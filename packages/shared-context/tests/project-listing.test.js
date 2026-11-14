/**
 * Journey round 3, A1: the listing start_session sends the assistant to.
 *
 * After 30 idle days the nightly job archives projects. start_session tells the
 * returning person "2 archived projects are waiting, not gone ... call
 * recall(action:"projects") for the IDs", and recall(action:"projects")
 * answered "No projects yet. Use manage_projects with action "create" to create
 * one." An assistant that followed it created an empty project beside the
 * archived one and the session started cold.
 *
 * formatProjectListing renders that listing for BOTH dispatchers. These pin
 * what it must say: archived projects named, marked archived, with their ids and
 * the restore call; "No projects yet" only to somebody with nothing at all; the
 * live listing exactly as it was; the structured half carrying the same facts.
 *
 *   node --test packages/shared-context/tests/project-listing.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const shared = require('../src/index');

const { formatProjectListing, formatProjectArchivedReply, formatArchivedProjectsNotice } = shared;

const LEDGER_API = { project_id: 'project_ledger_api', project_name: 'Ledger API', archived_at: '2026-08-24T03:00:00.000Z' };
const LEDGER_DASH = { project_id: 'project_ledger_dash', project_name: 'Ledger Dashboard', archived_at: '2026-08-24T03:00:01.000Z' };

// The live listing as it was rendered before archived projects were added to it.
function legacyLiveListing(tree) {
  const taskOf = (p) => (p.context?.current_task ? ` — ${p.context.current_task}` : '');
  const lines = [];
  for (const root of tree) {
    lines.push(`• ${root.project_name} (${root.project_id})${taskOf(root)}`);
    const subs = root.subprojects || [];
    subs.forEach((s, i) => {
      lines.push(`    ${i === subs.length - 1 ? '└─' : '├─'} ${s.project_name} (${s.project_id})${taskOf(s)}`);
    });
  }
  return lines.join('\n');
}

const LIVE_TREE = [
  {
    project_id: 'project_umbrella', project_name: 'Umbrella', context: { current_task: 'ship v2' },
    subprojects: [
      { project_id: 'project_sub_a', project_name: 'Sub A', context: { current_task: 'auth' } },
      { project_id: 'project_sub_b', project_name: 'Sub B', context: {} },
    ],
  },
  { project_id: 'project_solo', project_name: 'Solo', context: null, subprojects: [] },
];

test('the walker\'s return: every project archived, the listing names them with ids and the restore call', () => {
  assert.equal(typeof formatProjectListing, 'function', 'shared-context exports formatProjectListing');
  const { text, data } = formatProjectListing([], [LEDGER_DASH, LEDGER_API]);

  assert.doesNotMatch(text, /No projects yet/, 'THE BUG: "No projects yet" to somebody with two archived projects');
  assert.doesNotMatch(text, /action "create" to create one/);
  assert.equal(text, [
    'No active projects. 2 archived projects are waiting, not gone:',
    '• Ledger Dashboard (project_ledger_dash) — archived 2026-08-24',
    '• Ledger API (project_ledger_api) — archived 2026-08-24',
    '',
    'Everything they remembered is still there. To work in one, restore it with manage_projects(action:"restore", project_id:"<id>") rather than creating a new project: a new project starts with an empty brief.',
  ].join('\n'));

  // The notice that sends the assistant here names the same projects.
  const notice = formatArchivedProjectsNotice([LEDGER_DASH, LEDGER_API]);
  for (const project of [LEDGER_DASH, LEDGER_API]) {
    assert.ok(notice.includes(project.project_name));
    assert.ok(text.includes(`${project.project_name} (${project.project_id})`), `the listing gives ${project.project_name}'s id`);
  }

  // The structured half: the same facts, in the shape the hosted reply has.
  assert.deepEqual(data, {
    projects: [],
    archived_projects: [
      { project_id: 'project_ledger_dash', project_name: 'Ledger Dashboard', archived: true, archived_at: LEDGER_DASH.archived_at },
      { project_id: 'project_ledger_api', project_name: 'Ledger API', archived: true, archived_at: LEDGER_API.archived_at },
    ],
    archived_total: 2,
  });
});

test('one archived project: its own id is in the restore call', () => {
  const { text, data } = formatProjectListing([], [LEDGER_API]);
  assert.equal(text, [
    'No active projects. 1 archived project is waiting, not gone:',
    '• Ledger API (project_ledger_api) — archived 2026-08-24',
    '',
    'Everything it remembered is still there. To work in it, restore it with manage_projects(action:"restore", project_id:"project_ledger_api") rather than creating a new project: a new project starts with an empty brief.',
  ].join('\n'));
  assert.equal(data.archived_total, 1);
  assert.deepEqual(data.archived_projects.map((p) => p.project_id), ['project_ledger_api']);
});

test('"No projects yet" is said only to somebody with nothing, live or archived, and exactly as before', () => {
  for (const [tree, archived] of [[[], []], [null, null], [undefined, undefined], [[], null]]) {
    const { text, data } = formatProjectListing(tree, archived);
    assert.equal(text, 'No projects yet. Use manage_projects with action "create" to create one.');
    assert.deepEqual(data, { projects: [] }, 'no archived keys when there is nothing archived');
  }
});

test('live projects are listed exactly as before, with archived ones after them', () => {
  const live = formatProjectListing(LIVE_TREE, []);
  assert.equal(live.text, legacyLiveListing(LIVE_TREE), 'the live listing is unchanged byte for byte');
  assert.deepEqual(Object.keys(live.data), ['projects'], 'no archived keys when there is nothing archived');
  assert.deepEqual(live.data.projects[0], {
    project_id: 'project_umbrella', project_name: 'Umbrella', current_task: 'ship v2',
    subprojects: [
      { project_id: 'project_sub_a', project_name: 'Sub A', current_task: 'auth' },
      { project_id: 'project_sub_b', project_name: 'Sub B', current_task: undefined },
    ],
  });

  const both = formatProjectListing(LIVE_TREE, [LEDGER_API]);
  assert.ok(both.text.startsWith(`${legacyLiveListing(LIVE_TREE)}\n\nArchived, not gone (1):\n• Ledger API (project_ledger_api) — archived 2026-08-24\n`), both.text);
  assert.match(both.text, /restore it with manage_projects\(action:"restore", project_id:"project_ledger_api"\)/);
  assert.deepEqual(both.data.projects, live.data.projects, 'the live half of the structured reply is unchanged');
  assert.deepEqual(both.data.archived_projects, [{ project_id: 'project_ledger_api', project_name: 'Ledger API', archived: true, archived_at: LEDGER_API.archived_at }]);
});

test('a long archive is counted, never dropped silently, and the structured half says the same', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ project_id: `project_old_${i}`, project_name: `Old ${i}`, archived_at: '2026-07-01T00:00:00Z' }));
  const { text, data } = formatProjectListing([], many);
  assert.match(text, /^No active projects\. 40 archived projects are waiting, not gone:/);
  const named = many.filter((p) => text.includes(`(${p.project_id})`));
  assert.equal(named.length, shared.LISTING_ARCHIVED_SHOWN);
  assert.match(text, new RegExp(`… and ${40 - shared.LISTING_ARCHIVED_SHOWN} more archived`));
  assert.equal(data.archived_total, 40);
  assert.deepEqual(data.archived_projects.map((p) => p.project_id), named.map((p) => p.project_id), 'structured names exactly the ones the text names');
});

test('an archived row with no timestamp is still listed, without a date', () => {
  const { text } = formatProjectListing([], [{ project_id: 'project_x', project_name: 'X' }]);
  assert.match(text, /^• X \(project_x\) — archived$/m);
});

test('the archive reply no longer promises the project leaves the listing', () => {
  const reply = formatProjectArchivedReply({ project_id: 'project_ledger_api', project_name: 'Ledger API' });
  assert.equal(reply, 'Archived "Ledger API". It no longer resolves as the active project, and recall(action:"projects") lists it as archived. Restore it with manage_projects(action:"restore", project_id:"project_ledger_api").');
  assert.doesNotMatch(reply, /won't appear|no longer appear/);
});

test('neighbour: the portfolio counts ACTIVE projects and says so, not "this account has 0"', () => {
  // Said to the walker, whose two projects the nightly job had archived.
  const none = shared.formatPortfolio({ counts: { projects: 0, decisions: 0, shared_entities: 0 } });
  assert.equal(none, 'Cross-project memory needs more than one project; this account has 0 active projects. Nothing spans projects yet.');
  assert.doesNotMatch(none, /this account has 0\./);
  const one = shared.formatPortfolio({ counts: { projects: 1, decisions: 3, shared_entities: 0 } });
  assert.equal(one, 'Cross-project memory needs more than one project; this account has 1 active project. Nothing spans projects yet.');
});
