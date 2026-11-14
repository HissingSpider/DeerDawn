/**
 * Scan 17 (2026-09-23): the client redactor's half of the round-17 redaction
 * fixes — identifier *Key names and digests are not secrets, the gitleaks-default
 * token formats are, a URI password does not span a list item, and `$uperS3cret!`
 * is not a `$NAME` reference. The same fixtures run against the API and
 * shared-context redactors in apps/api/tests/unit/scan17-redaction.test.js.
 * Every fixture secret is fake and assembled by concatenation.
 */
import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../src/redact.js';

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
const STILL_MASKED: Record<string, string> = {
  azure_account_key: 'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=' + b64(aln(48)) + ';EndpointSuffix=core.windows.net',
  apim: 'Ocp-Apim-Subscription-Key: ' + hex(32),
  storage_key: '{"storageKey": "' + aln(40) + '"}',
  algolia_admin: "algoliaAdminKey: '" + hex(32) + "'",
  license_key: 'license_key = "' + UP(8) + '-' + aln(20) + '"',
  admin_key: 'admin_key: ' + hex(40),
  session_key: 'SESSION_KEY: ' + hex(48),
  hmac_json: '{"HMAC_KEY": "' + hex(64) + '"}',
  password_dollar: 'DB_PASSWORD=$uperS3cret!',
  uri_comma_password: 'postgres://app:hunter2,x@db.internal:5432/app',
};

// #3: one per format, in the bare form a paste carries.
const NEW_FORMATS: Record<string, string> = {
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

describe('scan 17: client redactor', () => {
  it('leaves identifiers under *Key names, list-item URIs and $NAME references alone', () => {
    for (const s of UNCHANGED) expect(redactSecrets(s), s).toBe(s);
  });

  it('still masks credential-named keys and a $-leading password', () => {
    for (const [name, s] of Object.entries(STILL_MASKED)) expect(redactSecrets(s), name).toContain('[REDACTED]');
  });

  it('masks every added token format', () => {
    for (const [name, s] of Object.entries(NEW_FORMATS)) {
      expect(redactSecrets(`token ${s} here`).includes(s.slice(-16)), name).toBe(false);
    }
  });

  it('leaves the new prefixes in prose and ids alone', () => {
    for (const s of NEW_FORMAT_NEAR_MISSES) expect(redactSecrets(s), s).toBe(s);
  });

  it('stays linear on 256 KB of each new prefix', () => {
    const N = 256 * 1024;
    const fill = (unit: string) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
    for (const seed of ['NRAK-', 'sntrys_eyJ', 'sk.eyJaaaaaaaaaaaa.', 'ATATT3', 'gldt-', 'hvs.a', 'glc_1',
      'aaaaaaaaaaaaaa.atlasv1.', 'TF_TOKEN_a=', 'a://b:1,', 'http://a:b,c:', 'PASSWORD=$a', 'cacheKey=']) {
      const started = performance.now();
      redactSecrets(fill(seed));
      expect(performance.now() - started, seed).toBeLessThan(200);
    }
  });
});

// Scan 18: exempt identifier words count only as a whole segment of the name,
// and words that also name real credentials are no longer exempt.
describe('scan 18: credentials under formerly exempt key names', () => {
  const secret = 'Qm9vN2' + 'xTa3B4Wm' + 'Q4cVJ0VnY3' + 'dUo5aEtM';
  const credentials = [
    `EVENTHUB_PRIMARY_KEY=${secret}`, `primaryKey: "${secret}"`, `REDIS_KEY=${secret}`,
    `COOKIE_HASH_KEY=${secret}`, `blockKey: ${secret}`, `PAGERDUTY_ROUTING_KEY=${secret}`,
    `EVENT_KEY=${secret}`, `lockKey=${secret}`, `PROFILE_KEY=${secret}`,
  ];
  it('masks every one', () => {
    for (const line of credentials) expect(redactSecrets(line)).not.toContain(secret);
  });
  it('still leaves identifier names alone', () => {
    const cache = 'cacheKey=' + 'a3f5c9e1b7d2' + '04f68e9a1c3b5d7f90e2a4c6';
    const dedupe = 'dedupeKey: evt_' + '1PqR8sTuV2wXyZ3a' + 'Bc4De5';
    expect(redactSecrets(cache)).toBe(cache);
    expect(redactSecrets(dedupe)).toBe(dedupe);
  });
});
