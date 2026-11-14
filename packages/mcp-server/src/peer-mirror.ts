/**
 * peer-mirror — peer state on disk, for the one consumer that cannot call out.
 *
 * The PreToolUse hook fires in the agent's edit path, before every Edit and
 * Write. That is the only moment where a warning PREVENTS a collision rather than
 * narrating one afterwards — and it is also the most latency-sensitive place in
 * the whole product. A network call there would be paid on every single edit.
 *
 * So this follows exactly the rule surface-state.ts already established for
 * tools/list: the hook reads LOCAL FILES ONLY. The mirror is refreshed as a side
 * effect of calls the agent already makes, and the hook never learns anything the
 * mirror has not been told. A stale mirror under-warns; that is the correct
 * direction, because blocking a legitimate edit is an uninstall and a missed
 * warning is the status quo.
 *
 * Freshness is carried IN the file (`captured_at`) rather than inferred from
 * mtime, so a mirror left behind by a crashed process ages out on read.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { safeWriteFileSync } from './utils/safe-fs.js';

const MIRROR_PATH = path.join(os.homedir(), '.deerdawn', 'peers.json');

/** Beyond this the mirror is treated as unknown, not as "nobody is here". */
export const MIRROR_TTL_MS = 45 * 60 * 1000;

export interface MirrorPeer {
  session_id: string;
  /** Who the peer is, when the server could name them. */
  display_name?: string | null;
  tool?: string | null;
  cwd?: string | null;
  scope: string[];
  held_cards: string[];
}

interface MirrorFile {
  captured_at: string;
  cwd: string | null;
  project_id: string | null;
  peers: MirrorPeer[];
}

/**
 * Write the current peers for this workspace. Best-effort and silent: a mirror
 * write failing must never surface to the user or interrupt a session start —
 * the feature it powers is advisory.
 */
export function writePeerMirror(
  cwd: string | null | undefined,
  projectId: string | null | undefined,
  presence: unknown,
): void {
  try {
    const peers: MirrorPeer[] = Array.isArray(presence)
      ? (presence as Array<Record<string, any>>).map((p) => ({
          session_id: String(p?.session_id || ''),
          display_name: p?.display_name ? String(p.display_name) : null,
          tool: p?.tool ?? null,
          cwd: p?.cwd ?? null,
          scope: Array.isArray(p?.scope) ? p.scope.map((x: unknown) => String(x)) : [],
          held_cards: Array.isArray(p?.held_cards)
            ? p.held_cards.map((c: any) => String(typeof c === 'string' ? c : c?.title || '')).filter(Boolean)
            : [],
        })).filter((p) => p.session_id)
      : [];
    const payload: MirrorFile = {
      captured_at: new Date().toISOString(),
      cwd: cwd ? String(cwd) : null,
      project_id: projectId ? String(projectId) : null,
      peers,
    };
    // Written even when `peers` is empty — that is a positive statement that
    // nobody else is here, and it is what clears a previous session's peers so
    // the hook stops warning about agents that have long since gone.
    safeWriteFileSync(MIRROR_PATH, JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    /* advisory feature — never surface a mirror failure */
  }
}

/**
 * Read the mirror. Returns an empty peer list on ANY problem — missing file,
 * unparseable JSON, wrong workspace, aged out. Every failure mode degrades to
 * "warn about nothing", never to "block".
 */
export function readPeerMirror(cwd: string, nowMs: number = Date.now()): MirrorPeer[] {
  try {
    const raw = fs.readFileSync(MIRROR_PATH, 'utf8');
    const parsed = JSON.parse(raw) as MirrorFile;
    if (!parsed || !Array.isArray(parsed.peers)) return [];
    const captured = Date.parse(String(parsed.captured_at || ''));
    if (!Number.isFinite(captured) || nowMs - captured > MIRROR_TTL_MS) return [];
    // The mirror is per-workspace. A mirror captured in another checkout says
    // nothing about who is editing here, and warning from it would be noise.
    if (parsed.cwd && cwd && path.resolve(parsed.cwd) !== path.resolve(cwd)) return [];
    return parsed.peers;
  } catch {
    return [];
  }
}

/**
 * Does an edit to `filePath` overlap a peer's derived scope?
 *
 * Matching is deliberately coarse — a basename or a path fragment a peer wrote
 * recently. It exists to make a human-legible warning ("session-x has been in
 * this file"), not to be a lock, so a false negative is cheap and a false
 * positive costs one line the model can dismiss.
 */
export function findOverlappingPeers(filePath: string, peers: MirrorPeer[]): MirrorPeer[] {
  const target = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  if (!target) return [];
  const base = target.split('/').filter(Boolean).pop() || '';
  return peers.filter((peer) =>
    (peer.scope || []).some((entry) => {
      const scope = String(entry || '').replace(/\\/g, '/').toLowerCase();
      // Ignore fragments too short to mean anything — "src" would match the
      // entire repo and make the hook warn on every edit, which trains the model
      // to ignore it. A warning that always fires is worse than none.
      if (scope.length < 4) return false;
      return target.includes(scope) || (base.length >= 4 && scope.includes(base));
    }),
  );
}

export const PEER_MIRROR_PATH = MIRROR_PATH;
