'use strict';

// INFRA-01: single source of truth for Postgres TLS config, shared by the runtime pool
// (config/db.js) AND every migration/ops script. TLS is decided by the PARSED hostname —
// never by a DATABASE_URL substring test or NODE_ENV — so a production URL can never fall
// through to a disabled or unverified TLS branch.
//
// Local/dev hosts (localhost, 127.0.0.1, plus anything in DB_DEV_HOSTNAMES) -> ssl: false.
// Everything else -> verify the server certificate (rejectUnauthorized: true), optionally
// pinned to DB_CA_CERT.

function localHostnames() {
    const dev = (process.env.DB_DEV_HOSTNAMES || '')
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean);
    return new Set(['localhost', '127.0.0.1', ...dev]);
}

/**
 * @param {string} [connectionString] defaults to process.env.DATABASE_URL
 * @returns {false | { rejectUnauthorized: true, ca?: string }}
 */
function getDbSslConfig(connectionString) {
    // Default to the same localhost dev URL the scripts/pool fall back to, so an unset
    // DATABASE_URL is correctly treated as local (TLS off) rather than verified-against-nothing.
    const url = connectionString || process.env.DATABASE_URL || 'postgres://localhost:5432/deerdawn_dev';
    let host = '';
    try {
        host = new URL(url).hostname;
    } catch {
        // Unparseable URL: fail safe to verified TLS rather than disabling it.
        host = '';
    }
    if (host && localHostnames().has(host)) {
        return false;
    }
    return {
        rejectUnauthorized: true,
        ...(process.env.DB_CA_CERT ? { ca: process.env.DB_CA_CERT } : {}),
    };
}

module.exports = { getDbSslConfig };
