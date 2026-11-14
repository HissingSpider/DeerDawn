/**
 * /settings/upgrade must not tell a reader their plan lacks something it has.
 *
 * Journey r1, S4: a Free user pressed the Upgrade banner and read, on the
 * product's highest-intent upgrade page, that Free does NOT brief every session
 * (/select-plan's Free card: "Every new session starts briefed"), that neither
 * Free nor Pro has API access (API keys are minted and work on every plan), and
 * that Pro has no brief sharing (/select-plan's Pro card: "Share links for any
 * brief"; /pricing: "Trail share links — Yes"). The page had typed those three
 * columns to mirror plans.js `auto_sync`, `api_access` and `context_sharing` —
 * flags nothing in apps/api reads — so each cross was a claim with nothing
 * behind it.
 *
 * Three rules, each checked against something outside this page:
 *   1. A cross is a claim that a plan does NOT have something, so it has to be
 *      backed by a plans.js flag the API actually enforces, with the same
 *      per-plan value.
 *   2. What /select-plan's cards say a plan includes, this page may not deny —
 *      for that plan or any plan above it.
 *   3. Where /pricing compares the same thing, this page agrees with it.
 *
 * /select-plan and /pricing are read as TEXT (select-plan keeps its bullets in
 * the page; marketing is another workspace), the same way planCopy.test.ts
 * reads plans.js.
 *
 * Run: `npx tsx --test src/lib/planComparison.test.ts`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { COMPARED_PLANS, PLAN_COMPARISON, type ComparedPlan, type ComparisonRow } from './planComparison';

const APP_ROOT = join(import.meta.dirname, '../..');
const REPO_ROOT = join(APP_ROOT, '../..');
const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), 'utf8');

/** Comment-blind: these files explain the drift they avoid by quoting it. */
const codeOnly = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** Plans are ordered: each includes everything the one before it does. */
const atOrAbove = (plan: ComparedPlan) => COMPARED_PLANS.slice(COMPARED_PLANS.indexOf(plan));

// ── The other surfaces, as data ──────────────────────────────────────────────

const plansJs = read('apps/api/src/config/plans.js');

function planBlock(id: string): string {
  const start = plansJs.indexOf(`  ${id}: {`);
  assert.notStrictEqual(start, -1, `plans.js no longer defines \`${id}\` — re-point this test`);
  const end = plansJs.indexOf('\n  },\n', start);
  assert.ok(end > start);
  return plansJs.slice(start, end);
}

function planFlag(plan: ComparedPlan, flag: string): boolean {
  const match = new RegExp(`\\b${flag}:\\s*(true|false)`).exec(planBlock(plan));
  assert.ok(match, `plans.js \`${plan}\` declares no \`${flag}\``);
  return match[1] === 'true';
}

/** Every .js file under apps/api/src except plans.js itself, comment-blind. */
function apiSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && !full.endsWith(join('config', 'plans.js'))) {
        out.push(codeOnly(readFileSync(full, 'utf8')));
      }
    }
  };
  walk(join(REPO_ROOT, 'apps/api/src'));
  assert.ok(out.length > 50, 'apps/api/src moved — re-point this test');
  return out;
}

/** Is this plans.js feature read by anything in the API — i.e. enforced? */
function enforced(flag: string, sources: string[]): boolean {
  const reads = new RegExp(`features\\??\\.${flag}\\b|['"]${flag}['"]`);
  return sources.some((source) => reads.test(source));
}

/** /select-plan's cards: plan id -> the bullets it shows. */
function selectPlanBullets(): Map<string, string[]> {
  // The cards moved out of the page into the component it renders them with
  // (2026-09-28), so a test can render their prices in both toggle states.
  const code = codeOnly(read('apps/dashboard/src/components/billing/SelectPlanChoices.tsx'));
  const cards = new Map<string, string[]>();
  for (const card of code.matchAll(/id:\s*'(\w+)',[\s\S]*?bullets:\s*\[([^\]]*)\]/g)) {
    cards.set(card[1], [...card[2].matchAll(/'([^']*)'/g)].map((m) => m[1]));
  }
  assert.ok(cards.get('free')?.length && cards.get('developer_basic')?.length,
    'could not read the Free and Pro cards off /select-plan — re-point this test');
  return cards;
}

