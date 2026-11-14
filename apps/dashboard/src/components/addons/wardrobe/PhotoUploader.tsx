import { useRef, useState } from 'react';
import { uploadAddonAttachment } from './platformClient';
import { ADDON_ID, errorText, wardrobe, type WardrobeItem } from './types';

// Phone camera rolls hand over dozens of photos at once. Three at a time keeps
// a phone connection busy without one slow file holding the rest, and each
// file reports its own state so one failure does not hide forty successes.
const CONCURRENCY = 3;

type FileState = { key: string; name: string; state: 'queued' | 'uploading' | 'adding' | 'done' | 'error'; error?: string };

// The server converts and resizes each photo on the way in; a 12 MP iPhone
// HEIC takes about 5 seconds, so "uploading" says processing, with a spinner.
const STATE_LABEL: Record<FileState['state'], string> = {
  queued: 'Waiting',
  uploading: 'Uploading and processing',
  adding: 'Adding to closet',
  done: 'Added',
  error: 'Failed',
};

const ACCEPT = 'image/*,image/heic,image/heif';

export function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-border-subtle border-t-primary"
    />
  );
}

export function PhotoUploader({ onAdded, onTagged }: { onAdded: (items: WardrobeItem[]) => void; onTagged?: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<FileState[]>([]);
  const [tagging, setTagging] = useState(false);
  const busy = tagging || files.some((f) => f.state === 'queued' || f.state === 'uploading' || f.state === 'adding');

  const update = (key: string, patch: Partial<FileState>) =>
    setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  async function uploadOne(file: File, key: string): Promise<WardrobeItem | null> {
    try {
      update(key, { state: 'uploading' });
      const attachment = await uploadAddonAttachment(ADDON_ID, file, { collection: 'items' });
      update(key, { state: 'adding' });
      // tag:false keeps this call fast. Drafting tags with a vision model can
      // outlast the client's request timeout, and a timed-out add that
      // succeeded server-side would be retried into a duplicate.
      const data = await wardrobe<{ items: WardrobeItem[] }>('add_item', { attachment_id: attachment.id, tag: false });
      update(key, { state: 'done' });
      return data.items[0] || null;
    } catch (err) {
      update(key, { state: 'error', error: errorText(err) });
      return null;
    }
  }

  async function start(list: FileList | null) {
    if (!list || !list.length) return;
    const picked = Array.from(list);
    const stamp = Date.now();
    const entries = picked.map((f, i) => ({ file: f, key: `${stamp}-${i}-${f.name}` }));
    setFiles((prev) => [...prev.filter((f) => f.state !== 'done'), ...entries.map(({ file, key }) => ({ key, name: file.name || 'photo', state: 'queued' as const }))]);
    const added: WardrobeItem[] = [];
    let next = 0;
    const worker = async () => {
      while (next < entries.length) {
        const { file, key } = entries[next++];
        const item = await uploadOne(file, key);
        if (item) added.push(item);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker));
    if (inputRef.current) inputRef.current.value = '';
    if (added.length) onAdded(added);
    // Draft tags for what was just added, when the server has a vision model.
    // Best effort: without one, or if this is slow, the items simply wait in
    // the confirm queue and the closet refresh picks up whatever was drafted.
    if (added.length && onTagged) {
      setTagging(true);
      const ids = added.map((i) => i.id);
      for (let i = 0; i < ids.length; i += 5) {
        try {
          await wardrobe('tag_pending', { item_ids: ids.slice(i, i + 5), limit: 5 });
        } catch {
          // no vision model, or the request outlived its timeout: nothing lost
        }
      }
      setTagging(false);
      onTagged();
    }
  }

  const done = files.filter((f) => f.state === 'done').length;
  const failed = files.filter((f) => f.state === 'error');

  return (
    <div className="rounded-xl border border-border-subtle bg-overlay-subtle p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text-primary">Add photos</p>
          <p className="mt-0.5 text-xs text-text-secondary">One photo per item. Pick as many as you like from your camera roll.</p>
        </div>
        <label className={`inline-flex h-11 cursor-pointer items-center rounded-lg bg-primary px-[18px] text-sm font-medium text-on-primary hover:bg-primary-hover ${busy ? 'pointer-events-none opacity-60' : ''}`}>
          {tagging ? 'Describing photos...' : busy ? 'Uploading...' : 'Choose photos'}
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            multiple
            className="sr-only"
            disabled={busy}
            onChange={(e) => void start(e.target.files)}
          />
        </label>
      </div>
      {files.length ? (
        <div className="mt-4 space-y-2">
          <p className="text-xs text-text-secondary" aria-live="polite">
            {done} of {files.length} added{failed.length ? `, ${failed.length} failed` : ''}.
          </p>
          <ul className="max-h-48 space-y-1 overflow-y-auto pr-1">
            {files.map((f) => (
              <li key={f.key} className="flex items-center justify-between gap-3 text-xs">
                <span className="min-w-0 truncate text-text-secondary">{f.name}</span>
                <span
                  className={`flex shrink-0 items-center gap-1.5 ${f.state === 'error' ? 'text-status-danger' : f.state === 'done' ? 'text-primary' : 'text-text-muted'}`}
                  title={f.error}
                >
                  {f.state === 'uploading' || f.state === 'adding' ? <Spinner /> : null}
                  {f.state === 'error' ? `Failed: ${f.error}` : STATE_LABEL[f.state]}
                </span>
              </li>
            ))}
          </ul>
          {!busy ? (
            <button type="button" className="text-xs font-medium text-text-secondary underline-offset-4 hover:text-text-primary hover:underline" onClick={() => setFiles([])}>
              Clear list
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
