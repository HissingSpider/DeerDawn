/**
 * E-3 / B-3 tests.
 *
 * Two things here are worth guarding. The first is the aged-out count: it is a
 * client-side mirror of applyHistoryWindow in contextSyncService.js, and the
 * notice built on it makes a factual claim ("N entries are outside your
 * window"), so an off-by-one or a stray undated entry would put a false number
 * on screen. The second is that the ask surfaces actually route through this
 * module — a unit test of the cap alone would stay green if a surface stopped
 * calling it, which is exactly how "one ask per session" would quietly become
 * four.
 *
 * Run: `tsx --test src/lib/upgradeOffer.test.ts` (covered by `npm test`).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PRODUCT_EVENTS } from './analyticsEvents';
import { claimSessionBeat, countAgedOutEntries, resetSessionBeatForTests, spendSessionBeat } from './upgradeOffer';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-21T12:00:00.000Z');

function readSource(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
}

/** Minimal window stub — only what the cap touches. */
function installWindow(mode: 'ok' | 'throws' = 'ok') {
  const store = new Map<string, string>();
  (globalThis as unknown as { window?: unknown }).window = {
    sessionStorage: {
      getItem(key: string) {
        if (mode === 'throws') throw new Error('storage blocked');
        return store.has(key) ? store.get(key) : null;
      },
      setItem(key: string, value: string) {
        if (mode === 'throws') throw new Error('storage blocked');
        store.set(key, value);
      },
    },
  };
  resetSessionBeatForTests();
  return store;
}

function uninstallWindow() {
  delete (globalThis as unknown as { window?: unknown }).window;
  resetSessionBeatForTests();
}

// ── The per-session cap ──────────────────────────────────────────────────────

test('one proactive ask per session, whichever surface gets there first', () => {
  installWindow();
  try {
    assert.equal(claimSessionBeat('third_brief'), true);
    assert.equal(claimSessionBeat('history_trim'), false);
    assert.equal(claimSessionBeat('post_sync_modal'), false);
    // Still capped after a re-read from storage rather than the memory fallback.
    resetSessionBeatForTests();
    assert.equal(claimSessionBeat('history_trim'), false);
  } finally {
    uninstallWindow();
  }
});

test('the first-sync celebration takes the beat so no ask shares it', () => {
  installWindow();
  try {
    spendSessionBeat('post_sync_celebrate');
    assert.equal(claimSessionBeat('third_brief'), false);
    assert.equal(claimSessionBeat('history_trim'), false);
  } finally {
    uninstallWindow();
  }
});

test('the project-cap screen spends the beat without being gated by it', () => {
  installWindow();
  try {
    assert.equal(claimSessionBeat('third_brief'), true);
    // Never gated — it answers an action the user just took, so it renders
    // regardless; this call only has to not throw and not un-claim the beat.
    spendSessionBeat('project_cap');
    assert.equal(claimSessionBeat('history_trim'), false);
  } finally {
    uninstallWindow();
  }
});

test('a storage-blocked browser still gets one ask, not one per page', () => {
  installWindow('throws');
  try {
    assert.equal(claimSessionBeat('third_brief'), true);
    assert.equal(claimSessionBeat('history_trim'), false);
  } finally {
    uninstallWindow();
  }
});

test('never claims a beat during server rendering', () => {
  uninstallWindow();
  assert.equal(claimSessionBeat('third_brief'), false);
});

// ── The aged-out count behind the history-trim notice ────────────────────────

test('counts only entries the plan window actually drops from the brief', () => {
  const context = {
    recent_decisions: [
      { summary: 'old decision', decided_at: new Date(NOW - 9 * DAY).toISOString() },
      { summary: 'recent decision', decided_at: new Date(NOW - 2 * DAY).toISOString() },
      // Undated entries never age out server-side — windowing only removes what
      // it can prove is older than the plan's memory.
      { summary: 'undated decision' },
      'a bare string decision',
    ],
    debugging_notes: [{ summary: 'old note', added_at: new Date(NOW - 30 * DAY).toISOString() }],
    shipped: [{ text: 'old ship', shipped_at: new Date(NOW - 8 * DAY).toISOString() }],
    // Identity fields are never windowed, however old the project is.
    goals: ['ship the thing'],
    tech_stack: ['next'],
  };
  assert.equal(countAgedOutEntries(context, 7, NOW), 3);
});

test('exactly at the boundary still counts as inside the window', () => {
  const context = {
    recent_decisions: [{ summary: 'edge', decided_at: new Date(NOW - 7 * DAY).toISOString() }],
  };
  assert.equal(countAgedOutEntries(context, 7, NOW), 0);
  assert.equal(countAgedOutEntries(context, 6, NOW), 1);
});

