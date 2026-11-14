const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { redis: redisClient } = require('../config/redis');
const workspace = require('../services/workspaceService');
const {
    EXTENDED_DEVICE_CODE_TTL,
    DEVICE_POLL_INTERVAL_SECONDS,
    DEVICE_CODE_PATTERN,
} = require('../config/deviceFlow');

const enableRedisRateLimit = process.env.ENABLE_REDIS_RATE_LIMIT !== 'false';
const fallbackMode = (process.env.RATE_LIMIT_FALLBACK || 'memory').toLowerCase();
const disableFallback = ['none', 'off', 'disabled'].includes(fallbackMode);
let hasWarnedRateLimitFallback = false;

const shouldSkipLimiter = (_req) => {
    // Only allow rate limit bypass in non-production environments via explicit env var
    // SECURITY: Hard-coded bypass keys removed - use SKIP_RATE_LIMIT=true in dev only
    return process.env.NODE_ENV !== 'production' && process.env.SKIP_RATE_LIMIT === 'true';
};

// RL-02: behind Cloudflare, the trustworthy client IP is CF-Connecting-IP — Cloudflare sets it to
// the real client and overwrites any client-supplied value, so it cannot be spoofed the way a
// client-appended X-Forwarded-For (which feeds req.ip via trust-proxy) can. We prefer it when
// present. NOTE: pair this with locking the Fly origin to Cloudflare-only (Authenticated Origin
// Pull / origin secret) so a direct *.fly.dev hit cannot inject a forged CF header — see
// docs/SECURITY-REMEDIATION-PLAN.md (ratelimit PR1). TRUST_CF_CONNECTING_IP=false disables it.
//
// Self-hosted installs default it OFF: most are not behind Cloudflare, and with no
// Cloudflare in front the header is whatever the client sends, which would let
// anyone pick their own rate-limit bucket. TRUST_CF_CONNECTING_IP=true turns it on.
const trustCfIp = require('../config/selfHosted').isSelfHosted()
    ? process.env.TRUST_CF_CONNECTING_IP === 'true'
    : process.env.TRUST_CF_CONNECTING_IP !== 'false';

// Validate IP format to prevent spoofing
const IPV4_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_PATTERN = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;

/** Is this string shaped like an address at all? Exported so other keyers can
 *  validate a forwarded value against the same rule this module applies. */
const isIpAddress = (value) => typeof value === 'string' && (IPV4_PATTERN.test(value) || IPV6_PATTERN.test(value));

const getClientIp = (req) => {
    const ipv4Pattern = IPV4_PATTERN;
    const ipv6Pattern = IPV6_PATTERN;

    let ip;
    const cfIp = trustCfIp ? req.headers['cf-connecting-ip'] : undefined;
    if (typeof cfIp === 'string' && (ipv4Pattern.test(cfIp) || ipv6Pattern.test(cfIp))) {
        ip = cfIp;
    } else {
        ip = req.ip || req.socket.remoteAddress;
    }

    if (!ipv4Pattern.test(ip) && !ipv6Pattern.test(ip)) {
        console.warn('[RATE LIMIT] Invalid IP format detected');
        // Use the raw value with a prefix to prevent bucket sharing
        // This ensures each invalid IP gets its own rate limit bucket
        return `invalid:${ip}`;
    }

    return ip;
};

const warnRateLimitFallback = (reason) => {
    if (hasWarnedRateLimitFallback) {
        return;
    }
    hasWarnedRateLimitFallback = true;
    const modeLabel = disableFallback ? 'disabled' : 'memory';
    console.warn(`[RATE LIMIT] Redis store unavailable (${reason}). Falling back to ${modeLabel} limiter.`);
};

// How long one Redis round-trip may take before the request stops waiting for it
// and is counted in memory instead. A limiter is on the path of every request;
// it does not get to be the reason one hangs.
const REDIS_COMMAND_TIMEOUT_MS = Math.max(50, Number(process.env.RATE_LIMIT_REDIS_TIMEOUT_MS) || 500);

