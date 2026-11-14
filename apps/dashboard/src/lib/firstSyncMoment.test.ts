/**
 * "It's working" and the first-sync conversions: only for THIS person's tool.
 *
 * Journey r1, H: sign up, skip connecting a tool, type a project name at
 * onboarding step 2, skip, "Continue free". Today said, truly, "No surface has
 * called in" — and PostSyncModal said "It's working — Your first context is
 * live." over it and pushed the Google Ads First Sync conversion (value 5) and
 * the GA4 first_sync_completed event, all keyed on `sync_health.has_projects`,
 * which the dashboard creates itself.
 *
 * Journey r2 (the regression in the r1 fix): a Team owner uses a tool; the
 * colleague they invite accepts, signs in on a new browser having connected
 * NOTHING, and got all three. The r1 fix borrowed Today's `everConnected`,
 * which falls back to `session_stats.total_sessions` — and the API counts that
 * over the whole WORKSPACE (dashboard.js, `context_session_loads WHERE
 * owner_key`), so the owner's session was read as the invitee's.
 *
 * So the rule under test: the decision is made from person-scoped fields only,
 * and no workspace-wide field can move it. Behaviour first, because a source
 * grep for the right identifier passes just as happily when the rule behind it
 * is wrong; the source contracts at the end pin that the component and the
 * module actually consult it.
 *
 * Run: `npx tsx --test src/lib/firstSyncMoment.test.ts`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { activeEnoughToAsk, ACTIVE_DAYS_BEFORE_ASK, briefReachedATool, firstSyncConversionDue, postSyncStep } from './firstSyncMoment';
import { absentCallout, readConnectionState, type McpSurface } from './todayConnection';

const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

/** The sync_health fields in play, as dashboard.js publishes them. */
type Health = {
  // Person-scoped once the workspace has more than one member.
  has_projects?: boolean | null;
  has_first_sync?: boolean | null;
  first_synced_at?: string | null;
  mcp_registered?: boolean;
  connector_authorized?: boolean;
  // Person-scoped always: distinct days of tool use (Thing 3h).
  active_days?: number | null;
  // Workspace-wide, always.
  session_stats?: { total_sessions: number; first_session_at: string | null } | null;
  mcp_surfaces?: McpSurface[];
};

const FRESH = { celebrated: false, offered: false };

/** The conversion decision: GA4 first_sync_completed and the Ads First Sync. */
const conversionDue = (health: Health, fired: boolean) => firstSyncConversionDue(health, fired);

/** The walker's solo account: a project typed into the dashboard, nothing else. */
const PROJECT_ONLY: Health = {
  has_projects: true,
  has_first_sync: false,
  first_synced_at: null,
  session_stats: { total_sessions: 0, first_session_at: null },
  mcp_surfaces: [],
};

/**
 * The r2 invitee, exactly as their bootstrap came back (r2/pages/s3d.out):
 * nothing of their own, one session in the workspace — the owner's.
 */
const INVITEE: Health = {
  has_projects: false,
  has_first_sync: false,
  first_synced_at: null,
  mcp_registered: false,
  session_stats: { total_sessions: 1, first_session_at: daysAgo(0) },
  mcp_surfaces: [{ surface: 'claude_code', last_called_at: daysAgo(0) }],
};

/** The same invitee after THEIR OWN tool loaded a brief. */
const INVITEE_DELIVERED: Health = {
  ...INVITEE,
  has_first_sync: true,
  first_synced_at: daysAgo(0),
  mcp_registered: true,
  session_stats: { total_sessions: 2, first_session_at: daysAgo(0) },
};

test('a project typed into the dashboard is not a first sync', () => {
  assert.equal(conversionDue(PROJECT_ONLY, false), false,
    'has_projects is set by the dashboard\'s own POST — it must not fire the first-sync GA4 event or the Google Ads conversion');
  assert.equal(postSyncStep(PROJECT_ONLY, FRESH), 'wait',
    '"It\'s working — Your first context is live." rendered over Today\'s "No surface has called in"');
});

test('an invited teammate who has connected nothing gets no celebration and fires no conversion', () => {
  assert.equal(postSyncStep(INVITEE, FRESH), 'wait',
    'the owner\'s session (session_stats is counted over the whole workspace) celebrated the invitee\'s "first context"');
  assert.equal(conversionDue(INVITEE, false), false,
    'the owner\'s session fired a first-sync conversion for an invitee who has connected nothing');
});

test('the same teammate, once THEIR OWN tool delivers, gets both — exactly once per browser', () => {
  assert.equal(postSyncStep(INVITEE_DELIVERED, FRESH), 'celebrate');
  assert.equal(conversionDue(INVITEE_DELIVERED, false), true);
  // What the browser has recorded after that beat (the component's two
  // once-ever keys): neither may happen again.
  assert.notEqual(postSyncStep(INVITEE_DELIVERED, { celebrated: true, offered: false }), 'celebrate');
  assert.notEqual(postSyncStep(INVITEE_DELIVERED, { celebrated: true, offered: true }), 'celebrate');
  assert.equal(conversionDue(INVITEE_DELIVERED, true), false);
});

