// DeerDawn surface id for THIS local stdio MCP process.
//
// Every product event the local server emits carries a `surface` so distinct-
// tool metrics (second_tool_connected, per-tool briefs delivered) can tell
// Claude Code from Cursor from Codex from anything else. Historically the only
// source was the DEERDAWN_SURFACE_ID env var, which generated configs never set,
// AND the clientInfo fallback only recognised three keywords — so every other
// MCP host (Windsurf, Cline, Zed, VS Code, mcp-inspector, …) landed surface-NULL
// and showed up in the dashboard as a phantom "unknown" tool, excluded from
// distinct-tool counting even though it is a real, identifiable second surface.
//
// The remote server (apps/api/src/routes/mcp.js) already keeps the raw clientInfo
// name when it can't map it; this module now mirrors that. Two distinct outputs:
//
//   • rendering profile  (resolveLocalSurface)      — must be a profile a context
//     adapter actually understands, so unmapped clients fall back to claude_code.
//   • telemetry identity (resolveLocalSurfaceOrNull) — the tool's REAL identity:
//     a canonical id when mapped, else a stable slug of its self-reported name,
//     null only when the handshake carried no name at all (never a guess).
//
// Priority for both: explicit env (authoritative, set by tool-specific configs
// and the Codex hook path) → detected clientInfo → default/null.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { managedHookStatus } from './hook-commands.js';

// Canonical profile id — only set for clients we have a context adapter for.
let detectedSurface: string | null = null;
// Real tool identity for telemetry — canonical id OR a slug of the raw name.
let detectedIdentity: string | null = null;
// Raw self-reported client name/version, kept verbatim for event metadata so
// unmapped clients are diagnosable and the mapping can be extended from data.
let detectedClientName: string | null = null;
let detectedClientVersion: string | null = null;

// Reserved non-identifying surfaces — a client must never resolve to one of
// these (they mark "couldn't identify" on the dashboard and in second_tool).
const RESERVED_SURFACES = new Set(['unknown', 'unknown_web']);

/**
 * Map a self-reported client name to a canonical profile id, or null.
 *
 * Claude Code is matched by its exact name only. It used to be any name that
 * contained "claude", which took Claude Desktop (and any other Claude client) for
 * Claude Code: a Desktop boot wrote Claude Code's hooks and CLAUDE.md. The name
 * Claude Code sends in its initialize message is `claude-code` (checked against
 * the real client, version 2.1.282: {"name":"claude-code","title":"Claude Code"}).
 * A different "claude*" name is a client DeerDawn cannot place, so it falls
 * through to a slug of its own name, which no boot writes files for.
 *
 * Codex's real name is `codex-mcp-client` (checked against codex-cli 0.137.0) and
 * Cursor's `cursor-vscode` (the name in this repo's fixtures); both are still
 * recognised by the words in them.
 */
function canonicalSurface(lowerName: string): string | null {
  if (lowerName === 'claude-code') return 'claude_code';
  if (lowerName.includes('cursor')) return 'cursor';
  if (lowerName.includes('codex') || lowerName.includes('openai')) return 'codex';
  return null;
}

/** Stable, low-cardinality slug of a raw client name for an unmapped tool. */
function slugSurface(rawName: string): string | null {
  const slug = rawName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  if (!slug || RESERVED_SURFACES.has(slug)) return null;
  return slug;
}

/** Called by index.ts when the initialize handshake completes. */
export function recordDetectedSurface(clientName?: string | null, clientVersion?: string | null): void {
  if (clientName && detectedClientName === null) detectedClientName = String(clientName).slice(0, 64);
  if (clientVersion && detectedClientVersion === null) detectedClientVersion = String(clientVersion).slice(0, 32);

  const raw = String(clientName || '').trim();
  if (!raw) return;

  const canonical = canonicalSurface(raw.toLowerCase());
  if (canonical) {
    if (!detectedSurface) detectedSurface = canonical;
    if (!detectedIdentity) detectedIdentity = canonical;
    return;
  }
  // Unmapped but named: keep the real identity for telemetry. Leave the
  // rendering profile at its safe default — there's no adapter for this client,
  // so resolveLocalSurface() must not hand it a profile nothing can render.
  if (!detectedIdentity) detectedIdentity = slugSurface(raw);
}

