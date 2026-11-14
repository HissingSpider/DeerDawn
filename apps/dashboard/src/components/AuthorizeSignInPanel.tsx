import { SignInButton, useSignUp } from '@clerk/nextjs';
import { isClerkHostedAuthEnabled } from '@/lib/authMode';
import { useEffect, useRef, useState } from 'react';
import { trackProductEvent } from '@/lib/productAnalytics';
import { PRODUCT_EVENTS } from '@/lib/analyticsEvents';
import { authorizeReturnPath, authorizeSignupPath, rememberAuthorizeReturn, ssoCallbackPath } from '@/lib/authorizeFlow';
import { signupContext } from '@/lib/signupContext';

// Both authorization surfaces (/mcp-auth device-code, /oauth/consent
// authorization-code) rendered a primary "Connect" button to browsers they had
// already determined were signed out. Measured over 2026-08-07..08-27, real
// accounts only: every one of the 15 `oauth_consent_viewed` events carrying
// signed_in=1 was followed by `oauth_consent_approved` within 5 seconds, and
// none of the 5 carrying signed_in=0 ever approved. Not one of those 5 even
// pressed Connect — `oauth_consent_signin_required`, which is emitted on that
// click, has zero events in 90 days.
//
// So the button was never the obstacle. A signed-out arrival was shown one
// action that could not work, and the only real affordance was a 13px "Sign in"
// pill in the top-right corner whose redirect returns to the dashboard root and
// drops the ?code= / ?req= the authorization needs. This panel replaces the
// dead button with the sign-in itself, and carries the current URL through the
// round trip so the user lands back on the request they came for.
//
// 2026-09-16: most people who reach this screen signed out have NO account yet;
// they copied a connector URL before signing up. The panel used to offer only
// "Sign in to continue", which reads as a dead end to someone without an
// account. It now leads with account creation, one click with Google, and keeps
// sign-in as the secondary path. Every path returns to this exact URL.
type Method = 'google' | 'email_signup' | 'signin';

function isAlreadySignedInError(err: unknown) {
  const clerkErr = err as { errors?: Array<{ code?: string; message?: string }> };
  return Boolean(
    clerkErr.errors?.some((issue) => {
      const code = String(issue.code || '').toLowerCase();
      const text = String(issue.message || '').toLowerCase();
      return code.includes('session_exists') || code.includes('already_signed_in') || text.includes('already signed in');
    }),
  );
}

/**
 * Without Clerk (local dev, self-hosted): the email/password pages, with the
 * way back to this authorize screen attached, so approving continues after
 * signing in.
 */
function CredentialAuthorizeSignInPanel() {
  const returnTo = typeof window !== 'undefined'
    ? `${window.location.pathname}${window.location.search}`
    : '/';
  const suffix = `?redirect_url=${encodeURIComponent(returnTo)}`;
  return (
    <div className="mt-4 space-y-2 text-sm text-text-secondary">
      <p>Sign in to this DeerDawn to approve the connection.</p>
      <p>
        <a href={`/login${suffix}`} className="font-medium text-primary hover:underline">Sign in</a>
        {' · '}
        <a href={`/signup${suffix}`} className="font-medium text-primary hover:underline">Create an account</a>
      </p>
    </div>
  );
}

export function AuthorizeSignInPanel(props: { surface: string; path: string }) {
  return isClerkHostedAuthEnabled() ? <ClerkAuthorizeSignInPanel {...props} /> : <CredentialAuthorizeSignInPanel />;
}

