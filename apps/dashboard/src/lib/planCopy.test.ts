/**
 * The dashboard's plan copy must agree with the plan the server enforces.
 *
 * This exists because of a real failure, not a hypothetical one. On 2026-08-27
 * the free tier went from "3 projects, 7-day history" to "unlimited projects,
 * 90-day history" in apps/api/src/config/plans.js, and a dozen dashboard
 * surfaces kept the old numbers. One of them — the upgrade banner — went on
 * telling free users to pay $10 to "unlock unlimited workspaces" they had just
 * been given for nothing. Nothing failed; the copy simply became false.
 *
 * plans.js is parsed as TEXT rather than required, because apps/api is CommonJS
 * and the dashboard is an ESM/TS workspace — the same approach the marketing
 * suite already uses for the refund policy.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  ANNUAL_DISCOUNT_PCT,
  ANNUAL_SAVING,
  PRICE_MONTHLY,
  PRICE_ANNUAL,
  PRICE_ANNUAL_PER_MONTH,
  TEAM_ANNUAL_SAVING,
  TEAM_PRICE_ANNUAL_PER_MONTH,
  TEAM_PRICE_MONTHLY,
  TEAM_PRICE_ANNUAL,
  TEAM_MIN_SEATS,
  TEAM_TRIAL_DAYS,
  MONTHLY_LABEL,
  money,
  ANNUAL_LABEL,
  PRO_PLAN_NAME,
  TEAM_PLAN_NAME,
  SELF_SERVE_PLAN_IDS,
  isSelfServePlan,
  minSeatsFor,
  describeFreeBound,
  billingCycleOnRecord,
  teamPricePhrase,
} from './planCopy';

const REPO_ROOT = join(import.meta.dirname, '../../../..');
const plans = readFileSync(join(REPO_ROOT, 'apps/api/src/config/plans.js'), 'utf8');

/** Pull one plan's literal block out of plans.js. */
function planBlock(id: string): string {
  const start = plans.indexOf(`  ${id}: {`);
  assert.notStrictEqual(start, -1, `plans.js no longer defines a \`${id}\` plan — re-point this test`);
  const end = plans.indexOf('\n  },\n', start);
  assert.ok(end > start, `plans.js \`${id}\` block is not terminated as expected`);
  return plans.slice(start, end);
}

function numberField(block: string, field: string): number | null {
  const match = new RegExp(`${field}:\\s*(\\d+|null)`).exec(block);
  assert.ok(match, `expected a ${field} on this plan`);
  return match[1] === 'null' ? null : Number(match[1]);
}

test('the displayed Team numbers are the numbers plans.js declares', () => {
  const team = planBlock('developer_pro');
  assert.strictEqual(numberField(team, 'price'), TEAM_PRICE_MONTHLY,
    'planCopy.TEAM_PRICE_MONTHLY has drifted from plans.js developer_pro.price');
  assert.strictEqual(numberField(team, 'annual_price'), TEAM_PRICE_ANNUAL,
    'planCopy.TEAM_PRICE_ANNUAL has drifted from plans.js developer_pro.annual_price');
  assert.strictEqual(numberField(team, 'minimum_seats'), TEAM_MIN_SEATS,
    'planCopy.TEAM_MIN_SEATS has drifted from plans.js — the conversion value floor is wrong');
  assert.strictEqual(numberField(team, 'trial_days'), TEAM_TRIAL_DAYS,
    'planCopy.TEAM_TRIAL_DAYS has drifted from the trial the checkout actually grants');
});

test('the displayed Pro price is the price plans.js declares', () => {
  const pro = planBlock('developer_basic');
  assert.strictEqual(numberField(pro, 'price'), PRICE_MONTHLY,
    'planCopy.PRICE_MONTHLY has drifted from plans.js developer_basic.price');
  assert.strictEqual(numberField(pro, 'annual_price'), PRICE_ANNUAL,
    'planCopy.PRICE_ANNUAL has drifted from plans.js developer_basic.annual_price');
});

