'use strict';

// Black-box, against the BUILT server: what `deerdawn-mcp setup` prints about
// Codex. A registration written in TOML's inline or dotted form (which codex
// 0.154 lists as enabled) printed "Not connected ... To connect: codex mcp add",
// and a CODEX_HOME registration was never looked for. A config.toml Codex
// cannot parse printed the same "codex mcp add" advice, which cannot work until
// the file parses.
//
// Runs under `npm run test:node`, which follows the build. Everything runs in a
// throwaway HOME, with a stub `claude` first on PATH so `claude mcp add` never
// reaches a real install, and an API URL on a closed local port.

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
// No home-like variable from the developer's shell reaches this file or the
// servers it starts: see ../../shared-context/tests/contain-home.cjs.
require('../../shared-context/tests/contain-home.cjs').containTestProcess(require('node:test').after);

const DIST = path.resolve(__dirname, '..', 'dist', 'index.js');

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function stubBin() {
  const dir = tempDir('dd-codex-summary-bin-');
  for (const name of ['claude', 'codex', 'cursor', 'open', 'xdg-open']) {
    fs.writeFileSync(path.join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  return dir;
}

function runSetup(t, home, extraEnv = {}) {
  const bin = stubBin();
  const projectDir = tempDir('dd-codex-summary-cwd-');
  const child = spawn(process.execPath, [DIST, 'setup'], {
    cwd: projectDir,
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HOME: home,
      USERPROFILE: home,
      DEERDAWN_API_URL: 'http://127.0.0.1:9',
      DEERDAWN_NO_BROWSER: '1',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.kill('SIGKILL');
    for (const dir of [home, projectDir, bin]) fs.rmSync(dir, { recursive: true, force: true });
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', () => {});
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, stdout })));
}

function seedHome() {
  const home = tempDir('dd-codex-summary-home-');
  write(home, '.deerdawn/credentials.json', JSON.stringify({ api_key: 'dd_test_key' }));
  write(home, '.codex/AGENTS.md', '# Codex rules\n');
  return home;
}

const codexLines = (stdout) => {
  const lines = stdout.split('\n');
  const at = lines.findIndex((l) => l.trimStart().startsWith('Codex'));
  return at === -1 ? '' : lines.slice(at, at + 2).join('\n');
};

test('an inline registration ticks Codex', async (t) => {
  const home = seedHome();
  write(home, '.codex/config.toml', 'model = "o3"\n[mcp_servers]\ndeerdawn = { url = "https://api.deerdawn.com/mcp" }\n');

  const { stdout } = await runSetup(t, home);

  assert.match(codexLines(stdout), /Codex\s+✓/, stdout);
});

test('a CODEX_HOME registration ticks Codex and names the file it is in', async (t) => {
  const home = seedHome();
  const codexHome = path.join(home, 'dotfiles', 'codex');
  write(home, 'dotfiles/codex/config.toml', 'mcp_servers.deerdawn.url = "https://api.deerdawn.com/mcp"\n');

  const { stdout } = await runSetup(t, home, { CODEX_HOME: codexHome });

  const codex = codexLines(stdout);
  assert.match(codex, /Codex\s+✓/, stdout);
  // Under the home directory, so shown as ~/dotfiles/codex/config.toml.
  assert.ok(codex.includes(path.join('dotfiles', 'codex', 'config.toml')), codex);
  assert.doesNotMatch(codex, /~\/\.codex\/config\.toml/, codex);
});

test('a config.toml Codex cannot parse is said to be one, not "run codex mcp add"', async (t) => {
  const home = seedHome();
  write(home, '.codex/config.toml', '[mcp_servers.deerdawn\nurl = "https://api.deerdawn.com/mcp"\n');

  const { stdout } = await runSetup(t, home);

  const codex = codexLines(stdout);
  assert.doesNotMatch(codex, /✓/, stdout);
  assert.match(codex, /cannot be parsed/, codex);
  assert.match(codex, /line 1/, codex);
});
