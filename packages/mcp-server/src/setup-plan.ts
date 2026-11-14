// The pieces of `deerdawn-mcp setup` that decide what gets written and what gets
// claimed. Kept out of index.ts, which dispatches the CLI as an import side
// effect and so cannot be imported by a test.

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ManagedHookStatus } from './hook-commands.js';
import { safeWriteFileSync } from './utils/safe-fs.js';
import { isCaptureDisabled } from './capture-optout.js';
import { readSetupChoices } from './setup-choices.js';

/** The hosted API. Every default in this package names it. */
export const DEFAULT_API_URL = 'https://api.deerdawn.com';

/**
 * Arguments for `claude mcp add`.
 *
 * There is deliberately NO `-e DEERDAWN_API_KEY=...`. setup used to bake the
 * device-flow key into the registration, and the server resolves env before
 * ~/.deerdawn/credentials.json — so that copy shadowed the credentials file
 * forever. Device-flow keys expire after 90 days; a re-sign-in wrote a fresh key
 * to credentials.json that the server never read again, because the dead one in
 * the MCP env still won. credentials.json already carries the key, and it is the
 * one place a renewal lands.
 */
export function buildClaudeMcpAddArgs(apiUrl: string = DEFAULT_API_URL): string[] {
  return [
    'mcp', 'add', '-s', 'user', 'deerdawn',
    '-e', `DEERDAWN_API_URL=${apiUrl}`,
    '-e', 'DEERDAWN_SURFACE_ID=claude_code',
    '--',
    'npx', '-y', '@deerdawn/mcp-server@latest',
  ];
}

/** The same registration as a command a person can paste (setup's fallback line). */
export function formatClaudeMcpAddCommand(apiUrl: string = DEFAULT_API_URL): string {
  return `claude mcp add -s user deerdawn -e DEERDAWN_API_URL=${apiUrl} -- npx -y @deerdawn/mcp-server@latest`;
}

/**
 * Which API does `setup` sign in against and register?
 *
 * A self-hosted DeerDawn serves its API from the operator's own origin, so a
 * setup that always wrote api.deerdawn.com into the registration signed the
 * person in to their own server and then pointed every later session at the
 * hosted one. Precedence: `--api-url <url>` (or `--api-url=<url>`), then
 * DEERDAWN_API_URL, then the hosted default. The value must be an http(s) URL
 * with no path beyond `/`; a trailing slash is dropped so `${apiUrl}/mcp` and
 * the registered env agree.
 */
export function resolveSetupApiUrl(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): { apiUrl: string; source: 'flag' | 'env' | 'default'; error: string | null } {
  let flag: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--api-url') {
      flag = argv[i + 1];
      if (flag === undefined || flag.startsWith('--')) {
        return { apiUrl: DEFAULT_API_URL, source: 'flag', error: '--api-url needs a value, e.g. --api-url https://deerdawn.example.com' };
      }
      break;
    }
    if (arg.startsWith('--api-url=')) {
      flag = arg.slice('--api-url='.length);
      break;
    }
  }
  const envValue = env.DEERDAWN_API_URL?.trim() || undefined;
  const raw = (flag ?? envValue)?.trim();
  const source = flag !== undefined ? 'flag' : envValue ? 'env' : 'default';
  if (!raw) {
    return flag !== undefined
      ? { apiUrl: DEFAULT_API_URL, source, error: '--api-url needs a value, e.g. --api-url https://deerdawn.example.com' }
      : { apiUrl: DEFAULT_API_URL, source: 'default', error: null };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { apiUrl: DEFAULT_API_URL, source, error: `${source === 'flag' ? '--api-url' : 'DEERDAWN_API_URL'} is not a URL: ${raw}` };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { apiUrl: DEFAULT_API_URL, source, error: `${source === 'flag' ? '--api-url' : 'DEERDAWN_API_URL'} must be an http(s) URL: ${raw}` };
  }
  return { apiUrl: raw.replace(/\/+$/, ''), source, error: null };
}

/**
 * Record the API the hooks should call in ~/.deerdawn/config.json (`api_url`),
 * the file session-context and flush-session read. A non-default URL is
 * written; the hosted default removes a recorded one, so switching back to
 * hosted with `setup` works too. Other keys in the file are kept. Returns a
 * setup line when something changed or could not be written, else null.
 */
export function recordHookApiUrl(apiUrl: string, dir: string = deerdawnConfigDir()): string | null {
  const file = path.join(dir, 'config.json');
  let cfg: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cfg = parsed;
  } catch { /* absent or unreadable: start empty */ }
  const current = typeof cfg.api_url === 'string' ? cfg.api_url : null;
  const wanted = apiUrl === DEFAULT_API_URL ? null : apiUrl;
  if (current === wanted) return null;
  if (wanted) cfg.api_url = wanted;
  else delete cfg.api_url;
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!safeWriteFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 })) throw new Error('not written');
  } catch {
    return `  Hooks        !  Could not write ${file}; add "api_url": "${apiUrl}" to it so the hooks reach ${apiUrl}`;
  }
  return wanted
    ? `  Hooks        ✓  Hooks will call ${wanted} (api_url in ${file})`
    : `  Hooks        ✓  Hooks will call ${DEFAULT_API_URL} (removed api_url ${current} from ${file})`;
}