/**
 * apps/marketing exists only in the private repo (the public export does not
 * ship it). The checks against /pricing skip without it; everything checked
 * against /select-plan and plans.js still runs.
 */
const PRICING_PAGE = join(REPO_ROOT, 'apps/marketing/src/pages/pricing.tsx');
const PRICING_SKIP = existsSync(PRICING_PAGE) ? false : 'apps/marketing is not in this checkout (private repo only)';

/** Marketing /pricing's comparison table: label -> per-plan cell. */
function pricingRows(): Map<string, Record<ComparedPlan, string>> {
  const code = codeOnly(read('apps/marketing/src/pages/pricing.tsx'));
  const rows = new Map<string, Record<ComparedPlan, string>>();
  for (const row of code.matchAll(/\{ label: '([^']+)', free: '([^']*)', pro: '([^']*)', team: '([^']*)' \}/g)) {
    rows.set(row[1], { free: row[2], developer_basic: row[3], developer_pro: row[4] });
  }
  assert.ok(rows.size > 5, 'could not read the /pricing comparison table — re-point this test');
  return rows;
}

const pricingIncludes = (cell: string) => cell !== '—' && cell !== '';

/** Rows of this page whose label is about `topic`. */
const rowsAbout = (topic: RegExp) => PLAN_COMPARISON.filter((row) => topic.test(row.label));

function assertIncluded(row: ComparisonRow, plans: readonly ComparedPlan[], because: string) {
  for (const plan of plans) {
    assert.notStrictEqual(row.values[plan], false,
      `/settings/upgrade shows "${row.label}" as NOT included on ${plan}, but ${because}`);
  }
}

// ── 1. Every cross is backed by something the API enforces ───────────────────

test('every "not included" on the upgrade page is a flag the API enforces, with the same value', () => {
  const sources = apiSources();
  for (const row of PLAN_COMPARISON) {
    const denied = COMPARED_PLANS.filter((plan) => row.values[plan] === false);
    if (!denied.length) continue;
    assert.ok(row.flag,
      `"${row.label}" is shown as not included on ${denied.join(', ')} but names no plans.js flag behind that`);
    assert.ok(enforced(row.flag, sources),
      `"${row.label}" restates plans.js \`${row.flag}\`, which nothing in apps/api/src reads — ` +
        `a cross on it is a claim nothing enforces (on ${denied.join(', ')})`);
    for (const plan of COMPARED_PLANS) {
      assert.strictEqual(row.values[plan], planFlag(plan, row.flag),
        `"${row.label}" on ${plan} disagrees with plans.js \`${row.flag}\``);
    }
  }
});

// ── 2. Nothing /select-plan says a plan has ──────────────────────────────────

test('every session is briefed on every plan, as /select-plan\'s Free card says', () => {
  const bullets = selectPlanBullets();
  assert.ok(bullets.get('free')!.includes('Every new session starts briefed'),
    '/select-plan\'s Free card no longer says this — re-point the claim below');
  const rows = rowsAbout(/\bsession/i);
  assert.ok(rows.length > 0, 'no session-briefing row found — re-point this test');
  for (const row of rows) {
    assertIncluded(row, atOrAbove('free'), '/select-plan\'s Free card says "Every new session starts briefed"');
  }
});

