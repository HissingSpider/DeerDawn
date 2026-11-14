const test = require('node:test');
// No home-like variable from the developer's shell reaches this file: see
// contain-home.cjs.
require('./contain-home.cjs').containTestProcess(require('node:test').after);
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildDeerdawnInstructionBlock } = require('../src/deerdawnInstructions.js');
const { applySurfaceSetup, inspectLocalSetupStatus } = require('../src/setup-status.js');

/**
 * A TOOL IS CONNECTED WHEN ITS OWN CONFIG REGISTERS DEERDAWN, AND NOT OTHERWISE.
 *
 * Observed in a walk (2026-09-27): a Codex user with a ~/.codex/AGENTS.md got
 * `apply_setup(codex)` -> already_configured:true and `complete_setup(codex)` ->
 * completed:true, while ~/.codex/config.toml had no DeerDawn server at all. The
 * status counted the instruction block DeerDawn had written into AGENTS.md as
 * the connection itself, so the one call that would have registered the server
 * short-circuited as "already done". Cursor had the same rule, and Claude Code
 * was counted as connected from an `mcpServers` entry in ~/.claude/settings.json,
 * a file Claude Code does not read servers from.
 *
 * Everything here runs under a throwaway home: DEERDAWN_HOME_DIR and HOME both
 * point into a temp dir, and CLAUDE_PROJECT_DIR at an empty one, so no real
 * ~/.codex, ~/.cursor, ~/.claude or repo .mcp.json is ever read or written.
 */

const ENV_KEYS = ['DEERDAWN_HOME_DIR', 'DEERDAWN_DIR', 'HOME', 'USERPROFILE', 'CLAUDE_PROJECT_DIR', 'DEERDAWN_API_KEY', 'DEERDAWN_API_URL', 'DEERDAWN_SURFACE_ID'];