function deerdawnConfigDir(): string {
  return process.env.DEERDAWN_DIR
    || (process.env.DEERDAWN_HOME_DIR ? path.join(process.env.DEERDAWN_HOME_DIR, '.deerdawn') : null)
    || path.join(os.homedir(), '.deerdawn');
}

/**
 * Does `setup` open a browser for the sign-in, and what does it say about it?
 *
 * Every piece of copy that describes this command says it opens your browser to
 * sign in. It did so only when ~/.claude.json recorded that the claude.ai
 * connector had once been connected — a condition borrowed from the MCP server's
 * background boot, where it means "this person is probably already signed in to
 * DeerDawn in a browser, so one click finishes it". For everybody else, which is
 * everybody following the install instructions for the first time, setup printed
 * a URL to stderr and waited, and the promised browser never appeared.
 *
 * `setup` is not that boot. It is a command a person typed, in a terminal they
 * are looking at, and opening the browser is what they were told would happen.
 * So it opens one — when there is a person and a screen to open it on:
 *   - not when stdout is not a TTY (piped, scripted, a CI step);
 *   - not in CI, where `open` has nobody to show anything to;
 *   - not over SSH, where it would open on the REMOTE machine, or hang;
 *   - not on Linux with no display server, where xdg-open fails noisily;
 *   - not when the user said no (DEERDAWN_NO_BROWSER).
 * The link is printed in EVERY case, because opening a browser can fail in ways
 * nothing here can detect, and the link works from any browser on any machine.
 *
 * Pure, so the rule can be tested without a terminal; index.ts supplies the facts.
 */
export function planSetupSignIn(facts: {
  env: Record<string, string | undefined>;
  platform: string;
  stdoutIsTTY: boolean;
}): { openBrowser: boolean; announcement: string } {
  const { env } = facts;
  const truthy = (value: string | undefined) => Boolean(value) && !/^(0|false|no|off)$/i.test(String(value).trim());
  const whyNot =
    truthy(env.DEERDAWN_NO_BROWSER) ? 'DEERDAWN_NO_BROWSER is set'
      : truthy(env.CI) ? 'this looks like CI'
        : (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) ? 'this is an SSH session, so it would open on the remote machine'
          : !facts.stdoutIsTTY ? 'this is not an interactive terminal'
            : (facts.platform !== 'darwin' && facts.platform !== 'win32' && !env.DISPLAY && !env.WAYLAND_DISPLAY) ? 'no display was found'
              : null;
  if (whyNot) {
    return {
      openBrowser: false,
      announcement: `  Not signed in yet. Not opening a browser (${whyNot}).\n  Open the sign-in link printed below in any browser, on any machine, and setup continues by itself.\n`,
    };
  }
  return {
    openBrowser: true,
    announcement: '  Not signed in yet. Opening your browser to sign in.\n  If no browser opens, use the sign-in link printed below (any browser, any machine).\n',
  };
}

export type SetupKeyState = 'valid' | 'rejected' | 'forbidden' | 'unreachable';

/**
 * Which key does `setup` run with, and does the env key get written down?
 *
 * setup took `env ?? saved` and persisted the env key only when NOTHING was
 * saved. With a stale credentials.json on disk that goes wrong twice over: a
 * working key passed as DEERDAWN_API_KEY was used for this run and then thrown
 * away, and because the registration deliberately carries no key (see
 * buildClaudeMcpAddArgs) the server and every hook then start from the stale
 * file. "Setup succeeded" followed by an install that cannot authenticate.
 *
 * So when the two differ, ask the API which one works. A working env key
 * replaces a saved one that does not. It never replaces a saved one that DOES:
 * that is a second valid credential — another workspace, say — and clobbering it
 * because a shell happened to export a different key is not setup's call. And a
 * dead env key stops shadowing a good saved one for the rest of the run.
 */
export async function resolveSetupKey(
  envKey: string | null,
  savedKey: string | null,
  check: (apiKey: string) => Promise<SetupKeyState>,
): Promise<{ apiKey: string | null; persistEnvKey: boolean; note: string | null }> {
  if (!envKey) return { apiKey: savedKey, persistEnvKey: false, note: null };
  if (!savedKey) return { apiKey: envKey, persistEnvKey: true, note: null };
  if (envKey === savedKey) return { apiKey: envKey, persistEnvKey: false, note: null };

  const envState = await check(envKey);
  if (envState === 'unreachable') {
    // Nothing learned. Behave as before and write nothing.
    return { apiKey: envKey, persistEnvKey: false, note: null };
  }
  if (envState !== 'valid') {
    return {
      apiKey: savedKey,
      persistEnvKey: false,
      note: envState === 'forbidden'
        ? '  API key      !  DEERDAWN_API_KEY was refused by the API (403) — using your saved sign-in instead'
        : '  API key      !  DEERDAWN_API_KEY was rejected (expired or revoked) — using your saved sign-in instead',
    };
  }
  const savedState = await check(savedKey);
  if (savedState === 'rejected' || savedState === 'forbidden') {
    return {
      apiKey: envKey,
      persistEnvKey: true,
      note: '  API key      ✓  Saved sign-in no longer works — replaced it with the working DEERDAWN_API_KEY',
    };
  }
  return {
    apiKey: envKey,
    persistEnvKey: false,
    note: savedState === 'valid'
      ? '  API key      !  DEERDAWN_API_KEY and your saved sign-in are both valid and differ — used the env key for this run, left ~/.deerdawn/credentials.json as it was'
      : null,
  };
}

