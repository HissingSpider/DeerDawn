import { useEffect, useState, type ReactNode } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { showToast } from '@/components/ui/Toast';
import { AttachmentImage } from './AttachmentImage';
import { Spinner } from './PhotoUploader';
import { deleteAddonAttachment, uploadAddonAttachment } from './platformClient';
import { ADDON_ID, CATEGORIES, SEASONS, STATUSES, errorText, label, wardrobe, type Season, type WardrobeItem } from './types';

type Draft = {
  name: string;
  category: string;
  subcategory: string;
  colors: string;
  pattern: string;
  material: string;
  formality: string;
  warmth: string;
  seasons: Season[];
  fit: string;
  brand: string;
  size: string;
  status: string;
  location: string;
  notes: string;
  description: string;
};

const toDraft = (i: WardrobeItem): Draft => ({
  name: i.name || '',
  category: i.category || '',
  subcategory: i.subcategory || '',
  colors: (i.colors || []).join(', '),
  pattern: i.pattern || '',
  material: i.material || '',
  formality: i.formality ? String(i.formality) : '',
  warmth: i.warmth ? String(i.warmth) : '',
  seasons: i.seasons || [],
  fit: i.fit || '',
  brand: i.brand || '',
  size: i.size || '',
  status: i.status || 'active',
  location: i.location || '',
  notes: i.notes || '',
  description: i.description || '',
});

const orNull = (s: string) => (s.trim() ? s.trim() : null);

function toArgs(d: Draft) {
  return {
    name: d.name.trim() || 'Unnamed item',
    category: d.category || null,
    subcategory: orNull(d.subcategory),
    colors: d.colors.split(',').map((c) => c.trim()).filter(Boolean),
    pattern: orNull(d.pattern),
    material: orNull(d.material),
    formality: d.formality ? Number(d.formality) : null,
    warmth: d.warmth ? Number(d.warmth) : null,
    seasons: d.seasons,
    fit: orNull(d.fit),
    brand: orNull(d.brand),
    size: orNull(d.size),
    status: d.status,
    location: orNull(d.location),
    notes: orNull(d.notes),
    description: orNull(d.description),
  };
}

