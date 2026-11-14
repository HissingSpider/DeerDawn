const test = require('node:test');
// No home-like variable from the developer's shell reaches this file: see
// contain-home.cjs.
require('./contain-home.cjs').containTestProcess(require('node:test').after);
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { applySurfaceSetup, inspectLocalSetupStatus } = require('../src/setup-status.js');

/**
 * CODEX'S config.toml IS READ AS TOML.
 *
 * Codex takes a server registered in any form TOML allows: the
 * `[mcp_servers.deerdawn]` table `codex mcp add` writes, but also an inline table
 * under `[mcp_servers]` (`deerdawn = { url = "..." }`) or dotted keys
 * (`mcp_servers.deerdawn.url = "..."`). Real codex 0.154 lists every one of
 * those as enabled. DeerDawn scanned for `[mcp_servers.<name>]` headers only, so
 * observed in a walk (2026-09-28): an inline registration read as "not
 * connected", `setup` told the person to run `codex mcp add`, and
 * apply_setup(codex) APPENDED a second `[mcp_servers.deerdawn]` table and
 * answered applied:true. Codex then refuses the whole file ("duplicate key"),
 * so every MCP server the person had in Codex stopped.
 *
 * The rule under test: registration is read from the parsed file; apply_setup
 * never writes a key that already exists in any form, writes nothing to a file
 * it cannot parse (and says so), and after a write the file still parses and
 * still holds everything it held. CODEX_HOME is where Codex reads both
 * config.toml and AGENTS.md when it is set (verified against codex-cli 0.154).
 *
 * Everything runs under a throwaway home; nothing real is read or written.
 */

const ENV_KEYS = ['DEERDAWN_HOME_DIR', 'DEERDAWN_DIR', 'HOME', 'USERPROFILE', 'CLAUDE_PROJECT_DIR', 'DEERDAWN_API_KEY', 'DEERDAWN_API_URL', 'DEERDAWN_SURFACE_ID', 'CODEX_HOME'];

