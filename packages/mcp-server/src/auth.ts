import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFileSync, spawn } from 'child_process';
import { buildCursorInstructionBlock } from './instruction-block.js';
import { buildOnDiskInstructionBlock, classifyMcpServerEntry, detectClaudeCodeServerKinds, detectCodexServerKinds, type DeerdawnServerKind } from './on-disk-instructions.js';
import * as setupStatus from '../../shared-context/src/setup-status.js';
import { getBlockToken, findOwnedBlock, upsertOwnedBlock } from './managed-block.js';
import { safeWriteFileSync, isUnsafeSymlink } from './utils/safe-fs.js';
import { timeoutSignal, AUTH_FETCH_TIMEOUT_MS } from './utils/fetch-timeout.js';
import { announceCredentialRenewed } from './auth-state.js';
import { hookCommand, isDeerdawnCommand, managedHookStatus, HOOK_TIMEOUTS_SECONDS, type ManagedHookStatus } from './hook-commands.js';
import { isCaptureDisabledByEnv } from './capture-optout.js';
import { resolveLocalSurfaceOrNull } from './surface.js';
import { readSetupChoices, writeSetupChoices } from './setup-choices.js';
// Inlined at build time (tsup), as in index.ts: the version that actually runs.
import { version as PKG_VERSION } from '../package.json';

// How DeerDawn's block is found and refreshed in a file that is the person's
// (CLAUDE.md, AGENTS.md, the Cursor rule): one rule, in setup-status.js, shared
// with apply_setup so a boot and apply_setup can never disagree about which
// bytes are DeerDawn's. A block is DeerDawn's when it carries THIS install's
// token (managed-block.ts); nothing that merely looks like it is.

/** Does this file hold DeerDawn's instruction block, found the way every writer finds it? */
export function holdsManagedBlock(file: string): boolean {
  try {
    return findOwnedBlock(fs.readFileSync(file, 'utf8'), getBlockToken({ create: false })) !== null;
  } catch {
    return false;
  }
}

/** Codex's config.toml as setup-status.js reads it (as TOML, from CODEX_HOME when set). */
export type CodexConfig = { path: string; exists: boolean; parsed: boolean; error: string | null };
const codexFiles = setupStatus as unknown as {
  codexHomeDir(home: string): string;
  readCodexConfig(home: string): CodexConfig;
};

/** Where Codex keeps config.toml and its global AGENTS.md: $CODEX_HOME when set (codex-cli 0.154 reads both there), else ~/.codex. */
export function codexHomeDir(home: string): string {
  return codexFiles.codexHomeDir(home);
}

export function readCodexConfig(home: string): CodexConfig {
  return codexFiles.readCodexConfig(home);
}

function getDeerdawnDir(): string {
  return process.env.DEERDAWN_DIR
    || (process.env.DEERDAWN_HOME_DIR ? path.join(process.env.DEERDAWN_HOME_DIR, '.deerdawn') : null)
    || path.join(os.homedir(), '.deerdawn');
}

function getCredentialsPath(): string {
  return path.join(getDeerdawnDir(), 'credentials.json');
}

function getPendingAuthPath(): string {
  return path.join(getDeerdawnDir(), 'pending-auth.json');
}

// Returns true if the user has already connected DeerDawn via Claude.ai OAuth.
// Used to decide whether to auto-open the browser during the device flow —
// if they're already logged into DeerDawn in the browser, it's a one-click approval.
export function hasClaudeAiDeerDawnConnection(): boolean {
  try {
    const claudeJsonPath = path.join(os.homedir(), '.claude.json');
    if (!fs.existsSync(claudeJsonPath)) return false;
    const claude = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    const connected: string[] = claude.claudeAiMcpEverConnected ?? [];
    return connected.includes('claude.ai DeerDawn');
  } catch {
    return false;
  }
}

function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore', timeout: 3000 });
    } else if (process.platform === 'darwin') {
      execFileSync('open', [url], { stdio: 'ignore', timeout: 3000 });
    } else {
      execFileSync('xdg-open', [url], { stdio: 'ignore', timeout: 3000 });
    }
  } catch { /* non-fatal — user can open manually */ }
}

export function loadSavedApiKey(): string | null {
  try {
    const raw = fs.readFileSync(getCredentialsPath(), 'utf8');
    const creds = JSON.parse(raw);
    return creds.api_key || null;
  } catch {
    return null;
  }
}

/**
 * Persist a freshly minted key. Returns whether it actually reached disk.
 *
 * safeWriteFileSync REFUSES rather than writing through a symlink (see
 * utils/safe-fs.ts), and this used to discard that answer — so a credentials.json
 * that had been symlinked, or a ~/.deerdawn the user cannot write, produced the
 * words "Credentials saved to ~/.deerdawn/credentials.json" and an empty file.
 * The next start then signed in again, and again, with nothing on screen ever
 * admitting why. Callers report from the return value.
 *
 * It does not throw: the key is good and the session can use it even when it
 * cannot be stored, and turning a successful sign-in into an exception would
 * throw away the one thing that did work.
 */
