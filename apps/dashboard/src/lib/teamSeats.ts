/**
 * SEATS: WHAT A WORKSPACE HAS, AND WHO MAY BUY ANOTHER ONE.
 *
 * There was no way in the product to add a seat. Every purchase path buys the
 * two-seat minimum, the third invitation 402s with "Upgrade to add another
 * person", and the only thing an owner could upgrade TO was the plan she was
 * already on. A team that wanted to grow had to leave the product.
 *
 * The API half is `POST /billing/checkout {tierId, seats}` from an owner of a
 * workspace with a live subscription: a same-tier request naming a higher count
 * is a SEAT CHANGE, repricing that subscription rather than opening a second
 * one. These are the questions the page has to answer before it may offer it —
 * pure, so the arithmetic and the money copy can be tested without React, a
 * network, or a Stripe account.
 */

import { TEAM_PRICE_ANNUAL, TEAM_PRICE_MONTHLY, isPerSeatPlan, money } from '@/lib/planCopy';
import { mayOfferBilling } from '@/lib/billingAccess';
import { firstPaymentSentence, isFirstPaymentIncomplete, retryCheckoutHref } from '@/lib/firstPayment';

/** The billing facts GET /teams/members reports about the bound workspace. */
export interface SeatBilling {
  plan_tier?: string | null;
  subscription_status?: string | null;
  /** A live Stripe subscription exists, so a seat change has something to reprice. */
  has_subscription?: boolean;
  /** organizations.purchased_seats: what the subscription is billed for. */
  seats_purchased?: number | null;
}

/** As much of the roster as any of this needs. */
export interface SeatRoster {
  actor_role?: string | null;
  seats: { used: number; pending: number; included?: number | null; purchased?: number | null };
  /** False on a workspace whose subscription lapsed. Absent on an older API. */
  team_management?: boolean;
  billing?: SeatBilling | null;
}

export interface SeatSummary {
  /** People plus outstanding invitations: seats actually spent. */
  spent: number;
  /** Seats the subscription is billed for, or null when there is no cap to state. */
  bought: number | null;
  full: boolean;
  /** "3 of 4 seats used" / "3 people in this workspace". */
  countLabel: string;
  /** "1 invitation outstanding", or null when there are none. */
  pendingLabel: string | null;
}

/**
 * What the seat meter says.
 *
 * `purchased` is preferred over `included` on purpose. They agree while the
 * subscription is live, and the moment it lapses `included` becomes the FREE
 * tier's single seat — so a three-person team whose card failed would read "3
 * of 1 seats used", which describes a plan they have stopped paying for rather
 * than the team they still have. A lapsed workspace states the headcount and
 * leaves the explaining to the inactive banner.
 */
export function seatSummary(roster: SeatRoster): SeatSummary {
  const used = Number(roster.seats?.used) || 0;
  const pending = Number(roster.seats?.pending) || 0;
  const spent = used + pending;
  const purchased = numberOrNull(roster.seats?.purchased);
  const included = numberOrNull(roster.seats?.included);
  const bought = subscriptionInactive(roster) ? purchased : (purchased ?? included);

  return {
    spent,
    bought,
    full: bought !== null && spent >= bought,
    countLabel: bought === null
      ? `${spent} ${spent === 1 ? 'person' : 'people'} in this workspace`
      : `${spent} of ${bought} seats used`,
    pendingLabel: pending > 0
      ? `${pending} ${pending === 1 ? 'invitation' : 'invitations'} outstanding`
      : null,
  };
}

/** The workspace is on a paid team plan it has stopped paying for. */
export function subscriptionInactive(roster: SeatRoster): boolean {
  return roster.team_management === false;
}

/**
 * May THIS person add a seat from THIS page?
 *
 * Four things have to hold, and each of them is a different refusal the server
 * would otherwise deliver after the click: spending money on a workspace is an
 * owner's power; the plan has to be one that is priced per seat; there has to be
 * a live subscription to reprice (buying Team from scratch is an ordinary
 * checkout with its own seat picker); and a workspace whose subscription lapsed
 * fixes the bill before it grows.
 */
export function canAddSeat(roster: SeatRoster): boolean {
  return mayOfferBilling({ role: roster.actor_role })
    && !subscriptionInactive(roster)
    && isPerSeatPlan(roster.billing?.plan_tier)
    && roster.billing?.has_subscription === true;
}

export interface SeatChangeRequest {
  tierId: string;
  /** The new total. The endpoint takes a COUNT, never a delta. */
  seats: number;
}

/**
 * One more seat than the workspace has.
 *
 * Counted from what was BOUGHT, falling back to what is spent: a workspace over
 * its own cap (possible, because the cap is only ever checked when somebody is
 * added) must ask for a number that actually leaves room, or the click buys a
 * seat and the invitation still refuses.
 *
 * `extra` exists for a typed number. One click is one seat, always; nothing
 * here reads a URL parameter and nothing fires on load.
 */
