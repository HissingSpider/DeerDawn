// The lapsed-team fallback: the switcher said "Acme" while every request on the
// page was being answered by the reader's personal workspace, and a write that
// the server refused with 409 came back through the generic "couldn't save"
// path, which reads as a dropped connection worth retrying.
import test from 'node:test';
import assert from 'node:assert';

import {
  credentialWorkspace,
  credentialWorkspaceWarning,
  fallbackReasonSentence,
  fallbackShortReason,
  fallbackWorkspaceLabel,
  fallbackWorkspaceName,
  isWorkspaceInactiveError,
  listingReportsNoFallback,
  mayFixFallbackBilling,
  servedWorkspace,
  workspaceFallbackNotice,
  workspaceInactiveMessage,
} from './workspaceFallback';

const TEAM = { workspace: 'org-acme', name: 'Acme', role: 'member', personal: false };
const MINE = { workspace: 'org-sam', name: 'Sam', role: 'owner', personal: true };

test('with no fallback anywhere, the stored choice is what is serving', () => {
  const served = servedWorkspace({ active: 'org-acme', workspaces: [TEAM, MINE] }, null);
  assert.deepStrictEqual(served, { served: 'org-acme', stored: 'org-acme', fallback: null });
});

test('an API that reports no fallback field at all still answers', () => {
  // The dashboard deploys independently of the API, so it has to render
  // correctly against the shape that exists today.
  const served = servedWorkspace({ active: 'org-sam', workspaces: [MINE] });
  assert.strictEqual(served.served, 'org-sam');
  assert.strictEqual(served.fallback, null);
});

test('the listing names the fallback: the SERVED workspace is personal, not the stored team', () => {
  const served = servedWorkspace({
    active: 'org-acme',
    workspaces: [TEAM, MINE],
    fallback: { from: 'org-acme', from_name: 'Acme', to: 'org-sam', reason: 'subscription_inactive' },
  });
  assert.strictEqual(served.served, 'org-sam', 'the switcher must render what is answering');
  assert.strictEqual(served.stored, 'org-acme', 'the choice is still the choice');
  assert.strictEqual(served.fallback?.from, 'org-acme');
  assert.strictEqual(served.fallback?.fromName, 'Acme');
  assert.strictEqual(served.fallback?.reason, 'subscription_inactive');
});

test('the response header alone is enough when the listing predates the field', () => {
  const served = servedWorkspace({ active: 'org-acme', workspaces: [TEAM, MINE] }, 'org-acme');
  assert.strictEqual(served.served, 'org-sam', 'personal is inferred from the listing');
  assert.strictEqual(served.fallback?.from, 'org-acme');
  assert.strictEqual(served.fallback?.fromName, 'Acme', 'the name comes off the listing row');
});

test('a header naming a workspace nobody is pointed at any more is ignored', () => {
  // The header is a fact about a request that already happened. After a switch
  // it describes nothing, and a banner about a workspace the reader has left is
  // worse than no banner.
  const served = servedWorkspace({ active: 'org-sam', workspaces: [TEAM, MINE] }, 'org-acme');
  assert.strictEqual(served.fallback, null);
  assert.strictEqual(served.served, 'org-sam');
});

test('a reported fallback wins over a stale header even when they disagree', () => {
  const served = servedWorkspace(
    { active: 'org-acme', workspaces: [TEAM, MINE], fallback: { from: 'org-acme', to: 'org-sam' } },
    'org-other',
  );
  assert.strictEqual(served.fallback?.from, 'org-acme');
});

test('the notice says whose bill it is, which half of the page is your own, and which half is not', () => {
  // "You are viewing your own workspace. Nothing you do here goes to Acme." was
  // half true and the wrong half was the actionable one: /api/v1/keys,
  // /api/v1/billing, /api/v1/orgs and /api/v1/auth are exempt from plan
  // enforcement, so they are never rebound and still act on the TEAM.
  const notice = workspaceFallbackNotice({ from: 'org-acme', fromName: 'Acme', to: 'org-sam', reason: 'subscription_inactive' });
  assert.match(notice, /^Acme’s subscription is inactive\./);
  assert.match(notice, /Projects and briefs shown here are from your own workspace/);
  assert.match(notice, /Billing, keys and team settings still refer to Acme\./);
  assert.ok(!/Nothing you do here goes to/.test(notice), 'the old sentence was false for every exempt route');
  assert.ok(!/—/.test(notice), 'no em dashes in user-facing copy');
});

