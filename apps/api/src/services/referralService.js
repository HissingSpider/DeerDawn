const crypto = require('crypto');
const db = require('../config/db');
const productEventsService = require('./productEventsService');

// The numbers live in config/plans.js with the rest of the entitlement
// arithmetic; this module only enforces them.
const {
  REFERRAL_REWARD_TIER,
  REFERRAL_REWARD_DAYS,
  REFERRAL_REWARDED_CAP,
  REFERRAL_SIGNUP_SOURCES,
} = require('../config/plans');

// Best-effort funnel telemetry. recordProductEvent writes product_events AND
// mirrors to PostHog; a referral reward must never fail because analytics did,
// so errors are swallowed.
async function emitReferralEvent(actor, eventName, metadata) {
  try {
    await productEventsService.recordProductEvent(actor, { event_name: eventName, source: 'api', metadata });
  } catch (err) {
    console.warn(`[REFERRAL] failed to emit ${eventName}:`, err && err.message);
  }
}

const REFERRAL_CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const REFERRAL_CODE_LENGTH = 8;

// Draw each character directly from the alphabet instead of filtering base64.
//
// The previous implementation was base64url(6 bytes) with [^A-Z0-9] stripped and then
// sliced to 8. base64url's alphabet includes '-' and '_', so any code containing them
// came out SHORTER than 8 — measured at 22% of codes, with a long tail down to 4
// characters. A 4-character code is ~1.7M combinations against a unique index, so this
// was a real entropy problem on a user-shareable code, not just a flaky assertion.
//
// crypto.randomInt is uniform over the range, so there's no modulo bias either.
function generateReferralCode() {
  let out = '';
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i += 1) {
    out += REFERRAL_CODE_ALPHABET[crypto.randomInt(REFERRAL_CODE_ALPHABET.length)];
  }
  return out;
}

