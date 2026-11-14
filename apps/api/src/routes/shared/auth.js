const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { hashPassword, verifyPassword, generateToken, buildJwtClaims } = require('../../utils/security');
const { LoginRequestSchema, SignupRequestSchema, ForgotPasswordRequestSchema, ResetPasswordRequestSchema } = require('../../schemas');
const { TRIAL_PLAN, normalizePlanId, isSelfServePlan, newSignupPlanState } = require('../../config/plans');
const crypto = require('crypto');
const { requireAuth, deriveScopes } = require('../../middleware/auth');
const { authLoginLimiter, authSignupLimiter } = require('../../middleware/rateLimit');
const { generateApiKey } = require('../../utils/security');
const { redis: redisClient } = require('../../config/redis');
const referralService = require('../../services/referralService');
const workspace = require('../../services/workspaceService');
const { addAuditLog } = require('../../utils/auditLogger');
const { requireLocalAuth } = require('../../config/localAuth');
const { isSelfHosted, dashboardBaseUrl, signupMode, sessionCookieSecure } = require('../../config/selfHosted');

const COOKIE_SESSION_NAME = 'dd_session';
const COOKIE_CSRF_NAME = 'dd_csrf';
const DESKTOP_AUTH_TTL_SECONDS = 300;

// Secure in production, except on a self-hosted install reached over plain HTTP
// at localhost (sessionCookieSecure in config/selfHosted.js).
const buildCookieOptions = (req, { httpOnly }) => ({
  httpOnly,
  secure: sessionCookieSecure(req),
  sameSite: 'lax',
  path: '/',
  maxAge: 1000 * 60 * 60 * 24 * 7,
});

const setAuthCookies = (req, res, token) => {
  const csrfToken = crypto.randomBytes(32).toString('hex');
  res.cookie(COOKIE_SESSION_NAME, token, buildCookieOptions(req, { httpOnly: true }));
  res.cookie(COOKIE_CSRF_NAME, csrfToken, buildCookieOptions(req, { httpOnly: false }));
};

const clearAuthCookies = (req, res) => {
  res.clearCookie(COOKIE_SESSION_NAME, buildCookieOptions(req, { httpOnly: true }));
  res.clearCookie(COOKIE_CSRF_NAME, buildCookieOptions(req, { httpOnly: false }));
};

async function createDesktopApiKey(actor) {
  const { key, prefix, hash } = generateApiKey();
  const keyId = `key-${crypto.randomUUID()}`;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 90);

  // AUTHZ: the handoff key inherits the actor's own role-derived scopes. It must never be
  // ['*'] — that wildcard is reserved for the internal system key (see middleware/auth.js),
  // and minting it here let any authenticated member (including read-only) self-escalate to
  // context:admin via a route gated only by requireAuth.
  const scopes = deriveScopes(actor.role);

  await db.query(
    'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [keyId, prefix, hash, `Desktop App - ${new Date().toISOString().slice(0, 10)}`, actor.id, actor.org_id, 'production', expiresAt.toISOString(), scopes],
    actor.org_id
  );

  return { key, keyId };
}

router.post('/desktop/start', requireAuth, async (req, res) => {
  const actor = req.actor;
  if (!actor?.id || !actor?.org_id) {
    return res.status(403).json({ error: 'forbidden', message: 'No org context' });
  }

  let createdKeyId = null;

  try {
    const { key, keyId } = await createDesktopApiKey(actor);
    createdKeyId = keyId;
    const handoffCode = crypto.randomBytes(24).toString('hex');

    await redisClient.set(
      `desktop_auth:${handoffCode}`,
      JSON.stringify({ api_key: key, email: actor.email || '' }),
      'EX',
      DESKTOP_AUTH_TTL_SECONDS
    );

    return res.json({ handoff_code: handoffCode, expires_in: DESKTOP_AUTH_TTL_SECONDS });
  } catch (err) {
    if (createdKeyId) {
      // Rollback of a key created a moment ago: nothing has used it (journey r7: the one delete path).
      await require('../../services/authorStampService').deleteApiKey({ keyId: createdKeyId, orgId: actor.org_id, scanContext: false }).catch(() => {});
    }
    console.error('[AUTH] Desktop handoff start failed:', err.message);
    return res.status(500).json({ error: 'internal_error', message: 'Could not start desktop handoff' });
  }
});

