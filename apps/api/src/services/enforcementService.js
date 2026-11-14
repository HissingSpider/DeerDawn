const db = require('../config/db');
const { getEntitlementsFromOrg } = require('./entitlementService');
const { normalizePlanId, PLAN_REQUIRED_STATUS } = require('../config/plans');
const { orgLockReason } = require('./lockReasons');
const { redis } = require('../config/redis');
const { isSelfHosted } = require('../config/selfHosted');

const ORG_CACHE_TTL = 300; // 5 minutes
// Short TTL for the per-period usage recount (product_events COUNT). Kept tight so the
// hard-cap gate stays roughly current without running a COUNT on every hot-path request.
const USAGE_COUNT_TTL = 60; // 1 minute

/**
 * Checks if an organization is allowed to perform an action.
 */
async function checkEnforcement(orgId, featureNeeded = null) {
    // 1. Fetch Org & Entitlements
    let org;
    let entitlements;
  
    const cacheKey = `org:${orgId}`;
  
    try {
        const cached = await redis.get(cacheKey);
        if (cached) {
            org = JSON.parse(cached);
        } else {
            const orgRes = await db.query(
                `SELECT org_id, subscription_status, plan, plan_tier, pending_plan, account_type,
                        is_locked, dispute_lock_ids, purchased_seats, billing_period_start, billing_cycle_anchor, created_at, shadow_mode, fail_mode,
                        redaction_keys, redaction_mode, referral_premium_until
                 FROM organizations
                 WHERE org_id = $1`,
                [orgId],
                orgId
            );
            if (orgRes.rows.length === 0) throw new Error('organization_not_found');
            org = orgRes.rows[0];
            await redis.setex(cacheKey, ORG_CACHE_TTL, JSON.stringify(org));
        }
        // Derive entitlements from the org record to avoid an extra DB round-trip.
        entitlements = getEntitlementsFromOrg(org);

    } catch (e) {
        console.error('Org Cache Error:', e);
        // Fallback
        const orgRes = await db.query(
            `SELECT org_id, subscription_status, plan, plan_tier, pending_plan, account_type,
                    is_locked, dispute_lock_ids, purchased_seats, billing_period_start, created_at, shadow_mode, fail_mode,
                    redaction_keys, redaction_mode, referral_premium_until
             FROM organizations
             WHERE org_id = $1`,
            [orgId],
            orgId
        );
        org = orgRes.rows[0];
        entitlements = getEntitlementsFromOrg(org);
    }
  
    // 2. Safety Gates
    // Two locks, kept apart (lockReasons.js): the owner's lockdown switch
    // (is_locked) and a Stripe dispute (dispute_lock_ids). `lock_reason` says
    // which, so the screen can tell the reader what they can do about it.
    const lockReason = orgLockReason(org);
    if (lockReason) {
        return { allowed: false, error: 'lockdown_active', lock_reason: lockReason, upgrade_required: false };
    }

    // SELF-HOSTED: plan enforcement never refuses. There is no subscription to
    // be inactive, no plan to lack a feature, no metered cap. The lock above
    // still applies: is_locked is the workspace owner's own lockdown switch, a
    // security control the owner turns on themselves, not a billing gate (and a dispute
    // lock cannot be written without Stripe webhooks, which are off).
    if (isSelfHosted()) {
        return { allowed: true, org, entitlements };
    }

    // 2b. HOSTED PRICING (2026-11) — kept as its own block so it merges cleanly
    // with anything else that changes this function. An account created while
    // HOSTED_FREE_TIER_FOR_NEW_SIGNUPS was off has no usable plan until it
    // checks out (config/plans.js newSignupPlanState). Its plan_tier reads
    // 'free', so the inactive-status gate below would let it through; this is
    // the refusal. The dashboard routes 'plan_required' to /select-plan.
    if (org.subscription_status === PLAN_REQUIRED_STATUS) {
        return { allowed: false, error: 'plan_required', subscription_status: PLAN_REQUIRED_STATUS, upgrade_required: true };
    }

    // 3. Status Gates
    // Bug 1 fix: past_due was missing. A card decline sets past_due immediately;
    // without this gate the org kept full paid access through Stripe's entire
    // dunning cycle (7-30 days). Stripe restores 'active' automatically on retry.
    // 'trial_expired' included for the same reason as in entitlementService's
    // INACTIVE_STATUSES: it is a documented status that nothing writes yet, and leaving it
    // out would mean an expired trial passes this gate with full access.
    //
    // 'incomplete' (the first payment never succeeded) locks like 'unpaid'; 'paused'
    // does not. The list must equal entitlementService's INACTIVE_STATUSES: a test
    // (tests/integration/journey-r5-billing.test.js) reads both.
    //
    // CANCELLING A SUBSCRIPTION DROPS YOU TO FREE. IT DOES NOT ERASE YOUR ACCOUNT.
    //
    // customer.subscription.deleted writes plan='free' AND status='cancelled',
    // and getEntitlementsFromOrg already reads that pair as "free entitlements".
    // This gate was the one place that read it as "no access at all", so a
    // churned workspace became unreachable — for its owner AND for every
    // teammate bound to it, with nothing left to pay for and no way back in. The
    // status still gates everything that is still on a PAID plan, which is the
    // delinquency this exists to catch: past_due during Stripe's dunning cycle,
    // an expired trial that has not been downgraded. Once the plan itself is
    // free there is nothing outstanding for the refusal to protect.
    //
    // The org's OWN plan, not entitlements.tier: getEntitlementsFromOrg already
    // reports 'free' for every inactive status, so reading that would make this
    // gate answer its own question and never fire.
    if (['cancelled', 'unpaid', 'incomplete', 'past_due', 'trial_expired'].includes(org.subscription_status)
        && normalizePlanId(org.plan_tier || org.plan) !== 'free') {
        const refusal = { allowed: false, error: 'subscription_inactive', upgrade_required: true };
        // The first payment never succeeded: nothing was ever collected, so the
        // way out is to check out again for the same plan, not the billing portal.
        // Name what to check out again (enforcePlan puts it in the 403 body).
        if (org.subscription_status === 'incomplete') {
            refusal.subscription_status = 'incomplete';
            refusal.retry_checkout = {
                plan: normalizePlanId(org.plan_tier || org.plan),
                seats: Number(org.purchased_seats) > 0 ? Number(org.purchased_seats) : null,
            };
        }
        return refusal;
    }

    // 4. Feature Gates
    if (featureNeeded && !entitlements.features[featureNeeded]) {
        return { allowed: false, error: 'feature_not_included', feature: featureNeeded, upgrade_required: true };
    }

    // 5. Usage Limits — for free/starter tiers with hard caps only.
    //
    // "Used" is sourced from product_events (event_name='context_delivered' = context
    // that actually reached a tool) since the billing period start — the SAME signal
    // billing.js getUsageSummary renders on the Usage & value page, so enforcement and
    // the dashboard always agree. The legacy usage_counters.decisions_count is NOT used:
    // nothing on the sync path increments it (its only writer, incrementUsage(), was dead
    // code and has been removed), so it reads 0 under real usage. Metered per-decision
    // counting/overage belongs to the governance product, which was extracted to a
    // separate repo; context-sync gates on the product_events signal instead.
    //
    // periodStart uses the same billing_period_start || billing_cycle_anchor || start-of-
    // month fallback chain as getUsageSummary, so both compute usage over the same window.
    //
    // Redis fronts the count with a short TTL: this is a periodic recount cache (there is
    // no incrementer keeping a long-lived counter fresh), so we run COUNT(*) at most once
    // per USAGE_COUNT_TTL instead of on every hot-path request. On Redis failure we count
    // directly, which is safe and never blocks the request.
    const decisionLimit = entitlements.limits.included_decisions;
    // A null/undefined limit means "uncapped" (e.g. free is gated on workspaces +
    // history, never on sync volume — see config/plans.js). Number.isFinite also
    // rejects the null-coercion footgun where `used >= null` would read as `>= 0`
    // and block everyone. Only run the count when there is a real numeric cap.
    if (['free', 'starter'].includes(entitlements.tier) && Number.isFinite(decisionLimit)) {
        const periodStart = org.billing_period_start || org.billing_cycle_anchor || new Date(new Date().getFullYear(), new Date().getMonth(), 1);
        const monthKey = new Date(periodStart).toISOString().slice(0, 7);
        // ":pe" namespaces this product_events recount cache so it can never collide with
        // any stale long-TTL value written under the old usage_counters-backed semantics.
        const usageKey = `usage:${orgId}:${monthKey}:pe`;

        const countDelivered = async () => {
            const countRes = await db.query(
                `SELECT COUNT(*)::int AS used
                   FROM product_events
                  WHERE org_id = $1
                    AND event_name = 'context_delivered'
                    AND created_at >= $2`,
                [orgId, periodStart],
                orgId
            );
            return parseInt(countRes.rows[0]?.used || 0, 10);
        };

        let used;
        try {
            const cached = await redis.get(usageKey);
            if (cached !== null) {
                used = parseInt(cached, 10);
            } else {
                used = await countDelivered();
                await redis.setex(usageKey, USAGE_COUNT_TTL, String(used));
            }
        } catch {
            // Redis unavailable: count directly (safe, never blocks the request)
            used = await countDelivered();
        }

        if (used >= decisionLimit) {
            return { allowed: false, error: 'decision_limit_exceeded', upgrade_required: true };
        }
    }

    return { allowed: true, org, entitlements };
}

async function invalidateOrgCache(orgId) {
    await redis.del(`org:${orgId}`).catch(() => {});
}

module.exports = {
    checkEnforcement,
    invalidateOrgCache
};
