// Short, badge-friendly plan names — the ChatGPT-style "Free / Plus" pill.
// Kept in one place so the TopNav badge and the upgrade-success modal agree on
// what a given tier is called.
//
// The names come from planCopy, which is pinned to plans.js `publicName`. This
// map spelled developer_basic "Founding Pro" — a name the product retired —
// which put it in the top-nav badge, the settings page and the upgrade-success
// modal, on the accounts that had just paid. The guard that bans "Founding Pro"
// only walked src/components and src/pages, so a label defined in src/lib and
// rendered by all three went unseen. developer_pro was missing outright and
// fell through to "Developer_pro".
import { PRO_PLAN_NAME, TEAM_PLAN_NAME } from '@/lib/planCopy';

const BADGE_LABELS: Record<string, string> = {
  free: 'Free',
  developer_basic: PRO_PLAN_NAME,
  developer_pro: TEAM_PLAN_NAME,
  lifetime: 'Lifetime',
};

/**
 * Resolve a tier into the short label shown in the top-right plan badge.
 * Falls back to the server-provided public label (e.g. "Scale") or a
 * capitalized tier id for organization plans we don't special-case.
 */
export function planBadgeLabel(tier: string | null | undefined, publicLabel?: string | null): string {
  if (!tier) return 'Free';
  if (BADGE_LABELS[tier]) return BADGE_LABELS[tier];
  if (publicLabel) return publicLabel;
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

/** A paid badge gets the accent treatment; free stays muted. */
export function isPaidTier(tier: string | null | undefined): boolean {
  return Boolean(tier) && tier !== 'free';
}
