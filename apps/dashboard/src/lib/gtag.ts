/**
 * Google Ads (gtag) helper for the dashboard app.
 *
 * The gtag.js loader + base config live in `_document.tsx`, driven by
 * GOOGLE_ADS_ID below, read ONLY from NEXT_PUBLIC_GOOGLE_ADS_ID. It used to
 * default to the live DeerDawn Ads account id so the tag shipped without
 * configuration, which also meant every self-hosted build beaconed to
 * DeerDawn's Ads account. Hosted sets the variable; nothing else gets a tag.
 * Conversion labels are supplied per-action via env — when a label is blank,
 * that conversion call is a no-op. The dashboard ships a strict CSP; the
 * Google Ads / GA4 hosts are allowlisted in `next.config.ts` and the gtag
 * bootstrap is served same-origin from `/gtag-init.js` (see commit history),
 * which is what lets these calls reach Google.
 */

export const GOOGLE_ADS_ID = process.env.NEXT_PUBLIC_GOOGLE_ADS_ID || '';

/**
 * GA4 measurement id (`G-XXXXXXX`). GA4 shares the same gtag.js loader as Google
 * Ads — the loader + per-id config live in `_document.tsx`, gated on this value.
 * Blank until a GA4 property exists, so every GA4 call here is a no-op.
 */
export const GA4_ID = process.env.NEXT_PUBLIC_GA4_ID || '';

type GtagParams = {
  value?: number;
  currency?: string;
  transaction_id?: string;
};

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    dataLayer?: unknown[];
  }
}

/**
 * Fire a Google Ads conversion. `label` is the per-action conversion label
 * (the part after the slash in `AW-XXXX/label`). No-ops when the Ads id or
 * label is missing, when gtag has not loaded, or when the signed-in account is
 * a synthetic journey/E2E account.
 *
 * The test-account guard lives HERE, at the one place every conversion passes
 * through, rather than at each caller. Connect Attempted shipped with its own
 * guard; sign-up and purchase did not, so the nightly journey run could report
 * itself as a conversion. Guarding per-caller means the next conversion action
 * added starts out unprotected by default, and the failure is silent — a
 * polluted conversion count looks like good news, not a bug.
 */
export function fireConversion(label: string | undefined, params: GtagParams = {}) {
  if (typeof window === 'undefined') return;
  if (!GOOGLE_ADS_ID || !label || typeof window.gtag !== 'function') return;
  if (isTestAccount()) return;
  window.gtag('event', 'conversion', {
    send_to: `${GOOGLE_ADS_ID}/${label}`,
    currency: params.currency || 'USD',
    ...params,
  });
}

/**
 * Send a GA4 page_view for client-side (SPA) route changes. GA4's initial
 * config emits the first page_view automatically; Pages Router navigations do
 * not reload the page, so each subsequent route must be reported manually.
 * No-ops until the GA4 id is set and gtag has loaded.
 */
export function gaPageview(path: string) {
  if (typeof window === 'undefined') return;
  if (!GA4_ID || typeof window.gtag !== 'function') return;
  window.gtag('event', 'page_view', {
    page_path: path,
    page_location: window.location.href,
    send_to: GA4_ID,
  });
}

/**
 * Send a custom GA4 event for funnel analysis (e.g. checkout_started →
 * purchase_completed, first_sync_completed). Distinct from fireConversion,
 * which reports Google Ads conversions. No-ops until the GA4 id is set and gtag
 * has loaded.
 */
export function gaEvent(
  name: string,
  params: Record<string, string | number | boolean | undefined> = {},
) {
  if (typeof window === 'undefined') return;
  if (!GA4_ID || typeof window.gtag !== 'function') return;
  window.gtag('event', name, { ...params, send_to: GA4_ID });
}

/**
 * Enhanced conversions: hand Google first-party identifiers (email) so it can
 * attribute conversions even when the ad-click cookie is missing. gtag hashes
 * the value with SHA-256 before it leaves the browser. Set this once the signed-in
 * user is known so later purchase / first_sync conversions carry it. No-ops
 * without the Ads id / an email.
 */
export function setEnhancedConversionData(data: { email?: string | null }) {
  if (typeof window === 'undefined') return;
  if (!GOOGLE_ADS_ID || typeof window.gtag !== 'function') return;
  const email = data.email?.trim().toLowerCase();
  if (!email) return;
  window.gtag('set', 'user_data', { email });
}

export const GADS_LABELS = {
  purchase: process.env.NEXT_PUBLIC_GADS_PURCHASE_LABEL || '',
  // "DeerDawn - First Sync Completed" (Begin checkout category, SECONDARY,
  // value $5, count One). Secondary on purpose: first sync is what we actually
  // care about, but it happens ~6 times a month across all traffic — far below
  // the 30-in-30-days Smart Bidding needs — so bidding on it would starve
  // delivery. It reports in "All conversions" and carries a value 5x Connect
  // Attempted, which is how a later Maximize Conversion Value strategy learns
  // that a sync is worth five connect attempts without ever needing 30 of them.
  firstSync: process.env.NEXT_PUBLIC_GADS_FIRST_SYNC_LABEL || '',
  // The "Sign-up" conversion action's label. Like every label here it has no
  // built-in default: hosted sets it, a self-hosted build fires nothing.
  signup: process.env.NEXT_PUBLIC_GADS_SIGNUP_LABEL || '',
  // "DeerDawn - Connect Attempted" (Begin checkout category, primary, value $1,
  // count One). Deliberately NOT in an account-default goal group, so turning it
  // on cannot disturb bidding on any existing campaign.
  connectAttempted:
    process.env.NEXT_PUBLIC_GADS_CONNECT_ATTEMPTED_LABEL || '',
};

