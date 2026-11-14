const test = require('node:test');
const assert = require('node:assert');

const {
  projectNameFromLabel,
  contextPatchFromFields,
} = require('../../src/services/briefStashService');

// ─── projectNameFromLabel ────────────────────────────────────────────────────
// The level-0 tool labels repo briefs "owner/repo". createProject's name guard
// reads a slash as a file path and rejects it, so a naive pass-through would
// fail every repo-derived project at the last step of the signup it was meant
// to improve.

test('an owner/repo label becomes the repo name', () => {
  assert.strictEqual(projectNameFromLabel('yamadashy/repomix', 0), 'repomix');
  assert.strictEqual(projectNameFromLabel('vercel/next.js', 0), 'next.js');
});

test('a label with spaces keeps its words, with slashes flattened not truncated', () => {
  // A pasted brief is labelled from its description, which can contain a slash
  // without being a repo path. Taking the last segment there would silently
  // throw away the front of the sentence.
  assert.strictEqual(
    projectNameFromLabel('A Next.js app with Postgres/Drizzle', 0),
    'A Next.js app with Postgres Drizzle'
  );
});

test('names are bounded and whitespace-normalised', () => {
  const out = projectNameFromLabel(`  ${'word '.repeat(40)}  `, 0);
  assert.ok(out.length <= 60, `expected <= 60 chars, got ${out.length}`);
  assert.ok(!out.startsWith(' '), 'leading whitespace trimmed');
  assert.ok(!/\s\s/.test(out), 'internal whitespace collapsed');
});

test('an unusable label falls back rather than throwing, so one bad brief does not sink the claim', () => {
  assert.strictEqual(projectNameFromLabel('', 0), 'Imported project 1');
  assert.strictEqual(projectNameFromLabel('   ', 2), 'Imported project 3');
  assert.strictEqual(projectNameFromLabel(null, 0), 'Imported project 1');
  // A single character is too short for createProject's guard.
  assert.strictEqual(projectNameFromLabel('x', 4), 'Imported project 5');
});

// ─── contextPatchFromFields ──────────────────────────────────────────────────

test('only populated fields reach the patch, so an empty brief writes nothing', () => {
  assert.deepStrictEqual(contextPatchFromFields({}), {});
  assert.deepStrictEqual(contextPatchFromFields(undefined), {});
  // Whitespace-only strings are absence, not content.
  assert.deepStrictEqual(contextPatchFromFields({ description: '   ', current_task: '' }), {});
  // Empty arrays likewise.
  assert.deepStrictEqual(contextPatchFromFields({ tech_stack: [], open_questions: [] }), {});
});

test('scalar fields are trimmed and carried', () => {
  const patch = contextPatchFromFields({
    description: '  A widget  ',
    current_task: 'Refunds',
    current_status: 'In progress',
    blocking_issue: 'Waiting on Stripe',
  });
  assert.strictEqual(patch.description, 'A widget');
  assert.strictEqual(patch.current_task, 'Refunds');
  assert.strictEqual(patch.current_status, 'In progress');
  assert.strictEqual(patch.blocking_issue, 'Waiting on Stripe');
});

test('decisions normalise from either shape and always carry a timestamp', () => {
  const patch = contextPatchFromFields({
    recent_decisions: ['Drizzle over Prisma', { summary: 'jose over jsonwebtoken' }],
  });
  assert.strictEqual(patch.recent_decisions.length, 2);
  for (const decision of patch.recent_decisions) {
    assert.ok(decision.summary, 'every decision keeps a summary');
    assert.ok(Date.parse(decision.decided_at), 'every decision carries a parseable decided_at');
  }
});

test('decisions without a usable summary are dropped rather than written as blanks', () => {
  const patch = contextPatchFromFields({
    recent_decisions: ['', { summary: '   ' }, null, { notASummary: 'x' }, 'Real one'],
  });
  assert.strictEqual(patch.recent_decisions.length, 1);
  assert.strictEqual(patch.recent_decisions[0].summary, 'Real one');
});

test('list fields are capped, so an over-long extraction cannot bloat a project', () => {
  const patch = contextPatchFromFields({
    tech_stack: Array.from({ length: 50 }, (_, i) => `tech-${i}`),
    open_questions: Array.from({ length: 50 }, (_, i) => `q-${i}`),
    recent_decisions: Array.from({ length: 50 }, (_, i) => `d-${i}`),
  });
  assert.strictEqual(patch.tech_stack.length, 20);
  assert.strictEqual(patch.open_questions.length, 20);
  assert.strictEqual(patch.recent_decisions.length, 20);
});
