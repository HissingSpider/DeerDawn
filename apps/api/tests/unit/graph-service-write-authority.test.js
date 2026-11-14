/**
 * PR #480 gated the graph WRITE ROUTES. It did not gate the graph write SERVICE.
 *
 * POST/PATCH/DELETE /api/v1/context/graph/nodes now run
 * assertGraphNodeCreatable / assertGraphNodeWritable. But those routes are not
 * how an agent writes a memory node — `upsert_workspace_entities` and
 * `mark_resolved` are, and both land on
 * contextSyncService.upsertWorkspaceEntities, which resolved nothing but
 * owner_key. In a shared workspace owner_key is the SAME VALUE for everybody in
 * it, so the gate on the routes was a gate on the door nobody uses.
 *
 * Both MCP dispatchers reach the same function:
 *   - hosted (apps/api/src/routes/mcp.js) calls service.upsertWorkspaceEntities
 *     directly, for upsert_workspace_entities and for mark_resolved;
 *   - local stdio (packages/mcp-server) calls it over HTTP through
 *     POST /api/v1/context/workspace/entities.
 * So the gate belongs in the service, where one fix covers both — the shape
 * mcp-two-dispatchers-parity keeps asking for.
 *
 * Three holes, all reachable with an ordinary session:
 *   1. a VIEWER could create and overwrite workspace memory (context:write is a
 *      scope derived from users.role; every member in the workspace holds it);
 *   2. a member could file a node into a project they cannot open, by naming its
 *      project_id;
 *   3. a member could OVERWRITE a colleague's node in a hidden project without
 *      naming it at all — the canonical-key/fuzzy dedup pass matches across the
 *      whole owner, and upsertGraphNode keeps the existing row's project, so the
 *      write lands on a node the caller may not even read. (Scan 31: such a
 *      write now becomes the caller's own node under a scoped key.)
 *
 * Refusal shapes match the routes: not_found for anything invisible (naming the
 * refusal confirms the id exists), share_write_forbidden/403 for something the
 * caller can see and may not change.
 *
 * DB-backed; run via scripts/run-db-test.sh node --test tests/unit/graph-service-write-authority.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const db = require('../../src/config/db');
const workspace = require('../../src/services/workspaceService');
const { closeRedisConnections } = require('../../src/config/redis');

const RUN = crypto.randomBytes(4).toString('hex');
const ORG = `org-${crypto.randomUUID()}`;
const SOLO = `org-${crypto.randomUUID()}`;
const ALICE = `user-gsw-alice-${RUN}`;
const BOB = `user-gsw-bob-${RUN}`;
const VERA = `user-gsw-vera-${RUN}`;
const SAM = `user-gsw-sam-${RUN}`;

const SCOPES = ['context:read', 'context:write', 'context:admin'];
const alice = () => ({ type: 'user', id: ALICE, org_id: ORG, workspace_key: ORG, role: 'admin', scopes: SCOPES });
const bob = () => ({ type: 'user', id: BOB, org_id: ORG, workspace_key: ORG, role: 'admin', scopes: SCOPES });
const vera = () => ({ type: 'user', id: VERA, org_id: ORG, workspace_key: ORG, role: 'admin', scopes: SCOPES });
// Sam is alone in his own workspace and has NO membership row — the case the
// solo exemption exists for. If the gate breaks him it has broken nearly every
// real account, so he is asserted on every path the gate touches.
const sam = () => ({ type: 'user', id: SAM, org_id: SOLO, workspace_key: SOLO, role: 'admin', scopes: SCOPES });

const now = () => new Date().toISOString();

const auth = require('../../src/middleware/auth');
auth.requireAuth = (req, _res, next) => { req.actor = currentActor(); next(); };
let currentActor = alice;
const app = express();
app.use(express.json());
app.use('/api/v1/context', require('../../src/routes/context/context-sync'));
app.use((err, _req, res, _next) => res.status(err?.status || 500).json({ error: err?.message || 'internal_error' }));
const httpServer = app.listen(0);
const as = (who, fn) => { currentActor = who; return fn(request(httpServer)); };

// The hosted connector's dispatcher, required AFTER the auth stub so the two
// surfaces share one process.
const { dispatchTool } = require('../../src/routes/mcp');
const textOf = (r) => (r?.content || []).map((c) => c.text).join('\n');

let personalProject;
let sharedProject;
let soloProject;
let hiddenNode;
let sharedNode;

async function setVisibility(ownerKey, projectId, visibility) {
  const row = await store.getProject(ownerKey, projectId);
  await store.saveProject({ ...row, visibility }, null);
}

const caught = async (fn) => { try { await fn(); return null; } catch (err) { return err; } };

test.before(async () => {
  await workspace.addMember(ORG, ALICE, { role: 'owner' });
  await workspace.addMember(ORG, BOB, { role: 'member' });
  await workspace.addMember(ORG, VERA, { role: 'viewer' });

  personalProject = await service.createProject(alice(), { project_name: `GswPersonal ${RUN}` });
  sharedProject = await service.createProject(alice(), { project_name: `GswShared ${RUN}` });
  await setVisibility(ORG, personalProject.project_id, 'personal');
  await setVisibility(ORG, sharedProject.project_id, 'shared');

  soloProject = await service.createProject(sam(), { project_name: `GswSolo ${RUN}` });

  // Alice's node, in her personal project. Bob and Vera cannot read it.
  hiddenNode = await store.upsertGraphNode({
    node_id: `graph_node_${crypto.randomUUID()}`,
    owner_key: ORG,
    project_id: personalProject.project_id,
    node_type: 'decision',
    canonical_key: `decision:acquire-northwind-${RUN}`,
    title: `Acquire Northwind in Q1 ${RUN}`,
    summary: `We are buying Northwind in Q1 ${RUN}; the team has not been told yet.`,
    metadata: { entity_type: 'decision', scope: 'project', status: 'open' },
    confidence: 0.9,
    source_session_id: '',
    source_tool: 'claude_code',
    created_at: now(), updated_at: now(), last_seen_at: now(),
  });

  // Alice's node in the SHARED project: Vera can read it, which is what makes
  // her refusal on mark_resolved a real refusal rather than a failed search.
  sharedNode = await store.upsertGraphNode({
    node_id: `graph_node_${crypto.randomUUID()}`,
    owner_key: ORG,
    project_id: sharedProject.project_id,
    node_type: 'decision',
    canonical_key: `decision:ship-the-queue-${RUN}`,
    title: `Ship the queue rewrite ${RUN}`,
    summary: `The team decided to ship the queue rewrite this sprint ${RUN}.`,
    metadata: { entity_type: 'decision', scope: 'project', status: 'open' },
    confidence: 0.9,
    source_session_id: '',
    source_tool: 'claude_code',
    created_at: now(), updated_at: now(), last_seen_at: now(),
  });
});

test.after(async () => {
  await new Promise((resolve) => httpServer.close(resolve));
  for (const ownerKey of [ORG, SOLO]) {
    for (const table of [
      'context_graph_evidence', 'context_graph_edges', 'context_graph_embeddings',
      'context_graph_nodes', 'context_sessions', 'context_projects', 'workspace_members',
    ]) {
      try { await db.query(`DELETE FROM ${table} WHERE owner_key = $1`, [ownerKey], 'org-system'); } catch (_) { /* best effort */ }
    }
  }
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});

