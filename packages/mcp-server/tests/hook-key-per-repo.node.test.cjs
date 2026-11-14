'use strict';

// Each repo's hooks authenticate with THAT repo's key.
//
// #523 made the server copy an env-only DEERDAWN_API_KEY into
// ~/.deerdawn/credentials.json at boot, when nothing was saved, so the hooks
// could authenticate at all. Every hook then used that file (after the shell).
// A person with a personal key in repo A's .mcp.json and a team key in repo B's
// got whichever booted first in the file — and every Stop in repo B flushed
// repo B's transcript into repo A's workspace, while SessionStart in repo B
// injected repo A's brief.
//
// Black-box against the BUILT hook entry points, in two throwaway repos with
// different keys, a credentials.json holding a THIRD key (the one the server
// persisted first), and a shell key that an entry's env overrides. Runs under
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
const KEY_A = `dd_repo_a_${'a'.repeat(32)}`;
const KEY_B = `dd_repo_b_${'b'.repeat(32)}`;
const KEY_LOCAL = `dd_local_scope_${'l'.repeat(28)}`;
const KEY_SAVED = `dd_saved_first_${'s'.repeat(28)}`;
const KEY_SHELL = `dd_shell_export_${'x'.repeat(27)}`;

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function fakeApi({ rejected = [] } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      calls.push({ method: req.method, pathname: url.pathname, key: req.headers['x-api-key'] || null });
      res.setHeader('content-type', 'application/json');
      if (rejected.includes(req.headers['x-api-key'])) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'invalid_api_key' }));
        return;
      }
      if (url.pathname === '/api/v1/context/active') {
        res.setHeader('x-deerdawn-location', 'header');
        res.end(JSON.stringify({ brief: 'Current task: pin the hook key.', project_id: 'project_k', project_name: 'K' }));
        return;
      }
      res.end(JSON.stringify({ ok: true, project: { project_name: 'K' } }));
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

/** A repo whose committed .mcp.json registers DeerDawn with `key` in its env block. */
function repoWithKey(key) {
  const dir = tempDir('deerdawn-hookkey-repo-');
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({
    mcpServers: {
      deerdawn: { command: 'npx', args: ['-y', '@deerdawn/mcp-server@latest'], env: { DEERDAWN_API_KEY: key } },
    },
  }, null, 2));
  return dir;
}

function homeWithSavedKey() {
  const home = tempDir('deerdawn-hookkey-home-');
  fs.mkdirSync(path.join(home, '.deerdawn'), { recursive: true });
  fs.writeFileSync(path.join(home, '.deerdawn', 'credentials.json'), JSON.stringify({ api_key: KEY_SAVED }), { mode: 0o600 });
  return home;
}

function runHook(args, { home, cwd, apiUrl, stdin = '', extraEnv = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DIST, ...args], {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        DEERDAWN_API_URL: apiUrl,
        CLAUDE_PROJECT_DIR: cwd,
        ...extraEnv,
      },
    });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => { stdout += d; });
    child.stdin.end(stdin);
    child.on('close', (status) => resolve({ status, stderr, stdout }));
  });
}

