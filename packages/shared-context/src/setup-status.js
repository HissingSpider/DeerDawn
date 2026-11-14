const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  OPEN_MARKER,
  CLOSE_MARKER,
  isBlockToken,
  ownedMarkersFor,
  buildDeerdawnInstructionBlock,
} = require('./deerdawnInstructions.js');
const {
  buildMcpServerConfigObject,
  formatCodexMcpTomlConfig,
  SetupApplyResultSchema,
  SetupStatusResultSchema,
} = require('./index.js');

function getHomeDir() {
  return process.env.DEERDAWN_HOME_DIR || os.homedir();
}

function getDeerDawnDir() {
  return process.env.DEERDAWN_DIR || path.join(getHomeDir(), '.deerdawn');
}

function getCredentialsPath() {
  return path.join(getDeerDawnDir(), 'credentials.json');
}

function getPendingAuthPath() {
  return path.join(getDeerDawnDir(), 'pending-auth.json');
}

function getBackupDir() {
  return path.join(getDeerDawnDir(), 'setup-backups');
}

function getRuntimeSurfacesPath() {
  return path.join(getDeerDawnDir(), 'runtime-surfaces.json');
}

function getRuntimeStaleMs() {
  const raw = Number(process.env.DEERDAWN_RUNTIME_STALE_MS || 1000 * 60 * 60 * 12);
  return Number.isFinite(raw) && raw > 0 ? raw : 1000 * 60 * 60 * 12;
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function hasDeerDawnInstruction(text) {
  const normalized = String(text || '').toLowerCase();
  return normalized.includes('deerdawn') && normalized.includes('start_session');
}

// ─── Is DeerDawn registered where the tool reads its servers? ────────────────
//
// A tool is connected when ITS OWN config registers a DeerDawn server it can
// start or reach (for Codex and Cursor, also when this very server is running
// inside it: see RUNNING_COUNTS_FOR), and not otherwise. The instruction block
// DeerDawn writes into a tool's global instructions (AGENTS.md, CLAUDE.md, a
// Cursor rule) used to
// count as the connection too, so apply_setup(codex) answered
// already_configured on a machine whose ~/.codex/config.toml had no DeerDawn
// server at all, and skipped the one write that would have added it. Claude
// Code was counted from an `mcpServers` entry in ~/.claude/settings.json, a file
// it does not read servers from.
//
// "Ours" and "runnable" follow classifyMcpServerEntry in
// packages/mcp-server/src/on-disk-instructions.ts, which is what decides whether
// a tool is given the block at all. The two must agree, or a tool is called
// connected with no instructions, or instructed with no connection:
// packages/mcp-server/tests/instructions-need-a-registration.test.ts holds them
// together.

// Reported in degraded_reason when a tool's instruction file carries DeerDawn's
// instructions but its config registers no DeerDawn server.
const INSTRUCTIONS_WITHOUT_SERVER = 'instructions_without_mcp_server';

function looksLikeDeerDawnServer(name, entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (/deerdawn/i.test(String(name))) return true;
  const haystack = [entry.url, entry.command, ...(Array.isArray(entry.args) ? entry.args : [])]
    .filter((part) => typeof part === 'string')
    .join(' ');
  return /deerdawn/i.test(haystack);
}

function isRunnableServerEntry(entry) {
  return Boolean((typeof entry.url === 'string' && entry.url) || (typeof entry.command === 'string' && entry.command));
}

/**
 * Over [name, entry, source] triples: `found` when any entry is DeerDawn's,
 * `valid` when one of those can actually run, and `source` = the file it is in.
 */
function registrationIn(entries) {
  const ours = entries.filter(([name, entry]) => looksLikeDeerDawnServer(name, entry));
  const runnable = ours.find(([, entry]) => isRunnableServerEntry(entry));
  return { found: ours.length > 0, valid: Boolean(runnable), source: runnable ? runnable[2] : null };
}

function jsonServerEntries(servers, source) {
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];
  return Object.entries(servers).map(([name, entry]) => [name, entry, source]);
}

// ─── Codex's config.toml, read as TOML ───────────────────────────────────────
//
// Codex takes a server registered in any form TOML allows: the
// `[mcp_servers.deerdawn]` table `codex mcp add` writes, an inline table under
// `[mcp_servers]` (`deerdawn = { url = "..." }`), dotted keys
// (`mcp_servers.deerdawn.url = "..."`), a top-level inline `mcp_servers`.
// codex-cli 0.154 lists every one of them as enabled. This file used to scan for
// `[mcp_servers.<name>]` header lines, so the other forms read as "not
// connected", and apply_setup appended a second `[mcp_servers.deerdawn]` table:
// a duplicate key, on which Codex refuses the WHOLE file and every server the
// person had in it stops.
//
// No TOML parser is a dependency of either package, and one would ship to every
// install for this one read, so this is a small reader of the whole language
// (TOML 1.0, plus the 1.1 relaxations codex's parser accepts: newlines and a
// trailing comma in inline tables, `\e` and `\xHH`, seconds-less times). It
// follows codex where the two versions differ, and rejects what codex rejects
// that matters here: a key or table defined twice, a table extended after it
// was closed. A file it cannot read is reported as unparseable, never guessed at.

class TomlSyntaxError extends Error {
  constructor(message, line) {
    super(message);
    this.line = line;
  }
}

const isTomlTable = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const TOML_ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };
const TOML_BARE_KEY = /[A-Za-z0-9_-]+/y;
const TOML_DATETIME = /\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?/y;
const TOML_SPECIAL_FLOAT = /[+-]?(?:inf|nan)/y;
const TOML_RADIX_INT = /0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*/y;
const TOML_DECIMAL = /[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?/y;
const TOML_BOOLEAN = /true|false/y;
const TOML_VALUE_END = /[ \t\r\n,\]}#]/;

/**
 * Parse TOML text. `{ ok: true, value }`, or `{ ok: false, error, line }` for a
 * file codex would refuse. Dates and times are kept as their text.
 */
function parseToml(source) {
  const text = String(source ?? '');
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  // How each table came to exist decides what may extend it later:
  // implicit (a parent named by a [header]), header, dotted (made by a dotted
  // key, which a [header] may not redefine), inline (closed for good).
  const kinds = new Map();
  const tableArrays = new Set();
  // Without a prototype, so a key named __proto__ is just a key.
  const newTable = (kind) => {
    const table = Object.create(null);
    kinds.set(table, kind);
    return table;
  };
  const root = newTable('header');

  const lineAt = (at) => text.slice(0, at).split('\n').length;
  const fail = (message, at = pos) => { throw new TomlSyntaxError(message, lineAt(at)); };
  const matchAt = (pattern) => {
    pattern.lastIndex = pos;
    const found = pattern.exec(text);
    return found ? found[0] : null;
  };
  const skipSpaces = () => { while (text[pos] === ' ' || text[pos] === '\t') pos += 1; };
  const skipComment = () => {
    if (text[pos] !== '#') return;
    while (pos < text.length && text[pos] !== '\n' && !(text[pos] === '\r' && text[pos + 1] === '\n')) pos += 1;
  };
  const atNewline = () => text[pos] === '\n' || (text[pos] === '\r' && text[pos + 1] === '\n');
  const skipNewline = () => { pos += text[pos] === '\r' ? 2 : 1; };
  // Inside arrays and inline tables: whitespace, newlines and comments.
  const skipBlank = () => {
    for (;;) {
      skipSpaces();
      skipComment();
      if (!atNewline()) return;
      skipNewline();
    }
  };
  const endOfLine = () => {
    skipSpaces();
    skipComment();
    if (pos >= text.length) return;
    if (!atNewline()) fail(text[pos] === '\r' ? 'a carriage return must be followed by a newline' : 'expected the end of the line');
    skipNewline();
  };

  function readEscape(out) {
    const code = text[pos + 1];
    if (code in TOML_ESCAPES) {
      pos += 2;
      return out + TOML_ESCAPES[code];
    }
    const width = { u: 4, U: 8, x: 2 }[code];
    const hex = width ? text.slice(pos + 2, pos + 2 + width) : '';
    if (!width || !new RegExp(`^[0-9A-Fa-f]{${width}}$`).test(hex)) fail('invalid escape in a string');
    const point = Number.parseInt(hex, 16);
    if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) fail('invalid unicode escape in a string');
    pos += 2 + width;
    return out + String.fromCodePoint(point);
  }

  function readBasicString() {
    const start = pos;
    pos += 1;
    let out = '';
    for (;;) {
      const ch = text[pos];
      if (ch === undefined || ch === '\n' || ch === '\r') fail('unterminated string', start);
      if (ch === '"') { pos += 1; return out; }
      if (ch === '\\') { out = readEscape(out); continue; }
      out += ch;
      pos += 1;
    }
  }

  function readLiteralString() {
    const start = pos;
    const end = text.indexOf("'", pos + 1);
    const newline = text.slice(pos + 1, end === -1 ? text.length : end).search(/[\r\n]/);
    if (end === -1 || newline !== -1) fail('unterminated string', start);
    pos = end + 1;
    return text.slice(start + 1, end);
  }

  // Up to two quotes may sit against the closing delimiter and belong to the value.
  function closeMultiline(delimiter, out) {
    let extra = 0;
    while (extra < 2 && text[pos + 3 + extra] === delimiter[0]) extra += 1;
    pos += 3 + extra;
    return out + delimiter[0].repeat(extra);
  }

  function readMultilineBasic() {
    const start = pos;
    pos += 3;
    if (atNewline()) skipNewline();
    let out = '';
    for (;;) {
      if (pos >= text.length) fail('unterminated multi-line string', start);
      if (text.startsWith('"""', pos)) return closeMultiline('"""', out);
      if (text[pos] === '\\') {
        // A backslash ending a line trims the newline and the whitespace after it.
        const lineEnd = /[ \t]*\r?\n/y;
        lineEnd.lastIndex = pos + 1;
        if (lineEnd.exec(text)) {
          pos = lineEnd.lastIndex;
          while (/[ \t\r\n]/.test(text[pos] || '')) pos += 1;
          continue;
        }
        out = readEscape(out);
        continue;
      }
      out += text[pos];
      pos += 1;
    }
  }

  function readMultilineLiteral() {
    const start = pos;
    pos += 3;
    if (atNewline()) skipNewline();
    const end = text.indexOf("'''", pos);
    if (end === -1) fail('unterminated multi-line string', start);
    const out = text.slice(pos, end);
    pos = end;
    return closeMultiline("'''", out);
  }

  function readSimpleKey() {
    if (text[pos] === '"') return readBasicString();
    if (text[pos] === "'") return readLiteralString();
    const bare = matchAt(TOML_BARE_KEY);
    if (!bare) fail('expected a key');
    pos += bare.length;
    return bare;
  }

  function readKey() {
    const parts = [];
    for (;;) {
      skipSpaces();
      parts.push(readSimpleKey());
      skipSpaces();
      if (text[pos] !== '.') return parts;
      pos += 1;
    }
  }

  function readScalar() {
    const start = pos;
    const token = matchAt(TOML_DATETIME) ?? matchAt(TOML_SPECIAL_FLOAT) ?? matchAt(TOML_RADIX_INT) ?? matchAt(TOML_DECIMAL) ?? matchAt(TOML_BOOLEAN);
    if (!token) fail('expected a value');
    pos += token.length;
    if (pos < text.length && !TOML_VALUE_END.test(text[pos])) fail('invalid value', start);
    if (token === 'true' || token === 'false') return token === 'true';
    if (/^\d{4}-|^\d{2}:/.test(token)) return token;
    if (/inf$/.test(token)) return token.startsWith('-') ? -Infinity : Infinity;
    if (/nan$/.test(token)) return NaN;
    if (/^0[xob]/.test(token)) return Number.parseInt(token.slice(2).replace(/_/g, ''), { x: 16, o: 8, b: 2 }[token[1]]);
    return Number(token.replace(/_/g, ''));
  }

  function readArray() {
    pos += 1;
    const items = [];
    for (;;) {
      skipBlank();
      if (text[pos] === ']') { pos += 1; return items; }
      items.push(readValue());
      skipBlank();
      if (text[pos] === ',') { pos += 1; continue; }
      if (text[pos] === ']') { pos += 1; return items; }
      fail('expected , or ] in an array');
    }
  }

  function closeInline(table) {
    kinds.set(table, 'inline');
    for (const value of Object.values(table)) if (isTomlTable(value)) closeInline(value);
  }

  function readInlineTable() {
    pos += 1;
    // Open while it is being read, so its own dotted keys can build it.
    const table = newTable('dotted');
    skipBlank();
    if (text[pos] === '}') { pos += 1; closeInline(table); return table; }
    for (;;) {
      readKeyValue(table);
      skipBlank();
      if (text[pos] === ',') {
        pos += 1;
        skipBlank();
        if (text[pos] === '}') break;
        continue;
      }
      if (text[pos] === '}') break;
      fail('expected , or } in an inline table');
    }
    pos += 1;
    closeInline(table);
    return table;
  }

  function readValue() {
    if (text.startsWith('"""', pos)) return readMultilineBasic();
    if (text.startsWith("'''", pos)) return readMultilineLiteral();
    if (text[pos] === '"') return readBasicString();
    if (text[pos] === "'") return readLiteralString();
    if (text[pos] === '[') return readArray();
    if (text[pos] === '{') return readInlineTable();
    return readScalar();
  }

  function readKeyValue(table) {
    const start = pos;
    const parts = readKey();
    if (text[pos] !== '=') fail('expected = after a key');
    pos += 1;
    skipSpaces();
    const value = readValue();
    let target = table;
    for (const part of parts.slice(0, -1)) {
      if (!hasOwn(target, part)) {
        target[part] = newTable('dotted');
        target = target[part];
        continue;
      }
      const existing = target[part];
      if (!isTomlTable(existing) || kinds.get(existing) !== 'dotted') fail(`${parts.join('.')} extends a table or value defined elsewhere`, start);
      target = existing;
    }
    const last = parts[parts.length - 1];
    if (hasOwn(target, last)) fail(`${parts.join('.')} is defined more than once`, start);
    target[last] = value;
  }

  // Walk a [header]'s parent keys, making the missing ones as implicit tables.
  function descend(parts, start) {
    let table = root;
    for (const part of parts) {
      if (!hasOwn(table, part)) {
        table[part] = newTable('implicit');
        table = table[part];
        continue;
      }
      const existing = table[part];
      if (Array.isArray(existing) && tableArrays.has(existing)) table = existing[existing.length - 1];
      else if (isTomlTable(existing) && kinds.get(existing) !== 'inline') table = existing;
      else fail(`[${parts.join('.')}] extends a value that is not a table`, start);
    }
    return table;
  }

  function readTableHeader() {
    const start = pos;
    const isArray = text.startsWith('[[', pos);
    pos += isArray ? 2 : 1;
    const parts = readKey();
    const close = isArray ? ']]' : ']';
    if (!text.startsWith(close, pos)) fail(`expected ${close} to close the table header`, start);
    pos += close.length;
    const parent = descend(parts.slice(0, -1), start);
    const last = parts[parts.length - 1];
    const existing = hasOwn(parent, last) ? parent[last] : undefined;
    if (isArray) {
      if (existing === undefined) {
        const list = [];
        tableArrays.add(list);
        parent[last] = list;
      } else if (!(Array.isArray(existing) && tableArrays.has(existing))) {
        fail(`[[${parts.join('.')}]] is already defined as something else`, start);
      }
      const table = newTable('header');
      parent[last].push(table);
      return table;
    }
    if (existing === undefined) {
      parent[last] = newTable('header');
      return parent[last];
    }
    if (isTomlTable(existing) && kinds.get(existing) === 'implicit') {
      kinds.set(existing, 'header');
      return existing;
    }
    return fail(`[${parts.join('.')}] is defined more than once`, start);
  }

  try {
    let current = root;
    while (pos < text.length) {
      skipSpaces();
      if (pos >= text.length) break;
      if (text[pos] === '#' || atNewline()) { endOfLine(); continue; }
      if (text[pos] === '[') current = readTableHeader();
      else readKeyValue(current);
      endOfLine();
    }
    return { ok: true, value: root, error: null, line: null };
  } catch (err) {
    if (err instanceof TomlSyntaxError) return { ok: false, value: null, error: err.message, line: err.line };
    // Arrays and inline tables nested deeper than the stack: a file this cannot
    // read, said as one, rather than an exception out of get_setup_status.
    if (err instanceof RangeError) return { ok: false, value: null, error: 'values nested too deeply to read', line: lineAt(pos) };
    throw err;
  }
}

