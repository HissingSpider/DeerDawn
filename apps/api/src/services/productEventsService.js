const crypto = require('crypto');
const { summarizeUserAgent, sanitizeCurrentUrl } = require('../utils/userAgentSummary');
const db = require('../config/db');
const { captureProductEvent } = require('./posthog');
const workspace = require('./workspaceService');
const connectionIdentity = require('./connectionIdentity');

const MAX_EVENT_NAME = 120;
const MAX_SOURCE = 64;
const MAX_SURFACE = 64;
const MAX_PATH = 512;
const MAX_SESSION_ID = 128;
// Chrome's own UA is ~120 chars; 512 leaves room for the long-tail without
// letting a hostile client push an unbounded string into every mirrored event.
const MAX_USER_AGENT = 512;
const MAX_METADATA_BYTES = 16 * 1024;

function normalizeString(value, maxLength) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function normalizeTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeDuration(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num);
}

function sanitizeMetadata(value) {
  const safe = value && typeof value === 'object' ? value : {};
  const encoded = JSON.stringify(safe);
  if (Buffer.byteLength(encoded, 'utf8') <= MAX_METADATA_BYTES) return safe;
  return { truncated: true };
}

// A person-property bag, or nothing. An array, a string or an empty object are
// all "the caller had nothing to set" — sending `$set: []` to PostHog writes a
// person property shaped like an array and is worse than sending none.
function plainObjectOrNull(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.keys(value).length ? value : null;
}

// The shapes our own identities take: `user-<uuid>` / `org-<uuid>` locally,
// `user_...` / `org_...` from Clerk. An ANONYMOUS caller presenting one of these
// as its session or anonymous id is claiming to be somebody.
const RESERVED_IDENTITY_SHAPE = /^(user|org)[-_]/i;

function buildActorFields(actor) {
  const a = actor || {};
  // Prefer the explicit user actor; otherwise fall back to the key's owner so
  // key-authed MCP/API events attribute to the owning user (and a stable PostHog
  // person) instead of collapsing onto the org. Without this, every MCP tool call
  // shares one org-keyed distinct_id and per-user weekly-active is unmeasurable.
  // The org is still attached separately as a PostHog group for account-level WAU.
  const user_id = a.type === 'user' ? a.id : (a.owner_id || null);
  return {
    // The WORKSPACE being worked in, not the org the person signed up under.
    //
    // An invited teammate's users.org_id is still their own personal org, so
    // without this every event they generate inside a team workspace would be
    // filed against their private account — and team activation would be
    // unmeasurable by construction, which is the same shape as the metric that
    // could not see a first connection at all.
    //
    // Changes nothing that already exists: workspace_key is only ever set after
    // the auth layer has checked membership, and is absent for a solo account,
    // so this resolves to exactly what it always did for every current user and
    // every historical row.
    org_id: a.workspace_key || a.org_id || null,
    user_id,
  };
}

