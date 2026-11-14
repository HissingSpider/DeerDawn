/**
 * Every plan price /select-plan and /settings/upgrade RENDER is the price —
 * in each toggle state, and on the card of the plan the reader already pays for.
 *
 * Round 3 of the journey scan (2026-09-28) found, on the rendered pages:
 *   - /select-plan on the Annual toggle said "Team is $15 a seat" while
 *     /settings/upgrade showed $12.50 for the same choice;
 *   - /settings/upgrade on the Annual toggle labelled a MONTHLY Pro
 *     subscriber's card "Current plan, Pro $8/mo". They pay $12.
 * Every figure in both came from planCopy, which CI pins to plans.js, so no
 * test of the numbers could see either. What was wrong was which figure a page
 * chose to print in which state. So these render the components the two pages
 * print prices through, in every state a reader can put them in, and compare
 * what comes out against figures derived here from the planCopy constants.
 *
 * The owner's table (2026-11): Team monthly is $15 per seat per month; Team
 * yearly is $12.50 per seat per month, $150 per seat billed yearly; Individual
 * is $12 a month, or $96 a year ($8 a month). A card marked "Current plan" shows
 * what that person is charged on their own cycle, whatever the toggle shows.
 *
 * A .ts file using createElement, not .tsx, so the `src/lib/*.test.ts` glob in
 * `npm test` picks it up (see authorizeAccountBadge.test.ts).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RouterContext } from 'next/dist/shared/lib/router-context.shared-runtime';
import type { NextRouter } from 'next/router';

import Checkout from '../pages/checkout';
import { PERSONAL_PLANS, SelectPlanChoices } from '../components/billing/SelectPlanChoices';
import { UpgradePlanCards } from '../components/billing/UpgradePlanCards';
import {
  ANNUAL_SAVING,
  PRICE_ANNUAL,
  PRICE_MONTHLY,
  TEAM_PRICE_ANNUAL,
  TEAM_PRICE_MONTHLY,
  money,
} from './planCopy';

type Cycle = 'monthly' | 'annual';
const CYCLES: Cycle[] = ['monthly', 'annual'];

// ── The table, derived from the mirror constants (pinned to plans.js) ───────
// To the cent, because that is what a page prints: an annual per-month figure
// need not be whole ($150/12 = $12.50), and a price like $100/12 renders "$8.33",
// which read back as 8.33 is not 100/12.
const cents = (n: number) => Math.round(n * 100) / 100;
const PRO = { monthly: PRICE_MONTHLY, annual: PRICE_ANNUAL, annualPerMonth: cents(PRICE_ANNUAL / 12), saving: PRICE_MONTHLY * 12 - PRICE_ANNUAL };
const TEAM = { monthly: TEAM_PRICE_MONTHLY, annual: TEAM_PRICE_ANNUAL, annualPerMonth: cents(TEAM_PRICE_ANNUAL / 12), saving: TEAM_PRICE_MONTHLY * 12 - TEAM_PRICE_ANNUAL };
/** The figures a cycle is stated in. Annual shows the per-month equivalent AND the yearly total. */
const figuresFor = (plan: typeof PRO, cycle: Cycle) => (cycle === 'annual' ? [plan.annualPerMonth, plan.annual] : [plan.monthly]);
const other = (cycle: Cycle): Cycle => (cycle === 'annual' ? 'monthly' : 'annual');
/** Figures that are Team's and nobody else's. */
const TEAM_ONLY = Object.values(TEAM).filter((n) => !Object.values(PRO).includes(n));

