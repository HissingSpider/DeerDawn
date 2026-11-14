'use strict';

// Black-box, against the BUILT server: `deerdawn-mcp setup` prints a summary a
// person reads as "these tools are now connected". It printed
//
//   Codex        ✓  ~/.codex/AGENTS.md
//   Cursor       ✓  ~/.cursor/rules/deerdawn.mdc
//
// on a machine where neither tool had a DeerDawn server registered — the tick
// came from the existence of an instruction file, and setup had just written an
// order to call start_session into Codex's global AGENTS.md. A tick now means a
// server is registered in that tool's own config, and nothing else.
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
  const dir = tempDir('dd-setup-summary-bin-');
  for (const name of ['claude', 'codex', 'cursor', 'open', 'xdg-open']) {
    fs.writeFileSync(path.join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  return dir;
}

function runSetup(t, home, projectDir) {
  const bin = stubBin();
  const child = spawn(process.execPath, [DIST, 'setup'], {
    cwd: projectDir,
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HOME: home,
      USERPROFILE: home,
      DEERDAWN_API_URL: 'http://127.0.0.1:9',
      DEERDAWN_NO_BROWSER: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.kill('SIGKILL');
    for (const dir of [home, projectDir, bin]) fs.rmSync(dir, { recursive: true, force: true });
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, stdout, stderr })));
}

const USER_AGENTS = '# Codex rules\nBe terse. USERMARK-CODEX\n';
const USER_TOML = 'model = "o3"\n';
const USER_RULE = '---\nalwaysApply: true\n---\nUse tabs.\n';

function seedHome({ codexRegistered, cursorRegistered }) {
  const home = tempDir('dd-setup-summary-home-');
  write(home, '.deerdawn/credentials.json', JSON.stringify({ api_key: 'dd_test_key' }));
  write(home, '.codex/AGENTS.md', USER_AGENTS);
  write(home, '.codex/config.toml', codexRegistered
    ? `${USER_TOML}\n[mcp_servers.deerdawn]\nurl = "https://api.deerdawn.com/mcp"\n`
    : USER_TOML);
  write(home, '.cursor/mcp.json', JSON.stringify({
    mcpServers: cursorRegistered
      ? { github: { command: 'gh-mcp' }, deerdawn: { url: 'https://api.deerdawn.com/mcp' } }
      : { github: { command: 'gh-mcp' } },
  }));
  write(home, '.cursor/rules/mine.mdc', USER_RULE);
  return home;
}

const line = (stdout, label) => stdout.split('\n').find((l) => l.trimStart().startsWith(label)) ?? '';

test('setup ticks neither Codex nor Cursor when neither has a DeerDawn server registered', async (t) => {
  const home = seedHome({ codexRegistered: false, cursorRegistered: false });
  const projectDir = tempDir('dd-setup-summary-cwd-');

  const result = await runSetup(t, home, projectDir);

  const codex = line(result.stdout, 'Codex');
  const cursor = line(result.stdout, 'Cursor');
  assert.doesNotMatch(codex, /✓/, `Codex is not connected:\n${result.stdout}`);
  assert.doesNotMatch(cursor, /✓/, `Cursor is not connected:\n${result.stdout}`);
  // Said for what it is, with the step that connects it.
  assert.match(result.stdout, /codex mcp add deerdawn --url \S+\/mcp/, result.stdout);
  assert.match(result.stdout, /codex mcp login deerdawn/, result.stdout);
  assert.match(result.stdout, /"url": "\S+\/mcp"/, result.stdout);

  // And nothing ordering either tool to call DeerDawn was written.
  assert.equal(fs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8'), USER_AGENTS);
  assert.equal(fs.existsSync(path.join(home, '.cursor', 'rules', 'deerdawn.mdc')), false);
  assert.equal(fs.readFileSync(path.join(home, '.cursor', 'rules', 'mine.mdc'), 'utf8'), USER_RULE);
});

test('setup ticks Cursor for a registration in the project\'s own .cursor/mcp.json, and writes nothing of Cursor\'s', async (t) => {
  // Cursor reads a project's .cursor/mcp.json as well as the global one. Nothing
  // global, DeerDawn registered in the repo setup is run from: connected here.
  const home = seedHome({ codexRegistered: false, cursorRegistered: false });
  const projectDir = tempDir('dd-setup-summary-cwd-');
  fs.mkdirSync(path.join(projectDir, '.git'));
  write(projectDir, '.cursor/mcp.json', JSON.stringify({ mcpServers: { deerdawn: { url: 'https://api.deerdawn.com/mcp' } } }));

  const result = await runSetup(t, home, projectDir);

  assert.match(line(result.stdout, 'Cursor'), /✓.*this project's \.cursor\/mcp\.json/, result.stdout);
  // Setup registers Claude Code. Cursor is read and ticked, and its files are not written.
  assert.equal(fs.existsSync(path.join(home, '.cursor', 'rules', 'deerdawn.mdc')), false);
  // Codex has nothing registered anywhere, and says so.
  assert.doesNotMatch(line(result.stdout, 'Codex'), /✓/, result.stdout);
});

test('setup ticks Codex and Cursor when each has a DeerDawn server registered, and writes only Claude Code\'s files', async (t) => {
  const home = seedHome({ codexRegistered: true, cursorRegistered: true });
  const projectDir = tempDir('dd-setup-summary-cwd-');

  const result = await runSetup(t, home, projectDir);

  assert.match(line(result.stdout, 'Codex'), /✓/, result.stdout);
  assert.match(line(result.stdout, 'Cursor'), /✓/, result.stdout);
  // Setup configures the tool it registers, Claude Code, and no other: a Codex
  // and a Cursor that are connected are ticked, and their files are not touched.
  assert.equal(fs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8'), USER_AGENTS);
  assert.equal(fs.existsSync(path.join(home, '.cursor', 'rules', 'deerdawn.mdc')), false);
  assert.equal(fs.readFileSync(path.join(home, '.cursor', 'rules', 'mine.mdc'), 'utf8'), USER_RULE);
  // Claude Code gets its SessionStart hook, which delivers the brief. The global
  // ~/.claude/CLAUDE.md block is no longer added (Thing 4.3): the instruction
  // goes only into repos that have a DeerDawn project.
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.ok(JSON.stringify(settings.hooks.SessionStart).includes('session-context'), 'Claude Code gets its hook');
  assert.equal(fs.existsSync(path.join(home, '.claude', 'CLAUDE.md')), false);
});
