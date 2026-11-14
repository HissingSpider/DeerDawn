// B3-3: a person whose workspace was locked for a failed renewal opened the
// dashboard and was told "The request didn't come back — usually a dropped
// connection or an expired session", with a Retry that could never work, and a
// SAMPLE brief on /projects in place of their own. The API had answered 403
// subscription_inactive: "Your subscription is not active. Update billing to
// restore access." These tests run the one classifier every page now asks.
import test from 'node:test';
import assert from 'node:assert';

import {
  UPDATE_BILLING_LABEL,
  UPDATE_BILLING_ROUTE,
  classifyLoadFailure,
  isRefusedLoad,
  mayUpdateBilling,
  refusalCopy,
  resolveLoadFailure,
} from './loadFailure';
import { mayFixFallbackBilling } from './workspaceFallback';
import { teamLoadRefusal } from './teamInvites';

// The exact shape api.ts throws for enforcePlan's refusal: throwApiError sets
// `code` from body.code (enforcePlan sends none) and keeps the body as `data`.
function enforcementRefusal(error: string, message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), {
    name: 'ApiError',
    status: 403,
    code: undefined,
    data: { error, message, upgrade_required: error !== 'lockdown_active' },
    ...extra,
  });
}
const LAPSED = () => enforcementRefusal('subscription_inactive', 'Your subscription is not active. Update billing to restore access.');
const LOCKED = () => enforcementRefusal('lockdown_active', 'This workspace is locked. Contact support to restore access.');
// What the API sends now: the same error code, and which lock it is.
const LOCKED_BECAUSE = (lockReason: string) => Object.assign(LOCKED(), {
  data: { error: 'lockdown_active', lock_reason: lockReason, message: '', upgrade_required: false },
});
const FIRST_PAYMENT_FAILED = (seats: number | null = 3) => Object.assign(LAPSED(), {
  data: {
    error: 'subscription_inactive',
    subscription_status: 'incomplete',
    retry_checkout: { plan: 'developer_pro', seats },
    upgrade_required: true,
  },
});

test('the enforcement refusal is classified as a lapsed subscription, not a dropped connection', () => {
  assert.deepStrictEqual(classifyLoadFailure(LAPSED()), { kind: 'subscription_inactive' });
  // A route that does set `code` is read the same way.
  assert.strictEqual(classifyLoadFailure({ status: 403, code: 'subscription_inactive' }).kind, 'subscription_inactive');
  assert.strictEqual(isRefusedLoad(classifyLoadFailure(LAPSED())), true);
});

test('a locked workspace is a refusal too, with its own reason', () => {
  assert.strictEqual(classifyLoadFailure(LOCKED()).kind, 'locked');
});

test('a genuine network failure, a timeout and a 5xx stay "did not come back"', () => {
  // The client's own shapes for a request that never arrived (api.ts executeFetch).
  const unreachable = { status: 503, code: 'network_unreachable', message: 'Dashboard could not reach http://localhost:8080.' };
  const timeout = { status: 504, code: 'network_timeout', message: 'Dashboard API request timed out after 8s.' };
  const serverError = { status: 500, data: { error: 'internal_error' }, requestId: 'req_1' };
  for (const error of [unreachable, timeout, serverError, new TypeError('Failed to fetch'), undefined, null, 'boom']) {
    assert.strictEqual(classifyLoadFailure(error).kind, 'unreachable', JSON.stringify(error));
    assert.strictEqual(isRefusedLoad(classifyLoadFailure(error)), false);
  }
  // A 5xx whose body happens to carry the word is still a failure to answer.
  assert.strictEqual(classifyLoadFailure({ status: 500, data: { error: 'subscription_inactive' } }).kind, 'unreachable');
  // The server's reference travels with the failure, as the page printed it before.
  assert.strictEqual(classifyLoadFailure(serverError).requestId, 'req_1');
});

test('other 403s keep the page\'s existing words: this change decides nothing about them', () => {
  for (const reason of ['workspace_forbidden', 'feature_not_included', 'forbidden', undefined]) {
    assert.strictEqual(classifyLoadFailure({ status: 403, data: { error: reason } }).kind, 'unreachable', String(reason));
  }
});

