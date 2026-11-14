import { useEffect, useMemo, useRef, useState } from 'react';
import type { DashboardBootstrap, ReferralOverview } from '@/lib/api';
import { api } from '@/lib/api';
import { redirectToTrustedUrl } from '@/lib/redirects';
import { showToast } from '@/components/ui/Toast';
import { trackProductEvent } from '@/lib/productAnalytics';
import { fireConversion, GADS_LABELS, gaEvent } from '@/lib/gtag';
import { buildInviteLink } from '@/lib/referral';
import { PRODUCT_EVENTS } from '@/lib/analyticsEvents';
import { firstSyncConversionDue, postSyncStep } from '@/lib/firstSyncMoment';
import {
  claimSessionBeat,
  spendSessionBeat,
  trackUpgradeOfferShown,
  trackUpgradeOfferClicked,
  trackUpgradeOfferDismissed,
} from '@/lib/upgradeOffer';
import { Modal } from '@/components/ui/Modal';
import { ANNUAL_SAVING, PRICE_ANNUAL, PRICE_MONTHLY, PRO_PLAN_NAME, PRO_VALUE_LINE, money } from '@/lib/planCopy';

// First sync gets a celebration (no ask). The upgrade ask is deferred to a
// LATER observation (a return visit / subsequent sync) so we never collapse the
// aha moment and the monetization ask into the same beat.
const CELEBRATED_KEY = 'dd_first_sync_celebrated_v1';
const SEEN_KEY = 'dd_post_sync_modal_seen_v1';
const FIRST_SYNC_FIRED_KEY = 'dd_first_sync_completed_v1';

type Mode = 'none' | 'celebrate' | 'upgrade';
type BillingPeriod = 'annual' | 'monthly';

const PRICING: Record<BillingPeriod, { label: string; price: string; per: string; badge: string | null; description: string }> = {
  annual: {
    label: PRO_PLAN_NAME,
    price: `$${PRICE_ANNUAL}`,
    per: '/year',
    badge: `Save ${money(ANNUAL_SAVING)}`,
    description: `Full ${PRO_PLAN_NAME} access, billed yearly. Cancel anytime.`,
  },
  monthly: {
    label: `Monthly ${PRO_PLAN_NAME}`,
    price: `$${PRICE_MONTHLY}`,
    per: '/month',
    badge: null,
    description: `Full ${PRO_PLAN_NAME} access, billed monthly. Cancel anytime.`,
  },
};

