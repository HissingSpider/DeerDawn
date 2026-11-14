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

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createFakeApi() {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    calls.push({ method: req.method, pathname: url.pathname });

    if (req.method === 'GET' && url.pathname === '/api/v1/context/active') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        brief: 'Current task: packaged start_session smoke test.',
        project_name: 'MCP Runtime Smoke',
        project_id: 'project_runtime_smoke',
        last_updated: new Date().toISOString(),
      }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/context/map') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        map: [
          '[DeerDawn - 2 projects]',
          'MCP Runtime Smoke (project_runtime_smoke)',
          'Other Project (project_other)',
        ].join('\n'),
      }));
      return;
    }

    if (req.method === 'POST' && (
      url.pathname === '/api/v1/product-events' ||
      url.pathname === '/api/v1/context/events'
    )) {
      req.resume();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found', path: url.pathname }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        calls,
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function waitForJsonRpc(stdout, id, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for JSON-RPC response ${id}. Output:\n${buffer}`));
    }, timeoutMs);

    stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (const line of buffer.split(/\r?\n/)) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === id) {
            clearTimeout(timeout);
            resolve(parsed);
            return;
          }
        } catch {
          // Keep collecting output until a complete JSON line arrives.
        }
      }
    });
  });
}

test('compiled stdio server completes start_session through JSON-RPC', async (t) => {
  const api = await createFakeApi();
  t.after(() => api.close());

  const home = createTempDir('deerdawn-mcp-home-');
  const projectDir = createTempDir('deerdawn-mcp-project-');
  fs.mkdirSync(path.join(home, '.deerdawn'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.deerdawn', 'credentials.json'),
    JSON.stringify({ api_key: 'dev-key' })
  );

  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      HOME: home,
      DEERDAWN_HOME: path.join(home, '.deerdawn'),
      DEERDAWN_API_URL: api.url,
      DEERDAWN_API_KEY: 'dev-key',
      CLAUDE_PROJECT_DIR: projectDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  t.after(() => {
    child.kill('SIGTERM');
  });

  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'packaged-smoke', version: '1' },
    },
  })}\n`);

  const initialize = await waitForJsonRpc(child.stdout, 1);
  assert.ifError(initialize.error);

  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {},
  })}\n`);

  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'start_session',
      arguments: { verbosity: 'light' },
    },
  })}\n`);

  const startSession = await waitForJsonRpc(child.stdout, 2);
  assert.ifError(startSession.error);

  const text = startSession.result.content[0].text;
  assert.match(text, /Resuming MCP Runtime Smoke/);
  assert.match(text, /packaged start_session smoke test/);
  assert.match(text, /Other Project/);
  assert.match(stderr, /Tool call successful: start_session/);
  assert(api.calls.some((call) => call.pathname === '/api/v1/context/active'));
  assert(api.calls.some((call) => call.pathname === '/api/v1/context/map'));
});
