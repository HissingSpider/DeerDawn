/**
 * flush-session: reads the just-ended session file and pushes it to the
 * DeerDawn extraction API. Supports two modes:
 *
 * Claude Code (called by Stop hook automatically):
 *   deerdawn-mcp flush-session
 *   Claude Code hands a hook its session on STDIN, as one JSON object:
 *   { session_id, transcript_path, cwd, hook_event_name, ... }. It does not set
 *   CLAUDE_SESSION_ID or CLAUDE_TRANSCRIPT_PATH, which is all this used to read,
 *   so every Stop took the Codex branch and no Claude Code transcript was ever
 *   flushed. The env names are still honoured as a fallback for a caller that
 *   sets them by hand.
 *
 * Codex (call manually after a session, e.g. from shell precmd or alias):
 *   deerdawn-mcp flush-session --codex
 *   Finds the most recently modified session file in ~/.codex/sessions/
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Readable } from 'stream';
import { getWorkspaceKey } from './freshness.js';
import { redactSecrets } from './redact.js';
import { isCaptureDisabled } from './capture-optout.js';
// The end-of-session flush must be attributable to the AGENT that did the work,
// not to the moment of flushing — a per-flush id makes one agent look like a new
// one every session and inflates any count of distinct sessions.
import { getAgentSessionId } from './agent-session.js';
import { resolveHookSurface } from './surface.js';
import { hookKeySender, resolveHookApiKeys, type HookKeyChoice } from './hook-api-key.js';
import { clearFlushNotice, recordFlushNotice } from './flush-notice.js';
import { readFlushWatermark, recordFlushWatermark } from './flush-watermark.js';
// The API's own limit for this route, read rather than guessed (see the
// constant's comment in shared-context). A flush that discovers the cap by being
// refused has already lost the session it was flushing.
import { EXTRACTION_BODY_BUDGET_BYTES } from '../../shared-context/src/index.js';
// Was a private copy here. The auth path needs the same deadline, and two
// implementations of "give up eventually" is one too many.
import { timeoutSignal } from './utils/fetch-timeout.js';
import { workspaceHeaders, resolveWorkspace, describeWorkspaceClosure, isWorkspaceClosureCode, WORKSPACE_HEADER } from './workspace-override.js';

const DEERDAWN_DIR = path.join(os.homedir(), '.deerdawn');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

// One attempt may not outlive this. The Stop hook is killed at 60s and takes
// the failure notice with it; three attempts plus their delays stay under that.
const FLUSH_FETCH_TIMEOUT_MS = 12_000;

// Mirrors the trivial-message heuristic in extractionService.js
const TRIVIAL_RE = /^(ok|yes|no|sure|thanks|great|got it|cool|nice|done|right|yep|nope|lgtm|[\p{Emoji}]+)$/iu;
function isTrivial(text: string): boolean {
  const t = text.trim();
  return t.length === 0 || t.length <= 8 && TRIVIAL_RE.test(t);
}

/**
 * The per-message cap, applied AFTER redaction — never before.
 *
 * Slicing first cuts secrets in half, and half a token matches none of the
 * redaction patterns: `sk-ant-api03-AAAA…` cut at 2000 characters is no longer
 * a key to any regex, so the surviving prefix travelled to the server in clear
 * text. Redacting while the token is still whole replaces it with [REDACTED],
 * and the slice then only ever cuts text that has already been cleaned.
 */
const MAX_MESSAGE_CHARS = 2000;

function redactThenClip(text: string): string {
  return redactSecrets(text).slice(0, MAX_MESSAGE_CHARS);
}

// Host-generated user entries that are not something the person typed: slash
// command wrappers, local command output, background task notifications, and
// a `!` shell escape's command and output (`<bash-input>`, `<bash-stdout>`,
// `<bash-stderr>` — the output is a terminal dump, not a prompt, and is exactly
// where a printed secret would come from). Claude Code writes all of them as
// `type:"user"` with STRING content.
const HOST_WRAPPER_PREFIX = /^<(?:command-(?:name|message|args)|local-command-[a-z-]+|task-notification|bash-(?:input|stdout|stderr))>/;
// The line the host writes when the person presses Esc: `[Request interrupted
// by user]`, or `... for tool use]`, as a text block. Nobody typed it. Matched
// only as the WHOLE message, so a prompt that quotes it is still sent.
const INTERRUPT_MARKER = /^\[Request interrupted by user[^\]\n]{0,40}\]$/;

