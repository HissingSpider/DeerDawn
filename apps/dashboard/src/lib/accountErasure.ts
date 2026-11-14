/**
 * The typed confirmation DELETE /api/v1/context/account demands, and what to
 * say when it refuses.
 *
 * THE BUG. /security sent `DELETE /api/v1/context/account` with NO BODY and then
 * rendered success only once it had a `confirmation_token` back. The route has
 * required `body.confirmation === 'DELETE MY DEERDAWN ACCOUNT'` since it was
 * written, and answers `{ deleted, deleted_counts, subscription_cancelled }` —
 * there has never been a `confirmation_token` in it. So the button could not
 * succeed: every press was a 400, and the "Danger zone" was a control that did
 * nothing, wearing copy ("Your account stays") that described only half of what
 * the route does.
 *
 * The phrase lives here as one constant, pinned by accountErasure.test.ts to the
 * literal in the route, and the typed value is compared against it before the
 * request goes anywhere — this is irreversible, so the button is unreachable
 * until the person has written the sentence out.
 */

/**
 * The exact string the route compares against. Sent verbatim rather than
 * echoing what was typed, so trailing whitespace a browser or a password
 * manager added cannot turn a correct confirmation into a 400.
 */
export const ACCOUNT_ERASURE_PHRASE = 'DELETE MY DEERDAWN ACCOUNT';

/**
 * Has the person written the phrase out?
 *
 * Case-sensitive on purpose: the point of a typed confirmation is that it cannot
 * be produced by accident, and "delete my deerdawn account" is a sentence
 * somebody could paste from this page's own copy without reading it. Surrounding
 * whitespace is forgiven because it is invisible, and the canonical constant is
 * what gets sent either way.
 */
export function erasurePhraseMatches(typed: string | null | undefined): boolean {
  return typeof typed === 'string' && typed.trim() === ACCOUNT_ERASURE_PHRASE;
}

/**
 * What a failed erasure should say.
 *
 * Every branch here is a real answer from the route, and each means something
 * different to the person reading it. A single "Deletion failed" told them
 * nothing about which, and in the 409 case it hid the one thing they could act
 * on. NOTHING here is retryable automatically — this deletes data, so a retry is
 * always a decision the person makes.
 */
export function describeErasureFailure(status: number, body: unknown): string {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const code = typeof b.error === 'string' ? b.error : '';
  const apiMessage = typeof b.message === 'string' && b.message.trim() ? b.message.trim() : '';

  if (code === 'workspace_has_members' || status === 409) {
    return apiMessage
      || 'This workspace has other members, so nothing was deleted. Remove them first, or leave the workspace instead of emptying it.';
  }
  if (code === 'billing_cancellation_failed' || status === 502) {
    return apiMessage
      || 'Your subscription could not be cancelled, so nothing was deleted. Cancel it from Billing first, then try again.';
  }
  if (status === 403) {
    return apiMessage || 'Only a workspace owner can delete this workspace’s data. Nothing was deleted.';
  }
  if (code === 'confirmation_required' || status === 400) {
    return `Type ${ACCOUNT_ERASURE_PHRASE} exactly to confirm. Nothing was deleted.`;
  }
  return apiMessage || 'That did not go through, and nothing was deleted. Try again, or contact support.';
}

/**
 * How many rows went, as a sentence, or null when the server sent no counts.
 *
 * `deleted_counts` is a per-table map; the person does not care which tables,
 * only that the erasure was real and how much of it there was.
 */
export function describeErasedRows(counts: Record<string, unknown> | null | undefined): string | null {
  if (!counts || typeof counts !== 'object') return null;
  let total = 0;
  for (const value of Object.values(counts)) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) total += n;
  }
  if (total <= 0) return null;
  return `${total.toLocaleString()} ${total === 1 ? 'record was' : 'records were'} removed.`;
}
