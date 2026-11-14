'use strict';

// Drive /authorize from what real clients ACTUALLY publish and send.
//
// The OAuth suite already had 31 contract tests, including a full
// authorize -> approve -> token exchange, and every one of them still passed
// while `claude mcp add` was a hard 400 for every new user (PR #445). The
// reason is structural, not an oversight: each of those fixtures writes a
// redirect_uri into the client metadata and then sends THAT SAME STRING back —
//
//     redirect_uris: [redirectUri]   ...   redirect_uri: redirectUri
//
// so the registered and the requested value are the same variable. A suite
// built that way is self-consistent by construction and can never detect a gap
// between what a client publishes and what it sends. Claude Code publishes a
// PORTLESS loopback callback and arrives with an ephemeral port, and nothing
// here could see it.
//
// This file closes that by taking both sides from tests/fixtures/oauth-real-clients.json:
// metadata captured verbatim from the live document, and the literal failing
// query string off a real connect attempt. Nothing in it is invented locally,
// which is the whole point — `npm run check:client-metadata` reports when the
// captured side goes stale.

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
process.env.DEERDAWN_API_KEY = process.env.DEERDAWN_API_KEY || 'dev-system-key-aaaaaaaaaaaaaaaaaaaa';
process.env.API_BASE_URL = 'https://api.deerdawn.test';
process.env.DASHBOARD_URL = 'https://app.deerdawn.test';

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

const db = require('../../src/config/db');
// An empty oauth_clients table: every lookup misses. Writes are recorded so a
// test can prove a request did NOT create a registration.
const dbWrites = [];
db.query = async (text) => {
  if (/^\s*(INSERT|UPDATE)/i.test(text)) dbWrites.push(text);
  return { rows: [] };
};

const { redis } = require('../../src/config/redis');
const redisStore = new Map();
redis.set = async (key, value) => { redisStore.set(key, value); return 'OK'; };
redis.get = async (key) => (redisStore.has(key) ? redisStore.get(key) : null);
redis.del = async (...keys) => {
  let deleted = 0;
  keys.flat().forEach((key) => { if (redisStore.delete(key)) deleted += 1; });
  return deleted;
};

const productEvents = require('../../src/services/productEventsService');
const emitted = [];
productEvents.recordProductEvent = async (actor, input) => { emitted.push(input); return input; };
// recordConnectorEvent defers with setImmediate so it never sits in the handshake.
const flush = () => new Promise((resolve) => setImmediate(resolve));

const fixture = require('../fixtures/oauth-real-clients.json');

const oauthRoutes = require('../../src/routes/oauth');
const app = express();
app.use(express.json());
app.use('/', oauthRoutes);

const ISSUER = 'https://api.deerdawn.test';
const CONSENT = 'https://app.deerdawn.test/oauth/consent';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Serve one captured document, keyed by its own source_url, and fail loudly if
// the route asks for anything else — a silently-unstubbed fetch would reach the
// network from a unit test and make the result depend on claude.ai being up.
function serveMetadata(client) {
  const body = JSON.stringify(client.metadata);
  const previous = global.fetch;
  global.fetch = async (url) => {
    assert.equal(String(url), client.source_url, 'route fetched an unexpected metadata URL');
    return {
      ok: true,
      headers: { get: (name) => (name === 'content-length' ? String(Buffer.byteLength(body)) : null) },
      text: async () => body,
    };
  };
  return () => { global.fetch = previous; };
}

function freshRedis() {
  redisStore.clear();
}

function authorizeQuery(clientId, redirectUri) {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    // A real S256 challenge from the observed request; the value is opaque here.
    code_challenge: '9lSFeuiyMwgdadpGN-Al0SZ20B_fDHix4wpN8TTYESE',
    code_challenge_method: 'S256',
    state: 'state-value',
    scope: 'context:read context:write',
    resource: `${ISSUER}/mcp`,
  };
}

