-- OWNER-RUN, BY HAND. READ-ONLY. See docs/runbooks/owner-run-db-checks.md.
--
-- Counts legacy lifetime accounts: a workspace whose plan_tier is 'lifetime', or
-- that has a lifetime_activated_at (the time a one-off lifetime payment was
-- applied), and how many of them are active. "Active" is not one thing, so this
-- prints three measures side by side and you decide which one you mean:
--   in good standing: subscription_status = 'active' and the workspace is not
--                     locked (neither the owner's lockdown nor a dispute lock);
--   used lately:      the workspace has a session seen in the last 30 (or 90) days.
--
-- It changes nothing: READ ONLY transaction, rolled back at the end, ACCESS SHARE
-- locks only. lifetime_activated_at is read through to_jsonb(o), so the file
-- still runs, and counts it as never set, on a database that does not have that
-- column yet.
--
-- Run: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 03-count-lifetime-accounts.sql

BEGIN READ ONLY;
SET LOCAL statement_timeout = '5min';

-- 1. The counts. One row.
WITH lifetime AS (
  SELECT o.org_id, o.plan_tier, o.subscription_status, o.is_locked, o.dispute_locked_at,
         (to_jsonb(o) ->> 'lifetime_activated_at')::timestamptz AS lifetime_activated_at,
         (SELECT max(s.last_seen_at) FROM context_sessions s WHERE s.owner_key = o.org_id) AS last_session_at
    FROM organizations o
   WHERE o.plan_tier = 'lifetime' OR (to_jsonb(o) ->> 'lifetime_activated_at') IS NOT NULL
)
SELECT count(*) AS lifetime_accounts,
       count(*) FILTER (WHERE plan_tier = 'lifetime') AS plan_tier_is_lifetime,
       count(*) FILTER (WHERE plan_tier <> 'lifetime' OR plan_tier IS NULL) AS activated_once_now_on_another_plan,
       count(*) FILTER (WHERE subscription_status = 'active' AND NOT COALESCE(is_locked, false) AND dispute_locked_at IS NULL) AS in_good_standing,
       count(*) FILTER (WHERE last_session_at > now() - interval '30 days') AS used_in_last_30_days,
       count(*) FILTER (WHERE last_session_at > now() - interval '90 days') AS used_in_last_90_days,
       count(*) FILTER (WHERE plan_tier = 'lifetime' AND subscription_status = 'active' AND NOT COALESCE(is_locked, false) AND dispute_locked_at IS NULL) AS lifetime_tier_in_good_standing
  FROM lifetime;

-- 2. Each account, newest activation first, at most 200. Workspace ids and
--    states only: no names, emails or content are read.
SELECT o.org_id, o.plan_tier, o.subscription_status, o.is_locked,
       (to_jsonb(o) ->> 'lifetime_activated_at')::timestamptz AS lifetime_activated_at,
       o.created_at,
       (SELECT max(s.last_seen_at) FROM context_sessions s WHERE s.owner_key = o.org_id) AS last_session_at
  FROM organizations o
 WHERE o.plan_tier = 'lifetime' OR (to_jsonb(o) ->> 'lifetime_activated_at') IS NOT NULL
 ORDER BY (to_jsonb(o) ->> 'lifetime_activated_at')::timestamptz DESC NULLS LAST, o.created_at DESC
 LIMIT 200;

ROLLBACK;
