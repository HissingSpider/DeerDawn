import { PRO_PLAN_NAME } from '@/lib/planCopy';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { ProjectContextJson } from '@/lib/api';
import { useDashboardBootstrap } from '@/components/dashboard/DashboardBootstrapProvider';
import {
  claimSessionBeat,
  countAgedOutEntries,
  trackUpgradeOfferShown,
  trackUpgradeOfferClicked,
  trackUpgradeOfferDismissed,
} from '@/lib/upgradeOffer';

// Free's memory window trims the brief silently: entries older than the plan's
// history_days are dropped from what the AI reads, while the dashboard — which
// fetches the RAW stored context — keeps showing them. The brief quietly gets
// shorter and nothing on screen says why.
//
// This says it, and only when it is true: the count comes from the user's own
// dated entries measured against their own plan's window (countAgedOutEntries
// mirrors the server's applyHistoryWindow). Zero aged-out entries, or any plan
// without a window, renders nothing — an always-on notice would be a claim the
// data does not support.
export function HistoryTrimNotice({ context }: { context: ProjectContextJson | null }) {
  const { bootstrap } = useDashboardBootstrap();
  const [state, setState] = useState<'idle' | 'shown' | 'dismissed'>('idle');
  const decidedRef = useRef(false);

  const historyDays = bootstrap?.usage?.limits?.history_days ?? null;
  const agedOut = useMemo(
    () => countAgedOutEntries(context as Record<string, unknown> | null, historyDays),
    [context, historyDays],
  );

  useEffect(() => {
    if (agedOut === 0 || decidedRef.current) return;
    decidedRef.current = true;
    // Shares the one-ask-per-session cap with the other moments.
    if (!claimSessionBeat('history_trim')) return;
    setState('shown');
    trackUpgradeOfferShown('history_trim', { aged_out: agedOut, history_days: historyDays ?? 0 });
  }, [agedOut, historyDays]);

  if (state !== 'shown' || agedOut === 0) return null;

  return (
    <div className="mb-4 flex items-start gap-3 rounded-xl border border-border-subtle bg-overlay-subtle p-4">
      <div className="min-w-0 flex-1">
        <p className="m-0 text-[13.5px] leading-6 text-text-secondary">
          <span className="font-semibold text-text-primary">
            {agedOut} {agedOut === 1 ? 'entry is' : 'entries are'} older than {historyDays} days
          </span>{' '}
          — outside Free&apos;s memory window, so your AI&apos;s brief leaves{' '}
          {agedOut === 1 ? 'it' : 'them'} out. Nothing is deleted; {PRO_PLAN_NAME} keeps history forever.
        </p>
        <Link
          href="/settings/upgrade?trigger=history_trim"
          onClick={() => trackUpgradeOfferClicked('history_trim', { aged_out: agedOut })}
          className="mt-2 inline-block text-[13px] font-medium text-primary hover:underline"
        >
          Keep every entry in the brief &rarr;
        </Link>
      </div>
      <button
        onClick={() => {
          trackUpgradeOfferDismissed('history_trim', { aged_out: agedOut });
          setState('dismissed');
        }}
        aria-label="Dismiss"
        className="flex shrink-0 cursor-pointer items-center rounded-md border-none bg-transparent p-1 text-text-muted"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
