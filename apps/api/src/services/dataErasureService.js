// DS-01: single source of truth for erasing all of an owner's (org's) data — GDPR right-to-erasure.
// Wired to both the account-delete endpoint and the Clerk user.deleted webhook so neither can drift
// and silently orphan encrypted credentials, globals, or embeddings.
//
// owner_key === org_id for org-scoped data; each table is deleted by the column it actually uses.
// Per-table try/catch so a missing optional table never aborts the rest of the erasure.
//
// ERASURE IS NOT ONLY A DELETE STATEMENT.
//
// Deleting the rows left the account signed in. Three things outlive the tables,
// and each of them is the point of the request:
//   1. The API key CACHE. requireAuth reads a 5-minute LRU before it reads the
//      database, so a purged account's credential kept working for up to five
//      more minutes — against a workspace being deleted underneath it. The key
//      row was gone and the request still succeeded.
//   2. Redis REFRESH TOKENS. They are keyed by a hash of the token, so they
//      cannot be found by owner, which meant nothing ever tried: a connector
//      could mint a brand-new access key for an account that no longer existed.
//      An index per owner, written at mint, is what makes them findable.
//   3. Rows nobody had listed. Invitations carry a colleague's EMAIL ADDRESS,
//      access logs carry IP and user agent, and memberships, approved domains,
//      shared skills, workspace pointers and the product_events mirror all
//      survived a purge that reported success.

const db = require('../config/db');
const apiKeyCache = require('./apiKeyCache');
const { redis } = require('../config/redis');
const posthog = require('./posthog');
const { reportSwallowed } = require('../utils/reportSwallowed');
// normalizeRole only: 'admin' is a legacy spelling of 'owner', and a workspace
// whose last owner-by-any-name is erased is just as ownerless.
const { normalizeRole, eraseProjectGraph } = require('./workspaceService');
// The module object, not destructured: closeWorkspaceInTransaction reads
// rehomeResidentsBeforeClose / lockAndConfirmSoleOccupant at call time.
const workspaceService = require('./workspaceService');

// Required lazily: the add-on platform pulls in workspaceService, which this
// module also loads, and the loader reads the addons/ directory.
const addonLifecycle = () => require('../addons/lifecycle');

// Tables keyed by owner_key (verified against information_schema).
const OWNER_KEY_TABLES = [
    'context_graph_edges',
    'context_graph_nodes',
    'context_graph_evidence',
    'context_graph_embeddings',
    'context_sessions',
    'context_session_loads',    // survives the project cascade when project_id is NULL
    'context_share_tokens',     // public share links: the URL must stop resolving
    'context_project_affinity',
    'context_task_reviews',     // finish_task reviews: digests, per connection and project
    'context_binding_notices',  // one-shot brief notes about a capture filed away from a dead binding
    'context_author_notices',   // one-shot notes that an owner made somebody a project's author
    'context_projects',
    'context_globals',
    'injection_preferences',
    'context_integrations',   // encrypted integration credentials — previously NOT erased
    'context_workspace_pointers',
    'workspace_skills',       // shared know-how authored inside this workspace
    'workspace_members',      // the roster — who was in it, in what role
    'workspace_invites',      // PII: a colleague's email address, per invite
    'workspace_domains',
    'user_encryption_keys',
    'context_audit_logs',
];

// Tables keyed by org_id only.
// 'integrations' has an org_id FK to organizations with no ON DELETE clause (schema.sql),
// so leaving a row behind makes the subsequent DELETE FROM organizations fail on the FK —
// silently, since the caller swallows that error. It must be purged here.
//
// access_logs and product_events have ON DELETE SET NULL, which is not erasure:
// it detaches the row from the org and keeps the IP, the user agent and the
// behavioural trail. Both are deleted outright, and onboarding_responses with
// them — free-text answers a person typed about their own work.
//
// THE ORG'S RECORDS, NOT ONLY ITS CONTEXT. escalation_resolutions through
// enterprise_inquiries used to be deleted INLINE by DELETE /api/v1/orgs and by
// nothing else. So the two "delete my account" routes disagreed about what an
// account's data is: DELETE /api/v1/context/account reported a complete erasure
// and left the audit trail (who did what, from where), the decisions, the
// policies and the enterprise inquiry behind, and the Clerk user.deleted webhook
// left them too — after which its DELETE FROM organizations failed on their
// foreign keys (none has an ON DELETE action) and the org survived a
// right-to-erasure request. They live here now so that every path which says
// "erased" means the same set of tables. Children before parents:
// escalation_resolutions hangs off a decision, policy_versions off a policy.
const ORG_ID_TABLES = [
    'escalation_resolutions',
    'audit_logs',
    'decisions',
    'policy_versions',
    'policies',
    'enterprise_inquiries',
    'api_keys',
    'integrations',
    'access_logs',
    'product_events',
    'onboarding_responses',
    'usage_counters',
];

// Tables that carry NO owner column at all and belong to an owner only through
// the project they hang off. Deleted by `project_id IN (the owner's projects)`,
// BEFORE context_projects, so the rows go whether or not the FK cascade does.
//
// context_events used to sit in ORG_ID_TABLES and be deleted `WHERE org_id =`.
// Neither place that creates the table (contextSyncStore.ensureSchema,
// scripts/migrate-context-sync.js) gives it an org_id. autoMigrate bolts one on
// as a "cleanup convenience" that no writer ever fills, so on a database it had
// touched the statement matched NOTHING and the events went only because the
// project cascade took them; on one it had not touched the statement raised
// 42703, every strict caller threw erasure_incomplete, and "delete my account"
// answered 500. Keying by project is right on both schemas, and stays right if
// a future migration adds an org_id that is actually populated.
const PROJECT_SCOPED_TABLES = [
    'context_events',
];

// A person's rows in OTHER people's workspaces, keyed by person rather than by
// workspace. Declared rather than inlined so the schema-consistency test can
// check every (table, column) pair this service deletes by.
const PERSON_KEYED_DELETES = [
    // Deliberately before the memberships: the membership is the record
    // of why this key belonged in that workspace, and deleting it first
    // leaves a live credential nothing points at.
    { label: 'api_keys_by_owner', table: 'api_keys', column: 'owner_id' },
    { label: 'workspace_members_by_user', table: 'workspace_members', column: 'user_id' },
    { label: 'access_logs_by_actor', table: 'access_logs', column: 'actor_id' },
    { label: 'product_events_by_user', table: 'product_events', column: 'user_id' },
    // Their "you" profile in every workspace they were in. It is the person's
    // (context_globals is keyed by workspace AND person), and in a team the
    // owner_key sweep never reaches it because the team is not being erased.
    { label: 'context_globals_by_person', table: 'context_globals', column: 'person_id' },
    // What they were told about authorship, in every workspace they were in.
    { label: 'context_author_notices_by_person', table: 'context_author_notices', column: 'person_id' },
];

