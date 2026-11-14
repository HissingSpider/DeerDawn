import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildOnDiskInstructionBlock } from '../src/on-disk-instructions.js';
import { buildCursorInstructionBlock, openMarkerFor, closeMarkerFor } from '../src/instruction-block.js';
import { findOwnedBlock } from '../src/managed-block.js';

/**
 * WHERE DEERDAWN'S BLOCK IS, IN A FILE THAT IS THE PERSON'S.
 *
 * Every boot refreshes DeerDawn's block in ~/.claude/CLAUDE.md (and, when that
 * tool has DeerDawn registered, in ~/.codex/AGENTS.md and
 * ~/.cursor/rules/deerdawn.mdc). The block was found with indexOf(OPEN_MARKER)
 * and indexOf(CLOSE_MARKER), the second searched from the START of the file and
 * neither anchored to a line. Observed in a walk (2026-09-28):
 *   - A note of the person's own that QUOTES the opening marker in prose, above
 *     their "## Code review" section: one boot deleted everything from the quote
 *     to the real block's closing marker, their section included.
 *   - A lone opening marker left by an editor that hides HTML comments: boot 1
 *     appended a block, boot 2 deleted the person's text between the stray
 *     marker and the new block.
 *   - A lone closing marker, or one before the opening marker: every boot
 *     duplicated the person's section and appended another block (2,630 to
 *     10,133 bytes in three boots).
 *
 * The rule under test: a marker is a line that is exactly that marker (outside a
 * code fence), and DeerDawn's block is the first closing marker line with an
 * opening marker line before it, paired with the nearest such opening line. Only
 * that span is replaced. With no such pair the block is appended. Text outside
 * the span is never modified, moved or duplicated, and boot 2 and boot 3 leave
 * the file byte-identical to boot 1.
 *
 * Everything runs under a throwaway HOME, with the API on a closed local port.
 */

const require = createRequire(import.meta.url);
const { buildLayouts, buildUnwritableLayouts, OLD } = require('../../shared-context/tests/managed-block-layouts.cjs');

// This install's block token, fixed for the file (written to install.json before
// every case) so the layouts, built when the file is collected, can name it.
const TOKEN = '0123456789abcdef0123456789abcdef';
const TOKEN_OPEN = openMarkerFor(TOKEN);
const TOKEN_CLOSE = closeMarkerFor(TOKEN);

let home: string;
let repo: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['HOME', 'USERPROFILE', 'CLAUDE_PROJECT_DIR', 'DEERDAWN_HOME_DIR', 'DEERDAWN_DIR', 'DEERDAWN_API_KEY', 'DEERDAWN_API_URL', 'DEERDAWN_SURFACE_ID', 'CODEX_HOME'];
let autoConfigureHooks: typeof import('../src/auth.js').autoConfigureHooks;

function write(rel: string, content: string): string {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}
const read = (rel: string) => fs.readFileSync(path.join(home, rel), 'utf8');

type FileCase = {
  label: string;
  rel: string;
  /** The tool whose boot refreshes this file, and no other's does. */
  tool: 'claude_code' | 'codex' | 'cursor';
  /** The block a boot writes into this file when the tool is registered. */
  block: () => string;
  register: () => void;
  unregister: () => void;
};

const FILES: FileCase[] = [
  {
    label: '~/.claude/CLAUDE.md',
    rel: '.claude/CLAUDE.md',
    tool: 'claude_code',
    // Nothing in ~/.claude.json and no .mcp.json: fitted to the local server.
    block: () => buildOnDiskInstructionBlock([], TOKEN).trimEnd(),
    register: () => {},
    unregister: () => {},
  },
  {
    label: '~/.codex/AGENTS.md',
    rel: '.codex/AGENTS.md',
    tool: 'codex',
    block: () => buildOnDiskInstructionBlock(['hosted'], TOKEN).trimEnd(),
    register: () => { write('.codex/config.toml', 'model = "o3"\n\n[mcp_servers.deerdawn]\nurl = "https://api.deerdawn.com/mcp"\n'); },
    unregister: () => { write('.codex/config.toml', 'model = "o3"\n'); },
  },
  {
    label: '~/.cursor/rules/deerdawn.mdc',
    rel: '.cursor/rules/deerdawn.mdc',
    tool: 'cursor',
    block: () => buildCursorInstructionBlock(TOKEN).trimEnd(),
    register: () => { write('.cursor/mcp.json', JSON.stringify({ mcpServers: { deerdawn: { url: 'https://api.deerdawn.com/mcp' } } })); },
    unregister: () => { write('.cursor/mcp.json', JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } })); },
  },
];

