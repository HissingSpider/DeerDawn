const { newSignupPlanState } = require('../config/plans');
const crypto = require('crypto');
const db = require('../config/db');
const { hashApiKey, verifyToken } = require('../utils/security');
const { API_KEY } = require('../config/env');
const apiKeyCache = require('../services/apiKeyCache');
const { reportSwallowed } = require('../utils/reportSwallowed');
const { primaryClerkEmail } = require('../utils/clerkEmail');
const { createClerkClient, verifyToken: verifyClerkToken } = require('@clerk/backend');
const { logAuthError } = require('../routes/debug');
const { normalizeMcpResource, mcpResourceForRequest } = require('../config/mcpResource');

// Org-scoped role taxonomy: read-only < member < owner. 'admin'/'operator'/'approver'
// are retained for backward compatibility (existing rows + api-key actors); 'admin' is
// no longer a global wildcard (see requireRole) and is treated as an org-scoped role.
const VALID_ROLES = new Set(['owner', 'member', 'read-only', 'admin', 'operator', 'approver']);

// Scopes are DERIVED from role — tenant actors never receive a wildcard scope.
// Only the internal system key (an infra credential, not a tenant) keeps ['*'].
const ROLE_SCOPES = {
    owner: ['context:read', 'context:write', 'context:admin', 'decisions:evaluate'],
    admin: ['context:read', 'context:write', 'context:admin', 'decisions:evaluate'],
    member: ['context:read', 'context:write'],
    operator: ['decisions:evaluate'],
    approver: ['decisions:evaluate'],
    'read-only': ['context:read'],
};

// A newly provisioned personal org has exactly one owner: the person it was made
// for. Without the row, the boot backfill was the only writer, so anyone who
// signed up between deploys was missing from their own roster. Never throws —
// JIT provisioning must not 401 somebody over a membership write.
async function ensureFounderMembership(orgId, userId) {
    try {
        const workspace = require('../services/workspaceService');
        await workspace.ensureOwnerMembership(orgId, userId);
    } catch (err) {
        console.warn('[AUTH] owner membership write failed:', err.message);
    }
}

function deriveScopes(role) {
    return ROLE_SCOPES[role] ? [...ROLE_SCOPES[role]] : ['context:read'];
}

async function systemQuery(text, params = [], orgId = 'org-system') {
    const client = await db.pool.connect();
    try {
        if (orgId) {
            await client.query('SELECT set_config(\'app.current_org_id\', $1, true)', [orgId]);
        }
        return await client.query(text, params);
    } finally {
        client.release();
    }
}

// A REJECTED TOKEN IS THE GATE WORKING, NOT AN INCIDENT.
//
// Clerk stamps a stable `reason` on every token failure. The token-* family all
// mean "the credential the client presented is not good": expired, malformed,
// wrong signature, wrong audience. Those happen constantly and by design — every
// session's token expires, every stale tab retries with it, every scanner sends
// garbage — and reporting them buries the one failure that matters.
//
// The jwk-* family is the opposite: we cannot fetch or resolve the signing keys,
// so EVERY user fails auth. That is an outage and must be reported.
//
// Anything unrecognised counts as an incident, not as routine: a new failure mode
// should arrive loudly and be demoted deliberately, never the reverse.
const ROUTINE_CLERK_TOKEN_REASONS = new Set([
    'token-expired',
    'token-invalid',
    'token-invalid-algorithm',
    'token-invalid-authorized-parties',
    'token-invalid-signature',
    'token-not-active-yet',
    'token-iat-in-the-future',
    'token-type-mismatch',
    // Audience-claim mismatch. Still a bad token, despite the general name.
    'token-verification-failed',
]);

function isRoutineTokenFailure(err) {
    if (err && typeof err.reason === 'string') {
        return ROUTINE_CLERK_TOKEN_REASONS.has(err.reason);
    }
    // decodeJwt throws a bare SyntaxError on a truncated or non-base64 bearer
    // before it ever reaches a reason code — the shape a copy-paste error or a
    // probe arrives in.
    return err instanceof SyntaxError;
}

