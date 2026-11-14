import { useEffect, useMemo, useState } from 'react';
import {
  api,
  buildTaskBoard,
  BOARD_PHASES,
  BOARD_PHASE_LABELS,
  type BoardPhase,
  isSectionWithheld,
  type ProjectContextJson,
  type TodoItem,
} from '@/lib/api';
import { showToast } from '@/components/ui/Toast';
import { logger } from '@/lib/logger';
import { writeRefusalMessage } from '@/lib/writeRefusal';
import { TaskCardBodyDialog, TaskCardBodyMarker } from './TaskCardBody';
import { bodySavedNotice, resolveBodyTarget } from '@/lib/taskCardBody';

// Colour law — stated on DashboardStatusPill in PageScaffold.tsx: a surface is
// tinted only when it encodes STATE the user may need to act on.
//
// A lane's IDENTITY is not that state. The label sits two pixels from the dot and
// already reads "BACKLOG"; the column position says the same thing again. Six
// lanes in six hues therefore encoded nothing — it was decoration, and it cost
// twice. Three of the six (slate, sky, violet) were raw palette values with no
// light-mode counterpart, so they came out wrong on the white surface. And the
// decoration was spending the system's real signals: IN PROGRESS wore the amber a
// landmine uses, on the healthiest state a card can be in. Once five of six lanes
// are coloured, colour on this board has stopped meaning anything, so the one
// lane that needs to shout cannot.
//
// Exactly one lane is tinted: BLOCKED, the only lane that is a request to the
// user. DONE is terminal rather than actionable, and its cards already read as
// finished from the line-through, the dimming and the completion date — a fourth
// restatement in green is not information. Every other lane is neutral.
//
// Tailwind can't build class names from runtime values, so each phase carries its
// full class set. Tokens only: these flip with the theme, raw palette does not.
const NEUTRAL_LANE = { dot: 'bg-text-muted', header: 'text-text-secondary' };
const PHASE_TONE: Record<BoardPhase, { dot: string; header: string }> = {
  backlog:     NEUTRAL_LANE,
  blocked:     { dot: 'bg-status-danger', header: 'text-status-danger' },
  in_progress: NEUTRAL_LANE,
  integration: NEUTRAL_LANE,
  testing:     NEUTRAL_LANE,
  done:        NEUTRAL_LANE,
};

// The drop target IS state the user is acting on, right now — so it keeps a
// colour. One brand ring for every lane, because it marks "this column will take
// the card", which is the same fact whichever column it is.
const DROP_RING = 'ring-primary/60';

interface TaskBoardProps {
  projectId: string;
  context: ProjectContextJson | null;
  // Bump the parent's refresh so it re-fetches authoritative context after a write.
  onMutated: () => void;
}

// PATCH /projects/:id/context takes these straight through to the merge.
// add_todos carries a body as well as a title: an entry whose title already
// names a card sets that card's body and leaves its id, title and column alone,
// which is the only write path a body has. It is additive — see
// src/lib/taskCardBody.ts for what that rules out.
type Directive =
  | { add_todos: Array<{ title: string; phase?: BoardPhase; body?: string }> }
  | { move_todos: Array<{ match: string; phase: BoardPhase }> }
  | { remove_todos: string[] };

