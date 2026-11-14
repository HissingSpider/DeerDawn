const { Pool } = require('pg');
const CircuitBreaker = require('opossum');
const { getDbSslConfig } = require('./dbSsl');

// Strict validation pattern for org_id to prevent SQL injection
const ORG_ID_PATTERN = /^org-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let DB_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/deerdawn_dev';

const devHostnames = (process.env.DB_DEV_HOSTNAMES || '')
  .split(',')
  .map((hostname) => hostname.trim())
  .filter(Boolean);
const localHostnames = new Set(['localhost', '127.0.0.1', ...devHostnames]);
const dbHost = new URL(DB_URL).hostname;
const isLocal = localHostnames.has(dbHost);

if (!isLocal && !DB_URL.includes('sslmode')) {
  DB_URL += '?sslmode=require';
}

if (process.env.NODE_ENV === 'test') {
    const safeUrl = DB_URL.replace(/:[^:@]+@/, ':***@');
    console.log(`[DB] Connecting to: ${safeUrl} (isLocal: ${isLocal})`);
}

// Detect Neon database and prefer the pooled endpoint for the app server.
const isNeon = DB_URL.includes('neon.tech');
if (isNeon) {
  const url = new URL(DB_URL);
  if (!url.hostname.includes('-pooler.')) {
    url.hostname = url.hostname.replace(/^(ep-[^.]+)(\..+)$/, '$1-pooler$2');
    DB_URL = url.toString();
  }
}

const pool = new Pool({
  connectionString: DB_URL,
  // TLS must be on by default for production connections; disable only for localhost/dev hostnames via DB_DEV_HOSTNAMES.
  ssl: getDbSslConfig(DB_URL),

    // Neon DB & Fly.io multi-region tuning
    max: parseInt(process.env.DB_POOL_MAX || '10', 10),
    min: parseInt(process.env.DB_POOL_MIN || '0', 10),
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '30000', 10), // Close idle connections after 30s
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT || '30000', 10), // 30s for multi-region
    maxLifetimeMillis: parseInt(process.env.DB_MAX_LIFETIME || '600000', 10), // Force connection rotation after 10 min
    // false for the server (the listener keeps it alive anyway; this is belt and
    // braces). TRUE UNDER TEST: with it false, every idle pooled connection holds
    // the event loop open until idleTimeoutMillis (30s) closes it, so every
    // DB-backed test file sat ~30s after its last assertion before exiting. That
    // tail was most of a teams file's wall time, and a laptop sleeping through it
    // expired the runner's per-file --test-timeout on files whose every subtest
    // had passed ("passes, then never exits"). Only IDLE clients are released
    // from the loop: a client checked out and never returned still holds the
    // process open, so a real leak still shows up as a file that does not exit
    // (tests/integration/scan15-pool-release.test.js).
    allowExitOnIdle: process.env.DB_ALLOW_EXIT_ON_IDLE
        ? process.env.DB_ALLOW_EXIT_ON_IDLE === 'true'
        : process.env.NODE_ENV === 'test',
    statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT || '25000', 10), // 25s statement timeout
    keepAlive: process.env.DB_KEEP_ALIVE === 'true', // Off by default: TCP keep-alive on pooled conns keeps Neon compute from scaling to zero. Set DB_KEEP_ALIVE=true to re-enable.
});

// Add error handlers to pool
pool.on('error', (err, _client) => {
    console.error('[DB POOL] Unexpected error on idle client:', err.message);
});

// ...and on checked-out ones. pool.on('error') covers IDLE clients only: pg-pool
// takes its listener off a client when it is checked out and puts it back on
// release. A client held between queries (every db.pool.connect() transaction)
// whose connection drops then emits 'error' with nobody listening, which throws
// — Sentry DEERDAWN-API-6 (2026-09-26), a fatal uncaughtException whose graceful
// shutdown ended the pool under an in-flight request (DEERDAWN-API-5). Once per
// physical connection, so it never stacks. The broken client fails its next
// query where the holder can see it, and pg-pool discards it on release.
pool.on('connect', (client) => {
    client.on('error', (err) => {
        console.error('[DB POOL] Connection error on checked-out client:', err.message);
    });
});


const breakerOptions = {
    // DB_CIRCUIT_BREAKER_TIMEOUT lets tests/local override without activating the full test stub mode
    timeout: parseInt(process.env.DB_CIRCUIT_BREAKER_TIMEOUT || '8000', 10),
    errorThresholdPercentage: 50, // Open if 50% of queries fail
    resetTimeout: 10000 // Try again after 10s
};