function withHome(fn) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-setup-reg-home-')));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-setup-reg-repo-')));
  fs.mkdirSync(path.join(repo, '.git'));
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.DEERDAWN_HOME_DIR = home;
  process.env.DEERDAWN_DIR = path.join(home, '.deerdawn');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CLAUDE_PROJECT_DIR = repo;
  delete process.env.DEERDAWN_API_KEY;
  delete process.env.DEERDAWN_API_URL;
  delete process.env.DEERDAWN_SURFACE_ID;
  write(home, '.deerdawn/credentials.json', JSON.stringify({ api_key: 'dd_test_key' }));
  try {
    return fn(home, repo);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const surfaceOf = (status, id) => status.surfaces.find((surface) => surface.id === id);

// What an earlier boot of the stdio server left in AGENTS.md: the person's text,
// a blank line, then the DeerDawn block.
const USER_AGENTS = '# Codex rules\nBe terse. USERMARK-CODEX\n';
const AGENTS_WITH_STALE_BLOCK = `${USER_AGENTS.trimEnd()}\n\n${buildDeerdawnInstructionBlock().trimEnd()}\n`;
const USER_TOML = 'model = "o3"\n\n[mcp_servers.other]\ncommand = "other"\nargs = ["a"]\n';

function tomlIsValid(file) {
  try {
    execFileSync('python3', ['-c', 'import tomllib,sys;tomllib.load(open(sys.argv[1],"rb"))', file], { stdio: 'pipe' });
    return true;
  } catch (err) {
    // No python3 (or no tomllib) on this runner: the structural asserts still hold.
    if (err && (err.code === 'ENOENT' || /No module named/.test(String(err.stderr)))) return true;
    return false;
  }
}

test('Codex: an AGENTS.md block with no server in config.toml is not "configured"', () => {
  withHome((home) => {
    write(home, '.codex/AGENTS.md', AGENTS_WITH_STALE_BLOCK);
    write(home, '.codex/config.toml', USER_TOML);

    const codex = surfaceOf(inspectLocalSetupStatus(), 'codex');
    assert.equal(codex.configured, false, 'instructions alone are not a connection');
    assert.equal(codex.verified, false);
    assert.equal(codex.config_has_deerdawn_mcp, false);
    assert.equal(codex.state, 'detected');
    // Said for what it is: the instructions are there, the server is not.
    assert.equal(codex.degraded_reason, 'instructions_without_mcp_server');
  });
});

test('Codex: a real registration counts, in either form, and a look-alike does not', () => {
  withHome((home) => {
    // What `codex mcp add deerdawn --url ...` writes.
    write(home, '.codex/config.toml', `${USER_TOML}\n[mcp_servers.deerdawn]\nurl = "https://api.deerdawn.com/mcp"\n`);
    let codex = surfaceOf(inspectLocalSetupStatus(), 'codex');
    assert.equal(codex.configured, true, 'the hosted URL form is a registration');
    assert.equal(codex.config_has_deerdawn_mcp, true);
    assert.equal(codex.config_format_valid, true);
    assert.equal(codex.state, 'configured');

    // A commented-out table registers nothing, whatever a substring match says.
    write(home, '.codex/config.toml', `${USER_TOML}\n# [mcp_servers.deerdawn]\n# url = "https://api.deerdawn.com/mcp"\n`);
    codex = surfaceOf(inspectLocalSetupStatus(), 'codex');
    assert.equal(codex.configured, false, 'a comment is not a registration');
    assert.equal(codex.config_has_deerdawn_mcp, false);

    // A table with nothing to start or reach is present but not runnable.
    write(home, '.codex/config.toml', `${USER_TOML}\n[mcp_servers.deerdawn]\nstartup_timeout_sec = 120\n`);
    codex = surfaceOf(inspectLocalSetupStatus(), 'codex');
    assert.equal(codex.config_has_deerdawn_mcp, true);
    assert.equal(codex.config_format_valid, false);
    assert.equal(codex.configured, false, 'a table with no command or url cannot run');
  });
});

test('Cursor: rules with no server in mcp.json are not "configured"; the url form is', () => {
  withHome((home) => {
    write(home, '.cursor/mcp.json', JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } }));
    write(home, '.cursor/rules/deerdawn.mdc', `---\nalwaysApply: true\n---\n\n${buildDeerdawnInstructionBlock()}`);

    let cursor = surfaceOf(inspectLocalSetupStatus(), 'cursor');
    assert.equal(cursor.configured, false, 'a rules file is not a connection');
    assert.equal(cursor.config_has_deerdawn_mcp, false);
    assert.equal(cursor.state, 'detected');
    assert.equal(cursor.degraded_reason, 'instructions_without_mcp_server');

    // The hosted entry the Cursor setup guide tells people to add.
    write(home, '.cursor/mcp.json', JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' }, deerdawn: { url: 'https://api.deerdawn.com/mcp' } } }));
    cursor = surfaceOf(inspectLocalSetupStatus(), 'cursor');
    assert.equal(cursor.configured, true);
    assert.equal(cursor.config_format_valid, true, 'a url entry is a valid Cursor registration');
  });
});

test('apply_setup(codex) registers the server, keeps every other server and key, and reports from the file', () => {
  withHome((home) => {
    write(home, '.codex/AGENTS.md', AGENTS_WITH_STALE_BLOCK);
    const tomlPath = write(home, '.codex/config.toml', USER_TOML);

    // Nothing registered: "auto" says so and offers the entry; the write is asked for by name.
    const offered = applySurfaceSetup('codex', 'auto');
    assert.equal(offered.applied, false);
    assert.equal(read(home, '.codex/config.toml'), USER_TOML, 'auto writes nothing unasked');
    const result = applySurfaceSetup('codex', 'repair');
    const toml = read(home, '.codex/config.toml');

    assert.equal(result.already_configured, false, 'nothing was registered, so nothing was already configured');
    assert.equal(result.applied, true);
    assert.ok(toml.startsWith(USER_TOML.trimEnd()), `the person's config survives byte for byte:\n${toml}`);
    assert.match(toml, /^\[mcp_servers\.deerdawn\]\ncommand = "npx"/m);
    assert.ok(tomlIsValid(tomlPath), `config.toml must still parse:\n${toml}`);
    assert.equal(surfaceOf(result.status, 'codex').configured, true, 'the report is the read-back');
  });
});

