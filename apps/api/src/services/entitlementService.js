const { PLANS, normalizePlanId } = require('../config/plans');
const db = require('../config/db');
const { REFERRAL_REWARD_TIER } = require('./referralService');
const { isSelfHosted, selfHostedEntitlements } = require('../config/selfHosted');

function cloneFeatures(features = {}) {
    return Object.fromEntries(Object.entries(features).map(([key, value]) => [key, Boolean(value)]));
}

// A plan limit is one of THREE things, and the merge has to tell them apart:
//   • a number    — a real cap
//   • null        — explicitly UNLIMITED. The sentinel documented in config/plans.js
//                   and read as uncapped by checkEnforcement's Number.isFinite guard,
//                   by the project cap (contextSyncService createProject) and by
//                   applyHistoryWindow. It is the most generous value there is.
//   • undefined   — the key is absent from that plan, i.e. it says nothing at all.
//
// The overlay is a REWARD (the referral month of Pro), so every key must resolve to
// the more generous of the two sides. The previous implementation collapsed null and
// undefined together with `== null` and, when the overlay was null, returned the
// BASE's number — so unlimited lost to a cap. Every limit Free bounds is expressed by
// Pro as null, so the 30-day referral reward lifted NONE of them: a referred user was
// told they had Pro and kept every Free bound — the whole reward.
// (Free's bounds are history_days and included_skills as of 2026-08-27; the
// workspace cap that originally motivated this comment has since been removed.)
//
// Note this is a grant, never a claw-back: when the premium lapses the caps return,
// but nothing is deleted. createProject only blocks the NEXT workspace (existing ones
// are kept, which is why `used` can legitimately exceed `cap`), and applyHistoryWindow
// narrows the view rather than the stored data.
function mergeLimits(baseLimits = {}, overlayLimits = {}) {
    const keys = new Set([...Object.keys(baseLimits || {}), ...Object.keys(overlayLimits || {})]);
    const merged = {};
    for (const key of keys) {
        const baseValue = baseLimits[key];
        const overlayValue = overlayLimits[key];
        const baseAbsent = baseValue === undefined;
        const overlayAbsent = overlayValue === undefined;
        // A side that declares nothing defers to the one that does. (Both absent is
        // unreachable with real plan definitions — every value is a number or null —
        // and keeps the previous null for safety.)
        if (baseAbsent && overlayAbsent) { merged[key] = null; continue; }
        if (baseAbsent) { merged[key] = overlayValue; continue; }
        if (overlayAbsent) { merged[key] = baseValue; continue; }
        // Both declare: unlimited beats any cap, otherwise the larger cap wins.
        if (baseValue === null || overlayValue === null) { merged[key] = null; continue; }
        merged[key] = Math.max(Number(baseValue), Number(overlayValue));
    }
    return merged;
}

function hasActiveReferralPremium(org) {
    if (!org?.referral_premium_until) return false;
    return new Date(org.referral_premium_until).getTime() > Date.now();
}

/**
 * Resolves the entitlements for a given organization based on their tier.
 */
function resolveEntitlementsForTier(tierId) {
    const normalizedTier = normalizePlanId(tierId);
    const plan = PLANS[normalizedTier] || PLANS.free;

    return {
        tier: normalizedTier,
        limits: plan.limits,
        features: plan.features
    };
}

// 'trial_expired' is a documented subscription_status (see sql/schema.sql) that was in
// neither this set nor checkEnforcement's deny list, so an expired trial would have kept
// full paid entitlements. Nothing currently writes that status — trials never actually
// expire today — so adding it changes no live behaviour. It closes the gap ahead of time,
// which matters now that plan enforcement is actually wired into the request path.
//
// 'incomplete' (the owner's decision, 2026-09-29): Stripe reports it while the
// FIRST payment of a subscription has not succeeded, so nothing has ever been
// collected. It locks exactly as 'unpaid' does. 'paused' does not lock. An
// 'incomplete_expired' subscription is gone: the webhook settles it as an ended
// subscription, and the workspace is Free.
//
// enforcementService's gate spells the same list out; a test holds the two equal.
const INACTIVE_STATUSES = new Set(['cancelled', 'unpaid', 'incomplete', 'past_due', 'trial_expired']);

