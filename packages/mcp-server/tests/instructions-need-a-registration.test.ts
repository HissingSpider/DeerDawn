import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildOnDiskInstructionBlock } from '../src/on-disk-instructions.js';
import { buildCursorInstructionBlock, buildDeerdawnInstructionBlock, MARKER_NAME_PREFIX } from '../src/instruction-block.js';

/**
 * AN ORDER TO CALL A TOOL THE TOOL DOES NOT HAVE.
 *
 * Every boot of the stdio server wrote a DeerDawn block into ~/.codex/AGENTS.md
 * whenever that file existed — "Always call start_session ... Do not answer
 * project questions ... until context has been loaded" — fitted to whatever
 * servers Codex had registered, INCLUDING NONE (buildOnDiskInstructionBlock reads
 * an empty list as the local server). A Codex user who never connected DeerDawn
 * to Codex got a standing order, in their own global instructions, to call a
 * tool Codex cannot see, and Codex stalls or refuses on every project question.
 * ~/.cursor/rules/deerdawn.mdc was written the same way, off the existence of a
 * directory.
 *
 * The rule under test: DeerDawn writes instructions into another tool's global
 * file only when that tool has a DeerDawn server registered in its own config;
 * with none, it writes nothing. It does not take back a block an earlier boot
 * left either: a boot cannot see every registration a tool has (Cursor reads
 * each project's own .cursor/mcp.json), and removing on what it cannot see made
 * the rule flip-flop between tools. See no-cross-tool-removal.test.ts.
 *
 * Everything runs under a throwaway HOME (and DEERDAWN_HOME_DIR inside it).
 */

let home: string;
let repo: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['HOME', 'USERPROFILE', 'CLAUDE_PROJECT_DIR', 'DEERDAWN_HOME_DIR', 'DEERDAWN_DIR', 'DEERDAWN_API_KEY', 'DEERDAWN_API_URL', 'DEERDAWN_AUTO_IMPORT', 'DEERDAWN_SURFACE_ID', 'CODEX_HOME'];
let autoConfigureHooks: typeof import('../src/auth.js').autoConfigureHooks;

function write(rel: string, content: string): string {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}
const read = (rel: string) => fs.readFileSync(path.join(home, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(home, rel));

async function setupStatus(): Promise<any> {
  const { inspectLocalSetupStatus } = await import('../../shared-context/src/setup-status.js');
  return inspectLocalSetupStatus();
}
const surfaceOf = (status: any, id: string) => status.surfaces.find((s: any) => s.id === id);

const USER_AGENTS = '# Codex rules\nBe terse. USERMARK-CODEX\n';
// Exactly what the append path of an earlier boot produced.
const staleAgents = () => `${USER_AGENTS.trimEnd()}\n\n${buildOnDiskInstructionBlock([]).trimEnd()}\n`;
const USER_TOML = 'model = "o3"\n\n[mcp_servers.other]\ncommand = "other"\n';
const USER_RULE = '---\nalwaysApply: true\n---\nUse tabs. USERMARK-CURSOR\n';
const CURSOR_FRONTMATTER = '---\ndescription: DeerDawn session memory — brief every new session with your project at session start\nalwaysApply: true\n---\n\n';

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-instr-reg-home-')));
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-instr-reg-repo-')));
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CLAUDE_PROJECT_DIR = repo;
  process.env.DEERDAWN_HOME_DIR = home;
  process.env.DEERDAWN_DIR = path.join(home, '.deerdawn');
  delete process.env.DEERDAWN_API_KEY;
  // Anything that does reach for the network finds a closed port, never a live stack.
  process.env.DEERDAWN_API_URL = 'http://127.0.0.1:9';
  delete process.env.DEERDAWN_AUTO_IMPORT;
  // The repo root bounds the walk up for a project-level config.
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  vi.resetModules();
  ({ autoConfigureHooks } = await import('../src/auth.js'));
});