/** Where Codex keeps config.toml and its global AGENTS.md: $CODEX_HOME when set (codex-cli 0.154 reads both there), else ~/.codex. */
function codexHomeDir(home) {
  return process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(home, '.codex');
}

/**
 * Codex's config.toml, parsed: its path, its text ('' when absent), whether it
 * parsed (and where it did not), and every `mcp_servers` entry as
 * [name, entry, path] in whatever form it was written.
 */
function readCodexConfig(home) {
  const configPath = path.join(codexHomeDir(home), 'config.toml');
  let text = null;
  try { text = fs.readFileSync(configPath, 'utf8'); } catch { /* absent */ }
  if (text === null) return { path: configPath, exists: false, text: '', parsed: true, error: null, value: {}, entries: [] };
  const parsed = parseToml(text);
  if (!parsed.ok) return { path: configPath, exists: true, text, parsed: false, error: `line ${parsed.line}: ${parsed.error}`, value: null, entries: [] };
  const servers = parsed.value.mcp_servers;
  const entries = isTomlTable(servers) ? Object.entries(servers).map(([name, entry]) => [name, entry, configPath]) : [];
  return { path: configPath, exists: true, text, parsed: true, error: null, value: parsed.value, entries };
}

/** Every table path and value in a parsed file, for "does it still hold everything it held". */
function tomlLeaves(value, prefix = [], out = new Map()) {
  if (isTomlTable(value)) {
    if (prefix.length) out.set(JSON.stringify(prefix), '{table}');
    for (const [key, child] of Object.entries(value)) tomlLeaves(child, [...prefix, key], out);
  } else {
    out.set(JSON.stringify(prefix), JSON.stringify(value));
  }
  return out;
}

function keepsEveryKey(before, after) {
  const now = tomlLeaves(after);
  for (const [key, value] of tomlLeaves(before)) if (now.get(key) !== value) return false;
  return true;
}

/**
 * Where Claude Code keeps servers: ~/.claude.json at user scope (top-level
 * `mcpServers`) and local scope (`projects[<dir>].mcpServers`), and a committed
 * .mcp.json at the repo root. Read as detectClaudeCodeServerKinds reads them.
 */
function claudeCodeServerEntries(home, cwd) {
  const claudeJsonPath = path.join(home, '.claude.json');
  const config = readJsonSafe(claudeJsonPath);
  const entries = jsonServerEntries(config?.mcpServers, claudeJsonPath);
  if (config?.projects && typeof config.projects === 'object') {
    for (const project of Object.values(config.projects)) entries.push(...jsonServerEntries(project?.mcpServers, claudeJsonPath));
  }
  for (const dir of dirsUpToRepoRoot(cwd)) {
    const mcpJsonPath = path.join(dir, '.mcp.json');
    entries.push(...jsonServerEntries(readJsonSafe(mcpJsonPath)?.mcpServers, mcpJsonPath));
  }
  return entries;
}

/**
 * Cursor reads servers from ~/.cursor/mcp.json AND from a project's own
 * .cursor/mcp.json. A person who registered DeerDawn only in the project is
 * connected there, and the global file alone would say they are not.
 */
function cursorServerEntries(home, cwd) {
  const globalPath = path.join(home, '.cursor', 'mcp.json');
  const entries = jsonServerEntries(readJsonSafe(globalPath)?.mcpServers, globalPath);
  for (const dir of dirsUpToRepoRoot(cwd)) {
    const projectPath = path.join(dir, '.cursor', 'mcp.json');
    if (projectPath !== globalPath) entries.push(...jsonServerEntries(readJsonSafe(projectPath)?.mcpServers, projectPath));
  }
  return entries;
}

/** The working directory and its parents, up to and including the repo root (bounded). */
function dirsUpToRepoRoot(cwd) {
  const dirs = [];
  if (!cwd) return dirs;
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 12; depth += 1) {
    dirs.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir || fs.existsSync(path.join(dir, '.git'))) break;
    dir = parent;
  }
  return dirs;
}

// Which tool this DeerDawn server is running inside, when the caller knows: the
// MCP handshake names it (surface.ts), and a tool-specific config sets
// DEERDAWN_SURFACE_ID. Null when nobody can say — a terminal, or a boot before
// the handshake — and null never counts as any tool.
function resolveRunningSurface(options) {
  if (options && options.runningSurface !== undefined) return options.runningSurface || null;
  return process.env.DEERDAWN_SURFACE_ID || null;
}

// The server running inside a tool is the strongest evidence that the tool has
// DeerDawn registered, wherever that registration lives. Counted for the two
// tools whose instruction files autoConfigureHooks keeps (auth.ts decides the
// same way), not for Claude Code: the handshake maps every "claude" client to
// claude_code, Claude Desktop included.
const RUNNING_COUNTS_FOR = new Set(['codex', 'cursor']);

function hostedMcpUrl() {
  return `${String(process.env.DEERDAWN_API_URL || 'https://api.deerdawn.com').replace(/\/+$/, '')}/mcp`;
}

// The step that registers DeerDawn with each tool, as that tool's setup guide
// gives it (apps/marketing/public/agent-setup/*.md, connectCopy.ts).
function connectStep(surface) {
  const url = hostedMcpUrl();
  if (surface === 'codex') return `Register it with Codex: \`codex mcp add deerdawn --url ${url}\`, then \`codex mcp login deerdawn\`.`;
  if (surface === 'cursor') return `Add \`"deerdawn": { "url": "${url}" }\` under "mcpServers" in ~/.cursor/mcp.json, then restart Cursor.`;
  if (surface === 'claude_code') return `Register it with Claude Code: \`npx -y @deerdawn/mcp-server@latest setup\` (runs \`claude mcp add\` and signs in), or \`claude mcp add -s user --transport http deerdawn ${url}/claude\`.`;
  return 'Add `"deerdawn": { "command": "npx", "args": ["-y", "@deerdawn/mcp-server@latest"] }` under "mcpServers" in claude_desktop_config.json, then restart Claude Desktop.';
}

const SUPPORTED_SURFACES = ['claude_code', 'cursor', 'claude_desktop', 'codex'];

function withModeState(surface, authenticated) {
  const state = !surface.detected
    ? 'not_detected'
    : surface.runtime_verified
      ? 'verified'
      : surface.degraded_reason && surface.configured
        ? 'degraded'
        : surface.verified
          ? 'configured'
          : surface.configured
            ? authenticated
              ? 'configured'
              : 'degraded'
            : 'detected';
  return {
    ...surface,
    state,
    degraded_reason: state === 'degraded'
      ? surface.degraded_reason || 'missing_authentication'
      : surface.degraded_reason || null,
  };
}

