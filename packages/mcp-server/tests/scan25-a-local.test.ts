/**
 * SCAN 25 (a), local stdio.
 *
 *   5. manage_memory(update) with no resolvable project still told the caller to
 *      "Call start_session (or pass project_id explicitly)" — circular on an
 *      account with no project, where start_session creates nothing. It names
 *      NO_PROJECT_NEXT_STEP now, like every other no-project refusal.
 *   6. recall(action:"context") with no project_id read /active with no
 *      directory, so the server fell back to the most recent project and warned
 *      "directory not linked to this project — match is a guess" inside a
 *      linked repo. The read now carries the cwd and workspace key, as
 *      start_session does.
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeerdawnClient } from '../src/client.js';
import { handleContextSyncTool } from '../src/tools/context-sync.js';
import { NO_PROJECT_NEXT_STEP } from '../src/write-target.js';

const text = (r: any) => (r?.content || []).map((c: any) => c.text).join('\n');

function withProjectDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = dir;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev;
  });
}

describe('5: a save with no project names the tool that makes one', () => {
  it('manage_memory(update) refuses with NO_PROJECT_NEXT_STEP, not "call start_session"', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-scan25-'));
    try {
      const stub = { getActiveContextByCwd: async () => null } as any;
      for (const [name, args] of [
        ['manage_memory', { action: 'update', summary: 'Decided to use Vite.' }],
        ['update_context', { summary: 'Shipped the thing.' }],
      ] as const) {
        const r: any = await withProjectDir(dir, () => handleContextSyncTool(name, args as any, stub));
        expect(r.isError).toBe(true);
        expect(text(r)).toContain(NO_PROJECT_NEXT_STEP);
        expect(text(r)).not.toMatch(/start_session/);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('6: a project-less recall says where it is', () => {
  let server: http.Server;
  let seen: { url: string; headers: http.IncomingHttpHeaders }[];
  let apiUrl: string;
  let dir: string;
  let linked: boolean;

  beforeEach(async () => {
    seen = [];
    linked = true;
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-scan25-linked-')));
    server = http.createServer((req, res) => {
      seen.push({ url: req.url || '', headers: req.headers });
      const located = typeof req.headers['x-deerdawn-cwd'] === 'string';
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (located) headers['X-DeerDawn-Location'] = 'header';
      res.writeHead(200, headers);
      const brief = located
        ? 'Now: today\nCurrent task: Local first task\nProject: Linked'
        : '⚠ directory not linked to this project — match is a guess.\nCurrent task: Somebody else\nProject: Recent';
      if (located && !linked) {
        // A named directory linked to nothing resolves to nothing.
        res.end(JSON.stringify({ project_id: null, project_name: null, brief: null }));
        return;
      }
      if ((req.url || '').includes('/inject')) {
        res.end(JSON.stringify({ payload: { body: brief, project_id: 'p_named', project_name: 'Named' } }));
        return;
      }
      res.end(JSON.stringify({ project_id: located ? 'p_linked' : 'p_recent', project_name: located ? 'Linked' : 'Recent', brief }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const makeClient = () => new DeerdawnClient({
    apiUrl, apiKey: 'dev-key', environment: 'sandbox', cacheEnabled: false, cacheTtlSeconds: 60, maxRetries: 0, retryBackoffMs: 100,
  } as any);

  it('recall(action:"context") and its sections form send the cwd to /active, and get the linked project', async () => {
    for (const args of [{ action: 'context' }, { action: 'context', sections: ['task'] }]) {
      seen = [];
      const r: any = await withProjectDir(dir, () => handleContextSyncTool('recall', args as any, makeClient()));
      const active = seen.filter((s) => s.url.startsWith('/api/v1/context/active'));
      expect(active.length).toBeGreaterThan(0);
      expect(decodeURIComponent(String(active[0].headers['x-deerdawn-cwd']))).toBe(dir);
      // A read: no dedup marker, and the location stays out of the URL.
      const query = new URLSearchParams(active[0].url.split('?')[1] || '');
      expect(query.has('mark_session')).toBe(false);
      expect(query.has('cwd')).toBe(false);
      expect(text(r)).not.toContain('match is a guess');
    }
  });

  it('in a directory linked to nothing, the read still offers the most recent project as a guess', async () => {
    linked = false;
    const r: any = await withProjectDir(dir, () => handleContextSyncTool('recall', { action: 'context' } as any, makeClient()));
    const active = seen.filter((s) => s.url.startsWith('/api/v1/context/active'));
    expect(active).toHaveLength(2);
    expect(active[1].headers['x-deerdawn-cwd']).toBeUndefined();
    expect(text(r)).toContain('Project: Recent');
  });

  it('a named project is read by id, with no location', async () => {
    await withProjectDir(dir, () => handleContextSyncTool('recall', { action: 'context', project_id: 'p_named' } as any, makeClient()));
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toContain('/api/v1/context/projects/p_named/inject');
    expect(seen[0].headers['x-deerdawn-cwd']).toBeUndefined();
  });
});
