/**
 * The two refusals of a plan or seat change whose way through is Stripe's
 * billing page: the bank has to confirm the payment, or a payment is overdue.
 *
 * Before round 3 the first read "update your card in the billing portal" (the
 * wrong reason, and not something updating the card fixes) and the second was
 * attempted and failed after the fact. The API now answers each with 402, its
 * own code, a sentence and `billing_portal: true`; these pin what the dashboard
 * shows for them and that the three pages which make the call offer the link.
 *
 * A .ts file using createElement, not .tsx, so the `src/lib/*.test.ts` glob in
 * `npm test` picks it up (see planPricesRendered.test.ts).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  BANK_CONFIRMATION_LINE,
  OPEN_BILLING_PAGE_LABEL,
  PAYMENT_OVERDUE_LINE,
  billingPageRefusal,
} from './billingRefusal';
import { checkoutFailure } from './checkoutPlanChange';
import { BillingRefusalNotice } from '../components/billing/BillingRefusalNotice';

// What apps/api/src/routes/shared/billing.js sends, word for word.
const SERVER = {
  payment_confirmation_required: 'Your bank needs to confirm this payment, so nothing was changed. '
    + 'Make this change from the billing page instead, where your bank can confirm it.',
  payment_overdue: 'A payment on this subscription is overdue, so nothing was changed. '
    + 'Update billing to restore access, then try again.',
};

/** An ApiError as lib/api.ts builds one from a JSON error body. */
function apiError(status: number, body: Record<string, unknown>) {
  return Object.assign(new Error(String(body.message || body.error || 'error')), {
    status,
    code: body.code,
    data: body,
  });
}

test('the two sentences are the ones the API sends', () => {
  assert.equal(BANK_CONFIRMATION_LINE, SERVER.payment_confirmation_required);
  assert.equal(PAYMENT_OVERDUE_LINE, SERVER.payment_overdue);
  assert.match(BANK_CONFIRMATION_LINE, /bank needs to confirm this payment/);
  assert.match(BANK_CONFIRMATION_LINE, /billing page/);
  assert.doesNotMatch(BANK_CONFIRMATION_LINE, /update your card|declined/i, 'updating the card cannot fix this');
  assert.match(PAYMENT_OVERDUE_LINE, /overdue/);
  assert.match(PAYMENT_OVERDUE_LINE, /Update billing to restore access/);
});

for (const code of ['payment_confirmation_required', 'payment_overdue'] as const) {
  test(`a 402 ${code} is a billing-page refusal, in the server's words or the same words without them`, () => {
    const said = billingPageRefusal(apiError(402, { error: code, message: SERVER[code], billing_portal: true }));
    assert.deepEqual(said, { code, message: SERVER[code] });
    const unsaid = billingPageRefusal(apiError(402, { error: code }));
    assert.deepEqual(unsaid, { code, message: SERVER[code] });

    // /checkout and /select-plan read failures through checkoutFailure: a
    // refusal with the billing page as its way through.
    assert.deepEqual(checkoutFailure(apiError(402, { error: code, message: SERVER[code] })),
      { kind: 'refused', exit: 'billing_portal', message: SERVER[code] });
  });
}

test('a declined card, and every other failure, is not one of them', () => {
  const declined = apiError(402, {
    error: 'payment_failed',
    message: 'Your card was declined. The charge for this change did not go through, so your plan was not changed. '
      + 'Update your card in the billing portal ("Update payment method" on Settings > Plan), then try again.',
  });
  assert.equal(billingPageRefusal(declined), null);
  assert.equal(checkoutFailure(declined).kind, 'error', 'a declined card keeps today\'s answer');
  assert.equal(billingPageRefusal(apiError(402, { error: 'subscription_payment_incomplete' })), null);
  assert.equal(billingPageRefusal(apiError(403, { error: 'payment_overdue' })), null);
  assert.equal(billingPageRefusal(new Error('network')), null);
  assert.equal(billingPageRefusal(null), null);
});

test('the notice shows the sentence beside a link to the billing page, and nothing without a refusal', () => {
  for (const code of ['payment_confirmation_required', 'payment_overdue'] as const) {
    const html = renderToStaticMarkup(createElement(BillingRefusalNotice, {
      refusal: { code, message: SERVER[code] },
      onOpenBilling: () => {},
    }));
    assert.ok(html.includes(SERVER[code]), `${code}: ${html}`);
    assert.ok(html.includes(OPEN_BILLING_PAGE_LABEL), `${code}: no link to the billing page in ${html}`);
    assert.match(html, /<button/);
  }
  assert.equal(renderToStaticMarkup(createElement(BillingRefusalNotice, { refusal: null, onOpenBilling: () => {} })), '');
});

// The three pages that make an in-place plan or seat change. Each must turn the
// refusal into the notice, and the notice's link must open the billing page
// (the existing owners-only portal hand-off, POST /billing/portal).
const PAGES = [
  { file: 'pages/settings/plan.tsx', opener: /onOpenBilling=\{\(\) => openPortal\(\)\}/ },
  { file: 'pages/settings/upgrade.tsx', opener: /onOpenBilling=\{\(\) => void handlePortal\(\)\}/ },
  { file: 'pages/settings/team.tsx', opener: /onOpenBilling=\{\(\) => void openBillingPage\(\)\}/ },
];

for (const page of PAGES) {
  test(`${page.file} shows the refusal beside the billing page`, () => {
    const source = readFileSync(join(__dirname, '..', page.file), 'utf8');
    assert.match(source, /billingPageRefusal\((error|e|err)\)/, 'the failed call is not read for the refusal');
    assert.match(source, /<BillingRefusalNotice\b/, 'the notice is not rendered');
    assert.match(source, page.opener, 'the notice does not open the billing page');
  });
}

test('/checkout offers the billing page for a refusal whose exit is the billing page', () => {
  const source = readFileSync(join(__dirname, '..', 'pages/checkout.tsx'), 'utf8');
  assert.match(source, /checkoutFailure\(err\)/);
  assert.match(source, /refusalExit === 'billing_portal'/);
});
