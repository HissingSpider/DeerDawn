// ENF-01: wire the plan-enforcement gate that was previously dead code.
//
// checkEnforcement() is the only place that reads organizations.is_locked and gates on an
// inactive subscription_status, but nothing ever called it — it was referenced solely by its
// own export and three unit tests. The practical effect: webhooks-stripe.js sets
// a lock on charge.dispute.funds_withdrawn ("money is gone and the org may be
// fraudulent"), and that flag did nothing. (The dispute lock is now its own column,
// organizations.dispute_lock_ids; is_locked is the owner's own lockdown switch.) Existing API keys and sessions kept full access
// indefinitely; only issuing a NEW key was blocked (routes/shared/keys.js).
//
// This runs from authenticate() in middleware/auth.js — the single point where req.actor
// becomes known — so coverage cannot drift as routers are added.
//
// Scope is deliberate. EXEMPT_PREFIXES below are NOT gated, because locking a delinquent
// customer out of billing/settings/sign-in would trap them: they could never reach the page
// that lets them pay. Everything else authenticated (context sync, MCP, keys, teams) is gated.
//
// Failure policy: an explicit deny blocks. An unexpected error (Redis down, DB blip) fails
// OPEN and logs — this is a billing-integrity control, not a security boundary, and taking
// the product down on a cache outage is worse than briefly serving an org that owes money.
// Org state is cached for 5 minutes, so this adds no per-request DB round-trip in the
// steady state.

const { checkEnforcement } = require('../services/enforcementService');
const workspace = require('../services/workspaceService');
const { LOCK_MESSAGES } = require('../services/lockReasons');

// Matched against req.originalUrl (authenticate() runs inside mounted routers, so req.path
// is already stripped of the mount prefix — see the auditAccess bug for the same trap).
const EXEMPT_PREFIXES = [
    '/api/v1/billing',      // must stay reachable to fix a card / re-subscribe
    '/api/v1/auth',         // sign-in, sign-out, session handoff
    '/api/v1/orgs',         // org settings, account deletion
    '/api/v1/dashboard',    // renders the "subscription inactive" state itself
    // Credential management is a containment action, not a product feature. Revoking a
    // leaked key must never depend on billing status — gating it would mean a customer
    // whose card expired cannot respond to a compromise, and would partially undo the
    // fix that let org owners revoke their own keys in the first place.
    '/api/v1/keys',
    // OAuth consent approval only mints an authorization code for the signed-in
    // person. Gating it turned a lapsed card into a generic "approve_failed" on the
    // consent screen, a dead end with no path to billing. Connecting is not the paid
    // action: every tool call the resulting token makes is still gated here, on /mcp.
    '/api/v1/oauth/approve',
    '/api/v1/onboarding',
    '/api/v1/product-events',
    '/api/v1/public',
    '/api/v1/webhooks',
    '/api/v1/internal/logs',
];

// A REFUSAL WITH NO EXIT IS A TRAP.
//
// EXEMPT_PREFIXES above keeps a delinquent customer able to reach the page that
// lets them pay. These are the same idea one level down, for the routes a whole
// PREFIX would be too coarse to exempt. They matter because the bound workspace
// is not always the caller's own: a teammate invited into a Team whose card
// lapsed had every request gated on somebody else's billing, including the
// switcher that is their only way out, and the owner could not even see who
// held the seats she was being billed for.
//
// Matched as METHOD plus full path on req.originalUrl (authenticate() runs
// inside mounted routers, so req.path is already stripped of the prefix), so a
// future router cannot inherit an exemption by naming a route '/active'.
const EXEMPT_ROUTES = [
    // Where may I go instead, and go there. The switcher is the only exit from a
    // workspace whose subscription somebody else stopped paying for.
    ['GET', /^\/api\/v1\/teams\/workspaces\/?(\?|$)/],
    ['GET', /^\/api\/v1\/teams\/active\/?(\?|$)/],
    ['POST', /^\/api\/v1\/teams\/active\/?(\?|$)/],
    // What an owner needs to recover: see who holds the seats she is billed for,
    // and shed one. Billing itself is already exempt by prefix.
    ['GET', /^\/api\/v1\/teams\/members\/?(\?|$)/],
    ['DELETE', /^\/api\/v1\/teams\/members\/[^/?]+\/?(\?|$)/],
    // THE AI TOOLS A COLLEAGUE CONNECTED TO THIS WORKSPACE ARE ACCESS SHE IS
    // ACCOUNTABLE FOR, and a lapsed team is exactly when she needs to see and cut
    // it: the same recovery as the roster. The router admits only an owner
    // (ownerOfBoundWorkspace, behind ensureRosterRecoveryAccess).
    ['GET', /^\/api\/v1\/teams\/connections\/?(\?|$)/],
    ['DELETE', /^\/api\/v1\/teams\/connections\/[^/?]+\/?(\?|$)/],
    // AN INVITATION NOBODY HAS ACCEPTED IS STILL A SEAT SHE IS BILLED FOR.
    //
    // Pending invites count toward the seat floor — deliberately, or the cap
    // would be evaded by sending them all at once — so taking one back is how
    // an owner shrinks the team to what she will pay for. The router already
    // admits her: DELETE /invites/:id is written behind
    // ensureRosterRecoveryAccess, the same gate as the two routes above. This
    // gate runs first, so the one action that lowers her bill answered 403
    // subscription_inactive and the invitation went on counting. The pending
    // invitations are listed by GET /members above, so there is no separate
    // listing route to exempt.
    ['DELETE', /^\/api\/v1\/teams\/invites\/[^/?]+\/?(\?|$)/],
    // Her own data, on the way out. Read-only, and already scoped to the
    // workspace the request is bound to.
    ['GET', /^\/api\/v1\/context\/export\/?(\?|$)/],
    // JOINING A HEALTHY TEAM IS NOT A PAID ACTION IN THE WORKSPACE YOU ARE IN.
    //
    // The accept handler resolves everything from the invitation token and the
    // person: the workspace it writes to is the INVITE's, and acceptInvite
    // re-checks THAT workspace's plan and seats itself. The bound workspace is
    // never read. Gating on it meant a dashboard whose saved workspace was a
    // lapsed team got 403 subscription_inactive when joining a paying team, and
    // somebody whose own personal org was past_due could accept no invitation
    // at all. (auth.js also leaves this route unbound — see
    // WORKSPACE_INDEPENDENT_ROUTES there.)
    ['POST', /^\/api\/v1\/teams\/invite\/accept\/?(\?|$)/],
    // THE DOMAIN DOOR IS THE SAME DOOR. Listing the offers reads only the
    // person's email domain and their own memberships; accepting one writes to
    // the OFFER's workspace, whose plan and seats the handler checks itself
    // (ensureTeamAccessFor + checkLimit on offer.workspace). Neither reads the
    // bound workspace, so a past_due personal org or a lapsed team in the header
    // must not stop somebody joining their company's healthy one — the same
    // reasoning as invite/accept above, which was exempted while this was not.
    ['GET', /^\/api\/v1\/teams\/joinable\/?(\?|$)/],
    ['POST', /^\/api\/v1\/teams\/joinable\/[^/?]+\/accept\/?(\?|$)/],
    // ERASURE IS THE EXIT OF LAST RESORT, and a lapsed card must not lock it.
    // auth.js's FALLBACK_WRITE_EXEMPT_ROUTES already names it that, and the
    // dashboard's /security page calls it; DELETE /api/v1/orgs is reachable
    // through the prefix above and this was not. The handler's own gates —
    // workspace owner, no other members, typed confirmation, subscription
    // cancelled before anything is purged — all still apply.
    ['DELETE', /^\/api\/v1\/context\/account\/?(\?|$)/],
];

