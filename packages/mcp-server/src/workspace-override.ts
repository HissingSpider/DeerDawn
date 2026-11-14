/**
 * Which workspace this install is working in, when it is not the one its key
 * was minted for.
 *
 * API keys are workspace credentials: keys.js mints them against the workspace
 * the person was in at the time, and a key then resolves to that workspace on
 * every later request. That is deliberate — accepting an invite must not
 * silently move somebody's existing personal key into a team. It leaves one
 * cohort with no route in at all: a teammate whose local install predates their
 * invite holds a key minted for their personal workspace, this package sent no
 * workspace header, and so their agent loop could never reach the team's
 * projects no matter how many times they were invited.
 *
 * The API admits `x-deerdawn-workspace` for any credential whose person is an
 * active member of the named workspace: membership is re-checked on every
 * request and scopes are capped to the role held there (middleware/auth.js,
 * bindWorkspace). A workspace the actor is not in is REFUSED, never silently
 * swapped for their own.
 *
 * So the value here is an IDENTIFIER, not a credential — which is why it can
 * live in the repo-committable .mcp.json that `GET /teams/workspace-config`
 * hands a team, beside the API URL and next to no key at all.
 *
 * TWO SOURCES, BECAUSE A HOOK IS NOT THE SERVER. The committed .mcp.json
 * delivers the value in the server entry's `env` block, and the host applies
 * that block to the MCP SERVER PROCESS ONLY. Claude Code spawns a hook with the
 * base environment plus CLAUDE_PROJECT_DIR, and an MCP server with the base
 * environment plus CLAUDE_PROJECT_DIR, CLAUDE_CODE_SESSION_ID, CLAUDECODE and
 * the entry's own `env` — so `flush-session` and `session-context`, which are
 * separate processes, never see the variable at all. Reading only process.env
 * therefore split one install in two: the server talked to the team while the
 * Stop hook POSTed the team repo's transcript with no header (binding it to the
 * key's personal workspace, where it may auto-create a project) and SessionStart
 * injected the PERSONAL brief as "Auto-loaded" into a session whose
 * start_session had just promised everything belonged to the team.
 *
 * So the file is read directly as a second source, below the environment. It is
 * the same file, read the same way the host would have read it; the environment
 * still wins, because that is what the host was actually told to pass.
 *
 * Only .mcp.json. Codex registers in ~/.codex/config.toml and Cursor in its own
 * file, and neither is written with a DEERDAWN_WORKSPACE block by anything in
 * this package (formatCodexMcpTomlConfig carries the API URL and the key, and
 * nothing else), so there is nothing there to read yet.
 *
 * DEVICE FLOW: deliberately not sent on /api/v1/auth/mcp/start or /token. Both
 * are unauthenticated (they present a device code and nothing else) and the key
 * is minted at APPROVE time, in the dashboard, stamped with the workspace the
 * approving person is active in — `workspace.defaultOwnerKey(req.actor)` in
 * routes/shared/mcp-auth.js. Approve-time binding wins; a header on those two
 * calls would be read by nobody. The header at USE time is what carries an
 * existing key into the team, and it is enough.
 */

import fs from 'fs';
import path from 'path';

type WorkspaceEnv = Record<string, string | undefined>;

/** Where the answer came from, for anything that has to describe it. */
export type WorkspaceSource = 'env' | 'project-config';

export interface WorkspaceLookup {
  /** Where DEERDAWN_WORKSPACE is read from. Defaults to process.env. */
  env?: WorkspaceEnv;
  /**
   * Where to start looking for the project's .mcp.json. Defaults to
   * CLAUDE_PROJECT_DIR, then the current directory. Pass `null` to consult no
   * file at all — which is what a unit test of the VALUE wants, and the only
   * way to ask this module a question that touches no disk.
   */
  projectDir?: string | null;
}

export interface ResolvedWorkspace {
  workspace: string | null;
  source: WorkspaceSource | null;
  /** The .mcp.json the value came from, for a message that has to be checkable. */
  configPath: string | null;
}

/** Long enough for an org id or a slug, short enough that nothing else fits. */
const MAX_WORKSPACE_KEY_LENGTH = 200;

