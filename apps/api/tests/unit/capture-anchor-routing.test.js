/**
 * WHERE A CAPTURE LANDS: a real anchor qualifies on its own, and a directory
 * ABOVE the capture is not one.
 *
 * The Stop-hook flush POSTs a finished Claude Code conversation to /extraction
 * with the session's cwd, its repository identity (workspace_key) and no
 * project_id. A capture is about NEW work, so it shares little vocabulary with
 * what the project already stores. The routing heuristic judged it against a
 * 1.25 threshold that "inside a linked path" (1.1) could not clear on its own,
 * so a capture from a repo that IS linked to a project matched nothing, the
 * model proposed a project named after the conversation, and the capture was
 * filed into a new stray project. The next session in that repo had none of it.
 *
 * The first fix let any containing linked path anchor by itself, and that
 * swallowed whole trees: a first session opened in the home directory linked
 * ~ to "Personal Household Budget", and every later repo under ~ was captured
 * into it, rewrote its brief, and was linked to it for good. A linked path
 * anchors alone only when the capture IS that directory, or is below it in the
 * SAME repository.
 *
 * Every test runs the route's own two steps (runExtraction, then
 * applyExtraction) against a real database. The model is never called: axios
 * is replaced for extractionService only, and answers the way the model did
 * for the walker, proposing a brand-new project named after the conversation.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test --test-concurrency=1 tests/unit/capture-anchor-routing.test.js
 */

process.env.NODE_ENV = 'test';

const Module = require('module');

