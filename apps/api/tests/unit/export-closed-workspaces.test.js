'use strict';

/**
 * A WORKSPACE THAT CLOSED WITH THE ACCOUNT IS PRINTED WHOLE, IN A BLOCK OF ITS
 * OWN (journey r5). The renderer half: headings one level down so nothing inside
 * the block reads as a section of the document itself, fenced skill text left
 * alone, and the key-driven completeness check reaching into the block.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderContextExportMarkdown, unaccountedKeys } = require('../../src/services/contextExportMarkdown');

const own = {
  exported_at: '2026-09-29T00:00:00.000Z',
  schema_version: 1,
  owner_key: 'org-home',
  global_context: {},
  preferences: {},
  projects: [{ project_id: 'p-home', project_name: 'Home project', context: { current_task: 'Home task' }, graph: { nodes: [], edges: [] } }],
  workspace_graph: { nodes: [], edges: [] },
  skills: [],
};

const closed = (name, extra = {}) => ({
  workspace_id: `org-${name}`,
  workspace_name: name,
  global_context: { user_profile: `Profile in ${name}` },
  preferences: {},
  projects: [{ project_id: `p-${name}`, project_name: `${name} project`, archived: false, context: { current_task: `${name} task` }, graph: { nodes: [{ node_id: 'n1', node_type: 'knowledge', title: `${name} note`, summary: 's' }], edges: [] } }],
  workspace_graph: { nodes: [], edges: [] },
  skills: [{ skill_id: 's1', name: `${name} skill`, markdown_content: '# Inside the skill\n\nDo it.\n' }],
  ...extra,
});

test('a closed workspace is one block under its own name, its parts one level down', () => {
  const md = renderContextExportMarkdown({ ...own, closed_workspaces: [closed('Side')] });
  const lines = md.split('\n');
  const start = lines.indexOf('## Workspace closing with your account: Side');
  assert.ok(start > 0, 'the block has a heading of its own');
  const block = lines.slice(start);
  assert.ok(block.includes('### Profile') && block.includes('### Projects (1)') && block.includes('### Skills (1)'), 'the parts are one level down');
  assert.ok(block.includes('#### Side project') && block.includes('##### Knowledge graph'), 'so are the projects and their graphs');
  assert.ok(!block.slice(1).some((line) => line.startsWith('## ')), 'nothing inside it is a top-level section');
  assert.ok(lines.slice(0, start).includes('## Projects (1)'), 'the own workspace is printed above it, at the top level');
  assert.ok(!md.slice(0, md.indexOf('## Workspace closing')).includes('Side task'), 'and none of the closed work is in it');
});

test('a skill body inside a fence keeps its own headings', () => {
  const md = renderContextExportMarkdown({ ...own, closed_workspaces: [closed('Side')] });
  assert.ok(md.split('\n').includes('# Inside the skill'), 'the fenced heading is not demoted');
  assert.ok(!md.split('\n').includes('## Inside the skill'));
});

test('two closed workspaces are two separate blocks', () => {
  const md = renderContextExportMarkdown({ ...own, closed_workspaces: [closed('Alpha'), closed('Beta')] });
  const alpha = md.indexOf('## Workspace closing with your account: Alpha');
  const beta = md.indexOf('## Workspace closing with your account: Beta');
  assert.ok(alpha > 0 && beta > alpha);
  assert.ok(!md.slice(alpha, beta).includes('Beta task') && !md.slice(beta).includes('Alpha task'));
});

test('projects that could not be opened are counted in the block', () => {
  const md = renderContextExportMarkdown({ ...own, closed_workspaces: [closed('Side', { unreadable_projects: 2 })] });
  assert.match(md, /_2 more projects in this workspace belonged to somebody who was once in it and could not be opened, so they are not in this export\._/);
});

test('a bundle with no closed workspace prints exactly what it did', () => {
  const md = renderContextExportMarkdown(own);
  assert.ok(!md.includes('closing with your account'));
});

test('a key nobody renders inside a closed workspace is named by unaccountedKeys', () => {
  assert.deepEqual(unaccountedKeys({ ...own, closed_workspaces: [closed('Side')] }), []);
  const stray = closed('Side');
  stray.mystery = 'x';
  stray.projects[0].mystery2 = 'y';
  assert.deepEqual(unaccountedKeys({ ...own, closed_workspaces: [stray] }).sort(), ['closed_workspaces[].mystery', 'closed_workspaces[].projects[].mystery2']);
});
