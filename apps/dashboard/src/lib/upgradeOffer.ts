/**
 * Upgrade asks: one event trio, one per-session cap.
 *
 * Every place the product asks a free user for money routes through here, so
 * two things stay true that were not true before:
 *
 *  1. One canonical name per step, sent to BOTH sinks with a `surface` that
 *     names the ask. The surfaces are separate rows in one funnel, never
 *     separate funnels — see the fragmentation note in lib/analyticsEvents.ts.
 *  2. At most one unsolicited ask per browsing session, across all of them.
 *     Three new moments landed at once (third brief, history trim, project
 *     cap); without a shared cap a single visit could stack all three plus the
 *     post-sync modal, and ask fatigue would cost more trust than the asks earn.
 *
 * sessionStorage, not localStorage: the cap is per visit, so a user who comes
 * back tomorrow is askable again. (lib/lifecycleEmail.ts scopes its dedupe the
 * same way and for the same reason.) Every access is wrapped — storage throws
 * outright in some privacy modes — and falls back to module state, which still
 * holds the cap across client-side navigation inside the visit.
 */

import { PRODUCT_EVENTS } from '@/lib/analyticsEvents';
import { trackProductEvent } from '@/lib/productAnalytics';
import { gaEvent } from '@/lib/gtag';

export type UpgradeSurface =
  | 'upgrade_banner'
  | 'post_sync_modal'
  | 'third_brief'
  | 'history_trim'
  | 'project_cap';

/**
 * What occupied this session's single ask beat. `post_sync_celebrate` is not an
 * ask — it takes the beat so that no ask can share it, which is the standing
 * rule that a celebration and an ask never land together.
 */
type SessionBeat = UpgradeSurface | 'post_sync_celebrate';

const BEAT_KEY = 'dd_upgrade_ask_beat_v1';

// Survives client-side navigation when sessionStorage is unavailable, so a
// storage-blocked browser still gets one ask per visit rather than one per page.
let beatFallback: SessionBeat | null = null;

function readBeat(): SessionBeat | null {
  if (typeof window === 'undefined') return null;
  try {
    return (window.sessionStorage.getItem(BEAT_KEY) as SessionBeat | null) ?? beatFallback;
  } catch {
    return beatFallback;
  }
}

function writeBeat(beat: SessionBeat) {
  beatFallback = beat;
  try {
    window.sessionStorage.setItem(BEAT_KEY, beat);
  } catch {
    /* storage may be unavailable — beatFallback still holds the cap */
  }
}

/**
 * Take this session's ask beat for a proactive, uninvited ask. Returns false if
 * something already took it, in which case the caller must render nothing and
 * must not burn its own once-ever key — it asks on a later visit instead.
 */
export function claimSessionBeat(surface: UpgradeSurface): boolean {
  if (typeof window === 'undefined') return false;
  if (readBeat()) return false;
  writeBeat(surface);
  return true;
}

/**
 * Take the beat without being gated by it.
 *
 * For surfaces that must render regardless: the celebration (never an ask), and
 * the project-cap screen, which answers an action the user just took. Gating
 * that one would put back the dead end it exists to remove. It still spends the
 * beat, so nothing piles on afterwards in the same visit.
 *
 * The persistent free-tier banner deliberately does NOT call this: it is chrome
 * on its own 7-day cadence rather than a beat, and letting it spend the session
 * would make every other moment unreachable.
 */
export function spendSessionBeat(beat: SessionBeat): void {
  if (typeof window === 'undefined') return;
  if (readBeat()) return;
  writeBeat(beat);
}

/** Test seam — resets the in-memory half of the cap. */
export function resetSessionBeatForTests(): void {
  beatFallback = null;
}

type OfferMetadata = Record<string, string | number | boolean>;

function emit(eventName: string, surface: UpgradeSurface, metadata: OfferMetadata) {
  // `surface` goes in the payload's own field: it is a real column on
  // product_events and PostHog receives it as a top-level property, so both
  // `GROUP BY surface` and a PostHog breakdown work without reading metadata.
  void trackProductEvent(eventName, {
    source: 'dashboard',
    surface,
    path: typeof window !== 'undefined' ? window.location.pathname : undefined,
    metadata,
  });
  // Same name to GA4 so the ask funnel joins across tools.
  gaEvent(eventName, { surface, ...metadata });
}

export function trackUpgradeOfferShown(surface: UpgradeSurface, metadata: OfferMetadata = {}) {
  emit(PRODUCT_EVENTS.upgradeOfferShown, surface, metadata);
}

export function trackUpgradeOfferClicked(surface: UpgradeSurface, metadata: OfferMetadata = {}) {
  emit(PRODUCT_EVENTS.upgradeOfferClicked, surface, metadata);
}

export function trackUpgradeOfferDismissed(surface: UpgradeSurface, metadata: OfferMetadata = {}) {
  emit(PRODUCT_EVENTS.upgradeOfferDismissed, surface, metadata);
}

/**
 * How many context entries this project holds that the plan's memory window
 * drops from the brief the AI actually reads.
 *
 * Mirrors applyHistoryWindow in apps/api/src/services/contextSyncService.js
 * (~line 136) — same three timestamped lists, same "undated entries never age
 * out" rule. The dashboard reads /inject?format=json, which returns the RAW
 * stored context, so it can see exactly what the windowed brief left behind;
 * the two rules must be changed together.
 *
 * Returns 0 for paid tiers (days null/0), so the notice can only ever appear
 * when something was genuinely trimmed.
 */
const WINDOWED_LISTS: Array<[field: string, timestampField: string]> = [
  ['recent_decisions', 'decided_at'],
  ['debugging_notes', 'added_at'],
  ['shipped', 'shipped_at'],
];

export function countAgedOutEntries(
  context: Record<string, unknown> | null | undefined,
  historyDays: number | null | undefined,
  now: number = Date.now(),
): number {
  const windowDays = Number(historyDays);
  if (!context || !Number.isFinite(windowDays) || windowDays <= 0) return 0;

  const cutoff = now - windowDays * 24 * 60 * 60 * 1000;
  let agedOut = 0;
  for (const [field, timestampField] of WINDOWED_LISTS) {
    const list = context[field];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const ts = Date.parse((entry as Record<string, unknown>)[timestampField] as string);
      if (Number.isFinite(ts) && ts < cutoff) agedOut += 1;
    }
  }
  return agedOut;
}
