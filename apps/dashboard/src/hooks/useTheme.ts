import { useCallback, useEffect, useSyncExternalStore } from 'react';

/**
 * Device-driven light/dark theming with an optional manual override.
 *
 * Preference is one of 'system' | 'light' | 'dark', persisted in localStorage
 * under 'deerdawn-theme' ('system' clears the key). The resolved theme is
 * reflected onto <html data-theme> and the <meta name="theme-color"> browser
 * bar. This mirrors the pre-paint /theme-init.js exactly, so the first paint and
 * every runtime toggle agree — no flash.
 *
 * State is read via useSyncExternalStore (localStorage + the OS color-scheme
 * media query are the external stores), which is SSR-safe and avoids a
 * setState-in-effect: the server render uses the 'system'/'dark' default that
 * theme-init.js already applied, then the client swaps to the real value.
 */
export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'deerdawn-theme';
const CHANGE_EVENT = 'deerdawn-theme-change';
// Keep in sync with --theme-color-bar in globals.css and /theme-init.js.
const THEME_COLORS: Record<ResolvedTheme, string> = { dark: '#07111d', light: '#f7f9fc' };

function readPreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    /* localStorage may be unavailable (private mode) — fall back to system */
  }
  return 'system';
}

function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolve(pref: ThemePreference): ResolvedTheme {
  return pref === 'system' ? systemTheme() : pref;
}

// Subscribe to every input that can change the resolved theme: cross-tab
// localStorage writes, our own setPreference dispatch, and OS scheme flips.
function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('storage', onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  mq?.addEventListener('change', onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
    mq?.removeEventListener('change', onChange);
  };
}

// Reflect the resolved theme onto <html> + the browser-chrome meta. A pure DOM
// side-effect (no React state), so it's safe to run from an effect.
function reflect(pref: ThemePreference): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (pref === 'light' || pref === 'dark') {
    root.setAttribute('data-theme', pref);
  } else {
    root.removeAttribute('data-theme');
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[resolve(pref)]);
}

export function useTheme() {
  const preference = useSyncExternalStore(subscribe, readPreference, (): ThemePreference => 'system');
  const resolved = useSyncExternalStore(
    subscribe,
    () => resolve(readPreference()),
    () => 'dark' as ResolvedTheme,
  );

  // Keep <html data-theme> + the browser bar in sync with the resolved theme,
  // including when the OS flips while in system mode. DOM side-effect only.
  useEffect(() => {
    reflect(preference);
  }, [preference, resolved]);

  const setPreference = useCallback((pref: ThemePreference) => {
    try {
      if (pref === 'system') window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, pref);
    } catch {
      /* ignore persistence failures — the in-memory choice still applies */
    }
    reflect(pref);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return { preference, resolved, setPreference };
}