/**
 * THE STORE IS CHOSEN PER REQUEST, NOT AT MODULE LOAD.
 *
 * This used to be `redisClient.status === 'ready' ? new RedisStore(...) : new
 * MemoryStore()`, evaluated once, while this file was being required. ioredis
 * connects asynchronously, so at that moment the status is always `connecting`:
 * every limiter in the service took the memory branch, on every boot, and kept
 * it for the life of the process. The warning it printed said "Redis store
 * unavailable (redis status=connecting)", which reads like a Redis blip rather
 * than like the permanent state of the system.
 *
 * What that cost: in-memory counters are per machine. With N machines behind
 * the load balancer every limit was really N times its configured value (the
 * signup cap that exists to stop one IP minting free-tier accounts, the MCP
 * tool budget), and a deploy or restart reset every bucket to zero.
 *
 * So the decision moves to where the information exists. This store always
 * owns a MemoryStore, and reaches for Redis on each operation IF Redis is ready
 * right then. The RedisStore itself is built on first use, not here: its
 * constructor fires SCRIPT LOAD immediately and keeps the promises, and a
 * rejected promise nobody awaits is an unhandledRejection, which on current
 * Node ends the process.
 *
 * A LIMITER MUST NEVER THROW OR HANG A REQUEST BECAUSE REDIS IS DOWN.
 * express-rate-limit turns a store error into next(err), a 500 on every route
 * the limiter guards, so a Redis outage would become an API outage. Every Redis
 * operation here is raced against a timeout and any failure falls through to
 * the memory store for that one operation: fail OPEN to a weaker limit, never
 * closed to no service. It logs once per transition, not once per request.
 *
 * Who the old behaviour served, and still gets it: local dev and tests with
 * DISABLE_REDIS=true (the stub client's status is `disabled`, never `ready`, so
 * this is a plain MemoryStore with one warning), ENABLE_REDIS_RATE_LIMIT=false,
 * and a single machine with Redis unreachable.
 */
class FailoverRateLimitStore {
    constructor(prefix) {
        this.prefix = prefix;
        // Counts live in Redis whenever it is reachable, so express-rate-limit
        // must not assume a key seen here is only ever seen here.
        this.localKeys = false;
        this.memory = new rateLimit.MemoryStore();
        this.redisStore = null;
        this.windowMs = undefined;
        this.degraded = false;
    }

    init(options) {
        this.windowMs = options.windowMs;
        this.memory.init(options);
        if (this.redisStore) this.redisStore.init(options);
    }

    _redis() {
        if (!enableRedisRateLimit) {
            warnRateLimitFallback('ENABLE_REDIS_RATE_LIMIT=false');
            return null;
        }
        if (redisClient?.status !== 'ready') {
            this._noteDegraded(`redis status=${redisClient?.status || 'unknown'}`);
            return null;
        }
        if (!this.redisStore) {
            const store = new RedisStore({
                sendCommand: (...args) => redisClient.call(...args),
                prefix: this.prefix,
            });
            // See the class comment: these are created eagerly by the
            // constructor and must not be able to take the process down. A
            // failed load is retried by RedisStore itself on the next command.
            Promise.resolve(store.incrementScriptSha).catch(() => {});
            Promise.resolve(store.getScriptSha).catch(() => {});
            if (this.windowMs !== undefined) store.init({ windowMs: this.windowMs });
            this.redisStore = store;
        }
        return this.redisStore;
    }

    _noteDegraded(reason) {
        if (!this.degraded) {
            this.degraded = true;
            warnRateLimitFallback(reason);
        }
    }

    async _run(method, key) {
        const store = this._redis();
        if (store) {
            let timer;
            try {
                const result = await Promise.race([
                    store[method](key),
                    new Promise((_, reject) => {
                        timer = setTimeout(
                            () => reject(new Error(`redis ${method} timed out after ${REDIS_COMMAND_TIMEOUT_MS}ms`)),
                            REDIS_COMMAND_TIMEOUT_MS
                        );
                        timer.unref?.();
                    }),
                ]);
                if (this.degraded) {
                    this.degraded = false;
                    hasWarnedRateLimitFallback = false;
                    console.warn(`[RATE LIMIT] Redis store recovered for ${this.prefix}; counting in Redis again.`);
                }
                return result;
            } catch (err) {
                this._noteDegraded(err.message);
            } finally {
                clearTimeout(timer);
            }
        }
        return this.memory[method](key);
    }

    increment(key) { return this._run('increment', key); }
    decrement(key) { return this._run('decrement', key); }
    resetKey(key) { return this._run('resetKey', key); }
    get(key) { return this._run('get', key); }

