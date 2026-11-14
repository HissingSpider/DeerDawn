// The instruction block DeerDawn writes into the user's OWN files
// (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md), fitted to the server that will
// actually answer the calls it names.
//
// This is the ON-DISK surface only. The MCP `instructions` field on the wire is a
// different module (shared-context/src/mcpInstructions.js) held to a different
// rule, and the two must stay apart — see the note at the top of
// shared-context/src/deerdawnInstructions.js. Nothing here is imported by, or
// imports, the wire text.
//
// WHY THE BLOCK DEPENDS ON THE SERVER. `setup` (and every boot of the stdio
// server) writes one block, and that block was written for one catalog: the
// local stdio server's. But the person running setup may have registered the
// HOSTED endpoint instead — `claude mcp add --transport http deerdawn
// https://api.deerdawn.com/mcp/claude` — and the hosted catalogs are not the
// local one:
//   - /mcp/claude splits the task board in two: `read_tasks` lists it and
//     `manage_tasks` only changes it. Its schema has no `list` action, and an
//     argument outside the schema is rejected before the handler runs.
//   - neither hosted catalog has `manage_memory(action:"import_local")`. The
//     hosted server has no filesystem to import from.
// So the block told the model, in the user's own voice, at the top of every
// session, to make two calls that server refuses. A standing instruction that
// fails every time is worse than none: it teaches the agent the tool is broken.
//
// The fix is not a second hard-coded block. It is one rule: EVERY CALL THE BLOCK
// NAMES MUST EXIST IN EVERY CATALOG THE BLOCK WILL BE READ AGAINST. When more
// than one kind of server is registered (a hosted connector in one repo, the
// stdio server in another, one global CLAUDE.md over both) the block names only
// what they all share, and falls back to describing the intent without naming a
// call. tests/on-disk-instructions-catalog.test.ts parses the block and checks
// each named call against the catalog for that kind.

import fs from 'fs';
import path from 'path';
import {
  OPEN_MARKER,
  CLOSE_MARKER,
  openMarkerFor,
  closeMarkerFor,
  isBlockToken,
  buildDeerdawnInstructionLines,
} from '../../shared-context/src/deerdawnInstructions.js';
import * as setupStatus from '../../shared-context/src/setup-status.js';

// setup-status.js is CommonJS, and its declaration shim
// (types/shared-context-setup-status.d.ts) names only what older callers use,
// so the part read here is typed at the point of use, and read at call time.
const codexConfigReader = setupStatus as unknown as {
  readCodexConfig(home: string): { entries: Array<[string, unknown, string]> };
};

/** Which catalog answers: the stdio server, hosted `/mcp`, or hosted `/mcp/claude`. */
export type DeerdawnServerKind = 'local' | 'hosted' | 'hosted_claude';

// What differs between the catalogs, as far as the block is concerned. The
// authoritative hosted catalog is the TOOLS array (and CLAUDE_MANAGE_TASKS_TOOL)
// in apps/api/src/routes/mcp.js; the local one is src/tools.
const SUPPORTS: Record<DeerdawnServerKind, { taskListAction: boolean; readTasksTool: boolean; importLocal: boolean }> = {
  local: { taskListAction: true, readTasksTool: false, importLocal: true },
  // readTasksTool is about tools/list, not dispatch: /mcp still EXECUTES
  // read_tasks (tools/call resolves against the whole TOOLS array) but does not
  // advertise it (ADVERTISED_TOOL_NAMES in mcp.js), and a model can only call
  // what it was shown. With /mcp and /mcp/claude both registered, the block
  // named read_tasks to a server whose tools/list does not carry it.
  hosted: { taskListAction: true, readTasksTool: false, importLocal: false },
  hosted_claude: { taskListAction: false, readTasksTool: true, importLocal: false },
};

const BOARD_COLUMNS = 'Backlog, Blocked, In Progress, Integration, Testing, and Done';

function taskBoardLine(kinds: DeerdawnServerKind[]): string {
  const track = `Track work with \`manage_tasks\`: add cards and move them across ${BOARD_COLUMNS}.`;
  if (kinds.every((kind) => SUPPORTS[kind].taskListAction)) {
    return `${track} Use \`action:"list"\` to read the board instead of keeping an ad hoc list.`;
  }
  if (kinds.every((kind) => SUPPORTS[kind].readTasksTool)) {
    return `${track} Read the board with \`read_tasks\` instead of keeping an ad hoc list.`;
  }
  // Registered servers disagree about HOW the board is read, so no call is named.
  return `${track} Read the board from DeerDawn instead of keeping an ad hoc list.`;
}

function closingLine(kinds: DeerdawnServerKind[]): string {
  const finish = '`manage_memory(action:"finish_task", complete_task:true, confirm_complete:true)` when the task is done';
  if (kinds.every((kind) => SUPPORTS[kind].importLocal)) {
    return `Use \`recall(action:"entities")\` for architecture and decisions, \`manage_memory(action:"import_local")\` on a first local open with no context, and ${finish}.`;
  }
  return `Use \`recall(action:"entities")\` for architecture and decisions, and ${finish}.`;
}

function normalizeKinds(kinds: DeerdawnServerKind | DeerdawnServerKind[] | null | undefined): DeerdawnServerKind[] {
  const list = (Array.isArray(kinds) ? kinds : kinds ? [kinds] : []).filter((kind) => kind in SUPPORTS);
  // Nothing registered that we can see means the stdio server: it is what is
  // running this code, or what setup is about to register.
  return list.length ? [...new Set(list)] : ['local'];
}

