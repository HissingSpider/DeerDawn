import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildOnDiskInstructionBlock } from '../src/on-disk-instructions.js';
import {
  BLOCK_NOTICE,
  MARKER_NAME_PREFIX,
  OPEN_MARKER,
  CLOSE_MARKER,
  closeMarkerFor,
  openMarkerFor,
} from '../src/instruction-block.js';
import { stripDeerdawnAuthoredBlocks } from '../src/first-run-import.js';
import { findOwnedBlock, getBlockToken } from '../src/managed-block.js';

/**
 * WHAT COUNTS AS DEERDAWN'S BLOCK IN A PERSON'S FILE.
 *
 * The block sits between two markers in a file that is the person's, and DeerDawn
 * replaces what is between them on every boot. The markers used to be one fixed
 * pair of comments that anybody, or any other tool, can type: a tutorial pasted
 * into CLAUDE.md, another tool's copy of ours, a hand-typed lookalike. Each was
 * "DeerDawn's block" and got rewritten.
 *
 * Now the markers carry a token made once for this install and kept in
 * ~/.deerdawn/install.json. A pair counts as ours only with that token. The
 * pair older versions wrote (no token) is recognised once, to migrate a file
 * upgraded from one of them, and only when what sits between the markers holds
 * the "## DeerDawn" heading every block DeerDawn ever wrote has.
 *
 * Everything runs under a throwaway HOME (tests/setup/contain-home.ts).
 */

let home: string;
let repo: string;
let autoConfigureHooks: typeof import('../src/auth.js').autoConfigureHooks;

