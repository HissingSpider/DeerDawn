'use strict';
const { randomUUID } = require('crypto');

// Remote MCP endpoint — Streamable HTTP transport for Claude.ai, ChatGPT.com, and other web-based AI tools.
// Auth: Bearer token or API key via existing requireAuth middleware.
// Mode: stateless — a fresh Server + Transport per request, no session management.

const express = require('express');
const { hostedSessionId, hostedSessionTool, credentialSurface } = require('../services/hostedSessionIdentity');
const connectionIdentity = require('../services/connectionIdentity');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const service = require('../services/contextSyncService');
const contextSearch = require('../services/contextSearchService');
const graphService = require('../services/contextGraphService');
const trailService = require('../services/trail');
const portfolioService = require('../services/portfolioService');
const { checkAndMarkSessionLoad } = require('../services/sessionDedup');
const {
  buildSessionCatchup,
  maybeEmitSecondToolConnected,
  recordRemoteSessionDelivery,
  recordCreationSessionLoad,
} = require('../services/sessionCatchupService');
const { requireAuth } = require('../middleware/auth');
const {
  formatWorkspaceOverview,
  formatPortfolio,
  formatQuestionResolution,
  formatSectionInjection,
  formatArchivedProjectsNotice,
  formatProjectListing,
  formatProjectArchivedReply,
  ARCHIVED_PROJECTS_FETCH_LIMIT,
  formatTaskCardDetail,
  normalizeTaskCardInputs,
  resolveTaskCard,
  taskCardBodyWasClipped,
  buildTaskBoardSnapshot,
  taskBoardSnapshotForListing,
  BOARD_PHASES,
  MAX_TODO_BODY_CHARS,
  TASK_BODY_MARKER,
  GRAPH_NODE_TYPE_VALUES,
  TASK_BOARD_WIDGET_URI,
  isTaskBoardUiEnabled,
  taskBoardToolMeta,
  taskBoardResource,
  taskBoardWidgetHtml,
  describeTaskState,
  formatLeftAfterReview,
  stayedOutside,
  orderLeftSections,
  NO_REVIEW_ON_RECORD,
} = require('../../../../packages/shared-context/src/index.js');
const { buildMcpInstructions } = require('../../../../packages/shared-context/src/mcpInstructions.js');
const { buildFirstSessionGuide } = require('../../../../packages/shared-context/src/firstSessionGuide.js');
const { recordProductEvent } = require('../services/productEventsService');
const toolUsageDays = require('../services/toolUsageDays');
// The function store.saveProject applies on the way to the row. A reply quoting
// what the caller sent quotes a credential the brief holds masked; quoting it
// through this quotes what was actually stored.
const { redactForStorage } = require('../store/contextSyncStore');
const db = require('../config/db');
const { MCP_RESOURCE_PATH, CLAUDE_MCP_RESOURCE_PATH } = require('../config/mcpResource');
const workspace = require('../services/workspaceService');
const {
  advertisedToolInputSchema,
  normalizeMcpError,
  OPAQUE_FIELD_LIMIT_CHARS,
  OPAQUE_STRUCTURED_FIELDS,
  redactDeep,
  // Applied a second time on the telemetry path. normalizeMcpError already
  // redacts, but this field is a free-text sink and the cost of redacting twice
  // is nothing next to the cost of one credential-shaped string being persisted.
  redactText,
  sanitizeToolResult,
  validateToolArguments,
  withTimeout,
} = require('../services/mcpSafety');

// finish_task over a brief with no current task. It completes nothing, so it
// records nothing as shipped, and the reply says so rather than "Task marked as
// completed". PARITY: packages/mcp-server/src/tools/context-sync.ts carries the
// same sentence; tests/unit/mcp-dispatcher-parity.test.js pins the two together.
const NO_TASK_TO_COMPLETE = 'No current task was set, so nothing was recorded as shipped.';

const MCP_TOOL_TIMEOUT_MS = Math.max(1_000, Number(process.env.MCP_TOOL_TIMEOUT_MS) || 30_000);
const MCP_MAX_CONCURRENCY = Math.max(1, Number(process.env.MCP_MAX_CONCURRENCY) || 64);
let mcpInFlight = 0;

// The two surfaces this endpoint can name. Everything else that reaches it —
// Cursor, VS Code, Codex, Claude Code over http — is real, but is not one of the
// web tools, and is recorded as 'unknown_web' rather than as a web tool it is not.
const HOSTED_WEB_SURFACES = new Set(['claude_web', 'chatgpt_web']);

// Map a client's self-reported name to a DeerDawn web surface.
//
// ONE ORDERED TABLE FOR BOTH INPUTS. The name is classified by the same table
// the credential's registered name goes through (hostedSessionIdentity), and
// that table tests "Claude Code" before "claude". This used to be two substring
// checks of its own, so Claude Code's handshake (`claude-code`) was filed as
// Claude.ai: the hosted Claude Code card read as a browser, and one editor on
// both transports (local 'claude_code', hosted 'claude_web') fired
// second_tool_connected for a person who had connected exactly one tool. It
// also matters now that a call is labelled from the credential: a handshake
// and a call from the same client must land on the same label, or one tool
// counts as two.
//
// The name only. The credential classifier can also fall back to a CIMD
// client_id's HOST, and a host is not an identity here: Claude Code's metadata
// document lives on claude.ai.
function detectWebSurface(clientName) {
  const surface = credentialSurface({ oauth_client_name: String(clientName || '') });
  return HOSTED_WEB_SURFACES.has(surface) ? surface : 'unknown_web';
}

// Which web tool holds the OAuth token this request arrived on.
//
// The transport is stateless, so `clientInfo` exists only on the request that
// carried `initialize`, and every tools/call used to be filed as 'unknown_web'.
// Setup marks a card connected only when ITS surface has calls, so a Claude.ai
// or ChatGPT connection that was loading briefs and saving decisions read as
// "0 of 9 tools connected" beside a Connect button (walker, 2026-09-27) — every
// hosted-only person, which is most people.
//
// The identity was on the credential all along: the OAuth grant stamps the
// client's registered name onto the key it mints (routes/oauth.js
// mintAccessToken), carried across every refresh, and the auth middleware hands
// it to each request with no extra query. Only an OAuth-minted token counts: a
// plain API key or a device-flow key names no client, and its calls stay
// 'unknown_web' exactly as before. A token minted before keys carried the name
// stays 'unknown_web' too — unidentified, not guessed.
function credentialWebSurface(actor) {
  if (actor?.type !== 'key' || !actor.oauth_resource || !actor.oauth_client_name) return 'unknown_web';
  return detectWebSurface(actor.oauth_client_name);
}

// The surface of one hosted request: the handshake's own word when it carries
// one, the credential's when it does not.
function requestSurface(actor, clientInfo) {
  if (clientInfo?.name) return detectWebSurface(clientInfo.name);
  return credentialWebSurface(actor);
}

// WHICH TOOL a hosted request came from, and HOW IT CONNECTED, as two facts of
// their own (services/connectionIdentity.js). `requestSurface` above answers
// only for the two web apps and files every other client (Claude Code, Codex,
// Cursor) as 'unknown_web', which is not a tool. The tool is named here from the
// same ordered name table, the handshake's word first and the credential's
// second; null when neither says. Nothing here changes `surface`.
function requestTool(actor, clientInfo) {
  const fromHandshake = clientInfo?.name ? credentialSurface({ oauth_client_name: String(clientInfo.name) }) : '';
  return connectionIdentity.cleanTool(fromHandshake || credentialSurface(actor));
}

// The coding clients that reach this endpoint directly over HTTP. Each has a
// coding-shaped render profile (next action, commands, files), the one the local
// server's /active hands the same tool.
const CODING_BRIEF_TOOLS = new Set(['claude_code', 'cursor', 'codex']);

// WHICH SHAPE OF BRIEF a hosted start_session renders: chosen from the request's
// TOOL, not from the web surface alone. The surface files every client that is
// not one of the two web apps as 'unknown_web', so Claude Code, Cursor and Codex
// connected over HTTP were all handed the chat-shaped claude_web brief, without
// the next action, commands and files their local twin gets.
//
// Codex inside a ChatGPT install is not one of them, and cannot be told apart
// here: its calls carry ChatGPT's credential and no client info, so requestTool
// says 'chatgpt_web' and it keeps the chat shape (which now carries the next
// step too). Anything unidentified keeps claude_web, as before.
function hostedBriefTool(actor, clientInfo, surface) {
  const tool = requestTool(actor, clientInfo);
  if (CODING_BRIEF_TOOLS.has(tool)) return tool;
  if (tool === 'chatgpt_web' || surface === 'chatgpt_web') return 'chatgpt_web';
  return 'claude_web';
}

// Best-effort, fire-and-forget telemetry so we can measure per-surface call rate
// (e.g. "ChatGPT connected but hasn't called start_session in 14d"). Mirrors the
// event names the local CLI server emits so the dashboard can aggregate both.
// `errorMessage` is deliberately recorded under `error`, the same property name
// the LOCAL stdio server uses for the same thing, so one query spans both
// transports instead of needing a coalesce over two spellings. `error_code`
// stays as it was: the low-cardinality field to group by.
function recordMcpCall(actor, { tool, ok, clientInfo, error, errorMessage }) {
  // A bare tools/call has no clientInfo, so this is the credential's surface —
  // the row the dashboard's per-surface call count, and Setup, read.
  const surface = requestSurface(actor, clientInfo);
  const event_name = ok
    ? (tool === 'start_session' ? 'mcp_start_session_succeeded' : 'mcp_tool_call_succeeded')
    : 'mcp_tool_call_failed';
  recordProductEvent(actor, {
    event_name,
    source: 'mcp',
    surface,
    tool: requestTool(actor, clientInfo),
    transport: connectionIdentity.hostedTransport(actor),
    metadata: {
      tool_name: tool,
      transport: 'http',
      client_name: String(clientInfo?.name || '').replace(/[^a-z0-9._ -]/gi, '').slice(0, 80) || null,
      client_version: String(clientInfo?.version || '').replace(/[^a-z0-9._+-]/gi, '').slice(0, 40) || null,
      ...(error ? { error_code: String(error).slice(0, 80) } : {}),
      // Without this, a failure recorded here says only WHICH of six codes it
      // was. 41 hosted manage_memory calls failed as 'invalid_arguments' over
      // two weeks and not one of them could be attributed to a field, because
      // the sentence naming the field was computed, returned to the caller, and
      // then dropped on the floor. Already redacted and capped at 500 by
      // normalizeMcpError; trimmed again here because a telemetry property does
      // not need the long tail. Safe to store: every validation message is built
      // from schema paths and schema constants (field names, enum values,
      // limits), never from the caller's own values.
      ...(errorMessage ? { error: redactText(errorMessage).slice(0, 200) } : {}),
    },
  }).catch(() => {});
}

// A connected, authenticated client sends `initialize` exactly once on connect,
// before any tool call — and web tools never auto-call a tool. Record that
// handshake as an mcp_runtime_started event (mirroring the local CLI server) so
// the dashboard's "is a tool connected?" check (product_events source='mcp')
// flips to detected on auth alone, instead of stranding the onboarding poll on
// "Waiting for your tool to connect…" until the user manually runs a tool.
function recordMcpConnect(actor, clientInfo) {
  const surface = requestSurface(actor, clientInfo);
  // Detect the 1→2 tool transition at the handshake, where clientInfo gives the
  // real web surface (claude_web / chatgpt_web). The tools/call path now labels
  // from the credential, through the same name table, so a client's handshake
  // and its calls land on one surface and cannot read as two tools. The check
  // unions this surface into the observed source='mcp' set, so it is
  // order-independent w.r.t. the mcp_runtime_started row recorded below.
  maybeEmitSecondToolConnected(actor, surface).catch(() => {});
  recordProductEvent(actor, {
    event_name: 'mcp_runtime_started',
    source: 'mcp',
    surface,
    tool: requestTool(actor, clientInfo),
    transport: connectionIdentity.hostedTransport(actor),
    metadata: {
      transport: 'http',
      client_name: clientInfo?.name || null,
      client_version: clientInfo?.version || null,
    },
  }).catch(() => {});
}

// One place for "omit project_id and the active project is used", which is what
// every advertised project_id description promises. Inlined copies of this
// already existed for read_tasks and resolve_open_question while the record_*
// writes threw 'project_id required' instead, so the promise held for reads and
// not for the writes.
// ─── Project references arrive as NAMES ──────────────────────────────────────
//
// Every project_id field on this surface wants an id, and the model almost never
// holds one. Names are what it holds: the brief prints a name, the board prints
// a name, recall({action:"projects"}) prints a name with the id in parentheses.
// So the most common call the model can make was the one that failed, and it
// failed opaquely: a name went down to the store as an id, missed, and came back
// as a bare internal_error naming nothing. manage_memory's own schema has been
// telling the model "Project id or exact name" the whole time.
//
// The local stdio package has resolved this centrally since project-ref.ts was
// written. Only the hosted connector never got it, which is the recurring shape
// of every tool-layer bug in this repo: fixed on one dispatcher, half-shipped.
// Most real users reach DeerDawn through THIS one.
//
// The rules mirror that module deliberately, because two dispatchers answering
// the same question differently is the thing being fixed:
//
//   1. An id costs nothing. `project_` short-circuits before any query, so the
//      common path is unchanged and the recursive dispatch below (manage_memory
//      to update_context) re-enters with an id and does no second lookup.
//   2. Matching is EXACT on the server's own normalized name identity, never
//      partial. Containment matching turns a typo into a confident write to the
//      wrong project.
//   3. Ambiguity REFUSES. Resolving two candidates by picking one files a user's
//      memory into another project and nothing in this tool can undo it.
//   4. No match passes through untouched, so the handler reports an unknown
//      project exactly as it did before this existed.
//
// The local module needs a truncated-archive refusal because it pages an HTTP
// endpoint. This one does not: findProjectCandidatesByName reads every row the
// ACTOR MAY SEE in a single query, archived included, so a lone match is provably
// lone. Actor-scoped, not owner-scoped: the refusal below prints every candidate's
// name and id, so an unscoped candidate set made a name collision with a
// colleague's personal project a disclosure of that project.
const PROJECT_REF_KEYS = new Set(['project_id', 'parent_project_id', 'related_project_id']);
const PROJECT_REF_MAX_DEPTH = 6;
const PROJECT_REF_MAX_NODES = 4000;

function looksLikeProjectId(value) {
  return typeof value === 'string' && value.startsWith('project_');
}

function collectProjectNames(node, depth, out, budget) {
  if (!node || typeof node !== 'object' || depth > PROJECT_REF_MAX_DEPTH || budget.left <= 0) return;
  budget.left -= 1;
  if (Array.isArray(node)) {
    for (const item of node) collectProjectNames(item, depth + 1, out, budget);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string') {
      if (!PROJECT_REF_KEYS.has(key)) continue;
      const raw = value.trim();
      if (raw && !looksLikeProjectId(raw)) out.add(raw);
      continue;
    }
    collectProjectNames(value, depth + 1, out, budget);
  }
}

function rewriteProjectNames(node, resolved, depth) {
  if (!node || typeof node !== 'object' || depth > PROJECT_REF_MAX_DEPTH) return node;
  if (Array.isArray(node)) {
    let changed = false;
    const next = node.map((item) => {
      const mapped = rewriteProjectNames(item, resolved, depth + 1);
      if (mapped !== item) changed = true;
      return mapped;
    });
    return changed ? next : node;
  }
  let changed = false;
  const next = {};
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string' && PROJECT_REF_KEYS.has(key)) {
      const id = resolved.get(value.trim());
      if (id && id !== value) {
        next[key] = id;
        changed = true;
      } else {
        next[key] = value;
      }
      continue;
    }
    const mapped = rewriteProjectNames(value, resolved, depth + 1);
    if (mapped !== value) changed = true;
    next[key] = mapped;
  }
  return changed ? next : node;
}

function projectAmbiguityMessage(name, candidates) {
  const lines = candidates.map((row) => `  - ${row.project_name || '(unnamed)'}: ${row.project_id}`);
  return [
    `"${name}" matches ${candidates.length} projects, so nothing was written or read.`,
    ...lines,
    '',
    'Pass the project_id of the one you mean. Picking for you could file this into the wrong',
    'project\'s memory, which cannot be undone from here.',
  ].join('\n');
}

/**
 * Replace project names with project ids anywhere in a tool's arguments.
 *
 * Never throws on a lookup failure: if the candidate query fails the arguments
 * come back untouched and the call proceeds exactly as it would have before, so
 * a degraded lookup can never be worse than not having one. An AMBIGUOUS name
 * does throw, because there is no safe way to continue.
 */
async function resolveProjectRefs(args, actor) {
  const names = new Set();
  collectProjectNames(args, 0, names, { left: PROJECT_REF_MAX_NODES });
  if (!names.size) return args;
  const ownerKey = workspace.defaultOwnerKey(actor);
  if (!ownerKey) return args;

  const resolved = new Map();
  for (const name of names) {
    let candidates;
    try {
      candidates = await service.findProjectCandidatesByName(actor, name);
    } catch {
      return args;
    }
    if (candidates.length > 1) {
      const error = new Error(projectAmbiguityMessage(name, candidates));
      error.mcpCode = 'invalid_arguments';
      error.safeMessage = error.message;
      throw error;
    }
    if (candidates.length === 1) resolved.set(name, candidates[0].project_id);
  }
  if (!resolved.size) return args;
  return rewriteProjectNames(args, resolved, 0);
}

// WHAT A CALL'S PROJECT RESOLUTION HAS TO SAY (journey r5).
//
// resolveActiveProject answers "which project" and, beside it, two facts the
// person has to be told: the connection's own project could not be used (it is
// archived, or no longer shared), or the caller reports a folder that belongs to
// a different project than the one the connection is bound to. Neither is
// something a tool handler decides; each handler resolves through resolveActive,
// which records the sentence here, and runTool appends it to that call's reply.
// AsyncLocalStorage, not a parameter: a dozen handlers resolve a project, and
// the sentence belongs to the CALL, not to any one of them.
const { AsyncLocalStorage } = require('node:async_hooks');
const callNotes = new AsyncLocalStorage();

function noteForCall(line) {
  const store = callNotes.getStore();
  if (store && line && !store.notes.includes(line)) store.notes.push(line);
}

// The sentence a dead binding earns a READ that resolved somewhere else. A write
// never gets one: it is refused (service.heldSessionProject).
function staleBindingSentence(stale) {
  if (!stale) return '';
  return stale.reason === 'archived'
    ? `Note: this connection was working in "${stale.project_name || stale.project_id}" (${stale.project_id}), which is archived, so this is not that project. To go back, restore it: manage_projects with action "restore" and project_id "${stale.project_id}".`
    : `Note: the project this connection was working in (${stale.project_id}) is no longer shared with you, so this is not that project. To work in another, call manage_projects with action "select" and a project id.`;
}

function locationConflictSentence(project) {
  const conflict = project?.location_conflict;
  if (!conflict) return '';
  return `Note: this connection is working in "${project.project_name || project.project_id}", and the folder you are in looks like "${conflict.project_name || conflict.project_id}" (${conflict.project_id}). Nothing was moved. To work in "${conflict.project_name || conflict.project_id}" instead, call manage_projects with action "select" and project_id "${conflict.project_id}".`;
}

/**
 * service.resolveActiveProject for a tool call, with the two things a handler
 * must not lose: a refusal the connection's own binding earned (a write bound to
 * a project that is archived or no longer shared) is RETHROWN, where every
 * other failure still reads as "no project" as it always did; and what the
 * resolution had to say is recorded for the reply.
 */
async function resolveActive(actor, { forWrite = false, cwd = null, workspaceKey = null } = {}) {
  let active = null;
  try {
    active = await service.resolveActiveProject(actor, cwd, workspaceKey, { forWrite, sessionId: hostedSessionId(actor) });
  } catch (err) {
    if (err?.bindingRefusal) throw err;
    return null;
  }
  noteForCall(staleBindingSentence(active?.stale_binding));
  noteForCall(locationConflictSentence(active));
  // A parent folder of another or unknown repository is shown for reading only.
  if (active?.match_warning) noteForCall(`Note: ${active.match_warning}.`);
  return active;
}

// By the time this runs, dispatch has already turned any name into an id (see
// resolveProjectRefs above), so this only has to answer the OTHER half of the
// promise: omit the reference and the active project is used.
// WHAT TO DO WITH NO PROJECT, naming only tools both catalogs advertise. It
// used to say "or call start_session first" — and on a brand-new account
// start_session creates nothing, so the caller was sent round in a circle.
// manage_projects(create) is what makes one; recall(projects) finds an existing
// one to pass. Pinned in tests/integration/scan24-b-fixes.test.js.
const NO_PROJECT_NEXT_STEP = 'Pass project_id (recall(action:"projects") lists them), or, if there is no project yet, create one with manage_projects(action:"create", project_name:"<name>").';

// What an entity write says when there is no project to file it under. Worded to
// contain "required" like the sentences around it, so it reaches the caller.
// PARITY: packages/mcp-server/src/tools/context-sync.ts says the same words.
const NO_PROJECT_FOR_ENTITIES = 'Nothing was saved. These entities name no project and this connection has no active project, so there is nowhere to file them, and a project is required. '
  + 'Pass project_id (recall(action:"projects") lists them) to file them in one project, or select one first with manage_projects(action:"select"). '
  + 'To save them for the whole workspace, readable by every member, set scope:"workspace" on each entity.';

// The reply to a project_id that names no project the caller can see.
// PARITY: packages/mcp-server/src/tools/context-sync.ts says the same words.
function unknownProjectMessage(projectRef) {
  return `No project "${projectRef}" that you can see, so nothing was resolved. List your projects with recall(action:"projects") and pass one of their ids as project_id, or omit project_id to use the active project.`;
}

// IS THIS ENTITY THE ONE `title` NAMES? Its title, exactly (case and outer
// whitespace aside), or its node id — or, for a text the title was cut from,
// its own full text: the canonical key the extractor slugs from the unclipped
// text (`<type>:<normalizeKey(text)>`), and for a decision the shared matcher
// every decision resolve uses (service.decisionNodeMatches: its summary, or its
// key when the summary is cut too). Never a prefix or a shared word.
// PARITY: packages/mcp-server/src/tools/context-sync.ts entityNamedExactly.
function entityNamedExactly(entity, title) {
  if (!entity || typeof title !== 'string') return false;
  if (entity.node_id === title) return true;
  const wanted = title.trim().toLowerCase();
  if (String(entity.title || '').trim().toLowerCase() === wanted) return true;
  const type = entity.node_type || entity.metadata?.entity_type;
  // A scoped copy's key is the plain one plus where it lives (`::in.<home>`),
  // its base cut short past 1KB (contextSyncService entityGroupKey).
  const key = service.entityGroupKey(entity.canonical_key);
  if (type && key && key === service.entityGroupKey(`${type}:${graphService.normalizeKey(title)}`)) return true;
  return type === 'decision' && service.decisionNodeMatches(title, entity);
}

// The decision entities whose text begins with the opening a shown cut carries
// (a text ending in "..." or "…"): the one decision it can mean when it is the
// only one, open or resolved (a resolved one, so the reply can say it is
// already done); otherwise every one it opens, OPEN OR RESOLVED, which the
// caller refuses as a guess and lists, the resolved ones marked. Counting only
// the open ones, a cut shared by X and Y resolved Y once X was resolved, though
// the caller sending that cut again meant X (scan 29). With none open, the
// resolved one alone, as "already resolved". [] when the text is no shown cut.
// PARITY: packages/mcp-server/src/tools/context-sync.ts decisionsNamedByOpening.
async function decisionsNamedByOpening(actor, title, projectId) {
  const opening = String(title || '').trim().replace(/\s*(\.\.\.|\u2026)$/, '');
  if (opening === String(title || '').trim()) return [];
  const wide = await service.getWorkspaceEntities(actor, {
    query: opening,
    types: ['decision'],
    ...(projectId ? { project_id: projectId } : {}),
    include_resolved: true,
    limit: 50,
  }).catch(() => []);
  const named = (wide || [])
    .filter((e) => (e.node_type || e.metadata?.entity_type) === 'decision')
    .filter((e) => service.decisionNodeNamedByOpening(title, e));
  const open = named.filter((e) => e.metadata?.status !== 'resolved');
  return open.length ? named : named.slice(0, 1);
}

