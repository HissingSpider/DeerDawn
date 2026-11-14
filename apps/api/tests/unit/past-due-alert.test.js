'use strict';

process.env.DISABLE_REDIS = 'true';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_past_due';
process.env.STRIPE_PRICE_DEVELOPER_PRO = process.env.STRIPE_PRICE_DEVELOPER_PRO || 'price_team_monthly';

// A past-due nobody is told about is churn with a delay.
//
// invoice.payment_failed already did the two silent things right — flip the
// status (enforcement blocks past_due) and write the ledger row — and nothing
// loud. The customer's briefs stop working and the only way John could learn
// why was to query the table. With the Team trial live, this same event now
// carries every failed day-14 conversion charge: the exact moment a trial
// fails to become revenue.
//
// The contract: an alert email to John, reply-to the customer, sent AFTER
// commit, best-effort — an email failure must never 500 the webhook, because
// Stripe would retry and the stripe_events guard would eat the retry, trading
// a missed email for a missed status flip.

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const DB_PATH = require.resolve('../../src/config/db');
const REDIS_PATH = require.resolve('../../src/config/redis');
const STRIPE_SERVICE_PATH = require.resolve('../../src/services/stripeService');
const PRODUCT_EVENTS_PATH = require.resolve('../../src/services/productEventsService');
const RETENTION_LEDGER_PATH = require.resolve('../../src/services/retentionLedger');
const RESEND_PATH = require.resolve('../../src/services/email/resendClient');
const ROUTE_PATH = require.resolve('../../src/routes/webhooks-stripe');

const ORG_ID = 'org-11111111-2222-3333-4444-555555555555';

