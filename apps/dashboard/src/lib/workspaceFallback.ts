/**
 * WHICH WORKSPACE IS ACTUALLY ANSWERING?
 *
 * A team whose subscription lapses does not disappear. The API keeps serving its
 * members, but it serves them their OWN workspace: a header-less read falls back
 * to personal and says so in `x-deerdawn-workspace-fallback`, and a header-less
 * write is refused outright with 409 `workspace_inactive`.
 *
 * The dashboard could not see any of that. It asked GET /teams/workspaces which
 * workspace was `active` — the STORED CHOICE, which is still the team — and put
 * that name in the switcher, while every other request on the page was being
 * answered by the person's personal workspace. So the shell said "Acme" and the
 * projects, board and memory underneath it were the reader's own. A teammate
 * whose browser has NO stored choice hits this by default: every request they
 * make is header-less, so it is bound to the server-side active workspace, which
 * is the team. (Accepting an invitation in the dashboard does store the joined
 * workspace in localStorage as well; a tab that joined elsewhere, a cleared
 * browser, or a switch to "personal" leaves no stored choice.)
 *
 * `active` is the choice. This module answers the different question: what is
 * SERVING. Both signals are optional on purpose — the response header may be
 * hidden by CORS on an older deployment, and `fallback` is absent on an API that
 * predates it — so every read here tolerates the field being missing and the
 * answer degrades to "no fallback", which is what the dashboard did before.
 */
import { mayOfferBilling } from './billingAccess';
import { parseRetryCheckout, type RetryCheckout } from './firstPayment';

/** The `fallback` object GET /teams/workspaces carries. Every field is optional
 *  because an older API carries none of it. */
export interface WorkspaceFallbackResponse {
  from?: string | null;
  from_name?: string | null;
  to?: string | null;
  reason?: string | null;
  /** The first payment never went through: what to check out again. */
  retry_checkout?: { plan?: string; seats?: number | null } | null;
}

/** As much of a workspace row as any decision here needs. */
export interface WorkspaceEntryLike {
  workspace: string;
  name?: string | null;
  role?: string | null;
  personal?: boolean;
}

/** The GET /teams/workspaces payload, or as much of it as reached us. */
export interface WorkspaceListingLike {
  active?: string | null;
  workspaces?: WorkspaceEntryLike[];
  fallback?: WorkspaceFallbackResponse | null;
}

export interface WorkspaceFallbackSignal {
  /** The workspace the person CHOSE, and which is not answering. */
  from: string;
  /** Its name, when the server or the listing knows one. */
  fromName: string | null;
  /** The workspace answering instead: the person's own. Null when unknown. */
  to: string | null;
  /** Why. Only `subscription_inactive` exists today; it is carried rather than
   *  assumed so a second reason does not silently render as the first. */
  reason: string;
  /** Set when the workspace is locked because its FIRST payment never went
   *  through: what to check out again. Its owner checks out again; it is not a
   *  bill to update (lib/firstPayment). */
  retryCheckout?: RetryCheckout;
}

/**
 * WHICH WORKSPACE IS THIS BROWSER ACTUALLY BOUND TO?
 *
 * GET /teams/workspaces is fetched WITHOUT the stored workspace header (it is
 * the exit from a stale one), so its `active` is the SERVER's choice: the one
 * agent sessions and header-less requests use. Every other request from this
 * browser carries the stored choice instead, and that is what POST /keys mints
 * into and what POST /billing/checkout charges. The two differ whenever the
 * person switched on another device, or the server half of a switch failed.
 *
 * Pages named `active` while acting on the stored choice: the key panel said
 * "Keys you create here belong to <you>" and minted the key into the team.
 *
 * `stored` is the browser's saved choice (getActiveWorkspace()). It wins when
 * the listing still offers it; a choice the person may no longer enter is not
 * a binding (the client drops it on the first 403), so `active` answers then.
 */
export function boundWorkspace(
  listing: WorkspaceListingLike | null | undefined,
  stored?: string | null,
): string | null {
  const entries = Array.isArray(listing?.workspaces) ? listing!.workspaces! : [];
  if (typeof stored === 'string' && stored && entries.some((entry) => entry && entry.workspace === stored)) {
    return stored;
  }
  return typeof listing?.active === 'string' && listing.active ? listing.active : null;
}

