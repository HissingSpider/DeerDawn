/**
 * WHICH TOOL, AND HOW IT CONNECTS: two facts (journey round 3, design B).
 * The pure half. tests/integration/journey-r6-tool-transport.test.js drives the
 * routes and the database.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const ci = require('../../src/services/connectionIdentity');

test('a legacy surface is split into a tool and a transport', () => {
  assert.deepEqual(ci.fromLegacySurface('claude_code', { execution_source: 'stdio' }), { tool: 'claude_code', transport: 'local_stdio' });
  assert.deepEqual(ci.fromLegacySurface('claude_web', { transport: 'http' }), { tool: 'claude_web', transport: 'hosted' });
  assert.deepEqual(ci.fromLegacySurface('unknown_web', { transport: 'http' }), { tool: null, transport: 'hosted' });
  assert.deepEqual(ci.fromLegacySurface('windsurf', {}), { tool: 'windsurf', transport: 'local_stdio' });
  assert.deepEqual(ci.fromLegacySurface(null, {}), { tool: null, transport: 'local_stdio' });
});

test('hosted transport says how the request authenticated', () => {
  assert.equal(ci.hostedTransport({ type: 'key', oauth_resource: 'https://x/mcp' }), 'hosted_oauth');
  assert.equal(ci.hostedTransport({ type: 'key' }), 'hosted_api_key');
});

test('a session id and the caller say the transport', () => {
  assert.equal(ci.sessionTransport({ type: 'key', oauth_resource: 'r' }, 'web-claude_code-abc'), 'hosted_oauth');
  assert.equal(ci.sessionTransport({ type: 'key' }, 'web-claude_web-abc'), 'hosted_api_key');
  assert.equal(ci.sessionTransport({ type: 'key' }, 'agent-1x-abcdef'), 'local_stdio');
  assert.equal(ci.sessionTransport({ type: 'user' }, 'sess-1'), 'rest_api');
  assert.equal(ci.sessionTransport({}, 'sess-1'), null);
});

test('a web app id on a connection a web app cannot make is not that app', () => {
  assert.equal(ci.displayTool('claude_web', 'hosted_api_key'), null, 'Claude.ai cannot use an API key on the hosted endpoint');
  assert.equal(ci.displayTool('claude_web', 'local_stdio'), null, 'Claude.ai is not a local install');
  assert.equal(ci.displayTool('claude_web', 'hosted_oauth'), 'claude_web');
  assert.equal(ci.displayTool('claude_web', 'rest_api'), 'claude_web', 'the browser userscript captures Claude.ai over the REST API');
  assert.equal(ci.displayTool('claude_web', null), 'claude_web', 'an unknown transport is not evidence against it');
  assert.equal(ci.displayTool('claude_code', 'hosted_oauth'), 'claude_code', 'Claude Code over the hosted endpoint is still Claude Code');
  assert.equal(ci.displayTool('unknown_web', 'hosted'), null);
});

test('labels name the tool and the transport apart', () => {
  assert.equal(ci.toolLabel('claude_code'), 'Claude Code');
  assert.equal(ci.toolLabel('claude_web'), 'Claude.ai');
  assert.equal(ci.toolLabel(null), 'Unidentified client');
  assert.equal(ci.transportLabel('local_stdio'), 'local install');
  assert.equal(ci.transportLabel('hosted_oauth'), 'hosted connection');
});
