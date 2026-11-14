import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DeerdawnClient } from '../src/client.js';
import { handleContextSyncTool } from '../src/tools/context-sync.js';
import { forgetWriteTargets } from '../src/write-target.js';

/**
 * Scan 29, the local stdio parity copies. PARITY with the hosted dispatcher
 * (apps/api/tests/integration/scan29-fixes.test.js).
 *
 *   1. manage_memory(upsert_entities) files an entity naming no project under
 *      the top-level project_id or this directory's project, and says so on the
 *      wire (filed_by_default), so the server applies that project to a NEW
 *      entity only: an existing workspace node re-saved from a personal
 *      project was adopted into it and hidden from the team.
 *   2. A shown cut ("<opening>...") never resolves the OPEN decision sharing
 *      the opening because the one it was cut from is already resolved.
 */

let server: http.Server;
let client: DeerdawnClient;
let posted: any[] = [];
let activeAnswer: any = {};
let entities: any[] = [];

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
      if (req.method === 'POST' && /\/decisions\/resolve/.test(req.url || '')) {
        return send(200, { outcome: 'not_found', project_name: 'Test', candidates: [], message: 'No open decision in Test reads that, so nothing was resolved.' });
      }
      if (req.method === 'POST' && req.url?.includes('/workspace/entities')) {
        const payload = JSON.parse(body || '{}');
        posted.push(...(payload.entities || []));
        // Applied, so mark_resolved's read-back sees the real result.
        for (const e of payload.entities || []) {
          const row = entities.find((n) => n.canonical_key === e.canonical_key);
          if (row) row.metadata = { ...row.metadata, ...e.metadata };
        }
        return send(200, { entities: payload.entities || [], relations: [] });
      }
      if (req.url?.includes('/workspace/entities')) return send(200, { entities });
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
  entities = [];
  forgetWriteTargets();
});

afterAll(() => server?.close());

const note = { entity_type: 'knowledge', title: 'The staging cluster lives in eu-west-2', summary: 'Every team deploys staging there.' };

describe('scan 29 (1): a defaulted project is marked as one', () => {
  it('marks entities filed under the top-level project_id or the directory\'s project, and no other', async () => {
    await handleContextSyncTool('manage_memory', {
      action: 'upsert_entities',
      project_id: 'project_mine',
      entities: [note, { ...note, title: 'Own project entity', project_id: 'project_named' }, { ...note, title: 'Team entity', scope: 'workspace' }],
    }, client);
    expect(posted.map((e) => [e.project_id, e.scope, e.filed_by_default])).toEqual([
      // No scope stamped (scan 30): the working project is the server's to
      // apply, and an old client's scope:"project" beside the flag is ignored.
      ['project_mine', undefined, true],
      ['project_named', undefined, undefined],
      [undefined, 'workspace', undefined],
    ]);
    posted = [];
    activeAnswer = { project_id: 'project_here', project_name: 'Here', match_kind: 'path', write_target: true };
    await handleContextSyncTool('manage_memory', { action: 'upsert_entities', entities: [note] }, client);
    expect(posted.map((e) => [e.project_id, e.filed_by_default])).toEqual([['project_here', true]]);
  });
});

describe('scan 29 (2): a shown cut and a resolved sibling', () => {
  const opening = 'Route every outbound webhook through the shared delivery queue';
  const X = `${opening} in staging only.`;
  const Y = `${opening} in production too.`;
  const node = (id: string, text: string, status: string) => ({
    node_id: id, node_type: 'decision', title: text, summary: text,
    canonical_key: `decision:${id}`, project_id: 'project_test', metadata: { entity_type: 'decision', status },
  });
  const resolve = async (title: string) => String(((await handleContextSyncTool('mark_resolved', { title, project_id: 'project_test' }, client)) as any)?.content?.[0]?.text ?? '');

  it('refuses when the cut also opens a resolved decision, naming both', async () => {
    entities = [node('x', X, 'resolved'), node('y', Y, 'active')];
    const out = await resolve(`${opening}...`);
    expect(posted).toHaveLength(0);
    expect(out).not.toContain('Marked resolved');
    expect(out).toContain('nothing was resolved');
    expect(out).toContain(X);
    expect(out).toContain(Y);
    expect(out).toMatch(/in staging only\.".*already resolved/);
  });

  it('still resolves the one decision it opens, and says a lone resolved one is done', async () => {
    entities = [node('y', Y, 'active')];
    expect(await resolve(`${opening}...`)).toContain('Marked resolved');
    posted = [];
    entities = [node('x', X, 'resolved')];
    const out = await resolve(`${opening}...`);
    expect(posted).toHaveLength(0);
    expect(out).toContain('already resolved');
  });
});
