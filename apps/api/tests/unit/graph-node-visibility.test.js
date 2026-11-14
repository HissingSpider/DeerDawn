/**
 * Graph nodes inherit the visibility of the projects they were observed in.
 *
 * Project rows have been visibility-filtered since the sharing work, but the
 * knowledge graph was not: entities are auto-promoted from project content, so
 * anything extracted from a colleague's PERSONAL project — a client name, a
 * vendor, a decision — surfaced in everybody else's workspace entities, brief
 * knowledge section, recall results and portfolio. The project stayed hidden and
 * its contents did not, which is the leak the visibility column exists to close.
 *
 * Cross-project membership is NOT in the node row (it keeps the first project it
 * was seen in); it lives in context_graph_evidence. So a node is visible when ANY
 * project it has been seen in is visible, and hidden only when every one of them
 * is hidden.
 *
 * DB-backed; run via scripts/run-db-test.sh node --test tests/unit/graph-node-visibility.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const service = require('../../src/services/contextSyncService');
const portfolio = require('../../src/services/portfolioService');
const store = require('../../src/store/contextSyncStore');
const db = require('../../src/config/db');
const workspace = require('../../src/services/workspaceService');
const { closeRedisConnections } = require('../../src/config/redis');

const RUN = crypto.randomBytes(4).toString('hex');
const ORG = `org-${crypto.randomUUID()}`;
const ALICE = `user-graphvis-alice-${RUN}`;
const BOB = `user-graphvis-bob-${RUN}`;

const alice = () => ({ org_id: ORG, id: ALICE });
const bob = () => ({ org_id: ORG, id: BOB });

const titles = (nodes) => nodes.map((n) => n.title);
const now = () => new Date().toISOString();

let personalProject;
let otherPersonalProject;
let sharedProject;

async function seedNode({ title, projectId, evidenceProjectIds = [], scope = 'project' }) {
  const node = await store.upsertGraphNode({
    node_id: `graph_node_${crypto.randomUUID()}`,
    owner_key: ORG,
    project_id: projectId,
    node_type: 'knowledge',
    canonical_key: `knowledge:${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    title,
    summary: `${title} summary long enough to survive the graph node summary rules`,
    metadata: { entity_type: 'knowledge', scope, importance: 'high', status: 'active' },
    confidence: 0.9,
    source_session_id: '',
    source_tool: 'claude_code',
    created_at: now(),
    updated_at: now(),
    last_seen_at: now(),
  });
  for (const pid of evidenceProjectIds) {
    await store.addGraphEvidence({
      evidence_id: `graph_ev_${crypto.randomUUID()}`,
      owner_key: ORG,
      project_id: pid,
      session_id: `sess-${RUN}`,
      node_id: node.node_id,
      tool: 'claude_code',
      excerpt: `${title} seen here`,
      metadata: {},
      confidence: 0.9,
      created_at: now(),
    });
  }
  return node;
}

test.before(async () => {
  await workspace.addMember(ORG, ALICE, { role: 'owner' });
  await workspace.addMember(ORG, BOB, { role: 'member' });

  personalProject = await service.createProject(alice(), { project_name: `AliceOnly ${RUN}` });
  const personalRow = await store.getProject(ORG, personalProject.project_id);
  await store.saveProject({ ...personalRow, visibility: 'personal' }, null);
  otherPersonalProject = await service.createProject(alice(), { project_name: `AliceOnlyToo ${RUN}` });
  const otherPersonalRow = await store.getProject(ORG, otherPersonalProject.project_id);
  await store.saveProject({ ...otherPersonalRow, visibility: 'personal' }, null);
  sharedProject = await service.createProject(alice(), { project_name: `TeamShared ${RUN}` });

  await seedNode({ title: `Vendor of the secret client ${RUN}`, projectId: personalProject.project_id });
  await seedNode({
    title: `Queue choice seen in both ${RUN}`,
    projectId: personalProject.project_id,
    evidenceProjectIds: [sharedProject.project_id],
  });
  await seedNode({ title: `Workspace wide convention ${RUN}`, projectId: null, scope: 'workspace' });
});

test.after(async () => {
  try {
    await db.query('DELETE FROM context_graph_evidence WHERE owner_key = $1', [ORG], 'org-system');
    await db.query('DELETE FROM context_graph_nodes WHERE owner_key = $1', [ORG], 'org-system');
    await db.query('DELETE FROM context_projects WHERE owner_key = $1', [ORG], 'org-system');
    await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [ORG], 'org-system');
  } catch (_) { /* best effort */ }
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});

test('workspace entities hide a node seen only in somebody else\'s personal project', async () => {
  const bobsEntities = titles(await service.getWorkspaceEntities(bob(), { limit: 50, track_selection: false }));
  assert.ok(
    !bobsEntities.some((t) => t.includes('Vendor of the secret client')),
    'an entity promoted from a personal project is not workspace knowledge'
  );
  assert.ok(
    bobsEntities.some((t) => t.includes('Queue choice seen in both')),
    'evidence in a shared project makes the same entity legitimately visible'
  );
  assert.ok(
    bobsEntities.some((t) => t.includes('Workspace wide convention')),
    'a workspace-scoped entity belongs to no project and stays visible'
  );
});

test('its author still sees her own entity', async () => {
  const hers = titles(await service.getWorkspaceEntities(alice(), { limit: 50, track_selection: false }));
  assert.ok(hers.some((t) => t.includes('Vendor of the secret client')), 'Alice reads her own work');
  assert.ok(hers.some((t) => t.includes('Queue choice seen in both')));
});

test('a text search cannot reach a hidden node either', async () => {
  const found = titles(await service.getWorkspaceEntities(bob(), {
    query: 'secret client vendor',
    limit: 50,
    track_selection: false,
  }));
  assert.ok(!found.some((t) => t.includes('Vendor of the secret client')), 'recall search is filtered too');
});

test('the brief\'s knowledge section is filtered', async () => {
  const overview = await service.getWorkspaceOverview(bob(), { verbosity: 'detailed' });
  const knowledge = JSON.stringify(overview.knowledge || []);
  assert.ok(!knowledge.includes('Vendor of the secret client'), 'no hidden entity in a teammate\'s brief');
});

test('the portfolio is filtered', async () => {
  await seedNode({
    title: `Cross project secret ${RUN}`,
    projectId: personalProject.project_id,
    evidenceProjectIds: [otherPersonalProject.project_id],
  });
  await seedNode({
    title: `Cross project legitimate ${RUN}`,
    projectId: personalProject.project_id,
    evidenceProjectIds: [sharedProject.project_id],
  });
  const view = await portfolio.getPortfolio(bob(), { entityLimit: 50 });
  const entries = JSON.stringify(view.entities?.entries || []);
  assert.ok(entries.includes('Cross project legitimate'), 'precondition: the portfolio lists cross-project entities');
  assert.ok(!entries.includes('Cross project secret'), 'a cross-project entity from hidden projects stays hidden');
});
