/**
 * JOURNEY R4 — /portfolio AND /memory SAY "ARCHIVED, NOT GONE" TOO.
 *
 * Round 3 (A1) put ArchivedProjectsNotice on Today, Projects and Board. With
 * every project archived, /portfolio still said "No decisions recorded yet" and
 * /memory "Nothing briefed yet". Both now ask the same question (is the active
 * list empty and the archive not?), only when their own content is empty, and
 * show the same notice in place of their empty state.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const code = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the shared question reads the archive only when nothing is active', () => {
  const hook = code('src/components/dashboard/useArchivedOnly.ts');
  assert.match(hook, /if \(!enabled\)/, 'asked only while the page itself is empty');
  assert.match(hook, /api\.getContextProjects\(\)/);
  assert.match(hook, /active\.length > 0\) return;[\s\S]*api\.getArchivedContextProjects\(\)/, 'the archive after an empty active list');
});

test('/portfolio shows the archived notice in place of its empty page', () => {
  const page = code('src/pages/portfolio.tsx');
  assert.match(page, /useArchivedOnly\(Boolean\(data\) && data!\.counts\.projects === 0\)/);
  const notice = page.indexOf('<ArchivedProjectsNotice archived={archivedOnly} />');
  const empty = page.indexOf('No decisions recorded yet.');
  assert.ok(notice > 0 && empty > notice, 'the notice comes before, and instead of, the empty sentence');
});

test('/memory shows the archived notice in place of "Nothing briefed yet"', () => {
  const page = code('src/pages/memory.tsx');
  assert.match(page, /useArchivedOnly\(!loading && !refusal && \(!graph \|\| graph\.nodes\.length === 0\)\)/);
  const notice = page.indexOf('<ArchivedProjectsNotice archived={archivedOnly} />');
  const empty = page.indexOf('title="Nothing briefed yet"');
  assert.ok(notice > 0 && empty > notice);
});

test('the /checkout "Open the billing portal" button is 40px on a phone, desktop untouched', () => {
  const page = code('src/pages/checkout.tsx');
  assert.match(page, /<Button className="max-sm:h-\[40px\]" disabled=\{openingPortal\}/);
});
