/**
 * The per-plan comparison /settings/upgrade renders under each price.
 *
 * It lived inside the page as columns on each plan card — `autoSync`,
 * `apiAccess`, `contextSharing` — typed to mirror three flags in
 * apps/api/src/config/plans.js (`auto_sync`, `api_access`, `context_sharing`)
 * that nothing in the API reads. So the crosses they drew were claims with
 * nothing behind them, and three were false on the page a Free user reaches
 * from the Upgrade banner:
 *
 *   - Free "Every session briefed": crossed. Every Free session IS briefed, and
 *     /select-plan's Free card says "Every new session starts briefed".
 *   - Free and Pro "API access": crossed. POST /api/v1/keys checks a scope and
 *     no plan, so keys are minted and work on every plan.
 *   - Pro "Brief sharing": crossed. Share links are Pro's `trail_share`, which
 *     shareService enforces, /pricing lists ("Trail share links — Yes") and
 *     /select-plan's Pro card sells ("Share links for any brief").
 *
 * The rule the rows now follow, pinned by `planComparison.test.ts`: a cross is
 * a claim that a plan does NOT have something, so a row may draw one only when
 * it names the plans.js flag the API enforces for it, with the same per-plan
 * values. A row that could not be stated truthfully for every plan from what
 * the other pages already say was removed rather than reworded into a new
 * promise — which is what happened to "API access": no other surface states it.
 *
 * Nothing here is a price. Prices come from planCopy, which CI pins to plans.js.
 */

export type ComparedPlan = 'free' | 'developer_basic' | 'developer_pro';

/** The columns, cheapest first. Each plan includes everything before it. */
export const COMPARED_PLANS: readonly ComparedPlan[] = ['free', 'developer_basic', 'developer_pro'];

export type ComparisonRow = {
  key: string;
  label: string;
  /**
   * The plans.js feature flag a yes/no row restates. Required for any row that
   * shows a plan WITHOUT something, and it must be a flag the API enforces.
   */
  flag?: string;
  /** A string is shown as written; a boolean renders a tick or a cross. */
  values: Readonly<Record<ComparedPlan, string | boolean>>;
};

export const PLAN_COMPARISON: readonly ComparisonRow[] = [
  { key: 'syncs', label: 'Included briefs', values: { free: 'Unlimited', developer_basic: 'Unlimited', developer_pro: 'Unlimited' } },
  { key: 'projects', label: 'Projects', values: { free: 'Unlimited projects', developer_basic: 'Unlimited', developer_pro: 'Unlimited' } },
  { key: 'syncRate', label: 'Daily limit', values: { free: 'None', developer_basic: 'None', developer_pro: 'None' } },
  { key: 'history', label: 'History', values: { free: '90 days', developer_basic: 'Forever', developer_pro: 'Forever' } },
  // Not a gated feature on any plan, so no flag and no cross: it is what the
  // product does. /select-plan's Free card says it in these terms.
  { key: 'sessionBriefed', label: 'Every session briefed', values: { free: true, developer_basic: true, developer_pro: true } },
  // Was "Brief sharing" off `context_sharing`, crossed on Pro. Named in
  // /select-plan's words, because this row is the same claim its Pro card makes.
  { key: 'shareLinks', label: 'Share links for any brief', flag: 'trail_share', values: { free: false, developer_basic: true, developer_pro: true } },
  { key: 'teamWorkspace', label: 'Shared workspace and seats', flag: 'team_management', values: { free: false, developer_basic: false, developer_pro: true } },
];
