/**
 * Render-tree contracts: a component that stops being rendered must fail a test.
 *
 * WHY THIS EXISTS: `OnboardingChecklist.tsx` sat in `src/components` for months,
 * exported, styled, analytics-wired — and imported by nothing. Two things referred
 * to it and both were fiction: a comment in `onboarding.tsx` promising it would
 * "pick up" users who bailed out of setup, and an assertion in
 * `onboarding-activation-contract.test.js` that read its SOURCE TEXT via
 * `fs.readFileSync` and checked the analytics surface label.
 *
 * That is the whole defect class. Every contract suite in `tests/` reads source as
 * TEXT, so it asserts a file's CONTENTS, never its REACHABILITY. A file on disk
 * satisfies a readFileSync assertion whether or not anything mounts it — delete the
 * `<Component />` from the only page that rendered it and every test stays green.
 * Text tests are still the right tool for pinning copy and wiring; they just cannot
 * see this, so the reachability half has to live somewhere, and it lives here.
 *
 * Two guards, both structural:
 *
 *   1. PINNED_RENDERS — named components that must actually be rendered by a file
 *      that is itself reachable from a page. Deleting `<FirstValueBanner />` from
 *      projects.tsx fails this, where a text test for its copy would not.
 *
 *   2. The orphan set — every module under `src/` must be reachable from a page or
 *      a framework entry point, except a short documented allowlist. A component
 *      falling out of the render tree lands here on the next run.
 *
 * Run: `node --test tests/render-tree-contract.test.js`
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'src');
const rel = (file) => path.relative(root, file).split(path.sep).join('/');

// Next.js entry points nothing imports: the framework loads them by convention, so
// being unreachable from a page is correct rather than a symptom.
const FRAMEWORK_ENTRIES = [
  'src/middleware.ts',
  'src/instrumentation.ts',
  // Next loads instrumentation-client.ts on the browser side by the same
  // convention — nothing imports it, and that is correct rather than rot. It
  // initialises Sentry (and arms the replay buffer) before route code runs, so
  // being reachable from a page would defeat the point of it.
  'src/instrumentation-client.ts',
];

/**
 * Modules that are genuinely unreachable today and are NOT being fixed here.
 *
 * This list is dead-code debt made visible. It is deliberately awkward to extend:
 * adding a line is the moment to ask whether the module should be deleted instead.
 * The test fails if an entry stops being an orphan or stops existing, so the list
 * cannot rot the way the thing it guards against did.
 */
const KNOWN_ORPHANS = [
  // Barrel file; both exports are imported from their own modules directly.
  'src/components/layout/index.ts',
  // Auth error copy helper, left behind by the Clerk-first auth rework.
  'src/lib/authErrors.ts',
  // Pre-remote-MCP onboarding UI: shows an API key that OAuth setup never issues.
  'src/components/OnboardingKeyDisplay.tsx',
  // Superseded by the connection strip on `/` (Today) after the 2026-08-27 redesign.
  'src/components/SystemHealthCard.tsx',
];

/**
 * Components that must stay in the render tree, and the file that must render them.
 *
 * `owner` has to both reference the component as JSX and be reachable from a page.
 * Each entry names a surface whose absence is silent — nothing errors, a user just
 * never sees it — which is exactly the failure mode text assertions miss.
 */
const PINNED_RENDERS = [
  {
    component: 'SampleBriefEmptyState',
    owner: 'src/components/dashboard/brief/BriefWorkspace.tsx',
    why: 'the empty brief workspace is what a new account sees instead of a blank page',
  },
  {
    component: 'FirstValueBanner',
    owner: 'src/pages/projects.tsx',
    why: 'the first-value banner is the only prompt to connect a tool on the brief page',
  },
  {
    component: 'ConnectionHealth',
    owner: 'src/pages/index.tsx',
    why:
      'the connection strip is the only place Today ever says a tool has stopped calling in; ' +
      'it renders from one of two slots, so dropping the wrong one leaves a page that looks ' +
      'complete and silently never reports a broken install',
  },
  {
    component: 'ProofLine',
    owner: 'src/pages/index.tsx',
    why:
      'the one line of evidence on the landing page of a memory product — DeerDawn works by ' +
      'preventing a cost the user never sees, so with this gone the page asks to be taken on faith',
  },
  {
    component: 'TaskCardBodyDialog',
    owner: 'src/components/dashboard/brief/TaskBoard.tsx',
    why:
      'the only place a card body can be READ — the board deliberately shows a marker and ' +
      'nothing else, so with the dialog unmounted every body written from an agent session ' +
      'is invisible and the board silently goes back to being titles-only',
  },
  {
    component: 'DashboardBootstrapProvider',
    owner: 'src/components/layout/Layout.tsx',
    why:
      'a dozen surfaces call useDashboardBootstrap; unmount the provider and every one of ' +
      'them reads an empty bootstrap instead of failing loudly',
  },
];

const SOURCE_FILE = /\.(tsx|ts|jsx|js)$/;
const NON_SOURCE = /\.(test|contract)\.[cm]?[jt]sx?$|\.d\.ts$/;
const RESOLVE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (SOURCE_FILE.test(entry.name) && !NON_SOURCE.test(entry.name)) acc.push(full);
  }
  return acc;
}