// A PERSON'S PERSONAL PROJECTS IN OTHER PEOPLE'S WORKSPACES.
//
// A project a member made inside a team with visibility 'personal' is readable
// by its author and nobody else — not even a workspace owner — so it is the
// person's data in the plainest sense, and the owner_key sweep above cannot
// reach it: it lives under the TEAM's key. After "delete my account" those
// projects, their events and their graph survived, readable by no one and
// erased by nobody. 'private' and 'shared' projects the person authored are the
// org's (an owner reads the first, the team the second) and stay, as member
// removal keeps them.
//
// Children first. Each statement is scoped to the matched project ids AND the
// workspace they live in ($2), so the ones on owner-keyed tables lead with the
// owner_key their indexes lead with.
//
// THE GRAPH IS NOT DELETED BY project_id. A graph node is one row per entity per
// workspace, stamped with the FIRST project that saw it; the team's own
// sightings of it are evidence rows. Deleting nodes "WHERE project_id = ANY(...)"
// deleted every entity the erased person happened to meet first — and the
// foreign-key cascade then took the TEAM's evidence and edges on it, out of
// shared projects the erasure had no business touching.
// workspaceService.eraseProjectGraph deletes what only these projects used
// and re-homes what the workspace still uses.
//
// Their AUDIT ROWS go with them: a personal project's audit trail was only ever
// shown to its author, and after erasure there is no author.
const PERSONAL_PROJECT_DELETES = [
    { label: 'personal_elsewhere_context_events', sql: 'DELETE FROM context_events WHERE project_id = ANY($1)' },
    { label: 'personal_elsewhere_context_sessions', sql: 'DELETE FROM context_sessions WHERE owner_key = $2 AND project_id = ANY($1)' },
    { label: 'personal_elsewhere_context_session_loads', sql: 'DELETE FROM context_session_loads WHERE owner_key = $2 AND project_id = ANY($1)' },
    { label: 'personal_elsewhere_context_share_tokens', sql: 'DELETE FROM context_share_tokens WHERE owner_key = $2 AND project_id = ANY($1)' },
    { label: 'personal_elsewhere_context_audit_logs', sql: 'DELETE FROM context_audit_logs WHERE owner_key = $2 AND project_id = ANY($1)' },
    { label: 'personal_elsewhere_context_projects', sql: 'DELETE FROM context_projects WHERE owner_key = $2 AND project_id = ANY($1)' },
];

async function erasePersonalProjectsElsewhere(query, identities, ownerKey, deleted) {
    let rows;
    try {
        const r = await query(
            `SELECT project_id, owner_key FROM context_projects
              WHERE owner_user_id = ANY($1) AND visibility = 'personal' AND owner_key IS DISTINCT FROM $2`,
            [identities, ownerKey],
            'org-system'
        );
        rows = r.rows;
    } catch (err) {
        deleted.personal_projects_elsewhere = err?.code === '42P01' ? 0 : `error:${err.code || err.message}`;
        return;
    }
    deleted.personal_projects_elsewhere = rows.length;
    if (!rows.length) return;

    const byWorkspace = new Map();
    for (const row of rows) {
        if (!byWorkspace.has(row.owner_key)) byWorkspace.set(row.owner_key, []);
        byWorkspace.get(row.owner_key).push(row.project_id);
    }
    const tally = (label, result) => {
        if (typeof deleted[label] === 'string') return; // an earlier workspace already failed it
        if (typeof result === 'string') { deleted[label] = result; return; }
        deleted[label] = (deleted[label] || 0) + result;
    };
    const exec = (text, params) => query(text, params, 'org-system');
    for (const [workspaceKey, projectIds] of byWorkspace) {
        try {
            const graph = await eraseProjectGraph(exec, workspaceKey, projectIds);
            tally('personal_elsewhere_context_graph_evidence', graph.evidence_deleted);
            tally('personal_elsewhere_context_graph_edges', graph.edges_deleted);
            tally('personal_elsewhere_context_graph_nodes', graph.nodes_deleted);
        } catch (err) {
            tally('personal_elsewhere_context_graph_nodes', err?.code === '42P01' ? 0 : `error:${err.code || err.message}`);
        }
        for (const { label, sql } of PERSONAL_PROJECT_DELETES) {
            try {
                const params = sql.includes('$2') ? [projectIds, workspaceKey] : [projectIds];
                const r = await query(sql, params, 'org-system');
                tally(label, r.rowCount || 0);
            } catch (err) {
                tally(label, err?.code === '42P01' ? 0 : `error:${err.code || err.message}`);
            }
        }
    }
}

// The ids the purge matches a person's rows by, widened for the read-only
// listers below exactly as purgeOwnerData widens them for its erasers: the
// people, plus the ids of every API key they own (read from api_keys before
// its sweeps delete the keys). For the listers only; no eraser calls it.
async function listerIdentities(query, people) {
    try {
        const keys = await query('SELECT key_id FROM api_keys WHERE owner_id = ANY($1)', [people], 'org-system');
        return [...new Set([...people, ...keys.rows.map((row) => row.key_id).filter(Boolean)])];
    } catch (err) {
        if (err?.code !== '42P01') throw err;
        return people;
    }
}

