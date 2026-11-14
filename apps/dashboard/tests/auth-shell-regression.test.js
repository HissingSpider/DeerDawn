const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

// Source-text assertions have to be comment-blind, or a comment that merely
// DESCRIBES the fix satisfies the test that is supposed to pin the fix.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    process.exitCode = 1;
  }
}

console.log('=== Dashboard Auth Shell Regression Tests ===\n');

const appFile = read('src/pages/_app.tsx');
const documentFile = read('src/pages/_document.tsx');
const authShellFile = read('src/components/AuthShell.tsx');
const buttonFile = read('src/components/ui/Button.tsx');
const clerkAuthPageFile = read('src/components/ClerkAuthPage.tsx');
const globalsFile = read('src/styles/globals.css');
const apiFile = read('src/lib/api.ts');
const middlewareFile = read('src/middleware.ts');
const nextConfigFile = read('next.config.ts');
const dashboardApiAuthFile = read('src/pages/api/_auth.ts');

test('dashboard document should emit noindex meta for all app pages', () => {
  assert(
    documentFile.includes('<meta name="robots" content="noindex,nofollow" />'),
    'dashboard document is missing a global noindex meta tag'
  );
});

test('public auth pages should not be wrapped by AuthProvider', () => {
  // Pins the INTENT, not one spelling of it. The original assertion matched the
  // exact ternary text, so adding a second legitimately-bare route (the /dev/
  // previews, which must skip AuthProvider or they spin on a bootstrap fetch
  // forever) failed a test whose subject had not changed. Match the shape:
  // whatever the bare-render condition is, it must include isAuthPage, and the
  // else-branch must still be AuthProvider.
  const branch = stripComments(appFile).match(
    /\{([^?}]*isAuthPage[^?}]*)\?\s*content\s*:\s*<AuthProvider>\{content\}<\/AuthProvider>\}/
  );
  assert(branch, 'public auth pages are still gated behind AuthProvider');
  assert(
    /\bisAuthPage\b/.test(branch[1]),
    'the bare-render branch no longer covers public auth pages'
  );
});

// The Clerk branch decides AuthProvider separately from the `page` condition
// that decides Layout, so every bare-render exemption is written twice and the
// second copy is the one that gets forgotten. #422 added isDevPreview there;
// before it the /dev/ harness spun on AuthProvider's bootstrap fetch under the
// local default (NEXT_PUBLIC_AUTH_MODE=clerk).
test('dev previews should not be wrapped by AuthProvider on the Clerk branch', () => {
  const branch = stripComments(appFile).match(
    /\{([^?}]*)\?\s*content\s*:\s*<AuthProvider>\{content\}<\/AuthProvider>\}/
  );
  assert(branch, 'could not locate the Clerk branch AuthProvider condition in _app.tsx');
  assert(
    /\bisDevPreview\b/.test(branch[1]),
    'dev component previews are gated behind AuthProvider on the Clerk branch'
  );
});

// Both halves of the /dev/ bypass are dev-only, and neither guard is implied by
// the other. isDevPreview is gated on NODE_ENV (Next inlines it at build time,
// so the bypass is dead code in a production bundle), and each preview page
// 404s itself server-side. The readdir means a preview added later without its
// own getServerSideProps fails here instead of shipping reachable.
test('dev previews must stay unreachable in production', () => {
  const source = stripComments(appFile);
  assert(
    /const isDevPreview =\s*process\.env\.NODE_ENV !== 'production' &&/.test(source),
    'isDevPreview is no longer gated on NODE_ENV, so the AuthProvider bypass would apply in production'
  );

  const previews = fs.readdirSync(path.join(root, 'src/pages/dev')).filter((f) => /\.tsx$/.test(f));
  assert(previews.length > 0, 'no /dev/ preview pages found — has the harness moved?');
  for (const file of previews) {
    const page = stripComments(read(path.join('src/pages/dev', file)));
    assert(
      /export async function getServerSideProps/.test(page) &&
        /process\.env\.NODE_ENV === 'production'/.test(page) &&
        /notFound: true/.test(page),
      `src/pages/dev/${file} does not 404 itself in production`
    );
  }
});

