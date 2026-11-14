import { useCallback, useEffect, useMemo, useState } from 'react';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { showToast } from '@/components/ui/Toast';
import { AttachmentImage } from './AttachmentImage';
import { ItemPanel } from './ItemPanel';
import { PhotoUploader } from './PhotoUploader';
import { CATEGORIES, STATUSES, errorText, label, wardrobe, type WardrobeItem } from './types';

type ListPage = { items: WardrobeItem[]; next_cursor: string | null };

async function loadAllItems(): Promise<WardrobeItem[]> {
  const all: WardrobeItem[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 20; guard += 1) {
    const page: ListPage = await wardrobe<ListPage>('list_items', { limit: 300, ...(cursor ? { cursor } : {}) });
    all.push(...page.items);
    cursor = page.next_cursor;
    if (!cursor) break;
  }
  return all;
}

function ItemCard({ item, onOpen, onConfirm }: { item: WardrobeItem; onOpen: () => void; onConfirm?: () => void }) {
  return (
    <div className="group overflow-hidden rounded-xl border border-border-subtle bg-overlay-subtle">
      <button type="button" onClick={onOpen} className="block w-full text-left">
        <AttachmentImage attachmentId={item.cover_photo_id} alt={item.name} className="aspect-square w-full" />
        <div className="p-2.5">
          <p className="truncate text-[13px] font-medium text-text-primary">{item.name}</p>
          <p className="mt-0.5 truncate text-[11px] text-text-muted">
            {[item.category ? label(item.category) : null, (item.colors || []).slice(0, 2).join(', ') || null, item.location].filter(Boolean).join(' · ') || 'No details yet'}
          </p>
          {item.status !== 'active' ? <p className="mt-1 text-[11px] text-status-warning">{label(item.status)}</p> : null}
        </div>
      </button>
      {onConfirm ? (
        <div className="flex gap-2 border-t border-border-subtle px-2.5 py-2">
          <button type="button" onClick={onOpen} className="text-[11px] font-medium text-text-secondary hover:text-text-primary">Edit</button>
          <button type="button" onClick={onConfirm} className="ml-auto text-[11px] font-semibold text-primary hover:underline" disabled={!item.category}>
            {item.category ? 'Looks right' : 'Needs details'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function ClosetTab() {
  const [items, setItems] = useState<WardrobeItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('active');
  const [location, setLocation] = useState('');
  const [open, setOpen] = useState<WardrobeItem | null>(null);
  const [newPhotos, setNewPhotos] = useState<{ id: string }[]>([]);
  const [adopting, setAdopting] = useState(false);

  const reload = useCallback(() => {
    loadAllItems().then(
      (all) => {
        setItems(all);
        setError(null);
      },
      (err) => setError(errorText(err)),
    );
    // Photos that arrived without an item (the phone upload link, or an
    // upload whose add step failed). Best effort: the closet works without it.
    wardrobe<{ new_photos?: { id: string }[] }>('review_queue', { limit: 1 }).then(
      (d) => setNewPhotos(d.new_photos || []),
      () => setNewPhotos([]),
    );
  }, []);

  async function adoptNewPhotos() {
    setAdopting(true);
    try {
      const ids = newPhotos.map((p) => p.id);
      const created: string[] = [];
      for (let i = 0; i < ids.length; i += 50) {
        const d = await wardrobe<{ items: WardrobeItem[] }>('add_item', { attachment_ids: ids.slice(i, i + 50), tag: false });
        created.push(...d.items.map((it) => it.id));
      }
      showToast(`Added ${ids.length} ${ids.length === 1 ? 'photo' : 'photos'} to your closet`, 'success');
      // Best effort, as in PhotoUploader: drafts tags only when the server has a vision model.
      for (let i = 0; i < created.length; i += 5) {
        try {
          await wardrobe('tag_pending', { item_ids: created.slice(i, i + 5), limit: 5 });
        } catch {
          // no vision model, or slow: the items wait in the confirm queue
        }
      }
    } catch (err) {
      showToast(errorText(err), 'error');
    } finally {
      setAdopting(false);
      reload();
    }
  }

  useEffect(() => {
    reload();
  }, [reload]);

  const locations = useMemo(
    () => [...new Set((items || []).map((i) => i.location).filter((l): l is string => Boolean(l)))].sort(),
    [items],
  );
  const queue = useMemo(() => (items || []).filter((i) => !i.tags_confirmed), [items]);
  const shown = useMemo(
    () =>
      (items || []).filter(
        (i) =>
          i.tags_confirmed &&
          (!category || i.category === category) &&
          (!status || i.status === status) &&
          (!location || (i.location || '').toLowerCase() === location.toLowerCase()),
      ),
    [items, category, status, location],
  );

  const replace = (next: WardrobeItem) => setItems((prev) => (prev || []).map((i) => (i.id === next.id ? { ...i, ...next } : i)));

  async function confirmItems(ids: string[]) {
    try {
      await wardrobe('confirm_tags', { item_ids: ids });
      setItems((prev) => (prev || []).map((i) => (ids.includes(i.id) ? { ...i, tags_confirmed: true } : i)));
      showToast(ids.length === 1 ? 'Confirmed' : `Confirmed ${ids.length} items`, 'success');
    } catch (err) {
      showToast(errorText(err), 'error');
    }
  }

  if (error && !items) {
    return (
      <div className="rounded-xl border border-border-subtle bg-overlay-subtle p-6 text-center">
        <p className="text-sm text-text-secondary">Couldn&apos;t load your closet. {error}</p>
        <Button variant="secondary" size="sm" className="mt-3" onClick={reload}>Retry</Button>
      </div>
    );
  }

  const confirmable = queue.filter((i) => i.category);

  return (
    <div className="space-y-5">
      <PhotoUploader onAdded={(added) => setItems((prev) => [...(prev || []), ...added])} onTagged={reload} />

      {items === null ? <Skeleton variant="rectangular" height={280} /> : null}

      {newPhotos.length ? (
        <section aria-labelledby="wardrobe-new-photos" className="space-y-3 rounded-xl border border-border-subtle p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 id="wardrobe-new-photos" className="text-sm font-semibold text-text-primary">
                {newPhotos.length} new {newPhotos.length === 1 ? 'photo' : 'photos'}
              </h2>
              <p className="text-xs text-text-secondary">Uploaded but not in your closet yet. Each photo becomes one item.</p>
            </div>
            <Button size="sm" isLoading={adopting} onClick={() => void adoptNewPhotos()}>
              Add to closet
            </Button>
          </div>
          <div className="flex gap-2 overflow-x-auto">
            {newPhotos.slice(0, 12).map((p) => (
              <AttachmentImage key={p.id} attachmentId={p.id} alt="New photo" className="h-16 w-16 shrink-0 rounded-md border border-border-subtle" />
            ))}
            {newPhotos.length > 12 ? <span className="self-center text-xs text-text-muted">+{newPhotos.length - 12} more</span> : null}
          </div>
        </section>
      ) : null}

      {queue.length ? (
        <section aria-labelledby="wardrobe-queue" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 id="wardrobe-queue" className="text-sm font-semibold text-text-primary">
                {queue.length} new {queue.length === 1 ? 'item' : 'items'} to confirm
              </h2>
              <p className="text-xs text-text-secondary">Check the tags on each one. Anything without details can be tagged here or by your AI.</p>
            </div>
            {confirmable.length > 1 ? (
              <Button variant="secondary" size="sm" onClick={() => void confirmItems(confirmable.map((i) => i.id))}>
                Confirm {confirmable.length} with details
              </Button>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {queue.map((item) => (
              <ItemCard key={item.id} item={item} onOpen={() => setOpen(item)} onConfirm={() => void confirmItems([item.id])} />
            ))}
          </div>
        </section>
      ) : null}

      {items !== null ? (
        <section aria-labelledby="wardrobe-closet" className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 id="wardrobe-closet" className="text-sm font-semibold text-text-primary">
              Closet <span className="font-normal text-text-muted">{shown.length} shown</span>
            </h2>
            <div className="grid w-full grid-cols-3 gap-2 sm:w-auto">
              <select aria-label="Category" className="dashboard-select" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">All categories</option>
                {CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}
              </select>
              <select aria-label="Status" className="dashboard-select" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">Any status</option>
                {STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
              </select>
              <select aria-label="Location" className="dashboard-select" value={location} onChange={(e) => setLocation(e.target.value)}>
                <option value="">Everywhere</option>
                {locations.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
          </div>
          {items.length === 0 ? (
            <div className="rounded-xl border border-border-subtle p-6 text-center">
              <p className="text-sm font-medium text-text-primary">Your closet is empty.</p>
              <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-text-secondary">
                Add photos above, one item per photo. Or ask your AI for an upload link to open on your phone, or tell it what you own and it will add items by description.
              </p>
            </div>
          ) : shown.length === 0 ? (
            <p className="py-8 text-center text-sm text-text-muted">
              {queue.length && queue.length === items.length ? 'Everything is waiting to be confirmed above.' : 'Nothing matches these filters.'}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {shown.map((item) => <ItemCard key={item.id} item={item} onOpen={() => setOpen(item)} />)}
            </div>
          )}
        </section>
      ) : null}

      <ItemPanel
        item={open}
        onClose={() => setOpen(null)}
        onChanged={replace}
        onRemoved={(id) => setItems((prev) => (prev || []).filter((i) => i.id !== id))}
      />
    </div>
  );
}