// Sign-up is the wrong thing to bid on: over the 45 days to 2026-08-26, 30 paid
// signups produced ZERO users with an MCP session. Connect Attempted sits one
// step from a live connection instead of three, and is the closest event to real
// value that still has enough volume for Google to learn from — the two connect
// paths (config file, remote OAuth) are almost entirely different people, so
// counting them as one action nearly doubles the signal rather than
// double-counting it.
const CONNECT_ATTEMPTED_KEY = 'dd_gads_connect_attempted_v1';
const TEST_ACCOUNT_KEY = 'dd_is_test_account';

/**
 * Latch whether the signed-in account is a synthetic journey/E2E account, using
 * the same `+clerk_test` convention the Clerk webhook uses server-side to set
 * `is_test` on the PostHog person (apps/api/src/routes/auth-webhooks.js).
 *
 * This is not hygiene, it is load-bearing. The nightly journey workflow
 * (.github/workflows/journey.yml) walks the whole signup→activation path against
 * PRODUCTION and accounts for roughly 45% of the OAuth consent funnel — 15 of 31
 * oauth_consent_approved in 21 days. Without this guard, Google Ads would be
 * trained to find more traffic that looks like our own test bot.
 *
 * Persisted rather than held in memory because Google OAuth sign-up is a
 * full-page redirect, and a conversion can fire before /auth/me resolves.
 */
export function markTestAccount(email: string | null | undefined) {
  if (typeof window === 'undefined') return;
  try {
    if (/\+clerk_test/i.test(email || '')) {
      window.localStorage.setItem(TEST_ACCOUNT_KEY, '1');
    } else if (email) {
      // A real address on this browser clears a stale latch (shared dev machine).
      window.localStorage.removeItem(TEST_ACCOUNT_KEY);
    }
  } catch {
    /* private mode: fall through and treat as a real account */
  }
}

function isTestAccount(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(TEST_ACCOUNT_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Fire the Connect Attempted conversion at most once per browser. The Google Ads
 * action is already set to count One per click, so this guard is not about
 * double-counting in Ads — it is so the local funnel and the Ads number agree
 * when someone copies a config four times, which the onboarding data shows they
 * do (one person picked a setup path 6 times before exiting).
 *
 * The test-account check here is deliberately redundant with the one in
 * fireConversion: without it a journey run would burn the once-key, and a real
 * user who later signs in on that same browser would never convert.
 */
export function fireConnectAttemptedOnce() {
  if (typeof window === 'undefined') return;
  if (isTestAccount()) return;
  try {
    if (window.localStorage.getItem(CONNECT_ATTEMPTED_KEY)) return;
    // Consume up front so a re-render or a second tab cannot double-fire.
    window.localStorage.setItem(CONNECT_ATTEMPTED_KEY, String(Date.now()));
  } catch {
    /* private mode: no guard available, still worth firing once */
  }
  // value 1.0 matches the conversion action's configured value.
  fireConversion(GADS_LABELS.connectAttempted, { value: 1.0 });
}

// The sign-up conversion is fired from a central authed place (GtagIdentity in
// _app) rather than from the auth form, because Google OAuth sign-up is a
// full-page redirect that loses in-memory React state. The auth form only marks
// a signup as PENDING; the authed shell fires it once the new user is present.
const SIGNUP_PENDING_KEY = 'dd_signup_pending';
// Generous TTL: must outlast the Google OAuth round-trip plus the post-signup
// onboarding hop before the authed shell first renders.
const SIGNUP_PENDING_TTL_MS = 30 * 60 * 1000;

/**
 * Record that a sign-up just started — call on email/password signup completion
 * and on Google-OAuth signup initiation. Consumed once by
 * fireSignupConversionIfPending().
 */
export function markSignupPending() {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SIGNUP_PENDING_KEY, String(Date.now()));
}

/**
 * Fire the Google Ads sign-up conversion exactly once for a just-completed
 * signup, then clear the pending flag (the removal is the once-guard). No-ops
 * unless a fresh signup is pending. `accountCreatedAtMs` (the signed-in user's
 * createdAt) guards Clerk's unified Google flow: an existing user who clicks
 * "Continue with Google" on the signup page has an old account, so the flag is
 * dropped without counting them as a new signup. Call AFTER
 * setEnhancedConversionData so the conversion carries the hashed email.
 */
export function fireSignupConversionIfPending(
  opts: { transactionId?: string; accountCreatedAtMs?: number | null } = {},
) {
  if (typeof window === 'undefined') return;
  const startedRaw = window.localStorage.getItem(SIGNUP_PENDING_KEY);
  if (!startedRaw) return;
  // Consume the flag up front so a re-render or second tab cannot double-fire.
  window.localStorage.removeItem(SIGNUP_PENDING_KEY);

  const startedAt = Number(startedRaw);
  if (!Number.isFinite(startedAt) || Date.now() - startedAt > SIGNUP_PENDING_TTL_MS) return;

  const { accountCreatedAtMs } = opts;
  if (accountCreatedAtMs != null && Date.now() - accountCreatedAtMs > SIGNUP_PENDING_TTL_MS) return;

  // value 1.0 matches the Sign-up conversion action's configured value.
  fireConversion(GADS_LABELS.signup, {
    value: 1.0,
    ...(opts.transactionId ? { transaction_id: opts.transactionId } : {}),
  });
}
