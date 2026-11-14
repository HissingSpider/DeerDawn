import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * JOURNEY R4, LOCAL: THE CREATE REPLY SAYS WHERE A PROJECT IS AND WHO READS IT.
 *
 * A project an AI tool creates in a workspace with more than one member now
 * starts personal (the owner's decision). The hosted manage_projects create
 * says so, and how to share it; the local one said only "Created project X
 * with ID: …". The server now hands back the same sentence (`placement_note`
 * on POST /projects, absent in a one-person workspace) and the local reply
 * carries it. PARITY: apps/api/tests/integration/journey-r4-tool-created-personal.test.js.
 */

let server: http.Server;
let home: string;
let note: string | undefined;
const saved: Record<string, string | undefined> = {};
let DeerdawnClient: typeof import('../src/client.js').DeerdawnClient;
let tools: typeof import('../src/tools/context-sync.js');
let client: InstanceType<typeof DeerdawnClient>;

const NOTE = 'It belongs to the workspace "Acme" and is personal, readable only by you. To share it with the team, open the dashboard\'s team settings and set it to "Shared with the team" under "What this team can see".';

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-cpp-home-')));
  for (const key of ['HOME', 'USERPROFILE', 'DEERDAWN_HOME_DIR', 'CLAUDE_PROJECT_DIR']) saved[key] = process.env[key];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.DEERDAWN_HOME_DIR = home;
  process.env.CLAUDE_PROJECT_DIR = home;
  vi.resetModules();
  ({ DeerdawnClient } = await import('../src/client.js'));
  tools = await import('../src/tools/context-sync.js');
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        project: { project_id: 'project_new', project_name: body?.project_name, parent_project_id: null },
        ...(note ? { placement_note: note } : {}),
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  client = new DeerdawnClient({
    apiUrl: `http://127.0.0.1:${port}`, apiKey: 'dev-key', environment: 'sandbox',
    cacheEnabled: false, cacheTtlSeconds: 60, maxRetries: 1, retryBackoffMs: 10,
  } as any);
});

beforeEach(() => { note = undefined; });

afterAll(() => {
  server?.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
});

const text = (r: any) => String(r?.content?.[0]?.text ?? '');

describe('local manage_projects create', () => {
  it('in a team, says the project is personal and how to share it, in the server\'s words', async () => {
    note = NOTE;
    const out = text(await tools.handleContextSyncTool('manage_projects', { action: 'create', project_name: 'Tax paperwork' }, client));
    expect(out).toBe(`Created project "Tax paperwork" with ID: project_new. ${NOTE}`);
  });

  it('in a workspace of one, or against an API that sends no note, reads exactly as before', async () => {
    const out = text(await tools.handleContextSyncTool('manage_projects', { action: 'create', project_name: 'Solo' }, client));
    expect(out).toBe('Created project "Solo" with ID: project_new');
  });
});
