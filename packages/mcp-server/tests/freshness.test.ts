import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { computeFreshness, recencyLine } from '../src/freshness.js';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

describe('computeFreshness', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-freshness-'));
    fs.mkdirSync(path.join(repo, '.git'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  async function mockGit(statusOut: string, headOut = 'a1b2c3d') {
    const { execFileSync } = await import('child_process');
    vi.mocked(execFileSync)
      .mockReturnValueOnce(statusOut as never) // git status --porcelain
      .mockReturnValueOnce(headOut as never); // git rev-parse --short HEAD
  }

  it('emits no stale badge when the working tree is clean', async () => {
    await mockGit('');
    const fresh = computeFreshness(repo, new Date().toISOString());
    expect(fresh.uncommittedCount).toBe(0);
    expect(fresh.staleBadge).toBeNull();
    expect(fresh.headSha).toBe('a1b2c3d');
  });

  it('emits a stale badge counting uncommitted files when the tree has diverged', async () => {
    await mockGit(' M apps/api/src/server.js\n?? packages/mcp-server/src/freshness.ts\n');
    const fresh = computeFreshness(repo, new Date(Date.now() - 3 * 3600_000).toISOString());
    expect(fresh.uncommittedCount).toBe(2);
    expect(fresh.staleBadge).toContain('2 uncommitted files');
    expect(fresh.staleBadge).toContain('factor your latest');
    // Honest recency — written, not "active"
    expect(fresh.recency).toBe('written 3h ago');
  });

  it('singularizes the badge for a single changed file', async () => {
    await mockGit(' M apps/api/src/server.js\n');
    const fresh = computeFreshness(repo, new Date().toISOString());
    expect(fresh.staleBadge).toContain('1 uncommitted file ');
    expect(fresh.staleBadge).not.toContain('1 uncommitted files');
  });

  it('reports unknown write time when last_updated is missing', async () => {
    await mockGit('');
    const fresh = computeFreshness(repo, null);
    expect(fresh.recency).toBe('write time unknown');
  });

  it('recencyLine appends the HEAD sha when present', () => {
    expect(recencyLine({ uncommittedCount: 0, headSha: 'deadbee', recency: 'written 5m ago', staleBadge: null }))
      .toBe('written 5m ago · HEAD deadbee');
    expect(recencyLine({ uncommittedCount: 0, headSha: null, recency: 'written 5m ago', staleBadge: null }))
      .toBe('written 5m ago');
  });
});
