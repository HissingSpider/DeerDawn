import { useState } from 'react';
import type { BriefItem, BriefSlotKind } from '@/lib/api';
import { briefLineKeys, locateRefusedLine, type RefusedEdit } from '@/lib/briefEdits';
import { BriefLine, type BriefLineCallbacks } from './BriefLine';
import { RefusedLineEditor } from './RefusedLineEditor';

// The four slots, with their locked labels + one-line subs. The 4th slot's UI
// label is "Landmine" (the DB field stays `landmines`).
//
// Colour law (DashboardStatusPill in PageScaffold.tsx): tinted only when it
// encodes STATE the user may need to act on. A slot's identity is not that —
// each slot already has its own icon AND its own label, so a third encoding of
// "which slot is this" was decoration. Decided was raw `text-sky-400` and Open
// raw `text-violet-400`: no token, therefore no light-mode value, therefore
// wrong on the white surface.
//
// LANDMINE keeps its tint, and is the only one that does. It is the single slot
// whose contents are a hazard — a footgun that costs you if you miss it — which
// is exactly the state amber exists to mark. Shipped and Decided are records of
// things already settled; Open is a category of question, not an alarm. Holding
// amber to landmines alone is what lets it still register as a warning.
export const SLOT_META: Record<
  BriefSlotKind,
  { label: string; sub: string; accent: string; icon: React.ReactNode }
> = {
  shipped: {
    label: 'Shipped',
    sub: 'What landed — done and deployed.',
    accent: 'text-text-secondary',
    icon: <CheckIcon />,
  },
  decided: {
    label: 'Decided',
    sub: 'Choices made — what not to relitigate.',
    accent: 'text-text-secondary',
    icon: <FlagIcon />,
  },
  open: {
    label: 'Open',
    sub: 'Still unanswered — what needs a call.',
    accent: 'text-text-secondary',
    icon: <QuestionIcon />,
  },
  landmine: {
    label: 'Landmine',
    sub: 'Sharp watch-outs — footguns and fragile invariants.',
    accent: 'text-status-warning',
    icon: <AlertIcon />,
  },
};

interface BriefSlotProps extends BriefLineCallbacks {
  slot: BriefSlotKind;
  items: BriefItem[];
  // index of the item currently mid-mutation (so we can dim just that line).
  busyKey?: string | null;
  /**
   * This slot's section is WITHHELD by the share policy — written, and not
   * yours to read. An empty slot omits itself, which is right for a section
   * nobody has written and wrong here: a teammate saw a project with three
   * slots and assumed the fourth had never been filled in.
   */
  withheld?: boolean;
  /**
   * Edits of this slot's lines that the API refused because the brief changed
   * underneath them. Each is shown in place of its line as it now reads, or,
   * when that line is gone, at the top of the slot: the typed text stays.
   */
  refused?: RefusedEdit[];
  onRefusedSave?: (edit: RefusedEdit, now: BriefItem, text: string) => Promise<void> | void;
  onRefusedDiscard?: (edit: RefusedEdit) => void;
}

// A slot with nine items next to a slot with one made the 2×2 grid run at wildly
// uneven heights and buried the other three slots below the fold. Show the first
// few and let the rest expand in place.
const PREVIEW_COUNT = 3;

