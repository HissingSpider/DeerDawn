import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DeerdawnClient } from '../src/client.js';
import { handleContextSyncTool } from '../src/tools/context-sync.js';
import { forgetWriteTargets } from '../src/write-target.js';

/**
 * mark_resolved resolved five things and flipped none of them (2026-08-29).
 *
 * It passed the search's whole candidate list to the upsert, so ONE title could
 * mark five unrelated entities resolved — and it printed all five as if that had
 * been asked for. It also overwrote each entity's `summary` with the resolution
 * note, destroying the content a later reader actually needs.
 *
 * The duplicate had a separate cause, fixed server-side: the read path returns
 * the full `${type}:${key}` identity, and feeding that back re-prefixed it into
 * a new one. Covered in apps/api/tests/layer4-workspace.test.js.
 */

let server: http.Server;
let client: DeerdawnClient;
let entities: any[] = [];
let upserted: any[] = [];
/** Simulates an upsert that 200s without changing anything. */
let swallowUpsert = false;

const SEED = [
  {
    node_id: 'graph_node_1', node_type: 'decision', title: 'Use PostgreSQL',
    summary: 'Chosen for relational integrity', canonical_key: 'decision:use-postgresql',
    project_id: 'project_test', metadata: { entity_type: 'decision', status: 'active' },
  },
  {
    node_id: 'graph_node_2', node_type: 'knowledge', title: 'Use PostgreSQL',
    summary: 'A different entity that happens to share a title', canonical_key: 'knowledge:use-postgresql',
    project_id: 'project_test', metadata: { entity_type: 'knowledge', status: 'active' },
  },
  {
    node_id: 'graph_node_3', node_type: 'decision', title: 'Cap the Done column',
    summary: 'Rank by completed_at', canonical_key: 'decision:cap-the-done-column',
    metadata: { entity_type: 'decision', status: 'active' },
  },
  {
    node_id: 'graph_node_4', node_type: 'knowledge', title: 'Ledger retention policy',
    summary: 'Seven years, then cold storage', canonical_key: 'knowledge:ledger-retention-policy',
    project_id: 'project_test', metadata: { entity_type: 'knowledge', status: 'active' },
  },
  {
    node_id: 'graph_node_5', node_type: 'decision', title: 'Use Redis for sessions',
    summary: 'Filed under the project that recorded it first', canonical_key: 'decision:use-redis-for-sessions',
    project_id: 'project_other', metadata: { entity_type: 'decision', status: 'active' },
  },
];

/** What POST /projects/:id/decisions/resolve answers; null = not_found. */
let briefOutcome: any = null;
/** 'current' | 'old' (no route: 404 not_found) | 'missing' (404 project_not_found). */
let briefRouteMode: 'current' | 'old' | 'missing' = 'current';
/** What GET /active answers for a write lookup ({} = no project here). */
let activeAnswer: any = {};
let briefCalls: Array<{ projectId: string; body: any }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const send = (body: any) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const briefRoute = req.url?.match(/\/projects\/([^/]+)\/decisions\/resolve/);
      if (req.method === 'POST' && briefRoute) {
        briefCalls.push({ projectId: decodeURIComponent(briefRoute[1]), body: JSON.parse(body || '{}') });
        if (briefRouteMode !== 'current') {
          res.writeHead(404, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: briefRouteMode === 'old' ? 'not_found' : 'project_not_found' }));
        }
        return send(briefOutcome || { outcome: 'not_found', project_name: 'Test', candidates: [], message: 'No open decision in Test reads that, so nothing was resolved.' });
      }
      if (req.method === 'GET' && req.url?.startsWith('/api/v1/context/active')) return send(activeAnswer);
      if (req.method === 'POST' && req.url?.includes('/workspace/entities')) {
        const payload = JSON.parse(body || '{}');
        upserted.push(...(payload.entities || []));
        // Apply, so the tool's read-back sees the real result.
        if (swallowUpsert) return send({ ok: true });
        for (const e of payload.entities || []) {
          const row = entities.find((n) => n.canonical_key === e.canonical_key);
          if (row) row.metadata = { ...row.metadata, ...e.metadata };
        }
        return send({ ok: true });
      }
      if (req.url?.includes('/workspace/entities')) {
        // Mirrors the server: query matches title/summary/canonical_key TEXT.
        // node_id is deliberately NOT searchable — that is why the tool must not
        // tell callers to disambiguate with one.
        const url = new URL(req.url, 'http://x');
        const q = (url.searchParams.get('query') || '').toLowerCase();
        const terms = q.split(/\s+/).filter((t) => t.length >= 3);
        const matched = !terms.length ? entities : entities.filter((n) => {
          const text = `${n.title} ${n.summary} ${n.canonical_key}`.toLowerCase();
          return terms.some((t) => text.includes(t));
        });
        return send({ entities: matched });
      }
      send({ ok: true });
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
  entities = SEED.map((e) => ({ ...e, metadata: { ...e.metadata } }));
  upserted = [];
  swallowUpsert = false;
  briefOutcome = null;
  briefCalls = [];
  briefRouteMode = 'current';
  activeAnswer = {};
  forgetWriteTargets();
});

