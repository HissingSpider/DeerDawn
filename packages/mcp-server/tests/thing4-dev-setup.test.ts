import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runDeviceFlow, startDetachedSignIn, savePendingAuth, loadPendingAuth, deviceFlowInstallId } from '../src/auth.js';
import { signInNotice } from '../src/session-context.js';
import { describeClaudeHooksResult } from '../src/setup-plan.js';
import { parseYesNo, canAsk } from '../src/setup-prompt.js';
import { writeSetupChoices, readSetupChoices, repoSeedConsented } from '../src/setup-choices.js';
import {
  previewRepoSeed,
  describeRepoSeedPreview,
  buildRepoSeedText,
  seedRepoBrief,
  buildCodexAgentsBlock,
  writeCodexAgentsBlock,
  README_SEND_CHARS,
  CODEX_BLOCK_HEADING,
} from '../src/repo-seed.js';
import { version as PKG_VERSION } from '../package.json';

/**
 * Thing 4 of the activation plan: one developer setup that works.
 *
 * Each case pins a promise the setup now makes to the person running it: the
 * sign-in is theirs to see and measurable, capture and seeding are asked, the
 * Codex block is asked and goes into the repo, and nothing is invented.
 */

let dir: string;
const saved = { HOME: process.env.HOME, DEERDAWN_DIR: process.env.DEERDAWN_DIR };

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-thing4-')));
  process.env.HOME = dir;
  process.env.DEERDAWN_DIR = path.join(dir, '.deerdawn');
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeAuthApi(onStart: (body: any) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/api/v1/auth/mcp/start')) {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        onStart(raw ? JSON.parse(raw) : null);
        res.end(JSON.stringify({
          device_code: 'dc_thing4',
          user_code: 'THING4AA',
          verification_url: 'https://app.deerdawn.test/mcp-auth?code=THING4AA',
          expires_in: 6,
          interval: 0.2,
        }));
      });
      return;
    }
    if (req.url?.startsWith('/api/v1/auth/mcp/token')) {
      res.end(JSON.stringify({ status: 'authorized', api_key: 'dd_thing4_key' }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  return new Promise((resolve) => server.listen(0, () => resolve({
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  })));
}

describe('4.1 the sign-in leak is measurable', () => {
  it('/start carries an anonymous install id and the package version, and never the install token', async () => {
    const bodies: any[] = [];
    const api = await fakeAuthApi((body) => bodies.push(body));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runDeviceFlow(api.url);
    } finally {
      await api.close();
    }
    expect(bodies[0]).toMatchObject({ honors_server_expiry: true, client_version: PKG_VERSION });
    expect(bodies[0].install_id).toMatch(/^[0-9a-f]{32}$/);
    // Stable per install, and a hash: the token itself stays on the machine.
    expect(deviceFlowInstallId()).toBe(bodies[0].install_id);
    const token = JSON.parse(fs.readFileSync(path.join(dir, '.deerdawn', 'install.json'), 'utf8')).block_token;
    expect(JSON.stringify(bodies[0])).not.toContain(token);
  }, 20_000);

  it('after "Authorized", the terminal says what to do next', async () => {
    const api = await fakeAuthApi(() => {});
    const said: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { said.push(args.join(' ')); });
    try {
      await runDeviceFlow(api.url);
      await runDeviceFlow(api.url, false, undefined, '   Next: setup finishes below.');
    } finally {
      await api.close();
    }
    const transcript = said.join('\n');
    expect(transcript).toMatch(/Authorized\. Credentials saved to [^\n]+\n {3}Next: go back to your AI tool/);
    expect(transcript).toContain('Set up a DeerDawn brief for this project');
    expect(transcript).toMatch(/Authorized\. Credentials saved to [^\n]+\n {3}Next: setup finishes below\./);
  }, 20_000);
});

