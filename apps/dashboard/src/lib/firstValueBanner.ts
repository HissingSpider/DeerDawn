export interface FirstValueSignals {
  isLoading: boolean;
  /** sync_health.has_projects */
  hasProjects: boolean;
  /** sync_health.mcp_registered — MCP traffic in the LAST 30 DAYS only. */
  mcpConnected: boolean;
  /** sync_health.has_first_sync — durable: a tool was connected at some point. */
  hasFirstSync: boolean;
}

/**
 * Should the brief page show the "Connect an AI tool" strip?
 *
 * It is for exactly one person: somebody who HAS a brief (an import, say) and
 * has never connected a live tool, so new sessions will not pick it up. The
 * no-projects state belongs to the sample-brief hero.
 *
 * mcp_registered looks back 30 days, so on its own it sent an established user
 * who took a month off back to "Connect an AI tool". A first sync is durable
 * evidence that they connected once; they are not a first-run user.
 */
export function shouldShowFirstValueBanner(signals: FirstValueSignals): boolean {
  if (signals.isLoading || !signals.hasProjects) return false;
  return !signals.mcpConnected && !signals.hasFirstSync;
}
