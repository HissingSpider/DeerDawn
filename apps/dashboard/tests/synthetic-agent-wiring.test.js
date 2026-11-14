/**
 * The two automation gates the validity gate now depends on (E-019, 2026-09-02).
 *
 * WHY THIS EXISTS, and it is not "more coverage for its own sake".
 *
 * `EXPERIMENT-PROTOCOL.md` §6.2 used to identify the nightly journey E2E by the
 * hour it ran ("~03:00 UTC"). That stopped being true on 2026-08-27: GitHub's
 * scheduler now starts the same unchanged `cron: '0 3 * * *'` anywhere between
 * 07:43 and 15:56 UTC. §6.2 was rewritten to classify by identity instead, and
 * one of the three things it now tells every future analysis to rely on is an
 * ABSENCE:
 *
 *   "Client-side dashboard and marketing events do not exist for a driven
 *    browser at all — both surfaces suppress PostHog init behind
 *    isSyntheticAgent(). So an anonymous client-side row is evidence AGAINST
 *    automation, not for it."
 *
 * An absence is the one observation that looks exactly the same when the thing
 * producing it has been deleted. And this repo has already shipped that exact
 * defect once: E-014 found that the dashboard had never had marketing's gate at
 * all, so every nightly run had been a dashboard "visitor" with a session replay
 * on the precise surfaces the activation push is measured on. `syntheticAgent.ts`
 * has a unit test for the PREDICATE; nothing has ever pinned the WIRING.
 *
 * So these three assertions are the price of §6.2's new instruction. If either
 * gate is removed, the gate stops being true and the analyses that trust it read
 * bot traffic as European working-hours humans — an error that manufactures real
 * users rather than discarding them.
 *
 * COMMENT-BLIND, matching `design-system-contract.test.js`: the paragraphs above
 * mention `isSyntheticAgent` and `is_automation` repeatedly, and a source-text
 * assertion that a comment can satisfy is not an assertion.
 *
 * Run: `node --test tests/synthetic-agent-wiring.test.js` (wired into
 * `npm test -w dashboard` by the `tests/*.test.js` glob).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

/** Strip comments so assertions see CODE only. Block comments first, then `//`. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const read = (rel) => stripComments(fs.readFileSync(path.join(root, rel), 'utf8'));

test('the PostHog SDK is not initialised for a driven browser', () => {
  const src = read('src/lib/posthog.ts');

  assert.match(
    src,
    /import\s*\{[^}]*\bisSyntheticAgent\b[^}]*\}\s*from\s*'@\/lib\/syntheticAgent'/,
    'lib/posthog.ts must import isSyntheticAgent — §6.2 reads the absence of client-side events as evidence against automation',
  );

  const init = src.slice(src.indexOf('export async function initPostHog'));
  assert.ok(init.length > 0, 'initPostHog() not found in lib/posthog.ts');

  const gate = init.indexOf('isSyntheticAgent()');
  const sdkLoad = init.indexOf('import(');
  assert.ok(gate !== -1, 'initPostHog() must consult isSyntheticAgent()');
  assert.ok(sdkLoad !== -1, 'initPostHog() no longer imports posthog-js — re-point this test');
  assert.ok(
    gate < sdkLoad,
    'the isSyntheticAgent() gate must run BEFORE posthog-js is loaded, or a driven browser still enters the funnel',
  );
});

test('relayed product events carry is_automation from a driven browser', () => {
  const src = read('src/lib/productAnalytics.ts');

  assert.match(
    src,
    /import\s*\{[^}]*\bisSyntheticAgent\b[^}]*\}\s*from\s*'@\/lib\/syntheticAgent'/,
    'lib/productAnalytics.ts must import isSyntheticAgent',
  );
  assert.match(
    src,
    /isSyntheticAgent\(\)\s*\?\s*\{\s*is_automation:\s*true\s*\}/,
    'the relay must stamp is_automation:true — the SDK gate cannot help here, this path never touches the SDK',
  );
  // Spread conditionally, never a literal false: `is_automation: false` on every
  // event from every real user is 30 days of storage to say nothing, and it also
  // makes `is_automation IS NULL` stop meaning "server-originated".
  assert.doesNotMatch(
    src,
    /is_automation:\s*false/,
    'is_automation must be absent rather than false on real users',
  );
});

test('the predicate itself keys on navigator.webdriver, not the user agent', () => {
  // UA sniffing cannot see our own bot: Playwright's devices['Desktop Chrome']
  // sends an ordinary Windows Chrome string. If someone ever reduces this to a
  // UA pattern, both gates above go on passing while catching nothing.
  const src = read('src/lib/syntheticAgent.ts');
  assert.match(
    src,
    /navigator\.webdriver\s*===\s*true/,
    'isSyntheticAgent() must key on navigator.webdriver — a UA pattern alone cannot see our own Playwright run',
  );
});