function getCredentials() {
  const raw = readJsonSafe(getCredentialsPath());
  return raw && raw.api_key ? raw : null;
}

function getPendingAuth() {
  return readJsonSafe(getPendingAuthPath());
}

function getPendingAuthState(pending) {
  if (!pending) return 'none';
  if (pending.error_message) return 'error';
  if (pending.expires_at && pending.expires_at <= new Date().toISOString()) return 'expired';
  return 'pending';
}

function loadRuntimeSurfaceRegistry() {
  const raw = readJsonSafe(getRuntimeSurfacesPath());
  return raw && typeof raw === 'object' ? raw : { surfaces: {} };
}

function writeRuntimeSurfaceRegistry(value) {
  writeJsonFile(getRuntimeSurfacesPath(), value);
}

function recordSurfaceHeartbeat(surface, patch = {}) {
  if (!surface) throw new Error('surface is required');
  const nowIso = new Date().toISOString();
  const current = loadRuntimeSurfaceRegistry();
  const existing = current.surfaces?.[surface] || {};
  const next = {
    surface,
    runtime_verified: patch.runtime_verified !== false,
    status_basis: 'runtime',
    runtime_version: patch.runtime_version || existing.runtime_version || null,
    last_seen_at: patch.last_seen_at || nowIso,
    last_error: patch.last_error === undefined ? null : patch.last_error,
    cwd: patch.cwd || existing.cwd || null,
    tool_name: patch.tool_name || existing.tool_name || null,
  };

  current.surfaces = {
    ...(current.surfaces || {}),
    [surface]: next,
  };
  writeRuntimeSurfaceRegistry(current);
  return next;
}

function recordSurfaceFailure(surface, patch = {}) {
  if (!surface) throw new Error('surface is required');
  const current = loadRuntimeSurfaceRegistry();
  const existing = current.surfaces?.[surface] || {};
  const next = {
    surface,
    runtime_verified: false,
    status_basis: 'runtime',
    runtime_version: patch.runtime_version || existing.runtime_version || null,
    last_seen_at: existing.last_seen_at || null,
    last_error: patch.last_error || 'runtime_failure',
    cwd: patch.cwd || existing.cwd || null,
    tool_name: patch.tool_name || existing.tool_name || null,
  };

  current.surfaces = {
    ...(current.surfaces || {}),
    [surface]: next,
  };
  writeRuntimeSurfaceRegistry(current);
  return next;
}

function buildMcpConfig(apiKey, surface = null) {
  const config = buildMcpServerConfigObject(process.env.DEERDAWN_API_URL || 'https://api.deerdawn.com', apiKey);
  // Stamp the tool identity into tool-specific configs so every product event
  // this server emits carries a surface (distinct-tool metrics like
  // second_tool_connected depend on it). The generic copy-paste templates stay
  // surface-less — the server's initialize clientInfo fallback covers those.
  if (surface) config.env = { ...config.env, DEERDAWN_SURFACE_ID: surface };
  return config;
}

// ─── DeerDawn's block inside a file that is the person's ─────────────────────
//
// CLAUDE.md, AGENTS.md and the Cursor rule are the person's own files, and
// DeerDawn owns only the span between its two markers. Every place that
// refreshes the block finds it here (the boot in packages/mcp-server/src/auth.ts
// and apply_setup below), because each used to find it with
// indexOf(OPEN_MARKER) / indexOf(CLOSE_MARKER): the closing marker searched from
// the START of the file and neither anchored to a line. A note that QUOTED the
// opening marker in prose made a boot delete everything from the quote to the
// real block; a stray marker an editor left behind made each boot either
// delete the person's text or duplicate it and append another block.
//
// The rule is structural, because nothing can tell DeerDawn's text from the
// person's between two markers: a marker is a line that is exactly that marker
// (surrounding spaces, tabs, a CR and a leading byte-order mark allowed), not in
// a code fence. The block is the first closing-marker line that has an
// opening-marker line before it, paired with the NEAREST such opening line, so
// no other marker sits inside the span. Pairing with the first opening line
// instead would join a stray one to the block appended after it, and the next
// boot would delete the person's text between them. Only the span from the
// opening marker to the closing marker is replaced; everything outside it,
// line endings and a missing final newline included, is left byte for byte.
// With no pair the block is appended and stray markers stay where they are.

const CODE_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const CODE_FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** '\r\n' when the file's first line ends that way, so a CRLF file stays CRLF. */
function lineEndingOf(text) {
  const newline = text.indexOf('\n');
  return newline > 0 && text[newline - 1] === '\r' ? '\r\n' : '\n';
}

/** [start, end) of each line's content, without its '\n' or a '\r' before it. */
function lineSpans(text) {
  const spans = [];
  let start = 0;
  for (;;) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline;
    spans.push([start, end > start && text[end - 1] === '\r' ? end - 1 : end]);
    if (newline === -1) return spans;
    start = newline + 1;
  }
}

/**
 * Which lines are inside a fenced code block. Only a fence that is closed
 * counts: an unclosed one would otherwise swallow the block appended after it,
 * and every boot would append another.
 */
function fencedLines(text, spans) {
  const fenced = new Array(spans.length).fill(false);
  let openedAt = -1;
  let fence = '';
  spans.forEach(([start, end], index) => {
    const line = text.slice(start, end);
    if (openedAt === -1) {
      const match = CODE_FENCE_OPEN.exec(line);
      // A backtick fence's info string cannot hold a backtick (CommonMark).
      if (match && !(match[1][0] === '`' && line.slice(match[0].length).includes('`'))) {
        openedAt = index;
        fence = match[1];
      }
      return;
    }
    const match = CODE_FENCE_CLOSE.exec(line);
    if (match && match[1][0] === fence[0] && match[1].length >= fence.length) {
      for (let inside = openedAt; inside <= index; inside += 1) fenced[inside] = true;
      openedAt = -1;
    }
  });
  return fenced;
}

/**
 * Which lines are plain text: not inside a fenced code block (`fenced`), not in an
 * indented code block (four spaces or a tab, after a blank line or another
 * indented line), and not inside an HTML comment that began on an earlier line.
 */
function plainTextLines(text, spans, fenced) {
  const plain = new Array(spans.length).fill(true);
  let previousBlank = true;
  let previousCode = false;
  let inComment = false;
  spans.forEach(([start, end], index) => {
    const line = text.slice(start, end);
    const blank = /^[ \t]*$/.test(line);
    const indented = /^(?: {4}|\t)/.test(line) && !blank;
    const code = !fenced[index] && !inComment && indented && (previousBlank || previousCode);
    if (fenced[index] || inComment || code) plain[index] = false;
    // Comment state after this line: scan its openers and closers in order.
    if (!fenced[index] && !code) {
      for (let at = 0; at < line.length;) {
        if (!inComment) {
          const open = line.indexOf('<!--', at);
          if (open === -1) break;
          inComment = true;
          at = open + 4;
        } else {
          const close = line.indexOf('-->', at);
          if (close === -1) break;
          inComment = false;
          at = close + 3;
        }
      }
    }
    previousCode = code;
    previousBlank = blank;
  });
  return plain;
}

// The global instruction block's markers. Project sync's repo blocks
// (`<!-- deerdawn:start -->` / `<!-- deerdawn:end -->`, and the skills index's
// pair) are found by the same rule with their own markers.
const AUTO_CONTEXT_MARKERS = { open: OPEN_MARKER, close: CLOSE_MARKER, strict: true };

/** The marker a line consists of, and where it starts, or null. */
function markerOnLine(text, [start, end], markers) {
  const line = text.slice(start, end);
  // A byte-order mark can only open the file. A strict marker (DeerDawn's own
  // block) also starts at column 0: indentation means it is inside something.
  const lead = (markers.strict
    ? (start === 0 ? /^\ufeff?/ : /^/)
    : (start === 0 ? /^\ufeff?[ \t]*/ : /^[ \t]*/)).exec(line)[0];
  const rest = line.slice(lead.length).replace(/[ \t]+$/, '');
  // An opening marker may be given as a pattern (the token blocks: the marker
  // name and the token are matched, the words after them are not).
  if (markers.openPattern ? markers.openPattern.test(rest) : rest === markers.open) return { open: true, at: start + lead.length };
  if (rest === markers.close) return { open: false, at: start + lead.length };
  return null;
}

/**
 * Where DeerDawn's block is: offsets from the first character of its opening
 * marker to just past its closing marker, or null when the file has no
 * well-formed pair. See the rule above.
 */
function findManagedBlock(text, markers = AUTO_CONTEXT_MARKERS) {
  const str = String(text || '');
  const spans = lineSpans(str);
  const fenced = fencedLines(str, spans);
  // DeerDawn's own block (strict markers) is also not one written about in an
  // indented code block or inside an HTML comment: a pair there is a note, and the
  // text between its markers is the person's.
  const plain = markers.strict ? plainTextLines(str, spans, fenced) : null;
  let open = null;
  for (let index = 0; index < spans.length; index += 1) {
    if (fenced[index] || (plain && !plain[index])) continue;
    const marker = markerOnLine(str, spans[index], markers);
    if (!marker) continue;
    if (marker.open) open = marker;
    else if (open) return { start: open.at, end: marker.at + markers.close.length };
  }
  return null;
}

/**
 * `text` with DeerDawn's block refreshed to `block`: the first well-formed pair
 * replaced in place, or, with none, `block` added with a blank line between it
 * and the person's text: below it, or above it with `prepend` (project sync puts
 * its block first). The block takes the file's line ending. Applying it twice
 * gives what applying it once did.
 */
function upsertManagedBlock(text, block, { markers = AUTO_CONTEXT_MARKERS, prepend = false, found: foundOverride } = {}) {
  const str = String(text || '');
  const eol = lineEndingOf(str);
  const body = String(block).replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n').join(eol);
  const found = foundOverride !== undefined ? foundOverride : findManagedBlock(str, markers);
  if (found) return str.slice(0, found.start) + body + str.slice(found.end);
  if (prepend) {
    // After a byte-order mark, which has to stay the file's first character.
    const bom = str.startsWith('\ufeff') ? '\ufeff' : '';
    return str.length > bom.length ? bom + body + eol + eol + str.slice(bom.length) : bom + body;
  }
  if (!str) return body + eol;
  return str + (str.endsWith('\n') ? eol : eol + eol) + body + eol;
}

/**
 * `text` with DeerDawn's first well-formed block taken out, or null when it has
 * none. The marker lines and everything between them go (the rest of a marker's
 * line is whitespace, by the rule above), and when they opened the file, so does
 * the blank line a prepended block is written with. A byte-order mark stays
 * first; a stray marker is the person's and stays; so does every other byte.
 */
function removeManagedBlock(text, markers = AUTO_CONTEXT_MARKERS, { found: foundOverride } = {}) {
  const str = String(text || '');
  const found = foundOverride !== undefined ? foundOverride : findManagedBlock(str, markers);
  if (!found) return null;
  const lineStart = str.lastIndexOf('\n', found.start - 1) + 1;
  const from = lineStart === 0 && str.startsWith('\ufeff') ? 1 : lineStart;
  const closeLineEnd = str.indexOf('\n', found.end);
  let to = closeLineEnd === -1 ? str.length : closeLineEnd + 1;
  if (lineStart === 0) {
    const blank = /^[ \t]*\r?\n/.exec(str.slice(to));
    if (blank) to += blank[0].length;
  }
  return str.slice(0, from) + str.slice(to);
}

