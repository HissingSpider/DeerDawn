/**
 * The consent screen says "You can revoke access any time from your dashboard
 * settings", and the dashboard had no way to do it.
 *
 * A person who wanted to cut ChatGPT off from their DeerDawn memory found no
 * list of connected apps and no Disconnect anywhere; the only control on a tool
 * row in Setup was "reset", which clears a flag in this browser's localStorage
 * and touches no credential at all (walker, 2026-09-27: Disconnect:0 on /setup,
 * /settings and /security, desktop and 375px).
 *
 * The API now lists a person's hosted connections and disconnects one
 * (/api/v1/connections). What Setup must do with it:
 *   - a connected hosted tool shows a Disconnect control, placed on its card
 *     only when the connection's own NAME says which tool it is; a connection
 *     that names nothing Setup has a card for is listed on its own, never
 *     dropped and never guessed onto a card;
 *   - Disconnect asks first, in the same confirm dialog key revocation uses,
 *     and says what will happen;
 *   - afterwards the row says so without a reload, and a reload agrees: a
 *     hosted tool whose credential is gone is not "connected" because its old
 *     calls are still inside the 30-day window;
 *   - failures read like key revocation's (404 means it is already gone).
 *
 * Driven against the page's own functions, transpiled from setup.tsx, plus the
 * source contracts for what cannot run outside a browser.
 *
 * Run: `node tests/setup-disconnect-contract.test.js` (wired into
 * `npm test -w dashboard`).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const pagePath = path.join(root, 'src/pages/setup.tsx');
const page = fs.readFileSync(pagePath, 'utf8');
const apiClient = fs.readFileSync(path.join(root, 'src/lib/api.ts'), 'utf8');

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    process.exitCode = 1;
  }
}

function loadPageFunctions(names) {
  const exported = names.map((name) => `${name} as __${name}`).join(', ');
  const { outputText } = ts.transpileModule(`${page}\nexport { ${exported} };\n`, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
    fileName: pagePath,
  });
  const stub = new Proxy(function stubbed() { return stub; }, {
    get: (_target, prop) => (prop === '__esModule' ? false : prop === Symbol.toPrimitive ? () => '' : stub),
    apply: () => [],
  });
  const loaded = { exports: {} };
  new Function('module', 'exports', 'require', outputText)(loaded, loaded.exports, () => stub);
  return Object.fromEntries(names.map((name) => [name, loaded.exports[`__${name}`]]));
}

const fns = loadPageFunctions(['connectionsByTool', 'toolRowState', 'describeDisconnectFailure']);
function need(name) {
  if (typeof fns[name] !== 'function') {
    throw new Error(`setup.tsx has no ${name}(): Setup has nothing that places, shows or disconnects a hosted connection`);
  }
  return fns[name];
}

const conn = (fields) => ({
  connection_id: `conn_${Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32)}`,
  client_id: 'mcp_x',
  client_name: 'ChatGPT',
  identified: true,
  surface: 'chatgpt_web',
  resource: 'https://api.deerdawn.com/mcp',
  first_authorized_at: '2026-09-01T00:00:00.000Z',
  last_used_at: new Date().toISOString(),
  ...fields,
});
const liveUsage = { surface: 'chatgpt_web', start_sessions: 2, start_session_skips: 0, update_contexts: 0, tool_calls: 5, last_called_at: new Date().toISOString(), call_rate: null };

console.log('\n=== Setup: disconnect a hosted connection ===\n');

test('a connection goes on the card its own name identifies', () => {
  const place = need('connectionsByTool');
  const chatgpt = conn({});
  const claude = conn({ client_name: 'Claude', surface: 'claude_web' });
  const { byTool, other } = place([chatgpt, claude]);
  assert.deepEqual(byTool.get('chatgpt-com'), [chatgpt]);
  assert.deepEqual(byTool.get('claude-ai'), [claude]);
  assert.deepEqual(other, []);
});

test('a connection Setup has no card for is listed on its own, not dropped and not guessed', () => {
  const place = need('connectionsByTool');
  const vscode = conn({ client_name: 'Visual Studio Code', surface: '' });
  const unnamed = conn({ client_name: null, identified: false, surface: '' });
  const hostOnly = conn({ client_name: 'claude.ai', identified: false, surface: '' });
  const { byTool, other } = place([vscode, unnamed, hostOnly]);
  assert.equal(byTool.size, 0, 'a connection was placed on a card by guessing');
  assert.deepEqual(other, [vscode, unnamed, hostOnly]);
});

test('a hosted tool whose credential is gone is not connected, whatever its old calls say', () => {
  const state = need('toolRowState');
  const withIt = state({ toolId: 'chatgpt-com', usage: liveUsage, selfAttested: false, connections: [conn({})] }).state;
  assert.equal(withIt, 'live');
  const afterDisconnect = state({ toolId: 'chatgpt-com', usage: liveUsage, selfAttested: false, connections: [] }).state;
  assert.equal(afterDisconnect, 'off', 'THE BUG: a disconnected ChatGPT still reads as connected on the strength of last week\'s calls');
});

test('a connection nobody can name keeps a hosted card as it was: it might be that tool', () => {
  const state = need('toolRowState');
  const unnamed = conn({ client_name: null, identified: false, surface: '' });
  assert.equal(state({ toolId: 'chatgpt-com', usage: liveUsage, selfAttested: false, connections: [unnamed] }).state, 'live');
  // A NAMED stranger (VS Code) rules nothing in: ChatGPT's credential is gone.
  const vscode = conn({ client_name: 'Visual Studio Code', surface: '' });
  assert.equal(state({ toolId: 'chatgpt-com', usage: liveUsage, selfAttested: false, connections: [vscode] }).state, 'off');
});

test('no listing (an older API, or it failed) changes nothing', () => {
  const state = need('toolRowState');
  assert.equal(state({ toolId: 'chatgpt-com', usage: liveUsage, selfAttested: false, connections: null }).state, 'live');
});

test('a local tool is never gated on hosted credentials', () => {
  const state = need('toolRowState');
  const usage = { ...liveUsage, surface: 'claude_code' };
  assert.equal(state({ toolId: 'claude-code', usage, selfAttested: false, connections: [] }).state, 'live');
});

test('failures read like key revocation: 404 is already gone, the rest say why', () => {
  const describe = need('describeDisconnectFailure');
  assert.equal(describe({ status: 404 }).alreadyGone, true);
  assert.equal(describe({ status: 403, data: { message: 'API keys cannot disconnect connected apps.' } }).message, 'API keys cannot disconnect connected apps.');
  assert.match(describe({ status: 401 }).message, /session expired/i);
  const other = describe({ status: 500 });
  assert.equal(other.alreadyGone, false);
  assert.ok(other.message.length > 10);
});

test('Disconnect asks first, in the same dialog key revocation uses, and says what happens', () => {
  const at = page.indexOf('const handleDisconnect');
  assert.ok(at !== -1, 'THE BUG: Setup has no disconnect handler at all');
  const handler = page.slice(at, page.indexOf('\n  };', at));
  assert.match(handler, /await confirm\(\{/, 'no confirmation before a destructive action');
  assert.match(handler, /destructive: true/);
  assert.match(handler, /confirmLabel: 'Disconnect'/);
  assert.match(handler, /lose access/i, 'the confirmation must say the tool loses access');
  assert.match(handler, /cannot renew/i, 'and that it cannot quietly come back');
  assert.match(handler, /reconnect/i, 'and how to undo it');
  assert.match(handler, /api\.disconnectHostedConnection\(/);
  assert.match(handler, /describeDisconnectFailure\(/, 'failures must be described, not swallowed');
});

test('the row reflects a disconnect without a reload', () => {
  const at = page.indexOf('const handleDisconnect');
  const handler = page.slice(at, page.indexOf('\n  };', at));
  assert.ok(!/window\.location\.reload/.test(handler), 'a disconnect must not reload the page');
  assert.match(handler, /setConnections\(/, 'the listing the rows read must be updated in place');
});

test('a connected hosted tool shows the control; the page reads the listing', () => {
  assert.match(page, /api\.getHostedConnections\(\)/, 'Setup never asks which apps are connected');
  assert.match(page, />\s*\{[^}]*'Disconnect'[^}]*\}\s*</s, 'no Disconnect control is rendered');
  assert.match(page, /Other connected apps/, 'connections with no card have nowhere to be disconnected from');
});

test('the API client adds, and changes nothing it had', () => {
  assert.ok(
    /getHostedConnections: \(\): Promise<HostedConnection\[\]> =>\s*fetchAPI\('\/api\/v1\/connections'\)/.test(apiClient),
    'api.ts has no getHostedConnections() reading GET /api/v1/connections',
  );
  assert.ok(
    /disconnectHostedConnection: \(connectionId: string\)[^\n]*=>\s*\n?\s*fetchAPI\(`\/api\/v1\/connections\/\$\{encodeURIComponent\(connectionId\)\}`, \{ method: 'DELETE' \}\)/.test(apiClient),
    'api.ts has no disconnectHostedConnection() calling DELETE /api/v1/connections/:id',
  );
  assert.ok(
    /deleteKey: \(id: string\) => fetchAPI\(`\/api\/v1\/keys\/\$\{id\}`, \{ method: 'DELETE' \}\),/.test(apiClient),
    'deleteKey changed',
  );
});

test('no gradients and no emojis in the new UI', () => {
  assert.ok(page.includes('Other connected apps'), 'the connected-apps UI is not there to check');
  assert.ok(!/gradient/i.test(page), 'a gradient crept into Setup');
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(page), 'an emoji crept into Setup');
});
