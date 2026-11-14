'use strict';

/**
 * Baseline for the multi-agent coordination work — read-only.
 *
 * Ships BEFORE presence renders anywhere, and that ordering is the entire point.
 * Presence renders whenever two sessions exist, so the moment it ships the render
 * count will climb and look exactly like adoption while the underlying problem
 * stays wide open. That is the same trap the P2 activation work hit with
 * content_origin, where a metric moved because a feature shipped rather than
 * because anything got better.
 *
 * So the number to judge on is not "how often did we render a presence block" but
 * "how often did two agents write to the same project inside one window" — this
 * script measures that, from data that already exists, so there is something real
 * to compare against afterwards. If contention is rare in the fleet, the honest
 * conclusion is that this feature does not matter yet, and this script is how we
 * would find that out instead of shipping on a hunch.
 *
 * Purely a read: no table is written, nothing is mutated.
 *
 *   node scripts/multi-agent-baseline.js                 # last 30 days
 *   node scripts/multi-agent-baseline.js --days=7
 *   node scripts/multi-agent-baseline.js --owner=user-123
 *   node scripts/multi-agent-baseline.js --json
 */

const db = require('../src/config/db');

// Two writes inside this window are treated as concurrent. Matched to the
// presence window in packages/shared-context/src/coordination.js — if that
// changes, this must change with it or the baseline stops measuring the thing
// the feature acts on.
const WINDOW_MINUTES = 45;

// Session ids that are minted PER WRITE rather than per agent.
//
// This is the correction that matters most in this file. Contention is measured
// as COUNT(DISTINCT source_session_id) > 1 inside a window, so an id that changes
// on every write makes ONE agent writing twice look like TWO agents colliding.
// The first run of this script against production reported 54.8% contention on
// data written almost entirely by `mcp-${Date.now()}` — it was measuring write
// frequency, not collision.
//
// Every known offender stamps a wall-clock timestamp after a fixed prefix, so
// they are identifiable in SQL. Date.now() is 13 digits; {10,} leaves room
// without matching a legitimate id that merely starts with digits.
//
// Keep this list in sync when a new write path is added. A synthetic id that is
// not listed here does not fail loudly — it silently inflates the metric, which
// is the failure mode this whole constant exists to prevent.
// One definition, used by both the SQL predicate and the JS check below, so the
// two cannot drift into measuring different things.
const SYNTHETIC_SESSION_ID_PATTERN = '^(mcp-remote|mcp|flush|codex|seed)-[0-9]{10,}';
const SYNTHETIC_SESSION_ID_RE = new RegExp(SYNTHETIC_SESSION_ID_PATTERN);

/** Is this id minted per write (and therefore useless for counting agents)? */
function isSyntheticSessionId(id) {
  return SYNTHETIC_SESSION_ID_RE.test(String(id || ''));
}

function parseArgs(argv) {
  const get = (name, fallback) => {
    const arg = argv.find((a) => a.startsWith(`--${name}=`));
    return arg ? arg.slice(name.length + 3) : fallback;
  };
  return {
    days: Number(get('days', '30')) || 30,
    owner: get('owner', null),
    json: argv.includes('--json'),
  };
}

