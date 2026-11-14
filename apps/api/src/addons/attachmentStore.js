'use strict';

// FILES ATTACHED TO ADD-ON RECORDS.
//
// A row in addon_attachments per upload, plus three objects in the storage
// adapter under `<storage_key>/<variant>`. Scoped like recordsStore: every
// read and write names the workspace, the add-on AND the person, so a photo is
// reachable by the person who uploaded it and nobody else.
//
// Limits (all env, all bytes/counts):
//   ADDON_MAX_UPLOAD_BYTES           default 15MB per file
//   ADDON_MAX_ATTACHMENTS_PER_PERSON default 1000
//   ADDON_MAX_BYTES_PER_PERSON       default 1GB stored (all variants)
// A self-hosted install has no limits unless the operator sets them.

const { randomUUID } = require('crypto');
const db = require('../config/db');
const { isSelfHosted } = require('../config/selfHosted');
const { ensureAddonSchema } = require('./schema');
const { getStorage } = require('./storage');
const { processImage } = require('./imageIngest');
const { AddonError } = require('./errors');

const VARIANTS = ['thumb', 'view', 'original'];
const VARIANT_FILE = { thumb: 'thumb.webp', view: 'view.webp', original: 'original' };
const VARIANT_MIME = { thumb: 'image/webp', view: 'image/webp' };

const MB = 1024 * 1024;

function limitFromEnv(name, hostedDefault, env = process.env) {
  const raw = typeof env[name] === 'string' ? env[name].trim() : '';
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return isSelfHosted(env) ? Infinity : hostedDefault;
}

function limits(env = process.env) {
  return {
    maxUploadBytes: limitFromEnv('ADDON_MAX_UPLOAD_BYTES', 15 * MB, env),
    maxAttachmentsPerPerson: limitFromEnv('ADDON_MAX_ATTACHMENTS_PER_PERSON', 1000, env),
    maxBytesPerPerson: limitFromEnv('ADDON_MAX_BYTES_PER_PERSON', 1024 * MB, env),
  };
}

function requireStorage() {
  const storage = getStorage();
  if (!storage) {
    throw new AddonError(503, 'addon_storage_unavailable', 'File uploads are not configured on this server (no add-on storage). Everything else in add-ons still works.');
  }
  return storage;
}

function objectKeys(storageKey) {
  return VARIANTS.map((v) => `${storageKey}/${VARIANT_FILE[v]}`);
}

