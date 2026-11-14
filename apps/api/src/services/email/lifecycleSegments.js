'use strict';

// Where each account stopped on the setup ladder — the one definition of it.
//
// Two one-shot campaigns read this file: A-4 (dormant reactivation) writes to
// people who never tried, A-3 (concierge recovery) writes to people who tried
// and it broke. Those two emails say incompatible things — "the setup you
// skipped got shorter" versus "I can see where the setup lost you" — so a
// person who receives both has been told two contradictory stories by the same
// founder in the same week.
//
// The segments are therefore defined as complements of one shared ladder rather
// than as two hand-maintained event lists that happen not to overlap today:
//
//   dormant  = no event at or above SETUP_ATTEMPT
//   stuck    = some event at or above SETUP_ATTEMPT, none in ACTIVATION
//   working  = some event in ACTIVATION
//
// Disjointness is then structural, not a coincidence to be re-checked whenever
// a new event name is added. tests/integration/concierge-recovery-audience.test.js
// asserts it against a live database.

// Reaching any of these means the person actively tried to connect a tool. That
// includes the hosted path, where there is no config to copy and the only trace
// of the attempt is an OAuth consent screen that failed to hand off properly.
// Anyone here is emphatically NOT "someone who looked at onboarding and left".
const SETUP_ATTEMPT_EVENTS = [
  'setup_path_selected',
  'setup_path_changed',
  'mcp_config_copied',
  'mcp_connection_tested',
  'oauth_consent_viewed',
  'oauth_consent_signin_required',
  'oauth_consent_failed',
  'oauth_consent_approved',
  'onboarding_connection_detected',
];

// The MCP session actually started and the tool talked to us. Strictly further
// along than a setup attempt: the transport works.
const RUNTIME_EVENTS = [
  'mcp_runtime_started',
  'mcp_start_session_succeeded',
  'mcp_tool_call_succeeded',
];

// The product demonstrably did its job for this account.
//
// CORRECTED 2026-08-29: this comment used to say `first_sync_completed` is
// "client-side and fires once per BROWSER (localStorage, no server emitter), so
// it is unreliable alone". That has been false since 2026-07-10. The redundant
// browser-scoped client emitter was REMOVED then, and the event is now emitted
// server-side and idempotently per USER by sessionCatchupService
// .maybeEmitFirstSyncActivation, guarded by a product_events lookup — which is
// exactly why the dashboard exposes it as sync_health.has_first_sync and why
// onboarding_completed was re-gated onto it. What survives client-side is the
// GA4/Ads conversion in PostSyncModal (gaEvent), not the product event; the
// localStorage key there only stops that conversion double-firing.
//
// The correction matters because the stale comment told the next reader to
// distrust the single most reliable activation signal we have. All three are
// server-side and load-bearing; keep all three.
const ACTIVATION_EVENTS = [
  'first_sync_completed',
  'context_delivered',
  'connection_established',
];

// Any of these means "not dormant" — they got somewhere. Union by construction
// so that adding a rung above cannot silently widen the dormant audience.
const ENGAGED_EVENTS = [
  ...SETUP_ATTEMPT_EVENTS,
  ...RUNTIME_EVENTS,
  ...ACTIVATION_EVENTS,
];

// +clerk_test addresses are journey-test signups, not real mailboxes. Their
// bounces are charged against the sending domain's reputation.
const TEST_EMAIL_MARKER = '+clerk_test';

// Ladder position, low to high. Two events share a rung where they represent the
// same step reached by different routes (local config vs hosted consent). Used
// to answer "how far did this person actually get?" — the highest rung present.
//
// RUNGS 8 AND 9 ARE THE SAME STEP TO A CASUAL READER AND ARE NOT THE SAME
// ACCOUNT. `mcp_runtime_started` is emitted from the `initialize` handshake
// alone (apps/api/src/routes/mcp.js, and the local server in
// packages/mcp-server/src/index.ts) — the tool connected and the model has not
// called us once. `mcp_start_session_succeeded` / `mcp_tool_call_succeeded` are
// only ever written after a tool actually ran. "Installed and silent" versus
// "actually calling us" is a real and currently-populated distinction — three of
// the eight accounts that ever completed a handshake have never made a call —
// and a file that calls itself the one definition of the ladder should not have
// to be told the difference twice. So the handshake gets its own rung, below.
//
// The two call events stay tied to each other on purpose: both mean "the model
// invoked a tool", reached by different routes, which is exactly the shared-rung
// convention above. Nothing downstream needs to tell start_session apart from
// any other successful call.
//
// RENUMBERING RULE — the new rung is inserted ABOVE, never below. Making room by
// shifting the lower rungs down would be silent breakage: conciergeRecovery.js
// keys its STEP_PHRASE map by rank NUMBER and gates three of its hypotheses on
// hard-coded `rank <= 6` (the oauth-consent rungs) and `rank === 3` (the
// setup-path picker). Those comparisons carry no event names, so a downward
// shift would move the consent rung out from under them without a single test
// failing. Every rung at or below 7 therefore keeps the number it has always
// had; only the activation block moves, 9 -> 10, to make room.
const LADDER_RANK = {
  account_created: 0,
  onboarding_page_viewed: 1,
  mcp_setup_viewed: 2,
  setup_path_selected: 3,
  setup_path_changed: 3,
  mcp_config_copied: 4,
  mcp_connection_tested: 5,
  oauth_consent_viewed: 5,
  oauth_consent_signin_required: 6,
  oauth_consent_failed: 6,
  oauth_consent_approved: 6,
  onboarding_connection_detected: 7,
  // Transport up, nobody home: the client handshook and never called a tool.
  mcp_runtime_started: 8,
  // The model actually called us.
  mcp_start_session_succeeded: 9,
  mcp_tool_call_succeeded: 9,
  connection_established: 10,
  context_delivered: 10,
  first_sync_completed: 10,
};

// Every event this file knows about — the query surface for reconstructing one
// person's journey in a single round trip.
const LADDER_EVENTS = Object.keys(LADDER_RANK);

module.exports = {
  SETUP_ATTEMPT_EVENTS,
  RUNTIME_EVENTS,
  ACTIVATION_EVENTS,
  ENGAGED_EVENTS,
  TEST_EMAIL_MARKER,
  LADDER_RANK,
  LADDER_EVENTS,
};