test('the API’s placeholder name is not a name', () => {
  // GET /teams/workspaces sends `from_name: names.get(key) || 'Workspace'`, so
  // an unnamed org arrived here as the literal string "Workspace" and rendered
  // "Workspace’s subscription is inactive."
  const unnamed = { from: 'org-acme', fromName: 'Workspace', to: null, reason: 'subscription_inactive' };
  assert.strictEqual(fallbackWorkspaceName(unnamed), null);
  assert.strictEqual(fallbackWorkspaceName({ ...unnamed, fromName: '  ' }), null);
  assert.strictEqual(fallbackWorkspaceName({ ...unnamed, fromName: 'Acme' }), 'Acme');
  assert.match(workspaceFallbackNotice(unnamed), /^Your team workspace’s subscription is inactive\./);
  assert.match(workspaceFallbackNotice(unnamed), /still refer to it\.$/);
  assert.strictEqual(fallbackWorkspaceLabel({ ...unnamed, fromName: '  ' }), 'Your team workspace');
});

test('a reason that is not a lapsed card is not described as one', () => {
  // enforcementService answers lockdown_active, subscription_inactive and
  // decision_limit_exceeded down this path. All three were rendered as
  // "subscription is inactive", which sends a locked workspace's owner to a
  // billing page that will not unlock it.
  const at = (reason: string) => ({ from: 'org-acme', fromName: 'Acme', to: 'org-sam', reason });
  assert.strictEqual(fallbackReasonSentence(at('subscription_inactive')), 'Acme’s subscription is inactive.');
  assert.strictEqual(fallbackReasonSentence(at('lockdown_active')), 'Acme is locked.');
  assert.strictEqual(fallbackReasonSentence(at('decision_limit_exceeded')), 'Acme has reached its plan limit.');
  // Unknown reasons say the one thing that is true of all of them.
  assert.strictEqual(fallbackReasonSentence(at('some_future_reason')), 'Acme is not available right now.');
  assert.match(workspaceFallbackNotice(at('lockdown_active')), /^Acme is locked\./);
  assert.ok(!/subscription/.test(workspaceFallbackNotice(at('lockdown_active'))));
  assert.strictEqual(fallbackShortReason(at('lockdown_active')), 'locked');
  assert.strictEqual(fallbackShortReason(at('subscription_inactive')), 'subscription inactive');
  assert.strictEqual(fallbackShortReason(at('some_future_reason')), 'not available');
});

test('only an owner of the lapsed workspace is offered the billing link', () => {
  const listing = { active: 'org-acme', workspaces: [TEAM, MINE] };
  const fallback = { from: 'org-acme', fromName: 'Acme', to: 'org-sam', reason: 'subscription_inactive' };
  assert.strictEqual(mayFixFallbackBilling(listing, fallback), false, 'a member cannot fix the bill');
  assert.strictEqual(
    mayFixFallbackBilling({ active: 'org-acme', workspaces: [{ ...TEAM, role: 'owner' }, MINE] }, fallback),
    true,
  );
  assert.strictEqual(mayFixFallbackBilling(null, fallback), false);
});

test('a refused write is recognised from the 409 body, not from the message', () => {
  assert.strictEqual(
    isWorkspaceInactiveError({ status: 409, data: { error: 'workspace_inactive', message: 'Acme’s subscription is inactive.' } }),
    true,
  );
  // The code field is the other shape the client may fill in.
  assert.strictEqual(isWorkspaceInactiveError({ status: 409, code: 'workspace_inactive' }), true);
  // Everything else keeps its own wording. A 409 is also how a role conflict
  // answers, so the status alone must not be the test.
  assert.strictEqual(isWorkspaceInactiveError({ status: 409, data: { error: 'last_owner' } }), false);
  assert.strictEqual(isWorkspaceInactiveError({ status: 403, data: { error: 'workspace_inactive' } }), false);
  assert.strictEqual(isWorkspaceInactiveError(new Error('workspace_inactive')), false);
  assert.strictEqual(isWorkspaceInactiveError(null), false);
});

