/**
 * The `?sections=` allow-list — one list, and every name on it is real.
 *
 * Two copies of this list lived inside two route handlers and drifted: /active
 * accepted `todos`, /inject did not. Because the filter DROPS an unknown name
 * rather than rejecting the request, asking /inject for the board returned a
 * payload with no board and no error — a caller could not tell "you have no
 * cards" from "this route does not serve cards". The MCP client routes the same
 * get_context call to /inject when it has a project_id and to /active when it
 * does not, so the same documented call worked or silently returned nothing
 * depending on an argument that has nothing to do with sections.
 *
 * These tests pin the two properties that failure needed:
 *   1. There is exactly ONE list. A second copy is how they drifted.
 *   2. Every name on it actually renders. An allow-list entry that
 *      formatSectionInjection does not know is advertised-but-dead — the same
 *      silent nothing, one layer down.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { formatSectionInjection } = require('../../../../packages/shared-context/src/index.js');

const ROUTE_PATH = path.join(__dirname, '..', '..', 'src', 'routes', 'context', 'context-sync.js');

// Comment-blind: the explanation above the constant names the sections it is
// about, and a source-text assertion that counts those would fail on prose.
function sourceWithoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

function readAllowList() {
  const source = sourceWithoutComments(fs.readFileSync(ROUTE_PATH, 'utf8'));
  const definitions = source.match(/VALID_SECTIONS\s*=\s*new Set\(\[[\s\S]*?\]\)/g) || [];
  return { source, definitions };
}

test('the section allow-list is defined exactly once', () => {
  const { definitions } = readAllowList();
  assert.strictEqual(
    definitions.length,
    1,
    `expected one VALID_SECTIONS definition, found ${definitions.length} — a second copy is how /inject and /active drifted apart`,
  );
});

test('every advertised section actually renders', () => {
  const { definitions } = readAllowList();
  const names = [...definitions[0].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  assert.ok(names.length > 10, 'failed to parse the allow-list');

  // A context with every field populated, so a section that renders nothing here
  // renders nothing because the API named a section the formatter does not know.
  const ctx = {
    project_name: 'Fixture',
    current_task: 'Ship the allow-list fix',
    current_status: 'In review',
    description: 'A fixture project',
    blocking_issue: 'Waiting on a deploy',
    next_action: 'Merge',
    task_progress: '80%',
    recent_decisions: [{ summary: 'Share one list', importance: 'high' }],
    tech_stack: ['node'],
    file_structure_summary: ['apps/api'],
    hot_paths: [{ label: 'Route', path: 'apps/api/src/routes/context/context-sync.js' }],
    entrypoints: [{ label: 'API', path: 'apps/api/src/app.js' }],
    surfaces: [{ label: 'Context sync', paths: ['apps/api/src/routes/context/context-sync.js'] }],
    debugging_notes: [{ summary: 'The list drifted' }],
    landmines: [{ summary: 'Two copies of one list' }],
    shipped: [{ summary: 'One shared list' }],
    goals: ['One list'],
    open_questions: ['Anything else duplicated?'],
    recurring_context: ['CommonJS only'],
    todo_items: [{ id: 'card-1', title: 'Pin the allow-list', phase: 'backlog' }],
  };
  const global = { user_profile: 'Fixture user', preferences: ['flat colors'] };

  const header = formatSectionInjection(ctx, [], global);
  for (const name of names) {
    const rendered = formatSectionInjection(ctx, [name], global);
    assert.notStrictEqual(
      rendered,
      header,
      `section "${name}" is on the allow-list but renders nothing — advertised and dead`,
    );
  }
});

test('the board is requestable by both of its names', () => {
  const { definitions } = readAllowList();
  for (const name of ['board', 'todos']) {
    assert.ok(definitions[0].includes(`'${name}'`), `"${name}" must be requestable`);
  }
});