// ── Reading rendered markup the way a person reads it ───────────────────────
function readable(html: string): string {
  return html
    .replace(/<!-- -->/g, '')
    .replace(/<\/(div|p|li|button|h1|h2|h3|section)>/g, '\n')
    .replace(/<svg[\s\S]*?<\/svg>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

/** The element carrying `attr`, found by balancing tags of its own name. */
function element(html: string, attr: string): string {
  const at = html.indexOf(attr);
  assert.notEqual(at, -1, `nothing rendered with ${attr}`);
  const open = html.lastIndexOf('<', at);
  const name = /^<(\w+)/.exec(html.slice(open))![1];
  const tag = new RegExp(`<\\/?${name}\\b[^>]*>`, 'g');
  tag.lastIndex = open;
  let depth = 0;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return readable(html.slice(open, m.index + m[0].length));
  }
  throw new Error('unbalanced markup');
}

/** The price block of a card: the lines that state money. */
const priced = (text: string) => text.split('\n').filter((l) => /\$\d/.test(l));
const figures = (text: string) => [...text.matchAll(/\$(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
const clauses = (text: string) => text.split('\n').flatMap((l) => l.split(/\s[·—]\s|,\s|\.\s|\s\(|\)/)).map((c) => c.trim()).filter(Boolean);

/**
 * Clauses that state a Team figure without saying what it is per. Team is sold
 * per seat with a two-seat floor, so a figure without "seat" reads as the bill;
 * and a price without its cycle is a different price — $15 and $12.50 are a
 * month, $150 is a year.
 */
function teamClausesWithoutUnit(text: string): string[] {
  return clauses(text).filter((c) => {
    const team = figures(c).filter((n) => TEAM_ONLY.includes(n));
    if (!team.length) return false;
    if (!/\bseat\b|\/seat/.test(c)) return true;
    return team.some((n) => ((n === TEAM.monthly || n === TEAM.annualPerMonth) && !/month|\/mo\b/.test(c))
      || (n === TEAM.annual && !/year|\/yr\b/.test(c)));
  });
}

// ── /select-plan ────────────────────────────────────────────────────────────
function selectPlan(billing: Cycle): string {
  return renderToStaticMarkup(createElement(SelectPlanChoices, {
    plans: PERSONAL_PLANS,
    billing,
    isLoading: false,
    activePlan: null,
    onContinueFree: () => undefined,
    onCheckout: () => undefined,
    onSeeTeam: () => undefined,
  }));
}

for (const billing of CYCLES) {
  test(`/select-plan, ${billing}: the Team pointer states Team's ${billing} price, per seat`, () => {
    const pointer = element(selectPlan(billing), 'data-plan-pointer="developer_pro"');
    for (const n of figuresFor(TEAM, billing)) {
      assert.ok(pointer.includes(money(n)), `${billing}: the Team line should state ${money(n)}: "${pointer}"`);
    }
    for (const n of figuresFor(TEAM, other(billing)).filter((n) => !figuresFor(TEAM, billing).includes(n))) {
      assert.ok(!figures(pointer).includes(n),
        `${billing}: the Team line states ${money(n)}, the ${other(billing)} price: "${pointer}"`);
    }
    assert.deepEqual(teamClausesWithoutUnit(pointer), [], `a Team figure without its seat: "${pointer}"`);
  });

  test(`/select-plan, ${billing}: the Pro card states Pro's ${billing} price`, () => {
    const pro = priced(element(selectPlan(billing), 'data-plan="developer_basic"')).join('\n');
    for (const n of figuresFor(PRO, billing)) {
      assert.ok(figures(pro).includes(n), `${billing}: the Pro card should state ${money(n)}:\n${pro}`);
    }
    if (billing === 'monthly') {
      assert.deepEqual(figures(pro), [PRO.monthly], `monthly Pro card:\n${pro}`);
    } else {
      assert.ok(!figures(pro).includes(PRO.monthly), `the annual Pro card states the monthly ${money(PRO.monthly)}:\n${pro}`);
    }
  });
}

// ── /settings/upgrade ───────────────────────────────────────────────────────
type Account = { name: string; tier: string; cycle: Cycle | null; stripeCustomerId: string | null };
const ACCOUNTS: Account[] = [
  { name: 'Free', tier: 'free', cycle: null, stripeCustomerId: null },
  { name: 'Pro monthly', tier: 'developer_basic', cycle: 'monthly', stripeCustomerId: 'cus_x' },
  { name: 'Pro yearly', tier: 'developer_basic', cycle: 'annual', stripeCustomerId: 'cus_x' },
  { name: 'Team monthly', tier: 'developer_pro', cycle: 'monthly', stripeCustomerId: 'cus_x' },
  { name: 'Team yearly', tier: 'developer_pro', cycle: 'annual', stripeCustomerId: 'cus_x' },
];

function upgrade(billing: Cycle, account: Account, cycleKnown = true): string {
  return renderToStaticMarkup(createElement(UpgradePlanCards, {
    billing,
    currentTier: account.tier,
    currentCycle: cycleKnown ? account.cycle : null,
    stripeCustomerId: account.stripeCustomerId,
    redirecting: null,
    onUpgrade: () => undefined,
    onPortal: () => undefined,
  } as Parameters<typeof UpgradePlanCards>[0]));
}

const PLAN_OF: Record<string, typeof PRO> = { developer_basic: PRO, developer_pro: TEAM };

for (const account of ACCOUNTS) {
  for (const billing of CYCLES) {
    test(`/settings/upgrade, ${account.name} subscriber, ${billing} toggle: every paid card states the right cycle`, () => {
      const html = upgrade(billing, account);
      for (const planId of ['developer_basic', 'developer_pro']) {
        const plan = PLAN_OF[planId];
        const card = element(html, `data-plan="${planId}"`);
        const isCurrent = account.tier === planId;
        // The card of the plan this person pays for states THEIR cycle; every
        // other card follows the toggle.
        const cycle = isCurrent ? account.cycle! : billing;
        const lines = priced(card).join('\n');
        for (const n of figuresFor(plan, cycle)) {
          assert.ok(figures(lines).includes(n),
            `${account.name}, ${billing} toggle, ${planId}${isCurrent ? ' (current plan)' : ''}: should state ${money(n)}:\n${lines}`);
        }
        for (const n of figuresFor(plan, other(cycle)).filter((n) => !figuresFor(plan, cycle).includes(n))) {
          assert.ok(!figures(lines).includes(n),
            `${account.name}, ${billing} toggle, ${planId}${isCurrent ? ' (current plan)' : ''}: states ${money(n)}, `
            + `the ${other(cycle)} price${isCurrent ? `, on the card of somebody billed ${cycle}` : ''}:\n${lines}`);
        }
        if (planId === 'developer_pro') {
          assert.deepEqual(teamClausesWithoutUnit(lines), [], `a Team figure without its seat:\n${lines}`);
        }
      }
    });
  }
}

test('/settings/upgrade: a current plan whose cycle is not known states both cycles and neither alone', () => {
  // A trial, or a period whose end is within the month (monthly, or the last
  // month of a year): the page cannot tell, so it must not pick the toggle's.
  for (const account of ACCOUNTS.filter((a) => a.tier !== 'free')) {
    for (const billing of CYCLES) {
      const plan = PLAN_OF[account.tier];
      const lines = priced(element(upgrade(billing, account, false), `data-plan="${account.tier}"`)).join('\n');
      for (const n of [plan.monthly, plan.annual]) {
        assert.ok(figures(lines).includes(n), `${account.name}, ${billing} toggle, cycle unknown: should state ${money(n)}:\n${lines}`);
      }
      assert.match(lines, new RegExp(`\\${money(plan.monthly)}(/seat)?/mo\\b`),
        `${account.name}, cycle unknown: the monthly figure has to say it is monthly:\n${lines}`);
      assert.match(lines, new RegExp(`\\${money(plan.annual)}(/seat)?/yr\\b`),
        `${account.name}, cycle unknown: the yearly figure has to say it is yearly:\n${lines}`);
    }
  }
});

// ── /checkout, every link shape ─────────────────────────────────────────────
// The page is rendered whole: its plan summary prints before any request is
// made, and it is the first thing a buyer arriving from a pricing card reads.
function checkout(query: Record<string, string>): string {
  const search = new URLSearchParams(query).toString();
  const router = {
    pathname: '/checkout', route: '/checkout', asPath: `/checkout?${search}`, query, basePath: '',
    isReady: true, isFallback: false,
    push: async () => true, replace: async () => true, prefetch: async () => undefined,
    events: { on() {}, off() {}, emit() {} },
  } as unknown as NextRouter;
  return readable(renderToStaticMarkup(createElement(RouterContext.Provider, { value: router }, createElement(Checkout))));
}

const LINKS: Array<Record<string, string>> = [
  { plan: 'developer_pro', billing: 'annual', seats: '2' },
  { plan: 'developer_pro', billing: 'monthly', seats: '2' },
  { plan: 'developer_pro' },
  { plan: 'developer_basic', billing: 'annual' },
  { plan: 'developer_basic', billing: 'monthly' },
  { plan: 'developer_basic' },
];

for (const query of LINKS) {
  test(`/checkout?${new URLSearchParams(query)}: every price it states is the price, per seat and per cycle`, () => {
    const text = checkout(query);
    assert.ok(text.includes('Complete checkout for'), `the page did not render:\n${text.slice(0, 400)}`);
    const plan = query.plan === 'developer_pro' ? TEAM : PRO;
    const stated = figures(priced(text).join('\n'));
    // The summary names both cycles, whatever the link carried: the cadence is
    // on its own line beneath it.
    for (const n of [plan.monthly, plan.annual]) {
      assert.ok(stated.includes(n), `should state ${money(n)}:\n${priced(text).join('\n')}`);
    }
    const stray = stated.filter((n) => !Object.values(plan).includes(n));
    assert.deepEqual(stray, [], `states ${stray.map(money).join(', ')}, which is not a price of this plan:\n${priced(text).join('\n')}`);
    assert.deepEqual(teamClausesWithoutUnit(text), [], `a Team figure without its seat or its cycle:\n${priced(text).join('\n')}`);
  });
}

// ── Each card states its own saving, computed from plans.js ─────────────────
// Owner decision (2026-09-29): the annual saving lives on each plan card. The
// "-33%" on /select-plan's toggle (with "Applies to Pro" beside it) and "save up
// to 33%" on /settings/upgrade's were one number over cards that save different
// amounts, so the toggles carry no figure and the cards carry their own. The
// figures are parsed from plans.js as text so a drifted planCopy cannot pass.
const PLANS_JS = readFileSync(join(import.meta.dirname, '../../../api/src/config/plans.js'), 'utf8');

function savingFromPlansJs(id: string): number {
  const start = PLANS_JS.indexOf(`  ${id}: {`);
  assert.notEqual(start, -1, `plans.js no longer defines ${id}`);
  const block = PLANS_JS.slice(start, PLANS_JS.indexOf('\n  },\n', start));
  const price = Number(/\n\s*price:\s*(\d+)/.exec(block)![1]);
  const annual = Number(/annual_price:\s*(\d+)/.exec(block)![1]);
  return price * 12 - annual;
}

test('/select-plan, annual: the Pro card states its own saving, from plans.js', () => {
  const saving = savingFromPlansJs('developer_basic');
  const pro = element(selectPlan('annual'), 'data-plan="developer_basic"');
  assert.ok(pro.includes(`save ${money(saving)}`), `the Pro card should say it saves ${money(saving)}:\n${pro}`);
  assert.ok(!/save/i.test(element(selectPlan('monthly'), 'data-plan="developer_basic"')), 'the monthly card advertises a saving');
});

test('/settings/upgrade, annual: each card states its own saving, per seat on Team', () => {
  const html = upgrade('annual', ACCOUNTS[0]);
  const pro = element(html, 'data-plan="developer_basic"');
  const team = element(html, 'data-plan="developer_pro"');
  const proSaving = savingFromPlansJs('developer_basic');
  const teamSaving = savingFromPlansJs('developer_pro');
  assert.ok(pro.includes(`save ${money(proSaving)}`) && !/save[^\n]*per seat/.test(pro), `Pro card:\n${pro}`);
  assert.ok(team.includes(`save ${money(teamSaving)} per seat`), `Team card should say it saves ${money(teamSaving)} per seat:\n${team}`);
  assert.ok(!/a seat/.test(team), `Team says "a seat", the wording is "per seat":\n${team}`);
});

/** The page's own JSX with comments removed: the pages cannot be rendered past their session check. */
function pageCode(rel: string): string {
  return readFileSync(join(import.meta.dirname, '..', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

for (const rel of ['pages/select-plan.tsx', 'pages/settings/upgrade.tsx', 'components/dashboard/PostSyncModal.tsx']) {
  test(`${rel}: the Annual toggle carries no shared discount figure`, () => {
    const code = pageCode(rel);
    assert.doesNotMatch(code, /ANNUAL_DISCOUNT_PCT|BEST_ANNUAL_DISCOUNT_PCT/, 'a percentage computed once for every card is on the toggle');
    assert.doesNotMatch(code, /Applies to/, 'a note narrowing the toggle to one plan is back');
    assert.doesNotMatch(code, /save up to/i);
  });
}

test('PostSyncModal states its saving in dollars, read from planCopy, like the pricing page', () => {
  const code = pageCode('components/dashboard/PostSyncModal.tsx');
  assert.match(code, /Save \{money\(ANNUAL_SAVING\)\}/, 'the annual badge should be "Save $N", N from ANNUAL_SAVING');
  assert.equal(ANNUAL_SAVING, savingFromPlansJs('developer_basic'), 'planCopy ANNUAL_SAVING has drifted from plans.js');
});

test('no dashboard source advertises the annual saving as a percentage', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx$/.test(name) && !/\.test\./.test(name)) {
        const code = readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
        if (/\bSave\s+\{[^}]*\}\s*%|save up to|-\{[A-Z_]*DISCOUNT[A-Z_]*\}%/i.test(code)) offenders.push(full);
      }
    }
  };
  walk(join(import.meta.dirname, '..'));
  assert.deepEqual(offenders, [], 'the saving is stated in dollars on each card, never as one percentage');
});
