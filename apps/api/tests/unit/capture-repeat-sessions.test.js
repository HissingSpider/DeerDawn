/**
 * REPEATED SESSIONS FROM ONE FOLDER MAKE AT MOST ONE PROJECT (round 6 review, M2).
 *
 * A capture from a folder that a linked ancestor holds only as a non-owning
 * guess (a different or half-known repository) creates its own project. That
 * project must be able to link its own directory, or the next session cannot
 * find it and creates another, every session. N sessions from the same folder
 * produce at most one new project, and later sessions find it. The same for
 * web captures with no folder: two conversations that propose one name are two
 * projects, and never share a name.
 *
 *   bash scripts/run-db-test.sh node --test --test-concurrency=1 tests/unit/capture-repeat-sessions.test.js
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
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-folder-rule-never-sent-repeat';
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
  return { org_id: org, id: `user-repeat-sessions-${label}-${RUN}-${crypto.randomBytes(2).toString('hex')}` };
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

async function capture(actor, { cwd, workspaceKey, name, marker, conversationRef }) {
  modelReply = proposes(name, marker);
  const input = {
    session_id: `cc-${crypto.randomUUID()}`,
    tool: 'claude_code',
    chunks: CHAT,
    session_context: {
      ...(cwd ? { cwd } : {}),
      conversation_ref: conversationRef || `conv-${crypto.randomUUID()}`,
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


async function count(org) {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM context_projects WHERE owner_key = $1', [org], 'org-system');
  return rows[0].n;
}

async function fourSessions(w, { cwd, workspaceKey, name }) {
  const landed = [];
  for (let i = 0; i < 4; i += 1) {
    landed.push(await capture(w.ana, { cwd, workspaceKey, name, marker: `repeat-${i}-${RUN}` }));
  }
  return landed;
}

async function ancestorWorld(ancestorKey) {
  const org = newOrg();
  const ana = person(org, 'ana');
  const home = `/home/u-${RUN}`;
  const ancestor = await service.createProject(ana, {
    project_name: `Home ${RUN}`,
    linked_paths: [home],
    ...(ancestorKey ? { workspace_key: ancestorKey } : {}),
    current_task: 'Plan the month',
  });
  return { org, ana, home, ancestor };
}

test('a plain folder below a plain linked ancestor: every session lands in the ancestor, none creates a project', async () => {
  const w = await ancestorWorld(null);
  const before = await count(w.org);
  const landed = await fourSessions(w, { cwd: `${w.home}/scratch/app`, workspaceKey: null, name: `Scratch App ${RUN}` });
  assert.deepEqual([...new Set(landed)], [w.ancestor.project_id]);
  assert.equal(await count(w.org), before);
});

for (const [label, ancestorKey, folderKey] of [
  ['a non-git folder below a linked ancestor whose repository is known', 'remote:github.com/u/dotfiles', null],
  ['a git repository with no remote below a plain linked ancestor', null, 'root:app'],
  ['a git repository with a key the ancestor lacks', 'remote:github.com/u/dotfiles', 'remote:github.com/u/scratch-app'],
]) {
  test(`${label}: four sessions make one project, and it is linked to the folder`, async () => {
    const w = await ancestorWorld(ancestorKey);
    const cwd = `${w.home}/scratch/app`;
    const before = await count(w.org);
    const landed = await fourSessions(w, { cwd, workspaceKey: folderKey, name: `Scratch App ${RUN}` });
    assert.equal(await count(w.org), before + 1, `four sessions made ${(await count(w.org)) - before} projects`);
    assert.equal(new Set(landed).size, 1, 'the sessions did not all find the same project');
    assert.notEqual(landed[0], w.ancestor.project_id, 'a folder the ancestor does not own was written into the ancestor');
    const made = await store.getProject(w.org, landed[0]);
    assert.ok((made.linked_paths || []).some((p) => folderRule.normalizeFolder(p) === folderRule.normalizeFolder(cwd)), 'the new project did not link its own folder');
    assert.equal(await resolverWrite(w.ana, cwd, folderKey), landed[0], 'the resolver does not find it either');
    assert.ok(!JSON.stringify((await store.getProject(w.org, w.ancestor.project_id)).context).includes('repeat-'), 'the ancestor received a capture');
  });
}

test('web captures from different conversations that propose one name are two projects with two names', async () => {
  const org = newOrg();
  const ana = person(org, 'ana');
  const name = `Trip Plan ${RUN}`;
  const a = await capture(ana, { cwd: null, name, marker: `web-a-${RUN}`, conversationRef: `https://chat.example.test/c/a-${RUN}` });
  const b = await capture(ana, { cwd: null, name, marker: `web-b-${RUN}`, conversationRef: `https://chat.example.test/c/b-${RUN}` });
  const c = await capture(ana, { cwd: null, name, marker: `web-c-${RUN}`, conversationRef: `https://chat.example.test/c/c-${RUN}` });
  assert.equal(new Set([a, b, c]).size, 3, 'two conversations were merged by name alone');
  const names = [a, b, c].map(() => null);
  for (const [i, id] of [a, b, c].entries()) names[i] = (await store.getProject(org, id)).project_name;
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, 3, `two projects share a name: ${names.join(' | ')}`);
  assert.equal(names[0], name);

  // The same conversation coming back finds its project; it does not make another.
  const again = await capture(ana, { cwd: null, name, marker: `web-b2-${RUN}`, conversationRef: `https://chat.example.test/c/b-${RUN}` });
  assert.equal(again, b);
  assert.equal(await count(org), 3);
});