// WHAT erasePersonalProjectsElsewhere WILL ERASE, READ WITHOUT ERASING ANYTHING.
//
// Account deletion emails "the last copy we hold" before the purge, so the copy
// has to cover what the purge takes — and these projects are erased by the
// person-keyed half of purgeOwnerData, not by the owner_key sweep the export
// used to mirror. They went with no copy anywhere (journey scan round 2, R2-2).
// The export asks here rather than choosing its own set, so a project the purge
// erases cannot be missing from it and one the purge leaves (a colleague's, or
// the team's shared and private work) cannot be in it.
//
// The same selection, step for step: `userIds` widened to every id those people
// may be stamped under (themselves plus their API keys' ids, read from api_keys
// as purgeOwnerData reads them before its sweeps delete the keys), then the same
// SELECT erasePersonalProjectsElsewhere runs. If either changes, change both;
// tests/integration/account-delete-export-elsewhere.test.js checks that the two
// agree on a real purge. Returns [{ project_id, owner_key }]. A read that fails
// throws — a copy that silently lacks a project is worse than none — except a
// missing table, which holds no projects.
async function listPersonalProjectsElsewhere(ownerKey, { userIds = [], query = db.query } = {}) {
    const people = [...new Set((userIds || []).filter(Boolean))];
    if (!people.length) return [];
    const identities = await listerIdentities(query, people);
    try {
        const r = await query(
            `SELECT project_id, owner_key FROM context_projects
              WHERE owner_user_id = ANY($1) AND visibility = 'personal' AND owner_key IS DISTINCT FROM $2`,
            [identities, ownerKey],
            'org-system'
        );
        return r.rows;
    } catch (err) {
        if (err?.code === '42P01') return [];
        throw err;
    }
}

// A PERSON'S PRIVATE NOTES IN OTHER PEOPLE'S WORKSPACES (scan 33).
//
// The first invite marks a founder's pre-team no-project nodes private to them
// (metadata.private_to, workspaceService.backfillProjectOwnership) instead of
// moving them into one of their personal projects, so the personal-project
// sweep above no longer reaches them: the founder's solo-era notes — the most
// personal thing a solo account holds — survived "delete my account" in the
// team they left behind, readable by nobody and erased by nobody. They are the
// person's by mark, so they go by mark, in every workspace that holds one,
// with their evidence, edges and vectors (evidence and edges also cascade on
// the node; their vectors do not).
//
// FOUND BY THE MARK, NOT THROUGH THE ROSTER (scan 34 b/p104). Round 33 listed
// the workspaces from workspace_members, and the Clerk user.deleted webhook
// deletes the person's roster rows (workspace.forgetPerson) BEFORE it erases
// them, so on the one path where the identity is already gone the sweep found
// no workspace and erased nothing. A person who left a team (or was removed)
// has no row to find either. The mark itself says whose the note is, so it is
// what selects: one pass over the partial expression index on private_to
// (contextSyncStore ensureSchema, idx_context_graph_nodes_private_to), which
// holds only marked rows. Every delete after it leads with owner_key.
async function erasePrivateNodesElsewhere(query, userIds, identities, ownerKey, deleted) {
    const label = 'private_to_context_graph_nodes';
    const marks = [...new Set((identities || []).filter(Boolean).map(String))];
    if (!userIds.length || !marks.length) { deleted[label] = 0; return; }
    const byWorkspace = new Map();
    try {
        const r = await query(
            `SELECT owner_key, node_id FROM context_graph_nodes
              WHERE metadata->>'private_to' = ANY($1::text[])
                AND owner_key IS DISTINCT FROM $2`,
            [marks, ownerKey],
            'org-system'
        );
        for (const row of r.rows) {
            if (!row.owner_key) continue;
            if (!byWorkspace.has(row.owner_key)) byWorkspace.set(row.owner_key, []);
            byWorkspace.get(row.owner_key).push(row.node_id);
        }
    } catch (err) {
        deleted[label] = err?.code === '42P01' ? 0 : `error:${err.code || err.message}`;
        return;
    }
    let count = 0;
    for (const [workspaceKey, nodes] of byWorkspace) {
        try {
            const evidence = (await query(
                `SELECT evidence_id FROM context_graph_evidence
                  WHERE owner_key = $1 AND node_id = ANY($2::text[])`,
                [workspaceKey, nodes],
                'org-system'
            )).rows.map((row) => row.evidence_id);
            const vectors = (await query('SELECT to_regclass($1) AS t', ['public.context_graph_embeddings'], 'org-system')).rows[0]?.t;
            if (vectors) {
                await query(
                    `DELETE FROM context_graph_embeddings
                      WHERE owner_key = $1 AND ((target_kind = 'node' AND target_id = ANY($2::text[]))
                         OR (target_kind = 'evidence' AND target_id = ANY($3::text[])))`,
                    [workspaceKey, nodes, evidence],
                    'org-system'
                );
            }
            await query(
                'DELETE FROM context_graph_evidence WHERE owner_key = $1 AND node_id = ANY($2::text[])',
                [workspaceKey, nodes],
                'org-system'
            );
            await query(
                `DELETE FROM context_graph_edges
                  WHERE owner_key = $1 AND (from_node_id = ANY($2::text[]) OR to_node_id = ANY($2::text[]))`,
                [workspaceKey, nodes],
                'org-system'
            );
            const gone = await query(
                'DELETE FROM context_graph_nodes WHERE owner_key = $1 AND node_id = ANY($2::text[])',
                [workspaceKey, nodes],
                'org-system'
            );
            count += gone.rowCount || 0;
        } catch (err) {
            deleted[label] = err?.code === '42P01' ? 0 : `error:${err.code || err.message}`;
            return;
        }
    }
    deleted[label] = count;
}

// WHAT erasePrivateNodesElsewhere WILL ERASE, READ WITHOUT ERASING ANYTHING.
//
// The same reason as listPersonalProjectsElsewhere, for the notes marked
// private to the person: the account-deletion export carries them because the
// purge erases them. The same selection: the marks are every id the person is
// stamped under (listerIdentities, as purgeOwnerData passes `identities`), the
// SELECT is the eraser's, and a row with no owner_key is skipped as it skips
// it. Returns [{ owner_key, node_id }]. Throws on a failed read, except a
// missing table. If the eraser's selection changes, change this with it; the
// agreement is checked on a real purge in
// tests/integration/account-delete-export-elsewhere.test.js.
async function listPrivateNodesElsewhere(ownerKey, { userIds = [], query = db.query } = {}) {
    const people = [...new Set((userIds || []).filter(Boolean))];
    if (!people.length) return [];
    const marks = [...new Set((await listerIdentities(query, people)).filter(Boolean).map(String))];
    try {
        const r = await query(
            `SELECT owner_key, node_id FROM context_graph_nodes
              WHERE metadata->>'private_to' = ANY($1::text[])
                AND owner_key IS DISTINCT FROM $2`,
            [marks, ownerKey],
            'org-system'
        );
        return r.rows.filter((row) => row.owner_key);
    } catch (err) {
        if (err?.code === '42P01') return [];
        throw err;
    }
}

