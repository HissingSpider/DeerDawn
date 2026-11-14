import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { DeerdawnClient } from '../src/client.js';
import { handleContextSyncTool } from '../src/tools/context-sync.js';

/**
 * Scan 19, the local half.
 *
 * 1. At 300 open cards every manage_tasks add evicted the oldest OPEN card, and
 *    this handler dropped the POST /events result, so nothing was said. The API
 *    now refuses the whole add (409 board_open_limit_reached) and writes nothing;
 *    the refusal must reach the caller as an error carrying the API's message,
 *    not the generic "Conflicts with something that already exists". An add
 *    into Done can still push the oldest completion off a full Done column, and
 *    that eviction is now named the way move/complete already name theirs.
 *
 * 2. manage_memory update with no resolvable project answered isError:false.
 *
 * PARITY: apps/api/tests/integration/scan19-open-card-cap.test.js (hosted).
 */

const REFUSAL = 'board_open_limit_reached: the board has 300 open cards and the limit is 300, so this card was not added: "one more". '
  + 'Nothing was saved. Complete or remove open cards first (manage_tasks action "complete" or "remove"), then add again.';

let todoItems: any[] = [];
let boardFull = false;
let evictOnDoneAdd = false;
const recorded: any[] = [];

let server: http.Server;
let client: DeerdawnClient;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const send = (body: any, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const briefLookup = Boolean(req.url?.startsWith('/api/v1/context/active')) && !req.url?.includes('format=json');
    if (briefLookup) return send({ brief: 'b', project_id: 'project_test', project_name: 'Test Project', match_kind: 'path' });
    if (req.url?.startsWith('/api/v1/context/active') || req.url?.includes('/inject')) {
      return send({ context: { project_id: 'project_test', project_name: 'Test Project', updated_at: new Date().toISOString(), todo_items: todoItems } });
    }
    if (req.url?.includes('/events')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      return req.on('end', () => {
        const event = JSON.parse(body || '{}');
        recorded.push(event);
        if (event.event_type === 'todo_added') {
          if (boardFull) return send({ error: 'board_open_limit_reached', message: REFUSAL }, 409);
          const cards = (event.metadata?.todos || []).map((c: any) => (typeof c === 'string' ? { title: c } : c));
          for (const c of cards) todoItems.push({ id: `n${todoItems.length}`, title: c.title, phase: c.phase || event.metadata?.phase || 'backlog' });
          if (evictOnDoneAdd) {
            const oldest = todoItems.find((t) => t.phase === 'done');
            todoItems = todoItems.filter((t) => t !== oldest);
            return send({ status: 'accepted', evicted_cards: [{ id: oldest.id, title: oldest.title }] }, 202);
          }
        }
        send({ status: 'accepted' }, 202);
      });
    }
    return send({}, 404);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  client = new DeerdawnClient({
    apiUrl: `http://127.0.0.1:${port}`,
    apiKey: 'dev-key',
    environment: 'sandbox',
    cacheEnabled: false,
    cacheTtlSeconds: 60,
    maxRetries: 1,
    retryBackoffMs: 10,
  } as any);
});

beforeEach(() => {
  todoItems = Array.from({ length: 3 }, (_, i) => ({ id: `a${i}`, title: `open ${i}`, phase: 'backlog' }));
  todoItems.push({ id: 'd0', title: 'Oldest completion', phase: 'done' });
  boardFull = false;
  evictOnDoneAdd = false;
  recorded.length = 0;
});

afterAll(() => server?.close());

const text = (r: any) => String(r?.content?.[0]?.text ?? '');

async function outcomeOf(fn: () => Promise<any>): Promise<{ isError: boolean; text: string }> {
  try {
    const r = await fn();
    return { isError: Boolean(r?.isError), text: text(r) };
  } catch (err: any) {
    // The dispatcher's contract for an API refusal is a thrown McpError, which
    // the server turns into an isError result.
    return { isError: true, text: String(err?.message || err) };
  }
}

describe('manage_tasks add at the open-card limit (local)', () => {
  it('surfaces the refusal as an error with the API message, and claims no add', async () => {
    boardFull = true;
    const out = await outcomeOf(() => handleContextSyncTool('manage_tasks', { action: 'add', project_id: 'project_test', todos: ['one more'] }, client));
    expect(out.isError).toBe(true);
    expect(out.text).toContain('limit is 300');
    expect(out.text).toContain('Nothing was saved');
    expect(out.text).not.toMatch(/Added to/);
    expect(out.text).not.toContain('Conflicts with something that already exists');
    // Nothing was queued for a retry either: a 409 is an answer, not an outage.
    expect(todoItems.map((t) => t.title)).not.toContain('one more');
  });

  it('names a completion an add into Done pushed off the Done column', async () => {
    evictOnDoneAdd = true;
    const out = await outcomeOf(() => handleContextSyncTool('manage_tasks', { action: 'add', project_id: 'project_test', phase: 'done', todos: ['Finished elsewhere'] }, client));
    expect(out.isError).toBe(false);
    expect(out.text).toContain('Added to');
    expect(out.text).toContain('removed to make room: "Oldest completion"');
  });

  it('says nothing about eviction when nothing was evicted', async () => {
    const out = await outcomeOf(() => handleContextSyncTool('manage_tasks', { action: 'add', project_id: 'project_test', todos: ['plain add'] }, client));
    expect(out.isError).toBe(false);
    expect(out.text).not.toContain('removed to make room');
  });
});

describe('manage_memory update with no resolvable project (local)', () => {
  it('returns isError:true and keeps the helpful text', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-scan19-'));
    const prev = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = dir;
    const stub = {
      getActiveContextByCwd: async () => null,
    } as any;
    try {
      const r: any = await handleContextSyncTool('update_context', { summary: 'Shipped the thing.' }, stub);
      expect(text(r)).toContain('No active project for this directory to save to.');
      expect(r.isError).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
