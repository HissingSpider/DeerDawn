/**
 * NO BILLING BUTTON UNLESS DEERDAWN KNOWS THE PERSON IS AN OWNER.
 *
 * Only a workspace owner may change a workspace's billing: every billing route
 * refuses anybody else (requireBillingOwner in apps/api billing.js). So a
 * billing or upgrade action offered on a locked or refused state is a dead end
 * for anybody else, and a member sent to a billing page they cannot use has one
 * more thing to report.
 *
 * Round 3's notices followed "owner only" (loadFailure.mayUpdateBilling, the
 * fallback banner's mayFixFallbackBilling); an older helper, teamLoadRefusal,
 * treated an UNKNOWN role as an owner, so the way forward was still offered when
 * the workspace listing could not be read. The owner's decision (journey r4):
 * one rule on every page, and this is it. DeerDawn knows the person is an owner
 * when either
 *   - the workspace listing names their role in that workspace as `owner`, or
 *   - the server has just answered one of their billing requests with a refusal
 *     it only gives past its owner check (a 402 bank-confirmation or overdue
 *     answer, a 400 invalid_plan), which only an owner can receive.
 * An unknown, missing or legacy role is not an owner.
 *
 * Every surface that offers such an action asks this, and
 * billingAccess.test.ts checks they agree for every role, unknown included.
 */
export interface OwnerEvidence {
  /** The person's role in the workspace, as the listing (or roster) names it. */
  role?: string | null;
  /** The server answered a billing request past its owner check. */
  ownerConfirmedByServer?: boolean;
}

export function mayOfferBilling(evidence: OwnerEvidence | null | undefined): boolean {
  if (!evidence) return false;
  if (evidence.ownerConfirmedByServer === true) return true;
  return String(evidence.role ?? '').trim().toLowerCase() === 'owner';
}
