import Head from 'next/head';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, isApiError, type ReferralOverview } from '@/lib/api';
import { showToast } from '@/components/ui/Toast';
import { trackProductEvent } from '@/lib/productAnalytics';
import { buildInviteLink, buildInviteMessage } from '@/lib/referral';
import { InlineErrorState, PageScaffold } from '@/components/dashboard/PageScaffold';
import { PRO_PLAN_NAME } from '@/lib/planCopy';
import { SelfHostedBillingGate } from '@/components/billing/SelfHostedBillingGate';

function ReferPagePage() {
  const [referrals, setReferrals] = useState<ReferralOverview | null>(null);
  // The load used to be `.catch(() => {})`, which left `referrals` null
  // forever: the link field said "Loading…" for the rest of the session, every
  // button stayed disabled, and nothing anywhere said the request had failed.
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    api.getReferralOverview()
      .then((overview) => {
        setReferrals(overview);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        setReferrals(null);
        setLoadError(isApiError(err) ? err : new Error('referral_overview_failed'));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    trackProductEvent('refer_page_viewed', { source: 'dashboard', path: '/settings/refer' });
  }, [load]);

  const code = referrals?.referral_code || '';
  // Invites unlock after the account's own first sync. null while loading.
  const eligible = referrals ? referrals.eligible : null;
  const link = code ? buildInviteLink(code) : '';
  const message = code ? buildInviteMessage(code) : '';
  const rewardDays = referrals?.reward_days ?? 30;
  // The programme has a ceiling (REFERRAL_REWARDED_CAP, API config/plans.js).
  const rewardCap = referrals?.reward_cap;
  const capReached = referrals?.cap_reached === true;
  // Rewarded = the friend's first brief synced, which is when the referrer is paid.
  const joined = (referrals?.referrals || []).filter((r) => r.status === 'rewarded').length;
  const daysEarned = joined * rewardDays;

  const copy = (text: string, what: string, surface: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    showToast(`Copied ${what}`, 'success');
    trackProductEvent('referral_link_copied', { source: 'dashboard', path: '/settings/refer', metadata: { surface } });
  };

  const shareX = () => {
    if (link) window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
  };
  const shareEmail = () => {
    if (link) window.location.href = `mailto:?subject=${encodeURIComponent('A tool that keeps your AI tools in sync')}&body=${encodeURIComponent(message)}`;
  };

  return (
    <>
      <Head><title>{`Invite & earn ${PRO_PLAN_NAME} | DeerDawn`}</title></Head>
      <PageScaffold
        title={`Give a month of ${PRO_PLAN_NAME}, get a month.`}
        description={<>Your friend gets {rewardDays} days of {PRO_PLAN_NAME} the moment they sign up with your link. You get {rewardDays} days for every friend whose first brief syncs{rewardCap ? <>, for up to {rewardCap} friends</> : null}.</>}
      >
        {loadError ? (
          <InlineErrorState
            title="Couldn't load your invite link"
            description="Your link is safe — we just couldn't fetch it. Nothing about your referrals has changed."
            onRetry={load}
            requestId={isApiError(loadError) ? loadError.requestId : undefined}
          />
        ) : null}

        {capReached ? (
          <div className="rounded-2xl border border-border-subtle bg-overlay-subtle p-5">
            <div className="text-sm font-semibold text-text-primary">You have reached the invite reward limit</div>
            <p className="mt-1.5 text-[13px] leading-6 text-text-secondary">
              The programme pays for {rewardCap} friends, and you have used them all. The link still opens the signup
              page, but a signup through it no longer earns days — for you or for them.
            </p>
          </div>
        ) : null}

        {eligible === false ? (
          <div className="rounded-2xl border border-border-subtle bg-overlay-subtle p-5">
            <div className="text-sm font-semibold text-text-primary">Your invite link unlocks after your first sync</div>
            <p className="mt-1.5 text-[13px] leading-6 text-text-secondary">
              Invites are for people who have seen DeerDawn work. Connect a tool and let your first brief load into a session, and your link appears here.
            </p>
            <Link href="/onboarding" className="mt-3 inline-block rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary">Connect a tool</Link>
          </div>
        ) : null}

        {/* Counter — an open loop that pulls you back */}
        <div className="grid max-w-sm grid-cols-2 gap-3">
          <div className="rounded-xl bg-overlay-subtle p-4">
            <div className="text-[12px] text-text-muted">Friends synced</div>
            <div className="mt-1 text-[24px] font-bold text-text-primary">{joined}</div>
          </div>
          <div className="rounded-xl bg-overlay-subtle p-4">
            <div className="text-[12px] text-text-muted">{`${PRO_PLAN_NAME} days earned`}</div>
            <div className="mt-1 text-[24px] font-bold text-text-primary">{daysEarned}</div>
          </div>
        </div>

        {/* Invite link + share targets */}
        <div className="rounded-2xl border border-border-subtle bg-overlay-subtle p-5">
          <div className="text-[12px] font-semibold text-text-secondary">Your invite link</div>
          <div className="mt-2 flex items-center gap-3">
            <div className="flex-1 truncate rounded-lg border border-border-subtle bg-[var(--code-bg)] px-3 py-2 text-sm text-text-secondary">{link || (eligible === false ? 'Locked until your first sync' : loading ? 'Loading…' : 'Unavailable right now')}</div>
            <button
              onClick={() => copy(link, 'invite link', 'refer_page')}
              disabled={!link}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary disabled:opacity-50"
            >
              Copy link
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={() => copy(message, 'invite message', 'refer_page_message')} disabled={!link} className="rounded-lg border border-border-strong px-3 py-2 text-[13px] font-medium text-text-secondary hover:text-text-primary disabled:opacity-50">Copy message</button>
            <button onClick={shareX} disabled={!link} className="rounded-lg border border-border-strong px-3 py-2 text-[13px] font-medium text-text-secondary hover:text-text-primary disabled:opacity-50">Share on X</button>
            <button onClick={shareEmail} disabled={!link} className="rounded-lg border border-border-strong px-3 py-2 text-[13px] font-medium text-text-secondary hover:text-text-primary disabled:opacity-50">Share by email</button>
          </div>
        </div>
      </PageScaffold>
    </>
  );
}

// A self-hosted install has no billing: this page renders a notice there
// instead (components/billing/SelfHostedBillingGate.tsx).
export default function ReferPage() {
  return (
    <SelfHostedBillingGate>
      <ReferPagePage />
    </SelfHostedBillingGate>
  );
}
