'use strict';

/**
 * GOOGLE ADS OPTIMISES TOWARD A REAL SETUP, NOT A COPIED COMMAND.
 *
 * maybeEmitFirstSyncActivation is the one place first_sync_completed is
 * recorded (a person's AI tool actually received a brief). It now mirrors that
 * moment to Google Ads as the SETUP conversion, using the click id stored on
 * the person's account_created event at signup.
 *
 * Pinned here: a customer with a stored gclid sends one setup conversion keyed
 * to them with the first-sync time; no stored click id sends nothing; one of our
 * own (journey / staff) sends nothing; an already-recorded first sync sends
 * nothing; and a Google failure never fails the first sync.
 */

const test = require('node:test');
const assert = require('node:assert');

const DB_PATH = require.resolve('../../src/config/db');
const REDDIT_PATH = require.resolve('../../src/services/reddit');
const GOOGLE_PATH = require.resolve('../../src/services/googleAds');
const EVENTS_PATH = require.resolve('../../src/services/productEventsService');
const REFERRAL_PATH = require.resolve('../../src/services/referralService');
const CATCHUP_PATH = require.resolve('../../src/services/sessionCatchupService');

function stub(path, exports) {
  delete require.cache[path];
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

function load(row, { googleThrows = false } = {}) {
  const calls = { google: [], events: [], sql: [] };
  stub(DB_PATH, {
    query: async () => ({ rows: [], rowCount: 0 }),
    queryBestEffort: async (sql) => { calls.sql.push(sql); return { rows: [row] }; },
  });
  stub(REDDIT_PATH, {
    trackRedditActivation: async () => {},
    trackRedditSignup: async () => {},
    isRedditConfigured: () => true,
    REDDIT_ACTIVATION_EVENT: 'FirstSync',
  });
  stub(GOOGLE_PATH, {
    trackGoogleAdsSetup: async (p) => {
      calls.google.push(p);
      if (googleThrows) throw new Error('google down');
    },
    trackGoogleAdsSignup: async () => {},
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
const customer = { already: false, email: 'person@example.org', is_platform_staff: false, click_id: null };

test('the stored click id is read from account_created in the same query', async () => {
  const { svc, calls } = load({ ...customer, google_click: null });
  await svc.maybeEmitFirstSyncActivation(actor, { tool: 'claude_code' });
  assert.match(calls.sql[0], /'account_created'/);
  assert.match(calls.sql[0], /metadata->>'gclid'/);
  assert.match(calls.sql[0], /AS google_click/);
});

test('a customer with a stored gclid sends one setup conversion at first-sync time', async () => {
  const before = Date.now();
  const { svc, calls } = load({
    ...customer,
    google_click: { gclid: 'GCLID_1', wbraid: null, gbraid: null, signed_up_at: '2026-10-18T10:00:00Z' },
  });
  assert.equal(await svc.maybeEmitFirstSyncActivation(actor, { tool: 'claude_code' }), true);
  await flush();
  assert.deepStrictEqual(calls.events, ['first_sync_completed']);
  assert.equal(calls.google.length, 1);
  const p = calls.google[0];
  assert.equal(p.gclid, 'GCLID_1');
  assert.equal(p.wbraid, undefined);
  assert.equal(p.personId, 'user_1');
  assert.equal(p.signedUpAt, '2026-10-18T10:00:00Z');
  assert.ok(p.eventAt instanceof Date && p.eventAt.getTime() >= before);
});

test('wbraid alone is enough', async () => {
  const { svc, calls } = load({ ...customer, google_click: { gclid: null, wbraid: 'WB', gbraid: null } });
  await svc.maybeEmitFirstSyncActivation(actor, { tool: 'claude_code' });
  await flush();
  assert.equal(calls.google.length, 1);
  assert.equal(calls.google[0].wbraid, 'WB');
});

test('no stored Google click id sends nothing', async () => {
  const { svc, calls } = load({ ...customer, google_click: null });
  assert.equal(await svc.maybeEmitFirstSyncActivation(actor, { tool: 'claude_code' }), true);
  await flush();
  assert.deepStrictEqual(calls.google, []);
});

test('one of ours sends nothing to Google either', async () => {
  const { svc, calls } = load({
    ...customer,
    email: 'journey+clerk_test_x@deerdawn.com',
    google_click: { gclid: 'G' },
  });
  await svc.maybeEmitFirstSyncActivation(actor, { tool: 'claude_code' });
  await flush();
  assert.deepStrictEqual(calls.google, []);
});

test('an already-recorded first sync sends nothing (once per person)', async () => {
  const { svc, calls } = load({ ...customer, already: true, google_click: { gclid: 'G' } });
  assert.equal(await svc.maybeEmitFirstSyncActivation(actor, { tool: 'claude_code' }), false);
  await flush();
  assert.deepStrictEqual(calls.google, []);
  assert.deepStrictEqual(calls.events, []);
});

test('a Google failure never fails the first sync', async () => {
  const { svc, calls } = load({ ...customer, google_click: { gclid: 'G' } }, { googleThrows: true });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await svc.maybeEmitFirstSyncActivation(actor, { tool: 'claude_code' }), true);
    await flush();
  } finally {
    console.warn = warn;
  }
  assert.deepStrictEqual(calls.events, ['first_sync_completed']);
});
