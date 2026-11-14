'use strict';

// Every advertised tool, called the way an SDK-based host calls it.
//
// listTools() gives every tool an outputSchema, and the MCP spec says a tool
// that declares one must return `structuredContent`. The official TypeScript
// SDK Client enforces that: callTool() THROWS
//   "Tool X has an output schema but did not return structured content"
// on any non-error result without it. The handlers returned prose in content[]
// only, so from any SDK-based client every successful call — start_session
// included — surfaced as an exception, after the work (writes included) had
// already been done.
//
// Nothing else in this package could see it: the JSON-RPC tests read
// `result.content[0].text` and never validate a result against the schema the
// same server advertised. So this drives the BUILT server through the real
// SDK Client, not raw JSON-RPC. Runs under `npm run test:node`, after the build.

const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
// No home-like variable from the developer's shell reaches this file or the
// servers it starts: see ../../shared-context/tests/contain-home.cjs.
require('../../shared-context/tests/contain-home.cjs').containTestProcess(require('node:test').after);

const PKG = path.resolve(__dirname, '..');
const DIST = path.join(PKG, 'dist', 'index.js');
const { Client } = require(require.resolve('@modelcontextprotocol/sdk/client/index.js', { paths: [PKG] }));
const { StdioClientTransport } = require(require.resolve('@modelcontextprotocol/sdk/client/stdio.js', { paths: [PKG] }));

/** A permissive fake API: every route answers 200 with an empty-ish payload. */
function fakeApi() {
  const server = http.createServer((req, res) => {
    req.resume();
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/v1/context/active') {
      res.end(JSON.stringify({
        brief: 'Current task: pin structuredContent on every tool.',
        project_name: 'SDK Pin',
        project_id: 'project_sdk_pin',
        last_updated: new Date().toISOString(),
      }));
      return;
    }
    if (url.pathname === '/api/v1/context/map') {
      res.end(JSON.stringify({ map: '[DeerDawn - 1 project]\nSDK Pin (project_sdk_pin)', project_count: 1 }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/context/projects') {
      res.end(JSON.stringify({ project: { project_id: 'project_sdk_new', project_name: 'sdk-pin', parent_project_id: null } }));
      return;
    }
    if (url.pathname === '/api/v1/context/subagent-brief') {
      res.end(JSON.stringify({ text: '[DeerDawn Subagent Brief v1]\nProject: SDK Pin', tokens: 12 }));
      return;
    }
    res.end(JSON.stringify({ ok: true, results: [], projects: [], todos: [], cards: [], skills: [] }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

// Representative arguments per tool. A tool advertised later that is missing
// here is still called (with {}), so a new tool cannot slip past the pin.
const CALLS = {
  start_session: [{}],
  recall: [{ action: 'map' }, { action: 'projects' }, { action: 'context' }, { action: 'paths', query: 'src' }, { action: 'entities' }],
  manage_projects: [{ action: 'create', project_name: 'sdk-pin' }],
  manage_memory: [{ action: 'record_finding', summary: 'structuredContent on every tool', title: 'pin' }],
  manage_tasks: [{ action: 'list' }],
  build_subagent_brief: [{ task: 'Pin structuredContent' }],
  browse_skills: [{}],
  get_auth_status: [{}],
};

test('every advertised tool returns structuredContent the SDK Client accepts', async (t) => {
  const api = await fakeApi();
  t.after(() => api.close());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-sdk-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-sdk-cwd-'));

  const client = new Client({ name: 'sdk-structured-pin', version: '1' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [DIST],
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      DEERDAWN_API_URL: api.url,
      DEERDAWN_API_KEY: `dd_sdk_pin_${'a'.repeat(32)}`,
      CLAUDE_PROJECT_DIR: cwd,
      DEERDAWN_CAPTURE: 'off',
    },
    stderr: 'pipe',
  }));
  t.after(() => client.close());

  const { tools } = await client.listTools();
  assert.ok(tools.length > 0, 'no tools advertised');
  const names = tools.map((tool) => tool.name);
  // start_session first: the server refuses everything else until it has run.
  const order = ['start_session', ...names.filter((name) => name !== 'start_session')];

  const succeeded = [];
  for (const name of order) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool.outputSchema, `${name} advertises no outputSchema — the precondition this pins is gone`);
    for (const args of CALLS[name] || [{}]) {
      let result;
      try {
        result = await client.callTool({ name, arguments: args });
      } catch (err) {
        assert.fail(`${name}(${JSON.stringify(args)}) threw through the SDK Client: ${err.message}`);
      }
      if (result.isError) continue;
      assert.equal(typeof result.structuredContent, 'object', `${name}: no structuredContent`);
      assert.notEqual(result.structuredContent, null, `${name}: null structuredContent`);
      const texts = (result.content || []).filter((b) => b.type === 'text').map((b) => b.text);
      if ('text' in result.structuredContent && texts.length) {
        assert.equal(result.structuredContent.text, texts.join('\n\n'), `${name}: structured text differs from the prose`);
      }
      succeeded.push(name);
    }
  }

  // Non-vacuous: an all-isError run would pass the loop above without
  // checking a single structuredContent.
  for (const required of ['start_session', 'recall', 'manage_tasks', 'build_subagent_brief']) {
    if (names.includes(required)) assert.ok(succeeded.includes(required), `${required} never returned a non-error result`);
  }
});
