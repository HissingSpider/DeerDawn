/**
 * DEERDAWN_CAPTURE=off.
 *
 * There was no way to decline passive capture. These tests drive each hook entry
 * point the way the hook runner does — credentials on disk, a payload on stdin,
 * a project that would match — and assert on the only thing that matters to
 * somebody who opted out: nothing was sent.
 *
 * HOME is a temp dir set BEFORE the modules load (several resolve ~/.deerdawn at
 * import), so nothing here reads or writes the real home directory.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const API = 'http://localhost:21177';
const ENV_KEYS = [
  'HOME', 'USERPROFILE', 'DEERDAWN_HOME', 'DEERDAWN_DIR', 'DEERDAWN_HOME_DIR', 'DEERDAWN_API_URL',
  'DEERDAWN_API_KEY', 'DEERDAWN_CAPTURE', 'CLAUDE_PROJECT_DIR', 'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_TRANSCRIPT_PATH', 'DEERDAWN_SURFACE_ID',
] as const;
const ORIGINAL = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const SESSION = '11111111-2222-3333-4444-555555555555';

describe('DEERDAWN_CAPTURE=off', () => {
  let home: string;
  let requests: string[];
  let stdinDescriptor: PropertyDescriptor | undefined;

  function fakeStdin(payload: unknown): void {
    const stream = Readable.from([Buffer.from(JSON.stringify(payload))]) as any;
    stream.isTTY = false;
    Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
  }

  /** Every request the API would have received, recorded and answered happily. */
  function openApi(): void {
    nock(API)
      .persist()
      .get(/.*/).reply(function (uri) {
        requests.push(`GET ${uri.split('?')[0]}`);
        if (uri.startsWith('/api/v1/orgs/usage')) return [200, { plan: { tier: 'developer_pro' } }];
        // match_kind as the real /active sends it: a capture hook only writes to
        // a project the directory is actually linked to (write-target.ts).
        return [200, { project_id: 'p_1', project_name: 'Atlas', brief: 'b', match_kind: 'path' }];
      })
      .post(/.*/).reply(function (uri) {
        requests.push(`POST ${uri.split('?')[0]}`);
        return [202, { status: 'accepted' }];
      });
  }

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-optout-')));
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.DEERDAWN_HOME = path.join(home, '.deerdawn');
    process.env.DEERDAWN_API_URL = API;
    fs.mkdirSync(path.join(home, '.deerdawn'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.deerdawn', 'credentials.json'),
      JSON.stringify({ api_key: 'dd_test_key_0123456789' }),
    );
    requests = [];
    stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
    nock.disableNetConnect();
    vi.resetModules();
  });

  afterEach(() => {
    if (stdinDescriptor) Object.defineProperty(process, 'stdin', stdinDescriptor);
    nock.cleanAll();
    nock.enableNetConnect();
    vi.unstubAllGlobals();
    for (const key of ENV_KEYS) {
      if (ORIGINAL[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL[key];
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  function makeRepo(): string {
    const repo = path.join(home, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
    process.env.CLAUDE_PROJECT_DIR = repo;
    return repo;
  }

  describe('capture-command', () => {
    const payload = { tool_input: { command: 'npm test' }, tool_response: { exit_code: 0 } };

    it('control: with capture on, the command IS sent', async () => {
      makeRepo();
      openApi();
      fakeStdin(payload);
      const { captureCommandFromHook } = await import('../src/command-capture.js');
      const result = await captureCommandFromHook();
      expect(result.captured).toBe(true);
      expect(requests).toContain('POST /api/v1/context/events');
    });

    for (const value of ['off', '0', 'false', 'OFF', ' Off ']) {
      it(`makes no request at all when DEERDAWN_CAPTURE=${JSON.stringify(value)}`, async () => {
        makeRepo();
        openApi();
        fakeStdin(payload);
        process.env.DEERDAWN_CAPTURE = value;
        const { captureCommandFromHook } = await import('../src/command-capture.js');
        const result = await captureCommandFromHook();
        expect(result.captured).toBe(false);
        expect(requests).toEqual([]);
      });
    }

    it('an unrelated value does not switch capture off', async () => {
      makeRepo();
      openApi();
      fakeStdin(payload);
      process.env.DEERDAWN_CAPTURE = 'on';
      const { captureCommandFromHook } = await import('../src/command-capture.js');
      expect((await captureCommandFromHook()).captured).toBe(true);
    });
  });

  describe('capture-worktree-change', () => {
    it('control: with capture on, the change event IS sent', async () => {
      makeRepo();
      openApi();
      const { captureWorktreeChange } = await import('../src/worktree-capture.js');
      await captureWorktreeChange('claude_code');
      expect(requests.some((r) => r.startsWith('GET /api/v1/context/active'))).toBe(true);
    });

    it('makes no request, and writes no snapshot, when capture is off', async () => {
      makeRepo();
      openApi();
      process.env.DEERDAWN_CAPTURE = 'off';
      const { captureWorktreeChange } = await import('../src/worktree-capture.js');
      const result = await captureWorktreeChange('claude_code');
      expect(result.recorded).toBe(false);
      expect(requests).toEqual([]);
      expect(fs.existsSync(path.join(home, '.deerdawn', 'worktree-snapshots'))).toBe(false);
    });
  });

  describe('flush-session', () => {
    function writeTranscript(): string {
      const file = path.join(home, '.claude', 'projects', '-Users-me-Atlas', `${SESSION}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const line = (type: string, text: string) => JSON.stringify({
        type, cwd: '/Users/me/Atlas', message: { content: [{ type: 'text', text }] },
      });
      fs.writeFileSync(file, [
        line('user', 'we decided to use postgres for the queue instead of redis'),
        line('assistant', 'agreed, recording that decision about the queue backend'),
      ].join('\n') + '\n');
      return file;
    }

    function stubFetch(): ReturnType<typeof vi.fn> {
      const fetchMock = vi.fn(async () => ({
        ok: true, status: 200, json: async () => ({ project: { project_name: 'Atlas' } }), text: async () => '',
      }) as any);
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    const stdinFor = (transcript: string) => Readable.from([Buffer.from(JSON.stringify({
      hook_event_name: 'Stop', session_id: SESSION, transcript_path: transcript, cwd: '/Users/me/Atlas',
    }))]);

    it('control: with capture on, the transcript IS sent', async () => {
      const transcript = writeTranscript();
      const fetchMock = stubFetch();
      const { runFlushSessionCli } = await import('../src/flush-session.js');
      await runFlushSessionCli(['node', 'deerdawn-mcp', 'flush-session'], stdinFor(transcript) as any);
      expect(fetchMock).toHaveBeenCalled();
    });

    it('the Stop hook sends nothing when capture is off', async () => {
      const transcript = writeTranscript();
      const fetchMock = stubFetch();
      process.env.DEERDAWN_CAPTURE = 'off';
      const { runFlushSessionCli } = await import('../src/flush-session.js');
      await runFlushSessionCli(['node', 'deerdawn-mcp', 'flush-session'], stdinFor(transcript) as any);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('nor does the signal-time flush inside the running server', async () => {
      const transcript = writeTranscript();
      const fetchMock = stubFetch();
      process.env.DEERDAWN_CAPTURE = 'false';
      const { flushSession } = await import('../src/flush-session.js');
      await flushSession({ hookInput: { session_id: SESSION, transcript_path: transcript, cwd: '/Users/me/Atlas' } });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('the setup answer', () => {
    it('a no recorded at setup turns every capture entry point into a no-op, like the variable', async () => {
      const { isCaptureDisabled } = await import('../src/capture-optout.js');
      const { writeSetupChoices } = await import('../src/setup-choices.js');
      expect(isCaptureDisabled()).toBe(false);
      writeSetupChoices({ capture: 'off', capture_source: 'setup' });
      expect(isCaptureDisabled()).toBe(true);
      // An environment handed in explicitly is judged on its own.
      expect(isCaptureDisabled({})).toBe(false);
    });
  });

  describe('autoConfigureHooks', () => {
    const settingsPath = () => path.join(home, '.claude', 'settings.json');
    const commandsUnder = (hooks: any, event: string): string[] =>
      (hooks?.[event] ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => String(h.command)));

    it('installs no capture hook, and keeps the brief injection and the peer check', async () => {
      process.env.DEERDAWN_CAPTURE = 'off';
      const { autoConfigureHooks } = await import('../src/auth.js');
      autoConfigureHooks({ tool: 'claude_code' });
      const { hooks } = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
      const all = ['Stop', 'PostToolUse', 'SessionStart', 'PreToolUse'].flatMap((e) => commandsUnder(hooks, e)).join('\n');
      expect(all).not.toContain('flush-session');
      expect(all).not.toContain('capture-command');
      expect(all).not.toContain('capture-worktree-change');
      expect(all).not.toContain('prime-worktree');
      expect(commandsUnder(hooks, 'SessionStart').join('\n')).toContain('session-context');
      expect(commandsUnder(hooks, 'PreToolUse').join('\n')).toContain('peer-check');
    });

    it('removes capture hooks an earlier boot installed, and leaves the user\'s own', async () => {
      const { autoConfigureHooks } = await import('../src/auth.js');
      const { writeSetupChoices } = await import('../src/setup-choices.js');
      writeSetupChoices({ capture: 'on', capture_source: 'setup' }); // a yes at setup
      autoConfigureHooks({ tool: 'claude_code' }); // capture on: everything installed
      const before = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
      before.hooks.Stop.push({ matcher: '', hooks: [{ type: 'command', command: 'say done' }] });
      fs.writeFileSync(settingsPath(), JSON.stringify(before));
      expect(commandsUnder(before.hooks, 'PostToolUse').join('\n')).toContain('capture-command');

      process.env.DEERDAWN_CAPTURE = '0';
      autoConfigureHooks({ tool: 'claude_code' });
      const { hooks } = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
      expect(commandsUnder(hooks, 'Stop')).toEqual(['say done']);
      expect(hooks.PostToolUse).toBeUndefined();
    });
  });
});
