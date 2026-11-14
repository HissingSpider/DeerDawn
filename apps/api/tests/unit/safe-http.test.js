/**
 * SSRF guard (SSRF-02) — no DB. IP-literal + localhost cases are deterministic (no external DNS).
 */
const test = require('node:test');
const assert = require('node:assert');
const { assertSafeUrl, isBlockedIp } = require('../../src/utils/safeHttp');

test('isBlockedIp flags private/loopback/link-local/metadata, allows public', () => {
    assert.strictEqual(isBlockedIp('169.254.169.254'), true, 'cloud metadata IP');
    assert.strictEqual(isBlockedIp('127.0.0.1'), true, 'loopback');
    assert.strictEqual(isBlockedIp('10.0.0.1'), true, 'private 10/8');
    assert.strictEqual(isBlockedIp('192.168.1.1'), true, 'private 192.168/16');
    assert.strictEqual(isBlockedIp('172.16.0.1'), true, 'private 172.16/12');
    assert.strictEqual(isBlockedIp('::1'), true, 'ipv6 loopback');
    assert.strictEqual(isBlockedIp('8.8.8.8'), false, 'public');
    assert.strictEqual(isBlockedIp('1.1.1.1'), false, 'public');
});

test('assertSafeUrl blocks metadata, private, non-http, and localhost', async () => {
    await assert.rejects(assertSafeUrl('http://169.254.169.254/latest/meta-data/'), /ssrf_blocked/);
    await assert.rejects(assertSafeUrl('http://10.0.0.5/admin'), /ssrf_blocked/);
    await assert.rejects(assertSafeUrl('ftp://example.com/x'), /ssrf_blocked/);
    await assert.rejects(assertSafeUrl('file:///etc/passwd'), /ssrf_blocked/);
    await assert.rejects(assertSafeUrl('not a url'), /ssrf_blocked/);
    await assert.rejects(assertSafeUrl('http://localhost:8080/'), /ssrf_blocked/);
});

test('assertSafeUrl allows a public literal IP', async () => {
    const url = await assertSafeUrl('https://8.8.8.8/');
    assert.strictEqual(url.hostname, '8.8.8.8');
});
