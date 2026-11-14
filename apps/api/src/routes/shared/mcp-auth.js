const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { redis } = require('../../config/redis');
const { requireAuth } = require('../../middleware/auth');
const { oauthActorLimiter } = require('../../middleware/rateLimit');
const { generateApiKey } = require('../../utils/security');
const db = require('../../config/db');
const productEvents = require('../../services/productEventsService');
const workspace = require('../../services/workspaceService');

// Ten minutes is short for what this actually is: a link printed into a terminal
// that a human has to notice, read, and carry to a browser. Thirty is closer to
// honest (RFC 8628's own example is 1800s).
//
// It cannot simply be raised, though. Clients at or below 1.0.44 poll /token for
// a HARDCODED ten minutes, so a longer server window would let somebody
// authorize at minute 20 into a tool that stopped listening at minute 10: the
// browser says "Authorized", the key is minted, and the tool silently never
// picks it up. That trades a loud 404 for a quiet lie, which is worse.
//
// So the client declares whether it honours the window the server states, and
// gets the long one only if it does. No release ordering to get right, and no
// version sniffing: the capability is asserted by the only party that knows.
// These live in config/deviceFlow.js because the rate limiter mounted over this
// route has to size its budget from the same numbers — see the poll limiter in
// middleware/rateLimit.js.
const {
    DEVICE_CODE_TTL,
    EXTENDED_DEVICE_CODE_TTL,
    DEVICE_POLL_INTERVAL_SECONDS,
} = require('../../config/deviceFlow');
// Self-hosted: PUBLIC_URL when DASHBOARD_URL is unset (config/selfHosted.js).
const DASHBOARD_URL = require('../../config/selfHosted').dashboardBaseUrl();
const MCP_API_KEY_TTL_DAYS = 90;
const MCP_API_KEY_SCOPES = ['context:read', 'context:write'];

// The local connect is a THREE-legged handshake and, until now, none of it was
// recorded: /start is fired by the MCP server on the user's machine, /authorize by
// the dashboard, /token by the MCP server again. If a user pasted the config and
// then never finished the browser step, every leg stayed silent — the runtime only
// reports mcp_runtime_started AFTER auth resolves, and its client promise is
// documented as "always pending until auth resolves, never rejects", so a failed or
// abandoned connect emitted nothing at all. In the 30d to 2026-08-19 that covered 15
// of the 17 users who copied a config: no runtime event, no error, no trace.
//
// The device code is the natural correlation key across the three legs, but it is
// also the bearer credential the MCP server polls with, so it must never be written
// to product_events or mirrored to PostHog. Hash it: both legs derive the same id
// without either storing the secret.
//
// /start has no actor yet. That is fine and deliberate — recordProductEvent stamps a
// NULL org and, when a later identified event carries the SAME session_id, backfills
// org_id/user_id onto the earlier row (and PostHog stitches the person by distinctId).
// So the anonymous attempt becomes attributable the moment the user authorizes.
function flowSessionId(deviceCode) {
    return `mcpdf-${crypto.createHash('sha256').update(String(deviceCode)).digest('hex').slice(0, 32)}`;
}

// Never let instrumentation break the auth handshake — this is the one flow where a
// failure means the user cannot connect at all.
function recordFlowEvent(actor, eventName, deviceCode, metadata = {}) {
    setImmediate(() => {
        productEvents.recordProductEvent(actor, {
            event_name: eventName,
            source: 'mcp_auth',
            surface: 'device_flow',
            session_id: flowSessionId(deviceCode),
            metadata,
        }).catch((err) => console.warn(`[MCP-AUTH] ${eventName} event failed:`, err.message));
    });
}

// What the MCP server says about itself at /start: an anonymous install id (a
// one-way hash the client derives from its own install token) and the package
// version. Without them every started sign-in looked the same, so ten starts
// could not be told apart from one person's ten restarts, and the leak between
// "started" and "completed" could not be sized by install or by release.
// Labels, not identity: shape-checked and bounded, and anything else dropped,
// because this is an unauthenticated route and the values reach product_events.
const INSTALL_ID_PATTERN = /^[a-f0-9]{16,64}$/;
const CLIENT_VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/;
function flowClientLabels(body) {
    const labels = {};
    if (typeof body?.install_id === 'string' && INSTALL_ID_PATTERN.test(body.install_id)) labels.install_id = body.install_id;
    if (typeof body?.client_version === 'string' && CLIENT_VERSION_PATTERN.test(body.client_version)) labels.client_version = body.client_version;
    return labels;
}

