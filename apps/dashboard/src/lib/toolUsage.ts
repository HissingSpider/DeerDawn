/**
 * Which tool called DeerDawn and how it connected, as two facts (journey round
 * 3, design B). The API's `sync_health.mcp_tools` carries both; the older
 * `mcp_surfaces` carries one mixed `surface` and is still sent.
 *
 * Setup's tool cards are keyed by tool, so this folds `mcp_tools` into the
 * per-tool shape they already read, and remembers which transports the calls
 * came over, so a card can say "local install" or "hosted connection" and a
 * hosted Claude Code is never shown as Claude.ai (or the other way round).
 */

export type McpToolRow = {
  tool: string | null;
  transport: string | null;
  start_sessions: number;
  start_session_skips: number;
  update_contexts: number;
  tool_calls: number;
  handshakes?: number;
  last_called_at: string | null;
};

export type ToolUsage = {
  surface: string;
  start_sessions: number;
  start_session_skips: number;
  update_contexts: number;
  tool_calls: number;
  last_called_at: string | null;
  call_rate: number | null;
  handshakes?: number;
  /** How the calls arrived, most recent first. */
  transports?: string[];
};

export const TRANSPORT_LABELS: Record<string, string> = {
  local_stdio: 'local install',
  hosted_oauth: 'hosted connection',
  hosted_api_key: 'hosted connection with an API key',
  rest_api: 'REST API',
  hosted: 'hosted connection',
};

export function transportLabel(transport: string): string {
  return TRANSPORT_LABELS[transport] || transport;
}

/**
 * One row per tool. A client nothing could name (`tool` null) becomes
 * 'unknown_web', the same non-identifying surface the older field used, so the
 * cards' existing handling of unidentified hosted calls is unchanged.
 */
export function usageFromTools(rows: McpToolRow[] | null | undefined): ToolUsage[] {
  const byTool = new Map<string, ToolUsage & { seen: Array<[string, string]> }>();
  for (const row of rows ?? []) {
    const key = row.tool || 'unknown_web';
    const entry = byTool.get(key) ?? {
      surface: key,
      start_sessions: 0,
      start_session_skips: 0,
      update_contexts: 0,
      tool_calls: 0,
      last_called_at: null,
      call_rate: null,
      handshakes: 0,
      seen: [] as Array<[string, string]>,
    };
    entry.start_sessions += row.start_sessions;
    entry.start_session_skips += row.start_session_skips;
    entry.update_contexts += row.update_contexts;
    entry.tool_calls += row.tool_calls;
    entry.handshakes = (entry.handshakes ?? 0) + (row.handshakes ?? 0);
    if ((row.last_called_at ?? '') > (entry.last_called_at ?? '')) entry.last_called_at = row.last_called_at;
    if (row.transport) entry.seen.push([row.last_called_at ?? '', row.transport]);
    byTool.set(key, entry);
  }
  return [...byTool.values()].map(({ seen, ...usage }) => {
    const starts = usage.start_sessions;
    const denom = starts + usage.start_session_skips;
    return {
      ...usage,
      // Only the local install can skip start_session and say so.
      call_rate: denom > 0 ? Math.round((starts / denom) * 100) : null,
      transports: [...new Set(seen.sort((a, b) => b[0].localeCompare(a[0])).map(([, transport]) => transport))],
    };
  });
}

/** `mcp_tools` when the API sends it, else the older per-surface rows. */
export function usageFromHealth(
  health: { mcp_tools?: McpToolRow[] | null; mcp_surfaces?: ToolUsage[] | null } | null | undefined,
): ToolUsage[] {
  if (health?.mcp_tools && health.mcp_tools.length > 0) return usageFromTools(health.mcp_tools);
  return health?.mcp_surfaces ?? [];
}