class AuthAdapter {
    constructor() {
        this.provider = process.env.AUTH_PROVIDER || 'local';
        // When an external provider (Clerk) is authoritative, the local HS256 fallback is
        // OFF unless explicitly re-enabled — otherwise anyone with JWT_SECRET could forge a session.
        this.allowLocalFallback = process.env.ALLOW_LOCAL_JWT_FALLBACK === 'true';
        this.clerk = process.env.CLERK_SECRET_KEY ? createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY }) : null;
        this.defaultRole = this._normalizeRole(process.env.AUTH_DEFAULT_ROLE, 'owner');
        this.providerRoleMap = this._parseProviderRoleMap(process.env.AUTH_PROVIDER_ROLE_MAP);
    }

    async verifySession(token) {
        if (this.clerk) {
            try {
                const user = await this._verifyClerk(token);
                if (user) return user;
            } catch (e) {
                if (e.message.includes('jwks')) console.error('[AUTH] Clerk JWKS error:', e.message);
            }
        }
        // AUTHN-001: with Clerk authoritative, do NOT fall back to local HS256 verification
        // (which would accept any JWT_SECRET-signed token) unless explicitly opted in.
        if (this.provider === 'clerk' && !this.allowLocalFallback) {
            return null;
        }
        return this._verifyLocal(token);
    }

    async _verifyClerk(token) {
        if (!this.clerk) return null;
        try {
            const decoded = await verifyClerkToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
            const clerkUser = await this.clerk.users.getUser(decoded.sub);
            // The PRIMARY address, not `emailAddresses[0]`: the list is in
            // the order addresses were added, so [0] is the oldest one — the
            // address a person who changed their email is leaving. See
            // utils/clerkEmail.js.
            const email = primaryClerkEmail(clerkUser);
            if (!email) {
                // Previously a TypeError on `undefined.emailAddress`. Same
                // outcome (no session, reported below), but it now says what
                // is actually wrong with the account.
                throw new Error(`Clerk user ${decoded.sub} has no email address`);
            }
            return this.syncUser(decoded.sub, email, 'clerk');
        } catch (err) {
            // Two very different failures land here and used to read the same.
            // A bad token is routine. syncUser throwing means the identity
            // verified and the DATABASE write failed — which 401s a legitimate
            // user on every request, forever, and surfaces to them as an
            // endless "your session expired" loop. That is the shape that hid
            // a locked-out paying customer for ~19 days.
            const isSyncFailure = /duplicate key|violates|constraint|relation|column/i.test(err.message || '');

            // Third case, added after the first week of real reporting: a token
            // that is simply bad. Both issues Sentry raised on day one were
            // these — one expired JWT, one truncated one — and neither is a
            // defect. Left in, they would have trained everyone to ignore the
            // feed that exists to catch clerk_identity_sync_failed, the silent
            // failure that 401'd the only paying customer for ~19 days.
            if (!isSyncFailure && isRoutineTokenFailure(err)) {
                console.debug(`[AUTH] rejected token (${err.reason || err.name}): ${err.message}`);
                return null;
            }

            reportSwallowed(err, {
                op: isSyncFailure ? 'clerk_identity_sync_failed' : 'clerk_token_verify_failed',
                meta: { stage: isSyncFailure ? 'sync_user' : 'verify_token' },
            });
            return null;
        }
    }

    async _verifyLocal(token) {
        let decoded = null;
        try {
            decoded = verifyToken(token);
        } catch (err) {
            console.debug('[AUTH] Local JWT verification error:', err.message);
            return null;
        }
        if (!decoded) return null;
        try {
            const result = await systemQuery(
                'SELECT u.*, o.name as org_name, o.redaction_mode, o.redaction_keys FROM users u LEFT JOIN organizations o ON u.org_id = o.org_id WHERE u.user_id = $1',
                [decoded.user_id],
                'org-system'
            );
            return result.rows.length > 0 ? result.rows[0] : null;
        } catch (err) {
            console.error('[AUTH] DB lookup failed during local verify:', err.message);
            return null;
        }
    }

    async syncUser(externalId, email, provider) {
        try {
            const result = await systemQuery(
                'SELECT u.*, o.name as org_name FROM users u LEFT JOIN organizations o ON u.org_id = o.org_id WHERE auth_provider = $1 AND auth_subject = $2',
                [provider, externalId],
                'org-system'
            );
            if (result.rows.length > 0) {
                const user = result.rows[0];
                if (user.org_id && !user.org_name) {
                    const orgId = `org-${crypto.randomUUID()}`;
                    const orgName = `${email.split('@')[0]}'s Workspace`;
                    await systemQuery(
                        'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, account_type) VALUES ($1, $2, $3, $4, $5, $6)',
                        [orgId, orgName, 'free', 'free', 'trial_active', 'organization'],
                        'org-system'
                    );
                    await systemQuery('UPDATE users SET org_id = $1 WHERE user_id = $2', [orgId, user.user_id], 'org-system');
                    await ensureFounderMembership(orgId, user.user_id);
                    return { ...user, org_id: orgId, org_name: orgName };
                }
                return user;
            }
            const existingByEmail = await systemQuery(
                'SELECT u.*, o.name as org_name FROM users u LEFT JOIN organizations o ON u.org_id = o.org_id WHERE u.email = $1',
                [email],
                'org-system'
            );
            // Resurrection / account-takeover guard: only adopt an email-matched
            // row when it isn't already bound to a DIFFERENT external identity of
            // this same provider. The legitimate case is provider migration — a
            // pre-existing local/password row (auth_provider !== provider, or no
            // auth_subject) signing in via Clerk for the first time. The dangerous
            // case is a new Clerk user signing up with the email of a *prior*
            // (deleted) Clerk account: relinking there would hand the new signup
            // the old org, plan_tier and all — exactly the "deleted, signed back
            // in, and was on Pro" report. When the email is bound to a conflicting
            // identity, fall through to fresh-account creation instead of adopting.
            const emailRow = existingByEmail.rows[0];
            const boundToDifferentIdentity =
                emailRow && emailRow.auth_provider === provider &&
                emailRow.auth_subject && emailRow.auth_subject !== externalId;
            // "Fall through to fresh-account creation" could never succeed on
            // its own: users.email is UNIQUE, so the INSERT below hit a 23505
            // on the stale row's address, syncUser returned null, and the new
            // identity 401'd on every request, forever — an endless "your
            // session expired" loop for anybody whose earlier Clerk account was
            // deleted without its row (the user.deleted webhook failed for
            // months). Release the address first when Clerk confirms the old
            // identity no longer holds it; nothing is merged or adopted.
            if (boundToDifferentIdentity) await this._releaseStaleEmail(emailRow, email, externalId);
            if (emailRow && !boundToDifferentIdentity) {
                const user = emailRow;
                // AN UNBOUND ROW IS AN UNVERIFIED CLAIM ON AN ADDRESS.
                //
                // A row with no auth_subject was made by POST /auth/signup,
                // which never verified the email — and that route was live in
                // production (see config/localAuth.js). So "a local row with
                // this email exists" proved only that SOMEBODY typed the
                // address. Adopting it handed the real owner, on their first
                // Clerk sign-in, a workspace the other person named, their
                // referral attribution, and their password_hash still on the
                // row.
                //
                // A row that shows real use (keys, projects, billing, other
                // members) is the legitimate provider migration and is adopted
                // as before. One that shows none is not trusted: the Clerk
                // identity gets a FRESH workspace, and the pre-created one is
                // detached (and removed when empty). Either way the local
                // password stops being a credential: Clerk is authoritative
                // for this person from here on.
                const unproven = !user.auth_subject && user.org_id
                    ? await this._isUnprovenLocalRow(user)
                    : false;
                const abandonedOrgId = unproven ? user.org_id : null;
                let orgId = unproven ? null : user.org_id;
                let orgName = unproven ? null : user.org_name;
                if (!orgId) {
                    orgId = `org-${crypto.randomUUID()}`;
                    orgName = `${email.split('@')[0]}'s Workspace`;
                    // A brand-new account (the pre-created row was never
                    // used): Free or plan_required per the hosted switch.
                    const signupPlan = newSignupPlanState();
                    await systemQuery(
                        'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, account_type) VALUES ($1, $2, $3, $4, $5, $6)',
                        [orgId, orgName, signupPlan.plan, signupPlan.plan_tier, signupPlan.subscription_status, 'organization'],
                        'org-system'
                    );
                }
                await systemQuery(
                    `UPDATE users
                        SET auth_provider = $1, auth_subject = $2,
                            org_id = CASE WHEN $5::boolean THEN $3 ELSE COALESCE(org_id, $3) END,
                            password_hash = NULL, invite_token_hash = NULL, invite_expires_at = NULL,
                            password_reset_required = FALSE
                      WHERE user_id = $4`,
                    [provider, externalId, orgId, user.user_id, unproven],
                    'org-system'
                );
                // Only when this call minted the org: an adopted row's existing
                // org may be a team it joined as a member, and owner is wrong there.
                if (!user.org_id || unproven) await ensureFounderMembership(orgId, user.user_id);
                if (abandonedOrgId) await this._detachUnprovenWorkspace(abandonedOrgId, user.user_id);
                return {
                    ...user,
                    password_hash: null,
                    invite_token_hash: null,
                    invite_expires_at: null,
                    password_reset_required: false,
                    auth_provider: provider,
                    auth_subject: externalId,
                    org_id: orgId,
                    org_name: orgName,
                };
            }
            const userId = `user-${crypto.randomUUID()}`;
            const orgId = `org-${crypto.randomUUID()}`;
            const orgName = `${email.split('@')[0]}'s Workspace`;
            const role = this._resolveRoleForProvider(provider);
            // A brand-new account: Free, or plan_required while the hosted
            // switch HOSTED_FREE_TIER_FOR_NEW_SIGNUPS is off (config/plans.js).
            const signupPlan = newSignupPlanState();
            await systemQuery(
                'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, account_type) VALUES ($1, $2, $3, $4, $5, $6)',
                [orgId, orgName, signupPlan.plan, signupPlan.plan_tier, signupPlan.subscription_status, 'organization'],
                'org-system'
            );
            try {
                await systemQuery(
                    'INSERT INTO users (user_id, email, role, org_id, auth_provider, auth_subject) VALUES ($1, $2, $3, $4, $5, $6)',
                    [userId, email, role, orgId, provider, externalId],
                    'org-system'
                );
            } catch (err) {
                // A brand-new signup provisions twice at once: the Clerk
                // `user.created` webhook and this lazy path (the dashboard's
                // first request) both see no row and both INSERT. auth_subject
                // and email are unique, so the loser gets a 23505. Returning
                // null here 401'd that first request, and the dashboard showed
                // a person who had just signed up "your session expired".
                // The winner's row is the account: drop the org this call
                // minted (nothing references it yet) and return that row.
                if (err && err.code === '23505') {
                    const winner = await this._recoverProvisioningRace(provider, externalId, orgId);
                    if (winner) return winner;
                }
                throw err;
            }
            await ensureFounderMembership(orgId, userId);
            return { user_id: userId, email, role, org_id: orgId, org_name: orgName, auth_provider: provider, auth_subject: externalId };
        } catch (err) {
            console.error(`[AUTH] syncUser failed for ${provider}:${externalId}:`, err.message);
            logAuthError(err);
            return null;
        }
    }

    // A row bound to ANOTHER Clerk identity holds this address. Clerk keeps an
    // address on one user at a time, so a new identity verified at it means
    // the old one let it go — but that is checked, not assumed: the old
    // identity must be gone (404) or now have a different primary address.
    // Then the stale row's email becomes a per-row `.invalid` tombstone, which
    // frees the address for the fresh account and keeps everything else on
    // that row (org, plan, history) exactly where it was. Any other answer —
    // the old identity still holds the address, or Clerk could not be asked —
    // leaves the row alone and the sign-in fails as it did before.
    async _releaseStaleEmail(staleRow, email, newSubject) {
        if (!this.clerk) return false;
        let stale;
        try {
            const holder = await this.clerk.users.getUser(staleRow.auth_subject);
            const holderEmail = primaryClerkEmail(holder, { strict: true });
            stale = !holderEmail || holderEmail.toLowerCase() !== String(email).toLowerCase();
        } catch (err) {
            if (err && err.status === 404) {
                stale = true;
            } else {
                reportSwallowed(err, {
                    op: 'clerk_stale_email_check_failed',
                    destructive: false,
                    meta: { auth_subject: newSubject, stale_user_id: staleRow.user_id },
                });
                return false;
            }
        }
        if (!stale) {
            reportSwallowed(new Error('Address is held by a live Clerk identity bound to another account'), {
                op: 'clerk_email_held_by_live_identity',
                destructive: false,
                meta: { auth_subject: newSubject, stale_user_id: staleRow.user_id },
            });
            return false;
        }
        const released = await systemQuery(
            'UPDATE users SET email = $1 WHERE user_id = $2 AND auth_subject = $3 AND email = $4',
            [`released+${staleRow.user_id}@deerdawn.invalid`, staleRow.user_id, staleRow.auth_subject, staleRow.email],
            'org-system'
        );
        if (!released.rowCount) return false;
        // Not an error, but a person should know an address changed hands.
        reportSwallowed(new Error('Released an address held by a stale Clerk identity'), {
            op: 'clerk_stale_email_released',
            destructive: false,
            meta: { auth_subject: newSubject, stale_user_id: staleRow.user_id },
        });
        return true;
    }

    // The other half of a lost first-touch INSERT. Reads back the row the
    // winner committed for this same identity, and removes the empty org the
    // losing call created before its INSERT failed. Returns null when no row
    // for this identity exists: the 23505 was then on email against a
    // DIFFERENT identity, which is not a race and must still fail.
    async _recoverProvisioningRace(provider, externalId, orphanOrgId) {
        const winner = await systemQuery(
            'SELECT u.*, o.name as org_name FROM users u LEFT JOIN organizations o ON u.org_id = o.org_id WHERE u.auth_provider = $1 AND u.auth_subject = $2',
            [provider, externalId],
            'org-system'
        );
        if (winner.rows.length === 0) return null;
        await systemQuery(
            'DELETE FROM organizations WHERE org_id = $1 AND NOT EXISTS (SELECT 1 FROM users WHERE org_id = $1)',
            [orphanOrgId],
            'org-system'
        ).catch((err) => {
            console.warn(`[AUTH] could not remove orphan org ${orphanOrgId} after a provisioning race:`, err.message);
        });
        return winner.rows[0];
    }

    // True when a locally-created, never-bound row shows NO sign of real use:
    // no API key, no project in its workspace, no billing, nobody else in it.
    // That is what a row minted by an unverified POST /auth/signup looks like;
    // a pre-Clerk account that was actually used has at least one of these.
    // Throws on a failed read (syncUser then 401s this request and the next one
    // retries) rather than guessing in either direction.
    async _isUnprovenLocalRow(user) {
        const r = await systemQuery(
            `SELECT
                EXISTS (SELECT 1 FROM api_keys WHERE owner_id = $1) AS has_keys,
                EXISTS (SELECT 1 FROM context_projects WHERE owner_key = $2) AS has_projects,
                EXISTS (SELECT 1 FROM organizations WHERE org_id = $2
                          AND (stripe_customer_id IS NOT NULL OR stripe_subscription_id IS NOT NULL)) AS billed,
                EXISTS (SELECT 1 FROM workspace_members WHERE owner_key = $2 AND user_id <> $1
                          AND removed_at IS NULL) AS has_others`,
            [user.user_id, user.org_id],
            'org-system'
        );
        const row = r.rows[0] || {};
        return !(row.has_keys || row.has_projects || row.billed || row.has_others);
    }

    // The pre-created workspace is not this person's: take them off its roster,
    // drop the referral attribution the unverified signup recorded against
    // their user id, and delete the organization itself only while it is still
    // empty (the WHERE re-checks, so nothing with data can go). Best-effort:
    // the person has already been given their own workspace; a leftover empty
    // org is residue, not access.
    async _detachUnprovenWorkspace(orgId, userId) {
        const steps = [
            ['DELETE FROM workspace_members WHERE owner_key = $1 AND user_id = $2', [orgId, userId]],
            ['DELETE FROM referrals WHERE referred_user_id = $2 AND referred_org_id = $1', [orgId, userId]],
            [`DELETE FROM organizations o
               WHERE o.org_id = $1
                 AND o.stripe_customer_id IS NULL AND o.stripe_subscription_id IS NULL
                 AND NOT EXISTS (SELECT 1 FROM users u WHERE u.org_id = o.org_id)
                 AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.owner_key = o.org_id)
                 AND NOT EXISTS (SELECT 1 FROM context_projects p WHERE p.owner_key = o.org_id)
                 AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.org_id = o.org_id)`, [orgId]],
        ];
        for (const [sql, params] of steps) {
            await systemQuery(sql, params, 'org-system').catch((err) => {
                console.warn('[AUTH] detaching an unverified pre-created workspace:', err.message);
            });
        }
    }

    _resolveRoleForProvider(provider) {
        return this._normalizeRole(this.providerRoleMap[provider], this.defaultRole);
    }

    _parseProviderRoleMap(rawMap) {
        if (!rawMap) return {};
        try {
            const parsed = JSON.parse(rawMap);
            if (!parsed || typeof parsed !== 'object') return {};
            return Object.fromEntries(
                Object.entries(parsed)
                    .map(([provider, role]) => [provider, this._normalizeRole(role, null)])
                    .filter(([, role]) => role)
            );
        } catch (err) {
            console.warn('[AUTH] Invalid AUTH_PROVIDER_ROLE_MAP JSON:', err.message);
            return {};
        }
    }

    _normalizeRole(role, fallback) {
        if (typeof role === 'string' && VALID_ROLES.has(role)) return role;
        return fallback;
    }
}

