// The /status page's dashboard row, measured on the server.
//
// The page used to ask the browser to fetch the dashboard with mode 'no-cors',
// which hides the status code: a dashboard answering 500 read as "Operational".
// The API now probes the dashboard itself and reports one answer. These tests
// stand up a real HTTP server as the dashboard, so the probe's own fetch runs.
//
//   - 2xx and 3xx are operational; 4xx, 5xx, a hang and a refused connection are not
//   - a redirect is never followed (it could lead to a third-party host)
//   - the answer is cached briefly, so the public route cannot be used to
//     hammer the dashboard, and concurrent callers share one probe
//   - an unconfigured dashboard URL is "unknown", not a fault nobody measured

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { createDashboardProbe } = require('../../src/services/dashboardProbe');

function serve(handler) {
    return new Promise((resolve) => {
        const hits = [];
        const server = http.createServer((req, res) => { hits.push(req.url); handler(req, res); });
        server.listen(0, '127.0.0.1', () => resolve({
            url: `http://127.0.0.1:${server.address().port}`,
            hits,
            close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
        }));
    });
}

async function answerFor(handler, opts = {}) {
    const dash = await serve(handler);
    try {
        const probe = createDashboardProbe({ baseUrl: () => dash.url, ...opts });
        return { result: await probe.check(), hits: dash.hits };
    } finally {
        await dash.close();
    }
}

test('a dashboard answering 200 is operational', async () => {
    const { result, hits } = await answerFor((req, res) => res.writeHead(200).end('<html></html>'));
    assert.strictEqual(result.dashboard, 'operational');
    assert.deepStrictEqual(hits, ['/login']);
});

test('a dashboard answering 500 is NOT operational', async () => {
    const { result } = await answerFor((req, res) => res.writeHead(500).end('boom'));
    assert.strictEqual(result.dashboard, 'degraded');
});

test('a dashboard answering 404 or 503 is not operational', async () => {
    for (const code of [404, 503]) {
        const { result } = await answerFor((req, res) => res.writeHead(code).end());
        assert.strictEqual(result.dashboard, 'degraded', `status ${code}`);
    }
});

test('a redirect is operational, and is not followed to another host', async () => {
    const elsewhere = await serve((req, res) => res.writeHead(200).end('third party'));
    try {
        const { result } = await answerFor((req, res) => res.writeHead(302, { location: `${elsewhere.url}/landing` }).end());
        assert.strictEqual(result.dashboard, 'operational');
        assert.deepStrictEqual(elsewhere.hits, [], 'the probe followed a redirect to another host');
    } finally {
        await elsewhere.close();
    }
});

test('a dashboard that never answers is degraded within the timeout', async () => {
    const started = Date.now();
    const { result } = await answerFor(() => { /* never respond */ }, { timeoutMs: 150 });
    assert.strictEqual(result.dashboard, 'degraded');
    assert.ok(Date.now() - started < 3000, 'the probe waited far past its timeout');
});

test('a refused connection is degraded', async () => {
    const dash = await serve((req, res) => res.end());
    const url = dash.url;
    await dash.close();
    const probe = createDashboardProbe({ baseUrl: () => url });
    assert.strictEqual((await probe.check()).dashboard, 'degraded');
});

test('the answer is cached: repeated and concurrent checks probe once', async () => {
    const dash = await serve((req, res) => setTimeout(() => res.writeHead(200).end(), 30));
    try {
        let clock = 1000;
        const probe = createDashboardProbe({ baseUrl: () => dash.url, ttlMs: 30000, now: () => clock });
        const results = await Promise.all([probe.check(), probe.check(), probe.check()]);
        assert.ok(results.every((r) => r.dashboard === 'operational'));
        clock += 29000;
        await probe.check();
        assert.strictEqual(dash.hits.length, 1, `the dashboard was probed ${dash.hits.length} times inside the cache window`);
        clock += 2000;
        await probe.check();
        assert.strictEqual(dash.hits.length, 2, 'the cache never expires');
    } finally {
        await dash.close();
    }
});

test('a degraded answer is cached too, so an outage is not hammered either', async () => {
    const dash = await serve((req, res) => res.writeHead(500).end());
    try {
        const probe = createDashboardProbe({ baseUrl: () => dash.url });
        await probe.check();
        await probe.check();
        assert.strictEqual(dash.hits.length, 1);
    } finally {
        await dash.close();
    }
});

test('no dashboard URL configured (or one that is not http) is unknown, not degraded', async () => {
    for (const value of [undefined, '', 'not a url', 'ftp://example.com', 'javascript:alert(1)']) {
        const probe = createDashboardProbe({ baseUrl: () => value });
        assert.strictEqual((await probe.check()).dashboard, 'unknown', String(value));
    }
});

test('the answer names the state and the time, and nothing about the dashboard host', async () => {
    const { result } = await answerFor((req, res) => res.writeHead(200).end());
    assert.deepStrictEqual(Object.keys(result).sort(), ['checked_at', 'dashboard']);
    assert.ok(!Number.isNaN(Date.parse(result.checked_at)));
});
