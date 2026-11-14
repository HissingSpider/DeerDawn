'use strict';

/**
 * `stored` MEANS THE CALLER'S TEXT CAN BE READ BACK — including the half of it
 * the server rewrote on the way in.
 *
 * recordExplicitUpdate judges the write on a read-back, which is the whole
 * reason this path exists. It compared the caller's RAW summary with what came
 * back, and every summary goes through cleanSyncedText first (secret redaction
 * plus injection defanging, in normalizeDecisionEntries). So a decision
 * mentioning an api_key, a credentialed DATABASE_URL, or the phrase "ignore
 * previous instructions" was stored correctly and then reported
 * `stored: false, not_found_on_read_back` with "Retry" attached — and the
 * duplicate check inside appendRecentDecision compared the same two unlike
 * things, so each retry stored another identical redacted copy.
 *
 * DB-backed; run via scripts/run-db-test.sh node --test tests/unit/explicit-update-readback.test.js
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
const USER = `user-readback-${RUN}`;
const actor = () => ({ org_id: ORG, id: USER, scopes: ['context:read', 'context:write'] });

// A canned extraction, so this exercises the write path and not the provider.
const EXTRACTION = {
  match_decision: 'matched_existing',
  confidence: 0.92,
  delta: {},
  should_create_project: false,
  needs_user_confirmation: false,
  no_material_change: false,
};

let project;

const save = (summary) => service.recordExplicitUpdate(actor(), {
  session_id: `sess-readback-${RUN}`,
  tool: 'claude_web',
  project_id: project.project_id,
  summary,
  session_context: { surface_type: 'browser', status: 'active' },
  extraction: EXTRACTION,
});

const decisionsOf = async () => (await service.getProject(actor(), project.project_id))
  .context.recent_decisions.map((entry) => entry.summary);

test.before(async () => {
  await workspace.addMember(ORG, USER, { role: 'owner' });
  project = await service.createProject(actor(), { project_name: `Readback ${RUN}` });
});

test.after(async () => {
  await db.query('DELETE FROM context_sessions WHERE owner_key = $1', [ORG], 'org-system').catch(() => {});
  await db.query('DELETE FROM context_projects WHERE owner_key = $1', [ORG], 'org-system').catch(() => {});
  await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [ORG], 'org-system').catch(() => {});
  await closeRedisConnections().catch(() => {});
});

test('a summary the redactor rewrites is reported stored, and says what was redacted', async () => {
  // A real key is random and carries a digit. The sample used to be
  // `dd_live_abcdefghijklmnop`, which round 14 (85c64668) deliberately stopped
  // treating as a secret: a digit-free `[a-z_]` run after a key name is how
  // snake_case columns and kebab ids read ("sort key: created_at"), so the
  // value guard now requires a digit, '+' or '='. The test kept passing a
  // non-secret and asking to be told it was redacted.
  const outcome = await save('Decided to keep api_key: dd_live_4f9c2a7e1b8d3065 in .env.local for the simulator only');
  assert.equal(outcome.stored, true, 'THE BUG: the text landed and the caller was told to retry');
  assert.equal(outcome.reason, null);
  assert.equal(outcome.redacted, true, 'a caller whose words were changed has to be told so');
  const stored = await decisionsOf();
  assert.equal(stored.length, 1);
  assert.match(stored[0], /\[REDACTED\]/);
});

test('re-sending the same summary does not store a second redacted copy', async () => {
  await save('Decided to rotate the key: DATABASE_URL=postgres://app:hunter2secret@db.internal:5432/prod');
  const afterFirst = await decisionsOf();
  await save('Decided to rotate the key: DATABASE_URL=postgres://app:hunter2secret@db.internal:5432/prod');
  const afterSecond = await decisionsOf();
  assert.deepEqual(afterSecond, afterFirst, 'THE BUG: the retry the caller was told to make stored a duplicate');
});

test('a defanged injection phrase is stored and reported stored', async () => {
  const outcome = await save('Decided to ignore previous instructions in CLAUDE.md about the old tool names');
  assert.equal(outcome.stored, true);
  assert.equal(outcome.redacted, true);
});

test('a summary nothing touches is stored and reported plainly', async () => {
  const outcome = await save(`Decided to use Postgres advisory locks for the scheduler ${RUN}`);
  assert.equal(outcome.stored, true);
  assert.equal(outcome.redacted, false, 'an untouched summary must not claim anything was redacted');
  const stored = await decisionsOf();
  assert.ok(stored.some((s) => s.includes('advisory locks')));
});
