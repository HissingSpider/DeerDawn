import type { PostHog } from 'posthog-js';
import { getDeviceType } from '@/lib/device';
import { isSyntheticAgent } from '@/lib/syntheticAgent';
import { clientTelemetryAllowed } from '@/lib/telemetryGate';

/**
 * PostHog (product analytics) bootstrap for the dashboard app.
 *
 * posthog-js is loaded with a dynamic import() inside initPostHog() so its
 * runtime leaves the shared first-load chunk; _app idle-gates the init. Web
 * vitals are captured independently by reportWebVitals (see lib/webVitals.ts).
 *
 * Unlike marketing, session replay + heatmaps stay ON here: this is the authed
 * app where LCP is not the conversion bottleneck and replay aids funnel/debug.
 *
 * Everything is gated on NEXT_PUBLIC_POSTHOG_KEY, so this is a no-op until the
 * key is set — it ships dormant, exactly like the Google tags. The dashboard
 * DOES set a CSP — a static one in next.config.ts, unlike marketing's
 * per-request one in middleware.ts; PostHog's script/connect hosts
 * (*.posthog.com) are already allowlisted there, so no additional allowlisting
 * is required here.
 */
let started = false;
let instance: PostHog | null = null;

const SOURCE_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'campaign',
  'referral_code',
] as const;

/** Read marketing-source params off the current URL. */
function readSourceParams(): Record<string, string> {
  const out: Record<string, string> = {};
  const p = new URLSearchParams(window.location.search);
  for (const k of SOURCE_PARAMS) {
    const v = p.get(k);
    if (v) out[k] = v;
  }
  return out;
}

/**
 * Stamp traffic-source attribution onto every event so the entire autocapture
 * firehose is sliceable by where the user came from. First-touch values are set
 * once per person (register_once); last-touch updates whenever params reappear.
 */
function registerSourceProperties(): void {
  if (!instance) return;
  const src = readSourceParams();
  const device = getDeviceType();
  instance.register_once({
    initial_referrer: document.referrer || '$direct',
    initial_landing_path: window.location.pathname,
    ...(device ? { initial_device_type: device } : {}),
    ...Object.fromEntries(Object.entries(src).map(([k, v]) => [`initial_${k}`, v])),
  });
  // device_type as a super-property so autocapture + custom events are all
  // sliceable mobile-vs-desktop, matching the server-side account_created tag.
  instance.register({ ...src, ...(device ? { device_type: device } : {}) });
}

/**
 * Lazily load + initialize PostHog. Idempotent and safe to call before the SDK
 * has finished loading (concurrent calls no-op after the first).
 */
export async function initPostHog(): Promise<void> {
  if (started || typeof window === 'undefined') return;
  // Self-hosted builds send nothing unless TELEMETRY_ENABLED=true. Checked here
  // as well as at the call site so no other caller can switch it on by accident.
  if (!clientTelemetryAllowed()) {
    started = true;
    return;
  }
  // Automation must not enter the funnel. Marketing has gated this since
  // 2026-08-12; the dashboard never did, so every nightly journey E2E run has
  // been a dashboard "visitor" with a session replay, on the exact surfaces the
  // activation push is measured on. Mark started so the idle gate does not
  // retry, and leave `instance` null — phCapture/phPageview no-op from here.
  if (isSyntheticAgent()) {
    started = true;
    return;
  }
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return;
  started = true;
  const mod = await import('posthog-js');
  instance = mod.default;
  instance.init(key, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
    person_profiles: 'identified_only',
    // Honor the browser Do Not Track signal — delivers on the privacy policy's
    // "you can limit or block these tools through your browser settings" promise
    // (no banner/feature added). DNT users are not captured.
    respect_dnt: true,
    autocapture: true,
    // Pages Router is an SPA — capture pageviews manually on route change.
    capture_pageview: false,
    capture_pageleave: true,
    // Session replay OFF here — Sentry owns dashboard replay as of 2026-09-01
    // (src/instrumentation-client.ts). Two reasons it moved, both about this
    // app specifically rather than about Sentry being nicer:
    //
    //   1. PRIVACY. This recorded 100% of sessions and `maskAllInputs` masks
    //      form fields but NOT rendered text, so decrypted project briefs —
    //      the actual private content of the product — were inside the
    //      recordings. Sentry's config masks all text, not just inputs.
    //   2. VOLUME. Every session was recorded whether or not anything went
    //      wrong. Sentry buffers in memory and only uploads when an error
    //      fires, which is when a recording is worth having.
    //
    // Marketing still records via PostHog and should keep doing so: replay
    // there is sampled, tuned to stay off the LCP path, and feeds the growth
    // funnel work rather than debugging.
    disable_session_recording: true,
    enable_heatmaps: true,
    // Exceptions go to Sentry now. Leaving this on would double-report every
    // browser error into two vendors and split the issue history across both.
    capture_exceptions: false,
    // Web vitals (LCP/CLS/INP/FCP) — reportWebVitals is the idle-safe path.
    capture_performance: true,
  });
  registerSourceProperties();
}

