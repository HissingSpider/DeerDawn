/**
 * Share-link referral attribution — the three moments, and what a URL observer
 * can learn from them.
 *
 * Share links existed and were fully built (mint, scan gate, visibility, revoke,
 * public read) but carried NO attribution: the only record a link had ever done
 * anything was an integer `view_count` in Postgres, invisible to the funnel. So
 * "does sharing bring users in" could not be answered at all — not measured
 * badly, not measured.
 *
 * The three moments are now `share_link_created` (identified, the sharer),
 * `share_link_viewed` (anonymous, the stranger) and conversion as a PROPERTY on
 * `account_created` rather than a fourth signup event.
 *
 * What is pinned here is the part that is easy to get wrong later:
 *   1. The referral code is NOT the share token, and is not derived from the
 *      owner. The token authorises reading a private brief; the ref code travels
 *      into query strings, localStorage, Clerk metadata and PostHog. Merging the
 *      two would put read access to a private brief into the analytics pipeline.
 *   2. Codes are per SHARE, not per account, so two links from one person cannot
 *      be correlated back to that person by whoever holds both.
 *   3. The anonymous view must NOT mint a PostHog person. A share link is posted
 *      in public; without the guard, every passer-by and link-preview crawler
 *      becomes a fictional "real user" with one event and no is_test flag —
 *      exactly the 11-people-from-nowhere cliff the device-flow endpoint put on
 *      the activation funnel.
 *   4. The chain from the share page to account_created is intact at BOTH ends.
 *      referral_code was captured first-touch and then dropped twice, so it had
 *      never once reached the webhook.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Patch the PostHog mirror BEFORE anything requires productEventsService, which
// destructures captureProductEvent at require time. shareService pulls it in, so
// this has to come first or the real function is bound.
const posthog = require('../../src/services/posthog');
const captures = [];
posthog.captureProductEvent = (payload) => { captures.push(payload); };

const db = require('../../src/config/db');
const store = require('../../src/store/contextSyncStore');
const entitlementService = require('../../src/services/entitlementService');
const shareService = require('../../src/services/shareService');

const ACTOR = { type: 'user', org_id: 'org-share-ref', id: 'user-sharer' };

// These files explain in prose the defects they fix, so several assertions below
// would match their own documentation. Assert against code only.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const readSrc = (...parts) =>
  stripComments(fs.readFileSync(path.join(__dirname, '..', '..', ...parts), 'utf8'));

function projectFixture() {
  return {
    project_id: 'project_share',
    project_name: 'DeerDawn',
    updated_at: '2026-08-29T00:00:00.000Z',
    context: {
      description: 'AI session memory',
      tech_stack: ['TypeScript', 'Postgres'],
      last_updated: '2026-08-29T00:00:00.000Z',
      shipped: [{ summary: 'Shipped share attribution', shipped_at: '2026-08-29T00:00:00.000Z' }],
      recent_decisions: [],
      open_questions: [],
      landmines: [],
    },
  };
}

// The store is stubbed, not exercised: what is under test is the attribution
// contract, and a real INSERT would only re-test Postgres.
function stubStore() {
  const minted = [];
  store.getProject = async () => projectFixture();
  store.createShareToken = async (row) => {
    minted.push(row);
    return { ...row, created_at: '2026-08-29T00:00:00.000Z', revoked_at: null, view_count: 0, conversion_count: 0 };
  };
  store.recordShareTokenView = async () => {};
  entitlementService.getEntitlementsForExistingOrg = async () => ({
    tier: 'developer_basic',
    features: { trail_share: true },
    limits: {},
  });
  return minted;
}

// recordProductEvent inserts before mirroring, and the emit is fire-and-forget,
// so drain the microtask queue rather than awaiting a promise nobody returns.
async function settle() {
  const originalQuery = db.query;
  db.query = async () => ({ rows: [] });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    db.query = originalQuery;
  }
}

test('Share referral attribution', async (t) => {
  await t.test('the referral code is not the share token, and reveals no account', async () => {
    stubStore();
    db.query = async () => ({ rows: [] });

    const { share } = await shareService.createShare(ACTOR, { project_id: 'project_share' });

    assert.ok(share.ref_code, 'every new share must carry a referral code');
    assert.notStrictEqual(
      share.ref_code, share.token,
      'the ref code must never be the share token — the token is the authorisation to READ the brief, ' +
      'and the ref code is handed to analytics, localStorage and query strings',
    );
    assert.ok(
      !share.token.includes(share.ref_code.replace(/^s_/, '')),
      'the ref code must not be a substring of the token either',
    );

    // Nothing about the owner may be recoverable from the string itself.
    for (const secret of [ACTOR.org_id, ACTOR.id, 'project_share', 'DeerDawn']) {
      assert.ok(
        !share.ref_code.includes(secret),
        `the ref code must not embed ${secret} — an observer of the URL learns nothing about the sharer`,
      );
    }
    assert.match(share.ref_code, /^s_/, 'the prefix is what separates share referrals from any other referral_code');
    await settle();
  });

  await t.test('two links from the same person carry uncorrelatable codes', async () => {
    stubStore();
    db.query = async () => ({ rows: [] });

    const first = await shareService.createShare(ACTOR, { project_id: 'project_share' });
    const second = await shareService.createShare(ACTOR, { project_id: 'project_share' });

    // This is the whole reason the code is per-share rather than per-account. A
    // ?ref=<account_id> would let anyone holding two links posted in two places
    // join them into one identity for free.
    assert.notStrictEqual(
      first.share.ref_code, second.share.ref_code,
      'a per-account code would let an observer correlate every link a person ever posted',
    );
    await settle();
  });

  await t.test('creating a link emits share_link_created against the sharer', async () => {
    stubStore();
    captures.length = 0;

    const { share } = await shareService.createShare(ACTOR, { project_id: 'project_share' });
    await settle();

    const created = captures.find((c) => c.event === 'share_link_created');
    assert.ok(created, 'the k-factor denominator is "distinct accounts that ever share", so creation must emit');
    assert.strictEqual(created.distinctId, 'user-sharer', 'the sharer is signed in and must be identified');
    assert.strictEqual(
      created.orgId, 'org-share-ref',
      'creation is an account-level act and must be groupable by org',
    );
    assert.strictEqual(created.properties.ref_code, share.ref_code);
    assert.ok(
      !('$process_person_profile' in created.properties),
      'an identified sharer is a real person and must keep person processing on',
    );
  });

  await t.test('an anonymous view is counted but mints no person', async () => {
    stubStore();
    captures.length = 0;
    store.getShareTokenByToken = async () => ({
      token: 'tok', owner_key: ACTOR.org_id, project_id: 'project_share',
      visibility: 'public', revoked_at: null, ref_code: 's_abc123',
    });

    const result = await shareService.getPublicShare('tok');
    await settle();

    assert.strictEqual(result.state, 'ok');

    const viewed = captures.find((c) => c.event === 'share_link_viewed');
    assert.ok(viewed, 'the view is the denominator for conversion and must reach PostHog, not just view_count');
    assert.strictEqual(
      viewed.properties.$process_person_profile, false,
      'a stranger opening a public URL must never be promoted to a PostHog person',
    );
    assert.strictEqual(
      viewed.distinctId, 's_abc123',
      'the distinct id must be link-scoped and non-null — posthog-node drops an event with no distinct id',
    );
    assert.ok(
      !viewed.orgId,
      'the sharer\'s org must not be attached to a stranger\'s event — rolling views up to sharers ' +
      'is a server-side join on ref_code, not a cross-account link in analytics',
    );
  });

  await t.test('the public payload hands over the pointer, never the owner', async () => {
    stubStore();
    store.getShareTokenByToken = async () => ({
      token: 'tok', owner_key: ACTOR.org_id, project_id: 'project_share',
      visibility: 'public', revoked_at: null, ref_code: 's_abc123',
    });

    const result = await shareService.getPublicShare('tok');
    await settle();

    assert.strictEqual(result.ref_code, 's_abc123', 'the page needs the pointer to stamp its CTA');

    // What an observer of the response can and cannot learn.
    const serialized = JSON.stringify(result);
    for (const secret of [ACTOR.org_id, ACTOR.id, 'owner_key', 'created_by', 'project_share']) {
      assert.ok(
        !serialized.includes(secret),
        `the public share response must not carry ${secret}`,
      );
    }
  });

  await t.test('an unrecognised referral code is a normal outcome, not an error', async () => {
    let calls = 0;
    store.recordShareTokenConversion = async () => { calls += 1; return null; };

    // Absent, foreign, and malformed codes must not even reach the database:
    // a revoked link, a stale bookmark or a hand-typed guess is ordinary traffic.
    assert.strictEqual(await shareService.recordShareConversion(undefined), null);
    assert.strictEqual(await shareService.recordShareConversion(''), null);
    assert.strictEqual(await shareService.recordShareConversion('gclid-not-a-share'), null);
    assert.strictEqual(await shareService.recordShareConversion('s_'), null);
    assert.strictEqual(calls, 0, 'a non-share referral code must not hit the store at all');

    // A well-formed but unknown code resolves to nothing, still without throwing.
    assert.strictEqual(await shareService.recordShareConversion('s_unknown'), null);
    assert.strictEqual(calls, 1);

    // And a store failure must never take down account creation.
    store.recordShareTokenConversion = async () => { throw new Error('db down'); };
    assert.strictEqual(await shareService.recordShareConversion('s_anything'), null);
  });

  await t.test('share codes cannot collide with the invite programme\'s codes', () => {
    // Two different systems now write the SAME `referral_code` attribution field:
    // this one (per-share, opaque, measurement only) and the older invite
    // programme in referralService.js (per-ACCOUNT, redeemable for 30 days of
    // Pro). They must stay separable, or a share view could be read as an invite
    // redemption and vice versa.
    //
    // They are structurally disjoint: invite codes are drawn from
    // [A-Z0-9]{8} — uppercase and digits only, no underscore — so no invite code
    // can ever begin with a lowercase 's_'. That is what makes
    // `referral_code LIKE 's_%'` an exact discriminator rather than a heuristic.
    const referralSrc = readSrc('src', 'services', 'referralService.js');
    assert.match(
      referralSrc,
      /REFERRAL_CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'/,
      'the invite alphabet must stay free of lowercase and underscore, or the s_ prefix stops discriminating',
    );

    const inviteAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let i = 0; i < 200; i += 1) {
      const code = shareService.mintRefCode();
      assert.ok(
        !code.split('').every((ch) => inviteAlphabet.includes(ch)),
        `a share code must never be mistakable for an invite code (${code})`,
      );
      assert.ok(shareService.isShareRefCode(code));
    }

    // And the conversion path must refuse an invite code outright.
    assert.strictEqual(shareService.isShareRefCode('A1B2C3D4'), false,
      'an invite-programme code must never be treated as a share conversion');
  });

  await t.test('the ref_code lookup index leads with ref_code', () => {
    // Third-repeat landmine: a context_* lookup on a column that leads no index
    // scans every owner's rows and trips the 8s DB breaker. The conversion
    // resolve runs once per signup and filters on ref_code alone.
    const storeSrc = readSrc('src', 'store', 'contextSyncStore.js');
    assert.match(
      storeSrc,
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_context_share_tokens_ref_code ON context_share_tokens\(ref_code\)/,
      'the conversion lookup filters on ref_code, so ref_code must lead its index',
    );
    assert.match(
      storeSrc,
      /SELECT \* FROM context_share_tokens WHERE ref_code = \$1/,
      'resolving a code back to a share is a plain indexed lookup, done server-side only',
    );
    assert.match(
      storeSrc,
      /SET ref_code = 's_' \|\| substr\(md5\(random\(\)::text \|\| token\), 1, 16\)/,
      'links minted before ref codes existed must be backfilled, or an old link in circulation is unattributable forever',
    );
  });

  await t.test('the webhook completes the chain that was cut at both ends', () => {
    const webhook = readSrc('src', 'routes', 'auth-webhooks.js');

    // Break #2 of 2: the forward list omitted referral_code, so even a code that
    // reached Clerk was dropped before account_created.
    assert.match(
      webhook,
      /'campaign', 'landing_page', 'referral_code'/,
      'referral_code must be forwarded from Clerk unsafeMetadata onto account_created',
    );

    // Conversion is a property on the authoritative signup event, never a fourth
    // signup counter — the last one of those missed 2 of every 3 real signups
    // because the OAuth path never reached it.
    assert.ok(
      !/event_name: 'share_converted'/.test(webhook),
      'conversion must not become a separate signup event that OAuth signups can miss',
    );
    assert.match(webhook, /referred_by_share: referredByShare/,
      'account_created must carry the one boolean that makes the numerator a single filter');
    assert.match(webhook, /recordShareConversion\(attribution\.referral_code\)/);
    assert.match(webhook, /if \(!isTestAccount\) \{[\s\S]{0,300}recordShareConversion/,
      'the nightly clerk_test journey must not manufacture a referral programme nobody used');
  });
});
