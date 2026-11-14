const db = require('../config/db');
const { redis } = require('../config/redis');
const { reportUsage } = require('../services/stripeService');
const { PLANS } = require('../config/plans');
const { isSelfHosted } = require('../config/selfHosted');
const { runVaultRemediation } = require('./vaultRemediationJob');
const { runAutoArchive } = require('./autoArchiveJob');
const { pruneAccessLogs } = require('./accessLogRetentionJob');
const { sendWeeklyDigestEmails } = require('../services/email/weeklyDigest');
const { sendActivationFollowUpEmails } = require('../services/email/activationFollowUp');
const { sendMorningAfterBriefs } = require('../services/email/morningAfterBrief');
const { runValueLadder } = require('../services/email/valueLadder');
const { reportSwallowed } = require('../utils/reportSwallowed');

// Track interval IDs for graceful shutdown
let usageReportingInterval = null;
let auditPruningInterval = null;
let accessLogPruningInterval = null;
let vaultRemediationInterval = null;
let autoArchiveInterval = null;
let weeklyDigestInterval = null;
let activationFollowUpInterval = null;
let morningAfterBriefInterval = null;
let valueLadderInterval = null;
let initialRunTimeout = null;

// Lock TTL in seconds (5 minutes)
const LOCK_TTL = 300;

// How often the weekly digest asks who is due. Hourly: the slot is a fixed
// weekday and hour, and a tick that lands inside it delivers.
const WEEKLY_DIGEST_TICK_MS = 60 * 60 * 1000;

// One report per job per outage, not one per tick: the hourly job would
// otherwise file the same incident twenty-four times a day.
const lockFailureReported = new Set();

/**
 * Acquire a distributed lock using Redis SETNX
 * Returns true if lock acquired, false otherwise
 *
 * WHEN REDIS CANNOT ANSWER, THE ANSWER IS "NO".
 *
 * This used to `return true` from the catch, with the comment "fail-open for
 * jobs". The lock exists because N machines run this scheduler and a job must
 * run on ONE of them. Failing open turns "I could not find out whether somebody
 * else is running this" into "nobody else is running this" — on every machine
 * at once, because they all lost the same Redis. So the exact moment the lock
 * is needed is the moment it stopped existing: every machine sent the email,
 * every machine reported the usage to Stripe, every machine wrote the archive
 * events.
 *
 * A skipped run costs a delay: every job here is periodic and the next tick
 * retries. A duplicated run costs an email nobody can unsend or a double charge.
 * So the default is closed, and it is reported, because a scheduler that has
 * silently stopped is its own incident.
 *
 * `failOpen: true` is for the narrow case where running twice is provably the
 * same as running once AND not running has a cost of its own: the retention
 * prunes. They are idempotent DELETEs of rows already past their retention, and
 * leaving them off for the length of a Redis outage means keeping personal data
 * longer than the policy says. Nothing that sends mail or writes new rows
 * qualifies.
 *
 * Unchanged for local dev and tests: with DISABLE_REDIS=true the stub client
 * answers 'OK' to every SET, so a single process always gets its lock.
 */
async function acquireLock(jobName, { failOpen = false } = {}) {
    const lockKey = `job:lock:${jobName}`;
    const instanceId = process.env.FLY_ALLOC_ID || process.env.HOSTNAME || `local-${process.pid}`;

    try {
        const acquired = await redis.set(lockKey, instanceId, 'EX', LOCK_TTL, 'NX');
        lockFailureReported.delete(jobName);
        return acquired === 'OK';
    } catch (err) {
        console.error(`[JOB] Failed to acquire lock for ${jobName}:`, err.message);
        if (failOpen) return true;
        if (!lockFailureReported.has(jobName)) {
            lockFailureReported.add(jobName);
            reportSwallowed(err, {
                op: 'scheduler_lock_unavailable',
                destructive: false,
                meta: { job: jobName, consequence: 'job skipped until Redis answers' },
            });
        }
        return false;
    }
}

/**
 * Release a distributed lock
 */
async function releaseLock(jobName) {
    const lockKey = `job:lock:${jobName}`;
    try {
        await redis.del(lockKey);
    } catch (err) {
        console.error(`[JOB] Failed to release lock for ${jobName}:`, err.message);
    }
}