function parseClaudeCodeLine(line: string): { role: string; text: string; cwd?: string } | null {
  try {
    const entry = JSON.parse(line) as {
      type?: string;
      message?: { content?: string | Array<{ type: string; text?: string; thinking?: string }> };
      cwd?: string;
      isMeta?: boolean;
      isCompactSummary?: boolean;
    };
    if (entry.type !== 'user' && entry.type !== 'assistant') return null;
    // Injected by the host (skill bodies, caveats, the compaction summary), not
    // said by either party.
    if (entry.isMeta || entry.isCompactSummary) return null;
    const content = entry.message?.content;
    let raw: string;
    if (typeof content === 'string') {
      // A prompt the person TYPED is stored as a plain string; only tool
      // results and pasted images arrive as block arrays. Requiring an array
      // dropped every typed prompt, so a session flushed the assistant's half
      // alone — and a one-reply session sent nothing at all.
      if (HOST_WRAPPER_PREFIX.test(content.trimStart())) return null;
      raw = content;
    } else if (Array.isArray(content)) {
      // tool_result-only user entries have no text or thinking block and fall
      // out here, as before.
      raw = content
        .filter((c) => c.type === 'text' || c.type === 'thinking')
        .map((c) => c.text || c.thinking || '')
        .join(' ');
    } else {
      return null;
    }
    if (entry.type === 'user' && INTERRUPT_MARKER.test(raw.trim())) return null;
    const text = redactThenClip(raw.trim());
    if (!text) return null;
    if (/^\[(?:BRIDGE|CONTEXT|WATCHER|CONTEXT-FILE)\]/.test(text)) return null;
    return { role: entry.type, text, cwd: entry.cwd };
  } catch {
    return null;
  }
}

/**
 * The name Claude Code gives a project's transcript directory.
 *
 * It is the ABSOLUTE path with every non-alphanumeric character replaced by a
 * dash, case preserved — `/Users/me/Desktop/DeerDawn` becomes
 * `-Users-me-Desktop-DeerDawn`, and a dotted segment produces the doubled dash
 * a worktree shows (`…-DeerDawn--claude-worktrees-festive-yalow-889319`).
 *
 * This used to be base64url. Nothing on disk is ever named that way, so the
 * lookup below could not match on any machine, for anybody — which is how the
 * guessing fallback came to be the only path that ever ran.
 */
