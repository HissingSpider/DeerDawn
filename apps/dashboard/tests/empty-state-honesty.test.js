/**
 * "Does this state distinguish 'nothing here' from 'we failed to load'?"
 *
 * Four surfaces answered no. Each caught a failed request, wrote an empty
 * result, and rendered the reassuring empty state for it — so a dropped
 * connection read as a fact about the account:
 *
 *   settings/skills.tsx   a failed list  -> "No shared skills yet"
 *   settings/refer.tsx    a failed load  -> "Loading…", forever, buttons dead
 *   ContextPanel.tsx      a failed search-> "No matches for X"
 *   trails.tsx            a failed list  -> "No share links yet." while live
 *                                            links keep serving briefs
 *
 * Source-contract tests, because this app has no renderer in its test
 * toolchain: they pin the shape of the fix (an error branch that is not the
 * empty branch, and a way back), not its wording.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

/**
 * The same file with its comments removed. Source-text assertions have been
 * fooled before by a comment that quotes the very code it replaced — including
 * the ones in the files under test here, which explain the old broken line.
 */
const readCode = (...parts) => read(...parts)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\*|\{\/\*)/.test(line))
  .join('\n');

test('the skills page separates a failed list from an empty one, and its limit message can fire', () => {
  const src = readCode('src', 'pages', 'settings', 'skills.tsx');

  assert.match(src, /setLoadError/, 'a failed list load must be recorded, not just logged');
  assert.match(src, /loadError \? \(\s*<InlineErrorState/, 'and must render as an error, before the empty state');
  assert.match(src, /onRetry=\{load\}/, 'with a way to try again');

  // The bug: the quota refusal is { error: 'skills_limit_exceeded' } with no
  // `code` key, so `err.code === 'skills_limit_exceeded'` was unreachable and
  // every capped save showed the generic failure toast.
  assert.doesNotMatch(src, /err\.code === 'skills_limit_exceeded'/,
    'err.code is undefined for this refusal — read the reason with apiErrorReason');
  assert.match(src, /apiErrorReason\(err\) === 'skills_limit_exceeded'/);
  assert.match(src, /reached your skills limit/);
});

test('the refer page can fail, and says so instead of loading forever', () => {
  const src = readCode('src', 'pages', 'settings', 'refer.tsx');

  assert.doesNotMatch(src, /getReferralOverview\(\)\.then\(setReferrals\)\.catch\(\(\) => \{\}\)/,
    'the swallowed catch is what left the page on "Loading…" with every button disabled');
  assert.match(src, /setLoadError/);
  assert.match(src, /<InlineErrorState/);
  assert.match(src, /onRetry=\{load\}/);
  // "Loading…" must be reachable only while a request is actually in flight.
  assert.match(src, /loading \? 'Loading…'/);
});

test('a failed search is not an answer about your context', () => {
  const src = readCode('src', 'components', 'dashboard', 'ContextPanel.tsx');

  assert.doesNotMatch(src, /\} catch \{\s*if \(!cancelled\) setResults\(\[\]\);\s*\}/,
    'a bare catch that empties the results turns a 500 into "No matches"');
  assert.match(src, /setFailed\(true\)/);
  assert.match(src, /failed \? \(/, 'the error branch must come before the "No matches" branch');
  const failedAt = src.indexOf('failed ? (');
  const noMatchesAt = src.indexOf('No matches for \u201C');
  assert.ok(failedAt > -1 && failedAt < noMatchesAt, 'error state must be checked before the empty state');
  assert.match(src, /Try again/);
  // The documents tab had the same shape.
  assert.match(src, /context_projects_load_failed/);
});

test('a failed share-link list never renders as "no share links"', () => {
  const src = readCode('src', 'pages', 'trails.tsx');

  assert.doesNotMatch(src, /\.catch\(\(\) => setShares\(\[\]\)\)/,
    'writing [] on failure tells somebody with live public links that they have none');
  assert.match(src, /setListError/);
  assert.match(src, /listError \? \(\s*<InlineErrorState/);
  assert.match(src, /onRetry=\{load\}/);

  const errorAt = src.indexOf('listError ? (');
  const emptyAt = src.indexOf('No share links yet.');
  assert.ok(errorAt > -1 && errorAt < emptyAt, 'the error branch must be checked before the empty one');
});

test('ContextNetwork is live code and is still wired to the memory page', () => {
  // Reported as dead code and slated for deletion. It is not: /memory renders
  // LibraryTab, which dynamically imports it, and it is the local precedent for
  // "error is not empty" (it already has an ErrorState with a retry). Pinned so
  // the next sweep does not delete a live screen on the same report.
  const library = read('src', 'components', 'dashboard', 'brief', 'LibraryTab.tsx');
  const memory = read('src', 'pages', 'memory.tsx');
  assert.match(library, /import\('@\/components\/dashboard\/ContextNetwork'\)/);
  assert.match(memory, /<LibraryTab/);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'components', 'dashboard', 'ContextNetwork.tsx')));
});