/**
 * How far up to look for the repo's .mcp.json. Bounded for the same reason
 * detectClaudeCodeServerKinds bounds its walk: a hook runs on every turn and a
 * symlink loop or a deep path must never turn that into an unbounded stat walk.
 */
const MAX_WALK_DEPTH = 12;

/**
 * Whitespace and control characters: an HTTP client rejects a header value
 * carrying either before any request leaves. Checked by code point rather than
 * by a character class, so the control range stays readable and the linter's
 * no-control-regex rule stays on.
 */
function isImplausible(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

export const WORKSPACE_HEADER = 'x-deerdawn-workspace';

let warnedAboutValue = false;

/**
 * Trimmed, because a value pasted into a config file carries whatever came with
 * it. Validated, because an implausible one would otherwise go out in a header
 * and be rejected by the HTTP client before any request left — which looks like
 * an outage rather than a typo. Never logged: the value is an identifier, but a
 * malformed one is whatever somebody actually put there.
 */
function sanitize(raw: unknown, where: string): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  if (value.length > MAX_WORKSPACE_KEY_LENGTH || isImplausible(value)) {
    if (!warnedAboutValue) {
      warnedAboutValue = true;
      // stderr only — stdout carries JSON-RPC frames exclusively on the stdio
      // path, and a hook's stdout is the host's payload channel. Says what was
      // wrong with it, never what it was.
      console.error(`[DeerDawn] Ignoring the workspace key in ${where}: it is not a plausible workspace key (whitespace, control characters, or too long). Copy it from your team's .mcp.json.`);
    }
    return null;
  }
  return value;
}

/** Is this `mcpServers` entry ours? Name, or the package the command runs. */
function isDeerdawnServerEntry(name: string, entry: Record<string, unknown>): boolean {
  if (/deerdawn/i.test(name)) return true;
  const command = typeof entry.command === 'string' ? entry.command : '';
  const args = Array.isArray(entry.args)
    ? entry.args.filter((arg): arg is string => typeof arg === 'string')
    : [];
  return /@deerdawn\/mcp-server/.test([command, ...args].join(' '));
}

/**
 * The `env` blocks of every DeerDawn entry in one `mcpServers` map, in order.
 *
 * Tolerates everything: a map that is missing or not an object, an entry that
 * is somebody else's server, an `env` that is not an object. A hook may never
 * fail the host over a config file it merely happened to look at.
 */
export function deerdawnServerEnvBlocks(servers: unknown): Array<Record<string, unknown>> {
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];
  const blocks: Array<Record<string, unknown>> = [];
  for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (!isDeerdawnServerEntry(name, record)) continue;
    const env = record.env;
    if (!env || typeof env !== 'object' || Array.isArray(env)) continue;
    blocks.push(env as Record<string, unknown>);
  }
  return blocks;
}

/** One .mcp.json's `mcpServers`, or undefined for a file that is absent or not JSON. */
function mcpServersIn(file: string): unknown {
  try {
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: unknown } | null)?.mcpServers;
  } catch {
    return undefined;
  }
}

/**
 * Walk up from the session's directory to the repo root, reading .mcp.json,
 * and return the first value `pick` accepts from a DeerDawn entry's `env`.
 *
 * The committed file sits at the repo root and the session is usually somewhere
 * below it, so the walk has to go up. It stops at the first directory holding a
 * `.git` — a .mcp.json ABOVE a checkout belongs to whatever else lives up there,
 * and adopting a stranger's workspace key (or API key) is the failure this whole
 * module is about. Same shape and the same ceiling as detectClaudeCodeServerKinds.
 *
 * Shared by the workspace lookup below and by hook-api-key.ts, so the two
 * answers a hook needs about "this repo" come from the same file by one rule.
 */
export function findInProjectMcpJson<T>(
  startDir: string,
  pick: (env: Record<string, unknown>, file: string) => T | null,
): { value: T; configPath: string } | null {
  let dir: string;
  try {
    dir = path.resolve(startDir);
  } catch {
    return null;
  }
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
    const file = path.join(dir, '.mcp.json');
    for (const env of deerdawnServerEnvBlocks(mcpServersIn(file))) {
      const found = pick(env, file);
      if (found !== null && found !== undefined) return { value: found, configPath: file };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    let atRepoRoot = false;
    try { atRepoRoot = fs.existsSync(path.join(dir, '.git')); } catch { /* unreadable */ }
    if (atRepoRoot) break;
    dir = parent;
  }
  return null;
}

