'use strict';

// finish_task: the confirmation clears what the review showed (journey r4,
// BLOCKED 22). The rule both dispatchers apply; see src/taskReview.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { taskReviewItems, planReviewedCompletion, formatLeftAfterReview, describeTaskState } = require('../src/index.js');

const ctx = (over = {}) => ({
  open_questions: ['Q1?', 'Q2?'],
  blocking_issue: 'Blocked on B',
  commands: [{ label: 'test', run: 'npm test' }],
  ...over,
});

test('clears exactly the reviewed items and keeps what was added since', () => {
  const reviewed = taskReviewItems(ctx());
  const now = ctx({
    open_questions: ['Q1?', 'Q2?', 'Q3?'],
    commands: [{ label: 'test', run: 'npm test' }, { label: 'lint', run: 'npm run lint' }],
  });
  const plan = planReviewedCompletion(now, reviewed);
  assert.deepEqual(plan.patch, { open_questions: ['Q3?'], commands: [{ label: 'lint', run: 'npm run lint' }], blocking_issue: '' });
  assert.deepEqual(plan.hidden, []);
  assert.deepEqual(plan.cleared, { questions: 2, blocker: true, commands: 1 });
  assert.deepEqual(plan.stayed, { questions: ['Q3?'], blocker: '', commands: 1 });
  assert.equal(formatLeftAfterReview(plan.stayed), 'Left as they were (added after the review, so not shown in it): the open question "Q3?"; 1 command log entry.');
});

test('a blocker or command that changed after the review is a different item and stays', () => {
  const reviewed = taskReviewItems(ctx());
  const plan = planReviewedCompletion(ctx({ blocking_issue: 'Blocked on C', commands: [{ label: 'test', run: 'npm test -- --watch' }] }), reviewed);
  assert.equal(plan.cleared.blocker, false);
  assert.equal(plan.cleared.commands, 0);
  // Every field the caller can view is written back, unchanged where nothing
  // was cleared, so the server names one they may not edit (journey r4, M1).
  assert.equal(plan.patch.blocking_issue, 'Blocked on C');
  assert.deepEqual(plan.patch.commands, [{ label: 'test', run: 'npm test -- --watch' }]);
  assert.equal(formatLeftAfterReview(plan.stayed), 'Left as they were (added after the review, so not shown in it): the blocking issue "Blocked on C"; 1 command log entry.');
});

test('outer whitespace is not a difference; the digest is applied to both sides', () => {
  const digest = (s) => `#${s.length}:${s}`;
  const reviewed = taskReviewItems(ctx({ open_questions: ['  Q1?  '] }), { digest });
  assert.deepEqual(reviewed.questions, ['#3:Q1?']);
  const plan = planReviewedCompletion(ctx({ open_questions: ['Q1?'] }), reviewed, { digest });
  assert.equal(plan.cleared.questions, 1);
});

test('a review of the state as it is clears everything: the no-review fallback', () => {
  const now = ctx();
  const plan = planReviewedCompletion(now, taskReviewItems(now));
  assert.deepEqual(plan.cleared, { questions: 2, blocker: true, commands: 1 });
  assert.equal(formatLeftAfterReview(plan.stayed), '');
  assert.deepEqual(describeTaskState(plan.cleared), ['2 open questions', 'the blocking issue', '1 command log entry']);
});

test('several questions left are named, each quoted', () => {
  assert.equal(formatLeftAfterReview({ questions: ['A?', 'B?'], blocker: '', commands: 0 }), 'Left as they were (added after the review, so not shown in it): 2 open questions: "A?", "B?".');
});

test('M1: a section-filtered view: a withheld field is hidden, never planned, never quoted', () => {
  const view = { open_questions: ['Q1?'], withheld_sections: ['blocking_issue', 'commands'] };
  const plan = planReviewedCompletion(view, taskReviewItems({ open_questions: [] }));
  assert.deepEqual(plan.hidden, ['commands', 'blocking_issue']);
  assert.deepEqual(plan.patch, { open_questions: ['Q1?'] }, 'nothing of a hidden field is written');
  assert.deepEqual(plan.stayed, { questions: ['Q1?'], blocker: '', commands: 0 }, 'only what the caller can view can stay');
});

test('M1: what stayed in a section the write skipped is named by section, not quoted', () => {
  const { stayedOutside, orderLeftSections } = require('../src/index.js');
  assert.deepEqual(stayedOutside({ questions: ['Q?'], blocker: 'B', commands: 2 }, new Set(['open_questions', 'commands'])), { questions: [], blocker: 'B', commands: 0 });
  assert.deepEqual(orderLeftSections(new Set(['shipped', 'blocking_issue', 'commands', 'open_questions'])), ['commands', 'open_questions', 'blocking_issue', 'shipped']);
});