async function recordProductEvent(actor, input = {}, context = {}) {
  const event_name = normalizeString(input.event_name, MAX_EVENT_NAME);
  if (!event_name) {
    const err = new Error('event_name is required');
    err.code = 'invalid_payload';
    throw err;
  }

  const source = normalizeString(input.source, MAX_SOURCE) || 'unknown';
  const surface = normalizeString(input.surface, MAX_SURFACE);
  const path = normalizeString(input.path, MAX_PATH);
  const session_id = normalizeString(input.session_id, MAX_SESSION_ID);
  const started_at = normalizeTimestamp(input.started_at);
  const ended_at = normalizeTimestamp(input.ended_at);
  const duration_ms = normalizeDuration(input.duration_ms);
  const metadata = sanitizeMetadata(input.metadata);
  const { org_id, user_id } = buildActorFields(actor);

  // WHICH TOOL, AND HOW IT CONNECTS: two facts, kept apart (connectionIdentity).
  // `surface` is unchanged and still mixes them, because dashboards and queries
  // read it by name. The two new fields are stated by the caller when it knows
  // (the hosted dispatcher does), and otherwise derived from what an MCP event
  // carries: the surface, and the transport marker each server writes.
  // Events that are not about a tool connection carry neither.
  let tool = connectionIdentity.cleanTool(input.tool);
  let transport = connectionIdentity.cleanTransport(input.transport);
  if ((!tool || !transport) && (source === 'mcp' || metadata?.transport === 'http')) {
    const derived = connectionIdentity.fromLegacySurface(surface, metadata);
    tool = tool || derived.tool;
    transport = transport || derived.transport;
  }

  const event = {
    event_id: crypto.randomUUID(),
    event_name,
    org_id,
    user_id,
    session_id,
    source,
    surface,
    tool,
    transport,
    path,
    started_at,
    ended_at,
    duration_ms,
    metadata,
  };

  await db.query(
    `INSERT INTO product_events
       (event_id, event_name, org_id, user_id, session_id, source, surface, path, started_at, ended_at, duration_ms, metadata, tool, transport)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)`,
    [
      event.event_id,
      event.event_name,
      event.org_id,
      event.user_id,
      event.session_id,
      event.source,
      event.surface,
      event.path,
      event.started_at,
      event.ended_at,
      event.duration_ms,
      JSON.stringify(event.metadata),
      event.tool,
      event.transport,
    ],
    org_id || 'org-system'
  );

  if (org_id && session_id) {
    // ADOPT ONLY YOUR OWN PRE-AUTH ROWS.
    //
    // This route is optionalAuth and session_id is whatever the caller sends, so
    // "every unowned row with this session id" was a claim anyone could make in
    // either direction: a signed-in caller naming somebody else's session id
    // pulled that person's anonymous funnel into their own org, and rows planted
    // under a guessable id were adopted by whoever signed in with it next. The
    // browser's anonymous_id is the second factor: a row is adopted only when it
    // carries the SAME one as the event doing the adopting (both absent counts
    // as the same, which is the device flow: keyed by session id alone on both
    // legs).
    await db.query(
      `UPDATE product_events
          SET org_id = $1,
              user_id = COALESCE(user_id, $2)
        WHERE session_id = $3
          AND org_id IS NULL
          AND (metadata->>'anonymous_id') IS NOT DISTINCT FROM $4`,
      [org_id, user_id, session_id, typeof metadata?.anonymous_id === 'string' ? metadata.anonymous_id : null],
      org_id
    );
  }

  // Mirror into PostHog so the full server-side funnel (signup -> onboarding ->
  // activation) and all MCP tool calls land in the same project as the browser
  // web analytics. Best-effort: no-op until POSTHOG_API_KEY is set, never throws.
  // distinctId prefers the known user, then the session id, then the anonymous
  // id stamped on metadata pre-auth — keeping a single person across the funnel.
  // Falls back to org_id so org-scoped events (e.g. MCP calls with an API-key
  // actor and no user/session) still land, grouped under the organization.
  // `posthog_session_id` is PostHog's OWN session id, forwarded by the browser
  // (dashboard productAnalytics.ts). Re-stamped as `$session_id`, which is the
  // property PostHog joins an event to its session replay on — a plain
  // `posthog_session_id` property does not link anything.
  //
  // Why it matters: every step of the activation funnel is relayed through
  // here with posthog-node, so until now none of it carried a `$session_id`
  // and no activation drop-off could be opened as a recording. Measured
  // 2026-08-25 over 21 days, real users only, 13 people copied a connector
  // config and 3 reached the OAuth consent screen; the ten who stalled left no
  // replay reachable from the funnel.
  //
  // Only a non-empty string is forwarded: posthog-node sends an explicit null
  // otherwise, and a null `$session_id` reads as a broken session rather than
  // an absent one. `posthog_session_id` is dropped from the flat properties so
  // the same value is not stored twice under two names.
  const { posthog_session_id: replaySessionId, current_url: rawCurrentUrl, ...callerMetadata } = metadata || {};
  // `$`-PREFIXED KEYS ARE POSTHOG'S, NOT THE CALLER'S. Relayed verbatim, a
  // metadata of { $set: { is_test: true } } rewrote PERSON properties — and with
  // the distinct id also caller-chosen (below), one unauthenticated request
  // could mark any real user as a test account and drop them out of every
  // funnel. The ones this service needs ($session_id, $raw_user_agent,
  // $process_person_profile) are stamped by this function, after this filter.
  const relayMetadata = Object.fromEntries(
    Object.entries(callerMetadata).filter(([key]) => !key.startsWith('$')),
  );
  const hasReplaySession = typeof replaySessionId === 'string' && replaySessionId.length > 0;
  //
  // When the ONLY identity available is a per-attempt session id — no user, no
  // org, and no anonymous_id deliberately carried from the browser — the event
  // must not create a PostHog person. Otherwise every such attempt mints a fresh
  // person who has exactly one event and no properties, and therefore no
  // `is_test` flag either: they read as brand-new real users forever.
  //
  // This is not hypothetical. `POST /auth/mcp/start` is anonymous by design and
  // keys on a per-device-code session id, so over the 30 days to 2026-08-26 it
  // manufactured 11 such people, one or two every night at ~03:5x UTC from the
  // production journey E2E. The activation funnel read "11 real people started a
  // device flow, 0 of them authorized" — a wholly fictional cliff on the exact
  // step the activation push is aimed at. Validity gate §6.2, fourth occurrence.
  //
  // $process_person_profile: false keeps the EVENT (the "a runtime booted and
  // tried" signal is real and worth counting) while suppressing person creation.
  // If the flow is later authorized, that leg carries a real actor and lands as
  // a normal identified event, and the product_events backfill above still
  // stitches the server-side row. Nothing that was attributable becomes less so.
  const identityIsAttemptScoped = !user_id && !org_id && !metadata?.anonymous_id;

  // The second half of the same defect, found 2026-08-29 (validity gate §6.2,
  // fifth occurrence). E-007 closed the case where the ONLY identity is a
  // per-attempt session id, and deliberately exempted `anonymous_id` — a browser
  // id carried pre-auth is a real identity being stitched across the signup
  // funnel, and suppressing it would break that. But the dashboard's relay
  // stamps `anonymous_id` on EVERY event from a localStorage uuid, so a driven
  // browser is exempted too: each automation run gets a fresh profile directory,
  // therefore a fresh uuid, therefore a brand-new person.
  //
  // That person then never signs in — which is the whole point of the surface —
  // so it never receives `is_test`, so `coalesce(person.properties.is_test,
  // false) = false` lets it straight through. Measured over the 30 days to
  // 2026-08-29: six of the eleven "people" who reached `oauth_consent_viewed`
  // are one-event property-less identities, ALL of them `signed_in = 0`, four
  // landing inside the nightly journey window. The authorize screen is exactly
  // where E-011 and E-012 are being read.
  //
  // `is_automation` is stamped in the browser (dashboard productAnalytics.ts),
  // because it is the last place `navigator.webdriver` can be seen — this
  // repo's own Playwright config sends an ordinary Windows Chrome user agent,
  // so nothing on the server can infer it. Only the ANONYMOUS case is
  // suppressed: an automated run that signs in carries a real actor and already
  // filters on `is_test`, and dropping its person would break the journey
  // assertions that read it back.
  const isAnonymousAutomation = !user_id && !org_id && metadata?.is_automation === true;
  // AN ANONYMOUS CALLER DOES NOT GET TO BE SOMEBODY.
  //
  // With no actor, the distinct id is session_id or anonymous_id: both strings
  // the caller typed. Sent as-is, an anonymous request naming a real person's id
  // filed its event under that person. Anything shaped like one of OUR ids (a
  // user or org id, local or Clerk) is therefore never used as an anonymous
  // identity: the event is kept, under a one-way hash, with no person profile.
  // Ordinary anonymous ids (a uuid from localStorage, a device-flow session id)
  // are untouched, so pre-auth funnel stitching works exactly as before.
  const anonymousIdentity = !user_id && !org_id ? (session_id || metadata?.anonymous_id || null) : null;
  const impersonatesAnIdentity = Boolean(anonymousIdentity) && RESERVED_IDENTITY_SHAPE.test(String(anonymousIdentity));
  const suppressPerson = identityIsAttemptScoped || isAnonymousAutomation || impersonatesAnIdentity;
  const userAgent = normalizeString(context?.userAgent, MAX_USER_AGENT);

  // PERSON PROPERTIES COME FROM THE CONTEXT, NEVER FROM THE CALLER.
  //
  // The `$`-prefix filter above is right and stays: `metadata` is a request body
  // on an optionalAuth route, so nothing in it may reach PostHog's own reserved
  // keys. But `$set` was also how the ONE trusted emitter — the Clerk
  // `user.created` webhook, the single place a person ever gets an identity —
  // wrote `email`, `signup_method`, `is_test` and the `initial_*` first-touch
  // attribution. Filtering the caller's keys silently took the server's away
  // with them, and account_created has been minting property-less persons since
  // 2026-09-19: the 09-21 journey run signed in, was tagged `is_test` ON THE
  // EVENT, and still landed a person with no `is_test` at all — which is
  // precisely the filter every growth query in this repo trusts (protocol
  // §6.2.1). No real signup happened inside the window, so nothing needs
  // repairing; the next one would have been unattributable and the next bot run
  // indistinguishable from it.
  //
  // `context` is the fix's whole point: the HTTP route builds it itself
  // (`{ userAgent }`) and never copies anything out of `req.body` into it, so a
  // request cannot reach this channel however it is shaped. A caller's
  // `metadata.$set` is still dropped, and is still tested for.
  //
  // Suppressed persons are skipped deliberately: with `$process_person_profile:
  // false` there is no profile to set properties on, and sending both asks
  // PostHog for two contradictory things.
  const personSet = !suppressPerson ? plainObjectOrNull(context?.personProperties?.set) : null;
  const personSetOnce = !suppressPerson ? plainObjectOrNull(context?.personProperties?.setOnce) : null;

  captureProductEvent({
    distinctId: impersonatesAnIdentity
      ? `anon_${crypto.createHash('sha256').update(String(anonymousIdentity)).digest('hex').slice(0, 32)}`
      : (user_id || session_id || metadata?.anonymous_id || org_id),
    event: event_name,
    properties: {
      source,
      surface,
      path,
      // NEW property names, not `tool` or `transport`: some events already carry
      // a metadata `tool` (a mixed value) and a `transport: 'http'`, and
      // dashboards read those by name. These say the two facts on their own.
      ...(tool ? { connection_tool: tool } : {}),
      ...(transport ? { connection_transport: transport } : {}),
      ...relayMetadata,
      ...(hasReplaySession ? { $session_id: replaySessionId } : {}),
      // PostHog's canonical UA property, so device/browser resolution and
      // E-010's crawler exclusion finally reach the activation funnel.
      ...(userAgent ? { $raw_user_agent: userAgent } : {}),
      // $raw_user_agent alone does not populate PostHog's browser/OS columns on
      // a server-side capture, and relayed events carried no page URL, so the
      // activation funnel could not be broken down by browser or by page.
      ...summarizeUserAgent(userAgent),
      ...(sanitizeCurrentUrl(rawCurrentUrl) || {}),
      ...(personSet ? { $set: personSet } : {}),
      ...(personSetOnce ? { $set_once: personSetOnce } : {}),
      ...(suppressPerson ? { $process_person_profile: false } : {}),
    },
    orgId: org_id,
  });

  return event;
}

