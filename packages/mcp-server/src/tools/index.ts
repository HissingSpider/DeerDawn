import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type { DeerdawnClient } from '../client.js';
import { contextGraphTools, handleContextGraphTool } from './context-graph.js';
import { contextSyncTools, handleContextSyncTool } from './context-sync.js';
import { authTools, handleAuthTool } from './auth.js';
import { addonTools, handleAddonTool, ADDON_TOOL_NAMES } from './addons.js';
import { loadSavedApiKey } from '../auth.js';
import { announceCredentialRenewed, liveCredential, consumePinnedEnvKeyNotice, consumeCredentialSwapNotice } from '../auth-state.js';
import { AUTH_EXPIRED_SENTINEL } from '../utils/errors.js';
import { resolveProjectRefs } from '../project-ref.js';
import { isTaskBoardUiEnabled, taskBoardToolMeta } from '../../../shared-context/src/index.js';

// ─── Advertised surface ──────────────────────────────────────────────────────
//
// tools/list is the single largest fixed cost DeerDawn imposes on a session: at
// 36 tools it was ~28KB (~7,000 tokens) charged to every user, in every session,
// before any work happened — spent on the context window of the product whose
// entire pitch is protecting the context window. It also degrades tool selection:
// nine overlapping orientation tools mean the model picks between near-synonyms.
//
// So the advertised surface is now a BUDGET, and it is state-driven: a tool is
// advertised when the session could plausibly need it, not because it exists.
//
// The hard constraint shaping all of this: tool names are a PUBLISHED CONTRACT.
// They are literal strings inside CLAUDE.md / AGENTS.md / .cursorrules files
// already written to users' disks, and inside the hook commands in auth.ts. There
// is no alias mechanism. So nothing here may rename or delete a tool — every name
// stays permanently reachable through handleToolCall below. This module narrows
// only what we ADVERTISE; the callable surface is unchanged and always complete.
//
// Tiers:
//
//   SETUP     — only while unauthenticated. Once signed in these are dead weight;
//               setup is a thing that happens once, not a thing a session does.
//   CORE      — the steady-state loop, grouped by recall, projects, memory, tasks,
//               and delegation.
//   SKILLS    — only when this workspace actually has skills synced.
//   LEGACY    — old single-purpose names remain callable but are never advertised.
//
// Adding a tool to CORE requires removing one. That is the point.

/** Setup and auth — advertised only until the user is signed in. */
const SETUP_TIER = new Set([
  'get_auth_status', 'get_setup_status', 'apply_setup', 'complete_setup',
]);

/** The steady-state loop. Always advertised. */
const CORE_TIER = new Set([
  'start_session',
  'recall',
  'manage_projects',
  'manage_memory',
  'manage_tasks',
  'build_subagent_brief',
]);

/**
 * Add-ons: two fixed tools for every add-on (tools/addons.ts). Always
 * advertised once signed in: whether this workspace has an add-on switched on
 * is not known to listTools without a request, and `help` answers "switched
 * off" honestly. Adding these two was decided explicitly against the budget.
 */
const ADDON_TIER = new Set(['read_addon', 'use_addon']);

/** Advertised only when the workspace has synced skills. */
const SKILLS_TIER = new Set(['browse_skills', 'manage_skills']);

const GROUPED_LEGACY = new Set([
  'get_context', 'read_brief', 'list_context_map', 'update_context', 'update_brief',
  'list_projects', 'create_project', 'search_context', 'import_local_context',
  'get_workspace_overview', 'get_workspace_entities', 'get_project_map',
  'find_known_paths', 'upsert_workspace_entities', 'record_hot_paths',
  'record_debug_finding', 'confirm_claim', 'get_next_best_context',
  'cleanup_context', 'switch_subproject', 'archive_project', 'set_project_parent',
  'rename_project', 'manage_todos', 'mark_resolved', 'sync_skills', 'list_skills',
  'get_skill', 'import_skill_from_github',
]);

