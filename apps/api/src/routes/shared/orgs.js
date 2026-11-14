const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { verifyPassword } = require('../../utils/security');
const {
    requireAuth,
    isClerkConfigured,
    clerkUserHasPassword,
    verifyClerkPassword,
    deleteClerkUser,
} = require('../../middleware/auth');
const contextSyncService = require('../../services/contextSyncService');
const encryption = require('../../services/encryptionService');
const { renderContextExportMarkdown } = require('../../services/contextExportMarkdown');
const { sendEmail } = require('../../services/email/resendClient');
const { PLANS, normalizePlanId, isSelfServePlan, getPlan, getPlanOrder } = require('../../config/plans');
const { createCheckoutSession, createPortalSession, cancelSubscriptionForDeletion } = require('../../services/stripeService');
const { checkFeature, checkLimit, getEntitlements } = require('../../services/entitlementService');
const { requireBillingEnabled } = require('../../config/selfHosted');
const { invalidateOrgCache } = require('../../services/enforcementService');
const referralService = require('../../services/referralService');
const { purgeOwnerData, closeWorkspaceInTransaction } = require('../../services/dataErasureService');
const workspace = require('../../services/workspaceService');
const { LOCK_MESSAGES, orgLockReason } = require('../../services/lockReasons');
// Who pays may not stop being part of a workspace while its subscription renews
// on their card (journey r6; services/billingOwnerService.js), and the seat
// shortfall the plan page reports.
const billingOwner = require('../../services/billingOwnerService');
const billingNotices = require('../../services/billingNoticeService');

router.use(requireAuth);

/**
 * The workspace a MONEY route applies to: the bound one, not the org the caller
 * signed up under.
 *
 * Identical to billingWorkspace in routes/shared/billing.js, and here for the
 * same reason. PR #475 moved every /billing route onto the bound workspace and
 * left GET /orgs/usage — which is what /settings/plan and /settings/usage
 * actually render — reading req.actor.org_id. The billing page could therefore
 * describe your personal Free account while the Upgrade button beside it
 * charged the team, or the reverse. Each screen is truthful on its own; only
 * together are they a lie, which is why it does not look like a bug until
 * somebody's card is charged for the wrong workspace.
 *
 * `actor.org_id` is NOT a fallback that is merely imprecise: an invited
 * teammate's users.org_id is still their own personal org, so for every member
 * of every shared workspace it is the wrong answer, every time.
 */
function moneyWorkspace(req) {
    if (!req.actor?.workspace_key && !req.actor?.org_id) return null;
    return workspace.defaultOwnerKey(req.actor);
}

/**
 * Spending a workspace's money, or reaching its Stripe portal, is an OWNER's
 * power — resolved from workspace membership, never from `actor.role`, which is
 * 'admin' by default for nearly every self-signup and absent on internal actors.
 *
 * Identical to requireBillingOwner in routes/shared/billing.js. PR #480 added
 * that gate to every /billing route and left these two legacy twins behind, and
 * because moneyWorkspace had just pointed them at the BOUND workspace, the
 * combination was worse than either alone: any member — a viewer included —
 * could open the team's Stripe portal, where the subscription can be cancelled
 * and the payment method changed. The older the route, the less anybody was
 * looking at it.
 *
 * Returns the workspace key, or null once the refusal has been sent.
 */
async function requireMoneyOwner(req, res) {
    const orgId = moneyWorkspace(req);
    if (!orgId) {
        res.status(403).json({ error: 'forbidden' });
        return null;
    }
    let role;
    try {
        role = await workspace.resolveRole(req.actor, orgId);
    } catch (err) {
        // A role that cannot be resolved is not an owner. Failing open here
        // would make a database blip the way in.
        console.error('[ORGS] billing role check failed:', err);
        res.status(503).json({ error: 'billing_unavailable' });
        return null;
    }
    if (!workspace.canAdminister(role)) {
        res.status(403).json({
            error: 'forbidden',
            message: 'Only a workspace owner can change its billing.',
        });
        return null;
    }
    return orgId;
}

async function requireFeatureAccess(res, orgId, featureName) {
    try {
        await checkFeature(orgId, featureName);
        return true;
    } catch (err) {
        res.status(err.status || 403).json({
            error: err.code || 'upgrade_required',
            message: err.message,
            upgrade_required: true
        });
        return false;
    }
}

