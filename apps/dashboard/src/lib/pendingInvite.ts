/**
 * An invitation somebody opened before they had a session.
 *
 * The invite link is the only thing that knows which workspace a new person was
 * asked into, and sign-up is a detour through at least one other page (and, for
 * Clerk, often a different origin: the dashboard's /signup forwards to the
 * marketing site). The return URL is carried through that detour as well, but
 * every hop that rebuilds a URL is a hop that can drop it, and one did: the
 * login/signup toggle and the marketing form both used to. So the token is also
 * parked here, in this tab, and redeemed the first time the tab has a session.
 *
 * sessionStorage, not localStorage: it is per tab and dies with it, so a shared
 * machine does not hand the next person somebody else's pending invite, and it
 * still survives a same-tab round trip to another origin and back.
 */

const STORAGE_KEY = 'deerdawn.pendingInvite';
// Long enough for sign-up plus email verification, short enough that a tab left
// open over a weekend does not join a workspace on Monday.
export const PENDING_INVITE_TTL_MS = 6 * 60 * 60 * 1000;

type Stored = { token: string; at: number };

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function stashPendingInvite(token: string, now = Date.now()): void {
  if (!token) return;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify({ token, at: now } satisfies Stored));
  } catch {
    /* the return URL still carries it */
  }
}

export function parsePendingInvite(raw: string | null | undefined, now = Date.now()): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (typeof parsed?.token !== 'string' || !parsed.token) return null;
    if (typeof parsed.at !== 'number' || now - parsed.at > PENDING_INVITE_TTL_MS || parsed.at > now + 60_000) return null;
    return parsed.token;
  } catch {
    return null;
  }
}

export function readPendingInvite(now = Date.now()): string | null {
  try {
    return parsePendingInvite(storage()?.getItem(STORAGE_KEY), now);
  } catch {
    return null;
  }
}

export function clearPendingInvite(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** The page that redeems a token. Relative, so it passes getSafeRedirectPath. */
export function invitePath(token: string): string {
  return `/invite?token=${encodeURIComponent(token)}`;
}

/** Where a signed-out invitee goes to get an account, with the way back attached. */
export function inviteAuthPath(token: string, mode: 'signup' | 'login'): string {
  return `/${mode}?redirect_url=${encodeURIComponent(invitePath(token))}`;
}

/**
 * Pages on which a pending invite must NOT pull the reader away: the auth pages
 * (they are mid-sign-in), the invite page itself (it redeems), checkout (a
 * purchase in flight), and the authorize screens (an OAuth handshake that is
 * navigated away from is lost).
 *
 * And the billing pages. A parked token that cannot be redeemed (the accept is
 * refused for as long as the reader's workspace has a lapsed plan) pulled every
 * page back to /invite for the token's whole lifetime, including the one page
 * that could fix the plan. Paying the bill must always be reachable.
 */
const NO_REDEEM_PREFIXES = ['/login', '/signup', '/forgot-password', '/mcp-auth', '/oauth', '/invite', '/checkout'];
const NO_REDEEM_PAGES = new Set(['/settings/plan', '/settings/upgrade', '/select-plan']);

export function shouldRedirectToPendingInvite(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (NO_REDEEM_PAGES.has(path)) return false;
  return !NO_REDEEM_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Refusals about the workspace the reader was BOUND to when they pressed Join,
 * not about the invitation.
 *
 * The accept is answered in whatever workspace the request is bound to, and a
 * binding to a team whose subscription lapsed (subscription_inactive, past_due,
 * workspace_inactive), that is locked (lockdown_active), or that the reader was
 * removed from (workspace_forbidden) refuses it before the token is even read.
 * The link is fine. These used to fall through to "This invite link is invalid
 * or has been revoked", which is false, and the page also discarded the parked
 * token, so the reader was told to go and get a new link that would have been
 * refused the same way.
 *
 * Every one of them is cured by binding to the reader's own workspace, so the
 * page offers exactly that. The retry reads the token from the page's own URL,
 * so the token is NOT parked again for it: a parked token pulls every other page
 * back to /invite, and one that keeps being refused would hold the reader there
 * for hours (see shouldRedirectToPendingInvite).
 */
const BOUND_WORKSPACE_REFUSALS = new Set([
  'subscription_inactive',
  'past_due',
  'workspace_inactive',
  'lockdown_active',
  'workspace_forbidden',
]);

/** Is this a refusal about the bound workspace, which switching to your own
 *  workspace and trying again can fix? */
export function inviteFailureIsRetryable(reason: string | undefined): boolean {
  return Boolean(reason && BOUND_WORKSPACE_REFUSALS.has(reason));
}

/** What to tell the reader for a refused invitation, by the server's reason. */
export function inviteFailureMessage(
  reason: string | undefined,
  invitedEmail: string | undefined,
  serverMessage?: string,
): string {
  switch (reason) {
    case 'subscription_inactive':
    case 'past_due':
    case 'workspace_inactive':
      return 'Your invitation is still valid. The workspace you are currently using has an inactive subscription,'
        + ' and that blocked joining. Switch to your own workspace and try again.';
    case 'lockdown_active':
      return 'Your invitation is still valid. The workspace you are currently using is locked, and that blocked'
        + ' joining. Switch to your own workspace and try again.';
    case 'workspace_forbidden':
      return 'Your invitation is still valid. This browser was still set to a workspace you are no longer a member of,'
        + ' and that blocked joining. Switch to your own workspace and try again.';
    case 'workspace_not_accepting_members':
      // The server names the workspace; this page cannot. Without this case the
      // reader was told the link was "invalid or has been revoked", which is
      // false, and sent to ask for a new one that would be refused the same way.
      return serverMessage
        || 'That workspace is not accepting new members right now. Ask the person who invited you. Your invitation link will work again once it is.';
    case 'wrong_account':
      return `This invitation was sent to ${invitedEmail || 'a different address'}. Sign in as that account to accept it.`;
    case 'expired':
      return 'This invitation has expired. Ask for a new one.';
    case 'already_accepted':
      return 'This invitation has already been used.';
    case 'revoked':
      return 'This invitation was withdrawn. Ask the workspace owner for a new one.';
    default:
      return 'This invite link is invalid or has been revoked.';
  }
}
