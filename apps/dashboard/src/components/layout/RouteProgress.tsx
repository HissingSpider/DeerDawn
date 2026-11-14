import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';

/**
 * App-level route-transition indicator (top progress bar).
 *
 * Bound to Next router events so navigation that triggers a destination fetch
 * shows motion immediately instead of feeling dead until the next page paints.
 * The bar appears synchronously on routeChangeStart (well under the ~120ms
 * "instant" threshold), trickles toward 90% while the route resolves, then snaps
 * to 100% and fades on complete/error. Respects prefers-reduced-motion.
 */
export function RouteProgress() {
  const router = useRouter();
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const trickle = useRef<ReturnType<typeof setInterval> | null>(null);
  const hide = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const onChange = () => setReducedMotion(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const clearTimers = () => {
      if (trickle.current) { clearInterval(trickle.current); trickle.current = null; }
      if (hide.current) { clearTimeout(hide.current); hide.current = null; }
    };

    const start = () => {
      clearTimers();
      setVisible(true);
      setProgress(8);
      trickle.current = setInterval(() => {
        // Ease toward 90% so long fetches keep showing forward motion.
        setProgress((p) => (p < 90 ? p + (90 - p) * 0.12 : p));
      }, 200);
    };

    const done = () => {
      clearTimers();
      setProgress(100);
      hide.current = setTimeout(() => {
        setVisible(false);
        setProgress(0);
      }, 280);
    };

    router.events.on('routeChangeStart', start);
    router.events.on('routeChangeComplete', done);
    router.events.on('routeChangeError', done);
    return () => {
      router.events.off('routeChangeStart', start);
      router.events.off('routeChangeComplete', done);
      router.events.off('routeChangeError', done);
      clearTimers();
    };
  }, [router.events]);

  if (!visible && progress === 0) return null;

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: 2,
        zIndex: 100,
        pointerEvents: 'none',
        opacity: visible ? 1 : 0,
        transition: reducedMotion ? 'none' : 'opacity 200ms ease',
      }}
    >
      <div
        style={{
          height: '100%',
          width: `${progress}%`,
          background: 'var(--primary)',
          boxShadow: '0 0 8px rgba(16,185,129,0.5)',
          transition: reducedMotion ? 'none' : 'width 200ms ease-out',
        }}
      />
    </div>
  );
}