/**
 * Job: Report Usage to Stripe
 * Runs every hour.
 *
 * NOTE: this reads usage_counters.decisions_count, which is a legacy counter that
 * nothing populates anymore (its only writer, enforcementService.incrementUsage, was
 * dead code and has been removed). The metered growth/scale tiers it serves are also
 * no longer sold (see config/plans.js). The job is therefore effectively inert today —
 * it reports 0 overage. If metered overage is ever revived, source the count from
 * product_events (event_name='context_delivered'), the live usage signal used by the
 * enforcement gate and the Usage & value dashboard, rather than re-adding an incrementer.
 */
async function runUsageReporting() {
    // Self-hosted: no Stripe, no metered plans.
    if (isSelfHosted()) return;
    if (!await acquireLock('usage_reporting')) {
        console.log('[JOB] Usage reporting skipped - another instance holds the lock');
        return;
    }

    console.log('[JOB] Starting Usage Reporting...');

    try {
        // 1. Get all orgs with paid plans
        const { rows: orgs } = await db.query(`
            SELECT org_id, plan_tier, billing_period_start
            FROM organizations
            WHERE plan_tier IN ('growth', 'scale')
              AND subscription_status = 'active'
              AND stripe_subscription_id IS NOT NULL
        `);

        for (const org of orgs) {
            try {
                const plan = PLANS[org.plan_tier];
                if (!plan?.overage_per_decision) continue;

                const included = plan.limits.included_decisions;
                const periodStart = org.billing_period_start; // Should be set by webhook

                if (!periodStart) continue;

                // 2. Get current usage from DB
                const counterRes = await db.query(`
                    SELECT decisions_count, reported_overage_count
                    FROM usage_counters
                    WHERE org_id = $1 AND period_start = $2
                `, [org.org_id, periodStart]);

                if (counterRes.rows.length === 0) continue;

                const { decisions_count, reported_overage_count } = counterRes.rows[0];
                const total = parseInt(decisions_count, 10);
                const reported = parseInt(reported_overage_count, 10);

                // 3. Calculate Overage
                const overage = Math.max(0, total - included);
                const delta = overage - reported;

                if (delta > 0) {
                    console.log(`[JOB] Reporting usage for ${org.org_id}: +${delta} (Total Overage: ${overage})`);

                    // 4. Send to Stripe
                    await reportUsage(org.org_id, delta);

                    // 5. Update Reported Count
                    await db.query(`
                        UPDATE usage_counters
                        SET reported_overage_count = reported_overage_count + $1
                        WHERE org_id = $2 AND period_start = $3
                    `, [delta, org.org_id, periodStart]);
                }
            } catch (err) {
                console.error(`[JOB] Failed to report usage for org ${org.org_id}:`, err);
            }
        }
    } catch (err) {
        console.error('[JOB] Usage reporting failed to start:', err);
    } finally {
        await releaseLock('usage_reporting');
    }

    console.log('[JOB] Usage Reporting Done.');
}

/**
 * Job: Prune Audit Logs
 * Runs daily.
 */
async function runAuditPruning() {
    // Self-hosted: retention is by PLAN here, and every self-hosted org row
    // still says plan 'free' (a 1-day audit retention) while its entitlements
    // say unlimited. Keep audit logs; the operator owns the database.
    if (isSelfHosted()) return;
    // Fail-open: an idempotent retention DELETE. See acquireLock.
    if (!await acquireLock('audit_pruning', { failOpen: true })) {
        console.log('[JOB] Audit pruning skipped - another instance holds the lock');
        return;
    }

    console.log('[JOB] Starting Audit Pruning...');

    try {
        const tiers = Object.keys(PLANS);

        for (const tierId of tiers) {
            const plan = PLANS[tierId];
            const days = plan.limits.audit_retention_days;

            if (!days) continue; // Keep forever if undefined (Pro?)

            // Delete logs older than X days for orgs in this tier
            // Note: This is a heavy query for large tables. In prod, use partitioning.
            await db.query(`
                DELETE FROM audit_logs
                WHERE org_id IN (SELECT org_id FROM organizations WHERE plan_tier = $1)
                  AND created_at < NOW() - INTERVAL '${days} days'
            `, [tierId]);
        }
    } catch (err) {
        console.error('[JOB] Audit pruning failed to start:', err);
    } finally {
        await releaseLock('audit_pruning');
    }

    console.log('[JOB] Audit Pruning Done.');
}

/**
 * Job: Prune access logs (IP + user agent per audited request)
 * Runs daily. Batched and capped; see accessLogRetentionJob.js.
 */
