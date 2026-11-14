import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageScaffold, InlineErrorState } from '@/components/dashboard/PageScaffold';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { isApiError } from '@/lib/api';
import {
  addonAttachmentUrl,
  listAddonAttachments,
  listAddons,
  runAddonAction,
  uploadAddonAttachment,
  type AddonAttachment,
  type AddonCatalogEntry,
  type AddonRecord,
  type AddonView,
} from '@/lib/addonsApi';

// THE GENERIC RENDERER for declarative add-ons, driven by the manifest's
// `views` (gallery, table, detail). Official add-ons may ship a hand-built page
// instead: Next gives a static pages/addons/<id>.tsx precedence over this one.
// Nothing here loads remote code; every view is data rendered by this file.

type Row = AddonRecord<Record<string, unknown>>;

const errorText = (err: unknown, fallback: string) => (isApiError(err) ? err.message : fallback);

function display(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(display).join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function schemaFields(addon: AddonCatalogEntry, collection: string): string[] {
  const schema = addon.collections.find((c) => c.name === collection)?.schema;
  return schema?.properties ? Object.keys(schema.properties) : [];
}

function fieldsFor(addon: AddonCatalogEntry, view: AddonView, rows: Row[]): string[] {
  if (view.fields?.length) return view.fields;
  const fromSchema = schemaFields(addon, view.collection);
  if (fromSchema.length) return fromSchema.slice(0, 6);
  return [...new Set(rows.flatMap((r) => Object.keys(r.data || {})))].slice(0, 6);
}

function titleOf(row: Row, view: AddonView): string {
  const field = view.title_field || 'title';
  return display(row.data?.[field]) || display(row.data?.name) || row.id;
}

function AttachmentThumb({ addonId, attachment, variant = 'thumb' }: { addonId: string; attachment: AddonAttachment; variant?: 'thumb' | 'view' }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    addonAttachmentUrl(addonId, attachment.id, variant).then((url) => { if (!cancelled) setSrc(url); }).catch(() => {});
    return () => { cancelled = true; };
  }, [addonId, attachment.id, variant]);
  if (!src) return <div className="aspect-square w-full rounded-lg bg-surface-hover" />;
  // eslint-disable-next-line @next/next/no-img-element -- a blob: URL, which next/image cannot optimise
  return <img src={src} alt="" className="aspect-square w-full rounded-lg object-cover" />;
}

function RecordThumb({ addonId, collection, recordId }: { addonId: string; collection: string; recordId: string }) {
  const [first, setFirst] = useState<AddonAttachment | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    listAddonAttachments(addonId, collection, recordId)
      .then((list) => { if (!cancelled) setFirst(list[0] || null); })
      .catch(() => { if (!cancelled) setFirst(null); });
    return () => { cancelled = true; };
  }, [addonId, collection, recordId]);
  if (first === undefined) return <div className="aspect-square w-full rounded-lg bg-surface-hover" />;
  if (!first) return <div className="flex aspect-square w-full items-center justify-center rounded-lg bg-surface-hover text-xs text-text-muted">No photo</div>;
  return <AttachmentThumb addonId={addonId} attachment={first} />;
}

function CreateForm({ addon, collection, onCreated }: { addon: AddonCatalogEntry; collection: string; onCreated: (row: Row) => void }) {
  const schema = addon.collections.find((c) => c.name === collection)?.schema;
  const props: Record<string, any> = schema?.properties || {};
  const editable = Object.entries(props).filter(([, p]) => ['string', 'number', 'integer', 'boolean'].includes(p?.type)
    || (p?.type === 'array' && p?.items?.type === 'string'));
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!editable.length) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const data: Record<string, unknown> = {};
    for (const [name, p] of editable) {
      const raw = values[name];
      if (raw === undefined || raw === '') continue;
      if (p.type === 'boolean') data[name] = Boolean(raw);
      else if (p.type === 'number' || p.type === 'integer') data[name] = Number(raw);
      else if (p.type === 'array') data[name] = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
      else data[name] = String(raw);
    }
    try {
      const result = await runAddonAction<{ record: Row }>(addon.id, 'create', { collection, data });
      if (result.data?.record) onCreated(result.data.record);
      setValues({});
    } catch (err) {
      setError(errorText(err, 'That could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-2xl border border-border-subtle bg-surface p-4">
      <div className="text-sm font-semibold text-text-primary">New {collection.replace(/_/g, ' ')}</div>
      <div className="grid gap-3 sm:grid-cols-2">
        {editable.map(([name, p]) => (
          <label key={name} className="space-y-1 text-sm">
            <span className="block text-text-secondary">{p.title || name}{schema?.required?.includes(name) ? ' *' : ''}</span>
            {p.type === 'boolean' ? (
              <input type="checkbox" checked={Boolean(values[name])} onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.checked }))} />
            ) : (
              <input
                className="h-10 w-full rounded-lg border border-border-subtle bg-background px-3 text-text-primary"
                type={p.type === 'number' || p.type === 'integer' ? 'number' : 'text'}
                placeholder={p.type === 'array' ? 'comma, separated' : ''}
                value={String(values[name] ?? '')}
                onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
              />
            )}
          </label>
        ))}
      </div>
      {error ? <p role="alert" className="text-sm text-status-danger">{error}</p> : null}
      <Button type="submit" size="sm" isLoading={busy}>Save</Button>
    </form>
  );
}

