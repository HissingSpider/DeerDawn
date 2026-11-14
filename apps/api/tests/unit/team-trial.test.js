'use strict';

// Team starts with a 14-day free trial, card up front.
//
// Team is the one plan a buyer cannot evaluate before paying: team_management
// is false on free AND on Pro, so every feature Team sells is invisible until
// after checkout. The trial is what makes "2 seats minimum" an invitation
// instead of a $30/mo ask, sight-unseen.
//
// Like the seat floor, the number is plan DATA — the checkout applies it, the
// public catalog serves it, the pricing copy advertises it, and these tests
// hold all of those to the same field.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { privateSkipReason } = require('../helpers/privatePaths');

const tests = [];
// `requires`: repo paths only the private repo has (the public export does
// not ship them); the test is reported as skipped where they are missing.
const test = (name, fn, { requires = [] } = {}) => tests.push([name, fn, privateSkipReason(...requires)]);

const { PLANS, serializePublicPlan } = require('../../src/config/plans');

test('Team carries a 14-day trial as plan data', () => {
  assert.strictEqual(PLANS.developer_pro.trial_days, 14);
});

test('the trial exists BECAUSE nothing cheaper shows team features', () => {
  // If a free or Pro tier ever grows team_management, the trial's reason
  // evaporates and someone should decide on purpose whether it stays.
  assert.strictEqual(PLANS.free.features.team_management, false);
  assert.strictEqual(PLANS.developer_basic.features.team_management, false);
  assert.strictEqual(PLANS.developer_pro.features.team_management, true);
});

test('plans that no free trial was decided for do not have one', () => {
  // A trial_days appearing on another plan should be a decision, not a
  // copy-paste. Pro needs none: free already shows a per-project version of
  // everything Pro extends.
  for (const [id, plan] of Object.entries(PLANS)) {
    if (id === 'developer_pro') continue;
    assert.ok(!plan.trial_days, `unexpected trial_days on ${id}`);
  }
});

test('the public catalog serves the trial, so surfaces can render it without retyping it', () => {
  assert.strictEqual(serializePublicPlan('developer_pro').trial_days, 14);
  assert.strictEqual(serializePublicPlan('developer_basic').trial_days, 0);
});

test('the checkout reads the trial from the plan and keeps the card mandatory', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'src', 'services', 'stripeService.js'),
    'utf8'
  );
  // The invariants, not the spelling: the trial Stripe applies must come from
  // plan.trial_days, and a trial checkout must still collect the card — the
  // convert-by-default design hangs on that word.
  assert.ok(/plan\.trial_days/.test(src), 'trial length must be read from the plan');
  assert.ok(/trial_period_days/.test(src), 'the trial must reach Stripe as trial_period_days');
  assert.ok(
    /payment_method_collection:\s*'always'/.test(src),
    'a trial without a card is a lead form, not a subscription — collection must be always'
  );
});

test('a trialing subscription is not blocked by enforcement', () => {
  // Stripe reports 14 free days as status 'trialing'. If that status ever
  // joins enforcement's block list, every trial is locked out of the product
  // they are meant to be evaluating.
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'src', 'services', 'enforcementService.js'),
    'utf8'
  );
  const blockList = src.match(/\[([^\]]*)\]\s*\.includes\(org\.subscription_status\)/);
  assert.ok(blockList, 'enforcement must still gate on a subscription_status block list — re-point this test');
  assert.ok(!blockList[1].includes('trialing'), 'trialing must never be a blocked status');
});

test('the advertised trial matches the trial the checkout grants', () => {
  const brand = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'marketing', 'src', 'lib', 'brand.ts'),
    'utf8'
  );
  const trialDays = brand.match(/teamTrialDays:\s*(\d+)/);
  assert.ok(trialDays, 'brand.ts must state the trial length');
  assert.strictEqual(Number(trialDays[1]), PLANS.developer_pro.trial_days);
}, { requires: ['apps/marketing'] });

(async () => {
  console.log('=== Team trial ===\n');
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
