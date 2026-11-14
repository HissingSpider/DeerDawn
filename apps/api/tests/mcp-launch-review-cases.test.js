'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  CONTENT_BUDGET_CHARS,
  sanitizeToolResult,
  validateToolArguments,
} = require('../src/services/mcpSafety');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const corpus = JSON.parse(fs.readFileSync(path.join(repoRoot, 'docs/launch/native-mcp-review-cases.json'), 'utf8'));
const mcpSource = fs.readFileSync(path.join(repoRoot, 'apps/api/src/routes/mcp.js'), 'utf8');
const oauthSource = fs.readFileSync(path.join(repoRoot, 'apps/api/src/routes/oauth.js'), 'utf8');
const submissionPack = fs.readFileSync(path.join(repoRoot, 'docs/launch/native-mcp-submission-pack.md'), 'utf8');
const registryManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'docs/launch/mcp-listings/server.json'), 'utf8'));
const packageVersion = require(path.join(repoRoot, 'packages/mcp-server/package.json')).version;

const readTool = (inputSchema = { type: 'object', properties: {} }) => ({ inputSchema, annotations: { readOnlyHint: true } });

// Evaluate only the static TOOLS array with inert output-schema placeholders.
// This keeps the review corpus tied to the actual advertised input schemas, so
// stale argument names or omitted required fields cannot pass a string-presence
// check while failing during a real directory review.
function advertisedTools() {
  const start = mcpSource.indexOf('const TOOLS = [');
  const end = mcpSource.indexOf('\n];\n\nmodule.exports', start);
  assert.ok(start !== -1 && end !== -1, 'static TOOLS array must be readable');
  const expression = mcpSource.slice(mcpSource.indexOf('[', start), end + 2);
  const outputSchemas = new Proxy({}, { get: () => ({ type: 'object', properties: {} }) });
  return Function('OUTPUT_SCHEMAS', 'GROUPED_OUTPUT', 'GRAPH_NODE_TYPE_VALUES', `return (${expression});`)(outputSchemas, { type: 'object', additionalProperties: true }, []);
}

const toolsByName = new Map(advertisedTools().map((tool) => [tool.name, tool]));

assert.ok(corpus.cases.length >= 20 && corpus.cases.length <= 30, 'review corpus must contain 20-30 cases');
assert.strictEqual(new Set(corpus.cases.map((item) => item.id)).size, corpus.cases.length, 'case IDs must be unique');
assert.ok(corpus.cases.filter((item) => item.category === 'positive').length >= 5, 'at least five positive cases required');
assert.ok(corpus.cases.filter((item) => item.category === 'negative').length >= 3, 'at least three negative cases required');
for (const category of ['positive', 'negative', 'auth', 'isolation', 'safety']) {
  assert.ok(corpus.cases.some((item) => item.category === category), `missing ${category} cases`);
}

assert.strictEqual(registryManifest.version, packageVersion, 'registry manifest must match the published package version');
assert.strictEqual(registryManifest.packages[0].version, packageVersion, 'registry package entry must match package version');
assert.strictEqual(registryManifest.remotes[0].url, corpus.endpoint, 'registry and review corpus must use the canonical endpoint');
for (const required of [
  'support@deerdawn.com',
  'https://deerdawn.com/privacy',
  'https://deerdawn.com/terms',
  'api.apps.write',
  'global data residency',
  'headless and MCP-only',
  'DOMAIN_VERIFICATION_FILENAME',
]) {
  assert.ok(submissionPack.includes(required), `submission pack is missing ${required}`);
}
assert.ok(oauthSource.includes('router.get(\'/.well-known/:challengeFile\''), 'temporary domain challenge route missing');