test('the refusal shows the server’s sentence VERBATIM and promises nothing was written', () => {
  // The prefix used to be "Not saved: " and the server's first letter was
  // lowercased to read on from the colon — which renamed the workspace:
  // "Not saved: acme Robotics’s subscription is inactive". Server text is not
  // ours to recase, so the prefix is its own sentence.
  const msg = workspaceInactiveMessage({
    status: 409,
    data: { error: 'workspace_inactive', message: 'Acme Robotics’s subscription is inactive, so nothing was changed.' },
  });
  assert.match(String(msg), /^Not saved\. /);
  assert.ok(String(msg).includes('Acme Robotics’s subscription is inactive'), 'the workspace keeps its name');
  assert.ok(!/acme Robotics/.test(String(msg)));
  // A body with no sentence still has to say the one thing the caller cannot know.
  assert.match(
    String(workspaceInactiveMessage({ status: 409, data: { error: 'workspace_inactive' } })),
    /nothing was written/,
  );
  assert.strictEqual(workspaceInactiveMessage({ status: 500 }), null, 'a real failure keeps its own wording');
});

test('a FRESH listing that reports no fallback clears one recorded earlier', () => {
  // THE OWNER PAID. The listing is recomputed for this read and says
  // `fallback: null`; the response header recorded earlier in this tab still
  // names the team and nothing ever cleared it, so the banner and the switcher
  // stayed false while writes were landing in the team again.
  const listing = { active: 'org-acme', workspaces: [TEAM, MINE], fallback: null };
  assert.strictEqual(listingReportsNoFallback(listing), true);
  const served = servedWorkspace(listing, 'org-acme');
  assert.strictEqual(served.fallback, null, 'an explicit null outranks a stale header');
  assert.strictEqual(served.served, 'org-acme', 'the team is serving again');
});

test('an API that omits the field entirely keeps the header-based behaviour', () => {
  // undefined is not null: an older API carries no `fallback` field at all, and
  // reading its silence as "no fallback" would delete the only signal it has.
  const listing = { active: 'org-acme', workspaces: [TEAM, MINE] };
  assert.strictEqual(listingReportsNoFallback(listing), false);
  assert.strictEqual(servedWorkspace(listing, 'org-acme').fallback?.from, 'org-acme');
  assert.strictEqual(listingReportsNoFallback(null), false);
});

test('a credential is minted against the BOUND workspace, never the served one', () => {
  // /api/v1/keys is exempt from plan enforcement, so the fallback never rebinds
  // it: the key is minted against the lapsed TEAM while every ordinary read on
  // the page is answered by the reader's own workspace. The key panel read
  // `servedWorkspace` and promised the personal workspace.
  const listing = {
    active: 'org-acme',
    workspaces: [TEAM, MINE],
    fallback: { from: 'org-acme', from_name: 'Acme', to: 'org-sam', reason: 'subscription_inactive' },
  };
  const served = servedWorkspace(listing, 'org-acme');
  const credential = credentialWorkspace(listing, 'org-acme');
  assert.strictEqual(served.served, 'org-sam', 'reads are personal');
  assert.strictEqual(credential.workspace, 'org-acme', 'the key is not');
  assert.notStrictEqual(credential.workspace, served.served, 'the two questions have different answers');
  assert.strictEqual(credential.name, 'Acme');
  assert.strictEqual(credential.personal, false);
  assert.strictEqual(credential.role, 'member');
  assert.strictEqual(credential.inactive?.from, 'org-acme');
  assert.match(
    credentialWorkspaceWarning(credential.inactive!),
    /^Acme’s subscription is inactive, so a key created now would belong to Acme and will not work until it is active again\.$/,
  );
});

test('with no fallback the credential workspace is simply the active one', () => {
  const credential = credentialWorkspace({ active: 'org-sam', workspaces: [TEAM, MINE] }, null);
  assert.strictEqual(credential.workspace, 'org-sam');
  assert.strictEqual(credential.personal, true);
  assert.strictEqual(credential.role, 'owner');
  assert.strictEqual(credential.inactive, null);
  assert.deepStrictEqual(credentialWorkspace(null).inactive, null);
  assert.strictEqual(credentialWorkspace(null).workspace, null);
});

test('a fallback about some OTHER workspace does not warn on the key panel', () => {
  // The header is a fact about one request. If it names a workspace this
  // listing is not bound to, the key being minted is not the one in question.
  const credential = credentialWorkspace({ active: 'org-sam', workspaces: [TEAM, MINE] }, 'org-acme');
  assert.strictEqual(credential.workspace, 'org-sam');
  assert.strictEqual(credential.inactive, null);
});

test('an unnamed lapsed workspace still gets a readable key warning', () => {
  const warning = credentialWorkspaceWarning({ from: 'org-acme', fromName: 'Workspace', to: null, reason: 'lockdown_active' });
  assert.strictEqual(warning, 'Your team workspace is locked. A key created now would belong to it and will not work until it is available again.');
  assert.ok(!/—/.test(warning), 'no em dashes in user-facing copy');
});
