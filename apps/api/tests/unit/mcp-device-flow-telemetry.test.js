const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const redisModule = require('../../src/config/redis');
const productEvents = require('../../src/services/productEventsService');
const router = require('../../src/routes/shared/mcp-auth');

// The device flow is the only record of a LOCAL connect attempt. Its three legs used
// to emit nothing, so a user who pasted the config and never finished the browser step
// left no trace at all. These tests pin the two properties that make the new telemetry
// worth having: the legs correlate, and the bearer credential never leaks into them.

function appWith() {
    const app = express();
    app.use(express.json());
    app.use('/auth/mcp', router);
    return app;
}

function captureEvents() {
    const original = productEvents.recordProductEvent;
    const events = [];
    productEvents.recordProductEvent = async (actor, input) => {
        events.push({ actor, input });
        return input;
    };
    return { events, restore: () => { productEvents.recordProductEvent = original; } };
}

function stubRedis(overrides) {
    const original = {};
    for (const k of Object.keys(overrides)) {
        original[k] = redisModule.redis[k];
        redisModule.redis[k] = overrides[k];
    }
    return () => {
        for (const k of Object.keys(original)) redisModule.redis[k] = original[k];
    };
}

// setImmediate keeps the instrumentation off the auth response path, so the event
// lands after the response resolves.
const flush = () => new Promise((r) => setImmediate(() => setImmediate(r)));

test('/start records an anonymous attempt and never writes the device code', async () => {
    const cap = captureEvents();
    const restore = stubRedis({
        multi: () => ({ set() { return this; }, exec: async () => [] }),
    });
    try {
        const res = await request(appWith()).post('/auth/mcp/start').send({});
        assert.equal(res.status, 200);
        await flush();

        assert.equal(cap.events.length, 1);
        const { actor, input } = cap.events[0];
        assert.equal(input.event_name, 'mcp_device_flow_started');
        assert.equal(actor, null, 'no actor exists yet at /start');
        assert.ok(input.session_id.startsWith('mcpdf-'), 'correlation id is namespaced');
        assert.ok(
            !input.session_id.includes(res.body.device_code),
            'the bearer device code must never reach product_events',
        );
        assert.ok(input.session_id.length <= 128, 'fits the session_id column');
    } finally {
        restore();
        cap.restore();
    }
});

test('/token attributes the pickup to the owner stored at authorize time', async () => {
    const cap = captureEvents();
    const deviceCode = 'a'.repeat(32);
    const restore = stubRedis({
        get: async () => JSON.stringify({
            status: 'authorized',
            api_key: 'dd_secret_key',
            user_code: 'ABCD1234',
            owner: { id: 'user-7', org_id: 'org-7' },
        }),
        multi: () => ({ del() { return this; }, exec: async () => [] }),
    });
    try {
        const res = await request(appWith()).get(`/auth/mcp/token?device_code=${deviceCode}`);
        assert.equal(res.status, 200);
        await flush();

        const { actor, input } = cap.events[0];
        assert.equal(input.event_name, 'mcp_device_flow_completed');
        assert.deepEqual(actor, { type: 'user', id: 'user-7', org_id: 'org-7' });
        assert.ok(!JSON.stringify(input).includes(deviceCode), 'device code stays out of the event');
        assert.ok(!JSON.stringify(input).includes('dd_secret_key'), 'api key stays out of the event');
    } finally {
        restore();
        cap.restore();
    }
});

test('the same device code yields the same correlation id across legs', async () => {
    const cap = captureEvents();
    const deviceCode = 'b'.repeat(32);
    const restore = stubRedis({
        get: async () => JSON.stringify({ status: 'authorized', api_key: 'k', user_code: 'X', owner: null }),
        multi: () => ({ del() { return this; }, exec: async () => [] }),
    });
    try {
        await request(appWith()).get(`/auth/mcp/token?device_code=${deviceCode}`);
        await request(appWith()).get(`/auth/mcp/token?device_code=${deviceCode}`);
        await flush();
        assert.equal(cap.events.length, 2);
        assert.equal(
            cap.events[0].input.session_id,
            cap.events[1].input.session_id,
            'a stable id is what lets the anonymous /start row be backfilled on authorize',
        );
    } finally {
        restore();
        cap.restore();
    }
});

// /authorize sits behind requireAuth, which is destructured at module load, so its
// wiring is pinned structurally — the same convention as desktop-auth-route.test.js.
test('/authorize is instrumented with the identified actor and persists the owner', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'routes', 'shared', 'mcp-auth.js'),
        'utf8',
    );
    assert.match(source, /recordFlowEvent\(req\.actor, 'mcp_device_flow_authorized', deviceCode, flowClientLabels\(state\.client\)\)/);
    assert.match(source, /owner: \{ id: actorId, org_id: orgId \}/);
    assert.doesNotMatch(source, /session_id:\s*deviceCode/, 'never pass the raw device code as session_id');
});

test('/start labels the attempt with the install id and package version, and the pickup carries them', async () => {
    const cap = captureEvents();
    let stored = null;
    const restore = stubRedis({
        multi: () => ({
            set(key, value) { if (key.startsWith('mcp:device:')) stored = JSON.parse(value); return this; },
            exec: async () => [],
        }),
    });
    const installId = 'c'.repeat(32);
    try {
        const res = await request(appWith()).post('/auth/mcp/start').send({
            honors_server_expiry: true,
            install_id: installId,
            client_version: '1.0.56',
        });
        assert.equal(res.status, 200);
        await flush();
        assert.deepEqual(cap.events[0].input.metadata, { install_id: installId, client_version: '1.0.56' });
        assert.deepEqual(stored.client, { install_id: installId, client_version: '1.0.56' }, 'kept for the later legs');
    } finally {
        restore();
        cap.restore();
    }

    const cap2 = captureEvents();
    const restore2 = stubRedis({
        get: async () => JSON.stringify({ status: 'authorized', api_key: 'k', user_code: 'X', owner: null, client: { install_id: installId, client_version: '1.0.56' } }),
        multi: () => ({ del() { return this; }, exec: async () => [] }),
    });
    try {
        await request(appWith()).get(`/auth/mcp/token?device_code=${'d'.repeat(32)}`);
        await flush();
        assert.equal(cap2.events[0].input.event_name, 'mcp_device_flow_completed');
        assert.deepEqual(cap2.events[0].input.metadata, { install_id: installId, client_version: '1.0.56' });
    } finally {
        restore2();
        cap2.restore();
    }
});

test('/start drops labels that are not the expected shape (an unauthenticated route)', async () => {
    const cap = captureEvents();
    const restore = stubRedis({
        multi: () => ({ set() { return this; }, exec: async () => [] }),
    });
    try {
        const res = await request(appWith()).post('/auth/mcp/start').send({
            install_id: 'not hex <script>',
            client_version: 'x'.repeat(500),
        });
        assert.equal(res.status, 200);
        await flush();
        assert.deepEqual(cap.events[0].input.metadata, {});
    } finally {
        restore();
        cap.restore();
    }
});
