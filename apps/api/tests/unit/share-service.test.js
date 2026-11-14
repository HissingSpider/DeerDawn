/**
 * Share links — what leaves the account, and what stops it.
 *
 * The share page is the growth loop and the leak risk in the same object: a
 * brief legitimately contains internal file counts, deliberate technical debt
 * and what is currently broken. So the properties pinned here are the ones that
 * decide whether that is a demo or an incident:
 *   1. The payload is an ALLOW-LIST. Hot paths, commands and file structure are
 *      in the brief and must never reach a public URL, including after someone
 *      adds a new field to the context schema.
 *   2. The scan runs on the BRIEF CONTENT, not on connected repos.
 *   3. The gate applies at EVERY visibility, unlisted included — an unlisted URL
 *      has no auth on it, it just isn't indexed.
 *   4. Acknowledging the findings is what unlocks minting, and acknowledgement
 *      is per-finding.
 *   5. Read-time masking is independent of the create-time gate, because the
 *      brief keeps changing after the link is minted.
 */
const test = require('node:test');
const assert = require('node:assert');

const store = require('../../src/store/contextSyncStore');
const entitlementService = require('../../src/services/entitlementService');
const shareService = require('../../src/services/shareService');

const ACTOR = { org_id: 'org-dddddddd-4444-4444-8444-dddddddddd44', id: 'user-share' };

function projectFixture(overrides = {}) {
  return {
    project_id: 'project_share',
    project_name: 'DeerDawn',
    updated_at: '2026-08-27T00:00:00.000Z',
    context: {
      description: 'AI session memory',
      tech_stack: ['TypeScript', 'Postgres'],
      last_updated: '2026-08-27T00:00:00.000Z',
      shipped: [{ summary: 'Shipped the portfolio tab', shipped_at: '2026-08-26T00:00:00.000Z' }],
      recent_decisions: [
        { summary: 'Removed the project cap', decided_at: '2026-08-27T00:00:00.000Z' },
        { summary: 'A settled thing', decided_at: '2026-08-01T00:00:00.000Z', resolved: true },
      ],
      open_questions: ['How long before a surface goes amber?'],
      landmines: [{ summary: 'context_graph_nodes is unique per owner, not per project' }],
      // Present in every real brief, and none of it belongs on a public URL.
      hot_paths: ['apps/api/src/services/contextSyncService.js'],
      commands: [{ command: 'make verify-prod' }],
      file_structure_summary: ['apps/api — CommonJS only'],
      ...overrides,
    },
  };
}

function stubStore(project) {
  store.getProject = async () => project;
  store.createShareToken = async (row) => ({ ...row, created_at: '2026-08-27T00:00:00.000Z', revoked_at: null, view_count: 0 });
  store.recordShareTokenView = async () => {};
  entitlementService.getEntitlementsForExistingOrg = async () => ({
    tier: 'developer_basic',
    features: { trail_share: true },
    limits: {},
  });
}

