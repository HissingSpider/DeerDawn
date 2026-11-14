/**
 * When the dashboard may say "It's working", and when the first-sync
 * conversions may fire.
 *
 * Both used to key on `sync_health.has_projects`, and the dashboard creates
 * projects itself: onboarding's "name your project" step is one POST. So a
 * person who skipped connecting a tool, typed a project name and pressed
 * "Continue free" landed on Today under two contradicting sentences — the strip
 * saying, truly, "No surface has called in. Your briefs are saved, but nothing
 * is reading them.", and PostSyncModal on top of it saying "It's working — Your
 * first context is live." The same observation pushed the Google Ads First Sync
 * conversion (value 5) and the GA4 `first_sync_completed` event, so the number
 * the ads are bid against counted a text box, not a tool.
 *
 * The first fix borrowed Today's `everConnected` and was wrong in a new way.
 * That rule falls back to `session_stats.total_sessions`, which dashboard.js
 * counts over the whole WORKSPACE (`context_session_loads WHERE owner_key`),
 * while the first-sync fields are scoped to the person. A Team owner used a
 * tool, invited a colleague, and the colleague — who had connected nothing —
 * got the celebration and both conversions on their first visit, for the
 * owner's session.
 *
 * So this module reads ONLY fields dashboard.js scopes to the person asking:
 *
 *   has_first_sync, first_synced_at   one query (firstSyncRes) over this
 *                                     person's first_sync_completed event —
 *                                     the once-per-user row the API writes on
 *                                     the first context delivery into any tool.
 *                                     The evidence.
 *   has_projects                      this person's projects. Read only for the
 *                                     upgrade ask's unchanged trigger, never as
 *                                     evidence of a sync.
 *
 * and nothing workspace-wide: not `session_stats` (a lifetime count of the
 * workspace's session loads) and not `mcp_surfaces` (the workspace's 30-day MCP
 * traffic, with no person clause). Both are true statements about the team and
 * false ones about the reader.
 *
 * Today still reads those two (todayConnection.everConnected), so on a busy
 * team Today can say a tool is reading while this person's own tool has never
 * delivered. The modal staying silent there is correct; what it must never do
 * is celebrate while Today says nothing is reading, and it cannot: a first sync
 * of this person's is also one of Today's signals.
 *
 * This lives here, rather than as JSX in the component, because nothing in
 * `tests/` can see a render tree — a rule inside a component can only be
 * grepped for, and a grep passes just as happily when the logic is wrong.
 */

/**
 * The fields of `sync_health` this module is allowed to read. All of them are
 * scoped to the person by dashboard.js once the workspace has more than one
 * member (and on a solo workspace the workspace is the person). Do not widen
 * this with a workspace-wide field — see above for what that did.
 */
export type FirstSyncHealth = {
  has_first_sync?: boolean | null;
  first_synced_at?: string | null;
  has_projects?: boolean | null;
  /** Distinct days this person used DeerDawn from a tool. Gates the ask only. */
  active_days?: number | null;
};

/**
 * NO ASK BEFORE VALUE (activation plan 2026-10, Thing 3h).
 *
 * Lives here, beside the post-sync rule it gates, because this module imports
 * nothing: the rule is testable without the analytics plumbing.
 *
 * The post-first-sync upgrade modal and the third-brief offer asked for money
 * right after the first sync and after the third brief — which can all happen
 * inside one afternoon, before anyone knows whether the brief is worth coming
 * back for. Both now wait until this person has used DeerDawn from an AI tool
 * on ACTIVE_DAYS_BEFORE_ASK distinct days.
 *
 * `sync_health.active_days` is per PERSON (dashboard.js), counted from the
 * usage-day rows every tool call writes, reads included. A payload without it
 * (an API from before the field existed) answers false: on deploy skew an ask
 * that comes a little late costs nothing, one that comes before value is what
 * this rule exists to stop.
 */
export const ACTIVE_DAYS_BEFORE_ASK = 3;

export function activeEnoughToAsk(health: Pick<FirstSyncHealth, 'active_days'> | null | undefined): boolean {
  const days = Number(health?.active_days);
  return Number.isFinite(days) && days >= ACTIVE_DAYS_BEFORE_ASK;
}

/**
 * Has THIS PERSON's tool loaded a brief?
 *
 * `has_first_sync` when the payload carries it. `first_synced_at` is the same
 * query's other face (both are `firstSyncRes` in dashboard.js), read only when
 * the boolean is absent, and only when it is a real date.
 *
 * A payload with neither — an API from before 2026-08-12, when both were added
 * together — answers false. That fails closed on deploy skew: a celebration
 * missed while the API catches up is recoverable, a false one and a false ad
 * conversion are not.
 */
export function briefReachedATool(health: FirstSyncHealth | null | undefined): boolean {
  if (!health) return false;
  if (typeof health.has_first_sync === 'boolean') return health.has_first_sync;
  return typeof health.first_synced_at === 'string' && Number.isFinite(Date.parse(health.first_synced_at));
}

/**
 * Should the first-sync GA4 event and Google Ads conversion fire now? Once per
 * browser: `fired` is the component's own once-ever localStorage key.
 */
export function firstSyncConversionDue(health: FirstSyncHealth | null | undefined, fired: boolean): boolean {
  return !fired && briefReachedATool(health);
}

/**
 * `wait` — nothing to decide yet; ask again when the bootstrap changes.
 * `celebrate` — the first delivery this browser has seen.
 * `offer` — celebrated on an earlier beat, so the upgrade ask may run.
 * `none` — celebrated and already asked; nothing more to show.
 */
export type PostSyncStep = 'wait' | 'celebrate' | 'offer' | 'none';

/**
 * What PostSyncModal should do on this observation, given what this browser
 * has already been shown (its two localStorage keys).
 *
 * `wait` is distinct from `none` because the component decides once per mount:
 * a `wait` must leave that decision open, so a delivery that lands while the
 * dashboard is open still gets its celebration when the bootstrap refreshes.
 */
export function postSyncStep(
  health: FirstSyncHealth | null | undefined,
  stored: { celebrated: boolean; offered: boolean },
): PostSyncStep {
  if (!stored.celebrated) return briefReachedATool(health) ? 'celebrate' : 'wait';
  // The ask keeps the trigger it always had. It was not the defect, and it
  // already requires a celebration on an earlier beat — which now requires this
  // person's own delivery.
  if (!health?.has_projects) return 'wait';
  if (stored.offered) return 'none';
  // No ask before value (Thing 3h): the ask waits for a third active day. A
  // `wait`, not `none`, so it is still offered on a later visit once it has
  // been earned — the once-ever key is not written until then.
  if (!activeEnoughToAsk(health)) return 'wait';
  return 'offer';
}
