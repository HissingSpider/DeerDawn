/**
 * The seat control, before it is wired to money.
 *
 * Every one of these is a click that either spends nothing it should not, or
 * refuses somebody the product currently has no answer for:
 *
 *  - a full workspace had no way to buy a third seat, and the invitation that
 *    would fill it 402'd with "Upgrade" aimed at a plan its owner already had;
 *  - a lapsed team's roster reported the FREE tier's one seat as its cap, so
 *    three people read as "3 of 1 seats used";
 *  - a member or viewer must not be shown a control that spends the
 *    workspace's money, and neither must an owner with no subscription to
 *    reprice.
 *
 * Run: `tsx --test src/lib/teamSeats.test.ts` (covered by `npm test`).
 */
import test from 'node:test';
import assert from 'node:assert';

import { TEAM_PRICE_ANNUAL, TEAM_PRICE_MONTHLY } from './planCopy';
import {
  addSeatConfirmation,
  addSeatRequest,
  canAddSeat,
  seatPurchaseOutcome,
  seatSummary,
  subscriptionInactive,
  type SeatRoster,
} from './teamSeats';

/** A live two-seat Team with both seats spent, as GET /teams/members reports it. */
function fullTeam(overrides: Partial<SeatRoster> = {}): SeatRoster {
  return {
    actor_role: 'owner',
    seats: { used: 1, pending: 1, included: 2, purchased: 2 },
    team_management: true,
    billing: {
      plan_tier: 'developer_pro',
      subscription_status: 'active',
      has_subscription: true,
      seats_purchased: 2,
    },
    ...overrides,
  };
}

// ── What the meter says ─────────────────────────────────────────────────────

test('an outstanding invitation is a seat spent', () => {
  const summary = seatSummary(fullTeam());
  assert.strictEqual(summary.spent, 2);
  assert.strictEqual(summary.bought, 2);
  assert.strictEqual(summary.full, true);
  assert.strictEqual(summary.countLabel, '2 of 2 seats used');
  assert.strictEqual(summary.pendingLabel, '1 invitation outstanding');
});

test('a lapsed team is not described with the free tier\'s one seat', () => {
  // THE BUG this guards: entitlements drop to free the moment a card fails, so
  // `included` becomes 1 and a three-person team read "3 of 1 seats used" —
  // a plan they stopped paying for, described as the team they still have.
  const lapsed = fullTeam({
    seats: { used: 3, pending: 0, included: 1, purchased: null },
    team_management: false,
    billing: { plan_tier: 'developer_pro', subscription_status: 'past_due', has_subscription: true, seats_purchased: null },
  });
  const summary = seatSummary(lapsed);
  assert.strictEqual(summary.bought, null);
  assert.strictEqual(summary.countLabel, '3 people in this workspace');
  assert.strictEqual(summary.full, false, 'a cap nobody is paying for is not a cap to enforce in copy');
  assert.strictEqual(subscriptionInactive(lapsed), true);
});

test('a workspace with room says so', () => {
  const summary = seatSummary(fullTeam({ seats: { used: 2, pending: 0, included: 5, purchased: 5 } }));
  assert.strictEqual(summary.countLabel, '2 of 5 seats used');
  assert.strictEqual(summary.full, false);
  assert.strictEqual(summary.pendingLabel, null);
});

test('an older API that reports no purchased count still states the cap it knows', () => {
  const summary = seatSummary({ actor_role: 'owner', seats: { used: 2, pending: 0, included: 5 } });
  assert.strictEqual(summary.bought, 5);
  assert.strictEqual(summary.countLabel, '2 of 5 seats used');
});

// ── Who may spend the money ─────────────────────────────────────────────────

test('an owner of a live per-seat subscription may add a seat', () => {
  assert.strictEqual(canAddSeat(fullTeam()), true);
});

test('a member and a viewer may not', () => {
  // Spending a workspace's money is an owner's power. The server refuses them
  // too; showing the control anyway means the refusal arrives after the click.
  assert.strictEqual(canAddSeat(fullTeam({ actor_role: 'member' })), false);
  assert.strictEqual(canAddSeat(fullTeam({ actor_role: 'viewer' })), false);
});

test('a lapsed team fixes the bill before it grows', () => {
  assert.strictEqual(canAddSeat(fullTeam({ team_management: false })), false);
});

test('a workspace with no live subscription is not offered a seat change', () => {
  // There is nothing to reprice: buying Team from scratch is an ordinary
  // checkout with its own seat picker, and a seat change there would be the
  // duplicate-subscription bug wearing a different hat.
  assert.strictEqual(canAddSeat(fullTeam({
    billing: { plan_tier: 'developer_pro', subscription_status: 'active', has_subscription: false, seats_purchased: null },
  })), false);
});