const queryFunc = async ({ text, params, orgId }) => {
    let client;
    try {
        client = await pool.connect();

        if (orgId) {
            // STRICT VALIDATION before setting context to prevent SQL injection
            // Allow 'org-system' as a special case for system queries
            if (orgId !== 'org-system' && !ORG_ID_PATTERN.test(orgId)) {
                console.error('[DB] Invalid org_id format:', orgId);
                throw new Error(`Invalid org_id format: ${orgId}`);
            }

            // 'org-system' is a bypass marker for context-sync queries. All
            // context_* tables have RLS disabled (rowsecurity=f, no policies),
            // so set_config is a no-op for them — skip the extra round-trip.
            // Real org IDs still set the context for governance RLS enforcement.
            if (orgId !== 'org-system') {
                await client.query('SELECT set_config(\'app.current_org_id\', $1, true)', [orgId]);
            }
        }

        const result = await client.query(text, params);
        return result;
    } catch (err) {
        console.error('[DB] Query failed:', err.message);
        throw err;
    } finally {
        if (client) {
            client.release();
        }
    }
};

// Best-effort query path for non-critical enrichment reads (e.g. the context
// graph behind /active). Runs with a short, per-query statement_timeout so a
// pathological query self-cancels instead of running 8-13s, and lives behind a
// SEPARATE circuit breaker so its failures can NEVER open the main breaker and
// 503 the must-succeed path. Callers are expected to tolerate a thrown error.
const bestEffortQueryFunc = async ({ text, params, orgId, timeoutMs }) => {
    let client;
    const stmtTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.floor(timeoutMs)
        : parseInt(process.env.DB_BESTEFFORT_STATEMENT_TIMEOUT || '4000', 10);
    try {
        client = await pool.connect();
        if (orgId && orgId !== 'org-system') {
            if (!ORG_ID_PATTERN.test(orgId)) {
                console.error('[DB] Invalid org_id format:', orgId);
                throw new Error(`Invalid org_id format: ${orgId}`);
            }
        }
        // SET LOCAL only applies inside a transaction; wrap so the timeout is
        // scoped to this query and never leaks onto the pooled connection.
        await client.query('BEGIN');
        await client.query(`SET LOCAL statement_timeout = ${stmtTimeout}`);
        if (orgId && orgId !== 'org-system') {
            await client.query('SELECT set_config(\'app.current_org_id\', $1, true)', [orgId]);
        }
        const result = await client.query(text, params);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        if (client) { try { await client.query('ROLLBACK'); } catch { /* already broken */ } }
        console.error('[DB] Best-effort query failed:', err.message);
        throw err;
    } finally {
        if (client) client.release();
    }
};

const bestEffortBreaker = new CircuitBreaker(bestEffortQueryFunc, {
    timeout: parseInt(process.env.DB_BESTEFFORT_BREAKER_TIMEOUT || '5000', 10),
    errorThresholdPercentage: 50,
    resetTimeout: 10000,
});
bestEffortBreaker.on('open', () => console.warn('[DB BREAKER:besteffort] open'));
bestEffortBreaker.on('close', () => console.warn('[DB BREAKER:besteffort] closed'));

const breaker = new CircuitBreaker(queryFunc, breakerOptions);
breaker.on('open', () => {
    console.warn('[DB BREAKER] open');
});
breaker.on('halfOpen', () => {
    console.warn('[DB BREAKER] half-open');
});
breaker.on('close', () => {
    console.warn('[DB BREAKER] closed');
});
breaker.on('timeout', () => {
    console.warn('[DB BREAKER] timeout');
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function testConnection() {
    let retries = 5;
    while (retries) {
        try {
            const client = await pool.connect();
            await client.query('SELECT 1');
            client.release();
            console.log('[BOOT] Database connection verified.');
            return;
        } catch (_) { // Changed err to _
            console.error(`[BOOT] Database connection failed. Retrying... (${retries} left)`);
            retries -= 1;
            await sleep(2 ** (5 - retries) * 1000); // 2s, 4s, 8s, 16s, 32s
        }
    }

    console.error('[BOOT] CRITICAL: Could not connect to database after multiple retries. Exiting.');
    process.exit(1);
}

module.exports = {
    /**
     * Scoped Query for SOC 2 Isolation + Circuit Breaker
     */
    query: async (text, params, orgId = null) => {
        return breaker.fire({ text, params, orgId });
    },
    /**
     * Best-effort read for non-critical enrichment. Short statement timeout +
     * isolated breaker so it can never 503 the main path. Caller must handle throws.
     */
    queryBestEffort: async (text, params, orgId = null, timeoutMs = null) => {
        return bestEffortBreaker.fire({ text, params, orgId, timeoutMs });
    },
    pool,
    testConnection
};