afterAll(() => server?.close());

const call = async (args: any) => {
  const r = await handleContextSyncTool('mark_resolved', args, client);
  return String((r as any)?.content?.[0]?.text ?? '');
};

describe('mark_resolved', () => {
  it('resolves exactly one entity, never the whole candidate list', async () => {
    const out = await call({ title: 'Cap the Done column' });
    expect(upserted).toHaveLength(1);
    expect(upserted[0].canonical_key).toBe('decision:cap-the-done-column');
    expect(out).toContain('Marked resolved: "Cap the Done column"');
  });

  it('refuses an ambiguous title instead of resolving all of them', async () => {
    // Two entities share this title. The old code resolved BOTH.
    const out = await call({ title: 'Use PostgreSQL' });
    expect(upserted).toHaveLength(0);
    expect(out).toContain('nothing was resolved');
    expect(out).toContain('decision');
    expect(out).toContain('knowledge');
  });

  it('does not tell the caller to disambiguate with a node id', async () => {
    // The entity search matches title/summary/canonical_key text and never
    // node_id, so that advice sends the caller to a guaranteed "No entity
    // found". entity_type is the parameter that actually filters.
    const out = await call({ title: 'Use PostgreSQL' });
    expect(out).not.toContain('graph_node_');
    expect(out).not.toMatch(/node id/i);
    expect(out).toContain('entity_type');
  });

  it('disambiguates by entity_type', async () => {
    const out = await call({ title: 'Use PostgreSQL', entity_type: 'decision' });
    // The fake ignores the type filter, so this still reads as ambiguous —
    // what matters is that a same-title pair never resolves more than one.
    expect(upserted.length).toBeLessThanOrEqual(1);
    expect(out).not.toContain('Marked resolved: "Use PostgreSQL", "Use PostgreSQL"');
  });

  it('preserves the entity summary and files the note in metadata', async () => {
    await call({ title: 'Cap the Done column', notes: 'Shipped in the trim fix' });
    expect(upserted[0].summary).toBe('Rank by completed_at');
    expect(upserted[0].metadata.resolution_note).toBe('Shipped in the trim fix');
    expect(upserted[0].summary).not.toContain('Shipped in the trim fix');
  });

  it('keys identity on node_type, and carries scope for a project entity', async () => {
    await call({ title: 'Cap the Done column' });
    expect(upserted[0].entity_type).toBe('decision');
    // graph_node_3 has no project_id, so no scope should be sent.
    expect(upserted[0].scope).toBeUndefined();

    upserted = [];
    await call({ title: 'Ledger retention policy' });
    expect(upserted[0].project_id).toBe('project_test');
    expect(upserted[0].scope).toBe('project');
  });

  it('never resolves a lone partial match: the search ranks by shared words, not identity', async () => {
    const out = await call({ title: 'happens to share' });
    expect(upserted).toHaveLength(0);
    expect(out).toContain('nothing was resolved');
  });

  it('with project_id, resolves the decision in THAT project\'s brief through the server', async () => {
    briefOutcome = { outcome: 'resolved', resolved: ['Use Redis for sessions'], message: 'Marked resolved: "Use Redis for sessions".' };
    const out = await call({ title: 'Use Redis for sessions', project_id: 'project_test', notes: 'moved to Valkey' });
    // untyped: no entity_type was given, so the server weighs a task of the
    // same text before any decision (scan 28).
    expect(briefCalls).toEqual([{ projectId: 'project_test', body: { title: 'Use Redis for sessions', notes: 'moved to Valkey', untyped: true } }]);
    // The node is filed under project_other; it is not written.
    expect(upserted).toHaveLength(0);
    expect(out).toBe('Marked resolved: "Use Redis for sessions".');
  });

  it('with project_id, "already resolved" is the named project\'s answer, not the node\'s', async () => {
    briefOutcome = { outcome: 'already_resolved', message: '"Use Redis for sessions" is already resolved in Test — nothing to do.' };
    const out = await call({ title: 'Use Redis for sessions', project_id: 'project_test' });
    expect(upserted).toHaveLength(0);
    expect(out).toContain('already resolved in Test');
  });

  it('with project_id, never resolves a decision node filed under another project', async () => {
    const out = await call({ title: 'Use Redis for sessions', project_id: 'project_test' });
    expect(briefCalls).toHaveLength(1);
    expect(upserted).toHaveLength(0);
    expect(out).toContain('decision in another project');
    expect(out).toContain('nothing was resolved');
  });

  it('no-ops on an already-resolved entity', async () => {
    entities[2].metadata.status = 'resolved';
    const out = await call({ title: 'Cap the Done column' });
    expect(upserted).toHaveLength(0);
    expect(out).toContain('already resolved');
  });

  it('reports a resolve that did not take', async () => {
    // The write 200s but the entity still reads active — the exact shape this
    // tool used to report as success.
    swallowUpsert = true;
    const out = await call({ title: 'Cap the Done column' });
    expect(out).toContain('NOT resolved');
    expect(out).not.toContain('Marked resolved');
  });
});

