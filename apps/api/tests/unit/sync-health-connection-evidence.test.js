/**
 * sync_health.mcp_registered must mean "a client reached us", not "a row exists".
 *
 * The flag was `mcpConnected || recentlySynced || hasProjects`. The last two are
 * satisfied by a context_projects row — and the DASHBOARD writes those itself.
 * The onboarding capture step's "Save my first brief" button is one POST, and on
 * the capture-first (phone) ordering it runs BEFORE the connect step, so a user
 * who had never opened an AI tool arrived at /onboarding already "registered":
 * the poll read 'synced', onboarding_connection_detected fired, the step
 * auto-advanced after 1.5s, and onboarding_completed recorded
 * verified_connection: true.
 *
 * That is the same error `connection_established` was created to avoid one level
 * up (a handshake is not a tool call) — here it was counting something that is
 * not even a handshake.
 *
 * Asserted against the route source because the flag is computed inside the
 * bootstrap handler's response literal, which no exported function returns. The
 * dashboard half of the same contract is
 * apps/dashboard/src/lib/connectionEvidence.test.ts, which tests real logic.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'src', 'routes', 'shared', 'dashboard.js'),
  'utf8',
);

/** The source with `//` comments stripped, so prose can never satisfy a check. */
const code = source
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

test('mcp_registered is derived from MCP events alone', () => {
  const match = code.match(/mcp_registered:\s*([^,\n]+)/);
  assert.ok(match, 'mcp_registered is no longer assigned in the bootstrap response');
  assert.equal(
    match[1].trim(),
    'mcpConnected',
    'mcp_registered must be exactly the source=\'mcp\' signal. Anything ORed in ' +
      'here is a claim that something other than a client reaching us is a ' +
      'connection — which is how a dashboard-side project create came to count ' +
      'as a verified connection.',
  );
});

test('a project row cannot reach the connection flag', () => {
  const line = code.match(/mcp_registered:.*/)[0];
  for (const banned of ['hasProjects', 'recentlySynced', 'lastSynced', 'has_projects']) {
    assert.ok(
      !line.includes(banned),
      `${banned} is back in mcp_registered. It is satisfied by a context_projects ` +
        'row, which the dashboard creates on the user\'s behalf.',
    );
  }
});

test('the MCP evidence query counts only authenticated runtime events', () => {
  // source='mcp' is written by the hosted dispatcher (mcp_runtime_started on
  // initialize, mcp_tool_call_succeeded / mcp_start_session_succeeded per call)
  // and by the local stdio server, in both cases only after auth resolves. The
  // device-flow events are source='mcp_auth' and must stay out: an abandoned
  // browser sign-in is not a connection.
  assert.ok(
    /mcp_events[\s\S]{0,400}?source = 'mcp'/.test(code),
    'the mcp_events query should filter on source = \'mcp\'',
  );
  assert.ok(
    !/mcp_events[\s\S]{0,400}?mcp_auth/.test(code),
    'source=\'mcp_auth\' (the device flow) must not count as a connection',
  );
});

test('has_projects is still published, just not as a connection', () => {
  // The fix is a separation, not a deletion: callers that legitimately want to
  // know whether any context exists still have the field.
  assert.ok(
    /has_projects:\s*hasProjects/.test(code),
    'has_projects should still be reported on sync_health',
  );
});

test('an authorized connector is published separately and never as a connection', () => {
  // 2026-09-27: ChatGPT exchanges its code at approve and first calls when a
  // chat uses the connector, so a fresh signup had a live credential and no
  // mcp_* event, and the empty state asked them to "Connect a tool". The grant
  // is published for display, and must stay out of mcp_registered: a handshake
  // is not a tool call.
  assert.ok(/connector_authorized:\s*connectorGrantRes\.rows\.length > 0/.test(code), 'connector_authorized should be published from the grant query');
  assert.ok(!/mcp_registered:.*connector/i.test(code), 'the connector grant must not reach mcp_registered');
  const query = code.slice(code.indexOf('SELECT oauth_client_name'), code.indexOf('\'org-system\'', code.indexOf('SELECT oauth_client_name')));
  assert.ok(/oauth_resource IS NOT NULL/.test(query), 'only OAuth-issued connector credentials count');
  assert.ok(/status = 'active'/.test(query), 'a revoked grant is not a connector');
  assert.ok(/expires_at > NOW\(\)/.test(query), 'an expired grant is not a connector');
  assert.ok(/owner_id = ANY\(\$2\)/.test(query), 'on a team, only the viewer\'s own connector counts');
});
