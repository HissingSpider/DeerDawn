'use strict';

/**
 * sessionDedup: cross-connection session-load dedup.
 *
 * A single user can have DeerDawn connected more than once at the same time —
 * e.g. the claude.ai connector AND a local Claude Code MCP server. When that
 * happens, each connection independently demands `start_session` and re-delivers
 * the same project context, doubling the payload (tokens + noise) for one
 * logical session.
 *
 * This records a short-lived per-(person, project) marker in Redis on each real
 * start_session. A second start_session for the same user+project within the TTL
 * is reported as a duplicate, so the caller can return a compact "already loaded"
 * pointer instead of repeating the full brief. It generalizes the in-process
 * on-disk dedup (mcp-server compares the brief against .deerdawn-context.md) to
 * work across two independent connections that can't see each other's state.
 *
 * Safety: this only suppresses the start_session TOOL payload, never the
 * SessionStart hook injection — every Claude Code session still receives full
 * context from its own hook regardless of this marker. The marker is keyed by
 * resolved project, so a session on a different project never collides.
 *
 * ONLY THAT CASE. One of the two connections is always HOSTED: a host does not
 * run two local DeerDawn stdio servers, so two LOCAL loads are two sessions.
 * The check used to ignore the surfaces, and Claude Code then Cursor on the
 * same project inside the window told Cursor its brief was "already loaded"
 * when it had never had it. See isHostedSurface. The one local pair that IS a
 * duplicate is a single process loading twice; see checkAndMarkSessionLoad.
 */

const { redis } = require('../config/redis');
const workspace = require('./workspaceService');
const { getToolProfile } = require('../../../../packages/tool-adapters/src/index.js');

// Window in which a repeat start_session for the same user+project counts as a
// duplicate. Long enough to cover two connectors racing at session start, short
// enough that two genuinely separate sessions rarely overlap.
const DEDUP_TTL_SECONDS = 90;

function actorKey(actor) {
  return workspace.defaultOwnerKey(actor) || 'org-system';
}

// Keyed by PERSON within the workspace, not by the workspace alone. On a shared
// project every teammate resolves to the same owner_key, so a workspace-only key
// let Bob's start_session inside the window mark Alice's as a "duplicate" — which
// skipped her catch-up and her session accounting outright. The dedup exists for
// one person reaching the server through two connections (a claude.ai connector
// and a local key both resolve to the same person via actorPersonId), so the
// person is the right grain.
//
// No person (a system key, an internal `{ id: ownerKey }` actor, a legacy key with
// no owner) keeps the original workspace-level key, byte for byte.
function markerKey(actor, projectId) {
  const person = workspace.actorPersonId(actor);
  const scope = person ? `${actorKey(actor)}:u:${person}` : actorKey(actor);
  return `dd:ss:${scope}:${projectId || 'workspace'}`;
}

// Did this load arrive over a HOSTED connection? The vocabulary has two sources
// of truth, one per caller:
//   - routes/mcp.js detectWebSurface is the only thing the hosted dispatcher
//     passes: claude_web, chatgpt_web, or unknown_web when a stateless
//     tools/call carried no clientInfo. `_web` is that function's convention for
//     "came through the hosted transport", so unknown_web counts: it does not
//     say WHICH web host, and it is certainly one.
//   - the /active route (the local server's start_session) passes a profile id
//     from packages/tool-adapters, whose `surface` field already marks the
//     browser ones.
// claude_code, cursor, codex, and a surface nobody named are not hosted.
//
// An UNNAMED surface (absent, '', 'unknown') is deliberately not hosted, so it
// can never withhold a brief on its own; only a positively hosted other side
// makes the pair a duplicate. Delivering a brief twice costs tokens once;
// withholding one leaves a session with no memory, which is the product's
// whole promise broken. Neither caller sends one today (the /active route
// defaults to claude_code, the hosted dispatcher to unknown_web).
function isHostedSurface(surface) {
  const id = typeof surface === 'string' ? surface : '';
  return id.endsWith('_web') || getToolProfile(id)?.surface === 'browser';
}

/**
 * Record this start_session and report whether another connection already loaded
 * the same context within the dedup window, where one of the two loads is a
 * hosted connection (isHostedSurface), or whether the SAME local process already
 * did (`options.sessionId`, see below). Always refreshes the marker for the
 * current surface. Never throws — on any Redis error it reports "not a duplicate"
 * so a degraded cache can never suppress real context.
 *
 * `options.sessionId` is the calling process's own id: the local server sends a
 * per-process `agent-<pid>-<hex>` as session_id on every /active call. Two local
 * loads are two sessions, except when they are one process loading twice (the
 * model calls start_session again, or a hook and the tool both load), which
 * already has the brief. Only two KNOWN and EQUAL ids say that; an id missing on
 * either side, including a marker written before ids were stored, never does.
 *
 * @returns {Promise<{duplicate: boolean, secondsAgo: number|null, otherSurface: string|null}>}
 */
async function checkAndMarkSessionLoad(actor, projectId, surface, options) {
  const key = markerKey(actor, projectId);
  const now = Date.now();
  const NONE = { duplicate: false, secondsAgo: null, otherSurface: null };
  const processId = typeof options?.sessionId === 'string' && options.sessionId ? options.sessionId : null;

  let prior = null;
  try {
    const raw = await redis.get(key);
    if (raw) prior = JSON.parse(raw);
  } catch {
    prior = null; // degraded cache — treat as first load
  }

  try {
    await redis.set(key, JSON.stringify({ at: now, surface: surface || null, session: processId }), 'EX', DEDUP_TTL_SECONDS);
  } catch {
    // Couldn't persist the marker — without it we can't dedup the next call, but
    // delivering full context twice is the safe failure mode.
  }

  // A duplicate only when one side of the pair is hosted, or both are the same
  // local process. The marker above is written either way, so a hosted load that
  // follows a local one still finds it.
  //
  // The marker holds only the LATEST load. So process A, then process B, then A
  // again inside the window gives A's second call a full brief: it is compared
  // with B, not with its own first load. That costs one repeated brief and one
  // extra booked session, only when two processes take turns loading the same
  // project inside 90 seconds, and it errs the safe way; a marker per process
  // would be a key per process.
  const hostedPair = isHostedSurface(prior?.surface) || isHostedSurface(surface);
  const sameProcess = Boolean(processId) && prior?.session === processId;
  if (prior && Number.isFinite(prior.at) && (hostedPair || sameProcess)) {
    return {
      duplicate: true,
      secondsAgo: Math.max(0, Math.round((now - prior.at) / 1000)),
      otherSurface: prior.surface && prior.surface !== surface ? prior.surface : null,
    };
  }
  return NONE;
}

module.exports = { checkAndMarkSessionLoad, DEDUP_TTL_SECONDS, markerKey };
