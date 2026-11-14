import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  trackUpgradeOfferShown,
  trackUpgradeOfferClicked,
  trackUpgradeOfferDismissed,
} from '@/lib/upgradeOffer';
import { MONTHLY_LABEL, PRO_PLAN_NAME, PRO_VALUE_LINE } from '@/lib/planCopy';

// Re-surface on a cadence instead of dismissing forever — a one-time-then-never
// trigger fires once and the user never sees a paywall prompt again.
const DISMISSED_AT_KEY = 'dd_upgrade_banner_dismissed_at';
const RESURFACE_MS = 7 * 24 * 60 * 60 * 1000;

// The phone form of the offer: the head of the same value line, before its
// colon ("everything across your projects"), so it is made only of words the
// banner already says and cannot drift from what the full sentence offers.
export const PRO_VALUE_HEAD = PRO_VALUE_LINE.split(':')[0].trim();

// Gated on the LIMITS, not on plan_tier. A referral month grants Pro's
// entitlements (unlimited workspaces, permanent memory) while plan_tier still
// reads 'free' — so a tier check would sell a user the exact thing they already
// have, which is the honesty rule's "claim the product does not deliver" in
// reverse. Same reasoning, and same source of truth, as ThirdBriefOffer.
export function UpgradeBanner({
  limits,
  hasFirstSync,
}: {
  limits?: Record<string, number | null>;
  // E-021. The durable, server-side "this account has been briefed at least once"
  // signal, straight off the bootstrap. `undefined` means not loaded yet.
  hasFirstSync?: boolean;
}) {
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      const at = Number(localStorage.getItem(DISMISSED_AT_KEY) || 0);
      setDismissed(at > 0 && Date.now() - at < RESURFACE_MS);
    } catch {
      setDismissed(false);
    }
  }, []);

  // A finite cap on either of the two limits Free is actually gated on means the
  // banner's promise is true for this user. Unlimited (null) or not-yet-loaded
  // (undefined) both fall through to hidden — never flash an offer we cannot
  // stand behind.
  const capped =
    typeof limits?.included_projects === 'number' || typeof limits?.history_days === 'number';
  // E-021. `capped` is true for every Free account by definition, so until now
  // this gate consulted nothing about whether the account had received anything —
  // and the first persistent chrome a new signup saw was a price. Measured over
  // 60 days with test accounts excluded: 5 real people have ever been shown this
  // banner, 4 of them within ten minutes of creating their account, and none of
  // those 4 has ever produced a first sync, a connection or a start_session. It
  // has been clicked zero times in 61 impressions.
  //
  // So require first value as well. Same shape as `capped` and for the same
  // reason: `undefined` (not yet loaded) falls through to hidden rather than
  // flashing an offer before we know whether it is even the right moment for one.
  const briefed = hasFirstSync === true;
  const visible = capped && briefed && !dismissed;

  // This bar is persistent chrome on its own 7-day cadence, so it deliberately
  // does not take the session's ask beat (see lib/upgradeOffer.ts) — it only
  // reports, so its show→click rate is comparable with the modal asks.
  useEffect(() => {
    if (!visible) return;
    trackUpgradeOfferShown('upgrade_banner', {
      project_limit: limits?.included_projects ?? 'unlimited',
      history_days: limits?.history_days ?? 'unlimited',
    });
  }, [visible, limits?.included_projects, limits?.history_days, hasFirstSync]);

  if (!visible) return null;

  function dismiss() {
    try { localStorage.setItem(DISMISSED_AT_KEY, String(Date.now())); } catch {}
    setDismissed(true);
    trackUpgradeOfferDismissed('upgrade_banner', { resurface_days: RESURFACE_MS / 86_400_000 });
  }

  // PHONES (max-sm, under 640px) get their own layout; every class that does
  // it is a max-sm: variant or only displays there, so the desktop bar is
  // unchanged. The desktop row is one fixed-height, centred, no-wrap line about
  // 1,000px wide: in a 375px screen, inside a shell that clips overflow, that
  // centring put the sentence from x=-368 to x=652 and Upgrade and Dismiss past
  // the right edge, so a phone showed a strip reading "ross-project search, the
  // entities that show up in more than one" and nothing to tap (journey r3,
  // S3-2). On a phone the row starts at the left, grows to fit, the sentence
  // wraps in its shorter form, and both controls are 40px tall. In px, not
  // the spacing scale: the dashboard's root font is smaller than 16px, so
  // `h-10` measured 35px on a phone.
  return (
    <div className="flex h-11 w-full shrink-0 items-center justify-center gap-3 border-b border-primary/[0.14] bg-primary/[0.07] px-4 max-sm:h-auto max-sm:min-h-11 max-sm:justify-start max-sm:gap-2 max-sm:py-1 max-sm:pr-1.5">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 max-sm:hidden">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
      {/* The offer has to name something Free does NOT have. It used to say
          "unlock unlimited workspaces", which was true until 2026-08-27 and has
          been free ever since — a banner selling people what they already own.
          Free is now bounded by history and by scope, so those are what Pro adds. */}
      <span className="whitespace-nowrap text-[13px] text-text-secondary max-sm:hidden">
        You&apos;re on Free —{' '}
        <span className="text-text-primary">
          {PRO_PLAN_NAME} adds {PRO_VALUE_LINE}, for {MONTHLY_LABEL}.
        </span>
      </span>
      {/* Phone form. Template strings, not JSX text around expressions, so no
          space can be dropped between a value and the word after it. */}
      <span className="hidden min-w-0 flex-1 text-[13px] leading-snug text-text-secondary max-sm:inline">
        {`You're on Free — `}
        <span className="text-text-primary">{`${PRO_PLAN_NAME} adds ${PRO_VALUE_HEAD}, for ${MONTHLY_LABEL}.`}</span>
      </span>
      <Link
        href="/settings/upgrade?trigger=upgrade_banner"
        onClick={() => trackUpgradeOfferClicked('upgrade_banner')}
        className="shrink-0 whitespace-nowrap rounded-lg bg-primary px-3 py-1 text-[12px] font-semibold text-[#03120b] no-underline max-sm:inline-flex max-sm:min-h-[40px] max-sm:items-center"
      >
        Upgrade
      </Link>
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="ml-1 flex shrink-0 cursor-pointer items-center rounded-md border-none bg-transparent p-1 text-text-muted max-sm:ml-0 max-sm:h-[40px] max-sm:w-[40px] max-sm:justify-center max-sm:p-0"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