// THE RULES (decided 2026-09-16):
//   * Only an ACTIVATED account can refer: one whose context has actually
//     reached an AI session (first_sync_completed). An account that never used
//     the product has nothing to vouch for, and letting it mint links turns the
//     programme into a free-Pro generator for throwaway signups.
//   * The person who was referred gets REFERRAL_REWARD_DAYS of Pro at signup, so
//     the invite's promise ("a free month of Pro on me") is true on arrival.
//   * The referrer gets REFERRAL_REWARD_DAYS per referral, but only when that
//     person activates (their own first sync). Paying on activation rather than
//     signup is what makes fake signups worthless.
//   * (2026-09-18) A code counts ONLY while the account is being created, and a
//     referrer is paid for at most REFERRAL_REWARDED_CAP referrals. Without
//     either rule one person could farm the programme: sock-puppet accounts
//     stacked unbounded Pro onto the referrer, and an authenticated account
//     could attach somebody's code to itself long after signup (the
//     /orgs/account-type handoff took one from any caller, at any time).
// Before this, both sides were paid on signals as weak as loading the dashboard
// with a project, creating a project or holding an API key, and a client-callable
// endpoint could trigger the reward directly.
async function isActivatedUser(userId, orgId = null) {
  if (!userId) return false;
  const result = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM product_events
        WHERE (user_id = $1 OR ($2::text IS NOT NULL AND org_id = $2 AND user_id IS NULL
                AND (SELECT COUNT(*) FROM workspace_members wm WHERE wm.owner_key = $2) <= 1))
          AND event_name = 'first_sync_completed'
     ) AS activated`,
    [userId, orgId],
    'org-system'
  );
  return Boolean(result.rows[0]?.activated);
}

async function ensureReferralCode(actor) {
  if (!actor?.id) throw new Error('missing_actor_id');
  const existing = await db.query(
    'SELECT referral_code FROM users WHERE user_id = $1',
    [actor.id],
    'org-system'
  );
  const current = existing.rows[0]?.referral_code;
  if (current) return current;

  let code = generateReferralCode();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const result = await db.query(
        'UPDATE users SET referral_code = $1 WHERE user_id = $2 RETURNING referral_code',
        [code, actor.id],
        'org-system'
      );
      return result.rows[0]?.referral_code || code;
    } catch (err) {
      if (!String(err.message || '').toLowerCase().includes('duplicate')) throw err;
      code = generateReferralCode();
    }
  }
  throw new Error('referral_code_generation_failed');
}

/**
 * How much of the programme a referrer has already been given.
 *
 * `granted` counts every referral that has already cost the programme
 * something — the referred side is paid AT SIGNUP, so a row in 'signed_up'
 * has already handed out REFERRAL_REWARD_DAYS even though the referrer has not
 * been paid yet. `rewarded` counts the ones that went the whole way and paid
 * the referrer. 'fraud_hold' and 'expired' rows paid nobody and are not
 * counted. One query, because two round trips to answer one question on the
 * signup path is two chances to be slow.
 */
// A 'signed_up' row that never activates used to count against the cap FOREVER.
// The cap exists to bound what a farmer can extract, and a rolling window bounds
// that just as well (CAP free months per window); counting for all time instead
// meant an honest referrer whose first few invitees signed up and wandered off
// could never refer anybody again, with no way to clear it. Rows that went on to
// activate or be rewarded are real referrals and always count.
const REFERRAL_SIGNUP_WINDOW_DAYS = 90;

async function countReferralGrants(referrerUserId) {
  const result = await db.query(
    `SELECT
       COUNT(*) FILTER (
         WHERE status IN ('activated', 'rewarded')
            OR (status = 'signed_up' AND created_at > NOW() - make_interval(days => $2))
       ) AS granted,
       COUNT(*) FILTER (WHERE status = 'rewarded') AS rewarded
     FROM referrals
      WHERE referrer_user_id = $1`,
    [referrerUserId, REFERRAL_SIGNUP_WINDOW_DAYS],
    'org-system'
  );
  const row = result.rows[0] || {};
  return {
    granted: Number(row.granted || 0),
    rewarded: Number(row.rewarded || 0),
  };
}

/**
 * Attribute a signup to an invite code.
 *
 * `source` names the moment this is being called from and MUST be one of
 * REFERRAL_SIGNUP_SOURCES. It is not decoration: an invite is a reason someone
 * created an account, so it can only be applied while the account is being
 * created. Any other caller is refused here rather than trusted to refuse
 * itself — the route that used to accept a code from an authenticated session
 * is exactly the hole this closes.
 */
async function recordReferralSignup({ referredUserId, referredOrgId, referralCode, source }) {
  if (!referralCode) return null;
  const normalizedCode = String(referralCode || '').trim().toUpperCase();
  if (!normalizedCode) return null;

  if (!REFERRAL_SIGNUP_SOURCES.includes(source)) {
    await emitReferralEvent(
      { type: 'user', id: referredUserId, org_id: referredOrgId },
      'referral_ineligible',
      { reason: 'not_at_signup', source: source || 'unspecified' }
    );
    return null;
  }

  const referrer = await db.query(
    `SELECT u.user_id, u.org_id, u.email, u.referral_code
       FROM users u
      WHERE u.referral_code = $1`,
    [normalizedCode],
    'org-system'
  );
  const row = referrer.rows[0];
  if (!row || row.user_id === referredUserId || row.org_id === referredOrgId) {
    return null;
  }
  // A code minted before the activation rule existed can still be in the wild.
  // It attributes nothing until its owner has activated.
  if (!(await isActivatedUser(row.user_id, row.org_id))) {
    await emitReferralEvent(
      { type: 'user', id: referredUserId, org_id: referredOrgId },
      'referral_ineligible',
      { reason: 'referrer_not_activated', referrer_org_id: row.org_id }
    );
    return null;
  }

  // The ceiling. Checked BEFORE the row is written, because the row itself is
  // what grants the referred side its 30 days — attributing first and refusing
  // to pay later would still hand a farmer a free month per puppet.
  const grants = await countReferralGrants(row.user_id);
  if (grants.granted >= REFERRAL_REWARDED_CAP) {
    await emitReferralEvent(
      { type: 'user', id: referredUserId, org_id: referredOrgId },
      'referral_ineligible',
      {
        reason: 'referrer_cap_reached',
        referrer_org_id: row.org_id,
        cap: REFERRAL_REWARDED_CAP,
        granted: grants.granted,
      }
    );
    return null;
  }

  const referralId = `ref_${crypto.randomUUID()}`;
  // ON CONFLICT DO NOTHING against the (referred_user_id, referred_org_id) unique index is
  // what actually closes the duplicate-referral race — the caller's SELECT-then-INSERT check
  // is advisory only. If nothing was inserted, this signup was already attributed; return
  // null so no second reward is emitted.
  const inserted = await db.query(
    `INSERT INTO referrals
      (referral_id, referral_code, referrer_user_id, referrer_org_id, referred_user_id, referred_org_id, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'signed_up', NOW(), NOW())
     ON CONFLICT (referred_user_id, referred_org_id) DO NOTHING
     RETURNING referral_id`,
    [referralId, normalizedCode, row.user_id, row.org_id, referredUserId, referredOrgId],
    'org-system'
  );
  if (inserted.rows.length === 0) return null;
  await emitReferralEvent(
    { type: 'user', id: referredUserId, org_id: referredOrgId },
    'referral_signup',
    { referral_code: normalizedCode, referrer_org_id: row.org_id }
  );

  // The referred side is paid on arrival.
  const referredExpiry = await extendOrgReferralPremium(referredOrgId);
  await db.query(
    `UPDATE referrals
        SET reward_tier = $2, reward_expires_at = $3::timestamptz, updated_at = NOW()
      WHERE referral_id = $1`,
    [referralId, REFERRAL_REWARD_TIER, referredExpiry],
    'org-system'
  );
  await emitReferralEvent({ type: 'user', id: referredUserId, org_id: referredOrgId }, 'referral_reward_granted',
    { side: 'referred', referral_id: referralId, reward_days: REFERRAL_REWARD_DAYS });

  return {
    referral_id: referralId,
    referral_code: normalizedCode,
    referrer_user_id: row.user_id,
    referrer_org_id: row.org_id,
    referred_user_id: referredUserId,
    referred_org_id: referredOrgId,
    status: 'signed_up',
  };
}

// Stack the reward: each qualified referral ADDS REFERRAL_REWARD_DAYS on top of
// whatever premium the org already has (counting from now if it has lapsed), so
// multiple referrals genuinely accumulate instead of overwriting a flat expiry.
// Returns the resulting expiry so callers can record it on the referral row.
async function extendOrgReferralPremium(orgId, days = REFERRAL_REWARD_DAYS) {
  const result = await db.query(
    `UPDATE organizations
        SET referral_premium_until =
          GREATEST(COALESCE(referral_premium_until, now()), now()) + make_interval(days => $2::int)
      WHERE org_id = $1
      RETURNING referral_premium_until`,
    [orgId, days],
    'org-system'
  );
  return result.rows[0]?.referral_premium_until || null;
}

const ACTIVATION_REASON = 'first_sync';

/**
 * Pay the referrer once the person they referred activates. Called from
 * maybeEmitFirstSyncActivation, the moment first_sync_completed is recorded; it
 * is not reachable from a client and refuses any other reason.
 */
async function activateReferralForActor(actor, activationReason = ACTIVATION_REASON) {
  if (activationReason !== ACTIVATION_REASON) return false;
  if (!actor?.id) return false;
  // Matched on the PERSON. The referred org is their personal org at signup; an
  // MCP actor can arrive scoped to a different workspace key.
  const pending = await db.query(
    `SELECT referral_id, referrer_user_id, referrer_org_id, referred_user_id, referred_org_id, referral_code, status
       FROM referrals
      WHERE referred_user_id = $1
        AND status IN ('pending', 'signed_up')
      ORDER BY created_at ASC
      LIMIT 1`,
    [actor.id],
    'org-system'
  );
  const referral = pending.rows[0];
  if (!referral) return false;
  if (referral.referrer_user_id === actor.id || (actor.org_id && referral.referrer_org_id === actor.org_id)) {
    await db.query(
      `UPDATE referrals
          SET status = 'fraud_hold', updated_at = NOW(), fraud_reason = 'self_referral_blocked'
        WHERE referral_id = $1`,
      [referral.referral_id],
      'org-system'
    );
    return false;
  }

  // Second gate, on the paying side. A row can predate the cap, or have been
  // written while another of this referrer's invitees was activating, so the
  // count is re-read at the moment the money moves. The referral is recorded as
  // 'activated' — it really did activate — but no premium is extended and
  // rewarded_at stays NULL, which is what distinguishes "capped" from "paid".
  const grants = await countReferralGrants(referral.referrer_user_id);
  if (grants.rewarded >= REFERRAL_REWARDED_CAP) {
    await db.query(
      `UPDATE referrals
          SET status = 'activated',
              activation_reason = $2,
              activated_at = NOW(),
              updated_at = NOW()
        WHERE referral_id = $1`,
      [referral.referral_id, activationReason],
      'org-system'
    );
    await emitReferralEvent(
      { type: 'user', id: referral.referrer_user_id, org_id: referral.referrer_org_id },
      'referral_reward_capped',
      { referral_id: referral.referral_id, cap: REFERRAL_REWARDED_CAP, rewarded: grants.rewarded }
    );
    return false;
  }

  await extendOrgReferralPremium(referral.referrer_org_id);
  await db.query(
    `UPDATE referrals
        SET status = 'rewarded',
            activation_reason = $2,
            activated_at = NOW(),
            rewarded_at = NOW(),
            updated_at = NOW()
      WHERE referral_id = $1`,
    [referral.referral_id, activationReason],
    'org-system'
  );
  await emitReferralEvent(
    { type: 'user', id: actor.id, org_id: referral.referred_org_id },
    'referral_activated',
    {
      referral_id: referral.referral_id,
      activation_reason: activationReason,
      referrer_org_id: referral.referrer_org_id,
      reward_days: REFERRAL_REWARD_DAYS,
    }
  );
  await emitReferralEvent({ type: 'user', id: referral.referrer_user_id, org_id: referral.referrer_org_id }, 'referral_reward_granted',
    { side: 'referrer', referral_id: referral.referral_id, reward_days: REFERRAL_REWARD_DAYS });
  return true;
}

async function listReferralOverview(actor) {
  if (!actor?.id) throw new Error('missing_actor_id');
  const eligible = await isActivatedUser(actor.id, actor.org_id || null);
  // No code is minted, or returned, until the account has activated.
  const code = eligible ? await ensureReferralCode(actor) : null;
  const results = await db.query(
    `SELECT referral_id, referral_code, referrer_user_id, referrer_org_id, referred_user_id, referred_org_id,
            status, activation_reason, activated_at, rewarded_at, reward_tier, reward_expires_at, created_at
       FROM referrals
      WHERE referrer_user_id = $1
      ORDER BY created_at DESC
      LIMIT 50`,
    [actor.id],
    'org-system'
  );
  const grants = await countReferralGrants(actor.id);
  return {
    eligible,
    referral_code: code,
    reward_tier: REFERRAL_REWARD_TIER,
    reward_days: REFERRAL_REWARD_DAYS,
    // Surfaced so the invite page can say where somebody stands instead of
    // letting them find the ceiling by running into it.
    reward_cap: REFERRAL_REWARDED_CAP,
    granted_count: grants.granted,
    rewarded_count: grants.rewarded,
    cap_reached: grants.granted >= REFERRAL_REWARDED_CAP,
    referrals: results.rows,
  };
}

module.exports = {
  REFERRAL_REWARD_DAYS,
  isActivatedUser,
  REFERRAL_REWARD_TIER,
  REFERRAL_REWARDED_CAP,
  REFERRAL_SIGNUP_SOURCES,
  countReferralGrants,
  ensureReferralCode,
  recordReferralSignup,
  activateReferralForActor,
  listReferralOverview,
};
