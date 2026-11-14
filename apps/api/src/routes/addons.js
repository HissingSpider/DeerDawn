'use strict';

// /api/v1/addons — the add-on platform's HTTP surface.
//
//   GET    /                                  catalog, with `enabled` for this workspace
//   GET    /brief-lines                       the start_session add-on lines (local MCP server)
//   POST   /:id/enable | /:id/disable         owners in a team; the person in a solo workspace
//   POST   /:id/actions/:action               body { args } -> { text, data, images }
//   POST   /:id/attachments                   multipart: file, collection, record_id?
//   GET    /:id/attachments?collection&record_id? the files on one record, or (no record_id) on none yet
//   GET    /:id/attachments/:attachmentId     ?variant=thumb|view|original (session, or a signed link)
//   DELETE /:id/attachments/:attachmentId
//   GET    /:id/upload/:token                 a plain upload form, no session
//   POST   /:id/upload/:token                 the form's target, no session
//
// The two upload-token routes and a SIGNED attachment GET are the only ones
// that run without requireAuth. Each is bound by something the platform issued
// (an HMAC signature over the exact row, or a hashed single-person token), and
// each re-checks the stored row before serving.
//
// Writes go through the auth middleware like every other POST: a viewer's
// credential is capped to read, and a request bound to a billing-lapsed team
// by the fallback is refused (409 workspace_inactive) before reaching here.
// A POST is a POST to that middleware, so on a lapsed team's fallback binding
// READ actions over HTTP are refused too; MCP transports fall back for both.

const express = require('express');
const Busboy = require('busboy');
const rateLimit = require('express-rate-limit');
const { requireAuth, requireAnyScope } = require('../middleware/auth');
const { resolveRateLimitStore, shouldSkipLimiter, disableFallback } = require('../middleware/rateLimit');
const registry = require('../addons/registry');
const enablement = require('../addons/enablement');
const attachments = require('../addons/attachmentStore');
const signing = require('../addons/signing');
const { runAddonAction, mayManage, mayWrite, scopeFor, splitIncludeData } = require('../addons/runner');
const { attachmentsCollection } = require('../addons/context');
const { AddonError, isAddonError } = require('../addons/errors');
const workspace = require('../services/workspaceService');

const router = express.Router();

const UPLOAD_FORM_MAX_FILES = 20;

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  store: resolveRateLimitStore('rl:addon-upload:'),
  skip: (req) => shouldSkipLimiter(req) || disableFallback,
});

function sendError(res, err, next) {
  if (isAddonError(err)) return res.status(err.status).json({ error: err.code, message: err.message });
  return next(err);
}

function loadAddonOr404(req, res) {
  const addon = registry.getAddon(req.params.id);
  if (!addon) {
    res.status(404).json({ error: 'addon_not_found', message: `There is no add-on "${req.params.id}" on this server.` });
    return null;
  }
  return addon;
}

function catalogEntry(addon, enabled) {
  const m = addon.manifest;
  return {
    id: addon.id,
    name: m.name,
    version: m.version,
    description: m.description || '',
    kind: addon.kind,
    enabled,
    collections: Object.values(addon.collections).map((c) => ({ name: c.name, attachments: c.attachments, schema: c.schema })),
    views: Array.isArray(m.views) ? m.views : [],
    actions: Object.values(addon.actions).map((a) => ({ name: a.name, mode: a.mode, description: a.description })),
  };
}

/**
 * Read a multipart body. Files are buffered (images are small, and sharp wants
 * a buffer); each is capped at `maxFileBytes`, and anything over the cap is
 * reported as truncated rather than silently cut.
 */
function parseMultipart(req, { maxFileBytes, maxFiles }) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({
        headers: req.headers,
        limits: { files: maxFiles, fields: 10, fieldSize: 4096, ...(Number.isFinite(maxFileBytes) ? { fileSize: maxFileBytes } : {}) },
      });
    } catch (_) {
      reject(new AddonError(400, 'addon_bad_upload', 'Send the file as multipart/form-data.'));
      return;
    }
    const fields = {};
    const files = [];
    let tooMany = false;
    bb.on('field', (name, value) => { fields[name] = value; });
    bb.on('file', (name, stream, info) => {
      const file = { field: name, filename: info.filename || '', truncated: false, buffer: null, chunks: [] };
      stream.on('data', (chunk) => file.chunks.push(chunk));
      stream.on('limit', () => { file.truncated = true; });
      files.push(file);
    });
    bb.on('filesLimit', () => { tooMany = true; });
    bb.on('error', () => reject(new AddonError(400, 'addon_bad_upload', 'The upload could not be read.')));
    bb.on('close', () => {
      if (tooMany) { reject(new AddonError(413, 'addon_too_many_files', `At most ${maxFiles} files per upload.`)); return; }
      for (const file of files) {
        file.buffer = Buffer.concat(file.chunks);
        delete file.chunks;
      }
      resolve({ fields, files });
    });
    req.pipe(bb);
  });
}