/** Resolve an import specifier to a file on disk. Bare package specifiers are ignored. */
function resolveSpecifier(spec, fromFile) {
  let base;
  if (spec.startsWith('@/')) base = path.join(srcDir, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // node_modules — not our render tree

  for (const ext of RESOLVE_EXTENSIONS) {
    if (fs.existsSync(base + ext)) return base + ext;
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    const index = path.join(base, `index${ext}`);
    if (fs.existsSync(index)) return index;
  }
  return fs.existsSync(base) && fs.statSync(base).isFile() ? base : null;
}

/**
 * Every specifier a file pulls in: static `from` clauses (import and re-export),
 * side-effect imports, and dynamic `import()` — which is how `next/dynamic` loads a
 * component, so a lazily-loaded surface still counts as rendered.
 *
 * Deliberately an over-approximation: a specifier-shaped string inside a comment
 * costs a false "reachable", while missing a real edge would cost a false failure.
 * Noisy tests get deleted, so this errs toward silence over crying wolf.
 */
function importSpecifiers(file) {
  const source = fs.readFileSync(file, 'utf8');
  const specs = [];
  for (const pattern of [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    let match;
    while ((match = pattern.exec(source))) specs.push(match[1]);
  }
  return specs;
}

/** Files the framework loads directly: every page, plus the convention entry points. */
function entryPoints() {
  const pages = walk(path.join(srcDir, 'pages'));
  const framework = FRAMEWORK_ENTRIES.map((f) => path.join(root, f)).filter((f) => fs.existsSync(f));
  return [...pages, ...framework];
}

/** Everything reachable from the entry points by following imports. */
function reachableModules() {
  const seen = new Set();
  const stack = entryPoints();
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importSpecifiers(file)) {
      const resolved = resolveSpecifier(spec, file);
      if (resolved && !seen.has(resolved)) stack.push(resolved);
    }
  }
  return seen;
}

test('the render tree has entry points and resolves past them', () => {
  const entries = entryPoints();
  assert.ok(entries.length > 0, 'no pages found — the app structure moved and this test is blind');
  const reachable = reachableModules();
  assert.ok(
    reachable.size > entries.length,
    'import resolution reached nothing beyond the entry points — the alias or extension list is stale, ' +
      'which would make every assertion below vacuous',
  );
});

test('pinned components are actually rendered by a file in the render tree', () => {
  const reachable = reachableModules();

  for (const { component, owner, why } of PINNED_RENDERS) {
    const ownerPath = path.join(root, owner);
    assert.ok(fs.existsSync(ownerPath), `${owner} is gone, so ${component} renders nowhere — ${why}`);
    assert.ok(
      reachable.has(ownerPath),
      `${owner} is no longer reachable from any page, so nothing it renders reaches a user — ${why}`,
    );

    const source = fs.readFileSync(ownerPath, 'utf8');

    // Rendered, not merely mentioned: `<Name>`, `<Name/>`, or `<Name ` with props.
    assert.match(
      source,
      new RegExp(`<${component}[\\s/>]`),
      `${owner} no longer renders <${component} /> — ${why}. A text assertion about its copy would ` +
        'still pass here; that is the gap this test exists to close.',
    );

    // ...and it has to come from somewhere: imported into the owner, or defined in it.
    const imported = new RegExp(`\\b${component}\\b[^;]{0,200}?\\bfrom\\s*['"]`).test(source);
    const defined = new RegExp(
      `(?:function|const|class)\\s+${component}\\b`,
    ).test(source);
    assert.ok(
      imported || defined,
      `${owner} renders <${component} /> but neither imports nor defines it`,
    );
  }
});

test('no module has silently left the render tree', () => {
  const reachable = reachableModules();
  const orphans = walk(srcDir)
    .filter((file) => !reachable.has(file))
    .map(rel)
    .sort();

  const allowlist = [...KNOWN_ORPHANS].sort();
  const unexpected = orphans.filter((file) => !allowlist.includes(file));

  assert.deepEqual(
    unexpected,
    [],
    'these modules are unreachable from every page — nothing renders them, so no user can ever ' +
      `see them: ${unexpected.join(', ')}. Delete them, render them, or (last resort) document ` +
      'them in KNOWN_ORPHANS. This is how OnboardingChecklist rotted for months while its ' +
      'contract test read the file and passed.',
  );
});

test('the known-orphan allowlist cannot rot', () => {
  // An allowlist nobody prunes becomes a place where dead code hides legitimately.
  // Both halves are checked: an entry that got wired back up, and one already deleted.
  const reachable = reachableModules();

  for (const entry of KNOWN_ORPHANS) {
    const full = path.join(root, entry);
    assert.ok(
      fs.existsSync(full),
      `${entry} is listed in KNOWN_ORPHANS but no longer exists — drop the line`,
    );
    assert.ok(
      !reachable.has(full),
      `${entry} is reachable again — remove it from KNOWN_ORPHANS so it is covered like everything else`,
    );
  }
});

test('the component deleted for being unrendered has not come back unrendered', () => {
  // Specific to the bug this suite was written for. If someone restores
  // OnboardingChecklist, it must arrive wired into a page, not as a file on disk.
  // Its `first_sync` step was also wrong — it read
  // `sync_health.has_projects || recently_active` instead of `has_first_sync`, so it
  // ticked "Confirm first briefed session" for anyone who had merely seeded a
  // project and had never been briefed. Restoring it means fixing that first.
  const checklist = path.join(srcDir, 'components/OnboardingChecklist.tsx');
  if (!fs.existsSync(checklist)) return;

  const reachable = reachableModules();
  assert.ok(
    reachable.has(checklist),
    'OnboardingChecklist.tsx is back but still unreachable from any page — it was deleted precisely ' +
      'because it existed without being rendered',
  );
  assert.match(
    fs.readFileSync(checklist, 'utf8'),
    /sync_health\?\.has_first_sync/,
    'a restored OnboardingChecklist must gate its first_sync step on sync_health.has_first_sync — ' +
      'has_projects || recently_active marks a briefed session complete for someone never briefed',
  );
});
