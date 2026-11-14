import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { applySurfaceSetup, inspectLocalSetupStatus } from '../../shared-context/src/setup-status.js';
import { buildOnDiskInstructionBlock } from '../src/on-disk-instructions.js';
import { buildCursorInstructionBlock, closeMarkerFor, openMarkerFor } from '../src/instruction-block.js';
import { removeStaleBlock } from '../src/managed-block.js';

/**
 * A BLOCK FROM ANOTHER DEERDAWN INSTALL.
 *
 * ~/.claude/CLAUDE.md is often synced between machines (dotfiles). The block in
 * it then carries the OTHER machine's token. It is DeerDawn's, written by a
 * DeerDawn install that is not this one, so this install keeps it as it is and
 * writes nothing: no second block beside it, no rewrite, no removal. Setup and
 * status say the file is managed by another DeerDawn install. A pair that only
 * looks like a block (a token nobody made, an unmatched closing marker) is not
 * that: it is left alone too, and is not called anything.
 *
 * Everything runs under a throwaway HOME (tests/setup/contain-home.ts).
 */

const OTHER = 'e'.repeat(32);
const MINE_TOKEN = '0123456789abcdef0123456789abcdef';
let home: string;
let repo: string;
let autoConfigureHooks: typeof import('../src/auth.js').autoConfigureHooks;

