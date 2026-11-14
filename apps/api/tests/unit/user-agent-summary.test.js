const test = require('node:test');
const assert = require('node:assert');
const { summarizeUserAgent, sanitizeCurrentUrl } = require('../../src/utils/userAgentSummary');

test('names the browser and OS of common agents', () => {
  const chromeMac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
  assert.deepStrictEqual(summarizeUserAgent(chromeMac), { $browser: 'Chrome', $browser_version: 152, $os: 'Mac OS X' });
  const edge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0';
  assert.strictEqual(summarizeUserAgent(edge).$browser, 'Edge');
  const iosSafari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  assert.deepStrictEqual(summarizeUserAgent(iosSafari), { $browser: 'Safari', $browser_version: 18, $os: 'iOS' });
});

test('returns nothing rather than guessing', () => {
  assert.deepStrictEqual(summarizeUserAgent(''), {});
  assert.deepStrictEqual(summarizeUserAgent(null), {});
  assert.deepStrictEqual(summarizeUserAgent('curl/8.4.0'), {});
});

test('a current url never carries its query or fragment', () => {
  assert.deepStrictEqual(
    sanitizeCurrentUrl('https://app.deerdawn.com/mcp-auth?code=secret&req=abc#x'),
    { $current_url: 'https://app.deerdawn.com/mcp-auth', $host: 'app.deerdawn.com', $pathname: '/mcp-auth' },
  );
  assert.strictEqual(sanitizeCurrentUrl('javascript:alert(1)'), null);
  assert.strictEqual(sanitizeCurrentUrl('not a url'), null);
  assert.strictEqual(sanitizeCurrentUrl(undefined), null);
});
