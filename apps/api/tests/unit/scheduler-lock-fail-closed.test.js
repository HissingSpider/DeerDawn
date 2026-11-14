'use strict';

/**
 * WHEN THE LOCK CANNOT BE CHECKED, A JOB THAT SENDS MAIL OR WRITES DATA DOES NOT RUN.
 *
 * acquireLock returned true from its catch ("fail-open for jobs"). The lock
 * exists so that one of N machines runs a job; all N lose Redis together, so
 * failing open meant every machine ran every job at exactly the moment nothing
 * was coordinating them.
 *
 * Drives the real job functions the way the timer does and observes whether the
 * work happened.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.DEERDAWN_API_KEY = process.env.DEERDAWN_API_KEY || 'dev-key';
process.env.DISABLE_REDIS = 'true';

const test = require('node:test');
const assert = require('node:assert');

const calls = { digest: 0, followUp: 0, archive: 0, prune: 0, reports: [] };

// Installed before the scheduler destructures them at load.
const weeklyDigest = require('../../src/services/email/weeklyDigest');
weeklyDigest.sendWeeklyDigestEmails = async () => { calls.digest += 1; return { sent: 0 }; };
const followUp = require('../../src/services/email/activationFollowUp');
followUp.sendActivationFollowUpEmails = async () => { calls.followUp += 1; return { sent: 0 }; };
const autoArchive = require('../../src/jobs/autoArchiveJob');
autoArchive.runAutoArchive = async () => { calls.archive += 1; return { archived: 0 }; };
const reportSwallowedModule = require('../../src/utils/reportSwallowed');
reportSwallowedModule.reportSwallowed = (error, meta = {}) => { calls.reports.push({ message: error?.message, ...meta }); };

const db = require('../../src/config/db');
db.query = async (sql) => {
    if (/DELETE FROM audit_logs/.test(sql)) calls.prune += 1;
    return { rows: [], rowCount: 0 };
};

const { redis } = require('../../src/config/redis');
const { _jobs } = require('../../src/jobs/scheduler');

const healthySet = redis.set.bind(redis);
function redisDown() {
    redis.set = async () => { throw new Error('ECONNREFUSED 127.0.0.1:6379'); };
}
function redisUp() {
    redis.set = healthySet;
}
function reset() {
    calls.digest = 0; calls.followUp = 0; calls.archive = 0; calls.prune = 0; calls.reports.length = 0;
}

test('with Redis down, nothing that sends email runs', async () => {
    reset();
    redisDown();
    await _jobs.runWeeklyDigest();
    await _jobs.runActivationFollowUp();
    redisUp();

    assert.strictEqual(calls.digest, 0, 'every machine would have sent the weekly digest');
    assert.strictEqual(calls.followUp, 0, 'every machine would have sent the activation follow-up');
});

test('with Redis down, nothing that writes data runs', async () => {
    reset();
    redisDown();
    await _jobs.runIdleProjectArchive();
    redisUp();

    assert.strictEqual(calls.archive, 0);
});

test('a skipped job is reported once per outage, not once per tick', async () => {
    // A healthy acquisition ends whatever outage an earlier test left open, so
    // what follows is one fresh outage.
    redisUp();
    await _jobs.runWeeklyDigest();
    reset();
    redisDown();
    await _jobs.runWeeklyDigest();
    await _jobs.runWeeklyDigest();
    await _jobs.runWeeklyDigest();
    redisUp();

    const reports = calls.reports.filter((r) => r.op === 'scheduler_lock_unavailable' && r.meta?.job === 'weekly_digest');
    assert.strictEqual(reports.length, 1, 'a scheduler that has silently stopped is its own incident, but one incident');
});

test('the retention prune is the deliberate exception: idempotent, and not running has a cost', async () => {
    reset();
    redisDown();
    await _jobs.runAuditPruning();
    redisUp();

    assert.ok(calls.prune > 0, 'an idempotent DELETE of expired rows should not wait out a Redis outage');
});

test('with Redis healthy (or disabled for local dev) the jobs run', async () => {
    reset();
    redisUp();
    await _jobs.runWeeklyDigest();
    await _jobs.runIdleProjectArchive();

    assert.strictEqual(calls.digest, 1);
    assert.strictEqual(calls.archive, 1);
});

test('a lock somebody else holds is still respected', async () => {
    reset();
    redis.set = async () => null; // what SET NX returns when the key exists
    await _jobs.runWeeklyDigest();
    redisUp();

    assert.strictEqual(calls.digest, 0);
    assert.strictEqual(calls.reports.length, 0, 'losing the race is normal operation, not an incident');
});