router.get('/desktop/exchange', async (req, res) => {
  const handoffCode = typeof req.query.code === 'string' ? req.query.code : '';
  if (!/^[a-f0-9]{48}$/i.test(handoffCode)) {
    return res.status(400).json({ error: 'invalid_code' });
  }

  try {
    const payload = await redisClient.get(`desktop_auth:${handoffCode}`);
    if (!payload) {
      return res.status(404).json({ error: 'expired_or_invalid' });
    }

    await redisClient.del(`desktop_auth:${handoffCode}`).catch(() => {});
    const parsed = JSON.parse(payload);
    return res.json({ api_key: parsed.api_key, email: parsed.email || '' });
  } catch (err) {
    console.error('[AUTH] Desktop handoff exchange failed:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * May this email create an account under SIGNUP_MODE=invite_only?
 *
 *   - Nobody has an account yet: yes. The first account is the install's owner.
 *   - Otherwise: only with an invitation token that is pending (not accepted,
 *     not revoked, not expired) AND was issued to this same email. The token is
 *     what the invitee was sent; an email match alone would let anybody who
 *     guessed who had been invited take the account first.
 */
async function inviteOnlySignupVerdict(email, inviteToken) {
    const anyUser = await db.query('SELECT 1 FROM users LIMIT 1', [], 'org-system');
    if (anyUser.rows.length === 0) return { allowed: true, reason: 'first_account' };
    if (typeof inviteToken !== 'string' || !inviteToken.trim()) return { allowed: false, reason: 'no_invite_token' };
    await workspace.ensureSchema().catch(() => {});
    const invite = await db.query(
        `SELECT invite_id FROM workspace_invites
          WHERE token_hash = $1
            AND LOWER(email) = LOWER($2)
            AND accepted_at IS NULL
            AND revoked_at IS NULL
            AND expires_at > NOW()
          LIMIT 1`,
        [workspace.hashInviteToken(inviteToken.trim()), String(email).trim()],
        'org-system'
    );
    return invite.rows.length > 0
        ? { allowed: true, reason: 'invited' }
        : { allowed: false, reason: 'invite_not_found' };
}

/**
 * Create the install's FIRST account, or report that somebody else already did.
 *
 * inviteOnlySignupVerdict's "nobody has an account yet" is a read, and two
 * sign-ups on an empty install that both read it before either wrote would
 * both become owners of their own workspace on an invite-only install. The
 * claim is therefore made again inside one transaction holding a
 * transaction-scoped advisory lock: the second sign-up waits for the first to
 * commit, then sees its user row and is refused like any uninvited sign-up.
 * `insertRows(query)` writes the organization and user rows through the
 * transaction's client. Resolves true when this request created the first
 * account, false when it lost the race.
 */
const FIRST_ACCOUNT_LOCK = 'deerdawn:first-account';
async function createFirstAccount(insertRows) {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [FIRST_ACCOUNT_LOCK]);
        const anyUser = await client.query('SELECT 1 FROM users LIMIT 1');
        if (anyUser.rows.length > 0) {
            await client.query('ROLLBACK');
            return false;
        }
        await insertRows((text, params) => client.query(text, params));
        await client.query('COMMIT');
        return true;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

router.post('/login', requireLocalAuth, authLoginLimiter, async (req, res) => {
    const validation = LoginRequestSchema.safeParse(req.body);
    if (!validation.success) {
        return res.status(400).send({ error: 'Invalid request', details: validation.error.issues });
    }
  
    const { email, password } = validation.data;

    try {
        const result = await db.query(`
        SELECT u.*, o.name as org_name 
        FROM users u 
        LEFT JOIN organizations o ON u.org_id = o.org_id 
        WHERE u.email = $1
    `, [email], 'org-system');
        const user = result.rows[0];

        // A row with no password_hash (every Clerk-bound account) has no local
        // credential: bcrypt threw on the null and this answered 500 instead
        // of the same 401 as a wrong password.
        if (!user || !user.password_hash || !(await verifyPassword(password, user.password_hash))) {
            // LOG-04: record failed authentication (email + source IP) for the security audit trail.
            addAuditLog(email, 'auth.login.failed', email, { ip: req.ip }, user?.org_id || null)
                .catch(() => {});
            return res.status(401).send({ error: 'Invalid credentials' });
        }

    if (user.password_reset_required) {
      return res.status(403).send({ error: 'password_reset_required' });
    }

    const token = generateToken(buildJwtClaims({
      user_id: user.user_id,
      email: user.email,
      role: user.role,
      org_id: user.org_id,
      org_name: user.org_name,
    }));
    setAuthCookies(req, res, token);
    addAuditLog(user, 'auth.login.success', user.user_id, { ip: req.ip }, user.org_id).catch(() => {});
    return res.json({ user: { id: user.user_id, email: user.email, role: user.role, org_id: user.org_id, org_name: user.org_name } });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: 'Internal error' });
  }
});

router.post('/signup', requireLocalAuth, authSignupLimiter, async (req, res) => {
    const validation = SignupRequestSchema.safeParse(req.body);
    if (!validation.success) {
        return res.status(400).send({ error: 'Invalid request', details: validation.error.issues });
    }

    const { email, password, org_name, plan, referral_code } = validation.data;

    try {
        // SIGNUP_MODE (config/selfHosted.js). invite_only admits the first
        // account on the install, which becomes its owner, and after that only
        // somebody holding a live invitation for the email they sign up with.
        // This route never verifies an email, so on a reachable self-host an
        // open signup is an open door; the invitation token is the proof the
        // owner asked for this person.
        const inviteRequired = () => res.status(403).send({
            error: 'signup_invite_required',
            message: 'Sign-up on this DeerDawn install is by invitation. Ask a workspace owner to invite this email address, then open the link from the invitation.',
        });
        // The first account is claimed under a lock (createFirstAccount), not
        // on the strength of the read in the verdict.
        let firstAccount = false;
        if (signupMode() === 'invite_only') {
            const verdict = await inviteOnlySignupVerdict(email, req.body?.invite_token);
            if (!verdict.allowed) return inviteRequired();
            firstAccount = verdict.reason === 'first_account';
        }

        const existing = await db.query('SELECT * FROM users WHERE email = $1', [email], 'org-system');
        if (existing.rows.length > 0) {
            return res.status(409).send({
                error: 'user_exists',
                message: 'An account with this email already exists.',
            });
        }

        // 1. Create Organization with Trial
        const orgId = `org-${crypto.randomUUID()}`;
        const orgName = org_name || `${email.split('@')[0]}'s Workspace`;
        const trialEndsAt = null;
        const resolvedAccountType = 'organization';
        const requestedPlan = normalizePlanId(plan);
        let resolvedPlan = TRIAL_PLAN;
        const pendingPlan = requestedPlan && isSelfServePlan(requestedPlan) ? requestedPlan : null;

        const isE2ERuntime = process.env.E2E_MODE;
        // Free, or plan_required while the hosted switch
        // HOSTED_FREE_TIER_FOR_NEW_SIGNUPS is off (config/plans.js).
        const subscriptionStatus = isE2ERuntime ? 'active' : newSignupPlanState().subscription_status;
        if (isE2ERuntime) {
            resolvedPlan = 'enterprise';
        }

        // Hashed before any lock is taken: bcrypt is the slow part.
        const passwordHash = await hashPassword(password);
        const userId = `user-${crypto.randomUUID()}`;
        // AUTHZ-001: the first user of a self-provisioned org is the org 'owner' (org-scoped),
        // never platform 'admin'. Platform privileges come only from is_platform_staff.
        const role = 'owner';

        const insertRows = async (query) => {
            await query(
                'INSERT INTO organizations (org_id, name, plan, plan_tier, pending_plan, trial_ends_at, subscription_status, account_type) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
                [orgId, orgName, resolvedPlan, resolvedPlan, pendingPlan, trialEndsAt, subscriptionStatus, resolvedAccountType],
            );
            // 2. Create User
            await query(
                'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
                [userId, email, passwordHash, role, orgId],
            );
        };
        if (firstAccount) {
            if (!(await createFirstAccount(insertRows))) return inviteRequired();
        } else {
            await insertRows((text, params) => db.query(text, params, 'org-system'));
        }

        // The founder's own membership row. Best-effort: the boot backfill is the
        // safety net, and a signup must never fail after its user row exists.
        await workspace.ensureOwnerMembership(orgId, userId).catch((err) => {
            console.warn('[AUTH] owner membership write failed:', err.message);
        });

        if (referral_code) {
            await referralService.recordReferralSignup({
                referredUserId: userId,
                referredOrgId: orgId,
                referralCode: referral_code,
                // One of the two moments an invite may be applied: the account
                // row this attributes was created three statements ago.
                source: 'signup',
            }).catch((err) => {
                console.warn('[AUTH] referral attribution failed:', err.message);
            });
        }

        const user = { id: userId, email, role, org_id: orgId, org_name: orgName };
        const token = generateToken(buildJwtClaims({
          user_id: userId,
          email,
          role,
          org_id: orgId,
          org_name: orgName,
        }));
    
    setAuthCookies(req, res, token);
    res.status(201).json({ user });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: 'Internal error' });
  }
});