/**
 * What a boot leaves. ~/.claude/CLAUDE.md is REFRESHED and never added to
 * (Thing 4.3, autoConfigureHooks): a layout with no block of DeerDawn's in it
 * is left byte for byte, where the other two files get the block appended.
 */
function expectedAfterBoot(file: FileCase, layout: { seeded: string; expected: string }): string {
  if (file.rel === '.claude/CLAUDE.md' && !findOwnedBlock(layout.seeded, TOKEN)) return layout.seeded;
  return layout.expected;
}

/** Three boots, as the tool whose file this is, returning the file after each. */
function threeBoots(rel: string, tool: FileCase['tool']): string[] {
  const after: string[] = [];
  for (let n = 0; n < 3; n += 1) {
    autoConfigureHooks({ tool });
    after.push(read(rel));
  }
  return after;
}

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-block-bounds-home-')));
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-block-bounds-repo-')));
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CLAUDE_PROJECT_DIR = repo;
  process.env.DEERDAWN_HOME_DIR = home;
  process.env.DEERDAWN_DIR = path.join(home, '.deerdawn');
  delete process.env.DEERDAWN_API_KEY;
  process.env.DEERDAWN_API_URL = 'http://127.0.0.1:9';
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  vi.resetModules();
  ({ autoConfigureHooks } = await import('../src/auth.js'));
});

