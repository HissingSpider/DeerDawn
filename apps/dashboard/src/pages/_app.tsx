import '@/styles/globals.css';
import type { AppProps } from 'next/app';
import { Layout } from '@/components/layout/Layout';
import { isClerkHostedAuthEnabled } from '@/lib/authMode';
import { useRouter } from 'next/router';
import dynamic from 'next/dynamic';
import { ClerkProvider, useAuth, useUser } from '@clerk/nextjs';
import { AuthProvider } from '@/components/layout/AuthProvider';
import { RouteProgress } from '@/components/layout/RouteProgress';
import { ToastContainer } from '@/components/ui/Toast';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ConfirmProvider } from '@/components/ui/ConfirmDialog';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { useEffect, useState } from 'react';
import { siteConfig } from '@/lib/siteConfig';
import { setRuntimeAuthToken, setRuntimeAuthTokenGetter } from '@/lib/authToken';
import { captureAttribution } from '@/lib/attribution';
import { captureLifecycleEmailClick, LIFECYCLE_EMAIL_PARAM } from '@/lib/lifecycleEmail';
import { gaPageview, setEnhancedConversionData, fireSignupConversionIfPending, markTestAccount } from '@/lib/gtag';
import { initPostHog, phPageview, phIdentify, phCapture } from '@/lib/posthog';
import { clientTelemetryAllowed, vercelInsightsAllowed } from '@/lib/telemetryGate';
import { getDeviceType } from '@/lib/device';
import { reportWebVital } from '@/lib/webVitals';
import { installRouterRecovery } from '@/lib/routerRecovery';
import { api } from '@/lib/api';
import { invitePath, readPendingInvite, shouldRedirectToPendingInvite } from '@/lib/pendingInvite';
import type { NextWebVitalsMetric } from 'next/app';

// Next calls this with each Core Web Vital as it finalizes. Forwarded to PostHog
// so the dashboard (which reports ~zero web vitals today) becomes measurable.
export function reportWebVitals(metric: NextWebVitalsMetric) {
  reportWebVital(metric);
}

// Governance host support is configured through NEXT_PUBLIC_GOVERNANCE_SITE_URL and NEXT_PUBLIC_GOVERNANCE_APP_URL.
const SATELLITE_DOMAIN = (() => {
  try {
    return new URL(siteConfig.SELF_APP_URL).host;
  } catch {
    return 'app.deerdawn.com';
  }
})();

const Analytics = dynamic(
  () => import('@vercel/analytics/react').then((mod) => mod.Analytics),
  { ssr: false }
);
const SpeedInsights = dynamic(
  () => import('@vercel/speed-insights/next').then((mod) => mod.SpeedInsights),
  { ssr: false }
);

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
};

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
  preload: false,
});

function ClerkTokenBridge() {
  const { getToken, isLoaded, isSignedIn } = useAuth();

  useEffect(() => {
    if (!isLoaded || !isSignedIn) {
      setRuntimeAuthToken(null);
      setRuntimeAuthTokenGetter(null);
      return;
    }

    setRuntimeAuthTokenGetter(async () => {
      const template = process.env.NEXT_PUBLIC_CLERK_JWT_TEMPLATE;
      if (template) {
        try {
          const token = await getToken({ template });
          if (token) return token;
        } catch {
          // Fall back to the default Clerk session token.
        }
      }

      return getToken();
    });

    return () => {
      setRuntimeAuthToken(null);
      setRuntimeAuthTokenGetter(null);
    };
  }, [getToken, isLoaded, isSignedIn]);

  return null;
}

/**
 * Feeds the signed-in user's email to gtag for enhanced conversions, so the
 * dashboard-side purchase / first_sync conversions attribute even without the
 * ad-click cookie. No-ops until gtag + a Google Ads id are present.
 */
