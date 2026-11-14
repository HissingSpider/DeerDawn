/**
 * Resilient Audit Logger
 *
 * Provides audit logging with fallback to Redis when DB writes fail.
 * Failed logs are queued in Redis and can be recovered later.
 */

const db = require('../config/db');
const { redis } = require('../config/redis');

// Redis key for failed audit logs
const AUDIT_BACKUP_KEY = 'audit:failed_logs';
const BACKUP_TTL = 7 * 24 * 60 * 60; // 7 days

/**
 * Add an audit log entry.
 * If DB write fails, backs up to Redis for later recovery.
 *
 * @param {string|Object} actor - The actor (user/system/key) performing the action
 * @param {string} action - The action being performed
 * @param {string} target - The resource being acted upon
 * @param {Object} details - Additional context (will be JSON serialized)
 * @param {string} orgId - Optional org_id for scoping
 */
async function addAuditLog(actor, action, target, details = {}, orgId = null) {
    // Normalize actor to string
    let actorStr = 'system';
    if (typeof actor === 'object' && actor !== null) {
        actorStr = actor.email || actor.id || 'unknown';
        // Extract org_id from actor if not provided
        if (!orgId && actor.org_id) {
            orgId = actor.org_id;
        }
    } else if (typeof actor === 'string') {
        actorStr = actor;
    }

    const logId = `aud-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    const timestamp = new Date().toISOString();

    const logEntry = {
        logId,
        actorStr,
        action,
        target,
        details: JSON.stringify(details),
        orgId,
        timestamp
    };

    try {
        await db.query(
            'INSERT INTO audit_logs (log_id, org_id, actor, action, target, details, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [logId, orgId, actorStr, action, target, JSON.stringify(details), timestamp],
            orgId
        );
    } catch (err) {
        console.error('[AUDIT] DB write failed, backing up to Redis:', err.message);

        try {
            // Store in Redis list for later recovery
            await redis.lpush(AUDIT_BACKUP_KEY, JSON.stringify(logEntry));
            await redis.expire(AUDIT_BACKUP_KEY, BACKUP_TTL);
        } catch (redisErr) {
            // Last resort: log to stderr for container log aggregation
            console.error('[AUDIT CRITICAL] Both DB and Redis failed. Log entry:', JSON.stringify(logEntry));
        }
    }
}

/**
 * Recover failed audit logs from Redis backup.
 * Called periodically by scheduler to flush backed-up logs to DB.
 *
 * @returns {Object} Recovery stats: { recovered, failed, remaining }
 */
async function flushBackupAuditLogs() {
    const stats = { recovered: 0, failed: 0, remaining: 0 };

    try {
        const count = await redis.llen(AUDIT_BACKUP_KEY);
        if (count === 0) return stats;

        console.log(`[AUDIT] Recovering ${count} backed up audit logs...`);
        stats.remaining = count;

        // Process logs one at a time from the end (FIFO order)
        for (let i = 0; i < count; i++) {
            const entry = await redis.rpop(AUDIT_BACKUP_KEY);
            if (!entry) break;

            try {
                const log = JSON.parse(entry);
                await db.query(
                    'INSERT INTO audit_logs (log_id, org_id, actor, action, target, details, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (log_id) DO NOTHING',
                    [log.logId, log.orgId, log.actorStr, log.action, log.target, log.details, log.timestamp],
                    log.orgId
                );
                stats.recovered++;
                stats.remaining--;
            } catch (err) {
                console.error('[AUDIT] Recovery failed for entry, re-queueing:', err.message);
                // Re-queue the failed entry
                await redis.lpush(AUDIT_BACKUP_KEY, entry);
                stats.failed++;
                // Stop processing if DB is still having issues
                break;
            }
        }

        console.log(`[AUDIT] Recovery complete: ${stats.recovered} recovered, ${stats.failed} failed, ${stats.remaining} remaining`);
    } catch (err) {
        console.error('[AUDIT] Recovery process failed:', err.message);
    }

    return stats;
}

/**
 * Get count of backed-up audit logs.
 * Useful for monitoring and alerting.
 *
 * @returns {number} Number of logs waiting for recovery
 */
async function getBackupCount() {
    try {
        return await redis.llen(AUDIT_BACKUP_KEY);
    } catch (err) {
        console.error('[AUDIT] Failed to get backup count:', err.message);
        return -1;
    }
}

module.exports = {
    addAuditLog,
    flushBackupAuditLogs,
    getBackupCount
};
