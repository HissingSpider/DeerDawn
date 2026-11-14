/**
 * Authorize-step sign-in contracts (2026-08-28) — see docs/growth/EXPERIMENTS.md
 * E-011 and E-012.
 *
 * The measured defect: over 2026-08-07..08-27, every `oauth_consent_viewed`
 * carrying `signed_in=1` was followed by `oauth_consent_approved` within five
 * seconds (15 of 15), and none of the five carrying `signed_in=0` ever approved.
 * Not one of those five even pressed Connect — `oauth_consent_signin_required`
 * fires on that click and has zero events in 90 days.
 *
 * Both authorize pages rendered a primary Connect button to a browser they had
 * already determined had no session, and the only real affordance was a 13px
 * pill whose redirect lands on the dashboard root, dropping the ?code= / ?req=
 * the authorization needs. These assertions pin the three things that make the
 * fix work, because each of them is invisible in review and silent at runtime:
 * the Connect button is gated on a RESOLVED and SIGNED-IN session, the sign-in
 * carries this page's own URL through the round trip, and the return event on
 * the connect step only counts a real absence.
 *
 * Run: `node --test tests/authorize-signin-contract.test.js` (wired into `npm test`).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.resolve(root, rel), 'utf8');

const PAGES = [
  ['/mcp-auth', 'src/pages/mcp-auth.tsx'],
  ['/oauth/consent', 'src/pages/oauth/consent.tsx'],
];
// Source-text assertions have to be comment-blind, or a comment that merely
// DESCRIBES the fix satisfies the test that is supposed to pin the fix.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const app = read('src/pages/_app.tsx');
const panel = read('src/components/AuthorizeSignInPanel.tsx');
const events = read('src/lib/analyticsEvents.ts');
const onboarding = read('src/pages/onboarding.tsx');

for (const [route, file] of PAGES) {
  const src = read(file);

  test(`${route}: Connect is gated on a resolved, signed-in session`, () => {
    // Assert the PROPERTY, not one exact expression. The first version of this
    // pinned the literal `{sessionResolved && isSignedIn && status === 'idle' && (`
    // and went red on 2026-08-28 the moment a second, unrelated gate
    // (`detailsStatus`) was added to the same branch — the session guard was
    // still present, in every branch, and the string had simply grown. A test
    // that fails when correct code is extended teaches people to delete it.
    //
    // This is also stricter than what it replaces: it checks EVERY idle render
    // branch, where the old one only proved that at least one guarded branch
    // existed somewhere in the file.
    const idleBranches = [...src.matchAll(/\{([^{}]*status === 'idle'[^{}]*?)&& \(/g)].map((m) => m[1]);
    assert.ok(
      idleBranches.length > 0,
      `${file} has no idle render branch at all — has the page been restructured?`,
    );
    for (const condition of idleBranches) {
      assert.ok(
        /sessionResolved\s*&&/.test(condition) && /isSignedIn/.test(condition),
        `${file} renders an idle branch without resolving the session first: ` +
          `{${condition.trim()}...  — an unguarded idle branch is the original defect: ` +
          'a button that 401s, shown to everyone.',
      );
    }
  });

  test(`${route}: a signed-out arrival gets the sign-in panel, not a dead button`, () => {
    assert.match(
      src,
      /\{sessionResolved && !isSignedIn && status === 'idle' && \(\s*\n\s*<AuthorizeSignInPanel/,
      `${file} must render AuthorizeSignInPanel for a resolved signed-out session`,
    );
    assert.match(
      src,
      new RegExp(`<AuthorizeSignInPanel surface=\\{SURFACE\\} path="${route.replace('/', '\\/')}"`),
      `${file} must tag the panel with its own surface and route, or the two authorize ` +
        'flows collapse into one unreadable number',
    );
  });

  test(`${route}: a blocked Clerk script still leaves a way forward`, () => {
    assert.match(
      src,
      /setClerkTimedOut\(true\), 3000\)/,
      `${file} must fall through to the sign-in panel if Clerk never resolves`,
    );
    assert.match(src, /const sessionResolved = isLoaded \|\| clerkTimedOut;/, `${file}`);
  });

  // THE EMPTY PRERENDER (2026-08-28). /oauth/consent rendered inside <Layout>
  // and behind <AuthProvider>, which returns WorkspaceLoadingScreen until Clerk
  // answers — and during a static prerender Clerk never answers. So the built
  // HTML for the one page every remote-MCP connection has to pass through was a
  // logo and a spinner: zero characters of text and not even the page's own
  // <title>, with nothing to paint until Clerk had loaded and hydrated. Its
  // sibling /mcp-auth, already in the same list, prerendered its whole card.
  // The defect is an OMISSION FROM A LIST — invisible in review, silent at
  // runtime, and it survived three separate edits to this page — so pin both
  // routes rather than the one that happened to be missing.
  test(`${route}: renders standalone, outside the dashboard shell and AuthProvider`, () => {
    const isAuthPageLine = stripComments(app)
      .split('\n')
      .find((line) => line.includes('const isAuthPage ='));
    assert.ok(
      isAuthPageLine,
      "_app.tsx no longer declares isAuthPage — has the shell routing moved?",
    );
    assert.ok(
      isAuthPageLine.includes(`startsWith('${route}')`),
      `${route} is missing from _app's isAuthPage list, so it renders inside <Layout> and ` +
        'behind <AuthProvider>. AuthProvider shows WorkspaceLoadingScreen until Clerk resolves, ' +
        'which on the server is never: the route then prerenders to a spinner with no text and ' +
        'no <title>, and its LCP waits on the Clerk script.',
    );
  });

  test(`${route}: no longer asks the user to sign in in another tab`, () => {
    assert.doesNotMatch(
      src,
      /come back to this tab|Sign in<\/strong> button in the top-right/,
      `${file} still carries the manual cross-tab recovery. Nobody completed it in 90 days: ` +
        'the round trip loses the authorization request, which is the whole reason they are here.',
    );
  });
}

test('the sign-in carries THIS page back, not the dashboard root', () => {
  assert.match(
    panel,
    /setReturnUrl\(window\.location\.href\)/,
    'the return target must be this page\'s own URL — the ?code= / ?req= is the request itself',
  );
  assert.match(
    panel,
    /forceRedirectUrl=\{returnUrl\}/,
    'Clerk must be told where to come back to; without it the satellite sign-in lands on /',
  );
  assert.match(
    panel,
    /signUpForceRedirectUrl=\{returnUrl\}/,
    'a signed-out arrival with no account signs UP, and that path needs the same return target',
  );
});

test('a signed-out arrival is offered account creation, not only sign-in', () => {
  // 2026-09-16: most signed-out arrivals have no account; "Sign in to continue"
  // alone read as a dead end. Google creates or signs in with one call and must
  // come back to this exact request.
  const code = stripComments(panel);
  assert.match(code, /strategy: 'oauth_google'/);
  assert.match(code, /redirectUrlComplete: returnUrl/, 'Google must return to this request, not a default');
  // The email sign-up is a LINK carrying ?redirect_url, not Clerk's
  // <SignUpButton mode="redirect">. The button put the return target in the URL
  // HASH, and every hop after it is server-side: dashboard /signup redirects to
  // marketing /signup from getServerSideProps (query only), and marketing reads
  // `redirect_url` off the query. So the hash was dropped and the new account —
  // the brand-new user who copied a connector URL — landed on /onboarding with
  // the ?req= / ?code= gone. Sign IN survives because dashboard /login renders
  // its own hash-reading page instead of redirecting.
  assert.match(code, /authorizeSignupPath\(window\.location\.href, window\.location\.origin\)/);
  assert.match(code, /href=\{signupHref\}/, 'the email sign-up must navigate to the built path');
  assert.doesNotMatch(
    code,
    /<SignUpButton/,
    'Clerk\'s redirect-mode sign-up carries the return target in the hash, which no hop on this chain can read',
  );
  assert.match(code, /Sign in to continue/, 'existing accounts keep a way in');
});

test('the sign-up path carries this request as a QUERY parameter the whole way', (t) => {
  // Each hop, read in the code rather than assumed:
  //   1. the panel builds /signup?redirect_url=/oauth/consent?req=... (above);
  //   2. dashboard /signup forwards its WHOLE query to the marketing sign-up;
  //   3. marketing /signup resolves ?redirect_url back to an app URL;
  //   4. the verification step navigates to it.
  const dashSignup = stripComments(read('src/pages/signup.tsx'));
  assert.match(
    dashSignup,
    /Object\.entries\(context\.query\)\.forEach/,
    'the server-side redirect to marketing must forward every query key, redirect_url included',
  );
  assert.match(
    dashSignup,
    /resolveAuthReturnPath\(/,
    'the client-rendered branch must honour the same return target',
  );

  // Hops 3 and 4 live in apps/marketing, which only the private repo has (the
  // public export does not ship it); there, the dashboard half above is all
  // that can be checked.
  const marketingRoot = path.resolve(__dirname, '..', '..', 'marketing');
  if (!fs.existsSync(marketingRoot)) {
    t.skip('apps/marketing is not in this checkout (private repo only)');
    return;
  }
  const marketingSignup = stripComments(fs.readFileSync(path.join(marketingRoot, 'src/pages/signup.tsx'), 'utf8'));
  assert.match(marketingSignup, /resolveAppReturnPath\(q\.redirect_url/, 'marketing must read ?redirect_url');
  assert.match(marketingSignup, /returnTo/, 'and hand it to the form as the place to come back to');

  const form = stripComments(fs.readFileSync(path.join(marketingRoot, 'src/components/MarketingAuthForm.tsx'), 'utf8'));
  assert.match(
    form,
    /if \(returnTo\) return `\$\{env\.ACTIVE_APP_URL\}\$\{returnTo\}`/,
    'returnTo must win over the /onboarding default',
  );
  assert.match(
    form,
    /window\.location\.href = signupRedirectUrl/,
    'and email verification must finish by navigating there',
  );
});

test('the corner Sign in pill carries the request too', () => {
  // The pill moved into the one badge both pages share (2026-09), so it is pinned
  // there, and each page is pinned to rendering that badge rather than a copy.
  const badge = stripComments(read('src/components/AuthorizeAccountBadge.tsx'));
  assert.match(badge, /<SignInButton mode="redirect" forceRedirectUrl=\{here\}/, 'the pill must not drop ?code= / ?req=');
  assert.match(badge, /signUpForceRedirectUrl=\{here\}/, 'a pill click that ends in sign-UP needs the same return target');
  for (const [route, file] of PAGES) {
    const code = stripComments(read(file));
    assert.match(
      code,
      new RegExp(`<AuthorizeAccountBadge surface=\\{SURFACE\\} path="${route.replace('/', '\\/')}"`),
      `${file} must render the shared badge, tagged with its own route`,
    );
  }
});

test('/login and /signup honour the absolute return URL Clerk hands them', () => {
  for (const file of ['src/pages/login.tsx', 'src/pages/signup.tsx']) {
    assert.match(stripComments(read(file)), /resolveAuthReturnPath\(/, `${file} must resolve Clerk's absolute force-redirect URL`);
  }
});

test('both new authorize events are declared, and referenced by constant', () => {
  assert.match(events, /oauthConsentSigninShown: 'oauth_consent_signin_shown'/);
  assert.match(events, /oauthConsentSigninClicked: 'oauth_consent_signin_clicked'/);
  assert.match(panel, /PRODUCT_EVENTS\.oauthConsentSigninShown/);
  assert.match(panel, /PRODUCT_EVENTS\.oauthConsentSigninClicked/);
  assert.doesNotMatch(
    panel,
    /'oauth_consent_signin_(shown|clicked)'/,
    'hand-typed event names drift; analyticsEvents.ts is the one place they are spelled',
  );
});

test('connect_step_returned counts a real absence, not the browser settling', () => {
  // E-020 (2026-09-04) moved this test out of an inline `awayMs >= 2000` and into
  // lib/connectReturn.ts, because adjudicating E-012 showed the away LENGTH was
  // only half the question: 3 of its 4 events were blur/focus pairs thrown while
  // the page was still settling, and every one of them cleared two seconds. The
  // invariant this line has always protected — an absence must be established
  // before it counts — is unchanged and is now tested as logic against those four
  // real events in src/lib/connectReturn.test.ts, rather than as source text.
  assert.match(
    onboarding,
    /if\s*\(isRealReturn\(/,
    'without the guard a focus event with no preceding blur counts as a return, and the ' +
      'return rate reads 100% by construction',
  );
  assert.match(
    onboarding,
    /seconds_since_mount:/,
    'the departure’s position in the step is what separates a return from load-time churn',
  );
  assert.match(
    onboarding,
    /window\.addEventListener\('blur', markAway\)/,
    'the departure half is what makes away_seconds meaningful; blur covers leaving for another app',
  );
  assert.match(
    onboarding,
    /window\.removeEventListener\('blur', markAway\)/,
    'the blur listener must be torn down with the rest, or it leaks across steps',
  );
  assert.match(onboarding, /'connect_step_returned'/);
  assert.match(
    onboarding,
    /status_on_return: statusRef\.current/,
    'a closed-over status would report "waiting" forever; the ref is what makes the field true',
  );
});

// THE CALLBACK THAT COULD NOT RUN (2026-09-26, E-031; fix shipped in #561). /oauth/sso-callback is
// where Google hands control back to Clerk, and whenever Clerk still has
// client-side work to do (a sign-up transfer, linking Google to an existing
// password account, a verification step) the browser arrives there SIGNED OUT.
// Behind AuthProvider a signed-out arrival is replaced to /login before any child
// mounts, so <AuthenticateWithRedirectCallback> never ran: 12 of 12 recorded
// callback pageviews in 60 days were followed within two seconds by
// /login?redirect_url=%2Foauth%2Fsso-callback, and the authorize request the
// panel passed as redirectUrlComplete was lost with it. Same omission-from-a-list
// class as the /oauth/consent prerender above, so it is pinned the same way.
test('/oauth/sso-callback: renders outside AuthProvider, so a signed-out return can finish', () => {
  const isAuthPageLine = stripComments(app)
    .split('\n')
    .find((line) => line.includes('const isAuthPage ='));
  assert.ok(isAuthPageLine, '_app.tsx no longer declares isAuthPage — has the shell routing moved?');
  assert.ok(
    // Either form admits the page; #561 shipped the exact match.
    /startsWith\('\/oauth\/sso-callback'\)|===\s*'\/oauth\/sso-callback'/.test(isAuthPageLine),
    '/oauth/sso-callback is missing from _app\'s isAuthPage list. AuthProvider will replace a ' +
      'signed-out arrival to /login before the Clerk callback mounts, so any Google sign-in that ' +
      'needs client-side completion bounces to /login and loses its redirect.',
  );
  const callback = stripComments(read('src/pages/oauth/sso-callback.tsx'));
  assert.match(
    callback,
    /<AuthenticateWithRedirectCallback/,
    'the callback page must still render the Clerk callback component',
  );
});
