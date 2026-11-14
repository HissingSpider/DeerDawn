/**
 * Scan 17 (2026-09-23), REDACTION.
 *
 *   #2 MED  KEY_NAME_ASSIGNMENT masked a hash or an id under ANY name ending in
 *           "key": `cacheKey=<sha1>` (two cards differing only there merged into
 *           one), `dedupeKey`, `objectKey`, `cache-key: node-modules-<md5>`,
 *           `integrityKey: sha512-…`, `idempotencyKey: <md5>`, an ssh
 *           `hostKey: SHA256:…` fingerprint. Identifier-describing names and
 *           digest-prefixed values are exempt; credential-ish names are not.
 *   #3 MED  bare token formats in gitleaks' defaults leaked on every surface.
 *   #4 LOW  a URI "password" spanned a ',' into the next list item
 *           (`http://localhost:3000,mailto:ops@corp.com`) or a '?' / '#'; and
 *           `DB_PASSWORD=$uperS3cret!` passed as a `$NAME` reference.
 *
 * The mcp-server half is packages/mcp-server/tests/scan17-redaction.test.ts.
 * Every fixture secret is fake and assembled by concatenation.
 */
process.env.NODE_ENV = 'test';
process.env.DISABLE_REDIS = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactSecrets } = require('../../src/utils/secretRedaction');
const { redactForStorage } = require('../../src/store/contextSyncStore');
const trailScan = require('../../src/services/trail/trailScan');
const { redactSecretText } = require('../../../../packages/shared-context/src/index.js');

test.after(async () => {
  await require('../../src/config/db').pool.end().catch(() => {});
});

const SURFACES = [
  ['redactSecrets', (s) => redactSecrets(s)],
  ['store.redactForStorage', (s) => redactForStorage({ context: { description: s } }).context.description],
  ['shared-context redactSecretText', (s) => redactSecretText(s)],
];