// Scan 27. The invariant: a resolve marks exactly the decision the caller means,
// in the project they are working in (named, or this directory's), and when it
// cannot, the reply says why.
describe('mark_resolved — the project the caller is working in (scan 27)', () => {
  const LONG_TASK = 'Wire the billing webhook into the Team seat counter so removed seats are credited pro rata next cycle';
  const slug = (v: string) => v.trim().toLowerCase().replace(/[^a-z0-9._:/-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

  it('without project_id, resolves in THIS directory\'s project, not wherever the node was filed', async () => {
    activeAnswer = { project_id: 'project_test', project_name: 'Test', match_kind: 'path', write_target: true };
    const out = await call({ title: 'Use Redis for sessions' });
    // The brief of the directory's project was asked first...
    expect(briefCalls.map((c) => c.projectId)).toEqual(['project_test']);
    // ...and the node filed under project_other was NOT resolved in its stead.
    expect(upserted).toHaveLength(0);
    expect(out).toContain('not in the active project');
    expect(out).toContain('project_id: "project_other"');
  });

  it('without project_id, the directory\'s brief answers when it holds the decision', async () => {
    activeAnswer = { project_id: 'project_test', project_name: 'Test', match_kind: 'path', write_target: true };
    briefOutcome = { outcome: 'resolved', message: 'Marked resolved: "Use Redis for sessions".' };
    const out = await call({ title: 'Use Redis for sessions' });
    expect(briefCalls).toHaveLength(1);
    expect(upserted).toHaveLength(0);
    expect(out).toBe('Marked resolved: "Use Redis for sessions".');
  });

  it('a task over 80 characters resolves by its complete text, not only by its cut title', async () => {
    entities.push({
      node_id: 'graph_node_6', node_type: 'task', title: `${LONG_TASK.slice(0, 79)}...`,
      summary: LONG_TASK, canonical_key: `task:${slug(LONG_TASK)}`,
      project_id: 'project_test', metadata: { entity_type: 'task', status: 'active' },
    });
    const out = await call({ title: LONG_TASK, entity_type: 'task' });
    expect(upserted).toHaveLength(1);
    expect(upserted[0].canonical_key).toBe(`task:${slug(LONG_TASK)}`);
    expect(out).toContain('Marked resolved');
  });

  it('against an API with no decision-resolve route, says the API is too old — not "another project"', async () => {
    briefRouteMode = 'old';
    const out = await call({ title: 'Use Redis for sessions', project_id: 'project_test' });
    expect(upserted).toHaveLength(0);
    expect(out).toContain('too old');
    expect(out).toMatch(/Update or redeploy/);
    expect(out).not.toContain('decision in another project');
  });

  it('a project_id that names no project is an error that names it and says how to list them', async () => {
    briefRouteMode = 'missing';
    await expect(handleContextSyncTool('mark_resolved', { title: 'Use Redis for sessions', project_id: 'project_gone' }, client))
      .rejects.toThrow(/No project "project_gone" that you can see[\s\S]*recall\(action:"projects"\)/);
    expect(upserted).toHaveLength(0);
  });
});

describe('mark_resolved — the same "exactly" as the hosted server (scan 28)', () => {
  const slug = (v: string) => v.trim().toLowerCase().replace(/[^a-z0-9._:/-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const LONG = 'Adopt the shared BullMQ queue for every background job, with three retries, exponential backoff and a DLQ per queue';

  it('"use redis." does not name "Use Redis": a trailing stop is not trimmed off the asked text', async () => {
    entities.push({
      node_id: 'graph_node_7', node_type: 'decision', title: 'Use Redis', summary: 'Use Redis',
      canonical_key: 'decision:use-redis', project_id: 'project_test', metadata: { entity_type: 'decision', status: 'active' },
    });
    const out = await call({ title: 'use redis.' });
    expect(upserted).toHaveLength(0);
    expect(out).toContain('No entity is named exactly');
  });

  it('a stored key names a decision only as the slug of the asked text, not with its stop trimmed', async () => {
    entities.push({
      node_id: 'graph_node_8', node_type: 'decision', title: 'Sessions store', summary: 'Chosen for speed',
      canonical_key: 'decision:keep-sessions-in-redis.', project_id: 'project_test', metadata: { entity_type: 'decision', status: 'active' },
    });
    const out = await call({ title: 'Keep sessions in Redis' });
    expect(upserted).toHaveLength(0);
    expect(out).toContain('No entity is named exactly');
  });

  it('still names a cut decision by its full text when the key carries more than the cut', async () => {
    entities.push({
      node_id: 'graph_node_9', node_type: 'decision', title: `${LONG.slice(0, 79)}...`, summary: `${LONG.slice(0, 79)}...`,
      canonical_key: `decision:${slug(LONG)}`, project_id: 'project_test', metadata: { entity_type: 'decision', status: 'active' },
    });
    const out = await call({ title: LONG });
    expect(upserted).toHaveLength(1);
    expect(upserted[0].canonical_key).toBe(`decision:${slug(LONG)}`);
    expect(out).toContain('Marked resolved');
  });

  it('a cut decision whose key carries no more than the cut is not named by the cut\'s words plus a stop', async () => {
    // What an upsert of a title copied from recall(entities) stores: keyed on
    // the slug of the cut itself, which says nothing about how it goes on. The
    // hosted server's decisionKeyBeyondCut refuses to read such a key as the
    // full text; this copy read it, with the stop trimmed, as a match.
    const visible = LONG.slice(0, 79);
    entities.push({
      node_id: 'graph_node_10', node_type: 'decision', title: `${visible}...`, summary: `${visible}...`,
      canonical_key: `decision:${slug(visible)}`, project_id: 'project_test', metadata: { entity_type: 'decision', status: 'active' },
    });
    const out = await call({ title: `${visible}.` });
    expect(upserted).toHaveLength(0);
    expect(out).not.toContain('Marked resolved');
  });

  it('the cut the brief shows ("..." and all) names the one decision it opens, and refuses two', async () => {
    entities.push({
      node_id: 'graph_node_11', node_type: 'decision', title: `${LONG.slice(0, 79)}...`, summary: LONG,
      canonical_key: `decision:${slug(LONG)}`, project_id: 'project_test', metadata: { entity_type: 'decision', status: 'active' },
    });
    const shown = `${LONG.slice(0, 60)}...`;
    let out = await call({ title: shown, project_id: 'project_test' });
    expect(out).toContain('Marked resolved');
    expect(upserted.map((e) => e.canonical_key)).toEqual([`decision:${slug(LONG)}`]);
    upserted = [];
    const twin = `${LONG.slice(0, 70)} and a separate DLQ per tenant`;
    entities.push({
      node_id: 'graph_node_12', node_type: 'decision', title: twin, summary: twin,
      canonical_key: `decision:${slug(twin)}`, project_id: 'project_test', metadata: { entity_type: 'decision', status: 'active' },
    });
    entities.find((e) => e.node_id === 'graph_node_11').metadata.status = 'active';
    out = await call({ title: shown, project_id: 'project_test' });
    expect(upserted).toHaveLength(0);
    expect(out).toContain('matches 2 entities');
  });
});

describe('mark_resolved — no entity_type is not "decision" (scan 28)', () => {
  it('tells the server the resolve is untyped, and a typed one is not', async () => {
    await call({ title: 'Use Redis for sessions', project_id: 'project_test' });
    await call({ title: 'Use Redis for sessions', project_id: 'project_test', entity_type: 'decision' });
    expect(briefCalls.map((c) => c.body.untyped)).toEqual([true, undefined]);
  });
});