test('apply_setup(codex) that cannot register says so, names the command, and writes no instructions', () => {
  withHome((home) => {
    write(home, '.codex/AGENTS.md', USER_AGENTS);
    // A DeerDawn table already exists but cannot run. Appending a second one
    // would make the file invalid TOML, so setup must not write it.
    const brokenToml = `${USER_TOML}\n[mcp_servers.deerdawn]\nstartup_timeout_sec = 120\n`;
    write(home, '.codex/config.toml', brokenToml);

    const result = applySurfaceSetup('codex', 'auto');

    assert.equal(result.applied, false);
    assert.equal(result.already_configured, false, 'an unrunnable table is not "already configured"');
    assert.equal(surfaceOf(result.status, 'codex').configured, false);
    assert.ok(result.reason, 'a failure carries its reason');
    assert.match(result.next_step, /codex mcp add deerdawn --url https:\/\/api\.deerdawn\.com\/mcp/);
    assert.match(result.next_step, /codex mcp login deerdawn/);
    assert.equal(read(home, '.codex/config.toml'), brokenToml, 'config.toml untouched');
    // No block ordering Codex to call a tool it cannot see.
    assert.equal(read(home, '.codex/AGENTS.md'), USER_AGENTS);
  });
});

test('apply_setup(claude_code) does not call an entry in ~/.claude/settings.json a connection', () => {
  withHome((home) => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });

    const result = applySurfaceSetup('claude_code', 'auto');
    const claude = surfaceOf(result.status, 'claude_code');

    // Claude Code reads servers from ~/.claude.json and .mcp.json. Whatever was
    // written to settings.json, it is not registered, and the report says so.
    assert.equal(result.applied, false, 'nothing Claude Code reads was registered');
    assert.equal(claude.configured, false);
    assert.equal(claude.verified, false);
    assert.match(result.reason, /\.claude\.json/);
    assert.match(result.next_step, /claude mcp add|@deerdawn\/mcp-server@latest setup/);
  });

  withHome((home) => {
    // Registered where Claude Code actually looks: user scope in ~/.claude.json.
    write(home, '.claude.json', JSON.stringify({ mcpServers: { deerdawn: { type: 'stdio', command: 'npx', args: ['-y', '@deerdawn/mcp-server@latest'] } } }));

    const result = applySurfaceSetup('claude_code', 'auto');
    assert.equal(result.already_configured, true);
    assert.equal(result.applied, false);
    assert.deepEqual(result.changed_paths, []);
    assert.equal(surfaceOf(result.status, 'claude_code').configured, true);
  });
});

test('apply_setup for a surface it does not configure says why instead of a bare false', () => {
  withHome(() => {
    for (const surface of ['windsurf', 'vscode']) {
      const result = applySurfaceSetup(surface, 'auto');
      assert.equal(result.applied, false);
      assert.ok(result.reason && result.reason.includes(surface), `${surface}: ${JSON.stringify(result.reason)}`);
      assert.match(result.reason, /claude_code, cursor, claude_desktop(,| and) codex/);
    }
  });
});

test('Cursor: a DeerDawn server in the project\'s own .cursor/mcp.json is a registration', () => {
  withHome((home, repo) => {
    write(home, '.cursor/mcp.json', JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } }));
    write(repo, '.cursor/mcp.json', JSON.stringify({ mcpServers: { deerdawn: { url: 'https://api.deerdawn.com/mcp' } } }));

    const cursor = surfaceOf(inspectLocalSetupStatus(), 'cursor');
    assert.equal(cursor.configured, true, 'Cursor reads the project file too');
    assert.equal(cursor.config_has_deerdawn_mcp, true);
  });
});

test('the tool this server is running inside is connected, whatever its global config says', () => {
  withHome((home) => {
    write(home, '.codex/AGENTS.md', '# mine\n');
    fs.mkdirSync(path.join(home, '.cursor', 'rules'), { recursive: true });

    // Told by the caller (the MCP handshake reaches setup-status this way).
    let status = inspectLocalSetupStatus('local_direct', { runningSurface: 'codex' });
    assert.equal(surfaceOf(status, 'codex').configured, true);
    assert.equal(surfaceOf(status, 'cursor').configured, false);

    // Or named in the server's own env, as a tool-specific config sets it.
    process.env.DEERDAWN_SURFACE_ID = 'cursor';
    status = inspectLocalSetupStatus();
    assert.equal(surfaceOf(status, 'cursor').configured, true);
    assert.equal(surfaceOf(status, 'codex').configured, false);
  });
});
