-- OWNER-RUN, BY HAND. READ-ONLY. See docs/runbooks/owner-run-db-checks.md.
--
-- Counts, and lists, the team workspaces the old new-team wizard created before
-- any payment: a workspace that was made, never used and never paid for. A
-- workspace counts when ALL of these hold:
--   - it is not anyone's personal org (no user has users.org_id = its org_id);
--   - it has exactly one member row in workspace_members, and that member has
--     not been removed (a workspace somebody joined and left is not "born empty");
--   - it has no project, archived or not (context_projects.owner_key);
--   - it has no Stripe customer and no Stripe subscription;
--   - it has no row in the billing ledger (subscription_events).
--
-- Nothing is deleted, changed or locked. The file runs in a READ ONLY
-- transaction (Postgres refuses any write in it) which is rolled back at the
-- end, and takes only the ACCESS SHARE locks a SELECT takes. Whether to remove
-- any of these workspaces is a separate decision; this only counts them.
--
-- The list shows the workspace id, when it was created, and the member's user
-- id. No name and no email is read.
--
-- Run: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 04-count-empty-team-workspaces.sql

BEGIN READ ONLY;
SET LOCAL statement_timeout = '5min';

-- 1. The count. One row.
SELECT count(*) AS empty_team_workspaces
  FROM organizations o
 WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.org_id = o.org_id)
   AND (SELECT count(*) FROM workspace_members m WHERE m.owner_key = o.org_id) = 1
   AND (SELECT count(*) FROM workspace_members m WHERE m.owner_key = o.org_id AND m.removed_at IS NULL) = 1
   AND NOT EXISTS (SELECT 1 FROM context_projects p WHERE p.owner_key = o.org_id)
   AND o.stripe_customer_id IS NULL
   AND o.stripe_subscription_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM subscription_events e WHERE e.org_id = o.org_id);

-- 2. Each one, oldest first, at most 500: workspace id, created_at, member's user id.
SELECT o.org_id, o.created_at, m.user_id AS member_user_id
  FROM organizations o
  JOIN workspace_members m ON m.owner_key = o.org_id
 WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.org_id = o.org_id)
   AND (SELECT count(*) FROM workspace_members x WHERE x.owner_key = o.org_id) = 1
   AND m.removed_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM context_projects p WHERE p.owner_key = o.org_id)
   AND o.stripe_customer_id IS NULL
   AND o.stripe_subscription_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM subscription_events e WHERE e.org_id = o.org_id)
 ORDER BY o.created_at, o.org_id
 LIMIT 500;

ROLLBACK;