test('an owner is told the API\'s own reason and given the link to billing', () => {
  const copy = refusalCopy({ kind: 'subscription_inactive', reader: { role: 'owner' } });
  assert.strictEqual(copy.title, 'This workspace’s subscription is inactive');
  assert.strictEqual(copy.description, 'Update billing to restore access.');
  assert.deepStrictEqual(copy.action, { href: '/settings/plan', label: 'Update billing' });
  assert.strictEqual(UPDATE_BILLING_ROUTE, '/settings/plan');
  assert.strictEqual(UPDATE_BILLING_LABEL, 'Update billing');
  // Case from the listing does not matter.
  assert.ok(refusalCopy({ kind: 'subscription_inactive', reader: { role: 'OWNER' } }).action);
});

test('a member or viewer is told who can act, and is offered no billing button that fails', () => {
  for (const role of ['member', 'viewer']) {
    const copy = refusalCopy({ kind: 'subscription_inactive', reader: { role } });
    assert.strictEqual(copy.action, null, role);
    assert.strictEqual(copy.title, 'This workspace’s subscription is inactive');
    assert.strictEqual(copy.description, 'Only a workspace owner can restore it by updating billing.');
  }
});

test('an unknown reader is not treated as an owner (the fallback banner\'s rule)', () => {
  for (const reader of [null, undefined, { role: null }, { role: 'admin' }]) {
    assert.strictEqual(refusalCopy({ kind: 'subscription_inactive', reader }).action, null, JSON.stringify(reader));
  }
});

test('who may update billing agrees with the fallback banner for every role', () => {
  const fallback = { from: 'org-acme', fromName: 'Acme', to: 'org-sam', reason: 'subscription_inactive' };
  for (const role of ['owner', 'Owner', 'member', 'viewer', 'admin', '', null, undefined]) {
    const listing = { active: 'org-acme', workspaces: [{ workspace: 'org-acme', name: 'Acme', role: role as string, personal: false }] };
    assert.strictEqual(
      mayUpdateBilling({ role: role ? String(role).toLowerCase() : null }),
      mayFixFallbackBilling(listing, fallback),
      `role ${String(role)}`,
    );
  }
});

// The owner's sentences (John, 2026-09-29), word for word.
const DISPUTE_TEXT = 'This workspace is locked because a payment on this account was disputed with the card issuer. '
  + 'Billing cannot lift it. Email support from the address on this account and we will review it.';
const LOCKDOWN_TEXT = 'This workspace was locked on purpose by an owner of this account. Ask an owner to turn lockdown off. '
  + 'If you are the owner and did not do this, email support.';
const FOREIGN_TEXT = 'The workspace you are using is locked, so nothing in it will load. '
  + 'Switch to your own workspace to keep working, or ask its owner to lift the lock.';

test('the API\'s lock_reason travels with the failure', () => {
  assert.deepStrictEqual(classifyLoadFailure(LOCKED_BECAUSE('dispute')), { kind: 'locked', lockReason: 'dispute' });
  assert.deepStrictEqual(classifyLoadFailure(LOCKED_BECAUSE('foreign_workspace')), { kind: 'locked', lockReason: 'foreign_workspace' });
  // A reason this client does not know, or none (an older API): no reason, read as lockdown.
  assert.deepStrictEqual(classifyLoadFailure(LOCKED_BECAUSE('something_new')), { kind: 'locked' });
  assert.deepStrictEqual(classifyLoadFailure(LOCKED()), { kind: 'locked' });
});

test('a dispute lock says billing cannot lift it and offers only an email to support', () => {
  const copy = refusalCopy({ kind: 'locked', lockReason: 'dispute' });
  assert.strictEqual(copy.title, 'This workspace is locked');
  assert.strictEqual(copy.description, DISPUTE_TEXT);
  assert.deepStrictEqual(copy.action, { href: 'mailto:support@deerdawn.com', label: 'Email support', kind: 'mailto' });
  assert.doesNotMatch(`${copy.description} ${copy.action?.href}`, /settings\/plan|Update billing/i);
});

test('an owner\'s lockdown says who turns it off, with no billing link', () => {
  for (const failure of [{ kind: 'locked', lockReason: 'lockdown' }, { kind: 'locked' }] as const) {
    const copy = refusalCopy(failure);
    assert.strictEqual(copy.description, LOCKDOWN_TEXT);
    assert.strictEqual(copy.action, null);
  }
});

