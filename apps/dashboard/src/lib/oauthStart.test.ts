/**
 * The "Continue with Google" decision on the dashboard, tested with no Clerk,
 * no browser, no network.
 *
 * This suite exists because the marketing copy of it did not stop the bug: #361
 * shipped the guard on deerdawn.com and left app.deerdawn.com calling
 * authenticateWithRedirect unguarded, and its regression test asserted only that
 * this app still had an `isAlreadySignedInError` catch — the one shape of
 * Clerk's refusal that a catch can never see. A user hit the raw
 * `authorization_invalid` JSON page on 2026-08-28 as a result.
 *
 * MIRROR of apps/marketing/tests/oauth-start.test.ts, pinned to it by
 * apps/marketing/tests/auth-already-signed-in.test.js. Colocated because the
 * dashboard's runner globs `src/lib/*.test.ts` and marketing's globs `tests/`,
 * which is the only reason the two files sit in different places.
 */
import test from 'node:test';
import assert from 'node:assert';
import { resolveOAuthStart } from './oauthStart';

const urls = { loginRedirectUrl: '/app/login-done', signupRedirectUrl: '/app/signup-done' };

test('an existing session never starts an OAuth attempt', () => {
  // The original bug: Clerk rejects OAuth against a live session, and when it
  // rejects server-side the user lands on a raw JSON page nothing can catch.
  for (const isSignup of [true, false]) {
    const result = resolveOAuthStart({ isSignedIn: true, isSignup, ...urls });
    assert.strictEqual(result.action, 'confirm',
      'must not start OAuth for a signed-in user');
  }
});

test('a signed-out user gets the normal OAuth flow', () => {
  assert.deepStrictEqual(
    resolveOAuthStart({ isSignedIn: false, isSignup: false, ...urls }),
    { action: 'oauth' },
  );
});

test('Clerk still loading is treated as signed out, not signed in', () => {
  // isSignedIn is undefined until Clerk hydrates. Guessing "signed in" would ask
  // a genuinely signed-out user which account they meant. handleGoogle
  // additionally refuses to run at all until authLoaded, so this default is the
  // second line of defence rather than the first.
  assert.deepStrictEqual(
    resolveOAuthStart({ isSignedIn: undefined, isSignup: false, ...urls }),
    { action: 'oauth' },
  );
});

test('the prompt names the account, because not naming it IS the bug', () => {
  // 2026-08-28: signed in as the openai-review test account, clicked Continue
  // with Google to reach a real Google account, and #368 would have dropped them
  // back into the review account's dashboard silently. The address is the one
  // piece of information that makes that legible.
  const result = resolveOAuthStart({
    isSignedIn: true,
    isSignup: false,
    identity: 'openai-review-20260809-8eaab8@deerdawn.com',
    ...urls,
  });
  assert.strictEqual(result.action, 'confirm');
  if (result.action !== 'confirm') return;
  assert.strictEqual(result.identity, 'openai-review-20260809-8eaab8@deerdawn.com');
  assert.match(result.prompt, /openai-review-20260809-8eaab8@deerdawn\.com/);
  assert.match(result.continueLabel, /openai-review-20260809-8eaab8@deerdawn\.com/);
  assert.match(result.switchLabel, /different Google account/i);
});

test('an unknown identity still asks, with copy that has no hole in it', () => {
  // Clerk can report a session before the user object resolves. Falling back to
  // a silent redirect here would reintroduce the bug for exactly the sessions we
  // understand least; printing an empty string would be worse.
  for (const identity of [undefined, null, '', '   ']) {
    const result = resolveOAuthStart({ isSignedIn: true, isSignup: false, identity, ...urls });
    assert.strictEqual(result.action, 'confirm', `identity ${JSON.stringify(identity)} must still ask`);
    if (result.action !== 'confirm') continue;
    assert.strictEqual(result.identity, undefined);
    assert.ok(!/\s{2,}|as \.|as$/.test(result.prompt), `copy has a hole: ${result.prompt}`);
    assert.ok(result.continueLabel.trim().length > 0);
  }
});

test('the continue branch respects signup vs login intent', () => {
  // The pre-#369 behaviour, preserved exactly — it was never the wrong
  // destination, it was only ever wrong to go there WITHOUT asking.
  const signup = resolveOAuthStart({ isSignedIn: true, isSignup: true, ...urls });
  const login = resolveOAuthStart({ isSignedIn: true, isSignup: false, ...urls });
  assert.strictEqual(signup.action === 'confirm' && signup.continueUrl, '/app/signup-done');
  assert.strictEqual(login.action === 'confirm' && login.continueUrl, '/app/login-done');
});

test('answering "different account" switches rather than redirecting', () => {
  // The email path's resolution — signOut then retry — reached only once the
  // user has said that is what they meant. Both intents, since the signal is
  // about identity and not about which form they are on.
  for (const isSignup of [true, false]) {
    assert.deepStrictEqual(
      resolveOAuthStart({ isSignedIn: true, isSignup, confirmedSwitch: true, identity: 'a@b.com', ...urls }),
      { action: 'switch' },
    );
  }
});

test('a switch confirmed after the session has already gone skips the sign-out', () => {
  // Signed out in another tab between the question and the answer. Calling
  // signOut() on no session is a pointless round trip at best; the ordering
  // inside resolveOAuthStart makes it unreachable.
  assert.deepStrictEqual(
    resolveOAuthStart({ isSignedIn: false, isSignup: false, confirmedSwitch: true, ...urls }),
    { action: 'oauth' },
  );
});

test('confirmedSwitch is opt-in — nothing else may be read as an answer', () => {
  // The flag is threaded from a click handler as an ARGUMENT (setState is not
  // synchronous, so a state flag would be read stale and re-ask forever).
  // Anything falsy, and the MouseEvent that a bare `onClick={handleGoogle}`
  // would pass, has to mean "not answered yet" rather than "yes, sign me out".
  for (const confirmedSwitch of [undefined, false, null as unknown as boolean, {} as unknown as boolean]) {
    assert.strictEqual(
      resolveOAuthStart({ isSignedIn: true, isSignup: false, confirmedSwitch, ...urls }).action,
      'confirm',
      `${JSON.stringify(confirmedSwitch)} must not be read as a confirmed switch`,
    );
  }
});
