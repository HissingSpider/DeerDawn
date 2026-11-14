'use strict';

/**
 * Erasure has to end the session, not only empty the tables.
 *
 * purgeOwnerData deleted context rows and the api_keys ROWS, and stopped there.
 * What survived a right-to-erasure request:
 *   - the API key CACHE. Auth reads a 5-minute LRU before it reads the DB and
 *     nothing invalidated it, so a deleted account's credential kept working for
 *     up to five more minutes — against a workspace whose data was being deleted
 *     underneath it.
 *   - Redis REFRESH TOKENS. Keyed by a hash of the token, so nothing could find
 *     them by owner; a connector could mint a brand-new access key after the
 *     account was gone.
 *   - rows with PII on them: workspace invites (a colleague's email address),
 *     memberships, approved domains, shared skills, workspace pointers, access
 *     logs (IP + user agent) and the product_events mirror.
 *
 * DB-backed; run via scripts/run-db-test.sh node --test tests/unit/data-erasure-residue.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const db = require('../../src/config/db');
const { redis, closeRedisConnections } = require('../../src/config/redis');
const apiKeyCache = require('../../src/services/apiKeyCache');
const posthog = require('../../src/services/posthog');
const erasure = require('../../src/services/dataErasureService');

const RUN = crypto.randomBytes(4).toString('hex');
const ORG = `org-${crypto.randomUUID()}`;
const USER = `user-erasure-${RUN}`;
const EMAIL = `erasure-${RUN}@example.com`;
const KEY_HASH = `hash-${crypto.randomUUID()}`;
const REFRESH_KEY = `oauth:refresh:${crypto.createHash('sha256').update(`ddr_${RUN}`).digest('hex')}`;

const captured = [];
const realCapture = posthog.captureProductEvent;

async function sql(text, params) {
  return db.query(text, params, 'org-system');
}

async function count(text, params) {
  const r = await sql(text, params);
  return r.rows.length;
}

test.before(async () => {
  posthog.captureProductEvent = (payload) => { captured.push(payload); };

  await sql(
    'INSERT INTO organizations (org_id, name, plan_tier, subscription_status) VALUES ($1,$2,$3,$4)',
    [ORG, `Erasure ${RUN}`, 'starter', 'active'],
  );
  await sql(
    'INSERT INTO users (user_id, email, role, org_id) VALUES ($1,$2,$3,$4)',
    [USER, EMAIL, 'owner', ORG],
  );
  await sql(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [`key-${RUN}`, 'dd_x', KEY_HASH, 'k', USER, ORG, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read']],
  );
  // The live session: a warm cache entry and a Redis refresh token.
  apiKeyCache.setApiKey(KEY_HASH, { key_id: `key-${RUN}`, org_id: ORG, owner_id: USER, scopes: ['context:read'] });
  await redis.set(REFRESH_KEY, JSON.stringify({ owner_id: USER, org_id: ORG, access_key_hash: KEY_HASH }));
  // Seeded through the raw index contract rather than the helper, so this suite
  // fails on the BEHAVIOUR when the behaviour is missing, not on a missing export.
  await redis.sadd(`oauth:refresh:owner:${ORG}`, REFRESH_KEY);

  // Residue with PII on it.
  await sql(
    'INSERT INTO workspace_members (owner_key, user_id, role) VALUES ($1,$2,$3)',
    [ORG, USER, 'owner'],
  );
  await sql(
    `INSERT INTO workspace_invites (invite_id, owner_key, email, role, token_hash, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [`inv-${RUN}`, ORG, `colleague-${RUN}@example.com`, 'member', `th-${RUN}`,
      new Date(Date.now() + 86400000).toISOString()],
  );
  await sql(
    'INSERT INTO workspace_domains (owner_key, domain, role) VALUES ($1,$2,$3)',
    [ORG, `erasure-${RUN}.example.com`, 'member'],
  );
  await sql(
    `INSERT INTO workspace_skills (skill_id, owner_key, slug, name, markdown_content)
     VALUES ($1,$2,$3,$4,$5)`,
    [`skill-${RUN}`, ORG, `slug-${RUN}`, 'Runbook', 'internal know-how'],
  );
  await sql(
    'INSERT INTO context_workspace_pointers (owner_key, workspace_key, active_project_id) VALUES ($1,$2,$3)',
    [ORG, `/Users/someone/code-${RUN}`, `proj-${RUN}`],
  );
  await sql(
    `INSERT INTO access_logs (access_id, org_id, actor_id, method, path, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [`acc-${RUN}`, ORG, USER, 'GET', '/api/v1/context/map', '203.0.113.7', 'Claude/1.0'],
  );
  await sql(
    'INSERT INTO product_events (event_id, event_name, org_id, user_id, source) VALUES ($1,$2,$3,$4,$5)',
    [crypto.randomUUID(), 'context_synced', ORG, USER, 'api'],
  );
});

test.after(async () => {
  posthog.captureProductEvent = realCapture;
  for (const [text, params] of [
    ['DELETE FROM api_keys WHERE org_id = $1', [ORG]],
    ['DELETE FROM workspace_members WHERE owner_key = $1', [ORG]],
    ['DELETE FROM workspace_invites WHERE owner_key = $1', [ORG]],
    ['DELETE FROM workspace_domains WHERE owner_key = $1', [ORG]],
    ['DELETE FROM workspace_skills WHERE owner_key = $1', [ORG]],
    ['DELETE FROM context_workspace_pointers WHERE owner_key = $1', [ORG]],
    ['DELETE FROM access_logs WHERE org_id = $1', [ORG]],
    ['DELETE FROM product_events WHERE org_id = $1', [ORG]],
    ['DELETE FROM users WHERE org_id = $1', [ORG]],
    ['DELETE FROM organizations WHERE org_id = $1', [ORG]],
  ]) {
    await sql(text, params).catch(() => {});
  }
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});

test('a purge ends the live session and leaves no PII behind', async () => {
  const deleted = await erasure.purgeOwnerData(ORG);
  for (const [table, result] of Object.entries(deleted)) {
    assert.equal(typeof result, 'number', `${table} should delete cleanly, got: ${result}`);
  }

  // 1. The credential stops working NOW, not in five minutes.
  assert.ok(!apiKeyCache.getApiKey(KEY_HASH), 'the cached API key must be invalidated');

  // 2. The refresh token cannot mint a new access key for a deleted account.
  assert.equal(await redis.get(REFRESH_KEY), null, 'the refresh token must be revoked');

  // 3. Nothing owner-scoped survives.
  assert.equal(await count('SELECT 1 FROM workspace_members WHERE owner_key = $1', [ORG]), 0);
  assert.equal(await count('SELECT 1 FROM workspace_invites WHERE owner_key = $1', [ORG]), 0, 'invites carry a colleague\'s email');
  assert.equal(await count('SELECT 1 FROM workspace_domains WHERE owner_key = $1', [ORG]), 0);
  assert.equal(await count('SELECT 1 FROM workspace_skills WHERE owner_key = $1', [ORG]), 0);
  assert.equal(await count('SELECT 1 FROM context_workspace_pointers WHERE owner_key = $1', [ORG]), 0);
  assert.equal(await count('SELECT 1 FROM access_logs WHERE org_id = $1', [ORG]), 0, 'access logs carry IP and user agent');
  assert.equal(await count('SELECT 1 FROM product_events WHERE org_id = $1', [ORG]), 0);
  assert.equal(await count('SELECT 1 FROM api_keys WHERE org_id = $1', [ORG]), 0);

  // 4. The analytics person's properties are the one thing this process cannot
  //    delete from here, so it must at least ask for their removal, per person.
  const suppression = captured.find((c) => c.distinctId === USER);
  assert.ok(suppression, 'an erasure signal is emitted for each erased person');
  assert.ok(
    Array.isArray(suppression.properties.$unset) && suppression.properties.$unset.includes('email'),
    'the PII person properties are unset by name',
  );
});