beforeEach(() => {
  for (const entry of fs.readdirSync(home)) {
    const full = path.join(home, entry);
    // A read-only file from an earlier case would survive rmSync's force on some platforms.
    try { fs.chmodSync(full, 0o755); } catch { /* gone already */ }
    fs.rmSync(full, { recursive: true, force: true });
  }
  write('.deerdawn/credentials.json', JSON.stringify({ api_key: 'dd_test_key' }));
  write('.deerdawn/install.json', JSON.stringify({ block_token: TOKEN }));
  fs.mkdirSync(path.join(home, '.cursor', 'rules'), { recursive: true });
  process.env.DEERDAWN_SURFACE_ID = 'claude_code';
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
  for (const dir of [home, repo]) {
    try { fs.chmodSync(path.join(dir, '.claude', 'CLAUDE.md'), 0o644); } catch { /* not there */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const file of FILES) {
  // The block an older version wrote, with the markers before the token, is
  // recognised once and rewritten with the token; the person's text around it is
  // not touched. Every layout below is seeded with that older pair.
  describe(`${file.label}, the tool registered: a block from before the token is migrated in place`, () => {
    for (const layout of buildLayouts(file.block(), { strict: true })) {
      it(`${layout.name}`, () => {
        file.register();
        write(file.rel, layout.seeded);

        const [boot1, boot2, boot3] = threeBoots(file.rel, file.tool);

        expect(boot1).toBe(expectedAfterBoot(file, layout));
        expect(boot2).toBe(boot1);
        expect(boot3).toBe(boot1);
      });
    }
  });

  // The same layouts with the markers a version with the token writes: only the
  // pair carrying this install's token is the block.
  describe(`${file.label}, the tool registered: the block carrying the token is refreshed in place`, () => {
    for (const layout of buildLayouts(file.block(), { open: TOKEN_OPEN, close: TOKEN_CLOSE, strict: true })) {
      it(`${layout.name}`, () => {
        file.register();
        write(file.rel, layout.seeded);

        const [boot1, boot2, boot3] = threeBoots(file.rel, file.tool);

        expect(boot1).toBe(expectedAfterBoot(file, layout));
        expect(boot2).toBe(boot1);
        expect(boot3).toBe(boot1);
      });
    }

    for (const layout of buildUnwritableLayouts()) {
      it(`${layout.name}: left byte for byte`, () => {
        file.register();
        const { seededAt, done } = seedUnwritable(file.rel, layout);
        // Root can write a 0444 file; that is not a case a person's machine has.
        const rootCanWrite = layout.kind === 'readonly' && typeof process.getuid === 'function' && process.getuid() === 0;

        const [boot1, boot2, boot3] = threeBoots(file.rel, file.tool);

        if (!rootCanWrite) expect(fs.readFileSync(seededAt, 'utf8')).toBe(layout.seeded);
        expect(boot2).toBe(boot1);
        expect(boot3).toBe(boot1);
        done();
      });
    }
  });
}

/**
 * Seed a layout DeerDawn cannot or must not write: a 0444 file, or a symlink
 * into a dotfiles repo (DeerDawn refuses to write through a symlink, see
 * utils/safe-fs.ts). Returns where the seeded bytes really live.
 */
function seedUnwritable(rel: string, layout: { kind: string; seeded: string }): { seededAt: string; done: () => void } {
  const target = write(rel, layout.seeded);
  if (layout.kind === 'readonly') {
    fs.chmodSync(target, 0o444);
    return { seededAt: target, done: () => fs.chmodSync(target, 0o644) };
  }
  const seededAt = path.join(home, 'dotfiles', path.basename(rel));
  fs.mkdirSync(path.dirname(seededAt), { recursive: true });
  fs.renameSync(target, seededAt);
  fs.symlinkSync(seededAt, target);
  return { seededAt, done: () => expect(fs.lstatSync(target).isSymbolicLink()).toBe(true) };
}

// CLAUDE.md is refreshed on every boot, whatever is registered (whether it
// should be is with the owner), so it has no unregistered path.
for (const file of FILES.filter((f) => f.rel !== '.claude/CLAUDE.md')) {
  describe(`${file.label}, the tool not registered anywhere this boot can see: nothing is written or removed`, () => {
    for (const layout of buildLayouts(file.block(), { strict: true })) {
      it(`${layout.name}`, () => {
        file.unregister();
        write(file.rel, layout.seeded);

        const [boot1, boot2, boot3] = threeBoots(file.rel, file.tool);

        expect(boot1).toBe(layout.seeded);
        expect(boot2).toBe(layout.seeded);
        expect(boot3).toBe(layout.seeded);
      });
    }

    for (const layout of buildUnwritableLayouts()) {
      it(`${layout.name}`, () => {
        file.unregister();
        const { seededAt, done } = seedUnwritable(file.rel, layout);

        threeBoots(file.rel, file.tool);

        expect(fs.readFileSync(seededAt, 'utf8')).toBe(layout.seeded);
        done();
      });
    }
  });
}

describe('the stories, as the walker told them', () => {
  const block = () => buildOnDiskInstructionBlock([], TOKEN).trimEnd();

  it('Story A: a quoted opening marker above "## Code review" costs the person nothing', () => {
    const note = 'DeerDawn keeps its block between `<!-- deerdawn:auto-context -->` and its closing marker; leave it alone.\n';
    const mine = `# Notes\n${note}\n## Code review\n\nNever approve my own PRs.\n`;
    write('.claude/CLAUDE.md', `${mine}\n${OLD}\n`);

    const [boot1] = threeBoots('.claude/CLAUDE.md', 'claude_code');

    expect(boot1.startsWith(mine)).toBe(true);
    expect(boot1).toBe(`${mine}\n${block()}\n`);
  });

  it('Story B: a lone closing marker does not grow the file boot after boot', () => {
    const mine = `# Notes\n\n${'<!-- /deerdawn:auto-context -->'}\n\n## Code review\n\nNever approve my own PRs.\n`;
    write('.claude/CLAUDE.md', mine);

    const sizes = threeBoots('.claude/CLAUDE.md', 'claude_code').map((text) => text.length);

    // No block of DeerDawn's in it, so nothing is added (Thing 4.3).
    expect(read('.claude/CLAUDE.md')).toBe(mine);
    expect(new Set(sizes).size).toBe(1);
  });
});
