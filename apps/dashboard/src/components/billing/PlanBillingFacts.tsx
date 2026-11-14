import { planBillingFacts, type PlanBillingRecord } from '@/lib/planBilling';

/**
 * What the workspace pays, as recorded from its subscription: price, cycle,
 * seats, when the current period (or trial) ends, and what a renewal costs.
 * Renders nothing for a workspace with no subscription on record. See
 * lib/planBilling for what is deliberately left out.
 */
export function PlanBillingFacts({ plan }: { plan: PlanBillingRecord | null | undefined }) {
  const facts = planBillingFacts(plan);
  if (!facts.length) return null;
  return (
    <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm leading-7">
      {facts.map((fact) => (
        <div key={fact.label} className="contents">
          <dt className="text-text-secondary">{fact.label}</dt>
          <dd className="m-0 text-text-primary">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}
