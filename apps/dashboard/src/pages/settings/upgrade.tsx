import Head from 'next/head';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useDashboardBootstrap } from '@/components/dashboard/DashboardBootstrapProvider';
import { api, type ReferralOverview } from '@/lib/api';
import { redirectToTrustedUrl } from '@/lib/redirects';
import { showToast } from '@/components/ui/Toast';
import { trackProductEvent } from '@/lib/productAnalytics';
import { gaEvent } from '@/lib/gtag';
import { PRODUCT_EVENTS } from '@/lib/analyticsEvents';
import { buildInviteLink } from '@/lib/referral';
import { PageScaffold } from '@/components/dashboard/PageScaffold';
import { PRO_PLAN_NAME, PRO_VALUE_LINE, TEAM_PLAN_NAME, billingCycleOnRecord } from '@/lib/planCopy';
import { UPGRADE_PLANS, UpgradePlanCards } from '@/components/billing/UpgradePlanCards';
import { billingPageRefusal, type BillingPageRefusal } from '@/lib/billingRefusal';
import { BillingRefusalNotice } from '@/components/billing/BillingRefusalNotice';
import { SelfHostedBillingGate } from '@/components/billing/SelfHostedBillingGate';

function formatRewardTierLabel(tier: string | null | undefined) {
  if (tier === 'developer_basic') return PRO_PLAN_NAME;
  if (!tier) return 'Premium';
  return tier.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function UpgradePagePage() {
  const router = useRouter();
  const { bootstrap } = useDashboardBootstrap();
  const currentTier = bootstrap?.org?.plan_tier ?? 'free';
  const stripeCustomerId = bootstrap?.org?.stripe_customer_id ?? null;
  const teamTrialStartedAt = bootstrap?.org?.team_trial_started_at ?? null;
  // What the workspace is billed on, read off its billing period — never off
  // the toggle below, which is for the plans it could move to.
  const currentCycle = billingCycleOnRecord(bootstrap?.org);
  const [redirecting, setRedirecting] = useState<string | null>(null);
  const [referrals, setReferrals] = useState<ReferralOverview | null>(null);
  const [billing, setBilling] = useState<'monthly' | 'annual'>('annual');
  // An upgrade refused because the bank must confirm it, or a payment is overdue.
  const [billingRefusal, setBillingRefusal] = useState<BillingPageRefusal | null>(null);
  const trigger = typeof router.query.trigger === 'string' ? router.query.trigger : '';
  const usageLimitTriggered = trigger === 'usage_limit';

  useEffect(() => {
    api.getReferralOverview().then(setReferrals).catch(() => {});
  }, []);

  // The at-limit / organic upgrade page is the single highest-intent free→paid
  // moment; capture the view (with its trigger) so the funnel is measurable.
  useEffect(() => {
    if (!router.isReady) return;
    trackProductEvent(PRODUCT_EVENTS.upgradeViewed, {
      source: 'dashboard',
      path: '/settings/upgrade',
      metadata: { trigger: trigger || 'organic', current_tier: currentTier },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady]);

  async function handleUpgrade(tierId: string) {
    if (tierId === 'free') return;
    setRedirecting(tierId);
    try {
      const checkoutBilling = billing;
      // Per-seat plans open Stripe already showing the floor rather than one
      // seat the buyer has to correct. stripeService clamps to the same
      // minimum_seats regardless, so this is the courtesy, not the enforcement.
      const seats = UPGRADE_PLANS.find((p) => p.id === tierId)?.minSeats;
      // Fire BEFORE the Stripe redirect — this click was previously uninstrumented,
      // so the highest-intent step of the revenue funnel was invisible.
      trackProductEvent(PRODUCT_EVENTS.checkoutStarted, {
        source: 'dashboard',
        path: '/settings/upgrade',
        metadata: { plan: tierId, billing: checkoutBilling, surface: 'upgrade', trigger: trigger || 'organic', seats: seats ?? 1 },
      });
      gaEvent('checkout_started', { tier: tierId, billing: checkoutBilling });
      const result = await api.upgrade(tierId, checkoutBilling, undefined, undefined, seats);
      if (result.url) {
        redirectToTrustedUrl(result.url);
        return;
      }
      // The workspace's existing subscription was moved onto this plan rather
      // than a second one being opened, so there is no Stripe page to visit.
      showToast(result.message || 'Your plan has been updated.', 'success');
      router.reload();
    } catch (e) {
      const refusal = billingPageRefusal(e);
      setBillingRefusal(refusal);
      if (!refusal) showToast(e instanceof Error ? e.message : 'Could not start upgrade', 'error');
      setRedirecting(null);
    }
  }

  async function handlePortal() {
    setRedirecting('portal');
    try {
      const { url } = await api.getPortalUrl();
      redirectToTrustedUrl(url);
    } catch {
      showToast('Could not open billing portal', 'error');
      setRedirecting(null);
    }
  }

  return (
    <>
      <Head>
        <title>Upgrade | DeerDawn</title>
      </Head>

      <PageScaffold
        // Kept, because it is the one eyebrow that is STATE rather than a category:
        // it says why you were sent here. The non-triggered branch had nothing to
        // add over the title, so it now passes nothing.
        eyebrow={usageLimitTriggered ? 'Plan limit reached' : undefined}
        title={usageLimitTriggered ? 'You’ve outgrown Free.' : 'Permanent memory. Every project.'}
        description={
          usageLimitTriggered
            ? 'Upgrade for unlimited projects and permanent memory — nothing gets deleted, and everything comes back into your briefs the moment you do.'
            : `Free includes unlimited projects with 90 days of memory. ${PRO_PLAN_NAME} adds ${PRO_VALUE_LINE}, across every AI tool you use.`
        }
      >
        <div>
          {/* Billing toggle */}
          <div className="mt-6 inline-flex items-center gap-0.5 rounded-[10px] border border-border-subtle bg-overlay-subtle p-[3px]">
            {(['monthly', 'annual'] as const).map((cycle) => (
              <button
                key={cycle}
                onClick={() => {
                  if (cycle !== billing) trackProductEvent('billing_period_changed', { source: 'dashboard', path: '/settings/upgrade', metadata: { billing: cycle, surface: 'upgrade', trigger: trigger || 'organic' } });
                  setBilling(cycle);
                }}
                className="cursor-pointer rounded-lg border-none px-4 py-1.5 text-[13px] font-medium transition-all duration-150 ease-[ease]"
                style={{
                  background: billing === cycle ? 'var(--overlay-strong)' : 'transparent',
                  color: billing === cycle ? 'var(--text-primary)' : 'var(--text-muted)',
                }}
              >
                {cycle === 'monthly' ? 'Monthly' : 'Annual'}
              </button>
            ))}
          </div>
        </div>

        {billingRefusal ? (
          <div className="mt-6 max-w-[640px]">
            <BillingRefusalNotice refusal={billingRefusal} onOpenBilling={() => void handlePortal()} opening={redirecting === 'portal'} />
          </div>
        ) : null}

        {/* Pricing cards */}
        <UpgradePlanCards
          billing={billing}
          currentTier={currentTier}
          currentCycle={currentCycle}
          stripeCustomerId={stripeCustomerId}
          teamTrialStartedAt={teamTrialStartedAt}
          redirecting={redirecting}
          onUpgrade={handleUpgrade}
          onPortal={handlePortal}
        />

        {/* Footer note */}
        <p className="mt-8 text-center text-[12px] text-text-muted">
          Secure checkout via Stripe · Cancel anytime · Instant access. {PRO_PLAN_NAME} and {TEAM_PLAN_NAME} both support monthly or annual billing.{' '}
          <a href="mailto:support@deerdawn.com" className="text-primary no-underline">Questions? Email us.</a>
        </p>

        {/* Referral */}
        {referrals && referrals.eligible && referrals.referral_code && (
          <div className="mt-12 border-t border-border-subtle pt-10">
            <div className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
              Referral
            </div>
            <h2 className="m-0 mb-4 text-[22px] font-bold tracking-[-0.03em] text-text-primary">
              Invite a friend: they get {referrals.reward_days} days of {formatRewardTierLabel(referrals.reward_tier)} now, you get {referrals.reward_days} more when they sync
            </h2>
            <div className="mb-4 flex max-w-[520px] items-center gap-3 rounded-xl border border-border-subtle bg-overlay-subtle px-[18px] py-3.5">
              <span className="flex-1 truncate font-[monospace] text-[13px] text-text-secondary">{buildInviteLink(referrals.referral_code ?? '')}</span>
              <button
                onClick={() => { navigator.clipboard.writeText(buildInviteLink(referrals.referral_code ?? '')); showToast('Copied invite link', 'success'); trackProductEvent('referral_link_copied', { source: 'dashboard', path: '/settings/upgrade', metadata: { surface: 'upgrade' } }); }}
                className="cursor-pointer whitespace-nowrap rounded-lg border border-primary/30 bg-transparent px-3 py-[5px] text-[12px] font-semibold text-primary"
              >
                Copy invite link
              </button>
            </div>
            {!referrals.referrals?.length ? (
              <p className="m-0 text-[13px] text-text-muted">
                No referrals yet. Your friend gets a free month of {PRO_PLAN_NAME} when they sign up with your link, and you get a month when their first brief syncs.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {referrals.referrals.slice(0, 5).map((item) => (
                  <div key={item.referral_id} className="flex justify-between border-b border-border-subtle pb-2 text-[13px] text-text-muted">
                    <span className="capitalize text-text-secondary">{item.status.replace(/_/g, ' ')}</span>
                    {item.reward_expires_at && <span>Reward until {new Date(item.reward_expires_at).toLocaleDateString()}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </PageScaffold>
    </>
  );
}

// A self-hosted install has no billing: this page renders a notice there
// instead (components/billing/SelfHostedBillingGate.tsx).
export default function UpgradePage() {
  return (
    <SelfHostedBillingGate>
      <UpgradePagePage />
    </SelfHostedBillingGate>
  );
}
