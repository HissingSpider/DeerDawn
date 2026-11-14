'use strict';

/**
 * "recorded: true" OVER A NOTE THAT DELETED ANOTHER ONE.
 *
 * debuggingNoteKey deliberately collapses notes that differ only by a date or a
 * counter — that is what stops a scheduled agent's hourly run-log evicting every
 * real finding (see packages/shared-context/tests/debugging-note-dedupe.test.js).
 * Collapsing is correct. Not SAYING SO is not: the caller filed a finding, was
 * told it was recorded, and a note it never asked about is gone.
 *
 * Wave 1 narrowed the key, so collisions are rarer. They are still by design.
 *
 * Built from a pre/post comparison of the stored notes, never from the request —
 * the request cannot know what it collided with.
 *
 * DB-backed; run via scripts/run-db-test.sh node --test tests/unit/record-finding-replacement.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const service = require('../../src/services/contextSyncService');
const workspace = require('../../src/services/workspaceService');
const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');

const RUN = crypto.randomBytes(4).toString('hex');
const ORG = `org-${crypto.randomUUID()}`;
const USER = `user-finding-${RUN}`;
const actor = () => ({ org_id: ORG, id: USER, scopes: ['context:read', 'context:write'] });

let project;
const record = (input) => service.recordDebugFinding(actor(), project.project_id, input);

test.before(async () => {
  await workspace.addMember(ORG, USER, { role: 'owner' });
  project = await service.createProject(actor(), { project_name: `Findings ${RUN}` });
});

test.after(async () => {
  await db.query('DELETE FROM context_sessions WHERE owner_key = $1', [ORG], 'org-system').catch(() => {});
  await db.query('DELETE FROM context_projects WHERE owner_key = $1', [ORG], 'org-system').catch(() => {});
  await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [ORG], 'org-system').catch(() => {});
  await closeRedisConnections().catch(() => {});
});

test('a finding that collides with nothing reports no replacement', async () => {
  const result = await record({
    summary: 'The consent redirect drops the code query parameter',
    paths: ['apps/marketing/src/pages/mcp-auth.tsx'],
  });
  assert.equal(result.replaced, null, 'nothing was there to replace');
});

test('a finding that replaced an earlier note says which one', async () => {
  const first = 'Growth run 2026-09-19 08:00 finished: 3 signups, nothing to act on';
  const second = 'Growth run 2026-09-20 08:00 finished: 5 signups, nothing to act on';
  await record({ summary: first, added_at: '2026-09-19T08:00:00.000Z' });
  const result = await record({ summary: second, added_at: '2026-09-20T08:00:00.000Z' });

  const stored = (await service.getProject(actor(), project.project_id)).context.debugging_notes
    .map((note) => note.summary);
  assert.ok(stored.includes(second), 'the new note is what the log holds');
  assert.ok(!stored.includes(first), 'the earlier copy really is gone');

  assert.equal(
    result.replaced,
    first,
    'THE BUG: the reply said recorded and never mentioned the note this write deleted',
  );
});

test('an explicit supersede is not reported as a surprise replacement', async () => {
  // The caller asked for the removal, so it is not news.
  await record({ summary: `The scheduler lock is advisory and per connection ${RUN}` });
  const result = await record({
    summary: `The scheduler lock is per transaction, not per connection ${RUN}`,
    supersedes: 'advisory and per connection',
  });
  assert.equal(result.replaced, null);
  assert.deepEqual(result.evicted, []);
});

// The OTHER way a note disappears behind "recorded": the log is full. Nothing
// collided — the cap simply had to give a slot back — and the note that went
// has nothing to do with the one just filed.
test('an eviction at the cap is reported, and names the note that went', async () => {
  const evictProject = await service.createProject(actor(), { project_name: `Eviction ${RUN}` });
  const fill = (input) => service.recordDebugFinding(actor(), evictProject.project_id, input);
  for (let i = 0; i < 30; i++) {
    await fill({
      summary: `Finding ${String.fromCharCode(97 + i)}: the ${String.fromCharCode(97 + i)} subsystem loses its lease under contention`,
      added_at: new Date(Date.parse('2026-09-01T00:00:00.000Z') + i * 3600e3).toISOString(),
    });
  }
  const result = await fill({
    summary: 'A thirty first finding, sharing no wording with any of the others',
    added_at: '2026-09-03T00:00:00.000Z',
  });
  assert.equal(result.replaced, null, 'nothing collided; the log was simply full');
  assert.deepEqual(
    result.evicted,
    ['Finding a: the a subsystem loses its lease under contention'],
    'THE BUG: the reply said recorded and never mentioned the note the cap dropped',
  );
  assert.equal(result.debugging_notes.length, 30);
});
