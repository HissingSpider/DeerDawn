/**
 * A1, the wiring half: when nothing is active, Today, Projects and Board ask
 * whether anything is ARCHIVED before choosing their empty state.
 *
 * The copy is executed by src/lib/archivedProjects.test.ts. This file covers
 * what a unit test cannot: that the pages consult the archive, only when the
 * active list is empty (an account with projects makes no extra request and
 * renders as before), render the notice ahead of the empty states, and that the
 * restore link opens the manager where Restore lives.
 *
 * Run: `node --test tests/archived-projects-empty-state-contract.test.js`
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const repo = path.resolve(root, '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(root, rel));

function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('the notice and its copy exist', () => {
  assert.ok(exists('src/lib/archivedProjects.ts'));
  assert.ok(exists('src/components/dashboard/ArchivedProjectsNotice.tsx'));
});

test('Today asks for archived projects only when nothing is active, before the empty hero', () => {
  const page = code(read('src/pages/index.tsx'));
  const lengthCheck = page.indexOf('if (sorted.length > 0)');
  const archivedCall = page.indexOf('api.getArchivedContextProjects()');
  assert.ok(lengthCheck > 0, 'Today must return early when there are active projects');
  assert.ok(archivedCall > lengthCheck, 'the archive is read only after the active list came back empty');
  assert.match(
    page,
    /archived\.length > 0 \? <ArchivedProjectsNotice archived=\{archived\} \/> : <NothingYet \/>/,
    'the archived notice must come before "Nothing to pick up yet"',
  );
});

test('Projects and Board read the archive through their shared loader, only when the tree is empty', () => {
  const loader = code(read('src/components/dashboard/brief/useProjectContext.ts'));
  assert.match(loader, /tree\.length === 0\s*\?\s*await api\.getArchivedContextProjects\(\)/);
  const brief = code(read('src/components/dashboard/brief/BriefWorkspace.tsx'));
  const notice = brief.indexOf('<ArchivedProjectsNotice');
  const sample = brief.indexOf('<SampleBriefEmptyState />');
  assert.ok(notice > 0 && sample > notice, 'Projects must show the archived notice ahead of the sample brief');
  const board = code(read('src/pages/board.tsx'));
  assert.match(board, /archived\.length > 0 \? <ArchivedProjectsNotice archived=\{archived\} \/> : <NoProjectsYet \/>/);
});

test('"Restore a project" opens the manager on /projects, where Restore lives', () => {
  const lib = read('src/lib/archivedProjects.ts');
  assert.match(lib, /RESTORE_ROUTE = '\/projects\?manage=archived'/);
  const brief = code(read('src/components/dashboard/brief/BriefWorkspace.tsx'));
  assert.match(brief, /router\.query\.manage !== 'archived'/);
  assert.match(brief, /setManagerOpen\(true\);\s*void router\.replace\(/, 'the manager opens and the parameter is dropped');
  const manager = read('src/components/dashboard/brief/ProjectManager.tsx');
  assert.match(manager, /Restore/);
});

test('the dashboard says what the hosted tool says: archived, not gone', () => {
  const hosted = fs.readFileSync(path.join(repo, 'packages/shared-context/src/index.js'), 'utf8');
  assert.ok(hosted.includes('archived projects are waiting, not gone'));
  assert.ok(hosted.includes('is archived, not gone.'));
  const lib = read('src/lib/archivedProjects.ts');
  assert.ok(lib.includes('archived projects are waiting, not gone.'));
  assert.ok(lib.includes('is archived, not gone.'));
});