export function BriefSlot({
  slot,
  items,
  busyKey,
  withheld = false,
  refused = [],
  onRefusedSave,
  onRefusedDiscard,
  ...callbacks
}: BriefSlotProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const refusedHere = refused.filter((edit) => edit.slot === slot);

  // Empty slots are OMITTED entirely — never a fabricated/blank box. Unless the
  // reason they are empty is that they were withheld, which is a different fact
  // and has to be said out loud. Or unless it holds a refused edit's text,
  // which is kept even when its line (the slot's last) is gone.
  if (!items.length && !refusedHere.length) return withheld ? <WithheldSlot slot={slot} /> : null;

  const meta = SLOT_META[slot];
  const bodyId = `brief-slot-${slot}`;
  const visible = showAll ? items : items.slice(0, PREVIEW_COUNT);
  // Keyed by the line, not its position: the brief refetches on focus, and a
  // line added ahead of an open editor must not move the editor onto another
  // line. `visible` is a prefix of `items`, so the indexes line up.
  const lineKeys = briefLineKeys(slot, items);
  const hidden = items.length - visible.length;

  // Where each refused edit's line is now. One shown in place of a visible line;
  // the rest (its line gone, or folded under "N more") at the top of the slot.
  const refusedAt = new Map<number, RefusedEdit>();
  const refusedTop: Array<{ edit: RefusedEdit; now: BriefItem | null }> = [];
  for (const edit of refusedHere) {
    const at = locateRefusedLine(edit.slot, items, edit.seen);
    if (at >= 0 && at < visible.length && !refusedAt.has(at)) refusedAt.set(at, edit);
    else refusedTop.push({ edit, now: at >= 0 ? items[at] : null });
  }
  const refusedEditor = (edit: RefusedEdit, now: BriefItem | null, key: string) => (
    <RefusedLineEditor
      key={key}
      edit={edit}
      now={now}
      onSave={(text) => (now ? onRefusedSave?.(edit, now, text) : undefined)}
      onDiscard={() => onRefusedDiscard?.(edit)}
    />
  );

  // Landmines keep their high-salience amber tint even as a grid card — through
  // the escalate tokens, which carry a light-mode value. The raw amber-500 this
  // used to hard-code had none, so on the white surface the card lost the tint
  // that is the whole point of the slot.
  const surface =
    slot === 'landmine'
      ? 'border-status-warning/30 bg-[var(--status-escalate-bg)]'
      : 'border-border-subtle bg-overlay-subtle';

  return (
    <section className={`rounded-xl border ${surface} p-4 max-sm:p-3.5`}>
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        className={`flex w-full items-center gap-2.5 text-left ${collapsed ? '' : 'mb-3'}`}
      >
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-overlay-subtle ${meta.accent}`}>
          {meta.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-[13px] font-semibold uppercase tracking-[0.1em] text-text-primary">
              {meta.label}
            </h3>
            <span className="rounded-full bg-overlay-active px-1.5 py-0.5 text-[10px] font-semibold text-text-muted">
              {items.length}
            </span>
          </div>
          <p className="mt-0.5 truncate text-[11px] leading-tight text-text-muted">{meta.sub}</p>
        </div>
        <ChevronIcon
          className={`shrink-0 text-text-muted transition-transform ${collapsed ? '-rotate-90' : ''}`}
        />
      </button>

      {!collapsed && (
        <>
          <ul id={bodyId} className="space-y-2">
            {refusedTop.map(({ edit, now }) => refusedEditor(edit, now, edit.id))}
            {visible.map((item, i) => {
              const kept = refusedAt.get(i);
              if (kept) return refusedEditor(kept, item, lineKeys[i]);
              return (
                <BriefLine
                  key={lineKeys[i]}
                  item={item}
                  slot={slot}
                  busy={busyKey === lineKeys[i]}
                  {...callbacks}
                />
              );
            })}
          </ul>
          {(hidden > 0 || showAll) && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="mt-2 w-full rounded-lg border border-dashed border-border-subtle py-1.5 text-[11.5px] font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text-secondary"
            >
              {showAll ? 'Show less' : `${hidden} more`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
function FlagIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" y1="22" x2="4" y2="15" />
    </svg>
  );
}
function QuestionIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
function AlertIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

// Same card frame as a real slot, deliberately: the reader should see the slot
// exists and is accounted for, not a hole where one used to be.
function WithheldSlot({ slot }: { slot: BriefSlotKind }) {
  const meta = SLOT_META[slot];
  return (
    <section className="rounded-xl border border-border-subtle bg-overlay-subtle p-4 max-sm:p-3.5">
      <div className="flex items-center gap-2.5">
        <span className="text-text-muted">{meta.icon}</span>
        <span className="text-sm font-semibold text-text-muted">{meta.label}</span>
      </div>
      <p className="mt-2 text-[12.5px] leading-5 text-text-muted">
        Not shared with you — withheld by this project&rsquo;s share policy, not empty. Ask its
        author to widen the share.
      </p>
    </section>
  );
}