// A fixture that lost its contents must fail, not pass vacuously: a `for` loop
// over an empty array asserts nothing and reports green. This is the same
// silent-success shape the OAuth bug itself had.
test('the fixture actually carries real captured clients', () => {
  assert.ok(Array.isArray(fixture.clients) && fixture.clients.length > 0, 'no captured clients');
  assert.ok(
    Array.isArray(fixture.observed_requests) && fixture.observed_requests.length > 0,
    'no observed requests',
  );
  for (const client of fixture.clients) {
    assert.ok(client.source_url.startsWith('https://'), `${client.label}: no source_url`);
    assert.ok(client.captured_at, `${client.label}: undated capture`);
    assert.ok(
      Array.isArray(client.metadata.redirect_uris) && client.metadata.redirect_uris.length > 0,
      `${client.label}: captured metadata declares no redirect_uris`,
    );
  }
});

for (const client of fixture.clients) {
  // Every callback the client publishes must be one it can actually use. A
  // portless loopback entry is a DECLARATION, not a literal: RFC 8252 §7.3 says
  // the client binds a free port at run time, so the ported form is the only
  // form that ever arrives in production.
  test(`${client.label}: every published redirect_uri is accepted as sent`, async () => {
    const restore = serveMetadata(client);
    try {
      for (const declared of client.metadata.redirect_uris) {
        freshRedis();
        const asDeclared = await request(app)
          .get('/api/v1/oauth/authorize')
          .query(authorizeQuery(client.metadata.client_id, declared));
        assert.equal(asDeclared.status, 302, `${declared} (as declared): ${asDeclared.text}`);
        assert.ok(asDeclared.headers.location.startsWith(CONSENT));

        const url = new URL(declared);
        if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) continue;

        // A declared port is no more literal than an omitted one: RFC 8252 §7.3
        // has the client bind a free port at run time, so whether the document
        // publishes a portless form (Claude Code) or one sample port (VS Code
        // publishes 33418), the form that arrives carries a different one.
        url.port = url.port === '3118' ? '3119' : '3118';
        freshRedis();
        const asSent = await request(app)
          .get('/api/v1/oauth/authorize')
          .query(authorizeQuery(client.metadata.client_id, url.toString()));
        assert.equal(
          asSent.status,
          302,
          `${url.toString()} (the form a CLI actually sends): ${asSent.text}`,
        );
        assert.ok(asSent.headers.location.startsWith(CONSENT));
      }
    } finally {
      restore();
    }
  });

  test(`${client.label}: the captured metadata satisfies our CIMD acceptance rules`, async () => {
    // If we silently rejected the document itself, the redirect_uri test above
    // would be asserting nothing about redirect matching at all.
    const restore = serveMetadata(client);
    try {
      freshRedis();
      const res = await request(app)
        .get('/api/v1/oauth/authorize')
        .query(authorizeQuery(client.metadata.client_id, client.metadata.redirect_uris[0]));
      assert.doesNotMatch(res.text || '', /invalid_client/, 'the real document was rejected outright');
      assert.equal(res.status, 302);
    } finally {
      restore();
    }
  });
}

// Every observation must be one this file knows how to replay: an unknown
// `kind` would otherwise be skipped by both loops below and pass vacuously.
test('every observed request has a kind this suite replays', () => {
  for (const observed of fixture.observed_requests) {
    assert.ok(['authorize', 'dcr_registration', 'authorize_after_registration_loss'].includes(observed.kind), `${observed.label}: unknown kind ${observed.kind}`);
  }
});

// A DCR client publishes nothing to capture; what it SENDS is the /register
// body, so that is what is replayed. Cursor's custom-scheme callback was
// refused here outright, before any consent screen (oauth-native-scheme-redirect
// drives the rest of that grant end to end).
for (const observed of fixture.observed_requests.filter((o) => o.kind === 'dcr_registration')) {
  test(`observed registration replays: ${observed.label}`, async () => {
    freshRedis();
    const res = await request(app).post('/api/v1/oauth/register').send(observed.registration_body);
    assert.equal(
      res.status,
      201,
      `this exact registration produced "${observed.outcome_before_fix}" before the fix: ${res.text}`,
    );
    assert.deepEqual(res.body.redirect_uris, observed.registration_body.redirect_uris);
  });
}

