import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { inspectLocalSetupStatus } from '../../shared-context/src/setup-status.js';

/**
 * A CLAUDE DESKTOP BOOT WRITES NOTHING OF CLAUDE CODE'S, AND THE LOOP IS GONE.
 *
 * Any client name containing "claude" used to map to Claude Code, Desktop's
 * included. A Desktop-only machine then had ~/.claude/settings.json hooks and
 * ~/.claude/CLAUDE.md written by a Desktop boot; the stale-block status flagged
 * DeerDawn's own write and told the person to remove it; the next Desktop boot
 * wrote it back. Only a client that names itself exactly as Claude Code does
 * (`claude-code`, verified against the real client's initialize message) is Claude
 * Code. Any other "claude*" name is a client DeerDawn cannot place, and a boot that
 * cannot say which tool it serves writes nothing. DEERDAWN_SURFACE_ID still wins.
 *
 * Everything runs under a throwaway HOME (tests/setup/contain-home.ts).
 */

let home: string;
let repo: string;

const write = (rel: string, text: string) => {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

function tree(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) tree(full, base, out);
    else out[path.relative(base, full)] = fs.readFileSync(full, 'utf8');
  }
  return out;
}

beforeAll(() => {
  home = process.env.HOME as string;
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-desktop-repo-')));
  fs.mkdirSync(path.join(repo, '.git'));
  process.env.CLAUDE_PROJECT_DIR = repo;
  process.env.DEERDAWN_API_URL = 'http://127.0.0.1:9';
});

beforeEach(() => {
  for (const entry of fs.readdirSync(home)) fs.rmSync(path.join(home, entry), { recursive: true, force: true });
  write('.deerdawn/credentials.json', JSON.stringify({ api_key: 'dd_test_key' }));
  write('Library/Application Support/Claude/claude_desktop_config.json', JSON.stringify({ mcpServers: { deerdawn: { command: 'npx', args: ['-y', '@deerdawn/mcp-server@latest'] } } }));
  delete process.env.DEERDAWN_SURFACE_ID;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  delete process.env.CLAUDE_PROJECT_DIR;
  fs.rmSync(repo, { recursive: true, force: true });
});

async function bootAs(clientName: string) {
  vi.resetModules();
  const { recordDetectedSurface } = await import('../src/surface.js');
  const auth = await import('../src/auth.js');
  recordDetectedSurface(clientName, '1.0.0');
  auth.autoConfigureHooks();
}

describe('the client names', () => {
  for (const name of ['claude-ai', 'Claude', 'claude-desktop', 'Claude Desktop', 'claude', 'claude_ai', 'claude-code-desktop']) {
    it(`"${name}" is not Claude Code: five boots write nothing, and the status flags nothing`, async () => {
      const before = tree(home);

      for (let n = 0; n < 5; n += 1) await bootAs(name);

      expect(tree(home)).toEqual(before);
      const status = inspectLocalSetupStatus('local_direct', { runningSurface: null } as any) as any;
      const claude = status.surfaces.find((entry: any) => entry.id === 'claude_code');
      expect(claude.stale_block ?? null).toBeNull();
      expect(claude.foreign_block ?? null).toBeNull();
    });
  }

  it('"claude-code", the name the real client sends, is Claude Code: its files are written', async () => {
    await bootAs('claude-code');
    expect(fs.existsSync(path.join(home, '.claude', 'settings.json'))).toBe(true);
    // Hooks only: the global CLAUDE.md block is never added by a boot (Thing 4.3).
    expect(fs.existsSync(path.join(home, '.claude', 'CLAUDE.md'))).toBe(false);
  });

  it('DEERDAWN_SURFACE_ID still wins over an unplaceable name', async () => {
    process.env.DEERDAWN_SURFACE_ID = 'claude_code';
    await bootAs('claude-ai');
    expect(fs.existsSync(path.join(home, '.claude', 'settings.json'))).toBe(true);
  });
});

describe('the loop', () => {
  it('a Desktop-only machine: boot, status, boot, status: nothing appears, and nothing is offered for removal', async () => {
    for (let round = 0; round < 3; round += 1) {
      await bootAs('claude-ai');
      const status = inspectLocalSetupStatus('local_direct', { runningSurface: null } as any) as any;
      expect(status.surfaces.find((entry: any) => entry.id === 'claude_code').stale_block ?? null).toBeNull();
      expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
    }
  });
});
