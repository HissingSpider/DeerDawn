const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { addAuditLog } = require('../../utils/auditLogger');
const { generateApiKey } = require('../../utils/security');
const { requireAuth, requireAnyScope } = require('../../middleware/auth');
const { CreateKeyRequestSchema } = require('../../schemas');
const apiKeyCache = require('../../services/apiKeyCache');
const { redis: redisClient } = require('../../config/redis');
const workspace = require('../../services/workspaceService');
const authorStamps = require('../../services/authorStampService');
const { LOCK_MESSAGES, orgLockReason } = require('../../services/lockReasons');

router.use(requireAuth);

// Get one-time onboarding API key (if available)
router.get('/onboarding', async (req, res) => {
    const userId = req.actor.id;
    if (!userId) return res.status(403).json({ error: 'forbidden' });

    try {
        const key = await redisClient.get(`onboarding:${userId}:api_key`);

        if (!key) {
            return res.json({ key: null });
        }

        // Delete after retrieval (one-time display)
        try {
            await redisClient.del(`onboarding:${userId}:api_key`);
        } catch (delErr) {
            // Non-critical: key will expire in 24 hours anyway
            console.error('Failed to delete onboarding key from Redis:', delErr.message);
        }

        res.json({ key });
    } catch (err) {
        console.error('Failed to retrieve onboarding key:', err);
        // Return null key instead of error if Redis is down
        res.json({ key: null });
    }
});

// Names the MCP auth flows stamp on the session tokens they auto-mint for the
// user: routes/oauth.js (mintAccessToken) uses 'DeerDawn MCP (OAuth)', and
// routes/mcp-auth.js (device-code flow) uses 'DeerDawn MCP'. Both are
// browser-connect session tokens the MCP client manages — not credentials the
// user created — and a fresh one is minted on every grant/refresh, so they pile
// up. Keep them out of the manual "API keys" list; this page is only for keys
// the user deliberately issues. Exact-match so a user key named similarly is
// never hidden.
const AUTO_MINTED_KEY_NAMES = ['DeerDawn MCP (OAuth)', 'DeerDawn MCP'];