function oneFileFrom(parsed, maxBytes) {
  const file = parsed.files.find((f) => f.field === 'file') || parsed.files[0];
  if (!file) throw new AddonError(400, 'addon_bad_upload', 'No file in the upload (expected a "file" field).');
  if (file.truncated) throw new AddonError(413, 'addon_file_too_large', `Files may be at most ${Math.round(maxBytes / (1024 * 1024))}MB.`);
  return file;
}

function sendVariant(res, buffer, mime) {
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', 'default-src \'none\'; sandbox');
  // The dashboard is on another origin and fetches these with credentials.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  return res.end(buffer);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

function uploadPage({ title, body }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>
  body { font: 16px/1.5 system-ui, -apple-system, sans-serif; margin: 0; padding: 24px 16px; background: #f6f5f2; color: #1d1d1b; }
  main { max-width: 480px; margin: 0 auto; background: #fff; border: 1px solid #e2e0da; border-radius: 10px; padding: 20px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0 0 16px; color: #55534d; }
  input[type=file] { display: block; width: 100%; margin: 0 0 16px; }
  button { font: inherit; background: #1d1d1b; color: #fff; border: 0; border-radius: 8px; padding: 10px 16px; width: 100%; }
  @media (prefers-color-scheme: dark) {
    body { background: #141413; color: #ecebe6; } main { background: #1d1d1b; border-color: #34332f; }
    p { color: #a9a79f; } button { background: #ecebe6; color: #141413; }
  }
</style></head><body><main>${body}</main></body></html>`;
}

function sendUploadPage(res, status, title, body) {
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Inline styles only; the form posts back to this same URL.
  res.setHeader('Content-Security-Policy', 'default-src \'none\'; style-src \'unsafe-inline\'; form-action \'self\'; base-uri \'none\'; frame-ancestors \'none\'');
  return res.send(uploadPage({ title, body }));
}

// ─── No session: the upload link ────────────────────────────────────────────

router.get('/:id/upload/:token', uploadLimiter, async (req, res, next) => {
  try {
    const addon = registry.getAddon(req.params.id);
    const binding = addon ? await signing.resolveUploadToken(addon.id, req.params.token) : null;
    if (!binding) {
      return sendUploadPage(res, 404, 'Link expired', '<h1>This upload link has expired</h1><p>Ask your assistant for a new one.</p>');
    }
    const name = escapeHtml(addon.manifest.name);
    return sendUploadPage(res, 200, `Upload to ${addon.manifest.name}`, `
      <h1>Upload photos to ${name}</h1>
      <p>Choose up to ${UPLOAD_FORM_MAX_FILES} photos. They are private to you. Location data is removed.</p>
      <form method="post" enctype="multipart/form-data">
        <input type="file" name="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple required>
        <button type="submit">Upload</button>
      </form>`);
  } catch (err) { return next(err); }
});

router.post('/:id/upload/:token', uploadLimiter, async (req, res, next) => {
  const wantsJson = /application\/json/.test(req.get('accept') || '');
  try {
    const addon = registry.getAddon(req.params.id);
    const binding = addon ? await signing.resolveUploadToken(addon.id, req.params.token, { consume: true }) : null;
    if (!binding) {
      if (wantsJson) return res.status(404).json({ error: 'addon_upload_link_expired', message: 'This upload link has expired.' });
      return sendUploadPage(res, 404, 'Link expired', '<h1>This upload link has expired</h1><p>Ask your assistant for a new one.</p>');
    }
    // The add-on must still be on, and the collection still take files.
    if (!(await enablement.isEnabled(binding.owner_key, addon.id))) {
      throw new AddonError(409, 'addon_disabled', `${addon.manifest.name} is switched off for this workspace.`);
    }
    attachmentsCollection(addon, binding.collection);
    const { maxUploadBytes } = attachments.limits();
    const parsed = await parseMultipart(req, { maxFileBytes: maxUploadBytes, maxFiles: UPLOAD_FORM_MAX_FILES });
    const scope = { ownerKey: binding.owner_key, addonId: addon.id, personId: binding.person_id };
    const stored = [];
    const failed = [];
    for (const file of parsed.files) {
      if (!file.buffer || !file.buffer.length) continue;
      try {
        if (file.truncated) throw new AddonError(413, 'addon_file_too_large', 'File too large.');
        stored.push(await attachments.ingest(scope, { collection: binding.collection, buffer: file.buffer }));
      } catch (err) {
        if (!isAddonError(err)) throw err;
        failed.push({ filename: file.filename, error: err.code, message: err.message });
      }
    }
    if (wantsJson) return res.status(stored.length ? 201 : 400).json({ attachments: stored, failed });
    const failedHtml = failed.length
      ? `<p>${failed.length} could not be added:</p><ul>${failed.map((f) => `<li>${escapeHtml(f.filename || 'file')}: ${escapeHtml(f.message)}</li>`).join('')}</ul>`
      : '';
    return sendUploadPage(res, stored.length ? 201 : 400, 'Uploaded', `
      <h1>${stored.length} photo${stored.length === 1 ? '' : 's'} added</h1>
      <p>You can go back to your assistant now, or add more below.</p>${failedHtml}
      <form method="post" enctype="multipart/form-data">
        <input type="file" name="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple required>
        <button type="submit">Upload more</button>
      </form>`);
  } catch (err) {
    if (isAddonError(err)) {
      if (wantsJson) return res.status(err.status).json({ error: err.code, message: err.message });
      return sendUploadPage(res, err.status, 'Upload failed', `<h1>Upload failed</h1><p>${escapeHtml(err.message)}</p>`);
    }
    return next(err);
  }
});

// ─── No session: a signed attachment link ───────────────────────────────────

router.get('/:id/attachments/:attachmentId', async (req, res, next) => {
  if (!req.query.sig) return next(); // the session-authenticated route below
  try {
    const variant = String(req.query.variant || 'view');
    const row = await attachments.getRowUnscoped(req.params.id, req.params.attachmentId);
    const ok = row && signing.verifyAttachmentSignature({
      addonId: req.params.id,
      attachmentId: req.params.attachmentId,
      variant,
      exp: req.query.exp,
      sig: String(req.query.sig),
      ownerKey: row.owner_key,
      personId: row.person_id,
    });
    if (!ok) return res.status(403).json({ error: 'addon_link_invalid', message: 'This link is invalid or has expired.' });
    const { buffer, mime } = await attachments.readRow(row, variant);
    return sendVariant(res, buffer, mime);
  } catch (err) { return sendError(res, err, next); }
});

// ─── Everything else needs a session or key ─────────────────────────────────

router.use(requireAuth);
router.use(requireAnyScope(['context:read', 'context:write', 'context:admin']));
const requireWrite = requireAnyScope(['context:write', 'context:admin']);

router.get('/', async (req, res, next) => {
  try {
    const ownerKey = workspace.defaultOwnerKey(req.actor);
    const enabled = await enablement.listEnabled(ownerKey);
    return res.json({ addons: registry.listAddons().map((addon) => catalogEntry(addon, enabled.has(addon.id))) });
  } catch (err) { return next(err); }
});

// The brief's add-on lines, for the local MCP server's start_session (the
// hosted one renders them in-process). [] when nothing is switched on.
router.get('/brief-lines', async (req, res, next) => {
  try {
    const lines = await require('../addons/lifecycle').briefLines(req.actor);
    return res.json({ lines });
  } catch (err) { return next(err); }
});

for (const [verb, on] of [['enable', true], ['disable', false]]) {
  router.post(`/:id/${verb}`, requireWrite, async (req, res, next) => {
    try {
      const addon = loadAddonOr404(req, res);
      if (!addon) return undefined;
      const ownerKey = workspace.defaultOwnerKey(req.actor);
      if (!(await mayManage(req.actor, ownerKey))) {
        return res.status(403).json({ error: 'addon_manage_forbidden', message: 'Only a workspace owner can switch add-ons on or off.' });
      }
      await enablement.setEnabled(ownerKey, addon.id, on, {
        version: addon.manifest.version,
        installedBy: workspace.actorPersonId(req.actor),
      });
      return res.json({ addon: catalogEntry(addon, on) });
    } catch (err) { return next(err); }
  });
}

router.post('/:id/actions/:action', async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const transport = req.get('x-deerdawn-transport') === 'mcp-local' ? 'mcp-local' : 'http';
    // `via: "read"` is what the local MCP server sends for read_addon: the
    // action must then be a read, whatever the credential could do.
    const via = body.via === 'read' ? 'read' : 'write';
    const result = await runAddonAction({
      actor: req.actor,
      addonId: req.params.id,
      action: req.params.action,
      // HTTP always returns `data`; include_data is an MCP switch, removed here
      // so it never trips an action's own argument schema.
      args: splitIncludeData(body.args).args,
      via,
      transport,
      req,
    });
    return res.json(result);
  } catch (err) { return sendError(res, err, next); }
});

router.post('/:id/attachments', requireWrite, async (req, res, next) => {
  try {
    const addon = loadAddonOr404(req, res);
    if (!addon) return undefined;
    const { ownerKey, personId } = scopeFor(req.actor);
    if (!(await enablement.isEnabled(ownerKey, addon.id))) {
      throw new AddonError(409, 'addon_disabled', `${addon.manifest.name} is not switched on for this workspace. Turn it on at /addons.`);
    }
    if (!(await mayWrite(req.actor, ownerKey))) {
      throw new AddonError(403, 'addon_read_only', 'You have read-only access to this workspace, so nothing was saved.');
    }
    const { maxUploadBytes } = attachments.limits();
    const parsed = await parseMultipart(req, { maxFileBytes: maxUploadBytes, maxFiles: 1 });
    const collection = String(parsed.fields.collection || '');
    attachmentsCollection(addon, collection);
    const file = oneFileFrom(parsed, maxUploadBytes);
    const attachment = await attachments.ingest(
      { ownerKey, addonId: addon.id, personId },
      { collection, recordId: parsed.fields.record_id ? String(parsed.fields.record_id) : null, buffer: file.buffer }
    );
    return res.status(201).json({ attachment });
  } catch (err) { return sendError(res, err, next); }
});

// The files on one record, or on no record yet, for the dashboard.
router.get('/:id/attachments', async (req, res, next) => {
  try {
    const addon = loadAddonOr404(req, res);
    if (!addon) return undefined;
    const { ownerKey, personId } = scopeFor(req.actor);
    const collection = String(req.query.collection || '');
    attachmentsCollection(addon, collection);
    // No record_id: the files on no record yet (upload links, bulk uploads).
    const recordId = req.query.record_id ? String(req.query.record_id) : null;
    const list = await attachments.listFor({ ownerKey, addonId: addon.id, personId }, collection, recordId);
    return res.json({ attachments: list });
  } catch (err) { return sendError(res, err, next); }
});

router.get('/:id/attachments/:attachmentId', async (req, res, next) => {
  try {
    const addon = loadAddonOr404(req, res);
    if (!addon) return undefined;
    const { ownerKey, personId } = scopeFor(req.actor);
    const row = await attachments.getRow({ ownerKey, addonId: addon.id, personId }, req.params.attachmentId);
    if (!row) throw new AddonError(404, 'addon_attachment_not_found', 'No such attachment.');
    const { buffer, mime } = await attachments.readRow(row, String(req.query.variant || 'view'));
    return sendVariant(res, buffer, mime);
  } catch (err) { return sendError(res, err, next); }
});

router.delete('/:id/attachments/:attachmentId', requireWrite, async (req, res, next) => {
  try {
    const addon = loadAddonOr404(req, res);
    if (!addon) return undefined;
    const { ownerKey, personId } = scopeFor(req.actor);
    if (!(await mayWrite(req.actor, ownerKey))) {
      throw new AddonError(403, 'addon_read_only', 'You have read-only access to this workspace, so nothing was changed.');
    }
    const removed = await attachments.remove({ ownerKey, addonId: addon.id, personId }, req.params.attachmentId);
    if (!removed) throw new AddonError(404, 'addon_attachment_not_found', 'No such attachment.');
    return res.json({ deleted: true });
  } catch (err) { return sendError(res, err, next); }
});

module.exports = router;
module.exports.parseMultipart = parseMultipart;