export function encodeProjectPath(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Every `<sessionId>.jsonl` under ~/.claude/projects, wherever it landed. */
function transcriptsForSession(sessionId: string): string[] {
  const wanted = `${sessionId}.jsonl`;
  const found: string[] = [];
  try {
    for (const entry of fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(CLAUDE_PROJECTS_DIR, entry.name, wanted);
      try {
        if (fs.statSync(candidate).isFile()) found.push(candidate);
      } catch { /* not there */ }
    }
  } catch { /* unreadable projects dir */ }
  return found;
}

/**
 * The transcript of THIS session, or null.
 *
 * There is no "best guess" branch, and that is the point. The old fallback
 * returned the most recently modified .jsonl across every project directory,
 * so on a machine running more than one Claude Code session — the normal case,
 * and the case we dogfood in — a flush uploaded somebody else's conversation
 * and filed it as this project's memory. A missed flush costs one session's
 * notes; a wrong one ships an unrelated conversation to the server under this
 * project's name and cannot be taken back. So: an exact match on the session
 * id, or nothing.
 *
 * The one search that is not a guess is by session id alone. A session id is a
 * uuid that identifies the conversation, so `<id>.jsonl` sitting under a
 * directory whose name does not line up with CLAUDE_PROJECT_DIR (a symlinked
 * spelling, a host that reports a parent) is still unambiguously this session.
 * Two directories holding the same id is not something Claude Code produces —
 * if it ever happens, that IS ambiguity, and it refuses.
 */
export function findSessionFile(
  sessionId: string | undefined,
  projectDir: string | undefined,
  transcriptPath?: string | null,
): string | null {
  // The host told us outright (the hook's stdin, or the env by hand). Authoritative.
  const directPath = transcriptPath || process.env.CLAUDE_TRANSCRIPT_PATH;
  if (directPath && fs.existsSync(directPath)) return directPath;

  if (!sessionId) return null;
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return null;

  // Where Claude Code writes it for this project directory.
  if (projectDir) {
    const candidate = path.join(CLAUDE_PROJECTS_DIR, encodeProjectPath(projectDir), `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }

  // Same session id, different directory spelling. Exact id, so not a guess.
  const matches = transcriptsForSession(sessionId);
  return matches.length === 1 ? matches[0] : null;
}

// ─── Codex session parser ─────────────────────────────────────────────────────

function parseCodexLine(line: string): { role: string; text: string } | null {
  try {
    const entry = JSON.parse(line) as {
      type?: string;
      payload?: {
        type?: string;
        role?: string;
        content?: Array<{ type: string; text?: string }> | string;
      };
    };
    if (entry.type !== 'response_item') return null;
    const payload = entry.payload;
    if (!payload || payload.type !== 'message') return null;
    if (payload.role !== 'user' && payload.role !== 'assistant') return null;
    const content = payload.content;
    // Redact, THEN clip — same order and same reason as the Claude Code parser.
    const text = redactThenClip((
      Array.isArray(content)
        ? content.filter(c => c.type === 'input_text' || c.type === 'text').map(c => c.text || '').join(' ')
        : String(content || '')
    ).trim());
    if (!text) return null;
    return { role: payload.role, text };
  } catch {
    return null;
  }
}

function extractCodexCwd(lines: string[]): string {
  for (const line of lines.slice(0, 5)) {
    try {
      const entry = JSON.parse(line) as { type?: string; payload?: { cwd?: string } };
      if (entry.type === 'session_meta' && entry.payload?.cwd) return entry.payload.cwd;
    } catch { /* skip */ }
  }
  return process.cwd();
}

function findNewestJsonl(dir: string, maxAgeMs = 120_000): string | null {
  const cutoff = Date.now() - maxAgeMs;
  let newestFile: string | null = null;
  let newestMtime = 0;

  function walk(d: string): void {
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.jsonl')) {
          const mtime = fs.statSync(full).mtimeMs;
          if (mtime > cutoff && mtime > newestMtime) {
            newestFile = full;
            newestMtime = mtime;
          }
        }
      }
    } catch { /* skip unreadable */ }
  }

  if (fs.existsSync(dir)) walk(dir);
  return newestFile;
}

async function flushCodexSession(apiKey: string, apiUrl: string): Promise<void> {
  const sessionFile = findNewestJsonl(CODEX_SESSIONS_DIR);
  if (!sessionFile) {
    console.error('[DeerDawn] No recent Codex session found');
    return;
  }

  const lines = fs.readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean);
  const cwd = extractCodexCwd(lines);
  const chunks: Array<{ role: string; text: string }> = [];

  for (const line of lines) {
    const parsed = parseCodexLine(line);
    if (!parsed || isTrivial(parsed.text)) continue;
    chunks.push({ role: parsed.role, text: redactSecrets(parsed.text) });
  }

  if (chunks.length < 2) return;

  // Same body limit, same trim, same visibility as the Claude Code path — a
  // Codex session is no less lost when its flush is refused.
  const workspaceKey = getWorkspaceKey(cwd);
  const fitted = fitChunksToBudget(chunks, (sending) => JSON.stringify({
    session_id: getAgentSessionId(),
    // Identified, never defaulted: this path runs only when Codex was named
    // (--codex, DEERDAWN_SURFACE_ID=codex, or the server's Codex handshake).
    tool: 'codex',
    chunks: sending,
    session_context: { cwd, host: 'codex', surface_type: 'code', workspace_key: workspaceKey },
  }));

  try {
    const res = await fetch(`${apiUrl}/api/v1/context/extraction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey, ...workspaceHeaders({ projectDir: cwd }) },
      body: fitted.body,
      signal: timeoutSignal(FLUSH_FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      const data = await res.json() as any;
      const projectName = data?.project?.project_name ?? 'project';
      const sentCount = fitted.chunks.length - (fitted.dropped ? 1 : 0);
      console.error(`[DeerDawn] Codex session briefed — ${projectName} (${sentCount} messages)`);
      if (fitted.dropped) {
        recordFlushNotice({
          kind: 'trimmed', at: new Date().toISOString(), sent: sentCount, total: chunks.length, project_dir: cwd,
        });
      } else {
        clearFlushNotice();
      }
    } else {
      const detail = await readErrorDetail(res);
      console.error(
        `[DeerDawn] Codex session NOT saved — API returned ${res.status}${detail ? ` (${detail})` : ''}.`
        + ' The next session will report this.',
      );
      recordFlushNotice({ kind: 'failed', at: new Date().toISOString(), status: res.status, reason: detail, project_dir: cwd });
    }
  } catch (err: any) {
    console.error(`[DeerDawn] Codex session NOT saved — ${err?.message ?? 'unknown error'}. The next session will report this.`);
    recordFlushNotice({ kind: 'failed', at: new Date().toISOString(), status: null, reason: err?.message ?? 'unknown error', project_dir: cwd });
  }
}

// ─── Fitting a transcript into one request ───────────────────────────────────

/**
 * The API's own explanation of a refusal, when it gave one.
 *
 * Wrapped completely: a body that cannot be read must never turn a clean 4xx
 * into an exception on the failure path — that would send a non-retryable
 * refusal back through the retry loop and change what gets recorded about it.
 */
async function readErrorBody(res: { text?: () => Promise<string> }): Promise<{ code: string | null; detail: string | null }> {
  try {
    if (typeof res.text !== 'function') return { code: null, detail: null };
    const body = await res.text();
    if (!body) return { code: null, detail: null };
    try {
      const parsed = JSON.parse(body);
      return {
        code: typeof parsed?.error === 'string' ? parsed.error : null,
        detail: parsed?.message ? String(parsed.message).slice(0, 200) : body.slice(0, 200),
      };
    } catch {
      return { code: null, detail: body.slice(0, 200) };
    }
  } catch {
    return { code: null, detail: null };
  }
}

/** Just the message, for the callers that have nothing to do with the code. */
async function readErrorDetail(res: { text?: () => Promise<string> }): Promise<string | null> {
  return (await readErrorBody(res)).detail;
}

export interface FlushChunk { role: string; text: string }

export function truncationNote(dropped: number, total: number): string {
  return `[DeerDawn] Transcript truncated to fit the sync limit — the earliest ${dropped} of ${total} `
    + 'messages were not sent. What follows is the end of the session.';
}

/**
 * The largest TAIL of the transcript that fits in one request body.
 *
 * A whole long session does not fit: past the limit the API refuses the body and
 * the flush used to be dropped with a stderr line, losing everything. Sending
 * the end rather than the beginning is the deliberate choice — the decisions, the
 * state and the unfinished work are at the end of a session; the opening is
 * usually the part already captured by earlier syncs.
 *
 * The omission is stated IN what is sent, so a trimmed flush can never be read
 * as a complete one, and the caller is told how much went missing.
 */
export function fitChunksToBudget(
  chunks: FlushChunk[],
  serialize: (chunks: FlushChunk[]) => string,
  budget: number = EXTRACTION_BODY_BUDGET_BYTES,
): { chunks: FlushChunk[]; body: string; dropped: number } {
  const whole = serialize(chunks);
  if (Buffer.byteLength(whole, 'utf8') <= budget) return { chunks, body: whole, dropped: 0 };

  const total = chunks.length;
  const build = (keep: number) => {
    const tail = chunks.slice(total - keep);
    const withNote: FlushChunk[] = [{ role: 'user', text: truncationNote(total - keep, total) }, ...tail];
    return { chunks: withNote, body: serialize(withNote), dropped: total - keep };
  };

  // Binary search the largest tail that fits. The note itself is included in
  // every candidate, so the answer is honest about its own cost.
  let best = build(0);
  let lo = 1;
  let hi = total;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = build(mid);
    if (Buffer.byteLength(candidate.body, 'utf8') <= budget) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

// ─── What the host said about this session ───────────────────────────────────

type HookStdin = Readable & { isTTY?: boolean };

/** The part of Claude Code's hook payload the flush needs. Everything optional. */
export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
}

export interface FlushOptions {
  /** Parsed hook stdin. Only the CLI path has one — see runFlushSessionCli. */
  hookInput?: HookInput | null;
  /** Flush the newest Codex session instead of a Claude Code transcript. */
  codex?: boolean;
  /**
   * The key to send with. Only the running server passes one (its live
   * credential, on a signal-time flush); a hook resolves it per repo.
   */
  apiKey?: string | null;
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Read the hook payload Claude Code writes to a hook's stdin.
 *
 * Never throws and never waits long: a TTY means a human ran the command and
 * there is nothing to read; a pipe nobody closes gives up after `timeoutMs`; and
 * anything that is not a JSON object is treated as no payload at all. A Stop hook
 * that hangs holds up the end of every turn.
 */
export async function readHookInput(
  stream: HookStdin = process.stdin,
  timeoutMs = 1000,
): Promise<HookInput | null> {
  if (stream.isTTY) return null;
  const raw = await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (text: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { stream.pause(); } catch { /* not pausable */ }
      resolve(text);
    };
    const timer = setTimeout(() => finish(Buffer.concat(chunks).toString('utf8')), timeoutMs);
    (timer as any).unref?.();
    stream.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', () => finish(''));
  });
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return {
      session_id: pickString(parsed.session_id),
      transcript_path: pickString(parsed.transcript_path),
      cwd: pickString(parsed.cwd),
    };
  } catch {
    return null;
  }
}