router.get('/', async (req, res) => {
    // An API key is the credential MCP traffic arrives on, and its org_id is what
    // every subsequent request resolves owner_key from. Minting it against
    // req.actor.org_id — the personal org on the user row — sent an invited
    // teammate's entire agent loop into their own workspace instead of the
    // team's, silently, with the team product simply appearing empty.
    const orgId = workspace.defaultOwnerKey(req.actor);
    if (!orgId) return res.status(403).json({ error: 'forbidden', message: 'No org context' });

    try {
        // SCOPED TO THE PERSON, NOT THE WORKSPACE.
        //
        // orgId is now the BOUND workspace, so an unfiltered listing handed every
        // member the full credential inventory of the whole team. A key is a
        // credential: a teammate has no business enumerating other people's, and
        // knowing a key_id is the first half of deleting it. Administrators still
        // see all of them, because revoking a leaked key is their job.
        const role = await workspace.resolveRole(req.actor, orgId);
        const scopeToSelf = !workspace.canAdminister(role);
        const { rows } = await db.query(
            `SELECT key_id, prefix, name, environment, status, last_used_at, created_at
               FROM api_keys
              WHERE org_id = $1
                AND name <> ALL($2::text[])
                ${scopeToSelf ? 'AND owner_id = ANY($3::text[])' : ''}
              ORDER BY created_at DESC`,
            scopeToSelf
                ? [orgId, AUTO_MINTED_KEY_NAMES, workspace.actorIdentities(req.actor)]
                : [orgId, AUTO_MINTED_KEY_NAMES],
            orgId
        );
        res.json({ keys: rows });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// AUTHZ IS THE WORKSPACE ROLE, NOT users.role.
//
// requireRole reads req.actor.role — the org-level role on the user row, which is
// 'owner' for every self-provisioned account. Once orgId became the BOUND
// workspace, that gate stopped being an authorization check at all: a viewer
// invited into someone else's workspace passed it, and the key they minted was
// stamped with THAT workspace's org_id, so it resolved to it on every later
// request without even needing the header again. The role that matters is the
// one held in the workspace being acted on.
// TWO AXES, BOTH GATED. requireAnyScope is the CREDENTIAL's authority (a
// context:read key must not mint a context:write one, whatever its holder's
// role); the workspace role check inside is the PERSON's. requireRole used to
// blur the two, and dropping it for the role fix would have left the scope axis
// open — a read-only key minting itself a writable one.
router.post('/', requireAnyScope(['context:write', 'context:admin']), async (req, res) => {
    // An API key is the credential MCP traffic arrives on, and its org_id is what
    // every subsequent request resolves owner_key from. Minting it against
    // req.actor.org_id — the personal org on the user row — sent an invited
    // teammate's entire agent loop into their own workspace instead of the
    // team's, silently, with the team product simply appearing empty.
    const orgId = workspace.defaultOwnerKey(req.actor);

    if (!orgId) {
        return res.status(403).json({ error: 'forbidden', message: 'No org context' });
    }

    try {
        // A CREDENTIAL MAY NOT MINT A CREDENTIAL.
        //
        // Key actors are stamped role: 'operator' in the auth middleware — a
        // property of the KEY, not of the person holding it — and 'operator'
        // maps forward to 'member', which can write. So resolving the role of a
        // key actor answers a question about the credential and reads like an
        // answer about the human: every API key, whatever its owner's actual
        // role, looked like a member and could mint more keys. That is a
        // privilege ladder, and a leaked key climbing it is exactly the shape
        // this route must not have.
        //
        // Minting requires a human session. Nothing legitimate is lost: the MCP
        // device flow issues its own least-privilege keys server-side
        // (mcp-auth.js), and the dashboard is where a person mints one.
        if (req.actor?.type === 'key') {
            return res.status(403).json({
                error: 'forbidden',
                message: 'API keys cannot create other API keys. Sign in to the dashboard to mint one.',
            });
        }

        // MEMBERSHIP GATES MINTING; THE ROLE GATES WHAT THE KEY MAY CARRY.
        //
        // This used to refuse anyone who could not WRITE, which made
        // grantableScopes('viewer') dead code: a viewer — whose whole role is
        // reading the team's brief, and who reads it through an agent — could
        // mint no key at all. The ceiling below already stops a key from
        // out-ranking its holder, so the question here is only "do you belong
        // to this workspace". The binding middleware has checked that for a
        // header; this re-asks it so no path can mint into a workspace the
        // person does not hold (their own org before the membership backfill
        // reached them is the one exception, as in resolveRole).
        const personId = workspace.actorPersonId(req.actor);
        const membership = await workspace.getMembership(orgId, personId);
        if (!membership && orgId !== req.actor.org_id) {
            return res.status(403).json({
                error: 'forbidden',
                message: 'Minting an API key for this workspace requires membership in it.',
            });
        }
        const role = await workspace.resolveRole(req.actor, orgId);

        const orgCheck = await db.query('SELECT is_locked, dispute_lock_ids FROM organizations WHERE org_id = $1', [orgId], orgId);

        // Locked for a reason the person can act on, said in words (lockReasons.js).
        const lockReason = orgLockReason(orgCheck.rows[0]);
        if (lockReason) {
            return res.status(403).json({
                error: 'forbidden',
                lock_reason: lockReason,
                message: `API keys cannot be created while this workspace is locked. ${LOCK_MESSAGES[lockReason]}`,
            });
        }

        const validation = CreateKeyRequestSchema.safeParse(req.body);
        if (!validation.success) {
            return res.status(400).json({ error: 'invalid_request', details: validation.error.issues });
        }

        const { name, environment, scopes } = validation.data;
        // A key may never out-rank the person minting it. Without this a member
        // could mint themselves a context:admin key and use it to reach the
        // owner-only routes their own session is refused.
        //
        // Scopes the caller did not ASK for are the schema's default
        // (read + write), and are narrowed to what the role grants — the same
        // thing the MCP device flow does, so a viewer's default key is read-only
        // rather than a refusal. Scopes the caller DID ask for are a request,
        // and one beyond the role is refused with the reason, as before.
        const grantable = workspace.grantableScopes(role);
        const explicitScopes = Array.isArray(req.body?.scopes);
        const requested = explicitScopes
            ? [...new Set(scopes)]
            : [...new Set(scopes)].filter((scope) => grantable.includes(scope));
        const refused = requested.filter((scope) => !grantable.includes(scope));
        if (refused.length > 0) {
            return res.status(403).json({
                error: 'forbidden',
                message: `Your role in this workspace cannot grant: ${refused.join(', ')}.`,
            });
        }
        const uniqueScopes = requested;

        // THE NAME IS UNIQUE PER PERSON, BECAUSE THE LIST IS PER PERSON.
        //
        // orgId is the BOUND workspace, so checking the name across it made the
        // dashboard's default name — "Primary key" — first-come, first-served
        // for a whole team: the second person to join was refused with a 409
        // against a key they could not see, in a list of their own that was
        // empty. A key belongs to its holder; two people may each have one
        // called the same thing, exactly as they would in separate accounts.
        // Administrators, who do see everyone's, are not privileged here either:
        // uniqueness is a property of one person's own inventory.
        const dupCheck = await db.query(
            `SELECT key_id FROM api_keys
              WHERE org_id = $1 AND name = $2 AND status = 'active'
                AND owner_id = ANY($3::text[])`,
            [orgId, name, workspace.actorIdentities(req.actor)],
            orgId
        );

        if (dupCheck.rows.length > 0) {
            return res.status(409).json({ error: 'conflict', message: 'You already have an active API Key with this name.' });
        }

        const { key, prefix, hash } = generateApiKey();
        const keyId = `key-${crypto.randomUUID()}`;
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 90);

        await db.query(
            'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
            [keyId, prefix, hash, name || 'Unnamed Key', req.actor.id, orgId, environment, expiresAt.toISOString(), uniqueScopes],
            orgId
        );

        addAuditLog(req.actor, 'api_key.create', keyId, { name, environment });
        // `scopes` is what was actually GRANTED, which for a default request is
        // narrowed to the role: a viewer asking for nothing in particular gets a
        // read-only key, and the dashboard can only say so if it is told.
        res.status(201).json({
            key: { id: keyId, key, prefix, name, environment, status: 'active', scopes: [...uniqueScopes] },
        });
    } catch (err) {
        console.error('[KEYS] Failed to create API key:', err.message);
        res.status(500).json({
            error: 'internal_error',
            message: 'Failed to create API key'
        });
    }
});

// Same authorization correction as POST, plus ownership: deleting a teammate's
// key invalidates it in the cache and breaks their running agent mid-session.
router.delete('/:id', requireAnyScope(['context:write', 'context:admin']), async (req, res) => {
    // An API key is the credential MCP traffic arrives on, and its org_id is what
    // every subsequent request resolves owner_key from. Minting it against
    // req.actor.org_id — the personal org on the user row — sent an invited
    // teammate's entire agent loop into their own workspace instead of the
    // team's, silently, with the team product simply appearing empty.
    const orgId = workspace.defaultOwnerKey(req.actor);
    if (!orgId) return res.status(403).json({ error: 'forbidden' });

    const { id } = req.params;
    try {
    // First get the key_hash for cache invalidation
        const keyResult = await db.query(
            'SELECT key_hash, name, owner_id FROM api_keys WHERE key_id = $1 AND org_id = $2',
            [id, orgId],
            orgId
        );

        if (keyResult.rows.length === 0) {
            return res.status(404).json({ error: 'not_found' });
        }

        // Same reasoning as create: revoking a credential is account management,
        // and a leaked key must not be able to revoke the others.
        if (req.actor?.type === 'key') {
            return res.status(403).json({
                error: 'forbidden',
                message: 'API keys cannot revoke API keys. Sign in to the dashboard to manage them.',
            });
        }

        const role = await workspace.resolveRole(req.actor, orgId);
        const isOwnKey = workspace.actorIdentities(req.actor).includes(keyResult.rows[0].owner_id);
        if (!isOwnKey && !workspace.canAdminister(role)) {
            // 403 rather than 404, matching the contract this route has always
            // had. A 404 would hide whether the key exists, but the id is an
            // unguessable uuid the caller must already hold, so the disclosure
            // is worth less than the clarity — and changing an established
            // status code is a behaviour change that does not belong in a
            // security fix.
            return res.status(403).json({
                error: 'forbidden',
                message: 'This key belongs to someone else. Only its owner or a workspace owner can revoke it.',
            });
        }

        const keyHash = keyResult.rows[0].key_hash;
        const keyName = keyResult.rows[0].name;

        // Delete the key, after re-stamping everything that names it as an author to
        // its owner (journey r7): a stamp that outlives its key resolves to nobody.
        await authorStamps.deleteApiKey({ keyId: id, orgId });

        // Invalidate cache across all instances
        await apiKeyCache.invalidateApiKey(keyHash);

        addAuditLog(req.actor, 'api_key.delete', id, { name: keyName });
        res.json({ success: true });
    } catch (err) {
        console.error('[KEYS] Delete error:', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

module.exports = router;
