import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { contextSyncTools } from '../src/tools/context-sync.js';
import {
  buildOnDiskInstructionBlock,
  classifyMcpServerEntry,
  detectClaudeCodeServerKinds,
  detectCodexServerKinds,
  type DeerdawnServerKind,
} from '../src/on-disk-instructions.js';
import { buildDeerdawnInstructionBlock, OPEN_MARKER, CLOSE_MARKER } from '../src/instruction-block.js';

/**
 * THE BLOCK setup WRITES NAMED CALLS THE REGISTERED SERVER REFUSES.
 *
 * `setup` (and every boot) writes one instruction block into ~/.claude/CLAUDE.md,
 * written for the local stdio catalog. With the HOSTED endpoint registered
 * instead, that block told the model — in the user's own voice, at the top of
 * every session — to call `manage_tasks action:"list"` and
 * `manage_memory action:"import_local"`. /mcp/claude has no `list` action (it
 * lists through `read_tasks`) and no hosted catalog has `import_local`.
 *
 * The rule under test: EVERY CALL THE BLOCK NAMES EXISTS IN THE CATALOG IT WILL
 * BE READ AGAINST. The block is parsed for the calls it names and each is checked
 * against that catalog's tools, actions and argument names.
 *
 * The local catalog is the real one (src/tools). The hosted catalogs are a
 * fixture of apps/api/src/routes/mcp.js — TOOLS, CLAUDE_ADVERTISED_TOOL_NAMES and
 * CLAUDE_MANAGE_TASKS_TOOL — as of 2026-09-20, reduced to what a block can name.
 * That file cannot be imported here (it loads the whole API). If a hosted action
 * is added or removed there, this fixture is the second place to change.
 */

type Catalog = Record<string, { actions: string[]; args: string[] }>;

const HOSTED_MANAGE_MEMORY = {
  actions: ['update', 'record_paths', 'record_finding', 'upsert_entities', 'resolve', 'resolve_question', 'finish_task', 'export_trail', 'import_trail'],
  args: ['action', 'project_id', 'trail', 'kind', 'new_project_name', 'dry_run', 'summary', 'commands', 'items', 'paths', 'added_at', 'commit_ref', 'diff_ref', 'entities', 'relations', 'title', 'entity_type', 'notes', 'question', 'answer', 'complete_task', 'ask_questions', 'confirm_complete'],
};
const HOSTED_SHARED: Catalog = {
  start_session: { actions: [], args: ['verbosity'] },
  recall: { actions: ['projects', 'context', 'search', 'overview', 'map', 'paths', 'entities', 'next', 'portfolio'], args: ['action', 'project_id', 'query', 'scope', 'mode', 'verbosity'] },
  manage_projects: { actions: ['create', 'select', 'rename', 'move', 'archive', 'restore'], args: ['action', 'project_id'] },
  manage_memory: HOSTED_MANAGE_MEMORY,
  browse_skills: { actions: ['list', 'get'], args: ['action'] },
  build_subagent_brief: { actions: [], args: ['task', 'project_id'] },
};
const TASK_ARGS = ['action', 'project_id', 'todos', 'cards', 'phase', 'confirm_destructive'];

function localCatalog(): Catalog {
  const catalog: Catalog = {};
  for (const tool of contextSyncTools as any[]) {
    const properties = tool?.inputSchema?.properties || {};
    catalog[tool.name] = { actions: properties.action?.enum || [], args: Object.keys(properties) };
  }
  return catalog;
}

