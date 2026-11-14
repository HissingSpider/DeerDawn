'use strict';

/**
 * The SessionStart hook against the compiled binary: what it says about WHICH
 * project it loaded, and what it does when the API blinks.
 *
 *   - a 503 is retried once, so one blip no longer costs the session its brief;
 *   - a confident match hands the agent its project id;
 *   - a guess is called a guess, with the alternatives, and is not "auto-loaded";
 *   - during an outage, the last confident project for this directory is named.
 */

const test = require('node:test');
require('../../shared-context/tests/contain-home.cjs').containTestProcess(require('node:test').after);
const assert = require('node:assert');
const http = require('http');
const { execFile } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const DIST = path.join(__dirname, '..', 'dist', 'index.js');

// Serves `responses` in order (the last one repeats); counts requests to /active.
function startApi(responses) {
  let hits = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const [status, body] = responses[Math.min(hits, responses.length - 1)];
      hits += 1;
      // Acknowledges the location headers, as the real API does, so the hook
      // makes no legacy-query repeat and every hit here is one attempt.
      res.writeHead(status, { 'content-type': 'application/json', 'x-deerdawn-location': 'header' });
      res.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, hits: () => hits }));
  });
}

function runHook(apiUrl, home, cwd) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, DEERDAWN_API_KEY: 'dd_test_key', DEERDAWN_API_URL: apiUrl, HOME: home, CLAUDE_PROJECT_DIR: cwd };
    delete env.DEERDAWN_DIR;
    delete env.DEERDAWN_HOME_DIR;
    execFile(process.execPath, [DIST, 'session-context'], { cwd, env, timeout: 20000 },
      (err, stdout) => (err && !stdout ? reject(err) : resolve(JSON.parse(stdout))));
  });
}

function tmpdirs() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-routing-home-'));
  const cwd = path.join(home, 'repo');
  fs.mkdirSync(cwd);
  return { home, cwd, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

const CONFIDENT = {
  brief: 'Current task: ship routing.', project_id: 'proj_a', project_name: 'Alpha',
  match_kind: 'path', match_confidence: 'high', write_target: true, last_updated: '2026-10-14T00:00:00Z',
};

test('a 503 is retried once and the brief still arrives', async () => {
  const api = await startApi([[503, { error: 'unavailable' }], [200, CONFIDENT]]);
  const dirs = tmpdirs();
  try {
    const out = await runHook(`http://127.0.0.1:${api.server.address().port}`, dirs.home, dirs.cwd);
    assert.strictEqual(api.hits(), 2, 'one retry, not zero and not more');
    assert.match(out.hookSpecificOutput.additionalContext, /ship routing/);
  } finally {
    api.server.close();
    dirs.cleanup();
  }
});

test('a confident match is auto-loaded and hands over its project id', async () => {
  const api = await startApi([[200, CONFIDENT]]);
  const dirs = tmpdirs();
  try {
    const ctx = (await runHook(`http://127.0.0.1:${api.server.address().port}`, dirs.home, dirs.cwd)).hookSpecificOutput.additionalContext;
    assert.match(ctx, /Auto-loaded; use it without re-asking/);
    assert.match(ctx, /project_id: "proj_a"/);
  } finally {
    api.server.close();
    dirs.cleanup();
  }
});

test('a guess is called a guess, with the alternatives, and is never promised', async () => {
  const api = await startApi([[200, {
    ...CONFIDENT, project_id: 'proj_b', project_name: 'Beta', match_kind: 'name', match_confidence: 'low', write_target: false,
    alternatives: [{ project_id: 'proj_c', project_name: 'Gamma' }],
  }]]);
  const dirs = tmpdirs();
  try {
    const ctx = (await runHook(`http://127.0.0.1:${api.server.address().port}`, dirs.home, dirs.cwd)).hookSpecificOutput.additionalContext;
    assert.match(ctx, /POSSIBLE project context/);
    assert.match(ctx, /"Gamma" \(proj_c\)/);
    assert.doesNotMatch(ctx, /without re-asking/);
  } finally {
    api.server.close();
    dirs.cleanup();
  }
});

test('nothing matched: the person\'s likely projects are named', async () => {
  const api = await startApi([[200, {
    brief: null, project_id: null, project_name: null, alternatives: [{ project_id: 'proj_c', project_name: 'Gamma' }],
  }]]);
  const dirs = tmpdirs();
  try {
    const ctx = (await runHook(`http://127.0.0.1:${api.server.address().port}`, dirs.home, dirs.cwd)).hookSpecificOutput.additionalContext;
    assert.match(ctx, /no saved brief matched this directory/);
    assert.match(ctx, /"Gamma" \(proj_c\)/);
  } finally {
    api.server.close();
    dirs.cleanup();
  }
});

test('during an outage, the last confident project for this directory is named', async () => {
  const dirs = tmpdirs();
  const good = await startApi([[200, CONFIDENT]]);
  try {
    await runHook(`http://127.0.0.1:${good.server.address().port}`, dirs.home, dirs.cwd);
  } finally {
    good.server.close();
  }
  const down = await startApi([[503, {}]]);
  try {
    const ctx = (await runHook(`http://127.0.0.1:${down.server.address().port}`, dirs.home, dirs.cwd)).hookSpecificOutput.additionalContext;
    assert.strictEqual(down.hits(), 2, 'retried once before giving up');
    assert.match(ctx, /degraded/);
    assert.match(ctx, /Last confirmed project for this directory: "Alpha" \(proj_a\)/);
  } finally {
    down.server.close();
    dirs.cleanup();
  }
});
