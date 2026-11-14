const crypto = require('crypto');
const { captureProductEvent } = require('./posthog');

/**
 * Server-side Reddit Conversions API (CAPI) client for the API.
 *
 * The browser fires the Reddit Pixel (PageVisit + a best-effort SignUp), but a
 * client pixel is blocked by ad-blockers and lost to the OAuth full-page
 * redirect. This mirrors the AUTHORITATIVE server-side signup signal
 * (account_created, from the Clerk webhook) straight to Reddit so ad-driven
 * signups are attributed even when the pixel never fires.
 *
 * Dedup: the CAPI event carries `event_metadata.conversion_id = <Clerk user id>`,
 * the same id the browser pixel sends as `conversionId`, so Reddit collapses the
 * pixel + CAPI signals into one conversion instead of double-counting.
 *
 * Gated on env — a no-op until BOTH REDDIT_PIXEL_ID and
 * REDDIT_CONVERSIONS_ACCESS_TOKEN are set, exactly like services/posthog.js and
 * the client-side tags. Never throws: analytics must not break account creation.
 *
 * Endpoint/shape follow Reddit Conversions API v2.0
 * (https://ads-api.reddit.com/api/v2.0/conversions/events/<pixel_id>). Confirm
 * events land in Reddit's Events Manager after setting the secrets.
 */

const REDDIT_CAPI_HOST = 'https://ads-api.reddit.com';

// Custom conversion name for the activation (first-sync) event. Surfaced here so
// the value that a campaign optimizes toward lives in one place; it appears in
// Reddit's Events Manager as a custom conversion once the first event lands.
const REDDIT_ACTIVATION_EVENT = 'FirstSync';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Reddit requires email lowercased + trimmed before SHA-256 hashing. */
function hashEmail(email) {
  return sha256(String(email || '').trim().toLowerCase());
}

function isRedditConfigured() {
  // Ad conversions are product telemetry: off on a self-host unless opted in.
  if (!require('../config/selfHosted').isTelemetryEnabled()) return false;
  return Boolean(process.env.REDDIT_PIXEL_ID && process.env.REDDIT_CONVERSIONS_ACCESS_TOKEN);
}

/**
 * POST a single conversion event to Reddit's CAPI. Both the SignUp and the
 * FirstSync (activation) conversions funnel through here so the endpoint,
 * headers, env-gating and error handling live in exactly one place.
 *
 * @param {object} p
 * @param {string} [p.trackingType]     Standard Reddit event (e.g. 'SignUp').
 * @param {string} [p.customEventName]  Custom event name; when set, tracking_type
 *                                      becomes 'Custom' and this is the label.
 * @param {string} [p.email]            Plaintext email — SHA-256 hashed before send.
 * @param {string} [p.clickId]          rdt_cid from the ad click (strongest match signal).
 * @param {string} [p.conversionId]     Stable dedup id (Clerk / internal user id).
 * @param {Date}   [p.eventAt]          Event time; defaults to now.
 */
async function postConversion({ trackingType, customEventName, email, clickId, conversionId, eventAt } = {}) {
  if (!isRedditConfigured()) return;

  const hashedEmail = email ? hashEmail(email) : undefined;
  // Reddit rejects an event with zero attribution signals. Signup carries the
  // click id when it came from an ad; post-signup events (FirstSync) usually
  // match on the hashed email alone, with the click id recovered when available.
  if (!hashedEmail && !clickId) return;

  const user = {};
  if (hashedEmail) user.email = hashedEmail;
  if (clickId) user.click_id = clickId;

  const event = {
    event_at: (eventAt instanceof Date ? eventAt : new Date()).toISOString(),
    event_type: customEventName
      ? { tracking_type: 'Custom', custom_event_name: customEventName }
      : { tracking_type: trackingType },
    user,
  };
  if (clickId) event.click_id = clickId;
  if (conversionId) event.event_metadata = { conversion_id: conversionId };

  const label = customEventName || trackingType;
  const url = `${REDDIT_CAPI_HOST}/api/v2.0/conversions/events/${encodeURIComponent(process.env.REDDIT_PIXEL_ID)}`;

  // Observability: the CAPI reports to Reddit, not to us, so a fire otherwise
  // leaves no trace on our side (success used to be silent). Mirror every send —
  // ok or not — as a `reddit_capi_sent` PostHog event AND a log line, so a fire
  // is verifiable in our own analytics and in `fly logs` without waiting on
  // Reddit's Events Manager. Instrumentation must never break the send.
  let status = 0;
  let ok = false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.REDDIT_CONVERSIONS_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'DeerDawn-Server/1.0',
      },
      body: JSON.stringify({ events: [event] }),
    });
    status = res.status;
    ok = res.ok;
    if (ok) {
      console.log(`[reddit] CAPI ${label} ok ${status} conv=${conversionId || 'n/a'} click_id=${clickId ? 'yes' : 'no'}`);
    } else {
      const body = await res.text().catch(() => '');
      console.warn('[reddit] CAPI non-2xx:', status, body.slice(0, 300));
    }
  } catch (err) {
    console.warn('[reddit] CAPI network error:', err && err.message ? err.message : err);
  } finally {
    // distinctId = conversionId (the user id) so the send ties to the person;
    // captureProductEvent is a no-op when PostHog is unconfigured and never throws.
    captureProductEvent({
      distinctId: conversionId || 'reddit_capi_anon',
      event: 'reddit_capi_sent',
      properties: {
        reddit_event: label,
        status,
        ok,
        has_click_id: Boolean(clickId),
        has_email: Boolean(hashedEmail),
      },
    });
  }
}

/**
 * Fire a Reddit "SignUp" conversion server-side. Best-effort and non-fatal.
 *
 * @param {object} p
 * @param {string}  p.email          Plaintext email — SHA-256 hashed before send.
 * @param {string} [p.clickId]       rdt_cid from the ad click (strongest match signal).
 * @param {string} [p.conversionId]  Stable id shared with the browser pixel for dedup (Clerk user id).
 * @param {Date}   [p.eventAt]       Event time; defaults to now.
 */
async function trackRedditSignup({ email, clickId, conversionId, eventAt } = {}) {
  try {
    await postConversion({ trackingType: 'SignUp', email, clickId, conversionId, eventAt });
  } catch (err) {
    console.warn('[reddit] CAPI error (non-fatal):', err && err.message ? err.message : err);
  }
}

/**
 * Fire the Reddit activation ("FirstSync") conversion server-side — the user's
 * first real context sync. This is the higher-intent signal a conversion
 * campaign can optimize toward once signup volume is flowing. Best-effort and
 * non-fatal. Fires at most once per user (see the caller's idempotence guard);
 * even if it double-fires, conversionId dedups it to one conversion at Reddit.
 *
 * @param {object} p
 * @param {string} [p.email]         Plaintext email — SHA-256 hashed before send (primary match).
 * @param {string} [p.clickId]       rdt_cid recovered from the ad-driven signup, when present.
 * @param {string} [p.conversionId]  Stable dedup id (internal user id).
 * @param {Date}   [p.eventAt]       Event time; defaults to now.
 */
async function trackRedditActivation({ email, clickId, conversionId, eventAt } = {}) {
  try {
    await postConversion({ customEventName: REDDIT_ACTIVATION_EVENT, email, clickId, conversionId, eventAt });
  } catch (err) {
    console.warn('[reddit] CAPI error (non-fatal):', err && err.message ? err.message : err);
  }
}

module.exports = { trackRedditSignup, trackRedditActivation, isRedditConfigured, REDDIT_ACTIVATION_EVENT };
