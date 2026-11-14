'use strict';

/**
 * POST /api/v1/orgs/join MUST NOT HAND OUT OWNERSHIP.
 *
 * The route took an org-wide `invite_code` and rewrote `users.org_id` to the
 * target workspace without writing a workspace_members row. resolveRole then
 * found no membership and fell through to its last branch — "somebody in their
 * OWN workspace before the backfill reaches them" — which matched, because
 * org_id had just been rewritten. That returns normalizeRole(users.role), and
 * users.role is 'admin' for nearly every self-signup, which maps forward to
 * 'owner'. Anyone holding the code became a workspace OWNER: billing, the
 * membership roster, and read access to every `private` project in it.
 *
 * It also reported failure after succeeding (the old-org cleanup DELETE raises
 * a foreign-key error, the catch turned that into a 500, and the escalation had
 * already been written) and deleted the joiner's own personal workspace on the
 * way through.
 *
 * These assertions are about the ROLE THE JOINER ENDS UP WITH and about which
 * writes reach the database — not about how the handler is spelled. The role is
 * read back through the real workspaceService.resolveRole, over a fake of the
 * tables it actually queries, so the escalation is observed the way an attacker
 * would experience it rather than inferred from source text.
 */

process.env.DISABLE_REDIS = 'true';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

const TEAM = 'org-team-acme';
const JOINER_ORG = 'org-personal-joiner';
const JOINER = 'user-joiner';
const JOINER_EMAIL = 'newhire@acme.test';
const CODE = 'TEAMCODE';

// ── an in-memory stand-in for the three tables this flow touches ─────────────

const fake = {
    members: [],
    invites: [],
    domains: [],
    orgs: [{ org_id: TEAM, name: 'Acme Engineering', invite_code: CODE }],
    usersInTargetOrg: 1,
    writes: [],
};

function resetFake() {
    fake.members = [{ owner_key: TEAM, user_id: 'user-founder', role: 'owner', removed_at: null, joined_at: '2026-01-01' }];
    fake.invites = [];
    fake.domains = [];
    fake.usersInTargetOrg = 1;
    fake.writes = [];
    fake.seatCapReached = false;
    fake.seatCap = null;
    fake.seatCountsSeen = [];
    // Tracked, not asserted directly: the old route MOVED the joiner's users row
    // into the target org, and that move is what the role fallback reads.
    fake.joinerOrgId = JOINER_ORG;
}

const db = require('../../src/config/db');

