import * as Sentry from '@sentry/nextjs';

/**
 * Browser error tracking for the dashboard.
 *
 * REPLAY. Sentry's replay REPLACES PostHog's here (lib/posthog.ts now sets
 * disable_session_recording: true). PostHog was recording 100% of dashboard
 * sessions unsampled, and `maskAllInputs` masks form fields but NOT rendered
 * text — so decrypted project briefs were going into recordings. This records
 * far less and masks far more:
 *
 *   - replaysSessionSampleRate 0  — nothing is recorded speculatively; the
 *     buffer only lives in memory and is discarded unless an error fires.
 *   - replaysOnErrorSampleRate 1  — every error gets the 60s that preceded it.
 *   - maskAllText + blockAllMedia — brief content, project names and memory
 *     bodies are redacted in the recording itself, not just in the UI.
 *
 * Replays are metered separately from errors on the Sentry plan, so the 0/1
 * split is also what keeps this inside a small quota.
 *
 * NO TRACING. tracesSampleRate is deliberately unset (not 0) — that is what
 * disables the tracing machinery rather than merely sampling none of it. The
 * API owns tracing via OpenTelemetry.
 *
 * The build asks for an `onRouterTransitionStart` export. It is not added,
 * here or on marketing: it instruments navigation SPANS, and with tracing off
 * there are no transactions for it to start. Keeping both apps identical on
 * this matters — on marketing the hook would force a static SDK import and
 * cost 55 KB of first-load JS, so 'fixing' the warning in one app invites
 * someone to fix it in the other.
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  // Without a DSN the SDK still installs global handlers and does work per
  // error. Local dev and preview builds have no DSN, so switch it off outright.
  enabled: Boolean(dsn),
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
  integrations: [
    Sentry.replayIntegration({
      maskAllText: true,
      maskAllInputs: true,
      blockAllMedia: true,
    }),
  ],
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1.0,
});