/** The listing row for the bound workspace, or null when there is none. */
export function boundWorkspaceEntry<T extends WorkspaceEntryLike>(
  listing: { active?: string | null; workspaces?: T[] } | null | undefined,
  stored?: string | null,
): T | null {
  const bound = boundWorkspace(listing, stored);
  const entries = Array.isArray(listing?.workspaces) ? listing!.workspaces! : [];
  return entries.find((entry) => entry && entry.workspace === bound) || null;
}

export interface ServedWorkspace {
  /** The workspace key actually serving this person's reads. */
  served: string | null;
  /** The stored choice. Still meaningful: it is what they picked and what the
   *  switcher has to be able to point back at once the bill is fixed. */
  stored: string | null;
  /** Null when the two agree, which is the overwhelmingly common case. */
  fallback: WorkspaceFallbackSignal | null;
}

/**
 * Reconcile the stored choice with the two fallback signals.
 *
 * `fallbackHeader` is the key from `x-deerdawn-workspace-fallback` on any
 * response, or null when nothing has reported one (including when CORS hid it,
 * which is why its absence proves nothing and the listing's own `fallback` field
 * is checked first, except when the stored choice binds this browser somewhere
 * other than the listing's `active`: then the listing is not about this
 * browser's requests and the header decides).
 *
 * `storedChoice` is the browser's saved workspace; see boundWorkspace.
 */
export function servedWorkspace(
  listing: WorkspaceListingLike | null | undefined,
  fallbackHeader?: string | null,
  storedChoice?: string | null,
): ServedWorkspace {
  const entries = Array.isArray(listing?.workspaces) ? listing!.workspaces! : [];
  const stored = boundWorkspace(listing, storedChoice);
  const personal = entries.find((entry) => entry && entry.personal)?.workspace || null;

  const reported = listing?.fallback && typeof listing.fallback === 'object' ? listing.fallback : null;
  const reportedFrom = typeof reported?.from === 'string' && reported.from ? reported.from : null;

  // THE LISTING SPEAKS FOR HEADER-LESS REQUESTS, AND THIS BROWSER SENDS A HEADER.
  //
  // The listing is fetched without the stored workspace header, so its
  // `fallback` (null or not) is computed for the SERVER's active workspace. A
  // browser whose stored choice binds it somewhere else sends that choice on
  // every other request, and since header-bound reads fall back too, the only
  // report about ITS requests is the response header those reads carried.
  //
  // Trusting the listing's explicit null here was the defect: the member
  // switched to personal on the laptop, this browser still stores the lapsed
  // team, every read came back from their own workspace with the header naming
  // the team, and the listing said `fallback: null` about the laptop's binding.
  // The shell said "Acme", the data was personal, and there was no banner until
  // a write was refused naming the team.
  //
  // So under an override the listing counts only when it names the stored
  // choice itself; otherwise the recorded header decides, and with no header
  // there is nothing to report.
  const overrides = choiceOverridesActive(listing, storedChoice);
  const applicable = !overrides || reportedFrom === stored ? reported : null;
  const applicableFrom = applicable ? reportedFrom : null;

  // AN EXPLICIT `fallback: null` IS AN ANSWER, NOT A SILENCE (for the binding it
  // was computed for).
  //
  // The bill gets paid. GET /teams/workspaces recomputes the fallback for THIS
  // read and answers null; the response header recorded earlier in the tab
  // still names the team, is never cleared on absence (deliberately — most
  // routes do not report one), and so outlived the thing it described. The
  // banner went on saying the team was not serving anyone while writes were
  // landing in it again, until a full reload.
  //
  // Only a listing that CARRIES the field can say this. An older API omits it
  // entirely, and reading its silence as "no fallback" would throw away the one
  // signal it does have.
  if (!overrides && !applicableFrom && listingReportsNoFallback(listing)) {
    return { served: stored, stored, fallback: null };
  }

  const header = typeof fallbackHeader === 'string' && fallbackHeader ? fallbackHeader : null;
  const from = applicableFrom || header;
  if (!from) return { served: stored, stored, fallback: null };

  // A header is a fact about one request that has already happened. If the
  // stored choice has moved on since (they switched, or they were served the
  // team again after paying), that header describes a workspace nobody is
  // pointed at any more and must not put a banner on the page. The listing's own
  // `fallback` field has no such staleness: it is computed for this read.
  if (!applicableFrom && stored && from !== stored) return { served: stored, stored, fallback: null };

  const named = entries.find((entry) => entry && entry.workspace === from) || null;
  const to = (typeof applicable?.to === 'string' && applicable.to ? applicable.to : null) || personal;

  return {
    served: to,
    stored,
    fallback: {
      from,
      fromName: (applicable?.from_name || named?.name || null) || null,
      to,
      reason: applicable?.reason || 'subscription_inactive',
      ...(parseRetryCheckout(applicable?.retry_checkout) ? { retryCheckout: parseRetryCheckout(applicable?.retry_checkout)! } : {}),
    },
  };
}