/**
 * The shared lines, with the two that name catalog-specific calls rewritten for
 * the server kind(s) in play. Every other line is the shared text, untouched, so
 * wording changes keep flowing from shared-context; the two are found by what
 * they mention rather than by position, so a reordering there cannot leave a
 * local-only call in a hosted block unnoticed (and the catalog test would say so).
 */
export function buildOnDiskInstructionLines(kinds?: DeerdawnServerKind | DeerdawnServerKind[] | null): string[] {
  const list = normalizeKinds(kinds);
  return buildDeerdawnInstructionLines().map((line) => {
    if (line.includes('import_local')) return closingLine(list);
    if (line.includes('`manage_tasks`')) return taskBoardLine(list);
    return line;
  });
}

/**
 * The block a writer puts in a person's file. `token` is this install's block
 * token (getBlockToken in setup-status.js): with it the block carries the markers
 * only this install recognises as its own, and the opening marker, the block's
 * first line, says edits inside are replaced. Without one it carries the legacy
 * markers older versions wrote, which no writer uses any more.
 */
export function buildOnDiskInstructionBlock(kinds?: DeerdawnServerKind | DeerdawnServerKind[] | null, token?: string | null): string {
  const [open, close] = isBlockToken(token) ? [openMarkerFor(token), closeMarkerFor(token)] : [OPEN_MARKER, CLOSE_MARKER];
  return [open, ...buildOnDiskInstructionLines(kinds), close, ''].join('\n');
}

/** May the copy around setup tell somebody to run the local import? */
export function supportsLocalImport(kinds: DeerdawnServerKind[]): boolean {
  return normalizeKinds(kinds).every((kind) => SUPPORTS[kind].importLocal);
}

// ─── Which server is registered ──────────────────────────────────────────────

function looksLikeDeerdawn(name: string, entry: Record<string, unknown>): boolean {
  if (/deerdawn/i.test(name)) return true;
  const haystack = [entry.url, entry.command, ...(Array.isArray(entry.args) ? entry.args : [])]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
  return /deerdawn/i.test(haystack);
}

/**
 * One `mcpServers` entry -> the catalog it reaches, or null when it is not ours.
 *
 * A URL is a hosted endpoint, and the PATH decides which catalog: `/mcp/claude`
 * is the split task board, anything else is the default. A command is the stdio
 * server. Trailing slashes and the legacy `/api/v1/mcp` alias are tolerated; a
 * URL that cannot be parsed is treated as the default hosted catalog, because it
 * is certainly not local.
 */
export function classifyMcpServerEntry(name: string, entry: unknown): DeerdawnServerKind | null {
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  if (!looksLikeDeerdawn(name, record)) return null;
  if (typeof record.url === 'string' && record.url) {
    let pathname = '';
    try { pathname = new URL(record.url).pathname; } catch { pathname = record.url; }
    return /\/mcp\/claude\/?$/.test(pathname) ? 'hosted_claude' : 'hosted';
  }
  if (typeof record.command === 'string' && record.command) return 'local';
  return null;
}

function kindsInServers(servers: unknown, out: Set<DeerdawnServerKind>): void {
  if (!servers || typeof servers !== 'object') return;
  for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
    const kind = classifyMcpServerEntry(name, entry);
    if (kind) out.add(kind);
  }
}

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Every kind of DeerDawn server Claude Code has registered, for a block that
 * lives in ONE global file (~/.claude/CLAUDE.md) read in every repo.
 *
 * `claude mcp add` stores a server in one of three places, and all three count:
 * user scope (top-level `mcpServers` in ~/.claude.json), local scope (the same
 * file, under `projects[<dir>]` — the default when no `-s` is given), and project
 * scope (a committed `.mcp.json`). Every project entry is read, not only the
 * current directory's: the file being written is global, so which repo happened
 * to run setup last must not decide what the other repos are told.
 */
export function detectClaudeCodeServerKinds(home: string, cwd?: string | null): DeerdawnServerKind[] {
  const found = new Set<DeerdawnServerKind>();
  const config = readJson(path.join(home, '.claude.json'));
  kindsInServers(config?.mcpServers, found);
  if (config?.projects && typeof config.projects === 'object') {
    for (const project of Object.values(config.projects as Record<string, any>)) kindsInServers(project?.mcpServers, found);
  }
  if (cwd) {
    // The committed file sits at the repo root; walk up to it, bounded.
    let dir = path.resolve(cwd);
    for (let depth = 0; depth < 12; depth += 1) {
      kindsInServers(readJson(path.join(dir, '.mcp.json'))?.mcpServers, found);
      const parent = path.dirname(dir);
      if (parent === dir || fs.existsSync(path.join(dir, '.git'))) break;
      dir = parent;
    }
  }
  return [...found];
}

/**
 * The same question for Codex, whose registrations live in config.toml under
 * `mcp_servers`, in $CODEX_HOME when that is set and ~/.codex otherwise. The
 * file is read as TOML by readCodexConfig in shared-context's setup-status.js,
 * the same reader get_setup_status and apply_setup use, so a table, an inline
 * table and dotted keys all count, and the three can never disagree about
 * whether Codex is connected. It used to scan for `[mcp_servers.<name>]` header
 * lines, which missed a registration codex 0.154 lists as enabled. A file that
 * does not parse registers nothing: Codex cannot load it either.
 */
export function detectCodexServerKinds(home: string): DeerdawnServerKind[] {
  const found = new Set<DeerdawnServerKind>();
  for (const [name, entry] of codexConfigReader.readCodexConfig(home).entries) {
    const kind = classifyMcpServerEntry(name, entry);
    if (kind) found.add(kind);
  }
  return [...found];
}
