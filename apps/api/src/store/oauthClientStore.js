'use strict';

// Where a connector's identity actually lives.
//
// 2026-09-05: reconnecting the Codex MCP returned
// `invalid_client: unknown client_id (re-register the connector)`. The
// registration had not expired — #267 already removed the TTL that would have
// expired it. It was simply gone, because Redis was the only place it had ever
// been written, and Redis is a cache. It restarts, it fails over, and under a
// maxmemory policy it evicts keys that carry no TTL as readily as ones that do.
// Removing the TTL made the key immortal in a store that never promised to keep
// anything.
//
// Two things went wrong, and they need separate fixes:
//
//   1. A DCR registration is a durable identity, not a cache entry. Clients do
//      NOT re-register on their own: Codex and Claude Code write the issued
//      client_id into local config and keep sending it forever, so
//      `invalid_client` is a dead end no retry escapes — the user has to delete
//      the connector and redo an install they already completed.
//      docs/SECURITY-AUDIT-2026-06.md:1043 assumed the opposite ("re-registration
//      is cheap ... clients re-register on demand") and proposed putting a 48h
//      TTL back on this exact key. Written down here so that assumption does not
//      get acted on a third time: Postgres is the record now, and the Redis key
//      in front of it is disposable by design.
//
//   2. A storage failure is not an unknown client. The old read swallowed its
//      error and fell into the same branch as a genuine miss, so a transient
//      Redis blip told a user their working connector was invalid and
//      instructed them to destroy it. Reads here throw
//      ClientStoreUnavailableError instead of answering "not found", so the
//      caller can say "retry" rather than "re-register".
//
// CIMD clients (chatgpt.com, claude.ai) are deliberately not stored: their
// record of truth is the metadata document they publish, which can always be
// refetched. Only self-registered DCR clients have nowhere else to exist.

const db = require('../config/db');
const { redis } = require('../config/redis');

// The cache may now expire freely — durability no longer depends on it, and a
// bounded TTL keeps unauthenticated registration from growing the Redis
// keyspace without limit (the real concern behind the audit's RL-07).
const CACHE_TTL_SECONDS = 3600;

// Thrown when we could not determine whether a client exists. Never thrown to
// mean "it does not exist".
class ClientStoreUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ClientStoreUnavailableError';
  }
}

function cacheKey(clientId) {
  return `oauth:client:${clientId}`;
}

function toClient(row) {
  return {
    client_id: row.client_id,
    redirect_uris: Array.isArray(row.redirect_uris) ? row.redirect_uris : [],
    client_name: row.client_name || 'MCP Client',
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    registration_type: row.registration_type || 'dcr',
    created_at: row.created_at ? new Date(row.created_at).getTime() : undefined,
  };
}

// A cache read failing is not an answer, so it never produces one: fall through
// to Postgres and let that decide.
async function readCache(clientId) {
  try {
    const raw = await redis.get(cacheKey(clientId));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeCache(client) {
  try {
    await redis.set(cacheKey(client.client_id), JSON.stringify(client), 'EX', CACHE_TTL_SECONDS);
  } catch (err) {
    // Best effort by construction. The record is already in Postgres; a cache
    // that refuses a write costs a query, not a connector.
    console.warn('[OAUTH] Client cache write failed:', err.message);
  }
}

async function persist(client) {
  await db.query(
    `INSERT INTO oauth_clients (client_id, redirect_uris, client_name, registration_type, created_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (client_id) DO NOTHING`,
    [
      client.client_id,
      client.redirect_uris,
      client.client_name || 'MCP Client',
      client.registration_type || 'dcr',
    ]
  );
}

/**
 * Record a newly registered DCR client. Throws if it could not be made durable —
 * issuing a client_id we cannot remember is the failure this module exists to
 * prevent, so registration fails loudly instead.
 */
async function saveClient(client) {
  await persist(client);
  await writeCache({ ...client, _persisted: true });
}

/**
 * Registrations issued before this store existed live only in Redis. Heal them
 * into Postgres the first time they are used, so a connector that works today
 * keeps working after the next Redis restart without its owner doing anything.
 * One write per client, and never at the cost of the request in flight.
 */
async function backfillFromCache(cached) {
  try {
    await persist(cached);
    await writeCache({ ...cached, _persisted: true });
  } catch (err) {
    console.warn('[OAUTH] Client backfill failed:', err.message);
  }
}

/**
 * @returns the client, or null if it genuinely does not exist.
 * @throws ClientStoreUnavailableError if that question could not be answered.
 */
async function loadClient(clientId) {
  const cached = await readCache(clientId);
  if (cached) {
    if (!cached._persisted) await backfillFromCache(cached);
    const { _persisted, ...client } = cached;
    return client;
  }

  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT client_id, redirect_uris, client_name, registration_type, created_at
       FROM oauth_clients WHERE client_id = $1`,
      [clientId]
    ));
  } catch (err) {
    throw new ClientStoreUnavailableError(err.message);
  }

  if (!rows || rows.length === 0) return null;
  const client = toClient(rows[0]);
  await writeCache({ ...client, _persisted: true });
  return client;
}

/**
 * Last-used stamp, for telling an abandoned registration from a live one if we
 * ever need to prune. Recording only — nothing deletes on it, because a rule
 * that expires in-use connectors is exactly the bug above.
 */
async function touchClient(clientId) {
  try {
    await db.query('UPDATE oauth_clients SET last_used_at = NOW() WHERE client_id = $1', [clientId]);
  } catch {
    // Observability, never a reason to fail a connect.
  }
}

module.exports = {
  ClientStoreUnavailableError,
  saveClient,
  loadClient,
  touchClient,
  CACHE_TTL_SECONDS,
};
