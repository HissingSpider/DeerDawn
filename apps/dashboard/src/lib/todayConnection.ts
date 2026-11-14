/**
 * Today's proof line, and where the connection strip belongs on the page.
 *
 * This lives in `lib` rather than inside `pages/index.tsx` for one reason: the
 * decisions below are the *behaviour* of the page, and nothing in `tests/` can
 * see a render tree. Every contract suite in this app reads source as TEXT, so a
 * rule expressed as JSX inside a component is a rule no test can exercise — it
 * can only be spot-checked by grepping for a string, which passes just as
 * happily when the logic behind the string is wrong. Pulled out here, the rules
 * are ordinary functions with a real unit test (`todayConnection.test.ts`).
 *
 * Three rules, and each one exists because the page got it wrong:
 *
 *  1. ONE CTA, ONE ROUTE. The zero state rendered "Connect a tool" twice —
 *     once from the empty hero (to `/onboarding`) and again, same words, from
 *     the connection strip's empty branch (to `/setup`) — stacked, on the first
 *     screen a non-activated user ever sees. `CONNECT_ROUTE` is now the single
 *     destination, and `connectionPlacement` hides the strip entirely whenever
 *     the hero is on screen, because the hero already says the same sentence.
 *
 *  2. ACTIONABLE FIRST. The strip is a quiet footer when every surface is live
 *     and the single most important thing on the page when one has gone quiet or
 *     none exists. Position follows that, rather than being fixed.
 *
 *  3. NEVER INVENT THE PROOF. `proofLine` returns null rather than guessing.
 *     A memory product that renders a made-up number is worse than one that
 *     renders none.
 *
 *  4. AN EMPTY LIST IS NOT A NEW ACCOUNT. `mcp_surfaces` is a 30-day window, so
 *     it empties out for anyone who has been away for a month — and the strip
 *     told them "nothing is reading your briefs", in the most prominent slot on
 *     the page. `absentReason` separates the two, on evidence that outlives the
 *     window and is already in the payload.
 */

/**
 * The one route Today's "Connect a tool" CTA points at.
 *
 * `/onboarding` and not `/setup`: `/onboarding` is the guided first-connection
 * wizard (pick a tool, copy one command, it polls until the connection lands,
 * then seeds a first brief), and it is what every other first-run surface in the
 * app already links to — SampleBriefEmptyState, projects.tsx's FirstValueBanner,
 * board.tsx, ContextNetwork. `/setup` is the tools MANAGEMENT table ("3 of 9
 * tools connected"), which is why the app links there to add a SECOND tool
 * (SecondToolNudge) or from settings. Someone in Today's zero state has never
 * connected anything, so the table is a list of nine things they cannot yet tell
 * apart; the wizard is the page built for them.
 */
export const CONNECT_ROUTE = '/onboarding';

/** The CTA's words. Exported so nothing can drift a second copy out of sync. */
export const CONNECT_CTA_LABEL = 'Connect a tool';

/**
 * How long a previously-active surface may stay silent before it reads as
 * drifted. Seven days, and the reasoning matters more than the number: anything
 * shorter turns a normal weekend — or a week not spent on this project — into an
 * alarm, and once amber is routine nobody reads it. Anything longer and a
 * genuinely broken install sits unreported for a fortnight.
 */
export const SURFACE_STALE_DAYS = 7;

const STALE_MS = SURFACE_STALE_DAYS * 24 * 60 * 60 * 1000;

/**
 * How far back `sync_health.mcp_surfaces` can see, in days.
 *
 * This is the fact the "absent" copy got wrong. The list is not every surface
 * that has ever called in — it is a WINDOWED aggregate, `created_at > NOW() -
 * INTERVAL '30 days'` on the per-surface query in
 * `apps/api/src/routes/shared/dashboard.js`. So an established account that has
 * simply been quiet for a month arrives here with an EMPTY array, structurally
 * identical to an account that has never connected anything, and was told "No
 * surface has called in. Your briefs are saved, but nothing is reading them."
 * — a sentence that is false for them, hoisted to the top of the page.
 *
 * MIRRORED, not derived: the payload carries the surfaces but not the window
 * they were selected in, so this number is a copy of the server's and the copy
 * below quotes it. `todayConnection.test.ts` reads that route file and fails if
 * the two drift, because the failure mode is silent — the sentence keeps
 * rendering, it just stops being true.
 */
