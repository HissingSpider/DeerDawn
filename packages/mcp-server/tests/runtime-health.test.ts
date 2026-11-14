import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { recordRuntimeFailure, recordRuntimeSuccess, resolveRuntimeSurfaceId } from '../src/runtime-health.js';

function readRuntimeFile(home: string) {
  return JSON.parse(fs.readFileSync(path.join(home, '.deerdawn', 'runtime-surfaces.json'), 'utf8'));
}

describe('runtime health', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-mcp-runtime-'));
    process.env.DEERDAWN_HOME_DIR = tempHome;
    process.env.DEERDAWN_SURFACE_ID = 'codex';
    process.env.DEERDAWN_MCP_VERSION = '1.0.15-test';
  });

  afterEach(() => {
    delete process.env.DEERDAWN_HOME_DIR;
    delete process.env.DEERDAWN_SURFACE_ID;
    delete process.env.DEERDAWN_MCP_VERSION;
  });

  it('resolves the runtime surface from environment', () => {
    expect(resolveRuntimeSurfaceId()).toBe('codex');
  });

  it('records a runtime heartbeat for the current surface', () => {
    recordRuntimeSuccess({ toolName: 'start_session', cwd: '/tmp/workspace' });
    const saved = readRuntimeFile(tempHome);

    expect(saved.surfaces.codex.runtime_verified).toBe(true);
    expect(saved.surfaces.codex.tool_name).toBe('start_session');
    expect(saved.surfaces.codex.runtime_version).toBe('1.0.15-test');
  });

  it('records the last runtime failure for the current surface', () => {
    recordRuntimeFailure({ message: 'tool_failed', toolName: 'get_context' });
    const saved = readRuntimeFile(tempHome);

    expect(saved.surfaces.codex.runtime_verified).toBe(false);
    expect(saved.surfaces.codex.last_error).toBe('tool_failed');
    expect(saved.surfaces.codex.tool_name).toBe('get_context');
  });
});
