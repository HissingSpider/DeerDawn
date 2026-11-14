const IORedis = require('ioredis');
const env = require('./env');

const redisDisabled = process.env.DISABLE_REDIS === 'true' || process.env.NODE_ENV === 'test';

// Expiry in the stub is an absolute deadline checked lazily on every read, NOT a
// setTimeout. Node's timer ceiling is 2^31-1 ms (~24.8 days); a longer delay —
// the 365-day OAuth refresh TTL — is clamped to 1ms with a TimeoutOverflowWarning,
// so the refresh token vanished from the store before a test could present it and
// integration suites had to swap in their own Map. A deadline has no ceiling.
function createStubClient(status = 'disabled') {
    const store = new Map();
    const deadlines = new Map();
    const live = (key) => {
        const deadline = deadlines.get(key);
        if (deadline !== undefined && Date.now() >= deadline) {
            store.delete(key);
            deadlines.delete(key);
        }
        return store.has(key);
    };
    const put = (key, value, ttlSeconds) => {
        store.set(key, value);
        const seconds = Number(ttlSeconds);
        // Redis semantics: a plain SET clears any TTL the key had.
        if (Number.isFinite(seconds)) deadlines.set(key, Date.now() + seconds * 1000);
        else deadlines.delete(key);
    };
    return {
        status,
        on() {},
        quit() { return Promise.resolve(); },
        call() { return Promise.reject(new Error('Redis disabled')); },
        get(key) { return Promise.resolve(live(key) ? store.get(key) : null); },
        set(key, value, mode, ttlMode, ttlValue, ...rest) {
            // XX (only if the key exists) and KEEPTTL are honoured because a
            // caller relying on them for correctness must get Redis's answer here
            // too. NX is not: callers already depend on the stub's plain SET.
            const flags = [mode, ttlMode, ttlValue, ...rest].filter((v) => typeof v === 'string').map((v) => v.toUpperCase());
            if (flags.includes('XX') && !live(key)) return Promise.resolve(null);
            if (flags.includes('KEEPTTL')) {
                const deadline = live(key) ? deadlines.get(key) : undefined;
                store.set(key, value);
                if (deadline === undefined) deadlines.delete(key);
                return Promise.resolve('OK');
            }
            if (mode === 'EX' && ttlMode !== undefined) put(key, value, ttlMode);
            else if (ttlMode === 'EX' && ttlValue !== undefined) put(key, value, ttlValue);
            else put(key, value, undefined);
            return Promise.resolve('OK');
        },
        setex(key, ttlSeconds, value) {
            put(key, value, ttlSeconds);
            return Promise.resolve('OK');
        },
        del(...keys) {
            let deleted = 0;
            keys.flat().forEach((key) => {
                if (live(key) && store.delete(key)) deleted += 1;
                deadlines.delete(key);
            });
            return Promise.resolve(deleted);
        },
        keys(pattern = '*') {
            const all = [...store.keys()].filter((key) => live(key));
            if (pattern === '*') return Promise.resolve(all);
            const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
            return Promise.resolve(all.filter((key) => regex.test(key)));
        },
        // Set commands: the OAuth refresh-token index (see dataErasureService)
        // needs them, and an erasure that could not find a person's live tokens
        // in a DISABLE_REDIS/test environment would report success while leaving
        // the session alive — the exact failure the index exists to prevent.
        sadd(key, ...members) {
            const existing = store.get(key);
            const set = existing instanceof Set ? existing : new Set();
            members.flat().forEach((member) => set.add(String(member)));
            store.set(key, set);
            return Promise.resolve(set.size);
        },
        smembers(key) {
            const value = store.get(key);
            return Promise.resolve(value instanceof Set ? [...value] : []);
        },
        srem(key, ...members) {
            const value = store.get(key);
            if (!(value instanceof Set)) return Promise.resolve(0);
            let removed = 0;
            members.flat().forEach((member) => { if (value.delete(String(member))) removed += 1; });
            return Promise.resolve(removed);
        },
        expire() { return Promise.resolve(1); },
        ping() { return Promise.resolve('PONG'); },
        multi() {
            // Mirror ioredis's chainable transaction API against the in-memory store.
            // Each queued command is the stub's own method; exec() runs them in order
            // and returns [err, result] tuples like ioredis.
            const ops = [];
            const chain = {};
            for (const name of ['set', 'setex', 'del', 'get', 'keys']) {
                chain[name] = (...args) => { ops.push([name, args]); return chain; };
            }
            chain.exec = async () => {
                const results = [];
                for (const [name, args] of ops) {
                    try {
                        results.push([null, await this[name](...args)]);
                    } catch (err) {
                        results.push([err, null]);
                    }
                }
                return results;
            };
            return chain;
        },
        publish() { return Promise.resolve(0); },
        psubscribe() { return Promise.resolve(); },
        punsubscribe() { return Promise.resolve(); },
        subscribe(_channel, callback) {
            if (typeof callback === 'function') callback(null);
        }
    };
}

// Shared Redis client for general operations (caching, rate limiting, etc.)
const redis = redisDisabled ? createStubClient() : new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false
    // Auto-pipelining disabled - caused latency issues in production
    // enableAutoPipelining: true,
    // autoPipeliningIgnoredCommands: ['subscribe', 'psubscribe', 'unsubscribe']
});

// Dedicated connections for pub/sub (cannot share with command client)
let subscriber = null;
let publisher = null;

function getSubscriber() {
    if (redisDisabled) {
        if (!subscriber) subscriber = createStubClient();
        return subscriber;
    }
    if (!subscriber) {
        subscriber = new IORedis(env.REDIS_URL);
        subscriber.on('error', (err) => console.error('[REDIS] Subscriber error:', err.message));
    }
    return subscriber;
}

function getPublisher() {
    if (redisDisabled) {
        if (!publisher) publisher = createStubClient();
        return publisher;
    }
    if (!publisher) {
        publisher = new IORedis(env.REDIS_URL);
        publisher.on('error', (err) => console.error('[REDIS] Publisher error:', err.message));
    }
    return publisher;
}

if (!redisDisabled) {
    redis.on('error', (err) => console.error('[REDIS] Shared client error:', err.message));
    redis.on('connect', () => console.log('[REDIS] Shared client connected'));
}

async function closeRedisConnections() {
    const clients = [redis, subscriber, publisher].filter(Boolean);
    await Promise.all(clients.map(c => c.quit().catch(() => {})));
}

module.exports = {
    redis,
    getSubscriber,
    getPublisher,
    closeRedisConnections
};
