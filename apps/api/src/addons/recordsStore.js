'use strict';

// ONE GENERIC TABLE FOR EVERY ADD-ON'S RECORDS.
//
// Every function takes a SCOPE — { ownerKey, addonId, personId } — and every
// statement filters on all three. ctx.records closes over a scope the platform
// built, so a handler cannot read another person's rows: there is no parameter
// through which it could name one. v1 visibility is 'personal' only, which is
// exactly this filter; workspace owners are excluded like everybody else.
//
// ENCRYPTED AT REST like briefs: `data` is sealed with the owner's DEK
// (encryptionService) whenever ENCRYPTION_MASTER_KEY is set, and stored as
// { _enc: "v1:..." }. That makes `where` impossible to evaluate in SQL, so it is
// evaluated IN MEMORY after decrypt: rows are read in keyset pages in the
// requested order and filtered until `limit` matches are found or SCAN_CAP rows
// have been read for this call. The same path runs when encryption is off, so
// the two configurations cannot answer differently. A filtered count scans at
// most SCAN_CAP rows too.

const { randomUUID } = require('crypto');
const db = require('../config/db');
const encryption = require('../services/encryptionService');
const { ensureAddonSchema } = require('./schema');
const { AddonError } = require('./errors');

const SCAN_CAP = 5000;
const SCAN_BATCH = 500;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_DATA_BYTES = 64 * 1024;

const ORDERS = {
  '-created_at': { column: 'created_at', dir: 'DESC' },
  created_at: { column: 'created_at', dir: 'ASC' },
  '-updated_at': { column: 'updated_at', dir: 'DESC' },
  updated_at: { column: 'updated_at', dir: 'ASC' },
};

function assertScope(scope) {
  if (!scope || !scope.ownerKey || !scope.addonId || !scope.personId) {
    throw new AddonError(403, 'addon_scope_missing', 'Add-on data needs a workspace and a person.');
  }
}

async function sealData(ownerKey, data) {
  if (!encryption.shouldEncrypt()) return data;
  return encryption.encryptContextObject(ownerKey, data);
}

async function openData(ownerKey, stored) {
  if (stored && stored._enc) return encryption.decryptContextObject(ownerKey, stored);
  return stored || {};
}

