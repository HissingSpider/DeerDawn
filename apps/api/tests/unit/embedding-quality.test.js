const test = require('node:test');
const assert = require('node:assert');
const embeddings = require('../../src/services/contextGraphEmbeddingService');

// These assert the local hash-embed floor (hash-embed-v2) is actually semantic
// enough to separate near-duplicates from unrelated text — the 32-dim v1 failed this.

test('hashEmbed produces normalized 256-dim vectors', () => {
  const v = embeddings.hashEmbed('apply database migration to staging environment');
  assert.strictEqual(v.length, 256);
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(mag - 1) < 1e-3, `expected unit magnitude, got ${mag}`);
});

test('hashEmbed scores near-duplicates high and unrelated text low', () => {
  const a = embeddings.hashEmbed('fix the auth token refresh bug in the login flow');
  const aDup = embeddings.hashEmbed('fix the auth token refresh bug in login flow');
  const unrelated = embeddings.hashEmbed('render the marketing pricing page hero section in dark mode');

  const dupSim = embeddings.cosineSimilarity(a, aDup);
  const farSim = embeddings.cosineSimilarity(a, unrelated);

  assert.ok(dupSim > 0.8, `near-duplicate similarity should be > 0.8, got ${dupSim.toFixed(3)}`);
  assert.ok(farSim < 0.3, `unrelated similarity should be < 0.3, got ${farSim.toFixed(3)}`);
  assert.ok(dupSim > farSim, 'near-duplicate must out-score unrelated');
});

test('hashEmbed handles empty input without throwing', () => {
  const v = embeddings.hashEmbed('');
  assert.strictEqual(v.length, 256);
  assert.ok(v.every((x) => x === 0));
});