const ADVERTISED_METADATA: Record<string, { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }> = {
  // Tool-call telemetry is an environment write. Consequently every exposed
  // tool is non-read-only and non-idempotent even when its core operation reads.
  // That is why readOnlyHint is false here and true for the same tool names on
  // the hosted connector, which suppresses those writes for read-only calls.
  //
  // destructiveHint is a SEPARATE question and it was being answered wrongly.
  // "Not read-only" does not imply "may destroy something": the spec's false
  // means the tool performs only additive updates, which is what appending a
  // telemetry event or bumping a selection counter is. get_auth_status and
  // recall were advertising themselves as destructive while destroying nothing,
  // which is the same class of false claim that the ChatGPT reviewer rejected
  // the hosted catalog for on 2026-09-08. A host is entitled to prompt the user
  // before a destructive call, so over-claiming is not the safe direction.
  //
  // start_session keeps destructiveHint:true here and is NOT drift against the
  // hosted connector's false. Only this runtime rewrites .deerdawn-context.md,
  // AGENTS.md and .cursorrules through syncProjectFiles, so only here can the
  // call replace a file the user has. Same name, different behaviour, different
  // honest label.
  get_auth_status: { title: 'Check Sign-In', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  get_setup_status: { title: 'Check Setup', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  apply_setup: { title: 'Configure DeerDawn', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  complete_setup: { title: 'Complete DeerDawn Setup', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  start_session: { title: 'Start DeerDawn Session', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  recall: { title: 'Recall DeerDawn Memory', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  manage_projects: { title: 'Manage Projects', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  manage_memory: { title: 'Manage Project Memory', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  manage_tasks: { title: 'Manage Task Board', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  build_subagent_brief: { title: 'Build Worker Brief', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  browse_skills: { title: 'Browse Shared Skills', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  manage_skills: { title: 'Manage Shared Skills', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  // read_addon is read-only on the hosted connector and NOT here, for the
  // reason at the top of this table: this runtime records a telemetry event on
  // every call. It destroys nothing. use_addon can delete add-on records.
  read_addon: { title: 'Read Add-on', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  use_addon: { title: 'Use Add-on', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
};

export interface SurfaceState {
  /** Signed in — hides the setup tier. */
  authed: boolean;
  /** This workspace has a bound project — hides the bootstrap tier. */
  hasBoundProject: boolean;
  /** This workspace has skills — reveals the skills tier. */
  hasSkills: boolean;
}

/** Keep tools/list compact even before auth and workspace state finish loading. */
export function listTools(state?: Partial<SurfaceState>) {
  const all = [...authTools, ...contextSyncTools, ...contextGraphTools, ...addonTools];
  const { authed = false, hasSkills = false } = state ?? {};

  return all.filter((tool) => {
    const name = tool.name;

    if (GROUPED_LEGACY.has(name)) return false;

    if (SETUP_TIER.has(name)) return !authed;
    if (CORE_TIER.has(name)) return true;
    if (ADDON_TIER.has(name)) return state ? authed : true;
    if (SKILLS_TIER.has(name)) return state ? hasSkills : true;

    return false;
  }).map((tool) => {
    const metadata = ADVERTISED_METADATA[tool.name];
    const descriptor = tool as any;
    return {
      ...tool,
      annotations: metadata ?? descriptor.annotations,
      outputSchema: descriptor.outputSchema ?? { type: 'object', additionalProperties: true },
      ...(tool.name === 'manage_tasks' && isTaskBoardUiEnabled()
        ? { _meta: taskBoardToolMeta() }
        : {}),
    };
  });
}

// Dispatch gate — MUST mirror the `case` labels in handleContextSyncTool
// (context-sync.ts). A tool advertised in listTools() but missing here is
// unreachable ("Unknown tool"); that drift had silently stranded
// archive_project / set_project_parent / switch_subproject / manage_todos.
const CONTEXT_SYNC_TOOLS = ['start_session', 'recall', 'manage_projects', 'manage_memory', 'manage_tasks', 'browse_skills', 'manage_skills', 'get_context', 'read_brief', 'update_context', 'update_brief', 'list_projects', 'create_project', 'list_context_map', 'search_context', 'import_local_context', 'get_workspace_overview', 'get_workspace_entities', 'get_portfolio', 'get_project_map', 'find_known_paths', 'upsert_workspace_entities', 'record_hot_paths', 'record_debug_finding', 'get_next_best_context', 'build_subagent_brief', 'cleanup_context', 'sync_skills', 'list_skills', 'get_skill', 'import_skill_from_github', 'switch_subproject', 'archive_project', 'set_project_parent', 'rename_project', 'manage_todos', 'confirm_claim', 'mark_resolved'];
const AUTH_TOOLS = new Set(['get_auth_status', 'get_setup_status', 'apply_setup', 'complete_setup']);
let startSessionCalled = false;

/**
 * Say, once, that the credential this session recovered onto is outranked.
 *
 * A swap that replaces the key pinned in DEERDAWN_API_KEY fixes the session and
 * not the install: that key wins again at the next boot. get_auth_status has
 * always carried the sentence, and both of the swap routes can now run without
 * ever calling it — so the flag is set at the swap (index.ts) and spent here,
 * wherever the next answer happens to be.
 *
 * Added as a SEPARATE content block: several callers parse content[0].text as
 * JSON, and appending to it would break them for the sake of a footnote.
 */
function withPinnedEnvKeyNotice(result: any) {
  if (!Array.isArray(result?.content)) return result;
  if (!consumePinnedEnvKeyNotice()) return result;
  result.content.push({
    type: 'text',
    text: 'DeerDawn reconnected using your saved sign-in. DEERDAWN_API_KEY in your MCP server config was rejected and overrides that sign-in on every restart, so this will keep happening until it is removed (for Claude Code: `claude mcp remove -s user deerdawn`, then re-run `npx -y @deerdawn/mcp-server@latest setup`).',
  });
  return result;
}

/**
 * Said once, when this session continued under a credential it did not start
 * with — see the comment above noteLiveCredential in auth-state.ts for why this
 * cannot be narrowed to "a different account" from inside the client.
 *
 * A separate content block, for the same reason the notice above is one.
 */
function withCredentialSwapNotice(result: any) {
  if (!Array.isArray(result?.content)) return result;
  if (!consumeCredentialSwapNotice()) return result;
  result.content.push({
    type: 'text',
    text: 'DeerDawn picked up a different sign-in that appeared on this machine during this session, and used it to answer. '
      + 'If somebody else signed in here, this session is now reading and writing THEIR memory: stop and start a new session. '
      + 'If you signed in again yourself, nothing is wrong and you can carry on. '
      + 'Project targeting remembered under the previous sign-in has been dropped either way, so the next write resolves its project again.',
  });
  return result;
}

function withStartSessionState(name: string, result: any) {
  if (name === 'start_session') {
    if (!result?.isError) startSessionCalled = true;
    return result;
  }
  return result;
}

/**
 * The structured half of a result, for every tool that advertises an
 * outputSchema — which, through listTools() above, is every tool.
 *
 * The MCP spec requires a tool that declares an outputSchema to return
 * `structuredContent`, and the official SDK Client enforces it: callTool()
 * THROWS "Tool X has an output schema but did not return structured content"
 * on any non-error result without it. Handlers here return prose in content[]
 * only, so every call from an SDK-based client failed after the work had
 * already been done — a write that happened and was reported as an error.
 *
 * Mirrors the hosted dispatcher's textOnly() (apps/api/src/routes/mcp.js):
 * the prose, verbatim, under `text`. A handler that already built its own
 * structured payload keeps it; error results are exempt, as in the spec.
 */
export function withStructuredText(result: any) {
  if (!result || typeof result !== 'object' || result.isError) return result;
  if (result.structuredContent !== undefined && result.structuredContent !== null) return result;
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('\n\n');
  return { ...result, structuredContent: { text } };
}

export async function handleToolCall(name: string, args: any, getClient: () => Promise<DeerdawnClient>) {
  return withStructuredText(await dispatchToolCall(name, args, getClient));
}

async function dispatchToolCall(name: string, args: any, getClient: () => Promise<DeerdawnClient>) {
  // Auth tool works without a client — always responds immediately
  if (AUTH_TOOLS.has(name)) {
    return await handleAuthTool(name, args);
  }

  if (name !== 'start_session' && !startSessionCalled) {
    return {
      content: [{
        type: 'text',
        text: 'DeerDawn requires `start_session` before any other context work so cloud context is loaded first. Call `start_session` now, then retry.',
      }],
      isError: true,
    };
  }

  // All other tools need the authenticated client — fail fast if auth is pending
  let client: DeerdawnClient;
  try {
    client = await Promise.race([
      getClient(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('auth_pending')), 3000)
      ),
    ]);
  } catch {
    // Auth is pending — return the sign-in URL directly so users don't need to
    // call get_auth_status separately (important for environments like Codex
    // where stderr isn't surfaced and users can't see the device flow URL)
    const authStatus = await handleAuthTool('get_auth_status');
    const statusText = authStatus.content[0]?.text ?? '{}';
    let signInUrl: string | null = null;
    try { signInUrl = JSON.parse(statusText)?.url ?? null; } catch { /* ignore */ }

    const message = signInUrl
      ? `DeerDawn: sign in to activate session memory.\n\nOpen this URL in your browser:\n  ${signInUrl}\n\nOnce signed in, retry this tool — setup completes automatically.`
      : `DeerDawn: not signed in.\n\nCall get_auth_status to start browser sign-in, then retry this tool once authorization completes.`;
    return {
      content: [{ type: 'text', text: message }],
      isError: true,
    };
  }

  // The tool's own work, isolated so the 401 path below can run it a second
  // time against a renewed credential without repeating any of it here.
  const runTool = async () => {
    // Project references may be NAMES — the thing the model actually holds —
    // and are turned into ids here, once, for the whole surface. A value that
    // already looks like an id short-circuits without a request, so this is free
    // on the common path. An ambiguous name stops the call instead of guessing
    // which project to write to. See project-ref.ts.
    const { args: resolvedArgs, refusal } = await resolveProjectRefs(args, client);
    if (refusal) return { content: [{ type: 'text', text: refusal }], isError: true };

    if (CONTEXT_SYNC_TOOLS.includes(name)) {
      const result = await handleContextSyncTool(name, resolvedArgs, client);
      return withStartSessionState(name, result);
    }

    if (name === 'inspect_context_graph') {
      return await handleContextGraphTool(name, resolvedArgs, client);
    }

    if (ADDON_TOOL_NAMES.has(name)) {
      return await handleAddonTool(name, resolvedArgs, client);
    }

    throw new Error(`Unknown tool: ${name}`);
  };

  try {
    // Wrapped on the ORDINARY path too, and that is the path that matters: the
    // swap usually happens in getClient above, before the tool ever runs, from
    // the rejection latch re-reading credentials.json. The 401 retry below is
    // the route that LOOKS like the one that fires.
    return withCredentialSwapNotice(withPinnedEnvKeyNotice(await runTool()));
  } catch (err: any) {
    // 401 from the API — trigger a fresh device flow and surface the sign-in URL
    // instead of showing a confusing low-level credential error.
    //
    // Matched by CONTAINMENT, not equality: McpError's constructor rewrites the
    // message as `MCP error ${code}: ${message}`, so the equality test this used
    // to run could never be true and the whole branch was dead. What a user
    // whose token expired actually got was the raw string
    // "MCP error -32600: __DD_AUTH_EXPIRED__" — an internal sentinel shown as if
    // it were an explanation, in place of the sign-in link that is the fix.
    if (err instanceof McpError && err.message.includes(AUTH_EXPIRED_SENTINEL)) {
      // BEFORE saying anything: somebody may have already fixed this.
      //
      // Two server processes share one HOME (two editor windows), the saved key
      // expires, one of them signs in again and writes credentials.json — and
      // the other is never told. Its client still holds the dead key, and the
      // only channel between the two is that file. Read it, and if it holds a
      // different key, swap it in and run the call again. The user should not
      // have to be told anything about a credential that was renewed while they
      // were working.
      //
      // Exactly ONE attempt, and only when the key genuinely differs: after the
      // swap the live key IS the disk key, so a disk key that is also dead
      // cannot make this fire twice. The second failure falls through to the
      // honest sign-in path below.
      //
      // But "a key that is not the one we started with" is not the same fact as
      // "the same person's renewed key". On a shared machine the person at the
      // next desk signing in writes the same file, and this used to continue the
      // session under their credential in silence — filing this conversation as
      // their memory, and following project ids resolved for somebody else.
      // Nothing the client already holds can tell the two apart (see
      // auth-state.ts), so the swap is made — a renewal is the common case and
      // refusing it restores the loop this recovery ended — while the two
      // things that are unsafe under EITHER reading are handled where the swap
      // is actually recorded: the answer says what happened, and targeting
      // resolved under the old credential stops being used.
      const diskKey = loadSavedApiKey();
      if (diskKey && diskKey !== liveCredential()) {
        announceCredentialRenewed(diskKey);
        if (liveCredential() === diskKey) {
          try {
            return withCredentialSwapNotice(withPinnedEnvKeyNotice(await runTool()));
          } catch (retryErr: any) {
            if (!(retryErr instanceof McpError && retryErr.message.includes(AUTH_EXPIRED_SENTINEL))) throw retryErr;
          }
        }
      }
      const authResult = await handleAuthTool('get_auth_status');
      const statusText = authResult.content[0]?.text ?? '{}';
      let url = '';
      let statusMessage = '';
      let recovered = false;
      let validOnDiskOnly = false;
      try {
        const parsed = JSON.parse(statusText);
        url = parsed?.url ?? '';
        statusMessage = typeof parsed?.message === 'string' ? parsed.message : '';
        // Both halves, because they are different facts. `authenticated` says a
        // key on DISK validates; `session_reconnected` says this process's
        // client is now sending it. Reading only the first is how the reply
        // "DeerDawn reconnected. Retry your last message." came to be sent
        // forever to a client that had adopted nothing — the retry it asks for
        // reproduces the same 401, and the loop has no exit.
        recovered = parsed?.authenticated === true && parsed?.session_reconnected === true;
        validOnDiskOnly = parsed?.authenticated === true && !recovered;
      } catch { /* ignore */ }
      // Never answer "call get_auth_status" with nothing else: this branch has
      // JUST called it, and repeating that advice was a loop with no exit. Relay
      // what it actually said — a link, a recovery, or the concrete reason.
      const message = url
        ? `Your DeerDawn session needs reconnecting.\n\nSign in with this link:\n  ${url}\n\nOnce signed in, retry your last message — no other steps needed.${statusMessage.includes('DEERDAWN_API_KEY') ? `\n\n${statusMessage.slice(statusMessage.indexOf('DEERDAWN_API_KEY'))}` : ''}`
        : recovered
          ? `${statusMessage || 'DeerDawn reconnected.'}\n\nRetry your last message.`
          : validOnDiskOnly
            // Saying "retry" here would be the old loop with better manners: the
            // credential is good, this process is not using it, and only a
            // restart changes that.
            ? `Your saved DeerDawn sign-in is valid, but this server process could not switch to it. Restart your editor or AI tool to pick it up.${statusMessage ? `\n\n${statusMessage}` : ''}`
            : `Your DeerDawn session needs reconnecting, but a sign-in link could not be issued${statusMessage ? `: ${statusMessage}` : '.'}`;
      return { content: [{ type: 'text', text: message }], isError: true };
    }
    throw err;
  }
}