export function saveApiKey(apiKey: string): boolean {
  const credentialsPath = getCredentialsPath();
  const deerdawnDir = getDeerdawnDir();
  let written = false;
  try {
    if (!fs.existsSync(deerdawnDir)) fs.mkdirSync(deerdawnDir, { recursive: true });
    written = safeWriteFileSync(credentialsPath, JSON.stringify({ api_key: apiKey }, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error(`[DeerDawn] Could not write ${credentialsPath}: ${err instanceof Error ? err.message : String(err)}`);
    written = false;
  }
  if (!written) {
    console.error(
      `[DeerDawn] Signed in, but the credential could NOT be saved to ${credentialsPath}.\n` +
      (isUnsafeSymlink(credentialsPath)
        ? '            That path is a symlink, and DeerDawn will not write through one. Replace it with a real file (or delete it) and sign in again.\n'
        : '            Check that the file and its directory are writable, then sign in again.\n') +
      '            This session keeps working; the next start will ask you to sign in again.'
    );
  }
  clearPendingAuth();
  autoConfigureHooks();
  return written;
}

// Marks a hook matcher-group as owned by DeerDawn. Boots after the first one can
// then find and refresh our own entries in place without touching hooks the user
// added under the same event. Mirrors the OPEN_MARKER/CLOSE_MARKER approach that
// scopes DeerDawn's managed region inside CLAUDE.md.
const DEERDAWN_HOOK_TAG = 'deerdawnManaged';

type HookCommand = { type?: string; command?: string; [k: string]: unknown };
type HookGroup = { matcher?: string; hooks?: HookCommand[]; [k: string]: unknown };

// A matcher-group belongs to DeerDawn if we tagged it, or — for installs written
// before the tag existed — if its commands invoke DeerDawn (the legacy bare
// `deerdawn-mcp` bin or the npx form). Recognizing legacy entries lets us
// replace them in place instead of stacking a duplicate alongside them.
function isDeerdawnHookGroup(group: unknown): boolean {
  if (!group || typeof group !== 'object') return false;
  const g = group as HookGroup;
  if (g[DEERDAWN_HOOK_TAG] === true) return true;
  const cmds = Array.isArray(g.hooks) ? g.hooks : [];
  return cmds.some(h => isDeerdawnCommand(h?.command));
}

// Merge DeerDawn's managed groups into one event's hook array. Our previous
// entries are replaced AT THE POSITION the first of them held, so a migration
// from the dead `deerdawn-mcp ...` commands rewrites them in place rather than
// reordering the user's hooks around them. Every group the user added survives.
//
// An untagged legacy group can hold a user's own command beside ours (someone
// hand-edited the group). Dropping the whole group would delete their hook, so
// only our commands are stripped from it, and the group stays if anything is
// left. Idempotent — re-running never duplicates DeerDawn's entries.
function mergeDeerdawnHookGroups(existing: unknown, managed: HookGroup[]): HookGroup[] {
  const current = Array.isArray(existing) ? (existing as HookGroup[]) : [];
  const out: HookGroup[] = [];
  let insertAt = -1;
  for (const group of current) {
    if (!isDeerdawnHookGroup(group)) {
      out.push(group);
      continue;
    }
    if (insertAt === -1) insertAt = out.length;
    if (group[DEERDAWN_HOOK_TAG] === true) continue;
    const remaining = (Array.isArray(group.hooks) ? group.hooks : []).filter(h => !isDeerdawnCommand(h?.command));
    if (remaining.length) out.push({ ...group, hooks: remaining });
  }
  if (insertAt === -1) insertAt = out.length;
  out.splice(insertAt, 0, ...managed);
  return out;
}

/**
 * What DeerDawn's Claude Code hooks look like on disk right now — read back
 * rather than assumed, because autoConfigureHooks swallows its own failures and
 * a written hook is not a working one. `setup` reports from this.
 */
export function inspectClaudeCodeHooks(envPath?: string): {
  settingsFound: boolean;
  settingsIsSymlink: boolean;
  events: Record<'SessionStart' | 'Stop' | 'PreToolUse' | 'PostToolUse', ManagedHookStatus>;
} {
  const events = ['SessionStart', 'Stop', 'PreToolUse', 'PostToolUse'] as const;
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  let settings: unknown = null;
  let settingsFound = false;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settingsFound = true;
  } catch { /* missing or malformed — every event reads absent */ }
  const out = {} as Record<(typeof events)[number], ManagedHookStatus>;
  for (const event of events) out[event] = managedHookStatus(settings, event, envPath);
  // A symlinked settings.json READS fine and REFUSES to be written (safe-fs), so
  // the hooks stay absent forever while every diagnostic says only "missing —
  // re-run setup". Re-running is the one thing that cannot help, so carry the
  // real cause out to whoever prints the line.
  return { settingsFound, settingsIsSymlink: isUnsafeSymlink(settingsPath), events: out };
}

/**
 * Every kind of DeerDawn server Cursor has registered, by the rule
 * classifyMcpServerEntry applies to Claude Code's and Codex's: in
 * ~/.cursor/mcp.json, and in the project's own .cursor/mcp.json, looked for from
 * `cwd` up to its repo root (Cursor reads both). Only `mcpServers` counts: a
 * top-level `deerdawn` key is not somewhere Cursor looks.
 */
export function detectCursorServerKinds(home: string, cwd?: string | null): DeerdawnServerKind[] {
  const found = new Set<DeerdawnServerKind>();
  const readFrom = (file: string) => {
    let config: { mcpServers?: unknown } | null = null;
    try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
    const servers = config?.mcpServers;
    if (!servers || typeof servers !== 'object') return;
    for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
      const kind = classifyMcpServerEntry(name, entry);
      if (kind) found.add(kind);
    }
  };
  const globalPath = path.join(home, '.cursor', 'mcp.json');
  readFrom(globalPath);
  if (cwd) {
    // Bounded, and stopped at the repo root, the way detectClaudeCodeServerKinds
    // walks up to a committed .mcp.json.
    let dir = path.resolve(cwd);
    for (let depth = 0; depth < 12; depth += 1) {
      const projectPath = path.join(dir, '.cursor', 'mcp.json');
      if (projectPath !== globalPath) readFrom(projectPath);
      const parent = path.dirname(dir);
      if (parent === dir || fs.existsSync(path.join(dir, '.git'))) break;
      dir = parent;
    }
  }
  return [...found];
}

/**
 * The kinds to fit a tool's block to, counting THIS server when it is running
 * inside that tool. That is the strongest evidence there is that the tool has
 * DeerDawn registered, wherever the registration lives (a workspace config, a
 * project file in another repo, anything this process cannot see), and the
 * server answering is the stdio one, so the block is fitted to it.
 */
function withRunningServer(kinds: DeerdawnServerKind[], tool: 'codex' | 'cursor', runningIn: string | null): DeerdawnServerKind[] {
  return runningIn === tool ? [...new Set<DeerdawnServerKind>([...kinds, 'local'])] : kinds;
}