const write = (rel: string, text: string) => {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const read = (rel: string) => fs.readFileSync(path.join(home, rel), 'utf8');

const CLAUDE_MD = '.claude/CLAUDE.md';
const MINE = '# My notes\n\nUse pnpm. Never force-push.\n';
const boot = () => autoConfigureHooks({ tool: 'claude_code' });
const token = () => JSON.parse(read('.deerdawn/install.json')).block_token as string;
/** What a boot writes here, for the token on disk. */
const ours = () => buildOnDiskInstructionBlock([], token()).trimEnd();
/**
 * A file that already holds this install's block, as an earlier version left it.
 * A boot only REFRESHES the block in ~/.claude/CLAUDE.md and never adds one
 * (Thing 4.3), so the cases about a block that is there start from one.
 */
const settle = (before = MINE) => {
  getBlockToken();
  write(CLAUDE_MD, `${before}\n${ours()}\n`);
  boot();
};

beforeAll(async () => {
  home = process.env.HOME as string;
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-identity-repo-')));
  fs.mkdirSync(path.join(repo, '.git'));
  process.env.CLAUDE_PROJECT_DIR = repo;
  process.env.DEERDAWN_API_URL = 'http://127.0.0.1:9';
  vi.resetModules();
  ({ autoConfigureHooks } = await import('../src/auth.js'));
});

beforeEach(() => {
  for (const entry of fs.readdirSync(home)) fs.rmSync(path.join(home, entry), { recursive: true, force: true });
  write('.deerdawn/credentials.json', JSON.stringify({ api_key: 'dd_test_key' }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  delete process.env.CLAUDE_PROJECT_DIR;
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('the install token', () => {
  it('is made once, is 128 random bits in hex, and is kept in DeerDawn\'s own config, readable by the owner only', () => {
    expect(getBlockToken({ create: false })).toBeNull();

    const first = getBlockToken();
    const second = getBlockToken();

    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).toBe(first);
    expect(token()).toBe(first);
    expect(fs.statSync(path.join(home, '.deerdawn', 'install.json')).mode & 0o777).toBe(0o600);
  });

  it('differs between installs', () => {
    const a = getBlockToken();
    fs.rmSync(path.join(home, '.deerdawn', 'install.json'));
    expect(getBlockToken()).not.toBe(a);
  });

  it('a damaged file is replaced, and one that cannot be written gives no token (so no block is written)', () => {
    write('.deerdawn/install.json', '{ not json');
    expect(getBlockToken()).toMatch(/^[0-9a-f]{32}$/);

    // ~/.deerdawn/install.json is a directory: nothing can be stored there.
    fs.rmSync(path.join(home, '.deerdawn', 'install.json'));
    fs.mkdirSync(path.join(home, '.deerdawn', 'install.json'));
    expect(getBlockToken()).toBeNull();

    write(CLAUDE_MD, MINE);
    boot();
    expect(read(CLAUDE_MD)).toBe(MINE);
  });
});

describe('the block says what happens to edits inside it', () => {
  it('its first line is the opening marker, and says in plain words that edits are replaced', () => {
    settle();

    const block = read(CLAUDE_MD).slice(MINE.length).trimStart();
    const [first] = block.split('\n');

    expect(first.startsWith(`${MARKER_NAME_PREFIX} ${token()}`)).toBe(true);
    expect(first).toContain('DeerDawn replaces anything edited between this line and the closing marker');
    expect(first).toContain(BLOCK_NOTICE);
    expect(block.trimEnd().endsWith(`<!-- /deerdawn:auto-context ${token()} -->`)).toBe(true);
  });

  it('an edit made inside the block is replaced on the next boot, and the person\'s own text is not', () => {
    settle();
    const settled = read(CLAUDE_MD);
    write(CLAUDE_MD, settled.replace('## DeerDawn\n', '## DeerDawn\nMY EDIT: skip start_session on Fridays.\n'));
    expect(read(CLAUDE_MD)).toContain('MY EDIT');

    boot();

    expect(read(CLAUDE_MD)).toBe(settled);
    expect(read(CLAUDE_MD).startsWith(MINE)).toBe(true);
  });

  it('the words can change in a later version: a block written with other words is still found by its token', () => {
    settle();
    const t = token();
    const reworded = read(CLAUDE_MD).replace(BLOCK_NOTICE, 'Old wording of the notice.');
    expect(reworded).not.toBe(read(CLAUDE_MD));
    write(CLAUDE_MD, reworded);

    boot();

    expect(read(CLAUDE_MD)).toContain(BLOCK_NOTICE);
    expect(read(CLAUDE_MD).match(new RegExp(`<!-- deerdawn:auto-context ${t}`, 'g'))).toHaveLength(1);
  });
});

describe('a block that merely looks like ours is never treated as ours', () => {
  it('the older markers around somebody else\'s text (no DeerDawn heading): left byte for byte, nothing added', () => {
    const lookalike = `${OPEN_MARKER}\nA tutorial on how tools mark their blocks.\nNever delete this.\n${CLOSE_MARKER}\n`;
    write(CLAUDE_MD, `${MINE}\n${lookalike}`);

    boot();
    boot();

    // Not DeerDawn's, so not refreshed; and a boot never ADDS a block here.
    expect(read(CLAUDE_MD)).toBe(`${MINE}\n${lookalike}`);
  });

  it('a well-formed pair with another install\'s token (a CLAUDE.md synced between two machines): kept, and no second block is added', () => {
    const other = 'f'.repeat(32);
    const foreign = `${openMarkerFor(other)}\n## DeerDawn\nWritten by the other machine.\n${closeMarkerFor(other)}\n`;
    write(CLAUDE_MD, `${MINE}\n${foreign}`);
    // This install already has a token of its own: it never takes another's by itself.
    write('.deerdawn/install.json', JSON.stringify({ block_token: '0123456789abcdef0123456789abcdef' }));

    boot();
    boot();

    expect(read(CLAUDE_MD)).toBe(`${MINE}\n${foreign}`);
    expect(findOwnedBlock(foreign, token())).toBeNull();
  });

  it('markers with the token\'s shape but a token nobody made are a lookalike: left alone, nothing added', () => {
    const forged = `<!-- deerdawn:auto-context not-a-token -->\n## DeerDawn\nforged\n<!-- /deerdawn:auto-context not-a-token -->\n`;
    write(CLAUDE_MD, `${MINE}\n${forged}`);

    boot();

    expect(read(CLAUDE_MD)).toBe(`${MINE}\n${forged}`);
  });

  it('the token pair is found first: a second, older-looking pair elsewhere is the person\'s and stays', () => {
    settle();
    const settled = read(CLAUDE_MD);
    const quoted = `\n${OPEN_MARKER}\n## DeerDawn\nQuoted from an old README.\n${CLOSE_MARKER}\n`;
    write(CLAUDE_MD, settled + quoted);

    boot();

    expect(read(CLAUDE_MD)).toBe(settled + quoted);
  });
});

describe('a block from before the token is recognised once', () => {
  it('rewritten with the token in place, the person\'s text above and below it untouched, and stable afterwards', () => {
    const below = '\n## Reviews\nNever approve my own PRs.\n';
    const old = `${OPEN_MARKER}\n## DeerDawn\nAn older copy of these instructions.\n${CLOSE_MARKER}`;
    write(CLAUDE_MD, `${MINE}\n${old}\n${below}`);

    boot();
    const once = read(CLAUDE_MD);
    boot();

    expect(once).toBe(`${MINE}\n${ours()}\n${below}`);
    expect(once).not.toContain(OPEN_MARKER);
    expect(read(CLAUDE_MD)).toBe(once);
  });

  it('an old block the person edited is still the block DeerDawn wrote, and is replaced', () => {
    const old = `${OPEN_MARKER}\nMY OWN NOTE: never push to main on Fridays.\n## DeerDawn\nOlder copy.\n${CLOSE_MARKER}`;
    write(CLAUDE_MD, `${MINE}\n${old}\n`);

    boot();

    expect(read(CLAUDE_MD)).toBe(`${MINE}\n${ours()}\n`);
  });
});

describe('what the rest of the package reads', () => {
  it('first-run import strips a block with this install\'s token, another install\'s, and the older pair, and nothing else', () => {
    const other = 'a'.repeat(32);
    const project = 'Atlas replaced the batch importer with a streaming one last quarter.';
    const text = [
      project,
      buildOnDiskInstructionBlock([], 'b'.repeat(32)).trimEnd(),
      'Between.',
      buildOnDiskInstructionBlock([], other).trimEnd(),
      `${OPEN_MARKER}\n## DeerDawn\nold\n${CLOSE_MARKER}`,
      'After.',
    ].join('\n');

    const stripped = stripDeerdawnAuthoredBlocks(text);

    expect(stripped).toContain(project);
    expect(stripped).toContain('Between.');
    expect(stripped).toContain('After.');
    expect(stripped).not.toContain('start_session');
    expect(stripped).not.toContain('deerdawn:auto-context');
  });
});