/**
 * The set of plans the client will take to checkout has to be the set the API
 * accepts. When they disagreed — the dashboard had `['developer_basic']` while
 * the API had both — the disagreement was invisible: the client simply never
 * called, and rendered "contact sales" for a plan with a live Stripe price.
 */
test('the self-serve set matches the one the API enforces', () => {
  const served = /const SELF_SERVE_PLAN_IDS\s*=\s*\[([^\]]*)\]/.exec(plans);
  assert.ok(served, 'plans.js no longer declares SELF_SERVE_PLAN_IDS — re-point this test');
  const ids = (served[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1)).sort();
  assert.deepStrictEqual([...SELF_SERVE_PLAN_IDS].sort(), ids,
    'the dashboard would offer a cart for a different set of plans than the API accepts');

  for (const id of ids) assert.ok(isSelfServePlan(id));
  assert.ok(!isSelfServePlan('enterprise'), 'a sales-assisted plan must not get a cart');
  assert.ok(!isSelfServePlan(null));
});

/**
 * The seat floor the client opens Stripe at must be the plan's, not 1. The
 * server clamps either way, so getting this wrong is not a mispriced sale — it
 * is a quantity that changes under the buyer on Stripe's own page.
 */
test('per-seat checkouts open at the plan floor', () => {
  assert.strictEqual(minSeatsFor('developer_pro'), TEAM_MIN_SEATS);
  assert.strictEqual(minSeatsFor('developer_basic'), 1, 'Pro is per person; a quantity would multiply one human');
  assert.strictEqual(minSeatsFor(null), 1);
});

test('the displayed plan names are the names plans.js publishes', () => {
  for (const [id, expected] of [['developer_basic', PRO_PLAN_NAME], ['developer_pro', TEAM_PLAN_NAME]] as const) {
    const match = /publicName:\s*'([^']+)'/.exec(planBlock(id));
    assert.ok(match, `expected a publicName on ${id}`);
    assert.strictEqual(match[1], expected,
      `the dashboard calls ${id} "${expected}" but the server publishes it as "${match[1]}"`);
  }
});

/**
 * Read code, never prose. The comments in these surfaces explain the drift they
 * are avoiding, and they do it by quoting the stale literal — checkout.tsx and
 * select-plan.tsx both say "$96 collected once beats $10" in a comment, and
 * UpgradeSuccessModal.tsx names the superseded $10 outright. A source scan that
 * cannot tell code from commentary either fails on those explanations or gets
 * watered down until it catches nothing. (Same lesson as the connectCopy mirror
 * test and the marketing /pricing scan.)
 *
 * Import lines are dropped for the same reason: `import { PRICE_MONTHLY }` is
 * how a surface does the right thing, not a place copy is rendered.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line) && !/^\s*import\b/.test(line))
    .join('\n');
}

/**
 * Directories holding rendered plan copy, relative to the app root.
 *
 * src/lib is in the list because a label defined there is rendered by every
 * surface that imports it: planLabels.ts called developer_basic "Founding Pro"
 * — the retired name this guard exists to ban — and put it in the top-nav
 * badge, the settings page and the upgrade-success modal without ever
 * appearing under src/components or src/pages.
 */
const SEARCH_DIRS = ['src/components', 'src/lib', 'src/pages'];

/** planCopy.ts is where these values are DEFINED; its own test reads them. */
const NOT_A_SURFACE = /(^|\/)planCopy\.ts$|\.test\.tsx?$/;

/** Every dashboard surface, as comment-stripped source. */
function surfaces(): Array<{ path: string; code: string }> {
  const found: Array<{ path: string; code: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (NOT_A_SURFACE.test(full)) continue;
      found.push({
        path: full.replace(REPO_ROOT + '/', ''),
        code: codeOnly(readFileSync(full, 'utf8')),
      });
    }
  };
  for (const dir of SEARCH_DIRS) walk(join(import.meta.dirname, '../..', dir));
  assert.ok(found.length > 0, `no surfaces found under ${SEARCH_DIRS.join(', ')} — the layout moved`);
  return found;
}

