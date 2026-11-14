import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { inspectClaudeCodeHooks, runDeviceFlow } from '../src/auth.js';
import { describeClaudeHooksResult } from '../src/setup-plan.js';

/**
 * A write that was refused must not be reported as a write that happened.
 *
 * safeWriteFileSync REFUSES rather than following a symlink (utils/safe-fs.ts) —
 * deliberately, and it logs when it does. Two callers threw that answer away:
 *
 *  - saveApiKey ignored it, so a symlinked credentials.json produced the words
 *    "Credentials saved to ~/.deerdawn/credentials.json" over an empty file, and
 *    the next start asked the user to sign in again with no explanation.
 *  - autoConfigureHooks ignored it, so a symlinked ~/.claude/settings.json left
 *    the hooks uninstalled and setup answered "hooks missing — re-run setup",
 *    forever, naming the one action that cannot change the outcome.
 */
describe('a credential store that refuses the write', () => {
  let dir: string;
  let server: http.Server;
  let apiUrl: string;
  const original = {
    deerdawnDir: process.env.DEERDAWN_DIR,
    homeDir: process.env.DEERDAWN_HOME_DIR,
    home: process.env.HOME,
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-refused-'));
    process.env.DEERDAWN_HOME_DIR = dir;
    process.env.DEERDAWN_DIR = path.join(dir, '.deerdawn');
    // autoConfigureHooks writes under os.homedir(); keep it inside the fixture.
    process.env.HOME = dir;
    fs.mkdirSync(process.env.DEERDAWN_DIR, { recursive: true });

    server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/api/v1/auth/mcp/start')) {
        req.resume();
        res.end(JSON.stringify({
          device_code: 'dc_refused',
          user_code: 'REFUSED1',
          verification_url: 'https://app.deerdawn.test/mcp-auth?code=REFUSED1',
          expires_in: 6,
          interval: 0.2,
        }));
        return;
      }
      if (req.url?.startsWith('/api/v1/auth/mcp/token')) {
        res.end(JSON.stringify({ status: 'authorized', api_key: 'dd_key_with_nowhere_to_go' }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [key, value] of [
      ['DEERDAWN_DIR', original.deerdawnDir],
      ['DEERDAWN_HOME_DIR', original.homeDir],
      ['HOME', original.home],
    ] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never claims the credential was saved when it was not', async () => {
    // Somebody's dotfiles linked credentials.json elsewhere. safe-fs refuses.
    const elsewhere = path.join(dir, 'somewhere-else.json');
    fs.writeFileSync(elsewhere, '{}');
    fs.symlinkSync(elsewhere, path.join(process.env.DEERDAWN_DIR!, 'credentials.json'));

    const said: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { said.push(args.join(' ')); });

    // The key still works, so the flow still resolves with it — and it now
    // reports the refusal alongside, because the one caller who can act on that
    // (`setup`, which prints a summary and returns an exit code) does not read
    // stderr. Throwing the answer away here is what let setup print ticks and
    // "Done" over a credential that had nowhere to go.
    await expect(runDeviceFlow(apiUrl)).resolves.toEqual({
      apiKey: 'dd_key_with_nowhere_to_go',
      saved: false,
    });

    const transcript = said.join('\n');
    expect(transcript).not.toMatch(/Credentials saved/i);
    expect(transcript).toMatch(/could NOT be saved|could not be saved/);
    expect(transcript).toMatch(/symlink/i);
    // The refusal is real: nothing was written through the link.
    expect(fs.readFileSync(elsewhere, 'utf8')).toBe('{}');
  }, 20_000);

  it('names the symlink as the reason the hooks are missing, not "re-run setup"', () => {
    const claudeDir = path.join(dir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const elsewhere = path.join(dir, 'real-settings.json');
    fs.writeFileSync(elsewhere, JSON.stringify({ hooks: {} }));
    fs.symlinkSync(elsewhere, path.join(claudeDir, 'settings.json'));

    const inspection = inspectClaudeCodeHooks();
    // Readable, parseable, and permanently unwritable: the combination that made
    // the old message a loop.
    expect(inspection.settingsFound).toBe(true);
    expect(inspection.settingsIsSymlink).toBe(true);

    const line = describeClaudeHooksResult(inspection);
    expect(line).toMatch(/symlink/i);
    expect(line).toMatch(/Replace it with a real file/i);
    expect(line).not.toMatch(/hooks missing from ~\/\.claude\/settings\.json — re-run setup/);
  });
});
