/**
 * surface-state — what does this session plausibly need?
 *
 * Feeds listTools() so the advertised tool surface matches the session's actual
 * situation instead of enumerating everything DeerDawn can do. See the tier
 * comments in tools/index.ts for why that matters (~7,000 tokens per session).
 *
 * Every signal here is a LOCAL file read, deliberately: tools/list is answered
 * immediately after initialize, and blocking that on a network round-trip would
 * trade a token cost for a latency cost on the most timing-sensitive call in the
 * protocol. Any unreadable signal degrades to "unknown", and unknown always
 * widens the surface rather than narrowing it — over-advertising costs tokens,
 * under-advertising breaks the session.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { SurfaceState } from './tools/index.js';
import { SKILL_PREFIX } from './project-sync.js';
import { credentialsWereRejected } from './auth-state.js';

const DEERDAWN_DIR = path.join(os.homedir(), '.deerdawn');
const CREDENTIALS_PATH = path.join(DEERDAWN_DIR, 'credentials.json');
const MANIFEST_PATH = path.join(DEERDAWN_DIR, 'synced-paths.json');

function isAuthed(): boolean {
  // A key the API has already refused is not authentication, and treating it as
  // such hides get_auth_status — the tool that carries the sign-in link — from
  // exactly the session that needs it. Checked FIRST so it also overrides an
  // env-var key, which expires the same way a stored one does.
  if (credentialsWereRejected()) return false;
  if (process.env.DEERDAWN_API_KEY) return true;
  try {
    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    return Boolean(creds?.api_key);
  } catch {
    return false;
  }
}

/**
 * Is a project already bound to this directory?
 *
 * Matched case-insensitively and by prefix: synced-paths.json is keyed by the
 * path as first written, and a previously-recorded case mismatch between
 * "/Users/…/DeerDawn" and the real "/Users/…/deerdawn" would otherwise read as
 * "unbound" and re-advertise the bootstrap tier to an established workspace.
 */
function hasBoundProject(cwd: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    // Entries live under `paths`, matching the SyncManifest shape written by
    // project-sync.ts — reading the top level instead silently matches nothing.
    const paths = parsed?.paths;
    if (!paths || typeof paths !== 'object') return false;
    const target = cwd.toLowerCase();
    return Object.keys(paths).some((key) => {
      const k = key.toLowerCase();
      return target === k || target.startsWith(`${k}/`) || k.startsWith(`${target}/`);
    });
  } catch {
    return false;
  }
}

/** Does this workspace have DeerDawn skills synced to disk? */
function hasSkills(cwd: string): boolean {
  const candidates = [
    path.join(cwd, '.claude', 'skills'),
    path.join(cwd, '.cursor', 'rules'),
  ];
  for (const dir of candidates) {
    try {
      if (fs.readdirSync(dir).some((entry) => entry.startsWith(SKILL_PREFIX))) return true;
    } catch { /* directory absent — not an error, just no skills here */ }
  }
  return false;
}

export function detectSurfaceState(
  // CLAUDE_PROJECT_DIR is the project root the host opened; process.cwd() can be
  // wherever the server process happened to start, which would miss the binding.
  cwd: string = process.env.CLAUDE_PROJECT_DIR || process.cwd(),
): SurfaceState {
  const authed = isAuthed();
  return {
    authed,
    // Only meaningful once signed in. An unauthenticated session should see the
    // full first-run surface regardless of what happens to be on disk.
    hasBoundProject: authed && hasBoundProject(cwd),
    hasSkills: hasSkills(cwd),
  };
}
