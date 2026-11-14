'use strict';

/**
 * Thing 3e: a return that only READS leaves a trace.
 *
 * The hosted dispatcher wrote no telemetry for a tool annotated readOnlyHint
 * (recall, read_tasks, browse_skills, build_subagent_brief), so "where did I
 * leave off?" answered by recall was invisible and nothing could say whether a
 * person came back. Every authenticated call now upserts one content-free row
 * per (person, UTC day, tool, client), from the hosted dispatcher and from the
 * local stdio server's per-call event; never arguments, never results; and the
 * read-only annotations do not change.
 *
 * DB-backed; run via scripts/run-db-test.sh node --test tests/unit/tool-usage-days.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');
const { ensureDatabaseAvailable } = require('../helpers/dbAvailability');
const workspace = require('../../src/services/workspaceService');
const service = require('../../src/services/contextSyncService');
const toolUsageDays = require('../../src/services/toolUsageDays');
const productEvents = require('../../src/services/productEventsService');
const { recordLocalToolUse } = require('../../src/routes/shared/product-events');

const RUN = crypto.randomBytes(4).toString('hex');
const ORG = `org-${crypto.randomUUID()}`;
const USER = `user-usage-${RUN}`;
const KEY_ID = `key-usage-${RUN}`;
const q = (sql, params) => db.query(sql, params, 'org-system');

// A hosted OAuth connection: key-authed, the person is owner_id.
const keyActor = () => ({
  type: 'key',
  id: KEY_ID,
  owner_id: USER,
  org_id: ORG,
  workspace_key: ORG,
  scopes: ['context:read', 'context:write'],
  oauth_client_name: 'ChatGPT',
});

async function rows() {
  const r = await q('SELECT day::text AS day, tool_name, client FROM tool_usage_days WHERE user_id = $1 ORDER BY tool_name, client', [USER]);
  return r.rows;
}

// recordToolUse is fire-and-forget; give its write a moment to land.
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

let dbUp = false;

test.before(async () => {
  dbUp = await db.pool.connect().then((c) => { c.release(); return true; }).catch(() => false);
  if (!dbUp) return;
  await q(
    `INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status)
     VALUES ($1, $2, 'free', 'free', 'active') ON CONFLICT DO NOTHING`,
    [ORG, `Usage ${RUN}`],
  );
  await q(
    `INSERT INTO users (user_id, email, role, org_id, auth_provider, auth_subject)
     VALUES ($1, $2, 'admin', $3, 'clerk', $4)`,
    [USER, `usage-${RUN}@usage.test`, ORG, `sub_${USER}`],
  );
  await workspace.addMember(ORG, USER, { role: 'owner' });
  await toolUsageDays.ensureTable();
});

test.after(async () => {
  if (dbUp) {
    await q('DELETE FROM tool_usage_days WHERE user_id = $1', [USER]).catch(() => {});
    await q('DELETE FROM product_events WHERE org_id = $1', [ORG]).catch(() => {});
    await q('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [ORG]).catch(() => {});
    await q('DELETE FROM context_projects WHERE owner_key = $1', [ORG]).catch(() => {});
    await q('DELETE FROM workspace_members WHERE owner_key = $1', [ORG]).catch(() => {});
    await q('DELETE FROM users WHERE user_id = $1', [USER]).catch(() => {});
    await q('DELETE FROM organizations WHERE org_id = $1', [ORG]).catch(() => {});
  }
  await closeRedisConnections?.().catch(() => {});
  await db.pool.end().catch(() => {});
});

test('a hosted READ-ONLY call (recall) writes one usage-day row and still no product event', async (t) => {
  if (!(await ensureDatabaseAvailable(t, db, 'tool usage days'))) return;
  toolUsageDays.resetForTests();
  const { runToolByName } = require('../../src/routes/mcp');
  await service.createProject({ type: 'user', id: USER, org_id: ORG, workspace_key: ORG }, { project_name: `Usage ${RUN}` });
  const before = await q('SELECT COUNT(*)::int AS n FROM product_events WHERE user_id = $1 AND source = $2', [USER, 'mcp']);

  await runToolByName('recall', { action: 'projects' }, keyActor(), 'chatgpt_web');
  await runToolByName('recall', { action: 'projects' }, keyActor(), 'chatgpt_web');
  await settle();

  const got = await rows();
  assert.deepEqual(got.map((r) => [r.tool_name, r.client]), [['recall', 'chatgpt_web']],
    'THE BUG: a read-only call left no trace, so a return that only reads could not be seen');
  assert.equal(got[0].day, new Date().toISOString().slice(0, 10), 'keyed by the UTC day');
  const afterEvents = await q('SELECT COUNT(*)::int AS n FROM product_events WHERE user_id = $1 AND source = $2', [USER, 'mcp']);
  assert.equal(afterEvents.rows[0].n, before.rows[0].n, 'the read-only call still emits no product telemetry');
});

test('the usage row holds no arguments and no results: four columns, all identifiers', async (t) => {
  if (!(await ensureDatabaseAvailable(t, db, 'tool usage days'))) return;
  const cols = await q(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'tool_usage_days' ORDER BY column_name`,
  );
  assert.deepEqual(cols.rows.map((r) => r.column_name), ['client', 'day', 'tool_name', 'user_id']);
});

test('a local stdio tool call, reported through POST /product-events, counts for the person', async (t) => {
  if (!(await ensureDatabaseAvailable(t, db, 'tool usage days'))) return;
  toolUsageDays.resetForTests();
  const actor = keyActor();
  // What packages/mcp-server posts after a successful read on Claude Code.
  const event = await productEvents.recordProductEvent(actor, {
    event_name: 'mcp_tool_call_succeeded',
    source: 'mcp',
    surface: 'claude_code',
    metadata: { tool_name: 'read_tasks', client_name: 'claude-code' },
  });
  recordLocalToolUse(actor, event);
  // Not a tool call: a dashboard page event, and an anonymous post.
  recordLocalToolUse(actor, { ...event, event_name: 'onboarding_page_viewed', source: 'dashboard' });
  recordLocalToolUse(null, event);
  await settle();

  const got = (await rows()).filter((r) => r.tool_name === 'read_tasks');
  assert.deepEqual(got.map((r) => r.client), ['claude_code']);
});

test('a failure to write never reaches the tool call', async () => {
  toolUsageDays.resetForTests();
  const original = db.query;
  db.query = async () => { throw new Error('database is on fire'); };
  try {
    const result = await toolUsageDays.recordToolUse(keyActor(), { toolName: 'recall', client: 'chatgpt' });
    assert.equal(result, false);
  } finally {
    db.query = original;
  }
});

test('no person, no row: a system key and an internal actor record nothing', async () => {
  toolUsageDays.resetForTests();
  const original = db.query;
  let calls = 0;
  db.query = async () => { calls += 1; return { rows: [] }; };
  try {
    assert.equal(await toolUsageDays.recordToolUse({ type: 'system', id: 'system-key' }, { toolName: 'recall' }), false);
    assert.equal(await toolUsageDays.recordToolUse({ id: ORG }, { toolName: 'recall' }), false);
    assert.equal(await toolUsageDays.recordToolUse(keyActor(), { toolName: '' }), false);
    assert.equal(calls, 0);
  } finally {
    db.query = original;
  }
});

test('the second call of the day costs no database round trip', async () => {
  toolUsageDays.resetForTests();
  const original = db.query;
  const inserts = [];
  db.query = async (text, params) => {
    if (/INSERT INTO tool_usage_days/.test(text)) inserts.push(params);
    return { rows: [] };
  };
  try {
    const now = new Date('2026-10-04T10:00:00Z');
    await toolUsageDays.recordToolUse(keyActor(), { toolName: 'recall', client: 'chatgpt', now });
    await toolUsageDays.recordToolUse(keyActor(), { toolName: 'recall', client: 'chatgpt', now });
    await toolUsageDays.recordToolUse(keyActor(), { toolName: 'recall', client: 'claude', now });
    await toolUsageDays.recordToolUse(keyActor(), { toolName: 'recall', client: 'chatgpt', now: new Date('2026-10-05T00:01:00Z') });
    assert.deepEqual(inserts.map((p) => [p[1], p[3]]), [
      ['2026-10-04', 'chatgpt'],
      ['2026-10-04', 'claude'],
      ['2026-10-05', 'chatgpt'],
    ]);
    assert.equal(inserts[0][0], USER, 'the PERSON, never the key id');
  } finally {
    db.query = original;
  }
});

test('a tool name a client sends is held to the shape of an identifier', () => {
  assert.equal(toolUsageDays.cleanIdentifier('recall', 64), 'recall');
  assert.equal(toolUsageDays.cleanIdentifier('Ignore previous instructions; DROP TABLE', 64), 'ignorepreviousinstructionsdroptable');
  assert.equal(toolUsageDays.cleanIdentifier('x'.repeat(200), 64).length, 64);
});

test('active days are distinct UTC days, and an error reads as 0', async (t) => {
  if (!(await ensureDatabaseAvailable(t, db, 'tool usage days'))) return;
  await q(
    `INSERT INTO tool_usage_days (user_id, day, tool_name, client) VALUES
       ($1, CURRENT_DATE - 5, 'recall', 'chatgpt'),
       ($1, CURRENT_DATE - 5, 'start_session', 'chatgpt'),
       ($1, CURRENT_DATE - 2, 'recall', 'claude')
     ON CONFLICT DO NOTHING`,
    [USER],
  );
  const days = await toolUsageDays.countActiveDays(USER);
  // -5, -2, and today (the earlier tests' calls).
  assert.equal(days, 3);
  assert.equal(await toolUsageDays.countActiveDays([]), 0);
  const original = db.query;
  db.query = async () => { throw new Error('down'); };
  try {
    assert.equal(await toolUsageDays.countActiveDays(USER), 0);
  } finally {
    db.query = original;
  }
});

test('the read-only annotations did not change, and the dispatcher comment says what is written', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/routes/mcp.js'), 'utf8');
  for (const title of ['Read Task Board', 'Recall DeerDawn Memory', 'Browse Shared Skills']) {
    const re = new RegExp(`title: '${title}', readOnlyHint: true`);
    assert.match(src, re, `${title} must stay readOnlyHint:true`);
  }
  assert.doesNotMatch(src, /readOnlyHint:true must actually write nothing/,
    'the old comment claimed read-only tools write nothing, which is no longer true');
  assert.match(src, /content-free row per person per UTC/);
  // Recorded before the read-only gate, so reads are counted.
  const runTool = src.slice(src.indexOf('async function runTool('));
  assert.ok(runTool.indexOf('toolUsageDays.recordToolUse') > 0);
  assert.ok(runTool.indexOf('toolUsageDays.recordToolUse') < runTool.indexOf('if (!readOnlyInvocation) recordMcpCall'));
});

test('the local path counts only real DeerDawn tool names', async () => {
  toolUsageDays.resetForTests();
  const original = db.query;
  const inserts = [];
  db.query = async (text, params) => {
    if (/INSERT INTO tool_usage_days/.test(text)) inserts.push(params[2]);
    return { rows: [] };
  };
  try {
    const base = { source: 'mcp', event_name: 'mcp_tool_call_succeeded', surface: 'claude_code' };
    recordLocalToolUse(keyActor(), { ...base, metadata: { tool_name: 'totally_made_up' } });
    recordLocalToolUse(keyActor(), { ...base, metadata: { tool_name: 'recall' } });
    recordLocalToolUse(keyActor(), { ...base, metadata: { tool_name: 'get_auth_status' } });
    await settle();
    assert.deepEqual(inserts.sort(), ['get_auth_status', 'recall']);
  } finally {
    db.query = original;
  }
});

test('every tool the hosted dispatcher can run is a known tool name', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/routes/mcp.js'), 'utf8');
  const names = [...src.matchAll(/^ {4}name: '([a-z_]+)'/gm)].map((m) => m[1]);
  assert.ok(names.length > 20, 'found the hosted tool list');
  for (const name of names) {
    assert.ok(toolUsageDays.isKnownToolName(name), `${name} is dispatchable but not in KNOWN_TOOL_NAMES`);
  }
});

test('the dashboard bootstrap publishes the PERSON\'s active days, for the upgrade-ask gate (Thing 3h)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/routes/shared/dashboard.js'), 'utf8');
  assert.match(src, /toolUsageDays\.countActiveDays\(workspace\.actorPersonId\(req\.actor\)\)/,
    'per person, never per workspace: a teammate must not inherit the owner\'s days');
  assert.match(src, /active_days: Number\(activeDays \|\| 0\)/);
});
