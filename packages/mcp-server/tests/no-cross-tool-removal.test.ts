import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildOnDiskInstructionBlock } from '../src/on-disk-instructions.js';
import { buildCursorInstructionBlock, MARKER_NAME_PREFIX } from '../src/instruction-block.js';

/**
 * A BOOT FROM ONE TOOL NEVER REMOVES ANOTHER TOOL'S BLOCK OR RULE.
 *
 * Round 1 took a stale block back out of ~/.codex/AGENTS.md and
 * ~/.cursor/rules/deerdawn.mdc whenever a boot ran somewhere else (Claude Code,
 * say) and saw no registration for that tool. "Saw no registration" is not
 * "there is none": Cursor reads a project's own .cursor/mcp.json, and a boot in
 * repo A cannot see repo B's. Observed in a walk (2026-09-28): Cursor registered
 * only in repo B, so every Claude Code boot in repo A stripped the rule (leaving
 * its frontmatter behind) and every Cursor boot in repo B put it back, forever.
 *
 * The rule under test: a boot keeps NOT WRITING a block into a tool with no
 * visible registration, and never removes one. Everything runs under a throwaway
 * HOME, with the API on a closed local port.
 */

let home: string;
let repoA: string;
let repoB: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['HOME', 'USERPROFILE', 'CLAUDE_PROJECT_DIR', 'DEERDAWN_HOME_DIR', 'DEERDAWN_DIR', 'DEERDAWN_API_KEY', 'DEERDAWN_API_URL', 'DEERDAWN_SURFACE_ID', 'CODEX_HOME'];
let autoConfigureHooks: typeof import('../src/auth.js').autoConfigureHooks;

function write(root: string, rel: string, content: string): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}
const read = (rel: string) => fs.readFileSync(path.join(home, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(home, rel));

async function setupStatus(runningSurface: string): Promise<any> {
  const { inspectLocalSetupStatus } = await import('../../shared-context/src/setup-status.js');
  return (inspectLocalSetupStatus as any)('local_direct', { runningSurface });
}
const surfaceOf = (status: any, id: string) => status.surfaces.find((s: any) => s.id === id);

/** One boot of the stdio server, as `surface`, with `cwd` as the project. */
function boot(surface: 'claude_code' | 'cursor' | 'codex', cwd: string): void {
  process.env.DEERDAWN_SURFACE_ID = surface;
  process.env.CLAUDE_PROJECT_DIR = cwd;
  autoConfigureHooks();
}

const GITHUB_ONLY = JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } });
const CURSOR_FRONTMATTER = '---\ndescription: DeerDawn session memory — brief every new session with your project at session start\nalwaysApply: true\n---\n\n';
const USER_AGENTS = '# Codex rules\nBe terse. USERMARK-CODEX\n';
const USER_TOML = 'model = "o3"\n\n[mcp_servers.other]\ncommand = "other"\n';
// What a boot of an earlier version left: the person's text, a blank line, the block.
const staleAgents = () => `${USER_AGENTS.trimEnd()}\n\n${buildOnDiskInstructionBlock([]).trimEnd()}\n`;
const staleRule = () => `${CURSOR_FRONTMATTER}${buildCursorInstructionBlock().trimEnd()}\n`;

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-no-xremove-home-')));
  repoA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-no-xremove-a-')));
  repoB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-no-xremove-b-')));
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.DEERDAWN_HOME_DIR = home;
  process.env.DEERDAWN_DIR = path.join(home, '.deerdawn');
  delete process.env.DEERDAWN_API_KEY;
  process.env.DEERDAWN_API_URL = 'http://127.0.0.1:9';
  for (const repo of [repoA, repoB]) fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  vi.resetModules();
  ({ autoConfigureHooks } = await import('../src/auth.js'));
});