export function addSeatRequest(roster: SeatRoster, extra = 1): SeatChangeRequest | null {
  if (!canAddSeat(roster)) return null;
  const tierId = roster.billing?.plan_tier;
  if (!tierId) return null;
  const summary = seatSummary(roster);
  const from = Math.max(summary.bought ?? 0, summary.spent);
  const seats = from + Math.max(1, Math.floor(extra));
  return { tierId, seats };
}

/** "$15 per seat each month, or $150 per seat each year on annual billing". */
export function perSeatPriceLine(): string {
  return `${money(TEAM_PRICE_MONTHLY)} per seat each month, or ${money(TEAM_PRICE_ANNUAL)} per seat each year on annual billing`;
}

/**
 * What the owner is agreeing to, stated before anything is charged.
 *
 * Names the new total rather than the delta, names the price, and says when the
 * money actually moves. That last sentence is not decoration: the seat change
 * keeps the subscription's existing billing period, so Stripe puts the prorated
 * difference on the NEXT invoice. Telling somebody they are being charged now
 * and then showing them no charge is the same class of wrong as the reverse.
 */
export function addSeatConfirmation(request: SeatChangeRequest, roster: SeatRoster): string {
  const summary = seatSummary(roster);
  const from = summary.bought;
  return [
    `Add a seat to this workspace?`,
    '',
    from === null
      ? `This workspace will be billed for ${request.seats} seats.`
      : `This workspace goes from ${from} ${from === 1 ? 'seat' : 'seats'} to ${request.seats} seats.`,
    `Team is ${perSeatPriceLine()}.`,
    'The prorated difference is added to your next invoice on the card on file. Nothing else about the plan changes.',
  ].join('\n');
}

/**
 * WHAT THE SEAT PURCHASE ACTUALLY DID.
 *
 * POST /billing/checkout has three answers and the page read exactly one of
 * them. `{updated: true}` is the seat change: the live subscription was
 * repriced. `{url, portal: true}` means it could NOT be changed automatically
 * and a human finishes it in the billing portal. `{url}` alone means there is no
 * live subscription to reprice and Stripe Checkout is where this starts.
 *
 * All three were shown as a green "This workspace now has N seats.", the URL was
 * never opened, and the invitation that had been refused for want of the seat
 * was then re-sent into the same cap and 402'd again. Nothing had been bought,
 * and the only thing on screen said otherwise.
 */
export interface SeatPurchaseResult {
  updated?: boolean;
  url?: string | null;
  portal?: boolean;
  seats?: number | null;
  message?: string | null;
}

export type SeatPurchaseOutcome =
  /** Bought. The only branch that may refresh the roster and send the invite. */
  | { kind: 'bought'; seats: number | null; message: string | null }
  /** Not bought yet: there is somewhere to go and finish it. */
  | { kind: 'finish_elsewhere'; url: string; portal: boolean; message: string | null }
  /** Not bought, and nowhere to go. */
  | { kind: 'not_bought'; message: string | null };

export function seatPurchaseOutcome(result: SeatPurchaseResult | null | undefined): SeatPurchaseOutcome {
  const message = typeof result?.message === 'string' && result.message ? result.message : null;
  if (result?.updated === true) {
    return { kind: 'bought', seats: numberOrNull(result.seats), message };
  }
  if (typeof result?.url === 'string' && result.url) {
    return { kind: 'finish_elsewhere', url: result.url, portal: result.portal === true, message };
  }
  return { kind: 'not_bought', message };
}

/** What somebody who cannot buy a seat is told instead. */
export const ASK_AN_OWNER_LINE = 'Ask a workspace owner to add a seat.';

/** The banner a lapsed team's owner gets in place of an error or an upsell. */
export const SUBSCRIPTION_INACTIVE_LINE =
  'This workspace’s subscription is inactive. You can remove members or update billing.';

/** What anybody else reading a lapsed team's roster is told: who can act
 *  (the words lib/loadFailure refusalCopy uses for the same state). */
export const SUBSCRIPTION_INACTIVE_NOT_OWNER_LINE =
  'This workspace’s subscription is inactive. Only a workspace owner can restore it by updating billing.';

/**
 * The lapsed-team panel on /settings/team: its sentence, and whether it offers
 * "Update billing". It offered the link to whoever could read the roster; it
 * now follows the one rule every page follows (lib/billingAccess).
 */
export function inactiveTeamNotice(roster: SeatRoster): { line: string; billingLink: boolean; checkoutAgainHref?: string } {
  const owner = mayOfferBilling({ role: roster.actor_role });
  // A first payment that never went through is not a bill to update: the owner
  // checks out again for the same plan (lib/firstPayment).
  if (isFirstPaymentIncomplete(roster.billing?.subscription_status)) {
    const plan = roster.billing?.plan_tier;
    return {
      line: firstPaymentSentence(owner),
      billingLink: false,
      ...(owner && plan
        ? { checkoutAgainHref: retryCheckoutHref({ plan, seats: numberOrNull(roster.billing?.seats_purchased) }) }
        : {}),
    };
  }
  return owner
    ? { line: SUBSCRIPTION_INACTIVE_LINE, billingLink: true }
    : { line: SUBSCRIPTION_INACTIVE_NOT_OWNER_LINE, billingLink: false };
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
