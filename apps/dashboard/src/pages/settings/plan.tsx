import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { PageScaffold, SurfacePanel, InlineErrorState } from '@/components/dashboard/PageScaffold';
import { Button } from '@/components/ui/Button';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { api } from '@/lib/api';
import type { OrgUsageSummary } from '@/lib/api';
import { logger } from '@/lib/logger';
import { redirectToTrustedUrl } from '@/lib/redirects';
import { showToast } from '@/components/ui/Toast';
import { siteConfig } from '@/lib/siteConfig';
import { trackProductEvent } from '@/lib/productAnalytics';
import { gaEvent } from '@/lib/gtag';
import { PRODUCT_EVENTS } from '@/lib/analyticsEvents';
import {
  PRO_PLAN_NAME,
  TEAM_MIN_SEATS,
  TEAM_PLAN_NAME,
  describeFreeBound,
  minSeatsFor,
} from '@/lib/planCopy';
import { teamTrialApplies, upgradeTargetsFor } from '@/lib/billingOffer';
import { billingPageRefusal, type BillingPageRefusal } from '@/lib/billingRefusal';
import { BillingRefusalNotice } from '@/components/billing/BillingRefusalNotice';
import { PlanBillingFacts } from '@/components/billing/PlanBillingFacts';
import { BillingOwnerPanel, SeatShortfallNotice } from '@/components/billing/BillingOwnerPanel';
import type { BillingOwnerAction } from '@/lib/billingOwner';
import { planFirstPaymentCard, planStatusLabel } from '@/lib/planBilling';
import { SelfHostedBillingGate } from '@/components/billing/SelfHostedBillingGate';

const ORGANIZATION_PLANS = ['free', 'starter', 'growth', 'scale', 'pilot', 'enterprise'];

const PLAN_DISPLAY_NAME: Record<string, string> = {
  developer_basic: PRO_PLAN_NAME,
  developer_pro: TEAM_PLAN_NAME,
};

// Post-checkout success (purchase conversion + confirmation) is handled on the
// home graph by UpgradeSuccessModal — Stripe redirects there, not here.

