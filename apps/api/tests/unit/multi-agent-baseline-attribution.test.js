/**
 * Baseline attribution — which session ids can be counted, and which cannot.
 *
 * The first production run of multi-agent-baseline.js reported 54.8% contention
 * and 100% attribution. Both were wrong in the same way: contention is measured
 * as COUNT(DISTINCT source_session_id) > 1 inside a window, and nearly all that
 * data was written by `mcp-${Date.now()}` — a NEW id on every write. One agent
 * writing twice looked like two agents colliding, and the coverage check said
 * "100% attributed" because it only tested for a non-empty string.
 *
 * So this guards the classification the corrected metric depends on. It is a
 * cheap test protecting an expensive mistake: a metric that reads confidently
 * and wrongly is worse than one that reads zero, because nobody goes looking.
 *
 * Pure (no DB). Run: node tests/unit/multi-agent-baseline-attribution.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isSyntheticSessionId,
  SYNTHETIC_SESSION_ID_PATTERN,
  SYNTHETIC_SESSION_ID_RE,
} = require('../../scripts/multi-agent-baseline.js');

// Every per-write id source found in the codebase. When a new write path is
// added, it belongs here AND in the script's SQL predicate — an unlisted
// synthetic id does not fail loudly, it silently inflates the contention rate.
const PER_WRITE_IDS = [
  ['mcp-1787195137123', 'client.ts pushContextUpdate, pre-1.0.42'],
  ['mcp-remote-1787195137123', 'apps/api/src/routes/mcp.js hosted connector'],
  ['flush-1787195137123', 'flush-session.ts fallback'],
  ['codex-1787195137123', 'flush-session.ts codex path'],
  ['seed-1787195137123-a1b2c3', 'context-sync.js seed path'],
];

for (const [id, source] of PER_WRITE_IDS) {
  test(`per-write id is excluded: ${id} (${source})`, () => {
    assert.equal(isSyntheticSessionId(id), true);
  });
}

test('a stable agent id counts', () => {
  // The format minted by agent-session.ts — one per process, not per write.
  assert.equal(isSyntheticSessionId('agent-5xo-0afa26'), false);
});

test('a web session id counts', () => {
  // Browser surfaces send their own id, stable for the conversation. Excluding
  // these would drop genuine web-vs-editor contention, which is a real case.
  assert.equal(isSyntheticSessionId('sess_01ABCDEF'), false);
  assert.equal(isSyntheticSessionId('conv-abc-123'), false);
});

test('a prefixed id that is NOT timestamped is not swept up', () => {
  // The pattern keys on the trailing timestamp, not the prefix alone, so an id
  // that merely starts with "mcp-" keeps counting. Over-matching here would
  // silently shrink the sample and under-report contention.
  assert.equal(isSyntheticSessionId('mcp-server-main'), false);
  assert.equal(isSyntheticSessionId('codex-workspace-a'), false);
});

test('short digit runs are not treated as timestamps', () => {
  assert.equal(isSyntheticSessionId('mcp-42'), false);
});

test('empty and missing ids are not counted as synthetic', () => {
  // They are excluded separately by the `<> ''` guard; double-counting them
  // here would confuse the two exclusion reasons in the reported numbers.
  assert.equal(isSyntheticSessionId(''), false);
  assert.equal(isSyntheticSessionId(null), false);
  assert.equal(isSyntheticSessionId(undefined), false);
});

test('the SQL predicate and the JS check come from one pattern', () => {
  // Postgres gets this string interpolated into `!~ '...'` and the RegExp is
  // built from the same constant. Asserting they are the same source is what
  // stops the tests passing while production measures something else.
  assert.equal(SYNTHETIC_SESSION_ID_RE.source, SYNTHETIC_SESSION_ID_PATTERN);
  assert.equal(SYNTHETIC_SESSION_ID_PATTERN, '^(mcp-remote|mcp|flush|codex|seed)-[0-9]{10,}');
});
