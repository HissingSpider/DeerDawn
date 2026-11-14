/**
 * A superseded Stripe price must keep resolving to its plan.
 *
 * Stripe prices are IMMUTABLE. Raising a price always means creating a new one
 * and leaving existing subscriptions on the old — so "two live prices for one
 * plan" is the normal case, not an edge case.
 *
 * webhooks-stripe.js builds its priceId -> plan map from the env vars in
 * plans.js (getAllPricePlanMappings) and falls back to 'free' for any price it
 * cannot map. That fallback is deliberate and correct on its own terms: an
 * unknown price should not grant paid features. But it has a dangerous
 * corollary — repoint STRIPE_PRICE_DEVELOPER_BASIC at a new price and the OLD
 * one drops out of the map, so the next webhook for anyone still on it resolves
 * to 'free'. They keep paying and silently lose Pro. Nothing errors.
 *
 * Concretely: on 2026-08-28 Pro went $10 -> $12 with one subscriber still on the
 * $10 price. This asserts both prices resolve to developer_basic.
 */
const test = require('node:test');
const assert = require('node:assert');

const NEW_PRICE = 'price_new_12_test';
const OLD_PRICE = 'price_old_10_test';

function freshPlans(env) {
  const before = { ...process.env };
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../../src/config/plans')];
  const plans = require('../../src/config/plans');
  const mappings = plans.getAllPricePlanMappings();
  process.env = before;
  delete require.cache[require.resolve('../../src/config/plans')];
  return mappings;
}

test('the current AND the superseded price both resolve to Pro', () => {
  const map = freshPlans({
    STRIPE_PRICE_DEVELOPER_BASIC: NEW_PRICE,
    STRIPE_PRICE_DEVELOPER_BASIC_LEGACY: OLD_PRICE,
  });
  assert.strictEqual(map[NEW_PRICE], 'developer_basic', 'the current price must map');
  assert.strictEqual(map[OLD_PRICE], 'developer_basic',
    'the SUPERSEDED price must still map — otherwise webhooks-stripe.js falls back ' +
    'to free and silently downgrades a subscriber who is still paying');
});

test('dropping the legacy var is what breaks an existing subscriber', () => {
  // Demonstrates the failure this guard exists to prevent, so the reason the
  // env var is required is legible rather than folklore.
  const map = freshPlans({ STRIPE_PRICE_DEVELOPER_BASIC: NEW_PRICE });
  assert.strictEqual(map[OLD_PRICE], undefined,
    'unmapped — webhooks-stripe.js would resolve this subscription to free');
});

test('the plan declares a slot for superseded prices at all', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../../src/config/plans.js'), 'utf8');
  const block = src.slice(src.indexOf('  developer_basic: {'), src.indexOf('\n  },\n', src.indexOf('  developer_basic: {')));
  assert.match(block, /legacy_price_ids:[\s\S]*STRIPE_PRICE_DEVELOPER_BASIC_LEGACY/,
    'developer_basic must keep a legacy price slot; removing it strands anyone on an older price');
});
