import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { BOARD_PHASE_LABELS, type BoardPhase, type TodoItem } from '@/lib/api';
import {
  BODY_AT_LIMIT_NOTE,
  TASK_BODY_MARKER_LABEL,
  bodyLengthNote,
  planBodySave,
  taskBodyIsAtLimit,
  type BodyTarget,
} from '@/lib/taskCardBody';

/**
 * Reading and writing a card's BODY. The ONLY place in the dashboard that
 * renders one.
 *
 * That is a rule, not an accident of layout, and `tests/task-card-body-contract`
 * pins it: the board is scanned in six narrow columns, and dropping 2,000
 * characters of spec into a column card would bury the twenty titles around it.
 * shared-context made the same call for the MCP surfaces — a listing prints a
 * ` +body` marker and nothing else, because inlining bodies there blew the
 * response budget silently. A body is something you open.
 */

/**
 * The marker on a board card: present and readable when the card has a body,
 * quiet until hover/focus when it does not. Same word as the ` +body` marker
 * every text surface uses.
 */
export function TaskCardBodyMarker({
  hasBody,
  title,
  onOpen,
  disabled,
}: {
  hasBody: boolean;
  title: string;
  onOpen: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={disabled}
      aria-label={hasBody ? `Read the ${TASK_BODY_MARKER_LABEL} of ${title}` : `Add a ${TASK_BODY_MARKER_LABEL} to ${title}`}
      title={hasBody ? 'This card has detail — open it to read.' : 'Add detail to this card.'}
      className={
        hasBody
          ? 'rounded border border-border-strong px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-text-secondary transition-colors hover:bg-overlay-hover hover:text-text-primary'
          : 'rounded border border-transparent px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-text-muted opacity-0 transition-opacity hover:text-text-secondary focus-visible:opacity-100 group-hover:opacity-100'
      }
    >
      {hasBody ? TASK_BODY_MARKER_LABEL : `+ ${TASK_BODY_MARKER_LABEL}`}
    </button>
  );
}

/**
 * The opened card. Reading mode keeps the body's line breaks — it is a checklist
 * or a short spec, and the breaks are the readable part (shared-context splits on
 * them for the same reason before neutralizing each line).
 *
 * Writing mode never claims more than the server stored: the counter says where
 * the clip lands before you save, the save posts the CLIPPED text so what you see
 * next is what exists, and the three ways a save would silently do nothing are
 * refused with the reason on screen instead of sent.
 */
export function TaskCardBodyDialog({
  card,
  phase,
  target,
  busy,
  onClose,
  onSave,
}: {
  card: TodoItem;
  phase: BoardPhase;
  /** Which stored card a save would land on — or why nothing can be written. */
  target: BodyTarget;
  busy: boolean;
  onClose: () => void;
  /** Resolves true when the write landed; the dialog stays open if it did not. */
  onSave: (body: string, clipped: boolean) => Promise<boolean>;
}) {
  const stored = card.body ?? '';
  const [editing, setEditing] = useState(!stored && target.writable);
  const [draft, setDraft] = useState(stored);
  const [saving, setSaving] = useState(false);

  const plan = planBodySave(draft, stored);
  const counter = bodyLengthNote(draft);
  const headingId = 'task-card-body-heading';

  async function save() {
    if (plan.action !== 'save' || saving) return;
    setSaving(true);
    const ok = await onSave(plan.body, plan.clipped);
    setSaving(false);
    // The stored body is the clipped one. Showing the typed text back would
    // claim a save that did not happen, so the editor drops to reading mode over
    // exactly what the server now holds — including the at-limit note if it was
    // cut. A failed write keeps the draft and stays open.
    if (ok) {
      setDraft(plan.body);
      setEditing(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      labelledById={headingId}
      cardClassName="w-full max-w-[560px] rounded-2xl border border-border-subtle bg-surface p-5 shadow-[var(--shadow-lg)]"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">
            {BOARD_PHASE_LABELS[phase]}
          </p>
          <h2 id={headingId} className="mt-1 text-sm font-semibold leading-snug text-text-primary">
            {card.title}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="shrink-0 rounded px-1 text-[15px] leading-none text-text-muted hover:text-text-primary"
        >
          <span aria-hidden>×</span>
        </button>
      </div>

      <div className="mt-4">
        {editing ? (
          <>
            <label htmlFor="task-card-body-input" className="sr-only">
              Card detail
            </label>
            <textarea
              id="task-card-body-input"
              autoFocus
              rows={10}
              value={draft}
              disabled={busy || saving}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void save();
                }
              }}
              placeholder="What this card actually means — the spec, the paths, the checklist."
              className="w-full resize-y rounded-lg border border-border-subtle bg-overlay-subtle px-3 py-2.5 font-mono text-[12.5px] leading-6 text-text-secondary outline-none placeholder:text-text-muted focus:border-border-strong"
            />
            <p className={`mt-1.5 text-[11px] ${counter.over ? 'text-status-warning' : 'text-text-muted'}`}>
              {counter.text}
            </p>
          </>
        ) : stored ? (
          <>
            {taskBodyIsAtLimit(stored) ? (
              <p className="mb-2 text-[11px] text-status-warning">{BODY_AT_LIMIT_NOTE}</p>
            ) : null}
            {/* whitespace-pre-wrap: a body is prose or a spec, never one line. */}
            <p className="max-h-[52vh] overflow-y-auto whitespace-pre-wrap break-words font-mono text-[12.5px] leading-6 text-text-secondary">
              {stored}
            </p>
          </>
        ) : (
          <p className="text-[12.5px] leading-6 text-text-muted">
            No detail on this card yet.
          </p>
        )}
      </div>

      {plan.action === 'blocked' ? (
        <p className="mt-3 text-[11px] leading-5 text-status-warning">{plan.note}</p>
      ) : null}
      {!target.writable ? (
        <p className="mt-3 text-[11px] leading-5 text-text-muted">{target.note}</p>
      ) : null}

      <div className="mt-4 flex items-center justify-end gap-2">
        {editing ? (
          <>
            <button
              type="button"
              onClick={() => {
                setDraft(stored);
                if (stored) setEditing(false);
                else onClose();
              }}
              disabled={saving}
              className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-text-muted hover:text-text-primary disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={plan.action !== 'save' || busy || saving}
              className="rounded-lg border border-border-subtle bg-overlay-active px-3 py-1.5 text-[12px] font-medium text-text-primary hover:bg-overlay-strong disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={!target.writable || busy}
            className="rounded-lg border border-border-subtle bg-overlay-active px-3 py-1.5 text-[12px] font-medium text-text-primary hover:bg-overlay-strong disabled:opacity-40"
          >
            {stored ? 'Edit' : 'Add detail'}
          </button>
        )}
      </div>
    </Modal>
  );
}