const authAdapter = new AuthAdapter();

// ── Clerk identity helpers ─────────────────────────────────────────────────
// Step-up verification + hard-delete for the Clerk identity, exposed so the
// account-deletion route can (a) require the account password before wiping
// data and (b) delete the Clerk user so a "deleted" account can't sign back in.
// All are null-safe no-ops when Clerk isn't configured (local/dev).
function isClerkConfigured() {
    return Boolean(authAdapter.clerk);
}

// Does this Clerk identity sign in with a password at all? OAuth-only accounts
// (e.g. Google) have no password to verify, so the caller falls back to a
// typed-email confirmation instead of requiring a password.
async function clerkUserHasPassword(authSubject) {
    if (!authAdapter.clerk || !authSubject) return false;
    try {
        const user = await authAdapter.clerk.users.getUser(authSubject);
        return user?.passwordEnabled === true;
    } catch (err) {
        console.warn('[AUTH] clerkUserHasPassword lookup failed:', err.message);
        return false;
    }
}

// Verify a password against the Clerk identity. Returns true only on a confirmed
// match; any error (wrong password, no password set, network) returns false so a
// destructive action can never proceed on an ambiguous result.
async function verifyClerkPassword(authSubject, password) {
    if (!authAdapter.clerk || !authSubject || !password) return false;
    try {
        const result = await authAdapter.clerk.users.verifyPassword({ userId: authSubject, password });
        return result?.verified === true;
    } catch {
        return false;
    }
}

async function deleteClerkUser(authSubject) {
    if (!authAdapter.clerk || !authSubject) return { skipped: true };
    await authAdapter.clerk.users.deleteUser(authSubject);
    return { ok: true };
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Returns true if strings are equal, false otherwise.
 */
function secureCompare(a, b) {
    if (!a || !b) return false;
    if (typeof a !== 'string' || typeof b !== 'string') return false;

    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);

    // If lengths differ, we still do a comparison to avoid timing leak
    if (bufA.length !== bufB.length) {
    // Compare against self to maintain constant time
        crypto.timingSafeEqual(bufA, bufA);
        return false;
    }

    return crypto.timingSafeEqual(bufA, bufB);
}

