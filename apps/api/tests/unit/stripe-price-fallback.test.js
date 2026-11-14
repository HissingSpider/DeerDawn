const test = require('node:test');
const assert = require('node:assert');

// B-4 made annual the default cadence on every checkout surface. That turned an
// unset annual price id from a partial outage (only people who explicitly chose
// annual) into a total one (every checkout throws "Missing Stripe base price"
// and the page shows "We couldn't start checkout"). Since the product has never
// taken a payment, that failure mode would be indistinguishable from the status
// quo and could go unnoticed for weeks.
//
// getBasePriceId is a pure function of the plan object, so these need no Stripe
// key and no database — the module reads STRIPE_SECRET_KEY at load but tolerates
// its absence.

const { __testables } = require('../../src/services/stripeService');

const getBasePriceId = __testables?.getBasePriceId;

test('an annual request uses the annual price when one is configured', () => {
  assert.equal(typeof getBasePriceId, 'function', 'getBasePriceId must be exported for test');
  const plan = { id: 'developer_basic', stripe_prices: { annual: 'price_year', monthly: 'price_month' } };
  assert.equal(getBasePriceId(plan, 'annual'), 'price_year');
  assert.equal(getBasePriceId(plan, 'monthly'), 'price_month');
});

test('a missing annual price degrades to monthly instead of taking checkout to zero', () => {
  const plan = { id: 'developer_basic', stripe_prices: { annual: null, monthly: 'price_month' } };
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    assert.equal(
      getBasePriceId(plan, 'annual'),
      'price_month',
      'a monthly sale beats no sale — Stripe shows the real cadence before the customer pays'
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.length, 1, 'the downgrade is a configuration bug and must be loud');
  assert.match(errors[0], /STRIPE_PRICE_DEVELOPER_BASIC_ANNUAL/, 'names the variable to set');
});

test('the misconfiguration names the TEAM annual variable for Team', () => {
  const plan = { id: 'developer_pro', stripe_prices: { annual: null, monthly: 'price_month' } };
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    getBasePriceId(plan, 'annual');
  } finally {
    console.error = originalError;
  }
  assert.match(errors[0], /STRIPE_PRICE_DEVELOPER_PRO_ANNUAL/, 'a Team misconfiguration must not tell the operator to set the Individual price');
});

test('with neither price configured it still reports missing, so the catalog check fires', () => {
  const plan = { id: 'developer_basic', stripe_prices: { annual: null, monthly: null } };
  const originalError = console.error;
  console.error = () => {};
  try {
    // No fallback exists, so this must stay null and let validateCheckoutCatalog
    // throw — silently returning a wrong price would be worse than failing.
    assert.equal(getBasePriceId(plan, 'annual'), null);
  } finally {
    console.error = originalError;
  }
});

test('the monthly path is untouched by the fallback', () => {
  const plan = { id: 'developer_basic', stripe_prices: { annual: 'price_year', monthly: null }, stripe_price_id: 'price_legacy' };
  assert.equal(getBasePriceId(plan, 'monthly'), 'price_legacy', 'legacy single-price plans still resolve');
});
