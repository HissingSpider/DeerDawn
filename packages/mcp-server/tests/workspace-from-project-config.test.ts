/**
 * The hooks write to the workspace the repo says they do.
 *
 * A team delivers DEERDAWN_WORKSPACE through the committed `.mcp.json` that
 * `GET /teams/workspace-config` hands them, in the server entry's `env` block.
 * The host applies that block to the MCP SERVER process and to nothing else —
 * verified in the shipped Claude Code bundle, where a hook is spawned with
 * `{...base, CLAUDE_PROJECT_DIR}` and an MCP server with
 * `{...base, CLAUDE_PROJECT_DIR, CLAUDE_CODE_SESSION_ID, CLAUDECODE, ...entry.env}`.
 *
 * So the Stop and SessionStart hooks are separate processes that never see the
 * variable. Reading it from process.env alone meant the SERVER talked to the
 * team while the HOOKS talked to the author's personal workspace: the Stop hook
 * POSTed the team repo's transcript with no header at all (binding it to the
 * key's own workspace, where it may auto-create a project), and SessionStart
 * injected the PERSONAL brief as "Auto-loaded" into a session whose
 * start_session had just said everything it reads and writes belongs to the
 * team.
 *
 * Everything below drives the REAL hook entry points against a real HTTP server
 * and reads the headers that arrived.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// flush-session and session-context are imported DYNAMICALLY, never here: both
// resolve ~/.deerdawn from os.homedir() once, at module load. A static import
// binds the developer's REAL home before any beforeEach can redirect it, which
// is how a hook test came to pass locally off a live credentials.json and fail
// in CI. Set HOME, write the fixture, reset the registry, then import.

const WORKSPACE = 'org_acme_team';

const ENV_KEYS = [
  'HOME', 'USERPROFILE', 'DEERDAWN_WORKSPACE', 'DEERDAWN_DIR', 'DEERDAWN_HOME_DIR',
  'DEERDAWN_HOME', 'DEERDAWN_API_URL', 'DEERDAWN_API_KEY', 'DEERDAWN_CAPTURE',
  'CLAUDE_PROJECT_DIR', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_TRANSCRIPT_PATH', 'DEERDAWN_SURFACE_ID',
] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

/** The committed file a team is handed, in the exact shape formatMcpJsonConfig writes. */
function writeTeamMcpJson(dir: string, apiUrl: string, workspace: string | null): void {
  const env: Record<string, string> = { DEERDAWN_API_URL: apiUrl };
  if (workspace) env.DEERDAWN_WORKSPACE = workspace;
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({
    mcpServers: { deerdawn: { command: 'npx', args: ['-y', '@deerdawn/mcp-server@latest'], env } },
  }, null, 2));
}

function writeTranscript(file: string, cwd: string): void {
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: [{ type: 'text', text: 'Move the rate limiter into middleware and keep the 429 budget.' }] } }),
    JSON.stringify({ type: 'assistant', cwd, message: { role: 'assistant', content: [{ type: 'text', text: 'Done. Decision: the budget counts only 5xx.' }] } }),
  ].join('\n') + '\n');
}

