/**
 * Lifecycle-email click attribution.
 *
 * The activation follow-up (apps/api/src/services/email/activationFollowUp.js)
 * is the product's only second touch: signup takes ten seconds, connecting an
 * AI tool is a detour into another app, and this email is what pulls a deferred
 * user back. In the 30d to 2026-08-15 it went out 52 times, 14 landed
 * (confirmed by the Resend webhook), and not one of those accounts activated.
 *
 * That number is unactionable on its own, because "nobody opened it" and
 * "everybody opened it and the page they landed on failed them" produce the
 * same zero. Resend can report opens and clicks, but only once open/click
 * tracking is switched on per sending domain in its dashboard — there is no
 * per-send API field, so apps/api cannot enable it and no code change here can.
 *
 * So the click is measured on arrival instead: the email's CTA carries
 * ?dd_email=<email type>, and the first dashboard page load that sees it emits
 * lifecycle_email_clicked. No pixel, no redirector, no ESP dependency.
 *
 * Deduped per email type in sessionStorage: the marker survives client-side
 * navigation inside the visit but not a genuinely new one, so a user who
 * returns to the link tomorrow counts again — which is the behaviour we want to
 * see. The params are stripped from the URL after capture so a shared or
 * bookmarked link doesn't keep re-reporting.
 *
 * ---
 *
 * WHY THE EMIT IS DEFERRED (E-022, 2026-09-05).
 *
 * This is the one product event in the dashboard that fires on a COLD LOAD
 * rather than after a user interaction: `_app.tsx` calls it on the first
 * `router.isReady`, which is the earliest moment in the page's life. Every
 * other product event follows a click, by which time Clerk has long since
 * resolved a session.
 *
 * That ordering has a consequence nothing was checking. `trackProductEvent`
 * POSTs to `/api/v1/product-events`, which is mounted behind `optionalAuth` —
 * so a request that goes out before Clerk has answered is accepted with a 200
 * and no actor. `productEventsService` then falls back to
 * `distinctId: metadata.anonymous_id` (the dashboard's own localStorage uuid,
 * which nothing ever aliases to the account) and the click lands on a fresh
 * PostHog person carrying exactly one event and no properties — no email, no
 * `is_test`. Unjoinable to the account we emailed, forever, and indistinguishable
 * from the phantom-person class E-007 and E-013 were opened to kill.
 *
 * The single `lifecycle_email_clicked` in the project's history (2026-08-27
 * 13:22 UTC) has precisely that shape. There is no 401 to notice, because
 * `optionalAuth` returns 200 — a silent success.
 *
 * So: read and consume the marker synchronously, as before, but wait for the
 * auth bridge to produce a token before emitting, and stamp the outcome. The
 * wait is bounded three ways — token, deadline, or the page going away — and
 * every one of them still emits. Losing a click would be worse than an
 * unattributed one, and E-008's open prediction turns on the event firing at
 * all.
 */

import { trackProductEvent } from '@/lib/productAnalytics';
import { PRODUCT_EVENTS } from '@/lib/analyticsEvents';
import { resolveRuntimeAuthToken } from '@/lib/authToken';

export const LIFECYCLE_EMAIL_PARAM = 'dd_email';

const SEEN_KEY_PREFIX = 'dd_lifecycle_email_seen:';
// Bounds what a crafted link can write into the event stream. The real values
// are activation_followup_connected / _authorized[_saved] / _unconnected[_saved].
const MAX_EMAIL_TYPE_LENGTH = 64;
const EMAIL_TYPE_PATTERN = /^[A-Za-z0-9_-]+$/;

// How long to wait for the auth bridge before emitting anyway. Clerk's session
// normally resolves in well under two seconds; eight is generous and still far
// inside a page visit. The POST is `keepalive`, so an emit at the deadline
// survives a navigation that starts immediately after it.
export const AUTH_WAIT_DEADLINE_MS = 8000;
export const AUTH_POLL_INTERVAL_MS = 250;

type Query = Record<string, string | string[] | undefined>;

