import { Button } from '@/components/ui/Button';
import {
  CONFIRM_TAKEOVER_LABEL,
  END_AT_PERIOD_END_LABEL,
  TAKE_OVER_LABEL,
  billingOwnerPanel,
  seatShortfallLine,
  type BillingOwnerAction,
  type BillingOwnerInput,
  type SeatShortfall,
} from '@/lib/billingOwner';

const LABELS: Record<BillingOwnerAction, string> = {
  take_over: TAKE_OVER_LABEL,
  confirm_takeover: CONFIRM_TAKEOVER_LABEL,
  end_at_period_end: END_AT_PERIOD_END_LABEL,
};

/**
 * Who pays for the workspace, and the two ways the payer can be freed: another
 * owner takes billing over, or the subscription ends at the close of the period.
 * Renders nothing when there is nothing to say. See lib/billingOwner.
 */
export function BillingOwnerPanel({ plan, pending, onAction }: {
  plan: BillingOwnerInput | null | undefined;
  /** The action in flight, if any: it spins and the others lock. */
  pending: string | null;
  onAction: (action: BillingOwnerAction) => void;
}) {
  const model = billingOwnerPanel(plan);
  if (!model) return null;
  return (
    <div className="mt-6 rounded-2xl border border-border-subtle bg-overlay-subtle p-5" data-billing-owner-panel>
      <h3 className="m-0 text-base font-semibold text-text-primary">{model.heading}</h3>
      {model.lines.map((line) => (
        <p key={line} className="mt-2 text-sm leading-7 text-text-secondary">{line}</p>
      ))}
      {model.actions.length > 0 && (
        <div className="mt-4 flex flex-col gap-3">
          {model.actions.map((action) => (
            <Button
              key={action}
              variant={action === 'end_at_period_end' ? 'danger' : 'secondary'}
              onClick={() => onAction(action)}
              disabled={pending !== null}
              isLoading={pending === action}
            >
              {LABELS[action]}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/** More people than seats, said once, plainly. Nothing is locked. */
export function SeatShortfallNotice({ shortfall, action }: {
  shortfall: SeatShortfall | null | undefined;
  /** Where to go to fix it: a link or button, rendered under the sentence. */
  action?: React.ReactNode;
}) {
  const line = seatShortfallLine(shortfall);
  if (!line) return null;
  return (
    <div role="status" className="mt-4 rounded-2xl border border-border-subtle bg-overlay-subtle px-5 py-4 text-sm leading-7 text-text-secondary" data-seat-shortfall>
      <p className="m-0 text-status-warning-text">{line}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
