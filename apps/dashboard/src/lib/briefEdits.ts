/**
 * ONE CLICK CHANGES ONE LINE.
 *
 * The brief's Pin, Edit, "This is wrong" and Dismiss have no per-item endpoint:
 * each one PATCHes the whole list the line lives in. They used to build that
 * list from the context the tab loaded, and the tab never refreshed itself. So a
 * person whose own AI tool had recorded a decision since the page loaded clicked
 * Pin on an older line, the tab sent back the three decisions it had loaded, the
 * API answered 200 and the toast said "Brief updated." — and the tool's decision
 * was gone from the brief, the decision history, and the tool's own recall
 * (journey r3, S3-1).
 *
 * Now every per-line change:
 *   1. reads the project FRESH, not from what the tab holds;
 *   2. finds the clicked line in the fresh list by what identifies it — its text
 *      plus the stamp the entry carries (decided_at, added_at) — never by its
 *      position in the old list, which moves the moment a tool adds a line;
 *   3. applies the one change to the fresh list, and writes it with the version
 *      it read, so the API refuses it (409 stale_context_version) if anything
 *      landed in between; then reads again and re-applies, at most twice more;
 *   4. writes NOTHING when the line is no longer there as the person saw it —
 *      somebody changed or removed it — and hands back the fresh brief so the
 *      caller can show what is actually saved.
 *
 * Pure apart from the read/write functions the caller passes in, so the rules
 * run here against real inputs (src/lib/briefEdits.test.ts).
 */
import type { ProjectContextJson } from './api';

export type EditableSlot = 'decided' | 'open' | 'landmine';
export type BriefArrayField = 'recent_decisions' | 'open_questions' | 'landmines';

// SHIPPED is structured-events only (no hand edits), so it has no entry here.
export const EDITABLE_SLOT_FIELD: Record<EditableSlot, BriefArrayField> = {
  decided: 'recent_decisions',
  open: 'open_questions',
  landmine: 'landmines',
};

/** What the person clicked, as they saw it. */
export interface LineIdentity {
  text: string;
  /** decided_at for a decision, added_at for a landmine; questions carry none. */
  stamp?: string;
}

export type LineChange =
  | { kind: 'edit'; text: string }
  | { kind: 'pin' }
  | { kind: 'dismiss' };

// ── The words a person reads ──────────────────────────────────────────────────

export const BRIEF_SAVED_MESSAGE = 'Brief updated.';
/** The clicked line changed or went away on the server: nothing was written. */
export const LINE_CHANGED_MESSAGE =
  'Not saved: the brief changed since this page loaded, and that line is no longer as you saw it. What you see now is current.';
/** Every attempt met a newer brief: nothing was written. */
export const BRIEF_BUSY_MESSAGE =
  'Not saved: the brief kept changing while this was saving. What you see now is current. Try again.';
/** The blocker the person completed is not the one stored any more. */
export const BLOCKER_CHANGED_MESSAGE =
  'Not cleared: the blocker changed since this page loaded. What you see now is current.';

// ── Identity ─────────────────────────────────────────────────────────────────

const norm = (value: unknown) => String(value ?? '').trim().replace(/\s+/g, ' ');

/** The text a stored entry shows in its slot (mirrors deriveBriefSpine's mappers). */
export function entryText(slot: EditableSlot, entry: unknown): string {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return '';
  const obj = entry as Record<string, unknown>;
  if (slot === 'decided') return String(obj.summary ?? '');
  if (slot === 'landmine') return String(obj.text || obj.summary || '');
  return '';
}

/** The stable stamp a stored entry carries, if any. */
export function entryStamp(slot: EditableSlot, entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const obj = entry as Record<string, unknown>;
  const raw = slot === 'decided' ? obj.decided_at : slot === 'landmine' ? obj.added_at : undefined;
  return typeof raw === 'string' && raw ? raw : undefined;
}

/** A line of the brief, as the slot renders it, reduced to what identifies it. */
export function lineIdentity(
  slot: EditableSlot,
  item: { text: string; decided_at?: string; added_at?: string },
): LineIdentity {
  const stamp = slot === 'decided' ? item.decided_at : slot === 'landmine' ? item.added_at : undefined;
  return stamp ? { text: item.text, stamp } : { text: item.text };
}

