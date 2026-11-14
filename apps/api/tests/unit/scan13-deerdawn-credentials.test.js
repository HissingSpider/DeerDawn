/**
 * SCAN 13: DeerDawn's OWN credentials were never redacted. No DB.
 *
 * The storage redactor knew every provider's key shape except ours, so a live
 * API key (`dd_<8 hex>_<64 hex>`) or OAuth refresh token (`ddr_<64 hex>`) typed
 * into a summary was stored verbatim and served back by /active, /inject and the
 * Trail export. The Trail publish scanner uses that redactor as its floor, so it
 * reported 0 findings and the publish gate let the key go public.
 *
 * The fixtures are minted by the real minters (generateApiKey; the refresh token
 * is built exactly as routes/oauth.js builds it), so a format change there that
 * the patterns miss fails here.
 *
 *   NODE_ENV=test JWT_SECRET=test-secret DEERDAWN_API_KEY=dev-key DISABLE_REDIS=true \
 *     node --test tests/unit/scan13-deerdawn-credentials.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { redactSecrets, REDACTED } = require('../../src/utils/secretRedaction');
const { generateApiKey } = require('../../src/utils/security');
const { scanContent } = require('../../src/services/trail/trailScan');
const publish = require('../../src/services/trail/trailPublish');
const { buildTrail } = require('../../src/services/trail/trailExport');
const { makeProject } = require('../helpers/trailFixture');

const mintRefreshToken = () => `ddr_${crypto.randomBytes(32).toString('hex')}`; // routes/oauth.js

test('a freshly minted API key and refresh token are masked by the storage redactor', () => {
  const { key, prefix } = generateApiKey();
  const refresh = mintRefreshToken();
  const out = redactSecrets(`CI uses the DeerDawn key ${key} for the nightly sync; refresh ${refresh} was rejected.`);
  assert.ok(!out.includes(key), `THE BUG: the API key was stored verbatim: ${out}`);
  assert.ok(!out.includes(refresh), `THE BUG: the refresh token was stored verbatim: ${out}`);
  assert.ok(!out.includes(key.slice(prefix.length)), 'no part of the secret half survives');
  assert.strictEqual(out, `CI uses the DeerDawn key ${REDACTED} for the nightly sync; refresh ${REDACTED} was rejected.`);
});

test('the key in the places people actually paste it', () => {
  const { key } = generateApiKey();
  const refresh = mintRefreshToken();
  for (const text of [
    `DEERDAWN_API_KEY=${key}`,
    `{"x-api-key":"${key}"}`,
    `curl -H 'x-api-key: ${key}' https://api.deerdawn.com`,
    `(${refresh})`,
    `refresh_token=${refresh}&client_id=abc`,
    `"${key}",`,
  ]) {
    const out = redactSecrets(text);
    assert.ok(!out.includes(key) && !out.includes(refresh), `survived in ${text} -> ${out}`);
  }
});

test('the non-secret display prefix and look-alike words are left alone', () => {
  const { prefix } = generateApiKey();
  for (const text of [
    `key ${prefix} was rotated`, // the dashboard shows this to identify a key
    'the dd_session cookie and dd_csrf header',
    'ddr_rollout_notes and dd_test_fixture_helpers',
    `dd_${'g'.repeat(8)}_${'a'.repeat(64)}`, // not hex
  ]) {
    assert.strictEqual(redactSecrets(text), text, `over-redacted: ${text}`);
  }
});

test('the Trail scanner reports DeerDawn credentials, and the excerpt re-leaks neither', () => {
  const { key } = generateApiKey();
  const refresh = mintRefreshToken();
  const { findings } = scanContent({ brief: { description: `CI uses ${key} and refresh ${refresh}.` } }, { includeHeuristicNames: false });
  const credentials = findings.filter((finding) => finding.category === 'credential');
  assert.strictEqual(credentials.length, 2, `THE BUG: expected one finding per credential, got ${JSON.stringify(findings)}`);
  const wire = JSON.stringify(findings);
  // Not even a fragment: the excerpt used to be cut BEFORE redaction, which split
  // the neighbouring credential so the redactor no longer recognised it.
  for (const secret of [key, refresh]) {
    for (let at = 0; at + 16 <= secret.length; at += 8) {
      assert.ok(!wire.includes(secret.slice(at, at + 16)), `an excerpt carries part of ${secret.slice(0, 6)}…: ${wire}`);
    }
  }
});

test('a Trail carrying a live key cannot be published until the finding is resolved', () => {
  const { key } = generateApiKey();
  const project = makeProject({ withSecrets: false });
  project.context.description += ` The nightly job authenticates with ${key}.`;
  const trail = buildTrail({ project, graph: project.graph, trailId: 'trail_ddkey', exportedAt: '2026-09-22T00:00:00.000Z' });

  const preview = publish.buildPreview(trail, { includeHeuristicNames: false });
  const credential = preview.findings.find((finding) => finding.category === 'credential');
  assert.ok(credential, `THE BUG: the preview reported no credential: ${JSON.stringify(preview.findings.map((f) => f.category))}`);

  const others = {};
  for (const finding of preview.findings) {
    if (finding.id !== credential.id) others[finding.id] = { action: 'exclude', digest: finding.digest };
  }
  const refused = publish.finalizePublish(trail, others, { includeHeuristicNames: false });
  assert.strictEqual(refused.ok, false, 'THE BUG: a Trail with a live DeerDawn key published');
  assert.ok(refused.errors.some((error) => error.code === 'unresolved_finding' && error.finding_id === credential.id));

  const excluded = publish.finalizePublish(
    trail,
    { ...others, [credential.id]: { action: 'exclude', digest: credential.digest } },
    { includeHeuristicNames: false },
  );
  assert.strictEqual(excluded.ok, true, JSON.stringify(excluded.errors));
  assert.ok(!JSON.stringify(excluded).includes(key), 'the key is gone from what publishes');
});

test('an excerpt never carries a fragment of a neighbouring credential (any provider)', () => {
  // The excerpt was cut to a 32-char radius BEFORE redaction. A second key
  // inside that radius was split, the redactor no longer recognised the half,
  // and the half shipped in the preview. Independent of DeerDawn's own shapes.
  const gh = `ghp_${'Q7x'.repeat(12)}`;
  const aws = 'AKIAIOSFODNN7EXAMPLE';
  // 16 characters after the address, so the 32-char tail stops 16 characters
  // into the AWS key: a fragment too short for its own pattern.
  const text = `mail ops@example.com and then later ${aws} done; also ${gh}`;
  const { findings } = scanContent({ brief: { description: text } }, { includeHeuristicNames: false });
  assert.ok(findings.some((f) => f.category === 'email') && findings.some((f) => f.category === 'credential'));
  const wire = JSON.stringify(findings);
  for (const secret of [gh, aws]) {
    for (let at = 0; at + 10 <= secret.length; at += 5) {
      assert.ok(!wire.includes(secret.slice(at, at + 10)), `an excerpt carries part of a credential: ${wire}`);
    }
  }
});