function workspaceFromProjectConfig(startDir: string): { workspace: string; configPath: string } | null {
  const found = findInProjectMcpJson(startDir, (env, file) => sanitize(env.DEERDAWN_WORKSPACE, file));
  return found ? { workspace: found.value, configPath: found.configPath } : null;
}

/**
 * Where the session is, for the walk above.
 *
 * CLAUDE_PROJECT_DIR first: the host exports it to hooks AND to MCP servers,
 * and it is the project ROOT, where a session may have `cd`-ed away from. The
 * Stop hook additionally receives a `cwd` on its stdin and passes it in
 * explicitly (see flush-session), which is why that argument exists.
 */
function defaultProjectDir(env: WorkspaceEnv): string {
  const fromHost = env.CLAUDE_PROJECT_DIR;
  if (typeof fromHost === 'string' && fromHost.trim()) return fromHost.trim();
  try {
    return process.cwd();
  } catch {
    return '.';
  }
}

/**
 * The workspace to target, where it came from, and the file if it was a file.
 *
 * ONE resolver, used by the server and by every hook, so a split like the one
 * this replaced cannot happen again by leaving a call site behind. Nothing is
 * cached across processes: a hook is a fresh process every turn, and a stale
 * answer here is a write in the wrong workspace.
 */
export function resolveWorkspace(lookup: WorkspaceLookup = {}): ResolvedWorkspace {
  const env = lookup.env ?? process.env;
  const fromEnv = sanitize(env.DEERDAWN_WORKSPACE, 'DEERDAWN_WORKSPACE');
  if (fromEnv) return { workspace: fromEnv, source: 'env', configPath: null };

  // `null` means "ask no file" — an explicit choice, not a missing argument.
  if (lookup.projectDir === null) return { workspace: null, source: null, configPath: null };

  const startDir = lookup.projectDir ?? defaultProjectDir(env);
  const fromFile = workspaceFromProjectConfig(startDir);
  if (fromFile) return { workspace: fromFile.workspace, source: 'project-config', configPath: fromFile.configPath };
  return { workspace: null, source: null, configPath: null };
}

/** The workspace to target, or null. */
export function workspaceOverride(lookup: WorkspaceLookup = {}): string | null {
  return resolveWorkspace(lookup).workspace;
}

/** Spread into any request's headers. Empty when no workspace is configured. */
export function workspaceHeaders(lookup: WorkspaceLookup = {}): Record<string, string> {
  const workspace = workspaceOverride(lookup);
  return workspace ? { [WORKSPACE_HEADER]: workspace } : {};
}

/** How the workspace was configured, in words somebody can go and check. */
export function describeWorkspaceSource(source: WorkspaceSource | null, configPath: string | null): string {
  if (source === 'project-config') return configPath ? `this repo's ${path.basename(configPath)}` : 'this repo\'s .mcp.json';
  return 'DEERDAWN_WORKSPACE';
}

/**
 * The refusals that mean THE WORKSPACE is closed to this key.
 *
 * `workspace_forbidden` is not a member. `subscription_inactive` and
 * `workspace_inactive` are a workspace that stopped paying — the first as a 403
 * on the request, the second as a 409 on a write. `lockdown_active` is the same
 * shape one gate over. None of the four is a bad request and none is an outage,
 * and each has a different fix, so they must not share one sentence.
 */
export const WORKSPACE_CLOSURE_CODES = ['workspace_forbidden', 'subscription_inactive', 'workspace_inactive', 'lockdown_active'] as const;
export type WorkspaceClosureCode = typeof WORKSPACE_CLOSURE_CODES[number];

export function isWorkspaceClosureCode(code: unknown): code is WorkspaceClosureCode {
  return typeof code === 'string' && (WORKSPACE_CLOSURE_CODES as readonly string[]).includes(code);
}

/** "…or stop targeting it", in the words of wherever the value actually is. */
function howToStopTargeting(source: WorkspaceSource | null, configPath: string | null): string {
  return source === 'project-config'
    ? `remove DEERDAWN_WORKSPACE from the deerdawn entry in ${configPath ?? '.mcp.json'}`
    : 'remove DEERDAWN_WORKSPACE from your MCP server config';
}