async function resolveProjectRefOrActive(actor, explicit, purpose) {
  if (explicit && typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  // Anything but a read resolves a WRITE target, which a name guess can never
  // be. A hosted caller has no directory, so nothing matches by name here today;
  // this keeps that true if this dispatcher ever starts carrying a location.
  //
  // sessionId is what stops ANOTHER connector's activity from answering this
  // question: with it, this connection's own binding is consulted first.
  const active = await resolveActive(actor, { forWrite: purpose !== 'read' });
  const projectId = active?.project_id;
  // Worded to contain "required" on purpose: normalizeMcpError passes such a
  // message through as an invalid-params error the caller can act on.
  //
  // A WRITE refused because this person's own projects are in another
  // workspace gets the service's text INSTEAD: NO_PROJECT_NEXT_STEP's "create
  // one" is what led an assistant to create their project in the team, shared
  // by default (service.ownWorkElsewhereRefusal). Everybody else's text is
  // unchanged.
  if (!projectId) {
    const elsewhere = purpose !== 'read' ? await service.ownWorkElsewhereNote(actor) : '';
    if (elsewhere) throw noActiveProjectError(elsewhere);
    throw new Error(`No active project to ${purpose} — project_id is required when there is none. ${NO_PROJECT_NEXT_STEP}`);
  }
  return projectId;
}

// MANAGE_MEMORY(UPSERT_ENTITIES) TELLS THE SERVICE WHERE THE CALLER IS WORKING.
//
// The advertised top-level project_id reads "Project id or exact name. Omit to
// use the active project", and this action dropped it on the floor: only a
// per-entity project_id reached the service, whose default for an entity with
// neither is WORKSPACE scope. A member who wrote a career decision and a salary
// figure "into" their personal project handed both to every colleague through
// recall(entities), recall(search) and GET /workspace/entities (scan 28).
//
// So an entity that names no project of its own carries the top-level
// project_id, or — omitted — the active project, marked filed_by_default: the
// WORKING project, not the caller's word about this entity. The service decides
// from it (upsertWorkspaceEntities, workingProject): a new entity is filed there
// whenever the caller may edit its section there, and is workspace-level only
// when a member writes their own knowledge in a teammate's share that withholds
// it; an existing node keeps its own home (a sighting in the working project is
// recorded); a resolve or reopen goes to that project when its decision log
// carries the decision. Rounds 28-30 each broke a different case (scans 29-31).
//
// scope:"project" with no project_id is the caller asking for the working
// project. It is marked filed_by_default too, with the scope kept beside it: a
// dispatcher-filled project NEVER adopts an existing node — stamped as a named
// project it moved the team's workspace node into a member's personal project
// (scan 31) — and the ask is refused rather than widened when the caller may
// not file there. scope:"workspace" keeps an entity out of every project. With
// no project named and none active nothing is filled in. Only this grouped
// action: the legacy upsert_workspace_entities tool documents "defaults to
// workspace" and keeps its own contract.
// PARITY: packages/mcp-server/src/tools/context-sync.ts fileEntitiesUnderProject.
// Exact-title candidates narrowed to the caller's home: those filed in
// `projectId`, else the workspace-level ones — whichever tier has any. The
// input unchanged when no tier does, or when there is only one candidate.
// PARITY: packages/mcp-server/src/tools/context-sync.ts preferCallersHome.
function preferCallersHome(exact, projectId) {
  if (!Array.isArray(exact) || exact.length < 2) return exact;
  const tiers = [
    (entity) => Boolean(projectId) && entity.project_id === projectId,
    (entity) => !entity.project_id,
  ];
  for (const tier of tiers) {
    const hits = exact.filter(tier);
    if (hits.length) return hits;
  }
  return exact;
}

// ONE TITLE, SEVERAL HOMES. When every exact candidate carries the very same
// title — the caller's scoped copy beside a colleague's node, a decision two
// projects both recorded — "Re-run with the exact, complete title" cannot
// succeed: it already was exact (scan 33 p100). What tells them apart is where
// each lives, so the refusal names that and asks for project_id, which resolves
// in the named project's own decision log. A project the caller cannot open is
// not named. Null when the titles differ (the ordinary refusal applies).
// PARITY: packages/mcp-server/src/tools/context-sync.ts sameTitleHomes.
async function sameTitleHomes(actor, exact) {
  if (!Array.isArray(exact) || exact.length < 2) return null;
  const norm = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (new Set(exact.map((entity) => norm(entity.title))).size !== 1) return null;
  // Of one type (two types is entity_type's to tell apart), in more than one home.
  if (new Set(exact.map((entity) => entity.node_type || entity.metadata?.entity_type)).size !== 1) return null;
  if (new Set(exact.map((entity) => entity.project_id || '')).size < 2) return null;
  const projects = await service.listProjects(actor).catch(() => []);
  const names = new Map((projects || []).map((project) => [project.project_id, project.project_name]));
  return exact.map((entity) => {
    if (!entity.project_id) return 'workspace-level';
    if (!names.has(entity.project_id)) return 'in a project you cannot open';
    return `in ${names.get(entity.project_id) || 'a project'} (project_id: "${entity.project_id}")`;
  });
}

function entityNamesNoProject(entity) {
  return Boolean(entity) && typeof entity === 'object'
    && !(typeof entity.project_id === 'string' && entity.project_id.trim())
    && entity.scope !== 'workspace';
}

async function fileEntitiesUnderProject(actor, args) {
  const entities = Array.isArray(args?.entities) ? args.entities : null;
  if (!entities || !entities.some(entityNamesNoProject)) return args;
  const named = typeof args.project_id === 'string' && args.project_id.trim() ? args.project_id.trim() : null;
  let projectId = named;
  if (named) {
    // Refused up front, in words, rather than as each entity's project_not_found
    // skip. Read through getProject, so a project this person may not see reads
    // exactly like one that does not exist.
    const visible = await service.getProject(actor, named).catch(() => null);
    if (!visible) {
      const error = new Error(`No project "${named}" that you can see, so nothing was saved. List your projects with recall(action:"projects") and pass one of their ids as project_id, or omit project_id to use the active project.`);
      error.mcpCode = 'invalid_arguments';
      error.safeMessage = error.message;
      throw error;
    }
  } else {
    const active = await resolveActive(actor, { forWrite: true });
    projectId = active?.project_id || null;
  }
  // NOTHING TO FILE UNDER IS A REFUSAL, NOT A WORKSPACE SAVE (journey r5). An
  // entity that names no project used to fall through here and be stored
  // workspace-wide, readable by every member, without a word. The workspace is
  // for a caller who asks for it (scope:"workspace"); everyone else names a
  // project or has one active.
  if (!projectId) {
    const elsewhere = await service.ownWorkElsewhereNote(actor).catch(() => '');
    const error = new Error(elsewhere || NO_PROJECT_FOR_ENTITIES);
    error.mcpCode = 'invalid_arguments';
    error.safeMessage = error.message;
    throw error;
  }
  return {
    ...args,
    entities: entities.map((entity) => (entityNamesNoProject(entity)
      ? { ...entity, project_id: projectId, filed_by_default: true }
      : entity)),
  };
}

function logContextAudit(actor, action, meta = {}) {
  const ownerKey = workspace.defaultOwnerKey(actor);
  if (!ownerKey) return Promise.resolve();
  return db.query(
    // actor_user_id is the PERSON (a key-authed actor's id is the key id), so the
    // team activity view can say who did it — the REST writer always has; this
    // one left every hosted MCP write unattributed.
    `INSERT INTO context_audit_logs (audit_id, owner_key, project_id, action, actor_type, actor_user_id, tool, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [`audit_${randomUUID()}`, ownerKey, meta.project_id || null, action, 'mcp', workspace.actorPersonId(actor), meta.tool || null, meta],
    'org-system'
  ).catch((error) => {
    console.warn(`[MCP AUDIT] write failed | action=${action} | tool=${meta.tool || 'unknown'} | code=${error.code || 'unknown'}`);
  });
}

const router = express.Router();
// Sized for import_trail contents; see config/bodyLimits.js.
router.use(express.json({ limit: require('../config/bodyLimits').TRAIL_JSON_BODY_LIMIT }));
router.use((req, res, next) => {
  if (mcpInFlight >= MCP_MAX_CONCURRENCY) {
    res.set('Retry-After', '2');
    return res.status(503).json({
      jsonrpc: '2.0',
      id: req.body?.id ?? null,
      error: { code: -32003, message: 'MCP capacity reached. Retry shortly.' },
    });
  }
  mcpInFlight += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    mcpInFlight = Math.max(0, mcpInFlight - 1);
  };
  res.once('finish', release);
  res.once('close', release);
  next();
});

async function handleMcpRequest(req, res, next) {
  try {
    const actor = req.actor;
    // Fires once per connection, before any tool call. `initialize` is never
    // batched, so a JSON-RPC array body (.method undefined) safely skips this.
    // Gated on `actor`: an anonymous discovery initialize (registry/scanner with
    // no credentials) is not a real client connecting and must not write a
    // connect event — only an authenticated handshake flips onboarding.
    if (actor && req.body && req.body.method === 'initialize') {
      recordMcpConnect(actor, req.body?.params?.clientInfo);
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const claudeCatalog = req.baseUrl === CLAUDE_MCP_RESOURCE_PATH;
    const server = buildServer(actor, {
      catalog: claudeCatalog ? 'claude' : 'default',
      resourcePath: claudeCatalog ? CLAUDE_MCP_RESOURCE_PATH : MCP_RESOURCE_PATH,
      requestBase: requestBaseUrl(req),
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => server.close().catch(() => {}));
  } catch (err) {
    next(err);
  }
}

// On unauthenticated access, advertise the OAuth resource metadata so MCP
// clients (Claude.ai, ChatGPT.com, …) can discover the authorization server,
// dynamically register, and run the OAuth flow instead of failing outright.
// The origin this request reached, for a self-host with neither API_BASE_URL
// nor PUBLIC_URL set (the same derivation oauth.js's issuer() falls back to).
function requestBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return host ? `${proto}://${host}`.replace(/\/+$/, '') : '';
}

function requireMcpAuth(req, res, next) {
  const respond = res.status.bind(res);
  res.status = (code) => {
    if (code === 401) {
      const base = (process.env.API_BASE_URL
        || require('../config/selfHosted').selfHostedPublicUrl()
        || requestBaseUrl(req)).replace(/\/+$/, '');
      const resourcePath = req.baseUrl === CLAUDE_MCP_RESOURCE_PATH
        ? CLAUDE_MCP_RESOURCE_PATH
        : MCP_RESOURCE_PATH;
      res.set(
        'WWW-Authenticate',
        `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource${resourcePath}"`
      );
    }
    res.status = respond;
    return res.status(code);
  };
  return requireAuth(req, res, next);
}

// Public, read-only MCP discovery. Registries and scanners (Smithery, mcp.so,
// client connection probes) must be able to enumerate the static tool catalog
// WITHOUT credentials — otherwise they list "0 tools". Execution (`tools/call`)
// and everything else stay auth-gated. Only a fully credential-less request
// takes the public path; any request bearing a token / API key / cookie is
// routed through requireMcpAuth exactly as before.
//
// `initialize` MUST NOT be listed here, and this is load-bearing for activation.
// A real user's very first connection is a credential-less `initialize`, and per
// the MCP authorization spec the 401 + WWW-Authenticate on THAT request is the
// only thing that tells the client to run OAuth. While `initialize` was public
// (2026-06-30 → 2026-08-08, commit 5600ad46) every client — Claude, Cursor,
// ChatGPT — got a clean 200, concluded the server needed no authorization, and
// silently registered as "connected" without ever opening the authorize tab.
// The user saw a connected server whose every tool call then 401'd. Measured
// over that window: ~14 people copied the config, 0 ever reached the OAuth
// consent screen, 1 ever started a runtime. Registries are unaffected —
// `tools/list` is stateless here (sessionIdGenerator: undefined), so it returns
// the full catalog with no preceding handshake, which is how catalog scrapers
// read it. A 401 on anonymous initialize is the standard, expected response for
// an OAuth-protected MCP server.
const PUBLIC_DISCOVERY_METHODS = new Set([
  'tools/list',
  'ping',
]);

function hasCredentials(req) {
  return Boolean(
    req.headers['x-api-key'] || req.headers['authorization'] || req.headers.cookie
  );
}

function mcpAuthGate(req, res, next) {
  const body = req.body;
  const method = body && !Array.isArray(body) ? body.method : null;
  if (method && PUBLIC_DISCOVERY_METHODS.has(method) && !hasCredentials(req)) {
    // Anonymous discovery — no actor. ListTools returns the static catalog;
    // `tools/call` is not a public method, and dispatch fails closed without an
    // actor regardless, so no privileged path is reachable here.
    return handleMcpRequest(req, res, next);
  }
  return requireMcpAuth(req, res, next);
}

// GET is where Streamable HTTP puts the SERVER-initiated SSE stream, and this
// server has nothing to put on one. Every transport built here passes
// `sessionIdGenerator: undefined`: it is stateless and never pushes. What a
// 200 bought instead was an open stream per client that sent nothing forever —
// and the in-flight gate at the top of this router counts an open response for
// its whole lifetime, so roughly 64 idle editors (Cursor, VS Code, Claude Code
// over http, anything on the MCP TypeScript SDK, all of which open this stream
// after initialize and reconnect whenever it drops) were enough to answer 503
// "MCP capacity reached" to everybody else, Claude.ai included, while the
// server was doing no work at all.
//
// The spec allows answering GET with 405, and the SDK reads exactly that as
// "this server offers no SSE stream" and carries on over POST. Auth still runs
// FIRST, deliberately: an unauthenticated GET must keep returning the 401 with
// WWW-Authenticate that tells a client where to run OAuth, which is how a
// client discovers the authorization server today.
function noServerInitiatedStream(_req, res) {
  res.set('Allow', 'POST, DELETE');
  return res.status(405).json({
    jsonrpc: '2.0',
    id: null,
    error: {
      code: -32000,
      message: 'This MCP endpoint is stateless and offers no server-initiated stream. Send requests as POST.',
    },
  });
}

router.post('/', mcpAuthGate, handleMcpRequest);
router.get('/', requireMcpAuth, noServerInitiatedStream);
router.delete('/', (_req, res) => res.status(200).end());

// ─── Server factory ───────────────────────────────────────────────────────────

// Server-level implementation metadata surfaced in the `initialize` response.
// Registries and directories (e.g. Smithery) score a server on this: a
// human-readable title, description, homepage, and icons. All optional fields
// of the MCP `Implementation` schema (SDK ≥1.18) — clients that don't read them
// simply ignore them.
const SERVER_INFO = {
  name: 'deerdawn-mcp',
  title: 'DeerDawn',
  version: '1.0.0',
  description:
    'Project memory for AI sessions. Stores each project\'s current task, recent decisions, open questions, and known file paths, and loads them back as a brief in a later session or a different tool.',
  websiteUrl: 'https://deerdawn.com',
  icons: [
    { src: 'https://deerdawn.com/android-chrome-512x512.png', mimeType: 'image/png', sizes: ['512x512'] },
    { src: 'https://deerdawn.com/android-chrome-192x192.png', mimeType: 'image/png', sizes: ['192x192'] },
    { src: 'https://deerdawn.com/favicon-32x32.png', mimeType: 'image/png', sizes: ['32x32'] },
  ],
};

function buildServer(actor, { catalog = 'default', resourcePath = MCP_RESOURCE_PATH, requestBase = '' } = {}) {
  const advertisedTools = buildAdvertisedTools(catalog);
  const taskBoardUiEnabled = isTaskBoardUiEnabled();
  const server = new Server(
    SERVER_INFO,
    {
      capabilities: { tools: {}, ...(taskBoardUiEnabled ? { resources: {} } : {}) },
      // Surfaced automatically by the MCP host (Claude.ai, ChatGPT, etc.) into
      // the model's system context on initialize — the only auto-injection path
      // for web tools, which have no on-disk instruction files.
      instructions: buildMcpInstructions(),
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: advertisedTools.map((tool) => ({
      ...tool,
      title: tool.annotations?.title || tool.name,
      inputSchema: advertisedToolInputSchema(tool),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
        ...tool.annotations,
      },
      // OpenAI and other MCP clients use this per-tool declaration to request
      // accurate least-privilege consent. Runtime enforcement remains in
      // requireToolScope below and fails closed for unmapped tools.
      securitySchemes: [{ type: 'oauth2', scopes: [TOOL_SCOPES[tool.name]] }],
      // Both board-returning tools carry the widget pointer, so a host renders
      // the same board whether it was read or mutated.
      ...(taskBoardUiEnabled && (tool.name === 'manage_tasks' || tool.name === 'read_tasks')
        ? { _meta: taskBoardToolMeta() }
        : {}),
    })),
  }));

  if (taskBoardUiEnabled) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [taskBoardResource()] }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      if (request.params.uri !== TASK_BOARD_WIDGET_URI) throw new Error('resource_not_found');
      return {
        contents: [{
          uri: TASK_BOARD_WIDGET_URI,
          mimeType: taskBoardResource().mimeType,
          text: taskBoardWidgetHtml(),
          _meta: {
            ui: {
              prefersBorder: true,
              csp: { connectDomains: [], resourceDomains: [] },
              widgetDescription: 'Interactive DeerDawn task board for the selected project.',
            },
          },
        }],
      };
    });
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    // This server instance is built per-request and stateless, so clientInfo is
    // only populated on the request that carried `initialize`. On a bare
    // tools/call the surface comes from the OAuth credential the call arrived on
    // (credentialWebSurface), which names the client that was granted it; with
    // no such credential it is 'unknown_web' (a NON-identifying surface), the
    // honest label, never a guess. Never a hardcoded 'claude_web': that
    // mislabelled ChatGPT users' session/activation events and could fire a
    // false second_tool_connected.
    const surface = requestSurface(actor, server.getClientVersion());
    const tool = catalog === 'claude'
      ? advertisedTools.find((candidate) => candidate.name === name)
      : TOOLS.find((candidate) => candidate.name === name);
    // A tool that advertises readOnlyHint:true must change nothing that is the
    // caller's: no selection counters, no audit row, no activation event, no
    // product telemetry. That is what makes the hint a true statement rather
    // than a hopeful one.
    //
    // ONE EXCEPTION, AND IT IS STATED HERE BECAUSE THIS COMMENT USED TO SAY
    // "WRITE NOTHING" (activation plan 2026-10, Thing 3e). Every authenticated
    // call, read-only included, upserts one content-free row per person per UTC
    // day per tool per client (services/toolUsageDays.js): person, day, tool
    // name, client — never arguments, never results. It is the same kind of
    // operational write as the api_keys.last_used_at update auth performs on
    // this very request, it alters nothing any tool returns or stores for the
    // user, and the privacy policy's usage-data line says so. Without it "where
    // did I leave off?" answered by recall left no trace at all, and nothing
    // could tell a person who came back from one who did not.
    //
    // This used to be gated on `catalog === 'claude'`, because Claude's
    // directory was the first to require a genuinely read-only tool. The gate is
    // gone: suppression now follows the annotation on every catalog. Two reasons.
    // Behaviour that differs by which host is asking is the definition of
    // cloaking, and a reviewer who finds it treats it as hidden behaviour. And
    // the annotation is now honest for everyone rather than for one audience.
    //
    // Cost, accepted deliberately: recall / browse_skills / build_subagent_brief
    // calls no longer emit mcp_tool_call_succeeded on any surface. Connection
    // detection is unaffected — mcp_runtime_started still fires on the
    // initialize handshake, which is what the onboarding poll watches — and
    // start_session plus every write tool still report as before.
    try {
      return await runTool(tool, name, args, actor, surface, { clientInfo: server.getClientVersion() });
    } catch (err) {
      // runTool has already recorded the failed call; this only shapes the reply.
      const normalized = normalizeMcpError(err);
      const result = {
        content: [{ type: 'text', text: `Error [${normalized.code}]: ${normalized.message}` }],
        structuredContent: { error: normalized },
        isError: true,
      };
      if (err.oauthError) {
        // Hosted: API_BASE_URL or api.deerdawn.com, as before. Self-hosted:
        // API_BASE_URL, PUBLIC_URL, else the host this request reached.
        const base = require('../config/selfHosted').apiBaseUrl() || requestBase || '';
        result._meta = {
          'mcp/www_authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource${resourcePath}", error="${err.oauthError}", error_description="${normalized.message.replace(/["\\]/g, '')}"`,
        };
      }
      return result;
    }
  });

  return server;
}

// ─── Tool dispatch ────────────────────────────────────────────────────────────

/**
 * Mark this person's hosted session as still live.
 *
 * The id is derived exactly the way every hosted write derives it
 * (hostedSessionIdentity), because anything else would refresh a row no write
 * ever created — the caller's declared `tool` first, then the surface when the
 * handshake identified one, then the catalog default the tools themselves use.
 * A call that matches no stored row is a no-op, by design: touchSession only
 * UPDATEs, and the session start is the only thing that should create a row.
 *
 * project_id is deliberately null. touchSession would re-bind the session
 * through its COALESCE, and this says "still here", not "working somewhere
 * else" — a write that means the latter carries an explicit project_id and
 * binds through applyExtraction as it always did.
 */
function touchHostedSession(actor, args, surface) {
  const tool = hostedSessionTool(actor, args?.tool, surface);
  return service.touchSession(actor, hostedSessionId(actor, tool), null).catch(() => {});
}

/**
 * Point THIS connection at a project after an explicit choice.
 *
 * Best-effort on purpose: every caller has already done the thing the user asked
 * for, and a failed convenience binding must not turn a successful create or
 * start_session into an error. The worst case is the guessing this replaces.
 */
function bindHostedSession(actor, projectId, args, surface) {
  if (!projectId) return Promise.resolve(null);
  const tool = hostedSessionTool(actor, args?.tool, surface);
  return service.bindSessionToProject(actor, hostedSessionId(actor, tool), projectId, { tool })
    .catch(() => null);
}

// THE GUESS NOTE for a hosted start_session that opened a project nothing in
// the call pointed at. Names where it came from, the likely alternatives by id,
// and the single call that switches. start_session { project_id } is accepted
// by the handler; manage_projects select is the advertised route and binds the
// connection the same way, so the note names that one.
function formatGuessNote(active, alternatives = []) {
  const name = active.project_name || active.project_id;
  const lines = [
    `DeerDawn guessed "${name}" (${active.project_id}): it is where you most recently worked, and nothing tied this conversation to a project. If the work here is about a different project, switch before relying on this brief: manage_projects with action "select" and its project_id.`,
  ];
  const others = (alternatives || []).filter((a) => a && a.project_id);
  if (others.length) {
    lines.push(`Other recent projects: ${others.map((a) => `"${a.project_name || a.project_id}" (${a.project_id})`).join(', ')}.`);
  }
  return lines.join('\n');
}

// A connection moved off the project it would otherwise have opened. When that
// project was a GUESS this is the agent correcting a wrong opening: the
// measurable form of "DeerDawn loaded the wrong context". Best effort; a
// move that changes nothing, or one with no prior answer, records nothing.
function recordRoutingCorrection(actor, surface, prior, toProjectId, via) {
  if (!prior?.project_id || !toProjectId || prior.project_id === toProjectId) return;
  recordProductEvent(actor, {
    event_name: 'session_project_corrected',
    source: 'mcp',
    surface,
    transport: connectionIdentity.hostedTransport(actor),
    metadata: {
      via,
      from_match_kind: prior.match_kind || null,
      from_guessed: Boolean(prior.match_guessed),
      from_confidence: prior.match_confidence || null,
    },
  }).catch(() => {});
}

// What select says once it has moved this connection. ONE sentence, reused by
// create, which moves the connection too and used not to say so (H3-1).
function connectionMovedSentence(projectName) {
  return `This connection now works in "${projectName}". Other connections are unchanged.`;
}

// WHERE A PROJECT IS AND WHO READS IT, for the reply to manage_projects
// create and select: the project the connection's next saves go to.
//
// A person whose own projects were in another workspace was told to "create
// one", did, and got back `Created project "Lighthouse Blog" (…)` — nothing
// said it was in the TEAM, shared with every member by default, so their
// private note went in next (journey round 2). In a workspace with more than
// one member the reply names the workspace and the visibility, and, for a
// personal project of the caller's own, how to share it (journey round 4). The
// words are the service's (describeProjectPlacement), so the local server's
// create, which reads them from POST /projects, says the same.
function projectPlacementNote(actor, projectId, options = {}) {
  return service.describeProjectPlacement(actor, projectId, options).catch(() => '');
}

/**
 * Run ONE tool call the way every binding must: validate the arguments against
 * the tool's schema, bound it with the MCP timeout, sanitise what comes back,
 * audit a write, and record the call. Throws the raw error (after recording the
 * failure) so each binding can shape its own error reply.
 *
 * This lived inline in the MCP CallTool handler, and the A2A binding called
 * `dispatch` directly — so A2A skipped all five. An A2A write was unvalidated
 * (its record-memory-update sent `tool: 'a2a'`, which the session schema
 * rejected only AFTER the extraction model had been paid for), unbounded,
 * unsanitised, absent from the audit log and invisible to call recording. One
 * wrapper, two callers: the bindings can no longer differ in what a call costs
 * or leaves behind.
 */
async function runTool(tool, name, args, actor, surface, { clientInfo = null } = {}) {
  // Do not emit invocation state for tools whose advertised contract is
  // read-only (see the note in the CallTool handler).
  const readOnlyInvocation = tool?.annotations?.readOnlyHint === true;
  try {
    if (!tool) {
      const error = new Error(`Unknown tool: ${name}`);
      error.mcpCode = 'invalid_arguments';
      error.safeMessage = `Unknown tool: ${name}`;
      throw error;
    }
    // The one write every call makes, read-only ones included: a content-free
    // (person, UTC day, tool, client) row. Fire-and-forget — never awaited,
    // never thrown. See the note in the CallTool handler.
    toolUsageDays.recordToolUse(actor, {
      toolName: name,
      client: requestTool(actor, clientInfo) || surface || null,
    });
    try {
      validateToolArguments(tool, args);
    } catch (err) {
      throw withArgumentHint(name, args, err);
    }
    // What this call's project resolution had to say (see resolveActive):
    // collected while the call runs, added to its reply below.
    const callState = { notes: [] };
    let result = sanitizeToolResult(await withTimeout(
      callNotes.run(callState, () => dispatch(name, args, actor, surface, { readOnlyInvocation, clientInfo })),
      MCP_TOOL_TIMEOUT_MS,
      `Tool ${name}`,
    ));
    if (callState.notes.length) {
      const said = callState.notes.join('\n');
      // After the line that reports a save, before anything else for a read:
      // the confirmation is what the caller looks for first on a write.
      result = callWrites(name, args) ? appendNotice(result, said) : prependNotice(result, said);
    }
    // A write that landed somewhere other than the workspace the caller
    // believes they are in has to say so in the reply that reports the save.
    // start_session says it once at the top of a session; a session that began
    // before the card lapsed never heard it. Skipped for start_session, which
    // renders its own wording into the brief itself.
    //
    // DECIDED PER ACTION, NOT PER TOOL. The grouped tools carry context:write
    // because most of their actions do, so `manage_tasks {action:"list"}` — a
    // listing that saves nothing — was prefixed with "this was saved to your
    // personal workspace". A read gets the wording that is true of a read.
    if (actor?.workspace_fallback?.from && TOOL_SCOPES[name] === 'context:write') {
      result = prependNotice(
        result,
        callWrites(name, args) ? WORKSPACE_FALLBACK_WRITE_NOTICE : WORKSPACE_FALLBACK_NOTICE,
      );
    }
    // The audit row and the session touch below are keyed on the CALL, as the
    // notice above and requireToolScope are: keyed on the tool's scope, a
    // read-only key listing the board filed an mcp_tool_write row and bumped
    // the hosted session as if something had been saved.
    const writes = callWrites(name, args);
    if (writes) {
      await logContextAudit(actor, 'mcp_tool_write', {
        tool: name,
        project_id: typeof args.project_id === 'string' ? args.project_id : null,
      });
    }
    // A write, or the call that opens a session, is evidence this person is
    // here NOW. Only update_context used to leave that evidence (its extraction
    // pass upserts the session on the way through), so after any other tool the
    // routing rules still read a last_seen_at from an earlier sitting — which
    // is what let "a project created since you were last seen" stay true for
    // the rest of the day and take id-less writes with it.
    if (writes || name === 'start_session') {
      await touchHostedSession(actor, args, surface);
    }
    if (!readOnlyInvocation) recordMcpCall(actor, { tool: name, ok: true, clientInfo });
    return result;
  } catch (err) {
    if (!readOnlyInvocation) {
      const normalized = normalizeMcpError(err);
      recordMcpCall(actor, { tool: name, ok: false, clientInfo, error: normalized.code, errorMessage: normalized.message });
    }
    throw err;
  }
}

function text(t) {
  return { content: [{ type: 'text', text: String(t) }] };
}

// WHAT TO DO INSTEAD, where the schema's refusal alone is a dead end.
//
// A resolve's title is capped at 500 characters (advertised, and frozen with
// the catalog), while a decision can be longer and recall(action:"entities")
// lists it whole — so the listed text was refused with "exceeds the 500
// character limit" and nothing to do about it (scan 27). The decision resolve
// already accepts an opening of 80+ characters when exactly one open decision
// begins with it (service.resolveProjectDecision), so the refusal says so.
function withArgumentHint(name, args, err) {
  const resolving = name === 'mark_resolved' || (name === 'manage_memory' && args?.action === 'resolve');
  const said = String(err?.safeMessage || err?.message || '');
  if (resolving && /^arguments\.title exceeds the \d+ character limit$/.test(said)) {
    const message = `${said}. To resolve a decision that long, pass its first 80 or more characters instead, or the cut the brief shows (ending in "..."), exactly as shown: it resolves when exactly one open decision in the project begins with them.`;
    err.message = message;
    err.safeMessage = message;
  }
  return err;
}