function ClerkAuthorizeSignInPanel({ surface, path }: { surface: string; path: string }) {
  // Resolved after mount: Clerk's satellite sign-in lives on the primary domain,
  // so the return target has to be the absolute URL of THIS page, query included.
  // Same-origin by construction — it is this page's own location, never input.
  const [returnUrl, setReturnUrl] = useState<string | undefined>(undefined);
  // Where the email sign-up goes. `/signup?redirect_url=<this page's path>` —
  // a QUERY parameter, because Clerk's redirect-mode SignUpButton puts the
  // return target in the HASH, which no server on the chain can read, and both
  // hops to the marketing sign-up form are server-side. See authorizeSignupPath.
  const [signupHref, setSignupHref] = useState('/signup');
  // Where Google returns to. Carries this page's path so the callback can send
  // the person back here even when Clerk transfers the attempt between sign-up
  // and sign-in, which ignores redirectUrlComplete. See ssoCallbackPath.
  const [callbackPath, setCallbackPath] = useState('/oauth/sso-callback');
  const [googleBusy, setGoogleBusy] = useState(false);
  const [error, setError] = useState('');
  const shownFired = useRef(false);
  const { isLoaded: signUpLoaded, signUp } = useSignUp();

  useEffect(() => {
    setReturnUrl(window.location.href);
    setSignupHref(authorizeSignupPath(window.location.href, window.location.origin));
    setCallbackPath(ssoCallbackPath(authorizeReturnPath(window.location.href, window.location.origin)));
  }, []);

  useEffect(() => {
    if (shownFired.current) return;
    shownFired.current = true;
    // The denominator this step has never had: how many people arrive at an
    // authorize screen without a session. Previously only inferable from
    // signed_in=0 on the view event, which cannot be filtered in a funnel.
    trackProductEvent(PRODUCT_EVENTS.oauthConsentSigninShown, {
      source: 'dashboard',
      path,
      metadata: { surface },
    });
  }, [surface, path]);

  const trackClick = (method: Method) =>
    trackProductEvent(PRODUCT_EVENTS.oauthConsentSigninClicked, {
      source: 'dashboard',
      path,
      metadata: { surface, method, has_return_url: returnUrl ? 1 : 0 },
    });

  // Google provisions a new account or signs an existing one in with the same
  // call, then the callback page forwards to redirectUrlComplete: this request.
  // This panel only renders for a resolved signed-out session, so the "never
  // start OAuth against a live session" rule holds; a session created in another
  // tab in the meantime is handled by reloading, which shows Connect.
  //
  // Started from signUp, not signIn, because the button leads with account
  // creation and only signUp carries unsafeMetadata: from signIn, every Google
  // account created here reached the account_created webhook with no
  // attribution and no record of the tool it was made to connect. The callback
  // page transfers an existing Google user to sign-in, so they still land back
  // here signed in.
  const continueWithGoogle = async () => {
    if (!signUpLoaded || !signUp || !returnUrl || googleBusy) return;
    trackClick('google');
    setError('');
    setGoogleBusy(true);
    // redirectUrlComplete is skipped when Clerk transfers the attempt on
    // /oauth/sso-callback (a new account, E-030). The callback URL carries this
    // request (callbackPath); sessionStorage is the fallback in case Clerk drops
    // that query on its way back. See the callback page.
    let storage: Storage | null = null;
    try { storage = window.sessionStorage; } catch { storage = null; }
    rememberAuthorizeReturn(storage, authorizeReturnPath(returnUrl, window.location.origin), Date.now());
    try {
      await signUp.authenticateWithRedirect({
        strategy: 'oauth_google',
        redirectUrl: callbackPath,
        redirectUrlComplete: returnUrl,
        unsafeMetadata: signupContext(returnUrl),
      });
    } catch (err) {
      if (isAlreadySignedInError(err)) {
        window.location.reload();
        return;
      }
      setGoogleBusy(false);
      setError('Google sign-in could not start. Try again, or use email below.');
    }
  };

  return (
    <div>
      <div className="mb-5 rounded-xl border border-primary/20 bg-primary/[0.07] p-4 text-[13px] leading-[1.6] text-text-secondary">
        <span className="font-semibold text-text-primary">Create a free account to connect.</span>{' '}
        It takes a few seconds, and you come straight back here to finish. Nothing to re-copy.
      </div>

      <button
        type="button"
        onClick={() => void continueWithGoogle()}
        disabled={!signUpLoaded || !returnUrl || googleBusy}
        className="w-full cursor-pointer rounded-xl border-none bg-primary p-3.5 text-[15px] font-semibold text-on-primary disabled:cursor-not-allowed disabled:opacity-60"
      >
        {googleBusy ? 'Opening Google…' : 'Continue with Google'}
      </button>

      {/* A plain link, not Clerk's SignUpButton. The button navigated with the
          return target in the URL hash, and every hop after it (dashboard
          /signup -> marketing /signup -> the verification step) is server-side
          and cannot see a hash, so the `?req=` / `?code=` this panel exists to
          preserve was dropped and the new account landed on /onboarding. */}
      <a
        href={signupHref}
        onClick={() => trackClick('email_signup')}
        className="mt-2.5 block w-full cursor-pointer rounded-xl border border-border-strong bg-transparent p-3 text-center text-[14px] font-medium text-text-primary no-underline"
      >
        Sign up with email
      </a>

      {error ? (
        <p role="alert" className="mt-3 text-[13px] text-status-danger">{error}</p>
      ) : null}

      {/* Google starts from signUp here, and Clerk runs its bot check when the
          sign-up is created — on this page, before the redirect. An escalated
          challenge needs this element to render into; see AuthShell. */}
      <div id="clerk-captcha" className="mt-3" />

      <div className="mt-4 text-center text-[13px] text-text-muted">
        Already have an account?{' '}
        <SignInButton mode="redirect" forceRedirectUrl={returnUrl} signUpForceRedirectUrl={returnUrl}>
          <button
            type="button"
            onClick={() => trackClick('signin')}
            className="cursor-pointer border-none bg-transparent p-0 font-semibold text-primary"
          >
            Sign in to continue
          </button>
        </SignInButton>
      </div>
    </div>
  );
}
