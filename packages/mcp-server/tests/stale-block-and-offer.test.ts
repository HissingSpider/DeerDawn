import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { applySurfaceSetup, inspectLocalSetupStatus } from '../../shared-context/src/setup-status.js';
import { buildOnDiskInstructionBlock } from '../src/on-disk-instructions.js';
import { buildCursorInstructionBlock, OPEN_MARKER, CLOSE_MARKER } from '../src/instruction-block.js';
import { removeStaleBlock } from '../src/managed-block.js';

/**
 * A STALE BLOCK IS KEPT, NAMED, AND REMOVAL IS OFFERED. A TOOL ASKED TO SET
 * ITSELF UP WITH NOTHING REGISTERED IS TOLD WHAT IS MISSING, AND WRITTEN NOTHING.
 *
 * A stale block is DeerDawn's instruction block in a tool's file with no DeerDawn
 * server registered for that tool: an order to call a tool the tool cannot see.
 * DeerDawn cannot be sure the server is not registered somewhere it cannot look
 * (a `-c` override, another repo's .cursor/mcp.json, a claude.ai connector), so
 * it never removes one on its own. It names it: which file, which tool, and the
 * command that removes it. A person runs that command.
 *
 * A tool asked to set itself up (apply_setup, complete_setup) with no server
 * registered is answered with what is missing and the global entry that fixes it.
 * Nothing is written until it is asked for by name (mode "repair").
 *
 * Everything runs under a throwaway HOME (tests/setup/contain-home.ts).
 */

const TOKEN = '0123456789abcdef0123456789abcdef';
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
const exists = (rel: string) => fs.existsSync(path.join(home, rel));

function tree(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) tree(full, base, out);
    else out[path.relative(base, full)] = fs.readFileSync(full, 'utf8');
  }
  return out;
}

const status = (): any => inspectLocalSetupStatus('local_direct', { runningSurface: null } as any);
const surfaceOf = (id: string): any => status().surfaces.find((entry: any) => entry.id === id);

const USER_TOML = 'model = "o3"\n\n[mcp_servers.other]\ncommand = "other"\n';
const GITHUB_ONLY = JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } });
const CURSOR_FRONTMATTER = '---\ndescription: DeerDawn session memory\nalwaysApply: true\n---\n\n';
const MINE_CODEX = '# Codex notes\n\nUse pnpm.\n';
const MINE_CLAUDE = '# Claude notes\n\nSmall commits.\n';

const legacyBlock = () => buildOnDiskInstructionBlock([]).trimEnd();
const tokenBlock = () => buildOnDiskInstructionBlock([], TOKEN).trimEnd();
const HAND_TYPED = '## DeerDawn\nAlways call start_session first (I pasted this from the setup page).\n';