test('Share service', async (t) => {
  await t.test('the payload is an allow-list: the four slots and nothing else', () => {
    const payload = shareService.buildSharePayload(projectFixture());
    assert.deepStrictEqual(Object.keys(payload.slots).sort(), ['decided', 'landmines', 'open', 'shipped']);
    const serialized = JSON.stringify(payload);
    assert.ok(!serialized.includes('contextSyncService'), 'hot paths must not reach a public URL');
    assert.ok(!serialized.includes('make verify-prod'), 'commands must not reach a public URL');
    assert.ok(!serialized.includes('CommonJS only'), 'file structure must not reach a public URL');
    assert.strictEqual(payload.slots.decided.length, 1, 'resolved decisions are not published');
  });

  await t.test('the scan reads the brief content, not the repo', () => {
    const project = projectFixture({
      recent_decisions: [{
        summary: 'Rotated the key to sk-live-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
        decided_at: '2026-08-27T00:00:00.000Z',
      }],
    });
    const scan = shareService.scanSharePayload(shareService.buildSharePayload(project));
    assert.ok(scan.counts.total > 0, 'a credential written into a decision must be found');
    assert.ok(
      scan.findings.some((f) => f.path.startsWith('brief.slots.decided')),
      `the finding must point at the slot it came from, got: ${scan.findings.map((f) => f.path).join(', ')}`,
    );
    // The reviewer scans down the section column, so it has to read as the slot
    // name. trailScan's own sectionForPath only understands `content.`-rooted
    // paths and would label every one of these 'unknown'.
    assert.ok(
      scan.findings.some((f) => f.section === 'Decided'),
      `findings must be labelled with the slot, got: ${scan.findings.map((f) => f.section).join(', ')}`,
    );
  });

  await t.test('unlisted is gated too — the scan is not a public-only check', async () => {
    stubStore(projectFixture({
      open_questions: ['Ask ops for the token AKIAIOSFODNN7EXAMPLE before Friday'],
    }));
    await assert.rejects(
      () => shareService.createShare(ACTOR, { project_id: 'project_share', visibility: 'unlisted' }),
      (err) => {
        assert.strictEqual(err.message, 'share_scan_unresolved');
        assert.strictEqual(err.status, 422);
        assert.ok(err.scan.unresolved_count > 0);
        return true;
      },
    );
  });

  await t.test('acknowledging every finding is what mints the link', async () => {
    const project = projectFixture({
      open_questions: ['Ask ops for the token AKIAIOSFODNN7EXAMPLE before Friday'],
    });
    stubStore(project);
    const scan = shareService.scanSharePayload(shareService.buildSharePayload(project));
    const ids = scan.findings.map((f) => f.id);

    // One short of the full set is still a refusal.
    if (ids.length > 1) {
      await assert.rejects(
        () => shareService.createShare(ACTOR, {
          project_id: 'project_share',
          acknowledged_finding_ids: ids.slice(0, -1),
        }),
        /share_scan_unresolved/,
      );
    }

    const { share } = await shareService.createShare(ACTOR, {
      project_id: 'project_share',
      acknowledged_finding_ids: ids,
    });
    assert.strictEqual(share.visibility, 'unlisted', 'unlisted is the default visibility');
    assert.ok(share.token && share.token.length >= 20, 'the token must not be guessable');
  });

  await t.test('a clean brief mints without ceremony', async () => {
    stubStore(projectFixture());
    const { share, scan } = await shareService.createShare(ACTOR, { project_id: 'project_share' });
    assert.strictEqual(scan.counts.total, 0);
    assert.strictEqual(share.project_id, 'project_share');
  });

  await t.test('free accounts get an upgrade message, not a broken call', async () => {
    stubStore(projectFixture());
    entitlementService.getEntitlementsForExistingOrg = async () => ({
      tier: 'free',
      features: { trail_share: false },
      limits: {},
    });
    await assert.rejects(
      () => shareService.createShare(ACTOR, { project_id: 'project_share' }),
      (err) => {
        assert.strictEqual(err.status, 403);
        assert.match(err.publicMessage, /stay unlimited on Free/,
          'naming what costs money must always name what stays free');
        return true;
      },
    );
  });

  await t.test('read-time masking catches a secret added AFTER the link was minted', async () => {
    // The create-time gate ran against a clean brief. This is the brief later.
    stubStore(projectFixture({
      open_questions: ['Retry with api_key="sk-live-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"'],
    }));
    store.getShareTokenByToken = async () => ({
      token: 't', owner_key: ACTOR.org_id, project_id: 'project_share',
      visibility: 'public', revoked_at: null,
    });
    const result = await shareService.getPublicShare('t');
    assert.strictEqual(result.state, 'ok');
    assert.ok(
      !JSON.stringify(result.brief).includes('sk-live-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'),
      'a credential added after minting must never be served',
    );
  });

  await t.test('listing is ungated and reports whether creating is allowed', async () => {
    // Listing must NOT be gated: an account that downgraded still owns its
    // existing links and has to be able to see and revoke them. Only minting is
    // paid, so the flag is how the client knows which state to render — inferring
    // it from a failed POST meant the locked panel could never appear.
    stubStore(projectFixture());
    store.listShareTokens = async () => [{
      token: 't1', owner_key: ACTOR.org_id, project_id: 'project_share',
      visibility: 'unlisted', created_at: null, revoked_at: null, last_viewed_at: null, view_count: 0,
    }];
    store.listProjects = async () => [{ project_id: 'project_share', project_name: 'DeerDawn' }];

    const pro = await shareService.listShares(ACTOR);
    assert.strictEqual(pro.can_create, true);
    assert.strictEqual(pro.shares[0].project_name, 'DeerDawn', 'project names are resolved for display');

    entitlementService.getEntitlementsForExistingOrg = async () => ({
      tier: 'free', features: { trail_share: false }, limits: {},
    });
    const free = await shareService.listShares(ACTOR);
    assert.strictEqual(free.can_create, false, 'free is told it cannot create');
    assert.strictEqual(free.shares.length, 1, 'but still sees the links it already owns');
  });

  await t.test('a revoked link says so; a missing one is a 404', async () => {
    store.getShareTokenByToken = async (token) => (token === 'revoked'
      ? { token, owner_key: ACTOR.org_id, project_id: 'project_share', visibility: 'unlisted', revoked_at: '2026-08-27T00:00:00.000Z' }
      : null);
    assert.strictEqual((await shareService.getPublicShare('revoked')).state, 'revoked');
    assert.strictEqual((await shareService.getPublicShare('nope')).state, 'not_found');
  });
});
