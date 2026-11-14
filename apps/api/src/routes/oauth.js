'use strict';

// OAuth 2.1 authorization server for the remote MCP endpoint (/mcp).
//
// Lets Claude.ai, ChatGPT.com, and any compliant MCP client connect via the
// standard discovery + Dynamic Client Registration + authorization-code/PKCE
// flow instead of requiring a manually-pasted Bearer token.
//
// Discovery (root):
//   GET /.well-known/oauth-protected-resource[ /mcp ]
//   GET /.well-known/oauth-authorization-server
//   GET /.well-known/openid-configuration   (mirror)
// Endpoints (/api/v1/oauth):
//   POST /register   — RFC 7591 Dynamic Client Registration (public PKCE clients)
//   GET  /authorize  — validates + redirects to the dashboard consent page
//   POST /approve    — dashboard-only (Clerk auth); mints a one-time auth code
//   POST /token       — authorization_code / refresh_token grant; returns a dd_ key
//
// Access tokens are freshly-minted DeerDawn API keys (dd_…) so the existing
// requireAuth middleware accepts them unchanged. Short-lived flow state (auth
// codes, consent requests, refresh tokens) lives in Redis; a client's
// REGISTRATION does not — see store/oauthClientStore.js for why.

const express = require('express');
const { isSelfHosted, selfHostedPublicUrl, dashboardBaseUrl, marketingBaseUrl } = require('../config/selfHosted');
const crypto = require('crypto');
const { redis } = require('../config/redis');
const { requireAuth } = require('../middleware/auth');
const { generateApiKey, hashApiKey } = require('../utils/security');
const {
  mcpAuthLimiter,
  oauthSharedEgressLimiter,
  oauthActorLimiter,
  oauthGrantLimiter,
  oauthRegisterLimiter,
} = require('../middleware/rateLimit');
const db = require('../config/db');
const oauthClientStore = require('../store/oauthClientStore');
const { ClientStoreUnavailableError } = oauthClientStore;
const apiKeyCache = require('../services/apiKeyCache');
const workspace = require('../services/workspaceService');
const { credentialSurface } = require('../services/hostedSessionIdentity');
const connectionIdentity = require('../services/connectionIdentity');
// The refresh-token index. A token's Redis key is a hash of the token, so
// without this nothing can find a person's live tokens — which is why an erased
// account could still refresh its way to a brand-new access key.
const { indexRefreshToken, forgetRefreshToken } = require('../services/dataErasureService');
// Required as a module object (not destructured) so tests can stub recordProductEvent.
const productEvents = require('../services/productEventsService');
const { rememberConnectorRequest } = require('../services/connectorSignupAttribution');
const {
  MCP_RESOURCE_PATH,
  CLAUDE_MCP_RESOURCE_PATH,
  canonicalMcpResource,
  normalizeMcpResource,
} = require('../config/mcpResource');
const { A2A_BASE_PATH } = require('../config/agentCard');

const router = express.Router();

// Publisher consoles sometimes require a temporary static file under
// /.well-known. Operators can satisfy a challenge without a code change while
// keeping the allowed path and exact response content fail-closed.
router.get('/.well-known/:challengeFile', (req, res, next) => {
  const filename = String(process.env.DOMAIN_VERIFICATION_FILENAME || '').trim();
  const content = String(process.env.DOMAIN_VERIFICATION_CONTENT || '');
  if (!filename || !content || !/^[A-Za-z0-9._-]{1,160}$/.test(filename)) return next();
  if (req.params.challengeFile !== filename) return next();
  res.set('Cache-Control', 'no-store');
  res.type('text/plain').send(content);
});
// OAuth token requests are form-urlencoded; registration is JSON (handled by
// the global express.json mounted before this router).
router.use(express.urlencoded({ extended: true }));

const REQUEST_TTL = 10 * 60;          // 10 minutes
const CODE_TTL = 60;                  // 60 seconds, one-time
// See config/oauthTokens.js: the refresh token has to outlive the access token
// by a wide margin, or the refresh grant is only ever presented after its own
// key has expired and every connection dies at the first access-token expiry.
// A successful refresh writes the new token with a full TTL again below, so an
// actively used connection never approaches this ceiling.
const { REFRESH_TTL_SECONDS: REFRESH_TTL, ACCESS_TOKEN_TTL_DAYS } = require('../config/oauthTokens');
const SCOPES = ['context:read', 'context:write'];
const CIMD_TTL = 60 * 60;             // 1 hour
const CIMD_TIMEOUT_MS = 3000;
const CIMD_MAX_BYTES = 64 * 1024;

// ─── Helpers ───────────────────────────────────────────────────────────────