function GtagIdentity() {
  const { isLoaded, isSignedIn, user } = useUser();

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    const email = user?.primaryEmailAddress?.emailAddress;
    // Latch synthetic journey accounts BEFORE any conversion can fire, so the
    // nightly E2E run (~45% of the OAuth consent funnel) never trains Google Ads.
    markTestAccount(email);
    if (email) setEnhancedConversionData({ email });
    // PostHog person identity MUST match the server-side distinct_id (the DeerDawn
    // user id from /auth/me), NOT Clerk's user.id. The server mirrors every
    // product/MCP event keyed on the DeerDawn id, so identifying web events with
    // Clerk's id would split one human into two PostHog persons and break the
    // cross-surface funnel + double-count weekly-active users.
    api.getCurrentUser()
      .then((u) => {
        if (!u?.id) return;
        // $set_once, so the server-side webhook's value always wins where it
        // exists. This only fills the accounts whose signup path dropped it —
        // the Google sign-in -> sign-up transfer, which is 10 of 48 real
        // accounts over the 45 days to 2026-08-23. See phIdentify's note.
        // Recovered from THIS browser, which is the same device that signed up.
        const device = getDeviceType();
        phIdentify(
          u.id,
          email ? { email } : undefined,
          device ? { initial_device_type: device } : undefined,
        );
      })
      .catch(() => { /* best-effort: leave web events anonymous if /me is unavailable */ });
    // Fire the Google Ads sign-up conversion once for a genuinely new account,
    // AFTER enhanced-conversion data is set so it carries the hashed email. The
    // signup flow (email/password or Google OAuth) set the pending flag;
    // createdAt filters existing users who re-auth via the signup Google button.
    const createdAtMs = user?.createdAt ? new Date(user.createdAt).getTime() : null;
    fireSignupConversionIfPending({ transactionId: user?.id, accountCreatedAtMs: createdAtMs });
  }, [isLoaded, isSignedIn, user]);

  return null;
}

/**
 * Finishes an invitation that was opened before the reader had a session.
 *
 * invite.tsx parks the token (lib/pendingInvite) when a signed-out visitor
 * chooses to sign up or sign in. The return URL normally brings them straight
 * back, but sign-up crosses to the marketing site, verification, Google OAuth
 * and onboarding defaults, and any one of those can land them somewhere else.
 * Wherever they land, the first signed-in page in this tab sends them to the
 * invite page, which redeems it. Skips the auth and authorize screens, where
 * navigating away would abandon a sign-in or an OAuth handshake mid-flight.
 */
function PendingInviteRedirect({ signedIn }: { signedIn: boolean | null }) {
  const router = useRouter();
  useEffect(() => {
    if (!router.isReady || signedIn !== true) return;
    if (!shouldRedirectToPendingInvite(router.pathname)) return;
    const token = readPendingInvite();
    if (token) void router.replace(invitePath(token));
  }, [router, router.isReady, router.pathname, signedIn]);
  return null;
}

function ClerkPendingInvite() {
  const { isLoaded, isSignedIn } = useAuth();
  return <PendingInviteRedirect signedIn={isLoaded ? Boolean(isSignedIn) : null} />;
}

// No Clerk (local dev / self-hosted): there is no session hook, so ask the API,
// and only when a token is actually waiting — the common case costs nothing.
function CredentialPendingInvite() {
  const router = useRouter();
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => {
    if (!router.isReady || !readPendingInvite() || !shouldRedirectToPendingInvite(router.pathname)) return;
    let cancelled = false;
    api.getCurrentUser()
      .then(() => { if (!cancelled) setSignedIn(true); })
      .catch(() => { if (!cancelled) setSignedIn(false); });
    return () => { cancelled = true; };
  }, [router.isReady, router.pathname]);
  return <PendingInviteRedirect signedIn={signedIn} />;
}

