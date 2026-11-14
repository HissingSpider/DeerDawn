import { AxiosError, AxiosHeaders } from 'axios';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DeerdawnClient } from '../src/client.js';
import { handleContextSyncTool, NO_PROJECT_FOR_ENTITIES } from '../src/tools/context-sync.js';
import { handleApiError, isActionableErrorCode } from '../src/utils/errors.js';
import { forgetWriteTargets } from '../src/write-target.js';

/**
 * Journey r5: where a tool's writes land, on the LOCAL dispatcher.
 *
 * 1. manage_memory(upsert_entities) with entities that name no project: filed in
 *    the directory's write target, the reply carries the server's note naming
 *    where they went, and with NO project (or only a guess) nothing is saved
 *    workspace-wide. scope:"workspace" is how a caller asks for it.
 * 3. The 409s a connection's dead binding earns surface their message: an
 *    archived project (project_archived) and one no longer shared
 *    (bound_project_unavailable) are both allow-listed, so this dispatcher
 *    says what the hosted one says.
 *
 * (2, a folder that belongs to another project than the one a session is bound
 * to, has no local path: the local server keeps no session binding, and the
 * directory IS its project. See the round-5 report.)
 */

let server: http.Server;
let client: DeerdawnClient;
let posted: any[] = [];
let activeAnswer: any = {};
let filedNote = ' Filed in "Here".';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (status: number, payload: any) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'GET' && req.url?.startsWith('/api/v1/context/active')) return send(200, activeAnswer);
      if (req.method === 'POST' && req.url?.includes('/workspace/entities')) {
        const payload = JSON.parse(body || '{}');
        posted.push(...(payload.entities || []));
        return send(200, { entities: payload.entities || [], relations: [], filed_note: filedNote });
      }
      return send(200, { ok: true });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  client = new DeerdawnClient({
    apiUrl: `http://127.0.0.1:${port}`, apiKey: 'dev-key', environment: 'sandbox',
    cacheEnabled: false, cacheTtlSeconds: 60, maxRetries: 1, retryBackoffMs: 10,
  } as any);
});

beforeEach(() => {
  posted = [];
  activeAnswer = {};
  filedNote = ' Filed in "Here".';
  forgetWriteTargets();
});

afterAll(() => server?.close());

const upsert = (args: any) => handleContextSyncTool('manage_memory', { action: 'upsert_entities', ...args }, client);
const note = { entity_type: 'service', title: 'Retry worker service', summary: 'Handles invoice export retries and records every failure.' };

describe('an entity naming no project (local)', () => {
  it('is filed in the directory\'s project, and the reply says where', async () => {
    activeAnswer = { project_id: 'project_here', project_name: 'Here', match_kind: 'path', write_target: true };
    const out = await upsert({ entities: [note] });
    expect(posted.map((e) => [e.project_id, e.filed_by_default])).toEqual([['project_here', true]]);
    expect(String(out.content[0].text)).toContain('Upserted 1 workspace entity. Filed in "Here".');
  });

  it('is REFUSED with no project to file under, and nothing is posted', async () => {
    await expect(upsert({ entities: [note] })).rejects.toThrow(NO_PROJECT_FOR_ENTITIES);
    expect(posted).toEqual([]);
  });

  it('is REFUSED on a guess, in the words every other write uses for one', async () => {
    activeAnswer = { project_id: 'project_guess', project_name: 'Api Notes', match_kind: 'name', write_target: false };
    await expect(upsert({ entities: [note] })).rejects.toThrow(/Nothing was saved.*closest match.*Api Notes.*a guess/s);
    expect(posted).toEqual([]);
  });

  it('scope:"workspace" is the explicit ask, and is never refused for having no project', async () => {
    await upsert({ entities: [{ ...note, scope: 'workspace' }] });
    expect(posted.map((e) => [e.project_id, e.scope])).toEqual([[undefined, 'workspace']]);
  });

  it('the refusal names how to pick a project and how to ask for the workspace', () => {
    expect(NO_PROJECT_FOR_ENTITIES).toMatch(/project_id/);
    expect(NO_PROJECT_FOR_ENTITIES).toMatch(/scope:"workspace"/);
  });
});

function apiError(status: number, data: unknown): AxiosError {
  const err = new AxiosError('Request failed with status code ' + status);
  err.response = { status, statusText: '', data, headers: new AxiosHeaders(), config: { headers: new AxiosHeaders() } } as AxiosError['response'];
  return err;
}

describe('a write refused because the connection\'s own project cannot take it', () => {
  const cases: Array<[string, string]> = [
    ['project_archived', 'project_archived: This connection is working in "Old" (project_1), which is archived, so nothing was saved. To keep working there, restore it: manage_projects with action "restore" and project_id "project_1".'],
    ['bound_project_unavailable', 'bound_project_unavailable: The project this connection was working in (project_1) is no longer shared with you, so nothing was saved. To work somewhere else, pass project_id or select one.'],
  ];
  for (const [code, message] of cases) {
    it(`${code}: the message reaches the caller and is allow-listed`, () => {
      expect(isActionableErrorCode(code)).toBe(true);
      expect(() => handleApiError(apiError(409, { error: code, message }))).toThrow(message);
    });
  }
});
