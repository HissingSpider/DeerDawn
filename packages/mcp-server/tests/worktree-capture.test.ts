import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildFileChangeSummary,
  captureWorktreeChangeWithClient,
  diffChangedPaths,
  parseGitStatusPorcelain,
  primeWorktreeSnapshot,
  readSnapshot,
} from '../src/worktree-capture.js';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

describe('worktree capture', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-worktree-'));
    process.env.DEERDAWN_HOME_DIR = tempHome;
  });

  afterEach(() => {
    delete process.env.DEERDAWN_HOME_DIR;
    vi.restoreAllMocks();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('parses git porcelain output into normalized paths', () => {
    const parsed = parseGitStatusPorcelain([
      ' M apps/api/src/server.js',
      '?? packages/mcp-server/src/new-file.ts',
      'R  old-name.ts -> src/new-name.ts',
    ].join('\n'));

    expect(parsed).toEqual([
      'apps/api/src/server.js',
      'packages/mcp-server/src/new-file.ts',
      'src/new-name.ts',
    ]);
  });

  it('diffs newly changed paths against the previous snapshot', () => {
    expect(diffChangedPaths(['a.ts', 'b.ts'], ['a.ts', 'b.ts', 'c.ts'])).toEqual(['c.ts']);
  });

  it('records only newly introduced changed paths after snapshot priming', async () => {
    const { execFileSync } = await import('child_process');
    vi.mocked(execFileSync)
      .mockReturnValueOnce(' M apps/api/src/server.js\n' as never)
      .mockReturnValueOnce(' M apps/api/src/server.js\n?? packages/mcp-server/src/worktree-capture.ts\n' as never);

    const cwd = tempHome;
    fs.mkdirSync(path.join(cwd, '.git'));

    primeWorktreeSnapshot(cwd);
    const snapshot = readSnapshot(cwd);
    expect(snapshot?.files).toEqual(['apps/api/src/server.js']);

    const getActiveContextByCwd = vi.fn().mockResolvedValue({
      project_id: 'project_123',
      project_name: 'DeerDawn',
      match_kind: 'path',
    });
    const recordContextEvent = vi.fn().mockResolvedValue({ status: 'accepted' });

    const result = await captureWorktreeChangeWithClient(
      { getActiveContextByCwd, recordContextEvent } as any,
      cwd,
      'claude_code'
    );

    expect(result.recorded).toBe(true);
    expect(result.changed_paths).toEqual(['packages/mcp-server/src/worktree-capture.ts']);
    expect(recordContextEvent).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'file_changed',
      project_id: 'project_123',
      metadata: expect.objectContaining({
        paths: ['packages/mcp-server/src/worktree-capture.ts'],
      }),
    }));
  });

  it('builds a compact file-change summary', () => {
    expect(buildFileChangeSummary('DeerDawn', ['a.ts', 'b.ts'])).toContain('Detected file changes for DeerDawn: a.ts, b.ts');
  });
});