    async resetAll() {
        // RedisStore has no resetAll (it would mean scanning a shared keyspace);
        // the memory side is the only one that can honour it.
        return this.memory.resetAll();
    }

    shutdown() {
        this.memory.shutdown?.();
    }
}

const resolveRateLimitStore = (prefix) => {
    if (disableFallback) {
        // RATE_LIMIT_FALLBACK=none|off|disabled. Every limiter in this service
        // also carries `skip: ... || disableFallback`, so in this mode the
        // limiter never consults a store at all. Unchanged, deliberately: what
        // that setting SHOULD mean is a product decision, not a store bug.
        warnRateLimitFallback(`RATE_LIMIT_FALLBACK=${fallbackMode}`);
        return undefined;
    }
    return new FailoverRateLimitStore(prefix);
};

const logAuthLimitExceeded = (req, limiterName) => {
    const email = req.body?.email ? String(req.body.email).toLowerCase() : 'unknown';
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const requestId = req._req_id || 'unknown';
    console.warn(`[AUTH RATE LIMIT] ${limiterName} exceeded | ip=${ip} | email=${email} | request_id=${requestId}`);
};

const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 120,            // 120 requests per minute
    standardHeaders: true,
    legacyHeaders: false,
    store: resolveRateLimitStore('rl:api:'),
    skip: (req) => shouldSkipLimiter(req) || disableFallback
});

const authLoginLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, // 10 minutes
    max: 20,                  // 20 failed logins per window
    standardHeaders: true,
    legacyHeaders: false,
    store: resolveRateLimitStore('rl:login:'),
    skip: (req) => shouldSkipLimiter(req) || disableFallback,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => {
        const ip = getClientIp(req);
        const email = req.body?.email ? String(req.body.email).toLowerCase() : '';
        return email ? `${ip}:${email}` : ip;
    },
    handler: (req, res, _next, options) => {
        logAuthLimitExceeded(req, 'login');
        res.status(options.statusCode).json({ error: 'too_many_requests', message: options.message });
    }
});

const authSignupLimiter = rateLimit({
    windowMs: 30 * 60 * 1000, // 30 minutes
    max: 10,                  // 10 failed signups per window
    standardHeaders: true,
    legacyHeaders: false,
    store: resolveRateLimitStore('rl:signup:'),
    skip: (req) => shouldSkipLimiter(req) || disableFallback,
    // Count ALL signups (not just failures) and key by IP only: with
    // skipSuccessfulRequests + an attacker-controlled email in the key, one IP
    // could mint unlimited accounts (each a fresh free-tier OpenAI budget).
    skipSuccessfulRequests: false,
    keyGenerator: (req) => getClientIp(req),
    handler: (req, res, _next, options) => {
        logAuthLimitExceeded(req, 'signup');
        res.status(options.statusCode).json({ error: 'too_many_requests', message: options.message });
    }
});

const mcpAuthLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    store: resolveRateLimitStore('rl:mcp-auth:'),
    skip: (req) => shouldSkipLimiter(req) || disableFallback,
    keyGenerator: (req) => getClientIp(req),
    handler: (req, res, _next, options) => {
        console.warn(`[MCP AUTH RATE LIMIT] exceeded | ip=${getClientIp(req)} | path=${req.path}`);
        res.status(options.statusCode).json({ error: 'too_many_requests', message: options.message });
    }
});

// ── The device-code poll ─────────────────────────────────────────────────────
//
// GET /api/v1/auth/mcp/token is the one endpoint under /api/v1/auth/mcp that a
// single, entirely legitimate client is SUPPOSED to hit hundreds of times:
// /start hands it a device code and tells it, in the response, to poll every
// `interval` seconds until the human finishes signing in in a browser. It sat
// in mcpAuthLimiter's bucket with /start and /authorize, so /start plus 29
// polls spent the whole 30-request window in about 58 seconds. Every later poll
// was a 429 that itself counted, so the bucket never reopened, and the key
// minted when the user did finally sign in was not collected until the ten
// minutes were up. Sign-in did not fail — it hung, silently, for anyone who
// spent more than a minute in the browser. That is everyone creating an account
// mid-flow, and nobody dogfooding with a session already open.
//
// So the poll gets its own budget, sized from the numbers the route itself
// advertises rather than from a guess.
const DEVICE_POLLS_PER_WINDOW = Math.ceil(EXTENDED_DEVICE_CODE_TTL / DEVICE_POLL_INTERVAL_SECONDS);
// Twice the theoretical maximum. A fixed limiter window does not line up with
// the flow's own window, so a flow that starts halfway through one spans two of
// them; and a client that polls a little fast, or retries a poll that failed,
// must not be cut off in the middle of a sign-in.
const DEVICE_POLL_BUDGET = DEVICE_POLLS_PER_WINDOW * 2;

