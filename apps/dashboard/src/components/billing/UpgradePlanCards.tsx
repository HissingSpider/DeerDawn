/**
 * The plan cards on /settings/upgrade: every price that page prints, in one
 * component that takes the billing toggle and the workspace's plan as props.
 *
 * Split out of the page so the cards can be rendered and read by a test in each
 * toggle state and for each kind of subscriber — the page reads its plan from
 * the dashboard bootstrap, which a static render does not have, and a static
 * render cannot press the toggle.
 */
import {
  PRICE_ANNUAL_PER_MONTH,
  PRICE_MONTHLY,
  PRO_PLAN_NAME,
  TEAM_MIN_SEATS,
  TEAM_PLAN_NAME,
  TEAM_PRICE_ANNUAL_PER_MONTH,
  TEAM_PRICE_MONTHLY,
  TEAM_TRIAL_DAYS,
  money,
  type BillingCycle,
} from '@/lib/planCopy';
import { teamTrialAlreadyUsed, teamTrialApplies } from '@/lib/billingOffer';
import { PLAN_COMPARISON, type ComparedPlan } from '@/lib/planComparison';

export const UPGRADE_PLANS: Array<{
  id: ComparedPlan;
  name: string;
  price: number;
  annualPrice: number;
  tagline: string;
  oneTime?: boolean;
  /** Per-seat plans price a seat, not an account: the card says so, and the
   *  checkout opens at `minSeats` rather than at one. */
  perSeat?: boolean;
  minSeats?: number;
  /** A qualifier under the price, where the number alone would mislead. */
  note?: string;
  /** The same qualifier for a workspace that will NOT get the trial `note`
   *  advertises, because its existing subscription is moved in place. */
  noteWithoutTrial?: string;
  /** The same qualifier for a workspace that would open a new checkout but has
   *  already had its one Team trial. */
  noteTrialUsed?: string;
  badge?: string;
  highlight?: boolean;
}> = [
  {
    id: 'free',
    name: 'Free',
    price: 0,
    annualPrice: 0,
    tagline: 'Try DeerDawn with no commitment.',
  },
  {
    id: 'developer_basic',
    name: PRO_PLAN_NAME,
    // From planCopy, which is pinned to plans.js. This card said `price: 10`
    // for the six days after Pro moved to $12 and the Stripe price was
    // repointed — the highest-intent upgrade surface in the product quoting a
    // number two dollars under what the next screen charged. It survived the
    // hard-coded-price guard because that guard looks for a `$` followed by a
    // digit, and a bare `10` in an object field has no `$` in front of it.
    price: PRICE_MONTHLY,
    annualPrice: PRICE_ANNUAL_PER_MONTH,
    tagline: 'For developers who build every day.',
    badge: 'Recommended',
    highlight: true,
  },
  {
    // Team has been self-serve since 2026-09-02 — its per-seat Stripe prices
    // exist, the API lists it in SELF_SERVE_PLAN_IDS, and marketing /pricing
    // sells it — but the only in-product upgrade page never offered it, so a
    // signed-in buyer could reach it only by leaving for the marketing site.
    id: 'developer_pro',
    name: TEAM_PLAN_NAME,
    price: TEAM_PRICE_MONTHLY,
    annualPrice: TEAM_PRICE_ANNUAL_PER_MONTH,
    tagline: 'One shared workspace, for everyone building on it.',
    perSeat: true,
    minSeats: TEAM_MIN_SEATS,
    note: `${TEAM_MIN_SEATS} seats minimum · ${TEAM_TRIAL_DAYS}-day free trial, card up front`,
    // What the card says to a workspace that is ALREADY paying. Its upgrade is
    // an in-place move of the existing subscription — no Checkout, so no trial
    // — and the note above would promise 14 free days about a change that is
    // prorated from the first minute. See lib/billingOffer.teamTrialApplies.
    noteWithoutTrial: `${TEAM_MIN_SEATS} seats minimum · your current subscription moves to ${TEAM_PLAN_NAME}, prorated`,
    // One trial per workspace: this one has had it, so it is charged from the start.
    noteTrialUsed: `${TEAM_MIN_SEATS} seats minimum · this workspace has already had its free trial`,
  },
];

function Check() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function Cross() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

