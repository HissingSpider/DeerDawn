// The workspace_forbidden screen used to offer Retry and nothing else. For the
// legacy member whose home org IS the team, Retry is a button that cannot
// succeed: the API client already dropped the stored workspace, and the account
// default resolves to the same forbidden key. These pin that the screen now
// ends somewhere.
import test from 'node:test';
import assert from 'node:assert';

import { planForbiddenWorkspaceExit, forbiddenWorkspaceCopy } from './workspaceRecovery';

const ws = (workspace: string, personal = false) => ({
  workspace,
  name: workspace,
  role: 'member' as const,
  personal,
});

test('a member of another workspace is offered the switch', () => {
  const exit = planForbiddenWorkspaceExit({
    active: 'org-team',
    workspaces: [ws('org-team', true), ws('org-other')],
  });
  assert.strictEqual(exit.kind, 'switch');
  assert.deepStrictEqual(
    exit.kind === 'switch' ? exit.options.map((o) => o.workspace) : [],
    ['org-other'],
    'the workspace that just refused us is never offered as the way out of it'
  );
  assert.strictEqual(forbiddenWorkspaceCopy(exit).actionLabel, 'Switch workspace');
});

test('the legacy member whose home org IS the team gets a sign-out, not a retry', () => {
  // personal and active are the SAME row — that is the whole defect.
  const exit = planForbiddenWorkspaceExit({
    active: 'org-team',
    workspaces: [ws('org-team', true)],
  });
  assert.deepStrictEqual(exit, { kind: 'sign_out', reason: 'home_org_is_forbidden' });
  const copy = forbiddenWorkspaceCopy(exit);
  assert.strictEqual(copy.actionLabel, 'Sign out');
  assert.match(copy.description, /Retrying cannot fix that/, 'the screen says why Retry is not the answer');
});

test('a workspace listing we could not fetch is its own state, and still ends somewhere', () => {
  const exit = planForbiddenWorkspaceExit(null);
  assert.deepStrictEqual(exit, { kind: 'sign_out', reason: 'lookup_failed' });
  assert.strictEqual(forbiddenWorkspaceCopy(exit).actionLabel, 'Sign out');
});

test('an empty or malformed listing never proposes the forbidden workspace', () => {
  assert.deepStrictEqual(
    planForbiddenWorkspaceExit({ active: 'org-team', workspaces: [] }),
    { kind: 'sign_out', reason: 'home_org_is_forbidden' }
  );
  // A non-personal entry that still IS the active (forbidden) one is not an exit.
  assert.deepStrictEqual(
    planForbiddenWorkspaceExit({ active: 'org-team', workspaces: [ws('org-team')] }),
    { kind: 'sign_out', reason: 'home_org_is_forbidden' }
  );
  assert.deepStrictEqual(
    planForbiddenWorkspaceExit({ active: 'org-team' } as never),
    { kind: 'sign_out', reason: 'lookup_failed' }
  );
});
