const test = require('node:test');
const assert = require('node:assert/strict');

const { createContextObject, mergeContextObject } = require('../src');

// An extraction delta names the items the model saw in ONE conversation, never
// the whole stored list. Replacing the list with the delta meant one new goal
// deleted every goal the conversation did not happen to mention.

const LIST_FIELDS = ['goals', 'tech_stack', 'recurring_context', 'file_structure_summary'];

for (const field of LIST_FIELDS) {
  test(`mergeContextObject adds to ${field} instead of replacing it`, () => {
    const current = createContextObject({ project_name: 'Atlas', [field]: ['one', 'two', 'three'] });
    const merged = mergeContextObject(current, { [field]: ['four'] });
    assert.deepStrictEqual(merged[field], ['one', 'two', 'three', 'four']);
  });

  test(`mergeContextObject does not duplicate a ${field} entry that differs only in case or spacing`, () => {
    const current = createContextObject({ project_name: 'Atlas', [field]: ['Node.js', 'Postgres'] });
    const merged = mergeContextObject(current, { [field]: ['  node.js ', 'Redis'] });
    assert.deepStrictEqual(merged[field], ['Node.js', 'Postgres', 'Redis']);
  });

  test(`mergeContextObject keeps ${field} inside the schema cap, newest kept`, () => {
    const stored = Array.from({ length: 15 }, (_, i) => `item ${i + 1}`);
    const current = createContextObject({ project_name: 'Atlas', [field]: stored });
    const merged = mergeContextObject(current, { [field]: ['item 16'] });
    assert.equal(merged[field].length, 15);
    assert.equal(merged[field][14], 'item 16');
    assert.equal(merged[field][0], 'item 2');
  });
}

test('completed_goals still removes a goal from the unioned list', () => {
  const current = createContextObject({ project_name: 'Atlas', goals: ['Ship auth', 'Ship billing'] });
  const merged = mergeContextObject(current, { goals: ['Ship teams'], completed_goals: ['Ship auth'] });
  assert.deepStrictEqual(merged.goals, ['Ship billing', 'Ship teams']);
});

test('a delta with no list fields leaves the stored lists alone', () => {
  const current = createContextObject({ project_name: 'Atlas', goals: ['Ship auth'], tech_stack: ['Node.js'] });
  const merged = mergeContextObject(current, { current_status: 'Testing.' });
  assert.deepStrictEqual(merged.goals, ['Ship auth']);
  assert.deepStrictEqual(merged.tech_stack, ['Node.js']);
});

// ─── The decision log's cap ──────────────────────────────────────────────────

const { capDecisions } = require('../src');

function decision(summary, extra = {}) {
  return { summary, decided_at: '2026-09-01T12:00:00.000Z', importance: 'normal', ...extra };
}

test('a full decision log evicts a resolved entry before a live one', () => {
  const log = Array.from({ length: 20 }, (_, i) => decision(`live decision ${i}`));
  log[7] = decision('already resolved', { resolved: true });
  const current = createContextObject({ project_name: 'Atlas', recent_decisions: log });
  const merged = mergeContextObject(current, { recent_decisions: [decision('the new one')] });
  const summaries = merged.recent_decisions.map((d) => d.summary);
  assert.equal(summaries.length, 20);
  assert.ok(!summaries.includes('already resolved'));
  assert.ok(summaries.includes('live decision 0'), 'the oldest LIVE decision was evicted while a resolved one kept its seat');
  assert.ok(summaries.includes('the new one'));
});

test('a full decision log evicts low importance before critical, however old the critical one is', () => {
  const log = Array.from({ length: 20 }, (_, i) => decision(`run log ${i}`, { importance: 'low' }));
  log[0] = decision('never deploy on Fridays', { importance: 'critical' });
  const current = createContextObject({ project_name: 'Atlas', recent_decisions: log });
  const merged = mergeContextObject(current, { recent_decisions: [decision('another run log', { importance: 'low' })] });
  const summaries = merged.recent_decisions.map((d) => d.summary);
  assert.ok(summaries.includes('never deploy on Fridays'), 'the critical decision was evicted for a run-log');
  assert.ok(!summaries.includes('run log 1'), 'the oldest low-importance entry should have gone');
});

test('the entry just written is never the one evicted, even into a log of higher-ranked entries', () => {
  const log = Array.from({ length: 20 }, (_, i) => decision(`high decision ${i}`, { importance: 'high' }));
  const kept = capDecisions([...log, decision('a low note', { importance: 'low' })], { keep: ['a low note'] });
  assert.equal(kept.length, 20);
  assert.ok(kept.some((d) => d.summary === 'a low note'));
});

test('open questions render newest-first, matching the end the cap evicts from', () => {
  const { formatSectionInjection } = require('../src');
  const current = createContextObject({ project_name: 'Atlas', open_questions: ['q one?', 'q two?', 'q three?', 'q four?'] });
  const body = formatSectionInjection(current, ['questions']);
  assert.match(body, /q four\?/);
  assert.ok(!/q one\?/.test(body), 'the oldest question was rendered and the newest was not');
  assert.ok(body.indexOf('q four?') < body.indexOf('q two?'));
});