// WHAT PERSON_KEYED_DELETES context_globals_by_person WILL ERASE OUTSIDE THE
// WORKSPACE BEING DESTROYED, READ WITHOUT ERASING ANYTHING.
//
// The "you" profile is keyed by workspace AND person, so the person has one in
// every workspace they wrote one in, and the person-keyed delete takes them
// all. The eraser's WHERE is `person_id = ANY(userIds)` — the people, not their
// key ids — and it runs after the owner_key sweep has already taken the home
// workspace's row, so the rows it reaches are exactly these: the same WHERE,
// outside `ownerKey`. Returns [{ owner_key, person_id }]. Throws on a failed
// read, except a missing table. Checked against a real purge in
// tests/integration/account-delete-export-elsewhere.test.js.
async function listProfilesElsewhere(ownerKey, { userIds = [], query = db.query } = {}) {
    const people = [...new Set((userIds || []).filter(Boolean))];
    if (!people.length) return [];
    try {
        const r = await query(
            `SELECT owner_key, person_id FROM context_globals
              WHERE person_id = ANY($1) AND owner_key IS DISTINCT FROM $2`,
            [people, ownerKey],
            'org-system'
        );
        return r.rows;
    } catch (err) {
        if (err?.code === '42P01') return [];
        throw err;
    }
}

// The PostHog person properties written at signup (auth-webhooks.js). Erasure
// cannot delete the PERSON from here — that needs PostHog's admin API and a
// personal API key this service does not hold — so it removes those properties
// by name and marks the person suppressed. Anything added to the $set/$set_once
// lists at signup belongs here too.
const POSTHOG_PERSON_PII = [
    'email',
    'name',
    'signup_method',
    'device_type',
    'initial_device_type',
    'initial_plan',
    'initial_utm_source',
    'initial_utm_medium',
    'initial_utm_campaign',
    'initial_utm_term',
    'initial_utm_content',
    'initial_campaign',
    'initial_landing_page',
    'initial_referral_code',
    'initial_rdt_cid',
    'initial_gclid',
    'initial_wbraid',
    'initial_gbraid',
];

const REFRESH_INDEX_PREFIX = 'oauth:refresh:owner:';
// Long enough to outlive any refresh token it points at. That is now DERIVED
// from the refresh TTL rather than restated: this was a hard-coded 45 days
// beside a comment saying the refresh TTL was 30, and by then it was 90, so
// the index expired while the tokens it pointed at were still live. The index
// is the only way to find a person's live refresh tokens (a token's key is a
// hash of the token), so an erased account could refresh its way to a fresh
// access key — the exact failure the index exists to prevent. A stale member
// costs one wasted DEL and never a wrong answer.
const { REFRESH_INDEX_TTL_SECONDS } = require('../config/oauthTokens');

// A TABLE THAT DOES NOT EXIST HOLDS NO DATA.
//
// Several of these tables are created lazily by whichever module owns them
// (contextSyncStore for context_*, workspaceService for workspace_*), so on a
// process or a database where that module never ran, the DELETE raises 42P01.
// That is not an incomplete erasure and must not fail one — but it is worth a
// line in the log, because a TYPO produces the same error code.
async function deleteWhere(query, table, column, value) {
    try {
        const r = await query(`DELETE FROM ${table} WHERE ${column} = $1`, [value], 'org-system');
        return r.rowCount;
    } catch (err) {
        if (err?.code === '42P01') {
            console.warn(`[ERASURE] ${table} does not exist on this database; nothing to erase there.`);
            return 0;
        }
        // A MISSING COLUMN IS NOT A MISSING TABLE. The table exists and holds
        // rows this statement could not select, so it stays an error — treating
        // it as "nothing to erase" would report a complete erasure over data
        // that is still there. It is always a bug in the lists above, never a
        // property of the database, so say that.
        if (err?.code === '42703') {
            console.error(`[ERASURE] ${table} has no column ${column}; the erasure table list is wrong for this schema`);
        }
        return `error:${err.code || err.message}`;
    }
}

// The ACTIVE roster minus the people who stay on it (see `keepMembers`).
//
// A REMOVED ROW IS NOT HISTORY HERE, IT IS A BAR. This path empties a workspace
// that goes on existing, and a removed member's row is what keeps them out of
// it: somebody the legacy invite path created INSIDE the team (users.org_id =
// the team) and who was removed without being re-homed is refused only because
// that row says so. Until scan 26 this swept the tombstones with everything
// else, and that person's next request reached resolveRole's own-org fallback
// with nothing to stop it — back in as an OWNER of the workspace they had been
// removed from (and the boot backfill would have re-inserted them as one). A
// tombstone names a person and a date, nothing of the emptied content. Full
// erasure (DELETE /orgs, the Clerk webhook) never comes through here: there the
// workspace itself goes. Same error contract as deleteWhere.
async function deleteMembersExcept(query, ownerKey, keepUserIds) {
    try {
        const r = await query(
            `DELETE FROM workspace_members
              WHERE owner_key = $1 AND removed_at IS NULL AND NOT (user_id = ANY($2::text[]))`,
            [ownerKey, keepUserIds],
            'org-system'
        );
        return r.rowCount;
    } catch (err) {
        if (err?.code === '42P01') return 0;
        return `error:${err.code || err.message}`;
    }
}

// Rows that belong to the owner only through one of the owner's projects.
async function deleteByOwnerProjects(query, table, ownerKey) {
    try {
        const r = await query(
            `DELETE FROM ${table} WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)`,
            [ownerKey],
            'org-system'
        );
        return r.rowCount;
    } catch (err) {
        if (err?.code === '42P01') {
            console.warn(`[ERASURE] ${table} (or context_projects) does not exist on this database; nothing to erase there.`);
            return 0;
        }
        if (err?.code === '42703') {
            console.error(`[ERASURE] ${table} has no project_id column; the erasure table list is wrong for this schema`);
        }
        return `error:${err.code || err.message}`;
    }
}

function refreshIndexKey(ownerKey) {
    return `${REFRESH_INDEX_PREFIX}${ownerKey}`;
}

/**
 * Record that a Redis key holds a refresh token belonging to `ownerKey`. Called
 * wherever a refresh token is minted or rotated. Best-effort: a failure here
 * must never fail the OAuth exchange, and the SCAN fallback below still finds an
 * unindexed token at erasure time.
 */
async function indexRefreshToken(ownerKey, tokenKey) {
    if (!ownerKey || !tokenKey) return;
    try {
        await redis.sadd(refreshIndexKey(ownerKey), tokenKey);
        await redis.expire(refreshIndexKey(ownerKey), REFRESH_INDEX_TTL_SECONDS);
    } catch (err) {
        console.warn('[ERASURE] refresh-token index write failed:', err.message);
    }
}

