'use strict';

// Black-box, against the BUILT server over real JSON-RPC on stdio — because the
// defect these cover is not visible in any one function. Every part reported
// success: the credential reached disk, stderr said the session was reconnected,
// get_auth_status answered {"authenticated":true,"source":"saved"}, and every
// real tool call still said "DeerDawn: not signed in" until the host app was
// restarted. Only the whole process, driven the way a host drives it, shows that.
//
// Runs under `npm run test:node`, which follows the build.

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

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * A fake DeerDawn API.
 *
 * `startFails(n)` decides whether the nth /start is a 503 — the shape of a
 * deploy, a rate limit, or a boot with no network yet. Every authenticated call
 * records the key it arrived with, which is how a test can tell "the tool
 * answered" from "the tool answered using the key the user just signed in with".
 */
function fakeApi({ startFails = () => false, apiKey = 'dd_freshly_signed_in', validKeys = null, tokenStatus = 200 } = {}) {
  const calls = [];
  let startCount = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    req.resume();
    const presented = req.headers['x-api-key'] || null;
    calls.push({ method: req.method, pathname: url.pathname, apiKey: presented });
    res.setHeader('content-type', 'application/json');

    // `validKeys` is a live Set the test mutates: expiry is a thing that happens
    // to a running install, not a fixture decided up front. Null means every key
    // is accepted, which is what the tests below this one want.
    if (validKeys && !url.pathname.startsWith('/api/v1/auth/mcp/') && !validKeys.has(presented)) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'unauthorized', message: 'API Key has expired.' }));
      return;
    }

    if (url.pathname === '/api/v1/auth/mcp/start') {
      startCount += 1;
      if (startFails(startCount)) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: 'service_unavailable' }));
        return;
      }
      res.end(JSON.stringify({
        device_code: 'dc_recovery',
        user_code: 'RECOVER1',
        verification_url: 'https://app.deerdawn.test/mcp-auth?code=RECOVER1',
        expires_in: 1800,
        interval: 1,
      }));
      return;
    }
    if (url.pathname === '/api/v1/auth/mcp/token') {
      // 404 is what the API answers for a code that expired or has already been
      // collected — a refusal no amount of polling survives.
      if (tokenStatus !== 200) {
        res.statusCode = tokenStatus;
        res.end(JSON.stringify({ error: 'expired_or_invalid' }));
        return;
      }
      // The user signs in promptly, as they do when they are sitting there.
      res.end(JSON.stringify({ status: 'authorized', api_key: apiKey }));
      return;
    }
    if (url.pathname === '/api/v1/context/active') {
      res.end(JSON.stringify({
        brief: 'Current task: prove the session recovered.',
        project_name: 'Boot Recovery',
        project_id: 'project_boot_recovery',
        last_updated: new Date().toISOString(),
      }));
      return;
    }
    if (url.pathname === '/api/v1/context/map') {
      res.end(JSON.stringify({ map: '[DeerDawn - 1 project]\nBoot Recovery (project_boot_recovery)', project_count: 1 }));
      return;
    }
    res.end(JSON.stringify({ ok: true, results: [], projects: [] }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        calls,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/** A JSON-RPC client over the child's stdio, so tests read like a host. */
function connect(child) {
  const waiters = new Map();
  let buffer = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim().startsWith('{')) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const waiter = message.id !== undefined && waiters.get(message.id);
      if (waiter) { waiters.delete(message.id); waiter(message); }
    }
  });

  let nextId = 1;
  const rpc = (method, params, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`timed out waiting for ${method}. stderr:\n${stderr}`));
    }, timeoutMs);
    waiters.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  return {
    rpc,
    notify: (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`),
    stderr: () => stderr,
  };
}

function toolText(response) {
  if (response.error) return JSON.stringify(response.error);
  return response.result?.content?.[0]?.text ?? JSON.stringify(response.result);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bootServer(t, api, home, projectDir) {
  const child = spawn(process.execPath, [DIST], {
    cwd: projectDir,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      DEERDAWN_API_URL: api.url,
      CLAUDE_PROJECT_DIR: projectDir,
      // Keep the fixture's hook writes off the machine's real config.
      DEERDAWN_CAPTURE: 'off',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  const host = connect(child);
  const initialize = await host.rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'boot-recovery', version: '1' },
  });
  assert.ifError(initialize.error);
  host.notify('notifications/initialized', {});
  return host;
}

test('a boot whose device flow failed can still be signed in, without restarting the host', async (t) => {
  // The first /start is a 503, exactly as during a deploy. Everything after it
  // is healthy — so the ONLY thing standing between the user and a working
  // session is whether this process can adopt a key it did not fetch itself.
  const api = await fakeApi({ startFails: (n) => n === 1 });
  t.after(() => api.close());
  const home = tempDir('deerdawn-boot-home-');
  const projectDir = tempDir('deerdawn-boot-cwd-');

  const host = await bootServer(t, api, home, projectDir);
  await sleep(600); // let the boot flow fail

  // Before sign-in: refused, which is correct.
  const beforeSignIn = await host.rpc('tools/call', { name: 'start_session', arguments: {} });
  assert.match(toolText(beforeSignIn), /sign in|not signed in/i, 'expected a sign-in prompt before sign-in');

  // The user asks for a link and uses it. The fake API authorizes immediately.
  const auth = await host.rpc('tools/call', { name: 'get_auth_status', arguments: {} });
  const authJson = JSON.parse(toolText(auth));
  assert.ok(authJson.url, `get_auth_status should hand over a sign-in link, got ${toolText(auth)}`);

  // The detached poll collects the key (interval 1s) and writes credentials.json.
  await sleep(3000);
  const credentials = path.join(home, '.deerdawn', 'credentials.json');
  assert.ok(fs.existsSync(credentials), 'sign-in should have written credentials.json');
  assert.equal(JSON.parse(fs.readFileSync(credentials, 'utf8')).api_key, 'dd_freshly_signed_in');

  // THE POINT: a real tool call now works, in this process, and reaches the API
  // carrying the key the user just signed in with.
  const afterSignIn = await host.rpc('tools/call', { name: 'start_session', arguments: {} });
  const text = toolText(afterSignIn);
  assert.ok(!afterSignIn.result?.isError, `start_session should succeed after sign-in, got: ${text}`);
  assert.match(text, /Boot Recovery/, `expected the project brief, got: ${text}`);
  assert.ok(
    api.calls.some((c) => c.pathname === '/api/v1/context/active' && c.apiKey === 'dd_freshly_signed_in'),
    'the API should have been called with the newly signed-in key'
  );

  // And the advertised surface agrees: setup is over.
  const tools = await host.rpc('tools/list', {});
  const names = tools.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('start_session'));
  assert.ok(!names.includes('get_auth_status'), `setup tier should be gone, got: ${names.join(',')}`);
});

test('a second server process picks up a sign-in another process completed', async (t) => {
  // /start never recovers here, so this process has no device flow of its own
  // and no renewal event will ever be announced to it. credentials.json is the
  // only channel between two servers on one machine — the case that made the
  // first tool call after "signing in elsewhere" fail for no visible reason.
  const api = await fakeApi({ startFails: () => true });
  t.after(() => api.close());
  const home = tempDir('deerdawn-peer-home-');
  const projectDir = tempDir('deerdawn-peer-cwd-');

  const host = await bootServer(t, api, home, projectDir);
  await sleep(600);

  const beforeSignIn = await host.rpc('tools/call', { name: 'start_session', arguments: {} });
  assert.match(toolText(beforeSignIn), /sign in|not signed in/i);

  // Somebody else signs in: another server process, or `deerdawn-mcp setup`.
  fs.mkdirSync(path.join(home, '.deerdawn'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.deerdawn', 'credentials.json'),
    JSON.stringify({ api_key: 'dd_written_by_a_peer' }),
    { mode: 0o600 }
  );

  const afterSignIn = await host.rpc('tools/call', { name: 'start_session', arguments: {} });
  const text = toolText(afterSignIn);
  assert.ok(!afterSignIn.result?.isError, `start_session should succeed once a key is on disk, got: ${text}`);
  assert.ok(
    api.calls.some((c) => c.pathname === '/api/v1/context/active' && c.apiKey === 'dd_written_by_a_peer'),
    'the API should have been called with the key the other process saved'
  );
});

test('a running process adopts the key another process signed in with, instead of looping on "reconnected"', async (t) => {
  // The 90-day expiry, on a machine running two editor windows. Both servers
  // share one HOME. The saved key expires; the OTHER process signs in again and
  // writes credentials.json. This process still holds the dead key in the axios
  // defaults it built at boot, and nothing announces the renewal to it.
  //
  // What that used to produce: the 401 handler asked get_auth_status, which
  // validates the key ON DISK, got {"authenticated":true,"source":"saved"}, and
  // answered "DeerDawn reconnected. Retry your last message." — forever, with
  // the expired key on the wire every single time. Permanent until the host was
  // restarted, and it recurs at every renewal.
  const validKeys = new Set(['dd_expired_key_0000']);
  const api = await fakeApi({ startFails: () => true, validKeys });
  t.after(() => api.close());
  const home = tempDir('deerdawn-renewal-home-');
  const projectDir = tempDir('deerdawn-renewal-cwd-');
  const credentials = path.join(home, '.deerdawn', 'credentials.json');
  fs.mkdirSync(path.dirname(credentials), { recursive: true });
  fs.writeFileSync(credentials, JSON.stringify({ api_key: 'dd_expired_key_0000' }), { mode: 0o600 });

  const host = await bootServer(t, api, home, projectDir);
  await sleep(600);

  // Healthy first, so the client is genuinely built and holding the old key.
  const healthy = await host.rpc('tools/call', { name: 'start_session', arguments: {} });
  assert.ok(!healthy.result?.isError, `start_session should work before expiry, got: ${toolText(healthy)}`);

  // The key expires. The peer process signs in and writes the new one.
  validKeys.delete('dd_expired_key_0000');
  validKeys.add('dd_renewed_key_0002');
  fs.writeFileSync(credentials, JSON.stringify({ api_key: 'dd_renewed_key_0002' }), { mode: 0o600 });

  // THE POINT: the very next tool call works, because the 401 path re-reads the
  // file that is the only channel between the two processes and retries once.
  const afterRenewal = await host.rpc('tools/call', { name: 'start_session', arguments: {} });
  const text = toolText(afterRenewal);
  assert.ok(
    !afterRenewal.result?.isError,
    `start_session should recover using the renewed key on disk, got: ${text}`
  );
  assert.ok(!/reconnected\.?\s*$|Retry your last message/i.test(text), `expected the brief, not a retry instruction: ${text}`);
  assert.match(text, /Boot Recovery/, `expected the project brief, got: ${text}`);

  // Judged on the WIRE, not on the reply: the whole defect was a truthful-looking
  // sentence over a request that still carried the dead credential.
  assert.ok(
    api.calls.some((c) => c.pathname === '/api/v1/context/active' && c.apiKey === 'dd_renewed_key_0002'),
    `the renewed key should have reached the API; keys seen: ${api.calls.filter((c) => c.pathname === '/api/v1/context/active').map((c) => c.apiKey).join(',')}`
  );

  // And the tool that answers "are we connected" now answers about THIS process,
  // not about the file. "Authenticated" was never the same fact as "reconnected".
  const auth = await host.rpc('tools/call', { name: 'get_auth_status', arguments: {} });
  const status = JSON.parse(toolText(auth));
  assert.equal(status.authenticated, true, toolText(auth));
  assert.equal(status.session_reconnected, true, toolText(auth));
});

test('setup exits non-zero when sign-in could not be completed', async (t) => {
  // `npx ... setup && next-step` read exit 0 as success and carried on against
  // an install that cannot authenticate.
  const api = await fakeApi({ startFails: () => true });
  t.after(() => api.close());
  const home = tempDir('deerdawn-setup-home-');
  const projectDir = tempDir('deerdawn-setup-cwd-');

  const child = spawn(process.execPath, [DIST, 'setup'], {
    cwd: projectDir,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      DEERDAWN_API_URL: api.url,
      DEERDAWN_NO_BROWSER: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  child.stdout.on('data', () => { /* drained */ });

  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.notEqual(code, 0, 'setup must not report success when it could not sign in');
  // The reason travels with the exit code — an exit code alone is not a report.
  assert.match(stderr, /Sign-in could not be completed/i, `expected the reason on stderr, got:\n${stderr}`);
});

test('a transparent recovery still says the pinned env key is the reason', async (t) => {
  // DEERDAWN_API_KEY in the MCP server config outranks credentials.json at every
  // boot, so a session recovered by swapping to the saved sign-in is recovered
  // only until the next restart. get_auth_status has always said so — and a
  // retry that succeeds without ever reaching get_auth_status would quietly
  // stop saying it, which is how the fix for one silent failure becomes another.
  const validKeys = new Set(['dd_saved_good_0003']);
  const api = await fakeApi({ startFails: () => true, validKeys });
  t.after(() => api.close());
  const home = tempDir('deerdawn-envkey-home-');
  const projectDir = tempDir('deerdawn-envkey-cwd-');
  fs.mkdirSync(path.join(home, '.deerdawn'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.deerdawn', 'credentials.json'),
    JSON.stringify({ api_key: 'dd_saved_good_0003' }),
    { mode: 0o600 }
  );

  const child = spawn(process.execPath, [DIST], {
    cwd: projectDir,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      DEERDAWN_API_URL: api.url,
      CLAUDE_PROJECT_DIR: projectDir,
      DEERDAWN_CAPTURE: 'off',
      DEERDAWN_API_KEY: 'dd_env_expired_0009',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  const host = connect(child);
  const initialize = await host.rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'boot-recovery', version: '1' },
  });
  assert.ifError(initialize.error);
  host.notify('notifications/initialized', {});
  await sleep(400);

  const started = await host.rpc('tools/call', { name: 'start_session', arguments: {} });
  const blocks = started.result?.content ?? [];
  assert.ok(!started.result?.isError, `start_session should recover on the saved key: ${toolText(started)}`);
  assert.match(String(blocks[0]?.text ?? ''), /Scan|Boot Recovery/, toolText(started));
  // In its own block, so anything parsing content[0] as JSON is untouched.
  const advice = blocks.map((b) => String(b?.text ?? '')).join('\n');
  assert.match(advice, /DEERDAWN_API_KEY/, `the pinned env key must still be named:\n${advice}`);
  assert.match(advice, /every restart/i, advice);
});

/** Run `setup` to completion and hand back everything it said. */
function runSetupCli(t, api, home, projectDir) {
  const child = spawn(process.execPath, [DIST, 'setup'], {
    cwd: projectDir,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      DEERDAWN_API_URL: api.url,
      DEERDAWN_NO_BROWSER: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, stdout, stderr })));
}

test('setup does not say "Done" over a credential it could not save', async (t) => {
  // credentials.json is a symlink, so safe-fs refuses the write (utils/safe-fs.ts).
  // The sign-in itself succeeds, and #500 taught saveApiKey to report that the
  // store refused — but only the env-key branch of setup read the answer. On the
  // DEVICE-FLOW path, the one a new user takes, setup printed a summary of ticks
  // and "Done. Restart Claude Code to activate DeerDawn", and exited 0, over an
  // install whose next start has nothing to find.
  const api = await fakeApi({ apiKey: 'dd_key_with_nowhere_to_go' });
  t.after(() => api.close());
  const home = tempDir('deerdawn-unsaved-home-');
  const projectDir = tempDir('deerdawn-unsaved-cwd-');
  fs.mkdirSync(path.join(home, '.deerdawn'), { recursive: true });
  const elsewhere = path.join(home, 'elsewhere.json');
  fs.writeFileSync(elsewhere, '{}');
  fs.symlinkSync(elsewhere, path.join(home, '.deerdawn', 'credentials.json'));

  const result = await runSetupCli(t, api, home, projectDir);

  assert.notEqual(result.code, 0, `setup must not exit 0 with no stored credential:\n${result.stdout}`);
  assert.doesNotMatch(result.stdout, /\bDone\./, `"Done." is a claim about the next run:\n${result.stdout}`);
  assert.match(result.stdout, /Could not write .*credentials\.json/i, `the summary must carry the failure:\n${result.stdout}`);
  // The refusal was real: nothing went through the link.
  assert.equal(fs.readFileSync(elsewhere, 'utf8'), '{}');
});

test('a terminal sign-in refusal prints one next step, not the dead link', async (t) => {
  // /token answers 404: the code expired, or somebody already collected it. The
  // message says that link cannot be retried — and the block underneath then
  // printed "Sign in manually in any browser: <that same dead link>" and "Then
  // re-run setup to finish". Contradictory, and the second half is worse than
  // contradictory: authorizing a link and re-running setup mints a SECOND code
  // and strands the key the first one just produced.
  const api = await fakeApi({ tokenStatus: 404 });
  t.after(() => api.close());
  const home = tempDir('deerdawn-terminal-home-');
  const projectDir = tempDir('deerdawn-terminal-cwd-');

  const result = await runSetupCli(t, api, home, projectDir);

  assert.notEqual(result.code, 0, 'a refused sign-in is not a successful setup');
  assert.match(result.stderr, /expired or has already been used/i, result.stderr);
  assert.doesNotMatch(result.stderr, /Sign in manually in any browser/i, `the dead link must not be offered:\n${result.stderr}`);
  assert.doesNotMatch(result.stderr, /Then re-run setup to finish/i, `stranding advice must not follow a terminal refusal:\n${result.stderr}`);
  // One truthful step remains, and it is the only one that can work.
  assert.match(result.stderr, /Re-run setup for a fresh authorization link/i, result.stderr);
});
