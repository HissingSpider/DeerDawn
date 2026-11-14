import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nock from 'nock';
import { AxiosError, AxiosHeaders } from 'axios';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SCAN 17 — MEDIUMS (A): THE LOCAL HALF.
 *
 *   2. manage_memory update with a commands[].run over the API's cap replied
 *      "+ 2 commands stored" and stored NONE: the PATCH is refused whole
 *      (400 field_too_long), the client swallowed it, and the reply counted the
 *      request.
 *   3. import_local with one over-long "Description:"/"Task:" line in CLAUDE.md
 *      failed with "Invalid request parameters" and left an empty project; a
 *      >4,000-character task read "Request failed with status code 400".
 *   4. upsert_entities: relations whose endpoint did not resolve (and skipped
 *      entities) were counted out in silence on the local connector.
 *
 * HOME is a temp dir, set before the modules load (the import writes a ledger).
 */

const base = 'http://localhost:19998';
let home: string;
const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};
let handleContextSyncTool: typeof import('../src/tools/context-sync.js').handleContextSyncTool;
let DeerdawnClient: typeof import('../src/client.js').DeerdawnClient;
let isActionableErrorCode: typeof import('../src/utils/errors.js').isActionableErrorCode;
let writeTarget: typeof import('../src/write-target.js');

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-scan17-home-')));
  for (const key of ['HOME', 'USERPROFILE', 'DEERDAWN_HOME', 'DEERDAWN_HOME_DIR', 'CLAUDE_PROJECT_DIR']) saved[key] = process.env[key];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.DEERDAWN_HOME = path.join(home, '.deerdawn');
  process.env.DEERDAWN_HOME_DIR = home;
  vi.resetModules();
  ({ handleContextSyncTool } = await import('../src/tools/context-sync.js'));
  ({ DeerdawnClient } = await import('../src/client.js'));
  ({ isActionableErrorCode } = await import('../src/utils/errors.js'));
  writeTarget = await import('../src/write-target.js');
});

beforeEach(() => writeTarget.forgetWriteTargets());
afterEach(() => { nock.cleanAll(); });

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of [home, ...dirs]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function apiError(status: number, data: unknown): AxiosError {
  const err = new AxiosError(`Request failed with status code ${status}`);
  err.response = {
    status,
    statusText: '',
    data,
    headers: new AxiosHeaders(),
    config: { headers: new AxiosHeaders() },
  } as AxiosError['response'];
  return err;
}

// What the API's PATCH /:id/context does with any value over 4,000 characters.
const TOO_LONG = (field: string, length: number) => apiError(400, {
  error: 'field_too_long',
  field,
  length,
  max_length: 4000,
  message: `${field} holds a value of ${length} characters; the limit is 4000. Nothing was saved — shorten it and resend.`,
});

function realClient() {
  return new DeerdawnClient({
    apiUrl: base,
    apiKey: 'dd_sandbox_abcdefghijklmnopqrstuvwxyz0123456789',
    environment: 'sandbox',
    cacheEnabled: false,
    cacheTtlSeconds: 60,
    maxRetries: 0,
    retryBackoffMs: 100,
  } as any);
}

// ── 2 ────────────────────────────────────────────────────────────────────────

describe('2: commands are reported from what was stored, not from what was asked', () => {
  it('the client returns the refused PATCH with the API\'s reason instead of swallowing it', async () => {
    nock(base).post('/api/v1/context/extraction').reply(202, { project: { project_id: 'p1', context: { commands: [] } } });
    nock(base).patch('/api/v1/context/p1/context').reply(400, TOO_LONG('commands', 4500).response!.data as any);
    const result = await realClient().pushContextUpdate('p1', 'Wired the deploy script', 'claude_code', [
      { label: 'deploy', run: 'x'.repeat(4500) },
      { label: 'test', run: 'npm test' },
    ]);
    expect(result.project.project_id).toBe('p1');
    expect(result.commands_outcome).toEqual({
      requested: 2,
      stored: false,
      error: expect.stringContaining('the limit is 4000'),
    });
  });

  it('and says stored when the PATCH landed', async () => {
    nock(base).post('/api/v1/context/extraction').reply(202, { project: { project_id: 'p1' } });
    nock(base).patch('/api/v1/context/p1/context').reply(200, { ok: true });
    const result = await realClient().pushContextUpdate('p1', 'Wired the tests', 'claude_code', [{ label: 'test', run: 'npm test' }]);
    expect(result.commands_outcome).toEqual({ requested: 1, stored: true });
  });

  it('the reply names a refused commands write, and never says "stored" over it', async () => {
    const client = {
      pushContextUpdate: vi.fn().mockResolvedValue({
        project: { project_name: 'Atlas' },
        extraction: { delta: {} },
        stored: true,
        commands_outcome: { requested: 2, stored: false, error: 'commands holds a value of 4500 characters; the limit is 4000. Nothing was saved — shorten it and resend.' },
      }),
      recordContextEvent: vi.fn(),
    } as any;
    const result = await handleContextSyncTool('manage_memory', {
      action: 'update',
      project_id: 'p1',
      summary: 'Wired the deploy script',
      commands: [{ label: 'deploy', run: 'make deploy' }, { label: 'test', run: 'npm test' }],
    }, client) as any;
    const text = String(result.content[0].text);
    expect(text).not.toContain('commands stored');
    expect(text).toContain('2 commands NOT stored');
    expect(text).toContain('the limit is 4000');
  });

  it('a run over the hosted 2,000-character limit is refused before anything is written', async () => {
    const client = { pushContextUpdate: vi.fn(), patchProjectContext: vi.fn(), recordContextEvent: vi.fn() } as any;
    const result = await handleContextSyncTool('manage_memory', {
      action: 'update',
      project_id: 'p1',
      summary: 'Wired the deploy script',
      commands: [{ label: 'deploy', run: 'y'.repeat(2001) }],
    }, client) as any;
    expect(result.isError).toBe(true);
    expect(String(result.content[0].text)).toMatch(/Nothing was saved: command "deploy" has a run of 2001 characters, and the limit is 2000/);
    expect(client.pushContextUpdate).not.toHaveBeenCalled();
  });
});

