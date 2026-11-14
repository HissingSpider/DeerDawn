/**
 * WHO PAYS, AND THE SEATS BEING PAID FOR: what the plan page and the team page
 * say (journey round 6, billing).
 *
 * The person who pays for a workspace may not leave it, hand over their last
 * owner seat, be removed or delete their account while the subscription renews on
 * their card, until another owner has taken billing over; they can always free
 * themselves by ending the subscription at the close of the paid period. The API
 * enforces it (409 `billing_owner`); this module is only the words and the
 * choice of buttons, so the page cannot promise more than the API does.
 *
 * `billing_owner.recorded` false means DeerDawn does not know who pays. Nobody is
 * refused over that, and the page says so rather than naming somebody.
 *
 * SEATS BELOW HEADCOUNT is a notice, not a lock: more people in the workspace
 * than seats on the subscription. Nobody is removed or suspended.
 */

export interface BillingOwnerRecord {
  /** Is somebody on record as paying? */
  recorded: boolean;
  is_you: boolean;
  /** Shown to owners only. */
  email?: string | null;
  /** Owner, or the person who pays: may use the controls below. */
  can_manage?: boolean;
}

export interface TakeoverRecord {
  pending: boolean;
  started_by_you: boolean;
  started_at?: string | null;
}

export interface SeatShortfall {
  members: number;
  seats: number;
  over_by: number;
}

export type BillingOwnerAction = 'take_over' | 'confirm_takeover' | 'end_at_period_end';

export interface BillingOwnerPanelModel {
  heading: string;
  lines: string[];
  actions: BillingOwnerAction[];
}

export const TAKE_OVER_LABEL = 'Take over billing';
export const CONFIRM_TAKEOVER_LABEL = 'I have changed the card';
export const END_AT_PERIOD_END_LABEL = 'End the subscription at the close of the period';

const PAID_TIERS = new Set(['developer_basic', 'developer_pro']);

function longDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return new Date(at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export interface BillingOwnerInput {
  tier: string;
  status?: string | null;
  stripe_customer_id?: string | null;
  billing_period_end?: string | null;
  cancel_at_period_end?: boolean | null;
  cancel_at?: string | null;
  billing_owner?: BillingOwnerRecord | null;
  takeover?: TakeoverRecord | null;
}

/**
 * What the "who pays" panel says and offers, or null when there is nothing to
 * say: a workspace with no Stripe subscription, an incomplete first payment
 * (nothing has been collected), or somebody who may not act on it.
 */
export function billingOwnerPanel(plan: BillingOwnerInput | null | undefined): BillingOwnerPanelModel | null {
  if (!plan || !PAID_TIERS.has(plan.tier) || !plan.stripe_customer_id) return null;
  if (plan.status === 'incomplete' || plan.status === 'cancelled') return null;
  const owner = plan.billing_owner;
  if (!owner || owner.can_manage !== true) return null;

  const endsOn = longDate(plan.cancel_at) || (plan.cancel_at_period_end === true ? longDate(plan.billing_period_end) : null);
  const ending = plan.cancel_at_period_end === true || Boolean(plan.cancel_at);

  // A subscription that is ending renews on nobody's card.
  if (ending) {
    if (!owner.is_you) return null;
    return {
      heading: 'You pay for this workspace',
      lines: [
        `The subscription is set to end${endsOn ? ` on ${endsOn}` : ' at the close of the period'}, so nothing more will be charged to your card.`,
        'You can leave the workspace or delete your account now.',
      ],
      actions: [],
    };
  }

  const takeover = plan.takeover;
  if (takeover?.pending && takeover.started_by_you) {
    return {
      heading: 'Taking over billing',
      lines: [
        'You started taking over billing. In Stripe\'s billing portal, change the payment method so the card that was paying is replaced.',
        'Once the subscription charges a different card, you become the billing owner, and the person who paid is free to leave.',
      ],
      actions: ['take_over', 'confirm_takeover'],
    };
  }

  if (owner.is_you) {
    return {
      heading: 'You pay for this workspace',
      lines: [
        'The subscription renews on your card. Until another owner takes over billing, you cannot leave the workspace, step down as an owner or delete your account.',
        'Or you can end the subscription at the close of the paid period: nothing more is charged, and you can leave.',
      ],
      actions: ['end_at_period_end'],
    };
  }

  const who = owner.recorded ? (owner.email || 'Another owner') : null;
  return {
    heading: 'Who pays',
    lines: [
      who ? `${who} pays for this subscription.` : 'DeerDawn does not have anybody on record as paying for this subscription.',
      takeover?.pending
        ? 'Another owner has started taking over billing.'
        : 'Taking over billing puts your card on it in Stripe. Once the old card is no longer the one being charged, you are the billing owner, and the person who paid is free to leave.',
    ],
    actions: ['take_over'],
  };
}

/** "This workspace has 3 people and 2 seats." plus what has and has not happened. */
export function seatShortfallLine(shortfall: SeatShortfall | null | undefined): string | null {
  if (!shortfall || !(shortfall.members > shortfall.seats)) return null;
  const people = `${shortfall.members} ${shortfall.members === 1 ? 'person' : 'people'}`;
  const seats = `${shortfall.seats} ${shortfall.seats === 1 ? 'seat' : 'seats'}`;
  return `This workspace has ${people} and ${seats}. Nobody has been removed or locked out. Add seats, or remove people, so the seats cover everyone; until then nobody new can be invited.`;
}
