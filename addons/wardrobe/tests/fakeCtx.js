'use strict';

// An in-memory implementation of the add-on platform's ctx contract, faithful
// enough to test Wardrobe without the platform:
//  - records are scoped to the calling person (two ctxs over one store cannot
//    see each other's rows);
//  - `where` is a flat map of top-level data fields to a value or an array of
//    values (any-of);
//  - create/update validate data against the collection's JSON Schema from
//    addon.json, using a small subset validator, so a field the add-on writes
//    but the schema does not allow fails here before it fails on the platform;
//  - rows are { id, data, created_at, updated_at } and are returned as copies.

const fs = require('node:fs');
const path = require('node:path');

const ADDON_DIR = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ADDON_DIR, 'addon.json'), 'utf8'));
const schemas = {};
for (const [name, col] of Object.entries(manifest.collections)) {
  schemas[name] = JSON.parse(fs.readFileSync(path.join(ADDON_DIR, col.schema), 'utf8'));
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function validate(schema, value, at, errors) {
  if (schema.enum && !schema.enum.some((e) => e === value)) {
    errors.push(`${at}: ${JSON.stringify(value)} not in enum`);
    return;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = typeOf(value);
    const ok = types.some((want) => want === t || (want === 'number' && t === 'integer'));
    if (!ok) { errors.push(`${at}: expected ${types.join('|')}, got ${t}`); return; }
  }
  if (typeof value === 'string' && schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.items) value.forEach((v, i) => validate(schema.items, v, `${at}[${i}]`, errors));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const req of schema.required || []) if (!(req in value)) errors.push(`${at}.${req}: required`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties && schema.properties[k]) validate(schema.properties[k], v, `${at}.${k}`, errors);
      else if (schema.properties && schema.additionalProperties === false) errors.push(`${at}.${k}: not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validate(schema.additionalProperties, v, `${at}.${k}`, errors);
    }
  }
}

function assertValid(collection, data) {
  const schema = schemas[collection];
  if (!schema) throw new Error(`unknown collection ${collection}`);
  const errors = [];
  validate(schema, data, collection, errors);
  if (errors.length) throw new Error(`schema violation: ${errors.join('; ')}`);
}

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function createStore() {
  return { rows: [], attachments: [], blobs: new Map(), seq: 0, clock: Date.parse('2026-11-01T00:00:00Z') };
}

function matchesWhere(data, where) {
  if (!where) return true;
  return Object.entries(where).every(([k, want]) => {
    const have = data[k];
    return Array.isArray(want) ? want.some((w) => w === have) : want === have;
  });
}

/**
 * makeCtx({ store, personId, llm, transport })
 * llm: null (no vision) or { describeImage(buffer, prompt) }.
 */
function makeCtx({ store = createStore(), personId = 'person_a', llm = null, transport = 'mcp-hosted' } = {}) {
  const logs = [];
  const tick = () => new Date((store.clock += 1000)).toISOString();
  const mine = (collection) => store.rows.filter((r) => r.person_id === personId && r.collection === collection);
  const pub = (r) => ({ id: r.id, data: clone(r.data), created_at: r.created_at, updated_at: r.updated_at });
  const findRow = (collection, id) => mine(collection).find((r) => r.id === id) || null;

  const records = {
    // Platform default order is '-created_at'; it also takes created_at,
    // updated_at and -updated_at.
    async list(collection, { where, limit = 50, cursor, order = '-created_at' } = {}) {
      let rows = mine(collection).filter((r) => matchesWhere(r.data, where));
      const desc = order.startsWith('-');
      const key = order.replace(/^-/, '');
      if (!['created_at', 'updated_at'].includes(key)) throw new Error(`bad order ${order}`);
      rows = rows.slice().sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (desc ? -1 : 1));
      const offset = cursor ? Number(cursor) : 0;
      const page = rows.slice(offset, offset + limit);
      return { rows: page.map(pub), next_cursor: offset + limit < rows.length ? String(offset + limit) : null };
    },
    async get(collection, id) {
      const r = findRow(collection, id);
      return r ? pub(r) : null;
    },
    async create(collection, data) {
      assertValid(collection, data);
      const now = tick();
      store.seq += 1;
      const r = { id: `rec_${String(store.seq).padStart(6, '0')}`, collection, person_id: personId, data: clone(data), created_at: now, updated_at: now };
      store.rows.push(r);
      return pub(r);
    },
    async update(collection, id, patch) {
      const r = findRow(collection, id);
      if (!r) throw new Error(`not found: ${collection}/${id}`);
      const next = { ...r.data, ...clone(patch) };
      assertValid(collection, next);
      r.data = next;
      r.updated_at = tick();
      return pub(r);
    },
    async remove(collection, id) {
      const r = findRow(collection, id);
      if (!r) throw new Error(`not found: ${collection}/${id}`);
      store.rows.splice(store.rows.indexOf(r), 1);
      return { removed: true };
    },
    async count(collection, where) {
      return mine(collection).filter((r) => matchesWhere(r.data, where)).length;
    },
  };

  const attachments = {
    async listFor(collection, recordId) {
      return store.attachments
        .filter((a) => a.person_id === personId && a.collection === collection && a.record_id === recordId)
        .map(({ id, mime, bytes, width, height }) => ({ id, mime, bytes, width, height }));
    },
    async attach(attachmentId, recordId) {
      const a = store.attachments.find((x) => x.id === attachmentId && x.person_id === personId);
      if (!a) throw new Error('attachment not found');
      a.record_id = recordId;
      return { id: a.id, mime: a.mime, bytes: a.bytes, width: a.width, height: a.height };
    },
    async read(attachmentId, variant) {
      if (!['thumb', 'view', 'original'].includes(variant)) throw new Error(`bad variant ${variant}`);
      const a = store.attachments.find((x) => x.id === attachmentId && x.person_id === personId);
      if (!a) throw new Error('attachment not found');
      return store.blobs.get(`${attachmentId}:${variant}`) || store.blobs.get(`${attachmentId}:original`);
    },
    async signedUrl(attachmentId, variant, ttlSeconds) {
      return `https://files.test/${attachmentId}/${variant}?ttl=${ttlSeconds}`;
    },
    async createUploadLink({ collection, ttlSeconds }) {
      return { url: `https://app.test/u/${collection}/${personId}`, expires_at: new Date(store.clock + ttlSeconds * 1000).toISOString() };
    },
    async ingest({ collection, recordId, buffer, filename }) {
      store.seq += 1;
      const a = { id: `att_${String(store.seq).padStart(6, '0')}`, person_id: personId, collection, record_id: recordId || null, mime: 'image/webp', bytes: buffer.length, width: 256, height: 256, filename };
      store.attachments.push(a);
      store.blobs.set(`${a.id}:original`, buffer);
      store.blobs.set(`${a.id}:thumb`, buffer);
      store.blobs.set(`${a.id}:view`, buffer);
      return { id: a.id, mime: a.mime, bytes: a.bytes, width: a.width, height: a.height };
    },
  };

  return {
    actor: { id: personId },
    ownerKey: 'org_test',
    personId,
    addonId: 'wardrobe',
    transport,
    records,
    attachments,
    llm,
    log(message, fields) { logs.push({ message, fields }); },
    _logs: logs,
    _store: store,
  };
}

module.exports = { makeCtx, createStore, assertValid };
