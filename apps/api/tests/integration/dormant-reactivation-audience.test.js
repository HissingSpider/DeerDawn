const test = require('node:test');
const assert = require('node:assert');
const { v4: uuidv4 } = require('uuid');

const db = require('../../src/config/db');
const svc = require('../../src/services/email/dormantReactivation');
const { closeRedisConnections } = require('../../src/config/redis');

// A-4 mails ~28 real people who never used the product. The unit tests pin the
// send mechanics against a stubbed db; this pins WHO the query actually selects,
// against the real schema with real rows. That distinction matters here more
// than usual: findRecipients swallows query errors and returns [], so a broken
// audience query does not raise — it silently mails nobody, or worse, mails the
// wrong people. Only real rows can tell the two apart.
//
// Needs the DB harness: bash scripts/run-db-test.sh node --test tests/integration/dormant-reactivation-audience.test.js

const created = [];

async function makeUser({ label, ageDays = 30, unsubscribed = false, email }) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const addr = email || `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  await db.query(
    'INSERT INTO organizations (org_id, name, subscription_status) VALUES ($1, $2, $3)',
    [orgId, `Dormant ${label}`, 'active'],
    orgId
  );
  await db.query(
    `INSERT INTO users (user_id, email, password_hash, role, org_id, created_at, weekly_digest_unsubscribed)
     VALUES ($1, $2, $3, $4, $5, NOW() - ($6 || ' days')::interval, $7)`,
    [userId, addr, 'x', 'admin', orgId, String(ageDays), unsubscribed],
    orgId
  );
  created.push({ orgId, userId });
  return { orgId, userId, email: addr };
}

async function addEvent(user, eventName) {
  await db.query(
    `INSERT INTO product_events (event_id, user_id, org_id, event_name, source)
     VALUES ($1, $2, $3, $4, $5)`,
    [uuidv4(), user.userId, user.orgId, eventName, 'test'],
    user.orgId
  );
}

test.after(async () => {
  for (const { orgId } of created) {
    await db.query('DELETE FROM product_events WHERE org_id = $1', [orgId], orgId).catch(() => {});
    await db.query('DELETE FROM users WHERE org_id = $1', [orgId], orgId).catch(() => {});
    await db.query('DELETE FROM organizations WHERE org_id = $1', [orgId], orgId).catch(() => {});
  }
  await closeRedisConnections().catch(() => {});
});

test('the audience is exactly the dormant accounts, and every exclusion holds', async () => {
  // The one person who SHOULD get it: signed up a month ago, never did anything.
  const dormant = await makeUser({ label: 'dormant', ageDays: 30 });

  // Each of these must be excluded, for a different reason.
  const copiedConfig = await makeUser({ label: 'copied', ageDays: 30 });
  await addEvent(copiedConfig, 'mcp_config_copied');

  const hostedUser = await makeUser({ label: 'hosted', ageDays: 30 });
  await addEvent(hostedUser, 'oauth_consent_approved'); // never copies a config

  const activated = await makeUser({ label: 'activated', ageDays: 30 });
  await addEvent(activated, 'first_sync_completed');

  const optedOut = await makeUser({ label: 'optedout', ageDays: 30, unsubscribed: true });

  const alreadySent = await makeUser({ label: 'alreadysent', ageDays: 30 });
  await addEvent(alreadySent, svc.SENT_EVENT);

  const tooNew = await makeUser({ label: 'toonew', ageDays: 1 });

  const testAccount = await makeUser({
    label: 'clerktest',
    ageDays: 30,
    email: `journey+clerk_test-${Date.now()}@example.com`,
  });

  const rows = await svc.findRecipients({ limit: 500 });
  const emails = new Set(rows.map((r) => r.email));

  assert.ok(emails.has(dormant.email), 'the dormant account must be in the audience');

  const mustNotReceive = [
    [copiedConfig, 'copied a config — past the dormancy line'],
    [hostedUser, 'took the hosted path, so never copied a config — must not read as dormant'],
    [activated, 'actually activated'],
    [optedOut, 'opted out of marketing mail'],
    [alreadySent, 'already received this campaign'],
    [tooNew, 'too new — belongs to the activation follow-up, not this'],
    [testAccount, 'journey-test signup, not a real mailbox'],
  ];
  for (const [user, why] of mustNotReceive) {
    assert.ok(!emails.has(user.email), `excluded: ${why}`);
  }
});

test('a dry run against real rows sends nothing and reports the audience', async () => {
  const result = await svc.sendDormantReactivationEmails({ limit: 500 });
  assert.equal(result.dryRun, true);
  assert.equal(result.sent, 0);
  assert.ok(Array.isArray(result.recipients));
  assert.ok(
    result.recipients.every((r) => r.email && r.user_id),
    'every row carries what the send loop needs — a missing email would be a silent skip'
  );
});

test('the limit is honoured, so a first real send can be a handful', async () => {
  await makeUser({ label: 'extra1', ageDays: 30 });
  await makeUser({ label: 'extra2', ageDays: 30 });
  const rows = await svc.findRecipients({ limit: 1 });
  assert.equal(rows.length, 1, '--limit=1 must actually bound the send');
});