// ENF-01: applied at every point where a tenant actor is established, so plan enforcement
// cannot be missed by a newly added router. Exemptions (billing, auth, settings) live in
// middleware/enforcePlan.js. Required lazily to avoid a require cycle at module load.
// Bind the request to a workspace, once, before anything reads data.
//
// THIS IS WHAT MAKES MEMBERSHIP MEAN ANYTHING. An invited teammate's users.org_id
// is still the personal org created at their own signup, so `actor.org_id` — the
// value every owner_key derives from — points at their own workspace, not the
// one they were invited to. Without this step they would join a team and then
// see an empty product.
//
// The client names the workspace it wants (the dashboard's switcher; for MCP,
// the API key's own org). workspaceService.resolveOwnerKey checks membership and
// REFUSES a workspace the actor is not in, rather than silently falling back to
// their own — a silent fallback would answer a question nobody asked and look
// like data loss.
//
// Done here, in one place, so the ~40 downstream `org_id || id` derivations
// inherit it without being rewritten: they all read actor.workspace_key first
// via workspaceService.defaultOwnerKey.
const WORKSPACE_HEADER = 'x-deerdawn-workspace';

async function bindWorkspace(req, res) {
    if (!(await resolveWorkspaceBinding(req, res))) return false;
    try {
        await capCredentialScopesToBoundRole(req.actor);
    } catch (err) {
        // Failing open here would hand a viewer's token its write scope on a DB
        // blip. Refuse the request instead, as resolution itself does.
        console.error('[AUTH] scope cap failed:', err.message);
        res.status(503).json({ error: 'workspace_unavailable' });
        return false;
    }
    return true;
}

// Scope implication, mirrored from the MCP dispatcher's hasScope: admin covers
// write, write covers read. Expanded before intersecting so a member holding an
// admin-only key keeps write, and a viewer holding a write-only one keeps read.
const IMPLIED_SCOPES = Object.freeze({
    'context:admin': ['context:write', 'context:read'],
    'context:write': ['context:read'],
});

// A CREDENTIAL IS CAPPED WHERE IT IS USED, NOT WHERE IT WAS MINTED.
//
// OAuth tokens and API keys store the scopes the person approved. Capping those
// at mint (the first cut of this, in routes/oauth.js) resolved the role in the
// person's ACTIVE workspace and baked it in: a viewer on a team got a read-only
// token that also governed their own PERSONAL workspace for up to 90 days, and a
// demotion only bit at the next refresh. The role that matters is the one held
// in the workspace THIS request is bound to, so it is read here, per request,
// after binding. contextSyncService.assertWorkspaceWritable remains the service
// layer's own refusal, in depth.
//
// Session (user) actors are untouched: their scopes derive from their session.
// A key with no owning person has no role to read, and somebody in their own
// account before the membership backfill reached them owns it — neither is
// narrowed, matching workspaceService.resolveRole's own carve-out.
async function capCredentialScopesToBoundRole(actor) {
    if (!actor || actor.type !== 'key' || !actor.owner_id) return;
    const workspace = require('../services/workspaceService');
    // What the credential was GRANTED, before any workspace narrowed it. Stashed
    // because a request can be bound twice — fallBackToPersonalWorkspace rebinds
    // one that a lapsed workspace refused — and capping the already-capped set
    // would carry a team viewer's read-only ceiling into their own account.
    if (!actor.granted_scopes) actor.granted_scopes = actor.scopes;
    const ownerKey = workspace.defaultOwnerKey(actor);
    // EVERY workspace this person belongs to, not only the bound one. Same
    // index (idx_workspace_members_user), same single round trip, and one row
    // for the overwhelming majority of accounts — so reading the whole set
    // costs nothing here and saves routes/mcp.js a query it would otherwise
    // have to run on every solo account's start_session to tell a plain key
    // holder that their team is somewhere this key cannot reach. Stashed so a
    // re-bind (fallBackToPersonalWorkspace) does not ask a second time.
    if (!actor.workspace_memberships) {
        actor.workspace_memberships = await workspace.listMemberships(actor.owner_id);
    }
    const membership = actor.workspace_memberships.find((m) => m.owner_key === ownerKey) || null;
    // "Their own account before the backfill" is the PERSON'S org (users.org_id),
    // not the key's: a key's org_id is the workspace it was minted in, so a key
    // minted in a team whose holder has no row there any more kept every scope
    // it was granted (scan 26). workspace.personalWorkspaceKey asks the person,
    // and is only reached when there is no membership row at all.
    if (!membership && ownerKey === await workspace.personalWorkspaceKey(actor)) {
        actor.scopes = actor.granted_scopes;
        return;
    }
    const role = membership ? membership.role : 'viewer';
    const grantable = new Set(workspace.grantableScopes(role));

    const held = Array.isArray(actor.granted_scopes) ? actor.granted_scopes : [];
    if (held.every((scope) => grantable.has(scope))) {
        actor.scopes = actor.granted_scopes;
        return;
    }

    const expanded = new Set(held);
    for (const scope of held) (IMPLIED_SCOPES[scope] || []).forEach((s) => expanded.add(s));
    // A NEW array: actor.scopes is the api-key cache's own array, and narrowing it
    // in place would leak one request's workspace into the next request's.
    actor.scopes = workspace.grantableScopes('owner').filter((scope) => expanded.has(scope) && grantable.has(scope));
}

// The routes a person barred from their own default workspace must still reach,
// because they are the ones that tell them where they can go instead. Read-only,
// and scoped to their own memberships. Matched on the full mounted path so a
// future router cannot accidentally inherit the exemption by naming a route
// '/workspaces'.
const WORKSPACE_EXIT_ROUTES = new Set(['/api/v1/teams/workspaces']);

function isWorkspaceExitRoute(req) {
    if (req.method !== 'GET') return false;
    const full = `${req.baseUrl || ''}${req.path || ''}`.replace(/\/+$/, '');
    return WORKSPACE_EXIT_ROUTES.has(full);
}

// ROUTES THAT NEVER READ THE BOUND WORKSPACE ARE NOT BOUND TO ONE.
//
// Accepting an invitation writes to the INVITE's workspace, resolved from the
// token, for the PERSON presenting it — nothing about the request's workspace
// enters into it. Binding it anyway let the workspace the person was LEAVING
// decide whether they could join another: a removed member whose dashboard
// still held the old team's id in x-deerdawn-workspace got workspace_forbidden
// on the re-invite that would readmit them, and somebody whose users.org_id is
// a team they were removed from (the legacy invite path, or a founder handed
// off) was refused every invitation with or without a header.
//
// Such a request is left unbound: no header check, no removal refusal, no
// is_active fallback. Nothing downstream reads a workspace from it, and the
// handler performs its own membership, seat and plan checks against the
// invite's workspace. Matched as METHOD plus full mounted path so no other
// router can inherit it.
//
// The domain door is the same shape: GET /teams/joinable reads the person's
// email domain and their own memberships, and accepting an offer writes to the
// OFFER's workspace after checking that workspace's plan and seats. A removed
// member re-entering that way is refused by the handler itself
// (removed_from_workspace), which never consulted the binding either.
const WORKSPACE_INDEPENDENT_ROUTES = [
    ['POST', /^\/api\/v1\/teams\/invite\/accept$/],
    ['GET', /^\/api\/v1\/teams\/joinable$/],
    ['POST', /^\/api\/v1\/teams\/joinable\/[^/]+\/accept$/],
];

function isWorkspaceIndependentRoute(req) {
    const method = (req.method || 'GET').toUpperCase();
    const full = `${req.baseUrl || ''}${req.path || ''}`.replace(/\/+$/, '');
    return WORKSPACE_INDEPENDENT_ROUTES.some(([verb, pattern]) => verb === method && pattern.test(full));
}

// WHICH CREDENTIALS MAY FOLLOW THE is_active ROW, AND WHICH MAY NOT.
//
// The fallback below exists for credentials that cannot name a workspace
// themselves. An MCP OAuth token WITHOUT a stamp is one (a stamped token is
// pinned to its workspace and never gets here; see bindPinnedWorkspace): it is
// minted against the person's PERSONAL org and its client cannot send a header,
// so without the fallback an invited teammate could never reach the team from
// Claude.ai or ChatGPT. An
// interactive session is the same case from the other side — the dashboard's
// switcher IS the is_active row, and it expresses "personal" by sending no
// header at all.
//
// An ordinary API KEY already names a workspace: keys.js and the device flow
// both stamp it with the workspace it was minted against. Letting those follow
// is_active too meant accepting an invite silently moved the personal key
// somebody had been using for months into the team, and the next project they
// created there was published to their new colleagues. A key belongs to the
// workspace it was issued for; the header remains the explicit override.
function credentialFollowsActiveWorkspace(actor) {
    return actor?.type !== 'key' || Boolean(actor.oauth_resource);
}

