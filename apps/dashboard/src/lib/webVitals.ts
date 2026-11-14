import type { NextWebVitalsMetric } from 'next/app';
import { phCapture } from './posthog';

/**
 * First-party Core Web Vitals reporter for the dashboard.
 *
 * The dashboard reports ~zero web vitals to PostHog today, so its perceived-perf
 * targets are unmeasurable. Next measures web vitals itself and calls
 * reportWebVitals() as each finalizes — independent of PostHog's (idle-gated)
 * init. We buffer metrics that arrive early and flush as soon as a capture
 * succeeds, retrying on a short timer and on page-hide. Emitted as `web_vital`
 * (distinct from PostHog's auto `$web_vitals`) with app:'dashboard' so the same
 * insight can slice marketing vs dashboard.
 */
const TRACKED = new Set(['FCP', 'LCP', 'CLS', 'FID', 'INP', 'TTFB']);
const MAX_RETRIES = 20;

type Pending = { name: string; value: number; id: string; path: string };

const pending: Pending[] = [];
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retries = 0;
let hideBound = false;

function tryFlush(): void {
  for (let i = pending.length - 1; i >= 0; i--) {
    const m = pending[i];
    const sent = phCapture('web_vital', {
      app: 'dashboard',
      metric: m.name,
      value: m.value,
      metric_id: m.id,
      path: m.path,
    });
    if (sent) pending.splice(i, 1);
  }
  if (pending.length && !retryTimer && retries < MAX_RETRIES) {
    retries += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      tryFlush();
    }, 1000);
  }
}

export function reportWebVital(metric: NextWebVitalsMetric): void {
  if (typeof window === 'undefined' || !TRACKED.has(metric.name)) return;
  pending.push({ name: metric.name, value: metric.value, id: metric.id, path: window.location.pathname });

  if (!hideBound) {
    hideBound = true;
    window.addEventListener('pagehide', tryFlush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') tryFlush();
    });
  }

  tryFlush();
}
