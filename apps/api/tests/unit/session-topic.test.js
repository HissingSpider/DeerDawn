/**
 * Session-topic binding (P3) — the confirm chip's server side.
 *
 * bindSessionTopic creates a topic on demand, records the chat URL for
 * deterministic same-chat re-matching, and marks the session confidently matched.
 * getSessionTopic returns the bound topic + a fresh brief to inject and the user's
 * topics as switch candidates. This guards that whole loop end to end.
 *
 * DB-backed; run via scripts/run-db-test.sh node tests/unit/session-topic.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const { closeRedisConnections } = require('../../src/config/redis');

const actor = () => ({ org_id: 'org-system', id: 'system-key' });

test('binding a new topic creates it, records the chat, and serves a brief', async () => {
  await store.clearAll();
  const sessionId = 'web-/c/shasta-on-claude';
  const convRef = 'https://claude.ai/chat/shasta-1';

  const bound = await service.bindSessionTopic(actor(), {
    session_id: sessionId,
    new_topic_name: 'Mount Shasta climb',
    conversation_ref: convRef,
    host: 'claude.ai',
    tool: 'claude_web',
  });
  assert.ok(bound.project_id, 'returns the created topic id');
  assert.equal(bound.project_name, 'Mount Shasta climb');

  // The project is a topic and carries the conversation URL for future matching.
  const project = await service.getProject(actor(), bound.project_id);
  assert.equal(project.context.category, 'topic', 'created as a topic, not a coding project');
  assert.ok((project.linked_conversations || []).includes(convRef), 'chat URL recorded for same-chat re-match');

  // getSessionTopic reflects the binding and serves an injectable brief.
  const view = await service.getSessionTopic(actor(), { session_id: sessionId, tool: 'claude_web' }, { tz: 'America/Los_Angeles' });
  assert.equal(view.active_topic?.project_id, bound.project_id, 'active topic is the bound one');
  assert.ok(view.candidates.some((c) => c.project_id === bound.project_id), 'topic appears in switch candidates');
  assert.ok(view.brief, 'a brief is returned for injection');
  assert.match(view.brief, /Now: /, 'brief carries the current time (P1)');
});

test('an unbound session returns candidates but no active topic or brief', async () => {
  await store.clearAll();
  await service.bindSessionTopic(actor(), { session_id: 'web-/c/a', new_topic_name: 'Kitchen renovation', tool: 'claude_web' });

  const view = await service.getSessionTopic(actor(), { session_id: 'web-/c/never-bound', tool: 'chatgpt_web' }, {});
  assert.equal(view.active_topic, null, 'no topic bound to this fresh session');
  assert.equal(view.brief, null, 'nothing to inject yet');
  assert.ok(view.candidates.some((c) => c.project_name === 'Kitchen renovation'), 'still offers existing topics to pick');
});

test('binding to an existing project switches the session without duplicating', async () => {
  await store.clearAll();
  const first = await service.bindSessionTopic(actor(), { session_id: 'web-/c/x', new_topic_name: 'Move to Denver', tool: 'claude_web' });
  // A second session binds to the SAME project by id (the chip's "switch" action).
  const bound = await service.bindSessionTopic(actor(), { session_id: 'web-/c/y', project_id: first.project_id, tool: 'chatgpt_web' });
  assert.equal(bound.project_id, first.project_id, 'reused the existing topic, no new project');

  const all = (await service.listProjects(actor())).filter((p) => p.context?.category === 'topic');
  assert.equal(all.length, 1, 'exactly one topic exists');
});

test.after(async () => {
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});
