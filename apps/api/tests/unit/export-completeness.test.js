'use strict';

/**
 * The export says "everything DeerDawn holds for you", and account deletion
 * emails the Markdown copy as "the last copy we hold" before the purge erases
 * the lot. So anything the export leaves out is not merely missing from a
 * download: it is destroyed without a copy.
 *
 * It left out a great deal, and said nothing:
 *   - ARCHIVED projects. Projects auto-archive after 30 idle days, so this is the
 *     normal state of any older project, and exportContext listed live ones only.
 *   - WORKSPACE-SCOPED entities (graph nodes with no project). Only per-project
 *     graphs were collected.
 *   - SKILLS, in any format.
 *   - In the Markdown (the copy that is emailed): the task board, findings, known
 *     paths, decisions, questions, goals, stack, constraints — everything but the
 *     profile, the task, the status, linked paths and graph node titles.
 *   - And any read that failed was swallowed into an empty result, so a DB
 *     hiccup produced a well-formed export with no projects or no graph in it.
 *
 * Every seeded value carries a unique marker, and each marker has to be found in
 * BOTH formats: the JSON (machine-readable, the one importers read) and the
 * Markdown (the one a person reads, and the one the deletion email attaches).
 *
 * The team half pins the other direction: completeness must not become a leak.
 * The export contains nothing the same person could not read through the normal
 * surfaces — a colleague's personal project, archived or not, a section a share
 * withholds, a skill filed in a project they cannot open, a node private to
 * somebody else.
 *
 * DB-backed; run via scripts/run-db-test.sh node --test tests/unit/export-completeness.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const db = require('../../src/config/db');
const workspace = require('../../src/services/workspaceService');
const exportMarkdown = require('../../src/services/contextExportMarkdown');
const { ContextObjectSchema, GlobalContextSchema } = require('../../../../packages/shared-context/src/index.js');
const { closeRedisConnections } = require('../../src/config/redis');

const { renderContextExportMarkdown } = exportMarkdown;

// Capital letters only, because graph node titles are re-cased and split on read
// (graphNodeTitle.js: "S7MKab" comes back "S7 Mkab"), and an all-capitals word
// with no digit in it is the one form they keep verbatim.
const RUN = [...crypto.randomBytes(8)].map((byte) => String.fromCharCode(65 + (byte % 26))).join('');
const mark = (label) => `${label}${RUN}`;

// ── A solo account on the Free plan ─────────────────────────────────────────
// Free, so the 90-day history window exists for this owner: the export has to
// return the full stored history regardless (it is not a brief).
const SOLO = `org-${crypto.randomUUID()}`;
const SAM = `user-export-sam-${RUN}`;
const sam = () => ({ type: 'user', id: SAM, org_id: SOLO, workspace_key: SOLO, role: 'admin' });

const M = {
  profile: mark('PROFILE'),
  desc: mark('DESCRIPTION'),
  goal: mark('GOAL'),
  stack: mark('STACK'),
  constraint: mark('CONSTRAINT'),
  task: mark('TASK'),
  status: mark('STATUS'),
  next: mark('NEXTACTION'),
  blocker: mark('BLOCKER'),
  progress: mark('PROGRESS'),
  decision: mark('DECISION'),
  agedDecision: mark('AGEDDECISION'),
  question: mark('QUESTION'),
  landmine: mark('LANDMINE'),
  shipped: mark('SHIPPED'),
  command: mark('COMMAND'),
  entry: mark('ENTRYPOINT'),
  surface: mark('SURFACE'),
  files: mark('FILES'),
  cardBacklog: mark('CARDBACKLOG'),
  cardBody: mark('CARDBODY'),
  cardProgress: mark('CARDINPROGRESS'),
  cardBlocked: mark('CARDBLOCKED'),
  cardDone: mark('CARDDONE'),
  finding: mark('FINDING'),
  hotpath: mark('KNOWNPATH'),
  linked: `/Users/sam-${RUN}/work/linked-${RUN}`,
  entity: mark('PROJECTENTITY'),
  entitySummary: mark('PROJECTENTITYSUMMARY'),
  relation: mark('RELATION'),
  archTask: mark('ARCHIVEDTASK'),
  archDecision: mark('ARCHIVEDDECISION'),
  archEntity: mark('ARCHIVEDENTITY'),
  ws: mark('WORKSPACEENTITY'),
  wsSummary: mark('WORKSPACEENTITYSUMMARY'),
  skillDesc: mark('SKILLDESCRIPTION'),
  skillBody: mark('SKILLBODY'),
  pskillBody: mark('PROJECTSKILLBODY'),
};

let liveProject;
let archivedProject;

// ── A two-person team ───────────────────────────────────────────────────────
const TEAM = `org-${crypto.randomUUID()}`;
const ALICE = `user-export-alice-${RUN}`; // workspace owner
const BOB = `user-export-bob-${RUN}`;     // member
const alice = () => ({ type: 'user', id: ALICE, org_id: TEAM, workspace_key: TEAM, role: 'admin' });
const bob = () => ({ type: 'user', id: BOB, org_id: TEAM, workspace_key: TEAM, role: 'admin' });

const T = {
  personal: mark('TPERSONAL'),
  personalArchived: mark('TPERSONALARCHIVED'),
  sharedTask: mark('TSHAREDTASK'),
  withheld: mark('TWITHHELDGOAL'),
  sharedArchivedTask: mark('TSHAREDARCHIVEDTASK'),
  withheldArchived: mark('TWITHHELDARCHIVEDGOAL'),
  personalSkill: mark('TPERSONALSKILL'),
  teamSkill: mark('TTEAMSKILL'),
  privateEntity: mark('TPRIVATEENTITY'),
  teamEntity: mark('TTEAMENTITY'),
};

async function setVisibility(ownerKey, projectId, visibility) {
  const row = await store.getProject(ownerKey, projectId);
  await store.saveProject({ ...row, visibility }, null);
}

async function seedWorkspaceNode(ownerKey, { title, summary, metadata = {} }) {
  const now = new Date().toISOString();
  return store.upsertGraphNode({
    node_id: `graph_node_${crypto.randomUUID()}`,
    owner_key: ownerKey,
    project_id: null,
    node_type: 'knowledge',
    canonical_key: `knowledge:${title.toLowerCase()}`,
    title,
    summary,
    metadata: { entity_type: 'knowledge', scope: 'workspace', importance: 'high', status: 'active', ...metadata },
    confidence: 0.9,
    source_session_id: '',
    source_tool: 'claude_code',
    created_at: now,
    updated_at: now,
    last_seen_at: now,
  });
}

// Both renderings of one bundle, as strings: "present" and "absent" have to hold
// for the machine-readable copy and the human-readable one alike.
async function exportStrings(actor) {
  const bundle = await service.exportContext(actor);
  return { bundle, json: JSON.stringify(bundle), markdown: renderContextExportMarkdown(bundle) };
}

test.before(async () => {
  // ── solo ──
  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status) VALUES ($1, $2, $3, $4, $5)',
    [SOLO, `Export solo ${RUN}`, 'free', 'free', 'active'],
    'org-system',
  );
  await workspace.addMember(SOLO, SAM, { role: 'owner' });
  await service.updateGlobalContext(sam(), { user_profile: `Sam builds things ${M.profile}` });

  liveProject = await service.createProject(sam(), { project_name: `Export live ${RUN}` });
  const livePid = liveProject.project_id;
  const agedAt = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
  await service.updateProjectContext(sam(), livePid, {
    description: `The live project ${M.desc} for the export`,
    goals: [`Reach ${M.goal} this quarter`],
    tech_stack: [`Postgres ${M.stack}`],
    recurring_context: [`Never ship on Fridays ${M.constraint}`],
    current_task: `Build the ${M.task} export`,
    current_status: `Halfway there ${M.status} today`,
    next_action: `Write the ${M.next} renderer`,
    blocking_issue: `Waiting on review ${M.blocker} from the lead`,
    task_progress: `Two of three parts ${M.progress} done`,
    recent_decisions: [
      { summary: `Decided ${M.decision} to render from keys`, decided_at: new Date().toISOString() },
      // Older than Free's 90-day window: hidden from a Free BRIEF, never deleted,
      // and so never missing from the export.
      { summary: `Decided ${M.agedDecision} long ago`, decided_at: agedAt },
    ],
    open_questions: [`Should ${M.question} be cached?`],
    landmines: [{ summary: `Never run the migration twice ${M.landmine}` }],
    shipped: [{ summary: `Shipped the ${M.shipped} importer` }],
    commands: [{ label: 'test', run: `npm test -- ${M.command}` }],
    entrypoints: [{ label: 'server', path: `src/${M.entry}.js` }],
    surfaces: [{ label: `Settings page ${M.surface}`, paths: ['apps/dashboard/src/pages/settings/data.tsx'] }],
    file_structure_summary: [`apps/api holds ${M.files}`],
    add_todos: [
      { title: `Backlog card ${M.cardBacklog}`, body: `The detail of the card ${M.cardBody}`, phase: 'backlog' },
      { title: `In progress card ${M.cardProgress}`, phase: 'in_progress' },
      { title: `Blocked card ${M.cardBlocked}`, phase: 'blocked' },
      { title: `Done card ${M.cardDone}`, phase: 'done' },
    ],
  });
  await service.recordDebugFinding(sam(), livePid, { summary: `The cache collides ${M.finding} under load`, paths: ['src/cache.js'] });
  await service.recordHotPaths(sam(), livePid, [{ label: 'export route', path: `src/routes/${M.hotpath}.js` }]);
  const liveRow = await store.getProject(SOLO, livePid);
  await store.saveProject({ ...liveRow, linked_paths: [M.linked] }, null);
  const pipelineKey = `component:export-pipeline-${RUN.toLowerCase()}`;
  const queueKey = `component:render-queue-${RUN.toLowerCase()}`;
  await service.upsertWorkspaceEntities(sam(), {
    project_id: livePid,
    entities: [
      { title: `Export pipeline ${M.entity}`, canonical_key: pipelineKey, entity_type: 'component', summary: `Renders bundles ${M.entitySummary}`, project_id: livePid, scope: 'project' },
      { title: `Render queue ${RUN}`, canonical_key: queueKey, entity_type: 'component', summary: 'Queues bundles for rendering in order', project_id: livePid, scope: 'project' },
    ],
    // A relation a caller states carries its own words.
    relations: [{ from_canonical_key: pipelineKey, to_canonical_key: queueKey, relation_type: 'depends_on', summary: `The pipeline waits on the queue ${M.relation}` }],
  });

  archivedProject = await service.createProject(sam(), { project_name: `Export archived ${RUN}` });
  const archPid = archivedProject.project_id;
  await service.updateProjectContext(sam(), archPid, {
    current_task: `Finish the ${M.archTask} work`,
    recent_decisions: [{ summary: `Decided ${M.archDecision} before it went quiet` }],
  });
  await service.upsertWorkspaceEntities(sam(), {
    project_id: archPid,
    entities: [{ title: `Old worker ${M.archEntity}`, entity_type: 'component', summary: 'the worker the archived project ran', project_id: archPid, scope: 'project' }],
  });
  await service.archiveProject(sam(), archPid);

  await service.upsertWorkspaceEntities(sam(), {
    entities: [{ title: `Shared platform ${M.ws}`, entity_type: 'component', summary: `Used everywhere ${M.wsSummary}`, scope: 'workspace' }],
  });

  await service.upsertSkill(sam(), {
    name: `Export skill ${RUN}`,
    description: `How to export ${M.skillDesc}`,
    markdown_content: `# Exporting\n\nAlways check ${M.skillBody} first.\n`,
  });
  await service.upsertSkill(sam(), {
    project_id: livePid,
    name: `Project skill ${RUN}`,
    description: 'Only for the live project',
    markdown_content: `Run ${M.pskillBody} before release.`,
  });

  // ── team ──
  await workspace.addMember(TEAM, ALICE, { role: 'owner' });
  await workspace.addMember(TEAM, BOB, { role: 'member' });

  const personal = await service.createProject(alice(), { project_name: `Team personal ${RUN}` });
  await service.updateProjectContext(alice(), personal.project_id, { current_task: `Side work ${T.personal}` });
  await setVisibility(TEAM, personal.project_id, 'personal');

  const personalArchived = await service.createProject(alice(), { project_name: `Team personal archived ${RUN}` });
  await service.updateProjectContext(alice(), personalArchived.project_id, { current_task: `Old side work ${T.personalArchived}` });
  await setVisibility(TEAM, personalArchived.project_id, 'personal');
  await service.archiveProject(alice(), personalArchived.project_id);

  const shared = await service.createProject(alice(), { project_name: `Team shared ${RUN}` });
  // `goals` is outside DEFAULT_SHARED_SECTIONS: the project is shared, the goals
  // are not. An array, because a bare string is coerced to [] and would make
  // "withheld" pass on a value that was never written.
  await service.updateProjectContext(alice(), shared.project_id, { current_task: `Team work ${T.sharedTask}`, goals: [`Private aim ${T.withheld}`] });
  await setVisibility(TEAM, shared.project_id, 'shared');

  const sharedArchived = await service.createProject(alice(), { project_name: `Team shared archived ${RUN}` });
  await service.updateProjectContext(alice(), sharedArchived.project_id, { current_task: `Old team work ${T.sharedArchivedTask}`, goals: [`Old private aim ${T.withheldArchived}`] });
  await setVisibility(TEAM, sharedArchived.project_id, 'shared');
  await service.archiveProject(alice(), sharedArchived.project_id);

  await service.upsertSkill(alice(), { project_id: personal.project_id, name: `Alice personal skill ${RUN}`, markdown_content: `Personal know-how ${T.personalSkill}` });
  await service.upsertSkill(alice(), { name: `Team skill ${RUN}`, markdown_content: `Team know-how ${T.teamSkill}` });

  // private_to is server-only metadata (the founder's pre-team no-project nodes),
  // so it is seeded at the store, the way the ownership backfill writes it.
  await seedWorkspaceNode(TEAM, { title: `Alice only ${T.privateEntity}`, summary: 'a note private to its author', metadata: { private_to: ALICE } });
  await seedWorkspaceNode(TEAM, { title: `Team fact ${T.teamEntity}`, summary: 'a workspace fact every member reads' });
});

test.after(async () => {
  for (const ownerKey of [SOLO, TEAM]) {
    for (const table of [
      'context_graph_evidence', 'context_graph_edges', 'context_graph_nodes', 'workspace_skills',
      'context_sessions', 'context_project_shares', 'context_projects', 'context_globals',
      'injection_preferences', 'workspace_members',
    ]) {
      try { await db.query(`DELETE FROM ${table} WHERE owner_key = $1`, [ownerKey], 'org-system'); } catch (_) { /* best effort */ }
    }
  }
  try { await db.query('DELETE FROM organizations WHERE org_id = $1', [SOLO], 'org-system'); } catch (_) { /* best effort */ }
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});

