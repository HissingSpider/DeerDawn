/**
 * The plan cards and the Team pointer on /select-plan: every price that page
 * prints, in one component that takes the billing toggle as a prop.
 *
 * Split out of the page so the prices can be rendered and read in BOTH toggle
 * states by a test. The page itself renders a spinner until a session check
 * resolves, which a static render never gets past, and a static render cannot
 * press the toggle either — so the page could only ever be read by hand.
 */
import { Button } from '@/components/ui/Button';
import { siteConfig } from '@/lib/siteConfig';
import {
  ANNUAL_SAVING,
  PRICE_ANNUAL_PER_MONTH,
  PRICE_MONTHLY,
  PRO_PLAN_NAME,
  TEAM_PLAN_NAME,
  money,
  teamPricePhrase,
  type BillingCycle,
} from '@/lib/planCopy';

export type PlanOption = {
  id: string;
  name: string;
  price: string;
  period: string;
  summary: string;
  bullets: string[];
  cta: string;
  featured?: boolean;
  salesAssisted?: boolean;
  oneTime?: boolean;
};

export const PERSONAL_PLANS: PlanOption[] = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    period: '',
    summary: 'Start with Free and see your first briefed session. No card required.',
    bullets: ['Every new session starts briefed', 'No daily caps', 'Unlimited projects · 90-day history', 'Cloud storage'],
    cta: 'Continue free',
  },
  {
    id: 'developer_basic',
    name: PRO_PLAN_NAME,
    price: `$${PRICE_MONTHLY}`,
    period: '/mo',
    summary: 'The daily-driver tier for developers who build every day.',
    // Every bullet must be something Free does NOT have. "Unlimited workspaces"
    // was here until 2026-08-27 and has been free ever since — a paid tier whose
    // headline bullet is a free feature reads as a con, not an upgrade.
    bullets: ['Cross-project search and the portfolio map', 'Shared entities across your projects', 'History that never ages out', 'Share links for any brief'],
    cta: `Start ${PRO_PLAN_NAME}`,
    featured: true,
  },
];

export function SelectPlanChoices({
  plans,
  billing,
  isLoading,
  activePlan,
  onContinueFree,
  onCheckout,
  onSeeTeam,
}: {
  plans: PlanOption[];
  billing: BillingCycle;
  isLoading: boolean;
  activePlan: string | null;
  onContinueFree: () => void;
  onCheckout: (planId: string) => void;
  onSeeTeam: () => void;
}) {
  return (
    <>
      {/* Plan cards */}
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        {plans.map((plan) => {
          const busy = isLoading && activePlan === plan.id;
          // Derived, not typed. `8` was right only because 96/12 is 8,
          // and the "-20%" beside it was never right at all — $144 of
          // monthly against $96 is a third off, which is the number
          // marketing's own card has been deriving and printing.
          const ANNUAL_PRICES: Record<string, number> = { developer_basic: PRICE_ANNUAL_PER_MONTH };
          const displayPrice = billing === 'annual' && ANNUAL_PRICES[plan.id]
            ? money(ANNUAL_PRICES[plan.id])
            : plan.price;
          const displayPeriod = plan.oneTime ? 'once' : billing === 'annual' && ANNUAL_PRICES[plan.id] ? '/mo' : plan.period;
          return (
            <section
              key={plan.id}
              data-plan={plan.id}
              className={`flex h-full flex-col rounded-2xl border p-5 transition-colors ${
                plan.featured
                  ? 'border-primary/30 bg-primary/[0.06]'
                  : 'border-border-subtle bg-overlay-subtle'
              }`}
            >
              {/* Badge on its own line so it never crowds the eyebrow/title
                  on a narrow card; an invisible placeholder keeps the
                  eyebrows aligned across all cards. */}
              <span
                aria-hidden={!plan.featured}
                className={`mb-3 inline-flex self-start rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${
                  plan.featured
                    ? 'border-primary/30 bg-primary/10 text-primary'
                    : 'invisible border-transparent'
                }`}
              >
                Recommended
              </span>
              <div>
                <div className="text-[11px] uppercase tracking-[0.16em] text-text-muted">
                  {plan.oneTime ? 'Launch offer' : 'Individual workspace'}
                </div>
                <h2 className="mt-1.5 text-xl font-semibold tracking-[-0.03em] text-text-primary">{plan.name}</h2>
              </div>

              <div className="mt-4">
                <div className="flex items-end gap-1.5">
                  <span className="text-3xl font-semibold tracking-[-0.05em] text-text-primary">{displayPrice}</span>
                  {displayPeriod ? <span className="pb-1 text-sm text-text-secondary">{displayPeriod}</span> : null}
                </div>
                {billing === 'annual' && ANNUAL_PRICES[plan.id] && (
                  <div className="mt-1 text-xs text-primary">
                    {money(ANNUAL_PRICES[plan.id] * 12)}/yr — save{' '}
                    {money(ANNUAL_SAVING)}
                  </div>
                )}
              </div>

              <p className="mt-2.5 text-sm leading-6 text-text-secondary">{plan.summary}</p>

              <div className="mt-4 space-y-1.5">
                {plan.bullets.map((bullet) => (
                  <div key={bullet} className="flex gap-2 text-sm leading-5 text-text-secondary">
                    <span className="mt-0.5 text-primary">✓</span>
                    <span>{bullet}</span>
                  </div>
                ))}
              </div>

              <div className="mt-auto pt-5">
                {plan.salesAssisted ? (
                  <Button
                    variant="secondary"
                    className="w-full"
                    onClick={() => { window.location.assign(`${siteConfig.ACTIVE_SITE_URL}/contact`); }}
                    disabled={isLoading}
                  >
                    {plan.cta}
                  </Button>
                ) : plan.id === 'free' ? (
                  <Button
                    variant="secondary"
                    className="w-full"
                    onClick={onContinueFree}
                    isLoading={isLoading && activePlan === null}
                    disabled={isLoading}
                  >
                    {plan.cta}
                  </Button>
                ) : (
                  <Button
                    className="w-full"
                    onClick={() => onCheckout(plan.id)}
                    isLoading={busy}
                    disabled={isLoading}
                  >
                    {busy ? 'Opening Stripe…' : plan.cta}
                  </Button>
                )}
              </div>
            </section>
          );
        })}
      </div>

      {/* Team is deliberately NOT a fourth card here. This picker hard-sets
          account_type 'personal' and passes it to updateAccountType with the
          chosen plan, so selling an organization plan from it would file the
          buyer's workspace as personal — the real Team path (marketing
          /pricing and /settings/upgrade) passes no account type at all. A
          pointer costs nothing and cannot mislabel anything. */}
      <div data-plan-pointer="developer_pro" className="mt-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-muted">
        {/* Follows the toggle like the cards above it. It said "$15 a seat"
            on Annual too, while /settings/upgrade showed $12.50 for the same
            choice; and "a seat" alone never said a month or a year. */}
        <span>{`Working with other people? ${TEAM_PLAN_NAME} is ${teamPricePhrase(billing)}.`}</span>
        <button
          onClick={onSeeTeam}
          disabled={isLoading}
          className="ui-focus font-medium text-text-secondary underline-offset-4 transition-colors hover:text-text-primary hover:underline disabled:opacity-50"
        >
          See {TEAM_PLAN_NAME}
        </button>
      </div>
    </>
  );
}
