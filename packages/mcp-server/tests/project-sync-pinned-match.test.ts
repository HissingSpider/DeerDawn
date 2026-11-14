import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Pinning a subproject deleted the repo's on-disk brief.
 *
 * The client sends workspace_key on every /active call, so once a user runs
 * switch_subproject in a repo the server answers every resolve there with
 * match_kind 'pinned' — never 'path' again. syncProjectFiles accepted only
 * 'path'. It did not just skip the write for anything else: a non-match in a
 * directory it had written before is treated as a STALE brief and stripped. So
 * the first sync after a pin removed .deerdawn-context.md and the DeerDawn
 * blocks, logged "directory no longer linked to a project", and every tool that
 * reads those files (Cursor, Codex, Copilot) lost its pointer to the project.
 * 'workspace' — the project carries this repo's own key — had the same fate.
 *
 * The guesses ('name', 'recency_fallback') must stay rejected: writing one to
 * disk is how an unrelated directory got a confident brief for the wrong project.
 */

const BRIEF = 'Project: Atlas API\nCurrent task: ship the queue';

function clientAnswering(matchKind: string, projectName = 'Atlas API') {
  return {
    getActiveContextByCwd: vi.fn().mockResolvedValue({
      brief: BRIEF,
      project_name: projectName,
      project_id: `proj-${matchKind}`,
      match_kind: matchKind,
      last_updated: '2026-09-19T00:00:00.000Z',
      context: { tech_stack: [] },
    }),
    patchProjectContext: vi.fn().mockResolvedValue(undefined),
    upsertWorkspaceEntities: vi.fn().mockResolvedValue(undefined),
    listSkills: vi.fn().mockResolvedValue({ skills: [] }),
  } as any;
}

describe('syncProjectFiles and the location match kinds', () => {
  let root: string;
  let homeBackup: string | undefined;
  let syncProjectFiles: typeof import('../src/project-sync.js').syncProjectFiles;

  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-pinned-sync-')));
    fs.mkdirSync(path.join(root, '.git'));
    homeBackup = process.env.HOME;
    process.env.HOME = root;
    // The manifest path is captured at module load; load AFTER HOME is sandboxed.
    vi.resetModules();
    ({ syncProjectFiles } = await import('../src/project-sync.js'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (homeBackup === undefined) delete process.env.HOME; else process.env.HOME = homeBackup;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const contextFile = () => path.join(root, '.deerdawn-context.md');

  it('keeps the on-disk brief when the repo’s project becomes a pinned subproject', async () => {
    // Session one: an ordinary linked-path match writes the brief.
    expect(await syncProjectFiles(clientAnswering('path', 'Atlas'), root, undefined, { tools: ['claude_code', 'codex', 'cursor', 'copilot'] })).toBe('Atlas');
    expect(fs.existsSync(contextFile())).toBe(true);

    // The user pins a subproject. Every later resolve is 'pinned'.
    const name = await syncProjectFiles(clientAnswering('pinned'), root, undefined, { tools: ['claude_code', 'codex', 'cursor', 'copilot'] });

    expect(name, 'a pin is the strongest "I am working here" there is').toBe('Atlas API');
    expect(fs.existsSync(contextFile()), 'the brief must not be stripped as stale').toBe(true);
    expect(fs.readFileSync(contextFile(), 'utf8')).toContain('Project: Atlas API');
    expect(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toContain('Atlas API');
  });

  it('writes a brief for a repo matched by its workspace key', async () => {
    expect(await syncProjectFiles(clientAnswering('workspace'), root, undefined, { tools: ['claude_code', 'codex', 'cursor', 'copilot'] })).toBe('Atlas API');
    expect(fs.readFileSync(contextFile(), 'utf8')).toContain('Project: Atlas API');
  });

  it.each(['name', 'recency_fallback', 'session'])('still refuses to write a %s guess to disk', async (kind) => {
    expect(await syncProjectFiles(clientAnswering(kind), root)).toBeNull();
    expect(fs.existsSync(contextFile())).toBe(false);
  });

  it('still cleans up a brief once the directory only matches by a guess', async () => {
    await syncProjectFiles(clientAnswering('path', 'Atlas'), root, undefined, { tools: ['claude_code', 'codex', 'cursor', 'copilot'] });
    expect(fs.existsSync(contextFile())).toBe(true);

    expect(await syncProjectFiles(clientAnswering('recency_fallback'), root)).toBeNull();
    expect(fs.existsSync(contextFile())).toBe(false);
  });
});
