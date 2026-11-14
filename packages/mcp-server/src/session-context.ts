/**
 * session-context: emits the current project brief as a Claude Code / Codex
 * SessionStart hook payload, so the agent has fresh project context in-context
 * WITHOUT depending on it remembering to call start_session.
 *
 * Why this exists: project-sync writes .deerdawn-context.md in the background on
 * MCP connect, which races Claude Code reading the @.deerdawn-context.md include
 * at session start. A SessionStart hook blocks session start, so fetching the
 * brief here guarantees the agent sees current context every session.
 *
 * Always prints a valid SessionStart hook JSON object to stdout. Not signed in:
 * the person is shown a sign-in link. Offline or slow API: the model is told the
 * context is degraded.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { computeFreshness, getWorkspaceKey } from './freshness.js';
import { hookKeySender, resolveHookApiKeys } from './hook-api-key.js';
import { locationHeaders, legacyLocationQuery, locationAcknowledged, LOCATION_ACK_HEADER } from './location-headers.js';
import { WORKSPACE_HEADER, resolveWorkspace, describeHookWorkspaceRefusal, isWorkspaceClosureCode } from './workspace-override.js';
import { startDetachedSignIn } from './auth.js';
import { resolveHookSurface } from './surface.js';
import { readSetupChoices, writeSetupChoices } from './setup-choices.js';
import {
  routingFrame, noMatchHint, rememberRepoProject, lastKnownRepoProject, lastKnownHint,
  type ActiveRouting,
} from './routing-hint.js';

const DEERDAWN_DIR = path.join(os.homedir(), '.deerdawn');
const CONFIG_PATH = path.join(DEERDAWN_DIR, 'config.json');

// SessionStart hooks block session start — keep the fetch tight so a slow or
// unreachable API never stalls the user. On timeout we emit the reminder.
const FETCH_TIMEOUT_MS = 3500;
// ONE retry, for a network failure, a timeout or a 5xx only. A single blip used
// to cost the whole session its brief, and the agent then worked from nothing
// (or from whatever a connector guessed). Two tight attempts stay well inside
// the hook's own timeout; a 4xx is an answer and is never retried.
const RETRY_DELAY_MS = 400;
// Starting a sign-in is one small POST; the same rule applies.
const SIGN_IN_TIMEOUT_MS = 3000;

// For the MODEL, and descriptive. This used to order the model to call
// start_session before responding, which put a DeerDawn call ahead of whatever
// the person had actually asked. It now says what is true and leaves the next
// move to the person's request: start_session is there when the work calls for
// it, and is described in the server's own instructions.
const FALLBACK_CONTEXT =
  '[DeerDawn] Session memory is connected, but no saved brief matched this directory, so none was loaded. DeerDawn can start one for this project when the person wants their work here remembered.';

// Not signed in: what the model is told. The PERSON is shown the sign-in link
// (systemMessage); the model is told only that, so it does not try a call that
// cannot succeed or invent a brief that was never loaded.
const NOT_SIGNED_IN_CONTEXT =
  '[DeerDawn] Not signed in on this machine, so no project brief was loaded. The person has been shown a sign-in link.';

// Emitted when the API was reachable-but-failing or timed out. Distinct from the
// benign fallback above so the agent knows context is degraded and may be stale,
// rather than assuming sync is healthy.
const DEGRADED_CONTEXT =
  '[DeerDawn] ⚠ Could not reach DeerDawn session memory (degraded) — project context may be stale or unavailable this session. Verify any loaded context before relying on it; retry start_session shortly.';

/**
 * Did the API refuse the WORKSPACE this repo asks for? Then say so, once.
 *
 * Three answers mean the workspace itself is closed to this key, and none of
 * them is an outage: 403 workspace_forbidden (not a member), 403
 * subscription_inactive (the workspace stopped paying), 409 workspace_inactive
 * (the same, reported per write). Reading the body is wrapped completely —
 * a body that cannot be parsed must never turn a refusal into a thrown hook.
 */
async function workspaceRefusal(res: Response, workspace: string): Promise<string | null> {
  if (res.status !== 403 && res.status !== 409) return null;
  let code: unknown = null;
  try {
    const body = await res.clone().json() as { error?: unknown } | null;
    code = body?.error ?? null;
  } catch { /* an unreadable body is not a workspace refusal */ }
  return isWorkspaceClosureCode(code) ? describeHookWorkspaceRefusal(workspace, code) : null;
}

/**
 * Emit the SessionStart hook payload.
 *
 * Two audiences, two channels, one hook:
 *
 *   additionalContext -> the MODEL. Wrapped in a system reminder and inserted
 *                        into the context window. The user never sees it.
 *   systemMessage     -> the USER. Rendered directly in their transcript.
 *
 * Until now DeerDawn only used the first, which is why a product that runs on
 * every single session was completely invisible to the person paying for it. The
 * card goes in systemMessage because that path is deterministic: it renders before
 * the model responds, costs no output tokens, and cannot be summarised away by an
 * agent that decided the brief wasn't worth mentioning.
 *
 * sessionTitle is free real estate — naming the session after the project the
 * memory came from makes the transcript list self-describing.
 */
