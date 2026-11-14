import { useCallback, useEffect, useMemo, useState } from 'react';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { showToast } from '@/components/ui/Toast';
import { AttachmentImage } from './AttachmentImage';
import { VERDICTS, errorText, label, wardrobe, type Verdict, type WardrobeOutfit } from './types';

const VERDICT_TONE: Record<Verdict, string> = {
  loved: 'border-primary/40 text-primary',
  fine: 'border-border-subtle text-text-secondary',
  rejected: 'border-status-danger/40 text-status-danger',
};

function OutfitCard({ outfit, onChange, onRemove }: { outfit: WardrobeOutfit; onChange: (o: WardrobeOutfit) => void; onRemove: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(outfit.name);
  const [notes, setNotes] = useState(outfit.notes || '');
  const [pendingVerdict, setPendingVerdict] = useState<Verdict | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(action: string, args: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const data = await wardrobe<{ outfit: WardrobeOutfit }>(action, { outfit_id: outfit.id, ...args });
      onChange({ ...outfit, ...data.outfit, items: outfit.items });
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function chooseVerdict(v: Verdict) {
    if (v === outfit.verdict) return;
    if (v === 'rejected' && !outfit.reason) {
      setPendingVerdict(v);
      return;
    }
    await call('rate_outfit', { verdict: v });
  }

  return (
    <article className="flex flex-col gap-3 rounded-xl border border-border-subtle bg-overlay-subtle p-4">
      <div className="flex gap-1.5 overflow-x-auto">
        {(outfit.items || []).map((it) => (
          <div key={it.id} className="w-16 shrink-0">
            <AttachmentImage attachmentId={it.removed ? null : it.cover_photo_id} alt={it.name || 'Removed item'} className="h-16 w-16 rounded-md border border-border-subtle" />
            <p className="mt-1 truncate text-[10px] text-text-muted">{it.removed ? 'Removed' : it.name}</p>
          </div>
        ))}
      </div>

      {editing ? (
        <div className="grid gap-2">
          <input className="dashboard-input" aria-label="Outfit name" value={name} onChange={(e) => setName(e.target.value)} />
          <textarea className="dashboard-textarea min-h-[64px]" aria-label="Notes" placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <div className="flex gap-2">
            <Button size="sm" isLoading={busy} onClick={async () => { if (await call('update_outfit', { name, notes: notes.trim() || null })) setEditing(false); }}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setName(outfit.name); setNotes(outfit.notes || ''); }}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="min-w-0">
          <div className="flex items-start justify-between gap-2">
            <h3 className="truncate text-sm font-semibold text-text-primary">{outfit.name}</h3>
            <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${VERDICT_TONE[outfit.verdict]}`}>{label(outfit.verdict)}</span>
          </div>
          <p className="mt-0.5 text-[11px] text-text-muted">
            {[(outfit.styles || []).join(', ') || 'No style', (outfit.worn_dates || []).length ? `worn ${outfit.worn_dates!.length} ${outfit.worn_dates!.length === 1 ? 'time' : 'times'}` : null].filter(Boolean).join(' · ')}
          </p>
          {outfit.reason ? <p className="mt-2 text-xs text-text-secondary">Why: {outfit.reason}</p> : null}
          {outfit.notes ? <p className="mt-1 whitespace-pre-line text-xs text-text-secondary">{outfit.notes}</p> : null}
        </div>
      )}

      {pendingVerdict ? (
        <div className="grid gap-2">
          <input className="dashboard-input" autoFocus placeholder="Why not? Your AI will avoid it next time." value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex gap-2">
            <Button size="sm" isLoading={busy} disabled={!reason.trim()} onClick={async () => { if (await call('rate_outfit', { verdict: pendingVerdict, reason: reason.trim() })) { setPendingVerdict(null); setReason(''); } }}>Reject</Button>
            <Button size="sm" variant="ghost" onClick={() => setPendingVerdict(null)}>Cancel</Button>
          </div>
        </div>
      ) : null}

      {error ? <p className="whitespace-pre-line text-xs text-status-danger">{error}</p> : null}

      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-border-subtle pt-3">
        <div role="group" aria-label="Verdict" className="inline-flex gap-1 rounded-lg border border-border-subtle p-0.5">
          {VERDICTS.map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={outfit.verdict === v}
              disabled={busy}
              onClick={() => void chooseVerdict(v)}
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium ${outfit.verdict === v ? 'bg-primary text-on-primary' : 'text-text-secondary hover:text-text-primary'}`}
            >
              {label(v)}
            </button>
          ))}
        </div>
        {!editing ? (
          <button type="button" className="text-[11px] font-medium text-text-secondary hover:text-text-primary" onClick={() => setEditing(true)}>Rename or add note</button>
        ) : null}
        <button type="button" className="ml-auto text-[11px] font-medium text-status-danger" onClick={onRemove}>Delete</button>
      </div>
    </article>
  );
}