// How much of the original window is left. The authorized state replaces the
// pending key, and re-stamping it with a fixed TTL would silently shorten a
// thirty-minute flow back to ten at the moment it succeeds.
async function remainingTtl(deviceCode) {
    try {
        const ttl = await redis.ttl(`mcp:device:${deviceCode}`);
        if (Number.isFinite(ttl) && ttl > 0) return ttl;
    } catch { /* Redis without TTL support, or a stub: fall through. */ }
    return EXTENDED_DEVICE_CODE_TTL;
}

// POST /api/v1/auth/mcp/start — no auth, starts the device flow
router.post('/start', async (req, res) => {
    const deviceCode = crypto.randomBytes(16).toString('hex');
    const userCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    const ttl = req.body?.honors_server_expiry === true ? EXTENDED_DEVICE_CODE_TTL : DEVICE_CODE_TTL;
    const client = flowClientLabels(req.body);
    const hasClient = Object.keys(client).length > 0;

    try {
        await redis
            .multi()
            .set(
                `mcp:device:${deviceCode}`,
                // The labels ride along so the later legs can carry them too.
                JSON.stringify({ status: 'pending', user_code: userCode, ...(hasClient ? { client } : {}) }),
                'EX',
                ttl
            )
            .set(
                `mcp:user:${userCode}`,
                deviceCode,
                'EX',
                ttl
            )
            .exec();
    } catch (err) {
        console.error('[MCP-AUTH] Redis write failed:', err.message);
        return res.status(503).json({ error: 'service_unavailable' });
    }

    // Anonymous: proof a local runtime booted and tried to connect. Without this the
    // attempt is invisible unless it succeeds.
    recordFlowEvent(null, 'mcp_device_flow_started', deviceCode, client);

    res.json({
        device_code: deviceCode,
        user_code: userCode,
        verification_url: `${DASHBOARD_URL}/mcp-auth?code=${userCode}`,
        expires_in: ttl,
        // The MCP server has always read `expires_at` and we have always sent
        // only `expires_in`, so every client-side expiry check on this value was
        // reading undefined and passing unconditionally. Additive: `expires_in`
        // stays for anything already parsing it.
        expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
        interval: DEVICE_POLL_INTERVAL_SECONDS,
    });
});

