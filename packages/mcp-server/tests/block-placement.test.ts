import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildOnDiskInstructionBlock } from '../src/on-disk-instructions.js';
import { closeMarkerFor, openMarkerFor } from '../src/instruction-block.js';
import { findOwnedBlock, getBlockToken } from '../src/managed-block.js';

/**
 * ONLY A PAIR AT COLUMN 0, IN PLAIN TEXT, IS DEERDAWN'S BLOCK.
 *
 * A marker pair inside an indented code block (four spaces or a tab), inside a
 * fenced one, or inside an HTML comment is something a person wrote ABOUT the
 * block (a note, a tutorial, a quoted example), not the block. Adopting its token,
 * or treating it as this install's block, would overwrite what the person put
 * between the markers on the next refresh. A pair counts only when its opening
 * marker starts at column 0 of its line, outside fenced and indented code blocks
 * and outside any enclosing HTML comment.
 *
 * Everything runs under a throwaway HOME (tests/setup/contain-home.ts).
 */

const T = '5'.repeat(32);
const OWN = '6'.repeat(32);
const MINE = '# My notes\n\nSmall commits.\n';
const NOTE = 'MY NOTE: never push to main on Fridays.';
let home: string;
let repo: string;
let autoConfigureHooks: typeof import('../src/auth.js').autoConfigureHooks;

const write = (rel: string, text: string) => {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const read = (rel: string) => fs.readFileSync(path.join(home, rel), 'utf8');
const CLAUDE_REGISTERED = JSON.stringify({ mcpServers: { deerdawn: { command: 'npx', args: ['-y', '@deerdawn/mcp-server@latest'] } } });
const pair = (token: string, indent = '', inner = `## DeerDawn\n${NOTE}`) => [
  `${indent}${openMarkerFor(token)}`,
  ...inner.split('\n').map((line) => `${indent}${line}`),
  `${indent}${closeMarkerFor(token)}`,
].join('\n');

const PLACEMENTS: Array<[string, string]> = [
  ['an indented code block (four spaces)', `${MINE}\nHow the block looks:\n\n${pair(T, '    ')}\n`],
  ['an indented code block (a tab)', `${MINE}\nHow the block looks:\n\n${pair(T, '\t')}\n`],
  ['an HTML comment', `${MINE}\n<!--\nkept for later:\n${pair(T)}\n-->\n`],
  ['an HTML comment that opens on the line before the pair', `${MINE}\n<!-- old notes\n${pair(T)}\n-->\n`],
  ['a fenced code block', `${MINE}\n\`\`\`md\n${pair(T)}\n\`\`\`\n`],
  ['a block quote', `${MINE}\n${pair(T, '> ')}\n`],
  ['a list item, indented two spaces', `${MINE}\n- a note\n${pair(T, '  ')}\n`],
];

beforeAll(async () => {
  home = process.env.HOME as string;
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-placement-repo-')));
  fs.mkdirSync(path.join(repo, '.git'));
  process.env.CLAUDE_PROJECT_DIR = repo;
  process.env.DEERDAWN_API_URL = 'http://127.0.0.1:9';
  vi.resetModules();
  ({ autoConfigureHooks } = await import('../src/auth.js'));
});
beforeEach(() => {
  for (const entry of fs.readdirSync(home)) fs.rmSync(path.join(home, entry), { recursive: true, force: true });
  write('.claude.json', CLAUDE_REGISTERED);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  delete process.env.CLAUDE_PROJECT_DIR;
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('a token is never adopted from a pair that is not at column 0 in plain text', () => {
  for (const [label, text] of PLACEMENTS) {
    it(`${label}`, () => {
      write('.claude/CLAUDE.md', text);

      const token = getBlockToken() as string;

      expect(token).toMatch(/^[0-9a-f]{32}$/);
      expect(token).not.toBe(T);
    });
  }

  it('the same pair at column 0 in plain text IS adopted (the control)', () => {
    write('.claude/CLAUDE.md', `${MINE}\n${pair(T)}\n`);
    expect(getBlockToken()).toBe(T);
  });

  it('a marker indented one to three spaces is not at column 0', () => {
    write('.claude/CLAUDE.md', `${MINE}\n${pair(T, '  ')}\n`);
    expect(getBlockToken()).not.toBe(T);
  });
});

describe('and it is never treated as this install\'s block, so the note between the markers survives a refresh', () => {
  for (const [label, text] of PLACEMENTS) {
    it(`${label}`, () => {
      write('.deerdawn/install.json', JSON.stringify({ block_token: T }));
      write('.claude/CLAUDE.md', text);
      expect(findOwnedBlock(text, T)).toBeNull();

      autoConfigureHooks({ tool: 'claude_code' });
      autoConfigureHooks({ tool: 'claude_code' });

      // No block of DeerDawn's in it, and the global file is refreshed, never
      // added to (Thing 4.3): left byte for byte, the note included.
      expect(read('.claude/CLAUDE.md')).toBe(text);
    });
  }

  it('a block at column 0 after such a note is still found and refreshed, and the note is left', () => {
    const text = `${MINE}\n${pair(T, '    ')}\n\n${pair(OWN, '', '## DeerDawn\nold copy')}\n`;
    write('.deerdawn/install.json', JSON.stringify({ block_token: OWN }));
    write('.claude/CLAUDE.md', text);

    autoConfigureHooks({ tool: 'claude_code' });

    const after = read('.claude/CLAUDE.md');
    expect(after).toContain(NOTE);
    expect(after).not.toContain('old copy');
    expect(after.startsWith(`${MINE}\n${pair(T, '    ')}\n\n`)).toBe(true);
  });
});