function PlanSettingsPage() {
  const router = useRouter();
  const confirm = useConfirm();
  const [data, setData] = useState<OrgUsageSummary | null>(null);
  const [usageLoadedAt, setUsageLoadedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Which async billing action is mid-redirect, so only that button spins while
  // the rest lock to prevent a double-submit. null = idle.
  const [pending, setPending] = useState<string | null>(null);
  const busy = pending !== null;
  // An upgrade refused because the bank must confirm it, or a payment is overdue.
  const [billingRefusal, setBillingRefusal] = useState<BillingPageRefusal | null>(null);

  const loadUsage = () => {
    setLoading(true);
    setLoadError(null);
    api.getUsage()
      .then((usage) => {
        setData(usage);
        setUsageLoadedAt(Date.now());
      })
      .catch((error) => {
        logger.error('plan_usage_load_failed', error);
        setLoadError(error instanceof Error ? error.message : 'Could not load your plan. Please try again.');
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadUsage();
  }, []);

  // BACK FROM STRIPE'S CARD PAGE: a takeover this person started is read back
  // once, so they do not have to know to press a button. Only when one is
  // pending and theirs; the answer is the same read the button makes.
  const [takeoverChecked, setTakeoverChecked] = useState(false);
  useEffect(() => {
    if (takeoverChecked || !data?.plan.takeover?.pending || !data.plan.takeover.started_by_you) return;
    setTakeoverChecked(true);
    api.confirmBillingTakeover()
      .then((result) => {
        if (result.status === 'confirmed') {
          showToast('You are now the billing owner of this workspace.', 'success');
          loadUsage();
        }
      })
      .catch((error) => logger.error('billing_takeover_check_failed', error));
  }, [data, takeoverChecked]);

  // Who pays: take billing over, read the takeover back, or end the subscription
  // at the close of the paid period (the payer's own way out).
  const handleBillingOwnerAction = async (action: BillingOwnerAction) => {
    if (action === 'end_at_period_end') {
      const ok = await confirm({
        title: 'End the subscription at the close of the period?',
        body: 'Nothing more will be charged after the paid period ends, and the workspace goes back to Free then. Until then it keeps working. You can undo this in the billing portal before it ends.',
        confirmLabel: 'End at the close of the period',
        cancelLabel: 'Keep the subscription',
        destructive: true,
      });
      if (!ok) return;
    }
    setPending(action);
    gaEvent('billing_owner_action', { action });
    try {
      if (action === 'take_over') {
        const { url } = await api.startBillingTakeover();
        redirectToTrustedUrl(url);
        return;
      }
      if (action === 'confirm_takeover') {
        const result = await api.confirmBillingTakeover();
        showToast(
          result.status === 'confirmed'
            ? 'You are now the billing owner of this workspace.'
            : result.status === 'not_applied'
              ? 'The takeover could not be completed. Start it again.'
              : 'The card that was paying is still the one being charged. Change the payment method in the billing portal, then check again.',
          result.status === 'confirmed' ? 'success' : 'error',
        );
      } else {
        const result = await api.cancelAtPeriodEnd();
        showToast(result.message, 'success');
      }
      loadUsage();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not make that change. Please try again.', 'error');
      logger.error('billing_owner_action_failed', error, { action });
    } finally {
      setPending(null);
    }
  };

  const handleUpgrade = async (tierId: string) => {
    setPending(`upgrade:${tierId}`);
    setBillingRefusal(null);
    // Product + GA4 funnel: user kicked off checkout (about to redirect to Stripe).
    // Same canonical event the /settings/upgrade and select-plan surfaces fire,
    // so free→paid is one measurable path regardless of entry point.
    // Per-seat plans open Stripe at the plan's floor rather than one seat.
    // stripeService clamps to the same number regardless; sending it means the
    // quantity does not change under the buyer on Stripe's own page.
    const seats = minSeatsFor(tierId);
    trackProductEvent(PRODUCT_EVENTS.checkoutStarted, {
      source: 'dashboard',
      path: '/settings/plan',
      metadata: { plan: tierId, surface: 'billing', seats },
    });
    gaEvent('checkout_started', { tier: tierId });
    try {
      // No cadence: this page has no billing toggle, so it must not choose one.
      // Sending 'monthly' here would have moved an annual subscriber onto
      // monthly billing as a side effect of upgrading their plan.
      const result = await api.upgrade(tierId, undefined, undefined, undefined, seats);
      if (result.url) {
        redirectToTrustedUrl(result.url);
        return;
      }
      // No URL means the workspace already had a live subscription and the API
      // moved THAT one onto the new plan, prorated. There is nothing to visit,
      // and sending the buyer to Stripe anyway is what opened a second one.
      showToast(result.message || `You're on ${PLAN_DISPLAY_NAME[tierId] || tierId} now.`, 'success');
      loadUsage();
      setPending(null);
    } catch (error) {
      const refusal = billingPageRefusal(error);
      setBillingRefusal(refusal);
      if (refusal) {
        setPending(null);
        return;
      }
      const msg = error instanceof Error ? error.message : 'Failed to start upgrade process';
      showToast(msg, 'error');
      logger.error('billing_upgrade_failed', error, { tierId });
      setPending(null);
    }
  };

  // One handler backs every self-serve billing action. `flow` deep-links the
  // Stripe customer portal straight into a specific task (update card / cancel);
  // omitting it lands on the portal home (invoices, plan changes, everything).
  const openPortal = async (flow?: 'payment_method' | 'cancel') => {
    const action = flow ?? 'manage';
    setPending(action);
    gaEvent('billing_portal_opened', { flow: action });
    try {
      const { url } = await api.getPortalUrl(flow);
      redirectToTrustedUrl(url);
    } catch (error) {
      showToast('Couldn’t open the billing portal. Please try again or email support.', 'error');
      logger.error('billing_portal_failed', error, { flow: action });
      setPending(null);
    }
  };

  const handleContactSales = () => {
    window.location.href = `${siteConfig.ACTIVE_SITE_URL}/contact`;
  };

  const emailSupport = (subject: string) => {
    window.location.href = `mailto:support@deerdawn.com?subject=${encodeURIComponent(subject)}`;
  };

  // Self-serve drop to Free for accounts with no Stripe subscription. Confirmed
  // first because it takes effect immediately and a comped plan can't be
  // re-granted self-serve. On success we refetch so the card re-renders as Free.
  const handleDowngrade = async (label: string) => {
    const ok = await confirm({
      title: 'Downgrade to Free?',
      body: `This moves you from ${label} to the Free plan right away. You keep your saved memory, but paid limits and features end immediately, and a comped plan can't be re-enabled without contacting support.`,
      confirmLabel: 'Downgrade to Free',
      cancelLabel: 'Keep my plan',
      destructive: true,
    });
    if (!ok) return;
    setPending('downgrade');
    gaEvent('billing_downgrade', { from_tier: label });
    try {
      await api.downgradeToFree();
      showToast('You’re now on the Free plan.', 'success');
      const fresh = await api.getUsage();
      setData(fresh);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Couldn’t change your plan. Please try again or email support.';
      showToast(msg, 'error');
      logger.error('billing_downgrade_failed', error);
    } finally {
      setPending(null);
    }
  };

  if (!loading && loadError && !data) {
    return (
      <div className="dashboard-center">
        <div className="w-full max-w-2xl">
          <InlineErrorState title="Couldn't load your plan" description={loadError} onRetry={loadUsage} />
        </div>
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div className="dashboard-center">
        <div className="dashboard-surface space-y-3 p-6">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-xl border border-border-subtle bg-overlay-subtle" />
          ))}
        </div>
      </div>
    );
  }

  const { plan, limits, account_type } = data;
  /**
   * The workspace this page describes — and the one every button on it spends
   * money in. They used to be two different things: /billing/checkout targets
   * the BOUND workspace while GET /orgs/usage read the personal org, so this
   * card could describe your own Free account beside an Upgrade button that
   * charged the team. Naming it is the part that makes the fix visible; a silent
   * correction would leave the same screen looking exactly as it did when it was
   * wrong.
   */
  const workspaceLabel = data.org_name || data.workspace || null;
  const isSharedWorkspace = data.is_personal_workspace === false;
  const isOrganizationPlan = account_type === 'organization' || (plan.tier !== 'free' && ORGANIZATION_PLANS.includes(plan.tier));
  /**
   * Everything above the current plan that has a cart.
   *
   * This was `plan.tier === 'free' ? 'developer_basic' : null` — one target, and
   * only from Free. A Pro subscriber had no path to Team anywhere in the
   * product: this page showed them the portal, /settings/upgrade showed Team's
   * card but marketing's CTA lands on /checkout, and /checkout refused the plan
   * outright. Team was purchasable from the API and from nowhere a customer
   * could reach.
   */
  //
  // Decided from the TIER, in lib/billingOffer. It was also gated on
  // `isOrganizationPlan`, which is true for every workspace the new-team wizard
  // makes (free + account_type 'organization') — so the workspace that exists
  // to be upgraded to Team was the one whose billing page offered no upgrade.
  const upgradeTargets = upgradeTargetsFor({
    tier: plan.tier,
    isPersonalWorkspace: data.is_personal_workspace,
  });
  const selfServeTarget = upgradeTargets[0] || null;
  const supportsSelfServeUpgrade = upgradeTargets.length > 0;
  // A Stripe customer id means self-serve subscription management (change plan,
  // update card, invoices, cancel) is available through the billing portal.
  const hasBillingPortal = Boolean(plan.stripe_customer_id);

  const planLabel = plan.public_name || plan.tier;
  const isFreeTier = plan.tier === 'free';
  const historyDays = limits.history_days ?? null;
  const projectLimit = limits.projects ?? null;

  // Value ledger: memory framed as accrued wealth, never a countdown toward a
  // cap. Paid plans have no meters — nothing on Pro runs out.
  const ledger = data.ledger;
  const memorySpanDays = ledger?.oldest_memory_at && usageLoadedAt
    ? Math.max(1, Math.floor((usageLoadedAt - new Date(ledger.oldest_memory_at).getTime()) / 86400000))
    : null;
  const ledgerTiles = ledger
    ? [
      {
        label: 'Briefs delivered',
        value: ledger.briefs_all_time.toLocaleString(),
        detail: `${ledger.briefs_this_period.toLocaleString()} this billing cycle`,
      },
      {
        label: 'Decisions remembered',
        value: ledger.decisions_remembered.toLocaleString(),
        detail: historyDays
          ? `The last ${historyDays} days reach your briefs on ${planLabel}`
          : 'Every one of them reaches your briefs',
      },
      {
        label: 'Memory span',
        value: memorySpanDays ? `${memorySpanDays.toLocaleString()} days` : '—',
        detail: ledger.oldest_memory_at
          ? `Oldest memory: ${new Date(ledger.oldest_memory_at).toLocaleDateString()}`
          : 'Your first sync starts the clock',
      },
      {
        label: 'Projects',
        value: ledger.projects.toLocaleString(),
        detail: projectLimit != null
          ? `${planLabel} includes ${projectLimit === 1 ? 'one project brief' : `${projectLimit} project briefs`}`
          : 'Unlimited project briefs',
      },
    ]
    : [];

  // NULL IS UNLIMITED, NOT MISSING. `included_projects` is null on Free (the
  // workspace cap was removed on 2026-08-27) and orgs.js passes the null
  // through, so `?? 3` invented a cap that has not existed for a month, printed
  // directly above a tile that reads "Unlimited project briefs". `?? 7` was the
  // same: the history window is 90 days. Both numbers come from the live
  // entitlement through describeFreeBound, which is the one place that knows how
  // to say "unlimited" — and which is also correct during a referral month,
  // where plan_tier still reads 'free' while the limits are Pro's.
  const freeBound = describeFreeBound({ included_projects: projectLimit, history_days: historyDays });
  const planPromiseLine = isFreeTier
    ? `${freeBound || 'Free keeps every project, and nothing you have recorded ages out of your briefs.'} Briefs are unlimited, so nothing you use runs out.`
    : `Unlimited briefs, unlimited projects, permanent memory — nothing on ${planLabel} runs out.`;

  type BillingAction = {
    id: string;
    label: string;
    onClick: () => void;
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    // Only Stripe redirects go through `pending`; instant nav/mailto actions don't.
    spins?: boolean;
  };

  let billingHeading: string;
  let billingBlurb: string;
  let billingActions: BillingAction[];

  const firstPayment = planFirstPaymentCard({
    tier: plan.tier,
    status: plan.status,
    purchased_seats: plan.purchased_seats,
  });

  if (firstPayment) {
    // The first payment never went through: nothing was ever collected, so the
    // way out is a new checkout for the same plan, not the billing portal.
    billingHeading = firstPayment.heading;
    billingBlurb = firstPayment.blurb;
    billingActions = [
      { id: 'check_out_again', label: firstPayment.actionLabel, onClick: () => router.push(firstPayment.href), variant: 'primary' },
    ];
  } else if (hasBillingPortal) {
    // Real Stripe subscriber — full self-serve management, each button deep-linked
    // into the matching portal flow so it's one click, not a scavenger hunt.
    billingHeading = 'Manage your subscription';
    billingBlurb = 'Update your card, download invoices, switch plans, or cancel — all self-serve, no email required.';
    billingActions = [
      { id: 'manage', label: 'Manage subscription & invoices', onClick: () => openPortal(), variant: 'primary', spins: true },
      // A paying subscriber with somewhere left to go. The API moves an existing
      // subscription rather than opening a second one, so this is an upgrade,
      // not a second charge — see /billing/checkout.
      ...upgradeTargets.map((target): BillingAction => ({
        id: `upgrade:${target}`,
        label: `Upgrade to ${PLAN_DISPLAY_NAME[target] || target}`,
        onClick: () => handleUpgrade(target),
        variant: 'secondary',
        spins: true,
      })),
      { id: 'payment_method', label: 'Update payment method', onClick: () => openPortal('payment_method'), variant: 'secondary', spins: true },
      { id: 'change', label: 'Change plan', onClick: () => router.push('/select-plan'), variant: 'secondary' },
      { id: 'cancel', label: 'Cancel subscription', onClick: () => openPortal('cancel'), variant: 'danger', spins: true },
    ];
  } else if (supportsSelfServeUpgrade && selfServeTarget) {
    // Free tier that can upgrade itself — to Pro, or straight to Team.
    billingHeading = 'Upgrade your plan';
    billingBlurb = 'Unlimited projects and permanent memory — every decision stays in your brief forever.';
    billingActions = [
      ...upgradeTargets.map((target, index): BillingAction => ({
        id: `upgrade:${target}`,
        // The trial is only promised to a workspace that will actually get
        // one — see teamTrialApplies. This branch has no Stripe customer, so
        // today that is always true; asking keeps it true if the branch moves.
        label: teamTrialApplies({ targetPlan: target, currentTier: plan.tier, stripeCustomerId: plan.stripe_customer_id, teamTrialStartedAt: plan.team_trial_started_at })
          ? `Try ${TEAM_PLAN_NAME} free — ${TEAM_MIN_SEATS} seats minimum`
          : `Upgrade to ${PLAN_DISPLAY_NAME[target] || target}`,
        onClick: () => handleUpgrade(target),
        variant: index === 0 ? 'primary' : 'secondary',
        spins: true,
      })),
      { id: 'compare', label: 'Compare all plans', onClick: () => router.push('/select-plan'), variant: 'secondary' },
    ];
  } else if (isOrganizationPlan) {
    // Team / org plan with no Stripe subscription (comped / manually managed).
    // Never one-click-strip a shared workspace — route change/cancel to a human.
    billingHeading = 'Manage your plan';
    billingBlurb = `You're on ${planLabel}, managed with the DeerDawn team. Track your usage, compare plans, or reach us to change or cancel.`;
    billingActions = [
      { id: 'usage', label: 'See usage & value', onClick: () => router.push('/settings/usage'), variant: 'primary' },
      { id: 'compare', label: 'Compare all plans', onClick: () => router.push('/select-plan'), variant: 'secondary' },
      { id: 'contact-sales', label: 'Talk to sales about your team', onClick: handleContactSales, variant: 'ghost' },
      { id: 'change-cancel', label: 'Change or cancel your plan', onClick: () => emailSupport(`Plan change / cancellation — ${planLabel}`), variant: 'ghost' },
    ];
  } else {
    // Personal paid tier with no Stripe subscription (comped / Founding). Billing
    // isn't self-serve, but the account is a single workspace — so a real
    // Downgrade to Free (confirmed) belongs here instead of a support email.
    billingHeading = 'Your plan';
    billingBlurb = `You're on ${planLabel}, managed by the DeerDawn team. Track your usage, compare plans, or downgrade to Free anytime.`;
    billingActions = [
      { id: 'usage', label: 'See usage & value', onClick: () => router.push('/settings/usage'), variant: 'primary' },
      { id: 'compare', label: 'Compare all plans', onClick: () => router.push('/select-plan'), variant: 'secondary' },
      { id: 'downgrade', label: 'Downgrade to Free', onClick: () => handleDowngrade(planLabel), variant: 'danger', spins: true },
    ];
  }

  return (
    <>
      <Head>
        <title>Billing | DeerDawn</title>
      </Head>

      <PageScaffold
        title="Plan & memory"
        description="Your plan, and the memory DeerDawn has built up for you."
      >
        <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
          <div className="space-y-6">
            <SurfacePanel className="p-6 lg:p-8">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="dashboard-eyebrow">
                    {workspaceLabel ? `Current plan · ${workspaceLabel}` : 'Current plan'}
                  </div>
                  <h2 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-text-primary">{plan.public_name || plan.tier}</h2>
                  {isSharedWorkspace ? (
                    <p className="mt-2 text-sm leading-7 text-text-secondary">
                      This is a shared workspace, not your personal account. Anything you change here — the plan, the card,
                      a cancellation — applies to <span className="text-text-primary">{workspaceLabel}</span>.
                    </p>
                  ) : null}
                  <p className="mt-2 text-sm leading-7 text-text-secondary">
                    Status: <span className="text-text-primary">{planStatusLabel(plan.status)}</span>
                  </p>
                  {/* What this workspace pays, from its subscription as recorded:
                      price, cycle, seats, period or trial end, renewal amount. */}
                  <PlanBillingFacts plan={plan} />
                  {/* More people than paid seats: the owner is told, nobody is
                      locked out. */}
                  {plan.billing_owner?.can_manage ? (
                    <SeatShortfallNotice
                      shortfall={plan.seat_shortfall}
                      action={<Link href="/settings/team" className="text-primary hover:underline">Open the team page</Link>}
                    />
                  ) : null}
                  <p className="mt-2 text-sm leading-7 text-text-secondary">{planPromiseLine}</p>
                  {plan.referral_premium_active ? (
                    <p className="mt-2 text-sm leading-7 text-primary">
                      Referral premium active until {plan.referral_premium_until ? new Date(plan.referral_premium_until).toLocaleString() : 'soon'}.
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="mt-8 grid gap-4 sm:grid-cols-2">
                {ledgerTiles.map((tile) => (
                  <div key={tile.label} className="rounded-2xl border border-border-subtle bg-overlay-subtle p-4">
                    <div className="text-sm font-semibold text-text-primary">{tile.label}</div>
                    <div className="mt-2 font-mono text-2xl text-text-primary">{tile.value}</div>
                    <div className="mt-1 text-xs leading-5 text-text-secondary">{tile.detail}</div>
                  </div>
                ))}
              </div>
            </SurfacePanel>

          </div>

          <SurfacePanel className="p-6 lg:p-8">
            <div className="dashboard-eyebrow">Billing &amp; plan</div>
            <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-text-primary">{billingHeading}</h2>
            <p className="mt-3 text-sm leading-7 text-text-secondary">{billingBlurb}</p>
            {/* The button and the card above it now read the same workspace.
                Saying so where the money is spent is the difference between a
                fixed bug and a fix nobody can see. */}
            {workspaceLabel ? (
              <p className="mt-2 text-sm leading-7 text-text-muted">
                Changes apply to <span className="text-text-primary">{workspaceLabel}</span>.
              </p>
            ) : null}

            {billingRefusal ? (
              <div className="mt-6">
                <BillingRefusalNotice refusal={billingRefusal} onOpenBilling={() => openPortal()} opening={pending === 'manage'} />
              </div>
            ) : null}

            <div className="mt-6 flex flex-col gap-3">
              {billingActions.map((action) => (
                <Button
                  key={action.id}
                  variant={action.variant ?? 'secondary'}
                  onClick={action.onClick}
                  disabled={busy}
                  isLoading={action.spins ? pending === action.id : false}
                >
                  {action.label}
                </Button>
              ))}
            </div>

            <BillingOwnerPanel plan={plan} pending={pending} onAction={handleBillingOwnerAction} />

            <div className="mt-6 border-t border-border-subtle pt-4">
              <p className="text-xs leading-6 text-text-secondary">
                Something wrong with your billing?{' '}
                <a href="mailto:support@deerdawn.com" className="text-primary hover:underline">Contact support</a>.
              </p>
            </div>
          </SurfacePanel>
        </div>
      </PageScaffold>
    </>
  );
}

// A self-hosted install has no billing: this page renders a notice there
// instead (components/billing/SelfHostedBillingGate.tsx).
export default function PlanSettings() {
  return (
    <SelfHostedBillingGate>
      <PlanSettingsPage />
    </SelfHostedBillingGate>
  );
}