beforeEach(() => {
  for (const entry of fs.readdirSync(home)) fs.rmSync(path.join(home, entry), { recursive: true, force: true });
  fs.rmSync(path.join(repo, '.cursor'), { recursive: true, force: true });
  write('.deerdawn/credentials.json', JSON.stringify({ api_key: 'dd_test_key' }));
  // Unless a test says otherwise, this is the server booting inside Claude Code,
  // registered by `setup` (whose `claude mcp add` sets this): a KNOWN surface
  // that is neither Codex nor Cursor. The walker's machine.
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
  for (const dir of [home, repo]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Codex: ~/.codex/AGENTS.md', () => {
  it('no server in config.toml: nothing is written, and the status says not connected', async () => {
    write('.codex/AGENTS.md', USER_AGENTS);
    write('.codex/config.toml', USER_TOML);

    autoConfigureHooks({ tool: 'codex' });

    expect(read('.codex/AGENTS.md')).toBe(USER_AGENTS);
    const codex = surfaceOf(await setupStatus(), 'codex');
    expect(codex.configured).toBe(false);
    expect(codex.config_has_deerdawn_mcp).toBe(false);
  });

  // These two used to assert the block was taken back out. A boot running in
  // another tool cannot know that Codex has no registration (it may live where
  // this process cannot see), so the file is left exactly as it is: not
  // refreshed, not removed. get_setup_status says what it is.
  it('a block an earlier boot left is neither refreshed nor removed: the file stays byte for byte', async () => {
    write('.codex/AGENTS.md', staleAgents());
    write('.codex/config.toml', USER_TOML);

    autoConfigureHooks({ tool: 'codex' });
    autoConfigureHooks({ tool: 'codex' });

    expect(read('.codex/AGENTS.md')).toBe(staleAgents());
    expect(surfaceOf(await setupStatus(), 'codex').degraded_reason).toBe('instructions_without_mcp_server');
  });

  it('a file that holds only DeerDawn\'s block is left as it is', () => {
    const only = `\n${buildOnDiskInstructionBlock([]).trimEnd()}\n`;
    write('.codex/AGENTS.md', only);

    autoConfigureHooks({ tool: 'codex' });

    expect(exists('.codex/AGENTS.md')).toBe(true);
    expect(read('.codex/AGENTS.md')).toBe(only);
  });

  it('a registered server: the block is written, fitted to it, below the person\'s text', async () => {
    write('.codex/AGENTS.md', USER_AGENTS);
    write('.codex/config.toml', `${USER_TOML}\n[mcp_servers.deerdawn]\nurl = "https://api.deerdawn.com/mcp"\n`);

    autoConfigureHooks({ tool: 'codex' });

    const agents = read('.codex/AGENTS.md');
    expect(agents.startsWith(USER_AGENTS.trimEnd())).toBe(true);
    expect(agents).toContain('start_session');
    expect(agents).not.toContain('import_local'); // hosted catalog, unchanged behaviour
    expect(surfaceOf(await setupStatus(), 'codex').configured).toBe(true);
  });
});

describe('Cursor: ~/.cursor/rules/deerdawn.mdc', () => {
  it('no server in mcp.json: no rule is created, and the person\'s rules are untouched', async () => {
    write('.cursor/mcp.json', JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } }));
    write('.cursor/rules/mine.mdc', USER_RULE);

    autoConfigureHooks({ tool: 'cursor' });

    expect(exists('.cursor/rules/deerdawn.mdc')).toBe(false);
    expect(read('.cursor/rules/mine.mdc')).toBe(USER_RULE);
    expect(surfaceOf(await setupStatus(), 'cursor').configured).toBe(false);
  });

  // Used to assert the block was taken back, leaving the frontmatter behind. A
  // Claude Code boot cannot see a Cursor registration in another repo's
  // .cursor/mcp.json, and removing on that guess made the rule flip-flop.
  it('a block left by an earlier boot or by apply_setup is left in place, byte for byte', () => {
    write('.cursor/mcp.json', JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } }));
    write('.cursor/rules/mine.mdc', USER_RULE);

    for (const block of [buildCursorInstructionBlock(), buildDeerdawnInstructionBlock()]) {
      const rule = `${CURSOR_FRONTMATTER}${block.trimEnd()}\n`;
      write('.cursor/rules/deerdawn.mdc', rule);

      autoConfigureHooks({ tool: 'cursor' });

      expect(read('.cursor/rules/deerdawn.mdc')).toBe(rule);
      expect(read('.cursor/rules/mine.mdc')).toBe(USER_RULE);
    }
  });

  it('a registered server: the rule is written as before', async () => {
    write('.cursor/mcp.json', JSON.stringify({ mcpServers: { deerdawn: { url: 'https://api.deerdawn.com/mcp' } } }));
    fs.mkdirSync(path.join(home, '.cursor', 'rules'), { recursive: true });

    autoConfigureHooks({ tool: 'cursor' });

    expect(read('.cursor/rules/deerdawn.mdc')).toContain(MARKER_NAME_PREFIX);
    expect(surfaceOf(await setupStatus(), 'cursor').configured).toBe(true);
  });
});