async function getProductEventSummary(actor) {
  // Read back under the key the events were FILED under: buildActorFields files
  // them against the workspace being worked in, so reading the person's own org
  // showed an invited teammate their personal account's events, not the team's.
  // Solo accounts carry no workspace_key, so this is their org_id as before.
  if (!actor?.org_id && !actor?.workspace_key) return null;
  const orgId = workspace.defaultOwnerKey(actor);
  const [totalsRes, onboardingRes, funnelRes, shared] = await Promise.all([
    db.query(
      `SELECT COUNT(*) AS total_events,
              COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS events_last_24h
         FROM product_events
        WHERE org_id = $1`,
      [orgId],
      orgId
    ),
    db.query(
      `SELECT
          COUNT(*) FILTER (WHERE event_name = 'onboarding_page_viewed') AS onboarding_views,
          COUNT(*) FILTER (WHERE event_name = 'onboarding_step_completed') AS onboarding_step_completions,
          COUNT(*) FILTER (WHERE event_name = 'onboarding_completed') AS onboarding_completions,
          AVG(duration_ms) FILTER (WHERE event_name = 'onboarding_completed' AND duration_ms IS NOT NULL) AS avg_onboarding_duration_ms,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms)
            FILTER (WHERE event_name = 'onboarding_completed' AND duration_ms IS NOT NULL) AS median_onboarding_duration_ms
         FROM product_events
        WHERE org_id = $1`,
      [orgId],
      orgId
    ),
    db.query(
      `SELECT
          COUNT(*) FILTER (WHERE event_name = 'signup_started') AS signup_starts,
          -- account_created is the authoritative signup signal: the Clerk user.created
          -- webhook fires it exactly once per real account (email + OAuth), server-side.
          -- Counting signup_completed here too double-counts email/password signups
          -- (both events fire for one account), so successes = account_created only.
          COUNT(*) FILTER (WHERE event_name = 'account_created') AS signup_successes,
          COUNT(*) FILTER (WHERE event_name = 'signup_failed') AS signup_failures,
          COUNT(*) FILTER (WHERE event_name = 'checkout_redirect_started') AS checkout_starts,
          COUNT(*) FILTER (WHERE event_name = 'checkout_redirect_failed') AS checkout_failures,
          COUNT(*) FILTER (WHERE event_name = 'context_import_started') AS import_starts,
          COUNT(*) FILTER (WHERE event_name = 'context_import_succeeded') AS import_successes,
          COUNT(*) FILTER (WHERE event_name = 'context_import_failed') AS import_failures,
          COUNT(*) FILTER (WHERE event_name = 'mcp_start_session_succeeded') AS mcp_start_sessions
         FROM product_events
        WHERE org_id = $1`,
      [orgId],
      orgId
    ),
    orgId !== actor?.org_id || workspace.isSharedWorkspace(orgId).catch(() => false),
  ]);

  // The aggregates are workspace-wide; the recent-event list carries each row's
  // path and metadata, so on a shared workspace it lists only the reader's own
  // events rather than a colleague's activity trail.
  const recentRes = await db.query(
    `SELECT event_name, created_at, source, surface, path, metadata
       FROM product_events
      WHERE org_id = $1${shared ? ' AND user_id = ANY($2::text[])' : ''}
      ORDER BY created_at DESC
      LIMIT 20`,
    shared ? [orgId, workspace.actorIdentities(actor)] : [orgId],
    orgId
  );

  const totals = totalsRes.rows[0] || {};
  const onboarding = onboardingRes.rows[0] || {};
  const funnel = funnelRes.rows[0] || {};

  return {
    totals: {
      total_events: Number(totals.total_events || 0),
      events_last_24h: Number(totals.events_last_24h || 0),
    },
    onboarding: {
      views: Number(onboarding.onboarding_views || 0),
      step_completions: Number(onboarding.onboarding_step_completions || 0),
      completions: Number(onboarding.onboarding_completions || 0),
      avg_duration_ms: onboarding.avg_onboarding_duration_ms ? Math.round(Number(onboarding.avg_onboarding_duration_ms)) : null,
      median_duration_ms: onboarding.median_onboarding_duration_ms ? Math.round(Number(onboarding.median_onboarding_duration_ms)) : null,
    },
    funnel: {
      signup_starts: Number(funnel.signup_starts || 0),
      signup_successes: Number(funnel.signup_successes || 0),
      signup_failures: Number(funnel.signup_failures || 0),
      checkout_starts: Number(funnel.checkout_starts || 0),
      checkout_failures: Number(funnel.checkout_failures || 0),
      import_starts: Number(funnel.import_starts || 0),
      import_successes: Number(funnel.import_successes || 0),
      import_failures: Number(funnel.import_failures || 0),
      mcp_start_sessions: Number(funnel.mcp_start_sessions || 0),
    },
    recent: recentRes.rows.map((row) => ({
      event_name: row.event_name,
      created_at: row.created_at,
      source: row.source,
      surface: row.surface,
      path: row.path,
      metadata: row.metadata || {},
    })),
  };
}

module.exports = {
  recordProductEvent,
  getProductEventSummary,
};