db.query = async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^(CREATE|ALTER|DROP)/i.test(text)) return { rows: [], rowCount: 0 };

    // Anything that mutates is recorded: the destructive legacy writes are
    // asserted absent by name below.
    if (/^(INSERT|UPDATE|DELETE)/i.test(text)) fake.writes.push({ text, params });

    if (/SELECT org_id, name FROM organizations WHERE invite_code/.test(text)) {
        const row = fake.orgs.find((o) => o.invite_code === params[0]);
        return { rows: row ? [{ org_id: row.org_id, name: row.name }] : [], rowCount: row ? 1 : 0 };
    }
    if (/SELECT email FROM users WHERE user_id/.test(text)) {
        return { rows: [{ email: JOINER_EMAIL }], rowCount: 1 };
    }
    // The legacy route's own queries, answered so it gets all the way through
    // and the escalation can be OBSERVED rather than masked by a crash.
    if (/SELECT role FROM users WHERE user_id/.test(text)) {
        return { rows: [{ role: 'admin' }], rowCount: 1 };
    }
    if (/UPDATE users SET org_id/.test(text)) {
        fake.joinerOrgId = params[0];
        return { rows: [], rowCount: 1 };
    }
    if (/SELECT COUNT\(\*\) AS count FROM users WHERE org_id/.test(text)) {
        return { rows: [{ count: '1' }], rowCount: 1 };
    }
    if (/SELECT COUNT\(\*\) FROM users WHERE org_id/.test(text)) {
        return { rows: [{ count: '0' }], rowCount: 1 };
    }
    if (/DELETE FROM organizations/.test(text)) {
        return { rows: [], rowCount: 1 };
    }
    if (/FROM workspace_invites WHERE owner_key/.test(text)) {
        const rows = fake.invites
            .filter((i) => i.owner_key === params[0])
            .map((i) => ({ ...i, expired: false }));
        return { rows, rowCount: rows.length };
    }
    if (/UPDATE workspace_invites SET accepted_at/.test(text)) {
        const invite = fake.invites.find((i) => i.owner_key === params[0] && i.invite_id === params[1]);
        if (invite) invite.accepted_at = 'now';
        return { rows: [], rowCount: invite ? 1 : 0 };
    }
    if (/FROM workspace_domains d/.test(text)) {
        const rows = fake.domains.filter((d) => d.domain === params[0]);
        return { rows, rowCount: rows.length };
    }
    if (/SELECT COUNT\(\*\) FILTER \(WHERE removed_at IS NULL\)/.test(text)) {
        const rows = fake.members.filter((m) => m.owner_key === params[0]);
        return { rows: [{ active: rows.filter((m) => !m.removed_at).length, total: rows.length }], rowCount: 1 };
    }
    if (/SELECT COUNT\(\*\)::int AS n FROM users u/.test(text)) {
        return { rows: [{ n: fake.usersInTargetOrg }], rowCount: 1 };
    }
    if (/SELECT owner_key, user_id, role, joined_at, invited_by FROM workspace_members/.test(text)) {
        const row = fake.members.find((m) => m.owner_key === params[0] && m.user_id === params[1] && !m.removed_at);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (/INSERT INTO workspace_members/.test(text)) {
        const [owner_key, user_id, role, invited_by] = params;
        const existing = fake.members.find((m) => m.owner_key === owner_key && m.user_id === user_id);
        if (existing) Object.assign(existing, { role, removed_at: null });
        else fake.members.push({ owner_key, user_id, role, invited_by, removed_at: null, joined_at: '2026-09-18' });
        return { rows: [], rowCount: 1 };
    }
    if (/SELECT user_id FROM workspace_members/.test(text)) {
        const row = fake.members.find((m) => m.owner_key === params[0] && !m.removed_at);
        return { rows: row ? [{ user_id: row.user_id }] : [], rowCount: row ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
};

// workspaceService.addMember runs its precheck, membership insert, backfill
// claim and visibility flip as ONE transaction on its own client, serialised by
// a per-workspace advisory lock, so the fake has to answer that client as well
// as db.query. Same table model; the transaction control statements and the lock
// are no-ops in memory, and the flip's UPDATE falls through to the empty default.
db.pool = {
    connect: async () => ({
        query: async (sql, params = []) => {
            const text = String(sql).replace(/\s+/g, ' ').trim();
            if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(text) || /pg_advisory/.test(text)) {
                return { rows: [], rowCount: 0 };
            }
            return db.query(sql, params);
        },
        release() {},
    }),
};

// ── module stubs that must be in place before orgs.js destructures them ──────

const authMiddleware = require('../../src/middleware/auth');
authMiddleware.requireAuth = (req, _res, next) => {
    // An ordinary self-signup: their own personal org, org-level role 'admin'
    // (the default for nearly everyone), no membership anywhere else.
    req.actor = { id: JOINER, org_id: JOINER_ORG, role: 'admin', email: JOINER_EMAIL };
    next();
};

const entitlements = require('../../src/services/entitlementService');
entitlements.checkFeature = async () => true;
entitlements.getEntitlements = async () => ({ limits: {}, features: {} });
entitlements.checkLimit = async (_orgId, _limit, currentCount) => {
    // The real comparison (entitlementService.checkLimit): refused once the
    // count the caller reports has reached the cap. Numeric, so a test can see
    // WHAT the route counted and not only whether it asked.
    fake.seatCountsSeen.push(currentCount);
    if (fake.seatCapReached || (Number.isFinite(fake.seatCap) && currentCount >= fake.seatCap)) {
        const err = new Error('This workspace is out of seats.');
        err.status = 402;
        err.code = 'limit_exceeded';
        throw err;
    }
    return true;
};

const enforcement = require('../../src/services/enforcementService');
enforcement.invalidateOrgCache = async () => {};

const workspace = require('../../src/services/workspaceService');
const orgsRouter = require('../../src/routes/shared/orgs');

function join() {
    const app = express();
    app.use(express.json());
    app.use('/orgs', orgsRouter);
    return request(app).post('/orgs/join').send({ invite_code: CODE });
}

/**
 * The role the joiner actually holds afterwards, read the way every route reads
 * it — including the org_id the join may have rewritten, since that rewrite is
 * precisely what the role fallback keys on.
 */
async function roleInTarget() {
    return workspace.resolveRole({ id: JOINER, org_id: fake.joinerOrgId, role: 'admin' }, TEAM);
}

// ── the defect ───────────────────────────────────────────────────────────────

test('an uninvited code-holder cannot join at all', async () => {
    resetFake();

    const res = await join();

    // The ROLE first, because that is the defect: this used to return 200 and
    // leave the code-holder resolving to 'owner' of somebody else's workspace.
    assert.strictEqual(await roleInTarget(), 'viewer',
        'an uninvited code-holder ended up holding a role in a workspace that never invited them');
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.error, 'not_invited');
});

test('joining never makes anyone an owner of somebody else\'s workspace', async () => {
    resetFake();
    fake.invites.push({ invite_id: 'inv-1', owner_key: TEAM, email: JOINER_EMAIL, role: 'member', invited_by: 'user-founder', accepted_at: null });

    const res = await join();

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.role, 'member');
    assert.strictEqual(await roleInTarget(), 'member',
        'the invitation said member; the joiner resolved to something else');
    assert.ok(!workspace.canAdminister(await roleInTarget()),
        'joining handed out administration of the workspace');
});

