const test = require('node:test');
// No home-like variable from the developer's shell reaches this file: see
// contain-home.cjs.
require('./contain-home.cjs').containTestProcess(require('node:test').after);
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { recordSurfaceHeartbeat, recordSurfaceFailure, inspectLocalSetupStatus } = require('../src/setup-status.js');

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-runtime-'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

test('setup status marks a configured surface as runtime verified when a fresh heartbeat exists', () => {
  const home = makeTempHome();
  process.env.DEERDAWN_HOME_DIR = home;
  process.env.DEERDAWN_RUNTIME_STALE_MS = '86400000';

  writeJson(path.join(home, '.deerdawn', 'credentials.json'), { api_key: 'dd_test_key' });
  writeJson(path.join(home, '.codex', 'config.toml'), {});
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[mcp_servers.deerdawn]\ncommand = "npx"\n');

  recordSurfaceHeartbeat('codex', {
    runtime_version: '1.0.15',
    tool_name: 'start_session',
    cwd: '/tmp/workspace',
  });

  const status = inspectLocalSetupStatus();
  const codex = status.surfaces.find((surface) => surface.id === 'codex');

  assert.ok(codex);
  assert.equal(codex.runtime_verified, true);
  assert.equal(codex.status_basis, 'runtime');
  assert.equal(codex.stale, false);
  assert.equal(status.runtime_verified_count, 1);

  delete process.env.DEERDAWN_HOME_DIR;
  delete process.env.DEERDAWN_RUNTIME_STALE_MS;
});

test('setup status marks a runtime heartbeat stale after the threshold', () => {
  const home = makeTempHome();
  process.env.DEERDAWN_HOME_DIR = home;
  process.env.DEERDAWN_RUNTIME_STALE_MS = '1';

  writeJson(path.join(home, '.deerdawn', 'credentials.json'), { api_key: 'dd_test_key' });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[mcp_servers.deerdawn]\ncommand = "npx"\n');

  recordSurfaceHeartbeat('codex', {
    runtime_version: '1.0.15',
    last_seen_at: '2020-01-01T00:00:00.000Z',
  });

  const status = inspectLocalSetupStatus();
  const codex = status.surfaces.find((surface) => surface.id === 'codex');

  assert.ok(codex);
  assert.equal(codex.runtime_verified, false);
  assert.equal(codex.stale, true);
  assert.equal(codex.degraded_reason, 'runtime_stale');
  assert.equal(status.runtime_verified_count, 0);

  delete process.env.DEERDAWN_HOME_DIR;
  delete process.env.DEERDAWN_RUNTIME_STALE_MS;
});

test('setup status preserves the last runtime failure for a surface', () => {
  const home = makeTempHome();
  process.env.DEERDAWN_HOME_DIR = home;

  writeJson(path.join(home, '.deerdawn', 'credentials.json'), { api_key: 'dd_test_key' });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[mcp_servers.deerdawn]\ncommand = "npx"\n');

  recordSurfaceFailure('codex', {
    runtime_version: '1.0.15',
    last_error: 'tool_call_failed',
  });

  const status = inspectLocalSetupStatus();
  const codex = status.surfaces.find((surface) => surface.id === 'codex');

  assert.ok(codex);
  assert.equal(codex.last_error, 'tool_call_failed');
  assert.equal(codex.runtime_verified, false);

  delete process.env.DEERDAWN_HOME_DIR;
});