export const SURFACE_WINDOW_DAYS = 30;

/**
 * Where a reader whose tools have gone quiet is sent, and what the link says.
 *
 * Deliberately NOT `CONNECT_ROUTE`. The reasoning behind that constant runs the
 * other way here: `/onboarding` is the guided FIRST connection, and its whole
 * shape ("pick a tool, copy one command, we'll poll until it lands") assumes
 * the reader has never done this. Someone whose surfaces have gone quiet has
 * already done it — possibly on several tools — and the question in front of
 * them is which one stopped. That is the tools table at `/setup`, the same
 * place `SecondToolNudge` and settings send people who are managing an install
 * rather than starting one.
 *
 * These two callouts are mutually exclusive branches of one `if`, so this is
 * not the duplicate-CTA defect returning: the page still renders exactly one
 * connect CTA, it just no longer sends a month-idle user through a wizard built
 * for someone with nothing set up.
 */
export const RECONNECT_ROUTE = '/setup';
export const RECONNECT_CTA_LABEL = 'Check your tools';

/** The fields of `sync_health.mcp_surfaces` this module actually reads. */
export type McpSurface = {
  surface: string;
  last_called_at: string | null;
};

export type EvaluatedSurface = McpSurface & { stale: boolean };

/**
 * Why the surface list is empty.
 *
 * `never` — nothing has ever called in.
 * `dormant` — something did, longer ago than the server's window can see.
 */
export type AbsentReason = 'never' | 'dormant';

/**
 * The durable, UNWINDOWED half of `sync_health` — the evidence that separates
 * the two.
 *
 * Both fields outlive the 30-day window and neither can be produced by using
 * the dashboard: `has_first_sync` is backed by the once-per-user
 * `first_sync_completed` row the API writes on the first context delivery into
 * any tool, and `session_stats.total_sessions` counts `context_session_loads`,
 * which are only written on a real session start (`mark_session=1`), i.e. by a
 * tool calling in. Either one is proof that this account has connected before.
 */
export type ConnectionHistory = {
  has_first_sync?: boolean | null;
  first_synced_at?: string | null;
  session_stats?: SessionStats | null;
};

export type ConnectionState = {
  surfaces: EvaluatedSurface[];
  liveCount: number;
  staleCount: number;
  /** Nothing is in the window. See `absentReason` for whether that is new. */
  absent: boolean;
  /** Why the list is empty, or null when it is not. */
  absentReason: AbsentReason | null;
  /** Something needs a person: a surface went quiet, or there is no surface. */
  actionable: boolean;
};

/**
 * Has any tool ever called in, on the evidence the bootstrap already carries?
 *
 * Returns false when there is no history to read. That is the conservative
 * answer in both directions: with no evidence the page keeps saying exactly
 * what it says today, and a caller that forgets to pass history cannot
 * accidentally promote a brand-new account to "you connected once".
 */
export function everConnected(history?: ConnectionHistory | null): boolean {
  if (!history) return false;
  if (history.has_first_sync) return true;
  if (history.first_synced_at && Number.isFinite(Date.parse(history.first_synced_at))) return true;
  const sessions = Number(history.session_stats?.total_sessions ?? 0);
  return Number.isFinite(sessions) && sessions > 0;
}

/**
 * Classify the surfaces as of `now`.
 *
 * `now` is passed in rather than read here: reading the clock during render is
 * impure, and the server and the browser would disagree on it, which is a
 * hydration mismatch on the first thing a returning user sees.
 */
export function readConnectionState(
  surfaces: readonly McpSurface[] | null | undefined,
  now: number,
  history?: ConnectionHistory | null,
): ConnectionState {
  const cutoff = now - STALE_MS;
  const evaluated: EvaluatedSurface[] = (surfaces ?? []).map((surface) => {
    const called = surface.last_called_at ? Date.parse(surface.last_called_at) : NaN;
    // An unparseable or missing timestamp is stale, not live. Guessing the
    // optimistic way here is how a broken install reads as healthy.
    return { ...surface, stale: !Number.isFinite(called) || called < cutoff };
  });

  const staleCount = evaluated.filter((surface) => surface.stale).length;
  const absent = evaluated.length === 0;

  return {
    surfaces: evaluated,
    liveCount: evaluated.length - staleCount,
    staleCount,
    absent,
    // The staleness ladder does not stop at SURFACE_STALE_DAYS, it falls off a
    // cliff at SURFACE_WINDOW_DAYS: a surface quiet for 8 days is listed and
    // flagged amber, and the same surface quiet for 31 days is not listed at
    // all. `dormant` is the far side of that cliff, and it is a state the strip
    // used to render as "never".
    absentReason: absent ? (everConnected(history) ? 'dormant' : 'never') : null,
    actionable: absent || staleCount > 0,
  };
}

