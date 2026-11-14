'use strict';

// Unit tests for the server-side Google Ads offline signup-conversion client
// (apps/api/src/services/googleAds.js). Pure/static — no network, no DB: global
// fetch is stubbed so we assert the OAuth exchange + uploadClickConversions
// payload shape without leaving the process.
//
//   node --test tests/google-ads-conversion.test.js

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('assert');

const googleAds = require('../src/services/googleAds');

const REQUIRED_ENV = {
  GOOGLE_ADS_DEVELOPER_TOKEN: 'dev-token',
  GOOGLE_ADS_CLIENT_ID: 'client-id',
  GOOGLE_ADS_CLIENT_SECRET: 'client-secret',
  GOOGLE_ADS_REFRESH_TOKEN: 'refresh-token',
  GOOGLE_ADS_CUSTOMER_ID: '123-456-7890',
  GOOGLE_ADS_SIGNUP_CONVERSION_ACTION_ID: '987654321',
};

function setConfigured() {
  Object.assign(process.env, REQUIRED_ENV);
  googleAds._resetTokenCache();
}

function clearConfigured() {
  for (const k of Object.keys(REQUIRED_ENV)) delete process.env[k];
  delete process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  delete process.env.GOOGLE_ADS_SIGNUP_VALUE;
  googleAds._resetTokenCache();
}

// Swap global.fetch with a recorder; returns { calls, restore }.
function stubFetch(handler) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return handler(url, opts, calls.length);
  };
  return { calls, restore: () => { global.fetch = original; } };
}

test('normalizeCustomerId strips dashes and non-digits', () => {
  assert.strictEqual(googleAds.normalizeCustomerId('123-456-7890'), '1234567890');
  assert.strictEqual(googleAds.normalizeCustomerId(' 111 222 '), '111222');
});

test('formatConversionDateTime emits "yyyy-mm-dd hh:mm:ss+00:00"', () => {
  const s = googleAds.formatConversionDateTime(new Date('2026-07-11T14:29:24.934Z'));
  assert.strictEqual(s, '2026-07-11 14:29:24+00:00');
});

test('no-op (no throw, no fetch) when unconfigured', async () => {
  clearConfigured();
  assert.strictEqual(googleAds.isGoogleAdsConfigured(), false);
  const f = stubFetch(async () => { throw new Error('should not be called'); });
  try {
    await googleAds.trackGoogleAdsSignup({ gclid: 'abc', conversionId: 'u1' });
    assert.strictEqual(f.calls.length, 0, 'fetch must not run when unconfigured');
  } finally {
    f.restore();
  }
});

test('no-op when configured but the signup carried no Google click id', async () => {
  setConfigured();
  const f = stubFetch(async () => { throw new Error('should not be called'); });
  try {
    await googleAds.trackGoogleAdsSignup({ conversionId: 'u1' }); // no gclid/wbraid/gbraid
    assert.strictEqual(f.calls.length, 0, 'fetch must not run without a click id');
  } finally {
    f.restore();
    clearConfigured();
  }
});

test('configured + gclid → OAuth exchange then click-conversion upload with correct shape', async () => {
  setConfigured();
  const f = stubFetch(async (url) => {
    if (String(url).includes('oauth2.googleapis.com')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'at-123', expires_in: 3600 }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ results: [{}] }) };
  });
  try {
    await googleAds.trackGoogleAdsSignup({ gclid: 'GCLID_XYZ', conversionId: 'user_42', eventAt: new Date('2026-07-11T14:29:24Z') });

    assert.strictEqual(f.calls.length, 2, 'expected an OAuth call + an upload call');
    const [oauthCall, uploadCall] = f.calls;
    assert.ok(String(oauthCall.url).includes('oauth2.googleapis.com'), 'first call is the token exchange');

    // Upload targets a supported API version plus the normalized (dashless)
    // customer id. A regression to a sunset version returns HTTP 404 in
    // production and silently drops the best-effort conversion.
    assert.ok(String(uploadCall.url).includes('/v25/customers/1234567890:uploadClickConversions'), uploadCall.url);
    assert.strictEqual(uploadCall.opts.headers['developer-token'], 'dev-token');
    assert.strictEqual(uploadCall.opts.headers.Authorization, 'Bearer at-123');

    const body = JSON.parse(uploadCall.opts.body);
    assert.strictEqual(body.partialFailure, true);
    const conv = body.conversions[0];
    assert.strictEqual(conv.gclid, 'GCLID_XYZ');
    assert.strictEqual(conv.conversionAction, 'customers/1234567890/conversionActions/987654321');
    assert.strictEqual(conv.conversionDateTime, '2026-07-11 14:29:24+00:00');
  } finally {
    f.restore();
    clearConfigured();
  }
});

test('never throws on a network error', async () => {
  setConfigured();
  const f = stubFetch(async () => { throw new Error('network down'); });
  try {
    await assert.doesNotReject(() => googleAds.trackGoogleAdsSignup({ gclid: 'g', conversionId: 'u' }));
  } finally {
    f.restore();
    clearConfigured();
  }
});

// ── Setup conversion (first_sync_completed) ────────────────────────────────

function setSetupConfigured() {
  setConfigured();
  process.env.GOOGLE_ADS_SETUP_CONVERSION_ACTION_ID = '555000111';
}

