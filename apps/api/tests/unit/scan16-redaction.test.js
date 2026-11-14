/**
 * Scan 16 (2026-09-23), REDACTION — the no-DB half. The stored/served half
 * (board merge, the description cap, `redacted_fields`) is in
 * tests/integration/scan16-redaction.test.js.
 *
 *   #1 HIGH  round 15's upper-snake *_KEY pass masked any value holding a digit,
 *            '+' or '=', so non-secret constants were masked at storage.
 *   #2 HIGH  URI_CREDS had an unbounded scheme and user part, quadratic on a
 *            long run of letters: a 40 KB description held the API 15 seconds.
 *            Every redactor pattern is now linear; this file TIMES them.
 *   #3 MED   Fly.io / Hugging Face / Shopify / Linear / Doppler, and a URI
 *            password holding '@' (the table rows are in the corpus test).
 *   #5 HIGH  a key named in camelCase / kebab / lowercase snake over a real key
 *            (Azure AccountKey, Ocp-Apim-Subscription-Key, storageKey) went out
 *            whole.
 *
 * Every fixture secret is fake and assembled by concatenation.
 */
process.env.NODE_ENV = 'test';
process.env.DISABLE_REDIS = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactSecrets } = require('../../src/utils/secretRedaction');
const { redactForStorage } = require('../../src/store/contextSyncStore');
const mcpSafety = require('../../src/services/mcpSafety');
const { redactSecretText } = require('../../../../packages/shared-context/src/index.js');

test.after(async () => {
  await require('../../src/config/db').pool.end().catch(() => {});
});

const SURFACES = [
  ['redactSecrets', (s) => redactSecrets(s)],
  ['store.redactForStorage', (s) => redactForStorage({ context: { description: s } }).context.description],
  ['shared-context redactSecretText', (s) => redactSecretText(s)],
  ['mcpSafety.redactText', (s) => mcpSafety.redactText(s)],
];

// ─── #2: linear time ─────────────────────────────────────────────────────────

function millis(fn, text) {
  const started = process.hrtime.bigint();
  fn(text);
  return Number(process.hrtime.bigint() - started) / 1e6;
}

