/**
 * THE PLAN PAGE SHOWS WHAT THE PERSON PAYS.
 *
 * Journey r4: /settings/plan showed the plan name and "Status: Active" and
 * nothing else; after cancelling it still read "Pro, Status: Active". The
 * owner's decision: price, monthly or yearly, seats, next renewal date and
 * amount, trial end, and "ends on <date>" for a pending cancellation, every
 * figure from the subscription's current state as recorded on the workspace
 * row (never a Stripe call on page load). Prices from planCopy.
 *
 * What the row does not record is left out, and these pin that too: a trial's
 * cycle (unknowable from its period) when no price is on record. Journey r6 added
 * the recorded price and the pending cancellation; those are pinned at the end.
 *
 * A .ts file using createElement so the `src/lib/*.test.ts` glob runs it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRICE_ANNUAL, PRICE_MONTHLY, TEAM_PRICE_ANNUAL, TEAM_PRICE_MONTHLY, money } from './planCopy';

const load = async () => {
  try { return await import('./planBilling'); } catch { return {} as Record<string, any>; }
};
const loadView = async () => {
  try { return await import('../components/billing/PlanBillingFacts'); } catch { return {} as Record<string, any>; }
};

const NOW = Date.parse('2026-09-29T12:00:00Z');
const day = (n: number) => new Date(NOW + n * 86_400_000).toISOString();
const facts = (list: Array<{ label: string; value: string }>) => Object.fromEntries(list.map((f) => [f.label, f.value]));

test('THE BUG: a monthly Pro subscriber sees their price, cycle, period end and renewal amount', async () => {
  const m = await load();
  assert.equal(typeof m.planBillingFacts, 'function', 'THE BUG: the plan page had nothing but a name and a status');
  const got = facts(m.planBillingFacts({ tier: 'developer_basic', status: 'active', billing_period_start: day(-10), billing_period_end: day(20), stripe_customer_id: 'cus_1' }, NOW));
  assert.deepEqual(got, {
    Price: `$${PRICE_MONTHLY}/mo`,
    Billed: 'Monthly',
    'Current period ends': 'October 19, 2026',
    'Renewal amount': money(PRICE_MONTHLY),
  });
});

test('a yearly Pro subscriber: the yearly price and a yearly renewal', async () => {
  const m = await load();
  const got = facts(m.planBillingFacts?.({ tier: 'developer_basic', status: 'active', billing_period_start: day(-30), billing_period_end: day(335), stripe_customer_id: 'cus_1' }, NOW) || []);
  assert.equal(got.Price, `$${PRICE_ANNUAL}/year`);
  assert.equal(got.Billed, 'Yearly');
  assert.equal(got['Renewal amount'], money(PRICE_ANNUAL));
});

test('Team: price per seat, the seats bought, and a renewal for all of them', async () => {
  const m = await load();
  const monthly = facts(m.planBillingFacts?.({ tier: 'developer_pro', status: 'active', billing_period_start: day(-1), billing_period_end: day(29), purchased_seats: 3, stripe_customer_id: 'cus_1' }, NOW) || []);
  assert.equal(monthly.Price, `${money(TEAM_PRICE_MONTHLY)} per seat per month`);
  assert.equal(monthly.Seats, '3');
  assert.equal(monthly['Renewal amount'], money(TEAM_PRICE_MONTHLY * 3));
  const yearly = facts(m.planBillingFacts?.({ tier: 'developer_pro', status: 'active', billing_period_start: day(-1), billing_period_end: day(364), purchased_seats: 4, stripe_customer_id: 'cus_1' }, NOW) || []);
  assert.equal(yearly.Price, `${money(TEAM_PRICE_ANNUAL / 12)} per seat per month, ${money(TEAM_PRICE_ANNUAL)} per seat billed yearly`);
  assert.equal(yearly['Renewal amount'], money(TEAM_PRICE_ANNUAL * 4));
});

test('a trial: when it ends and the seats; no price, since its cycle is not on record', async () => {
  const m = await load();
  const got = facts(m.planBillingFacts?.({ tier: 'developer_pro', status: 'trialing', billing_period_start: day(-2), billing_period_end: day(12), purchased_seats: 2, stripe_customer_id: 'cus_1' }, NOW) || []);
  assert.deepEqual(got, { 'Trial ends': 'October 11, 2026', Seats: '2' });
});

test('what is not recorded is left out, not guessed', async () => {
  const m = await load();
  // Team with no seat count on record: no renewal amount.
  const noSeats = facts(m.planBillingFacts?.({ tier: 'developer_pro', status: 'active', billing_period_start: day(-1), billing_period_end: day(29), purchased_seats: null, stripe_customer_id: 'cus_1' }, NOW) || []);
  assert.equal(noSeats.Seats, undefined);
  assert.equal(noSeats['Renewal amount'], undefined);
  // A period with no start that ends within the month: the cycle is unknown.
  const unknown = facts(m.planBillingFacts?.({ tier: 'developer_basic', status: 'active', billing_period_end: day(10), stripe_customer_id: 'cus_1' }, NOW) || []);
  assert.equal(unknown.Price, undefined);
  assert.equal(unknown['Current period ends'], 'October 9, 2026');
  // Nothing says "renews on": whether a subscription will renew is never
  // promised, only when the period ends and what a renewal would cost.
  for (const f of m.planBillingFacts?.({ tier: 'developer_basic', status: 'active', billing_period_start: day(-10), billing_period_end: day(20), stripe_customer_id: 'cus_1' }, NOW) || []) {
    assert.doesNotMatch(`${f.label} ${f.value}`, /renews on|will renew/i);
  }
});

test('Free, and a paid plan with no subscription on record, show nothing new', async () => {
  const m = await load();
  assert.deepEqual(m.planBillingFacts?.({ tier: 'free', status: 'active', stripe_customer_id: null }, NOW), []);
  assert.deepEqual(m.planBillingFacts?.({ tier: 'developer_basic', status: 'active', stripe_customer_id: null, billing_period_end: day(20) }, NOW), []);
});

test('the plan page renders the figures under the plan name', async () => {
  const v = await loadView();
  assert.equal(typeof v.PlanBillingFacts, 'function');
  const html = renderToStaticMarkup(createElement(v.PlanBillingFacts, { plan: { tier: 'developer_basic', status: 'active', billing_period_start: day(-10), billing_period_end: day(20), stripe_customer_id: 'cus_1' } }));
  assert.match(html, /<dt[^>]*>Price<\/dt><dd[^>]*>\$12\/mo<\/dd>/);
  assert.match(html, /Billed.*Monthly/);
  const page = readFileSync(join(__dirname, '..', 'pages', 'settings', 'plan.tsx'), 'utf8');
  assert.match(page, /<PlanBillingFacts plan=\{plan\} \/>/);
});

// ── journey r6: the real price and the pending cancellation ────────────────

test('r6: the price a subscription was SOLD at is shown, not today\'s list price (a legacy $10 Pro subscriber reads $10)', async () => {
  const m = await load();
  const got = facts(m.planBillingFacts?.({
    tier: 'developer_basic', status: 'active', billing_period_start: day(-10), billing_period_end: day(20), stripe_customer_id: 'cus_1',
    price: { unit_amount_cents: 1000, currency: 'usd', interval: 'month', interval_count: 1 },
  }, NOW) || []);
  assert.equal(got.Price, '$10/mo', 'THE BUG: every Pro subscription read as today\'s $12');
  assert.equal(got.Billed, 'Monthly');
  assert.equal(got['Renewal amount'], '$10');
});

test('r6: the recorded cadence decides Monthly or Yearly, not the length of the period', async () => {
  const m = await load();
  // No period start on record: the old reading could not tell, the price can.
  const yearly = facts(m.planBillingFacts?.({
    tier: 'developer_basic', status: 'active', billing_period_end: day(10), stripe_customer_id: 'cus_1',
    price: { unit_amount_cents: 9600, currency: 'usd', interval: 'year', interval_count: 1 },
  }, NOW) || []);
  assert.equal(yearly.Price, '$96/year');
  assert.equal(yearly.Billed, 'Yearly');
  assert.equal(yearly['Renewal amount'], '$96');
});

test('r6: a Team subscription at a real per-seat price: the price, the seats and the renewal for all of them', async () => {
  const m = await load();
  const got = facts(m.planBillingFacts?.({
    tier: 'developer_pro', status: 'active', billing_period_start: day(-1), billing_period_end: day(29), purchased_seats: 4, stripe_customer_id: 'cus_1',
    price: { unit_amount_cents: 1200, currency: 'usd', interval: 'month', interval_count: 1 },
  }, NOW) || []);
  assert.equal(got.Price, '$12 per seat per month');
  assert.equal(got.Seats, '4');
  assert.equal(got['Renewal amount'], '$48');
});

test('r6: a pending cancellation says "Ends on <date>" and promises no renewal', async () => {
  const m = await load();
  const got = facts(m.planBillingFacts?.({
    tier: 'developer_basic', status: 'active', billing_period_start: day(-10), billing_period_end: day(20), stripe_customer_id: 'cus_1',
    cancel_at_period_end: true, cancel_at: day(20),
    price: { unit_amount_cents: 1200, currency: 'usd', interval: 'month', interval_count: 1 },
  }, NOW) || []);
  assert.equal(got.Cancellation, 'Ends on October 19, 2026', 'THE BUG: a cancelled subscription read as "Pro, Status: Active" with a renewal');
  assert.equal(got['Renewal amount'], undefined, 'a subscription that will not renew has no renewal amount');
  assert.equal(got['Current period ends'], undefined);
  // The flag alone (no cancel_at): the period's end is the end.
  const flagOnly = facts(m.planBillingFacts?.({
    tier: 'developer_basic', status: 'active', billing_period_start: day(-10), billing_period_end: day(20), stripe_customer_id: 'cus_1',
    cancel_at_period_end: true,
  }, NOW) || []);
  assert.equal(flagOnly.Cancellation, 'Ends on October 19, 2026');
});

test('r6: a cancellation dated beyond the current period still renews until then, and says both', async () => {
  const m = await load();
  const got = facts(m.planBillingFacts?.({
    tier: 'developer_basic', status: 'active', billing_period_start: day(-10), billing_period_end: day(20), stripe_customer_id: 'cus_1',
    cancel_at_period_end: false, cancel_at: day(200),
    price: { unit_amount_cents: 1200, currency: 'usd', interval: 'month', interval_count: 1 },
  }, NOW) || []);
  assert.equal(got.Cancellation, 'Ends on April 17, 2027');
  assert.equal(got['Renewal amount'], '$12');
  assert.equal(got['Current period ends'], 'October 19, 2026');
});

test('r6: a trial that will be cancelled shows its end and the cancellation; one with a price shows what it costs after', async () => {
  const m = await load();
  const trial = { tier: 'developer_pro', status: 'trialing', billing_period_start: day(-2), billing_period_end: day(12), purchased_seats: 2, stripe_customer_id: 'cus_1' };
  const priced = facts(m.planBillingFacts?.({ ...trial, price: { unit_amount_cents: 1500, currency: 'usd', interval: 'month', interval_count: 1 } }, NOW) || []);
  assert.equal(priced['Price after the trial'], '$15 per seat per month');
  const cancelling = facts(m.planBillingFacts?.({ ...trial, cancel_at_period_end: true, cancel_at: day(12), price: { unit_amount_cents: 1500, currency: 'usd', interval: 'month', interval_count: 1 } }, NOW) || []);
  assert.equal(cancelling['Price after the trial'], undefined, 'it will not convert');
  assert.equal(cancelling.Cancellation, 'Ends on October 11, 2026');
});

test('r6: no price on record reads exactly as before (the list price, from the cycle)', async () => {
  const m = await load();
  const got = facts(m.planBillingFacts?.({ tier: 'developer_basic', status: 'active', billing_period_start: day(-10), billing_period_end: day(20), stripe_customer_id: 'cus_1', price: null, cancel_at_period_end: null }, NOW) || []);
  assert.equal(got.Price, `$${PRICE_MONTHLY}/mo`);
  assert.equal(got.Cancellation, undefined, 'a cancellation that is not on record is not invented');
});
