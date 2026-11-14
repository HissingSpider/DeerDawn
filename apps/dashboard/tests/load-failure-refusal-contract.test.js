/**
 * B3-3, the wiring half: every page that loads the workspace's data asks ONE
 * classifier (src/lib/loadFailure.ts) whether a failed load was refused or did
 * not come back, and says so.
 *
 * The behaviour (which refusal, which reader, which sentence) is executed by
 * src/lib/loadFailure.test.ts. This file covers only what a unit test cannot:
 * that the pages still route through it. The defect lived in the pages: each
 * had its own catch that set a boolean, and every boolean rendered "The request
 * didn't come back — usually a dropped connection". A paying person locked for
 * a failed renewal read that on Today, a SAMPLE brief on Projects, "No board
 * yet" on Board, and a generic failure on Portfolio, Trails, Memory and Skills.
 *
 * Run: `node --test tests/load-failure-refusal-contract.test.js`
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const repo = path.resolve(root, '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(root, rel));

/** Source with block and line comments stripped: comments are not behaviour. */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// Every page whose load failure used the generic branch, found by sweeping for
// its wording and for a lone Retry under a refused load.
const PAGES_WITH_OWN_LOAD = [
  'src/pages/index.tsx',
  'src/pages/portfolio.tsx',
  'src/pages/trails.tsx',
  'src/pages/memory.tsx',
  'src/pages/settings/skills.tsx',
];
// Projects and Board share one loader.
const SHARED_LOADER = 'src/components/dashboard/brief/useProjectContext.ts';
const LOADER_PAGES = ['src/components/dashboard/brief/BriefWorkspace.tsx', 'src/pages/board.tsx'];

test('the classifier and the refusal notice exist', () => {
  assert.ok(exists('src/lib/loadFailure.ts'), 'src/lib/loadFailure.ts is the one classifier');
  assert.ok(exists('src/components/dashboard/RefusalNotice.tsx'), 'the shared refusal notice');
});

test('every page with its own load asks the classifier why it failed, and shows a refusal as one', () => {
  for (const rel of PAGES_WITH_OWN_LOAD) {
    const src = code(read(rel));
    assert.match(
      src,
      /import\s*\{[^}]*\bloadFailureFrom\b[^}]*\}\s*from\s*['"]@\/components\/dashboard\/RefusalNotice['"]/s,
      `${rel} must classify its load failure through loadFailureFrom`,
    );
    assert.match(src, /\bloadFailureFrom\(err|\bloadFailureFrom\(e\)/, `${rel} imports loadFailureFrom but never calls it`);
    assert.match(src, /isRefusedLoad\(failure\)/, `${rel} must branch on the classifier's answer`);
    assert.match(src, /<RefusalNotice failure=\{/, `${rel} must render the refusal notice`);
  }
});

test('the refusal is checked before the page\'s own failure and empty states', () => {
  const order = {
    'src/pages/index.tsx': ['{refusal ? <RefusalNotice', '{failed ? (', '<NothingYet />'],
    'src/pages/portfolio.tsx': ['{refusal ? <RefusalNotice', '{error ? ('],
    'src/pages/trails.tsx': ['{listRefusal ? (', 'listError ? (', 'No share links yet.'],
    'src/pages/settings/skills.tsx': [') : refusal ? (', ') : loadError ? (', 'No shared skills yet'],
    'src/pages/memory.tsx': ['if (refusal) {', 'if (error) {'],
  };
  for (const [rel, marks] of Object.entries(order)) {
    const src = code(read(rel));
    const at = marks.map((m) => src.indexOf(m));
    at.forEach((i, n) => assert.ok(i > -1, `${rel}: "${marks[n]}" not found`));
    for (let n = 1; n < at.length; n += 1) {
      assert.ok(at[n - 1] < at[n], `${rel}: "${marks[n - 1]}" must come before "${marks[n]}"`);
    }
  }
  // While a refusal is on screen the page is not also "loading".
  assert.match(code(read('src/pages/index.tsx')), /projects === null && !failed && !refusal \?/);
  assert.match(code(read('src/pages/portfolio.tsx')), /data === null && !error && !refusal \?/);
});

test('Projects and Board learn the reason from their shared loader and show it instead of a sample', () => {
  const loader = code(read(SHARED_LOADER));
  assert.match(loader, /\bloadFailureFrom\(/, 'useProjectContext must classify the list failure');
  assert.match(loader, /\bprojectsFailure\b/, 'useProjectContext must expose why the list failed');
  for (const rel of LOADER_PAGES) {
    const src = code(read(rel));
    assert.match(src, /isRefusedLoad\(projectsFailure\)/, `${rel} must ask whether the list was refused`);
    assert.match(src, /if \(refused\) return <RefusalNotice failure=\{refused\} \/>/, `${rel} must render the refusal before any empty state`);
    // The "showing a sample" line is for a list that did not come back, never for a refusal.
    assert.match(src, /projectsError && !refused &&/, `${rel} still says "showing a sample" to a refused workspace`);
  }
});

test('a genuine network failure keeps each page\'s own words and its Retry', () => {
  const unchanged = {
    'src/pages/index.tsx': "The request didn't come back — usually a dropped connection or an expired session. Nothing is lost; retrying is safe.",
    'src/pages/portfolio.tsx': "The request didn't come back — usually a dropped connection. Nothing is lost; retrying is safe.",
    'src/pages/trails.tsx': "Any links you have made are still live — this list just didn't load, so nothing here can be trusted as complete.",
    'src/pages/settings/skills.tsx': "The list didn't come back, so we can't tell you what's there. Nothing was changed; retrying is safe.",
  };
  for (const [rel, sentence] of Object.entries(unchanged)) {
    const src = read(rel);
    assert.ok(src.includes(sentence), `${rel} changed its words for a load that did not come back`);
    assert.match(code(src), /<InlineErrorState[\s\S]*?onRetry=/, `${rel} dropped the Retry for a load that did not come back`);
  }
  // Projects keeps its sample-brief line for a list that did not come back.
  assert.ok(read('src/components/dashboard/brief/BriefWorkspace.tsx').includes('showing a sample brief. Retry by reloading.'));
  const notice = code(read('src/components/dashboard/RefusalNotice.tsx'));
  assert.doesNotMatch(notice, /onRetry/, 'a refusal must not offer Retry: the retry is refused identically');
});

test('the generic wording appears nowhere else unclassified', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) files.push(rel);
    }
  };
  walk('src/pages');
  walk('src/components');
  // ContextPanel's sentence is about a SEARCH that did not come back, not a page
  // load. It lives in Memory's library tab, which is never rendered while the
  // workspace refuses Memory's own load: memory.tsx shows the refusal instead.
  const allowed = new Set(['src/components/dashboard/ContextPanel.tsx']);
  for (const rel of files) {
    if (allowed.has(rel)) continue;
    const src = code(read(rel));
    if (/didn.t come back|dropped connection/.test(src)) {
      assert.match(src, /\bloadFailureFrom\(/, `${rel} renders the generic failure text without asking the classifier first`);
    }
  }
});

