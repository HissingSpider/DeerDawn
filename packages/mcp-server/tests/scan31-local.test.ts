import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DeerdawnClient } from '../src/client.js';
import { handleContextSyncTool } from '../src/tools/context-sync.js';
import { forgetWriteTargets } from '../src/write-target.js';

/**
 * Scan 31, the local stdio parity copy of rule R2. PARITY with the hosted
 * dispatcher (apps/api/tests/integration/scan31-fixes.test.js, p6).
 *
 * Every project the dispatcher supplies is marked filed_by_default — the
 * scope:"project" ask included, with its scope kept beside the flag. Stamped
 * as a named project, that ask adopted the team's workspace-level node into
 * the caller's personal project (the store adopts only for a project the
 * entity itself names). A per-entity project_id and scope:"workspace" travel
 * exactly as given.
 */

let server: http.Server;
let client: DeerdawnClient;
let posted: any[] = [];
let reply: any = null;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (status: number, payload: any) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'POST' && req.url?.includes('/workspace/entities')) {
        const payload = JSON.parse(body || '{}');
        posted.push(...(payload.entities || []));
        return send(200, reply || { entities: payload.entities || [], relations: [] });
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
  reply = null;
  forgetWriteTargets();
});

afterAll(() => server?.close());

const note = { entity_type: 'service', title: 'Stripe billing', summary: 'Stripe handles all subscription billing for every app we ship.' };

describe('scan 31 (R2): a dispatcher-supplied project never reads as named', () => {
  it('marks the scope:"project" ask filed_by_default, scope kept; leaves named and workspace entities alone', async () => {
    await handleContextSyncTool('manage_memory', {
      action: 'upsert_entities',
      project_id: 'project_here',
      entities: [
        { ...note, title: 'Asked for the project', scope: 'project' },
        note,
        { ...note, title: 'Named elsewhere', project_id: 'project_other' },
        { ...note, title: 'For everybody', scope: 'workspace' },
      ],
    }, client);
    expect(posted.map((e) => [e.title, e.project_id, e.scope, e.filed_by_default])).toEqual([
      ['Asked for the project', 'project_here', 'project', true],
      ['Stripe billing', 'project_here', undefined, true],
      ['Named elsewhere', 'project_other', undefined, undefined],
      ['For everybody', undefined, 'workspace', undefined],
    ]);
  });
});