test('the join is recorded as MEMBERSHIP, not by rewriting users.org_id', async () => {
    resetFake();
    fake.invites.push({ invite_id: 'inv-1', owner_key: TEAM, email: JOINER_EMAIL, role: 'member', invited_by: null, accepted_at: null });

    await join();

    assert.ok(
        fake.writes.some((w) => /INSERT INTO workspace_members/.test(w.text)),
        'no membership row was written, so the role fallback decides who this person is'
    );
    assert.ok(
        !fake.writes.some((w) => /UPDATE users SET org_id/.test(w.text)),
        'users.org_id was rewritten — that is what makes resolveRole fall through to the org-level role'
    );
    assert.ok(
        !fake.writes.some((w) => /DELETE FROM organizations/.test(w.text)),
        'joining a team deleted the joiner\'s own workspace'
    );
});

test('an approved email domain is the other door, and it sets the role too', async () => {
    resetFake();
    fake.domains.push({ owner_key: TEAM, domain: 'acme.test', role: 'viewer', name: 'Acme Engineering' });

    const res = await join();

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(await roleInTarget(), 'viewer',
        'the domain policy said viewer');
});

test('an accepted invitation is consumed, so it stops holding a seat', async () => {
    resetFake();
    fake.invites.push({ invite_id: 'inv-1', owner_key: TEAM, email: JOINER_EMAIL, role: 'member', invited_by: null, accepted_at: null });

    const res = await join();

    assert.strictEqual(res.body.invite_consumed, true);
    assert.ok(fake.invites[0].accepted_at, 'the invitation is still open and still redeemable');
});

test('the seat cap covers this door too', async () => {
    resetFake();
    fake.invites.push({ invite_id: 'inv-1', owner_key: TEAM, email: JOINER_EMAIL, role: 'member', invited_by: null, accepted_at: null });
    fake.seatCapReached = true;

    const res = await join();

    assert.strictEqual(res.status, 402, JSON.stringify(res.body));
    assert.strictEqual(await roleInTarget(), 'viewer', 'an over-cap workspace admitted somebody anyway');
});

test('an invitation addressed to somebody else is not an invitation', async () => {
    resetFake();
    fake.invites.push({ invite_id: 'inv-1', owner_key: TEAM, email: 'someone.else@acme.test', role: 'owner', invited_by: null, accepted_at: null });
    // No domain approval — only the colleague's invite exists.

    const res = await join();

    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(await roleInTarget(), 'viewer');
});

test('the joiner\'s own invitation is not counted as a second seat', async () => {
    resetFake();
    // A three-seat workspace: the founder, one colleague, and ONE invitation out
    // — this person's. The seat was counted when the invitation was sent.
    fake.members.push({ owner_key: TEAM, user_id: 'user-colleague', role: 'member', removed_at: null, joined_at: '2026-02-01' });
    fake.invites.push({ invite_id: 'inv-1', owner_key: TEAM, email: JOINER_EMAIL, role: 'member', invited_by: null, accepted_at: null });
    fake.seatCap = 3;

    const res = await join();

    assert.strictEqual(
        res.status,
        200,
        `THE BUG: the last invited person was refused the seat held for them (route counted ${fake.seatCountsSeen.join(', ')} of 3): ${JSON.stringify(res.body)}`,
    );
    assert.strictEqual(await roleInTarget(), 'member');
});

test('somebody else\'s pending invitation still holds its seat', async () => {
    resetFake();
    fake.members.push({ owner_key: TEAM, user_id: 'user-colleague', role: 'member', removed_at: null, joined_at: '2026-02-01' });
    fake.invites.push({ invite_id: 'inv-1', owner_key: TEAM, email: JOINER_EMAIL, role: 'member', invited_by: null, accepted_at: null });
    fake.invites.push({ invite_id: 'inv-2', owner_key: TEAM, email: 'another.hire@acme.test', role: 'member', invited_by: null, accepted_at: null });
    fake.seatCap = 3;

    const res = await join();

    assert.strictEqual(res.status, 402, 'a fourth person was admitted to a three-seat workspace');
});

test('joining puts the person IN the workspace they joined', async () => {
    resetFake();
    fake.invites.push({ invite_id: 'inv-1', owner_key: TEAM, email: JOINER_EMAIL, role: 'member', invited_by: null, accepted_at: null });
    const activations = [];
    const realActivate = workspace.activateJoinedWorkspace;
    workspace.activateJoinedWorkspace = async (ownerKey, userId) => { activations.push([ownerKey, userId]); return true; };
    try {
        const res = await join();
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(
            activations,
            [[TEAM, JOINER]],
            'THE BUG: a member of the team whose keys and dashboard still point at their personal workspace',
        );
        assert.strictEqual(res.body.activated, true);
    } finally {
        workspace.activateJoinedWorkspace = realActivate;
    }
});
