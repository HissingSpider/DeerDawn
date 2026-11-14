/**
 * /onboarding before there is an account — the structural half of the contract.
 *
 * The behavioural half is `src/lib/onboardingPreview.test.ts`, which runs the
 * real values and proves none of them is account-scoped. This file covers what
 * that one structurally cannot: that the page is actually REACHABLE without a
 * session, and — the part that matters far more — that reaching it fires no
 * authenticated request.
 *
 * WHY THAT SECOND HALF IS THE WHOLE RISK. The gate on this route was not
 * arbitrary. It was added because signed-out users could once reach
 * /onboarding, /checkout and /select-plan, where the authed calls those pages
 * make 401'd and the reader was shown a confusing "session expired" error
 * instead of being sent to sign in. Opening the route again is only safe while
 * the signed-out branch returns BEFORE that call — so the ordering is pinned
 * here, not left to review.
 *
 * Run: `node --test tests/onboarding-preview-contract.test.js`
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// Source-text assertions have to be comment-blind, or a comment that merely
// DESCRIBES the rule satisfies the test meant to pin it.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const authProvider = read('src/components/layout/AuthProvider.tsx');
const onboarding = read('src/pages/onboarding.tsx');
const authProviderCode = stripComments(authProvider);
const onboardingCode = stripComments(onboarding);

/** The routes AuthProvider renders for a signed-out reader, read from source. */
function previewPages() {
  const match = authProviderCode.match(/const PREVIEW_PAGES\s*=\s*\[([^\]]*)\]/);
  assert.ok(match, 'AuthProvider no longer declares PREVIEW_PAGES — this suite is blind');
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

// ── Reachable ────────────────────────────────────────────────────────────────

test('/onboarding renders for a signed-out reader instead of bouncing to /login', () => {
  // The asymmetry this closes: the public /connect page hands the connector URL
  // to anyone, while the dashboard's own copy of the same instructions sat
  // behind a signup form that 25 of 55 accounts abandoned.
  assert.ok(
    previewPages().includes('/onboarding'),
    '/onboarding is gated again, so the setup instructions are behind the signup form',
  );
  assert.match(
    authProviderCode,
    /if \(isSignedIn \|\| rendersWithoutSession\)/,
    'the redirect no longer consults the preview list, so a preview page bounces anyway',
  );
});

test('the preview list is exact-match, and the pages that must stay gated are not in it', () => {
  // `publicPages` uses startsWith, which is right for /login and its siblings and
  // wrong here: a prefix match would open every future route beneath a preview
  // page along with it.
  assert.match(
    authProviderCode,
    /PREVIEW_PAGES\.includes\(router\.pathname\)/,
    'the preview list must match the pathname exactly, never by prefix',
  );
  for (const gated of ['/checkout', '/select-plan']) {
    assert.ok(
      !previewPages().includes(gated),
      `${gated} joined the preview list — it makes authed calls and has no signed-out branch`,
    );
  }
});

test('every preview page reads the presence it was opened on', () => {
  // The condition for being on that list. A page added to it without a
  // signed-out branch re-creates the exact defect the gate was added for: a
  // reader with no token, on a page that calls the API, shown "session expired".
  for (const route of previewPages()) {
    const page = path.join('src/pages', `${route.replace(/^\//, '')}.tsx`);
    assert.ok(fs.existsSync(path.join(root, page)), `${route} is on the preview list but ${page} does not exist`);
    assert.match(
      stripComments(read(page)),
      /useAuthPresence\(\)/,
      `${page} is rendered for signed-out readers but never asks whether there is a session — ` +
        'it will fire its authed calls at someone who has no token',
    );
  }
});

// ── ...and it makes no authenticated request ─────────────────────────────────

test('the signed-out branch returns before the phase machine and before any api call', () => {
  const branch = onboardingCode.indexOf('if (signedOut) {');
  const phaseMachine = onboardingCode.indexOf("if (phase === 'loading')");
  assert.ok(branch > -1, 'the signed-out branch is gone — a signed-out reader now falls into the authed flow');
  assert.ok(phaseMachine > -1, 'the phase machine moved; this ordering check is blind');
  assert.ok(
    branch < phaseMachine,
    'the signed-out branch must come first — `phase` never leaves "loading" without the authed ' +
      'call that advances it, so a later branch renders a blank screen forever',
  );
});

