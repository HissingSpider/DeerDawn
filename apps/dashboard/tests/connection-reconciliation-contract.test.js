/**
 * Connection reconciliation contracts (2026-08-26).
 *
 * /onboarding's connection poll only ever sees a handshake that lands while that
 * page is MOUNTED — but the entire design of the connect step is that the user
 * LEAVES to paste a URL into Claude, Cursor or ChatGPT. Someone who connects from
 * their editor and returns tomorrow was never told it worked, and never counted.
 *
 * The dashboard's zero-project empty state was the specific hole: it is the one
 * screen a connected-but-unbriefed user actually lands on, and it told them to
 * "Connect a tool" — the one thing they had already done. That is the literal
 * "I pasted the config, restarted my client, and nothing visibly happened"
 * complaint, rendered by us.
 *
 * It is a reachable and known population: connecting is not a trigger. A tool
 * only loads a brief when the model calls start_session, and 3 of 8 accounts that
 * ever completed a handshake have never made a single tool call.
 *
 * Run: `node tests/connection-reconciliation-contract.test.js` (wired into
 * `npm test -w dashboard`).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const emptyState = fs.readFileSync(
  path.join(root, 'src/components/dashboard/brief/SampleBriefEmptyState.tsx'),
  'utf8'
);
const provider = fs.readFileSync(
  path.join(root, 'src/components/dashboard/DashboardBootstrapProvider.tsx'),
  'utf8'
);

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

console.log('\n=== Connection Reconciliation Contract Tests ===\n');

test('the empty state reads server-backed connection state, not a poll', () => {
  assert.ok(
    /useDashboardBootstrap\(\)/.test(emptyState),
    'the empty state should read bootstrap, which is server-backed and therefore ' +
      'true whenever the user returns — unlike the onboarding page poll'
  );
  assert.ok(
    /sync_health\?\.mcp_registered/.test(emptyState),
    'connection should be derived from sync_health.mcp_registered'
  );
});

test('an already-connected user is never told to connect a tool', () => {
  // The whole defect in one assertion: "Connect a tool" must live only on the
  // branch where nothing is connected.
  const connectedBranch = emptyState.slice(
    emptyState.indexOf('{connected ? ('),
    emptyState.indexOf(') : (')
  );
  assert.ok(connectedBranch.length > 0, 'connected branch not found');
  assert.ok(
    !/Connect a tool/.test(connectedBranch),
    'the connected branch must not ask the user to do the thing they already did'
  );
  assert.ok(
    /Connect a tool/.test(emptyState),
    'the disconnected branch should still carry the connect CTA'
  );
});

test('the connected state names start_session as the actual trigger', () => {
  // Connecting is not a trigger. If we do not say so, the user concludes the
  // product is broken and leaves — which is what the funnel shows them doing.
  assert.ok(
    /start_session/.test(emptyState),
    'the connected state must explain that the brief loads when the model calls ' +
      'start_session — connecting alone does nothing visible'
  );
});

test('reconciliation is reported once, and is separable from the poll', () => {
  assert.ok(
    /trackProductEvent\('onboarding_connection_detected'/.test(provider),
    'a connection observed on a later dashboard load should still be recorded'
  );
  assert.ok(
    /surface: 'dashboard_bootstrap'/.test(provider),
    "the emission must carry a surface so it is distinguishable from /onboarding's " +
      'poll-driven emission of the same event'
  );
  assert.ok(
    /localStorage\.getItem\(key\)/.test(provider),
    'the event should fire once per person per browser, not on every dashboard load'
  );
});

test('reconciliation is not emitted from a surface that only no-project accounts see', () => {
  // The emitter lived here until 2026-09-16. SampleBriefEmptyState renders only
  // when projects.length === 0, so everyone who connected AND got a brief was
  // invisible to it, which made the event anti-correlated with real syncs.
  assert.ok(
    !/trackProductEvent\('onboarding_connection_detected'/.test(emptyState),
    'the empty state cannot see a connected user who has a project'
  );
});

test('a connector that has authorized but not yet called is not told to connect', () => {
  // 2026-09-27: two signups through ChatGPT approved the connector and landed
  // here with no mcp_* event yet — ChatGPT exchanges its code at approve and
  // first calls when a chat uses the connector — and were asked to "Connect a
  // tool". The grant is enough to stop asking for that step.
  assert.ok(
    /sync_health\?\.connector_authorized/.test(emptyState),
    'the empty state should read sync_health.connector_authorized'
  );
  const connectedExpr = emptyState.slice(
    emptyState.indexOf('const connected = Boolean('),
    emptyState.indexOf(');', emptyState.indexOf('const connected = Boolean('))
  );
  assert.ok(/connectorAuthorized/.test(connectedExpr), 'an authorized connector should count as connected here');
});

test('the connector grant never becomes connection evidence', () => {
  // A handshake is not a tool call. The grant is display-only: it must not reach
  // the provider's reconciliation event or the shared evidence helper.
  const evidence = fs.readFileSync(path.join(root, 'src/lib/connectionEvidence.ts'), 'utf8');
  assert.ok(!/connector_authorized|connectorAuthorized/.test(provider), 'the provider must not read the connector grant');
  assert.ok(!/connector_authorized|connectorAuthorized/.test(evidence), 'connectionEvidence must not read the connector grant');
});

test('the sample lines are hidden once a tool is connected', () => {
  // Invented "verified" lines rendered with the real slot components read as
  // data already loaded into a new account.
  const grid = emptyState.indexOf('aria-label="Sample brief preview"');
  assert.ok(grid > 0, 'sample preview not found');
  const before = emptyState.slice(Math.max(0, grid - 200), grid);
  assert.ok(/\{!connected && \(/.test(before), 'the sample preview must render only when nothing is connected');
});

console.log('\nConnection reconciliation contracts in place.\n');
