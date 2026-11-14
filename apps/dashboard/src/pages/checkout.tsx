import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { trackProductEvent } from '@/lib/productAnalytics';
import { buildSignInRedirect, hasAttemptedSignIn } from '@/lib/checkoutIntent';
import { redirectToTrustedUrl } from '@/lib/redirects';
import { revealNotice } from '@/lib/revealNotice';
import { siteConfig } from '@/lib/siteConfig';
import { usePageScroll } from '@/hooks';
import {
  ANNUAL_LABEL,
  MONTHLY_LABEL,
  PRO_PLAN_NAME,
  PRO_VALUE_LINE,
  TEAM_MIN_SEATS,
  TEAM_PLAN_NAME,
  TEAM_PRICE_ANNUAL,
  TEAM_PRICE_ANNUAL_PER_MONTH,
  TEAM_TRIAL_DAYS,
  TEAM_VALUE_LINE,
  isSelfServePlan,
  minSeatsFor,
  money,
  teamPricePhrase,
} from '@/lib/planCopy';
import { ApiError, getActiveWorkspace, PERSONAL_SWITCH_FAILED_MESSAGE, switchToPersonalWorkspace } from '@/lib/api';
import { boundWorkspaceEntry } from '@/lib/workspaceFallback';
import { teamTrialAlreadyUsed, teamTrialApplies } from '@/lib/billingOffer';
import {
  CHECKOUT_RETRY_MESSAGE,
  checkoutAutoSubmitDecision,
  checkoutFailure,
  resolveCheckoutCadence,
  seatChangeSentence,
  seatReductionRefusal,
  workspaceHasSubscription,
  type CheckoutExit,
} from '@/lib/checkoutPlanChange';
import { SelfHostedBillingGate } from '@/components/billing/SelfHostedBillingGate';
// No workspace_inactive branch here, deliberately. /api/v1/billing is one of
// enforcePlan's EXEMPT_PREFIXES — a delinquent customer has to be able to reach
// the page that lets them pay — so a checkout POST is never rebound to the
// personal workspace and never refused with 409 workspace_inactive. The branch
// that handled it could not run, and dead code that reads as a handled case is
// how a real gap gets overlooked. A lapsed workspace's owner reaches this page
// through the banner's billing link and buys for the workspace, which is the
// point.

const PLAN_NAMES: Record<string, string> = {
  free: 'Free',
  developer_basic: PRO_PLAN_NAME,
  developer_pro: TEAM_PLAN_NAME,
  lifetime: 'Lifetime',
};

const PLAN_SUMMARIES: Record<string, string> = {
  developer_basic: `${PRO_PLAN_NAME} is ${MONTHLY_LABEL} or ${ANNUAL_LABEL}. It adds ${PRO_VALUE_LINE}.`,
  // Per SEAT, and per what — the words carry the whole price, so they are in
  // the sentence rather than implied by a suffix elsewhere on the page. This
  // said "or $12.50 a seat on annual billing": on annual billing a seat is
  // $150, charged yearly, and $12.50 is only what that comes to a month.
  developer_pro: `${TEAM_PLAN_NAME} is ${teamPricePhrase('monthly')}, or ${money(TEAM_PRICE_ANNUAL)} per seat billed yearly (${money(TEAM_PRICE_ANNUAL_PER_MONTH)} per seat per month). It adds ${TEAM_VALUE_LINE}.`,
  lifetime: 'One payment. Long-term access with no recurring subscription.',
};
const CHECKOUT_STEPS = [
  'DeerDawn updates the workspace billing context before redirecting.',
  'Stripe handles the payment step outside the app.',
  'You return to the dashboard with the updated plan state.',
];

