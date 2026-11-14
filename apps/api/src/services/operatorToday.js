'use strict';

/**
 * "DID ANYONE GET VALUE TODAY?" — one row per human who got a brief.
 *
 * WHY THIS EXISTS: answering that question took an agent, a git worktree and
 * hand-written SQL, which is why the answer has only ever arrived as a daily
 * report in docs/growth/daily-reports/ rather than as a glance. There was no
 * operator surface to read it from: /admin has exactly two pages, retention
 * (all zeros at zero paying customers) and the CMS, and the one platform-wide
 * endpoint returns MRR. Everything else in the API is scoped to `req.actor`, so
 * by construction it cannot answer a cross-account question.
 *
 * POSTGRES, NOT POSTHOG. Every recorded distortion of this number lives on the
 * analytics side: a nightly journey E2E that runs against PRODUCTION and was
 * ~45% of the consent funnel, an ad-verification crawler that was ~20% of
 * desktop "visitors", and an `is_not true` filter on `$virt_is_bot` that
 * silently drops ALL server-relayed events. `context_session_loads` has none of
 * those problems, because it is not a telemetry stream — it is the write the
 * product makes when it actually hands a human a brief. If a row is here, the
 * work happened.
 *
 * THE TABLE. One row per real session start, written by
 * sessionCatchupService.buildSessionCatchup: owner_key (the workspace),
 * user_id (the human, when the actor carries one), project_id, tool,
 * created_at. That is exactly the five facts this view needs and no more, which
 * is why nothing here is estimated.
 *
 * INDEXES — the leading column is the whole story:
 *   - the window filter rides `idx_context_session_loads_created (created_at DESC)`,
 *     added alongside this view. Without it, a created_at-only predicate on the
 *     owner-leading index is a sequential scan of an unbounded table.
 *   - the first-ever probe rides `idx_context_session_loads_owner_project
 *     (owner_key, ...)` — owner_key leading, one seek per person in the window.
 *   - identity rides `users_pkey` (user_id) and `idx_users_org_created_at`,
 *     whose leading column is org_id.
 *   - the project name rides `context_projects_pkey`.
 * No unindexed join column is touched, and nothing scans per-owner rows for
 * owners outside the window.
 */

const db = require('../config/db');
const { internalIdentitySql } = require('./internalAccounts');

/** Widest window the view will read. A month of rows is still a small seek. */
const MAX_WINDOW_DAYS = 31;

function startOfUtcDay(now) {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : value || null;
}

/**
 * `project_name` is plaintext on context_projects — only the `context` JSONB is
 * encrypted at rest (see contextSyncStore's encryptContextObject). So the name
 * can be selected in SQL; the brief body could not be, and is not read here.
 */