test('no window, no claim — paid tiers and missing data count nothing', () => {
  const context = {
    recent_decisions: [{ summary: 'ancient', decided_at: new Date(NOW - 400 * DAY).toISOString() }],
  };
  for (const days of [null, undefined, 0, -1, Number.NaN]) {
    assert.equal(countAgedOutEntries(context, days as number | null, NOW), 0, `days=${String(days)}`);
  }
  assert.equal(countAgedOutEntries(null, 7, NOW), 0);
  assert.equal(countAgedOutEntries({ recent_decisions: 'not an array' }, 7, NOW), 0);
  assert.equal(countAgedOutEntries({ recent_decisions: [{ decided_at: 'not a date' }] }, 7, NOW), 0);
});

// ── Every ask surface reports, and reports under its own name ────────────────

test('the ask trio exists under one name each', () => {
  assert.equal(PRODUCT_EVENTS.upgradeOfferShown, 'upgrade_offer_shown');
  assert.equal(PRODUCT_EVENTS.upgradeOfferClicked, 'upgrade_offer_clicked');
  assert.equal(PRODUCT_EVENTS.upgradeOfferDismissed, 'upgrade_offer_dismissed');
});

test('every upgrade ask surface reports through this module', () => {
  const surfaces: Array<[file: string, surface: string]> = [
    ['components/dashboard/UpgradeBanner.tsx', 'upgrade_banner'],
    ['components/dashboard/PostSyncModal.tsx', 'post_sync_modal'],
    ['components/dashboard/ThirdBriefOffer.tsx', 'third_brief'],
    ['components/dashboard/brief/HistoryTrimNotice.tsx', 'history_trim'],
    ['components/dashboard/AddFromClaudeModal.tsx', 'project_cap'],
  ];
  for (const [file, surface] of surfaces) {
    const source = readSource(file);
    assert.match(source, new RegExp(`['"]${surface}['"]`), `${file} must name surface ${surface}`);
    assert.match(
      source,
      /trackUpgradeOffer(Shown|Clicked|Dismissed)|PersonalPlanGate/,
      `${file} must emit upgrade_offer_* (directly or via PersonalPlanGate)`,
    );
  }
  // PersonalPlanGate is where the project-cap surface's events are emitted.
  const gate = readSource('components/ui/PersonalPlanGate.tsx');
  assert.match(gate, /trackUpgradeOfferShown/);
  assert.match(gate, /trackUpgradeOfferClicked/);
});

test('the three new moments share the cap; the persistent banner does not spend it', () => {
  for (const file of [
    'components/dashboard/ThirdBriefOffer.tsx',
    'components/dashboard/brief/HistoryTrimNotice.tsx',
    'components/dashboard/PostSyncModal.tsx',
  ]) {
    assert.match(readSource(file), /claimSessionBeat\(/, `${file} must go through the session cap`);
  }
  const banner = readSource('components/dashboard/UpgradeBanner.tsx');
  assert.doesNotMatch(banner, /claimSessionBeat\(|spendSessionBeat\(/);
});

// ── E-021: no ask before the product has done anything ───────────────────────

/**
 * Comment-blind. The E-021 note inside UpgradeBanner.tsx explains the gate in
 * prose and names every identifier below, so a regex over the raw source would
 * stay green against a component that had dropped the gate and kept the comment.
 */
function readSourceStripped(relativePath: string) {
  return readSource(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('the persistent banner waits for first value, and treats unknown as not yet', () => {
  const banner = readSourceStripped('components/dashboard/UpgradeBanner.tsx');
  // The gate must consult first sync, and must do it with an explicit `=== true`
  // so that `undefined` (bootstrap still loading) falls through to hidden rather
  // than flashing a price at somebody mid-load.
  assert.match(banner, /hasFirstSync\s*===\s*true/, 'must require first sync explicitly');
  assert.match(
    banner,
    /const\s+visible\s*=[^;]*briefed/,
    'first value must be part of the visibility gate, not just computed',
  );
});

test('the shell passes the bootstrap first-sync signal into the banner', () => {
  // Measured 2026-09-04 over 60 days, test accounts excluded: 5 real people have
  // ever seen this banner, 4 within ten minutes of signing up, and none of those
  // 4 has ever produced a first sync, a connection or a start_session. If this
  // prop stops being wired the gate silently reverts to "every Free account".
  const shell = readSourceStripped('components/dashboard/AppShell.tsx');
  assert.match(shell, /<UpgradeBanner[\s\S]{0,200}?hasFirstSync=\{/, 'AppShell must pass hasFirstSync');
  assert.match(shell, /sync_health\?\.has_first_sync/, 'and take it from sync_health');
});