/**
 * Where the line the person clicked is in THIS list, or -1 when it is not there
 * as they saw it. Text must match; a stamp, when the clicked line had one, must
 * match too — two decisions can read alike, and the stamp is what the text
 * alone cannot tell apart. A decision that has since been resolved has left the
 * DECIDED slot, so it counts as gone.
 */
export function findLine(slot: EditableSlot, entries: unknown[], id: LineIdentity): number {
  const want = norm(id.text);
  if (!want) return -1;
  return entries.findIndex((entry) => {
    if (norm(entryText(slot, entry)) !== want) return false;
    if (id.stamp && entryStamp(slot, entry) !== id.stamp) return false;
    if (slot === 'decided' && entry && typeof entry === 'object' && (entry as Record<string, unknown>).resolved) return false;
    return true;
  });
}

// ── The change ───────────────────────────────────────────────────────────────

function withText(slot: EditableSlot, entry: unknown, text: string): unknown {
  if (slot === 'open') return text; // open_questions are bare strings
  if (typeof entry === 'string') return { summary: text };
  const obj = entry as Record<string, unknown>;
  if (slot === 'decided') return { ...obj, summary: text };
  // A landmine is STORED under `summary` (the server's normaliser reads summary
  // before text), and some rows also carry `text`. Setting `text` alone left the
  // stored summary — what every tool reads — on the old wording.
  return 'text' in obj ? { ...obj, summary: text, text } : { ...obj, summary: text };
}

function withImportance(slot: EditableSlot, entry: unknown): unknown {
  if (slot === 'open') return entry; // bare strings carry no importance
  if (typeof entry === 'string') return { summary: entry, importance: 'high' };
  return { ...(entry as Record<string, unknown>), importance: 'high' };
}

/** A new list with the one change applied at `index`. Nothing else moves. */
export function applyLineChange(slot: EditableSlot, entries: unknown[], index: number, change: LineChange): unknown[] {
  if (index < 0 || index >= entries.length) return entries.slice();
  if (change.kind === 'dismiss') return entries.filter((_, i) => i !== index);
  return entries.map((entry, i) => {
    if (i !== index) return entry;
    return change.kind === 'edit' ? withText(slot, entry, change.text) : withImportance(slot, entry);
  });
}

function listOf(ctx: ProjectContextJson | null | undefined, field: BriefArrayField): unknown[] {
  const value = ctx ? (ctx as Record<string, unknown>)[field] : undefined;
  return Array.isArray(value) ? value : [];
}

/**
 * The same change, applied to a whole context by identity: the optimistic draft
 * the tab shows while the write is in flight. Unchanged (and `found: false`)
 * when the line is not in it.
 */
export function applyChangeToContext(
  ctx: ProjectContextJson,
  slot: EditableSlot,
  id: LineIdentity,
  change: LineChange,
): { context: ProjectContextJson; found: boolean } {
  const field = EDITABLE_SLOT_FIELD[slot];
  const list = listOf(ctx, field);
  const index = findLine(slot, list, id);
  if (index < 0) return { context: ctx, found: false };
  return { context: { ...ctx, [field]: applyLineChange(slot, list, index, change) } as ProjectContextJson, found: true };
}

// ── Versions and the write loop ──────────────────────────────────────────────

export const STALE_VERSION_CODE = 'stale_context_version';

/** The version a read was taken at, when the API reports one. */
export function contextVersionOf(ctx: ProjectContextJson | null | undefined): number | null {
  const raw = ctx ? (ctx as Record<string, unknown>).context_version : undefined;
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : null;
}

/** The API refused the write because the brief moved on since the read. */
export function isStaleVersionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: unknown; code?: unknown; data?: { error?: unknown; code?: unknown } };
  if (e.status !== 409) return false;
  return e.code === STALE_VERSION_CODE || e.data?.error === STALE_VERSION_CODE || e.data?.code === STALE_VERSION_CODE;
}