test('auth shell should use dashboard surface tokens with readable copy', () => {
  assert(
    authShellFile.includes('bg-surface') &&
      authShellFile.includes('border-border') &&
      authShellFile.includes('text-text-secondary') &&
      !authShellFile.includes('tracking-[-'),
    'auth shell should use dashboard surface/text tokens and avoid over-tight auth heading typography'
  );
});

test('primary disabled buttons should remain legible on dark auth screens', () => {
  // Scoped to the PRIMARY variant line. A whole-file grep for
  // disabled:opacity-50 also matched the `danger` variant — a transparent
  // red-text button that never appears on an auth screen — so the check failed
  // on something it was never about.
  const primaryLine = buttonFile
    .split('\n')
    .find((line) => /^\s*primary:/.test(line));
  assert(primaryLine, 'could not locate the primary button variant in Button.tsx');
  assert(
    primaryLine.includes('disabled:bg-surface-hover') &&
      primaryLine.includes('disabled:text-text-secondary') &&
      !primaryLine.includes('disabled:opacity-50'),
    'disabled primary buttons should not fade dark text into the dark auth background'
  );
});

test('dashboard global reset should not override Tailwind utility spacing or button backgrounds', () => {
  assert(
    !globalsFile.includes('padding: 0;') &&
      !globalsFile.includes('button {\n  background: none;') &&
      !globalsFile.includes('border: none;'),
    'dashboard global reset should not erase Tailwind padding, borders, or button backgrounds'
  );
});

test('Clerk auth form labels should use the dashboard form style', () => {
  assert(
    clerkAuthPageFile.includes('dashboard-eyebrow block') &&
      clerkAuthPageFile.includes('dashboard-input'),
    'Clerk auth form should use dashboard label and input styles'
  );
});

test('Clerk auth should sign in with a password and not the email_code flow', () => {
  assert(
    clerkAuthPageFile.includes('signIn!.create({ identifier, password })') &&
      // The field gained a show/hide toggle, so the type is now an expression
      // rather than the literal type="password".
      /type=\{showPassword \? 'text' : 'password'\}|type="password"/.test(clerkAuthPageFile),
    'Clerk auth page should use password sign-in'
  );

  // This used to assert the file contained no 'email_code' at all. That was a
  // proxy for the real rule — SIGN-IN is password-based, not a passwordless
  // emailed code — and it stopped being a safe proxy on 2026-08-26, when email
  // verification was enabled at the Clerk instance and SIGN-UP legitimately
  // needed email_code to confirm a new address. Pin the intent instead of the
  // substring: every use must belong to the signUp verification calls.
  const emailCodeLines = clerkAuthPageFile.match(/^.*email_code.*$/gm) || [];
  assert(
    emailCodeLines.every((line) => line.includes('EmailAddressVerification')),
    'email_code may only appear in signUp email verification, never in the sign-in flow'
  );
});

test('dashboard API client should use the Clerk token bridge before bootstrap calls', () => {
  assert(
    apiFile.includes("import { resolveRuntimeAuthToken } from './authToken'") &&
      apiFile.includes('const bridgedToken = await resolveRuntimeAuthToken()') &&
      apiFile.indexOf('const bridgedToken = await resolveRuntimeAuthToken()') < apiFile.indexOf('const clerk = (window as typeof window'),
    'dashboard API client should prefer the React Clerk token bridge before reading window.Clerk.session'
  );
});

test('dashboard setup fallback should stay on the dashboard host and allow the local bridge', () => {
  assert(
    // Status no longer calls a fallback route at all (it could only answer a
    // constant "unavailable" and 401'd on every load); apply still does.
    !apiFile.includes("fetchDashboardRoute('/api/setup-status')") &&
      apiFile.includes("'local_setup_unavailable'") &&
      apiFile.includes("fetchDashboardRoute('/api/setup-apply'") &&
      !apiFile.includes("fetchAPI('/api/setup-status'") &&
      nextConfigFile.includes('http://127.0.0.1:41338'),
    'dashboard setup fallback should not call api.deerdawn.com/api/setup-status and CSP should allow the local setup bridge'
  );
});

