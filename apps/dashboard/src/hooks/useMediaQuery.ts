import { useCallback, useSyncExternalStore } from 'react';

const MOBILE_QUERY = '(max-width: 767px)';
const TABLET_QUERY = '(min-width: 768px) and (max-width: 1023px)';
const DESKTOP_QUERY = '(min-width: 1024px)';

// Absent during SSR, and absent in jsdom unless a test installs it. Both callers
// below treat "no matchMedia" as "does not match" rather than throwing.
const getMediaQueryList = (query: string): MediaQueryList | null =>
  typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? null
    : window.matchMedia(query);

/**
 * Read a media query NOW, outside of React's render cycle.
 *
 * `useMediaQuery` cannot answer this question during the first render — the
 * server has no viewport, so the first client render has to agree with the
 * server's "false" or hydration mismatches. That is correct for rendering and
 * wrong for anything that reads the value from a closure: an effect with a `[]`
 * dep array captures the first render's `false` and keeps it forever, no matter
 * how long the effect waits before using it. Awaiting a promise does not help —
 * the re-render produces a *new* closure, and the old one still holds the stale
 * value.
 *
 * That is exactly how the onboarding flow pinned every phone user to the desktop
 * step ordering for the whole life of the feature (see the phase-pinning effect
 * in pages/onboarding.tsx). Inside an effect, an event handler, or a callback,
 * call this instead of closing over the hook's return value.
 *
 * Not reactive: it is a point-in-time read and will not re-render anything.
 */
export const matchesMediaQuery = (query: string): boolean =>
  getMediaQueryList(query)?.matches ?? false;

/**
 * Hook to detect media query matches.
 *
 * @example
 * const isMobile = useMediaQuery('(max-width: 768px)')
 */
export const useMediaQuery = (query: string): boolean => {
  const subscribe = useCallback((onStoreChange: () => void) => {
    const mediaQuery = getMediaQueryList(query);
    if (!mediaQuery) return () => {};
    mediaQuery.addEventListener('change', onStoreChange);
    return () => mediaQuery.removeEventListener('change', onStoreChange);
  }, [query]);

  // The server snapshot is a flat `false`, so the hydration render stays
  // byte-identical to the SSR markup and consumers that branch their JSX on this
  // (TopNav, ContextNetwork) do not mismatch. React then reconciles against the
  // client snapshot as part of finishing hydration, rather than waiting for a
  // passive effect to call setState — which is what the previous
  // useState(false) + useEffect version did.
  return useSyncExternalStore(
    subscribe,
    () => matchesMediaQuery(query),
    () => false,
  );
};

// Common breakpoint helpers
export const useIsMobile = () => useMediaQuery(MOBILE_QUERY);
export const useIsTablet = () => useMediaQuery(TABLET_QUERY);
export const useIsDesktop = () => useMediaQuery(DESKTOP_QUERY);

/** Non-reactive counterpart to `useIsMobile`. See `matchesMediaQuery`. */
export const isMobileNow = () => matchesMediaQuery(MOBILE_QUERY);