// ─── Which block is ours ─────────────────────────────────────────────────────
//
// A pair of markers is DeerDawn's when it carries this install's token
// (deerdawnInstructions.js says why). One older shape is recognised as well, once:
// the token-less pair versions before the token wrote, so a file upgraded from
// one of them is rewritten with the token instead of getting a second block.
// That pair is a marker anybody can type, so it counts only when what sits
// between the markers holds the "## DeerDawn" heading every block DeerDawn ever
// wrote has (anywhere inside it: an old block a person edited at the top is still
// the one DeerDawn wrote). A note that quotes the markers around something else
// is not ours. Once a token block is in the file the old pair is no longer looked
// at: the migration has happened, and a second, older-looking pair is the
// person's.

const LEGACY_OWNED_HEADING = /^[ \t]*##[ \t]+DeerDawn[ \t]*$/;

const TOKEN_IN_TEXT = /"block_token"\s*:\s*"([0-9a-f]{32})"/;

function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait available: spin once */ }
}

/**
 * This install's block token, from ~/.deerdawn/install.json. Made on first use,
 * unless `create` is false; null when it cannot be read or stored.
 *
 * Made atomically. The token is written in full to a file of its own and then
 * linked into place, which succeeds for exactly one process and never shows the
 * others a file that is empty or half written (a create-then-write did, and two
 * processes starting together each wrote a token of their own). The loser reads
 * the winner's. A file that is empty is waited for briefly before it is called
 * damaged, and a damaged one whose token can still be read keeps that token: a
 * new token would turn this install's own block into "another install's".
 *
 * An install with NO token that is about to mint one first looks at the tool's
 * global files: exactly one distinct well-formed block token there is adopted
 * instead (reclaimableToken), so a wiped ~/.deerdawn recovers and two machines
 * that sync one file share one token. An install that has a token never switches.
 */
function getBlockToken({ create = true } = {}) {
  const file = path.join(getDeerDawnDir(), 'install.json');
  const stored = () => {
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
    try {
      const raw = JSON.parse(text);
      if (raw && isBlockToken(raw.block_token)) return raw.block_token;
    } catch { /* damaged: see below */ }
    const salvaged = TOKEN_IN_TEXT.exec(text);
    if (salvaged && create) {
      // Repaired in place, with the token it held, so the next read is plain.
      try {
        const symlink = fs.lstatSync(file).isSymbolicLink();
        if (!symlink) writeFileAtomic(file, `${JSON.stringify({ block_token: salvaged[1], created_at: new Date().toISOString() }, null, 2)}\n`);
      } catch { /* left as it is */ }
    }
    return salvaged ? salvaged[1] : null;
  };
  const existing = stored();
  if (existing || !create) return existing;

  // About to mint: if the tool's global files already hold ONE well-formed DeerDawn
  // block token, that is this install's own from before (a wiped ~/.deerdawn) or
  // another machine's that shares the file, and it is adopted instead. Several
  // different tokens are a guess, so none is taken (reclaimableToken).
  const token = reclaimableToken() || crypto.randomBytes(16).toString('hex');
  const body = `${JSON.stringify({ block_token: token, created_at: new Date().toISOString() }, null, 2)}\n`;
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(temp, body, { flag: 'wx', mode: 0o600 });
  } catch {
    return null;
  }
  try {
    try {
      fs.linkSync(temp, file);
      return token;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') {
        // A filesystem with no hard links: create it directly, in full and exclusively.
        try {
          fs.writeFileSync(file, body, { flag: 'wx', mode: 0o600 });
          return token;
        } catch (inner) {
          if (!inner || inner.code !== 'EEXIST') return null;
        }
      }
    }
    // The file is there. Its token wins, once it can be read.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const winner = stored();
      if (winner) return winner;
      sleepMs(20);
    }
    // Still nothing usable in it: damaged. Replace it, atomically, but never a link.
    try {
      if (fs.lstatSync(file).isSymbolicLink()) return null;
      fs.renameSync(temp, file);
      return token;
    } catch {
      return null;
    }
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* gone already */ }
  }
}

/**
 * The tokens of every well-formed DeerDawn block in `text`, in order and without
 * repeats. A pair counts only when its opening marker carries a 32-hex token and
 * its closing marker carries the same one, outside a code fence: a token nobody
 * made, a closing marker with another token, an unclosed opening marker and the
 * older token-less pair are lookalikes and are not here.
 */
function wellFormedTokens(text) {
  const str = String(text || '');
  const tokens = [];
  for (const match of str.matchAll(TOKEN_OPEN_LINES)) {
    if (tokens.includes(match[1])) continue;
    if (findManagedBlock(str, ownedMarkersFor(match[1]))) tokens.push(match[1]);
  }
  return tokens;
}

/** The distinct well-formed block tokens across the tool's global files: { tokens: [...], byFile }. */
function globalBlockTokens(home) {
  const tokens = new Set();
  for (const surface of ['claude_code', 'codex', 'cursor']) {
    let text = '';
    try { text = fs.readFileSync(instructionFileFor(surface, home), 'utf8'); } catch { continue; }
    for (const token of wellFormedTokens(text)) tokens.add(token);
  }
  return [...tokens];
}

/** The one token an install with none of its own may adopt, or null (none found, or several: a guess). */
function reclaimableToken() {
  const tokens = globalBlockTokens(getHomeDir());
  return tokens.length === 1 ? tokens[0] : null;
}

/**
 * DeerDawn's block in `text`, as { start, end, legacy }, or null. `token` is this
 * install's (getBlockToken); with none, only the older shape can be found.
 */
function findOwnedBlock(text, token) {
  const str = String(text || '');
  if (isBlockToken(token)) {
    const found = findManagedBlock(str, ownedMarkersFor(token));
    if (found) return { ...found, legacy: false };
  }
  const legacy = findManagedBlock(str, AUTO_CONTEXT_MARKERS);
  if (!legacy) return null;
  const inside = str.slice(legacy.start + AUTO_CONTEXT_MARKERS.open.length, legacy.end - AUTO_CONTEXT_MARKERS.close.length);
  const holdsHeading = inside.split('\n').some((line) => LEGACY_OWNED_HEADING.test(line.replace(/\r$/, '')));
  return holdsHeading ? { ...legacy, legacy: true } : null;
}

const TOKEN_OPEN_LINES = /^[ \t]*<!-- deerdawn:auto-context ([0-9a-f]{32})(?:[. ][^\r\n]*)? -->[ \t]*\r?$/gm;

/**
 * A well-formed DeerDawn block in `text` that carries ANOTHER install's token
 * (a CLAUDE.md synced between two machines): its token and span, or null. An
 * opening marker with a token nobody made, or one whose closing marker carries a
 * different token, is a lookalike and is not found here.
 */
function findForeignBlock(text, token) {
  const str = String(text || '');
  const seen = new Set();
  for (const match of str.matchAll(TOKEN_OPEN_LINES)) {
    if (match[1] === token || seen.has(match[1])) continue;
    seen.add(match[1]);
    const found = findManagedBlock(str, ownedMarkersFor(match[1]));
    if (found) return { ...found, token: match[1] };
  }
  return null;
}

/**
 * `text` with DeerDawn's block refreshed to `block` (built with `token`): the block
 * found by findOwnedBlock replaced in place, otherwise `block` added. A block from
 * another install is kept as it is, and no second one is added beside it.
 */
function upsertOwnedBlock(text, block, token) {
  const owned = findOwnedBlock(text, token);
  if (!owned && findForeignBlock(text, token)) return String(text || '');
  return upsertManagedBlock(text, block, { found: owned });
}

/** `text` with DeerDawn's block taken out, or null when it has none. */
function removeOwnedBlock(text, token) {
  return removeManagedBlock(text, AUTO_CONTEXT_MARKERS, { found: findOwnedBlock(text, token) });
}

/**
 * The file text with DeerDawn's block refreshed, or null when this install has no
 * token to write it with (nothing is written then: a block that could not be
 * recognised again would be added afresh on every run).
 */
function mergeInstructionText(existing) {
  const existingStr = String(existing || '');
  const token = getBlockToken();
  if (!token) return null;
  // Has DeerDawn's instructions but no markers (written by hand, or by a much
  // older version): left alone, as it always was, rather than given a second copy.
  if (!findOwnedBlock(existingStr, token) && hasDeerDawnInstruction(existingStr)) return existingStr;
  return upsertOwnedBlock(existingStr, buildDeerdawnInstructionBlock(token), token);
}

function latestBackupPath(surface) {
  const backupDir = getBackupDir();
  if (!fs.existsSync(backupDir)) return null;
  const files = fs.readdirSync(backupDir)
    .filter((name) => name.startsWith(`${surface}-`))
    .sort()
    .reverse();
  return files[0] ? path.join(backupDir, files[0]) : null;
}

// Backups can hold a key (a Cursor or Claude Desktop config carries the API key in
// its entry's env), so the directory is private to the person and so is each file.
// Only the newest few per tool are kept: a backup exists to undo the last write,
// and one that is never removed is a copy of the key that outlives its purpose.
const BACKUPS_KEPT = 5;

function writeBackup(surface, filePath, { redact = null } = {}) {
  const backupDir = getBackupDir();
  ensureDir(backupDir);
  try { fs.chmodSync(backupDir, 0o700); } catch { /* not ours to change */ }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `${surface}-${stamp}${path.extname(filePath) || '.bak'}`);
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath) : Buffer.from('');
  if (redact) content = Buffer.from(content.toString('utf8').split(redact).join(REDACTED_KEY), 'utf8');
  fs.writeFileSync(backupPath, content, { mode: 0o600 });
  try { fs.chmodSync(backupPath, 0o600); } catch { /* best effort */ }
  pruneBackups(surface);
  return backupPath;
}

const REDACTED_KEY = '[removed by DeerDawn remove-key]';

function pruneBackups(surface) {
  try {
    const dir = getBackupDir();
    const mine = fs.readdirSync(dir).filter((name) => name.startsWith(`${surface}-`)).sort();
    for (const name of mine.slice(0, Math.max(0, mine.length - BACKUPS_KEPT))) fs.rmSync(path.join(dir, name), { force: true });
  } catch { /* best effort */ }
}

function writeJsonFile(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeTextFile(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, value, 'utf8');
}

// ─── JSON with comments and trailing commas ────────────────────────────────────
//
// Claude Code's settings.json accepts both, and so does Cursor's mcp.json in
// practice, so a file a person keeps by hand often carries them. JSON.parse
// refuses such a file, and a reader that treats "cannot parse" as "nothing there"
// reports a key that is in the file as absent. This reads the file as a tree of
// tokens that keep their offsets, so a member can be taken out of the TEXT
// without re-serialising the rest of the file.

/** Tokens of `text` with their offsets (comments and whitespace skipped), or null when it cannot be tokenised. */
function tokenizeJsonc(text) {
  const tokens = [];
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i += 1; continue; }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return null;
      i = end + 2;
      continue;
    }
    if ('{}[]:,'.includes(ch)) { tokens.push({ type: ch, start: i, end: i + 1 }); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') j += 1;
        if (text[j] === '\n') return null;
        j += 1;
      }
      if (j >= text.length) return null;
      let value;
      try { value = JSON.parse(text.slice(i, j + 1)); } catch { return null; }
      tokens.push({ type: 'string', start: i, end: j + 1, value });
      i = j + 1;
      continue;
    }
    const literal = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
    if (!literal) return null;
    tokens.push({ type: 'literal', start: i, end: i + literal[0].length, value: JSON.parse(literal[0]) });
    i += literal[0].length;
  }
  return tokens;
}

