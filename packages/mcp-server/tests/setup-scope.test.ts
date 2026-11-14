import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { applySurfaceSetup, inspectLocalSetupStatus } from '../../shared-context/src/setup-status.js';
import { removePlainTextKeys } from '../src/managed-block.js';
import { syncProjectFiles } from '../src/project-sync.js';

/**
 * SETUP CONFIGURES ONLY THE TOOL THE PERSON CHOSE.
 *
 * It used to write files of tools the person had not chosen to set up from where
 * they were:
 *   - apply_setup(claude_desktop) also wrote DeerDawn's block into Claude Code's
 *     ~/.claude/CLAUDE.md;
 *   - apply_setup(claude_code) put the DeerDawn API key, in plain text, in
 *     ~/.claude/settings.json, a file Claude Code does not read servers from;
 *   - a boot inside any tool wrote Claude Code's hooks and CLAUDE.md, and a boot
 *     inside Claude Code refreshed Codex's AGENTS.md and Cursor's rule.
 *   - `setup` synced the project files of every tool.
 * Now each writer touches its own tool's files. A key written to a file by an
 * older version is named and offered for removal, never deleted unasked.
 *
 * Everything runs under a throwaway HOME (tests/setup/contain-home.ts).
 */

const KEY = 'dd_live_PLAINTEXT_KEY_1234567890';
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

/** Every file under `dir` -> its text, for "nothing else changed". */
function tree(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) tree(full, base, out);
    else out[path.relative(base, full)] = fs.readFileSync(full, 'utf8');
  }
  return out;
}

/** The files under HOME that carry the key, other than DeerDawn's own credentials. */
function filesHoldingKey(): string[] {
  return Object.entries(tree(home))
    .filter(([file, text]) => text.includes(KEY) && !file.startsWith(`.deerdawn${path.sep}credentials`))
    .map(([file]) => file);
}

const CLAUDE_REGISTERED = JSON.stringify({ mcpServers: { deerdawn: { command: 'npx', args: ['-y', '@deerdawn/mcp-server@latest'] } } });
const CODEX_REGISTERED = 'model = "o3"\n\n[mcp_servers.deerdawn]\nurl = "https://api.deerdawn.com/mcp"\n';
const CURSOR_REGISTERED = JSON.stringify({ mcpServers: { deerdawn: { url: 'https://api.deerdawn.com/mcp' } } });
const USER_CLAUDE = '# Claude notes\nSmall commits.\n';
const USER_AGENTS = '# Codex notes\nBe terse.\n';

beforeAll(async () => {
  home = process.env.HOME as string;
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-scope-repo-')));
  fs.mkdirSync(path.join(repo, '.git'));
  process.env.CLAUDE_PROJECT_DIR = repo;
  process.env.DEERDAWN_API_URL = 'http://127.0.0.1:9';
  vi.resetModules();
  ({ autoConfigureHooks } = await import('../src/auth.js'));
});