/** Drop a rotated/revoked token from the index. */
async function forgetRefreshToken(ownerKey, tokenKey) {
    if (!ownerKey || !tokenKey) return;
    try {
        await redis.srem(refreshIndexKey(ownerKey), tokenKey);
    } catch { /* the index is a hint; a stale member costs one wasted DEL */ }
}

/**
 * Revoke every OAuth refresh token belonging to an owner: the index first, then
 * a bounded SCAN for tokens minted before the index existed. Returns the number
 * of keys deleted.
 */
const REFRESH_SWEEP_MAX_ROUNDS = 200;

async function revokeOwnerRefreshTokens(ownerKey, report = {}) {
    let revoked = 0;
    const indexKey = refreshIndexKey(ownerKey);
    try {
        const members = await redis.smembers(indexKey);
        for (const key of members || []) {
            revoked += await redis.del(key).catch(() => 0);
        }
        await redis.del(indexKey).catch(() => {});
    } catch (err) {
        console.warn('[ERASURE] refresh-token index read failed:', err.message);
    }

    // Tokens minted before the index shipped are still live credentials, and a
    // SCAN is the only way to find a key named after a hash. Bounded, and only
    // on a path that runs once per erased account.
    if (typeof redis.scan !== 'function') return revoked;
    try {
        let cursor = '0';
        let rounds = 0;
        do {
            const [next, keys] = await redis.scan(cursor, 'MATCH', 'oauth:refresh:*', 'COUNT', 500);
            cursor = next;
            for (const key of keys || []) {
                if (key.startsWith(REFRESH_INDEX_PREFIX)) continue;
                const raw = await redis.get(key).catch(() => null);
                if (!raw || typeof raw !== 'string') continue;
                let record = null;
                try { record = JSON.parse(raw); } catch { continue; }
                if (record && record.org_id === ownerKey) {
                    revoked += await redis.del(key).catch(() => 0);
                }
            }
            rounds += 1;
        } while (cursor !== '0' && rounds < REFRESH_SWEEP_MAX_ROUNDS);
        // STOPPING EARLY IS NOT FINISHING. The bound is right — this runs inside
        // a request — but hitting it used to look exactly like a clean sweep, so
        // an erasure could report its tokens revoked with most of the keyspace
        // unread and a pre-index refresh token for that account still live. Say
        // so, loudly enough to be acted on: the token stays redeemable until it
        // expires or somebody finishes the sweep.
        if (cursor !== '0') {
            console.error(`[ERASURE] refresh-token sweep for ${ownerKey} stopped at ${rounds} SCAN rounds with keys unread; a legacy refresh token may still be live`);
            report.sweep_incomplete = true;
        }
    } catch (err) {
        console.warn('[ERASURE] refresh-token sweep failed:', err.message);
    }
    return revoked;
}

/**
 * Ask PostHog to drop the person properties written at signup, once per erased
 * person.
 *
 * THIS IS NOT A PERSON DELETION, and must not be described as one: deleting a
 * PostHog person needs the admin API and a personal API key this service does
 * not hold. The events and the person survive — minus the identifying
 * properties, and carrying a suppression marker so they can be excluded.
 */
function requestAnalyticsErasure(distinctIds, ownerKey) {
    const erasedAt = new Date().toISOString();
    for (const distinctId of distinctIds) {
        posthog.captureProductEvent({
            distinctId,
            event: 'account_erased',
            orgId: ownerKey,
            properties: {
                $unset: POSTHOG_PERSON_PII,
                $set: { is_erased: true, erased_at: erasedAt },
                erased_at: erasedAt,
            },
        });
    }
}

/**
 * Say so when an erasure has taken the last owner off somebody else's workspace.
 *
 * Only for workspaces the erased person OWNED — a member leaving takes no
 * authority with them — and only when no owner remains. A report nobody needs to
 * act on trains people to ignore the ones they do.
 *
 * Every failure here is swallowed on purpose: this runs after the DELETEs, and
 * an erasure that already happened must not be reported as failed because the
 * follow-up query could not run.
 */
async function reportOwnerlessWorkspaces(query, userIds, ownerKey, memberships) {
    const owned = [...new Set(
        (memberships || [])
            .filter((row) => normalizeRole(row.role) === 'owner')
            .map((row) => row.owner_key)
            .filter((key) => key && key !== ownerKey)
    )];
    if (!owned.length) return;

    const remaining = await query(
        `SELECT owner_key, COUNT(*)::int AS owners
           FROM workspace_members
          WHERE owner_key = ANY($1) AND removed_at IS NULL AND role IN ('owner', 'admin')
          GROUP BY owner_key`,
        [owned],
        'org-system'
    ).then((r) => new Map(r.rows.map((row) => [row.owner_key, Number(row.owners) || 0])))
        .catch((err) => {
            console.warn('[ERASURE] could not re-count workspace owners:', err.message);
            return null;
        });
    if (!remaining) return;

    // How much work is now unreachable, per workspace. A project whose
    // owner_user_id is an erased person and whose visibility is `personal` has
    // no reader left at all.
    const orphaned = await query(
        `SELECT owner_key, COUNT(*)::int AS projects
           FROM context_projects
          WHERE owner_user_id = ANY($1) AND owner_key = ANY($2)
          GROUP BY owner_key`,
        [userIds, owned],
        'org-system'
    ).then((r) => new Map(r.rows.map((row) => [row.owner_key, Number(row.projects) || 0])))
        .catch(() => new Map());

    for (const workspaceKey of owned) {
        if ((remaining.get(workspaceKey) || 0) > 0) continue;
        reportSwallowed(
            new Error('workspace has no owner: its last owner erased their account'),
            {
                op: 'erasure_left_workspace_ownerless',
                // Not a destructive failure — the erasure did exactly what it
                // was asked to. It is a workspace that now needs a human.
                destructive: false,
                meta: {
                    org_id: workspaceKey,
                    erased_owner_key: ownerKey,
                    orphaned_projects: orphaned.get(workspaceKey) || 0,
                },
            }
        );
    }
}

/**
 * Erase every owner-scoped row for an org. Returns a per-table count/error map.
 * @param {string} ownerKey the org_id (== owner_key) to purge
 */
