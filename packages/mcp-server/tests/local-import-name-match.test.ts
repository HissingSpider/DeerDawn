import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AxiosError, AxiosHeaders } from 'axios';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE LOCAL IMPORT AND THE SERVER DISAGREED ABOUT WHICH NAMES ARE THE SAME.
 *
 * importLocalContextFile looked for an existing project by exact lowercase name.
 * The server's duplicate gate compares NORMALISED names. So a CLAUDE.md headed
 * "Acme Platform" did not find the project called "acme-platform", tried to
 * create it, was refused as a duplicate, retried the identical request from its
 * own catch block, and failed: an import that died with a 409 about a project it
 * had just failed to notice (or, against rows that predate the gate, made the
 * near-duplicate beside it).
 *
 * HOME and the import ledger are temp dirs, set before the modules load.
 */

const CLAUDE_MD = [
  '# Acme Platform',
  '',
  'Current task: Ship the ingest rewrite',
  'Tech stack:',
  '- TypeScript',
  '',
  'Acme replaced the batch importer with a streaming one last quarter, and the remaining work is',
  'mostly about draining the old queue without dropping partially-written rows on the floor.',
].join('\n');

let home: string;
const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};
let handleContextSyncTool: typeof import('../src/tools/context-sync.js').handleContextSyncTool;
let writeTarget: typeof import('../src/write-target.js');

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-import-home-')));
  for (const key of ['HOME', 'USERPROFILE', 'DEERDAWN_HOME', 'DEERDAWN_HOME_DIR', 'CLAUDE_PROJECT_DIR']) saved[key] = process.env[key];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.DEERDAWN_HOME = path.join(home, '.deerdawn');
  process.env.DEERDAWN_HOME_DIR = home;
  vi.resetModules();
  ({ handleContextSyncTool } = await import('../src/tools/context-sync.js'));
  writeTarget = await import('../src/write-target.js');
});

beforeEach(() => writeTarget.forgetWriteTargets());

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of [home, ...dirs]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function workspace(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-import-ws-')));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), CLAUDE_MD, 'utf8');
  process.env.CLAUDE_PROJECT_DIR = dir;
  return dir;
}

function duplicateNameError(existingId?: string): AxiosError {
  const err = new AxiosError('Request failed with status code 409');
  err.response = {
    status: 409,
    statusText: 'Conflict',
    data: { error: 'duplicate_project_name', message: 'duplicate_project_name: already exists', ...(existingId ? { existing_project_id: existingId } : {}) },
    headers: new AxiosHeaders(),
    config: { headers: new AxiosHeaders() },
  } as AxiosError['response'];
  return err;
}

function makeClient(projects: any[], overrides: Record<string, any> = {}) {
  return {
    listContextProjects: vi.fn().mockResolvedValue({ projects }),
    // The server's gate: what it would do with a name it considers taken.
    createContextProject: vi.fn().mockRejectedValue(duplicateNameError()),
    getContextJson: vi.fn().mockResolvedValue({ project_id: 'project_acme', project_name: 'acme-platform' }),
    patchProjectContext: vi.fn().mockResolvedValue({ ok: true }),
    updateGlobalContext: vi.fn().mockResolvedValue({ ok: true }),
    pushContextUpdate: vi.fn().mockResolvedValue({ ok: true }),
    recordContextEvent: vi.fn().mockResolvedValue(null),
    recordProductEvent: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

const importNow = (client: any) =>
  handleContextSyncTool('manage_memory', { action: 'import_local', confirmed: true }, client);

describe('the local import finds the project the server would call a duplicate', () => {
  it('fills "acme-platform" from a file headed "Acme Platform" instead of trying to create it', async () => {
    workspace();
    const client = makeClient([{ project_id: 'project_acme', project_name: 'acme-platform' }]);
    const result = await importNow(client);
    expect(client.createContextProject).not.toHaveBeenCalled();
    expect(client.patchProjectContext.mock.calls[0][0]).toBe('project_acme');
    expect(String(result.content[0].text)).toContain('acme-platform');
  });

  it('finds it when it is a subproject nested under its umbrella', async () => {
    workspace();
    const client = makeClient([{ project_id: 'project_umbrella', project_name: 'Acme', subprojects: [{ project_id: 'project_acme', project_name: 'ACME_PLATFORM' }] }]);
    await importNow(client);
    expect(client.createContextProject).not.toHaveBeenCalled();
    expect(client.patchProjectContext.mock.calls[0][0]).toBe('project_acme');
  });

  it('an exact spelling still wins among several that normalise alike', async () => {
    workspace();
    const client = makeClient([
      { project_id: 'project_dashed', project_name: 'acme-platform' },
      { project_id: 'project_exact', project_name: 'acme platform' },
    ]);
    await importNow(client);
    expect(client.patchProjectContext.mock.calls[0][0]).toBe('project_exact');
  });

  it('does not treat a different project as the same one', async () => {
    workspace();
    const client = makeClient(
      [{ project_id: 'project_other', project_name: 'Acme Platform API' }],
      { createContextProject: vi.fn().mockResolvedValue({ project: { project_id: 'project_new', project_name: 'Acme Platform' } }) },
    );
    await importNow(client);
    expect(client.createContextProject).toHaveBeenCalledTimes(1);
    expect(client.patchProjectContext.mock.calls[0][0]).toBe('project_new');
  });

  it('when the list could not be read, the server\'s own duplicate answer names the project to fill', async () => {
    workspace();
    const client = makeClient([], {
      listContextProjects: vi.fn().mockRejectedValue(new Error('timeout')),
      createContextProject: vi.fn().mockRejectedValue(duplicateNameError('project_acme')),
    });
    await importNow(client);
    // Asked once. The old catch block repeated the identical request.
    expect(client.createContextProject).toHaveBeenCalledTimes(1);
    expect(client.patchProjectContext.mock.calls[0][0]).toBe('project_acme');
  });
});
