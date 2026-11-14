const test = require('node:test');
const assert = require('node:assert');
const guards = require('../../src/services/contextQualityGuards');

test('isGenericText flags short and boilerplate text', () => {
  assert.strictEqual(guards.isGenericText(''), true);
  assert.strictEqual(guards.isGenericText('in progress'), true);
  assert.strictEqual(guards.isGenericText('working on it'), true);
  assert.strictEqual(guards.isGenericText('short'), true); // < 18 chars
  assert.strictEqual(guards.isGenericText('Refactored the auth token refresh to fix the 401 loop'), false);
});

test('isTrivialText flags content with no substantive token', () => {
  assert.strictEqual(guards.isTrivialText(''), true);
  assert.strictEqual(guards.isTrivialText('ok ok ok'), true);
  assert.strictEqual(guards.isTrivialText('yep'), true);
  assert.strictEqual(guards.isTrivialText('migrate the credentials store'), false);
});

test('jaccardSimilarity and titleSimilarity score overlap sensibly', () => {
  const a = 'apply database migration to staging';
  const b = 'apply database migration to production';
  const far = 'render the marketing pricing hero';
  assert.ok(guards.jaccardSimilarity(a, b) > 0.4, 'paraphrase should overlap');
  assert.ok(guards.jaccardSimilarity(a, far) < 0.15, 'unrelated should be low');
  assert.ok(guards.titleSimilarity(a, a) > 0.9, 'identical titles near 1');
});

test('isVagueDecision rejects filler-only summaries, keeps specific ones', () => {
  for (const vague of [
    'various improvements',
    'general cleanup',
    'API work',
    'misc fixes',
    'made some changes',
    'stuff and things',
  ]) {
    assert.strictEqual(guards.isVagueDecision(vague), true, `should reject: "${vague}"`);
  }
  for (const specific of [
    'Switched session storage from PostgreSQL to Redis',
    'Decided to use Zod for all request schema validation',
    'Drop Node < 18 support because of ESM requirements',
  ]) {
    assert.strictEqual(guards.isVagueDecision(specific), false, `should accept: "${specific}"`);
  }
});

test('isValidProjectName rejects filenames, paths, and placeholders', () => {
  for (const bad of ['CLAUDE.md', 'AGENTS.md', '.cursorrules', 'index.ts', 'Untitled project', 'project', 'src/app', 'a']) {
    assert.strictEqual(guards.isValidProjectName(bad), false, `should reject: "${bad}"`);
  }
  for (const good of ['DeerDawn', 'Context Sync API', 'ApexFundV3', 'Motorcycle Simulator']) {
    assert.strictEqual(guards.isValidProjectName(good), true, `should accept: "${good}"`);
  }
});

test('sanitizeProjectName falls back instead of storing junk', () => {
  assert.strictEqual(guards.sanitizeProjectName('CLAUDE.md', 'DeerDawn'), 'DeerDawn');
  assert.strictEqual(guards.sanitizeProjectName('Context Sync API'), 'Context Sync API');
  assert.strictEqual(guards.sanitizeProjectName('CLAUDE.md', '.gitignore'), 'Untitled project');
});
