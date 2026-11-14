/**
 * The dashboard's /admin pages must be reachable on the dashboard.
 *
 * That sounds too obvious to test. It was false in production for months.
 *
 * `next.config.ts` carried a production redirect sending `/admin/:path*` to the
 * governance app. It was correct when it was written — /admin WAS the
 * governance console. Then governance was extracted into its own repo
 * (`deerdawn-governance`; this repo's CLAUDE.md now says it is "exclusively
 * session memory"), and this repo's /admin pages became operator surfaces for
 * session memory: the content CMS, retention, and now today. The redirect was
 * never removed.
 *
 * THE MECHANISM IS SHARPER THAN "forwarded to the wrong app", and the sharper
 * version is why it could never have worked. `app.governance.deerdawn.com` is
 * not a separate deployment at all — it is an ALIAS on this same Vercel
 * deployment, sitting in the same `alias` array as `app.deerdawn.com`. The
 * redirect therefore returned the request to the IDENTICAL Next.js app under a
 * different hostname, where this identical rule matched again:
 *
 *   app.deerdawn.com/admin/today
 *     -> 307 app.governance.deerdawn.com/admin/today
 *     -> 307 the same URL, forever
 *
 * curl gave up after 10 hops. Self-referential, so unterminating by
 * construction: not a rule pointing somewhere stale, a rule pointing at itself.
 *
 * And it failed silently, which is why it lasted. A redirect throws nothing and
 * 404s nothing, so `/admin/retention` was shipped, linked and dead for months
 * with every check green. The tell, once you look for it, is that a
 * NONEXISTENT admin path 307'd too — which is why this suite's sibling check in
 * production is that /admin/definitely-not-a-page now returns 404.
 *
 * This is the same class as the `_app.tsx` route-gate omissions already
 * recorded here: a page ships, its tests pass, its build succeeds, and a
 * routing rule one layer above quietly makes it unreachable. Source contracts
 * catch it; nothing else in the pipeline looks at both halves.
 *
 * Run: `node --test tests/admin-routes-contract.test.js`
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const CONFIG = 'next.config.ts';
const config = fs.readFileSync(path.join(root, CONFIG), 'utf8');

/** Block comments first, then `//` not preceded by `:` (so URLs survive). */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * ONLY the `redirects()` body. Scanning the whole file also picks up
 * `headers()`, whose catch-all `source: "/:path*"` applies security headers to
 * every route — it redirects nothing, but it matches every path, so an
 * unscoped shadow check reports every admin page as unreachable. Slicing from
 * `async redirects()` to end-of-file is enough here because it is the last
 * member of the config object.
 */
const rules = (() => {
  const stripped = stripComments(config);
  const start = stripped.indexOf('async redirects()');
  if (start === -1) throw new Error(`${CONFIG} has no redirects() to check`);
  return stripped.slice(start);
})();

test('no redirect forwards /admin off the dashboard', () => {
  // Comment-blind: the note explaining WHY the rule is gone names the very
  // pattern being scanned for. A literal scan would trip over its own
  // documentation, which is how a guard gets deleted instead of fixed.
  const offenders = [...rules.matchAll(/source:\s*["'`](\/admin[^"'`]*)["'`]/g)].map((m) => m[1]);
  assert.deepEqual(
    offenders,
    [],
    `${CONFIG} redirects ${offenders.join(', ')} away from the dashboard. Every /admin page in `
      + 'this repo is a session-memory operator surface; forwarding them to the governance app '
      + 'sent them into a redirect loop and made all of them unreachable in production.',
  );
});

test('no redirect destination points an admin path at the governance app', () => {
  // The inverse spelling: a rule could match on something else and still land
  // on `${governanceAppUrl}/admin/...`.
  assert.ok(
    !/destination:\s*[^\n]*governanceAppUrl[^\n]*\/admin/.test(rules),
    `${CONFIG} sends a path to the governance app's /admin. That host does not serve this `
      + "repo's operator pages — it 307s the request back to itself.",
  );
});

test('the governance surfaces that SHOULD cross over still do', () => {
  // The fix is a deletion, and the risk of a deletion is taking too much. The
  // genuinely governance-only routes must be untouched.
  for (const route of ['/governance/:path*', '/settings/governance/:path*']) {
    assert.ok(
      rules.includes(`source: "${route}"`),
      `${CONFIG} should still forward ${route} to the governance app — that surface really did `
        + 'move out of this repo.',
    );
  }
  assert.match(
    rules,
    /source:\s*"\/:path\(policies\|decisions\|escalations\|playground\|usage\|audit\)"/,
    `${CONFIG} should still forward the governance console routes.`,
  );
});

test('every admin page that exists is reachable by its own route', () => {
  // Ties the guard to reality: if someone adds /admin/whatever, this asserts
  // nothing in the redirect table shadows it. Reads the directory rather than a
  // hard-coded list, so a new page is covered the day it lands.
  const dir = path.join(root, 'src/pages/admin');
  const pages = fs
    .readdirSync(dir)
    .filter((f) => /\.tsx$/.test(f))
    .map((f) => `/admin/${f.replace(/\.tsx$/, '')}`);

  assert.ok(pages.length > 0, 'expected at least one admin page');

  const sources = [...rules.matchAll(/source:\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
  for (const page of pages) {
    for (const source of sources) {
      // Turn a Next route pattern into something testable: `:path*` and
      // `:path` swallow segments, everything else must match literally.
      const pattern = new RegExp(
        '^'
          + source
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/:[A-Za-z]+\*/g, '.*')
            .replace(/:[A-Za-z]+(\([^)]*\))?/g, '[^/]+')
          + '$',
      );
      assert.ok(
        !pattern.test(page),
        `${page} is shadowed by the redirect "${source}" in ${CONFIG}, so the page ships but `
          + 'cannot be opened.',
      );
    }
  }
});
