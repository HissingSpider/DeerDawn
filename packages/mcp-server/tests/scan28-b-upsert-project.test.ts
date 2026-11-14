import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DeerdawnClient } from '../src/client.js';
import { handleContextSyncTool } from '../src/tools/context-sync.js';
import { forgetWriteTargets } from '../src/write-target.js';

/**
 * Scan 28 (b): manage_memory(action:"upsert_entities") dropped its TOP-LEVEL
 * project_id. Only a per-entity project_id reached the server, whose default for
 * an entity with neither is WORKSPACE scope, so a member's personal note written
 * "into" their personal project was served to the whole team. Omitting it did not
 * use this directory's project either. PARITY with the hosted dispatcher
 * (apps/api/tests/integration/scan28-b-fixes.test.js).
 */

let server: http.Server;
let client: DeerdawnClient;
let posted: any[] = [];
let activeAnswer: any = {};
let upsertStatus = 200;

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
        if (upsertStatus !== 200) return send(upsertStatus, { error: 'project_not_found' });
        posted.push(...(payload.entities || []));
        return send(200, { entities: payload.entities || [], relations: [] });
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
  upsertStatus = 200;
  forgetWriteTargets();
});

afterAll(() => server?.close());

const upsert = (args: any) => handleContextSyncTool('manage_memory', { action: 'upsert_entities', ...args }, client);
const note = { entity_type: 'knowledge', title: 'Salary band for the Globex offer is 180k', summary: 'Recruiter said 180k base.' };

describe('manage_memory upsert_entities files into a project', () => {
  it('files entities with no project of their own under the top-level project_id', async () => {
    const out = await upsert({ project_id: 'project_mine', entities: [note, { ...note, title: 'Globex interview is on Tuesday', scope: 'project' }] });
    expect(String(out.content[0].text)).toContain('Upserted 2');
    // The working project travels as filed_by_default with no scope stamped
    // (scan 30): the server decides where a NEW entity goes from it. One saying
    // scope:"project" asks for that project: marked filed_by_default too, the
    // scope kept beside it, so it never adopts an existing node (scan 31).
    expect(posted.map((e) => [e.project_id, e.scope, e.filed_by_default])).toEqual([['project_mine', undefined, true], ['project_mine', 'project', true]]);
  });

  it('files them under this directory\'s write target when project_id is omitted', async () => {
    activeAnswer = { project_id: 'project_here', project_name: 'Here', match_kind: 'path', write_target: true };
    await upsert({ entities: [note] });
    expect(posted.map((e) => [e.project_id, e.scope, e.filed_by_default])).toEqual([['project_here', undefined, true]]);
  });

  it('refuses, rather than save workspace-wide, when no project is named and none is active (journey r5)', async () => {
    await expect(upsert({ entities: [note] })).rejects.toThrow(/Nothing was saved/);
    expect(posted).toEqual([]);
  });

  it('keeps a per-entity project_id and an explicit scope:"workspace" as given', async () => {
    await upsert({
      project_id: 'project_mine',
      entities: [{ ...note, project_id: 'project_other' }, { ...note, title: 'Staging lives in eu-west-2', scope: 'workspace' }],
    });
    expect(posted.map((e) => [e.project_id, e.scope])).toEqual([['project_other', undefined], [undefined, 'workspace']]);
  });

  it('says so, in words (the client\'s 404 mapping), when the named project is not one the caller can see', async () => {
    upsertStatus = 404;
    await expect(upsert({ project_id: 'project_hidden', entities: [note] }))
      .rejects.toThrow(/No project matches that reference/);
    expect(posted).toEqual([]);
  });
});
