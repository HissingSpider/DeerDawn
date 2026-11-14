/**
 * Reddit Pixel (rdt) helper for the dashboard.
 *
 * The base pixel loader + init + PageVisit are served same-origin from
 * /rdt-init.js (see pages/rdt-init.js.ts) and injected in _document, gated on
 * NEXT_PUBLIC_REDDIT_PIXEL_ID — a no-op until the id is set, exactly like the
 * Google tags. This module fires the one-off SignUp conversion at signup.
 *
 * The pixel is best-effort (ad-blockers + the signup redirect can drop it); the
 * server-side Conversions API (apps/api services/reddit.js, fired from the
 * account_created webhook) is the authoritative signal. Both carry the same
 * conversionId (the Clerk user id) so Reddit dedupes them into one conversion.
 */

export const REDDIT_PIXEL_ID = process.env.NEXT_PUBLIC_REDDIT_PIXEL_ID || '';

declare global {
  interface Window {
    rdt?: (...args: unknown[]) => void;
  }
}

type RedditEventMeta = { conversionId?: string; email?: string; currency?: string; value?: number };

/** Fire a Reddit standard conversion event. No-ops until the pixel has loaded. */
export function rdtTrack(event: string, meta: RedditEventMeta = {}) {
  if (typeof window === 'undefined') return;
  if (!REDDIT_PIXEL_ID || typeof window.rdt !== 'function') return;
  const payload: Record<string, unknown> = {};
  if (meta.conversionId) payload.conversionId = meta.conversionId;
  if (meta.email) payload.email = meta.email;
  if (meta.currency) payload.currency = meta.currency;
  if (typeof meta.value === 'number') payload.value = meta.value;
  window.rdt('track', event, payload);
}

/**
 * Fire the Reddit sign-up conversion. Pass the new account's Clerk user id as
 * conversionId so it matches the server-side CAPI event and Reddit dedupes the
 * pixel + CAPI signals.
 */
export function trackRedditSignup(conversionId?: string) {
  rdtTrack('SignUp', { conversionId });
}
