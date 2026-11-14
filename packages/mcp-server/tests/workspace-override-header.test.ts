/**
 * Reaching a team you were invited to AFTER you installed DeerDawn.
 *
 * API keys are workspace credentials: keys.js mints them against the workspace
 * the person was in, and a key then resolves to that workspace on every later
 * request. Deliberately — accepting an invite must not silently move somebody's
 * personal key into a team. But this package sent no workspace header at all, so
 * for the cohort whose install predates their invite there was NO route into the
 * team: invite them as often as you like, their agent loop still reads and
 * writes their personal workspace, and the team product looks empty.
 *
 * The API admits `x-deerdawn-workspace` for any credential whose person is an
 * active member, re-checking membership per request and capping scopes to the
 * role held there (middleware/auth.js). These tests drive the real client and
 * the real hook paths against a real HTTP server and read what arrived.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeerdawnClient } from '../src/client.js';
import { handleContextSyncTool } from '../src/tools/context-sync.js';
import { handleAuthTool } from '../src/tools/auth.js';
import { workspaceOverride, workspaceHeaders, resetWorkspaceOverrideState } from '../src/workspace-override.js';

// flush-session is imported DYNAMICALLY, never here: it resolves
// ~/.deerdawn/credentials.json from os.homedir() once, at module load, the way
// every other hook module does. A static import would fix that path against the
// developer's REAL home before any beforeEach could redirect it — which is
// exactly what made the hook case below pass on a machine with a live
// credentials.json and fail in CI, where HOME is empty and the flush returns
// before it builds a request at all. Same shape as hook-network-budget.test.ts:
// set HOME, write the fixture, reset the module registry, then import.

const WORKSPACE = 'org-acme-team';

// Cleared before every test so nothing a developer happens to export into their
// shell can reach the code under test.
const ENV_KEYS = [
  'HOME', 'USERPROFILE', 'DEERDAWN_WORKSPACE', 'DEERDAWN_DIR', 'DEERDAWN_HOME_DIR',
  'DEERDAWN_HOME', 'DEERDAWN_API_URL', 'DEERDAWN_API_KEY', 'DEERDAWN_CAPTURE',
  // CLAUDE_CODE_SESSION_ID is the one Claude Code really exports to the
  // processes it spawns, so a suite run from inside Claude Code inherits it.
  'CLAUDE_PROJECT_DIR', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_TRANSCRIPT_PATH', 'DEERDAWN_SURFACE_ID',
] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

describe('the DEERDAWN_WORKSPACE value itself', () => {
  beforeEach(() => resetWorkspaceOverrideState());
  afterEach(() => { delete process.env.DEERDAWN_WORKSPACE; });

  // `projectDir: null` asks the resolver a question that touches no disk. The
  // value is now also readable from the project's .mcp.json (see
  // workspace-from-project-config.test.ts), so without it these would answer
  // from whatever repo the suite happens to be run in — which is how a unit
  // test of a STRING quietly becomes a test of the developer's checkout.
  const value = (DEERDAWN_WORKSPACE?: string) => ({ env: { DEERDAWN_WORKSPACE }, projectDir: null } as const);

  it('is absent when nothing is configured', () => {
    expect(workspaceOverride(value())).toBeNull();
    expect(workspaceHeaders(value())).toEqual({});
  });

  it('is trimmed, because a value pasted from a config file brings what came with it', () => {
    expect(workspaceOverride(value(`  ${WORKSPACE}\n`))).toBe(WORKSPACE);
  });

  it('treats an empty or whitespace-only value as unset', () => {
    expect(workspaceOverride(value('   '))).toBeNull();
  });

  it('ignores an implausible value rather than sending it', () => {
    // A header carrying whitespace or a control character is rejected by the
    // HTTP client before any request leaves, which looks like an outage rather
    // than a typo.
    for (const bad of ['org acme', 'org\nacme', `org${String.fromCharCode(0)}acme`, 'x'.repeat(201)]) {
      resetWorkspaceOverrideState();
      expect(workspaceOverride(value(bad))).toBeNull();
      expect(workspaceHeaders(value(bad))).toEqual({});
    }
  });
});

describe('the workspace header on the wire', () => {
  let server: http.Server;
  let apiUrl: string;
  let seen: Array<{ url: string; headers: http.IncomingHttpHeaders }>;
  let refuseWorkspace: boolean;
  let dir: string;

  beforeEach(async () => {
    seen = [];
    refuseWorkspace = false;
    resetWorkspaceOverrideState();
    // realpathSync because macOS hands out /var symlinks for temp dirs, and the
    // hook compares paths it derived itself against ones it was handed.
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-workspace-')));
    for (const key of ENV_KEYS) delete process.env[key];
    // The whole fixture lives under one temp HOME: os.homedir() reads HOME, so
    // this is what every path the code derives for itself resolves against.
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    process.env.DEERDAWN_DIR = path.join(dir, '.deerdawn');
    fs.mkdirSync(process.env.DEERDAWN_DIR, { recursive: true });
    // Its own credential, so the test never depends on whether the machine
    // running it happens to be signed in.
    fs.writeFileSync(
      path.join(process.env.DEERDAWN_DIR, 'credentials.json'),
      JSON.stringify({ api_key: 'dd_personal_key' }),
      { mode: 0o600 },
    );

    server = http.createServer((req, res) => {
      seen.push({ url: req.url || '', headers: req.headers });
      req.resume();
      res.setHeader('content-type', 'application/json');
      if (refuseWorkspace && req.headers['x-deerdawn-workspace']) {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: 'workspace_forbidden', message: 'You are not a member of this workspace.' }));
        return;
      }
      res.end(JSON.stringify({
        brief: 'Current task: ship the header.',
        project_id: 'p_team',
        project_name: 'Acme Platform',
        map: '[DeerDawn - 1 project]\nAcme Platform (p_team)',
        project: { project_name: 'Acme Platform' },
        results: [],
        projects: [],
      }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    for (const key of ENV_KEYS) {
      const value = ORIGINAL_ENV[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const makeClient = () => new DeerdawnClient({
    apiUrl, apiKey: 'dd_personal_key', environment: 'sandbox',
    cacheEnabled: false, cacheTtlSeconds: 60, maxRetries: 0, retryBackoffMs: 10,
  } as any);

  it('travels on every API request when it is set', async () => {
    process.env.DEERDAWN_WORKSPACE = WORKSPACE;
    const client = makeClient();
    await client.getContextMap().catch(() => null);
    await client.getActiveContext().catch(() => null);

    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const call of seen) expect(call.headers['x-deerdawn-workspace']).toBe(WORKSPACE);
  });

  it('is absent entirely when it is not set, so a solo install is unchanged', async () => {
    const client = makeClient();
    await client.getContextMap().catch(() => null);

    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) expect(call.headers['x-deerdawn-workspace']).toBeUndefined();
  });

  it('is not sent at all when the configured value is implausible', async () => {
    process.env.DEERDAWN_WORKSPACE = 'org acme with spaces';
    const client = makeClient();
    await client.getContextMap().catch(() => null);

    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) expect(call.headers['x-deerdawn-workspace']).toBeUndefined();
  });

  it('travels on the hook path too, not only on tool calls', async () => {
    // The Stop hook is a separate CLI process building its own request. A header
    // wired only into the axios client would send a team's session transcript to
    // the author's personal workspace.
    process.env.DEERDAWN_WORKSPACE = WORKSPACE;
    process.env.DEERDAWN_API_URL = apiUrl;

    // Pointed at through the environment, which is how a hook is actually
    // driven: flushSession takes no transcript argument (FlushOptions is
    // hookInput and codex, nothing else), and an options object naming one is
    // silently ignored — tsconfig excludes tests, so nothing catches it. With
    // the transcript ignored, the flush fell through to CLAUDE_CODE_SESSION_ID,
    // which Claude Code exports into every process it spawns, and read a REAL
    // transcript out of the developer's own ~/.claude/projects. That is what
    // passed locally; in CI there is neither, so it returned before building a
    // request at all.
    // Both lines carry content as an ARRAY of blocks, which is the only shape
    // parseClaudeCodeLine accepts; a string content parses to nothing, and the
    // flush returns under its two-chunk floor without sending anything.
    const transcript = path.join(dir, 'session.jsonl');
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'user', cwd: dir, message: { role: 'user', content: [{ type: 'text', text: 'Ship the workspace header on every request.' }] } }),
      JSON.stringify({ type: 'assistant', cwd: dir, message: { role: 'assistant', content: [{ type: 'text', text: 'Done, it is on the hook path too now.' }] } }),
    ].join('\n'));
    process.env.CLAUDE_TRANSCRIPT_PATH = transcript;
    process.env.CLAUDE_PROJECT_DIR = dir;
    process.env.CLAUDE_SESSION_ID = 'session-workspace-header';

    // A hook is a fresh process every time, and this one resolves
    // ~/.deerdawn/credentials.json from os.homedir() at load — so it has to be
    // loaded AFTER the temp HOME and its credential exist. Imported statically
    // it binds the developer's real home instead.
    vi.resetModules();
    const { flushSession } = await import('../src/flush-session.js');
    try {
      await flushSession();
    } catch { /* the flush is best-effort; what it SENT is the question */ }

    const extraction = seen.filter((call) => call.url.includes('/context/extraction'));
    expect(extraction.length).toBeGreaterThan(0);
    for (const call of extraction) expect(call.headers['x-deerdawn-workspace']).toBe(WORKSPACE);
  });

  it('says plainly when the workspace refuses this machine\'s key', async () => {
    // Not "Access forbidden. Insufficient permissions.", which reads like a
    // broken credential and sends people to sign in again — and above all not a
    // silent fall back to the personal workspace, which would leave the session
    // quietly reading and writing the wrong place.
    process.env.DEERDAWN_WORKSPACE = WORKSPACE;
    refuseWorkspace = true;
    const client = makeClient();

    const failure = await handleContextSyncTool('start_session', {}, client).then(
      (result: any) => String(result?.content?.[0]?.text ?? ''),
      (err: Error) => err.message,
    );

    expect(failure).toContain(WORKSPACE);
    expect(failure).toMatch(/not a member/i);
    expect(failure).toMatch(/DEERDAWN_WORKSPACE/);
    expect(failure).not.toMatch(/Insufficient permissions/);
  });

  it('reports the workspace it is targeting in the auth and setup status', async () => {
    process.env.DEERDAWN_WORKSPACE = WORKSPACE;
    process.env.DEERDAWN_API_URL = apiUrl;
    process.env.DEERDAWN_API_KEY = 'dd_personal_key';
    try {
      for (const tool of ['get_auth_status', 'get_setup_status']) {
        const result = await handleAuthTool(tool);
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.workspace).toBe(WORKSPACE);
      }
    } finally {
      delete process.env.DEERDAWN_API_URL;
      delete process.env.DEERDAWN_API_KEY;
    }
  });
});