function buildQuery(paramsSoFar) {
  const internal = internalIdentitySql(
    { emailExpr: 'i.email', platformStaffExpr: 'i.is_platform_staff' },
    paramsSoFar + 1
  );

  const sql = `
    WITH window_loads AS (
      SELECT l.owner_key,
             l.user_id,
             l.project_id,
             l.tool,
             l.created_at,
             -- First brief this workspace has EVER received. Scoped to one
             -- owner_key, so it seeks the owner-leading index rather than
             -- aggregating the table. Compared against this row's own timestamp
             -- (not the window start) so it stays true only for the genuinely
             -- first row, even when a person loads several briefs today.
             NOT EXISTS (
               SELECT 1
                 FROM context_session_loads prior
                WHERE prior.owner_key = l.owner_key
                  AND prior.created_at < l.created_at
             ) AS is_first_ever
        FROM context_session_loads l
       WHERE l.created_at >= $1
         AND l.created_at <  $2
    ),
    identified AS (
      SELECT
        -- The most specific identity the ROW actually carries. user_id is set
        -- whenever the actor is a user; API-key actors fall back to the
        -- workspace. Never invent a person for a row that names none.
        COALESCE(w.user_id, w.owner_key)                            AS person_key,
        w.owner_key,
        w.project_id,
        COALESCE(du.email, ou.email)                                AS email,
        COALESCE(du.is_platform_staff, ou.is_platform_staff, FALSE) AS is_platform_staff,
        p.project_name,
        w.tool,
        w.created_at,
        w.is_first_ever
        FROM window_loads w
        -- Primary key lookup.
        LEFT JOIN users du ON du.user_id = w.user_id
        -- Fallback for rows with no user_id: the workspace's owner. Rides
        -- idx_users_org_created_at, whose LEADING column is org_id. This arm
        -- is what stops an unattributed founder row from slipping the filter.
        LEFT JOIN LATERAL (
          SELECT u.email, u.is_platform_staff
            FROM users u
           WHERE u.org_id = w.owner_key
           ORDER BY (u.role = 'owner') DESC, u.created_at ASC
           LIMIT 1
        ) ou ON TRUE
        LEFT JOIN context_projects p ON p.project_id = w.project_id
    ),
    customers AS (
      SELECT i.* FROM identified i WHERE NOT ${internal.sql}
    ),
    ranked AS (
      SELECT c.*,
             ROW_NUMBER() OVER (PARTITION BY c.person_key ORDER BY c.created_at DESC) AS recency
        FROM customers c
    )
    SELECT person_key,
           MIN(owner_key)                                        AS owner_key,
           MAX(email)                                            AS email,
           COUNT(*)::int                                         AS briefs,
           MIN(created_at)                                       AS first_brief_at,
           MAX(created_at)                                       AS last_brief_at,
           BOOL_OR(is_first_ever)                                AS is_first_ever,
           MAX(project_name) FILTER (WHERE recency = 1)          AS latest_project,
           MAX(tool)         FILTER (WHERE recency = 1)          AS latest_tool,
           COUNT(DISTINCT project_id)::int                       AS projects,
           COUNT(DISTINCT tool)::int                             AS tools
      FROM ranked
     GROUP BY person_key
     ORDER BY MAX(created_at) DESC
  `;

  return { sql, params: internal.params };
}

/**
 * @param {object} [options]
 * @param {number} [options.days=1]  Window size. 1 = since UTC midnight today.
 * @param {Date}   [options.now]     Injectable clock, for tests.
 */
async function getOperatorToday({ days = 1, now = new Date() } = {}) {
  const windowDays = Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.floor(Number(days) || 1)));
  const end = new Date(now);
  const start = startOfUtcDay(end);
  // days=1 is "since midnight"; each extra day walks the start back a full day,
  // so days=7 is today plus the six calendar days before it.
  start.setUTCDate(start.getUTCDate() - (windowDays - 1));

  const { sql, params } = buildQuery(2);
  const result = await db.query(sql, [start.toISOString(), end.toISOString(), ...params], 'org-system');

  const people = (result.rows || []).map((row) => ({
    person_key: row.person_key,
    owner_key: row.owner_key,
    // Null when the row names a user we cannot resolve and the workspace has no
    // user rows. Rendered as the workspace key rather than guessed at.
    email: row.email || null,
    briefs: Number(row.briefs || 0),
    projects: Number(row.projects || 0),
    tools: Number(row.tools || 0),
    latest_project: row.latest_project || null,
    latest_tool: row.latest_tool || null,
    first_brief_at: iso(row.first_brief_at),
    last_brief_at: iso(row.last_brief_at),
    is_first_ever: row.is_first_ever === true,
  }));

  return {
    window_start: start.toISOString(),
    window_end: end.toISOString(),
    window_days: windowDays,
    generated_at: end.toISOString(),
    // Counts of the rows below, nothing more. No rate is reported: at this
    // volume a one-day rate is noise, and the growth protocol already says a
    // one-day move is not a result.
    people_count: people.length,
    first_timers: people.filter((p) => p.is_first_ever).length,
    briefs_count: people.reduce((sum, p) => sum + p.briefs, 0),
    people,
  };
}

module.exports = { getOperatorToday, buildQuery, MAX_WINDOW_DAYS };
