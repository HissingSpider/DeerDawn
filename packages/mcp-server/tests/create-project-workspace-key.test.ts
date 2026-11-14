import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';

/**
 * A NEW PROJECT DID NOT KNOW WHICH REPO IT WAS CREATED IN.
 *
 * workspace_key was only ever stamped by the first write that happened to carry
 * one. "Create a subproject, then switch to it" therefore pinned a project with
 * no key, and the pin lookup requires the pinned project to be in the caller's
 * workspace: the switch reported success and the next session opened elsewhere.
 *
 * The key is derived by the server process from the repo it runs in. It is NOT
 * an argument: the advertised schema is frozen, and a caller does not get to
 * assert which codebase it is standing in.
 */

let server: http.Server;
let home: string;
let repo: string;
let bare: string;
let bodies: any[] = [];
const saved: Record<string, string | undefined> = {};
let DeerdawnClient: typeof import('../src/client.js').DeerdawnClient;
let tools: typeof import('../src/tools/context-sync.js');
let client: InstanceType<typeof DeerdawnClient>;

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-cpk-home-')));
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-cpk-repo-')));
  bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-cpk-bare-')));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Acme/Platform.git'], { cwd: repo });
  for (const key of ['HOME', 'USERPROFILE', 'DEERDAWN_HOME_DIR', 'CLAUDE_PROJECT_DIR']) saved[key] = process.env[key];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.DEERDAWN_HOME_DIR = home;
  vi.resetModules();
  ({ DeerdawnClient } = await import('../src/client.js'));
  tools = await import('../src/tools/context-sync.js');

  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      if (req.method === 'POST' && req.url === '/api/v1/context/projects') bodies.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ project: { project_id: 'project_new', project_name: body?.project_name, parent_project_id: body?.parent_project_id ?? null } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  client = new DeerdawnClient({
    apiUrl: `http://127.0.0.1:${port}`, apiKey: 'dev-key', environment: 'sandbox',
    cacheEnabled: false, cacheTtlSeconds: 60, maxRetries: 1, retryBackoffMs: 10,
  } as any);
});

beforeEach(() => { bodies = []; });

afterAll(() => {
  server?.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of [home, repo, bare]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('create_project carries the repo it was created in', () => {
  it('sends this repo\'s workspace key with a new subproject', async () => {
    process.env.CLAUDE_PROJECT_DIR = repo;
    await tools.handleContextSyncTool('manage_projects', { action: 'create', project_name: 'Billing rewrite', parent_project_id: 'project_umbrella' }, client);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      project_name: 'Billing rewrite',
      parent_project_id: 'project_umbrella',
      workspace_key: 'remote:github.com/acme/platform',
    });
  });

  it('sends it from a subdirectory of the repo too', async () => {
    const nested = path.join(repo, 'packages', 'api');
    fs.mkdirSync(nested, { recursive: true });
    process.env.CLAUDE_PROJECT_DIR = nested;
    await tools.handleContextSyncTool('create_project', { project_name: 'API' }, client);
    expect(bodies[0].workspace_key).toBe('remote:github.com/acme/platform');
  });

  it('invents nothing outside a git repo', async () => {
    process.env.CLAUDE_PROJECT_DIR = bare;
    await tools.handleContextSyncTool('create_project', { project_name: 'Scratch' }, client);
    expect(bodies[0].project_name).toBe('Scratch');
    expect('workspace_key' in bodies[0]).toBe(false);
  });

  it('is not an argument: the advertised schemas do not mention it, and a caller cannot set it', async () => {
    for (const name of ['manage_projects', 'create_project']) {
      const tool = tools.contextSyncTools.find((t: any) => t.name === name) as any;
      expect(Object.keys(tool.inputSchema.properties || {}), name).not.toContain('workspace_key');
    }
    process.env.CLAUDE_PROJECT_DIR = repo;
    await tools.handleContextSyncTool('create_project', { project_name: 'Spoof', workspace_key: 'remote:github.com/somebody/else' } as any, client);
    expect(bodies[0].workspace_key).toBe('remote:github.com/acme/platform');
  });
});