// ─── 1. A viewer writes nothing ──────────────────────────────────────────────

test('a viewer cannot upsert a workspace entity through the service', async () => {
  const err = await caught(() => service.upsertWorkspaceEntities(vera(), {
    entities: [{ entity_type: 'knowledge', title: `Viewer planted rule ${RUN}`, summary: `A rule a read-only member should not be able to write ${RUN}` }],
  }));
  assert.ok(err, 'a viewer must be refused');
  assert.strictEqual(err.code, 'share_write_forbidden');

  const landed = await store.listGraphNodes(ORG, { limit: 500 });
  assert.ok(!landed.some((n) => n.title.includes('Viewer planted rule')), 'nothing was written');
});

test('POST /workspace/entities answers 403, not 500, for a viewer', async () => {
  const res = await as(vera, (r) => r.post('/api/v1/context/workspace/entities').send({
    entities: [{ entity_type: 'knowledge', title: `Viewer via REST ${RUN}`, summary: `The local stdio dispatcher's route ${RUN}` }],
  }));
  assert.strictEqual(res.status, 403, 'the route the local MCP server posts to');
  assert.strictEqual(res.body.error, 'share_write_forbidden');
});

test('the hosted dispatcher refuses a viewer on upsert_workspace_entities', async () => {
  const err = await caught(() => dispatchTool('upsert_workspace_entities', {
    entities: [{ entity_type: 'knowledge', title: `Viewer via hosted ${RUN}`, summary: `The hosted connector's dispatcher ${RUN}` }],
  }, vera(), 'claude_web'));
  assert.ok(err, 'a viewer must be refused on the hosted connector too');
  assert.match(String(err.message), /share_write_forbidden/);
});