beforeAll(async () => {
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
  write('.deerdawn/install.json', JSON.stringify({ block_token: TOKEN }));
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

describe('a stale block is named, with the file, the tool, and the command that removes it', () => {
  for (const [label, block] of [['from before the token', legacyBlock], ['with the token', tokenBlock]] as const) {
    it(`Codex, block ${label}: get_setup_status names ~/.codex/AGENTS.md and the removal, and the file is untouched`, () => {
      const agents = `${MINE_CODEX}\n${block()}\n`;
      write('.codex/config.toml', USER_TOML);
      write('.codex/AGENTS.md', agents);

      const codex = surfaceOf('codex');

      expect(codex.configured).toBe(false);
      expect(codex.degraded_reason).toBe('instructions_without_mcp_server');
      expect(codex.stale_block).toMatchObject({
        path: path.join(home, '.codex', 'AGENTS.md'),
        tool: 'codex',
        removable: true,
        remove_with: 'npx -y @deerdawn/mcp-server@latest remove-block codex',
      });
      expect(codex.stale_block.summary).toContain('~/.codex/AGENTS.md');
      expect(codex.stale_block.summary).toContain('for Codex');
      expect(codex.stale_block.summary).toContain('left as it is');
      expect(read('.codex/AGENTS.md')).toBe(agents);
    });
  }

  it('Cursor: the rule is named the same way', () => {
    write('.cursor/mcp.json', GITHUB_ONLY);
    write('.cursor/rules/deerdawn.mdc', `${CURSOR_FRONTMATTER}${buildCursorInstructionBlock(TOKEN).trimEnd()}\n`);

    const cursor = surfaceOf('cursor');

    expect(cursor.stale_block).toMatchObject({ tool: 'cursor', removable: true, remove_with: 'npx -y @deerdawn/mcp-server@latest remove-block cursor' });
    expect(cursor.stale_block.summary).toContain('~/.cursor/rules/deerdawn.mdc');
  });

  it('Claude Code: named, and says that a claude.ai connection is not recorded where DeerDawn looks, so the block may be in use', () => {
    write('.claude/CLAUDE.md', `${MINE_CLAUDE}\n${tokenBlock()}\n`);

    const claude = surfaceOf('claude_code');

    expect(claude.stale_block).toMatchObject({ tool: 'claude_code', removable: true });
    expect(claude.stale_block.summary).toContain('~/.claude/CLAUDE.md');
    expect(claude.stale_block.summary).toContain('claude.ai');
    expect(claude.stale_block.summary).toContain('keep the block');
  });

  it('a block typed or pasted by hand (no DeerDawn markers) is named, and DeerDawn offers no removal for it', () => {
    write('.codex/config.toml', USER_TOML);
    write('.codex/AGENTS.md', `${MINE_CODEX}\n${HAND_TYPED}`);

    const { stale_block: stale } = surfaceOf('codex');

    expect(stale.removable).toBe(false);
    expect(stale.remove_with).toBeNull();
    expect(stale.summary).toContain('yours to remove');
  });

  it('a tool with a DeerDawn server registered has no stale block, and one with no block has none either', () => {
    write('.codex/config.toml', `${USER_TOML}\n[mcp_servers.deerdawn]\nurl = "https://api.deerdawn.com/mcp"\n`);
    write('.codex/AGENTS.md', `${MINE_CODEX}\n${tokenBlock()}\n`);
    write('.cursor/mcp.json', GITHUB_ONLY);
    write('.cursor/rules/mine.mdc', 'Use tabs.\n');

    expect(surfaceOf('codex').stale_block ?? null).toBeNull();
    expect(surfaceOf('cursor').stale_block ?? null).toBeNull();
  });

  it('a marker quoted in the person\'s notes is not a block', () => {
    write('.codex/config.toml', USER_TOML);
    write('.codex/AGENTS.md', `Notes: DeerDawn's block sits between \`${OPEN_MARKER}\` and \`${CLOSE_MARKER}\`.\n`);

    expect(surfaceOf('codex').stale_block ?? null).toBeNull();
  });
});

describe('a boot never removes a stale block, its own tool\'s included', () => {
  for (const [tool, rel, seeded] of [
    ['codex', '.codex/AGENTS.md', () => `${MINE_CODEX}\n${legacyBlock()}\n`],
    ['cursor', '.cursor/rules/deerdawn.mdc', () => `${CURSOR_FRONTMATTER}${buildCursorInstructionBlock(TOKEN).trimEnd()}\n`],
  ] as const) {
    it(`${tool}: three boots as ${tool}, nothing registered anywhere they can see: the file is byte for byte`, () => {
      write('.codex/config.toml', USER_TOML);
      write('.cursor/mcp.json', GITHUB_ONLY);
      write(rel, seeded());

      for (let n = 0; n < 3; n += 1) autoConfigureHooks({ tool });

      expect(read(rel)).toBe(seeded());
    });
  }
});

describe('removal, when asked for', () => {
  for (const [label, block] of [['from before the token', legacyBlock], ['with the token', tokenBlock]] as const) {
    it(`Codex, block ${label}: only the block goes, every other byte stays, and a backup of the file as it was is taken`, () => {
      const above = `${MINE_CODEX}\n`;
      const below = '\n## Later\nKeep answers short.\n';
      write('.codex/config.toml', USER_TOML);
      write('.codex/AGENTS.md', `${above}${block()}\n${below}`);

      const outcome = removeStaleBlock('codex', { runningSurface: null });

      expect(outcome.removed).toBe(true);
      expect(read('.codex/AGENTS.md')).toBe(`${above}${below}`);
      expect(fs.readFileSync(outcome.backup_path as string, 'utf8')).toContain('start_session');
      expect(read('.codex/config.toml')).toBe(USER_TOML);
    });
  }

  it('Cursor: the block goes from the rule and the rest of the file stays', () => {
    write('.cursor/mcp.json', GITHUB_ONLY);
    write('.cursor/rules/deerdawn.mdc', `${CURSOR_FRONTMATTER}${buildCursorInstructionBlock(TOKEN).trimEnd()}\n`);

    const outcome = removeStaleBlock('cursor', { runningSurface: null });

    expect(outcome.removed).toBe(true);
    expect(read('.cursor/rules/deerdawn.mdc')).toBe(CURSOR_FRONTMATTER);
  });

  it('a second request finds nothing to remove and says so', () => {
    write('.codex/config.toml', USER_TOML);
    write('.codex/AGENTS.md', `${MINE_CODEX}\n${tokenBlock()}\n`);
    removeStaleBlock('codex', { runningSurface: null });

    const again = removeStaleBlock('codex', { runningSurface: null });

    expect(again.removed).toBe(false);
    expect(again.reason).toMatch(/no block that DeerDawn wrote/);
  });

  it('a tool with a DeerDawn server registered is not stale: the block is in use and stays', () => {
    write('.codex/config.toml', `${USER_TOML}\n[mcp_servers.deerdawn]\nurl = "https://api.deerdawn.com/mcp"\n`);
    const agents = `${MINE_CODEX}\n${tokenBlock()}\n`;
    write('.codex/AGENTS.md', agents);

    const outcome = removeStaleBlock('codex', { runningSurface: null });

    expect(outcome.removed).toBe(false);
    expect(outcome.reason).toMatch(/has a DeerDawn server registered/);
    expect(read('.codex/AGENTS.md')).toBe(agents);
  });

  it('a block typed by hand is never removed: DeerDawn did not write it', () => {
    write('.codex/config.toml', USER_TOML);
    const agents = `${MINE_CODEX}\n${HAND_TYPED}`;
    write('.codex/AGENTS.md', agents);

    const outcome = removeStaleBlock('codex', { runningSurface: null });

    expect(outcome.removed).toBe(false);
    expect(read('.codex/AGENTS.md')).toBe(agents);
  });

  it('a lookalike pair around somebody else\'s text is never removed', () => {
    write('.codex/config.toml', USER_TOML);
    const agents = `${MINE_CODEX}\n${OPEN_MARKER}\nA tutorial.\n${CLOSE_MARKER}\n`;
    write('.codex/AGENTS.md', agents);

    expect(removeStaleBlock('codex', { runningSurface: null }).removed).toBe(false);
    expect(read('.codex/AGENTS.md')).toBe(agents);
  });

  it('a symlinked file is refused, and a tool DeerDawn keeps no block for is explained', () => {
    write('.codex/config.toml', USER_TOML);
    const target = write('dotfiles/AGENTS.md', `${MINE_CODEX}\n${tokenBlock()}\n`);
    fs.symlinkSync(target, path.join(home, '.codex', 'AGENTS.md'));

    const outcome = removeStaleBlock('codex', { runningSurface: null });

    expect(outcome.removed).toBe(false);
    expect(outcome.reason).toMatch(/symlink/);
    expect(fs.readFileSync(target, 'utf8')).toContain('start_session');
    expect(removeStaleBlock('claude_desktop', { runningSurface: null }).reason).toMatch(/keeps no instruction block/);
  });
});

describe('a tool asked to set itself up with no DeerDawn server registered: what is missing, the global entry, and nothing written', () => {
  const CASES: Array<{ surface: string; missing: RegExp; entry: () => string; command: RegExp; canWrite: boolean }> = [
    { surface: 'claude_code', missing: /no DeerDawn server registered in ~\/\.claude\.json or a project \.mcp\.json/, entry: () => path.join(home, '.claude.json'), command: /claude mcp add -s user/, canWrite: false },
    { surface: 'cursor', missing: /no DeerDawn server registered in ~\/\.cursor\/mcp\.json/, entry: () => path.join(home, '.cursor', 'mcp.json'), command: /~\/\.cursor\/mcp\.json/, canWrite: true },
    { surface: 'codex', missing: /registers no DeerDawn server/, entry: () => path.join(home, '.codex', 'config.toml'), command: /codex mcp add deerdawn --url/, canWrite: true },
    { surface: 'claude_desktop', missing: /has no DeerDawn server for Claude Desktop/, entry: () => path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), command: /claude_desktop_config\.json/, canWrite: true },
  ];

  for (const { surface, missing, entry, command, canWrite } of CASES) {
    for (const mode of canWrite ? (['auto'] as const) : (['auto', 'repair'] as const)) {
      it(`${surface}, mode ${mode}: nothing under HOME changes, and the answer explains and offers`, () => {
        write('.codex/config.toml', USER_TOML);
        write('.codex/AGENTS.md', MINE_CODEX);
        write('.claude/CLAUDE.md', MINE_CLAUDE);
        write('.cursor/mcp.json', GITHUB_ONLY);
        const before = tree(home);

        const result = applySurfaceSetup(surface, mode) as any;

        expect(tree(home)).toEqual(before);
        expect(result.applied).toBe(false);
        expect(result.already_configured).toBe(false);
        expect(result.changed_paths).toEqual([]);
        expect(result.reason).toMatch(missing);
        expect(result.reason).toMatch(/nothing was written/);
        expect(result.next_step).toMatch(command);
        expect(result.offer.global_entry).toBe(entry());
        expect(result.offer.command).toMatch(command);
        if (canWrite) {
          expect(result.next_step).toContain(`apply_setup again with surface "${surface}" and mode "repair"`);
          expect(result.offer.write_with).toEqual({ tool: 'apply_setup', surface, mode: 'repair' });
        } else {
          expect(result.offer.write_with).toBeNull();
        }
      });
    }
  }

  it('claude_code\'s answer says a claude.ai connection is not recorded in either file', () => {
    const result = applySurfaceSetup('claude_code', 'auto') as any;
    expect(result.reason).toContain('claude.ai');
  });

  it('asked for by name (repair), cursor, codex and claude_desktop get the entry written', () => {
    for (const surface of ['cursor', 'codex', 'claude_desktop']) {
      const result = applySurfaceSetup(surface, 'repair') as any;
      expect(result.applied, surface).toBe(true);
      expect(result.status.surfaces.find((entry: any) => entry.id === surface).configured, surface).toBe(true);
    }
  });

  it('with a registration in place the answer is the no-op it always was, and offers nothing', () => {
    write('.codex/config.toml', `${USER_TOML}\n[mcp_servers.deerdawn]\nurl = "https://api.deerdawn.com/mcp"\n`);
    const before = tree(home);

    const result = applySurfaceSetup('codex', 'auto') as any;

    expect(result.already_configured).toBe(true);
    expect(result.offer).toBeUndefined();
    expect(tree(home)).toEqual(before);
  });

  it('complete_setup(claude_code) with nothing registered: completed is false and the next action is the command', async () => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    vi.doMock('../src/tools/context-sync.js', async () => {
      const actual = await vi.importActual<any>('../src/tools/context-sync.js');
      return { ...actual, handleContextSyncTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'No local context files found.' }] }) };
    });
    write('.claude/CLAUDE.md', MINE_CLAUDE);
    const before = tree(home);
    // complete_setup points DEERDAWN_HOME_DIR at a shared temp directory under test
    // when it is unset; this test's own HOME is what must stay unchanged.
    process.env.DEERDAWN_HOME_DIR = home;
    process.env.DEERDAWN_DIR = path.join(home, '.deerdawn');
    try {
      const { handleAuthTool } = await import('../src/tools/auth.js');
      const payload = JSON.parse(((await handleAuthTool('complete_setup', { surface: 'claude_code' })) as any).content[0].text);

      expect(payload.completed).toBe(false);
      expect(payload.setup.applied).toBe(false);
      expect(payload.nextAction).toMatch(/nothing was written/);
      expect(payload.nextAction).toMatch(/claude mcp add -s user/);
      expect(exists('.claude/settings.json')).toBe(false);
      expect(read('.claude/CLAUDE.md')).toBe(MINE_CLAUDE);
      expect(Object.keys(tree(home)).filter((file) => !(file in before))).toEqual([]);
    } finally {
      vi.doUnmock('../src/tools/context-sync.js');
      vi.unstubAllGlobals();
      delete process.env.DEERDAWN_HOME_DIR;
      delete process.env.DEERDAWN_DIR;
    }
  });
});
