/**
 * SCAN 21 — RAW-JSON READS OF AN ENCRYPTED COLUMN.
 *
 * context_projects.context is stored as { _enc } whenever ENCRYPTION_MASTER_KEY
 * is set (production). Three readers queried it with JSON paths in SQL:
 *
 *   5. GET /api/v1/dashboard/bootstrap picked the active-task card with
 *      `context->>'current_task'` over EVERY project in the workspace. On a
 *      plaintext row a member saw a colleague's PERSONAL project name and task;
 *      on an encrypted row the card was empty for everybody, the author included.
 *   6. GET /api/v1/orgs/usage summed `context->'recent_decisions'`: 0 under
 *      encryption. The nightly vault remediation (phases 2, 6, 7) filtered and
 *      rewrote with JSON paths / jsonb_set: under encryption it found nothing and
 *      silently did nothing.
 *
 * Both modes are pinned: shouldEncrypt() reads the env on every write, so a
 * test can write one team's rows in plaintext and another's sealed.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan21-encrypted-reads.test.js
 */

process.env.NODE_ENV = 'test';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);
const MASTER_KEY = process.env.ENCRYPTION_MASTER_KEY;

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { hashPassword, generateToken } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const store = require('../../src/store/contextSyncStore');
const vault = require('../../src/jobs/vaultRemediationJob');

const q = (sql, params) => db.query(sql, params, 'org-system');

async function makeOrg(label, plan) {
  const orgId = `org-${uuidv4()}`;
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, plan, plan, 'active', plan === 'free' ? null : 5],
  );
  return orgId;
}

async function makePerson(label, { plan = 'free' } = {}) {
  const orgId = await makeOrg(label, plan);
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@e2e.test`;
  await q(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
  );
  await workspace.ensureOwnerMembership(orgId, userId);
  const jwt = generateToken({ user_id: userId, org_id: orgId, role: 'admin', email });
  return { label, orgId, userId, email, jwt };
}

async function join(owner, joiner, role = 'member') {
  const invite = await workspace.createInvite(owner.orgId, joiner.email, { role, invitedBy: owner.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
  assert.equal(accepted.ok, true, `invite must be redeemable: ${accepted.reason}`);
}

function as(method, path, person, ws = null) {
  let r = request(httpServer)[method](path).set('Authorization', `Bearer ${person.jwt}`);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  return r;
}

async function createProject(person, ws, name) {
  const res = await as('post', '/api/v1/context/projects', person, ws).send({ project_name: name });
  assert.equal(res.status, 201, `project create: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.project.project_id;
}

async function setSharing(person, ws, projectId, body) {
  const res = await as('patch', `/api/v1/teams/projects/${projectId}/sharing`, person, ws).send(body);
  assert.equal(res.status, 200, `sharing: ${res.status} ${JSON.stringify(res.body)}`);
}

async function writeContext(person, ws, projectId, patch, { updatedAt = new Date().toISOString() } = {}) {
  const raw = await store.getProject(ws, projectId);
  const actor = { id: person.userId, org_id: ws, workspace_key: ws, type: 'user', role: 'admin' };
  await store.saveProject({
    ...raw,
    context: { ...(raw.context || {}), ...patch, project_name: raw.project_name },
    updated_at: updatedAt,
  }, actor);
}

async function isSealed(projectId) {
  const { rows } = await q('SELECT (context ? \'_enc\') AS sealed, (context ? \'recent_decisions\') AS plain FROM context_projects WHERE project_id = $1', [projectId]);
  return rows[0];
}

// Runs `fn` with encryption on or off for WRITES; reads still decrypt either way.
async function withEncryption(on, fn) {
  if (on) process.env.ENCRYPTION_MASTER_KEY = MASTER_KEY;
  else delete process.env.ENCRYPTION_MASTER_KEY;
  try { return await fn(); } finally { process.env.ENCRYPTION_MASTER_KEY = MASTER_KEY; }
}

// Wherever the payload nests it.
function commandCapture(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.command_capture) return body.command_capture;
  for (const value of Object.values(body)) {
    const found = commandCapture(value);
    if (found) return found;
  }
  return null;
}

// ── 5 ────────────────────────────────────────────────────────────────────────

