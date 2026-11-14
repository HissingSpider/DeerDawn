const { captureProductEvent } = require('./posthog');

/**
 * Server-side Google Ads offline-conversion client for the API.
 *
 * The browser fires the Google Ads tag for email signups, but the primary paid
 * path — a Google-OAuth signup — loses the client conversion: the marketing
 * `handleGoogle` never marks a pending signup, and the app-origin pending flag
 * (dd_signup_pending in app.deerdawn.com localStorage) is unreadable from the
 * marketing origin where the ad click lands. So Google-OAuth signups fire zero
 * client conversion. This mirrors the AUTHORITATIVE server-side signup signal
 * (account_created, from the Clerk webhook) straight to Google Ads via an
 * offline click-conversion upload keyed on the gclid/wbraid/gbraid threaded
 * through Clerk unsafeMetadata — the exact counterpart of services/reddit.js.
 *
 * It also uploads the SETUP conversion (trackGoogleAdsSetup): the person's AI
 * tool actually received its first brief (first_sync_completed). That is the
 * conversion the campaigns should optimise toward. The click id it needs is the
 * one stored on the person's account_created product event at signup.
 *
 * Gated on env — a no-op until the OAuth + account credentials are all set, and
 * a per-person no-op unless the account carried a Google ad-click id. Never
 * throws: analytics must not break account creation or a sync.
 *
 * Required env (all must be set to enable):
 *   GOOGLE_ADS_DEVELOPER_TOKEN
 *   GOOGLE_ADS_CLIENT_ID
 *   GOOGLE_ADS_CLIENT_SECRET
 *   GOOGLE_ADS_REFRESH_TOKEN
 *   GOOGLE_ADS_CUSTOMER_ID                 (digits only, no dashes — owns the conversion action)
 *   GOOGLE_ADS_SIGNUP_CONVERSION_ACTION_ID (numeric id of the "signup" conversion action)
 * Optional:
 *   GOOGLE_ADS_LOGIN_CUSTOMER_ID           (manager/MCC id, digits only, if applicable)
 *   GOOGLE_ADS_SIGNUP_VALUE                 (proxy conversion value; omitted if unset)
 *   GOOGLE_ADS_CURRENCY                     (defaults to USD when a value is sent)
 *   GOOGLE_ADS_SETUP_CONVERSION_ACTION_ID   (numeric id of the "setup" conversion action;
 *                                            trackGoogleAdsSetup is a no-op until it is set.
 *                                            Needs the credentials above, not the signup id)
 *   GOOGLE_ADS_SETUP_VALUE                  (conversion value for a setup; omitted if unset)
 *
 * API: Google Ads REST v25 customers/{cid}:uploadClickConversions.
 * Keep this on a currently supported version: sunset endpoints return HTTP 404
 * and silently drop the conversion because this client is intentionally
 * best-effort/non-fatal.
 * (https://developers.google.com/google-ads/api/reference/rest/v25/customers/uploadClickConversions)
 */

const ADS_API_VERSION = 'v25';
const ADS_API_HOST = 'https://googleads.googleapis.com';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Google Ads only accepts a click conversion inside the click-through window
// (90 days at most). We store the signup time, not the click time, and the
// click can only be EARLIER than the signup — so past this the upload is very
// likely rejected. It is sent anyway (Google is the judge) and logged.
const CLICK_WINDOW_DAYS = 90;

