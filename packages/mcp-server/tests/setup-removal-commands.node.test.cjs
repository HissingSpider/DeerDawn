'use strict';

// Black-box, against the BUILT server: the two commands that take away what
// DeerDawn no longer writes, and only when a person runs them.
//
//   deerdawn-mcp remove-block <tool>   a stale DeerDawn block (no DeerDawn server
//                                      registered for the tool)
//   deerdawn-mcp remove-key            the API key an older setup wrote in plain
//                                      text into a file its tool does not read
//
// `setup` names both and removes neither (stale-block-summary.node.test.cjs
// covers the blocks); these tests cover the naming of the key and the commands.
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
const TOKEN = '0123456789abcdef0123456789abcdef';
const OPEN = `<!-- deerdawn:auto-context ${TOKEN}. DeerDawn replaces anything edited between this line and the closing marker. Keep your own notes outside it. -->`;
const CLOSE = `<!-- /deerdawn:auto-context ${TOKEN} -->`;
const BLOCK = `${OPEN}\n## DeerDawn\nAlways call \`start_session\` before your first response.\n${CLOSE}`;
const KEY = 'dd_live_PLAINTEXT_KEY_1234567890';

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function run(t, home, args) {
  const bin = tempDir('dd-removal-bin-');
  for (const name of ['claude', 'codex', 'cursor', 'open', 'xdg-open']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const cwd = tempDir('dd-removal-cwd-');
  const child = spawn(process.execPath, [DIST, ...args], {
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
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, stdout })));
}

const SETTINGS = {
  model: 'opus',
  mcpServers: { deerdawn: { command: 'npx', args: ['-y', '@deerdawn/mcp-server@latest'], env: { DEERDAWN_API_URL: 'https://api.deerdawn.com', DEERDAWN_API_KEY: KEY } } },
};

test('remove-block codex takes DeerDawn\'s block out of AGENTS.md when Codex has no DeerDawn server, and nothing else', async (t) => {
  const home = tempDir('dd-removal-home-');
  write(home, '.deerdawn/install.json', JSON.stringify({ block_token: TOKEN }));
  write(home, '.codex/config.toml', 'model = "o3"\n');
  write(home, '.codex/AGENTS.md', `# Codex notes\n\nUse pnpm.\n\n${BLOCK}\n\n## Later\nKeep answers short.\n`);

  const result = await run(t, home, ['remove-block', 'codex']);

  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /Removed DeerDawn's block from .*AGENTS\.md/, result.stdout);
  assert.equal(fs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8'), '# Codex notes\n\nUse pnpm.\n\n\n## Later\nKeep answers short.\n');
  assert.equal(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), 'model = "o3"\n');
});

test('remove-block refuses when the tool has a DeerDawn server registered', async (t) => {
  const home = tempDir('dd-removal-home-');
  const agents = `# Codex notes\n\n${BLOCK}\n`;
  write(home, '.deerdawn/install.json', JSON.stringify({ block_token: TOKEN }));
  write(home, '.codex/config.toml', '[mcp_servers]\ndeerdawn = { url = "https://api.deerdawn.com/mcp" }\n');
  write(home, '.codex/AGENTS.md', agents);

  const registered = await run(t, home, ['remove-block', 'codex']);
  assert.equal(registered.code, 1, registered.stdout);
  assert.match(registered.stdout, /has a DeerDawn server registered/, registered.stdout);
  assert.equal(fs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8'), agents);
});

test('remove-block with no tool, or an unknown one, says what it takes and removes nothing', async (t) => {
  const home = tempDir('dd-removal-home-');
  write(home, '.deerdawn/install.json', JSON.stringify({ block_token: TOKEN }));

  const result = await run(t, home, ['remove-block']);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /claude_code, cursor or codex/, result.stdout);
});

test('remove-key deletes the plain-text key and only the key; setup and status only name it', async (t) => {
  const home = tempDir('dd-removal-home-');
  write(home, '.deerdawn/credentials.json', JSON.stringify({ api_key: KEY }));
  write(home, '.claude/settings.json', JSON.stringify(SETTINGS, null, 2));

  // setup names the file and the command, and leaves the key where it is.
  const setup = await run(t, home, ['setup']);
  assert.match(setup.stdout, /~\/\.claude\/settings\.json holds your DeerDawn API key in plain text/, setup.stdout);
  assert.match(setup.stdout, /remove-key/, setup.stdout);
  assert.ok(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8').includes(KEY), 'setup must not delete it unasked');
  assert.doesNotMatch(setup.stdout, new RegExp(KEY), 'and must not print it');
});

test('remove-key, run on purpose, removes it', async (t) => {
  const home = tempDir('dd-removal-home-');
  write(home, '.deerdawn/credentials.json', JSON.stringify({ api_key: KEY }));
  write(home, '.claude/settings.json', JSON.stringify(SETTINGS, null, 2));

  const result = await run(t, home, ['remove-key']);

  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /Removed the DeerDawn API key from .*settings\.json/, result.stdout);
  const after = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(after.model, 'opus');
  assert.deepEqual(after.mcpServers.deerdawn.env, { DEERDAWN_API_URL: 'https://api.deerdawn.com' });
});

