'use strict';

/**
 * WHY A WORKSPACE IS LOCKED, AND WHAT THE PERSON IS TOLD.
 *
 * Three locks used to answer one sentence ("This workspace is locked. Contact
 * support to restore access."), and they need different things from the reader:
 *
 *   dispute            A payment on the account was disputed with the card
 *                      issuer. Held in organizations.dispute_lock_ids, written
 *                      only by the Stripe webhook (and DeerDawn by hand, see
 *                      docs/RUNBOOK.md, "Disputes"). Billing cannot lift it.
 *   lockdown           An owner turned lockdown on (organizations.is_locked,
 *                      PATCH /orgs/settings). An owner turns it off.
 *   foreign_workspace  The locked workspace is somebody else's: the reader is
 *                      not an owner of it. They can only switch to their own.
 *
 * The sentences are the owner's (John, 2026-09-29), word for word. The dashboard
 * carries the same text keyed by `lock_reason` (lib/lockCopy.ts); the code is the
 * contract, the message is for a client that only prints what it is sent.
 */

const SUPPORT_EMAIL = 'support@deerdawn.com';

const LOCK_MESSAGES = Object.freeze({
  dispute: 'This workspace is locked because a payment on this account was disputed with the card issuer. '
    + 'Billing cannot lift it. Email support from the address on this account and we will review it.',
  lockdown: 'This workspace was locked on purpose by an owner of this account. Ask an owner to turn lockdown off. '
    + 'If you are the owner and did not do this, email support.',
  foreign_workspace: 'The workspace you are using is locked, so nothing in it will load. '
    + 'Switch to your own workspace to keep working, or ask its owner to lift the lock.',
});

/** Does a Stripe dispute hold this workspace locked? */
function hasDisputeLock(org) {
  return Array.isArray(org?.dispute_lock_ids) && org.dispute_lock_ids.length > 0;
}

/**
 * Which lock this workspace is under, or null. A dispute wins over a lockdown:
 * the owner's setting cannot lift it, so it is the reason worth naming.
 */
function orgLockReason(org) {
  if (hasDisputeLock(org)) return 'dispute';
  if (org?.is_locked) return 'lockdown';
  return null;
}

module.exports = { SUPPORT_EMAIL, LOCK_MESSAGES, hasDisputeLock, orgLockReason };
