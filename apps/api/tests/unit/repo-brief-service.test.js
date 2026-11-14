const test = require('node:test');
const assert = require('node:assert');

const {
  composeRepoDigest,
  condenseMarkdown,
  isUsefulCommitSubject,
} = require('../../src/services/repoBriefService');

// ─── condenseMarkdown ────────────────────────────────────────────────────────
// A README is mostly not prose about the project. Badge rows, HTML blocks and
// fenced examples would otherwise dominate a 6k-character extraction window.

test('condenseMarkdown drops fenced code, HTML and images but keeps link text', () => {
  const md = [
    '# Project',
    '[![build](https://img.shields.io/x.svg)](https://ci.example.com)',
    '<div align="center">centred</div>',
    'We use [Drizzle](https://orm.drizzle.team) for typed SQL.',
    '```bash',
    'npm install everything-irrelevant',
    '```',
  ].join('\n');

  const out = condenseMarkdown(md);

  assert.ok(out.includes('Drizzle'), 'link TEXT survives — it is the project signal');
  assert.ok(!out.includes('orm.drizzle.team'), 'link URL is stripped');
  assert.ok(!out.includes('img.shields.io'), 'badge image is stripped');
  assert.ok(!out.includes('<div'), 'raw HTML tags are stripped');
  assert.ok(!out.includes('npm install everything-irrelevant'), 'fenced code is stripped');
});

test('condenseMarkdown is bounded, so one huge README cannot crowd out the other file', () => {
  const out = condenseMarkdown('x'.repeat(50000));
  assert.ok(out.length <= 6000, `expected <= 6000 chars, got ${out.length}`);
});

test('condenseMarkdown tolerates empty and nullish input', () => {
  assert.strictEqual(condenseMarkdown(''), '');
  assert.strictEqual(condenseMarkdown(null), '');
  assert.strictEqual(condenseMarkdown(undefined), '');
});

// ─── isUsefulCommitSubject ───────────────────────────────────────────────────
// Commit subjects are the ONLY evidence of what a project is working on now. A
// run of merge or dependency-bump commits would read to the model as the
// current task, which is exactly the hallucination this tool cannot afford.

test('isUsefulCommitSubject rejects merges and dependency bumps, keeps real work', () => {
  assert.strictEqual(isUsefulCommitSubject('Merge pull request #12 from feat/x'), false);
  assert.strictEqual(isUsefulCommitSubject('merge branch main into dev'), false);
  assert.strictEqual(isUsefulCommitSubject('Bump axios from 1.2.0 to 1.3.0'), false);
  assert.strictEqual(isUsefulCommitSubject('chore(deps): update lockfile'), false);

  assert.strictEqual(isUsefulCommitSubject('Add refund handling to the billing webhook'), true);
  assert.strictEqual(isUsefulCommitSubject('fix: brief injection dropped open questions'), true);
});

test('isUsefulCommitSubject rejects empty and trivially short subjects', () => {
  assert.strictEqual(isUsefulCommitSubject(''), false);
  assert.strictEqual(isUsefulCommitSubject(null), false);
  assert.strictEqual(isUsefulCommitSubject('wip'), false);
});

// ─── composeRepoDigest ───────────────────────────────────────────────────────

function sourceFixture(overrides = {}) {
  return {
    owner: 'acme',
    repo: 'widget',
    ref: 'main',
    meta: { description: 'A widget', language: 'TypeScript', topics: ['cli'], pushed_at: '', stars: 3, archived: false },
    files: [{ path: 'CLAUDE.md', text: 'Always use Drizzle, never Prisma.' }],
    commits: ['Add refund handling'],
    issues: ['Should refunds be partial?'],
    ...overrides,
  };
}

// THE LOAD-BEARING INVARIANT. Files are stated fact; commit subjects are only
// evidence to reason from. If the digest ever stops drawing that line, the
// model will present an inferred current task as something the project
// declared about itself — the one failure mode that would make this tool read
// as a hallucination machine to the audience it is aimed at.
test('composeRepoDigest marks file content as stated and commits as evidence', () => {
  const digest = composeRepoDigest(sourceFixture());

  assert.ok(digest.includes('STATED IN CLAUDE.md'), 'file content is labelled as stated');
  assert.match(
    digest,
    /RECENT COMMIT SUBJECTS[^\n]*not statements about the project/,
    'commit section explicitly disclaims being a statement about the project'
  );
  const statedAt = digest.indexOf('STATED IN CLAUDE.md');
  const commitsAt = digest.indexOf('RECENT COMMIT SUBJECTS');
  assert.ok(statedAt < commitsAt, 'stated fact precedes inference material');
});

test('composeRepoDigest includes the repo identity and metadata it was given', () => {
  const digest = composeRepoDigest(sourceFixture());
  assert.ok(digest.includes('acme/widget'));
  assert.ok(digest.includes('A widget'));
  assert.ok(digest.includes('TypeScript'));
  assert.ok(digest.includes('Should refunds be partial?'));
});

test('composeRepoDigest omits sections it has no data for, rather than emitting empty headers', () => {
  const digest = composeRepoDigest(sourceFixture({ commits: [], issues: [], files: [] }));
  assert.ok(!digest.includes('RECENT COMMIT SUBJECTS'), 'no commit header without commits');
  assert.ok(!digest.includes('OPEN ISSUE TITLES'), 'no issue header without issues');
  assert.ok(!digest.includes('STATED IN'), 'no file header without files');
  assert.ok(digest.includes('acme/widget'), 'identity still present');
});

test('composeRepoDigest surfaces archived repos, so a stale brief is explainable', () => {
  const digest = composeRepoDigest(sourceFixture({ meta: { ...sourceFixture().meta, archived: true } }));
  assert.match(digest, /archived/i);
});
