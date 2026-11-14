process.env.NODE_ENV = 'test';
process.env.DISABLE_REDIS = 'true';

/**
 * A long session's Stop-hook flush VANISHED at the body limit.
 *
 * `deerdawn-mcp flush-session` posts the whole transcript to
 * POST /api/v1/context/extraction in one body. Past the JSON limit express
 * refuses it, the CLI prints one stderr line the user never sees, and the entire
 * session's context is gone — the silent-drop shape again, this time on the path
 * that exists precisely so nothing is lost at the end of a session.
 *
 * Two halves. The client trims to fit and records the failure where the next
 * session will show it (packages/mcp-server). This is the server half: the
 * refusal must say what happened, how big the body was, what the cap is, and
 * what the caller should do about it — not a bare status.
 *
 * The limit itself stays small on purpose. This parser runs BEFORE
 * authentication, so every byte allowed is a byte an unauthenticated caller can
 * make the server buffer.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../../src/app');
const { ensureHttpBindingAvailable } = require('../helpers/runtimeAvailability');
const {
  MAX_EXTRACTION_BODY_BYTES,
  EXTRACTION_BODY_BUDGET_BYTES,
} = require('../../../../packages/shared-context/src/index.js');
const { EXTRACTION_JSON_BODY_LIMIT, TRAIL_JSON_BODY_LIMIT } = require('../../src/config/bodyLimits');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

function oversizeExtractionBody() {
  const text = 'x'.repeat(2000);
  const chunks = [];
  while (JSON.stringify(chunks).length < MAX_EXTRACTION_BODY_BYTES + 32 * 1024) {
    chunks.push({ role: 'assistant', text });
  }
  return { session_id: 'oversize-test', tool: 'claude_code', chunks };
}

test('extraction body limit', async (t) => {
  if (!await ensureHttpBindingAvailable(t, 'extraction body limit')) return;

  await t.test('the client budget is smaller than the server limit', () => {
    assert.ok(
      EXTRACTION_BODY_BUDGET_BYTES < MAX_EXTRACTION_BODY_BYTES,
      'a client that trims to exactly the cap has no headroom left',
    );
    assert.equal(EXTRACTION_JSON_BODY_LIMIT, MAX_EXTRACTION_BODY_BYTES);
  });

  await t.test('an oversize flush is refused with a readable 413, not a bare status', async () => {
    const res = await request(httpServer)
      .post('/api/v1/context/extraction')
      .set('X-Api-Key', process.env.DEERDAWN_API_KEY || 'dev-key')
      .send(oversizeExtractionBody());

    assert.equal(res.status, 413);
    assert.equal(res.body?.error, 'payload_too_large');
    const message = String(res.body?.message || '');
    // Says what the cap is, in a unit a human reads...
    assert.match(message, /KB/, `message should state the limit in KB: ${message}`);
    // ...and what to do about it, rather than only that it was refused.
    assert.match(message, /trim|split|smaller|fewer/i, `message should say what to do: ${message}`);
  });

  await t.test('the extraction limit stays modest — this parser runs before auth', () => {
    assert.ok(
      EXTRACTION_JSON_BODY_LIMIT <= 512 * 1024,
      'raising this cap moves the cost of a huge body to an unauthenticated request',
    );
    // The MCP/trail paths keep their own, larger limit — untouched here.
    assert.ok(TRAIL_JSON_BODY_LIMIT > EXTRACTION_JSON_BODY_LIMIT);
  });
});