// The sentence start_session already says when a request was rebound to the
// caller's personal workspace, in one place so a write can say the same thing.
const WORKSPACE_FALLBACK_NOTICE = 'This team workspace subscription is inactive, so this session is using your personal workspace.';
const WORKSPACE_FALLBACK_WRITE_NOTICE = 'This team workspace subscription is inactive, so this was saved to your personal workspace.';

// DOES THIS CALL WRITE ANYTHING?
//
// TOOL_SCOPES answers a different question — what the TOOL may do — and the
// grouped tools carry context:write because most of their actions do. So
// anything keyed on the scope alone treats `manage_tasks {action:"list"}` as a
// save, and the fallback notice told somebody reading a board that the board
// had been written to somebody else's workspace.
//
// Keyed by the action, with the SAME default each handler applies, because an
// omitted action is a real call shape: manage_tasks defaults to list (a read)
// and manage_memory to update (a write).
const READ_ACTIONS = {
  manage_tasks: { default: 'list', reads: new Set(['list']) },
  manage_todos: { default: 'list', reads: new Set(['list']) },
  manage_memory: { default: 'update', reads: new Set(['export_trail']) },
};

// The action is read EXACTLY as the handler reads it (no trim, no case fold):
// this also decides the scope a call needs (requireToolScope), and a classifier
// more forgiving than the handler it guards could call something a read that the
// handler then treats differently. An action spelled any other way is a write,
// which fails closed for a read-only credential.
function callWrites(name, args) {
  if (TOOL_SCOPES[name] !== 'context:write') return false;
  const shape = READ_ACTIONS[name];
  if (!shape) return true;
  const action = String(args?.action || shape.default);
  return !shape.reads.has(action);
}

/**
 * Put a notice in front of a tool reply's first text block.
 *
 * WHY A WRITE NEEDS ONE AND NOT JUST start_session. Every other surface refuses
 * a write while the bound workspace is refusing on billing grounds
 * (middleware/auth.js answers 409 workspace_inactive). The MCP transports
 * cannot: the client has no switcher and cannot send x-deerdawn-workspace, so a
 * refusal would leave it with no reachable workspace at all. It falls back and
 * saves the work, which is the right outcome and an invisible one, because the
 * reply otherwise reads exactly like a save into the team.
 *
 * Said on every write while the fallback is in effect, rather than once: each
 * hosted request builds its own actor, so there is no "first" to remember
 * without inventing a marker, and somebody writing several times in a row is
 * precisely the person who needs to know where it all went.
 */
function prependNotice(result, notice) {
  if (!notice || !result || !Array.isArray(result.content)) return result;
  const first = result.content.findIndex((part) => part?.type === 'text');
  if (first === -1) return result;
  const content = result.content.map((part, i) => (
    i === first ? { ...part, text: `${notice}\n\n${part.text}` } : part
  ));
  return { ...result, content };
}

function appendNotice(result, notice) {
  if (!notice || !result || !Array.isArray(result.content)) return result;
  const first = result.content.findIndex((part) => part?.type === 'text');
  if (first === -1) return result;
  const content = result.content.map((part, i) => (
    i === first ? { ...part, text: `${part.text}\n\n${notice}` } : part
  ));
  return { ...result, content };
}


/**
 * A HOSTED CONNECTION IS PINNED, AND ITS PERSON MAY NOT KNOW WHERE.
 *
 * An OAuth connection acts only in the workspace it was approved for (auth.js
 * bindPinnedWorkspace), however the dashboard switcher is set. So somebody who
 * connected Claude in their personal workspace, then joined a team and switched
 * to it, gets their personal brief with no mention of the team and no reason to
 * think anything is wrong. Said once, on start_session: where this connection
 * works, and the one way to use it somewhere else (approve it again from there).
 *
 * Fires only for a token that is actually pinned, when the person has a
 * different workspace selected, or belongs to a team this connection is not in.
 * Costs a solo account nothing: auth already loaded the memberships, and fewer
 * than two means there is nowhere else to be.
 */
async function pinnedConnectionNotice(actor) {
  const pin = actor.oauth_workspace_key;
  if (!pin || actor.workspace_binding !== 'pinned') return null;
  const memberships = Array.isArray(actor.workspace_memberships) ? actor.workspace_memberships : [];
  if (memberships.length < 2) return null;
  const personId = workspace.actorPersonId(actor);
  if (!personId) return null;

  const [selected, own] = await Promise.all([
    workspace.selectedWorkspaceKeyForPerson(personId),
    db.query('SELECT org_id FROM users WHERE user_id = $1', [personId], 'org-system').catch(() => ({ rows: [] })),
  ]);
  const home = own.rows[0]?.org_id || null;
  const others = selected && selected !== pin
    ? [selected]
    : memberships.map((m) => m.owner_key).filter((key) => key && key !== pin && key !== home);
  if (!others.length) return null;

  const named = await db.query(
    'SELECT org_id, name FROM organizations WHERE org_id = ANY($1)',
    [[pin, ...others]],
    'org-system',
  ).catch(() => ({ rows: [] }));
  const names = new Map(named.rows.map((row) => [row.org_id, row.name]));
  const label = (key) => (key === home ? 'your personal workspace' : (names.get(key) || 'another workspace'));
  return `This connection works in ${label(pin)}. To use it in ${others.map(label).join(' or ')}, approve the connection again from that workspace.`;
}

/**
 * A KEY THAT WORKS, IN A WORKSPACE THAT IS NOT THE ONE THEY MEANT.
 *
 * PR #504 correctly stopped a plain API key from following the is_active row, so
 * a key minted before somebody joined a team stays in their personal workspace.
 * Correct, and silent: their brief simply has none of their colleagues' work in
 * it, nothing says why, and `setup` will not re-run the device flow while the
 * saved key is still valid. An OAuth token is in the same position: it is
 * pinned to the workspace it was approved for, whatever the switcher says, and
 * its client cannot send the header either. It has its own wording, because
 * the way out is different (approve it again from the other workspace, not edit
 * a file): see pinnedConnectionNotice.
 *
 * Costs a solo account nothing: auth already loaded this person's memberships to
 * cap the key's scopes, and a solo account has exactly one. Only somebody who is
 * genuinely in another workspace pays for the name lookup.
 *
 * ONE DIRECTION ONLY, AND IT IS THIS ONE.
 *
 * This used to fire whenever the bound workspace was not the only membership,
 * which is every invited person on the INTENDED path, on every start_session
 * they will ever run: a key minted FOR the team is bound to the team, and its
 * owner is also a member of their own personal org, so the notice named that
 * personal org as somewhere they were "also a member of" and told them to use
 * "the team's .mcp.json" to reach it — advice that is wrong in that direction
 * and about a workspace that is not a team.
 *
 * The situation the notice describes is strictly the other way round: bound to
 * their OWN personal workspace while being an active member of a team. The
 * person's personal org is read from their user row rather than from
 * actor.org_id, which on a key-authed actor is the org the KEY was minted in —
 * the team itself, for exactly the people this used to misfire on.
 */
async function otherWorkspaceNotice(actor) {
  if (actor?.type === 'key' && actor.oauth_resource) return pinnedConnectionNotice(actor);
  if (actor?.type !== 'key') return null;
  const memberships = Array.isArray(actor.workspace_memberships) ? actor.workspace_memberships : [];
  // Fewer than two memberships is a solo account: nothing to be elsewhere than.
  // Checked first so that account still pays for no query at all.
  if (memberships.length < 2) return null;
  const personId = workspace.actorPersonId(actor);
  if (!personId) return null;

  const own = await db.query(
    'SELECT org_id FROM users WHERE user_id = $1',
    [personId],
    'org-system',
  ).catch(() => ({ rows: [] }));
  const personal = own.rows[0]?.org_id || null;
  if (!personal || workspace.defaultOwnerKey(actor) !== personal) return null;

  const teams = memberships.map((m) => m.owner_key).filter((key) => key && key !== personal);
  if (!teams.length) return null;

  const named = await db.query(
    'SELECT org_id, name FROM organizations WHERE org_id = ANY($1)',
    [teams],
    'org-system',
  ).catch(() => ({ rows: [] }));
  const names = new Map(named.rows.map((row) => [row.org_id, row.name]));
  const there = teams.map((key) => names.get(key) || key).join(', ');
  return `This key works in your personal workspace, so nothing from ${there} is in this session. To work there, use that team's .mcp.json or run setup again from its dashboard.`;
}

// Several service errors carry a human-actionable `publicMessage` alongside a
// terse machine code (e.g. project_limit_exceeded, project_has_subprojects,
// project_name_too_long, workspace_entity_title_required). Surface that instead
// of the bare code so the calling agent/session can relay something useful.
// No project_id and nothing active for this connection. A caller can act on
// that (pass project_id, or create/select a project), so it is an argument error
// carrying its own words — a bare Error here matched none of normalizeMcpError's
// classifiers and was reported as internal_error "could not be completed".
// `elsewhere` is service.ownWorkElsewhereNote's refusal, or '': a write that
// found nothing because this person's own projects are in another workspace is
// answered with that text alone. The generic one's "create or select a project
// first" steered such a person into creating their project here, shared with
// the team by default; everybody else keeps it, unchanged.
function noActiveProjectError(elsewhere = '') {
  const error = new Error(elsewhere || 'No active project — pass project_id, or create or select a project first (manage_projects).');
  error.mcpCode = 'invalid_arguments';
  error.safeMessage = error.message;
  return error;
}

function rethrowWithPublicMessage(err) {
  if (err?.publicMessage) {
    const safe = new Error(err.publicMessage);
    safe.safeMessage = err.publicMessage;
    safe.mcpCode = 'invalid_arguments';
    throw safe;
  }
  throw err;
}

// move/complete/remove each resolve EVERY query to exactly one card through
// shared-context's resolveTaskCard — the same rule the merge applies — and the
// event then names that card by ID, so the write cannot land on a different or
// additional card than the one reported. An ambiguous query writes nothing and
// lists the candidates with their ids, because a caller told only "ambiguous"
// has no way to become unambiguous.
//
// PARITY: packages/mcp-server/src/tools/context-sync.ts does the same.
function resolveTodoQueries(cards, queries) {
  const resolutions = (queries || []).map((q) => resolveTaskCard(cards, q));
  return {
    matched: resolutions.filter((r) => r.status === 'matched'),
    ambiguous: resolutions.filter((r) => r.status === 'ambiguous'),
    unmatched: resolutions.filter((r) => r.status === 'unmatched').map((r) => r.query),
  };
}

function formatAmbiguousTodos(ambiguous, verb) {
  return ambiguous.map((r) => [
    `"${r.query}" matches ${r.candidates.length} cards, so nothing was ${verb} for it. Re-run with the card id:`,
    ...r.candidates.map((c) => `    - "${c.title}" [${c.id}]${c.phase ? ` (${String(c.phase).replace(/_/g, ' ')})` : ''}`),
  ].join('\n')).join('\n');
}

function ambiguousTodoData(ambiguous) {
  return ambiguous.length
    ? ambiguous.map((r) => ({ query: r.query, candidates: r.candidates }))
    : undefined;
}

// Return a tool result carrying BOTH a human/model-readable text block (kept for
// backward compatibility — every existing client reads content[]) AND
// `structuredContent`, the machine-readable payload matching the tool's declared
// `outputSchema`. The MCP spec requires a tool advertising an outputSchema to
// return structuredContent, so the two always travel together.
// Under the 30s MCP deadline with room for the writes that follow it.
const HOSTED_EXTRACTION_TIMEOUT_MS = 8_000;

// Why an update_context did not store the caller's words, said truthfully. One
// sentence used to cover all three and was wrong for two of them: "the write
// returned without error" is false when the write was REFUSED.
function explainNotStored(outcome) {
  if (outcome?.reason === 'forbidden') {
    return outcome.refusal_message
      || 'you do not have write access to this section of the project, so nothing was saved.';
  }
  // Lost the race with other writers on every attempt. Nothing was saved, and
  // unlike a refusal a retry is exactly the right move.
  if (outcome?.reason === 'conflict') {
    return outcome.refusal_message
      || 'other writes to this project kept landing at the same moment, so nothing was saved. Retry.';
  }
  if (outcome?.reason === 'unverifiable') {
    return 'the write was sent but the project could not be read back to confirm it. Check with recall before retrying.';
  }
  return 'the write returned without error but your text is not in the stored brief. Retry, or use action "record_finding".';
}

// The Done column keeps the most recently completed MAX_DONE_RETAINED cards, so
// completing one at the cap pushes the oldest completion off the board. That is
// the design; saying nothing about it is not. These gather what each board write
// reported it evicted (applyStructuredContextEvent's evicted_cards) so the reply
// names the cards instead of answering "Marked complete" over a silent loss.
function collectEvictedCards(into, eventResult) {
  const cards = Array.isArray(eventResult?.evicted_cards) ? eventResult.evicted_cards : [];
  for (const card of cards) {
    if (card?.title && !into.some((seen) => (seen.id && seen.id === card.id) || seen.title === card.title)) into.push(card);
  }
  return into;
}

function describeEvictedCards(cards) {
  const shown = cards.slice(0, 5).map((card) => `"${card.title}"`).join(', ');
  const more = cards.length > 5 ? ` and ${cards.length - 5} more` : '';
  return `The board is at its limit, so ${cards.length === 1 ? 'this older card was' : 'these older cards were'} removed to make room: ${shown}${more}.`;
}

function textData(t, data) {
  return { ...text(t), structuredContent: data };
}

// Prose tools return a formatted brief; their structured payload is that same
// text under a `text` key (matches their `{ text }` outputSchema).
function textOnly(t) {
  return textData(t, { text: String(t) });
}

// MCP-01: required scope per tool. Read tools need context:read; write tools need context:write.
// New tools MUST be added here or dispatch fails closed.
const TOOL_SCOPES = {
  // Trail dispatch targets. manage_memory routes to these by name and dispatch
  // fails closed on anything unlisted, so omitting them made export_trail and
  // import_trail unreachable with "insufficient_scope" even though the tool
  // advertised both actions. Export reads a project; import writes one.
  export_trail: 'context:read',
  import_trail: 'context:write',
  recall: 'context:read',
  manage_projects: 'context:write',
  manage_memory: 'context:write',
  manage_tasks: 'context:write',
  read_tasks: 'context:read',
  browse_skills: 'context:read',
  start_session: 'context:read',
  list_projects: 'context:read',
  get_context: 'context:read',
  search_context: 'context:read',
  get_workspace_overview: 'context:read',
  get_project_map: 'context:read',
  find_known_paths: 'context:read',
  get_workspace_entities: 'context:read',
  get_portfolio: 'context:read',
  get_next_best_context: 'context:read',
  build_subagent_brief: 'context:read',
  list_skills: 'context:read',
  get_skill: 'context:read',
  create_project: 'context:write',
  update_context: 'context:write',
  record_hot_paths: 'context:write',
  upsert_workspace_entities: 'context:write',
  record_debug_finding: 'context:write',
  manage_todos: 'context:write',
  switch_subproject: 'context:write',
  archive_project: 'context:write',
  set_project_parent: 'context:write',
  rename_project: 'context:write',
  mark_resolved: 'context:write',
  resolve_open_question: 'context:write',
  cleanup_context: 'context:write',
};

function actorHasScope(actor, scope) {
  const scopes = Array.isArray(actor?.scopes) ? actor.scopes : [];
  if (scopes.includes('*') || scopes.includes(scope)) return true;
  // context:admin implies write+read; context:write implies read.
  if (scope === 'context:read') return scopes.includes('context:write') || scopes.includes('context:admin');
  if (scope === 'context:write') return scopes.includes('context:admin');
  return false;
}

// The scope a CALL needs, not the tool: the grouped tools carry context:write
// because most of their actions write, but manage_tasks(list) and
// manage_memory(export_trail) read. Keyed on the tool alone, a read-only key —
// every viewer's, and anybody's deliberately narrowed one — was refused a board
// listing on /mcp, where read_tasks is not advertised, so a viewer had no way to
// read the board at all. The action classification is callWrites', the same one
// the workspace-fallback notice uses, so the two cannot disagree about a call.
// A viewer's WRITE is still refused twice: here by scope, and by the workspace
// role in the service layer for a key that does carry context:write.
function requiredScopeFor(name, args) {
  const required = TOOL_SCOPES[name];
  if (required === 'context:write' && READ_ACTIONS[name] && !callWrites(name, args)) return 'context:read';
  return required;
}

function requireToolScope(actor, name, args) {
  const required = requiredScopeFor(name, args);
  if (!required) {
    const err = new Error(`insufficient_scope: tool '${name}' is not authorized`);
    err.oauthError = 'insufficient_scope';
    throw err;
  }
  if (!actorHasScope(actor, required)) {
    const err = new Error(`insufficient_scope: this credential lacks the '${required}' scope required by '${name}'`);
    err.oauthError = 'insufficient_scope';
    err.requiredScope = required;
    throw err;
  }
}

// `queries` OPENS cards instead of listing the board: a card's body is never
// rendered in a listing (the listing already strains the response limit with
// titles alone), so the marked cards are opened by id or title phrase. The
// rendering itself is shared-context's formatTaskCardDetail — the one part of
// this feature both dispatchers physically cannot drift on.
// cards_per_phase is advertised as `number`, NOT `integer`, and that is load
// bearing. It shipped as `integer` in 1.0.47 and was refused end to end on every
// call — before AND after the server-side integer fix in #458 — while every
// pre-existing numeric parameter in this catalog (recall's `limit`, and the rest)
// uses `number` and works. `limit: 5` was tested against production and returned
// normally in the same session that `cards_per_phase: 2` did not.
//
// Which layer rejects `integer` was NOT localised: the server accepts it when the
// same validation runs locally, and MCP requests are only logged here when slow,
// so their absence proves nothing. What is reproducible is that the TYPE is the
// only difference between a parameter that works and one that does not. Following
// the convention that demonstrably works beats being right about JSON Schema.
//
// So do not "tidy" this back to `integer`. A fractional value is floored in
// shared-context rather than refused, which is the friendlier end of the same
// decision. Range is still enforced at validation.
function taskListingOptions(args) {
  const n = args?.cards_per_phase;
  return Number.isFinite(n) ? { cards_per_phase: n } : {};
}

// A title -> {phase, body} index of the cards a project stores in todo_items.
//
// manage_tasks builds its write replies by comparing one of these from BEFORE
// the write against one from after, so this has to index EXACTLY the list the
// merge in shared-context dedupes against, which is todo_items and nothing
// else. task_steps render as derived cards and are not rows, so a step must not
// make a real card look like it already existed — and the legacy
// `completed_todos` the Done column folds in for reading is the same mistake
// from the other side: the merge does not consult it, so a project carrying one
// had a card genuinely created in Backlog and was told "already exists in
// backlog; nothing was added".
//
// The rendered Done column still shows those legacy entries. This index is not
// the board; it is the answer to "what would an add collide with".
function indexBoardCardsByTitle(project) {
  const context = project?.context || {};
  const cards = Array.isArray(context.todo_items) ? context.todo_items : [];
  const byTitle = new Map();
  for (const card of cards) {
    const key = String(card?.title || '').trim().toLowerCase();
    if (!key || byTitle.has(key)) continue;
    byTitle.set(key, { phase: String(card.phase || 'backlog'), body: String(card.body || '') });
  }
  return byTitle;
}

const phaseLabel = (phase) => String(phase || '').replace(/_/g, ' ');

async function renderTaskBoard(actor, projectId, queries = [], listingOptions = {}) {
  const project = await service.getProject(actor, projectId);
  if (!project) throw new Error('project_not_found');
  const context = project.context || {};
  if (Array.isArray(queries) && queries.length) {
    return textData(formatTaskCardDetail(context, queries), {
      action: 'list',
      project_id: project.project_id,
      project_name: project.project_name,
      opened: queries,
    });
  }
  const snapshot = buildTaskBoardSnapshot(context, project);
  // Render from the BOUNDED listing, not the full snapshot: the text half and the
  // structured half have to describe the same view, and an unbounded text board
  // exceeds CONTENT_BUDGET_CHARS on titles alone, at which point our own
  // sanitizeToolResult truncates it on the way out. Column headings still print
  // col.total — the stored count, never the number of rows shown.
  const listing = taskBoardSnapshotForListing(snapshot, listingOptions);
  const columns = listing.board;
  const total = snapshot.total_cards;
  const lines = [`Task board for ${project.project_name}:`];
  let withBody = 0;
  if (!total) {
    lines.push('  (empty — add a card with manage_tasks and action:"add")');
  } else {
    for (const col of columns) {
      lines.push(`  ${col.label} (${col.total}):`);
      if (!col.cards.length) { lines.push('    —'); continue; }
      for (const task of col.cards) {
        const when = col.phase === 'done' && task.completed_at
          ? ` (${String(task.completed_at).slice(0, 10)})`
          : '';
        if (task.has_body) withBody += 1;
        lines.push(`    - ${task.title}${when} [${task.id}]${task.has_body ? TASK_BODY_MARKER : ''}`);
      }
      // Name the elision in the column it happened to. A listing that quietly
      // showed 20 of 158 is the failure this whole function exists to avoid.
      if (col.has_more) {
        lines.push(`    …+${col.total - col.returned} more not shown — open by id with todos:["<card id>"].`);
      }
    }
  }
  if (withBody) {
    lines.push(`  ${withBody} card${withBody > 1 ? 's carry' : ' carries'} detail — open with todos:["<card id>"].`);
  }
  return textData(lines.join('\n'), {
    action: 'list',
    ...listing,
  });
}

