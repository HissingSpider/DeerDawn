/**
 * The cross-project block — the paid unit of the Phase 2.5 pivot.
 *
 * What these pin, and why each one is a thing that was actually got wrong:
 *
 *   1. Relevance beats recency. The first attempt at this reused the portfolio's
 *      merged timeline, which sorts by decided_at. Assembled against real data it
 *      put another project's terrain-streaming work at the top of a quant brief.
 *      A newer, unrelated decision must NEVER outrank an older, related one.
 *   2. One distinctive shared term is enough. The pair this exists to find —
 *      ApexFundV3's "portfolio_sharpe has no covariance term" against Red Queen's
 *      allocator — shares exactly ONE word. A gate that counts matches instead of
 *      weighing rarity returns nothing here, and did.
 *   3. Two generic shared words are NOT enough. That is the noise case, and a bad
 *      pull is worse than none: it teaches the reader to skip the section.
 *   4. Free sees the counts, never silence. A free reader who sees nothing cannot
 *      tell there was anything to see, which puts Pro back out of sight.
 *
 * The store and entitlements are stubbed — this is about the ranking and the
 * gate, not about Postgres.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const entitlementService = require('../../src/services/entitlementService');
const crossProjectService = require('../../src/services/crossProjectService');
const { buildRelatedProjectsLine, decisionHeadline } = require('../../../../packages/shared-context/src/index.js');

const ACTOR = { org_id: 'org-11111111-2222-4333-8444-555555555555', id: 'user-cross' };

const TARGET = {
  project_id: 'p_redqueen',
  project_name: 'Red Queen',
  context: {
    current_task: 'Review the allocator covariance and the correlation gate; confirm whether the momentum baseline rejection is thresholds or market conditions.',
    open_questions: ['Should we explore data sources beyond crypto and US equities?'],
  },
};

const RELATED_NEIGHBOUR = {
  project_id: 'p_apex',
  project_name: 'ApexFundV3',
  context: {
    debugging_notes: [{
      summary: 'portfolio_sharpe is NOT a portfolio Sharpe and is non-diagnostic. It computes sum(w_i * oos_sharpe_i) — per-strategy backtest Sharpes with no covariance term, not normalized by gross.',
      paths: ['api/routes/portfolio.py'],
      added_at: '2026-07-23T00:00:00.000Z',
      importance: 'high',
    }],
  },
};

// Newer than the related one, and completely unrelated. Under a recency merge
// this wins; under relevance it must not appear at all.
const NOISY_NEIGHBOUR = {
  project_id: 'p_apexdrive',
  project_name: 'ApexDrive',
  context: {
    recent_decisions: [{
      summary: 'Far-terrain ring landed in WorldStreamer: coarse 1024 m tiles at 64 m/quad out to 6.1 km, submerged tiles skipped via ChunkMeshData.HasLand.',
      decided_at: '2026-08-28T23:59:00.000Z',
      importance: 'high',
    }],
  },
};

const PROJECTS = [TARGET, RELATED_NEIGHBOUR, NOISY_NEIGHBOUR];

function withEntitlements(features, run) {
  const original = entitlementService.getEntitlementsForExistingOrg;
  entitlementService.getEntitlementsForExistingOrg = async () => ({ features });
  return run().finally(() => { entitlementService.getEntitlementsForExistingOrg = original; });
}

test('cross-project brief block', async (t) => {
  await t.test('surfaces the related finding unasked, ranked first', async () => {
    await withEntitlements({ portfolio: true }, async () => {
      const block = await crossProjectService.getRelatedFromOtherProjects(ACTOR, {
        projectId: TARGET.project_id,
        projects: PROJECTS,
      });
      assert.equal(block.locked, false);
      assert.ok(block.entries.length >= 1, 'expected at least one related entry');
      assert.match(block.entries[0].headline, /portfolio_sharpe/);
      assert.equal(block.entries[0].project_name, 'ApexFundV3');
      // The anchor is what makes the claim checkable in the other repo.
      assert.equal(block.entries[0].anchor, 'api/routes/portfolio.py');
    });
  });

  await t.test('a newer unrelated decision does not appear at all', async () => {
    await withEntitlements({ portfolio: true }, async () => {
      const block = await crossProjectService.getRelatedFromOtherProjects(ACTOR, {
        projectId: TARGET.project_id,
        projects: PROJECTS,
      });
      assert.ok(
        !block.entries.some((entry) => /terrain|WorldStreamer/i.test(entry.headline)),
        'recency leaked back in — an unrelated newer decision was injected'
      );
    });
  });

  await t.test('two generic shared words are not a relationship', async () => {
    const generic = {
      project_id: 'p_generic',
      project_name: 'Generic',
      context: {
        recent_decisions: [{
          // Shares "review" and "conditions" with the target task and nothing else.
          summary: 'Team agreed to review the rollout under normal conditions before the launch window closes.',
          decided_at: '2026-08-27T00:00:00.000Z',
        }],
      },
    };
    await withEntitlements({ portfolio: true }, async () => {
      const block = await crossProjectService.getRelatedFromOtherProjects(ACTOR, {
        projectId: TARGET.project_id,
        projects: [TARGET, generic],
      });
      assert.equal(block.count, 0, 'generic word overlap produced a block');
    });
  });

  await t.test('free gets the counts, never silence', async () => {
    await withEntitlements({ portfolio: false }, async () => {
      const block = await crossProjectService.getRelatedFromOtherProjects(ACTOR, {
        projectId: TARGET.project_id,
        projects: PROJECTS,
      });
      assert.equal(block.locked, true);
      assert.ok(block.count >= 1, 'locked block must still report the real count');
      assert.deepEqual(block.entries, [], 'locked block must not leak contents');

      const line = buildRelatedProjectsLine(block);
      assert.match(line, /Related elsewhere/);
      assert.match(line, /Pro shows them/);
      assert.ok(!/portfolio_sharpe/.test(line), 'locked line leaked a headline');
    });
  });

  await t.test('a single project has nothing to relate to', async () => {
    await withEntitlements({ portfolio: true }, async () => {
      const block = await crossProjectService.getRelatedFromOtherProjects(ACTOR, {
        projectId: TARGET.project_id,
        projects: [TARGET],
      });
      assert.equal(block.count, 0);
      assert.equal(buildRelatedProjectsLine(block), null);
    });
  });

  await t.test('a subproject is the same body of work, not another project', async () => {
    const child = {
      project_id: 'p_child',
      project_name: 'Red Queen Allocator',
      parent_project_id: TARGET.project_id,
      context: {
        recent_decisions: [{
          summary: 'Allocator covariance must come from out-of-sample returns only; Tier-A returns look uncorrelated because each strategy was fitted to a different piece of the same noise.',
          decided_at: '2026-08-20T00:00:00.000Z',
          importance: 'critical',
        }],
      },
    };
    await withEntitlements({ portfolio: true }, async () => {
      const block = await crossProjectService.getRelatedFromOtherProjects(ACTOR, {
        projectId: TARGET.project_id,
        projects: [TARGET, child],
      });
      assert.equal(block.count, 0, 'a subproject was treated as a separate project');
    });
  });
});

test('decisionHeadline', async (t) => {
  await t.test('takes the claim, not the transcript', () => {
    const headline = decisionHeadline({
      summary: 'portfolio_sharpe is NOT a portfolio Sharpe and is non-diagnostic for risk-adjusted work. api/routes/portfolio.py:72-84 computes it as a weight-weighted sum with no covariance term, and not normalized by gross.',
    });
    assert.equal(headline, 'portfolio_sharpe is NOT a portfolio Sharpe and is non-diagnostic for risk-adjusted work.');
  });

  await t.test('an explicit headline from extraction wins', () => {
    assert.equal(decisionHeadline({ headline: 'Allocator covariance comes from OOS returns', summary: 'long…' }),
      'Allocator covariance comes from OOS returns');
  });

  await t.test('does not split a decimal or a filename mid-claim', () => {
    const headline = decisionHeadline({ summary: 'The redirect lives in apps/dashboard/next.config.ts, not marketing.' });
    assert.match(headline, /next\.config\.ts/);
  });

  await t.test('caps length so a session dump cannot enter a brief whole', () => {
    const headline = decisionHeadline({ summary: 'x'.repeat(5000) });
    assert.ok(headline.length <= 161, `headline was ${headline.length} chars`);
  });
});
