/**
 * cwd, hostname and the repo workspace key must not be in the URL.
 *
 * A query string is the part of a request every hop writes down — access logs,
 * proxies, APM traces. These tests stand up a real HTTP server, call the client
 * the way the tools and hooks do, and read what arrived: the request line, and
 * the headers.
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeerdawnClient } from '../src/client.js';

type Seen = { url: string; headers: http.IncomingHttpHeaders };

const HOST = os.hostname();

describe('where the session is travels in headers, not the URL', () => {
  let server: http.Server;
  let seen: Seen[];
  let apiUrl: string;
  let acknowledges: boolean;
  let cwd: string;

  beforeEach(async () => {
    seen = [];
    acknowledges = true;
    // A path with a space and non-ASCII characters: a raw header cannot carry
    // these (Node throws ERR_INVALID_CHAR), which is why the value is encoded.
    cwd = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-loc-'))), 'Jürgen Müller', 'clients', 'AcmeCorp');
    fs.mkdirSync(cwd, { recursive: true });
    server = http.createServer((req, res) => {
      seen.push({ url: req.url || '', headers: req.headers });
      const hasLocation = Boolean(req.headers['x-deerdawn-cwd'] || req.headers['x-deerdawn-workspace-key']);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (acknowledges && hasLocation) headers['X-DeerDawn-Location'] = 'header';
      res.writeHead(200, headers);
      const sawCwd = typeof req.headers['x-deerdawn-cwd'] === 'string' || (req.url || '').includes('cwd=');
      res.end(JSON.stringify({ project_id: sawCwd ? 'p_located' : 'p_recency_guess', project_name: 'Atlas', brief: 'b', map: 'm', result: {} }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(path.resolve(cwd, '..', '..', '..'), { recursive: true, force: true });
  });

  const makeClient = () => new DeerdawnClient({
    apiUrl, apiKey: 'dev-key', environment: 'sandbox', cacheEnabled: false, cacheTtlSeconds: 60, maxRetries: 0, retryBackoffMs: 100,
  } as any);

  function expectNothingSensitiveInUrl(url: string): void {
    const decoded = decodeURIComponent(url);
    expect(decoded).not.toContain('AcmeCorp');
    expect(decoded).not.toContain('Müller');
    expect(decoded).not.toContain(HOST);
    expect(decoded).not.toContain('remote:');
    expect(new URLSearchParams(url.split('?')[1] || '').has('cwd')).toBe(false);
    expect(new URLSearchParams(url.split('?')[1] || '').has('host')).toBe(false);
    expect(new URLSearchParams(url.split('?')[1] || '').has('workspace_key')).toBe(false);
  }

  it('getActiveContextByCwd: one request, location in headers, nothing in the URL', async () => {
    const data = await makeClient().getActiveContextByCwd(cwd, 'claude_code', 'light', true, 'remote:github.com/acme/secret-repo');
    expect(seen).toHaveLength(1);
    expectNothingSensitiveInUrl(seen[0].url);
    expect(decodeURIComponent(String(seen[0].headers['x-deerdawn-cwd']))).toBe(cwd);
    // The machine's hostname is never sent — not in the URL, not in a header.
    expect(seen[0].headers['x-deerdawn-host']).toBeUndefined();
    expect(decodeURIComponent(String(seen[0].headers['x-deerdawn-workspace-key']))).toBe('remote:github.com/acme/secret-repo');
    // Everything that is not a location still rides the query string.
    const query = new URLSearchParams(seen[0].url.split('?')[1]);
    expect(query.get('tool')).toBe('claude_code');
    expect(query.get('mark_session')).toBe('1');
    expect(query.get('session_id')).toBeTruthy();
    expect(data.project_id).toBe('p_located');
  });

  it('getContextMap, getContextJson and getNextBestContext keep the cwd out of the URL too', async () => {
    const client = makeClient();
    await client.getContextMap(true, cwd, 'remote:github.com/acme/secret-repo');
    await client.getContextJson(undefined, { cwd, workspaceKey: 'remote:github.com/acme/secret-repo' });
    await client.getNextBestContext({ tool: 'claude_code', cwd, limit: 3 });
    expect(seen).toHaveLength(3);
    for (const req of seen) {
      expectNothingSensitiveInUrl(req.url);
      expect(decodeURIComponent(String(req.headers['x-deerdawn-cwd']))).toBe(cwd);
    }
  });

  it('a call with no location sends no location headers and is not repeated', async () => {
    await makeClient().getContextMap();
    expect(seen).toHaveLength(1);
    expect(seen[0].headers['x-deerdawn-cwd']).toBeUndefined();
  });

  describe('against an API that predates the headers', () => {
    beforeEach(() => { acknowledges = false; });

    it('repeats the request the old way instead of accepting a project picked without a cwd', async () => {
      const client = makeClient();
      const data = await client.getActiveContextByCwd(cwd, 'claude_code', 'light');
      expect(seen).toHaveLength(2);
      expect(new URLSearchParams(seen[1].url.split('?')[1]).get('cwd')).toBe(cwd);
      expect(data.project_id).toBe('p_located');
    });

    it('and remembers, so the next call costs one request', async () => {
      const client = makeClient();
      await client.getActiveContextByCwd(cwd, 'claude_code', 'light');
      seen.length = 0;
      await client.getActiveContextByCwd(cwd, 'claude_code', 'light');
      expect(seen).toHaveLength(1);
      expect(new URLSearchParams(seen[0].url.split('?')[1]).get('cwd')).toBe(cwd);
    });
  });

  describe('the SessionStart hook', () => {
    const ENV_KEYS = ['HOME', 'USERPROFILE', 'DEERDAWN_API_URL', 'DEERDAWN_API_KEY', 'CLAUDE_PROJECT_DIR', 'DEERDAWN_SURFACE_ID'] as const;
    const original = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    let home: string;

    beforeEach(() => {
      home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-loc-home-')));
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      process.env.DEERDAWN_API_URL = apiUrl;
      process.env.DEERDAWN_API_KEY = 'dev-key';
      process.env.CLAUDE_PROJECT_DIR = cwd;
      delete process.env.DEERDAWN_SURFACE_ID;
      vi.resetModules();
    });

    afterEach(() => {
      vi.restoreAllMocks();
      for (const key of ENV_KEYS) {
        if (original[key] === undefined) delete process.env[key];
        else process.env[key] = original[key];
      }
      fs.rmSync(home, { recursive: true, force: true });
    });

    it('sends the cwd as a header', async () => {
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const { emitSessionContext } = await import('../src/session-context.js');
      await emitSessionContext();
      expect(out).toHaveBeenCalled();
      expect(seen).toHaveLength(1);
      expectNothingSensitiveInUrl(seen[0].url);
      expect(decodeURIComponent(String(seen[0].headers['x-deerdawn-cwd']))).toBe(cwd);
    });

    it('falls back to the query string against an older API', async () => {
      acknowledges = false;
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const { emitSessionContext } = await import('../src/session-context.js');
      await emitSessionContext();
      expect(seen).toHaveLength(2);
      expect(new URLSearchParams(seen[1].url.split('?')[1]).get('cwd')).toBe(cwd);
    });
  });
});