function emit(additionalContext: string, card?: string | null, projectName?: string | null): void {
  const hookSpecificOutput: Record<string, string> = {
    hookEventName: 'SessionStart',
    additionalContext,
  };
  if (projectName) hookSpecificOutput.sessionTitle = projectName;

  const payload: Record<string, unknown> = { hookSpecificOutput };
  // Omit rather than send an empty string — a blank notice still renders a blank
  // line in the transcript, and a card that shows up empty teaches users to
  // ignore the card.
  if (card && card.trim()) payload.systemMessage = card;

  process.stdout.write(JSON.stringify(payload));
}

/**
 * The sign-in notice for the PERSON. The link comes from startDetachedSignIn,
 * which reuses a link somebody is already listening for or starts one and leaves
 * a listener behind. No link (the API did not answer in time) is said plainly,
 * with the command that gets one, rather than left blank.
 */
export function signInNotice(url: string | null): string {
  return url
    ? `DeerDawn is not signed in on this machine yet. Sign in to load your project brief: ${url}\n`
      + 'This session connects as soon as you approve; new sessions start with your brief.'
    : 'DeerDawn is not signed in on this machine yet, and a sign-in link could not be fetched just now.\n'
      + 'Run `npx -y @deerdawn/mcp-server@latest setup` in a terminal to sign in.';
}

/**
 * Said ONCE to somebody whose capture hooks an earlier version installed without
 * asking (captureWanted in auth.ts keeps them, as `existing_install`). They are
 * told what leaves the machine, where it goes, and how to stop it, in their own
 * transcript, and then never again.
 */
export const EXISTING_CAPTURE_NOTICE =
  'DeerDawn capture is on for this machine (an earlier version switched it on): at the end of each session the redacted '
  + 'transcript, the Bash commands your agent ran and which files changed are sent to api.deerdawn.com, where a model '
  + 'extracts decisions and next steps for your brief. To turn it off, re-run `npx -y @deerdawn/mcp-server@latest setup` '
  + 'and answer no, or set DEERDAWN_CAPTURE=off.';

function takeExistingCaptureNotice(): string | null {
  const choices = readSetupChoices();
  if (choices.capture !== 'on' || choices.capture_source !== 'existing_install' || choices.capture_notice_shown_at) return null;
  // Recorded before it is shown: a notice that cannot be marked as shown would
  // otherwise repeat at the top of every session.
  if (!writeSetupChoices({ capture_notice_shown_at: new Date().toISOString() })) return null;
  return EXISTING_CAPTURE_NOTICE;
}

/** The person's line(s): the receipt (or the server's card), then any one-time notice. */
function personMessage(receipt: string | null | undefined, card: string | null | undefined): string | null {
  const lines = [receipt && receipt.trim() ? receipt.trim() : (card || null), takeExistingCaptureNotice()].filter(Boolean);
  return lines.length ? lines.join('\n\n') : null;
}