let flushes = 0;
async function flushIn(repo, home, api, extraEnv = {}) {
  // A fresh session per flush: the watermark would otherwise (correctly) send
  // an already-flushed transcript nothing the second time.
  flushes += 1;
  const transcript = path.join(home, `t-${flushes}.jsonl`);
  fs.writeFileSync(transcript, [
    { type: 'user', message: { role: 'user', content: 'Cap the widget queue retries at five and log each retry.' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Capped retries at five in the queue worker config and added a log line.' }] } },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n');
  const before = api.calls.length;
  const result = await runHook(['flush-session'], {
    home, cwd: repo, apiUrl: api.url, extraEnv,
    stdin: JSON.stringify({ session_id: `sess-${flushes}`, transcript_path: transcript, cwd: repo, hook_event_name: 'Stop' }),
  });
  assert.equal(result.status, 0, result.stderr);
  flushStderr = result.stderr;
  return api.calls.slice(before).filter((c) => c.pathname === '/api/v1/context/extraction');
}
let flushStderr = '';

test('the Stop hook in each repo flushes with that repo\'s .mcp.json key, not the first key saved', async (t) => {
  const api = await fakeApi();
  t.after(() => api.close());
  const home = homeWithSavedKey();
  const repoA = repoWithKey(KEY_A);
  const repoB = repoWithKey(KEY_B);

  const fromA = await flushIn(repoA, home, api);
  const fromB = await flushIn(repoB, home, api);
  assert.deepEqual(fromA.map((c) => c.key), [KEY_A]);
  assert.deepEqual(fromB.map((c) => c.key), [KEY_B]);
});

test('an entry\'s key outranks a key exported in the shell, as it does for the server', async (t) => {
  const api = await fakeApi();
  t.after(() => api.close());
  const home = homeWithSavedKey();
  const repoB = repoWithKey(KEY_B);

  const sent = await flushIn(repoB, home, api, { DEERDAWN_API_KEY: KEY_SHELL });
  assert.deepEqual(sent.map((c) => c.key), [KEY_B]);
});

test('a local-scope registration in ~/.claude.json outranks the repo\'s .mcp.json', async (t) => {
  const api = await fakeApi();
  t.after(() => api.close());
  const home = homeWithSavedKey();
  const repoA = repoWithKey(KEY_A);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    projects: { [repoA]: { mcpServers: { deerdawn: { command: 'npx', args: ['-y', '@deerdawn/mcp-server@latest'], env: { DEERDAWN_API_KEY: KEY_LOCAL } } } } },
  }));

  const sent = await flushIn(repoA, home, api);
  assert.deepEqual(sent.map((c) => c.key), [KEY_LOCAL]);
});

test('a repo that names no key still falls back to the shell, then the saved key', async (t) => {
  const api = await fakeApi();
  t.after(() => api.close());
  const home = homeWithSavedKey();
  const plain = tempDir('deerdawn-hookkey-plain-');
  fs.mkdirSync(path.join(plain, '.git'));

  assert.deepEqual((await flushIn(plain, home, api, { DEERDAWN_API_KEY: KEY_SHELL })).map((c) => c.key), [KEY_SHELL]);
  assert.deepEqual((await flushIn(plain, home, api)).map((c) => c.key), [KEY_SAVED]);
});

test('SessionStart in each repo loads the brief with that repo\'s key', async (t) => {
  const api = await fakeApi();
  t.after(() => api.close());
  const home = homeWithSavedKey();
  for (const [repo, key] of [[repoWithKey(KEY_A), KEY_A], [repoWithKey(KEY_B), KEY_B]]) {
    const before = api.calls.length;
    const result = await runHook(['session-context'], { home, cwd: repo, apiUrl: api.url });
    assert.equal(result.status, 0, result.stderr);
    const active = api.calls.slice(before).filter((c) => c.pathname === '/api/v1/context/active');
    assert.ok(active.length >= 1, 'SessionStart made no /active call');
    for (const call of active) assert.equal(call.key, key);
  }
});

// ─── Scan 13: a pinned key the API has revoked ───────────────────────────────
//
// A team removal revokes every key the person holds, including the one
// `claude mcp add -s user ... -e DEERDAWN_API_KEY=...` pinned in ~/.claude.json.
// The running server recovers on its first 401 by adopting credentials.json.
// With #529 the hooks ranked that pinned key above credentials.json and had no
// such step, so every Stop flush and SessionStart brief failed silently while
// the session worked.

const KEY_DEAD = `dd_dead_pinned_${'d'.repeat(28)}`;
const KEY_FRESH = `dd_fresh_signin_${'f'.repeat(27)}`;

