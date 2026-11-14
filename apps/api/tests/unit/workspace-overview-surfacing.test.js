/**
 * Workspace overview — affinity + contributors must reach the TEXT body.
 *
 * Regression guard for a write-only bug: getWorkspaceOverview computed
 * related_projects (cross-project affinity) and contributors (team attribution)
 * but rendered `text` from the schema-parsed object, which dropped both — so the
 * learned affinity and the social switching cost were invisible to MCP clients,
 * which mostly read the text body. This asserts the formatter both ACCEPTS and
 * RENDERS those fields. Pure (no DB).
 *
 * Run: node tests/unit/workspace-overview-surfacing.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatWorkspaceOverview,
  WorkspaceOverviewResultSchema,
} = require('../../../../packages/shared-context/src/index.js');

test('schema retains related_projects and contributors instead of stripping them', () => {
  const parsed = WorkspaceOverviewResultSchema.parse({
    related_projects: [{ project_id: 'p1', project_name: 'Billing', co_occurrence_count: 4 }],
    contributors: [{ user_id: 'user_abc', contributions: 7, last_at: null }],
  });
  assert.equal(parsed.related_projects.length, 1, 'related_projects survives parse');
  assert.equal(parsed.related_projects[0].project_name, 'Billing');
  assert.equal(parsed.contributors.length, 1, 'contributors survives parse');
  assert.equal(parsed.contributors[0].user_id, 'user_abc');
});

test('formatter renders affinity + contributors into the text body', () => {
  const text = formatWorkspaceOverview({
    mode: 'overview',
    summary: { now: ['Active'], recent: [] },
    related_projects: [{ project_id: 'p1', project_name: 'Billing service', co_occurrence_count: 4 }],
    contributors: [
      { user_id: 'user_abc', contributions: 7 },
      { user_id: 'user_xyz', contributions: 1 },
    ],
  }, 'standard');

  assert.match(text, /Projects you work alongside/, 'affinity heading present');
  assert.match(text, /Billing service \(co-occurs 4×\)/, 'related project + count rendered');
  assert.match(text, /Contributors/, 'contributors heading present');
  assert.match(text, /user_abc — 7 contributions/, 'plural contributions');
  assert.match(text, /user_xyz — 1 contribution\b/, 'singular contribution');
});

test('empty affinity/contributors render no headings (no noise)', () => {
  const text = formatWorkspaceOverview({
    mode: 'overview',
    summary: { now: ['Active'], recent: [] },
  }, 'standard');
  assert.doesNotMatch(text, /Projects you work alongside/);
  assert.doesNotMatch(text, /Contributors/);
});
