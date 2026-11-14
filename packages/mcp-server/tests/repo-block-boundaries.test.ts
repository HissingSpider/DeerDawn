import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildContextPointer, syncProjectFiles } from '../src/project-sync.js';
import { readUserAuthoredContext, stripDeerdawnAuthoredBlocks } from '../src/first-run-import.js';

/**
 * DEERDAWN'S BLOCK IN A PERSON'S REPOSITORY FILES.
 *
 * Project sync writes a block between `<!-- deerdawn:start -->` and
 * `<!-- deerdawn:end -->` into a repo's AGENTS.md, .cursorrules and
 * .github/copilot-instructions.md, and takes it out again when the directory
 * stops matching a project. It found the block with `includes(START)` and a lazy
 * `START[\s\S]*?END` regex, neither anchored to a line: a repo whose AGENTS.md
 * DOCUMENTS the markers (this repository's own docs do) had the text between the
 * quoted START and the next END replaced, and a lone START meant the block was
 * never written at all. Taking it out collapsed every run of blank lines in the
 * whole file. First-run import stripped DeerDawn's blocks before reading a
 * person's CLAUDE.md, and treated an unterminated block as "the rest of the file
 * is ours": everything after a stray marker was left out of the import.
 *
 * The rule under test is the one the global files follow (setup-status.js
 * findManagedBlock): markers are whole lines outside a code fence, only a
 * well-formed pair is DeerDawn's, and nothing of the person's is changed, moved
 * or dropped. Three runs each. Everything runs in a temp repo under the
 * contained HOME (tests/setup/contain-home.ts), with a mocked API.
 */

const require = createRequire(import.meta.url);
const { buildLayouts, buildUnwritableLayouts, P2 } = require('../../shared-context/tests/managed-block-layouts.cjs');

const START = '<!-- deerdawn:start -->';
const END = '<!-- deerdawn:end -->';
const LAST_UPDATED = '2026-09-28T00:00:00.000Z';
const NEW = `${START}\n## DeerDawn Context\n\n${buildContextPointer('Atlas', LAST_UPDATED)}\n${END}`;

let repo: string;

function mockClient(matched = true) {
  return {
    getActiveContextByCwd: vi.fn().mockResolvedValue(matched
      ? { brief: 'Project: Atlas', project_name: 'Atlas', project_id: 'proj-1', match_kind: 'path', last_updated: LAST_UPDATED, context: { tech_stack: [] } }
      : { brief: 'x', project_name: null, project_id: null, match_kind: 'recency_fallback' }),
    getContextJson: vi.fn().mockResolvedValue({ tech_stack: [] }),
    patchProjectContext: vi.fn().mockResolvedValue(undefined),
    upsertWorkspaceEntities: vi.fn().mockResolvedValue(undefined),
    listSkills: vi.fn().mockResolvedValue([]),
  } as any;
}

