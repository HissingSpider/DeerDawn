'use strict';

// The deletion email promises a full export and "the last copy we hold".
//
// DELETE /api/v1/orgs with email_export sends the Markdown rendering of the
// export bundle, says it is "a full Markdown export", says "This is the last copy
// we hold", and the purge that follows erases everything. So the attachment has
// to carry everything the bundle carries that somebody wrote — the board, the
// findings, the known paths, archived projects, workspace entities, skills — and
// what it still leaves out has to be said, in the email, in words, because after
// this email there is nowhere left to find it.
//
// Stubbed like account-delete-export-scope.test.js: the export bundle is fixed
// here, so this pins the RENDERING and the COPY; export-completeness.test.js pins
// that the bundle itself is complete.

process.env.NODE_ENV = 'test';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const PERSONAL = 'org-personal-erin';

const auth = require('../../src/middleware/auth');
let actor = null;
auth.requireAuth = (req, _res, next) => { req.actor = { ...actor }; next(); };
auth.isClerkConfigured = () => false;
auth.deleteClerkUser = async () => {};

const db = require('../../src/config/db');
db.query = async (text) => {
  if (/FROM users WHERE user_id/.test(text)) {
    return { rows: [{ user_id: 'user-erin', email: 'erin@example.com', auth_provider: 'local', auth_subject: null, password_hash: null }] };
  }
  return { rows: [] };
};
db.pool = {
  connect: async () => ({
    query: async (text) => ({ rowCount: /DELETE FROM organizations/.test(text) ? 1 : 0 }),
    release: () => {},
  }),
};

const stripe = require('../../src/services/stripeService');
stripe.cancelSubscriptionForDeletion = async () => ({ ok: true, cancelled: false });

const erasure = require('../../src/services/dataErasureService');
erasure.purgeOwnerData = async () => ({});

const MARK = {
  archived: 'ERINARCHIVEDPROJECT',
  card: 'ERINBOARDCARD',
  cardBody: 'ERINCARDBODY',
  finding: 'ERINFINDING',
  hotpath: 'ERINKNOWNPATH',
  decision: 'ERINDECISION',
  goal: 'ERINGOAL',
  workspaceEntity: 'ERINWORKSPACEENTITY',
  skill: 'ERINSKILLBODY',
};

const contextSync = require('../../src/services/contextSyncService');
contextSync.exportContext = async () => ({
  exported_at: '2026-09-27T12:00:00.000Z',
  schema_version: 1,
  owner_key: PERSONAL,
  global_context: { user_profile: 'Erin builds things' },
  preferences: {},
  projects: [
    {
      project_id: 'p-live',
      project_name: 'Erin live project',
      updated_at: '2026-09-27T12:00:00.000Z',
      archived: false,
      archived_at: null,
      context: {
        project_name: 'Erin live project',
        goals: [`Reach ${MARK.goal}`],
        recent_decisions: [{ summary: `Chose ${MARK.decision}`, decided_at: '2026-09-01T00:00:00.000Z' }],
        debugging_notes: [{ summary: `Found ${MARK.finding}`, paths: [], added_at: '2026-09-01T00:00:00.000Z' }],
        hot_paths: [{ label: 'route', path: `src/${MARK.hotpath}.js` }],
        todo_items: [{ id: 'card-1', title: `Card ${MARK.card}`, body: `Body ${MARK.cardBody}`, phase: 'in_progress', created_at: '2026-09-01T00:00:00.000Z' }],
      },
      linked_paths: [],
      graph: { nodes: [], edges: [] },
    },
    {
      project_id: 'p-archived',
      project_name: `Old ${MARK.archived}`,
      updated_at: '2026-06-01T00:00:00.000Z',
      archived: true,
      archived_at: '2026-07-01T00:00:00.000Z',
      context: { project_name: `Old ${MARK.archived}`, current_task: 'Old work' },
      linked_paths: [],
      graph: { nodes: [], edges: [] },
    },
  ],
  workspace_graph: {
    nodes: [{ node_id: 'n-ws', node_type: 'component', title: `Platform ${MARK.workspaceEntity}`, summary: 'used everywhere' }],
    edges: [],
  },
  skills: [{ skill_id: 's-1', project_id: null, slug: 'release', name: 'Release', description: 'How we release', markdown_content: `Run ${MARK.skill}`, enabled: true }],
});

const resend = require('../../src/services/email/resendClient');
const sent = [];
resend.sendEmail = async (message) => { sent.push(message); return { ok: true }; };

const workspace = require('../../src/services/workspaceService');
workspace.resolveRole = async () => 'owner';
workspace.isSharedWorkspace = async () => false;

const app = express();
app.use(express.json());
app.use('/api/v1/orgs', require('../../src/routes/shared/orgs'));
const httpServer = app.listen(0);
const del = (body) => request(httpServer).delete('/api/v1/orgs/').send(body);

beforeEach(() => {
  sent.length = 0;
  actor = { type: 'user', id: 'user-erin', org_id: PERSONAL, workspace_key: PERSONAL, role: 'owner', scopes: ['context:admin'] };
});

test('the emailed attachment carries everything in the bundle a person wrote', async () => {
  const res = await del({ confirm_email: 'erin@example.com', email_export: true });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.export_emailed, true);
  const attachment = Buffer.from(sent[0].attachments[0].content, 'base64').toString('utf-8');
  const missing = Object.entries(MARK).filter(([, marker]) => !attachment.includes(marker)).map(([key]) => key);
  assert.deepStrictEqual(missing, [], 'nothing the bundle holds is missing from the attachment');
});

test('the email says, in words, what the attachment still leaves out', async () => {
  const res = await del({ confirm_email: 'erin@example.com', email_export: true });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const { html } = sent[0];
  assert.match(html, /Once your account is deleted, it is the last copy we hold\./, 'the promise stays, now that the attachment keeps it');
  assert.match(html, /leaves out/, 'and it names the exceptions');
  assert.doesNotMatch(html, /excerpt/i, 'the graph no longer keeps conversation excerpts, so the email names none');
  for (const [what, pattern] of [
    ['the change and session history', /history/],
    // Evidence rows hold a line the product writes, not the conversation
    // (journey scan round 3), so they are named as notes, not excerpts.
    ['the notes on where the graph came from', /the notes on where your knowledge graph came from/],
    ['the indexes and rankings DeerDawn computes from the data', /computes/],
  ]) {
    assert.match(html, pattern, `the email names ${what}`);
  }
  // Switched-off skills are in the attachment now, marked (journey r4), so the
  // email no longer lists them among what it leaves out.
  assert.doesNotMatch(html, /switched off/, 'switched-off skills are attached, not left out');
});

test.after(() => new Promise((resolve) => httpServer.close(resolve)));