// ─── 2. A project you cannot open ────────────────────────────────────────────

test('a member cannot file an entity into a project they cannot see', async () => {
  const err = await caught(() => service.upsertWorkspaceEntities(bob(), {
    entities: [{
      entity_type: 'knowledge',
      title: `Planted into personal ${RUN}`,
      summary: `Filed by naming a project id that is not visible ${RUN}`,
      project_id: personalProject.project_id,
      scope: 'project',
    }],
  }));
  assert.ok(err, 'naming a hidden project id must not work');
  assert.strictEqual(err.message, 'project_not_found', 'not_found, never forbidden — a 403 confirms the project exists');

  const landed = await store.listGraphNodes(ORG, { limit: 500 });
  assert.ok(!landed.some((n) => n.title.includes('Planted into personal')), 'nothing was written');
});

test('POST /workspace/entities answers 404 for a project the caller cannot see', async () => {
  const res = await as(bob, (r) => r.post('/api/v1/context/workspace/entities').send({
    entities: [{
      entity_type: 'knowledge',
      title: `Planted via REST ${RUN}`,
      summary: `Filed through the route the local dispatcher uses ${RUN}`,
      project_id: personalProject.project_id,
      scope: 'project',
    }],
  }));
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, 'project_not_found');
});

// ─── 3. Overwriting a hidden node without naming it ──────────────────────────

// Scan 31: colliding with a hidden node's key used to be refused
// (node_not_found), which left the name unsaveable for everybody who could not
// read that node — forever. It is now the caller's OWN node, under a scoped key;
// the hidden one is neither written nor returned.
test('a member cannot overwrite a hidden node by colliding with its canonical key', async () => {
  const res = await service.upsertWorkspaceEntities(bob(), {
    entities: [{
      entity_type: 'decision',
      title: `Acquire Northwind in Q1 ${RUN}`,
      canonical_key: `decision:acquire-northwind-${RUN}`,
      summary: `Rewritten by somebody who cannot read the original ${RUN}`,
    }],
  });
  assert.strictEqual(res.entities.length, 1, 'the caller\'s entity is written');
  const [own] = res.entities;
  assert.notStrictEqual(own.node_id, hiddenNode.node_id, 'the dedup pass must not hand a caller a node they cannot read');
  assert.notStrictEqual(own.canonical_key, hiddenNode.canonical_key, 'it is keyed on its own');
  assert.ok(!JSON.stringify(res).includes('the team has not been told'), 'and nothing of the hidden node comes back');

  const survived = await store.getGraphNode(ORG, hiddenNode.node_id);
  assert.ok(survived.summary.includes('the team has not been told'), 'the original summary survived');
  assert.strictEqual(survived.project_id, personalProject.project_id, 'and it was not moved');
  // Bob's own node would answer the relation test below by the same key.
  await store.deleteGraphNode(ORG, own.node_id);
});

test('mark_resolved cannot resolve a node the caller may not change', async () => {
  // Deliberately the SHARED node: Vera can read it, so this is a refusal on the
  // write and not a search that found nothing. Resolving hides an entry from
  // every future context load, which is a write like any other.
  const call = (who) => dispatchTool('mark_resolved', {
    title: `Ship the queue rewrite ${RUN}`, entity_type: 'decision',
  }, who, 'claude_web');

  let outcome;
  try { outcome = textOf(await call(vera())); } catch (err) { outcome = String(err.message); }
  assert.match(outcome, /share_write_forbidden/, `a viewer resolves nothing (got: ${outcome})`);

  const still = await store.getGraphNode(ORG, sharedNode.node_id);
  assert.notStrictEqual(String(still.metadata?.status), 'resolved', 'the decision is still open');

  // ...and a member on the same shared project still can, or the gate has
  // replaced a privacy bug with a collaboration bug.
  const byMember = textOf(await call(bob()));
  assert.match(byMember, /Marked resolved/, `a member may still resolve a shared decision (got: ${byMember})`);
});