test('somebody else\'s locked workspace points at the reader\'s own', () => {
  const copy = refusalCopy({ kind: 'locked', lockReason: 'foreign_workspace' });
  assert.strictEqual(copy.description, FOREIGN_TEXT);
  assert.strictEqual(copy.action?.kind, 'switch_workspace');
  assert.strictEqual(copy.action?.label, 'Switch to your own workspace');
});

test('the old catch-all sentence is gone from every lock', () => {
  for (const reason of ['dispute', 'lockdown', 'foreign_workspace'] as const) {
    assert.doesNotMatch(refusalCopy({ kind: 'locked', lockReason: reason }).description, /Contact support to restore access/);
  }
});

test('a first payment that never went through offers checkout again for the same plan, not billing', () => {
  const failure = classifyLoadFailure(FIRST_PAYMENT_FAILED());
  assert.deepStrictEqual(failure, { kind: 'subscription_inactive', retryCheckout: { plan: 'developer_pro', seats: 3 } });
  const owner = refusalCopy({ ...failure, reader: { role: 'owner' } });
  assert.strictEqual(owner.title, 'The first payment did not go through');
  assert.deepStrictEqual(owner.action, { href: '/checkout?plan=developer_pro&seats=3', label: 'Check out again' });
  assert.doesNotMatch(`${owner.description} ${owner.action?.href}`, /settings\/plan|Update billing/);
  // Nobody else can buy for the workspace.
  for (const role of ['member', 'viewer', null]) {
    const other = refusalCopy({ ...failure, reader: { role } });
    assert.strictEqual(other.action, null, String(role));
    assert.strictEqual(other.description, 'Only a workspace owner can check out again.');
  }
  // Seats are optional; a personal plan carries none.
  assert.strictEqual(classifyLoadFailure(FIRST_PAYMENT_FAILED(null)).retryCheckout?.seats, null);
  assert.strictEqual(refusalCopy({ kind: 'subscription_inactive', retryCheckout: { plan: 'developer_basic', seats: null }, reader: { role: 'owner' } }).action?.href, '/checkout?plan=developer_basic');
});

test('an unpaid workspace is unchanged: billing, no retry', () => {
  const failure = classifyLoadFailure(LAPSED());
  assert.strictEqual(failure.retryCheckout, undefined);
  assert.strictEqual(refusalCopy({ ...failure, reader: { role: 'owner' } }).action?.href, '/settings/plan');
});

test('the Team page says the same lock sentences', () => {
  for (const [reason, text] of [['dispute', DISPUTE_TEXT], ['lockdown', LOCKDOWN_TEXT], ['foreign_workspace', FOREIGN_TEXT], [null, LOCKDOWN_TEXT]] as const) {
    const refusal = teamLoadRefusal({ status: 403, reason: 'lockdown_active', lockReason: reason });
    assert.strictEqual(refusal.message, text, String(reason));
    assert.strictEqual(refusal.planLink, null);
  }
});

test('the refusal says nothing about data, grace periods or dates', () => {
  const all = [
    refusalCopy({ kind: 'subscription_inactive', reader: { role: 'owner' } }),
    refusalCopy({ kind: 'subscription_inactive', reader: { role: 'member' } }),
    refusalCopy({ kind: 'locked' }),
    refusalCopy({ kind: 'locked', lockReason: 'dispute' }),
    refusalCopy({ kind: 'locked', lockReason: 'foreign_workspace' }),
  ].map((c) => `${c.title} ${c.description}`).join(' ');
  assert.doesNotMatch(all, /\b(data|delet|lost|safe|grace|days?|date|until|expire|retry)/i);
  assert.doesNotMatch(all, /dropped connection|didn.t come back/i);
});

test('the title is the product\'s existing sentence for this state', () => {
  // lib/teamInvites says it to the owner of a lapsed workspace on the Team page.
  const team = teamLoadRefusal({ status: 403, reason: 'subscription_inactive', role: 'owner', personal: true });
  assert.ok(team.message.startsWith(`${refusalCopy({ kind: 'subscription_inactive', reader: { role: 'owner' } }).title}.`), team.message);
  // And the member sentence is the Team page's, minus the roster.
  const member = teamLoadRefusal({ status: 403, reason: 'subscription_inactive', role: 'member', personal: false });
  assert.ok(member.message.endsWith(refusalCopy({ kind: 'subscription_inactive', reader: { role: 'member' } }).description), member.message);
});

