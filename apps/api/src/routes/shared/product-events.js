const express = require('express');
const router = express.Router();
const { optionalAuth, requireAuth } = require('../../middleware/auth');
const { apiLimiter } = require('../../middleware/rateLimit');
const { recordProductEvent, getProductEventSummary } = require('../../services/productEventsService');
const toolUsageDays = require('../../services/toolUsageDays');

// THE LOCAL STDIO SERVER'S TOOL CALLS, COUNTED LIKE THE HOSTED ONES (Thing 3e).
//
// The local server (packages/mcp-server) reaches the API over plain REST with
// no header naming the tool it is serving, so no auth-middleware hook can tell
// a `recall` from a dashboard page load. What it DOES send, after every tool
// call — reads included, because its tools are not annotated read-only — is one
// of these events with metadata.tool_name, on the person's own credential. That
// is the single choke point: one content-free usage-day row per (person, UTC
// day, tool, client), exactly what routes/mcp.js writes for a hosted call. A
// hosted call never comes through here (the dispatcher records its events
// in-process), so nothing is counted twice; and an anonymous post has no
// person, so it records nothing.
const LOCAL_TOOL_CALL_EVENTS = new Set([
  'mcp_tool_call_succeeded',
  'mcp_start_session_succeeded',
  'mcp_tool_call_failed',
]);

function recordLocalToolUse(actor, event) {
  if (!actor || !event || event.source !== 'mcp' || !LOCAL_TOOL_CALL_EVENTS.has(event.event_name)) return;
  const toolName = event.metadata?.tool_name
    || (event.event_name === 'mcp_start_session_succeeded' ? 'start_session' : null);
  // Only a real DeerDawn tool name: a post naming anything else mints nothing.
  if (!toolName || !toolUsageDays.isKnownToolName(toolName)) return;
  toolUsageDays.recordToolUse(actor, { toolName, client: event.tool || event.surface || null });
}

// RL-01: the anonymous-writable event ingest must be rate-limited so it can't be used for
// unbounded row insertion / funnel poisoning. apiLimiter keys on the CF-aware client IP.
router.post('/', apiLimiter, optionalAuth, async (req, res) => {
  try {
    // The request's own User-Agent, forwarded so the PostHog mirror can stamp
    // it. Until now every relayed event — which is the whole activation funnel,
    // onboarding through both authorize screens — reached PostHog through
    // posthog-node carrying no `$raw_user_agent`, no `$browser` and no
    // `$current_url`. Real users and automation were indistinguishable on the
    // exact steps the activation work is judged on, and E-010's crawler
    // exclusion (which matches on UA) could never apply below the pageview.
    const event = await recordProductEvent(req.actor, req.body || {}, {
      userAgent: req.get('user-agent') || null,
    });
    recordLocalToolUse(req.actor, event);
    return res.status(201).json({ event });
  } catch (err) {
    if (err?.code === 'invalid_payload') {
      return res.status(400).json({ error: 'invalid_payload', message: err.message });
    }
    console.error('[PRODUCT_EVENTS] Failed to record event:', err?.message || err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.use(requireAuth);

router.get('/summary', async (req, res) => {
  try {
    const summary = await getProductEventSummary(req.actor);
    if (!summary) return res.status(403).json({ error: 'forbidden' });
    return res.json({ summary });
  } catch (err) {
    console.error('[PRODUCT_EVENTS] Failed to load summary:', err?.message || err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
module.exports.recordLocalToolUse = recordLocalToolUse;
