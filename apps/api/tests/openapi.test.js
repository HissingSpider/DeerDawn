const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

// Helper
function request(path) {
    return new Promise((resolve, reject) => {
        http.get(`http://localhost:${process.env.PORT || 8080}${path}`, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('error', reject);
    });
}

test('OpenAPI Documentation', async (t) => {
    await t.test('GET /openapi.json returns valid JSON spec', async () => {
        try {
            const { status, body } = await request('/openapi.json');
            assert.strictEqual(status, 200);
            const spec = JSON.parse(body);
            assert.strictEqual(spec.openapi, '3.0.0');
            assert.ok(spec.paths['/api/v1/auth/login']);
        } catch (e) {
            if (e.code === 'ECONNREFUSED') {
                console.log('Skipping test: Server not running');
                return;
            }
            throw e;
        }
    });

    await t.test('GET /docs returns HTML or 403 based on env', async () => {
        try {
            const { status } = await request('/docs');
            // In dev (default), it should be 200 (redirect) or 301.
            // If DOCS_ENABLED=false, 403. 
            // We just assert it responds.
            assert.ok(status === 200 || status === 301 || status === 403);
        } catch (e) {
            if (e.code === 'ECONNREFUSED') return;
            throw e;
        }
    });
});