test('remove-key with no such key says so and changes nothing', async (t) => {
  const home = tempDir('dd-removal-home-');
  write(home, '.claude/settings.json', JSON.stringify({ model: 'opus' }));

  const result = await run(t, home, ['remove-key']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Nothing changed/, result.stdout);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), JSON.stringify({ model: 'opus' }));
});

test('setup says a block written by another DeerDawn install is managed by it, and leaves the file as it is', async (t) => {
  const home = tempDir('dd-removal-home-');
  const other = 'e'.repeat(32);
  const foreign = `<!-- deerdawn:auto-context ${other}. DeerDawn replaces anything edited between this line and the closing marker. Keep your own notes outside it. -->\n## DeerDawn\nAlways call \`start_session\`.\n<!-- /deerdawn:auto-context ${other} -->`;
  const claudeMd = `# My notes\n\n${foreign}\n`;
  write(home, '.deerdawn/credentials.json', JSON.stringify({ api_key: KEY }));
  write(home, '.deerdawn/install.json', JSON.stringify({ block_token: TOKEN }));
  write(home, '.claude/CLAUDE.md', claudeMd);

  const result = await run(t, home, ['setup']);

  assert.match(result.stdout, /~\/\.claude\/CLAUDE\.md holds a DeerDawn block that is managed by another DeerDawn install/, result.stdout);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8'), claudeMd);
});

const JSONC_SETTINGS = `// kept by hand\n{\n  /* model */\n  "model": "opus",\n  "mcpServers": { "deerdawn": { "command": "npx", "env": {\n    "DEERDAWN_API_URL": "https://api.deerdawn.com",\n    "DEERDAWN_API_KEY": "${KEY}", // pinned\n  } } },\n}\n`;

test('remove-key reads a settings.json with comments and trailing commas, removes the key, and leaves no readable copy of it', async (t) => {
  const home = tempDir('dd-removal-home-');
  write(home, '.deerdawn/credentials.json', JSON.stringify({ api_key: KEY }));
  write(home, '.claude/settings.json', JSONC_SETTINGS);

  const result = await run(t, home, ['remove-key']);

  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /Removed the DeerDawn API key from .*settings\.json/, result.stdout);
  assert.doesNotMatch(result.stdout, /Nothing changed/);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), JSONC_SETTINGS.replace(`    "DEERDAWN_API_KEY": "${KEY}", // pinned\n`, ''));
  const backups = path.join(home, '.deerdawn', 'setup-backups');
  for (const name of fs.readdirSync(backups)) {
    assert.ok(!fs.readFileSync(path.join(backups, name), 'utf8').includes(KEY), `${name} still holds the key`);
    assert.equal(fs.statSync(path.join(backups, name)).mode & 0o777, 0o600);
  }
  assert.equal(fs.statSync(backups).mode & 0o777, 0o700);
});

test('remove-key on a file it cannot parse names the file and does not say "Nothing changed" about a key it could not remove', async (t) => {
  const home = tempDir('dd-removal-home-');
  const broken = `{ "mcpServers": { "deerdawn": { "env": { "DEERDAWN_API_KEY": "${KEY}" } } \n`;
  write(home, '.claude/settings.json', broken);

  const result = await run(t, home, ['remove-key']);

  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /Not removed from .*settings\.json: .*cannot be parsed/, result.stdout);
  assert.doesNotMatch(result.stdout, /No file holds/);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), broken);
});

test('adopt-block takes over a block another install wrote, on request, when this install has none', async (t) => {
  const home = tempDir('dd-removal-home-');
  const other = 'e'.repeat(32);
  const claudeMd = `# My notes\n\n<!-- deerdawn:auto-context ${other}. DeerDawn replaces anything edited between this line and the closing marker. Keep your own notes outside it. -->\n## DeerDawn\nbody\n<!-- /deerdawn:auto-context ${other} -->\n`;
  write(home, '.claude/CLAUDE.md', claudeMd);
  write(home, '.deerdawn/install.json', JSON.stringify({ block_token: TOKEN }));

  const result = await run(t, home, ['adopt-block', 'claude_code']);

  assert.equal(result.code, 0, result.stdout);
  const after = fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');
  assert.ok(after.includes(`<!-- /deerdawn:auto-context ${TOKEN} -->`) && !after.includes(other), after);
  assert.ok(after.includes('## DeerDawn\nbody\n'));
});