/** Parse the tokens into nodes: objects list their members with the offsets an edit needs. null when the text is not JSON-with-comments. */
function parseJsoncTree(text) {
  const tokens = tokenizeJsonc(text);
  if (!tokens || !tokens.length) return null;
  let at = 0;
  const fail = () => { throw new SyntaxError('not JSON'); };
  function value() {
    const tok = tokens[at];
    if (!tok) fail();
    if (tok.type === 'string' || tok.type === 'literal') { at += 1; return { kind: 'value', value: tok.value, start: tok.start, end: tok.end }; }
    if (tok.type === '{') {
      at += 1;
      const node = { kind: 'object', start: tok.start, end: 0, members: [] };
      while (tokens[at] && tokens[at].type !== '}') {
        const key = tokens[at];
        if (!key || key.type !== 'string') fail();
        at += 1;
        if (!tokens[at] || tokens[at].type !== ':') fail();
        at += 1;
        const child = value();
        const member = { key: key.value, keyStart: key.start, node: child, end: child.end, comma: null };
        if (tokens[at] && tokens[at].type === ',') { member.comma = tokens[at]; at += 1; }
        else if (!tokens[at] || tokens[at].type !== '}') fail();
        node.members.push(member);
      }
      if (!tokens[at]) fail();
      node.end = tokens[at].end;
      at += 1;
      return node;
    }
    if (tok.type === '[') {
      at += 1;
      const node = { kind: 'array', start: tok.start, end: 0, items: [] };
      while (tokens[at] && tokens[at].type !== ']') {
        node.items.push(value());
        if (tokens[at] && tokens[at].type === ',') at += 1;
        else if (!tokens[at] || tokens[at].type !== ']') fail();
      }
      if (!tokens[at]) fail();
      node.end = tokens[at].end;
      at += 1;
      return node;
    }
    return fail();
  }
  try {
    const root = value();
    return at === tokens.length ? root : null;
  } catch {
    return null;
  }
}

/** The plain JavaScript value of a tree node. */
function jsoncValue(node) {
  if (node.kind === 'object') {
    const out = {};
    for (const member of node.members) out[member.key] = jsoncValue(member.node);
    return out;
  }
  if (node.kind === 'array') return node.items.map(jsoncValue);
  return node.value;
}

/** { ok:true, value, tree } for text that is JSON with comments, { ok:false } otherwise. */
function parseJsonc(text) {
  const tree = parseJsoncTree(String(text));
  return tree ? { ok: true, value: jsoncValue(tree), tree } : { ok: false, value: null, tree: null };
}

function memberOf(node, key) {
  return node && node.kind === 'object' ? node.members.find((member) => member.key === key) || null : null;
}

/**
 * `text` with one object member taken out, the rest byte for byte: its comma goes
 * with it (the one before it when it is the last), and so does its line when it
 * had the line to itself.
 */
function removeJsoncMember(text, objectNode, member) {
  const index = objectNode.members.indexOf(member);
  const previous = index > 0 ? objectNode.members[index - 1] : null;
  const last = !member.comma;
  let from = member.keyStart;
  let to = member.comma ? member.comma.end : member.end;

  const lineStart = text.lastIndexOf('\n', from - 1) + 1;
  const lineEnd = text.indexOf('\n', to);
  const before = text.slice(lineStart, from);
  const after = text.slice(to, lineEnd === -1 ? text.length : lineEnd);
  // A line comment after the member is about it, and goes with its line.
  const alone = /^[ \t]*$/.test(before) && /^[ \t]*(?:\/\/.*)?\r?$/.test(after);

  const cut = (str, start, end) => str.slice(0, start) + str.slice(end);
  if (alone) {
    from = lineStart;
    to = lineEnd === -1 ? text.length : lineEnd + 1;
    const removed = cut(text, from, to);
    // The last member: the comma after the one before it goes, and nothing else on that line.
    return last && previous ? cut(removed, previous.comma.start, previous.comma.end) : removed;
  }
  if (last && previous) {
    const between = text.slice(previous.comma.end, member.keyStart);
    // Only whitespace between them: comma, whitespace and member go together.
    if (/^\s*$/.test(between)) return cut(text, previous.comma.start, member.end);
    // A comment sits between them: it stays, and only the comma and the member go.
    return cut(cut(text, member.keyStart, member.end), previous.comma.start, previous.comma.end);
  }
  return cut(text, from, to);
}

/** Write `text` to `file` through a temporary file in the same directory, keeping the file's mode. */
function writeFileAtomic(file, text) {
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch { /* new file */ }
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, text, { mode, flag: 'wx' });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } catch (err) {
    try { fs.rmSync(temp, { force: true }); } catch { /* gone */ }
    throw err;
  }
}

// ─── What DeerDawn left behind that it no longer writes ──────────────────────

const CLI_PREFIX = 'npx -y @deerdawn/mcp-server@latest';

/** The file each tool reads DeerDawn's instruction block from, or null when DeerDawn keeps none for it. */
function instructionFileFor(surface, home) {
  if (surface === 'claude_code') return path.join(home, '.claude', 'CLAUDE.md');
  if (surface === 'cursor') return path.join(home, '.cursor', 'rules', 'deerdawn.mdc');
  if (surface === 'codex') return path.join(codexHomeDir(home), 'AGENTS.md');
  return null;
}

const STALE_BLOCK_LABELS = { claude_code: 'Claude Code', cursor: 'Cursor', codex: 'Codex' };

/**
 * A block in `file` for a tool that has no DeerDawn server behind it, named: which
 * file, which tool, whether DeerDawn can take it out (it found its own markers) and
 * the command that does. null when there is nothing there, or the tool is
 * connected. It is KEPT: no boot and no setup removes it; a person asks.
 */
function staleBlockOf(surface, file, text, connected, home, token) {
  if (connected) return null;
  const owned = findOwnedBlock(text, token) !== null;
  // Another install's block is not stale and not hand-typed: see foreignBlockOf.
  if (!owned && findForeignBlock(text, token)) return null;
  if (!owned && !hasDeerDawnInstruction(text)) return null;
  const label = STALE_BLOCK_LABELS[surface] || surface;
  const shown = tildePath(file, home);
  const where = surface === 'claude_code'
    ? 'in ~/.claude.json or a project .mcp.json'
    : surface === 'cursor'
      ? 'in ~/.cursor/mcp.json or a project .cursor/mcp.json'
      : `in ${tildePath(readCodexConfig(home).path, home)}`;
  const removeWith = owned ? `${CLI_PREFIX} remove-block ${surface}` : null;
  const summary = `${shown} holds DeerDawn's instructions for ${label}, and no DeerDawn server is registered for ${label} ${where}. `
    + (surface === 'claude_code' ? 'A DeerDawn connection made through claude.ai is not recorded there: if that is how you connect, keep the block. ' : '')
    + 'It has been left as it is. '
    + (owned
      ? `To take it out: ${removeWith} (only the block DeerDawn wrote is removed).`
      : 'It carries no DeerDawn markers, so it was typed or pasted by hand and is yours to remove.');
  return { path: file, tool: surface, removable: owned, remove_with: removeWith, summary };
}

/** The sentence for a block another DeerDawn install wrote, for a status and for the reply that leaves it alone. */
function foreignBlockSentence(file, home, { reply = false, surface = '', tokenless = false, tokens = 1 } = {}) {
  const shown = tildePath(file, home);
  const adopt = `${CLI_PREFIX} adopt-block ${surface}`;
  if (reply) {
    return `${shown} holds a DeerDawn block that is managed by another DeerDawn install (its token is not this install's, as when the file is synced between two machines). It was left as it is, and no second block was added.`;
  }
  if (tokens > 1) {
    return `${shown} holds a DeerDawn block that is managed by another DeerDawn install. Your files hold blocks from several different DeerDawn installs (${tokens} different tokens), so none was adopted automatically: DeerDawn will not write to any of them, remove them, or add a second block beside them. To make this one this install's own: ${adopt}`;
  }
  if (tokenless) {
    return `${shown} holds a DeerDawn block written by a DeerDawn install whose token is in it, and this install has no token yet (~/.deerdawn was deleted, or this is a second machine that shares the file). The next start adopts this block's token and refreshes the block in place. To take it over now: ${adopt}`;
  }
  return `${shown} holds a DeerDawn block that is managed by another DeerDawn install (its token is not this install's, as when the file is synced between two machines). DeerDawn will not write to it, remove it, or add a second block beside it. To make it this install's own (for example when this is the only machine that writes it): ${adopt}`;
}

/** A block in `file` that another DeerDawn install wrote, named. null when there is none, or this install's own block is there. */
function foreignBlockOf(surface, file, text, home, token, distinctTokens = 1) {
  if (findOwnedBlock(text, token) || !findForeignBlock(text, token)) return null;
  return {
    path: file,
    tool: surface,
    adopt_with: `${CLI_PREFIX} adopt-block ${surface}`,
    summary: foreignBlockSentence(file, home, { surface, tokenless: !token, tokens: distinctTokens }),
  };
}

/** The files that may hold a plain-text DeerDawn key where the tool does not read one, and where in each. */
function keyFileCandidates(home) {
  return [
    { file: path.join(home, '.claude', 'settings.json'), tool: 'claude_code', at: (root) => root && memberOf(root, 'mcpServers'), topLevel: false },
    // A top-level `deerdawn` key in Cursor's file is somewhere Cursor does not look.
    { file: path.join(home, '.cursor', 'mcp.json'), tool: 'cursor', at: (root) => root, topLevel: true },
  ];
}

/** The DeerDawn entries under `holder` (an object node) that carry an env key: [{ name, env, keyMember }]. */
function keyedEntries(holderNode, topLevel) {
  if (!holderNode) return [];
  const servers = topLevel ? holderNode : holderNode.node;
  if (!servers || servers.kind !== 'object') return [];
  const out = [];
  for (const member of servers.members) {
    if (topLevel && member.key !== 'deerdawn') continue;
    const entry = jsoncValue(member.node);
    if (!looksLikeDeerDawnServer(member.key, entry)) continue;
    const env = memberOf(member.node, 'env');
    const keyMember = env && memberOf(env.node, 'DEERDAWN_API_KEY');
    if (keyMember && typeof keyMember.node.value === 'string' && keyMember.node.value) out.push({ name: member.key, envNode: env.node, keyMember });
  }
  return out;
}

/**
 * Files that hold the DeerDawn API key in plain text where the tool does not
 * read one. Versions before this one wrote it under mcpServers in
 * ~/.claude/settings.json, which Claude Code does not read servers from, so the
 * key sat in a second file for nothing. Named, never removed unasked. A file with
 * comments or trailing commas is read as such; one that cannot be read at all, and
 * mentions the key, is named as unreadable, never skipped.
 */
function findPlainTextKeys(home) {
  const found = [];
  for (const candidate of keyFileCandidates(home)) {
    let text;
    try { text = fs.readFileSync(candidate.file, 'utf8'); } catch { continue; }
    const shown = tildePath(candidate.file, home);
    const parsed = parseJsonc(text);
    if (!parsed.ok) {
      if (text.includes('DEERDAWN_API_KEY')) {
        found.push({
          path: candidate.file,
          tool: candidate.tool,
          entry: null,
          readable: false,
          remove_with: null,
          summary: `${shown} mentions DEERDAWN_API_KEY, and cannot be read as JSON (even allowing comments and trailing commas), so DeerDawn cannot tell whether the key is your DeerDawn API key in plain text, and will not edit the file. Open it and delete the key by hand if it is. Nothing was changed.`,
        });
      }
      continue;
    }
    const holder = candidate.at(parsed.tree);
    for (const entry of keyedEntries(holder, candidate.topLevel)) {
      found.push({
        path: candidate.file,
        tool: candidate.tool,
        entry: entry.name,
        remove_with: `${CLI_PREFIX} remove-key`,
        summary: `${shown} holds your DeerDawn API key in plain text (mcpServers.${entry.name}.env.DEERDAWN_API_KEY), and ${STALE_BLOCK_LABELS[candidate.tool] || candidate.tool} does not read a server from that file. It has been left as it is. To delete the key: ${CLI_PREFIX} remove-key`,
      });
    }
  }
  return found;
}