test('Clerk middleware should not 500 local builds without a secret key', () => {
  assert(
    middlewareFile.includes('process.env.CLERK_SECRET_KEY') &&
      middlewareFile.includes('NextResponse.next()'),
    'dashboard Clerk middleware should pass through when CLERK_SECRET_KEY is absent'
  );
});

test('dashboard API auth routes should be covered by Clerk middleware and degrade to 401', () => {
  assert(
    middlewareFile.includes("'/api/:path*'") &&
      dashboardApiAuthFile.includes('try {') &&
      dashboardApiAuthFile.includes('clerkAuth = getAuth(req)') &&
      dashboardApiAuthFile.includes("res.status(401).json({ error: 'unauthorized'"),
    'dashboard API auth should run Clerk middleware for API routes and avoid raw 500s when Clerk context is unavailable'
  );
});

// A dropped connection kills Clerk's token fetch, the call then goes out with no
// Authorization header, and the API can only answer 401 — a 401 that says
// nothing about the session. Gating the retry on `Clerk.session` alone means the
// one case that most needs a retry (Clerk never loaded, so there IS no session
// object) is the one case that never gets one, and the page dead-ends.
test('a 401 caused by a failed token fetch should still be retried once', () => {
  const source = stripComments(apiFile);
  assert(
    source.includes('tokenFetchFailed = true') &&
      source.includes('hasLiveSession || tokenFetchFailed') &&
      source.includes('!retryAttempted'),
    'fetchAPI should retry a 401 when the auth token fetch itself failed, and still retry at most once'
  );
});

// THE SIGN-IN LOOP (2026-08-28, hit in production).
//
// The dashboard sent the reader to /login on any bootstrap 401, believing a 401
// meant the session had died. /login sent them straight back whenever Clerk
// reported isSignedIn. Each half is defensible alone; together they close a
// cycle for any 401 whose cause is NOT a dead session — in the observed case, a
// failed token fetch meaning no Authorization header was ever sent, so the
// server was never even asked about the session. The reader sees "session
// expired", signs in, and Clerk answers a raw authorization_invalid page
// because they were signed in the whole time.
//
// Three things have to hold for the cycle to stay open, so all three are pinned.
test('a 401 with no token sent must not be reported as an expired session', () => {
  const source = stripComments(apiFile);
  assert(
    source.includes("'auth_token_unavailable'") && source.includes('!headers.Authorization'),
    'api.ts no longer distinguishes "we sent no token" from "the server rejected our token"'
  );
});

test('an unverifiable sign-in offers a retry, not another sign-in', () => {
  const bootstrap = stripComments(read('src/components/dashboard/DashboardBootstrapProvider.tsx'));
  assert(
    bootstrap.includes("error.code === 'auth_token_unavailable'"),
    'the bootstrap error state no longer special-cases a tokenless 401'
  );
  const branch = bootstrap.slice(bootstrap.indexOf("error.code === 'auth_token_unavailable'"));
  const untilNextBranch = branch.slice(0, branch.indexOf('if (error.status === 401'));
  assert(
    untilNextBranch.includes("primaryLabel: 'Retry'") && !untilNextBranch.includes('Go to sign in'),
    'a tokenless 401 still routes the reader to sign-in, which is what closes the loop'
  );
});

test('the login page must not bounce a signed-in reader back indefinitely', () => {
  const login = stripComments(read('src/components/ClerkAuthPage.tsx'));
  assert(login.includes('recordAuthBounce'), 'no bounce counter — the redirect is unconditional again');
  assert(
    login.includes('BOUNCE_LIMIT') && login.includes('setLoopDetected(true)'),
    'the bounce counter no longer stops the cycle'
  );
  assert(
    login.includes('signOut('),
    'the loop recovery must offer a real sign-out — re-signing-in cannot clear a session that is already live'
  );
});

if (process.exitCode) {
  console.error('\nDashboard auth shell regressions detected.');
} else {
  console.log('\nDashboard auth shell contracts in place.');
}