describe('a hook in a repo whose .mcp.json names a workspace', () => {
  let server: http.Server;
  let apiUrl: string;
  let seen: Array<{ url: string; method: string; headers: http.IncomingHttpHeaders }>;
  let dir: string;
  let projectDir: string;
  let refuse: { status: number; body: Record<string, unknown> } | null;

  beforeEach(async () => {
    seen = [];
    refuse = null;
    // realpathSync because macOS hands out /var symlinks for temp dirs, and the
    // walk compares paths it derived itself against ones it was handed.
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-mcpjson-')));
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    process.env.DEERDAWN_DIR = path.join(dir, '.deerdawn');
    fs.mkdirSync(process.env.DEERDAWN_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(process.env.DEERDAWN_DIR, 'credentials.json'),
      JSON.stringify({ api_key: 'dd_personal_key' }),
      { mode: 0o600 },
    );

    // The repo. A `.git` marker, because the walk must stop at the repo root
    // rather than climbing into whatever sits above a checkout.
    projectDir = path.join(dir, 'repo');
    fs.mkdirSync(path.join(projectDir, '.git'), { recursive: true });

    server = http.createServer((req, res) => {
      seen.push({ url: req.url || '', method: req.method || '', headers: req.headers });
      req.resume();
      res.setHeader('content-type', 'application/json');
      if (refuse && req.headers['x-deerdawn-workspace']) {
        res.statusCode = refuse.status;
        res.end(JSON.stringify(refuse.body));
        return;
      }
      res.end(JSON.stringify({
        brief: 'Current task: ship the header.',
        project_id: 'p_team',
        project_name: 'Acme Platform',
        project: { project_name: 'Acme Platform' },
        last_updated: new Date().toISOString(),
      }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.DEERDAWN_API_URL = apiUrl;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    for (const key of ENV_KEYS) {
      const value = ORIGINAL_ENV[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Run the Stop hook the way the host does: CLAUDE_PROJECT_DIR set, no DEERDAWN_WORKSPACE. */
  async function runFlush(startDir: string): Promise<void> {
    const transcript = path.join(dir, 'session.jsonl');
    writeTranscript(transcript, startDir);
    process.env.CLAUDE_PROJECT_DIR = startDir;
    process.env.CLAUDE_TRANSCRIPT_PATH = transcript;
    process.env.CLAUDE_SESSION_ID = 'session-mcp-json';
    vi.resetModules();
    const { flushSession } = await import('../src/flush-session.js');
    await flushSession();
  }

  /** Run the SessionStart hook, capturing the payload it writes to stdout. */
  async function runSessionContext(startDir: string): Promise<string> {
    process.env.CLAUDE_PROJECT_DIR = startDir;
    let out = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      out += String(chunk);
      return true;
    });
    try {
      vi.resetModules();
      const { emitSessionContext } = await import('../src/session-context.js');
      await emitSessionContext();
    } finally {
      spy.mockRestore();
    }
    return out;
  }

  const extractionCalls = () => seen.filter((call) => call.url.includes('/context/extraction'));
  const activeCalls = () => seen.filter((call) => call.url.includes('/context/active'));

  it('sends the workspace header on the Stop hook flush', async () => {
    writeTeamMcpJson(projectDir, apiUrl, WORKSPACE);
    await runFlush(projectDir);

    expect(extractionCalls().length).toBeGreaterThan(0);
    for (const call of extractionCalls()) expect(call.headers['x-deerdawn-workspace']).toBe(WORKSPACE);
  });

  it('sends it on the SessionStart brief too, so the injected brief is the team\'s', async () => {
    writeTeamMcpJson(projectDir, apiUrl, WORKSPACE);
    await runSessionContext(projectDir);

    expect(activeCalls().length).toBeGreaterThan(0);
    for (const call of activeCalls()) expect(call.headers['x-deerdawn-workspace']).toBe(WORKSPACE);
  });

  it('finds it from a nested subdirectory, which is where a session usually is', async () => {
    writeTeamMcpJson(projectDir, apiUrl, WORKSPACE);
    const nested = path.join(projectDir, 'packages', 'api', 'src');
    fs.mkdirSync(nested, { recursive: true });
    await runFlush(nested);

    expect(extractionCalls().length).toBeGreaterThan(0);
    for (const call of extractionCalls()) expect(call.headers['x-deerdawn-workspace']).toBe(WORKSPACE);
  });

  it('sends no header when the file is malformed, and the hook still finishes', async () => {
    fs.writeFileSync(path.join(projectDir, '.mcp.json'), '{ "mcpServers": { "deerdawn": ');
    await expect(runFlush(projectDir)).resolves.toBeUndefined();

    expect(extractionCalls().length).toBeGreaterThan(0);
    for (const call of extractionCalls()) expect(call.headers['x-deerdawn-workspace']).toBeUndefined();
  });

  it('ignores a .mcp.json that registers somebody else\'s server', async () => {
    fs.writeFileSync(path.join(projectDir, '.mcp.json'), JSON.stringify({
      mcpServers: { sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp', env: { DEERDAWN_WORKSPACE: 'org_not_ours' } } },
    }));
    await runFlush(projectDir);

    expect(extractionCalls().length).toBeGreaterThan(0);
    for (const call of extractionCalls()) expect(call.headers['x-deerdawn-workspace']).toBeUndefined();
  });

  it('lets the environment win, because that is what the host was told to pass', async () => {
    writeTeamMcpJson(projectDir, apiUrl, 'org_from_the_file');
    process.env.DEERDAWN_WORKSPACE = WORKSPACE;
    await runFlush(projectDir);

    expect(extractionCalls().length).toBeGreaterThan(0);
    for (const call of extractionCalls()) expect(call.headers['x-deerdawn-workspace']).toBe(WORKSPACE);
  });

  it('says one true line instead of a brief when the workspace refuses this key', async () => {
    // The alternative to this sentence is NOT silence: it is the PERSONAL
    // brief, injected as "Auto-loaded" into a session working on a repo that
    // asked for somebody else's workspace.
    writeTeamMcpJson(projectDir, apiUrl, WORKSPACE);
    refuse = { status: 403, body: { error: 'workspace_forbidden', message: 'You are not a member of this workspace.' } };

    const payload = await runSessionContext(projectDir);
    const additional = JSON.parse(payload).hookSpecificOutput.additionalContext as string;

    expect(additional).toContain(WORKSPACE);
    expect(additional).toMatch(/not a member/i);
    expect(additional).not.toMatch(/degraded/i);
    expect(additional).not.toContain('Auto-loaded');
  });

  it('names the lapsed subscription rather than calling it an outage', async () => {
    writeTeamMcpJson(projectDir, apiUrl, WORKSPACE);
    refuse = { status: 403, body: { error: 'subscription_inactive', message: 'Your subscription is not active.' } };

    const additional = JSON.parse(await runSessionContext(projectDir)).hookSpecificOutput.additionalContext as string;

    expect(additional).toContain(WORKSPACE);
    expect(additional).toMatch(/subscription is not active/i);
    expect(additional).not.toMatch(/degraded/i);
  });

  it('names the workspace on a refused flush, and tries exactly once', async () => {
    writeTeamMcpJson(projectDir, apiUrl, WORKSPACE);
    refuse = { status: 403, body: { error: 'subscription_inactive', message: 'Your subscription is not active.' } };
    const said: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { said.push(parts.join(' ')); });
    try {
      await runFlush(projectDir);
    } finally {
      spy.mockRestore();
    }

    // Not retried: a closed workspace is not a blip, and three attempts would
    // only spend the Stop hook's budget on the same refusal.
    expect(extractionCalls().length).toBe(1);
    const message = said.join('\n');
    expect(message).toContain(WORKSPACE);
    expect(message).toMatch(/subscription .* is inactive/i);
    // And nothing was quietly filed in the personal workspace instead.
    expect(message).toMatch(/Nothing was read or written/i);
  });

  it('makes start_session\'s claim about the session true, and checkable', async () => {
    // The sentence asserts that everything this session reads and writes
    // belongs to the workspace. It used to exclude the two processes doing the
    // reading at the start and the writing at the end, and it named a variable
    // that a team install never sets.
    writeTeamMcpJson(projectDir, apiUrl, WORKSPACE);
    process.env.CLAUDE_PROJECT_DIR = projectDir;
    vi.resetModules();
    const { resetWorkspaceOverrideState, consumeWorkspaceOverrideNotice } = await import('../src/workspace-override.js');
    resetWorkspaceOverrideState();

    const notice = consumeWorkspaceOverrideNotice({ projectDir });

    expect(notice).toContain(WORKSPACE);
    expect(notice).toContain('.mcp.json');
    expect(notice).not.toContain('DEERDAWN_WORKSPACE');
    expect(notice).toMatch(/SessionStart hook/);
    // Once per process, whichever source it came from.
    expect(consumeWorkspaceOverrideNotice({ projectDir })).toBeNull();
  });

  it('does not climb out of the repo to find one', async () => {
    // A .mcp.json ABOVE the checkout belongs to whatever else lives up there —
    // another repo, a home directory. The walk stops at the .git it is in.
    writeTeamMcpJson(dir, apiUrl, 'org_someone_elses');
    await runFlush(projectDir);

    expect(extractionCalls().length).toBeGreaterThan(0);
    for (const call of extractionCalls()) expect(call.headers['x-deerdawn-workspace']).toBeUndefined();
  });
});