for (const encrypted of [false, true]) {
  test(`5: the bootstrap active-task card reads only what the viewer may read (${encrypted ? 'encrypted' : 'plaintext'})`, async () => {
    const tag = uuidv4().slice(0, 6);
    const O = await makePerson(`owner${tag}`, { plan: 'developer_pro' });
    const M = await makePerson(`member${tag}`);
    await join(O, M);
    const T = O.orgId;
    const now = Date.now();

    await withEncryption(encrypted, async () => {
      // M's own project, oldest: the card M should get.
      const mine = await createProject(M, T, `Member work ${tag}`);
      await writeContext(M, T, mine, { current_task: `MEMBERTASK${tag} wire the importer` }, { updatedAt: new Date(now - 60000).toISOString() });
      // O's PERSONAL project, newest: nobody but O may see it.
      const personal = await createProject(O, T, `BOOTPNAME${tag} diary`);
      await setSharing(O, T, personal, { visibility: 'personal' });
      await writeContext(O, T, personal, { current_task: `BOOTSECRET${tag} interview at competitor` }, { updatedAt: new Date(now).toISOString() });
      // A shared project whose share withholds current_task (goals only).
      const narrowed = await createProject(O, T, `Narrowed ${tag}`);
      await setSharing(O, T, narrowed, { visibility: 'shared', sections: [{ section_key: 'goals', can_view: true, can_edit: false }] });
      await writeContext(O, T, narrowed, { current_task: `SHAREDSECRET${tag} layoffs`, goals: ['ship'] }, { updatedAt: new Date(now - 30000).toISOString() });
      assert.equal((await isSealed(personal)).sealed, encrypted, 'fixture: storage mode');
    });

    const member = await as('get', '/api/v1/dashboard/bootstrap', M, T);
    assert.equal(member.status, 200, JSON.stringify(member.body));
    const text = JSON.stringify(member.body);
    assert.ok(!text.includes(`BOOTSECRET${tag}`) && !text.includes(`BOOTPNAME${tag}`), 'a colleague\'s personal project reached the card');
    assert.ok(!text.includes(`SHAREDSECRET${tag}`), 'a withheld current_task reached the card');
    assert.match(String(commandCapture(member.body)?.active_task_label || ''), new RegExp(`MEMBERTASK${tag}`),
      'the member\'s own task is on the card');

    const owner = await as('get', '/api/v1/dashboard/bootstrap', O, T);
    assert.equal(owner.status, 200, JSON.stringify(owner.body));
    assert.match(String(commandCapture(owner.body)?.active_task_label || ''), new RegExp(`BOOTSECRET${tag}`),
      'the author still sees their own newest task');
  });
}

// ── 6: /orgs/usage ───────────────────────────────────────────────────────────

test('6a: decisions_remembered counts decrypted decisions', async () => {
  const tag = uuidv4().slice(0, 6);
  const O = await makePerson(`owner${tag}`, { plan: 'developer_pro' });
  const T = O.orgId;
  const P = await createProject(O, T, `Ledger ${tag}`);
  const decided = new Date().toISOString();
  await withEncryption(true, () => writeContext(O, T, P, {
    recent_decisions: [1, 2, 3].map((n) => ({ summary: `decision ${n}`, decided_at: decided })),
  }));
  assert.equal((await isSealed(P)).sealed, true, 'fixture: sealed');

  const res = await as('get', '/api/v1/orgs/usage', O, T);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(JSON.stringify(res.body).includes('"decisions_remembered":3'), true,
    `decisions_remembered should be 3: ${JSON.stringify(res.body).match(/"decisions_remembered":\d+/)}`);
});

// ── 6: vault remediation ─────────────────────────────────────────────────────

test('6b: the vault remediation phases that remain repair encrypted projects and keep them sealed (2 and 7 are retired)', async () => {
  const tag = uuidv4().slice(0, 6);
  const O = await makePerson(`owner${tag}`, { plan: 'developer_pro' });
  const T = O.orgId;
  const P = await createProject(O, T, `Vault ${tag}`);
  const resolvedTitle = `Adopt the ${tag} importer`;
  await withEncryption(true, () => writeContext(O, T, P, {
    recent_decisions: [
      { summary: `Fake date ${tag}`, decided_at: '2023-01-02T00:00:00.000Z' },
      { summary: resolvedTitle, decided_at: new Date().toISOString() },
      { summary: `Resolved: the ${tag} deploy pipeline blocker is fixed and deployed`, decided_at: new Date().toISOString() },
    ],
    blocking_issue: `${tag} deploy pipeline blocker`,
    // Written raw (store.saveProject), so it carries the stamp the server puts
    // on every blocker write itself. Scan 23: phase 7 only clears a blocker a
    // NEWER decision resolves, so the blocker predates the resolving decision.
    blocking_issue_set_at: new Date(Date.now() - 3600000).toISOString(),
  }));
  const now = new Date().toISOString();
  await store.upsertGraphNode({
    node_id: `graph_node_${uuidv4()}`, owner_key: T, project_id: P, node_type: 'decision',
    canonical_key: `decision:${uuidv4()}`, title: resolvedTitle, summary: resolvedTitle,
    metadata: { entity_type: 'decision', scope: 'project', status: 'resolved' }, confidence: 0.9,
    source_session_id: '', source_tool: 'claude_code', created_at: now, updated_at: now, last_seen_at: now,
  });
  const before = await store.getProject(T, P);

  // The whole nightly run, as the scheduler calls it.
  await vault.runVaultRemediation();

  const after = await store.getProject(T, P);
  const decisions = after.context.recent_decisions;
  const fake = decisions.find((d) => d.summary === `Fake date ${tag}`);
  assert.equal(fake.decided_at, '2023-01-02T00:00:00.000Z', 'phase 2 is retired: the 2023 date is kept');
  assert.equal(fake.timestamp_repaired, undefined);
  assert.equal(decisions.find((d) => d.summary === resolvedTitle).resolved, true, 'phase 6: the resolved node propagated');
  assert.equal(after.context.blocking_issue, `${tag} deploy pipeline blocker`, 'phase 7 is retired: the blocker is kept');
  assert.equal(after.context.blocker_reconciled_at, undefined);
  assert.equal(after.updated_at, before.updated_at, 'a repair is not activity');

  const sealed = await isSealed(P);
  assert.equal(sealed.sealed, true, 'still encrypted');
  assert.equal(sealed.plain, false, 'no plaintext keys written beside the ciphertext');
});
