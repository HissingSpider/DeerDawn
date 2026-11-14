import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { OPEN_BILLING_PAGE_LABEL, type BillingPageRefusal } from '@/lib/billingRefusal';
import { revealNotice } from '@/lib/revealNotice';

/**
 * Why a plan or seat change was refused, beside the one thing that fixes it:
 * Stripe's billing page. See lib/billingRefusal. A toast could say the
 * sentence but not carry the link, and the link is the answer.
 *
 * It answers a press, so it goes where the person is: each new refusal takes
 * focus and is scrolled to the nearest edge that shows it (lib/revealNotice).
 * The pages render it where they keep their messages, which on a phone can be
 * a screen or more away from the button pressed (/settings/upgrade stacks its
 * plan cards below it). Already on screen, it does not move. `scroll-mt-24`
 * keeps it clear of the sticky top bar when it is scrolled to the top edge.
 */
export function BillingRefusalNotice({ refusal, onOpenBilling, opening = false }: {
  refusal: BillingPageRefusal | null;
  onOpenBilling: () => void;
  opening?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (refusal) revealNotice(ref.current);
  }, [refusal]);

  if (!refusal) return null;
  return (
    <div
      ref={ref}
      role="alert"
      // Focusable by script, skipped by Tab: a message, not a control.
      tabIndex={-1}
      data-billing-refusal={refusal.code}
      className="scroll-mt-24 rounded-2xl border border-border-subtle bg-overlay-subtle px-5 py-4 text-sm leading-7 text-text-secondary"
    >
      <p className="m-0 text-text-primary">{refusal.message}</p>
      <div className="mt-3">
        {/* 40px to the touch on a phone; h-11 is 38.5px at the 14px root. */}
        <Button variant="secondary" className="max-sm:h-[40px]" onClick={onOpenBilling} disabled={opening} isLoading={opening}>
          {OPEN_BILLING_PAGE_LABEL}
        </Button>
      </div>
    </div>
  );
}
