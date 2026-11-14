'use strict';

// ─── A2A JSON-RPC protocol binding ────────────────────────────────────────────
//
// https://a2a-protocol.org/latest/specification/ §9. This is the endpoint the
// published Agent Card declares in `supportedInterfaces` — a card pointing at a
// URL that does not speak A2A would violate §8.3.1 ("Each interface MUST
// accurately declare its transport protocol and URL"), so the card and this
// route ship together.
//
// DeerDawn is a *memory* agent: every skill reads or writes stored project
// context and answers in one round trip. There is no long-running work, so:
//   - `capabilities.streaming` is false        -> SendStreamingMessage/SubscribeToTask are unsupported
//   - `capabilities.pushNotifications` is false -> the push-config methods are unsupported
//   - SendMessage always returns a `message` payload, never a `task`
//   - no Task is ever created, so GetTask is always TaskNotFound and ListTasks is empty
//
// Skills dispatch through the same tool layer the MCP binding uses
// (routes/mcp.js `dispatchTool`), so the two transports cannot answer the same
// question differently, and per-tool scope enforcement is shared.

const { randomUUID } = require('crypto');
const express = require('express');

const { requireAuth } = require('../middleware/auth');
const { buildAgentCard, A2A_BASE_PATH } = require('../config/agentCard');
const { runToolByName } = require('./mcp');
const service = require('../services/contextSyncService');

// Every skill goes through the same wrapper the MCP binding uses: argument
// validation, the tool timeout, result sanitising, the write audit and call
// recording. Calling dispatch directly skipped all five.
const dispatchTool = (name, args, actor, surface) => runToolByName(name, args, actor, surface);

const router = express.Router();
// No body parser here: app.js parses every JSON body before any router runs
// (and is where the size limit lives). A second express.json on this router saw
// an already-consumed stream and did nothing, while reading as though the 1mb
// limit on this line were the one in force.

// ─── JSON-RPC error helpers ───────────────────────────────────────────────────
// Codes from §9.5 (standard JSON-RPC) and §5.4 (A2A-specific, -32001..-32099).

const ERR = {
  PARSE: [-32700, 'Invalid JSON payload'],
  INVALID_REQUEST: [-32600, 'Request payload validation error'],
  METHOD_NOT_FOUND: [-32601, 'Method not found'],
  INVALID_PARAMS: [-32602, 'Invalid parameters'],
  INTERNAL: [-32603, 'Internal error'],
  TASK_NOT_FOUND: [-32001, 'Task not found'],
  PUSH_NOT_SUPPORTED: [-32003, 'Push notifications are not supported'],
  UNSUPPORTED_OPERATION: [-32004, 'Operation not supported'],
  EXTENDED_CARD_NOT_CONFIGURED: [-32007, 'Extended agent card is not configured'],
};

