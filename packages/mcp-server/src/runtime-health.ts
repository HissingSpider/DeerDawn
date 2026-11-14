import { recordSurfaceHeartbeat, recordSurfaceFailure } from '../../shared-context/src/setup-status.js';

export type RuntimeSurfaceId = 'claude_code' | 'cursor' | 'claude_desktop' | 'codex';

export function resolveRuntimeSurfaceId(): RuntimeSurfaceId | null {
  const explicit = process.env.DEERDAWN_SURFACE_ID;
  if (explicit === 'claude_code' || explicit === 'cursor' || explicit === 'claude_desktop' || explicit === 'codex') {
    return explicit;
  }
  return null;
}

export function recordRuntimeSuccess(event: { toolName?: string; cwd?: string; runtimeVersion?: string } = {}) {
  const surface = resolveRuntimeSurfaceId();
  if (!surface) return null;
  return recordSurfaceHeartbeat(surface, {
    tool_name: event.toolName || null,
    cwd: event.cwd || process.cwd(),
    runtime_version: event.runtimeVersion || process.env.DEERDAWN_MCP_VERSION || null,
  });
}

export function recordRuntimeFailure(error: { message?: string; toolName?: string; cwd?: string; runtimeVersion?: string } = {}) {
  const surface = resolveRuntimeSurfaceId();
  if (!surface) return null;
  return recordSurfaceFailure(surface, {
    last_error: error.message || 'runtime_failure',
    tool_name: error.toolName || null,
    cwd: error.cwd || process.cwd(),
    runtime_version: error.runtimeVersion || process.env.DEERDAWN_MCP_VERSION || null,
  });
}