// A boot configures ONLY the tool it is running inside, and never takes a block
// out. A Codex or Cursor boot used to be able to write Claude Code's hooks and
// CLAUDE.md, and a Claude Code boot Codex's AGENTS.md and Cursor's rule: files of
// tools the person had not chosen to set up from here. Now the tool is named
// (`options.tool`, or the one this process is running inside: DEERDAWN_SURFACE_ID,
// else the handshake) and only its files are touched. A boot that cannot tell
// which tool it is in (no handshake yet, or a host with no DeerDawn profile)
// writes nothing; the handshake calls this again once the tool is named.
//
// Nor does a boot remove a block. It used to remove one whenever it ran
// somewhere else and saw no registration for that tool, but "saw none" is not
// "there is none": Cursor also reads a project's own .cursor/mcp.json, and a boot
// in repo A cannot see repo B's. With Cursor registered only in repo B, every
// Claude Code boot stripped the rule and every Cursor boot put it back. The one
// boot that could know is the tool's own, and while it is running the server it
// is registered (withRunningServer). get_setup_status names a block with no
// registration behind it (`stale_block`, `instructions_without_mcp_server`) and
// how to remove it; a person asks for that.

export type ConfiguredTool = 'claude_code' | 'codex' | 'cursor';

// What the SessionStart command prints when the session-context binary itself
// cannot run. For the model, and descriptive: it used to order the model to call
// start_session before answering, which put DeerDawn ahead of whatever the
// person had actually asked. Single-quoted into a shell command, so it must
// never contain a single quote.
const HOOK_FALLBACK_JSON = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: '[DeerDawn] The session-context hook could not run, so no project brief was loaded this session.',
  },
});

/** Does this settings.json already carry DeerDawn's capture hooks (Stop or PostToolUse)? */
function hasDeerdawnCaptureHooks(hooks: Record<string, unknown>): boolean {
  return (['Stop', 'PostToolUse'] as const).some((event) =>
    Array.isArray(hooks[event]) && (hooks[event] as unknown[]).some(isDeerdawnHookGroup));
}

/**
 * Should the capture hooks be installed?
 *
 * Only after a yes. Capture sends the redacted session transcript, the Bash
 * commands an agent runs and which files changed to DeerDawn's API for
 * extraction, and it used to be installed for everybody at every boot with no
 * question asked. Now `setup` asks (setup-choices.ts) and this follows the
 * answer; DEERDAWN_CAPTURE=off outranks a yes.
 *
 * An install from before the question, which already has the hooks and has
 * never been asked, keeps them. Taking them out silently would stop its brief
 * updating at session end with nothing on screen to say why, which is the
 * failure this product exists to prevent. So the answer is recorded as
 * `existing_install`, and the SessionStart hook tells the person once, in their
 * own transcript, what capture sends and how to turn it off (session-context.ts).
 * A machine with no hooks and no answer gets none.
 */
function captureWanted(hooks: Record<string, unknown>): boolean {
  if (isCaptureDisabledByEnv()) return false;
  const choice = readSetupChoices().capture;
  if (choice) return choice === 'on';
  if (!hasDeerdawnCaptureHooks(hooks)) return false;
  writeSetupChoices({ capture: 'on', capture_source: 'existing_install' });
  return true;
}

/**
 * Put DeerDawn's block back in ~/.claude/CLAUDE.md, for a person who removed it
 * and has now said yes in `setup` (the one way back in: a removal the person
 * made is not undone by a boot or by an agent's apply_setup). Clears the
 * recorded removal. Returns whether the block reached the file.
 */
export function restoreGlobalClaudeMdBlock(): boolean {
  try {
    const token = getBlockToken();
    if (!token) return false;
    const claudeDir = path.join(os.homedir(), '.claude');
    const file = path.join(claudeDir, 'CLAUDE.md');
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const block = buildOnDiskInstructionBlock(
      detectClaudeCodeServerKinds(os.homedir(), process.env.CLAUDE_PROJECT_DIR || process.cwd()),
      token,
    ).trimEnd();
    if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });
    if (!safeWriteFileSync(file, upsertOwnedBlock(existing, block, token))) return false;
    writeSetupChoices({ global_claude_md: 'kept', global_claude_md_removed_at: undefined });
    return true;
  } catch {
    return false;
  }
}

