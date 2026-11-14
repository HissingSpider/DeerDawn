/**
 * What an invitation attempt means for the person who sent it.
 *
 * Pure so the copy can be tested without React or a network.
 */

import { ASK_AN_OWNER_LINE } from '@/lib/teamSeats';
import { lockReasonOf, lockSentence } from '@/lib/lockCopy';
import { CHECK_OUT_AGAIN_LABEL, firstPaymentSentence, retryCheckoutHref, type RetryCheckout } from '@/lib/firstPayment';
import { mayOfferBilling } from '@/lib/billingAccess';

/**
 * Did the invitation email actually go out?
 *
 * Only an explicit `true` counts. The API used to return 201 whether or not the
 * email left (it had no working sender in production), and the dashboard said
 * "Invitation sent" regardless, so invitees were never told. A server that
 * predates `email_sent` answers undefined, and undefined is not a yes: the link
 * is shown so the owner can send it themselves.
 */
export function inviteWasEmailed(result: { email_sent?: boolean } | null | undefined): boolean {
  return result?.email_sent === true;
}

/**
 * What the reader may do about a 402, which is not the same question as why it
 * happened.
 *
 * A workspace ALREADY on the per-seat plan cannot upgrade its way out of a full
 * workspace: it has the plan, it needs a seat. Telling its owner to "Upgrade"
 * pointed her at a plan picker whose only entry was the plan she was paying
 * for, which is how "there is no way to add a seat" looked from inside the
 * product.
 */
export interface InviteRefusalContext {
  /** This viewer may buy the seat from here (teamSeats.canAddSeat). */
  canAddSeat?: boolean;
  /** The workspace is on the per-seat plan, whoever is looking at it. */
  onPerSeatPlan?: boolean;
}

/**
 * Why a single invite was refused, in words the owner can act on.
 *
 * 403 is the plan: a workspace without `team_management` refuses every invite.
 * The new-team wizard creates exactly such a workspace for a Free or Pro
 * creator, and mapped only 402, so the refusal read as "Not invited: a@b.com"
 * with no hint that the workspace itself was the problem.
 */
export function inviteRefusalMessage(
  status: number | undefined,
  context: InviteRefusalContext = {},
): string {
  if (status === 402) {
    if (context.canAddSeat) return 'All seats are taken. Add a seat to invite another person.';
    if (context.onPerSeatPlan) return `All seats are taken. ${ASK_AN_OWNER_LINE}`;
    return 'All seats are taken. Upgrade to add another person.';
  }
  if (status === 403) return 'Inviting people needs the Team plan. Upgrade this workspace to invite your team.';
  if (status === 409) return 'That person is already in this workspace.';
  return 'Could not send that invitation.';
}

/** The wizard's per-address label for a failed invite. */
export function inviteFailureLabel(email: string, status: number | undefined): string {
  if (status === 402) return `${email} (no seats left)`;
  if (status === 403) return `${email} (needs the Team plan)`;
  if (status === 409) return `${email} (already a member)`;
  return email;
}

/**
 * Why the wizard could not list the projects you might move in.
 *
 * Step 2 called GET /teams/projects-sharing and, on ANY failure, rendered "You
 * have no projects to move yet. That is fine — start fresh." That listing sits
 * behind ensureTeamAccess, which requires `team_management` on the BOUND
 * workspace — and at that point in the wizard the bound workspace is still the
 * creator's own, which is exactly the Free or Pro account they are creating a
 * team from. So the 403 was the normal case, and the wizard told every one of
 * them they owned no projects. An empty list and a refused list are different
 * facts, and one of them is a lie about their own account.
 */
export function projectListRefusalMessage(status: number | undefined): string {
  if (status === 403 || status === 402) {
    return 'We could not list your projects here: this workspace does not have the Team plan, and the listing needs it. '
      + 'Create the team, then move projects in from Team settings.';
  }
  if (status === 401) return 'Your session expired, so we could not list your projects. Sign in again.';
  return 'We could not load your projects just now, so this step cannot show them. '
    + 'Create the team, then move projects in from Team settings.';
}

/** What the Team page says when the roster itself is refused. */
export interface TeamLoadRefusal {
  message: string;
  /** Offer the plan page, and with which label; null when this reader cannot
   *  act on it (an owner has to) or when the failure is not about the plan. */
  planLink: { label: string; href?: string } | null;
}

/**
 * WHY THE ROSTER WAS REFUSED, AND WHO CAN FIX IT.
 *
 * Every 403 used to read "Shared workspaces are on the Team plan. Upgrade to
 * invite people." beside a lone "Try again" button: no way to the plan the
 * sentence named, and the same advice for a member of a team whose owner's card
 * lapsed, who cannot upgrade anything. `role`/`personal` describe the workspace
 * the request was BOUND to (see boundWorkspaceEntry); both may be unknown when
 * the listing could not be read.
 *
 * AN UNKNOWN ROLE IS NOT AN OWNER. It was treated as one, so the plan link was
 * offered whenever the listing could not be read. The link now follows the one
 * rule every page follows (lib/billingAccess): only a person the listing names
 * as an owner is offered it. Anybody else is told who can act, in the words the
 * other refused pages use (lib/loadFailure refusalCopy).
 */
export function teamLoadRefusal(input: {
  status?: number;
  reason?: string;
  role?: string | null;
  personal?: boolean | null;
  /** The server's `lock_reason` on a lockdown_active refusal (lib/lockCopy). */
  lockReason?: string | null;
  /** The server's `retry_checkout` on a subscription_inactive refusal: the first
   *  payment never went through, and this is what to check out again. */
  retryCheckout?: RetryCheckout | null;
}): TeamLoadRefusal {
  if (input.status !== 403) {
    return { message: 'Could not load your team. Try again in a moment.', planLink: null };
  }
  if (input.reason === 'lockdown_active') {
    // The sentence for THIS lock: a dispute, an owner's lockdown, or somebody
    // else's locked workspace. None is fixed by billing.
    return { message: lockSentence(lockReasonOf(input.lockReason)), planLink: null };
  }
  if (input.reason === 'subscription_inactive' && input.retryCheckout) {
    // Not a bill to update: the first payment never went through, and the owner
    // checks out again (lib/firstPayment).
    const mayCheckOut = mayOfferBilling({ role: input.role });
    return {
      message: firstPaymentSentence(mayCheckOut),
      planLink: mayCheckOut ? { label: CHECK_OUT_AGAIN_LABEL, href: retryCheckoutHref(input.retryCheckout) } : null,
    };
  }
  const lapsed = input.reason === 'subscription_inactive' || input.reason === 'past_due';
  const role = String(input.role || '').toLowerCase();
  const nonOwnerOfATeam = input.personal !== true && (role === 'member' || role === 'viewer');
  const owner = mayOfferBilling({ role: input.role });
  if (nonOwnerOfATeam) {
    return {
      message: lapsed
        ? 'This team’s subscription has lapsed, so its roster is unavailable. Only a workspace owner can restore it by updating billing.'
        : 'This team’s plan does not include shared workspaces right now, which usually means its subscription lapsed. Only a workspace owner can fix that.',
      planLink: null,
    };
  }
  if (lapsed) {
    return owner
      ? { message: 'This workspace’s subscription is inactive. Update billing to invite people.', planLink: { label: 'Update billing' } }
      : { message: 'This workspace’s subscription is inactive. Only a workspace owner can restore it by updating billing.', planLink: null };
  }
  return {
    message: 'Shared workspaces are on the Team plan. Upgrade to invite people.',
    planLink: owner ? { label: 'See plans' } : null,
  };
}
