'use strict';

/**
 * A hosted write is evidence that this person is here NOW.
 *
 * Only one hosted tool refreshed the session's last_seen_at: update_context,
 * and only when it carried a summary (that path runs applyExtraction, which
 * upserts the session on its way through). Every other write — manage_tasks,
 * record_finding, record_paths — left the row untouched, so routing kept
 * reading a last_seen_at from an earlier sitting. That is what let the
 * "created since you were last seen" rule stay true indefinitely and hand
 * id-less writes to a project the caller made for later.
 *
 * The binding itself is deliberately NOT changed here: this says "still here",
 * not "working somewhere else". touchSession leaves project_id alone when it is
 * passed null (COALESCE).
 *
 * DB-backed; run via scripts/run-db-test.sh node --test tests/unit/hosted-session-liveness.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const service = require('../../src/services/contextSyncService');
const workspace = require('../../src/services/workspaceService');
const db = require('../../src/config/db');
const { hostedSessionId } = require('../../src/services/hostedSessionIdentity');
const { runToolByName } = require('../../src/routes/mcp');
const { closeRedisConnections } = require('../../src/config/redis');

const RUN = crypto.randomBytes(4).toString('hex');
const ORG = `org-${crypto.randomUUID()}`;
const USER = `user-liveness-${RUN}`;
const actor = () => ({ org_id: ORG, id: USER, scopes: ['context:read', 'context:write'] });

let project;
let sessionId;

async function sessionRow() {
  const result = await db.query(
    'SELECT project_id, last_seen_at FROM context_sessions WHERE owner_key = $1 AND session_id = $2',
    [ORG, sessionId],
    'org-system'
  );
  return result.rows[0];
}

async function rewind() {
  await db.query(
    'UPDATE context_sessions SET last_seen_at = NOW() - INTERVAL \'1 hour\' WHERE owner_key = $1 AND session_id = $2',
    [ORG, sessionId],
    'org-system'
  );
}

const secondsSinceSeen = (row) => (Date.now() - new Date(row.last_seen_at).getTime()) / 1000;

test.before(async () => {
  await workspace.addMember(ORG, USER, { role: 'owner' });
  project = await service.createProject(actor(), { project_name: `Liveness ${RUN}` });
  sessionId = hostedSessionId(actor(), 'claude_web');
  await service.upsertSession(actor(), sessionId, {
    tool: 'claude_web',
    surface_type: 'browser',
    project_id: project.project_id,
    status: 'active',
  });
});

test.after(async () => {
  await db.query('DELETE FROM context_sessions WHERE owner_key = $1', [ORG], 'org-system').catch(() => {});
  await db.query('DELETE FROM context_projects WHERE owner_key = $1', [ORG], 'org-system').catch(() => {});
  await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [ORG], 'org-system').catch(() => {});
  await closeRedisConnections().catch(() => {});
});

test('adding a task card marks the hosted session as seen', async () => {
  await rewind();
  await runToolByName('manage_tasks', { action: 'add', todos: [`card ${RUN}`], project_id: project.project_id }, actor(), 'claude_web');
  const row = await sessionRow();
  assert.ok(secondsSinceSeen(row) < 60, `THE BUG: last_seen_at is still ${Math.round(secondsSinceSeen(row))}s old after a write`);
  assert.equal(row.project_id, project.project_id, 'a liveness refresh must not re-bind the session');
});

test('recording a finding marks the hosted session as seen', async () => {
  await rewind();
  await runToolByName('manage_memory', {
    action: 'record_finding',
    summary: `Liveness finding ${RUN}: the hosted write path did not refresh the session`,
    paths: [],
    project_id: project.project_id,
  }, actor(), 'claude_web');
  const row = await sessionRow();
  assert.ok(secondsSinceSeen(row) < 60, `THE BUG: last_seen_at is still ${Math.round(secondsSinceSeen(row))}s old after a write`);
});

test('start_session marks the hosted session as seen', async () => {
  await rewind();
  await runToolByName('start_session', {}, actor(), 'claude_web');
  const row = await sessionRow();
  assert.ok(secondsSinceSeen(row) < 60, `THE BUG: last_seen_at is still ${Math.round(secondsSinceSeen(row))}s old after start_session`);
});
