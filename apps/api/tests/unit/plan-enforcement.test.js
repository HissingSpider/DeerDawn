/**
 * Plan Enforcement Unit Tests
 *
 * Pure unit tests for plans.js — no HTTP, no DB.
 * Verifies plan limits, feature gates, aliases, and ordering.
 */

const test = require('node:test');
const assert = require('node:assert');
const {
    TRIAL_DECISION_LIMIT,
    TRIAL_PLAN,
    normalizePlanId,
    getPlan,
    getPlanOrder,
    isSelfServePlan,
    isOrganizationPlan,
    getPublicBillingPlans,
} = require('../../src/config/plans');

test('Plan Enforcement Unit Tests', async (t) => {

    await t.test('trial constants are correct', () => {
        assert.strictEqual(TRIAL_PLAN, 'free');
        assert.strictEqual(TRIAL_DECISION_LIMIT, 1000);
    });

    await t.test('normalizePlanId handles aliases', () => {
        assert.strictEqual(normalizePlanId('standard'), 'starter');
        assert.strictEqual(normalizePlanId('personal_basic'), 'developer_basic');
        assert.strictEqual(normalizePlanId('personal_developer'), 'developer_pro');
        assert.strictEqual(normalizePlanId('pro'), 'enterprise');
        assert.strictEqual(normalizePlanId('starter_cx'), 'starter');
        assert.strictEqual(normalizePlanId('growth_cx'), 'growth');
        assert.strictEqual(normalizePlanId('scale_cx'), 'scale');
    });

    await t.test('normalizePlanId handles invalid input gracefully', () => {
        assert.strictEqual(normalizePlanId(null), 'free');
        assert.strictEqual(normalizePlanId(undefined), 'free');
        assert.strictEqual(normalizePlanId(''), 'free');
        assert.strictEqual(normalizePlanId('nonexistent_plan'), 'nonexistent_plan');
    });

    await t.test('getPlan returns correct plan objects', () => {
        assert.strictEqual(getPlan('free').id, 'free');
        assert.strictEqual(getPlan('starter').id, 'starter');
        assert.strictEqual(getPlan('growth').id, 'growth');
        assert.strictEqual(getPlan('scale').id, 'scale');
        assert.strictEqual(getPlan('enterprise').id, 'enterprise');
        // Falls back to free for unknown
        assert.strictEqual(getPlan('totally_unknown').id, 'free');
    });

    await t.test('free plan has correct limits', () => {
        const plan = getPlan('free');
        // Free is uncapped on decision/sync volume (gated on workspaces + history instead);
        // null is the "no cap" sentinel that checkEnforcement treats as unlimited.
        assert.strictEqual(plan.limits.included_decisions, null);
        assert.strictEqual(plan.limits.included_admins, 1);
        assert.strictEqual(plan.is_trial, true);
    });

    // The integration cap was config-only: nothing enforced it and no surface
    // ever sold a tool count (select-plan says "All integrations"). It is now
    // the same null sentinel, on both live tiers. Connecting a SECOND tool is
    // the habit metric the business runs on, so a cap here must not come back —
    // this asserts the promise, not an implementation detail.
    await t.test('live tiers do not cap tool integrations', () => {
        assert.strictEqual(getPlan('free').limits.included_integrations, null);
        assert.strictEqual(getPlan('developer_basic').limits.included_integrations, null);
    });

    await t.test('starter plan has correct limits', () => {
        const plan = getPlan('starter');
        assert.strictEqual(plan.limits.included_decisions, 5000);
        assert.strictEqual(plan.limits.included_integrations, 1);
        assert.strictEqual(plan.limits.included_admins, 2);
    });

    await t.test('growth plan has correct limits', () => {
        const plan = getPlan('growth');
        assert.strictEqual(plan.limits.included_decisions, 25000);
        assert.strictEqual(plan.limits.included_integrations, 3);
        assert.strictEqual(plan.limits.included_admins, 5);
    });

    await t.test('scale plan has correct limits', () => {
        const plan = getPlan('scale');
        assert.strictEqual(plan.limits.included_decisions, 100000);
        assert.strictEqual(plan.limits.included_integrations, 10);
    });

    await t.test('feature gates: free plan excludes all gated features', () => {
        const plan = getPlan('free');
        assert.strictEqual(plan.features.human_approval, false);
        assert.strictEqual(plan.features.audit_log, false);
        assert.strictEqual(plan.features.webhooks, false);
        assert.strictEqual(plan.features.team_management, false);
        assert.strictEqual(plan.features.fail_mode_config, false);
    });

    await t.test('feature gates: starter plan includes human_approval, audit_log, team_management', () => {
        const plan = getPlan('starter');
        assert.strictEqual(plan.features.human_approval, true);
        assert.strictEqual(plan.features.audit_log, true);
        assert.strictEqual(plan.features.team_management, true);
        // Not yet on starter
        assert.strictEqual(plan.features.webhooks, false);
        assert.strictEqual(plan.features.fail_mode_config, false);
    });

    await t.test('feature gates: growth plan includes webhooks and fail_mode_config', () => {
        const plan = getPlan('growth');
        assert.strictEqual(plan.features.webhooks, true);
        assert.strictEqual(plan.features.fail_mode_config, true);
        assert.strictEqual(plan.features.human_approval, true);
        assert.strictEqual(plan.features.audit_log, true);
    });

    await t.test('feature gates: scale plan includes alerts_advanced', () => {
        const plan = getPlan('scale');
        assert.strictEqual(plan.features.alerts_advanced, true);
        assert.strictEqual(plan.features.webhooks, true);
    });

    await t.test('feature gates: enterprise plan has all features', () => {
        const plan = getPlan('enterprise');
        assert.strictEqual(plan.features.human_approval, true);
        assert.strictEqual(plan.features.audit_log, true);
        assert.strictEqual(plan.features.webhooks, true);
        assert.strictEqual(plan.features.fail_mode_config, true);
        assert.strictEqual(plan.features.team_management, true);
        assert.strictEqual(plan.features.alerts_advanced, true);
    });

    await t.test('plan ordering is correct (higher tier = higher order)', () => {
        assert.ok(getPlanOrder('starter') > getPlanOrder('free'));
        assert.ok(getPlanOrder('growth') > getPlanOrder('starter'));
        assert.ok(getPlanOrder('scale') > getPlanOrder('growth'));
        assert.ok(getPlanOrder('enterprise') > getPlanOrder('scale'));
    });

    await t.test('isSelfServePlan identifies self-serve tiers', () => {
        // Governance tiers (starter/growth/scale) are no longer sold or self-serve.
        assert.strictEqual(isSelfServePlan('starter'), false);
        assert.strictEqual(isSelfServePlan('growth'), false);
        assert.strictEqual(isSelfServePlan('scale'), false);
        assert.strictEqual(isSelfServePlan('free'), false);
        assert.strictEqual(isSelfServePlan('developer_basic'), true);
        // Team became purchasable on 2026-09-02. It was false here for a real
        // reason — the Stripe prices behind it were still the old $25/$240 ones,
        // and a purchasable column at the wrong price is a billing bug — and
        // that reason is gone: $15/seat and $150/seat/year exist, and the API
        // holds their ids. The invariant that replaces "Team is not sold" is
        // "a plan is self-serve only once its price ids resolve", which
        // validateCheckoutCatalog enforces at checkout time.
        assert.strictEqual(isSelfServePlan('developer_pro'), true);
        assert.strictEqual(isSelfServePlan('enterprise'), false);
        assert.strictEqual(isSelfServePlan('pilot'), false);
    });

    await t.test('isOrganizationPlan identifies org vs personal plans', () => {
        assert.strictEqual(isOrganizationPlan('starter'), true);
        assert.strictEqual(isOrganizationPlan('growth'), true);
        assert.strictEqual(isOrganizationPlan('enterprise'), true);
        assert.strictEqual(isOrganizationPlan('developer_basic'), false);
        // developer_pro is the plan named "Team". It was account_type 'personal'
        // while simultaneously being sold per seat, which is the same
        // contradiction that had it shipping with team_management: false.
        assert.strictEqual(isOrganizationPlan('developer_pro'), true);
    });

    await t.test('getPublicBillingPlans returns the full public catalog with required shape', () => {
        const plans = getPublicBillingPlans();
        assert.ok(Array.isArray(plans));
        // Public catalog is Free + Individual (developer_basic) + Team
        // (developer_pro) as of the 2026-11 hosted pricing; the exact membership
        // is pinned by the id checks below.
        assert.strictEqual(plans.length, 3);

        for (const plan of plans) {
            assert.ok(plan.id, 'plan missing id');
            assert.ok(plan.publicName, `plan ${plan.id} missing publicName`);
            assert.ok(typeof plan.price === 'number' || plan.price === null, `plan ${plan.id} price invalid`);
            assert.ok(plan.limits, `plan ${plan.id} missing limits`);
            assert.ok(plan.features, `plan ${plan.id} missing features`);
        }

        const ids = plans.map(p => p.id);
        assert.ok(ids.includes('free'));
        assert.ok(ids.includes('developer_basic'));
        // Enterprise left the public catalog with the 2026-11 hosted pricing:
        // "everything unlocked" is the self-hosted install now.
        assert.ok(!ids.includes('enterprise'));
        // Team (developer_pro) is public AND self-serve at $15/seat.
        assert.ok(ids.includes('developer_pro'));
        assert.ok(isSelfServePlan('developer_pro'));
        // Governance tiers and non-public plans must not appear in the public catalog
        assert.ok(!ids.includes('starter'));
        assert.ok(!ids.includes('growth'));
        assert.ok(!ids.includes('scale'));
        assert.ok(!ids.includes('pilot'));
    });

    await t.test('overage pricing is set for growth and scale, null for free/starter', () => {
        assert.ok(getPlan('growth').overage_per_decision > 0);
        assert.ok(getPlan('scale').overage_per_decision > 0);
        assert.ok(getPlan('scale').overage_per_decision < getPlan('growth').overage_per_decision);
        assert.ok(!getPlan('free').overage_per_decision);
        assert.ok(!getPlan('starter').overage_per_decision);
    });
});
