/**
 * contextSearchService — the one search both dispatchers answer from.
 *
 * The write-then-read proof over real HTTP lives in
 * tests/integration/hosted-search-write-then-read.test.js. This file covers what
 * that one cannot reach cheaply:
 *
 *   1. the matcher itself — identifiers survive, `E-007` is not `007`, the raw
 *      query is tried before anything is tokenised, the snippet holds the match;
 *   2. VISIBILITY on a shared workspace — search is the one read that sweeps
 *      every project at once, so it is the read most able to leak. A teammate
 *      must not find a colleague's `personal` project, nor a section a share
 *      policy withholds, and an invited teammate who has authored nothing still
 *      finds what IS shared with them;
 *   3. `recall paths` (findKnownPaths) — real paths first, at most three clipped
 *      notes after them.
 *
 * Multi-user, DB-backed; run via scripts/run-db-test.sh.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../../src/services/contextSyncService');
const search = require('../../src/services/contextSearchService');
const store = require('../../src/store/contextSyncStore');
const db = require('../../src/config/db');
const workspace = require('../../src/services/workspaceService');
const { closeRedisConnections } = require('../../src/config/redis');

const alice = () => ({ org_id: 'org-system', id: 'user-alice' });
const bob = () => ({ org_id: 'org-system', id: 'user-bob' });

// ── 1. the matcher (pure) ────────────────────────────────────────────────────

test('the tokeniser keeps the identifiers people search for', () => {
  assert.deepEqual(search.tokenize('A-2 $12 E-007'), ['a-2', '$12', 'e-007']);
  assert.deepEqual(search.tokenize('owner_key in apps/api, v1.0.52.'), ['owner_key', 'apps/api', 'v1.0.52']);
  assert.deepEqual(search.tokenize('PR #486'), ['pr', '#486']);
  // Filler is dropped, unless filler is the whole query.
  assert.deepEqual(search.tokenize('to be or'), ['to', 'be', 'or']);
  // A lone character matches nearly everything and says nothing.
  assert.deepEqual(search.tokenize('a b auth'), ['auth']);
});

test('E-007 matches E-007 and never a bare 007', () => {
  const tokens = search.tokenize('E-007');
  assert.ok(search.matchText('Filed as experiment E-007 last week', 'e-007', tokens));
  assert.equal(search.matchText('Ticket OPS-1007 and agent 007', 'e-007', tokens), null);
  // The punctuation-blind fallback starts at a word boundary only.
  assert.equal(search.matchText('type 007 connector', 'e-007', tokens), null);
  assert.ok(search.matchText('experiment E 007 (typed without the dash)', 'e-007', tokens));
});

test('an exact phrase outranks the same words scattered, which outranks some of them', () => {
  const tokens = search.tokenize('stripe webhook');
  const phrase = search.matchText('The Stripe webhook retries twice', 'stripe webhook', tokens);
  const scattered = search.matchText('A webhook fires when Stripe settles', 'stripe webhook', tokens);
  const partial = search.matchText('Stripe price ids are mapped in plans.js', 'stripe webhook', tokens);
  assert.ok(phrase.score > scattered.score && scattered.score > partial.score, JSON.stringify({ phrase, scattered, partial }));
});

test('words still match across punctuation, as they did before', () => {
  assert.ok(search.matchText('see the auth-decisions doc', 'auth decisions', search.tokenize('auth decisions')));
  assert.ok(search.matchText('owner_key comes from workspaceService', 'owner key', search.tokenize('owner key')));
});

test('the snippet is cut around the match, not from the start of the entry', () => {
  const text = `${'lead-in words '.repeat(60)}THE-MARKER ${'trailing words '.repeat(60)}`;
  const at = text.toLowerCase().indexOf('the-marker');
  const snippet = search.snippetAround(text, at, 'the-marker'.length);
  assert.match(snippet, /THE-MARKER/);
  assert.ok(snippet.startsWith('…') && snippet.endsWith('…'));
  assert.ok(snippet.length <= 170, `snippet was ${snippet.length} chars`);
  // Short entries come back whole.
  assert.equal(search.snippetAround('short entry', 0, 5), 'short entry');
});

test('rows written before headlines, importance or dates existed still produce candidates', () => {
  const fields = search.buildProjectCandidates({
    project_id: 'p',
    context: {
      recent_decisions: ['a bare string decision', { summary: 'object decision without a date' }],
      debugging_notes: [{ summary: 'note without paths' }],
      todo_items: [{ id: 't1', title: 'card without a body' }],
    },
  }).map((c) => c.field);
  assert.deepEqual(fields, ['decision[0]', 'decision[1]', 'debug[0]', 'todo[0]']);
});

// ── 2. visibility ────────────────────────────────────────────────────────────

async function freshWorkspace() {
  await store.clearAll();
  await db.query('DELETE FROM workspace_members WHERE owner_key = $1', ['org-system'], 'org-system').catch(() => {});
  await workspace.addMember('org-system', 'user-alice', { role: 'owner' });
  await workspace.addMember('org-system', 'user-bob', { role: 'member' });
}

async function aliceProject(name, visibility, context, sections = null) {
  const project = await service.createProject(alice(), { project_name: name, description: `${name} project`, goals: [], current_status: '' });
  await service.updateProjectContext(alice(), project.project_id, context);
  await db.query('UPDATE context_projects SET visibility = $2 WHERE project_id = $1', [project.project_id, visibility], 'org-system');
  if (sections) {
    await store.upsertProjectShare(project.project_id, {
      org_id: 'org-system',
      enabled: true,
      created_by: 'user-alice',
      updated_by: 'user-alice',
      sections: sections.map((section_key) => ({ section_key, can_view: true, can_edit: true })),
      members: [],
    });
  }
  return project;
}

const now = () => new Date().toISOString();

test('a teammate cannot search a colleague\'s personal project; the author still can', async () => {
  await freshWorkspace();
  await aliceProject('Side Project', 'personal', {
    recent_decisions: [{ summary: 'Pangolinmarker stays out of the team workspace', decided_at: now() }],
  });

  const mine = await search.searchContext(alice(), { query: 'pangolinmarker' });
  assert.equal(mine.results.length, 1, 'the author finds their own note');

  const theirs = await search.searchContext(bob(), { query: 'pangolinmarker' });
  assert.deepEqual(theirs.results, [], 'a teammate does not');
});

test('a section the share policy withholds cannot be matched; a shared one can', async () => {
  await freshWorkspace();
  const project = await aliceProject('Narrow Share', 'shared', {
    current_task: 'Ship the okapimarker importer',
    recent_decisions: [{ summary: 'Tapirmarker pricing stays confidential', decided_at: now() }],
  }, ['current_task', 'current_status']);

  // Bob has authored nothing anywhere. What is shared with him is still his to find.
  const shared = await search.searchContext(bob(), { query: 'okapimarker' });
  assert.equal(shared.results.length, 1);
  assert.equal(shared.results[0].project_id, project.project_id);
  assert.equal(shared.results[0].field, 'task');

  const withheld = await search.searchContext(bob(), { query: 'tapirmarker' });
  assert.deepEqual(withheld.results, [], 'decisions are outside this share');

  // Naming the project does not widen what he may read.
  const named = await search.searchContext(bob(), { query: 'tapirmarker', project_id: project.project_id });
  assert.deepEqual(named.results, []);
});

test('naming a personal project you cannot read neither finds it nor errors', async () => {
  await freshWorkspace();
  const hidden = await aliceProject('Hidden', 'personal', { current_task: 'Work on the dugongmarker' });
  const out = await search.searchContext(bob(), { query: 'dugongmarker', project_id: hidden.project_id });
  assert.deepEqual(out.results, []);
});

test('the active project leads when nothing is requested, and date breaks the remaining ties', async () => {
  await freshWorkspace();
  const lastMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const a = await aliceProject('Alpha', 'shared', {
    recent_decisions: [
      { summary: 'Older narwhalmarker decision', decided_at: lastMonth },
      { summary: 'Newer narwhalmarker decision', decided_at: now() },
    ],
  });
  const out = await search.searchContext(alice(), { query: 'narwhalmarker' });
  assert.deepEqual(out.results.map((r) => r.snippet), ['Newer narwhalmarker decision', 'Older narwhalmarker decision']);
  assert.ok(out.results.every((r) => r.project_id === a.project_id));
  // limit is clamped into [1, 10] rather than producing an empty page.
  assert.equal((await search.searchContext(alice(), { query: 'narwhalmarker', limit: 0 })).results.length, 1);
});

// ── 3. recall paths ──────────────────────────────────────────────────────────

test('findKnownPaths ranks real paths first and appends at most three clipped notes', async () => {
  await freshWorkspace();
  const project = await aliceProject('Paths', 'shared', {
    hot_paths: [
      { label: 'dispatcher', path: 'apps/api/src/routes/mcp.js', purpose: 'hosted dispatcher' },
      { label: 'local dispatcher', path: 'packages/mcp-server/src/tools/context-sync.ts', purpose: 'stdio dispatcher' },
    ],
    // Six long notes that each out-match the paths on the old single score.
    debugging_notes: ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].map((word, i) => ({
      summary: `The ${word} dispatcher bug: the hosted dispatcher and the local dispatcher disagree. ${'More detail about the dispatcher. '.repeat(40)}`,
      paths: ['apps/api/src/routes/mcp.js'],
      added_at: new Date(Date.now() - i * 3600e3).toISOString(),
    })),
  });

  const out = await service.findKnownPaths(alice(), { query: 'hosted dispatcher', project_id: project.project_id, limit: 10 });
  const kinds = out.map((item) => item.kind);
  assert.deepEqual(kinds, ['hot_path', 'hot_path', 'debugging_note', 'debugging_note', 'debugging_note']);
  for (const note of out.filter((item) => item.kind === 'debugging_note')) {
    assert.ok(note.summary.length <= 240, `note was ${note.summary.length} chars`);
  }
  // No path hits at all: the notes are still the (capped) answer, not nothing.
  const notesOnly = await service.findKnownPaths(alice(), { query: 'charlie', project_id: project.project_id, limit: 10 });
  assert.deepEqual(notesOnly.map((item) => item.kind), ['debugging_note']);
});

test.after(async () => {
  // 'org-system' is a SHARED sentinel across suites: leaving these rows behind
  // makes every later suite's solo workspace look like a two-person team.
  await db.query('DELETE FROM workspace_members WHERE owner_key = $1', ['org-system'], 'org-system').catch(() => {});
  await closeRedisConnections();
});