test('the refusal speaks only in sentences the API and the product already use', () => {
  const lib = read('src/lib/loadFailure.ts');
  const enforcePlan = fs.readFileSync(path.join(repo, 'apps/api/src/middleware/enforcePlan.js'), 'utf8');
  const teamInvites = read('src/lib/teamInvites.ts');
  // The API's own refusal messages.
  assert.ok(enforcePlan.includes("'Your subscription is not active. Update billing to restore access.'"));
  // The lock sentences are the owner's, by reason (2026-09-29): the API's
  // lockReasons.js and the dashboard's lockCopy.ts say the same three, and
  // enforcePlan sends the one for the lock. The old catch-all is gone.
  const apiLocks = fs.readFileSync(path.join(repo, 'apps/api/src/services/lockReasons.js'), 'utf8');
  const dashLocks = read('src/lib/lockCopy.ts');
  assert.ok(enforcePlan.includes('LOCK_MESSAGES[lockReason]'));
  assert.ok(!enforcePlan.includes('Contact support to restore access.'));
  for (const sentence of [
    'Billing cannot lift it. Email support from the address on this account and we will review it.',
    'Ask an owner to turn lockdown off. ',
    'Switch to your own workspace to keep working, or ask its owner to lift the lock.',
  ]) {
    assert.ok(apiLocks.includes(sentence), `the API no longer says "${sentence}"`);
    assert.ok(dashLocks.includes(sentence), `the dashboard no longer says "${sentence}"`);
  }
  assert.ok(lib.includes("'Update billing to restore access.'"));
  // The product's own wording for this state and for who can act on it.
  assert.ok(teamInvites.includes('This workspace’s subscription is inactive.'));
  assert.ok(lib.includes("'This workspace’s subscription is inactive'"));
  assert.ok(teamInvites.includes('Only a workspace owner can restore it by updating billing.'));
  assert.ok(lib.includes("'Only a workspace owner can restore it by updating billing.'"));
});

test('the billing link agrees with the fallback banner: same page, same label, owners only', () => {
  const banner = read('src/components/dashboard/WorkspaceFallbackBanner.tsx');
  const lib = code(read('src/lib/loadFailure.ts'));
  assert.match(banner, /href="\/settings\/plan"/);
  assert.match(lib, /UPDATE_BILLING_ROUTE = '\/settings\/plan'/);
  assert.match(banner, /'Update billing'/);
  assert.match(lib, /UPDATE_BILLING_LABEL = 'Update billing'/);
  // Journey r4: one rule for every page, lib/billingAccess (its behaviour for
  // every role is run in src/lib/billingAccess.test.ts). Both surfaces ask it.
  assert.match(lib, /mayOfferBilling\(\{ role: reader\?\.role \}\)/, 'only a named owner is offered the link, as mayFixFallbackBilling does');
  assert.match(code(read('src/lib/workspaceFallback.ts')), /mayOfferBilling\(\{ role: named\?\.role \}\)/);
  assert.match(code(read('src/lib/billingAccess.ts')), /=== 'owner'/);
});

test('a refused rollup is not reported as an error on every page', () => {
  // The nav reads /context/activity on every page; while locked it is refused
  // every time, and logging that put an "ApiError" issue on every page.
  const hook = code(read('src/components/dashboard/useWeeklyActivity.ts'));
  assert.match(hook, /if \(isRefusedLoad\(classifyLoadFailure\(err\)\)\) return;\s*logger\.error\('weekly_activity_failed'/);
  const loader = code(read(SHARED_LOADER));
  assert.match(loader, /if \(!isRefusedLoad\(failure\)\) logger\.error\('brief_projects_failed'/);
  const skills = code(read('src/pages/settings/skills.tsx'));
  assert.match(skills, /if \(isRefusedLoad\(failure\)\) \{\s*setRefusal\(failure\);\s*return;\s*\}\s*logger\.error\('skills_load_failed'/);
});
