const test = require('node:test');
const assert = require('node:assert');
const { v4: uuidv4 } = require('uuid');

const db = require('../../src/config/db');
const svc = require('../../src/services/email/conciergeRecovery');
const dormant = require('../../src/services/email/dormantReactivation');
const { closeRedisConnections } = require('../../src/config/redis');

// A-3 tells real people what went wrong on their own machine. The unit tests pin
// the send mechanics and the copy against a stubbed db; this pins WHO the query
// selects and WHAT it will say to them, against the real schema with real rows.
//
// That distinction earns its keep twice here. First, findRecipients swallows
// query errors and returns [] — a broken audience query does not raise, it
// silently mails nobody. Second, the diagnosis is derived from a second query
// whose jsonb metadata round-trip (has_request, tool) only exists against a real
// column; a stub can be made to return whatever shape the test wants.
//
// Needs the DB harness:
//   bash scripts/run-db-test.sh node --test tests/integration/concierge-recovery-audience.test.js

const created = [];

async function makeUser({ label, ageDays = 30, unsubscribed = false, email }) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const addr = email || `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  await db.query(
    'INSERT INTO organizations (org_id, name, subscription_status) VALUES ($1, $2, $3)',
    [orgId, `Concierge ${label}`, 'active'],
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

async function addEvent(user, eventName, metadata = {}) {
  await db.query(
    `INSERT INTO product_events (event_id, user_id, org_id, event_name, source, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [uuidv4(), user.userId, user.orgId, eventName, 'test', JSON.stringify(metadata)],
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

test('the audience is exactly the stuck accounts, and every exclusion holds', async () => {
  // Should receive it: tried, never activated.
  const stuck = await makeUser({ label: 'stuck' });
  await addEvent(stuck, 'mcp_config_copied', { tool: 'claude_code' });

  // Should also receive it: the hosted path has no config to copy, and a consent
  // screen that never handed off is still an attempt that broke.
  const hostedStuck = await makeUser({ label: 'hostedstuck' });
  await addEvent(hostedStuck, 'oauth_consent_viewed', { has_request: 0 });

  // Each of these must be excluded, for a different reason.
  const neverTried = await makeUser({ label: 'nevertried' });
  await addEvent(neverTried, 'onboarding_page_viewed');

  const activatedClient = await makeUser({ label: 'activatedclient' });
  await addEvent(activatedClient, 'mcp_config_copied', { tool: 'cursor' });
  await addEvent(activatedClient, 'first_sync_completed');

  // The server-side activation events are the load-bearing ones: first_sync is
  // client-side and fires once per browser, so an account can be working without
  // it. Either of the other two must be enough to keep someone out.
  const activatedServer = await makeUser({ label: 'activatedserver' });
  await addEvent(activatedServer, 'mcp_config_copied', { tool: 'cursor' });
  await addEvent(activatedServer, 'context_delivered');

  const optedOut = await makeUser({ label: 'optedout', unsubscribed: true });
  await addEvent(optedOut, 'mcp_config_copied');

  const alreadySent = await makeUser({ label: 'alreadysent' });
  await addEvent(alreadySent, 'mcp_config_copied');
  await addEvent(alreadySent, svc.SENT_EVENT);

  const tooNew = await makeUser({ label: 'toonew', ageDays: 1 });
  await addEvent(tooNew, 'mcp_config_copied');

  const testAccount = await makeUser({
    label: 'clerktest',
    email: `journey+clerk_test-${Date.now()}@example.com`,
  });
  await addEvent(testAccount, 'mcp_config_copied');

  const rows = await svc.findRecipients({ limit: 500 });
  const emails = new Set(rows.map((r) => r.email));

  assert.ok(emails.has(stuck.email), 'copied a config, never activated — this is the segment');
  assert.ok(emails.has(hostedStuck.email), 'a broken consent hand-off is an attempt, not an absence');

  const mustNotReceive = [
    [neverTried, 'only looked at onboarding — that is A-4 dormant, not stuck'],
    [activatedClient, 'activated (client-side)'],
    [activatedServer, 'activated (server-side) — first_sync is unreliable alone'],
    [optedOut, 'opted out of marketing mail'],
    [alreadySent, 'already received this campaign'],
    [tooNew, 'too new — the activation follow-up has not had its turn yet'],
    [testAccount, 'journey-test signup, not a real mailbox'],
  ];
  for (const [user, why] of mustNotReceive) {
    assert.ok(!emails.has(user.email), `excluded: ${why}`);
  }
});

test('A-3 and A-4 select disjoint audiences from the same rows', async () => {
  // The two emails say incompatible things — "the setup you skipped got shorter"
  // versus "I can see where the setup lost you". A person in both lists is told
  // two contradictory stories by the same founder in the same week. The unit
  // test proves the event lists are complements; this proves the QUERIES are.
  const tried = await makeUser({ label: 'disjoint-tried', ageDays: 40 });
  await addEvent(tried, 'setup_path_selected', { tool: 'codex' });

  const looked = await makeUser({ label: 'disjoint-looked', ageDays: 40 });
  await addEvent(looked, 'mcp_setup_viewed');

  const stuckRows = await svc.findRecipients({ limit: 500 });
  const dormantRows = await dormant.findRecipients({ limit: 500 });
  const stuckEmails = new Set(stuckRows.map((r) => r.email));
  const dormantEmails = new Set(dormantRows.map((r) => r.email));

  const both = [...stuckEmails].filter((e) => dormantEmails.has(e));
  assert.deepEqual(both, [], 'nobody may be in both campaigns');

  assert.ok(stuckEmails.has(tried.email), 'picking a tool is an attempt — A-3');
  assert.ok(dormantEmails.has(looked.email), 'only viewing setup is not — A-4');
});

test('the diagnosis is derived from real jsonb metadata, per person', async () => {
  const claudeCode = await makeUser({ label: 'diag-cc' });
  await addEvent(claudeCode, 'setup_path_selected', { tool: 'claude_code' });
  await addEvent(claudeCode, 'mcp_config_copied', { tool: 'claude_code' });

  const brokenHandoff = await makeUser({ label: 'diag-oauth' });
  await addEvent(brokenHandoff, 'mcp_config_copied', { tool: 'cursor' });
  await addEvent(brokenHandoff, 'oauth_consent_viewed', { has_request: 0 });

  const connectedNoBrief = await makeUser({ label: 'diag-connected' });
  await addEvent(connectedNoBrief, 'mcp_config_copied', { tool: 'cursor' });
  await addEvent(connectedNoBrief, 'onboarding_connection_detected');

  const unknownTool = await makeUser({ label: 'diag-unknown' });
  await addEvent(unknownTool, 'mcp_config_copied'); // no tool in metadata

  const audience = await svc.buildAudience({ limit: 500 });
  const byEmail = new Map(audience.map((r) => [r.email, r]));

  assert.match(byEmail.get(claudeCode.email).diagnosis.hypothesis, /registers servers through its own command/);
  assert.match(byEmail.get(brokenHandoff.email).diagnosis.hypothesis, /without the actual request attached/,
    'has_request=0 must survive the jsonb round trip as a number');
  assert.match(byEmail.get(connectedNoBrief.email).diagnosis.hypothesis, /never got asked for a brief/);

  const unknown = byEmail.get(unknownTool.email).diagnosis;
  assert.equal(unknown.hypothesis, null, 'no tool means no guess — the step is still stated');
  assert.equal(unknown.stepPhrase, 'copying the config');
});

test('a running MCP session with no activation is the blind spot, not a stuck setup', async () => {
  // These are the C-1a accounts. Before the fix, hosted start_session answered
  // from getWorkspaceOverview and emitted no activation event at all, so an
  // account could be working perfectly and look dead. They get the question, not
  // the diagnosis.
  const ranSession = await makeUser({ label: 'blindspot' });
  await addEvent(ranSession, 'mcp_config_copied', { tool: 'claude_desktop' });
  await addEvent(ranSession, 'mcp_runtime_started');

  const audience = await svc.buildAudience({ limit: 500 });
  const row = audience.find((r) => r.email === ranSession.email);
  assert.ok(row, 'still in the audience — no activation is on record');
  assert.equal(row.variant, svc.VARIANT_BLIND_SPOT);
});

test('org-attributed events count toward the account', async () => {
  // Key-authed MCP calls carry no user actor: productEventsService keys them to
  // the org. If the ladder query only joined on user_id, a person whose only
  // runtime evidence is org-keyed would be miscategorised as never having run
  // anything and be sent the wrong variant.
  const orgOnly = await makeUser({ label: 'orgonly' });
  await addEvent(orgOnly, 'mcp_config_copied', { tool: 'cursor' });
  await db.query(
    `INSERT INTO product_events (event_id, user_id, org_id, event_name, source)
     VALUES ($1, NULL, $2, $3, $4)`,
    [uuidv4(), orgOnly.orgId, 'mcp_start_session_succeeded', 'test'],
    orgOnly.orgId
  );

  const audience = await svc.buildAudience({ limit: 500 });
  const row = audience.find((r) => r.email === orgOnly.email);
  assert.equal(row.variant, svc.VARIANT_BLIND_SPOT, 'the org-keyed runtime event must be seen');
});

test('a dry run against real rows sends nothing and reports a readable audience', async () => {
  const result = await svc.sendConciergeRecoveryEmails({ limit: 500 });
  assert.equal(result.dryRun, true);
  assert.equal(result.sent, 0);
  assert.ok(result.recipients.length > 0);
  assert.ok(
    result.recipients.every((r) => r.email && r.user_id && r.variant && r.diagnosis),
    'every row carries what the send loop and the human reviewer both need'
  );
});

test('--only narrows to one person, which is how the draft says to send these', async () => {
  const target = await makeUser({ label: 'onlyone' });
  await addEvent(target, 'mcp_config_copied', { tool: 'codex' });

  const rows = await svc.findRecipients({ limit: 500, onlyEmail: target.email.toUpperCase() });
  assert.equal(rows.length, 1, 'and the match is case-insensitive');
  assert.equal(rows[0].email, target.email);
});
