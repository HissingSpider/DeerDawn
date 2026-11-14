import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// surface.ts holds module-level detection state, so each case loads a fresh copy.
async function freshSurface() {
  vi.resetModules();
  return import('../src/surface.js');
}

describe('surface detection', () => {
  const prevEnv = process.env.DEERDAWN_SURFACE_ID;

  beforeEach(() => {
    delete process.env.DEERDAWN_SURFACE_ID;
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.DEERDAWN_SURFACE_ID;
    else process.env.DEERDAWN_SURFACE_ID = prevEnv;
  });

  it('maps known clients to canonical ids for both telemetry and rendering', async () => {
    for (const [name, expected] of [
      ['claude-code', 'claude_code'],
      ['Cursor', 'cursor'],
      ['cursor-vscode', 'cursor'],
      ['codex-cli', 'codex'],
      ['openai-mcp', 'codex'],
    ] as const) {
      const s = await freshSurface();
      s.recordDetectedSurface(name, '1.2.3');
      expect(s.resolveLocalSurfaceOrNull()).toBe(expected);
      expect(s.resolveLocalSurface()).toBe(expected);
    }
  });

  it('preserves an unmapped client as a slug for telemetry, safe default for rendering', async () => {
    const s = await freshSurface();
    s.recordDetectedSurface('Windsurf', '0.9');
    // Telemetry keeps the real identity (no longer a phantom "unknown")...
    expect(s.resolveLocalSurfaceOrNull()).toBe('windsurf');
    // ...but rendering falls back to a profile a context adapter understands.
    expect(s.resolveLocalSurface()).toBe('claude_code');
    // Raw name/version are captured for diagnosis.
    expect(s.getDetectedClientMeta()).toEqual({ client_name: 'Windsurf', client_version: '0.9' });
  });

  it('names a tool for a session or a save only when it was positively identified', async () => {
    const mapped = await freshSurface();
    mapped.recordDetectedSurface('claude-code', '2');
    expect(mapped.resolveIdentifiedSurface()).toBe('claude_code');
    // Windsurf renders as claude_code, but that is a default, not an identity.
    const unmapped = await freshSurface();
    unmapped.recordDetectedSurface('Windsurf', '0.9');
    expect(unmapped.resolveLocalSurface()).toBe('claude_code');
    expect(unmapped.resolveIdentifiedSurface()).toBeNull();
    const anonymous = await freshSurface();
    expect(anonymous.resolveIdentifiedSurface()).toBeNull();
    process.env.DEERDAWN_SURFACE_ID = 'cursor';
    const configured = await freshSurface();
    expect(configured.resolveIdentifiedSurface()).toBe('cursor');
  });

  it('slugifies multi-word client names to a low-cardinality id', async () => {
    const s = await freshSurface();
    s.recordDetectedSurface('MCP Inspector');
    expect(s.resolveLocalSurfaceOrNull()).toBe('mcp_inspector');
  });

  it('stays null (never a guess) when the handshake carried no name', async () => {
    const s = await freshSurface();
    s.recordDetectedSurface(undefined);
    expect(s.resolveLocalSurfaceOrNull()).toBeNull();
    // Rendering still has a safe default.
    expect(s.resolveLocalSurface()).toBe('claude_code');
    expect(s.getDetectedClientMeta()).toEqual({ client_name: null, client_version: null });
  });

  it('never resolves a client to a reserved non-identifying surface', async () => {
    const s = await freshSurface();
    s.recordDetectedSurface('unknown');
    expect(s.resolveLocalSurfaceOrNull()).toBeNull();
  });

  it('lets DEERDAWN_SURFACE_ID override detection', async () => {
    process.env.DEERDAWN_SURFACE_ID = 'codex';
    const s = await freshSurface();
    s.recordDetectedSurface('Windsurf');
    expect(s.resolveLocalSurfaceOrNull()).toBe('codex');
    expect(s.resolveLocalSurface()).toBe('codex');
  });

  it('keeps the first detected identity and does not overwrite it', async () => {
    const s = await freshSurface();
    s.recordDetectedSurface('claude-code', '1.0');
    s.recordDetectedSurface('Cursor', '2.0');
    expect(s.resolveLocalSurfaceOrNull()).toBe('claude_code');
    expect(s.getDetectedClientMeta()).toEqual({ client_name: 'claude-code', client_version: '1.0' });
  });
});

/**
 * The card is suppressed when a SessionStart hook will show it. A tagged hook
 * calling `deerdawn-mcp` (never on PATH under npx) used to count, so every
 * install lost the card to a hook that could not run.
 */
describe('hasSessionStartHook', () => {
  let home: string;
  let binDir: string;
  const prev = { HOME: process.env.HOME, PATH: process.env.PATH, SURFACE: process.env.DEERDAWN_SURFACE_ID };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-surface-home-'));
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-surface-bin-'));
    fs.writeFileSync(path.join(binDir, 'npx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.HOME = home;
    process.env.PATH = binDir;
    process.env.DEERDAWN_SURFACE_ID = 'claude_code';
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  });
  afterEach(() => {
    for (const [k, v] of [['HOME', prev.HOME], ['PATH', prev.PATH], ['DEERDAWN_SURFACE_ID', prev.SURFACE]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  const writeSessionStart = (command: string) => fs.writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { SessionStart: [{ deerdawnManaged: true, matcher: '', hooks: [{ type: 'command', command }] }] } }),
  );

  it('treats a bare deerdawn-mcp hook that is not on PATH as absent', async () => {
    writeSessionStart('deerdawn-mcp prime-worktree 2>/dev/null || true; deerdawn-mcp session-context 2>/dev/null || echo x');
    const s = await freshSurface();
    expect(s.hasSessionStartHook()).toBe(false);
  });

  it('treats the npx hook as present when npx resolves', async () => {
    const { hookCommand } = await import('../src/hook-commands.js');
    writeSessionStart(`${hookCommand('session-context')} 2>/dev/null || echo x`);
    const s = await freshSurface();
    expect(s.hasSessionStartHook()).toBe(true);
    process.env.PATH = '';
    expect(s.hasSessionStartHook()).toBe(false);
  });
});

