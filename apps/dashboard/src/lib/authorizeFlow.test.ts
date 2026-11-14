/**
 * The authorize screens' logic, tested as logic.
 *
 * Run: `tsx --test src/lib/authorizeFlow.test.ts` (covered by `npm test`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  AUTHORIZE_RETURN_KEY,
  AUTHORIZE_RETURN_TTL_MS,
  DEVICE_LINK_MINUTES,
  LEGACY_DEVICE_LINK_MINUTES,
  authorizeReturnPath,
  authorizeReturnUrl,
  authorizeSignupPath,
  consentRequestId,
  describeAuthorizeFailure,
  deviceLinkLifetimeCopy,
  isAuthorizeRequestPath,
  rememberAuthorizeReturn,
  ssoCallbackPath,
  ssoCallbackReturnTo,
  takeAuthorizeReturn,
} from './authorizeFlow';

const here = path.dirname(fileURLToPath(import.meta.url));
// The constants moved out of routes/shared/mcp-auth.js so the poll limiter's
// budget could be derived from the same window the route grants. This test kept
// reading the route and went red on main the moment that merged, because no job
// on an API-only PR runs the dashboard suite.
const apiSource = readFileSync(
  path.resolve(here, '../../../api/src/config/deviceFlow.js'),
  'utf8',
);

function apiSeconds(name: string): number {
  const match = apiSource.match(new RegExp(`const ${name} = (\\d+);`));
  assert.ok(match, `${name} is no longer declared in apps/api/src/config/deviceFlow.js, so the copy is unpinned`);
  return Number(match[1]);
}

test('the stated link lifetime is the one the API grants', () => {
  assert.equal(DEVICE_LINK_MINUTES * 60, apiSeconds('EXTENDED_DEVICE_CODE_TTL'));
  assert.equal(LEGACY_DEVICE_LINK_MINUTES * 60, apiSeconds('DEVICE_CODE_TTL'));
});

test('the lifetime sentence reads as written, numbers and spaces included', () => {
  assert.equal(
    deviceLinkLifetimeCopy(),
    'valid for 30 minutes (10 if your DeerDawn server is older than 1.0.45)',
  );
});

test('switching account comes back to the same request', () => {
  assert.equal(
    authorizeReturnUrl('https://app.deerdawn.com/oauth/consent?req=abc123'),
    'https://app.deerdawn.com/oauth/consent?req=abc123',
  );
  assert.equal(
    authorizeReturnUrl('https://app.deerdawn.com/mcp-auth?code=WXYZ-1234&utm_source=cli'),
    'https://app.deerdawn.com/mcp-auth?code=WXYZ-1234&utm_source=cli',
  );
});

test('a Clerk routing hash is not carried through the sign-out', () => {
  assert.equal(
    authorizeReturnUrl('https://app.deerdawn.com/mcp-auth?code=WXYZ-1234#/?redirect_url=https%3A%2F%2Fapp.deerdawn.com%2F'),
    'https://app.deerdawn.com/mcp-auth?code=WXYZ-1234',
  );
});

test('an unparseable or non-web location yields no redirect at all', () => {
  assert.equal(authorizeReturnUrl(''), null);
  assert.equal(authorizeReturnUrl(undefined), null);
  assert.equal(authorizeReturnUrl('not a url'), null);
  assert.equal(authorizeReturnUrl('javascript:alert(1)'), null);
});

test('an expired request is terminal and keeps the API\'s own sentence', () => {
  const apiBody = {
    error: 'expired_request',
    message: 'This authorization request expired. Restart the connection from your AI tool.',
  };
  const failure = describeAuthorizeFailure(404, apiBody);
  assert.equal(failure.terminal, true, 'Try again can only resend the same dead request');
  assert.equal(failure.message, apiBody.message);
  assert.equal(failure.reason, 'expired_request');
});

test('a 404 the API did not describe is still terminal, and still says what to do', () => {
  const failure = describeAuthorizeFailure(404, {});
  assert.equal(failure.terminal, true);
  assert.match(failure.message, /Restart the connection from your AI tool/);
});

test('a malformed request is terminal and does not show developer text', () => {
  const failure = describeAuthorizeFailure(400, { error: 'invalid_request', message: 'missing or malformed req' });
  assert.equal(failure.terminal, true);
  assert.ok(!failure.message.includes('malformed req'));
  assert.match(failure.message, /Restart the connection/);
});

test('a transient failure stays retryable', () => {
  for (const [status, body] of [
    [503, { error: 'temporarily_unavailable' }],
    [500, { error: 'internal_error', message: 'fetch failed' }],
    [429, {}],
  ] as const) {
    const failure = describeAuthorizeFailure(status, body);
    assert.equal(failure.terminal, false, `HTTP ${status} can succeed on a second attempt`);
    assert.ok(failure.message.length > 0);
  }
});

test('a body that is not an object cannot throw', () => {
  assert.equal(describeAuthorizeFailure(502, null).terminal, false);
  assert.equal(describeAuthorizeFailure(502, 'Bad gateway').terminal, false);
});


test('the email sign-up carries the request as a query parameter', () => {
  // THE DEFECT THIS REPLACES. Clerk's <SignUpButton mode="redirect"> puts the
  // return target in the HASH (`#/?redirect_url=...`), and the dashboard's
  // /signup redirects Clerk-mode visitors to the marketing sign-up from
  // getServerSideProps, which can only forward the QUERY. The ?req= / ?code=
  // was dropped and the brand-new account landed on /onboarding.
  const origin = 'https://app.deerdawn.com';
  assert.equal(
    authorizeSignupPath(`${origin}/oauth/consent?req=abc123`, origin),
    '/signup?redirect_url=%2Foauth%2Fconsent%3Freq%3Dabc123',
  );
  assert.equal(
    authorizeSignupPath(`${origin}/mcp-auth?code=XYZ-789`, origin),
    '/signup?redirect_url=%2Fmcp-auth%3Fcode%3DXYZ-789',
  );
});

test('the sign-up return target is same-site or nothing', () => {
  const origin = 'https://app.deerdawn.com';
  // This is a navigation target, so an off-origin value must not survive even
  // though today it can only ever be this page's own location.
  assert.equal(authorizeSignupPath('https://evil.tld/oauth/consent?req=1', origin), '/signup');
  assert.equal(authorizeSignupPath('javascript:alert(1)', origin), '/signup');
  assert.equal(authorizeSignupPath('not a url', origin), '/signup');
  assert.equal(authorizeSignupPath(undefined, origin), '/signup');
  assert.equal(authorizeSignupPath('', origin), '/signup');
});

test('the sign-up return target drops the hash, like the sign-in one', () => {
  const origin = 'https://app.deerdawn.com';
  // Clerk's redirect-mode components park their own routing state in the hash;
  // carrying a stale one forward hands the next component somebody else's.
  assert.equal(
    authorizeReturnPath(`${origin}/oauth/consent?req=abc#/?redirect_url=%2F`, origin),
    '/oauth/consent?req=abc',
  );
});

const REQ = 'a'.repeat(16) + '0123456789abcdef'.repeat(2);

test('a sign-up from the consent screen forwards the request id, and nothing else does', () => {
  // The account_created webhook resolves this id against the record /authorize
  // wrote, to name the AI tool the account was made to connect. Only a real
  // consent-screen id is forwarded: the server refuses anything else anyway.
  assert.equal(REQ.length, 48);
  assert.equal(consentRequestId(`/oauth/consent?req=${REQ}`), REQ);
  assert.equal(consentRequestId(`https://app.deerdawn.com/oauth/consent?req=${REQ}`), REQ);
  assert.equal(consentRequestId(`/mcp-auth?code=${REQ}`), undefined);
  assert.equal(consentRequestId('/oauth/consent?req=ChatGPT'), undefined);
  assert.equal(consentRequestId(`/oauth/consent?req=${REQ.toUpperCase()}`), undefined);
  assert.equal(consentRequestId('/onboarding'), undefined);
  assert.equal(consentRequestId(undefined), undefined);
  assert.equal(consentRequestId(''), undefined);
});

test('Google from an authorize screen names that screen on the callback URL', () => {
  // THE DEFECT. redirectUrlComplete alone is skipped whenever Clerk transfers
  // the attempt between sign-in and sign-up on the callback page, which then
  // used its fallbacks: a new account from ChatGPT landed on /select-plan with
  // its ?req= gone and never approved the connection.
  assert.equal(
    ssoCallbackPath(`/oauth/consent?req=${REQ}`),
    `/oauth/sso-callback?return_to=${encodeURIComponent(`/oauth/consent?req=${REQ}`)}`,
  );
  assert.equal(
    ssoCallbackPath('/mcp-auth?code=XYZ-789'),
    `/oauth/sso-callback?return_to=${encodeURIComponent('/mcp-auth?code=XYZ-789')}`,
  );
  // Anything that is not an authorize screen keeps the old, bare callback.
  assert.equal(ssoCallbackPath('/checkout?plan=pro'), '/oauth/sso-callback');
  assert.equal(ssoCallbackPath(null), '/oauth/sso-callback');
  assert.equal(ssoCallbackPath(undefined), '/oauth/sso-callback');
});

test('the callback forces only a same-site authorize screen it reads back', () => {
  const path = `/oauth/consent?req=${REQ}`;
  assert.equal(ssoCallbackReturnTo(path), path);
  assert.equal(ssoCallbackReturnTo([path, '/elsewhere']), path);
  // Hand-edited callback URLs: off-site, protocol-relative, traversal, other pages.
  for (const bad of ['https://evil.tld/oauth/consent', '//evil.tld/oauth/consent', '/\\evil.tld', '/..//evil.tld', '/settings', '', undefined]) {
    assert.equal(ssoCallbackReturnTo(bad), undefined, `expected nothing for ${String(bad)}`);
  }
  // Round trip: what the panel writes is what the callback accepts.
  const written = new URL(ssoCallbackPath(path), 'https://app.deerdawn.com').searchParams.get('return_to');
  assert.equal(ssoCallbackReturnTo(written), path);
});

test('the consent panel starts Google from signUp, with the metadata and the named callback', () => {
  // unsafeMetadata is a sign-up parameter; SignIn.authenticateWithRedirect
  // drops it silently, which is how Google signups here arrived unattributed.
  const panel = readFileSync(path.resolve(here, '../components/AuthorizeSignInPanel.tsx'), 'utf8');
  assert.match(panel, /signUp\.authenticateWithRedirect\(/);
  assert.doesNotMatch(panel, /signIn\.authenticateWithRedirect\(/);
  assert.match(panel, /unsafeMetadata: signupContext\(returnUrl\)/);
  assert.match(panel, /redirectUrl: callbackPath/);

  const callback = readFileSync(path.resolve(here, '../pages/oauth/sso-callback.tsx'), 'utf8');
  assert.match(callback, /signInForceRedirectUrl: returnTo, signUpForceRedirectUrl: returnTo/);
});

function memoryStore() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
}

test('a Google sign-up started on an authorize screen comes back to that request (E-030)', () => {
  const store = memoryStore();
  const path = '/oauth/consent?req=4977d0b5813c7999452eddc8fa4f6db3';
  assert.equal(rememberAuthorizeReturn(store, path, 1_000), true);
  assert.equal(takeAuthorizeReturn(store, 1_000 + 60_000), path);
  // Consumed exactly once: a later, unrelated Google sign-up is not steered.
  assert.equal(takeAuthorizeReturn(store, 1_000 + 61_000), null);
  assert.equal(store.map.size, 0);
});

test('the device-code screen is carried the same way', () => {
  const store = memoryStore();
  assert.equal(rememberAuthorizeReturn(store, '/mcp-auth?code=ABCD-EFGH', 0), true);
  assert.equal(takeAuthorizeReturn(store, 5), '/mcp-auth?code=ABCD-EFGH');
});

test('a remembered request expires with the request itself', () => {
  const store = memoryStore();
  rememberAuthorizeReturn(store, '/oauth/consent?req=abc', 0);
  assert.equal(takeAuthorizeReturn(store, AUTHORIZE_RETURN_TTL_MS + 1), null);
  assert.equal(store.map.size, 0, 'a stale entry is still removed');
});

test('only a same-origin authorize path carrying a request is ever a target', () => {
  for (const bad of [
    '/select-plan',
    '/oauth/consent',
    '/oauth/consent?',
    '//evil.example/oauth/consent?req=1',
    'https://evil.example/oauth/consent?req=1',
    '/oauth/consentx?req=1',
    '/mcp-auth-evil?code=1',
    '',
    null,
  ]) {
    assert.equal(isAuthorizeRequestPath(bad), false, String(bad));
  }
  const store = memoryStore();
  store.setItem(AUTHORIZE_RETURN_KEY, JSON.stringify({ path: '//evil.example/x?y', at: 0 }));
  assert.equal(takeAuthorizeReturn(store, 1), null, 'a tampered entry is refused on the way out too');
  store.setItem(AUTHORIZE_RETURN_KEY, 'not json');
  assert.equal(takeAuthorizeReturn(store, 1), null);
});

test('storage that throws never breaks the sign-in', () => {
  const throwing = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
  };
  assert.equal(rememberAuthorizeReturn(throwing, '/oauth/consent?req=1', 0), false);
  assert.equal(takeAuthorizeReturn(throwing, 0), null);
  assert.equal(takeAuthorizeReturn(null, 0), null);
});

test('the sign-up leg of the Google callback no longer defaults an authorize arrival to the plan picker', () => {
  const callback = readFileSync(path.resolve(here, '../pages/oauth/sso-callback.tsx'), 'utf8');
  const panel = readFileSync(path.resolve(here, '../components/AuthorizeSignInPanel.tsx'), 'utf8');
  assert.match(callback, /takeAuthorizeReturn\(/, 'the callback must consume the remembered request');
  assert.match(callback, /signUpForceRedirectUrl: returnTo/, 'the sign-up leg must be forced back to the request');
  assert.match(callback, /fromUrl \|\| fromStorage/, 'the callback URL wins, sessionStorage is the fallback');
  assert.match(panel, /rememberAuthorizeReturn\(/, 'the Google button must remember the request before leaving');
});

test('the Google callback is not behind the signed-in guard it exists to satisfy', () => {
  // THE DEFECT. _app wrapped /oauth/sso-callback in AuthProvider, which sends a
  // signed-out browser to /login?redirect_url=... before children mount. The
  // callback page is reached signed out by definition, so Clerk never finished
  // and every Google attempt that needed the callback looped back to /login.
  const app = readFileSync(path.resolve(here, '../pages/_app.tsx'), 'utf8');
  const line = app.split('\n').find((l) => l.includes('const isAuthPage ='));
  assert.ok(line, 'isAuthPage must exist');
  assert.match(line!, /\/oauth\/sso-callback/, 'the callback must render outside AuthProvider');
  assert.match(app, /isAuthPage \|\| isDevPreview \? content : <AuthProvider>/, 'isAuthPage must still be what skips AuthProvider');
});
