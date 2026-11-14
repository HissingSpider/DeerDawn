// Rate-limiter coverage. The audit found no test anywhere asserted a 429, so a regression
// that silently disabled a limiter (or reintroduced the skipSuccessfulRequests trap on
// signup, which would let one IP mint unlimited free-tier accounts) would have shipped green.

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'false';
process.env.RATE_LIMIT_FALLBACK = 'memory';
process.env.DISABLE_REDIS = 'true';
process.env.MCP_RATE_LIMIT_PER_MINUTE = '3';
process.env.MCP_ANON_RATE_LIMIT_PER_MINUTE = '4';

const express = require('express');
const request = require('supertest');
const {
    authLoginLimiter,
    authSignupLimiter,
    leadsLimiter,
    mcpToolLimiter,
    mcpUnauthenticatedIpLimiter,
} = require('../../src/middleware/rateLimit');

// Each limiter keys on client IP, so distinct X-Forwarded-For values give independent
// buckets. 'trust proxy' must be on for express to honour the header.
function appWith(limiter, { method = 'post', path = '/t' } = {}) {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app[method](path, limiter, (req, res) => res.status(200).json({ ok: true }));
    return app;
}

async function hammer(app, { ip, times, path = '/t', body = {} }) {
    const codes = [];
    for (let i = 0; i < times; i += 1) {
        const res = await request(app).post(path).set('X-Forwarded-For', ip).send(body);
        codes.push(res.status);
    }
    return codes;
}

test('signup limiter counts ALL attempts and eventually returns 429', async () => {
    const app = appWith(authSignupLimiter);
    // Limit is 10 per 30min per IP, and skipSuccessfulRequests is deliberately false —
    // successes must count, otherwise one IP can mint unlimited accounts.
    const codes = await hammer(app, { ip: '203.0.113.10', times: 13, body: { email: 'a@b.co' } });
    assert.ok(codes.includes(429), `expected a 429 within 13 successful signups, got ${codes.join(',')}`);
    const last = codes[codes.length - 1];
    assert.strictEqual(last, 429, 'limiter should stay closed once tripped');
});

test('signup limiter buckets are per-IP, not global', async () => {
    const app = appWith(authSignupLimiter);
    await hammer(app, { ip: '203.0.113.20', times: 12, body: { email: 'a@b.co' } });
    const other = await request(app)
        .post('/t').set('X-Forwarded-For', '203.0.113.21').send({ email: 'c@d.co' });
    assert.strictEqual(other.status, 200, 'a different IP must not inherit another IP\'s exhausted bucket');
});

test('signup limiter is not defeated by varying the email on one IP', async () => {
    const app = appWith(authSignupLimiter);
    const codes = [];
    for (let i = 0; i < 13; i += 1) {
        const res = await request(app)
            .post('/t').set('X-Forwarded-For', '203.0.113.30').send({ email: `u${i}@example.com` });
        codes.push(res.status);
    }
    assert.ok(codes.includes(429), 'rotating the email must not create fresh buckets — key is IP only');
});

test('login limiter returns a structured 429 body, not a bare status', async () => {
    const app = appWith(authLoginLimiter);
    // skipSuccessfulRequests is true here, so a 200 handler never counts. Use a failing
    // handler to exercise the counted path.
    const failing = express();
    failing.set('trust proxy', 1);
    failing.use(express.json());
    failing.post('/t', authLoginLimiter, (req, res) => res.status(401).json({ error: 'nope' }));

    let body = null;
    for (let i = 0; i < 25; i += 1) {
        const res = await request(failing)
            .post('/t').set('X-Forwarded-For', '203.0.113.40').send({ email: 'x@y.co' });
        if (res.status === 429) { body = res.body; break; }
    }
    assert.ok(body, 'expected the login limiter to trip within 25 failed attempts');
    assert.strictEqual(body.error, 'too_many_requests');
    assert.ok(body.message, '429 response should carry a message');
    assert.ok(app, 'app constructed');
});

test('leads limiter protects the public lead-capture path', async () => {
    const app = appWith(leadsLimiter);
    // max is 30 per 15min per IP, so the 31st request is the first to trip.
    const codes = await hammer(app, { ip: '203.0.113.50', times: 32, body: { email: 'a@b.co' } });
    assert.ok(codes.includes(429), `expected the public leads limiter to trip, got ${codes.join(',')}`);
});

test('MCP limiter returns a JSON-RPC rate-limit error', async () => {
    const app = appWith(mcpToolLimiter);
    const responses = [];
    for (let i = 0; i < 5; i += 1) {
        responses.push(await request(app)
            .post('/t')
            .set('X-Forwarded-For', '203.0.113.60')
            .send({ jsonrpc: '2.0', id: i + 1, method: 'tools/list' }));
    }
    const limited = responses.find((response) => response.status === 429);
    assert.ok(limited, 'expected the MCP limiter to trip');
    assert.strictEqual(limited.body.jsonrpc, '2.0');
    assert.strictEqual(limited.body.error.code, -32029);
    assert.match(limited.body.error.message, /retry/i);
});

