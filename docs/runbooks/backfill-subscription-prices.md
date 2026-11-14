# Backfill the recorded subscription price and pending cancellation

Owner-run. Never runs at boot, in CI, or by an agent.

The Stripe webhook records, on each subscription event, the price the subscription
is billed at and its pending cancellation. A workspace with no event since that
shipped has neither on record, and its plan page shows today's list price (a
subscriber who joined at $10 reads $12). This script reads each workspace's
subscription from Stripe and records the same thing.

## What it does and does not do

- Read-only against Stripe (`subscriptions.list`, paginated, one workspace at a
  time with a pause between, retried with backoff on rate limits).
- Writes only `cancel_at_period_end`, `cancel_at`, `price_unit_amount_cents`,
  `price_currency`, `price_interval`, `price_interval_count` of the subscription the
  row records, through the same writer as the webhook (`services/billingRecord.js`).
- Never changes the plan, status, seats, period, subscription id or access.
- Skips workspaces with no customer, no recorded subscription, a subscription
  Stripe does not list, or an ended one. Idempotent: a row that already matches is
  left alone.

## Run it (from `apps/api`, `DATABASE_URL` and `STRIPE_SECRET_KEY` set)

```
node scripts/owner-run/backfill-subscription-prices.js            # dry run, writes nothing
node scripts/owner-run/backfill-subscription-prices.js --apply    # writes
node scripts/owner-run/backfill-subscription-prices.js --org org-<uuid>   # one workspace
```

Options: `--delay-ms <n>` (default 150), `--page-size <n>` (default 100). Run the dry
run first and read the per-workspace lines. The last line is a summary: examined,
written (or would write), unchanged, skipped by reason, failed. Exit code 1 if any
workspace failed; re-running is safe.
