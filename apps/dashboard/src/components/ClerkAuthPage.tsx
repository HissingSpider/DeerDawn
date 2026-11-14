import { useRouter } from 'next/router';
import Link from 'next/link';
import { useState, useEffect, useMemo, useRef } from 'react';
import { useSignIn, useSignUp, useUser } from '@clerk/nextjs';
import AuthShell from '@/components/AuthShell';
import { Button } from '@/components/ui/Button';
import { markSignupPending, gaEvent } from '@/lib/gtag';
import { trackRedditSignup } from '@/lib/reddit';
import { trackProductEvent } from '@/lib/productAnalytics';
import { PRODUCT_EVENTS } from '@/lib/analyticsEvents';
import { signupContext } from '@/lib/signupContext';
import { ssoCallbackPath } from '@/lib/authorizeFlow';
import { authQueryWithClerkHash, getSafeRedirectPath } from '@/lib/redirects';
import { resolveOAuthStart } from '@/lib/oauthStart';
import type { OAuthAccountPrompt } from '@/lib/oauthStart';
import { useSafeSignOut } from '@/lib/useSafeSignOut';

// ─── Redirect-loop breaker ────────────────────────────────────────────────────
//
// The dashboard sends a reader here whenever its bootstrap 401s, on the
// assumption that a 401 means the session died. This page sends them straight
// back whenever Clerk says they are signed in. Both are reasonable alone; when a
// 401 has any cause OTHER than a dead session — most often that we could not get
// a token to send at all — they form a closed cycle the reader cannot escape,
// with no error of their own in it.
//
// api.ts now labels that specific 401 so the dashboard offers a retry instead of
// a sign-in, which fixes the known cause. This is the backstop for the unknown
// ones: count the bounces, and once it is clearly a cycle, stop participating
// and hand over the one action that actually clears a stuck session.
const BOUNCE_KEY = 'dd_auth_bounce';
const BOUNCE_WINDOW_MS = 30_000;
const BOUNCE_LIMIT = 2;

function recordAuthBounce(): number {
  if (typeof window === 'undefined') return 1;
  try {
    const now = Date.now();
    const previous = JSON.parse(sessionStorage.getItem(BOUNCE_KEY) || 'null');
    const withinWindow = previous && now - previous.first < BOUNCE_WINDOW_MS;
    const next = withinWindow
      ? { count: previous.count + 1, first: previous.first }
      : { count: 1, first: now };
    sessionStorage.setItem(BOUNCE_KEY, JSON.stringify(next));
    return next.count;
  } catch {
    // Private mode / blocked storage: never let the counter itself break login.
    return 1;
  }
}

export function clearAuthBounce() {
  if (typeof window === 'undefined') return;
  try { sessionStorage.removeItem(BOUNCE_KEY); } catch { /* storage may be unavailable */ }
}

interface ClerkAuthPageProps {
  initialMode: 'login' | 'signup';
  redirectUrl?: string;
  /** A validated same-origin path a sign-up must return to (an authorize screen). */
  returnTo?: string;
  accountType?: string;
  plan?: string;
  billing?: string;
  referralCode?: string;
  promotionCode?: string;
  campaign?: string;
}

// Mirror Clerk's default password policy so users get instant feedback instead
// of a round-trip rejection at setActive time. Keep in sync with the minimum
// length configured in the Clerk Dashboard.
const MIN_PASSWORD_LENGTH = 8;

export function ClerkAuthUnavailablePage() {
  return (
    <AuthShell
      mode="login"
      title="Sign-in unavailable"
      subtitle="Clerk is not configured for this dashboard environment."
      alternateAction={(
        <a href="https://deerdawn.com" className="font-medium text-text-secondary underline decoration-[color:var(--border-strong)] underline-offset-4 transition-colors hover:text-text-primary">
          Back to deerdawn.com
        </a>
      )}
    >
      <AuthMessage tone="info">
        Set the Clerk publishable key for this environment, then reload this page to sign in.
      </AuthMessage>
    </AuthShell>
  );
}

