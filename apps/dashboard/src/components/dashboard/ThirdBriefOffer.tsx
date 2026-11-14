import { useEffect, useRef, useState } from 'react';
import type { DashboardBootstrap } from '@/lib/api';
import { api } from '@/lib/api';
import { redirectToTrustedUrl } from '@/lib/redirects';
import { showToast } from '@/components/ui/Toast';
import { trackProductEvent } from '@/lib/productAnalytics';
import { gaEvent } from '@/lib/gtag';
import { PRODUCT_EVENTS } from '@/lib/analyticsEvents';
import {
  claimSessionBeat,
  trackUpgradeOfferShown,
  trackUpgradeOfferClicked,
  trackUpgradeOfferDismissed,
} from '@/lib/upgradeOffer';
import { activeEnoughToAsk } from '@/lib/firstSyncMoment';
import { Modal } from '@/components/ui/Modal';
import { ANNUAL_LABEL, PRO_PLAN_NAME, PRO_VALUE_LINE, describeFreeBound } from '@/lib/planCopy';

// Ask after the value has been delivered three times, not before. The count is
// bootstrap.usage.syncs.syncs_used — a server-side COUNT of context_delivered
// events (apps/api/src/routes/shared/billing.js getUsageSummary), i.e. briefs
// that actually reached a tool, not sessions or page views.
//
// That count is scoped to the current billing period rather than all time. The
// exact all-time number exists (ledger.briefs_all_time on /api/v1/orgs/usage)
// but costs an extra request on every dashboard load; the period count is
// already in bootstrap and can only ever UNDER-count, so this ask can be late
// but never early — the safe direction for "prove it three times first".
const BRIEFS_BEFORE_ASK = 3;
const SEEN_KEY = 'dd_third_brief_offer_seen_v1';

type Offer = { briefsDelivered: number; bound: string };

export function ThirdBriefOffer({ bootstrap }: { bootstrap: DashboardBootstrap }) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [redirecting, setRedirecting] = useState(false);
  const decidedRef = useRef(false);

  const briefsDelivered = bootstrap.usage?.syncs?.syncs_used ?? 0;
  // The plan's real gates, straight from entitlements — never hard-coded, so the
  // sell screen can't claim a limit the server isn't enforcing. A referral month
  // grants Pro limits while plan_tier still reads 'free', so the limits (not the
  // tier) decide whether there is anything left to unlock.
  //
  // This USED to require both a finite history window AND a finite project cap.
  // When the project cap was removed on 2026-08-27 the second condition became
  // permanently false and the whole offer went dark for every free user —
  // silently, because a modal that never opens looks exactly like a modal nobody
  // triggered. describeFreeBound returns null only when there is genuinely
  // nothing left to sell, which is the condition that was actually meant.
  const limits = bootstrap.usage?.limits;
  const bound = describeFreeBound(limits);
  // No ask before value (Thing 3h): three briefs can land in one afternoon, so
  // the offer also waits for a third day of actual use. Per person, and false
  // when the API does not send the field.
  const activeEnough = activeEnoughToAsk(bootstrap.sync_health);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (briefsDelivered < BRIEFS_BEFORE_ASK) return;
    if (!activeEnough) return;
    if (bound === null) return;
    // StrictMode double-invokes effects in dev; decide once per mount.
    if (decidedRef.current) return;
    decidedRef.current = true;

    try {
      if (window.localStorage.getItem(SEEN_KEY)) return;
    } catch {
      /* storage may be unavailable — better to ask once more than never */
    }
    // Claimed before the once-ever key is written, so a session already spent on
    // the post-sync ask (or on the first-sync celebration) defers this to the
    // next visit instead of burning it unseen.
    if (!claimSessionBeat('third_brief')) return;
    try {
      window.localStorage.setItem(SEEN_KEY, '1');
    } catch {
      /* storage may be unavailable */
    }

    setOffer({ briefsDelivered, bound });
    trackUpgradeOfferShown('third_brief', { briefs_delivered: briefsDelivered });
  }, [briefsDelivered, bound, activeEnough]);

  if (!offer) return null;

  // Modal always closes on Escape regardless of closeOnBackdrop (ui/Modal.tsx),
  // so route every exit through one place — an Escape-dismissed offer must not
  // record a `shown` with no outcome, or ask-health reads active rejection as
  // indifference.
  const dismiss = (via: 'escape' | 'button') => {
    trackUpgradeOfferDismissed('third_brief', { briefs_delivered: offer.briefsDelivered, via });
    setOffer(null);
  };

  return (
    <Modal
      open
      onClose={() => dismiss('escape')}
      closeOnBackdrop={false}
      labelledById="third-brief-offer-title"
      cardClassName="flex w-full max-w-[520px] flex-col rounded-[28px] border border-border-subtle bg-background p-7 shadow-[0_24px_80px_rgba(0,0,0,0.35)]"
    >
      <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
        Your memory is working
      </div>
      <h2 id="third-brief-offer-title" className="m-0 mt-2.5 text-[30px] leading-[1.06] tracking-[-0.05em] text-text-primary">
        {offer.briefsDelivered} briefs delivered, and counting.
      </h2>
      <p className="m-0 mt-3.5 text-[15px] leading-[1.7] text-text-secondary">
        {offer.bound} {PRO_PLAN_NAME} is {ANNUAL_LABEL} — {PRO_VALUE_LINE}, and every new session
        briefed across every tool you connect.
      </p>

      <button
        onClick={async () => {
          setRedirecting(true);
          trackUpgradeOfferClicked('third_brief', {
            plan: 'developer_basic',
            billing: 'annual',
            briefs_delivered: offer.briefsDelivered,
          });
          trackProductEvent(PRODUCT_EVENTS.checkoutStarted, {
            source: 'dashboard',
            path: window.location.pathname,
            metadata: { plan: 'developer_basic', billing: 'annual', surface: 'third_brief', trigger: 'third_brief' },
          });
          // Same name to GA4 — this entry point joins the cross-tool checkout funnel.
          gaEvent('checkout_started', { tier: 'developer_basic', billing: 'annual' });
          try {
            const result = await api.upgrade('developer_basic', 'annual');
            // No URL means the workspace already had a live subscription and the
            // API moved it in place rather than opening a second one.
            if (result.url) redirectToTrustedUrl(result.url);
            else window.location.reload();
          } catch (err) {
            showToast(err instanceof Error ? err.message : 'Could not start upgrade', 'error');
            setRedirecting(false);
          }
        }}
        className="mt-6 inline-flex w-full items-center justify-center rounded-2xl bg-primary px-4 py-3 text-sm font-semibold text-on-primary"
      >
        {redirecting ? 'Opening Stripe…' : `Get ${PRO_PLAN_NAME} — ${ANNUAL_LABEL}`}
      </button>
      <p className="m-0 mt-2.5 text-center text-[12px] text-text-muted">
        Secure checkout via Stripe · Cancel anytime
      </p>

      <div className="mt-3 flex justify-center">
        <button
          onClick={() => dismiss('button')}
          className="cursor-pointer rounded-[10px] border border-border-strong bg-transparent px-3.5 py-[5px] text-[13px] font-medium text-text-secondary"
        >
          Keep using Free
        </button>
      </div>
    </Modal>
  );
}
