/**
 * How much of a session's transcript has already been flushed.
 *
 * The flush hangs off Claude Code's Stop hook, and Stop fires at the end of
 * every TURN, not once per session. Without a mark, turn forty re-sends turns one
 * to thirty-nine: forty extractions of a growing transcript, each re-deriving
 * decisions the brief already holds. With one, each Stop sends what is new.
 *
 * One file per session rather than one shared map: several Claude Code sessions
 * stop at the same moment on a busy machine, and a read-modify-write of a shared
 * file would have one session's mark erase another's.
 *
 * Self-healing in the same way as flush-notice: an unreadable mark is no mark
 * (the whole transcript is sent again, which is the old behaviour, not a loss),
 * and a mark that cannot be written must never fail the flush.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const MAX_WATERMARK_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function watermarkDir(): string {
  // Resolved per call, not at module load — same reason as flush-notice.
  return path.join(os.homedir(), '.deerdawn', 'flush-watermarks');
}

function watermarkPath(sessionKey: string): string {
  // A session id is a uuid, but the key can also be a transcript path.
  const safe = sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-120);
  return path.join(watermarkDir(), `${safe}.json`);
}

/** Transcript lines already flushed for this session; 0 when nothing is known. */
export function readFlushWatermark(sessionKey: string): number {
  try {
    const raw = JSON.parse(fs.readFileSync(watermarkPath(sessionKey), 'utf8')) as { lines?: unknown };
    const lines = Number(raw?.lines);
    return Number.isInteger(lines) && lines > 0 ? lines : 0;
  } catch {
    return 0;
  }
}

export function recordFlushWatermark(sessionKey: string, lines: number): void {
  try {
    const dir = watermarkDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(watermarkPath(sessionKey), JSON.stringify({ lines, at: new Date().toISOString() }), 'utf8');
    pruneOldWatermarks(dir);
  } catch { /* a mark that cannot be written must not break the flush */ }
}

// A session that ended a month ago will not stop again. Swept on write so the
// directory cannot grow without bound on a machine that runs sessions all day.
function pruneOldWatermarks(dir: string): void {
  try {
    const cutoff = Date.now() - MAX_WATERMARK_AGE_MS;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
      } catch { /* skip */ }
    }
  } catch { /* non-fatal */ }
}
