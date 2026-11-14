/**
 * Today's connection strip and proof line.
 *
 * These assert BEHAVIOUR, not source text. Every contract suite in `tests/`
 * reads files with `fs.readFileSync`, which means it can pin a string but can
 * never tell you what the page decided — a suite full of `includes('Connect a
 * tool')` assertions passes just as happily when the button is rendered twice,
 * which is the exact defect these tests were written after. The rules therefore
 * live in `todayConnection.ts` as functions, and this is where they are checked.
 *
 * Run: `npx tsx --test src/lib/todayConnection.test.ts`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CONNECT_CTA_LABEL,
  CONNECT_ROUTE,
  RECONNECT_CTA_LABEL,
  RECONNECT_ROUTE,
  SURFACE_STALE_DAYS,
  SURFACE_WINDOW_DAYS,
  absentCallout,
  connectionPlacement,
  everConnected,
  proofLine,
  readConnectionState,
  type ConnectionHistory,
  type McpSurface,
} from './todayConnection';

const NOW = Date.parse('2026-08-29T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

const surface = (name: string, lastCalled: string | null): McpSurface => ({
  surface: name,
  last_called_at: lastCalled,
});

// ── The duplicate CTA ────────────────────────────────────────────────────────

test('the zero state hides the strip, so the hero owns the only connect CTA', () => {
  // The bug: with no projects and no surface, the empty hero rendered "Connect
  // a tool" → /onboarding and the strip rendered "Connect a tool" → /setup,
  // stacked, on the first screen a non-activated user ever sees.
  const state = readConnectionState([], NOW);
  assert.equal(state.absent, true);
  assert.equal(
    connectionPlacement(state, false),
    'hidden',
    'the strip must stand down whenever the empty hero is on screen — otherwise the page ' +
      'renders the same sentence twice, pointing at two different routes',
  );
});

test('the connect CTA has exactly one destination and it is the wizard', () => {
  // /setup is the tools MANAGEMENT table ("3 of 9 tools connected"); a reader in
  // the zero state has connected nothing, so it is nine rows they cannot tell
  // apart. /onboarding is the guided first connection, and is where every other
  // first-run surface in the app already points.
  assert.equal(CONNECT_ROUTE, '/onboarding');
});

test('no projects but a live surface still shows the strip', () => {
  // "Your tool is live" is information the hero does not carry, and it is the
  // answer to the question that brought the reader back after an install. Only
  // the DUPLICATE was the problem, so the fix must not blank the strip whenever
  // the project list happens to be empty.
  const state = readConnectionState([surface('claude_code', daysAgo(0))], NOW);
  assert.equal(state.absent, false);
  assert.equal(connectionPlacement(state, false), 'footer');
});

// ── Actionable first ─────────────────────────────────────────────────────────

test('an all-live strip stays a footer', () => {
  const state = readConnectionState(
    [surface('claude_code', daysAgo(0)), surface('cursor', daysAgo(2))],
    NOW,
  );
  assert.equal(state.actionable, false);
  assert.equal(state.liveCount, 2);
  assert.equal(connectionPlacement(state, true), 'footer');
});

test('one stale surface hoists the strip above the resume card', () => {
  const state = readConnectionState(
    [surface('claude_code', daysAgo(0)), surface('cursor', daysAgo(SURFACE_STALE_DAYS + 1))],
    NOW,
  );
  assert.equal(state.staleCount, 1);
  assert.equal(state.liveCount, 1);
  assert.equal(
    connectionPlacement(state, true),
    'top',
    'a resume card is worth nothing if no tool is reading it — the broken surface goes first',
  );
});

test('projects with no surface at all is actionable, not hidden', () => {
  // Saved briefs that nothing reads. This is the state the strip exists for, so
  // it must survive the zero-state fix rather than be swept up by it.
  const state = readConnectionState([], NOW);
  assert.equal(connectionPlacement(state, true), 'top');
});

test('the stale boundary is the documented one, not off by a day', () => {
  const justInside = readConnectionState(
    [surface('cursor', daysAgo(SURFACE_STALE_DAYS - 0.01))],
    NOW,
  );
  const justOutside = readConnectionState(
    [surface('cursor', daysAgo(SURFACE_STALE_DAYS + 0.01))],
    NOW,
  );
  assert.equal(justInside.staleCount, 0);
  assert.equal(justOutside.staleCount, 1);
});

test('a surface that never called in is stale, not live', () => {
  // Reading a missing timestamp optimistically is how a broken install renders
  // as healthy, which is the one outcome this strip must never produce.
  const state = readConnectionState(
    [surface('cursor', null), surface('codex', 'not-a-date')],
    NOW,
  );
  assert.equal(state.staleCount, 2);
  assert.equal(state.liveCount, 0);
  assert.equal(state.actionable, true);
});

test('an absent surfaces field reads as absent rather than throwing', () => {
  // sync_health.mcp_surfaces is optional in the bootstrap payload.
  for (const input of [undefined, null]) {
    const state = readConnectionState(input, NOW);
    assert.equal(state.absent, true);
    assert.equal(state.surfaces.length, 0);
  }
});

// ── "Never connected" vs "connected, then quiet" ─────────────────────────────

const NEVER_COPY = 'No surface has called in. Your briefs are saved, but nothing is reading them.';

test('an empty surface list on an established account is not "nothing is reading them"', () => {
  // The bug. `mcp_surfaces` is a 30-day window server-side, so an account that
  // has been quiet for 31 days arrives with an EMPTY array — structurally
  // identical to one that has never connected anything. It was shown "No
  // surface has called in. Your briefs are saved, but nothing is reading them",
  // which is false for them, in the most prominent slot on the page.
  const history: ConnectionHistory = {
    has_first_sync: true,
    first_synced_at: daysAgo(200),
    session_stats: { total_sessions: 162, first_session_at: daysAgo(200) },
  };
  const state = readConnectionState([], NOW, history);

  assert.equal(state.absent, true, 'the list really is empty — that part was never wrong');
  assert.equal(state.absentReason, 'dormant');
  assert.notEqual(
    absentCallout(state.absentReason!).message,
    NEVER_COPY,
    'a user with 162 briefed sessions is still being told nothing has ever read their briefs',
  );
});

test('a genuinely new account still gets the never-connected copy and the wizard', () => {
  // The other half: this branch must keep working for the people it was written
  // for. No history at all, and history that exists but proves nothing.
  for (const history of [
    undefined,
    null,
    {},
    { has_first_sync: false, first_synced_at: null, session_stats: { total_sessions: 0, first_session_at: null } },
  ] as (ConnectionHistory | null | undefined)[]) {
    const state = readConnectionState([], NOW, history);
    assert.equal(state.absentReason, 'never');
    const callout = absentCallout(state.absentReason!);
    assert.equal(callout.message, NEVER_COPY);
    assert.equal(callout.ctaRoute, CONNECT_ROUTE, 'a first connection is still the wizard');
    assert.equal(callout.ctaLabel, CONNECT_CTA_LABEL);
  }
});

test('the dormant callout sends the reader to the tools table, not back through the wizard', () => {
  // /onboarding is the guided FIRST connection and assumes the reader has never
  // done this. Someone whose surfaces went quiet has already done it, possibly
  // on several tools, and the question is which one stopped — that is /setup.
  const callout = absentCallout('dormant');
  assert.equal(callout.ctaRoute, RECONNECT_ROUTE);
  assert.equal(callout.ctaLabel, RECONNECT_CTA_LABEL);
  assert.notEqual(callout.ctaRoute, CONNECT_ROUTE);
});

test('the dormant copy quotes the window it is actually claiming', () => {
  // "No tool has called in" is only true of a bounded period, and the bound is
  // the server's query window. If the sentence stops naming it, it becomes the
  // absolute claim that was wrong in the first place.
  assert.match(absentCallout('dormant').message, new RegExp(`\\b${SURFACE_WINDOW_DAYS}\\b`));
});

test('the dormant copy invents no date, because the payload carries none', () => {
  // first_synced_at and session_stats.first_session_at are FIRST-time stamps and
  // last_synced is the last project write (which the dashboard itself performs).
  // There is no honest "last read" date to render, so none is rendered.
  const message = absentCallout('dormant').message;
  for (const month of ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December']) {
    assert.ok(!message.includes(month), `the dormant copy names a month (${month}) it cannot know`);
  }
  assert.ok(!/\bago\b/.test(message), 'the dormant copy claims an elapsed time it cannot measure');
});

test('either durable signal is enough, and neither can be produced by the dashboard', () => {
  // has_first_sync is the once-per-user first_sync_completed row; total_sessions
  // counts context_session_loads, written only on a real session start
  // (mark_session=1) — i.e. by a tool calling in, never by browsing the app.
  assert.equal(everConnected({ has_first_sync: true }), true);
  assert.equal(everConnected({ session_stats: { total_sessions: 1, first_session_at: null } }), true);
  assert.equal(everConnected({ first_synced_at: daysAgo(90) }), true);

  assert.equal(everConnected(undefined), false);
  assert.equal(everConnected({}), false);
  assert.equal(everConnected({ has_first_sync: false }), false);
  assert.equal(everConnected({ first_synced_at: 'not-a-date' }), false, 'an unparseable stamp is not proof');
  assert.equal(everConnected({ session_stats: { total_sessions: 0, first_session_at: null } }), false);
});

test('history never promotes a non-empty list into an absent one', () => {
  // absentReason exists only to explain an empty list. A live surface plus a
  // long history is an ordinary healthy account.
  const state = readConnectionState([surface('claude_code', daysAgo(0))], NOW, { has_first_sync: true });
  assert.equal(state.absent, false);
  assert.equal(state.absentReason, null);
  assert.equal(state.actionable, false);
});

test('the dormant state stays actionable and stays hoisted', () => {
  // It is the far end of the same ladder as a stale surface, not a milder
  // thing: nothing has read this account's briefs in a month. Demoting it to a
  // footer would undo the actionable-first rule for the worst case it covers.
  const state = readConnectionState([], NOW, { has_first_sync: true });
  assert.equal(state.actionable, true);
  assert.equal(connectionPlacement(state, true), 'top');
});

test('the staleness ladder ends inside the window it is read from', () => {
  // If the amber threshold ever passed the server's window, no surface could
  // ever be shown stale — it would vanish from the list first, and the amber
  // branch would be dead code that still reads as coverage.
  assert.ok(
    SURFACE_STALE_DAYS < SURFACE_WINDOW_DAYS,
    'a surface would leave the payload before it could be flagged stale',
  );
});

test('SURFACE_WINDOW_DAYS still matches the window the API selects in', () => {
  // The number is MIRRORED from apps/api, not derived: the bootstrap sends the
  // surfaces but not the interval they were selected in, and the dormant copy
  // quotes it out loud. Drift here is silent — the sentence keeps rendering, it
  // just stops being true. Same defect class as the connectCopy mirror.
  //
  // Skipped rather than failed when apps/api is not on disk, so a standalone
  // dashboard checkout does not fail on something it cannot see.
  const route = path.resolve(
    __dirname, '..', '..', '..', '..', 'apps/api/src/routes/shared/dashboard.js',
  );
  if (!fs.existsSync(route)) return;

  const source = fs.readFileSync(route, 'utf8');
  // The per-surface aggregate, isolated from the other windowed queries in the
  // same Promise.all (the MCP-runtime probe uses 30 days too, but is a
  // different claim and could legitimately move on its own).
  const start = source.indexOf('AS start_sessions');
  assert.ok(start > -1, 'the mcp_surfaces query moved — this guard is now blind');
  const query = source.slice(start, source.indexOf('GROUP BY', start));
  const interval = query.match(/INTERVAL\s+'(\d+)\s+days'/);
  assert.ok(interval, 'the mcp_surfaces query no longer names a day interval');
  assert.equal(
    Number(interval![1]),
    SURFACE_WINDOW_DAYS,
    `the API selects surfaces over ${interval![1]} days but Today's copy says ${SURFACE_WINDOW_DAYS}`,
  );
});

// ── The proof line ───────────────────────────────────────────────────────────

test('the proof line states the count and the month it started', () => {
  assert.equal(
    proofLine({ total_sessions: 162, first_session_at: '2026-07-04T09:12:00.000Z' }),
    '162 sessions briefed · since July 2026',
  );
});

test('one session is not "1 sessions"', () => {
  assert.equal(
    proofLine({ total_sessions: 1, first_session_at: '2026-08-29T09:12:00.000Z' }),
    '1 session briefed · since August 2026',
  );
});

test('the proof line renders nothing rather than a fabricated number', () => {
  // A memory product that shows a made-up metric is worse than one that shows
  // none. Zero sessions is not proof of anything, and there is no honest
  // substitute for a first-session date the server did not send.
  assert.equal(proofLine({ total_sessions: 0, first_session_at: null }), null);
  assert.equal(proofLine(undefined), null);
  assert.equal(proofLine(null), null);
  assert.equal(proofLine({}), null);
});

test('a count with no start date drops the date, not the count', () => {
  assert.equal(proofLine({ total_sessions: 9, first_session_at: null }), '9 sessions briefed');
  assert.equal(proofLine({ total_sessions: 9, first_session_at: 'nonsense' }), '9 sessions briefed');
});

test('the proof line is the same string on the server and in the browser', () => {
  // It renders during SSR and again on hydration. toLocaleDateString would give
  // two different answers across a locale or time-zone boundary, and a mismatch
  // here is a hydration error on the first thing a returning user sees. A
  // December 31st UTC timestamp is the case that catches a local-time getter.
  const line = proofLine({ total_sessions: 5, first_session_at: '2025-12-31T23:30:00.000Z' });
  assert.equal(line, '5 sessions briefed · since December 2025');
});