// `deferSideEffects`: for a caller running this inside ITS OWN transaction.
// Ending the live session (key cache, Redis refresh tokens) and asking the
// analytics provider to erase a person cannot be rolled back, and they used to
// run from in here — before the caller's COMMIT. DELETE /orgs does exactly that:
// if a later statement in its transaction failed, the database rolled back to a
// fully intact account whose sessions had been revoked and whose analytics
// identity had been erased. With the flag set nothing irreversible runs here;
// the result carries `runSideEffects()` for the caller to invoke after COMMIT.
async function purgeOwnerData(ownerKey, {
    strict = false,
    query = db.query,
    deferSideEffects = false,
    // The people whose data this is, when the caller already knows them. The
    // Clerk user.deleted webhook has to delete the users row BEFORE it purges
    // (see auth-webhooks.js), so the `users WHERE org_id` read below finds
    // nobody there, and everything keyed by PERSON was skipped: the person's
    // personal projects in other people's workspaces, their access logs and
    // product events. DELETE /account erased all of that; the webhook erased
    // none of it. Merged with whatever the reads below still find.
    userIds: knownUserIds = [],
    // Every id those people may be stamped under (user ids + API key ids),
    // read by the caller while the api_keys rows still existed.
    identities: knownIdentities = [],
    // EMPTY THE WORKSPACE, KEEP THE PERSON. DELETE /context/account is "empty
    // my workspace" — the person keeps their login and stays who they were
    // everywhere else. The person-keyed half below reaches into OTHER people's
    // workspaces (their memberships, their keys there, their personal projects
    // there), which is right when the account itself is going (DELETE /orgs,
    // Clerk user.deleted) and wrong here: a member who emptied their own
    // workspace was silently taken off every team roster they were on and had
    // their team keys revoked, while the page promised "an empty workspace".
    // With this set, only what the workspace itself owns is erased.
    workspaceOnly = false,
    // People whose OWN roster row in this workspace survives the purge. Emptying
    // a workspace does not take the person doing it off it: until scan 25 the
    // owner_key sweep deleted the caller's owner row along with everybody
    // else's, the owner kept working through resolveRole's own-workspace
    // fallback, and everything that COUNTS rows went wrong — the next invitee
    // was the only member on the roster, the solo-era projects never flipped
    // to personal (the 1->2 transition read 0->1), the new co-owner could not
    // leave (last_owner), and a second empty with a teammate aboard saw one
    // member, answered 200 and erased the teammate's work. Only meaningful with
    // workspaceOnly: erasing the account erases the person's rows too.
    keepMembers = [],
} = {}) {
    if (!ownerKey) throw new Error('purgeOwnerData requires an ownerKey');
    const deleted = {};
    // Not a count, so it does not belong among the per-table numbers the caller
    // serialises as `deleted_counts`. Attached non-enumerably below for the same
    // reason runSideEffects is.
    let leftWorkspaces = [];

    // Read what has to outlive the DELETEs before issuing them: the key hashes
    // the auth cache is holding, and the people whose analytics identity has to
    // be suppressed. Best-effort — a read failure must not stop the erasure.
    let keyHashes = [];
    let userIds = [];
    try {
        const r = await query('SELECT key_hash FROM api_keys WHERE org_id = $1', [ownerKey], 'org-system');
        keyHashes = r.rows.map((row) => row.key_hash).filter(Boolean);
    } catch (err) {
        console.warn('[ERASURE] could not enumerate api keys for cache invalidation:', err.message);
    }
    try {
        const r = await query('SELECT user_id FROM users WHERE org_id = $1', [ownerKey], 'org-system');
        userIds = r.rows.map((row) => row.user_id).filter(Boolean);
    } catch (err) {
        console.warn('[ERASURE] could not enumerate users:', err.message);
    }
    userIds = [...new Set([...userIds, ...knownUserIds.filter(Boolean)])];
    // Every id these people may be stamped under in owner_user_id: themselves,
    // and their API keys for rows written before attribution named people.
    // Read now, because the api_keys sweeps below delete the rows that say so.
    let identities = [...new Set([...userIds, ...knownIdentities.filter(Boolean)])];
    if (userIds.length) {
        try {
            const r = await query('SELECT key_id FROM api_keys WHERE owner_id = ANY($1)', [userIds], 'org-system');
            identities = [...new Set([...identities, ...r.rows.map((row) => row.key_id).filter(Boolean)])];
        } catch (err) {
            console.warn('[ERASURE] could not enumerate key identities:', err.message);
        }
    }

    // Children before parents: these are found THROUGH context_projects, so
    // they have to go while the projects are still there to find them by.
    for (const table of PROJECT_SCOPED_TABLES) {
        deleted[table] = await deleteByOwnerProjects(query, table, ownerKey);
    }
    // ADD-ON DATA, for every add-on at once (apps/api/src/addons/lifecycle.js).
    // The rows go now, inside the caller's transaction when it has one; the
    // FILES go in runSideEffects below, after any COMMIT, because a deleted
    // object cannot be rolled back.
    const addonFileKeys = await addonLifecycle().eraseWorkspaceAddonData(query, ownerKey, deleted);
    const keep = workspaceOnly ? [...new Set((keepMembers || []).filter(Boolean))] : [];
    for (const table of OWNER_KEY_TABLES) {
        deleted[table] = table === 'workspace_members' && keep.length
            ? await deleteMembersExcept(query, ownerKey, keep)
            : await deleteWhere(query, table, 'owner_key', ownerKey);
    }
    for (const table of ORG_ID_TABLES) {
        deleted[table] = await deleteWhere(query, table, 'org_id', ownerKey);
    }

    // A person's rows in SOMEBODY ELSE'S workspace are still their data: a
    // membership naming them on a roster they are no longer part of, an access
    // log carrying their IP, a product event filed under their user id. Keyed by
    // person, not by workspace, so the owner_key sweep above cannot reach them.
    // Only when the PERSON is being erased — see `workspaceOnly`.
    if (userIds.length && !workspaceOnly) {
        // WHAT THE PERSON HELD IN OTHER PEOPLE'S WORKSPACES, read before the
        // rows that record it are deleted. Two things depend on this and both
        // were missing.
        const foreignMemberships = await query(
            `SELECT owner_key, role FROM workspace_members
              WHERE user_id = ANY($1) AND owner_key <> $2 AND removed_at IS NULL`,
            [userIds, ownerKey],
            'org-system'
        ).then((r) => r.rows).catch((err) => {
            console.warn('[ERASURE] could not enumerate foreign workspace memberships:', err.message);
            return [];
        });

        // 0. WHICH TEAMS THIS PERSON IS ABOUT TO BE REMOVED FROM, BY NAME.
        //
        // The membership rows are deleted a few statements below, so this is
        // the last moment the answer exists — which is why it is read here and
        // not by the caller. Deleting "your account" also takes you off every
        // roster you were on and revokes your keys in those workspaces, and the
        // response said only `deleted: true`: the part that reaches into other
        // people's workspaces was the part nobody was told about.
        if (foreignMemberships.length) {
            const keys = [...new Set(foreignMemberships.map((row) => row.owner_key).filter(Boolean))];
            const names = await query(
                'SELECT org_id, name FROM organizations WHERE org_id = ANY($1)',
                [keys],
                'org-system'
            ).then((r) => new Map(r.rows.map((row) => [row.org_id, row.name])))
                .catch(() => new Map());
            leftWorkspaces = keys.map((key) => ({ key, name: names.get(key) || null }));
        }

        // 1. THE CREDENTIALS HAVE TO FOLLOW THE PERSON, NOT THE WORKSPACE.
        //
        // The hash enumeration above and the api_keys sweep are both keyed on
        // org_id, so a key minted INSIDE another workspace — which is what
        // keys.js stamps for an invited teammate, deliberately — survived a
        // purge that deleted the membership justifying it. The roster row went
        // and the live credential stayed, which is removal without revocation:
        // the failure DELETE /teams/members/:userId already names, arrived at
        // from the other direction.
        //
        // Revoked AND deleted: the status change is what a database read
        // enforces, and the row going is the erasure. Neither ends the session
        // on its own — the cache invalidation at the end of this function does,
        // which is why the hashes are collected here rather than discarded.
        const foreignHashes = await query(
            'SELECT key_hash FROM api_keys WHERE owner_id = ANY($1)',
            [userIds],
            'org-system'
        ).then((r) => r.rows.map((row) => row.key_hash).filter(Boolean)).catch((err) => {
            console.warn('[ERASURE] could not enumerate this person\'s keys in other workspaces:', err.message);
            return [];
        });
        for (const hash of foreignHashes) {
            if (!keyHashes.includes(hash)) keyHashes.push(hash);
        }
        try {
            const r = await query(
                'UPDATE api_keys SET status = $2 WHERE owner_id = ANY($1) AND status = $3',
                [userIds, 'revoked', 'active'],
                'org-system'
            );
            deleted.api_keys_revoked_by_owner = r.rowCount;
        } catch (err) {
            deleted.api_keys_revoked_by_owner = err?.code === '42P01' ? 0 : `error:${err.code || err.message}`;
        }

        // Their PERSONAL projects in other people's workspaces, with
        // everything hanging off them. See PERSONAL_PROJECT_DELETES.
        await erasePersonalProjectsElsewhere(query, identities, ownerKey, deleted);
        // Their add-on data in other people's workspaces: v1 add-on data is
        // all `personal`, so wherever it lives it is theirs alone.
        addonFileKeys.push(...await addonLifecycle().erasePersonAddonData(query, userIds, deleted));
        // And their private notes there (scan 33): the home workspace's go with
        // its owner_key sweep above.
        await erasePrivateNodesElsewhere(query, userIds, identities, ownerKey, deleted);

        // THE ERASED PERSON'S KEYS GO THROUGH THE ONE DELETE PATH (journey r7): what
        // they wrote in somebody else's workspace stays there, stamped with a key id
        // that is about to stop resolving to anybody, and in a team that leaves the
        // project nobody can manage. Re-stamped to the person's own id first, which
        // resolves to "a person who is no longer here": the owners may act. Keys in
        // the workspace being erased go with it (no context scan). Never fails the
        // erasure.
        try {
            const owned = await query('SELECT key_id, org_id FROM api_keys WHERE owner_id = ANY($1)', [userIds], 'org-system');
            for (const key of owned.rows) {
                await require('./authorStampService')
                    .deleteApiKey({ keyId: key.key_id, scanContext: key.org_id !== ownerKey })
                    .catch((err) => console.warn(`[ERASURE] could not re-stamp key ${key.key_id}: ${err.message}`));
            }
        } catch (err) {
            if (err?.code !== '42P01') console.warn('[ERASURE] key re-stamp skipped:', err.message);
        }

        for (const { label, table, column } of PERSON_KEYED_DELETES) {
            try {
                const r = await query(`DELETE FROM ${table} WHERE ${column} = ANY($1)`, [userIds], 'org-system');
                deleted[label] = r.rowCount;
            } catch (err) {
                deleted[label] = err?.code === '42P01' ? 0 : `error:${err.code || err.message}`;
            }
        }

        // 2. A WORKSPACE MUST NOT BE LEFT WITH NOBODY WHO CAN ADMINISTER IT.
        //
        // Dropping these rows can take the LAST owner off somebody else's
        // workspace — one that still has members, projects and a subscription.
        // Nobody left to invite, to bill, or to reach the projects the erased
        // person authored there: a `personal` project's author is the only
        // reader it has, so those become permanently unreachable rather than
        // merely unowned.
        //
        // RETAIN AND REPORT, the choice #484 made for the same shape of problem
        // on the Clerk path (erasure_skipped_shared_workspace). Auto-promoting
        // the longest-tenured member would hand somebody billing authority and
        // read access to `private` projects they could not read the day before,
        // as a side effect of a third party's account deletion — that is a
        // privilege grant, and a privilege grant is a decision a human takes.
        // Refusing the erasure is not an option either: the right to erasure is
        // not contingent on somebody else's workspace being well-administered.
        // So the workspace is left intact and under-administered, and this
        // report is what gets a human to transfer it deliberately.
        await reportOwnerlessWorkspaces(query, userIds, ownerKey, foreignMemberships);
    }

    // END THE LIVE SESSION — BEFORE the strict check, not after it.
    //
    // The comment here always said these run "on every outcome", and they sat
    // below a throw. So the one outcome that most needs them skipped them: a
    // PARTIAL erasure, where the api_keys rows are gone and one other table
    // failed, left every one of those keys authenticating from the 5-minute
    // cache, against an owner whose data was half deleted. A credential that
    // outlives its data is worse than an incomplete-erasure error.
    const runSideEffects = async () => {
        for (const hash of keyHashes) {
            await apiKeyCache.invalidateApiKey(hash).catch((err) => {
                console.warn('[ERASURE] api key cache invalidation failed:', err.message);
            });
        }
        deleted.api_key_cache_invalidated = keyHashes.length;
        deleted.addon_files_deleted = await addonLifecycle().deleteAddonFiles(addonFileKeys).catch((err) => {
            console.warn('[ERASURE] add-on file deletion failed:', err.message);
            return `error:${err.code || err.message}`;
        });
        const sweep = {};
        deleted.refresh_tokens_revoked = await revokeOwnerRefreshTokens(ownerKey, sweep);
        // On the report, so the caller (and the erasure record) can see that
        // "revoked: 3" was not the whole keyspace.
        if (sweep.sweep_incomplete) deleted.refresh_token_sweep_incomplete = true;
        try {
            requestAnalyticsErasure(userIds.length ? userIds : [ownerKey], ownerKey);
        } catch (err) {
            console.warn('[ERASURE] analytics suppression signal failed:', err.message);
        }
        return deleted;
    };

    if (deferSideEffects) {
        // The caller owns the transaction, so a failure here ROLLS BACK: the keys
        // are still rows, and ending their sessions would be the wrong half of
        // an erasure that did not happen. Non-enumerable, so the result still
        // serialises as the plain per-table report it always was.
        Object.defineProperty(deleted, 'runSideEffects', { value: runSideEffects, enumerable: false });
    } else {
        await runSideEffects();
    }
    Object.defineProperty(deleted, 'leftWorkspaces', { value: leftWorkspaces, enumerable: false });

    const failures = Object.entries(deleted).filter(([, result]) => typeof result === 'string' && result.startsWith('error:'));
    if (strict && failures.length) {
        const error = new Error(`Owner-data erasure failed for ${failures.length} table(s)`);
        error.code = 'erasure_incomplete';
        error.deleted = deleted;
        throw error;
    }

    return deleted;
}

