/**
 * connectCopy on a SELF-HOSTED build points every copy-paste value at the
 * install's own API. (The hosted values are pinned elsewhere: the marketing
 * mirror test and the shared-context contract test compare them byte for byte.)
 *
 * Module-level constants read the build env at import, so the env is set by a
 * side-effect import first; node:test runs each test file in its own process.
 */
import './connectTarget.selfhosted.env.test';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as copy from './connectCopy';
import { SELF_HOSTED_API_URL, forThisDeployment } from './connectTarget';

const ORIGIN = 'https://dd.example.com';

test('a self-hosted build names its own origin', () => {
  assert.equal(SELF_HOSTED_API_URL, ORIGIN);
  assert.equal(copy.DEERDAWN_API_URL, ORIGIN);
  assert.equal(copy.REMOTE_MCP_URL, `${ORIGIN}/mcp`);
  assert.equal(copy.ONE_COMMAND_SETUP, `npx -y @deerdawn/mcp-server@latest setup --api-url ${ORIGIN}`);
});

test('no copy-paste value names the hosted API', () => {
  for (const [name, value] of Object.entries(copy)) {
    if (typeof value === 'string' && name !== 'AGENT_SETUP_URL' && name !== 'AGENT_SETUP_PROMPT') {
      assert.ok(!value.includes('api.deerdawn.com'), `${name} still names api.deerdawn.com`);
    }
  }
  for (const loc of copy.REMOTE_SETUP_LOCATIONS) assert.ok(!loc.where.includes('api.deerdawn.com'), loc.tool);
  assert.match(copy.LOCAL_NPX_CONFIG_JSON, /"DEERDAWN_API_URL": "https:\/\/dd\.example\.com"/);
  assert.match(copy.CODEX_TOML_CONFIG, /DEERDAWN_API_URL = "https:\/\/dd\.example\.com"/);
  assert.equal(copy.REMOTE_SETUP_LOCATIONS.find((l) => l.tool === 'Claude Code')?.where, `Run ${copy.ONE_COMMAND_SETUP}`);
});

test('forThisDeployment rewrites every occurrence', () => {
  assert.equal(forThisDeployment('a https://api.deerdawn.com b https://api.deerdawn.com/mcp'), `a ${ORIGIN} b ${ORIGIN}/mcp`);
});
