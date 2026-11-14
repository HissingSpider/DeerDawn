import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { loadConfig } from './config.js';
import { DeerdawnClient, HOOK_CLIENT_OPTIONS } from './client.js';
import { resolveHookApiKey } from './hook-api-key.js';
import { redactSecrets } from './redact.js';
import { safeWriteFileSync } from './utils/safe-fs.js';
import { isCaptureDisabled } from './capture-optout.js';
import { resolveWriteTarget } from './write-target.js';

type CommandCapturePayload = Record<string, unknown>;

const MIN_CAPTURE_PLAN_ORDER = 1; // developer_basic or better
const PLAN_ORDER: Record<string, number> = {
  free: 0,
  starter: 1,
  developer_basic: 1,
  growth: 2,
  developer_pro: 2,
  lifetime: 3,
  scale: 3,
  enterprise: 4,
  pilot: 4,
};

type EntitlementCache = {
  plan: string;
  /** The last verdict the API actually gave, and when. Absent until one exists. */
  allowed?: boolean;
  checked_at?: string;
  /** When the check last FAILED (offline, 5xx, timeout). Never a verdict. */
  failed_at?: string;
  /** Which credential the verdict is about: a short hash, never the key. */
  key_id?: string;
};

// A verdict describes an ACCOUNT. With "not eligible" now held for an hour, a
// cache that outlived a sign-out would tell somebody who just signed in to their
// paid account that they are on Free. A cache written for another key — or by a
// version that did not record one — is ignored.
function keyId(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 12);
}

function cachePath(): string {
  const home = process.env.DEERDAWN_HOME || path.join(os.homedir(), '.deerdawn');
  return path.join(home, 'command-capture-entitlement.json');
}

function readCache(): EntitlementCache | null {
  try {
    return JSON.parse(fs.readFileSync(cachePath(), 'utf8')) as EntitlementCache;
  } catch {
    return null;
  }
}

function writeCache(value: EntitlementCache): void {
  try {
    fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
    safeWriteFileSync(cachePath(), JSON.stringify(value, null, 2));
  } catch {
    // non-fatal
  }
}

function isAllowedPlan(plan: string): boolean {
  const normalized = String(plan || 'free').trim().toLowerCase();
  const order = PLAN_ORDER[normalized] ?? 0;
  return order >= MIN_CAPTURE_PLAN_ORDER;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
    const timeoutHandle = setTimeout(() => resolve(''), 300);
    if (typeof (timeoutHandle as any).unref === 'function') {
      (timeoutHandle as any).unref();
    }
  });
}

function parsePayload(raw: string): CommandCapturePayload {
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw) as CommandCapturePayload;
  } catch {
    return {};
  }
}