// ERASE A PERSON WITHOUT ERASING A WORKSPACE.
//
// The Clerk user.deleted webhook RETAINS a workspace that still has other
// members (it cannot refuse the way DELETE /account does: the identity is
// already gone). purgeOwnerData never runs on that path, so before this nothing
// keyed by the person was erased at all. This is the person-keyed half of
// purgeOwnerData on its own: their `personal` projects in EVERY workspace
// (including the retained one, since a personal project is readable by its
// author and nobody else, and after erasure there is no author) plus
// PERSON_KEYED_DELETES. 'private' and 'shared' projects they authored are the
// org's and stay, as they do on member removal. Never throws; failures come
// back as `error:` strings in the report, like purgeOwnerData's.
async function erasePersonData({ userIds = [], identities = [], query = db.query } = {}) {
    const deleted = {};
    const people = [...new Set(userIds.filter(Boolean))];
    if (!people.length) return deleted;
    const ids = [...new Set([...people, ...identities.filter(Boolean)])];
    await erasePersonalProjectsElsewhere(query, ids, null, deleted);
    await erasePrivateNodesElsewhere(query, people, ids, null, deleted);
    const addonFileKeys = await addonLifecycle().erasePersonAddonData(query, people, deleted);
    deleted.addon_files_deleted = await addonLifecycle().deleteAddonFiles(addonFileKeys)
        .catch((err) => `error:${err.code || err.message}`);
    for (const { label, table, column } of PERSON_KEYED_DELETES) {
        try {
            const r = await query(`DELETE FROM ${table} WHERE ${column} = ANY($1)`, [people], 'org-system');
            deleted[label] = r.rowCount;
        } catch (err) {
            deleted[label] = err?.code === '42P01' ? 0 : `error:${err.code || err.message}`;
        }
    }
    return deleted;
}