test('a solo person whose tool delivered is celebrated once, and the ask comes on a later beat', () => {
  const solo: Health = { ...PROJECT_ONLY, has_first_sync: true, first_synced_at: daysAgo(0), active_days: 3 };
  assert.equal(postSyncStep(solo, FRESH), 'celebrate');
  assert.equal(postSyncStep(solo, { celebrated: true, offered: false }), 'offer');
  assert.equal(postSyncStep(solo, { celebrated: true, offered: true }), 'none');
});

test('a first delivery with no project yet is still a first sync', () => {
  // contextSyncService emits first_sync_completed for a GLOBAL-only delivery
  // (projectId: null), so a tool can load a brief before any project exists.
  const globalOnly: Health = { has_projects: false, has_first_sync: true, first_synced_at: daysAgo(0) };
  assert.equal(postSyncStep(globalOnly, FRESH), 'celebrate');
  assert.equal(conversionDue(globalOnly, false), true);
});

test('the upgrade ask keeps its own trigger: a celebrated browser with projects', () => {
  assert.equal(postSyncStep({ has_projects: true, active_days: 3 }, { celebrated: true, offered: false }), 'offer');
  assert.equal(postSyncStep({ has_projects: false, active_days: 3 }, { celebrated: true, offered: false }), 'wait');
});

// ── Thing 3h: no upgrade ask before three active days ────────────────────────

test('the post-sync upgrade ask waits for a third day of actual use', () => {
  const delivered: Health = { has_projects: true, has_first_sync: true, first_synced_at: daysAgo(0) };
  const celebrated = { celebrated: true, offered: false };
  for (const active_days of [undefined, null, 0, 1, 2]) {
    assert.equal(postSyncStep({ ...delivered, active_days }, celebrated), 'wait',
      `asked for money after ${String(active_days)} active day(s)`);
  }
  assert.equal(postSyncStep({ ...delivered, active_days: 3 }, celebrated), 'offer');
  assert.equal(postSyncStep({ ...delivered, active_days: 9 }, celebrated), 'offer');
  // The celebration is not an ask and is never held back by the gate.
  assert.equal(postSyncStep({ ...delivered, active_days: 0 }, FRESH), 'celebrate');
  // Once asked, never again, active or not.
  assert.equal(postSyncStep({ ...delivered, active_days: 1 }, { celebrated: true, offered: true }), 'none');
});

test('activeEnoughToAsk fails closed on a payload without the field', () => {
  assert.equal(ACTIVE_DAYS_BEFORE_ASK, 3);
  assert.equal(activeEnoughToAsk(undefined), false);
  assert.equal(activeEnoughToAsk({}), false);
  assert.equal(activeEnoughToAsk({ active_days: null }), false);
  assert.equal(activeEnoughToAsk({ active_days: 2 }), false);
  assert.equal(activeEnoughToAsk({ active_days: 3 }), true);
});

test('the third-brief offer consults the same active-days gate', () => {
  const code = codeOnly(path.join(import.meta.dirname, '..', 'components', 'dashboard', 'ThirdBriefOffer.tsx'));
  assert.match(code, /activeEnoughToAsk\(bootstrap\.sync_health\)/,
    'ThirdBriefOffer must hold its ask until activeEnoughToAsk says the person has been active on 3 days');
  assert.match(code, /if \(!activeEnough\) return;/);
});

// ── Deploy skew: the dashboard (Vercel) and the API (Fly) ship separately ────

test('an API payload that predates has_first_sync fails closed: nothing fires until it catches up', () => {
  // Before 2026-08-12 (#296) the bootstrap carried neither has_first_sync nor
  // first_synced_at — only the workspace-wide session count. That is not
  // evidence about this person, so the answer is "not yet", never "yes".
  const preFirstSync: Health = { has_projects: true, session_stats: { total_sessions: 12, first_session_at: daysAgo(60) } };
  assert.equal(postSyncStep(preFirstSync, FRESH), 'wait');
  assert.equal(conversionDue(preFirstSync, false), false);
});

test('first_synced_at alone still counts (it is the same person-scoped query), and an explicit false wins', () => {
  // has_first_sync and first_synced_at are one value in dashboard.js
  // (firstSyncRes), so they can only disagree in a payload we did not build.
  // Taking the explicit boolean when it is present is the conservative read.
  assert.equal(briefReachedATool({ first_synced_at: daysAgo(3) }), true);
  assert.equal(briefReachedATool({ first_synced_at: 'not a date' }), false);
  assert.equal(briefReachedATool({ has_first_sync: false, first_synced_at: daysAgo(3) }), false);
  assert.equal(briefReachedATool(null), false);
  assert.equal(briefReachedATool(undefined), false);
});

// ── The grid: no workspace-wide field can move the decision ──────────────────

