/**
 * Which API key a capture hook should use: the one the DeerDawn server for THIS
 * repo is started with.
 *
 * A hook (Stop flush, SessionStart brief, command and worktree capture) is a
 * separate process the host spawns WITHOUT the MCP server entry's `env` block.
 * Since #523 the server copies an env-only key into ~/.deerdawn/credentials.json
 * at boot so the hooks can authenticate at all — but only when nothing is saved
 * yet, so the file holds whichever repo's key booted FIRST. A person with a
 * personal key in one repo and a team key in another (each in that repo's
 * .mcp.json, which is exactly how `GET /teams/workspace-config` hands a team its
 * setup) then had every hook in repo B authenticate with repo A's key: repo B's
 * transcript flushed into repo A's workspace, and SessionStart injected repo A's
 * brief into repo B.
 *
 * So a hook resolves the key the way the host resolves the server's env, from
 * the configuration that belongs to this directory, and falls back to the
 * per-user file only when no configuration names one:
 *
 *   1. local scope    ~/.claude.json  projects[<project dir>].mcpServers.<deerdawn>.env
 *   2. project scope  the nearest .mcp.json up to the repo root (the same walk
 *                     workspace-override.ts uses for DEERDAWN_WORKSPACE)
 *   3. user scope     ~/.claude.json  mcpServers.<deerdawn>.env
 *   4. the hook's own environment (a key exported in the shell, which the server
 *      also inherits but which an entry's `env` overrides)
 *   5. ~/.deerdawn/credentials.json
 *
 * Scopes 1-3 are Claude Code's own precedence for a server registered in more
 * than one place. A config value may use the `${VAR}` / `${VAR:-default}`
 * expansion Claude Code applies to .mcp.json; an expansion that yields nothing
 * is skipped rather than sent. Codex and Cursor register elsewhere and run no
 * Claude Code hooks, so they are not read here.
 *
 * A key from 1-4 that the API answers 401 is not the end: the server itself
 * moves to credentials.json on its first 401, so a hook does too — see
 * hookKeySender and the rejected-key record below.
 *
 * Nothing is cached: a hook is a fresh process every turn, and a stale answer
 * here is a write in the wrong workspace.
 */

import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { deerdawnServerEnvBlocks, findInProjectMcpJson } from './workspace-override.js';

export type HookKeySource = 'local-config' | 'project-config' | 'user-config' | 'env' | 'credentials';

export interface HookApiKey {
  apiKey: string | null;
  source: HookKeySource | null;
}

type Env = Record<string, string | undefined>;

/** Longer than any key this service mints; short enough that nothing else fits. */
const MAX_KEY_LENGTH = 512;

function plausibleKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > MAX_KEY_LENGTH) return null;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return null;
  }
  return value;
}

/** Claude Code's .mcp.json expansion: `${VAR}` and `${VAR:-default}`. */
function expand(raw: unknown, env: Env): unknown {
  if (typeof raw !== 'string' || !raw.includes('${')) return raw;
  return raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) => {
    const value = env[name];
    return value !== undefined && value !== '' ? value : (fallback ?? '');
  });
}

