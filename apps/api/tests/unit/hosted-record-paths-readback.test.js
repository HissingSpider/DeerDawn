'use strict';

// "Recorded 1 hot path" OVER A PROJECT THAT STORED NOTHING.
//
// hot_paths is capped at 40. The hosted record_paths reply counted the ARGUMENT
// — items.length — so a project already holding 40 paths answered "Recorded 1
// hot path" to a path it had dropped, and `recall paths` could not find it
// afterwards. Nothing in the loop could tell the agent its note had not landed.
//
// The cap itself is fixed in packages/shared-context (newest wins ties, see
// tests/hot-path-cap.test.js). This pins the other half: the REPLY is built from
// what the service read back, names what did not fit, and names what was evicted
// to make room. Same family as deerdawn-write-path-bugs-2026-08 — a success
// string written from the request cannot describe what happened.
//
// Drives the real dispatcher with the service layer stubbed.

process.env.NODE_ENV = 'test';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const service = require('../../src/services/contextSyncService');

let recordResult = null;
service.resolveActiveProject = async () => ({ project_id: 'proj-1', project_name: 'Aurora' });
service.getProject = async (actor, projectId) => ({ project_id: projectId, project_name: 'Aurora', context: {} });
service.recordHotPaths = async () => recordResult;

const { dispatchTool } = require('../../src/routes/mcp');

const ACTOR = { type: 'user', id: 'user-1', org_id: 'org-1', scopes: ['context:read', 'context:write'] };
const textOf = (result) => result.content.map((c) => c.text).join('\n');

const record = (items) => dispatchTool('record_hot_paths', { project_id: 'proj-1', items }, ACTOR, 'claude_web');

beforeEach(() => {
  recordResult = null;
});

test('a path that did not fit under the cap is not reported as recorded', async () => {
  recordResult = {
    project_id: 'proj-1',
    project_name: 'Aurora',
    hot_paths: [],
    requested: 1,
    stored: 0,
    not_stored: 1,
    evicted: 0,
  };
  const result = await record([{ label: 'new', path: 'src/new.js' }]);
  const text = textOf(result);

  assert.match(text, /Recorded 0 hot paths/, 'the count comes from the read-back, never from items.length');
  assert.match(text, /could not be stored/, 'the caller has to be told the path is not in the brief');
  assert.strictEqual(result.structuredContent.recorded, 0);
});

test('paths evicted to make room are named', async () => {
  recordResult = {
    project_id: 'proj-1',
    project_name: 'Aurora',
    hot_paths: [],
    requested: 2,
    stored: 2,
    not_stored: 0,
    evicted: 2,
  };
  const text = textOf(await record([
    { label: 'a', path: 'src/a.js' },
    { label: 'b', path: 'src/b.js' },
  ]));

  assert.match(text, /Recorded 2 hot paths/);
  assert.match(text, /2 older paths made room/, 'forgetting an old path is a change the caller should hear about');
});

test('the ordinary case still reads as it did', async () => {
  recordResult = {
    project_id: 'proj-1',
    project_name: 'Aurora',
    hot_paths: [],
    requested: 1,
    stored: 1,
    not_stored: 0,
    evicted: 0,
  };
  const result = await record([{ label: 'a', path: 'src/a.js' }]);
  assert.strictEqual(textOf(result), 'Recorded 1 hot path for Aurora.');
  assert.strictEqual(result.structuredContent.recorded, 1);
});