/** What the strip says when the surface list is empty, and where it points. */
export type AbsentCallout = {
  message: string;
  ctaLabel: string;
  ctaRoute: string;
};

/**
 * The copy for an empty surface list, chosen by WHY it is empty.
 *
 * Both branches live here rather than in the page for the reason the whole
 * module exists: `tests/` reads source as text, so a rule expressed as JSX is a
 * rule that can only be spot-checked by grepping for a string — and a grep for
 * "No surface has called in" passes just as happily when it is shown to the
 * wrong person, which is exactly the defect this function fixes.
 */
export function absentCallout(reason: AbsentReason): AbsentCallout {
  if (reason === 'dormant') {
    return {
      // States the window, because the window is the entire claim. Note what it
      // does NOT say: when a surface last called in. `first_synced_at` and
      // `session_stats.first_session_at` are both FIRST-time stamps and
      // `last_synced` is the last project WRITE (which the dashboard itself
      // performs), so there is no honest "last read" date in the payload. Rule
      // 3 applies to dates as much as to counts: say the true, dull thing.
      message: `No tool has called in for ${SURFACE_WINDOW_DAYS} days. Your briefs are all still here.`,
      ctaLabel: RECONNECT_CTA_LABEL,
      ctaRoute: RECONNECT_ROUTE,
    };
  }
  return {
    message: 'No surface has called in. Your briefs are saved, but nothing is reading them.',
    ctaLabel: CONNECT_CTA_LABEL,
    ctaRoute: CONNECT_ROUTE,
  };
}

/** `hidden` — the empty hero owns the message. `top` — above the resume card. */
export type ConnectionPlacement = 'hidden' | 'top' | 'footer';

/**
 * Where the strip goes.
 *
 * The `hidden` case is the duplicate-CTA fix: with no projects AND no surface,
 * the empty hero is already on screen saying "nothing to pick up yet, connect a
 * tool". The strip's empty branch says the same thing in different words with a
 * second button — so it says nothing new and costs the page its single clear
 * next step. Note that this is scoped to `absent`: a user with no projects but a
 * surface that IS calling in still gets the strip, because "your tool is live"
 * is information the hero does not carry.
 */
export function connectionPlacement(
  state: Pick<ConnectionState, 'absent' | 'actionable'>,
  hasProjects: boolean,
): ConnectionPlacement {
  if (state.absent && !hasProjects) return 'hidden';
  return state.actionable ? 'top' : 'footer';
}

export type SessionStats = {
  total_sessions?: number | null;
  first_session_at?: string | null;
};

// Spelled out rather than formatted with toLocaleDateString: the page renders on
// the server and again in the browser, and the two disagree about locale and
// time zone. A fixed table read with UTC getters produces the same string in
// both, which is the difference between a proof line and a hydration error.
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * The one honest line of proof: how many sessions DeerDawn has briefed, and
 * since when. Both numbers come from `sync_health.session_stats`, which the
 * dashboard bootstrap already returns and which nothing rendered until now.
 *
 * Deliberately "N sessions briefed" rather than "Session N". The count is
 * `COUNT(*)` over sessions already loaded, so "Session N" quietly claims the one
 * being read right now is the Nth, which is off by one the moment the current
 * session was itself counted. The plural form is true either way.
 *
 * Returns null — render nothing — when there is no count to state. A zero here
 * is not proof of anything, and inventing a first-session date from `created_at`
 * or the earliest project would be making the number up.
 */
export function proofLine(stats: SessionStats | null | undefined): string | null {
  const total = Number(stats?.total_sessions ?? 0);
  if (!Number.isFinite(total) || total < 1) return null;

  const count = `${Math.floor(total)} session${total === 1 ? '' : 's'} briefed`;

  const started = stats?.first_session_at ? Date.parse(stats.first_session_at) : NaN;
  if (!Number.isFinite(started)) return count;

  const first = new Date(started);
  return `${count} · since ${MONTHS[first.getUTCMonth()]} ${first.getUTCFullYear()}`;
}
