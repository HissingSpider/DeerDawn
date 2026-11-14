import test from 'node:test';
import assert from 'node:assert';

import {
  CHECKOUT_RETRY_MESSAGE,
  LOWER_TIER_REFUSAL,
  checkoutAutoSubmitDecision,
  checkoutFailure,
  isLowerTier,
  namedCadence,
  resolveCheckoutCadence,
  seatChangeSentence,
  seatReductionRefusal,
  workspaceHasSubscription,
} from './checkoutPlanChange';

test('namedCadence reads only a cadence the URL actually named', () => {
  assert.strictEqual(namedCadence('monthly'), 'monthly');
  assert.strictEqual(namedCadence('annual'), 'annual');
  // The marketing pricing page links `billing=yearly`. The old page compared
  // against 'monthly' and called everything else annual, so this spelling
  // worked by accident; it is a synonym on purpose now.
  assert.strictEqual(namedCadence('yearly'), 'annual');
  assert.strictEqual(namedCadence('YEARLY'), 'annual');
  assert.strictEqual(namedCadence(undefined), null);
  assert.strictEqual(namedCadence(''), null);
  assert.strictEqual(namedCadence('anual'), null, 'a typo is not a cadence');
  assert.strictEqual(namedCadence(['monthly', 'annual']), null, 'a repeated key is not a cadence');
});

test('a new buyer keeps the annual-first default', () => {
  const opts = { hasSubscription: false };
  assert.strictEqual(resolveCheckoutCadence({}, opts), 'annual');
  assert.strictEqual(resolveCheckoutCadence({ billing: 'monthly' }, opts), 'monthly');
  assert.strictEqual(resolveCheckoutCadence({ billing: 'yearly' }, opts), 'annual');
});

test('an existing subscriber keeps their cadence unless the URL named one', () => {
  const opts = { hasSubscription: true };
  // THE REGRESSION GUARD. `?billing` absent used to become 'annual', and an
  // interval change makes Stripe start a new period and charge the prorated
  // difference immediately — so a monthly Pro subscriber following an upgrade
  // link was billed for a year the same minute.
  assert.strictEqual(resolveCheckoutCadence({}, opts), undefined);
  assert.strictEqual(resolveCheckoutCadence({ billing: 'nonsense' }, opts), undefined);
  // Named is still honoured: asking for annual is a decision, not an accident.
  assert.strictEqual(resolveCheckoutCadence({ billing: 'yearly' }, opts), 'annual');
  assert.strictEqual(resolveCheckoutCadence({ billing: 'monthly' }, opts), 'monthly');
});

test('lifetime is always monthly, subscription or not', () => {
  assert.strictEqual(resolveCheckoutCadence({ plan: 'lifetime' }, { hasSubscription: false }), 'monthly');
  assert.strictEqual(
    resolveCheckoutCadence({ plan: 'lifetime', billing: 'yearly' }, { hasSubscription: true }),
    'monthly',
  );
});

test('workspaceHasSubscription agrees with the trial signal', () => {
  assert.strictEqual(workspaceHasSubscription({ tier: 'free', stripe_customer_id: null }), false);
  assert.strictEqual(workspaceHasSubscription({ tier: 'free', stripe_customer_id: 'cus_1' }), false);
  assert.strictEqual(workspaceHasSubscription({ tier: 'developer_basic', stripe_customer_id: null }), false);
  assert.strictEqual(workspaceHasSubscription({ tier: 'developer_basic', stripe_customer_id: 'cus_1' }), true);
  assert.strictEqual(workspaceHasSubscription(null), false);
  // A first payment that never went through is not a subscription to move: the
  // page checks out again instead of asking to confirm a prorated change.
  assert.strictEqual(workspaceHasSubscription({ tier: 'developer_pro', stripe_customer_id: 'cus_1', status: 'incomplete' }), false);
  assert.strictEqual(workspaceHasSubscription({ tier: 'developer_pro', stripe_customer_id: 'cus_1', status: 'unpaid' }), true);
});

