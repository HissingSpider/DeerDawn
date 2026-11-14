'use strict';

// WHAT THE PLATFORM OWNS ON BEHALF OF EVERY ADD-ON: the brief line, the account
// export, and erasure. Because add-ons only ever write to addon_records and
// addon_attachments (plus the two bookkeeping tables), these are done ONCE here
// and every add-on is covered — "delete my account" cannot miss data because
// somebody switched an add-on on.

const db = require('../config/db');
const { renderBriefLine, briefLineCollections } = require('../../../../packages/addon-kit/src');
const registry = require('./registry');
const enablement = require('./enablement');
const records = require('./recordsStore');
const attachments = require('./attachmentStore');
const workspace = require('../services/workspaceService');
const { ensureAddonSchema } = require('./schema');

const MAX_BRIEF_LINES = 3;

/**
 * At most one line per enabled add-on that has a brief_line, three in all,
 * for the person behind `actor`. [] when nothing is enabled. Never throws: a
 * brief must not fail because an add-on count could not be read.
 */
async function briefLines(actor, { query = db.query } = {}) {
  try {
    const ownerKey = workspace.defaultOwnerKey(actor);
    const personId = workspace.actorPersonId(actor);
    if (!ownerKey || !personId) return [];
    const enabled = await enablement.listEnabled(ownerKey, { query });
    if (!enabled.size) return [];
    const lines = [];
    for (const addon of registry.listAddons()) {
      if (lines.length >= MAX_BRIEF_LINES) break;
      if (!enabled.has(addon.id) || !addon.manifest.brief_line) continue;
      const counts = briefLineCollections(addon.manifest.brief_line).length
        ? await records.countsByCollection({ ownerKey, addonId: addon.id, personId }, { query })
        : {};
      const line = renderBriefLine(addon.manifest.brief_line, counts);
      if (line) lines.push(line.slice(0, 160));
    }
    return lines;
  } catch (err) {
    console.warn('[ADDONS] brief lines skipped:', err.message);
    return [];
  }
}

/**
 * The person's add-on data in this workspace, for GET /context/export.
 * Records in full (decrypted); attachments LISTED with id, size and checksum.
 * The bundle is JSON (and a Markdown rendering), which cannot carry binaries,
 * so the files themselves are not inside it: each is downloadable by id from
 * GET /api/v1/addons/:addon/attachments/:id?variant=original.
 */
async function exportForActor(actor, { query = db.query } = {}) {
  const ownerKey = workspace.defaultOwnerKey(actor);
  const personId = workspace.actorPersonId(actor);
  if (!ownerKey || !personId) return { enabled: [], records: [], attachments: [] };
  const [enabled, recs, files] = await Promise.all([
    enablement.listEnabled(ownerKey, { query }),
    records.exportForPerson(ownerKey, personId, { query }),
    attachments.listForExport(ownerKey, personId, { query }),
  ]);
  return {
    enabled: [...enabled].sort(),
    records: recs,
    attachments: files.map((file) => ({
      ...file,
      download: `/api/v1/addons/${file.addon_id}/attachments/${file.id}?variant=original`,
    })),
    note: 'Attachment files are listed, not embedded: download each by its id at the path given.',
  };
}

function errorLabel(err) {
  return err?.code === '42P01' ? 0 : `error:${err.code || err.message}`;
}

async function selectKeys(query, sql, params) {
  try {
    const r = await query(sql, params, 'org-system');
    return r.rows.map((row) => row.storage_key).filter(Boolean);
  } catch (err) {
    if (err?.code !== '42P01') console.warn('[ERASURE] could not list add-on files:', err.message);
    return [];
  }
}

async function deleteCounted(query, deleted, label, sql, params) {
  try {
    const r = await query(sql, params, 'org-system');
    deleted[label] = r.rowCount;
  } catch (err) {
    deleted[label] = errorLabel(err);
  }
}