async function main() {
  const { days, owner, json } = parseArgs(process.argv.slice(2));
  const ownerFilter = owner ? 'AND owner_key = $2' : '';
  const params = owner ? [days, owner] : [days];

  // 1. Contended projects: more than one distinct session wrote to the same
  //    project inside the window. Graph nodes carry source_session_id, so this is
  //    answerable today with no new instrumentation.
  const contention = await db.query(
    `WITH writes AS (
       SELECT owner_key,
              project_id,
              source_session_id,
              date_trunc('hour', updated_at)
                + (floor(extract(minute FROM updated_at) / ${WINDOW_MINUTES}) * interval '${WINDOW_MINUTES} minutes') AS bucket
         FROM context_graph_nodes
        WHERE updated_at > NOW() - ($1 || ' days')::interval
          AND source_session_id <> ''
          -- Per-write ids would count one agent's two writes as two agents.
          AND source_session_id !~ '${SYNTHETIC_SESSION_ID_PATTERN}'
          AND project_id IS NOT NULL
          ${ownerFilter}
     ), per_bucket AS (
       SELECT owner_key, project_id, bucket, COUNT(DISTINCT source_session_id) AS sessions
         FROM writes
        GROUP BY owner_key, project_id, bucket
     )
     SELECT COUNT(*)::int                                        AS total_windows,
            COUNT(*) FILTER (WHERE sessions > 1)::int            AS contended_windows,
            COUNT(DISTINCT project_id) FILTER (WHERE sessions > 1)::int AS contended_projects,
            COUNT(DISTINCT owner_key)  FILTER (WHERE sessions > 1)::int AS contended_owners
       FROM per_bucket`,
    params,
    'org-system'
  );

  // 2. Overlapping sessions: two live sessions bound to one project at once. This
  //    is what presence WILL render, tracked separately so the two can be compared
  //    afterwards — if renders climb and contention does not, the feature is
  //    decorating a problem it is not solving.
  const overlap = await db.query(
    `SELECT COUNT(*)::int AS projects_with_multiple_sessions
       FROM (
         SELECT project_id
           FROM context_sessions
          WHERE last_seen_at > NOW() - ($1 || ' days')::interval
            AND project_id IS NOT NULL
            ${ownerFilter}
          GROUP BY project_id
         HAVING COUNT(DISTINCT session_id) > 1
       ) t`,
    params,
    'org-system'
  );

  // 3. Attribution coverage. Everything above is a read on source_session_id, so
  //    a low number here means the baseline itself is under-counting — worth
  //    knowing before anyone quotes these figures. Before the stable agent session
  //    id landed, MCP writes minted a fresh id per call, so historical rows are
  //    attributable in name only; expect this to be the weakest number in the run.
  const attribution = await db.query(
    `SELECT COUNT(*)::int AS total_nodes,
            COUNT(*) FILTER (WHERE source_session_id <> '')::int AS attributed_nodes,
            COUNT(*) FILTER (
              WHERE source_session_id <> ''
                AND source_session_id !~ '${SYNTHETIC_SESSION_ID_PATTERN}'
            )::int AS stable_nodes
       FROM context_graph_nodes
      WHERE updated_at > NOW() - ($1 || ' days')::interval
        ${ownerFilter}`,
    params,
    'org-system'
  );

  const c = contention.rows[0] || {};
  const o = overlap.rows[0] || {};
  const a = attribution.rows[0] || {};
  const pct = (num, den) => (den > 0 ? `${((num / den) * 100).toFixed(1)}%` : 'n/a');

  const report = {
    window_days: days,
    window_minutes: WINDOW_MINUTES,
    owner: owner || 'all',
    write_windows: Number(c.total_windows || 0),
    contended_windows: Number(c.contended_windows || 0),
    contended_window_rate: pct(Number(c.contended_windows || 0), Number(c.total_windows || 0)),
    contended_projects: Number(c.contended_projects || 0),
    contended_owners: Number(c.contended_owners || 0),
    projects_with_multiple_sessions: Number(o.projects_with_multiple_sessions || 0),
    graph_nodes: Number(a.total_nodes || 0),
    // Non-empty. Kept because it is what earlier runs reported, but it is NOT a
    // trust signal: the broken per-write ids were non-empty too, so this read
    // 100% while the real figure below was near zero.
    attributed_nodes: Number(a.attributed_nodes || 0),
    attribution_coverage: pct(Number(a.attributed_nodes || 0), Number(a.total_nodes || 0)),
    // THE trust signal: writes carrying an id that identifies an AGENT rather
    // than a single write. The contention numbers above are computed over only
    // these, so this is also the sample size behind them.
    stable_nodes: Number(a.stable_nodes || 0),
    stable_attribution: pct(Number(a.stable_nodes || 0), Number(a.total_nodes || 0)),
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write([
      `Multi-agent baseline — last ${days} days (${report.owner})`,
      '',
      `  Write windows (${WINDOW_MINUTES} min):    ${report.write_windows}`,
      `  ...with 2+ distinct sessions:  ${report.contended_windows} (${report.contended_window_rate})   <- THE metric`,
      `  Distinct contended projects:   ${report.contended_projects}`,
      `  Distinct contended owners:     ${report.contended_owners}`,
      '',
      `  Projects w/ 2+ sessions seen:  ${report.projects_with_multiple_sessions}   <- what presence will render on`,
      '',
      `  Graph nodes:                   ${report.graph_nodes}`,
      `  ...non-empty session id:       ${report.attributed_nodes} (${report.attribution_coverage})  <- NOT a trust signal`,
      `  ...AGENT-identifying id:       ${report.stable_nodes} (${report.stable_attribution})  <- the real sample size`,
      '',
      '  Judge the feature on the contended-window rate falling, NOT on how often',
      '  the presence block renders — renders climb the moment it ships.',
      '',
      ...(Number(report.stable_nodes || 0) < 100
        ? [
          '  ⚠ Too few agent-identifying writes for the rate above to mean much yet.',
          '    Writes made before mcp-server 1.0.42 carry a per-write id and are',
          '    excluded by design. Re-run once real 1.0.42 traffic has accumulated.',
          '',
        ]
        : []),
    ].join('\n'));
  }
}

// Only run when invoked directly, so the classification above can be unit-tested
// without opening a database connection or calling process.exit.
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`[BASELINE] failed: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { isSyntheticSessionId, SYNTHETIC_SESSION_ID_PATTERN, SYNTHETIC_SESSION_ID_RE, WINDOW_MINUTES };
