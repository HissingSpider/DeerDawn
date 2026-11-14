// What a product event may say about the machine it came from.
//
// Product events are relayed to PostHog. Four of them carried `path:
// process.cwd()` — a home directory, a user name, and very often a client or
// employer name, on every tool call — and the failure event carried the raw
// exception message, which routinely quotes a file path ("ENOENT: no such file
// '/Users/...'"), a URL, or the rejected input itself. None of that is needed to
// answer the questions those events exist for ("does the runtime start?", "which
// tool fails, and how?"), so none of it is sent.
//
// Two layers: the call sites in index.ts build events from the two helpers
// below, and DeerdawnClient.recordProductEvent runs every outgoing event through
// sanitizeProductEvent, because index.ts dispatches the CLI as an import side
// effect and cannot be reached by a test — the client can.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { redactSecrets } from './redact.js';

export type TelemetryPathCategory = 'git_repo' | 'home_dir' | 'other_dir' | 'unknown';

/** Where the server was started, as a category. Never a name, never a basename. */
export function telemetryPathCategory(cwd: string | null | undefined): TelemetryPathCategory {
  if (!cwd) return 'unknown';
  try {
    const resolved = path.resolve(cwd);
    if (resolved === path.resolve(os.homedir())) return 'home_dir';
    let current = resolved;
    const root = path.parse(current).root;
    while (current !== root) {
      if (fs.existsSync(path.join(current, '.git'))) return 'git_repo';
      current = path.dirname(current);
    }
    return 'other_dir';
  } catch {
    return 'unknown';
  }
}

const CODE_RE = /^[A-Za-z][A-Za-z0-9_]{1,47}$/;

/**
 * A failure as a short machine code: `http_404`, `ECONNREFUSED`, `mcp_-32602`,
 * or the error class. Never the message.
 */
export function telemetryErrorCode(error: unknown): string {
  const e = error as { response?: { status?: unknown }; code?: unknown; name?: unknown } | null;
  const status = Number(e?.response?.status);
  if (Number.isInteger(status) && status >= 100 && status <= 599) return `http_${status}`;
  if (typeof e?.code === 'string' && CODE_RE.test(e.code)) return e.code;
  if (typeof e?.code === 'number' && Number.isInteger(e.code)) return `mcp_${e.code}`;
  const name = typeof e?.name === 'string' ? e.name.replace(/[^A-Za-z0-9_]/g, '').slice(0, 48) : '';
  return name || 'unknown_error';
}

const MAX_TELEMETRY_STRING = 120;
// An absolute POSIX path, a home-relative path, a Windows drive path or a UNC
// path. The lookbehind keeps the slashes inside a URL (`https://host/x`) and a
// relative `a/b` from reading as the start of one.
const ABSOLUTE_PATH = /(?<![\w/:.~-])(?:~|[A-Za-z]:)?[\\/][^\s'"`<>|]{1,512}/g;

/** Free text made safe to relay: secrets masked, filesystem paths removed, clipped. */
export function scrubTelemetryText(value: string): string {
  const scrubbed = redactSecrets(value).replace(ABSOLUTE_PATH, '[path]');
  return scrubbed.length > MAX_TELEMETRY_STRING ? `${scrubbed.slice(0, MAX_TELEMETRY_STRING - 1)}…` : scrubbed;
}

const PATH_CATEGORY_RE = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * The chokepoint. `path` survives only as a bare category token — an MCP event
 * has no URL path to report, so anything with a separator in it is a filesystem
 * path somebody passed by habit — and every string in `metadata` is scrubbed.
 */
export function sanitizeProductEvent<T extends { path?: string | null; metadata?: Record<string, unknown> }>(event: T): T {
  const out: T = { ...event };
  if (typeof out.path === 'string' && !PATH_CATEGORY_RE.test(out.path)) out.path = null;
  if (out.metadata && typeof out.metadata === 'object') {
    const metadata: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(out.metadata)) {
      metadata[key] = typeof value === 'string' ? scrubTelemetryText(value) : value;
    }
    out.metadata = metadata;
  }
  return out;
}
