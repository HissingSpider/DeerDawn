import { useEffect } from 'react';

/**
 * Lets a page that renders OUTSIDE the dashboard shell scroll normally.
 *
 * globals.css pins html/body/#__next to `height: 100%; overflow: hidden` so the
 * shell can be a fixed-height app layout with internally-scrolling panes. Pages
 * rendered standalone inherit that and have nothing scrolling internally, so any
 * content past the fold is unreachable — not merely awkward: at 1280x720 the
 * connect step's primary button sat at y=959 with maxScroll 0 and could not be
 * clicked at all.
 *
 * Adds `.page-scroll` to <html> for the lifetime of the page and removes it on
 * unmount, so navigating back into the shell restores the fixed layout. Safe to
 * mount in several components at once — it counts holders rather than assuming
 * a single owner, so an inner component unmounting cannot strip scrolling from
 * an outer one still relying on it.
 */
const CLASS = 'page-scroll';
const COUNTER = '__ddPageScrollHolders';

export function usePageScroll(enabled = true) {
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return;

    const root = document.documentElement;
    const w = window as unknown as Record<string, number>;
    w[COUNTER] = (w[COUNTER] || 0) + 1;
    root.classList.add(CLASS);

    return () => {
      w[COUNTER] = Math.max(0, (w[COUNTER] || 1) - 1);
      if (w[COUNTER] === 0) root.classList.remove(CLASS);
    };
  }, [enabled]);
}
