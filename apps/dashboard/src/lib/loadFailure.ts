/**
 * REFUSED, OR DID NOT COME BACK?
 *
 * Every page that loads data had one failure branch, and it assumed the
 * request never arrived: "The request didn't come back — usually a dropped
 * connection or an expired session. Nothing is lost; retrying is safe." That is
 * the right sentence for a network failure or a 5xx, and a false one for the
 * refusal plan enforcement sends when a workspace's renewal fails: 403
 * `subscription_inactive`, "Your subscription is not active. Update billing to
 * restore access." A paying person whose card failed was told it was their
 * connection, offered a Retry that could never work, and on /projects shown a
 * SAMPLE brief in place of their own. Only Settings > Plan said "Past Due".
 *
 * This is the one place that tells the two apart. Every page asks it; a page
 * keeps its own words for the failure it already described, and the refusal
 * gets the reason and, for the reader who can act on it, the way to act.
 *
 * Pure and duck-typed (like workspaceFallback's isWorkspaceInactiveError): it
 * imports nothing from the API client at runtime, so it is testable without
 * one, and a refusal that arrives through any wrapper is still recognised.
 */
import { boundWorkspaceEntry, type WorkspaceListingLike } from './workspaceFallback';
import { mayOfferBilling } from './billingAccess';
import {
  CHECK_OUT_AGAIN_LABEL,
  FIRST_PAYMENT_NOT_OWNER_LINE,
  FIRST_PAYMENT_OWNER_LINE,
  FIRST_PAYMENT_TITLE,
  parseRetryCheckout,
  retryCheckoutHref,
  type RetryCheckout,
} from './firstPayment';
import { SUPPORT_MAILTO, lockReasonOf, lockSentence, type LockReason } from './lockCopy';

/**
 * - `subscription_inactive`: enforcePlan refused the request because the bound
 *   workspace's subscription is not active (past_due, unpaid, cancelled on a
 *   paid plan, trial_expired).
 * - `locked`: enforcePlan refused it because the workspace is locked.
 * - `unreachable`: everything else, including a genuine network failure, a
 *   timeout and a 5xx. The page says what it said before.
 */
export type LoadFailureKind = 'subscription_inactive' | 'locked' | 'unreachable';

/** Who is reading, as far as billing is concerned. */
export interface RefusalReader {
  /** This reader's role in the workspace the request was bound to, lowercased;
   *  null when the listing did not say. */
  role: string | null;
}

export interface LoadFailure {
  kind: LoadFailureKind;
  /** The server's id for this failure, when it sent one. */
  requestId?: string;
  /** Resolved only for a subscription refusal: who may act on it. Null when
   *  the workspace listing could not be read. */
  reader?: RefusalReader | null;
  /** For a `locked` refusal: which lock (the server's `lock_reason`). Absent on
   *  an API that predates it, which reads as lockdown (lockCopy.lockSentence). */
  lockReason?: LockReason;
  /** For a subscription refusal on a first payment that never went through: what
   *  to check out again. The way out is a new checkout, not the billing portal. */
  retryCheckout?: RetryCheckout;
}

/** The page where billing is updated. It hands off to the billing portal. */
export const UPDATE_BILLING_ROUTE = '/settings/plan';

/** The label the product already uses for that link (the fallback banner and
 *  the Team page's lapsed-subscription refusal). */
export const UPDATE_BILLING_LABEL = 'Update billing';

function reasonOf(error: { code?: unknown; data?: unknown }): string | undefined {
  if (typeof error.code === 'string' && error.code) return error.code;
  const data = error.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const raw = (data as { error?: unknown }).error;
    if (typeof raw === 'string') return raw;
  }
  return undefined;
}

/** Tell "refused, and here is why" from "did not come back". */
export function classifyLoadFailure(error: unknown): LoadFailure {
  if (!error || typeof error !== 'object') return { kind: 'unreachable' };
  const candidate = error as { status?: unknown; code?: unknown; data?: unknown; requestId?: unknown };
  const requestId = typeof candidate.requestId === 'string' && candidate.requestId ? candidate.requestId : undefined;
  const base = requestId ? { requestId } : {};
  // Only a 403 is a refusal. The enforcement gate answers 403 and nothing else;
  // a 5xx or a failed fetch (the client's own 503 network_unreachable and 504
  // network_timeout) did not come back, whatever its body says.
  if (Number(candidate.status) !== 403) return { kind: 'unreachable', ...base };
  const reason = reasonOf(candidate);
  const data = candidate.data && typeof candidate.data === 'object' && !Array.isArray(candidate.data)
    ? candidate.data as Record<string, unknown>
    : {};
  if (reason === 'subscription_inactive') {
    const retry = parseRetryCheckout(data.retry_checkout);
    if (retry) return { kind: 'subscription_inactive', retryCheckout: retry, ...base };
    return { kind: 'subscription_inactive', ...base };
  }
  if (reason === 'lockdown_active') {
    const lockReason = lockReasonOf(data.lock_reason);
    return { kind: 'locked', ...(lockReason ? { lockReason } : {}), ...base };
  }
  return { kind: 'unreachable', ...base };
}

/** A refusal the page must explain, as opposed to a load that did not come back. */
export function isRefusedLoad(failure: LoadFailure | null | undefined): boolean {
  return Boolean(failure) && failure!.kind !== 'unreachable';
}