describe('the block is written exactly when the status says connected', () => {
  // setup-status.js (CommonJS, shared-context) and on-disk-instructions.ts each
  // read Codex's config.toml. If they ever disagree, a tool is either called
  // connected with no instructions, or instructed with no connection.
  const fixtures: Array<[string, string]> = [
    ['none', USER_TOML],
    ['stdio', `${USER_TOML}\n[mcp_servers.deerdawn]\ncommand = "npx"\nargs = ["-y", "@deerdawn/mcp-server@latest"]\n\n[mcp_servers.deerdawn.env]\nDEERDAWN_API_URL = "https://api.deerdawn.com"\n`],
    ['hosted url', `${USER_TOML}\n[mcp_servers.deerdawn]\nurl = "https://api.deerdawn.com/mcp"\n`],
    ['another name, our url', `${USER_TOML}\n[mcp_servers.memory]\nurl = "https://api.deerdawn.com/mcp/claude"\n`],
    ['quoted name', `${USER_TOML}\n[mcp_servers."deerdawn"]\ncommand = "npx"\n`],
    ['commented out', `${USER_TOML}\n# [mcp_servers.deerdawn]\n# url = "https://api.deerdawn.com/mcp"\n`],
    ['no command or url', `${USER_TOML}\n[mcp_servers.deerdawn]\nstartup_timeout_sec = 120\n`],
    ['only the env sub-table', `${USER_TOML}\n[mcp_servers.deerdawn.env]\nDEERDAWN_API_URL = "https://api.deerdawn.com"\n`],
  ];

  for (const [label, toml] of fixtures) {
    it(`Codex, ${label}`, async () => {
      write('.codex/AGENTS.md', USER_AGENTS);
      write('.codex/config.toml', toml);
      autoConfigureHooks({ tool: 'codex' });
      const blockWritten = read('.codex/AGENTS.md').includes(MARKER_NAME_PREFIX);
      expect(surfaceOf(await setupStatus(), 'codex').configured).toBe(blockWritten);
    });
  }

  const cursorFixtures: Array<[string, unknown]> = [
    ['none', { mcpServers: { github: { command: 'gh-mcp' } } }],
    ['stdio', { mcpServers: { deerdawn: { command: 'npx', args: ['-y', '@deerdawn/mcp-server@latest'] } } }],
    ['hosted url', { mcpServers: { deerdawn: { url: 'https://api.deerdawn.com/mcp' } } }],
    ['entry with neither', { mcpServers: { deerdawn: { env: {} } } }],
    ['top-level key Cursor does not read', { deerdawn: { command: 'npx', args: [] } }],
  ];
  for (const [label, config] of cursorFixtures) {
    it(`Cursor, ${label}`, async () => {
      write('.cursor/mcp.json', JSON.stringify(config));
      fs.mkdirSync(path.join(home, '.cursor', 'rules'), { recursive: true });
      autoConfigureHooks({ tool: 'cursor' });
      const ruleWritten = exists('.cursor/rules/deerdawn.mdc');
      expect(surfaceOf(await setupStatus(), 'cursor').configured).toBe(ruleWritten);
    });
  }

  // Registrations the global files do not show, and must still count.
  it('Codex, running inside Codex, nothing in config.toml', async () => {
    process.env.DEERDAWN_SURFACE_ID = 'codex';
    write('.codex/AGENTS.md', USER_AGENTS);
    write('.codex/config.toml', USER_TOML);
    autoConfigureHooks();
    const blockWritten = read('.codex/AGENTS.md').includes(MARKER_NAME_PREFIX);
    expect(blockWritten).toBe(true);
    expect(surfaceOf(await setupStatus(), 'codex').configured).toBe(blockWritten);
  });

  it('Cursor, registered only in the project\'s .cursor/mcp.json', async () => {
    write('.cursor/mcp.json', JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } }));
    fs.mkdirSync(path.join(home, '.cursor', 'rules'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { deerdawn: { url: 'https://api.deerdawn.com/mcp' } } }));
    autoConfigureHooks({ tool: 'cursor' });
    const ruleWritten = exists('.cursor/rules/deerdawn.mdc');
    expect(ruleWritten).toBe(true);
    expect(surfaceOf(await setupStatus(), 'cursor').configured).toBe(ruleWritten);
  });

  it('Cursor, running inside Cursor, nothing in any config', async () => {
    process.env.DEERDAWN_SURFACE_ID = 'cursor';
    fs.mkdirSync(path.join(home, '.cursor', 'rules'), { recursive: true });
    autoConfigureHooks();
    const ruleWritten = exists('.cursor/rules/deerdawn.mdc');
    expect(ruleWritten).toBe(true);
    expect(surfaceOf(await setupStatus(), 'cursor').configured).toBe(ruleWritten);
  });
});

