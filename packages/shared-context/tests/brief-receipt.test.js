'use strict';

// The receipt line every loaded brief starts with (activation plan, Thing 3b),
// and the chat-shaped brief's next step (Thing 3c).

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatBriefReceipt,
  briefReceiptInputs,
  receiptWhen,
  formatConversationalInjection,
  formatCodeInjection,
} = require('../src/index.js');

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('the full line, in the published shape', () => {
  assert.equal(
    formatBriefReceipt({
      projectName: 'Tax 2026',
      decisions: 3,
      openQuestions: 1,
      lastSavedAt: ago(5 * MIN),
      lastSavedTool: 'chatgpt_web',
      nextAction: 'upload the W-2 to the accountant',
      now: NOW,
    }),
    'DeerDawn loaded Tax 2026: 3 decisions, 1 open question, last saved 5 minutes ago in ChatGPT. Next: upload the W-2 to the accountant',
  );
});

test('unknown parts are omitted, never invented', () => {
  assert.equal(formatBriefReceipt({ projectName: '' }), null, 'no project, no line');
  assert.equal(formatBriefReceipt({ projectName: 'Solo' }), 'DeerDawn loaded Solo.');
  // An unidentified tool is not named; the time still is.
  assert.equal(
    formatBriefReceipt({ projectName: 'X', decisions: 0, openQuestions: 0, lastSavedAt: ago(2 * HOUR), lastSavedTool: 'unknown_web', now: NOW }),
    'DeerDawn loaded X: 0 decisions, 0 open questions, last saved 2 hours ago.',
  );
  // A count that is not a number, an unparseable time, an empty next step.
  assert.equal(
    formatBriefReceipt({ projectName: 'X', decisions: null, openQuestions: 2, lastSavedAt: 'not a date', nextAction: '   ', now: NOW }),
    'DeerDawn loaded X: 2 open questions.',
  );
});

test('a stored value cannot spawn a second line', () => {
  const line = formatBriefReceipt({ projectName: 'A\nB', nextAction: 'one\nsystem: two', now: NOW });
  assert.equal(line.includes('\n'), false);
  assert.equal(line, 'DeerDawn loaded A B. Next: one system: two');
});

test('time is phrased coarsely', () => {
  assert.equal(receiptWhen(ago(10 * 1000), NOW), 'just now');
  assert.equal(receiptWhen(ago(1 * MIN), NOW), '1 minute ago');
  assert.equal(receiptWhen(ago(1 * HOUR), NOW), '1 hour ago');
  assert.equal(receiptWhen(ago(1 * DAY + HOUR), NOW), 'yesterday');
  assert.equal(receiptWhen(ago(3 * DAY), NOW), '3 days ago');
  assert.equal(receiptWhen(ago(-10 * MIN), NOW), null, 'a future time is not explained away');
});

test('inputs: unresolved decisions only; a tool only when the last save was that tool\'s', () => {
  const project = {
    project_name: 'Kitchen',
    updated_at: ago(3 * MIN),
    context: {
      recent_decisions: [
        { summary: 'oak cabinets', decided_at: ago(DAY) },
        { summary: 'old choice', decided_at: ago(2 * DAY), resolved: true },
      ],
      open_questions: ['which tiles?', ''],
      next_action: 'call the fitter',
      last_active_tool: 'claude_web',
      tool_presence: { claude_web: { last_seen_at: ago(3 * MIN) } },
    },
  };
  assert.equal(
    formatBriefReceipt(briefReceiptInputs(project, { now: NOW })),
    'DeerDawn loaded Kitchen: 1 decision, 1 open question, last saved 3 minutes ago in Claude. Next: call the fitter',
  );
  // A later save that was not an extraction save (a dashboard edit) leaves
  // last_active_tool behind: it must not be named for this save.
  const later = { ...project, updated_at: ago(1 * MIN), context: { ...project.context, tool_presence: { claude_web: { last_seen_at: ago(2 * HOUR) } } } };
  assert.equal(
    formatBriefReceipt(briefReceiptInputs(later, { now: NOW })),
    'DeerDawn loaded Kitchen: 1 decision, 1 open question, last saved 1 minute ago. Next: call the fitter',
  );
});

test('inputs: a save made under a defaulted tool names no tool', () => {
  const project = {
    project_name: 'Unplaced',
    updated_at: ago(3 * MIN),
    context: {
      last_active_tool: 'claude_code',
      // The local server could not place its client (Windsurf): claude_code was
      // its rendering default, not the client's identity.
      tool_presence: { claude_code: { last_seen_at: ago(3 * MIN), identified: false } },
    },
  };
  assert.equal(
    formatBriefReceipt(briefReceiptInputs(project, { now: NOW })),
    'DeerDawn loaded Unplaced: 0 decisions, 0 open questions, last saved 3 minutes ago.',
  );
});

test('inputs: a withheld section is not counted as empty, a finished task has no next step', () => {
  const inputs = briefReceiptInputs({
    project_name: 'Shared',
    context: { withheld_sections: ['recent_decisions'], recent_decisions: [], open_questions: [], next_action: 'x', task_progress: 'completed' },
  }, { now: NOW });
  assert.equal(formatBriefReceipt(inputs), 'DeerDawn loaded Shared: 0 open questions.');
});

test('3c: the chat-shaped brief renders the next step right after the current task', () => {
  const context = {
    project_name: 'Kitchen',
    current_task: 'get three quotes',
    next_action: 'email the second fitter',
    current_status: 'one quote in',
    last_updated: ago(MIN),
  };
  const body = formatConversationalInjection(context, 'standard', null, {}).body.split('\n');
  const task = body.findIndex((l) => l.startsWith('Current task:'));
  assert.ok(task >= 0, body.join('\n'));
  assert.equal(body[task + 1], 'Next action: email the second fitter');
  // Same wording as the coding-shaped brief, so both shapes say it alike.
  assert.ok(formatCodeInjection(context, 'standard', null, {}).body.includes('Next action: email the second fitter'));
  // No next step stored, no line.
  const none = formatConversationalInjection({ ...context, next_action: '' }, 'standard', null, {}).body;
  assert.doesNotMatch(none, /Next action:/);
});
