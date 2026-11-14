// A 403 that names the workspace is not an expired session. Reading it as one
// signed a removed member out, Clerk bounced them back with the same session,
// and the loop had no exit.
import test from 'node:test';
import assert from 'node:assert';
import { ApiError } from './api';
import { getBootstrapErrorState } from '../components/dashboard/DashboardBootstrapProvider';

test('workspace_forbidden is its own state, never auth_expired', () => {
  const err = new ApiError(403, 'You are no longer a member of this workspace.', undefined, undefined, undefined, {
    error: 'workspace_forbidden',
  });
  const state = getBootstrapErrorState(err);
  assert.strictEqual(state?.code, 'workspace_forbidden');
});

test('a plain 403 still routes to sign-in', () => {
  assert.strictEqual(getBootstrapErrorState(new ApiError(403, 'nope'))?.code, 'auth_expired');
});

// Retry was the only action this state offered, and for the legacy member whose
// home org IS the team it is a button that cannot succeed: the stale workspace
// choice has already been dropped, so every retry re-asks the same refused
// default. The real actions live in WorkspaceForbiddenExit.
test('workspace_forbidden does not promise a retry that cannot succeed', () => {
  const err = new ApiError(403, 'You are no longer a member of this workspace.', undefined, undefined, undefined, {
    error: 'workspace_forbidden',
  });
  const state = getBootstrapErrorState(err);
  assert.notStrictEqual(state?.primaryLabel, 'Retry');
  assert.doesNotMatch(String(state?.description), /Retry/i);
});