// digits only — the API rejects dashed customer ids.
function normalizeCustomerId(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

// The credentials every upload needs, whichever conversion action it targets.
function hasGoogleAdsCredentials() {
  // Ad conversions are product telemetry: off on a self-host unless opted in.
  if (!require('../config/selfHosted').isTelemetryEnabled()) return false;
  return Boolean(
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN &&
    process.env.GOOGLE_ADS_CLIENT_ID &&
    process.env.GOOGLE_ADS_CLIENT_SECRET &&
    process.env.GOOGLE_ADS_REFRESH_TOKEN &&
    process.env.GOOGLE_ADS_CUSTOMER_ID,
  );
}

function isGoogleAdsConfigured() {
  return Boolean(hasGoogleAdsCredentials() && process.env.GOOGLE_ADS_SIGNUP_CONVERSION_ACTION_ID);
}

function isGoogleAdsSetupConfigured() {
  return Boolean(hasGoogleAdsCredentials() && process.env.GOOGLE_ADS_SETUP_CONVERSION_ACTION_ID);
}

// Google Ads wants "yyyy-mm-dd hh:mm:ss+|-hh:mm". Emit UTC with a +00:00 offset,
// which the API accepts regardless of the account's configured timezone.
function formatConversionDateTime(date) {
  const d = date instanceof Date ? date : new Date();
  const iso = d.toISOString(); // 2026-07-11T14:29:24.934Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}+00:00`;
}

// Access tokens live ~1h; cache the exchanged token in-process so a burst of
// signups doesn't hit the OAuth endpoint on every webhook. Refreshed lazily
// once inside a 60s safety margin of expiry.
let cachedToken = null; // { accessToken, expiresAtMs }

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAtMs - 60_000 > nowMs()) {
    return cachedToken.accessToken;
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.GOOGLE_ADS_CLIENT_ID,
    client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
  });
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`oauth token exchange ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  const expiresInMs = (Number(json.expires_in) || 3600) * 1000;
  cachedToken = { accessToken: json.access_token, expiresAtMs: nowMs() + expiresInMs };
  return cachedToken.accessToken;
}

// Isolated so tests / callers don't depend on Date.now directly.
function nowMs() {
  return Date.now();
}

function clickKind({ gclid, wbraid, gbraid }) {
  return gclid ? 'gclid' : wbraid ? 'wbraid' : gbraid ? 'gbraid' : 'none';
}

/**
 * Upload one offline click conversion. Best-effort and non-fatal: every error
 * is logged and swallowed. Callers have already checked configuration and that
 * a click id is present.
 */
async function uploadClickConversion({ label, actionId, valueEnv, gclid, wbraid, gbraid, conversionId, orderId, eventAt }) {
  const customerId = normalizeCustomerId(process.env.GOOGLE_ADS_CUSTOMER_ID);
  const conversionAction = `customers/${customerId}/conversionActions/${actionId}`;

  const conversion = {
    conversionAction,
    conversionDateTime: formatConversionDateTime(eventAt),
  };
  // Exactly one click identifier; gclid is strongest, then the iOS-privacy ids.
  if (gclid) conversion.gclid = gclid;
  else if (wbraid) conversion.wbraid = wbraid;
  else if (gbraid) conversion.gbraid = gbraid;
  // orderId is Google's per-conversion-action dedup key: a second upload with
  // the same orderId is rejected as a duplicate instead of counted twice.
  if (orderId) conversion.orderId = orderId;

  const value = Number(process.env[valueEnv]);
  if (Number.isFinite(value) && value > 0) {
    conversion.conversionValue = value;
    conversion.currencyCode = process.env.GOOGLE_ADS_CURRENCY || 'USD';
  }

  const url = `${ADS_API_HOST}/${ADS_API_VERSION}/customers/${customerId}:uploadClickConversions`;
  const kind = clickKind({ gclid, wbraid, gbraid });

  let status = 0;
  let ok = false;
  try {
    const accessToken = await getAccessToken();
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
      'Content-Type': 'application/json',
    };
    if (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
      headers['login-customer-id'] = normalizeCustomerId(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
    }
    // partialFailure:true so a single bad row is reported in the body instead of
    // failing the whole request; validateOnly stays false (real upload).
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ conversions: [conversion], partialFailure: true }),
    });
    status = res.status;
    const bodyText = await res.text().catch(() => '');
    // A 200 with a partialFailureError still means the row was rejected — surface it.
    const hasPartialError = bodyText.includes('partialFailureError');
    ok = res.ok && !hasPartialError;
    if (ok) {
      console.log(`[google-ads] ${label} conversion ok ${status} conv=${conversionId || 'n/a'} click=${kind}`);
    } else {
      console.warn(`[google-ads] ${label} upload non-ok:`, status, bodyText.slice(0, 400));
    }
  } catch (err) {
    console.warn(`[google-ads] ${label} upload error:`, err && err.message ? err.message : err);
  } finally {
    captureProductEvent({
      distinctId: conversionId || 'google_ads_capi_anon',
      event: 'google_ads_conversion_sent',
      properties: {
        google_ads_event: label,
        status,
        ok,
        click_kind: kind,
      },
    });
  }
}

/**
 * Upload a single offline "signup" click conversion to Google Ads. Best-effort,
 * env-gated, and non-fatal — mirrors reddit.postConversion.
 *
 * @param {object} p
 * @param {string} [p.gclid]         Primary Google ad-click id.
 * @param {string} [p.wbraid]        iOS web-to-app click id (fallback).
 * @param {string} [p.gbraid]        iOS app click id (fallback).
 * @param {string} [p.conversionId]  Stable id (Clerk user id) — dedup + observability.
 * @param {Date}   [p.eventAt]       Conversion time; defaults to now.
 */
async function trackGoogleAdsSignup({ gclid, wbraid, gbraid, conversionId, eventAt } = {}) {
  if (!isGoogleAdsConfigured()) return;
  // Offline click-conversion import needs at least one Google click id. Email is
  // not an accepted match key here (that is enhanced conversions, a client-side
  // concern) — so a signup with no Google click id is genuinely not a paid
  // Google conversion and is skipped, not force-fit.
  if (!gclid && !wbraid && !gbraid) return;
  await uploadClickConversion({
    label: 'signup',
    actionId: process.env.GOOGLE_ADS_SIGNUP_CONVERSION_ACTION_ID,
    valueEnv: 'GOOGLE_ADS_SIGNUP_VALUE',
    gclid,
    wbraid,
    gbraid,
    conversionId,
    eventAt,
  });
}

/**
 * Upload the "setup" conversion: the person's AI tool actually received its
 * first brief (first_sync_completed). This is what the campaigns should
 * optimise toward — a signup that never connects anything is worth nothing, and
 * the /start command-copy proxy counts people who never ran the command.
 *
 * Fired once per person by sessionCatchupService.maybeEmitFirstSyncActivation,
 * with the click id recovered from that person's account_created event. The
 * orderId `<personId>:setup` makes a retry or a racing double-emit collapse to
 * one conversion at Google. Never throws.
 *
 * @param {object} p
 * @param {string} [p.gclid]       Click ids stored at signup (one is enough).
 * @param {string} [p.wbraid]
 * @param {string} [p.gbraid]
 * @param {string}  p.personId     DeerDawn user id — dedup key + observability.
 * @param {Date}   [p.eventAt]     When first_sync_completed was recorded.
 * @param {Date|string} [p.signedUpAt]  account_created time, for the window log.
 */
async function trackGoogleAdsSetup({ gclid, wbraid, gbraid, personId, eventAt, signedUpAt } = {}) {
  try {
    if (!isGoogleAdsSetupConfigured()) return;
    if (!gclid && !wbraid && !gbraid) return;
    const at = eventAt instanceof Date ? eventAt : new Date();
    const signedUp = signedUpAt ? new Date(signedUpAt) : null;
    if (signedUp && !Number.isNaN(signedUp.getTime())) {
      const days = (at.getTime() - signedUp.getTime()) / 86400000;
      if (days > CLICK_WINDOW_DAYS) {
        console.warn(`[google-ads] setup ${Math.round(days)}d after signup (> ${CLICK_WINDOW_DAYS}d click window); sending anyway, Google may reject it conv=${personId || 'n/a'}`);
      }
    }
    await uploadClickConversion({
      label: 'setup',
      actionId: process.env.GOOGLE_ADS_SETUP_CONVERSION_ACTION_ID,
      valueEnv: 'GOOGLE_ADS_SETUP_VALUE',
      gclid,
      wbraid,
      gbraid,
      conversionId: personId,
      orderId: personId ? `${personId}:setup` : undefined,
      eventAt: at,
    });
  } catch (err) {
    console.warn('[google-ads] setup conversion failed:', err && err.message ? err.message : err);
  }
}

// Test seam: let unit tests reset the cached OAuth token between cases.
function _resetTokenCache() {
  cachedToken = null;
}

module.exports = {
  trackGoogleAdsSignup,
  trackGoogleAdsSetup,
  isGoogleAdsConfigured,
  isGoogleAdsSetupConfigured,
  formatConversionDateTime,
  normalizeCustomerId,
  CLICK_WINDOW_DAYS,
  _resetTokenCache,
};