/** Capture a SPA pageview. No-op until PostHog is initialized. */
export function phPageview(): void {
  if (typeof window === 'undefined' || !instance) return;
  instance.capture('$pageview');
}

/**
 * Capture a custom event through the SDK. Returns false if PostHog isn't
 * initialized yet, so callers (e.g. the buffered web-vitals reporter) can retry.
 */
export function phCapture(event: string, props: Record<string, unknown> = {}): boolean {
  if (typeof window === 'undefined' || !instance) return false;
  instance.capture(event, props);
  return true;
}

/**
 * Tie the current session to a known user. No-op until initialized.
 *
 * `setOnceProps` become `$set_once` person properties — written only if the
 * person does not already have them, so a value the authoritative server-side
 * webhook already supplied always wins.
 *
 * Why this exists: `account_created` is emitted server-side from the Clerk
 * user.created webhook, which never sees the browser. Device + attribution are
 * threaded to it through Clerk `unsafeMetadata` at signup — but `unsafeMetadata`
 * is a *SignUp* parameter. `SignIn.authenticateWithRedirect` silently drops it,
 * and Clerk's sign-in -> sign-up transfer (what happens when someone clicks
 * "Continue with Google" on the login tab without an account yet) does not carry
 * it across. Measured 2026-08-23 over 45 days: of 48 real accounts, 10 — every
 * one of them `signup_method='google'`, i.e. 10 of 19 Google signups — arrived
 * with no device_type, no utm_source and no person-level initial_device_type at
 * all. That is 21% of all signups invisible to the mobile-vs-desktop question,
 * which is the open ad-bidding decision (71% of attributable accounts are
 * mobile, measured off the other 79%).
 *
 * `register_once` in registerSourceProperties() does NOT cover this: it sets
 * super-properties on browser-sent events, not person properties, and
 * account_created is not browser-sent.
 */
export function phIdentify(
  distinctId: string,
  props?: Record<string, unknown>,
  setOnceProps?: Record<string, unknown>,
): void {
  if (typeof window === 'undefined' || !instance || !distinctId) return;
  instance.identify(distinctId, props, setOnceProps);
}

/**
 * PostHog's OWN session id for the current browser session — the key a session
 * replay is filed under. Not to be confused with DeerDawn's
 * `dd_product_session_id` (productAnalytics.ts), which is our localStorage
 * funnel id and means nothing to PostHog.
 *
 * Why it is exported: the whole activation funnel — onboarding_page_viewed,
 * mcp_setup_viewed, mcp_config_copied, oauth_consent_viewed/approved,
 * connection_established, first_sync_completed — is relayed through the API
 * with posthog-node, so those events carry no `$session_id` and cannot be
 * opened as a replay. Session replay is ON in this app (see initPostHog), so
 * the recordings exist; there was simply no key joining them to the funnel.
 *
 * Measured 2026-08-25 over 21 days, real users only (person.is_test = false):
 * 13 people copied a connector config and 3 reached the consent screen. The
 * ten who did not are the largest activation leak on the board, and every one
 * of them was undiagnosable because their events had no replay to open.
 *
 * Returns undefined before init, when DNT has suppressed capture, or on an SDK
 * without the getter — every caller must treat it as optional.
 */
export function phSessionId(): string | undefined {
  if (typeof window === 'undefined' || !instance) return undefined;
  try {
    const id = typeof instance.get_session_id === 'function' ? instance.get_session_id() : undefined;
    return typeof id === 'string' && id ? id : undefined;
  } catch {
    return undefined;
  }
}
