'use strict';

// SHORT-LIVED LINKS THAT WORK WITHOUT A SESSION.
//
// Two kinds:
//   - a SIGNED ATTACHMENT URL: an HMAC over (add-on, attachment, variant,
//     expiry, workspace, person). The route re-reads the attachment row and
//     checks it still belongs to that workspace and person, so a link to a
//     deleted photo, or one that changed hands, stops working at once.
//   - an UPLOAD TOKEN: 32 random bytes handed to the person once; only its
//     sha256 is stored (addon_upload_tokens), bound to one person, one add-on,
//     one collection, with an expiry and a use cap.
//
// The HMAC key is derived from JWT_SECRET under a fixed label, so it is a
// different key from anything else signed with that secret.

const crypto = require('crypto');
const db = require('../config/db');
const { apiBaseUrl } = require('../config/selfHosted');
const { ensureAddonSchema } = require('./schema');

const MAX_URL_TTL = 24 * 3600;
const DEFAULT_URL_TTL = 15 * 60;
const MAX_UPLOAD_TTL = 3600;
const DEFAULT_UPLOAD_TTL = 15 * 60;
const UPLOAD_MAX_USES = 50;

function signingKey() {
  const secret = process.env.JWT_SECRET || '';
  if (!secret) throw new Error('JWT_SECRET is required to sign add-on links');
  return crypto.createHmac('sha256', secret).update('deerdawn-addon-links-v1').digest();
}

function sign(parts) {
  return crypto.createHmac('sha256', signingKey()).update(parts.join('\n')).digest('base64url');
}

function clampTtl(ttl, fallback, max) {
  const n = Math.floor(Number(ttl));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

/** The absolute base the API is reachable at, for links handed to agents. */
function publicApiBase(req) {
  const configured = apiBaseUrl();
  if (configured) return configured.replace(/\/+$/, '');
  if (req && typeof req.get === 'function') return `${req.protocol}://${req.get('host')}`;
  return '';
}

function attachmentSignature({ addonId, attachmentId, variant, exp, ownerKey, personId }) {
  return sign(['att', addonId, attachmentId, variant, String(exp), ownerKey, personId]);
}

function signedAttachmentUrl({ addonId, attachmentId, variant, ownerKey, personId, ttlSeconds, base = publicApiBase() }) {
  const exp = Math.floor(Date.now() / 1000) + clampTtl(ttlSeconds, DEFAULT_URL_TTL, MAX_URL_TTL);
  const sig = attachmentSignature({ addonId, attachmentId, variant, exp, ownerKey, personId });
  const qs = new URLSearchParams({ variant, exp: String(exp), sig });
  return `${base}/api/v1/addons/${encodeURIComponent(addonId)}/attachments/${encodeURIComponent(attachmentId)}?${qs}`;
}

/** True when sig is valid and unexpired for this exact row. Constant-time compare. */
function verifyAttachmentSignature({ addonId, attachmentId, variant, exp, sig, ownerKey, personId }) {
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Math.floor(Date.now() / 1000)) return false;
  if (typeof sig !== 'string' || !sig) return false;
  const expected = Buffer.from(attachmentSignature({ addonId, attachmentId, variant, exp: expNum, ownerKey, personId }));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

async function createUploadToken({ ownerKey, personId, addonId, collection, ttlSeconds, base = publicApiBase() }, { query = db.query } = {}) {
  await ensureAddonSchema();
  const ttl = clampTtl(ttlSeconds, DEFAULT_UPLOAD_TTL, MAX_UPLOAD_TTL);
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttl * 1000);
  await query(
    `INSERT INTO addon_upload_tokens (token_hash, owner_key, person_id, addon_id, collection, expires_at, max_uses)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [hashToken(token), ownerKey, personId, addonId, collection, expiresAt.toISOString(), UPLOAD_MAX_USES],
    'org-system'
  );
  return {
    token,
    url: `${base}/api/v1/addons/${encodeURIComponent(addonId)}/upload/${token}`,
    expires_at: expiresAt.toISOString(),
  };
}

/**
 * The token's binding, or null when it is unknown, expired, used up, or for a
 * different add-on. `consume` counts one use atomically.
 */
async function resolveUploadToken(addonId, token, { consume = false, query = db.query } = {}) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  await ensureAddonSchema();
  const sql = consume
    ? `UPDATE addon_upload_tokens SET uses = uses + 1
        WHERE token_hash = $1 AND addon_id = $2 AND expires_at > NOW() AND uses < max_uses
        RETURNING owner_key, person_id, addon_id, collection, expires_at`
    : `SELECT owner_key, person_id, addon_id, collection, expires_at FROM addon_upload_tokens
        WHERE token_hash = $1 AND addon_id = $2 AND expires_at > NOW() AND uses < max_uses`;
  const r = await query(sql, [hashToken(token), addonId], 'org-system');
  return r.rows[0] || null;
}

module.exports = {
  signedAttachmentUrl,
  verifyAttachmentSignature,
  createUploadToken,
  resolveUploadToken,
  hashToken,
  publicApiBase,
  DEFAULT_URL_TTL,
};
