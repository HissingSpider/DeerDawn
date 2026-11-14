/**
 * GET /api/v1/context/export is the custody-lock-in pressure valve — "you can
 * always get your data out" — and it runs against the BOUND WORKSPACE. On a
 * shared workspace that is not "your data", it is everybody's, and the bundle is
 * the most complete form the leak can take: one request, no project id, both
 * formats, downloaded as a file.
 *
 * Whole projects are governed by visibility (personal / private / shared) and, on
 * a shared one, by the section policy — the same rules the brief, the graph and
 * the project list already enforce. A bundle that reproduces the raw project is
 * the section policy enforcing nothing, because the point of withholding a
 * section is that the section does not travel.
 *
 * Both formats matter and JSON is the one to be careful about: the markdown
 * renderer only prints what the bundle hands it, so a fix that filters the
 * renderer leaves the JSON — the machine-readable copy — untouched.
 *
 * DB-backed; run via scripts/run-db-test.sh node --test tests/unit/export-bundle-visibility.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const db = require('../../src/config/db');
const workspace = require('../../src/services/workspaceService');
const { renderContextExportMarkdown } = require('../../src/services/contextExportMarkdown');
const { closeRedisConnections } = require('../../src/config/redis');

const RUN = crypto.randomBytes(4).toString('hex');
const ORG = `org-${crypto.randomUUID()}`;
const ALICE = `user-export-alice-${RUN}`;   // workspace owner
const BOB = `user-export-bob-${RUN}`;       // member

const alice = () => ({ type: 'user', id: ALICE, org_id: ORG, workspace_key: ORG, role: 'admin' });
const bob = () => ({ type: 'user', id: BOB, org_id: ORG, workspace_key: ORG, role: 'admin' });

// Every marker is unique per run, so "absent" cannot be satisfied by a stale row
// or by a substring of some other fixture.
const SECRET = `PERSONALSECRET${RUN}`;
const ORGPRIVATE = `ORGPRIVATE${RUN}`;
const SHARED_TASK = `SHAREDTASK${RUN}`;
const WITHHELD = `WITHHELDGOAL${RUN}`;
const BOBS_OWN = `BOBSOWN${RUN}`;
const AUTHOR_PATH = `/Users/alice-${RUN}/work/client-x`;

let personalProject, privateProject, sharedProject, bobsProject;

async function setVisibility(projectId, visibility) {
  const row = await store.getProject(ORG, projectId);
  await store.saveProject({ ...row, visibility }, null);
}

// Both renderings of the same bundle, as strings, because "absent" has to hold
// for the machine-readable copy and the human-readable one alike.
async function exportStrings(actor) {
  const bundle = await service.exportContext(actor);
  return { bundle, json: JSON.stringify(bundle), markdown: renderContextExportMarkdown(bundle) };
}

test.before(async () => {
  await workspace.addMember(ORG, ALICE, { role: 'owner' });
  await workspace.addMember(ORG, BOB, { role: 'member' });

  personalProject = await service.createProject(alice(), { project_name: `ExpPersonal ${RUN}` });
  privateProject = await service.createProject(alice(), { project_name: `ExpPrivate ${RUN}` });
  sharedProject = await service.createProject(alice(), { project_name: `ExpShared ${RUN}` });
  bobsProject = await service.createProject(bob(), { project_name: `ExpBobs ${RUN}` });

  await service.updateProjectContext(alice(), personalProject.project_id, { current_task: SECRET });
  await service.updateProjectContext(alice(), privateProject.project_id, { current_task: ORGPRIVATE });
  await service.updateProjectContext(alice(), sharedProject.project_id, {
    current_task: SHARED_TASK,
    // `goals` is NOT in DEFAULT_SHARED_SECTIONS, so it is withheld from everyone
    // but the author even though the project itself is shared. It is an ARRAY of
    // strings — a bare string is coerced to [] by the context sanitizer, which
    // would make the "withheld" assertions pass on a value that was never
    // written, i.e. pass for the wrong reason.
    goals: [WITHHELD],
  });
  await service.updateProjectContext(bob(), bobsProject.project_id, { current_task: BOBS_OWN });

  // The author's absolute path on HER machine, on the shared project. There is no
  // section key that could withhold it, so it must not travel at all.
  const sharedRow = await store.getProject(ORG, sharedProject.project_id);
  await store.saveProject({ ...sharedRow, linked_paths: [AUTHOR_PATH] }, null);

  await setVisibility(personalProject.project_id, 'personal');
  await setVisibility(privateProject.project_id, 'private');
  await setVisibility(sharedProject.project_id, 'shared');
  await setVisibility(bobsProject.project_id, 'personal');
});

test.after(async () => {
  for (const table of [
    'context_graph_evidence', 'context_graph_edges', 'context_graph_nodes',
    'context_sessions', 'context_project_shares', 'context_projects', 'workspace_members',
  ]) {
    try { await db.query(`DELETE FROM ${table} WHERE owner_key = $1`, [ORG], 'org-system'); } catch (_) { /* best effort */ }
  }
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});

