/**
 * A task card's BODY — the dashboard half of rules that live in
 * `packages/shared-context/src/index.js`.
 *
 * PR #390 gave a card a body so a spec would stop being crammed into its title
 * (four cards shipped with wrong file paths because on that board the title WAS
 * the body). The board stores it, both MCP dispatchers write it — and the
 * dashboard could neither show one nor write one.
 *
 * Three server rules decide what this UI is allowed to promise, and all three
 * fail SILENTLY if the UI guesses wrong. They are functions here, not JSX,
 * because every contract suite in `tests/` reads source as text and so can pin a
 * string but never an outcome:
 *
 *   1. A body over the cap is CLIPPED, never rejected (normalizeTodoBody). The
 *      write succeeds either way, so a UI that says "saved" and shows the text
 *      the user typed is lying about what is stored.
 *   2. A body is written by re-adding the card's TITLE — `add_todos:
 *      [{title, body}]` sets the body of the card that title already names. The
 *      merge matches on the lowercased title exactly, so a title that matches
 *      two cards writes to the wrong one, and a title that matches none files a
 *      brand-new card.
 *   3. `if (entry.body && …)` — an empty body is normalized to undefined and
 *      skipped, so a body can never be CLEARED this way. The request returns
 *      200 and nothing changes. That is the exact "reported success while doing
 *      nothing" class this repo keeps shipping, so the UI refuses it up front
 *      rather than passing it on.
 */

/**
 * Mirror of `MAX_TODO_BODY_CHARS` in packages/shared-context/src/index.js.
 * Pinned to that source in taskCardBody.test.ts — if the cap moves there and
 * not here, the counter in the editor starts lying about where the cut lands.
 */
export const TASK_BODY_MAX_CHARS = 2000;

/**
 * The word this UI puts on a card that has a body. shared-context marks the same
 * thing with ` +body` in every text surface (the brief, both MCP listings); a
 * marker that differs per surface is a marker nobody learns to look for.
 */
export const TASK_BODY_MARKER_LABEL = 'body';

/** Thousands separators without a locale formatter — this string is rendered. */
function withThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export const TASK_BODY_MAX_LABEL = withThousands(TASK_BODY_MAX_CHARS);

/**
 * What the server will actually store for this text. Mirror of normalizeTodoBody:
 * trim, then clip to the cap with a trailing ellipsis (never reject).
 */
export function clipTaskBody(value: string | null | undefined): string {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.length > TASK_BODY_MAX_CHARS
    ? `${text.slice(0, TASK_BODY_MAX_CHARS - 1)}…`
    : text;
}

/** True when saving this text would lose the end of it. */
export function taskBodyWouldClip(value: string | null | undefined): boolean {
  return String(value ?? '').trim().length > TASK_BODY_MAX_CHARS;
}

/**
 * True when a STORED body carries the shape clipping leaves behind — exactly at
 * the cap and ending in the ellipsis the clip appends. A body that genuinely
 * ends in an ellipsis at exactly 2,000 characters reads as clipped too; saying so
 * about an intact body costs a sentence, and staying silent about a clipped one
 * costs the reader the part that was cut.
 */
export function taskBodyIsAtLimit(stored: string | null | undefined): boolean {
  const text = String(stored ?? '');
  return text.length === TASK_BODY_MAX_CHARS && text.endsWith('…');
}

// ── Which card a save would actually land on ─────────────────────────────────

/** A stored card, as it appears in `context.todo_items`. */
export interface StoredTaskCard {
  id: string;
  title: string;
  body?: string | null;
}

/** A card as the board renders it — including derived, unsaved step cards. */
export interface BoardCardRef {
  id: string;
  title: string;
  kind?: string;
}

export type BodyTarget =
  | { writable: true; title: string }
  | { writable: false; reason: 'derived_step' | 'unmatched_title' | 'duplicate_title'; note: string };

export const BODY_STEP_NOTE =
  'This is a step of the current task, projected onto the board by your AI. It has no stored card, so there is nothing to write a body to.';

export const BODY_UNMATCHED_NOTE =
  'A body is saved by matching the card title, and this card is not on the project’s card list — it came in from the older completed list. Saving would file a new card instead of adding detail here.';

export const BODY_DUPLICATE_NOTE =
  'Two cards share this title. A body is saved by matching the title, so this would land on whichever one the server saw last. Rename one of them first.';

/**
 * Resolve which stored card `add_todos:[{title}]` would hit, using the merge's
 * own predicate: the query title is trimmed, the stored titles are not. Anything
 * other than exactly one match is refused here rather than sent — the write
 * would return 200 and put the body somewhere else.
 */
export function resolveBodyTarget(
  todoItems: ReadonlyArray<StoredTaskCard> | null | undefined,
  card: BoardCardRef,
): BodyTarget {
  if (card.kind === 'step') return { writable: false, reason: 'derived_step', note: BODY_STEP_NOTE };
  const query = String(card.title ?? '').trim();
  const matches = (todoItems ?? []).filter(
    (item) => String(item?.title ?? '').toLowerCase() === query.toLowerCase(),
  );
  if (matches.length === 0) return { writable: false, reason: 'unmatched_title', note: BODY_UNMATCHED_NOTE };
  if (matches.length > 1) return { writable: false, reason: 'duplicate_title', note: BODY_DUPLICATE_NOTE };
  return { writable: true, title: query };
}

// ── What a save would do ─────────────────────────────────────────────────────

export const BODY_CLEAR_NOTE =
  'A body can’t be emptied from here — the save path only ever adds detail, so this would report success and change nothing. Replace the text, or remove the card.';

export type BodySavePlan =
  | { action: 'save'; body: string; clipped: boolean }
  | { action: 'blocked'; reason: 'clear_unsupported'; note: string }
  | { action: 'skip'; reason: 'empty' | 'unchanged' };

/**
 * Decide what pressing Save should do — including the two cases where the honest
 * answer is "nothing", said out loud. `body` is what will be STORED, not what was
 * typed, so the caller can show the user exactly that.
 */
export function planBodySave(draft: string, current?: string | null): BodySavePlan {
  const typed = String(draft ?? '').trim();
  const stored = String(current ?? '').trim();
  if (!typed) {
    return stored
      ? { action: 'blocked', reason: 'clear_unsupported', note: BODY_CLEAR_NOTE }
      : { action: 'skip', reason: 'empty' };
  }
  const body = clipTaskBody(typed);
  if (body === stored) return { action: 'skip', reason: 'unchanged' };
  return { action: 'save', body, clipped: taskBodyWouldClip(typed) };
}

/** Live counter under the editor. Says where the cut lands BEFORE the save. */
export function bodyLengthNote(draft: string): { over: boolean; text: string } {
  const length = String(draft ?? '').trim().length;
  if (length > TASK_BODY_MAX_CHARS) {
    return {
      over: true,
      text: `${withThousands(length)} characters — ${withThousands(length - TASK_BODY_MAX_CHARS)} over the limit. Saving clips this to ${TASK_BODY_MAX_LABEL}.`,
    };
  }
  return { over: false, text: `${withThousands(length)} / ${TASK_BODY_MAX_LABEL}` };
}

/** What the toast says AFTER the save. Never "saved" alone when it was clipped. */
export function bodySavedNotice(clipped: boolean): string {
  return clipped
    ? `Saved — clipped to ${TASK_BODY_MAX_LABEL} characters.`
    : 'Body saved.';
}

/** Shown above a stored body that arrived at the cap. */
export const BODY_AT_LIMIT_NOTE = `At the ${TASK_BODY_MAX_LABEL}-character limit — anything past that was cut when this was saved.`;