export function PostSyncModal({ bootstrap }: { bootstrap: DashboardBootstrap }) {
  const [mode, setMode] = useState<Mode>('none');
  const [referrals, setReferrals] = useState<ReferralOverview | null>(null);
  const [redirecting, setRedirecting] = useState(false);
  const [billing, setBilling] = useState<BillingPeriod>('annual');
  // Both effects below decide through lib/firstSyncMoment, on whether THIS
  // person's own tool has loaded a brief. They used `has_projects` (which the
  // dashboard sets itself), then Today's everConnected (which counts the whole
  // workspace's sessions, so an invitee was celebrated for the owner's); each
  // time the celebration and both conversions fired for somebody who had
  // connected nothing.
  const referralCode = referrals?.referral_code || '';
  const decidedRef = useRef(false);

  // Fire the client-side first-sync ad/GA conversion exactly once per browser, the
  // first time we observe a successful sync. Deduped on its own key so it stays
  // independent of whether the upgrade modal itself was dismissed/seen.
  //
  // The first_sync_completed PRODUCT event is emitted authoritatively SERVER-SIDE
  // (contextSyncService → maybeEmitFirstSyncActivation, idempotent per user, on the
  // real "context delivered to a tool" moment). We deliberately do NOT emit it from
  // the client: this browser-scoped signal double-counted (fired per browser,
  // re-fired on a new device / cleared storage) and used a weaker trigger
  // (has_projects vs. real delivery), inflating and mis-dating activation. The GA4
  // event + Google Ads conversion stay client-side (they can only fire from the
  // browser); the Reddit CAPI activation mirror is server-side.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!firstSyncConversionDue(bootstrap.sync_health, Boolean(window.localStorage.getItem(FIRST_SYNC_FIRED_KEY)))) return;

    window.localStorage.setItem(FIRST_SYNC_FIRED_KEY, '1');
    // GA4 funnel + Google Ads activation conversion (client-only signals).
    gaEvent('first_sync_completed', { sync_projects: true });
    // value 5.0 matches the conversion action's configured value, and is
    // deliberately 5x Connect Attempted's 1.0 — that ratio is the whole signal
    // a value-based bid strategy would eventually learn from.
    fireConversion(GADS_LABELS.firstSync, { value: 5.0 });
  }, [bootstrap.sync_health]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Decide once per mount — React StrictMode double-invokes effects in dev,
    // which would otherwise let the second pass fall through celebrate into upgrade.
    if (decidedRef.current) return;
    const step = postSyncStep(bootstrap.sync_health, {
      celebrated: Boolean(window.localStorage.getItem(CELEBRATED_KEY)),
      offered: Boolean(window.localStorage.getItem(SEEN_KEY)),
    });
    // Not decided: nothing has reached a tool yet, so leave the decision open
    // for the bootstrap refresh that carries the first delivery.
    if (step === 'wait') return;
    decidedRef.current = true;

    // First sync EVER on this browser → celebrate and point at the graph. No
    // price, no ask — let the user feel the value first (peak-end / reciprocity).
    if (step === 'celebrate') {
      window.localStorage.setItem(CELEBRATED_KEY, '1');
      setMode('celebrate');
      // Not an ask, but it takes the session's beat so nothing asks alongside it
      // — the celebration keeps this visit to itself.
      spendSessionBeat('post_sync_celebrate');
      trackProductEvent('first_sync_celebrated', {
        source: 'dashboard',
        path: window.location.pathname,
        metadata: { surface: 'post_sync_celebrate' },
      });
      return;
    }

    // Already celebrated on a prior beat → a later sync / return visit is a fair
    // moment to surface the upgrade ask.
    if (step === 'none') return;
    // Claimed BEFORE the once-ever key is written: if another surface already
    // took this session's beat, this ask is deferred to a later visit rather
    // than spent silently on a modal nobody sees.
    if (!claimSessionBeat('post_sync_modal')) return;
    window.localStorage.setItem(SEEN_KEY, '1');
    setMode('upgrade');
    api.getReferralOverview().then(setReferrals).catch(() => {});
    trackProductEvent('post_sync_modal_viewed', {
      source: 'dashboard',
      path: window.location.pathname,
      metadata: { sync_projects: true },
    });
    trackProductEvent('upgrade_modal_viewed', {
      source: 'dashboard',
      path: window.location.pathname,
      metadata: { surface: 'post_sync_modal' },
    });
    trackUpgradeOfferShown('post_sync_modal', { billing: 'annual' });
  }, [bootstrap.sync_health]);

  const plan = useMemo(() => PRICING[billing], [billing]);

  // Modal always closes on Escape regardless of closeOnBackdrop (ui/Modal.tsx),
  // so both exits from the upgrade mode run through here: a `shown` with no
  // outcome would make an actively rejected ask look merely ignored. The
  // celebrate mode carries no ask and deliberately emits nothing.
  const dismissUpgrade = (via: 'escape' | 'button') => {
    trackUpgradeOfferDismissed('post_sync_modal', { billing, via });
    setMode('none');
  };

  if (mode === 'none') return null;

  if (mode === 'celebrate') {
    return (
      <Modal open onClose={() => setMode('none')} closeOnBackdrop={false} labelledById="postsync-celebrate-title" cardClassName="flex w-full max-w-[480px] flex-col rounded-[28px] border border-border-subtle bg-background p-7 shadow-[0_24px_80px_rgba(0,0,0,0.35)]">
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
            It’s working
          </div>
          <h2 id="postsync-celebrate-title" className="m-0 mt-2.5 text-[30px] leading-[1.06] tracking-[-0.05em] text-text-primary">
            Your first context is live.
          </h2>
          <p className="m-0 mt-3.5 text-[15px] leading-[1.7] text-text-secondary">
            Your context graph is filling in now — every AI tool you connect can load this project automatically, every session. Take a look around.
          </p>
          <button
            onClick={() => setMode('none')}
            className="mt-6 inline-flex w-full items-center justify-center rounded-2xl bg-primary px-4 py-3 text-sm font-semibold text-on-primary"
          >
            Explore my graph
          </button>
      </Modal>
    );
  }

  return (
    <Modal open onClose={() => dismissUpgrade('escape')} closeOnBackdrop={false} labelledById="postsync-upgrade-title" cardClassName="flex w-full max-w-[560px] flex-col rounded-[28px] border border-border-subtle bg-background p-7 shadow-[0_24px_80px_rgba(0,0,0,0.35)]">
        <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
          You’re getting value from DeerDawn
        </div>
        <h2 id="postsync-upgrade-title" className="m-0 mt-2.5 text-[32px] leading-[1.05] tracking-[-0.05em] text-text-primary">
          Never start cold — without limits.
        </h2>
        <p className="m-0 mt-3.5 text-[15px] leading-[1.7] text-text-secondary">
          {PRO_PLAN_NAME} adds {PRO_VALUE_LINE}, and a brief that every new session picks up across every AI tool.
        </p>

        {referralCode ? (
          <div className="mt-[22px] rounded-[18px] border border-border-subtle bg-overlay-subtle p-4">
            <div className="mb-2 text-[12px] font-semibold text-text-secondary">Or invite a friend: they get a free month of {PRO_PLAN_NAME}, and you get one when their first brief syncs</div>
            <div className="flex items-center gap-3">
              <div className="flex-1 truncate text-[13px] text-text-secondary [font-family:monospace]">{buildInviteLink(referralCode)}</div>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(buildInviteLink(referralCode));
                  showToast('Copied invite link', 'success');
                  trackProductEvent('referral_link_copied', {
                    source: 'dashboard',
                    path: window.location.pathname,
                    metadata: { surface: 'post_sync_modal' },
                  });
                }}
                className="whitespace-nowrap rounded-xl border border-primary/30 px-3 py-2 text-sm font-semibold text-primary"
              >
                Copy invite link
              </button>
            </div>
          </div>
        ) : null}

        {/* Billing toggle */}
        <div className="mt-[22px] flex items-center gap-2">
          <div className="inline-flex gap-[3px] rounded-[12px] border border-border-subtle bg-overlay-subtle p-[3px]">
            {(['annual', 'monthly'] as BillingPeriod[]).map((period) => (
              <button
                key={period}
                onClick={() => setBilling(period)}
                className="cursor-pointer rounded-[9px] border-none px-3.5 py-[5px] text-[13px] font-semibold transition-all duration-150"
                style={{
                  background: billing === period ? 'var(--primary)' : 'transparent',
                  color: billing === period ? 'var(--on-primary)' : 'var(--text-secondary)',
                }}
              >
                {period.charAt(0).toUpperCase() + period.slice(1)}
              </button>
            ))}
          </div>
          {/* Dollars, read from planCopy like every plan card: a percentage was
              one rate typed beside prices that move, and the pricing page and the
              plan cards state the saving as money. */}
          {billing === 'annual' && (
            <span className="rounded-md bg-primary/[0.12] px-2 py-[3px] text-[12px] font-semibold text-primary">
              Save {money(ANNUAL_SAVING)}
            </span>
          )}
        </div>

        {/* Pricing card */}
        <div className="mt-3 rounded-[20px] border border-primary/25 bg-primary/[0.06] p-[18px]">
          <div className="text-[12px] font-bold uppercase tracking-[0.14em] text-primary">
            {plan.label}
          </div>
          <div className="mt-2 flex items-baseline gap-0.5 text-[28px] font-bold text-text-primary">
            {plan.price}
            <span className="text-[16px] font-medium text-text-secondary">{plan.per}</span>
          </div>
          <p className="m-0 mt-1.5 text-[14px] leading-[1.6] text-text-secondary">
            {plan.description}
          </p>

          <div className="mt-4">
            <button
              onClick={async () => {
                setRedirecting(true);
                trackUpgradeOfferClicked('post_sync_modal', { plan: 'developer_basic', billing });
                trackProductEvent(PRODUCT_EVENTS.checkoutStarted, {
                  source: 'dashboard',
                  path: window.location.pathname,
                  metadata: { plan: 'developer_basic', billing, surface: 'post_sync_modal', trigger: 'post_sync_modal' },
                });
                // Mirror to GA4 with the SAME name so this entry point joins the
                // cross-tool checkout funnel.
                gaEvent('checkout_started', { tier: 'developer_basic', billing });
                try {
                  const result = await api.upgrade('developer_basic', billing);
                  // No URL means the workspace already had a live subscription
                  // and the API moved it in place rather than opening a second.
                  if (result.url) redirectToTrustedUrl(result.url);
                  else window.location.reload();
                } catch (err) {
                  showToast(err instanceof Error ? err.message : 'Could not start upgrade', 'error');
                  setRedirecting(false);
                }
              }}
              className="inline-flex w-full items-center justify-center rounded-2xl bg-primary px-4 py-3 text-sm font-semibold text-on-primary"
            >
              {redirecting ? 'Opening Stripe…' : billing === 'annual' ? 'Go annual' : 'Go monthly'}
            </button>
          </div>
          <p className="m-0 mt-2.5 text-center text-[12px] text-text-muted">
            Secure checkout via Stripe · Cancel anytime
          </p>

          {/* Maybe later — bottom-right of the pricing box */}
          <div className="mt-3 flex justify-end">
            <button
              onClick={() => dismissUpgrade('button')}
              className="cursor-pointer rounded-[10px] border border-border-strong bg-transparent px-3.5 py-[5px] text-[13px] font-medium text-text-secondary"
            >
              Maybe later
            </button>
          </div>
        </div>
    </Modal>
  );
}
