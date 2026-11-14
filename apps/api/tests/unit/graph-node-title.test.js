const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeGraphNodeTitle } = require('../../src/store/graphNodeTitle');

test('normalizes sentence-style capability titles while preserving acronyms', () => {
  assert.equal(
    normalizeGraphNodeTitle('workspace_overview_mcp_tool', 'capability'),
    'Workspace overview MCP tool'
  );
});

test('normalizes known brand and tool casing', () => {
  assert.equal(normalizeGraphNodeTitle('claude_code', 'service'), 'Claude Code');
  assert.equal(normalizeGraphNodeTitle('chatgpt', 'tool'), 'ChatGPT');
  assert.equal(normalizeGraphNodeTitle('deerdawn-api', 'repo'), 'DeerDawn API');
  assert.equal(normalizeGraphNodeTitle('nextjs', 'service'), 'Next.js');
  assert.equal(normalizeGraphNodeTitle('vscode', 'tool'), 'VS Code');
});

test('preserves path-like node titles', () => {
  assert.equal(
    normalizeGraphNodeTitle('apps/api/src/services/contextSyncService.js', 'file'),
    'apps/api/src/services/contextSyncService.js'
  );
});

test('preserves code/command-bearing titles verbatim', () => {
  // camelCase identifier with call parens
  assert.equal(
    normalizeGraphNodeTitle('hasClaudeAiDeerDawnConnection() detected but did not help', 'decision'),
    'hasClaudeAiDeerDawnConnection() detected but did not help'
  );
  // shell command with flags, =, --, scoped package
  const cmd = 'claude mcp add -s user deerdawn -e DEERDAWN_API_URL=https://api.deerdawn.com -- npx -y @deerdawn/mcp-server@latest';
  assert.equal(normalizeGraphNodeTitle(cmd, 'knowledge'), cmd);
});

test('preserves long-form content types verbatim', () => {
  const summary = 'Fixed WorkspaceEntitiesUpsertSchema missing resolved status values';
  assert.equal(normalizeGraphNodeTitle(summary, 'decision'), summary);
});