function Field({ label: text, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`grid gap-1.5 ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="dashboard-eyebrow">{text}</span>
      {children}
    </label>
  );
}

const SCALE = ['1', '2', '3', '4', '5'];

export function ItemPanel({
  item,
  onClose,
  onChanged,
  onRemoved,
}: {
  item: WardrobeItem | null;
  onClose: () => void;
  onChanged: (item: WardrobeItem) => void;
  onRemoved: (id: string) => void;
}) {
  const confirm = useConfirm();
  const [draft, setDraft] = useState<Draft | null>(item ? toDraft(item) : null);
  const [photos, setPhotos] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The panel opens on one item at a time; reload its photo list (the closet
  // grid only knows the cover) whenever a different item is opened.
  useEffect(() => {
    if (!item) return;
    let live = true;
    setDraft(toDraft(item));
    setError(null);
    setPhotos(item.photo_ids || (item.cover_photo_id ? [item.cover_photo_id] : []));
    wardrobe<{ item: WardrobeItem }>('get_item', { item_id: item.id }).then(
      (d) => live && setPhotos(d.item.photo_ids || []),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [item]);

  if (!item || !draft) return null;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft({ ...draft, [key]: value });

  async function save(confirmTags: boolean) {
    if (!item || !draft) return;
    setSaving(true);
    setError(null);
    try {
      const data = await wardrobe<{ item: WardrobeItem }>('update_item', { item_id: item.id, ...toArgs(draft), confirm: confirmTags || undefined });
      onChanged({ ...data.item, photo_ids: photos });
      showToast(confirmTags ? 'Saved and confirmed' : 'Saved', 'success');
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  async function photoChange(args: Record<string, unknown>) {
    if (!item) return;
    try {
      const data = await wardrobe<{ item: WardrobeItem }>('update_item', { item_id: item.id, ...args });
      const nextPhotos = data.item.photo_ids || [];
      setPhotos(nextPhotos);
      onChanged({ ...data.item, photo_ids: nextPhotos });
    } catch (err) {
      setError(errorText(err));
    }
  }

  // Hide it on the item first (that is what the agent reads), then delete the
  // stored file. A failed delete leaves an orphaned file, never a broken item.
  async function removePhoto(id: string) {
    await photoChange({ remove_photo_ids: [id] });
    try {
      await deleteAddonAttachment(ADDON_ID, id);
    } catch {
      // the photo is already off the item; the file is cleaned up with the account
    }
  }

  async function addPhotos(list: FileList | null) {
    if (!item || !list || !list.length) return;
    setUploading(true);
    setError(null);
    const ids: string[] = [];
    for (const file of Array.from(list)) {
      try {
        const att = await uploadAddonAttachment(ADDON_ID, file, { collection: 'items', recordId: item.id });
        ids.push(att.id);
      } catch (err) {
        setError(`${file.name}: ${errorText(err)}`);
      }
    }
    if (ids.length) await photoChange({ add_photo_ids: ids });
    setUploading(false);
  }

  async function remove() {
    if (!item) return;
    const ok = await confirm({
      title: `Delete ${item.name}?`,
      body: 'It leaves the closet for good, and saved outfits will show it as removed. To keep its history, set the status to donated instead.',
      confirmLabel: 'Delete item',
      destructive: true,
    });
    if (!ok) return;
    try {
      await wardrobe('remove_item', { item_ids: [item.id] });
      onRemoved(item.id);
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      labelledById="wardrobe-item-title"
      cardClassName="w-full max-w-[720px] max-h-[92vh] overflow-y-auto rounded-2xl border border-border-subtle bg-background p-6 max-sm:p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="wardrobe-item-title" className="truncate text-lg font-semibold text-text-primary">{item.name}</h2>
          <p className="mt-0.5 text-xs text-text-muted">
            <span className="font-mono">{item.ref}</span> · worn {item.wear_count || 0} {item.wear_count === 1 ? 'time' : 'times'}{item.last_worn ? `, last ${item.last_worn}` : ''}
          </p>
        </div>
        <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-sm text-text-secondary hover:text-text-primary" aria-label="Close">
          Close
        </button>
      </div>

      {!item.tags_confirmed ? (
        <p className="mt-3 rounded-lg border border-status-warning/40 px-3 py-2 text-xs text-text-secondary">
          {item.tag_error
            ? `Automatic tagging failed (${item.tag_error}). Fill in the details below, or ask your AI to look at the photo.`
            : item.tag_source === 'vision'
              ? 'These tags were drafted from the photo. Check them, then save and confirm.'
              : 'Not tagged yet. Fill in what you know, or ask your AI to tag it.'}
        </p>
      ) : null}

      <div className="mt-4">
        <p className="dashboard-eyebrow">Photos</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {photos.map((id, i) => (
            <div key={id} className="w-24">
              <AttachmentImage attachmentId={id} alt={`${item.name} photo ${i + 1}`} className="h-24 w-24 rounded-lg border border-border-subtle" />
              <div className="mt-1 flex justify-between text-[11px]">
                {i === 0 ? (
                  <span className="text-text-muted">Cover</span>
                ) : (
                  <button type="button" className="text-text-secondary hover:text-text-primary" onClick={() => void photoChange({ cover_photo_id: id })}>
                    Make cover
                  </button>
                )}
                <button type="button" className="text-status-danger" onClick={() => void removePhoto(id)}>
                  Remove
                </button>
              </div>
            </div>
          ))}
          <label className={`flex h-24 w-24 cursor-pointer items-center justify-center rounded-lg border border-dashed border-border-subtle text-center text-[11px] text-text-secondary hover:text-text-primary ${uploading ? 'pointer-events-none opacity-60' : ''}`}>
            {uploading ? <span className="flex flex-col items-center gap-1.5"><Spinner />Processing</span> : 'Add photo'}
            <input type="file" accept="image/*,image/heic,image/heif" multiple className="sr-only" onChange={(e) => void addPhotos(e.target.files)} />
          </label>
        </div>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field label="Name" wide>
          <input className="dashboard-input" value={draft.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="Category">
          <select className="dashboard-select" value={draft.category} onChange={(e) => set('category', e.target.value)}>
            <option value="">Not set</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}
          </select>
        </Field>
        <Field label="Type">
          <input className="dashboard-input" placeholder="shirt, jeans, boots" value={draft.subcategory} onChange={(e) => set('subcategory', e.target.value)} />
        </Field>
        <Field label="Colours">
          <input className="dashboard-input" placeholder="navy, white" value={draft.colors} onChange={(e) => set('colors', e.target.value)} />
        </Field>
        <Field label="Pattern">
          <input className="dashboard-input" placeholder="solid, striped" value={draft.pattern} onChange={(e) => set('pattern', e.target.value)} />
        </Field>
        <Field label="Formality (1 lounge, 5 black tie)">
          <select className="dashboard-select" value={draft.formality} onChange={(e) => set('formality', e.target.value)}>
            <option value="">Not set</option>
            {SCALE.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
        <Field label="Warmth (1 light, 5 heavy)">
          <select className="dashboard-select" value={draft.warmth} onChange={(e) => set('warmth', e.target.value)}>
            <option value="">Not set</option>
            {SCALE.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
        <div className="grid gap-1.5 sm:col-span-2">
          <span className="dashboard-eyebrow">Seasons</span>
          <div className="flex flex-wrap gap-2">
            {SEASONS.map((s) => {
              const on = draft.seasons.includes(s);
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={on}
                  onClick={() => set('seasons', on ? draft.seasons.filter((x) => x !== s) : [...draft.seasons, s])}
                  className={`rounded-md border px-3 py-1.5 text-xs font-medium ${on ? 'border-primary bg-primary text-on-primary' : 'border-border-subtle text-text-secondary hover:text-text-primary'}`}
                >
                  {label(s)}
                </button>
              );
            })}
          </div>
        </div>
        <Field label="Status">
          <select className="dashboard-select" value={draft.status} onChange={(e) => set('status', e.target.value)}>
            {STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
          </select>
        </Field>
        <Field label="Location">
          <input className="dashboard-input" placeholder="dorm, home" value={draft.location} onChange={(e) => set('location', e.target.value)} />
        </Field>
        <Field label="Material">
          <input className="dashboard-input" value={draft.material} onChange={(e) => set('material', e.target.value)} />
        </Field>
        <Field label="Fit">
          <input className="dashboard-input" placeholder="slim, relaxed" value={draft.fit} onChange={(e) => set('fit', e.target.value)} />
        </Field>
        <Field label="Brand">
          <input className="dashboard-input" value={draft.brand} onChange={(e) => set('brand', e.target.value)} />
        </Field>
        <Field label="Size">
          <input className="dashboard-input" value={draft.size} onChange={(e) => set('size', e.target.value)} />
        </Field>
        <Field label="Description" wide>
          <input className="dashboard-input" placeholder="One sentence your AI can read" value={draft.description} onChange={(e) => set('description', e.target.value)} />
        </Field>
        <Field label="Notes" wide>
          <textarea className="dashboard-textarea min-h-[88px]" placeholder="Shrinks in the dryer, goes with the grey chinos" value={draft.notes} onChange={(e) => set('notes', e.target.value)} />
        </Field>
      </div>

      {error ? <p className="mt-4 whitespace-pre-line text-sm text-status-danger">{error}</p> : null}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <Button variant="danger" size="sm" onClick={() => void remove()}>Delete item</Button>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => void save(false)} isLoading={saving}>Save</Button>
          {!item.tags_confirmed ? (
            <Button size="sm" onClick={() => void save(true)} isLoading={saving}>Save and confirm</Button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
