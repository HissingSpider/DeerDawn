/**
 * The cross-connection dedup fires only for the case it exists for.
 *
 * sessionDedup's header names that case: ONE host reaching DeerDawn through two
 * connections at once, "the claude.ai connector AND a local Claude Code MCP
 * server", where the same conversation would otherwise get the brief twice.
 * The check did not look at the surfaces at all. Any second start_session for
 * the same person and project inside 90 seconds was a duplicate, so opening the
 * project in Claude Code and then in Cursor 20 seconds later told Cursor
 * "Context already loaded moments ago via your other DeerDawn connection" and
 * gave it no task and no decisions. It never had them.
 *
 * Two LOCAL loads are never one conversation: a host does not run two local
 * DeerDawn stdio servers. Only a hosted (web) connection can be the second
 * connection of a host that is also running a local one.
 *
 * Uses the in-memory Redis stub (NODE_ENV=test). No DB required.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { redis } = require('../../src/config/redis');
const { checkAndMarkSessionLoad } = require('../../src/services/sessionDedup');

// A fresh person per test, so no marker leaks between them.
function someone() {
  const id = `user-dedup-surf-${crypto.randomBytes(4).toString('hex')}`;
  return { type: 'user', id, org_id: `org-${id}`, workspace_key: `org-${id}` };
}

test('a second local tool opening the same project is a real session, not a duplicate', async () => {
  const ana = someone();
  const first = await checkAndMarkSessionLoad(ana, 'proj-local-pair', 'claude_code');
  assert.equal(first.duplicate, false);
  // Cursor, a separate local install, 20 seconds later.
  const cursor = await checkAndMarkSessionLoad(ana, 'proj-local-pair', 'cursor');
  assert.equal(cursor.duplicate, false, 'Cursor was told Claude Code\'s brief was already in its context');
});

test('the other order too: Cursor first, then a new Claude Code process', async () => {
  const ana = someone();
  await checkAndMarkSessionLoad(ana, 'proj-local-pair-2', 'cursor');
  const claudeCode = await checkAndMarkSessionLoad(ana, 'proj-local-pair-2', 'claude_code');
  assert.equal(claudeCode.duplicate, false);
});

test('two processes of the same local tool are two sessions', async () => {
  const ana = someone();
  await checkAndMarkSessionLoad(ana, 'proj-two-terminals', 'claude_code');
  const secondTerminal = await checkAndMarkSessionLoad(ana, 'proj-two-terminals', 'claude_code');
  assert.equal(secondTerminal.duplicate, false, 'a second terminal running Claude Code has no brief until it is given one');
});

test('a hosted connection beside a local one is still the duplicate the dedup exists for', async () => {
  const ana = someone();
  // Local stdio first, then the claude.ai connector in the same host.
  await checkAndMarkSessionLoad(ana, 'proj-mixed-1', 'claude_code');
  const viaConnector = await checkAndMarkSessionLoad(ana, 'proj-mixed-1', 'claude_web');
  assert.equal(viaConnector.duplicate, true);
  assert.equal(viaConnector.otherSurface, 'claude_code');

  // And the connector first, then the local server.
  const bob = someone();
  await checkAndMarkSessionLoad(bob, 'proj-mixed-2', 'claude_web');
  const viaLocal = await checkAndMarkSessionLoad(bob, 'proj-mixed-2', 'claude_code');
  assert.equal(viaLocal.duplicate, true);
  assert.equal(viaLocal.otherSurface, 'claude_web');
});

test('every surface the hosted dispatcher sends counts as hosted, including its unidentified one', async () => {
  // detectWebSurface (routes/mcp.js) answers claude_web, chatgpt_web, or
  // unknown_web when a stateless tools/call carried no clientInfo. The last is
  // non-identifying about the TOOL, but it is still certainly a hosted connection.
  for (const hosted of ['claude_web', 'chatgpt_web', 'unknown_web']) {
    const ana = someone();
    await checkAndMarkSessionLoad(ana, 'proj-hosted', 'cursor');
    const second = await checkAndMarkSessionLoad(ana, 'proj-hosted', hosted);
    assert.equal(second.duplicate, true, `${hosted} beside a local load must still dedup`);
  }
  const ana = someone();
  await checkAndMarkSessionLoad(ana, 'proj-hosted-pair', 'chatgpt_web');
  const again = await checkAndMarkSessionLoad(ana, 'proj-hosted-pair', 'unknown_web');
  assert.equal(again.duplicate, true, 'two hosted loads keep today\'s behaviour');
});

test('an unidentified surface never withholds on its own: it counts as hosted only when it is', async () => {
  // Nothing in the API passes these today (the /active route defaults to
  // claude_code, the hosted dispatcher to unknown_web). A future caller that
  // forgets is treated as a separate session unless the OTHER load is hosted.
  for (const unknown of [undefined, null, '', 'unknown']) {
    const ana = someone();
    await checkAndMarkSessionLoad(ana, 'proj-unknown', 'claude_code');
    const next = await checkAndMarkSessionLoad(ana, 'proj-unknown', unknown);
    assert.equal(next.duplicate, false, `surface ${JSON.stringify(unknown)} after a local load withheld a brief`);
  }
  const ana = someone();
  await checkAndMarkSessionLoad(ana, 'proj-unknown-hosted', 'claude_web');
  const next = await checkAndMarkSessionLoad(ana, 'proj-unknown-hosted', null);
  assert.equal(next.duplicate, true, 'the hosted side is positively known, so the pair is still the one the dedup is for');
});

test('the marker is refreshed on every load, including one that is not a duplicate', async () => {
  const ana = someone();
  await checkAndMarkSessionLoad(ana, 'proj-refresh', 'claude_code');
  await checkAndMarkSessionLoad(ana, 'proj-refresh', 'cursor');
  const viaConnector = await checkAndMarkSessionLoad(ana, 'proj-refresh', 'claude_web');
  assert.equal(viaConnector.duplicate, true);
  assert.equal(viaConnector.otherSurface, 'cursor', 'the marker holds the latest load, not the first');
});

test('never throws: a failing cache reports "not a duplicate"', async () => {
  const ana = someone();
  const { get, set } = redis;
  redis.get = async () => { throw new Error('redis down'); };
  redis.set = async () => { throw new Error('redis down'); };
  try {
    const result = await checkAndMarkSessionLoad(ana, 'proj-degraded', 'claude_web');
    assert.deepEqual(result, { duplicate: false, secondsAgo: null, otherSurface: null });
  } finally {
    redis.get = get;
    redis.set = set;
  }
});

// ── One local PROCESS loading twice ─────────────────────────────────────────
// Two local loads are two sessions, except when they are the SAME process: the
// model calls start_session again, or a hook and the tool both load inside the
// window. That process already has the brief. The /active route passes the
// process's own id (the local server's per-process `agent-<pid>-<hex>`), and
// only two KNOWN, EQUAL ids make the pair one session.

test('the same local process loading twice is a duplicate', async () => {
  const ana = someone();
  const first = await checkAndMarkSessionLoad(ana, 'proj-same-process', 'claude_code', { sessionId: 'agent-1a-aaaaaa' });
  assert.equal(first.duplicate, false);
  const again = await checkAndMarkSessionLoad(ana, 'proj-same-process', 'claude_code', { sessionId: 'agent-1a-aaaaaa' });
  assert.equal(again.duplicate, true, 'the same process was handed the brief twice and booked two sessions');
  assert.equal(again.otherSurface, null, 'it is not "your other DeerDawn connection"');
});

test('another process of the same tool, or another local tool, is never the same process', async () => {
  const ana = someone();
  await checkAndMarkSessionLoad(ana, 'proj-other-process', 'claude_code', { sessionId: 'agent-1a-aaaaaa' });
  const secondTerminal = await checkAndMarkSessionLoad(ana, 'proj-other-process', 'claude_code', { sessionId: 'agent-2b-bbbbbb' });
  assert.equal(secondTerminal.duplicate, false);
  const cursor = await checkAndMarkSessionLoad(ana, 'proj-other-process', 'cursor', { sessionId: 'agent-3c-cccccc' });
  assert.equal(cursor.duplicate, false);
});

test('an unknown process id on either side is not the same process', async () => {
  for (const [first, second] of [['agent-1a-aaaaaa', undefined], [undefined, 'agent-1a-aaaaaa'], [undefined, undefined], ['', ''], [null, null]]) {
    const ana = someone();
    await checkAndMarkSessionLoad(ana, 'proj-unknown-process', 'claude_code', first === undefined ? undefined : { sessionId: first });
    const next = await checkAndMarkSessionLoad(ana, 'proj-unknown-process', 'claude_code', second === undefined ? undefined : { sessionId: second });
    assert.equal(next.duplicate, false, `${JSON.stringify(first)} then ${JSON.stringify(second)} withheld a brief`);
  }
});

test('a hosted load stays a duplicate whatever the process ids say', async () => {
  const ana = someone();
  await checkAndMarkSessionLoad(ana, 'proj-hosted-ids', 'claude_web', { sessionId: 'hosted-1' });
  const local = await checkAndMarkSessionLoad(ana, 'proj-hosted-ids', 'claude_code', { sessionId: 'agent-1a-aaaaaa' });
  assert.equal(local.duplicate, true);
  assert.equal(local.otherSurface, 'claude_web');
});
