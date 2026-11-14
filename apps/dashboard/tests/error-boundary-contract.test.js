/**
 * WHERE the error boundaries are mounted — the half a state-machine test
 * cannot see.
 *
 * The defect: one boundary, mounted in `_app.tsx` above ClerkProvider,
 * AuthProvider and Layout. A throw in a single panel of a single page therefore
 * replaced the sidebar, the nav and every other route with a full-screen
 * apology, whose two buttons both dead-ended (reload re-mounted the same crash;
 * "Try Again" re-rendered the identical tree). The app was unusable until the
 * user typed a different URL by hand, and nothing on screen said so.
 *
 * The fix is structural, so the guard has to be too. Two invariants:
 *
 *   1. There is a boundary INSIDE the shell, wrapping only the routed page, so
 *      the nav survives a page crash and is clickable.
 *   2. The outer, shell-less boundary in _app.tsx still exists. Scoping is an
 *      addition — a crash in ClerkProvider or DashboardBootstrapProvider is
 *      above the inner one and would otherwise reach the white screen.
 *
 * The behavioural half (that a caught error is RELEASED on navigation) is in
 * `src/lib/errorBoundary.test.ts`. Neither guard means much alone: a boundary
 * that resets but wraps everything still blanks the dashboard, and one scoped
 * correctly but never reset leaves a dead panel on every later route.
 *
 * COMMENT-BLIND, like the other contracts here: both files explain the fix in
 * prose that names the very strings being scanned for, and a literal scan that
 * trips over its own documentation is a guard someone deletes.
 *
 * Run: `node --test tests/error-boundary-contract.test.js`
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/** Block comments first (covers JSX `{/* … *\/}`), then `//` not preceded by `:`. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const LAYOUT = 'src/components/layout/Layout.tsx';
const APP = 'src/pages/_app.tsx';
const BOUNDARY = 'src/components/ErrorBoundary.tsx';

const layout = stripComments(read(LAYOUT));
const app = stripComments(read(APP));
const boundary = stripComments(read(BOUNDARY));

// ── 1. The inner boundary is inside the shell ────────────────────────────────

test('Layout wraps the routed page in a boundary that sits INSIDE AppShell', () => {
  // Position is the whole point. `<ErrorBoundary><AppShell>…` would compile,
  // pass a "Layout mounts a boundary" check, and still cover the nav with the
  // error — i.e. it would reproduce the exact bug while looking fixed.
  const open = layout.indexOf('<AppShell>');
  const close = layout.indexOf('</AppShell>');
  assert.ok(open !== -1 && close > open, `${LAYOUT} should still render <AppShell>`);

  const shellBody = layout.slice(open, close);
  assert.match(
    shellBody,
    /<ErrorBoundary\b/,
    `${LAYOUT} must mount the page boundary INSIDE <AppShell>, not around it. Outside it, `
      + 'a crash in one page hides the sidebar and the user has no way to leave the '
      + 'broken route.',
  );
  assert.match(
    shellBody,
    /\{children\}/,
    `${LAYOUT}'s boundary should wrap the routed page (\`{children}\`).`,
  );
});

test('the inner boundary renders the panel variant, not the full-screen one', () => {
  // A full-screen fallback rendered into the content column is the same failure
  // with extra steps: it swallows the page area and reads as "everything is
  // broken" next to a working nav.
  assert.match(
    layout,
    /<ErrorBoundary[^>]*variant="inline"/,
    `${LAYOUT}'s boundary must pass variant="inline" — the page-sized fallback in the `
      + 'content column claims the whole app died when only one route did.',
  );
});

test('the inner boundary is keyed on the route so navigation clears it', () => {
  // Without this, scoping makes things WORSE: the nav works, the user clicks
  // it, and the previous page's crash renders on the new route forever.
  assert.match(
    layout,
    /<ErrorBoundary[^>]*resetKey=\{router\.asPath\}/,
    `${LAYOUT}'s boundary must pass resetKey={router.asPath}. A boundary holds its error `
      + 'until told otherwise, so an unkeyed inner boundary leaves a dead panel behind on '
      + 'every subsequent page.',
  );
});

test('the ErrorBoundary honours resetKey rather than merely accepting it', () => {
  // The prop could be threaded through and ignored, and every assertion above
  // would still pass. This is the one line that makes it load-bearing.
  assert.match(
    boundary,
    /static getDerivedStateFromProps\b/,
    `${BOUNDARY} must implement getDerivedStateFromProps — it is what turns resetKey into `
      + 'an actual reset.',
  );
  assert.match(
    boundary,
    /props\.resetKey === state\.lastResetKey/,
    `${BOUNDARY} should clear its error only when resetKey CHANGES. Clearing on every `
      + 'render re-renders the crashing child immediately and loops.',
  );
});

// ── 2. The outer boundary survives ───────────────────────────────────────────

test('_app.tsx still mounts an app-root boundary above the providers', () => {
  // Scoping is an addition, not a replacement. ClerkProvider,
  // DashboardBootstrapProvider and Layout itself are all ABOVE the inner
  // boundary; a throw in any of them has nothing else to catch it.
  assert.match(
    app,
    /<ErrorBoundary>/,
    `${APP} must keep the outermost boundary. The inner one cannot catch a crash in the `
      + 'providers that render it.',
  );
  assert.ok(
    (app.match(/<ErrorBoundary>/g) || []).length >= 2,
    `${APP} has two return branches (Clerk and credentials auth); both need the boundary.`,
  );
});

test('the outer boundary is NOT given a resetKey', () => {
  // Deliberate. Everything that could navigate you out died with it, so there
  // is no route change that means "recovered" — resetting on one would hide a
  // dead app behind a working-looking URL bar.
  assert.ok(
    !/<ErrorBoundary[^>]*resetKey/.test(app),
    `${APP}'s app-root boundary must not take a resetKey: when the shell itself is gone, a `
      + 'route change is not evidence of recovery.',
  );
});

// ── 3. The fallback is legible in both themes ────────────────────────────────

test('the fallback routes every colour through the theme layer', () => {
  // This surface is the one guaranteed to be seen on a bad day, and it used to
  // hard-code #EF4444 / #0F3D2E / #4B5563 — dark-first values chosen against
  // the old dark-only palette, which render as dark-surface colours on white.
  // globals.css: "Add new colors as tokens here, never as raw hex in components."
  const hex = boundary.match(/#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3}(?:[0-9a-fA-F]{2})?)?\b/g) || [];
  assert.deepEqual(
    [...new Set(hex)],
    [],
    `${BOUNDARY} hard-codes a hex colour. A hex written in a component exists in one theme `
      + 'only, and this is the component people see when something has already gone wrong.',
  );
});

test('the fallback does not tell the user to do something that cannot work', () => {
  // The old "Try Again" cleared hasError and re-rendered the identical tree, so
  // on a deterministic crash it threw again before paint — a button that
  // reliably did nothing. The boundary now notices a retry that reproduced the
  // crash and stops offering it.
  assert.match(
    boundary,
    /retryFailed/,
    `${BOUNDARY} should track a retry that reproduced the crash, so it can stop offering a `
      + 'button that demonstrably cannot help.',
  );
  assert.match(
    boundary,
    /this\.retried\s*=\s*true/,
    `${BOUNDARY}'s reset handler must record that a retry was offered and taken.`,
  );
});