function CheckoutPage() {
  // Renders outside the dashboard shell, whose global `overflow: hidden`
  // would otherwise strand anything below the fold on a short viewport.
  usePageScroll();
  const router = useRouter();
  // 'updated' is the path with no Stripe page at the end of it: the workspace
  // already had a live subscription, so the API moved that one onto the new
  // plan rather than opening a second. The page has to be able to END here.
  // 'confirm' is the state this page did not have. A workspace with a live
  // subscription is MOVED in place by POST /billing/checkout — prorated,
  // immediate, no Stripe page — so posting on load spent money on a GET. It now
  // stops here and asks.
  // 'refused' is the other thing the page could not say: only an owner may
  // change a workspace's billing, and a member watched a spinner end in a 403.
  const [status, setStatus] = useState<'loading' | 'confirm' | 'refused' | 'redirecting' | 'error' | 'canceled' | 'updated'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [refusalMsg, setRefusalMsg] = useState('');
  // Where a refusal can send them, when it can send them anywhere. /checkout is
  // standalone: without this the only controls on a refusal went backwards.
  const [refusalExit, setRefusalExit] = useState<CheckoutExit>('none');
  // A refusal that answers Confirm replaces the confirm panel, whose button
  // unmounts: focus fell to the page body, and on a phone the panel's longer
  // text had been scrolled past, so the refusal's first lines sat above the
  // screen. Set only when a submit is refused (Confirm, or the submit the page
  // makes itself when there is nothing to confirm); a refusal the page's own
  // decision ARRIVES at is the page itself and moves nothing.
  const refusalRef = useRef<HTMLDivElement>(null);
  const revealSubmitRefusal = useRef(false);
  useEffect(() => {
    if (status !== 'refused' || !revealSubmitRefusal.current) return;
    revealSubmitRefusal.current = false;
    revealNotice(refusalRef.current);
  }, [status, refusalMsg]);
  const [switching, setSwitching] = useState(false);
  const [openingPortal, setOpeningPortal] = useState(false);
  const [updatedMsg, setUpdatedMsg] = useState('');
  // Whether anything actually moved. `updated: false` is the server saying the
  // request was a no-op, and the heading has to agree with the sentence below it.
  const [changeApplied, setChangeApplied] = useState(true);
  const [sessionReady, setSessionReady] = useState(false);
  // What the BOUND workspace is today. null = not answered yet or the read
  // failed, which is deliberately not the same as "no subscription".
  const [hasSubscription, setHasSubscription] = useState<boolean | null>(null);
  const [currentTier, setCurrentTier] = useState<string | null>(null);
  const [workspaceRole, setWorkspaceRole] = useState<string | null>(null);
  // Whether the workspace being charged is this person's own. Undefined on an
  // older API, and never guessed: it decides whether a refusal has a way out.
  const [boundIsPersonal, setBoundIsPersonal] = useState<boolean | null>(null);
  // Seats the subscription is billed for TODAY. null is unknown, which is never
  // read as zero — a guess here is how a link takes seats off a live team.
  const [currentSeats, setCurrentSeats] = useState<number | null>(null);
  // What the SERVER refused with, once it has. Its numbers outrank anything
  // read here: they came from the subscription rather than from the roster, and
  // they are what an `allow_reduce` press is confirming.
  const [serverSeatRefusal, setServerSeatRefusal] = useState<{ from: number; to: number } | null>(null);
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  // Bumped to re-run the workspace read in place after switching workspaces,
  // which keeps the plan/billing/seats/promo query the person arrived with.
  const [reloadToken, setReloadToken] = useState(0);
  // Whether THIS workspace gets the Team trial. null = not known yet, and the
  // page says nothing about a trial until it is: the trial belongs to a new
  // subscription, and a workspace that is already paying is moved in place
  // with no trial at all (see lib/billingOffer.teamTrialApplies). Promising
  // "nothing is charged until the trial ends" while that was still unknown is
  // how an existing subscriber got told it about a prorated charge.
  const [trialApplies, setTrialApplies] = useState<boolean | null>(null);
  // True when this workspace would open a new Team checkout but has already had
  // its one trial (one per workspace): the page then says it is charged from the start.
  const [trialUsed, setTrialUsed] = useState<boolean>(false);
  const viewedRef = useRef(false);

  const plan = typeof router.query.plan === 'string' ? router.query.plan : null;
  // B-4 (annual-first): annual is the default cadence for a NEW subscription —
  // $96 collected once beats $10 against an unknown retention curve — so only an
  // explicit `?billing=monthly` opts down. `?billing=annual` and the marketing
  // links' `?billing=yearly` both read as annual.
  //
  // For a workspace that already has a subscription the default is no cadence at
  // all: sending one moves the billing interval, and an interval change closes
  // the current period and charges the prorated difference immediately. See
  // lib/checkoutPlanChange.
  const billingCycle = resolveCheckoutCadence(
    { billing: router.query.billing, plan },
    { hasSubscription: hasSubscription === true },
  );
  const referralCode = typeof router.query.referral_code === 'string' ? router.query.referral_code : '';
  const promotionCode = typeof router.query.promo_code === 'string' ? router.query.promo_code : '';
  const campaign = typeof router.query.campaign === 'string' ? router.query.campaign : '';
  // Seat count for per-seat plans, carried the same way plan and billing are.
  // Clamped here as well as on the server: this value becomes a Stripe line
  // quantity, and the buyer can still adjust it on Stripe's own page.
  //
  // The FLOOR is the plan's, not 1. A link that arrives without ?seats (an
  // emailed checkout link, a retry after sign-in that dropped the query) used to
  // ask Stripe for one seat of a plan whose minimum is two; the server clamps it
  // back up, so the buyer saw a quantity they had not chosen appear on Stripe's
  // page. Opening at the floor means the number never moves under them.
  const minSeats = minSeatsFor(plan);
  const seats = (() => {
    const raw = Number(typeof router.query.seats === 'string' ? router.query.seats : String(minSeats));
    if (!Number.isFinite(raw)) return minSeats;
    return Math.max(minSeats, Math.min(500, Math.floor(raw)));
  })();
  const isPerSeat = minSeats > 1;
  const isSalesAssistedPlan = Boolean(plan && !isSelfServePlan(plan));
  const isCanceled = router.query.canceled === 'true';
  const staticError = !plan
    ? ''
    : !isSelfServePlan(plan)
      ? 'This plan is sales-assisted. Contact DeerDawn sales to activate it.'
      : '';

  useEffect(() => {
    if (!router.isReady || viewedRef.current) return;
    viewedRef.current = true;
    let state = 'ready';
    if (isCanceled) state = 'canceled';
    if (staticError) state = 'blocked';
    trackProductEvent('checkout_page_viewed', {
      source: 'dashboard',
      path: router.pathname,
      metadata: {
        plan: plan || null,
        billing: billingCycle || 'unchanged',
        state,
        referral_code_present: Boolean(referralCode),
        promotion_code_present: Boolean(promotionCode),
        campaign: campaign || null,
      },
    });
    if (isCanceled) {
      trackProductEvent('checkout_canceled_viewed', {
        source: 'dashboard',
        path: router.pathname,
        metadata: {
          plan: plan || null,
          billing: billingCycle || 'unchanged',
        },
      });
    }
    if (staticError) {
      trackProductEvent('checkout_sales_assisted_viewed', {
        source: 'dashboard',
        path: router.pathname,
        metadata: {
          plan: plan || null,
          billing: billingCycle || 'unchanged',
          message: staticError,
        },
      });
    }
  }, [billingCycle, isCanceled, plan, referralCode, router.isReady, router.pathname, seats, staticError]);

  useEffect(() => {
    if (!router.isReady) return;

    let canceled = false;
    api.getCurrentUser()
      .then(() => {
        if (!canceled) setSessionReady(true);
      })
      .catch(() => {
        if (canceled) return;
        // B-0: every emailed checkout link is opened signed out, so a failed
        // session check is a sign-in prompt, not a dead end — hand the visitor
        // to /login carrying the plan and cadence. The marker on that target
        // caps this at one bounce: a Clerk session the API rejects (or an API
        // outage) would otherwise ping-pong, because login sends an
        // already-signed-in visitor straight back to redirect_url.
        if (!hasAttemptedSignIn(router.query)) {
          router.replace(buildSignInRedirect(router.pathname, router.query));
          return;
        }
        setErrorMsg('Your session expired. Sign in again, then retry checkout.');
        setStatus('error');
      });

    return () => {
      canceled = true;
    };
  }, [router]);

  // WHAT THIS WORKSPACE ALREADY HAS, READ BEFORE ANYTHING IS POSTED.
  //
  // This used to be a copy-only read fired in PARALLEL with the checkout call,
  // and only for Team, because all it decided was whether to mention the trial.
  // It now gates the call itself: the answer decides whether POST
  // /billing/checkout opens a Stripe page or silently moves a live subscription
  // onto another plan, so the request has to wait for it.
  //
  // GET /teams/workspaces is the role half. It is deliberately NOT feature-gated
  // (somebody invited to their first team has to be able to see it), so it
  // answers for a personal workspace too, and it names the role in the BOUND
  // workspace — which is the one /billing/checkout would charge.
  useEffect(() => {
    if (!sessionReady || !plan || isCanceled || staticError) return;
    let stale = false;
    // The roster is the only place that says how many seats this workspace is
    // BILLED for, and it is read only when the seat count could matter. It fails
    // for everybody without team features, which is why it is allSettled with
    // the rest and its absence resolves to "unknown", never to a number.
    const seatRead = isPerSeat ? api.getTeam() : Promise.resolve(null);
    void Promise.allSettled([api.getUsage(), api.getWorkspaces(), seatRead]).then(([usage, workspaces, roster]) => {
      if (stale) return;
      if (usage.status === 'fulfilled') {
        setCurrentTier(usage.value.plan.tier || null);
        setHasSubscription(workspaceHasSubscription(usage.value.plan));
        const offer = {
          targetPlan: plan,
          currentTier: usage.value.plan.tier,
          stripeCustomerId: usage.value.plan.stripe_customer_id,
          teamTrialStartedAt: usage.value.plan.team_trial_started_at,
          subscriptionStatus: usage.value.plan.status,
        };
        setTrialApplies(teamTrialApplies(offer));
        setTrialUsed(teamTrialAlreadyUsed(offer));
      }
      if (workspaces.status === 'fulfilled') {
        // The workspace POST /billing/checkout will CHARGE: it carries this
        // browser's stored choice, while the listing is read without one and
        // its `active` is the server's (another device's switch, or a switch
        // whose server half failed). Reading `active` here let a member whose
        // browser was still on a team, and whose server choice was personal,
        // auto-submit as the "owner" of a workspace the charge did not go to.
        const bound = boundWorkspaceEntry(workspaces.value, getActiveWorkspace());
        setWorkspaceRole(bound?.role || null);
        setBoundIsPersonal(typeof bound?.personal === 'boolean' ? bound.personal : null);
      }
      if (roster.status === 'fulfilled' && roster.value) {
        const purchased = roster.value.seats?.purchased ?? roster.value.billing?.seats_purchased ?? null;
        const n = Number(purchased);
        setCurrentSeats(Number.isFinite(n) && n > 0 ? Math.floor(n) : null);
      }
      setWorkspaceLoaded(true);
    });
    return () => {
      stale = true;
    };
  }, [isCanceled, isPerSeat, plan, reloadToken, sessionReady, staticError]);

  const decision = useMemo(
    () => checkoutAutoSubmitDecision({
      hasSubscription,
      workspaceRole,
      boundIsPersonal,
      targetPlan: plan,
      currentTier,
      requestedSeats: isPerSeat ? seats : null,
      currentSeats,
      serverSeatRefusal,
    }),
    [boundIsPersonal, currentSeats, currentTier, hasSubscription, isPerSeat, plan, seats, serverSeatRefusal, workspaceRole],
  );

  // `allowReduce` is only ever true on a press that followed a confirmation
  // NAMING both seat numbers. Nothing on this page sets it from the URL.
  const submit = useCallback(async (allowReduce = false) => {
    try {
      setStatus('redirecting');
      const checkoutBillingCycle = billingCycle;
      const checkoutMeta = {
        plan,
        billing: checkoutBillingCycle || 'unchanged',
        referral_code_present: Boolean(referralCode),
        promotion_code_present: Boolean(promotionCode),
        campaign: campaign || null,
        seats,
      };
      trackProductEvent('checkout_redirect_started', {
        source: 'dashboard',
        path: router.pathname,
        metadata: checkoutMeta,
      });
      // checkout_started is the spec's canonical name for the same moment.
      trackProductEvent('checkout_started', {
        source: 'dashboard',
        path: router.pathname,
        metadata: checkoutMeta,
      });
      await api.updateAccountType(undefined, plan || undefined);
      // `upgrade`, not `checkout`: the same endpoint, but its billingCycle is
      // OPTIONAL and has no default. `checkout` defaults to monthly, which for
      // an existing annual subscriber would change their billing interval as a
      // side effect of changing plan — and an interval change is charged now.
      const result = await api.upgrade(plan || '', checkoutBillingCycle, promotionCode || undefined, campaign || undefined, seats, allowReduce);
      if (result.url) {
        redirectToTrustedUrl(result.url);
        return;
      }
      // No URL: this workspace already had a live subscription and the API
      // moved THAT one onto the new plan, prorated. There is no Stripe page
      // to open — opening one anyway is precisely how a second concurrent
      // subscription got created.
      //
      // The server's sentence is shown whole. It knows whether the billing
      // period moved with the plan, which decides whether the prorated
      // difference is charged now or on the next invoice; this page used to
      // append "prorated onto your next invoice" to every outcome.
      //
      // AND `updated: false` IS NOT AN UPDATE. billing.js answers it for "this
      // workspace already has N seats. Nothing was changed or charged." — a
      // real answer, and one this page rendered under the heading "Plan
      // updated", which is the page contradicting the sentence inside it.
      setChangeApplied(result.updated !== false);
      setUpdatedMsg(result.message || 'Your existing subscription was moved to the new plan. You have one subscription, not two.');
      setStatus('updated');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      trackProductEvent('checkout_redirect_failed', {
        source: 'dashboard',
        path: router.pathname,
        metadata: {
          plan,
          billing: billingCycle || 'unchanged',
          reason: msg || 'checkout_failed',
          promotion_code_present: Boolean(promotionCode),
          campaign: campaign || null,
        },
      });
      // THE SERVER DISAGREES ABOUT THE SEAT COUNT. It refused before changing
      // anything and handed back both numbers, which is exactly what the
      // confirmation needs. Ask with ITS numbers; never resend with
      // `allow_reduce` on this page's own authority.
      //
      // The numbers go to the DECISION, not only to `currentSeats`. Storing
      // them there alone left a reader whose /orgs/usage call had failed in a
      // loop: `hasSubscription: null` keeps the decision at `unknown_state`,
      // whose Confirm sends `submit(false)`, which is refused identically.
      const reduction = seatReductionRefusal(err);
      if (reduction) {
        setServerSeatRefusal(reduction);
        setCurrentSeats(reduction.from);
        setStatus('confirm');
        return;
      }
      // A 503 from /billing/checkout is a CONFIGURATION failure the server has
      // already named — "Missing Stripe base price for developer_pro
      // (monthly)" when its price env var is unset, "Stripe is not configured",
      // "Missing DASHBOARD_URL". Replacing that with "retry in a minute"
      // tells a buyer to keep trying something that will never work and tells
      // us nothing, so the server's own sentence is shown verbatim. Only the
      // generic branch below invents copy.
      //
      // A 4xx is the server ANSWERING, and no retry changes the answer: a 400
      // invalid_plan (same or lower tier) or seats_below_headcount used to read
      // "Retry once". Those become refusals with a way through; any other 4xx
      // shows the server's own sentence. See lib/checkoutPlanChange.
      const failure = err instanceof ApiError
        ? checkoutFailure(err)
        : msg.includes('billing_unavailable') || msg.includes('503')
          ? { kind: 'error' as const, message: 'Billing is temporarily unavailable. Retry in a minute or contact support.' }
          : { kind: 'error' as const, message: CHECKOUT_RETRY_MESSAGE };
      if (failure.kind === 'refused') {
        revealSubmitRefusal.current = true;
        setRefusalMsg(failure.message);
        setRefusalExit(failure.exit);
        setStatus('refused');
        return;
      }
      setErrorMsg(failure.message);
      setStatus('error');
    }
  }, [billingCycle, campaign, plan, promotionCode, referralCode, router.pathname, seats]);

  useEffect(() => {
    if (!sessionReady || isCanceled || staticError) return;

    if (!plan) {
      router.replace('/onboarding');
      return;
    }

    // Nothing is posted until the workspace has answered. `workspaceLoaded`
    // turns true even when both reads fail, and an unanswered subscription state
    // resolves to 'confirm' rather than 'submit' — a transient API failure must
    // not be what reopens a silent plan change.
    if (!workspaceLoaded) return;

    if (decision.action === 'refuse') {
      setRefusalMsg(decision.reason);
      setRefusalExit(decision.exit);
      setStatus('refused');
      trackProductEvent('checkout_change_refused', {
        source: 'dashboard',
        path: router.pathname,
        metadata: { plan, role: workspaceRole || null, exit: decision.exit },
      });
      return;
    }

    if (decision.action === 'confirm') {
      setStatus((current) => (current === 'loading' ? 'confirm' : current));
      return;
    }

    void submit();
  }, [decision, isCanceled, plan, router, sessionReady, staticError, submit, workspaceLoaded, workspaceRole]);

  /**
   * Leave a workspace that is not yours and re-evaluate IN PLACE.
   *
   * Never automatic. The refusal is correct and the person may genuinely want
   * an owner to make the change; switching workspaces under somebody mid-
   * purchase is the same mistake as the silent charge, pointed the other way.
   * No navigation, so the plan, cadence, seats and promo they arrived with are
   * still here when the page re-reads.
   */
  // A move to a lower plan happens in Stripe's portal, not through checkout.
  // If the portal cannot be opened, the plan page is where its button lives.
  const openBillingPortal = useCallback(async () => {
    setOpeningPortal(true);
    try {
      const { url } = await api.getPortalUrl();
      redirectToTrustedUrl(url);
    } catch {
      setOpeningPortal(false);
      router.push('/settings/plan');
    }
  }, [router]);

  const switchToOwnWorkspace = useCallback(async () => {
    setSwitching(true);
    if (!(await switchToPersonalWorkspace())) {
      // Re-evaluating now would read the same workspace again: the server still
      // has it active and this browser no longer sends a header to override it.
      setRefusalMsg(PERSONAL_SWITCH_FAILED_MESSAGE);
      setSwitching(false);
      return;
    }
    setWorkspaceRole(null);
    setBoundIsPersonal(null);
    setHasSubscription(null);
    setCurrentTier(null);
    setCurrentSeats(null);
    // The refusal belonged to the workspace being left, including its numbers.
    setServerSeatRefusal(null);
    setRefusalMsg('');
    setRefusalExit('none');
    setWorkspaceLoaded(false);
    setStatus('loading');
    setSwitching(false);
    setReloadToken((n) => n + 1);
  }, []);

  const confirmReason = decision.action === 'confirm' ? decision.reason : null;
  const seatChange = decision.action === 'confirm' ? decision.seatChange : undefined;

  const planTitle = plan ? PLAN_NAMES[plan] || plan : 'Selected plan';
  const planSummary = plan ? PLAN_SUMMARIES[plan] || 'Premium DeerDawn access.' : '';
  const currentPlanTitle = currentTier ? PLAN_NAMES[currentTier] || currentTier : 'your current plan';
  // "Unchanged" is a real answer, not a missing one: for an existing subscriber
  // whose URL named no cadence, nothing about the billing interval moves.
  const cadenceLabel = billingCycle === 'annual' ? 'Annual' : billingCycle === 'monthly' ? 'Monthly' : 'Unchanged';
  const stageLabel = useMemo(() => {
    if (isCanceled) return 'Checkout canceled';
    if (staticError || status === 'error') return 'Checkout needs attention';
    if (status === 'refused') return 'You cannot change this billing';
    // "Plan updated" over "Nothing was changed or charged" is the page
    // disagreeing with itself. The server said which one it was.
    if (status === 'updated') return changeApplied ? 'Plan updated' : 'Nothing changed';
    if (status === 'confirm') {
      // The heading is part of the claim. "Confirm this plan change" over a
      // panel that says the plan is not moving is its own small untruth.
      if (confirmReason === 'seat_reduction') return 'Confirm fewer seats';
      if (confirmReason === 'seat_increase') return 'Confirm more seats';
      if (confirmReason === 'unknown_state') return 'Confirm to continue';
      if (confirmReason === 'one_time') return 'Confirm this one-time payment';
      return 'Confirm this plan change';
    }
    if (status === 'loading') return 'Preparing workspace';
    if (status === 'redirecting') return 'Redirecting to Stripe';
    return 'Preparing workspace';
  }, [changeApplied, confirmReason, isCanceled, staticError, status]);

  return (
    <div className="min-h-screen bg-background text-text-primary">
      <header className="relative flex items-center justify-between px-6 py-4 lg:px-10">
        <a href={siteConfig.ACTIVE_SITE_URL} className="text-base font-bold text-text-primary transition-colors hover:text-primary">
          DeerDawn
        </a>
        <button
          onClick={() => router.push('/select-plan')}
          className="ui-press ui-focus text-sm text-text-muted transition-colors hover:text-text-secondary"
        >
          ← Back to plans
        </button>
      </header>

      <div className="relative mx-auto flex min-h-[calc(100vh-72px)] max-w-6xl items-center px-6 py-8 lg:px-10">
        <div className="grid w-full gap-8 lg:grid-cols-[1.1fr_0.9fr]">
          <section className="rounded-[32px] border border-border-subtle bg-overlay-subtle p-8 shadow-[0_30px_90px_rgba(0,0,0,0.24)] max-sm:rounded-3xl max-sm:p-6 lg:p-10">
            {!isCanceled && !staticError && status !== 'error' && status !== 'refused' ? (
              <div className="dashboard-eyebrow">Almost there</div>
            ) : null}
            <h1 className="mt-3 text-[clamp(2.8rem,5vw,4.8rem)] font-semibold tracking-[-0.07em] text-text-primary leading-[0.94]">
              Complete checkout for {planTitle}.
            </h1>
            <p className="mt-4 max-w-2xl text-[16px] leading-8 text-text-secondary">{planSummary}</p>
            {plan && isSelfServePlan(plan) ? (
              <>
                <p className="mt-3 text-sm leading-7 text-text-muted">
                  Billing cadence: <span className="text-text-primary">{cadenceLabel}</span>
                  {isPerSeat ? (
                    <>
                      <span className="text-text-muted"> · </span>
                      <span className="text-text-primary">{seats} seats</span>
                    </>
                  ) : null}
                  {promotionCode ? <><span className="text-text-muted"> · </span><span className="text-text-primary">Promo {promotionCode}</span></> : null}
                </p>
                {/* Team is the one plan whose features nothing cheaper shows you
                    first, so the trial is the offer, not a footnote. Both
                    numbers come from planCopy, which is pinned to the trial the
                    checkout actually grants and the floor it actually clamps to. */}
                {/* Not on the confirm step: "change the count on Stripe's page"
                    is only true when there IS a Stripe page, and a workspace
                    being changed in place never sees one. */}
                {plan === 'developer_pro' && status !== 'updated' && status !== 'refused' && status !== 'confirm' ? (
                  <p className="mt-2 text-sm leading-7 text-text-muted">
                    {trialApplies ? (
                      <>
                        {TEAM_TRIAL_DAYS} days free, card up front — nothing is charged until the trial ends, and you can
                        cancel before then.{' '}
                      </>
                    ) : trialUsed ? (
                      <>
                        This workspace has already had its Team free trial, so it is charged from the start.{' '}
                      </>
                    ) : null}
                    {TEAM_MIN_SEATS} seats minimum; you can change the count on Stripe&rsquo;s page.
                  </p>
                ) : null}
                {/* B-5: the guarantee links to the published policy rather than
                    standing as an unbacked claim. Cancelling is the Stripe
                    billing portal already wired into /settings/plan. */}
                <p className="mt-2 text-sm leading-7 text-text-muted">
                  30-day money-back guarantee on your first charge. Cancel anytime.{' '}
                  <a
                    href={`${siteConfig.ACTIVE_SITE_URL}/refund-policy`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    Refund policy
                  </a>
                </p>
              </>
            ) : null}

            <div className="mt-8 rounded-[28px] border border-border-subtle bg-surface p-6">
              <div className="dashboard-eyebrow">Status</div>
              <div className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-text-primary">{stageLabel}</div>
              {(status === 'loading' || status === 'redirecting') && !isCanceled && !staticError ? (
                <div className="mt-6 flex items-center gap-4">
                  <div className="h-10 w-10 animate-spin rounded-full border-2 border-border-subtle border-t-primary" />
                  <div className="text-sm leading-7 text-text-secondary">
                    {status === 'loading'
                      ? 'We’re aligning your workspace state before checkout begins.'
                      : plan === 'lifetime'
                        ? 'Stripe is opening for a one-time payment checkout.'
                        : 'Stripe is opening now. Keep this tab open until the redirect completes.'}
                  </div>
                </div>
              ) : null}

              {status === 'confirm' ? (
                <div className="mt-6 space-y-4">
                  {/* THE STEP THAT DID NOT EXIST. This workspace already has a
                      subscription, so POST /billing/checkout would move THAT
                      subscription rather than open a Stripe page — there is no
                      Stripe screen later to read this on. Everything that
                      changes is named here, and nothing is sent until Confirm.

                      And it names the RIGHT thing. One paragraph used to be
                      shown to everybody, including a reader whose usage read had
                      failed (we do not know what they have) and a lifetime buyer
                      (a one-time payment, no card on file being charged a
                      proration). Stating a charge to somebody it will not happen
                      to is the same class of wrong as the silent charge. */}
                  {confirmReason === 'unknown_state' ? (
                    <p className="text-sm leading-7 text-text-secondary">
                      We could not check your current plan, so we cannot say here what this will change or what it will
                      cost. Confirm to continue to the next step, where the exact amount is shown before anything is
                      taken.
                    </p>
                  ) : confirmReason === 'one_time' ? (
                    <p className="text-sm leading-7 text-text-secondary">
                      Lifetime is a single payment, taken on Stripe&rsquo;s own page. Confirm to open it. Nothing is
                      charged to a card on file, and no recurring subscription starts.
                    </p>
                  ) : seatChange ? (
                    <>
                      {/* THE REDUCTION, NAMED. The marketing "Try Team" link
                          carries seats=2, so a Team owner on five seats who
                          follows it is asking, without knowing it, to pay for
                          three fewer. Both numbers are in the sentence, and
                          `allow_reduce` is sent only by this press. */}
                      <p className="text-sm leading-7 text-text-secondary">
                        <span className="text-text-primary">{seatChangeSentence(planTitle, seatChange)}</span>
                      </p>
                      <p className="text-sm leading-7 text-text-secondary">
                        {seatChange.to < seatChange.from
                          ? 'Removing seats does not remove anybody from the workspace. If more people are in it than you pay for, the change is refused and nothing is charged.'
                          : 'The prorated difference for the extra seats is charged to the card on file.'}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm leading-7 text-text-secondary">
                        This workspace already has a subscription. Confirming moves it from{' '}
                        <span className="text-text-primary">{currentPlanTitle}</span> to{' '}
                        <span className="text-text-primary">{planTitle}</span>
                        {isPerSeat ? <> at <span className="text-text-primary">{seats} seats</span></> : null}
                        {billingCycle ? <> on <span className="text-text-primary">{cadenceLabel.toLowerCase()}</span> billing</> : <>, leaving your billing cadence unchanged</>}.
                      </p>
                      {/* Deliberately not "charged now": whether Stripe bills the
                          difference immediately depends on the billing INTERVAL
                          moving, and this page cannot see the interval the
                          subscription is currently on. Both outcomes are named
                          rather than one of them guessed. */}
                      <p className="text-sm leading-7 text-text-secondary">
                        The card on file is charged a prorated amount for the change. If the billing period moves with it
                        (monthly to annual, or back), that charge is taken immediately; otherwise it appears on your next
                        invoice. No free trial applies to a plan change, and you will still have one subscription, not two.
                      </p>
                    </>
                  )}
                  <div className="flex flex-wrap gap-3">
                    <Button onClick={() => void submit(confirmReason === 'seat_reduction')}>
                      {confirmReason === 'seat_reduction' ? 'Confirm fewer seats' : 'Confirm the change'}
                    </Button>
                    <Button variant="secondary" onClick={() => router.push('/settings/plan')}>Cancel</Button>
                  </div>
                </div>
              ) : null}

              {status === 'refused' ? (
                // The sentence AND its way through are what is revealed, so the
                // whole block is the target: on a phone the buttons wrap below.
                <div ref={refusalRef} tabIndex={-1} className="mt-6 scroll-mt-6 space-y-4">
                  <div className="rounded-2xl border border-border-subtle bg-overlay-subtle px-5 py-4 text-sm leading-7 text-text-secondary">
                    {refusalMsg}
                  </div>
                  <div className="flex flex-wrap gap-3">
                    {/* THE WAY THROUGH. This page is standalone and has no
                        workspace switcher on it, so "switch to your own
                        workspace first" used to be advice beside two buttons
                        that both went backwards. The purchase continues here:
                        no navigation, so the plan, cadence, seats and promo
                        survive the switch. */}
                    {refusalExit === 'own_workspace' ? (
                      <Button disabled={switching} onClick={() => void switchToOwnWorkspace()}>
                        {switching ? 'Switching…' : 'Use my own workspace'}
                      </Button>
                    ) : null}
                    {refusalExit === 'team_settings' ? (
                      <Button onClick={() => router.push('/settings/team')}>Open team settings</Button>
                    ) : null}
                    {refusalExit === 'billing_portal' ? (
                      // 40px to the touch on a phone; the default h-11 is 38.5px at the 14px root.
                      <Button className="max-sm:h-[40px]" disabled={openingPortal} onClick={() => void openBillingPortal()}>
                        {openingPortal ? 'Opening…' : 'Open the billing portal'}
                      </Button>
                    ) : null}
                    <Button variant="secondary" onClick={() => router.push('/settings/plan')}>Back to billing</Button>
                    <Button variant="secondary" onClick={() => router.push('/')}>Back to the dashboard</Button>
                  </div>
                </div>
              ) : null}

              {status === 'updated' ? (
                <div className="mt-6 space-y-4">
                  <p className="text-sm leading-7 text-text-secondary">
                    {updatedMsg}
                  </p>
                  <div className="flex flex-wrap gap-3">
                    <Button onClick={() => router.push('/settings/plan')}>See your plan</Button>
                    <Button variant="secondary" onClick={() => router.push('/')}>Back to the dashboard</Button>
                  </div>
                </div>
              ) : null}

              {isCanceled ? (
                <div className="mt-6 space-y-4">
                  <p className="text-sm leading-7 text-text-secondary">
                    No charge was made. You can retry the same plan or continue setting up the workspace before deciding.
                  </p>
                  <div className="flex flex-wrap gap-3">
                    <Button onClick={() => {
                      setStatus('loading');
                      router.replace({ pathname: '/checkout', query: router.query });
                    }}>
                      Try again
                    </Button>
                    <Button variant="secondary" onClick={() => router.push('/select-plan')}>Choose another plan</Button>
                  </div>
                </div>
              ) : null}

              {staticError || status === 'error' ? (
                <div className="mt-6 space-y-4">
                  <div className="rounded-2xl border border-red-500/20 bg-red-500/10 px-5 py-4 text-sm text-text-secondary">
                    {staticError || errorMsg}
                  </div>
                  <div className="flex flex-wrap gap-3">
                    {isSalesAssistedPlan ? (
                      <Button onClick={() => { window.location.assign(`${siteConfig.ACTIVE_SITE_URL}/contact`); }}>
                        Contact sales
                      </Button>
                    ) : !sessionReady ? (
                      // B-0: the session check is what failed and the one-bounce
                      // cap is spent, so a Retry would fail identically. Offer the
                      // sign-in that was missing here, still carrying the intent.
                      <Button onClick={() => { router.push(buildSignInRedirect(router.pathname, router.query)); }}>
                        Sign in and continue
                      </Button>
                    ) : (
                      <Button onClick={() => {
                        setStatus('loading');
                        router.replace({ pathname: '/checkout', query: router.query });
                      }}>
                        Retry checkout
                      </Button>
                    )}
                    <Button variant="secondary" onClick={() => router.push('/settings/plan')}>
                      Back to billing
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </section>

          <aside className="space-y-6">
            <section className="rounded-[32px] border border-border-subtle bg-background p-8 max-sm:rounded-3xl max-sm:p-6">
              <div className="dashboard-eyebrow">What happens next</div>
              <div className="mt-4 space-y-3">
                {CHECKOUT_STEPS.map((item, index) => (
                  <div key={item} className="flex gap-4 rounded-2xl border border-border-subtle bg-overlay-subtle px-4 py-4">
                    <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-sm font-semibold text-primary">
                      {index + 1}
                    </div>
                    <p className="text-sm leading-6 text-text-secondary">{item}</p>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-[32px] border border-border-subtle bg-background p-8 max-sm:rounded-3xl max-sm:p-6">
              <div className="dashboard-eyebrow">Trust</div>
              <div className="mt-4 space-y-4 text-sm leading-7 text-text-secondary">
                <p>Checkout runs through Stripe. DeerDawn never renders raw payment fields inside the app.</p>
                <p>If Stripe is unavailable or the session expires, the flow falls back to a clear recovery path instead of a dead-end spinner.</p>
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}

export async function getServerSideProps() {
  return { props: {} };
}

// A self-hosted install has no billing: this page renders a notice there
// instead (components/billing/SelfHostedBillingGate.tsx).
export default function Checkout() {
  return (
    <SelfHostedBillingGate standalone>
      <CheckoutPage />
    </SelfHostedBillingGate>
  );
}