function withHome(fn) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-codex-toml-home-')));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-codex-toml-repo-')));
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
  delete process.env.CODEX_HOME;
  write(home, '.deerdawn/credentials.json', JSON.stringify({ api_key: 'dd_test_key' }));
  try {
    return fn(home);
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
const codexOf = (status) => status.surfaces.find((surface) => surface.id === 'codex');

/** Python's tomllib as an independent parser, when this machine has one. */
function tomllibAccepts(text) {
  try {
    execFileSync('python3', ['-c', 'import tomllib,sys;tomllib.loads(sys.stdin.read())'], { input: text, stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch (err) {
    if (err && (err.code === 'ENOENT' || /No module named/.test(String(err.stderr)))) return null;
    return false;
  }
}

const URL = 'https://api.deerdawn.com/mcp';
const OTHERS = 'model = "gpt-5-codex"\napproval_policy = "on-request"\n\n[mcp_servers.github]\ncommand = "npx"\nargs = ["gh"]\n\n[mcp_servers.github.env]\nGITHUB_TOKEN = "ghp_keep_me"\n';

// Every form codex-cli 0.154 lists as an enabled `deerdawn` server.
const REGISTERED = {
  'a [mcp_servers.deerdawn] table': `[mcp_servers.deerdawn]\nurl = "${URL}"\n`,
  'a quoted, spaced table header': `[ mcp_servers . "deerdawn" ]\nurl = '${URL}'  # hosted\n`,
  'an inline table under [mcp_servers]': `[mcp_servers]\ndeerdawn = { url = "${URL}" }\n`,
  'dotted keys under [mcp_servers]': `[mcp_servers]\ndeerdawn.url = "${URL}"\n`,
  'top-level dotted keys': `mcp_servers.deerdawn.url = "${URL}"\n`,
  'a top-level inline table': `mcp_servers = { deerdawn = { url = "${URL}" } }\n`,
  'a stdio server over a multi-line array, with comments': `[mcp_servers.deerdawn] # DeerDawn\ncommand = "npx" # via npx\nargs = [\n  "-y", # yes\n  "@deerdawn/mcp-server@latest",\n]\n\n[mcp_servers.deerdawn.env]\nDEERDAWN_API_URL = "https://api.deerdawn.com"\n`,
  'another name, our url, inline': `[mcp_servers]\nmemory = { url = "${URL}/claude" }\n`,
  'a multi-line inline table (TOML 1.1, which codex accepts)': `[mcp_servers]\ndeerdawn = {\n  url = "${URL}",\n}\n`,
  'after other servers and keys': `${OTHERS}\n[mcp_servers.deerdawn]\nurl = "${URL}"\n`,
  'a url with a # inside the string': `[mcp_servers.deerdawn]\nurl = "${URL}#section" # a comment\n`,
};

// None of these registers a server Codex can start or reach.
const NOT_REGISTERED = {
  'nothing': OTHERS,
  'a commented-out table': `${OTHERS}\n# [mcp_servers.deerdawn]\n# url = "${URL}"\n`,
  'a commented-out inline entry': `[mcp_servers]\n# deerdawn = { url = "${URL}" }\n`,
  'the table header inside a multi-line string': `notes = """\n[mcp_servers.deerdawn]\nurl = "${URL}"\n"""\n`,
  'an entry only in a trailing comment': `[mcp_servers.other]\nurl = "https://example.com/mcp" # deerdawn = { url = "${URL}" }\n`,
};

for (const [label, toml] of Object.entries(REGISTERED)) {
  test(`registered as ${label}: Codex is configured`, () => {
    withHome((home) => {
      write(home, '.codex/config.toml', toml);
      const codex = codexOf(inspectLocalSetupStatus());
      assert.equal(codex.configured, true, toml);
      assert.equal(codex.config_has_deerdawn_mcp, true);
      assert.equal(codex.config_format_valid, true);
    });
  });
}

for (const [label, toml] of Object.entries(NOT_REGISTERED)) {
  test(`${label}: Codex is not configured`, () => {
    withHome((home) => {
      write(home, '.codex/config.toml', toml);
      assert.equal(codexOf(inspectLocalSetupStatus()).configured, false, toml);
    });
  });
}

for (const [label, toml] of Object.entries(REGISTERED)) {
  test(`apply_setup(codex) with DeerDawn registered as ${label}: config.toml is not touched`, () => {
    withHome((home) => {
      write(home, '.codex/AGENTS.md', '# Codex notes\n');
      write(home, '.codex/config.toml', toml);

      for (const mode of ['auto', 'repair']) {
        const result = applySurfaceSetup('codex', mode);
        assert.equal(read(home, '.codex/config.toml'), toml, `${mode}: no second registration is written`);
        assert.ok(!result.changed_paths.some((p) => p.endsWith('config.toml')), `${mode}: ${JSON.stringify(result.changed_paths)}`);
        assert.equal(codexOf(result.status).configured, true);
        if (mode === 'auto') assert.equal(result.already_configured, true, 'auto reports it was already registered');
      }
    });
  });
}

test('complete_setup\'s path, the walker\'s case: an inline registration is never duplicated', () => {
  withHome((home) => {
    const toml = `model = "gpt-5-codex"\n[mcp_servers]\ndeerdawn = { url = "${URL}" }\ngithub = { command = "npx", args = ["gh"] }\n`;
    write(home, '.codex/AGENTS.md', '# Codex notes\n');
    write(home, '.codex/config.toml', toml);

    const result = applySurfaceSetup('codex', 'auto');

    assert.equal(result.already_configured, true);
    assert.equal(read(home, '.codex/config.toml'), toml);
  });
});

test('an mcp_servers.deerdawn entry that cannot run is not given a second one, in any form', () => {
  for (const toml of [
    `[mcp_servers.deerdawn]\nstartup_timeout_sec = 120\n`,
    `[mcp_servers]\ndeerdawn = { startup_timeout_sec = 120 }\n`,
    `mcp_servers.deerdawn.startup_timeout_sec = 120\n`,
  ]) {
    withHome((home) => {
      write(home, '.codex/AGENTS.md', '# Codex notes\n');
      write(home, '.codex/config.toml', toml);

      const result = applySurfaceSetup('codex', 'auto');

      assert.equal(read(home, '.codex/config.toml'), toml, 'untouched');
      assert.equal(read(home, '.codex/AGENTS.md'), '# Codex notes\n', 'no instructions without a server');
      assert.equal(result.applied, false);
      assert.match(result.reason, /mcp_servers\.deerdawn/);
      assert.match(result.next_step, /codex mcp add deerdawn --url/);
    });
  }
});

test('a config.toml that cannot be parsed is left alone, and the answer says so and gives the command', () => {
  for (const toml of [
    `[mcp_servers.deerdawn\nurl = "${URL}"\n`,
    'model = "gpt-5-codex\n[mcp_servers.github]\ncommand = "npx"\n',
    `[mcp_servers.deerdawn]\nurl = "${URL}"\n[mcp_servers.deerdawn]\ncommand = "npx"\n`,
  ]) {
    withHome((home) => {
      write(home, '.codex/AGENTS.md', '# Codex notes\n');
      write(home, '.codex/config.toml', toml);

      const result = applySurfaceSetup('codex', 'auto');

      assert.equal(read(home, '.codex/config.toml'), toml, 'untouched');
      assert.equal(read(home, '.codex/AGENTS.md'), '# Codex notes\n');
      assert.equal(result.applied, false);
      assert.equal(codexOf(result.status).configured, false);
      assert.match(result.reason, /cannot be parsed|could not be parsed/i, result.reason);
      assert.match(result.reason, /line \d+/, result.reason);
      assert.match(result.next_step, /codex mcp add deerdawn --url/);
    });
  }
});

test('a config.toml nested too deeply to read is reported as unparseable, not thrown', () => {
  withHome((home) => {
    const toml = `deep = ${'['.repeat(50000)}${']'.repeat(50000)}\n`;
    write(home, '.codex/config.toml', toml);

    const codex = codexOf(inspectLocalSetupStatus());
    const result = applySurfaceSetup('codex', 'auto');

    assert.equal(codex.configured, false);
    assert.equal(read(home, '.codex/config.toml'), toml, 'untouched');
    assert.match(result.reason, /cannot be parsed/);
  });
});

test('a top-level inline mcp_servers cannot take a [mcp_servers.deerdawn] table: nothing is written', () => {
  withHome((home) => {
    const toml = 'mcp_servers = { github = { command = "npx", args = ["gh"] } }\n';
    write(home, '.codex/config.toml', toml);

    const result = applySurfaceSetup('codex', 'auto');

    assert.equal(read(home, '.codex/config.toml'), toml, 'appending a table would make the file invalid, so nothing is appended');
    assert.equal(result.applied, false);
    assert.ok(result.reason);
    assert.match(result.next_step, /codex mcp add deerdawn --url/);
  });
});

test('apply_setup(codex) that registers keeps every server and key, and the file still parses', () => {
  withHome((home) => {
    write(home, '.codex/config.toml', OTHERS);

    // Asked for by name (repair): with no registration visible, "auto" only offers it.
    const offered = applySurfaceSetup('codex', 'auto');
    assert.equal(offered.applied, false);
    assert.equal(read(home, '.codex/config.toml'), OTHERS, 'auto writes nothing unasked');
    const result = applySurfaceSetup('codex', 'repair');
    const toml = read(home, '.codex/config.toml');

    assert.equal(result.applied, true);
    assert.ok(toml.startsWith(OTHERS), toml);
    for (const kept of ['gpt-5-codex', 'approval_policy', '[mcp_servers.github]', 'ghp_keep_me']) assert.ok(toml.includes(kept), kept);
    assert.notEqual(tomllibAccepts(toml), false, `tomllib must accept it:\n${toml}`);
    assert.equal(codexOf(result.status).configured, true);
  });
});

test('CODEX_HOME: the registration is read there, and ~/.codex says nothing about Codex', () => {
  withHome((home) => {
    const codexHome = path.join(home, 'dotfiles', 'codex');
    process.env.CODEX_HOME = codexHome;
    write(home, '.codex/config.toml', `[mcp_servers.deerdawn]\nurl = "${URL}"\n`);
    write(home, 'dotfiles/codex/config.toml', OTHERS);

    let codex = codexOf(inspectLocalSetupStatus());
    assert.equal(codex.configured, false, 'Codex does not read ~/.codex when CODEX_HOME is set');

    write(home, 'dotfiles/codex/config.toml', `${OTHERS}\n[mcp_servers]\ndeerdawn = { url = "${URL}" }\n`);
    write(home, '.codex/config.toml', OTHERS);
    codex = codexOf(inspectLocalSetupStatus());
    assert.equal(codex.configured, true);
    assert.equal(codex.path, path.join(codexHome, 'config.toml'));
  });
});

test('CODEX_HOME: apply_setup(codex) registers and instructs Codex there, not in ~/.codex', () => {
  withHome((home) => {
    const codexHome = path.join(home, 'dotfiles', 'codex');
    process.env.CODEX_HOME = codexHome;
    write(home, 'dotfiles/codex/config.toml', OTHERS);
    write(home, 'dotfiles/codex/AGENTS.md', '# Codex notes\n');
    write(home, '.codex/config.toml', 'model = "o3"\n');
    write(home, '.codex/AGENTS.md', '# the old home\n');

    const result = applySurfaceSetup('codex', 'repair');

    assert.equal(result.applied, true);
    assert.match(read(home, 'dotfiles/codex/config.toml'), /^\[mcp_servers\.deerdawn\]$/m);
    assert.match(read(home, 'dotfiles/codex/AGENTS.md'), /start_session/);
    assert.equal(read(home, '.codex/config.toml'), 'model = "o3"\n');
    assert.equal(read(home, '.codex/AGENTS.md'), '# the old home\n');
  });
});