test('every section a person wrote is in the JSON bundle and in the Markdown', async () => {
  const { json, markdown } = await exportStrings(sam());
  const missingFromJson = Object.entries(M).filter(([, value]) => !json.includes(value)).map(([key]) => key);
  const missingFromMarkdown = Object.entries(M).filter(([, value]) => !markdown.includes(value)).map(([key]) => key);
  // One assertion over both, so a failure names every gap in each format at once.
  assert.deepEqual(
    { json: missingFromJson, markdown: missingFromMarkdown },
    { json: [], markdown: [] },
    'nothing stored is missing from either export',
  );
});

test('an archived project is exported, and marked archived with its date', async () => {
  const { bundle, markdown } = await exportStrings(sam());
  const archived = bundle.projects.find((p) => p.project_id === archivedProject.project_id);
  assert.ok(archived, 'the archived project is in the bundle');
  assert.equal(archived.archived, true, 'marked as archived');
  assert.ok(Number.isFinite(Date.parse(archived.archived_at)), 'with the date it was archived');
  const live = bundle.projects.find((p) => p.project_id === liveProject.project_id);
  assert.equal(live.archived, false, 'a live project says so');
  assert.equal(live.archived_at, null);
  assert.match(markdown, new RegExp(`### Export archived ${RUN} \\(archived\\)`), 'the Markdown heading says it is archived');
});

