'use strict';

// Hosted start_session must deliver the active project's BRIEF — the same
// injection the local server renders from /active — and accept `verbosity`.
//
// It used to answer with the startup workspace overview ("what matters now", a
// few knowledge nodes, recent changes): no decisions, open questions,
// landmines, board or hot paths. And it declared no input properties, so the
// `verbosity` argument the local catalog advertises was rejected outright.
//
// Drives the real dispatch with the service layer stubbed. The session helpers
// are imported by destructuring in mcp.js, so they are stubbed on their module
// objects BEFORE mcp.js is required.

process.env.NODE_ENV = 'test';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const sessionDedup = require('../../src/services/sessionDedup');
const catchupService = require('../../src/services/sessionCatchupService');
const service = require('../../src/services/contextSyncService');

const calls = { renderInjection: [], overview: [], deliveries: [] };
let activeProject = null;
let injectionBody = null;
let injectionReceipt = null;

sessionDedup.checkAndMarkSessionLoad = async () => ({ duplicate: false, secondsAgo: null, otherSurface: null });
catchupService.buildSessionCatchup = async () => ({ text: 'Since last session (yesterday): shipped the thing.' });
catchupService.recordRemoteSessionDelivery = (actor, input) => { calls.deliveries.push(input); };

service.resolveActiveProject = async () => activeProject;
service.renderInjection = async (...args) => {
  calls.renderInjection.push(args);
  return injectionBody === null ? null : { body: injectionBody, ...(injectionReceipt ? { receipt: injectionReceipt } : {}) };
};
let overviewPayload = null;
service.getWorkspaceOverview = async (actor, options) => {
  calls.overview.push(options);
  return overviewPayload;
};
let archivedProjects = [];
service.listArchivedProjectSummaries = async () => archivedProjects;

const { dispatchTool } = require('../../src/routes/mcp');

const ACTOR = { type: 'user', id: 'user-1', org_id: 'org-1', scopes: ['context:read', 'context:write'] };
const textOf = (result) => result.content.map((c) => c.text).join('\n');

beforeEach(() => {
  calls.renderInjection.length = 0;
  calls.overview.length = 0;
  calls.deliveries.length = 0;
  activeProject = { project_id: 'proj-1', project_name: 'Aurora Launch Review' };
  overviewPayload = { mode: 'startup', text: 'What matters now\n- Workspace overview body', projects: [{ project_id: 'p1' }] };
  archivedProjects = [];
  injectionReceipt = null;
  injectionBody = 'Current task: verify the MCP connection\nRecent decisions:\n- One universal endpoint\nOpen questions:\n- Who owns rollout?';
});

test('an active project gets its full brief, led by the catch-up', async () => {
  const result = await dispatchTool('start_session', {}, ACTOR, 'chatgpt_web');
  const text = textOf(result);
  assert.match(text, /^Since last session/, 'the catch-up still leads');
  assert.match(text, /Resuming Aurora Launch Review/);
  assert.match(text, /Recent decisions:/);
  assert.match(text, /Open questions:/);
  assert.doesNotMatch(text, /Workspace overview body/, 'the overview is not the body when a brief exists');
  assert.equal(calls.overview.length, 0);

  assert.equal(calls.renderInjection.length, 1);
  const [, projectId, tool, verbosity, , options] = calls.renderInjection[0];
  assert.equal(projectId, 'proj-1');
  assert.equal(tool, 'chatgpt_web');
  assert.equal(verbosity, 'standard');
  assert.equal(options.record_side_effects, false, 'delivery telemetry is emitted once, by the route');
  assert.equal(calls.deliveries.length, 1);
  assert.equal(calls.deliveries[0].delivered, true);
});

test('verbosity is passed through to the brief', async () => {
  await dispatchTool('start_session', { verbosity: 'light' }, ACTOR, 'claude_web');
  assert.equal(calls.renderInjection[0][2], 'claude_web');
  assert.equal(calls.renderInjection[0][3], 'light');
});

test('no active project falls back to the workspace overview', async () => {
  activeProject = null;
  const text = textOf(await dispatchTool('start_session', {}, ACTOR, 'claude_web'));
  assert.equal(calls.renderInjection.length, 0);
  assert.equal(calls.overview.length, 1);
  assert.match(text, /Workspace overview body/);
});

test('an injection that renders nothing falls back to the overview', async () => {
  injectionBody = null; // e.g. the user paused injection for this surface
  const text = textOf(await dispatchTool('start_session', {}, ACTOR, 'claude_web'));
  assert.equal(calls.overview.length, 1);
  assert.match(text, /Workspace overview body/);
});