test('SKIP_RATE_LIMIT only bypasses outside production', async () => {
    // The bypass is guarded by NODE_ENV !== 'production'. Assert the guard exists rather
    // than mutating global state mid-suite.
    const src = require('node:fs').readFileSync(
        require.resolve('../../src/middleware/rateLimit'), 'utf8'
    );
    assert.match(
        src,
        /process\.env\.NODE_ENV\s*!==\s*'production'\s*&&\s*process\.env\.SKIP_RATE_LIMIT\s*===\s*'true'/,
        'rate-limit bypass must remain gated on non-production'
    );
});

// The MCP limiter is mounted before auth, so req.actor is unset when it runs.
// Keyed on IP alone, every Claude.ai (or ChatGPT) user shared that host's
// egress bucket: one heavy user rate-limited everyone else on the same host.
test('MCP limiter buckets per credential when two users share one egress IP', async () => {
    const app = appWith(mcpToolLimiter);
    const send = (token) => request(app)
        .post('/t')
        .set('X-Forwarded-For', '203.0.113.70')
        .set('Authorization', `Bearer ${token}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/call' });
    const heavy = [];
    for (let i = 0; i < 5; i += 1) heavy.push((await send('token-heavy-user')).status);
    assert.ok(heavy.includes(429), `the heavy user should trip their own bucket, got ${heavy.join(',')}`);
    const other = await send('token-other-user');
    assert.strictEqual(other.status, 200, 'another credential on the same IP must not inherit the exhausted bucket');
});

// ── The other half of that fix ────────────────────────────────────────────────
// Keying on a hash of the presented credential means a flood that ROTATES the
// credential draws a fresh bucket per request — unlimited, while each request
// still costs a credential lookup. The anonymous IP limiter in front bounds that
// without re-sharing a bucket between real users on one provider egress, because
// it counts only requests that never resolved to an actor.
//
// Mirrors app.js: anon IP limiter, then per-credential limiter, then auth.
function mcpStack({ validTokens = [] } = {}) {
    // Flipped by the 503 case below: a credential lookup that is briefly
    // unavailable answers 503 WITHOUT binding an actor, exactly like the real one.
    const state = { unavailable: false };
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.post(
        '/t',
        mcpUnauthenticatedIpLimiter,
        mcpToolLimiter,
        (req, res, next) => {
            if (state.unavailable) return res.status(503).json({ error: 'service_unavailable' });
            const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
            if (!validTokens.includes(token)) return res.status(401).json({ error: 'unauthorized' });
            // What requireAuth does: bind the request to a workspace.
            req.actor = { type: 'user', id: `user-${token}`, org_id: `org-${token}` };
            return next();
        },
        (_req, res) => res.status(200).json({ ok: true })
    );
    app.state = state;
    return app;
}

const mcpPost = (app, { ip, token }) => {
    const req = request(app).post('/t').set('X-Forwarded-For', ip);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req.send({ jsonrpc: '2.0', id: 1, method: 'tools/call' });
};

test('N rotating junk tokens from one IP DO get limited', async () => {
    const app = mcpStack({ validTokens: ['good-token'] });
    const codes = [];
    for (let i = 0; i < 10; i += 1) {
        // A fresh random bearer every request: a brand-new per-credential bucket
        // each time, so only an IP-keyed bucket can bound this at all.
        codes.push((await mcpPost(app, { ip: '198.51.100.10', token: `junk-${i}-${Math.random()}` })).status);
    }
    assert.ok(
        codes.includes(429),
        `rotating the credential must not mint unlimited buckets, got ${codes.join(',')}`
    );
    assert.strictEqual(codes[codes.length - 1], 429, 'the anonymous bucket should stay closed once tripped');
});

test('the rotating-token bucket is per IP, and answers in JSON-RPC', async () => {
    const app = mcpStack({ validTokens: [] });
    let limited = null;
    for (let i = 0; i < 10 && !limited; i += 1) {
        const res = await mcpPost(app, { ip: '198.51.100.20', token: `junk-${i}` });
        if (res.status === 429) limited = res;
    }
    assert.ok(limited, 'expected the anonymous IP limiter to trip');
    assert.strictEqual(limited.body.jsonrpc, '2.0');
    assert.strictEqual(limited.body.error.code, -32029);

    const elsewhere = await mcpPost(app, { ip: '198.51.100.21', token: 'junk-from-another-ip' });
    assert.strictEqual(elsewhere.status, 401, 'another IP must not inherit the exhausted anonymous bucket');
});

test('two valid tokens behind one egress IP do not share a bucket', async () => {
    // THE BUG NOT TO REINTRODUCE. Every Claude.ai user reaches us from one host's
    // egress; an IP bucket counting their successful traffic would throttle them
    // by each other. Six identified requests from one IP is well past the
    // anonymous ceiling (4 here) and must all pass.
    const app = mcpStack({ validTokens: ['alice-token', 'bob-token'] });
    const codes = [];
    for (let i = 0; i < 3; i += 1) {
        codes.push((await mcpPost(app, { ip: '198.51.100.30', token: 'alice-token' })).status);
        codes.push((await mcpPost(app, { ip: '198.51.100.30', token: 'bob-token' })).status);
    }
    assert.deepStrictEqual(
        codes,
        [200, 200, 200, 200, 200, 200],
        `identified users on one IP must not be limited by each other, got ${codes.join(',')}`
    );

    // Their OWN per-credential bucket still closes (max 3 here), and only theirs.
    assert.strictEqual((await mcpPost(app, { ip: '198.51.100.30', token: 'alice-token' })).status, 429);
    assert.strictEqual((await mcpPost(app, { ip: '198.51.100.30', token: 'bob-token' })).status, 429);
});

// ── REGRESSION (#480): "anonymous" was being read off the ACTOR alone ─────────
//
// requestWasSuccessful asked only whether an actor got bound, and a request
// refused DOWNSTREAM never binds one — the per-credential limiter and the auth
// middleware both sit behind this one. So a single heavy credential's own 429s,
// or a brief credential-lookup blip, counted as anonymous attempts against the
// shared egress and locked out every OTHER Claude.ai and ChatGPT user behind it
// for the window: precisely the bug the IP bucket was built to avoid.
//
// A request that carried a recognised credential is never anonymous, and neither
// is one nobody downstream was willing to answer. Only the anon limiter's own
// refusal, and requests that genuinely resolved to nobody, count.
test('a heavy credential\'s own 429s do not lock out the egress IP it shares', async () => {
    const app = mcpStack({ validTokens: ['heavy-token', 'quiet-token'] });
    const ip = '198.51.100.40';
    const codes = [];
    for (let i = 0; i < 12; i += 1) codes.push((await mcpPost(app, { ip, token: 'heavy-token' })).status);
    assert.ok(codes.includes(429), `precondition: the heavy credential trips its OWN bucket, got ${codes.join(',')}`);

    // Nine of those 429s are well past the anonymous ceiling (4 here). The
    // colleague sharing the egress has spent nothing.
    const neighbour = await mcpPost(app, { ip, token: 'quiet-token' });
    assert.strictEqual(
        neighbour.status, 200,
        'one heavy credential must not throttle every other user behind the same egress IP'
    );
});

test('a downstream 503 is not an anonymous attempt either', async () => {
    // A blip in the credential lookup hits everybody behind the egress at once,
    // so this is six different real users each making one request — well past the
    // anonymous ceiling (4 here), and none of them anonymous.
    const tokens = ['steady-1', 'steady-2', 'steady-3', 'steady-4', 'steady-5', 'steady-6'];
    const app = mcpStack({ validTokens: [...tokens, 'steady-after'] });
    const ip = '198.51.100.50';
    app.state.unavailable = true;
    const during = [];
    for (const token of tokens) during.push((await mcpPost(app, { ip, token })).status);
    assert.ok(
        during.every((code) => code === 503),
        `a blip must keep answering with its own reason, got ${during.join(',')}`
    );

    // The blip passes. The IP must not still be serving out a rate-limit window
    // it earned by being briefly unavailable.
    app.state.unavailable = false;
    assert.strictEqual(
        (await mcpPost(app, { ip, token: 'steady-after' })).status, 200,
        'a concurrency blip must not lock the IP out for the rest of the window'
    );
});

test('MCP limiter key hashes the credential and never stores the raw token', () => {
    const { mcpToolKey } = require('../../src/middleware/rateLimit');
    const token = 'dd_live_secret_token_value';
    const bearer = mcpToolKey({ headers: { authorization: `Bearer ${token}` }, ip: '203.0.113.80' });
    assert.match(bearer, /^cred:[0-9a-f]{64}$/);
    assert.ok(!bearer.includes(token), 'the raw token must not appear in the limiter key');
    const apiKey = mcpToolKey({ headers: { 'x-api-key': token }, ip: '203.0.113.80' });
    assert.strictEqual(apiKey, bearer, 'the same credential keys the same bucket whichever header carries it');
    const actor = mcpToolKey({ headers: { authorization: `Bearer ${token}` }, actor: { id: 'u1', workspace_key: 'ws_1' } });
    assert.match(actor, /^actor:/, 'an authenticated actor still keys on the tenant');
    const anon = mcpToolKey({ headers: {}, ip: '203.0.113.80', socket: {} });
    assert.strictEqual(anon, '203.0.113.80', 'no credential falls back to the client IP');
});