function formatClerkError(err: unknown) {
  const clerkErr = err as { errors?: { code?: string; message?: string; longMessage?: string }[]; message?: string };
  return clerkErr.errors?.[0]?.longMessage
    || clerkErr.errors?.[0]?.message
    || clerkErr.message
    || 'We could not complete authentication.';
}

function isAlreadySignedInError(err: unknown) {
  const clerkErr = err as { errors?: Array<{ code?: string; message?: string }>; status?: number };
  return Boolean(
    clerkErr.errors?.some((issue) => {
      const code = String(issue.code || '').toLowerCase();
      const text = String(issue.message || '').toLowerCase();
      return code.includes('session_exists') || code.includes('already_signed_in') || text.includes('already signed in');
    })
  );
}

function isExistingAccountError(err: unknown) {
  const clerkErr = err as { errors?: Array<{ code?: string; message?: string; longMessage?: string }> };
  return Boolean(clerkErr.errors?.some((issue) => {
    const code = String(issue.code || '').toLowerCase();
    const text = `${issue.message || ''} ${issue.longMessage || ''}`.toLowerCase();
    return code.includes('identifier') || code.includes('exists') || text.includes('already exists') || text.includes('already been taken');
  }));
}

function GoogleMark() {
  return (
    <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M23.52 12.27c0-.82-.07-1.6-.2-2.36H12v4.46h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.88c2.27-2.09 3.57-5.17 3.57-8.73z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.95-2.91l-3.88-3c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.27v3.1A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.27 14.28a7.2 7.2 0 0 1 0-4.56v-3.1H1.27a12 12 0 0 0 0 10.76l4-3.1z" />
      <path fill="#EA4335" d="M12 4.76c1.77 0 3.35.6 4.6 1.8l3.43-3.43A11.95 11.95 0 0 0 12 0 12 12 0 0 0 1.27 6.62l4 3.1C6.22 6.87 8.87 4.76 12 4.76z" />
    </svg>
  );
}

function AuthMessage({ children, tone = 'error', id }: { children: React.ReactNode; tone?: 'error' | 'info'; id?: string }) {
  return (
    <div
      id={id}
      role={tone === 'error' ? 'alert' : undefined}
      aria-live={tone === 'error' ? 'assertive' : undefined}
      className={`rounded-2xl border px-4 py-3 text-sm leading-6 ${
        tone === 'error'
          ? 'border-red-500/20 bg-red-500/10 text-text-secondary'
          : 'border-border-subtle bg-overlay-subtle text-text-secondary'
      }`}
    >
      {children}
    </div>
  );
}