async function dispatch(name, args, actor, surface = 'unknown_web', invocation = {}) {
  // MCP-01: enforce the per-tool scope before doing any work (fail-closed for unmapped tools).
  requireToolScope(actor, name, args);
  // Names to ids, once, for every tool rather than per handler. See the block
  // above resolveProjectRefs. The grouped tools dispatch recursively, and by the
  // time they do the reference is already an id, so the inner pass short-circuits
  // without a second lookup.
  args = await resolveProjectRefs(args, actor);
  switch (name) {
    case 'recall': {
      const action = String(args?.action || 'context');
      const targets = {
        projects: 'list_projects',
        context: 'get_context',
        search: 'search_context',
        overview: 'get_workspace_overview',
        map: 'get_project_map',
        paths: 'find_known_paths',
        entities: 'get_workspace_entities',
        next: 'get_next_best_context',
        // The one read that crosses project boundaries. Reached as an ACTION
        // rather than a new tool name: the advertised surface is a token budget,
        // and an enum value costs a word where a tool costs a schema.
        portfolio: 'get_portfolio',
      };
      const target = targets[action];
      if (!target) throw new Error(`Unknown recall action: ${action}`);
      return dispatch(target, args, actor, surface, invocation);
    }

    case 'manage_projects': {
      const action = String(args?.action || 'create');
      const targets = {
        create: 'create_project',
        select: 'switch_subproject',
        archive: 'archive_project',
        restore: 'archive_project',
        move: 'set_project_parent',
        rename: 'rename_project',
      };
      const target = targets[action];
      if (!target) throw new Error(`Unknown manage_projects action: ${action}`);
      return dispatch(target, action === 'restore' ? { ...args, unarchive: true } : args, actor, surface, invocation);
    }

    case 'manage_memory': {
      const action = String(args?.action || 'update');
      const targets = {
        update: 'update_context',
        record_paths: 'record_hot_paths',
        record_finding: 'record_debug_finding',
        upsert_entities: 'upsert_workspace_entities',
        resolve: 'mark_resolved',
        // Deliberately NOT folded into `resolve`. mark_resolved flips a workspace
        // graph ENTITY; this edits the brief's open_questions list. Two different
        // stores behind one verb would have to be told apart by which optional
        // argument happened to be present, and choosing a destructive path by
        // loose matching is the failure this repo has already paid for.
        resolve_question: 'resolve_open_question',
        finish_task: 'cleanup_context',
        export_trail: 'export_trail',
        import_trail: 'import_trail',
      };
      const target = targets[action];
      if (!target) throw new Error(`Unknown manage_memory action: ${action}`);
      // The top-level project_id (or the active project) is the working project
      // of entities naming no project of their own. See fileEntitiesUnderProject.
      const routed = action === 'upsert_entities' ? await fileEntitiesUnderProject(actor, args) : args;
      return dispatch(target, routed, actor, surface, invocation);
    }

    case 'manage_tasks':
      return dispatch('manage_todos', args, actor, surface, invocation);

    case 'read_tasks': {
      let projectId = args?.project_id;
      if (!projectId) {
        const active = await resolveActive(actor);
        projectId = active?.project_id;
      }
      if (!projectId) throw noActiveProjectError();
      // Opening a card's body is a READ, so it has to be reachable from the
      // read-only tool. Without this, the Claude catalog — whose manage_tasks
      // deliberately has no list action — could write bodies and never read one.
      const open = Array.isArray(args?.todos) ? args.todos.filter(Boolean).map(String) : [];
      return renderTaskBoard(actor, projectId, open, taskListingOptions(args));
    }

    case 'browse_skills': {
      const action = String(args?.action || 'list');
      if (action === 'list') return dispatch('list_skills', args, actor, surface, invocation);
      if (action === 'get') return dispatch('get_skill', args, actor, surface, invocation);
      throw new Error(`Unknown browse_skills action: ${action}`);
    }

    case 'start_session': {
      // Cross-connection dedup, marked but never used to withhold the brief here.
      //
      // The suppression this used to do rests on an assumption that only holds
      // locally: sessionDedup's own safety note is that Claude Code still gets
      // full context from its SessionStart hook, so dropping the TOOL payload
      // costs nothing. A web client — ChatGPT, claude.ai — has no hook. For them
      // the tool payload IS the brief, and suppressing it returned a bare
      // already-loaded pointer and nothing else. Two ChatGPT conversations
      // opened within 90 seconds, or one reviewer working through desktop, iOS
      // and Android on a single account, hit exactly that: the product's
      // headline call answering with a refusal.
      //
      // So this route always delivers. The marker is still written, because the
      // local path (context-sync.js, mark_session=1) reads it and there the hook
      // fallback genuinely exists — that is where the duplicate-payload saving
      // was real. And `dedup.duplicate` still gates the session ACCOUNTING
      // below, so a second connector racing at session start cannot inflate
      // session_number or double-count a delivery.
      // A project the caller NAMED wins over the one history would guess. Read
      // through getProject, so a project this person may not see resolves to
      // nothing and the call falls back to their own active project rather than
      // confirming that the id exists.
      const requestedId = typeof args?.project_id === 'string' ? args.project_id.trim() : '';
      const requested = requestedId
        ? await service.getProject(actor, requestedId).catch(() => null)
        : null;
      // `context` is not decoration on this stub. buildSessionCatchup reads
      // project.context for every slot it renders, so a stub without it made
      // "since your last session", the team delta and the contradiction pass all
      // EMPTY on any call that named a project — the resolved-project branch has
      // always carried it, and only this one did not.
      const activeForDedup = requested
        ? {
          project_id: requested.project_id,
          project_name: requested.project_name,
          match_kind: 'explicit',
          context: requested.context,
        }
        : await resolveActive(actor);
      // Naming a project is choosing one, so it binds this connection: on the
      // hosted transport `start_session { project_id }` used to bind nothing at
      // all, and the very next id-less call reverted to the old project.
      //
      // AND IT SAYS SO, in select's words (journey r4). The reply said only
      // "Resuming X", so a person who opened another project's brief to look
      // at it had their next id-less saves filed there with nothing telling
      // them the connection had moved. Only when the bind happened: with no
      // project named, or one this caller cannot see, nothing moves and the
      // reply is unchanged.
      // What this connection would have opened WITHOUT the named project, read
      // before the bind moves it: a named project that differs from a guess is
      // the agent correcting a wrong opening, which is the rate worth watching.
      const priorForCorrection = requested ? await service.resolveActiveProject(actor, null, null, { sessionId: hostedSessionId(actor) }).catch(() => null) : null;
      const bound = requested ? await bindHostedSession(actor, requested.project_id, args, surface) : null;
      if (bound && !invocation.readOnlyInvocation) recordRoutingCorrection(actor, surface, priorForCorrection, bound.project_id, 'start_session');
      const movedLine = bound ? connectionMovedSentence(bound.project_name || bound.project_id) : null;
      const dedup = await checkAndMarkSessionLoad(actor, activeForDedup?.project_id, surface);
      // Day-two catch-up on the resolved project — leads the payload so a return
      // session opens on what CHANGED, with the workspace overview as the body.
      // Best-effort (null on failure/first session); the overview never depends on it.
      // Skipped for a duplicate: the brief still goes out, but this is the
      // accounting half, and a racing connector must not book a second session.
      // The stored load names the TOOL when the request says which one
      // (requestTool), so the next catch-up can say "last session … in Claude
      // Code"; the events keep `surface`, which is what they are read by.
      const catchup = (!dedup.duplicate && activeForDedup?.project_id)
        ? await buildSessionCatchup(actor, activeForDedup, surface, {
          transport: connectionIdentity.hostedTransport(actor),
          loadTool: requestTool(actor, invocation.clientInfo),
        })
        : null;
      // Same values and default the local server's start_session accepts.
      const verbosity = args?.verbosity === 'light' ? 'light' : 'standard';

      // WHY THIS WORKSPACE. When a team's billing lapses, auth re-binds the
      // request to the caller's own personal workspace and records it on the
      // actor. Nothing said so, so from the tool's side the brief simply
      // changed: different projects, no teammates, no explanation. Prepended to
      // every reply below, including the empty-account ones, because a personal
      // workspace with nothing in it is exactly where this lands.
      //
      // The second notice answers the other way a brief can be surprisingly
      // empty: a plain API key minted before its holder joined a team stays in
      // the workspace it was minted for, by design, and nothing said so.
      const workspaceNotice = actor?.workspace_fallback?.from ? WORKSPACE_FALLBACK_NOTICE : null;
      const keyWorkspaceNotice = workspaceNotice ? null : await otherWorkspaceNotice(actor).catch(() => null);
      const notices = [workspaceNotice, keyWorkspaceNotice].filter(Boolean).join('\n\n');
      const withNotice = (text) => (notices ? `${notices}\n\n${text}` : text);

      // PARITY with start_session in packages/mcp-server/src/tools/context-sync.ts,
      // which renders the active project's full injection (via /active). This
      // route used to answer with the startup workspace overview instead: "what
      // matters now", a few knowledge nodes and recent changes, but none of the
      // decisions, open questions, landmines, board or hot paths the tool's own
      // description promises. So a hosted user got a thinner brief than a local
      // one for the same project.
      //
      // record_side_effects is off on purpose. Delivery telemetry for this route
      // is emitted once below by recordRemoteSessionDelivery, gated on
      // readOnlyInvocation and on dedup; letting renderInjection emit too would
      // count every hosted session start twice.
      //
      // Falls back to the overview when no project resolves, or when the
      // injection renders nothing (the user paused injection, or the project
      // became unreadable between resolution and render).
      let body = null;
      let overview = null;
      // The receipt line (formatBriefReceipt, computed by renderInjection from the
      // project it rendered): the first line of a loaded brief. null when no
      // brief rendered — it describes the brief, so without one it says nothing.
      let receipt = null;
      if (activeForDedup?.project_id) {
        const payload = await service.renderInjection(
          actor,
          activeForDedup.project_id,
          hostedBriefTool(actor, invocation.clientInfo, surface),
          verbosity,
          null,
          {
            record_side_effects: false,
            now: new Date().toISOString(),
            // Only this one kind. The others would add "directory not linked",
            // which means nothing to a client that has no directory.
            ...(activeForDedup.match_kind === 'shared_fallback' ? { matchKind: 'shared_fallback' } : {}),
          },
        ).catch((err) => {
          console.warn(`[MCP] start_session brief render failed | code=${err?.code || 'unknown'}`);
          return null;
        });
        if (typeof payload?.body === 'string' && payload.body.trim()) {
          const resuming = `Resuming ${activeForDedup.project_name || activeForDedup.project_id}`;
          body = `${movedLine ? `${resuming}\n${movedLine}` : resuming}\n\n${payload.body.trim()}`;
          receipt = typeof payload.receipt === 'string' && payload.receipt.trim() ? payload.receipt.trim() : null;
        }
      }
      if (!body) {
        overview = await service.getWorkspaceOverview(actor, { mode: 'startup', verbosity });
        body = overview?.text || formatWorkspaceOverview(overview, verbosity);
        // The brief did not render, and the connection moved all the same.
        if (movedLine && body) body = `${movedLine}\n\n${body}`;
      }
      // WHY THIS PROJECT, AND HOW OUT OF IT. Nothing in the call named one, this
      // connection has never been bound, and there is no directory to read: the
      // answer came from what this person most recently touched somewhere else.
      // An agent handed a guess with no way out uses it, so the note names the
      // likely alternatives by id and the one call that switches. It leads the
      // WHOLE reply (above the receipt and catch-up), because a caveat after
      // the brief is read after the brief has already been believed.
      const guessNote = body && activeForDedup?.match_guessed
        ? formatGuessNote(activeForDedup, await service.listRoutingAlternatives(actor, activeForDedup.project_id, 3).catch(() => []))
        : null;
      // A capture from an earlier session was filed in this project because the
      // project that session was bound to has since been archived (or is no
      // longer shared with the caller). Said once, here, with how to restore or
      // pick another (journey r5). The read clears it; a start that renders no
      // project has nothing to attach it to.
      if (body && activeForDedup?.project_id && !invocation.readOnlyInvocation) {
        const deadBindingNote = await service.takeDeadBindingNotice(actor, activeForDedup.project_id);
        if (deadBindingNote) body = `${deadBindingNote}\n\n${body}`;
      }
      // Telemetry runs on every non-duplicate start_session. A duplicate now
      // still receives the brief, but it is the same logical session as the call
      // moments before it, so counting it again would inflate context_delivered
      // and the activation funnel behind it. Honours readOnlyInvocation for the
      // same reason get_context does.
      //
      // "Delivered" is judged on the STRUCTURED overview, never on the length of
      // the rendered text. A workspace with nothing in it still renders a
      // placeholder ("What matters now / - No active workspace summary yet."),
      // which comfortably clears the emptiness check below — so a length test
      // would book a first_sync for a brand-new user who received no context at
      // all, and quietly inflate the activation rate with people the product has
      // not worked for yet. Projects, graph entities and a resolved active
      // project are what actually constitute context reaching the tool.
      const deliveredRealContext = Boolean(
        activeForDedup?.project_id
        || overview?.projects?.length
        || overview?.knowledge?.length
        || overview?.tools?.length
        || overview?.capabilities?.length
      );
      if (!invocation.readOnlyInvocation && !dedup.duplicate) {
        recordRemoteSessionDelivery(actor, {
          surface,
          projectId: activeForDedup?.project_id || null,
          delivered: deliveredRealContext,
          matchKind: activeForDedup?.match_kind || null,
          matchGuessed: Boolean(activeForDedup?.match_guessed),
        });
      }

      // ARCHIVING A PROJECT DOES NOT DELETE ITS GRAPH.
      //
      // The archived-projects notice used to hang off deliveredRealContext,
      // which counts knowledge/tools/capabilities — and those nodes OUTLIVE the
      // project they were promoted from. So somebody whose projects had all aged
      // out was handed a few surviving entities, judged "not empty", and never
      // told that their projects are one restore away: the exact failure the
      // notice exists to prevent, in the product whose promise is not forgetting.
      //
      // The notice asks a narrower question than the telemetry does — is there a
      // LIVE project to resume — so it gets its own test. deliveredRealContext is
      // left alone: it measures whether context reached the tool, which surviving
      // entities genuinely are.
      const hasLiveProjectContext = Boolean(activeForDedup?.project_id || overview?.projects?.length);
      // Looked up at most once per call, then reused by the branches below.
      let archivedNoticeCache;
      const archivedProjectsNotice = async () => {
        if (archivedNoticeCache === undefined) {
          // The whole set, not the default page of 10: the notice COUNTS what it
          // is given, and a count of 10 beside a listing of 14 contradicts the
          // listing it sends the assistant to.
          const archived = await service.listArchivedProjectSummaries(actor, { limit: ARCHIVED_PROJECTS_FETCH_LIMIT }).catch(() => []);
          archivedNoticeCache = formatArchivedProjectsNotice(archived) || null;
        }
        return archivedNoticeCache;
      };
      if (!hasLiveProjectContext) {
        const notice = await archivedProjectsNotice();
        if (notice) return textOnly(withNotice(notice));
      }

      // An empty account is judged on the structured overview, for the reason
      // given above: the rendered placeholder always clears a length test, which
      // is why a brand-new hosted user used to receive "No active workspace
      // summary yet." and nothing to do next.
      if (!deliveredRealContext) {
        if (!invocation.readOnlyInvocation && !dedup.duplicate) {
          recordProductEvent(actor, {
            event_name: 'first_session_guide_shown',
            source: 'mcp',
            surface,
            transport: connectionIdentity.hostedTransport(actor),
            metadata: { transport: 'http' },
          }).catch(() => {});
        }
        return textOnly(withNotice(buildFirstSessionGuide()));
      }

      if (!body || body.trim().length < 10) {
        // Before declaring an empty workspace, check for archived projects. A
        // user whose projects aged out still HAS their memory — saying "no
        // context yet" would be both wrong and the exact failure this product
        // exists to prevent.
        const notice = await archivedProjectsNotice();
        if (notice) return textOnly(withNotice(notice));
        return textOnly(withNotice('No DeerDawn context yet. Create a project with manage_projects and action "create", or import a CLAUDE.md or AGENTS.md file from the DeerDawn dashboard.'));
      }
      const brief = withNotice(catchup?.text ? `${catchup.text}\n\n${body}` : body);
      const delivered = receipt ? `${receipt}\n\n${brief}` : brief;
      return textOnly(guessNote ? `${guessNote}\n\n${delivered}` : delivered);
    }

    case 'list_projects': {
      // Live AND archived. start_session sends somebody whose projects were
      // archived here "for the IDs"; a listing of live projects only answered
      // "No projects yet ... create one", and the assistant created an empty
      // project beside the archived one. The archived feed is the same one the
      // notice reads, filtered exactly as the live listing is, and rendering is
      // shared-context's so the local server says the same (formatProjectListing).
      const [tree, archived] = await Promise.all([
        service.listProjectTree(actor),
        service.listArchivedProjectSummaries(actor, { limit: ARCHIVED_PROJECTS_FETCH_LIMIT }).catch(() => []),
      ]);
      const listing = formatProjectListing(tree, archived);
      return textData(listing.text, listing.data);
    }

    case 'create_project': {
      const { project_name, description, parent_project_id } = args;
      if (!project_name || typeof project_name !== 'string') throw new Error('project_name required');
      // Not advertised (a hosted client has no repo to name), but honoured when a
      // caller that does have one sends it, as switch_subproject already does:
      // a project with no workspace_key cannot be pinned.
      const workspace_key = typeof args.workspace_key === 'string' && args.workspace_key.trim()
        ? args.workspace_key.trim().slice(0, 512)
        : undefined;
      let project;
      try {
        project = await service.createProject(actor, { project_name, description, parent_project_id, workspace_key });
      } catch (err) {
        rethrowWithPublicMessage(err);
      }
      // SESSION ONE, BOOKED BEFORE THE FIRST SAVE. A new account's first
      // start_session had no project and so recorded no session, which made the
      // NEXT one "session 1" — and the day-two catch-up never spoke to the person
      // it exists for. Create only, never select (see recordCreationSessionLoad).
      // Same tool and transport the start_session load records. Best-effort.
      await recordCreationSessionLoad(actor, project.project_id, requestTool(actor, invocation.clientInfo) || surface, {
        transport: connectionIdentity.hostedTransport(actor),
      });
      // Making a project IS choosing one. The very next call is almost always a
      // save that carries no project_id, and before this it resolved through the
      // person's history and landed in the project they had just moved on from.
      // Best-effort: a create that succeeded must not report failure because a
      // convenience binding did not.
      const bound = await bindHostedSession(actor, project.project_id, args, surface);
      const nested = project.parent_project_id ? ` (subproject of ${project.parent_project_id})` : '';
      // Where it now is and who reads it, in a workspace with more than one
      // member; unchanged in a one-person workspace. See projectPlacementNote.
      const placement = await projectPlacementNote(actor, project.project_id, { shareHint: true });
      // SAID, when it happened: the create moved this connection, so the next
      // id-less save lands here. It used to move it silently, and a person
      // creating "Tax 2026" mid-conversation had their next decision filed there
      // (H3-1). select's own sentence, not a new one.
      const moved = bound ? ` ${connectionMovedSentence(bound.project_name)}` : '';
      return textData(`Created project "${project.project_name}" (${project.project_id})${nested}${moved || placement ? `.${moved}${placement}` : ''}`, {
        project_id: project.project_id,
        project_name: project.project_name,
        parent_project_id: project.parent_project_id || undefined,
      });
    }

    case 'switch_subproject': {
      const { project_id, workspace_key } = args;
      if (!project_id || typeof project_id !== 'string') throw new Error('project_id required');
      // NO workspace_key IS THE NORMAL CASE ON THE WEB, NOT AN ERROR.
      //
      // The pin is keyed to a codebase, which a hosted client does not have, so
      // this used to refuse outright and point at the dashboard. Then it was
      // made to accept one, wrote a pointer row, and answered "Switched" — while
      // every hosted call resolves with workspaceKey = null and never reads that
      // row. A user who said where they were working got a confirmation and no
      // change. A connection is what a hosted client actually has, so bind that,
      // and say precisely what was bound.
      if (!workspace_key || typeof workspace_key !== 'string') {
        const tool = hostedSessionTool(actor, args?.tool, surface);
        const prior = await service.resolveActiveProject(actor, null, null, { sessionId: hostedSessionId(actor) }).catch(() => null);
        const bound = await service.bindSessionToProject(actor, hostedSessionId(actor, tool), project_id, { tool });
        recordRoutingCorrection(actor, surface, prior, bound.project_id, 'select');
        // Its next saves go there: say who reads them (projectPlacementNote).
        const placement = await projectPlacementNote(actor, bound.project_id);
        return textData(
          `${connectionMovedSentence(bound.project_name)}${placement}`,
          { project_id: bound.project_id, project_name: bound.project_name },
        );
      }
      // WITH a workspace_key the pointer row is still written (a local client in
      // that codebase reads it), but it is not what resolves a HOSTED write:
      // resolveProjectRefOrActive reads this connection's session binding. Writing
      // only the pointer answered "Switched" and the next save without a
      // project_id landed in whatever the connection was bound to before. Bind
      // the connection too, after the pointer write has validated the project.
      const project = await service.switchSubproject(actor, project_id, workspace_key);
      const tool = hostedSessionTool(actor, args?.tool, surface);
      const bound = await service.bindSessionToProject(actor, hostedSessionId(actor, tool), project.project_id, { tool });
      const placement = await projectPlacementNote(actor, bound.project_id);
      return textData(
        `This connection now works in "${bound.project_name}", and it is the active subproject for workspace ${workspace_key}. Other connections are unchanged.${placement}`,
        {
          project_id: bound.project_id,
          project_name: bound.project_name,
          workspace_key,
        },
      );
    }

    case 'set_project_parent': {
      const { project_id, parent_project_id } = args;
      if (!project_id || typeof project_id !== 'string') throw new Error('project_id required');
      const parentId = parent_project_id && typeof parent_project_id === 'string' ? parent_project_id : null;
      let project;
      try {
        project = await service.setProjectParent(actor, project_id, parentId);
      } catch (err) {
        rethrowWithPublicMessage(err);
      }
      const msg = parentId
        ? `Nested "${project.project_name}" as a subproject of ${parentId}.`
        : `Promoted "${project.project_name}" to a top-level project.`;
      return textData(msg, {
        project_id: project.project_id,
        project_name: project.project_name,
        parent_project_id: project.parent_project_id || undefined,
      });
    }

    case 'archive_project': {
      const { project_id, unarchive } = args;
      if (!project_id || typeof project_id !== 'string') throw new Error('project_id required');
      // A refusal that carries its own sentence (a private project whose author is
      // still in the workspace) reaches the caller as that sentence, as it does
      // for move and rename. PARITY: the local server gets it from the REST 403.
      if (unarchive) {
        let restored;
        try {
          restored = await service.unarchiveProject(actor, project_id);
        } catch (err) {
          rethrowWithPublicMessage(err);
        }
        return textData(`Restored "${restored.project_name}" from the archive.`, {
          project_id: restored.project_id, project_name: restored.project_name, archived: false,
        });
      }
      let project;
      try {
        project = await service.archiveProject(actor, project_id);
      } catch (err) {
        rethrowWithPublicMessage(err);
      }
      return textData(formatProjectArchivedReply(project), {
        project_id: project.project_id, project_name: project.project_name, archived: true,
      });
    }

    case 'rename_project': {
      const { project_id, project_name } = args;
      if (!project_id || typeof project_id !== 'string') throw new Error('project_id required');
      if (!project_name || typeof project_name !== 'string') throw new Error('project_name required');
      let project;
      try {
        project = await service.renameProject(actor, project_id, project_name);
      } catch (err) {
        rethrowWithPublicMessage(err);
      }
      return textData(`Renamed to "${project.project_name}".`, {
        project_id: project.project_id, project_name: project.project_name,
      });
    }

    case 'get_context': {
      const { verbosity = 'standard', sections } = args;
      // PARITY with get_context in packages/mcp-server/src/tools/context-sync.ts,
      // whose GetContextSchema has always had project_id optional, described as
      // "Omit to get the most recently active project". Only the hosted side
      // threw 'project_id required' — so recall({action:"context"}), the most
      // called read on the connector most real users are on, refused the exact
      // call shape recall's OWN advertised schema invites ("Optional project ID.
      // Some actions use the active project when omitted."). The catalog
      // promised the fallback and the handler refused it. Same helper, same
      // shape, as the record_* and update_context fallbacks.
      const project_id = await resolveProjectRefOrActive(actor, args?.project_id, 'read');

      if (sections && sections.length > 0) {
        const project = await service.getProject(actor, project_id);
        if (!project) throw new Error('project_not_found');
        const globalCtx = await service.getGlobalContext(actor).catch(() => null);
        // THE SAME MEMORY WINDOW renderInjection applies. This read renders
        // straight off the stored context, so a Free account was served
        // decisions its own brief had already aged out — two reads of one
        // project disagreeing about what the plan remembers. The aged-out line
        // is said here too: that line is the whole point of the window.
        const windowed = await service.applyPlanHistoryWindow(actor, project.context || {});
        const body = formatSectionInjection(windowed.context || {}, sections, globalCtx);
        // ...and said only where it can be true. The sentence claims entries are
        // missing "above"; on a read of the task and the stack nothing above
        // could have been windowed at all.
        const agedOut = service.sectionsTouchHistoryWindow(sections)
          ? service.formatAgedOutLine(windowed)
          : null;
        const msg = `Project: ${project.project_name}\n\n${body}${agedOut ? `\n${agedOut}` : ''}`;
        return textData(msg, { text: msg, project_id });
      }

      const payload = await service.renderInjection(
        actor,
        project_id,
        'claude_web',
        verbosity,
        null,
        { record_side_effects: !invocation.readOnlyInvocation },
      );
      if (!payload) throw new Error('Project not found or context unavailable');
      if (!invocation.readOnlyInvocation) {
        logContextAudit(actor, 'context_read', { project_id, tool: 'mcp' });
      }
      const body = payload.body || JSON.stringify(payload);
      return textData(body, { text: body, project_id });
    }

    case 'update_context': {
      const { summary, task, commands } = args;
      // The label on the session row this write upserts, and therefore what the
      // brief means by "via ...". The catalog default made every hosted client
      // claim to be claude_web, so a Claude Code connector's work was filed as a
      // browser tab's. hostedSessionTool prefers what the caller declared and
      // otherwise reads the credential, which is the only identity a bare
      // tools/call carries. No new advertised argument.
      const tool = hostedSessionTool(actor, args?.tool, surface);
      // A task alone is a complete instruction. Requiring a summary alongside it
      // would push callers back onto the extraction path, which cannot set the
      // task field at all — the reason briefs kept headlining finished work.
      const taskText = typeof task === 'string' && task.trim() ? task.trim() : '';
      if (!taskText && (!summary || typeof summary !== 'string')) {
        throw new Error('summary required (or pass task to set the brief\'s current task)');
      }
      // PARITY with update_context in packages/mcp-server/src/tools/context-sync.ts,
      // which has resolved this from the active project since it was written.
      // Only the hosted side threw 'project_id required' — and this is the action
      // behind most manage_memory calls, so the gap fell on the write path the
      // product exists for. Checked AFTER the content check so a call missing
      // both is still told about the field it actually forgot.
      const project_id = await resolveProjectRefOrActive(actor, args?.project_id, 'update');
      // PARITY with update_context in packages/mcp-server/src/tools/context-sync.ts:
      // the task is written DIRECTLY, because extraction has never been able to
      // set this field. It is written LAST, after extraction, for the same reason
      // the command merge is: mergeContextObject is `{ ...current, ...delta }`,
      // so a delta that happens to carry current_task would silently overwrite an
      // explicitly requested task. An explicit instruction must beat an inferred
      // one, and verifying before extraction ran would have confirmed a value
      // that extraction then replaced.
      let taskWritten = '';
      // WHY a task did not land, when the server is the one that refused it.
      // "the write returned without error" describes a mystery; a refusal is not
      // a mystery, and a caller told only that the brief "reads differently"
      // retries the same words forever.
      let taskRefusal = '';
      // What the brief reads AFTER the attempt, from the read-back: the sentence
      // below has to quote the task that actually stands, not the one requested.
      let taskLive = '';
      // Set when the task landed MASKED: the service redacts a patch before it
      // merges (updateProjectContext -> redactForStorage), so a task naming a
      // key is stored with [REDACTED] in its place. Compared with the raw words
      // that read as "NOT changed" — a false failure that invites the model to
      // retry a write that already landed, forever. taskWritten then holds the
      // STORED value, so the reply never echoes the secret the brief does not
      // hold. PARITY: taskRedacted in packages/mcp-server/src/tools/context-sync.ts.
      let taskRedacted = false;
      const writeTask = async () => {
        if (!taskText) return;
        const patched = await service.updateProjectContext(actor, project_id, { current_task: taskText });
        const live = String(patched?.context?.current_task || '').trim();
        taskLive = live;
        const maskedTask = String(redactForStorage(taskText) || '').trim();
        if (live === taskText) taskWritten = taskText;
        else if (maskedTask !== taskText && live && live === maskedTask) {
          taskWritten = maskedTask;
          taskRedacted = true;
        }
        const refusal = (patched?.refused || []).find((item) => item.field === 'current_task');
        if (refusal) taskRefusal = refusal.reason;
      };
      // SAID ON BOTH BRANCHES. A task that was sent and did not land is the same
      // fact whether or not a summary rode along, and this was printed only when
      // the call carried nothing else — so `manage_memory update` with a summary
      // AND a task answered "Context updated", in full, over a task that was
      // never written and a refusal the server could name.
      const taskNotChanged = (projectName) => (taskRefusal
        ? `Current task NOT changed for "${projectName}". The task was refused because ${taskRefusal}. The brief still reads "${taskLive || '(no task)'}".`
        : `Current task NOT changed for "${projectName}" — the write returned without error but the brief still reads differently.`);
      if (!summary || typeof summary !== 'string') {
        await writeTask();
        const project = await service.getProject(actor, project_id);
        if (!project) throw new Error('project_not_found');
        return textData(
          taskWritten
            ? (taskRedacted
              ? `Current task written, with sensitive text redacted, for "${project.project_name}": "${taskWritten}".`
              : `Current task set for "${project.project_name}": "${taskWritten}".`)
            : taskNotChanged(project.project_name),
          { project_id, project_name: project.project_name, current_task: taskWritten || undefined },
        );
      }
      // A STABLE ID, NOT A FRESH ONE PER WRITE.
      //
      // This minted `mcp-remote-${Date.now()}` on every call. Presence, board
      // holds and the contention baseline all count DISTINCT session ids, so one
      // claude.ai client writing five times read as five colliding agents — and
      // now that presence names people, a teammate would be shown several
      // phantom peers that are all the same person.
      const sessionId = hostedSessionId(actor, tool);
      // ONE PATH FOR "SAVE WHAT I SAID", shared with the REST route the local
      // dispatcher calls (see recordExplicitUpdate). It stores the caller's
      // sentence verbatim, exactly once, and reports `stored` from a read-back
      // of that sentence — not from a moved timestamp, which a delta of
      // {category} was enough to move.
      //
      // session_context makes the row applyExtraction upserts describe a real
      // surface, so this connector shows up in another agent's presence block.
      //
      // timeout_ms: the provider's 15s default plus the writes behind it could
      // pass the 30s MCP deadline during an outage, and the caller then saw a
      // timeout for a write that had in fact landed.
      //
      // keep_session_binding: A PROJECT THE CALLER NAMED IS FOR THIS CALL ONLY.
      // sessionId is the CONNECTION, and the save path bound it to whatever the
      // write named, so one note filed to B by id moved the connection into B
      // and the next id-less decision, card and finish_task followed it there
      // (journey round 3, H3-1). No other call that names a project did that;
      // only select and create move a connection. An id-less call is left as it
      // was: it resolved through the binding when there is one, and otherwise
      // its save binds the connection as it always has.
      const namedByCaller = typeof args?.project_id === 'string' && Boolean(args.project_id.trim());
      const outcome = await service.recordExplicitUpdate(actor, {
        session_id: sessionId,
        tool,
        project_id,
        summary,
        session_context: { surface_type: 'browser', status: 'active' },
        timeout_ms: HOSTED_EXTRACTION_TIMEOUT_MS,
        ...(namedByCaller ? { keep_session_binding: true } : {}),
        // `tool` falls back to the catalog default (claude_web) when neither the
        // credential nor the handshake names the client, and a model's declared
        // `tool` is its own guess. Only a tool the REQUEST identifies is credited
        // with the save by name (the receipt's "last saved … in X").
        ...(requestTool(actor, invocation.clientInfo) === tool ? {} : { tool_identified: false }),
      });
      let updatedProject = outcome.project;
      if (Array.isArray(commands) && commands.length) {
        const byLabel = new Map(
          (Array.isArray(updatedProject.context?.commands) ? updatedProject.context.commands : [])
            .map((entry) => [String(entry?.label || '').trim(), entry])
            .filter(([label]) => Boolean(label)),
        );
        for (const entry of commands) {
          const label = String(entry?.label || '').trim();
          if (label) byLabel.set(label, entry);
        }
        updatedProject = await service.updateProjectContext(actor, project_id, {
          commands: [...byLabel.values()],
        });
      }
      await writeTask();
      const cmdNote = Array.isArray(commands) && commands.length
        ? ` + ${commands.length} command${commands.length > 1 ? 's' : ''} stored`
        : '';
      const taskNote = taskWritten
        ? (taskRedacted
          ? ` Current task written, with sensitive text redacted → "${taskWritten}".`
          : ` Current task → "${taskWritten}".`)
        : (taskText
          ? ` ${taskNotChanged(updatedProject.project_name)}`
          // A "Current task:" line in the summary sets the task (journey r4);
          // said the way the `task` argument's write is said.
          : (outcome.task_set ? ` Current task → "${outcome.task_set}".` : ''));
      // Built from the READ-BACK, not from the request. "Context updated" over an
      // unchanged row is the defect this whole path exists to stop repeating, so
      // when nothing landed the reply has to say nothing landed.
      const stored = outcome.stored;
      // Stored is not the same as stored verbatim. A summary carrying a key or
      // an override phrase is rewritten on its way to the row, and a caller who
      // reads [REDACTED] back later having been told only "updated" has been
      // told the truth and still surprised by it. Said in the TEXT alone: the
      // structured payload is held to the frozen output schema.
      const redactedNote = outcome.redacted
        ? ' Sensitive text in your summary was redacted before it was stored.'
        : '';
      const headline = stored
        ? `Context updated for "${updatedProject.project_name}".${redactedNote}`
        : `Context NOT updated for "${updatedProject.project_name}" — ${explainNotStored(outcome)}`;
      return textData(
        `${headline}${cmdNote}${taskNote} Last updated: ${updatedProject.context?.last_updated || 'now'}`,
        {
          project_id,
          project_name: updatedProject.project_name,
          stored,
          ...(!stored && outcome.reason ? { reason: outcome.reason } : {}),
          ...(taskWritten || outcome.task_set ? { current_task: taskWritten || outcome.task_set } : {}),
          last_updated: updatedProject.context?.last_updated || 'now',
        },
      );
    }

    case 'manage_todos': {
      const action = String(args?.action || 'list');
      // Changing the board is a WRITE, so an id-less one resolves for a write:
      // a project this connection may only read (the team's shared project,
      // shown to somebody whose own work is in another workspace) is never the
      // board a card lands on. Reading the board may still follow the read.
      const writesBoard = ['add', 'move', 'complete', 'remove'].includes(action);
      let projectId = args?.project_id;
      if (!projectId) {
        const active = await resolveActive(actor, { forWrite: writesBoard });
        projectId = active?.project_id;
      }
      if (!projectId) throw noActiveProjectError(writesBoard ? await service.ownWorkElsewhereNote(actor) : '');
      const rawPhase = args?.phase ? String(args.phase).trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
      const phase = BOARD_PHASES.includes(rawPhase) ? rawPhase : '';
      const todos = Array.isArray(args?.todos) ? args.todos.filter(Boolean).map(String) : [];
      // `cards` is the richer form of the same request: {title, body, phase} per
      // card. `todos: string[]` is untouched and still means bare titles — it is
      // the published contract, written into every CLAUDE.md already on disk.
      const rawCards = Array.isArray(args?.cards) ? args.cards : [];

      if (action === 'list') {
        // Named cards are OPENED (title, column, body); an unfiltered list is the
        // board, which shows a marker instead of any body.
        return renderTaskBoard(actor, projectId, todos, taskListingOptions(args));
      }

      const emit = (event_type, summary, metadata) =>
        service.applyStructuredContextEvent(actor, {
          event_type,
          project_id: projectId,
          summary,
          metadata: { ...metadata, surface: 'claude_web' },
        });

      if (action === 'add') {
        // Titles and bodies AS STORED. The board is saved through the storage
        // redactor, so a title carrying a key lands masked: matched against the
        // raw request it read as absent, and the reply quoted the key back. The
        // redactor is idempotent, so masking here changes nothing that is saved.
        const cards = normalizeTaskCardInputs([...todos, ...rawCards], phase).map((card) => ({
          ...card,
          title: redactForStorage(card.title),
          ...(typeof card.body === 'string' ? { body: redactForStorage(card.body) } : {}),
        }));
        if (!cards.length) throw new Error('todos or cards is required for add action');
        const titles = cards.map((card) => card.title);
        // Built from a BEFORE/AFTER difference of the board, never from the
        // request. Re-adding a title already on the board is a no-op in the
        // shared-context merge — with one exception, an entry carrying a body,
        // which sets that card's body and changes nothing else — so a reply read
        // off the request answered `Added to in progress: "X"` for a card that
        // was sitting untouched in Done. Only the board can say what happened.
        const before = await service.getProject(actor, projectId);
        if (!before) throw new Error('project_not_found');
        const beforeCards = indexBoardCardsByTitle(before);
        // The event's result was dropped here, so a card the write pushed off the
        // board went unreported — move and complete already named theirs. An add
        // no longer evicts OPEN work (the service refuses the whole add, with a
        // message, when open cards would pass the limit), but an add straight into
        // Done can still push the oldest completion off a full Done column.
        const evicted = collectEvictedCards([], await emit('todo_added', `Added ${cards.length} card${cards.length > 1 ? 's' : ''}: ${titles.join(', ')}`, { todos: cards, phase: phase || undefined }));
        const after = await service.getProject(actor, projectId);
        const afterCards = indexBoardCardsByTitle(after);
        // A hosted client has no cwd, so the project was resolved from this
        // person's history and is not necessarily the one they had in mind.
        const projectName = after?.project_name || before.project_name || projectId;

        const created = [];
        const bodyUpdated = [];
        const alreadyThere = [];
        const absent = [];
        // Two titles that differ only in a masked secret are ONE title once
        // stored ("Rotate key [REDACTED] in billing"), so the merge folded the
        // second into the first. Both found the card on the board afterwards and
        // both were reported "Added" — four cards announced over two stored.
        // The first of each is judged against the board; the rest are named as
        // collapsed into it.
        const collapsed = [];
        const firstByKey = new Map();
        for (const card of cards) {
          const key = card.title.toLowerCase();
          if (firstByKey.has(key)) { collapsed.push({ card, into: firstByKey.get(key) }); continue; }
          firstByKey.set(key, card);
          const was = beforeCards.get(key);
          const now = afterCards.get(key);
          if (!now) absent.push(card);
          // `body` is read off the BOARD, not off the request, for the same
          // reason the rest of this reply is: it is the value a later read will
          // return, and a clipped one is not the value that was sent.
          else if (!was) created.push({ card, phase: now.phase, body: now.body });
          else if (card.body && now.body === card.body && was.body !== card.body) bodyUpdated.push({ card, phase: now.phase, body: now.body });
          else alreadyThere.push({ card, phase: now.phase });
        }
        // EVERY BODY THIS CALL SET, NOT ONLY THE ONES IT OVERWROTE.
        //
        // This counted `bodyUpdated` alone — the one case a before/after index
        // can compare, an existing title whose body changed. A card CREATED in
        // this same call carries its body in on the same write and lands in
        // `created`, so eight new cards with eight bodies answered
        // `bodies_set: 0`, which reads exactly like the bodies having been
        // dropped over a board that had stored all eight.
        const bodiesSet = created.filter((entry) => entry.body).length + bodyUpdated.length;

        // A body longer than the cap is clipped rather than refused, so the reply
        // has to say so — a silently shortened spec is the same failure as a
        // silently dropped card, one layer down.
        const clipped = rawCards.filter((card) => taskCardBodyWasClipped(card?.body)).length;
        const lines = [];
        if (created.length) {
          lines.push(`Added to "${projectName}": ${created.map((entry) => `"${entry.card.title}"${entry.body ? TASK_BODY_MARKER : ''} → ${phaseLabel(entry.phase)}`).join(', ')}`);
        }
        if (bodyUpdated.length) {
          lines.push(`Updated the body of: ${bodyUpdated.map((entry) => `"${entry.card.title}" (${phaseLabel(entry.phase)} in "${projectName}")`).join(', ')}`);
        }
        for (const entry of alreadyThere) {
          lines.push(`"${entry.card.title}" already exists in ${phaseLabel(entry.phase)} in "${projectName}"; nothing was added. Move it with action "move", or re-add it with a body to fill in its detail.`);
        }
        if (absent.length) {
          lines.push(`Not on the board after the write: ${absent.map((card) => `"${card.title}"`).join(', ')}. The board may be at its card limit.`);
        }
        if (collapsed.length) {
          lines.push(`Stored as one card: ${collapsed.map((entry) => `"${entry.card.title}" is the same card as "${entry.into.title}" once the secret in it is masked`).join('; ')}. Nothing separate was added for ${collapsed.length === 1 ? 'it' : 'them'}.`);
        }
        if (clipped) lines.push(`${clipped} body clipped to ${MAX_TODO_BODY_CHARS} characters.`);
        if (evicted.length) lines.push(describeEvictedCards(evicted));
        return textData(lines.join('\n') || `Nothing changed on the board for "${projectName}".`, {
          action: 'add',
          evicted: evicted.length ? evicted.map((card) => card.title) : undefined,
          affected: created.map((entry) => entry.card.title),
          ...(collapsed.length ? { collapsed: collapsed.map((entry) => ({ title: entry.card.title, into: entry.into.title })) } : {}),
          body_updated: bodyUpdated.map((entry) => entry.card.title),
          already_present: alreadyThere.map((entry) => ({ title: entry.card.title, phase: entry.phase })),
          bodies_set: bodiesSet,
          phase: phase || undefined,
          project_id: projectId,
          project_name: projectName,
        });
      }
      if (action === 'move') {
        if (!todos.length) throw new Error('todos array is required for move action');
        if (!phase) throw new Error('phase is required for move — one of: ' + BOARD_PHASES.join(', '));
        const project = await service.getProject(actor, projectId);
        if (!project) throw new Error('project_not_found');
        const todoItems = project.context?.todo_items || [];
        const { matched, ambiguous, unmatched } = resolveTodoQueries(todoItems, todos);
        // Which board this landed on. A hosted client sends no cwd, so the
        // project came out of this person's history rather than out of the
        // request, and a reply that does not name it cannot be checked.
        const projectName = project.project_name || projectId;
        const evicted = [];
        for (const r of matched) collectEvictedCards(evicted, await emit('todo_moved', `Moved to ${phaseLabel(phase)}: ${r.card.title}`, { todo: r.card.id, phase }));
        const lines = [];
        if (matched.length) lines.push(`Moved to ${phaseLabel(phase)} in "${projectName}": ${matched.map((r) => `"${r.card.title}"`).join(', ')}`);
        if (evicted.length) lines.push(describeEvictedCards(evicted));
        if (ambiguous.length) lines.push(formatAmbiguousTodos(ambiguous, 'moved'));
        if (unmatched.length) lines.push(`No matching card found for: ${unmatched.map(t => `"${t}"`).join(', ')}`);
        return textData(lines.join('\n') || `No matching cards found in "${projectName}".`, {
          action: 'move',
          affected: matched.map((r) => r.card.title),
          ambiguous: ambiguousTodoData(ambiguous),
          unmatched: unmatched.length ? unmatched : undefined,
          evicted: evicted.length ? evicted.map((card) => card.title) : undefined,
          phase,
          project_id: projectId,
          project_name: projectName,
        });
      }
      if (action === 'complete') {
        if (!todos.length) throw new Error('todos array is required for complete action');
        const project = await service.getProject(actor, projectId);
        if (!project) throw new Error('project_not_found');
        const todoItems = project.context?.todo_items || [];
        const { matched, ambiguous, unmatched } = resolveTodoQueries(todoItems, todos);
        const projectName = project.project_name || projectId;
        const evicted = [];
        for (const r of matched) collectEvictedCards(evicted, await emit('todo_completed', `Completed: ${r.card.title}`, { todo: r.card.id }));
        const lines = [];
        if (matched.length) lines.push(`Marked complete (→ Done) in "${projectName}": ${matched.map((r) => `"${r.card.title}"`).join(', ')}`);
        if (evicted.length) lines.push(describeEvictedCards(evicted));
        if (ambiguous.length) lines.push(formatAmbiguousTodos(ambiguous, 'completed'));
        if (unmatched.length) lines.push(`No matching card found for: ${unmatched.map(t => `"${t}"`).join(', ')}`);
        return textData(lines.join('\n') || `No matching cards found in "${projectName}".`, {
          action: 'complete',
          affected: matched.map((r) => r.card.title),
          ambiguous: ambiguousTodoData(ambiguous),
          unmatched: unmatched.length ? unmatched : undefined,
          evicted: evicted.length ? evicted.map((card) => card.title) : undefined,
          phase: 'done',
          project_id: projectId,
          project_name: projectName,
        });
      }
      if (action === 'remove') {
        if (!todos.length) throw new Error('todos array is required for remove action');
        if (args?.confirm_destructive !== true) {
          const error = new Error('Removing task cards is irreversible. Review the matched card IDs and retry with confirm_destructive=true.');
          error.mcpCode = 'confirmation_required';
          error.safeMessage = error.message;
          throw error;
        }
        const project = await service.getProject(actor, projectId);
        if (!project) throw new Error('project_not_found');
        const removeCandidates = [...(project.context?.todo_items || []), ...(project.context?.completed_todos || [])];
        const { matched, ambiguous, unmatched } = resolveTodoQueries(removeCandidates, todos);
        const projectName = project.project_name || projectId;
        for (const r of matched) await emit('todo_removed', `Removed: ${r.card.title}`, { todo: r.card.id });
        const lines = [];
        if (matched.length) lines.push(`Removed from "${projectName}": ${matched.map((r) => `"${r.card.title}"`).join(', ')}`);
        if (ambiguous.length) lines.push(formatAmbiguousTodos(ambiguous, 'removed'));
        if (unmatched.length) lines.push(`No matching card found for: ${unmatched.map(t => `"${t}"`).join(', ')}`);
        return textData(lines.join('\n') || `No matching cards found in "${projectName}".`, {
          action: 'remove',
          affected: matched.map((r) => r.card.title),
          ambiguous: ambiguousTodoData(ambiguous),
          unmatched: unmatched.length ? unmatched : undefined,
          project_id: projectId,
          project_name: projectName,
        });
      }
      // Named for the tool the caller actually invoked. manage_todos is the
      // dispatch target behind manage_tasks and is not in tools/list, so telling
      // a hosted caller its action was rejected by a tool it cannot see leaves it
      // nothing to correct.
      throw new Error(`Unknown manage_tasks action: ${action}. Use one of: list, add, move, complete, remove.`);
    }

    case 'search_context': {
      const { query, limit: rawLimit = 5 } = args;
      if (!query || typeof query !== 'string') throw new Error('query required');
      // Candidates, matching, scoring and the snippet all live in
      // contextSearchService, shared with POST /api/v1/context/search (which the
      // local stdio server calls). This handler used to carry its own copy: six
      // fields, a tokeniser that turned `E-007` into `007` and dropped `$12`
      // outright, and a snippet cut from the start of the entry — so what
      // manage_memory saved, recall could not find. The limit is clamped to the
      // declared [1, 10] in there, so limit:0 is coerced into range rather than
      // silently producing an empty result.
      //
      // `project_id` reaches here through `recall`, which advertises it; it
      // boosts that project's hits rather than filtering on it.
      const { results: top } = await contextSearch.searchContext(actor, {
        query,
        limit: rawLimit,
        project_id: typeof args.project_id === 'string' ? args.project_id : undefined,
        // Which connection is asking. Without it the boost followed whichever
        // connector wrote last, so a search on one connection ranked another
        // connection's project first.
        session_id: hostedSessionId(actor),
      });
      if (top.length === 0) return textData('No matches found.', { results: [] });
      return textData(top.map(h => `${h.project_name} [${h.field}]: ${h.snippet}`).join('\n\n'), {
        results: top.map(h => ({
          ...(h.project_id ? { project_id: h.project_id } : {}),
          project_name: h.project_name,
          field: h.field,
          snippet: h.snippet,
          score: h.score,
        })),
      });
    }

    case 'get_workspace_overview': {
      const { mode = 'overview', verbosity = 'standard' } = args;
      const overview = await service.getWorkspaceOverview(actor, {
        mode,
        verbosity,
        track_selection: invocation.readOnlyInvocation ? false : undefined,
      });
      const body = overview?.text || formatWorkspaceOverview(overview, verbosity);
      return textOnly(body || 'No workspace context available.');
    }

    // ─── Durable structure store (parity with the local @deerdawn/mcp-server) ──
    // These let web agents read/append the repo "structure tree" — hot paths,
    // entrypoints/surfaces, debugging notes, and architecture entities — so they
    // don't re-sweep the codebase every session.

    case 'get_project_map': {
      let { project_id } = args;
      const { verbosity = 'standard' } = args;
      if (!project_id) {
        const active = await resolveActive(actor);
        project_id = active?.project_id;
      }
      if (!project_id) return textOnly('No project_id was given and no active project was found. Call recall with action "projects", then pass a project_id.');
      const map = await service.getProjectMap(actor, project_id, verbosity);
      if (!map) throw new Error('project_not_found');
      const mapText = map.text || JSON.stringify(map, null, 2);
      return textData(mapText, { text: mapText, project_id });
    }

    case 'find_known_paths': {
      const { query, project_id, limit = 10 } = args;
      if (!query || typeof query !== 'string') throw new Error('query required');
      const results = await service.findKnownPaths(actor, { query, project_id, limit });
      if (!results || results.length === 0) return textData('No known paths found.', { paths: [] });
      const body = results.map((item) => {
        if (item.kind === 'debugging_note') {
          const fix = item.commit_ref || item.diff_ref;
          return `- [${item.project_name}] note: ${item.summary}${item.paths?.length ? ` [${item.paths.join(' | ')}]` : ''}${fix ? ` (fix: ${fix})` : ''}`;
        }
        if (item.kind === 'surface') {
          return `- [${item.project_name}] surface ${item.label}: ${(item.paths || []).join(' | ')}${item.purpose ? ` — ${item.purpose}` : ''}`;
        }
        return `- [${item.project_name}] ${item.kind} ${item.label}: ${item.path}${item.purpose ? ` — ${item.purpose}` : ''}`;
      }).join('\n');
      return textData(body, { paths: results });
    }

    case 'get_workspace_entities': {
      const { types, query, project_id, scope, surface, status, limit = 10 } = args;
      const normalizedTypes = Array.isArray(types)
        ? types
        : (typeof types === 'string' && types ? types.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
      const entities = await service.getWorkspaceEntities(actor, {
        types: normalizedTypes, query, project_id, scope, surface, status, limit,
        track_selection: invocation.readOnlyInvocation ? false : undefined,
      });
      if (!entities || entities.length === 0) return textData('No workspace entities found.', { entities: [] });
      // A node with no summary prints its title alone. It printed the canonical
      // key instead — an internal identity, which for a per-project copy carries
      // a project id (`…::in.project_<uuid>`), in the text a person reads (scan 36).
      return textData(entities.map((node) => `- ${node.title}${node.summary ? `: ${node.summary}` : ''}`).join('\n'), {
        entities: entities.map((node) => ({
          title: node.title,
          summary: node.summary || undefined,
          canonical_key: node.canonical_key,
          entity_type: node.entity_type || undefined,
        })),
      });
    }

    // Cross-project memory. Delegates to portfolioService, which is the same
    // read the /portfolio dashboard page performs: it already resolves the
    // owner-scoped CTE over context_graph_evidence (a per-node LATERAL on the
    // unindexed evidence.node_id measured 14,219ms and tripped the 8s DB
    // breaker), and it already merges decisions in JS because project context is
    // encrypted at rest. Do not re-derive either here.
    case 'get_portfolio': {
      const { query, limit } = args;
      const entityLimit = Math.min(Math.max(Number(limit) || 8, 1), 25);
      const portfolio = await portfolioService.getPortfolio(actor, {
        query: typeof query === 'string' ? query : '',
        entityLimit,
        decisionLimit: 5,
      });
      return textData(formatPortfolio(portfolio, { entityLimit, decisionLimit: 5 }), {
        locked: Boolean(portfolio.locked),
        counts: portfolio.counts,
        // The contents are already redacted upstream when locked, so this is the
        // gated payload either way, never a second copy of it.
        entities: portfolio.entities,
        decisions: portfolio.decisions,
      });
    }

    // ─── Trails ──────────────────────────────────────────────────────────
    // Reached via manage_memory(action:"export_trail"|"import_trail"). The
    // hosted connector is how most people reach DeerDawn at all, so leaving
    // these wired only into the local stdio package meant Trails did not exist
    // for the majority of users.
    case 'export_trail': {
      const { project_id, kind } = args;
      if (!project_id || typeof project_id !== 'string') throw new Error('project_id required');
      const result = await trailService.exportTrail(actor, project_id, {
        exporter: { tool: surface || 'remote_mcp' },
        // kind:"pack" marks this as knowledge for OTHER projects; importing it
        // then skips this project's task state, goals and board.
        kind,
      });
      const counts = result.trail?.manifest?.counts || {};
      // THE ARCHIVE MUST LEAVE BYTE-FOR-BYTE, OR IT CANNOT BE IMPORTED.
      //
      // Its checksum covers every leaf, and sanitizeToolResult's walk rewrites
      // what it walks: it dropped `tech_stack` (a SENSITIVE_KEY substring hit)
      // and every card past the 100th, and the import this export exists to
      // feed then refused it as "modified after export". So the trail is sealed
      // out of that walk (OPAQUE_STRUCTURED_FIELDS). The one thing the walk did
      // that still matters — credential-shaped strings never reach the model —
      // is done here instead, and the archive is RE-SEALED if it changed, so it
      // stays importable either way.
      const redacted = redactDeep(result.trail);
      const trail = JSON.stringify(redacted) === JSON.stringify(result.trail)
        ? result.trail
        : trailService.format.sealTrail(redacted);
      const tooLarge = JSON.stringify(trail).length > OPAQUE_FIELD_LIMIT_CHARS;
      const reply = textData(
        `Exported "${result.trail?.manifest?.title || project_id}" as a Trail: ${counts.decisions || 0} decisions, `
        + `${counts.graph_nodes || 0} entities, ${counts.paths || 0} paths, ${counts.findings || 0} findings, `
        + `${counts.board_cards || 0} cards.\n\n`
        + (tooLarge
          ? `The archive is larger than this connector can return in one reply (or import in one call), so it is not attached. Export it through the API instead: GET /api/v1/context/projects/${project_id}/trail.\n\n`
          : '')
        + 'This archive is PRIVATE and has not been scanned for secrets, emails, home paths, financial figures, or personal names. '
        + 'Do not share it as-is. Publishing runs a separate redaction review that must be resolved finding by finding.',
        tooLarge
          ? { filename: result.filename, private: true }
          : { trail, filename: result.filename, private: true },
      );
      reply[OPAQUE_STRUCTURED_FIELDS] = ['trail'];
      return reply;
    }

    case 'import_trail': {
      const { trail, project_id, new_project_name, dry_run } = args;
      // A URL is resolved in trailService against an origin allow-list — the
      // API does not fetch arbitrary caller-supplied hosts.
      if (!trail || typeof trail !== 'string') throw new Error('trail required (a Trail URL, or the .dawn archive contents)');
      // dry_run is the difference between a READ (return the merge plan) and a
      // WRITE (perform the merge), so `=== true` fails OPEN: a client that
      // stringifies booleans — the exact hazard the local dispatcher's
      // coerceConfirmedFlag exists for, and which import_local_context already
      // advertises string forms for — asked for a plan and got a real merge.
      // An unrecognised value stops the call rather than silently picking the
      // branch that writes.
      const dryRunRaw = typeof dry_run === 'string' ? dry_run.trim().toLowerCase() : dry_run;
      const TRUE_FORMS = [true, 'true', '1', 'yes', 'y', 'on'];
      const FALSE_FORMS = [false, 'false', '0', 'no', 'n', 'off', undefined, null, ''];
      if (!TRUE_FORMS.includes(dryRunRaw) && !FALSE_FORMS.includes(dryRunRaw)) {
        throw new Error(`dry_run must be a boolean; received ${JSON.stringify(dry_run)}. Nothing was imported.`);
      }
      const result = await trailService.importTrail(actor, trail, {
        projectId: project_id,
        newProjectName: new_project_name,
        dryRun: TRUE_FORMS.includes(dryRunRaw),
      });
      const applied = result?.plan?.applied || {};
      const conflicts = result?.conflicts || [];
      const lines = [
        result.applied
          ? `Imported into ${result.project_name} (${result.project_id}).`
          : 'Dry run — nothing was written.',
        `${applied.decisions || 0} decisions, ${applied.paths || 0} paths, ${applied.findings || 0} findings, `
        + `${applied.commands || 0} commands, ${applied.board_cards || 0} cards, ${applied.entities || 0} entities.`,
      ];
      const skipped = result?.plan?.skipped_brief_fields || [];
      if (skipped.length) {
        lines.push('', `Pack — ${skipped.length} brief field${skipped.length === 1 ? '' : 's'} present in the Trail but not applied (they describe its author's project): ${skipped.join(', ')}.`);
      }
      if (conflicts.length) {
        lines.push('', `${conflicts.length} field${conflicts.length === 1 ? '' : 's'} kept the existing value rather than the imported one.`);
      }
      // The Done column is capped; what the cap pushed off is named, not hidden
      // behind the applied count above.
      const evicted = Array.isArray(result?.evicted_cards) ? result.evicted_cards : [];
      if (evicted.length) {
        const shown = evicted.slice(0, 5).map((card) => `"${card.title}"`).join(', ');
        const more = evicted.length > 5 ? ` and ${evicted.length - 5} more` : '';
        lines.push('', `The board is at its card limit, so ${evicted.length} card${evicted.length === 1 ? '' : 's'} did not stay on it: ${shown}${more}.`);
      }
      return textData(lines.join('\n'), result);
    }

    case 'record_hot_paths': {
      const { items } = args;
      if (!Array.isArray(items) || items.length === 0) throw new Error('items required (array of {label, path, purpose?})');
      // PARITY with record_hot_paths in packages/mcp-server/src/tools/context-sync.ts:
      // the advertised description says omitting project_id uses the active
      // project, and requiring it outright rejected the exact call shape the
      // description asks for.
      const project_id = await resolveProjectRefOrActive(actor, args?.project_id, 'record hot paths in');
      const result = await service.recordHotPaths(actor, project_id, items);
      // From the READ-BACK, not from the request. hot_paths is capped at 40, and
      // this counted the ARGUMENT: "Recorded 1 hot path" over a project where
      // that path was never stored, and `recall paths` could not find it
      // afterwards. Eviction is said too — quietly forgetting an old path to
      // make room for a new one is something the caller should hear about.
      const stored = Number.isInteger(result?.stored) ? result.stored : items.length;
      const notStored = Number.isInteger(result?.not_stored) ? result.not_stored : 0;
      const evicted = Number.isInteger(result?.evicted) ? result.evicted : 0;
      // A path already recorded by somebody else is left as it was when the
      // caller may add to the section but not rewrite it — not a full list.
      const alreadyRecorded = Number.isInteger(result?.already_recorded) ? result.already_recorded : 0;
      const atLimit = notStored - alreadyRecorded;
      const notStoredNote = (atLimit > 0
        ? ` ${atLimit} could not be stored: this project is at the 40 hot path limit.`
        : '')
        + (alreadyRecorded > 0
          ? ` ${alreadyRecorded} ${alreadyRecorded === 1 ? 'was' : 'were'} already recorded and left as ${alreadyRecorded === 1 ? 'it was' : 'they were'}: you may add hot paths to this project but not rewrite them.`
          : '');
      const evictedNote = evicted > 0
        ? ` ${evicted} older path${evicted === 1 ? '' : 's'} made room and ${evicted === 1 ? 'is' : 'are'} no longer in the brief.`
        : '';
      return textData(`Recorded ${stored} hot path${stored === 1 ? '' : 's'} for ${result?.project_name || project_id}.${notStoredNote}${evictedNote}`, {
        project_id,
        project_name: result?.project_name || undefined,
        recorded: stored,
      });
    }

    case 'upsert_workspace_entities': {
      const { entities, relations } = args;
      if (!Array.isArray(entities) || entities.length === 0) throw new Error('entities required (array of typed entities)');
      let result;
      try {
        result = await service.upsertWorkspaceEntities(actor, { entities, relations });
      } catch (err) {
        // Surface the honest, field-specific message (not just the bare error code)
        // so the calling agent knows exactly what to fix.
        // Through rethrowWithPublicMessage, which keeps the text as the
        // error's safeMessage. `throw new Error(err.publicMessage)` kept the
        // words only as .message, which normalizeMcpError deliberately does not
        // trust — so "too generic, name it more specifically" reached the caller
        // as internal_error "could not be completed", with nothing to fix.
        rethrowWithPublicMessage(err);
      }
      const e = result?.entities || [];
      const r = result?.relations || [];
      // Skips are said in the TEXT only: structuredContent is held to the
      // advertised output schema, which is frozen. Each one names the entity and
      // why, because "Upserted 3" for a batch of 5 is a silent loss otherwise.
      const skippedNote = (result?.skipped || []).length
        ? ` Skipped ${result.skipped.length}: ${result.skipped.map((entry) => `"${entry.title || '(untitled)'}" (${entry.message || entry.reason})`).join('; ')}.`
        : '';
      // Relations that could not be recorded are named with the key that did not
      // resolve and why. They were dropped without a word before, and a reply
      // that counts only the ones that landed reads as success.
      const unresolved = result?.unresolved_relations || [];
      const unresolvedNote = unresolved.length
        ? ` Did not record ${unresolved.length} relation${unresolved.length === 1 ? '' : 's'}: ${unresolved.map((entry) => `${entry.from_canonical_key} ${entry.relation_type} ${entry.to_canonical_key} (${(entry.unresolved || []).map((u) => `${u.key}: ${u.reason === 'ambiguous_project_name' ? 'more than one project you can see has this name; use project:<project_id>' : 'no such entity you can see'}`).join('; ')})`).join('; ')}.`
        : '';
      // A row the reply filter hid (withheld: true) was written but is not the
      // caller's to read. New nodes in a withheld section are refused before
      // they are written, so this should not arise — but if any path still
      // produces one, the reply says so rather than counting it as an ordinary
      // save the caller can come back to.
      const withheldCount = e.filter((entity) => entity?.withheld).length;
      const withheldNote = withheldCount
        ? ` ${withheldCount} of ${e.length === 1 ? 'it' : 'them'} ${withheldCount === 1 ? 'is' : 'are'} in a section this project's share does not show you, so you will not be able to read ${withheldCount === 1 ? 'it' : 'them'} back.`
        : '';
      const resolvesNote = result?.decision_resolves_note || '';
      // A stored description the upsert did not replace, named (scan 30).
      const keptNote = result?.summaries_kept_note || '';
      // The caller's own pre-team private nodes this save published or kept.
      const privateNote = result?.private_note || '';
      // Where it was filed: the project by name, or the workspace (journey r5).
      const filedNote = result?.filed_note || '';
      return textData(`Upserted ${e.length} workspace entit${e.length === 1 ? 'y' : 'ies'}.${filedNote}${withheldNote}${r.length ? ` Recorded ${r.length} relation${r.length === 1 ? '' : 's'}.` : ''}${skippedNote}${unresolvedNote}${resolvesNote}${keptNote}${privateNote}`, {
        entities_upserted: e.length,
        relations_recorded: r.length,
      });
    }

    case 'record_debug_finding': {
      const { summary, paths, added_at, commit_ref, diff_ref } = args;
      if (!summary || typeof summary !== 'string') throw new Error('summary required');
      // PARITY with record_debug_finding in packages/mcp-server/src/tools/context-sync.ts.
      const project_id = await resolveProjectRefOrActive(actor, args?.project_id, 'record a finding in');
      const result = await service.recordDebugFinding(actor, project_id, { summary, paths, added_at, commit_ref, diff_ref });
      // A teammate already filed this finding (the same words, or the same but
      // for a date or a count): it is in the log, their note is left as it was,
      // and nothing was written. Said as such, not as "Recorded".
      if (result?.already_recorded) {
        return textData(`Already recorded in ${result?.project_name || project_id}: a teammate filed this finding, so their note was left as it is and nothing was changed.`, {
          project_id,
          project_name: result?.project_name || undefined,
          recorded: false,
        });
      }
      // A note can REPLACE an earlier one through a dedupe-key collision (notes
      // differing only by a date or a counter are one note by design). Said in
      // the TEXT only: structuredContent is held to the frozen output schema.
      // "Recorded" over a write that deleted somebody's finding is the same
      // silent loss this whole family of replies exists to stop.
      const clipNote = (summary) => `"${String(summary).slice(0, 80)}${String(summary).length > 80 ? '…' : ''}"`;
      const replacedNote = result?.replaced
        ? ` Replaced an earlier note: ${clipNote(result.replaced)}.`
        : '';
      // A finding can also cost a note it has nothing to do with: the log is
      // capped, and at the cap something leaves. Named in the caller's own
      // words so they can re-file it if it mattered.
      const evicted = Array.isArray(result?.evicted) ? result.evicted : [];
      // A caller the share does not let read the log hears the COUNT only
      // (aged_out): the log is full and something older made room, but not
      // whose note it was or what it said.
      const agedOut = Number.isInteger(result?.aged_out) ? result.aged_out : 0;
      const evictedNote = evicted.length
        ? ` The log is full, so ${evicted.length === 1 ? 'the oldest note was' : `${evicted.length} older notes were`} dropped to make room: ${evicted.slice(0, 3).map(clipNote).join(', ')}.`
        : (agedOut > 0
          ? ` The log is full, so ${agedOut === 1 ? '1 older note' : `${agedOut} older notes`} aged out to make room.`
          : '');
      return textData(`Recorded debugging finding for ${result?.project_name || project_id}.${replacedNote}${evictedNote}`, {
        project_id,
        project_name: result?.project_name || undefined,
        recorded: true,
      });
    }

    // ─── Parity with the local @deerdawn/mcp-server (none of these need
    // filesystem/git access, so there's no reason web agents can't reach them) ──

    case 'mark_resolved': {
      const { title, entity_type, project_id, notes } = args || {};
      if (!title || typeof title !== 'string') throw new Error('title required');
      // A DECISION IN A NAMED PROJECT IS RESOLVED IN THAT PROJECT'S BRIEF.
      //
      // Decision nodes are unique per owner and keep the first project that
      // wrote them, and project_id was only a ranking hint to the entity search,
      // so resolving "in B" the decision B shares with A flipped A — and B stayed
      // open behind "already resolved — nothing to do". The brief is the thing a
      // resolve is for; service.resolveProjectDecision reads and writes the NAMED
      // project's, by the decision's own text, and answers in the words both
      // dispatchers use. Only a text that is in no decision of that project falls
      // through to the entity search below (a stored entity of another type, or
      // a decision node the brief no longer lists).
      //
      // AND AN OMITTED project_id IS THE ACTIVE PROJECT, as the schema promises
      // and as update_context already reads it. Omitted, this went straight to the
      // entity search, so the same decision in A and B with B active resolved A's
      // node and left B open for good (scan 27) — and models omit it. With no
      // active project at all, the entity search answers as before.
      //
      // PARITY: the local server reaches the same function through
      // POST /projects/:id/decisions/resolve (packages/mcp-server
      // src/tools/context-sync.ts).
      const decisionLike = !entity_type || entity_type === 'decision';
      let projectId = project_id || null;
      let fromActive = false;
      if (!projectId && decisionLike) {
        const active = await resolveActive(actor, { forWrite: true });
        if (active?.project_id) {
          projectId = active.project_id;
          fromActive = true;
        }
      }
      let briefMiss = null;
      if (projectId && decisionLike) {
        try {
          // untyped: with no entity_type the text may name a task as well; see
          // service.resolveProjectDecision (scan 28).
          const outcome = await service.resolveProjectDecision(actor, projectId, { title, notes, untyped: !entity_type });
          if (outcome.outcome !== 'not_found') return textOnly(outcome.message);
          briefMiss = outcome;
        } catch (err) {
          if (err?.message === 'project_not_found') {
            // An active project that vanished between the lookup and here is
            // no project: the entity search answers, as with none.
            if (fromActive) {
              projectId = null;
              fromActive = false;
            } else {
              // A project_id that names nothing this caller can see. It used to
              // be a generic resource_not_found (and before round 26, ignored,
              // so the resolve landed wherever the search pointed). Neither is
              // honest: say which id, and how to find the right one.
              const error = new Error(unknownProjectMessage(project_id));
              error.mcpCode = 'invalid_arguments';
              error.safeMessage = error.message;
              throw error;
            }
          } else {
            rethrowWithPublicMessage(err);
          }
        }
      }
      const candidates = await service.getWorkspaceEntities(actor, {
        query: title,
        ...(entity_type ? { types: [entity_type] } : {}),
        ...(projectId ? { project_id: projectId } : {}),
        include_resolved: true,
        limit: 5,
      });
      if (!candidates || !candidates.length) {
        return textOnly(briefMiss
          ? `${briefMiss.message}\nNo stored entity matches it either.`
          : `No entity found matching "${title}". Check the title and try again, or browse with recall({ action: "entities" }).`);
      }
      // Resolve EXACTLY ONE entity, or refuse and show the choices.
      //
      // This used to pass the whole candidate list to the upsert, so one title
      // resolved up to five unrelated entities and printed them all as if that
      // had been asked for. A search ranking is a guess; acting on all of it is
      // never what "mark this resolved" meant.
      //
      // And only an EXACT title (or node id). A lone search hit was taken as the
      // answer too, and the search ranks by shared words, not identity: a
      // question's answer, not yet in the graph, resolved the one decision in
      // ANOTHER project that shared a few words with it (scan 26).
      //
      // PARITY: this must stay behaviourally identical to mark_resolved in
      // packages/mcp-server/src/tools/context-sync.ts. There are two independent
      // MCP dispatchers — this one serves the hosted connectors (Claude.ai,
      // ChatGPT, Cursor) and the other serves local stdio — and the same bug was
      // fixed in only one of them, leaving it live for most real users.
      // tests/unit/mark-resolved-parity.test.js pins the invariants on both.
      //
      // "Exact" is the entity's own text, not only its title: a decision or task
      // over 80 characters is stored under a title cut to 79 + "...", with the
      // whole text in its canonical key and summary, so the full text — what
      // the brief prints and what a caller pastes — matched no title and every
      // such resolve was refused (scan 27). entityNamedExactly reads all three.
      let exact = candidates.filter((e) => entityNamedExactly(e, title));
      // THE CUT A BRIEF SHOWS, "..." and all, names a decision too — but only
      // as its opening, so it must be the opening of exactly ONE: read wider
      // than the five-hit ranking (a sibling sharing the opening may rank
      // sixth) and refuse two. See service.decisionNodeNamedByOpening (scan 28).
      if (!exact.length && (!entity_type || entity_type === 'decision')) {
        exact = await decisionsNamedByOpening(actor, title, projectId);
      }
      // THE CALLER'S OWN NODE FIRST. Two entities can carry the very same
      // title in different homes — the caller's node beside a colleague's that
      // held the plain key (service.landGraphWrite) — and the refusal below
      // asked for "the exact, complete title", which cannot tell them apart
      // (scan 32). The one filed in the project being worked in wins, then a
      // workspace-level one; a tie within a tier is still refused.
      exact = preferCallersHome(exact, projectId);
      const target = exact.length === 1 ? exact[0] : null;
      if (!target) {
        const shown = exact.length > 1 ? exact : candidates;
        const list = shown
          .map((e) => `  - "${e.title}" (${e.node_type || e.metadata?.entity_type || 'unknown type'})${e.metadata?.status === 'resolved' ? ' — already resolved' : ''}`)
          .join('\n');
        // Disambiguate with entity_type, NOT a node id: the entity search matches
        // title/summary/canonical_key text and never node_id, so advising an id
        // sends the caller to a guaranteed "No entity found".
        const types = [...new Set(shown.map((e) => e.node_type || e.metadata?.entity_type).filter(Boolean))];
        const how = types.length > 1
          ? `Re-run with the exact title plus entity_type (one of: ${types.join(', ')}).`
          : 'Re-run with the exact, complete title.';
        if (!exact.length) {
          return textOnly(`No entity is named exactly "${title}" (by its title, or by the complete text a cut title stands for), so nothing was resolved.${briefMiss ? ` ${briefMiss.message.split('\n')[0]}` : ''}\nClosest:\n${list}\n${how}`);
        }
        const homes = await sameTitleHomes(actor, exact);
        if (homes) {
          const where = exact
            .map((e, i) => `  - "${e.title}" (${e.node_type || e.metadata?.entity_type || 'unknown type'}) ${homes[i]}${e.metadata?.status === 'resolved' ? ' — already resolved' : ''}`)
            .join('\n');
          return textOnly(`"${title}" matches ${exact.length} entities with this same title in different places, so nothing was resolved — resolving the wrong one is not recoverable from here.\n${where}\nRe-run with project_id naming the project whose copy you mean.`);
        }
        return textOnly(`"${title}" matches ${shown.length} entities, so nothing was resolved — resolving the wrong one is not recoverable from here.\n${list}\n${how}`);
      }
      // A decision filed under ANOTHER project than the one named (or active)
      // is that project's decision; resolving its node would flip that
      // project's brief. Said with the way through: that project's id.
      if (projectId && target.node_type === 'decision' && target.project_id && target.project_id !== projectId) {
        const here = fromActive
          ? `not in the active project${briefMiss?.project_name ? ` (${briefMiss.project_name})` : ''}`
          : 'not in the one named';
        return textOnly(`"${target.title}" is a decision in another project, ${here}, so nothing was resolved. ${briefMiss ? briefMiss.message.split('\n')[0] : ''}\nTo resolve it where it is recorded, re-run with project_id: "${target.project_id}".`.trim());
      }
      if (target.metadata?.status === 'resolved') {
        return textOnly(`"${target.title}" is already resolved — nothing to do.`);
      }
      const now = new Date().toISOString();
      const written = await service.upsertWorkspaceEntities(actor, {
        entities: [{
          // node_type is what the DB keys on; metadata.entity_type is a label
          // and can disagree with it, which lands the write on a different
          // identity and duplicates instead of updating.
          entity_type: target.node_type || target.metadata?.entity_type,
          title: target.title,
          // Keep the summary. Overwriting it with the note destroyed the
          // entity's actual content to store a sentence about closing it.
          summary: target.summary || '',
          canonical_key: target.canonical_key,
          ...(target.project_id ? { project_id: target.project_id, scope: 'project' } : {}),
          metadata: {
            ...(target.metadata || {}),
            status: 'resolved',
            resolved_at: now,
            ...(notes ? { resolution_note: notes } : {}),
          },
        }],
      });
      const briefNote = written?.decision_resolves_note || '';
      return textOnly(`Marked resolved: "${target.title}".${briefNote}\nThis entry will no longer appear in normal context loads.\nRetrieve with: recall({ action: "entities", status: "resolved" })`);
    }

    // ─── Retire ONE open question ────────────────────────────────────────────
    //
    // Reached through manage_memory(action:"resolve_question"), never advertised
    // on its own.
    //
    // Before this, the only agent-facing lever on open_questions was
    // cleanup_context, which empties the list wholesale along with the command
    // log and the blocking issue. A brief that collects a dead question had no
    // way to drop just that one, so they piled up unread. This is the narrow
    // counterpart: it removes exactly one question or none, records the answer as
    // a decision, and leaves the task, the steps, the commands and every other
    // question exactly as they were.
    //
    // Resolving nothing is a normal, expected outcome, so it comes back as text
    // the model can act on — carrying the candidate questions verbatim — rather
    // than as an error. A caller told only "ambiguous" cannot become unambiguous.
    // PARITY: behaviourally identical to resolve_open_question in
    // packages/mcp-server/src/tools/context-sync.ts, and the wording is shared
    // through formatQuestionResolution so the two cannot drift.
    case 'resolve_open_question': {
      const { question, answer } = args || {};
      if (typeof question !== 'string' || !question.trim()) {
        throw new Error('question is required — pass the exact, complete text of the open question, as the brief prints it.');
      }
      if (typeof answer !== 'string' || !answer.trim()) {
        throw new Error('answer is required — what the question was decided to be. It is recorded as a decision.');
      }
      let projectId = args?.project_id;
      if (!projectId) {
        // Resolving a question writes it away and records the answer as a
        // decision: a WRITE, resolved as one (see manage_todos).
        const active = await resolveActive(actor, { forWrite: true });
        projectId = active?.project_id;
      }
      // Worded to contain "required" on purpose: normalizeMcpError passes such a
      // message through verbatim and otherwise collapses it to "The MCP request
      // could not be completed", which tells the caller nothing it can act on.
      // Somebody whose own projects are in another workspace gets the service's
      // refusal instead (see resolveProjectRefOrActive).
      if (!projectId) {
        const elsewhere = await service.ownWorkElsewhereNote(actor);
        if (elsewhere) throw noActiveProjectError(elsewhere);
        throw new Error(`project_id is required — no active project was found. ${NO_PROJECT_NEXT_STEP}`);
      }
      // A question is stored redacted, so a pasted question carrying a key in
      // clear never matched the one it quotes. Match as sent first (a row that
      // predates storage redaction holds the clear text), then as stored.
      // PARITY: POST /projects/:id/questions/resolve does the same.
      const asked = question.trim();
      const maskedAsked = redactForStorage(asked);
      let outcome = await service.resolveQuestion(actor, projectId, asked, answer.trim());
      if (outcome.reason === 'unmatched' && maskedAsked !== asked) {
        outcome = await service.resolveQuestion(actor, projectId, maskedAsked, answer.trim());
      }
      // Everything quoted back is quoted as stored — the question as asked
      // included, which is the one string here the store never saw.
      const openQuestions = redactForStorage(outcome.project?.context?.open_questions || []);
      const resolved = redactForStorage(outcome.resolved);
      const text = formatQuestionResolution(maskedAsked, {
        reason: outcome.reason,
        resolved,
        candidates: redactForStorage(outcome.candidates),
        // The service hands back the project either way, so the still-open list
        // costs nothing and turns a dead-end miss into a retryable one.
        open_questions: openQuestions,
      });
      return textData(text, {
        text,
        resolved: resolved || null,
        reason: outcome.reason,
        open_questions: openQuestions,
      });
    }

    case 'get_next_best_context': {
      const { tool, project_id, limit } = args || {};
      const result = await service.getNextBestContext(actor, {
        tool,
        project_id,
        limit,
        track_selection: invocation.readOnlyInvocation ? false : undefined,
      });
      const lines = [
        result.summary,
        ...(result.suggestions || []).map((item) => `- ${item.label}: ${item.reason}`),
      ].filter(Boolean);
      return textData(lines.join('\n'), { text: lines.join('\n'), suggestions: result.suggestions || [] });
    }

    case 'build_subagent_brief': {
      // max_tokens is advertised as `number` on purpose — a property declared
      // `integer` was refused end to end on the hosted path, which is why this
      // whole catalog uses `number` (see the cards_per_phase note above). The
      // request schema in shared-context parses it as an int, so 250.5 was
      // refused for being exactly what the advertised type invited. Round it
      // here; changing the published type mid-review is not an option.
      const requestedTokens = args?.max_tokens;
      const result = await service.buildSubagentBrief(actor, {
        ...(args || {}),
        ...(Number.isFinite(requestedTokens) ? { max_tokens: Math.round(requestedTokens) } : {}),
        tool: surface,
      }, {
        // Separate from the request on purpose: this is derived here, not sent,
        // and it is what makes the brief describe the project THIS connection
        // is working in rather than the one another connector wrote to last.
        sessionId: hostedSessionId(actor),
      });
      if (!invocation.readOnlyInvocation) {
        logContextAudit(actor, 'subagent_brief_read', {
          project_id: result.project_id,
          tool: surface,
          estimated_tokens: result.estimated_tokens,
          omitted_count: result.omitted_count,
        });
        recordProductEvent(actor, {
          event_name: 'subagent_brief_built',
          source: 'mcp',
          surface,
          metadata: {
            role: args?.role || null,
            selected_source_count: result.sources.length,
            estimated_tokens: result.estimated_tokens,
            max_tokens: result.max_tokens,
            main_brief_estimated_tokens: result.main_brief_estimated_tokens,
            packaging_token_delta: result.packaging_token_delta,
            omitted_count: result.omitted_count,
          },
        }).catch(() => {});
      }
      return textData(result.text, result);
    }

    case 'cleanup_context': {
      const { complete_task = false, ask_questions = true } = args || {};
      if (complete_task && args?.confirm_complete !== true) {
        const error = new Error('Completing cleanup clears command history, open questions, and the blocking issue. Retry with confirm_complete=true after reviewing the task.');
        error.mcpCode = 'confirmation_required';
        error.safeMessage = error.message;
        throw error;
      }
      let projectId = args?.project_id;
      if (!projectId) {
        // Only a confirmed completion writes (the gate above has already refused
        // an unconfirmed one), so only that resolves for a write; the checklist
        // below is a read and may follow the read.
        const active = await resolveActive(actor, { forWrite: Boolean(complete_task) });
        projectId = active?.project_id;
      }
      if (!projectId && complete_task) throw noActiveProjectError(await service.ownWorkElsewhereNote(actor));
      if (!projectId) return textOnly('No active project found to clean up.');
      const project = await service.getProject(actor, projectId);
      if (!project) throw new Error('project_not_found');
      const context = project.context || {};
      const projectName = project.project_name || projectId;
      const openQuestions = Array.isArray(context.open_questions) ? context.open_questions : [];
      const commands = Array.isArray(context.commands) ? context.commands : [];
      const currentTask = String(context.current_task || '').trim();
      const blocker = String(context.blocking_issue || '').trim();
      // ONLY an explicit, confirmed completion clears anything.
      //
      // This used to substring-match the brief's OWN status text for
      // /(completed|done|shipped|closed)/, so "Shipped PR 488; now verifying the
      // deploy" meant "this task is over" and a bare finish_task — no arguments
      // at all — emptied the open questions, the blocking issue and the command
      // log. "abandoned" and "disclosed" contain the same substrings. Worse, the
      // confirmation gate above only runs when complete_task is set, so the one
      // destructive path nobody asked for was also the one that skipped the
      // gate. Words in a status line are not consent.
      const clearing = Boolean(complete_task) && args?.confirm_complete === true;
      // What a confirmed completion destroys, named the same way in the report
      // and in the receipt so a caller reads the same list before and after.
      const clearable = describeTaskState({ questions: openQuestions.length, blocker: Boolean(blocker), commands: commands.length });
      // THE REVIEW AND ITS CONFIRMATION ARE TWO CALLS, tied together here: the
      // review is remembered per connection and project, and the confirmation
      // clears exactly what it showed (journey r4, BLOCKED 22). The same
      // session id every hosted write of this connection derives.
      const reviewSession = hostedSessionId(actor, hostedSessionTool(actor, args?.tool, surface));

      if (clearing) {
        // WHAT THE REVIEW SHOWED, AND NOTHING ADDED SINCE. This cleared the
        // project's questions, blocker and command log as they stood at the
        // confirmation, so a question added between the review and the
        // confirmation — by the person, or another tool — was cleared without
        // anybody having seen it. The plan is made from the row the write swaps
        // on (the builder re-runs on a lost swap), so a question landing during
        // this call stays too. No review on record for this connection keeps
        // today's behaviour: see service.planTaskCompletion.
        const reviewed = await service.readTaskReview(actor, reviewSession, projectId).catch(() => null);
        // NO REVIEW ON RECORD FOR THIS CONNECTION AND PROJECT: refused, nothing
        // cleared (the owner's decision). It used to clear everything open at
        // that moment, which nobody had been shown. A review of another
        // project of this connection is not a review of this one.
        if (!reviewed) {
          const error = new Error(NO_REVIEW_ON_RECORD);
          error.mcpCode = 'confirmation_required';
          error.safeMessage = NO_REVIEW_ON_RECORD;
          throw error;
        }
        let plan = null;
        let planBasis = {};
        // skipUnwritableDerived: a teammate finishing THEIR task on a shared
        // project marks it complete, and the parts the share does not let them
        // edit (the progress marker, the owner's open questions, blocker and
        // command log) are left as they were and named below — instead of the
        // whole completion being refused, which it was on every share.
        const patched = await service.updateProjectContext(actor, projectId, (fresh, policy) => {
          // The caller's VIEW of the row this write swaps on, never the row:
          // the review was taken from their view, and a section the share
          // hides from them must neither be counted as "added after the
          // review" nor quoted back to them (journey r4, M1).
          planBasis = service.projectViewForActor(actor, fresh, policy)?.context || {};
          plan = service.planTaskCompletion(planBasis, reviewed);
          return {
            current_status: currentTask ? `Completed: ${currentTask}` : 'Completed',
            task_progress: 'completed',
            ...plan.patch,
          };
        }, { skipUnwritableDerived: true });
        const skippedSections = new Set(Array.isArray(patched?.skipped_sections) ? patched.skipped_sections : []);
        // Sections the caller cannot view were never in the patch; they are left
        // as they are and named by section, exactly as when the write skipped them.
        for (const section of plan?.hidden || []) skippedSections.add(section);
        // WHAT THE SERVER WOULD NOT TAKE, IN THE REPLY THAT REPORTS THE WRITE.
        //
        // updateProjectContext refuses rather than blanks, and it says which
        // fields in `refused`. Nothing here read it, so a refused completion
        // status answered "Task remains recorded as completed" over a brief
        // still carrying the old one — and the next start_session showed the
        // task in progress, which is the one thing this reply promised was no
        // longer true.
        const refused = (patched?.refused || []).filter((item) => (
          item.field === 'current_status' || item.field === 'task_progress'
        ));
        // THE COMPLETION REACHES `shipped`, as it does on the local dispatcher
        // (packages/mcp-server context-sync.ts, the same two writes in the same
        // order). Without the event a task finished from claude.ai never entered
        // the shipped list or the catch-up built from it, and its task entity
        // stayed active. appendShipped dedupes on the summary, so a task that was
        // also a board card moved to Done lands once. Skipped when the server
        // declined the completion itself: shipping a task the brief still shows
        // in progress would say two contradictory things.
        //
        // And only when there IS a task. With none set this wrote a shipped item
        // "Task completed in <project>" at confidence 1, which the next catch-up
        // reported as finished work nobody did. The rest of the completion —
        // the status and the clearing — still runs, as it always has.
        if (!refused.length && currentTask) {
          const event = await service.applyStructuredContextEvent(actor, {
            event_type: 'task_completed',
            project_id: projectId,
            summary: currentTask,
            metadata: {
              source: 'cleanup_context',
              cleared_commands: plan ? plan.cleared.commands : commands.length,
              cleared_questions: plan ? plan.cleared.questions : openQuestions.length,
              surface: 'claude_web',
            },
          }).catch(() => null);
          for (const section of event?.skipped_sections || []) skippedSections.add(section);
        }
        // What a confirmed completion did NOT clear, because this caller may not
        // edit it: said plainly, so "Cleared: ..." never claims the owner's
        // questions or blocker went when they are still there.
        const SECTION_LABELS = {
          task_progress: 'task progress',
          commands: 'command log',
          open_questions: 'open questions',
          blocking_issue: 'blocker',
          shipped: 'shipped list',
          next_action: 'next action',
        };
        const leftNote = skippedSections.size
          ? `Left as they were (not shared for editing with you): ${orderLeftSections(skippedSections).map((key) => SECTION_LABELS[key] || key.replace(/_/g, ' ')).join(', ')}.`
          : '';
        const cleared = plan?.cleared || { questions: 0, blocker: false, commands: 0 };
        const clearedNow = describeTaskState({
          questions: skippedSections.has('open_questions') ? 0 : cleared.questions,
          blocker: cleared.blocker && !skippedSections.has('blocking_issue'),
          commands: skippedSections.has('commands') ? 0 : cleared.commands,
        });
        // What was added after the review and therefore left, named. The reply
        // SHOWS it, so it becomes what this connection has reviewed: a second
        // confirmation clears it. With nothing left to name, the review is used
        // up, and a later confirmation with no review before it is today's.
        // Only what the caller can view AND the write could have cleared: a
        // section skipped for editing is named above, never quoted item by item.
        const stayedNote = formatLeftAfterReview(stayedOutside(plan?.stayed, skippedSections));
        if (stayedNote) {
          // What this reply showed, from the caller's view only: no digest of
          // anything the share hides from them is recorded.
          await service.recordTaskReview(actor, reviewSession, projectId, { ...planBasis, ...plan.patch }).catch(() => {});
        } else {
          await service.forgetTaskReview(actor, reviewSession, projectId).catch(() => {});
        }
        const lines = [
          `Cleanup complete for ${projectName}.`,
          refused.length
            ? `Task NOT recorded as completed for ${projectName}: the server declined ${refused.map((item) => item.field).join(' and ')} because ${refused[0].reason}. The brief still reads "${patched?.context?.current_status || '(no status)'}".`
            : (currentTask ? `Task remains recorded as completed: "${currentTask}".` : NO_TASK_TO_COMPLETE),
          // The old receipt mentioned the command log and nothing else, so
          // questions and a blocker went quietly. Name everything that went.
          clearedNow.length ? `Cleared: ${clearedNow.join(', ')}.` : (skippedSections.size || stayedNote ? '' : 'There was no open task state to clear.'),
          leftNote,
          stayedNote,
        ].filter(Boolean);
        return textOnly(lines.join('\n'));
      }

      const checklist = [];
      if (ask_questions && openQuestions.length) {
        checklist.push('Open questions to answer before closing this task:');
        for (const question of openQuestions.slice(0, 12)) checklist.push(`- ${question}`);
      }
      if (blocker) checklist.push(`Blocking issue still recorded: ${blocker}`);
      if (commands.length) checklist.push(`Command log entries currently attached to this open task: ${commands.length}.`);
      checklist.push(clearable.length
        ? `Nothing was cleared. Completing this task would clear ${clearable.join(', ')}. If it is done, call manage_memory with action "finish_task", complete_task=true and confirm_complete=true.`
        : 'Nothing was cleared, and there is no open task state to clear. If this task is done, call manage_memory with action "finish_task", complete_task=true and confirm_complete=true.');
      // What this review showed is what its confirmation may clear. Best-effort:
      // a review that could not be remembered leaves the confirmation as it
      // was before, which is still no worse than today.
      await service.recordTaskReview(actor, reviewSession, projectId, context).catch(() => {});
      return textOnly([`Task in progress for ${projectName}: "${currentTask || 'Unnamed task'}".`, ...checklist].join('\n'));
    }

    case 'list_skills': {
      const ownerKey = workspace.defaultOwnerKey(actor);
      const skills = await service.listWorkspaceSkills(ownerKey, { project_id: args?.project_id, actor });
      if (!skills || !skills.length) return textData('No shared skills available.', { skills: [] });
      const lines = skills.map((s) => `- ${s.name} (${s.slug})${s.description ? ` — ${s.description}` : ''}`);
      return textData(`Shared skills:\n${lines.join('\n')}\n\nCall browse_skills with action "get" and a slug to load one in full.`, {
        skills: skills.map((s) => ({ slug: s.slug, name: s.name, description: s.description || undefined })),
      });
    }

    case 'get_skill': {
      const slug = String(args?.slug || '').trim();
      if (!slug) return textOnly('A slug is required. Call browse_skills with action "list" to see available skills.');
      const ownerKey = workspace.defaultOwnerKey(actor);
      const skill = await service.getWorkspaceSkill(ownerKey, slug, { actor });
      if (!skill) return textOnly(`No shared skill found for slug "${slug}".`);
      const body = skill.markdown_content || `Skill "${skill.name}" has no content.`;
      return textData(body, { text: body, slug: skill.slug, name: skill.name });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

// Machine-readable result shapes, one per tool. A tool that declares an
// `outputSchema` (below) must return `structuredContent` matching it — dispatch
// does, via textData()/textOnly(). Schemas are intentionally permissive
// (additionalProperties: true, minimal `required`) so the payloads dispatch
// already builds always validate; they describe the useful fields without
// over-constraining. Prose tools expose a `{ text }` brief.
const TEXT_OUTPUT = {
  type: 'object',
  properties: { text: { type: 'string', description: 'The formatted brief, ready to read.' } },
  required: ['text'],
  additionalProperties: true,
};
const OUTPUT_SCHEMAS = {
  start_session: TEXT_OUTPUT,
  get_workspace_overview: TEXT_OUTPUT,
  get_context: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The formatted project context.' },
      project_id: { type: 'string' },
    },
    required: ['text'],
    additionalProperties: true,
  },
  get_project_map: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The formatted project map.' },
      project_id: { type: 'string' },
    },
    required: ['text'],
    additionalProperties: true,
  },
  list_projects: {
    type: 'object',
    properties: {
      projects: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            project_name: { type: 'string' },
            current_task: { type: 'string' },
            subprojects: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  project_id: { type: 'string' },
                  project_name: { type: 'string' },
                  current_task: { type: 'string' },
                },
                required: ['project_id', 'project_name'],
                additionalProperties: true,
              },
            },
          },
          required: ['project_id', 'project_name'],
          additionalProperties: true,
        },
      },
    },
    required: ['projects'],
    additionalProperties: true,
  },
  create_project: {
    type: 'object',
    properties: {
      project_id: { type: 'string' },
      project_name: { type: 'string' },
      parent_project_id: { type: 'string' },
    },
    required: ['project_id', 'project_name'],
    additionalProperties: true,
  },
  switch_subproject: {
    type: 'object',
    properties: {
      project_id: { type: 'string' },
      project_name: { type: 'string' },
      workspace_key: { type: 'string' },
    },
    required: ['project_id', 'project_name'],
    additionalProperties: true,
  },
  archive_project: {
    type: 'object',
    properties: {
      project_id: { type: 'string' },
      project_name: { type: 'string' },
      archived: { type: 'boolean' },
    },
    required: ['project_id', 'project_name'],
    additionalProperties: true,
  },
  set_project_parent: {
    type: 'object',
    properties: {
      project_id: { type: 'string' },
      project_name: { type: 'string' },
      parent_project_id: { type: 'string' },
    },
    required: ['project_id', 'project_name'],
    additionalProperties: true,
  },
  rename_project: {
    type: 'object',
    properties: {
      project_id: { type: 'string' },
      project_name: { type: 'string' },
    },
    required: ['project_id', 'project_name'],
    additionalProperties: true,
  },
  update_context: {
    type: 'object',
    properties: {
      project_id: { type: 'string' },
      project_name: { type: 'string' },
      last_updated: { type: 'string' },
    },
    required: ['project_id'],
    additionalProperties: true,
  },
  manage_todos: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'The action performed.' },
      board: {
        type: 'array',
        description: 'Present for action=list — the board grouped by phase column.',
        items: {
          type: 'object',
          properties: {
            phase: { type: 'string' },
            label: { type: 'string' },
            cards: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  completed_at: { type: 'string' },
                },
                additionalProperties: true,
              },
            },
          },
          additionalProperties: true,
        },
      },
      affected: { type: 'array', items: { type: 'string' }, description: 'Requested cards that actually matched and were changed by add/move/complete/remove.' },
      unmatched: { type: 'array', items: { type: 'string' }, description: 'Requested cards (move/complete/remove) that matched no existing card — a no-op, distinct from a real change.' },
      phase: { type: 'string' },
    },
    required: ['action'],
    additionalProperties: true,
  },
  search_context: {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            project_name: { type: 'string' },
            field: { type: 'string' },
            snippet: { type: 'string' },
            score: { type: 'number' },
          },
          additionalProperties: true,
        },
      },
    },
    required: ['results'],
    additionalProperties: true,
  },
  find_known_paths: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description: 'Matching hot paths, surfaces, and debugging notes.',
      },
    },
    required: ['paths'],
    additionalProperties: true,
  },
  get_workspace_entities: {
    type: 'object',
    properties: {
      entities: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            summary: { type: 'string' },
            canonical_key: { type: 'string' },
            entity_type: { type: 'string' },
          },
          additionalProperties: true,
        },
      },
    },
    required: ['entities'],
    additionalProperties: true,
  },
  get_portfolio: {
    type: 'object',
    properties: {
      locked: { type: 'boolean', description: 'True when the plan withholds contents. The counts are real either way.' },
      counts: {
        type: 'object',
        properties: {
          projects: { type: 'number' },
          decisions: { type: 'number' },
          shared_entities: { type: 'number' },
        },
        additionalProperties: true,
      },
      entities: { type: 'object', description: 'Entities recorded in more than one project, with the projects each spans.', additionalProperties: true },
      decisions: { type: 'object', description: 'One decision timeline merged across every project.', additionalProperties: true },
    },
    required: ['counts'],
    additionalProperties: true,
  },
  export_trail: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'What was exported, and the warning that it is unscanned.' },
      trail: { type: 'object', description: 'The sealed .dawn archive.', additionalProperties: true },
      filename: { type: 'string', description: 'Suggested filename for the archive.' },
      private: { type: 'boolean', description: 'Always true. An export is unscanned, so it is never publishable as-is.' },
    },
    required: ['text'],
    additionalProperties: true,
  },
  import_trail: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'What the merge applied, and anything it declined to apply.' },
      applied: { type: 'boolean', description: 'False on a dry run, when nothing was written.' },
      project_id: { type: 'string' },
      project_name: { type: 'string' },
      plan: { type: 'object', description: 'Counts per section, plus any brief fields a pack carried but did not donate.', additionalProperties: true },
      conflicts: {
        type: 'array',
        description: 'Fields where the existing value won. Reported, never applied.',
        items: { type: 'object', additionalProperties: true },
      },
    },
    required: ['text'],
    additionalProperties: true,
  },
  record_hot_paths: {
    type: 'object',
    properties: {
      project_id: { type: 'string' },
      project_name: { type: 'string' },
      recorded: { type: 'number', description: 'Number of hot paths recorded.' },
    },
    required: ['recorded'],
    additionalProperties: true,
  },
  upsert_workspace_entities: {
    type: 'object',
    properties: {
      entities_upserted: { type: 'number' },
      relations_recorded: { type: 'number' },
    },
    required: ['entities_upserted'],
    additionalProperties: true,
  },
  record_debug_finding: {
    type: 'object',
    properties: {
      project_id: { type: 'string' },
      project_name: { type: 'string' },
      recorded: { type: 'boolean' },
    },
    required: ['recorded'],
    additionalProperties: true,
  },
  mark_resolved: TEXT_OUTPUT,
  resolve_open_question: TEXT_OUTPUT,
  cleanup_context: TEXT_OUTPUT,
  get_next_best_context: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Formatted summary + ranked suggestions.' },
      suggestions: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description: 'Ranked next-best context suggestions.',
      },
    },
    required: ['text'],
    additionalProperties: true,
  },
  build_subagent_brief: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Spawn-ready task-scoped worker brief.' },
      version: { type: 'number' },
      marker: { type: 'string' },
      project_id: { type: 'string' },
      project_name: { type: 'string' },
      generated_at: { type: 'string' },
      context_updated_at: { type: ['string', 'null'] },
      estimated_tokens: { type: 'number' },
      max_tokens: { type: 'number' },
      omitted_count: { type: 'number' },
      sources: { type: 'array', items: { type: 'object', additionalProperties: true } },
    },
    required: ['text', 'version', 'project_id', 'estimated_tokens', 'max_tokens', 'sources'],
    additionalProperties: true,
  },
  list_skills: {
    type: 'object',
    properties: {
      skills: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            slug: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['slug', 'name'],
          additionalProperties: true,
        },
      },
    },
    required: ['skills'],
    additionalProperties: true,
  },
  get_skill: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The skill markdown body.' },
      slug: { type: 'string' },
      name: { type: 'string' },
    },
    required: ['text'],
    additionalProperties: true,
  },
};

