'use strict';

// Which AI tool a signup came from, when the account was created mid-connect.
//
// 2026-09-26: both signups the day before came in through ChatGPT's connector,
// and the only way to know was to line account_created up against
// connector_authorize_requested by the second. The signup event is emitted by
// the Clerk user.created webhook, which never sees the browser, and the
// authorize request that knew the client's name lives ten minutes in Redis and
// is deleted on approve.
//
// So the two ends are joined through the one thing the browser does carry
// across the sign-up: the consent URL's `?req=` id. The authorize endpoint
// writes a small, longer-lived side record keyed by that id (the client's name
// and how it registered, nothing else), the sign-up forwards the id in Clerk
// unsafeMetadata, and the webhook reads the name back here.
//
// The name comes from OUR record, never from the browser. unsafeMetadata is
// whatever the signing-up browser chose to send, so a client name taken from it
// would be a free-text field anyone can fill; an id only resolves to a request
// this server actually issued. A made-up or expired id resolves to nothing.

// Long enough to outlive an email-verification round trip, a Google redirect,
// and somebody who wanders off mid-signup and comes back. Unlike the request
// itself (REQUEST_TTL, 10 minutes, a bearer-ish handle on an authorization),
// this record authorizes nothing, so it can safely live longer.
const CONNECTOR_REQUEST_CLIENT_TTL = 24 * 60 * 60;

// oauth.js mints request ids as randomBytes(24).toString('hex').
const REQUEST_ID_PATTERN = /^[a-f0-9]{48}$/;

// A DCR client names itself, unauthenticated, up to 200 characters. An
// analytics property does not need all of that.
const MAX_CLIENT_NAME = 100;

function isConsentRequestId(value) {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

function clientRecordKey(requestId) {
  return `oauth:req-client:${requestId}`;
}

/**
 * Remember who asked for an authorization, for the signup that may follow it.
 * Best-effort: attribution must never cost somebody their connection.
 */
async function rememberConnectorRequest(redis, requestId, { clientName, clientVerified, clientSource } = {}) {
  if (!redis || !isConsentRequestId(requestId)) return;
  const record = {
    client_name: typeof clientName === 'string' ? clientName.slice(0, MAX_CLIENT_NAME) : null,
    client_verified: Boolean(clientVerified),
    client_source: typeof clientSource === 'string' ? clientSource : null,
  };
  try {
    await redis.set(clientRecordKey(requestId), JSON.stringify(record), 'EX', CONNECTOR_REQUEST_CLIENT_TTL);
  } catch (err) {
    console.warn('[OAUTH] connector signup attribution not stored:', err.message);
  }
}

/**
 * The connector a signup came through, as event properties, or {} when the
 * signup did not start from a consent screen (or the record is gone). Never
 * throws: the caller is account creation.
 */
async function resolveConnectorSignupProps(redis, requestId) {
  if (!redis || !isConsentRequestId(requestId)) return {};
  try {
    const raw = await redis.get(clientRecordKey(requestId));
    if (!raw) return {};
    const record = JSON.parse(raw);
    if (!record || typeof record.client_name !== 'string' || !record.client_name) return {};
    return {
      client_name: record.client_name.slice(0, MAX_CLIENT_NAME),
      client_verified: Boolean(record.client_verified),
      ...(typeof record.client_source === 'string' ? { client_source: record.client_source } : {}),
    };
  } catch (err) {
    console.warn('[AUTH] connector signup attribution lookup failed:', err.message);
    return {};
  }
}

module.exports = {
  CONNECTOR_REQUEST_CLIENT_TTL,
  isConsentRequestId,
  clientRecordKey,
  rememberConnectorRequest,
  resolveConnectorSignupProps,
};