// Archiving a project does NOT delete its graph. So for somebody whose projects
// have all aged out, the workspace overview still comes back with knowledge
// nodes in it — and the "is there any context here" test counted those, decided
// the account was not empty, and skipped the archived-projects notice entirely.
// The person was handed a few surviving entities and no way to learn that their
// projects are one restore away, which is the precise failure the notice exists
// to prevent.
test('archived projects are announced even when graph nodes survive them', async () => {
  activeProject = null;
  overviewPayload = {
    mode: 'startup',
    text: 'What matters now\n- A surviving knowledge node',
    projects: [],
    knowledge: [{ node_id: 'n1', title: 'A surviving knowledge node' }],
  };
  archivedProjects = [{ project_id: 'p-old', project_name: 'Aurora', archived_at: '2026-07-01T00:00:00.000Z' }];

  const text = textOf(await dispatchTool('start_session', {}, ACTOR, 'claude_web'));
  assert.match(text, /Aurora/, 'the archived project is named');
  assert.match(text, /archived/i, 'and said to be archived, with the way back');
});

test('a live project is never displaced by the archived notice', async () => {
  archivedProjects = [{ project_id: 'p-old', project_name: 'Aurora', archived_at: '2026-07-01T00:00:00.000Z' }];
  const text = textOf(await dispatchTool('start_session', {}, ACTOR, 'claude_web'));
  assert.match(text, /Resuming Aurora Launch Review/);

  // …nor when the overview itself still lists unarchived projects.
  activeProject = null;
  const overviewText = textOf(await dispatchTool('start_session', {}, ACTOR, 'claude_web'));
  assert.match(overviewText, /Workspace overview body/);
});

// ─── Thing 3b: the receipt line leads every loaded brief ─────────────────────

test('the receipt is the first line, above the catch-up', async () => {
  injectionReceipt = 'DeerDawn loaded Aurora Launch Review: 1 decision, 1 open question, last saved 2 hours ago. Next: ship it';
  const text = textOf(await dispatchTool('start_session', {}, ACTOR, 'chatgpt_web'));
  const lines = text.split('\n');
  assert.equal(lines[0], injectionReceipt);
  assert.match(text, /Since last session/, 'the catch-up still follows');
  assert.ok(text.indexOf('Since last session') > text.indexOf(injectionReceipt));
});

test('no rendered brief, no receipt', async () => {
  injectionBody = null;
  injectionReceipt = 'DeerDawn loaded Aurora Launch Review.';
  const text = textOf(await dispatchTool('start_session', {}, ACTOR, 'claude_web'));
  assert.doesNotMatch(text, /DeerDawn loaded/);
});

// ─── Thing 3d: the brief's shape follows the request's TOOL ──────────────────

const renderedTool = () => calls.renderInjection[0][2];

test('coding clients over HTTP get the coding-shaped brief, named by the handshake', async () => {
  for (const [name, tool] of [['claude-code', 'claude_code'], ['Cursor', 'cursor'], ['codex-mcp-client', 'codex']]) {
    calls.renderInjection.length = 0;
    // The surface for all three is unknown_web: it names only the two web apps.
    await dispatchTool('start_session', {}, ACTOR, 'unknown_web', { clientInfo: { name } });
    assert.equal(renderedTool(), tool, name);
  }
});

test('coding clients are recognised from the OAuth credential on a bare tools/call', async () => {
  const keyActor = {
    type: 'key', id: 'key-1', owner_id: 'user-1', org_id: 'org-1',
    oauth_resource: 'https://api.deerdawn.com/mcp', oauth_client_name: 'Claude Code',
    scopes: ['context:read', 'context:write'],
  };
  await dispatchTool('start_session', {}, keyActor, 'unknown_web');
  assert.equal(renderedTool(), 'claude_code');
});

test('ChatGPT (and Codex inside a ChatGPT install) keep the chat shape', async () => {
  await dispatchTool('start_session', {}, ACTOR, 'chatgpt_web', { clientInfo: { name: 'ChatGPT' } });
  assert.equal(renderedTool(), 'chatgpt_web');
  calls.renderInjection.length = 0;
  // Codex reaching us through a ChatGPT install carries ChatGPT's credential and
  // no client info of its own: indistinguishable from ChatGPT, so chat-shaped.
  await dispatchTool('start_session', {}, ACTOR, 'chatgpt_web');
  assert.equal(renderedTool(), 'chatgpt_web');
});

test('an unidentified client keeps the claude_web brief, as before', async () => {
  await dispatchTool('start_session', {}, ACTOR, 'unknown_web');
  assert.equal(renderedTool(), 'claude_web');
});