// THE ADMISSION TEST FOR A PERSON'S OWN WORKSPACE, IN ONE PLACE.
//
// There are two ways a request ends up bound to actor.org_id: the ordinary
// header-less binding in resolveWorkspaceBinding, and fallBackToPersonalWorkspace
// rebinding a request whose team workspace is refusing on billing grounds. The
// second ran none of the first's checks.
//
// That is an access-control hole, not a tidiness problem. Anyone whose
// users.org_id IS a team workspace — the legacy invite path creates people
// directly inside the target org — could be removed from that team, refused it
// by header, and then handed it anyway the moment the team they had switched to
// lapsed: the fallback rebound them to org_id, enforcement passed for org_id,
// and the removed member was served that workspace's shared projects.
//
// So the test lives here and both paths call it. Returns null when the binding
// is admissible, or a {status, body} refusal. THROWS on infrastructure failure:
// "cannot tell" must never be read as "yes".
async function refuseOwnOrgBinding(req, actor) {
    const workspace = require('../services/workspaceService');
    if (!(await workspace.isRemovedFrom(actor.org_id, actor))) return null;

    // REFUSING THE ENTRANCE MUST NOT ALSO REFUSE THE EXIT.
    //
    // For anybody whose users.org_id IS a team workspace this branch refuses
    // every request they can make, with or without a header. The dashboard drops
    // its stored workspace, retries against the account default, and gets the
    // same 403 forever: a screen whose only button cannot work.
    //
    // GET /teams/workspaces is the route that answers "where may I go instead".
    // It reads nothing but this person's own memberships and their own org id,
    // which is why it is deliberately not feature-gated either — and why it is
    // safe to answer while barred. Every other route stays refused.
    if (isWorkspaceExitRoute(req)) return null;

    return {
        status: 403,
        body: {
            error: 'workspace_forbidden',
            message: 'You are no longer a member of this workspace.',
        },
    };
}

// A HOSTED CONNECTION ACTS IN THE WORKSPACE IT WAS APPROVED FOR, AND NOWHERE ELSE.
//
// An OAuth token used to follow the person's selected workspace (the is_active
// row) on every call, so the dashboard switcher silently moved a tool that a
// team owner could see as a TEAM connection, and a tool approved in a personal
// workspace started writing to the team. The workspace is now the stamp put on
// the grant at consent (api_keys.oauth_workspace_key), carried across refresh.
//
//   - Switching workspace in the dashboard moves nothing.
//   - A person no longer a member of the stamped workspace is REFUSED, with the
//     reason, rather than moved somewhere else. Using a tool in another
//     workspace means approving it there.
//   - The connection cannot switch itself: a header naming another workspace is
//     refused. (An MCP client cannot send one; this is the door held shut.)
//   - No billing fallback either: the fallback moves a request to the person's
//     personal workspace, which is exactly the silent move this forbids. A
//     lapsed pinned team answers with the enforcement refusal.
// A grant with no stamp yet (minted by a machine still on the old code during a
// deploy, before the boot backfill reaches it) keeps the old is_active behaviour.
async function bindPinnedWorkspace(req, res) {
    const actor = req.actor;
    const pin = actor.oauth_workspace_key;
    const requested = req.headers[WORKSPACE_HEADER];
    if (typeof requested === 'string' && requested.trim() && requested.trim() !== pin) {
        res.status(403).json({
            error: 'workspace_pinned',
            message: 'This connection was approved for one workspace and cannot switch to another. '
                + 'To use a different workspace, approve the connection again from there.',
        });
        return false;
    }
    const workspace = require('../services/workspaceService');
    try {
        const person = workspace.actorPersonId(actor);
        const home = await workspace.personalWorkspaceKey(actor);
        const admitted = pin === home
            ? !(await workspace.isRemovedFrom(pin, actor))
            : (!person || Boolean(await workspace.getMembership(pin, person)));
        if (!admitted) {
            // 401, not 403: the token can never work again, and a 401 on /mcp
            // carries the WWW-Authenticate challenge (routes/mcp.js
            // requireMcpAuth) that makes Claude and ChatGPT offer their own
            // reconnect button and start the OAuth flow again.
            res.status(401).json({
                error: 'invalid_token',
                message: 'You are no longer a member of the workspace this connection was approved for. '
                    + 'Approve the connection again from the workspace you want to use.',
            });
            return false;
        }
    } catch (err) {
        console.error('[AUTH] pinned workspace check failed:', err.message);
        res.status(503).json({ error: 'workspace_unavailable' });
        return false;
    }
    actor.workspace_key = pin;
    actor.workspace_binding = 'pinned';
    return true;
}

async function resolveWorkspaceBinding(req, res) {
    if (!req.actor) return true;
    if (isWorkspaceIndependentRoute(req)) {
        req.actor.workspace_binding = 'unbound';
        return true;
    }
    if (req.actor.type === 'key' && req.actor.oauth_resource && req.actor.oauth_workspace_key) {
        return bindPinnedWorkspace(req, res);
    }
    const workspace = require('../services/workspaceService');
    const requested = req.headers[WORKSPACE_HEADER];
    const wantsOwnOrg = !requested || typeof requested !== 'string' || requested === req.actor.org_id;

    // REMOVAL HAS TO REVOKE, including on the default path.
    //
    // defaultOwnerKey hands back actor.org_id with no membership check, and this
    // function used to return early whenever the requested workspace WAS that
    // org. So anyone whose users.org_id is a team workspace — which the legacy
    // invite path creates directly — kept full access after being removed, just
    // by omitting the header. Their keys were revoked and their membership row
    // said removed_at; nothing consulted it.
    if (wantsOwnOrg) {
        try {
            // NO HEADER DOES NOT MEAN "PERSONAL ORG".
            //
            // It means "whatever workspace this person is currently working in",
            // and that choice lives on their membership row. The header remains
            // the explicit override, but an MCP client cannot send one — OAuth
            // tokens carry the personal org — so without this an invited
            // teammate's entire agent loop resolved to their own empty workspace
            // and the team brief, which is the product, was never reachable from
            // Claude.ai or ChatGPT at all.
            //
            // Only consulted when the caller did not ask for something specific,
            // for credentials that cannot ask (see
            // credentialFollowsActiveWorkspace), and it re-checks membership, so
            // a removed member falls back to their personal org on the very next
            // request.
            if (!requested && credentialFollowsActiveWorkspace(req.actor)) {
                const active = await workspace.getActiveWorkspace(req.actor);
                if (active && active !== req.actor.org_id) {
                    req.actor.workspace_key = active;
                    req.actor.workspace_binding = 'active_fallback';
                    return true;
                }
            }
            const refusal = await refuseOwnOrgBinding(req, req.actor);
            if (refusal) {
                res.status(refusal.status).json(refusal.body);
                return false;
            }
        } catch (err) {
            console.error('[AUTH] removal check failed:', err.message);
            res.status(503).json({ error: 'workspace_unavailable' });
            return false;
        }
        req.actor.workspace_binding = 'own_org';
        return true;
    }

    try {
        req.actor.workspace_key = await workspace.resolveOwnerKey(req.actor, requested.trim());
        req.actor.workspace_binding = 'header';
        return true;
    } catch (err) {
        if (err instanceof workspace.WorkspaceAccessError) {
            res.status(403).json({ error: err.code, message: err.message });
            return false;
        }
        // A membership lookup that fails for infrastructure reasons must not be
        // read as "not a member" — that would hand somebody else's fallback
        // workspace to a legitimate request. Fail the request instead.
        console.error('[AUTH] workspace resolution failed:', err.message);
        res.status(503).json({ error: 'workspace_unavailable' });
        return false;
    }
}

