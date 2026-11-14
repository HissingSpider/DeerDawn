'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BOARD_PHASES,
  TASK_BOARD_WIDGET_MIME,
  TASK_BOARD_WIDGET_URI,
  buildTaskBoardSnapshot,
  formatTaskBoardText,
  isTaskBoardUiEnabled,
  taskBoardWidgetHtml,
} = require('../src');

test('task board snapshot and compact text preserve canonical phases and counts', () => {
  const snapshot = buildTaskBoardSnapshot({
    project_id: 'p1',
    project_name: 'DeerDawn',
    todo_items: [
      { id: 'a', title: 'First', phase: 'in_progress' },
      { id: 'b', title: 'Second', phase: 'blocked' },
      { id: 'c', title: 'Third', phase: 'blocked' },
      { id: 'd', title: 'Fourth', phase: 'blocked' },
    ],
  });
  assert.deepEqual(snapshot.board.map((column) => column.phase), BOARD_PHASES);
  assert.equal(snapshot.total_cards, 4);
  assert.equal(snapshot.open_cards, 4);
  assert.equal(snapshot.counts_by_phase.blocked, 3);
  assert.match(formatTaskBoardText(snapshot), /Task board — DeerDawn/);
  assert.match(formatTaskBoardText(snapshot), /… 1 more/);
});

test('task board widget is versioned, self-contained, and opt-in', () => {
  assert.equal(TASK_BOARD_WIDGET_URI, 'ui://deerdawn/task-board/v1.html');
  assert.equal(TASK_BOARD_WIDGET_MIME, 'text/html;profile=mcp-app');
  assert.equal(isTaskBoardUiEnabled({}), false);
  assert.equal(isTaskBoardUiEnabled({ MCP_TASK_BOARD_UI_ENABLED: 'true' }), true);
  const html = taskBoardWidgetHtml();
  assert.match(html, /ui\/notifications\/tool-result/);
  assert.match(html, /name:'manage_tasks'/);
  assert.doesNotMatch(html, /<script\s+src=/i);
  assert.doesNotMatch(html, /https?:\/\//i);
});

// The widget runs inside a sandboxed iframe, where the host suppresses
// window.confirm and the call returns false without ever showing a dialog. The
// remove button was gated on exactly that, so it looked live and did nothing.
// Destructive confirmation has to be drawn by the widget itself.
test('destructive confirmation is drawn in the widget, never a native dialog', () => {
  const html = taskBoardWidgetHtml();
  assert.doesNotMatch(html, /\bconfirm\s*\(/, 'no window.confirm — a sandboxed iframe suppresses it');
  assert.doesNotMatch(html, /\balert\s*\(|\bprompt\s*\(/, 'no other native dialogs either');
  assert.match(html, /pendingRemove/, 'the widget tracks which card is awaiting confirmation');
  assert.match(html, /confirm_destructive:true/, 'removal still passes the destructive confirmation to the tool');
});

// A widget that fetches nothing should say so rather than leave the host to
// infer it. Hosts that enforce a widget CSP need the declaration present.
test('widget declares a content security policy and fetches nothing', () => {
  const { taskBoardToolMeta } = require('../src');
  const csp = taskBoardToolMeta()['openai/widgetCSP'];
  assert.deepEqual(csp, { connect_domains: [], resource_domains: [] });
});

// A dark-only palette under `color-scheme: light dark` renders a black slab in
// a light-themed host.
test('widget paints both themes explicitly', () => {
  const html = taskBoardWidgetHtml();
  assert.match(html, /:root\{[^}]*--bg:#ffffff/, 'light is the base palette');
  assert.match(html, /@media\(prefers-color-scheme:dark\)\{:root\{[^}]*--bg:#111318/, 'dark overrides it');
});
