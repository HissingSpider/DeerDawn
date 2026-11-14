'use strict';

// WHICH STORAGE ADAPTER, CHOSEN BY ENV.
//
//   ADDON_S3_BUCKET (+ ADDON_S3_ACCESS_KEY_ID, ADDON_S3_SECRET_ACCESS_KEY,
//   optional ADDON_S3_ENDPOINT, ADDON_S3_REGION)  -> S3-compatible
//   ADDON_STORAGE_DIR                              -> local disk
//   neither, self-hosted                           -> local disk at /data/addons
//   neither, development or test                   -> local disk under the OS temp dir
//   neither, hosted production                     -> NONE: uploads answer 503,
//                                                     everything else works
//
// An adapter is { kind, put(key, buffer), get(key) -> Buffer|null, delete(key) }.

const os = require('os');
const path = require('path');
const { isSelfHosted } = require('../../config/selfHosted');
const { createLocalDiskStorage } = require('./localDisk');
const { createS3Storage } = require('./s3');

const SELF_HOSTED_DEFAULT_DIR = '/data/addons';

const clean = (v) => (typeof v === 'string' ? v.trim() : '');

function resolveStorageConfig(env = process.env) {
  if (clean(env.ADDON_S3_BUCKET)) {
    return {
      kind: 's3',
      bucket: clean(env.ADDON_S3_BUCKET),
      endpoint: clean(env.ADDON_S3_ENDPOINT) || null,
      region: clean(env.ADDON_S3_REGION) || (clean(env.ADDON_S3_ENDPOINT) ? 'auto' : 'us-east-1'),
      accessKeyId: clean(env.ADDON_S3_ACCESS_KEY_ID),
      secretAccessKey: clean(env.ADDON_S3_SECRET_ACCESS_KEY),
    };
  }
  if (clean(env.ADDON_STORAGE_DIR)) return { kind: 'local', dir: clean(env.ADDON_STORAGE_DIR) };
  if (isSelfHosted(env)) return { kind: 'local', dir: SELF_HOSTED_DEFAULT_DIR };
  if (env.NODE_ENV !== 'production') return { kind: 'local', dir: path.join(os.tmpdir(), 'deerdawn-addons') };
  return { kind: 'none' };
}

let cached = null;
let override = null;

/** The configured adapter, or null when no storage is configured. */
function getStorage(env = process.env) {
  if (override) return override.none ? null : override;
  if (cached) return cached.adapter;
  const config = resolveStorageConfig(env);
  let adapter = null;
  if (config.kind === 's3') {
    try {
      adapter = createS3Storage(config);
    } catch (err) {
      console.warn(`[ADDONS] S3 storage misconfigured, uploads disabled: ${err.message}`);
    }
  } else if (config.kind === 'local') {
    adapter = createLocalDiskStorage(config.dir);
  }
  cached = { adapter };
  return adapter;
}

/** Tests: force an adapter (or null for "none"), or pass undefined to reset. */
function setStorageForTests(adapter) {
  override = adapter === undefined ? null : (adapter || { kind: 'none-test', none: true });
  cached = null;
}

function storageAvailable() {
  const s = getStorage();
  return Boolean(s && !s.none);
}

module.exports = { getStorage, storageAvailable, resolveStorageConfig, setStorageForTests, SELF_HOSTED_DEFAULT_DIR };
