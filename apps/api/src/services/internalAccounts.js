'use strict';

/**
 * WHO IS NOT A CUSTOMER — one definition, in one place.
 *
 * Every cross-account read has to answer this, and until now each one answered
 * it for itself: `TEST_EMAIL_MARKER = '+clerk_test'` is declared THREE separate
 * times (lifecycleSegments.js, activationFollowUp.js, and by re-export in
 * dormantReactivation.js), and none of them exclude the founder. That is fine
 * for an email job — sending the founder a nudge is harmless — and load-bearing
 * for an operator view, where the founder's workspace is by far the highest
 * activity in the product. A "did anyone get value today" list that forgets to
 * drop it is a chart of one person, and it will read as traction.
 *
 * TWO KINDS of not-a-customer, deliberately distinguished:
 *
 *   1. US. Not an email pattern at all — `users.is_platform_staff`, the column
 *      autoMigrate seeds from the PLATFORM_ADMIN_EMAILS allowlist and which
 *      middleware/auth.js calls "non-grantable". It is already the database's
 *      own answer to "is this row one of ours", it survives the founder
 *      changing address, and it needs no list to maintain. Use the flag; do not
 *      re-derive it from an email.
 *
 *   2. SYNTHETIC. Robots wearing an email: Clerk's journey signups
 *      (`+clerk_test`), anything at the company domain, and the review account
 *      Anthropic used for the ChatGPT app submission. These have no
 *      is_platform_staff flag because nobody granted them one, so they DO need
 *      a pattern.
 *
 * MATCHING IS `POSITION`, NEVER `LIKE`. `+clerk_test` contains an underscore,
 * and `_` is a LIKE wildcard — `LIKE '%+clerk_test%'` also matches
 * `+clerkXtest`. The same trap is already pinned by a test on the activation
 * follow-up query; it is repeated here because the marker is the same string.
 * POSITION with a bound parameter is literal, so there is nothing to escape.
 */

/**
 * Substrings that mark an address as synthetic. Lowercase — every comparison
 * below lowercases the column before matching, so these must not carry case.
 */
const SYNTHETIC_EMAIL_MARKERS = Object.freeze([
  '@deerdawn.com',
  '+clerk_test',
  'anthropic-review@',
]);

/**
 * JS-side twin of the SQL predicate, for callers holding rows rather than
 * building a query. Kept in the same module as the SQL so the two cannot drift.
 * A missing email is NOT synthetic — absence of evidence is not evidence, and
 * the `is_platform_staff` flag is the arm that catches our own unattributed
 * rows.
 */
function isSyntheticEmail(email) {
  if (!email) return false;
  const lowered = String(email).toLowerCase();
  return SYNTHETIC_EMAIL_MARKERS.some((marker) => lowered.includes(marker));
}

/** True when this resolved identity should be kept out of customer-facing counts. */
function isInternalIdentity({ email = null, isPlatformStaff = false } = {}) {
  return isPlatformStaff === true || isSyntheticEmail(email);
}

/**
 * Build the SQL half.
 *
 * @param {object} refs
 * @param {string} refs.emailExpr           SQL expression yielding the address (may be NULL).
 * @param {string} refs.platformStaffExpr   SQL expression yielding the boolean flag (may be NULL).
 * @param {number} firstParamIndex          Position of this fragment's first bound parameter.
 * @returns {{ sql: string, params: string[], paramCount: number }}
 *   `sql` is TRUE for an internal row. Append `params` to the caller's list in
 *   order, starting at `firstParamIndex`.
 */
function internalIdentitySql({ emailExpr, platformStaffExpr }, firstParamIndex) {
  const markerClauses = SYNTHETIC_EMAIL_MARKERS.map(
    (_, i) => `POSITION($${firstParamIndex + i} IN lower(COALESCE(${emailExpr}, ''))) > 0`
  );
  return {
    sql: `(COALESCE(${platformStaffExpr}, FALSE) = TRUE OR ${markerClauses.join(' OR ')})`,
    params: [...SYNTHETIC_EMAIL_MARKERS],
    paramCount: SYNTHETIC_EMAIL_MARKERS.length,
  };
}

module.exports = {
  SYNTHETIC_EMAIL_MARKERS,
  isSyntheticEmail,
  isInternalIdentity,
  internalIdentitySql,
};
