const { newSignupPlanState } = require('../config/plans');
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { Webhook } = require('svix');
const db = require('../config/db');
const { generateApiKey } = require('../utils/security');
const { redis: redisClient } = require('../config/redis');
const erasure = require('../services/dataErasureService');
const { purgeOwnerData } = erasure;
const stripeService = require('../services/stripeService');
const { cancelSubscriptionForDeletion } = stripeService;
const { reportSwallowed } = require('../utils/reportSwallowed');
const { recordProductEvent } = require('../services/productEventsService');
const { aliasUser } = require('../services/posthog');
const { trackRedditSignup } = require('../services/reddit');
const { trackGoogleAdsSignup } = require('../services/googleAds');
const { resolveConnectorSignupProps } = require('../services/connectorSignupAttribution');
const shareService = require('../services/shareService');
const referralService = require('../services/referralService');
const workspace = require('../services/workspaceService');
const apiKeyCache = require('../services/apiKeyCache');
const { primaryClerkEmail } = require('../utils/clerkEmail');

const CLERK_WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET;
const CLERK_EVENT_TTL_SECONDS = 24 * 60 * 60;
const SANDBOX_KEY_NAME = 'Default Sandbox Key';
// How old a row user.created may still finish. Svix gives up on a message
// after about a day and a half of retries, so a week covers every delivery of
// a real race. It exists to refuse the other way a Clerk identity can already
// have a row: syncUser adopting a long-standing local account by email, which
// is not a new signup and must not be counted as one.
const SKIPPED_SIGNUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Auto-generate the starter sandbox API key, inside the caller's transaction.
async function insertSandboxKey(client, userId, orgId) {
    const { key, prefix, hash } = generateApiKey();
    const keyId = `key-${crypto.randomUUID()}`;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 90); // 90-day expiration

    await client.query(
        `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
        [keyId, prefix, hash, SANDBOX_KEY_NAME, userId, orgId, 'sandbox', expiresAt.toISOString(), ['context:read', 'context:write'], 'active']
    );
    return { key, prefix };
}

// user.created found a row it did not create. Returns the starter key when
// this delivery has claimed the once-per-account work that row is missing,
// null when there is nothing to do.
//
// The claim is the sandbox key: the creating delivery writes it in the same
// transaction as the user row, and this writes it here, so its presence means
// the work is done or owned. The advisory lock makes two deliveries that both
// arrive after syncUser serialize on it instead of both claiming. An
// account_created already on record is checked too, so a key revoked or
// removed later can never bring the signup events back.
async function claimSkippedSignupWork(client, user) {
    if (!user.org_id) return null;
    const createdAt = user.created_at ? new Date(user.created_at).getTime() : NaN;
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > SKIPPED_SIGNUP_WINDOW_MS) return null;

    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`signup-finish:${user.user_id}`]);
    const done = await client.query(
        `SELECT 1 FROM api_keys WHERE owner_id = $1 AND name = $2
         UNION ALL
         SELECT 1 FROM product_events WHERE user_id = $1 AND event_name = 'account_created'
         LIMIT 1`,
        [user.user_id, SANDBOX_KEY_NAME]
    );
    if (done.rows.length > 0) return null;
    return insertSandboxKey(client, user.user_id, user.org_id);
}

/**
 * Clerk Webhook Handler (Task 10: User Sync)
 */
router.post('/clerk', express.raw({ type: 'application/json' }), async (req, res) => {
    const svixId = req.headers['svix-id'];
    const svixTimestamp = req.headers['svix-timestamp'];
    const svixSignature = req.headers['svix-signature'];
    if (!svixId || !svixTimestamp || !svixSignature) {
        return res.status(400).json({ error: 'missing_signature_headers' });
    }

    if (!CLERK_WEBHOOK_SECRET) return res.status(500).json({ error: 'Webhook secret not configured' });

    const payload = req.body.toString();
    const wh = new Webhook(CLERK_WEBHOOK_SECRET);
    let evt;

    try {
        evt = wh.verify(payload, { 'svix-id': svixId, 'svix-timestamp': svixTimestamp, 'svix-signature': svixSignature });
    } catch (err) {
        return res.status(400).json({ error: 'Invalid signature' });
    }

    const { id, email_addresses, first_name, last_name } = evt.data;
    const eventType = evt.type;
    // THE REPLAY KEY IS THE svix-id HEADER, NOT ANYTHING IN THE BODY.
    //
    // This used to key on `evt.id`. A Clerk event body is
    // { data, object: 'event', type, timestamp, instance_id } — it has no
    // top-level id — so the key was always null, every guarded cache call
    // below was skipped, and the replay cache had never once recorded or
    // refused a delivery. It looked wired because the tests that "covered" it
    // matched the source text for the template string.
    //
    // svix-id is the message id: Svix sends the SAME value on every retry of
    // one message and a different one for every distinct message, and it is
    // part of what the signature above covers, so a verified request cannot
    // carry somebody else's. A body hash would collapse two genuinely distinct
    // events with identical payloads (two user.updated deliveries that both
    // describe the current state); a timestamp changes between retries of the
    // same message. Neither is an identity. This is.
    const eventCacheKey = `clerk:webhook:${svixId}`;
    const markProcessed = () => redisClient
        .setex(eventCacheKey, CLERK_EVENT_TTL_SECONDS, '1')
        .catch(() => {});

    try {
        const alreadyProcessed = await redisClient.get(eventCacheKey);
        if (alreadyProcessed) {
            return res.json({ success: true, duplicate: true });
        }
    } catch (redisErr) {
        // Fails open on purpose: every branch below is idempotent against the
        // database on its own, so a missing cache costs a repeated no-op, while
        // refusing deliveries because Redis is down would cost signups.
        console.error('[AUTH] Failed to check Clerk webhook replay cache:', redisErr.message);
    }

    if (eventType === 'user.created') {
        let client;
        try {
            // Get primary email
            const primaryEmail = email_addresses?.find(e => e.id === evt.data.primary_email_address_id)?.email_address;
            if (!primaryEmail) {
                console.error('No primary email found for user:', id);
                return res.status(400).json({ error: 'no_email' });
            }

            client = await db.pool.connect();
            await client.query('BEGIN');

            const existingUser = await client.query(
                'SELECT user_id, org_id, created_at FROM users WHERE auth_provider = $1 AND auth_subject = $2 LIMIT 1',
                ['clerk', id]
            );

            const userName = [first_name, last_name].filter(Boolean).join(' ') || primaryEmail.split('@')[0];
            let orgId;
            let userId;
            let key;
            let prefix;

            if (existingUser.rows.length > 0) {
                // THE ROW EXISTING DOES NOT MEAN THE SIGNUP WAS FINISHED.
                //
                // The dashboard's first request (syncUser's JIT path) can
                // create this row before this delivery arrives. Returning here
                // then skipped everything below that only this handler does:
                // the starter key, its one-time onboarding display and the
                // authoritative account_created / signup_completed events, so
                // every signup that lost this race was invisible to the
                // signup count. Do that work now, once: the sandbox key is the
                // claim, written inside this transaction under a per-user
                // lock, so a Clerk retry, a concurrent delivery, or the
                // delivery that created the row itself all find it and stop.
                const claim = await claimSkippedSignupWork(client, existingUser.rows[0]);
                if (!claim) {
                    await client.query('COMMIT');
                    await markProcessed();
                    return res.json({ success: true, duplicate: true });
                }
                ({ user_id: userId, org_id: orgId } = existingUser.rows[0]);
                ({ key, prefix } = claim);
                console.log(`[AUTH] User ${id} was provisioned on first request; finishing its signup here`);
            } else {
                orgId = `org-${crypto.randomUUID()}`;
                userId = `user-${crypto.randomUUID()}`;

                // Free, or plan_required while the hosted switch
                // HOSTED_FREE_TIER_FOR_NEW_SIGNUPS is off (config/plans.js).
                const signupPlan = newSignupPlanState();
                await client.query(
                    `INSERT INTO organizations (org_id, name, subscription_status, plan, plan_tier, account_type, trial_ends_at, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
                    [orgId, `${userName}'s Workspace`, signupPlan.subscription_status, signupPlan.plan, signupPlan.plan_tier, 'organization', null]
                );

                // Create user record (note: users table doesn't have 'name' column)
                // AUTHZ-001: org owner (org-scoped), never platform 'admin'.
                await client.query(
                    `INSERT INTO users (user_id, email, role, org_id, auth_provider, auth_subject, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
                    [userId, primaryEmail, 'owner', orgId, 'clerk', id]
                );

                ({ key, prefix } = await insertSandboxKey(client, userId, orgId));
            }

            await client.query('COMMIT');

            // The founder's own membership row, written after COMMIT because
            // workspaceService runs on the pool rather than this transaction.
            // Best-effort: idempotent, and the boot backfill is the safety net.
            await workspace.ensureOwnerMembership(orgId, userId).catch((err) => {
                console.warn('[AUTH] owner membership write failed:', err.message);
            });

            // Store API key in Redis for one-time display (expires in 24 hours)
            try {
                await redisClient.setex(`onboarding:${userId}:api_key`, 86400, key);
            } catch (redisErr) {
                // Non-critical: If Redis is down, user can still see key in API Keys page
                console.error('[AUTH] Failed to store onboarding key in Redis:', redisErr.message);
            }

            await markProcessed();

            console.log(`[AUTH] User ${id} created with org ${orgId} and auto-generated API key ${prefix}`);

            // Authoritative signup signal. The Clerk webhook fires exactly once
            // per real account — for both email/password and OAuth — so unlike the
            // client-side signup_completed (which a redirect can race past) this is
            // the reliable "account created" count, recorded server-side and
            // mirrored to PostHog keyed on the DeerDawn user id. Best-effort:
            // analytics must never fail account creation.
            try {
                const externalAccounts = Array.isArray(evt.data.external_accounts) ? evt.data.external_accounts : [];
                const signupMethod = externalAccounts.length
                    ? String(externalAccounts[0].provider || 'oauth').replace(/^oauth_/, '')
                    : 'password';
                // Clerk E2E/journey signups use the +clerk_test email convention and
                // flow through this exact webhook, so without a marker they inflate
                // account_created as if they were real accounts (5 of 7 in prod were
                // clerk_test). Tag the event AND the PostHog person so these synthetic
                // signups can be filtered out of the funnel instead of polluting it.
                const isTestAccount = /\+clerk_test/i.test(primaryEmail);
                // Attribution + device threaded from the browser via Clerk
                // unsafeMetadata at signup — the only way this server-side webhook
                // (which never sees the browser or its localStorage) can attribute
                // the authoritative account_created event to its ad/keyword + device.
                // Best-effort: the OAuth path may omit it, so every field is optional.
                const unsafe = (evt.data && typeof evt.data.unsafe_metadata === 'object' && evt.data.unsafe_metadata) || {};
                const attribution = (unsafe && typeof unsafe.attribution === 'object' && unsafe.attribution) || {};
                const deviceType = typeof unsafe.device_type === 'string' ? unsafe.device_type : undefined;
                const attrProps = {};
                const initialAttrProps = {};
                // `referral_code` was missing from this list until 2026-08-29, which
                // is the second of the two places the referral chain was cut:
                // attribution.ts captured the code into localStorage first-touch,
                // and then nothing read it back out (MarketingAuthForm's
                // buildAttribution omitted it) and nothing forwarded it here. Both
                // ends now carry it, so a share-driven signup is finally
                // distinguishable from an unattributed one.
                for (const field of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'campaign', 'landing_page', 'referral_code', 'rdt_cid', 'gclid', 'wbraid', 'gbraid']) {
                    const value = attribution[field];
                    if (typeof value === 'string' && value) {
                        attrProps[field] = value;
                        initialAttrProps[`initial_${field}`] = value;
                    }
                }
                if (deviceType) initialAttrProps.initial_device_type = deviceType;

                // Which AI tool this account was created to connect, when the
                // sign-up started on a consent screen (ChatGPT, Claude, Cursor…).
                // The browser forwards only the consent request id; the name is
                // read from the record the authorize endpoint wrote, so it cannot
                // be typed in by whoever is signing up. {} for every other signup.
                const connectorProps = await resolveConnectorSignupProps(redisClient, unsafe.oauth_request_id);
                if (connectorProps.client_name) initialAttrProps.initial_client_name = connectorProps.client_name;

                // Moment 3 of 3 — conversion. Resolve the opaque code the visitor
                // carried in from a share page back to the share that minted it,
                // and bump that share's durable counter.
                //
                // Conversion is a PROPERTY on account_created rather than an event
                // of its own, on purpose: account_created is the single
                // authoritative signup signal for both email and OAuth, so a
                // referred signup can never drift away from the signup count the
                // rest of the funnel uses. A separate share_converted event would
                // be a fourth signup counter, and the last one of those
                // (client-side signup_completed) missed two of every three real
                // signups for months because the OAuth path never reached it.
                //
                // The SHARER is deliberately not put on this event. Rolling
                // conversions up to the accounts that drive them is a server-side
                // join on ref_code, where the owner key already lives; copying one
                // account's identity onto another account's analytics profile buys
                // no measurement and creates a cross-account link that did not
                // need to exist.
                //
                // Synthetic clerk_test journeys are excluded from the counter for
                // the same reason they are tagged on the event: they run nightly
                // against production and would otherwise manufacture a referral
                // programme that nobody used.
                let referredByShare = false;
                if (!isTestAccount) {
                    const referredShare = await shareService
                        .recordShareConversion(attribution.referral_code)
                        .catch(() => null);
                    referredByShare = Boolean(referredShare);
                }

                // An INVITE code (the account-level programme, not a share link).
                // This webhook is the one place every signup passes through, email
                // and OAuth alike. Before 2026-09-16 an invite was only recorded if
                // the new user also reached /select-plan with ?referral_code still
                // in the URL, which most never did, so invites mostly paid nobody.
                // recordReferralSignup refuses a code whose owner has not activated,
                // and grants the new user their 30 days of Pro.
                let referredByInvite = false;
                const inviteCode = typeof attribution.referral_code === 'string' ? attribution.referral_code : '';
                if (!isTestAccount && inviteCode && !shareService.isShareRefCode(inviteCode)) {
                    const referral = await referralService
                        // source: this handler IS account creation — the webhook
                        // fires once, as the account appears. It is one of the
                        // two callers the service accepts a code from.
                        .recordReferralSignup({ referredUserId: userId, referredOrgId: orgId, referralCode: inviteCode, source: 'clerk_webhook' })
                        .catch((err) => {
                            console.warn('[AUTH] invite referral not recorded:', err.message);
                            return null;
                        });
                    referredByInvite = Boolean(referral);
                }

                // Stitch the pre-auth marketing/web person (identified by Clerk's
                // user id `id`) onto the canonical DeerDawn user id, so top-of-funnel
                // visits and post-signup activity are one PostHog person.
                aliasUser({ distinctId: userId, alias: id });
                await recordProductEvent(
                    { type: 'user', id: userId, org_id: orgId },
                    {
                        event_name: 'account_created',
                        source: 'api',
                        surface: 'clerk_webhook',
                        metadata: {
                            signup_method: signupMethod,
                            plan: 'free',
                            is_test: isTestAccount,
                            ...(deviceType ? { device_type: deviceType } : {}),
                            ...attrProps,
                            ...connectorProps,
                            // The one boolean that makes the k-factor numerator a
                            // single filter, without needing to know the ref-code
                            // encoding. `referral_code` (above) keeps the detail.
                            referred_by_share: referredByShare,
                            referred_by_invite: referredByInvite,
                        },
                    },
                    {
                        // Identify the PostHog person so the funnel is sliceable
                        // by identity, not just the anonymous pre-auth session.
                        // is_test on the person lets one filter exclude all of a
                        // test journey's events (add "email contains clerk_test"
                        // to PostHog's internal/test-accounts filter to match too).
                        // initial_* first-touch props let the signup→activation
                        // funnel break down by acquisition source and device.
                        //
                        // These travel in the CONTEXT, not in `metadata`. They used
                        // to be `metadata.$set` / `$set_once`, until the 2026-09-19
                        // hardening of the optionalAuth ingest route dropped every
                        // `$`-prefixed key a caller sends — correctly for callers,
                        // and silently for this one, which is the only place a
                        // person ever gets an identity at all. `context` is built
                        // by the server and never out of a request body, so it is
                        // the one channel a request cannot reach.
                        personProperties: {
                            set: { email: primaryEmail, name: userName, signup_method: signupMethod, is_test: isTestAccount, ...(deviceType ? { device_type: deviceType } : {}) },
                            setOnce: { initial_plan: 'free', ...initialAttrProps },
                        },
                    }
                );

                // signup_completed, emitted from the same authoritative place.
                //
                // It used to be client-only, and only on the email/password branch:
                // the Google path hands off to Clerk's redirect, so nothing on the
                // marketing origin survives to fire it. Measured 2026-08-14 over 30
                // days: 18 people on signup_completed against 64 on account_created,
                // i.e. it missed roughly two of every three real signups, and
                // docs/growth/funnel-tracking.md had to carry a "do not build funnels
                // on this" warning. Emitting it here makes it fire exactly once per
                // real account for BOTH methods, with the same identity, attribution
                // and method as account_created — so the cross-tool funnel (GA4 uses
                // the same event name) finally counts the same signups PostHog does.
                //
                // The client emitters in MarketingAuthForm and ClerkAuthPage were
                // removed in the same change so this does not double-count; their
                // GA4 / Google Ads / Reddit conversions stay client-side, since those
                // need the browser.
                await recordProductEvent(
                    { type: 'user', id: userId, org_id: orgId },
                    {
                        event_name: 'signup_completed',
                        source: 'api',
                        surface: 'clerk_webhook',
                        metadata: {
                            method: signupMethod,
                            signup_method: signupMethod,
                            is_test: isTestAccount,
                            ...(deviceType ? { device_type: deviceType } : {}),
                            ...attrProps,
                            ...connectorProps,
                            referred_by_share: referredByShare,
                            referred_by_invite: referredByInvite,
                        },
                    }
                );

                // Mirror the authoritative signup to Reddit's Conversions API so
                // ad-driven signups are attributed even when the browser pixel is
                // blocked or lost to an OAuth redirect. conversion_id = Clerk user
                // id matches the browser pixel's conversionId so Reddit dedupes the
                // two. Skip synthetic clerk_test journeys. No-op unless the Reddit
                // secrets are set; never throws.
                if (!isTestAccount) {
                    await trackRedditSignup({
                        email: primaryEmail,
                        clickId: typeof attribution.rdt_cid === 'string' ? attribution.rdt_cid : undefined,
                        conversionId: id,
                    });
                    // Mirror the signup to Google Ads via an offline click-conversion
                    // upload keyed on gclid/wbraid/gbraid — but ONLY for OAuth
                    // signups. This is the exact gap: a Google-OAuth signup can't
                    // fire the browser conversion (the marketing origin can't set
                    // the app-origin pending flag), so it converts nowhere. EMAIL
                    // signups already fire the client conversion in MarketingAuthForm,
                    // so firing here too would double-count them. `signupMethod` is
                    // 'password' for email and the provider name for OAuth. No-op
                    // unless the Google Ads secrets are set and the signup carried a
                    // Google click id; never throws.
                    if (signupMethod !== 'password') {
                        const pick = (f) => (typeof attribution[f] === 'string' ? attribution[f] : undefined);
                        await trackGoogleAdsSignup({
                            gclid: pick('gclid'),
                            wbraid: pick('wbraid'),
                            gbraid: pick('gbraid'),
                            conversionId: id,
                        });
                    }
                }
            } catch (analyticsErr) {
                console.error('[AUTH] signup analytics failed (non-fatal):', analyticsErr.message);
            }

        } catch (err) {
            if (client) {
                await client.query('ROLLBACK').catch(() => {});
            }
            console.error('Failed to create user/org on signup:', err);
            return res.status(500).json({ error: 'internal_error' });
        } finally {
            client?.release();
        }
    }

    if (eventType === 'user.updated') {
        // AN EMAIL CHANGE HAS TO LAND SOMEWHERE.
        //
        // This event used to fall through to the unconditional 200 at the
        // bottom, so `users.email` was written once at signup and never again.
        // Somebody who moved their Clerk account to a new address kept
        // receiving lifecycle and digest mail at the old one (possibly a
        // mailbox they no longer control), and a workspace invite sent to the
        // new address matched nobody.
        //
        // Only the email is synced. `users` has no name column, and role/org
        // are DeerDawn's own facts that Clerk does not get to overwrite.
        //
        // STRICT primary: this is about to overwrite a stored address, so an
        // absent or dangling primary pointer means "leave it alone", never
        // "take the first one in the list".
        const newEmail = primaryClerkEmail(evt.data, { strict: true });
        if (!newEmail) {
            await markProcessed();
            return res.json({ success: true, skipped: 'no_primary_email' });
        }

        try {
            // Keyed on the Clerk identity, never on the old email: the address
            // is the thing changing, and matching on it is how one account's
            // update would land on another's row.
            const current = await db.query(
                'SELECT user_id, email FROM users WHERE auth_provider = $1 AND auth_subject = $2 LIMIT 1',
                ['clerk', id], 'org-system'
            );
            const row = current.rows[0];
            if (!row) {
                // No local row yet (user.updated can overtake user.created, and
                // JIT provisioning creates the row on first sign-in with the
                // then-current primary address). Nothing to correct.
                await markProcessed();
                return res.json({ success: true, skipped: 'unknown_user' });
            }
            if (row.email === newEmail) {
                // The common case: user.updated fires for every profile edit,
                // sign-in metadata bump and avatar change. No write.
                await markProcessed();
                return res.json({ success: true, unchanged: true });
            }

            // Look before writing. The unique index would refuse the collision
            // anyway (and the catch below still handles the race where it
            // does), but a refused statement is a FAILURE to the shared DB
            // circuit breaker, and a webhook Clerk may redeliver should not be
            // able to push the main query path towards open. Compared
            // case-insensitively, which the index is not: `A@x.com` beside
            // `a@x.com` is the same mailbox and must not become two accounts.
            const holder = await db.query(
                'SELECT 1 FROM users WHERE lower(email) = lower($1) AND user_id <> $2 LIMIT 1',
                [newEmail, row.user_id], 'org-system'
            );
            if (holder.rows.length > 0) {
                const collision = new Error('email_in_use');
                collision.code = '23505';
                throw collision;
            }

            await db.query(
                'UPDATE users SET email = $1 WHERE user_id = $2',
                [newEmail, row.user_id], 'org-system'
            );
            // The Stripe customer carries the address too, and it is where
            // receipts and dunning mail go. Best-effort: the users row is the
            // change Clerk asked for, and a Stripe outage must not 500 a
            // delivery Clerk would then retry for days.
            try {
                const billing = await stripeService.syncCustomerEmailForPerson({
                    userId: row.user_id, oldEmail: row.email, newEmail,
                });
                if (billing.failed > 0) {
                    reportSwallowed(new Error(`Stripe customer email not updated after a Clerk email change: ${billing.reason}`), {
                        op: 'clerk_user_updated_stripe_email_failed',
                        destructive: false,
                        meta: { auth_subject: id, failed: billing.failed, updated: billing.updated },
                    });
                }
            } catch (stripeErr) {
                reportSwallowed(stripeErr, {
                    op: 'clerk_user_updated_stripe_email_failed',
                    destructive: false,
                    meta: { auth_subject: id },
                });
            }
            await markProcessed();
            console.log(`[AUTH] Clerk user ${id} email updated.`);
            return res.json({ success: true, updated: true });
        } catch (err) {
            // users.email is UNIQUE, and the new address can already belong to
            // ANOTHER DeerDawn account — most often a stale row left by a
            // deleted Clerk identity, sometimes a second live account the same
            // person made.
            //
            // Two things must not happen here.
            //
            // It must not 500. Clerk retries a failed delivery on a backoff
            // schedule for days, and this failure is not transient: the same
            // UPDATE collides every time. That is the user.deleted incident
            // again — the same message ids retried forever, a 27% endpoint
            // error rate, and the real failures buried underneath it.
            //
            // It must not MERGE. Repointing the other row at this identity, or
            // deleting it to make room, hands one account's org, plan and
            // history to whoever now controls an address — the account-takeover
            // shape syncUser's resurrection guard exists to refuse. Which of two
            // accounts should own an address is a decision for a person.
            //
            // So: leave both rows exactly as they are, acknowledge the delivery,
            // and put it in front of a human.
            if (err && err.code === '23505') {
                reportSwallowed(new Error('Clerk email change collides with another account; users.email left unchanged'), {
                    op: 'clerk_user_updated_email_collision',
                    destructive: false,
                    // The Clerk subject identifies the account. The address
                    // itself stays out of the report: it is personal data, and
                    // the subject is enough to find both rows.
                    meta: { auth_subject: id },
                });
                await markProcessed();
                return res.json({ success: true, skipped: 'email_in_use' });
            }
            // Anything else (pool exhausted, breaker open) IS transient, and a
            // retry is exactly what should happen. Not marked processed.
            reportSwallowed(err, {
                op: 'clerk_user_updated_sync',
                destructive: false,
                meta: { auth_subject: id },
            });
            return res.status(500).json({ error: 'sync_failed' });
        }
    }

    if (eventType === 'user.deleted') {
        try {
            // DS-01: resolve the user's org BEFORE deleting the row, then erase the org's data when
            // this was the last member (GDPR right-to-erasure — incl. encrypted credentials/globals).
            const userRow = await db.query(
                'SELECT user_id, org_id FROM users WHERE auth_subject = $1 AND auth_provider = $2',
                [id, 'clerk'], 'org-system'
            );
            const orgId = userRow.rows[0]?.org_id || null;
            const deletedUserId = userRow.rows[0]?.user_id || null;

            // THE PERSON IS GONE. THE WORKSPACE MAY NOT BE.
            //
            // Erase what belongs to the person everywhere, before deciding
            // anything about the workspace they founded — and BEFORE deleting
            // the users row, which is the ordering this got wrong.
            //
            // api_keys.owner_id is a foreign key onto users.user_id. Deleting
            // the users row first took the key rows with it, so the revoke that
            // followed matched nothing, read back nothing, and invalidated
            // nothing — while reporting a clean erasure. On a RETAINED team
            // workspace (the case directly below) that is not cosmetic:
            // requireAuth reads a 5-minute LRU before it reads the database, so
            // the erased person's cached credential went on reading and writing
            // their colleagues' workspace over MCP for up to the full TTL. A
            // credential that outlives the account it belongs to is the exact
            // thing a right-to-erasure request is about.
            //
            // So: enumerate the hashes, revoke the rows, drop the cache — then
            // delete the person. Dropping their memberships matters for a second
            // reason: workspace_members has no FK to `users`, so without it the
            // deleted founder still counts as an active member of their own
            // workspace and the guard below would refuse every purge it should
            // perform.
            //
            // The person's IDENTITIES are read here too, for the same reason:
            // project rows written before attribution named people carry the
            // key id in owner_user_id, and the key rows go with the users row.
            let identities = deletedUserId ? [deletedUserId] : [];

            // EVERY OTHER WORKSPACE NOBODY BUT THIS PERSON IS LEFT IN. Read
            // now, while their membership rows still exist — forgetPerson
            // below hard-deletes them, and after that "the workspaces they
            // were the last one in" has no answer. Closed further down, after
            // the home org; see the block before erasePersonData. Without this
            // a second workspace everybody else had left survived the erasure
            // with its data and a live subscription, on a roster of tombstones
            // nobody could manage or cancel it from.
            let alsoClosing = [];
            if (deletedUserId) {
                alsoClosing = await workspace.listSoleMemberWorkspaces(
                    [deletedUserId],
                    { exclude: orgId ? [orgId] : [] }
                ).catch((listErr) => {
                    reportSwallowed(listErr, {
                        op: 'erasure_sole_workspace_list_failed',
                        destructive: true,
                        meta: { user_id: deletedUserId },
                    });
                    return [];
                });
            }

            if (deletedUserId) {
                // Read while the rows still exist. Best-effort: an erasure must
                // not stop because the cache cannot be told about it.
                const keyIds = await db.query(
                    'SELECT key_id FROM api_keys WHERE owner_id = $1',
                    [deletedUserId], 'org-system'
                ).then((r) => r.rows.map((row) => row.key_id).filter(Boolean)).catch(() => []);
                identities = [...new Set([...identities, ...keyIds])];
                const keyHashes = await db.query(
                    'SELECT key_hash FROM api_keys WHERE owner_id = $1',
                    [deletedUserId], 'org-system'
                ).then((r) => r.rows.map((row) => row.key_hash).filter(Boolean)).catch((readErr) => {
                    reportSwallowed(readErr, {
                        op: 'erasure_key_enumerate_failed',
                        destructive: true,
                        meta: { user_id: deletedUserId },
                    });
                    return [];
                });
                await db.query(
                    'UPDATE api_keys SET status = $2 WHERE owner_id = $1 AND status = $3',
                    [deletedUserId, 'revoked', 'active'], 'org-system'
                ).catch((keyErr) => {
                    reportSwallowed(keyErr, {
                        op: 'erasure_key_revoke_failed',
                        destructive: true,
                        meta: { user_id: deletedUserId },
                    });
                });
                // The revoke changes a column requireAuth may not read for
                // another five minutes. This is what actually ends the session.
                for (const hash of keyHashes) {
                    await apiKeyCache.invalidateApiKey(hash).catch((cacheErr) => {
                        reportSwallowed(cacheErr, {
                            op: 'erasure_key_cache_invalidate_failed',
                            destructive: true,
                            meta: { user_id: deletedUserId },
                        });
                    });
                }
                await workspace.forgetPerson(deletedUserId).catch((memberErr) => {
                    reportSwallowed(memberErr, {
                        op: 'erasure_membership_drop_failed',
                        destructive: true,
                        meta: { user_id: deletedUserId },
                    });
                });
            }

            await db.query('DELETE FROM users WHERE auth_subject = $1 AND auth_provider = $2', [id, 'clerk'], 'org-system');

            // Whether the workspace purge below ran. When it did not (the
            // workspace was retained for its other members, or the person had
            // no org), the person-keyed erasure still has to happen: it is the
            // PERSON who asked to be erased.
            let personErased = false;
            if (orgId) {
                const remaining = await db.query('SELECT 1 FROM users WHERE org_id = $1 LIMIT 1', [orgId], 'org-system');

                // THE MEMBER GUARD BOTH INTERACTIVE DELETE ROUTES ALREADY CARRY.
                //
                // `users.org_id` does NOT enumerate a workspace. An invited
                // teammate's users row keeps pointing at their own personal org
                // — that is the whole reason workspace_members exists — so for
                // every shared workspace the `remaining` check above returns
                // zero while colleagues are still working in it. A founder
                // deleting their Clerk identity therefore purged the entire
                // TEAM: everyone's projects, sessions, graph, integration
                // credentials and keys, from a webhook, with no confirmation
                // and nothing to appeal to.
                //
                // DELETE /api/v1/context/account and DELETE /api/v1/orgs both
                // refuse outright while other members exist ("remove them
                // first, or leave the workspace"). This path cannot refuse —
                // the Clerk identity is already gone and there is nobody left
                // to retry — so it does the other half: erase the PERSON
                // (above) and RETAIN the workspace.
                //
                // Retain rather than transfer. Promoting the longest-tenured
                // member would hand somebody billing authority and read access
                // to `private` projects they could not read yesterday, as a
                // side effect of another person's account deletion; that is a
                // privilege grant, and a privilege grant is a decision a human
                // takes. So the workspace is left intact and under-administered
                // rather than either destroyed or silently re-owned, and the
                // report below is what gets a human to transfer it deliberately.
                //
                // Fails CLOSED: if the member count cannot be read, assume the
                // workspace is shared and skip the purge. An unpurged workspace
                // is a support ticket; a wrongly purged one is not recoverable.
                const otherMembers = await workspace.countActiveMembers(orgId).catch((countErr) => {
                    reportSwallowed(countErr, {
                        op: 'erasure_member_count_failed',
                        destructive: true,
                        meta: { org_id: orgId },
                    });
                    return 1;
                });

                if (otherMembers > 0) {
                    // Not an error, but nobody may own this workspace any more
                    // and it may still be billing a card. It has to reach a
                    // person, not a log line.
                    //
                    // "May own" was doing too much work: forgetPerson has just
                    // hard-deleted the founder's membership, so the retained
                    // workspace is frequently left with NO owner at all — nobody
                    // who can invite, bill, or reach the erased person's
                    // projects — and the report said only how many members
                    // remain, which reads like a healthy team. Counted rather
                    // than implied, and counted after the drop so it is the
                    // number a human will find when they look.
                    const ownersLeft = await workspace.countActiveOwners(orgId).catch(() => null);
                    reportSwallowed(
                        new Error(ownersLeft === 0
                            ? 'workspace retained with NO OWNER: its founder was deleted and other members remain'
                            : 'workspace retained: its founder was deleted but other members remain'),
                        {
                            op: 'erasure_skipped_shared_workspace',
                            destructive: false,
                            meta: {
                                org_id: orgId,
                                active_members: otherMembers,
                                owners_remaining: ownersLeft,
                                deleted_user_id: deletedUserId,
                            },
                        }
                    );
                }

                if (remaining.rows.length === 0 && otherMembers === 0) {
                    // Cancel the Stripe subscription BEFORE the purge. Unlike the
                    // interactive delete routes this cannot abort — the Clerk
                    // identity is already gone, so there is no "retry" to offer —
                    // but a failure here means a deleted account keeps getting
                    // billed, which must reach someone rather than a log line.
                    const billing = await cancelSubscriptionForDeletion(orgId);
                    if (!billing.ok) {
                        reportSwallowed(new Error(`subscription cancel failed during erasure: ${billing.reason}`), {
                            op: 'erasure_subscription_cancel_failed',
                            destructive: true,
                            meta: { org_id: orgId },
                        });
                    }
                    // The users row is already gone, so purgeOwnerData can no
                    // longer find this person by org_id: it has to be TOLD who
                    // they were, or their personal projects in other people's
                    // workspaces, access logs and product events all survive a
                    // right-to-erasure request that DELETE /account honours.
                    await purgeOwnerData(orgId, {
                        userIds: deletedUserId ? [deletedUserId] : [],
                        identities,
                    });
                    personErased = true;
                    // Do NOT swallow this: a leftover FK row (e.g. integrations) makes the
                    // delete fail, and silently discarding the error meant the org survived a
                    // right-to-erasure request with no log, metric, or alert.
                    try {
                        await db.query('DELETE FROM organizations WHERE org_id = $1', [orgId], 'org-system');
                    } catch (orgDeleteErr) {
                        // The comment above already says not to swallow this.
                        // A console line IS swallowing it — a right-to-erasure
                        // request that half-completed needs to reach someone.
                        reportSwallowed(orgDeleteErr, {
                            op: 'erasure_incomplete_org_delete',
                            destructive: true,
                            meta: { org_id: orgId },
                        });
                    }
                }
            }

            // The workspaces listed above, through the same sequence the
            // interactive close uses (erasure.closeWorkspaceInTransaction):
            // re-home anybody still pointing at it, purge it, delete its org
            // row, in one transaction per workspace. Billing first and, as for
            // the home org above, a failed cancel cannot stop an erasure that
            // is not refusable — it is reported instead. A close that fails
            // rolls back whole (the workspace survives intact) and is reported
            // as destructive: a right-to-erasure request half-honoured has to
            // reach a person.
            //
            // The doors shut before the billing call: markWorkspaceClosing
            // re-checks, under the membership lock, that nobody else is in the
            // workspace and marks it so addMember refuses every join from then
            // on. Cancelling first let somebody join in between, the close
            // rolled back, and a live team kept going with its subscription
            // already cancelled (scan 28). A workspace somebody got into since
            // it was listed is theirs now: neither cancelled nor closed.
            for (const ws of alsoClosing) {
                let marked = false;
                try {
                    marked = await workspace.markWorkspaceClosing(ws.id, identities);
                } catch (markErr) {
                    reportSwallowed(markErr, {
                        op: 'erasure_sole_workspace_close_failed',
                        destructive: true,
                        meta: { org_id: ws.id, deleted_user_id: deletedUserId },
                    });
                    continue;
                }
                if (!marked) {
                    reportSwallowed(new Error(`workspace ${ws.id} gained a member before it could be closed; left open with its subscription`), {
                        op: 'erasure_sole_workspace_gained_member',
                        destructive: false,
                        meta: { org_id: ws.id, deleted_user_id: deletedUserId },
                    });
                    continue;
                }
                const wsBilling = await cancelSubscriptionForDeletion(ws.id);
                if (!wsBilling.ok) {
                    reportSwallowed(new Error(`subscription cancel failed during erasure: ${wsBilling.reason}`), {
                        op: 'erasure_subscription_cancel_failed',
                        destructive: true,
                        meta: { org_id: ws.id },
                    });
                }
                let closed = null;
                const client = await db.pool.connect();
                try {
                    await client.query('BEGIN');
                    closed = await erasure.closeWorkspaceInTransaction(client, ws.id, { identities });
                    await client.query('COMMIT');
                } catch (closeErr) {
                    await client.query('ROLLBACK').catch(() => {});
                    closed = null;
                    // The workspace survives, so its door opens again (a mark
                    // left behind expires on its own).
                    await workspace.clearWorkspaceClosing(ws.id).catch(() => {});
                    reportSwallowed(closeErr, {
                        op: 'erasure_sole_workspace_close_failed',
                        destructive: true,
                        meta: { org_id: ws.id, deleted_user_id: deletedUserId },
                    });
                } finally {
                    client.release();
                }
                if (closed?.erasure?.runSideEffects) {
                    await closed.erasure.runSideEffects().catch((sideErr) => {
                        console.warn(`[AUTH] post-commit erasure side effects failed for ${ws.id}:`, sideErr.message);
                    });
                }
            }

            if (deletedUserId && !personErased) {
                const report = await erasure.erasePersonData({ userIds: [deletedUserId], identities });
                const failures = Object.entries(report)
                    .filter(([, v]) => typeof v === 'string' && v.startsWith('error:'));
                if (failures.length) {
                    reportSwallowed(new Error(`person erasure incomplete: ${failures.map(([k]) => k).join(', ')}`), {
                        op: 'erasure_person_incomplete',
                        destructive: true,
                        meta: { user_id: deletedUserId },
                    });
                }
            }

            await markProcessed();
            console.log(`[AUTH] Clerk User ${id} deleted and synced.`);
            return res.json({ success: true });
        } catch (err) {
            // This one 500'd on every delivery for months. Clerk retried each
            // event forever, 120 users rows were left pointing at identities
            // that no longer existed, and right-to-erasure silently did not
            // happen. The only trace was a console line nothing watched.
            reportSwallowed(err, {
                op: 'clerk_user_deleted_sync',
                destructive: true,
                meta: { auth_subject: id },
            });
            return res.status(500).json({ error: 'sync_failed' });
        }
    }

    res.json({ success: true });
});

module.exports = router;
