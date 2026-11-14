import { useState } from 'react';
import type { BriefItem, BriefSlotKind } from '@/lib/api';
import { ProvenanceBadge } from './ProvenanceBadge';
import { ClampedText } from '@/components/ui/ClampedText';

// Actions a line can request of the workspace. The parent owns the optimistic
// override + the read-modify-write PATCH; this component only fires callbacks.
//
// Every callback is told the line's slot: an editor commits against the line
// as it was when it OPENED (see `opened` below), which after a refresh is no
// longer an object in the parent's current spine, so the parent cannot find
// its slot by looking it up there.
export interface BriefLineCallbacks {
  // An edit resolves when the save is settled. The editor stays open until then:
  // a save refused because the brief changed underneath it keeps the typed text
  // (the parent shows it beside the line as it now reads), so it is never
  // dropped between the press and the answer.
  onEdit?: (item: BriefItem, nextText: string, slot?: BriefSlotKind) => void | Promise<void>;
  onDismiss?: (item: BriefItem, slot?: BriefSlotKind) => void;
  onPin?: (item: BriefItem, slot?: BriefSlotKind) => void;
  // "This is wrong" — a correction is just an edit the user flags as a fix; the
  // parent decides how to persist it (here: same array PATCH as edit).
  onCorrect?: (item: BriefItem, nextText: string, slot?: BriefSlotKind) => void | Promise<void>;
  // "Answer" — resolve an OPEN question. The parent removes it from the OPEN
  // slot and records the answer as a Decided entry (POST /questions/resolve),
  // so the resolution is what the AI reads next session. Open slot only.
  onAnswer?: (item: BriefItem, answer: string) => void;
}

interface BriefLineProps extends BriefLineCallbacks {
  item: BriefItem;
  slot: BriefSlotKind;
  busy?: boolean;
}