/**
 * Does this browser's stored choice bind it somewhere other than the listing's
 * `active`? When it does, the listing's `fallback` describes requests this
 * browser does not make (see servedWorkspace).
 */
export function choiceOverridesActive(
  listing: WorkspaceListingLike | null | undefined,
  storedChoice?: string | null,
): boolean {
  const bound = boundWorkspace(listing, storedChoice);
  return Boolean(bound) && bound !== (listing?.active || null);
}

/**
 * May a fresh listing clear the fallback key recorded from response headers?
 *
 * Only when its explicit `fallback: null` was computed for the binding this
 * browser actually uses. Under an override it was computed for somebody else's
 * requests, and clearing on it erased the one report about this browser's own.
 */
export function listingEndsRecordedFallback(
  listing: WorkspaceListingLike | null | undefined,
  storedChoice?: string | null,
): boolean {
  return listingReportsNoFallback(listing) && !choiceOverridesActive(listing, storedChoice);
}

/**
 * Did a header-bound read prove the workspace it named is serving again?
 *
 * Under an override the listing cannot say the fallback has ended (it speaks
 * for the other binding), so the evidence has to come from this browser's own
 * reads. Absence of the header is only evidence on a route that WOULD have
 * carried it: a GET under /api/v1/context, which plan enforcement gates and the
 * fallback rebinds. Export is exempt from enforcement and is left out; so is
 * everything outside /context (billing, keys, teams, auth), where the header is
 * never sent whatever the workspace's state.
 */
