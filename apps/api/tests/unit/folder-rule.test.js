/**
 * ONE FOLDER RULE, used by the resolver and by capture (journey round 3,
 * design A; owner decisions "one rule, one function" and "a capture is never
 * merged by name alone").
 *
 * The resolver (resolveActiveProject: which project a session or an explicit
 * write belongs to) and capture (runExtraction + applyExtraction: where the
 * end-of-session extraction is filed) used to read the linked paths, the
 * repository identity and the project name with different rules. Every case
 * below is asked of BOTH and they must give the same answer:
 *
 *   exact repo, subfolder, parent of another repository, unknown folder,
 *   repository identity alone, and a proposed name that matches a project the
 *   folder has nothing to do with.
 *
 * A parent folder of another or unknown repository is READ with a warning and
 * never written to. A capture is never merged into a project by name alone.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test --test-concurrency=1 tests/unit/folder-rule.test.js
 */

process.env.NODE_ENV = 'test';

const Module = require('module');

let modelReply = null;
const originalLoad = Module._load;
Module._load = function (request, parent) {
  if (request === 'axios' && parent && /extractionService\.js$/.test(parent.filename || '')) {
    return {
      post: async () => {
        if (!modelReply) throw new Error('model reply not stubbed');
        return { data: { content: [{ text: JSON.stringify(modelReply) }] } };
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

const SAVED_ENV = ['EXTRACTION_PROVIDER', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
const savedEnv = Object.fromEntries(SAVED_ENV.map((key) => [key, process.env[key]]));
process.env.EXTRACTION_PROVIDER = 'anthropic';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-folder-rule-never-sent';
delete process.env.OPENAI_API_KEY;

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const service = require('../../src/services/contextSyncService');
const { runExtraction } = require('../../src/services/extractionService');
const store = require('../../src/store/contextSyncStore');
const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');
const folderRule = require('../../src/services/folderRule');

const RUN = crypto.randomBytes(4).toString('hex');
const ORGS = new Set();

function newOrg() {
  const org = `org-${crypto.randomUUID()}`;
  ORGS.add(org);
  return org;
}

function person(org, label) {
  return { org_id: org, id: `user-folder-rule-${label}-${RUN}-${crypto.randomBytes(2).toString('hex')}` };
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

const CHAT = [
  { role: 'user', text: 'Can you wire the invoice exporter to our warehouse?' },
  { role: 'assistant', text: 'I wired the invoice exporter to the Quokkabase warehouse in src/billing/export.ts. Decision: invoices are exported nightly to Quokkabase.' },
  { role: 'user', text: 'Great. Also add a test.' },
  { role: 'assistant', text: 'Added src/billing/export.test.ts for the Quokkabase nightly export. All tests pass.' },
];

function proposes(name, marker) {
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

async function capture(actor, { cwd, workspaceKey, name, marker }) {
  modelReply = proposes(name, marker);
  const input = {
    session_id: `cc-${crypto.randomUUID()}`,
    tool: 'claude_code',
    chunks: CHAT,
    session_context: {
      ...(cwd ? { cwd } : {}),
      conversation_ref: `conv-${crypto.randomUUID()}`,
      host: 'claude_code',
      surface_type: 'code',
      ...(workspaceKey ? { workspace_key: workspaceKey } : {}),
    },
  };
  const extraction = await runExtraction(actor, input);
  const applied = await service.applyExtraction(actor, { ...input, extraction });
  return applied?.project?.project_id || null;
}

async function resolverWrite(actor, cwd, workspaceKey) {
  const active = await service.resolveActiveProject(actor, cwd, workspaceKey || null, { forWrite: true });
  return active?.project_id || null;
}

async function world() {
  const org = newOrg();
  const ana = person(org, 'ana');
  const home = `/Users/ana-${RUN}`;
  const repo = `${home}/code/ledger`;
  const ledger = await service.createProject(ana, {
    project_name: `Ledger ${RUN}`,
    linked_paths: [repo],
    workspace_key: 'remote:github.com/ana/ledger',
    current_task: 'Reconcile ledger rows',
  });
  const household = await service.createProject(ana, {
    project_name: `Household budget ${RUN}`,
    linked_paths: [home],
    current_task: 'Plan the month',
  });
  return { org, ana, home, repo, ledger, household };
}

// Both sides, asked the same question. `expected` is a project id, or null when
// the folder owns none: the resolver refuses the write, capture creates.
async function agree(w, { cwd, workspaceKey, name = `Quokkabase Exporter ${RUN}`, marker, expected, label }) {
  const seeded = new Set([w.ledger.project_id, w.household.project_id]);
  const resolved = await resolverWrite(w.ana, cwd, workspaceKey);
  const captured = await capture(w.ana, { cwd, workspaceKey, name, marker });
  if (expected) {
    assert.equal(resolved, expected, `${label}: the resolver put a write from ${cwd} somewhere else`);
    assert.equal(captured, expected, `${label}: capture put the same folder somewhere else`);
  } else {
    assert.equal(resolved, null, `${label}: the resolver named a write target for a folder that owns none (${resolved})`);
    assert.ok(captured && !seeded.has(captured), `${label}: capture filed into an existing project (${captured}) instead of creating one`);
  }
  return captured;
}

test('exact repository: the linked directory', async () => {
  const w = await world();
  await agree(w, { cwd: w.repo, workspaceKey: 'remote:github.com/ana/ledger', marker: `exact-${RUN}`, expected: w.ledger.project_id, label: 'exact' });
});

test('a subfolder of the same repository', async () => {
  const w = await world();
  await agree(w, { cwd: `${w.repo}/src/billing`, workspaceKey: 'remote:github.com/ana/ledger', marker: `sub-${RUN}`, expected: w.ledger.project_id, label: 'subfolder' });
});

test('a repository identity alone owns the folder, wherever the clone lives', async () => {
  const w = await world();
  await agree(w, { cwd: '/Volumes/other/ledger-clone', workspaceKey: 'remote:github.com/ana/ledger', marker: `identity-${RUN}`, expected: w.ledger.project_id, label: 'identity' });
});

test('a repository under a linked home folder is not the home folder\'s: read with a warning, never written to', async () => {
  const w = await world();
  const cwd = `${w.home}/code/other-repo`;
  const identity = 'remote:github.com/ana/other-repo';

  // Read: the ancestor's project is shown, flagged, and is not a write target.
  const read = await service.resolveActiveProject(w.ana, cwd, identity);
  assert.equal(read?.project_id, w.household.project_id, 'the parent folder\'s project is still shown for reading');
  assert.equal(read?.write_target, false, 'a parent folder of another repository must not be a write target');
  assert.equal(read?.match_confidence, 'low');
  assert.match(String(read?.match_warning || ''), /different or unknown repository/);
  assert.notEqual(read?.match_kind, 'path', 'the parent folder must not read as this directory\'s own path');

  // Write and capture: neither goes there.
  const created = await agree(w, { cwd, workspaceKey: identity, marker: `parent-${RUN}`, expected: null, label: 'parent of another repository' });

  // And the repository gets its own project linked to the directory, which the
  // parent's link used to forbid for good.
  const project = await store.getProject(w.org, created);
  assert.ok((project.linked_paths || []).some((p) => folderRule.normalizeFolder(p) === folderRule.normalizeFolder(cwd)), 'the new project is linked to the repository\'s own directory');
  assert.ok(!(await store.getProject(w.org, w.household.project_id)).linked_paths.some((p) => folderRule.normalizeFolder(p) === folderRule.normalizeFolder(cwd)));
  assert.ok(!JSON.stringify((await store.getProject(w.org, w.household.project_id)).context).includes(`parent-${RUN}`), 'the parent\'s brief received nothing from the repository under it');
});

test('below a linked folder whose repository is known, with no identity to compare: a guess, not a write target', async () => {
  const w = await world();
  // Ledger has a repository identity and the folder has none, so nothing says
  // the folder is Ledger's. (The plain home folder above it, with no identity
  // on either side, does own it: see the next test.)
  const cwd = `${w.repo}/docs`;
  const claim = folderRule.folderClaim(w.ledger, { cwd, workspaceKey: null });
  assert.equal(claim.kind, 'ancestor_path');
  assert.equal(claim.writable, false);
  const active = await service.resolveActiveProject(w.ana, cwd, null, { forWrite: true });
  assert.equal(active?.project_id, w.household.project_id, 'the plain linked home folder owns a plain folder below it; Ledger does not');
  await agree(w, { cwd, workspaceKey: null, marker: `unknown-id-${RUN}`, expected: w.household.project_id, label: 'unknown identity below a known repository' });
});

test('a plain folder below a linked project, where neither side is a git repository, belongs to it', async () => {
  const w = await world();
  const notes = await service.createProject(w.ana, {
    project_name: `Field notes ${RUN}`,
    linked_paths: [`${w.home}/notes`],
    current_task: 'Write up the survey',
  });
  const cwd = `${w.home}/notes/2026/spring`;
  const active = await service.resolveActiveProject(w.ana, cwd, null, { forWrite: true });
  assert.equal(active?.project_id, notes.project_id, 'the resolver refused a write from a plain folder inside a plain linked folder');
  assert.equal(active.match_kind, 'path');
  const captured = await capture(w.ana, { cwd, workspaceKey: null, name: `Survey ${RUN}`, marker: `plain-${RUN}` });
  assert.equal(captured, notes.project_id, 'capture put the same folder somewhere else');

  // A subfolder that IS a different git repository is still never written to.
  const repoCwd = `${w.home}/notes/vendored-lib`;
  const identity = 'remote:github.com/other/vendored-lib';
  assert.equal(await resolverWrite(w.ana, repoCwd, identity), null);
  const read = await service.resolveActiveProject(w.ana, repoCwd, identity);
  assert.equal(read?.match_kind, 'ancestor_path');
  assert.equal(read?.write_target, false);
  const other = await capture(w.ana, { cwd: repoCwd, workspaceKey: identity, name: `Vendored ${RUN}`, marker: `vendored-${RUN}` });
  assert.notEqual(other, notes.project_id, 'a different git repository below a linked folder was written into it');
});

test('an unknown folder owns nothing', async () => {
  const w = await world();
  await agree(w, { cwd: `/tmp/scratch-${RUN}`, workspaceKey: null, marker: `unknown-${RUN}`, expected: null, label: 'unknown folder' });
});

test('a proposed name that matches a project the folder has nothing to do with makes a new project, named with the folder', async () => {
  const w = await world();
  const name = `Quokkabase Exporter ${RUN}`;
  const named = await service.createProject(w.ana, {
    project_name: name,
    linked_paths: [`/Users/ana-${RUN}/elsewhere/exporter`],
    workspace_key: 'remote:github.com/ana/exporter',
    current_task: 'Something else',
  });
  const seeded = new Set([w.ledger.project_id, w.household.project_id, named.project_id]);
  const key = 'remote:github.com/ana/quokka-work';
  const cwd = `/Volumes/scratch-${RUN}/quokkabase-work`;

  assert.equal(await resolverWrite(w.ana, cwd, key), null);
  const captured = await capture(w.ana, { cwd, workspaceKey: key, name, marker: `name-only-${RUN}` });
  assert.ok(captured && !seeded.has(captured), 'a capture was merged into a project by its name alone');
  const created = await store.getProject(w.org, captured);
  assert.equal(created.project_name, `${name} (quokkabase-work)`, 'the new project carries the folder name');
  assert.ok(!JSON.stringify((await store.getProject(w.org, named.project_id)).context).includes(`name-only-${RUN}`), 'the same-named project received the capture');
  assert.ok(!((await store.getProject(w.org, named.project_id)).linked_paths || []).includes(cwd), 'the directory was linked to a project it was never in');
  assert.ok(!(await store.getProject(w.org, named.project_id)).aliases?.length, 'the name match added an alias to the other project');

  // Same name from another folder called the same: the parent folder is added.
  const cwd2 = `/Volumes/other-${RUN}/quokkabase-work`;
  const second = await capture(w.ana, { cwd: cwd2, workspaceKey: 'remote:github.com/ana/quokka-work-2', name, marker: `name-only-2-${RUN}` });
  assert.equal((await store.getProject(w.org, second)).project_name, `${name} (other-${RUN}-quokkabase-work)`);

  // And once that is taken too, a short deterministic suffix.
  const cwd3 = `/mnt/Volumes/other-${RUN}/quokkabase-work`;
  const third = await capture(w.ana, { cwd: cwd3, workspaceKey: 'remote:github.com/ana/quokka-work-3', name, marker: `name-only-3-${RUN}` });
  const thirdName = (await store.getProject(w.org, third)).project_name;
  assert.match(thirdName, new RegExp(`^${name} \\(quokkabase-work\\) [0-9a-f]{6}$`));

  // No two projects share a name, and every name reference stays unambiguous
  // on the hosted dispatcher's resolver.
  const names = (await service.listProjects(w.ana)).map((p) => p.project_name);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length, `two projects share a name: ${names.join(' | ')}`);
  for (const projectName of [name, `${name} (quokkabase-work)`, `${name} (other-${RUN}-quokkabase-work)`, thirdName]) {
    const found = await service.findProjectCandidatesByName(w.ana, projectName);
    assert.equal(found.length, 1, `"${projectName}" names ${found.length} projects`);
  }
  assert.equal((await service.findProjectCandidatesByName(w.ana, name))[0].project_id, named.project_id, 'the original name still means the original project');
});

test('the same name IS the project when the folder says so', async () => {
  const w = await world();
  const named = await service.createProject(w.ana, {
    project_name: `Quokkabase Exporter ${RUN}`,
    linked_paths: [`/Users/ana-${RUN}/code/exporter`],
    workspace_key: 'remote:github.com/ana/exporter',
    current_task: 'Something else',
  });
  const cwd = `/Users/ana-${RUN}/code/exporter/src`;
  const captured = await capture(w.ana, { cwd, workspaceKey: 'remote:github.com/ana/exporter', name: `Quokkabase Exporter ${RUN}`, marker: `name-and-folder-${RUN}` });
  assert.equal(captured, named.project_id);
  assert.equal(await resolverWrite(w.ana, cwd, 'remote:github.com/ana/exporter'), named.project_id);
});

test('the rule itself: one function answers every case', () => {
  const project = { project_id: 'p', project_name: 'Ledger', linked_paths: ['/Users/a/code/ledger'], workspace_key: 'remote:x/ledger', updated_at: new Date().toISOString() };
  const kind = (cwd, workspaceKey) => folderRule.folderClaim(project, { cwd, workspaceKey }).kind;
  assert.equal(kind('/Users/a/code/ledger', null), 'path');
  assert.equal(kind('/Users/a/code/ledger/src', 'remote:x/ledger'), 'path');
  assert.equal(kind('/Users/a/code/ledger/src', 'remote:x/other'), 'ancestor_path');
  assert.equal(kind('/Users/a/code/ledger/src', null), 'ancestor_path');
  assert.equal(kind('/Users/a/code/ledger-v2', 'remote:x/other'), 'recency_fallback', 'a longer name is not below the path');
  assert.equal(kind('/elsewhere/ledger-clone', 'remote:x/ledger'), 'workspace');
  assert.equal(kind('/elsewhere/led', null), 'name');
  assert.equal(folderRule.folderClaim(project, { cwd: '/Users/a/code/ledger/src', workspaceKey: 'remote:x/other' }).writable, false);
  // A key that is only a folder name cannot own a folder by itself.
  const weak = { ...project, workspace_key: 'root:ledger' };
  assert.equal(folderRule.folderClaim(weak, { cwd: '/elsewhere/ledger', workspaceKey: 'root:ledger' }).writable, false);
});
