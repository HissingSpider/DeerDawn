'use strict';

/**
 * A stable session identity for the hosted (web) MCP connector.
 *
 * That transport is stateless by construction — a fresh Server per request, no
 * session management — so there is no process, and no MCP session id, to hang an
 * identity on. `clientInfo` arrives only on `initialize`; a bare tools/call has
 * none. At write time the only identity signals are who is writing, where the
 * write lands, and the tool the caller declares.
 *
 * It used to mint `mcp-remote-${Date.now()}` per write, which is worse than no
 * id at all: session_id is what presence, board holds, and the contention
 * baseline all count DISTINCT values of, so one web client writing five times
 * read as five colliding agents. That is what inflated the first production
 * baseline to 54.8%.
 *
 * So this derives an id that is STABLE rather than unique — the same person, on
 * the same surface, writing into the same workspace is the same logical session,
 * permanently. Deliberately no time bucket: a bucket boundary would split one
 * session in two and reintroduce the same over-count in slower motion. Liveness
 * is already carried by context_sessions.last_seen_at, which moves on every
 * write, so a permanently stable id is exactly what presence wants.
 *
 * THE PERSON IS IN THE KEY, AND THAT IS A CHANGE FROM THE ORIGINAL DESIGN.
 *
 * This was first written against a single-user product, where deriving from the
 * owner key alone was right and its stated trade — "two people in a shared
 * workspace on the same surface collapse into one session" — was an acceptable
 * under-count. Multi-user workspaces changed that. Presence now NAMES people
 * ("sarah@acme.com has recently written here"), so collapsing two colleagues
 * into one session id no longer just under-reports contention: it attributes
 * one person's writing to another, or hides them from a teammate entirely.
 * Under-counting was the safe error; misattributing a named person is not.
 *
 * So the digest covers the workspace AND the person. What still collapses, on
 * purpose, is one person's several tabs on one surface — that is genuinely one
 * session, and it is the case the stable id exists to merge.
 *
 * The workspace comes from workspaceService rather than actor.org_id directly:
 * after multi-user workspaces the write lands in the BOUND workspace, and an id
 * keyed to the caller's personal org would label a row that lives somewhere else.
 *
 * Lives in its own module so it can be tested without loading the MCP route and
 * everything it pulls in.
 */

const { createHash } = require('crypto');
const workspace = require('./workspaceService');

/** Prefix chosen so the id is recognisable as derived — and so it can never be
 *  mistaken for the per-write ids the baseline excludes, which require a
 *  trailing timestamp. See apps/api/scripts/multi-agent-baseline.js. */
const HOSTED_SESSION_PREFIX = 'web';

/** The tool values context_sessions.tool accepts. Anything derived here has to
 *  be one of them, or the session write is rejected by the schema. */
const KNOWN_TOOLS = new Set(['claude_web', 'chatgpt_web', 'gemini', 'perplexity', 'cursor', 'claude_code', 'codex']);

// THE PERSON IS NOT THE CONNECTION, AND THAT IS THE SECOND CHANGE HERE.
//
// Keying on (workspace, person, surface) alone gave every hosted client ONE
// shared session row, because `tool` was the catalog default 'claude_web' on
// every call. claude.ai, ChatGPT and a Claude Code connector were therefore one
// session: each one's writes moved the binding the others resolved through, and
// a Claude Code session working in a repo opened the project a browser tab had
// written to fifteen minutes earlier. The brief also said "via claude_web" for
// all three.
//
// A connection is a CREDENTIAL. Each connector authenticates with its own OAuth
// grant or its own API key, so that is what separates them.
function connectionKey(actor) {
  if (!actor || actor.type !== 'key') return '';
  // The OAuth CLIENT, not the key row, and this is the whole reason api_keys
  // carries it: a refresh grant MINTS A NEW KEY (routes/oauth.js
  // mintAccessToken, on both grant types), so keying on the key id would throw
  // this connection's project binding away every time its token rotated —
  // silently, roughly monthly, and only for the people using the product most.
  // The client_id is issued once at registration, travels on the refresh record,
  // and still tells claude.ai from ChatGPT from an editor.
  if (actor.oauth_client_id) return `oauth:${actor.oauth_client_id}`;
  // A plain API key IS one connection: a person pastes one into each tool's
  // config. A deliberate reversal of "one person is one session across their own
  // keys" — that under-count was harmless while nothing hung off a session id,
  // and is exactly what let one client redirect another client's reads.
  return actor.id ? `key:${actor.id}` : '';
}

