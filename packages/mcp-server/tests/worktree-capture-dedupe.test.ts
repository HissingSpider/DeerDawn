/**
 * The worktree hook runs after every edit and again at every Stop. When a run
 * found no path that was NEW since the last snapshot, it reported every dirty
 * file again — so a session that touched two files and then talked for twenty
 * turns filed the same event twenty more times.
 *
 * Real git repo, real files; only the API client is a double.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureWorktreeChangeWithClient, primeWorktreeSnapshot } from '../src/worktree-capture.js';

describe('worktree events are not repeated when nothing new changed', () => {
  const ENV_KEYS = ['DEERDAWN_DIR', 'DEERDAWN_HOME_DIR'] as const;
  const original = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let tmp: string;
  let repo: string;
  let clock = Date.now();

  function client(projectId: string | null = 'p_1') {
    return {
      getActiveContextByCwd: vi.fn().mockResolvedValue(projectId ? { project_id: projectId, project_name: 'Atlas', match_kind: 'path' } : null),
      recordContextEvent: vi.fn().mockResolvedValue({ status: 'accepted' }),
    };
  }

  /** Write a file and move its mtime forward, so two writes never share a timestamp. */
  function edit(rel: string, content: string): void {
    const file = path.join(repo, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    clock += 5000;
    fs.utimesSync(file, new Date(clock), new Date(clock));
  }

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-wt-dedupe-')));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    process.env.DEERDAWN_DIR = path.join(tmp, 'deerdawn-home');
    delete process.env.DEERDAWN_HOME_DIR;
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'v1\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('a second run over an unchanged worktree records nothing — and asks the API nothing', async () => {
    const c = client();
    primeWorktreeSnapshot(repo);
    edit('tracked.txt', 'v2\n');
    edit('src/new.ts', 'export {};\n');

    const first = await captureWorktreeChangeWithClient(c as any, repo);
    expect(first.recorded).toBe(true);
    expect(c.recordContextEvent).toHaveBeenCalledTimes(1);

    // Stop, Stop, Stop: twenty turns of conversation, no edits.
    for (let i = 0; i < 5; i++) {
      const again = await captureWorktreeChangeWithClient(c as any, repo);
      expect(again.recorded).toBe(false);
    }
    expect(c.recordContextEvent).toHaveBeenCalledTimes(1);
    expect(c.getActiveContextByCwd).toHaveBeenCalledTimes(1);
  });

  it('a further edit to an already-dirty file IS new, and is recorded', async () => {
    const c = client();
    primeWorktreeSnapshot(repo);
    edit('tracked.txt', 'v2\n');
    await captureWorktreeChangeWithClient(c as any, repo);
    edit('tracked.txt', 'v3 with more in it\n');
    const second = await captureWorktreeChangeWithClient(c as any, repo);
    expect(second.recorded).toBe(true);
    expect(c.recordContextEvent).toHaveBeenCalledTimes(2);
  });

  it('a newly changed path is still reported on its own', async () => {
    const c = client();
    primeWorktreeSnapshot(repo);
    edit('tracked.txt', 'v2\n');
    await captureWorktreeChangeWithClient(c as any, repo);
    edit('docs/notes.md', '# notes\n');
    const second = await captureWorktreeChangeWithClient(c as any, repo);
    expect(second.changed_paths).toEqual(['docs/notes.md']);
  });

  it('a new session over the same unchanged worktree does not re-announce it', async () => {
    const c = client();
    primeWorktreeSnapshot(repo);
    edit('tracked.txt', 'v2\n');
    await captureWorktreeChangeWithClient(c as any, repo);

    primeWorktreeSnapshot(repo); // SessionStart of the next session
    const next = await captureWorktreeChangeWithClient(c as any, repo);
    expect(next.recorded).toBe(false);
    expect(c.recordContextEvent).toHaveBeenCalledTimes(1);
  });

  it('a change set that was never SENT is still news once the directory is linked', async () => {
    primeWorktreeSnapshot(repo);
    edit('tracked.txt', 'v2\n');
    const unlinked = client(null);
    expect((await captureWorktreeChangeWithClient(unlinked as any, repo)).recorded).toBe(false);

    const linked = client();
    const result = await captureWorktreeChangeWithClient(linked as any, repo);
    expect(result.recorded).toBe(true);
    expect(linked.recordContextEvent).toHaveBeenCalledTimes(1);
  });
});