test('a member\'s export excludes a colleague\'s personal project', async () => {
  const { json, markdown, bundle } = await exportStrings(bob());
  assert.ok(json.includes(BOBS_OWN), 'precondition: Bob exports his own work');
  assert.ok(!json.includes(SECRET), 'a colleague\'s personal project is not Bob\'s data (JSON)');
  assert.ok(!markdown.includes(SECRET), 'and not in the markdown either');
  assert.ok(
    !bundle.projects.some((p) => p.project_id === personalProject.project_id),
    'the project is absent entirely, not merely emptied'
  );
});

test('a member\'s export excludes an org-private project', async () => {
  // 'private' is org-owned and unshared: readable by its author and a WORKSPACE
  // OWNER, not by a member. Same line canViewProjectForActor draws.
  const { json, markdown } = await exportStrings(bob());
  assert.ok(!json.includes(ORGPRIVATE), 'a member does not export org-private work (JSON)');
  assert.ok(!markdown.includes(ORGPRIVATE), 'nor in markdown');
});

test('the author exports her own personal and private work', async () => {
  // The bundle must not become useless in the name of privacy: this is the
  // promise the route exists to keep.
  const { json } = await exportStrings(alice());
  assert.ok(json.includes(SECRET), 'her own personal project');
  assert.ok(json.includes(ORGPRIVATE), 'her own private project');
  assert.ok(json.includes(SHARED_TASK), 'and her own shared one');
  assert.ok(json.includes(WITHHELD), 'including the sections she withheld from others');
});

test('a workspace owner exports org-private work but never a colleague\'s personal work', async () => {
  // The asymmetry is the whole reason `personal` and `private` are two words:
  // continuity for the org, without reading somebody's independent side project.
  const { json } = await exportStrings(alice());
  assert.ok(!json.includes(BOBS_OWN), 'not even the workspace owner exports Bob\'s personal project');
});

test('withheld SECTIONS of a shared project do not travel in the bundle', async () => {
  // Guarded against passing for the wrong reason: the author's own export must
  // contain the marker, or "absent from Bob's" proves only that it was never
  // stored. (It was not, on the first draft of this test — `goals` is an array.)
  const authors = await exportStrings(alice());
  assert.ok(authors.json.includes(WITHHELD), 'precondition: the withheld section exists at all');

  const { json, markdown } = await exportStrings(bob());
  assert.ok(json.includes(SHARED_TASK), 'precondition: the shared sections do travel');
  assert.ok(!json.includes(WITHHELD), 'a section outside the share policy is absent from the JSON');
  assert.ok(!markdown.includes(WITHHELD), 'and from the markdown');
});

test('a teammate\'s bundle does not carry the author\'s local filesystem paths', async () => {
  // Same judgement getProjectPresence already makes when it withholds a peer's
  // cwd and host: on a shared workspace the peer is a colleague on their own
  // machine. The markdown prints linked_paths verbatim under the project.
  const authors = await exportStrings(alice());
  assert.ok(authors.json.includes(AUTHOR_PATH), 'precondition: the author keeps her own paths');

  const { json, markdown } = await exportStrings(bob());
  assert.ok(json.includes(SHARED_TASK), 'precondition: Bob does read the shared project');
  assert.ok(!json.includes(AUTHOR_PATH), 'no author-machine path in a teammate\'s JSON bundle');
  assert.ok(!markdown.includes(AUTHOR_PATH), 'nor printed in the markdown');
});

test('the graph inside the bundle obeys the same rule', async () => {
  // Each project carries its knowledge graph, and the graph reads fan out past
  // the project they were asked about.
  const node = await store.upsertGraphNode({
    node_id: `graph_node_${crypto.randomUUID()}`,
    owner_key: ORG,
    project_id: personalProject.project_id,
    node_type: 'knowledge',
    canonical_key: `knowledge:export-secret-${RUN}`,
    title: `Graph ${SECRET}`,
    summary: `Graph ${SECRET} summary long enough to survive the graph node summary rules`,
    metadata: { entity_type: 'knowledge', scope: 'project', importance: 'high', status: 'active' },
    confidence: 0.9,
    source_session_id: '',
    source_tool: 'claude_code',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
  });
  assert.ok(node.node_id, 'precondition: the node was seeded');

  const { json } = await exportStrings(bob());
  assert.ok(!json.includes(`Graph ${SECRET}`), 'a node from a hidden project is not in a teammate\'s bundle');
});
