import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { planSetupSignIn } from '../src/setup-plan.js';

/**
 * `setup` SAID IT OPENS YOUR BROWSER, AND MOSTLY DID NOT.
 *
 * Every description of the command says it opens a browser to sign in. It did so
 * only when ~/.claude.json recorded that the claude.ai connector had once been
 * connected — a rule borrowed from the MCP server's background boot. For anybody
 * following the install instructions for the first time, setup printed a URL to
 * stderr and waited for a browser that never came.
 *
 * The behaviour and the copy now agree: setup opens a browser whenever there is
 * a person and a screen to open it for, says so, and prints the link regardless.
 */

const INTERACTIVE_MAC = { env: {}, platform: 'darwin', stdoutIsTTY: true };

describe('whether setup opens a browser', () => {
  it('opens one in an interactive terminal, with no claude.ai connection required', () => {
    const plan = planSetupSignIn(INTERACTIVE_MAC);
    expect(plan.openBrowser).toBe(true);
    expect(plan.announcement).toContain('Opening your browser');
    expect(plan.announcement).toContain('link printed below');
  });

  it.each([
    ['CI', { ...INTERACTIVE_MAC, env: { CI: 'true' } }, 'CI'],
    ['an SSH session', { ...INTERACTIVE_MAC, env: { SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22' } }, 'SSH'],
    ['a pipe or script', { ...INTERACTIVE_MAC, stdoutIsTTY: false }, 'not an interactive terminal'],
    ['Linux with no display', { env: {}, platform: 'linux', stdoutIsTTY: true }, 'no display'],
    ['an explicit opt-out', { ...INTERACTIVE_MAC, env: { DEERDAWN_NO_BROWSER: '1' } }, 'DEERDAWN_NO_BROWSER'],
  ])('does not open one in %s, and says so instead of promising it', (_label, facts, reason) => {
    const plan = planSetupSignIn(facts as any);
    expect(plan.openBrowser).toBe(false);
    expect(plan.announcement).toContain('Not opening a browser');
    expect(plan.announcement).toContain(reason);
    expect(plan.announcement).not.toContain('Opening your browser');
    // The way forward is in the message either way.
    expect(plan.announcement).toContain('link printed below');
  });

  it('opens one on Linux when there is a display, X11 or Wayland', () => {
    expect(planSetupSignIn({ env: { DISPLAY: ':0' }, platform: 'linux', stdoutIsTTY: true }).openBrowser).toBe(true);
    expect(planSetupSignIn({ env: { WAYLAND_DISPLAY: 'wayland-0' }, platform: 'linux', stdoutIsTTY: true }).openBrowser).toBe(true);
  });

  it('CI=false is not CI', () => {
    expect(planSetupSignIn({ ...INTERACTIVE_MAC, env: { CI: 'false' } }).openBrowser).toBe(true);
  });
});

describe('the device flow prints the link whether or not it opens a browser', () => {
  let home: string;
  let server: http.Server;
  let apiUrl: string;
  const saved: Record<string, string | undefined> = {};
  const launched: string[][] = [];
  let runDeviceFlow: typeof import('../src/auth.js').runDeviceFlow;
  let stderr: string[] = [];

  beforeAll(async () => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-setup-home-')));
    for (const key of ['HOME', 'USERPROFILE', 'DEERDAWN_HOME', 'DEERDAWN_HOME_DIR']) saved[key] = process.env[key];
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.DEERDAWN_HOME;
    delete process.env.DEERDAWN_HOME_DIR;

    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url?.includes('/auth/mcp/start')) {
        return res.end(JSON.stringify({ verification_url: 'https://app.deerdawn.com/mcp-auth?code=TEST-CODE', device_code: 'dev-1', interval: 0.01, expires_in: 5 }));
      }
      return res.end(JSON.stringify({ status: 'authorized', api_key: 'dd_test_key' }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    vi.resetModules();
    // Nothing may actually launch a browser from a test run.
    vi.doMock('child_process', async (original) => {
      const actual = await original<typeof import('child_process')>();
      const execFileSync = vi.fn((file: string, args?: readonly string[]) => { launched.push([file, ...(args ?? [])]); return ''; });
      return { ...actual, default: { ...actual, execFileSync }, execFileSync };
    });
    ({ runDeviceFlow } = await import('../src/auth.js'));
  });

  beforeEach(() => {
    launched.length = 0;
    stderr = [];
    vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { stderr.push(parts.join(' ')); });
  });

  afterAll(() => {
    vi.doUnmock('child_process');
    vi.restoreAllMocks();
    server?.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const browserLaunches = () => launched.filter((call) => call.some((part) => part.includes('mcp-auth?code=TEST-CODE')));

  it('opening: launches the browser once AND prints the link', async () => {
    await expect(runDeviceFlow(apiUrl, true)).resolves.toMatchObject({ apiKey: 'dd_test_key' });
    expect(browserLaunches()).toHaveLength(1);
    expect(stderr.join('\n')).toContain('https://app.deerdawn.com/mcp-auth?code=TEST-CODE');
    // The reason is the caller's; setup passes none, and must not be told it is
    // "connected via Claude.ai" when nothing checked.
    expect(stderr.join('\n')).not.toContain('Claude.ai');
  });

  it('not opening: launches nothing and still prints the link', async () => {
    await expect(runDeviceFlow(apiUrl, false)).resolves.toMatchObject({ apiKey: 'dd_test_key' });
    expect(browserLaunches()).toHaveLength(0);
    expect(stderr.join('\n')).toContain('https://app.deerdawn.com/mcp-auth?code=TEST-CODE');
  });

  it('wrote its credentials under the temp HOME, not the real one', () => {
    expect(fs.existsSync(path.join(home, '.deerdawn', 'credentials.json'))).toBe(true);
  });
});
