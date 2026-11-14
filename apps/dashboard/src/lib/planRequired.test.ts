/**
 * An account the API created with no plan (HOSTED_FREE_TIER_FOR_NEW_SIGNUPS
 * off) must land on the plan picker, and the picker must not offer it Free.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PLAN_REQUIRED_STATUS, CHOOSE_PLAN_PATH, isPlanRequired, planRequiredRedirect } from './planRequired';

const REPO_ROOT = join(import.meta.dirname, '../../../..');

test('the status is the one the API writes', () => {
  const plans = readFileSync(join(REPO_ROOT, 'apps/api/src/config/plans.js'), 'utf8');
  const match = /const PLAN_REQUIRED_STATUS = '([a-z_]+)'/.exec(plans);
  assert.ok(match, 'plans.js no longer declares PLAN_REQUIRED_STATUS — re-point this test');
  assert.strictEqual(PLAN_REQUIRED_STATUS, match[1]);
});

test('every existing status is left alone — the redirect is inert for today\'s accounts', () => {
  for (const status of ['trial_active', 'active', 'trialing', 'past_due', 'incomplete', 'cancelled', undefined, null]) {
    assert.strictEqual(isPlanRequired(status), false);
    assert.strictEqual(planRequiredRedirect(status, '/'), null);
  }
});

test('a plan_required account is sent to the picker from product pages', () => {
  for (const path of ['/', '/portfolio', '/trails', '/settings/team', '/settings/usage', '/onboarding']) {
    assert.strictEqual(planRequiredRedirect(PLAN_REQUIRED_STATUS, path), CHOOSE_PLAN_PATH, path);
  }
});

test('…but may stay where it buys a plan or deletes its account', () => {
  for (const path of ['/select-plan', '/checkout', '/settings/plan', '/settings/upgrade', '/settings', '/security']) {
    assert.strictEqual(planRequiredRedirect(PLAN_REQUIRED_STATUS, path), null, path);
  }
});

test('the picker drops the Free card and its escapes for a plan_required account', () => {
  const page = readFileSync(join(import.meta.dirname, '../pages/select-plan.tsx'), 'utf8');
  assert.match(page, /planRequired \? PERSONAL_PLANS\.filter\(\(plan\) => plan\.id !== 'free'\)/);
  assert.match(page, /if \(isLoading \|\| planRequired\) return;/, 'dismissing must not drop a plan_required account into a workspace it cannot use');
  assert.match(page, /isPlanRequired\(b\?\.org\?\.subscription_status\)/);
});