// POST /api/v1/auth/mcp/authorize — requires Clerk auth, called from dashboard
//
// The limiter runs BEHIND requireAuth because it has to count the person, not
// the address: this route is reached through a Vercel server-side passthrough
// (apps/dashboard/src/pages/api/mcp-authorize.ts) that forwards no client IP,
// so an address-keyed bucket here is one shared bucket for everybody signed in
// to the dashboard, locking them out of a sign-in none of them can retry. The
// unauthenticated flood is bounded in front of the router, in app.js.
router.post('/authorize', requireAuth, oauthActorLimiter, async (req, res) => {
    const userCode = typeof req.body?.user_code === 'string'
        ? req.body.user_code.trim().toUpperCase()
        : null;
    if (!userCode) return res.status(400).json({ error: 'missing_user_code' });
    if (!/^[A-F0-9]{8}$/.test(userCode)) return res.status(400).json({ error: 'invalid_user_code' });

    // The PERSON the key belongs to, and the workspace they are working in —
    // both from workspaceService, like keys.js. The inline org_id-then-id
    // derivation stamped every device-flow key with the personal org, so it only
    // reached a team through bindWorkspace's active-row lookup at read time.
    const actorId = workspace.actorPersonId(req.actor);
    const ownerKey = workspace.defaultOwnerKey(req.actor);
    const orgId = ownerKey;

    // These 404s carried no `message`, and the dashboard renders
    // `body.message || \`HTTP ${res.status}\``. So the single most common way this
    // page fails — arriving after DEVICE_CODE_TTL, which is ten minutes, on a
    // link a human has to notice in a terminal and walk to a browser with —
    // showed the user the literal words "HTTP 404" and nothing else. Not what
    // expired, not that anything had expired, and not the one action that fixes
    // it. The remedy is never retrying this link; it is minting a new one.
    //
    // Expired and never-issued are indistinguishable here by construction: the
    // key is simply absent either way. So say the thing that is true of both,
    // rather than guessing at one.
    const EXPIRED_LINK_MESSAGE =
        'This sign-in link has expired or has already been used. Start sign-in again in your AI tool to get a fresh link — this one cannot be retried.';

    let existing;
    let deviceCode;
    try {
        deviceCode = await redis.get(`mcp:user:${userCode}`);
        if (!deviceCode) {
            return res.status(404).json({ error: 'invalid_user_code', message: EXPIRED_LINK_MESSAGE, terminal: true });
        }
        existing = await redis.get(`mcp:device:${deviceCode}`);
    } catch (err) {
        // Retryable, and distinct from the above on purpose: an outage must not
        // send somebody off to re-run a sign-in that was never the problem.
        console.error('[MCP-AUTH] Redis read failed:', err.message);
        return res.status(503).json({
            error: 'service_unavailable',
            message: 'We could not reach the sign-in service just now. Please try again in a moment.',
        });
    }

    if (!existing) {
        return res.status(404).json({ error: 'invalid_device_code', message: EXPIRED_LINK_MESSAGE, terminal: true });
    }

    const state = JSON.parse(existing);
    if (state.status === 'authorized') {
        return res.status(409).json({
            error: 'already_authorized',
            message: 'This link has already been used, so your tool should already be connected. If it is not, start sign-in again in your tool for a fresh link.',
            terminal: true,
        });
    }

    const { key, prefix, hash } = generateApiKey();
    const keyId = `key-${crypto.randomUUID()}`;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + MCP_API_KEY_TTL_DAYS);

    try {
        // Now that the key is stamped with the bound workspace, it must not
        // out-rank the person in it: a viewer gets a read-only key, as keys.js
        // already enforces for keys minted by hand.
        const role = await workspace.resolveRole(req.actor, orgId);
        const grantable = new Set(workspace.grantableScopes(role));
        const scopes = MCP_API_KEY_SCOPES.filter((scope) => grantable.has(scope));
        await db.query(
            'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
            [keyId, prefix, hash, 'DeerDawn MCP', actorId, orgId, 'production', expiresAt.toISOString(), scopes],
            'org-system'
        );
    } catch (err) {
        console.error('[MCP-AUTH] Failed to create API key:', err.message);
        return res.status(500).json({ error: 'internal_error', message: err.message });
    }

    try {
        await redis.set(
            `mcp:device:${deviceCode}`,
            JSON.stringify({
                status: 'authorized',
                api_key: key,
                user_code: userCode,
                // Carried so the /token pickup below can attribute to a real user; that
                // request is unauthenticated (it presents only the device code).
                owner: { id: actorId, org_id: orgId },
                ...(state.client ? { client: state.client } : {}),
            }),
            'EX',
            // Whatever remains of the original window: a code issued for thirty
            // minutes must still be collectable at minute twenty-nine.
            await remainingTtl(deviceCode)
        );
    } catch (err) {
        console.error('[MCP-AUTH] Redis write failed after key creation:', err.message);
        // The rollback of a key created a moment ago (nothing has used it, so no stamp
        // names it), through the one delete path all the same.
        await require('../../services/authorStampService').deleteApiKey({ keyId, scanContext: false }).catch(() => {});
        return res.status(503).json({ error: 'service_unavailable' });
    }

    console.log(`[MCP-AUTH] Key created for owner ${ownerKey}, key_id ${keyId}`);
    // Identified — this also backfills the anonymous /start row via the shared session_id.
    recordFlowEvent(req.actor, 'mcp_device_flow_authorized', deviceCode, flowClientLabels(state.client));
    res.json({ status: 'authorized' });
});

// GET /api/v1/auth/mcp/token?device_code=... — no auth, polled by MCP server
router.get('/token', async (req, res) => {
    const { device_code } = req.query;
    if (!device_code) return res.status(400).json({ error: 'missing device_code' });

    let raw;
    try {
        raw = await redis.get(`mcp:device:${device_code}`);
    } catch (err) {
        return res.status(503).json({ error: 'service_unavailable' });
    }

    if (!raw) return res.status(404).json({ error: 'expired_or_invalid' });

    const state = JSON.parse(raw);
    if (state.status !== 'authorized') return res.json({ status: 'pending' });

    // Delete after retrieval — one-time pickup
    await redis
        .multi()
        .del(`mcp:device:${device_code}`)
        .del(`mcp:user:${state.user_code}`)
        .exec()
        .catch(() => {});

    // The runtime actually collected the key. Distinct from 'authorized' on purpose:
    // the code is one-time pickup on a 10-minute TTL, so a user who approves in the
    // browser after their MCP server has already given up leaves a stranded key and
    // never connects. That gap is only visible as authorized-without-completed.
    recordFlowEvent(
        state.owner ? { type: 'user', id: state.owner.id, org_id: state.owner.org_id } : null,
        'mcp_device_flow_completed',
        device_code,
        flowClientLabels(state.client)
    );

    res.json({ status: 'authorized', api_key: state.api_key });
});

module.exports = router;