const BODY_LIMIT = 256 * 1024;
const fill = (unit) => (n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

// One adversarial input per pattern family, so a regression names the family.
const SHAPES = [
  ['a run of lowercase letters (URI scheme)', fill('a')],
  ['a run of capitals', fill('A')],
  ['letters then "://" with no credentials', (n) => 'a://' + 'a'.repeat(n)],
  ['many uri userinfo starts, no @', fill('a://b:c ')],
  ['"eyJ" end to end (JWT)', fill('eyJ')],
  ['JWT-looking segments with no third part', fill('eyJaaaaaaaaaaaa.')],
  ['"sk-" end to end', fill('sk-')],
  ['"glpat-" end to end', fill('glpat-')],
  ['unterminated PEM fences', fill('-----BEGIN RSA PRIVATE KEY-----\n')],
  ['a PEM BEGIN then capitals', (n) => '-----BEGIN ' + 'A'.repeat(n)],
  ['END first, then unterminated BEGINs', (n) => '-----END RSA PRIVATE KEY-----' + fill('-----BEGIN RSA PRIVATE KEY-----')(n)],
  ['x-api-key then letters', (n) => 'x-api-key ' + 'a'.repeat(n)],
  ['an unclosed quoted api_key', (n) => 'api_key: "' + fill('a1')(n)],
  ['upper-snake env names end to end', fill('A_KEY:')],
  ['camelCase key names end to end', fill('storageKey=')],
  ['a key name then an endless value', (n) => 'storageKey=' + fill('aB3+')(n)],
  ['mixed secret-ish characters', fill('aB3+/=_-.:@')],
];

for (const [surface, run] of SURFACES) {
  test(`${surface}: ${BODY_LIMIT / 1024} KB of letters redacts in under 200ms`, () => {
    run('a'.repeat(2000)); // warm the JIT
    const text = 'a'.repeat(BODY_LIMIT);
    const best = Math.min(millis(run, text), millis(run, text), millis(run, text));
    assert.ok(best < 200, `${surface} took ${best.toFixed(1)}ms on ${BODY_LIMIT} letters`);
  });

  test(`${surface}: every adversarial shape stays linear up to the body limit`, () => {
    const slow = [];
    for (const [name, build] of SHAPES) {
      run(build(2000));
      const best = (n) => Math.min(millis(run, build(n)), millis(run, build(n)), millis(run, build(n)));
      const small = Math.max(best(BODY_LIMIT / 8), 0.5);
      const large = best(BODY_LIMIT);
      // Ratios, not only milliseconds: CI is noisy and the property is the SHAPE
      // of the curve. 8x the input is ~8x linear and ~64x quadratic. Below 50ms
      // the ratio is scheduler noise and the absolute bound is the check.
      if (large > 50 && large / small > 20) slow.push(`${name}: ${small.toFixed(1)}ms -> ${large.toFixed(1)}ms (x${(large / small).toFixed(0)})`);
      if (large > 1000) slow.push(`${name}: ${large.toFixed(0)}ms at ${BODY_LIMIT} chars`);
    }
    assert.deepEqual(slow, []);
  });
}

// ─── #1 / #5: a key name is masked over a key, and only over a key ───────────

const AZURE_KEY = 'q83vEjRWeJCrze8SNFZ4mg7R1bXkP0yT+/Lw9cZfUhA3sG2iN6dVoQ5aYxK4eB8jMnHuWt1z0rC7pFg9lIsE2vDy+Kh==';

for (const [surface, run] of SURFACES.slice(0, 3)) {
  test(`${surface}: an Azure connection string loses the key and keeps everything else`, () => {
    const text = `DefaultEndpointsProtocol=https;AccountName=acme;AccountKey=${AZURE_KEY};EndpointSuffix=core.windows.net`;
    assert.equal(run(text), 'DefaultEndpointsProtocol=https;AccountName=acme;AccountKey=[REDACTED];EndpointSuffix=core.windows.net');
  });

  test(`${surface}: two values that differ only in a non-secret *_KEY stay two values`, () => {
    // The board merged these into one card: both were stored as
    // "Set ROUTING_KEY=[REDACTED] on the producer".
    const a = run('Set ROUTING_KEY=orders.created.v1 on the producer');
    const b = run('Set ROUTING_KEY=orders.deleted.v1 on the producer');
    assert.equal(a, 'Set ROUTING_KEY=orders.created.v1 on the producer');
    assert.notEqual(a, b);
  });

  test(`${surface}: a URI password holding '@' is masked up to the host`, () => {
    assert.equal(run('postgres://app:p@ss@db.internal:5432/app'), 'postgres://app:[REDACTED]@db.internal:5432/app');
    // Compact JSON: the password stops at the quote, not at the next field's '@'.
    const json = '{"a":"http://h:80","b":"x@y.io"}';
    assert.equal(run(json), json);
  });

  test(`${surface}: a reference to a secret is left as written`, () => {
    for (const text of ['GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }}', 'API_KEY="${API_KEY_V2}"', 'DB_PASSWORD=${DB_PASSWORD_2}']) {
      assert.equal(run(text), text);
    }
  });

  test(`${surface}: FLY_API_TOKEN keeps its name and loses the whole macaroon`, () => {
    const out = run('FLY_API_TOKEN=Fly' + 'V1 fm2_lJPECAAAAAAAAMyUxBDaB3dE5gH7jK9mN1pQ2rS4tU6,fm2_aB3dE5gH7jK9mN1pQ2rS4tU6vW8');
    assert.ok(out.startsWith('FLY_API_TOKEN='), out);
    assert.ok(!/fm2_|aB3dE5gH7jK9/.test(out), out);
  });
}

test('the API and shared-context redactors agree on every round-16 fixture (mcp-server: redaction-false-positives.test.ts)', () => {
  const fixtures = [
    'const SEEN_KEY = \'dd_post_sync_modal_seen_v1\';',
    'ROUTING_KEY=orders.created.v1',
    `AccountKey=${AZURE_KEY};`,
    'Ocp-Apim-Subscription-Key: 3a1f8c6e4b2d0a9f7c5e3a1f8c6e4b2d',
    'NEXT_PUBLIC_POSTHOG_KEY=phc_aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zaB3dE5gH7jK',
    'postgres://app:p@ss@db:5432/app',
    'whsec_rotation_plan',
    'hf_' + 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zaB3',
  ];
  for (const text of fixtures) assert.equal(redactSecretText(text), redactSecrets(text), text);
});

// ─── #5: the Trail scanner, whose floor is this redactor ─────────────────────

const { scanContent } = require('../../src/services/trail/trailScan');
const trailPublish = require('../../src/services/trail/trailPublish');

const ROUND_13_KEY_SHAPES = [
  `DefaultEndpointsProtocol=https;AccountName=acme;AccountKey=${AZURE_KEY};EndpointSuffix=core.windows.net`,
  'Ocp-Apim-Subscription-Key: ' + '3a1f8c6e4b2d0a9f7c5e3a1f8c6e4b2d',
  '{"storageKey":"' + AZURE_KEY + '"}',
  'algoliaAdminKey: \'' + '3a1f8c6e4b2d0a9f7c5e3a1f8c6e4b2d' + '\'',
  'license_key = "' + '9f86d081884c7d659a2feaa0c55ad015' + '"',
  'admin_key=' + '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b',
  'FLY_API_TOKEN=Fly' + 'V1 fm2_lJPECAAAAAAAAMyUxBDaB3dE5gH7jK9mN1pQ2rS4tU6',
];

test('Trail: every round-13 key shape is a credential finding, and publish is refused until it is resolved', () => {
  for (const text of ROUND_13_KEY_SHAPES) {
    const { findings } = scanContent({ brief: { current_status: `Uploads use ${text}` } });
    assert.ok(findings.some((f) => f.category === 'credential'), `no credential finding for: ${text}`);
    const result = trailPublish.finalizePublish({ content: { brief: { current_status: `Uploads use ${text}` } } }, {});
    assert.equal(result.ok, false, `publish went through with: ${text}`);
    assert.ok(result.errors.some((e) => e.code === 'unresolved_finding'), JSON.stringify(result.errors));
  }
});

test('Trail: a non-secret *_KEY constant raises no credential finding', () => {
  for (const text of ['const SEEN_KEY = \'dd_post_sync_modal_seen_v1\';', 'ROUTING_KEY=orders.created.v1', 'S3_OBJECT_KEY=exports/2026-09-23.csv']) {
    const { findings } = scanContent({ brief: { current_status: text } });
    assert.deepEqual(findings.filter((f) => f.category === 'credential'), [], text);
  }
});