async function toRecord(row) {
  return {
    id: row.id,
    data: await openData(row.owner_key, row.data),
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

function matchesWhere(data, where) {
  if (!where) return true;
  for (const [field, expected] of Object.entries(where)) {
    const actual = data ? data[field] : undefined;
    const options = Array.isArray(expected) ? expected : [expected];
    const hit = options.some((option) => {
      if (Array.isArray(actual)) return actual.some((item) => sameValue(item, option));
      return sameValue(actual, option);
    });
    if (!hit) return false;
  }
  return true;
}

function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a == b;
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

function normalizeWhere(where) {
  if (where === undefined || where === null) return null;
  if (typeof where !== 'object' || Array.isArray(where)) {
    throw new AddonError(400, 'addon_bad_where', '`where` must be a flat object of field: value.');
  }
  return Object.keys(where).length ? where : null;
}

function encodeCursor(row, column) {
  const at = row[column] instanceof Date ? row[column].toISOString() : String(row[column]);
  return Buffer.from(JSON.stringify([at, row.id])).toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const [at, id] = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (typeof at !== 'string' || typeof id !== 'string' || Number.isNaN(Date.parse(at))) throw new Error('shape');
    return { at, id };
  } catch (_) {
    throw new AddonError(400, 'addon_bad_cursor', 'That cursor is not one this server issued.');
  }
}

function checkDataSize(data) {
  const size = Buffer.byteLength(JSON.stringify(data), 'utf8');
  if (size > MAX_DATA_BYTES) {
    throw new AddonError(413, 'addon_record_too_large', `A record may hold at most ${MAX_DATA_BYTES / 1024}KB of data.`);
  }
}

async function list(scope, collection, { where, limit, cursor, order } = {}, { query = db.query } = {}) {
  assertScope(scope);
  await ensureAddonSchema();
  const filter = normalizeWhere(where);
  const ord = ORDERS[order || '-created_at'];
  if (!ord) throw new AddonError(400, 'addon_bad_order', '`order` must be created_at, -created_at, updated_at or -updated_at.');
  const want = Math.min(Math.max(1, Math.floor(Number(limit) || DEFAULT_LIMIT)), MAX_LIMIT);
  let after = decodeCursor(cursor);
  const cmp = ord.dir === 'DESC' ? '<' : '>';
  const rows = [];
  let scanned = 0;
  let exhausted = false;
  let lastRaw = null;

  while (rows.length <= want && scanned < SCAN_CAP) {
    const params = [scope.ownerKey, scope.addonId, scope.personId, collection, SCAN_BATCH];
    let keyset = '';
    if (after) {
      params.push(after.at, after.id);
      keyset = `AND (${ord.column}, id) ${cmp} ($6::timestamptz, $7)`;
    }
    const r = await query(
      `SELECT id, owner_key, data, created_at, updated_at FROM addon_records
        WHERE owner_key = $1 AND addon_id = $2 AND person_id = $3 AND collection = $4
          AND visibility = 'personal' ${keyset}
        ORDER BY ${ord.column} ${ord.dir}, id ${ord.dir}
        LIMIT $5`,
      params,
      'org-system'
    );
    for (const raw of r.rows) {
      scanned += 1;
      lastRaw = raw;
      const record = await toRecord(raw);
      if (matchesWhere(record.data, filter)) {
        rows.push({ record, raw });
        if (rows.length > want) break;
      }
      if (scanned >= SCAN_CAP) break;
    }
    if (r.rows.length < SCAN_BATCH) { exhausted = true; break; }
    after = { at: (lastRaw[ord.column] instanceof Date ? lastRaw[ord.column].toISOString() : String(lastRaw[ord.column])), id: lastRaw.id };
  }

  let nextCursor = null;
  if (rows.length > want) {
    rows.length = want;
    nextCursor = encodeCursor(rows[rows.length - 1].raw, ord.column);
  } else if (!exhausted && scanned >= SCAN_CAP && lastRaw) {
    // Stopped by the scan cap, not by the end of the data: resume after the
    // last row READ, so the next call continues the scan instead of re-reading.
    nextCursor = encodeCursor(lastRaw, ord.column);
  }
  return { rows: rows.map((entry) => entry.record), next_cursor: nextCursor };
}

async function get(scope, collection, id, { query = db.query } = {}) {
  assertScope(scope);
  await ensureAddonSchema();
  if (typeof id !== 'string' || !id) return null;
  const r = await query(
    `SELECT id, owner_key, data, created_at, updated_at FROM addon_records
      WHERE id = $1 AND owner_key = $2 AND addon_id = $3 AND person_id = $4 AND collection = $5
        AND visibility = 'personal'`,
    [id, scope.ownerKey, scope.addonId, scope.personId, collection],
    'org-system'
  );
  return r.rows[0] ? toRecord(r.rows[0]) : null;
}

async function create(scope, collection, data, { query = db.query } = {}) {
  assertScope(scope);
  await ensureAddonSchema();
  checkDataSize(data);
  const id = `rec_${randomUUID()}`;
  const sealed = await sealData(scope.ownerKey, data);
  const r = await query(
    `INSERT INTO addon_records (id, owner_key, addon_id, collection, person_id, visibility, data)
     VALUES ($1, $2, $3, $4, $5, 'personal', $6)
     RETURNING id, owner_key, data, created_at, updated_at`,
    [id, scope.ownerKey, scope.addonId, collection, scope.personId, JSON.stringify(sealed)],
    'org-system'
  );
  return { ...(await toRecord(r.rows[0])), data };
}

/** Merge-patch semantics: a key set to null is removed. Returns null when no such row. */
function mergePatch(existing, patch) {
  const merged = { ...(existing || {}) };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

async function replaceData(scope, collection, id, data, { query = db.query } = {}) {
  checkDataSize(data);
  const sealed = await sealData(scope.ownerKey, data);
  const r = await query(
    `UPDATE addon_records SET data = $6, updated_at = date_trunc('milliseconds', NOW())
      WHERE id = $1 AND owner_key = $2 AND addon_id = $3 AND person_id = $4 AND collection = $5
        AND visibility = 'personal'
      RETURNING id, owner_key, data, created_at, updated_at`,
    [id, scope.ownerKey, scope.addonId, scope.personId, collection, JSON.stringify(sealed)],
    'org-system'
  );
  return r.rows[0] ? { ...(await toRecord(r.rows[0])), data } : null;
}

async function remove(scope, collection, id, { query = db.query } = {}) {
  assertScope(scope);
  await ensureAddonSchema();
  const r = await query(
    `DELETE FROM addon_records
      WHERE id = $1 AND owner_key = $2 AND addon_id = $3 AND person_id = $4 AND collection = $5
        AND visibility = 'personal'`,
    [id, scope.ownerKey, scope.addonId, scope.personId, collection],
    'org-system'
  );
  return r.rowCount > 0;
}

async function count(scope, collection, where, { query = db.query } = {}) {
  assertScope(scope);
  await ensureAddonSchema();
  const filter = normalizeWhere(where);
  if (!filter) {
    const r = await query(
      `SELECT count(*)::int AS n FROM addon_records
        WHERE owner_key = $1 AND addon_id = $2 AND person_id = $3 AND collection = $4 AND visibility = 'personal'`,
      [scope.ownerKey, scope.addonId, scope.personId, collection],
      'org-system'
    );
    return r.rows[0]?.n || 0;
  }
  let n = 0;
  let cursor = null;
  let scanned = 0;
  do {
    // Unfiltered pages, filtered here, so the scan cap counts rows READ.
    const page = await list(scope, collection, { limit: MAX_LIMIT, cursor }, { query });
    scanned += page.rows.length;
    n += page.rows.filter((row) => matchesWhere(row.data, filter)).length;
    cursor = page.next_cursor;
  } while (cursor && scanned < SCAN_CAP);
  return n;
}

/** Counts per collection for one person, for the brief line. One query. */
async function countsByCollection(scope, { query = db.query } = {}) {
  assertScope(scope);
  await ensureAddonSchema();
  const r = await query(
    `SELECT collection, count(*)::int AS n FROM addon_records
      WHERE owner_key = $1 AND addon_id = $2 AND person_id = $3 AND visibility = 'personal'
      GROUP BY collection`,
    [scope.ownerKey, scope.addonId, scope.personId],
    'org-system'
  );
  return Object.fromEntries(r.rows.map((row) => [row.collection, row.n]));
}

/** Every record a person holds in a workspace, decrypted, for the account export. */
async function exportForPerson(ownerKey, personId, { query = db.query } = {}) {
  await ensureAddonSchema();
  const r = await query(
    `SELECT id, owner_key, addon_id, collection, data, created_at, updated_at FROM addon_records
      WHERE owner_key = $1 AND person_id = $2
      ORDER BY addon_id, collection, created_at`,
    [ownerKey, personId],
    'org-system'
  );
  const out = [];
  for (const row of r.rows) out.push({ addon_id: row.addon_id, collection: row.collection, ...(await toRecord(row)) });
  return out;
}

module.exports = {
  list,
  get,
  create,
  replaceData,
  mergePatch,
  remove,
  count,
  countsByCollection,
  exportForPerson,
  matchesWhere,
  SCAN_CAP,
  MAX_LIMIT,
};