// CLOSE ONE MORE WORKSPACE AS PART OF CLOSING AN ACCOUNT.
//
// Closing an account closes the person's home org (DELETE /orgs, the Clerk
// user.deleted webhook). It used to close ONLY that: a second workspace they
// created and that everybody else had since left survived with its org row, its
// projects and graph, and a live subscription — and a roster holding nothing but
// tombstones, so nobody could reach its billing portal to cancel it or even see
// it. See workspaceService.listSoleMemberWorkspaces for which workspaces qualify.
//
// The same sequence the home org goes through, inside the caller's transaction:
// confirm under the membership lock that nobody has joined since the caller
// listed it, move out anybody whose users.org_id still names it
// (rehomeResidentsBeforeClose), erase everything it owns, delete its org row.
// workspaceOnly: the PERSON's rows are the home purge's business, not this one's.
// Billing is NOT cancelled here — Stripe cannot be rolled back, so the caller
// cancels before its transaction, exactly as it does for the home org.
//
// Throws (the caller rolls back) on a join that raced the close, and — strict —
// on any table that failed to clear. Returns { erasure, rehomed }; erasure
// carries runSideEffects() for the caller to invoke after COMMIT.
async function closeWorkspaceInTransaction(client, ownerKey, { identities = [] } = {}) {
    if (!ownerKey) throw new Error('closeWorkspaceInTransaction requires an ownerKey');
    const sole = await workspaceService.lockAndConfirmSoleOccupant(client, ownerKey, identities);
    if (!sole) {
        const error = new Error(`workspace ${ownerKey} gained a member while the account was closing`);
        error.code = 'workspace_membership_changed';
        error.workspace = ownerKey;
        throw error;
    }
    const rehomed = await workspaceService.rehomeResidentsBeforeClose(client, ownerKey, null);
    const erasure = await purgeOwnerData(ownerKey, {
        strict: true,
        query: (text, params) => client.query(text, params),
        deferSideEffects: true,
        workspaceOnly: true,
    });
    await client.query('DELETE FROM organizations WHERE org_id = $1', [ownerKey]);
    // The closure mark (workspaceService.markWorkspaceClosing) goes with the
    // workspace, in this transaction: on a rollback it stays, and the caller
    // clears it.
    await workspaceService.clearWorkspaceClosing(ownerKey, (text, params) => client.query(text, params));
    return { erasure, rehomed };
}

module.exports = {
    purgeOwnerData,
    closeWorkspaceInTransaction,
    erasePersonData,
    listPersonalProjectsElsewhere,
    listPrivateNodesElsewhere,
    listProfilesElsewhere,
    indexRefreshToken,
    forgetRefreshToken,
    revokeOwnerRefreshTokens,
    OWNER_KEY_TABLES,
    ORG_ID_TABLES,
    PROJECT_SCOPED_TABLES,
    PERSON_KEYED_DELETES,
    PERSONAL_PROJECT_DELETES,
    POSTHOG_PERSON_PII,
};
