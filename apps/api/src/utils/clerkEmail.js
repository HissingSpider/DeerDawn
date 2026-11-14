'use strict';

/**
 * WHICH OF A CLERK USER'S ADDRESSES IS "THEIR EMAIL".
 *
 * A Clerk user carries a LIST of email addresses and a pointer to the primary
 * one. The list is not ordered by primacy: it is ordered by when each address
 * was added, so `[0]` is the OLDEST address, which is exactly the one a person
 * who changed their email is trying to leave behind. Anybody who added a work
 * address and made it primary was still, as far as DeerDawn was concerned, the
 * person at their old address — lifecycle mail went there, invites addressed to
 * the new one never matched them, and `users.email` could not be corrected by
 * signing in again because sign-in read the same wrong element.
 *
 * Two shapes reach this service and they spell everything differently:
 *   - the Backend SDK object (`clerk.users.getUser`): camelCase —
 *     `primaryEmailAddressId`, `emailAddresses[].emailAddress`
 *   - the webhook payload (`evt.data`): snake_case —
 *     `primary_email_address_id`, `email_addresses[].email_address`
 * One reader for both, so the two entry points cannot disagree about who
 * somebody is.
 *
 * Falls back to the first address only when the pointer is absent or dangling
 * (it names an id that is not in the list). That is the old behaviour, kept for
 * the one case where it is the best available answer rather than a wrong one.
 * Returns null when there is no address at all; callers decide what that means.
 *
 * `strict: true` disables the fallback. Sign-in needs SOME address to provision
 * an account against, so it takes the fallback; the user.updated webhook is
 * about to OVERWRITE a stored address, and overwriting it with a guess is worse
 * than leaving it alone.
 */
function primaryClerkEmail(clerkUser, { strict = false } = {}) {
    if (!clerkUser || typeof clerkUser !== 'object') return null;

    const addresses = Array.isArray(clerkUser.emailAddresses)
        ? clerkUser.emailAddresses
        : Array.isArray(clerkUser.email_addresses)
            ? clerkUser.email_addresses
            : [];
    const primaryId = clerkUser.primaryEmailAddressId || clerkUser.primary_email_address_id || null;

    const read = (entry) => {
        const value = entry && (entry.emailAddress || entry.email_address);
        return typeof value === 'string' && value.trim() ? value.trim() : null;
    };

    if (primaryId) {
        const primary = addresses.find((entry) => entry && entry.id === primaryId);
        const email = read(primary);
        if (email) return email;
    }
    if (strict) return null;

    for (const entry of addresses) {
        const email = read(entry);
        if (email) return email;
    }
    return null;
}

module.exports = { primaryClerkEmail };
