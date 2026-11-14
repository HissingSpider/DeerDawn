// How Claude Code hooks invoke this package, and whether a written hook can run.
//
// Every hook used to start `deerdawn-mcp ...`. That is the package's `bin` name,
// but no documented install puts it on PATH: every install path is
// `npx -y @deerdawn/mcp-server@latest`, and npx exposes the bin only to the
// process it spawns. So every hook exited 127, each one swallowed by its own
// `|| true` — SessionStart never rendered the brief, Stop never flushed, the
// capture hooks captured nothing, and it all read as success.
//
// The command is now npx itself, which is on PATH wherever the MCP server could
// start. Two alternatives were rejected:
//   - `process.execPath` + the running dist path: the dist lives in
//     ~/.npm/_npx/<hash>/, which `npm cache clean`, npx's own eviction and a
//     version bump all move or delete, and execPath pins whichever nvm Node
//     happened to launch the server. Both rot silently, which is the failure
//     being fixed.
//   - bare `@latest`: npx revalidates the packument once its cache ages out, a
//     network round-trip on hooks that fire on EVERY edit and every Bash call.
//     `--prefer-offline` uses the cached package when there is one and fetches
//     only when there is not. The MCP server entry itself still runs plain
//     `@latest`, which is what keeps that cache current.

import fs from 'fs';
import path from 'path';

export const HOOK_PACKAGE_SPEC = '@deerdawn/mcp-server@latest';
export const HOOK_RUNNER = `npx -y --prefer-offline ${HOOK_PACKAGE_SPEC}`;

/** The shell command a hook runs for one CLI subcommand. */
export function hookCommand(subcommand: string): string {
  return `${HOOK_RUNNER} ${subcommand}`;
}

// A warm npx start is ~0.6s; a cold one (empty cache, first install) downloads
// the package and has taken well over ten seconds. Claude Code's default is 60s,
// so these mostly exist to make the budget explicit — and to keep PreToolUse,
// which sits in front of every edit, from ever holding one up for long. A hook
// that times out is killed and contributes nothing, exactly like one that fails.
export const HOOK_TIMEOUTS_SECONDS = {
  SessionStart: 60,
  Stop: 60,
  PostToolUse: 30,
  PreToolUse: 10,
} as const;

// Does this command invoke DeerDawn? Matches both the current npx form and the
// legacy bare-bin form, and only in command position, so a user hook that merely
// mentions a path containing "deerdawn-mcp" is not mistaken for ours.
const LEGACY_BIN_RE = /(^|[\s;&|()])deerdawn-mcp(?=\s|$|;|&|\|)/;
export function isDeerdawnCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  return command.includes('@deerdawn/mcp-server') || LEGACY_BIN_RE.test(command);
}

function isExecutableFile(p: string): boolean {
  try {
    const stat = fs.statSync(p);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve an executable name the way a shell would, against PATH. */
export function resolveExecutable(name: string, envPath: string | undefined = process.env.PATH): string | null {
  if (!name) return null;
  if (name.includes('/') || name.includes('\\')) {
    return isExecutableFile(name) ? name : null;
  }
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').concat([''])
    : [''];
  for (const dir of String(envPath || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Can this hook command actually start? Checks the program in command position
 * resolves, which is the exact failure a bare `deerdawn-mcp` hits under npx.
 * Deliberately not a full shell parse: every hook DeerDawn writes starts with
 * the program it runs, and a user-written command is not ours to judge.
 */
export function hookCommandResolves(command: unknown, envPath?: string): boolean {
  if (typeof command !== 'string') return false;
  const first = command.trim().split(/[\s;&|]+/)[0] ?? '';
  return resolveExecutable(first, envPath) !== null;
}

export type ManagedHookStatus = {
  /** A DeerDawn hook group exists under this event. */
  present: boolean;
  /** ...and every DeerDawn command in it can actually start. */
  runnable: boolean;
};

/**
 * Status of DeerDawn's hooks under one event in a parsed settings.json.
 *
 * "Present" alone is what used to be checked, and it was true for every install
 * whose hooks were dead: the group was there, tagged and all, calling a binary
 * that was never on PATH. Anything deciding behaviour from a hook must ask
 * whether it RUNS.
 */
export function managedHookStatus(settings: unknown, event: string, envPath?: string): ManagedHookStatus {
  const groups = (settings as any)?.hooks?.[event];
  if (!Array.isArray(groups)) return { present: false, runnable: false };
  const commands: unknown[] = [];
  for (const g of groups) {
    const cmds = Array.isArray(g?.hooks) ? g.hooks : [];
    const ours = g?.deerdawnManaged === true
      ? cmds
      : cmds.filter((h: any) => isDeerdawnCommand(h?.command));
    for (const h of ours) commands.push(h?.command);
  }
  if (!commands.length) return { present: false, runnable: false };
  return { present: true, runnable: commands.every((c) => hookCommandResolves(c, envPath)) };
}
