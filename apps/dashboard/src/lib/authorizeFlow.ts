// Shared logic for the two authorize screens: /mcp-auth (device code, `?code=`)
// and /oauth/consent (authorization code, `?req=`). Kept out of the pages so it
// can be tested as logic. Both pages render outside the dashboard shell and
// behind Clerk, which makes them expensive to render in a test and cheap to get
// subtly wrong.

/**
 * How long a device sign-in link lives, in minutes, as the /mcp-auth copy states
 * it. There is no constant shared between the API and this app, so these mirror
 * two in apps/api/src/config/deviceFlow.js and authorizeFlow.test.ts reads
 * that file and fails if either drifts:
 *
 *   EXTENDED_DEVICE_CODE_TTL = 1800  the window every current client is given
 *   DEVICE_CODE_TTL          = 600   clients at or below 1.0.44, which stop
 *                                    polling after a hardcoded ten minutes
 *
 * The page said "ten minutes" to everybody. Current clients get thirty, so it
 * told most people their link was dead twenty minutes before it was.
 */
export const DEVICE_LINK_MINUTES = 30;
export const LEGACY_DEVICE_LINK_MINUTES = 10;
/** The first @deerdawn/mcp-server release that is given the long window. */
export const DEVICE_LINK_EXTENDED_SINCE = '1.0.45';

/** The sentence the expired-link panel shows. One string, so it renders as written. */
export function deviceLinkLifetimeCopy(): string {
  return `valid for ${DEVICE_LINK_MINUTES} minutes (${LEGACY_DEVICE_LINK_MINUTES} if your DeerDawn server is older than ${DEVICE_LINK_EXTENDED_SINCE})`;
}

/**
 * Where "Switch account" comes back to: this authorize URL, query intact.
 *
 * The query IS the request (`?req=` / `?code=`), so dropping it turns an account
 * switch into a lost connection. The hash is dropped on purpose. Clerk's
 * redirect-mode components keep their own routing state there (`#/?redirect_url=`
 * and friends, see authQueryWithClerkHash in redirects.ts), and carrying a stale
 * one through a sign-out hands the next Clerk component somebody else's state.
 *
 * Returns null for anything that is not an http(s) URL, so a caller never
 * redirects a just-signed-out browser to a string it could not parse.
 */
export function authorizeReturnUrl(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

/**
 * The same-origin PATH (with query, without hash) of an authorize URL, or null.
 *
 * The hash is dropped for the reason authorizeReturnUrl drops it: Clerk's
 * redirect-mode components park their own routing state there, and carrying a
 * stale one forward hands the next component somebody else's state.
 */
export function authorizeReturnPath(
  href: string | null | undefined,
  origin: string | null | undefined,
): string | null {
  // No base is passed on purpose: the input is always an absolute
  // window.location.href, so anything that needs a base to parse is not the
  // thing this is for, and resolving it against the origin would launder a
  // typo into a navigation target. No origin means the server, which cannot
  // know this and must answer nothing.
  if (!href || !origin) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.origin !== origin) return null;
    const path = `${url.pathname}${url.search}`;
    if (!path.startsWith('/') || path.startsWith('//')) return null;
    return path;
  } catch {
    return null;
  }
}

/**
 * Where "Sign up with email" on an authorize screen has to go.
 *
 * THE BUG. The panel used Clerk's `<SignUpButton mode="redirect"
 * forceRedirectUrl={returnUrl}>` under copy promising "you come straight back
 * here". Clerk carries that return target in the HASH, as
 * `#/?redirect_url=...&sign_up_force_redirect_url=...` (see
 * authQueryWithClerkHash in redirects.ts). A hash never reaches a server, and
 * the dashboard's /signup redirects Clerk-mode visitors to the marketing sign-up
 * from getServerSideProps, which forwards only the QUERY — so the hash-reading
 * half of that page never rendered, marketing's /signup reads `redirect_url`
 * alone, and the new account landed on /onboarding with the `?req=` / `?code=`
 * gone. Google sign-up and Sign in both work; only email sign-up broke, which is
 * exactly the brand-new user who copied a connector URL before signing up.
 *
 * So put the return target where a server can see it: the same
 * `/signup?redirect_url=<path>` shape the invite flow uses
 * (pendingInvite.inviteAuthPath) and the billing pages use
 * (checkoutIntent.buildSignInRedirect). Both hops already carry it — dashboard
 * /signup forwards its whole query to marketing, and marketing /signup resolves
 * `redirect_url` back into an app URL that the verification step navigates to.
 *
 * SAME-SITE OR NOTHING. `href` is this page's own location, but the result is a
 * navigation target, so it is validated rather than trusted: an absolute URL is
 * reduced to its path and query only when its origin matches, and anything else
 * falls back to a bare `/signup`. `origin` is a parameter so this stays pure.
 */