/**
 * What to say when the API refuses the workspace this install targets.
 *
 * The generic "Access forbidden. Insufficient permissions." reads like a broken
 * credential and sends people to sign in again, which cannot help — and
 * "Conflicts with something that already exists", which is what an unlisted 409
 * became, is not even true: nothing was created and nothing conflicts. Falling
 * back to the personal workspace silently would be worse than either, because
 * the session would then quietly read and write the wrong place.
 */
export function describeWorkspaceClosure(
  workspace: string,
  code: WorkspaceClosureCode,
  source: WorkspaceSource | null = null,
  configPath: string | null = null,
): string {
  const where = describeWorkspaceSource(source, configPath);
  const stop = howToStopTargeting(source, configPath);
  if (code === 'workspace_forbidden') {
    return `This machine's DeerDawn key is not a member of the workspace "${workspace}" set in ${where}, so the request was refused. `
      + `Nothing was read or written. Accept the invite to that workspace with the account this key belongs to, or ${stop} `
      + 'to work in your own workspace.';
  }
  if (code === 'lockdown_active') {
    return `The workspace "${workspace}" set in ${where} is locked down, so the request was refused. `
      + `Nothing was read or written. Ask a workspace owner to lift the lockdown, or ${stop} to work in your own workspace.`;
  }
  return `The subscription for the workspace "${workspace}" set in ${where} is inactive, so the request was refused. `
    + `Nothing was read or written. Ask a workspace owner to update billing, or ${stop} to work in your own workspace.`;
}

/** Kept for the call sites that only ever see the membership refusal. */
export function describeWorkspaceRefusal(workspace: string, source: WorkspaceSource | null = null, configPath: string | null = null): string {
  return describeWorkspaceClosure(workspace, 'workspace_forbidden', source, configPath);
}

/**
 * The one line a HOOK may print about a closed workspace.
 *
 * session-context's stdout goes straight into the model's context as the
 * session's opening brief, so the alternative to this sentence is not silence —
 * it is the PERSONAL brief, delivered under a header that says "Auto-loaded",
 * in a repo that asked for somebody else's workspace. One true line beats a
 * brief from the wrong place.
 */
export function describeHookWorkspaceRefusal(workspace: string, code: WorkspaceClosureCode): string {
  const tail = 'No brief was loaded, and nothing was read from your personal workspace instead.';
  if (code === 'workspace_forbidden') {
    return `[DeerDawn] This repo targets the workspace "${workspace}" but this machine's key is not a member of it. ${tail} `
      + 'Accept the invite with the account this key belongs to, or remove DEERDAWN_WORKSPACE from the deerdawn entry in .mcp.json.';
  }
  if (code === 'lockdown_active') {
    return `[DeerDawn] This repo targets the workspace "${workspace}", which is locked down. ${tail} `
      + 'Ask a workspace owner to lift the lockdown, or remove DEERDAWN_WORKSPACE from the deerdawn entry in .mcp.json.';
  }
  return `[DeerDawn] This repo targets the workspace "${workspace}", whose subscription is not active. ${tail} `
    + 'Ask a workspace owner to update billing, or remove DEERDAWN_WORKSPACE from the deerdawn entry in .mcp.json.';
}

// Said once per process, at the first session start, and never again: repeating
// it every session is noise, and never saying it is how somebody spends an
// afternoon writing into a workspace they did not mean to be in.
let workspaceNoticeSaid = false;

export function consumeWorkspaceOverrideNotice(lookup: WorkspaceLookup = {}): string | null {
  if (workspaceNoticeSaid) return null;
  const { workspace, source, configPath } = resolveWorkspace(lookup);
  if (!workspace) return null;
  workspaceNoticeSaid = true;
  return `[DeerDawn] Working in the shared workspace "${workspace}" (from ${describeWorkspaceSource(source, configPath)}). `
    + 'Everything this session reads and writes belongs to that workspace, not to your personal one, '
    + 'including the end-of-session flush and the brief the SessionStart hook loads.';
}

/** Test seam. Nothing in the server calls this. */
export function resetWorkspaceOverrideState(): void {
  warnedAboutValue = false;
  workspaceNoticeSaid = false;
}