export default function ClerkAuthPage({
  initialMode,
  redirectUrl,
  returnTo,
  accountType,
  plan,
  billing,
  referralCode,
  promotionCode,
  campaign,
}: ClerkAuthPageProps) {
  const router = useRouter();
  const { isLoaded: signInLoaded, signIn, setActive: setSignInActive } = useSignIn();
  const { isLoaded: signUpLoaded, signUp, setActive: setSignUpActive } = useSignUp();
  // useUser rather than useAuth because the guard below has to NAME the session
  // it found: "you are already signed in" without saying as whom is the bug
  // report, not the fix. useUser supplies isLoaded/isSignedIn too, so nothing is
  // lost by dropping useAuth.
  const { isLoaded: authLoaded, isSignedIn, user } = useUser();
  // useSafeSignOut rather than useClerk().signOut: same call, but it also
  // survives the dev/local case where no <ClerkProvider> is mounted.
  const signOut = useSafeSignOut();
  // #373's redirect-loop breaker. Kept as-is through this rebase.
  const [loopDetected, setLoopDetected] = useState(false);

  // Clerk's own label for the account, in the order a person would recognise it.
  // `undefined` is fine — resolveOAuthStart falls back to generic copy rather
  // than printing a blank where the address should be.
  const signedInIdentity = user?.primaryEmailAddress?.emailAddress
    || user?.emailAddresses?.[0]?.emailAddress
    || user?.fullName
    || undefined;

  // H10: sanitize the caller-supplied redirectUrl once, at the point of
  // consumption, so every navigation below (mount redirect, ticket exchange,
  // login, signup error recovery, and the Clerk OAuth redirectUrlComplete) is
  // covered by a single same-origin-relative-path check. See lib/redirects.ts.
  const safeRedirectUrl = useMemo(() => getSafeRedirectPath(redirectUrl), [redirectUrl]);

  // Set when "Continue with Google" is clicked against a live session. Holds the
  // question — which account did you mean — until the user answers it.
  const [accountPrompt, setAccountPrompt] = useState<OAuthAccountPrompt | null>(null);

  // Redirect already-signed-in users immediately on mount so they never see the
  // login form, then submit and get a confusing session_exists error.
  //
  // Stands down while the prompt is up. The only way to see the prompt on this
  // page is to click in the gap between Clerk hydrating and this navigation
  // landing — and without the guard, this effect would then yank the page out
  // from under the question it just asked. If the replace is already in flight
  // the navigation still wins, which is exactly today's behaviour and no worse;
  // switching accounts from inside the app is what the shell's "Log out" is for.
  useEffect(() => {
    if (accountPrompt) return;
    if (authLoaded && isSignedIn) {
      // Arriving here already signed in is normal once. Repeatedly, in half a
      // minute, means the page we are about to return to will send us straight
      // back — the bounce limit is the ONLY thing that skips the redirect.
      if (recordAuthBounce() > BOUNCE_LIMIT) {
        setLoopDetected(true);
        return;
      }
      router.replace(safeRedirectUrl);
    }
  }, [authLoaded, isSignedIn, safeRedirectUrl, router, accountPrompt]);

  const [flowMode, setFlowMode] = useState<'login' | 'signup'>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Email verification (Clerk "Verify at sign-up"). When the instance requires
  // it, signUp.create() comes back `missing_requirements` with email_address
  // unverified rather than `complete` — the account exists but has no session
  // yet. Everything below is that second leg: hold the signup open, collect the
  // emailed code, and only then run the completion side effects.
  const [pendingCode, setPendingCode] = useState(false);
  const [code, setCode] = useState('');
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent'>('idle');

  // Consume Clerk sign-in tickets (__clerk_ticket) — minted by Backend-API
  // sign-in tokens and carried by invitation links. Custom auth pages must
  // exchange the ticket explicitly; without this the URL dead-ends on the
  // sign-in form. Ref guards the one-shot exchange (tickets are single-use,
  // so a Strict-Mode double-fire would burn the ticket and then fail).
  const ticket = typeof router.query.__clerk_ticket === 'string' ? router.query.__clerk_ticket : undefined;
  const ticketConsumed = useRef(false);
  useEffect(() => {
    if (!signInLoaded || !authLoaded || isSignedIn || !ticket || ticketConsumed.current) return;
    ticketConsumed.current = true;
    (async () => {
      try {
        const result = await signIn!.create({ strategy: 'ticket', ticket });
        if (result.status === 'complete' && result.createdSessionId) {
          await setSignInActive!({ session: result.createdSessionId });
          router.replace(safeRedirectUrl);
          return;
        }
        setError('Could not complete sign-in from this link. Enter your email to continue.');
      } catch {
        setError('This sign-in link is invalid or has expired. Enter your email to continue.');
      }
    })();
  }, [signInLoaded, authLoaded, isSignedIn, ticket, signIn, setSignInActive, safeRedirectUrl, router]);

  const isSignup = flowMode === 'signup';

  const defaultSignupRedirect = (() => {
    const safeReturnTo = returnTo ? getSafeRedirectPath(returnTo, '') : '';
    if (safeReturnTo) return safeReturnTo;
    const params = new URLSearchParams();
    if (accountType) params.set('account_type', accountType);
    if (plan) params.set('plan', plan);
    if (billing) params.set('billing', billing);
    if (referralCode) params.set('referral_code', referralCode);
    if (promotionCode) params.set('promo_code', promotionCode);
    if (campaign) params.set('campaign', campaign);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    // Value-first: free signups onboard first; plan selection follows onboarding.
    return plan ? `/checkout${suffix}` : `/onboarding${suffix}`;
  })();

  const handleLogin = async (identifier: string) => {
    const result = await signIn!.create({ identifier, password });
    if (result.status === 'complete') {
      if (!result.createdSessionId) {
        setError('Sign-in completed but no session was created. Please try again.');
        return;
      }
      await setSignInActive!({ session: result.createdSessionId });
      await router.push(safeRedirectUrl);
      return;
    }
    // Password is the only first factor we support; any other status means the
    // account needs a different recovery path (e.g. reset).
    setError(`Sign-in requires an additional step (${result.status}). Try resetting your password.`);
  };

  const handleSignup = async (identifier: string) => {
    // Dashboard signup funnel — same canonical names as the marketing signup form
    // (signup_started → signup_completed) fired to BOTH PostHog and GA4, so the
    // dashboard-originated signup path is measurable and joins the cross-tool
    // funnel. (These previously lived in the now-deleted, never-rendered AuthPage.)
    trackProductEvent(PRODUCT_EVENTS.signupStarted, { source: 'dashboard', path: '/signup', metadata: { method: 'email' } });
    gaEvent('signup_started', { method: 'email' });

    const result = await signUp!.create({
      emailAddress: identifier,
      password,
      firstName: firstName.trim() || undefined,
      lastName: lastName.trim() || undefined,
      unsafeMetadata: signupContext(returnTo),
    });

    if (result.status === 'complete') {
      await finishSignup(result);
      return;
    }

    // Email verification is ON at the Clerk instance level: the account now
    // exists but carries no session until the emailed code is confirmed. Send
    // the code and hand off to the verification step.
    if ((result.unverifiedFields || []).includes('email_address')) {
      await signUp!.prepareEmailAddressVerification({ strategy: 'email_code' });
      setPendingCode(true);
      setCode('');
      setResendState('idle');
      return;
    }

    // Any OTHER incomplete status means Clerk wants a field this form does not
    // collect — a Dashboard flip that breaks EVERY signup at once. Say what is
    // missing instead of dead-ending on "contact support".
    setError(
      `Account setup could not complete (${result.status}${
        (result.missingFields || []).length ? `: needs ${(result.missingFields || []).join(', ')}` : ''
      }). Email support@deerdawn.com and we’ll sort it out.`
    );
  };

  // The completion side effects, in one place. Both routes into a finished
  // signup — verification-off (create returns `complete`) and verification-on
  // (the code attempt returns `complete`) — run exactly this, so enabling or
  // disabling verification in Clerk can never silently change which conversions
  // fire.
  const finishSignup = async (result: { createdSessionId?: string | null; createdUserId?: string | null }) => {
    if (!result.createdSessionId) {
      setError('Your account was created, but the session did not finish. Please sign in.');
      return;
    }
    // signup_completed now comes from the user.created webhook (once per real
    // account, both email and OAuth) — see apps/api/src/routes/auth-webhooks.js.
    // Emitting it here too would double-count this email path. GA4 has no server
    // counterpart, so it stays.
    gaEvent('signup_completed', { method: 'email' });
    // Reddit Pixel SignUp conversion. conversionId = Clerk user id so it
    // dedupes against the server-side CAPI event fired from the account_created
    // webhook. Best-effort before navigation; the CAPI is the guaranteed signal.
    trackRedditSignup(result.createdUserId || undefined);
    // New account created — mark the signup so the authed shell fires the
    // Google Ads sign-up conversion once the user is active (see _app
    // GtagIdentity). Set before setActive so the flag is present when the
    // signed-in state propagates.
    markSignupPending();
    await setSignUpActive!({ session: result.createdSessionId });
    await router.push(defaultSignupRedirect);
  };

  const handleVerifyCode = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!signUpLoaded) return;
    const entered = code.trim();
    if (!entered) {
      setError('Enter the code we emailed you.');
      return;
    }
    setIsLoading(true);
    setError('');
    try {
      const result = await signUp!.attemptEmailAddressVerification({ code: entered });
      if (result.status === 'complete') {
        await finishSignup(result);
        return;
      }
      setError(`That didn’t complete sign-up (${result.status}). Request a new code and try again.`);
    } catch (err: unknown) {
      // A wrong or expired code lands here. Keep the user on this step — the
      // account already exists, so sending them back to the form would only
      // produce an "email already taken" error on their own address.
      setError(formatClerkError(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleResendCode = async () => {
    if (!signUpLoaded || resendState === 'sending') return;
    setResendState('sending');
    setError('');
    try {
      await signUp!.prepareEmailAddressVerification({ strategy: 'email_code' });
      setResendState('sent');
    } catch (err: unknown) {
      setResendState('idle');
      setError(formatClerkError(err));
    }
  };

  // `switchAccount` is passed by the prompt's own button rather than read from
  // state: setState is not synchronous, so a handler that flipped a flag and
  // then called this would re-read the old value and ask the same question
  // again, forever.
  const handleGoogle = async (options?: { switchAccount?: boolean }) => {
    // authLoaded as well as signInLoaded: without it the guard below runs on an
    // `isSignedIn` of `undefined` and defaults to starting OAuth, which is the
    // exact hydration window the mount effect cannot cover.
    if (!signInLoaded || !authLoaded || (isSignup && !signUpLoaded)) return;
    setError('');
    setIsGoogleLoading(true);
    try {
      // Never start an OAuth attempt against a live session — see
      // lib/oauthStart.ts for why the check has to happen HERE and not in the
      // catch below, why the mount effect above is not sufficient on its own,
      // and why an existing session is a question rather than a silent redirect.
      // The decision lives there so it is unit-testable without Clerk, a
      // browser, or a network, and so it cannot drift from the marketing copy.
      //
      // This runs BEFORE the signup tracking rather than after: someone being
      // asked which account they meant is not starting a signup, and
      // markSignupPending() would arm a conversion for a click that creates no
      // account.
      const start = resolveOAuthStart({
        isSignedIn,
        isSignup,
        identity: signedInIdentity,
        confirmedSwitch: options?.switchAccount === true,
        loginRedirectUrl: safeRedirectUrl,
        signupRedirectUrl: defaultSignupRedirect,
      });
      if (start.action === 'confirm') {
        setAccountPrompt(start);
        trackProductEvent(PRODUCT_EVENTS.oauthSignedInPrompted, {
          source: 'dashboard',
          path: isSignup ? '/signup' : '/login',
          metadata: { method: 'google', named: Boolean(start.identity) },
        });
        setIsGoogleLoading(false);
        return;
      }
      if (start.action === 'switch') {
        // The email path's resolution, reached the moment the signal is as
        // specific as a typed address: drop the stale session, then attempt.
        await signOut();
      }
      // Cleared only once the session is actually gone. Clearing it first would
      // re-run the dashboard's mount effect while `isSignedIn` is still true,
      // and its router.replace would navigate away mid-switch — back into the
      // account the user just asked to leave.
      setAccountPrompt(null);

      // Clerk's OAuth flow is unified across sign-in and sign-up: this single
      // call provisions a new account or signs an existing one in. The callback
      // page completes the handshake and then forwards to redirectUrlComplete.
      // Mark a pending signup only when the user is on the signup flow; the
      // authed shell fires the conversion once, and only for a freshly-created
      // account, so an existing user signing in here is not miscounted.
      if (isSignup) {
        // Google signup completes after the OAuth redirect, so only the start is
        // recorded inline (matches the marketing form); completion is the server
        // account signal. Same name to both sinks for a joinable funnel.
        trackProductEvent(PRODUCT_EVENTS.signupStarted, { source: 'dashboard', path: '/signup', metadata: { method: 'google' } });
        gaEvent('signup_started', { method: 'google' });
        markSignupPending();
      }
      // `unsafeMetadata` is a SignUp parameter: SignIn.authenticateWithRedirect
      // silently drops it, and the sign-in→sign-up transfer does not carry it
      // across. This used to start from signIn with the metadata attached, so
      // every Google signup here reached the webhook with no attribution. Start
      // from signUp on signup intent, as the marketing form does (see its
      // comment for the PostHog evidence); the callback page transfers an
      // existing user to sign-in either way.
      const params = {
        strategy: 'oauth_google' as const,
        // Names the authorize screen this came from, if any, so the callback can
        // return there even when Clerk transfers sign-in <-> sign-up.
        redirectUrl: ssoCallbackPath(returnTo),
        redirectUrlComplete: isSignup ? defaultSignupRedirect : safeRedirectUrl,
      };
      if (isSignup) {
        await signUp!.authenticateWithRedirect({ ...params, unsafeMetadata: signupContext(returnTo) });
      } else {
        await signIn!.authenticateWithRedirect(params);
      }
    } catch (err: unknown) {
      // Belt and braces for the race the guard above cannot close: a session
      // created in another tab between the check and the redirect. This only
      // ever catches the client-side shape of Clerk's refusal — the server-side
      // shape lands on a raw JSON page and never comes back here, which is why
      // the guard has to run before the attempt. Same resolution as the guard:
      // ask, rather than seat them in whichever account happened to appear.
      if (isAlreadySignedInError(err)) {
        const raced = resolveOAuthStart({
          isSignedIn: true,
          isSignup,
          identity: signedInIdentity,
          loginRedirectUrl: safeRedirectUrl,
          signupRedirectUrl: defaultSignupRedirect,
        });
        if (raced.action === 'confirm') setAccountPrompt(raced);
        setIsGoogleLoading(false);
        return;
      }
      setError(formatClerkError(err));
      setIsGoogleLoading(false);
    }
  };

  const handleContinueAsCurrent = async () => {
    if (!accountPrompt) return;
    trackProductEvent(PRODUCT_EVENTS.oauthSignedInResolved, {
      source: 'dashboard',
      path: isSignup ? '/signup' : '/login',
      metadata: { method: 'google', choice: 'continue' },
    });
    await router.push(accountPrompt.continueUrl);
  };

  const handleUseDifferentAccount = async () => {
    trackProductEvent(PRODUCT_EVENTS.oauthSignedInResolved, {
      source: 'dashboard',
      path: isSignup ? '/signup' : '/login',
      metadata: { method: 'google', choice: 'switch' },
    });
    await handleGoogle({ switchAccount: true });
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!signInLoaded || !signUpLoaded) return;

    const normalizedEmail = email.trim();
    if (!normalizedEmail) {
      setError('Enter your email to continue.');
      return;
    }
    if (!password) {
      setError('Enter your password to continue.');
      return;
    }
    if (isSignup && password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use a password with at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      if (isSignup) {
        await handleSignup(normalizedEmail);
      } else {
        await handleLogin(normalizedEmail);
      }
    } catch (err: unknown) {
      if (isAlreadySignedInError(err)) {
        await router.push(safeRedirectUrl);
        return;
      }
      if (isSignup && isExistingAccountError(err)) {
        setError('That email already has a DeerDawn account. Sign in instead.');
        return;
      }
      setError(formatClerkError(err));
    } finally {
      setIsLoading(false);
    }
  };

  // Switching between sign-in and sign-up must carry the query (and Clerk's
  // hash params) across. It used to push a bare path, so an invitee sent to
  // /login?redirect_url=/invite?token=... who had no account clicked "Create
  // one", lost the return URL, and landed in onboarding instead of the workspace.
  const switchModeUrl = (mode: 'login' | 'signup') => ({
    pathname: mode === 'login' ? '/login' : '/signup',
    query: authQueryWithClerkHash(router.query, typeof window !== 'undefined' ? window.location.hash : ''),
  });

  const toggleMode = async () => {
    setFlowMode((current) => current === 'signup' ? 'login' : 'signup');
    setError('');
    setPassword('');
    await router.push(switchModeUrl(isSignup ? 'login' : 'signup'), undefined, { shallow: true });
  };

  const title = pendingCode ? 'Confirm your email' : isSignup ? 'Create your account' : 'Sign in';
  // The old signup subtitle promised "no email round-trip", which stopped being
  // true the moment verification was enabled in Clerk.
  const subtitle = pendingCode
    ? `We emailed a code to ${email.trim()}. Enter it to finish setting up your account.`
    : isSignup
      ? 'Create your account with an email and password.'
      : 'Sign in with your DeerDawn email and password.';

  // The account already exists at this point; only the session is missing. So
  // this step replaces the form entirely rather than sitting alongside it —
  // resubmitting the signup form would just fail on their own email.
  // Caught in the bounce cycle. Showing the login form here would be a lie —
  // they ARE signed in, and submitting it earns a raw `authorization_invalid`
  // page from Clerk, which is what this looks like from the outside. Say what is
  // actually true, and offer the one action that resolves it: drop the session
  // that cannot be verified and start a clean one.
  if (loopDetected) {
    return (
      <AuthShell
        mode="login"
        title="You're already signed in"
        subtitle="But the dashboard couldn't confirm it, so it sent you back here — and this page sent you back there. Signing in again won't break that; it's the session itself that needs replacing."
        alternateAction={null}
      >
        <div className="space-y-4">
          <Button
            type="button"
            className="w-full"
            onClick={async () => {
              clearAuthBounce();
              await signOut({ redirectUrl: '/login' });
            }}
          >
            Sign out and start a fresh session
          </Button>
          <button
            type="button"
            onClick={() => {
              clearAuthBounce();
              setLoopDetected(false);
              router.replace(safeRedirectUrl);
            }}
            className="w-full font-medium text-text-secondary underline decoration-[color:var(--border-strong)] underline-offset-4 transition-colors hover:text-text-primary"
          >
            Try the dashboard once more
          </button>
        </div>
      </AuthShell>
    );
  }

  if (pendingCode) {
    return (
      <AuthShell
        mode="signup"
        title={title}
        subtitle={subtitle}
        alternateAction={(
          // The account exists, so "start over" is not an option — the same
          // email would be rejected as taken. Signing in is the real recovery
          // for someone who confirms from another device or comes back later.
          <button
            type="button"
            onClick={async () => {
              setPendingCode(false);
              setFlowMode('login');
              setError('');
              setPassword('');
              await router.push(switchModeUrl('login'), undefined, { shallow: true });
            }}
            className="font-medium text-text-secondary underline decoration-[color:var(--border-strong)] underline-offset-4 transition-colors hover:text-text-primary"
          >
            Already confirmed? Sign in
          </button>
        )}
      >
        <form onSubmit={handleVerifyCode} noValidate className="space-y-5">
          {error ? <AuthMessage id="clerk-auth-error">{error}</AuthMessage> : null}
          {resendState === 'sent' && !error ? (
            <AuthMessage tone="info">A new code is on its way.</AuthMessage>
          ) : null}

          <div className="space-y-2">
            <label htmlFor="clerk-email-code" className="dashboard-eyebrow block">
              Verification code
            </label>
            <input
              id="clerk-email-code"
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'clerk-auth-error' : undefined}
              className="dashboard-input"
            />
          </div>

          <Button type="submit" isLoading={isLoading} className="w-full">
            Confirm and continue
          </Button>

          <button
            type="button"
            onClick={handleResendCode}
            disabled={resendState === 'sending'}
            className="block w-full text-center text-sm font-medium text-text-secondary underline decoration-[color:var(--border-strong)] underline-offset-4 transition-colors hover:text-text-primary disabled:opacity-60"
          >
            {resendState === 'sending' ? 'Sending…' : 'Send a new code'}
          </button>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      mode={isSignup ? 'signup' : 'login'}
      title={title}
      subtitle={subtitle}
      alternateAction={(
        <button
          type="button"
          onClick={toggleMode}
          className="font-medium text-text-secondary underline decoration-[color:var(--border-strong)] underline-offset-4 transition-colors hover:text-text-primary"
        >
          {isSignup ? 'Already have an account? Sign in' : 'Need an account? Create one'}
        </button>
      )}
    >
      <div className="space-y-5">
        {error ? <AuthMessage id="clerk-auth-error">{error}</AuthMessage> : null}

        {/* The question the Google button asks when a session already exists.
            Every string comes from lib/oauthStart.ts so it cannot say something
            different here than it does in the marketing modal; only the chrome
            is local. Rendered as a panel rather than an AuthMessage error:
            nothing has gone wrong, and the red treatment reads as failure on a
            page whose whole job is to get the user in. */}
        {accountPrompt ? (
          <div
            role="group"
            aria-labelledby="oauth-account-prompt"
            className="rounded-2xl border border-border-strong bg-overlay-subtle px-4 py-4"
          >
            <p id="oauth-account-prompt" className="text-sm leading-6 text-text-secondary">
              {accountPrompt.prompt}
            </p>
            <div className="mt-3.5 flex flex-col gap-2.5">
              <Button type="button" variant="primary" onClick={handleContinueAsCurrent} disabled={isLoading || isGoogleLoading} className="w-full">
                {accountPrompt.continueLabel}
              </Button>
              <Button type="button" variant="secondary" onClick={handleUseDifferentAccount} isLoading={isGoogleLoading} disabled={isLoading} className="w-full">
                {!isGoogleLoading ? <GoogleMark /> : null}
                {accountPrompt.switchLabel}
              </Button>
            </div>
          </div>
        ) : null}

        <Button
          type="button"
          variant="secondary"
          onClick={() => handleGoogle()}
          isLoading={isGoogleLoading}
          disabled={isLoading}
          className="w-full"
        >
          {!isGoogleLoading ? <GoogleMark /> : null}
          Continue with Google
        </Button>

        <div className="flex items-center gap-3" aria-hidden="true">
          <div className="h-px flex-1 bg-overlay-active" />
          <span className="text-xs font-medium uppercase tracking-wide text-text-muted">or</span>
          <div className="h-px flex-1 bg-overlay-active" />
        </div>
      </div>

      <form onSubmit={handleSubmit} noValidate className="mt-5 space-y-5">

        {isSignup ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor="clerk-first-name" className="dashboard-eyebrow block">
                First name
              </label>
              <input
                id="clerk-first-name"
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="Jane"
                autoComplete="given-name"
                autoFocus={isSignup}
                className="dashboard-input"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="clerk-last-name" className="dashboard-eyebrow block">
                Last name
              </label>
              <input
                id="clerk-last-name"
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder="Doe"
                autoComplete="family-name"
                className="dashboard-input"
              />
            </div>
          </div>
        ) : null}

        <div className="space-y-2">
          <label htmlFor="clerk-email" className="dashboard-eyebrow block">
            Email
          </label>
          <input
            id="clerk-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
            autoComplete="email"
            autoFocus={!isSignup}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'clerk-auth-error' : undefined}
            className="dashboard-input"
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="clerk-password" className="dashboard-eyebrow block">
            Password
          </label>
          <div className="relative">
            <input
              id="clerk-password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isSignup ? `At least ${MIN_PASSWORD_LENGTH} characters` : 'Your password'}
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'clerk-auth-error' : undefined}
              className="dashboard-input pr-16"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-pressed={showPassword}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1 text-xs font-medium text-text-muted transition-colors hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>

        <Button type="submit" isLoading={isLoading} className="w-full">
          {isSignup ? 'Create free account' : 'Sign in'}
        </Button>

        {!isSignup ? (
          <Link
            href="/forgot-password"
            className="block w-full text-center text-sm font-medium text-text-secondary underline decoration-[color:var(--border-strong)] underline-offset-4 transition-colors hover:text-text-primary"
          >
            Forgot password?
          </Link>
        ) : null}
      </form>
    </AuthShell>
  );
}
