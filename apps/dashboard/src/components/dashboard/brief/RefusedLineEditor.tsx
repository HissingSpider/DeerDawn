import { useState } from 'react';
import type { BriefItem } from '@/lib/api';
import { showToast } from '@/components/ui/Toast';
import { EDIT_KEPT_NOTE, LINE_NOW_LABEL, refusedEditMessage, type RefusedEdit } from '@/lib/briefEdits';

/**
 * The editor of a save the API refused because the brief changed underneath it.
 *
 * It used to close, and what the person typed was gone. Now their text stays
 * here, editable, beside the line as it reads NOW, so they can copy it, adjust
 * it and save again (the save goes through the same fresh-read, versioned write
 * as any edit). When the line is no longer in the brief, the text is still kept
 * and they are told the line is gone; there is nothing left to save it onto.
 */
export function RefusedLineEditor({
  edit,
  now,
  onSave,
  onDiscard,
}: {
  edit: RefusedEdit;
  /** The line as it reads now, or null when it is no longer in the brief. */
  now: BriefItem | null;
  onSave: (text: string) => Promise<void> | void;
  onDiscard: () => void;
}) {
  const [draft, setDraft] = useState(edit.draft);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const message = refusedEditMessage(edit, Boolean(now));
  const textId = `refused-edit-${edit.id}`;

  const save = async () => {
    const next = draft.trim();
    if (!now || !next) return;
    if (next === now.text) {
      onDiscard();
      return;
    }
    setSaving(true);
    try {
      await onSave(next);
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast('Could not copy. Select the text and copy it manually.', 'error');
    }
  };

  return (
    <li className="rounded-lg border border-status-warning/40 bg-overlay-subtle px-3 py-2.5">
      <p role="status" className="text-[12.5px] leading-5 text-text-secondary [overflow-wrap:anywhere]">
        {message}
      </p>
      {now && (
        <div className="mt-2 rounded-md border border-border-subtle px-2.5 py-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted">{LINE_NOW_LABEL}</p>
          <p className="mt-0.5 text-[13px] leading-[1.5] text-text-primary [overflow-wrap:anywhere]">{now.text}</p>
        </div>
      )}
      <label htmlFor={textId} className="mt-2 block text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted">
        Your text
      </label>
      <textarea
        id={textId}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={2}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
        }}
        className="mt-1 w-full resize-none rounded-md border border-border-subtle bg-overlay-subtle px-2.5 py-1.5 text-[13px] max-sm:text-base leading-[1.5] text-text-primary outline-none focus:border-primary/40"
      />
      {now && <p className="mt-1 text-[11px] text-text-muted">{EDIT_KEPT_NOTE}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {now && (
          <button
            onClick={() => void save()}
            disabled={saving}
            className="rounded-md bg-primary px-3 py-1 text-xs font-semibold text-on-primary hover:bg-primary/90 disabled:opacity-50"
          >
            {edit.mode === 'correct' ? 'Save correction' : 'Save'}
          </button>
        )}
        <button
          onClick={() => void copy()}
          className="rounded-md border border-border-subtle px-3 py-1 text-xs font-medium text-text-secondary hover:text-text-primary"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          onClick={onDiscard}
          disabled={saving}
          className="rounded-md border border-border-subtle px-3 py-1 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-50"
        >
          Discard
        </button>
      </div>
    </li>
  );
}
