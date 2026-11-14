import fs from 'fs';
import os from 'os';
import path from 'path';
import { beginDeviceFlow, clearPendingAuth, isPendingAuthFresh, loadPendingAuth, loadSavedApiKey } from '../auth.js';
import { loadConfig } from '../config.js';
import { announceCredentialRenewed, liveCredential } from '../auth-state.js';
import { workspaceHeaders, workspaceOverride } from '../workspace-override.js';
import { DeerdawnClient } from '../client.js';
import { timeoutSignal, AUTH_FETCH_TIMEOUT_MS } from '../utils/fetch-timeout.js';
import { handleContextSyncTool } from './context-sync.js';
import { autoImportOptIn } from '../first-run-import.js';
import { applySurfaceSetup, inspectLocalSetupStatus } from '../../../shared-context/src/setup-status.js';
import { resolveLocalSurfaceOrNull } from '../surface.js';

// setup-status.js counts the tool this server is running inside as connected
// (the same evidence autoConfigureHooks keeps that tool's instructions on), and
// only this process knows which tool that is once the handshake has named it.
// The declaration shim in types/shared-context-setup-status.d.ts predates the
// options argument; these are the signatures setup-status.js actually has.
type SetupStatusOptions = { runningSurface?: string | null };
const inspectSetupStatus = inspectLocalSetupStatus as (executionSource?: string, options?: SetupStatusOptions) => Record<string, unknown>;
const applySetup = applySurfaceSetup as (surface: string, mode?: 'auto' | 'repair' | 'restore', executionSource?: string, options?: SetupStatusOptions) => Record<string, unknown>;

export const authTools = [
  {
    name: 'get_auth_status',
    description: 'Check DeerDawn authentication during initial setup or when a tool reports that sign-in needs attention. If authentication is missing, this may clear stale pending sign-in state and start a device flow that returns a sign-in URL for the user.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_setup_status',
    description: 'Check DeerDawn local setup status for authentication, global instruction files, and MCP-capable tool configs. Use this when an agent needs to know how well DeerDawn is connected on this machine.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'apply_setup',
    description: 'Safely configure or repair DeerDawn setup for a supported local surface. Normally called automatically on first authenticated startup via complete_setup — only call this manually if auto-setup failed or you need to repair a specific surface. Creates a backup before writing config files and can restore the latest backup.',
    inputSchema: {
      type: 'object',
      properties: {
        surface: {
          type: 'string',
          enum: ['claude_code', 'cursor', 'claude_desktop', 'codex'],
        },
        mode: {
          type: 'string',
          enum: ['auto', 'repair', 'restore'],
        },
      },
      required: ['surface'],
    },
  },
  {
    name: 'complete_setup',
    // Describes the local-context import by what it does, not by the internal
    // tool name that performs it: import_local_context dispatches but is not in
    // tools/list, and naming it in an ADVERTISED description invites a call that
    // comes back "Unknown tool".
    description: 'Run DeerDawn setup in one call: check auth, apply local surface setup, and preview then import local context files (CLAUDE.md, AGENTS.md, .cursorrules) when they are found.',
    inputSchema: {
      type: 'object',
      properties: {
        surface: {
          type: 'string',
          enum: ['claude_code', 'cursor', 'claude_desktop', 'codex'],
        },
        mode: {
          type: 'string',
          enum: ['auto', 'repair', 'restore'],
        },
        path: {
          type: 'string',
          description: 'Optional override path for the local context import (defaults to auto-detect in cwd).',
        },
      },
      required: ['surface'],
    },
  },
];

type KeyCheck = 'valid' | 'rejected' | 'forbidden' | 'unreachable';
type KeyCheckResult = { state: KeyCheck; detail: string | null };

