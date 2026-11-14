'use strict';

/**
 * A share link is a PUBLICATION. Who may mint one, and whose brief may it show.
 *
 * shareService loaded its project with `store.getProject(ownerKey, projectId)` —
 * the workspace key, straight past the visibility model. So in a shared
 * workspace:
 *   - any member could PREVIEW a colleague's `personal` project, which is the
 *     one state that means "nobody else, not even a workspace owner";
 *   - any member holding context:write could mint a PUBLIC link to it, putting
 *     somebody else's private work on an unauthenticated URL.
 * The preview even ran the redaction scan for them, so the leak came with a
 * report of what was in it.
 *
 * What is pinned here:
 *   1. Preview obeys canViewProjectForActor, and an invisible project is
 *      `project_not_found` — never a 403, which would confirm it exists.
 *   2. Minting, and widening an existing link, require the AUTHOR. A workspace
 *      owner gets READ on `private` work (continuity when somebody leaves);
 *      publishing it to the web is a different power nobody asked for.
 *   3. Revoking is available to the author or a workspace owner — turning a
 *      live link OFF is the safe direction, and must never need the person who
 *      has left.
 *
 * DB-backed; run via scripts/run-db-test.sh node --test tests/unit/share-project-authority.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const service = require('../../src/services/contextSyncService');
const shareService = require('../../src/services/shareService');
const store = require('../../src/store/contextSyncStore');
const db = require('../../src/config/db');
const workspace = require('../../src/services/workspaceService');
const entitlementService = require('../../src/services/entitlementService');
const { closeRedisConnections } = require('../../src/config/redis');

const RUN = crypto.randomBytes(4).toString('hex');
const ORG = `org-${crypto.randomUUID()}`;
const ALICE = `user-share-alice-${RUN}`; // workspace owner
const BOB = `user-share-bob-${RUN}`;     // member, author of the projects below
const DORA = `user-share-dora-${RUN}`;   // a second member

const actor = (id) => ({ org_id: ORG, id });
const alice = () => actor(ALICE);
const bob = () => actor(BOB);
const dora = () => actor(DORA);

const notFound = (err) => err.message === 'project_not_found' && err.status === 404;
const forbidden = (err) => err.message === 'share_forbidden' && err.status === 403;

const realEntitlements = entitlementService.getEntitlementsForExistingOrg;

let seq = 0;
async function projectWithVisibility(visibility) {
  seq += 1;
  const project = await service.createProject(bob(), { project_name: `Share ${visibility} ${seq} ${RUN}` });
  const row = await store.getProject(ORG, project.project_id);
  await store.saveProject({ ...row, visibility }, null);
  return project.project_id;
}

test.before(async () => {
  await workspace.addMember(ORG, ALICE, { role: 'owner' });
  await workspace.addMember(ORG, BOB, { role: 'member' });
  await workspace.addMember(ORG, DORA, { role: 'member' });
  // Share links are a paid feature; the plan is not what this suite is about.
  entitlementService.getEntitlementsForExistingOrg = async () => ({
    tier: 'developer_basic', features: { trail_share: true }, limits: {},
  });
});

// Seeded workspace_members MUST be cleared, or a later suite inherits a roster
// it never created — a breakage that only shows up after a merge.
test.after(async () => {
  entitlementService.getEntitlementsForExistingOrg = realEntitlements;
  try {
    await db.query(
      'DELETE FROM context_share_tokens WHERE owner_key = $1', [ORG], 'org-system',
    );
    await db.query('DELETE FROM context_projects WHERE owner_key = $1', [ORG], 'org-system');
    await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [ORG], 'org-system');
  } catch (_) { /* best effort */ }
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});

test('a teammate cannot preview a colleague\'s personal project', async () => {
  const projectId = await projectWithVisibility('personal');
  await assert.rejects(shareService.previewShare(dora(), projectId), notFound);
  // Not even the workspace owner: 'personal' is the state that excludes them.
  await assert.rejects(shareService.previewShare(alice(), projectId), notFound);
  // The author still can.
  const preview = await shareService.previewShare(bob(), projectId);
  assert.ok(preview.preview.project_name);
});

test('a teammate cannot mint a public link to a colleague\'s personal project', async () => {
  const projectId = await projectWithVisibility('personal');
  await assert.rejects(
    shareService.createShare(dora(), { project_id: projectId, visibility: 'public' }),
    notFound,
  );
  const tokens = await store.listShareTokens(ORG);
  assert.equal(tokens.filter((t) => t.project_id === projectId).length, 0, 'nothing was minted');
});

test('a workspace owner may read private work but not publish it', async () => {
  const projectId = await projectWithVisibility('private');
  // READ is the point of the 'private' state — continuity when somebody leaves.
  const preview = await shareService.previewShare(alice(), projectId);
  assert.ok(preview.scan, 'an owner may preview org-owned private work');
  // Publishing it is not.
  await assert.rejects(
    shareService.createShare(alice(), { project_id: projectId, visibility: 'unlisted' }),
    forbidden,
  );
  // A plain member cannot even see it.
  await assert.rejects(shareService.previewShare(dora(), projectId), notFound);
});

test('a member cannot mint or widen a link to a colleague\'s shared project', async () => {
  const projectId = await projectWithVisibility('shared');
  // A teammate may READ a shared project — that is what shared means...
  const preview = await shareService.previewShare(dora(), projectId);
  assert.ok(preview.preview.project_name);
  // ...and may not put it on a public URL.
  await assert.rejects(
    shareService.createShare(dora(), { project_id: projectId, visibility: 'public' }),
    forbidden,
  );

  const { share } = await shareService.createShare(bob(), { project_id: projectId, visibility: 'unlisted' });
  await assert.rejects(
    shareService.setShareVisibility(dora(), share.token, 'public'),
    forbidden,
  );
  const stored = await store.getShareTokenByToken(share.token);
  assert.equal(stored.visibility, 'unlisted', 'the link was not widened');

  // Revoking is the safe direction, so a workspace owner may do it.
  const revoked = await shareService.revokeShare(alice(), share.token);
  assert.ok(revoked.revoked_at, 'a workspace owner may turn a live link off');
});
