/**
 * Best-effort device classification for analytics slicing.
 *
 * Activation depends on device: a phone can't set up Cursor / Claude Code, so we
 * need every signup + funnel event to carry device_type to see (and later fix)
 * the mobile-activation gap. SSR-safe — returns undefined on the server so it can
 * be called unconditionally.
 */

export type DeviceType = 'mobile' | 'tablet' | 'desktop';

export function getDeviceType(): DeviceType | undefined {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return undefined;
  const ua = navigator.userAgent || '';
  // Tablets first — an Android tablet UA lacks "Mobile" but still matches Android.
  if (/iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/i.test(ua)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android.*Mobile|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return 'mobile';
  // UA inconclusive (e.g. desktop-mode requests) — fall back to viewport width.
  if (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 767px)').matches) return 'mobile';
  return 'desktop';
}
