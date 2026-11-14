// Typed client for /api/v1/addons (apps/api/src/routes/addons.js).
//
// The Wardrobe page imports runAddonAction, uploadAddonAttachment and
// addonAttachmentUrl from here; their signatures are pinned (see the shared
// notes for the add-on sessions) and should not change shape.

import { requestApi, requestApiRaw } from '@/lib/api';

export type AddonVariant = 'thumb' | 'view' | 'original';

export interface AddonImage {
  mime: string;
  base64: string;
}

export interface AddonActionResult<T = any> {
  text: string;
  data: T | null;
  images: AddonImage[];
}

export interface AddonAttachment {
  id: string;
  addon_id: string;
  collection: string;
  record_id: string | null;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  created_at: string;
}

export interface AddonRecord<D = Record<string, unknown>> {
  id: string;
  data: D;
  created_at: string;
  updated_at: string;
}

export interface AddonView {
  id: string;
  type: 'gallery' | 'table' | 'detail';
  collection: string;
  title?: string;
  fields?: string[];
  title_field?: string;
}

export interface AddonCollectionInfo {
  name: string;
  attachments: boolean;
  schema?: Record<string, any>;
}

export interface AddonCatalogEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  kind: 'declarative' | 'server';
  enabled: boolean;
  collections: AddonCollectionInfo[];
  views: AddonView[];
  actions: { name: string; mode: 'read' | 'write'; description: string }[];
}

const base = (addonId: string) => `/api/v1/addons/${encodeURIComponent(addonId)}`;

export async function listAddons(): Promise<AddonCatalogEntry[]> {
  const body = await requestApi<{ addons: AddonCatalogEntry[] }>('/api/v1/addons');
  return Array.isArray(body?.addons) ? body.addons : [];
}

export async function setAddonEnabled(addonId: string, enabled: boolean): Promise<AddonCatalogEntry> {
  const body = await requestApi<{ addon: AddonCatalogEntry }>(`${base(addonId)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' });
  return body.addon;
}

// AN ACTION MAY DO SLOW WORK (a vision model describing a photo, a contact
// sheet being composed), and the dashboard's default 8s budget would report a
// write that succeeded server-side as a failure, inviting a retry that
// duplicates it. Aborting the fetch does not undo the write, so actions get
// the same 60s an upload gets.
const ACTION_TIMEOUT_MS = 60_000;

/** Run one action. Rejects with ApiError (status, code, message) on a refusal. */
export async function runAddonAction<T = any>(
  addonId: string,
  action: string,
  args: Record<string, unknown> = {},
  options: { timeoutMs?: number } = {},
): Promise<AddonActionResult<T>> {
  const body = await requestApi<Partial<AddonActionResult<T>>>(`${base(addonId)}/actions/${encodeURIComponent(action)}`, {
    method: 'POST',
    body: JSON.stringify({ args }),
    timeoutMs: options.timeoutMs ?? ACTION_TIMEOUT_MS,
  });
  return {
    text: typeof body?.text === 'string' ? body.text : '',
    data: (body?.data ?? null) as T | null,
    images: Array.isArray(body?.images) ? body.images : [],
  };
}

/** Upload one image into a collection, optionally attached to a record. */
export async function uploadAddonAttachment(
  addonId: string,
  file: File | Blob,
  opts: { collection: string; recordId?: string; filename?: string },
): Promise<AddonAttachment> {
  const form = new FormData();
  form.append('collection', opts.collection);
  if (opts.recordId) form.append('record_id', opts.recordId);
  const filename = opts.filename || (typeof File !== 'undefined' && file instanceof File ? file.name : 'upload');
  form.append('file', file, filename);
  const res = await requestApiRaw(`${base(addonId)}/attachments`, { method: 'POST', body: form });
  const body = await res.json();
  return body.attachment as AddonAttachment;
}

export async function deleteAddonAttachment(addonId: string, attachmentId: string): Promise<void> {
  await requestApi(`${base(addonId)}/attachments/${encodeURIComponent(attachmentId)}`, { method: 'DELETE' });
  for (const variant of ['thumb', 'view', 'original'] as const) forgetUrl(addonId, attachmentId, variant);
}

// ─── Attachment URLs ─────────────────────────────────────────────────────────
//
// ASYNC on purpose. The API authenticates with the dashboard's bearer token,
// which an <img src> cannot send, so the bytes are fetched with auth and handed
// to the image as a blob: URL (the CSP's img-src already allows blob:). Cached
// for the page's lifetime so a grid that re-renders does not refetch, and
// in-flight requests are shared.

const urlCache = new Map<string, Promise<string>>();
const cacheKey = (addonId: string, attachmentId: string, variant: AddonVariant) => `${addonId}\n${attachmentId}\n${variant}`;

function forgetUrl(addonId: string, attachmentId: string, variant: AddonVariant) {
  const key = cacheKey(addonId, attachmentId, variant);
  const pending = urlCache.get(key);
  urlCache.delete(key);
  if (pending && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    pending.then((url) => URL.revokeObjectURL(url)).catch(() => {});
  }
}

export function addonAttachmentUrl(addonId: string, attachmentId: string, variant: AddonVariant = 'thumb'): Promise<string> {
  const key = cacheKey(addonId, attachmentId, variant);
  const cached = urlCache.get(key);
  if (cached) return cached;
  const pending = requestApiRaw(`${base(addonId)}/attachments/${encodeURIComponent(attachmentId)}?variant=${variant}`)
    .then((res) => res.blob())
    .then((blob) => URL.createObjectURL(blob));
  pending.catch(() => urlCache.delete(key));
  urlCache.set(key, pending);
  return pending;
}

/**
 * The files attached to one record, oldest first. recordId null lists the
 * files in the collection that are on no record yet (upload links, bulk
 * uploads), capped at 500 by the server.
 */
export async function listAddonAttachments(addonId: string, collection: string, recordId: string | null): Promise<AddonAttachment[]> {
  const qs = new URLSearchParams({ collection, ...(recordId ? { record_id: recordId } : {}) });
  const body = await requestApi<{ attachments: AddonAttachment[] }>(`${base(addonId)}/attachments?${qs}`);
  return Array.isArray(body?.attachments) ? body.attachments : [];
}
