import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildOnDiskInstructionBlock } from '../src/on-disk-instructions.js';

/**
 * A HOME UPGRADED FROM 1.0.53, WHOSE CODEX HAS NO DEERDAWN SERVER.
 *
 * 1.0.53 wrote DeerDawn's block into ~/.codex/AGENTS.md whenever the file
 * existed, registered or not: an order to call start_session that Codex cannot
 * follow. Removing it at boot needs CERTAIN knowledge that Codex has no DeerDawn
 * server, and codex-cli 0.154 does not give that from config.toml alone
 * (verified 2026-09-28 in a throwaway CODEX_HOME with `codex exec`): a
 * `-c mcp_servers.<name>.command=...` override starts a server that is in no
 * file, `-p <name>` layers $CODEX_HOME/<name>.config.toml, and the binary also
 * reads /etc/codex/config.toml, /etc/codex/managed_config.toml and plugins'
 * .mcp.json. So the block stays, byte for byte; get_setup_status flags it, and
 * the `setup` CLI names it (setup-summary node test).
 *
 * The files here are exactly what a 1.0.53 boot left: the person's text, a
 * blank line, the block fitted to the local server.
 */

let home: string;
let repo: string;
let autoConfigureHooks: typeof import('../src/auth.js').autoConfigureHooks;

const USER_AGENTS = '# Codex notes\n\nUse pnpm.\n';
const LEFT_BY_1_0_53 = `${USER_AGENTS.trimEnd()}\n\n${buildOnDiskInstructionBlock([]).trimEnd()}\n`;

const write = (rel: string, text: string) => {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const read = (rel: string) => fs.readFileSync(path.join(home, rel), 'utf8');

async function codexStatus(): Promise<any> {
  const { inspectLocalSetupStatus } = await import('../../shared-context/src/setup-status.js');
  return (inspectLocalSetupStatus() as any).surfaces.find((s: any) => s.id === 'codex');
}

function bootAs(surface: string) {
  process.env.DEERDAWN_SURFACE_ID = surface;
  autoConfigureHooks();
}

beforeAll(async () => {
  // HOME is this file's own (tests/setup/contain-home.ts).
  home = process.env.HOME as string;
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-stale-repo-')));
  fs.mkdirSync(path.join(repo, '.git'));
  process.env.CLAUDE_PROJECT_DIR = repo;
  process.env.DEERDAWN_API_URL = 'http://127.0.0.1:9';
  vi.resetModules();
  ({ autoConfigureHooks } = await import('../src/auth.js'));
});

beforeEach(() => {
  for (const entry of fs.readdirSync(home)) fs.rmSync(path.join(home, entry), { recursive: true, force: true });
  write('.deerdawn/credentials.json', JSON.stringify({ api_key: 'dd_test_key' }));
  write('.codex/AGENTS.md', LEFT_BY_1_0_53);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.DEERDAWN_SURFACE_ID;
});

afterAll(() => {
  delete process.env.CLAUDE_PROJECT_DIR;
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('upgraded from 1.0.53', () => {
  it('no DeerDawn server in config.toml: the block stays byte for byte, and the status flags it', async () => {
    const toml = 'model = "o3"\n\n[mcp_servers.github]\ncommand = "gh-mcp"\n';
    write('.codex/config.toml', toml);

    for (const surface of ['claude_code', 'cursor', 'claude_code']) bootAs(surface);

    expect(read('.codex/AGENTS.md')).toBe(LEFT_BY_1_0_53);
    expect(read('.codex/config.toml')).toBe(toml);
    const codex = await codexStatus();
    expect(codex.configured).toBe(false);
    expect(codex.degraded_reason).toBe('instructions_without_mcp_server');
  });

  it('an inline registration: only a Codex boot touches the block, and it moves to the token markers, fitted to the hosted server', async () => {
    write('.codex/config.toml', 'model = "o3"\n[mcp_servers]\ndeerdawn = { url = "https://api.deerdawn.com/mcp" }\n');

    // Another tool's boot leaves Codex's file alone, byte for byte.
    bootAs('claude_code');
    expect(read('.codex/AGENTS.md')).toBe(LEFT_BY_1_0_53);

    // Codex's own boot migrates the block written by 1.0.53 (the markers without
    // a token) in place; the person's text above it is untouched.
    bootAs('codex');
    const once = read('.codex/AGENTS.md');
    bootAs('codex');

    const token = JSON.parse(read('.deerdawn/install.json')).block_token;
    expect(once).toBe(`${USER_AGENTS.trimEnd()}\n\n${buildOnDiskInstructionBlock(['hosted'], token).trimEnd()}\n`);
    expect(read('.codex/AGENTS.md')).toBe(once);
    expect((await codexStatus()).configured).toBe(true);
  });

  it('a config.toml that does not parse: nothing is touched', async () => {
    const toml = '[mcp_servers.deerdawn\nurl = "https://api.deerdawn.com/mcp"\n';
    write('.codex/config.toml', toml);

    for (const surface of ['claude_code', 'cursor']) bootAs(surface);

    expect(read('.codex/AGENTS.md')).toBe(LEFT_BY_1_0_53);
    expect(read('.codex/config.toml')).toBe(toml);
    expect((await codexStatus()).configured).toBe(false);
  });
});