describe('4.2 sign-in goes to the person', () => {
  it('reuses a fresh saved link, which somebody is already listening for', async () => {
    savePendingAuth({ verification_url: 'https://app.deerdawn.test/mcp-auth?code=SAVED111', device_code: 'dc_saved', expires_at: new Date(Date.now() + 60_000).toISOString() });
    const listener = vi.fn();
    await expect(startDetachedSignIn('http://127.0.0.1:9', { spawnListener: listener })).resolves.toBe('https://app.deerdawn.test/mcp-auth?code=SAVED111');
    expect(listener).not.toHaveBeenCalled();
  });

  it('otherwise starts one, saves it for the server to resume, and leaves a listener behind', async () => {
    const api = await fakeAuthApi(() => {});
    const listener = vi.fn();
    try {
      await expect(startDetachedSignIn(api.url, { spawnListener: listener })).resolves.toBe('https://app.deerdawn.test/mcp-auth?code=THING4AA');
    } finally {
      await api.close();
    }
    expect(listener).toHaveBeenCalledTimes(1);
    expect(loadPendingAuth()?.device_code).toBe('dc_thing4');
  });

  it('an unreachable API gives no link, and the notice says how to get one', async () => {
    await expect(startDetachedSignIn('http://127.0.0.1:9', { spawnListener: null, timeoutMs: 1000 })).resolves.toBeNull();
    expect(signInNotice(null)).toContain('npx -y @deerdawn/mcp-server@latest setup');
    expect(signInNotice('https://x.test/l')).toContain('https://x.test/l');
    expect(signInNotice('https://x.test/l')).not.toMatch(/start_session/);
  });
});

describe('4.4 capture is reported as opt-in', () => {
  const ok = { present: true, runnable: true } as any;
  const absent = { present: false, runnable: false } as any;
  it('no Stop hook is not "missing" while capture has not been switched on', () => {
    const line = describeClaudeHooksResult({ settingsFound: true, events: { SessionStart: ok, Stop: absent, PreToolUse: ok, PostToolUse: absent } });
    expect(line).toContain('✓');
    expect(line).toContain('capture off');
    expect(line).not.toContain('CLAUDE.md');
  });
  it('after a yes, a missing Stop hook is', () => {
    writeSetupChoices({ capture: 'on', capture_source: 'setup' });
    expect(describeClaudeHooksResult({ settingsFound: true, events: { SessionStart: ok, Stop: absent, PreToolUse: ok, PostToolUse: ok } })).not.toContain('✓');
    expect(describeClaudeHooksResult({ settingsFound: true, events: { SessionStart: ok, Stop: ok, PreToolUse: ok, PostToolUse: ok } })).toContain('capture hooks');
  });
});

describe('4.5 seeding asks first', () => {
  function repo(): string {
    const root = path.join(dir, 'acme');
    fs.mkdirSync(root, { recursive: true });
    execFileSync('git', ['init', '-q', root]);
    for (const [i, msg] of ['first commit', 'add checkout', 'wire refund webhook'].entries()) {
      fs.writeFileSync(path.join(root, `f${i}.txt`), msg);
      execFileSync('git', ['-C', root, 'add', '.']);
      execFileSync('git', ['-C', root, '-c', 'user.email=t@t.test', '-c', 'user.name=T', 'commit', '-q', '-m', msg]);
    }
    return root;
  }

  it('previews exactly what would be read, without sending anything', () => {
    const root = repo();
    fs.writeFileSync(path.join(root, 'README.md'), `# Acme\n\n${'x'.repeat(README_SEND_CHARS + 500)}`);
    const preview = previewRepoSeed(root);
    expect(preview.root).toBe(root);
    expect(preview.contextFile).toBeNull();
    expect(preview.readme?.name).toBe('README.md');
    expect(preview.commits).toEqual(['wire refund webhook', 'add checkout', 'first commit']);
    const lines = describeRepoSeedPreview(preview).join('\n');
    expect(lines).toContain(`the first ${README_SEND_CHARS.toLocaleString('en-US')} of`);
    expect(lines).toContain('the last 3 commit subjects');
  });

  it('what is sent is the README opening and the commit subjects, secrets masked', () => {
    const root = repo();
    fs.writeFileSync(path.join(root, 'README.md'), '# Acme\nConnect with sk-live-abcdefghijklmnopqrstuvwxyz0123456789.\n');
    const text = buildRepoSeedText(previewRepoSeed(root)) as string;
    expect(text).toContain('# Acme');
    expect(text).toContain('- wire refund webhook');
    expect(text).not.toContain('sk-live-abcdefghijklmnopqrstuvwxyz0123456789');
    expect(buildRepoSeedText(previewRepoSeed(root), { includeReadme: false })).not.toContain('# Acme');
  });

  it('after a yes: a project for this repo, and the repo text sent to it', async () => {
    const root = repo();
    fs.writeFileSync(path.join(root, 'README.md'), '# Acme\nA checkout service.\n');
    const pushed: Array<[string, string]> = [];
    const client = {
      getActiveContextByCwd: vi.fn(async () => ({ project_id: null })),
      createContextProject: vi.fn(async (name: string) => ({ project: { project_id: 'p_new', project_name: name } })),
      pushContextUpdate: vi.fn(async (id: string, text: string) => { pushed.push([id, text]); }),
    };
    const importer = vi.fn(async () => null);
    const outcome = await seedRepoBrief(client, root, previewRepoSeed(root), importer);
    expect(importer).not.toHaveBeenCalled(); // no context file here
    expect(outcome).toMatchObject({ projectId: 'p_new', projectName: 'acme' });
    expect(pushed[0][0]).toBe('p_new');
    expect(pushed[0][1]).toContain('A checkout service.');
  });

  it('the answer is recorded, and only a yes lets a first session read without asking', () => {
    expect(repoSeedConsented()).toBe(false);
    writeSetupChoices({ repo_seed: 'no' });
    expect(repoSeedConsented()).toBe(false);
    writeSetupChoices({ repo_seed: 'yes' });
    expect(repoSeedConsented()).toBe(true);
    expect(readSetupChoices().repo_seed).toBe('yes');
  });
});

