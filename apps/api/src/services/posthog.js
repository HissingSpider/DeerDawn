const { PostHog } = require('posthog-node');
const { isTelemetryEnabled } = require('../config/selfHosted');

/**
 * Server-side PostHog client for the API.
 *
 * The browser apps (dashboard + marketing) send web/autocapture events directly
 * via posthog-js. This client mirrors PRODUCT events — the funnel and MCP usage
 * that only exist server-side — into the same PostHog project so the full
 * signup -> activation funnel is queryable in one place.
 *
 * Every product event already funnels through recordProductEvent() in
 * productEventsService.js (dashboard, marketing API, and the MCP server all POST
 * to /api/v1/product-events -> recordProductEvent), so a single capture() there
 * covers the entire product funnel and all MCP tool calls.
 *
 * Gated on POSTHOG_API_KEY: a no-op until the key is set, exactly like the
 * client bootstraps. Never throws — analytics must not break event recording.
 */

let client = null;

function getClient() {
  // Lazily create the client, but DO NOT latch a null result: if the key isn't
  // set yet we return null and re-check on the next call (a cheap env read), so
  // a key set after the process booted (e.g. a fresh `fly secrets set` without a
  // clean restart) starts working without needing a manual process restart.
  if (client) return client;

  // Self-hosted installs send nothing unless the operator opted in
  // (TELEMETRY_ENABLED=true). Hosted: unchanged, gated on the key alone.
  if (!isTelemetryEnabled()) return null;
  const apiKey = process.env.POSTHOG_API_KEY;
  if (!apiKey) return null;

  client = new PostHog(apiKey, {
    host: process.env.POSTHOG_HOST || 'https://us.i.posthog.com',
    // Product events are low-volume (funnel + MCP), so flush each event
    // immediately instead of buffering to 20 — guarantees delivery without
    // depending on the periodic flush timer firing on a long-lived process.
    flushAt: 1,
    flushInterval: 10000,
  });
  // Surface send failures (egress / host / key) instead of dropping them
  // silently, so a broken pipe shows up in logs rather than as "no events".
  if (typeof client.on === 'function') {
    client.on('error', (err) => console.warn('[posthog] capture error:', err && err.message ? err.message : err));
  }
  return client;
}

/**
 * Mirror a product event into PostHog. Safe to call unconditionally — no-ops
 * when unconfigured and swallows all errors.
 *
 * @param {object} params
 * @param {string} params.distinctId  Stable id for the actor (user id, else session/anonymous id).
 * @param {string} params.event       Event name (matches the product_events event_name).
 * @param {object} [params.properties] Event properties.
 * @param {string} [params.orgId]     Organization id — attached as a PostHog group when present.
 */
function captureProductEvent({ distinctId, event, properties = {}, orgId }) {
  try {
    const ph = getClient();
    if (!ph || !distinctId || !event) return;

    ph.capture({
      distinctId,
      event,
      properties,
      ...(orgId ? { groups: { organization: orgId } } : {}),
    });
  } catch {
    // Analytics is best-effort; never surface to the caller.
  }
}

/**
 * Merge two distinct ids into one PostHog person. Used at signup to stitch the
 * pre-auth marketing/web person (identified by Clerk's user id) onto the
 * canonical DeerDawn user id that the server mirrors every product/MCP event on —
 * so a visitor's top-of-funnel journey and their post-signup activity are one
 * person, not two. Safe to call unconditionally; no-ops unconfigured, never throws.
 *
 * @param {object} params
 * @param {string} params.distinctId  Canonical id to keep (the DeerDawn user id).
 * @param {string} params.alias       Other id to fold in (e.g. the Clerk user id).
 */
function aliasUser({ distinctId, alias }) {
  try {
    const ph = getClient();
    if (!ph || !distinctId || !alias || distinctId === alias) return;
    if (typeof ph.alias === 'function') ph.alias({ distinctId, alias });
  } catch {
    // Analytics is best-effort; never surface to the caller.
  }
}

// Server-side exception capture lived here until 2026-09-01. It moved to
// services/errorReporting.js (Sentry), which owns source maps, issue grouping
// and alerting. This module is product events only now — keep it that way so
// errors have one home rather than two partial ones.

/** Flush and close the client during graceful shutdown. Safe if never initialized. */
async function shutdownPostHog() {
  if (!client) return 'PostHog client not initialized';
  try {
    await client.shutdown();
    return 'PostHog client flushed and closed';
  } catch (err) {
    return `PostHog shutdown error: ${err?.message || err}`;
  }
}

module.exports = { captureProductEvent, aliasUser, shutdownPostHog };