// What a block may name is what tools/list SHOWS, not what tools/call will
// dispatch: a model only calls what it was advertised. /mcp still executes
// read_tasks (tools/call resolves against the whole TOOLS array) but its
// ADVERTISED_TOOL_NAMES does not carry it; /mcp/claude does.
const READ_TASKS = { actions: [], args: ['project_id', 'todos', 'cards_per_phase'] };
const CATALOGS: Record<DeerdawnServerKind, Catalog> = {
  local: localCatalog(),
  hosted: { ...HOSTED_SHARED, manage_tasks: { actions: ['list', 'add', 'move', 'complete', 'remove'], args: TASK_ARGS } },
  // /mcp/claude: tools/call resolves against the ADVERTISED set only, and its
  // manage_tasks is the write-only variant. `list` is rejected by the schema.
  hosted_claude: { ...HOSTED_SHARED, read_tasks: READ_TASKS, manage_tasks: { actions: ['add', 'move', 'complete', 'remove'], args: TASK_ARGS } },
};

const ALL_TOOLS = new Set(Object.values(CATALOGS).flatMap((catalog) => Object.keys(catalog)));

/** Every call a block names that `catalog` would refuse, as readable strings. */
function callsRefusedBy(block: string, catalog: Catalog): string[] {
  const problems: string[] = [];
  for (const line of block.split('\n')) {
    const spans = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const mentioned = new Set<string>();
    const looseActions: string[] = [];

    for (const span of spans) {
      // `tool(action:"x", other:1)`: the call form. Checked against THAT tool.
      const call = /^([a-z_]+)\((.*)\)$/.exec(span);
      if (call && ALL_TOOLS.has(call[1])) {
        const [, tool, inner] = call;
        mentioned.add(tool);
        if (!catalog[tool]) { problems.push(`${tool} is not a tool here`); continue; }
        const action = /action\s*:\s*"([^"]+)"/.exec(inner)?.[1];
        if (action && !catalog[tool].actions.includes(action)) problems.push(`${tool}(action:"${action}")`);
        for (const arg of inner.split(',').map((part) => part.split(':')[0].trim()).filter(Boolean)) {
          if (!catalog[tool].args.includes(arg)) problems.push(`${tool}(${arg}: …)`);
        }
        continue;
      }
      if (ALL_TOOLS.has(span)) { mentioned.add(span); continue; }
      const bareAction = /^action\s*:\s*"([^"]+)"$/.exec(span)?.[1];
      if (bareAction) looseActions.push(bareAction);
      else if (/^[a-z_]+$/.test(span)) looseActions.push(span);
    }

    for (const tool of mentioned) if (!catalog[tool]) problems.push(`${tool} is not a tool here`);
    // "`recall` with action `map`" / "Use `action:"list"`": an action named
    // beside a tool rather than inside a call. It counts as an action only if
    // SOME catalog knows it as one for a tool this line mentions; then at least
    // one mentioned tool must accept it HERE.
    for (const action of looseActions) {
      const isAnActionSomewhere = [...mentioned].some((tool) => Object.values(CATALOGS).some((c) => c[tool]?.actions.includes(action)));
      if (!isAnActionSomewhere) continue;
      if (![...mentioned].some((tool) => catalog[tool]?.actions.includes(action))) problems.push(`${[...mentioned].join('/')} action "${action}"`);
    }
  }
  return [...new Set(problems)];
}

