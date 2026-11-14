'use strict';

// A TASK THAT LANDED MASKED LANDED.
//
// updateProjectContext redacts a patch BEFORE it merges (store.redactForStorage),
// so a task naming a key is stored with [REDACTED] in its place. The hosted
// manage_memory update verified its write by comparing the stored task with the
// RAW words, saw a difference, and answered "Current task NOT changed" over a
// write that had happened. The model then retries the same words, which land
// masked again — a retry loop with no exit. The local dispatcher already says
// "written, with sensitive text redacted"; this pins the hosted one to the same,
// on both branches (task alone, and task with a summary), and pins that the
// reply never echoes the secret.
//
// Drives the real dispatcher with the service layer stubbed; the stub masks the
// patch exactly as the service does, with the store's own redactor.

process.env.NODE_ENV = 'test';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const service = require('../../src/services/contextSyncService');
const { redactForStorage } = require('../../src/store/contextSyncStore');

let stored = {};
service.resolveActiveProject = async () => ({ project_id: 'proj-1', project_name: 'Aurora' });
const maskingPatch = async (actor, projectId, patch) => {
  stored = { ...stored, ...redactForStorage({ ...patch }) };
  return { project_id: projectId, project_name: 'Aurora', context: { ...stored } };
};
service.updateProjectContext = maskingPatch;
service.getProject = async (actor, projectId) => ({ project_id: projectId, project_name: 'Aurora', context: { ...stored } });
service.recordExplicitUpdate = async (actor, input) => ({
  project: { project_id: input.project_id, project_name: 'Aurora', context: { ...stored } },
  stored: true,
  redacted: false,
});

const { dispatchTool } = require('../../src/routes/mcp');

const ACTOR = { type: 'user', id: 'user-1', org_id: 'org-1', scopes: ['context:read', 'context:write'] };
const textOf = (result) => result.content.map((c) => c.text).join('\n');
const KEY = 'gh' + 'p_' + 'Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78';
const TASK = `Rotate the leaked token ${KEY} today`;
const MASKED = 'Rotate the leaked token [REDACTED] today';

beforeEach(() => {
  stored = { current_task: 'Ship the teams invite flow' };
  service.updateProjectContext = maskingPatch;
});

test('task alone: a task stored masked is reported written-with-redaction, not NOT changed', async () => {
  const result = await dispatchTool('manage_memory', { action: 'update', project_id: 'proj-1', task: TASK }, ACTOR, 'claude_web');
  const text = textOf(result);
  assert.equal(stored.current_task, MASKED, 'the write landed, masked');
  assert.doesNotMatch(text, /NOT changed/, text);
  assert.match(text, /written, with sensitive text redacted/, text);
  assert.ok(text.includes(MASKED), text);
  assert.ok(!JSON.stringify(result).includes(KEY.slice(4)), 'the reply must not echo the key');
});

test('task with a summary: the same', async () => {
  const result = await dispatchTool('manage_memory', {
    action: 'update',
    project_id: 'proj-1',
    task: TASK,
    summary: 'Decision: rotate every credential that appeared in a transcript.',
  }, ACTOR, 'claude_web');
  const text = textOf(result);
  assert.doesNotMatch(text, /NOT changed/, text);
  assert.match(text, /written, with sensitive text redacted/, text);
  assert.ok(!JSON.stringify(result).includes(KEY.slice(4)), 'the reply must not echo the key');
});

test('a clean task still reads "set", and a task that did not land still reads NOT changed', async () => {
  const clean = textOf(await dispatchTool('manage_memory', { action: 'update', project_id: 'proj-1', task: 'Ship the importer' }, ACTOR, 'claude_web'));
  assert.match(clean, /Current task set for "Aurora": "Ship the importer"/, clean);
  service.updateProjectContext = async (actor, projectId) => ({ project_id: projectId, project_name: 'Aurora', context: { ...stored } });
  const dropped = textOf(await dispatchTool('manage_memory', { action: 'update', project_id: 'proj-1', task: TASK }, ACTOR, 'claude_web'));
  assert.match(dropped, /NOT changed/, 'a masked task that did NOT land must not be read as written');
  assert.ok(!dropped.includes(KEY.slice(4)), dropped);
});