// Four answers. "Could not validate" used to cover both an expired key and an
// unreachable API, so the one case with a fix (sign in again) got the advice for
// the one without (check your connection). Then 401 and 403 shared 'rejected',
// which made the same mistake one level down: a 403 means the API KNOWS this key
// and refused the request — removed from the workspace, a key without the scope,
// a plan gate — and every such user was told their key had expired and sent to
// sign in again, which for most of those causes changes nothing.
export async function checkApiKeyDetailed(apiUrl: string, apiKey: string): Promise<KeyCheckResult> {
  try {
    const res = await fetch(`${apiUrl}/api/v1/context/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        // The same workspace every other call targets, so "is this key live"
        // answers the question actually being asked. A key that works but is
        // not a member of the configured workspace comes back 403 here, which
        // reads as 'forbidden' and carries the API's own words — rather than
        // 'valid', which would then fail on the very next tool call.
        ...workspaceHeaders(),
      },
      body: JSON.stringify({ query: 'auth status', limit: 1 }),
      // An API that accepts the connection and never answers used to hang this
      // call, and with it get_auth_status — the one tool a stuck session is told
      // to reach for. A timeout reads as 'unreachable', which is the truth and
      // already has advice attached.
      signal: timeoutSignal(AUTH_FETCH_TIMEOUT_MS),
    });
    if (res.ok) return { state: 'valid', detail: null };
    if (res.status === 401) return { state: 'rejected', detail: null };
    if (res.status === 403) return { state: 'forbidden', detail: await readRefusal(res) };
    return { state: 'unreachable', detail: null };
  } catch {
    return { state: 'unreachable', detail: null };
  }
}

/** The API's own words for a refusal, clipped. Never throws. */
async function readRefusal(res: { json?: () => Promise<unknown> }): Promise<string | null> {
  try {
    if (typeof res.json !== 'function') return null;
    const body = await res.json() as { message?: unknown; error?: unknown } | null;
    const said = body?.message ?? body?.error;
    return typeof said === 'string' && said.trim() ? said.trim().slice(0, 200) : null;
  } catch {
    return null;
  }
}

function describeRefusal(detail: string | null): string {
  return `HTTP 403${detail ? `: ${detail}` : ''}`;
}

/**
 * Put a key that JUST validated into this process's live client, and report
 * whether it is really there now.
 *
 * The answer is read back from auth-state rather than assumed, because there is
 * one case where announcing changes nothing: a CLI subcommand or a test that
 * never registered a renewal listener has no client to hand it to. Everything
 * downstream that says the words "reconnected" is gated on this boolean, so the
 * sentence can only be printed when the client genuinely holds the validated
 * key — not merely when the file on disk does.
 */
function adoptValidatedKey(apiKey: string): boolean {
  announceCredentialRenewed(apiKey);
  return liveCredential() === apiKey;
}

function parseToolJson(result: any): any {
  const text = result?.content?.[0]?.text ?? '{}';
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

type ToolResult = { content: Array<{ type: 'text'; text: string }> };

export async function handleAuthTool(name: string, args?: { surface?: string; mode?: 'auto' | 'repair' | 'restore'; path?: string }): Promise<ToolResult> {
  if (name !== 'get_auth_status' && name !== 'get_setup_status' && name !== 'apply_setup' && name !== 'complete_setup') throw new Error(`Unknown auth tool: ${name}`);

  if (name === 'get_setup_status') {
    // Same reason as get_auth_status below: "how well is DeerDawn connected on
    // this machine" is not answerable without saying which workspace it is
    // connected TO once an override is in play.
    return withWorkspaceTarget({
      content: [{
        type: 'text',
        text: JSON.stringify(inspectSetupStatus('local_direct', { runningSurface: resolveLocalSurfaceOrNull() })),
      }],
    });
  }

  if (name === 'apply_setup') {
    if (!args?.surface) {
      throw new Error('surface is required for apply_setup');
    }
    try {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(applySetup(args.surface, args.mode || 'auto', 'local_direct', { runningSurface: resolveLocalSurfaceOrNull() })),
        }],
      };
    } catch (err: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            applied: false,
            error: `Setup failed: ${err?.message ?? 'unknown error'}. Check file permissions in the target directories.`,
          }),
        }],
      };
    }
  }

  if (name === 'complete_setup') {
    if (!args?.surface) {
      throw new Error('surface is required for complete_setup');
    }

    const authResult: ToolResult = await handleAuthTool('get_auth_status');
    const authStatus = parseToolJson(authResult);
    const setupStatus = { applied: false };

    if (!authStatus?.authenticated) {
      return authResult;
    }

    const configAfterAuth = loadConfig();
    // When auth succeeded through the saved key (an env key was rejected), the
    // env key is the dead one — do not hand it back to the steps below.
    const resolvedApiKey = authStatus?.source === 'saved'
      ? loadSavedApiKey()
      : configAfterAuth.apiKey ?? loadSavedApiKey();
    if (!resolvedApiKey) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            completed: false,
            auth: authStatus,
            setup: setupStatus,
            imported: false,
            nextAction: 'Authentication is connected, but no saved API key was found. Call get_auth_status and retry complete_setup.',
          }),
        }],
      };
    }

    let testHomeToRemove: string | null = null;
    const previousEnvApiKey = process.env.DEERDAWN_API_KEY;
    const previousHomeDir = process.env.DEERDAWN_HOME_DIR;
    const previousDeerdawnDir = process.env.DEERDAWN_DIR;
    process.env.DEERDAWN_API_KEY = resolvedApiKey;
    if ((process.env.VITEST || process.env.NODE_ENV === 'test') && !process.env.DEERDAWN_HOME_DIR) {
      // A home of this call's own. It used to be one fixed directory under the
      // temp dir, which kept whatever an earlier run had configured in it: a
      // setup that finds a tool already configured answers differently from one
      // that finds nothing, so a test's result depended on the machine's history.
      testHomeToRemove = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-complete-setup-test-home-'));
      const testHome = testHomeToRemove;
      process.env.DEERDAWN_HOME_DIR = testHome;
      process.env.DEERDAWN_DIR = path.join(testHome, '.deerdawn');
    }
    const setupResult = await handleAuthTool('apply_setup', { surface: args.surface, mode: args.mode || 'auto' });
    const appliedSetupStatus = parseToolJson(setupResult);
    if (previousEnvApiKey === undefined) delete process.env.DEERDAWN_API_KEY;
    else process.env.DEERDAWN_API_KEY = previousEnvApiKey;
    if (previousHomeDir === undefined) delete process.env.DEERDAWN_HOME_DIR;
    else process.env.DEERDAWN_HOME_DIR = previousHomeDir;
    if (previousDeerdawnDir === undefined) delete process.env.DEERDAWN_DIR;
    else process.env.DEERDAWN_DIR = previousDeerdawnDir;
    if (testHomeToRemove) fs.rmSync(testHomeToRemove, { recursive: true, force: true });

    const client = new DeerdawnClient({ ...loadConfig(), apiKey: resolvedApiKey });
    const preview = await handleContextSyncTool('import_local_context', { path: args?.path }, client);
    const previewText = preview?.content?.[0]?.text ?? '';
    const foundLocalFile = typeof previewText === 'string' && previewText.startsWith('Found ');

    // The preview is where this stops unless the user has a standing opt-in.
    // It used to confirm its own preview in the same call: the file was found,
    // "shown" to nobody, and uploaded — a consent step with no one in it, on the
    // very first tool a new install runs. Whoever is in the conversation reads
    // the preview and makes the second call; autoImportOptIn is the one way to
    // have said yes ahead of time.
    let importResultText = previewText;
    let imported = false;
    if (foundLocalFile && autoImportOptIn()) {
      const confirm = await handleContextSyncTool('import_local_context', {
        path: args?.path,
        confirmed: true,
      }, client);
      importResultText = confirm?.content?.[0]?.text ?? importResultText;
      imported = true;
    }

    // apply_setup reports `applied` / `already_configured` from a read-back of
    // the tool's own config, so this is true only when that tool can now reach
    // DeerDawn. When it cannot, "Setup complete." is the one thing this answer
    // must not say: the next action is the step that connects it.
    const setupDone = !!(appliedSetupStatus?.applied || appliedSetupStatus?.already_configured);
    const notConnected = [appliedSetupStatus?.reason ?? appliedSetupStatus?.error, appliedSetupStatus?.next_step]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' ') || `DeerDawn is not connected to ${args.surface} yet. Call get_setup_status to see why.`;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          completed: setupDone,
          auth: authStatus,
          setup: appliedSetupStatus,
          import: {
            previewed: true,
            imported,
            message: importResultText,
          },
          nextAction: !setupDone
            ? `${notConnected}${foundLocalFile && !imported
              ? ' A local context file was also found and NOT imported yet — nothing has left this machine. Show the user the preview above; if they agree, call manage_memory(action:"import_local", confirmed:true).'
              : ''}`
            : imported
              ? 'Setup complete. Call start_session to continue with current project context.'
              : foundLocalFile
                ? 'Setup complete. A local context file was found and NOT imported yet — nothing has left this machine. Show the user the preview above; if they agree, call manage_memory(action:"import_local", confirmed:true). Then call start_session.'
                : 'No CLAUDE.md, AGENTS.md, or .cursorrules found in the current directory. Create one or call create_project.',
        }),
      }],
    };
  }

  return withWorkspaceTarget(await getAuthStatus());
}

/**
 * Stamp the workspace this install targets onto an auth answer.
 *
 * Whoever is asking "am I connected" is asking about a specific workspace, and
 * with DEERDAWN_WORKSPACE set that is not the one the key was minted for. A
 * status that omits it can be entirely true and still leave somebody looking for
 * their own projects in a team's brief. Absent entirely when no override is set.
 */
function withWorkspaceTarget(result: ToolResult): ToolResult {
  const workspace = workspaceOverride();
  if (!workspace) return result;
  const text = result.content[0]?.text ?? '{}';
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    return result;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result;
  return { content: [{ type: 'text', text: JSON.stringify({ ...parsed, workspace }) }] };
}

async function getAuthStatus(): Promise<ToolResult> {
  const config = loadConfig();

  // Set when DEERDAWN_API_KEY in the MCP env was refused. It outranks
  // credentials.json on every boot, so whatever this call does to fix the
  // session, the next restart will reach for the dead key again unless the user
  // removes it — every message from here on has to say so.
  let envKeyRejected = false;
  // ...and when that refusal was a 403 rather than a 401: the key is known to the
  // API and was denied, which is not expiry and must not be described as it.
  let envKeyRefusal: string | null = null;
  if (config.apiKey) {
    const envResult = await checkApiKeyDetailed(config.apiUrl, config.apiKey);
    const envCheck = envResult.state;
    if (envCheck === 'forbidden') envKeyRefusal = describeRefusal(envResult.detail);
    if (envCheck === 'valid') {
      clearPendingAuth();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ authenticated: true, source: 'env', session_reconnected: adoptValidatedKey(config.apiKey) }),
        }],
      };
    }

    if (envCheck === 'unreachable') {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            authenticated: false,
            source: 'env',
            url: null,
            message: 'Could not reach the DeerDawn API to check the configured API key. Check your connection and retry.',
          }),
        }],
      };
    }

    // Rejected. This used to answer url:null and "check that the key is
    // current", while the 401 path told the user to call get_auth_status — the
    // very call that had just said that. A circle with no exit. Fall through to
    // the same recovery a stale saved key gets: a working saved key, or a
    // device flow whose link is returned.
    envKeyRejected = true;
  }
  const REMOVE_ENV_KEY = 'Remove it from the MCP config (for Claude Code: `claude mcp remove -s user deerdawn`, then re-run `npx -y @deerdawn/mcp-server@latest setup`).';
  const ENV_KEY_ADVICE = envKeyRefusal
    ? `DEERDAWN_API_KEY in your MCP server config was refused by the API (${envKeyRefusal}). The key is recognised, so this is a workspace, scope or plan problem — not an expired key — and it overrides your saved sign-in on every restart. Fix that key's access, or to use your saved sign-in instead: ${REMOVE_ENV_KEY}`
    : `DEERDAWN_API_KEY in your MCP server config was rejected (expired or revoked) and overrides your saved sign-in on every restart. ${REMOVE_ENV_KEY}`;

  const savedApiKey = loadSavedApiKey();
  let savedKeyRefusal: string | null = null;
  if (savedApiKey && !(envKeyRejected && savedApiKey === config.apiKey)) {
    const savedResult = await checkApiKeyDetailed(config.apiUrl, savedApiKey);
    if (savedResult.state === 'forbidden') savedKeyRefusal = describeRefusal(savedResult.detail);
    const authenticated = savedResult.state === 'valid';
    if (authenticated) {
      clearPendingAuth();
      // Hand it to the live client ALWAYS, not only when an env key was the
      // thing that failed. That condition was the whole of the defect: a second
      // server process holding an expired key in memory validated the renewed
      // key on disk, answered {"authenticated":true,"source":"saved"}, and
      // adopted nothing — so the caller was told it had reconnected while every
      // request still went out with the dead key. Validating a credential and
      // then not using it is the one outcome with no reason to exist.
      const reconnected = adoptValidatedKey(savedApiKey);
      if (envKeyRejected) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ authenticated: true, source: 'saved', session_reconnected: reconnected, message: `Reconnected with your saved sign-in. ${ENV_KEY_ADVICE}` }),
          }],
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ authenticated: true, source: 'saved', session_reconnected: reconnected }) }],
      };
    }
  }

  let pending = loadPendingAuth();

  // A saved link outlives the code inside it. clearPendingAuth() runs only on a
  // SUCCESSFUL sign-in, so an abandoned attempt leaves this file behind forever,
  // and the branch below that mints a fresh code fires only when there is no
  // file at all. The result was a permanent dead end: every auth failure served
  // the same expired URL, the dashboard answered 404, and re-running sign-in
  // produced the identical link. Treat a stale pending as no pending — the
  // recovery path already exists below, it just has to be reachable.
  if (pending && !isPendingAuthFresh(pending)) {
    clearPendingAuth();
    pending = null;
  }

  // Surface auth errors written by the main process (e.g. 429, claude.ai link required).
  // Only while still current: a rate-limit notice from yesterday is not news, and
  // holding it here would keep the user off the fresh-link path for good.
  if (pending?.error_message) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          authenticated: false,
          url: pending.verification_url || null,
          message: envKeyRejected ? `${pending.error_message}\n\n${ENV_KEY_ADVICE}` : pending.error_message,
        }),
      }],
    };
  }

  if (!pending?.verification_url) {
    try {
      const verificationUrl = await beginDeviceFlow(config.apiUrl);
      pending = { verification_url: verificationUrl };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start sign-in flow.';
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            authenticated: false,
            url: null,
            message: envKeyRejected ? `${message}\n\n${ENV_KEY_ADVICE}` : message,
          }),
        }],
      };
    }
  }

  if (pending?.verification_url) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          authenticated: false,
          url: pending.verification_url,
          ...(envKeyRejected ? { source: 'env' } : {}),
          ...(envKeyRefusal || savedKeyRefusal ? { reason: 'forbidden' } : {}),
          message: envKeyRejected
            ? envKeyRefusal
              ? `The configured DeerDawn API key was refused (${envKeyRefusal}) — it has not expired. A fresh sign-in is here if you want one: ${pending.verification_url}\n\n${ENV_KEY_ADVICE}`
              : `The configured DeerDawn API key was rejected. Reconnect here: ${pending.verification_url}\n\n${ENV_KEY_ADVICE}`
            : savedKeyRefusal
              ? `Saved DeerDawn credentials were refused (${savedKeyRefusal}) — they have not expired, so check this account's workspace membership, key scopes and plan first. To sign in again instead: ${pending.verification_url}`
              : savedApiKey
                ? `Saved DeerDawn credentials are stale. Reconnect here: ${pending.verification_url}`
                : `DeerDawn sign-in required. Open this URL in your browser: ${pending.verification_url}`,
        }),
      }],
    };
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        authenticated: false,
        url: null,
        message: 'DeerDawn is not authenticated and no sign-in flow is active. Restart the MCP server to trigger a new sign-in.',
      }),
    }],
  };
}