class RpcError extends Error {
  constructor([code, message], data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function errorInfo(reason, metadata = {}) {
  return [{
    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
    reason,
    domain: 'a2a-protocol.org',
    metadata: Object.fromEntries(
      Object.entries(metadata).map(([k, v]) => [k, String(v)]),
    ),
  }];
}

function badRequest(field, description) {
  return [{
    '@type': 'type.googleapis.com/google.rpc.BadRequest',
    fieldViolations: [{ field, description }],
  }];
}

// ─── Skills ───────────────────────────────────────────────────────────────────
// Each entry maps an Agent Card skill id onto the MCP tool that already
// implements it. `requireProject` skills resolve the caller's active project
// when the request does not name one.

// `forWrite`: the skill WRITES to the project it resolves, so an omitted
// projectId resolves as a write target, never as a project this caller may only
// read. The team's shared project is shown read-only to somebody whose own
// projects are in another workspace (contextSyncService resolveActiveProject,
// tier 6), and resolving it as a read here filed their A2A memory updates into
// a colleague's project. For that person the refusal is the hosted MCP
// refusal's text (spelled with this binding's projectId, and with no listing
// call, which A2A has none of), inside the error shape this binding already
// uses; everybody else's is unchanged.
async function resolveProjectId(actor, requested, { forWrite = false } = {}) {
  if (requested && typeof requested === 'string') return requested;
  const active = await service.resolveActiveProject(actor, null, null, { forWrite }).catch(() => null);
  if (!active?.project_id) {
    const elsewhere = forWrite ? await service.ownWorkElsewhereNote(actor, { param: 'projectId', listing: null }) : '';
    throw new RpcError(
      ERR.INVALID_PARAMS,
      badRequest('message.parts[].data.projectId', elsewhere || 'No active project — pass projectId.'),
    );
  }
  return active.project_id;
}

const SKILL_HANDLERS = {
  'load-project-brief': async (actor, input) => dispatchTool(
    'get_context',
    {
      project_id: await resolveProjectId(actor, input.projectId),
      verbosity: input.verbosity || 'standard',
      sections: Array.isArray(input.sections) ? input.sections : undefined,
    },
    actor,
    'a2a',
  ),

  'search-memory': async (actor, input) => {
    const query = String(input.query || '').trim();
    if (!query) {
      throw new RpcError(
        ERR.INVALID_PARAMS,
        badRequest('message.parts', 'search-memory needs a text part or data.query.'),
      );
    }
    return dispatchTool('search_context', { query, limit: input.limit }, actor, 'a2a');
  },

  // read_tasks, not manage_todos: reading the board is a READ, and the tool it
  // dispatches decides the scope the caller must hold. Routed through
  // manage_todos this skill demanded context:write for a list — an agent with
  // a read-only credential could not even look at the board.
  // todos / cardsPerPhase are forwarded: without them an A2A caller could list
  // the board and never open a card's body or see past the first page of a
  // column, both of which the underlying tool has always supported.
  'read-task-board': async (actor, input) => dispatchTool(
    'read_tasks',
    {
      project_id: input.projectId,
      ...(Array.isArray(input.todos) && input.todos.length ? { todos: input.todos.map(String) } : {}),
      ...(Number.isFinite(Number(input.cardsPerPhase ?? input.cards_per_phase))
        ? { cards_per_phase: Number(input.cardsPerPhase ?? input.cards_per_phase) }
        : {}),
    },
    actor,
    'a2a',
  ),

  'record-memory-update': async (actor, input) => {
    const summary = String(input.summary || input.query || '').trim();
    if (!summary) {
      throw new RpcError(
        ERR.INVALID_PARAMS,
        badRequest('message.parts', 'record-memory-update needs a text part or data.summary.'),
      );
    }
    return dispatchTool(
      'update_context',
      // No `tool`: that field is a closed enum of host tools ('claude_web',
      // 'chatgpt_web'), and 'a2a' is not one. Sending it made the session write
      // fail schema validation AFTER extraction had run, so every A2A memory
      // update cost a model call and stored nothing. A2A is a transport; it is
      // already carried as the surface.
      { project_id: await resolveProjectId(actor, input.projectId, { forWrite: true }), summary },
      actor,
      'a2a',
    );
  },
};

const DEFAULT_SKILL = 'search-memory';

// A2A messages are free-form: content arrives as text parts, structured parts,
// or both. Collapse a Message into { skill, input } — a `data` part (or message
// metadata) selects the skill explicitly; otherwise the joined text is the query
// for the default skill.
function readMessage(message) {
  if (!message || typeof message !== 'object') {
    throw new RpcError(ERR.INVALID_PARAMS, badRequest('message', 'A message is required.'));
  }
  const parts = Array.isArray(message.parts) ? message.parts : [];
  if (parts.length === 0) {
    throw new RpcError(ERR.INVALID_PARAMS, badRequest('message.parts', 'At least one part is required.'));
  }

  const texts = [];
  let data = {};
  for (const part of parts) {
    if (typeof part?.text === 'string') texts.push(part.text);
    else if (part?.data && typeof part.data === 'object' && !Array.isArray(part.data)) {
      data = { ...data, ...part.data };
    }
  }

  const text = texts.join('\n').trim();
  const skill = String(data.skill || message.metadata?.skill || DEFAULT_SKILL);
  if (!Object.prototype.hasOwnProperty.call(SKILL_HANDLERS, skill)) {
    throw new RpcError(
      ERR.INVALID_PARAMS,
      badRequest('message.parts[].data.skill', `Unknown skill "${skill}". Known: ${Object.keys(SKILL_HANDLERS).join(', ')}.`),
    );
  }

  // Text is the natural-language payload for whichever skill was selected.
  const input = { ...data };
  if (text) {
    if (input.query === undefined) input.query = text;
    if (input.summary === undefined) input.summary = text;
  }
  return { skill, input };
}

function agentMessage({ skill, contextId, taskId, result }) {
  const text = (result?.content || [])
    .filter((c) => c?.type === 'text')
    .map((c) => c.text)
    .join('\n');
  const parts = [{ text, mediaType: 'text/plain' }];
  if (result?.structuredContent !== undefined) {
    parts.push({ data: result.structuredContent, mediaType: 'application/json' });
  }
  return {
    messageId: randomUUID(),
    contextId: contextId || randomUUID(),
    ...(taskId ? { taskId } : {}),
    role: 'ROLE_AGENT',
    parts,
    metadata: { skill },
  };
}

// ─── Methods ──────────────────────────────────────────────────────────────────

async function sendMessage(params, actor) {
  const { skill, input } = readMessage(params?.message);
  let result;
  try {
    result = await SKILL_HANDLERS[skill](actor, input);
  } catch (err) {
    if (err instanceof RpcError) throw err;
    // Tool-layer failures are caller-facing (missing scope, unknown project,
    // bad arguments) far more often than they are server faults.
    throw new RpcError(
      ERR.INVALID_PARAMS,
      errorInfo('SKILL_EXECUTION_FAILED', { skill, detail: err?.safeMessage || err?.message || 'failed' }),
    );
  }
  return {
    message: agentMessage({
      skill,
      contextId: params.message.contextId,
      taskId: params.message.taskId,
      result,
    }),
  };
}

// `method` -> handler. `auth: false` methods are answerable without credentials.
const METHODS = {
  GetAgentCard: { auth: false, handle: async () => buildAgentCard() },

  SendMessage: { auth: true, handle: sendMessage },

  // No Task is ever created (see the header note), so these are honest, not stubs.
  GetTask: {
    auth: true,
    handle: async (params) => {
      throw new RpcError(ERR.TASK_NOT_FOUND, errorInfo('TASK_NOT_FOUND', { taskId: params?.id ?? '' }));
    },
  },
  CancelTask: {
    auth: true,
    handle: async (params) => {
      throw new RpcError(ERR.TASK_NOT_FOUND, errorInfo('TASK_NOT_FOUND', { taskId: params?.id ?? '' }));
    },
  },
  ListTasks: { auth: true, handle: async () => ({ tasks: [] }) },

  SendStreamingMessage: { auth: true, handle: unsupported('streaming') },
  SubscribeToTask: { auth: true, handle: unsupported('streaming') },
  CreateTaskPushNotificationConfig: { auth: true, handle: pushUnsupported },
  GetTaskPushNotificationConfig: { auth: true, handle: pushUnsupported },
  ListTaskPushNotificationConfig: { auth: true, handle: pushUnsupported },
  DeleteTaskPushNotificationConfig: { auth: true, handle: pushUnsupported },

  GetExtendedAgentCard: {
    auth: true,
    handle: async () => {
      throw new RpcError(
        ERR.EXTENDED_CARD_NOT_CONFIGURED,
        errorInfo('EXTENDED_AGENT_CARD_NOT_CONFIGURED'),
      );
    },
  },
};

function unsupported(capability) {
  return async () => {
    throw new RpcError(ERR.UNSUPPORTED_OPERATION, errorInfo('UNSUPPORTED_OPERATION', { capability }));
  };
}

async function pushUnsupported() {
  throw new RpcError(ERR.PUSH_NOT_SUPPORTED, errorInfo('PUSH_NOTIFICATIONS_NOT_SUPPORTED'));
}

// ─── Transport ────────────────────────────────────────────────────────────────

function allowCors(req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
}

function protectedResourceUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const base = (process.env.API_BASE_URL || `${proto}://${host}`).replace(/\/+$/, '');
  return `${base}/.well-known/oauth-protected-resource${A2A_BASE_PATH}`;
}

// Mirrors the MCP binding: a 401 must carry the RFC 9728 pointer, otherwise an
// agent client has no way to discover where to run OAuth.
function requireA2aAuth(req, res, next) {
  const respond = res.status.bind(res);
  res.status = (code) => {
    if (code === 401) {
      res.set('WWW-Authenticate', `Bearer resource_metadata="${protectedResourceUrl(req)}"`);
    }
    res.status = respond;
    return res.status(code);
  };
  return requireAuth(req, res, next);
}

function hasCredentials(req) {
  return Boolean(req.headers['x-api-key'] || req.headers.authorization || req.headers.cookie);
}

// `GetAgentCard` is public discovery — a scanner with no credentials must be
// able to read the card. Anything else goes through auth, and a request that
// carries credentials is always authenticated even when it asks for the card.
function authGate(req, res, next) {
  const body = req.body;
  const method = body && !Array.isArray(body) ? body.method : null;
  if (method && METHODS[method]?.auth === false && !hasCredentials(req)) return next();
  return requireA2aAuth(req, res, next);
}

// Convenience GET: hand back the card so an operator (or a registry probing the
// endpoint) sees what lives here instead of a 404. Not an advertised interface.
router.get('/', allowCors, (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(buildAgentCard());
});

// Envelope validation runs *before* the auth gate: it reports nothing about the
// server, only about the caller's own payload, and answering a malformed body
// with 401 would send a client hunting for a credential problem it doesn't have.
function validateEnvelope(req, res, next) {
  const body = req.body;
  if (Array.isArray(body)) {
    // JSON-RPC batching is optional and A2A defines no batch semantics.
    return res.json(rpcError(null, new RpcError(ERR.INVALID_REQUEST, errorInfo('BATCH_NOT_SUPPORTED'))));
  }
  if (!body || typeof body !== 'object' || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return res.json(rpcError(body?.id ?? null, new RpcError(ERR.INVALID_REQUEST)));
  }
  return next();
}

router.post('/', allowCors, validateEnvelope, authGate, async (req, res) => {
  const body = req.body;
  const id = body.id ?? null;
  const entry = METHODS[body.method];
  if (!entry) {
    return res.json(rpcError(id, new RpcError(
      ERR.METHOD_NOT_FOUND,
      errorInfo('METHOD_NOT_FOUND', { method: body.method }),
    )));
  }

  try {
    const result = await entry.handle(body.params || {}, req.actor);
    return res.json({ jsonrpc: '2.0', id, result });
  } catch (err) {
    if (err instanceof RpcError) return res.json(rpcError(id, err));
    console.error('[A2A] handler failed:', err?.message);
    return res.json(rpcError(id, new RpcError(ERR.INTERNAL)));
  }
});

function rpcError(id, err) {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: err.code,
      message: err.message,
      ...(err.data ? { data: err.data } : {}),
    },
  };
}

// ─── Discovery ────────────────────────────────────────────────────────────────
// The canonical Agent Card lives on the apex host (deerdawn.com), which is what
// an A2A client resolves; this is the same card on the API host, for clients
// that discover the service endpoint first and walk back to its well-known URI.
// Mounted at '/' above the bootstrap gate so a scanner is never told 503.

const discoveryRouter = express.Router();

discoveryRouter.get('/.well-known/agent-card.json', allowCors, (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600, s-maxage=3600');
  res.json(buildAgentCard());
});

module.exports = router;
module.exports.discoveryRouter = discoveryRouter;
module.exports.SKILL_HANDLERS = SKILL_HANDLERS;
module.exports.METHODS = METHODS;
// Exported for tests: the Message -> { skill, input } collapse is the one piece
// of A2A-specific interpretation that isn't reachable through the transport
// without a live actor.
module.exports.readMessage = readMessage;
module.exports.RpcError = RpcError;