function RecordDetail({ addon, collection, row, fields, onDeleted }: {
  addon: AddonCatalogEntry; collection: string; row: Row; fields: string[]; onDeleted: (id: string) => void;
}) {
  const takesFiles = Boolean(addon.collections.find((c) => c.name === collection)?.attachments);
  const [files, setFiles] = useState<AddonAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!takesFiles) return;
    let cancelled = false;
    listAddonAttachments(addon.id, collection, row.id).then((list) => { if (!cancelled) setFiles(list); }).catch(() => {});
    return () => { cancelled = true; };
  }, [addon.id, collection, row.id, takesFiles]);

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(list)) {
        const attachment = await uploadAddonAttachment(addon.id, file, { collection, recordId: row.id });
        setFiles((current) => [...current, attachment]);
      }
    } catch (err) {
      setError(errorText(err, 'The upload did not go through.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await runAddonAction(addon.id, 'remove', { collection, id: row.id });
      onDeleted(row.id);
    } catch (err) {
      setError(errorText(err, 'That could not be deleted.'));
      setBusy(false);
    }
  };

  const shown = fields.length ? fields : Object.keys(row.data || {});
  return (
    <div className="space-y-4 rounded-2xl border border-border-subtle bg-surface p-4 sm:p-5">
      <dl className="grid gap-3 sm:grid-cols-[160px_1fr]">
        {shown.map((field) => (
          <div key={field} className="contents">
            <dt className="text-xs font-medium uppercase tracking-[0.08em] text-text-muted">{field}</dt>
            <dd className="whitespace-pre-wrap break-words text-sm text-text-primary">{display(row.data?.[field]) || '-'}</dd>
          </div>
        ))}
      </dl>
      {takesFiles ? (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {files.map((file) => <AttachmentThumb key={file.id} addonId={addon.id} attachment={file} />)}
          </div>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-primary">
            <input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple className="sr-only" disabled={busy} onChange={(e) => upload(e.target.files)} />
            {busy ? 'Working...' : 'Add photos'}
          </label>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-sm text-status-danger">{error}</p> : null}
      <div className="flex justify-end">
        <Button size="sm" variant="danger" isLoading={busy} onClick={remove}>Delete</Button>
      </div>
    </div>
  );
}

export default function AddonDetailPage() {
  const router = useRouter();
  const addonId = typeof router.query.id === 'string' ? router.query.id : '';
  const [addon, setAddon] = useState<AddonCatalogEntry | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [viewId, setViewId] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingRows, setLoadingRows] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!addonId) return;
    let cancelled = false;
    listAddons()
      .then((list) => { if (!cancelled) setAddon(list.find((a) => a.id === addonId) || null); })
      .catch((err) => { if (!cancelled) setError(errorText(err, 'The add-on could not be loaded.')); });
    return () => { cancelled = true; };
  }, [addonId]);

  const views: AddonView[] = useMemo(() => {
    if (!addon) return [];
    if (addon.views.length) return addon.views;
    return addon.collections.map((c) => ({ id: c.name, type: 'table' as const, collection: c.name }));
  }, [addon]);
  const listViews = views.filter((v) => v.type !== 'detail');
  const view = listViews.find((v) => v.id === viewId) || listViews[0] || null;
  const detailView = view ? views.find((v) => v.type === 'detail' && v.collection === view.collection) : undefined;

  const load = useCallback(async (append: string | null) => {
    if (!addon || !view) return;
    setLoadingRows(true);
    try {
      const result = await runAddonAction<{ rows: Row[]; next_cursor: string | null }>(addon.id, 'list', {
        collection: view.collection, limit: 50, ...(append ? { cursor: append } : {}),
      });
      const page = result.data?.rows || [];
      setRows((current) => (append ? [...current, ...page] : page));
      setCursor(result.data?.next_cursor || null);
    } catch (err) {
      setError(errorText(err, 'The records could not be loaded.'));
    } finally {
      setLoadingRows(false);
    }
  }, [addon, view]);

  useEffect(() => {
    setRows([]);
    setCursor(null);
    setSelected(null);
    if (addon?.enabled) void load(null);
  }, [addon, view?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedRow = rows.find((r) => r.id === selected) || null;

  return (
    <>
      <Head><title>{addon?.name ? `${addon.name} | DeerDawn` : 'Add-on | DeerDawn'}</title></Head>
      <PageScaffold
        title={addon?.name || 'Add-on'}
        description={addon?.description || undefined}
        action={<Link href="/addons" className="text-sm font-medium text-primary hover:underline">All add-ons</Link>}
      >
        {error ? <InlineErrorState title="Something went wrong" description={error} onRetry={() => { setError(null); void load(null); }} /> : null}
        {addon === undefined && !error ? <Skeleton className="h-40 w-full" /> : null}
        {addon === null ? <p className="text-sm text-text-secondary">There is no add-on called &quot;{addonId}&quot; on this server.</p> : null}
        {addon && !addon.enabled ? (
          <p className="text-sm text-text-secondary">
            {addon.name} is off for this workspace. <Link href="/addons" className="font-medium text-primary hover:underline">Turn it on</Link> to use it.
          </p>
        ) : null}
        {addon?.enabled && view ? (
          <div className="space-y-4">
            {listViews.length > 1 ? (
              <div role="tablist" className="flex flex-wrap gap-2">
                {listViews.map((v) => (
                  <button
                    key={v.id}
                    role="tab"
                    type="button"
                    aria-selected={v.id === view.id}
                    onClick={() => setViewId(v.id)}
                    className={`rounded-lg border px-3 py-1.5 text-sm ${v.id === view.id ? 'border-primary/40 text-primary' : 'border-border-subtle text-text-secondary hover:text-text-primary'}`}
                  >
                    {v.title || v.id}
                  </button>
                ))}
              </div>
            ) : null}

            <CreateForm addon={addon} collection={view.collection} onCreated={(row) => setRows((current) => [row, ...current])} />

            {selectedRow ? (
              <div className="space-y-2">
                <button type="button" className="text-sm text-text-secondary hover:text-text-primary" onClick={() => setSelected(null)}>Back to the list</button>
                <RecordDetail
                  addon={addon}
                  collection={view.collection}
                  row={selectedRow}
                  fields={detailView?.fields || fieldsFor(addon, view, rows)}
                  onDeleted={(id) => { setRows((current) => current.filter((r) => r.id !== id)); setSelected(null); }}
                />
              </div>
            ) : null}

            {!selectedRow && rows.length === 0 && !loadingRows ? (
              <p className="text-sm text-text-secondary">Nothing saved here yet. Add one above, or ask your agent.</p>
            ) : null}

            {!selectedRow && rows.length > 0 && view.type === 'gallery' ? (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {rows.map((row) => (
                  <li key={row.id}>
                    <button type="button" onClick={() => setSelected(row.id)} className="block w-full space-y-2 rounded-xl border border-border-subtle bg-surface p-2 text-left hover:border-border-strong">
                      {addon.collections.find((c) => c.name === view.collection)?.attachments
                        ? <RecordThumb addonId={addon.id} collection={view.collection} recordId={row.id} />
                        : null}
                      <span className="block truncate px-1 text-sm text-text-primary">{titleOf(row, view)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            {!selectedRow && rows.length > 0 && view.type === 'table' ? (
              <div className="overflow-x-auto rounded-2xl border border-border-subtle">
                <table className="w-full min-w-[480px] text-left text-sm">
                  <thead className="border-b border-border-subtle text-xs uppercase tracking-[0.08em] text-text-muted">
                    <tr>{fieldsFor(addon, view, rows).map((f) => <th key={f} className="px-4 py-2 font-medium">{f}</th>)}</tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id} onClick={() => setSelected(row.id)} className="cursor-pointer border-b border-border-subtle last:border-b-0 hover:bg-surface-hover">
                        {fieldsFor(addon, view, rows).map((f) => (
                          <td key={f} className="max-w-[280px] truncate px-4 py-2 text-text-primary">{display(row.data?.[f])}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {!selectedRow && cursor ? (
              <Button size="sm" variant="secondary" isLoading={loadingRows} onClick={() => load(cursor)}>Load more</Button>
            ) : null}
          </div>
        ) : null}
      </PageScaffold>
    </>
  );
}