describe('every call the on-disk block names exists in the catalog it is read against', () => {
  it.each(['local', 'hosted', 'hosted_claude'] as const)('%s', (kind) => {
    expect(callsRefusedBy(buildOnDiskInstructionBlock(kind), CATALOGS[kind])).toEqual([]);
  });

  it('with more than one kind registered, the one block is valid in ALL of them', () => {
    const mixes: DeerdawnServerKind[][] = [['local', 'hosted'], ['local', 'hosted_claude'], ['hosted', 'hosted_claude'], ['local', 'hosted', 'hosted_claude']];
    for (const kinds of mixes) {
      const block = buildOnDiskInstructionBlock(kinds);
      for (const kind of kinds) expect(callsRefusedBy(block, CATALOGS[kind]), `${kinds.join('+')} read by ${kind}`).toEqual([]);
    }
  });

  it('the checker is not vacuous: the unfitted block is refused by both hosted catalogs', () => {
    const unfitted = buildDeerdawnInstructionBlock();
    expect(callsRefusedBy(unfitted, CATALOGS.local)).toEqual([]);
    expect(callsRefusedBy(unfitted, CATALOGS.hosted)).toEqual(['manage_memory(action:"import_local")']);
    expect(callsRefusedBy(unfitted, CATALOGS.hosted_claude).sort()).toEqual(['manage_memory(action:"import_local")', 'manage_tasks action "list"']);
  });

  it('a local registration still gets the whole block, unchanged', () => {
    expect(buildOnDiskInstructionBlock('local')).toBe(buildDeerdawnInstructionBlock());
    expect(buildOnDiskInstructionBlock([])).toBe(buildDeerdawnInstructionBlock());
  });

  it('a hosted /mcp/claude registration is told how THAT server reads the board', () => {
    const block = buildOnDiskInstructionBlock('hosted_claude');
    expect(block).toContain('`read_tasks`');
    expect(block).not.toContain('import_local');
    // Everything that is not catalog-specific is still the shared text.
    expect(block).toContain('`start_session`');
    expect(block).toContain('manage_memory(action:"finish_task", complete_task:true, confirm_complete:true)');
  });
});

describe('which server is registered', () => {
  it('reads the catalog off the URL path, and a command as the stdio server', () => {
    expect(classifyMcpServerEntry('deerdawn', { type: 'http', url: 'https://api.deerdawn.com/mcp/claude' })).toBe('hosted_claude');
    expect(classifyMcpServerEntry('deerdawn', { type: 'http', url: 'https://api.deerdawn.com/mcp/claude/' })).toBe('hosted_claude');
    expect(classifyMcpServerEntry('deerdawn', { type: 'http', url: 'https://api.deerdawn.com/mcp' })).toBe('hosted');
    expect(classifyMcpServerEntry('memory', { url: 'https://api.deerdawn.com/api/v1/mcp' })).toBe('hosted');
    expect(classifyMcpServerEntry('deerdawn', { command: 'npx', args: ['-y', '@deerdawn/mcp-server@latest'] })).toBe('local');
    expect(classifyMcpServerEntry('memory', { command: 'npx', args: ['-y', '@deerdawn/mcp-server@latest'] })).toBe('local');
    expect(classifyMcpServerEntry('github', { command: 'npx', args: ['-y', '@github/mcp'] })).toBeNull();
    expect(classifyMcpServerEntry('deerdawn', null)).toBeNull();
  });
});

