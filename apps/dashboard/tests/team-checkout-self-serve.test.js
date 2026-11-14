'use strict';

/**
 * Team has to be buyable from the client, not just from the API.
 *
 * The API listed `developer_pro` in SELF_SERVE_PLAN_IDS on 2026-09-02, gave it
 * per-seat Stripe prices, a two-seat floor and a 14-day trial — and the
 * dashboard kept its OWN copy of the self-serve set, `new Set(['developer_basic'])`,
 * in two files. Marketing's "Try Team free for 14 days" hands the buyer to
 * /checkout?plan=developer_pro, /checkout read its private set, decided Team was
 * sales-assisted, and rendered "Contact DeerDawn sales to activate it" without
 * ever calling the API. The plan the pricing page sells as a cart was
 * unreachable from inside the product.
 *
 * The rule this pins is not "Team is in the set" — that is one plan, and the
 * next one repeats the bug. It is that no surface may keep a private copy of
 * the set at all: there is one mirror (lib/planCopy), and planCopy.test.ts pins
 * that mirror to plans.js.
 */

const test = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const APP_ROOT = join(__dirname, '..');
const REPO_ROOT = join(APP_ROOT, '..', '..');

/** Comment-blind, for the same reason planCopy.test.ts is: these files explain
 *  the drift they are avoiding by quoting the shape that caused it. */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

const CHECKOUT_SURFACES = [
  'src/pages/checkout.tsx',
  'src/pages/settings/plan.tsx',
  'src/pages/settings/upgrade.tsx',
];

function surface(rel) {
  return codeOnly(readFileSync(join(APP_ROOT, rel), 'utf8'));
}

test('no checkout surface keeps its own copy of the self-serve plan set', () => {
  const offenders = [];
  for (const rel of CHECKOUT_SURFACES) {
    const code = surface(rel);
    // `const SELF_SERVE_PLANS = new Set(['developer_basic'])` — a second source
    // of truth for which plans have a cart.
    if (/new Set\(\s*\[[^\]]*developer_/.test(code)) {
      offenders.push(`${rel}: builds a plan-id Set inline instead of importing it`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    'the self-serve set lives in lib/planCopy, which planCopy.test.ts pins to plans.js:\n  '
    + offenders.join('\n  '));
});

test('the dashboard mirror of SELF_SERVE_PLAN_IDS matches the API', () => {
  const planCopy = readFileSync(join(APP_ROOT, 'src/lib/planCopy.ts'), 'utf8');
  const plans = readFileSync(join(REPO_ROOT, 'apps/api/src/config/plans.js'), 'utf8');

  const mirrored = /SELF_SERVE_PLAN_IDS\s*(?::[^=]+)?=\s*\[([^\]]*)\]/.exec(planCopy);
  assert.ok(mirrored, 'lib/planCopy must export SELF_SERVE_PLAN_IDS');
  const served = /const SELF_SERVE_PLAN_IDS\s*=\s*\[([^\]]*)\]/.exec(plans);
  assert.ok(served, 'plans.js no longer declares SELF_SERVE_PLAN_IDS — re-point this test');

  const ids = (block) => (block.match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1)).sort();
  assert.deepStrictEqual(ids(mirrored[1]), ids(served[1]),
    'the dashboard would offer a cart for a different set of plans than the API accepts');
});

test('/checkout can name and price Team, not just Pro', () => {
  const code = surface('src/pages/checkout.tsx');
  assert.ok(/TEAM_PLAN_NAME/.test(code),
    '/checkout must be able to title a Team checkout — it titled the page "developer_pro" otherwise');
  assert.ok(/TEAM_MIN_SEATS|MIN_SEATS_BY_PLAN/.test(code),
    'a per-seat checkout must open at the plan floor; one seat of Team costs more than Pro and does less');
  assert.ok(/TEAM_TRIAL_DAYS/.test(code),
    'the page the buyer lands on must state the trial the checkout actually grants');
});

test('a missing Stripe price fails loudly rather than as a generic retry', () => {
  // validateCheckoutCatalog throws "Missing Stripe base price for X (monthly)"
  // when STRIPE_PRICE_DEVELOPER_PRO is unset. billing.js only mapped the
  // lowercase phrase "missing price ID", which that message does not contain,
  // so an unconfigured plan 500'd as internal_error and the buyer was told to
  // "retry once" forever.
  const billing = readFileSync(join(REPO_ROOT, 'apps/api/src/routes/shared/billing.js'), 'utf8');
  assert.ok(/Missing Stripe base price/.test(billing),
    'sendBillingError must recognise the catalog error stripeService actually throws');

  // The 503 branch moved into the classifier /checkout and /select-plan share
  // (lib/checkoutPlanChange checkoutFailure), so both pages keep it.
  const checkout = surface('src/pages/checkout.tsx');
  const classifier = surface('src/lib/checkoutPlanChange.ts');
  assert.ok(/checkoutFailure\(/.test(checkout), '/checkout must classify failures with the shared helper');
  assert.ok(/status === 503/.test(classifier),
    '/checkout must show the server\'s own 503 message, not swallow a configuration error');
});

/**
 * /billing IS EXEMPT, SO THERE IS NO workspace_inactive TO HANDLE.
 *
 * enforcePlan's EXEMPT_PREFIXES includes '/api/v1/billing' on purpose: locking a
 * delinquent customer out of billing would trap them behind the page that lets
 * them pay. An exempt request is never rebound by the workspace fallback and
 * therefore never refused with 409 workspace_inactive, so /checkout's branch for
 * that refusal could not run. Dead code that reads as a handled case is how a
 * real gap goes unnoticed, and this one also claimed an exit ("use my own
 * workspace") for a purchase the reader had come here to make for the team.
 */
test('checkout does not pretend to handle a refusal /api/v1/billing cannot return', () => {
  const code = codeOnly(surface('src/pages/checkout.tsx'));
  assert.ok(
    !/workspaceInactiveMessage/.test(code),
    'checkout must not branch on a 409 the billing routes never send',
  );
});

/**
 * `updated: false` IS AN ANSWER, AND IT IS NOT "UPDATED".
 *
 * billing.js returns it for "This workspace already has N seats. Nothing was
 * changed or charged." The page rendered that sentence under the heading "Plan
 * updated", so the screen contradicted itself and a reader who trusted the
 * heading would go looking for a charge that never happened.
 */
test('a no-op answer is not rendered as a plan change', () => {
  const code = codeOnly(surface('src/pages/checkout.tsx'));
  assert.ok(/result\.updated !== false/.test(code), 'the server says whether anything moved');
  assert.ok(
    /changeApplied \? 'Plan updated' :/.test(code),
    'the heading follows the server, not the fact that a request completed',
  );
});
