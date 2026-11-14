/**
 * SIGNUP_MODE=invite_only: two sign-ups racing on an EMPTY install.
 *
 * Both read "nobody has an account yet" before either writes, so without a
 * serialised claim both became owners. The claim is now re-made inside a
 * transaction holding pg_advisory_xact_lock (createFirstAccount in
 * routes/shared/auth.js): exactly one becomes the owner and the other is
 * refused like any uninvited sign-up.
 *
 * The fake database below models what matters: committed rows are what a read
 * sees, a transaction's inserts land on COMMIT, and the advisory lock blocks a
 * second holder until the first transaction ends. A barrier makes both requests
 * pass the unlocked read before either reaches the lock: the interleaving the
 * race needs, every run.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.DISABLE_REDIS = 'true';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

const redisStore = new Map();
require.cache[require.resolve('../../src/config/redis')] = {
  exports: {
    redis: {
      get: async (k) => redisStore.get(k) || null,
      setex: async (k, _t, v) => { redisStore.set(k, v); return 'OK'; },
      set: async (k, v) => { redisStore.set(k, v); return 'OK'; },
      del: async (k) => { redisStore.delete(k); return 1; },
      incr: async () => 1,
      expire: async () => 1,
      on: () => {},
      status: 'ready',
    },
  },
};

// ── The fake database ────────────────────────────────────────────────────────
const committedUsers = [];
const locks = new Map(); // key -> promise chain tail
const lockRequests = [];
let unlockedReads = 0;
let releaseBarrier;
const barrier = new Promise((resolve) => { releaseBarrier = resolve; });

function acquire(key) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  locks.set(key, prev.then(() => held));
  return prev.then(() => release);
}

const mockDb = {
  // Every query outside a transaction.
  query: async (text, params) => {
    if (text.includes('SELECT 1 FROM users LIMIT 1')) {
      const seen = committedUsers.length ? [{ '?column?': 1 }] : [];
      unlockedReads += 1;
      if (unlockedReads >= 2) releaseBarrier();
      await barrier; // both requests have read "empty" before either goes on
      return { rows: seen };
    }
    if (text.includes('INSERT INTO users')) {
      committedUsers.push({ email: params[1] });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  },
  pool: {
    connect: async () => {
      let pending = [];
      let release = null;
      const end = () => { if (release) { release(); release = null; } pending = []; };
      return {
        query: async (text, params) => {
          if (text === 'BEGIN') return { rows: [] };
          if (text.includes('pg_advisory_xact_lock')) {
            lockRequests.push(params[0]);
            release = await acquire(params[0]);
            return { rows: [] };
          }
          if (text.includes('SELECT 1 FROM users LIMIT 1')) {
            return { rows: committedUsers.length ? [{ '?column?': 1 }] : [] };
          }
          if (text.includes('INSERT INTO users')) { pending.push({ email: params[1] }); return { rows: [], rowCount: 1 }; }
          if (text === 'COMMIT') { committedUsers.push(...pending); end(); return { rows: [] }; }
          if (text === 'ROLLBACK') { end(); return { rows: [] }; }
          return { rows: [], rowCount: 1 };
        },
        release: () => {},
      };
    },
  },
};
require.cache[require.resolve('../../src/config/db')] = { exports: mockDb };

function signupApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', require('../../src/routes/shared/auth'));
  return app;
}

test('two sign-ups on an empty invite-only install: exactly one becomes the owner', async () => {
  const saved = { SELF_HOSTED: process.env.SELF_HOSTED, SIGNUP_MODE: process.env.SIGNUP_MODE, AUTH_PROVIDER: process.env.AUTH_PROVIDER };
  process.env.SELF_HOSTED = 'true';
  delete process.env.SIGNUP_MODE;
  delete process.env.AUTH_PROVIDER;
  try {
    const app = signupApp();
    const [a, b] = await Promise.all([
      request(app).post('/api/v1/auth/signup').send({ email: 'first@example.com', password: 'password123' }),
      request(app).post('/api/v1/auth/signup').send({ email: 'second@example.com', password: 'password123' }),
    ]);
    assert.strictEqual(unlockedReads, 2, 'both requests passed the unlocked "no users yet" read');
    const statuses = [a.status, b.status].sort();
    assert.deepStrictEqual(statuses, [201, 403], `${a.status} ${JSON.stringify(a.body)} / ${b.status} ${JSON.stringify(b.body)}`);
    const loser = a.status === 403 ? a : b;
    assert.strictEqual(loser.body.error, 'signup_invite_required');
    assert.strictEqual(committedUsers.length, 1, 'one account exists afterwards');
    assert.deepStrictEqual(lockRequests, ['deerdawn:first-account', 'deerdawn:first-account']);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