// WHICH BINDINGS MAY FALL BACK.
//
// The is_active binding always could. A HEADER binding could not, on the theory
// that a header names a workspace deliberately — but for a person the header is
// not a separate decision: the dashboard's switcher writes is_active AND sends
// the header for the same choice. So an invited teammate whose team lapsed was
// 403'd on every dashboard read (the browser sends the header) while the same
// person's header-less MCP traffic fell back, and GET /teams/workspaces — which
// the dashboard calls WITHOUT the header — announced a fallback that none of its
// other requests were getting. For a session or an OAuth token the header is
// just the switcher, and it falls back exactly like the switcher does.
//
// An ordinary API KEY stays out: it was minted for one workspace, and a key
// bound to a lapsed team has to fail loudly rather than quietly start serving
// its holder's personal data. Removed members never get this far —
// resolveOwnerKey refuses their header with workspace_forbidden.
function bindingMayFallBack(actor) {
    if (actor.workspace_binding === 'active_fallback') return true;
    return actor.workspace_binding === 'header' && credentialFollowsActiveWorkspace(actor);
}

// A WORKSPACE SOMEBODY ELSE STOPPED PAYING FOR MUST NOT TAKE YOUR OWN WITH IT.
//
// The is_active row is a convenience: it answers "where were you working" for a
// credential that cannot say. When that workspace is refusing on billing
// grounds the convenience becomes a trap — an invited teammate whose team
// lapsed was 403'd everywhere, including on their own healthy personal
// workspace, and they are not the person who can pay the bill.
//
// Only a binding the PERSON chose through the switcher is undone: the is_active
// row, or the header a session or OAuth token sends for the same choice (see
// bindingMayFallBack). A key minted against a workspace belongs to it; and an
// owner whose own org is the lapsed one has nowhere to fall back to, which is
// what enforcePlan's exempt exits are for.
//
// The caller is told, rather than quietly served different data: the response
// carries x-deerdawn-workspace-fallback, and req.actor.workspace_fallback is
// there for a surface that can say it in words.
//
// IS THIS REQUEST IN THAT SITUATION? Answered without rebinding anything, so the
// routes that are exempt from enforcement — the switcher, which is never
// rebound and therefore always reported the team as active — can tell the truth
// about where this person's OTHER requests are landing.
//
// Returns { from, to, reason } or null. `deny` is the verdict the caller has
// already computed, passed in to avoid asking enforcement the same question
// twice; a caller on an exempt route has no verdict and omits it.
async function evaluateWorkspaceFallback(req, deny = undefined) {
    const actor = req.actor;
    if (!actor || !bindingMayFallBack(actor)) return null;
    if (!actor.org_id || actor.org_id === actor.workspace_key) return null;

    let verdict = deny;
    if (verdict === undefined) {
        const { checkEnforcement } = require('../services/enforcementService');
        try {
            const result = await checkEnforcement(actor.workspace_key);
            verdict = result && result.allowed === false ? { body: { error: result.error, lock_reason: result.lock_reason, retry_checkout: result.retry_checkout } } : null;
        } catch (err) {
            // Same failure policy as enforcePlan itself: a check that cannot run
            // fails open, which here means "no fallback is happening".
            console.error('[AUTH] fallback enforcement check failed:', err.message);
            return null;
        }
    }
    if (!verdict) return null;

    // The target has to be admissible on its own terms — the whole point of
    // refuseOwnOrgBinding. If it is not, there is no fallback and the original
    // refusal stands.
    try {
        if (await refuseOwnOrgBinding(req, actor)) return null;
    } catch (err) {
        console.error('[AUTH] removal check failed on workspace fallback:', err.message);
        return null;
    }

    return {
        from: actor.workspace_key,
        to: actor.org_id,
        reason: verdict.body?.error || 'subscription_inactive',
        ...(verdict.body?.lock_reason ? { lock_reason: verdict.body.lock_reason } : {}),
        // The first payment never went through: what to check out again.
        ...(verdict.body?.retry_checkout ? { retry_checkout: verdict.body.retry_checkout } : {}),
    };
}

async function fallBackToPersonalWorkspace(req, res, fallback) {
    const actor = req.actor;
    if (!actor || !fallback) return false;

    const from = fallback.from;
    const binding = actor.workspace_binding;
    actor.workspace_key = actor.org_id;
    actor.workspace_binding = 'personal_fallback';
    actor.workspace_fallback = { from, to: actor.org_id };
    try {
        await capCredentialScopesToBoundRole(actor);
    } catch (err) {
        // Same reasoning as bindWorkspace: a scope cap that cannot run must not
        // hand back an uncapped credential. Leave the original refusal standing.
        console.error('[AUTH] scope cap failed on workspace fallback:', err.message);
        actor.workspace_key = from;
        actor.workspace_binding = binding;
        actor.workspace_fallback = null;
        return false;
    }
    res.setHeader('x-deerdawn-workspace-fallback', from);
    return true;
}

// A READ MAY BE SERVED BY THE FALLBACK WORKSPACE. A WRITE MAY NOT.
//
// Reading your own work instead of a 403 you cannot act on is a kindness. A
// WRITE lands somewhere, and the switcher — GET /teams/workspaces, exempt from
// enforcement and therefore never rebound — went on answering "active: the
// team". So an invited teammate's dashboard, which is header-less by default,
// created a project with 201 into their PERSONAL workspace while the UI named
// the team. The only signal was a response header CORS did not expose and
// nothing read.
//
// Two exceptions, both because the caller has no way to choose a workspace:
//
//   - the MCP transports. An MCP client cannot send x-deerdawn-workspace and has
//     no switcher, so refusing its writes would leave it with no reachable
//     workspace at all. It falls back as before, and routes/mcp.js says so in
//     words on start_session and on every write reply while it is in effect.
//   - deleting your own account, which is about the caller's own workspace:
//     exactly the one being fallen back to, and the exit of last resort.
//
// Everything else somebody needs while their team is lapsed — the switcher,
// billing, account settings, sign-out, telemetry — never reaches here at all:
// enforcePlan exempts those routes, so no refusal is raised to fall back from.
//
// AND WRITES THAT DO NOT TARGET THE LAPSED WORKSPACE AT ALL.
//
// The 409 is "your write would have landed somewhere you did not mean". A
// request that never addresses the bound workspace cannot land in the wrong
// one, and refusing it only traps the person inside the workspace somebody else
// stopped paying for. Each of these was checked against its handler:
//
//   - accepting an invitation writes to the INVITE's workspace, resolved from
//     the token. Refusing it meant a lapsed team could stop you joining a
//     healthy one.
//   - creating a workspace mints a new org and adds the caller to it, touching
//     nothing bound.
//
// PATCH /context/preferences is deliberately NOT here: preferences are stored
// per WORKSPACE (store.savePreferences takes the owner key), so it is precisely
// a write that would land somewhere the caller did not mean.
const FALLBACK_WRITE_EXEMPT_ROUTES = [
    // Enforcement exempts this route, so it reaches the fallback through
    // EXEMPT_ROUTES_THAT_FOLLOW_FALLBACK rather than through a refusal; kept
    // here so the rule reads the same from both directions.
    ['DELETE', /^\/api\/v1\/context\/account\/?(\?|$)/],
    ['POST', /^\/api\/v1\/teams\/invite\/accept\/?(\?|$)/],
    // joining through the domain door writes to the OFFER's workspace, exactly
    // as an invitation does (and, like it, is left unbound — see
    // WORKSPACE_INDEPENDENT_ROUTES — so this entry is belt and braces).
    ['POST', /^\/api\/v1\/teams\/joinable\/[^/?]+\/accept\/?(\?|$)/],
    ['POST', /^\/api\/v1\/teams\/workspaces\/?(\?|$)/],
];

function mayBeServedByFallback(req) {
    const method = (req.method || 'GET').toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return true;
    const url = req.originalUrl || req.url || '';
    const { isMcpRequestPath } = require('../config/mcpResource');
    if (isMcpRequestPath(url) || url.startsWith('/a2a/')) return true;
    return FALLBACK_WRITE_EXEMPT_ROUTES.some(([verb, pattern]) => verb === method && pattern.test(url));
}

