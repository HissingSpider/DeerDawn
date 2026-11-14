import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DeerdawnClient } from '../src/client.js';
import { handleContextSyncTool } from '../src/tools/context-sync.js';
import { forgetWriteTargets } from '../src/write-target.js';

/**
 * Scan 30, the local stdio parity copies. PARITY with the hosted dispatcher
 * (apps/api/tests/integration/scan30-fixes.test.js).
 *
 *   1. manage_memory(upsert_entities) only says which project the caller is
 *      working in: an entity naming no project and no scope carries it as
 *      filed_by_default, with NO scope stamped (the server decides where a
 *      new entity goes). An entity saying scope:"project" with no project_id
 *      asks for that project, so it carries it as named, without the flag.
 *   2. A stored description the upsert did not replace is said in the reply
 *      (summaries_kept_note), as the hosted reply says it.
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

describe('scan 30 (1): the working project, and a caller asking for it', () => {
  // Scan 31: a scope:"project" ask is dispatcher-supplied too, so it carries
  // filed_by_default (with its scope): named, it adopted the team's node.
  it('marks a scope-less entity filed_by_default with no scope, and a scope:"project" one filed_by_default with its scope', async () => {
    await handleContextSyncTool('manage_memory', {
      action: 'upsert_entities',
      project_id: 'project_here',
      entities: [note, { ...note, title: 'Asked for the project', scope: 'project' }],
    }, client);
    expect(posted.map((e) => [e.project_id, e.scope, e.filed_by_default])).toEqual([
      ['project_here', undefined, true],
      ['project_here', 'project', true],
    ]);
  });
});

describe('scan 30 (2): a kept description is said', () => {
  it('appends the server\'s summaries_kept_note to the reply', async () => {
    reply = {
      entities: [{ ...note, node_id: 'n1' }],
      relations: [],
      summaries_kept: ['Stripe Billing'],
      summaries_kept_note: ' Kept the existing description of "Stripe Billing": a stored description is not replaced by an upsert, so the new summary was not saved.',
    };
    const out = await handleContextSyncTool('manage_memory', { action: 'upsert_entities', entities: [{ ...note, scope: 'workspace' }] }, client);
    const text = String((out as any)?.content?.[0]?.text ?? '');
    expect(text).toContain('Upserted 1 workspace entity.');
    expect(text).toContain('Kept the existing description of "Stripe Billing"');
  });
});