/**
 * `deerdawn-mcp flush-session` — the only caller that may read stdin.
 *
 * The signal-time flush inside the running MCP server must never do this: that
 * process's stdin is the JSON-RPC channel, and reading it would eat the client's
 * messages.
 */
export async function runFlushSessionCli(
  argv: string[] = process.argv,
  stdin: HookStdin = process.stdin,
): Promise<void> {
  // Opted out: do not even read the hook payload, and say nothing — the "no
  // session on stdin" line below would read as a fault.
  if (isCaptureDisabled()) return;
  // Codex has no Stop hook and no stdin payload; it is asked for by name. The
  // surface env is the same explicit signal capture-worktree-change honours.
  const codex = argv.includes('--codex') || process.env.DEERDAWN_SURFACE_ID === 'codex';
  const hookInput = codex ? null : await readHookInput(stdin);
  if (!codex && !hookInput?.session_id && !hookInput?.transcript_path && !sessionIdFromEnv() && !process.env.CLAUDE_TRANSCRIPT_PATH) {
    // This used to fall through to the Codex branch, which is how every Claude
    // Code Stop ended up there. Say what to do instead of guessing a host.
    console.error(
      '[DeerDawn] flush-session: no Claude Code session on stdin — nothing to flush.'
      + ' For a Codex session run `flush-session --codex`.',
    );
    return;
  }
  return flushSession({ hookInput, codex });
}