export function authorizeSignupPath(
  href: string | null | undefined,
  origin: string | null | undefined,
): string {
  const returnTo = authorizeReturnPath(href, origin);
  return returnTo ? `/signup?redirect_url=${encodeURIComponent(returnTo)}` : '/signup';
}

export interface AuthorizeFailure {
  /**
   * True when repeating the same request cannot succeed: the request expired,
   * was already used, or was never complete. The only way forward is a new
   * request from the AI tool, so the page must not offer "Try again".
   */
  terminal: boolean;
  /** What to show. The API's own sentence whenever it sent one. */
  message: string;
  /** Groupable reason for analytics. Never user-supplied text. */
  reason: string;
}

const RESTART_HINT = 'Restart the connection from your AI tool.';

/**
 * Turn a failed authorize response into what the page should say and offer.
 *
 * /oauth/consent used to collapse every failure into "Something went wrong" plus
 * a Try again button. For an expired request that button re-sent the same dead
 * id, got the same 404, and offered itself again: a loop with no exit, on the
 * single most likely failure (the request lives ten minutes). The details fetch
 * was worse. It threw the API's response away on any non-200, so an expired
 * request rendered as an "Unverified connection" warning above a Connect button
 * that could only fail.
 */
export function describeAuthorizeFailure(status: number, body: unknown): AuthorizeFailure {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const code = typeof b.error === 'string' ? b.error : '';
  const apiMessage = typeof b.message === 'string' && b.message.trim() ? b.message.trim() : '';

  if (code === 'expired_request' || status === 404 || status === 410 || b.terminal === true) {
    return {
      terminal: true,
      message: apiMessage || `This authorization request expired. ${RESTART_HINT}`,
      reason: code || 'expired_request',
    };
  }
  if (code === 'invalid_request') {
    // The API's text here is for developers ("missing or malformed req").
    return {
      terminal: true,
      message: `This link is missing its authorization request, so it cannot be approved. ${RESTART_HINT}`,
      reason: 'invalid_request',
    };
  }
  return {
    terminal: false,
    message: apiMessage || (code ? code : `The request failed (HTTP ${status}).`),
    reason: code || `http_${status}`,
  };
}

// Mirrors the API: request ids are randomBytes(24).toString('hex') in
// apps/api/src/routes/oauth.js, and the webhook refuses anything else.
const CONSENT_REQUEST_ID = /^[a-f0-9]{48}$/;
const PARSE_BASE = 'http://internal.invalid';

/**
 * The consent request id (`?req=`) a sign-up is returning to, or undefined.
 *
 * Carried through Clerk unsafeMetadata so the account_created webhook can name
 * the AI tool the account was created to connect (see
 * apps/api/src/services/connectorSignupAttribution.js). Only the id travels —
 * the server resolves it against its own record — so this reads it and nothing
 * else. Accepts a path or an absolute URL, and answers undefined for anything
 * that is not the consent screen.
 */
