'use strict';

/**
 * PATCH /teams/projects/:id/sharing — WHAT A PAYLOAD THAT OMITS SOMETHING MEANS.
 *
 * The sharing panel shipped in #484 made this route the only way a section
 * policy is ever written, and it writes the WHOLE share every time: sections and
 * per-project member overrides both. Two regressions follow from treating a
 * partial payload as authoritative, and both are silent.
 *
 *   1. AN OMITTED `sections` DOWNGRADED THE SHARE. A project with no stored rows
 *      travels today's defaults, and canEditSectionForActor's no-row fallback
 *      makes every one of those defaults WRITABLE. The route answered an empty
 *      sections array by writing the default rows with
 *      `can_edit: section_key !== 'recent_decisions'` — so the first save of a
 *      project that already shared a writable decision log turned it read-only,
 *      without asking and without saying so.
 *
 *   2. AN OMITTED `members` DELETED THE OVERRIDES. upsertProjectShare DELETEs
 *      every context_project_members row before re-inserting the payload's, and
 *      the panel never sends members at all — so ticking one section wiped every
 *      per-project role grant in the project.
 *
 * The rule pinned here: a key the payload does not carry is a key the caller is
 * not editing. Omission preserves; an explicit value replaces.
 *
 * Behavioural against the real router (module stubs, no database), in the shape
 * teams-setup-defects.test.js established.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

let currentActor = { id: 'user-owner', org_id: 'org-personal', workspace_key: 'org-team' };

const authMiddleware = require('../../src/middleware/auth');
authMiddleware.requireAuth = (req, _res, next) => {
    req.actor = { ...currentActor };
    next();
};

const entitlements = require('../../src/services/entitlementService');
entitlements.checkFeature = async () => true;
entitlements.checkLimit = async () => true;
entitlements.getEntitlements = async () => ({ limits: {}, features: {} });

const db = require('../../src/config/db');
// The route reads `visibility` alongside the author now — the sharing gate asks
// who wrote the project and where it currently lives, not just whether the
// caller administers the workspace. Matched on the leading columns so the stub
// does not have to be re-pinned every time the projection grows.
db.query = async (sql) => {
    if (/SELECT project_id, owner_key, owner_user_id.* FROM context_projects/.test(sql)) {
        return {
            rows: [{
                project_id: 'proj-1',
                owner_key: 'org-team',
                owner_user_id: 'user-owner',
                visibility: 'shared',
            }],
            rowCount: 1,
        };
    }
    return { rows: [], rowCount: 0 };
};

const workspace = require('../../src/services/workspaceService');
workspace.resolveRole = async () => 'owner';

const contextStore = require('../../src/store/contextSyncStore');
let stored = { share: null, sections: [], members: [] };
const upserts = [];
contextStore.getProjectShare = async () => ({
    share: stored.share,
    sections: stored.sections.map((row) => ({ ...row })),
    members: stored.members.map((row) => ({ ...row })),
});
contextStore.upsertProjectShare = async (projectId, payload) => {
    upserts.push({ projectId, payload });
    stored = {
        share: { enabled: payload.enabled },
        sections: payload.sections || [],
        members: payload.members || [],
    };
};

const teamsRouter = require('../../src/routes/shared/teams');

function appWith() {
    const app = express();
    app.use(express.json());
    app.use('/teams', teamsRouter);
    return app;
}

function reset(initial = { share: null, sections: [], members: [] }) {
    upserts.length = 0;
    stored = initial;
    currentActor = { id: 'user-owner', org_id: 'org-personal', workspace_key: 'org-team' };
}

const lastPayload = () => upserts[upserts.length - 1].payload;

// ─── 1. The first save must not downgrade what the project already had ───────

test('a save that carries no sections does not freeze a downgraded policy onto an unconfigured share', async () => {
    // No stored rows: this project travels today's defaults, and every one of
    // those defaults is writable (canEditSectionForActor falls back to
    // DEFAULT_SHARED_SECTIONS.includes(sectionKey) when no row exists).
    reset();

    const res = await request(appWith())
        .patch('/teams/projects/proj-1/sharing')
        .send({ visibility: 'shared' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    const rows = lastPayload().sections || [];
    const decisions = rows.find((row) => row.section_key === 'recent_decisions');
    assert.ok(
        !decisions || decisions.can_edit === true,
        'a payload that says nothing about sections must not turn the decision log read-only: ' +
        'before this save a teammate could write it, and nobody asked for that to change',
    );
});

test('an omitted sections key preserves the rows the author saved', async () => {
    reset({
        share: { enabled: true },
        sections: [
            { section_key: 'current_task', can_view: true, can_edit: true },
            { section_key: 'recent_decisions', can_view: true, can_edit: true },
            { section_key: 'todo_items', can_view: false, can_edit: false },
        ],
        members: [],
    });

    const res = await request(appWith())
        .patch('/teams/projects/proj-1/sharing')
        .send({ visibility: 'private' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    assert.deepStrictEqual(
        (lastPayload().sections || []).map((row) => [row.section_key, row.can_view, row.can_edit]),
        [
            ['current_task', true, true],
            ['recent_decisions', true, true],
            ['todo_items', false, false],
        ],
        'changing visibility is not a decision about sections; the saved policy has to survive it',
    );
});

test('an explicit sections array still replaces the policy', async () => {
    reset({
        share: { enabled: true },
        sections: [{ section_key: 'current_task', can_view: true, can_edit: true }],
        members: [],
    });

    await request(appWith())
        .patch('/teams/projects/proj-1/sharing')
        .send({
            visibility: 'shared',
            sections: [
                { section_key: 'current_task', can_view: true, can_edit: false },
                { section_key: 'recent_decisions', can_view: false, can_edit: false },
            ],
        });

    assert.deepStrictEqual(
        (lastPayload().sections || []).map((row) => [row.section_key, row.can_view, row.can_edit]),
        [['current_task', true, false], ['recent_decisions', false, false]],
        'an author who sends a policy gets the policy they sent',
    );
});

// ─── 2. Every toggle deleted the per-project member overrides ────────────────

test('a sections-only save keeps the per-project member overrides', async () => {
    reset({
        share: { enabled: true },
        sections: [{ section_key: 'current_task', can_view: true, can_edit: true }],
        members: [
            { user_id: 'user-bob', role_override: 'viewer' },
            { user_id: 'user-carol', role_override: 'member' },
        ],
    });

    const res = await request(appWith())
        .patch('/teams/projects/proj-1/sharing')
        .send({
            visibility: 'shared',
            sections: [{ section_key: 'current_task', can_view: true, can_edit: true }],
        });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    assert.deepStrictEqual(
        (lastPayload().members || []).map((row) => [row.user_id, row.role_override]),
        [['user-bob', 'viewer'], ['user-carol', 'member']],
        'upsertProjectShare deletes every member row before re-inserting the payload\'s, and the ' +
        'panel sends none — so ticking a section silently revoked every per-project grant',
    );
});

test('an explicit empty members array still clears the overrides', async () => {
    reset({
        share: { enabled: true },
        sections: [{ section_key: 'current_task', can_view: true, can_edit: true }],
        members: [{ user_id: 'user-bob', role_override: 'viewer' }],
    });

    await request(appWith())
        .patch('/teams/projects/proj-1/sharing')
        .send({ visibility: 'shared', members: [] });

    assert.deepStrictEqual(
        lastPayload().members,
        [],
        'saying "no overrides" is a decision, and it must still be expressible',
    );
});

// ─── A failed read is not an empty share ─────────────────────────────────────

test('a failed read of the stored share answers 5xx and writes nothing', async () => {
    reset({
        share: { enabled: true },
        sections: [{ section_key: 'current_task', can_view: true, can_edit: true }],
        members: [{ user_id: 'user-bob', role_override: 'member' }],
    });
    const realRead = contextStore.getProjectShare;
    contextStore.getProjectShare = async () => { throw new Error('connection terminated unexpectedly'); };
    try {
        const res = await request(appWith())
            .patch('/teams/projects/proj-1/sharing')
            .send({ visibility: 'shared' });
        assert.ok(res.status >= 500, `a read error was treated as an empty share (status ${res.status})`);
        assert.strictEqual(
            upserts.length,
            0,
            'THE BUG: the upsert ran with nothing to preserve, and it deletes every section and member row first',
        );
    } finally {
        contextStore.getProjectShare = realRead;
    }
});

test('a legacy role_override is carried across a save, in its current name', async () => {
    reset({
        share: { enabled: true },
        sections: [],
        // Written before the three-role model. Maps forward to `member`.
        members: [{ user_id: 'user-bob', role_override: 'operator' }, { user_id: 'user-cy', role_override: 'viewer' }],
    });
    const res = await request(appWith())
        .patch('/teams/projects/proj-1/sharing')
        .send({ visibility: 'shared', sections: [{ section_key: 'current_task', can_view: true, can_edit: true }] });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const members = lastPayload().members || [];
    assert.deepStrictEqual(
        members.map((m) => m.user_id).sort(),
        ['user-bob', 'user-cy'],
        'THE BUG: saving a section toggle revoked the override of everyone whose row predates the three roles',
    );
    const bob = members.find((m) => m.user_id === 'user-bob');
    assert.strictEqual(bob.role_override, workspace.normalizeRole('operator'));
});

// ─── The sharing LIST obeys the same three states as every other read ────────

test('GET /projects-sharing does not list a colleague\'s personal project, even to an owner', async () => {
    reset();
    const realQuery = db.query;
    db.query = async (sql, ...rest) => {
        if (/FROM context_projects\s+WHERE owner_key = \$1\s+ORDER BY updated_at DESC/.test(String(sql))) {
            return {
                rows: [
                    { project_id: 'p-mine', owner_key: 'org-team', owner_user_id: 'user-owner', visibility: 'personal', project_name: 'My side project', updated_at: new Date() },
                    { project_id: 'p-theirs-personal', owner_key: 'org-team', owner_user_id: 'user-bob', visibility: 'personal', project_name: 'Bob job search', updated_at: new Date() },
                    { project_id: 'p-theirs-private', owner_key: 'org-team', owner_user_id: 'user-bob', visibility: 'private', project_name: 'Bob billing spike', updated_at: new Date() },
                    { project_id: 'p-theirs-shared', owner_key: 'org-team', owner_user_id: 'user-bob', visibility: 'shared', project_name: 'Payments API', updated_at: new Date() },
                    { project_id: 'p-legacy', owner_key: 'org-team', owner_user_id: null, visibility: 'shared', project_name: 'Legacy', updated_at: new Date() },
                ],
                rowCount: 5,
            };
        }
        return realQuery(sql, ...rest);
    };
    const realRole = workspace.resolveRole;
    try {
        // As an OWNER: private is theirs to read, personal is nobody's but Bob's.
        workspace.resolveRole = async () => 'owner';
        const asOwner = await request(appWith()).get('/teams/projects-sharing');
        assert.strictEqual(asOwner.status, 200, JSON.stringify(asOwner.body));
        const ownerSees = asOwner.body.projects.map((p) => p.project_id).sort();
        assert.ok(!ownerSees.includes('p-theirs-personal'), 'THE BUG: a colleague\'s personal project name was listed');
        assert.deepStrictEqual(ownerSees, ['p-legacy', 'p-mine', 'p-theirs-private', 'p-theirs-shared']);

        // As a MEMBER: neither personal nor private.
        workspace.resolveRole = async () => 'member';
        currentActor = { id: 'user-cy', org_id: 'org-cy', workspace_key: 'org-team' };
        const asMember = await request(appWith()).get('/teams/projects-sharing');
        if (asMember.status === 200) {
            const memberSees = asMember.body.projects.map((p) => p.project_id).sort();
            assert.deepStrictEqual(memberSees, ['p-legacy', 'p-theirs-shared']);
        } else {
            // The route may refuse non-owners outright; that is stricter, not a leak.
            assert.ok([401, 403].includes(asMember.status), `unexpected status ${asMember.status}`);
        }
    } finally {
        db.query = realQuery;
        workspace.resolveRole = realRole;
    }
});