export function readProvesWorkspaceServing(
  endpoint: string,
  method: string | undefined,
  status: number,
  sentWorkspace: string | null | undefined,
  recordedKey: string | null | undefined,
): boolean {
  if (!recordedKey || !sentWorkspace || sentWorkspace !== recordedKey) return false;
  if ((method || 'GET').toUpperCase() !== 'GET') return false;
  if (status < 200 || status >= 300) return false;
  const path = endpoint.split(/[?#]/)[0];
  if (!path.startsWith('/api/v1/context/')) return false;
  return !/^\/api\/v1\/context\/export\/?$/.test(path);
}

/**
 * Does this listing SAY there is no fallback, as opposed to not mentioning one?
 *
 * The distinction is the whole fix for the banner that would not go away: an
 * explicit null is computed for this read and outranks anything recorded
 * earlier, while a missing field is an older API that cannot answer at all.
 */
export function listingReportsNoFallback(listing: WorkspaceListingLike | null | undefined): boolean {
  if (!listing || typeof listing !== 'object') return false;
  if (!('fallback' in listing)) return false;
  const reported = listing.fallback;
  if (!reported || typeof reported !== 'object') return true;
  return !(typeof reported.from === 'string' && reported.from);
}

/**
 * The lapsed workspace's REAL name, or null when it has none.
 *
 * GET /teams/workspaces sends `from_name: names.get(key) || 'Workspace'`, so an
 * org row with no name arrives as the literal word "Workspace" and rendered
 * "Workspace’s subscription is inactive." That is a placeholder wearing a name's
 * clothes, and every surface that prints a name has to see through it.
 */
export function fallbackWorkspaceName(fallback: WorkspaceFallbackSignal): string | null {
  const raw = (fallback.fromName || '').trim();
  if (!raw || raw.toLowerCase() === 'workspace') return null;
  return raw;
}

/**
 * WHY it is not answering, in one sentence.
 *
 * enforcementService answers three refusals down this path — `lockdown_active`,
 * `subscription_inactive` and `decision_limit_exceeded` — and the banner
 * described all of them as a lapsed subscription, which sends a locked
 * workspace's owner to a billing page that cannot unlock it. An unknown reason
 * says the only thing true of every one of them rather than guessing.
 */
export function fallbackReasonSentence(fallback: WorkspaceFallbackSignal): string {
  const subject = fallbackWorkspaceLabel(fallback);
  switch (fallback.reason) {
    case 'subscription_inactive':
      if (fallback.retryCheckout) return `${subject}’s first payment did not go through.`;
      return `${subject}’s subscription is inactive.`;
    case 'lockdown_active':
      return `${subject} is locked.`;
    case 'decision_limit_exceeded':
      return `${subject} has reached its plan limit.`;
    default:
      return `${subject} is not available right now.`;
  }
}

/** The same reason as a parenthetical, for a row in the workspace switcher. */
export function fallbackShortReason(fallback: WorkspaceFallbackSignal): string {
  switch (fallback.reason) {
    case 'subscription_inactive': return fallback.retryCheckout ? 'first payment failed' : 'subscription inactive';
    case 'lockdown_active': return 'locked';
    case 'decision_limit_exceeded': return 'plan limit reached';
    default: return 'not available';
  }
}

/**
 * What the banner says: why the workspace is not answering, which half of this
 * page is therefore somebody else's, and which half is still the team's.
 *
 * THE OLD SENTENCE WAS HALF TRUE, AND THE WRONG HALF WAS THE ACTIONABLE ONE.
 * "You are viewing your own workspace. Nothing you do here goes to <Team>" is
 * right about projects, briefs, the board and context, and wrong about every
 * route enforcePlan exempts: /api/v1/keys, /api/v1/billing, /api/v1/orgs,
 * /api/v1/auth and the rest are never rebound by the fallback, so they still act
 * on the team. A reader who believed the banner minted a key they were told was
 * their own into a workspace they cannot write to.
 */
export function workspaceFallbackNotice(fallback: WorkspaceFallbackSignal): string {
  const object = fallbackWorkspaceName(fallback) || 'it';
  return `${fallbackReasonSentence(fallback)} Projects and briefs shown here are from your own workspace.`
    + ` Billing, keys and team settings still refer to ${object}.`;
}

/**
 * How to name the lapsed workspace at the START of a sentence. "Your team
 * workspace" rather than "That workspace": the reader has exactly one lapsed
 * workspace in play and the phrase has to work as a possessive.
 */
export function fallbackWorkspaceLabel(fallback: WorkspaceFallbackSignal): string {
  return fallbackWorkspaceName(fallback) || 'Your team workspace';
}

/** The workspace a credential minted RIGHT NOW would belong to. */
export interface CredentialWorkspace {
  /** Its key, or null when the listing did not answer. */
  workspace: string | null;
  /** Its name, or null when it has none (the API's "Workspace" placeholder). */
  name: string | null;
  /** True when it is this person's own. */
  personal: boolean;
  /** This reader's role in it, lowercased, or null when the listing omits it. */
  role: string | null;
  /**
   * Set when the workspace the credential would belong to is the very one that
   * is not answering ordinary reads. The key is still minted against it, and it
   * will not work until that workspace is available again.
   */
  inactive: WorkspaceFallbackSignal | null;
}

/**
 * WHICH WORKSPACE WOULD OWN A KEY CREATED HERE?
 *
 * A DIFFERENT QUESTION FROM `servedWorkspace`, and the key panel asked the wrong
 * one. Minting goes through POST /api/v1/keys, which enforcePlan exempts by
 * prefix — credential management is a containment action and must survive a
 * lapsed card — and an exempt request is never rebound by the fallback. So while
 * projects and briefs are answered out of the reader's personal workspace, the
 * key is minted against the lapsed TEAM: `defaultOwnerKey(actor)` is still
 * `actor.workspace_key`, which is what `active` reports.
 *
 * The panel said "Keys you create here belong to <you>, your own workspace."
 * The key was the team's, dead with 403 subscription_inactive until somebody
 * paid, and live in the team afterwards, where new projects default to `shared`.
 * That is the opposite of the promise, in the one place on the dashboard that
 * hands out a long-lived credential.
 *
 * So: the BOUND workspace (see boundWorkspace: the browser's stored choice when
 * it has one, else `active`), never the served one. The fallback is
 * carried through as `inactive` so the panel can say what minting now would
 * actually produce, and it is only set when the fallback names the workspace
 * the key would belong to.
 */
export function credentialWorkspace(
  listing: WorkspaceListingLike | null | undefined,
  fallbackHeader?: string | null,
  storedChoice?: string | null,
): CredentialWorkspace {
  const bound = boundWorkspace(listing, storedChoice);
  const row = boundWorkspaceEntry(listing, storedChoice);
  const rawName = (row?.name || '').trim();
  const { fallback } = servedWorkspace(listing, fallbackHeader, storedChoice);
  return {
    workspace: bound,
    name: !rawName || rawName.toLowerCase() === 'workspace' ? null : rawName,
    personal: Boolean(row?.personal),
    role: row?.role ? String(row.role).toLowerCase() : null,
    inactive: fallback && bound && fallback.from === bound ? fallback : null,
  };
}

/** What minting into a workspace that is not answering would actually produce. */
export function credentialWorkspaceWarning(inactive: WorkspaceFallbackSignal): string {
  const object = fallbackWorkspaceName(inactive) || 'it';
  if (inactive.reason === 'subscription_inactive' && !inactive.retryCheckout) {
    return `${fallbackWorkspaceLabel(inactive)}’s subscription is inactive, so a key created now would belong to`
      + ` ${object} and will not work until it is active again.`;
  }
  return `${fallbackReasonSentence(inactive)} A key created now would belong to ${object}`
    + ` and will not work until ${object} is available again.`;
}

/**
 * Is this reader the one who can fix the bill?
 *
 * Only an owner may touch a workspace's billing, so only an owner is offered the
 * link to it. A member sent to a billing page they cannot use learns nothing and
 * has one more dead end to report.
 */
export function mayFixFallbackBilling(
  listing: WorkspaceListingLike | null | undefined,
  fallback: WorkspaceFallbackSignal,
): boolean {
  const entries = Array.isArray(listing?.workspaces) ? listing!.workspaces! : [];
  const named = entries.find((entry) => entry && entry.workspace === fallback.from);
  // The one rule every page follows (lib/billingAccess).
  return mayOfferBilling({ role: named?.role });
}

/**
 * THE REFUSED WRITE.
 *
 * Duck-typed rather than checking `instanceof ApiError`, so this module imports
 * nothing at runtime and stays testable without the API client — and so a
 * refusal that arrives through any other wrapper is still recognised.
 *
 * 409 is deliberate on the server's part: it is not "you may not", it is "not
 * here, not now". Nothing was written, so there is nothing to roll back and
 * nothing to retry; a retry sends the identical request to the identical
 * workspace and is refused identically.
 */
export function isWorkspaceInactiveError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: unknown; code?: unknown; data?: { error?: unknown } | null };
  if (Number(candidate.status) !== 409) return false;
  const reason = typeof candidate.code === 'string' && candidate.code
    ? candidate.code
    : candidate.data && typeof candidate.data === 'object'
      ? candidate.data.error
      : undefined;
  return reason === 'workspace_inactive';
}