async function runAccessLogPruning() {
    // Fail-open, like audit pruning: an idempotent DELETE of rows already past
    // retention. Two machines racing it delete disjoint batches of the same
    // expired rows; not running it keeps personal data past its limit.
    if (!await acquireLock('access_log_pruning', { failOpen: true })) {
        console.log('[JOB] Access-log pruning skipped - another instance holds the lock');
        return;
    }
    try {
        await pruneAccessLogs();
    } catch (err) {
        console.error('[JOB] Access-log pruning failed:', err);
    } finally {
        await releaseLock('access_log_pruning');
    }
}

/**
 * Job: Nightly vault remediation
 * Repairs template summaries, fake timestamps, blob nodes, stale candidates.
 */
async function runNightlyVaultRemediation() {
    if (!await acquireLock('vault_remediation')) {
        console.log('[JOB] Vault remediation skipped - another instance holds the lock');
        return;
    }
    try {
        await runVaultRemediation();
    } catch (err) {
        console.error('[JOB] Vault remediation failed:', err);
    } finally {
        await releaseLock('vault_remediation');
    }
}

/**
 * Job: Auto-archive idle projects
 * Soft-archives projects with no activity for PROJECT_AUTO_ARCHIVE_DAYS (30 by
 * default) so a stale dashboard cleans itself up. Nothing is deleted and the
 * user can restore any project, so this is safe to run unattended.
 */
async function runIdleProjectArchive() {
    if (!await acquireLock('auto_archive')) {
        console.log('[JOB] Auto-archive skipped - another instance holds the lock');
        return;
    }
    try {
        await runAutoArchive();
    } catch (err) {
        console.error('[JOB] Auto-archive failed:', err);
    } finally {
        await releaseLock('auto_archive');
    }
}

/**
 * Job: Weekly activity-digest email — the outbound return trigger.
 *
 * Ticks every hour and asks the database who is due for the current weekly slot
 * (Monday 14:00 UTC by default), rather than counting seven days from boot. A
 * restart, a second machine or a late deploy therefore moves nothing: the answer
 * is in weekly_digest_workspace_sends, not in when this process started. See
 * services/email/weeklyDigest.js. No-ops when RESEND_API_KEY is unset.
 */
async function runWeeklyDigest() {
    // Self-hosted without an email transport: the boot log already said email
    // is off; do not repeat it every tick.
    if (isSelfHosted() && !process.env.RESEND_API_KEY) return;
    if (!await acquireLock('weekly_digest')) {
        console.log('[JOB] Weekly digest skipped - another instance holds the lock');
        return;
    }
    try {
        await sendWeeklyDigestEmails();
    } catch (err) {
        console.error('[JOB] Weekly digest failed:', err);
    } finally {
        await releaseLock('weekly_digest');
    }
}

/**
 * Job: Activation follow-up email — recovers un-activated signups (signed up but
 * never connected an AI tool). Runs every 6 hours; no-ops when RESEND_API_KEY is
 * unset. Safe to run at startup because the service is idempotent per user (it
 * records an activation_followup_email_sent event and never re-sends).
 */
async function runActivationFollowUp() {
    // A hosted growth email (it nudges people toward connecting a tool and
    // links deerdawn.com). A self-host's operator did not sign up to send it.
    if (isSelfHosted()) return;
    if (!await acquireLock('activation_followup')) {
        console.log('[JOB] Activation follow-up skipped - another instance holds the lock');
        return;
    }
    try {
        await sendActivationFollowUpEmails();
    } catch (err) {
        console.error('[JOB] Activation follow-up failed:', err);
    } finally {
        await releaseLock('activation_followup');
    }
}

/**
 * Job: The value ladder (services/email/valueLadder.js). Ticks hourly: records
 * the value_first_return / value_habit_reached milestones for anyone who has
 * reached them, and, only when VALUE_LADDER_EMAILS_ENABLED is set and the tick
 * is inside the send window, sends the one email due per person. At-most-once
 * per person per email is a claim row in the database, not this lock.
 */
async function runValueLadderJob() {
    if (!await acquireLock('value_ladder')) {
        console.log('[JOB] Value ladder skipped - another instance holds the lock');
        return;
    }
    try {
        await runValueLadder();
    } catch (err) {
        console.error('[JOB] Value ladder failed:', err);
    } finally {
        await releaseLock('value_ladder');
    }
}

/**
 * Job: The morning-after brief (activation plan Thing 3f). Ticks hourly; the
 * service itself decides whether this tick is inside the morning window and
 * who is due, and sends nothing at all unless MORNING_AFTER_BRIEF_ENABLED is
 * set. At-most-once per person is a claim row in the database, not this lock,
 * so a second machine or a restart cannot send a second copy.
 */