export async function emitSessionContext(): Promise<void> {
  let apiUrl = process.env.DEERDAWN_API_URL ?? 'https://api.deerdawn.com';
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (cfg.api_url) apiUrl = cfg.api_url;
  } catch { /* use default */ }

  // Resolve credentials. The key this repo's DeerDawn server is started with,
  // not whichever one reached credentials.json first: see hook-api-key.ts.
  // Without one, the PERSON gets the sign-in link (see signInNotice) and the
  // model is told only that nothing was loaded.
  const keyChoice = resolveHookApiKeys({ claudeConfig: process.env.DEERDAWN_SURFACE_ID !== 'codex' });
  if (!keyChoice.apiKey) {
    emit(NOT_SIGNED_IN_CONTEXT, signInNotice(await startDetachedSignIn(apiUrl, { timeoutMs: SIGN_IN_TIMEOUT_MS })));
    return;
  }
  // A pinned key the API revoked moves on to the shell's, then the saved one,
  // exactly as the server does on its first 401. See hook-api-key.ts.
  const keys = hookKeySender(keyChoice);

  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // Which tool, and whether that is known or the claude_code default: an
  // unidentified one is said to be (tool_identified=0), as every save says it,
  // so nothing is credited to a tool by guess. See resolveHookSurface.
  const { tool, identified } = resolveHookSurface();

  // cwd and the workspace key travel as headers, not in the URL: a query string
  // is what every access log keeps. See location-headers.ts, including why an
  // unacknowledged request is repeated the old way rather than trusted.
  const location = { cwd, workspaceKey: getWorkspaceKey(cwd) };
  // The per-directory memory of the last CONFIDENT answer (routing-hint.ts).
  // Keyed by the directory itself: a remote-less repository's workspace key is
  // only its folder name, which two unrelated folders can share.
  const cacheKey = cwd;
  const degraded = () => {
    const hint = lastKnownHint(lastKnownRepoProject(cacheKey));
    emit(hint ? `${DEGRADED_CONTEXT}\n${hint}` : DEGRADED_CONTEXT);
  };
  const url = new URL(`${apiUrl}/api/v1/context/active`);
  url.searchParams.set('tool', tool);
  if (!identified) url.searchParams.set('tool_identified', '0');
  url.searchParams.set('verbosity', 'standard');

  // This hook is a separate process from the MCP server, so it never receives
  // the .mcp.json `env` block the host hands the server. The workspace is
  // resolved from the project directory as well as the environment, or a
  // team's SessionStart would go on injecting the PERSONAL brief as
  // "Auto-loaded". See workspace-override.ts.
  const workspace = resolveWorkspace({ projectDir: cwd });
  const headers: Record<string, string> = workspace.workspace ? { [WORKSPACE_HEADER]: workspace.workspace } : {};

  // One attempt under its own timeout; the caller decides whether to retry.
  const attempt = async (): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      let res = await keys.send((apiKey) => fetch(url, { headers: { 'X-Api-Key': apiKey, ...headers, ...locationHeaders(location) }, signal: controller.signal }));
      if (res.ok && !locationAcknowledged(res.headers?.get?.(LOCATION_ACK_HEADER))) {
        const legacy = new URL(url);
        for (const [key, value] of Object.entries(legacyLocationQuery(location))) legacy.searchParams.set(key, value);
        res = await fetch(legacy, { headers: { 'X-Api-Key': keys.key!, ...headers }, signal: controller.signal });
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let res: Response;
    try {
      res = await attempt();
      if (res.status >= 500) throw new Error(`status ${res.status}`);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      res = await attempt();
    }
    // The workspace this repo asks for refused us. NOT degraded, and above all
    // not a silent fall back to the personal workspace: that would put one
    // person's brief into a session working on another workspace's repo, under
    // a header promising it was auto-loaded for this project.
    const refusal = workspace.workspace ? await workspaceRefusal(res, workspace.workspace) : null;
    if (refusal) { emit(refusal); return; }
    // A reachable-but-failing API (e.g. 503 from the circuit breaker) means sync
    // is degraded — say so rather than implying healthy context.
    if (!res.ok) { degraded(); return; }

    const data = await res.json() as ActiveRouting & {
      brief?: string | null;
      card?: string | null;
      receipt?: string | null;
      last_updated?: string | null;
    };
    // No brief yet, but the server may still have sent a first-session card —
    // that empty state is the most valuable card a new user ever sees, since it
    // is the moment the product explains what it is about to start doing. When
    // nothing matched this directory the API names the person's likely
    // projects, so "none matched" is not read as "there is no memory".
    if (!data?.brief) {
      const hint = data?.project_id ? null : noMatchHint(data?.alternatives);
      emit(hint ? `${FALLBACK_CONTEXT}\n${hint}` : FALLBACK_CONTEXT, personMessage(null, data?.card), data?.project_name);
      return;
    }

    const synced = data.last_updated ? ` (synced ${data.last_updated})` : '';
    // Which project, how sure, and the id that keeps every other DeerDawn call
    // on it (routing-hint.ts). An API too old to send project_id gets the old
    // header unchanged.
    const frame = data.project_id ? routingFrame(data, synced) : null;
    const header = frame
      ? frame.header
      : data.project_name
        ? `[DeerDawn] Project context — ${data.project_name}${synced}. Auto-loaded; use it without re-asking the user.`
        : `[DeerDawn] Project context${synced}. Auto-loaded; use it without re-asking the user.`;
    if (data.project_id) rememberRepoProject(cacheKey, data);
    // Honest staleness: if the working tree has uncommitted changes the recorded
    // context can't account for, say so up front rather than implying it's current.
    const fresh = computeFreshness(cwd, data.last_updated);
    const badge = fresh.staleBadge ? `${fresh.staleBadge}\n\n` : '';
    // The person sees the receipt line (/active renders it with shared-context
    // formatBriefReceipt, the one formatter every surface uses: what loaded, how
    // much, when it was last saved, the next step). It was the one proof the
    // brief arrived, and the hook never sent it: the server's card is built only
    // for a marked session start, which this passive read is not.
    emit(
      `${header}\n\n${badge}${data.brief}\n\n${frame?.footer ? `${frame.footer}\n` : ''}Call recall for deeper context; call manage_memory after meaningful changes.`,
      personMessage(data.receipt, data.card),
      data.project_name,
    );
  } catch {
    // Timeout / network error on both attempts — the API is unreachable, so
    // context is degraded. The last confirmed project for this directory, if
    // any, rides along so the agent can still ask for the right one.
    degraded();
  }
}
