'use strict';

// Resolving a Trail that arrives as a URL, server-side.
//
// ─── Why this is an allow-list and not a fetcher ─────────────────────────────
// Packs are distributed as links, and the hosted MCP connector is how most
// people reach DeerDawn at all — so "import this pack" has to work without the
// caller first downloading a file. But a server that fetches caller-supplied
// URLs is an SSRF primitive aimed at its own network: cloud metadata endpoints,
// internal services, anything reachable from the API's VPC that is not reachable
// from the internet.
//
// So the host is never caller-supplied in any meaningful sense. The URL's origin
// must match one we serve Trails from, exactly, and redirects are refused rather
// than followed — a 302 off an allowed origin is the obvious way around an
// origin check. What the caller actually controls is the path.
//
// The local stdio MCP package does its own fetching instead, in the runtime on
// the user's machine, where there is no internal network to reach and the origin
// can be anything. That asymmetry is deliberate: the constraint is about whose
// network is doing the fetching, not about who is asking.

const axios = require('axios');

const MAX_TRAIL_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;

function normalizeOrigin(value) {
  const match = /^(https?):\/\/([^/?#]+)/i.exec(String(value || '').trim());
  if (!match) return null;
  return `${match[1].toLowerCase()}://${match[2].toLowerCase()}`;
}

/**
 * Origins a Trail may be fetched from. TRAIL_FETCH_ORIGINS overrides; otherwise
 * the marketing site, which is where published Trails and packs are served.
 * @returns {string[]}
 */
function allowedOrigins() {
  const configured = String(process.env.TRAIL_FETCH_ORIGINS || '')
    .split(',')
    .map((entry) => normalizeOrigin(entry))
    .filter(Boolean);
  if (configured.length) return configured;
  return [
    normalizeOrigin(process.env.MARKETING_URL),
    'https://deerdawn.com',
    'https://www.deerdawn.com',
  ].filter(Boolean);
}

/**
 * Does this input look like a URL rather than .dawn contents or a path?
 * @param {*} value
 * @returns {boolean}
 */
function isTrailUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

/**
 * Fetch a .dawn from an allowed origin. Returns the raw bytes as text; the
 * caller still parses and verifies the checksum, which is what establishes the
 * content is what its author sealed. This function only bounds where the bytes
 * may come from and what they may cost.
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchTrailByUrl(url) {
  const origin = normalizeOrigin(url);
  const allowed = allowedOrigins();
  if (!origin || !allowed.includes(origin)) {
    const error = new Error('trail_fetch_origin_not_allowed');
    error.publicMessage = `trail_fetch_origin_not_allowed: a Trail URL must be served from ${allowed.join(' or ')}. Download the .dawn and pass its contents instead.`;
    throw error;
  }

  let response;
  try {
    response = await axios.get(url, {
      responseType: 'text',
      // Leave the bytes alone — parseTrail's own "not valid JSON, check it was
      // not truncated" is the more useful message than an axios parse failure.
      transformResponse: [(value) => value],
      timeout: FETCH_TIMEOUT_MS,
      maxContentLength: MAX_TRAIL_BYTES,
      maxBodyLength: MAX_TRAIL_BYTES,
      // A redirect is the obvious way around an origin allow-list, so it is
      // refused rather than followed.
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 300,
      headers: { Accept: 'application/json, text/plain' },
    });
  } catch (err) {
    const status = err?.response?.status;
    const error = new Error('trail_fetch_failed');
    error.publicMessage = status
      ? `trail_fetch_failed: ${url} returned HTTP ${status}${status >= 300 && status < 400 ? ' (redirects are not followed)' : ''}.`
      : `trail_fetch_failed: could not fetch ${url} (${err?.message || 'unknown error'}).`;
    throw error;
  }

  const body = typeof response.data === 'string' ? response.data : String(response.data ?? '');
  if (!body.trim()) {
    const error = new Error('trail_fetch_failed');
    error.publicMessage = `trail_fetch_failed: ${url} returned an empty body.`;
    throw error;
  }
  return body;
}

module.exports = {
  MAX_TRAIL_BYTES,
  isTrailUrl,
  allowedOrigins,
  fetchTrailByUrl,
};
