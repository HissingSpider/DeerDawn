'use strict';

// Pure retention math over a subscription-event ledger. No DB and no internal
// clock (now is passed in), so it is deterministic and fully testable. This is
// the "can we measure pay-twice" brain: it turns a raw event stream into MRR,
// active counts, window new/renewed/churned, and cohort retention.
//
// Event shape: { org_id, event_type, plan_tier, mrr_cents, occurred_at (ISO) }
//   event_type: 'created' | 'renewed' | 'plan_changed' | 'cancelled' | 'refunded' | 'payment_failed'

const CHURN_EVENTS = new Set(['cancelled', 'refunded']);
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 30;

function monthKey(iso) {
  return String(iso || '').slice(0, 7); // YYYY-MM
}

// Fold one org's time-ordered events into subscription state as of `untilMs`
// (default: all events). Tracks firstPaidAt (original acquisition) AND spellStart
// (start of the CURRENT active spell) so win-back re-subscriptions can be told
// apart from continuous tenure.
function foldOrg(events, untilMs = Infinity) {
  const ordered = [...events]
    .filter((e) => new Date(e.occurred_at).getTime() < untilMs)
    .sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
  let active = false;
  let atRisk = false;
  let planTier = null;
  let mrrCents = 0;
  let firstPaidAt = null;
  let spellStart = null;

  for (const event of ordered) {
    if (event.event_type === 'created') {
      active = true; atRisk = false; planTier = event.plan_tier; mrrCents = Number(event.mrr_cents || 0);
      if (!firstPaidAt) firstPaidAt = event.occurred_at;
      spellStart = event.occurred_at; // every (re)creation starts a fresh spell
    } else if (event.event_type === 'renewed') {
      active = true; atRisk = false;
      if (event.plan_tier != null) planTier = event.plan_tier;
      if (event.mrr_cents != null) mrrCents = Number(event.mrr_cents);
      if (!spellStart) spellStart = event.occurred_at;
    } else if (event.event_type === 'plan_changed') {
      // Mid-cycle upgrade/downgrade: keep the subscription active and re-price it
      // immediately, so MRR isn't stale between the change and the next renewal.
      // Not a renewal and not churn — it must not move those window counts.
      active = true;
      if (event.plan_tier != null) planTier = event.plan_tier;
      if (event.mrr_cents != null) mrrCents = Number(event.mrr_cents);
      if (!spellStart) spellStart = event.occurred_at;
    } else if (CHURN_EVENTS.has(event.event_type)) {
      active = false; atRisk = false; mrrCents = 0; spellStart = null;
    } else if (event.event_type === 'payment_failed') {
      atRisk = active; // a risk flag only while still active; cleared by the next renewal
    }
  }
  return { active, atRisk, planTier, mrrCents, firstPaidAt, spellStart };
}

function computeRetentionMetrics(events = [], now = Date.now()) {
  const nowMs = typeof now === 'number' ? now : new Date(now).getTime();
  const windowStart = nowMs - WINDOW_DAYS * DAY_MS;

  const byOrg = new Map();
  for (const event of events) {
    if (!event?.org_id) continue;
    if (!byOrg.has(event.org_id)) byOrg.set(event.org_id, []);
    byOrg.get(event.org_id).push(event);
  }

  let activeSubscriptions = 0;
  let mrrCents = 0;
  let pastDue = 0;
  let newSubscriptions = 0;
  let activeAtStart = 0;   // churn-rate denominator: subscriptions live when the window opened
  let churnedFromBase = 0; // of that base, how many churned during the window
  const cohorts = new Map(); // YYYY-MM -> { size, retained }

  for (const [, orgEvents] of byOrg) {
    const state = foldOrg(orgEvents);
    if (state.active) {
      activeSubscriptions += 1;
      mrrCents += state.mrrCents;
      if (state.atRisk) pastDue += 1;
    }

    // Churn rate is "of customers active at the START of the window, how many left"
    // — not churned/(active-now + churned), which mixes a point-in-time count with
    // a flow and understates churn whenever the base has grown.
    const startState = foldOrg(orgEvents, windowStart);
    if (startState.active) {
      activeAtStart += 1;
      const churnedInWindow = orgEvents.some((e) => {
        const t = new Date(e.occurred_at).getTime();
        return CHURN_EVENTS.has(e.event_type) && t >= windowStart && t <= nowMs;
      });
      if (churnedInWindow) churnedFromBase += 1;
    }

    if (state.firstPaidAt) {
      const firstKey = monthKey(state.firstPaidAt);
      const origCohort = cohorts.get(firstKey) || { size: 0, retained: 0 };
      origCohort.size += 1;
      // Retained only if currently active on an UNBROKEN spell from acquisition.
      const continuous = state.active && state.spellStart === state.firstPaidAt;
      if (continuous) origCohort.retained += 1;
      cohorts.set(firstKey, origCohort);

      // Win-back: a customer who churned and re-subscribed belongs to a new cohort
      // at their reacquisition month. Crediting the original cohort with their
      // return overstates that cohort's true retention (they did churn out of it).
      if (state.active && !continuous && state.spellStart) {
        const reKey = monthKey(state.spellStart);
        if (reKey !== firstKey) {
          const reCohort = cohorts.get(reKey) || { size: 0, retained: 0 };
          reCohort.size += 1;
          reCohort.retained += 1;
          cohorts.set(reKey, reCohort);
        } else {
          // Reacquired in the same calendar month they first joined — net retained there.
          origCohort.retained += 1;
        }
      }

      const firstMs = new Date(state.firstPaidAt).getTime();
      if (firstMs >= windowStart && firstMs <= nowMs) newSubscriptions += 1;
    }
  }

  let renewals = 0;
  let churned = 0;
  for (const event of events) {
    const eventMs = new Date(event.occurred_at).getTime();
    if (Number.isNaN(eventMs) || eventMs < windowStart || eventMs > nowMs) continue;
    if (event.event_type === 'renewed') renewals += 1;
    else if (CHURN_EVENTS.has(event.event_type)) churned += 1;
  }

  const churnRate = activeAtStart > 0 ? churnedFromBase / activeAtStart : 0;

  const cohortRetention = [...cohorts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([cohort, value]) => ({
      cohort,
      size: value.size,
      retained: value.retained,
      retention: value.size ? Number((value.retained / value.size).toFixed(4)) : 0,
    }));

  return {
    generated_for: new Date(nowMs).toISOString(),
    active_subscriptions: activeSubscriptions,
    past_due: pastDue,
    mrr_cents: mrrCents,
    arr_cents: mrrCents * 12,
    window_days: WINDOW_DAYS,
    new_subscriptions: newSubscriptions,
    renewals,
    churned,
    churn_rate: Number(churnRate.toFixed(4)),
    cohort_retention: cohortRetention,
  };
}

module.exports = { computeRetentionMetrics };
