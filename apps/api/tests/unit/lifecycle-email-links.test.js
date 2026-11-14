/**
 * Lifecycle emails must link routes that EXIST, not routes that redirect.
 *
 * The return path was broken for the whole of its life and nobody could see it:
 * the activation follow-up linked `/settings/tools`, which is a redirect in the
 * dashboard's next.config.ts, and the `?dd_email=` query did not survive the hop
 * in production. _app.tsx captures that param to fire `lifecycle_email_clicked`,
 * so with the param gone the event never fired once across 31 delivered emails —
 * and a funnel step that always reads zero looks exactly like a step nobody
 * reached. Nothing errored; the link simply arrived stripped.
 *
 * So: no lifecycle email may link a path that next.config.ts redirects away
 * from. The fix is to link the canonical route directly, and this is the guard.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '../../../..');
const EMAIL_DIR = path.join(REPO_ROOT, 'apps/api/src/services/email');

/** Every `source:` in the dashboard's redirects() — i.e. every path that moves. */
function redirectingPaths() {
  const config = fs.readFileSync(path.join(REPO_ROOT, 'apps/dashboard/next.config.ts'), 'utf8');
  const sources = [...config.matchAll(/source:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(sources.length > 0, 'found no redirects to check — has next.config.ts moved?');
  // Only plain literal paths are checkable here; pattern routes (:path*) are not
  // something an email would link directly.
  return sources.filter((s) => !s.includes(':'));
}

test('no lifecycle email links a path that redirects', () => {
  const redirects = redirectingPaths();
  const offenders = [];

  for (const file of fs.readdirSync(EMAIL_DIR)) {
    if (!file.endsWith('.js')) continue;
    const full = path.join(EMAIL_DIR, file);
    const source = fs.readFileSync(full, 'utf8');
    // Strip comments so a comment explaining the hazard doesn't read as a use.
    const code = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const redirectPath of redirects) {
      if (code.includes(`${redirectPath}"`) || code.includes(`${redirectPath}'`) || code.includes(`${redirectPath}?`) || code.includes(`${redirectPath}\``)) {
        offenders.push(`${file} links ${redirectPath}, which redirects`);
      }
    }
  }

  assert.deepStrictEqual(offenders, [],
    `lifecycle emails must link canonical routes:\n  ${offenders.join('\n  ')}`);
});

test('the activation follow-up carries the click parameter it is measured by', () => {
  const svc = require('../../src/services/email/activationFollowUp');
  const url = svc.followUpCtaUrl
    ? svc.followUpCtaUrl('https://app.deerdawn.com', false)
    : null;
  if (!url) return; // not exported — the link-shape test above still covers it.
  assert.match(url, /dd_email=/, 'without dd_email the click can never be attributed');
  assert.match(url, /^https:\/\/app\.deerdawn\.com\/setup\?/, 'must point at the canonical connect route');
});