beforeEach(() => {
  for (const entry of fs.readdirSync(home)) fs.rmSync(path.join(home, entry), { recursive: true, force: true });
  for (const repo of [repoA, repoB]) fs.rmSync(path.join(repo, '.cursor'), { recursive: true, force: true });
  write(home, '.deerdawn/credentials.json', JSON.stringify({ api_key: 'dd_test_key' }));
  delete process.env.CODEX_HOME;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of [home, repoA, repoB]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Cursor registered only in another repo', () => {
  it('Claude Code boots in repo A leave the rule a Cursor boot in repo B wrote, every round', () => {
    write(home, '.cursor/mcp.json', GITHUB_ONLY);
    fs.mkdirSync(path.join(home, '.cursor', 'rules'), { recursive: true });
    write(repoB, '.cursor/mcp.json', JSON.stringify({ mcpServers: { deerdawn: { command: 'npx', args: ['-y', '@deerdawn/mcp-server@latest'] } } }));

    // Codex registered in config.toml, and the person's own global files beside it.
    write(home, '.codex/config.toml', '[mcp_servers.deerdawn]\nurl = "https://api.deerdawn.com/mcp"\n');
    write(home, '.codex/AGENTS.md', USER_AGENTS);
    write(home, '.claude/CLAUDE.md', '# Claude notes\n\nSmall commits.\n');

    boot('cursor', repoB);
    const rule = read('.cursor/rules/deerdawn.mdc');
    expect(rule).toContain(MARKER_NAME_PREFIX);
    boot('claude_code', repoA);
    const settled = ['.cursor/rules/deerdawn.mdc', '.codex/AGENTS.md', '.claude/CLAUDE.md'].map(read);

    // Ten alternations: nothing appears or disappears, in any tool's file.
    for (let round = 1; round <= 10; round += 1) {
      boot('claude_code', repoA);
      expect(read('.cursor/rules/deerdawn.mdc'), `round ${round}, after the Claude Code boot`).toBe(rule);
      boot('cursor', repoB);
      expect(read('.cursor/rules/deerdawn.mdc'), `round ${round}, after the Cursor boot`).toBe(rule);
      expect(['.cursor/rules/deerdawn.mdc', '.codex/AGENTS.md', '.claude/CLAUDE.md'].map(read), `round ${round}`).toEqual(settled);
    }
  });

  it('the status from repo A still says what it can see: not registered here, instructions present', async () => {
    write(home, '.cursor/mcp.json', GITHUB_ONLY);
    write(home, '.cursor/rules/deerdawn.mdc', staleRule());
    write(repoB, '.cursor/mcp.json', JSON.stringify({ mcpServers: { deerdawn: { url: 'https://api.deerdawn.com/mcp' } } }));

    boot('claude_code', repoA);

    expect(read('.cursor/rules/deerdawn.mdc')).toBe(staleRule());
    const cursor = surfaceOf(await setupStatus('claude_code'), 'cursor');
    expect(cursor.configured).toBe(false);
    expect(cursor.degraded_reason).toBe('instructions_without_mcp_server');
  });
});

describe('a boot never removes a block, whichever tool it runs in', () => {
  for (const surface of ['claude_code', 'cursor'] as const) {
    it(`Codex with nothing in config.toml, booted in ${surface}: AGENTS.md is left byte for byte`, () => {
      write(home, '.codex/AGENTS.md', staleAgents());
      write(home, '.codex/config.toml', USER_TOML);

      for (let n = 0; n < 3; n += 1) boot(surface, repoA);

      expect(read('.codex/AGENTS.md')).toBe(staleAgents());
    });
  }

  for (const surface of ['claude_code', 'codex'] as const) {
    it(`Cursor with nothing registered anywhere, booted in ${surface}: the rule is left byte for byte`, () => {
      write(home, '.cursor/mcp.json', GITHUB_ONLY);
      write(home, '.cursor/rules/deerdawn.mdc', staleRule());

      for (let n = 0; n < 3; n += 1) boot(surface, repoA);

      expect(read('.cursor/rules/deerdawn.mdc')).toBe(staleRule());
    });
  }

  it('and still writes nothing into a tool with no visible registration', () => {
    write(home, '.codex/AGENTS.md', USER_AGENTS);
    write(home, '.codex/config.toml', USER_TOML);
    write(home, '.cursor/mcp.json', GITHUB_ONLY);
    fs.mkdirSync(path.join(home, '.cursor', 'rules'), { recursive: true });

    boot('claude_code', repoA);

    expect(read('.codex/AGENTS.md')).toBe(USER_AGENTS);
    expect(exists('.cursor/rules/deerdawn.mdc')).toBe(false);
  });
});
