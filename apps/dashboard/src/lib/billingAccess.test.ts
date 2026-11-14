/**
 * ONE RULE ON EVERY PAGE: NO BILLING BUTTON UNLESS DEERDAWN KNOWS THE PERSON IS
 * AN OWNER.
 *
 * Journey r4: round 3's refusal notices offered "Update billing" to an owner
 * only, while the Team page's older helper (teamLoadRefusal) treated an UNKNOWN
 * role as an owner, and its lapsed-team panel offered the link to whoever could
 * read the roster. The owner's decision: one rule everywhere a billing or
 * upgrade action is offered on a locked or refused state. This asks every such
 * surface, for every role a listing can carry and for no role at all, and
 * checks they all agree with lib/billingAccess and with each other.
 *
 * The surfaces:
 *   - the refused-load notice on seven pages (loadFailure.refusalCopy)
 *   - the lapsed-workspace fallback banner (workspaceFallback.mayFixFallbackBilling)
 *   - the Team page when its roster is refused (teamInvites.teamLoadRefusal)
 *   - the Team page's lapsed-team panel (teamSeats.inactiveTeamNotice)
 *   - the Team page's "Add a seat" (teamSeats.canAddSeat)
 *   - /checkout's refusal of a lower plan (checkoutPlanChange.checkoutAutoSubmitDecision)
 * and the refusals the SERVER gives only past its owner check (a 402 from
 * /billing/checkout, a 400 invalid_plan), which prove the person an owner.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mayOfferBilling } from './billingAccess';
import { refusalCopy } from './loadFailure';
import { mayFixFallbackBilling } from './workspaceFallback';
import { teamLoadRefusal } from './teamInvites';
import { canAddSeat, inactiveTeamNotice } from './teamSeats';
import { checkoutAutoSubmitDecision, checkoutFailure } from './checkoutPlanChange';

// Every role a listing or roster can carry, legacy values, odd casing, and none.
const ROLES: Array<string | null | undefined> = ['owner', 'OWNER', ' owner ', 'member', 'viewer', 'admin', 'operator', 'approver', '', null, undefined];
const knownOwner = (role: string | null | undefined) => String(role ?? '').trim().toLowerCase() === 'owner';

const surfaces: Record<string, (role: string | null | undefined) => boolean> = {
  'refused-load notice': (role) => refusalCopy({ kind: 'subscription_inactive', reader: role === undefined ? null : { role: role ?? null } }).action !== null,
  'fallback banner': (role) => mayFixFallbackBilling(
    { workspaces: [{ workspace: 'org-team', name: 'Acme', role: role as never, personal: false }] },
    { from: 'org-team', to: 'org-me', reason: 'subscription_inactive' } as never,
  ),
  'Team page, roster refused (lapsed)': (role) => teamLoadRefusal({ status: 403, reason: 'subscription_inactive', role, personal: false }).planLink !== null,
  'Team page, roster refused (lapsed, personal)': (role) => teamLoadRefusal({ status: 403, reason: 'subscription_inactive', role, personal: true }).planLink !== null,
  'Team page, roster refused (no Team plan)': (role) => teamLoadRefusal({ status: 403, reason: 'upgrade_required', role, personal: null }).planLink !== null,
  'Team page, lapsed-team panel': (role) => inactiveTeamNotice({ actor_role: role as never, team_management: false } as never).billingLink,
  'Team page, Add a seat': (role) => canAddSeat({ actor_role: role as never, team_management: true, billing: { plan_tier: 'developer_pro', has_subscription: true } } as never),
  '/checkout, lower plan refused': (role) => {
    const d = checkoutAutoSubmitDecision({ hasSubscription: true, workspaceRole: role ?? null, targetPlan: 'developer_basic', currentTier: 'developer_pro' });
    return d.action === 'refuse' && d.exit === 'billing_portal';
  },
};

test('THE BUG: an unknown role was offered the plan link on the Team page', () => {
  assert.equal(teamLoadRefusal({ status: 403, reason: 'subscription_inactive', role: null, personal: null }).planLink, null);
  assert.equal(teamLoadRefusal({ status: 403, reason: 'upgrade_required', role: null, personal: null }).planLink, null);
});

for (const role of ROLES) {
  test(`every surface agrees for role ${JSON.stringify(role)}`, () => {
    const expected = knownOwner(role);
    assert.equal(mayOfferBilling({ role }), expected, 'the rule itself');
    for (const [name, offers] of Object.entries(surfaces)) {
      assert.equal(offers(role), expected, `${name} ${expected ? 'must offer' : 'must not offer'} a billing action to ${JSON.stringify(role)}`);
    }
  });
}

test('a refusal the server gives only past its owner check proves an owner, whatever the listing said', () => {
  assert.equal(mayOfferBilling({ role: null, ownerConfirmedByServer: true }), true);
  for (const error of [
    { status: 402, code: 'payment_overdue', data: { error: 'payment_overdue', billing_portal: true } },
    { status: 402, code: 'payment_confirmation_required', data: { error: 'payment_confirmation_required', billing_portal: true } },
    { status: 400, code: 'invalid_plan', data: { error: 'invalid_plan' } },
  ]) {
    const outcome = checkoutFailure(error) as { kind: string; exit?: string };
    assert.equal(outcome.kind, 'refused');
    assert.equal(outcome.exit, 'billing_portal');
  }
});

test('somebody who is not offered the button is told who can act, in the same words everywhere', () => {
  const notice = refusalCopy({ kind: 'subscription_inactive', reader: { role: 'member' } }).description;
  assert.equal(notice, 'Only a workspace owner can restore it by updating billing.');
  assert.match(teamLoadRefusal({ status: 403, reason: 'subscription_inactive', role: null, personal: null }).message, /Only a workspace owner can restore it by updating billing\./);
  assert.match(inactiveTeamNotice({ actor_role: 'member', team_management: false } as never).line, /Only a workspace owner can restore it by updating billing\./);
});

test('every page that offers a billing or upgrade action on a refused state asks the one rule', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');
  for (const lib of ['lib/loadFailure.ts', 'lib/workspaceFallback.ts', 'lib/teamInvites.ts', 'lib/teamSeats.ts', 'lib/checkoutPlanChange.ts']) {
    assert.match(read(lib), /mayOfferBilling\(/, `${lib} decides through lib/billingAccess`);
  }
  const team = read('pages/settings/team.tsx');
  assert.match(team, /inactiveTeamNotice\(roster\)\.billingLink \?/, 'the lapsed-team panel links only when the rule says so');
  assert.doesNotMatch(team, /SUBSCRIPTION_INACTIVE_LINE/, 'not the owner sentence to everybody');
  const newTeam = read('pages/settings/new-team.tsx');
  assert.match(newTeam, /needsTeamPlan && mayOfferBilling\(\{ ownerConfirmedByServer: Boolean\(workspace\) \}\)/,
    'the new-team wizard offers "Upgrade to Team" only for the workspace the server just made this person owner of');
});