/** Surface for API calls that render context — must be a known profile. */
export function resolveLocalSurface(): string {
  return process.env.DEERDAWN_SURFACE_ID || detectedSurface || 'claude_code';
}

/**
 * The rendering profile ONLY when it was positively identified — the env var a
 * tool-specific config sets, or a handshake name that maps to a profile. null
 * when resolveLocalSurface() would be falling back to its 'claude_code' default.
 * What a session row or a save may be credited to by name: "last session … in
 * Claude Code" must never be a guess for a Windsurf or Zed session.
 */
export function resolveIdentifiedSurface(): string | null {
  return process.env.DEERDAWN_SURFACE_ID || detectedSurface || null;
}

/**
 * The tool a HOOK process is running for, and whether that is known rather than
 * defaulted. A hook is its own process: it never sees the server's handshake, so
 * resolveIdentifiedSurface() is null in it unless a config set
 * DEERDAWN_SURFACE_ID. Two more signals are positive identification here:
 *   - the host handed a hook payload (`hookPayload`), which only the host whose
 *     settings installed the hook does;
 *   - CLAUDE_PROJECT_DIR, which Claude Code exports to the hooks it runs.
 * Without any of them the tool is the claude_code default, said to be one
 * (`identified: false`), the same rule saves follow (client.ts tool_identified).
 */
export function resolveHookSurface(options: { hookPayload?: boolean } = {}): { tool: 'claude_code' | 'codex'; identified: boolean } {
  if (process.env.DEERDAWN_SURFACE_ID === 'codex') return { tool: 'codex', identified: true };
  const identified = resolveIdentifiedSurface() === 'claude_code'
    || Boolean(options.hookPayload)
    || Boolean(process.env.CLAUDE_PROJECT_DIR);
  return { tool: 'claude_code', identified };
}

/** Surface for telemetry — the tool's real identity, null when truly unknown. */
export function resolveLocalSurfaceOrNull(): string | null {
  return process.env.DEERDAWN_SURFACE_ID || detectedIdentity || detectedSurface || null;
}

/** Raw client identity for event metadata — lets unmapped surfaces be diagnosed. */
export function getDetectedClientMeta(): { client_name: string | null; client_version: string | null } {
  return { client_name: detectedClientName, client_version: detectedClientVersion };
}

/**
 * True when our SessionStart hook has already shown the user the brief card, so
 * start_session must not ask the agent to print it a second time.
 *
 * Deliberately strict, and deliberately asymmetric about which way it fails.
 * resolveLocalSurface() defaults UNMAPPED clients to 'claude_code' for rendering
 * purposes; trusting that here would mean a user running Windsurf on a machine
 * that also has Claude Code installed gets no card at all, because we'd find the
 * hook in ~/.claude/settings.json and suppress. So this uses the telemetry
 * identity, which never guesses, and requires BOTH an exact claude_code match and
 * a DeerDawn-managed SessionStart hook actually present on disk.
 *
 * Showing the card twice is a blemish. Never showing it defeats the feature.
 */
export function hasSessionStartHook(): boolean {
  if (resolveLocalSurfaceOrNull() !== 'claude_code') return false;
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    // A hook that is written but cannot START is not a hook. Every install until
    // this fix wrote `deerdawn-mcp ...`, a bin npx never puts on PATH, and this
    // check — reading only the tag — called that "present" and suppressed the
    // card the dead hook was never going to show. Same asymmetry as above: when
    // in doubt, let the agent relay it.
    return managedHookStatus(settings, 'SessionStart').runnable;
  } catch {
    // No settings file, unreadable, or malformed — assume no hook and let the
    // agent relay the card. See the asymmetry note above.
    return false;
  }
}