export function UpgradePlanCards({
  billing,
  currentTier,
  currentCycle,
  stripeCustomerId,
  teamTrialStartedAt = null,
  redirecting,
  onUpgrade,
  onPortal,
}: {
  billing: BillingCycle;
  currentTier: string;
  /** The cycle the workspace is billed on, from planCopy.billingCycleOnRecord;
   *  null when the dashboard cannot know it. */
  currentCycle: BillingCycle | null;
  stripeCustomerId: string | null;
  /** organizations.team_trial_started_at: when this workspace's Team trial
   *  started; null = it has never had one. */
  teamTrialStartedAt?: string | null;
  redirecting: string | null;
  onUpgrade: (planId: string) => void;
  onPortal: () => void;
}) {
  return (
    <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {UPGRADE_PLANS.map((plan) => {
        const isCurrent = currentTier === plan.id;
        const isRedirecting = redirecting === plan.id;
        // Only Team has a trial, and only a NEW subscription gets it.
        const offersTrial = teamTrialApplies({ targetPlan: plan.id, currentTier, stripeCustomerId, teamTrialStartedAt });
        const trialUsed = teamTrialAlreadyUsed({ targetPlan: plan.id, currentTier, stripeCustomerId, teamTrialStartedAt });
        // The card for the plan you are ALREADY on makes no offer, so it
        // carries neither version: "your subscription moves to Team" is as
        // wrong there as the trial was.
        const planNote = isCurrent
          ? undefined
          : plan.id === 'developer_pro' && trialUsed ? plan.noteTrialUsed
            : plan.id === 'developer_pro' && !offersTrial ? plan.noteWithoutTrial : plan.note;
        // WHICH CYCLE THIS CARD PRICES. Every card follows the toggle except the
        // one marked "Current plan", which states what this workspace is
        // charged. It followed the toggle too, and the toggle opens on Annual,
        // so a MONTHLY Pro subscriber read "Current plan, Pro $8/mo" — they pay
        // $12. null means the cycle is not on record (a trial, or a period
        // ending within the month), and the card then states both cycles
        // rather than guess one.
        const paidCurrent = isCurrent && plan.price > 0;
        const cycle: BillingCycle | null = paidCurrent ? currentCycle : billing;
        const perMonthUnit = plan.oneTime ? ' once' : plan.perSeat ? '/seat/mo' : '/mo';
        const perYearUnit = plan.perSeat ? '/seat/yr' : '/yr';

        return (
          <div
            key={plan.id}
            data-plan={plan.id}
            className="relative rounded-2xl px-6 py-7"
            style={{
              border: plan.highlight
                ? '1px solid rgba(16,185,129,0.35)'
                : '1px solid var(--border-subtle)',
              background: plan.highlight ? 'rgba(16,185,129,0.04)' : 'var(--surface)',
              boxShadow: plan.highlight ? '0 0 40px -12px rgba(16,185,129,0.25)' : 'none',
            }}
          >
            {/* Badge */}
            {(plan.badge || isCurrent) && (
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full px-2.5 py-[3px] text-[11px] font-bold uppercase tracking-[0.1em]" style={{
                color: isCurrent ? 'var(--text-muted)' : 'var(--on-primary)',
                background: isCurrent ? 'var(--surface-elevated)' : 'var(--primary)',
                border: isCurrent ? '1px solid var(--border-subtle)' : 'none',
              }}>
                {isCurrent ? 'Current plan' : plan.badge}
              </div>
            )}

            {/* Plan name & price */}
            <div className="mb-5">
              <div className="mb-2 text-[13px] font-semibold" style={{ color: plan.highlight ? 'var(--primary)' : 'var(--text-muted)' }}>
                {plan.name}
              </div>
              {cycle === null ? (
                <>
                  <div className="mb-1 text-[22px] font-bold tracking-[-0.03em] text-text-primary">
                    {`${money(plan.price)}${perMonthUnit} or ${money(plan.annualPrice * 12)}${perYearUnit}`}
                  </div>
                  <div className="mb-1.5 text-[12px] text-text-muted">
                    Billed monthly or yearly. Manage billing shows which.
                  </div>
                </>
              ) : (
                <>
                  <div className="mb-1 flex items-baseline gap-1">
                    <span className="text-[36px] font-bold tracking-[-0.04em] text-text-primary">
                      {money(cycle === 'annual' && plan.annualPrice > 0 ? plan.annualPrice : plan.price)}
                    </span>
                    {plan.price > 0 && (
                      <span className="text-[13px] text-text-muted">
                        {perMonthUnit}
                      </span>
                    )}
                  </div>
                  {cycle === 'annual' && plan.annualPrice > 0 && !plan.oneTime && (
                    <div className="mb-1.5 text-[12px] text-primary">
                      {money(plan.annualPrice * 12)}{perYearUnit} — save{' '}
                      {money((plan.price - plan.annualPrice) * 12)}{plan.perSeat ? ' per seat' : ''}
                    </div>
                  )}
                  {paidCurrent && (
                    <div className="mb-1.5 text-[12px] text-text-muted">
                      {cycle === 'annual' ? 'Billed yearly' : 'Billed monthly'}
                    </div>
                  )}
                </>
              )}
              <p className="m-0 text-[13px] leading-[1.5] text-text-muted">
                {plan.tagline}
              </p>
              {planNote && (
                <p className="mt-1.5 mb-0 text-[12px] leading-[1.5] text-text-muted">
                  {planNote}
                </p>
              )}
            </div>

            {/* Divider */}
            <div className="mb-5 h-px bg-overlay-active" />

            {/* Features. From lib/planComparison, not columns on these cards:
                the cards crossed out session briefing on Free, API access on
                Free and Pro, and sharing on Pro — all three things those plans
                have — off plans.js flags nothing enforces. A cross there must
                now name an enforced flag, and planComparison.test.ts checks the
                rows against /select-plan and /pricing. */}
            <div className="mb-7 flex flex-col gap-3">
              {PLAN_COMPARISON.map((row) => {
                const val = row.values[plan.id];
                const isBool = typeof val === 'boolean';
                return (
                  <div key={row.key} className="flex items-center justify-between gap-2">
                    <span className="text-[13px] text-text-secondary">{row.label}</span>
                    {isBool ? (
                      val ? <Check /> : <Cross />
                    ) : (
                      <span className="text-[13px] font-medium text-text-primary">{val as string}</span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* CTA */}
            {plan.id === 'free' && !isCurrent ? (
              <div className="w-full rounded-[10px] border border-border-subtle bg-transparent px-0 py-2.5 text-center text-[13px] font-semibold text-text-muted">
                Included for new workspaces
              </div>
            ) : isCurrent ? (
              currentTier !== 'free' ? (
                <button
                  onClick={onPortal}
                  disabled={redirecting === 'portal'}
                  className="w-full cursor-pointer rounded-[10px] border border-border-subtle bg-overlay-subtle px-0 py-2.5 text-[13px] font-semibold text-text-primary"
                  style={{
                    opacity: redirecting === 'portal' ? 0.5 : 1,
                  }}
                >
                  {redirecting === 'portal' ? 'Opening…' : 'Manage billing'}
                </button>
              ) : (
                <div className="w-full rounded-[10px] border border-border-subtle bg-transparent px-0 py-2.5 text-center text-[13px] font-semibold text-text-muted">
                  Your current plan
                </div>
              )
            ) : (
              <button
                onClick={() => onUpgrade(plan.id)}
                disabled={!!redirecting}
                className="w-full rounded-[10px] px-0 py-2.5 text-[13px] font-semibold"
                style={{
                  cursor: redirecting ? 'not-allowed' : 'pointer',
                  border: plan.highlight ? 'none' : '1px solid var(--border-subtle)',
                  background: plan.highlight ? 'var(--primary)' : 'var(--overlay-subtle)',
                  color: plan.highlight ? 'var(--on-primary)' : 'var(--text-primary)',
                  opacity: redirecting ? 0.5 : 1,
                  boxShadow: plan.highlight ? '0 14px 30px -18px rgba(16,185,129,0.75)' : 'none',
                }}
              >
                {isRedirecting
                  ? 'Opening Stripe…'
                  : plan.oneTime
                    ? `Get ${plan.name}`
                    : offersTrial
                      ? `Try ${plan.name} free for ${TEAM_TRIAL_DAYS} days`
                      : `Upgrade to ${plan.name}${billing === 'annual' ? ' — Annual' : ''}`}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