/**
 * Erase every add-on row a WORKSPACE holds. Returns the storage keys whose
 * files must be deleted once the caller has committed (files cannot be rolled
 * back, so they are not deleted here).
 */
async function eraseWorkspaceAddonData(query, ownerKey, deleted) {
  await ensureAddonSchema().catch(() => {});
  const keys = await selectKeys(query, 'SELECT storage_key FROM addon_attachments WHERE owner_key = $1', [ownerKey]);
  await deleteCounted(query, deleted, 'addon_attachments', 'DELETE FROM addon_attachments WHERE owner_key = $1', [ownerKey]);
  await deleteCounted(query, deleted, 'addon_records', 'DELETE FROM addon_records WHERE owner_key = $1', [ownerKey]);
  await deleteCounted(query, deleted, 'addon_upload_tokens', 'DELETE FROM addon_upload_tokens WHERE owner_key = $1', [ownerKey]);
  await deleteCounted(query, deleted, 'workspace_addons', 'DELETE FROM workspace_addons WHERE owner_key = $1', [ownerKey]);
  return keys;
}

/**
 * Erase PEOPLE's add-on data in every workspace (v1 add-on data is all
 * personal, so it is theirs wherever it lives). `ownerKey` limits it to one
 * workspace (member removal). Returns storage keys to delete after commit.
 */
async function erasePersonAddonData(query, people, deleted, { ownerKey = null, suffix = '_by_person' } = {}) {
  const ids = [...new Set((people || []).filter(Boolean))];
  if (!ids.length) {
    deleted[`addon_attachments${suffix}`] = 0;
    deleted[`addon_records${suffix}`] = 0;
    deleted[`addon_upload_tokens${suffix}`] = 0;
    return [];
  }
  await ensureAddonSchema().catch(() => {});
  const where = ownerKey ? 'person_id = ANY($1) AND owner_key = $2' : 'person_id = ANY($1)';
  const params = ownerKey ? [ids, ownerKey] : [ids];
  const keys = await selectKeys(query, `SELECT storage_key FROM addon_attachments WHERE ${where}`, params);
  await deleteCounted(query, deleted, `addon_attachments${suffix}`, `DELETE FROM addon_attachments WHERE ${where}`, params);
  await deleteCounted(query, deleted, `addon_records${suffix}`, `DELETE FROM addon_records WHERE ${where}`, params);
  await deleteCounted(query, deleted, `addon_upload_tokens${suffix}`, `DELETE FROM addon_upload_tokens WHERE ${where}`, params);
  return keys;
}

/** Delete the stored files for the given storage keys. Returns the object count. */
async function deleteAddonFiles(storageKeys) {
  return attachments.deleteObjects([...new Set(storageKeys || [])]);
}

/**
 * A MEMBER'S ADD-ON DATA, WHEN THEY ARE REMOVED FROM (OR LEAVE) A WORKSPACE.
 *
 * Add-on records and files are `personal` in v1: readable by the person and
 * nobody else, owners included. After removal nobody can reach them, so they
 * are erased with their files. A personal PROJECT is carried home instead by
 * removeMemberAndRehome; add-on data has no carry path yet.
 *
 * Deliberately here and NOT in dataErasureService: member removal must never
 * route through that service (tests/unit/teams-multi-user.test.js), which
 * deletes by owner_key across a dozen tables. This touches the add-on tables
 * only, for this one person in this one workspace. Never throws.
 */
async function eraseMemberAddonData(ownerKey, userId, { query = db.query } = {}) {
  const deleted = {};
  if (!ownerKey || !userId) return deleted;
  const keys = await erasePersonAddonData(query, [userId], deleted, { ownerKey, suffix: '' });
  deleted.addon_files_deleted = await deleteAddonFiles(keys).catch((err) => `error:${err.code || err.message}`);
  return deleted;
}

module.exports = {
  eraseMemberAddonData,
  briefLines,
  exportForActor,
  eraseWorkspaceAddonData,
  erasePersonAddonData,
  deleteAddonFiles,
  MAX_BRIEF_LINES,
};
