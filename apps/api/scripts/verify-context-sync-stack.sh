#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

echo "== Context Sync Contracts =="
node apps/api/tests/context-sync-contracts.test.js
node apps/dashboard/tests/context-graph.contract.cjs
node apps/desktop/tests/contracts.test.cjs
node apps/desktop/tests/native-integrations.test.cjs
node apps/extension/tests/contracts.test.cjs
node packages/mcp-server/tests/config.node.test.cjs
node packages/mcp-server/tests/client.node.test.cjs
node packages/mcp-server/tests/context-graph.node.test.cjs

echo
echo "== Typecheck =="
./node_modules/.bin/tsc -p apps/dashboard/tsconfig.json --noEmit
./node_modules/.bin/tsc -p apps/desktop/tsconfig.json --noEmit

echo
echo "== MCP Runtime =="
(
  cd packages/mcp-server
  ../../apps/desktop/node_modules/.bin/tsup >/tmp/deerdawn-mcp-build.log
)
DEERDAWN_API_URL=http://localhost:8080 DEERDAWN_API_KEY=dev-key node -e "
const { spawn } = require('child_process');
const child = spawn(process.execPath, ['packages/mcp-server/dist/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, DEERDAWN_API_URL: 'http://localhost:8080', DEERDAWN_API_KEY: 'dev-key' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
setTimeout(() => {
  const ok = stderr.includes('running on stdio');
  child.kill('SIGINT');
  setTimeout(() => {
    if (!ok) {
      console.error(stderr);
      process.exit(1);
    }
    console.log('MCP server boot smoke passed.');
    process.exit(0);
  }, 200);
}, 1000);
"

echo
echo "== Native Client Configs =="
node -e "
const fs = require('fs');
const files = [
  process.env.HOME + '/Library/Application Support/Claude/claude_desktop_config.json',
  process.env.HOME + '/.cursor/mcp.json',
];
for (const file of files) {
  if (!fs.existsSync(file)) {
    console.error('Missing native config: ' + file);
    process.exit(1);
  }
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entry = json.mcpServers?.deerdawn;
  if (!entry) {
    console.error('Missing deerdawn MCP entry: ' + file);
    process.exit(1);
  }
  const args = Array.isArray(entry.args) ? entry.args : [];
  const usesLocalBuild = entry.command === 'node'
    && Boolean(args[0] && String(args[0]).includes('/packages/mcp-server/dist/index.js'));
  const usesPublishedLatest = entry.command === 'npx'
    && args.includes('-y')
    && args.some((arg) => String(arg).includes('@deerdawn/mcp-server@latest'));
  if (!usesLocalBuild && !usesPublishedLatest) {
    console.error('Expected either local build (node dist/index.js) or npx @latest MCP config: ' + file);
    process.exit(1);
  }
}
console.log('Native client config verification passed.');
"

echo
echo "== Context Sync API =="
DEERDAWN_API_KEY=dev-key DISABLE_REDIS=true node apps/api/tests/unit/context-sync.service.test.js
DEERDAWN_API_KEY=dev-key DISABLE_REDIS=true node apps/api/tests/integration/context-sync-api.test.js
DEERDAWN_API_KEY=dev-key DISABLE_REDIS=true node apps/api/tests/integration/context-sync-tenant-isolation.test.js

echo
echo "Context sync verification passed."
