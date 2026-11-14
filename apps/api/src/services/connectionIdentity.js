'use strict';

/**
 * WHICH TOOL IS CALLING, AND HOW IT CONNECTS. Two facts, recorded separately
 * (journey round 3, design B; the owner's decision "record tool and transport
 * separately").
 *
 * One field, `surface` (and its twin `context_sessions.tool`), used to carry
 * both. `claude_code` said "the Claude Code editor" and, by the way the local
 * server writes it, "over a local install". `claude_web` said "Claude.ai" and
 * "over the hosted connector". A hosted Claude Code, Codex or Cursor had no
 * value at all and was filed as `unknown_web`, so Setup read "0 tools
 * connected" beside a connection that worked; and attributing it to `codex`
 * would have made the hosted-plus-local dedup read it as local.
 *
 * So there are two fields and this is the only place that names their values.
 *
 *   TOOL       which client it is: claude_code, cursor, codex, claude_web
 *              (Claude.ai), chatgpt_web (ChatGPT), gemini, perplexity, or a
 *              slug the local server derived from an unrecognised client. null
 *              when nothing says. The values are the ones that already existed,
 *              so nothing that reads them changes meaning.
 *   TRANSPORT  how the call arrived:
 *                local_stdio     the local install (packages/mcp-server)
 *                hosted_oauth    the hosted endpoint, on an OAuth grant
 *                hosted_api_key  the hosted endpoint, on an API key
 *                rest_api        the REST API (a browser userscript, a script)
 *                hosted          hosted, credential kind not recorded (rows
 *                                that predate this field)
 *
 * Old values stay readable: `fromLegacySurface` derives both from the mixed
 * field, and the SQL fragments below derive them for rows that were written
 * without the new columns.
 */

const TRANSPORT = Object.freeze({
  LOCAL_STDIO: 'local_stdio',
  HOSTED_OAUTH: 'hosted_oauth',
  HOSTED_API_KEY: 'hosted_api_key',
  REST_API: 'rest_api',
  HOSTED: 'hosted',
});

const TRANSPORT_VALUES = new Set(Object.values(TRANSPORT));

// Surfaces that name no tool: the hosted endpoint could not say which client,
// or the local server could not resolve one.
const NON_IDENTIFYING = new Set(['', 'unknown', 'unknown_web']);

// Claude.ai and ChatGPT are web apps: they reach DeerDawn only through the
// hosted endpoint, on an OAuth grant (or, for the browser capture userscript,
// the REST API). A local install or a hosted API key is never one of them.
const WEB_APP_TOOLS = new Set(['claude_web', 'chatgpt_web']);
const WEB_APP_TRANSPORTS = new Set([TRANSPORT.HOSTED_OAUTH, TRANSPORT.HOSTED, TRANSPORT.REST_API]);

const TOOL_LABELS = Object.freeze({
  claude_code: 'Claude Code',
  claude_desktop: 'Claude Desktop',
  claude_web: 'Claude.ai',
  chatgpt_web: 'ChatGPT',
  cursor: 'Cursor',
  codex: 'Codex',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
});

const TRANSPORT_LABELS = Object.freeze({
  [TRANSPORT.LOCAL_STDIO]: 'local install',
  [TRANSPORT.HOSTED_OAUTH]: 'hosted connection',
  [TRANSPORT.HOSTED_API_KEY]: 'hosted connection with an API key',
  [TRANSPORT.REST_API]: 'REST API',
  [TRANSPORT.HOSTED]: 'hosted connection',
});

function cleanTool(value) {
  const tool = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 64);
  return tool && !NON_IDENTIFYING.has(tool) ? tool : null;
}

function cleanTransport(value) {
  const transport = String(value || '').trim();
  return TRANSPORT_VALUES.has(transport) ? transport : null;
}

/**
 * Tool and transport for a row written with only the mixed `surface` field
 * (and, for a product event, its metadata).
 */
function fromLegacySurface(surface, metadata = null) {
  const value = String(surface || '').trim();
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  const tool = cleanTool(value);
  let transport;
  if (meta.execution_source === 'stdio') transport = TRANSPORT.LOCAL_STDIO;
  else if (meta.transport === 'http' || value.endsWith('_web')) transport = TRANSPORT.HOSTED;
  else transport = TRANSPORT.LOCAL_STDIO;
  return { tool, transport };
}

/** How a hosted MCP request authenticated: an OAuth grant, else an API key. */
function hostedTransport(actor) {
  return actor?.oauth_resource ? TRANSPORT.HOSTED_OAUTH : TRANSPORT.HOSTED_API_KEY;
}

/**
 * The transport of a session row, from the session id and the caller.
 *
 * `web-…` ids are derived by the hosted endpoint (hostedSessionIdentity),
 * `agent-…` ids by the local server's process (mcp-server agent-session). Any
 * other id came in over the REST API (the dashboard, a browser userscript, a
 * script), unless the caller holds an OAuth grant, which only the hosted
 * endpoint issues. Null when nothing says.
 */
function sessionTransport(actor, sessionId) {
  const id = String(sessionId || '');
  if (id.startsWith('web-')) return hostedTransport(actor);
  if (id.startsWith('agent-')) return TRANSPORT.LOCAL_STDIO;
  if (actor?.oauth_resource) return TRANSPORT.HOSTED_OAUTH;
  if (actor?.type === 'key' || actor?.type === 'user') return TRANSPORT.REST_API;
  return null;
}

/**
 * What to SHOW for a stored tool. A web app's id on a connection a web app
 * cannot make (a local install, a hosted API key) is not that app: the row is
 * kept, and reads as an unidentified client instead of "Claude.ai connected".
 */
function displayTool(tool, transport) {
  const id = cleanTool(tool);
  if (!id) return null;
  if (WEB_APP_TOOLS.has(id) && transport && !WEB_APP_TRANSPORTS.has(transport)) return null;
  return id;
}

function toolLabel(tool) {
  const id = cleanTool(tool);
  if (!id) return 'Unidentified client';
  return TOOL_LABELS[id] || id.replace(/_+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function transportLabel(transport) {
  return TRANSPORT_LABELS[transport] || null;
}

// The same derivations for rows already in the database, as SQL over a table
// alias, so a reader can use the new columns and fall back to the old field.
// `tool` and `transport` columns win when set.
function toolSql(alias = '') {
  const a = alias ? `${alias}.` : '';
  return `COALESCE(NULLIF(${a}tool, ''), CASE WHEN ${a}surface IS NULL OR ${a}surface IN ('', 'unknown', 'unknown_web') THEN NULL ELSE ${a}surface END)`;
}

function transportSql(alias = '') {
  const a = alias ? `${alias}.` : '';
  return `COALESCE(NULLIF(${a}transport, ''), CASE
    WHEN ${a}metadata->>'execution_source' = 'stdio' THEN 'local_stdio'
    WHEN ${a}metadata->>'transport' = 'http' OR ${a}surface LIKE '%\\_web' THEN 'hosted'
    ELSE 'local_stdio' END)`;
}

module.exports = {
  TRANSPORT,
  TRANSPORT_VALUES,
  WEB_APP_TOOLS,
  cleanTool,
  cleanTransport,
  fromLegacySurface,
  hostedTransport,
  sessionTransport,
  displayTool,
  toolLabel,
  transportLabel,
  toolSql,
  transportSql,
};
