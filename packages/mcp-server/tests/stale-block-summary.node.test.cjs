'use strict';

// Black-box, against the BUILT server: `deerdawn-mcp setup`, which a person
// runs on purpose, names a DeerDawn block that has no visible server behind it
// and says in one line how to connect the tool or remove the block. A boot never
// removes one (a Codex or Cursor registration can live where DeerDawn cannot
// see it: see tests/stale-block-upgrade.test.ts and no-cross-tool-removal), so
// this line is how a person upgraded from 1.0.53 finds out their Codex
// AGENTS.md orders a call Codex cannot make.
//
// Runs under `npm run test:node`, which follows the build. Throwaway HOME, stub
// binaries first on PATH, API on a closed local port.

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
const OPEN = '<!-- deerdawn:auto-context -->';
const CLOSE = '<!-- /deerdawn:auto-context -->';
const BLOCK = `${OPEN}\n## DeerDawn\nAlways call \`start_session\` before your first response.\n${CLOSE}`;

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function runSetup(t, home) {
  const bin = tempDir('dd-stale-summary-bin-');
  for (const name of ['claude', 'codex', 'cursor', 'open', 'xdg-open']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const cwd = tempDir('dd-stale-summary-cwd-');
  const child = spawn(process.execPath, [DIST, 'setup'], {
    cwd,
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: home, USERPROFILE: home, DEERDAWN_API_URL: 'http://127.0.0.1:9', DEERDAWN_NO_BROWSER: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.kill('SIGKILL');
    for (const dir of [home, cwd, bin]) fs.rmSync(dir, { recursive: true, force: true });
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', () => {});
  return new Promise((resolve) => child.on('exit', () => resolve(stdout)));
}

const lineAbout = (stdout, file) => stdout.split('\n').find((line) => line.includes(file)) ?? '';

test('a Codex AGENTS.md block with no server is named, with the command and how to remove it; the file is untouched', async (t) => {
  const home = tempDir('dd-stale-summary-home-');
  const agents = `# Codex notes\n\nUse pnpm.\n\n${BLOCK}\n`;
  write(home, '.deerdawn/credentials.json', JSON.stringify({ api_key: 'dd_test_key' }));
  write(home, '.codex/config.toml', 'model = "o3"\n');
  write(home, '.codex/AGENTS.md', agents);

  const stdout = await runSetup(t, home);

  const line = lineAbout(stdout, '~/.codex/AGENTS.md');
  assert.match(line, /no DeerDawn server/i, stdout);
  // Names the file and the tool, says it was left as it is, and offers the removal.
  assert.match(line, /for Codex/, line);
  assert.match(line, /left as it is/, line);
  assert.match(line, /remove-block codex/, line);
  assert.match(stdout, /codex mcp add deerdawn --url/, stdout);
  assert.equal(fs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8'), agents);
});

test('a Cursor rule with no server registered for Cursor here is named, with how to remove it; the file is untouched', async (t) => {
  const home = tempDir('dd-stale-summary-home-');
  const rule = `---\nalwaysApply: true\n---\n\n${BLOCK}\n`;
  write(home, '.deerdawn/credentials.json', JSON.stringify({ api_key: 'dd_test_key' }));
  write(home, '.cursor/mcp.json', JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } }));
  write(home, '.cursor/rules/deerdawn.mdc', rule);

  const stdout = await runSetup(t, home);

  const line = lineAbout(stdout, '~/.cursor/rules/deerdawn.mdc');
  assert.match(line, /no DeerDawn server/i, stdout);
  assert.match(line, /for Cursor/, line);
  assert.match(line, /left as it is/, line);
  assert.match(line, /remove-block cursor/, line);
  assert.equal(fs.readFileSync(path.join(home, '.cursor', 'rules', 'deerdawn.mdc'), 'utf8'), rule);
});

test('a registered Codex, or a file with only a quoted marker, gets no such line', async (t) => {
  const home = tempDir('dd-stale-summary-home-');
  write(home, '.deerdawn/credentials.json', JSON.stringify({ api_key: 'dd_test_key' }));
  write(home, '.codex/config.toml', '[mcp_servers]\ndeerdawn = { url = "https://api.deerdawn.com/mcp" }\n');
  write(home, '.codex/AGENTS.md', `# Codex notes\n\n${BLOCK}\n`);
  write(home, '.cursor/mcp.json', JSON.stringify({ mcpServers: {} }));
  write(home, '.cursor/rules/deerdawn.mdc', `Notes: DeerDawn's block sits between \`${OPEN}\` and \`${CLOSE}\`.\n`);

  const stdout = await runSetup(t, home);

  assert.equal(lineAbout(stdout, '~/.codex/AGENTS.md').match(/no DeerDawn server/i), null, stdout);
  assert.equal(lineAbout(stdout, '~/.cursor/rules/deerdawn.mdc').match(/no DeerDawn server/i), null, stdout);
});
