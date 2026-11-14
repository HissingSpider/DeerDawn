const express = require('express');
const { requireAuth, requirePlatformStaff } = require('../../middleware/auth');
const { getRetentionMetrics } = require('../../services/retentionLedger');
const { getOperatorToday } = require('../../services/operatorToday');

const router = express.Router();

// AUTHZ-003: platform-wide revenue/retention numbers (not tenant data). Platform-staff only —
// a tenant 'admin'/'owner' must NOT be able to read cross-customer MRR/retention.
router.use(requireAuth, requirePlatformStaff);

// GET /api/v1/metrics/retention
// Returns MRR/ARR, active subscriptions, 30-day new/renewed/churned + churn rate,
// and monthly cohort retention — the "are customers paying twice" view.
router.get('/retention', async (req, res, next) => {
  try {
    const metrics = await getRetentionMetrics();
    res.json(metrics);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/metrics/today[?days=N]
// One row per human who got a brief in the window, read from Postgres — the
// "did anyone get value today" view. Cross-account by design, so it lives on
// this router precisely BECAUSE the router already carries requireAuth +
// requirePlatformStaff: a tenant 'admin'/'owner' must not be able to read other
// customers' names, projects and activity. Same gate as /retention and the
// cross-tenant CMS; no new one is introduced.
router.get('/today', async (req, res, next) => {
  try {
    const summary = await getOperatorToday({ days: req.query.days });
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