router.get('/usage', async (req, res) => {
    const orgId = moneyWorkspace(req);
    if (!orgId) return res.status(403).json({ error: 'forbidden' });

    try {
        const orgRes = await db.query(
            `SELECT org_id, name, account_type, plan, plan_tier, subscription_status, billing_period_end,
                    trial_ends_at, is_pilot, pilot_ends_at, stripe_customer_id, redaction_mode,
                    redaction_keys, is_locked, shadow_mode, fail_mode, billing_period_start, billing_cycle_anchor,
                    purchased_seats, team_trial_started_at,
                    cancel_at_period_end, cancel_at, price_unit_amount_cents, price_currency, price_interval, price_interval_count,
                    billing_owner_user_id, billing_takeover, stripe_subscription_id
             FROM organizations
             WHERE org_id = $1`,
            [orgId],
            orgId
        );
        if (orgRes.rows.length === 0) return res.status(404).json({ error: 'org_not_found' });
        const org = orgRes.rows[0];
        const entitlements = await getEntitlements(orgId);
        const planTier = normalizePlanId(org.plan_tier || org.plan || 'free');
        const planConfig = getPlan(planTier);
        // Get current usage counters (use billing_cycle_anchor as fallback if billing_period_start doesn't exist).
        // Briefs delivered this cycle come from product_events (event_name='context_delivered') — the same live
        // signal billing.js getUsageSummary and the enforcement gate use. The legacy usage_counters.decisions_count
        // is no longer populated on the sync path, so we only fall back to it when product_events yields nothing.
        const periodStart = org.billing_period_start || org.billing_cycle_anchor || new Date(new Date().getFullYear(), new Date().getMonth(), 1);
        // Ledger subqueries frame usage as accrued value (what DeerDawn remembers
        // for you), not consumption against a meter. context_projects.owner_key
        // equals the org id for authed actors (getActorKey = org_id || id).
        const countsRes = await db.query(
            `SELECT
                (SELECT COUNT(*) FROM product_events WHERE org_id = $1 AND event_name = 'context_delivered' AND created_at >= $2) AS briefs_delivered,
                (SELECT COUNT(*) FROM product_events WHERE org_id = $1 AND event_name = 'context_delivered') AS briefs_all_time,
                (SELECT decisions_count FROM usage_counters WHERE org_id = $1 AND period_start = $2) AS legacy_decisions,
                (SELECT COUNT(*) FROM integrations WHERE org_id = $1) AS integrations,
                (SELECT COUNT(*) FROM users WHERE org_id = $1 AND role = 'admin') AS admins,
                (SELECT MIN(created_at) FROM context_projects WHERE owner_key = $1) AS oldest_memory_at,
                (SELECT COUNT(*) FROM context_projects WHERE owner_key = $1 AND archived_at IS NULL AND parent_project_id IS NULL) AS projects_count`,
            [orgId, periodStart],
            orgId
        );
        const counts = countsRes.rows[0];
        // DECISIONS REMEMBERED IS COUNTED AFTER DECRYPTION. It was a SQL sum over
        // `context->'recent_decisions'`, and context is stored as { _enc } whenever
        // ENCRYPTION_MASTER_KEY is set — which is production — so the path was
        // NULL on every row and the ledger read 0 for every paying workspace. Same
        // rows as before (this workspace, not archived), same tenant scope, but
        // decrypted in JS; a row that will not decrypt counts nothing rather than
        // failing the page. A workspace aggregate: no project's content leaves.
        counts.decisions_remembered = await db.query(
            'SELECT owner_key, context FROM context_projects WHERE owner_key = $1 AND archived_at IS NULL',
            [orgId],
            orgId
        ).then(async ({ rows }) => {
            let total = 0;
            for (const row of rows || []) {
                const context = await encryption.decryptContextObject(row.owner_key, row.context).catch(() => null);
                if (Array.isArray(context?.recent_decisions)) total += context.recent_decisions.length;
            }
            return total;
        }).catch((err) => {
            console.warn('[ORGS] decisions_remembered unavailable:', err.message);
            return 0;
        });
        const briefsDelivered = parseInt(counts.briefs_delivered || 0, 10);
        const decisionUsage = briefsDelivered > 0 ? briefsDelivered : parseInt(counts.legacy_decisions || 0, 10);
        const integrationUsage = parseInt(counts.integrations, 10);
        const adminUsage = parseInt(counts.admins, 10);

    const limits = {
        decisions: entitlements.limits?.included_decisions ?? null,
        integrations: entitlements.limits?.included_integrations ?? null,
        admins: entitlements.limits?.included_admins ?? null,
        // Free's real gates (paid tiers: null = unlimited). The plan page uses
        // these to explain the memory window instead of rendering a usage meter.
        projects: entitlements.limits?.included_projects ?? null,
        history_days: entitlements.limits?.history_days ?? null
    };
    const remainingDecisionAllowance = limits.decisions == null
        ? null
        : Math.max(limits.decisions - decisionUsage, 0);

        // WHO PAYS, on the plan page (journey r6): whether this person is the
        // billing owner, whether one is on record at all, and a takeover in
        // progress. The billing owner's address is shown to owners only.
        const person = workspace.actorPersonId(req.actor);
        const viewerRole = await workspace.resolveRole(req.actor, orgId).catch(() => null);
        const viewerIsOwner = workspace.canAdminister(viewerRole);
        const takeover = org.billing_takeover && org.billing_takeover.user_id
            ? { pending: true, started_by_you: org.billing_takeover.user_id === person, started_at: org.billing_takeover.started_at || null }
            : null;
        // A payer who is no longer in the workspace (erased, or removed some other
        // way) is not somebody who pays any more: reported as not on record.
        const payerStillHere = Boolean(org.billing_owner_user_id)
            && Boolean(await workspace.getMembership(orgId, org.billing_owner_user_id).catch(() => null));
        let billingOwnerEmail = null;
        if (viewerIsOwner && payerStillHere) {
            const owner = await db.query('SELECT email FROM users WHERE user_id = $1', [org.billing_owner_user_id], 'org-system').catch(() => ({ rows: [] }));
            billingOwnerEmail = owner.rows[0]?.email || null;
        }
        const seatShortfall = await billingNotices.seatShortfallForOrg(orgId).catch(() => null);

        res.json({
        org_name: org.name,
        // WHICH workspace this describes. The page has to be able to print it:
        // "your plan" is ambiguous the moment a person belongs to more than one
        // workspace, and an ambiguous label over a live Upgrade button is how
        // the wrong account gets charged.
        workspace: orgId,
        // "Is this my own account, or one I was invited into?" — the caller's
        // default org is the one they signed up with, and anything else is a
        // workspace they switched to.
        is_personal_workspace: orgId === req.actor?.org_id,
        account_type: org.account_type || 'organization',
        plan: {
            org_id: org.org_id,
            tier: planTier,
            public_name: planConfig.publicName,
            status: org.subscription_status,
            period_end: org.billing_period_end || org.billing_cycle_anchor,
            // What /settings/plan prints of the subscription, as the webhook
            // recorded it on this row (journey r4): the period itself, with no
            // fallback to the anchor (its length is how the page reads the
            // cycle), and the seats bought. Nothing here is fetched from Stripe.
            billing_period_start: org.billing_period_start || null,
            billing_period_end: org.billing_period_end || null,
            purchased_seats: Number.isInteger(org.purchased_seats) && org.purchased_seats > 0 ? org.purchased_seats : null,
            // The pending cancellation and the price Stripe bills, as the webhook
            // recorded them from its own read (journey r6). null = not on record,
            // which the page never fills with a guess.
            cancel_at_period_end: org.cancel_at_period_end === null || org.cancel_at_period_end === undefined ? null : org.cancel_at_period_end === true,
            cancel_at: org.cancel_at || null,
            price: Number.isInteger(org.price_unit_amount_cents)
                ? {
                    unit_amount_cents: org.price_unit_amount_cents,
                    currency: org.price_currency || null,
                    interval: org.price_interval || null,
                    interval_count: Number.isInteger(org.price_interval_count) && org.price_interval_count > 0 ? org.price_interval_count : 1,
                }
                : null,
            billing_owner: {
                recorded: payerStillHere,
                is_you: payerStillHere && org.billing_owner_user_id === person,
                email: billingOwnerEmail,
                // May use the takeover and end-of-period controls: an owner, or
                // the person who pays whatever their role now is.
                can_manage: viewerIsOwner || (payerStillHere && org.billing_owner_user_id === person),
            },
            takeover,
            // More people in the workspace than seats paid for; nobody is suspended.
            seat_shortfall: seatShortfall,
            trial_ends_at: org.trial_ends_at,
            // When this workspace's Team trial started (Stripe-confirmed), or
            // null when it has never had one: there is one per workspace, so
            // the dashboard must not promise a second.
            team_trial_started_at: org.team_trial_started_at || null,
            is_pilot: org.is_pilot || false,
            pilot_ends_at: org.pilot_ends_at,
            overage_per_decision: planConfig.overage_per_decision ?? null,
            remaining_trial_actions: planTier === 'free' ? remainingDecisionAllowance : null,
            referral_premium_until: entitlements.referral_premium_until || null,
            referral_premium_active: Boolean(entitlements.referral_premium_active),
            stripe_customer_id: org.stripe_customer_id,
            redaction_mode: org.redaction_mode,
            redaction_keys: org.redaction_keys || [],
            is_locked: org.is_locked,
            shadow_mode: org.shadow_mode || false,
            fail_mode: org.fail_mode || 'closed'
        },
        usage: {
            decisions: decisionUsage,
            integrations: integrationUsage,
            admins: adminUsage
        },
        limits,
        // Value ledger: usage framed as what DeerDawn has accumulated for the
        // user (memory is wealth), never a countdown toward a cap.
        ledger: {
            briefs_this_period: briefsDelivered,
            briefs_all_time: parseInt(counts.briefs_all_time || 0, 10),
            decisions_remembered: parseInt(counts.decisions_remembered || 0, 10),
            oldest_memory_at: counts.oldest_memory_at || null,
            projects: parseInt(counts.projects_count || 0, 10)
        }
    });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.get('/referrals/me', async (req, res) => {
    try {
        const result = await referralService.listReferralOverview(req.actor);
        res.json(result);
    } catch (err) {
        console.error('Referral overview error:', err);
        res.status(500).json({ error: 'internal_error', message: 'Failed to load referral overview' });
    }
});

// POST /referrals/activate was removed 2026-09-16: a client could call it to
// trigger its own referral reward. Rewards are paid server-side on first sync.

// ... (Inquire endpoint remains same)

router.patch('/settings', async (req, res) => {
    const orgId = req.actor.org_id;
    const { redaction_mode, redaction_keys, is_locked, shadow_mode, fail_mode } = req.body;

    if (!['owner', 'admin'].includes(req.actor.role)) return res.status(403).json({ error: 'forbidden' });

    // Validate redaction_mode
    if (redaction_mode && !['strict', 'permissive'].includes(redaction_mode)) {
        return res.status(400).json({
            error: 'validation_error',
            message: 'redaction_mode must be "strict" or "permissive"'
        });
    }

    // Validate redaction_keys array
    if (redaction_keys !== undefined && redaction_keys !== null) {
        if (!Array.isArray(redaction_keys)) {
            return res.status(400).json({
                error: 'validation_error',
                message: 'redaction_keys must be an array'
            });
        }

        if (redaction_keys.length > 500) {
            return res.status(400).json({
                error: 'validation_error',
                message: 'redaction_keys cannot exceed 500 items'
            });
        }

        // Validate each key in the array
        for (const key of redaction_keys) {
            if (typeof key !== 'string') {
                return res.status(400).json({
                    error: 'validation_error',
                    message: 'All redaction_keys must be strings'
                });
            }

            if (key.length === 0 || key.length > 100) {
                return res.status(400).json({
                    error: 'validation_error',
                    message: 'Each redaction key must be 1-100 characters'
                });
            }
        }
    }

    // Validate is_locked
    if (is_locked !== undefined && typeof is_locked !== 'boolean') {
        return res.status(400).json({
            error: 'validation_error',
            message: 'is_locked must be a boolean'
        });
    }

    // Validate shadow_mode
    if (shadow_mode !== undefined && typeof shadow_mode !== 'boolean') {
        return res.status(400).json({
            error: 'validation_error',
            message: 'shadow_mode must be a boolean'
        });
    }

    if (fail_mode !== undefined && fail_mode !== null) {
        if (!['open', 'closed'].includes(fail_mode)) {
            return res.status(400).json({
                error: 'validation_error',
                message: 'fail_mode must be "open" or "closed"'
            });
        }
    }

    // Build update dynamically — only set fields that were actually sent
    const setClauses = [];
    const values = [];
    let idx = 1;
    if (redaction_mode !== undefined) { setClauses.push(`redaction_mode = $${idx++}`); values.push(redaction_mode); }
    if (redaction_keys !== undefined) { setClauses.push(`redaction_keys = $${idx++}`); values.push(redaction_keys); }
    if (is_locked !== undefined) { setClauses.push(`is_locked = $${idx++}`); values.push(is_locked); }
    if (shadow_mode !== undefined) { setClauses.push(`shadow_mode = $${idx++}`); values.push(shadow_mode); }

    if (fail_mode !== undefined) {
        try {
            await checkFeature(orgId, 'fail_mode_config');
        } catch (err) {
            return res.status(err.status || 403).json({
                error: err.code || 'upgrade_required',
                message: err.message,
                upgrade_required: true
            });
        }
        setClauses.push(`fail_mode = $${idx++}`);
        values.push(fail_mode);
    }

    if (setClauses.length === 0) {
        return res.status(400).json({ error: 'validation_error', message: 'No fields to update' });
    }
    values.push(orgId);

    try {
        const result = await db.query(
            `UPDATE organizations SET ${setClauses.join(', ')} WHERE org_id = $${idx} RETURNING redaction_mode, redaction_keys, is_locked, dispute_lock_ids, shadow_mode, fail_mode`,
            values,
            orgId
        );

        if (result.rowCount === 0) return res.status(404).json({ error: 'org_not_found' });

        await invalidateOrgCache(orgId);

        // `settings.is_locked` is the owner's own lockdown switch and nothing more.
        // A dispute holds the workspace on its own column, which this route cannot
        // clear: say so, so the owner is not left believing it unlocked.
        const { dispute_lock_ids: disputeLockIds, ...settings } = result.rows[0];
        const lockReason = orgLockReason({ is_locked: settings.is_locked, dispute_lock_ids: disputeLockIds });
        res.json({
            success: true,
            settings,
            locked: lockReason !== null,
            lock_reason: lockReason,
            ...(lockReason === 'dispute' ? { message: LOCK_MESSAGES.dispute } : {}),
        });
    } catch (err) {
        console.error('Update settings error:', err);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
});

// Legacy billing endpoint — kept for backwards compatibility with old dashboard builds.
router.post('/upgrade', requireBillingEnabled, async (req, res) => {
    const orgId = await requireMoneyOwner(req, res);
    if (!orgId) return undefined;

    const tierId = normalizePlanId(req.body?.tierId);
    const billingCycle = typeof req.body?.billingCycle === 'string' ? req.body.billingCycle : 'monthly';
    const seats = Number.isFinite(Number(req.body?.seats)) ? Number(req.body.seats) : 1;

    if (!PLANS[tierId]) return res.status(400).json({ error: 'invalid_plan' });

    // Bug 7 fix: this endpoint previously skipped the plan-order and self-serve
    // guardrails that billing.js enforces, allowing any plan including downgrades
    // and non-self-serve plans (e.g. enterprise, pilot). Apply the same checks.
    if (!isSelfServePlan(tierId)) {
        return res.status(400).json({ error: 'invalid_plan', message: 'Contact sales for this plan.' });
    }
    try {
        const orgRes = await db.query(
            'SELECT plan_tier, stripe_subscription_id FROM organizations WHERE org_id = $1',
            [orgId],
            orgId
        );
        const currentTier = normalizePlanId(orgRes.rows[0]?.plan_tier);
        if (tierId !== 'pilot' && getPlanOrder(tierId) <= getPlanOrder(currentTier)) {
            return res.status(400).json({ error: 'invalid_plan', message: 'Cannot checkout for the same or lower tier.' });
        }

        // This legacy path creates a checkout session unconditionally, which for
        // a workspace that ALREADY has a subscription is the double-billing bug
        // /billing/checkout was just fixed for. Rather than duplicate the
        // plan-change logic in a route kept only for old builds, refuse and name
        // the one that does it properly. Refusing costs an old client an upgrade;
        // proceeding costs a customer a second monthly charge.
        if (orgRes.rows[0]?.stripe_subscription_id) {
            return res.status(409).json({
                error: 'subscription_exists',
                message: 'This workspace already has a subscription. Change plans from POST /api/v1/billing/checkout, which moves it instead of opening a second one.',
            });
        }

        let userEmail = req.actor.email;
        if (!userEmail) {
            const userRes = await db.query('SELECT email FROM users WHERE user_id = $1', [req.actor.id], orgId);
            userEmail = userRes.rows[0]?.email || `admin-${orgId}@deerdawn.com`;
        }
        const url = await createCheckoutSession(orgId, userEmail, tierId, { billingCycle, seats });
        res.json({ url });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.post('/portal', requireBillingEnabled, async (req, res) => {
    const orgId = await requireMoneyOwner(req, res);
    if (!orgId) return undefined;

    try {
        const url = await createPortalSession(orgId);
        res.json({ url });
    } catch (err) {
        console.error(err);
        res.status(400).json({ error: err.message });
    }
});

// --- User Management ---

router.get('/users', async (req, res) => {
    const orgId = req.actor.org_id;
    if (!orgId) return res.status(403).json({ error: 'forbidden' });
    if (!await requireFeatureAccess(res, orgId, 'team_management')) return;

    try {
        const { rows } = await db.query('SELECT user_id, email, role, created_at FROM users WHERE org_id = $1 ORDER BY created_at DESC', [orgId], orgId);
        res.json({ users: rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// RETIRED: the legacy invite. It INSERTed a shell `users` row straight into the
// team org and minted a users.invite_token_hash link, bypassing
// workspace_members, seat counting and workspaceService.createInvite entirely,
// and its redemption route (POST /api/v1/auth/invite/accept) is retired with it.
// Nothing in the dashboard, marketing site or SDKs calls it. It answers 410 and
// names the replacement rather than 404, so an external caller learns where to go.
router.post('/users', (req, res) => {
    res.status(410).json({
        error: 'gone',
        message: 'This endpoint has been removed. Invite people to a workspace with POST /api/v1/teams/invite.',
        replacement: '/api/v1/teams/invite',
    });
});

// RETIRED, with the legacy invite it paired with. It HARD-DELETED the users row
// — the person, not their membership — and gated that on `actor.role`, the
// org-level role that is 'admin' by default for nearly everyone and is banned as
// an authority for exactly that reason. It also left workspace_members untouched,
// so the membership row, the seat it holds and the person's API keys all
// survived the "removal".
//
// Removal belongs to DELETE /api/v1/teams/members/:userId, which resolves the
// actor's role in the WORKSPACE, soft-removes the membership and revokes their
// keys — keeping their decisions, landmines and paths, which are the asset the
// workspace is paying for. Nothing calls this: the dashboard's api.ts still
// declares a `deleteUser` wrapper, but no screen invokes it (its sibling
// `inviteUser` was left the same way when POST /users was retired).
router.delete('/users/:id', (req, res) => {
    res.status(410).json({
        error: 'gone',
        message: 'This endpoint has been removed. Remove a person from a workspace with DELETE /api/v1/teams/members/:userId.',
        replacement: '/api/v1/teams/members/:userId',
    });
});

// --- Invite Code ---

// Generate or return an existing invite code for the org (admin only)
router.post('/invite-code/generate', async (req, res) => {
    const orgId = req.actor.org_id;
    if (!orgId) return res.status(403).json({ error: 'forbidden' });
    if (!['owner', 'admin'].includes(req.actor.role)) return res.status(403).json({ error: 'forbidden' });
    if (!await requireFeatureAccess(res, orgId, 'team_management')) return;

    // Generate a random 8-char alphanumeric code
    const code = require('crypto').randomBytes(5).toString('base64url').slice(0, 8).toUpperCase();

    try {
        await db.query(
            'UPDATE organizations SET invite_code = $1 WHERE org_id = $2',
            [code, orgId],
            orgId
        );
        res.json({ invite_code: code });
    } catch (err) {
        console.error('invite-code generate error:', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// Get current invite code for the org (admin only)
router.get('/invite-code', async (req, res) => {
    const orgId = req.actor.org_id;
    if (!orgId) return res.status(403).json({ error: 'forbidden' });
    if (!['owner', 'admin'].includes(req.actor.role)) return res.status(403).json({ error: 'forbidden' });
    if (!await requireFeatureAccess(res, orgId, 'team_management')) return;

    try {
        const { rows } = await db.query('SELECT invite_code FROM organizations WHERE org_id = $1', [orgId], orgId);
        res.json({ invite_code: rows[0]?.invite_code || null });
    } catch (err) {
        console.error('invite-code get error:', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// JOINING A WORKSPACE IS AN AUTHORISATION, NOT A REDIRECT.
//
// This route used to take an org-wide `invite_code` and simply rewrite
// `users.org_id` to the target. Three things followed from that, all bad:
//
// 1. IT MADE THE JOINER AN OWNER. No workspace_members row was written, so
//    resolveRole found no membership and fell through to its last branch —
//    "somebody in their OWN workspace before the backfill reaches them" — which
//    now matched, because org_id had just been rewritten to the target. That
//    returns normalizeRole(users.role), and users.role is 'admin' for nearly
//    every self-signup, which LEGACY_ROLE_MAP maps to 'owner'. Anyone holding
//    an 8-character code became a full owner of the workspace: billing, the
//    membership roster, read access to every `private` project in it.
//
// 2. IT REPORTED FAILURE AFTER SUCCEEDING. The org_id rewrite, the old-org
//    cleanup and the DELETE of the joiner's personal organizations row were
//    separate statements with no transaction. The DELETE routinely raises a
//    foreign-key error (api_keys, context_projects, integrations all point at
//    it), which the catch turned into a 500 — so the caller saw the join fail
//    while the escalation in (1) had already been written and kept.
//
// 3. IT DELETED THE JOINER'S OWN WORKSPACE. "Clean up the old solo org" is a
//    purge of everything that person had done before joining, triggered by
//    pasting a code.
//
// The code is now a SELECTOR — it says which workspace — and the authorisation
// is the same one every other door requires: a live invitation addressed to
// this person's email, or an approved domain. An org-wide code is a bearer
// secret with no addressee, no expiry and no revocation, and workspaceService
// deliberately built neither door that way.
//
// users.org_id is no longer touched. Membership is what grants access, exactly
// as it does for /teams/invite/accept and /teams/joinable/:key/accept, and
// leaving org_id alone is what keeps resolveRole's fallback from ever firing
// again. It also collapses the multi-statement sequence in (2) to a single
// authorising write, which is why there is no transaction to roll back: the
// invite is consumed afterwards, and that follow-up grants nothing, so a
// failure there can only leave a pending invitation, never a member who should
// not be one.
router.post('/join', async (req, res) => {
    const userId = workspace.actorPersonId(req.actor);
    const inviteCode = req.body?.invite_code;

    if (!inviteCode || typeof inviteCode !== 'string' || inviteCode.length > 20) {
        return res.status(400).json({ error: 'invalid_invite_code' });
    }
    if (!userId) return res.status(403).json({ error: 'forbidden' });

    try {
        const targetRes = await db.query(
            'SELECT org_id, name FROM organizations WHERE invite_code = $1',
            [inviteCode.trim().toUpperCase()],
            'org-system'
        );

        if (targetRes.rows.length === 0) {
            return res.status(404).json({ error: 'invite_code_not_found', message: 'Invalid invite code. Check with your team admin.' });
        }

        const targetOrg = targetRes.rows[0];

        if (targetOrg.org_id === req.actor.org_id) {
            return res.status(400).json({ error: 'already_in_org' });
        }
        if (await workspace.getMembership(targetOrg.org_id, userId)) {
            return res.status(400).json({ error: 'already_in_org' });
        }
        if (!await requireFeatureAccess(res, targetOrg.org_id, 'team_management')) return;

        // The person's email is what both gates are addressed to. A key-authed
        // actor carries none, which is why acceptInvite had to be made to fail
        // closed on exactly this: any valid API key plus a forwarded invitation
        // defeated the guarantee that an invitation names a person.
        let email = typeof req.actor.email === 'string' ? req.actor.email.trim().toLowerCase() : '';
        if (!email) {
            const identity = await db.query(
                'SELECT email FROM users WHERE user_id = $1',
                [userId],
                'org-system'
            ).catch(() => ({ rows: [] }));
            email = String(identity.rows[0]?.email || '').trim().toLowerCase();
        }
        if (!email) {
            return res.status(403).json({ error: 'not_invited', message: 'This credential cannot join a workspace. Sign in and accept the invitation.' });
        }

        // THE GATE. An open invitation addressed to this email, or a domain the
        // workspace has approved — re-checked here rather than trusted from any
        // earlier listing, because an offer is not a grant and either can have
        // been withdrawn since.
        const invitation = (await workspace.listInvites(targetOrg.org_id))
            .find((invite) => String(invite.email || '').toLowerCase() === email && invite.status === 'pending');
        const domainOffer = invitation
            ? null
            : (await workspace.joinableWorkspaces(email)).find((offer) => offer.workspace === targetOrg.org_id);
        const admission = invitation || domainOffer;
        if (!admission) {
            return res.status(403).json({
                error: 'not_invited',
                message: 'This workspace has not invited you. Ask an owner to send an invitation to your email address.',
            });
        }

        // THE SEAT GATE HAS TO COVER EVERY DOOR. Same accounting as /teams/invite
        // and the domain door: a workspace that correctly refuses invitation six
        // must not admit people six through forty through this one, uncapped and
        // unbilled.
        const [activeMembers, pendingInvites] = await Promise.all([
            workspace.countActiveMembers(targetOrg.org_id),
            workspace.listInvites(targetOrg.org_id),
        ]);
        // THE JOINER'S OWN INVITATION IS NOT A SECOND SEAT. It was counted when it
        // was sent, precisely so this person would have one; counting it again
        // here, next to the membership it is about to become, refused the LAST
        // invited person the seat that had been held for them. Joining through an
        // invitation is pending -> active: net zero. A domain join has no
        // invitation and does take a new seat, so nothing is subtracted for it.
        const othersPending = pendingInvites
            .filter((invite) => !invitation || invite.invite_id !== invitation.invite_id)
            .length;
        try {
            await checkLimit(targetOrg.org_id, 'included_seats', activeMembers + othersPending);
        } catch (limitErr) {
            return res.status(limitErr.status || 402).json({
                error: limitErr.code || 'limit_exceeded',
                message: limitErr.message,
                upgrade_required: true,
            });
        }

        // The role comes from the invitation or the domain policy — never from
        // users.role, and never defaulted to owner.
        const role = workspace.normalizeRole(admission.role);
        const membership = await workspace.addMember(targetOrg.org_id, userId, {
            role,
            invitedBy: invitation?.invited_by || null,
        });

        const inviteConsumed = invitation
            ? await workspace.markInviteAccepted(targetOrg.org_id, invitation.invite_id, userId).catch(() => false)
            : false;

        await invalidateOrgCache(targetOrg.org_id);

        // Same last step as redeeming an invite by token. Without it the person
        // is a member of the team and still WORKING IN their personal workspace:
        // their keys, their agent loop and their dashboard all stay where they
        // were, and the team they just joined looks empty. Best-effort by
        // design (it never moves somebody already working in another team).
        const activated = await workspace.activateJoinedWorkspace(targetOrg.org_id, userId);

        res.json({
            success: true,
            org_id: targetOrg.org_id,
            org_name: targetOrg.name,
            role: membership?.role || role,
            invite_consumed: inviteConsumed,
            activated,
        });
    } catch (err) {
        // Its last member is closing their account (workspaceService
        // markWorkspaceClosing): refused, not a server fault.
        if (err?.code === 'workspace_closing') {
            return res.status(409).json({ error: 'workspace_closing', message: err.message });
        }
        console.error('join org error:', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// An invite code is a reason somebody created an account, so it can only be
// applied while the account is being created — POST /auth/signup for credential
// signups, the Clerk account-created webhook for everyone else. Both of those
// run once, unauthenticated-by-construction, at the account's birth.
//
// This endpoint is neither: it is an authenticated handoff that any signed-in
// account can call at any time, as often as it likes. Accepting a code here let
// one person attach a colleague's — or their own sock puppet's — code to an
// existing account long after signup, which is half of how the programme could
// be farmed. It now refuses, by name, instead of quietly attributing.
const REFERRAL_SIGNUP_ONLY = Object.freeze({
    code: 'referral_signup_only',
    message: 'An invite code can only be applied while the account is being created. Sign up from the invite link to use it.',
});

// Legacy onboarding handoff endpoint for saving the selected account type, pending plan,
// and optional referral attribution before checkout or onboarding continues.
router.patch('/account-type', async (req, res) => {
    const orgId = req.actor.org_id;
    if (!orgId) return res.status(403).json({ error: 'forbidden' });
    // Self-serve onboarding handoff: the org OWNER sets their own workspace type
    // and pending plan. New individual signups are role 'owner' (auth.js), which
    // carries the same context:admin scope as 'admin' — gating on 'admin' alone
    // 403s every fresh signup here, breaking both "Continue free" and checkout.
    if (!['owner', 'admin'].includes(req.actor.role)) return res.status(403).json({ error: 'forbidden' });

    const { account_type } = req.body;
    const plan = req.body?.plan ? normalizePlanId(req.body.plan) : undefined;
    const referralCode = typeof req.body?.referral_code === 'string' ? req.body.referral_code : undefined;

    const VALID_ACCOUNT_TYPES = ['organization', 'personal'];
    if (account_type && !VALID_ACCOUNT_TYPES.includes(account_type)) {
        return res.status(400).json({ error: 'invalid_account_type' });
    }

    if (plan && !isSelfServePlan(plan)) {
        return res.status(400).json({ error: 'invalid_plan', message: 'Unsupported self-serve plan for this endpoint' });
    }

    // THE PENDING PLAN BELONGS TO THE WORKSPACE THAT IS ABOUT TO BE CHARGED.
    //
    // /checkout calls this immediately before POST /billing/checkout, and that
    // route bills the BOUND workspace (billingWorkspace). This one stamped
    // req.actor.org_id — always the personal org — so the founder of a
    // wizard-made team marked their PERSONAL account as "about to buy Team"
    // while Stripe charged the team. The webhook clears pending_plan on the org
    // it reconciles, which is the team, so the personal org's mark was never
    // cleared by anything.
    //
    // account_type is deliberately NOT moved: it describes the caller's own
    // account (the onboarding handoff above), and a teammate finishing
    // onboarding while switched into a shared workspace must not be able to
    // flip that workspace to 'personal'.
    const planWorkspace = plan ? moneyWorkspace(req) : null;
    if (plan && planWorkspace && planWorkspace !== orgId) {
        // Same gate as the checkout it precedes, so the refusal arrives here
        // with a reason rather than one request later.
        const owned = await requireMoneyOwner(req, res);
        if (!owned) return undefined;
    }

    try {
        const updates = [];
        const values = [];
        let idx = 1;
        const stampsOtherWorkspace = Boolean(plan && planWorkspace && planWorkspace !== orgId);

        if (account_type) { updates.push(`account_type = $${idx++}`); values.push(account_type); }
        if (plan && !stampsOtherWorkspace) { updates.push(`pending_plan = $${idx++}`); values.push(plan); }

        if (updates.length === 0 && !stampsOtherWorkspace && !referralCode) return res.status(400).json({ error: 'no_fields' });

        // A call carrying ONLY a code has nothing left to do once the code is
        // refused, so it is refused outright rather than answered with a
        // success that did nothing.
        const referralRefused = typeof referralCode === 'string' && referralCode.trim() ? REFERRAL_SIGNUP_ONLY : null;
        if (referralRefused && updates.length === 0 && !stampsOtherWorkspace) {
            return res.status(400).json({ error: referralRefused.code, message: referralRefused.message });
        }

        if (stampsOtherWorkspace) {
            await db.query(
                'UPDATE organizations SET pending_plan = $1 WHERE org_id = $2',
                [plan, planWorkspace],
                planWorkspace
            );
            await invalidateOrgCache(planWorkspace);
        }

        if (updates.length > 0) {
            values.push(orgId);
            await db.query(
                `UPDATE organizations SET ${updates.join(', ')} WHERE org_id = $${idx}`,
                values,
                orgId
            );
        }

        await invalidateOrgCache(orgId);

        res.json({
            success: true,
            pending_plan: plan || null,
            referral_recorded: false,
            // The account type/plan really were saved; the code was not applied.
            // Saying so is the difference between this and the silent no-op it
            // would otherwise be.
            ...(referralRefused ? { referral_refused: referralRefused } : {}),
        });
    } catch (err) {
        console.error('account-type update error:', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// Step-up confirmation for account deletion. A live session isn't enough for an
// irreversible wipe — the caller must re-prove identity. Password accounts verify
// the password (via Clerk for clerk identities, bcrypt for local); OAuth-only
// accounts (no password to type) confirm by typing their exact account email.
// Any ambiguity fails closed. Returns { ok } or { ok:false, status, code, message }.
async function verifyDeletionConfirmation(actorRow, { password, confirmEmail }) {
    const provider = actorRow.auth_provider;
    const email = String(actorRow.email || '');

    const hasPassword = provider === 'clerk' && isClerkConfigured()
        ? await clerkUserHasPassword(actorRow.auth_subject)
        : Boolean(actorRow.password_hash);

    if (hasPassword) {
        if (!password) {
            return { ok: false, status: 400, code: 'password_required', message: 'Enter your password to confirm deletion.' };
        }
        const verified = provider === 'clerk' && isClerkConfigured()
            ? await verifyClerkPassword(actorRow.auth_subject, password)
            : (actorRow.password_hash ? await verifyPassword(password, actorRow.password_hash) : false);
        if (!verified) {
            return { ok: false, status: 401, code: 'invalid_password', message: 'Incorrect password.' };
        }
        return { ok: true };
    }

    // No password credential (OAuth-only, or Clerk unconfigured locally): require
    // the account email typed exactly, so the action still takes a deliberate,
    // identity-specific confirmation rather than a bare click.
    const typed = String(confirmEmail || '').trim().toLowerCase();
    if (!typed || typed !== email.trim().toLowerCase()) {
        return { ok: false, status: 400, code: 'email_confirmation_required', message: 'Type your account email to confirm deletion.' };
    }
    return { ok: true };
}

// Email the full markdown context export to the account holder before their
// data is purged. Never throws; returns whether the email was actually sent, and
// the route refuses to delete anything when it was asked for and was not.
//
// SCOPED TO THE ORG BEING DELETED, NOT TO THE BOUND WORKSPACE.
//
// exportContext resolves its owner through workspaceService.defaultOwnerKey, which
// reads `actor.workspace_key` FIRST — and the auth middleware binds that on every
// request, from the header or, with no header at all, from the person's active
// workspace. So an invited teammate deleting their own account was emailed a full
// markdown export of the TEAM's profile, projects and knowledge graph, while the
// purge below erased only their own org. A courtesy on the way out became an
// exfiltration channel that needed no header, no flag and no privilege: leave the
// team, delete your account, receive the team's brain by email.
//
// The export must describe exactly what is about to be destroyed, so it is taken
// against orgId — the same key purgeOwnerData is given — with the bound workspace
// cleared rather than trusted.
//
// "THE LAST COPY WE HOLD" HAS TO BE TRUE OF THE ATTACHMENT.
//
// The Markdown used to carry the profile, each project's task and status, and
// graph node titles, from live projects only; the board, findings, known paths,
// decisions, archived projects, workspace entities and skills were in none of it
// and were erased moments later. The attachment now renders all of those. What
// it still does not carry is named in the email, because after this email there
// is nowhere left to look for it: the history behind the snapshot (context
// events, sessions, activity), the evidence lines saying where each graph entry
// came from (no longer conversation excerpts: journey scan round 3), and the
// layer DeerDawn computes from the data (embeddings,
// learned rankings and affinities) — the compounding layer exportContext has
// never carried.
//
// AND WHAT THE PURGE TAKES FROM OTHER PEOPLE'S WORKSPACES (journey scan round 2,
// R2-2). The person-keyed half of purgeOwnerData reaches into every other
// workspace the person was in, and three of the things it erases there are
// things the person WROTE and nobody else could read: their `personal` projects
// (erasePersonalProjectsElsewhere), their "you" profile in that workspace
// (PERSON_KEYED_DELETES context_globals_by_person) and the graph notes marked
// private to them (erasePrivateNodesElsewhere). The export above never saw any
// of them. They are carried now, and only they: each set is the one the purge
// selects (dataErasureService's list*Elsewhere), and each workspace is read AS
// THE PERSON bound to it, through exportContext with those sets, so the
// ordinary visibility filters apply and nothing else of the team — its shared
// and private projects, its workspace entities, the nodes a private note or a
// personal project links to (contextSyncService carriedProjectGraph) — is read
// into the copy. The rest of that half (their keys, their roster
// rows, access logs and product events) is credentials and telemetry, not
// anything they wrote, and the email's "activity history" already names it.
// A workspace that closes with the account (`closing`: every other workspace
// nobody but this person is in) is erased whole, and it IS attached (journey r5,
// the owner's decision on round 1's BLOCKED 9): each one is read as the person,
// whole, the way their own workspace is, and printed in a block of its own headed
// with the workspace's name, apart from everything else in the document
// (exportClosingWorkspaces). A workspace with other people in it never closes
// with the account, so it is neither erased nor attached: it stays with the team.
//
// `userId` is the person being erased: the purge finds them as the users row of
// orgId, which is the row this route loaded.
async function emailContextExport(actor, orgId, toEmail, { userId = null, closing = [] } = {}) {
    try {
        const bundle = await contextSyncService.exportContext({ ...actor, workspace_key: orgId, org_id: orgId });
        const elsewhere = await exportPersonalDataElsewhere(actor, orgId, userId, closing);
        if (elsewhere.length) bundle.other_workspaces = elsewhere;
        const closed = await exportClosingWorkspaces(actor, closing);
        if (closed.length) bundle.closed_workspaces = closed;
        const md = renderContextExportMarkdown(bundle);
        const result = await sendEmail({
            to: toEmail,
            subject: 'Your DeerDawn context export',
            html: contextExportEmailHtml(bundle, closing),
            attachments: [{ filename: 'deerdawn-context-export.md', content: Buffer.from(md, 'utf-8').toString('base64') }],
        });
        return result?.ok === true;
    } catch (err) {
        console.warn('[ORG-DELETE] context export email failed:', err.message);
        return false;
    }
}

// Every workspace that closes with the account, whole, one entry per workspace,
// for emailContextExport. Read as the person, bound to that workspace, through
// the same exportContext their own workspace goes through, so the same
// visibility rules apply and nothing is read that they could not read there. They
// are its only member, so that is all of it but the personal projects of somebody
// who was once in it, which are nobody's to read and are counted, not attached.
// Read before anything is erased; a failed read throws and the export is not
// sent rather than sent short. Sorted by name so the document does not depend on
// row order.
async function exportClosingWorkspaces(actor, closing) {
    const sections = [];
    for (const ws of closing || []) {
        const bundle = await contextSyncService.exportContext({ ...actor, workspace_key: ws.id, org_id: ws.id });
        const stored = await db.query(
            'SELECT COUNT(*)::int AS n FROM context_projects WHERE owner_key = $1',
            [ws.id],
            'org-system'
        );
        const read = (bundle.projects || []).length;
        sections.push({
            workspace_id: ws.id,
            workspace_name: ws.name || null,
            global_context: bundle.global_context,
            preferences: bundle.preferences,
            projects: bundle.projects,
            workspace_graph: bundle.workspace_graph,
            skills: bundle.skills,
            unreadable_projects: Math.max(0, (stored.rows[0]?.n || 0) - read),
        });
    }
    return sections.sort((a, b) => String(a.workspace_name || a.workspace_id).localeCompare(String(b.workspace_name || b.workspace_id)));
}

// What was the person's alone in other workspaces, one entry per workspace, for
// emailContextExport. Read before anything is erased, like the rest of the
// export; a failed read throws, and the export is not sent rather than sent
// short. Sorted by workspace name so the document does not depend on row order.
async function exportPersonalDataElsewhere(actor, orgId, userId, closing) {
    // Required here rather than destructured at the top: the rest of this file
    // takes only the purge from that module, and this is the one caller.
    const erasure = require('../../services/dataErasureService');
    // The renderer's own test for "a profile somebody wrote", so the email and
    // the attachment agree about whether one is there.
    const { profileWritten } = require('../../services/contextExportMarkdown');
    const people = { userIds: [userId] };
    const [projectRows, profileRows, noteRows] = await Promise.all([
        erasure.listPersonalProjectsElsewhere(orgId, people),
        erasure.listProfilesElsewhere(orgId, people),
        erasure.listPrivateNodesElsewhere(orgId, people),
    ]);
    // A workspace closing with the account is purged whole before the person-
    // keyed half runs, so none of its rows is reached by that half: they are
    // that workspace's, and they are not attached (see above).
    const closingKeys = new Set((closing || []).map((ws) => ws.id));
    const byWorkspace = new Map();
    const entry = (row) => {
        if (!row.owner_key || closingKeys.has(row.owner_key)) return null;
        if (!byWorkspace.has(row.owner_key)) byWorkspace.set(row.owner_key, { projectIds: [], profile: false, nodeIds: [] });
        return byWorkspace.get(row.owner_key);
    };
    for (const row of projectRows) entry(row)?.projectIds.push(row.project_id);
    for (const row of profileRows) { const found = entry(row); if (found) found.profile = true; }
    for (const row of noteRows) entry(row)?.nodeIds.push(row.node_id);
    if (!byWorkspace.size) return [];

    const names = new Map((await db.query(
        'SELECT org_id, name FROM organizations WHERE org_id = ANY($1)',
        [[...byWorkspace.keys()]],
        'org-system'
    )).rows.map((row) => [row.org_id, row.name]));

    const sections = [];
    for (const [workspaceKey, { projectIds, profile, nodeIds }] of byWorkspace) {
        // The person, bound to that workspace: the binding the auth middleware
        // gives them there. Not a system actor, and not a membership check
        // either — somebody removed from a team can still own a personal project
        // left in it, which only they could ever read and which is erased here.
        const part = await contextSyncService.exportContext(
            { ...actor, workspace_key: workspaceKey },
            { projectIds, profile, privateNodeIds: nodeIds }
        );
        const read = new Set(part.projects.map((project) => project.project_id));
        // A note already printed inside one of the carried projects' graphs is
        // carried; only one read nowhere is missing.
        const carried = new Set([
            ...part.private_nodes.map((node) => node.node_id),
            ...part.projects.flatMap((project) => project.graph.nodes.map((node) => node.node_id)),
        ]);
        const section = {
            workspace_id: workspaceKey,
            workspace_name: names.get(workspaceKey) || null,
            ...(profile && profileWritten(part.global_context) ? { profile: part.global_context } : {}),
            projects: part.projects,
            skills: part.skills,
            unreadable_projects: projectIds.filter((id) => !read.has(id)).length,
            private_notes: part.private_nodes,
            unreadable_private_notes: nodeIds.filter((id) => !carried.has(id)).length,
        };
        // A profile row with nothing written in it is the only way to get here
        // with nothing to carry and nothing missing; it adds no block.
        if (section.profile || section.projects.length || section.private_notes.length
            || section.unreadable_projects || section.unreadable_private_notes) {
            sections.push(section);
        }
    }
    return sections.sort((a, b) => String(a.workspace_name || a.workspace_id).localeCompare(String(b.workspace_name || b.workspace_id)));
}

// The deletion email, sentence by sentence true of the attachment it goes out
// with. A solo account's reads exactly as it always has; each addition appears
// only in the case it describes:
//   - what was carried from other workspaces (personal projects, the profile
//     there, private notes): which workspaces, and that those workspaces' own
//     projects are not attached;
//   - private notes carried, or a carried personal project linked to the rest
//     of its workspace's graph: that what they linked to is not;
//   - a project that could not be decrypted (its context is marked in the
//     attachment, and the purge destroys the ciphertext): how many, and the
//     copy is no longer called full;
//   - a personal project or private note elsewhere the person's own read could
//     not reach: how many are missing;
//   - a workspace that closes with the account: named, and said to be attached
//     under its own name, since it is erased with the account;
//   - a project of such a workspace that could not be opened (a personal project
//     of somebody who was once in it): how many are not attached.
function contextExportEmailHtml(bundle, closing = []) {
    const escape = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]
    ));
    const join = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
    const list = (names) => join(names.map(escape));
    const nameOf = (ws) => ws.workspace_name || ws.workspace_id;
    const sum = (items, pick) => items.reduce((n, item) => n + pick(item), 0);
    const others = bundle.other_workspaces || [];
    const closed = bundle.closed_workspaces || [];
    const carriedFrom = others.filter((ws) => ws.profile || (ws.projects || []).length || (ws.private_notes || []).length);
    const projects = sum(others, (ws) => (ws.projects || []).length);
    const profiles = others.filter((ws) => ws.profile).length;
    const notedIn = others.filter((ws) => (ws.private_notes || []).length);
    const notes = sum(notedIn, (ws) => ws.private_notes.length);
    // Carried personal projects whose links to the rest of their workspace's
    // graph were left out (contextSyncService carriedProjectGraph).
    const linking = (ws) => (ws.projects || []).filter((project) => Number(project?.graph?.links_left_out) > 0).length;
    const linkingProjects = sum(others, linking);
    const unreadableProjects = sum(others, (ws) => ws.unreadable_projects || 0);
    const unreadableNotes = sum(others, (ws) => ws.unreadable_private_notes || 0);
    const undecryptable = [...(bundle.projects || []), ...others.flatMap((ws) => ws.projects || []), ...closed.flatMap((ws) => ws.projects || [])]
        .filter((project) => project?.context?._decrypt_error).length;
    // A closing workspace's projects that nobody could open, by workspace.
    const closedUnreadable = closed.filter((ws) => (ws.unreadable_projects || 0) > 0);
    const closedUnreadableCount = sum(closedUnreadable, (ws) => ws.unreadable_projects);
    // A workspace that closes with the account and is missing from the bundle
    // (it cannot be: a failed read stops the export) would still be missing.
    const closedMissing = (closing || []).filter((ws) => !closed.some((c) => c.workspace_id === ws.id));
    const missing = undecryptable > 0 || unreadableProjects > 0 || unreadableNotes > 0 || closedUnreadableCount > 0 || closedMissing.length > 0;
    const otherWorkspaces = others.length > 0 || closed.length > 0 || closedMissing.length > 0;

    let first = `As requested before deleting your account, attached is a ${missing ? '' : 'full '}Markdown export of your DeerDawn context — your profile, every project ${otherWorkspaces ? 'in your own workspace ' : ''}including archived ones, their task boards, notes and knowledge graph, and your skills.`;
    if (carriedFrom.length) {
        const one = carriedFrom.length === 1;
        const parts = [
            projects && (projects === 1 ? 'the personal project' : `the ${projects} personal projects`),
            profiles && (profiles === 1 ? 'your profile' : `your ${profiles} profiles`),
            notes && (notes === 1 ? 'a private note' : `${notes} private notes`),
        ].filter(Boolean);
        first += ` It also carries ${join(parts)} you kept in ${list(carriedFrom.map(nameOf))}, ${one ? 'under that workspace\'s name; that workspace\'s shared and private projects stay with it' : 'each under the name of its workspace; the shared and private projects of those workspaces stay with them'} and are not attached.`;
    }
    if (undecryptable) {
        first += ` ${undecryptable === 1 ? 'One project' : `${undecryptable} projects`} could not be decrypted, so ${undecryptable === 1 ? 'its' : 'their'} context is missing from the attachment and will be erased with the rest.`;
    }

    let second = 'It is a copy of what was stored, so it leaves out the edit, session and activity history behind it, the notes on where your knowledge graph came from, and the search indexes and rankings DeerDawn computes from your data.';
    if (unreadableProjects || unreadableNotes) {
        const parts = [
            unreadableProjects && (unreadableProjects === 1 ? 'one of your personal projects' : `${unreadableProjects} of your personal projects`),
            unreadableNotes && (unreadableNotes === 1 ? 'one of your private notes' : `${unreadableNotes} of your private notes`),
        ].filter(Boolean);
        second += ` It also leaves out ${join(parts)} in other workspaces, which could not be read.`;
    }
    if (notes || linkingProjects) {
        // Only each note's own words travel, and only each personal project's own
        // graph: what they pointed at is the team's.
        const from = [
            linkingProjects && (linkingProjects === projects
                ? (projects === 1 ? 'your personal project' : 'your personal projects')
                : (linkingProjects === 1 ? 'one of your personal projects' : `${linkingProjects} of your personal projects`)),
            notes && `your private ${notes === 1 ? 'note' : 'notes'}`,
        ].filter(Boolean);
        const linkedIn = others.filter((ws) => (ws.private_notes || []).length || linking(ws));
        second += ` It also leaves out the links from ${join(from)} to the rest of the knowledge graph in ${list(linkedIn.map(nameOf))}.`;
    }
    if (closed.length) {
        const one = closed.length === 1;
        first += ` It also carries ${one ? 'the workspace' : 'the workspaces'} ${list(closed.map(nameOf))}, which ${one ? 'closes' : 'close'} with your account because nobody else is in ${one ? 'it' : 'them'}: ${one ? 'its profile' : 'their profiles'}, projects, task boards, notes, knowledge graph and skills are attached${one ? '' : ', each'} under ${one ? 'that workspace\'s name' : 'the name of its workspace'}, and will be erased with the account.`;
    }
    if (closedUnreadableCount) {
        second += ` It leaves out ${closedUnreadableCount === 1 ? 'one project' : `${closedUnreadableCount} projects`} of ${list(closedUnreadable.map(nameOf))} that belonged to somebody who was once in ${closedUnreadable.length === 1 ? 'it' : 'them'} and that you could not open.`;
    }
    if (closedMissing.length) {
        const one = closedMissing.length === 1;
        second += ` It does not include ${one ? 'the workspace' : 'the workspaces'} ${list(closedMissing.map((ws) => ws.name || ws.id))}, which ${one ? 'closes' : 'close'} with your account because nobody else is in ${one ? 'it: its' : 'them: their'} projects will be erased with ${one ? 'it' : 'them'} and are not attached.`;
    }

    return `<p>${first}</p><p>${second}</p><p>This is a copy of your data, made just before deletion. Once your account is deleted, it is the last copy we hold.</p>`;
}

// ── TWO ROUTES ARE CALLED "DELETE MY ACCOUNT". THEY ARE NOT THE SAME ACTION. ──
//
//   DELETE /api/v1/orgs                (this one)      CLOSES THE ACCOUNT.
//   DELETE /api/v1/context/account     (context-sync)  EMPTIES A WORKSPACE.
//
// Both erase DATA through the same service, services/dataErasureService.js
// purgeOwnerData, so "erased" means one set of tables whichever is called. They
// differ in three deliberate ways, and only in these:
//
//                        this route                  /context/account
//   which workspace      req.actor.org_id: the       workspace.defaultOwnerKey:
//                        person's OWN org, always —  the BOUND workspace, which
//                        plus every workspace        for a teammate is the team
//                        nobody else is left in
//   confirmation         step-up: password, or the   a fixed phrase in the body
//                        account email typed out
//   the account shell    DELETED: users rows, the    KEPT: the person can still
//                        organizations row, and      sign in, to an empty
//                        every Clerk identity        workspace
//
// Authorization is the same on both and is not this comment's business to
// change: a workspace OWNER (workspace role, not org role), and never while the
// workspace has other members.
//
// If you add a table that holds a customer's data, add it to purgeOwnerData and
// to nowhere else. The inline list that used to live in this handler is how the
// other route came to report a complete erasure while leaving the audit trail,
// decisions and policies behind.
router.delete('/', async (req, res) => {
    const orgId = req.actor.org_id;

    // AUTHZ-001 made self-provisioned account holders 'owner' (never platform
    // 'admin'), and 'owner'/'admin' carry identical org scopes. Gating solely on
    // 'admin' locked the real owner out of deleting their own account (the
    // "Failed to delete account" report). Allow the org owner or a legacy admin.
    if (req.actor.role !== 'owner' && req.actor.role !== 'admin') {
        return res.status(403).json({ error: 'forbidden' });
    }
    if (!orgId) return res.status(400).json({ error: 'no_org_context' });

    // THE SAME TWO GATES DELETE /api/v1/context/account CARRIES, AND FOR THE SAME
    // REASON. req.actor.role is the ORG-level role on the users row, 'admin' by
    // default for nearly every self-signup, so the check above separated almost
    // nobody from anybody. That is survivable while users.org_id is always a
    // personal org — and it is not: the legacy invite path in this very file
    // creates users directly INSIDE the target org, so for that population orgId
    // IS the team, and this route deletes the organizations row, every user in it
    // and every Clerk identity attached.
    //
    // 1. The workspace role, not the org role, decides who may administer it.
    const workspaceRole = await workspace.resolveRole(req.actor, orgId).catch(() => null);
    if (!workspace.canAdminister(workspaceRole)) {
        return res.status(403).json({
            error: 'forbidden',
            message: 'Only a workspace owner can delete its data.',
        });
    }
    // 2. Even an owner does not destroy other people's work through a route called
    // "delete my account". Deleting a shared workspace is a different decision,
    // taken deliberately after the other members are removed.
    if (await workspace.isSharedWorkspace(orgId).catch(() => false)) {
        return res.status(409).json({
            error: 'workspace_has_members',
            message: 'This workspace has other members. Remove them first, or leave the workspace instead of deleting it.',
        });
    }
    // 3. Nor does closing the account orphan a TEAM this person owns alone.
    // The erasure removes their memberships everywhere, so the sole owner of
    // a team with other people in it left that team with no owner at all — and
    // a live subscription nobody could reach the billing portal to cancel. Hand
    // it over (or empty it) first. The Clerk user.deleted webhook is an erasure
    // request and is not refusable; this route is a choice and can wait.
    const soleOwned = await workspace.listSoleOwnedTeams(workspace.actorIdentities(req.actor));
    if (soleOwned.length) {
        return res.status(409).json(workspace.soleOwnerConflict(soleOwned));
    }

    const { password, confirm_email: confirmEmail, email_export: emailExport } = req.body || {};

    // Load the actor's identity + credential for step-up confirmation.
    let actorRow;
    try {
        const r = await db.query(
            'SELECT user_id, email, auth_provider, auth_subject, password_hash FROM users WHERE user_id = $1 AND org_id = $2',
            [req.actor.id, orgId],
            orgId,
        );
        actorRow = r.rows[0];
    } catch (err) {
        console.error('Org Deletion preflight error:', err);
        return res.status(500).json({ error: 'internal_error' });
    }
    if (!actorRow) return res.status(404).json({ error: 'user_not_found' });

    const confirmation = await verifyDeletionConfirmation(actorRow, { password, confirmEmail });
    if (!confirmation.ok) {
        return res.status(confirmation.status).json({ error: confirmation.code, code: confirmation.code, message: confirmation.message });
    }

    // 4. AND EVERY OTHER WORKSPACE NOBODY BUT THIS PERSON IS LEFT IN CLOSES WITH
    // IT. Gate 3 covers the teams that still have other people in them; this is
    // the opposite case. A second workspace (POST /teams/workspaces) that
    // everybody else has left used to survive the close with its org row, its
    // projects and graph and a LIVE SUBSCRIPTION, on a roster holding nothing
    // but tombstones — nobody left who could reach its billing portal to cancel
    // it, or even see it. Each one goes through the home org's own sequence:
    // billing cancelled first (below), then re-home, purge and org row in the
    // same transaction. See workspaceService.listSoleMemberWorkspaces.
    const identities = workspace.actorIdentities(req.actor);
    let alsoClosing;
    try {
        alsoClosing = await workspace.listSoleMemberWorkspaces(identities, { exclude: [orgId] });
    } catch (err) {
        console.error('Org Deletion preflight error (sole-member workspaces):', err);
        return res.status(500).json({ error: 'internal_error' });
    }

    // 5. THE PERSON WHO PAYS FOR A WORKSPACE THAT SURVIVES THIS DELETION cannot
    // walk away from a subscription that renews on their card (journey r6; the
    // owner's decision, "block until billing moves"). Every workspace they belong
    // to except the ones closing with the account (which are cancelled below, as
    // before): refused with nothing deleted, exported or cancelled, until another
    // owner has taken billing over or the subscription is set to end. A billing
    // owner that is not recorded refuses nobody; a Stripe that cannot be read
    // answers 503 and changes nothing.
    try {
        const person = workspace.actorPersonId(req.actor);
        const candidates = await billingOwner.listPayerCandidates(person, {
            exclude: [orgId, ...alsoClosing.map((ws) => ws.id)],
        });
        const block = await billingOwner.findBlockingWorkspace(person, candidates);
        if (block) return billingOwner.sendRefusal(res, 'delete_account', block);
    } catch (err) {
        if (err instanceof billingOwner.BillingOwnerUnconfirmed) return billingOwner.sendUnconfirmed(res);
        console.error('Org Deletion preflight error (billing owner):', err);
        return res.status(500).json({ error: 'internal_error' });
    }

    // THE DOORS SHUT BEFORE ANY BILLING IS CANCELLED. Each workspace closing
    // with the account is marked closing under its membership lock, after a
    // re-check that nobody else is in it; from then on no join can land
    // (addMember refuses a marked workspace under the same lock). Cancelling
    // first left a window in which somebody joined, the close aborted with a
    // 409, and a live team survived with its subscription already cancelled —
    // and every retry refused as sole_owner (scan 28). A workspace somebody got
    // into since it was listed stops the close here, with nothing cancelled.
    // Every exit that does not close them clears the marks (releaseClosing).
    const marked = [];
    const releaseClosing = () => workspace.clearWorkspaceClosing(marked.map((ws) => ws.id)).catch((err) => {
        // A mark left behind expires on its own (WORKSPACE_CLOSING_TTL_MINUTES).
        console.warn('[ORG-DELETE] could not clear closing marks:', err?.message || err);
    });
    try {
        for (const ws of alsoClosing) {
            if (!(await workspace.markWorkspaceClosing(ws.id, identities))) {
                await releaseClosing();
                return res.status(409).json({
                    error: 'workspace_has_members',
                    workspace: ws.id,
                    message: `Somebody joined ${ws.name || 'one of your workspaces'} while your account was closing, so nothing was deleted and no subscription was cancelled. Try again.`,
                });
            }
            marked.push(ws);
        }
    } catch (err) {
        await releaseClosing();
        console.error('Org Deletion preflight error (closing marks):', err);
        return res.status(500).json({ error: 'internal_error' });
    }

    // THE EXPORT COMES BEFORE ANYTHING IS CANCELLED OR ERASED, AND IT MUST GO.
    // Journey r5, the owner's decision on round 1's BLOCKED 9: when the person
    // asked for the export (`email_export`) and it was not sent, nothing is
    // deleted. It used to be best-effort ("never blocks the deletion"), and the
    // email calls itself the last copy we hold. Taken before billing so that a
    // failed send costs nothing: no subscription is cancelled, the closing marks
    // are released, and a retry starts clean. Not asking for it changes nothing.
    let exportEmailed = false;
    // The export is emailed before anything is deleted and says nothing has been:
    // when the deletion then stops, the reply says the copy is only a copy.
    const exportNote = () => (exportEmailed ? ' The export we emailed you is only a copy: your account is intact.' : '');
    if (emailExport) {
        exportEmailed = await emailContextExport(req.actor, orgId, actorRow.email, { userId: actorRow.user_id, closing: alsoClosing });
        if (!exportEmailed) {
            await releaseClosing();
            return res.status(502).json({
                error: 'export_not_sent',
                retryable: true,
                message: 'Your export could not be emailed, so nothing was deleted. Try again, or turn off the export option to delete without one.',
            });
        }
    }

    // BILLING FIRST, AND ABORT ON FAILURE — same contract as DELETE /account.
    // This route goes further than the data purge (it deletes the organizations
    // row and the Clerk identities), which made the old gap worse: with the org
    // row gone, even Stripe's own webhooks could no longer find anything to
    // reconcile, and the subscription billed a customer that had ceased to
    // exist anywhere but Stripe.
    const billing = await cancelSubscriptionForDeletion(orgId);
    if (!billing.ok) {
        console.error('[ORG-DELETE] refusing to delete: subscription cancel failed:', billing.reason);
        await releaseClosing();
        return res.status(502).json({
            error: 'billing_cancellation_failed',
            ...(exportEmailed ? { export_emailed: true } : {}),
            message: `Your subscription could not be cancelled, so nothing was deleted. Try again, or cancel the subscription from Billing first.${exportNote()}`,
        });
    }
    // The same contract for every workspace closing with the account: a
    // subscription that cannot be cancelled stops the close, nothing is
    // deleted, and a retry is safe (already-cancelled counts as success).
    for (const ws of alsoClosing) {
        const wsBilling = await cancelSubscriptionForDeletion(ws.id);
        if (!wsBilling.ok) {
            console.error(`[ORG-DELETE] refusing to delete: subscription cancel failed for ${ws.id}:`, wsBilling.reason);
            await releaseClosing();
            return res.status(502).json({
                error: 'billing_cancellation_failed',
                workspace: ws.id,
                ...(exportEmailed ? { export_emailed: true } : {}),
                message: `The subscription of ${ws.name || ws.id} could not be cancelled, so nothing was deleted. Try again, or cancel that workspace's subscription from Billing first.${exportNote()}`,
            });
        }
    }

    // The Clerk identities to hard-delete after the DB wipe — otherwise the
    // "deleted" account keeps a live Clerk login that can sign right back in.
    // Read from the rows this route actually deletes (below), never "every
    // users row pointing at this org": see rehomeResidentsBeforeClose.
    let clerkSubjects = [];
    let rehomed = [];

    const client = await db.pool.connect();
    let erasure = null;
    const closedErasures = [];
    try {
        await client.query('BEGIN');
        await client.query('SELECT set_config(\'app.current_org_id\', $1, true)', [orgId]);

        // The other workspaces first: their roster rows go with them, so the
        // home purge's person-keyed half below neither reports them as left
        // "ownerless" nor lists them as teams the person was taken off.
        for (const ws of alsoClosing) {
            const closed = await closeWorkspaceInTransaction(client, ws.id, { identities });
            closedErasures.push(closed.erasure);
        }

        // ONE ACCOUNT, THE CALLER'S. Anybody else whose users.org_id still names
        // this org (the legacy invite path created people inside it; the gates
        // above count only ACTIVE members, so a member it had removed passes
        // them) is moved into a fresh workspace of their own FIRST, inside this
        // transaction. Otherwise the users sweep deleted their account and
        // purgeOwnerData — which finds "the people being erased" by org_id —
        // erased their memberships, keys and personal projects everywhere else.
        rehomed = await workspace.rehomeResidentsBeforeClose(client, orgId, actorRow.user_id);

        // Erase context-sync data in the same transaction as the account shell,
        // including OAuth/API tokens, encrypted integrations, and embeddings.
        erasure = await purgeOwnerData(orgId, {
            strict: true,
            query: (text, params) => client.query(text, params),
            // Nothing irreversible until this transaction has committed. See
            // purgeOwnerData: revoking sessions and erasing the analytics
            // identity from inside an uncommitted transaction left a rolled-back,
            // fully intact account signed out and forgotten.
            deferSideEffects: true,
        });

        // The org's records (audit trail, decisions, policies, keys,
        // integrations, inquiries) used to be deleted here, inline, as a second
        // list that only THIS route ran. They are in purgeOwnerData now, so the
        // other delete route and the Clerk webhook erase them too, and there is
        // one list to keep right instead of two that drift. `strict: true`
        // above means a table that failed to clear has already thrown.
        //
        // What is left is the ACCOUNT SHELL, which is this route's alone — and
        // only the caller's: everybody else was re-homed above.
        const gone = await client.query(
            'DELETE FROM users WHERE user_id = $1 AND org_id = $2 RETURNING auth_provider, auth_subject',
            [actorRow.user_id, orgId]
        );
        clerkSubjects = (gone.rows || [])
            .filter((row) => row.auth_provider === 'clerk' && row.auth_subject)
            .map((row) => row.auth_subject);
        const result = await client.query('DELETE FROM organizations WHERE org_id = $1', [orgId]);

        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            await releaseClosing();
            return res.status(404).json({ error: 'org_not_found' });
        }

        await client.query('COMMIT');
        if (rehomed.length) {
            console.info(`[ORG-DELETE] ${orgId}: re-homed ${rehomed.length} other account(s) that still pointed at it`);
        }
    } catch (err) {
        await client.query('ROLLBACK');
        await releaseClosing();
        if (err?.code === 'workspace_membership_changed') {
            // The closing mark shuts every door addMember guards, so this is a
            // way in that does not go through it (or a mark that went stale).
            // Nothing is deleted — but billing WAS cancelled above, and a reply
            // that said only "try again" hid that the workspace that survived
            // no longer has a subscription (scan 28).
            const survivor = alsoClosing.find((ws) => ws.id === err.workspace);
            return res.status(409).json({
                error: 'workspace_has_members',
                workspace: err.workspace,
                subscription_cancelled: true,
                ...(exportEmailed ? { export_emailed: true } : {}),
                message: `Somebody joined ${survivor?.name || 'one of your workspaces'} while your account was closing, so nothing was deleted. Its subscription, and your own, had already been cancelled: resubscribe from Billing if the workspace is staying.${exportNote()}`,
            });
        }
        console.error('Org Deletion Error:', err);
        return res.status(500).json({
            error: 'internal_error',
            ...(exportEmailed ? { export_emailed: true, message: `Your account could not be deleted, and nothing was deleted.${exportNote()}` } : {}),
        });
    } finally {
        client.release();
    }

    // The data is gone for good now, so end what outlives it: cached API keys,
    // Redis refresh tokens, the analytics identity. Best-effort — the erasure has
    // committed and must be reported as done whatever happens here.
    for (const done of [...closedErasures, erasure]) {
        if (!done?.runSideEffects) continue;
        await done.runSideEffects().catch((err) => {
            console.warn('[ORG-DELETE] post-commit erasure side effects failed:', err.message);
        });
    }

    // Hard-delete the Clerk identities so the account can't sign back in. After
    // the DB commit, so a Clerk API hiccup can't leave the DB half-deleted; the
    // user.deleted webhook is idempotent if it also fires. Best-effort per id.
    for (const subject of clerkSubjects) {
        try {
            await deleteClerkUser(subject);
        } catch (err) {
            console.warn(`[ORG-DELETE] Clerk identity ${subject} delete failed:`, err.message);
        }
    }

    return res.json({
        success: true,
        export_emailed: exportEmailed,
        // Every workspace that closed WITH the account because nobody else was
        // left in it. Named, because the person may not remember it existed.
        closed_workspaces: alsoClosing.map((ws) => ({ workspace: ws.id, name: ws.name })),
        message: alsoClosing.length
            ? `Account and all associated data deleted, along with ${alsoClosing.length} other workspace${alsoClosing.length === 1 ? '' : 's'} only you belonged to.`
            : 'Account and all associated data deleted.',
    });
});

module.exports = router;
