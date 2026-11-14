/**
 * WHY A WORKSPACE IS LOCKED, in the owner's own words (John, 2026-09-29).
 *
 * One sentence ("This workspace is locked. Contact support to restore access.")
 * used to cover three different locks, and it was wrong for two of them: an
 * owner who had turned lockdown on was told to write to support, and a person
 * whose card issuer had raised a dispute was told the same with no hint that
 * billing cannot lift it. The API says which lock it is (`lock_reason` on the
 * 403, apps/api/src/services/lockReasons.js) and the screen says what that
 * reason means for the reader.
 *
 *   dispute            a payment was disputed with the card issuer; billing
 *                      cannot lift it; support reviews it.
 *   lockdown           an owner turned lockdown on; an owner turns it off.
 *   foreign_workspace  the locked workspace is somebody else's; leave it.
 *
 * The text here equals the API's `message` for the same reason. A client that
 * only prints what it is sent still says the same thing.
 */

export type LockReason = 'dispute' | 'lockdown' | 'foreign_workspace';

export const SUPPORT_EMAIL = 'support@deerdawn.com';
export const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}`;

export const LOCK_COPY: Readonly<Record<LockReason, string>> = {
  dispute: 'This workspace is locked because a payment on this account was disputed with the card issuer. '
    + 'Billing cannot lift it. Email support from the address on this account and we will review it.',
  lockdown: 'This workspace was locked on purpose by an owner of this account. Ask an owner to turn lockdown off. '
    + 'If you are the owner and did not do this, email support.',
  foreign_workspace: 'The workspace you are using is locked, so nothing in it will load. '
    + 'Switch to your own workspace to keep working, or ask its owner to lift the lock.',
};

/** The reason the server sent, or null when it sent none this client knows. */
export function lockReasonOf(value: unknown): LockReason | null {
  return value === 'dispute' || value === 'lockdown' || value === 'foreign_workspace' ? value : null;
}

/**
 * The sentence for a lock. A reason the server did not send (an API that
 * predates lock_reason) is the lockdown sentence: that was the only lock there
 * was, and it says who can lift it.
 */
export function lockSentence(reason: LockReason | null | undefined): string {
  return LOCK_COPY[reason || 'lockdown'];
}
