/**
 * E-020. When does a `focus` on the connect step mean "the user came back from
 * configuring their tool"?
 *
 * E-012 shipped this test as one inequality — the absence lasted at least two
 * seconds — and adjudicating it on 2026-09-04 showed that inequality is not the
 * question. Three of its four events fired 2-6s after `onboarding_page_viewed`,
 * before the person had copied anything: a blur/focus pair thrown by the page
 * settling after the client-side navigation into /onboarding, which clears a
 * two-second bar whenever the gap happens to exceed two seconds. Exactly one of
 * the four was a real return from another application.
 *
 * An absence therefore has to satisfy two independent things, and the original
 * guard only knew about the first:
 *
 *   1. It lasted long enough to be an absence rather than a flicker.
 *   2. It STARTED late enough that the step had a chance to be read — a
 *      departure inside the first few seconds of mounting is the browser
 *      settling, not somebody leaving to paste a URL into Claude.
 *
 * The window on (2) is set from what this step has actually produced: the
 * fastest real copy observed on it is 24s after mount, and the fastest
 * copy -> consent -> approve traversal ever recorded here is 28s end to end. Ten
 * seconds sits well below both. Where the window is wrong it drops a real
 * return, which is the safe direction for a number the activation diagnosis
 * divides by — an overcount invents a returning population that does not exist.
 */

/** Shorter than this and the absence is a flicker, not a departure. */
export const MIN_AWAY_MS = 2_000;

/**
 * An absence beginning inside this much of the step mounting is load-time focus
 * churn. Deliberately generous: see the note above on the 24s / 28s floors.
 */
export const RETURN_GRACE_MS = 10_000;

export interface ReturnCandidate {
  /** How long the user was away, or null if no departure was ever recorded. */
  awayMs: number | null;
  /**
   * How far into the step the absence began, or null when either the departure
   * or the mount time is unknown. Unknown is NOT treated as "fine" — an absence
   * we cannot place in the step's timeline is exactly the ambiguous case E-020
   * exists to stop counting.
   */
  departedAfterMs: number | null;
}

/** An absence that passed both tests, with both timings known to be present. */
export interface RealReturn {
  awayMs: number;
  departedAfterMs: number;
}

/**
 * True only for an absence that is both long enough and late enough.
 *
 * Written as a type predicate so the caller can read the two timings off the
 * narrowed candidate rather than re-asserting they are non-null — the emitter
 * needs both values for the event payload, and a `!` there would be the same
 * "trust me" this whole record exists to remove.
 */
export function isRealReturn(candidate: ReturnCandidate): candidate is RealReturn {
  const { awayMs, departedAfterMs } = candidate;
  if (awayMs === null || awayMs < MIN_AWAY_MS) return false;
  if (departedAfterMs === null || departedAfterMs < RETURN_GRACE_MS) return false;
  return true;
}