/**
 * The sentence to show for a refused write, or null when the error is something
 * else entirely (so callers keep their own wording for a genuine save failure).
 *
 * The server's own message is preferred: it names the workspace and the bill,
 * which is the only actionable part. The fallback text still has to promise the
 * one thing the caller cannot otherwise know — nothing was saved, anywhere.
 *
 * THE PREFIX IS ITS OWN SENTENCE. It used to be "Not saved: " with the server's
 * first letter lowercased to read on from the colon, which quietly renamed the
 * workspace: "Not saved: acme Robotics’s subscription is inactive." Server text
 * is data, and recasing data is how a proper noun becomes a typo.
 */
export function workspaceInactiveMessage(error: unknown): string | null {
  if (!isWorkspaceInactiveError(error)) return null;
  const candidate = error as { message?: unknown; data?: { message?: unknown } | null };
  const fromServer = candidate.data && typeof candidate.data === 'object' && typeof candidate.data.message === 'string'
    ? candidate.data.message
    : typeof candidate.message === 'string'
      ? candidate.message
      : '';
  const cleaned = fromServer.replace(/^workspace_inactive:?\s*/i, '').trim();
  if (cleaned && cleaned !== 'workspace_inactive') return `Not saved. ${cleaned}`;
  return 'Not saved. That workspace’s subscription is inactive, so nothing was written to it.';
}