export function consentRequestId(target: string | null | undefined): string | undefined {
  if (!target) return undefined;
  try {
    const url = new URL(target, PARSE_BASE);
    if (url.pathname !== '/oauth/consent') return undefined;
    const id = url.searchParams.get('req');
    return id && CONSENT_REQUEST_ID.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

const SSO_CALLBACK_PATH = '/oauth/sso-callback';
const AUTHORIZE_SCREENS = ['/oauth/consent', '/mcp-auth'];

/**
 * The Google callback URL for an OAuth attempt started on an authorize screen.
 *
 * THE BUG. The consent panel's "Continue with Google" passed its URL as
 * `redirectUrlComplete` and nothing else. Clerk honours that only when the
 * attempt completes in one hop. When it does not — a sign-in that turns out
 * to be a new account, or a sign-up that turns out to be an existing one, which
 * Clerk transfers on the callback page — the callback falls back to its own
 * defaults: /select-plan after a sign-up, / after a sign-in. So a brand-new
 * user who came from ChatGPT made an account and was then dropped on the
 * dashboard, with the `?req=` their connection needed gone (2026-09-25: the one
 * Google signup from ChatGPT that day landed on /setup and never approved).
 *
 * Carrying the return path on the callback URL lets the callback page force
 * it for BOTH outcomes. Same-origin authorize screens only; anything else
 * yields the bare callback, which behaves exactly as before.
 */
export function ssoCallbackPath(returnPath: string | null | undefined): string {
  const safe = authorizeScreenPath(returnPath);
  return safe ? `${SSO_CALLBACK_PATH}?return_to=${encodeURIComponent(safe)}` : SSO_CALLBACK_PATH;
}

/**
 * The return path the callback page should force, read back from its own
 * `return_to`, or undefined. Validated again here because it arrives in a URL
 * anyone can hand-edit: a same-origin path to an authorize screen, or nothing.
 */
export function ssoCallbackReturnTo(value: string | string[] | null | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return authorizeScreenPath(raw) || undefined;
}

function authorizeScreenPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  try {
    const url = new URL(value, PARSE_BASE);
    if (url.origin !== PARSE_BASE) return null;
    if (!AUTHORIZE_SCREENS.includes(url.pathname)) return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

/**
 * Carrying an authorize request across a Google sign-UP.
 *
 * THE BUG (found 2026-09-25, E-030). "Continue with Google" on an authorize
 * screen calls `signIn.authenticateWithRedirect({ redirectUrlComplete: <this
 * request> })`. That return target is honoured only when Google resolves to an
 * EXISTING account. For a brand-new one Clerk hands the sign-in over to a
 * sign-up on /oauth/sso-callback, and a completed sign-up goes to the callback's
 * sign-up redirect, which was `/select-plan`: a plan picker with checkout
 * buttons, shown to somebody whose AI tool is still waiting on the request.
 * On 2026-09-25 the first person to arrive from the ChatGPT connector did
 * exactly this: signed out, Google, account created, then /setup and a
 * developer_pro checkout they cancelled, and no approval.
 *
 * The return target cannot ride on the callback URL without trusting Clerk to
 * keep our query through its own redirects, so it rides in sessionStorage: the
 * same tab, the same origin, set on the click and consumed exactly once by the
 * callback. It expires with the request it points at (ten minutes, the lifetime
 * `describeAuthorizeFailure` documents), so an abandoned attempt cannot steer a
 * later, unrelated Google sign-up onto a dead request.
 */
export const AUTHORIZE_RETURN_KEY = 'dd_authorize_return';
export const AUTHORIZE_RETURN_TTL_MS = 10 * 60 * 1000;

/** Only the two authorize screens, as a same-origin path carrying a request. */
export function isAuthorizeRequestPath(path: string | null | undefined): path is string {
  if (!path || !path.startsWith('/') || path.startsWith('//')) return false;
  return /^\/(oauth\/consent|mcp-auth)\?[^#]*\S$/.test(path);
}

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function rememberAuthorizeReturn(
  storage: KeyValueStore | null | undefined,
  path: string | null | undefined,
  now: number,
): boolean {
  if (!storage || !isAuthorizeRequestPath(path)) return false;
  try {
    storage.setItem(AUTHORIZE_RETURN_KEY, JSON.stringify({ path, at: now }));
    return true;
  } catch {
    return false;
  }
}

/** Reads and REMOVES the remembered request; null when absent, stale or not an authorize path. */
export function takeAuthorizeReturn(storage: KeyValueStore | null | undefined, now: number): string | null {
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(AUTHORIZE_RETURN_KEY);
    storage.removeItem(AUTHORIZE_RETURN_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { path?: unknown; at?: unknown };
    const at = typeof parsed.at === 'number' ? parsed.at : NaN;
    if (!(now - at >= 0 && now - at <= AUTHORIZE_RETURN_TTL_MS)) return null;
    return typeof parsed.path === 'string' && isAuthorizeRequestPath(parsed.path) ? parsed.path : null;
  } catch {
    return null;
  }
}