function getEntitlementsFromOrg(org) {
    // SELF-HOSTED: everything, for every workspace, whatever its row says. The
    // org row on a self-host still carries the hosted defaults (plan 'free',
    // status 'trial_active') because the signup paths write them; reading them
    // would cap a self-hoster at one seat and 90 days. Decided here, the single
    // place every entitlement read goes through (checkFeature, checkLimit,
    // checkEnforcement, the brief window, the portfolio, sharing).
    if (isSelfHosted()) return selfHostedEntitlements();
    // Bug 2 fix: checkFeature/checkLimit called into getEntitlementsFromOrg
    // without any subscription_status check. A cancelled/unpaid/past_due org
    // with a premium plan_tier still got full feature grants for team mgmt,
    // audit logs, etc. Downgrade to free entitlements when status is inactive.
    // Referral premium is also suppressed — it only applies to active accounts.
    const effectiveTier = INACTIVE_STATUSES.has(org?.subscription_status)
        ? 'free'
        : normalizePlanId(org?.plan_tier || 'free');
    const base = resolveEntitlementsForTier(effectiveTier);
    // SEATS FOLLOW THE PURCHASE, not the plan's default.
    //
    // included_seats on the plan is what a Team subscription ships with; what
    // this org actually bought is on the org row, kept in step with the Stripe
    // subscription's quantity by the webhook. Buying eight and being capped at
    // five would be a paying customer locked out of their own workspace, and
    // they would have no way to tell it was our arithmetic rather than theirs.
    //
    // Ignored on an inactive subscription: effectiveTier is already 'free' by
    // then, and honouring a purchased count for a cancelled org would keep
    // selling them something they stopped paying for.
    const purchased = Number(org?.purchased_seats);
    const seatsApply = effectiveTier !== 'free' && Number.isFinite(purchased) && purchased > 0;
    if (seatsApply) {
      base.limits = { ...base.limits, included_seats: purchased };
    }
    const referralPremiumActive = !INACTIVE_STATUSES.has(org?.subscription_status) && hasActiveReferralPremium(org);
    if (!referralPremiumActive) {
        return {
            ...base,
            referral_premium_active: false,
            referral_reward_tier: null,
            referral_premium_until: org?.referral_premium_until || null,
        };
    }

    const overlay = resolveEntitlementsForTier(REFERRAL_REWARD_TIER);
    return {
        ...base,
        features: {
            ...cloneFeatures(base.features),
            ...Object.fromEntries(Object.entries(cloneFeatures(overlay.features)).map(([key, value]) => [key, value || Boolean(base.features[key])])),
        },
        limits: mergeLimits(base.limits, overlay.limits),
        referral_premium_active: true,
        referral_reward_tier: REFERRAL_REWARD_TIER,
        referral_premium_until: org?.referral_premium_until || null,
    };
}

async function getEntitlements(orgId, orgOverride = null) {
    if (isSelfHosted()) return selfHostedEntitlements();
    if (orgOverride) return getEntitlementsFromOrg(orgOverride);

    // 1. Fetch Org Tier
    const res = await db.query('SELECT plan_tier, subscription_status, referral_premium_until, purchased_seats FROM organizations WHERE org_id = $1', [orgId], orgId);
    const org = res.rows[0];
    return getEntitlementsFromOrg(org);
}

// Like getEntitlements, but returns null when the org row doesn't exist instead
// of defaulting to free. Product-quality gates (the brief memory window, the
// workspace cap) use this so system/dev actors without an org row are never
// capped as if they were free customers. Billing enforcement keeps the
// fail-closed free default above.
async function getEntitlementsForExistingOrg(orgId) {
    if (isSelfHosted()) return selfHostedEntitlements();
    const res = await db.query('SELECT plan_tier, subscription_status, referral_premium_until, purchased_seats FROM organizations WHERE org_id = $1', [orgId], orgId);
    const org = res.rows[0];
    return org ? getEntitlementsFromOrg(org) : null;
}

/**
 * Checks if a specific feature is enabled.
 */
async function checkFeature(orgId, featureName) {
    const entitlements = await getEntitlements(orgId);
    if (!entitlements.features[featureName]) {
        throw { status: 403, code: 'upgrade_required', message: `Feature '${featureName}' requires a higher plan.` };
    }
    return true;
}

/**
 * Checks if a limit has been reached (e.g., integrations count).
 */
async function checkLimit(orgId, limitName, currentCount) {
    const entitlements = await getEntitlements(orgId);
    const limit = entitlements.limits[limitName];

    // GUARD ON Number.isFinite, NOT ON `!== undefined`.
    //
    // `null` is the uncapped sentinel across plans.js (included_projects,
    // history_days, syncs_per_day, included_skills all use it). Under the old
    // `limit !== undefined` test, null passed the guard and then `currentCount >=
    // null` coerced to `currentCount >= 0` — true for every count including zero.
    // A null limit read here was therefore not "uncapped" but "a cap of zero",
    // rejecting the very first request.
    //
    // It had never fired only because this helper happened to be called solely
    // for limits that are still finite on every tier. Adding a seat cap — null on
    // the uncapped tiers — is exactly the change that would have detonated it.
    if (Number.isFinite(limit) && currentCount >= limit) {
        throw { status: 402, code: 'limit_exceeded', message: `You have reached the limit for ${limitName} (${limit}). Upgrade to add more.` };
    }
    return true;
}

// mergeLimits is exported for tests only. Its invariant — an absent key defers
// to the other side, an explicit null beats any number — used to be witnessable
// through real plan data, because Free and Team declared different limit keys.
// They no longer do (both declare included_seats), so the only way to keep the
// rule pinned rather than merely assumed is to drive the function directly.
module.exports = { INACTIVE_STATUSES, getEntitlements, getEntitlementsForExistingOrg, getEntitlementsFromOrg, checkFeature, checkLimit, mergeLimits };
