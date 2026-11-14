/**
 * routing-hint: what the SessionStart hook tells the model about WHICH project
 * it loaded, how sure that is, and how to get to the right one.
 *
 * The hook is the one caller that always knows the directory. A hosted
 * connector (claude.ai, ChatGPT) does not, so its start_session and id-less
 * saves resolve from the person's most recent work anywhere — which, in a
 * different repo, is a different project. Two answers in one session, and the
 * agent went on with whichever it read last. So the hook now hands over the id
 * it resolved, says plainly when its own answer is only a guess (with the likely
 * alternatives), and remembers the last confident answer per directory so an
 * outage still leaves the agent a project to ask for.
 *
 * Pure formatting plus a small best-effort cache: nothing here may throw into
 * the hook, which must always print a valid payload.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { isGuessedMatch, type ActiveMatch } from './write-target.js';

export interface ProjectRef {
  project_id: string;
  project_name?: string | null;
}

export interface ActiveRouting extends ActiveMatch {
  match_guessed?: boolean | null;
  alternatives?: ProjectRef[] | null;
}

// High-confidence kinds as the API names them, in words a model can repeat.
const MATCH_WORDS: Record<string, string> = {
  path: 'this directory is linked to it',
  pinned: 'it is the subproject pinned for this repository',
  workspace: 'it belongs to this repository',
  session: 'this connection was last working in it',
  explicit: 'it was named explicitly',
  name: 'its name resembles this directory, nothing more',
  recency_fallback: 'it is your most recently used project, nothing more',
  shared_fallback: 'it is the team\'s most recent shared project, nothing more',
  ancestor_path: 'a parent folder is linked to it, but this is another or unknown repository',
};

function label(ref: ProjectRef | ActiveRouting): string {
  const name = ref.project_name || ref.project_id;
  return name === ref.project_id ? `"${name}"` : `"${name}" (${ref.project_id})`;
}

export function alternativesLine(alternatives: ProjectRef[] | null | undefined): string | null {
  const list = (alternatives || []).filter((a) => a && typeof a.project_id === 'string' && a.project_id);
  if (!list.length) return null;
  return `Other recent projects: ${list.slice(0, 3).map(label).join(', ')}.`;
}

/** Is this /active answer one the agent should verify rather than trust? */
export function isGuess(active: ActiveRouting): boolean {
  return Boolean(active.match_guessed) || isGuessedMatch(active);
}

/**
 * The header and the closing instruction for a loaded brief.
 *
 * Confident: the header keeps "Auto-loaded; use it without re-asking", and the
 * id is handed over so a connector that cannot see this folder does not guess.
 * Guessed: no such promise. The header says it is a guess and why, names the
 * alternatives, and says how to switch — before the brief, because a caveat
 * read after a brief has already been believed changes nothing.
 */
export function routingFrame(active: ActiveRouting, synced: string): { header: string; footer: string } {
  const kind = String(active.match_kind || '');
  const why = MATCH_WORDS[kind] || (kind ? `matched by ${kind}` : 'matched without a stated reason');
  const id = active.project_id;
  if (!isGuess(active)) {
    const header = `[DeerDawn] Project context — ${active.project_name || id}${synced}. Matched because ${why}. Auto-loaded; use it without re-asking the user.`;
    const footer = `Project id for this directory: ${id}. Pass project_id: "${id}" on DeerDawn calls that take one: a DeerDawn connector that cannot see this folder would otherwise pick a project from your recent history.`;
    return { header, footer };
  }
  const header = [
    `[DeerDawn] POSSIBLE project context — ${label(active)}${synced}. This is a guess: ${why}. It is not linked to this directory.`,
    'Before relying on it, check it matches the work here (the repository, the person\'s request). If it does not, do not use it.',
    alternativesLine(active.alternatives),
    `To load another project, call start_session or manage_projects (action "select") with its project_id. If this one IS right, pass project_id: "${id}" on the first save.`,
  ].filter(Boolean).join('\n');
  return { header, footer: '' };
}

/** Said beside the "no brief matched" fallback when the API offered candidates. */
export function noMatchHint(alternatives: ProjectRef[] | null | undefined): string | null {
  const line = alternativesLine(alternatives);
  return line
    ? `${line} If this directory belongs to one of them, load it with start_session or manage_projects (action "select") and its project_id, then pass that project_id on the first save so the directory is linked to it.`
    : null;
}

// ─── Last confident answer per directory ─────────────────────────────────────

const CACHE_FILE = 'repo-projects.json';
const MAX_ENTRIES = 200;

interface CacheEntry {
  project_id: string;
  project_name: string | null;
  match_kind: string | null;
  at: string;
}

function cachePath(): string {
  const dir = process.env.DEERDAWN_DIR
    || (process.env.DEERDAWN_HOME_DIR ? path.join(process.env.DEERDAWN_HOME_DIR, '.deerdawn') : null)
    || path.join(os.homedir(), '.deerdawn');
  return path.join(dir, CACHE_FILE);
}

function readCache(): Record<string, CacheEntry> {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Remember a CONFIDENT answer for this directory. A guess is never cached: the
 * cache exists to be trusted during an outage, and a remembered guess would be
 * the wrong project with a "last known" label on it.
 */
export function rememberRepoProject(key: string | null | undefined, active: ActiveRouting): void {
  if (!key || !active.project_id || isGuess(active)) return;
  try {
    const cache = readCache();
    cache[key] = {
      project_id: active.project_id,
      project_name: active.project_name || null,
      match_kind: active.match_kind || null,
      at: new Date().toISOString(),
    };
    const keys = Object.keys(cache);
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => String(cache[a].at).localeCompare(String(cache[b].at)));
      for (const stale of keys.slice(0, keys.length - MAX_ENTRIES)) delete cache[stale];
    }
    const file = cachePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch { /* best effort: the brief already went out */ }
}

export function lastKnownRepoProject(key: string | null | undefined): CacheEntry | null {
  if (!key) return null;
  const entry = readCache()[key];
  return entry && typeof entry.project_id === 'string' ? entry : null;
}

/** The recovery line added to the degraded notice when this directory has a remembered project. */
export function lastKnownHint(entry: CacheEntry | null): string | null {
  if (!entry) return null;
  return `Last confirmed project for this directory: ${label(entry)}, seen ${entry.at}. When DeerDawn answers, load it with start_session and project_id: "${entry.project_id}" (or pass that project_id on DeerDawn calls), rather than letting it guess.`;
}