// One bucket per (address, device code) pair. Keying on the code alone would
// hand anybody a fresh bucket for the asking; keying on the address alone is
// the bug above once, as happens, several people behind one NAT each run their
// own flow. A code we never issued gets no bucket of its own at all — it falls
// back to the plain address bucket, so a flood of invented codes stays bounded
// by the ceiling below rather than drawing an unlimited number of budgets.
const devicePollKey = (req) => {
    const ip = getClientIp(req);
    const code = req.query?.device_code;
    if (typeof code === 'string' && DEVICE_CODE_PATTERN.test(code)) return `code:${ip}:${code}`;
    return `ip:${ip}`;
};

const devicePollRefusal = (req, res, _next, options) => {
    console.warn(`[MCP DEVICE POLL RATE LIMIT] exceeded | ip=${getClientIp(req)}`);
    res.status(options.statusCode).json({ error: 'too_many_requests', message: options.message });
};

// The ceiling the per-code bucket cannot provide: a caller inventing a new code
// per request is a new bucket per request, so the flood has to be bounded by
// address as well. Set well above what a shared address of real users spends —
// a genuine flow stops polling the moment the browser step lands, usually
// inside a minute, so the full-window budget is already a generous estimate of
// one flow, and this allows several at once.
const mcpDevicePollIpLimiter = rateLimit({
    windowMs: EXTENDED_DEVICE_CODE_TTL * 1000,
    max: Math.max(1, Number(process.env.MCP_DEVICE_POLL_IP_LIMIT) || DEVICE_POLL_BUDGET * 8),
    standardHeaders: true,
    legacyHeaders: false,
    store: resolveRateLimitStore('rl:mcp-device-poll-ip:'),
    skip: (req) => shouldSkipLimiter(req) || disableFallback,
    keyGenerator: (req) => `ip:${getClientIp(req)}`,
    handler: devicePollRefusal,
});

const mcpDevicePollCodeLimiter = rateLimit({
    windowMs: EXTENDED_DEVICE_CODE_TTL * 1000,
    max: DEVICE_POLL_BUDGET,
    standardHeaders: true,
    legacyHeaders: false,
    store: resolveRateLimitStore('rl:mcp-device-poll:'),
    skip: (req) => shouldSkipLimiter(req) || disableFallback,
    keyGenerator: devicePollKey,
    handler: devicePollRefusal,
});

// Mounted as one middleware so app.js keeps a single name per endpoint.
const mcpDevicePollLimiter = (req, res, next) => mcpDevicePollIpLimiter(
    req,
    res,
    (err) => (err ? next(err) : mcpDevicePollCodeLimiter(req, res, next))
);

// ── OAuth endpoints many unrelated people reach from ONE address ─────────────
//
// mcpAuthLimiter is keyed on client IP, which is the right key for a browser
// arriving at /api/v1/oauth/authorize and the wrong one for everything else it
// guarded:
//
//   - /api/v1/oauth/approve arrives through a Vercel server-side passthrough
//     (apps/dashboard/src/pages/api/oauth-approve.ts) that forwards no client
//     IP, and /api/v1/auth/mcp/authorize through its sibling. So EVERY person
//     using the dashboard shares one bucket, and thirty consents in ten
//     minutes locks all of them out of a sign-in none of them can retry.
//   - /api/v1/oauth/token and /revoke are called by Claude.ai's and ChatGPT's
//     BACKENDS. One provider egress carries every one of their users, so a
//     token refresh storm anywhere refuses refreshes everywhere. This is the
//     same hazard the comment above the consent route describes, and the same
//     one mcpToolKey already solved for the MCP endpoint.
//
// The key has to be the thing being protected. Consent is protected per
// PERSON: those two routes are authenticated, so the limiter runs behind auth
// and counts the actor. A token exchange is protected per GRANT: the
// authorization code or refresh token being presented, hashed, one bucket
// each, so one connector's retry loop cannot spend another's budget.
//
// Neither key bounds an UNAUTHENTICATED flood — an invented grant draws a
// fresh bucket, and an unauthenticated request never binds an actor at all —
// so a generous IP floor runs in front of both. It is sized for a provider
// egress in normal use, not for one person.
const oauthSharedEgressLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: Math.max(1, Number(process.env.OAUTH_SHARED_EGRESS_LIMIT) || 600),
    standardHeaders: true,
    legacyHeaders: false,
    store: resolveRateLimitStore('rl:oauth-egress:'),
    skip: (req) => shouldSkipLimiter(req) || disableFallback,
    keyGenerator: (req) => `ip:${getClientIp(req)}`,
    handler: (req, res, _next, options) => {
        console.warn(`[OAUTH EGRESS RATE LIMIT] exceeded | ip=${getClientIp(req)} | path=${req.path}`);
        res.status(options.statusCode).json({ error: 'too_many_requests', message: options.message });
    },
});