/**
 * One setup line for the Claude Code hooks, from what is actually on disk.
 *
 * This used to print "✓ SessionStart/Stop hooks" whenever settings.json existed
 * — including for every install whose hooks called a binary that was not on
 * PATH, and for a malformed settings.json autoConfigureHooks had refused to
 * touch. A success line for a hook that cannot run is the thing that hid the bug.
 */
export function describeClaudeHooksResult(inspection: {
  settingsFound: boolean;
  /** The file exists and is a symlink, which safe-fs refuses to write through. */
  settingsIsSymlink?: boolean;
  events: Record<string, ManagedHookStatus>;
}): string {
  if (!inspection.settingsFound) {
    return '  Claude Code  –  Could not write ~/.claude/settings.json (malformed or unreadable?) — hooks not installed';
  }
  // With capture declined, or never switched on (it is opt-in: see
  // captureWanted in auth.ts), the Stop hook is deliberately absent; reporting
  // it as "missing — re-run setup" would send the user in a circle.
  const captureOff = isCaptureDisabled() || readSetupChoices().capture !== 'on';
  const required = captureOff ? ['SessionStart'] : ['SessionStart', 'Stop'];
  const missing = required.filter((e) => !inspection.events[e]?.present);
  if (missing.length) {
    // A symlinked settings.json reads perfectly and refuses to be written, so
    // the hooks stay absent no matter how often setup runs. Telling that user to
    // "re-run setup" names the one action guaranteed not to change anything, and
    // it said so again on every run after. Name the cause instead.
    if (inspection.settingsIsSymlink) {
      return `  Claude Code  ✗  ~/.claude/settings.json is a symlink, so DeerDawn will not write through it and the ${missing.join('/')} hooks were never installed.\n` +
        '               Replace it with a real file (copy the link target\'s contents over it), then re-run setup. Re-running on its own cannot help.';
    }
    return `  Claude Code  –  ${missing.join('/')} hooks missing from ~/.claude/settings.json — re-run setup`;
  }
  const dead = Object.entries(inspection.events)
    .filter(([, s]) => s.present && !s.runnable)
    .map(([e]) => e);
  if (dead.length) {
    return `  Claude Code  ✗  ${dead.join('/')} hooks written but cannot run: \`npx\` is not on PATH. Install Node.js (which provides npx), then re-run setup`;
  }
  if (captureOff) {
    return `  Claude Code  ✓  SessionStart hook (loads the brief); capture off${isCaptureDisabled(process.env, null) ? ' (DEERDAWN_CAPTURE)' : ''}`;
  }
  return '  Claude Code  ✓  SessionStart hook (loads the brief) + capture hooks (Stop, PostToolUse)';
}

/**
 * Should the server, at BOOT, copy a DEERDAWN_API_KEY it was started with into
 * ~/.deerdawn/credentials.json?
 *
 * The capture hooks (Stop flush, SessionStart brief) are separate processes the
 * host spawns WITHOUT the MCP server's `env` block, so a key that lives only in
 * that block — the README's headless path — never reaches them. The server
 * still installed the hooks, and every one of them then exited silently for
 * want of a credential: capture was switched on and captured nothing.
 *
 * Same rule `setup` has always applied (resolveSetupKey): persist only when
 * nothing is saved, so a second valid credential already on disk is never
 * clobbered, and only once the API has confirmed the key works, so a typo or a
 * revoked key does not become the machine's default sign-in. The destination
 * is the per-user credentials file (0600, in HOME) that every hook already
 * reads — never the repo's .mcp.json or any other project file.
 */
export async function persistBootEnvKey(
  envKey: string | null | undefined,
  deps: {
    loadSaved: () => string | null;
    check: (apiKey: string) => Promise<SetupKeyState>;
    save: (apiKey: string) => boolean;
  },
): Promise<'saved' | 'save_failed' | 'already_saved' | 'not_valid' | 'no_env_key'> {
  const key = envKey?.trim();
  if (!key) return 'no_env_key';
  if (deps.loadSaved()) return 'already_saved';
  const state = await deps.check(key);
  if (state !== 'valid') return 'not_valid';
  // Re-read: a device flow in another process may have landed while we asked.
  if (deps.loadSaved()) return 'already_saved';
  return deps.save(key) ? 'saved' : 'save_failed';
}
