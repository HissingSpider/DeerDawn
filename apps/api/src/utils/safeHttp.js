'use strict';

// SSRF-02: a shared guard for server-side fetches of any URL influenced by user input.
// Enforces an http(s) scheme allowlist and rejects hosts that resolve to private, loopback,
// link-local (incl. the cloud metadata IP 169.254.169.254), unique-local, or reserved ranges —
// resolving the DNS name so a public name pointing at an internal IP (DNS rebinding) is caught.

const dns = require('dns').promises;
const ipaddr = require('ipaddr.js');
const axios = require('axios');

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// ipaddr.range() categories that are NOT safe to reach from the server.
const BLOCKED_RANGES = new Set([
    'unspecified', 'broadcast', 'loopback', 'linkLocal', 'carrierGradeNat',
    'private', 'reserved', 'uniqueLocal', 'ipv4Mapped', 'rfc6145', 'rfc6052',
    '6to4', 'teredo',
]);

function isBlockedIp(ip) {
    try {
        let addr = ipaddr.parse(ip);
        if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) {
            addr = addr.toIPv4Address();
        }
        return BLOCKED_RANGES.has(addr.range());
    } catch {
        // Unparseable address: treat as unsafe.
        return true;
    }
}

/**
 * Validate that a URL is safe to fetch server-side. Throws on violation.
 * @param {string} rawUrl
 * @returns {Promise<URL>}
 */
async function assertSafeUrl(rawUrl) {
    let url;
    try {
        url = new URL(String(rawUrl));
    } catch {
        throw new Error('ssrf_blocked: invalid URL');
    }
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
        throw new Error(`ssrf_blocked: protocol '${url.protocol}' not allowed`);
    }
    const host = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets

    // Literal IP host: check directly.
    if (ipaddr.isValid(host)) {
        if (isBlockedIp(host)) throw new Error('ssrf_blocked: target IP is in a private/reserved range');
        return url;
    }

    // DNS name: resolve and verify EVERY address (defeats rebinding to an internal IP).
    let addrs;
    try {
        addrs = await dns.lookup(host, { all: true });
    } catch {
        throw new Error('ssrf_blocked: host did not resolve');
    }
    if (!addrs.length) throw new Error('ssrf_blocked: host did not resolve');
    for (const { address } of addrs) {
        if (isBlockedIp(address)) throw new Error('ssrf_blocked: host resolves to a private/reserved IP');
    }
    return url;
}

/**
 * SSRF-safe axios request. Validates the URL, caps body size + time, and refuses redirects by
 * default (a redirect could point at an internal IP without re-validation).
 */
async function safeRequest(config = {}) {
    const url = config.url;
    await assertSafeUrl(url);
    return axios({
        maxRedirects: 0,
        timeout: 10000,
        maxContentLength: 10 * 1024 * 1024, // 10 MB
        maxBodyLength: 10 * 1024 * 1024,
        ...config,
    });
}

const safeGet = (url, opts = {}) => safeRequest({ ...opts, method: 'get', url });

module.exports = { assertSafeUrl, isBlockedIp, safeRequest, safeGet };