// Every tool below carries `annotations` (title + behavioural hints) and an
// `outputSchema` (machine-readable result shape) per the MCP spec. Annotations
// are hints only — clients never make trust decisions on them, but registries
// score their presence and hosts use the title for display. openWorldHint is
// false everywhere: these tools read/write DeerDawn's own context store, never
// the open internet.
// Keep the public catalog small and action based. Older names remain in TOOLS so
// existing clients can still call them, but tools/list advertises only this set.
const ADVERTISED_TOOL_NAMES = new Set([
  'start_session',
  'recall',
  'manage_projects',
  'manage_memory',
  'manage_tasks',
  'browse_skills',
  'build_subagent_brief',
]);

const CLAUDE_ADVERTISED_TOOL_NAMES = new Set([
  'start_session',
  'recall',
  'manage_projects',
  'manage_memory',
  'read_tasks',
  'manage_tasks',
  'browse_skills',
  'build_subagent_brief',
]);

const GROUPED_OUTPUT = {
  type: 'object',
  additionalProperties: true,
};

const CLAUDE_MANAGE_TASKS_TOOL = {
  name: 'manage_tasks',
  description: 'Change the active project task board. Add cards, move cards between phases, mark work complete, or permanently remove a mistaken card. Use read_tasks to inspect the board first. Removing a card requires confirm_destructive=true.',
  inputSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['add', 'move', 'complete', 'remove'], description: 'The write action to perform.' },
      project_id: { type: 'string', description: 'Optional project ID. Omit to use the active project.' },
      todos: { type: 'array', items: { type: 'string' }, description: 'Card titles for add, or card IDs or title phrases for other actions.' },
      cards: {
        type: 'array',
        description: 'For add: cards with detail. Use instead of todos when a card needs a body. Re-adding an existing title with a body sets that card\'s body.',
        items: {
          type: 'object',
          required: ['title'],
          properties: {
            title: { type: 'string', description: 'Card title, one scannable line.' },
            body: { type: 'string', description: 'The detail: spec, paths, acceptance criteria. Clipped at 2000 characters. Never shown in a listing; opened per card.' },
            phase: { type: 'string', enum: ['backlog', 'blocked', 'in_progress', 'integration', 'testing', 'done'], description: 'Column for this card. Overrides the top-level phase.' },
          },
        },
      },
      phase: { type: 'string', enum: ['backlog', 'blocked', 'in_progress', 'integration', 'testing', 'done'], description: 'Destination phase for add or move.' },
      confirm_destructive: { type: 'boolean', description: 'Required for remove after reviewing the matched cards.' },
    },
  },
  annotations: { title: 'Manage Task Board', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  outputSchema: GROUPED_OUTPUT,
};

