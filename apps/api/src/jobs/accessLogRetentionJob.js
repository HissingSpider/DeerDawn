'use strict';

const db = require('../config/db');

// access_logs HAD NO RETENTION AT ALL.
//
// Every audited request (middleware/auditAccess.js) writes a row carrying the
// caller's IP ADDRESS and USER AGENT, and nothing ever removed one. audit_logs
// has a per-plan prune and context_audit_logs reports a `retained_since`; this
// table just grew. Two separate problems:
//   - it is personal data kept without a limit or a stated purpose, and the only
//     way a row left was the account being erased;
//   - it is an unbounded table on the write path of the key-management routes.
//
// 90 days by default: long enough to investigate "who used this key, and from
// where" well after the fact, short enough to be a retention period rather than
// an archive. ACCESS_LOG_RETENTION_DAYS overrides it.
const DEFAULT_RETENTION_DAYS = 90;

// THE DELETE IS BATCHED, AND THAT IS THE POINT.
//
// The obvious statement — DELETE FROM access_logs WHERE created_at < cutoff —
// is fine on the day it ships and a hazard the first time it meets a backlog,
// which is exactly the situation on first deploy: every row ever written is
// eligible at once. One statement would hold row locks on millions of rows, in
// one transaction, generate all of that WAL before it could commit, and run
// into the pool's 25s statement_timeout, at which point it rolls back and the
// next run does the same thing forever. (That is the failure mode the
// attribution repair in autoMigrate.js documents.)
//
// So: small batches, each its own statement and its own transaction, capped per
// run. A backlog drains over a few nights instead of in one long lock, and any
// single batch that fails costs only itself.
const DEFAULT_BATCH_SIZE = 5000;
const DEFAULT_MAX_BATCHES = 200; // 1M rows a run at the defaults

// NOT THROUGH db.query, AND NOT BY ACCIDENT.
//
// db.query is wrapped in the circuit breaker that guards every request: 8s, and
// it opens at 50% failures. On a night with nothing old enough to delete, the
// batch below is one full read of the table, and on a big table that can pass
// 8s. At 3am the breaker's window holds very few other calls, so one slow
// maintenance statement is most of the sample — and a background prune would
// open the breaker and 503 the API. Maintenance gets its own connection and its
// own statement timeout, scoped with SET LOCAL so it cannot leak onto the pooled
// connection, and its failures are its own.
const BATCH_STATEMENT_TIMEOUT_MS = 20000;

async function queryOnOwnConnection(text, params) {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL statement_timeout = ${BATCH_STATEMENT_TIMEOUT_MS}`);
        const result = await client.query(text, params);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

function readPositiveInt(raw, fallback) {
    const parsed = Number.parseInt(String(raw ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function retentionDays(env = process.env) {
    // A non-positive or unparseable value falls back to the default rather than
    // meaning "delete everything" or "keep forever": a typo in an env var must
    // not be able to empty the table or silently switch retention off. Turning
    // it off is its own explicit switch, below.
    return readPositiveInt(env.ACCESS_LOG_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
}

function isEnabled(env = process.env) {
    return String(env.ACCESS_LOG_PRUNE_ENABLED ?? 'true').toLowerCase() !== 'false';
}

/**
 * Delete access_logs rows older than the retention window, a batch at a time.
 *
 * No ORDER BY and no index on created_at, deliberately. The table is
 * append-only, so its oldest rows are physically first in the heap and a
 * `LIMIT n` scan finds a full batch of them almost immediately; an ORDER BY
 * would force a sort of the whole table per batch to delete the same rows. The
 * cost that remains is one full read of the table on a night when nothing is
 * old enough, which takes no lock a request can notice. Building an index
 * instead would have to happen inside the boot migration's transaction, where
 * CREATE INDEX blocks every insert into this table until it finishes.
 *
 * `query` is injectable so the maintenance script can run this on its own
 * client; by default each batch takes a pooled connection for just that batch
 * (see queryOnOwnConnection for why not db.query).
 */
async function pruneAccessLogs({ env = process.env, now = new Date(), query = queryOnOwnConnection } = {}) {
    if (!isEnabled(env)) return { skipped: 'disabled', deleted: 0, batches: 0 };

    const days = retentionDays(env);
    const batchSize = readPositiveInt(env.ACCESS_LOG_PRUNE_BATCH, DEFAULT_BATCH_SIZE);
    const maxBatches = readPositiveInt(env.ACCESS_LOG_PRUNE_MAX_BATCHES, DEFAULT_MAX_BATCHES);
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

    let deleted = 0;
    let batches = 0;
    let more = false;

    while (batches < maxBatches) {
        const res = await query(
            `DELETE FROM access_logs
              WHERE access_id IN (
                    SELECT access_id FROM access_logs
                     WHERE created_at < $1
                     LIMIT $2)`,
            [cutoff, batchSize]
        );
        batches += 1;
        deleted += res.rowCount || 0;
        if ((res.rowCount || 0) < batchSize) break;
        // A full batch means there may be more. If the cap stops us here, say
        // so: "deleted N" and "deleted N, and stopped" are different reports.
        more = batches >= maxBatches;
    }

    console.log(`[JOB] Access-log retention: deleted ${deleted} row(s) older than ${days}d in ${batches} batch(es)${more ? ' (cap reached, continuing next run)' : ''}`);
    return { deleted, batches, more, cutoff, retention_days: days };
}

module.exports = {
    pruneAccessLogs,
    retentionDays,
    isEnabled,
    DEFAULT_RETENTION_DAYS,
    DEFAULT_BATCH_SIZE,
    DEFAULT_MAX_BATCHES,
};