// CIMD client_ids are URLs, so the host names the client. A DCR client has an
// opaque id and its registered name is all there is. Both are matched against
// the small set of tools the session schema accepts; anything unrecognised
// stays '' so the caller can fall back rather than assert something false.
const SURFACE_BY_HOST = [
  [/(^|\.)chatgpt\.com$/, 'chatgpt_web'],
  [/(^|\.)openai\.com$/, 'chatgpt_web'],
  [/(^|\.)cursor\.(com|sh)$/, 'cursor'],
  [/(^|\.)claude\.ai$/, 'claude_web'],
];

// Ordered: "Claude Code" contains "claude", so the specific client has to be
// tested before the generic one or every editor reports itself as a browser.
const SURFACE_BY_NAME = [
  [/claude[\s_-]*code/, 'claude_code'],
  [/codex/, 'codex'],
  [/cursor/, 'cursor'],
  [/chatgpt|openai/, 'chatgpt_web'],
  [/claude|anthropic/, 'claude_web'],
];

/**
 * Which client is on the other end of this credential?
 *
 * Known at token mint and stored on the key, so this costs no round trip: the
 * api-key cache hands these columns back with the row the auth middleware
 * already reads.
 */
function credentialSurface(actor) {
  // NAME BEFORE HOST, because the host is the coarser signal: an editor and a
  // browser client can both be registered under claude.ai, and answering
  // claude_web for both is the misnaming this exists to end. The host is the
  // fallback for a client whose name says nothing recognisable.
  const name = String(actor?.oauth_client_name || '').toLowerCase();
  if (name) {
    for (const [pattern, surface] of SURFACE_BY_NAME) if (pattern.test(name)) return surface;
  }
  const clientId = String(actor?.oauth_client_id || '');
  if (clientId.startsWith('http')) {
    try {
      const host = new URL(clientId).hostname.toLowerCase();
      for (const [pattern, surface] of SURFACE_BY_HOST) if (pattern.test(host)) return surface;
    } catch { /* not a URL after all, and the name already said nothing */ }
  }
  return '';
}

/**
 * The tool label for a hosted call: what the caller declared, else what the
 * credential says, else what the handshake said, else the catalog default.
 *
 * Declared first because a caller that names its own surface is telling the
 * truth about itself; the credential next because it is the only identity a
 * bare tools/call carries at all (clientInfo arrives on `initialize` alone).
 * Nothing new is advertised — every input here already exists.
 */
function hostedSessionTool(actor, declaredTool, handshakeSurface) {
  const declared = String(declaredTool || '').trim();
  if (KNOWN_TOOLS.has(declared)) return declared;
  const fromCredential = credentialSurface(actor);
  if (fromCredential) return fromCredential;
  if (KNOWN_TOOLS.has(handshakeSurface)) return handshakeSurface;
  return 'claude_web';
}

function hostedSessionId(actor, tool) {
  // The workspace the write actually lands in, not the org the caller signed up
  // under. defaultOwnerKey prefers the bound workspace and falls back to the
  // personal one, which is the same resolution every store call uses.
  const ownerKey = workspace.defaultOwnerKey(actor) || 'unknown';
  // The human, not the credential: attribution stays by PERSON, so presence and
  // the brief still name who wrote something even though the id below now
  // separates that person's connections.
  const personId = workspace.actorPersonId(actor) || 'anonymous';
  const connection = connectionKey(actor);
  // With a connection to key on, the label comes from the CREDENTIAL and the
  // caller-declared `tool` is ignored for the id. That is load-bearing: the id
  // is what a project binding hangs off, so letting one argument on one call
  // change it would give the same connector two identities and strand the
  // binding under the other one. With no connection (a cookie-authed or
  // internal actor) the declared tool is all there is, as it always was.
  // Both arms default to the same label, so a caller that passes no `tool` and
  // one that passes the catalog default derive the SAME id. That matters more
  // than it looks: the read path resolves a session id without any arguments to
  // hand, and a different default there would have looked up a binding the
  // write path never wrote.
  const rawSurface = connection
    ? (credentialSurface(actor) || 'claude_web')
    : (tool || credentialSurface(actor) || 'claude_web');
  // Sanitised rather than trusted: it becomes part of a stored identifier, and
  // an unbounded caller-supplied value would be a storage problem.
  const surface = String(rawSurface).replace(/[^a-z0-9_]/gi, '').slice(0, 24) || 'web';
  // Hashed for length and opacity. The row this lands on is already scoped by
  // owner_key, so the digest carries no authority of its own. The NUL separator
  // keeps ('ab','c') and ('a','bc') from colliding.
  const digest = createHash('sha256')
    .update(`${ownerKey}\0${personId}\0${connection}`)
    .digest('hex')
    .slice(0, 12);
  return `${HOSTED_SESSION_PREFIX}-${surface}-${digest}`;
}

module.exports = {
  hostedSessionId,
  hostedSessionTool,
  credentialSurface,
  connectionKey,
  HOSTED_SESSION_PREFIX,
};