test('a relation cannot be hung off a node in a project the caller cannot see', async () => {
  // The edge summary is built as `${from.title} ${relation} ${to.title}` and
  // comes straight back in the response, so resolving a hidden endpoint would
  // read a colleague's node title out loud. An unresolvable endpoint was always
  // a silent skip, so a hidden one looks exactly like a key that is not there.
  const res = await service.upsertWorkspaceEntities(bob(), {
    entities: [{
      entity_type: 'knowledge',
      title: `Queue retry budget ${RUN}`,
      summary: `How long the queue retries before it gives up ${RUN}`,
      project_id: sharedProject.project_id,
      scope: 'project',
    }],
    relations: [{
      from_canonical_key: `knowledge:queue-retry-budget-${RUN}`,
      to_canonical_key: `decision:acquire-northwind-${RUN}`,
      relation_type: 'related_to',
    }],
  });
  assert.strictEqual(res.entities.length, 1, 'the entity itself still lands');
  assert.strictEqual(res.relations.length, 0, 'the relation to a hidden node is skipped');
  assert.ok(!JSON.stringify(res).includes('Acquire Northwind'), 'and its title never comes back');

  // The same relation between two nodes he CAN see is written normally.
  const ok = await service.upsertWorkspaceEntities(bob(), {
    entities: [],
    relations: [{
      from_canonical_key: `knowledge:queue-retry-budget-${RUN}`,
      to_canonical_key: `decision:ship-the-queue-${RUN}`,
      relation_type: 'related_to',
    }],
  });
  assert.strictEqual(ok.relations.length, 1, 'a visible pair still links');
});

// ─── The solo account, which is nearly every account ─────────────────────────

test('a solo account with no membership row still writes', async () => {
  const workspaceScoped = await service.upsertWorkspaceEntities(sam(), {
    entities: [{ entity_type: 'knowledge', title: `Solo workspace rule ${RUN}`, summary: `A solo account must keep writing workspace memory ${RUN}` }],
  });
  assert.strictEqual(workspaceScoped.entities.length, 1, 'solo workspace-scoped write');

  const projectScoped = await service.upsertWorkspaceEntities(sam(), {
    entities: [{
      entity_type: 'knowledge',
      title: `Solo project rule ${RUN}`,
      summary: `A solo account must keep writing project memory ${RUN}`,
      project_id: soloProject.project_id,
      scope: 'project',
    }],
  });
  assert.strictEqual(projectScoped.entities.length, 1, 'solo project-scoped write');
  assert.strictEqual(projectScoped.entities[0].project_id, soloProject.project_id);

  // ...and re-upserting the same entity (the dedup/overwrite path) still works.
  const again = await service.upsertWorkspaceEntities(sam(), {
    entities: [{
      entity_type: 'knowledge',
      title: `Solo project rule ${RUN}`,
      summary: `Updated by the same solo account ${RUN}`,
      project_id: soloProject.project_id,
      scope: 'project',
    }],
  });
  assert.strictEqual(again.entities[0].node_id, projectScoped.entities[0].node_id, 'same node, updated in place');
});

test('an author and a member still write where they are allowed', async () => {
  const byAuthor = await service.upsertWorkspaceEntities(alice(), {
    entities: [{
      entity_type: 'knowledge',
      title: `Encryption master key backup drill ${RUN}`,
      summary: `The author of a personal project was never the problem ${RUN}`,
      project_id: personalProject.project_id,
      scope: 'project',
    }],
  });
  assert.strictEqual(byAuthor.entities.length, 1);

  const byMember = await service.upsertWorkspaceEntities(bob(), {
    entities: [{
      entity_type: 'knowledge',
      title: `Postgres connection pool sizing ${RUN}`,
      summary: `Shared means shared — a member still contributes ${RUN}`,
      project_id: sharedProject.project_id,
      scope: 'project',
    }],
  });
  assert.strictEqual(byMember.entities.length, 1);
  assert.strictEqual(byMember.entities[0].project_id, sharedProject.project_id);
});

test('a near-duplicate of a HIDDEN node becomes the caller\'s own node, not a refusal', async () => {
  // The fuzzy pass scans the whole owner. Before the filter it merged this into
  // Alice's personal-project node; refusing instead would leak that something
  // like it exists. The caller simply gets their own node.
  const res = await service.upsertWorkspaceEntities(bob(), {
    entities: [{
      entity_type: 'decision',
      title: `Acquire Northwind in Q1 ${RUN}`,
      summary: `We are buying Northwind in Q1 ${RUN}; the team has not been told yet.`,
      project_id: sharedProject.project_id,
      scope: 'project',
    }],
  });
  assert.strictEqual(res.entities.length, 1);
  assert.notStrictEqual(res.entities[0].node_id, hiddenNode.node_id, 'a separate node, not a write-through');
  assert.strictEqual(res.entities[0].project_id, sharedProject.project_id, 'filed where the caller asked');

  const original = await store.getGraphNode(ORG, hiddenNode.node_id);
  assert.ok(original.summary.includes('the team has not been told'), 'the hidden node is untouched');
});
