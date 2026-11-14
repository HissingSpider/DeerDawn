const test = require('node:test');
// No home-like variable from the developer's shell reaches this file: see
// contain-home.cjs.
require('./contain-home.cjs').containTestProcess(require('node:test').after);
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * THE GUARD ITSELF: a test file that leaves a write under a CODEX_HOME it did
 * not create fails, and one that stays inside its own directories does not.
 *
 * Each case runs a one-test fixture in a child `node --test`, with CODEX_HOME
 * exported to a sentinel directory seeded the way a developer's is, exactly as
 * a shell would hand it to the suite.
 */

const CONTAIN = path.join(__dirname, 'contain-home.cjs');

function runFixture(body) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-guard-')));
  const sentinel = path.join(dir, 'developer-codex-home');
  fs.mkdirSync(sentinel);
  const seeded = { 'config.toml': 'model = "o3"\n[mcp_servers.deerdawn]\nurl = "https://example.invalid/mcp"\n', 'AGENTS.md': '# the developer\'s own\n' };
  for (const [name, text] of Object.entries(seeded)) fs.writeFileSync(path.join(sentinel, name), text);
  const fixture = path.join(dir, 'fixture.test.js');
  fs.writeFileSync(fixture, [
    "const test = require('node:test');",
    `require(${JSON.stringify(CONTAIN)}).containTestProcess(require('node:test').after);`,
    "const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');",
    `const SENTINEL = ${JSON.stringify(sentinel)};`,
    `test('fixture', () => { ${body} });`,
  ].join('\n'));
  const run = spawnSync(process.execPath, ['--test', fixture], {
    env: { PATH: process.env.PATH, HOME: dir, CODEX_HOME: sentinel },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const after = Object.fromEntries(Object.keys(seeded).map((name) => [name, fs.readFileSync(path.join(sentinel, name), 'utf8')]));
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: run.status, output: `${run.stdout}${run.stderr}`, seeded, after };
}

test('a test that writes AGENTS.md under the inherited CODEX_HOME fails its file', () => {
  const run = runFixture("fs.appendFileSync(path.join(SENTINEL, 'AGENTS.md'), 'written by a test\\n');");
  assert.notEqual(run.status, 0, run.output);
  assert.match(run.output, /A test wrote under CODEX_HOME=/);
});

test('a test that rewrites config.toml under the inherited CODEX_HOME fails its file', () => {
  const run = runFixture("fs.writeFileSync(path.join(SENTINEL, 'config.toml'), 'model = \"o4\"\\n');");
  assert.notEqual(run.status, 0, run.output);
  assert.match(run.output, /A test wrote under CODEX_HOME=/);
});

test('inside the fixture, CODEX_HOME is unset and HOME is a directory of its own', () => {
  const run = runFixture("if (process.env.CODEX_HOME !== undefined) throw new Error('CODEX_HOME leaked'); if (!process.env.HOME.includes('dd-test-home-')) throw new Error('HOME not contained');");
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.after, run.seeded);
});

test('a test that points CODEX_HOME inside a directory it created, and writes there, passes', () => {
  const run = runFixture("const own = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-own-codex-')); process.env.CODEX_HOME = own; fs.writeFileSync(path.join(own, 'AGENTS.md'), 'mine\\n'); fs.rmSync(own, { recursive: true, force: true });");
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.after, run.seeded);
});