export function BriefLine({ item, slot, busy, onEdit, onDismiss, onPin, onCorrect, onAnswer }: BriefLineProps) {
  const [editing, setEditing] = useState<null | 'edit' | 'correct' | 'answer'>(null);
  const [draft, setDraft] = useState(item.text);
  // The line as it read when the editor opened. The brief refetches when the
  // tab regains focus, so by the time the person saves, `item` may have been
  // replaced by what the server holds now. The edit is about the words they
  // were shown: it is committed against those, and if they are not there any
  // more the parent writes nothing and says so.
  const [opened, setOpened] = useState<BriefItem | null>(null);
  const [saving, setSaving] = useState(false);
  const openEditor = (mode: 'edit' | 'correct' | 'answer', text: string) => {
    setOpened(item);
    setDraft(text);
    setEditing(mode);
  };

  const isLandmine = slot === 'landmine';
  // Answering only makes sense for an OPEN question.
  const canAnswer = slot === 'open' && Boolean(onAnswer);
  const canMutate = Boolean(onEdit || onDismiss || onPin || onCorrect || canAnswer);
  // Each slot stamps its own timestamp field: decisions decided_at, shipped
  // shipped_at, landmines added_at. This used to read decided_at alone, so
  // SHIPPED and LANDMINE lines silently rendered with no date at all.
  const itemDate = item.decided_at || item.shipped_at || item.added_at;

  const commit = async () => {
    if (saving) return;
    const next = draft.trim();
    const target = opened ?? item;
    // Answer mode: any non-empty answer is valid — it needn't differ from the
    // question text, and the box starts empty rather than pre-filled.
    if (editing === 'answer') {
      if (next) onAnswer?.(target, next);
      setEditing(null);
      setOpened(null);
      setDraft(item.text);
      return;
    }
    if (!next || next === target.text) {
      setEditing(null);
      setOpened(null);
      setDraft(item.text);
      return;
    }
    setSaving(true);
    try {
      if (editing === 'correct') await onCorrect?.(target, next, slot);
      else await onEdit?.(target, next, slot);
    } finally {
      setSaving(false);
    }
    setEditing(null);
    setOpened(null);
  };

  const cancel = () => {
    setEditing(null);
    setOpened(null);
    setDraft(item.text);
  };

  if (editing) {
    const isAnswer = editing === 'answer';
    return (
      <li className="rounded-lg border border-primary/30 bg-overlay-subtle px-3 py-2.5">
        {/* Answer mode keeps the question visible above the answer box. */}
        {isAnswer && (
          <p className="mb-2 flex items-start gap-1.5 text-[13px] leading-[1.5] text-text-secondary [overflow-wrap:anywhere]">
            {/* Neutral: this marked the OPEN slot's violet, and that palette is
                gone (see SLOT_META). The badge's job is to separate the question
                from the answer box, which shape and position already do. */}
            <span className="mt-px shrink-0 rounded bg-overlay-active px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted">
              Q
            </span>
            <span className="min-w-0">{(opened ?? item).text}</span>
          </p>
        )}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          autoFocus
          placeholder={isAnswer ? 'Your answer — this resolves the question and moves it to Decided.' : undefined}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void commit();
            if (e.key === 'Escape') cancel();
          }}
          className="w-full resize-none rounded-md border border-border-subtle bg-overlay-subtle px-2.5 py-1.5 text-[13px] max-sm:text-base leading-[1.5] text-text-primary outline-none focus:border-primary/40 placeholder:text-text-muted"
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={() => void commit()}
            disabled={busy || saving}
            className="rounded-md bg-primary px-3 py-1 text-xs font-semibold text-on-primary hover:bg-primary/90 disabled:opacity-50"
          >
            {isAnswer ? 'Save answer' : editing === 'correct' ? 'Save correction' : 'Save'}
          </button>
          <button
            onClick={cancel}
            className="rounded-md border border-border-subtle px-3 py-1 text-xs font-medium text-text-secondary hover:text-text-primary"
          >
            Cancel
          </button>
          <span className="text-[10px] text-text-muted">⌘↵ to save · Esc to cancel</span>
        </div>
      </li>
    );
  }

  return (
    <li
      className={`group relative rounded-lg border px-3 py-2.5 transition-colors ${
        isLandmine
          ? 'border-status-warning/30 bg-[var(--status-escalate-bg)] hover:border-status-warning/50'
          : 'border-border-subtle bg-overlay-subtle hover:border-border-strong'
      } ${busy ? 'opacity-60' : ''}`}
    >
      <div className="flex items-start gap-2.5">
        {isLandmine && (
          <span className="mt-0.5 shrink-0 text-status-warning" aria-hidden="true" title="Landmine">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </span>
        )}
        <div className="min-w-0 flex-1">
          {/* CLAMPED, and this is load-bearing rather than cosmetic. These
              entries are model-written session summaries: most are a sentence,
              a few are six hundred words of changelog. Unbounded, one of those
              made its column of the 2-up grid four thousand pixels tall next to
              a four-hundred-pixel sibling — the slots stopped lining up, the
              "N more" footers ended up screens apart, and the brief could not
              be skimmed, which is the only thing it is for. Three lines is
              enough to recognise an entry; the rest is one click away. */}
          <ClampedText
            text={item.text}
            lines={3}
            className="break-words text-[13px] leading-[1.55] text-text-primary [overflow-wrap:anywhere]"
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {item.trust && <ProvenanceBadge trust={item.trust} fromCard={item.from_card === true} />}
            {item.source_tool && (
              <span className="text-[10px] uppercase tracking-[0.08em] text-text-muted">
                {item.source_tool}
              </span>
            )}
            {/* Each slot stamps its own field: decisions decided_at, shipped
                shipped_at, landmines added_at. Reading only decided_at meant
                SHIPPED and LANDMINE lines silently lost their dates. */}
            {itemDate && (
              <span className="text-[10px] text-text-muted">{formatDate(itemDate)}</span>
            )}
          </div>
        </div>
      </div>

      {canMutate && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 max-sm:opacity-100">
          {/* Answer is the primary action on an open question — accented, and
              listed first — but reveals on hover/focus like the rest. */}
          {canAnswer && (
            <button
              onClick={() => openEditor('answer', '')}
              disabled={busy}
              className="rounded-md border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
            >
              Answer
            </button>
          )}
          {onEdit && <LineAction label="Edit" onClick={() => openEditor('edit', item.text)} disabled={busy} />}
          {onPin && <LineAction label="Pin" onClick={() => onPin(item, slot)} disabled={busy} />}
          {onCorrect && <LineAction label="This is wrong" onClick={() => openEditor('correct', item.text)} disabled={busy} />}
          {onDismiss && <LineAction label="Dismiss" danger onClick={() => onDismiss(item, slot)} disabled={busy} />}
        </div>
      )}
    </li>
  );
}

function LineAction({ label, onClick, danger, disabled }: { label: string; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-50 ${
        danger
          ? 'border-status-danger/25 text-status-danger hover:border-status-danger/50 hover:text-status-danger'
          : 'border-border-subtle text-text-secondary hover:border-border-strong hover:text-text-primary'
      }`}
    >
      {label}
    </button>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