test('no dashboard surface hard-codes a price or the old plan name', () => {
  // The whole point of planCopy is that these strings live in exactly one place.
  //
  // This used to enumerate the prices it knew about — `$10/mo`, `'$12'`,
  // `$96/year` — which meant it only ever caught drift toward a number someone
  // had already thought to list. #359 added this guard and a hard-coded
  // `$200/year` in PostSyncModal in the SAME commit, and the guard never saw it:
  // 200 was not on the list. That file imports PRICE_FUTURE_ANNUAL and
  // interpolates it correctly on two other lines, so the literal was a straggler,
  // not a decision. A price-agnostic shape is the only version that catches the
  // NEXT price rather than the last one.
  //
  // `$` immediately followed by a digit is a typed amount. Everything derived
  // reads `$${PRICE_X}` in a template literal or `${PRICE_X}` in JSX — a `$`
  // followed by `{`, never by a digit — so the two shapes cannot collide and
  // this needs no allowlist beyond free.
  const offenders: string[] = [];
  for (const { path, code } of surfaces()) {
    for (const match of code.matchAll(/\$\d[\d,.]*/g)) {
      // Free is free. $0 is not a price that can drift from plans.js, and it is
      // the one amount with no constant to import. Note this is an exact match:
      // "$0.99" is a real price and still fails.
      if (match[0] === '$0') continue;
      offenders.push(`${path}: hard-codes "${match[0]}"`);
    }
    if (/Founding Pro/.test(code)) offenders.push(`${path}: hard-codes "Founding Pro"`);
  }
  assert.deepStrictEqual(offenders, [],
    `these files write plan copy as a literal instead of importing from lib/planCopy:\n  ${offenders.join('\n  ')}`);
});

/**
 * A price written as a bare NUMBER is the same drift with the dollar sign left
 * off, and the test above cannot see it.
 *
 * /settings/upgrade — the highest-intent upgrade surface in the product — built
 * its cards from `price: 10, annualPrice: 8`, and kept quoting $10 for the six
 * days after Pro moved to $12 and the Stripe price was repointed. The scan for
 * `$` followed by a digit walked straight past it: the `$` in that card lives
 * in the JSX (`${plan.price}`), not next to the literal. /select-plan carried
 * the same shape in `ANNUAL_PRICES = { developer_basic: 8 }`.
 *
 * So: a numeric literal on a field whose name mentions a price, or inside a
 * declaration whose name does, has to come from planCopy instead. Zero is
 * exempt for the same reason "$0" is — free is free, and there is no constant
 * to import for it.
 */