async function refuseWriteToInactiveWorkspace(fallback, actor) {
    const db = require('../config/db');
    const named = await db.query(
        'SELECT name FROM organizations WHERE org_id = $1',
        [fallback.from],
        'org-system',
    ).catch(() => ({ rows: [] }));
    const name = named.rows[0]?.name || 'This workspace';
    // TELLING THE OWNER TO GO ASK AN OWNER IS A DEAD END.
    //
    // The same sentence went to everybody, so the one person who can fix the
    // bill was advised to find somebody who could. She reaches billing either
    // way (enforcePlan exempts it), but only if the refusal points her there.
    //
    // Required here rather than at the top of the file, like every other use in
    // this module: workspaceService pulls auth back in.
    const workspace = require('../services/workspaceService');
    const isOwner = await workspace.resolveRole(actor, fallback.from)
        .then((role) => workspace.canAdminister(role))
        .catch(() => false);
    // A LOCK IS NOT A LAPSED SUBSCRIPTION. Said in the lock's own words, or the
    // owner of a locked workspace is told to update billing, which cannot lift it.
    if (fallback.reason === 'lockdown_active') {
        const { LOCK_MESSAGES } = require('../services/lockReasons');
        return {
            status: 409,
            body: {
                error: 'workspace_inactive',
                lock_reason: isOwner ? (fallback.lock_reason || 'lockdown') : 'foreign_workspace',
                message: `Nothing was changed. ${LOCK_MESSAGES[isOwner ? (fallback.lock_reason || 'lockdown') : 'foreign_workspace']}`,
                workspace: fallback.from,
            },
        };
    }
    // A FIRST PAYMENT THAT NEVER WENT THROUGH is not an overdue bill: the way out
    // is checking out again (the owner's answer, 2026-09-29), and only an owner can.
    if (fallback.retry_checkout) {
        return {
            status: 409,
            body: {
                error: 'workspace_inactive',
                retry_checkout: fallback.retry_checkout,
                message: isOwner
                    ? `${name}'s first payment did not go through, so nothing was changed. `
                        + `Check out again to keep working in ${name}, or switch to your own workspace.`
                    : `${name}'s first payment did not go through, so nothing was changed. `
                        + 'Switch to your own workspace to keep working, or ask a workspace owner to check out again.',
                workspace: fallback.from,
            },
        };
    }
    return {
        status: 409,
        body: {
            error: 'workspace_inactive',
            message: isOwner
                ? `${name}'s subscription is inactive, so nothing was changed. `
                    + `Update billing to keep working in ${name}, or switch to your own workspace.`
                : `${name}'s subscription is inactive, so nothing was changed. `
                    + 'Switch to your own workspace to keep working, or ask a workspace owner to update billing.',
            workspace: fallback.from,
        },
    };
}

// EXEMPT FROM ENFORCEMENT IS NOT EXEMPT FROM THE FALLBACK.
//
// The fallback is triggered by enforcement's refusal, and enforcePlan exempts
// these routes, so no refusal was ever raised for them and they stayed bound to
// the lapsed team while every other read served the person's own workspace.
// For the switcher that is right (it reports the fallback itself). For these it
// was wrong, because each answers about THE WORKSPACE THE PERSON IS IN:
//
//   - GET /context/export exported the TEAM — without the fallback header —
//     to a teammate whose every other read was their own workspace.
//   - DELETE /context/account targeted the team and 403'd (the caller is not
//     its owner), so the FALLBACK_WRITE_EXEMPT_ROUTES entry naming it could
//     never be reached. Deleting your account is about your own workspace.
//   - GET /teams/members answered a non-owner member with the team's
//     upgrade_required, an upgrade offer to somebody who cannot pay the bill.
//     Its exemption exists for the team's OWNER, to see and shed the seats she
//     is billed for (ensureRosterRecoveryAccess), so an owner stays on the
//     team; everybody else follows the fallback like every other read.
//   - GET /context/export is the same split. The workspace's data belongs to
//     its owners, and export is how they take it out — lapsed or not. Sent
//     down the fallback unconditionally, every owner whose users.org_id is not
//     the team (a co-owner, a successor, the creator of a POST /teams/workspaces
//     team) exported their PERSONAL workspace instead, and only the founder
//     whose signup org it was (who has nowhere to fall back to) got the team.
//
// Only a binding that may fall back at all is moved (bindingMayFallBack:
// sessions and OAuth tokens, never a plain API key), and it is announced with
// x-deerdawn-workspace-fallback exactly as the enforced routes are.
const EXEMPT_ROUTES_THAT_FOLLOW_FALLBACK = [
    ['GET', /^\/api\/v1\/context\/export\/?(\?|$)/, { ownerStays: true }],
    ['DELETE', /^\/api\/v1\/context\/account\/?(\?|$)/, {}],
    ['GET', /^\/api\/v1\/teams\/members\/?(\?|$)/, { ownerStays: true }],
];

async function fallBackOnExemptRoute(req, res) {
    const method = (req.method || 'GET').toUpperCase();
    const url = req.originalUrl || req.url || '';
    const route = EXEMPT_ROUTES_THAT_FOLLOW_FALLBACK.find(([verb, pattern]) => verb === method && pattern.test(url));
    if (!route) return;
    const fallback = await evaluateWorkspaceFallback(req);
    if (!fallback) return;
    if (route[2].ownerStays) {
        const workspace = require('../services/workspaceService');
        const isOwner = await workspace.resolveRole(req.actor, fallback.from)
            .then((role) => workspace.canAdminister(role))
            .catch(() => false);
        if (isOwner) return;
    }
    await fallBackToPersonalWorkspace(req, res, fallback);
}

async function proceed(req, res, next) {
    if (!(await bindWorkspace(req, res))) return undefined;
    const { evaluatePlanEnforcement } = require('./enforcePlan');
    let deny = await evaluatePlanEnforcement(req);
    if (!deny) await fallBackOnExemptRoute(req, res);
    if (deny) {
        const fallback = await evaluateWorkspaceFallback(req, deny);
        if (fallback && !mayBeServedByFallback(req)) {
            const refusal = await refuseWriteToInactiveWorkspace(fallback, req.actor);
            return res.status(refusal.status).json(refusal.body);
        }
        if (fallback && await fallBackToPersonalWorkspace(req, res, fallback)) {
            deny = await evaluatePlanEnforcement(req);
        }
    }
    if (deny) return res.status(deny.status).json(deny.body);
    return next();
}