export function TaskBoard({ projectId, context, onMutated }: TaskBoardProps) {
  // Optimistic override: local board applied instantly, replaced by the parent's
  // authoritative re-fetch (cleared whenever a fresh context prop arrives).
  const [override, setOverride] = useState<ProjectContextJson | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropPhase, setDropPhase] = useState<BoardPhase | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Partial<Record<BoardPhase, boolean>>>({});
  // The opened card, by id. A body is never rendered on the board itself — the
  // column marks which cards have one and this is how you read it.
  const [openCardId, setOpenCardId] = useState<string | null>(null);

  useEffect(() => {
    setOverride(null);
  }, [context]);

  const effective = override ?? context;
  const columns = useMemo(() => buildTaskBoard(effective), [effective]);
  const total = columns.reduce((n, c) => n + c.cards.length, 0);
  const counts = Object.fromEntries(columns.map((column) => [column.phase, column.cards.length])) as Record<BoardPhase, number>;
  const open = total - counts.done;

  // Apply a directive optimistically, then persist. On failure, roll back and
  // toast. Returns whether the write landed, so a caller holding an editor open
  // can keep the user's text instead of closing over a failure.
  async function mutate(directive: Directive, nextItems: TodoItem[], done?: string) {
    if (!projectId || busy) return false;
    setBusy(true);
    const base = effective ?? context;
    if (base) setOverride({ ...base, todo_items: nextItems });
    try {
      await api.updateProjectContext(projectId, directive as never);
      onMutated();
      if (done) showToast(done, 'success');
      return true;
    } catch (err) {
      logger.error('task_board_mutation_failed', err);
      // A refusal is not a failure: writeRefusalMessage returns null for a real
      // save error, so retrying keeps its own wording.
      showToast(writeRefusalMessage(err) || 'Couldn’t save that change — rolled back.', 'error');
      setOverride(null);
      return false;
    } finally {
      setBusy(false);
    }
  }

  // Flatten the current board back into a real todo_items array (excluding derived
  // step cards) so we can compute the optimistic next state locally.
  function currentItems(): TodoItem[] {
    return columns.flatMap((c) => c.cards.filter((card) => card.kind !== 'step').map((card) => ({ ...card, phase: c.phase })));
  }

  function moveCard(card: TodoItem, phase: BoardPhase) {
    if (card.phase === phase) return;
    const now = new Date().toISOString();
    const next = currentItems().map((t) =>
      t.id === card.id
        ? { ...t, phase, updated_at: now, completed_at: phase === 'done' ? t.completed_at ?? now : null }
        : t,
    );
    mutate({ move_todos: [{ match: card.id, phase }] }, next);
  }

  function removeCard(card: TodoItem) {
    const next = currentItems().filter((t) => t.id !== card.id);
    mutate({ remove_todos: [card.id] }, next);
  }

  function addCard(phase: BoardPhase, title: string) {
    const trimmed = title.trim();
    if (!trimmed) return;
    const now = new Date().toISOString();
    const optimistic: TodoItem = {
      id: `todo-optimistic-${now}-${currentItems().length}`,
      title: trimmed,
      phase,
      created_at: now,
      updated_at: now,
      completed_at: phase === 'done' ? now : null,
    };
    mutate({ add_todos: [{ title: trimmed, phase }] }, [...currentItems(), optimistic]);
  }

  // Writing a body IS an add: an entry whose title already names a card sets that
  // card's body, keeping its id, title and column. `body` here is the CLIPPED
  // text the server will store, so the optimistic board shows what exists rather
  // than what was typed.
  async function saveBody(card: TodoItem, body: string, clipped: boolean) {
    const now = new Date().toISOString();
    const next = currentItems().map((t) => (t.id === card.id ? { ...t, body, updated_at: now } : t));
    return mutate({ add_todos: [{ title: card.title, body }] }, next, bodySavedNotice(clipped));
  }

  const openCard = openCardId
    ? columns.flatMap((c) => c.cards.map((card) => ({ card, phase: c.phase }))).find((e) => e.card.id === openCardId)
    : undefined;

  if (!total) {
    // An empty board on somebody else's shared project may be a board this
    // reader is not allowed to see. "No tasks yet" would be a lie with an
    // obvious and destructive follow-up: re-file every card by hand.
    if (isSectionWithheld(context, 'todo_items')) return <WithheldBoard />;
    return (
      <EmptyBoard onAdd={(title) => addCard('backlog', title)} busy={busy} />
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">Task board</h2>
          <p className="mt-0.5 text-[11px] font-medium text-text-muted">
            Drag a card between lanes, or use the ‹ › controls. Every session reads the board.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5" aria-label="Task board summary">
          {/* Same law as the lanes: a count is not a state to act on, so only
              Blocked carries a tint. Active was amber and Testing violet, which
              made three of four numbers coloured and none of them meaningful. */}
          <SummaryChip label="Open" value={open} />
          <SummaryChip label="Blocked" value={counts.blocked} tone="text-status-danger" />
          <SummaryChip label="Active" value={counts.in_progress} />
          <SummaryChip label="Testing" value={counts.testing} />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {columns.map((col) => {
          const tone = PHASE_TONE[col.phase];
          const isDrop = dropPhase === col.phase;
          const visibleCards = expanded[col.phase] ? col.cards : col.cards.slice(0, 2);
          const hiddenCount = col.cards.length - visibleCards.length;
          return (
            <div
              key={col.phase}
              onDragOver={(e) => {
                if (dragId) {
                  e.preventDefault();
                  setDropPhase(col.phase);
                }
              }}
              onDragLeave={() => setDropPhase((p) => (p === col.phase ? null : p))}
              onDrop={(e) => {
                e.preventDefault();
                const card = currentItems().find((t) => t.id === dragId);
                setDropPhase(null);
                setDragId(null);
                if (card) moveCard(card, col.phase);
              }}
              className={`flex min-w-0 flex-col rounded-xl border bg-overlay-subtle transition-colors ${
                isDrop ? `border-transparent ring-2 ${DROP_RING}` : 'border-border-subtle'
              }`}
            >
              <div className="flex items-center gap-2 px-3 py-2.5">
                <span className={`h-2 w-2 rounded-full ${tone.dot}`} aria-hidden />
                <span className={`text-[11px] font-semibold uppercase tracking-[0.1em] ${tone.header}`}>
                  {col.label}
                </span>
                <span className="ml-auto text-[11px] font-medium text-text-muted">{col.cards.length}</span>
              </div>

              <div className="flex flex-1 flex-col gap-2 px-2 pb-2">
                {col.cards.length === 0 ? (
                  <p className="px-1 py-3 text-center text-[11px] text-text-muted/60">—</p>
                ) : (
                  visibleCards.map((card) => (
                    <BoardCard
                      key={card.id}
                      card={card}
                      phase={col.phase}
                      busy={busy}
                      onDragStart={() => setDragId(card.id)}
                      onDragEnd={() => {
                        setDragId(null);
                        setDropPhase(null);
                      }}
                      onMove={(p) => moveCard(card, p)}
                      onRemove={() => removeCard(card)}
                      onOpenBody={() => setOpenCardId(card.id)}
                    />
                  ))
                )}
                {hiddenCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => setExpanded((value) => ({ ...value, [col.phase]: true }))}
                    className="rounded-lg px-2.5 py-1 text-left text-[11px] font-medium text-text-muted hover:bg-overlay-hover hover:text-text-secondary"
                  >
                    +{hiddenCount} more
                  </button>
                ) : expanded[col.phase] && col.cards.length > 2 ? (
                  <button
                    type="button"
                    onClick={() => setExpanded((value) => ({ ...value, [col.phase]: false }))}
                    className="rounded-lg px-2.5 py-1 text-left text-[11px] font-medium text-text-muted hover:bg-overlay-hover hover:text-text-secondary"
                  >
                    Show less
                  </button>
                ) : null}
                <AddCardInput phase={col.phase} onAdd={(title) => addCard(col.phase, title)} busy={busy} />
              </div>
            </div>
          );
        })}
      </div>
      {openCard ? (
        <TaskCardBodyDialog
          // Keyed so opening a different card resets the editor's draft.
          key={openCard.card.id}
          card={openCard.card}
          phase={openCard.phase}
          // Resolved against the STORED cards, not the rendered column: derived
          // step cards and legacy completed_todos entries render on the board but
          // no add_todos write can reach them.
          target={resolveBodyTarget(effective?.todo_items, openCard.card)}
          busy={busy}
          onClose={() => setOpenCardId(null)}
          onSave={(body, clipped) => saveBody(openCard.card, body, clipped)}
        />
      ) : null}
    </div>
  );
}