function sessionIdFromEnv(): string | undefined {
  // CLAUDE_SESSION_ID is the name this file always read; CLAUDE_CODE_SESSION_ID
  // is the one Claude Code actually exports to the processes it spawns.
  return pickString(process.env.CLAUDE_SESSION_ID) ?? pickString(process.env.CLAUDE_CODE_SESSION_ID);
}

function isCompleteJson(line: string): boolean {
  try { JSON.parse(line); return true; } catch { return false; }
}

// ─── Main flush entry point ───────────────────────────────────────────────────

export async function flushSession(options: FlushOptions = {}): Promise<void> {
  // Here rather than in the CLI wrapper, so the signal-time flush inside the
  // running MCP server honours it too — that one never passes through a hook.
  if (isCaptureDisabled()) return;
  const hookInput = options.hookInput ?? null;
  const sessionId = hookInput?.session_id ?? sessionIdFromEnv();
  // CLAUDE_PROJECT_DIR is the project root; the payload's cwd is wherever the
  // session has `cd`-ed to since, so it only stands in when the root is unknown.
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? hookInput?.cwd ?? process.cwd();

  // Load credentials: the key the DeerDawn server for THIS repo is started
  // with — its local/project/user registration's env block, then the shell,
  // then ~/.deerdawn/credentials.json. Reading the shell and then the per-user
  // file only made every repo's hook use whichever key the server copied to
  // that file first (persistBootEnvKey), so a team repo's transcript flushed
  // into a personal workspace. See hook-api-key.ts. The flush the running
  // server does on a signal passes its live key instead: it knows exactly which
  // key this session is using.
  //
  // The server's own key needs no fallback: it is the one already working.
  const passedKey = options.apiKey?.trim();
  const keyChoice: HookKeyChoice = passedKey
    ? { apiKey: passedKey, source: null, fallbacks: [], home: os.homedir() }
    : (options.codex ? resolveHookApiKeys({ claudeConfig: false }) : resolveHookApiKeys({ projectDir }));
  const apiKey = keyChoice.apiKey;
  if (!apiKey) return;

  // Load config for API URL
  let apiUrl = process.env.DEERDAWN_API_URL ?? 'https://api.deerdawn.com';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(DEERDAWN_DIR, 'config.json'), 'utf8'));
    if (cfg.api_url) apiUrl = cfg.api_url;
  } catch { /* use default */ }

  // Codex mode: find the most recent session in ~/.codex/sessions/. Only when
  // asked for — "no Claude session id" is not evidence of a Codex session, and
  // treating it as one sent every Claude Code Stop down this branch.
  if (options.codex) {
    if (fs.existsSync(CODEX_SESSIONS_DIR)) {
      return flushCodexSession(apiKey, apiUrl);
    }
    return;
  }

  // Find session file
  const sessionFile = findSessionFile(sessionId, projectDir, hookInput?.transcript_path);
  if (!sessionFile) {
    // Nothing identified this session at all (a signal-time flush in a host that
    // is not Claude Code). Not a refusal worth a line — there was never a claim.
    if (!sessionId && !hookInput?.transcript_path && !process.env.CLAUDE_TRANSCRIPT_PATH) return;
    // Deliberately a refusal, not a fallback. See findSessionFile: the only
    // thing left to send would be a transcript belonging to some other session.
    console.error(
      `[DeerDawn] No transcript for session ${sessionId ?? '(unknown)'} under ~/.claude/projects `
      + '— skipping flush rather than sending another session\'s conversation.',
    );
    return;
  }

  // Parse the lines no earlier flush of this session has sent. Stop fires every
  // turn, so without the mark each turn re-sends the whole conversation so far.
  // A transcript SHORTER than its mark was rewritten underneath us; start over.
  const lines = fs.readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean);
  // The host may still be appending. A final line that is not yet whole JSON
  // would be skipped as unparseable AND counted by the mark, and so never sent
  // once finished. Leave it for the next flush.
  if (lines.length && !isCompleteJson(lines[lines.length - 1])) lines.pop();
  const watermarkKey = sessionId ?? sessionFile;
  const flushedLines = readFlushWatermark(watermarkKey);
  const freshLines = flushedLines <= lines.length ? lines.slice(flushedLines) : lines;
  const chunks: Array<{ role: string; text: string }> = [];
  for (const line of freshLines) {
    const parsed = parseClaudeCodeLine(line);
    if (!parsed || isTrivial(parsed.text)) continue;
    chunks.push({ role: parsed.role, text: redactSecrets(parsed.text) });
  }

  if (chunks.length < 2) {
    // Not enough content to extract anything meaningful. The mark stays where it
    // is, so these lines ride along with the next turn's rather than being lost.
    return;
  }

  // Resolved ONCE: fitting the body calls serialize several times, and this one
  // shells out to git. It is a property of the directory, not of the payload.
  const workspaceKey = getWorkspaceKey(projectDir);
  // A Stop hook payload, or Claude Code's own hook env, identifies the tool; the
  // signal-time flush inside the server has only its handshake to go on.
  const toolIdentified = resolveHookSurface({ hookPayload: Boolean(hookInput) }).identified;
  const serialize = (sending: FlushChunk[]) => JSON.stringify({
    // The host's session id when it supplied one (stable, and ties the write to
    // the transcript); otherwise this process's agent id — never a fresh stamp.
    session_id: sessionId ?? getAgentSessionId(),
    tool: 'claude_code',
    // Same rule as every save (client.ts): a defaulted tool is said to be one,
    // so the capture is not credited to Claude Code by guess.
    ...(toolIdentified ? {} : { tool_identified: false }),
    chunks: sending,
    session_context: {
      cwd: projectDir,
      conversation_ref: sessionId ?? '',
      host: 'claude_code',
      surface_type: 'code',
      workspace_key: workspaceKey,
    },
  });

  // Fit it into ONE request rather than being refused by the body limit. A long
  // session is precisely the session worth keeping, and it was the only one this
  // used to drop.
  const fitted = fitChunksToBudget(chunks, serialize);
  const body = fitted.body;
  if (fitted.dropped) {
    console.error(
      `[DeerDawn] Transcript too large for one sync — sent the last ${fitted.chunks.length - 1} of ${chunks.length} messages`,
    );
  }

  const noteFailure = (status: number | null, reason: string | null) => {
    recordFlushNotice({
      kind: 'failed',
      at: new Date().toISOString(),
      status,
      reason,
      project_dir: projectDir,
    });
  };

  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 2000;

  // Resolved once, for the same reason the workspace key above is: the answer is
  // a property of the directory, not of the attempt. This hook is a separate
  // process from the MCP server and never receives the .mcp.json `env` block the
  // host hands the server, so the project directory is the second source — or a
  // team's transcript goes to the author's personal workspace with no header at
  // all. See workspace-override.ts.
  const targeted = resolveWorkspace({ projectDir });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(targeted.workspace ? { [WORKSPACE_HEADER]: targeted.workspace } : {}),
  };
  // A pinned key the API has revoked (a team removal revokes them all) is
  // retried with the shell's and then credentials.json's, as the server does
  // on its own 401 — or every Stop fails while the session works. See
  // hook-api-key.ts. Kept across attempts: a key that was accepted stays.
  const keys = hookKeySender(keyChoice);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await keys.send((key) => fetch(`${apiUrl}/api/v1/context/extraction`, {
        method: 'POST',
        headers: { ...headers, 'X-Api-Key': key },
        body,
        signal: timeoutSignal(FLUSH_FETCH_TIMEOUT_MS),
      }));

      if (res.ok) {
        const data = await res.json() as any;
        const projectName = data?.project?.project_name ?? data?.session?.project_id ?? 'project';
        const sentCount = fitted.chunks.length - (fitted.dropped ? 1 : 0);
        console.error(`[DeerDawn] Session briefed — ${projectName} (${sentCount} messages)`);
        // Only a flush that LANDED moves the mark: a refused or failed one leaves
        // its lines to be sent again by the next Stop.
        recordFlushWatermark(watermarkKey, lines.length);
        // A landed flush clears any earlier failure; a TRIMMED one leaves its own
        // notice, because part of that session genuinely did not arrive.
        if (fitted.dropped) {
          recordFlushNotice({
            kind: 'trimmed',
            at: new Date().toISOString(),
            sent: sentCount,
            total: chunks.length,
            project_dir: projectDir,
          });
        } else {
          clearFlushNotice();
        }
        return;
      }

      // 4xx errors are not retryable
      if (res.status < 500) {
        // Read the API's own message where there is one — it says what to do
        // (the 413 names the cap), and this is the last place it can be recorded.
        const { code, detail } = await readErrorBody(res);
        // A closed workspace is not a malformed flush, and "API returned 403"
        // is the description under which nobody ever looks at the workspace the
        // repo asked for. Name it, and say the transcript was NOT filed
        // somewhere else instead.
        const workspaceClosed = targeted.workspace && isWorkspaceClosureCode(code)
          ? describeWorkspaceClosure(targeted.workspace, code, targeted.source, targeted.configPath)
          : null;
        console.error(
          workspaceClosed
            ? `[DeerDawn] Session NOT saved. ${workspaceClosed}`
            : `[DeerDawn] Session NOT saved — API returned ${res.status}${detail ? ` (${detail})` : ''}.`
              + ' The next session will report this.',
        );
        noteFailure(res.status, workspaceClosed ?? detail);
        return;
      }

      // 5xx — retry unless final attempt
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      } else {
        console.error(
          `[DeerDawn] Session NOT saved — API returned ${res.status} after ${MAX_ATTEMPTS} attempts.`
          + ' The next session will report this.',
        );
        noteFailure(res.status, `no response after ${MAX_ATTEMPTS} attempts`);
      }
    } catch (err: any) {
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      } else {
        console.error(
          `[DeerDawn] Session NOT saved — ${err?.message ?? 'unknown error'}. The next session will report this.`,
        );
        noteFailure(null, err?.message ?? 'unknown error');
      }
    }
  }
}
