import test from 'node:test';
import assert from 'node:assert/strict';
import { transportLabel, usageFromHealth, usageFromTools, type McpToolRow } from './toolUsage';

const row = (over: Partial<McpToolRow>): McpToolRow => ({
  tool: 'claude_code', transport: 'local_stdio', start_sessions: 0, start_session_skips: 0,
  update_contexts: 0, tool_calls: 0, handshakes: 0, last_called_at: null, ...over,
});

test('a hosted Claude Code and a local Claude Code are one tool on two transports', () => {
  const usage = usageFromTools([
    row({ transport: 'local_stdio', tool_calls: 3, start_sessions: 2, last_called_at: '2026-09-29T10:00:00Z' }),
    row({ transport: 'hosted_oauth', tool_calls: 4, last_called_at: '2026-09-30T10:00:00Z' }),
  ]);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].surface, 'claude_code');
  assert.equal(usage[0].tool_calls, 7);
  assert.deepEqual(usage[0].transports, ['hosted_oauth', 'local_stdio']);
  assert.equal(usage[0].last_called_at, '2026-09-30T10:00:00Z');
});

test('a hosted Claude Code is never counted as Claude.ai', () => {
  const usage = usageFromTools([
    row({ tool: 'claude_code', transport: 'hosted_oauth', tool_calls: 5 }),
    row({ tool: 'claude_web', transport: 'hosted_oauth', tool_calls: 1 }),
  ]);
  const bySurface = Object.fromEntries(usage.map((u) => [u.surface, u.tool_calls]));
  assert.deepEqual(bySurface, { claude_code: 5, claude_web: 1 });
});

test('a client nothing could name stays the unidentified web surface', () => {
  const usage = usageFromTools([row({ tool: null, transport: 'hosted_api_key', tool_calls: 2, handshakes: 1 })]);
  assert.equal(usage[0].surface, 'unknown_web');
  assert.equal(usage[0].handshakes, 1);
});

test('an older API that sends only mcp_surfaces is read as before', () => {
  const surfaces = [{ surface: 'cursor', start_sessions: 1, start_session_skips: 0, update_contexts: 0, tool_calls: 1, last_called_at: null, call_rate: 100 }];
  assert.deepEqual(usageFromHealth({ mcp_surfaces: surfaces }), surfaces);
  assert.deepEqual(usageFromHealth({ mcp_tools: [], mcp_surfaces: surfaces }), surfaces);
  assert.deepEqual(usageFromHealth(null), []);
});

test('transports have plain names', () => {
  assert.equal(transportLabel('local_stdio'), 'local install');
  assert.equal(transportLabel('hosted_oauth'), 'hosted connection');
  assert.equal(transportLabel('something_new'), 'something_new');
});
