import { PRO_PLAN_NAME } from '@/lib/planCopy';
import Head from 'next/head';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { Modal } from '@/components/ui/Modal';
import { PERSONAL_PLANS, SelectPlanChoices } from '@/components/billing/SelectPlanChoices';
import { api, ApiError } from '@/lib/api';
import { CHECKOUT_RETRY_MESSAGE, checkoutFailure } from '@/lib/checkoutPlanChange';
import { trackProductEvent } from '@/lib/productAnalytics';
import { PRODUCT_EVENTS } from '@/lib/analyticsEvents';
import { gaEvent } from '@/lib/gtag';
import { buildSignInRedirect, hasAttemptedSignIn } from '@/lib/checkoutIntent';
import { redirectToTrustedUrl } from '@/lib/redirects';
import { usePageScroll } from '@/hooks';
import { PLAN_REQUIRED_SUBTITLE, isPlanRequired } from '@/lib/planRequired';
import { SelfHostedBillingGate } from '@/components/billing/SelfHostedBillingGate';

function SelectPlanPage() {
  // Renders outside the dashboard shell, whose global `overflow: hidden`
  // would otherwise strand anything below the fold on a short viewport.
  usePageScroll();
  const router = useRouter();
  const [localSessionReady, setLocalSessionReady] = useState(false);
  const [localHasSession, setLocalHasSession] = useState<boolean | null>(null);
  // B-4 (annual-first): $96 collected once beats $10 against an unknown
  // retention curve, so annual is the default here as it already is on
  // settings/upgrade and the post-sync ask. The toggle still switches freely.
  const [billing, setBilling] = useState<'monthly' | 'annual'>('annual');
  const billingFromQueryRef = useRef(false);
  const [isLoading, setIsLoading] = useState(false);
  const [activePlan, setActivePlan] = useState<string | null>(null);
  const [error, setError] = useState('');
  const viewedRef = useRef(false);
  // No plan yet and no Free to fall back to (lib/planRequired): the picker is
  // the only way in, so it offers no Free card and cannot be dismissed.
  const [planRequired, setPlanRequired] = useState(false);
  const accountType = 'personal';
  const referralCode = typeof router.query.referral_code === 'string' ? router.query.referral_code : undefined;
  const promotionCode = typeof router.query.promo_code === 'string' ? router.query.promo_code : undefined;
  const campaign = typeof router.query.campaign === 'string' ? router.query.campaign : undefined;
  const sessionChecked = localSessionReady;
  const hasSession = localHasSession;

  useEffect(() => {
    let canceled = false;

    api.getCurrentUser()
      .then(() => {
        if (canceled) return;
        setLocalHasSession(true);
        setLocalSessionReady(true);
      })
      .catch(() => {
        if (canceled) return;
        setLocalHasSession(false);
        setLocalSessionReady(true);
        // B-0: a bare '/login' dropped the visitor on '/' after sign-in with the
        // plan and cadence gone. Carry the intent through instead. The marker on
        // that target caps this at one bounce — login sends an already-signed-in
        // visitor straight back here, so a session the API rejects would
        // otherwise ping-pong.
        router.replace(hasAttemptedSignIn(router.query)
          ? '/login'
          : buildSignInRedirect(router.pathname, router.query));
      });

    return () => {
      canceled = true;
    };
  }, [router]);

  // Annual is the default state above, so the only cadence a link still has to
  // override is an explicit billing=monthly; an incoming billing=annual (e.g.
  // the Google Ads landing CTA) lands on the same value it always did. Done as
  // an effect because the user can still toggle afterward.
  useEffect(() => {
    if (!router.isReady || billingFromQueryRef.current) return;
    billingFromQueryRef.current = true;
    if (router.query.billing === 'monthly') setBilling('monthly');
  }, [router.isReady, router.query.billing]);

  useEffect(() => {
    if (!router.isReady || viewedRef.current) return;
    viewedRef.current = true;
    trackProductEvent('select_plan_viewed', {
      source: 'dashboard',
      path: router.pathname,
      metadata: {
        account_type: accountType,
        billing,
        referral_code_present: Boolean(referralCode),
        promotion_code_present: Boolean(promotionCode),
        campaign: campaign || null,
      },
    });
  }, [accountType, billing, referralCode, promotionCode, campaign, router.isReady, router.pathname]);

  const plans = planRequired ? PERSONAL_PLANS.filter((plan) => plan.id !== 'free') : PERSONAL_PLANS;

  useEffect(() => {
    if (!router.isReady) return;
    trackProductEvent('select_plan_account_type_changed', {
      source: 'dashboard',
      path: router.pathname,
      metadata: {
        account_type: accountType,
      },
    });
  }, [accountType, router.isReady, router.pathname]);

  // Plan selection now follows onboarding (value-first). If the user already has
  // a paid plan (e.g. paid upfront via checkout), skip straight to the app.
  // Kept with the other hooks (before any early return) to satisfy rules-of-hooks.
  useEffect(() => {
    let canceled = false;
    api.getDashboardBootstrap()
      .then((b) => {
        if (canceled) return;
        if (isPlanRequired(b?.org?.subscription_status)) { setPlanRequired(true); return; }
        if (b?.org?.plan_tier && b.org.plan_tier !== 'free') router.replace('/');
      })
      .catch(() => {});
    return () => { canceled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!sessionChecked || hasSession !== true) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex items-center gap-3 rounded-full border border-border-subtle bg-overlay-subtle px-5 py-3 text-sm text-text-secondary">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-primary" />
          Loading
        </div>
      </div>
    );
  }

  const launchCheckout = async (planId: string) => {
    setError('');
    setIsLoading(true);
    setActivePlan(planId);
    trackProductEvent(PRODUCT_EVENTS.checkoutStarted, {
      source: 'dashboard',
      path: router.pathname,
      metadata: {
        surface: 'select_plan',
        account_type: accountType,
        plan: planId,
        billing,
        referral_code_present: Boolean(referralCode),
        promotion_code_present: Boolean(promotionCode),
        campaign: campaign || null,
      },
    });
    // Mirror to GA4 under the same canonical name so the checkout funnel joins
    // across PostHog and GA4 regardless of entry point.
    gaEvent('checkout_started', { tier: planId, billing });

    try {
      const checkoutBilling = billing;
      await api.updateAccountType(accountType, planId);
      const result = await api.checkout(planId, checkoutBilling, promotionCode, campaign);
      if (result.url) {
        redirectToTrustedUrl(result.url);
        return;
      }
      // No URL: the workspace already had a live subscription and the API moved
      // it onto this plan rather than opening a second one. There is no Stripe
      // page to visit, so land on billing, where the new plan is now shown.
      router.push('/settings/plan');
    } catch (err: unknown) {
      // Branch on the STATUS. throwApiError puts the server's sentence in
      // `message`, not the `billing_unavailable` code, so the text match below
      // never saw a real 503 and every failure read "Retry once". The shared
      // classifier is the one /checkout uses: 503 names a configuration
      // problem, a 4xx shows the server's own answer, and only a failure with
      // no answer gets the retry copy.
      const message = err instanceof Error ? err.message : '';
      if (err instanceof ApiError) {
        setError(checkoutFailure(err).message);
      } else if (message.includes('billing_unavailable') || message.includes('503')) {
        setError('Billing is temporarily unavailable. Retry in a minute or contact support.');
      } else {
        setError(CHECKOUT_RETRY_MESSAGE);
      }
      setIsLoading(false);
      setActivePlan(null);
    }
  };

  const continueToOnboarding = async () => {
    setError('');
    setIsLoading(true);
    setActivePlan(null);
    trackProductEvent('select_plan_trial_continue_clicked', {
      source: 'dashboard',
      path: router.pathname,
      metadata: {
        account_type: accountType,
        billing,
        referral_code_present: Boolean(referralCode),
        promotion_code_present: Boolean(promotionCode),
        campaign: campaign || null,
      },
    });

    // Saving the workspace type is best-effort attribution — it must never trap a
    // user on the paywall. Free IS the default, so we head to the app regardless
    // of whether the (non-critical) save succeeds. Onboarding already ran before
    // this step, so the destination is the dashboard.
    try {
      await api.updateAccountType(accountType, undefined);
    } catch {
      // Swallow: attribution can be reconciled later; do not block the free path.
    }
    router.push('/');
  };

  // Low-friction dismissal (the ✕ / Escape / backdrop): the free plan is the
  // default, so closing the paywall simply drops the user into their free
  // workspace. Fire the account-type save without awaiting so the exit is instant.
  const dismiss = () => {
    if (isLoading || planRequired) return;
    trackProductEvent('select_plan_dismissed', {
      source: 'dashboard',
      path: router.pathname,
      metadata: { account_type: accountType, billing },
    });
    void api.updateAccountType(accountType, undefined).catch(() => {});
    router.push('/');
  };

  return (
    <>
      <Head>
        <title>Select Plan | DeerDawn</title>
        <meta
          name="description"
          content="Choose the DeerDawn billing path for your new workspace."
        />
      </Head>

      {/* The plan chooser is a dismissible modal: a blurred, translucent scrim
          over the workspace, closeable via ✕ / Escape / backdrop. Closing is the
          free default, so there is no wrong way out. */}
      <div aria-hidden className="fixed inset-0 -z-10 bg-background">
        <div className="pointer-events-none absolute left-1/2 top-0 h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-primary/[0.06] blur-[120px]" />
      </div>

      <Modal
        open
        onClose={dismiss}
        ariaLabel="Choose your plan"
        cardClassName="relative flex max-h-[calc(100dvh-2rem)] w-full max-w-3xl flex-col overflow-hidden rounded-[24px] border border-border-subtle bg-surface shadow-[0_24px_80px_rgba(0,0,0,0.35)]"
      >
        {/* Low-friction close — drops the user into their free workspace.
            Not offered when there is no free workspace to drop into. */}
        {planRequired ? null : <button
          type="button"
          onClick={dismiss}
          disabled={isLoading}
          aria-label="Close and continue on Free"
          className="ui-press ui-focus absolute right-3.5 top-3.5 z-10 flex h-9 w-9 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-overlay-strong hover:text-text-primary disabled:opacity-40"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>}

        {/* Scrollable content — the tall pricing card must scroll on short /
            mobile viewports so the pinned ✕ and the paid CTA stay reachable.
            min-h-0 lets this flex child shrink below its content height (default
            min-height:auto would block the scroll and clip instead). */}
        <div className="min-h-0 overflow-y-auto p-7 max-sm:p-5">
          {/* Header row */}
          <div className="flex flex-wrap items-start justify-between gap-4 pr-10">
              <div>
                <h1 className="text-3xl font-semibold tracking-[-0.04em] text-text-primary max-sm:text-2xl">
                  Choose your plan
                </h1>
                <p className="mt-1.5 text-sm leading-6 text-text-secondary">
                  {planRequired
                    ? PLAN_REQUIRED_SUBTITLE
                    : `Start free to see your first briefed session, or choose ${PRO_PLAN_NAME} when it's part of your daily workflow.`}
                </p>
              </div>

            </div>

            {promotionCode ? (
              <div className="mt-4 inline-flex rounded-full border border-primary/25 bg-primary/5 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-primary">
                Campaign code: {promotionCode}
              </div>
            ) : null}

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center gap-0.5 rounded-xl border border-border-subtle bg-overlay-subtle p-1">
                {(['monthly', 'annual'] as const).map((cycle) => (
                  <button
                    key={cycle}
                    onClick={() => {
                      if (cycle !== billing) trackProductEvent('billing_period_changed', { source: 'dashboard', path: '/select-plan', metadata: { billing: cycle, surface: 'select_plan' } });
                      setBilling(cycle);
                    }}
                    className={`ui-press ui-focus rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
                      billing === cycle ? 'bg-overlay-active text-text-primary' : 'text-text-muted hover:text-text-primary'
                    }`}
                  >
                    {cycle === 'monthly' ? 'Monthly' : 'Annual'}
                  </button>
                ))}
              </div>
            </div>

            {error ? (
              <div className="mt-5 rounded-2xl border border-red-500/20 bg-red-500/10 px-5 py-3.5 text-sm text-text-secondary">
                {error}
              </div>
            ) : null}

            <SelectPlanChoices
              plans={plans}
              billing={billing}
              isLoading={isLoading}
              activePlan={activePlan}
              onContinueFree={continueToOnboarding}
              onCheckout={launchCheckout}
              onSeeTeam={() => router.push('/settings/upgrade')}
            />

            {/* Footer — single quiet escape; the Free card is the primary free path.
                No escape for an account with no plan: the dashboard would send it
                straight back here. */}
            {planRequired ? null : <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border-subtle pt-5 text-sm text-text-muted">
              <span>Already have a workspace?</span>
              <button
                onClick={() => router.push('/')}
                disabled={isLoading}
                className="ui-focus font-medium text-text-secondary underline-offset-4 transition-colors hover:text-text-primary hover:underline disabled:opacity-50"
              >
                Go to dashboard
              </button>
            </div>}
        </div>
      </Modal>
    </>
  );
}

export async function getServerSideProps() {
  return { props: {} };
}

// A self-hosted install has no billing: this page renders a notice there
// instead (components/billing/SelfHostedBillingGate.tsx).
export default function SelectPlan() {
  return (
    <SelfHostedBillingGate standalone>
      <SelectPlanPage />
    </SelfHostedBillingGate>
  );
}