for (const item of corpus.cases) {
  assert.strictEqual(typeof item.prompt, 'string', `${item.id}: prompt required`);
  assert.ok(Object.prototype.hasOwnProperty.call(item, 'expected_tool'), `${item.id}: expected_tool required`);
  assert.strictEqual(typeof item.expected_arguments, 'object', `${item.id}: expected_arguments required`);
  assert.strictEqual(typeof item.expected_result, 'object', `${item.id}: expected_result required`);

  switch (item.contract) {
    case 'tool_selection':
      assert.ok(mcpSource.includes(`name: '${item.expected_tool}'`), `${item.id}: advertised tool missing`);
      assert.doesNotThrow(
        () => validateToolArguments(toolsByName.get(item.expected_tool), item.expected_arguments),
        `${item.id}: review arguments must match the advertised schema`,
      );
      break;
    case 'no_tool':
      assert.strictEqual(item.expected_tool, null);
      break;
    case 'invalid_arguments':
      assert.throws(() => validateToolArguments(readTool({ type: 'object', properties: { query: { type: 'string' } } }), item.expected_arguments), /not a supported argument/);
      break;
    case 'oversized_input':
      assert.throws(() => validateToolArguments(readTool({ type: 'object', properties: { query: { type: 'string', maxLength: 500 } } }), { query: 'x'.repeat(501) }), /character limit/);
      break;
    case 'prompt_injection':
      assert.throws(() => validateToolArguments(toolsByName.get(item.expected_tool), item.expected_arguments), /prompt-injection/);
      break;
    case 'prompt_injection_confirmed':
      assert.doesNotThrow(() => validateToolArguments(toolsByName.get(item.expected_tool), item.expected_arguments));
      break;
    case 'confirmation_required':
    case 'destructive_confirmed':
      assert.ok(mcpSource.includes('confirm_destructive'));
      assert.ok(mcpSource.includes('mcpCode = \'confirmation_required\''));
      assert.doesNotThrow(() => validateToolArguments(toolsByName.get(item.expected_tool), item.expected_arguments));
      break;
    case 'auth_401':
      assert.ok(mcpSource.includes('return requireAuth(req, res, next)'));
      assert.ok(!mcpSource.match(/PUBLIC_DISCOVERY_METHODS[\s\S]{0,100}initialize/));
      break;
    case 'public_discovery':
      assert.ok(mcpSource.includes('PUBLIC_DISCOVERY_METHODS.has(method)'));
      assert.ok(mcpSource.includes('\'tools/list\''));
      assert.ok(mcpSource.includes('securitySchemes'));
      break;
    case 'insufficient_scope':
      assert.ok(mcpSource.includes('oauthError = \'insufficient_scope\''));
      assert.doesNotThrow(() => validateToolArguments(toolsByName.get(item.expected_tool), item.expected_arguments));
      break;
    case 'invalid_grant':
      assert.ok(oauthSource.includes('error: \'invalid_grant\''));
      break;
    case 'tenant_isolation':
    case 'owner_scoping':
      assert.ok(mcpSource.includes('service.getProject(actor, project_id)') || mcpSource.includes('service.listProjectTree(actor)'));
      assert.doesNotThrow(() => validateToolArguments(toolsByName.get(item.expected_tool), item.expected_arguments));
      break;
    case 'redaction': {
      assert.doesNotThrow(() => validateToolArguments(toolsByName.get(item.expected_tool), item.expected_arguments));
      const safe = sanitizeToolResult({ content: [{ type: 'text', text: 'Bearer abc.def.ghi' }] });
      assert.ok(safe.content[0].text.includes('[REDACTED]'));
      assert.ok(!safe.content[0].text.includes('abc.def.ghi'));
      break;
    }
    case 'output_budget': {
      assert.doesNotThrow(() => validateToolArguments(toolsByName.get(item.expected_tool), item.expected_arguments));
      const safe = sanitizeToolResult({ content: [{ type: 'text', text: 'x'.repeat(CONTENT_BUDGET_CHARS + 100) }] });
      assert.ok(safe.content[0].text.includes('output truncated'));
      break;
    }
    default:
      throw new Error(`${item.id}: unknown contract ${item.contract}`);
  }
  console.log(`✓ ${item.id} ${item.category}: ${item.prompt}`);
}

console.log(`\n${corpus.cases.length} native MCP review cases passed.`);
