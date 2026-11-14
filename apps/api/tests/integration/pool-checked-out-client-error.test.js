/**
 * A CHECKED-OUT CLIENT WHOSE CONNECTION DROPS MUST NOT CRASH THE API.
 *
 * Sentry DEERDAWN-API-6 (2026-09-26 05:56, fatal): "Connection terminated
 * unexpectedly" reached process.on('uncaughtException') from pg's client, and
 * the graceful shutdown that follows ended the pool under an in-flight
 * POST /context/extraction — DEERDAWN-API-5, "Cannot use a pool after calling
 * end on the pool", 1.7s later.
 *
 * pool.on('error') only covers IDLE clients: pg-pool removes its listener from
 * a client when it is checked out (_acquireClient) and puts it back on release.
 * A client held across awaits between queries — every db.pool.connect()
 * transaction — that loses its connection while no query is running emits
 * 'error' with nobody listening, and an unhandled 'error' event throws.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/pool-checked-out-client-error.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../../src/config/db');

test('a checked-out client whose backend is killed between queries does not throw an uncaught error', async () => {
  const uncaught = [];
  const onUncaught = (err) => uncaught.push(err);
  // Registered for the test's duration so the regression is reported as a
  // failed assertion rather than as the test runner itself dying.
  process.prependListener('uncaughtException', onUncaught);
  const client = await db.pool.connect();
  let released = false;
  try {
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    // Held, no query in flight: the state a transaction is in between statements.
    await db.pool.query('SELECT pg_terminate_backend($1)', [pid]);
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.deepEqual(uncaught.map((e) => e.message), [], 'the dropped connection escaped as an uncaught exception');

    // The broken client fails its next query instead of crashing anything...
    await assert.rejects(client.query('SELECT 1'));
    client.release();
    released = true;
    // ...and the pool discards it and keeps serving.
    const ok = await db.pool.query('SELECT 1 AS one');
    assert.equal(ok.rows[0].one, 1);
  } finally {
    if (!released) client.release(true);
    process.removeListener('uncaughtException', onUncaught);
  }
});
