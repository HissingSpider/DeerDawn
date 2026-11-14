const db = require('../config/db');

/**
 * Record a system health metric
 * @param {string} metricName - Name of the metric (e.g., 'api_latency_p95', 'error_rate', 'uptime')
 * @param {number} metricValue - The metric value
 * @param {object} metadata - Additional metadata (optional)
 * @param {string} orgId - Organization ID (optional, for org-specific metrics)
 */
async function recordHealthMetric(metricName, metricValue, metadata = {}, orgId = null) {
    try {
        const logId = `hlth-${crypto.randomUUID()}`;

        await db.query(
            `INSERT INTO system_health_log (log_id, metric_name, metric_value, metadata, org_id, timestamp)
            VALUES ($1, $2, $3, $4, $5, NOW())`,
            [logId, metricName, metricValue, JSON.stringify(metadata), orgId],
            orgId
        );
    } catch (err) {
        console.error('[HEALTH METRICS] Failed to record metric:', err.message);
        // Don't throw - health metrics should not break the application
    }
}

/**
 * Get recent health metrics
 * @param {string} metricName - Name of the metric to fetch (optional)
 * @param {number} hours - Number of hours to look back (default: 24)
 * @param {string} orgId - Organization ID (optional)
 * @returns {Array} Array of health metric records
 */
async function getHealthMetrics(metricName = null, hours = 24, orgId = null) {
    try {
        let query = `
            SELECT
                metric_name,
                metric_value,
                metadata,
                timestamp,
                org_id
            FROM system_health_log
            WHERE timestamp > NOW() - INTERVAL '${hours} hours'
        `;

        const params = [];

        if (metricName) {
            params.push(metricName);
            query += ` AND metric_name = $${params.length}`;
        }

        if (orgId) {
            params.push(orgId);
            query += ` AND org_id = $${params.length}`;
        }

        query += ' ORDER BY timestamp DESC';

        const { rows } = await db.query(query, params, orgId);

        return rows;
    } catch (err) {
        console.error('[HEALTH METRICS] Failed to fetch metrics:', err.message);
        return [];
    }
}

/**
 * Calculate aggregate health metrics for display
 * @param {string} orgId - Organization ID (optional)
 * @returns {Object} Aggregated health metrics
 */
async function getAggregatedHealthMetrics(orgId = null) {
    try {
        // Get latency metrics from decisions table (last 24 hours)
        let latencyQuery = `
            SELECT
                AVG(latency_ms) as avg_latency,
                PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE latency_ms IS NOT NULL) as p95_latency,
                PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE latency_ms IS NOT NULL) as p99_latency,
                COUNT(*) as total_decisions
            FROM decisions
            WHERE created_at > NOW() - INTERVAL '24 hours'
        `;

        const latencyParams = [];

        if (orgId) {
            latencyParams.push(orgId);
            latencyQuery += ` AND org_id = $${latencyParams.length}`;
        }

        const { rows: latencyRows } = await db.query(latencyQuery, latencyParams, orgId);

        // Get error rate (decisions that resulted in fail-safe mode)
        let errorQuery = `
            SELECT
                COUNT(CASE WHEN is_fail_safe = true THEN 1 END) as fail_safe_count,
                COUNT(*) as total_decisions,
                CASE
                    WHEN COUNT(*) > 0 THEN
                        (COUNT(CASE WHEN is_fail_safe = true THEN 1 END)::float / COUNT(*)) * 100
                    ELSE 0
                END as error_rate_percent
            FROM decisions
            WHERE created_at > NOW() - INTERVAL '24 hours'
        `;

        const errorParams = [];

        if (orgId) {
            errorParams.push(orgId);
            errorQuery += ` AND org_id = $${errorParams.length}`;
        }

        const { rows: errorRows } = await db.query(errorQuery, errorParams, orgId);

        // Get last outage from health log (if any)
        let outageQuery = `
            SELECT
                timestamp,
                metadata
            FROM system_health_log
            WHERE metric_name = 'outage'
        `;

        const outageParams = [];

        if (orgId) {
            outageParams.push(orgId);
            outageQuery += ` AND org_id = $${outageParams.length}`;
        }

        outageQuery += ' ORDER BY timestamp DESC LIMIT 1';

        const { rows: outageRows } = await db.query(outageQuery, outageParams, orgId);

        const latencyData = latencyRows[0] || {};
        const errorData = errorRows[0] || {};

        return {
            latency: {
                avg: Math.round(latencyData.avg_latency || 0),
                p95: Math.round(latencyData.p95_latency || 0),
                p99: Math.round(latencyData.p99_latency || 0),
                unit: 'ms'
            },
            error_rate: {
                percent: parseFloat((errorData.error_rate_percent || 0).toFixed(2)),
                fail_safe_count: parseInt(errorData.fail_safe_count || 0, 10),
                total_decisions: parseInt(errorData.total_decisions || 0, 10)
            },
            last_outage: outageRows.length > 0 ? {
                timestamp: outageRows[0].timestamp,
                metadata: outageRows[0].metadata
            } : null,
            total_decisions_24h: parseInt(latencyData.total_decisions || 0, 10)
        };
    } catch (err) {
        console.error('[HEALTH METRICS] Failed to get aggregated metrics:', err.message);
        return {
            latency: { avg: 0, p95: 0, p99: 0, unit: 'ms' },
            error_rate: { percent: 0, fail_safe_count: 0, total_decisions: 0 },
            last_outage: null,
            total_decisions_24h: 0
        };
    }
}

/**
 * Record an outage event
 * @param {string} reason - Reason for the outage
 * @param {object} metadata - Additional outage metadata
 * @param {string} orgId - Organization ID (optional)
 */
async function recordOutage(reason, metadata = {}, orgId = null) {
    return recordHealthMetric('outage', 1, { reason, ...metadata }, orgId);
}

module.exports = {
    recordHealthMetric,
    getHealthMetrics,
    getAggregatedHealthMetrics,
    recordOutage
};