// Installed before anything loads extractionService, and scoped to it: every
// other module that requires axios gets the real one.
let modelReply = null;
const originalLoad = Module._load;
Module._load = function (request, parent) {
  if (request === 'axios' && parent && /extractionService\.js$/.test(parent.filename || '')) {
    return {
      post: async () => {
        if (!modelReply) throw new Error('model reply not stubbed');
        const content = JSON.stringify(modelReply);
        return { data: { content: [{ text: content }] } };
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

const SAVED_ENV = ['EXTRACTION_PROVIDER', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
const savedEnv = Object.fromEntries(SAVED_ENV.map((key) => [key, process.env[key]]));
// The extraction provider is the anthropic one, with a key that exists only so
// runExtraction reaches the (stubbed) model step instead of its no-key fallback.
// NOT the OpenAI one: OPENAI_API_KEY also switches on the graph embedding
// service, which would then call the real OpenAI API from applyExtraction.
process.env.EXTRACTION_PROVIDER = 'anthropic';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-capture-anchor-never-sent';
delete process.env.OPENAI_API_KEY;

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const service = require('../../src/services/contextSyncService');
const { runExtraction } = require('../../src/services/extractionService');
const store = require('../../src/store/contextSyncStore');
const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');

const RUN = crypto.randomBytes(4).toString('hex');
const ORGS = new Set();

function newOrg() {
  const org = `org-${crypto.randomUUID()}`;
  ORGS.add(org);
  return org;
}

function person(org, label) {
  return { org_id: org, id: `user-capture-anchor-${label}-${RUN}-${crypto.randomBytes(2).toString('hex')}` };
}

test.after(async () => {
  Module._load = originalLoad;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const org of ORGS) {
    try {
      await db.query('DELETE FROM context_workspace_pointers WHERE owner_key = $1', [org], 'org-system');
      await db.query('DELETE FROM context_sessions WHERE owner_key = $1', [org], 'org-system');
      await db.query('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [org], 'org-system');
      await db.query('DELETE FROM context_projects WHERE owner_key = $1', [org], 'org-system');
      await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [org], 'org-system');
    } catch (_) { /* best effort */ }
  }
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});

// What the model answered for the walker: new work, so a new project named
// after it. `marker` rides on the decision so the test can find where it went.
function proposesNewProject(marker, name = `Quokkabase Invoice Exporter ${RUN}`) {
  return {
    match_decision: 'new_project',
    confidence: 0.9,
    project_candidate: { project_name: name, reason: 'new work in this conversation', score: 0.9 },
    delta: {
      recent_decisions: [{
        summary: `Invoices are exported nightly to the Quokkabase warehouse (${marker})`,
        headline: `Invoices export nightly to the Quokkabase warehouse (${marker})`,
        decided_at: new Date().toISOString(),
        importance: 'high',
      }],
    },
    should_create_project: true,
    needs_user_confirmation: false,
    no_material_change: false,
  };
}

// The conversation the walker's Stop hook flushed. Nothing in it appears in
// the stored text of the projects below unless a test puts it there.
const QUOKKABASE_CHAT = [
  { role: 'user', text: 'Can you wire the invoice exporter to our warehouse?' },
  { role: 'assistant', text: 'I wired the invoice exporter to the Quokkabase warehouse in src/billing/export.ts. Decision: invoices are exported nightly to Quokkabase.' },
  { role: 'user', text: 'Great. Also add a test.' },
  { role: 'assistant', text: 'Added src/billing/export.test.ts for the Quokkabase nightly export. All tests pass.' },
];

// The route's own two steps, with the payload the Stop-hook flush sends.
// `workspaceKey` is what the flush derives from git (packages/mcp-server
// getWorkspaceKey): `remote:<origin>`, `root:<repo dir name>`, or nothing
// outside a repository.
async function flush(actor, { sessionId, cwd, workspaceKey, chunks = QUOKKABASE_CHAT, conversationRef, host = 'claude_code', surfaceType = 'code' }) {
  const input = {
    session_id: sessionId,
    tool: 'claude_code',
    chunks,
    session_context: {
      ...(cwd ? { cwd } : {}),
      conversation_ref: conversationRef || sessionId,
      ...(host ? { host } : {}),
      surface_type: surfaceType,
      ...(workspaceKey ? { workspace_key: workspaceKey } : {}),
    },
  };
  const extraction = await runExtraction(actor, input);
  const applied = await service.applyExtraction(actor, { ...input, extraction });
  return { extraction, applied };
}

const newSession = () => `cc-${crypto.randomUUID()}`;

async function projectCount(org) {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM context_projects WHERE owner_key = $1', [org], 'org-system');
  return rows[0].n;
}

async function stored(org, projectId) {
  const project = await store.getProject(org, projectId);
  return { text: JSON.stringify(project?.context || {}), linkedPaths: project?.linked_paths || [] };
}

test('a capture from a linked directory itself lands in that directory\'s project, whatever it talks about', async () => {
  const org = newOrg();
  const ana = person(org, 'ana');
  const root = `/Users/ana-${RUN}/code`;
  // Stored text chosen to share no vocabulary with the Quokkabase conversation,
  // and no repository identity on either side: the directory alone decides.
  const ledger = await service.createProject(ana, {
    project_name: `Ledger ${RUN}`,
    linked_paths: [`${root}/ledger`],
    current_task: 'Reconcile ledger rows',
    tech_stack: ['Rust'],
  });
  const atlas = await service.createProject(ana, {
    project_name: `Atlas ${RUN}`,
    linked_paths: [`${root}/atlas-web`],
    current_task: 'Polish map tiles',
    tech_stack: ['Elm'],
  });
  const before = await projectCount(org);

  modelReply = proposesNewProject(`FD-ledger-${RUN}`);
  const first = await flush(ana, { sessionId: newSession(), cwd: `${root}/ledger` });
  assert.equal(
    first.applied?.project?.project_id,
    ledger.project_id,
    `the capture from ${root}/ledger was filed into "${first.applied?.project?.project_name}" instead of the project linked to that directory`
  );

  modelReply = proposesNewProject(`FD-atlas-${RUN}`);
  const second = await flush(ana, { sessionId: newSession(), cwd: `${root}/atlas-web/` });
  assert.equal(second.applied?.project?.project_id, atlas.project_id, 'the second repo\'s capture must land in the second repo\'s project');

  assert.equal(await projectCount(org), before, 'a capture from a linked directory created a project');
  assert.ok((await stored(org, ledger.project_id)).text.includes(`FD-ledger-${RUN}`), 'the ledger capture\'s decision is in the ledger project');
  assert.ok((await stored(org, atlas.project_id)).text.includes(`FD-atlas-${RUN}`), 'the atlas capture\'s decision is in the atlas project');
  assert.ok(!(await stored(org, ledger.project_id)).text.includes(`FD-atlas-${RUN}`), 'nothing from the atlas repo leaked into the ledger project');
});

test('below a linked directory, the same repository anchors; an unknown identity does not', async () => {
  const org = newOrg();
  const ana = person(org, 'ana');
  const repo = `/Users/ana-${RUN}/code/ledger`;
  const identity = 'remote:github.com/ana/ledger';
  const ledger = await service.createProject(ana, {
    project_name: `Ledger ${RUN}`,
    linked_paths: [repo],
    workspace_key: identity,
    current_task: 'Reconcile ledger rows',
  });
  const before = await projectCount(org);

  modelReply = proposesNewProject(`FD-sub-${RUN}`);
  const same = await flush(ana, { sessionId: newSession(), cwd: `${repo}/src/billing`, workspaceKey: identity });
  assert.equal(same.applied?.project?.project_id, ledger.project_id, 'a sub-directory of the same repository belongs to the repository\'s project');
  assert.equal(await projectCount(org), before);

  // Nothing says which repository this is. Below a linked directory that is
  // not a tie on its own, so routing is what it was before any of this: the
  // path is worth 1.1 and needs vocabulary on top to qualify. None here.
  // (Another sub-directory: the write above linked src/billing itself.)
  modelReply = proposesNewProject(`FD-unknown-${RUN}`, `Unknown Identity ${RUN}`);
  const unknown = await runExtraction(ana, {
    session_id: newSession(),
    tool: 'claude_code',
    chunks: QUOKKABASE_CHAT,
    session_context: { cwd: `${repo}/docs`, host: 'claude_code', surface_type: 'code' },
  });
  assert.notEqual(unknown.project_candidate?.project_id, ledger.project_id, 'a directory above the capture anchored it with no repository identity');
});

test('a conversation the project has linked anchors a capture on its own', async () => {
  const org = newOrg();
  const ana = person(org, 'ana');
  const conversationRef = `https://chat.example.test/c/${crypto.randomUUID()}`;
  const topic = await service.createProject(ana, { project_name: `Garden Beds ${RUN}`, current_task: 'Order cedar planks' });
  // How a conversation gets linked: the confirm chip binds one tab to it.
  await service.bindSessionTopic(ana, {
    session_id: `tab-${crypto.randomUUID()}`,
    tool: 'claude_web',
    project_id: topic.project_id,
    conversation_ref: conversationRef,
  });
  const before = await projectCount(org);

  // The same conversation reopened in a new tab: a new session, no binding, no cwd.
  modelReply = proposesNewProject(`FD-conv-${RUN}`);
  const result = await flush(ana, {
    sessionId: `tab-${crypto.randomUUID()}`,
    conversationRef,
    host: null,
    surfaceType: 'browser',
  });
  assert.equal(result.applied?.project?.project_id, topic.project_id, 'the conversation is linked to this project, so its capture belongs there');
  assert.equal(await projectCount(org), before, 'a capture from a linked conversation created a project');
});

test('vocabulary alone still never qualifies a code project: an unlinked directory is not routed by what it talks about', async () => {
  const org = newOrg();
  const ana = person(org, 'ana');
  const root = `/Users/ana-${RUN}/code`;
  const exporter = await service.createProject(ana, {
    project_name: `Exporter ${RUN}`,
    linked_paths: [`${root}/exporter`],
    current_task: 'Wire the invoice exporter to the Quokkabase warehouse',
    current_status: 'Invoices export nightly to Quokkabase; adding tests for the nightly export',
    tech_stack: ['TypeScript', 'Quokkabase'],
    file_structure_summary: ['src/billing/export.ts', 'src/billing/export.test.ts'],
  });

  // Same conversation, from a directory nobody has linked. It overlaps the
  // exporter's stored text heavily, and that is still not a fact tying the
  // session to it.
  modelReply = proposesNewProject(`FD-unlinked-${RUN}`);
  const extraction = await runExtraction(ana, {
    session_id: newSession(),
    tool: 'claude_code',
    chunks: QUOKKABASE_CHAT,
    session_context: { cwd: `${root}/scratch`, host: 'claude_code', surface_type: 'code' },
  });
  assert.notEqual(extraction.project_candidate?.project_id, exporter.project_id, 'shared vocabulary routed a capture into a code project with no anchor');
  assert.equal(extraction.match_decision, 'new_project', 'with no anchor the routing is left to the model, as before');
});

test('monorepo: the most specific linked path of the same repository wins, the same project start_session opens', async () => {
  const org = newOrg();
  const ana = person(org, 'ana');
  const mono = `/Users/ana-${RUN}/code/mono`;
  const identity = 'remote:github.com/ana/mono';
  // The umbrella's stored text shares the conversation's vocabulary; the package
  // it contains shares none. Vocabulary must not decide between two anchors of
  // different specificity.
  const umbrella = await service.createProject(ana, {
    project_name: `Mono ${RUN}`,
    linked_paths: [mono],
    workspace_key: identity,
    current_task: 'Wire the invoice exporter to the Quokkabase warehouse',
    current_status: 'Invoices export nightly to Quokkabase',
    file_structure_summary: ['src/billing/export.ts'],
  });
  // A work-stream of the umbrella inherits its repository identity.
  const pkg = await service.createProject(ana, {
    project_name: `Payments package ${RUN}`,
    parent_project_id: umbrella.project_id,
    linked_paths: [`${mono}/packages/payments`],
    current_task: 'Reconcile ledger rows',
  });
  const cwd = `${mono}/packages/payments/src`;
  const before = await projectCount(org);

  const started = await service.resolveActiveProject(ana, cwd, identity);
  assert.equal(started?.project_id, pkg.project_id, 'precondition: start_session in this directory opens the package');

  modelReply = proposesNewProject(`FD-nested-${RUN}`);
  const result = await flush(ana, { sessionId: newSession(), cwd, workspaceKey: identity });
  assert.equal(
    result.applied?.project?.project_id,
    started.project_id,
    `a session that starts in "${started.project_name}" captured into "${result.applied?.project?.project_name}"`
  );
  assert.ok(!(await stored(org, umbrella.project_id)).text.includes(`FD-nested-${RUN}`), 'the umbrella did not receive the package\'s capture');
  assert.equal(await projectCount(org), before);

  // Elsewhere in the same repository, outside the package: the umbrella.
  modelReply = proposesNewProject(`FD-umbrella-${RUN}`);
  const atRoot = await flush(ana, { sessionId: newSession(), cwd: `${mono}/apps/web`, workspaceKey: identity });
  assert.equal(atRoot.applied?.project?.project_id, umbrella.project_id);
  assert.equal(await projectCount(org), before);
});

test('a linked home directory does not swallow the repositories under it', async () => {
  const org = newOrg();
  const dana = person(org, 'dana');
  const home = `/Users/dana-${RUN}`;
  // The first Claude Code session ran in ~, which is not a repository, and its
  // capture made this project and linked ~ to it.
  const household = await service.createProject(dana, {
    project_name: `Personal Household Budget ${RUN}`,
    linked_paths: [home],
    current_task: 'Track expenses weekly in a Google Sheet',
  });

  const cases = [
    { label: 'with a remote', cwd: `${home}/code/trailhead-blog`, workspaceKey: 'remote:github.com/dana/trailhead-blog' },
    { label: 'with no remote', cwd: `${home}/work/invoice-api`, workspaceKey: 'root:invoice-api' },
  ];
  for (const [index, { label, cwd, workspaceKey }] of cases.entries()) {
    const before = await projectCount(org);
    modelReply = proposesNewProject(`FD-home-${index}-${RUN}`, `Home Case ${index} ${RUN}`);
    const result = await flush(dana, { sessionId: newSession(), cwd, workspaceKey });
    assert.notEqual(result.applied?.project?.project_id, household.project_id, `a repo ${label} under ~ was captured into the home directory's project`);
    assert.equal(await projectCount(org), before + 1, `the repo ${label} gets its own project, as it always did`);
  }

  const after = await stored(org, household.project_id);
  assert.deepEqual(after.linkedPaths, [home], 'a swallowed capture linked its repository to the home directory\'s project for good');
  assert.ok(!after.text.includes('FD-home-'), 'the home directory\'s brief was rewritten by a repository under it');

  // A plain folder under a plain linked ~ (no repository on either side) IS the
  // home project's: nothing says it is anything else (owner decision, round 6).
  const before = await projectCount(org);
  modelReply = proposesNewProject(`FD-home-plain-${RUN}`, `Home Plain ${RUN}`);
  const plain = await flush(dana, { sessionId: newSession(), cwd: `${home}/Downloads/scratch`, workspaceKey: null });
  assert.equal(plain.applied?.project?.project_id, household.project_id, 'a plain folder under a plain linked ~ belongs to it');
  assert.equal(await projectCount(org), before, 'no project was created for it');
});

test('a home directory that is itself a repository still does not own a different repository under it', async () => {
  const org = newOrg();
  const dana = person(org, 'dana');
  const home = `/Users/dana-${RUN}`;
  const dotfiles = await service.createProject(dana, {
    project_name: `Dotfiles ${RUN}`,
    linked_paths: [home],
    workspace_key: 'remote:github.com/dana/dotfiles',
    current_task: 'Tidy the zsh config',
  });
  modelReply = proposesNewProject(`FD-dot-${RUN}`, `Dot Case ${RUN}`);
  const other = await flush(dana, { sessionId: newSession(), cwd: `${home}/code/trailhead-blog`, workspaceKey: 'remote:github.com/dana/trailhead-blog' });
  assert.notEqual(other.applied?.project?.project_id, dotfiles.project_id);

  // A directory inside the dotfiles repository IS that repository.
  modelReply = proposesNewProject(`FD-dot-own-${RUN}`, `Dot Own ${RUN}`);
  const own = await flush(dana, { sessionId: newSession(), cwd: `${home}/.config/nvim`, workspaceKey: 'remote:github.com/dana/dotfiles' });
  assert.equal(own.applied?.project?.project_id, dotfiles.project_id);
});

test('a linked parent folder does not swallow a sibling repository', async () => {
  const org = newOrg();
  const ana = person(org, 'ana');
  const work = `/Users/ana-${RUN}/work`;
  const notes = await service.createProject(ana, {
    project_name: `Work Notes ${RUN}`,
    linked_paths: [work],
    current_task: 'Plan the quarter',
  });
  const before = await projectCount(org);
  modelReply = proposesNewProject(`FD-sibling-${RUN}`, `Sibling Case ${RUN}`);
  const result = await flush(ana, { sessionId: newSession(), cwd: `${work}/other`, workspaceKey: 'root:other' });
  assert.notEqual(result.applied?.project?.project_id, notes.project_id, 'a repository beside the linked one was captured into the parent folder\'s project');
  assert.equal(await projectCount(org), before + 1);
  assert.deepEqual((await stored(org, notes.project_id)).linkedPaths, [work]);
});

test('two projects linked to the same directory: the capture goes where start_session goes, and creates nothing', async () => {
  const org = newOrg();
  const ana = person(org, 'ana');
  const twin = `/Users/ana-${RUN}/code/twin`;
  await service.createProject(ana, { project_name: `Twin Alpha ${RUN}`, current_task: 'Draft the alpha plan' });
  await service.createProject(ana, { project_name: `Twin Beta ${RUN}`, current_task: 'Draft the beta plan' });
  // A row from before claimablePaths refused a second claim on one directory.
  await db.query(
    'UPDATE context_projects SET linked_paths = ARRAY[$2]::text[] WHERE owner_key = $1',
    [org, twin],
    'org-system'
  );
  const before = await projectCount(org);

  const started = await service.resolveActiveProject(ana, twin);
  modelReply = proposesNewProject(`FD-twin-${RUN}`, `Twin Gamma ${RUN}`);
  const result = await flush(ana, { sessionId: newSession(), cwd: twin });
  assert.equal(result.applied?.project?.project_id, started.project_id, 'the capture and start_session disagree on a tie');
  assert.equal(await projectCount(org), before);
});

// A session BOUND to one project whose cwd is another project's directory.
// What should happen there is an open product question, so these pin that it
// routes exactly as it did before anchors qualified alone: the candidates
// qualify on `qualifying >= 1.25` alone, vocabulary included, so stale_binding
// fires in the cases it always fired in and no others. Letting the directory's
// project qualify on its anchor here made it outrank the binding (1.1 plus the
// 0.45 resemblance its own linked path always earns, over 1.4) and answer
// stale_binding, which writes nothing: the capture was dropped.
async function boundScene(label, { bVocabulary = false } = {}) {
  const org = newOrg();
  const ana = person(org, label);
  const root = `/Users/ana-${RUN}-${label}/code`;
  const ledger = await service.createProject(ana, { project_name: `Ledger ${RUN}`, linked_paths: [`${root}/ledger`], current_task: 'Reconcile ledger rows' });
  const settlement = await service.createProject(ana, {
    project_name: `Settlement ${RUN}`,
    linked_paths: [`${root}/pay`],
    ...(bVocabulary
      ? {
        current_task: 'Wire the invoice exporter to the Quokkabase warehouse',
        current_status: 'Invoices export nightly to Quokkabase; adding tests for the nightly export',
        file_structure_summary: ['src/billing/export.ts', 'src/billing/export.test.ts'],
      }
      : { current_task: 'Retry payouts' }),
  });
  const sessionId = newSession();
  await service.upsertSession(ana, sessionId, { tool: 'claude_code', project_id: ledger.project_id });
  return { org, ana, root, ledger, settlement, sessionId, before: await projectCount(org) };
}

test('bound to A, working in B\'s linked directory, nothing in the capture pointing at B: written into A', async () => {
  const { org, ana, root, ledger, settlement, sessionId, before } = await boundScene('bound-plain');
  modelReply = proposesNewProject(`FD-bound-plain-${RUN}`, `Bound Plain ${RUN}`);
  const result = await flush(ana, { sessionId, cwd: `${root}/pay` });
  assert.equal(result.extraction.routing_state, 'matched', 'the capture was answered stale_binding and dropped');
  assert.equal(result.applied?.project?.project_id, ledger.project_id);
  assert.ok((await stored(org, ledger.project_id)).text.includes(`FD-bound-plain-${RUN}`), 'the capture\'s content was not written');
  assert.ok(!(await stored(org, settlement.project_id)).text.includes(`FD-bound-plain-${RUN}`));
  assert.equal((await store.getSession(org, sessionId))?.project_id, ledger.project_id);
  assert.equal(await projectCount(org), before);
});

test('bound to A, in B\'s linked directory, and the capture shares enough with B to qualify: stale_binding, as it always was', async () => {
  const { org, ana, root, ledger, settlement, sessionId, before } = await boundScene('bound-vocab', { bVocabulary: true });
  modelReply = proposesNewProject(`FD-bound-vocab-${RUN}`, `Bound Vocab ${RUN}`);
  const result = await flush(ana, { sessionId, cwd: `${root}/pay` });
  assert.equal(result.extraction.routing_state, 'stale_match');
  assert.ok(!(await stored(org, ledger.project_id)).text.includes(`FD-bound-vocab-${RUN}`));
  assert.ok(!(await stored(org, settlement.project_id)).text.includes(`FD-bound-vocab-${RUN}`));
  assert.equal((await store.getSession(org, sessionId))?.project_id, settlement.project_id);
  assert.equal(await projectCount(org), before);
});

test('bound to an A that has been archived, in B\'s linked directory: routed as it always was', async () => {
  const { org, ana, root, ledger, settlement, sessionId, before } = await boundScene('bound-archived');
  await service.archiveProject(ana, ledger.project_id);
  modelReply = proposesNewProject(`FD-bound-arch-${RUN}`, `Bound Archived ${RUN}`);
  const result = await flush(ana, { sessionId, cwd: `${root}/pay` });
  // Nothing qualifies (B has only its directory), so the model's proposal is
  // what lands: a new project, as it did before.
  assert.notEqual(result.extraction.routing_state, 'stale_match', 'the capture was answered stale_binding and dropped');
  assert.equal(result.applied?.project?.project_name, `Bound Archived ${RUN}`);
  assert.ok((await stored(org, result.applied.project.project_id)).text.includes(`FD-bound-arch-${RUN}`));
  assert.ok(!(await stored(org, settlement.project_id)).text.includes(`FD-bound-arch-${RUN}`));
  assert.equal(await projectCount(org), before + 1);
});

test('bound to an A this person can no longer read, in B\'s linked directory: routed as it always was', async () => {
  const { org, ana, root, ledger, settlement, sessionId, before } = await boundScene('bound-unreadable');
  // A became somebody else's personal project.
  await db.query(
    'UPDATE context_projects SET owner_user_id = $2, visibility = $3 WHERE project_id = $1',
    [ledger.project_id, `user-somebody-else-${RUN}`, 'personal'],
    'org-system'
  );
  modelReply = proposesNewProject(`FD-bound-gone-${RUN}`, `Bound Unreadable ${RUN}`);
  const result = await flush(ana, { sessionId, cwd: `${root}/pay` });
  assert.notEqual(result.extraction.routing_state, 'stale_match', 'the capture was answered stale_binding and dropped');
  assert.equal(result.applied?.project?.project_name, `Bound Unreadable ${RUN}`);
  assert.ok((await stored(org, result.applied.project.project_id)).text.includes(`FD-bound-gone-${RUN}`));
  assert.ok(!(await stored(org, settlement.project_id)).text.includes(`FD-bound-gone-${RUN}`));
  assert.ok(!(await stored(org, ledger.project_id)).text.includes(`FD-bound-gone-${RUN}`));
  assert.equal(await projectCount(org), before + 1);
});

test('bound to A, below B\'s directory with no repository identity: B is no anchor, the capture stays with A', async () => {
  const org = newOrg();
  const ana = person(org, 'ana');
  const root = `/Users/ana-${RUN}/code`;
  const ledger = await service.createProject(ana, { project_name: `Ledger ${RUN}`, linked_paths: [`${root}/ledger`], current_task: 'Reconcile ledger rows' });
  const settlement = await service.createProject(ana, { project_name: `Settlement ${RUN}`, linked_paths: [`${root}/pay`], current_task: 'Retry payouts' });
  const sessionId = newSession();
  await service.upsertSession(ana, sessionId, { tool: 'claude_code', project_id: ledger.project_id });
  const before = await projectCount(org);

  modelReply = proposesNewProject(`FD-bound-${RUN}`, `Bound Case ${RUN}`);
  const result = await flush(ana, { sessionId, cwd: `${root}/pay/src` });
  assert.equal(result.extraction.routing_state, 'matched');
  assert.equal(result.applied?.project?.project_id, ledger.project_id);
  assert.ok((await stored(org, ledger.project_id)).text.includes(`FD-bound-${RUN}`));
  assert.ok(!(await stored(org, settlement.project_id)).text.includes(`FD-bound-${RUN}`));
  assert.equal(await projectCount(org), before);
});