export function autoConfigureHooks(options: { tool?: string | null } = {}): void {
  // Which tool this process is running inside, when it can be known yet: the
  // server's own env (a tool-specific config sets it) or the `initialize`
  // handshake. Never a guess (surface.ts), so null means "cannot say".
  const runningIn = resolveLocalSurfaceOrNull();
  const tool = options.tool !== undefined ? options.tool : runningIn;

  // ── Claude Code settings.json ─────────────────────────────────────────────
  if (tool === 'claude_code') try {
    const claudeDir = path.join(os.homedir(), '.claude');
    const settingsPath = path.join(claudeDir, 'settings.json');

    // Start from the existing settings, or an empty object for a brand-new
    // Claude Code user who has no settings.json yet. This block used to be gated
    // on the file already existing, which silently skipped installing the
    // capture hooks (Stop flush, SessionStart inject, PostToolUse capture) for
    // exactly the new-user cohort where automatic capture matters most. A
    // malformed existing file still throws here and aborts via the outer catch,
    // so we never clobber a real config we can't parse.
    const settingsExisted = fs.existsSync(settingsPath);
    const settings = settingsExisted
      ? JSON.parse(fs.readFileSync(settingsPath, 'utf8') || '{}')
      : {};
    const hooks = settings.hooks || {};
    // Capture (Stop, PostToolUse) is installed only after a yes. See
    // captureWanted: the answer setup recorded, DEERDAWN_CAPTURE=off over it,
    // and an install that already had the hooks keeping them. A no merges the
    // capture groups in as EMPTY lists, which is what removes ones a previous
    // boot installed — skipping the merge would leave them firing. The brief
    // injection (SessionStart) and the local-only peer warning (PreToolUse)
    // capture nothing and stay.
    const captureOff = !captureWanted(hooks);

    // Merge our managed groups into each event instead of overwriting the whole
    // array — this refreshes DeerDawn's own entries while preserving any hooks the
    // user added under the same events. Each managed group carries DEERDAWN_HOOK_TAG
    // so the next boot can identify and update it. See mergeDeerdawnHookGroups.
    hooks.Stop = mergeDeerdawnHookGroups(hooks.Stop, captureOff ? [] : [{
      [DEERDAWN_HOOK_TAG]: true,
      matcher: '',
      hooks: [{ type: 'command', command: `${hookCommand('capture-worktree-change')} 2>/dev/null || true; ${hookCommand('flush-session')} 2>/dev/null || true`, timeout: HOOK_TIMEOUTS_SECONDS.Stop }],
    }]);

    // Always refresh SessionStart — ensures existing installs get the latest instruction.
    // session-context fetches the live project brief and emits it as additionalContext so
    // the agent has current context deterministically (no reliance on it calling
    // start_session). It always prints valid hook JSON; the echo is a last-resort fallback
    // if the binary itself can't run.
    hooks.SessionStart = mergeDeerdawnHookGroups(hooks.SessionStart, [{
      [DEERDAWN_HOOK_TAG]: true,
      matcher: '',
      // prime-worktree only exists to give the change capture a baseline.
      hooks: [{ type: 'command', timeout: HOOK_TIMEOUTS_SECONDS.SessionStart, command: `${captureOff ? '' : `${hookCommand('prime-worktree')} 2>/dev/null || true; `}${hookCommand('session-context')} 2>/dev/null || echo '${HOOK_FALLBACK_JSON}'` }],
    }]);

    hooks.PostToolUse = mergeDeerdawnHookGroups(hooks.PostToolUse, captureOff ? [] : [
      {
        [DEERDAWN_HOOK_TAG]: true,
        // Capture file changes SILENTLY. This used to also echo an additionalContext
        // reminder ("call update_context now…") after EVERY Write/Edit/MultiEdit —
        // which fired dozens of times per session, trained agents to tune it out,
        // and merely duplicated guidance the agent already has two other ways: the
        // persistent MCP instructions block ("call update_context on a decision/ship")
        // and the Stop hook's end-of-session flush that captures everything anyway.
        // Capture is the useful part; the per-write nag was noise, so it's gone.
        matcher: 'Write|Edit|MultiEdit',
        hooks: [{ type: 'command', command: `${hookCommand('capture-worktree-change')} 2>/dev/null || true`, timeout: HOOK_TIMEOUTS_SECONDS.PostToolUse }],
      },
      {
        [DEERDAWN_HOOK_TAG]: true,
        matcher: 'Bash',
        hooks: [{ type: 'command', command: `${hookCommand('capture-command')} 2>/dev/null || true`, timeout: HOOK_TIMEOUTS_SECONDS.PostToolUse }],
      },
    ]);

    // Multi-agent overlap warning, BEFORE the edit — the only point at which
    // knowing a peer is in this file changes the outcome rather than explaining
    // it. Reads ~/.deerdawn/peers.json and nothing else: no network call belongs
    // in the edit path, and the command exits 0 unconditionally so a failure can
    // never block a write. Silent whenever no peer overlaps, which is nearly
    // always — a hook that fires on every edit gets tuned out, and then it is
    // worth less than nothing.
    hooks.PreToolUse = mergeDeerdawnHookGroups(hooks.PreToolUse, [
      {
        [DEERDAWN_HOOK_TAG]: true,
        matcher: 'Write|Edit|MultiEdit',
        hooks: [{ type: 'command', command: `${hookCommand('peer-check')} 2>/dev/null || true`, timeout: HOOK_TIMEOUTS_SECONDS.PreToolUse }],
      },
    ]);

    // An event left with no groups is dropped rather than written as `[]`.
    for (const event of ['Stop', 'PostToolUse'] as const) {
      if (Array.isArray(hooks[event]) && hooks[event].length === 0) delete hooks[event];
    }
    settings.hooks = hooks;
    if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });
    safeWriteFileSync(settingsPath, JSON.stringify(settings, null, 2));
    console.error(captureOff
      ? `[DeerDawn] Installed the SessionStart brief and PreToolUse peer check in ~/.claude/settings.json${settingsExisted ? '' : ' (created)'}; capture hooks (Stop, PostToolUse) are off`
      : `[DeerDawn] Merged hooks (SessionStart + PreToolUse, and capture: Stop + PostToolUse) into ~/.claude/settings.json${settingsExisted ? '' : ' (created)'}`);
  } catch { /* non-fatal */ }

  // ── ~/.claude/CLAUDE.md ───────────────────────────────────────────────────
  //
  // Refreshed, never added. Every boot used to append the block when it was
  // missing, so a person who deleted it from their own global file found it back
  // at the next start, and every repo they opened was told to call DeerDawn,
  // projects or not. Now:
  //   - a block that is there (written by an earlier version, or asked for with
  //     apply_setup) is refreshed in place, so it never goes stale;
  //   - a block that WAS there and is gone was removed by the person, and that is
  //     recorded (setup-choices.ts) as an opt-out no boot undoes;
  //   - nothing is added to a file without one. The instruction now lives in the
  //     repos that have a DeerDawn project (project-sync's pointer, written by
  //     setup), and the SessionStart hook delivers the brief without it.
  if (tool === 'claude_code') try {
    const claudeDir = path.join(os.homedir(), '.claude');
    const globalClaudeMd = path.join(claudeDir, 'CLAUDE.md');
    const existing = fs.existsSync(globalClaudeMd) ? fs.readFileSync(globalClaudeMd, 'utf8') : '';
    // Made (or reclaimed from this very file, after a wiped ~/.deerdawn) only
    // when there is a file to look in: see getBlockToken.
    const found = existing ? findOwnedBlock(existing, getBlockToken()) : null;
    const choices = readSetupChoices();
    if (!found) {
      if (choices.global_claude_md === 'kept') {
        writeSetupChoices({ global_claude_md: 'removed', global_claude_md_removed_at: new Date().toISOString() });
        console.error('[DeerDawn] The DeerDawn block was removed from ~/.claude/CLAUDE.md — recorded, and it will not be added back');
      }
    } else {
      // The block carries this install's token (managed-block.ts). Without one it
      // could not be recognised on the next boot.
      const token = getBlockToken();
      if (!token) {
        console.error('[DeerDawn] Could not store the install token in ~/.deerdawn/install.json — the instruction block in ~/.claude/CLAUDE.md was left as it is');
      } else {
        // Fitted to whichever DeerDawn server Claude Code actually has registered: a
        // hosted endpoint does not have every call the stdio server has, and a block
        // that names a call the server refuses fails at the top of every session.
        // See on-disk-instructions.ts.
        const block = buildOnDiskInstructionBlock(
          detectClaudeCodeServerKinds(os.homedir(), process.env.CLAUDE_PROJECT_DIR || process.cwd()),
          token,
        ).trimEnd();
        // The person's text around it is never touched (see upsertManagedBlock). A
        // block an older version wrote, with the markers before the token, is
        // recognised once and rewritten with it.
        const newContent = upsertOwnedBlock(existing, block, token);
        if (newContent !== existing) {
          safeWriteFileSync(globalClaudeMd, newContent);
          console.error('[DeerDawn] Refreshed the DeerDawn block in ~/.claude/CLAUDE.md');
        }
        if (choices.global_claude_md !== 'kept') writeSetupChoices({ global_claude_md: 'kept' });
      }
    }
  } catch { /* non-fatal */ }

  // ── ~/.codex/AGENTS.md ($CODEX_HOME/AGENTS.md when that is set) ───────────
  if (tool === 'codex') try {
    const codexAgentsPath = path.join(codexHomeDir(os.homedir()), 'AGENTS.md');
    // Codex keeps its own registrations (config.toml beside that AGENTS.md), so
    // its block is fitted to those and not to Claude Code's.
    const codexKinds = withRunningServer(detectCodexServerKinds(os.homedir()), 'codex', runningIn);
    // No DeerDawn server in Codex's config means none of the calls the block
    // names exist there. buildOnDiskInstructionBlock reads an empty list as the
    // local server, which is right for Claude Code (setup is about to register
    // it) and wrong here, where nothing will: the block became a standing order,
    // in the person's own global AGENTS.md, to call a tool Codex cannot see. So
    // nothing is written, and nothing is removed either (see above).
    const codexToken = codexKinds.length && fs.existsSync(codexAgentsPath) ? getBlockToken() : null;
    if (codexToken) {
      const existing = fs.readFileSync(codexAgentsPath, 'utf8');
      const block = buildOnDiskInstructionBlock(codexKinds, codexToken).trimEnd();
      const newContent = upsertOwnedBlock(existing, block, codexToken);
      if (newContent !== existing) {
        safeWriteFileSync(codexAgentsPath, newContent);
        console.error(`[DeerDawn] Updated ${codexAgentsPath}`);
      }
    }
  } catch { /* non-fatal */ }

  // ── ~/.cursor/rules/deerdawn.mdc ──────────────────────────────────────────
  if (tool === 'cursor') try {
    const cursorRulesDir = path.join(os.homedir(), '.cursor', 'rules');
    const mdcPath = path.join(cursorRulesDir, 'deerdawn.mdc');
    const cursorKinds = withRunningServer(
      detectCursorServerKinds(os.homedir(), process.env.CLAUDE_PROJECT_DIR || process.cwd()),
      'cursor',
      runningIn,
    );
    // Same rule as Codex: a rules directory is not a DeerDawn connection, and
    // this used to be written off the directory alone.
    const cursorToken = cursorKinds.length && fs.existsSync(cursorRulesDir) ? getBlockToken() : null;
    if (cursorToken) {
      const content = [
        '---',
        'description: DeerDawn session memory — brief every new session with your project at session start',
        'alwaysApply: true',
        '---',
        '',
        buildCursorInstructionBlock(cursorToken).trimEnd(),
      ].join('\n') + '\n';

      const existing = fs.existsSync(mdcPath) ? fs.readFileSync(mdcPath, 'utf8') : '';
      // The whole file used to be rewritten, so anything the person had added to
      // it went. Created whole when absent or empty; after that, only the block.
      const next = existing ? upsertOwnedBlock(existing, buildCursorInstructionBlock(cursorToken), cursorToken) : content;
      if (next !== existing) {
        safeWriteFileSync(mdcPath, next);
        console.error('[DeerDawn] Updated ~/.cursor/rules/deerdawn.mdc');
      }
    }
  } catch { /* non-fatal */ }
}