test('share links are on Pro and Team, as /select-plan and /pricing say', () => {
  const bullets = selectPlanBullets();
  assert.ok(bullets.get('developer_basic')!.includes('Share links for any brief'),
    '/select-plan\'s Pro card no longer says this — re-point the claim below');
  const pricing = PRICING_SKIP ? null : pricingRows().get('Trail share links');
  if (!PRICING_SKIP) assert.ok(pricing, '/pricing no longer has a "Trail share links" row — re-point this test');

  const rows = rowsAbout(/\bshar(e|ing)\b/i);
  assert.ok(rows.length > 0, 'no share row found — re-point this test');
  for (const row of rows) {
    assertIncluded(row, atOrAbove('developer_basic'), '/select-plan\'s Pro card says "Share links for any brief"');
    if (!pricing) continue; // /pricing half: private repo only (see PRICING_SKIP)
    for (const plan of COMPARED_PLANS) {
      if (typeof row.values[plan] !== 'boolean') continue;
      assert.strictEqual(row.values[plan], pricingIncludes(pricing[plan]),
        `"${row.label}" on ${plan} disagrees with /pricing's "Trail share links": ${pricing[plan]}`);
    }
  }
});

test('no plan is shown without API access: keys are minted on every plan', () => {
  // The anchor is the route, not a page: POST /api/v1/keys checks a scope and
  // no plan feature, so a Free account's key works.
  const keys = codeOnly(read('apps/api/src/routes/shared/keys.js'));
  assert.doesNotMatch(keys, /checkFeature\(|features\??\./,
    'the keys route now gates on a plan feature — this claim needs revisiting, not deleting');
  for (const row of rowsAbout(/\bAPI\b/)) {
    assertIncluded(row, COMPARED_PLANS, 'API keys are created and work on every plan');
  }
});

test('no row names a plan feature that nothing enforces', () => {
  // auto_sync, api_access and context_sharing are declared in plans.js and read
  // by nothing. A tick on one is as unfounded as a cross; neither may be sold.
  const sources = apiSources();
  for (const row of PLAN_COMPARISON) {
    if (row.flag) assert.ok(enforced(row.flag, sources), `"${row.label}" restates unenforced \`${row.flag}\``);
  }
});

// ── 3. Where /pricing compares the same thing, agree with it ─────────────────

test('the rows /pricing also compares say the same thing there', { skip: PRICING_SKIP }, () => {
  const pricing = pricingRows();

  const workspace = pricing.get('Shared workspace and seats');
  const workspaceRow = PLAN_COMPARISON.find((row) => row.label === 'Shared workspace and seats');
  assert.ok(workspace && workspaceRow);
  for (const plan of COMPARED_PLANS) {
    assert.strictEqual(workspaceRow.values[plan], pricingIncludes(workspace[plan]), plan);
  }

  const projects = pricing.get('Projects');
  const projectsRow = PLAN_COMPARISON.find((row) => row.label === 'Projects');
  assert.ok(projects && projectsRow);
  for (const plan of COMPARED_PLANS) {
    assert.match(String(projectsRow.values[plan]), /^Unlimited/, `${plan}: /pricing says ${projects[plan]}`);
  }

  const history = pricing.get('Brief history');
  const historyRow = PLAN_COMPARISON.find((row) => row.label === 'History');
  assert.ok(history && historyRow);
  assert.strictEqual(historyRow.values.free, history.free, 'Free\'s history window');
  for (const plan of atOrAbove('developer_basic')) {
    assert.doesNotMatch(String(historyRow.values[plan]), /\d/, `${plan}'s history is unbounded on /pricing (${history[plan]})`);
  }
});

// ── The page renders this structure, and keeps no private copy ───────────────

test('/settings/upgrade renders its comparison from this module', () => {
  // The page prints its plan cards through UpgradePlanCards (2026-09-28), so
  // the surface is the page and that component together.
  const page = codeOnly(read('apps/dashboard/src/pages/settings/upgrade.tsx'));
  assert.match(page, /<UpgradePlanCards\b/, '/settings/upgrade no longer renders its cards through UpgradePlanCards');
  const cards = codeOnly(read('apps/dashboard/src/components/billing/UpgradePlanCards.tsx'));
  assert.match(cards, /from '@\/lib\/planComparison'/);
  assert.match(cards, /PLAN_COMPARISON\.map\(/);
  for (const source of [page, cards]) {
    assert.doesNotMatch(source, /\b(autoSync|apiAccess|contextSharing|teamWorkspace)\s*:/,
      'the page is keeping its own per-plan feature columns again');
  }
});
