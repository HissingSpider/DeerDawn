import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { inspectLocalSetupStatus } from '../../shared-context/src/setup-status.js';
import { buildOnDiskInstructionBlock } from '../src/on-disk-instructions.js';
import { buildCursorInstructionBlock, closeMarkerFor, openMarkerFor, OPEN_MARKER, CLOSE_MARKER } from '../src/instruction-block.js';
import { getBlockToken } from '../src/managed-block.js';

/**
 * AN INSTALL WITH NO TOKEN RECLAIMS THE ONE ALREADY IN ITS FILES.
 *
 * The token lives in ~/.deerdawn/install.json. Delete that folder, or start on a
 * second machine that shares ~/.claude/CLAUDE.md through dotfiles, and the install
 * used to mint a new token: the block in the file became "another install's",
 * was kept and never refreshed, and status said so on the only machine there is.
 *
 * Now, when an install has NO token and is about to mint one, and a well-formed
 * DeerDawn block with a token already sits in a tool's global file, it adopts that
 * token. A wiped ~/.deerdawn recovers by itself, and two machines syncing one file
 * share one token and refresh one block. It never happens when an install already
 * has a token (only `adopt-block` changes that), when the files hold several
 * different tokens (nothing is adopted: they are named), or for a lookalike.
 *
 * Everything runs under a throwaway HOME (tests/setup/contain-home.ts).
 */

const SETUP_STATUS = path.resolve(__dirname, '..', '..', 'shared-context', 'src', 'setup-status.js');
const T1 = '1'.repeat(32);
const T2 = '2'.repeat(32);
const MINE = '# My notes\n\nSmall commits.\n';
const CURSOR_FRONTMATTER = '---\ndescription: DeerDawn session memory\nalwaysApply: true\n---\n\n';
const CLAUDE_REGISTERED = JSON.stringify({ mcpServers: { deerdawn: { command: 'npx', args: ['-y', '@deerdawn/mcp-server@latest'] } } });
const CODEX_REGISTERED = 'model = "o3"\n\n[mcp_servers.deerdawn]\nurl = "https://api.deerdawn.com/mcp"\n';

let home: string;
let repo: string;
let autoConfigureHooks: typeof import('../src/auth.js').autoConfigureHooks;

