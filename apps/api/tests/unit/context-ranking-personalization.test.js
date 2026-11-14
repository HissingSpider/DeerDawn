/**
 * Compounding intelligence — expertise-match personalization in ranking.
 *
 * The learned you_profile (expertise_areas) biases what gets surfaced toward what
 * the user actually works on. As the profile accumulates, the feed personalizes —
 * value that can't travel with an exported context file.
 *
 * Pure-function test (rankWorkspaceNodes) — no DB/Redis required.
 *
 * Run: node tests/unit/context-ranking-personalization.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../../src/services/contextSyncService');
const { closeRedisConnections } = require('../../src/config/redis');

function node(id, title) {
  return {
    node_id: id,
    node_type: 'knowledge',
    canonical_key: `knowledge:${id}`,
    title,
    summary: '',
    confidence: 0.8,
    project_id: null,
    metadata: { memory_tier: 'durable' },
  };
}

const RUST = node('rust', 'Rust async runtime tuning for the worker pool');
const CSS = node('css', 'CSS grid layout notes for the marketing site');

test('without a learned profile, neither node is preferred (stable input order)', () => {
  const ranked = service.rankWorkspaceNodes([CSS, RUST], {});
  assert.equal(ranked[0].node_id, 'css', 'no expertise signal → input order preserved');
});

test('expertise_areas bias ranking toward matching nodes', () => {
  const ranked = service.rankWorkspaceNodes([CSS, RUST], { expertiseAreas: ['Rust'] });
  const rustRank = ranked.findIndex((n) => n.node_id === 'rust');
  const cssRank = ranked.findIndex((n) => n.node_id === 'css');
  assert.ok(rustRank < cssRank, 'a Rust-matching node should outrank an unrelated one for a Rust expert');
});

test('expertise boost is bounded — it does not override active-project relevance', () => {
  // A cross-project node matching expertise must not leapfrog an active-project node.
  const activeNode = { ...node('active', 'CSS grid layout notes'), project_id: 'P1' };
  const crossExpertNode = { ...node('cross', 'Rust async runtime tuning'), project_id: 'P2' };
  const ranked = service.rankWorkspaceNodes([crossExpertNode, activeNode], {
    projectId: 'P1',
    expertiseAreas: ['Rust'],
  });
  assert.equal(ranked[0].node_id, 'active', 'active-project relevance still dominates the expertise nudge');
});

test.after(async () => {
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});
