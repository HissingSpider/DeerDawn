import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import type { DashboardBootstrap } from '@/lib/api';
import { planBadgeLabel, isPaidTier } from '@/lib/planLabels';
import { PRICE_ANNUAL, PRICE_MONTHLY, TEAM_PRICE_ANNUAL, TEAM_PRICE_MONTHLY, TEAM_MIN_SEATS, TEAM_TRIAL_DAYS } from '@/lib/planCopy';
import { trackProductEvent } from '@/lib/productAnalytics';
import { fireConversion, GADS_LABELS, gaEvent } from '@/lib/gtag';
import { PRODUCT_EVENTS } from '@/lib/analyticsEvents';
import { Modal } from '@/components/ui/Modal';

// Stripe redirects back to `/?upgrade=success&session_id=...&tier=...&billing=...`
// after a completed payment (see stripeService.createCheckoutSession). This is
// the reliable client-side fire point for the purchase conversion — dedup on the
// Stripe session id so a refresh does not double-count.
const PURCHASE_FIRED_PREFIX = 'dd_purchase_completed_';

// Conversion value by tier + billing (USD), for Google Ads value reporting.
// Stripe remains the source of truth for what was actually charged.
//
// Derived rather than typed. These were the literals 96 and 10, and 10 is the
// SUPERSEDED price — Pro moved to $12 on 2026-08-27 and every display surface
// followed, so the bidding signal was quietly reporting a number the product no
// longer charges. CI already pins planCopy to plans.js, so taking the value from
// there means the repoint of STRIPE_PRICE_DEVELOPER_BASIC carries this with it
// instead of leaving one more literal behind.
function purchaseValue(tier: string | null, billing: string | null): number | undefined {
  if (tier === 'developer_basic') return billing === 'annual' ? PRICE_ANNUAL : PRICE_MONTHLY;
  // Per-seat, valued at the checkout's seat floor: the buyer bought AT LEAST
  // this many seats, so it is the most conservative honest number the browser
  // can know (the real count lives on the Stripe subscription, server-side).
  if (tier === 'developer_pro') return (billing === 'annual' ? TEAM_PRICE_ANNUAL : TEAM_PRICE_MONTHLY) * TEAM_MIN_SEATS;
  if (tier === 'lifetime') return 250;
  return undefined;
}