test('the page posts by itself only for a workspace known to have no subscription', () => {
  // The assertions moved from deepStrictEqual to `.action`/`.reason` because the
  // decision now also says WHAT is being confirmed — the panel used to tell a
  // lifetime buyer and somebody whose usage read failed about a prorated charge
  // on a card on file. The intent is unchanged: submit only on a known-empty
  // workspace.
  assert.deepStrictEqual(checkoutAutoSubmitDecision({ hasSubscription: false }), { action: 'submit' });
  assert.strictEqual(checkoutAutoSubmitDecision({ hasSubscription: true }).action, 'confirm');
  // Unknown is NOT "no subscription". A failed or pending usage read must not be
  // the thing that reopens a silent plan change.
  const unknown = checkoutAutoSubmitDecision({ hasSubscription: null });
  assert.strictEqual(unknown.action, 'confirm');
  assert.strictEqual(unknown.action === 'confirm' && unknown.reason, 'unknown_state');
});

test('a member or a viewer is told the truth instead of posting', () => {
  for (const role of ['member', 'viewer', 'MEMBER']) {
    const decision = checkoutAutoSubmitDecision({ hasSubscription: false, workspaceRole: role });
    assert.strictEqual(decision.action, 'refuse', `${role} must not start checkout`);
    assert.match(
      decision.action === 'refuse' ? decision.reason : '',
      /workspace owner/i,
      'the refusal names the same rule requireBillingOwner enforces',
    );
  }
  assert.strictEqual(checkoutAutoSubmitDecision({ hasSubscription: false, workspaceRole: 'owner' }).action, 'submit');
  // An older API that does not report a role must not lock the owner out of
  // their own checkout.
  assert.strictEqual(checkoutAutoSubmitDecision({ hasSubscription: false, workspaceRole: null }).action, 'submit');
});

test('a refused member is offered their own workspace, because /checkout has no switcher', () => {
  // THE DEFECT. An invited teammate who wanted their OWN Pro was told to
  // "switch to your own workspace first" beside two buttons that both went
  // backwards. The page is standalone: there is no switcher on it.
  const refused = checkoutAutoSubmitDecision({
    hasSubscription: false,
    workspaceRole: 'member',
    boundIsPersonal: false,
  });
  assert.strictEqual(refused.action, 'refuse');
  assert.strictEqual(refused.action === 'refuse' && refused.exit, 'own_workspace');
  // An older API that does not say whose workspace this is must not offer an
  // exit it cannot stand behind.
  const unknownWorkspace = checkoutAutoSubmitDecision({ hasSubscription: false, workspaceRole: 'viewer' });
  assert.strictEqual(unknownWorkspace.action === 'refuse' && unknownWorkspace.exit, 'none');
});

test('lifetime is confirmed as a one-time payment, not as a card-on-file proration', () => {
  const decision = checkoutAutoSubmitDecision({ hasSubscription: true, targetPlan: 'lifetime' });
  assert.strictEqual(decision.action === 'confirm' && decision.reason, 'one_time');
});

test('a Team owner following the marketing seats=2 link sees the reduction named', () => {
  // THE DEFECT. The marketing "Try Team" link carries seats=2. A Team owner on
  // five seats following it was shown "This workspace already has a
  // subscription", and confirming took three seats away without ever saying so.
  const decision = checkoutAutoSubmitDecision({
    hasSubscription: true,
    targetPlan: 'developer_pro',
    currentTier: 'developer_pro',
    requestedSeats: 2,
    currentSeats: 5,
  });
  assert.strictEqual(decision.action === 'confirm' && decision.reason, 'seat_reduction');
  assert.deepStrictEqual(decision.action === 'confirm' ? decision.seatChange : null, { from: 5, to: 2 });
  assert.strictEqual(seatChangeSentence('Team', { from: 5, to: 2 }), 'Team stays Team; seats go from 5 to 2.');
});

test('unknown seats never produce a reduction offer', () => {
  // A reduction is a real request the API will honour. Guessing the current
  // count in order to offer one is how three seats disappear.
  const decision = checkoutAutoSubmitDecision({
    hasSubscription: true,
    targetPlan: 'developer_pro',
    currentTier: 'developer_pro',
    requestedSeats: 2,
    currentSeats: null,
  });
  assert.strictEqual(decision.action, 'refuse');
  assert.strictEqual(decision.action === 'refuse' && decision.exit, 'team_settings');
  assert.match(decision.action === 'refuse' ? decision.reason : '', /already on this plan/i);
});