function isExempt(req) {
    const url = req.originalUrl || req.url || '';
    if (EXEMPT_PREFIXES.some((prefix) => url.startsWith(prefix))) return true;
    const method = (req.method || 'GET').toUpperCase();
    return EXEMPT_ROUTES.some(([verb, pattern]) => verb === method && pattern.test(url));
}

/**
 * Returns null when the request may proceed, or a {status, body} deny descriptor.
 * Never throws — callers treat a thrown/unknown condition as allowed.
 */
async function evaluatePlanEnforcement(req) {
    const actor = req.actor;

    // System key is an infra credential, not a tenant.
    if (!actor || actor.type === 'system') return null;

    // The BOUND workspace (bindWorkspace has already run), not the org the person
    // signed up under. Reading actor.org_id 403'd a teammate out of a paying team
    // because their own personal org was past_due, and let a lapsed team through
    // for anyone whose personal org was healthy.
    if (!actor.workspace_key && !actor.org_id) return null;
    const orgId = workspace.defaultOwnerKey(actor);
    if (!orgId || orgId === 'org-system') return null;
    if (isExempt(req)) return null;

    let result;
    try {
        result = await checkEnforcement(orgId);
    } catch (err) {
        console.error(`[ENFORCE] check failed for org ${orgId} — failing open:`, err.message);
        return null;
    }

    if (!result || result.allowed !== false) return null;

    if (result.error === 'lockdown_active') {
        // WHO IS READING decides which sentence is true. The locked workspace's
        // owners are told why and what they can do; anybody else is reading a
        // workspace that is not theirs, and the only thing they can do is leave
        // it (lockReasons.js). A lookup that fails reads as an owner: the
        // sentence about lockdown or a dispute is true of the workspace whoever
        // is asking.
        let lockReason = result.lock_reason || 'lockdown';
        try {
            const foreign = actor.org_id && orgId !== actor.org_id
                && !workspace.canAdminister(await workspace.resolveRole(actor, orgId));
            if (foreign) lockReason = 'foreign_workspace';
        } catch (err) {
            console.error(`[ENFORCE] role lookup failed for org ${orgId}:`, err.message);
        }
        return {
            status: 403,
            body: {
                error: result.error,
                lock_reason: lockReason,
                message: LOCK_MESSAGES[lockReason],
                upgrade_required: Boolean(result.upgrade_required),
            },
        };
    }

    if (result.error === 'plan_required') {
        // A new hosted account created while the free tier for new signups was
        // switched off (config/plans.js). Nothing lapsed: there is no plan yet.
        // Name the page, because the reader is often an AI tool relaying this to
        // somebody who never opened the dashboard.
        const dashboardUrl = String(process.env.DASHBOARD_URL || 'https://app.deerdawn.com').replace(/\/+$/, '');
        return {
            status: 403,
            body: {
                error: 'plan_required',
                message: `Choose a DeerDawn plan to start using this account: ${dashboardUrl}/select-plan`,
                subscription_status: result.subscription_status,
                plan_url: `${dashboardUrl}/select-plan`,
                upgrade_required: true,
            },
        };
    }

    const body = {
        error: result.error,
        message: 'Your subscription is not active. Update billing to restore access.',
        upgrade_required: Boolean(result.upgrade_required),
    };
    if (result.retry_checkout) {
        // The first payment never went through: the way out is checking out
        // again for the same plan, and only an owner can (the billing routes
        // refuse anybody else).
        body.message = 'The first payment for this subscription did not go through. Check out again to finish setting it up.';
        body.subscription_status = result.subscription_status;
        body.retry_checkout = result.retry_checkout;
    }
    return { status: 403, body };
}

module.exports = { evaluatePlanEnforcement, EXEMPT_PREFIXES, EXEMPT_ROUTES };