// There used to be a `claude`-only override here that re-described recall,
// browse_skills and build_subagent_brief as read-only. It existed because the
// base descriptions disclosed audit/telemetry writes and so carried write
// annotations — which made three plain reads advertise themselves as destructive
// to every other host. The override also claimed those calls record no usage
// telemetry, which was never true: recordMcpCall fires for every tool call on
// every catalog.
//
// Both halves are gone. Operational audit and telemetry writes are not what
// readOnlyHint describes — the MCP hint is about the caller's data — so the base
// definitions now carry the honest annotation directly and every host sees the
// same catalog. Serving a different, friendlier description to one reviewer's
// host than to another's is cloaking, and directory review treats it as such.
function buildAdvertisedTools(catalog) {
  const names = catalog === 'claude' ? CLAUDE_ADVERTISED_TOOL_NAMES : ADVERTISED_TOOL_NAMES;
  return Array.from(names).map((name) => {
    if (catalog === 'claude' && name === 'manage_tasks') return CLAUDE_MANAGE_TASKS_TOOL;
    return TOOLS.find((candidate) => candidate.name === name);
  }).filter(Boolean);
}

const TOOLS = [
  {
    name: 'read_tasks',
    description: 'Read the active project task board grouped by phase. A listing is BOUNDED: each column returns its first cards (Done returns its most recent) with total, returned and has_more, so read a column\'s size from total and never from the number of cards returned. Cards marked +body carry detail; name them in todos to open those cards in full. This does not add, move, complete, or remove cards.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Optional project ID. Omit to use the active project.' },
        todos: { type: 'array', items: { type: 'string' }, description: 'Card IDs or title phrases to open in full, including body. Omit to list the whole board.' },
        cards_per_phase: { type: 'number', minimum: 1, maximum: 50, description: 'Cards to return per column (default 20, Done 10). Raise it to see further down a long column. Capped at 50, and lowered further when the whole board would exceed the response budget. Every column still reports its true total and has_more, so a shortened listing is always visible as one.' },
      },
    },
    annotations: { title: 'Read Task Board', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: GROUPED_OUTPUT,
  },
  {
    name: 'recall',
    description: 'Look up stored DeerDawn memory for the signed-in account: the list of projects, a project brief or selected sections of it, the project map, recorded file paths, architecture entities and decisions, or a search across them. Action portfolio reads across every project at once, for what recurs in more than one. It does not create, change, or delete project data.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['projects', 'context', 'search', 'overview', 'map', 'paths', 'entities', 'next', 'portfolio'], description: 'The kind of memory to retrieve. Use portfolio for what is shared across projects.' },
        project_id: { type: 'string', description: 'Optional project ID. Some actions use the active project when omitted.' },
        query: { type: 'string', description: 'Topic or path query for search, paths, entities, or portfolio.' },
        sections: { type: 'array', items: { type: 'string' }, description: 'Project brief sections for action=context.' },
        types: { type: 'array', items: { type: 'string' }, description: 'Entity types for action=entities.' },
        scope: { type: 'string', enum: ['workspace', 'project'], description: 'Entity scope for action=entities. workspace looks across ALL of this account\'s projects, which is how you find a service, person, or decision appearing in more than one; project stays inside a single project.' },
        surface: { type: 'string', description: 'Optional entity surface filter.' },
        status: { type: 'string', description: 'Optional entity status filter.' },
        mode: { type: 'string', enum: ['startup', 'overview'], description: 'Overview mode for action=overview.' },
        verbosity: { type: 'string', enum: ['light', 'standard', 'detailed'], description: 'Amount of detail to return.' },
        limit: { type: 'number', minimum: 1, maximum: 50, description: 'Maximum number of matches.' },
      },
    },
    annotations: { title: 'Recall DeerDawn Memory', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: GROUPED_OUTPUT,
  },
  {
    name: 'manage_projects',
    description: 'Manage projects and subprojects through one tool. Actions can create, select, rename, move, archive, or restore a project. Archive hides a project from normal use, while rename and move replace its current name or hierarchy. Use recall with action projects to find an existing project ID first.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['create', 'select', 'rename', 'move', 'archive', 'restore'], description: 'The project action to perform.' },
        project_id: { type: 'string', description: 'Existing project to select or change.' },
        project_name: { type: 'string', description: 'Name for create or rename.' },
        description: { type: 'string', description: 'Optional description for a new project.' },
        parent_project_id: { type: 'string', description: 'Parent for create or move. Omit during move to promote a subproject.' },
        workspace_key: { type: 'string', description: 'Identifier for the codebase a project selection is pinned to (a normalized git remote or root path, not a credential). Required only when selecting from a web client.' },
      },
    },
    annotations: { title: 'Manage Projects', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    outputSchema: GROUPED_OUTPUT,
  },
  {
    name: 'manage_memory',
    description: 'Write or close out DeerDawn memory through one tool. Actions update the project brief, record known paths or debugging findings, create or replace workspace entities, resolve a stored entity or one open question in the brief, finish the current task, or move a project between machines as a Trail archive (export_trail returns a private .dawn archive, and takes kind:"pack" when it is knowledge for other people\'s projects; import_trail merges one in, from a Trail URL or raw contents, without overwriting existing context). Some actions overwrite current fields or permanently clear finished task state. Exported Trails are unscanned and private: this tool cannot publish one.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['update', 'record_paths', 'record_finding', 'upsert_entities', 'resolve', 'resolve_question', 'finish_task', 'export_trail', 'import_trail'], description: 'The memory change to perform. resolve closes a stored workspace entity; resolve_question answers ONE open question in the brief and leaves the rest of it alone.' },
        project_id: { type: 'string', description: 'Project id or exact name. Omit to use the active project. The one exception is action="export_trail", which needs it explicitly and will not guess which project to archive.' },
        trail: { type: 'string', description: 'For action=import_trail: a Trail URL on deerdawn.com, or the .dawn archive contents to merge in.' },
        kind: { type: 'string', enum: ['project', 'pack'], description: 'For action=export_trail: pack marks the Trail as curated knowledge meant for OTHER projects, so importing it skips this project\'s task state, goals and board. Default: project.' },
        new_project_name: { type: 'string', description: 'For action=import_trail: name for the project to create when no project_id is given.' },
        dry_run: { type: 'boolean', description: 'For action=import_trail: return the merge plan without writing anything.' },
        summary: { type: 'string', description: 'What changed or the debugging finding to record.' },
        commands: {
          type: 'array', description: 'Optional runnable commands for action=update.', items: {
            type: 'object', required: ['label', 'run'], properties: {
              label: { type: 'string' }, run: { type: 'string' }, note: { type: 'string' },
            },
          },
        },
        items: {
          type: 'array', description: 'Path entries for action=record_paths.', items: {
            type: 'object', required: ['label', 'path'], properties: {
              label: { type: 'string' }, path: { type: 'string' }, purpose: { type: 'string' },
            },
          },
        },
        paths: { type: 'array', items: { type: 'string' }, description: 'Related paths for action=record_finding.' },
        added_at: { type: 'string', description: 'Optional timestamp for action=record_finding.' },
        commit_ref: { type: 'string', description: 'Optional commit reference for action=record_finding.' },
        diff_ref: { type: 'string', description: 'Optional diff or pull request reference for action=record_finding.' },
        entities: {
          type: 'array', description: 'Workspace entities for action=upsert_entities.', items: {
            type: 'object', required: ['title', 'entity_type'], properties: {
              title: { type: 'string' }, name: { type: 'string' }, entity_type: { type: 'string', enum: GRAPH_NODE_TYPE_VALUES },
              summary: { type: 'string' }, scope: { type: 'string', enum: ['workspace', 'project'] },
              project_id: { type: 'string' }, canonical_key: { type: 'string' },
              metadata: {
                type: 'object', properties: {
                  importance: { type: 'string', enum: ['low', 'normal', 'high', 'critical'] },
                  status: { type: 'string' }, surface: { type: 'string' }, pinned: { type: 'boolean' },
                  curation_state: { type: 'string' }, source_kind: { type: 'string' },
                },
              },
            },
          },
        },
        relations: {
          type: 'array', description: 'Entity relationships for action=upsert_entities.', items: {
            type: 'object', required: ['from_canonical_key', 'to_canonical_key', 'relation_type'], properties: {
              from_canonical_key: { type: 'string' }, to_canonical_key: { type: 'string' },
              relation_type: { type: 'string' }, summary: { type: 'string' },
            },
          },
        },
        title: { type: 'string', description: 'Stored item to resolve.' },
        entity_type: { type: 'string', description: 'Optional type filter for action=resolve.' },
        notes: { type: 'string', description: 'Optional resolution note.' },
        question: { type: 'string', description: 'For action=resolve_question: the exact, complete open question from the brief. Matching one question is the point, so a query that fits several resolves none and lists them.' },
        answer: { type: 'string', description: 'For action=resolve_question: what the question was decided to be. Recorded as a decision.' },
        complete_task: { type: 'boolean', description: 'Set true for action=finish_task to close the task.' },
        ask_questions: { type: 'boolean', description: 'Include remaining questions in finish output.' },
        confirm_complete: { type: 'boolean', description: 'Required when finishing a task because open task state is cleared.' },
      },
    },
    annotations: { title: 'Manage Project Memory', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    outputSchema: GROUPED_OUTPUT,
  },
  {
    name: 'manage_tasks',
    description: 'Manage the active project task board. List cards, add new work, move cards between phases, mark work complete, or remove a mistaken card. A listing is BOUNDED: each column returns its first cards (Done returns its most recent) with total, returned and has_more, so read a column\'s size from total and never from the number of cards returned. Removing a card is permanent and requires confirm_destructive=true.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'move', 'complete', 'remove'], description: 'The board action to perform.' },
        project_id: { type: 'string', description: 'Optional project ID. Omit to use the active project.' },
        todos: { type: 'array', items: { type: 'string' }, description: 'Card titles for add, card IDs or title phrases for other actions, or the cards to open in full for list.' },
        cards: {
          type: 'array',
          description: 'For add: cards with detail. Use instead of todos when a card needs a body. Re-adding an existing title with a body sets that card\'s body.',
          items: {
            type: 'object',
            required: ['title'],
            properties: {
              title: { type: 'string', description: 'Card title, one scannable line.' },
              body: { type: 'string', description: 'The detail: spec, paths, acceptance criteria. Clipped at 2000 characters. Never shown in a listing; opened per card.' },
              phase: { type: 'string', enum: ['backlog', 'blocked', 'in_progress', 'integration', 'testing', 'done'], description: 'Column for this card. Overrides the top-level phase.' },
            },
          },
        },
        phase: { type: 'string', enum: ['backlog', 'blocked', 'in_progress', 'integration', 'testing', 'done'], description: 'Destination phase for add or move.' },
        cards_per_phase: { type: 'number', minimum: 1, maximum: 50, description: 'For list: cards to return per column (default 20, Done 10). Raise it to see further down a long column. Capped at 50, and lowered further when the whole board would exceed the response budget. Every column still reports its true total and has_more, so a shortened listing is always visible as one.' },
        confirm_destructive: { type: 'boolean', description: 'Required for remove after reviewing the matched cards.' },
      },
    },
    annotations: { title: 'Manage Task Board', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    outputSchema: GROUPED_OUTPUT,
  },
  {
    name: 'browse_skills',
    description: 'List the shared skill documents available to the signed-in account, or read one in full by its exact slug. It does not create, change, or delete skills.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'get'], description: 'List available skills or get one skill in full.' },
        project_id: { type: 'string', description: 'Optional project scope for action=list.' },
        slug: { type: 'string', description: 'Exact skill slug for action=get.' },
      },
    },
    annotations: { title: 'Browse Shared Skills', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: GROUPED_OUTPUT,
  },
  {
    name: 'start_session',
    description: 'Load the active project brief for the signed-in account (current task, recent decisions, open questions, and recent changes) and open a session against that project. Opening a session appends a session-load record and refreshes a short-lived marker used to recognise a second connector loading the same brief. It does not change or delete stored project content.',
    inputSchema: {
      type: 'object',
      // `verbosity` (light | standard, as the local catalog advertises) is HELD
      // while the ChatGPT app resubmission is in review: the console reviews a
      // cached scan of this catalog, and changing a tool's input schema mid-review
      // puts the live server out of step with what was submitted. The handler
      // already honours the argument; restore the property once the app is
      // approved and re-scan. Tracked on the board.
      properties: {},
    },
    // destructiveHint is false. It used to be true, and that reversed claim is
    // what the ChatGPT submission was rejected over on 2026-09-08: "annotations
    // do not appear to match the tool's behavior".
    //
    // The old true rested on an internal reading. The dedup marker is REPLACED
    // rather than appended, so the write is not additive. That is true of the
    // marker and false of everything a reviewer means by the word. The marker is
    // a 90-second Redis key this server writes for itself (sessionDedup.js), and
    // beside it start_session appends a session-load row and emits product
    // events. Nothing stored is overwritten and nothing is deleted, which the
    // tool's own description asserted in the same breath as the annotation
    // denying it. A published catalog cannot answer one question both ways.
    //
    // readOnlyHint stays false: the session row and the marker ARE environment
    // writes, and claiming otherwise would be the opposite lie. destructiveHint
    // false is the spec's "performs only additive updates", which is what this
    // actually does.
    //
    // The LOCAL stdio package deliberately keeps destructiveHint:true for the
    // same tool name, and that divergence is correct rather than drift. There,
    // start_session also rewrites .deerdawn-context.md / AGENTS.md / .cursorrules
    // on the user's disk through syncProjectFiles, which really can replace a
    // file the user wrote. Different behaviour, different honest label.
    annotations: { title: 'Start DeerDawn Session', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    outputSchema: OUTPUT_SCHEMAS.start_session,
  },
  {
    name: 'list_projects',
    description: 'List accessible projects and subprojects with stable IDs and current-task summaries. Project data is unchanged, but invocation telemetry is recorded.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'List Projects', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    outputSchema: OUTPUT_SCHEMAS.list_projects,
  },
  {
    name: 'create_project',
    description: 'Create a DeerDawn project owned by the authenticated account. An optional parent_project_id creates a one-level subproject. This writes project data and is not safe to retry blindly because duplicate projects may be created.',
    inputSchema: {
      type: 'object',
      required: ['project_name'],
      properties: {
        project_name: { type: 'string', description: 'Name of the project' },
        description: { type: 'string', description: 'Brief description of what this project is' },
        parent_project_id: { type: 'string', description: 'Optional. Create this as a subproject under the given top-level project. The hierarchy is one level deep.' },
      },
    },
    annotations: { title: 'Create Project', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    outputSchema: OUTPUT_SCHEMAS.create_project,
  },
  {
    name: 'switch_subproject',
    description: 'Set which subproject is active for this codebase, so start_session, update_context, and manage_todos target it by default. The choice is remembered per workspace until you switch again. Keyed to the codebase (workspace_key), which the Claude Code / Cursor MCP sends automatically.',
    inputSchema: {
      type: 'object',
      required: ['project_id', 'workspace_key'],
      properties: {
        project_id: { type: 'string', description: 'The subproject (or project) to make active for this workspace.' },
        workspace_key: { type: 'string', description: 'Repo identity for the codebase this pin applies to (normalized git remote or root). Sent automatically by the local MCP.' },
      },
    },
    annotations: { title: 'Switch Subproject', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    outputSchema: OUTPUT_SCHEMAS.switch_subproject,
  },
  {
    name: 'archive_project',
    description: 'Archive a dead or finished project so it stops cluttering list_projects and never auto-resolves as the active project. Preserves all history. Pass unarchive:true to restore it. Refuses to archive an umbrella that still has live subprojects.',
    inputSchema: {
      type: 'object',
      required: ['project_id'],
      properties: {
        project_id: { type: 'string', description: 'The project to archive (or restore).' },
        unarchive: { type: 'boolean', description: 'Set true to restore a previously archived project instead of archiving.' },
      },
    },
    annotations: { title: 'Archive Project', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    outputSchema: OUTPUT_SCHEMAS.archive_project,
  },
  {
    name: 'set_project_parent',
    description: 'Re-parent an existing project: nest it under a top-level umbrella by passing parent_project_id, or promote it back to top-level by omitting parent_project_id. Use this to organize related projects into one umbrella after the fact. One level deep; the umbrella must be top-level and the project being moved must have no subprojects of its own.',
    inputSchema: {
      type: 'object',
      required: ['project_id'],
      properties: {
        project_id: { type: 'string', description: 'The project to move.' },
        parent_project_id: { type: 'string', description: 'The umbrella to nest under. Omit to promote the project to top-level.' },
      },
    },
    annotations: { title: 'Move Project', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    outputSchema: OUTPUT_SCHEMAS.set_project_parent,
  },
  {
    name: 'rename_project',
    description: 'Rename a project (umbrella or subproject). Use to tidy inconsistent, unclear, or shouty project names — the change is immediate and flows into every future brief. Junk names (file paths, "Untitled") are rejected.',
    inputSchema: {
      type: 'object',
      required: ['project_id', 'project_name'],
      properties: {
        project_id: { type: 'string', description: 'The project to rename.' },
        project_name: { type: 'string', description: 'The new name.' },
      },
    },
    annotations: { title: 'Rename Project', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    outputSchema: OUTPUT_SCHEMAS.rename_project,
  },
  {
    name: 'get_context',
    description: 'Retrieve selected context sections or a rendered brief for one accessible DeerDawn project. Project memory is unchanged, but audit and invocation events are recorded.',
    inputSchema: {
      type: 'object',
      required: ['project_id'],
      properties: {
        project_id: { type: 'string', description: 'Project ID from list_projects' },
        verbosity: { type: 'string', enum: ['light', 'standard', 'detailed'], default: 'standard', description: 'How much detail to return per section.' },
        sections: {
          type: 'array',
          items: { type: 'string', enum: ['task', 'status', 'decisions', 'stack', 'files', 'hot_paths', 'entrypoints', 'surfaces', 'debugging_notes', 'landmines', 'shipped', 'goals', 'questions', 'constraints', 'description', 'blocking', 'progress', 'board', 'todos', 'all'] },
          description: 'Which sections to include. Omit for task+status. Use board (or todos) for the task board.',
        },
      },
    },
    annotations: { title: 'Get Project Context', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    outputSchema: OUTPUT_SCHEMAS.get_context,
  },
  {
    name: 'update_context',
    description: 'Write a concise progress, task, decision, or shipped-feature summary to one accessible project, optionally storing bounded runnable command entries. Pass `task` to set the brief\'s current task directly — extraction cannot change that field. Extraction may replace current scalar state or merge the summary into multiple context fields; command entries replace an existing entry with the same label, and retries can create duplicate events.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project to update. Omit to use the active project.' },
        summary: { type: 'string', description: 'What changed or was decided — 1-2 sentences' },
        task: { type: 'string', description: 'Set the brief\'s current task directly. Extraction cannot change this field, so pass it explicitly whenever the headline of the brief should change. Either summary or task is required.' },
        tool: { type: 'string', enum: ['claude_web', 'chatgpt_web'], default: 'claude_web', description: 'Which tool surface the update originated from.' },
        commands: {
          type: 'array',
          description: 'Key runnable commands to store. Stored by label — overwrites existing entry with the same label.',
          items: {
            type: 'object',
            required: ['label', 'run'],
            properties: {
              label: { type: 'string', description: 'Short name, e.g. "deploy", "test", "start"' },
              run: { type: 'string', description: 'The full command string to run' },
              note: { type: 'string', description: 'Optional clarification, e.g. "run from monorepo root"' },
            },
          },
        },
      },
    },
    annotations: { title: 'Update Project Context', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    outputSchema: OUTPUT_SCHEMAS.update_context,
  },
  {
    name: 'manage_todos',
    description: 'Manage the active project\'s task board — a scrum-style board where every task is a card that moves across phase columns: Backlog → Blocked → In Progress → Integration → Testing → Done. Actions: add (new cards, default to Backlog or a named phase), move (re-column a card), complete (shorthand for → Done), remove (delete a mistaken card), list (show the board grouped by column). The single task tracker for the project.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['add', 'move', 'complete', 'remove', 'list'], description: 'add new cards, move a card to another phase, mark cards complete (→ Done), remove erroneous cards, or list the board.' },
        project_id: { type: 'string', description: 'Optional project ID. Omit to use the active project.' },
        todos: { type: 'array', items: { type: 'string' }, description: 'For add: card titles. For move/complete/remove: card IDs or title substrings to match. For list: cards to open in full.' },
        cards: {
          type: 'array',
          description: 'For add: cards with detail. Use instead of todos when a card needs a body. Re-adding an existing title with a body sets that card\'s body.',
          items: {
            type: 'object',
            required: ['title'],
            properties: {
              title: { type: 'string', description: 'Card title, one scannable line.' },
              body: { type: 'string', description: 'The detail: spec, paths, acceptance criteria. Clipped at 2000 characters. Never shown in a listing; opened per card.' },
              phase: { type: 'string', enum: ['backlog', 'blocked', 'in_progress', 'integration', 'testing', 'done'], description: 'Column for this card. Overrides the top-level phase.' },
            },
          },
        },
        phase: { type: 'string', enum: ['backlog', 'blocked', 'in_progress', 'integration', 'testing', 'done'], description: 'For add: the column new cards land in (default backlog). For move: the destination column (required).' },
        confirm_destructive: { type: 'boolean', description: 'Required for remove after reviewing the exact cards that will be permanently deleted.' },
      },
    },
    annotations: { title: 'Manage Task Board', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    outputSchema: OUTPUT_SCHEMAS.manage_todos,
  },
  {
    name: 'search_context',
    description: 'Search context owned by the authenticated account for a bounded keyword or topic query. Returns at most 10 ranked snippets and performs no external or arbitrary database query.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'What to search for — e.g. "auth decisions" or "projects using PostgreSQL"' },
        limit: { type: 'number', default: 5, minimum: 1, maximum: 10, description: 'Maximum number of results to return (1-10, default 5).' },
      },
    },
    annotations: { title: 'Search Context', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    outputSchema: OUTPUT_SCHEMAS.search_context,
  },
  {
    name: 'get_workspace_overview',
    description: 'Get a full overview of your workspace — all projects, durable knowledge, and capabilities.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['startup', 'overview'], default: 'overview', description: 'startup for a compact brief, overview for full details' },
        verbosity: { type: 'string', enum: ['light', 'standard', 'detailed'], default: 'standard', description: 'How much detail to include in the overview.' },
      },
    },
    annotations: { title: 'Workspace Overview', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    outputSchema: OUTPUT_SCHEMAS.get_workspace_overview,
  },
  {
    name: 'get_project_map',
    description: 'Retrieve the durable map for one accessible project. Project memory is unchanged, but invocation telemetry is recorded.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID. Omit to use the active project.' },
        verbosity: { type: 'string', enum: ['light', 'standard', 'detailed'], default: 'standard', description: 'How much of the project map to return.' },
      },
    },
    annotations: { title: 'Get Project Map', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    outputSchema: OUTPUT_SCHEMAS.get_project_map,
  },
  {
    name: 'find_known_paths',
    description: 'Search stored hot paths, surfaces, and debugging notes. The search stays inside DeerDawn and records invocation telemetry.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Path-oriented query.' },
        project_id: { type: 'string', description: 'Optional project ID to scope the search.' },
        limit: { type: 'number', default: 10, description: 'Maximum number of paths to return (default 10).' },
      },
    },
    annotations: { title: 'Find Known Paths', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    outputSchema: OUTPUT_SCHEMAS.find_known_paths,
  },
  {
    name: 'get_portfolio',
    description: 'Look across every project on the account at once: which services, people, patterns, and decisions appear in more than one, and one decision timeline merged over all of them. Reached as recall action portfolio. It does not create, change, or delete project data.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional text filter applied to shared entities and decisions.' },
        limit: { type: 'number', default: 8, description: 'Maximum number of shared entities to return (default 8).' },
      },
    },
    annotations: { title: 'Recall Across Projects', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: OUTPUT_SCHEMAS.get_portfolio,
  },
  {
    name: 'get_workspace_entities',
    description: 'Query typed workspace knowledge — services, capabilities, patterns, environments, and workflows — for architecture-level orientation.',
    inputSchema: {
      type: 'object',
      properties: {
        types: { type: 'array', items: { type: 'string' }, description: 'Optional entity types to filter.' },
        query: { type: 'string', description: 'Optional text query.' },
        project_id: { type: 'string', description: 'Optional project to rank against.' },
        scope: { type: 'string', enum: ['workspace', 'project'], description: 'Limit to workspace-wide or project-scoped entities.' },
        surface: { type: 'string', description: 'Optional surface filter (mcp_tool, api, dashboard, …).' },
        status: { type: 'string', description: 'Optional status filter (active, shipped, planned, stale, resolved).' },
        limit: { type: 'number', default: 10, description: 'Maximum number of entities to return (default 10).' },
      },
    },
    annotations: { title: 'Query Workspace Entities', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    outputSchema: OUTPUT_SCHEMAS.get_workspace_entities,
  },
  {
    name: 'record_hot_paths',
    description: 'Record durable file/folder hot paths AFTER you discover them, so future sessions find them before searching. Adds new paths and replaces the label or purpose of an existing entry with the same normalized path.',
    inputSchema: {
      type: 'object',
      required: ['items'],
      properties: {
        project_id: { type: 'string', description: 'Project to attach hot paths to. Omit to use the active project.' },
        items: {
          type: 'array',
          description: 'Hot paths to append — one entry per file or folder worth remembering.',
          items: {
            type: 'object',
            required: ['label', 'path'],
            properties: {
              label: { type: 'string', description: 'Short human-readable name for the path, e.g. "signup route".' },
              path: { type: 'string', description: 'Repo-relative file or folder path.' },
              purpose: { type: 'string', description: 'Optional note on what lives there or why it matters.' },
            },
          },
        },
      },
    },
    annotations: { title: 'Record Hot Paths', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    outputSchema: OUTPUT_SCHEMAS.record_hot_paths,
  },
  {
    name: 'upsert_workspace_entities',
    description: 'Create or update typed workspace entities (services, capabilities, patterns) and relationships. Use for durable architecture knowledge that should persist beyond a single project note.',
    inputSchema: {
      type: 'object',
      required: ['entities'],
      properties: {
        entities: {
          type: 'array',
          description: 'Typed workspace entities to create or update.',
          items: {
            type: 'object',
            required: ['title', 'entity_type'],
            properties: {
              title: { type: 'string', description: 'Required. Human-readable title, at least 3 characters. (Alias: `name`.)' },
              name: { type: 'string', description: 'Alias for `title`, accepted for backward compatibility.' },
              entity_type: { type: 'string', enum: GRAPH_NODE_TYPE_VALUES, description: 'Required. The kind of entity being recorded.' },
              summary: { type: 'string', description: 'Optional description of the entity. Must not be generic/low-value filler.' },
              scope: { type: 'string', enum: ['workspace', 'project'], description: 'Optional. Defaults to "project" when project_id is set, else "workspace".' },
              project_id: { type: 'string', description: 'Optional. Scopes the entity to a specific project.' },
              canonical_key: { type: 'string', description: 'Optional. Override the auto-derived dedup key for this entity.' },
              metadata: {
                type: 'object',
                description: 'Optional bounded metadata. Only the declared keys are accepted.',
                properties: {
                  importance: { type: 'string', enum: ['low', 'normal', 'high', 'critical'] },
                  status: { type: 'string', enum: ['active', 'shipped', 'experimental', 'planned', 'deprecated', 'stale', 'resolved', 'archived'] },
                  surface: { type: 'string', description: 'Optional surface tag (e.g. mcp_tool, api, dashboard) — filterable via get_workspace_entities({ surface }).' },
                  pinned: { type: 'boolean' },
                  curation_state: { type: 'string', enum: ['inferred', 'promoted', 'curated', 'stale'] },
                  source_kind: { type: 'string', enum: ['manual', 'imported', 'inferred'] },
                },
              },
            },
          },
        },
        relations: {
          type: 'array',
          description: 'Optional relationships between entities.',
          items: {
            type: 'object',
            required: ['from_canonical_key', 'to_canonical_key', 'relation_type'],
            properties: {
              from_canonical_key: { type: 'string', description: 'canonical_key of the source entity.' },
              to_canonical_key: { type: 'string', description: 'canonical_key of the target entity.' },
              relation_type: { type: 'string', description: 'Relationship label, e.g. depends_on, implements, related_to.' },
              summary: { type: 'string', description: 'Optional description of the relationship.' },
            },
          },
        },
      },
    },
    annotations: { title: 'Upsert Workspace Entities', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    outputSchema: OUTPUT_SCHEMAS.upsert_workspace_entities,
  },
  {
    name: 'record_debug_finding',
    description: 'Record a durable debugging finding, optionally tied to file paths and a commit/diff ref, after diagnosing a bug or tracing a non-obvious handoff.',
    inputSchema: {
      type: 'object',
      required: ['summary'],
      properties: {
        project_id: { type: 'string', description: 'Project to attach the finding to. Omit to use the active project.' },
        summary: { type: 'string', description: 'Concise factual finding.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Optional related file paths.' },
        added_at: { type: 'string', description: 'Optional ISO timestamp override.' },
        commit_ref: { type: 'string', description: 'Optional commit SHA/ref containing the fix.' },
        diff_ref: { type: 'string', description: 'Optional PR/diff URL or identifier.' },
      },
    },
    annotations: { title: 'Record Debug Finding', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    outputSchema: OUTPUT_SCHEMAS.record_debug_finding,
  },
  {
    name: 'mark_resolved',
    description: 'Mark matching knowledge or decision entities as resolved so they stop appearing in normal context loads. Resolved entries remain retrievable via get_workspace_entities({ status: "resolved" }); optional notes replace the stored summary for each match.',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', description: 'Title or key phrase matching the entity to resolve.' },
        entity_type: { type: 'string', enum: ['decision', 'knowledge', 'question', 'task', 'capability', 'workflow'], description: 'Optional entity type filter. Omit to match any type.' },
        project_id: { type: 'string', description: 'Optional project ID to scope the search.' },
        notes: { type: 'string', description: 'Optional brief note on why/how it was resolved.' },
      },
    },
    annotations: { title: 'Mark Resolved', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    outputSchema: OUTPUT_SCHEMAS.mark_resolved,
  },
  {
    name: 'get_next_best_context',
    description: 'Return the most relevant next context to fetch or use for the current task/session, including open questions and pending decisions ranked for relevance and token efficiency.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', enum: ['claude_web', 'chatgpt_web', 'cursor', 'claude_code', 'codex'], description: 'Optional active tool surface.' },
        project_id: { type: 'string', description: 'Optional active project override.' },
        limit: { type: 'number', default: 5, minimum: 1, maximum: 10, description: 'Max ranked suggestions to return (default 5).' },
      },
    },
    annotations: { title: 'Get Next Best Context', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    outputSchema: OUTPUT_SCHEMAS.get_next_best_context,
  },
  {
    name: 'build_subagent_brief',
    description: 'Build and return a compact, task-scoped brief for one piece of delegated work, drawn from the project brief and its recorded paths. It returns text only: it does not start a worker and does not create, change, or delete project memory.',
    inputSchema: {
      type: 'object',
      required: ['task'],
      properties: {
        project_id: { type: 'string', description: 'Optional project override. Omit to use the active project.' },
        task: { type: 'string', description: 'The concrete, bounded objective delegated to the worker.' },
        role: { type: 'string', description: 'Optional worker role.' },
        deliverable: { type: 'string', description: 'The exact result the worker should return.' },
        acceptance_criteria: { type: 'array', items: { type: 'string' }, maxItems: 8 },
        focus_paths: { type: 'array', items: { type: 'string' }, maxItems: 12 },
        verification: { type: 'array', items: { type: 'string' }, maxItems: 8 },
        max_tokens: { type: 'number', default: 250, minimum: 120, maximum: 600 },
      },
    },
    annotations: { title: 'Build Worker Brief', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: OUTPUT_SCHEMAS.build_subagent_brief,
  },
  {
    name: 'cleanup_context',
    description: 'Inspect task context at handoff time, or finish it with complete_task=true. Finishing marks the task completed and permanently clears command history, open questions, and the blocking issue after explicit confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Optional project ID. Omit to use the active project.' },
        complete_task: { type: 'boolean', default: false, description: 'Force-complete and close the active task now.' },
        ask_questions: { type: 'boolean', default: true, description: 'Include open follow-up questions that should be answered.' },
        confirm_complete: { type: 'boolean', description: 'Required with complete_task=true because cleanup clears open task state and command history.' },
      },
    },
    annotations: { title: 'Cleanup Context', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    outputSchema: OUTPUT_SCHEMAS.cleanup_context,
  },
  {
    // Reached through manage_memory(action:"resolve_question"), never advertised
    // on its own. It still needs a definition here: TOOLS is the callable
    // catalog, and mcp-remote-tools-contracts asserts defs and dispatch cases
    // match exactly.
    //
    // destructiveHint is true and idempotentHint is false, both honestly:
    // the question is REMOVED from the brief (non-additive), and a second
    // identical call finds nothing left to match.
    name: 'resolve_open_question',
    description: 'Answer one open question in the project brief: the question is removed from the open list and the answer is recorded as a decision. Resolves exactly one question or none — a query matching several resolves nothing and returns the candidates. Unlike finishing a task, it leaves the current task, task steps, command log and every other question untouched.',
    inputSchema: {
      type: 'object',
      required: ['question', 'answer'],
      properties: {
        question: { type: 'string', description: 'The exact, complete open question as the brief prints it.' },
        answer: { type: 'string', description: 'What the question was decided to be. Recorded as a decision.' },
        project_id: { type: 'string', description: 'Optional project ID. Omit to use the active project.' },
      },
    },
    annotations: { title: 'Resolve Open Question', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    outputSchema: OUTPUT_SCHEMAS.resolve_open_question,
  },
  {
    // Reached through manage_memory(action:"export_trail"), never advertised on
    // its own. It still needs a definition here: TOOLS is the callable catalog,
    // and a dispatch case with no entry is exactly the drift this file's
    // contract test exists to catch.
    name: 'export_trail',
    description: 'Export a project as a portable .dawn Trail archive. The archive is unscanned and private, so it is not publishable as-is; publishing runs a separate redaction review resolved finding by finding. Pass kind:"pack" when the Trail is curated knowledge meant for other projects rather than a record of this one.',
    inputSchema: {
      type: 'object',
      required: ['project_id'],
      properties: {
        project_id: { type: 'string', description: 'Project to export.' },
        kind: { type: 'string', enum: ['project', 'pack'], description: 'project (default) records this project. pack marks it as knowledge for OTHER projects, so importing it skips this project\'s task state, goals and board.' },
      },
    },
    annotations: { title: 'Export Trail', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    outputSchema: OUTPUT_SCHEMAS.export_trail,
  },
  {
    // Reached through manage_memory(action:"import_trail").
    //
    // destructiveHint is false and that is a load-bearing claim, not an
    // optimistic default: the merge is non-destructive by construction. Scalars
    // are fill-only, lists union, a local command wins a label collision, and
    // graph nodes dedupe on a canonical key. See services/trail/trailImport.js.
    //
    // openWorldHint is false because a URL is fetched only from the origin
    // allow-list in services/trail/trailFetch.js, which the caller cannot widen.
    name: 'import_trail',
    description: 'Merge a .dawn Trail into a project, or into a new one. Never overwrites what the project already knows: existing values win, lists are unioned, and conflicts are reported rather than applied. Accepts a Trail URL on an allowed origin or the archive contents. Use dry_run to see the merge plan without writing anything.',
    inputSchema: {
      type: 'object',
      required: ['trail'],
      properties: {
        trail: { type: 'string', description: 'A Trail URL on an allowed origin, or the .dawn archive contents.' },
        project_id: { type: 'string', description: 'Project to merge into. Omit to create a new one.' },
        new_project_name: { type: 'string', description: 'Name for the project to create when no project_id is given.' },
        dry_run: { type: 'boolean', description: 'Return the merge plan without writing anything.' },
      },
    },
    annotations: { title: 'Import Trail', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    outputSchema: OUTPUT_SCHEMAS.import_trail,
  },
  {
    name: 'list_skills',
    description: 'List available shared skills (name + description, no body). Use on web tools (ChatGPT, Claude.ai) that cannot read skill files from disk.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Optional project ID to scope skills. Omit for workspace-wide skills.' },
      },
    },
    annotations: { title: 'List Skills', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    outputSchema: OUTPUT_SCHEMAS.list_skills,
  },
  {
    name: 'get_skill',
    description: 'Retrieve one accessible shared DeerDawn skill by its exact slug. Skill content is unchanged, but invocation telemetry is recorded.',
    inputSchema: {
      type: 'object',
      required: ['slug'],
      properties: {
        slug: { type: 'string', description: 'Skill slug from list_skills.' },
      },
    },
    annotations: { title: 'Get Skill', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    outputSchema: OUTPUT_SCHEMAS.get_skill,
  },
];

module.exports = router;
// The A2A JSON-RPC binding (src/routes/a2a.js) answers `SendMessage` by running
// the same tool dispatch the MCP binding does, so the two transports can never
// drift into answering the same question differently.
module.exports.dispatchTool = dispatch;
// What A2A calls. By NAME, against the full dispatchable list, because A2A's
// skills map onto tools (get_context, read_tasks) that the MCP catalogs no
// longer advertise but still dispatch.
module.exports.runToolByName = (name, args, actor, surface, options) => runTool(
  TOOLS.find((candidate) => candidate.name === name),
  name,
  args || {},
  actor,
  surface,
  options,
);
// The two sentences this file says about workspaces, driven directly. Both are
// decisions about WHEN to speak rather than about what any one tool returns,
// and reaching them through a tool call would test the tool instead of the rule.
module.exports.__testables = { otherWorkspaceNotice, callWrites };
