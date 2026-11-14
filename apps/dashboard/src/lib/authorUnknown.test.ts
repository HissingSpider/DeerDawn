import test from 'node:test';
import assert from 'node:assert';
import { assignableMembers, unknownAuthorIds } from './authorUnknown';
import type { ProjectSharing, TeamMember } from './api';

const row = (project_id: string, extra: Partial<ProjectSharing> = {}) =>
  ({ project_id, project_name: project_id, visibility: 'private', owner_user_id: null, updated_at: '', ...extra }) as ProjectSharing;

test('only projects the server marked author_unknown are flagged, and a member who is sent none sees none', () => {
  const ids = unknownAuthorIds([row('a', { author_unknown: true }), row('b'), row('c', { author_unknown: false })]);
  assert.deepStrictEqual([...ids], ['a']);
  assert.strictEqual(unknownAuthorIds(undefined).size, 0);
  assert.strictEqual(unknownAuthorIds([row('x')]).size, 0);
});

test('an owner may pick an active owner or member, themselves included, and nobody who has left or who is a viewer', () => {
  const member = (id: string, extra: Partial<TeamMember> = {}): TeamMember =>
    ({ id, email: `${id}@x.test`, role: 'member', status: 'active', removed_at: null, created_at: '', ...extra });
  const picks = assignableMembers([
    member('owner', { role: 'owner' }),
    member('lee'),
    member('vic', { role: 'viewer' }),
    member('gone', { status: 'removed', removed_at: '2026-09-01T00:00:00Z' }),
  ]);
  assert.deepStrictEqual(picks.map((m) => m.id), ['owner', 'lee']);
  assert.deepStrictEqual(assignableMembers(null), []);
});
