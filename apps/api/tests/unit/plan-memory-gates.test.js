/**
 * Plan memory gates — the "never forgets" entitlement model.
 *
 * Free is bounded by TIME, not by volume: unlimited workspaces, a 90-day brief
 * memory window. Pro (developer_basic) is uncapped everywhere (null limits —
 * nothing on a paid plan runs out). Verifies:
 *   1. No workspace cap: a free org can create as many top-level projects as it
 *      likes. The cap was removed on 2026-08-27 because it sat directly on top
 *      of the moat — a capped free user only ever experiences per-project
 *      memory, which is the commoditized half, and can never reach the
 *      cross-project state Pro is sold on.
 *   2. Memory window: a free org's brief drops decisions older than
 *      history_days, discloses what it left out, and reports the structured
 *      history_window; Pro briefs keep old decisions untouched.
 *
 * Both windows read history_days from PLANS rather than hard-coding it, so
 * moving the window is a one-line config change and not a test rewrite.
 */
const test = require('node:test');
const assert = require('node:assert');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');
const { ensureRuntimeSchema } = require('../helpers/runtimeSchema');
const { PLANS } = require('../../src/config/plans');

const FREE_HISTORY_DAYS = PLANS.free.limits.history_days;

// org_id must be org-<uuid> (db.js ORG_ID_PATTERN); fixed values keep reruns idempotent.
const FREE_ORG = 'org-aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1';
const PRO_ORG = 'org-bbbbbbbb-2222-4222-8222-bbbbbbbbbbb2';

function freeActor() {
  return { org_id: FREE_ORG, id: 'user-memgate-free' };
}

function proActor() {
  return { org_id: PRO_ORG, id: 'user-memgate-pro' };
}

async function seedOrg(orgId, planTier) {
  await db.query('DELETE FROM organizations WHERE org_id = $1', [orgId], orgId);
  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status) VALUES ($1, $2, $3, $3, $4)',
    [orgId, `Memgate ${planTier}`, planTier, 'active'],
    orgId
  );
}

const OLD_DECISION = 'Ancient decision from months ago';
const FRESH_DECISION = 'Fresh decision from this session';

async function seedDecisions(actor, project) {
  project.context.recent_decisions = [
    { summary: OLD_DECISION, decided_at: '2026-01-01T00:00:00.000Z', importance: 'normal' },
    { summary: FRESH_DECISION, decided_at: new Date().toISOString(), importance: 'normal' },
  ];
  await store.saveProject(project, actor);
}

test('plan memory gates: unlimited workspaces and the brief memory window', async (t) => {
  // migrate.js alone doesn't create the referral schema (referral_premium_until,
  // referrals) — runAutoMigration does, at server boot. On a fresh CI database
  // the entitlement lookup would throw and fail open, silently disabling the
  // very gates under test — so sync the runtime schema first.
  await ensureRuntimeSchema();
  await store.clearAll();
  // clearAll only wipes org-system rows; wipe this test's owners for idempotent reruns.
  await db.query('DELETE FROM context_projects WHERE owner_key = ANY($1)', [[FREE_ORG, PRO_ORG]], 'org-system');
  await seedOrg(FREE_ORG, 'free');
  await seedOrg(PRO_ORG, 'developer_basic');

  const freeProject = await service.createProject(freeActor(), { project_name: 'Memgate Free One' });
  await service.createProject(freeActor(), { project_name: 'Memgate Free Two' });
  await service.createProject(freeActor(), { project_name: 'Memgate Free Three' });

  await t.test('free org: the fourth top-level project is NOT blocked', async () => {
    // Project four is exactly where cross-project stops being a feature and
    // starts being a need — which is why it must be reachable on Free. This is
    // the regression guard for reintroducing the cap by accident.
    assert.strictEqual(PLANS.free.limits.included_projects, null, 'premise: Free is uncapped on projects');
    const fourth = await service.createProject(freeActor(), { project_name: 'Memgate Free Four' });
    assert.ok(fourth.project_id);
    const fifth = await service.createProject(freeActor(), { project_name: 'Memgate Free Five' });
    assert.ok(fifth.project_id);
  });

  await t.test('free org: subprojects still work under an uncapped parent', async () => {
    const sub = await service.createProject(freeActor(), {
      project_name: 'Memgate Free Substream',
      parent_project_id: freeProject.project_id,
    });
    assert.strictEqual(sub.parent_project_id, freeProject.project_id);
  });

  await t.test('pro org: multiple projects, no cap', async () => {
    const one = await service.createProject(proActor(), { project_name: 'Memgate Pro One' });
    const two = await service.createProject(proActor(), { project_name: 'Memgate Pro Two' });
    assert.ok(one.project_id && two.project_id);
  });

  await t.test('org-system actor is never capped', async () => {
    const sys = { org_id: 'org-system', id: 'system-key' };
    const a = await service.createProject(sys, { project_name: 'Memgate System A' });
    const b = await service.createProject(sys, { project_name: 'Memgate System B' });
    assert.ok(a.project_id && b.project_id);
  });

  await t.test('free brief windows out old decisions and says what it forgot', async () => {
    await seedDecisions(freeActor(), freeProject);
    const payload = await service.renderInjection(freeActor(), freeProject.project_id, 'cursor', 'detailed');
    assert.ok(payload, 'expected an injection payload');
    assert.ok(payload.body.includes(FRESH_DECISION), 'fresh decision must stay in the brief');
    assert.ok(!payload.body.includes(OLD_DECISION), 'old decision must age out of a free brief');
    // The disclosure is load-bearing and stays: an agent must know it is working
    // from partial history. What must NOT be there is the plan pitch that used
    // to follow it — a brief is a tool response injected into someone's
    // assistant, not an ad slot.
    assert.match(
      payload.body,
      new RegExp(`outside this plan's ${FREE_HISTORY_DAYS}-day history window`),
      'brief must state what it left out',
    );
    assert.match(payload.body, /Nothing has been deleted/, 'and that the entries still exist');
    assert.ok(!/deerdawn\.com\/pricing/.test(payload.body), 'no pricing URL in an injected brief');
    assert.ok(!/\bPro\b/.test(payload.body), 'no plan upsell in an injected brief');
    assert.deepStrictEqual(payload.history_window, { aged_out: 1, days: FREE_HISTORY_DAYS });
  });

  await t.test('pro brief keeps old decisions — permanent memory, no window line', async () => {
    const proProject = await service.createProject(proActor(), { project_name: 'Memgate Pro Memory' });
    // Only the old decision: the formatter renders the newest decision, so this
    // is the direct proof that a months-old decision still reaches a pro brief.
    proProject.context.recent_decisions = [
      { summary: OLD_DECISION, decided_at: '2026-01-01T00:00:00.000Z', importance: 'normal' },
    ];
    await store.saveProject(proProject, proActor());
    const payload = await service.renderInjection(proActor(), proProject.project_id, 'cursor', 'detailed');
    assert.ok(payload, 'expected an injection payload');
    assert.ok(payload.body.includes(OLD_DECISION), 'pro briefs remember everything');
    assert.ok(!/history window/.test(payload.body), 'no history-window line on pro');
    assert.strictEqual(payload.history_window, null);
  });

  await db.query('DELETE FROM organizations WHERE org_id = ANY($1)', [[FREE_ORG, PRO_ORG]], 'org-system');
  await closeRedisConnections();
  await db.pool.end();
});
