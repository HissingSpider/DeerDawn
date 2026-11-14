'use strict';

/**
 * EVERY hosted project resolution has to consult THIS connection's binding.
 *
 * Wave 6 threaded the hosted session id through resolveActiveProject so one
 * connector's writes stop redirecting another's. Two callers were missed, and
 * both of them are reads a person acts on:
 *
 *   - build_subagent_brief resolved without the session id, so an editor
 *     connection bound to "Ledger service" briefed a worker on "Apex Fund" —
 *     the project a browser tab had written to last — while `recall context` on
 *     the SAME connection correctly said Ledger.
 *   - the recall search boost did the same, ranking the other connection's
 *     project first for a query that matched both.
 *
 * A partial fix is the worse failure here: two reads on one connection
 * disagreeing about which project is open is harder to notice, and harder to
 * believe, than both being wrong.
 *
 * DB-backed; run via scripts/run-db-test.sh node --test tests/unit/hosted-session-binding-reach.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const service = require('../../src/services/contextSyncService');
const contextSearch = require('../../src/services/contextSearchService');
const workspace = require('../../src/services/workspaceService');
const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');

const RUN = crypto.randomBytes(4).toString('hex');
const ORG = `org-${crypto.randomUUID()}`;
const USER = `user-reach-${RUN}`;
const actor = () => ({ org_id: ORG, id: USER, scopes: ['context:read', 'context:write'] });

// The editor connection and the browser connection, as hostedSessionId derives
// them: one stable id per credential.
const EDITOR_SESSION = `web-claude_code-${RUN}`;
const BROWSER_SESSION = `web-claude_web-${RUN}`;

let ledger;
let apex;

test.before(async () => {
  await workspace.addMember(ORG, USER, { role: 'owner' });
  ledger = await service.createProject(actor(), { project_name: `Ledger service ${RUN}` });
  apex = await service.createProject(actor(), { project_name: `Apex Fund ${RUN}` });

  await service.updateProjectContext(actor(), ledger.project_id, {
    recent_decisions: [{
      summary: 'The ledger service posts a double entry for every transfer report',
      decided_at: new Date().toISOString(),
    }],
  });
  await service.updateProjectContext(actor(), apex.project_id, {
    recent_decisions: [{
      summary: 'The apex fund report uses quarterly NAV figures for investors',
      decided_at: new Date().toISOString(),
    }],
  });

  // The editor binds first; the browser binds second and writes last, so every
  // person-wide signal (latest binding, most recently touched) points at Apex.
  // That is the whole point: only the session id can still say Ledger.
  await service.bindSessionToProject(actor(), EDITOR_SESSION, ledger.project_id, { tool: 'claude_code' });
  await service.bindSessionToProject(actor(), BROWSER_SESSION, apex.project_id, { tool: 'claude_web' });
});

test.after(async () => {
  await db.query('DELETE FROM context_sessions WHERE owner_key = $1', [ORG], 'org-system').catch(() => {});
  await db.query('DELETE FROM context_projects WHERE owner_key = $1', [ORG], 'org-system').catch(() => {});
  await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [ORG], 'org-system').catch(() => {});
  await closeRedisConnections().catch(() => {});
});

test('the baseline holds: with no session id, the person-wide binding answers', async () => {
  const active = await service.resolveActiveProject(actor(), null, null, {});
  assert.equal(active.project_id, apex.project_id);
});

test('build_subagent_brief briefs the project THIS connection is bound to', async () => {
  const brief = await service.buildSubagentBrief(
    actor(),
    { task: 'Review the postings and report code for defects', role: 'reviewer' },
    { sessionId: EDITOR_SESSION },
  );
  assert.equal(
    brief.project_id,
    ledger.project_id,
    'THE BUG: the editor connection was briefed on the browser connection\'s project',
  );
});

test('and the browser connection still gets its own', async () => {
  const brief = await service.buildSubagentBrief(
    actor(),
    { task: 'Review the postings and report code for defects', role: 'reviewer' },
    { sessionId: BROWSER_SESSION },
  );
  assert.equal(brief.project_id, apex.project_id);
});

test('an explicit project_id still wins over the binding', async () => {
  const brief = await service.buildSubagentBrief(
    actor(),
    { project_id: apex.project_id, task: 'Review the report code' },
    { sessionId: EDITOR_SESSION },
  );
  assert.equal(brief.project_id, apex.project_id);
});

test('the recall search boost follows THIS connection too', async () => {
  const { results } = await contextSearch.searchContext(actor(), {
    query: 'report',
    limit: 5,
    session_id: EDITOR_SESSION,
  });
  const ranked = results.filter((hit) => hit.project_id);
  assert.ok(ranked.length >= 2, 'both projects match the query');
  assert.equal(
    ranked[0].project_id,
    ledger.project_id,
    'THE BUG: the editor connection had the other connection\'s project boosted',
  );
});

test('and the browser connection still has its own boosted', async () => {
  const { results } = await contextSearch.searchContext(actor(), {
    query: 'report',
    limit: 5,
    session_id: BROWSER_SESSION,
  });
  const ranked = results.filter((hit) => hit.project_id);
  assert.equal(ranked[0].project_id, apex.project_id);
});
