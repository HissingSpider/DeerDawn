'use strict';

// An install signed in ONLY through DEERDAWN_API_KEY — the README's headless
// path — must also be signed in for its capture hooks.
//
// The host applies the MCP server entry's `env` block to the server process and
// to nothing else. The hooks the server installs (Stop flush, SessionStart
// brief) are separate processes that never see it, and flush-session read only
// ~/.deerdawn/credentials.json. So the server installed hooks that could not
// authenticate, and every one of them exited silently: capture switched on,
// nothing captured, nothing said.
//
// Black-box against the BUILT server and the BUILT hook entry point, because
// the failure lives in the gap between two processes. Runs under
// `npm run test:node`, after the build.

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
// No home-like variable from the developer's shell reaches this file or the
// servers it starts: see ../../shared-context/tests/contain-home.cjs.
require('../../shared-context/tests/contain-home.cjs').containTestProcess(require('node:test').after);

const DIST = path.resolve(__dirname, '..', 'dist', 'index.js');
const GOOD_KEY = `dd_envonly_${'b'.repeat(32)}`;
const DEAD_KEY = `dd_revoked_${'c'.repeat(32)}`;

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function fakeApi() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const key = req.headers['x-api-key'] || null;
      calls.push({ method: req.method, pathname: url.pathname, key, body });
      res.setHeader('content-type', 'application/json');
      if (key && key !== GOOD_KEY) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'unauthorized', message: 'API Key has expired.' }));
        return;
      }
      if (url.pathname === '/api/v1/context/extraction') {
        res.end(JSON.stringify({ ok: true, project_id: 'project_env', delta: {} }));
        return;
      }
      res.end(JSON.stringify({ ok: true, results: [], projects: [] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      calls,
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(100);
  }
  return predicate();
}

/** Boot the server the way a host does: env block applied, stdio open. */
function bootServer(t, { home, cwd, apiUrl, apiKey }) {
  const child = spawn(process.execPath, [DIST], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      DEERDAWN_API_URL: apiUrl,
      DEERDAWN_API_KEY: apiKey,
      CLAUDE_PROJECT_DIR: cwd,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  t.after(() => child.kill('SIGKILL'));
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'env-key-hooks', version: '1' } },
  })}\n`);
  return { child, stderr: () => stderr };
}

function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function runStopHook(api, { home, cwd, extraEnv = {} }) {
  const sessionId = 'bbbbbbbb-1111-2222-3333-444444444444';
  const transcript = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const lines = [
    'We decided to move the ingest worker onto a queue so retries stop blocking uploads.',
    'Agreed. I updated the worker to consume from the queue and added a dead-letter topic for poison messages.',
    'Next we need to backfill the three days of uploads that failed while the old worker was down.',
    'I will write the backfill script against the dead-letter topic tomorrow morning.',
  ].map((text, i) => JSON.stringify({ type: i % 2 === 0 ? 'user' : 'assistant', cwd, message: { content: [{ type: 'text', text }] } }));
  fs.writeFileSync(transcript, `${lines.join('\n')}\n`);

  const before = api.calls.length;
  const hook = spawn(process.execPath, [DIST, 'flush-session'], {
    cwd,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, DEERDAWN_API_URL: api.url, CLAUDE_PROJECT_DIR: cwd, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let hookErr = '';
  hook.stderr.on('data', (c) => { hookErr += c; });
  hook.stdin.end(JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId, transcript_path: transcript, cwd }));
  await new Promise((resolve) => hook.on('exit', resolve));
  const flushed = api.calls.slice(before).filter((c) => c.pathname === '/api/v1/context/extraction');
  return { flushed, hookErr };
}

test('an env-only key reaches the Stop hook, which can then flush', async (t) => {
  const api = await fakeApi();
  t.after(() => api.close());
  const home = tempDir('deerdawn-envkey-home-');
  const cwd = tempDir('deerdawn-envkey-repo-');
  fs.mkdirSync(path.join(cwd, '.git'));
  const credentials = path.join(home, '.deerdawn', 'credentials.json');

  const server = bootServer(t, { home, cwd, apiUrl: api.url, apiKey: GOOD_KEY });
  const landed = await waitFor(() => fs.existsSync(credentials));
  assert.ok(landed, `the env key never reached credentials.json. stderr:\n${server.stderr()}`);
  assert.equal(JSON.parse(fs.readFileSync(credentials, 'utf8')).api_key, GOOD_KEY);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(credentials).mode & 0o777, 0o600, 'credentials.json must be private');
  }
  // Never into the repo.
  for (const file of filesUnder(cwd)) {
    assert.ok(!fs.readFileSync(file, 'utf8').includes(GOOD_KEY), `the key was written into the project: ${file}`);
  }
  server.child.kill('SIGKILL');

  // Now the Stop hook, exactly as the host spawns it: NO DEERDAWN_API_KEY (the
  // env block is the server's alone), the payload on stdin.
  const { flushed, hookErr } = await runStopHook(api, { home, cwd });
  assert.ok(flushed.length > 0, `the Stop hook sent nothing. hook stderr:\n${hookErr}`);
  assert.equal(flushed[0].key, GOOD_KEY);
});

test('a key exported in the shell reaches the Stop hook with nothing saved', async (t) => {
  const api = await fakeApi();
  t.after(() => api.close());
  const home = tempDir('deerdawn-envkey-shell-home-');
  const cwd = tempDir('deerdawn-envkey-shell-repo-');
  const { flushed, hookErr } = await runStopHook(api, { home, cwd, extraEnv: { DEERDAWN_API_KEY: GOOD_KEY } });
  assert.ok(flushed.length > 0, `the Stop hook ignored DEERDAWN_API_KEY. hook stderr:\n${hookErr}`);
  assert.equal(flushed[0].key, GOOD_KEY);
  assert.ok(!fs.existsSync(path.join(home, '.deerdawn', 'credentials.json')));
});

test('a key the API refuses is not written anywhere', async (t) => {
  const api = await fakeApi();
  t.after(() => api.close());
  const home = tempDir('deerdawn-envkey-dead-home-');
  const cwd = tempDir('deerdawn-envkey-dead-repo-');
  bootServer(t, { home, cwd, apiUrl: api.url, apiKey: DEAD_KEY });
  // Give the background check time to answer, then some.
  await waitFor(() => api.calls.some((c) => c.pathname === '/api/v1/context/search'), 5000);
  await sleep(500);
  assert.ok(!fs.existsSync(path.join(home, '.deerdawn', 'credentials.json')), 'a refused key must not become the saved sign-in');
});

test('a saved sign-in that already exists is never replaced', async (t) => {
  const api = await fakeApi();
  t.after(() => api.close());
  const home = tempDir('deerdawn-envkey-saved-home-');
  const cwd = tempDir('deerdawn-envkey-saved-repo-');
  const credentials = path.join(home, '.deerdawn', 'credentials.json');
  fs.mkdirSync(path.dirname(credentials), { recursive: true });
  fs.writeFileSync(credentials, JSON.stringify({ api_key: 'dd_already_saved_key_000000000000' }), { mode: 0o600 });
  bootServer(t, { home, cwd, apiUrl: api.url, apiKey: GOOD_KEY });
  await sleep(1500);
  assert.equal(JSON.parse(fs.readFileSync(credentials, 'utf8')).api_key, 'dd_already_saved_key_000000000000');
});
