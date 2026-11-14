import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * TWO UNRELATED FOLDERS CALLED `app` SHARE A WORKSPACE KEY.
 *
 * A repo with no git remote is keyed `root:<basename>`. The server matches that
 * key by equality, so a project stamped from ~/work/app is a `workspace` match
 * in ~/personal/app, and a subproject pinned in one is `pinned` in the other —
 * both of which were write-grade. A save from the second folder went into the
 * first folder's project.
 *
 * The key is deliberately unchanged (the server holds projects and pins under
 * the old form and this client can send only one key per request; see
 * write-target.ts). What changes is that a match reached THROUGH such a key is
 * not a write target. These use two real repos with the same folder name.
 */

let home: string;
let work: string;
let personal: string;
let remoteRepo: string;
const saved: Record<string, string | undefined> = {};
let writeTarget: typeof import('../src/write-target.js');
let freshness: typeof import('../src/freshness.js');
let handleContextSyncTool: typeof import('../src/tools/context-sync.js').handleContextSyncTool;

function repoAt(parent: string, name: string, remote?: string): string {
  const dir = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), parent))), name);
  fs.mkdirSync(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  if (remote) execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
  return dir;
}

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-root-home-')));
  work = repoAt('dd-root-work-', 'app');
  personal = repoAt('dd-root-personal-', 'app');
  remoteRepo = repoAt('dd-root-remote-', 'app', 'https://github.com/acme/app.git');
  for (const key of ['HOME', 'USERPROFILE', 'DEERDAWN_HOME_DIR', 'CLAUDE_PROJECT_DIR']) saved[key] = process.env[key];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.DEERDAWN_HOME_DIR = home;
  vi.resetModules();
  writeTarget = await import('../src/write-target.js');
  freshness = await import('../src/freshness.js');
  ({ handleContextSyncTool } = await import('../src/tools/context-sync.js'));
});

beforeEach(() => writeTarget.forgetWriteTargets());

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of [home, path.dirname(work), path.dirname(personal), path.dirname(remoteRepo)]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** An API that, like the real one, matches the workspace key by equality. */
function apiWithProjectStampedFrom(stampedKey: string, kind: 'workspace' | 'pinned', extra: Record<string, unknown> = {}) {
  return {
    getActiveContextByCwd: vi.fn(async (cwd: string) => (
      freshness.getWorkspaceKey(cwd) === stampedKey
        ? { project_id: 'project_work_app', project_name: 'Work App', match_kind: kind, ...extra }
        : null
    )),
    pushContextUpdate: vi.fn().mockResolvedValue({ stored: true, project: { project_name: 'Work App' } }),
    recordContextEvent: vi.fn().mockResolvedValue({ ok: true }),
  };
}

describe('a workspace key that is only a folder name', () => {
  it('the premise: two unrelated local-only repos with one folder name share a key, which is left as it was', () => {
    expect(freshness.getWorkspaceKey(work)).toBe('root:app');
    expect(freshness.getWorkspaceKey(personal)).toBe('root:app');
    expect(freshness.getWorkspaceKey(remoteRepo)).toBe('remote:github.com/acme/app');
  });

  for (const kind of ['workspace', 'pinned'] as const) {
    it(`a ${kind} match reached through it is not a write target, even when the API says it is`, async () => {
      const api = apiWithProjectStampedFrom('root:app', kind, { match_confidence: 'high', write_target: true });
      const target = await writeTarget.resolveWriteTarget(api as any, personal, { nameTheGuess: true });
      expect(target).toMatchObject({ kind: 'guess', projectId: 'project_work_app', reason: 'folder_key' });
    });
  }

  it('a save from the OTHER folder called app is refused, and says why', async () => {
    process.env.CLAUDE_PROJECT_DIR = personal;
    const api = apiWithProjectStampedFrom('root:app', 'workspace');
    const result: any = await handleContextSyncTool('update_context', { summary: 'Personal note that must not reach work.' }, api as any);
    expect(api.pushContextUpdate).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(String(result.content[0].text)).toContain('no git remote');
    expect(String(result.content[0].text)).toContain('project_work_app');
  });

  it('a linked path in a local-only repo is still a write target: the key was never involved', async () => {
    const api = { getActiveContextByCwd: vi.fn().mockResolvedValue({ project_id: 'project_personal', project_name: 'Personal App', match_kind: 'path' }) };
    await expect(writeTarget.resolveWriteTarget(api as any, personal)).resolves.toMatchObject({ kind: 'target', projectId: 'project_personal' });
  });

  it('a repo WITH a remote keeps workspace and pinned matches write-grade', async () => {
    for (const kind of ['workspace', 'pinned'] as const) {
      const api = apiWithProjectStampedFrom('remote:github.com/acme/app', kind);
      await expect(writeTarget.resolveWriteTarget(api as any, remoteRepo)).resolves.toMatchObject({ kind: 'target', projectId: 'project_work_app' });
    }
  });

  it('what this process was told directly still works in a local-only repo', async () => {
    // Pinned here, by this process: not something inferred from the folder name.
    const api = apiWithProjectStampedFrom('root:app', 'pinned');
    writeTarget.rememberWriteTarget(work, 'project_work_app', 'Work App');
    await expect(writeTarget.resolveWriteTarget(api as any, work)).resolves.toMatchObject({ kind: 'target', projectId: 'project_work_app' });
    // ...and says nothing about the other folder.
    await expect(writeTarget.resolveWriteTarget(api as any, personal)).resolves.toMatchObject({ kind: 'guess' });
  });
});
