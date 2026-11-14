/**
 * JOURNEY R5 (BLOCKED 26): the Memory page's "Paste text" and "From file" tabs.
 *
 * "Add context" on the dashboard's Memory page has three tabs. From AI sends
 * `source: 'claude_export'`. Paste text and From file send `source:
 * 'file_import'`, and /seed's request schema did not list it, so both tabs got
 * a 400 (`invalid_payload`, "expected one of chatgpt_export|claude_export|paste|
 * manual") and nothing was saved: two of three tabs never completed.
 *
 * The bodies below are exactly what AddFromClaudeModal builds (its
 * parseProjects, now lib/addContextPayload.ts): text with no numbered headers
 * goes as one project named "Imported context"; text with numbered headers
 * goes as one project per header, named after it.
 *
 * Accepting the source must not change what an import keeps. `source` is not
 * read after validation, so the round 4 rule holds for it as for every other:
 * with no model answering, nothing from the pasted text is saved and the reply
 * says the project was not processed.
 *
 *   bash scripts/run-db-test.sh node --test tests/integration/journey-r5-import-file-source.test.js
 */

process.env.NODE_ENV = 'test';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { hashPassword, generateApiKey } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const store = require('../../src/store/contextSyncStore');

const q = (sql, params) => db.query(sql, params, 'org-system');
const token = () => [...crypto.randomBytes(14)].map((b) => String.fromCharCode(65 + (b % 26))).join('');
const TAG = uuidv4().slice(0, 8);

async function makePerson(label) {
  const orgId = `org-${uuidv4()}`;
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status) VALUES ($1, $2, $3, $4, $5)',
    [orgId, `${label} workspace`, 'free', 'free', 'active'],
  );
  const userId = `user-${uuidv4()}`;
  await q(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, `${label}-${uuidv4().slice(0, 8)}@e2e.test`, await hashPassword('password123'), 'admin', orgId],
  );
  await workspace.ensureOwnerMembership(orgId, userId);
  const { key, prefix, hash } = generateApiKey();
  await q(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, 'k', userId, orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
  );
  return { orgId, key };
}

const seed = (key, body) => request(httpServer).post('/api/v1/context/seed').set('X-Api-Key', key).send(body);