test('a per-person plan has no seats to add', () => {
  assert.strictEqual(canAddSeat(fullTeam({
    billing: { plan_tier: 'developer_basic', subscription_status: 'active', has_subscription: true, seats_purchased: null },
  })), false);
  assert.strictEqual(canAddSeat(fullTeam({ billing: null })), false);
});

// ── What gets posted ────────────────────────────────────────────────────────

test('one click asks for one more seat than the workspace bought, as a total', () => {
  // The endpoint takes a COUNT. Sending a delta would ask a two-seat team to
  // drop to one, which it refuses as below headcount — the confusing version of
  // this bug rather than the visible one.
  assert.deepStrictEqual(addSeatRequest(fullTeam()), { tierId: 'developer_pro', seats: 3 });
});

test('a workspace already over its bought count asks for room, not for its cap', () => {
  // Reachable: the cap is only ever checked when somebody is ADDED, so a seat
  // reduction or a plan change can leave more people than seats. Asking for
  // bought+1 there buys a seat the invitation still cannot use.
  const over = fullTeam({ seats: { used: 3, pending: 1, included: 2, purchased: 2 } });
  assert.deepStrictEqual(addSeatRequest(over), { tierId: 'developer_pro', seats: 5 });
});

test('a typed number adds that many, and never fewer than one', () => {
  assert.strictEqual(addSeatRequest(fullTeam(), 3)?.seats, 5);
  assert.strictEqual(addSeatRequest(fullTeam(), 0)?.seats, 3);
  assert.strictEqual(addSeatRequest(fullTeam(), -4)?.seats, 3);
});

test('nobody who may not buy a seat gets a request to send', () => {
  assert.strictEqual(addSeatRequest(fullTeam({ actor_role: 'viewer' })), null);
  assert.strictEqual(addSeatRequest(fullTeam({ team_management: false })), null);
});

// ── What the owner agrees to ────────────────────────────────────────────────

test('the confirmation names the new total, the price and when the money moves', () => {
  const roster = fullTeam();
  const request = addSeatRequest(roster)!;
  const text = addSeatConfirmation(request, roster);

  assert.match(text, /from 2 seats to 3 seats/, 'the new total is the thing being agreed to');
  assert.match(text, new RegExp(`\\$${TEAM_PRICE_MONTHLY} per seat each month`));
  assert.match(text, new RegExp(`\\$${TEAM_PRICE_ANNUAL} per seat each year`));
  // The seat change keeps the existing billing period, so Stripe prorates onto
  // the next invoice. "Charged now" would be a promise of a charge that does
  // not appear.
  assert.match(text, /next invoice/);
  assert.ok(!/—/.test(text), 'no em dashes in user-facing copy');
});

test('a confirmation with no known cap still names the total it is buying', () => {
  const roster = fullTeam({ seats: { used: 2, pending: 0 } });
  const request = { tierId: 'developer_pro', seats: 3 };
  assert.match(addSeatConfirmation(request, roster), /billed for 3 seats/);
});

test('only an in-place seat change counts as bought', () => {
  // THE DEFECT. The page read neither `updated` nor `url`, so all three answers
  // showed the same green "This workspace now has N seats.", the URL was never
  // opened, and the invitation waiting on the seat was re-sent into the same cap.
  const bought = seatPurchaseOutcome({ updated: true, seats: 4, url: null, message: 'Seats changed to 4.' });
  assert.strictEqual(bought.kind, 'bought');
  assert.strictEqual(bought.kind === 'bought' && bought.seats, 4);

  const portal = seatPurchaseOutcome({ url: 'https://billing.stripe.com/p/session', portal: true, message: 'Finish this in the portal.' });
  assert.strictEqual(portal.kind, 'finish_elsewhere');
  assert.strictEqual(portal.kind === 'finish_elsewhere' && portal.portal, true);

  // No live subscription: a Stripe Checkout session, not a seat change.
  const checkout = seatPurchaseOutcome({ url: 'https://checkout.stripe.com/c/pay/abc' });
  assert.strictEqual(checkout.kind, 'finish_elsewhere');
  assert.strictEqual(checkout.kind === 'finish_elsewhere' && checkout.portal, false);

  // An answer with neither is not a purchase, whatever it says.
  assert.strictEqual(seatPurchaseOutcome({ message: 'Nothing to change.' }).kind, 'not_bought');
  assert.strictEqual(seatPurchaseOutcome({ updated: false }).kind, 'not_bought');
  assert.strictEqual(seatPurchaseOutcome(null).kind, 'not_bought');
  // `updated` must be the boolean, not anything truthy the API might grow.
  assert.strictEqual(seatPurchaseOutcome({ updated: 1 as unknown as boolean }).kind, 'not_bought');
});
