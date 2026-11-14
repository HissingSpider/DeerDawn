/**
 * agent-session — a stable identity for THIS running agent.
 *
 * Before this existed, every context write minted a fresh id (`mcp-${Date.now()}`
 * in client.ts), so the server saw one throwaway session per write: nothing could
 * be attributed to an agent across two calls, and context_sessions accumulated an
 * orphan row per update. Multi-agent coordination is entirely a read on that
 * attribution — presence, holds and staleness all need to know that the agent
 * asking now is the same one that wrote a minute ago — so the id has to outlive
 * the call.
 *
 * Scope is the PROCESS. One MCP server process is one agent working in one
 * workspace, which is exactly the unit a peer needs to be told about. It is
 * deliberately not persisted to disk: a stale id surviving a crash would look
 * like a live peer holding cards nobody is on, and rule 3 (TTL on everything)
 * says a dead agent must release by doing nothing.
 */

import { randomBytes } from 'crypto';

let cachedSessionId: string | null = null;

/**
 * Short, human-readable, and unique enough to name in a brief line another agent
 * has to read. The pid makes it recognisable in `ps` while debugging; the random
 * suffix keeps two same-pid processes on different hosts from colliding.
 */
export function getAgentSessionId(): string {
  if (cachedSessionId) return cachedSessionId;
  const pid = typeof process.pid === 'number' ? process.pid : 0;
  cachedSessionId = `agent-${pid.toString(36)}-${randomBytes(3).toString('hex')}`;
  return cachedSessionId;
}

/**
 * The session_context every write should carry so a peer can be described by
 * WHERE it is working, not just by an opaque id.
 *
 * `host` is never sent: the machine's hostname is NOT part of the context. It
 * used to be `os.hostname()` verbatim — often the owner's name
 * ("Johns-MacBook-Pro") or an employer/university domain — and the server
 * stored it on every session, minted a durable graph entity from it, and
 * printed it into the brief's "Resuming from X on <host>" line, which on a
 * shared workspace is read by colleagues. Nothing needs it: agent identity is
 * the session id above, presence and board holds key on that, and the handoff
 * line reads fine without the machine. A hash was considered and rejected — a
 * hostname is low-entropy, so its hash is guessable, and no consumer needs to
 * tell machines apart.
 *
 * The key is ABSENT, never null. The API's schema is `host: z.string()
 * .optional()`: an omitted key passes, a null one is a 400 invalid_payload. For
 * one release this returned `host: null` "so older APIs see the same keys", and
 * every local update carrying a summary failed with a bare -32602 — the tests
 * that shipped it ran against a stub API that accepted anything. The same rule
 * holds for `cwd`: when it cannot be resolved it is left out, not sent as null.
 * Pinned against the REAL route schema in
 * tests/session-context-real-api.node.test.cjs.
 *
 * Every field degrades to absent rather than throwing: attribution is a
 * nice-to-have on a write whose real job is saving the user's context.
 */
export function getAgentSessionContext(cwd?: string): {
  cwd?: string;
  status: string;
} {
  let resolvedCwd: string | null = null;
  try {
    resolvedCwd = cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd() || null;
  } catch { resolvedCwd = null; }
  return resolvedCwd ? { cwd: resolvedCwd, status: 'active' } : { status: 'active' };
}