function keyInEnvBlocks(servers: unknown, env: Env): string | null {
  for (const block of deerdawnServerEnvBlocks(servers)) {
    const key = plausibleKey(expand(block.DEERDAWN_API_KEY, env));
    if (key) return key;
  }
  return null;
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The project directory as ~/.claude.json keys it: the absolute path, and its realpath. */
function projectKeys(projectDir: string): string[] {
  const keys = new Set<string>();
  try { keys.add(path.resolve(projectDir)); } catch { /* unresolvable */ }
  try { keys.add(fs.realpathSync(projectDir)); } catch { /* missing */ }
  return [...keys];
}

export interface HookKeyOptions {
  projectDir?: string | null;
  env?: Env;
  home?: string;
  /**
   * false for a Codex flush: Codex registers in ~/.codex/config.toml, so a
   * Claude Code registration says nothing about which key its server holds.
   * Only the shell and credentials.json are consulted, as before.
   */
  claudeConfig?: boolean;
}

/** Every key a hook could use, in the order above, each key once. */
function hookKeyCandidates(options: HookKeyOptions, home: string): Array<{ apiKey: string; source: HookKeySource }> {
  const env = options.env ?? process.env;
  const useClaudeConfig = options.claudeConfig !== false;
  const projectDir = !useClaudeConfig
    ? null
    : options.projectDir === undefined
      ? (env.CLAUDE_PROJECT_DIR?.trim() || safeCwd())
      : options.projectDir;

  const found: Array<{ apiKey: string; source: HookKeySource }> = [];
  const add = (apiKey: string | null | undefined, source: HookKeySource) => {
    if (apiKey && !found.some((seen) => seen.apiKey === apiKey)) found.push({ apiKey, source });
  };

  const claudeJson = useClaudeConfig ? readJson(path.join(home, '.claude.json')) : null;

  if (projectDir) {
    const projects = claudeJson?.projects;
    if (projects && typeof projects === 'object') {
      for (const key of projectKeys(projectDir)) {
        const local = keyInEnvBlocks(projects[key]?.mcpServers, env);
        if (local) { add(local, 'local-config'); break; }
      }
    }
    const fromProject = findInProjectMcpJson(projectDir, (block) => plausibleKey(expand(block.DEERDAWN_API_KEY, env)));
    if (fromProject) add(fromProject.value, 'project-config');
  }

  add(keyInEnvBlocks(claudeJson?.mcpServers, env), 'user-config');
  add(plausibleKey(env.DEERDAWN_API_KEY), 'env');
  add(plausibleKey(readJson(path.join(home, '.deerdawn', 'credentials.json'))?.api_key), 'credentials');
  return found;
}

// ─── A pinned key the API has already rejected ────────────────────────────────
//
// A key pinned in a registration (or exported in the shell) outranks
// credentials.json, and nothing ever rewrites it. When the API revokes it — a
// team removal revokes every key the person holds, a rotation retires the old
// one — the running server recovers on its first 401 by adopting whatever
// credentials.json holds (index.ts, getClient/adoptApiKey). Before this, the
// hooks had no such step: they went on sending the dead key from the config,
// every Stop flush and every SessionStart brief failed, and the session the
// agent was working in looked perfectly healthy.
//
// So a hook does what the server does — on a 401, it tries the key the shell
// and credentials.json hold, once each — and remembers the rejection, so the
// next hook (and the command and worktree capture, which have no retry of their
// own) goes straight to the working one. Only a SHA-256 of the key is stored:
// the file says "this key is dead", never what the key was. A rejection is
// recorded only once another key has been accepted in its place, or by the
// server when it swaps off a key the API refused — a 401 alone could be a
// broken API, and skipping a working key on the strength of one would be worse
// than the failure it avoids.

const REJECTED_KEYS_FILE = 'rejected-pinned-keys.json';
/** Enough for years of rotations; the file never grows past it. */
const MAX_REJECTED_KEYS = 20;

function keyFingerprint(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

function rejectedFingerprints(home: string): string[] {
  const stored = readJson(path.join(home, '.deerdawn', REJECTED_KEYS_FILE))?.sha256;
  return Array.isArray(stored) ? stored.filter((entry: unknown): entry is string => typeof entry === 'string') : [];
}

/**
 * Remember that the API rejected this key. Best effort: a hook that cannot
 * write the file still works, it just retries again next time.
 */
export function recordRejectedPinnedKey(apiKey: string, home: string = os.homedir()): void {
  const value = plausibleKey(apiKey);
  if (!value) return;
  try {
    const fingerprint = keyFingerprint(value);
    const known = rejectedFingerprints(home);
    if (known.includes(fingerprint)) return;
    const next = [...known, fingerprint].slice(-MAX_REJECTED_KEYS);
    const dir = path.join(home, '.deerdawn');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, REJECTED_KEYS_FILE), JSON.stringify({ sha256: next }), { mode: 0o600 });
  } catch { /* best effort */ }
}

/** A key a hook may fall back to after a 401: never another registration's. */
const FALLBACK_SOURCES: ReadonlySet<HookKeySource> = new Set(['env', 'credentials']);

export interface HookKeyChoice extends HookApiKey {
  /**
   * What to try, in order, if the API answers 401 to `apiKey`: the shell's key
   * and then credentials.json's — the same step the server takes. Never another
   * registration's key: that would be exactly the cross-repo mix-up this file
   * exists to prevent. Empty when `apiKey` is credentials.json's own.
   */
  fallbacks: HookApiKey[];
  home: string;
}

export function resolveHookApiKeys(options: HookKeyOptions = {}): HookKeyChoice {
  const home = options.home ?? os.homedir();
  const candidates = hookKeyCandidates(options, home);
  if (!candidates.length) return { apiKey: null, source: null, fallbacks: [], home };

  const first = candidates[0];
  const fallbacks = first.source === 'credentials'
    ? []
    : candidates.slice(1).filter((candidate) => FALLBACK_SOURCES.has(candidate.source));
  // A pinned key the API already refused is passed over for the first fallback
  // it has not also refused — the same keys a 401 would have moved on to, and
  // never to another registration's. With nothing else on offer it is still
  // sent, so the failure is the API's to report rather than a hook going quiet.
  const rejected = new Set(rejectedFingerprints(home));
  if (first.source !== 'credentials' && rejected.has(keyFingerprint(first.apiKey))) {
    const index = fallbacks.findIndex((candidate) => candidate.source === 'credentials' || !rejected.has(keyFingerprint(candidate.apiKey)));
    if (index >= 0) {
      const next = fallbacks[index];
      return { apiKey: next.apiKey, source: next.source, fallbacks: fallbacks.slice(index + 1), home };
    }
  }
  return { apiKey: first.apiKey, source: first.source, fallbacks, home };
}

export function resolveHookApiKey(options: HookKeyOptions = {}): HookApiKey {
  const { apiKey, source } = resolveHookApiKeys(options);
  return { apiKey, source };
}

/**
 * Send a hook's request, recovering from a dead pinned key the way the server
 * does: on a 401, retry with each fallback once — at most two extra requests,
 * never a loop — and keep using whichever key was accepted. `key` is the one
 * currently in use, for a follow-up request in the same hook.
 */
export function hookKeySender(choice: HookKeyChoice) {
  let current = choice.apiKey;
  const queue = [...choice.fallbacks];
  return {
    get key(): string | null {
      return current;
    },
    async send<R extends { ok: boolean; status: number }>(request: (apiKey: string) => Promise<R>): Promise<R> {
      if (!current) throw new Error('no DeerDawn key to send');
      let res = await request(current);
      while (res.status === 401 && queue.length) {
        current = queue.shift()!.apiKey!;
        res = await request(current);
      }
      if (res.ok && choice.apiKey && current !== choice.apiKey) recordRejectedPinnedKey(choice.apiKey, choice.home);
      return res;
    },
  };
}

function safeCwd(): string | null {
  try {
    return process.cwd();
  } catch {
    return null;
  }
}