function makeDb({ orgRow } = {}) {
  const claimedEvents = new Set();
  async function query(text, params = []) {
    if (/INSERT INTO stripe_events/.test(text) && /'processing'/.test(text)) {
      const eventId = params[0];
      if (claimedEvents.has(eventId)) return { rows: [], rowCount: 0 };
      claimedEvents.add(eventId);
      return { rows: [{ event_id: eventId }], rowCount: 1 };
    }
    if (/SELECT o\.plan_tier, o\.purchased_seats/.test(text)) {
      return { rows: orgRow ? [orgRow] : [], rowCount: orgRow ? 1 : 0 };
    }
    if (/UPDATE organizations/.test(text)) {
      return { rows: [{ org_id: ORG_ID }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  return { query, pool: { connect: async () => ({ query, release() {} }) } };
}

function loadRoute({ event, db, emailFails = false }) {
  const emails = [];
  const ledger = [];
  for (const p of [DB_PATH, REDIS_PATH, STRIPE_SERVICE_PATH, PRODUCT_EVENTS_PATH, RETENTION_LEDGER_PATH, RESEND_PATH, ROUTE_PATH]) {
    delete require.cache[p];
  }
  require.cache[DB_PATH] = { id: DB_PATH, filename: DB_PATH, loaded: true, exports: db };
  require.cache[REDIS_PATH] = { id: REDIS_PATH, filename: REDIS_PATH, loaded: true, exports: { redis: { del: async () => 1 } } };
  require.cache[STRIPE_SERVICE_PATH] = {
    id: STRIPE_SERVICE_PATH, filename: STRIPE_SERVICE_PATH, loaded: true,
    exports: {
      stripe: {
        webhooks: { constructEvent: () => event },
        // Stripe's word is final: every invoice event reads its subscription,
        // and this one is past_due in Stripe. (Without a Stripe to ask, the
        // webhook no longer writes past_due from the event: since 2026-09-29 a
        // subscription Stripe will not show is never written from a payload.)
        subscriptions: {
          retrieve: async (id) => ({
            id, object: 'subscription', status: 'past_due', customer: 'cus_test_1',
            items: { data: [{ id: 'si_1', quantity: 2, price: { id: process.env.STRIPE_PRICE_DEVELOPER_PRO } }] },
          }),
        },
      },
    },
  };
  require.cache[PRODUCT_EVENTS_PATH] = {
    id: PRODUCT_EVENTS_PATH, filename: PRODUCT_EVENTS_PATH, loaded: true,
    exports: { recordProductEvent: async () => ({}) },
  };
  require.cache[RETENTION_LEDGER_PATH] = {
    id: RETENTION_LEDGER_PATH, filename: RETENTION_LEDGER_PATH, loaded: true,
    exports: { recordSubscriptionEvent: async (e) => { ledger.push(e); } },
  };
  require.cache[RESEND_PATH] = {
    id: RESEND_PATH, filename: RESEND_PATH, loaded: true,
    exports: {
      sendEmail: async (msg) => {
        if (emailFails) throw new Error('resend down');
        emails.push(msg);
        return { ok: true };
      },
    },
  };
  const router = require(ROUTE_PATH);
  return { router, emails, ledger };
}

async function deliver(router, body) {
  const app = express();
  app.use('/hook', router);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=stub' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    server.close();
  }
}

function failedInvoiceEvent(overrides = {}) {
  return {
    id: overrides.id || 'evt_invoice_failed_1',
    type: 'invoice.payment_failed',
    data: {
      object: {
        subscription: 'sub_test_1',
        customer: 'cus_test_1',
        customer_email: 'stripe-side@example.com',
        amount_due: 3000,
        attempt_count: 1,
        next_payment_attempt: 1757678400,
        hosted_invoice_url: 'https://invoice.stripe.com/i/inv_123',
        ...(overrides.invoice || {}),
      },
    },
  };
}

const ORG_ROW = { plan_tier: 'developer_pro', purchased_seats: 2, email: 'buyer@example.com' };

test('a failed charge alerts John, reply-to the customer, with the facts that matter', async () => {
  const { router, emails, ledger } = loadRoute({ event: failedInvoiceEvent(), db: makeDb({ orgRow: ORG_ROW }) });
  const res = await deliver(router, { stub: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  assert.equal(emails.length, 1, 'exactly one alert per failure');
  const mail = emails[0];
  assert.equal(mail.emailType, 'past_due_alert');
  // Reply-to is the customer so chasing them is one keystroke.
  assert.equal(mail.replyTo, 'buyer@example.com');
  assert.match(mail.subject, /buyer@example\.com/);
  assert.match(mail.subject, /attempt 1/);
  assert.match(mail.html, /developer_pro \(2 seats\)/);
  assert.match(mail.html, /\$30\.00/);
  assert.match(mail.html, /invoice\.stripe\.com/);

  // The alert rides WITH the existing behaviour, not instead of it.
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].event_type, 'payment_failed');
});

test('the org row wins for the address; Stripe’s copy is the fallback', async () => {
  const noUser = { ...ORG_ROW, email: null };
  const { router, emails } = loadRoute({ event: failedInvoiceEvent({ id: 'evt_invoice_failed_2' }), db: makeDb({ orgRow: noUser }) });
  await deliver(router, { stub: true });
  assert.equal(emails[0].replyTo, 'stripe-side@example.com');
});

test('customer-typed values are escaped before they reach an email John opens', async () => {
  const hostile = { ...ORG_ROW, email: '<img src=x onerror=alert(1)>@x.com' };
  const { router, emails } = loadRoute({ event: failedInvoiceEvent({ id: 'evt_invoice_failed_3' }), db: makeDb({ orgRow: hostile }) });
  await deliver(router, { stub: true });
  assert.ok(!emails[0].html.includes('<img'), 'raw HTML from a customer field must never survive');
  assert.match(emails[0].html, /&lt;img/);
});

test('an invoice with no subscription (one-off) alerts nobody', async () => {
  const { router, emails } = loadRoute({
    event: failedInvoiceEvent({ id: 'evt_invoice_failed_4', invoice: { subscription: null } }),
    db: makeDb({ orgRow: ORG_ROW }),
  });
  const res = await deliver(router, { stub: true });
  assert.equal(res.status, 200);
  assert.equal(emails.length, 0);
});

test('a Resend outage never 500s the webhook — the status flip is worth more than the email', async () => {
  const { router } = loadRoute({ event: failedInvoiceEvent({ id: 'evt_invoice_failed_5' }), db: makeDb({ orgRow: ORG_ROW }), emailFails: true });
  const res = await deliver(router, { stub: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { received: true });
});

test('a re-delivered event does not send a second email', async () => {
  const db = makeDb({ orgRow: ORG_ROW });
  const event = failedInvoiceEvent({ id: 'evt_invoice_failed_6' });
  const { router, emails } = loadRoute({ event, db });
  await deliver(router, { stub: true });
  const second = await deliver(router, { stub: true });
  assert.deepEqual(second.body, { received: true, duplicate: true });
  assert.equal(emails.length, 1);
});