function clearSetupConfigured() {
  delete process.env.GOOGLE_ADS_SETUP_CONVERSION_ACTION_ID;
  delete process.env.GOOGLE_ADS_SETUP_VALUE;
  clearConfigured();
}

function okFetch() {
  return stubFetch(async (url) => {
    if (String(url).includes('oauth2.googleapis.com')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'at-setup', expires_in: 3600 }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ results: [{}] }) };
  });
}

test('setup: no-op without GOOGLE_ADS_SETUP_CONVERSION_ACTION_ID, even with every signup credential set', async () => {
  setConfigured();
  assert.strictEqual(googleAds.isGoogleAdsSetupConfigured(), false);
  const f = stubFetch(async () => { throw new Error('should not be called'); });
  try {
    await googleAds.trackGoogleAdsSetup({ gclid: 'abc', personId: 'user-1' });
    assert.strictEqual(f.calls.length, 0);
  } finally {
    f.restore();
    clearSetupConfigured();
  }
});

test('setup: does not need the SIGNUP action id', async () => {
  setSetupConfigured();
  delete process.env.GOOGLE_ADS_SIGNUP_CONVERSION_ACTION_ID;
  try {
    assert.strictEqual(googleAds.isGoogleAdsSetupConfigured(), true);
    assert.strictEqual(googleAds.isGoogleAdsConfigured(), false);
  } finally {
    clearSetupConfigured();
  }
});

test('setup: no-op without a stored Google click id', async () => {
  setSetupConfigured();
  const f = stubFetch(async () => { throw new Error('should not be called'); });
  try {
    await googleAds.trackGoogleAdsSetup({ personId: 'user-1' });
    assert.strictEqual(f.calls.length, 0);
  } finally {
    f.restore();
    clearSetupConfigured();
  }
});

test('setup: uploads to the SETUP action with orderId <person>:setup and the event time', async () => {
  setSetupConfigured();
  process.env.GOOGLE_ADS_SETUP_VALUE = '25';
  const f = okFetch();
  try {
    await googleAds.trackGoogleAdsSetup({
      gclid: 'GCLID_SETUP',
      personId: 'user-42',
      eventAt: new Date('2026-10-19T08:00:05Z'),
      signedUpAt: '2026-10-18T10:00:00Z',
    });
    assert.strictEqual(f.calls.length, 2);
    const conv = JSON.parse(f.calls[1].opts.body).conversions[0];
    assert.strictEqual(conv.conversionAction, 'customers/1234567890/conversionActions/555000111');
    assert.strictEqual(conv.gclid, 'GCLID_SETUP');
    assert.strictEqual(conv.orderId, 'user-42:setup');
    assert.strictEqual(conv.conversionDateTime, '2026-10-19 08:00:05+00:00');
    assert.strictEqual(conv.conversionValue, 25);
    assert.strictEqual(conv.currencyCode, 'USD');
  } finally {
    f.restore();
    clearSetupConfigured();
  }
});

test('setup: the signup value never leaks onto a setup conversion', async () => {
  setSetupConfigured();
  process.env.GOOGLE_ADS_SIGNUP_VALUE = '3';
  const f = okFetch();
  try {
    await googleAds.trackGoogleAdsSetup({ wbraid: 'WB', personId: 'user-7' });
    const conv = JSON.parse(f.calls[1].opts.body).conversions[0];
    assert.strictEqual(conv.wbraid, 'WB');
    assert.strictEqual(conv.gclid, undefined);
    assert.strictEqual(conv.conversionValue, undefined);
  } finally {
    f.restore();
    clearSetupConfigured();
  }
});

test('setup: past the 90-day window it still sends, and warns', async () => {
  setSetupConfigured();
  const f = okFetch();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...a) => { warnings.push(a.join(' ')); };
  try {
    await googleAds.trackGoogleAdsSetup({
      gclid: 'OLD',
      personId: 'user-9',
      eventAt: new Date('2026-10-19T00:00:00Z'),
      signedUpAt: '2026-06-01T00:00:00Z',
    });
    assert.strictEqual(f.calls.length, 2, 'Google is the judge of a stale click, not us');
    assert.ok(warnings.some((w) => w.includes('click window')), warnings.join('\n'));
  } finally {
    console.warn = originalWarn;
    f.restore();
    clearSetupConfigured();
  }
});

test('setup: never throws on a network error', async () => {
  setSetupConfigured();
  const f = stubFetch(async () => { throw new Error('network down'); });
  try {
    await assert.doesNotReject(() => googleAds.trackGoogleAdsSetup({ gclid: 'g', personId: 'u' }));
  } finally {
    f.restore();
    clearSetupConfigured();
  }
});

test('signup uploads carry no orderId (unchanged behaviour)', async () => {
  setConfigured();
  const f = okFetch();
  try {
    await googleAds.trackGoogleAdsSignup({ gclid: 'G', conversionId: 'user_1' });
    const conv = JSON.parse(f.calls[1].opts.body).conversions[0];
    assert.strictEqual(conv.orderId, undefined);
    assert.strictEqual(conv.conversionAction, 'customers/1234567890/conversionActions/987654321');
  } finally {
    f.restore();
    clearConfigured();
  }
});
