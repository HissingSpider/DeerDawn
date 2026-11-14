'use strict';

/**
 * The SessionStart hook is the ONLY deterministic path by which DeerDawn reaches
 * the human: it renders before the model responds, costs no output tokens, and
 * cannot be summarised away. Everything else about the card being visible depends
 * on this payload having the right shape, so it is worth an end-to-end assertion
 * against the compiled binary rather than a unit test of the formatter.
 */

const test = require('node:test');
// No home-like variable from the developer's shell reaches this file or the
// servers it starts: see ../../shared-context/tests/contain-home.cjs.
require('../../shared-context/tests/contain-home.cjs').containTestProcess(require('node:test').after);
const assert = require('node:assert');
const http = require('http');
const { execFile } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const DIST = path.join(__dirname, '..', 'dist', 'index.js');

function startFakeApi(payload) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function runHook(apiUrl, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [DIST, 'session-context'],
      {
        cwd,
        env: {
          ...process.env,
          DEERDAWN_API_KEY: 'dd_test_key',
          DEERDAWN_API_URL: apiUrl,
          // Isolate credential/config lookups to the temp dir so the developer's
          // real ~/.deerdawn never influences the result.
          HOME: cwd,
        },
        timeout: 15000,
      },
      (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout)),
    );
  });
}