async function authenticate(req, res, next, { allowAnonymous = false } = {}) {
    let apiKey = req.headers['x-api-key'];
    let bearerToken = null;
    let usedCookieAuth = false;

    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (token.startsWith('dd_')) {
            apiKey = token;
        } else {
            bearerToken = token;
        }
    }

    const cookieHeader = req.headers.cookie;
    if (!bearerToken && !apiKey && cookieHeader) {
        const cookies = Object.fromEntries(
            cookieHeader.split(';').map(pair => {
                const [rawKey, ...rawValue] = pair.trim().split('=');
                return [rawKey, decodeURIComponent(rawValue.join('='))];
            })
        );
        if (cookies.dd_session) {
            bearerToken = cookies.dd_session;
            usedCookieAuth = true;
        }

        if (usedCookieAuth) {
            const method = req.method?.toUpperCase() || 'GET';
            const isMutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
            if (isMutating) {
                const csrfHeader = req.headers['x-csrf-token'];
                if (!csrfHeader || !secureCompare(csrfHeader, cookies.dd_csrf || '')) {
                    if (allowAnonymous) {
                        req.actor = null;
                        return next();
                    }
                    return res.status(403).send({ error: 'forbidden', message: 'Invalid CSRF token' });
                }
            }
        }
    }

    // 1. API Key (Machine Access)
    if (apiKey) {
        if (secureCompare(apiKey, API_KEY)) {
            req.actor = {
                type: 'system',
                id: 'system-key',
                role: 'admin',
                org_id: 'org-system',
                environment: 'production',
                scopes: ['*']  // Full access for system key
            };
            return next();
        }

        const hash = hashApiKey(apiKey);

        // Check cache first
        let keyData = apiKeyCache.getApiKey(hash);

        if (!keyData) {
            // Cache miss - fetch from DB
            try {
                const result = await db.query(
                    'SELECT * FROM api_keys WHERE key_hash = $1 AND status = \'active\'',
                    [hash],
                    'org-system'
                );

                if (result.rows.length > 0) {
                    keyData = result.rows[0];
                    // Warm the cache
                    apiKeyCache.setApiKey(hash, keyData);
                }
            } catch (err) {
                console.error('[AUTH] API key lookup failed:', err.message);
            }
        }

        if (keyData) {
            if (new Date() > new Date(keyData.expires_at)) {
                return res.status(401).send({ error: 'unauthorized', message: 'API Key has expired.' });
            }

            // OAuth-issued MCP tokens are audience-bound. Ordinary user-created
            // API keys have oauth_resource=NULL and retain their existing API
            // behavior; an MCP OAuth token can only be presented to /mcp (or
            // its compatibility alias), never reused against arbitrary REST
            // routes carrying the same context scopes.
            if (keyData.oauth_resource) {
                const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
                const host = req.headers['x-forwarded-host'] || req.get('host');
                const base = (process.env.API_BASE_URL || `${proto}://${host}`).replace(/\/+$/, '');
                const validAudience = normalizeMcpResource(keyData.oauth_resource, base);
                const requestAudience = mcpResourceForRequest(req.originalUrl || req.url, base);
                if (!validAudience || !requestAudience || validAudience !== requestAudience) {
                    return res.status(401).send({
                        error: 'invalid_token',
                        message: 'This OAuth token is restricted to the DeerDawn MCP resource.',
                    });
                }
            }

            req.actor = {
                type: 'key',
                id: keyData.key_id,
                // The human who owns this key. Carried so product-event mirroring
                // can attribute MCP/API usage to a real user (and PostHog person),
                // not just the org — otherwise every key-authed event collapses to
                // one org-keyed distinct_id and per-user weekly activity is invisible.
                owner_id: keyData.owner_id || null,
                role: 'operator',
                org_id: keyData.org_id,
                environment: keyData.environment,
                scopes: keyData.scopes || ['decisions:evaluate'],
                oauth_resource: keyData.oauth_resource || null,
                // WHICH CONNECTOR is holding this token. Rides on the row the
                // api-key cache already returns, so naming the client and
                // keeping one connection's project binding separate from
                // another's costs no extra query on the hot path. Null for a
                // key minted before the columns existed, and for every
                // hand-created API key. See services/hostedSessionIdentity.js.
                oauth_client_id: keyData.oauth_client_id || null,
                oauth_client_name: keyData.oauth_client_name || null,
                // THE WORKSPACE THIS CONNECTION WAS APPROVED FOR. A hosted OAuth
                // token acts there and nowhere else; see bindPinnedWorkspace.
                // Null only on a grant not yet stamped by the boot backfill.
                oauth_workspace_key: keyData.oauth_workspace_key || null,
            };

            // Update last_used asynchronously (non-blocking)
            setImmediate(() => {
                db.query('UPDATE api_keys SET last_used_at = NOW() WHERE key_id = $1', [keyData.key_id], keyData.org_id)
                    .catch(err => console.error('[AUTH] Failed to update key last_used:', err.message));
            });

            return proceed(req, res, next);
        }
    }

    // 2. Identity Provider (User Access via AuthAdapter)
    if (bearerToken) {
        try {
            const user = await authAdapter.verifySession(bearerToken);
            if (user) {
                req.actor = {
                    type: 'user',
                    id: user.user_id,
                    email: user.email,
                    role: user.role,
                    org_id: user.org_id,
                    org_name: user.org_name,
                    is_platform_staff: user.is_platform_staff === true,
                    scopes: deriveScopes(user.role)
                };

                if (!req.actor.org_id) {
                    if (allowAnonymous) {
                        req.actor = null;
                        return next();
                    }
                    return res.status(403).send({
                        error: 'forbidden',
                        message: 'User is missing organization context'
                    });
                }

                return proceed(req, res, next);
            }
        } catch (err) {
            console.error('[AUTH] Session verification failed:', err.message);
        }
    }

    if (allowAnonymous) {
        req.actor = null;
        return next();
    }

    return res.status(401).send({
        error: 'unauthorized',
        message: 'Missing or invalid credentials'
    });
}

async function requireAuth(req, res, next) {
    return authenticate(req, res, next);
}

async function optionalAuth(req, res, next) {
    return authenticate(req, res, next, { allowAnonymous: true });
}

/**
 * Middleware to enforce granular scopes.
 */
function requireScope(requiredScope) {
    return (req, res, next) => {
        if (!req.actor) return res.status(401).json({ error: 'unauthorized' });
        
        const hasScope = req.actor.scopes.includes('*') || req.actor.scopes.includes(requiredScope);
        if (!hasScope) {
            return res.status(403).json({ 
                error: 'insufficient_scope', 
                message: `This API key requires the '${requiredScope}' scope.` 
            });
        }
        next();
    };
}

function requireAnyScope(requiredScopes) {
    const allowed = Array.isArray(requiredScopes) ? requiredScopes : [requiredScopes];
    return (req, res, next) => {
        if (!req.actor) return res.status(401).json({ error: 'unauthorized' });
        const actorScopes = Array.isArray(req.actor.scopes) ? req.actor.scopes : [];
        const hasScope = actorScopes.includes('*') || allowed.some((scope) => actorScopes.includes(scope));
        if (!hasScope) {
            return res.status(403).json({
                error: 'insufficient_scope',
                message: `This credential requires one of these scopes: ${allowed.join(', ')}.`
            });
        }
        next();
    };
}

/**
 * Middleware to enforce Role-Based Access Control (RBAC).
 */
function requireRole(allowedRoles) {
    return (req, res, next) => {
        if (!req.actor) return res.status(401).json({ error: 'unauthorized' });

        // AUTHZ-001: explicit membership only. 'admin' is NO LONGER a global wildcard;
        // it must be listed in allowedRoles to pass. Global surfaces use requirePlatformStaff.
        const hasRole = allowedRoles.includes(req.actor.role);
        if (!hasRole) {
            return res.status(403).json({
                error: 'forbidden',
                message: `This action requires one of these roles: ${allowedRoles.join(', ')}`
            });
        }
        next();
    };
}

/**
 * Middleware for genuinely PLATFORM-GLOBAL surfaces (cross-tenant CMS, platform revenue
 * metrics, etc.). Gated on the non-grantable users.is_platform_staff flag — no tenant role
 * (including org 'admin'/'owner') can satisfy it. The internal system key is platform-level
 * by definition and is accepted.
 */
function requirePlatformStaff(req, res, next) {
    if (!req.actor) return res.status(401).json({ error: 'unauthorized' });
    const isStaff = req.actor.is_platform_staff === true || req.actor.type === 'system';
    if (!isStaff) {
        return res.status(403).json({
            error: 'forbidden',
            message: 'This action requires platform staff privileges.'
        });
    }
    next();
}

module.exports = {
    requireAuth, optionalAuth, requireScope, requireAnyScope, requireRole, requirePlatformStaff, deriveScopes, isClerkConfigured, clerkUserHasPassword, verifyClerkPassword, deleteClerkUser,
    // Exported for GET /teams/workspaces, which is exempt from enforcement and
    // therefore never rebound: it has to evaluate the same condition itself to
    // report where this person's other requests are actually landing.
    evaluateWorkspaceFallback,
    // The live adapter, exported so a test can drive _verifyClerk end to end
    // (token -> Clerk user -> the email handed to syncUser) instead of matching
    // its source text. Not for application code: go through requireAuth.
    _authAdapter: authAdapter,
    // The two halves of the lapsed-workspace refusal: which writes it may
    // refuse, and what it says. Driven directly so the rules are pinned as
    // rules, rather than inferred from whichever routers happen to exist.
    __testables: {
        mayBeServedByFallback, refuseWriteToInactiveWorkspace, FALLBACK_WRITE_EXEMPT_ROUTES, EXEMPT_ROUTES_THAT_FOLLOW_FALLBACK,
    },
};