// Mounted AFTER requireAuth, so req.actor is bound. Falls back to the address
// only if it somehow is not: a key that silently became a constant would put
// everybody back in one bucket.
const oauthActorLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: Math.max(1, Number(process.env.OAUTH_ACTOR_LIMIT) || 30),
    standardHeaders: true,
    legacyHeaders: false,
    store: resolveRateLimitStore('rl:oauth-actor:'),
    skip: (req) => shouldSkipLimiter(req) || disableFallback,
    keyGenerator: (req) => {
        const person = workspace.actorPersonId(req.actor) || workspace.defaultOwnerKey(req.actor);
        return person ? `actor:${person}` : `ip:${getClientIp(req)}`;
    },
    handler: (req, res, _next, options) => {
        console.warn(`[OAUTH CONSENT RATE LIMIT] exceeded | path=${req.path}`);
        res.status(options.statusCode).json({ error: 'too_many_requests', message: options.message });
    },
});

// The grant a token request presents. NOT the client_id: a CIMD client_id is
// one URL shared by every user of that product, so keying on it would rebuild
// the shared bucket this exists to break up. Hashed, because the key is
// written to Redis and the value is a live credential. A few attempts per
// grant is generous — an authorization code is one-time and a refresh token is
// rotated on use — and a grant we cannot identify falls back to the address.
const oauthGrantKey = (req) => {
    const grant = req.body?.code || req.body?.refresh_token || req.body?.token;
    if (typeof grant === 'string' && grant) {
        return `grant:${crypto.createHash('sha256').update(grant).digest('hex')}`;
    }
    return `ip:${getClientIp(req)}`;
};

const oauthGrantLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: Math.max(1, Number(process.env.OAUTH_GRANT_LIMIT) || 20),
    standardHeaders: true,
    legacyHeaders: false,
    store: resolveRateLimitStore('rl:oauth-grant:'),
    skip: (req) => shouldSkipLimiter(req) || disableFallback,
    keyGenerator: oauthGrantKey,
    handler: (req, res, _next, options) => {
        console.warn(`[OAUTH GRANT RATE LIMIT] exceeded | path=${req.path}`);
        res.status(options.statusCode).json({ error: 'too_many_requests', message: options.message });
    },
});

// Registration stays keyed on the address: a client registering itself has no
// credential and no grant yet, so there is nothing else to key on. The budget
// moves off the shared 30 because a provider egress registering connectors for
// its own users would reach that in normal use, and a connector that cannot
// register cannot be installed at all.
const oauthRegisterLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: Math.max(1, Number(process.env.OAUTH_REGISTER_LIMIT) || 120),
    standardHeaders: true,
    legacyHeaders: false,
    store: resolveRateLimitStore('rl:oauth-register:'),
    skip: (req) => shouldSkipLimiter(req) || disableFallback,
    keyGenerator: (req) => `ip:${getClientIp(req)}`,
    handler: (req, res, _next, options) => {
        console.warn(`[OAUTH REGISTER RATE LIMIT] exceeded | ip=${getClientIp(req)}`);
        res.status(options.statusCode).json({ error: 'too_many_requests', message: options.message });
    },
});