const write = (rel: string, text: string) => {
  const file = path.join(repo, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8');

/** Every file in the repo, for "nothing else changed" and "no diff noise". */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(repo, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(repo);
  return out;
}

type Tool = 'claude_code' | 'codex' | 'cursor' | 'copilot';
const ALL_TOOLS: Tool[] = ['claude_code', 'codex', 'cursor', 'copilot'];

/** `tools` is full setup for those tools (their files are written, created if need be); without it, a sync only refreshes what already carries the block. */
async function threeSyncs(rel: string, matched = true, tools?: Tool[]): Promise<string[]> {
  const after: string[] = [];
  for (let n = 0; n < 3; n += 1) {
    await syncProjectFiles(mockClient(matched), repo, undefined, tools ? { tools } : {});
    after.push(fs.existsSync(path.join(repo, rel)) ? read(rel) : '<absent>');
  }
  return after;
}

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-repo-blocks-')));
  fs.mkdirSync(path.join(repo, '.git'));
  // The sync manifest lives in ~/.deerdawn under the contained HOME; start clean.
  fs.rmSync(path.join(os.homedir(), '.deerdawn'), { recursive: true, force: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(repo, { recursive: true, force: true });
});

const SYNCED: Array<[string, Tool]> = [['AGENTS.md', 'codex'], ['.cursorrules', 'cursor'], ['.github/copilot-instructions.md', 'copilot']];

for (const [rel, tool] of SYNCED) {
  describe(`project sync into the repo's ${rel}: the block is refreshed in place, or put first`, () => {
    for (const layout of buildLayouts(NEW, { open: START, close: END, prepend: true })) {
      it(layout.name, async () => {
        write(rel, layout.seeded);

        const [run1, run2, run3] = await threeSyncs(rel, true, [tool]);

        expect(run1).toBe(layout.expected);
        expect(run2).toBe(run1);
        expect(run3).toBe(run1);
      });
    }
  });

  // A boot or start_session names no tool: it refreshes a file that already
  // carries a well-formed block, and leaves every other layout alone.
  describe(`project sync that names no tool, into the repo's ${rel}: refreshed only where the block already is`, () => {
    for (const layout of buildLayouts(NEW, { open: START, close: END, prepend: true })) {
      it(layout.name, async () => {
        write(rel, layout.seeded);

        const [run1, run2, run3] = await threeSyncs(rel);

        expect(run1).toBe(layout.kind === 'pair' ? layout.expected : layout.seeded);
        expect(run2).toBe(run1);
        expect(run3).toBe(run1);
      });
    }
  });

  describe(`project sync, ${rel}: files DeerDawn cannot or must not write`, () => {

    for (const layout of buildUnwritableLayouts({ open: START, close: END })) {
      it(`${layout.name}: left byte for byte`, async () => {
        const target = write(rel, layout.seeded);
        let seededAt = target;
        if (layout.kind === 'readonly') fs.chmodSync(target, 0o444);
        else {
          seededAt = path.join(repo, 'elsewhere', path.basename(rel));
          fs.mkdirSync(path.dirname(seededAt), { recursive: true });
          fs.renameSync(target, seededAt);
          fs.symlinkSync(seededAt, target);
        }

        await threeSyncs(rel, true, [tool]);

        if (!(layout.kind === 'readonly' && process.getuid?.() === 0)) expect(fs.readFileSync(seededAt, 'utf8')).toBe(layout.seeded);
        if (layout.kind === 'readonly') fs.chmodSync(target, 0o644);
      });
    }
  });

  describe(`project sync, the directory no longer linked: DeerDawn's block leaves ${rel}, nothing else does`, () => {
    for (const layout of buildLayouts(NEW, { open: START, close: END, prepend: true })) {
      it(layout.name, async () => {
        write(rel, layout.seeded);
        // An earlier sync wrote here: that is what makes this one clean up.
        fs.mkdirSync(path.join(os.homedir(), '.deerdawn'), { recursive: true });
        fs.writeFileSync(path.join(os.homedir(), '.deerdawn', 'synced-paths.json'), JSON.stringify({ paths: { [repo]: { project_id: 'proj-1', written_at: LAST_UPDATED } } }));

        const [run1, run2, run3] = await threeSyncs(rel, false);

        expect(run1).toBe(layout.removed);
        expect(run2).toBe(run1);
        expect(run3).toBe(run1);
      });
    }
  });
}

describe('project sync into the repo\'s CLAUDE.md: only the pointer line is added, once', () => {
  for (const layout of buildLayouts('<unused>')) {
    it(layout.name, async () => {
      write('CLAUDE.md', layout.seeded);

      const [run1, run2, run3] = await threeSyncs('CLAUDE.md', true, ['claude_code']);

      expect(run1).toBe(`@.deerdawn-context.md\n\n${layout.seeded}`);
      expect(run2).toBe(run1);
      expect(run3).toBe(run1);
    });
  }
});

describe('a repeated sync of an unchanged brief leaves every file in the repo byte-identical', () => {
  it('a repo with every kind of file, including docs that describe the markers', async () => {
    const docs = buildLayouts(NEW, { open: START, close: END, prepend: true }).find((l: any) => l.name.startsWith('docs describing'));
    write('AGENTS.md', docs.seeded);
    write('.cursorrules', 'Use tabs.\n');
    write('.github/copilot-instructions.md', `# Copilot\n\n${P2}`);
    write('CLAUDE.md', '# Project\n\nKeep it simple.\n');
    write('src/index.ts', 'export {};\n');

    const all = { tools: ALL_TOOLS };
    await syncProjectFiles(mockClient(), repo, undefined, all);
    const first = snapshot();
    await syncProjectFiles(mockClient(), repo, undefined, all);
    await syncProjectFiles(mockClient(), repo, undefined, all);

    expect(snapshot()).toEqual(first);
    expect(first['AGENTS.md']).toBe(docs.expected);
  });
});

describe('first-run import reads everything the person wrote', () => {
  const MARKERS: Array<[string, string]> = [
    ['<!-- deerdawn:auto-context -->', '<!-- /deerdawn:auto-context -->'],
    [START, END],
    ['<!-- deerdawn:skills:start -->', '<!-- deerdawn:skills:end -->'],
  ];

  for (const [open, close] of MARKERS) {
    // With an empty NEW, a layout's `expected` is the file with its first
    // well-formed pair cut out, which is what the import must leave.
    for (const layout of buildLayouts('', { open, close })) {
      it(`${open}: ${layout.name}`, () => {
        const file = write('CLAUDE.md', layout.seeded);
        const oldBlock = `${open}\n## DeerDawn\nAn older copy of these instructions.\n${close}`;
        // No well-formed pair: nothing of the person's is removed, a stray
        // marker included. Every well-formed pair is DeerDawn's and goes.
        const expected = layout.kind === 'append' ? layout.seeded : layout.expected.split(oldBlock).join('');

        for (let n = 0; n < 3; n += 1) {
          expect(stripDeerdawnAuthoredBlocks(read('CLAUDE.md'))).toBe(expected);
          readUserAuthoredContext(file);
          expect(read('CLAUDE.md')).toBe(layout.seeded);
        }
      });
    }
  }

  it('a lone opening marker does not cut the rest of the file out of the import', () => {
    const file = write('CLAUDE.md', `# Notes\n\n${START}\nstray, left by an editor\n\n## Code review\n\nNever approve my own PRs, and always run the whole suite.\n`);

    const imported = readUserAuthoredContext(file) || '';

    expect(imported).toContain('Never approve my own PRs, and always run the whole suite.');
  });
});
