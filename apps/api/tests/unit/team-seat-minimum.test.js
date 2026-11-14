'use strict';

// Team sells a minimum of two seats, and Team is buyable.
//
// Both of these are new on 2026-09-02 and both are the kind of thing that goes
// wrong quietly: a seat floor that exists in the copy and not in the checkout
// sells a one-seat Team at $15 against Pro's $12 — a strictly worse Pro — and a
// plan listed as self-serve without its Stripe price ids gives every buyer
// "Missing Stripe base price" instead of a cart.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { privateSkipReason } = require('../helpers/privatePaths');

const tests = [];
// `requires`: repo paths only the private repo has (the public export does
// not ship them); the test is reported as skipped where they are missing.
const test = (name, fn, { requires = [] } = {}) => tests.push([name, fn, privateSkipReason(...requires)]);

const { PLANS, SELF_SERVE_PLAN_IDS } = require('../../src/config/plans');

test('Team is self-serve', () => {
  assert.ok(
    SELF_SERVE_PLAN_IDS.includes('developer_pro'),
    'developer_pro must be purchasable now that its per-seat prices exist'
  );
});

test('Team carries a two-seat floor as plan data', () => {
  assert.strictEqual(PLANS.developer_pro.limits.minimum_seats, 2);
});

test('the floor is read from the plan, not written into the checkout', () => {
  // A literal in stripeService drifts the first time a second per-seat plan
  // wants a different floor, and the copy and the charge stop agreeing.
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'src', 'services', 'stripeService.js'),
    'utf8'
  );
  assert.ok(/minimum_seats/.test(src), 'the checkout must read minimum_seats from the plan');
  assert.ok(
    /adjustable_quantity:\s*\{\s*enabled:\s*true,\s*minimum:\s*minSeats/.test(src),
    'Stripe\'s own quantity stepper must use the same floor, or a buyer can edit below it on Stripe\'s page'
  );
  assert.ok(
    !/adjustable_quantity:\s*\{\s*enabled:\s*true,\s*minimum:\s*1\b/.test(src),
    'the hard-coded minimum of 1 must be gone'
  );
});

test('a Team price below the floor is raised, not accepted', () => {
  // Mirrors the clamp in createCheckoutSession without needing Stripe: the
  // arithmetic is what decides whether someone gets billed for one seat.
  const plan = PLANS.developer_pro;
  const isPerSeat = plan.limits?.included_seats !== 1 && plan.account_type === 'organization';
  assert.ok(isPerSeat, 'Team must qualify as per-seat, or quantity is ignored entirely');

  const minSeats = Math.max(1, Number(plan.limits?.minimum_seats) || 1);
  const clamp = (seats) => Math.max(minSeats, Math.min(500, Math.floor(Number(seats) || minSeats)));

  assert.strictEqual(clamp(1), 2, 'one seat must be raised to the floor');
  assert.strictEqual(clamp(0), 2);
  assert.strictEqual(clamp(undefined), 2);
  assert.strictEqual(clamp('nonsense'), 2);
  assert.strictEqual(clamp(-5), 2, 'a negative must not become a credit');
  assert.strictEqual(clamp(3), 3, 'a real count above the floor is respected');
  assert.strictEqual(clamp(9999), 500, 'and still bounded at the top');
});

test('Pro is not per-seat, so the floor cannot leak onto it', () => {
  const pro = PLANS.developer_basic;
  const isPerSeat = pro.limits?.included_seats !== 1 && pro.account_type === 'organization';
  assert.ok(!isPerSeat, 'a per-seat Pro would multiply one person by a quantity');
});

test('the displayed Team price matches what plans.js charges', () => {
  const brand = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'marketing', 'src', 'lib', 'brand.ts'),
    'utf8'
  );
  // The two Team prices moved into a TEAM_PRICES constant so PRICING's
  // per-month figure could be DERIVED from the annual price rather than
  // repeating 150. Both numbers in PRICING were always correct; the yearly card
  // still printed "$13/seat/mo" for a $12.50 plan, because the falsehood was
  // manufactured downstream by a Math.round. This reads the constant — still
  // exactly one place where each number is written down.
  const teamPrices = /const TEAM_PRICES = \{([^}]*)\}/.exec(brand);
  assert.ok(teamPrices, 'brand.ts must declare TEAM_PRICES — re-point this test if it moved');
  const monthly = /monthly:\s*(\d+)/.exec(teamPrices[1]);
  const annual = /annual:\s*(\d+)/.exec(teamPrices[1]);
  const minSeats = brand.match(/teamMinSeats:\s*(\d+)/);
  assert.ok(monthly && annual && minSeats, 'brand.ts must state all three');
  // And PRICING must actually use them, or the constant is decoration.
  assert.match(brand, /team:\s*TEAM_PRICES\.monthly/);
  assert.match(brand, /teamAnnual:\s*TEAM_PRICES\.annual/);
  assert.match(brand, /teamAnnualPerMonth:\s*TEAM_PRICES\.annual\s*\/\s*12/,
    'the per-month figure must be derived from the annual price, never typed or rounded');
  assert.strictEqual(Number(monthly[1]), PLANS.developer_pro.price);
  assert.strictEqual(Number(annual[1]), PLANS.developer_pro.annual_price);
  assert.strictEqual(Number(minSeats[1]), PLANS.developer_pro.limits.minimum_seats);
}, { requires: ['apps/marketing'] });

(async () => {
  console.log('=== Team seat minimum and self-serve ===\n');
  for (const [name, fn, skip] of tests) {
    if (skip) {
      console.log(`- ${name} (skipped: ${skip})`);
      continue;
    }
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (error) {
      console.error(`✗ ${name}`);
      console.error(`  ${error.stack || error.message}`);
      process.exitCode = 1;
    }
  }
})();
