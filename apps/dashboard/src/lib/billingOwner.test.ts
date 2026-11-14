/**
 * WHO PAYS, AND SEATS BELOW HEADCOUNT: the words and the buttons (journey r6).
 *
 * The API refuses the payer's departure (409 billing_owner) until another owner
 * has taken billing over or the subscription is set to end; the page must offer
 * exactly those two ways and promise nothing else. A workspace whose payer is
 * not on record refuses nobody, and the page says it does not know rather than
 * naming somebody.
 *
 * A .ts file using createElement so the `src/lib/*.test.ts` glob runs it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const load = async () => {
  try { return await import('./billingOwner'); } catch { return {} as Record<string, any>; }
};
const loadView = async () => {
  try { return await import('../components/billing/BillingOwnerPanel'); } catch { return {} as Record<string, any>; }
};

const NOW = Date.parse('2026-09-29T12:00:00Z');
const day = (n: number) => new Date(NOW + n * 86_400_000).toISOString();
const paid = { tier: 'developer_pro', status: 'active', stripe_customer_id: 'cus_1', billing_period_end: day(20) };

test('the payer is told what holds them and offered exactly the payer\'s way out', async () => {
  const m = await load();
  assert.equal(typeof m.billingOwnerPanel, 'function', 'THE BUG: the page had no word about who pays');
  const panel = m.billingOwnerPanel({ ...paid, billing_owner: { recorded: true, is_you: true, can_manage: true } });
  assert.equal(panel.heading, 'You pay for this workspace');
  assert.match(panel.lines.join(' '), /cannot leave the workspace, step down as an owner or delete your account/);
  assert.deepEqual(panel.actions, ['end_at_period_end']);
});

test('another owner is offered the takeover, and told who pays when it is on record', async () => {
  const m = await load();
  const named = m.billingOwnerPanel({ ...paid, billing_owner: { recorded: true, is_you: false, email: 'sam@acme.test', can_manage: true } });
  assert.match(named.lines[0], /^sam@acme\.test pays for this subscription\.$/);
  assert.deepEqual(named.actions, ['take_over']);
  const anonymous = m.billingOwnerPanel({ ...paid, billing_owner: { recorded: true, is_you: false, can_manage: true } });
  assert.match(anonymous.lines[0], /^Another owner pays/);
});

test('a payer that is not on record is not invented', async () => {
  const m = await load();
  const panel = m.billingOwnerPanel({ ...paid, billing_owner: { recorded: false, is_you: false, can_manage: true } });
  assert.match(panel.lines[0], /does not have anybody on record as paying/);
  assert.deepEqual(panel.actions, ['take_over']);
});

test('a takeover in progress offers the portal again and the read-back; another owner\'s is only reported', async () => {
  const m = await load();
  const mine = m.billingOwnerPanel({ ...paid, billing_owner: { recorded: true, is_you: false, can_manage: true }, takeover: { pending: true, started_by_you: true } });
  assert.equal(mine.heading, 'Taking over billing');
  assert.deepEqual(mine.actions, ['take_over', 'confirm_takeover']);
  const theirs = m.billingOwnerPanel({ ...paid, billing_owner: { recorded: true, is_you: false, can_manage: true }, takeover: { pending: true, started_by_you: false } });
  assert.match(theirs.lines.join(' '), /Another owner has started taking over billing/);
});

test('once the subscription is set to end, the payer is told they are free and offered nothing to press', async () => {
  const m = await load();
  const panel = m.billingOwnerPanel({ ...paid, cancel_at_period_end: true, cancel_at: day(20), billing_owner: { recorded: true, is_you: true, can_manage: true } });
  assert.deepEqual(panel.actions, []);
  assert.match(panel.lines.join(' '), /set to end on October 19, 2026/);
  assert.match(panel.lines.join(' '), /leave the workspace or delete your account now/);
  // Nobody else has anything to say about a subscription that no longer renews.
  assert.equal(m.billingOwnerPanel({ ...paid, cancel_at_period_end: true, billing_owner: { recorded: true, is_you: false, can_manage: true } }), null);
});

test('nothing is shown to somebody who may not act, or for a workspace with no live Stripe subscription', async () => {
  const m = await load();
  assert.equal(m.billingOwnerPanel({ ...paid, billing_owner: { recorded: true, is_you: false, can_manage: false } }), null);
  assert.equal(m.billingOwnerPanel({ ...paid, billing_owner: null }), null);
  assert.equal(m.billingOwnerPanel({ tier: 'free', status: 'active', stripe_customer_id: null, billing_owner: { recorded: false, is_you: false, can_manage: true } }), null);
  assert.equal(m.billingOwnerPanel({ ...paid, status: 'incomplete', billing_owner: { recorded: true, is_you: true, can_manage: true } }), null, 'nothing was collected, so nothing renews');
});

test('the seat shortfall sentence says what is true: counts, nobody removed, nobody new until it fits', async () => {
  const m = await load();
  assert.equal(typeof m.seatShortfallLine, 'function');
  const line = m.seatShortfallLine({ members: 3, seats: 2, over_by: 1 });
  assert.match(line, /^This workspace has 3 people and 2 seats\. Nobody has been removed or locked out\./);
  assert.match(line, /nobody new can be invited/);
  assert.equal(m.seatShortfallLine(null), null);
  assert.equal(m.seatShortfallLine({ members: 2, seats: 2, over_by: 0 }), null);
});

test('the panels render, and the plan and team pages wire them', async () => {
  const v = await loadView();
  assert.equal(typeof v.BillingOwnerPanel, 'function');
  const html = renderToStaticMarkup(createElement(v.BillingOwnerPanel, {
    plan: { ...paid, billing_owner: { recorded: true, is_you: true, can_manage: true } }, pending: null, onAction: () => {},
  }));
  assert.match(html, /You pay for this workspace/);
  assert.match(html, /End the subscription at the close of the period/);
  const notice = renderToStaticMarkup(createElement(v.SeatShortfallNotice, { shortfall: { members: 4, seats: 3, over_by: 1 } }));
  assert.match(notice, /This workspace has 4 people and 3 seats/);
  assert.equal(renderToStaticMarkup(createElement(v.SeatShortfallNotice, { shortfall: null })), '');

  const plan = readFileSync(join(__dirname, '..', 'pages', 'settings', 'plan.tsx'), 'utf8');
  assert.match(plan, /<BillingOwnerPanel plan=\{plan\}/);
  assert.match(plan, /<SeatShortfallNotice/);
  const team = readFileSync(join(__dirname, '..', 'pages', 'settings', 'team.tsx'), 'utf8');
  assert.match(team, /<SeatShortfallNotice/);
});