describe('complete_setup(codex) reports what is on disk', () => {
  async function completeSetup(surface: string, mode?: 'auto' | 'repair'): Promise<any> {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    vi.doMock('../src/tools/context-sync.js', async () => {
      const actual = await vi.importActual<any>('../src/tools/context-sync.js');
      return {
        ...actual,
        handleContextSyncTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'No local context files found.' }] }),
      };
    });
    try {
      const { handleAuthTool } = await import('../src/tools/auth.js');
      const result = await handleAuthTool('complete_setup', mode ? { surface, mode } : { surface }) as any;
      return JSON.parse(result.content[0].text);
    } finally {
      vi.doUnmock('../src/tools/context-sync.js');
      vi.unstubAllGlobals();
    }
  }

  // A tool asked to set itself up with no server registered anywhere it looks: it
  // is told what is missing and offered the global entry, and nothing is written.
  it('no registration: nothing is written, and the answer says what is missing and offers the entry', async () => {
    // The walker's machine: an earlier boot had already put the block in
    // AGENTS.md, which is what made this short-circuit as "already configured".
    write('.codex/AGENTS.md', staleAgents());
    write('.codex/config.toml', USER_TOML);

    const payload = await completeSetup('codex');

    expect(read('.codex/config.toml')).toBe(USER_TOML);
    expect(read('.codex/AGENTS.md')).toBe(staleAgents());
    expect(payload.setup.applied).toBe(false);
    expect(payload.setup.already_configured).toBe(false);
    expect(payload.setup.changed_paths).toEqual([]);
    expect(payload.completed).toBe(false);
    expect(payload.setup.reason).toMatch(/registers no DeerDawn server/);
    expect(payload.setup.reason).toMatch(/nothing was written/);
    expect(payload.setup.offer.global_entry).toBe(path.join(home, '.codex', 'config.toml'));
    expect(payload.setup.offer.write_with).toEqual({ tool: 'apply_setup', surface: 'codex', mode: 'repair' });
    expect(payload.nextAction).toMatch(/codex mcp add deerdawn --url/);
    expect(payload.nextAction).toMatch(/mode "repair"/);
  });

  it('asked for by name (mode repair): it registers the server, and says completed only after reading it back', async () => {
    write('.codex/AGENTS.md', staleAgents());
    write('.codex/config.toml', USER_TOML);

    const payload = await completeSetup('codex', 'repair');
    const toml = read('.codex/config.toml');

    expect(toml).toMatch(/^\[mcp_servers\.deerdawn\]$/m);
    expect(toml.startsWith(USER_TOML.trimEnd())).toBe(true);
    expect(payload.setup.already_configured).toBe(false);
    expect(payload.setup.applied).toBe(true);
    expect(payload.completed).toBe(true);
  });

  it('a registration it cannot make: completed:false, and the next action is the command that makes it', async () => {
    write('.codex/AGENTS.md', USER_AGENTS);
    const broken = `${USER_TOML}\n[mcp_servers.deerdawn]\nstartup_timeout_sec = 120\n`;
    write('.codex/config.toml', broken);

    const payload = await completeSetup('codex');

    expect(read('.codex/config.toml')).toBe(broken);
    expect(read('.codex/AGENTS.md')).toBe(USER_AGENTS);
    expect(payload.completed).toBe(false);
    expect(payload.setup.applied).toBe(false);
    expect(payload.setup.already_configured).toBe(false);
    expect(payload.nextAction).toMatch(/codex mcp add deerdawn --url/);
    expect(payload.nextAction).not.toMatch(/^Setup complete/);
  });
});

