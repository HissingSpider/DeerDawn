import { useCallback, useEffect, useRef } from 'react';
import { trackProductEvent } from '@/lib/productAnalytics';
import { getDeviceType } from '@/lib/device';

/**
 * Answers "did they leave because they didn't want it, or because they never saw
 * the thing to click?"
 *
 * The onboarding connect step went silent on 2026-07-26 — `onboarding_step_completed`
 * has not fired for any user since. The events we had could only say "they arrived
 * and did not advance". They could not distinguish a user who read the whole page
 * and gave up from one who never scrolled far enough to see the button, which are
 * opposite problems with opposite fixes. Measured on an iPhone 13, the primary
 * action really was at y=680 on a 664px viewport, so the second explanation was not
 * hypothetical.
 *
 * Emits ONE summary event when the user leaves, rather than a stream of scroll
 * milestones. At ~1.7 signups/day a milestone stream is unreadable noise; a single
 * row per visit with the full picture is something you can actually scan.
 *
 * Usage:
 *   const { primaryCtaRef, markResolved } = useStepDiagnostics({
 *     event: 'connect_step_exited', path: '/onboarding', enabled: phase === 'connect',
 *   });
 *   <a ref={primaryCtaRef} ...>            // the action that matters
 *   onContinue={() => { markResolved('continued'); ... }}
 */
export function useStepDiagnostics({
  event,
  path,
  enabled = true,
  metadata,
}: {
  event: string;
  path: string;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
}) {
  // Stamped in the effect, not here: Date.now() during render is impure and
  // would drift on re-render (react-hooks/purity).
  const startedAt = useRef<number>(0);
  const maxScrollPct = useRef(0);
  const ctaSeen = useRef(false);
  const msToCtaSeen = useRef<number | null>(null);
  const resolution = useRef<string | null>(null);
  // Guards double-emit: pagehide and unmount can both fire for one departure.
  const emitted = useRef(false);
  const ctaEl = useRef<HTMLElement | null>(null);
  // Latched: ctaEl is null again by the time the unmount emit runs, so it can't
  // answer "did the CTA ever exist?" — and that is the question that separates a
  // real 'never saw it' from an instrumentation hole.
  const ctaEverMounted = useRef(false);
  const ctaObserver = useRef<IntersectionObserver | null>(null);
  // Read in the emit path, which is a stale closure by then (pagehide listeners
  // are registered once), so the latest values have to be reachable via refs.
  // Synced in an effect with no dep array — writing a ref during render trips
  // react-hooks/refs, and this runs after every render, which is what we want.
  const latest = useRef({ event, path, enabled, metadata });
  useEffect(() => {
    latest.current = { event, path, enabled, metadata };
  });

  /** Records how the step ended. Call before navigating away. */
  const markResolved = useCallback((how: string) => {
    resolution.current = how;
  }, []);

  /**
   * Attach to the primary action to learn whether it was ever on screen.
   *
   * The observer is created HERE, in the ref callback, not in the mount effect.
   * It used to live in the effect below, whose only dep is `enabled` — so it ran
   * once, on mount, and read `ctaEl.current`. On the onboarding connect step the
   * CTA is inside an `isMobile &&` branch, and `useIsMobile` is false on the
   * server and on the first client render, flipping true only in its own effect.
   * The node therefore attached one commit AFTER the observer was built, the
   * effect never re-ran, and no observer was ever pointed at anything.
   *
   * `primary_cta_seen` consequently reported `false` for 15 of 15 connect-step
   * exits over the 21 days to 2026-08-11 — including mobile visitors whose
   * max_scroll_pct was 100. That is a constant, not a measurement, and reading
   * it as "nobody saw the button" would have sent a patch at the wrong problem.
   * Re-attaching per node also means a ref that moves between breakpoints (as
   * this one does) keeps working.
   */
  const primaryCtaRef = useCallback((node: HTMLElement | null) => {
    ctaObserver.current?.disconnect();
    ctaObserver.current = null;
    ctaEl.current = node;
    if (!node) return;
    ctaEverMounted.current = true;
    if (ctaSeen.current || typeof IntersectionObserver === 'undefined') return;

    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || ctaSeen.current) continue;
          ctaSeen.current = true;
          // startedAt is 0 until the mount effect stamps it. Ref callbacks run
          // during commit, before effects, but observer callbacks are always
          // delivered later — so this is normally set. Guard anyway rather than
          // reporting a 57-year "time to CTA".
          msToCtaSeen.current = startedAt.current > 0 ? Date.now() - startedAt.current : null;
          obs.disconnect();
          ctaObserver.current = null;
        }
      },
      // Require half the element on screen: a 1px sliver clipped by the fold is
      // not "seen", and counting it would reproduce the blind spot this hook
      // exists to remove.
      { threshold: 0.5 },
    );
    obs.observe(node);
    ctaObserver.current = obs;
  }, []);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    startedAt.current = Date.now();

    const readScroll = () => {
      const doc = document.documentElement;
      const scrollable = doc.scrollHeight - window.innerHeight;
      // A page shorter than the viewport is fully seen by definition; without
      // this it would report 0% and read as "never scrolled".
      const pct = scrollable <= 0 ? 100 : Math.round((window.scrollY / scrollable) * 100);
      const clamped = Math.max(0, Math.min(100, pct));
      if (clamped > maxScrollPct.current) maxScrollPct.current = clamped;
    };
    readScroll();
    window.addEventListener('scroll', readScroll, { passive: true });

    const emit = () => {
      if (emitted.current) return;
      const cur = latest.current;
      if (!cur.enabled) return;
      emitted.current = true;
      trackProductEvent(cur.event, {
        source: 'dashboard',
        path: cur.path,
        duration_ms: Date.now() - startedAt.current,
        metadata: {
          ...cur.metadata,
          device_type: getDeviceType(),
          max_scroll_pct: maxScrollPct.current,
          primary_cta_seen: ctaSeen.current,
          ms_to_primary_cta_seen: msToCtaSeen.current ?? undefined,
          // Disambiguates a false `primary_cta_seen`: false here means the CTA
          // never rendered for this visitor (a layout/branching problem), true
          // means it rendered and stayed off screen (a scroll/placement one).
          primary_cta_mounted: ctaEverMounted.current,
          // 'abandoned' when the user left without any recorded action — the
          // case the old instrumentation collapsed into silence.
          resolution: resolution.current ?? 'abandoned',
          viewport_h: window.innerHeight,
        },
      });
    };

    // pagehide, not beforeunload: it fires on mobile Safari tab switches and
    // back/forward-cache navigations, where beforeunload does not — and mobile
    // is where the drop-off is. trackProductEvent posts with keepalive.
    window.addEventListener('pagehide', emit);

    return () => {
      window.removeEventListener('scroll', readScroll);
      window.removeEventListener('pagehide', emit);
      ctaObserver.current?.disconnect();
      ctaObserver.current = null;
      // Unmount is the in-app departure (advancing a step, client-side route
      // change). pagehide covers closing the tab. The emitted guard means
      // whichever happens first wins and the other is a no-op.
      emit();
    };
  }, [enabled]);

  return { primaryCtaRef, markResolved };
}