describe('4.9 the Codex block', () => {
  it('is the §3 block, filled in, and goes into the repo\'s AGENTS.md once', () => {
    const block = buildCodexAgentsBlock('checkout "redesign"', 'proj_123');
    expect(block.startsWith(CODEX_BLOCK_HEADING)).toBe(true);
    expect(block).toContain('project_id "proj_123"');
    expect(block).toContain('If DeerDawn is not connected, carry on without it.');
    expect(block).not.toContain('""');

    const root = path.join(dir, 'repo');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Agents\n\nRun tests first.\n');
    expect(writeCodexAgentsBlock(root, block)).toBe('written');
    expect(writeCodexAgentsBlock(root, block)).toBe('already');
    const after = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    expect(after.startsWith('# Agents\n\nRun tests first.\n')).toBe(true);
    expect(after.split(CODEX_BLOCK_HEADING)).toHaveLength(2);
  });
});

describe('hooks say when their tool is a default, not a fact', () => {
  const keys = ['DEERDAWN_SURFACE_ID', 'CLAUDE_PROJECT_DIR'] as const;
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  });

  it('Claude Code\'s hook env, a hook payload, or the surface env identify the tool; nothing does not', async () => {
    const { resolveHookSurface } = await import('../src/surface.js');
    for (const k of keys) delete process.env[k];
    expect(resolveHookSurface()).toEqual({ tool: 'claude_code', identified: false });
    expect(resolveHookSurface({ hookPayload: true })).toEqual({ tool: 'claude_code', identified: true });
    process.env.CLAUDE_PROJECT_DIR = dir;
    expect(resolveHookSurface().identified).toBe(true);
    delete process.env.CLAUDE_PROJECT_DIR;
    process.env.DEERDAWN_SURFACE_ID = 'codex';
    expect(resolveHookSurface()).toEqual({ tool: 'codex', identified: true });
  });
});

describe('the y/N questions', () => {
  it('only y or yes is yes; Enter takes the default; nobody at a terminal means not asked', () => {
    expect(parseYesNo('y', false)).toBe(true);
    expect(parseYesNo(' YES ', false)).toBe(true);
    expect(parseYesNo('', false)).toBe(false);
    expect(parseYesNo('', true)).toBe(true);
    expect(parseYesNo('n', true)).toBe(false);
    expect(parseYesNo('maybe', false)).toBe(false);
    expect(canAsk({ stdinIsTTY: false, stdoutIsTTY: true })).toBe(false);
    expect(canAsk({ stdinIsTTY: true, stdoutIsTTY: false })).toBe(false);
    expect(canAsk({ stdinIsTTY: true, stdoutIsTTY: true })).toBe(true);
  });
});
