/**
 * Relative-time formatting for the dashboard.
 *
 * Lives in lib rather than inside the page because it produced a user-visible
 * grammar bug the first time it shipped: `relativeTime` returned the phrase
 * "just now" for the under-a-minute case, and its caller renders every value as
 * "last touched <value> ago" — so the resume card read "last touched just now
 * ago" on any project touched in the last sixty seconds, which is exactly the
 * project the card is most likely to be showing.
 *
 * The rule that prevents a repeat: `relativeTime` returns a bare DURATION that
 * must read correctly with " ago" after it, and never a complete phrase. Callers
 * that render the value on its own (a table column, the surface strip) use
 * `shortTime`, which is allowed to substitute a standalone spelling.
 *
 * `now` is passed in rather than read here: reading the clock during render is
 * impure, and the server and browser would disagree on it, which is a hydration
 * mismatch on the first thing a returning user sees. Pass null before mount.
 */

/** A bare duration. Always reads correctly followed by the word "ago". */
export function relativeTime(now: number | null, iso: string | null | undefined): string {
  if (now === null) return '';
  if (!iso) return 'never';
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'never';
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'moments';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.round(days / 30)}mo`;
}

/** The same measurement rendered standalone, with no trailing "ago". */
export function shortTime(now: number | null, iso: string | null | undefined): string {
  const value = relativeTime(now, iso);
  return value === 'moments' ? 'now' : value;
}
