import { useCallback, useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { showToast } from '@/components/ui/Toast';
import { errorText, wardrobe, type WardrobeProfile, type WardrobeStyle } from './types';

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);
const commas = (s: string) => s.split(',').map((l) => l.trim()).filter(Boolean);

type StyleDraft = { name: string; description: string; doRules: string; dontRules: string; palette: string };
const toDraft = (s?: WardrobeStyle): StyleDraft => ({
  name: s?.name || '',
  description: s?.description || '',
  doRules: (s?.do || []).join('\n'),
  dontRules: (s?.dont || []).join('\n'),
  palette: (s?.palette || []).join(', '),
});

function StyleEditor({ style, onSaved, onCancel }: { style?: WardrobeStyle; onSaved: () => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<StyleDraft>(toDraft(style));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof StyleDraft, value: string) => setDraft({ ...draft, [key]: value });

  async function save() {
    if (!draft.name.trim()) { setError('Give the style a name.'); return; }
    setBusy(true);
    setError(null);
    try {
      const renamed = style && draft.name.trim() !== style.name;
      await wardrobe('save_style', {
        name: style ? style.name : draft.name.trim(),
        ...(renamed ? { rename_to: draft.name.trim() } : {}),
        description: draft.description.trim() || null,
        do: lines(draft.doRules),
        dont: lines(draft.dontRules),
        palette: commas(draft.palette),
      });
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3 rounded-xl border border-border-subtle bg-overlay-subtle p-4 sm:grid-cols-2">
      <label className="grid gap-1.5">
        <span className="dashboard-eyebrow">Name</span>
        <input className="dashboard-input" placeholder="Smart casual" value={draft.name} onChange={(e) => set('name', e.target.value)} />
      </label>
      <label className="grid gap-1.5">
        <span className="dashboard-eyebrow">Palette (colour names)</span>
        <input className="dashboard-input" placeholder="navy, stone, white" value={draft.palette} onChange={(e) => set('palette', e.target.value)} />
      </label>
      <label className="grid gap-1.5 sm:col-span-2">
        <span className="dashboard-eyebrow">Description</span>
        <input className="dashboard-input" placeholder="Office without a tie" value={draft.description} onChange={(e) => set('description', e.target.value)} />
      </label>
      <label className="grid gap-1.5">
        <span className="dashboard-eyebrow">Do (one per line)</span>
        <textarea className="dashboard-textarea min-h-[96px]" placeholder="Collared shirts" value={draft.doRules} onChange={(e) => set('doRules', e.target.value)} />
      </label>
      <label className="grid gap-1.5">
        <span className="dashboard-eyebrow">Don&apos;t (one per line)</span>
        <textarea className="dashboard-textarea min-h-[96px]" placeholder="Sneakers" value={draft.dontRules} onChange={(e) => set('dontRules', e.target.value)} />
      </label>
      {error ? <p className="whitespace-pre-line text-sm text-status-danger sm:col-span-2">{error}</p> : null}
      <div className="flex gap-2 sm:col-span-2">
        <Button size="sm" isLoading={busy} onClick={() => void save()}>Save style</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function ProfileEditor({ profile, onSaved }: { profile: WardrobeProfile | null; onSaved: () => void }) {
  const [prefs, setPrefs] = useState((profile?.preferences || []).join('\n'));
  const [sizes, setSizes] = useState(Object.entries(profile?.sizes || {}).map(([k, v]) => `${k}: ${v}`).join('\n'));
  const [notes, setNotes] = useState(profile?.notes || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    const nextSizes: Record<string, string | null> = {};
    for (const key of Object.keys(profile?.sizes || {})) nextSizes[key] = null; // removed lines clear their size
    for (const line of lines(sizes)) {
      const at = line.indexOf(':');
      if (at > 0) nextSizes[line.slice(0, at).trim()] = line.slice(at + 1).trim() || null;
    }
    try {
      await wardrobe('set_profile', { preferences: lines(prefs), sizes: nextSizes, notes: notes.trim() || null });
      showToast('Preferences saved', 'success');
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="wardrobe-profile" className="space-y-3">
      <div>
        <h2 id="wardrobe-profile" className="text-sm font-semibold text-text-primary">Standing preferences</h2>
        <p className="text-xs text-text-secondary">Rules for every outfit, whatever the style. Your AI reads these before it proposes anything.</p>
      </div>
      <div className="grid gap-3 rounded-xl border border-border-subtle bg-overlay-subtle p-4 sm:grid-cols-2">
        <label className="grid gap-1.5">
          <span className="dashboard-eyebrow">Preferences (one per line)</span>
          <textarea className="dashboard-textarea min-h-[110px]" placeholder={'Nothing tight\nNo logos'} value={prefs} onChange={(e) => setPrefs(e.target.value)} />
        </label>
        <label className="grid gap-1.5">
          <span className="dashboard-eyebrow">Sizes (kind: size, one per line)</span>
          <textarea className="dashboard-textarea min-h-[110px]" placeholder={'tops: M\nshoes: 43'} value={sizes} onChange={(e) => setSizes(e.target.value)} />
        </label>
        <label className="grid gap-1.5 sm:col-span-2">
          <span className="dashboard-eyebrow">Notes</span>
          <input className="dashboard-input" placeholder="I run warm; I cycle to class" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        {error ? <p className="whitespace-pre-line text-sm text-status-danger sm:col-span-2">{error}</p> : null}
        <div className="sm:col-span-2">
          <Button size="sm" isLoading={busy} onClick={() => void save()}>Save preferences</Button>
        </div>
      </div>
    </section>
  );
}

export function StylesTab() {
  const confirm = useConfirm();
  const [data, setData] = useState<{ styles: WardrobeStyle[]; profile: WardrobeProfile | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);

  const reload = useCallback(() => {
    wardrobe<{ styles: WardrobeStyle[]; profile: WardrobeProfile | null }>('styles').then(
      (d) => { setData(d); setError(null); },
      (err) => setError(errorText(err)),
    );
  }, []);
  useEffect(() => { reload(); }, [reload]);

  async function remove(s: WardrobeStyle) {
    const ok = await confirm({ title: `Delete the style "${s.name}"?`, body: 'Outfits saved under it are kept, without this style.', confirmLabel: 'Delete style', destructive: true });
    if (!ok) return;
    try {
      await wardrobe('remove_style', { name: s.name });
      reload();
    } catch (err) {
      showToast(errorText(err), 'error');
    }
  }

  if (error && !data) {
    return (
      <div className="rounded-xl border border-border-subtle bg-overlay-subtle p-6 text-center">
        <p className="text-sm text-text-secondary">Couldn&apos;t load styles. {error}</p>
        <Button variant="secondary" size="sm" className="mt-3" onClick={reload}>Retry</Button>
      </div>
    );
  }
  if (!data) return <Skeleton variant="rectangular" height={280} />;

  return (
    <div className="space-y-8">
      <section aria-labelledby="wardrobe-styles" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="wardrobe-styles" className="text-sm font-semibold text-text-primary">Styles</h2>
            <p className="text-xs text-text-secondary">Named looks with their own rules, so &ldquo;smart casual&rdquo; and &ldquo;gym&rdquo; get different answers.</p>
          </div>
          {editing !== 'new' ? <Button size="sm" variant="secondary" onClick={() => setEditing('new')}>New style</Button> : null}
        </div>
        {editing === 'new' ? <StyleEditor onSaved={() => { setEditing(null); reload(); }} onCancel={() => setEditing(null)} /> : null}
        {data.styles.length === 0 && editing !== 'new' ? (
          <div className="rounded-xl border border-border-subtle p-6 text-center">
            <p className="text-sm font-medium text-text-primary">No styles yet.</p>
            <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-text-secondary">
              Add one here, or let them appear as your AI saves outfits. A style with do and don&apos;t rules gives better suggestions.
            </p>
          </div>
        ) : null}
        <div className="grid gap-3 lg:grid-cols-2">
          {data.styles.map((s) =>
            editing === s.id ? (
              <StyleEditor key={s.id} style={s} onSaved={() => { setEditing(null); reload(); }} onCancel={() => setEditing(null)} />
            ) : (
              <article key={s.id} className="rounded-xl border border-border-subtle bg-overlay-subtle p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold text-text-primary">{s.name}</h3>
                    <p className="text-[11px] text-text-muted">{s.outfit_count || 0} {s.outfit_count === 1 ? 'outfit' : 'outfits'}</p>
                  </div>
                  <div className="flex shrink-0 gap-3 text-[11px] font-medium">
                    <button type="button" className="text-text-secondary hover:text-text-primary" onClick={() => setEditing(s.id)}>Edit</button>
                    <button type="button" className="text-status-danger" onClick={() => void remove(s)}>Delete</button>
                  </div>
                </div>
                {s.description ? <p className="mt-2 text-xs text-text-secondary">{s.description}</p> : null}
                {(s.do || []).length ? <p className="mt-2 text-xs text-text-secondary"><span className="font-medium text-text-primary">Do:</span> {s.do!.join('; ')}</p> : null}
                {(s.dont || []).length ? <p className="mt-1 text-xs text-text-secondary"><span className="font-medium text-text-primary">Don&apos;t:</span> {s.dont!.join('; ')}</p> : null}
                {(s.palette || []).length ? <p className="mt-1 text-xs text-text-secondary"><span className="font-medium text-text-primary">Palette:</span> {s.palette!.join(', ')}</p> : null}
              </article>
            ),
          )}
        </div>
      </section>

      <ProfileEditor key={data.profile?.id || 'none'} profile={data.profile} onSaved={reload} />
    </div>
  );
}
