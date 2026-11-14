/**
 * Multi-tool dependency (moat 3) — tool presence + cross-tool handoff.
 *
 * As a project is touched from more tools, DeerDawn's toolchain coverage
 * accumulates and the brief surfaces it ("Synced across N tools"), and the
 * resume cursor (next_action) is carried across tools. Leaving means
 * re-establishing context in every tool by hand.
 *
 * DB-backed; run via scripts/run-db-test.sh node tests/unit/context-multitool.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const { closeRedisConnections } = require('../../src/config/redis');

function actor() {
  return { org_id: 'org-system', id: 'system-key' };
}

function extraction(projectId, delta) {
  return {
    match_decision: 'matched_existing',
    confidence: 0.95,
    project_candidate: { project_id: projectId, project_name: 'Polyglot', reason: 'same repo' },
    delta,
    should_create_project: false,
    needs_user_confirmation: false,
  };
}

test('tool presence accumulates across tools and surfaces in the cross-tool handoff', async () => {
  await store.clearAll();
  const project = await service.createProject(actor(), {
    project_name: 'Polyglot', description: 'Cross-tool project', goals: [], current_status: '',
  });

  await service.applyExtraction(actor(), {
    session_id: 'sess-claude',
    tool: 'claude_code',
    session_context: { cwd: '/repo', host: 'laptop', status: 'active' },
    chunks: [{ role: 'assistant', text: 'We wired the auth flow in the API layer.' }],
    extraction: extraction(project.project_id, {
      current_status: 'Auth flow wired in the API layer.',
      next_action: 'Add the refresh-token rotation test',
    }),
  });

  await service.applyExtraction(actor(), {
    session_id: 'sess-cursor',
    tool: 'cursor',
    session_context: { cwd: '/repo', host: 'laptop', status: 'active' },
    chunks: [{ role: 'assistant', text: 'Refactored the session store to use Redis for the TTL.' }],
    extraction: extraction(project.project_id, { current_status: 'Session store moved to Redis TTL.' }),
  });

  const saved = await service.getProject(actor(), project.project_id);
  assert.ok(saved.context.tool_presence.claude_code, 'claude_code presence recorded');
  assert.ok(saved.context.tool_presence.cursor, 'cursor presence recorded');
  assert.equal(saved.context.last_active_tool, 'cursor', 'cursor wrote last');

  // Entering a THIRD tool: handoff names the last tool, carries the resume cursor,
  // and shows the full toolchain coverage.
  const inj = await service.renderInjection(actor(), project.project_id, 'codex', 'standard');
  assert.match(inj.body, /Resuming from cursor/, 'handoff from the last-active tool');
  assert.match(inj.body, /Next action: Add the refresh-token rotation test/, 'resume cursor carried across tools');
  // Said once: the brief's own "Next action:" line carries it, so the handoff
  // line does not repeat it (the receipt above the brief is the other mention).
  assert.match(inj.body, /^Resuming from cursor on laptop\.$/m, 'the handoff line has no second copy of the next step');
  assert.equal(inj.body.match(/Add the refresh-token rotation test/g).length, 1, 'the next step appears once in the body');
  assert.match(inj.receipt, /Next: Add the refresh-token rotation test$/, 'the receipt carries it too');
  // The hosted chat-shaped brief: the same, once in the body.
  const chat = await service.renderInjection(actor(), project.project_id, 'chatgpt_web', 'standard');
  assert.match(chat.body, /Next action: Add the refresh-token rotation test/);
  assert.equal(chat.body.match(/Add the refresh-token rotation test/g).length, 1, 'chat brief: the next step once');
  assert.match(inj.body, /Synced across 2 tools/, 'toolchain coverage surfaced');
});

test('a single-tool project shows no multi-tool line', async () => {
  await store.clearAll();
  const project = await service.createProject(actor(), {
    project_name: 'SoloTool', description: 'one tool only', goals: [], current_status: '',
  });
  await service.applyExtraction(actor(), {
    session_id: 'sess-solo',
    tool: 'claude_code',
    session_context: { cwd: '/repo', host: 'laptop', status: 'active' },
    chunks: [{ role: 'assistant', text: 'Initial setup of the build pipeline is complete.' }],
    extraction: extraction(project.project_id, { current_status: 'Build pipeline set up.' }),
  });
  const inj = await service.renderInjection(actor(), project.project_id, 'claude_code', 'standard');
  assert.doesNotMatch(inj.body, /Synced across/, 'no multi-tool line for a single-tool project');
});

test.after(async () => {
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});
