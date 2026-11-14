/**
 * Setup said "0 of 9 tools connected" over a Claude.ai connection that worked.
 *
 * The hosted transport is stateless, so `clientInfo` arrives on `initialize`
 * alone and every tools/call used to be filed under 'unknown_web'. Setup marks
 * a card connected only when ITS surface has calls, and no card maps from
 * 'unknown_web', so the walker's account (claude_web: a handshake and 0 calls;
 * unknown_web: 4 calls, 2 brief loads) rendered Claude.ai as "last seen today"
 * beside a Connect button.
 *
 * The API now files a call under the client its OAuth credential names. That
 * fixes every call from here on, and it cannot fix the calls already recorded,
 * nor the ones still arriving on a credential minted before keys carried their
 * client's name. Those rows are not rewritten. Instead Setup reads them with one
 * rule, and the rule never guesses:
 *
 *   unidentified web calls belong to a hosted web tool ONLY when exactly one
 *   hosted web tool introduced itself (an identified handshake) and no
 *   unidentified client did. Two candidates, or an unidentified client that
 *   could have made the calls itself, and the calls stay unattributed.
 *
 * Driven against the page's own functions, transpiled from setup.tsx, so the
 * rule is tested as it runs rather than as it reads.
 *
 * Run: `node tests/setup-hosted-attribution-contract.test.js` (wired into
 * `npm test -w dashboard`).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const pagePath = path.join(root, 'src/pages/setup.tsx');
const page = fs.readFileSync(pagePath, 'utf8');

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

// Load the page module with every import stubbed: only its top-level pure
// functions are exercised, and none of them touch React or the API client.
function loadPageFunctions(names) {
  const exported = names.map((name) => `${name} as __${name}`).join(', ');
  const source = `${page}\nexport { ${exported} };\n`;
  const { outputText } = ts.transpileModule(source, {
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

let fns = null;
try {
  fns = loadPageFunctions(['usageByToolId', 'toolRowState']);
} catch (error) {
  fns = { loadError: error };
}

function states(surfaces, { connections = null, selfAttested = {} } = {}) {
  if (fns.loadError || typeof fns.usageByToolId !== 'function' || typeof fns.toolRowState !== 'function') {
    const why = fns.loadError ? fns.loadError.message : 'usageByToolId / toolRowState are not defined';
    throw new Error(`setup.tsx has no card-state functions that can read the walker's data (${why}), so Setup still renders 0 of 9`);
  }
  const usage = fns.usageByToolId(surfaces);
  const out = {};
  for (const id of ['claude-ai', 'chatgpt-com', 'claude-code', 'cursor', 'codex']) {
    out[id] = fns.toolRowState({ toolId: id, usage: usage.get(id), selfAttested: Boolean(selfAttested[id]), connections }).state;
  }
  return out;
}

const now = new Date().toISOString();
const row = (surface, fields = {}) => ({
  surface,
  start_sessions: 0,
  start_session_skips: 0,
  update_contexts: 0,
  tool_calls: 0,
  last_called_at: now,
  call_rate: null,
  handshakes: 0,
  ...fields,
});

console.log('\n=== Setup: hosted call attribution ===\n');

test('a call the API filed under Claude.ai makes the Claude.ai card connected', () => {
  const s = states([row('claude_web', { tool_calls: 4, start_sessions: 2, handshakes: 1 })]);
  assert.equal(s['claude-ai'], 'live', JSON.stringify(s));
});

test('the walker\'s account: one Claude.ai handshake, four unidentified calls, reads as connected', () => {
  // Exactly the bootstrap the walker captured, plus the handshake count the
  // API now reports beside it.
  const s = states([
    row('claude_web', { handshakes: 1 }),
    row('unknown_web', { tool_calls: 4, start_sessions: 2, call_rate: 100 }),
  ]);
  assert.equal(s['claude-ai'], 'live', `THE BUG: 0 of 9 over a working Claude.ai connection: ${JSON.stringify(s)}`);
  assert.notEqual(s['chatgpt-com'], 'live', 'the calls were credited to a tool that never connected');
});

test('two hosted tools introduced themselves, so their old calls are nobody\'s', () => {
  const s = states([
    row('claude_web', { handshakes: 1 }),
    row('chatgpt_web', { handshakes: 2 }),
    row('unknown_web', { tool_calls: 5, start_sessions: 1 }),
  ]);
  assert.notEqual(s['claude-ai'], 'live', `a guess: ${JSON.stringify(s)}`);
  assert.notEqual(s['chatgpt-com'], 'live', `a guess: ${JSON.stringify(s)}`);
});

test('an unidentified client connected too, so it may have made the calls itself', () => {
  // Cursor, VS Code and Codex reach the hosted endpoint as 'unknown_web' at
  // the handshake as well; any of them could own every one of these calls.
  const s = states([
    row('claude_web', { handshakes: 1 }),
    row('unknown_web', { tool_calls: 3, handshakes: 1 }),
  ]);
  assert.notEqual(s['claude-ai'], 'live', `a guess: ${JSON.stringify(s)}`);
});

test('no identified handshake at all: the calls stay unattributed', () => {
  const s = states([row('unknown_web', { tool_calls: 3 })]);
  assert.deepEqual(Object.values(s).filter((v) => v === 'live'), [], JSON.stringify(s));
});

test('an API that does not report handshakes yet attributes nothing', () => {
  // Dashboard deployed ahead of the API: no `handshakes` field anywhere.
  const bare = (surface, fields) => { const r = row(surface, fields); delete r.handshakes; return r; };
  const s = states([bare('claude_web'), bare('unknown_web', { tool_calls: 4 })]);
  assert.notEqual(s['claude-ai'], 'live', JSON.stringify(s));
});

test('a local tool\'s card is untouched by hosted attribution', () => {
  const s = states([
    row('claude_code', { tool_calls: 7 }),
    row('claude_web', { handshakes: 1 }),
    row('unknown_web', { tool_calls: 2 }),
  ]);
  assert.equal(s['claude-code'], 'live');
  assert.equal(s['claude-ai'], 'live');
  assert.notEqual(s.cursor, 'live');
});

test('a handshake alone is not a connection', () => {
  // Unchanged on purpose: connecting is not a trigger, and Setup counts calls.
  const s = states([row('chatgpt_web', { handshakes: 3 })]);
  assert.notEqual(s['chatgpt-com'], 'live', JSON.stringify(s));
});

test('the header counts what the rows say', () => {
  assert.ok(
    /connectedCount = rows\.filter\(\(r\) => r\.state !== 'off'\)\.length/.test(page),
    'the "N of 9 tools connected" count must be derived from the same row states',
  );
});
