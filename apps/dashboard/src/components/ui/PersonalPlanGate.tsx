import { useEffect } from 'react';
import Link from 'next/link';
import { Card } from './Card';
import {
  spendSessionBeat,
  trackUpgradeOfferShown,
  trackUpgradeOfferClicked,
  type UpgradeSurface,
} from '@/lib/upgradeOffer';
import { MONTHLY_LABEL, PRO_PLAN_NAME, PRO_VALUE_LINE, STAYS_FREE_LINE } from '@/lib/planCopy';

interface PersonalPlanGateProps {
  feature: string;
  /** Which ask this is, for ask-health reporting. */
  surface: UpgradeSurface;
  /** Replaces the generic pitch when the block has a specific reason to explain. */
  description?: string;
}

// The screen a paid feature shows instead of an error. It is reactive — it only
// renders where the user just ran into a limit — so it SPENDS the session's ask
// beat rather than claiming it: gating it would put back the dead end it exists
// to replace. See lib/upgradeOffer.ts.
export function PersonalPlanGate({ feature, surface, description }: PersonalPlanGateProps) {
  useEffect(() => {
    spendSessionBeat(surface);
    trackUpgradeOfferShown(surface, { feature });
  }, [surface, feature]);

  return (
    <Card>
      <div className="text-center py-10">
        <div className="w-12 h-12 rounded-full bg-surface-elevated border border-border flex items-center justify-center mx-auto mb-4">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-text-muted">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>
        <h3 className="text-lg font-semibold text-text-primary mb-2">Unlock {feature}</h3>
        <p className="text-sm text-text-secondary mb-6 max-w-md mx-auto">
          {description ?? `${feature} is part of ${PRO_PLAN_NAME} — ${PRO_VALUE_LINE}. ${MONTHLY_LABEL}, cancel anytime. ${STAYS_FREE_LINE}`}
        </p>
        <Link
          href={`/settings/upgrade?trigger=${surface}`}
          onClick={() => trackUpgradeOfferClicked(surface, { feature })}
          className="inline-block px-5 py-2 bg-primary text-on-primary rounded-sm text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          Upgrade to {PRO_PLAN_NAME} &rarr;
        </Link>
      </div>
    </Card>
  );
}