/**
 * May this reader fix the bill?
 *
 * Only a workspace owner may change a workspace's billing, and only an owner the
 * listing NAMES as one: the same rule as the fallback banner
 * (workspaceFallback.mayFixFallbackBilling), so the two surfaces can never
 * disagree about who is offered the link. An unknown role is not an owner: a
 * member sent to a billing page they cannot use has one more dead end. The rule
 * itself is lib/billingAccess, shared by every page that offers billing.
 */
export function mayUpdateBilling(reader: RefusalReader | null | undefined): boolean {
  return mayOfferBilling({ role: reader?.role });
}

export interface RefusalCopy {
  title: string;
  description: string;
  /** Where to act on it, or null when this reader cannot. `mailto` is a link to
   *  write to support; `switch_workspace` is a button that moves the reader to
   *  their own workspace (POST /teams/active is exempt from the lock). */
  action: { href: string; label: string; kind?: 'link' | 'mailto' | 'switch_workspace' } | null;
}

export { retryCheckoutHref };

/**
 * What a refused page says, in words the product already uses.
 *
 * - The title is the product's own sentence for this state
 *   ("This workspace’s subscription is inactive.", lib/teamInvites; the
 *   fallback banner builds "<workspace>’s subscription is inactive.").
 * - An owner is told what the API itself sent ("Update billing to restore
 *   access.") and given the link to where billing is updated.
 * - Anybody else is told who can act (lib/teamInvites, for a member of a lapsed
 *   team: "Only a workspace owner can restore it by updating billing.") and is
 *   given no billing button, because every billing action refuses them.
 * - A locked workspace gets the sentence for ITS lock (dispute, lockdown, or
 *   somebody else's workspace; lib/lockCopy) and never a billing link: billing
 *   cannot unlock it.
 * - A workspace whose first payment never went through is offered a new
 *   checkout for the same plan, not the billing portal.
 *
 * Nothing here speaks about what happens to data, about grace periods or dates.
 */
export function refusalCopy(failure: LoadFailure): RefusalCopy {
  if (failure.kind === 'locked') {
    // Three locks, three sentences (lib/lockCopy). Billing cannot lift any of
    // them, so none offers a billing link.
    const reason = failure.lockReason || 'lockdown';
    const description = lockSentence(reason);
    if (reason === 'dispute') {
      return { title: 'This workspace is locked', description, action: { href: SUPPORT_MAILTO, label: 'Email support', kind: 'mailto' } };
    }
    if (reason === 'foreign_workspace') {
      return { title: 'This workspace is locked', description, action: { href: '/', label: 'Switch to your own workspace', kind: 'switch_workspace' } };
    }
    return { title: 'This workspace is locked', description, action: null };
  }
  if (failure.retryCheckout) {
    // The first payment never went through, so nothing was ever collected: the
    // way out is a new checkout for the same plan, not the billing portal. Only
    // an owner can buy for the workspace.
    if (mayUpdateBilling(failure.reader)) {
      return {
        title: FIRST_PAYMENT_TITLE,
        description: FIRST_PAYMENT_OWNER_LINE,
        action: { href: retryCheckoutHref(failure.retryCheckout), label: CHECK_OUT_AGAIN_LABEL },
      };
    }
    return {
      title: FIRST_PAYMENT_TITLE,
      description: FIRST_PAYMENT_NOT_OWNER_LINE,
      action: null,
    };
  }
  if (mayUpdateBilling(failure.reader)) {
    return {
      title: 'This workspace’s subscription is inactive',
      description: 'Update billing to restore access.',
      action: { href: UPDATE_BILLING_ROUTE, label: UPDATE_BILLING_LABEL },
    };
  }
  return {
    title: 'This workspace’s subscription is inactive',
    description: 'Only a workspace owner can restore it by updating billing.',
    action: null,
  };
}

export interface LoadFailureDeps {
  /** GET /teams/workspaces. Exempt from enforcement, so it answers while the
   *  workspace is refusing everything else. */
  readListing: () => Promise<WorkspaceListingLike | null>;
  /** The browser's stored workspace choice (api.getActiveWorkspace). */
  storedChoice: () => string | null;
}

/**
 * Classify, and for a subscription refusal find out who is reading.
 *
 * The role is read from the listing for the workspace this browser is BOUND to
 * (boundWorkspaceEntry: the stored choice when the listing still offers it,
 * else the server's active workspace), which is the workspace the refused
 * request was sent to. The Team page resolves its refusal the same way. Only a
 * subscription refusal pays for the listing read: the other kinds do not
 * depend on who is reading.
 */
export async function resolveLoadFailure(error: unknown, deps: LoadFailureDeps): Promise<LoadFailure> {
  const failure = classifyLoadFailure(error);
  if (failure.kind !== 'subscription_inactive') return failure;
  let listing: WorkspaceListingLike | null = null;
  try {
    listing = await deps.readListing();
  } catch {
    listing = null;
  }
  let stored: string | null = null;
  try {
    stored = deps.storedChoice();
  } catch {
    stored = null;
  }
  const entry = boundWorkspaceEntry(listing, stored);
  return {
    ...failure,
    reader: entry ? { role: entry.role ? String(entry.role).toLowerCase() : null } : null,
  };
}