beforeEach(() => {
  for (const entry of fs.readdirSync(home)) fs.rmSync(path.join(home, entry), { recursive: true, force: true });
  write('.deerdawn/credentials.json', JSON.stringify({ api_key: KEY }));
  delete process.env.DEERDAWN_SURFACE_ID;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  delete process.env.CLAUDE_PROJECT_DIR;
  delete process.env.DEERDAWN_SURFACE_ID;
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('apply_setup writes the chosen tool\'s files and no other tool\'s', () => {
  it('claude_code: DeerDawn\'s block in ~/.claude/CLAUDE.md, and nothing in ~/.claude/settings.json (no plain-text key anywhere)', () => {
    write('.claude.json', CLAUDE_REGISTERED);
    write('.claude/CLAUDE.md', USER_CLAUDE);

    const result = applySurfaceSetup('claude_code', 'repair') as any;

    expect(result.applied).toBe(true);
    expect(result.changed_paths).toEqual([path.join(home, '.claude', 'CLAUDE.md')]);
    expect(exists('.claude/settings.json')).toBe(false);
    expect(read('.claude/CLAUDE.md').startsWith(USER_CLAUDE)).toBe(true);
    expect(read('.claude/CLAUDE.md')).toContain('start_session');
    expect(filesHoldingKey()).toEqual([]);
  });

  it('claude_code: a block the person removed is not added back, repair mode included, and the reply says how to opt back in', async () => {
    write('.claude.json', CLAUDE_REGISTERED);
    write('.claude/CLAUDE.md', USER_CLAUDE);
    write('.deerdawn/setup-choices.json', JSON.stringify({ global_claude_md: 'removed' }));

    const result = applySurfaceSetup('claude_code', 'repair') as any;

    expect(read('.claude/CLAUDE.md')).toBe(USER_CLAUDE);
    expect(result.changed_paths).toEqual([]);
    expect(result.note).toMatch(/You removed DeerDawn's block from ~\/\.claude\/CLAUDE\.md/);
    expect(result.note).toContain('npx -y @deerdawn/mcp-server@latest setup');

    // The way back in is the person's own yes in setup.
    const { restoreGlobalClaudeMdBlock } = await import('../src/auth.js');
    const { readSetupChoices } = await import('../src/setup-choices.js');
    expect(restoreGlobalClaudeMdBlock()).toBe(true);
    expect(read('.claude/CLAUDE.md').startsWith(USER_CLAUDE)).toBe(true);
    expect(read('.claude/CLAUDE.md')).toContain('start_session');
    expect(readSetupChoices().global_claude_md).toBe('kept');
  });

  it('claude_code: a settings.json the person has is left as it is', () => {
    write('.claude.json', CLAUDE_REGISTERED);
    const settings = JSON.stringify({ model: 'opus', mcpServers: { other: { command: 'x' } } }, null, 2);
    write('.claude/settings.json', settings);

    applySurfaceSetup('claude_code', 'repair');

    expect(read('.claude/settings.json')).toBe(settings);
  });

  it('claude_desktop: Claude Desktop\'s config only, and Claude Code\'s CLAUDE.md is not touched', () => {
    const configRel = 'Library/Application Support/Claude/claude_desktop_config.json';
    write(configRel, JSON.stringify({ mcpServers: { deerdawn: { command: 'npx', args: ['-y', '@deerdawn/mcp-server@latest'] } } }));
    write('.claude/CLAUDE.md', USER_CLAUDE);

    const result = applySurfaceSetup('claude_desktop', 'repair') as any;

    expect(result.changed_paths).toEqual([path.join(home, configRel)]);
    expect(read('.claude/CLAUDE.md')).toBe(USER_CLAUDE);
    expect(exists('.claude/settings.json')).toBe(false);
  });

  it('cursor: Cursor\'s own files; the key goes only where Cursor reads one (the entry\'s env in mcp.json)', () => {
    write('.cursor/mcp.json', CURSOR_REGISTERED);
    write('.claude/CLAUDE.md', USER_CLAUDE);

    const result = applySurfaceSetup('cursor', 'repair') as any;

    expect(result.changed_paths.sort()).toEqual([path.join(home, '.cursor', 'mcp.json'), path.join(home, '.cursor', 'rules', 'deerdawn.mdc')].sort());
    expect(read('.claude/CLAUDE.md')).toBe(USER_CLAUDE);
    expect(exists('.claude/settings.json')).toBe(false);
    expect(JSON.parse(read('.cursor/mcp.json')).mcpServers.deerdawn.env.DEERDAWN_API_KEY).toBe(KEY);
    expect(filesHoldingKey()).toEqual(['.cursor/mcp.json']);
  });

  it('codex: config.toml and AGENTS.md; no key is written to either', () => {
    write('.codex/config.toml', CODEX_REGISTERED);
    write('.codex/AGENTS.md', USER_AGENTS);
    write('.claude/CLAUDE.md', USER_CLAUDE);

    applySurfaceSetup('codex', 'repair');

    expect(read('.claude/CLAUDE.md')).toBe(USER_CLAUDE);
    expect(read('.codex/AGENTS.md')).toContain('start_session');
    expect(filesHoldingKey()).toEqual([]);
  });
});

describe('a boot writes the files of the tool it is running inside, and no other tool\'s', () => {
  function everythingRegistered() {
    write('.claude.json', CLAUDE_REGISTERED);
    write('.claude/CLAUDE.md', USER_CLAUDE);
    write('.codex/config.toml', CODEX_REGISTERED);
    write('.codex/AGENTS.md', USER_AGENTS);
    write('.cursor/mcp.json', CURSOR_REGISTERED);
    fs.mkdirSync(path.join(home, '.cursor', 'rules'), { recursive: true });
  }

  it('a Claude Code boot writes hooks, and leaves Codex\'s AGENTS.md, Cursor\'s rule and a CLAUDE.md with no block of its own alone', () => {
    everythingRegistered();
    const before = tree(home);

    autoConfigureHooks({ tool: 'claude_code' });

    const after = tree(home);
    const changed = Object.keys(after).filter((file) => after[file] !== before[file] && !file.startsWith('.deerdawn')).sort();
    // The global CLAUDE.md is refreshed when it holds DeerDawn's block, and never
    // added to (Thing 4.3); this one holds only the person's text.
    expect(changed).toEqual([path.join('.claude', 'settings.json')]);
  });

  it('a Codex boot writes AGENTS.md only', () => {
    everythingRegistered();
    const before = tree(home);

    autoConfigureHooks({ tool: 'codex' });

    const after = tree(home);
    const changed = Object.keys(after).filter((file) => after[file] !== before[file] && !file.startsWith('.deerdawn')).sort();
    expect(changed).toEqual([path.join('.codex', 'AGENTS.md')]);
  });

  it('a Cursor boot writes its rule only', () => {
    everythingRegistered();
    const before = tree(home);

    autoConfigureHooks({ tool: 'cursor' });

    const after = tree(home);
    const changed = Object.keys(after).filter((file) => after[file] !== before[file] && !file.startsWith('.deerdawn')).sort();
    expect(changed).toEqual([path.join('.cursor', 'rules', 'deerdawn.mdc')]);
  });

  it('a boot in a host with no DeerDawn profile, or one that cannot yet say which tool it is, writes nothing', () => {
    everythingRegistered();
    const before = tree(home);

    autoConfigureHooks({ tool: 'windsurf' });
    autoConfigureHooks({ tool: null });
    autoConfigureHooks();

    expect(tree(home)).toEqual(before);
  });

  it('the environment names the tool: DEERDAWN_SURFACE_ID=codex is a Codex boot', () => {
    everythingRegistered();
    process.env.DEERDAWN_SURFACE_ID = 'codex';
    const before = tree(home);

    autoConfigureHooks();

    const after = tree(home);
    const changed = Object.keys(after).filter((file) => after[file] !== before[file] && !file.startsWith('.deerdawn')).sort();
    expect(changed).toEqual([path.join('.codex', 'AGENTS.md')]);
  });

  it('once the initialize handshake names the tool, that tool is configured', async () => {
    everythingRegistered();
    vi.resetModules();
    const { recordDetectedSurface } = await import('../src/surface.js');
    const auth = await import('../src/auth.js');

    auth.autoConfigureHooks();
    expect(exists('.claude/settings.json')).toBe(false);

    recordDetectedSurface('claude-code', '2.1.0');
    auth.autoConfigureHooks();

    expect(exists('.claude/settings.json')).toBe(true);
    expect(read('.claude/CLAUDE.md')).toBe(USER_CLAUDE);
  });
});

describe('project files: setup writes the tool it registers, and no other\'s', () => {
  const brief = { brief: 'Project: Atlas', project_name: 'Atlas', project_id: 'proj-1', match_kind: 'path', last_updated: '2026-06-08T00:00:00.000Z', context: { tech_stack: [] } };
  const client = () => ({
    getActiveContextByCwd: vi.fn().mockResolvedValue(brief),
    patchProjectContext: vi.fn().mockResolvedValue(undefined),
    upsertWorkspaceEntities: vi.fn().mockResolvedValue(undefined),
    listSkills: vi.fn().mockResolvedValue([]),
  }) as any;

  it('with the tool named: that tool\'s files only', async () => {
    const written = await syncProjectFiles(client(), repo, undefined, { tools: ['claude_code'] });

    expect(written).toBe('Atlas');
    expect(fs.existsSync(path.join(repo, '.deerdawn-context.md'))).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8')).toContain('@.deerdawn-context.md');
    expect(fs.existsSync(path.join(repo, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.cursorrules'))).toBe(false);
  });

  it('with no tool named (a boot, start_session): no tool\'s file is added (project-sync-update-only.test.ts covers the rule)', async () => {
    fs.rmSync(path.join(repo, 'CLAUDE.md'), { force: true });
    fs.rmSync(path.join(repo, '.deerdawn-context.md'), { force: true });

    await syncProjectFiles(client(), repo);

    expect(fs.existsSync(path.join(repo, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.cursorrules'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'CLAUDE.md'))).toBe(false);
  });
});

describe('a plain-text key an older version wrote is named, offered for removal, and removed only when asked', () => {
  const SETTINGS = {
    model: 'opus',
    mcpServers: { deerdawn: { command: 'npx', args: ['-y', '@deerdawn/mcp-server@latest'], env: { DEERDAWN_API_URL: 'https://api.deerdawn.com', DEERDAWN_API_KEY: KEY } } },
  };

  it('get_setup_status names the file and the command that removes the key; nothing is deleted', () => {
    write('.claude/settings.json', JSON.stringify(SETTINGS, null, 2));
    const before = read('.claude/settings.json');

    const status = inspectLocalSetupStatus('local_direct', { runningSurface: null } as any) as any;

    const [found] = status.diagnostics.plain_text_keys;
    expect(found.path).toBe(path.join(home, '.claude', 'settings.json'));
    expect(found.tool).toBe('claude_code');
    expect(found.remove_with).toBe('npx -y @deerdawn/mcp-server@latest remove-key');
    expect(found.summary).toContain('~/.claude/settings.json');
    expect(found.summary).toContain('plain text');
    expect(found.summary).not.toContain(KEY);
    expect(read('.claude/settings.json')).toBe(before);
    // Re-running setup does not delete it either.
    write('.claude.json', CLAUDE_REGISTERED);
    applySurfaceSetup('claude_code', 'repair');
    expect(read('.claude/settings.json')).toBe(before);
  });

  it('a settings.json with no key in it says nothing', () => {
    write('.claude/settings.json', JSON.stringify({ model: 'opus', hooks: {} }));
    expect((inspectLocalSetupStatus('local_direct', { runningSurface: null } as any) as any).diagnostics.plain_text_keys).toEqual([]);
  });

  it('asked to remove it, only the key goes: every other byte of the settings survives, and a backup is taken', () => {
    write('.claude/settings.json', JSON.stringify(SETTINGS, null, 2));

    const [outcome] = removePlainTextKeys();

    expect(outcome.removed).toBe(true);
    const after = JSON.parse(read('.claude/settings.json'));
    expect(after.model).toBe('opus');
    expect(after.mcpServers.deerdawn.env).toEqual({ DEERDAWN_API_URL: 'https://api.deerdawn.com' });
    expect(after.mcpServers.deerdawn.command).toBe('npx');
    // The backup has the key blanked out: its point is that the key is gone (remove-key-safety.test.ts).
    expect(fs.readFileSync(outcome.backup_path as string, 'utf8')).not.toContain(KEY);
    expect(fs.readFileSync(outcome.backup_path as string, 'utf8')).toContain('removed by DeerDawn remove-key');
    expect((inspectLocalSetupStatus('local_direct', { runningSurface: null } as any) as any).diagnostics.plain_text_keys).toEqual([]);
  });

  it('a settings.json that is a symlink is refused, as every DeerDawn write is', () => {
    const target = write('dotfiles/settings.json', JSON.stringify(SETTINGS, null, 2));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.symlinkSync(target, path.join(home, '.claude', 'settings.json'));

    const [outcome] = removePlainTextKeys();

    expect(outcome.removed).toBe(false);
    expect(outcome.reason).toMatch(/symlink/);
    expect(fs.readFileSync(target, 'utf8')).toContain(KEY);
  });
});