export function savePendingAuth(data: {
  verification_url: string;
  device_code?: string;
  expires_at?: string;
  error_message?: string;
}): void {
  const deerdawnDir = getDeerdawnDir();
  if (!fs.existsSync(deerdawnDir)) fs.mkdirSync(deerdawnDir, { recursive: true });
  safeWriteFileSync(getPendingAuthPath(), JSON.stringify({
    ...data,
    started_at: new Date().toISOString(),
  }, null, 2));
}

// The API mints a device code that lives ten minutes (DEVICE_CODE_TTL in
// apps/api/src/routes/shared/mcp-auth.js). A saved pending auth older than that
// does not hold a sign-in link — it holds a dead one, and handing it to a user
// is worse than handing them nothing, because it looks like the way forward.
//
// Observed 2026-09-06: a pending-auth.json written 31 hours earlier was still
// being served as THE sign-in link on every auth failure. The code had expired
// 10 minutes after it was written, so the dashboard answered 404 and the user
// had no route to a fresh one — get_auth_status only minted a new code when the
// file was absent entirely, and nothing ever removed it, since clearPendingAuth
// runs only on success.
//
// index.ts already applied exactly this ten-minute rule to decide whether to
// resume a device flow. It was right, and it was the only place that knew.
export const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;

/** Is this saved sign-in link still capable of working? */
export function isPendingAuthFresh(pending: { started_at?: string; expires_at?: string } | null): boolean {
  if (!pending) return false;
  // Trust an explicit expiry when the API supplies one; fall back to age.
  if (pending.expires_at) return pending.expires_at > new Date().toISOString();
  const started = Date.parse(pending.started_at ?? '');
  if (!Number.isFinite(started)) return false;
  return Date.now() - started < PENDING_AUTH_TTL_MS;
}

export function clearPendingAuth(): void {
  try { fs.unlinkSync(getPendingAuthPath()); } catch { /* already gone */ }
}

/**
 * Forget the saved link, but only if it is the one this flow was polling.
 *
 * A detached poll can outlive the link that started it: a second flow may have
 * written a fresh pending-auth.json in the meantime, and deleting THAT because
 * an older code expired would take the user's working link away. Compared by
 * device code so the old flow can only ever clean up after itself.
 */
function clearPendingAuthForDeviceCode(deviceCode: string): void {
  if (loadPendingAuth()?.device_code === deviceCode) clearPendingAuth();
}