test('the task board travels by column, card text and body included', async () => {
  const { markdown } = await exportStrings(sam());
  const section = (label) => {
    const start = markdown.indexOf(`**${label}**`);
    assert.ok(start >= 0, `the ${label} column is rendered`);
    const rest = markdown.slice(start + label.length + 4);
    const next = rest.search(/\n- \*\*|\n\*\*|\n#/);
    return next < 0 ? rest : rest.slice(0, next);
  };
  assert.ok(section('Backlog').includes(M.cardBacklog), 'a backlog card sits under Backlog');
  assert.ok(section('Backlog').includes(M.cardBody), 'with its body');
  assert.ok(section('In Progress').includes(M.cardProgress), 'an in-progress card sits under In Progress');
  assert.ok(section('Blocked').includes(M.cardBlocked), 'a blocked card sits under Blocked');
  assert.ok(section('Done').includes(M.cardDone), 'a done card sits under Done');
});

test('the plan history window hides entries from a Free brief, never from the export', async () => {
  // Precondition: the window is real for this owner, or the assertion below
  // proves nothing.
  const windowed = await service.applyPlanHistoryWindow(sam(), (await store.getProject(SOLO, liveProject.project_id)).context);
  assert.ok(windowed.agedOut > 0, 'precondition: a Free brief ages the old decision out');

  const { json, markdown } = await exportStrings(sam());
  assert.ok(json.includes(M.agedDecision), 'the JSON export still carries it');
  assert.ok(markdown.includes(M.agedDecision), 'and so does the Markdown');
});

test('every key the bundle carries is rendered or deliberately listed as not rendered', async () => {
  const { bundle } = await exportStrings(sam());
  assert.deepEqual(exportMarkdown.unaccountedKeys(bundle), [], 'a real, fully seeded bundle has no key the renderer ignores');

  // A key added to the schema later fails here even before any fixture writes it.
  const schemaBundle = {
    ...bundle,
    global_context: Object.fromEntries(Object.keys(GlobalContextSchema.shape).map((key) => [key, ''])),
    projects: [{ ...bundle.projects[0], context: Object.fromEntries(Object.keys(ContextObjectSchema.shape).map((key) => [key, ''])) }],
  };
  assert.deepEqual(exportMarkdown.unaccountedKeys(schemaBundle), [], 'every field the context and profile schemas declare is accounted for');
});

test('a section the renderer has never heard of still reaches the Markdown', async () => {
  // The runtime half of the rule above: a key that slips past the test is
  // printed generically, never dropped.
  const { bundle } = await exportStrings(sam());
  const novel = {
    ...bundle,
    novel_top_level: mark('NOVELTOP'),
    global_context: { ...bundle.global_context, novel_profile_field: [mark('NOVELPROFILE')] },
    projects: bundle.projects.map((p, i) => (i === 0 ? { ...p, novel_project_field: mark('NOVELPROJECT'), context: { ...p.context, novel_section: { note: mark('NOVELSECTION') } } } : p)),
  };
  const markdown = renderContextExportMarkdown(novel);
  for (const marker of ['NOVELTOP', 'NOVELPROFILE', 'NOVELPROJECT', 'NOVELSECTION']) {
    assert.ok(markdown.includes(mark(marker)), `${marker} is rendered`);
  }
  assert.deepEqual(
    exportMarkdown.unaccountedKeys(novel).sort(),
    ['global_context.novel_profile_field', 'novel_top_level', 'projects[].context.novel_section', 'projects[].novel_project_field'],
    'and the check names each one',
  );
});

test('a graph read that fails fails the export instead of exporting an empty graph', async () => {
  const real = store.listGraphNodesForProject;
  store.listGraphNodesForProject = async () => { throw new Error('graph read failed'); };
  try {
    await assert.rejects(service.exportContext(sam()), /graph read failed/, 'no export that silently lacks a graph');
  } finally {
    store.listGraphNodesForProject = real;
  }
});

test('after a failed read the export stops reading the remaining projects', async () => {
  // All or nothing, and the "nothing" should be cheap: an export that has already
  // failed must not go on to read every other project's graph for no one.
  const real = store.listGraphNodesForProject;
  let calls = 0;
  store.listGraphNodesForProject = async (...args) => {
    calls += 1;
    if (calls === 1) throw new Error('graph read failed');
    await new Promise((resolve) => setTimeout(resolve, 5));
    return real(...args);
  };
  const extra = [];
  try {
    for (let i = 0; i < 12; i += 1) {
      extra.push(await service.createProject(sam(), { project_name: `Export stop ${i} ${RUN}` }));
    }
    await assert.rejects(service.exportContext(sam()), /graph read failed/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(calls <= 4, `no more reads start once one has failed (${calls} graph reads for 14 projects)`);
  } finally {
    store.listGraphNodesForProject = real;
    for (const p of extra) {
      try { await db.query('DELETE FROM context_projects WHERE project_id = $1', [p.project_id], 'org-system'); } catch (_) { /* best effort */ }
    }
  }
});

test('a project listing that fails fails the export instead of exporting no projects', async () => {
  const real = store.listProjects;
  store.listProjects = async () => { throw new Error('project listing failed'); };
  try {
    await assert.rejects(service.exportContext(sam()), /project listing failed/, 'no export that silently lacks every project');
  } finally {
    store.listProjects = real;
  }
});

test('project reads are bounded, not fired for every project at once', async () => {
  // Every project's graph used to be read in one Promise.all. On a large account
  // that queued thousands of queries against a pool of ten behind breakers with
  // 5s and 8s timeouts: the best-effort graph reads time out (and used to come
  // back as empty graphs), and the main breaker can open for everyone.
  const extra = [];
  for (let i = 0; i < 12; i += 1) {
    extra.push(await service.createProject(sam(), { project_name: `Export fan-out ${i} ${RUN}` }));
  }
  const real = store.listGraphNodesForProject;
  let inFlight = 0;
  let peak = 0;
  store.listGraphNodesForProject = async (...args) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return await real(...args);
    } finally {
      inFlight -= 1;
    }
  };
  try {
    const bundle = await service.exportContext(sam());
    assert.ok(bundle.projects.length >= 13, 'precondition: every project was read');
    assert.ok(peak <= 4, `at most 4 projects are read at once (peak ${peak})`);
  } finally {
    store.listGraphNodesForProject = real;
    for (const p of extra) {
      try { await db.query('DELETE FROM context_projects WHERE project_id = $1', [p.project_id], 'org-system'); } catch (_) { /* best effort */ }
    }
  }
});

