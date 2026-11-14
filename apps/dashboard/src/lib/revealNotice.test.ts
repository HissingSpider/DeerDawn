/**
 * JOURNEY R4 / D4-1 — a refused plan change has to be SEEN where it was refused.
 *
 * Round 3 turned the two billing refusals (the bank must confirm the payment; a
 * payment is overdue) into a notice carrying "Open the billing page", and
 * dropped the toast so the sentence was not said twice. On /settings/upgrade the
 * notice sits above the plan cards; on a phone the cards stack, so the pressed
 * "Upgrade to Team" was 860 to 1,180px below it (768 wide: 274px). The person
 * saw an unchanged screen, and focus fell to the page body because the pressed
 * button was disabled while it waited.
 *
 * The fix is a mechanism, not a position: whichever page renders the notice, a
 * new refusal takes focus and is scrolled to the NEAREST edge that shows it
 * whole. "Nearest" is a no-op for a notice already on screen, so a desktop
 * window, where it was always visible, does not move.
 *
 * A .ts file using createElement, not .tsx, so the `src/lib/*.test.ts` glob in
 * `npm test` picks it up (see billingRefusal.test.ts).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { revealNotice } from './revealNotice';
import { BillingRefusalNotice } from '../components/billing/BillingRefusalNotice';
import { PAYMENT_OVERDUE_LINE } from './billingRefusal';

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');
/** Block and line comments out, so the prose describing a fix cannot satisfy its test. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function fakeElement() {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    focus(options?: unknown) { calls.push(['focus', options]); },
    scrollIntoView(options?: unknown) { calls.push(['scrollIntoView', options]); },
  };
}

test('revealNotice gives the notice focus and scrolls it to the nearest edge, and nothing else', () => {
  const el = fakeElement();
  assert.equal(revealNotice(el), true);
  assert.deepEqual(el.calls, [
    // Focus first and without its own scroll, so the one scroll that happens is
    // the one chosen here: the nearest edge. "start" or "center" would move a
    // notice that is already on screen, and a desktop window with it.
    ['focus', { preventScroll: true }],
    ['scrollIntoView', { block: 'nearest', inline: 'nearest' }],
  ]);
  assert.equal(revealNotice(null), false, 'no element, nothing to do, and no throw');
  assert.equal(revealNotice(undefined), false);
});

test('the billing refusal can take focus without joining the tab order', () => {
  const html = renderToStaticMarkup(createElement(BillingRefusalNotice, {
    refusal: { code: 'payment_overdue', message: PAYMENT_OVERDUE_LINE },
    onOpenBilling: () => {},
  }));
  // tabindex=-1: focusable by script, skipped by Tab. Without it, focus() on a
  // div does nothing and focus stays on the page body.
  assert.match(html, /<div[^>]*role="alert"[^>]*tabindex="-1"|<div[^>]*tabindex="-1"[^>]*role="alert"/, html);
});

test('the billing refusal reveals itself for every new refusal, whichever page renders it', () => {
  const source = code('components/billing/BillingRefusalNotice.tsx');
  // The effect runs on each new refusal object, so a second refused press
  // (the same code again) is brought back into view as well.
  assert.match(source, /useEffect\(\s*\(\)\s*=>\s*\{[\s\S]*?revealNotice\(\s*ref\.current\s*\)[\s\S]*?\},\s*\[refusal\]\s*\)/,
    'the notice does not reveal itself when a refusal arrives');
  assert.match(source, /ref=\{ref\}/, 'the element revealed is not the notice');
});

// Every page that shows the notice after a press. None may also toast the same
// sentence: the notice is now visible where the person is looking, and saying
// it twice is what round 3 removed.
for (const page of ['pages/settings/upgrade.tsx', 'pages/settings/plan.tsx', 'pages/settings/team.tsx']) {
  test(`${page} shows a recognised refusal once, through the notice that reveals itself`, () => {
    const source = code(page);
    assert.match(source, /<BillingRefusalNotice\b/);
    const at = source.search(/const refusal = billingPageRefusal\((?:e|err|error)\);/);
    assert.ok(at >= 0, `${page}: the refusal is not read from the failed call`);
    // What the catch does next, up to its first toast.
    const after = source.slice(at);
    const recognised = after.slice(0, after.indexOf('showToast(') + 'showToast('.length);
    // Either `if (!refusal) showToast(…)` or `if (refusal) { …; return; }` before any toast.
    const guarded = /if\s*\(!refusal\)\s*showToast/.test(recognised)
      || /if\s*\(refusal\)\s*\{[^}]*return;?\s*\}/.test(recognised);
    assert.ok(guarded, `${page}: a recognised refusal also raises a toast:\n${recognised}`);
  });
}

test('/checkout brings its own refusal into view and gives it focus when a press is refused', () => {
  const source = code('pages/checkout.tsx');
  assert.match(source, /import \{ revealNotice \} from '@\/lib\/revealNotice'/);
  // The refused box is the element revealed, and it can hold focus.
  assert.match(source, /ref=\{refusalRef\}[\s\S]{0,200}tabIndex=\{-1\}|tabIndex=\{-1\}[\s\S]{0,200}ref=\{refusalRef\}/);
  // Only a refusal that answers a press moves anything: a refusal the page
  // arrives on (a member, a lower tier) is the page itself and is left alone.
  assert.match(source, /revealSubmitRefusal\.current = true;\s*setRefusalMsg\(failure\.message\)/);
  assert.match(source, /if \(status !== 'refused' \|\| !revealSubmitRefusal\.current\) return;[\s\S]{0,120}revealNotice\(refusalRef\.current\)/);
});

// ── The locked-workspace notice is announced (R4 item 4) ─────────────────────
//
// RefusalNotice renders through InlineErrorState IN PLACE of a page's content
// when the page's own load is refused. It had no role, so a screen reader was
// never told. It is `status`, not `alert`: it arrives with the page rather than
// answering something the reader just did, and a polite region waits for the
// page's own announcement instead of cutting it off. (The billing refusal is an
// `alert` because it answers a press.) InlineErrorState's other callers pass no
// role and render exactly what they rendered before.
test('the refused-load notice is a polite status region; every other inline error renders as before', async () => {
  const { RefusalNotice } = await import('../components/dashboard/RefusalNotice');
  const { InlineErrorState } = await import('../components/dashboard/PageScaffold');
  const owner = renderToStaticMarkup(createElement(RefusalNotice, {
    failure: { kind: 'subscription_inactive', reader: { role: 'owner' } },
  }));
  assert.match(owner, /^<div[^>]*role="status"/, owner);
  assert.match(owner, /Update billing/);
  const locked = renderToStaticMarkup(createElement(RefusalNotice, { failure: { kind: 'locked' } }));
  assert.match(locked, /^<div[^>]*role="status"/, locked);
  // Each lock offers what it can (owner's sentences, 2026-09-29): a dispute an
  // email to support and nothing about billing; somebody else's workspace a way
  // to leave it; an owner's own lockdown neither.
  const dispute = renderToStaticMarkup(createElement(RefusalNotice, { failure: { kind: 'locked', lockReason: 'dispute' } }));
  assert.match(dispute, /href="mailto:support@deerdawn\.com"/, dispute);
  assert.doesNotMatch(dispute, /settings\/plan|Update billing/);
  const foreign = renderToStaticMarkup(createElement(RefusalNotice, { failure: { kind: 'locked', lockReason: 'foreign_workspace' } }));
  assert.match(foreign, /<button[^>]*>Switch to your own workspace<\/button>/, foreign);
  assert.doesNotMatch(locked, /<button|<a /, 'a lockdown notice offers no button or link');
  const firstPayment = renderToStaticMarkup(createElement(RefusalNotice, {
    failure: { kind: 'subscription_inactive', reader: { role: 'owner' }, retryCheckout: { plan: 'developer_pro', seats: 3 } },
  }));
  assert.match(firstPayment, /href="\/checkout\?plan=developer_pro&amp;seats=3"[^>]*>Check out again</, firstPayment);

  const retry = renderToStaticMarkup(createElement(InlineErrorState, {
    title: 'Couldn’t load your plan', description: 'Try again.', onRetry: () => {},
  }));
  assert.doesNotMatch(retry, /\brole=/, 'an inline error that did not ask for a role gained one');
  assert.match(retry, /^<div class="rounded-2xl border border-status-danger\/25 bg-\[var\(--status-deny-bg\)\] p-6">/, retry);
});

// ── The new controls are big enough to press on a phone (R4 item 6) ─────────
//
// The dashboard's root font is 14px, so `h-10` is 35px and `h-11` is 38.5px:
// only a pixel value states 40px. Phone-only (`max-sm:`), so a desktop control
// keeps the size it had.
const PHONE_MIN_HEIGHT = /max-sm:(?:min-h|h)-\[(\d+)px\]/;
for (const [rel, label] of [
  ['components/dashboard/RefusalNotice.tsx', 'Update billing link'],
  ['components/dashboard/ArchivedProjectsNotice.tsx', 'Restore a project link'],
  ['components/billing/BillingRefusalNotice.tsx', 'Open the billing page button'],
] as const) {
  test(`the ${label} is at least 40px tall on a phone`, () => {
    const m = PHONE_MIN_HEIGHT.exec(code(rel));
    assert.ok(m, `${rel}: no phone-only pixel height`);
    assert.ok(Number(m[1]) >= 40, `${rel}: ${m[1]}px`);
  });
}