function issuer(req) {
  if (process.env.API_BASE_URL) return process.env.API_BASE_URL.replace(/\/+$/, '');
  // Self-hosted: PUBLIC_URL, when the API is served behind the same origin.
  const publicUrl = selfHostedPublicUrl();
  if (publicUrl) return publicUrl;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

function dashboardUrl() {
  return dashboardBaseUrl();
}

function marketingUrl() {
  return marketingBaseUrl();
}

// Where a person reads how to connect. Hosted: the marketing site's /connect.
// Self-hosted: there is no marketing site; the dashboard's own /setup page.
function connectDocsUrl() {
  return isSelfHosted() ? `${dashboardBaseUrl()}/setup` : `${marketingUrl()}/connect`;
}

// Public, unauthenticated discovery/metadata: safe to expose cross-origin.
function allowCors(_req, res, next) {
  // An allowlisted origin (our own dashboard) was already answered by the global
  // CORS middleware with its own origin and Allow-Credentials. Overwriting that
  // with '*' made the browser discard the response to a CREDENTIALED call — the
  // cookie-session consent approval a self-hosted dashboard makes directly
  // (lib/dashboardAuth.ts). Everybody else still gets '*'.
  if (res.get('Access-Control-Allow-Credentials') === 'true' && res.get('Access-Control-Allow-Origin')) return next();
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-protocol-version');
  res.set('Cache-Control', 'no-store');
  if (_req.method === 'OPTIONS') return res.status(204).end();
  next();
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyPkce(verifier, challenge) {
  if (!verifier || !challenge) return false;
  const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
  return safeEqual(computed, challenge);
}

// Refresh tokens are bearer credentials. Never place the plaintext token in a
// Redis key or value: hash it for lookup so snapshots, key scans, and telemetry
// cannot be replayed as live OAuth credentials.
function refreshTokenKey(token) {
  return `oauth:refresh:${crypto.createHash('sha256').update(String(token)).digest('hex')}`;
}

// ─── Connector-handoff instrumentation (2026-08-30, E-015) ───────────────────
//
// The activation funnel goes dark between our copy button and the consent
// screen. Over the 30 days to 2026-08-30, 17 people copied a connector config
// and 2 reached `oauth_consent_viewed`; nothing in between emitted anything, so
// "never pasted the URL into Claude" and "pasted it and the handshake died
// before consent" were the same observation. They need opposite fixes.
//
// Two server-side moments close that gap, and every real connector attempt
// passes through at least one of them:
//   1. POST /register  — the client registers itself (DCR). Skipped entirely by
//      clients using a client-id metadata document, which is why it cannot be
//      the only instrument.
//   2. GET  /authorize — the user's browser arrives with a client_id. Every
//      attempt reaches here regardless of how the client was registered, and
//      its two hard-400 branches are dead ends the user sees as a broken page
//      and the funnel has never seen at all.
//
// Correlation key: a hash of the client_id, so the register and authorize legs
// of one connector share a session_id without either storing the identifier
// itself (CIMD client_ids are URLs — high-cardinality and not worth mirroring).
// A rejection can arrive with no usable client_id at all. It still gets a
// session id: captureProductEvent drops any event with a falsy distinctId, so a
// null here would land the row in Postgres, report success, and never reach the
// funnel it exists to be read in. One shared bucket rather than a random id per
// attempt — person creation is suppressed either way, and a constant aggregates.
const UNATTRIBUTED_CONNECTOR_SESSION = 'mcpcx-unattributed';

function connectorSessionId(clientId) {
  if (!clientId) return UNATTRIBUTED_CONNECTOR_SESSION;
  return `mcpcx-${crypto.createHash('sha256').update(String(clientId)).digest('hex').slice(0, 32)}`;
}

// Never let instrumentation break the handshake: a failure here must not cost
// a user their connection. Deliberately actor-less — recordProductEvent sees no
// user, no org and no anonymous_id, so it stamps `$process_person_profile:
// false` and the event cannot mint a property-less PostHog person (validity
// gate §6.1; the same defect as E-007 and E-013).
function recordConnectorEvent(eventName, clientId, metadata = {}) {
  setImmediate(() => {
    productEvents
      .recordProductEvent(null, {
        event_name: eventName,
        source: 'oauth',
        surface: 'connector_handoff',
        session_id: connectorSessionId(clientId),
        metadata,
      })
      .catch((err) => console.warn(`[OAUTH] ${eventName} event failed:`, err.message));
  });
}

// ─── Authorize-rejection diagnostics (2026-09-30) ────────────────────────────
//
// 13 `unknown_client` rejections in September carried nothing but the reason.
// The distinct_id is a hash of the client_id, so one of the six client_ids was
// identifiable only by hashing candidate URLs until one matched (VS Code, before
// vscode.dev joined the CIMD allowlist); the other five could be a lost DCR
// registration, a metadata URL from an origin we do not fetch, or junk, and the
// event could not say which. Everything below is non-secret by construction: a
// public client's id is not a credential, but it is still only ever sent as a
// short hash, a shape, and — for a metadata URL, which is a public document —
// its origin.

// Every client_id this server has ever issued (since 2026-06-02) has this shape.
const ISSUED_DCR_CLIENT_ID = /^mcp_[0-9a-f]{32}$/;

function classifyClientId(clientId) {
  if (typeof clientId !== 'string' || !clientId) return { kind: 'missing', origin: null };
  if (ISSUED_DCR_CLIENT_ID.test(clientId)) return { kind: 'dcr', origin: null };
  if (/^https?:\/\//i.test(clientId)) {
    let origin;
    try {
      origin = new URL(clientId).origin;
    } catch {
      return { kind: 'malformed_url', origin: null };
    }
    return { kind: cimdAllowedOrigins().has(origin) ? 'cimd' : 'cimd_origin_not_allowed', origin };
  }
  if (clientId.startsWith('mcp_')) return { kind: 'dcr_malformed', origin: null };
  return { kind: 'other', origin: null };
}

// Coarse family only; the full string is not needed to tell a person's browser
// from a crawler following the /authorize URL our discovery documents publish.
function userAgentFamily(ua) {
  const s = String(ua || '').toLowerCase();
  if (!s) return 'none';
  if (/bot|crawl|spider|slurp|headless/.test(s)) return 'bot';
  if (/^curl\//.test(s)) return 'curl';
  if (/python|aiohttp|httpx/.test(s)) return 'python';
  if (/node|undici|axios/.test(s)) return 'node';
  if (/go-http-client/.test(s)) return 'go';
  if (/electron/.test(s)) return 'electron';
  if (/edg\//.test(s)) return 'edge';
  if (/opr\//.test(s)) return 'opera';
  if (/firefox|fxios/.test(s)) return 'firefox';
  if (/chrome|crios|chromium/.test(s)) return 'chrome';
  if (/safari/.test(s)) return 'safari';
  return 'other';
}

function hostOf(value) {
  if (!value) return null;
  try {
    return new URL(String(value)).host || null;
  } catch {
    return null;
  }
}

const AUTHORIZE_PARAMS = [
  'response_type', 'client_id', 'redirect_uri', 'code_challenge',
  'code_challenge_method', 'state', 'scope', 'resource',
];

function authorizeDiagnostics(req, clientId, extra = {}) {
  const { kind, origin } = classifyClientId(clientId);
  const query = req.query || {};
  return {
    client_id_kind: kind,
    client_id_hash: clientId ? crypto.createHash('sha256').update(String(clientId)).digest('hex').slice(0, 12) : null,
    client_id_origin: origin,
    redirect_host: typeof query.redirect_uri === 'string' ? redirectHost(query.redirect_uri) : null,
    // Names only, from a fixed list: which parameters arrived, never their values.
    params_present: AUTHORIZE_PARAMS.filter((name) => query[name] !== undefined && query[name] !== '').join(','),
    ua_family: userAgentFamily(req.get('user-agent')),
    referer_host: hostOf(req.get('referer')),
    ...extra,
  };
}

// A registration we issued and no longer hold. Before #451 (2026-09-06) a DCR
// registration lived only in Redis, so any restart or eviction lost it, and the
// client, which wrote the client_id into its local config, resends it forever.
// The durable store stops NEW losses. It cannot bring back the old ones, and
// "remove the connector and add it again" is the instruction that turned a
// returning user into a lost one.
//
// Re-admitting the id as a fresh unverified DCR client for this one request
// grants nothing an anonymous POST /register does not already grant: DCR is
// open, unauthenticated, and takes any redirect_uri isValidRedirectUri allows.
// Every guard after this point still applies. The consent screen shows it
// UNVERIFIED with its redirect host, PKCE is required, and nothing is persisted,
// so an unknown id can neither plant a registration nor pin a redirect_uri.
function recoveredDcrClient(clientId, redirectUri) {
  return {
    client_id: clientId,
    redirect_uris: [redirectUri],
    client_name: 'MCP Client',
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    registration_type: 'dcr',
    recovered: true,
  };
}

// The token leg (E-032, 2026-09-27). Consent approval is the last moment the
// funnel could see: from 2026-09-25 to 09-27 four real people approved ChatGPT
// on the consent screen and none of them ever sent an authenticated
// `initialize`, while the founder's and the reviewer's ChatGPT connections did
// within ~100s. Whether the code was never redeemed, was refused here, or was
// redeemed and the token then refused, was indistinguishable.
//
// A redemption that found its code record is attributed to the PERSON who
// approved (owner_id), so it joins that account's `account_created` and
// `oauth_consent_approved`. It deliberately carries NO session_id: a CIMD
// client_id is shared by every user of that client (every ChatGPT user has the
// same one), so the connector session id is a shared bucket, and
// recordProductEvent adopts every org-less row with the caller's session id
// into the caller's org. Passing it here would file all anonymous ChatGPT
// authorize rows under whoever redeemed next. A refusal with no record has no
// person and stays actor-less, keyed like the other connector events.
function recordTokenEvent(eventName, { record = null, clientId = null, metadata = {} } = {}) {
  setImmediate(() => {
    const owned = Boolean(record && record.owner_id);
    productEvents
      .recordProductEvent(
        owned ? { type: 'key', owner_id: record.owner_id, org_id: record.org_id || null } : null,
        {
          event_name: eventName,
          source: 'oauth',
          surface: 'connector_handoff',
          ...(owned ? {} : { session_id: connectorSessionId(clientId) }),
          metadata: { client_name: record?.client_name || null, ...metadata },
        }
      )
      .catch((err) => console.warn(`[OAUTH] ${eventName} event failed:`, err.message));
  });
}

// Which MCP audience a token was minted for (/mcp, /mcp/claude, ...): the path
// only, so the event never carries a host a client supplied.
function resourcePathOf(resource) {
  try { return new URL(String(resource)).pathname.slice(0, 80); } catch { return null; }
}

// The registration channel a client arrived through decides how much the
// consent screen can vouch for it. CIMD clients publish their metadata at an
// HTTPS origin on our explicit allowlist (chatgpt.com, claude.ai), so their
// identity is anchored to a domain we trust. DCR clients are self-registered by
// anyone, unauthenticated, with an arbitrary redirect_uri — so consent must
// treat them as unverified and show the user exactly where the code will go.
function isVerifiedClient(client) {
  return Boolean(client) && client.registration_type === 'cimd';
}

// Host shown to the resource owner so a phishing redirect is legible. Never
// throws — the redirect_uri was already validated by isValidRedirectUri.
//
// For a native app's private-use scheme the SCHEME is the identity, not the
// host: `cursor://anysphere.cursor-mcp/...` and `evil://anysphere.cursor-mcp/...`
// share a host, so showing the host alone would let any locally-installed app
// borrow a trusted tool's name on the consent screen. Non-web redirects are
// therefore shown as `scheme://host` (or `scheme:` when there is no authority).
function redirectHost(uri) {
  try {
    const url = new URL(uri);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.host;
    return url.host ? `${url.protocol}//${url.host}` : url.protocol;
  } catch {
    return null;
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Private-use URI schemes for native apps (RFC 8252 s7.1). Cursor registers
// `cursor://anysphere.cursor-mcp/oauth/callback` — on older versions as its ONLY
// redirect_uri — so refusing every non-web scheme made DCR a hard 400 and Cursor
// could not connect at all.
//
// RFC 8252 asks for a reverse-domain scheme (`com.example.app`), and a scheme
// containing a '.' is accepted on that basis: no browser can hand one to a web
// page (registerProtocolHandler only admits `web+<letters>` and a fixed safelist,
// none dotted), so the code can only reach an installed native app. The editors
// that predate the convention use bare names; those are allowed by name only.
// Everything else without a dot is refused: an open-ended bare-scheme rule
// would admit OS handlers (`ms-settings:`, `x-apple-...`) and anything a browser
// might treat as navigable.
//
// Always refused, whatever the list says: schemes that execute or embed
// content in the page that follows the redirect, or read local resources.
// The code is still protected by PKCE (a hostile app that claims the same
// scheme holds no verifier), and a DCR client is still shown as UNVERIFIED on
// the consent screen with its scheme visible (see redirectHost).
//
// A SCHEME IS NOT A CALLBACK. Admitting the scheme was only half the rule, and
// the missing half made the consent screen a launcher: Approve navigates to the
// registered URI, so whatever that URI's handler does, one click on a
// DeerDawn-branded page does it. Three shapes did something other than receive
// a code:
//   - the editors' BUILT-IN handlers. `vscode://vscode.git/clone?url=...`
//     clones a repository of the registrant's choosing, `vscode://file/<path>`
//     opens any local file, `vscode-remote` opens a remote. Cursor and Windsurf
//     are VS Code forks and route the same way.
//   - a registered QUERY. `?url=` is what arms the clone handler. An OAuth
//     callback needs no query of its own: the `code` and `state` we append are
//     the whole payload.
//   - OS handlers that happen to be dotted: `x-apple.systempreferences:` is
//     macOS System Settings, and the reverse-domain rule admitted it.
// So an editor redirect must name an EXTENSION callback (`publisher.name`) from
// a publisher that does not ship acting handlers; Cursor's must be its
// observed `anysphere.cursor-mcp` exactly; a reverse-domain scheme may not sit
// in an OS vendor's namespace; and no native redirect carries a query.
const NATIVE_APP_SCHEMES = new Set(['cursor', 'vscode', 'vscode-insiders', 'windsurf']);
const CURSOR_CALLBACK_AUTHORITY = 'anysphere.cursor-mcp';
// Publishers whose extensions register URI handlers that ACT: clone, open a
// file or remote, join a session, or finish another provider's sign-in.
// `vscode` is every built-in extension (vscode.git, vscode.github,
// vscode.github-authentication, vscode.microsoft-authentication).
const EDITOR_HANDLER_PUBLISHERS = new Set(['vscode', 'ms-vscode', 'ms-vscode-remote', 'ms-vsliveshare', 'github']);
// `<publisher>.<extension>`: letters, digits and hyphens, one dot. An encoded
// dot (`vscode%2Egit`), a bare word (`file`, `vscode-remote`) or a port cannot
// pass for an extension id.
const EXTENSION_AUTHORITY = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;
const FORBIDDEN_REDIRECT_SCHEMES = new Set([
  'javascript', 'data', 'file', 'vbscript', 'blob', 'about', 'filesystem',
  'ftp', 'ws', 'wss', 'mailto', 'view-source', 'chrome', 'chrome-extension', 'moz-extension',
]);
const REVERSE_DOMAIN_SCHEME = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
// Operating-system namespaces. `x-` and `ms-` lead Apple's and Microsoft's own
// handler schemes; the rest are the platform vendors' reverse-domain roots.
const OS_SCHEME_PREFIXES = [
  'apple.', 'com.apple.', 'microsoft.', 'com.microsoft.', 'windows.',
  'android.', 'com.android.', 'com.google.android.',
  'org.freedesktop.', 'org.gnome.', 'org.kde.',
];

function isOsScheme(scheme) {
  if (/^(?:x|ms)-/.test(scheme)) return true;
  return OS_SCHEME_PREFIXES.some((prefix) => scheme.startsWith(prefix));
}

function isAllowedNativeScheme(scheme) {
  if (FORBIDDEN_REDIRECT_SCHEMES.has(scheme)) return false;
  if (NATIVE_APP_SCHEMES.has(scheme)) return true;
  return REVERSE_DOMAIN_SCHEME.test(scheme) && !isOsScheme(scheme);
}

// The authority of an editor redirect: an extension's callback, never a
// first-party handler. Lower-cased, because the editors match extension ids
// case-insensitively (`vscode://VSCode.Git/...` reaches the git extension).
function isEditorCallbackAuthority(scheme, authority) {
  const id = String(authority || '').toLowerCase();
  if (scheme === 'cursor') return id === CURSOR_CALLBACK_AUTHORITY;
  if (!EXTENSION_AUTHORITY.test(id)) return false;
  return !EDITOR_HANDLER_PUBLISHERS.has(id.split('.')[0]);
}

// https everywhere; http only for loopback (desktop clients); a private-use
// native-app scheme per the rule above.
function isValidRedirectUri(uri) {
  if (typeof uri !== 'string' || uri.length > 2048) return false;
  // The URL parser trims surrounding whitespace and drops tabs and newlines
  // anywhere, so ` https://x` validated as `https://x` while the STORED string,
  // which the exact-match compare and the consent screen use, kept them. No
  // real client sends either; refuse rather than guess which one was meant.
  if (/\s/.test(uri) || [...uri].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return false;
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol === 'http:') return LOOPBACK_HOSTS.has(parsed.hostname);
  // A native redirect is compared by exact string, so it must be a plain
  // callback: no credentials, and no fragment (RFC 6749 s3.1.2), which would
  // otherwise swallow the `?code=` we append.
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (!isAllowedNativeScheme(scheme)) return false;
  if (parsed.username || parsed.password || parsed.hash || uri.includes('#')) return false;
  if (uri.includes('?')) return false;
  if (NATIVE_APP_SCHEMES.has(scheme)) {
    if (parsed.port || !isEditorCallbackAuthority(scheme, parsed.hostname)) return false;
  }
  return true;
}

// RFC 8252 s7.3: a CLI binds whatever loopback port is free at run time and
// cannot know it when it registers, so the authorization server MUST compare
// loopback redirect URIs ignoring the port. Claude Code publishes
// `http://localhost/callback` in its client metadata document and then arrives
// as `http://localhost:3118/callback` — under an exact string compare that is a
// bare 400 mid-connect, on the very first thing a new user does, and no amount
// of retrying fixes it. Only the port is relaxed: scheme, host and path must
// still match exactly, and https redirects are unaffected.
function loopbackIdentity(uri) {
  if (typeof uri !== 'string') return null;
  let url;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) return null;
  return `${url.hostname}|${url.pathname}|${url.search}`;
}

function matchesRegisteredRedirectUri(registeredUris, requested) {
  if (typeof requested !== 'string' || !requested) return false;
  const registered = Array.isArray(registeredUris) ? registeredUris : [];
  if (registered.includes(requested)) return true;
  const wanted = loopbackIdentity(requested);
  if (!wanted) return false;
  return registered.some((uri) => loopbackIdentity(uri) === wanted);
}

function appendQuery(uri, params) {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  return url.toString();
}

async function readJson(key) {
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeRequestedScopes(rawScope) {
  const requested = typeof rawScope === 'string' && rawScope.trim()
    ? [...new Set(rawScope.trim().split(/\s+/))]
    : [...SCOPES];
  if (requested.length === 0 || requested.some((scope) => !SCOPES.includes(scope))) return null;
  return requested;
}

// The origins whose published client metadata documents we are willing to
// FETCH. This is an allowlist and not a policy knob: the fetch is a
// server-side request at a URL the caller chose, so anything not on it is an
// SSRF surface, and the list stays a short set of named products.
//
// https://vscode.dev is on it because VS Code / Copilot is an advertised setup
// path (apps/marketing/public/agent-setup/vscode.md) that could not connect at
// all. VS Code uses https://vscode.dev/oauth/client-metadata.json as its
// client_id whenever a server advertises
// `client_id_metadata_document_supported` — which authServerMetadata below
// does — and it has no DCR fallback to try instead, so /authorize answered
// every VS Code user a bare 400 invalid_client and nothing they could do to
// their editor would change that.
function cimdAllowedOrigins() {
  return new Set(
    (process.env.CIMD_ALLOWED_ORIGINS || 'https://chatgpt.com,https://claude.ai,https://vscode.dev')
      .split(',')
      .map((origin) => origin.trim().replace(/\/+$/, ''))
      .filter(Boolean)
  );
}

function validateCimdClientId(clientId) {
  let url;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !cimdAllowedOrigins().has(url.origin)
  ) {
    return null;
  }
  return url;
}

// `diag.cimd_failure` names why a document was refused, for the rejection
// event. Every refusal below is still a null: this only makes it legible.
async function fetchCimdClient(clientId, diag = {}) {
  const refuse = (why) => {
    diag.cimd_failure = why;
    return null;
  };
  const url = validateCimdClientId(clientId);
  if (!url) return refuse('not_a_fetchable_metadata_url');

  const cacheKey = `oauth:cimd:${crypto.createHash('sha256').update(clientId).digest('hex')}`;
  const cached = await readJson(cacheKey);
  if (cached) return cached;

  // The client_id validated as one of ours, so this client is not unknown — we
  // simply could not reach its metadata document. Answering "not found" here
  // would tell a claude.ai or chatgpt.com user to re-register a connector over a
  // network hiccup on our side.
  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ClientStoreUnavailableError(`client metadata fetch failed: ${err.message}`);
  }
  if (response.status >= 500 || response.status === 429) {
    throw new ClientStoreUnavailableError(`client metadata document returned ${response.status}`);
  }
  if (!response.ok) return refuse(`http_${response.status}`);
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > CIMD_MAX_BYTES) return refuse('too_large');
  const raw = await response.text();
  if (Buffer.byteLength(raw, 'utf8') > CIMD_MAX_BYTES) return refuse('too_large');

  let metadata;
  try {
    metadata = JSON.parse(raw);
  } catch {
    return refuse('invalid_json');
  }

  if (!metadata || typeof metadata !== 'object') return refuse('invalid_json');
  if (metadata.client_id && metadata.client_id !== clientId) return refuse('client_id_mismatch');
  const redirectUris = Array.isArray(metadata.redirect_uris) ? metadata.redirect_uris : [];
  if (redirectUris.length === 0 || redirectUris.length > 10 || !redirectUris.every(isValidRedirectUri)) return refuse('invalid_redirect_uris');
  const authMethods = Array.isArray(metadata.token_endpoint_auth_methods_supported)
    ? metadata.token_endpoint_auth_methods_supported
    : [metadata.token_endpoint_auth_method || 'none'];
  if (!authMethods.includes('none')) return refuse('confidential_client');

  const client = {
    client_id: clientId,
    redirect_uris: redirectUris,
    client_name: typeof metadata.client_name === 'string'
      ? metadata.client_name.slice(0, 200)
      : url.hostname,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    registration_type: 'cimd',
  };
  await redis.set(cacheKey, JSON.stringify(client), 'EX', CIMD_TTL);
  return client;
}

// Throws ClientStoreUnavailableError when it could not determine whether the
// client exists; returns null only when it determined that it does not.
async function resolveOAuthClient(clientId, diag) {
  const registered = await oauthClientStore.loadClient(clientId);
  if (registered) return registered;
  return fetchCimdClient(clientId, diag);
}

// The registered name of a grant's client, for a grant that predates the
// refresh record carrying it. Best-effort: a lookup that fails costs a label,
// never a connection, so every failure is null.
async function registeredClientName(clientId) {
  if (!clientId) return null;
  try {
    const client = await resolveOAuthClient(clientId);
    return typeof client?.client_name === 'string' && client.client_name ? client.client_name.slice(0, 200) : null;
  } catch {
    return null;
  }
}

// ─── Discovery ───────────────────────────────────────────────────────────────

function protectedResourceDoc(req, resourcePath = MCP_RESOURCE_PATH) {
  const iss = issuer(req);
  return {
    resource: canonicalMcpResource(iss, resourcePath),
    resource_name: 'DeerDawn Remote MCP',
    resource_documentation: `${connectDocsUrl()}`,
    authorization_servers: [iss],
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
  };
}

router.get('/.well-known/oauth-protected-resource', allowCors, (req, res) => {
  res.json(protectedResourceDoc(req));
});

// MCP clients may append the resource path to the well-known location.
router.get('/.well-known/oauth-protected-resource/mcp', allowCors, (req, res) => {
  res.json(protectedResourceDoc(req));
});

router.get('/.well-known/oauth-protected-resource/mcp/claude', allowCors, (req, res) => {
  res.json(protectedResourceDoc(req, CLAUDE_MCP_RESOURCE_PATH));
});

// Backward-compatible discovery path for clients still configured with the
// former /api/v1/mcp alias.
router.get('/.well-known/oauth-protected-resource/api/v1/mcp', allowCors, (req, res) => {
  res.json(protectedResourceDoc(req));
});

// The A2A JSON-RPC endpoint is a second protected resource on the same
// authorization server. Its 401 WWW-Authenticate points here (routes/a2a.js).
router.get(`/.well-known/oauth-protected-resource${A2A_BASE_PATH}`, allowCors, (req, res) => {
  const iss = issuer(req);
  res.json({
    resource: `${iss}${A2A_BASE_PATH}`,
    resource_name: 'DeerDawn A2A Agent',
    resource_documentation: `${connectDocsUrl()}`,
    authorization_servers: [iss],
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
  });
});

function authServerMetadata(req) {
  const iss = issuer(req);
  const site = marketingUrl();
  const app = dashboardUrl();
  const registerUri = `${iss}/api/v1/oauth/register`;
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/api/v1/oauth/authorize`,
    token_endpoint: `${iss}/api/v1/oauth/token`,
    revocation_endpoint: `${iss}/api/v1/oauth/revoke`,
    registration_endpoint: registerUri,
    client_id_metadata_document_supported: true,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: SCOPES,
    protected_resources: [
      canonicalMcpResource(iss),
      canonicalMcpResource(iss, CLAUDE_MCP_RESOURCE_PATH),
    ],
    agent_auth: {
      skill: `${site}/auth.md`,
      register_uri: registerUri,
      identity_types_supported: ['oauth_user'],
      credential_types_supported: ['oauth2_authorization_code_pkce', 'bearer_api_key'],
      oauth_user: {
        register_uri: registerUri,
        authorization_uri: `${iss}/api/v1/oauth/authorize`,
        token_uri: `${iss}/api/v1/oauth/token`,
        claim_uri: `${app}/oauth/consent`,
        credential_types_supported: ['oauth2_authorization_code_pkce'],
        scopes_supported: SCOPES,
      },
      api_key: {
        credential_types_supported: ['bearer_api_key'],
        claim_uri: `${app}/api-keys`,
      },
    },
  };
}

router.get('/.well-known/oauth-authorization-server', allowCors, (req, res) => {
  res.json(authServerMetadata(req));
});

// Some clients probe the OpenID configuration location.
router.get('/.well-known/openid-configuration', allowCors, (req, res) => {
  res.json(authServerMetadata(req));
});

// ─── Dynamic Client Registration (RFC 7591) ──────────────────────────────────

router.options('/api/v1/oauth/register', allowCors);
router.post('/api/v1/oauth/register', allowCors, oauthRegisterLimiter, async (req, res) => {
  const body = req.body || {};
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];

  if (redirectUris.length === 0) {
    recordConnectorEvent('connector_registration_rejected', null, { reason: 'missing_redirect_uris' });
    return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' });
  }
  if (redirectUris.length > 10 || !redirectUris.every(isValidRedirectUri)) {
    recordConnectorEvent('connector_registration_rejected', null, { reason: 'invalid_redirect_uris' });
    return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https, http loopback, or a native-app private-use scheme (reverse-domain, e.g. com.example.app:/callback)' });
  }

  const clientId = `mcp_${crypto.randomBytes(16).toString('hex')}`;
  const client = {
    client_id: clientId,
    redirect_uris: redirectUris,
    client_name: typeof body.client_name === 'string' ? body.client_name.slice(0, 200) : 'MCP Client',
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    // Self-registered, unauthenticated, arbitrary redirect_uri. The consent
    // screen surfaces this as an unverified client so the resource owner can
    // spot a phishing registration before approving.
    registration_type: 'dcr',
    created_at: Date.now(),
  };

  try {
    // Durable, and with no expiry: a registration stays valid for as long as its
    // connector is installed, because the client has no way to notice it was
    // forgotten and no way to re-register itself if it did. Access and refresh
    // tokens still expire and rotate independently. Failing the registration is
    // the right outcome when we cannot make it durable — a client_id we might
    // not remember is worse than no client_id, since the client will treat it as
    // permanent either way.
    await oauthClientStore.saveClient(client);
  } catch (err) {
    console.error('[OAUTH] Failed to persist client:', err.message);
    return res.status(503).json({ error: 'temporarily_unavailable' });
  }

  // The first observable moment a user has handed our URL to their tool.
  recordConnectorEvent('connector_registration_requested', clientId, {
    client_name: client.client_name,
    redirect_host: redirectHost(redirectUris[0]),
    registration_type: 'dcr',
  });

  res.status(201).json({
    client_id: clientId,
    client_id_issued_at: Math.floor(client.created_at / 1000),
    redirect_uris: client.redirect_uris,
    token_endpoint_auth_method: 'none',
    grant_types: client.grant_types,
    response_types: client.response_types,
    client_name: client.client_name,
  });
});

// ─── Authorization endpoint ───────────────────────────────────────────────────

router.get('/api/v1/oauth/authorize', mcpAuthLimiter, async (req, res) => {
  const {
    response_type: responseType,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
    state,
    scope,
    resource,
  } = req.query;

  // redirect_uri must be validated against the registered client BEFORE we
  // ever redirect an error back to it.
  // Every rejection below carries the same diagnostics, so the next one can be
  // read from the event instead of reverse-engineered from a hash.
  const reject = (reason, extra = {}) =>
    recordConnectorEvent('connector_authorize_rejected', typeof clientId === 'string' ? clientId : null, {
      reason,
      ...authorizeDiagnostics(req, typeof clientId === 'string' ? clientId : null, extra),
    });

  if (!clientId || typeof clientId !== 'string') {
    reject('missing_client_id');
    return res.status(400).send('invalid_request: missing client_id');
  }
  const lookup = {};
  let client;
  try {
    client = await resolveOAuthClient(clientId, lookup);
  } catch (err) {
    // "We could not check" and "it does not exist" used to be the same branch,
    // so a Redis blip mid-connect told the user their working connector was
    // invalid and to re-register it — advice that destroys a good registration
    // to work around a transient fault. A retry fixes this; nothing the user
    // does to their connector will.
    if (err instanceof ClientStoreUnavailableError) {
      console.error('[OAUTH] Client lookup unavailable:', err.message);
      reject('client_store_unavailable');
      return res
        .status(503)
        .send('temporarily_unavailable: could not verify the connector just now. Your connector is still registered — please retry in a moment.');
    }
    console.warn('[OAUTH] Failed to resolve client metadata:', err.message);
    lookup.cimd_failure = lookup.cimd_failure || 'error';
  }
  // A client_id we minted, that neither store holds: a registration lost before
  // it was durable. See recoveredDcrClient for why this is safe to re-admit.
  if (!client && ISSUED_DCR_CLIENT_ID.test(clientId) && isValidRedirectUri(redirectUri)) {
    client = recoveredDcrClient(clientId, redirectUri);
  }
  // Both of these render a bare 400 in the user's browser mid-connect. They are
  // the two dead ends the 17 -> 2 gap could have been hiding, and until now
  // neither left any trace at all.
  //
  // This branch now means what it says: the store was reached and does not have
  // this client, and it is not one of ours to recover. Before oauthClientStore
  // existed it also fired whenever Redis had dropped a perfectly good
  // registration, which is how a connector that had worked for weeks started
  // demanding a reinstall.
  if (!client) {
    const { kind, origin } = classifyClientId(clientId);
    reject('unknown_client', { registration_found: false, cimd_failure: lookup.cimd_failure || null });
    if (kind === 'cimd_origin_not_allowed') {
      return res
        .status(400)
        .send(`invalid_client: this tool identifies itself with a client metadata document from ${origin}, which DeerDawn does not accept yet. Connect with an API key instead: ${connectDocsUrl()}`);
    }
    return res
      .status(400)
      .send('invalid_client: this connector is not registered with DeerDawn. Remove it from your tool and add it again to register a new one.');
  }
  if (!matchesRegisteredRedirectUri(client.redirect_uris, redirectUri)) {
    reject(typeof redirectUri === 'string' && redirectUri ? 'redirect_uri_mismatch' : 'missing_redirect_uri', {
      client_source: client.registration_type || null,
      registration_found: true,
    });
    return res.status(400).send('invalid_request: redirect_uri does not match a registered URI');
  }
  // A registration is checked when it is made, and the rule has since been
  // tightened: a client registered under the looser one still holds its
  // handler URI. Re-checked here, so the consent page never becomes a launcher
  // for a redirect the current rule would refuse.
  if (!isValidRedirectUri(redirectUri)) {
    reject('redirect_uri_disallowed', {
      client_source: client.registration_type || null,
      registration_found: true,
    });
    return res.status(400).send('invalid_request: redirect_uri is not an allowed callback. Remove the connector from your tool and add it again.');
  }

  // Reached by every connector attempt, however the client registered — the
  // last server-side step before the consent screen, and therefore the
  // denominator `oauth_consent_viewed` has never had.
  recordConnectorEvent('connector_authorize_requested', clientId, {
    client_name: client.client_name || null,
    redirect_host: redirectHost(redirectUri),
    client_source: client.registration_type || null,
    // True when the registration was lost and re-admitted above. The count of
    // these is the count of people the old answer would have sent away.
    recovered_registration: Boolean(client.recovered),
    ua_family: userAgentFamily(req.get('user-agent')),
  });

  // Records that this registration is live. Nothing prunes on it — it exists so
  // that if pruning is ever proposed, it can tell an abandoned client from one
  // somebody is using right now.
  if (client.registration_type !== 'cimd' && !client.recovered) oauthClientStore.touchClient(clientId);

  // From here errors are returned to the client via redirect.
  const fail = (error, description) =>
    res.redirect(appendQuery(redirectUri, { error, error_description: description, state }));

  if (responseType !== 'code') return fail('unsupported_response_type', 'only code is supported');
  if (!codeChallenge) return fail('invalid_request', 'PKCE code_challenge is required');
  if (codeChallengeMethod && codeChallengeMethod !== 'S256') {
    return fail('invalid_request', 'only S256 code_challenge_method is supported');
  }
  const requestedScopes = normalizeRequestedScopes(scope);
  if (!requestedScopes) return fail('invalid_scope', 'requested scopes are not supported');
  const normalizedResource = normalizeMcpResource(resource, issuer(req));
  if (!normalizedResource) {
    return fail('invalid_target', `resource must identify ${MCP_RESOURCE_PATH} or ${CLAUDE_MCP_RESOURCE_PATH}`);
  }

  const requestId = crypto.randomBytes(24).toString('hex');
  const requestRecord = {
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    state: state || null,
    scope: requestedScopes.join(' '),
    resource: normalizedResource,
    // Whether the client NAMED an audience here, or took our default. Only an
    // unnamed one may be narrowed to a specific MCP audience at /token.
    resource_indicated: resource !== undefined && resource !== null && resource !== '',
    client_name: client.client_name,
    client_verified: isVerifiedClient(client),
  };

  try {
    await redis.set(`oauth:req:${requestId}`, JSON.stringify(requestRecord), 'EX', REQUEST_TTL);
  } catch (err) {
    console.error('[OAUTH] Failed to persist authorize request:', err.message);
    return fail('temporarily_unavailable', 'please try again');
  }

  // So an account created from this consent screen can say which tool it came
  // through. Best-effort and never awaited into a failure: see
  // services/connectorSignupAttribution.js.
  await rememberConnectorRequest(redis, requestId, {
    clientName: client.client_name,
    clientVerified: requestRecord.client_verified,
    clientSource: client.registration_type || null,
  });

  res.redirect(`${dashboardUrl()}/oauth/consent?req=${requestId}`);
});

// ─── Consent details (dashboard consent screen, pre-approval) ─────────────────

// The consent screen must show the resource owner who is asking and where their
// authorization will be delivered — otherwise a maliciously self-registered
// (DCR) client with an arbitrary redirect_uri is indistinguishable from a
// legitimate one, and PKCE cannot help because the attacker owns that client.
// This returns only non-secret display fields already chosen by the client; it
// never exposes the code_challenge, owner, or any credential.
// No rate limiter here on purpose: the dashboard reaches this endpoint through
// a server-side passthrough, so an IP-keyed limiter would bucket every user
// under the dashboard's single egress IP — turning a shared quota into both a
// site-wide 429 and a way to suppress the unverified-client warning for
// everyone. The read is safe to leave unthrottled: it returns only non-secret
// display fields, keyed by an unguessable 48-hex request id that expires in 10
// minutes, so there is no credential or brute-force surface to protect.
router.options('/api/v1/oauth/consent/:requestId', allowCors);
router.get('/api/v1/oauth/consent/:requestId', allowCors, async (req, res) => {
  const requestId = typeof req.params.requestId === 'string' ? req.params.requestId : '';
  if (!/^[a-f0-9]{48}$/.test(requestId)) {
    return res.status(400).json({ error: 'invalid_request' });
  }
  const record = await readJson(`oauth:req:${requestId}`);
  if (!record) {
    return res.status(404).json({ error: 'expired_request', message: 'This authorization request expired. Restart the connection from your AI tool.' });
  }
  res.json({
    client_name: record.client_name || 'Unknown client',
    redirect_uri: record.redirect_uri,
    redirect_host: redirectHost(record.redirect_uri),
    scope: record.scope || SCOPES.join(' '),
    verified: Boolean(record.client_verified),
  });
});

// ─── Consent approval (dashboard → API, Clerk-authenticated) ──────────────────

router.options('/api/v1/oauth/approve', allowCors);
router.post('/api/v1/oauth/approve', allowCors, oauthSharedEgressLimiter, requireAuth, oauthActorLimiter, async (req, res) => {
  const requestId = typeof req.body?.req === 'string' ? req.body.req : null;
  if (!requestId) return res.status(400).json({ error: 'invalid_request', message: 'missing req' });

  const record = await readJson(`oauth:req:${requestId}`);
  if (!record) return res.status(404).json({ error: 'expired_request', message: 'This authorization request expired. Restart the connection from your AI tool.' });

  const actor = req.actor;
  if (!actor?.id) return res.status(401).json({ error: 'unauthorized' });

  const code = crypto.randomBytes(32).toString('hex');
  const codeRecord = {
    client_id: record.client_id,
    // Carried so the minted key can say which client holds it; a DCR client's
    // id is opaque, so the registered name is the only readable label it has.
    client_name: record.client_name || null,
    redirect_uri: record.redirect_uri,
    code_challenge: record.code_challenge,
    scope: record.scope,
    resource: record.resource,
    resource_indicated: record.resource_indicated,
    // The PERSON, not the credential. For an approver authenticated with an API
    // key, actor.id is the KEY id: the minted access key was then owned by a key,
    // and grantOwnerStillBelongs (below) could not look that "owner" up, so it let
    // the grant refresh forever — including after the person was removed. The
    // fallback keeps the old value only where there is no person to name.
    owner_id: workspace.actorPersonId(actor) || actor.id,
    org_id: actor.org_id || null,
    // The workspace this person is working in as they approve: the one a team
    // owner may later list and disconnect this connection under. actor.org_id
    // is the approver's own org and says nothing about it.
    workspace_key: workspace.defaultOwnerKey(actor) || null,
  };

  try {
    await redis.set(`oauth:code:${code}`, JSON.stringify(codeRecord), 'EX', CODE_TTL);
    await redis.del(`oauth:req:${requestId}`);
  } catch (err) {
    console.error('[OAUTH] Failed to persist auth code:', err.message);
    return res.status(503).json({ error: 'temporarily_unavailable' });
  }

  // The approval's own record (E-038, 2026-10-03). `oauth_consent_approved` is
  // relayed by the consent page and raced against the redirect, so it can be
  // lost: on 10-03 one of four new ChatGPT accounts got a token at 07:11 with
  // no consent view or approval recorded at all. Emitted only once the code is
  // stored, so it counts approvals that can actually be redeemed.
  recordTokenEvent('connector_consent_granted', {
    record: codeRecord,
    metadata: { verified: Boolean(record.client_verified), resource_path: resourcePathOf(record.resource) },
  });

  const redirect = appendQuery(record.redirect_uri, { code, state: record.state || undefined });
  res.json({
    redirect,
    client_name: record.client_name,
    redirect_host: redirectHost(record.redirect_uri),
    verified: Boolean(record.client_verified),
  });
});

// ─── Token endpoint ───────────────────────────────────────────────────────────

// A token must not out-rank the person it acts for — but the ceiling is applied
// per REQUEST, in the workspace that request is bound to
// (middleware/auth.js capCredentialScopesToBoundRole), not here. Capping at mint
// resolved the role in the person's ACTIVE workspace and baked it into the token,
// so a team viewer's token was read-only in their own personal workspace too, and
// a demotion waited for the next refresh. The token stores what was approved.

// WHICH CLIENT asked is stamped on the key, and it has to be: a refresh grant
// mints a NEW key row, so nothing about the key itself survives a rotation. The
// hosted session a project binding hangs off is per CONNECTION, and the client
// id is the only identifier that is both stable across refresh and different
// between claude.ai, ChatGPT and an editor. See services/hostedSessionIdentity.js.
// Both grant paths pass it: the authorization code record and the refresh record
// each carry client_id already.
async function mintAccessToken(owner, resource, scopes, client = {}) {
  const { key, prefix, hash } = generateApiKey();
  const keyId = `key-${crypto.randomUUID()}`;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + ACCESS_TOKEN_TTL_DAYS);

  await db.query(
    'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes, oauth_resource, oauth_client_id, oauth_client_name, oauth_workspace_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
    [
      keyId, prefix, hash, 'DeerDawn MCP (OAuth)', owner.owner_id, owner.org_id, 'production',
      expiresAt.toISOString(), scopes, resource,
      client.client_id ? String(client.client_id).slice(0, 512) : null,
      client.client_name ? String(client.client_name).slice(0, 200) : null,
      client.workspace_key ? String(client.workspace_key).slice(0, 200) : null,
    ],
    'org-system'
  );

  return { key, hash, expiresInSeconds: ACCESS_TOKEN_TTL_DAYS * 24 * 60 * 60 };
}

// May this grant still mint into the workspace it was issued for?
//
// Refused only on positive evidence that the person left: a membership row
// marked removed (what refuseOwnOrgBinding refuses every request on), or a
// person whose own workspace is now somewhere else and who holds no active
// membership here (re-homed). A solo account whose membership row predates the
// backfill still owns its users.org_id and keeps refreshing. A grant whose
// owner_id is not a person we can look up is left alone — this check narrows
// removed members, it does not invent a new refusal for anybody else. A lookup
// FAILURE throws, and the endpoint answers 500 with the pair intact, so a DB
// blip costs a retry, never a connection.
async function grantOwnerStillBelongs(record) {
  const personId = record?.owner_id;
  const orgId = record?.org_id;
  if (!personId || !orgId) return true;
  // THE STAMPED WORKSPACE, not the org the person signed up under. A token is
  // pinned to the workspace it was approved for (middleware/auth.js
  // bindPinnedWorkspace), so a person who has left it holds a connection that
  // can only be refused; refusing the refresh too lets the client re-run
  // consent instead of carrying a dead pair. Their own workspace always admits
  // them unless it removed them.
  const pin = record?.workspace_key;
  if (pin && pin !== orgId) {
    if (!(await workspace.getMembership(pin, personId))) {
      const own = await db.query('SELECT org_id FROM users WHERE user_id = $1', [personId], 'org-system');
      if (own.rows.length && !(own.rows[0].org_id === pin && !(await workspace.isRemovedFrom(pin, { type: 'user', id: personId })))) return false;
    }
  }
  if (await workspace.isRemovedFrom(orgId, { type: 'user', id: personId })) return false;
  if (await workspace.getMembership(orgId, personId)) return true;
  const home = await db.query('SELECT org_id FROM users WHERE user_id = $1', [personId], 'org-system');
  if (!home.rows.length) return true;
  return home.rows[0].org_id === orgId;
}

async function unstampedGrantWorkspace(record) {
  if (record.access_key_hash) {
    const { rows } = await db.query(
      'SELECT oauth_workspace_key FROM api_keys WHERE key_hash = $1 AND oauth_resource IS NOT NULL',
      [record.access_key_hash],
      'org-system'
    );
    if (rows[0]?.oauth_workspace_key) return rows[0].oauth_workspace_key;
  }
  return (await workspace.selectedWorkspaceKeyForPerson(record.owner_id)) || null;
}

async function revokeAccessTokenHash(hash) {
  if (!hash) return;
  await db.query(
    'UPDATE api_keys SET status = \'revoked\' WHERE key_hash = $1 AND oauth_resource IS NOT NULL',
    [hash],
    'org-system'
  );
  await apiKeyCache.invalidateApiKey(hash);
}

// Retire one refresh token and the access token it last minted. The RFC 7009
// revoke and a dashboard disconnect both come through here, so there is one
// way a refresh token is taken away, not two.
async function revokeRefreshTokenKey(tokenKey) {
  const record = await readJson(tokenKey);
  await redis.del(tokenKey);
  await forgetRefreshToken(record?.org_id, tokenKey);
  await revokeAccessTokenHash(record?.access_key_hash);
  return record;
}

// A CONNECTION ITS PERSON TOOK AWAY STAYS TAKEN AWAY.
//
// The refresh grant never asked whether the access key it was about to rotate
// still existed. So deleting a hosted key through DELETE /api/v1/keys/:id
// answered 200 and killed the token, and the client's next refresh minted a
// working one (walker, 2026-09-27). Most live refresh tokens predate the
// per-owner index and cannot be found to delete, so the key is where the
// answer has to live: a grant whose key was deleted, or revoked, is withdrawn.
//
// EXCEPT A KEY RETIRED BY ROTATION. A refresh retires the key it rotates out
// itself, and a second refresh of the same token already in flight reads the
// record before the first deletes it and then finds the key revoked. That is
// not the person taking anything away, and refusing it would drop a working
// connection into re-consent. Rotation leaves a signature no revocation does:
// it consumed this refresh token (deleted before the key is retired), and it
// left a NEWER active key for the same person and client. A disconnect revokes
// every key the connection has, so it leaves no successor; and a refresh token
// that survived a disconnect is still stored, so a later re-authorisation of
// the same client cannot bring it back.
//
// `besides` excludes a key this very request just minted, for the second look
// the grant takes after minting.
//
// Positive evidence only, as in grantOwnerStillBelongs: the probe always returns
// exactly one row from a real database, so an answer with no row is not
// evidence of anything, and a record from before refresh records carried their
// access key's hash has nothing to check.
async function accessKeyWithdrawn(tokenKey, record, { besides = null } = {}) {
  const hash = record?.access_key_hash;
  if (!hash) return false;
  const { rows } = await db.query(
    `SELECT TRUE AS probed,
            k.key_hash IS NOT NULL AS present,
            k.status,
            EXISTS (
              SELECT 1 FROM api_keys s
               WHERE s.owner_id = $2 AND s.oauth_client_id = $3
                 AND s.oauth_resource IS NOT NULL AND s.status = 'active'
                 AND s.key_hash <> $1 AND s.key_hash <> $4
                 AND s.created_at >= k.created_at
            ) AS superseded
       FROM (SELECT 1) AS probe
       LEFT JOIN api_keys k ON k.key_hash = $1 AND k.oauth_resource IS NOT NULL`,
    [hash, record.owner_id || null, record.client_id || null, besides || ''],
    'org-system'
  );
  const row = rows?.[0];
  if (!row?.probed) return false;
  if (!row.present) return true;
  if (row.status === 'active') return false;
  if (!row.superseded) return true;
  return Boolean(await redis.get(tokenKey));
}

router.options('/api/v1/oauth/token', allowCors);
router.post('/api/v1/oauth/token', allowCors, oauthSharedEgressLimiter, oauthGrantLimiter, async (req, res) => {
  const body = req.body || {};
  const grantType = body.grant_type;
  // Every refusal names its reason and the grant it happened on. Never the
  // code, verifier or token: the reason is the whole payload.
  const rejectToken = (reason, record, clientId) => recordTokenEvent('connector_token_rejected', {
    record,
    clientId: record ? record.client_id : clientId,
    metadata: { grant_type: typeof grantType === 'string' ? grantType.slice(0, 40) : null, reason },
  });

  try {
    if (grantType === 'authorization_code') {
      const { code, code_verifier: codeVerifier, client_id: clientId, redirect_uri: redirectUri } = body;
      if (!code || !codeVerifier) {
        rejectToken('missing_code_or_verifier', null, clientId);
        return res.status(400).json({ error: 'invalid_request', error_description: 'code and code_verifier are required' });
      }

      const record = await readJson(`oauth:code:${code}`);
      if (!record) {
        rejectToken('code_invalid_or_expired', null, clientId);
        return res.status(400).json({ error: 'invalid_grant', error_description: 'authorization code is invalid or expired' });
      }
      // One-time use.
      await redis.del(`oauth:code:${code}`);

      if (clientId && !safeEqual(clientId, record.client_id)) {
        rejectToken('client_id_mismatch', record);
        return res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
      }
      if (redirectUri && redirectUri !== record.redirect_uri) {
        rejectToken('redirect_uri_mismatch', record);
        return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      }
      if (!verifyPkce(codeVerifier, record.code_challenge)) {
        rejectToken('pkce_failed', record);
        return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      }

      // RFC 8707 makes `resource` OPTIONAL at /token, and normalizing an omitted
      // one returns the DEFAULT audience (/mcp) — so a grant issued for
      // /mcp/claude and exchanged without the parameter was refused
      // invalid_target, the same bug the refresh grant below was fixed for. An
      // omitted resource now means "the one this grant was issued for".
      //
      // The converse: when /authorize named NO resource we picked /mcp by
      // default, and a client that then names one of our MCP audiences here is
      // narrowing an unrestricted grant, not widening a restricted one — the
      // consent screen never showed an audience, and scopes and owner are fixed
      // by the code either way. A grant that DID name an audience keeps it.
      // Codes minted before this field existed carry no flag and stay strict.
      const hasResourceParam = body.resource !== undefined && body.resource !== null && body.resource !== '';
      const requestedResource = hasResourceParam
        ? normalizeMcpResource(body.resource, issuer(req))
        : record.resource;
      const audienceWasDefaulted = record.resource_indicated === false;
      if (!requestedResource || (requestedResource !== record.resource && !audienceWasDefaulted)) {
        rejectToken('resource_mismatch', record);
        return res.status(400).json({ error: 'invalid_target', error_description: 'resource does not match the authorization request' });
      }
      const grantResource = requestedResource;

      const owner = { owner_id: record.owner_id, org_id: record.org_id };
      const tokenScopes = normalizeRequestedScopes(record.scope);
      if (!tokenScopes) {
        rejectToken('unsupported_scope', record);
        return res.status(400).json({ error: 'invalid_scope', error_description: 'authorization grant contains unsupported scopes' });
      }
      const { key, hash, expiresInSeconds } = await mintAccessToken(owner, grantResource, tokenScopes, record);

      const refreshToken = `ddr_${crypto.randomBytes(32).toString('hex')}`;
      await redis.set(
        refreshTokenKey(refreshToken),
        JSON.stringify({
          ...owner,
          client_id: record.client_id,
          client_name: record.client_name || null,
          workspace_key: record.workspace_key || null,
          scope: record.scope,
          resource: grantResource,
          access_key_hash: hash,
        }),
        'EX',
        REFRESH_TTL
      );
      await indexRefreshToken(owner.org_id, refreshTokenKey(refreshToken));

      recordTokenEvent('connector_token_issued', {
        record,
        metadata: { grant_type: grantType, resource_path: resourcePathOf(grantResource) },
      });
      return res.json({
        access_token: key,
        token_type: 'Bearer',
        expires_in: expiresInSeconds,
        refresh_token: refreshToken,
        // What the token actually carries: the approved scope. The per-request
        // role ceiling can narrow what a given request may do, but it is not a
        // property of the token and differs by workspace.
        scope: tokenScopes.join(' '),
        resource: grantResource,
      });
    }

    if (grantType === 'refresh_token') {
      const refreshToken = body.refresh_token;
      if (!refreshToken) {
        rejectToken('missing_refresh_token', null, body.client_id);
        return res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token is required' });
      }
      const record = await readJson(refreshTokenKey(refreshToken));
      if (!record) {
        rejectToken('refresh_invalid_or_expired', null, body.client_id);
        return res.status(400).json({ error: 'invalid_grant', error_description: 'refresh_token is invalid or expired' });
      }
      if (body.client_id && !safeEqual(body.client_id, record.client_id)) {
        rejectToken('client_id_mismatch', record);
        return res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
      }
      // RFC 8707 §2.2 makes `resource` OPTIONAL on a refresh, and normalizing an
      // omitted one returns the DEFAULT resource (/mcp). A grant issued for
      // /mcp/claude — which is the audience Claude.ai connects to — was therefore
      // refused invalid_target on every refresh that left the parameter out, and
      // the connection died silently at the first token expiry. An omitted
      // resource now means "the one this grant was issued for"; a resource that
      // is PRESENT and names a different audience is still refused, so this is a
      // default, never a widening.
      const hasResourceParam = body.resource !== undefined && body.resource !== null && body.resource !== '';
      const requestedResource = hasResourceParam
        ? normalizeMcpResource(body.resource, issuer(req))
        : record.resource;
      if (!requestedResource || requestedResource !== record.resource) {
        rejectToken('resource_mismatch', record);
        return res.status(400).json({ error: 'invalid_target', error_description: 'resource does not match the refresh token' });
      }
      const owner = { owner_id: record.owner_id, org_id: record.org_id };
      const tokenScopes = normalizeRequestedScopes(record.scope);
      if (!tokenScopes) {
        rejectToken('unsupported_scope', record);
        return res.status(400).json({ error: 'invalid_scope', error_description: 'refresh token contains unsupported scopes' });
      }
      // A grant from before connections were pinned to a workspace carries no
      // stamp. It acts today in the workspace its person has selected, so that
      // is the one it keeps: read from its own key when the boot backfill got
      // there first, from the person otherwise. Never a workspace it did not
      // already act in.
      if (!record.workspace_key) record.workspace_key = await unstampedGrantWorkspace(record);

      // The grant's workspace was captured at consent. If the person has since
      // been removed from it, minting into it again yields a token every call
      // refuses (workspace_forbidden) while the refresh itself keeps working,
      // so the client never asks them to reconnect and their new home is
      // unreachable from any agent. invalid_grant is the one answer a client
      // acts on: it drops the pair and re-runs consent, which binds the person's
      // current workspace. The refresh token is retired with it.
      if (!(await grantOwnerStillBelongs(record))) {
        try {
          await redis.del(refreshTokenKey(refreshToken));
          await forgetRefreshToken(record.org_id, refreshTokenKey(refreshToken));
          await revokeAccessTokenHash(record.access_key_hash);
        } catch (err) {
          console.error('[OAUTH] Could not retire a refresh token for a removed member:', err.message);
        }
        rejectToken('owner_left_workspace', record);
        return res.status(400).json({
          error: 'invalid_grant',
          error_description: 'this connection belongs to a workspace you are no longer a member of; reconnect to continue',
        });
      }

      // The person disconnected this client, or deleted its key: the refresh
      // must not mint it back. See accessKeyWithdrawn. The dead refresh token is
      // retired with the answer, so the client drops the pair and asks again.
      const disconnected = () => res.status(400).json({
        error: 'invalid_grant',
        error_description: 'this connection was disconnected from DeerDawn; reconnect to continue',
      });
      if (await accessKeyWithdrawn(refreshTokenKey(refreshToken), record)) {
        try {
          await redis.del(refreshTokenKey(refreshToken));
          await forgetRefreshToken(record.org_id, refreshTokenKey(refreshToken));
        } catch (err) {
          console.error('[OAUTH] Could not retire the refresh token of a disconnected grant:', err.message);
        }
        return disconnected();
      }

      // A grant made before the refresh record carried its client's NAME
      // rotates into a key that names no client, and each rotation copies the
      // record forward, so it never would: every hosted call on it is filed as
      // 'unknown_web' for the life of the connection, and Setup reads a working
      // Claude.ai or ChatGPT connection as not connected. The registration still
      // has the name. Read it once, here, and carry it from now on.
      const grant = record.client_name
        ? record
        : { ...record, client_name: await registeredClientName(record.client_id) };

      // Issue the new pair BEFORE retiring the old one. The old order (revoke,
      // delete, then mint) meant a failed api_keys insert or Redis write
      // returned 500 with both tokens already gone — the connector could
      // neither retry nor keep working, and the user had to re-consent.
      // Same client as the grant, so the new key lands under the same connection
      // identity the old one had and this connector keeps its project binding
      // across the rotation.
      const { key, hash, expiresInSeconds } = await mintAccessToken(owner, record.resource, tokenScopes, grant);
      const newRefresh = `ddr_${crypto.randomBytes(32).toString('hex')}`;
      try {
        await redis.set(
          refreshTokenKey(newRefresh),
          JSON.stringify({ ...grant, access_key_hash: hash }),
          'EX',
          REFRESH_TTL
        );
      } catch (err) {
        // The new access token has no refresh token to travel with; withdraw
        // it so the old pair stays the one live credential.
        await revokeAccessTokenHash(hash).catch(() => {});
        throw err;
      }
      await indexRefreshToken(owner.org_id, refreshTokenKey(newRefresh));

      // Asked again now that the new pair exists. A disconnect that landed
      // between the check above and the mint revoked every key the grant had
      // at the time, which did not yet include this one; left alone, the pair
      // just minted would outlive it. Either way it goes, the old pair is still
      // untouched here, so a failure costs a retry, never the connection.
      let withdrawnMeanwhile;
      try {
        withdrawnMeanwhile = await accessKeyWithdrawn(refreshTokenKey(refreshToken), record, { besides: hash });
      } catch (err) {
        await revokeRefreshTokenKey(refreshTokenKey(newRefresh)).catch(() => {});
        throw err;
      }
      if (withdrawnMeanwhile) {
        try {
          await revokeRefreshTokenKey(refreshTokenKey(newRefresh));
          await redis.del(refreshTokenKey(refreshToken));
          await forgetRefreshToken(owner.org_id, refreshTokenKey(refreshToken));
        } catch (err) {
          console.error('[OAUTH] Could not withdraw a pair minted across a disconnect:', err.message);
        }
        return disconnected();
      }

      // Only now rotate: retire the old refresh token and its access token.
      // The new pair already exists, so a failure here must not become a 500:
      // that would discard the only live pair the client could still use.
      try {
        await redis.del(refreshTokenKey(refreshToken));
        await forgetRefreshToken(owner.org_id, refreshTokenKey(refreshToken));
        await revokeAccessTokenHash(record.access_key_hash);
      } catch (err) {
        console.error('[OAUTH] Refresh rotation could not retire the previous token pair:', err.message);
      }

      return res.json({
        access_token: key,
        token_type: 'Bearer',
        expires_in: expiresInSeconds,
        refresh_token: newRefresh,
        scope: tokenScopes.join(' '),
        resource: record.resource,
      });
    }

    rejectToken('unsupported_grant_type', null, body.client_id);
    return res.status(400).json({ error: 'unsupported_grant_type' });
  } catch (err) {
    console.error('[OAUTH] Token endpoint error:', err.message);
    rejectToken('server_error', null, body.client_id);
    return res.status(500).json({ error: 'server_error' });
  }
});

// RFC 7009-style revocation. The endpoint deliberately returns success for an
// unknown token so callers cannot use it as a credential-existence oracle.
router.options('/api/v1/oauth/revoke', allowCors);
router.post('/api/v1/oauth/revoke', allowCors, oauthSharedEgressLimiter, oauthGrantLimiter, async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  if (!token) return res.status(200).end();

  try {
    if (token.startsWith('ddr_')) {
      await revokeRefreshTokenKey(refreshTokenKey(token));
    } else if (token.startsWith('dd_')) {
      const hash = hashApiKey(token);
      await revokeAccessTokenHash(hash);
    }
    return res.status(200).end();
  } catch (err) {
    console.error('[OAUTH] Token revocation error:', err.message);
    return res.status(503).json({ error: 'temporarily_unavailable' });
  }
});

// ─── Hosted connections: the grants a person approved, as that person sees them
//
// The consent screen promises "You can revoke access any time from your
// dashboard settings", and until this nothing could: GET /api/v1/keys hides the
// OAuth-minted keys (a new one on every refresh would bury the keys a person
// made), and nothing else listed them. Served to the dashboard by
// routes/shared/connections.js; the token model lives here, so the listing and
// the revocation do too.
//
// ONE ROW PER CLIENT, NOT PER KEY. Every refresh mints a new key row, so a
// month-old Claude.ai connection is several rows, all one connection. The
// client id is what they share (stamped on the key since the columns existed,
// and on the refresh record since before that). A key from before either names
// no client and is its own connection: unnamed, but listed and removable.
//
// The person's own, by owner_id, in whichever workspace the grant was made: a
// grant carries the approver's own org, so a teammate working in a team
// workspace still finds theirs. Nobody else reaches them through these two
// functions. The one other door is the workspace form (listForWorkspace,
// disconnectForWorkspace), for an OWNER of a workspace and only for grants
// stamped as approved for that workspace at consent (oauth_workspace_key).

// The per-owner refresh-token index dataErasureService writes
// (indexRefreshToken). Read-only here: only it and forgetRefreshToken change it.
const REFRESH_INDEX_PREFIX = 'oauth:refresh:owner:';

function connectionIdFor(groupKey) {
  return `conn_${crypto.createHash('sha256').update(groupKey).digest('hex').slice(0, 32)}`;
}

// A connection can still act if any of its keys is active and either unexpired
// or young enough that the refresh token minted beside it is still live.
function connectionIsLive(group, now = Date.now()) {
  return group.keys.some((key) => key.status === 'active' && (
    new Date(key.expires_at).getTime() > now || new Date(key.created_at).getTime() > now - REFRESH_TTL * 1000
  ));
}

// `personIds` finds one person's grants wherever they were made. `workspaceKey`
// instead finds every grant approved FOR one workspace (oauth_workspace_key) by
// anybody who is still an active member of it, one connection per person and
// client. The two are never combined, and the workspace form only ever reads
// rows and refresh records that carry that exact stamp: a person's connection
// for another workspace, their own, or from before the stamp existed is not in
// it, and so cannot be listed or revoked through it.
async function loadHostedGrants(personIds, { workspaceKey = null, includeFormerMembers = false } = {}) {
  const people = new Set((personIds || []).filter(Boolean));
  if (!workspaceKey && !people.size) return new Map();
  // `includeFormerMembers` (with people) is for taking a person's connections
  // back after they LEFT the workspace: the membership join below would
  // otherwise be the one thing that hides exactly what has to be revoked.
  const scopedToPeople = Boolean(workspaceKey && includeFormerMembers && people.size);
  const { rows } = workspaceKey
    ? await db.query(
      `SELECT k.key_id, k.key_hash, k.owner_id, k.org_id, k.status, k.created_at, k.expires_at, k.last_used_at,
              k.oauth_client_id, k.oauth_client_name, k.oauth_resource
         FROM api_keys k
        WHERE k.oauth_workspace_key = $1 AND k.oauth_resource IS NOT NULL
          AND (($3::boolean AND k.owner_id = ANY($2::text[]))
               OR (NOT $3::boolean AND EXISTS (SELECT 1 FROM workspace_members m
                                                WHERE m.owner_key = $1 AND m.user_id = k.owner_id AND m.removed_at IS NULL)))
        ORDER BY k.created_at ASC`,
      [workspaceKey, scopedToPeople ? [...people] : [], scopedToPeople],
      'org-system'
    )
    : await db.query(
      `SELECT key_id, key_hash, owner_id, org_id, status, created_at, expires_at, last_used_at,
              oauth_client_id, oauth_client_name, oauth_resource
         FROM api_keys
        WHERE owner_id = ANY($1::text[]) AND oauth_resource IS NOT NULL
        ORDER BY created_at ASC`,
      [[...people]],
      'org-system'
    );
  const owners = new Set(rows.map((row) => row.owner_id));
  const stampedHashes = new Set(rows.map((row) => row.key_hash));

  // Refresh tokens are found through the index of every org these grants were
  // made in. Tokens minted before the index existed are not found here, and do
  // not need to be: once their key is revoked the refresh grant refuses them
  // (accessKeyWithdrawn).
  const refresh = [];
  for (const orgId of new Set(rows.map((row) => row.org_id).filter(Boolean))) {
    const members = await redis.smembers(`${REFRESH_INDEX_PREFIX}${orgId}`);
    for (const tokenKey of members || []) {
      const record = await readJson(tokenKey);
      if (!record) continue;
      // A record with no stamp of its own (not yet reached by the boot backfill)
      // belongs to this workspace when the access key it last minted does.
      const inWorkspace = workspaceKey
        && owners.has(record.owner_id)
        && (record.workspace_key === workspaceKey || (!record.workspace_key && stampedHashes.has(record.access_key_hash)));
      if (workspaceKey ? inWorkspace : people.has(record.owner_id)) {
        refresh.push({ tokenKey, record });
      }
    }
  }
  const clientByHash = new Map(refresh.map(({ record }) => [record.access_key_hash, record]));

  // A workspace view keeps one person's Claude apart from a colleague's; a
  // person's own view has only them, so the client alone identifies it.
  const scoped = (groupKey, owner) => (workspaceKey ? `${owner}|${groupKey}` : groupKey);
  const groups = new Map();
  const groupFor = (groupKey, clientId, owner) => {
    if (!groups.has(groupKey)) {
      const idSource = workspaceKey ? `ws:${workspaceKey}|${groupKey}` : groupKey;
      groups.set(groupKey, {
        groupKey, connection_id: connectionIdFor(idSource), client_id: clientId, owner_id: owner, keys: [], refresh: [], names: [],
      });
    }
    return groups.get(groupKey);
  };
  for (const row of rows) {
    const fromRecord = clientByHash.get(row.key_hash);
    const clientId = row.oauth_client_id || fromRecord?.client_id || null;
    const group = groupFor(scoped(clientId ? `client:${clientId}` : `key:${row.key_id}`, row.owner_id), clientId, row.owner_id);
    group.keys.push(row);
    if (row.oauth_client_name) group.names.push(row.oauth_client_name);
    else if (fromRecord?.client_name) group.names.push(fromRecord.client_name);
  }
  for (const entry of refresh) {
    const groupKey = entry.record.client_id ? scoped(`client:${entry.record.client_id}`, entry.record.owner_id) : null;
    if (groupKey && groups.has(groupKey)) groups.get(groupKey).refresh.push(entry);
  }
  return groups;
}

// What a person is shown for one connection. The display name falls back to
// the client's own registration, then to a CIMD client id's host; the SURFACE
// is read from a name alone, the same way a call is labelled, so a connection
// is never placed on a tool's card by guessing from where its metadata lives.
function describeConnection(group, registeredNames) {
  const newest = group.keys[group.keys.length - 1];
  const recorded = group.names[group.names.length - 1] || null;
  const registered = group.client_id ? registeredNames.get(group.client_id) || null : null;
  let host = null;
  if (!recorded && !registered && /^https:\/\//.test(group.client_id || '')) {
    try { host = new URL(group.client_id).hostname; } catch { host = null; }
  }
  const name = recorded || registered || null;
  const lastUsed = group.keys.map((key) => key.last_used_at).filter(Boolean)
    .map((value) => new Date(value)).sort((a, b) => b - a)[0] || null;
  return {
    connection_id: group.connection_id,
    client_id: group.client_id,
    client_name: name || host,
    // False when no name was ever recorded for this client: the connection is
    // real, but it could be any tool, and the dashboard must not rule it out.
    identified: Boolean(name),
    surface: name ? credentialSurface({ oauth_client_name: name }) || '' : '',
    // The same two facts, apart (services/connectionIdentity): which tool the
    // client's name says it is (null when it names none), and how it connects.
    // A listed connection is always a hosted OAuth grant. `surface` is unchanged.
    tool: name ? connectionIdentity.cleanTool(credentialSurface({ oauth_client_name: name })) : null,
    transport: connectionIdentity.TRANSPORT.HOSTED_OAUTH,
    resource: newest.oauth_resource,
    first_authorized_at: new Date(group.keys[0].created_at).toISOString(),
    last_used_at: lastUsed ? lastUsed.toISOString() : null,
  };
}

// Registered names for DCR clients whose keys never carried one. Best-effort:
// the listing is still right without it, only less readable.
async function registeredNamesFor(groups) {
  const unnamed = [...groups.values()].filter((group) => !group.names.length && group.client_id).map((group) => group.client_id);
  const names = new Map();
  if (!unnamed.length) return names;
  try {
    const { rows } = await db.query(
      'SELECT client_id, client_name FROM oauth_clients WHERE client_id = ANY($1::text[])',
      [unnamed],
      'org-system'
    );
    for (const row of rows) if (row.client_name) names.set(row.client_id, row.client_name);
  } catch (err) {
    console.warn('[OAUTH] connection names unavailable:', err.message);
  }
  return names;
}

async function listHostedConnections(personIds) {
  const groups = await loadHostedGrants(personIds);
  const live = [...groups.values()].filter((group) => connectionIsLive(group));
  const registeredNames = await registeredNamesFor(new Map(live.map((group) => [group.groupKey, group])));
  return live
    .map((group) => describeConnection(group, registeredNames))
    .sort((a, b) => String(b.last_used_at || b.first_authorized_at).localeCompare(String(a.last_used_at || a.first_authorized_at)));
}

/**
 * Take one client's access away from one person: every refresh token that can
 * be found (RFC 7009's own path, revokeRefreshTokenKey) and every key it still
 * holds (revokeAccessTokenHash). A key revoked is enough on its own: the refresh
 * grant refuses to rotate it, which is what stops a token the index never knew.
 *
 * The answer is a READ-BACK, not a tally of what was attempted. If a refresh of
 * this very client raced the revocation and minted a key in between, the second
 * pass retires that too; only a read-back with nothing left is a success.
 *
 * Returns null when this person has no such live connection.
 */
async function disconnectHostedConnection(personIds, connectionId) {
  return disconnectGroup(() => loadHostedGrants(personIds), connectionId);
}

// The same revocation, for an OWNER of a workspace taking back a connection a
// colleague approved for it. `load` is what scopes it: the workspace form of
// loadHostedGrants only ever contains grants stamped with this workspace, so a
// connection id from anywhere else finds nothing and answers null.
async function disconnectWorkspaceConnection(workspaceKey, connectionId) {
  if (!workspaceKey) return null;
  return disconnectGroup(() => loadHostedGrants([], { workspaceKey }), connectionId);
}

async function disconnectGroup(load, connectionId) {
  let group = [...(await load()).values()].find((candidate) => candidate.connection_id === connectionId);
  if (!group || !connectionIsLive(group)) return null;
  const registeredNames = await registeredNamesFor(new Map([[group.groupKey, group]]));
  const connection = describeConnection(group, registeredNames);
  const revoked = { access_tokens: 0, refresh_tokens: 0 };
  let remaining = null;
  for (let pass = 0; pass < 2; pass += 1) {
    for (const { tokenKey } of group.refresh) {
      await revokeRefreshTokenKey(tokenKey);
      revoked.refresh_tokens += 1;
    }
    for (const key of group.keys.filter((candidate) => candidate.status === 'active')) {
      await revokeAccessTokenHash(key.key_hash);
      revoked.access_tokens += 1;
    }
    const after = (await load()).get(group.groupKey);
    remaining = {
      access_tokens: after ? after.keys.filter((key) => key.status === 'active').length : 0,
      refresh_tokens: after ? after.refresh.length : 0,
    };
    if (!remaining.access_tokens && !remaining.refresh_tokens) break;
    group = after;
  }
  return { connection, owner_id: group.owner_id, revoked, remaining };
}

/**
 * Take back EVERY connection one person approved for one workspace, live or not,
 * with the Redis refresh records that can mint more. Used when the person is
 * removed from it or leaves: their grants carry the approver's own org, so the
 * removal's `owner_id AND org_id` key revocation never reached them, and a token
 * stayed active for up to 90 days and came back to life on a re-invite without
 * anyone consenting again. Same read-back as a disconnect: a second pass retires
 * a key a racing refresh minted in between. Returns what is left (zeros on
 * success) so the caller can refuse to report a clean removal over a partial one.
 */
async function revokeWorkspaceConnectionsOf(workspaceKey, personIds) {
  const people = (personIds || []).filter(Boolean);
  const revoked = { access_tokens: 0, refresh_tokens: 0, connections: 0 };
  if (!workspaceKey || !people.length) return { revoked, remaining: { access_tokens: 0, refresh_tokens: 0 } };
  const load = () => loadHostedGrants(people, { workspaceKey, includeFormerMembers: true });
  let groups = await load();
  revoked.connections = groups.size;
  let remaining = { access_tokens: 0, refresh_tokens: 0 };
  for (let pass = 0; pass < 2 && groups.size; pass += 1) {
    for (const group of groups.values()) {
      for (const { tokenKey } of group.refresh) {
        await revokeRefreshTokenKey(tokenKey);
        revoked.refresh_tokens += 1;
      }
      for (const key of group.keys.filter((candidate) => candidate.status === 'active')) {
        await revokeAccessTokenHash(key.key_hash);
        revoked.access_tokens += 1;
      }
    }
    groups = await load();
    remaining = {
      access_tokens: [...groups.values()].reduce((n, g) => n + g.keys.filter((key) => key.status === 'active').length, 0),
      refresh_tokens: [...groups.values()].reduce((n, g) => n + g.refresh.length, 0),
    };
    if (!remaining.access_tokens && !remaining.refresh_tokens) break;
  }
  return { revoked, remaining };
}

/**
 * Every live connection approved for one workspace, for its owner: one row per
 * person and client. The route checks the caller owns the workspace; this only
 * ever returns what carries that workspace's stamp.
 */
async function listWorkspaceConnections(workspaceKey) {
  if (!workspaceKey) return [];
  const groups = await loadHostedGrants([], { workspaceKey });
  const live = [...groups.values()].filter((group) => connectionIsLive(group));
  const registeredNames = await registeredNamesFor(new Map(live.map((group) => [group.groupKey, group])));
  return live
    .map((group) => ({ ...describeConnection(group, registeredNames), owner_id: group.owner_id }))
    .sort((a, b) => String(b.last_used_at || b.first_authorized_at).localeCompare(String(a.last_used_at || a.first_authorized_at)));
}

module.exports = router;
module.exports.hostedConnections = {
  list: listHostedConnections,
  disconnect: disconnectHostedConnection,
  listForWorkspace: listWorkspaceConnections,
  disconnectForWorkspace: disconnectWorkspaceConnection,
  revokeForPersonInWorkspace: revokeWorkspaceConnectionsOf,
};