/**
 * Take a stale block out of a tool's instruction file, on request. Only the block
 * DeerDawn wrote goes (its markers, or the older shape's, found by
 * findOwnedBlock), after a backup, and only when the tool has no DeerDawn server
 * registered: otherwise it is not stale. Every other byte stays.
 */
function removeStaleBlock(surface, options = {}) {
  const home = getHomeDir();
  const file = instructionFileFor(surface, home);
  if (!file) return { surface, removed: false, path: null, reason: `DeerDawn keeps no instruction block for "${surface}". Use claude_code, cursor or codex.` };
  const status = inspectLocalSetupStatus('local_direct', options);
  const entry = status.surfaces.find((item) => item.id === surface);
  if (entry && entry.configured) {
    return { surface, removed: false, path: file, reason: `${STALE_BLOCK_LABELS[surface]} has a DeerDawn server registered, so the block in ${tildePath(file, home)} is in use and was left as it is.` };
  }
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { surface, removed: false, path: file, reason: `${tildePath(file, home)} does not exist.` }; }
  const removeToken = getBlockToken({ create: false });
  const next = removeOwnedBlock(text, removeToken);
  if (next === null && findForeignBlock(text, removeToken)) {
    return { surface, removed: false, path: file, reason: `${tildePath(file, home)} holds a block managed by another DeerDawn install, so it was left as it is. Remove it from the install that wrote it, or by hand.` };
  }
  if (next === null) {
    return { surface, removed: false, path: file, reason: `${tildePath(file, home)} has no block that DeerDawn wrote (no DeerDawn markers). Anything typed there by hand is yours to remove.` };
  }
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return { surface, removed: false, path: file, reason: `${tildePath(file, home)} is a symlink, and DeerDawn will not write through one.` };
  } catch { /* checked above by the read */ }
  const backup = writeBackup(surface, file);
  writeTextFile(file, next);
  // Only the first block goes. Another one, this install's or another's, is said.
  const remaining = findOwnedBlock(next, removeToken) ? 'owned' : findForeignBlock(next, removeToken) ? 'other_install' : null;
  const result = { surface, removed: true, path: file, backup_path: backup, reason: null };
  if (remaining) {
    result.remaining = remaining;
    result.note = remaining === 'owned'
      ? `Another DeerDawn block written by this install is still in ${tildePath(file, home)}. Run the command again to remove it too.`
      : `A DeerDawn block written by another DeerDawn install is still in ${tildePath(file, home)}; it was not touched.`;
  }
  return result;
}

/**
 * On request: make a block another install wrote this install's own, when this is
 * the only machine that writes the file (the token is lost with ~/.deerdawn). Only
 * the two marker lines change, to carry this install's token; the body is refreshed
 * by the next boot. Refused when this install already has a block in the file, or
 * the file has no block from another install.
 */
function adoptForeignBlock(surface) {
  const home = getHomeDir();
  const file = instructionFileFor(surface, home);
  if (!file) return { surface, adopted: false, path: null, reason: `DeerDawn keeps no instruction block for "${surface}". Use claude_code, cursor or codex.` };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { surface, adopted: false, path: file, reason: `${tildePath(file, home)} does not exist.` }; }
  const token = getBlockToken();
  if (!token) return { surface, adopted: false, path: file, reason: 'DeerDawn could not store its install token, so it has nothing to take the block over with.' };
  if (findOwnedBlock(text, token)) return { surface, adopted: false, path: file, reason: `${tildePath(file, home)} already has a block written by this install, so another one is not taken over.` };
  const foreign = findForeignBlock(text, token);
  if (!foreign) return { surface, adopted: false, path: file, reason: `${tildePath(file, home)} has no DeerDawn block written by another install.` };
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return { surface, adopted: false, path: file, reason: `${tildePath(file, home)} is a symlink, and DeerDawn will not write through one.` };
  } catch { /* checked by the read */ }
  const replaceLine = (str, at, length, marker) => str.slice(0, at) + marker + str.slice(at + length);
  // The closing marker first, so the opening one's offset does not move.
  const closeLine = ownedMarkersFor(foreign.token).close;
  let next = replaceLine(text, foreign.end - closeLine.length, closeLine.length, ownedMarkersFor(token).close);
  const openMatch = new RegExp(`<!-- deerdawn:auto-context ${foreign.token}(?:[. ][^\\r\\n]*)? -->`).exec(next.slice(foreign.start));
  if (!openMatch) return { surface, adopted: false, path: file, reason: 'the opening marker could not be found again, so the file was left as it is.' };
  next = replaceLine(next, foreign.start + openMatch.index, openMatch[0].length, ownedMarkersFor(token).open);
  const backup = writeBackup(surface, file);
  writeFileAtomic(file, next);
  return { surface, adopted: true, path: file, backup_path: backup, reason: null };
}

/**
 * Delete the plain-text key from the files findPlainTextKeys names, on request.
 * The key comes out of the file's text with the rest of it byte for byte, written
 * through a temporary file and renamed into place. The backup taken first has the
 * key redacted (its point is that the key is gone), and any older backup that
 * still holds it is redacted too. A file that cannot be read or safely edited is
 * reported by name and left alone.
 */
function removePlainTextKeys() {
  const home = getHomeDir();
  const results = [];
  for (const item of findPlainTextKeys(home)) {
    const shown = tildePath(item.path, home);
    try {
      if (fs.lstatSync(item.path).isSymbolicLink()) {
        results.push({ path: item.path, removed: false, reason: `${shown} is a symlink, and DeerDawn will not write through one.` });
        continue;
      }
      if (item.readable === false) {
        results.push({ path: item.path, removed: false, reason: `${shown} cannot be parsed as JSON (even allowing comments and trailing commas), so DeerDawn did not edit it. Open it and delete DEERDAWN_API_KEY by hand.` });
        continue;
      }
      let text = fs.readFileSync(item.path, 'utf8');
      const secrets = [];
      let redactedBackups = 0;
      // Every keyed entry in the file, one at a time, re-reading the text after each edit.
      for (;;) {
        const parsed = parseJsonc(text);
        if (!parsed.ok) throw new Error('the file stopped parsing');
        const candidate = keyFileCandidates(home).find((entry) => entry.file === item.path);
        const [entry] = keyedEntries(candidate.at(parsed.tree), candidate.topLevel);
        if (!entry) break;
        secrets.push(entry.keyMember.node.value);
        const edited = removeJsoncMember(text, entry.envNode, entry.keyMember);
        // The edit must leave a file that parses, holds everything it held, and not this key.
        const after = parseJsonc(edited);
        const expected = jsoncValue(parsed.tree);
        const removedFrom = candidate.topLevel ? expected[entry.name] : expected.mcpServers[entry.name];
        delete removedFrom.env.DEERDAWN_API_KEY;
        if (!after.ok || JSON.stringify(after.value) !== JSON.stringify(expected)) throw new Error('removing the key would change more than the key');
        text = edited;
      }
      if (!secrets.length) continue;
      const backup = writeBackup(`${item.tool}_keyfile`, item.path, { redact: secrets[0] });
      // (A file with more than one key: redact each of them in the backup too.)
      if (secrets.length > 1) {
        let backupText = fs.readFileSync(backup, 'utf8');
        for (const secret of secrets.slice(1)) backupText = backupText.split(secret).join(REDACTED_KEY);
        fs.writeFileSync(backup, backupText, { mode: 0o600 });
      }
      writeFileAtomic(item.path, text);
      for (const secret of secrets) redactedBackups += redactKeyInBackups(secret);
      results.push({ path: item.path, removed: true, backup_path: backup, redacted_backups: redactedBackups, reason: null });
    } catch (err) {
      results.push({ path: item.path, removed: false, reason: `could not update ${shown}: ${err && err.message ? err.message : err}. Nothing was changed.` });
    }
  }
  return results;
}