export function loadPendingAuth(): {
  verification_url?: string;
  device_code?: string;
  expires_at?: string;
  started_at?: string;
  error_message?: string;
} | null {
  try {
    return JSON.parse(fs.readFileSync(getPendingAuthPath(), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * A refusal more polling cannot fix.
 *
 * The loop below deliberately swallows ordinary failures — a dropped connection
 * mid-flow is not a reason to abandon a sign-in a human is walking to a browser
 * to finish. This class is how a genuinely final answer gets out through that
 * catch instead of being mistaken for a hiccup.
 */
class TerminalAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalAuthError';
  }
}

/**
 * Is this failure one that a link already in the user's hand cannot survive?
 *
 * `setup` needs to know, because its advice differs by exactly this: an ordinary
 * failure leaves the printed link alive and worth finishing in a browser, while
 * a terminal one means that link is spent and the only step forward mints a new
 * code. Matched on the NAME as well as the class so a second copy of this module
 * in a bundle cannot quietly turn every terminal refusal back into an ordinary
 * one.
 */
export function isTerminalAuthFailure(err: unknown): boolean {
  return err instanceof TerminalAuthError || (err as { name?: string })?.name === 'TerminalAuthError';
}

// What /token actually answers (apps/api/src/routes/shared/mcp-auth.js):
//
//   200 {status:'pending'}     nobody has approved yet — keep polling
//   200 {status:'authorized'}  done, and the code is spent (one-time pickup)
//   400 missing device_code    we asked wrongly; asking again cannot fix it
//   404 expired_or_invalid     the code expired, or somebody already collected
//                              it. Expired and never-issued are indistinguishable
//                              there by construction: the key is simply absent.
//   503 service_unavailable    Redis is unreachable — retry, this one passes
//
// A 404 used to land in `if (!res.ok) continue`, so a dead code was polled for
// the whole window — up to thirty minutes of a person watching a link that could
// never work — and the only thing ever said about it was "Authorization timed
// out", which describes waiting rather than the expiry that had already happened.
const TERMINAL_POLL_STATUSES = new Set([400, 404, 410]);
const EXPIRED_LINK_MESSAGE =
  'This sign-in link has expired or has already been used. Start sign-in again to get a fresh link — this one cannot be retried.';

// Rate-limit backoff. The old rule slept up to two minutes at a time, and with
// no Retry-After header at all it multiplied the poll interval by five and could
// still reach that cap — on a ten-minute link, two of those sleeps are a fifth of
// its life spent not asking, while the user watches a browser tab that already
// said "Authorized". Honour what the server states; otherwise grow gently.
const MAX_POLL_BACKOFF_MS = 15_000;

/** How long the server asked us to wait, in ms, or null if it said nothing usable. */
function statedRetryDelayMs(headers: { get(name: string): string | null }): number | null {
  const retryAfter = headers.get('Retry-After');
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.max(dateMs - Date.now(), 0);
  }
  // draft-ietf-httpapi-ratelimit-headers: seconds remaining in the current window.
  const reset = headers.get('RateLimit-Reset') ?? headers.get('X-RateLimit-Reset');
  if (reset) {
    const value = Number.parseInt(reset, 10);
    if (Number.isFinite(value) && value >= 0) {
      // Some servers send an absolute epoch here instead of a duration.
      return value > 1_000_000_000 ? Math.max(value * 1000 - Date.now(), 0) : value * 1000;
    }
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function poll(apiUrl: string, deviceCode: string, intervalMs: number, timeoutMs: number): Promise<string> {
  const tokenUrl = `${apiUrl}/api/v1/auth/mcp/token?device_code=${encodeURIComponent(deviceCode)}`;
  const deadline = Date.now() + timeoutMs;
  let waitMs = intervalMs;
  while (Date.now() < deadline) {
    await sleep(Math.min(waitMs, Math.max(0, deadline - Date.now())));
    if (Date.now() >= deadline) break;
    try {
      const res = await fetch(tokenUrl, { signal: timeoutSignal(AUTH_FETCH_TIMEOUT_MS) });
      if (res.status === 429) {
        const stated = statedRetryDelayMs(res.headers);
        waitMs = stated ?? Math.min(Math.max(waitMs * 2, intervalMs), MAX_POLL_BACKOFF_MS);
        // Never sleep past the code's own expiry: waking to poll a link that
        // died while we waited is the one outcome worse than saying so now.
        if (waitMs >= deadline - Date.now()) {
          throw new TerminalAuthError(
            `Sign-in polling is rate limited for longer than this link lives (${Math.ceil(waitMs / 1000)}s). ` +
            'Wait a moment, then start sign-in again for a fresh link.'
          );
        }
        console.error(`[DeerDawn] Auth polling rate limited — retrying in ${Math.ceil(waitMs / 1000)}s`);
        continue;
      }
      // Not limited any more: back to the cadence the server asked for.
      waitMs = intervalMs;
      if (TERMINAL_POLL_STATUSES.has(res.status)) {
        // Only OUR link, never a newer one a later flow has since written.
        clearPendingAuthForDeviceCode(deviceCode);
        throw new TerminalAuthError(EXPIRED_LINK_MESSAGE);
      }
      if (!res.ok) continue;
      const body = await res.json() as { status: string; api_key?: string };
      if (body.status === 'authorized' && body.api_key) return body.api_key;
    } catch (err) {
      if (err instanceof TerminalAuthError) throw err;
      // network hiccup, keep polling
    }
  }
  throw new Error('Authorization timed out. Re-run to try again.');
}

function checkRateLimit(res: Response): void {
  if (res.status === 429) {
    const retryAfter = res.headers.get('Retry-After') ?? '60';
    const waitSec = parseInt(retryAfter, 10);
    throw new Error(
      `Rate limited by DeerDawn API. Please wait ${waitSec} seconds before restarting. ` +
      `This usually happens after several quick restarts during setup.`
    );
  }
}

type DeviceFlowStart = {
  device_code: string;
  verification_url: string;
  expires_at?: string;
  expires_in?: number;
  interval?: number;
};

/**
 * A stable, anonymous id for this install, for the device-flow telemetry only.
 *
 * `mcp_device_flow_started` carried nothing that said WHICH machine started a
 * sign-in, so ten starts read the same whether they were ten people or one
 * person's ten restarts, and the sign-in leak could not be sized. This is a
 * one-way hash of the install's block token (managed-block.ts), which already
 * exists per install and survives restarts: the token itself never leaves the
 * machine, and nothing about the person or the machine is in it. null when the
 * token cannot be stored; the flow never depends on it.
 */
export function deviceFlowInstallId(): string | null {
  try {
    const token = getBlockToken();
    if (!token) return null;
    return crypto.createHash('sha256').update(`deerdawn-install:${token}`).digest('hex').slice(0, 32);
  } catch {
    return null;
  }
}

// We told the API we honour the window it states, so this asks for the long one
// (30 minutes rather than 10). A server that does not understand the flag simply
// issues the short window and says so in expires_in — which is why the poll
// deadline below is READ rather than assumed. The install id and package version
// only label the attempt (see deviceFlowInstallId); an API that predates them
// ignores them.
function startBody(): string {
  const installId = deviceFlowInstallId();
  return JSON.stringify({
    honors_server_expiry: true,
    client_version: PKG_VERSION,
    ...(installId ? { install_id: installId } : {}),
  });
}
// Built per call, not once: the AbortSignal inside carries a deadline, and a
// module-level one would already have fired by the time the second sign-in of
// the process used it.
const startRequestInit = (timeoutMs: number = AUTH_FETCH_TIMEOUT_MS): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: startBody(),
  signal: timeoutSignal(timeoutMs),
});

/**
 * Ask the API to start a device flow, and say something a person can act on
 * when it does not answer.
 *
 * timeoutSignal aborts the request (utils/fetch-timeout.ts), and an abort is
 * reported by fetch as "This operation was aborted" — the runtime's description
 * of its own mechanism, naming no service, no deadline, and nothing to do. That
 * string travelled all the way out to `setup` ("Sign-in could not be completed:
 * This operation was aborted") and to get_auth_status, which relays the same
 * message. Translated at the one place that knows what the deadline was for.
 */
function isAbortError(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

async function startDeviceFlow(apiUrl: string, timeoutMs: number = AUTH_FETCH_TIMEOUT_MS): Promise<Response> {
  try {
    return await fetch(`${apiUrl}/api/v1/auth/mcp/start`, startRequestInit(timeoutMs));
  } catch (err) {
    if (!isAbortError(err)) throw err;
    throw new Error(
      `The DeerDawn API did not answer within ${Math.round(timeoutMs / 1000)} seconds. `
      + 'Check your connection and try again.'
    );
  }
}

// Polling ran for a hardcoded 600_000ms. That matched DEVICE_CODE_TTL only by
// coincidence — the constants live in different packages and neither knew about
// the other, so the moment one moved, the client would either give up on a live
// code or poll a dead one. The server states the window; believe it.
function pollWindowMs(start: { expires_in?: number; expires_at?: string }): number {
  if (typeof start.expires_in === 'number' && start.expires_in > 0) return start.expires_in * 1000;
  if (start.expires_at) {
    const remaining = Date.parse(start.expires_at) - Date.now();
    if (Number.isFinite(remaining) && remaining > 0) return remaining;
  }
  return PENDING_AUTH_TTL_MS;
}

function pollIntervalMs(start: { interval?: number }): number {
  return typeof start.interval === 'number' && start.interval > 0 ? start.interval * 1000 : 2000;
}

export async function beginDeviceFlow(apiUrl: string): Promise<string> {
  const startRes = await startDeviceFlow(apiUrl);
  checkRateLimit(startRes);
  if (!startRes.ok) throw new Error('Failed to start auth flow. Is the DeerDawn API reachable?');
  const start = await startRes.json() as DeviceFlowStart;
  savePendingAuth({ verification_url: start.verification_url, device_code: start.device_code, expires_at: start.expires_at });

  // Handing out a sign-in link without listening for it is what made every
  // browser sign-in a no-op. This function only ever returned a URL, and the
  // one thing that polls — the startup device flow in index.ts — does not run
  // when a credentials.json exists. A DEAD key is still a key, so an install
  // whose key had expired took the "use it" branch forever: get_auth_status
  // minted link after link, the user completed them correctly, and the minted
  // credential sat in Redis unclaimed until its TTL wiped it. Nothing on the
  // machine was addressed by any of it.
  //
  // Detached on purpose: the caller is answering "how do I sign in", and must
  // not block for ten minutes waiting for a human. Failure is silent because
  // the window simply closing is the ordinary outcome — the next
  // get_auth_status mints a fresh link, and now that one is listened for too.
  void poll(apiUrl, start.device_code, pollIntervalMs(start), pollWindowMs(start))
    .then((apiKey) => {
      const saved = saveApiKey(apiKey);
      clearPendingAuth();
      // Reaches the live client, so a sign-in takes effect in the session that
      // asked for it rather than only after a restart nobody was told to do.
      // Announced whether or not the file was written: the key works either way,
      // and saveApiKey has already said on stderr what did not.
      announceCredentialRenewed(apiKey);
      console.error(saved
        ? `[DeerDawn] Signed in — credentials saved and this session is reconnected.\n${IN_TOOL_NEXT_STEP}\n`
        : `[DeerDawn] Signed in and this session is reconnected, but the credential could not be saved (see above).\n${IN_TOOL_NEXT_STEP}\n`);
    })
    .catch((err) => {
      // The window simply closing is the ordinary outcome and not news. A
      // terminal refusal is: the link the user is holding is dead, and nothing
      // but a fresh one helps.
      if (err instanceof TerminalAuthError) console.error(`[DeerDawn] ${err.message}\n`);
    });

  return start.verification_url;
}

export async function resumeDeviceFlow(apiUrl: string, deviceCode: string, verificationUrl: string, expiresAt?: string): Promise<string> {
  if (verificationUrl) {
    // stderr only — stdout carries JSON-RPC frames exclusively when running as an
    // MCP stdio server; any stray line corrupts the stream in strict clients.
    console.error(`\nDeerDawn: resuming sign-in. Complete auth at: ${verificationUrl}\n`);
  }
  const apiKey = await poll(apiUrl, deviceCode, 2000, pollWindowMs({ expires_at: expiresAt }));
  announceAuthorized(saveApiKey(apiKey));
  return apiKey;
}

/**
 * What to do once the browser says "Authorized", for a sign-in that started
 * inside an AI tool (the server's boot flow, get_auth_status, the SessionStart
 * hook). The session that asked is already reconnected (announceCredentialRenewed),
 * so the next step is something to SAY in it. Two phrases, because an account
 * with no project has no brief to resume yet. `setup` passes its own (see
 * runDeviceFlow): it has more of the install left to do.
 */
export const IN_TOOL_NEXT_STEP =
  '   Next: go back to your AI tool. This session is connected; ask "Set up a DeerDawn brief for this project",\n'
  + '   or, if you already have one, "Where did I leave off? Check DeerDawn". New sessions load the brief by themselves.';

/**
 * One sentence about where the credential went, and it has to be the true one,
 * then the next step. "Authorized. Credentials saved to …" ended the output, and
 * a person who had just finished the one step they were asked to do was left
 * with no idea what to do after it.
 */
function announceAuthorized(saved: boolean, nextStep: string = IN_TOOL_NEXT_STEP): void {
  console.error(saved
    ? `Authorized. Credentials saved to ${getCredentialsPath()}\n${nextStep}\n`
    : `Authorized, but the credential could not be saved (see above) — this run works, the next one will ask again.\n${nextStep}\n`);
}

/**
 * The outcome of a completed sign-in: the key, and whether it reached disk.
 *
 * saveApiKey has returned that second answer since #500, and this function threw
 * it away — so `setup` could print an all-ticks summary and "Done. Restart
 * Claude Code" over a credentials.json it had just been refused, and exit 0. The
 * only caller that reported the failure was the env-key branch, which is not the
 * path a new user takes. Callers report from the return value.
 */
export type DeviceFlowResult = { apiKey: string; saved: boolean };

// `autoOpen` has two callers with different reasons, and the sentence printed
// used to describe only one of them ("you're connected via Claude.ai"), which was
// false whenever `setup` opened the browser for anybody else. `why` carries the
// caller's reason; the URL is printed on both branches, always, because opening a
// browser can fail in ways this process cannot see.
export async function runDeviceFlow(apiUrl: string, autoOpen = false, why?: string, nextStep?: string): Promise<DeviceFlowResult> {
  const startRes = await startDeviceFlow(apiUrl);
  checkRateLimit(startRes);
  if (!startRes.ok) throw new Error('Failed to start auth flow. Is the DeerDawn API reachable?');
  const start = await startRes.json() as DeviceFlowStart;

  savePendingAuth({
    verification_url: start.verification_url,
    device_code: start.device_code,
    expires_at: start.expires_at,
  });

  if (autoOpen) {
    console.error(`\nDeerDawn: ${why ? `${why} — ` : ''}opening your browser to sign in.\n   If it does not open, use this link: ${start.verification_url}\n   (also saved to ~/.deerdawn/pending-auth.json)\n`);
    openBrowser(start.verification_url);
  } else {
    console.error(`\nDeerDawn: sign in to activate session memory.\n   Open in your browser: ${start.verification_url}\n   (URL also saved to ~/.deerdawn/pending-auth.json)\n`);
  }
  // stderr only (above) — stdout is reserved for JSON-RPC frames when running as
  // an MCP stdio server; GUI hosts surface the URL via the get_auth_status tool.

  const apiKey = await poll(apiUrl, start.device_code, pollIntervalMs(start), pollWindowMs(start));

  const saved = saveApiKey(apiKey);
  announceAuthorized(saved, nextStep);
  return { apiKey, saved };
}

/**
 * A sign-in link for the PERSON, from a process that cannot wait for them: the
 * SessionStart hook, which has a few seconds and then exits.
 *
 * The hook used to answer "not signed in" by telling the MODEL it must call
 * start_session, a call that could not succeed and that the person never saw.
 * The link is what the person needs, so the hook shows it to them (systemMessage)
 * and this is where it comes from:
 *   - a fresh link already saved (the MCP server's own boot flow, a previous
 *     hook, get_auth_status) is reused: somebody is already listening for it;
 *   - otherwise a new flow is started, saved to pending-auth.json (so a server
 *     that boots after this resumes the SAME code instead of minting a second),
 *     and a detached `await-sign-in` process is left listening, because a code
 *     nobody polls is a sign-in that completes in the browser and reaches no one.
 * null when no link can be had inside `timeoutMs`; the hook then says so plainly.
 */
export async function startDetachedSignIn(
  apiUrl: string,
  options: { timeoutMs?: number; spawnListener?: (() => void) | null } = {},
): Promise<string | null> {
  const pending = loadPendingAuth();
  if (pending?.verification_url && !pending.error_message && isPendingAuthFresh(pending)) {
    return pending.verification_url;
  }
  try {
    const res = await startDeviceFlow(apiUrl, options.timeoutMs ?? 3000);
    if (!res.ok) return null;
    const start = await res.json() as DeviceFlowStart;
    if (!start?.verification_url || !start.device_code) return null;
    savePendingAuth({ verification_url: start.verification_url, device_code: start.device_code, expires_at: start.expires_at });
    const listen = options.spawnListener === undefined ? () => spawnSignInListener(apiUrl) : options.spawnListener;
    try { listen?.(); } catch { /* the link still works; the next server start resumes it */ }
    return start.verification_url;
  } catch {
    return null;
  }
}

/** Leave `deerdawn-mcp await-sign-in` running after this process exits. */
function spawnSignInListener(apiUrl: string): void {
  const entry = process.argv[1];
  if (!entry) return;
  const child = spawn(process.execPath, [entry, 'await-sign-in'], {
    detached: true,
    stdio: 'ignore',
    // The same API the flow was started against, whichever way it was chosen.
    env: { ...process.env, DEERDAWN_API_URL: apiUrl },
  });
  child.unref();
}

/**
 * `deerdawn-mcp await-sign-in`: poll the saved sign-in to completion and store
 * the key. The listener startDetachedSignIn leaves behind. Resolves false when
 * there is nothing fresh to wait for, or the window closed.
 */
export async function awaitPendingSignIn(apiUrl: string): Promise<boolean> {
  const pending = loadPendingAuth();
  if (!pending?.device_code || pending.error_message || !isPendingAuthFresh(pending)) return false;
  try {
    await resumeDeviceFlow(apiUrl, pending.device_code, pending.verification_url ?? '', pending.expires_at);
    return true;
  } catch {
    return false;
  }
}