function getNestedString(source: Record<string, unknown>, pathParts: string[]): string {
  let current: unknown = source;
  for (const part of pathParts) {
    if (!current || typeof current !== 'object') return '';
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' ? current : '';
}

function extractCommand(payload: CommandCapturePayload): { command: string; exitCode: number | null } | null {
  const command = [
    getNestedString(payload, ['tool_input', 'command']),
    getNestedString(payload, ['toolInput', 'command']),
    getNestedString(payload, ['input', 'command']),
    getNestedString(payload, ['arguments', 'command']),
    getNestedString(payload, ['tool_response', 'command']),
  ].find(Boolean) || '';

  if (!command.trim()) return null;

  const exitRaw =
    (payload?.tool_response as any)?.exit_code ??
    (payload?.toolResponse as any)?.exitCode ??
    (payload?.result as any)?.exit_code ??
    (payload?.result as any)?.exitCode ??
    null;
  const exitCode = Number.isFinite(Number(exitRaw)) ? Number(exitRaw) : null;

  return { command: command.trim(), exitCode };
}

function compactCommand(command: string): string {
  // CSL-01: redact secrets BEFORE collapsing/truncating so no credential material is ever
  // recorded or sent to the server (the server also redacts, as defense-in-depth).
  const redacted = redactSecrets(command);
  const singleLine = redacted.replace(/\s+/g, ' ').trim();
  return singleLine.length > 240 ? `${singleLine.slice(0, 237)}...` : singleLine;
}

function commandLabel(command: string): string {
  const firstToken = command.split(/\s+/)[0] || 'command';
  const clean = firstToken.replace(/[^a-zA-Z0-9._-]/g, '') || 'command';
  return clean.slice(0, 32);
}

export async function captureCommandWithClient(client: DeerdawnClient, payload: CommandCapturePayload): Promise<void> {
  const extracted = extractCommand(payload);
  if (!extracted) return;

  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // A write target, not "whatever /active says": a folder called `api` matches
  // every project with "api" in its name, and this hook used to file each Bash
  // command into that guess. Dropped in silence when there is no real target.
  // This runs after every command, nobody reads its output, and the directory
  // starts capturing by itself once a project is linked to it.
  const target = await resolveWriteTarget(client, cwd);
  if (target.kind !== 'target') return;

  const run = compactCommand(extracted.command);
  const summary = `Executed command: ${run}`;
  const note = extracted.exitCode == null ? undefined : `exit_code=${extracted.exitCode}`;
  const surface = process.env.DEERDAWN_SURFACE_ID || 'claude_code';

  await client.recordContextEvent({
    event_type: 'command_confirmed',
    project_id: target.projectId,
    summary,
    metadata: {
      label: commandLabel(run),
      run,
      note,
      cwd,
      surface,
      auto: true,
      silent: true,
    },
  }).catch(() => null);
}

// How long each answer to "may this account capture commands?" is trusted.
//
// The check runs on EVERY Bash call, and only the yes was ever cached usefully:
//   - "not eligible" shared the 5-minute TTL, so a Free account — most accounts —
//     paid a network round-trip a dozen times an hour, for a hook that then did
//     nothing, for as long as it stayed on Free;
//   - a failed check cached nothing, so an offline or rate-limited machine paid
//     the full request timeout on every single command.
// An hour for "no" is long enough to stop the traffic and short enough that an
// upgrade starts capturing the same afternoon. A failure is remembered briefly
// and answered with the last real verdict when there is one: being offline does
// not change what plan you are on.
const PLAN_ALLOWED_TTL_MS = 5 * 60 * 1000;
const PLAN_DENIED_TTL_MS = 60 * 60 * 1000;
const PLAN_ERROR_TTL_MS = 2 * 60 * 1000;

function cacheAgeMs(stamp: string | undefined): number {
  if (!stamp) return Infinity;
  const age = Date.now() - new Date(stamp).getTime();
  // A stamp from the future (clock change, hand edit) is not fresh, it is wrong.
  return Number.isFinite(age) && age >= 0 ? age : Infinity;
}

async function checkPlanGate(client: DeerdawnClient, apiKey: string): Promise<boolean> {
  const id = keyId(apiKey);
  const stored = readCache();
  const cached = stored?.key_id === id ? stored : null;
  const lastVerdict = typeof cached?.allowed === 'boolean' && cached.checked_at ? Boolean(cached.allowed) : null;
  if (lastVerdict !== null) {
    const ttl = lastVerdict ? PLAN_ALLOWED_TTL_MS : PLAN_DENIED_TTL_MS;
    if (cacheAgeMs(cached?.checked_at) < ttl) return lastVerdict;
  }
  if (cacheAgeMs(cached?.failed_at) < PLAN_ERROR_TTL_MS) return lastVerdict ?? false;

  try {
    const org = await client.getOrganizationSettings();
    const plan = String(org?.plan || 'free');
    const allowed = isAllowedPlan(plan);
    writeCache({ plan, allowed, checked_at: new Date().toISOString(), key_id: id });
    return allowed;
  } catch {
    // Keep the last real verdict on disk beside the failure stamp; only the
    // stamp is new. With no verdict at all the answer is "no": capture is a
    // paid feature and an unverifiable account does not get it by default.
    writeCache({
      plan: cached?.plan ?? 'unknown',
      ...(lastVerdict !== null && cached?.checked_at ? { allowed: lastVerdict, checked_at: cached.checked_at } : {}),
      failed_at: new Date().toISOString(),
      key_id: id,
    });
    return lastVerdict ?? false;
  }
}

export async function captureCommandFromHook(): Promise<{ captured: boolean }> {
  // Before stdin, before credentials: an opted-out hook reads nothing.
  if (isCaptureDisabled()) return { captured: false };
  // This repo's key, not the first one saved: see hook-api-key.ts.
  const apiKey = resolveHookApiKey({ claudeConfig: process.env.DEERDAWN_SURFACE_ID !== 'codex' }).apiKey;
  if (!apiKey) return { captured: false };

  const raw = await readStdin();
  const payload = parsePayload(raw);
  const extracted = extractCommand(payload);
  if (!extracted) return { captured: false };

  const client = new DeerdawnClient({ ...loadConfig(), apiKey }, HOOK_CLIENT_OPTIONS);
  const allowed = await checkPlanGate(client, apiKey);
  if (!allowed) return { captured: false };

  await captureCommandWithClient(client, payload);
  return { captured: true };
}
