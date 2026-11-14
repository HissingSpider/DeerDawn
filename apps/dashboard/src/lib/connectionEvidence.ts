/**
 * What counts as a connection.
 *
 * This is the one metric the company steers by, and it was being minted by the
 * dashboard writing to its own database. The connect step computed
 *
 *   synced   = runtime_verified || has_projects || recently_active
 *   detected = synced || mcp_registered
 *
 * and the API computed `mcp_registered = mcp_events || recently_synced ||
 * has_projects`, so THREE of the four inputs were satisfied by a row existing in
 * context_projects. A phone user on the capture-first ordering types two lines,
 * presses "Save my first brief", and that single POST turns has_projects and
 * recently_active true. They then arrive on the connect step already 'synced':
 * onboarding_connection_detected fires, the step auto-advances after 1.5s, and
 * onboarding_completed records verified_connection: true — for somebody who has
 * never opened an AI tool.
 *
 * That is the same mistake twice over. `connection_established` exists precisely
 * because a connector handshake is not a tool call
 * (activation-connector-not-a-trigger, 2026-08-26: 3 of 8 handshaked accounts
 * have never produced one); this went a step further and counted something that
 * is not even a handshake. Both times the pattern was a signal that is easy to
 * observe standing in for one that is hard.
 *
 * So evidence of a connection means a client reached the server holding a
 * credential. Nothing this dashboard can do on the user's behalf qualifies:
 *
 *   - `mcpRegistered`   product_events rows with source='mcp'. The hosted
 *                       dispatcher writes mcp_runtime_started on `initialize`
 *                       and mcp_tool_call_succeeded / mcp_start_session_succeeded
 *                       per call; the local stdio server writes the same names,
 *                       and only after auth resolves. The device-flow events are
 *                       source='mcp_auth' and deliberately NOT in this set — an
 *                       abandoned sign-in is not a connection.
 *   - `runtimeVerified` `npx @deerdawn/mcp-server setup` verified the runtime.
 *   - `hasFirstSync`    first_sync_completed: a brief actually reached a tool.
 *                       Durable, once per user, and the strongest of the three.
 *
 * `hasProjects` and `recentlyActive` are accepted by this module and ignored by
 * it, on purpose. They are the two that caused the defect, and taking them as
 * named inputs is what lets the test above assert, exhaustively, that no
 * combination of them can move the status off 'waiting'. Callers should keep
 * passing them rather than dropping them at the call site, where the omission
 * would be invisible.
 */

export type ConnectionEvidence = 'none' | 'handshake' | 'first_sync';

export type ConnectionStatus = 'waiting' | 'detected' | 'synced';

export interface ConnectionSignals {
  /** sync_health.mcp_registered — product_events with source='mcp'. Evidence. */
  mcpRegistered?: boolean;
  /** sync_health.has_first_sync — first_sync_completed. Evidence, and the best. */
  hasFirstSync?: boolean;
  /** local setup status runtime_verified_count > 0. Evidence. */
  runtimeVerified?: boolean;
  /** sync_health.has_projects. NOT evidence: the dashboard creates these itself. */
  hasProjects?: boolean;
  /** sync_health.recently_active. NOT evidence, for the same reason. */
  recentlyActive?: boolean;
}

/**
 * The strongest evidence of an actual connection present in these signals, or
 * 'none'. Returned rather than a boolean so the emitter can say WHICH signal
 * moved it — without that, a future regression looks identical in PostHog to the
 * real thing, which is how this survived as long as it did.
 */
export function connectionEvidence(signals: ConnectionSignals): ConnectionEvidence {
  if (signals.hasFirstSync) return 'first_sync';
  if (signals.mcpRegistered || signals.runtimeVerified) return 'handshake';
  return 'none';
}

/** The connect step's three-state view of the same answer. */
export function connectionStatus(signals: ConnectionSignals): ConnectionStatus {
  switch (connectionEvidence(signals)) {
    case 'first_sync':
      return 'synced';
    case 'handshake':
      return 'detected';
    default:
      return 'waiting';
  }
}

/**
 * How long to wait before the connect step asks the server again.
 *
 * It asked every 4 seconds for as long as the tab stayed open, and each ask is
 * the full dashboard bootstrap: thirteen queries. A tab left on this step over
 * lunch made ~900 of them. The fast cadence only matters while somebody is
 * actively pasting a URL into another tool, which is the first couple of
 * minutes — and coming back to the tab re-checks at once regardless (the
 * focus/visibility handler), so backing off costs a returning user nothing.
 */
export function nextPollDelay(elapsedMs: number): number {
  if (elapsedMs < 2 * 60_000) return 4_000;
  if (elapsedMs < 10 * 60_000) return 15_000;
  return 60_000;
}
