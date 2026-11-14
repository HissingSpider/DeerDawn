'use strict';

/**
 * THE AD PLATFORM IS NEVER TOLD THAT ONE OF OUR ROBOTS ACTIVATED.
 *
 * maybeEmitFirstSyncActivation mirrors a person's first delivered brief to
 * Reddit's Conversions API as "FirstSync". The signup mirror has always skipped
 * +clerk_test journeys; this one had no gate, so the weekly journey run posted a
 * real FirstSync every Monday. From 2026-08-28 to 2026-09-30 it was the only
 * source of FirstSync conversions Reddit received (8 of 8) — see E-034.
 *
 * Pinned here: a synthetic address or a platform-staff account still records
 * first_sync_completed (our own analytics filters test persons itself) but sends
 * nothing to Reddit; a customer's first sync still does.
 */

const test = require('node:test');
const assert = require('node:assert');

const DB_PATH = require.resolve('../../src/config/db');
const REDDIT_PATH = require.resolve('../../src/services/reddit');
const EVENTS_PATH = require.resolve('../../src/services/productEventsService');
const REFERRAL_PATH = require.resolve('../../src/services/referralService');
const CATCHUP_PATH = require.resolve('../../src/services/sessionCatchupService');

function stub(path, exports) {
  delete require.cache[path];
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

function load(row) {
  const calls = { reddit: [], events: [] };
  stub(DB_PATH, {
    query: async () => ({ rows: [], rowCount: 0 }),
    queryBestEffort: async () => ({ rows: [row] }),
  });
  stub(REDDIT_PATH, {
    trackRedditActivation: async (p) => { calls.reddit.push(p); },
    trackRedditSignup: async () => {},
    isRedditConfigured: () => true,
    REDDIT_ACTIVATION_EVENT: 'FirstSync',
  });
  stub(EVENTS_PATH, {
    recordProductEvent: async (_actor, ev) => { calls.events.push(ev.event_name); },
  });
  stub(REFERRAL_PATH, { activateReferralForActor: async () => {} });
  delete require.cache[CATCHUP_PATH];
  return { svc: require(CATCHUP_PATH), calls };
}

const actor = { type: 'user', id: 'user_1', org_id: 'org_1', workspace_key: 'org_1' };
const flush = () => new Promise((r) => setImmediate(r));

test('a journey address records the first sync and sends Reddit nothing', async () => {
  const { svc, calls } = load({ already: false, email: 'journey+clerk_test_abc@deerdawn.com', is_platform_staff: false, click_id: null });
  assert.equal(await svc.maybeEmitFirstSyncActivation(actor, { tool: 'claude_code' }), true);
  await flush();
  assert.deepStrictEqual(calls.events, ['first_sync_completed']);
  assert.deepStrictEqual(calls.reddit, []);
});

test('platform staff send Reddit nothing, whatever their address', async () => {
  const { svc, calls } = load({ already: false, email: 'someone@example.org', is_platform_staff: true, click_id: null });
  assert.equal(await svc.maybeEmitFirstSyncActivation(actor, { tool: 'chatgpt_web' }), true);
  await flush();
  assert.deepStrictEqual(calls.reddit, []);
});

test('a customer still reaches Reddit, with their click id', async () => {
  const { svc, calls } = load({ already: false, email: 'person@example.org', is_platform_staff: false, click_id: 'cid_9' });
  assert.equal(await svc.maybeEmitFirstSyncActivation(actor, { tool: 'chatgpt_web' }), true);
  await flush();
  assert.equal(calls.reddit.length, 1);
  assert.deepStrictEqual(calls.reddit[0], { email: 'person@example.org', clickId: 'cid_9', conversionId: 'user_1' });
});

test('a missing staff flag is not staff, and a missing email is not synthetic', async () => {
  const { svc, calls } = load({ already: false, email: null, is_platform_staff: null, click_id: null });
  assert.equal(await svc.maybeEmitFirstSyncActivation(actor, { tool: 'chatgpt_web' }), true);
  await flush();
  assert.equal(calls.reddit.length, 1);
});
