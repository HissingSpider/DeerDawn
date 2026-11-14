/**
 * Fetching a Trail by URL, server-side.
 *
 * The property under test: the API will fetch a Trail only from an origin we
 * serve Trails from. Everything else here — redirects, size, status handling —
 * exists to keep that guarantee from being routed around, because a server that
 * fetches caller-supplied URLs is an SSRF primitive aimed at its own network.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const trailFetch = require('../../src/services/trail/trailFetch');

const BODY = JSON.stringify({ format: 'dawn', format_version: 1, manifest: {}, content: {} });

/** Paths the fake origin was actually asked for. */
let seen = [];
let server;
let origin;

test.before(async () => {
  server = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url === '/pack.dawn') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(BODY);
    }
    if (req.url === '/moved.dawn') {
      res.writeHead(302, { location: '/pack.dawn' });
      return res.end();
    }
    if (req.url === '/huge.dawn') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('x'.repeat(6 * 1024 * 1024));
    }
    if (req.url === '/empty.dawn') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('   ');
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  process.env.TRAIL_FETCH_ORIGINS = origin;
});

test.after(async () => {
  delete process.env.TRAIL_FETCH_ORIGINS;
  await new Promise((resolve) => server.close(resolve));
});

test('a URL is told apart from .dawn contents and from a path', () => {
  assert.strictEqual(trailFetch.isTrailUrl('https://deerdawn.com/packs/x.dawn'), true);
  assert.strictEqual(trailFetch.isTrailUrl('{"format":"dawn"}'), false);
  assert.strictEqual(trailFetch.isTrailUrl('./local.dawn'), false);
  assert.strictEqual(trailFetch.isTrailUrl(undefined), false);
});

test('a Trail on an allowed origin is fetched', async () => {
  const body = await trailFetch.fetchTrailByUrl(`${origin}/pack.dawn`);
  assert.strictEqual(body, BODY);
});

test('an origin we do not serve Trails from is refused before any request', async () => {
  seen = [];
  await assert.rejects(
    () => trailFetch.fetchTrailByUrl('http://169.254.169.254/latest/meta-data/'),
    /trail_fetch_origin_not_allowed/,
  );
  await assert.rejects(
    () => trailFetch.fetchTrailByUrl('https://deerdawn.com.evil.example/pack.dawn'),
    /trail_fetch_origin_not_allowed/,
  );
  assert.deepStrictEqual(seen, [], 'the allow-list must be checked before the request goes out');
});

test('a redirect is refused rather than followed', async () => {
  // Otherwise an allowed origin becomes a hop to anywhere, and the allow-list
  // means nothing.
  await assert.rejects(() => trailFetch.fetchTrailByUrl(`${origin}/moved.dawn`), /trail_fetch_failed/);
});

test('a failed fetch says what happened', async () => {
  await assert.rejects(() => trailFetch.fetchTrailByUrl(`${origin}/missing.dawn`), (err) => {
    assert.match(err.publicMessage, /HTTP 404/);
    return true;
  });
  await assert.rejects(() => trailFetch.fetchTrailByUrl(`${origin}/empty.dawn`), (err) => {
    assert.match(err.publicMessage, /empty body/);
    return true;
  });
});

test('an oversized response is refused rather than merged', async () => {
  await assert.rejects(() => trailFetch.fetchTrailByUrl(`${origin}/huge.dawn`), /trail_fetch_failed/);
});

test('the default allow-list is the site we publish Trails from', () => {
  delete process.env.TRAIL_FETCH_ORIGINS;
  const allowed = trailFetch.allowedOrigins();
  assert.ok(allowed.includes('https://deerdawn.com'));
  assert.ok(allowed.every((entry) => entry.startsWith('http')));
  process.env.TRAIL_FETCH_ORIGINS = origin;
});