for (const observed of fixture.observed_requests.filter((o) => o.kind === 'authorize')) {
  // The literal query string off a real failing connect. Replayed verbatim
  // except for the resource origin, which is origin-bound to the deployment.
  test(`observed request replays: ${observed.label}`, async () => {
    const client = fixture.clients.find(
      (c) => c.metadata.client_id === new URLSearchParams(observed.query).get('client_id'),
    );
    assert.ok(client, `${observed.label}: no captured client matches its client_id`);

    const params = new URLSearchParams(observed.query);
    params.set('resource', params.get('resource').replace(observed.production_origin, ISSUER));

    const restore = serveMetadata(client);
    try {
      freshRedis();
      const res = await request(app).get(`/api/v1/oauth/authorize?${params.toString()}`);
      assert.equal(
        res.status,
        302,
        `this exact request produced "${observed.outcome_before_fix}" in production: ${res.text}`,
      );
      assert.ok(res.headers.location.startsWith(CONSENT));
    } finally {
      restore();
    }
  });
}

// A client_id we issued by DCR and then lost. Before #451 (2026-09-06) Redis was
// a registration's only home, so a restart or eviction erased it, and the client
// — which keeps the id in its own config and never re-registers on its own —
// replayed it into a 400 telling the person to delete the connector and start
// over. PostHog shows exactly that: one client_id rejected 7 times over 11 days.
//
// Both stores are empty here, which is the state such a client meets today: the
// id is in neither the cache nor oauth_clients, and no metadata URL backs it.
for (const observed of fixture.observed_requests.filter((o) => o.kind === 'authorize_after_registration_loss')) {
  test(`observed request replays: ${observed.label}`, async () => {
    const params = new URLSearchParams(observed.query);
    params.set('resource', params.get('resource').replace(observed.production_origin, ISSUER));
    const clientId = params.get('client_id');
    assert.match(clientId, /^mcp_[0-9a-f]{32}$/, 'the replay must use the shape this server issues');

    const previousFetch = global.fetch;
    global.fetch = async (url) => assert.fail(`a DCR client_id must never be fetched as metadata: ${url}`);
    try {
      freshRedis();
      dbWrites.length = 0;
      emitted.length = 0;
      const res = await request(app).get(`/api/v1/oauth/authorize?${params.toString()}`);
      await flush();

      assert.equal(
        res.status,
        302,
        `this request produced "${observed.outcome_before_fix}" in production: ${res.text}`,
      );
      assert.ok(res.headers.location.startsWith(CONSENT));

      // The person still sees who is asking and where the code goes: a recovered
      // id is exactly as unverified as a fresh DCR registration.
      const requestId = new URL(res.headers.location).searchParams.get('req');
      const consent = await request(app).get(`/api/v1/oauth/consent/${requestId}`);
      assert.equal(consent.status, 200);
      assert.equal(consent.body.verified, false);
      assert.equal(consent.body.redirect_host, new URL(params.get('redirect_uri')).host);
      assert.equal(consent.body.redirect_uri, params.get('redirect_uri'));

      // Nothing was written: an unknown id cannot plant a registration or pin a
      // redirect_uri for whoever sends it next.
      assert.deepEqual(dbWrites, []);

      const requested = emitted.filter((e) => e.event_name === 'connector_authorize_requested');
      assert.equal(requested.length, 1);
      assert.equal(requested[0].metadata.recovered_registration, true);
      assert.equal(emitted.filter((e) => e.event_name === 'connector_authorize_rejected').length, 0);
    } finally {
      global.fetch = previousFetch;
    }
  });

  test(`${observed.label}: recovery never admits a redirect the register endpoint would refuse`, async () => {
    const params = new URLSearchParams(observed.query);
    params.set('resource', params.get('resource').replace(observed.production_origin, ISSUER));
    for (const hostile of ['javascript:alert(1)', 'http://attacker.example/callback', 'vscode://vscode.git/clone?url=x']) {
      params.set('redirect_uri', hostile);
      freshRedis();
      const res = await request(app).get(`/api/v1/oauth/authorize?${params.toString()}`);
      assert.equal(res.status, 400, `${hostile} must not reach consent: ${res.text}`);
      assert.ok(!res.headers.location, 'must never redirect to an unvalidated URI');
    }
  });
}
