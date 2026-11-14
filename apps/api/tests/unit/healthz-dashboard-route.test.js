// GET /healthz/dashboard: the dashboard row of the public /status page.
//
// /healthz itself is Fly's health check and Docker's, and its exact body ("ok",
// or a bootstrap status on 503) is what they read, so it is unchanged and pinned
// here. The dashboard answer is a separate endpoint.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const dash = http.createServer((req, res) => { res.writeHead(500).end('boom'); });
let dashUrl;

const request = require('supertest');

test.before(() => new Promise((resolve) => dash.listen(0, '127.0.0.1', () => {
    dashUrl = `http://127.0.0.1:${dash.address().port}`;
    process.env.DASHBOARD_URL = dashUrl;
    resolve();
})));

test('GET /healthz/dashboard reports a 500 dashboard as degraded, to the public site', async () => {
    const app = require('../../src/app');
    const server = app.listen(0);
    try {
        const res = await request(server).get('/healthz/dashboard').set('Origin', 'https://deerdawn.com');
        assert.strictEqual(res.status, 200, 'the endpoint itself answers; the state is in the body');
        assert.strictEqual(res.body.dashboard, 'degraded');
        assert.strictEqual(res.headers['access-control-allow-origin'], 'https://deerdawn.com');
        assert.ok(!JSON.stringify(res.body).includes(dashUrl), 'the dashboard address is in the response');

        const healthz = await request(server).get('/healthz');
        assert.strictEqual(healthz.status, 200);
        assert.strictEqual(healthz.text, 'ok', '/healthz body changed: Fly and Docker read it');
    } finally {
        await new Promise((r) => server.close(r));
        dash.closeAllConnections?.();
        await new Promise((r) => dash.close(r));
        await require('../../src/config/redis').closeRedisConnections();
        await require('../../src/config/db').pool.end();
    }
});
