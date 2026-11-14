'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { formatSectionInjection } = require('../src/index.js');

/**
 * THREE OF TWENTY READ EXACTLY LIKE THREE OF THREE.
 *
 * `recall` with sections ["decisions"] renders the three highest-ranked
 * decisions and stopped. Nothing said there were more, so a targeted read of
 * this section was indistinguishable from a project that had only ever decided
 * three things — and a caller with no reason to look further does not look
 * further, which is the whole risk of a bounded read that will not name its
 * bound. Every other bounded surface in this file already says "+N more".
 */

const decisions = (count) => Array.from({ length: count }, (_, i) => ({
  summary: `Decision number ${i + 1}: settle the ${String.fromCharCode(97 + i)} question`,
  decided_at: new Date(Date.parse('2026-09-01T00:00:00.000Z') + i * 3600e3).toISOString(),
}));

const render = (ctx) => formatSectionInjection(ctx, ['decisions']);

test('a section holding back decisions says how many', () => {
  const body = render({ recent_decisions: decisions(20) });
  assert.match(body, /…\+17 more decisions/, 'THE BUG: seventeen decisions went unmentioned');
  assert.match(body, /recall with action "search"/, 'and the caller is told how to reach them');
});

test('the singular is a real case and reads like one', () => {
  const body = render({ recent_decisions: decisions(4) });
  assert.match(body, /…\+1 more decision:/);
  assert.doesNotMatch(body, /1 more decisions/);
});

test('nothing held back, nothing said', () => {
  const body = render({ recent_decisions: decisions(3) });
  assert.match(body, /Decisions:/);
  assert.doesNotMatch(body, /more decision/);
});

test('resolved decisions are not counted as held back', () => {
  // They are filtered out of the rendering, so counting them would promise
  // entries no further read would ever return.
  const rows = decisions(5).map((d, i) => (i < 2 ? { ...d, resolved: true } : d));
  const body = render({ recent_decisions: rows });
  assert.doesNotMatch(body, /more decision/, 'three unresolved decisions is all there is');
});

test('a project with no decisions still renders no section', () => {
  assert.doesNotMatch(render({ recent_decisions: [] }), /Decisions:/);
});
