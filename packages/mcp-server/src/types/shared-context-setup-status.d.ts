declare module '../../shared-context/src/setup-status.js' {
  export function recordSurfaceHeartbeat(surface: string, metadata?: Record<string, unknown>): unknown;
  export function recordSurfaceFailure(surface: string, metadata?: Record<string, unknown>): unknown;
}

declare module '../../../shared-context/src/setup-status.js' {
  export function applySurfaceSetup(surface: string, mode?: 'auto' | 'repair' | 'restore'): Record<string, unknown>;
  export function inspectLocalSetupStatus(): Record<string, unknown>;
}

declare module '*shared-context/src/setup-status.js' {
  export function recordSurfaceHeartbeat(surface: string, metadata?: Record<string, unknown>): unknown;
  export function recordSurfaceFailure(surface: string, metadata?: Record<string, unknown>): unknown;
  export function applySurfaceSetup(surface: string, mode?: 'auto' | 'repair' | 'restore'): Record<string, unknown>;
  export function inspectLocalSetupStatus(): Record<string, unknown>;
}