async function withoutModelKeys(run) {
  const saved = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    return await run();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// A model is configured and every call to it is answered here: no request
// leaves the machine. `answerFor` gets the prompt so a multi-project import can
// answer each project from its own words.
async function withModel(answerFor, run) {
  const axios = require('axios');
  const original = axios.post;
  const saved = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  process.env.OPENAI_API_KEY = 'test-not-a-key';
  process.env.ANTHROPIC_API_KEY = 'test-not-a-key';
  axios.post = async (_url, body) => {
    const prompt = JSON.stringify(body);
    const answer = answerFor(prompt);
    return { data: { choices: [{ message: { content: JSON.stringify(answer) } }], content: [{ text: JSON.stringify(answer) }] } };
  };
  try {
    return await run();
  } finally {
    axios.post = original;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const modelAnswer = (description) => ({
  match_decision: 'new_project', confidence: 0.9,
  delta: { description },
  should_create_project: true, needs_user_confirmation: false, no_material_change: false,
});

// What "Paste text" / "From file" send for a document with no numbered headers.
const oneBlockBody = (text) => ({
  source: 'file_import',
  projects: [{ name: 'Imported context', conversations: [{ messages: [{ role: 'user', text }] }] }],
});

// What they send for a CLAUDE.md-style document with numbered headers: one
// project per header, named from it (Title Case, punctuation dropped).
const sectionsBody = (a, b) => ({
  source: 'file_import',
  projects: [
    { name: `Harbor Ledger ${TAG}`, conversations: [{ messages: [{ role: 'user', text: a }] }] },
    { name: `Tide Tables ${TAG}`, conversations: [{ messages: [{ role: 'user', text: b }] }] },
  ],
});

let P;
test.before(async () => { P = await makePerson('r5import'); });

const projectNamed = async (name) =>
  (await q('SELECT project_id FROM context_projects WHERE owner_key = $1 AND project_name = $2', [P.orgId, name])).rows[0]?.project_id || null;

test('Paste text: a document sent as source file_import is accepted, and the model-processed project lands', async () => {
  const description = `Service that flags vessels which cannot clear the channel ${TAG}`;
  const text = 'CLAUDE.md for the berth planner. The planner reads the tide tables every morning and warns the harbour master when a vessel draft will not clear the channel at low water. Stack: Node, Postgres.';
  const res = await withModel(() => modelAnswer(description), () => seed(P.key, oneBlockBody(text)));
  assert.equal(res.status, 200, `/seed refused what the Paste text tab sends: ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(res.body.projects_created, 1, JSON.stringify(res.body));
  assert.deepEqual(res.body.errors, []);
  const projectId = await projectNamed('Imported context');
  assert.ok(projectId, 'the saved context lands in a project');
  assert.equal((await store.getProject(P.orgId, projectId)).context?.description, description);
});

test('From file: a CLAUDE.md with numbered headers, sent as file_import, lands one project per section', async () => {
  const a = 'Harbor Ledger\n' + 'A ledger service for harbour fees. It bills each berth by the hour and closes the day at midnight local time, with a report for the harbour master.';
  const b = 'Tide Tables\n' + 'A parser for the harbour tide tables feed. It stores a week of high and low water and skips the header rows the feed sometimes repeats in the middle of a file.';
  const res = await withModel(
    (prompt) => modelAnswer(prompt.includes('ledger service') ? `Fees ledger ${TAG}` : `Tide feed parser ${TAG}`),
    () => seed(P.key, sectionsBody(a, b)),
  );
  assert.equal(res.status, 200, `/seed refused what the From file tab sends: ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(res.body.projects_created, 2, JSON.stringify(res.body));
  const ledger = await projectNamed(`Harbor Ledger ${TAG}`);
  const tide = await projectNamed(`Tide Tables ${TAG}`);
  assert.ok(ledger && tide, 'each section is its own project');
  assert.equal((await store.getProject(P.orgId, ledger)).context?.description, `Fees ledger ${TAG}`);
  assert.equal((await store.getProject(P.orgId, tide)).context?.description, `Tide feed parser ${TAG}`);
});

test('a file_import with no model answering saves nothing from the text and says it was not processed (the round 4 rule holds)', async () => {
  const marker = `QZDOC${token()}`;
  const name = `Kept Empty ${TAG}`;
  const res = await withoutModelKeys(() => seed(P.key, {
    source: 'file_import',
    projects: [{ name, conversations: [{ messages: [{ role: 'user', text: `Notes on the pier project: ${marker} is the only thing we know so far about the new berth, and the harbour master wants a summary before the first pilot boards.` }] }] }],
  }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.projects_created, 0, `a refused import must not count as created: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.projects_not_processed, 1, JSON.stringify(res.body));
  const projectId = await projectNamed(name);
  assert.deepEqual(res.body.not_processed, [{ project: name, project_id: projectId }]);
  assert.ok(!JSON.stringify(res.body).includes(marker), 'the reply relays the pasted text');
  const brief = JSON.stringify((await store.getProject(P.orgId, projectId))?.context || {});
  assert.ok(!brief.includes(marker), `the brief carries the pasted text: ${brief}`);
  const rows = (await q('SELECT count(*)::int AS n FROM context_graph_evidence WHERE owner_key = $1 AND excerpt LIKE $2', [P.orgId, `%${marker}%`])).rows[0].n;
  assert.equal(rows, 0, 'no evidence row holds the pasted text');
});

test('a source /seed does not know is still refused', async () => {
  const res = await seed(P.key, { ...oneBlockBody('x'.repeat(120)), source: 'carrier_pigeon' });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.error, 'invalid_payload');
});