// ── the team: completeness must not become a leak ───────────────────────────

test('a member exports what the team shares, archived projects and workspace entities included', async () => {
  const { json, markdown } = await exportStrings(bob());
  for (const [label, marker] of [
    ['a live shared project', T.sharedTask],
    ['an archived shared project', T.sharedArchivedTask],
    ['a workspace-wide skill', T.teamSkill],
    ['a workspace entity every member reads', T.teamEntity],
  ]) {
    assert.ok(json.includes(marker), `${label} is in the member's JSON`);
    assert.ok(markdown.includes(marker), `${label} is in the member's Markdown`);
  }
});

test('a member\'s export carries nothing the member could not read elsewhere', async () => {
  const authors = await exportStrings(alice());
  for (const marker of Object.values(T)) {
    assert.ok(authors.json.includes(marker), `precondition: the author exports ${marker}`);
  }

  const { json, markdown } = await exportStrings(bob());
  for (const [label, marker] of [
    ['a colleague\'s personal project', T.personal],
    ['a colleague\'s ARCHIVED personal project', T.personalArchived],
    ['a section the share withholds', T.withheld],
    ['a withheld section of an archived shared project', T.withheldArchived],
    ['a skill filed in a project the member cannot open', T.personalSkill],
    ['a workspace node private to somebody else', T.privateEntity],
  ]) {
    assert.ok(!json.includes(marker), `${label} is not in the member's JSON`);
    assert.ok(!markdown.includes(marker), `${label} is not in the member's Markdown`);
  }
});