/** Seam for tests. Production wiring is the default below. */
export type LifecycleEmailDeps = {
  track: (event: string, payload: Record<string, unknown>) => void;
  resolveToken: () => Promise<string | null>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Registers a "the page is going away" callback; returns an unsubscribe. */
  onPageHide: (fn: () => void) => () => void;
};

const defaultDeps: LifecycleEmailDeps = {
  track: (event, payload) => {
    void trackProductEvent(event, payload as Parameters<typeof trackProductEvent>[1]);
  },
  resolveToken: resolveRuntimeAuthToken,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onPageHide: (fn) => {
    if (typeof window === 'undefined') return () => {};
    window.addEventListener('pagehide', fn);
    return () => window.removeEventListener('pagehide', fn);
  },
};

function pick(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value || undefined;
}

/**
 * Returns the email type if `query` carries a well-formed lifecycle marker.
 * Anything else — missing, too long, or outside the tag charset the API uses —
 * is ignored rather than recorded, so a hand-edited URL cannot inject arbitrary
 * strings into the funnel's event names.
 */
export function readLifecycleEmailType(query: Query): string | undefined {
  const raw = pick(query[LIFECYCLE_EMAIL_PARAM]);
  if (!raw || raw.length > MAX_EMAIL_TYPE_LENGTH) return undefined;
  return EMAIL_TYPE_PATTERN.test(raw) ? raw : undefined;
}

/**
 * Wait for the auth bridge, then emit exactly once.
 *
 * Resolves to the value stamped on the event as `identified`: true when a token
 * was in hand at emit time (the click is attributable to the account that was
 * emailed), false when the deadline or a page-hide got there first.
 *
 * Exported for the test — the whole point of E-022 is that this rule is checked
 * as logic rather than assumed from the call site.
 */
export async function emitLifecycleEmailClick(
  emailType: string,
  path: string,
  deps: LifecycleEmailDeps = defaultDeps,
): Promise<boolean> {
  const startedAt = deps.now();

  let pageHidden = false;
  const unsubscribe = deps.onPageHide(() => {
    pageHidden = true;
  });

  let identified = false;
  try {
    for (;;) {
      let token: string | null = null;
      try {
        token = await deps.resolveToken();
      } catch {
        // The bridge throwing is not an answer either — keep waiting for the
        // deadline rather than treating it as "signed out".
        token = null;
      }
      if (token) {
        identified = true;
        break;
      }
      if (pageHidden) break;
      if (deps.now() - startedAt >= AUTH_WAIT_DEADLINE_MS) break;
      await deps.sleep(AUTH_POLL_INTERVAL_MS);
    }
  } finally {
    unsubscribe();
  }

  deps.track(PRODUCT_EVENTS.lifecycleEmailClicked, {
    source: 'dashboard',
    surface: 'lifecycle_email',
    path,
    metadata: {
      email_type: emailType,
      // The property this whole deferral exists to make meaningful. `false`
      // means the row is on an anonymous person and cannot be joined back to
      // the emailed account — a real click that the funnel must not count as a
      // new user. Stamped either way so the split is visible instead of
      // inferred from an absence.
      identified,
      auth_wait_ms: Math.max(0, deps.now() - startedAt),
    },
  });

  return identified;
}

/**
 * Fire lifecycle_email_clicked once per email type per browsing session.
 * Returns true when this call was the one that recorded it, so the caller knows
 * whether it still needs to strip the params from the URL.
 *
 * The return stays synchronous: the marker is read and consumed here, so the
 * caller can strip the query immediately and a second render cannot double-fire
 * while the emit is still waiting for auth.
 */
export function captureLifecycleEmailClick(
  query: Query,
  path: string,
  deps: LifecycleEmailDeps = defaultDeps,
): boolean {
  if (typeof window === 'undefined') return false;
  const emailType = readLifecycleEmailType(query);
  if (!emailType) return false;

  const key = `${SEEN_KEY_PREFIX}${emailType}`;
  try {
    if (window.sessionStorage.getItem(key)) return false;
    window.sessionStorage.setItem(key, '1');
  } catch {
    // Private mode / storage disabled. Recording a duplicate is a far smaller
    // problem than recording nothing, so fall through rather than bail.
  }

  void emitLifecycleEmailClick(emailType, path, deps);
  return true;
}