function toAttachment(row) {
  return {
    id: row.id,
    addon_id: row.addon_id,
    collection: row.collection,
    record_id: row.record_id || null,
    mime: row.mime,
    bytes: Number(row.bytes),
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

async function usage(personId, { query = db.query } = {}) {
  const r = await query(
    'SELECT count(*)::int AS n, COALESCE(sum(stored_bytes), 0)::bigint AS bytes FROM addon_attachments WHERE person_id = $1',
    [personId],
    'org-system'
  );
  return { count: r.rows[0]?.n || 0, bytes: Number(r.rows[0]?.bytes || 0) };
}

async function recordExists(scope, collection, recordId, query) {
  const r = await query(
    `SELECT 1 FROM addon_records
      WHERE id = $1 AND owner_key = $2 AND addon_id = $3 AND person_id = $4 AND collection = $5`,
    [recordId, scope.ownerKey, scope.addonId, scope.personId, collection],
    'org-system'
  );
  return r.rows.length > 0;
}

/** Process and store one image. Returns the attachment row (see toAttachment). */
async function ingest(scope, { collection, recordId = null, buffer }, { query = db.query } = {}) {
  await ensureAddonSchema();
  const storage = requireStorage();
  const lim = limits();
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new AddonError(400, 'addon_empty_file', 'The upload was empty.');
  if (buffer.length > lim.maxUploadBytes) {
    throw new AddonError(413, 'addon_file_too_large', `Files may be at most ${Math.round(lim.maxUploadBytes / MB)}MB.`);
  }
  if (recordId && !(await recordExists(scope, collection, recordId, query))) {
    throw new AddonError(404, 'addon_record_not_found', 'No such record to attach the file to.');
  }
  const used = await usage(scope.personId, { query });
  if (used.count >= lim.maxAttachmentsPerPerson) {
    throw new AddonError(413, 'addon_attachment_limit', `You have reached the limit of ${lim.maxAttachmentsPerPerson} files.`);
  }

  const image = await processImage(buffer);
  const storedBytes = image.variants.thumb.length + image.variants.view.length + image.variants.original.length;
  if (used.bytes + storedBytes > lim.maxBytesPerPerson) {
    throw new AddonError(413, 'addon_storage_limit', 'This upload would take you over your file storage limit.');
  }

  const id = `att_${randomUUID()}`;
  const storageKey = `${scope.addonId}/${id}`;
  const written = [];
  try {
    for (const variant of VARIANTS) {
      const key = `${storageKey}/${VARIANT_FILE[variant]}`;
      await storage.put(key, image.variants[variant]);
      written.push(key);
    }
    const r = await query(
      `INSERT INTO addon_attachments
         (id, owner_key, person_id, addon_id, collection, record_id, sha256, mime, bytes, stored_bytes, width, height, storage_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [id, scope.ownerKey, scope.personId, scope.addonId, collection, recordId, image.sha256, image.mime,
        image.variants.original.length, storedBytes, image.width, image.height, storageKey],
      'org-system'
    );
    return toAttachment(r.rows[0]);
  } catch (err) {
    // No row, no files: a half-written upload must not become storage nobody can reach or erase.
    await Promise.all(written.map((key) => storage.delete(key).catch(() => {})));
    throw err;
  }
}

async function getRow(scope, attachmentId, { query = db.query } = {}) {
  await ensureAddonSchema();
  if (typeof attachmentId !== 'string' || !attachmentId) return null;
  const r = await query(
    'SELECT * FROM addon_attachments WHERE id = $1 AND owner_key = $2 AND addon_id = $3 AND person_id = $4',
    [attachmentId, scope.ownerKey, scope.addonId, scope.personId],
    'org-system'
  );
  return r.rows[0] || null;
}

/** For the signed-URL route only: the caller verifies the signature against the row's owner and person. */
async function getRowUnscoped(addonId, attachmentId, { query = db.query } = {}) {
  await ensureAddonSchema();
  const r = await query('SELECT * FROM addon_attachments WHERE id = $1 AND addon_id = $2', [attachmentId, addonId], 'org-system');
  return r.rows[0] || null;
}

const UNLINKED_LIMIT = 500;

/**
 * The files on one record, oldest first. recordId null (or omitted) lists the
 * person's files in the collection that are on NO record yet — what an upload
 * link or a bulk dashboard upload leaves behind — capped at UNLINKED_LIMIT.
 */
async function listFor(scope, collection, recordId, { query = db.query } = {}) {
  await ensureAddonSchema();
  const unlinked = recordId === null || recordId === undefined || recordId === '';
  const r = await query(
    `SELECT * FROM addon_attachments
      WHERE owner_key = $1 AND addon_id = $2 AND person_id = $3 AND collection = $4
        AND ${unlinked ? 'record_id IS NULL' : 'record_id = $5'}
      ORDER BY created_at, id
      ${unlinked ? `LIMIT ${UNLINKED_LIMIT}` : ''}`,
    unlinked
      ? [scope.ownerKey, scope.addonId, scope.personId, collection]
      : [scope.ownerKey, scope.addonId, scope.personId, collection, String(recordId)],
    'org-system'
  );
  return r.rows.map(toAttachment);
}

function assertVariant(variant) {
  if (!VARIANTS.includes(variant)) throw new AddonError(400, 'addon_bad_variant', 'variant must be thumb, view or original.');
}

/** Bytes of one variant of a row already authorised by the caller. */
async function readRow(row, variant) {
  assertVariant(variant);
  const storage = requireStorage();
  const buffer = await storage.get(`${row.storage_key}/${VARIANT_FILE[variant]}`);
  if (!buffer) throw new AddonError(404, 'addon_attachment_missing', 'The stored file is missing.');
  return { buffer, mime: VARIANT_MIME[variant] || row.mime };
}

async function read(scope, attachmentId, variant, opts) {
  const row = await getRow(scope, attachmentId, opts);
  if (!row) throw new AddonError(404, 'addon_attachment_not_found', 'No such attachment.');
  return (await readRow(row, variant)).buffer;
}

async function attach(scope, attachmentId, recordId, { query = db.query } = {}) {
  await ensureAddonSchema();
  const row = await getRow(scope, attachmentId, { query });
  if (!row) throw new AddonError(404, 'addon_attachment_not_found', 'No such attachment.');
  if (recordId && !(await recordExists(scope, row.collection, recordId, query))) {
    throw new AddonError(404, 'addon_record_not_found', 'No such record to attach the file to.');
  }
  const r = await query(
    'UPDATE addon_attachments SET record_id = $5 WHERE id = $1 AND owner_key = $2 AND addon_id = $3 AND person_id = $4 RETURNING *',
    [attachmentId, scope.ownerKey, scope.addonId, scope.personId, recordId || null],
    'org-system'
  );
  return toAttachment(r.rows[0]);
}

/** Delete files for rows; best effort per object, returns how many objects were deleted. */
async function deleteObjects(storageKeys) {
  const storage = getStorage();
  if (!storage || !storageKeys.length) return 0;
  let n = 0;
  for (const key of storageKeys.flatMap(objectKeys)) {
    try {
      if (await storage.delete(key)) n += 1;
    } catch (err) {
      console.warn(`[ADDONS] could not delete stored object ${key}: ${err.message}`);
    }
  }
  return n;
}

async function remove(scope, attachmentId, { query = db.query } = {}) {
  await ensureAddonSchema();
  const r = await query(
    'DELETE FROM addon_attachments WHERE id = $1 AND owner_key = $2 AND addon_id = $3 AND person_id = $4 RETURNING storage_key',
    [attachmentId, scope.ownerKey, scope.addonId, scope.personId],
    'org-system'
  );
  if (!r.rows.length) return false;
  await deleteObjects(r.rows.map((row) => row.storage_key));
  return true;
}

async function removeForRecord(scope, collection, recordId, { query = db.query } = {}) {
  await ensureAddonSchema();
  const r = await query(
    `DELETE FROM addon_attachments
      WHERE owner_key = $1 AND addon_id = $2 AND person_id = $3 AND collection = $4 AND record_id = $5
      RETURNING storage_key`,
    [scope.ownerKey, scope.addonId, scope.personId, collection, recordId],
    'org-system'
  );
  await deleteObjects(r.rows.map((row) => row.storage_key));
  return r.rows.length;
}

/** The account export's listing (no bytes) for one person in one workspace. */
async function listForExport(ownerKey, personId, { query = db.query } = {}) {
  await ensureAddonSchema();
  const r = await query(
    'SELECT * FROM addon_attachments WHERE owner_key = $1 AND person_id = $2 ORDER BY addon_id, created_at',
    [ownerKey, personId],
    'org-system'
  );
  return r.rows.map((row) => ({ ...toAttachment(row), sha256: row.sha256 }));
}

module.exports = {
  ingest,
  getRow,
  getRowUnscoped,
  listFor,
  read,
  readRow,
  attach,
  remove,
  removeForRecord,
  deleteObjects,
  listForExport,
  limits,
  objectKeys,
  VARIANTS,
  UNLINKED_LIMIT,
};