const PERSON_SCOPED: Health[] = [];
for (const has_projects of [true, false]) {
  for (const firstSync of [
    {},
    { has_first_sync: false, first_synced_at: null },
    { has_first_sync: true, first_synced_at: daysAgo(1) },
    { first_synced_at: daysAgo(40) },
  ]) {
    for (const handshake of [{}, { mcp_registered: true, connector_authorized: true }]) {
      PERSON_SCOPED.push({ has_projects, ...firstSync, ...handshake });
    }
  }
}

const WORKSPACE_WIDE: Array<Pick<Health, 'session_stats' | 'mcp_surfaces'>> = [
  {},
  { session_stats: { total_sessions: 0, first_session_at: null }, mcp_surfaces: [] },
  { session_stats: { total_sessions: 1, first_session_at: daysAgo(0) } },
  { session_stats: { total_sessions: 900, first_session_at: daysAgo(200) } },
  { mcp_surfaces: [{ surface: 'claude_code', last_called_at: daysAgo(0) }] },
  { mcp_surfaces: [{ surface: 'chatgpt', last_called_at: daysAgo(12) }], session_stats: { total_sessions: 3, first_session_at: daysAgo(12) } },
];

const STORED = [
  { celebrated: false, offered: false },
  { celebrated: true, offered: false },
  { celebrated: true, offered: true },
];

test('flipping a workspace-wide field alone never changes the decision', () => {
  for (const person of PERSON_SCOPED) {
    const baseline = { conversion: conversionDue(person, false), steps: STORED.map((s) => postSyncStep(person, s)) };
    for (const workspace of WORKSPACE_WIDE) {
      const health: Health = { ...person, ...workspace };
      const label = JSON.stringify(health);
      assert.equal(conversionDue(health, false), baseline.conversion,
        `a workspace-wide field changed whether the first-sync conversion fires: ${label}`);
      assert.deepEqual(STORED.map((s) => postSyncStep(health, s)), baseline.steps,
        `a workspace-wide field changed what the modal shows: ${label}`);
    }
  }
});

test('a handshake is not a brief: mcp_registered and a connector grant alone fire nothing', () => {
  const handshake: Health = { has_projects: true, has_first_sync: false, mcp_registered: true, connector_authorized: true };
  assert.equal(postSyncStep(handshake, FRESH), 'wait');
  assert.equal(conversionDue(handshake, false), false);
});

test('the modal never celebrates while Today says nothing is reading the brief', () => {
  // One direction only, and deliberately. Today reads the workspace-wide
  // session count and surface list (todayConnection.everConnected), so in a
  // busy workspace it can say a tool is reading while this person's own tool
  // has never delivered — and the modal, correctly, stays silent. What must
  // never happen is the reverse: "It's working" over "No surface has called in".
  for (const person of PERSON_SCOPED) {
    for (const workspace of WORKSPACE_WIDE) {
      const health: Health = { ...person, ...workspace };
      const today = readConnectionState(health.mcp_surfaces, NOW, health);
      if (postSyncStep(health, FRESH) === 'celebrate') {
        assert.notEqual(today.absentReason, 'never',
          `"It's working" over "${absentCallout('never').message}": ${JSON.stringify(health)}`);
      }
    }
  }
});

// ── Source contracts ─────────────────────────────────────────────────────────

const codeOnly = (file: string) => fs.readFileSync(file, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('the rule reads no workspace-wide field, directly or through Today\'s helper', () => {
  const code = codeOnly(path.join(import.meta.dirname, 'firstSyncMoment.ts'));
  for (const field of ['session_stats', 'total_sessions', 'mcp_surfaces', 'everConnected', 'readConnectionState']) {
    assert.ok(!code.includes(field),
      `firstSyncMoment.ts reads ${field}, which dashboard.js computes over the whole workspace — ` +
        'a teammate\'s activity would celebrate and convert for this person');
  }
});

test('PostSyncModal decides through this rule, not through has_projects', () => {
  const code = codeOnly(path.join(import.meta.dirname, '..', 'components', 'dashboard', 'PostSyncModal.tsx'));

  assert.doesNotMatch(code, /has_projects|session_stats|mcp_surfaces|everConnected/,
    'PostSyncModal reads a sync_health field directly instead of going through lib/firstSyncMoment');

  assert.match(code,
    /firstSyncConversionDue\(bootstrap\.sync_health,[\s\S]{0,400}?fireConversion\(GADS_LABELS\.firstSync/,
    'the Google Ads first-sync conversion must sit behind firstSyncConversionDue');
  assert.match(code,
    /firstSyncConversionDue\(bootstrap\.sync_health,[\s\S]{0,400}?gaEvent\('first_sync_completed'/,
    'and so must the GA4 first_sync_completed event');

  assert.match(code, /const step = postSyncStep\(bootstrap\.sync_health,/,
    'the celebrate/offer decision must come from postSyncStep');
  assert.equal((code.match(/setMode\('celebrate'\)/g) || []).length, 1);
  assert.match(code, /step === 'celebrate'[\s\S]{0,200}?setMode\('celebrate'\)/,
    'the celebration must be reachable only from the celebrate step');
});
