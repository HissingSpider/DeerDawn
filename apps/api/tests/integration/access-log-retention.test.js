'use strict';

/**
 * access_logs HAS A RETENTION PERIOD, AND THE PRUNE IS BOUNDED.
 *
 * Every audited request writes the caller's IP and user agent into access_logs,
 * and nothing ever removed a row. This drives the real prune against a real
 * table and checks three things a reviewer cannot see in a diff: that old rows
 * go and recent ones stay, that a backlog is deleted in batches rather than in
 * one statement, and that a run stops at its cap and says so.
 *
 * Run via scripts/run-db-test.sh node --test tests/integration/access-log-retention.test.js
 */

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const { v4: uuidv4 } = require('uuid');

const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');
const { ensureDatabaseAvailable } = require('../helpers/dbAvailability');
const { pruneAccessLogs, retentionDays, DEFAULT_RETENTION_DAYS } = require('../../src/jobs/accessLogRetentionJob');

const actors = [];

async function seed(actorId, ageDays, count) {
    for (let i = 0; i < count; i += 1) {
        await db.query(
            `INSERT INTO access_logs (access_id, org_id, actor_id, method, path, ip, user_agent, created_at)
             VALUES ($1, NULL, $2, 'GET', '/api/v1/keys', '203.0.113.7', 'retention-test', NOW() - ($3 || ' days')::interval)`,
            [`acc-${uuidv4()}`, actorId, String(ageDays)], 'org-system'
        );
    }
}

async function remaining(actorId) {
    const res = await db.query(
        'SELECT COUNT(*)::int AS n FROM access_logs WHERE actor_id = $1', [actorId], 'org-system'
    );
    return res.rows[0].n;
}

function newActor() {
    const id = `actor-${uuidv4()}`;
    actors.push(id);
    return id;
}

after(async () => {
    for (const id of actors) {
        await db.query('DELETE FROM access_logs WHERE actor_id = $1', [id], 'org-system').catch(() => {});
    }
    await closeRedisConnections?.().catch(() => {});
    await db.pool.end().catch(() => {});
});

test('rows past 90 days are deleted and recent ones are kept', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'access log retention'))) return;
    const actorId = newActor();
    await seed(actorId, 120, 4);
    await seed(actorId, 89, 3);

    const result = await pruneAccessLogs({ env: {} });

    assert.strictEqual(result.retention_days, 90);
    assert.strictEqual(await remaining(actorId), 3, 'the 89-day-old rows are inside the window and must survive');
    assert.ok(result.deleted >= 4);
});

test('a backlog is deleted in batches, never in one statement', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'access log retention'))) return;
    await pruneAccessLogs({ env: {} }); // drain whatever else is old, so the counts below are ours
    const actorId = newActor();
    await seed(actorId, 200, 7);

    const statements = [];
    const result = await pruneAccessLogs({
        env: { ACCESS_LOG_PRUNE_BATCH: '2' },
        query: async (text, params) => {
            const res = await db.query(text, params, 'org-system');
            statements.push(res.rowCount);
            return res;
        },
    });

    assert.strictEqual(await remaining(actorId), 0);
    assert.strictEqual(result.deleted, 7);
    assert.deepStrictEqual(statements, [2, 2, 2, 1], 'no single statement may touch more than one batch of rows');
    assert.strictEqual(result.more, false);
});

test('a run stops at its cap, says so, and the next run finishes the job', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'access log retention'))) return;
    await pruneAccessLogs({ env: {} });
    const actorId = newActor();
    await seed(actorId, 200, 10);
    const env = { ACCESS_LOG_PRUNE_BATCH: '2', ACCESS_LOG_PRUNE_MAX_BATCHES: '3' };

    const first = await pruneAccessLogs({ env });
    assert.strictEqual(first.deleted, 6);
    assert.strictEqual(first.more, true, 'a capped run must not read as a finished one');
    assert.strictEqual(await remaining(actorId), 4);

    const second = await pruneAccessLogs({ env });
    assert.strictEqual(second.deleted, 4);
    assert.strictEqual(await remaining(actorId), 0);
});

test('the window is env-overridable, and a bad value cannot empty the table', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'access log retention'))) return;
    const actorId = newActor();
    await seed(actorId, 40, 2);
    await seed(actorId, 10, 2);

    // 0, negatives and garbage all mean "the default", never "delete everything".
    for (const bad of ['0', '-5', 'ninety', '']) {
        assert.strictEqual(retentionDays({ ACCESS_LOG_RETENTION_DAYS: bad }), DEFAULT_RETENTION_DAYS);
    }
    await pruneAccessLogs({ env: { ACCESS_LOG_RETENTION_DAYS: '0' } });
    assert.strictEqual(await remaining(actorId), 4);

    await pruneAccessLogs({ env: { ACCESS_LOG_RETENTION_DAYS: '30' } });
    assert.strictEqual(await remaining(actorId), 2, 'a 30-day window removes the 40-day-old rows only');

    const off = await pruneAccessLogs({ env: { ACCESS_LOG_PRUNE_ENABLED: 'false', ACCESS_LOG_RETENTION_DAYS: '1' } });
    assert.strictEqual(off.skipped, 'disabled');
    assert.strictEqual(await remaining(actorId), 2);
});
