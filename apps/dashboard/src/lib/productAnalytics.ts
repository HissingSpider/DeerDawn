import { api } from '@/lib/api';
import { logger } from '@/lib/logger';
import { getAttribution } from '@/lib/attribution';
import { getDeviceType } from '@/lib/device';
import { phSessionId } from '@/lib/posthog';
import { isSyntheticAgent } from '@/lib/syntheticAgent';
import { fireConnectAttemptedOnce } from '@/lib/gtag';
import { clientTelemetryAllowed } from '@/lib/telemetryGate';
import { fetchDeployment } from '@/lib/deployment';

const ONBOARDING_TIMER_KEY = 'dd_onboarding_started_at';
const PRODUCT_SESSION_KEY = 'dd_product_session_id';

// The two events that mean "this person is trying to connect a client", one per
// setup path: pasting a config (Claude Code / Cursor) and approving remote OAuth
// (Claude.ai / ChatGPT). They map to a single Google Ads conversion.
//
// The mapping lives here, at the layer every product event already passes
// through, rather than at the call sites: mcp_config_copied alone fires from
// five places in onboarding.tsx today, and a sixth added later would silently
// miss the conversion if each site had to remember to fire it.
const CONNECT_ATTEMPTED_EVENTS = new Set(['mcp_config_copied', 'oauth_consent_approved']);

type ProductEventPayload = {
  source: 'dashboard' | 'mcp' | 'desktop' | 'api';
  surface?: string;
  path?: string;
  session_id?: string;
  started_at?: string;
  ended_at?: string;
  duration_ms?: number;
  metadata?: Record<string, unknown>;
};

export async function trackProductEvent(event_name: string, payload: ProductEventPayload) {
  // Self-hosted: no browser product events unless TELEMETRY_ENABLED=true. The
  // build flag answers at once; the API's own answer covers an image built
  // without it. (Product STATE the dashboard shows comes from the server's own
  // MCP events, never from these.)
  if (!clientTelemetryAllowed()) return;
  try {
    const deployment = await fetchDeployment();
    if (deployment.self_hosted && !deployment.telemetry_enabled) return;
  } catch {
    /* fetchDeployment never throws; hosted defaults apply */
  }
  try {
    const anonId = getProductSessionId();
    const replaySessionId = phSessionId();
    // Auto-attach first-touch attribution + the anonymous id to every event so
    // the full funnel can be sliced by utm_source/campaign/term/content and
    // landing_page even before the user authenticates.
    const { metadata: payloadMetadata, ...rest } = payload;
    const metadata = {
      ...getAttribution(),
      anonymous_id: anonId,
      // Device class on every product event so the signup→activation funnel is
      // sliceable mobile-vs-desktop (a phone can't set up Cursor/Claude Code).
      device_type: getDeviceType(),
      // Page, for the relayed event's $current_url. origin + pathname only: the
      // query can hold an OAuth code or a stash token. The API strips it again.
      ...(typeof window !== 'undefined' ? { current_url: `${window.location.origin}${window.location.pathname}` } : {}),
      // PostHog's session id, relayed so the API can stamp `$session_id` on the
      // mirrored event and the funnel step becomes openable as a session replay.
      // Spread conditionally: posthog-node would otherwise send an explicit null
      // and PostHog treats a null `$session_id` as a real (broken) value rather
      // than an absent one. Undefined before init / under Do Not Track.
      ...(replaySessionId ? { posthog_session_id: replaySessionId } : {}),
      // Is a driver holding this browser? Relayed events reach PostHog through
      // posthog-node and arrive with no user agent and no browser context at
      // all, so nothing downstream can tell our own Playwright run from a
      // person. Suppressing the SDK (lib/posthog.ts) does not help here: this
      // path never touches the SDK. The flag has to be stamped at the source,
      // by the only code that can still see `navigator`.
      //
      // Spread conditionally so the property exists only when it is true — a
      // literal `false` on every event from every real user is 30 days of noise
      // to say nothing.
      ...(isSyntheticAgent() ? { is_automation: true } : {}),
      ...(payloadMetadata || {}),
    };
    await api.trackProductEvent({
      event_name,
      session_id: payload.session_id || anonId,
      ...rest,
      metadata,
    });
  } catch (err) {
    logger.error('product_event_failed', err, { event_name, source: payload.source });
  } finally {
    // In `finally`, not after the await: the Google Ads conversion reports a
    // thing the user actually did, and a failed relay to our own API is no
    // reason to lose the attribution for it.
    if (CONNECT_ATTEMPTED_EVENTS.has(event_name)) fireConnectAttemptedOnce();
  }
}

export function getAnonymousId(): string | undefined {
  return getProductSessionId();
}

function getProductSessionId() {
  if (typeof window === 'undefined') return undefined;
  const existing = window.localStorage.getItem(PRODUCT_SESSION_KEY);
  if (existing) return existing;
  const next = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `dd_${Date.now()}`;
  window.localStorage.setItem(PRODUCT_SESSION_KEY, next);
  return next;
}

export function markOnboardingStart() {
  if (typeof window === 'undefined') return;
  if (!window.localStorage.getItem(ONBOARDING_TIMER_KEY)) {
    window.localStorage.setItem(ONBOARDING_TIMER_KEY, new Date().toISOString());
  }
}

// `surface` is required, not optional, for the same reason onboarding_step_completed
// carries one: two independent places finish onboarding — the /onboarding flow and
// the dashboard checklist — and without a discriminator the funnel cannot tell a
// completion that walked the real setup steps from one the checklist ticked off in
// the background. duration_ms means different things on each, too (the flow measures
// a single sitting; the checklist can span days), so an average across both is
// meaningless. Typing it as required means a third completion path cannot be added
// later without labelling itself.
export async function trackOnboardingCompletion(
  metadata: { surface: 'onboarding_flow' | 'dashboard_checklist' } & Record<string, unknown>,
) {
  const endedAt = new Date();
  let startedAtIso: string | null = null;
  let durationMs: number | null = null;

  if (typeof window !== 'undefined') {
    startedAtIso = window.localStorage.getItem(ONBOARDING_TIMER_KEY);
  }

  if (startedAtIso) {
    const startedAt = new Date(startedAtIso);
    if (!Number.isNaN(startedAt.getTime())) {
      durationMs = endedAt.getTime() - startedAt.getTime();
    }
  }

  await trackProductEvent('onboarding_completed', {
    source: 'dashboard',
    path: typeof window !== 'undefined' ? window.location.pathname : '/onboarding',
    started_at: startedAtIso || undefined,
    ended_at: endedAt.toISOString(),
    duration_ms: durationMs || undefined,
    metadata,
  });
}
