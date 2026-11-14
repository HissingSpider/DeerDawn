const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireAuth } = require('../../middleware/auth');
const { getOnboardingState, TEMPLATE_OPTIONS, normalizeTemplate } = require('../../services/onboardingService');
const { invalidateOrgCache } = require('../../services/enforcementService');

router.use(requireAuth);

router.get('/state', async (req, res) => {
  const orgId = req.actor.org_id;
  if (!orgId) return res.status(403).json({ error: 'forbidden' });

  try {
    const state = await getOnboardingState(orgId, req.actor.id);
    res.json({ state });
  } catch (err) {
    console.error('[ONBOARDING] Failed to load state:', err.message);
    res.status(500).json({ error: 'internal_error' });
  }
});

router.patch('/template', async (req, res) => {
  const orgId = req.actor.org_id;
  if (!orgId) return res.status(403).json({ error: 'forbidden' });
  if (!['owner', 'admin'].includes(req.actor.role)) return res.status(403).json({ error: 'forbidden' });

  const template = normalizeTemplate(req.body?.template, null);
  if (!TEMPLATE_OPTIONS.includes(template)) {
    return res.status(400).json({ error: 'invalid_template' });
  }

  try {
    await db.query(
      'UPDATE organizations SET onboarding_template = $1 WHERE org_id = $2',
      [template, orgId],
      orgId
    );
    await invalidateOrgCache(orgId);
    const state = await getOnboardingState(orgId, req.actor.id);
    res.json({ success: true, state });
  } catch (err) {
    console.error('[ONBOARDING] Failed to update template:', err.message);
    res.status(500).json({ error: 'internal_error' });
  }
});

// "Why are you using DeerDawn" questionnaire. Single-choice fields are validated
// against allowed sets; unknown values are dropped to null. tools is a multi-select.
const SURVEY_OPTIONS = {
  role: ['founder', 'engineer', 'pm', 'designer', 'other'],
  primary_use: ['sync_context', 'onboard_teammates', 'personal_projects', 'other'],
  team_size: ['solo', '2_10', '11_50', '50_plus'],
};
const SURVEY_TOOLS = ['claude', 'chatgpt', 'cursor', 'codex', 'other'];
const MOTIVATION_MAX = 2000;

function pickOption(value, allowed) {
  return typeof value === 'string' && allowed.includes(value) ? value : null;
}

router.get('/survey', async (req, res) => {
  const userId = req.actor.id;
  if (!userId) return res.status(403).json({ error: 'forbidden' });

  try {
    const { rows } = await db.query(
      'SELECT user_id, org_id, role, primary_use, tools, team_size, motivation, created_at FROM onboarding_responses WHERE user_id = $1',
      [userId],
      req.actor.org_id
    );
    if (!rows.length) return res.json({ completed: false, survey: null });
    res.json({ completed: true, survey: rows[0] });
  } catch (err) {
    console.error('[ONBOARDING] Failed to load survey:', err.message);
    res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/survey', async (req, res) => {
  const userId = req.actor.id;
  const orgId = req.actor.org_id;
  if (!userId) return res.status(403).json({ error: 'forbidden' });

  const body = req.body || {};
  const role = pickOption(body.role, SURVEY_OPTIONS.role);
  const primaryUse = pickOption(body.primary_use, SURVEY_OPTIONS.primary_use);
  const teamSize = pickOption(body.team_size, SURVEY_OPTIONS.team_size);
  const tools = Array.isArray(body.tools)
    ? [...new Set(body.tools.filter((t) => SURVEY_TOOLS.includes(t)))]
    : [];
  const motivation = typeof body.motivation === 'string'
    ? body.motivation.trim().slice(0, MOTIVATION_MAX) || null
    : null;

  try {
    const { rows } = await db.query(
      `INSERT INTO onboarding_responses (user_id, org_id, role, primary_use, tools, team_size, motivation)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id) DO UPDATE SET
         org_id = EXCLUDED.org_id,
         role = EXCLUDED.role,
         primary_use = EXCLUDED.primary_use,
         tools = EXCLUDED.tools,
         team_size = EXCLUDED.team_size,
         motivation = EXCLUDED.motivation,
         updated_at = NOW()
       RETURNING user_id, org_id, role, primary_use, tools, team_size, motivation, created_at`,
      [userId, orgId || null, role, primaryUse, tools, teamSize, motivation],
      orgId
    );
    res.json({ success: true, completed: true, survey: rows[0] });
  } catch (err) {
    console.error('[ONBOARDING] Failed to save survey:', err.message);
    res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