test('the mount effect that calls the API bails out when there is no session', () => {
  // `api.getOnboardingSurvey()` is the one authed call this page makes on mount,
  // and its own `.catch(start)` would walk a 401 straight into the authed flow.
  const effect = onboardingCode.slice(
    onboardingCode.indexOf('if (signedOut) return;'),
    onboardingCode.indexOf('api.getOnboardingSurvey()'),
  );
  assert.ok(
    effect.length > 0 && effect.startsWith('if (signedOut) return;'),
    'the survey lookup no longer bails on a signed-out reader, so the page 401s on mount',
  );
  assert.match(
    onboardingCode,
    /\}, \[signedOut\]\);/,
    'the guard must be a real dependency of the effect, not a value read from a stale closure',
  );
});

test('the preview component itself touches neither the API nor the auth token', () => {
  const start = onboardingCode.indexOf('function SignedOutSetupPreview()');
  assert.ok(start > -1, 'the preview component is gone');
  const body = onboardingCode.slice(start, onboardingCode.indexOf('export default function Onboarding()'));
  assert.ok(body.length > 0, 'could not isolate the preview component');
  for (const forbidden of ['api.', 'getToken', 'fetchAPI', 'trackProductEvent(']) {
    assert.ok(
      !body.includes(forbidden),
      `the signed-out preview calls ${forbidden} — it must issue nothing that needs a session ` +
        '(trackProductEvent included: it posts through the API client and its mcp_config_copied ' +
        'maps to a Google Ads connect conversion that must not fire before signup)',
    );
  }
});

// ── The values it shows ──────────────────────────────────────────────────────

test('the preview renders the shared copy module, never its own strings', () => {
  const start = onboardingCode.indexOf('function SignedOutSetupPreview()');
  const body = onboardingCode.slice(start, onboardingCode.indexOf('export default function Onboarding()'));
  assert.match(
    onboardingCode,
    /from '@\/lib\/onboardingPreview'/,
    'the preview must take its values from the shared module, where they are pinned to connectCopy',
  );
  assert.ok(
    !/https?:\/\/[^\s'"`]*deerdawn/i.test(body),
    'a DeerDawn URL is written into the preview markup — it must come from connectCopy, or the ' +
      'page a stranger copies from and the page they finish on will eventually disagree',
  );
  assert.ok(
    !body.includes('npx '),
    'the setup command is written into the preview markup rather than imported',
  );
});

test('the preview is separable in the funnel and does not re-baseline the signed-in events', () => {
  const start = onboardingCode.indexOf('function SignedOutSetupPreview()');
  const body = onboardingCode.slice(start, onboardingCode.indexOf('export default function Onboarding()'));
  assert.match(
    body,
    /surface: 'dashboard_onboarding_signed_out'/,
    'anonymous setup views and copies must carry their own surface, or they average into the ' +
      'signed-in step they are meant to be compared against',
  );
  assert.ok(
    !body.includes("'mcp_config_copied'") && !body.includes("'mcp_setup_viewed'"),
    'the signed-out surface must not emit the signed-in step\'s event names',
  );
});

test('the preview adds no gradient, no emoji and no raw colour', () => {
  const start = onboarding.indexOf('function SignedOutSetupPreview()');
  const body = onboarding.slice(start, onboarding.indexOf('export default function Onboarding()'));
  const preview = read('src/lib/onboardingPreview.ts');
  for (const [name, source] of [['SignedOutSetupPreview', body], ['src/lib/onboardingPreview.ts', preview]]) {
    assert.equal((source.match(/gradient/gi) || []).length, 0, `${name} uses a gradient`);
    assert.equal(
      (source.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length,
      0,
      `${name} hard-codes a hex colour — colours come from the token layer in globals.css`,
    );
    assert.equal(
      (source.match(/\b(?:bg|text|border|ring)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g) || []).length,
      0,
      `${name} uses a raw Tailwind palette class`,
    );
    assert.equal(
      (source.match(/\p{Extended_Pictographic}/gu) || []).length,
      0,
      `${name} contains an emoji`,
    );
  }
});