async function runMorningAfterBrief() {
    if (!await acquireLock('morning_after_brief')) {
        console.log('[JOB] Morning-after brief skipped - another instance holds the lock');
        return;
    }
    try {
        await sendMorningAfterBriefs();
    } catch (err) {
        console.error('[JOB] Morning-after brief failed:', err);
    } finally {
        await releaseLock('morning_after_brief');
    }
}

/**
 * Start the scheduler with distributed locking
 */
function startScheduler() {
    // Run usage reporting every hour
    usageReportingInterval = setInterval(runUsageReporting, 60 * 60 * 1000);

    // Run audit pruning every 24 hours
    auditPruningInterval = setInterval(runAuditPruning, 24 * 60 * 60 * 1000);

    // Prune access logs past retention every 24 hours
    accessLogPruningInterval = setInterval(runAccessLogPruning, 24 * 60 * 60 * 1000);

    // Run vault remediation every 24 hours
    vaultRemediationInterval = setInterval(runNightlyVaultRemediation, 24 * 60 * 60 * 1000);

    // Auto-archive idle projects every 24 hours
    autoArchiveInterval = setInterval(runIdleProjectArchive, 24 * 60 * 60 * 1000);

    // The weekly activity-digest email is a fixed weekly slot checked hourly, not
    // a seven-day timer armed at boot (which drifted with every deploy and ran
    // once per machine). Whether anybody is due is decided by the durable
    // per-person-per-workspace marker, so ticking hourly, and running it in the
    // startup pass below, cannot send a second copy.
    weeklyDigestInterval = setInterval(runWeeklyDigest, WEEKLY_DIGEST_TICK_MS);

    // Recover un-activated signups every 6 hours. Unlike the weekly digest this
    // IS included in the initial run — it's idempotent per user, so running it on
    // deploy can only help (no double-sends) and keeps follow-ups timely.
    activationFollowUpInterval = setInterval(runActivationFollowUp, 6 * 60 * 60 * 1000);

    // The morning-after brief: hourly, so every tick inside the morning window
    // gets a chance; idempotent per person, so it is safe in the startup pass.
    morningAfterBriefInterval = setInterval(runMorningAfterBrief, 60 * 60 * 1000);

    // The value ladder: hourly, idempotent per person and email type.
    valueLadderInterval = setInterval(runValueLadderJob, 60 * 60 * 1000);

    // Initial Run (delayed 10s to let server startup)
    initialRunTimeout = setTimeout(() => {
        runUsageReporting();
        runAuditPruning();
        runAccessLogPruning();
        runNightlyVaultRemediation();
        runIdleProjectArchive();
        runWeeklyDigest();
        runActivationFollowUp();
        runMorningAfterBrief();
        runValueLadderJob();
    }, 10000);

    console.log('[SCHEDULER] Started with distributed locking enabled');
}

/**
 * Stop the scheduler (for graceful shutdown)
 */
function stopScheduler() {
    if (usageReportingInterval) {
        clearInterval(usageReportingInterval);
        usageReportingInterval = null;
    }
    if (auditPruningInterval) {
        clearInterval(auditPruningInterval);
        auditPruningInterval = null;
    }
    if (accessLogPruningInterval) {
        clearInterval(accessLogPruningInterval);
        accessLogPruningInterval = null;
    }
    if (vaultRemediationInterval) {
        clearInterval(vaultRemediationInterval);
        vaultRemediationInterval = null;
    }
    if (autoArchiveInterval) {
        clearInterval(autoArchiveInterval);
        autoArchiveInterval = null;
    }
    if (weeklyDigestInterval) {
        clearInterval(weeklyDigestInterval);
        weeklyDigestInterval = null;
    }
    if (activationFollowUpInterval) {
        clearInterval(activationFollowUpInterval);
        activationFollowUpInterval = null;
    }
    if (morningAfterBriefInterval) {
        clearInterval(morningAfterBriefInterval);
        morningAfterBriefInterval = null;
    }
    if (valueLadderInterval) {
        clearInterval(valueLadderInterval);
        valueLadderInterval = null;
    }
    if (initialRunTimeout) {
        clearTimeout(initialRunTimeout);
        initialRunTimeout = null;
    }
    console.log('[SCHEDULER] Stopped');
}

module.exports = {
    startScheduler,
    stopScheduler,
    // Exported so tests can drive a job the way the timer does and observe
    // whether it ran, rather than reading this file's text.
    _jobs: { acquireLock, runWeeklyDigest, runActivationFollowUp, runMorningAfterBrief, runValueLadderJob, runIdleProjectArchive, runAuditPruning, runAccessLogPruning, runUsageReporting },
};