export function UpgradeSuccessModal({ bootstrap }: { bootstrap: DashboardBootstrap }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const firedRef = useRef(false);

  const isSuccess = router.query.upgrade === 'success';
  const sessionId = typeof router.query.session_id === 'string' ? router.query.session_id : '';
  const tier = typeof router.query.tier === 'string' ? router.query.tier : null;
  const billing = typeof router.query.billing === 'string' ? router.query.billing : null;
  // Stamped by createCheckoutSession when the plan granted a free trial: this
  // checkout collected a card and $0, and the modal must not claim "Payment
  // complete" about a payment that has not happened.
  const isTrial = router.query.trial === '1';
  // A Team purchase that creates a NEW workspace (the new-team wizard). The
  // workspace is created when Stripe confirms the subscription, so it is not in
  // the listing yet at the moment of this redirect; the wizard waits for it.
  const newWorkspace = router.query.new_workspace === '1' && typeof router.query.workspace === 'string'
    ? router.query.workspace
    : null;

  // Stripe just confirmed this purchase, so the paid tier it handed back in the
  // URL is authoritative — trust it over a bootstrap that may not have refreshed
  // yet (otherwise a stale truthy plan_tier='free' would render "You're on Free"
  // right after a successful payment). Only fall back to the live tier when the
  // URL didn't carry a paid tier.
  const resolvedTier = isPaidTier(tier) ? tier : bootstrap.org.plan_tier || tier;
  const planLabel = planBadgeLabel(resolvedTier, bootstrap.org.plan_label);

  useEffect(() => {
    if (!router.isReady || !isSuccess || !sessionId) return;
    setOpen(true);

    // Fire the purchase conversion exactly once per Stripe session.
    if (firedRef.current) return;
    const firedKey = `${PURCHASE_FIRED_PREFIX}${sessionId}`;
    if (typeof window !== 'undefined' && window.localStorage.getItem(firedKey)) return;
    firedRef.current = true;
    if (typeof window !== 'undefined') window.localStorage.setItem(firedKey, '1');

    const value = purchaseValue(tier, billing);
    trackProductEvent(PRODUCT_EVENTS.purchaseCompleted, {
      source: 'dashboard',
      path: router.pathname,
      // is_trial mirrors the server-side copy of this event (webhooks-stripe):
      // a "purchase" that collected $0 must be distinguishable from a sale on
      // both halves of the join.
      metadata: { tier, billing, value: value ?? null, transaction_id: sessionId, is_trial: isTrial },
    });
    // GA4 + Google Ads funnel: purchase complete. A trial still fires — the
    // card is on file and it converts by default at day 14 — with the value as
    // the expected floor; Stripe stays the source of truth for what was charged.
    gaEvent('purchase_completed', { tier: tier ?? undefined, billing: billing ?? undefined, value });
    fireConversion(GADS_LABELS.purchase, { value, transaction_id: sessionId });
  }, [router.isReady, router.pathname, isSuccess, sessionId, tier, billing, isTrial]);

  // The admin-onboarding handoff. A Team buyer's next step is never "explore
  // my workspace" — it is naming the shared workspace and inviting the people
  // whose context should live in it. The wizard at /settings/new-team already
  // does all of that; this is the missing route INTO it.
  const startTeamSetup = useCallback(() => {
    trackProductEvent(PRODUCT_EVENTS.teamSetupStarted, {
      source: 'dashboard',
      path: router.pathname,
      metadata: { tier, billing, is_trial: isTrial },
    });
    router.push(newWorkspace
      ? `/settings/new-team?resume=1&workspace=${encodeURIComponent(newWorkspace)}`
      : '/settings/new-team');
  }, [router, tier, billing, isTrial, newWorkspace]);

  const dismiss = useCallback(() => {
    setOpen(false);
    // Strip the checkout params so a refresh / back doesn't re-open the modal,
    // leaving the user on the home graph.
    router.replace('/', undefined, { shallow: true });
  }, [router]);

  return (
    <Modal
      open={open}
      onClose={dismiss}
      labelledById="upgrade-success-title"
      cardClassName="flex w-full max-w-[480px] flex-col items-center rounded-[28px] border border-border-subtle bg-background p-7 text-center shadow-[0_24px_80px_rgba(0,0,0,0.35)]"
    >
        {/* Success checkmark */}
        <div className="flex h-14 w-14 items-center justify-center rounded-full border border-primary/30 bg-primary/[0.12]">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6L9 17l-5-5" />
          </svg>
        </div>

        <div className="mt-5 text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
          {isTrial ? `Trial started — ${TEAM_TRIAL_DAYS} days free` : 'Payment complete'}
        </div>
        <h2 id="upgrade-success-title" className="m-0 mt-2.5 text-[30px] leading-[1.06] tracking-[-0.05em] text-text-primary">
          You’re on {planLabel}.
        </h2>
        {resolvedTier === 'developer_pro' ? (
          <>
            <p className="m-0 mt-3.5 text-[15px] leading-[1.7] text-text-secondary">
              {newWorkspace
                ? 'One brief the whole team\u2019s agents read. Your team workspace is being created now. Next: choose what moves in, and invite the people whose context belongs in it.'
                : 'One brief the whole team\u2019s agents read. Next: name the shared workspace, choose what moves in, and invite the people whose context belongs in it. It takes about two minutes.'}
            </p>
            <button
              onClick={startTeamSetup}
              className="mt-6 inline-flex w-full items-center justify-center rounded-2xl bg-primary px-4 py-3 text-sm font-semibold text-on-primary"
            >
              Set up your team
            </button>
            <button
              onClick={dismiss}
              className="mt-3 inline-flex w-full items-center justify-center rounded-2xl border border-border px-4 py-3 text-sm font-semibold text-text-primary"
            >
              Explore my workspace first
            </button>
          </>
        ) : (
          <>
            <p className="m-0 mt-3.5 text-[15px] leading-[1.7] text-text-secondary">
              Every new session starts briefed across every tool.
              Your brief keeps every AI tool you connect caught up on your project — open
              one and you&apos;re ready to go.
            </p>
            <button
              onClick={dismiss}
              className="mt-6 inline-flex w-full items-center justify-center rounded-2xl bg-primary px-4 py-3 text-sm font-semibold text-on-primary"
            >
              Explore my workspace
            </button>
          </>
        )}
    </Modal>
  );
}