test('SessionStart hook emits the card as systemMessage, separate from model context', async () => {
  const CARD = [
    '┌─ DEERDAWN ───────────────────────────────────────┐',
    '│ Setup & API Testing               briefed 2m ago │',
    '└──────────────────────────────────────────────────┘',
  ].join('\n');

  const server = await startFakeApi({
    brief: 'Current task: ship the brief card.',
    card: CARD,
    project_name: 'Setup & API Testing',
    last_updated: new Date().toISOString(),
  });
  const { port } = server.address();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-card-'));

  try {
    const stdout = await runHook(`http://127.0.0.1:${port}`, tmp);
    const payload = JSON.parse(stdout);

    // The human channel: rendered directly into the user's transcript.
    assert.strictEqual(payload.systemMessage, CARD, 'card must be emitted verbatim as systemMessage');

    // The model channel: unchanged, still carrying the brief.
    assert.ok(payload.hookSpecificOutput, 'model context must still be emitted');
    assert.strictEqual(payload.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(payload.hookSpecificOutput.additionalContext, /ship the brief card/);

    // The card is for the human only — duplicating it into the model's context
    // would spend tokens re-stating what the brief already says.
    assert.ok(
      !payload.hookSpecificOutput.additionalContext.includes('DEERDAWN ──'),
      'card must not be duplicated into the model context',
    );

    // Free win: the transcript list names itself after the project.
    assert.strictEqual(payload.hookSpecificOutput.sessionTitle, 'Setup & API Testing');
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('omits systemMessage entirely when the server sends no card', async () => {
  // An empty notice still renders a blank line in the transcript, and a card that
  // shows up empty teaches users to ignore the card.
  const server = await startFakeApi({
    brief: 'Current task: something.',
    card: null,
    project_name: 'No Card Project',
    last_updated: new Date().toISOString(),
  });
  const { port } = server.address();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-nocard-'));

  try {
    const payload = JSON.parse(await runHook(`http://127.0.0.1:${port}`, tmp));
    assert.ok(!('systemMessage' in payload), 'systemMessage must be absent, not empty');
    assert.ok(payload.hookSpecificOutput.additionalContext, 'brief must still reach the model');
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the /active read says tool_identified=0 unless something identifies the tool', async () => {
  const urls = [];
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      urls.push(req.url);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ brief: 'b', project_name: 'A' }));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-identified-'));
  const run = (extra) => new Promise((resolve, reject) => {
    const env = { ...process.env, DEERDAWN_API_KEY: 'dd_test_key', DEERDAWN_API_URL: `http://127.0.0.1:${port}`, HOME: tmp, ...extra };
    delete env.CLAUDE_PROJECT_DIR;
    delete env.DEERDAWN_SURFACE_ID;
    Object.assign(env, extra);
    execFile(process.execPath, [DIST, 'session-context'], { cwd: tmp, env, timeout: 15000 },
      (err, out) => (err && !out ? reject(err) : resolve(out)));
  });
  try {
    await run({});
    await run({ CLAUDE_PROJECT_DIR: tmp });
    const actives = urls.filter((u) => u.startsWith('/api/v1/context/active'));
    assert.match(actives[0], /tool_identified=0/, 'a defaulted tool is said to be one');
    assert.doesNotMatch(actives[actives.length - 1], /tool_identified/, 'Claude Code\'s hook env identifies it');
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the receipt line is what the person sees when the API sends one (Thing 4.7)', async () => {
  const RECEIPT = 'DeerDawn loaded Atlas: 2 decisions, 1 open question, last saved 3h ago in Codex. Next: wire the refund webhook';
  const server = await startFakeApi({
    brief: 'Current task: ship it.',
    card: null,
    receipt: RECEIPT,
    project_name: 'Atlas',
    last_updated: new Date().toISOString(),
  });
  const { port } = server.address();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-receipt-'));
  try {
    const payload = JSON.parse(await runHook(`http://127.0.0.1:${port}`, tmp));
    assert.strictEqual(payload.systemMessage, RECEIPT);
    assert.ok(!payload.hookSpecificOutput.additionalContext.includes(RECEIPT), 'the receipt is for the person, not the model');
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('an install an earlier version switched capture on for is told once what capture sends (Thing 4.4)', async () => {
  const server = await startFakeApi({ brief: 'b', card: null, receipt: 'DeerDawn loaded A: 0 decisions, 0 open questions.', project_name: 'A' });
  const { port } = server.address();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-capnote-'));
  fs.mkdirSync(path.join(tmp, '.deerdawn'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.deerdawn', 'setup-choices.json'), JSON.stringify({ capture: 'on', capture_source: 'existing_install' }));
  try {
    const first = JSON.parse(await runHook(`http://127.0.0.1:${port}`, tmp));
    assert.match(first.systemMessage, /^DeerDawn loaded A/);
    assert.match(first.systemMessage, /capture is on for this machine/);
    assert.match(first.systemMessage, /DEERDAWN_CAPTURE=off/);
    const second = JSON.parse(await runHook(`http://127.0.0.1:${port}`, tmp));
    assert.ok(!/capture is on/.test(second.systemMessage), 'said once');
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('not signed in: the PERSON gets a sign-in link, and the model is not told to call start_session (Thing 4.2)', async () => {
  const LINK = 'https://app.deerdawn.test/mcp-auth?code=HOOKLINK';
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url.startsWith('/api/v1/auth/mcp/start')) {
        // Short-lived, so the listener the hook leaves behind gives up quickly.
        res.end(JSON.stringify({ device_code: 'dc_hook', user_code: 'HOOKLINK', verification_url: LINK, expires_in: 2, interval: 0.5 }));
      } else {
        res.end(JSON.stringify({ status: 'pending' }));
      }
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-signin-'));
  try {
    const stdout = await new Promise((resolve, reject) => {
      const env = { ...process.env, DEERDAWN_API_URL: `http://127.0.0.1:${port}`, HOME: tmp };
      delete env.DEERDAWN_API_KEY;
      execFile(process.execPath, [DIST, 'session-context'], { cwd: tmp, env, timeout: 15000 },
        (err, out) => (err && !out ? reject(err) : resolve(out)));
    });
    const payload = JSON.parse(stdout);
    assert.ok(payload.systemMessage.includes(LINK), 'the link is shown to the person');
    assert.doesNotMatch(payload.hookSpecificOutput.additionalContext, /must call start_session/);
    assert.match(payload.hookSpecificOutput.additionalContext, /Not signed in/);
    // Saved, so a server that boots after the hook resumes this same code.
    const pending = JSON.parse(fs.readFileSync(path.join(tmp, '.deerdawn', 'pending-auth.json'), 'utf8'));
    assert.strictEqual(pending.device_code, 'dc_hook');
  } finally {
    // Let the detached listener finish its two-second window before the dir goes.
    await new Promise((r) => setTimeout(r, 2500));
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
