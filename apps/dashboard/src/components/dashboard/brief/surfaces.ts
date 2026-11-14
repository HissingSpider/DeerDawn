// Shared surface vocabulary for the brief's tool panels. Both the "Connected
// tools — caught up" list and the single-tool "brief follows you" nudge must
// agree on what counts as a connected tool — otherwise the panel can show five
// tools while the nudge claims everything reached you through only one.
//
// A surface counts as a real, connected tool when it is *identifiable* and has
// actually been seen (last_called_at). 'unknown' (local events whose surface
// couldn't be resolved) and 'unknown_web' (stateless web tools/call with no
// clientInfo) are NON-identifying: they are un-attributed events from a session
// that already appears under its real name (claude_code / claude_web / …), so
// showing them as their own row is a phantom duplicate. Filter them everywhere.

export type McpSurface = {
  surface: string;
  start_sessions: number;
  start_session_skips: number;
  update_contexts: number;
  tool_calls: number;
  last_called_at: string | null;
  call_rate: number | null;
};

export const SURFACE_LABELS: Record<string, string> = {
  claude_code: 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex',
  chatgpt_web: 'ChatGPT',
  claude_web: 'Claude (web)',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
};

const NON_IDENTIFYING = new Set(['unknown', 'unknown_web', '']);

export function isIdentifiedSurface(s: Pick<McpSurface, 'surface' | 'last_called_at'>): boolean {
  return Boolean(s.surface) && !NON_IDENTIFYING.has(s.surface) && Boolean(s.last_called_at);
}

/** Connected, identifiable tools — the single source of truth for both panels. */
export function identifiedSurfaces(surfaces: McpSurface[] | undefined | null): McpSurface[] {
  return (surfaces || []).filter(isIdentifiedSurface);
}

export function surfaceLabel(surface: string): string {
  if (SURFACE_LABELS[surface]) return SURFACE_LABELS[surface];
  // Unmapped client — the local server records a slug of its self-reported name
  // (e.g. 'windsurf', 'mcp_inspector'). Present it readably rather than raw.
  return surface.replace(/_+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