/**
 * A WORKING CONNECTION THE GLOBAL FILE DOES NOT SHOW.
 *
 * The first cut decided "registered" from ~/.cursor/mcp.json and
 * ~/.codex/config.toml alone. Somebody who registered DeerDawn in a repo's
 * .cursor/mcp.json, or whose tool starts the server from somewhere else, had
 * their rule REMOVED on every boot, by the very server Cursor was running. The
 * strongest evidence of a registration is the server running inside that tool.
 * Round 1 still removed a block when this process knew it was running elsewhere
 * and saw no registration; round 2 found that flip-flopping with a registration
 * in another repo, so no boot removes a block at all now.
 */
describe('where the server is running, and what the working directory registers', () => {
  const GITHUB_ONLY = JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } });
  const staleRule = () => `${CURSOR_FRONTMATTER}${buildCursorInstructionBlock().trimEnd()}\n`;

  it('(a) Cursor registered only in <repo>/.cursor/mcp.json: the rule is kept', () => {
    write('.cursor/mcp.json', GITHUB_ONLY);
    write('.cursor/rules/deerdawn.mdc', staleRule());
    fs.mkdirSync(path.join(repo, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { deerdawn: { command: 'npx', args: ['-y', '@deerdawn/mcp-server@latest'] } } }));

    autoConfigureHooks({ tool: 'cursor' });

    expect(read('.cursor/rules/deerdawn.mdc')).toContain(MARKER_NAME_PREFIX);
  });

  it('(a) ...and from a subdirectory of that repo, found by walking up to its root', () => {
    write('.cursor/mcp.json', GITHUB_ONLY);
    fs.mkdirSync(path.join(home, '.cursor', 'rules'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { deerdawn: { url: 'https://api.deerdawn.com/mcp' } } }));
    const sub = path.join(repo, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    process.env.CLAUDE_PROJECT_DIR = sub;
    try {
      autoConfigureHooks({ tool: 'cursor' });
    } finally {
      process.env.CLAUDE_PROJECT_DIR = repo;
    }

    expect(read('.cursor/rules/deerdawn.mdc')).toContain(MARKER_NAME_PREFIX);
  });

  it('(b) booted with surface cursor and no config entry anywhere: the rule is written', () => {
    process.env.DEERDAWN_SURFACE_ID = 'cursor';
    fs.mkdirSync(path.join(home, '.cursor', 'rules'), { recursive: true });

    autoConfigureHooks();

    expect(read('.cursor/rules/deerdawn.mdc')).toContain(MARKER_NAME_PREFIX);
  });

  it('(b) booted with surface codex and nothing in config.toml: the block is written, fitted to the local server', () => {
    process.env.DEERDAWN_SURFACE_ID = 'codex';
    write('.codex/AGENTS.md', USER_AGENTS);
    write('.codex/config.toml', USER_TOML);

    autoConfigureHooks();

    const agents = read('.codex/AGENTS.md');
    expect(agents.startsWith(USER_AGENTS.trimEnd())).toBe(true);
    expect(agents).toContain(MARKER_NAME_PREFIX);
    // The server answering is the stdio one: its catalog has import_local.
    expect(agents).toContain('import_local');
  });

  it('(b) the surface named by the initialize handshake counts the same as the env', async () => {
    delete process.env.DEERDAWN_SURFACE_ID;
    fs.mkdirSync(path.join(home, '.cursor', 'rules'), { recursive: true });
    vi.resetModules();
    const { recordDetectedSurface } = await import('../src/surface.js');
    const auth = await import('../src/auth.js');
    const tools = await import('../src/tools/auth.js');
    recordDetectedSurface('cursor-vscode', '1.7.0');

    auth.autoConfigureHooks();

    expect(read('.cursor/rules/deerdawn.mdc')).toContain(MARKER_NAME_PREFIX);
    // And get_setup_status, asked from inside Cursor, agrees.
    const status = JSON.parse((await tools.handleAuthTool('get_setup_status')).content[0].text);
    expect(surfaceOf(status, 'cursor').configured).toBe(true);
  });

  // (c) used to assert these were removed. "Registered nowhere" was only
  // "registered nowhere this boot can see".
  it('(c) booted in Claude Code, Cursor registered nowhere it can see: a stale rule is left in place', () => {
    write('.cursor/mcp.json', GITHUB_ONLY);
    write('.cursor/rules/deerdawn.mdc', staleRule());

    autoConfigureHooks();

    expect(read('.cursor/rules/deerdawn.mdc')).toBe(staleRule());
  });

  it('(c) booted in Claude Code, Codex registered nowhere it can see: a stale block is left in place', () => {
    write('.codex/AGENTS.md', staleAgents());
    write('.codex/config.toml', USER_TOML);

    autoConfigureHooks();

    expect(read('.codex/AGENTS.md')).toBe(staleAgents());
  });

  it('when this process cannot say where it is running, nothing is removed', () => {
    // No env, no handshake yet: the state at boot before `initialize` arrives,
    // and in a terminal. It might be the very tool whose block this is.
    delete process.env.DEERDAWN_SURFACE_ID;
    write('.codex/AGENTS.md', staleAgents());
    write('.codex/config.toml', USER_TOML);
    write('.cursor/mcp.json', GITHUB_ONLY);
    write('.cursor/rules/deerdawn.mdc', staleRule());

    autoConfigureHooks();

    expect(read('.codex/AGENTS.md')).toBe(staleAgents());
    expect(read('.cursor/rules/deerdawn.mdc')).toBe(staleRule());
  });

  it('with CODEX_HOME pointing elsewhere, ~/.codex says nothing about Codex, so nothing is removed', () => {
    // Codex reads $CODEX_HOME/config.toml and ignores ~/.codex when it is set
    // (verified against codex-cli 0.154.0 with `codex mcp list`).
    process.env.CODEX_HOME = path.join(home, 'codex-home-elsewhere');
    write('.codex/AGENTS.md', staleAgents());
    write('.codex/config.toml', USER_TOML);

    autoConfigureHooks();

    expect(read('.codex/AGENTS.md')).toBe(staleAgents());
  });
});