export function OutfitsTab() {
  const confirm = useConfirm();
  const [outfits, setOutfits] = useState<WardrobeOutfit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [style, setStyle] = useState('');
  const [verdict, setVerdict] = useState('');

  const reload = useCallback(() => {
    wardrobe<{ outfits: WardrobeOutfit[] }>('list_outfits', { limit: 300 }).then(
      (d) => { setOutfits(d.outfits); setError(null); },
      (err) => setError(errorText(err)),
    );
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const styles = useMemo(() => [...new Set((outfits || []).flatMap((o) => o.styles || []))].sort(), [outfits]);
  const shown = useMemo(
    () => (outfits || []).filter((o) => (!style || (o.styles || []).includes(style)) && (!verdict || o.verdict === verdict)),
    [outfits, style, verdict],
  );

  async function remove(o: WardrobeOutfit) {
    const ok = await confirm({ title: `Delete "${o.name}"?`, body: 'The outfit goes; its items stay in your closet.', confirmLabel: 'Delete outfit', destructive: true });
    if (!ok) return;
    try {
      await wardrobe('remove_outfit', { outfit_id: o.id });
      setOutfits((prev) => (prev || []).filter((x) => x.id !== o.id));
    } catch (err) {
      showToast(errorText(err), 'error');
    }
  }

  if (error && !outfits) {
    return (
      <div className="rounded-xl border border-border-subtle bg-overlay-subtle p-6 text-center">
        <p className="text-sm text-text-secondary">Couldn&apos;t load outfits. {error}</p>
        <Button variant="secondary" size="sm" className="mt-3" onClick={reload}>Retry</Button>
      </div>
    );
  }
  if (outfits === null) return <Skeleton variant="rectangular" height={280} />;
  if (outfits.length === 0) {
    return (
      <div className="rounded-xl border border-border-subtle p-6 text-center">
        <p className="text-sm font-medium text-text-primary">No outfits yet.</p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-text-secondary">
          Ask your AI to put an outfit together, for example &ldquo;what should I wear to dinner on Friday, it will be cold&rdquo;. The ones you like are saved here under a style.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-text-secondary">{shown.length} of {outfits.length} outfits</p>
        <div className="grid w-full grid-cols-2 gap-2 sm:w-auto">
          <select aria-label="Style" className="dashboard-select" value={style} onChange={(e) => setStyle(e.target.value)}>
            <option value="">All styles</option>
            {styles.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select aria-label="Verdict" className="dashboard-select" value={verdict} onChange={(e) => setVerdict(e.target.value)}>
            <option value="">Any verdict</option>
            {VERDICTS.map((v) => <option key={v} value={v}>{label(v)}</option>)}
          </select>
        </div>
      </div>
      {shown.length ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((o) => (
            <OutfitCard
              key={o.id}
              outfit={o}
              onChange={(next) => setOutfits((prev) => (prev || []).map((x) => (x.id === next.id ? next : x)))}
              onRemove={() => void remove(o)}
            />
          ))}
        </div>
      ) : (
        <p className="py-8 text-center text-sm text-text-muted">No outfits match these filters.</p>
      )}
    </div>
  );
}
