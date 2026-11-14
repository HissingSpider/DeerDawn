/**
 * Display logic for /admin/today, kept out of the page.
 *
 * Same reason `todayConnection.ts` exists: a source-text contract cannot see a
 * render tree, so anything worth asserting about behaviour has to live in a
 * function that can be called with real inputs. Everything here is pure and
 * clock-injected — no `Date.now()` inside, so the tests are not time-dependent.
 */

import type { OperatorToday } from '@/lib/api';

/** Windows an operator actually asks for. `days` is clamped server-side too. */
export const OPERATOR_WINDOWS: ReadonlyArray<{ days: number; label: string; phrase: string }> = [
  { days: 1, label: 'Today', phrase: 'today' },
  { days: 7, label: '7 days', phrase: 'in the last 7 days' },
  { days: 30, label: '30 days', phrase: 'in the last 30 days' },
];

/**
 * "4m ago" / "3h ago" / "2d ago". Recency is the point of this page — an
 * operator wants to know whether the last brief was this morning or last week,
 * and a bare timestamp makes them do that subtraction themselves.
 *
 * `now` is passed in rather than read, so every row on one render agrees.
 */
export function relativeTime(iso: string | null | undefined, now: number): string {
  const then = Date.parse(iso || '');
  if (!Number.isFinite(then)) return '—';
  // Clamped at zero: a row stamped a second into the future (clock skew between
  // the API host and the browser) must read "just now", never "-1m ago".
  const mins = Math.max(0, Math.round((now - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Local wall-clock time, so "when" is legible without doing UTC maths. */
export function clockTime(iso: string | null | undefined): string {
  const d = new Date(iso || '');
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * The answer, in one sentence, because that is how the question is asked.
 *
 * Plural forms are spelled out rather than assembled by appending `s`: "1
 * people got 1 briefs" is the fastest way to make a page look like it is
 * guessing, and at these counts the singular case is the COMMON one.
 */
export function summarySentence(
  data: Pick<OperatorToday, 'people_count' | 'briefs_count' | 'first_timers'>,
  windowPhrase: string,
): string {
  const people = data.people_count;
  const briefs = data.briefs_count;
  const first = data.first_timers;

  if (people === 0) return `Nobody got a brief ${windowPhrase}.`;

  const who = people === 1 ? '1 person' : `${people} people`;
  const what = briefs === 1 ? '1 brief' : `${briefs} briefs`;
  const head = `${who} got ${what} ${windowPhrase}.`;

  if (first === 0) return `${head} None were a first.`;
  return `${head} ${first === 1 ? '1 was' : `${first} were`} somebody's first ever.`;
}

/**
 * "+2 others" under the primary project/tool. Returns null when there is
 * nothing extra, so the caller renders nothing rather than "+0 others".
 */
export function overflowLabel(total: number): string | null {
  const extra = Math.max(0, total - 1);
  if (extra === 0) return null;
  return `+${extra} other${extra === 1 ? '' : 's'}`;
}

/**
 * How a person is named in the list. An unresolved row shows a stated
 * placeholder — never a guess, and never silently blank.
 */
export function displayName(person: { email: string | null }): string {
  return person.email ?? 'Unidentified account';
}
