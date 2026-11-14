'use strict';

// S3-COMPATIBLE STORAGE (AWS S3, Cloudflare R2, Tigris, MinIO), with AWS
// Signature Version 4 written out here rather than pulling in the AWS SDK: the
// platform needs three verbs (PUT, GET, DELETE) on private objects, and the SDK
// is tens of megabytes in the API image for that.
//
// With ADDON_S3_ENDPOINT set, requests go path-style to that endpoint
// (https://endpoint/bucket/key), which every S3-compatible service accepts.
// Without it, virtual-hosted style on s3.<region>.amazonaws.com.
//
// Objects are never handed out by URL: the API serves them through its own
// signed attachment route, so the bucket stays private and the dashboard's CSP
// needs no bucket origin.

const crypto = require('crypto');

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// RFC 3986 encoding as SigV4 wants it; '/' kept in paths.
function encodeRfc3986(value, keepSlash = false) {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(keepSlash ? /%2F/g : /$^/, '/');
}

function amzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/**
 * Sign a request with SigV4 (header auth). Pure: exported for the test vector.
 * @returns {Object} headers to send, including Authorization.
 */
function signRequest({ method, host, path, query = {}, headers = {}, payloadHash, region, service = 's3', accessKeyId, secretAccessKey, date = new Date() }) {
  const stamp = amzDate(date);
  const day = stamp.slice(0, 8);
  const all = { ...headers, host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': stamp };
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const signedHeaders = Object.keys(lower).sort();
  const canonicalHeaders = signedHeaders.map((k) => `${k}:${lower[k]}\n`).join('');
  const canonicalQuery = Object.keys(query).sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(String(query[k]))}`).join('&');
  const canonicalRequest = [
    method,
    encodeRfc3986(path, true),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${secretAccessKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    ...all,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`,
  };
}

function createS3Storage({ endpoint, bucket, accessKeyId, secretAccessKey, region = 'auto', fetchImpl = globalThis.fetch, timeoutMs = 20000 }) {
  if (!bucket || !accessKeyId || !secretAccessKey) throw new Error('S3 storage needs a bucket and credentials');
  const custom = endpoint ? new URL(endpoint) : null;
  const awsRegion = region || 'us-east-1';

  function target(key) {
    if (custom) {
      const prefix = custom.pathname.replace(/\/+$/, '');
      return { origin: custom.origin, host: custom.host, path: `${prefix}/${bucket}/${key}` };
    }
    const host = `${bucket}.s3.${awsRegion}.amazonaws.com`;
    return { origin: `https://${host}`, host, path: `/${key}` };
  }

  async function send(method, key, body) {
    const { origin, host, path } = target(key);
    const payload = body || Buffer.alloc(0);
    const headers = signRequest({
      method,
      host,
      path,
      headers: body ? { 'content-type': 'application/octet-stream' } : {},
      payloadHash: sha256Hex(payload),
      region: awsRegion,
      accessKeyId,
      secretAccessKey,
    });
    delete headers.host; // fetch sets Host itself; it was signed above
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(`${origin}${encodeRfc3986(path, true)}`, {
        method,
        headers,
        body: body || undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    kind: 's3',
    async put(key, buffer) {
      const res = await send('PUT', key, buffer);
      if (!res.ok) throw new Error(`S3 PUT failed: ${res.status}`);
    },
    async get(key) {
      const res = await send('GET', key);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`S3 GET failed: ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    async delete(key) {
      const res = await send('DELETE', key);
      if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE failed: ${res.status}`);
      return true;
    },
  };
}

module.exports = { createS3Storage, signRequest, sha256Hex };