const OWNER_ROW = { workspace: 'org-sam', name: 'Sam', role: 'owner', personal: true };
const TEAM_MEMBER_ROW = { workspace: 'org-acme', name: 'Acme', role: 'member', personal: false };

test('resolving a lapsed refusal reads who is reading from the bound workspace', async () => {
  // Solo owner: the bound workspace is their own.
  const owner = await resolveLoadFailure(LAPSED(), {
    readListing: async () => ({ active: 'org-sam', workspaces: [OWNER_ROW] }),
    storedChoice: () => null,
  });
  assert.deepStrictEqual(owner, { kind: 'subscription_inactive', reader: { role: 'owner' } });
  assert.ok(refusalCopy(owner).action);

  // A member whose browser is bound (stored choice) to the lapsed team.
  const member = await resolveLoadFailure(LAPSED(), {
    readListing: async () => ({ active: 'org-sam', workspaces: [OWNER_ROW, TEAM_MEMBER_ROW] }),
    storedChoice: () => 'org-acme',
  });
  assert.deepStrictEqual(member.reader, { role: 'member' });
  assert.strictEqual(refusalCopy(member).action, null);

  // A stored choice the listing no longer offers is not a binding: `active` answers.
  const stale = await resolveLoadFailure(LAPSED(), {
    readListing: async () => ({ active: 'org-sam', workspaces: [OWNER_ROW] }),
    storedChoice: () => 'org-gone',
  });
  assert.deepStrictEqual(stale.reader, { role: 'owner' });
});

test('if the listing cannot be read, nobody is offered the billing link', async () => {
  const failure = await resolveLoadFailure(LAPSED(), {
    readListing: async () => { throw new Error('listing down'); },
    storedChoice: () => { throw new Error('no storage'); },
  });
  assert.strictEqual(failure.kind, 'subscription_inactive');
  assert.strictEqual(failure.reader, null);
  assert.strictEqual(refusalCopy(failure).action, null);
});

test('only a subscription refusal pays for the listing read', async () => {
  let reads = 0;
  const deps = { readListing: async () => { reads += 1; return null; }, storedChoice: () => null };
  assert.strictEqual((await resolveLoadFailure({ status: 503, code: 'network_unreachable' }, deps)).kind, 'unreachable');
  assert.strictEqual((await resolveLoadFailure(LOCKED(), deps)).kind, 'locked');
  assert.strictEqual(reads, 0);
});

// ── Every other surface that describes an incomplete workspace ──────────────
// (owner's answer, 2026-09-29: check out again, not billing)
import { inactiveTeamNotice } from './teamSeats';
import { FIRST_PAYMENT_OWNER_LINE, FIRST_PAYMENT_TITLE, firstPaymentSentence, parseRetryCheckout, retryCheckoutHref } from './firstPayment';
import { fallbackReasonSentence, fallbackShortReason, servedWorkspace, workspaceFallbackNotice, credentialWorkspaceWarning } from './workspaceFallback';
import { planFirstPaymentCard, planStatusLabel } from './planBilling';

const INCOMPLETE_ROSTER = (role: string) => ({
  actor_role: role,
  team_management: false,
  billing: { plan_tier: 'developer_pro', subscription_status: 'incomplete', seats_purchased: 3, has_subscription: true },
});

test('the Team page panel for an incomplete workspace says the first payment failed and offers checkout again to an owner', () => {
  const owner = inactiveTeamNotice(INCOMPLETE_ROSTER('owner') as never);
  assert.strictEqual(owner.line, `${FIRST_PAYMENT_TITLE}. ${FIRST_PAYMENT_OWNER_LINE}`);
  assert.strictEqual(owner.billingLink, false, 'not the billing page');
  assert.strictEqual(owner.checkoutAgainHref, '/checkout?plan=developer_pro&seats=3');
  for (const role of ['member', 'viewer', null]) {
    const other = inactiveTeamNotice(INCOMPLETE_ROSTER(role as string) as never);
    assert.strictEqual(other.line, 'The first payment did not go through. Only a workspace owner can check out again.', String(role));
    assert.strictEqual(other.billingLink, false);
    assert.strictEqual(other.checkoutAgainHref, undefined);
  }
});

test('the Team page panel for an unpaid workspace is unchanged', () => {
  const unpaid = { actor_role: 'owner', team_management: false, billing: { plan_tier: 'developer_pro', subscription_status: 'unpaid', seats_purchased: 3 } };
  const notice = inactiveTeamNotice(unpaid as never);
  assert.match(notice.line, /subscription is inactive\. You can remove members or update billing\./);
  assert.strictEqual(notice.billingLink, true);
  assert.strictEqual(notice.checkoutAgainHref, undefined);
});