const hex = (n, seed = 5) => Array.from({ length: n }, (_, i) => '0123456789abcdef'[(i * 7 + seed) % 16]).join('');
const aln = (n, seed = 2) => Array.from({ length: n }, (_, i) => 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z'[(i * 5 + seed) % 31]).join('');
const UP = (n) => aln(n).toUpperCase();
const b64 = (s) => Buffer.from(s).toString('base64');

// #2 / #4: ordinary text every surface must store exactly as written.
const UNCHANGED = [
  'Purge CDN cacheKey=9f86d081884c7d659a2feaeae0ab4b1c after the deploy',
  'Purge CDN cacheKey=5e884898da28047151d0e56f8dc62927 after the deploy',
  'cacheKey: 1a2c200d8f7e6b5a4c3d2e1f0a9b8c7d6e5f4a3b',
  'cache-key: node-modules-9f8e7d6c5b4a39281706f5e4d3c2b1a0',
  'objectKey = "avatars/user_2NxK9fQ8zLmA7bPqRtY3/profile.png"',
  'S3 objectKey=uploads/3f2a1b4c5d6e4f708a9b0c1d2e3f4a5b.pdf',
  'dedupeKey: evt_1Nq8Zx2eZvKYlo2C8f7gH3kL',
  'Stripe dedupeKey: evt_1Nq8Zx2eZvKYlo2C8f7gH3kL fired twice',
  'idempotencyKey: 5d41402abc4b2a76b9719d911017c592',
  'integrityKey: sha512-9f8e7d6c5b4a39281706f5e4d3c2b1a0Zx9Kq2Lm8Np4Rt6Vw1',
  'ssh hostKey: SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8',
  'ETag cacheKey = W/"5e8f2a1b9c3d7e4f"',
  'redisKey: "session:3f2a1b4c5d6e:v2"',
  'partitionKey: tenant_8f3Kx92LmQ',
  'CORS_ORIGINS=http://localhost:3000,mailto:ops@corp.com',
  'http://localhost:8080?email=john@example.com',
  'Open http://127.0.0.1:3000#user@example.com in the browser',
  'export OPENAI_API_KEY=$OPENAI_API_KEY',
  'DATABASE_PASSWORD=${DB_PASSWORD}',
  'GH_TOKEN=$(gh auth token)',
  'DB_PASSWORD=$DB_PASSWORD_2',
];

// Round 16's true positives under credential-ish *Key names: still masked.
const STILL_MASKED = {
  azure_account_key: 'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=' + b64(aln(48)) + ';EndpointSuffix=core.windows.net',
  apim: 'Ocp-Apim-Subscription-Key: ' + hex(32),
  storage_key: '{"storageKey": "' + aln(40) + '"}',
  algolia_admin: 'algoliaAdminKey: \'' + hex(32) + '\'',
  license_key: 'license_key = "' + UP(8) + '-' + aln(20) + '"',
  admin_key: 'admin_key: ' + hex(40),
  session_key: 'SESSION_KEY: ' + hex(48),
  hmac_json: '{"HMAC_KEY": "' + hex(64) + '"}',
  password_dollar: 'DB_PASSWORD=$uperS3cret!',
  uri_comma_password: 'postgres://app:hunter2,x@db.internal:5432/app',
};

// #3: one per format, in the bare form a paste carries.
const NEW_FORMATS = {
  new_relic_user: 'NRAK-' + UP(27),
  new_relic_insert: 'NRII-' + aln(32),
  sentry_org: 'sntrys_eyJpYXQiOjE3MjY4MDAwMDB9_' + aln(43),
  sentry_user: 'sntryu_' + hex(64),
  mapbox_secret: 'sk.eyJ1IjoiYWNtZSIsImEiOiJjbGZ' + aln(20) + '.' + aln(22),
  atlassian: 'ATATT3xFfGF0' + aln(180),
  digitalocean: 'dop_v1_' + hex(64),
  digitalocean_oauth: 'doo_v1_' + hex(64),
  gitlab_deploy: 'gldt-' + aln(20),
  gitlab_runner: 'glrt-' + aln(20),
  vault_service: 'hvs.CAESI' + aln(80),
  vault_batch: 'hvb.AAAAAQ' + aln(60),
  databricks: 'dapi' + hex(32),
  grafana_sa: 'glsa_' + aln(32) + '_' + hex(8),
  grafana_cloud: 'glc_' + b64('{"o":"123","n":"stack-456","k":"' + aln(24) + '"}').replace(/=+$/, ''),
  age: 'AGE-SECRET-KEY-1' + UP(58).replace(/[^A-Z0-9]/g, 'Q'),
  planetscale: 'pscale_pw_' + aln(43),
  terraform: aln(14) + '.atlasv1.' + aln(67),
  terraform_env: 'TF_TOKEN_app_terraform_io=' + aln(40),
};

// Near misses for the new formats: the prefixes named in prose, ids, docs.
const NEW_FORMAT_NEAR_MISSES = [
  'NRAK- keys are New Relic user keys',
  'sntrys_ is the Sentry org token prefix',
  'Use the public pk.eyJ1IjoiYWNtZSJ9.abc token in the browser',
  'ATATT3 prefixed tokens come from id.atlassian.com',
  'dop_v1_ tokens are DigitalOcean PATs',
  'gldt-rotation-runbook-v2',
  'hvs.config.loader',
  'the dapi prefix marks a Databricks token',
  'glsa_rotation_plan',
  'glc_stack_config_loader_for_production_use',
  'AGE-SECRET-KEY-1 is the age identity prefix',
  'pscale_pw_ is PlanetScale\'s password prefix',
  'app.terraform.io uses .atlasv1. tokens',
  'TF_TOKEN_app_terraform_io=${TFC_TOKEN}',
];

test('#2/#4: identifiers under *Key names, list-item URIs and $NAME references are stored unchanged', () => {
  for (const [surface, redact] of SURFACES) {
    for (const s of UNCHANGED) assert.equal(redact(s), s, `${surface} changed: ${s}`);
  }
});

test('#2: two cards that differ only in a cache-key hash stay two cards', () => {
  const [a, b] = UNCHANGED.slice(0, 2).map((s) => redactSecrets(s));
  assert.notEqual(a, b);
});

test('#2/#4: round 16\'s credential-named keys, and a $-leading password, are still masked', () => {
  for (const [surface, redact] of SURFACES) {
    for (const [name, s] of Object.entries(STILL_MASKED)) {
      const out = redact(s);
      assert.notEqual(out, s, `${surface} leaked ${name}`);
      assert.match(out, /\[REDACTED\]/, `${surface} ${name}`);
    }
  }
});

test('#3: every added token format is masked on every surface and flagged by the Trail scanner', () => {
  for (const [surface, redact] of SURFACES) {
    for (const [name, s] of Object.entries(NEW_FORMATS)) {
      const out = redact(`token ${s} here`);
      assert.ok(!out.includes(s.slice(-16)), `${surface} leaked ${name}: ${out}`);
    }
  }
  for (const [name, s] of Object.entries(NEW_FORMATS)) {
    assert.ok(trailScan.detectCredentials(`token ${s} here`).length > 0, `Trail missed ${name}`);
  }
});

test('#3: the new formats\' prefixes in prose and ids are left alone', () => {
  for (const [surface, redact] of SURFACES) {
    for (const s of NEW_FORMAT_NEAR_MISSES) assert.equal(redact(s), s, `${surface} changed: ${s}`);
  }
});

test('the new patterns stay linear: 256 KB of each prefix end to end under 200 ms', () => {
  const N = 256 * 1024;
  const fill = (unit) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  const seeds = ['NRAK-', 'sntrys_eyJ', 'sk.eyJ', 'sk.eyJaaaaaaaaaaaa.', 'ATATT3', 'dop_v1_', 'gldt-', 'glrt-A1', 'hvs.a', 'dapi',
    'glsa_', 'glc_1', 'AGE-SECRET-KEY-1', 'pscale_pw_', 'aaaaaaaaaaaaaa.atlasv1.', 'TF_TOKEN_a=', 'a://b:1,', ',a:', 'http://a:b,c:',
    'PASSWORD=$a', 'cacheKey=', 'xKey=$a1'];
  for (const [surface, redact] of SURFACES.filter(([name]) => name !== 'store.redactForStorage')) {
    for (const seed of seeds) {
      const started = process.hrtime.bigint();
      redact(fill(seed));
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(ms < 200, `${surface} took ${ms.toFixed(0)}ms on ${JSON.stringify(seed)} x 256KB`);
    }
  }
});

test('the API and shared-context redactors agree on every round-17 fixture', () => {
  const all = [...UNCHANGED, ...Object.values(STILL_MASKED), ...Object.values(NEW_FORMATS), ...NEW_FORMAT_NEAR_MISSES];
  for (const s of all) assert.equal(redactSecretText(s), redactSecrets(s), s);
});

// Scan 18 (2026-09-23): the round-17 identifier exemption matched a bare suffix
// and listed words that also name real credentials, so these were stored in
// clear again. Exempt words now count only as a whole segment of the name.
const R18_SECRET = 'Qm9vN2' + 'xTa3B4Wm' + 'Q4cVJ0VnY3' + 'dUo5aEtM';
const R18_CREDENTIALS = [
  `EVENTHUB_PRIMARY_KEY=${R18_SECRET}`,
  `primaryKey: "${R18_SECRET}"`,
  `REDIS_KEY=${R18_SECRET}`,
  `redisKey = '${R18_SECRET}'`,
  `COOKIE_HASH_KEY=${R18_SECRET}`,
  `blockKey: ${R18_SECRET}`,
  `PAGERDUTY_ROUTING_KEY=${R18_SECRET}`,
  `EVENT_KEY=${R18_SECRET}`,
  `STATE_KEY=${R18_SECRET}`,
  `lockKey=${R18_SECRET}`,
  `PROFILE_KEY=${R18_SECRET}`,
];
const R18_IDENTIFIERS = [
  'cacheKey=' + 'a3f5c9e1b7d2' + '04f68e9a1c3b5d7f90e2a4c6',
  'S3_OBJECT_KEY=uploads/2024/' + 'Zk3mP9qL2xR7vT4n' + '.png',
  'dedupeKey: evt_' + '1PqR8sTuV2wXyZ3a' + 'Bc4De5',
  'idempotencyKey: ' + '9b2e7f4a1c8d3e6f' + '0a5b9c2d7e4f1a83',
];

test('#r18 credentials under formerly exempt names are masked on every surface', () => {
  for (const line of R18_CREDENTIALS) {
    for (const [surface, out] of [
      ['api', redactSecrets(line)],
      ['store', redactForStorage({ description: line }).description],
      ['shared-context', redactSecretText(line)],
    ]) {
      assert.ok(!out.includes(R18_SECRET), `${surface} left the secret in: ${line}`);
    }
  }
});

test('#r18 identifier names stay unmasked', () => {
  for (const line of R18_IDENTIFIERS) {
    assert.equal(redactSecrets(line), line, `api masked an identifier: ${line}`);
    assert.equal(redactSecretText(line), line, `shared-context masked an identifier: ${line}`);
  }
});