test('no dashboard surface writes a price as a bare number either', () => {
  const offenders: string[] = [];
  for (const { path, code } of surfaces()) {
    // `price: 12`, `annualPrice: 8`, `monthlyPrice: 15` — a numeric literal on
    // a price-named field. Anything derived reads `price: PRICE_MONTHLY`.
    for (const match of code.matchAll(/\b(\w*[Pp]rice\w*)\s*:\s*(\d[\d_.]*)/g)) {
      if (Number(match[2]) === 0) continue;
      offenders.push(`${path}: hard-codes ${match[1]}: ${match[2]}`);
    }
    // `const ANNUAL_PRICES = { developer_basic: 8 }` — the field name is a plan
    // id, so the rule above cannot see it; the DECLARATION is what names a price.
    for (const match of code.matchAll(/\b(?:const|let)\s+(\w*PRICES?\w*|\w*[Pp]rices?)\s*(?::[^=]+)?=\s*\{([^}]*)\}/g)) {
      for (const value of match[2].matchAll(/:\s*(\d[\d_.]*)/g)) {
        if (Number(value[1]) === 0) continue;
        offenders.push(`${path}: hard-codes ${value[1]} inside ${match[1]}`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [],
    `these files write a price as a number instead of importing it from lib/planCopy:\n  ${offenders.join('\n  ')}`);
});

/**
 * The derived annual figures have to describe the two prices they sit beside.
 *
 * Both plan pickers advertised "-20%" next to $12 and $96, which is a third
 * off, not a fifth — and marketing's /pricing card, which computes the same
 * number, has been printing 33 next to the dashboard's 20 the whole time.
 */
test('the annual comparison is derived from the two prices, not typed', () => {
  assert.strictEqual(PRICE_ANNUAL_PER_MONTH, PRICE_ANNUAL / 12);
  assert.strictEqual(ANNUAL_SAVING, PRICE_MONTHLY * 12 - PRICE_ANNUAL);
  assert.strictEqual(ANNUAL_DISCOUNT_PCT, Math.round((ANNUAL_SAVING / (PRICE_MONTHLY * 12)) * 100));
  assert.strictEqual(TEAM_PRICE_ANNUAL_PER_MONTH, TEAM_PRICE_ANNUAL / 12);
  assert.strictEqual(TEAM_ANNUAL_SAVING, TEAM_PRICE_MONTHLY * 12 - TEAM_PRICE_ANNUAL);
});

/**
 * `money()` exists because Team's annual price per seat is $12.50 — the first
 * plan figure that is not a whole number. Pasting it after a `$` would print
 * "$12.5", and rounding it would print a price nobody is charged.
 */
test('money() prints whole dollars whole and cents in full', () => {
  assert.strictEqual(money(12), '$12');
  assert.strictEqual(money(12.5), '$12.50');
  // Team's $150/seat/yr is $12.50 a month and Individual's $96/yr is $8 — the
  // first keeps exactly two cents digits, the second stays whole.
  assert.strictEqual(money(TEAM_PRICE_ANNUAL_PER_MONTH), '$12.50');
  assert.strictEqual(money(PRICE_ANNUAL_PER_MONTH), '$8');
  // A non-whole figure is rounded to the cent, never printed in full.
  assert.strictEqual(money(100 / 12), '$8.33');
  assert.strictEqual(money(0), '$0');
});

test('the price labels keep the dollar sign glued to the number', () => {
  // Shape, not presence. A dropped `$` turns "$12/mo" into "12/mo", which still
  // contains the price and still passes anything that merely looks for the
  // number — so assert the character, not its neighbourhood.
  assert.match(MONTHLY_LABEL, /^\$\d+\/mo$/,
    `MONTHLY_LABEL is "${MONTHLY_LABEL}" — it must read "$${PRICE_MONTHLY}/mo", dollar sign included`);
  assert.match(ANNUAL_LABEL, /^\$\d+\/year$/,
    `ANNUAL_LABEL is "${ANNUAL_LABEL}" — it must read "$${PRICE_ANNUAL}/year", dollar sign included`);
  assert.strictEqual(MONTHLY_LABEL, `$${PRICE_MONTHLY}/mo`);
  assert.strictEqual(ANNUAL_LABEL, `$${PRICE_ANNUAL}/year`);
});

/**
 * The raw numbers, for the surfaces that render an amount without the label —
 * a plan card that prints the figure large and the period beside it.
 *
 * The dollar sign in front of these is a LITERAL character, and how many times
 * it must be typed depends on where it sits. In JSX, `${PRICE_X}` is a literal
 * `$` followed by an expression — one. Inside a template literal the identical
 * output has to be written `$${PRICE_X}` — two, because the second belongs to
 * `${}` itself.
 *
 * That distinction is the whole point of this test. "Is there a `$` before the
 * brace?" cannot see it: in a template literal the interpolation always brings
 * its own `$`, so that check passes on `${PRICE_MONTHLY}` — which renders "12",
 * not "$12". This was not hypothetical; the first version of this guard was
 * written that way and a mutation walked straight through it. So count the run
 * of `$`, subtract the one the syntax owns, and require exactly one to survive
 * as text.
 */
// The Team price constants are deliberately NOT here: no surface renders them
// as prose yet — they feed the conversion VALUE in UpgradeSuccessModal, a
// number, not copy. Add them the day a surface interpolates one into text.
const MONEY = ['PRICE_MONTHLY', 'PRICE_ANNUAL'];

/**
 * An odd number of backticks before this point means we are inside an unclosed
 * template literal. Comments are stripped before this runs, and these surfaces
 * put backticks nowhere else.
 */
function inTemplateLiteral(code: string, index: number): boolean {
  return (code.slice(0, index).match(/`/g) || []).length % 2 === 1;
}

test('every raw price a surface interpolates carries a dollar sign', () => {
  const seen = new Map(MONEY.map((ident) => [ident, 0]));
  for (const { path, code } of surfaces()) {
    for (const ident of MONEY) {
      const needle = `{${ident}}`;
      let index = code.indexOf(needle);
      while (index !== -1) {
        seen.set(ident, seen.get(ident)! + 1);
        let run = 0;
        while (code[index - 1 - run] === '$') run += 1;
        const literal = run - (inTemplateLiteral(code, index) ? 1 : 0);
        const line = code.slice(0, index).split('\n').length;
        assert.strictEqual(literal, 1,
          `${path}:${line} renders ${ident} with ${literal} literal dollar sign(s), not 1 — ` +
            `it prints "${'$'.repeat(Math.max(literal, 0))}${PRICE_MONTHLY}/mo" where the reader ` +
            `expects "$${PRICE_MONTHLY}/mo". In JSX write ${'${'}${ident}}; inside a template ` +
            `literal write $${'${'}${ident}} — the second dollar belongs to the interpolation.`);
        index = code.indexOf(needle, index + 1);
      }
    }
  }
  for (const [ident, count] of seen) {
    assert.ok(count > 0,
      `no dashboard surface interpolates ${ident} any more — if it was renamed or the last ` +
        'caller moved to a label, update MONEY, or this guard silently stops guarding it');
  }
});

/**
 * The owner's decision (journey scan round 4): the product states today's
 * price and nothing about a future one. The post-sync upsell said "locks in
 * $96/year before the price moves to $200/year", struck "$200/year" through as
 * a "Future price", and asked the reader to "Lock in $96/year before Pro moves
 * to $200/year", while the Terms say a renewal is charged at the then-current
 * price: nothing is locked in. The $200 constant is gone, and no surface may
 * bring the promise back in other words.
 */
test('no dashboard surface promises a price lock or names a future price', async () => {
  const planCopy = await import('./planCopy');
  assert.ok(!('PRICE_FUTURE_ANNUAL' in planCopy), 'planCopy still exports a future price for a surface to render');
  const offenders: string[] = [];
  for (const { path, code } of surfaces()) {
    for (const claim of [/\blocks? in\b/i, /future price/i, /price moves to|moves to \$+\{?PRICE|moves to \$\d/i, /\beventual\b/i, /PRICE_FUTURE/]) {
      const match = claim.exec(code);
      if (match) offenders.push(`${path}: "${code.slice(Math.max(0, match.index - 40), match.index + 40).replace(/\s+/g, ' ')}"`);
    }
  }
  assert.deepStrictEqual(offenders, [], `these surfaces still sell a future price:\n  ${offenders.join('\n  ')}`);
});

test('describeFreeBound reads the live entitlement, never a hard-coded cap', () => {
  // Today's free plan: uncapped projects, bounded history. The sentence must not
  // imply a project cap that no longer exists.
  const free = describeFreeBound({ included_projects: null, history_days: 90 });
  assert.ok(free && /90 days of history/.test(free));
  assert.ok(free && /unlimited projects/.test(free), 'must say projects are unlimited, not omit it');
  assert.ok(free && !/\bworkspaces\b/.test(free), 'must not describe a workspace cap that is gone');

  // A referral month grants Pro limits while plan_tier still reads 'free'.
  // Nothing left to sell means nothing should be said.
  assert.strictEqual(describeFreeBound({ included_projects: null, history_days: null }), null);
  assert.strictEqual(describeFreeBound(undefined), null);

  // Still correct if a future plan reintroduces a project cap.
  const capped = describeFreeBound({ included_projects: 3, history_days: 7 });
  assert.ok(capped && /3 workspaces/.test(capped) && /7 days/.test(capped));
});


test('the plan page never invents a Free cap that plans.js does not declare', () => {
  // 2026-09 scan, defect 5. /settings/plan rendered `${projectLimit ?? 3}
  // workspaces` and `${historyDays ?? 7} days` — both of them the pre-2026-08-27
  // numbers — and orgs.js passes Free's `included_projects: null` straight
  // through, so the fallback fired for every free account. The sentence claimed
  // a three-workspace cap directly above a tile reading "Unlimited project
  // briefs", and a seven-day window against a real ninety.
  // Comment-blind: the explanation of why `?? 3` was wrong must not be the
  // thing that fails the test, or deleting the explanation is the fastest green.
  const page = readFileSync(join(REPO_ROOT, 'apps/dashboard/src/pages/settings/plan.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(!/\?\?\s*3\b/.test(page), 'a hard-coded project fallback is back on the plan page');
  assert.ok(!/\?\?\s*7\b/.test(page), 'a hard-coded history fallback is back on the plan page');
  assert.match(page, /describeFreeBound\(/, 'the Free sentence must come from the live entitlement');

  // And the helper itself must read a null cap as unlimited rather than as
  // absent, which is the whole reason the fallback was wrong.
  const withNullCap = describeFreeBound({ included_projects: null, history_days: 90 });
  assert.ok(withNullCap && !/\b3\b/.test(withNullCap));
  assert.ok(withNullCap && /90/.test(withNullCap));
});

// ── Which cycle a price is stated for (2026-09-28, journey round 3) ─────────

test('Team is stated per seat and per cycle, never as a bare "$15 a seat"', () => {
  // /select-plan on Annual said "Team is $15 a seat" while /settings/upgrade
  // showed $12.50 for the same choice.
  assert.strictEqual(teamPricePhrase('monthly'), `${money(TEAM_PRICE_MONTHLY)} per seat per month`);
  assert.strictEqual(
    teamPricePhrase('annual'),
    `${money(TEAM_PRICE_ANNUAL / 12)} per seat per month, ${money(TEAM_PRICE_ANNUAL)} per seat billed yearly`,
  );
});

test('the billing cycle on record is read off the period, and never guessed', () => {
  const DAY = 86_400_000;
  const now = Date.parse('2026-09-28T12:00:00Z');
  const iso = (offsetDays: number) => new Date(now + offsetDays * DAY).toISOString();

  // Both ends of the period: its length is the cycle.
  assert.strictEqual(billingCycleOnRecord({ subscription_status: 'active', billing_period_start: iso(-3), billing_period_end: iso(27) }, now), 'monthly');
  assert.strictEqual(billingCycleOnRecord({ subscription_status: 'active', billing_period_start: iso(-3), billing_period_end: iso(362) }, now), 'annual');
  // February is a month too.
  assert.strictEqual(billingCycleOnRecord({ subscription_status: 'active', billing_period_start: '2027-02-01T00:00:00Z', billing_period_end: '2027-03-01T00:00:00Z' }, now), 'monthly');
  // The last month of a year is still a year.
  assert.strictEqual(billingCycleOnRecord({ subscription_status: 'active', billing_period_start: iso(-345), billing_period_end: iso(20) }, now), 'annual');

  // Only the end (what the bootstrap sends): more than a month away is a year...
  assert.strictEqual(billingCycleOnRecord({ subscription_status: 'active', billing_period_end: iso(300) }, now), 'annual');
  // ...and within a month is monthly OR the end of a year, so it is not known.
  assert.strictEqual(billingCycleOnRecord({ subscription_status: 'active', billing_period_end: iso(30) }, now), null);

  // A trial's period is the trial, the same length on either cycle.
  assert.strictEqual(billingCycleOnRecord({ subscription_status: 'trialing', billing_period_start: iso(0), billing_period_end: iso(14) }, now), null);
  assert.strictEqual(billingCycleOnRecord({ subscription_status: 'trialing', billing_period_end: iso(300) }, now), null);

  // Nothing on record.
  assert.strictEqual(billingCycleOnRecord({ subscription_status: 'active', billing_period_end: null }, now), null);
  assert.strictEqual(billingCycleOnRecord(null, now), null);
  assert.strictEqual(billingCycleOnRecord({ billing_period_end: 'not a date' }, now), null);
});
