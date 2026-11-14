import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { DeerdawnClient } from '../src/client.js';
import { handleContextSyncTool } from '../src/tools/context-sync.js';

/**
 * The pinned subproject was read from and never written to.
 *
 * `switch_subproject` stores a per-workspace pointer, and the server honours it
 * in resolveActiveProject — but ONLY when the request carries `workspace_key`.
 * `start_session` sent it; every write path that has to resolve "the project I am
 * in" called getActiveContextByCwd (or getContextJson) without it, so the pin was
 * skipped and resolution fell through to the recency tiebreak among the siblings.
 *
 * The result was a pin that meant nothing for the half that matters: the brief
 * you read was the subproject you pinned, and the update you saved a moment later
 * landed on its sibling. Silent, and only visible later as a brief missing its
 * own work.
 *
 * The workspace key is DERIVED FROM THE CWD, which is the only input these call
 * sites ever had — so there is no longer a call site that can forget it. These
 * tests assert on the query string the client actually sends.
 */

let server: http.Server;
let client: DeerdawnClient;
let repoDir: string;
/** Every /active (and /map, /inject) request URL this run. */
let seen: string[] = [];

function makeGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-pin-'));
  const real = fs.realpathSync(dir);
  execFileSync('git', ['init', '-q'], { cwd: real });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/deerdawn/pin-fixture.git'], { cwd: real });
  return real;
}

beforeAll(async () => {
  repoDir = makeGitRepo();

  server = http.createServer((req, res) => {
    // The workspace key travels as a header now (location-headers.ts). Recorded
    // beside the URL so the assertions read what the API would read, and
    // acknowledged the way the API acknowledges it, or the client would repeat
    // every request in the legacy query-string form.
    const headerKey = req.headers['x-deerdawn-workspace-key'];
    seen.push(`${req.url || ''}${typeof headerKey === 'string' ? `#wk=${headerKey}` : ''}`);
    if (req.headers['x-deerdawn-cwd'] || headerKey) res.setHeader('X-DeerDawn-Location', 'header');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (payload: any) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'PATCH') return send({ ok: true });
      if (req.url?.includes('format=json')) {
        return send({
          context: {
            project_id: 'project_pinned',
            project_name: 'Pinned Subproject',
            current_task: 'whatever',
            todo_items: [],
            completed_todos: [],
          },
        });
      }
      if (req.url?.includes('/active')) {
        return send({
          brief: 'brief',
          project_id: 'project_pinned',
          project_name: 'Pinned Subproject',
          // What the API answers once a pin exists. Writes judge this field now
          // (write-target.ts), so a fake that omits it reads as "not from here".
          match_kind: 'pinned',
          last_updated: null,
        });
      }
      if (req.url?.includes('/extraction')) {
        return send({
          project: { project_id: 'project_pinned', project_name: 'Pinned Subproject' },
          extraction: { delta: { current_task: 'Ship it' } },
        });
      }
      send({ ok: true });
    });
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

beforeEach(() => { seen = []; });

afterAll(() => {
  server?.close();
  try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

const activeRequests = () => seen.filter((u) => u.includes('/context/active'));
const EXPECTED_KEY = 'remote:github.com/deerdawn/pin-fixture';

/** The workspace_key a request actually carries, however axios encoded it. */
function workspaceKeyOf(url: string): string | null {
  const [request, headerKey] = url.split('#wk=');
  if (headerKey) return decodeURIComponent(headerKey);
  const params = new URLSearchParams(request.split('?')[1] || '');
  return params.get('workspace_key');
}

describe('a pinned subproject is honoured by writes, not only by reads', () => {
  it('getActiveContextByCwd derives the workspace key from the cwd', async () => {
    await client.getActiveContextByCwd(repoDir, 'claude_code', 'light');
    expect(activeRequests()).toHaveLength(1);
    expect(workspaceKeyOf(activeRequests()[0])).toBe(EXPECTED_KEY);
  });

  it('an explicitly passed workspace key still wins', async () => {
    await client.getActiveContextByCwd(repoDir, 'claude_code', 'light', false, 'remote:github.com/other/repo');
    expect(workspaceKeyOf(activeRequests()[0])).toBe('remote:github.com/other/repo');
  });

  it('a cwd outside any repo sends no workspace key rather than a wrong one', async () => {
    const notARepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-norepo-')));
    try {
      await client.getActiveContextByCwd(notARepo, 'claude_code', 'light');
      expect(workspaceKeyOf(activeRequests()[0])).toBe(null);
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it('getContextJson with a cwd derives it too', async () => {
    await client.getContextJson(undefined, { cwd: repoDir });
    const req = seen.find((u) => u.includes('/context/active'));
    expect(workspaceKeyOf(req || '')).toBe(EXPECTED_KEY);
  });

  it("update_context's project resolution carries the pin", async () => {
    const prev = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = repoDir;
    try {
      await handleContextSyncTool('update_context', { summary: 'Shipped the thing.' }, client);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prev;
    }
    const resolution = activeRequests();
    expect(resolution.length).toBeGreaterThan(0);
    expect(workspaceKeyOf(resolution[0])).toBe(EXPECTED_KEY);
  });

  it("cleanup_context's project resolution carries the pin", async () => {
    const prev = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = repoDir;
    try {
      await handleContextSyncTool('cleanup_context', {}, client);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prev;
    }
    const resolution = activeRequests();
    expect(resolution.length).toBeGreaterThan(0);
    expect(workspaceKeyOf(resolution[0])).toBe(EXPECTED_KEY);
  });
});
