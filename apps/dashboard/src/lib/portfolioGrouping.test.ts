/**
 * The Portfolio split, run against the shape of a real account.
 *
 * The bug being pinned is an ordering one, and it is invisible per-row: every
 * row rendered correctly, the list sorted correctly by project count, and the
 * page was still useless — because sorting by count guarantees that "TypeScript,
 * 9 projects" outranks "Day-2 activation is upstream of every acquisition
 * question, workspace-wide" every single time. So the assertions here are about
 * WHICH GROUP a row lands in and WHAT ORDER the groups appear in, not about
 * formatting.
 *
 * Run: `tsx --test src/lib/portfolioGrouping.test.ts`
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { PortfolioEntity } from '@/lib/api';
import {
  INSIGHT_TYPES,
  isInsight,
  portfolioLead,
  reachLabel,
  splitEntities,
  stackShare,
} from '@/lib/portfolioGrouping';

function entity(over: Partial<PortfolioEntity>): PortfolioEntity {
  return {
    node_id: over.node_id || 'n1',
    title: over.title || 'Thing',
    summary: over.summary || '',
    entity_type: over.entity_type || 'service',
    node_type: over.node_type || 'entity',
    shared_reason: over.shared_reason || 'cross_project',
    project_count: over.project_count ?? 2,
    projects: over.projects || [],
    updated_at: over.updated_at || '2026-08-29T00:00:00.000Z',
  };
}

// ── The split ────────────────────────────────────────────────────────────────

test('tools and judgements land in different groups', () => {
  const rows = [
    entity({ node_id: 'ts', title: 'TypeScript', entity_type: 'service', project_count: 9 }),
    entity({
      node_id: 'k1',
      title: 'Day-2 activation is upstream of every acquisition question',
      entity_type: 'knowledge',
      shared_reason: 'workspace_scope',
      project_count: 0,
    }),
    entity({ node_id: 'f1', title: 'index.tsx', entity_type: 'file', project_count: 2 }),
    entity({ node_id: 'd1', title: 'Entitlements gate reads, never writes', entity_type: 'decision' }),
  ];

  const { insights, stack } = splitEntities(rows);

  assert.deepEqual(insights.map((e) => e.node_id), ['k1', 'd1']);
  assert.deepEqual(stack.map((e) => e.node_id), ['ts', 'f1']);
});

test('the split preserves the server order inside each group', () => {
  // The server sorts by project count. That order is right for the bar chart
  // and harmless for insight; re-sorting here would fight it for no reason.
  const rows = [
    entity({ node_id: 'a', entity_type: 'service', project_count: 9 }),
    entity({ node_id: 'b', entity_type: 'service', project_count: 6 }),
    entity({ node_id: 'c', entity_type: 'service', project_count: 2 }),
  ];
  assert.deepEqual(splitEntities(rows).stack.map((e) => e.node_id), ['a', 'b', 'c']);
});

test('every row lands in exactly one group — nothing is dropped', () => {
  // A split that silently loses rows would look like a tidier page and be a
  // data-loss bug. Assert the partition is total.
  const rows = ['service', 'knowledge', 'file', 'decision', 'environment', 'weird_new_type'].map(
    (entity_type, i) => entity({ node_id: `n${i}`, entity_type }),
  );
  const { insights, stack } = splitEntities(rows);
  assert.equal(insights.length + stack.length, rows.length);
});

test('an unrecognised type falls to stack, not insight', () => {
  // Insight is the section that leads the page, so the default must be the
  // quiet one. A new extractor type appearing at the top of Portfolio unbidden
  // is the failure this guards.
  assert.equal(isInsight(entity({ entity_type: 'some_future_type' })), false);
  assert.equal(isInsight(entity({ entity_type: '' })), false);
});

test('type matching is case-insensitive', () => {
  assert.equal(isInsight(entity({ entity_type: 'Decision' })), true);
  assert.equal(isInsight(entity({ entity_type: 'KNOWLEDGE' })), true);
});

test('environment is stack, not insight', () => {
  // "DeerDawn API — Fly.io" is where something runs. The test is whether the
  // row survives a rewrite in another language; a decision does, a runtime
  // does not.
  assert.equal(INSIGHT_TYPES.has('environment'), false);
});

// ── The bar ──────────────────────────────────────────────────────────────────

test('bar length is a share of all projects, not of the biggest bar', () => {
  // Scaling to the largest would stretch the top row to full width and imply it
  // is everywhere, which at 9 of 18 is exactly half true.
  assert.equal(stackShare(9, 18), 0.5);
  assert.equal(stackShare(18, 18), 1);
});

test('a real single-project row is still visible', () => {
  const share = stackShare(1, 40);
  assert.ok(share >= 0.04, 'a 1-of-40 bar must not render as an invisible sliver');
});

test('nothing overflows the track, and absent data draws no bar', () => {
  assert.equal(stackShare(30, 18), 1, 'bad data must clamp, not overflow');
  assert.equal(stackShare(0, 18), 0);
  assert.equal(stackShare(3, 0), 0, 'no projects means no denominator, so no bar');
  assert.equal(stackShare(NaN, 18), 0);
});

// ── Reach ────────────────────────────────────────────────────────────────────

test('a workspace-scoped row states its reach instead of showing a dash', () => {
  // THE BUG: `project_count || '—'` printed an em dash for exactly the rows
  // that matter most. A dash reads as missing data; these rows are not missing
  // a number, they apply everywhere — which is MORE reach than "3 projects".
  assert.equal(
    reachLabel(entity({ shared_reason: 'workspace_scope', project_count: 0 })),
    'Workspace-wide',
  );
  assert.equal(reachLabel(entity({ shared_reason: 'cross_project', project_count: 0 })), 'Workspace-wide');
});

test('reach pluralises', () => {
  assert.equal(reachLabel(entity({ project_count: 1 })), '1 project');
  assert.equal(reachLabel(entity({ project_count: 4 })), '4 projects');
});

// ── The lead sentence ────────────────────────────────────────────────────────

test('the lead counts the reader’s work, not our data model', () => {
  const line = portfolioLead(11, 35, 18);
  assert.match(line, /11 things you've decided or learned apply beyond one project/);
  assert.match(line, /35 tools repeat across them/);
  assert.ok(!/entit/i.test(line), 'never says "entities" — that is our word, not theirs');
});

test('the lead never renders a group the reader does not have', () => {
  assert.equal(
    portfolioLead(3, 0, 5),
    "3 things you've decided or learned apply beyond one project.",
  );
  assert.equal(portfolioLead(0, 2, 5), '2 tools repeat across them.');
});

test('singulars read as English', () => {
  const line = portfolioLead(1, 1, 3);
  assert.match(line, /1 thing you've decided or learned applies beyond one project/);
  assert.match(line, /1 tool repeats across them/);
});

test('a one-project account is pointed at its next step, not at an empty list', () => {
  // Cross-project is meaningless at one project, and this is the exact account
  // the project-cap removal exists to unblock.
  const line = portfolioLead(0, 0, 1);
  assert.match(line, /second project/);
  assert.ok(!/Nothing yet spans/.test(line));
});

test('a multi-project account with nothing shared is told so in its own numbers', () => {
  assert.equal(portfolioLead(0, 0, 6), 'Nothing yet spans two of your 6 projects.');
});
