/**
 * The one sentence /settings/usage says about what this plan remembers.
 *
 * `limits.projects: null` means UNCAPPED (plans.js: Free's included_projects is
 * null since the project cap was removed). The page read it as `?? 3`, so every
 * Free workspace was told it had a three-workspace limit that does not exist,
 * which is the one number on the page most likely to decide an upgrade. Unknown
 * is never filled in with a number: the old `?? 7` for history days was the
 * same mistake (Free's window is 90 days).
 */
export function usagePlanLine(input: {
  isFreeTier: boolean;
  planLabel: string;
  historyDays?: number | null;
  projectLimit?: number | null;
}): string {
  if (!input.isFreeTier) {
    return `Unlimited projects and permanent memory. Nothing on ${input.planLabel} runs out.`;
  }
  const days = finite(input.historyDays);
  const limit = finite(input.projectLimit);
  const window = days === null ? 'your recent history' : `the last ${days} day${days === 1 ? '' : 's'}`;
  const scope = limit === null
    ? 'across unlimited workspaces'
    : limit === 1 ? 'in one workspace' : `in ${limit} workspaces`;
  return `Free remembers ${window} ${scope}.`;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}