export interface FreshWriteIO {
  /** Read the project's brief now (GET /inject?format=json). */
  read: () => Promise<ProjectContextJson>;
  /** Write a patch, guarded on the version it was built from (null: unguarded). */
  write: (patch: Record<string, unknown>, expectedVersion: number | null) => Promise<unknown>;
}

export type FreshWriteResult =
  | { outcome: 'saved'; attempts: number }
  | { outcome: 'gone'; attempts: number; context: ProjectContextJson };

/** How many times a write refused as stale is re-read and re-applied. */
export const STALE_RETRIES = 2;

/**
 * Read, build, write — and on a stale refusal, read and build again (at most
 * `retries` more times). `build` returns the patch for the brief as it is NOW,
 * or null when what the person acted on is no longer there, in which case
 * nothing is written and the fresh brief is handed back. Any other failure, and
 * a stale refusal on the last attempt, is thrown to the caller.
 */
export async function writeFromFreshRead(
  io: FreshWriteIO,
  build: (fresh: ProjectContextJson) => Record<string, unknown> | null,
  retries: number = STALE_RETRIES,
): Promise<FreshWriteResult> {
  for (let attempt = 1; ; attempt += 1) {
    const fresh = await io.read();
    const patch = build(fresh);
    if (!patch) return { outcome: 'gone', attempts: attempt, context: fresh };
    try {
      await io.write(patch, contextVersionOf(fresh));
      return { outcome: 'saved', attempts: attempt };
    } catch (err) {
      if (isStaleVersionError(err) && attempt <= retries) continue;
      throw err;
    }
  }
}

/** One line, one change, against the brief as it is now. */
export function saveLineChange(
  io: FreshWriteIO,
  slot: EditableSlot,
  id: LineIdentity,
  change: LineChange,
  retries: number = STALE_RETRIES,
): Promise<FreshWriteResult> {
  const field = EDITABLE_SLOT_FIELD[slot];
  return writeFromFreshRead(io, (fresh) => {
    const list = listOf(fresh, field);
    const index = findLine(slot, list, id);
    if (index < 0) return null;
    return { [field]: applyLineChange(slot, list, index, change) };
  }, retries);
}

// ── A refused edit keeps what was typed ──────────────────────────────────────

/**
 * An edit the API refused because the brief changed underneath it — the line
 * was no longer as the person saw it, or every attempt met a newer brief. The
 * editor used to close and the typed text was thrown away. Now the text is
 * kept, on screen, beside the line as it now reads (or, when the line is gone,
 * on its own with that said), until the person saves it again or discards it.
 */
export type RefusedEditReason = 'changed' | 'busy';

export interface RefusedEdit {
  id: string;
  projectId: string;
  slot: EditableSlot;
  /** The line as the person saw it when they pressed Save. */
  seen: LineIdentity;
  /** What they typed. */
  draft: string;
  mode: 'edit' | 'correct';
  reason: RefusedEditReason;
}

/** Said beside kept text whose line is still in the brief. */
export const EDIT_KEPT_NOTE = 'Your text is kept here: copy it, adjust it, and save again.';
/** Said when the line the person was editing is no longer in the brief. */
export const LINE_GONE_MESSAGE =
  'Not saved: that line is no longer in the brief. It was changed or removed since this page loaded. Your text is kept here so you can copy it.';
/** The label over the line as it reads now, beside the kept text. */
export const LINE_NOW_LABEL = 'The line now reads';

let refusedEditSeq = 0;

export function refusedEditFor(fields: Omit<RefusedEdit, 'id'>): RefusedEdit {
  refusedEditSeq += 1;
  return { id: `refused-${Date.now().toString(36)}-${refusedEditSeq}`, ...fields };
}

/**
 * Which of the slot's lines, as they are NOW, the kept text belongs beside; -1
 * when none. A stamped line (a decision, a landmine) is found by its stamp alone,
 * so a reworded line is still found — and never by words alone, since two
 * entries can read alike. A question has no stamp: it is found by its words,
 * and a reworded question counts as gone.
 */