describe('what autoConfigureHooks writes, end to end', () => {
  let home: string;
  let repo: string;
  const saved: Record<string, string | undefined> = {};
  let autoConfigureHooks: typeof import('../src/auth.js').autoConfigureHooks;

  beforeAll(async () => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-block-home-')));
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-block-repo-')));
    for (const key of ['HOME', 'USERPROFILE', 'CLAUDE_PROJECT_DIR']) saved[key] = process.env[key];
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CLAUDE_PROJECT_DIR = repo;
    vi.resetModules();
    ({ autoConfigureHooks } = await import('../src/auth.js'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  beforeEach(() => {
    for (const entry of ['.claude.json', '.claude', '.codex']) fs.rmSync(path.join(home, entry), { recursive: true, force: true });
    fs.rmSync(path.join(repo, '.mcp.json'), { force: true });
  });

  afterAll(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [home, repo]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  const claudeMd = () => fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');
  const register = (config: unknown) => fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(config));
  // A boot refreshes DeerDawn's block in ~/.claude/CLAUDE.md and never adds one
  // (Thing 4.3), so these start from a block an earlier version left there.
  const seedOldBlock = () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), `# Mine\n\n${OPEN_MARKER}\n## DeerDawn\nAn older copy.\n${CLOSE_MARKER}\n`);
  };

  it('after a hosted /mcp/claude registration, the block names nothing that server refuses', () => {
    register({ mcpServers: { deerdawn: { type: 'http', url: 'https://api.deerdawn.com/mcp/claude' } } });
    seedOldBlock();
    autoConfigureHooks({ tool: 'claude_code' });
    expect(detectClaudeCodeServerKinds(home, repo)).toEqual(['hosted_claude']);
    expect(callsRefusedBy(claudeMd(), CATALOGS.hosted_claude)).toEqual([]);
    expect(claudeMd()).toContain('`read_tasks`');
  });

  it('finds a registration made at the default (per-directory) scope too', () => {
    register({ projects: { [repo]: { mcpServers: { deerdawn: { type: 'http', url: 'https://api.deerdawn.com/mcp' } } } } });
    seedOldBlock();
    autoConfigureHooks({ tool: 'claude_code' });
    expect(callsRefusedBy(claudeMd(), CATALOGS.hosted)).toEqual([]);
    expect(claudeMd()).not.toContain('import_local');
  });

  it('finds one committed to the repo as .mcp.json', () => {
    fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { deerdawn: { type: 'http', url: 'https://api.deerdawn.com/mcp/claude' } } }));
    expect(detectClaudeCodeServerKinds(home, repo)).toEqual(['hosted_claude']);
  });

  it('a local registration, or none at all, keeps the full local block', () => {
    seedOldBlock();
    autoConfigureHooks({ tool: 'claude_code' });
    expect(claudeMd()).toContain('manage_memory(action:"import_local")');
    register({ mcpServers: { deerdawn: { type: 'stdio', command: 'npx', args: ['-y', '@deerdawn/mcp-server@latest'] } } });
    autoConfigureHooks({ tool: 'claude_code' });
    expect(claudeMd()).toContain('manage_memory(action:"import_local")');
    expect(callsRefusedBy(claudeMd(), CATALOGS.local)).toEqual([]);
  });

  it('re-registering replaces the block in place rather than stacking a second one', () => {
    register({ mcpServers: { deerdawn: { command: 'npx', args: ['-y', '@deerdawn/mcp-server@latest'] } } });
    seedOldBlock();
    autoConfigureHooks({ tool: 'claude_code' });
    register({ mcpServers: { deerdawn: { type: 'http', url: 'https://api.deerdawn.com/mcp/claude' } } });
    autoConfigureHooks({ tool: 'claude_code' });
    expect(claudeMd().match(/<!-- deerdawn:auto-context /g)).toHaveLength(1);
    expect(claudeMd()).not.toContain('import_local');
  });

  it('Codex gets a block fitted to CODEX\'s registration, not Claude Code\'s', () => {
    register({ mcpServers: { deerdawn: { command: 'npx', args: ['-y', '@deerdawn/mcp-server@latest'] } } });
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'AGENTS.md'), '# My agents\n');
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), [
      'model = "gpt-5"',
      '',
      '[mcp_servers.deerdawn]',
      'url = "https://api.deerdawn.com/mcp"',
      '',
      '[mcp_servers.other]',
      'command = "npx"',
    ].join('\n'));
    // Each tool's boot writes that tool's file and no other's.
    seedOldBlock();
    autoConfigureHooks({ tool: 'claude_code' });
    autoConfigureHooks({ tool: 'codex' });
    expect(detectCodexServerKinds(home)).toEqual(['hosted']);
    const agents = fs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8');
    expect(callsRefusedBy(agents, CATALOGS.hosted)).toEqual([]);
    expect(agents).not.toContain('import_local');
    expect(claudeMd()).toContain('import_local');
  });

  it('reads the stdio form of a Codex registration as local', () => {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), [
      '[mcp_servers.deerdawn]',
      'command = "npx"',
      'args = ["-y", "@deerdawn/mcp-server@latest"]',
      '',
      '[mcp_servers.deerdawn.env]',
      'DEERDAWN_API_URL = "https://api.deerdawn.com"',
    ].join('\n'));
    expect(detectCodexServerKinds(home)).toEqual(['local']);
  });
});