router.post('/logout', requireAuth, (req, res) => {
  clearAuthCookies(req, res);
  if (req.actor) addAuditLog(req.actor, 'auth.logout', req.actor.id, {}, req.actor.org_id).catch(() => {});
  res.status(204).send();
});

// RETIRED: the legacy invite redemption. It matched users.invite_token_hash, the
// token POST /api/v1/orgs/users minted (also retired). That column also carries
// password-reset tokens, and this route accepted a NULL expiry, so it doubled as
// a second, laxer way to spend a reset link. Workspace invitations live in
// workspace_invites and are redeemed by POST /api/v1/teams/invite/accept.
router.post('/invite/accept', (req, res) => {
  res.status(410).json({
    error: 'gone',
    message: 'This endpoint has been removed. Accept a workspace invitation with POST /api/v1/teams/invite/accept while signed in.',
    replacement: '/api/v1/teams/invite/accept',
  });
});

// Password reset TTL: 1 hour
const PASSWORD_RESET_TTL_MINUTES = 60;

// Wire up a real email sender by setting RESET_EMAIL_WEBHOOK_URL (POST with { to, reset_url })
// or implement sendPasswordResetEmail() below with your preferred provider (Resend, SendGrid, etc.)
async function sendPasswordResetEmail(email, resetUrl) {
    const webhookUrl = process.env.RESET_EMAIL_WEBHOOK_URL;
    if (webhookUrl) {
        const axios = require('axios');
        await axios.post(webhookUrl, { to: email, reset_url: resetUrl }, { timeout: 5000 });
        return;
    }
    if (isSelfHosted()) {
        // A self-host with Resend configured gets a real email; one without it
        // gets the link in its own log, where the operator (the only person who
        // can read that log) hands it over. Hosted production never reaches
        // here: it keeps LOG-02's fail-closed rule below.
        const { sendEmail } = require('../../services/email/resendClient');
        const safeUrl = String(resetUrl).replace(/"/g, '&quot;');
        const result = await sendEmail({
            to: email,
            subject: 'Reset your DeerDawn password',
            html: `<p>Somebody asked to reset the password for this address on DeerDawn.</p><p><a href="${safeUrl}">Choose a new password</a></p><p>The link expires in ${PASSWORD_RESET_TTL_MINUTES} minutes. If you did not ask for it, ignore this email.</p>`,
            emailType: 'password_reset',
        }).catch(() => null);
        if (result?.ok) return;
        console.info(`[AUTH] Password reset for ${email} was not emailed (no email transport configured). Reset link: ${resetUrl}`);
        return;
    }
    // LOG-02: a reset URL carries a live, single-use credential and must NEVER be logged
    // in production. In production with no email channel configured, fail closed.
    if (process.env.NODE_ENV === 'production') {
        throw new Error('No reset email channel configured (set RESET_EMAIL_WEBHOOK_URL)');
    }
    // Dev convenience only: emit the link to a developer running locally, gated explicitly.
    if (process.env.ALLOW_INSECURE_EMAIL_LOGGING === 'true') {
        console.log(`[AUTH] (dev) Password reset link for ${email}: ${resetUrl}`);
    } else {
        console.log('[AUTH] Password reset requested; configure RESET_EMAIL_WEBHOOK_URL to deliver links (set ALLOW_INSECURE_EMAIL_LOGGING=true to print locally).');
    }
}

router.post('/forgot-password', requireLocalAuth, authSignupLimiter, async (req, res) => {
    const validation = ForgotPasswordRequestSchema.safeParse(req.body);
    if (!validation.success) {
        return res.status(400).json({ error: 'invalid_request', details: validation.error.issues });
    }

    const { email } = validation.data;

    // Always return success to prevent email enumeration
    res.status(200).json({ message: 'If that email exists, a reset link has been sent.' });

    try {
        const result = await db.query('SELECT user_id FROM users WHERE email = $1', [email], 'org-system');
        if (result.rows.length === 0) return;

        const userId = result.rows[0].user_id;
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
        const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000);

        await db.query(
            'UPDATE users SET invite_token_hash = $1, invite_expires_at = $2 WHERE user_id = $3',
            [tokenHash, expiresAt.toISOString(), userId],
            'org-system'
        );

        const baseUrl = dashboardBaseUrl();
        const resetUrl = `${baseUrl}/reset-password?token=${rawToken}`;
        await sendPasswordResetEmail(email, resetUrl).catch(err => {
            console.error('[AUTH] Failed to send reset email:', err.message);
        });
    } catch (err) {
        console.error('[AUTH] Forgot password error:', err.message);
    }
});

router.post('/reset-password', requireLocalAuth, authLoginLimiter, async (req, res) => {
    const validation = ResetPasswordRequestSchema.safeParse(req.body);
    if (!validation.success) {
        return res.status(400).json({ error: 'invalid_request', details: validation.error.issues });
    }

    const { token, password } = validation.data;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    try {
        const passwordHash = await hashPassword(password);

        const result = await db.query(
            `UPDATE users
             SET password_hash = $1,
                 invite_token_hash = NULL,
                 invite_expires_at = NULL,
                 password_reset_required = FALSE
             WHERE invite_token_hash = $2
               AND invite_expires_at > NOW()
             RETURNING user_id, email`,
            [passwordHash, tokenHash],
            'org-system'
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'invalid_or_expired_token' });
        }

        addAuditLog(result.rows[0].user_id, 'auth.password_reset.completed', result.rows[0].user_id, { ip: req.ip })
            .catch(() => {});
        res.status(200).json({ success: true });
    } catch (err) {
        console.error('[AUTH] Reset password error:', err.message);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({
    user: {
      id: req.actor.id,
      email: req.actor.email,
      role: req.actor.role,
      org_id: req.actor.org_id,
      org_name: req.actor.org_name,
    },
  });
});

module.exports = router;
