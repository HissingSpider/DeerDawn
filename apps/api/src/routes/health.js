const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { redis } = require('../config/redis');
const { requireAuth } = require('../middleware/auth');
const { getAggregatedHealthMetrics } = require('../services/healthMetricsService');
const { getBootstrapState } = require('../state/bootstrap');
const { checkDashboard } = require('../services/dashboardProbe');

// Cheap liveness/readiness signal for orchestrator health checks (Fly, Docker).
// Reflects in-memory bootstrap state only — intentionally does NOT touch the DB
// or Redis, so frequent polling can't keep Neon's compute from scaling to zero
// (and won't flap during a Neon cold-start). Use /health/readiness for a deep
// dependency check.
router.get('/healthz', (req, res) => {
    const bootstrap = getBootstrapState();
    if (!bootstrap.ready) {
        return res.status(503).send(bootstrap.status || 'starting');
    }
    res.status(200).send('ok');
});

// The dashboard row of the public /status page. The dashboard is checked from
// here because a browser cannot read its status (see services/dashboardProbe).
// A separate path, not a field on /healthz: Fly's health check and the Docker
// healthcheck read /healthz, and its exact body must not change.
router.get('/healthz/dashboard', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).json(await checkDashboard());
});

router.get('/health/liveness', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

router.get('/health/readiness', async (req, res) => {
    const bootstrap = getBootstrapState();
    if (!bootstrap.ready) {
        // Unauthenticated endpoint — never echo raw driver/bootstrap error text.
        if (bootstrap.error) console.error('[HEALTH] Readiness blocked during bootstrap:', bootstrap.error);
        return res.status(503).json({ status: bootstrap.status });
    }

    try {
        await Promise.all([
            db.query('SELECT 1'),
            redis.ping(),
        ]);
        res.status(200).json({ status: 'ok' });
    } catch (err) {
        // Log detail server-side; return nothing that describes internal infra to an
        // unauthenticated caller (pg/ioredis messages can carry hostnames and auth reasons).
        console.error('Readiness check failed:', err);
        res.status(503).json({ status: 'error' });
    }
});

// GET /health/metrics - Get aggregated system health metrics
router.get('/health/metrics', requireAuth, async (req, res) => {
    const orgId = req.actor.org_id;

    try {
        const metrics = await getAggregatedHealthMetrics(orgId);
        res.status(200).json(metrics);
    } catch (err) {
        console.error('Health metrics fetch failed:', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

module.exports = router;