export function locateRefusedLine(
  slot: EditableSlot,
  items: Array<{ text: string; decided_at?: string; added_at?: string }>,
  seen: LineIdentity,
): number {
  if (seen.stamp) return items.findIndex((item) => lineIdentity(slot, item).stamp === seen.stamp);
  const want = norm(seen.text);
  if (!want) return -1;
  return items.findIndex((item) => norm(item.text) === want);
}

/** What the person is told above their kept text. */
export function refusedEditMessage(edit: RefusedEdit, located: boolean): string {
  if (!located) return LINE_GONE_MESSAGE;
  return edit.reason === 'busy' ? BRIEF_BUSY_MESSAGE : LINE_CHANGED_MESSAGE;
}

// ── Keys that follow a line, not a position ─────────────────────────────────

/**
 * React keys for one slot's lines. They were `${slot}-${index}`, and the tab
 * now refetches the brief when it regains focus: a line added or evicted ahead
 * of an open editor shifted every index, so the editor (and its draft) moved
 * onto somebody else's line. A stamped line (decided_at, added_at, shipped_at)
 * keeps its key through a refresh and through an edit of its own text; a line
 * with no stamp (a question) is keyed by its text. Repeats get a suffix.
 */
export function briefLineKeys(
  slot: string,
  items: Array<{ text: string; decided_at?: string; added_at?: string; shipped_at?: string }>,
): string[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const stamp = item.decided_at || item.added_at || item.shipped_at;
    const base = stamp ? `${slot}:s:${stamp}` : `${slot}:t:${item.text}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}#${n}` : base;
  });
}

// ── A list edited as a block of lines (the /memory project editor's goals) ───

/**
 * The lines the person removed and added, applied to the list as it is NOW.
 * A textarea edit is a set of line changes, not a new list: lines somebody else
 * added since the editor opened stay, and a line the person removed is removed
 * wherever it now sits. Order: the fresh list's surviving lines, then the new
 * ones in the order typed.
 */
export function mergeLineEdits(original: string[], edited: string[], fresh: string[]): string[] {
  const key = (s: string) => norm(s).toLowerCase();
  const before = new Set(original.map(key));
  const after = new Set(edited.map(key));
  const removed = new Set([...before].filter((k) => !after.has(k)));
  const kept = fresh.filter((line) => !removed.has(key(line)));
  const present = new Set(kept.map(key));
  const added: string[] = [];
  for (const line of edited) {
    const k = key(line);
    if (before.has(k) || present.has(k)) continue;
    present.add(k);
    added.push(line);
  }
  return [...kept, ...added];
}

// ── The /memory project editor: send what the person changed, nothing else ──

const PROJECT_EDITOR_SCALARS = ['project_name', 'description', 'current_task', 'current_status'] as const;

const editorLines = (text: string | undefined) =>
  String(text ?? '').split('\n').map((s) => s.trim()).filter(Boolean);

/**
 * The editor opens on a copy of the project taken when /memory loaded, and it
 * used to send every field back on Save — so renaming a project put back the
 * task, status and goals the page had loaded, over whatever the person's AI
 * tool had written since. Now only the fields the person actually changed are
 * written. Goals, a list, are merged as line edits onto the list as it is at
 * save time (see mergeLineEdits); null when there is nothing to write at all.
 */
export function projectEditorPatch(
  start: Record<string, string | undefined>,
  edited: Record<string, string | undefined>,
): { scalars: Record<string, string>; goals: { original: string[]; edited: string[] } | null } | null {
  const scalars: Record<string, string> = {};
  for (const key of PROJECT_EDITOR_SCALARS) {
    const before = String(start[key] ?? '');
    const after = String(edited[key] ?? '');
    if (after !== before) scalars[key] = after;
  }
  const original = editorLines(start.goals);
  const next = editorLines(edited.goals);
  const goalsChanged = original.length !== next.length || original.some((line, i) => line !== next[i]);
  const goals = goalsChanged ? { original, edited: next } : null;
  if (!Object.keys(scalars).length && !goals) return null;
  return { scalars, goals };
}