const write = (rel: string, text: string) => {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const read = (rel: string) => fs.readFileSync(path.join(home, rel), 'utf8');
const status = (): any => inspectLocalSetupStatus('local_direct', { runningSurface: null } as any);
const surfaceOf = (id: string): any => status().surfaces.find((entry: any) => entry.id === id);

const MINE = '# My notes\n\nSmall commits.\n';
const foreignClaude = () => `${MINE}\n${buildOnDiskInstructionBlock([], OTHER).trimEnd()}\n`;
const foreignCodex = () => `${MINE}\n${buildOnDiskInstructionBlock(['hosted'], OTHER).trimEnd()}\n`;
const CURSOR_FRONTMATTER = '---\ndescription: DeerDawn session memory\nalwaysApply: true\n---\n\n';
const foreignRule = () => `${CURSOR_FRONTMATTER}${buildCursorInstructionBlock(OTHER).trimEnd()}\n`;
const CLAUDE_REGISTERED = JSON.stringify({ mcpServers: { deerdawn: { command: 'npx', args: ['-y', '@deerdawn/mcp-server@latest'] } } });
const CODEX_REGISTERED = 'model = "o3"\n\n[mcp_servers.deerdawn]\nurl = "https://api.deerdawn.com/mcp"\n';

beforeAll(async () => {
  home = process.env.HOME as string;
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-foreign-repo-')));
  fs.mkdirSync(path.join(repo, '.git'));
  process.env.CLAUDE_PROJECT_DIR = repo;
  process.env.DEERDAWN_API_URL = 'http://127.0.0.1:9';
  vi.resetModules();
  ({ autoConfigureHooks } = await import('../src/auth.js'));
});

beforeEach(() => {
  for (const entry of fs.readdirSync(home)) fs.rmSync(path.join(home, entry), { recursive: true, force: true });
  write('.deerdawn/credentials.json', JSON.stringify({ api_key: 'dd_test_key' }));
  write('.deerdawn/install.json', JSON.stringify({ block_token: MINE_TOKEN }));
  delete process.env.DEERDAWN_SURFACE_ID;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  delete process.env.CLAUDE_PROJECT_DIR;
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('a boot keeps a block from another install and adds nothing', () => {
  it('Claude Code: ~/.claude/CLAUDE.md is byte for byte after three boots', () => {
    write('.claude/CLAUDE.md', foreignClaude());
    for (let n = 0; n < 3; n += 1) autoConfigureHooks({ tool: 'claude_code' });
    expect(read('.claude/CLAUDE.md')).toBe(foreignClaude());
  });

  it('Codex (registered): AGENTS.md is byte for byte', () => {
    write('.codex/config.toml', CODEX_REGISTERED);
    write('.codex/AGENTS.md', foreignCodex());
    for (let n = 0; n < 3; n += 1) autoConfigureHooks({ tool: 'codex' });
    expect(read('.codex/AGENTS.md')).toBe(foreignCodex());
  });

  it('Cursor (registered): the rule is byte for byte', () => {
    write('.cursor/mcp.json', JSON.stringify({ mcpServers: { deerdawn: { url: 'https://api.deerdawn.com/mcp' } } }));
    write('.cursor/rules/deerdawn.mdc', foreignRule());
    for (let n = 0; n < 3; n += 1) autoConfigureHooks({ tool: 'cursor' });
    expect(read('.cursor/rules/deerdawn.mdc')).toBe(foreignRule());
  });

  it('apply_setup with a registered tool leaves it too, and says who manages it', () => {
    write('.claude.json', CLAUDE_REGISTERED);
    write('.claude/CLAUDE.md', foreignClaude());

    const result = applySurfaceSetup('claude_code', 'repair') as any;

    expect(read('.claude/CLAUDE.md')).toBe(foreignClaude());
    expect(result.note).toContain('another DeerDawn install');
  });
});

describe('status and setup say the file is managed by another DeerDawn install', () => {
  it('get_setup_status: the file, the tool, and that DeerDawn will not write to it', () => {
    write('.claude.json', CLAUDE_REGISTERED);
    write('.claude/CLAUDE.md', foreignClaude());

    const claude = surfaceOf('claude_code');

    expect(claude.foreign_block).toMatchObject({ path: path.join(home, '.claude', 'CLAUDE.md'), tool: 'claude_code' });
    expect(claude.foreign_block.summary).toContain('~/.claude/CLAUDE.md');
    expect(claude.foreign_block.summary).toContain('managed by another DeerDawn install');
    expect(claude.stale_block ?? null).toBeNull();
  });

  it('a tool with no server registered: named as another install\'s block, not as a stale one or a hand-typed one', () => {
    write('.codex/config.toml', 'model = "o3"\n');
    write('.codex/AGENTS.md', foreignCodex());

    const codex = surfaceOf('codex');

    expect(codex.foreign_block.summary).toContain('managed by another DeerDawn install');
    expect(codex.stale_block ?? null).toBeNull();
  });

  it('this install\'s own block, and a file with no block, are not reported', () => {
    write('.claude.json', CLAUDE_REGISTERED);
    write('.claude/CLAUDE.md', `${MINE}\n${buildOnDiskInstructionBlock([], MINE_TOKEN).trimEnd()}\n`);

    expect(surfaceOf('claude_code').foreign_block ?? null).toBeNull();
    expect(surfaceOf('cursor').foreign_block ?? null).toBeNull();
  });

  it('a lookalike (a token nobody made, an unmatched closing marker) is not called another install\'s', () => {
    const forged = `<!-- deerdawn:auto-context not-a-token -->\n## DeerDawn\nforged\n<!-- /deerdawn:auto-context not-a-token -->\n`;
    const mismatched = `${openMarkerFor(OTHER)}\n## DeerDawn\nunclosed\n${closeMarkerFor('d'.repeat(32))}\n`;
    write('.claude.json', CLAUDE_REGISTERED);
    for (const lookalike of [forged, mismatched]) {
      write('.claude/CLAUDE.md', `${MINE}\n${lookalike}`);
      expect(surfaceOf('claude_code').foreign_block ?? null).toBeNull();
      autoConfigureHooks({ tool: 'claude_code' });
      expect(read('.claude/CLAUDE.md').startsWith(`${MINE}\n${lookalike}`)).toBe(true);
    }
  });

  it('remove-block refuses a block from another install and says why', () => {
    write('.codex/config.toml', 'model = "o3"\n');
    write('.codex/AGENTS.md', foreignCodex());

    const outcome = removeStaleBlock('codex', { runningSurface: null });

    expect(outcome.removed).toBe(false);
    expect(outcome.reason).toContain('another DeerDawn install');
    expect(read('.codex/AGENTS.md')).toBe(foreignCodex());
  });
});