const write = (rel: string, text: string) => {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const read = (rel: string) => fs.readFileSync(path.join(home, rel), 'utf8');
const installToken = (dir = path.join(home, '.deerdawn')) => JSON.parse(fs.readFileSync(path.join(dir, 'install.json'), 'utf8')).block_token as string;
const count = (text: string, token: string) => (text.match(new RegExp(`<!-- deerdawn:auto-context ${token}`, 'g')) || []).length;
const claudeBlock = (token: string, body = 'an older copy of these instructions') => `${openMarkerFor(token)}\n## DeerDawn\n${body}\n${closeMarkerFor(token)}`;
const statusOf = (id: string): any => (inspectLocalSetupStatus('local_direct', { runningSurface: null } as any) as any).surfaces.find((entry: any) => entry.id === id);

beforeAll(async () => {
  home = process.env.HOME as string;
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-reclaim-repo-')));
  fs.mkdirSync(path.join(repo, '.git'));
  process.env.CLAUDE_PROJECT_DIR = repo;
  process.env.DEERDAWN_API_URL = 'http://127.0.0.1:9';
  vi.resetModules();
  ({ autoConfigureHooks } = await import('../src/auth.js'));
});

beforeEach(() => {
  for (const entry of fs.readdirSync(home)) fs.rmSync(path.join(home, entry), { recursive: true, force: true });
  delete process.env.DEERDAWN_DIR;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  delete process.env.CLAUDE_PROJECT_DIR;
  delete process.env.DEERDAWN_DIR;
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('a wiped ~/.deerdawn recovers by itself', () => {
  it('Claude Code: the token in ~/.claude/CLAUDE.md is adopted, the block is refreshed in place, never doubled, and status stops saying "another install"', () => {
    write('.claude.json', CLAUDE_REGISTERED);
    write('.claude/CLAUDE.md', `${MINE}\n${claudeBlock(T1)}\n`);

    autoConfigureHooks({ tool: 'claude_code' });
    autoConfigureHooks({ tool: 'claude_code' });

    expect(installToken()).toBe(T1);
    const after = read('.claude/CLAUDE.md');
    expect(count(after, T1)).toBe(1);
    expect(after).toBe(`${MINE}\n${buildOnDiskInstructionBlock([], T1).trimEnd()}\n`);
    expect(after).not.toContain('an older copy');
    expect(statusOf('claude_code').foreign_block ?? null).toBeNull();
  });

  it('Codex: ~/.codex/AGENTS.md', () => {
    write('.codex/config.toml', CODEX_REGISTERED);
    write('.codex/AGENTS.md', `${MINE}\n${claudeBlock(T1)}\n`);

    autoConfigureHooks({ tool: 'codex' });

    expect(installToken()).toBe(T1);
    expect(read('.codex/AGENTS.md')).toBe(`${MINE}\n${buildOnDiskInstructionBlock(['hosted'], T1).trimEnd()}\n`);
  });

  it('Cursor: the global rule', () => {
    write('.cursor/mcp.json', JSON.stringify({ mcpServers: { deerdawn: { url: 'https://api.deerdawn.com/mcp' } } }));
    write('.cursor/rules/deerdawn.mdc', `${CURSOR_FRONTMATTER}${buildCursorInstructionBlock(T1).trimEnd()}\n`);

    autoConfigureHooks({ tool: 'cursor' });

    expect(installToken()).toBe(T1);
    expect(count(read('.cursor/rules/deerdawn.mdc'), T1)).toBe(1);
  });

  it('an install.json that is there but unreadable counts as no token', () => {
    write('.claude.json', CLAUDE_REGISTERED);
    write('.deerdawn/install.json', '');
    write('.claude/CLAUDE.md', `${MINE}\n${claudeBlock(T1)}\n`);

    autoConfigureHooks({ tool: 'claude_code' });

    expect(installToken()).toBe(T1);
    expect(count(read('.claude/CLAUDE.md'), T1)).toBe(1);
  });

  it('the first tool to boot adopts it, and every other tool\'s file then agrees', () => {
    write('.claude.json', CLAUDE_REGISTERED);
    write('.codex/config.toml', CODEX_REGISTERED);
    write('.claude/CLAUDE.md', `${MINE}\n${claudeBlock(T1)}\n`);
    write('.codex/AGENTS.md', `${MINE}\n${claudeBlock(T1)}\n`);

    autoConfigureHooks({ tool: 'claude_code' });
    autoConfigureHooks({ tool: 'codex' });

    expect(count(read('.claude/CLAUDE.md'), T1)).toBe(1);
    expect(count(read('.codex/AGENTS.md'), T1)).toBe(1);
    expect(installToken()).toBe(T1);
  });
});

describe('two machines that sync one file share one token', () => {
  it('A writes, the file is synced to B (no install.json), B adopts: alternating boots leave the file byte for byte and one block', () => {
    write('.claude.json', CLAUDE_REGISTERED);
    // A block an older version left (a boot refreshes the block and never adds
    // one, Thing 4.3): A's first boot rewrites it with A's token.
    write('.claude/CLAUDE.md', `${MINE}\n${OPEN_MARKER}\n## DeerDawn\nolder\n${CLOSE_MARKER}\n`);
    const a = path.join(home, '.deerdawn-a');
    const b = path.join(home, '.deerdawn-b');

    process.env.DEERDAWN_DIR = a;
    autoConfigureHooks({ tool: 'claude_code' });
    const tokenA = installToken(a);
    const settled = read('.claude/CLAUDE.md');
    expect(count(settled, tokenA)).toBe(1);

    process.env.DEERDAWN_DIR = b;
    autoConfigureHooks({ tool: 'claude_code' });

    expect(installToken(b)).toBe(tokenA);
    for (let round = 0; round < 3; round += 1) {
      process.env.DEERDAWN_DIR = a;
      autoConfigureHooks({ tool: 'claude_code' });
      process.env.DEERDAWN_DIR = b;
      autoConfigureHooks({ tool: 'claude_code' });
      expect(read('.claude/CLAUDE.md')).toBe(settled);
    }
    expect(count(read('.claude/CLAUDE.md'), tokenA)).toBe(1);
  });

  it('eight processes starting together on a wiped install all adopt the file\'s token', async () => {
    write('.claude/CLAUDE.md', `${MINE}\n${claudeBlock(T1)}\n`);
    const script = (at: number) => `const t=${at};while(Date.now()<t){};process.stdout.write(String(require(${JSON.stringify(SETUP_STATUS)}).getBlockToken()));`;
    for (let round = 0; round < 10; round += 1) {
      fs.rmSync(path.join(home, '.deerdawn'), { recursive: true, force: true });
      const at = Date.now() + 250;
      const tokens = await Promise.all(Array.from({ length: 8 }, () => new Promise<string>((resolve) => {
        const proc = spawn(process.execPath, ['-e', script(at)], { env: { PATH: process.env.PATH, HOME: home, DEERDAWN_HOME_DIR: home }, stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        proc.stdout.on('data', (chunk) => { out += chunk; });
        proc.on('exit', () => resolve(out));
      })));
      expect(new Set(tokens), `round ${round}`).toEqual(new Set([T1]));
    }
  }, 60_000);
});

describe('nothing is adopted when it would be a guess', () => {
  it('two different well-formed tokens in two files: neither is adopted, both are kept, both are named as several', () => {
    write('.claude.json', CLAUDE_REGISTERED);
    write('.codex/config.toml', CODEX_REGISTERED);
    write('.claude/CLAUDE.md', `${MINE}\n${claudeBlock(T1)}\n`);
    write('.codex/AGENTS.md', `${MINE}\n${claudeBlock(T2)}\n`);
    const before = [read('.claude/CLAUDE.md'), read('.codex/AGENTS.md')];

    autoConfigureHooks({ tool: 'claude_code' });
    autoConfigureHooks({ tool: 'codex' });

    expect([installToken()]).not.toContain(T1);
    expect(installToken()).not.toBe(T2);
    expect([read('.claude/CLAUDE.md'), read('.codex/AGENTS.md')]).toEqual(before);
    const summary = statusOf('claude_code').foreign_block.summary as string;
    expect(summary).toContain('managed by another DeerDawn install');
    expect(summary).toContain('several different DeerDawn installs');
    expect(summary).toContain('none was adopted automatically');
    expect(statusOf('claude_code').foreign_block.adopt_with).toContain('adopt-block claude_code');
  });

  it('two different tokens in one file: the same', () => {
    write('.claude.json', CLAUDE_REGISTERED);
    write('.claude/CLAUDE.md', `${MINE}\n${claudeBlock(T1)}\n\n${claudeBlock(T2)}\n`);
    const before = read('.claude/CLAUDE.md');

    autoConfigureHooks({ tool: 'claude_code' });

    expect([T1, T2]).not.toContain(installToken());
    expect(read('.claude/CLAUDE.md')).toBe(before);
  });

  it('the same token in two files is one token: it is adopted', () => {
    write('.claude/CLAUDE.md', `${MINE}\n${claudeBlock(T1)}\n`);
    write('.codex/AGENTS.md', `${MINE}\n${claudeBlock(T1)}\n`);

    expect(getBlockToken()).toBe(T1);
  });

  for (const [label, lookalike] of [
    ['a token nobody made', `<!-- deerdawn:auto-context not-a-token -->\n## DeerDawn\nforged\n<!-- /deerdawn:auto-context not-a-token -->\n`],
    ['a closing marker with a different token', `${openMarkerFor(T1)}\n## DeerDawn\nunclosed\n${closeMarkerFor(T2)}\n`],
    ['an opening marker with no closing one', `${openMarkerFor(T1)}\n## DeerDawn\nnever closed\n`],
    ['a pair quoted in a code fence', `\`\`\`md\n${claudeBlock(T1)}\n\`\`\`\n`],
    ['the older token-less pair', `${OPEN_MARKER}\n## DeerDawn\nold\n${CLOSE_MARKER}\n`],
  ] as const) {
    it(`a lookalike is never adopted: ${label}`, () => {
      write('.claude/CLAUDE.md', `${MINE}\n${lookalike}`);

      const token = getBlockToken() as string;

      expect(token).toMatch(/^[0-9a-f]{32}$/);
      expect(token).not.toBe(T1);
    });
  }

  it('an install that already has a token never switches to another one by itself', () => {
    const MINE_TOKEN = '3'.repeat(32);
    write('.deerdawn/install.json', JSON.stringify({ block_token: MINE_TOKEN }));
    write('.claude.json', CLAUDE_REGISTERED);
    write('.claude/CLAUDE.md', `${MINE}\n${claudeBlock(T1)}\n`);
    const before = read('.claude/CLAUDE.md');

    for (let n = 0; n < 3; n += 1) autoConfigureHooks({ tool: 'claude_code' });

    expect(installToken()).toBe(MINE_TOKEN);
    expect(read('.claude/CLAUDE.md')).toBe(before);
    expect(statusOf('claude_code').foreign_block.summary).toContain('managed by another DeerDawn install');
  });

  it('a read that cannot create (status) adopts nothing and writes nothing', () => {
    write('.claude/CLAUDE.md', `${MINE}\n${claudeBlock(T1)}\n`);

    expect(getBlockToken({ create: false })).toBeNull();
    statusOf('claude_code');

    expect(fs.existsSync(path.join(home, '.deerdawn', 'install.json'))).toBe(false);
  });
});

describe('status, before the next start', () => {
  it('names the block and says the next start adopts its token', () => {
    write('.claude.json', CLAUDE_REGISTERED);
    write('.claude/CLAUDE.md', `${MINE}\n${claudeBlock(T1)}\n`);

    const foreign = statusOf('claude_code').foreign_block;

    expect(foreign.summary).toContain('this install has no token yet');
    expect(foreign.summary).toContain('next start adopts');
    expect(foreign.adopt_with).toContain('adopt-block claude_code');
  });

  it('with a token of its own, the wording is the other-install one and offers adopt-block', () => {
    write('.deerdawn/install.json', JSON.stringify({ block_token: '3'.repeat(32) }));
    write('.claude/CLAUDE.md', `${MINE}\n${claudeBlock(T1)}\n`);

    const summary = statusOf('claude_code').foreign_block.summary as string;

    expect(summary).toContain('managed by another DeerDawn install');
    expect(summary).toContain('adopt-block claude_code');
    expect(summary).not.toContain('next start adopts');
  });
});
