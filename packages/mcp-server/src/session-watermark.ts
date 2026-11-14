/**
 * session-watermark — has the project moved under this agent since it was briefed?
 *
 * A brief is a snapshot. In a project with one agent it stays true for hours; in
 * a contended one it can be wrong within minutes, and nothing told the agent.
 *
 * The rule that keeps this cheap: NEVER fetch to check. Every comparison here
 * runs against a watermark that arrived in a response the caller already made for
 * another reason — the project `updated_at` on a board read, the `brief_watermark`
 * on a session start. If checking staleness ever needs its own round-trip, the
 * banner belongs on a different call, not on a new request.
 *
 * State is per-process and deliberately not persisted: a watermark surviving a
 * restart would suppress the banner for a brief this process never received.
 */

const briefedAt = new Map<string, string>();

/** Record the watermark a brief was cut at. Called on session start. */
export function recordBriefWatermark(projectId: string | null | undefined, watermark: string | null | undefined): void {
  if (!projectId || !watermark) return;
  briefedAt.set(String(projectId), String(watermark));
}

function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Compare a watermark we just received for free against the one we were briefed
 * with. Returns null when the brief is still current, when we never recorded one
 * (nothing to compare against — silence beats a banner we cannot justify), or
 * when either value is unparseable.
 *
 * Advances the stored watermark on report, so one change is announced once rather
 * than on every subsequent call for the rest of the session.
 */
export function checkStale(
  projectId: string | null | undefined,
  currentWatermark: string | null | undefined,
): { staleMs: number } | null {
  if (!projectId || !currentWatermark) return null;
  const key = String(projectId);
  const briefed = briefedAt.get(key);
  if (!briefed) return null;
  const before = toMs(briefed);
  const now = toMs(currentWatermark);
  if (before === null || now === null) return null;
  if (now <= before) return null;
  briefedAt.set(key, String(currentWatermark));
  return { staleMs: now - before };
}

/** Test seam — the map is process-global, so suites must be able to reset it. */
export function resetWatermarks(): void {
  briefedAt.clear();
}