function homeWithDeadPinnedKey() {
  const home = tempDir('deerdawn-hookkey-dead-');
  fs.mkdirSync(path.join(home, '.deerdawn'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { deerdawn: { command: 'npx', args: ['-y', '@deerdawn/mcp-server@latest'], env: { DEERDAWN_API_KEY: KEY_DEAD } } },
  }));
  fs.writeFileSync(path.join(home, '.deerdawn', 'credentials.json'), JSON.stringify({ api_key: KEY_FRESH }), { mode: 0o600 });
  return home;
}

test('a dead key pinned in ~/.claude.json: the Stop flush moves to credentials.json, and the next one goes straight there', async (t) => {
  const api = await fakeApi({ rejected: [KEY_DEAD] });
  t.after(() => api.close());
  const home = homeWithDeadPinnedKey();
  const repo = tempDir('deerdawn-hookkey-deadrepo-');
  fs.mkdirSync(path.join(repo, '.git'));

  const first = await flushIn(repo, home, api);
  assert.deepEqual(first.map((c) => c.key), [KEY_DEAD, KEY_FRESH], 'one retry with the saved key, no loop');
  assert.match(flushStderr, /Session briefed/);
  // Never a key on stderr, dead or alive.
  assert.ok(!flushStderr.includes(KEY_DEAD) && !flushStderr.includes(KEY_FRESH), flushStderr);

  // Recorded as a hash only, so the next hook skips the dead key outright.
  const record = fs.readFileSync(path.join(home, '.deerdawn', 'rejected-pinned-keys.json'), 'utf8');
  assert.ok(!record.includes(KEY_DEAD), 'the rejected-key record holds the key itself');
  const second = await flushIn(repo, home, api);
  assert.deepEqual(second.map((c) => c.key), [KEY_FRESH]);
});

test('a dead key pinned in ~/.claude.json: SessionStart loads the brief with credentials.json', async (t) => {
  const api = await fakeApi({ rejected: [KEY_DEAD] });
  t.after(() => api.close());
  const home = homeWithDeadPinnedKey();
  const repo = tempDir('deerdawn-hookkey-deadrepo-');
  fs.mkdirSync(path.join(repo, '.git'));

  const result = await runHook(['session-context'], { home, cwd: repo, apiUrl: api.url });
  assert.equal(result.status, 0, result.stderr);
  const active = api.calls.filter((c) => c.pathname === '/api/v1/context/active');
  assert.equal(active[0].key, KEY_DEAD);
  assert.ok(active.slice(1).length >= 1 && active.slice(1).every((c) => c.key === KEY_FRESH), JSON.stringify(active.map((c) => c.key === KEY_FRESH)));
  assert.match(result.stdout, /Project context/, 'SessionStart did not inject the brief');
  assert.ok(!result.stdout.includes(KEY_DEAD) && !result.stdout.includes(KEY_FRESH));
});

test('a dead repo key never falls back to ANOTHER registration\'s key, and a dead fallback is not retried again', async (t) => {
  // Repo A's .mcp.json key is dead; the user scope holds a different, live
  // key (another workspace's). Falling back to it would file repo A's
  // transcript in that workspace — the exact mix-up #529 fixed. Only the
  // shell and credentials.json are fallbacks, and here both are dead too.
  const api = await fakeApi({ rejected: [KEY_A, KEY_SHELL, KEY_SAVED] });
  t.after(() => api.close());
  const home = homeWithSavedKey();
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { deerdawn: { command: 'npx', args: ['-y', '@deerdawn/mcp-server@latest'], env: { DEERDAWN_API_KEY: KEY_LOCAL } } },
  }));
  const repoA = repoWithKey(KEY_A);

  const sent = await flushIn(repoA, home, api, { DEERDAWN_API_KEY: KEY_SHELL });
  assert.deepEqual(sent.map((c) => c.key), [KEY_A, KEY_SHELL, KEY_SAVED]);
  assert.ok(!sent.some((c) => c.key === KEY_LOCAL), 'fell back to another registration\'s key');
  assert.ok(!fs.existsSync(path.join(home, '.deerdawn', 'rejected-pinned-keys.json')), 'recorded a rejection with no working key to show for it');
});
