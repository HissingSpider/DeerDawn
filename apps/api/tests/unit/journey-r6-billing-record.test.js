'use strict';

/**
 * WHAT A STRIPE SUBSCRIPTION SAYS ABOUT ITS PRICE AND ITS END (journey r6),
 * and the pure judgements the billing-takeover gate makes about one. No database,
 * no Stripe: plain objects in, answers out.
 */
process.env.STRIPE_PRICE_DEVELOPER_BASIC = process.env.STRIPE_PRICE_DEVELOPER_BASIC || 'price_pro_monthly_r6u';
process.env.STRIPE_PRICE_DEVELOPER_PRO = process.env.STRIPE_PRICE_DEVELOPER_PRO || 'price_team_monthly_r6u';

const test = require('node:test');
const assert = require('node:assert/strict');

const { billingRecordOf, recordColumns } = require('../../src/services/billingRecord');
const { isRenewing, isEnding, effectivePaymentMethod } = require('../../src/services/billingOwnerService');
const { seatShortfall } = require('../../src/services/billingNoticeService');

const TEAM = process.env.STRIPE_PRICE_DEVELOPER_PRO;
const item = (price = {}, end = 2_000_000_000) => ({
    price: { id: TEAM, unit_amount: 1500, currency: 'USD', recurring: { interval: 'month', interval_count: 1 }, ...price },
    quantity: 3,
    current_period_end: end,
});

test('the record carries the real price, lower-cased currency, and the interval', () => {
    const record = billingRecordOf({ items: { data: [item({ unit_amount: 1000 })] }, cancel_at_period_end: false, cancel_at: null });
    assert.deepEqual(record, {
        cancelAtPeriodEnd: false,
        cancelAt: null,
        price: { unitAmountCents: 1000, currency: 'usd', interval: 'month', intervalCount: 1 },
    });
    assert.deepEqual(recordColumns(record), {
        cancel_at_period_end: false, cancel_at: null,
        price_unit_amount_cents: 1000, price_currency: 'usd', price_interval: 'month', price_interval_count: 1,
    });
});

test('a pending cancellation is recorded with its date', () => {
    const record = billingRecordOf({ items: { data: [item()] }, cancel_at_period_end: true, cancel_at: 1_900_000_000 });
    assert.equal(record.cancelAtPeriodEnd, true);
    assert.equal(record.cancelAt.getTime(), 1_900_000_000_000);
});

test('what the subscription does not carry is left undefined, never read as "no cancellation" or "free"', () => {
    assert.deepEqual(recordColumns(billingRecordOf({ items: { data: [] } })), {});
    assert.deepEqual(recordColumns(billingRecordOf(null)), {});
    // A price with no unit amount (metered, tiered) records no price rather than zero.
    assert.equal(billingRecordOf({ items: { data: [item({ unit_amount: null })] } }).price, undefined);
    // A free price is a real zero.
    assert.equal(billingRecordOf({ items: { data: [item({ unit_amount: 0 })] } }).price.unitAmountCents, 0);
});

test('the plan line is the one priced on the map; an unrecognised price is still what Stripe bills', () => {
    const overage = item({ id: 'price_overage', unit_amount: 1 });
    assert.equal(billingRecordOf({ items: { data: [overage, item({ unit_amount: 1500 })] } }).price.unitAmountCents, 1500);
    assert.equal(billingRecordOf({ items: { data: [item({ id: 'price_unmapped', unit_amount: 777 })] } }).price.unitAmountCents, 777);
});

test('renewing: live and not ending; ending: the flag, or a cancel_at inside the period', () => {
    const live = (extra = {}) => ({ status: 'active', items: { data: [item()] }, ...extra });
    assert.equal(isRenewing(live()), true);
    assert.equal(isRenewing(live({ status: 'trialing' })), true);
    assert.equal(isRenewing(live({ status: 'past_due' })), true, 'Stripe is still trying to charge it');
    for (const status of ['unpaid', 'incomplete', 'canceled', 'incomplete_expired', 'paused']) {
        assert.equal(isRenewing(live({ status })), false, status);
    }
    assert.equal(isEnding(live({ cancel_at_period_end: true })), true);
    assert.equal(isEnding(live({ cancel_at: 1_999_999_999 })), true, 'cancel_at within the period');
    assert.equal(isEnding(live({ cancel_at: 2_000_000_001 })), false, 'cancel_at beyond the period: another charge comes first');
    assert.equal(isRenewing(live({ cancel_at_period_end: true })), false);
});

test('the effective payment method: the subscription\'s, else the customer\'s invoice default, else the default source', () => {
    assert.equal(effectivePaymentMethod({ default_payment_method: 'pm_sub' }, { invoice_settings: { default_payment_method: 'pm_cust' } }), 'pm_sub');
    assert.equal(effectivePaymentMethod({ default_payment_method: { id: 'pm_obj' } }, null), 'pm_obj', 'expanded objects are read by id');
    assert.equal(effectivePaymentMethod({}, { invoice_settings: { default_payment_method: 'pm_cust' } }), 'pm_cust');
    assert.equal(effectivePaymentMethod({}, { invoice_settings: {}, default_source: 'card_1' }), 'card_1');
    assert.equal(effectivePaymentMethod({}, { invoice_settings: {} }), null);
    assert.equal(effectivePaymentMethod({}, null), null);
});

test('a seat shortfall needs a per-seat plan, a paying workspace, a purchased count and more people than seats', () => {
    const base = { planTier: 'developer_pro', status: 'active', purchasedSeats: 2, activeMembers: 3 };
    assert.deepEqual(seatShortfall(base), { members: 3, seats: 2, over_by: 1 });
    assert.equal(seatShortfall({ ...base, activeMembers: 2 }), null);
    assert.equal(seatShortfall({ ...base, purchasedSeats: null }), null, 'no purchased count on record: nothing to compare');
    assert.equal(seatShortfall({ ...base, status: 'cancelled' }), null);
    assert.equal(seatShortfall({ ...base, planTier: 'free' }), null);
    assert.equal(seatShortfall({ ...base, planTier: 'developer_basic' }), null, 'Pro is one person');
});