test('the same plan at the same seat count is not a purchase', () => {
  const decision = checkoutAutoSubmitDecision({
    hasSubscription: true,
    targetPlan: 'developer_pro',
    currentTier: 'developer_pro',
    requestedSeats: 5,
    currentSeats: 5,
  });
  assert.strictEqual(decision.action, 'refuse');
  assert.match(decision.action === 'refuse' ? decision.reason : '', /nothing has been charged/i);
});

test('more seats on the same plan is still a confirm, just not a reduction', () => {
  const decision = checkoutAutoSubmitDecision({
    hasSubscription: true,
    targetPlan: 'developer_pro',
    currentTier: 'developer_pro',
    requestedSeats: 7,
    currentSeats: 5,
  });
  assert.strictEqual(decision.action === 'confirm' && decision.reason, 'seat_increase');
});

test('a plan MOVE is unaffected by the seat arithmetic', () => {
  // Pro to Team is a plan change, whatever the seat numbers say.
  const decision = checkoutAutoSubmitDecision({
    hasSubscription: true,
    targetPlan: 'developer_pro',
    currentTier: 'developer_basic',
    requestedSeats: 2,
    currentSeats: null,
  });
  assert.strictEqual(decision.action === 'confirm' && decision.reason, 'plan_change');
});

test('the server’s own seat refusal is read for its numbers, never resent on our authority', () => {
  assert.deepStrictEqual(
    seatReductionRefusal({ status: 409, data: { error: 'seat_reduction_not_confirmed', current: 5, requested: 2 } }),
    { from: 5, to: 2 },
  );
  assert.strictEqual(seatReductionRefusal({ status: 409, data: { error: 'workspace_inactive' } }), null);
  assert.strictEqual(
    seatReductionRefusal({ status: 409, data: { error: 'seat_reduction_not_confirmed' } }),
    null,
    'a refusal with no numbers cannot be turned into a confirmation',
  );
  assert.strictEqual(seatReductionRefusal(new Error('boom')), null);
});

test('a per-person plan you already have is refused without any seat talk', () => {
  // A Pro subscriber opening /checkout?plan=developer_basic. There are no seats
  // here, so neither the reduction copy nor the team-settings exit applies.
  const decision = checkoutAutoSubmitDecision({
    hasSubscription: true,
    targetPlan: 'developer_basic',
    currentTier: 'developer_basic',
    requestedSeats: null,
    currentSeats: null,
  });
  assert.strictEqual(decision.action, 'refuse');
  assert.strictEqual(decision.action === 'refuse' && decision.exit, 'none');
  assert.doesNotMatch(decision.action === 'refuse' ? decision.reason : '', /seat/i);
});

test('the server’s seat refusal breaks the loop an unread usage call leaves behind', () => {
  // THE DEAD END. /orgs/usage failed, so `hasSubscription` is null and the
  // decision is `unknown_state` — whose Confirm sends `submit(false)`. The
  // server answers 409 seat_reduction_not_confirmed, the page stores the
  // numbers, and the decision is STILL unknown_state because it never looked at
  // them. Same press, same refusal, forever.
  //
  // But the server has just told us there IS a subscription, how many seats it
  // is billed for, and how many were asked for. That is knowledge, not a guess,
  // and it is exactly what the named-reduction confirmation needs.
  const stuck = checkoutAutoSubmitDecision({
    hasSubscription: null,
    targetPlan: 'developer_pro',
    requestedSeats: 2,
    currentSeats: 5,
  });
  assert.strictEqual(stuck.action === 'confirm' && stuck.reason, 'unknown_state', 'the state before the refusal');

  const told = checkoutAutoSubmitDecision({
    hasSubscription: null,
    targetPlan: 'developer_pro',
    requestedSeats: 2,
    currentSeats: 5,
    serverSeatRefusal: { from: 5, to: 2 },
  });
  assert.strictEqual(told.action, 'confirm');
  assert.strictEqual(told.action === 'confirm' && told.reason, 'seat_reduction');
  assert.deepStrictEqual(told.action === 'confirm' && told.seatChange, { from: 5, to: 2 });
  assert.strictEqual(
    seatChangeSentence('Team', { from: 5, to: 2 }),
    'Team stays Team; seats go from 5 to 2.',
  );
});