test('the Team page load refusal for an incomplete workspace names the first payment and links to checkout again', () => {
  const retryCheckout = { plan: 'developer_pro', seats: 3 };
  const owner = teamLoadRefusal({ status: 403, reason: 'subscription_inactive', role: 'owner', personal: true, retryCheckout });
  assert.strictEqual(owner.message, `${FIRST_PAYMENT_TITLE}. ${FIRST_PAYMENT_OWNER_LINE}`);
  assert.deepStrictEqual(owner.planLink, { label: 'Check out again', href: '/checkout?plan=developer_pro&seats=3' });
  for (const role of ['member', 'viewer']) {
    const other = teamLoadRefusal({ status: 403, reason: 'subscription_inactive', role, personal: false, retryCheckout });
    assert.strictEqual(other.message, firstPaymentSentence(false));
    assert.strictEqual(other.planLink, null);
  }
  const unknown = teamLoadRefusal({ status: 403, reason: 'subscription_inactive', role: null, personal: null, retryCheckout });
  assert.strictEqual(unknown.planLink, null, 'an unknown role is not an owner');
});

test('the fallback banner for an incomplete team says the first payment failed', () => {
  const listing = {
    active: 'org-acme',
    workspaces: [
      { workspace: 'org-acme', name: 'Acme', role: 'owner', personal: false },
      { workspace: 'org-sam', name: 'Sam', role: 'owner', personal: true },
    ],
    fallback: { from: 'org-acme', from_name: 'Acme', to: 'org-sam', reason: 'subscription_inactive', retry_checkout: { plan: 'developer_pro', seats: 3 } },
  };
  const { fallback } = servedWorkspace(listing, null, null);
  assert.deepStrictEqual(fallback?.retryCheckout, { plan: 'developer_pro', seats: 3 });
  assert.strictEqual(fallbackReasonSentence(fallback!), 'Acme’s first payment did not go through.');
  assert.strictEqual(fallbackShortReason(fallback!), 'first payment failed');
  assert.match(workspaceFallbackNotice(fallback!), /^Acme’s first payment did not go through\./);
  assert.doesNotMatch(workspaceFallbackNotice(fallback!), /subscription is inactive/);
  assert.doesNotMatch(credentialWorkspaceWarning(fallback!), /subscription is inactive/);
  // Unpaid is unchanged.
  const unpaid = servedWorkspace({ ...listing, fallback: { ...listing.fallback, retry_checkout: undefined } }, null, null).fallback!;
  assert.strictEqual(unpaid.retryCheckout, undefined);
  assert.strictEqual(fallbackReasonSentence(unpaid), 'Acme’s subscription is inactive.');
});

test('the plan page says the first payment failed and offers checkout again', () => {
  const plan = { tier: 'developer_pro', status: 'incomplete', purchased_seats: 3, stripe_customer_id: 'cus_1' };
  const card = planFirstPaymentCard(plan);
  assert.deepStrictEqual(card, {
    heading: FIRST_PAYMENT_TITLE,
    blurb: `${FIRST_PAYMENT_OWNER_LINE} Only a workspace owner can do this.`,
    actionLabel: 'Check out again',
    href: '/checkout?plan=developer_pro&seats=3',
  });
  assert.strictEqual(planFirstPaymentCard({ ...plan, status: 'unpaid' }), null);
  assert.strictEqual(planFirstPaymentCard({ tier: 'free', status: 'incomplete' }), null, 'a Free workspace has no paid plan to check out again');
  assert.strictEqual(planStatusLabel('incomplete'), 'First payment did not go through');
  assert.strictEqual(planStatusLabel('past_due'), 'Past Due');
});

test('retry_checkout is read defensively', () => {
  assert.strictEqual(parseRetryCheckout(null), null);
  assert.strictEqual(parseRetryCheckout({ plan: '' }), null);
  assert.deepStrictEqual(parseRetryCheckout({ plan: 'developer_basic', seats: 'x' }), { plan: 'developer_basic', seats: null });
  assert.strictEqual(retryCheckoutHref({ plan: 'developer_basic', seats: null }), '/checkout?plan=developer_basic');
});
