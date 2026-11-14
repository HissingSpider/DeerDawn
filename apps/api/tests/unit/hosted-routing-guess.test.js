'use strict';

// A hosted start_session that GUESSED its project must say so first, name the
// likely alternatives by id, and record how the project was chosen; an explicit
// project that replaces a guess is recorded as a correction.
//
// The failure: a session in one repository opened another project's brief (a
// connector has no folder, so the answer came from recent work anywhere), the
// one-line caveat sat below the receipt and catch-up, named no alternative, and
// the agent carried on with the wrong brief. Nothing measured how often.
//
// Drives the real dispatch with the service layer stubbed; the destructured
// helpers are stubbed on their module objects BEFORE mcp.js is required.

process.env.NODE_ENV = 'test';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const sessionDedup = require('../../src/services/sessionDedup');
const catchupService = require('../../src/services/sessionCatchupService');
const productEvents = require('../../src/services/productEventsService');
const service = require('../../src/services/contextSyncService');

const deliveries = [];
const events = [];
let activeProject = null;

sessionDedup.checkAndMarkSessionLoad = async () => ({ duplicate: false, secondsAgo: null, otherSurface: null });
catchupService.buildSessionCatchup = async () => ({ text: 'Since last session (yesterday): shipped the thing.' });
catchupService.recordRemoteSessionDelivery = (actor, input) => { deliveries.push(input); };
productEvents.recordProductEvent = async (actor, event) => { events.push(event); };

service.resolveActiveProject = async () => activeProject;
service.renderInjection = async () => ({ body: 'Current task: the guessed project\'s task', receipt: 'DeerDawn loaded it.' });
service.getWorkspaceOverview = async () => ({ text: 'overview', projects: [{ project_id: 'p' }] });
service.listArchivedProjectSummaries = async () => [];
service.takeDeadBindingNotice = async () => null;
service.listRoutingAlternatives = async (actor, exclude) => [
  { project_id: 'proj-right', project_name: 'The Right One' },
  { project_id: 'proj-other', project_name: null },
].filter((p) => p.project_id !== exclude);
service.getProject = async (actor, id) => ({ project_id: id, project_name: id === 'proj-right' ? 'The Right One' : id, context: {} });
service.bindSessionToProject = async (actor, sessionId, id) => ({ project_id: id, project_name: id === 'proj-right' ? 'The Right One' : id });

const { dispatchTool } = require('../../src/routes/mcp');

const ACTOR = { type: 'user', id: 'user-1', org_id: 'org-1', scopes: ['context:read', 'context:write'] };
const textOf = (result) => result.content.map((c) => c.text).join('\n');

beforeEach(() => {
  deliveries.length = 0;
  events.length = 0;
  activeProject = {
    project_id: 'proj-guess', project_name: 'Most Recent Elsewhere',
    match_kind: 'session', match_confidence: 'high', match_guessed: true,
  };
});

test('a guessed project is called a guess FIRST, with the alternatives by id', async () => {
  const text = textOf(await dispatchTool('start_session', {}, ACTOR, 'claude_code'));
  assert.match(text, /^DeerDawn guessed "Most Recent Elsewhere" \(proj-guess\)/, text.slice(0, 300));
  assert.ok(text.indexOf('DeerDawn guessed') < text.indexOf('DeerDawn loaded it.'), 'the guess leads, above the receipt');
  assert.match(text, /"The Right One" \(proj-right\)/);
  assert.match(text, /"proj-other"/);
  assert.match(text, /manage_projects with action "select"/);
});

test('a confident project carries no guess note', async () => {
  activeProject = { project_id: 'proj-right', project_name: 'The Right One', match_kind: 'session', match_confidence: 'high', match_guessed: false };
  const text = textOf(await dispatchTool('start_session', {}, ACTOR, 'claude_code'));
  assert.doesNotMatch(text, /DeerDawn guessed/);
});

test('delivery telemetry says how the project was chosen', async () => {
  await dispatchTool('start_session', {}, ACTOR, 'claude_code');
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].matchKind, 'session');
  assert.equal(deliveries[0].matchGuessed, true);
});

test('naming a project that replaces a guess records a correction', async () => {
  await dispatchTool('start_session', { project_id: 'proj-right' }, ACTOR, 'claude_code');
  const corrected = events.filter((e) => e.event_name === 'session_project_corrected');
  assert.equal(corrected.length, 1, JSON.stringify(events.map((e) => e.event_name)));
  assert.equal(corrected[0].metadata.via, 'start_session');
  assert.equal(corrected[0].metadata.from_guessed, true);
});

test('naming the project it would have opened anyway records nothing', async () => {
  activeProject = { ...activeProject, project_id: 'proj-right' };
  await dispatchTool('start_session', { project_id: 'proj-right' }, ACTOR, 'claude_code');
  assert.equal(events.filter((e) => e.event_name === 'session_project_corrected').length, 0);
});

test('manage_projects select off a guess records a correction too', async () => {
  await dispatchTool('switch_subproject', { project_id: 'proj-right' }, ACTOR, 'claude_code');
  const corrected = events.filter((e) => e.event_name === 'session_project_corrected');
  assert.equal(corrected.length, 1);
  assert.equal(corrected[0].metadata.via, 'select');
});
