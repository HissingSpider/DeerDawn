// H10 regression test.
//
// `?redirect_url` on the login/signup flow was passed unvalidated into router.replace/push
// and Clerk's redirectUrlComplete, giving an open redirect that fired even for an
// already-signed-in visitor on mount (zero interaction).
//
// The traversal cases below are the important ones: an input check alone is NOT enough,
// because URL normalization collapses '/..//evil.tld' into the pathname '//evil.tld' —
// protocol-relative, which a browser resolves as https://evil.tld. The first version of
// this guard checked only the input and so still returned '//evil.tld'.

import test from 'node:test';
import assert from 'node:assert';
import { authQueryWithClerkHash, getSafeRedirectPath, resolveAuthReturnPath } from './redirects';

test('allows same-origin relative paths', () => {
  assert.strictEqual(getSafeRedirectPath('/onboarding'), '/onboarding');
  assert.strictEqual(getSafeRedirectPath('/settings/plan?tab=billing#x'), '/settings/plan?tab=billing#x');
  assert.strictEqual(getSafeRedirectPath('/legit/../path'), '/path');
});

test('rejects absolute and scheme-bearing URLs', () => {
  for (const bad of [
    'https://evil.tld',
    'http://evil.tld',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
  ]) {
    assert.strictEqual(getSafeRedirectPath(bad), '/', `${bad} must not be followed`);
  }
});

test('rejects protocol-relative URLs, including ones produced by traversal normalization', () => {
  for (const bad of [
    '//evil.tld',
    '\t//evil.tld',
    '/\\evil.tld',
    '/..//evil.tld',
    '/../..//evil.tld',
    '/foo/../..//evil.tld',
    '/%2e%2e//evil.tld',
  ]) {
    const got = getSafeRedirectPath(bad);
    assert.strictEqual(got, '/', `${bad} resolved to ${got}, which a browser reads as an external host`);
    assert.ok(!got.startsWith('//'), `${bad} produced a protocol-relative result`);
  }
});

test('rejects empty and non-string input', () => {
  assert.strictEqual(getSafeRedirectPath(''), '/');
  assert.strictEqual(getSafeRedirectPath(null), '/');
  assert.strictEqual(getSafeRedirectPath(undefined), '/');
  assert.strictEqual(getSafeRedirectPath(42 as unknown as string), '/');
});

test('honours an explicit fallback', () => {
  assert.strictEqual(getSafeRedirectPath('https://evil.tld', '/home'), '/home');
});

test('an authorize screen\'s absolute return URL survives sign-in and sign-up', () => {
  const origin = 'https://app.deerdawn.com';
  const back = 'https://app.deerdawn.com/oauth/consent?req=abc123';
  assert.strictEqual(
    resolveAuthReturnPath({ sign_in_force_redirect_url: back, redirect_url: back }, origin, 'login'),
    '/oauth/consent?req=abc123',
  );
  assert.strictEqual(
    resolveAuthReturnPath({ sign_up_force_redirect_url: 'https://app.deerdawn.com/mcp-auth?code=XY-12' }, origin, 'signup'),
    '/mcp-auth?code=XY-12',
  );
  assert.strictEqual(resolveAuthReturnPath({ redirect_url: '/settings' }, origin, 'login'), '/settings');
});

test('a return URL on another origin, or none at all, is not followed', () => {
  const origin = 'https://app.deerdawn.com';
  assert.strictEqual(resolveAuthReturnPath({ redirect_url: 'https://evil.tld/oauth/consent' }, origin, 'login'), undefined);
  assert.strictEqual(resolveAuthReturnPath({ sign_up_force_redirect_url: '//evil.tld' }, origin, 'signup'), undefined);
  assert.strictEqual(resolveAuthReturnPath({ redirect_url: 'javascript:alert(1)' }, origin, 'login'), undefined);
  assert.strictEqual(resolveAuthReturnPath({}, origin, 'login'), undefined);
  // On the server the origin is unknown, so nothing absolute is trusted.
  assert.strictEqual(resolveAuthReturnPath({ redirect_url: 'https://app.deerdawn.com/x' }, null, 'login'), undefined);
});

test('Clerk\'s hash-borne return URL is read, the way Clerk actually sends it', () => {
  // Observed 2026-09-16: <SignInButton mode="redirect"> lands on
  // /login#/?sign_in_force_redirect_url=...&redirect_url=..., with an empty query.
  const hash = '#/?sign_up_force_redirect_url=http%3A%2F%2Flocalhost%3A3010%2Foauth%2Fconsent%3Freq%3DR1'
    + '&sign_in_force_redirect_url=http%3A%2F%2Flocalhost%3A3010%2Foauth%2Fconsent%3Freq%3DR1'
    + '&redirect_url=http%3A%2F%2Flocalhost%3A3010%2Foauth%2Fconsent%3Freq%3DR1';
  const merged = authQueryWithClerkHash({}, hash);
  assert.strictEqual(resolveAuthReturnPath(merged, 'http://localhost:3010', 'login'), '/oauth/consent?req=R1');
  assert.strictEqual(resolveAuthReturnPath(merged, 'http://localhost:3010', 'signup'), '/oauth/consent?req=R1');
  assert.deepStrictEqual(authQueryWithClerkHash({ plan: 'x' }, ''), { plan: 'x' });
});
