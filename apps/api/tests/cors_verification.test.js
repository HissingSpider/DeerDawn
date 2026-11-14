const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../src/app');

// One server for the whole file. Passing the bare `app` makes supertest
// listen() and close() a fresh ephemeral server per request; under that churn a
// connection occasionally fails, surfacing as ETIMEDOUT or as a 200 with an
// unparsed body. See tests/oauth-mcp-contracts.test.js for the full diagnosis.
const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../src/config/db');
const { closeRedisConnections } = require('../src/config/redis');

test('CORS Configuration Verification', async (t) => {
  
    await t.test('should allow https://deerdawn.com', async () => {
        const res = await request(httpServer)
            .get('/healthz')
            .set('Origin', 'https://deerdawn.com');
    
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers['access-control-allow-origin'], 'https://deerdawn.com');
        assert.strictEqual(res.headers['cache-control'], 'no-store');
    });

    await t.test('should allow https://www.deerdawn.com', async () => {
        const res = await request(httpServer)
            .get('/healthz')
            .set('Origin', 'https://www.deerdawn.com');
    
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers['access-control-allow-origin'], 'https://www.deerdawn.com');
    });

    await t.test('should allow local dashboard origin on 127.0.0.1:3002', async () => {
        const res = await request(httpServer)
            .get('/healthz')
            .set('Origin', 'http://127.0.0.1:3002');

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers['access-control-allow-origin'], 'http://127.0.0.1:3002');
    });

    await t.test('should NOT allow https://evil.com', async () => {
        const res = await request(httpServer)
            .get('/healthz')
            .set('Origin', 'https://evil.com');
    
        assert.strictEqual(res.status, 200); // The endpoint still works
        // But CORS headers should be missing or not matching
        assert.notStrictEqual(res.headers['access-control-allow-origin'], 'https://evil.com');
    });

    await closeRedisConnections();
    await db.pool.end();
});
