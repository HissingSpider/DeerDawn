/**
 * A durable mark for an end-of-session flush that did not land.
 *
 * The Stop hook runs `deerdawn-mcp flush-session` as a detached CLI process.
 * There is no tool result to fail into and no human watching: its stderr goes
 * to a log nobody opens. So when a flush was refused — a 413 on a long
 * transcript, an outage, an expired key — the session's context was lost and
 * nothing anywhere said so. That is the silent-drop shape, on the one path whose
 * entire job is that nothing is lost at the end of a session.
 *
 * This writes the fact to disk instead, and start_session reads it into the NEXT
 * session's tool result — the first moment a human or an agent is present to see
 * it. Consumed on read, because a warning that repeats forever is noise, and
 * cleared by the next flush that succeeds.
 *
 * Deliberately tiny and self-healing: a corrupt or unreadable notice is treated
 * as no notice. This must never be a reason a session fails to start.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export type FlushNoticeKind = 'failed' | 'trimmed';

export interface FlushNotice {
  kind: FlushNoticeKind;
  at: string;
  /** HTTP status, when the API answered at all. */
  status?: number | null;
  /** Short reason — a transport error message, or the API's own message. */
  reason?: string | null;
  /** Messages sent / messages the transcript held, for a trimmed flush. */
  sent?: number;
  total?: number;
  project_dir?: string | null;
}

const MAX_NOTICE_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function noticePath(): string {
  // Resolved per call, not at module load: the CLI, the MCP server and the tests
  // are different processes with different HOMEs.
  return path.join(os.homedir(), '.deerdawn', 'last-flush.json');
}

export function recordFlushNotice(notice: FlushNotice): void {
  try {
    const file = noticePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(notice), 'utf8');
  } catch { /* a notice that cannot be written must not break the flush */ }
}

export function clearFlushNotice(): void {
  try {
    fs.rmSync(noticePath(), { force: true });
  } catch { /* non-fatal */ }
}

/** The stored notice rendered as one short line, or null when there is none. */
export function readFlushNotice(): string | null {
  let raw: FlushNotice;
  try {
    raw = JSON.parse(fs.readFileSync(noticePath(), 'utf8')) as FlushNotice;
  } catch {
    return null;
  }
  if (!raw || (raw.kind !== 'failed' && raw.kind !== 'trimmed')) return null;
  // "The previous session" stops being a true description eventually. A notice
  // nobody was present to read for two weeks is archaeology, not a warning, and
  // the brief it was qualifying has long since moved on.
  const age = Date.now() - Date.parse(String(raw.at));
  if (Number.isFinite(age) && age > MAX_NOTICE_AGE_MS) return null;
  const when = typeof raw.at === 'string' && raw.at ? ` (${raw.at})` : '';
  // The notice is per MACHINE, not per project — the flush that failed may have
  // been another directory's session, and a warning about the wrong project is
  // worse than none. So it always says which one it is about.
  const where = raw.project_dir ? ` in ${raw.project_dir}` : '';
  if (raw.kind === 'trimmed') {
    const counts = raw.total && raw.sent ? ` Only the last ${raw.sent} of ${raw.total} messages were sent` : '';
    return `⚠ The previous session${where} was TRUNCATED before its context was saved${when}.${counts}`
      + ' — the earliest part of that session is not in the brief. Anything important from early on is worth re-stating.';
  }
  const because = [
    raw.status ? `HTTP ${raw.status}` : null,
    raw.reason ? String(raw.reason).slice(0, 160) : null,
  ].filter(Boolean).join(' — ');
  return `⚠ The previous session${where} had its context NOT saved${when}${because ? ` (${because})` : ''}.`
    + ' Its decisions and task state never reached DeerDawn, so the brief above predates that session.'
    + ' Ask the user what happened in it, or re-state it with manage_memory(action:"update").';
}

/** Read the notice and clear it — a warning shown once is a warning, twice is noise. */
export function consumeFlushNotice(): string | null {
  const line = readFlushNotice();
  if (line) clearFlushNotice();
  return line;
}
