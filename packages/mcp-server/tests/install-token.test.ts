import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applySurfaceSetup, inspectLocalSetupStatus } from '../../shared-context/src/setup-status.js';
import { getBlockToken } from '../src/managed-block.js';
import { buildOnDiskInstructionBlock } from '../src/on-disk-instructions.js';

/**
 * THE INSTALL TOKEN IS MADE ONCE, WHOEVER ASKS FIRST, AND IS NOT LOST EASILY.
 *
 * Token creation was not atomic: the file is created empty and then written, so a
 * second process reading in between saw no token, decided the file was damaged and
 * wrote one of its own (two different tokens in 58 of 100 lockstep rounds). With
 * a foreign-token block kept and nothing written beside it, a second token means
 * the first process's block is "another install's" on the only machine there is.
 *
 * Everything runs under a throwaway HOME (tests/setup/contain-home.ts).
 */

const SETUP_STATUS = path.resolve(__dirname, '..', '..', 'shared-context', 'src', 'setup-status.js');
let home: string;
const write = (rel: string, text: string) => {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const read = (rel: string) => fs.readFileSync(path.join(home, rel), 'utf8');

beforeEach(() => {
  home = process.env.HOME as string;
  for (const entry of fs.readdirSync(home)) fs.rmSync(path.join(home, entry), { recursive: true, force: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function child(dir: string, startAt: number): Promise<string> {
  const script = `const t=${startAt};while(Date.now()<t){};process.stdout.write(String(require(${JSON.stringify(SETUP_STATUS)}).getBlockToken()));`;
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ['-e', script], { env: { PATH: process.env.PATH, HOME: dir, DEERDAWN_HOME_DIR: dir }, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (chunk) => { out += chunk; });
    proc.on('exit', () => resolve(out));
  });
}

describe('creation is atomic', () => {
  it('eight processes asking at the same instant, forty times over: one token, every time', async () => {
    const results: string[][] = [];
    for (let round = 0; round < 40; round += 1) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-token-race-'));
      const startAt = Date.now() + 250;
      results.push(await Promise.all(Array.from({ length: 8 }, () => child(dir, startAt))));
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const split = results.filter((tokens) => new Set(tokens).size !== 1);
    expect(split.length, `rounds with more than one token: ${split.length} of 40`).toBe(0);
    for (const tokens of results) expect(tokens[0]).toMatch(/^[0-9a-f]{32}$/);
  }, 120_000);

  it('leaves no temporary file behind', () => {
    getBlockToken();
    expect(fs.readdirSync(path.join(home, '.deerdawn'))).toEqual(['install.json']);
  });
});

describe('a damaged install.json keeps its token when the token can still be read', () => {
  const TOKEN = '0123456789abcdef0123456789abcdef';

  it('truncated JSON with the token intact: the same token', () => {
    write('.deerdawn/install.json', `{\n  "block_token": "${TOKEN}",\n  "created_at": "2026-09-3`);
    expect(getBlockToken()).toBe(TOKEN);
    expect(JSON.parse(read('.deerdawn/install.json')).block_token).toBe(TOKEN);
  });

  it('an empty file is a file another process is about to fill, not a damaged one: it is waited for briefly, then replaced', () => {
    write('.deerdawn/install.json', '');
    expect(getBlockToken()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('a block from another install, for an install that has a token of its own', () => {
  const OLD = 'd'.repeat(32);
  const OWN = 'a'.repeat(32);
  const claudeMd = () => `# Notes\n\n${buildOnDiskInstructionBlock([], OLD).trimEnd()}\n`;
  const withOwnToken = () => write('.deerdawn/install.json', JSON.stringify({ block_token: OWN }));

  it('the block is kept and not doubled, and the status says how to make it this install\'s own', () => {
    write('.claude.json', JSON.stringify({ mcpServers: { deerdawn: { command: 'npx', args: ['-y', '@deerdawn/mcp-server@latest'] } } }));
    write('.claude/CLAUDE.md', claudeMd());
    withOwnToken();

    const claude = (inspectLocalSetupStatus('local_direct', { runningSurface: null } as any) as any).surfaces.find((entry: any) => entry.id === 'claude_code');

    expect(read('.claude/CLAUDE.md')).toBe(claudeMd());
    expect(claude.foreign_block.summary).toContain('managed by another DeerDawn install');
    expect(claude.foreign_block.summary).toContain('make it this install');
    expect(claude.foreign_block.adopt_with).toBe('npx -y @deerdawn/mcp-server@latest adopt-block claude_code');
  });

  it('adopt-block rewrites only the two marker lines to this install\'s token, and the next boot refreshes the block', async () => {
    write('.claude/CLAUDE.md', claudeMd());
    withOwnToken();
    const ours = getBlockToken() as string;
    expect(ours).toBe(OWN);
    const { adoptForeignBlock } = await import('../../shared-context/src/setup-status.js') as any;

    const outcome = adoptForeignBlock('claude_code');

    expect(outcome.adopted).toBe(true);
    expect(read('.claude/CLAUDE.md')).toContain(`<!-- deerdawn:auto-context ${ours}`);
    expect(read('.claude/CLAUDE.md')).toContain(`<!-- /deerdawn:auto-context ${ours} -->`);
    expect(read('.claude/CLAUDE.md')).not.toContain(OLD);
    expect(read('.claude/CLAUDE.md').startsWith('# Notes\n\n')).toBe(true);
    const claude = (inspectLocalSetupStatus('local_direct', { runningSurface: null } as any) as any).surfaces.find((entry: any) => entry.id === 'claude_code');
    expect(claude.foreign_block ?? null).toBeNull();
  });

  it('adopt-block refuses when this install already has a block, when there is no foreign block, and for another tool\'s file DeerDawn keeps none for', async () => {
    withOwnToken();
    const ours = getBlockToken() as string;
    const { adoptForeignBlock } = await import('../../shared-context/src/setup-status.js') as any;

    write('.claude/CLAUDE.md', `# Notes\n\n${buildOnDiskInstructionBlock([], OLD).trimEnd()}\n\n${buildOnDiskInstructionBlock([], ours).trimEnd()}\n`);
    expect(adoptForeignBlock('claude_code').adopted).toBe(false);
    write('.claude/CLAUDE.md', '# Notes\n');
    expect(adoptForeignBlock('claude_code').adopted).toBe(false);
    expect(adoptForeignBlock('claude_desktop').adopted).toBe(false);
  });
});