// The credential a request presents, if any: a bearer token or an API key.
// Cookies are excluded — a Cookie header carries unrelated values that change
// between requests, so hashing it would not identify one caller.
const presentedCredential = (req) => {
    const authorization = req.headers?.authorization;
    if (typeof authorization === 'string') {
        const match = authorization.match(/^Bearer\s+(\S+)/i);
        if (match) return match[1];
    }
    const apiKey = req.headers?.['x-api-key'];
    if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim();
    return null;
};

// MCP tool traffic is distinct from the OAuth endpoints above. The limiter is
// mounted BEFORE auth (so a flood is refused before it costs a token lookup),
// which means req.actor is normally unset here. Keying that case on client IP
// put every user of one host — all Claude.ai users, all ChatGPT users, calling
// from that host's egress — into a single shared bucket. So: the authenticated
// tenant when there is one, else a SHA-256 of the presented credential (never
// the raw token: the key is written to Redis), else the validated client IP.
const mcpToolKey = (req) => {
    const actorKey = workspace.defaultOwnerKey(req.actor);
    if (actorKey) return `actor:${actorKey}`;
    const credential = presentedCredential(req);
    if (credential) {
        return `cred:${crypto.createHash('sha256').update(credential).digest('hex')}`;
    }
    return getClientIp(req);
};

const mcpRateLimitHandler = (label, { marksAnonymousRefusal = false } = {}) => (req, res, _next, options) => {
    // Its own refusal is the one 429 the anonymous bucket must still count — see
    // mcpAnonymousAttempt. Without the mark, a tripped bucket would decrement
    // itself on every refusal and reopen under a sustained flood.
    if (marksAnonymousRefusal) req._mcpAnonRefused = true;
    console.warn(`[${label}] exceeded | path=${req.path} | request_id=${req._req_id || 'unknown'}`);
    res.status(options.statusCode).json({
        jsonrpc: '2.0',
        id: req.body?.id ?? null,
        error: { code: -32029, message: 'Too many MCP requests. Wait briefly and retry.' },
    });
};

// WHAT COUNTS AS ANONYMOUS — asked of the OUTCOME, and only of an outcome that
// is actually about the credential.
//
// Reading it off `req.actor` alone was wrong in the one direction that matters:
// this limiter is mounted in FRONT of the per-credential limiter and of auth, so
// a request refused by either of them never binds an actor either. One heavy
// credential's own 429s, or a few seconds of an unavailable credential lookup,
// therefore filed as anonymous attempts against a shared provider egress — and
// locked out every other Claude.ai and ChatGPT user behind it for the window.
// That is the exact bug an IP bucket exists to avoid, reintroduced through the
// back door.
//
//   - identified    -> never anonymous, however many share the address.
//   - downstream 429/503 -> nobody downstream was willing to answer; the request
//     was never judged against a credential, so it says nothing about one. The
//     flood it might hide is already bounded: a 429 there means the credential's
//     OWN bucket closed.
//   - our own 429   -> still counts (`_mcpAnonRefused`), or a tripped bucket
//     would decrement itself on each refusal and reopen mid-flood.
//   - anything else with no actor -> junk token, revoked key, anonymous
//     discovery. This is the traffic the bucket is for.
const mcpAnonymousAttempt = (req, res) => {
    if (workspace.defaultOwnerKey(req.actor)) return false;
    if (req._mcpAnonRefused) return true;
    return res.statusCode !== 429 && res.statusCode !== 503;
};

