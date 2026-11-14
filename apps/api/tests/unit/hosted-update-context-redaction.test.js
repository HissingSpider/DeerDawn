'use strict';

/**
 * The hosted reply has to account for the words the server changed.
 *
 * recordExplicitUpdate stores a summary through cleanSyncedText, so one naming
 * a key or carrying an override phrase lands REWRITTEN. The read-back used to
 * compare the raw sentence and answer "Context NOT updated ... Retry", which
 * was false and expensive: the retry stored another redacted copy. Now it
 * answers stored, and has to say why the caller will read [REDACTED] later.
 *
 * Said in the TEXT only. update_context's structuredContent is held to its
 * declared output schema, which is frozen for the ChatGPT review.
 *
 * Drives the real dispatch with the service layer stubbed; no database.
 */

process.env.NODE_ENV = 'test';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const service = require('../../src/services/contextSyncService');

let outcome = null;
service.recordExplicitUpdate = async () => outcome;

const { dispatchTool } = require('../../src/routes/mcp');

const PROJECT_ID = 'project_11111111-2222-3333-4444-555555555555';
const ACTOR = { type: 'user', id: 'user-1', org_id: 'org-1', scopes: ['context:read', 'context:write'] };
const textOf = (result) => result.content.map((c) => c.text).join('\n');

beforeEach(() => {
  outcome = {
    project: { project_id: PROJECT_ID, project_name: 'Atlas', context: { last_updated: '2026-09-20T10:00:00.000Z' } },
    stored: true,
    reason: null,
    redacted: false,
  };
});

test('a redacted summary is reported stored, and the reply says it was redacted', async () => {
  outcome.redacted = true;
  const result = await dispatchTool('update_context', {
    project_id: PROJECT_ID,
    summary: 'Decided to keep api_key: dd_live_abcdefghijklmnop in .env.local',
  }, ACTOR, 'claude_web');
  const text = textOf(result);
  assert.match(text, /Context updated/);
  assert.match(text, /redacted before it was stored/);
  assert.doesNotMatch(text, /Retry/);
  assert.equal(result.structuredContent.stored, true);
  assert.equal(result.structuredContent.redacted, undefined, 'the output schema is frozen; this belongs in the text');
});

test('an untouched summary says nothing about redaction', async () => {
  const result = await dispatchTool('update_context', { project_id: PROJECT_ID, summary: 'Decided to use advisory locks' }, ACTOR, 'claude_web');
  const text = textOf(result);
  assert.match(text, /Context updated/);
  assert.doesNotMatch(text, /redacted/);
});

test('a write that genuinely did not land still says so', async () => {
  outcome.stored = false;
  outcome.reason = 'not_found_on_read_back';
  const result = await dispatchTool('update_context', { project_id: PROJECT_ID, summary: 'Decided to use advisory locks' }, ACTOR, 'claude_web');
  assert.match(textOf(result), /Context NOT updated/);
});