/** Redact `secret` in every file of the backup directory that holds it, and make those files private. How many were changed. */
function redactKeyInBackups(secret) {
  let changed = 0;
  let names = [];
  try { names = fs.readdirSync(getBackupDir()); } catch { return 0; }
  for (const name of names) {
    const file = path.join(getBackupDir(), name);
    try {
      if (!fs.lstatSync(file).isFile()) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (!text.includes(secret)) continue;
      fs.writeFileSync(file, text.split(secret).join(REDACTED_KEY), { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      changed += 1;
    } catch { /* unreadable: left */ }
  }
  return changed;
}

function inspectLocalSetupStatus(executionSource = 'local_direct', options = {}) {
  const runningSurface = resolveRunningSurface(options);
  const runningInside = (id) => RUNNING_COUNTS_FOR.has(id) && runningSurface === id;
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const credentials = getCredentials();
  const authenticated = Boolean(credentials?.api_key);
  const pending = getPendingAuth();
  const envKeyPresent = Boolean(process.env.DEERDAWN_API_KEY);
  const savedKeyPresent = Boolean(credentials?.api_key);
  const pendingAuthState = getPendingAuthState(pending);
  const home = getHomeDir();
  const runtimeSurfaces = loadRuntimeSurfaceRegistry().surfaces || {};

  const claudeSettingsPath = path.join(home, '.claude', 'settings.json');
  const claudeInstructionsPath = path.join(home, '.claude', 'CLAUDE.md');
  const claudeJsonPath = path.join(home, '.claude.json');
  const claudeInstructions = fs.existsSync(claudeInstructionsPath) ? fs.readFileSync(claudeInstructionsPath, 'utf8') : '';
  const claudeRegistration = registrationIn(claudeCodeServerEntries(home, cwd));

  const cursorMcpPath = path.join(home, '.cursor', 'mcp.json');
  const cursorRulePath = path.join(home, '.cursor', 'rules', 'deerdawn.mdc');
  const cursorMcp = readJsonSafe(cursorMcpPath) || {};
  const cursorRule = fs.existsSync(cursorRulePath) ? fs.readFileSync(cursorRulePath, 'utf8') : '';
  const cursorRegistration = registrationIn(cursorServerEntries(home, cwd));
  // A top-level `deerdawn` key is DeerDawn's entry in a place Cursor does not
  // read: present, and not a registration.
  const cursorHasEntry = cursorRegistration.found || Boolean(cursorMcp?.deerdawn);
  const cursorConnected = cursorRegistration.valid || runningInside('cursor');

  const claudeDesktopPath = path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  const claudeDesktopConfig = readJsonSafe(claudeDesktopPath) || {};
  const claudeDesktopConfigured = Boolean(claudeDesktopConfig?.mcpServers?.deerdawn);
  const claudeDesktopFormatValid = claudeDesktopConfigured
    && claudeDesktopConfig.mcpServers.deerdawn?.command === 'npx'
    && Array.isArray(claudeDesktopConfig.mcpServers.deerdawn?.args);

  const codexAgentsPath = path.join(codexHomeDir(home), 'AGENTS.md');
  const codexConfig = readCodexConfig(home);
  const codexConfigPath = codexConfig.path;
  const codexAgents = fs.existsSync(codexAgentsPath) ? fs.readFileSync(codexAgentsPath, 'utf8') : '';
  const codexRegistration = registrationIn(codexConfig.entries);
  const codexConnected = codexRegistration.valid || runningInside('codex');

  // Instructions sitting in a tool's file with no server behind them: said for
  // what they are, instead of being counted as the connection. A block is found
  // the way every writer finds it (findOwnedBlock: this install's token, or the
  // one older shape once), so a marker quoted in the person's notes, or a fenced
  // example of one, is not mistaken for DeerDawn's instructions. The block is
  // named, with the file and the tool, and how to take it out; nothing here, or
  // in any boot, takes it out.
  const readToken = getBlockToken({ create: false });
  const staleBlocks = {
    claude_code: staleBlockOf('claude_code', claudeInstructionsPath, claudeInstructions, claudeRegistration.valid, home, readToken),
    cursor: staleBlockOf('cursor', cursorRulePath, cursorRule, cursorConnected, home, readToken),
    codex: staleBlockOf('codex', codexAgentsPath, codexAgents, codexConnected, home, readToken),
  };
  const strandedInstructions = (id) => (staleBlocks[id] ? INSTRUCTIONS_WITHOUT_SERVER : null);
  const distinctTokens = globalBlockTokens(home).length;
  const foreignBlocks = {
    claude_code: foreignBlockOf('claude_code', claudeInstructionsPath, claudeInstructions, home, readToken, distinctTokens),
    cursor: foreignBlockOf('cursor', cursorRulePath, cursorRule, home, readToken, distinctTokens),
    codex: foreignBlockOf('codex', codexAgentsPath, codexAgents, home, readToken, distinctTokens),
  };

  function withRuntimeScaffold(surface) {
    const runtime = runtimeSurfaces[surface.id] || null;
    const lastSeenAt = runtime?.last_seen_at || null;
    const stale = lastSeenAt
      ? (Date.now() - new Date(lastSeenAt).getTime()) > getRuntimeStaleMs()
      : false;
    const runtimeVerified = Boolean(runtime?.runtime_verified && lastSeenAt && !stale);
    return {
      ...surface,
      runtime_verified: runtimeVerified,
      status_basis: runtimeVerified ? 'runtime' : 'config',
      last_seen_at: lastSeenAt,
      runtime_version: runtime?.runtime_version || null,
      last_error: runtime?.last_error || null,
      stale,
      degraded_reason: stale ? 'runtime_stale' : surface.degraded_reason || null,
    };
  }

  const surfaces = [
    withModeState(withRuntimeScaffold({
      id: 'claude_code',
      label: 'Claude Code',
      mode: claudeRegistration.valid ? 'mcp' : 'global_instructions',
      detected: fs.existsSync(path.dirname(claudeSettingsPath)) || fs.existsSync(claudeInstructionsPath) || fs.existsSync(claudeJsonPath),
      configured: claudeRegistration.valid,
      verified: authenticated && claudeRegistration.valid,
      path: claudeRegistration.source || (fs.existsSync(claudeInstructionsPath) ? claudeInstructionsPath : claudeJsonPath),
      backup_path: latestBackupPath('claude_code'),
      config_has_deerdawn_mcp: claudeRegistration.found,
      config_format_valid: claudeRegistration.valid,
      env_key_present: envKeyPresent,
      saved_key_present: savedKeyPresent,
      degraded_reason: strandedInstructions('claude_code'),
      stale_block: staleBlocks.claude_code,
      foreign_block: foreignBlocks.claude_code,
    }), authenticated),
    withModeState(withRuntimeScaffold({
      id: 'cursor',
      label: 'Cursor',
      mode: cursorConnected ? 'mcp' : 'workspace_rules',
      detected: fs.existsSync(path.dirname(cursorMcpPath)) || fs.existsSync(cursorRulePath) || cursorConnected,
      configured: cursorConnected,
      verified: authenticated && cursorConnected,
      path: cursorRegistration.source || (!cursorConnected && fs.existsSync(cursorRulePath) ? cursorRulePath : cursorMcpPath),
      backup_path: latestBackupPath('cursor'),
      config_has_deerdawn_mcp: cursorHasEntry,
      config_format_valid: cursorRegistration.valid,
      env_key_present: envKeyPresent,
      saved_key_present: savedKeyPresent,
      degraded_reason: strandedInstructions('cursor'),
      stale_block: staleBlocks.cursor,
      foreign_block: foreignBlocks.cursor,
    }), authenticated),
    withModeState(withRuntimeScaffold({
      id: 'claude_desktop',
      label: 'Claude Desktop',
      mode: 'mcp',
      detected: fs.existsSync(path.dirname(claudeDesktopPath)) || fs.existsSync(claudeDesktopPath),
      configured: claudeDesktopConfigured,
      verified: authenticated && claudeDesktopConfigured,
      path: claudeDesktopPath,
      backup_path: latestBackupPath('claude_desktop'),
      config_has_deerdawn_mcp: claudeDesktopConfigured,
      config_format_valid: claudeDesktopFormatValid,
      env_key_present: envKeyPresent,
      saved_key_present: savedKeyPresent,
    }), authenticated),
    withModeState(withRuntimeScaffold({
      id: 'codex',
      label: 'Codex',
      mode: codexConnected ? 'mcp' : 'global_instructions',
      detected: fs.existsSync(path.dirname(codexAgentsPath)) || fs.existsSync(codexAgentsPath) || codexConnected,
      configured: codexConnected,
      verified: authenticated && codexConnected,
      path: codexConnected ? codexConfigPath : codexAgentsPath,
      backup_path: latestBackupPath('codex'),
      config_has_deerdawn_mcp: codexRegistration.found,
      config_format_valid: codexRegistration.valid,
      env_key_present: envKeyPresent,
      saved_key_present: savedKeyPresent,
      degraded_reason: strandedInstructions('codex'),
      stale_block: staleBlocks.codex,
      foreign_block: foreignBlocks.codex,
    }), authenticated),
  ];

  const configuredCount = surfaces.filter((surface) => surface.configured).length;
  const verifiedCount = surfaces.filter((surface) => surface.verified).length;
  const runtimeVerifiedCount = surfaces.filter((surface) => surface.runtime_verified).length;

  return SetupStatusResultSchema.parse({
    authenticated,
    setup_complete: authenticated && verifiedCount > 0,
    configured_count: configuredCount,
    verified_count: verifiedCount,
    runtime_verified_count: runtimeVerifiedCount,
    pending_sign_in_url: pending?.verification_url || null,
    diagnostics: {
      env_key_present: envKeyPresent,
      saved_key_present: savedKeyPresent,
      pending_auth_state: pendingAuthState,
      api_reachable: 'unchecked',
      plain_text_keys: findPlainTextKeys(home),
      next_action: authenticated
        ? 'Authentication is present. Call start_session to verify runtime context loading.'
        : pending?.verification_url
          ? 'Open pending_sign_in_url in a browser, authorize, then retry get_auth_status.'
          : 'Call get_auth_status to start browser sign-in.',
    },
    execution_source: executionSource,
    surfaces,
  });
}

// The person's answers and opt-outs, as the MCP server records them
// (packages/mcp-server/src/setup-choices.ts writes this file).
function readSetupChoices() {
  return readJsonSafe(path.join(getDeerDawnDir(), 'setup-choices.json')) || {};
}

/** Did the person delete DeerDawn's block from ~/.claude/CLAUDE.md (recorded by a boot)? */
function globalClaudeMdRemoved() {
  return readSetupChoices().global_claude_md === 'removed';
}

const GLOBAL_BLOCK_REMOVED =
  'You removed DeerDawn\'s block from ~/.claude/CLAUDE.md, so it was not added back. '
  + 'The SessionStart hook still loads the brief in every session. To have the block again, '
  + 're-run `npx -y @deerdawn/mcp-server@latest setup` in a terminal and answer yes when it asks about the block.';

function applySurfaceSetup(surface, mode = 'auto', executionSource = 'local_direct', options = {}) {
  const credentials = getCredentials();
  const apiKey = credentials?.api_key || process.env.DEERDAWN_API_KEY || '';
  const home = getHomeDir();
  const changedPaths = [];
  let restoredFromBackup = null;
  // Why Codex's config.toml was not written, when it was not.
  let codexProblem = null;

  // A surface this does not configure used to fall through every branch below
  // and answer applied:false with nothing to say why.
  if (!SUPPORTED_SURFACES.includes(surface)) {
    const status = inspectLocalSetupStatus(executionSource, options);
    return {
      ...SetupApplyResultSchema.parse({ surface, mode, applied: false, execution_source: executionSource, status, changed_paths: [], restored_from_backup: null }),
      reason: `apply_setup configures claude_code, cursor, claude_desktop and codex; "${surface}" is not one of them, so nothing was changed.`,
    };
  }

  if (mode === 'restore') {
    const backupPath = latestBackupPath(surface);
    if (!backupPath) {
      const status = inspectLocalSetupStatus(executionSource, options);
      return {
        ...SetupApplyResultSchema.parse({ surface, mode, applied: false, execution_source: executionSource, status, changed_paths: [], restored_from_backup: null }),
        reason: `No backup for ${surface} in ${getBackupDir()}, so nothing was restored.`,
      };
    }
    const restoreTargets = {
      claude_code: path.join(home, '.claude', backupPath.endsWith('.md') ? 'CLAUDE.md' : 'settings.json'),
      cursor: path.join(home, '.cursor', backupPath.endsWith('.mdc') ? 'rules/deerdawn.mdc' : 'mcp.json'),
      claude_desktop: path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
      // Where the Codex branch below took its backup from.
      codex: path.join(codexHomeDir(home), 'AGENTS.md'),
    };
    const target = restoreTargets[surface];
    if (!target) {
      const status = inspectLocalSetupStatus(executionSource, options);
      return SetupApplyResultSchema.parse({ surface, mode, applied: false, execution_source: executionSource, status, changed_paths: [], restored_from_backup: null });
    }
    ensureDir(path.dirname(target));
    fs.copyFileSync(backupPath, target);
    changedPaths.push(target);
    restoredFromBackup = backupPath;
    return SetupApplyResultSchema.parse({
      surface,
      mode,
      applied: true,
      execution_source: executionSource,
      status: inspectLocalSetupStatus(executionSource, options),
      changed_paths: changedPaths,
      restored_from_backup: restoredFromBackup,
    });
  }

  // What Claude Code, Cursor, Codex or Claude Desktop registers is read BEFORE
  // anything is written: the tool's own config, as inspectLocalSetupStatus reads it.
  const preStatus = inspectLocalSetupStatus(executionSource, options);
  const current = preStatus.surfaces.find((entry) => entry.id === surface);

  // Idempotent short-circuit: in auto mode, if the surface is already configured
  // and authenticated (state 'configured' or 'verified'), don't rewrite config
  // files or churn a fresh backup — re-running setup on an already-connected
  // machine should be a no-op. Use mode 'repair' to force a rewrite.
  if (mode === 'auto') {
    if (current && (current.state === 'verified' || current.state === 'configured')) {
      return SetupApplyResultSchema.parse({
        surface,
        mode,
        applied: false,
        already_configured: true,
        execution_source: executionSource,
        status: preStatus,
        changed_paths: [],
        restored_from_backup: null,
      });
    }
  }

  // A tool asked to set itself up with no DeerDawn server registered anywhere it
  // looks: nothing is written. Its own config is not this call's to fill in
  // unasked, and instructions written for a server that is not there order a call
  // the tool cannot make. The answer says what is missing and offers the global
  // entry; asking for it (mode "repair") is what writes it. Claude Code's entry
  // is made by `claude mcp add`, not by editing ~/.claude.json, which Claude Code
  // itself rewrites, so for it the offer is the command.
  // (For Codex and Cursor `configured` also counts this server running inside them.)
  const registered = Boolean(current && current.configured);
  if (!registered && (mode === 'auto' || surface === 'claude_code')) {
    return {
      ...SetupApplyResultSchema.parse({ surface, mode, applied: false, execution_source: executionSource, status: preStatus, changed_paths: [], restored_from_backup: null }),
      ...globalEntryOffer(surface, home),
    };
  }

  // Blocks that could not be written for want of an install token, or that are
  // another install's and so are left as they are.
  let blockProblem = null;
  const foreignIn = (file, text) => {
    const token = getBlockToken({ create: false });
    return !findOwnedBlock(text, token) && findForeignBlock(text, token) ? foreignBlockSentence(file, home, { reply: true }) : null;
  };
  const NO_TOKEN = `DeerDawn could not store its install token in ${tildePath(path.join(getDeerDawnDir(), 'install.json'), home)}, so no instruction block was written.`;

  if (surface === 'claude_code') {
    // Only DeerDawn's block in the person's ~/.claude/CLAUDE.md. Nothing goes into
    // ~/.claude/settings.json: Claude Code does not read servers from it, and the
    // entry written there carried the API key in plain text.
    const instructionsPath = path.join(home, '.claude', 'CLAUDE.md');
    const existingInstructions = fs.existsSync(instructionsPath) ? fs.readFileSync(instructionsPath, 'utf8') : '';
    const merged = mergeInstructionText(existingInstructions);
    if (globalClaudeMdRemoved() && !findOwnedBlock(existingInstructions, getBlockToken({ create: false }))) {
      // The person deleted DeerDawn's block from their own global file, and a
      // boot recorded it (setup-choices.json, written by the MCP server's
      // autoConfigureHooks). A removal the person made is not an agent's to
      // undo, repair mode included.
      blockProblem = GLOBAL_BLOCK_REMOVED;
    } else if (merged === null) {
      blockProblem = NO_TOKEN;
    } else if (foreignIn(instructionsPath, existingInstructions)) {
      blockProblem = foreignIn(instructionsPath, existingInstructions);
    } else {
      writeBackup('claude_code', instructionsPath);
      writeTextFile(instructionsPath, merged);
      changedPaths.push(instructionsPath);
    }
  } else if (surface === 'cursor') {
    const mcpPath = path.join(home, '.cursor', 'mcp.json');
    const rulesPath = path.join(home, '.cursor', 'rules', 'deerdawn.mdc');
    const mcp = readJsonSafe(mcpPath) || {};
    writeBackup('cursor', fs.existsSync(mcpPath) ? mcpPath : rulesPath);
    // Cursor reads the key from this entry's env, so it is written here (and only
    // here: see the claude_code branch for a file that does not).
    mcp.mcpServers = { ...(mcp.mcpServers || {}), deerdawn: buildMcpConfig(apiKey, 'cursor') };
    writeJsonFile(mcpPath, mcp);
    changedPaths.push(mcpPath);
    const existingRules = fs.existsSync(rulesPath) ? fs.readFileSync(rulesPath, 'utf8') : '';
    const merged = mergeInstructionText(existingRules);
    if (merged === null) {
      blockProblem = NO_TOKEN;
    } else if (foreignIn(rulesPath, existingRules)) {
      blockProblem = foreignIn(rulesPath, existingRules);
    } else {
      writeTextFile(rulesPath, merged);
      changedPaths.push(rulesPath);
    }
  } else if (surface === 'claude_desktop') {
    // Claude Desktop's own config, and nothing else: its instructions are not in
    // ~/.claude/CLAUDE.md, which is Claude Code's file.
    const configPath = path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    const config = readJsonSafe(configPath) || {};
    writeBackup('claude_desktop', configPath);
    config.mcpServers = { ...(config.mcpServers || {}), deerdawn: buildMcpConfig(apiKey, 'claude_desktop') };
    writeJsonFile(configPath, config);
    changedPaths.push(configPath);
  } else if (surface === 'codex') {
    // Codex Mac app + CLI both read config.toml and AGENTS.md from CODEX_HOME,
    // ~/.codex by default.
    const agentsPath = path.join(codexHomeDir(home), 'AGENTS.md');
    const before = readCodexConfig(home);
    const configPath = before.path;
    writeBackup('codex', fs.existsSync(agentsPath) ? agentsPath : configPath);

    // Register the server first, but only as a write that cannot break the
    // file: never over a key that exists in any form, never into a file that
    // does not parse, and only when the result still parses. Codex refuses an
    // invalid config.toml whole, so a bad write here stops every server in it.
    const plan = planCodexRegistration(before, home);
    codexProblem = plan.problem;
    if (plan.text !== null) {
      writeTextFile(configPath, plan.text);
      // Read back: it must still parse and still hold every key it held. If
      // not, the person's file goes back exactly as it was.
      const after = readCodexConfig(home);
      if (after.parsed && keepsEveryKey(before.value, after.value)) {
        changedPaths.push(configPath);
      } else {
        writeTextFile(configPath, before.text);
        codexProblem = `${tildePath(configPath, home)} ${after.parsed ? 'lost a key it held' : `no longer parsed (${after.error})`} once the DeerDawn server was added, so it was put back exactly as it was.`;
      }
    }

    // Then the instructions, and only once config.toml, read back, registers a
    // server Codex can start or reach (or this server is running inside Codex).
    // The block opens with "Always call start_session"; with no server behind
    // it, it orders Codex to call a tool it cannot see, and Codex stalls on
    // every project question.
    if (registrationIn(readCodexConfig(home).entries).valid || resolveRunningSurface(options) === 'codex') {
      const existingAgents = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : '';
      const merged = mergeInstructionText(existingAgents);
      if (merged === null) {
        blockProblem = NO_TOKEN;
      } else if (foreignIn(agentsPath, existingAgents)) {
        blockProblem = foreignIn(agentsPath, existingAgents);
      } else {
        writeTextFile(agentsPath, merged);
        changedPaths.push(agentsPath);
      }
    }
  }

  // Reported from a read-back, not from the writes. A write is not a
  // connection: Codex's is skipped when an mcp_servers.deerdawn entry is already
  // there in any form. So `applied` means this call changed files AND the tool's
  // own config now registers a server it can run; anything short of that says
  // why, and what connects it.
  const status = inspectLocalSetupStatus(executionSource, options);
  const connected = Boolean(status.surfaces.find((entry) => entry.id === surface)?.configured);
  const result = SetupApplyResultSchema.parse({
    surface,
    mode,
    applied: connected && changedPaths.length > 0,
    execution_source: executionSource,
    status,
    changed_paths: changedPaths,
    restored_from_backup: restoredFromBackup,
  });
  if (connected) return blockProblem ? { ...result, note: blockProblem } : result;
  return { ...result, reason: codexProblem || notConnectedReason(surface, home), next_step: connectStep(surface) };
}

/** The file DeerDawn's global entry for a tool goes in (or, for Claude Code, is made in by `claude mcp add`). */
function globalEntryPath(surface, home) {
  if (surface === 'claude_code') return path.join(home, '.claude.json');
  if (surface === 'cursor') return path.join(home, '.cursor', 'mcp.json');
  if (surface === 'codex') return readCodexConfig(home).path;
  return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
}

/**
 * What a tool that asked to be set up is told when DeerDawn is not registered
 * with it: what is missing, the global entry that fixes it, and how to have
 * DeerDawn write that entry (mode "repair"), where DeerDawn can.
 */
function globalEntryOffer(surface, home) {
  const entryPath = globalEntryPath(surface, home);
  const shown = tildePath(entryPath, home);
  const command = connectStep(surface);
  const canWrite = surface !== 'claude_code';
  const missing = surface === 'claude_code'
    ? 'Claude Code has no DeerDawn server registered in ~/.claude.json or a project .mcp.json (a connection made through claude.ai is not recorded in either)'
    : surface === 'cursor'
      ? 'Cursor has no DeerDawn server registered in ~/.cursor/mcp.json or a project .cursor/mcp.json'
      : surface === 'codex'
        ? (planCodexRegistration(readCodexConfig(home), home).problem || `${shown} registers no DeerDawn server Codex can start or reach`)
        : `${shown} has no DeerDawn server for Claude Desktop to start`;
  const writeStep = canWrite
    ? ` To have DeerDawn add that entry to ${shown} for you, call apply_setup again with surface "${surface}" and mode "repair".`
    : '';
  return {
    reason: `${missing}, so nothing was written.`,
    next_step: `${command}${writeStep}`,
    offer: {
      global_entry: entryPath,
      command,
      write_with: canWrite ? { tool: 'apply_setup', surface, mode: 'repair' } : null,
    },
  };
}

/** A path under the home directory, written the way a person reads it. */
function tildePath(filePath, home) {
  return filePath.startsWith(home + path.sep) ? `~${filePath.slice(home.length)}` : filePath;
}

/**
 * What adding DeerDawn's `[mcp_servers.deerdawn]` table to Codex's config would
 * write: `text` to write (null for nothing), and `problem`, the reason when
 * nothing can be written safely.
 */
function planCodexRegistration(config, home) {
  const shown = tildePath(config.path, home);
  if (!config.parsed) {
    return { text: null, problem: `${shown} cannot be parsed as TOML (${config.error}), so it was left unchanged. Codex cannot load it either until that is fixed.` };
  }
  // Registered under any name, in any form: nothing to add.
  if (registrationIn(config.entries).valid) return { text: null, problem: null };
  if (config.entries.some(([name]) => name === 'deerdawn')) {
    return { text: null, problem: `${shown} already has an mcp_servers.deerdawn entry, but it gives no command or url, and setup does not add a second one (Codex refuses a file that defines a key twice).` };
  }
  const table = formatCodexMcpTomlConfig(process.env.DEERDAWN_API_URL || 'https://api.deerdawn.com');
  const text = `${config.text.trimEnd()}\n${table}\n`;
  const check = parseToml(text);
  if (!check.ok) {
    return { text: null, problem: `Adding a [mcp_servers.deerdawn] table to ${shown} would make it invalid TOML (line ${check.line}: ${check.error}), so it was left unchanged.` };
  }
  return { text, problem: null };
}

function notConnectedReason(surface, home) {
  if (surface === 'claude_code') {
    return 'Claude Code reads MCP servers from ~/.claude.json (where `claude mcp add` puts them) and a project .mcp.json, and neither registers a DeerDawn server.';
  }
  if (surface === 'codex') {
    const config = readCodexConfig(home);
    return planCodexRegistration(config, home).problem || `${tildePath(config.path, home)} does not register a DeerDawn server Codex can start or reach.`;
  }
  if (surface === 'cursor') return '~/.cursor/mcp.json does not register a DeerDawn server Cursor can start or reach.';
  return 'claude_desktop_config.json does not register a DeerDawn server Claude Desktop can start.';
}

module.exports = {
  applySurfaceSetup,
  inspectLocalSetupStatus,
  recordSurfaceHeartbeat,
  recordSurfaceFailure,
  loadRuntimeSurfaceRegistry,
  findManagedBlock,
  upsertManagedBlock,
  removeManagedBlock,
  getBlockToken,
  findOwnedBlock,
  findForeignBlock,
  globalBlockTokens,
  upsertOwnedBlock,
  removeOwnedBlock,
  removeStaleBlock,
  adoptForeignBlock,
  removePlainTextKeys,
  findPlainTextKeys,
  parseToml,
  codexHomeDir,
  readCodexConfig,
};
