'use strict';

// Which add-ons a WORKSPACE has switched on (workspace_addons). Add-on data is
// per person, but the switch is per workspace: in a team, an owner decides
// which add-ons the team has; in a one-person workspace that person does.

const db = require('../config/db');
const { ensureAddonSchema } = require('./schema');

async function listEnabled(ownerKey, { query = db.query } = {}) {
  await ensureAddonSchema();
  if (!ownerKey) return new Set();
  const r = await query(
    'SELECT addon_id FROM workspace_addons WHERE owner_key = $1 AND enabled = TRUE',
    [ownerKey],
    'org-system'
  );
  return new Set(r.rows.map((row) => row.addon_id));
}

async function isEnabled(ownerKey, addonId, opts) {
  return (await listEnabled(ownerKey, opts)).has(addonId);
}

async function setEnabled(ownerKey, addonId, enabled, { version = null, installedBy = null, query = db.query } = {}) {
  await ensureAddonSchema();
  await query(
    `INSERT INTO workspace_addons (owner_key, addon_id, version, enabled, installed_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (owner_key, addon_id) DO UPDATE
       SET enabled = EXCLUDED.enabled,
           version = COALESCE(EXCLUDED.version, workspace_addons.version),
           updated_at = NOW()`,
    [ownerKey, addonId, version, Boolean(enabled), installedBy],
    'org-system'
  );
}

module.exports = { listEnabled, isEnabled, setEnabled };