// A PER-CREDENTIAL BUCKET CANNOT BOUND A CREDENTIAL IT HAS NEVER SEEN.
//
// mcpToolKey hashes whatever token arrived, so a flood that mints a new random
// bearer per request draws a fresh bucket every time: unlimited by construction,
// and every one of those requests still costs a credential lookup behind this
// middleware. The per-credential bucket is right for callers we can identify; it
// is simply not a limit on anonymous traffic.
//
// So bound the anonymous half separately, by IP, in front of it. The obvious
// objection is the bug this replaced — one provider egress carries every
// Claude.ai (and every ChatGPT) user, so an IP bucket that counted their traffic
// would throttle real users by each other. What makes both properties true at
// once is that this limiter counts on OUTCOME, not on address:
// skipSuccessfulRequests + requestWasSuccessful decrement, on response finish,
// every request mcpAnonymousAttempt (above) declines to call anonymous.
// Legitimate users therefore never accumulate here no matter how many share an
// IP, while requests that never resolve to anybody — junk tokens, revoked keys,
// anonymous discovery — do, per IP.
//
// The window is deliberately loose: this is a flood ceiling, not a quota.
// Anonymous `tools/list` (registry scrapers) is legitimate traffic and lands in
// the same bucket, which is why the default is generous rather than tight. Once
// it trips, the refusal happens here, before the credential lookup — which is
// the cost the rotating-token flood was buying.
const mcpUnauthenticatedIpLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Math.max(1, Number(process.env.MCP_ANON_RATE_LIMIT_PER_MINUTE) || 240),
    standardHeaders: false,
    legacyHeaders: false,
    store: resolveRateLimitStore('rl:mcp-anon-ip:'),
    skip: (req) => shouldSkipLimiter(req) || disableFallback,
    keyGenerator: (req) => `ip:${getClientIp(req)}`,
    skipSuccessfulRequests: true,
    // "Successful" here means IDENTIFIED, not 2xx. An anonymous 200 (public
    // discovery) is exactly the traffic this bucket is for, and a 401 from a
    // real user's expired token costs them one slot out of hundreds.
    requestWasSuccessful: (req, res) => !mcpAnonymousAttempt(req, res),
    handler: mcpRateLimitHandler('MCP ANON RATE LIMIT', { marksAnonymousRefusal: true }),
});

// Returns a JSON-RPC-shaped error so MCP clients can classify the retry.
const mcpToolLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Math.max(1, Number(process.env.MCP_RATE_LIMIT_PER_MINUTE) || 120),
    standardHeaders: true,
    legacyHeaders: false,
    store: resolveRateLimitStore('rl:mcp-tool:'),
    skip: (req) => shouldSkipLimiter(req) || disableFallback,
    keyGenerator: mcpToolKey,
    handler: mcpRateLimitHandler('MCP RATE LIMIT'),
});

const logLeadLimitExceeded = (req) => {
    const email = req.body?.email ? String(req.body.email).toLowerCase() : 'unknown';
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const requestId = req._req_id || 'unknown';
    console.warn(`[LEAD RATE LIMIT] exceeded | ip=${ip} | email=${email} | request_id=${requestId}`);
};

const leadsLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 30,                  // 30 requests per window per IP
    standardHeaders: true,
    legacyHeaders: false,
    store: resolveRateLimitStore('rl:leads:'),
    skip: (req) => shouldSkipLimiter(req) || disableFallback,
    keyGenerator: (req) => getClientIp(req), // RL-02: use the CF-aware, validated client IP
    handler: (req, res, _next, options) => {
        logLeadLimitExceeded(req);
        res.status(options.statusCode).json({ error: 'too_many_requests', message: options.message });
    }
});

const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,      // 1 minute
    max: 100,                  // 100 requests per minute per IP
    standardHeaders: true,
    legacyHeaders: false,
    store: resolveRateLimitStore('rl:webhook:'),
    skip: (req) => shouldSkipLimiter(req) || disableFallback,
    keyGenerator: (req) => getClientIp(req),
    handler: (req, res, _next, options) => {
        console.warn(`[WEBHOOK RATE LIMIT] exceeded | ip=${getClientIp(req)} | path=${req.path}`);
        res.status(options.statusCode).json({ error: 'rate_limit_exceeded', message: options.message });
    }
});

const contextHeavyLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    store: resolveRateLimitStore('rl:context-heavy:'),
    skip: (req) => shouldSkipLimiter(req) || disableFallback,
    keyGenerator: (req) => {
        const actorKey = workspace.defaultOwnerKey(req.actor);
        return actorKey ? `actor:${actorKey}` : getClientIp(req);
    },
    handler: (req, res, _next, options) => {
        res.status(options.statusCode).json({ error: 'rate_limit_exceeded', message: options.message });
    }
});

module.exports = {
    getClientIp,
    isIpAddress,
    resolveRateLimitStore,
    shouldSkipLimiter,
    disableFallback,
    apiLimiter,
    authLoginLimiter,
    authSignupLimiter,
    mcpAuthLimiter,
    mcpDevicePollLimiter,
    oauthSharedEgressLimiter,
    oauthActorLimiter,
    oauthGrantLimiter,
    oauthRegisterLimiter,
    mcpToolLimiter,
    mcpUnauthenticatedIpLimiter,
    mcpToolKey,
    leadsLimiter,
    webhookLimiter,
    contextHeavyLimiter
};
