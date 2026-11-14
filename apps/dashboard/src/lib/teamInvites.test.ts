import test from 'node:test';
import assert from 'node:assert';
import { inviteFailureLabel, inviteRefusalMessage, inviteWasEmailed, projectListRefusalMessage } from './teamInvites';

test('only an explicit email_sent: true counts as emailed', () => {
  assert.strictEqual(inviteWasEmailed({ email_sent: true }), true);
  // An older server omits the field. That is unknown, and unknown shows the link.
  assert.strictEqual(inviteWasEmailed({}), false);
  assert.strictEqual(inviteWasEmailed({ email_sent: false }), false);
  assert.strictEqual(inviteWasEmailed(undefined), false);
});

test('a 403 on invite names the plan, not a generic failure', () => {
  assert.match(inviteRefusalMessage(403), /Team plan/);
  assert.match(inviteFailureLabel('a@b.com', 403), /Team plan/);
  assert.match(inviteRefusalMessage(402), /seats/);
  assert.match(inviteFailureLabel('a@b.com', 402), /no seats left/);
  assert.strictEqual(inviteFailureLabel('a@b.com', 500), 'a@b.com');
});

test('a full workspace on the per-seat plan is not told to upgrade to it', () => {
  // THE BUG: "Upgrade to add another person" was shown to an owner already
  // paying for Team, and the only thing behind that word was a plan picker
  // offering the plan she was on. She needs a seat, not a plan.
  const owner = inviteRefusalMessage(402, { canAddSeat: true, onPerSeatPlan: true });
  assert.match(owner, /Add a seat/);
  assert.ok(!/Upgrade/i.test(owner), owner);

  const teammate = inviteRefusalMessage(402, { onPerSeatPlan: true });
  assert.match(teammate, /Ask a workspace owner/);
  assert.ok(!/Upgrade/i.test(teammate), teammate);

  // A workspace that is NOT on a per-seat plan genuinely does have to upgrade.
  assert.match(inviteRefusalMessage(402), /Upgrade/);
});

test('a refused project listing is not reported as an empty account', () => {
  // The wizard's step 2 swallowed every failure and rendered "You have no
  // projects to move yet." GET /teams/projects-sharing sits behind
  // ensureTeamAccess, which needs team_management on the BOUND workspace — at
  // that point in the wizard, the creator's own Free or Pro account. So the 403
  // was the normal case and the wizard told them they owned nothing.
  const refused = projectListRefusalMessage(403);
  assert.match(refused, /Team plan/);
  assert.match(refused, /Team settings/, 'it has to name the way to do it anyway');
  assert.ok(!/no projects/i.test(refused), 'it must not claim the account is empty');

  assert.match(projectListRefusalMessage(402), /Team plan/);
  assert.match(projectListRefusalMessage(401), /session expired/i);
  // Anything else is still honest about which fact it is reporting.
  const unknown = projectListRefusalMessage(500);
  assert.match(unknown, /could not load/i);
  assert.ok(!/no projects/i.test(unknown));
});
