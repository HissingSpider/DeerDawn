const express = require('express');
const router = express.Router();
const { requireAuth, requireAnyScope } = require('../../middleware/auth');
const { apiLimiter } = require('../../middleware/rateLimit');
const { addAuditLog } = require('../../utils/auditLogger');
const workspace = require('../../services/workspaceService');
const { hostedConnections } = require('../oauth');

// HOSTED CONNECTIONS: the AI tools a person has let into their DeerDawn memory
// over OAuth (Claude.ai, ChatGPT, an editor on the hosted endpoint), and the
// way to take one back out.
//
// The consent screen tells a person "You can revoke access any time from your
// dashboard settings". This is the route that makes the sentence true. The
// token model — what a connection is, how its access and refresh tokens are
// retired — is routes/oauth.js's; this is only the dashboard's door to it.
//
// STRICTLY THE PERSON'S OWN, HERE. A grant is a person's credential, made at
// their consent and carrying their own org, so it is found by the person
// (owner_id) wherever it was made — a teammate working in a team workspace
// still finds theirs — and nobody else reaches it through this route, a
// workspace owner included. An owner's power over the connections a colleague
// approved FOR THE TEAM WORKSPACE is a separate, narrower door with its own
// gate: GET/DELETE /api/v1/teams/connections (routes/shared/teams.js).

router.use(apiLimiter);
router.use(requireAuth);

router.get('/', async (req, res) => {
  const personIds = workspace.actorIdentities(req.actor).filter(Boolean);
  if (!personIds.length) return res.status(403).json({ error: 'forbidden' });
  try {
    const connections = await hostedConnections.list(personIds);
    res.json({ connections });
  } catch (err) {
    console.error('[CONNECTIONS] List failed:', err.message);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Same gates as revoking an API key: a write scope, and a human. A leaked key
// must not be able to cut a person off from their own tools.
router.delete('/:connectionId', requireAnyScope(['context:write', 'context:admin']), async (req, res) => {
  if (req.actor?.type === 'key') {
    return res.status(403).json({
      error: 'forbidden',
      message: 'API keys cannot disconnect connected apps. Sign in to the dashboard to manage them.',
    });
  }
  const personIds = workspace.actorIdentities(req.actor).filter(Boolean);
  const connectionId = String(req.params.connectionId || '');
  if (!personIds.length) return res.status(403).json({ error: 'forbidden' });
  if (!/^conn_[0-9a-f]{32}$/.test(connectionId)) return res.status(404).json({ error: 'not_found' });

  try {
    const result = await hostedConnections.disconnect(personIds, connectionId);
    // Not this person's, or already gone: one answer for both, so the route
    // says nothing about anybody else's connections.
    if (!result) return res.status(404).json({ error: 'not_found', message: 'That connection is not connected.' });

    addAuditLog(req.actor, 'oauth_connection.disconnect', connectionId, {
      client_name: result.connection.client_name,
      revoked: result.revoked,
    });
    if (result.remaining.access_tokens || result.remaining.refresh_tokens) {
      // Say so rather than report a disconnect the read-back contradicts.
      console.error(`[CONNECTIONS] Disconnect of ${connectionId} left credentials behind: ${JSON.stringify(result.remaining)}`);
      return res.status(500).json({
        error: 'disconnect_incomplete',
        message: 'The connection was not fully disconnected. Try again.',
        remaining: result.remaining,
      });
    }
    return res.json({
      disconnected: true,
      connection: result.connection,
      revoked: result.revoked,
      remaining: result.remaining,
    });
  } catch (err) {
    console.error('[CONNECTIONS] Disconnect failed:', err.message);
    return res.status(500).json({ error: 'internal_error', message: 'Could not disconnect. Try again.' });
  }
});

module.exports = router;
