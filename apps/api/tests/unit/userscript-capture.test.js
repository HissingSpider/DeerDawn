/**
 * Userscript generator — the generated browser script must be valid JS and must
 * include the new bidirectional-capture path (POST back to /extraction).
 *
 * A syntax error in the generated script fails silently in users' browsers, so we
 * assert the output parses via `new Function`. Auth/db/security are stubbed via
 * require.cache so no DB is needed.
 *
 * Run: node tests/unit/userscript-capture.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

require.cache[require.resolve('../../src/middleware/auth')] = {
  id: require.resolve('../../src/middleware/auth'),
  loaded: true,
  exports: {
    requireAuth: (req, _res, next) => { req.actor = { id: 'user-1', org_id: 'org-system' }; next(); },
    requireRole: () => (_req, _res, next) => next(),
    requireAnyScope: () => (_req, _res, next) => next(),
  },
};
require.cache[require.resolve('../../src/config/db')] = {
  id: require.resolve('../../src/config/db'),
  loaded: true,
  exports: { query: async () => ({ rows: [] }) },
};
require.cache[require.resolve('../../src/utils/security')] = {
  id: require.resolve('../../src/utils/security'),
  loaded: true,
  exports: { generateApiKey: () => ({ key: 'dd_testkey1234567890', prefix: 'dd_test', hash: 'hash' }) },
};

const userscriptRouter = require('../../src/routes/context/userscript');
const { TOOL_VALUES } = require('../../../../packages/shared-context/src/index.js');
const app = express();
app.use('/u', userscriptRouter);

test('every capture-enabled web tool is accepted by the extraction enum', () => {
  // Capture POSTs to /extraction validate `tool` against TOOL_VALUES; a web tool
  // missing here would inject context but silently fail to write back (400).
  for (const tool of ['claude_web', 'chatgpt_web', 'gemini', 'perplexity']) {
    assert.ok(TOOL_VALUES.includes(tool), `${tool} must be in TOOL_VALUES so capture POSTs validate`);
  }
});

for (const tool of ['claude_web', 'chatgpt_web', 'gemini', 'perplexity']) {
  test(`userscript (${tool}) generates valid, capture-enabled JS`, async () => {
    const res = await request(app).get('/u/?tool=' + tool);
    assert.strictEqual(res.status, 200, 'route returns the script');
    const body = res.text;

    // Generated script must be syntactically valid (parsed, not executed).
    assert.doesNotThrow(() => new Function(body), 'generated userscript must parse as valid JS');

    // Bidirectional: still injects, and now captures back to the extraction pipeline.
    assert.ok(body.includes('captureMessages'), 'includes the capture reader');
    assert.ok(body.includes('/api/v1/context/extraction'), 'posts captured turns back to extraction');
    assert.ok(body.includes('onMessageSend'), 'still injects context on send');

    // P1: the script reports the browser timezone so the server can render local time.
    assert.ok(body.includes('resolvedOptions().timeZone'), 'reads the browser timezone');
    assert.ok(body.includes('&tz='), 'sends tz on the context fetch');

    // P3: the topic confirm chip + session-topic binding.
    assert.ok(body.includes('/api/v1/context/session/topic'), 'reads/writes the session topic');
    assert.ok(body.includes('dd-topic-chip'), 'renders the in-page topic chip');
    assert.ok(body.includes('bindTopic'), 'can confirm/switch/create a topic');
  });
}
