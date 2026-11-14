/**
 * AN ERROR REPORT DOES NOT CARRY THE CONVERSATION IT FAILED ON. (A guard.)
 *
 * The end-of-session flush posts the conversation itself to
 * /api/v1/context/extraction. The API processes it and keeps none of it, and a
 * failure of that request is reported to Sentry. @sentry/node can attach the
 * incoming request body to an error event (its http integration reads up to
 * 10 KB by default when it instruments a request); `sendDefaultPii: false` in
 * instrument.js is not what stops that. Journey scan round 3 checked what
 * actually leaves: with the SDK and configuration this API runs, the event
 * carries the error, its stack and the extras errorHandler passes — and no
 * request data at all.
 *
 * This pins that. It drives a real failure through the real app, Sentry
 * initialised first as server.js does and pointed at a local stand-in for its
 * ingest endpoint, after a warm-up request (Sentry instruments a server on the
 * first request it sees). The error must arrive, or the test proves nothing;
 * the words the request carried must not. An SDK upgrade or an integration
 * change that starts shipping bodies fails here.
 *
 *   bash scripts/run-db-test.sh node --test tests/integration/sentry-sends-no-request-body.test.js
 */

process.env.NODE_ENV = 'test';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);

const { execFileSync } = require('child_process');

// A free port for the stand-in ingest endpoint, found without loading `http`:
// Sentry is initialised first, before anything loads it, as server.js orders it.
const INGEST_PORT = Number(execFileSync(process.execPath, ['-e',
  'const s=require(\'net\').createServer().listen(0,\'127.0.0.1\',()=>{process.stdout.write(String(s.address().port));s.close();})']).toString());
process.env.SENTRY_DSN = `http://publickey@127.0.0.1:${INGEST_PORT}/1`;
const Sentry = require('../../src/instrument');

const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

// A stand-in for Sentry's ingest endpoint, listening before Sentry starts.
const received = [];
const ingest = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    if (/gzip/.test(req.headers['content-encoding'] || '')) body = zlib.gunzipSync(body);
    received.push(body.toString('utf8'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
});

const MARK = `QZFLUSH${[...crypto.randomBytes(14)].map((b) => String.fromCharCode(65 + (b % 26))).join('')}`;

test('a failed flush reaches Sentry without the conversation it carried', async () => {
  await new Promise((resolve) => ingest.listen(INGEST_PORT, '127.0.0.1', resolve));

  const request = require('supertest');
  const { v4: uuidv4 } = require('uuid');
  const app = require('../../src/app');
  const db = require('../../src/config/db');
  const { hashPassword, generateApiKey } = require('../../src/utils/security');
  const workspace = require('../../src/services/workspaceService');
  const service = require('../../src/services/contextSyncService');
  const extractionService = require('../../src/services/extractionService');
  const q = (sql, params) => db.query(sql, params, 'org-system');

  const orgId = `org-${uuidv4()}`;
  await q('INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status) VALUES ($1, $2, $3, $4, $5)', [orgId, 'sentry', 'free', 'free', 'active']);
  const userId = `user-${uuidv4()}`;
  await q('INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)', [userId, `sentry-${uuidv4().slice(0, 8)}@e2e.test`, await hashPassword('password123'), 'admin', orgId]);
  await workspace.ensureOwnerMembership(orgId, userId);
  const { key, prefix, hash } = generateApiKey();
  await q(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, 'k', userId, orgId, 'production', new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
  );

  const server = app.listen(0);
  const realRun = extractionService.runExtraction;
  const realApply = service.applyExtraction;
  extractionService.runExtraction = async () => ({
    match_decision: 'matched_existing', confidence: 0.9, delta: { current_task: 'x' },
    should_create_project: false, needs_user_confirmation: false, no_material_change: false,
  });
  service.applyExtraction = async () => { throw new Error('the database went away mid-flush'); };
  try {
    // Sentry instruments a server on the FIRST request it sees (a diagnostics
    // channel hook that wraps server.emit), so that one request goes
    // unobserved. A live API has served thousands before any flush fails;
    // warm this one up the same way.
    await request(server).get('/health');
    const res = await request(server).post('/api/v1/context/extraction').set('X-Api-Key', key).send({
      session_id: `sess-${uuidv4()}`,
      tool: 'claude_code',
      chunks: [
        { role: 'user', text: `Please look at why the invoice run skips ${MARK} every Friday.` },
        { role: 'assistant', text: `It is filtered out because ${MARK} has no billing address.` },
      ],
    });
    assert.equal(res.status, 500, `premise: the flush failed on the server: ${res.status} ${JSON.stringify(res.body)}`);
    assert.ok(!JSON.stringify(res.body).includes(MARK), 'the reply does not echo it either');
    await Sentry.flush(5000);
  } finally {
    extractionService.runExtraction = realRun;
    service.applyExtraction = realApply;
    await new Promise((resolve) => server.close(resolve));
    await Sentry.close(2000);
    await new Promise((resolve) => ingest.close(resolve));
    await db.pool.end().catch(() => {});
  }

  const events = received.filter((body) => body.includes('the database went away mid-flush'));
  assert.ok(events.length >= 1, `premise: the error was reported (${received.length} envelope(s) arrived)`);
  for (const body of events) {
    assert.ok(!body.includes(MARK), 'the error report carries the conversation the request was carrying');
  }
});
