'use strict';

// THE `ctx` AN ADD-ON ACTION RECEIVES.
//
// Built by the platform for ONE call, from a scope the platform resolved:
// workspace through workspaceService, person through actorPersonId. Every
// records/attachments function closes over that scope, so a handler cannot
// name another person or workspace — there is no argument that would carry it.
//
// A READ action gets a ctx whose write functions refuse. read_addon is
// annotated read-only to the client, and that promise has to hold for every
// add-on, including one whose read handler tries to write.

const records = require('./recordsStore');
const attachments = require('./attachmentStore');
const signing = require('./signing');
const { visionCapability } = require('../config/llmVision');
const { AddonError } = require('./errors');
const { formatAjvErrors } = require('./loader');

function collectionOf(addon, name) {
  const collection = addon.collections[name];
  if (!collection) {
    throw new AddonError(400, 'addon_unknown_collection', `"${name}" is not a collection of ${addon.manifest.name}. Collections: ${Object.keys(addon.collections).join(', ')}.`);
  }
  return collection;
}

function validateData(addon, collectionName, data) {
  const collection = collectionOf(addon, collectionName);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new AddonError(400, 'addon_invalid_record', 'Record data must be an object.');
  }
  if (!collection.validate(data)) {
    throw new AddonError(400, 'addon_invalid_record', `That ${collectionName} record does not match its schema: ${formatAjvErrors(collection.validate.errors)}.`);
  }
}

function attachmentsCollection(addon, name) {
  const collection = collectionOf(addon, name);
  if (!collection.attachments) {
    throw new AddonError(400, 'addon_no_attachments', `The "${name}" collection does not take attachments.`);
  }
  return collection;
}

function buildContext({ addon, actor, ownerKey, personId, transport, mode, req = null }) {
  const scope = { ownerKey, addonId: addon.id, personId };
  const writable = mode === 'write';
  const guardWrite = (what) => {
    if (!writable) throw new AddonError(403, 'addon_read_only_action', `A read action cannot ${what}. Make it a write action.`);
  };

  const recordsApi = Object.freeze({
    list: (collection, options = {}) => {
      collectionOf(addon, collection);
      const { where, limit, cursor, order } = options || {};
      return records.list(scope, collection, { where, limit, cursor, order });
    },
    get: (collection, id) => {
      collectionOf(addon, collection);
      return records.get(scope, collection, id);
    },
    create: async (collection, data) => {
      guardWrite('create records');
      validateData(addon, collection, data);
      return records.create(scope, collection, data);
    },
    update: async (collection, id, patch) => {
      guardWrite('update records');
      collectionOf(addon, collection);
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new AddonError(400, 'addon_invalid_record', 'A patch must be an object.');
      }
      const existing = await records.get(scope, collection, id);
      if (!existing) return null;
      const merged = records.mergePatch(existing.data, patch);
      validateData(addon, collection, merged);
      return records.replaceData(scope, collection, id, merged);
    },
    remove: async (collection, id) => {
      guardWrite('delete records');
      collectionOf(addon, collection);
      const removed = await records.remove(scope, collection, id);
      if (removed) await attachments.removeForRecord(scope, collection, id);
      return removed;
    },
    count: (collection, where) => {
      collectionOf(addon, collection);
      return records.count(scope, collection, where);
    },
  });

  const attachmentsApi = Object.freeze({
    // recordId null: the files in this collection that are on no record yet.
    listFor: (collection, recordId = null) => {
      collectionOf(addon, collection);
      return attachments.listFor(scope, collection, recordId);
    },
    read: (attachmentId, variant = 'view') => attachments.read(scope, attachmentId, variant),
    signedUrl: async (attachmentId, variant = 'view', ttlSeconds) => {
      const row = await attachments.getRow(scope, attachmentId);
      if (!row) throw new AddonError(404, 'addon_attachment_not_found', 'No such attachment.');
      if (!attachments.VARIANTS.includes(variant)) throw new AddonError(400, 'addon_bad_variant', 'variant must be thumb, view or original.');
      return signing.signedAttachmentUrl({
        addonId: addon.id, attachmentId, variant, ownerKey, personId, ttlSeconds, base: signing.publicApiBase(req),
      });
    },
    createUploadLink: async ({ collection, ttlSeconds } = {}) => {
      guardWrite('create upload links');
      attachmentsCollection(addon, collection);
      const link = await signing.createUploadToken({
        ownerKey, personId, addonId: addon.id, collection, ttlSeconds, base: signing.publicApiBase(req),
      });
      return { url: link.url, expires_at: link.expires_at };
    },
    ingest: async ({ collection, recordId, buffer } = {}) => {
      guardWrite('store files');
      attachmentsCollection(addon, collection);
      return attachments.ingest(scope, { collection, recordId: recordId || null, buffer });
    },
    attach: async (attachmentId, recordId) => {
      guardWrite('attach files');
      return attachments.attach(scope, attachmentId, recordId);
    },
  });

  return Object.freeze({
    actor,
    ownerKey,
    personId,
    addonId: addon.id,
    transport,
    records: recordsApi,
    attachments: attachmentsApi,
    llm: visionCapability(),
    log: (message, fields) => {
      console.log(`[ADDON:${addon.id}] ${message}`, fields && typeof fields === 'object' ? JSON.stringify(fields) : '');
    },
  });
}

module.exports = { buildContext, validateData, attachmentsCollection, collectionOf };
