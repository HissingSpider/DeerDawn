/**
 * Context quality gates — write-time confidence floor + staleness enforcement.
 *
 * These guard the "pay-twice" failure mode where month 2 is worse than month 1:
 *   - sanitizeExtraction drops low-confidence deltas before they pollute the vault.
 *   - classifyStaleness escalates old context from a passive note to enforcement.
 *
 * Pure-function tests — no DB/Redis required.
 *
 * Run: node tests/unit/context-quality-gates.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../../src/services/contextSyncService');
const { closeRedisConnections } = require('../../src/config/redis');

const { sanitizeExtraction, classifyStaleness } = service;

const DAY = 24 * 60 * 60 * 1000;

test('write confidence floor drops low-confidence deltas before they land', () => {
  const project = { context: {} };
  const result = sanitizeExtraction(project, {
    confidence: 0.4,
    delta: {
      current_status: 'A plausible-sounding but low-confidence status update.',
      tech_stack: ['Rust'],
      recent_decisions: [{ summary: 'Switched the queue to NATS for backpressure', decided_at: '2026-06-01T00:00:00.000Z' }],
    },
  });

  assert.deepEqual(result.delta, {}, 'low-confidence delta must be dropped entirely');
  assert.equal(result.no_material_change, true);
  assert.equal(result.suppression_reason, 'low_confidence');
});

test('high-confidence, substantive delta passes the floor', () => {
  const project = { context: {} };
  const result = sanitizeExtraction(project, {
    confidence: 0.9,
    delta: { current_status: 'Privacy posture locked for the V1 extraction path.' },
  });

  assert.equal(result.delta.current_status, 'Privacy posture locked for the V1 extraction path.');
  assert.notEqual(result.no_material_change, true);
});

test('floor does not override existing noise filters (vague decisions still dropped)', () => {
  const project = { context: {} };
  const result = sanitizeExtraction(project, {
    confidence: 0.9,
    delta: { recent_decisions: [{ summary: 'various improvements', decided_at: '2026-06-01T00:00:00.000Z' }] },
  });

  assert.equal(result.delta.recent_decisions, undefined, 'vague decision must still be filtered even above the floor');
});

test('classifyStaleness tiers fresh / soft / hard / unknown', () => {
  const now = Date.parse('2026-06-08T00:00:00.000Z');

  assert.equal(classifyStaleness(new Date(now - 1 * DAY).toISOString(), now).tier, 'fresh');
  assert.equal(classifyStaleness(new Date(now - 4 * DAY).toISOString(), now).tier, 'soft');   // > 3d default
  assert.equal(classifyStaleness(new Date(now - 12 * DAY).toISOString(), now).tier, 'hard');  // > 9d default
  assert.equal(classifyStaleness(null, now).tier, 'unknown');
});

test.after(async () => {
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});