// ── 3 ────────────────────────────────────────────────────────────────────────

function workspaceWith(claudeMd: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-scan17-ws-')));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), claudeMd, 'utf8');
  process.env.CLAUDE_PROJECT_DIR = dir;
  return dir;
}

function collectStrings(value: any): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(collectStrings);
  return [];
}

describe('3: one over-long CLAUDE.md line no longer sinks the import', () => {
  it('clips the field to the API cap, imports the rest, and says so', async () => {
    workspaceWith([
      '# Longline Project',
      '',
      `Description: ${'Payments orchestration and settlement. '.repeat(150)}`,
      'Current task: Ship the ingest rewrite',
      'Tech stack:',
      '- TypeScript',
    ].join('\n'));
    const patchProjectContext = vi.fn(async (_id: string, patch: any) => {
      const long = collectStrings(patch).find((text) => text.length > 4000);
      if (long) throw TOO_LONG('description', long.length);
      return { ok: true };
    });
    const client = {
      listContextProjects: vi.fn().mockResolvedValue({ projects: [] }),
      createContextProject: vi.fn().mockResolvedValue({ project: { project_id: 'project_new', project_name: 'Longline Project' } }),
      getContextJson: vi.fn().mockResolvedValue(null),
      patchProjectContext,
      updateGlobalContext: vi.fn().mockResolvedValue({ ok: true }),
      pushContextUpdate: vi.fn().mockResolvedValue({ ok: true }),
      recordContextEvent: vi.fn().mockResolvedValue(null),
      recordProductEvent: vi.fn().mockResolvedValue({}),
    };
    const result = await handleContextSyncTool('manage_memory', { action: 'import_local', confirmed: true }, client as any) as any;
    const text = String(result.content[0].text);
    expect(result.isError).toBeFalsy();
    expect(text).toContain('Imported "Longline Project"');
    expect(text).toMatch(/Clipped to the brief's 4000-character limit per value: description/);
    const sent = patchProjectContext.mock.calls[0][1] as any;
    expect(sent.description.length).toBe(4000);
    expect(sent.description.endsWith('…')).toBe(true);
    expect(sent.current_task).toBe('Ship the ingest rewrite');
  });

  it('field_too_long is relayed: an over-long task names the limit, not "status code 400"', async () => {
    expect(isActionableErrorCode('field_too_long')).toBe(true);
    const task = 'z'.repeat(4100);
    const client = {
      patchProjectContext: vi.fn().mockRejectedValue(TOO_LONG('current_task', 4100)),
      getContextJson: vi.fn(),
      pushContextUpdate: vi.fn(),
      recordContextEvent: vi.fn(),
    } as any;
    const result = await handleContextSyncTool('manage_memory', { action: 'update', project_id: 'p1', task }, client) as any;
    const text = String(result.content[0].text);
    expect(text).toContain('Current task NOT changed — current_task holds a value of 4100 characters; the limit is 4000');
    expect(text).not.toContain('status code 400');
  });
});

// ── 4 ────────────────────────────────────────────────────────────────────────

describe('4: the local upsert_entities reply names what it did not record', () => {
  it('lists unresolved relation keys and skipped entities', async () => {
    const client = {
      upsertWorkspaceEntities: vi.fn().mockResolvedValue({
        entities: [{ node_id: 'n1' }],
        relations: [],
        skipped: [{ title: 'Orion', reason: 'workspace_entity_project_ambiguous', message: 'more than one project you can see is named "Orion"' }],
        unresolved_relations: [
          { from_canonical_key: 'service:ledger', to_canonical_key: 'project:atlas', relation_type: 'part_of', unresolved: [{ key: 'project:atlas', reason: 'ambiguous_project_name' }] },
          { from_canonical_key: 'service:ledger', to_canonical_key: 'service:ghost', relation_type: 'depends_on', unresolved: [{ key: 'service:ghost', reason: 'not_found' }] },
        ],
      }),
    } as any;
    const result = await handleContextSyncTool('manage_memory', {
      action: 'upsert_entities',
      // A project to file under (journey r5): with none, an entity that names no
      // project is refused rather than saved workspace-wide. This test is about
      // the reply's account of what was skipped, not about where entities go.
      project_id: 'project_ledger',
      entities: [{ title: 'Ledger', entity_type: 'service', summary: 'Double-entry ledger that books every payout' }, { title: 'Orion', entity_type: 'project' }],
      relations: [
        { from_canonical_key: 'service:ledger', to_canonical_key: 'project:atlas', relation_type: 'part_of' },
        { from_canonical_key: 'service:ledger', to_canonical_key: 'service:ghost', relation_type: 'depends_on' },
      ],
    }, client) as any;
    const text = String(result.content[0].text);
    expect(text).toContain('Upserted 1 workspace entity.');
    expect(text).toContain('Skipped 1: "Orion"');
    expect(text).toContain('Did not record 2 relations');
    expect(text).toContain('project:atlas: more than one project you can see has this name; use project:<project_id>');
    expect(text).toContain('service:ghost: no such entity you can see');
  });
});