test('the server’s numbers are the ones confirmed, even when ours disagree', () => {
  // The roster read and the subscription can differ (a pending invite, a stale
  // read). The refusal came from the thing that would do the work.
  const told = checkoutAutoSubmitDecision({
    hasSubscription: true,
    targetPlan: 'developer_pro',
    currentTier: 'developer_pro',
    requestedSeats: 2,
    currentSeats: 4,
    serverSeatRefusal: { from: 6, to: 2 },
  });
  assert.deepStrictEqual(told.action === 'confirm' && told.seatChange, { from: 6, to: 2 });
});

test('a seat refusal never overrides "you may not change this billing at all"', () => {
  // A member's press must not become a confirmed reduction because the server
  // happened to answer with numbers.
  const decision = checkoutAutoSubmitDecision({
    hasSubscription: null,
    workspaceRole: 'member',
    boundIsPersonal: false,
    serverSeatRefusal: { from: 5, to: 2 },
  });
  assert.strictEqual(decision.action, 'refuse');
});

// ── scan 19: the dead-end retries ───────────────────────────────────────────

test('a Team owner on a Pro checkout link is refused up front, with the portal as the way through', () => {
  // The server refuses a same-or-lower tier with 400 invalid_plan. The page
  // used to show the prorated plan-change panel first, and Confirm ended in
  // "Retry once": a retry that could never work.
  const decision = checkoutAutoSubmitDecision({
    hasSubscription: true,
    workspaceRole: 'owner',
    targetPlan: 'developer_basic',
    currentTier: 'developer_pro',
  });
  assert.deepStrictEqual(decision, { action: 'refuse', exit: 'billing_portal', reason: LOWER_TIER_REFUSAL });
  // An upgrade is still the confirm panel.
  assert.deepStrictEqual(
    checkoutAutoSubmitDecision({ hasSubscription: true, workspaceRole: 'owner', targetPlan: 'developer_pro', currentTier: 'developer_basic' }),
    { action: 'confirm', reason: 'plan_change' },
  );
  assert.strictEqual(isLowerTier('developer_basic', 'developer_pro'), true);
  assert.strictEqual(isLowerTier('developer_pro', 'developer_basic'), false);
  assert.strictEqual(isLowerTier('developer_basic', null), false, 'unknown is never read as lower');
  assert.strictEqual(isLowerTier('developer_basic', 'something_new'), false);
});

test('a 400 invalid_plan from the server becomes a refusal, not "retry"', () => {
  const err = { status: 400, message: 'Cannot start checkout for the same or lower tier.', data: { error: 'invalid_plan' } };
  assert.deepStrictEqual(checkoutFailure(err), { kind: 'refused', exit: 'billing_portal', message: LOWER_TIER_REFUSAL });
});

test('a 400 seats_below_headcount shows the server\'s sentence and points at team settings', () => {
  const err = {
    status: 400,
    message: 'This workspace has 4 people and pending invites. Remove somebody before reducing to 2 seats.',
    data: { error: 'seats_below_headcount', minimum_seats: 4 },
  };
  const out = checkoutFailure(err);
  assert.strictEqual(out.kind, 'refused');
  assert.strictEqual(out.kind === 'refused' && out.exit, 'team_settings');
  assert.match(out.message, /Remove somebody before reducing to 2 seats/);
  assert.doesNotMatch(out.message, /Retry/);
});

test('any other 4xx shows the server\'s own sentence; only an unanswered failure says retry', () => {
  assert.deepStrictEqual(
    checkoutFailure({ status: 403, message: 'Only a workspace owner can change its billing.' }),
    { kind: 'error', message: 'Only a workspace owner can change its billing.' },
  );
  assert.deepStrictEqual(checkoutFailure({ status: 500, message: 'Internal error' }), { kind: 'error', message: CHECKOUT_RETRY_MESSAGE });
  assert.deepStrictEqual(checkoutFailure(new Error('Failed to fetch')), { kind: 'error', message: CHECKOUT_RETRY_MESSAGE });
});

test('a 503 is named as configuration, keyed on the STATUS (the message carries the server sentence, not the code)', () => {
  // select-plan matched the text `billing_unavailable`, which throwApiError
  // never puts in `message`, so a real 503 read "Retry once".
  const out = checkoutFailure({ status: 503, message: 'Stripe is not configured', data: { error: 'billing_unavailable' } });
  assert.strictEqual(out.kind, 'error');
  assert.match(out.message, /^Stripe is not configured/);
  assert.match(out.message, /not something a retry fixes/);
});