export default function App({ Component, pageProps }: AppProps) {
  const router = useRouter();
  // Auth pages render without Layout and without AuthProvider wrapping.
  // Full-screen setup pages stay auth-protected, but they render outside the
  // dashboard shell so the document can scroll normally.
  //
  // /oauth/consent belongs here for exactly the reason /mcp-auth does: they are
  // the two halves of one authorization step, and each draws its own
  // full-screen card and resolves the session itself (AccountBadge +
  // AuthorizeSignInPanel + the `sessionResolved` gate). /mcp-auth was added to
  // this list in 49fa2065; /oauth/consent landed later, in 18ca4a9f, and never
  // joined it — so the one page every remote-MCP connection must pass through
  // was the only authorize surface still rendering inside the dashboard shell
  // AND behind AuthProvider. That is what made it prerender to nothing:
  // AuthProvider returns WorkspaceLoadingScreen until Clerk answers, and on the
  // server Clerk never answers, so the static HTML for /oauth/consent was a
  // logo and a spinner — no heading, no copy, not even the page's <title>,
  // nothing to paint until Clerk had loaded and hydrated. (Its sibling
  // /mcp-auth prerenders its whole card.) Same omission class as the #252
  // usePageScroll miss the page already carries a comment about.
  //
  // /oauth/sso-callback belongs here most of all: it is where a signed-OUT
  // browser comes back from Google so Clerk can finish signing it in. Wrapped in
  // AuthProvider, the guard saw "signed out" and replaced it with
  // /login?redirect_url=%2Foauth%2Fsso-callback ~250ms after it loaded, before
  // <AuthenticateWithRedirectCallback> ever mounted. Only a sign-up Clerk had
  // already completed server-side arrived signed in and got through; every
  // other outcome (an existing account, a transfer, a verification step) looped
  // Google -> callback -> /login. Measured 2026-09-25/26: every Android attempt
  // from the ChatGPT connector, and the founder's own desktop retest.
  const isAuthPage = router.pathname.startsWith('/login') || router.pathname.startsWith('/signup') || router.pathname.startsWith('/forgot-password') || router.pathname.startsWith('/mcp-auth') || router.pathname.startsWith('/oauth/consent') || router.pathname === '/oauth/sso-callback';
  const isErrorPage = router.pathname === '/404' || router.pathname === '/_error' || router.pathname === '/500';
  // /invite renders its own full-screen card and has a signed-out branch; inside
  // Layout it could not render at all without a working bootstrap, which a
  // signed-out invitee (or a removed member being re-invited) does not have.
  const isStandaloneAuthedPage = router.pathname === '/select-plan' || router.pathname === '/checkout' || router.pathname === '/onboarding' || router.pathname === '/invite';
  // Dev-only component previews (e.g. /dev/blocking-banner). Rendered bare —
  // outside Layout, so they skip DashboardBootstrapProvider's session fetch and
  // can be viewed without signing in. The pages themselves 404 in production.
  //
  // Escaping Layout is only half of it: the clerkEnabled branch below must also
  // skip AuthProvider, which renders WorkspaceLoadingScreen until its bootstrap
  // fetch to the API resolves. Omitting isDevPreview there left the harness
  // spinning forever under the local default (NEXT_PUBLIC_AUTH_MODE=clerk, no
  // API on :8080) — documented as sign-in-free but reachable only by flipping
  // authMode to credentials, i.e. by leaving the code path you wanted to look
  // at. Same omission class as the /oauth/consent isAuthPage miss above.
  const isDevPreview = process.env.NODE_ENV !== 'production' && router.pathname.startsWith('/dev/');
  const [enableTelemetry, setEnableTelemetry] = useState(false);

  // Capture first-touch attribution (utm_* / campaign) as soon as the router
  // has the query string, on first load and every navigation. Stored in
  // localStorage and auto-attached to every product event.
  useEffect(() => {
    if (!router.isReady) return;
    captureAttribution(router.query);
  }, [router.isReady, router.query]);

  // Recovers from Next's "attempted to hard navigate to the same URL"
  // invariant (PostHog issue 01a0822c, seen on /onboarding), which fires
  // outside React and would otherwise leave the SPA stuck with no recovery
  // UI. See routerRecovery.ts.
  useEffect(() => installRouterRecovery(), []);

  // A lifecycle email's CTA carries ?dd_email=<type>. Capture it here rather
  // than in the two landing pages (/onboarding, /setup) so the click is
  // measured wherever a future email points, and so onboarding.tsx does not have
  // to grow another concern. Params are stripped afterwards via a shallow
  // replace — same history entry, no re-render of the page component, no reload
  // — so a bookmarked or shared link stops re-reporting.
  useEffect(() => {
    if (!router.isReady) return;
    if (!captureLifecycleEmailClick(router.query, router.pathname)) return;
    const rest = { ...router.query };
    for (const key of [LIFECYCLE_EMAIL_PARAM, 'utm_source', 'utm_medium', 'utm_campaign']) {
      delete rest[key];
    }
    void router.replace({ pathname: router.pathname, query: rest }, undefined, { shallow: true });
    // captureAttribution has already stored the utm_* values by the time this
    // runs (the effect above is declared first, and effects fire in order), so
    // stripping them here loses nothing.
  }, [router, router.isReady, router.query]);

  // Analytics SPA pageviews (GA4 + PostHog). gtag's initial config emits the
  // first page_view and initPostHog captures the first $pageview; Pages Router
  // navigations do not reload, so report each subsequent route here.
  useEffect(() => {
    // PostHog inits + fires its landing $pageview from the idle gate below; this
    // effect only reports subsequent SPA navigations (GA4 + PostHog).
    const onRouteChange = (url: string) => {
      gaPageview(url);
      phPageview();
    };
    router.events.on('routeChangeComplete', onRouteChange);
    return () => router.events.off('routeChangeComplete', onRouteChange);
  }, [router.events]);

  // Baseline route-transition latency (start -> rendered). Wave 1 adds the
  // perceived click -> first-progress-paint metric once the progress bar lands.
  useEffect(() => {
    let startedAt = 0;
    const onStart = () => {
      startedAt = performance.now();
    };
    const onDone = (url: string) => {
      if (!startedAt) return;
      const durationMs = Math.round(performance.now() - startedAt);
      startedAt = 0;
      phCapture('nav_timing', { app: 'dashboard', duration_ms: durationMs, to: url.split('?')[0] });
    };
    const onError = () => {
      startedAt = 0;
    };
    router.events.on('routeChangeStart', onStart);
    router.events.on('routeChangeComplete', onDone);
    router.events.on('routeChangeError', onError);
    return () => {
      router.events.off('routeChangeStart', onStart);
      router.events.off('routeChangeComplete', onDone);
      router.events.off('routeChangeError', onError);
    };
  }, [router.events]);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    // Self-hosted builds: no PostHog, Vercel Analytics or Speed Insights unless
    // TELEMETRY_ENABLED=true (lib/telemetryGate.ts).
    if (!clientTelemetryAllowed()) return;

    const enable = () => {
      setEnableTelemetry(true);
      // Defer PostHog boot to idle so its chunk + init don't compete with
      // hydration; reportWebVitals (buffered) still captures the early LCP.
      initPostHog().then(phPageview);
    };

    const ric = (window as IdleWindow).requestIdleCallback;
    if (typeof ric === 'function') {
      ric(enable, { timeout: 3000 });
      return;
    }

    const t = window.setTimeout(enable, 1500);
    return () => window.clearTimeout(t);
  }, []);

  const page = (isAuthPage || isErrorPage || isStandaloneAuthedPage || isDevPreview) ? (
    <div className="h-full overflow-y-auto">
      <Component {...pageProps} />
    </div>
  ) : (
    <>
      <Layout>
        <Component {...pageProps} />
      </Layout>
    </>
  );

  // App-wide promise-based confirm dialog (themed replacement for window.confirm).
  const content = <ConfirmProvider>{page}</ConfirmProvider>;

  const clerkKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  // Was an inline copy of the same condition as lib/authMode. The two MUST agree:
  // if authMode routes /login to ClerkAuthPage while this decides not to mount
  // ClerkProvider, the page throws on useSignIn outside a provider. One source.
  const clerkEnabled = isClerkHostedAuthEnabled();

  if (clerkEnabled) {
    return (
      <div className={`${inter.variable} ${jetbrainsMono.variable} h-full`}>
        <ErrorBoundary>
          <ClerkProvider
            publishableKey={clerkKey}
            signInUrl="/login"
            signUpUrl="/signup"
            afterSignOutUrl="/login"
          >
            <ClerkTokenBridge />
            <GtagIdentity />
            <ClerkPendingInvite />
            {isAuthPage || isDevPreview ? content : <AuthProvider>{content}</AuthProvider>}
            <RouteProgress />
            <ToastContainer />
            {enableTelemetry && vercelInsightsAllowed() && (
              <>
                <SpeedInsights />
                <Analytics />
              </>
            )}
          </ClerkProvider>
        </ErrorBoundary>
      </div>
    );
  }

  return (
    <div className={`${inter.variable} ${jetbrainsMono.variable} h-full`}>
      <ErrorBoundary>
        <CredentialPendingInvite />
        {content}
        <RouteProgress />
        <ToastContainer />
        {enableTelemetry && vercelInsightsAllowed() && (
          <>
            <SpeedInsights />
            <Analytics />
          </>
        )}
      </ErrorBoundary>
    </div>
  );
}