function SummaryChip({ label, value, tone = 'text-text-secondary' }: { label: string; value: number; tone?: string }) {
  return (
    <span className="rounded-full border border-border-subtle bg-overlay-subtle px-2.5 py-1 text-[10px] font-medium text-text-muted">
      <span className={tone}>{value}</span> {label}
    </span>
  );
}

function BoardCard({
  card,
  phase,
  busy,
  onDragStart,
  onDragEnd,
  onMove,
  onRemove,
  onOpenBody,
}: {
  card: TodoItem;
  phase: BoardPhase;
  busy: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (phase: BoardPhase) => void;
  onRemove: () => void;
  onOpenBody: () => void;
}) {
  const idx = BOARD_PHASES.indexOf(phase);
  const prev = idx > 0 ? BOARD_PHASES[idx - 1] : null;
  const next = idx < BOARD_PHASES.length - 1 ? BOARD_PHASES[idx + 1] : null;
  const done = phase === 'done';
  const isStep = card.kind === 'step';

  // Derived current-task steps are a read-only projection of task_steps (owned by
  // extraction) — shown on the board for a single task surface, but not editable.
  if (isStep) {
    return (
      <div
        title="A step of the current task — managed by your AI, shown here read-only."
        className="rounded-lg border border-dashed border-border-subtle bg-overlay-subtle px-2.5 py-2"
      >
        <div className="flex items-start gap-1.5">
          <p className={`flex-1 text-[12.5px] leading-snug text-text-muted ${done ? 'line-through' : ''}`}>
            {card.title}
          </p>
          <span className="mt-0.5 shrink-0 rounded bg-overlay-active px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-text-muted/80">
            step
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      draggable={!busy}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`group cursor-grab rounded-lg border border-border-subtle bg-overlay-subtle px-2.5 py-2 active:cursor-grabbing ${
        done ? 'opacity-70' : ''
      }`}
    >
      <div className="flex items-start gap-1.5">
        <p className={`flex-1 text-[12.5px] leading-snug text-text-secondary ${done ? 'line-through' : ''}`}>
          {card.title}
        </p>
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          aria-label={`Remove ${card.title}`}
          className="opacity-0 transition-opacity hover:text-status-danger group-hover:opacity-100 disabled:opacity-0 text-text-muted"
        >
          <span aria-hidden className="text-[13px] leading-none">×</span>
        </button>
      </div>
      <div className="mt-1.5 flex items-center gap-1">
        <button
          type="button"
          onClick={() => prev && onMove(prev)}
          disabled={!prev || busy}
          aria-label={prev ? `Move to ${BOARD_PHASE_LABELS[prev]}` : 'At first lane'}
          className="rounded px-1 text-[13px] leading-none text-text-muted hover:text-text-primary disabled:opacity-25"
        >
          ‹
        </button>
        {/* The card's detail is MARKED here and read in the dialog — never
            printed on the board. Six narrow columns are scanned, and 2,000
            characters of spec on one card buries the twenty titles around it. */}
        <TaskCardBodyMarker
          hasBody={Boolean(card.body)}
          title={card.title}
          onOpen={onOpenBody}
          disabled={busy}
        />
        {done && card.completed_at ? (
          <span className="text-[10px] text-text-muted/70">{card.completed_at.slice(0, 10)}</span>
        ) : null}
        <button
          type="button"
          onClick={() => next && onMove(next)}
          disabled={!next || busy}
          aria-label={next ? `Move to ${BOARD_PHASE_LABELS[next]}` : 'At last lane'}
          className="ml-auto rounded px-1 text-[13px] leading-none text-text-muted hover:text-text-primary disabled:opacity-25"
        >
          ›
        </button>
      </div>
    </div>
  );
}

function AddCardInput({ phase, onAdd, busy }: { phase: BoardPhase; onAdd: (title: string) => void; busy: boolean }) {
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-dashed border-border-subtle px-2.5 py-1.5 text-left text-[11px] text-text-muted hover:border-border-strong hover:text-text-secondary"
      >
        + Add card
      </button>
    );
  }

  const submit = () => {
    onAdd(value);
    setValue('');
    setOpen(false);
  };

  return (
    <textarea
      autoFocus
      rows={2}
      value={value}
      disabled={busy}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => (value.trim() ? submit() : setOpen(false))}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          submit();
        } else if (e.key === 'Escape') {
          setValue('');
          setOpen(false);
        }
      }}
      placeholder={`New card in ${BOARD_PHASE_LABELS[phase]}…`}
      className="resize-none rounded-lg border border-border-subtle bg-overlay-subtle px-2.5 py-2 text-[12.5px] text-text-secondary outline-none placeholder:text-text-muted/60 focus:border-border-strong"
    />
  );
}

// The board exists; this reader may not read it. No add box — offering one
// would invite a parallel board alongside the one already there.
function WithheldBoard() {
  return (
    <div className="rounded-xl border border-dashed border-border-subtle bg-overlay-subtle p-8 text-center">
      <p className="text-sm font-medium text-text-secondary">This board is not shared with you</p>
      <p className="mx-auto mt-1 max-w-sm text-[12.5px] text-text-muted">
        The project has a task board — this project&apos;s share policy withholds it, so it is not
        empty. Ask its author to share the board section.
      </p>
    </div>
  );
}

function EmptyBoard({ onAdd, busy }: { onAdd: (title: string) => void; busy: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-border-subtle bg-overlay-subtle p-8 text-center">
      <p className="text-sm font-medium text-text-secondary">No tasks on the board yet</p>
      <p className="mx-auto mt-1 max-w-sm text-[12.5px] text-text-muted">
        Add a card here, or let your AI file one with{' '}
        <code className="rounded bg-overlay-active px-1 py-0.5 text-[11px]">manage_tasks</code>. Cards flow{' '}
        {BOARD_PHASES.map((p) => BOARD_PHASE_LABELS[p as BoardPhase]).join(' → ')}.
      </p>
      <div className="mx-auto mt-4 max-w-xs">
        <AddCardInput phase="backlog" onAdd={onAdd} busy={busy} />
      </div>
    </div>
  );
}
