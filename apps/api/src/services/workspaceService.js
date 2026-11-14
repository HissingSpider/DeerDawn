'use strict';

// Workspace membership — the one place that decides which owner_key an actor is
// allowed to read and write.
//
// WHY THIS EXISTS AT ALL. Every context_* table is keyed on `owner_key`, and
// until now every call site derived that key inline as `actor.org_id || actor.id`
// — forty-odd copies of the same expression across the routes, the service and
// the store. That worked while an org was always exactly one person, because the
// expression could not be wrong. The moment a second human shares an org it
// becomes an authorization decision, and an authorization decision copied forty
// times is one that will be got wrong the forty-first time.
//
// The lesson is the one already paid for in the entitlements work: a cap
// enforced per route drifts the moment a new entry point appears, and only a
// single choke point in the service layer keeps the paths honest. Tenancy has
// exactly that shape with a worse failure mode — the next MCP tool ships
// cross-tenant and looks correct in review, because it looks like its
// neighbours. So: resolveOwnerKey() is the only sanctioned way to turn an actor
// into an owner_key, and tests/unit/workspace-choke-point.test.js fails the
// build if the inline expression reappears.
//
// PERFORMANCE. Resolution happens ONCE per request and every downstream query
// stays `WHERE owner_key = $1`, which is the leading column of every context_*
// index. Do not be tempted to express membership as a per-row join — the same
// mistake against context_graph_evidence measured 14,219ms where the
// owner-scoped form measured 177ms.

const crypto = require('crypto');
const db = require('../config/db');
const { reportSwallowed } = require('../utils/reportSwallowed');
const encryption = require('./encryptionService');

const ROLES = Object.freeze(['owner', 'member', 'viewer']);
const WRITE_ROLES = new Set(['owner', 'member']);
const ADMIN_ROLES = new Set(['owner']);

// Legacy org-scoped roles that predate the three-role model. They are mapped
// forward on read rather than rewritten in place, so a half-migrated database
// behaves consistently and an old row can never silently grant more than it did.
const LEGACY_ROLE_MAP = Object.freeze({
  owner: 'owner',
  admin: 'owner',
  operator: 'member',
  member: 'member',
  approver: 'member',
  'read-only': 'viewer',
  viewer: 'viewer',
});

function normalizeRole(role) {
  if (!role) return 'viewer';
  return LEGACY_ROLE_MAP[String(role).trim()] || 'viewer';
}

let schemaReadyPromise = null;

async function ensureSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await db.query(
        `CREATE TABLE IF NOT EXISTS workspace_members (
          owner_key  TEXT NOT NULL,
          user_id    TEXT NOT NULL,
          role       TEXT NOT NULL DEFAULT 'member',
          invited_by TEXT,
          joined_at  TIMESTAMPTZ DEFAULT NOW(),
          removed_at TIMESTAMPTZ,
          PRIMARY KEY (owner_key, user_id)
        )`,
        [],
        'org-system'
      );
      // WHICH WORKSPACE IS THIS PERSON WORKING IN RIGHT NOW.
      //
      // Without this the only way to act in a team workspace was the
      // x-deerdawn-workspace header, which the dashboard can send and an MCP
      // client cannot. OAuth tokens carry the person's PERSONAL org, so an
      // invited teammate's whole agent loop resolved to their own empty
      // workspace and the team product simply looked empty on the surface it is
      // sold on. The choice has to live on the server, not in a header.
      //
      // NULL/false everywhere means "my personal org", which is what every
      // existing row means today, so the backfill is a no-op.
      await db.query(
        'ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT FALSE',
        [],
        'org-system'
      );
      // LEAVING IS NOT BEING REMOVED.
      //
      // Both stamp removed_at, and the domain door refuses anyone with a
      // removed_at row ("You were removed from this workspace") — so somebody
      // who LEFT a team could never come back through their company's domain,
      // though nobody had decided anything about them. An owner removing a
      // person is that decision, and only the owner undoes it; a person leaving
      // is their own, and the domain approval still covers them. TRUE only for
      // a self-leave; every admission clears it (addMember).
      await db.query(
        'ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS left_voluntarily BOOLEAN NOT NULL DEFAULT FALSE',
        [],
        'org-system'
      );
      // At most one active workspace per person, enforced by the database rather
      // than by remembering to clear the old one.
      await db.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_members_one_active
           ON workspace_members (user_id) WHERE is_active AND removed_at IS NULL`,
        [],
        'org-system'
      );
      // "Which workspaces may this person enter" is the hot lookup, and it leads
      // with user_id — so it needs its own index rather than riding the primary
      // key, whose leading column is owner_key.
      await db.query(
        `CREATE INDEX IF NOT EXISTS idx_workspace_members_user
           ON workspace_members (user_id) WHERE removed_at IS NULL`,
        [],
        'org-system'
      );
      await db.query(
        `CREATE INDEX IF NOT EXISTS idx_workspace_members_owner_active
           ON workspace_members (owner_key) WHERE removed_at IS NULL`,
        [],
        'org-system'
      );
      // THE PROJECT-OWNERSHIP BACKFILL RUNS ONCE PER WORKSPACE, EVER.
      //
      // It used to be keyed off the 1->2 member transition, which recurs: a
      // two-person team that loses somebody and hires a replacement crosses it
      // again, and the second crossing flips every org-owned 'private' project
      // to 'personal' — handing the departed member's work to nobody. "Has it
      // run" is a fact about the workspace, so it is stored as one. One row per
      // workspace, written at most once (see claimOwnershipBackfill).
      await db.query(
        `CREATE TABLE IF NOT EXISTS workspace_ownership_backfills (
          owner_key     TEXT PRIMARY KEY,
          backfilled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
        [],
        'org-system'
      );
      // A WORKSPACE THAT IS BEING CLOSED TAKES NOBODY IN.
      //
      // Closing an account closes every other workspace its person is the only
      // one left in (listSoleMemberWorkspaces), and it cancels each one's
      // subscription BEFORE the transaction that purges it — the billing call
      // cannot sit inside a database transaction. A join landing in between
      // made the close abort with 409 and left a live team whose subscription
      // had already been cancelled (scan 28). So the close marks the workspace
      // here first, under the membership lock and after re-checking that nobody
      // else is in it, and addMember refuses a marked workspace under the same
      // lock. The row goes with the close's own transaction, is cleared when a
      // close gives up, and is ignored once stale, so a crash mid-close cannot
      // shut a workspace's door for good.
      await db.query(
        `CREATE TABLE IF NOT EXISTS workspace_closures (
          owner_key  TEXT PRIMARY KEY,
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
        [],
        'org-system'
      );
      // Invitations are their own record rather than a half-built `users` row.
      //
      // The old flow INSERTed a shell user into the target org on invite. Because
      // users.email is globally UNIQUE, inviting anybody who already had a
      // DeerDawn account raised 23505, which the route caught and reported as
      // `user_exists` — so the people most worth inviting, the ones who had
      // already tried the product, were the exact set that could not be invited.
      await db.query(
        `CREATE TABLE IF NOT EXISTS workspace_invites (
          invite_id        TEXT PRIMARY KEY,
          owner_key        TEXT NOT NULL,
          email            TEXT NOT NULL,
          role             TEXT NOT NULL DEFAULT 'member',
          token_hash       TEXT NOT NULL,
          invited_by       TEXT,
          expires_at       TIMESTAMPTZ NOT NULL,
          accepted_at      TIMESTAMPTZ,
          accepted_user_id TEXT,
          revoked_at       TIMESTAMPTZ,
          created_at       TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE (owner_key, email)
        )`,
        [],
        'org-system'
      );
      await db.query(
        `CREATE INDEX IF NOT EXISTS idx_workspace_invites_token
           ON workspace_invites (token_hash)`,
        [],
        'org-system'
      );
      // Domain joining: anyone with an email at an approved domain may join
      // without a per-person invite. Stored per workspace rather than as a flag
      // on the org, because a workspace can legitimately approve more than one
      // (an agency and its client, a company mid-rename).
      await db.query(
        `CREATE TABLE IF NOT EXISTS workspace_domains (
          owner_key  TEXT NOT NULL,
          domain     TEXT NOT NULL,
          role       TEXT NOT NULL DEFAULT 'member',
          added_by   TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (owner_key, domain)
        )`,
        [],
        'org-system'
      );
    })().catch((err) => {
      schemaReadyPromise = null;
      // Two processes bootstrapping the same schema at once both run CREATE
      // TABLE IF NOT EXISTS, and Postgres can still raise a duplicate-key error
      // on pg_type between the existence check and the create. It means the
      // table is there, which is all this cared about. Same guard the context
      // store already carries; without it a parallel test run or a multi-replica
      // cold start fails on a race that has already resolved itself.
      if (err?.code === '23505' && String(err.message || '').includes('pg_type_typname_nsp_index')) return;
      throw err;
    });
  }
  return schemaReadyPromise;
}

/**
 * Every user already belongs to exactly one organization, created at signup, so
 * the membership table starts as a projection of that fact rather than as an
 * empty table nobody is in. Idempotent: safe to run on every boot.
 *
 * Runs INSERT ... SELECT rather than a read-then-write loop so it cannot race
 * with a concurrent signup.
 */
async function backfillMembershipsFromUsers() {
  await ensureSchema();
  const result = await db.query(
    `INSERT INTO workspace_members (owner_key, user_id, role, joined_at)
     SELECT u.org_id, u.user_id,
            CASE WHEN u.role IN ('owner', 'admin') THEN 'owner'
                 WHEN u.role IN ('read-only') THEN 'viewer'
                 ELSE 'member' END,
            u.created_at
       FROM users u
      WHERE u.org_id IS NOT NULL
     ON CONFLICT (owner_key, user_id) DO NOTHING`,
    [],
    'org-system'
  );
  return result.rowCount || 0;
}

/**
 * The workspace this actor is operating in.
 *
 * `workspace_key` is set by the auth middleware only after membership has been
 * checked (see bindWorkspace), so reading it first is safe and is what lets an
 * invited teammate reach the workspace they were invited to rather than the
 * personal org their user row was created in. Absent that, behaviour is exactly
 * what it always was.
 */
function defaultOwnerKey(actor) {
  return actor?.workspace_key || actor?.org_id || actor?.id || null;
}

/**
 * Has this actor been removed from the workspace they are defaulting into?
 *
 * defaultOwnerKey returns actor.org_id with no membership check, which is right
 * for somebody's own account and wrong for anyone whose users.org_id happens to
 * BE a team workspace — the legacy invite path (routes/shared/orgs.js) creates
 * users directly in the target org, so that is a real population. Removing them
 * set removed_at and revoked their keys, but they kept full access simply by not
 * sending a workspace header.
 *
 * Checked as an explicit "is this person barred" rather than folded into
 * defaultOwnerKey, which is synchronous and called on hot paths; the middleware
 * does the async part once per request.
 */
// The workspace this person last chose, if it is still theirs to enter.
//
// Returns null for "use your personal org" — the default, and the answer for
// everybody who has never switched. Membership is re-checked on every read
// rather than trusted from the flag, so removing somebody takes effect on their
// next request instead of the next time they happen to switch.
async function getActiveWorkspace(actor) {
  const userId = actorPersonId(actor);
  if (!userId) return null;
  await ensureSchema();
  const result = await db.query(
    `SELECT owner_key FROM workspace_members
      WHERE user_id = $1 AND is_active AND removed_at IS NULL
      LIMIT 1`,
    [userId],
    'org-system'
  );
  return result.rows[0]?.owner_key || null;
}

// WHERE THIS PERSON IS WORKING RIGHT NOW, by id: the workspace they selected (the
// is_active row, membership re-checked) or, when none is, their own. Null only
// for somebody who does not exist. Used once per old OAuth grant, to stamp the
// workspace it acts in today (see config/autoMigrate.js and routes/oauth.js), so
// pinning a grant to a workspace moves nobody.
async function selectedWorkspaceKeyForPerson(userId) {
  if (!userId) return null;
  await ensureSchema();
  const active = await db.query(
    `SELECT owner_key FROM workspace_members
      WHERE user_id = $1 AND is_active AND removed_at IS NULL
      LIMIT 1`,
    [userId],
    'org-system'
  );
  if (active.rows[0]?.owner_key) return active.rows[0].owner_key;
  const home = await db.query('SELECT org_id FROM users WHERE user_id = $1', [userId], 'org-system');
  return home.rows[0]?.org_id || null;
}

// THE PERSON'S OWN WORKSPACE — users.org_id — for any actor.
//
// For a session actor that is actor.org_id. For a KEY it is not: a key's org_id
// is the workspace the key was minted in, which keys.js deliberately stamps as
// the TEAM for a teammate's key. Reading it as "personal" is how a key minted
// in team T could not select T (setActiveWorkspace took T for "go home" and
// cleared the choice), and how /teams/workspaces labelled T personal:true.
// Only the questions that mean "the person's own workspace" ask this; the
// DEFAULT BINDING of a key (defaultOwnerKey, the auth middleware) is its minted
// workspace and stays so. A key with no owning person has nobody to look up and
// keeps its own org. Memoised per actor object, which is per request.
const personalWorkspaceByActor = new WeakMap();
async function personalWorkspaceKey(actor) {
  if (!actor) return null;
  if (actor.type !== 'key') return actor.org_id || null;
  const person = actorPersonId(actor);
  if (!person) return actor.org_id || null;
  if (personalWorkspaceByActor.has(actor)) return personalWorkspaceByActor.get(actor);
  const result = await db.query('SELECT org_id FROM users WHERE user_id = $1', [person], 'org-system');
  const home = result.rows[0]?.org_id || null;
  personalWorkspaceByActor.set(actor, home);
  return home;
}

// Point somebody at a workspace they belong to. Passing null (or their own org)
// returns them to their personal workspace.
async function setActiveWorkspace(actor, ownerKey) {
  const userId = actorPersonId(actor);
  if (!userId) throw new WorkspaceAccessError('This credential cannot switch workspace.');
  await ensureSchema();

  if (!ownerKey || ownerKey === await personalWorkspaceKey(actor)) {
    await db.query(
      'UPDATE workspace_members SET is_active = FALSE WHERE user_id = $1 AND is_active',
      [userId],
      'org-system'
    );
    return null;
  }

  const membership = await getMembership(ownerKey, userId);
  if (!membership) throw new WorkspaceAccessError('You are not a member of this workspace.');

  // Clear then set: the partial unique index would reject two active rows, and
  // doing it in that order keeps the failure mode "no active workspace" (falls
  // back to personal) rather than "two", which the index would refuse outright.
  await db.query(
    'UPDATE workspace_members SET is_active = FALSE WHERE user_id = $1 AND is_active',
    [userId],
    'org-system'
  );
  await db.query(
    'UPDATE workspace_members SET is_active = TRUE WHERE user_id = $1 AND owner_key = $2 AND removed_at IS NULL',
    [userId, ownerKey],
    'org-system'
  );
  return ownerKey;
}

// `byOwnerOnly`: count only a removal an owner made, not the person leaving on
// their own (see left_voluntarily). The domain door asks that question; the
// own-workspace binding checks ask the plain one.
async function isRemovedFrom(ownerKey, actor, { byOwnerOnly = false } = {}) {
  const userId = actorPersonId(actor);
  if (!ownerKey || !userId) return false;
  await ensureSchema();
  const result = await db.query(
    `SELECT 1 FROM workspace_members
      WHERE owner_key = $1 AND user_id = $2 AND removed_at IS NOT NULL${byOwnerOnly ? ' AND NOT left_voluntarily' : ''}`,
    [ownerKey, userId],
    'org-system'
  );
  return result.rows.length > 0;
}

/**
 * Is this actor STILL admitted to `ownerKey`? For a long-lived connection
 * (GET /context/stream) that authenticated once and must not outlive the
 * person's removal: authentication binds a workspace per REQUEST, and an SSE
 * request never ends. True for a system or internal actor (no person behind
 * it), for an active member, and for somebody in their own default workspace
 * who has not been removed from it (a solo account predating the membership
 * backfill has no row there). False once they have been removed — or erased,
 * which deletes the row outright — from any workspace that is not their own.
 */
async function isStillAdmitted(ownerKey, actor) {
  if (!ownerKey || actor?.type === 'system' || ownerKey === 'org-system') return true;
  const userId = actorPersonId(actor);
  if (!userId) return true;
  if (await getMembership(ownerKey, userId)) return true;
  if (ownerKey !== actor?.org_id) return false;
  return !(await isRemovedFrom(ownerKey, actor));
}

/**
 * The HUMAN behind an actor.
 *
 * `actor.id` is the user id for a session-authed request and the API KEY id for
 * a key-authed one. Every attribution site in the codebase used actor.id
 * directly, so anything written through MCP — which is nearly everything — was
 * attributed to a credential rather than to a person: owner_user_id on created
 * projects, contributing_user_id on events, and therefore
 * listProjectContributors, which was counting keys and calling them teammates.
 * Rotate your key and you became a different contributor.
 *
 * One person can still hold several keys, so anything that MATCHES on identity
 * must use actorIdentities() rather than this alone.
 */
function actorPersonId(actor) {
  if (!actor) return null;
  if (actor.type === 'key') return actor.owner_id || null;
  if (actor.type === 'system') return null;
  // An internal caller (a migration script, a job) is commonly constructed as
  // `{ id: ownerKey }` — its "id" is the WORKSPACE, not a human. Attributing a
  // project to that id invents a person who does not exist and, worse, one whom
  // nobody can ever match: the row then belongs to an identity no real actor
  // carries, so it is invisible to everybody including the workspace's owner.
  //
  // Organisations are minted `org-<uuid>` (plus the 'org-system' sentinel) and
  // users `user-<uuid>`, so the shapes are distinguishable. Null is the correct
  // answer here and is already meaningful: unattributed means workspace-owned,
  // which is exactly what a script-created project is.
  if (typeof actor.id === 'string' && /^org[-_]/.test(actor.id)) return null;
  return actor.id || null;
}

/**
 * Every id a given actor may legitimately appear under in stored rows: the
 * person, plus the raw actor id for rows written before actorPersonId existed.
 *
 * Widening the match cannot leak across people — one person's key id is never
 * another person's — and narrowing it would hide somebody's own history from
 * them, which is the worse error of the two.
 */
function actorIdentities(actor) {
  const ids = new Set();
  const person = actorPersonId(actor);
  if (person) ids.add(person);
  if (actor?.id) ids.add(actor.id);
  return [...ids];
}

/**
 * WHO A STAMPED AUTHOR IS, AND WHETHER THEY ARE STILL IN THIS WORKSPACE.
 *
 * A project or entry written before the identity fix carries the author's KEY id
 * in place of their user id (see actorIdentities). Whether that author "has left"
 * is judged on the PERSON: a stamped id that is an active member's user id is
 * theirs; one that is an api_keys row owned by an active member is theirs too
 * (so an owner cannot act on an active colleague's work because it predates the
 * fix); one that belongs to nobody, or to a person with no active membership
 * (removed, erased), has left; an unresolvable KEY id is ambiguous in a workspace
 * with more than one active member and is not left. Returns { isActive(id), personOf(id) } for the ids
 * asked about. `personOf` is the person a KEY id belongs to (or the id itself
 * when it is an active member's), else null.
 */
async function resolveAuthors(ownerKey, ids = []) {
  // Through the export, so a test that stubs the roster is honoured.
  const members = await module.exports.listMembers(ownerKey);
  const active = new Set(members.filter((member) => !member.removed_at).map((member) => member.user_id));
  const unknown = [...new Set((ids || []).filter((id) => typeof id === 'string' && id && !active.has(id)))];
  const owners = new Map();
  if (unknown.length) {
    const result = await db.query(
      'SELECT key_id, owner_id FROM api_keys WHERE key_id = ANY($1::text[])',
      [unknown],
      'org-system'
    );
    for (const row of result.rows || []) if (row.owner_id) owners.set(row.key_id, row.owner_id);
  }
  const personOf = (id) => (active.has(id) ? id : owners.get(id) || null);
  const isActive = (id) => {
    const person = personOf(id);
    if (person) return active.has(person);
    // UNRESOLVABLE. A user id with no active membership is somebody erased or
    // gone: left. A KEY id whose api_keys row is gone (keys are hard-deleted) could
    // have been anybody's: with one active member in the workspace it can only be
    // theirs (or nobody's), so it is left as before; with several it is AMBIGUOUS
    // and counts as NOT left. Privacy wins when we cannot tell.
    return typeof id === 'string' && /^key[-_]/i.test(id) && active.size > 1;
  };
  return { isActive, personOf };
}

async function getMembership(ownerKey, userId) {
  if (!ownerKey || !userId) return null;
  await ensureSchema();
  const result = await db.query(
    `SELECT owner_key, user_id, role, joined_at, invited_by
       FROM workspace_members
      WHERE owner_key = $1 AND user_id = $2 AND removed_at IS NULL`,
    [ownerKey, userId],
    'org-system'
  );
  if (!result.rows.length) return null;
  const row = result.rows[0];
  return { ...row, role: normalizeRole(row.role) };
}

async function listMemberships(userId) {
  if (!userId) return [];
  await ensureSchema();
  const result = await db.query(
    `SELECT owner_key, role, joined_at
       FROM workspace_members
      WHERE user_id = $1 AND removed_at IS NULL
      ORDER BY joined_at ASC`,
    [userId],
    'org-system'
  );
  return result.rows.map((row) => ({ ...row, role: normalizeRole(row.role) }));
}

async function listMembers(ownerKey, { includeRemoved = false } = {}) {
  if (!ownerKey) return [];
  await ensureSchema();
  const where = includeRemoved ? '' : ' AND m.removed_at IS NULL';
  const result = await db.query(
    `SELECT m.user_id, m.role, m.joined_at, m.removed_at, m.invited_by, u.email
       FROM workspace_members m
       LEFT JOIN users u ON u.user_id = m.user_id
      WHERE m.owner_key = $1${where}
      ORDER BY m.joined_at ASC`,
    [ownerKey],
    'org-system'
  );
  return result.rows.map((row) => ({
    user_id: row.user_id,
    email: row.email || null,
    role: normalizeRole(row.role),
    joined_at: row.joined_at,
    removed_at: row.removed_at || null,
    invited_by: row.invited_by || null,
    active: !row.removed_at,
  }));
}

/**
 * How every query in this service runs by default.
 *
 * All of them are system-scoped ('org-system' is the RLS bypass marker; the
 * workspace_* and context_* tables carry no policies). The helpers below take
 * one as an argument so addMember can hand them a TRANSACTION-bound executor
 * and run its precheck, insert, claim and flip as a single unit under one
 * advisory lock — see the comment there.
 */
const systemExec = (text, params) => db.query(text, params, 'org-system');

async function countActiveMembers(ownerKey, exec = systemExec) {
  if (!ownerKey) return 0;
  await ensureSchema();
  const result = await exec(
    `SELECT COUNT(*) FILTER (WHERE removed_at IS NULL)::int AS active,
            COUNT(*)::int AS total
       FROM workspace_members WHERE owner_key = $1`,
    [ownerKey]
  );
  const { active = 0, total = 0 } = result.rows[0] || {};
  if (Number(total) > 0) return Number(active);

  // No membership rows AT ALL — a workspace that predates this table, or one
  // whose users were created after the boot-time backfill ran. Fall back to the
  // org's user rows, which membership is a projection of.
  //
  // Excludes anyone with a removed_at row for this workspace. users.org_id is
  // never cleared on removal, so counting it raw re-admits people who were taken
  // out: a workspace with no active members could report several, isShared would
  // return true, and new projects would default to 'shared' in a workspace that
  // has nobody in it.
  const legacy = await exec(
    `SELECT COUNT(*)::int AS n
       FROM users u
      WHERE u.org_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM workspace_members m
           WHERE m.owner_key = $1 AND m.user_id = u.user_id AND m.removed_at IS NOT NULL
        )`,
    [ownerKey]
  ).catch(() => ({ rows: [{ n: 0 }] }));
  return Number(legacy.rows[0]?.n || 0);
}

/**
 * True once a workspace holds more than one person. Several behaviours key off
 * this rather than off a plan flag, because they are correctness concerns rather
 * than billing ones: a solo workspace has no one to hide anything from.
 */
async function isSharedWorkspace(ownerKey, exec = systemExec) {
  return (await countActiveMembers(ownerKey, exec)) > 1;
}

/**
 * How many people can still administer this workspace.
 *
 * Zero is a real and reachable state: erasing a person hard-deletes their
 * membership rows (forgetPerson), and the person erased is very often the
 * founder. A workspace with members, projects and a live subscription but no
 * owner cannot invite, cannot bill, and cannot be handed to anyone — so the
 * number has to be knowable at the moment it goes to zero, not discovered by
 * the colleague who tries to use it.
 *
 * Counts the legacy spelling too: 'admin' maps forward to 'owner', and a
 * workspace whose last owner-by-any-name is gone is just as ownerless.
 */
/**
 * The workspaces this person is the ONLY active owner of while somebody else is
 * still in them — the teams their account deletion would leave with nobody able
 * to bill, administer or delete them, over a subscription that keeps charging.
 * Returns [{ id, name }]. Legacy 'admin' counts as owner, as countActiveOwners.
 *
 * Read by the two "delete my account" routes, which refuse (409 sole_owner)
 * while this is non-empty. Not by the Clerk user.deleted webhook: an erasure
 * request is not refusable, and that path retains-and-reports instead.
 */
async function listSoleOwnedTeams(identities = []) {
  const ids = [...new Set((identities || []).filter(Boolean))];
  if (!ids.length) return [];
  await ensureSchema();
  const result = await db.query(
    `SELECT m.owner_key AS id, o.name
       FROM workspace_members m
       LEFT JOIN organizations o ON o.org_id = m.owner_key
      WHERE m.user_id = ANY($1::text[]) AND m.removed_at IS NULL AND m.role IN ('owner', 'admin')
        AND NOT EXISTS (
          SELECT 1 FROM workspace_members x
           WHERE x.owner_key = m.owner_key AND x.removed_at IS NULL
             AND x.role IN ('owner', 'admin') AND NOT (x.user_id = ANY($1::text[]))
        )
        AND EXISTS (
          SELECT 1 FROM workspace_members y
           WHERE y.owner_key = m.owner_key AND y.removed_at IS NULL AND NOT (y.user_id = ANY($1::text[]))
        )
      ORDER BY o.name NULLS LAST, m.owner_key`,
    [ids],
    'org-system'
  );
  const seen = new Set();
  return result.rows
    .filter((row) => (seen.has(row.id) ? false : seen.add(row.id)))
    .map((row) => ({ id: row.id, name: row.name || null }));
}

/**
 * THE WORKSPACES NOBODY BUT THIS PERSON IS LEFT IN — which closing their account
 * has to close too, or nobody ever can.
 *
 * listSoleOwnedTeams (above) catches the teams that still have OTHER people in
 * them, and both delete routes refuse over those. It says nothing about the
 * opposite case: a second workspace (POST /teams/workspaces) that everybody else
 * has left. Closing the account erased the person's membership there and left
 * the workspace standing — its org row, its projects and graph, and a live
 * subscription — with a roster of tombstones: nobody who could reach the billing
 * portal to cancel it, nobody who could even see it.
 *
 * "Nobody else" means no other ACTIVE membership row AND no other users row
 * pointing at the workspace that the roster has not removed: resolveRole's
 * own-org fallback admits such a legacy resident with no row at all, so they are
 * an occupant too. A removed legacy resident is not — rehomeResidentsBeforeClose
 * moves them out before the close. Any role counts: a lone viewer is as much the
 * last person able to reach it as a lone owner.
 *
 * `exclude` is the home org, which the caller closes through its own sequence.
 * Returns [{ id, name }].
 */
function soleOccupantPredicate(keyExpr, idsExpr) {
  return `NOT EXISTS (
      SELECT 1 FROM workspace_members x
       WHERE x.owner_key = ${keyExpr} AND x.removed_at IS NULL AND NOT (x.user_id = ANY(${idsExpr}::text[]))
    )
    AND NOT EXISTS (
      SELECT 1 FROM users u
       WHERE u.org_id = ${keyExpr} AND NOT (u.user_id = ANY(${idsExpr}::text[]))
         AND NOT EXISTS (
           SELECT 1 FROM workspace_members r
            WHERE r.owner_key = ${keyExpr} AND r.user_id = u.user_id AND r.removed_at IS NOT NULL
         )
    )`;
}

async function listSoleMemberWorkspaces(identities = [], { exclude = [], exec = systemExec } = {}) {
  const ids = [...new Set((identities || []).filter(Boolean))];
  if (!ids.length) return [];
  await ensureSchema();
  const result = await exec(
    `SELECT DISTINCT m.owner_key AS id, o.name
       FROM workspace_members m
       LEFT JOIN organizations o ON o.org_id = m.owner_key
      WHERE m.user_id = ANY($1::text[]) AND m.removed_at IS NULL
        AND NOT (m.owner_key = ANY($2::text[]))
        AND ${soleOccupantPredicate('m.owner_key', '$1')}
      ORDER BY o.name NULLS LAST, m.owner_key`,
    [ids, [...new Set((exclude || []).filter(Boolean))]]
  );
  return result.rows.map((row) => ({ id: row.id, name: row.name || null }));
}

/**
 * Re-check, inside the closing transaction and under the membership lock
 * addMember takes, that nobody but `identities` occupies `ownerKey`. The list
 * above is read before the transaction (billing is cancelled in between), so a
 * join landing in that window must stop the close rather than be erased by it.
 * `identities` may no longer have a row at all (the Clerk webhook drops the
 * person's memberships first); the predicate only asks about everybody else.
 */
async function lockAndConfirmSoleOccupant(client, ownerKey, identities = []) {
  const ids = [...new Set((identities || []).filter(Boolean))];
  await client.query(
    'SELECT pg_advisory_xact_lock($1, hashtext($2))',
    [WORKSPACE_MEMBERSHIP_LOCK_NAMESPACE, ownerKey]
  );
  const r = await client.query(
    `SELECT ${soleOccupantPredicate('$1', '$2')} AS sole`,
    [ownerKey, ids]
  );
  return r.rows[0]?.sole === true;
}

// How long a closure mark holds the door shut. A close takes seconds (billing,
// the export email, one transaction); a mark older than this is a close that
// died without clearing it, and the workspace is open again.
const WORKSPACE_CLOSING_TTL_MINUTES = 30;

/**
 * Mark `ownerKey` as closing, provided nobody but `identities` occupies it —
 * judged under the membership lock, in its own short transaction, so from the
 * moment this returns true no join can land (addMember reads the mark under the
 * same lock). Returns false, marking nothing, when somebody else is in it.
 * Call BEFORE cancelling the workspace's billing; see workspace_closures.
 */
async function markWorkspaceClosing(ownerKey, identities = []) {
  if (!ownerKey) return false;
  await ensureSchema();
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const sole = await lockAndConfirmSoleOccupant(client, ownerKey, identities);
    if (!sole) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `INSERT INTO workspace_closures (owner_key, started_at) VALUES ($1, NOW())
       ON CONFLICT (owner_key) DO UPDATE SET started_at = NOW()`,
      [ownerKey]
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Open the door again: a close that gave up (billing failed, somebody got in
 * first, the transaction rolled back). `exec` runs it inside a caller's
 * transaction — the close itself, where it commits with the purge.
 */
async function clearWorkspaceClosing(ownerKeys, exec = null) {
  const keys = [...new Set((Array.isArray(ownerKeys) ? ownerKeys : [ownerKeys]).filter(Boolean))];
  if (!keys.length) return;
  await ensureSchema();
  const run = exec || systemExec;
  await run('DELETE FROM workspace_closures WHERE owner_key = ANY($1::text[])', [keys]);
}

async function isWorkspaceClosing(ownerKey, exec) {
  const r = await exec(
    `SELECT 1 FROM workspace_closures
      WHERE owner_key = $1 AND started_at > NOW() - make_interval(mins => $2::int)`,
    [ownerKey, WORKSPACE_CLOSING_TTL_MINUTES]
  );
  return r.rows.length > 0;
}

// The 409 both "delete my account" routes answer while listSoleOwnedTeams is
// non-empty. One builder so the two routes cannot word it differently.
function soleOwnerConflict(teams = []) {
  const named = teams.map((team) => team.name || team.id).join(', ');
  return {
    error: 'sole_owner',
    message: `You are the only owner of ${named}, which still has other members. `
      + 'Make someone else an owner, or remove the other members, before deleting your account — '
      + 'otherwise nobody could manage or cancel that workspace\'s subscription.',
    workspaces: teams.map((team) => ({ id: team.id, name: team.name })),
  };
}

async function countActiveOwners(ownerKey) {
  if (!ownerKey) return 0;
  await ensureSchema();
  const result = await db.query(
    `SELECT COUNT(*)::int AS n
       FROM workspace_members
      WHERE owner_key = $1 AND removed_at IS NULL AND role IN ('owner', 'admin')`,
    [ownerKey],
    'org-system'
  );
  return Number(result.rows[0]?.n || 0);
}

// One advisory-lock namespace for "membership changes to this workspace", so a
// hash collision with the boot migration's lock (0x44443031) is impossible: the
// two-int form of pg_advisory_xact_lock keys off both numbers.
const WORKSPACE_MEMBERSHIP_LOCK_NAMESPACE = 0x44443032; // 'DD02'

/**
 * Add somebody to a workspace. Returns the membership.
 *
 * The backfill on the second member is the load-bearing part and is explained at
 * length in backfillProjectOwnership() — in short, a NULL owner_user_id is
 * ambiguous, and the only moment it can be resolved without guessing is the
 * moment before a second person can read it.
 *
 * ALL OF IT RUNS AS ONE UNIT, UNDER ONE LOCK.
 *
 * The claim used to be the whole concurrency story: an INSERT that only one
 * caller can win. That is sound for two backfills racing and unsound for the
 * moment it actually matters. Two invites accepted milliseconds apart on the
 * very first 1->2 join interleave like this: A inserts its membership row; B,
 * now seeing two rows, concludes from hasEverHeldTwoMembers that this workspace
 * predates the marker and claims it as ALREADY DONE; A's claim then returns
 * false and the backfill never runs. Pre-team projects keep visibility 'private'
 * and a NULL author for good — the marker says it was handled.
 *
 * And the marker was written BEFORE the flip while the flip swallowed its own
 * errors, so a backfill that failed halfway was recorded as complete and could
 * never be retried.
 *
 * So: one transaction, one advisory lock per workspace, precheck and insert and
 * claim and flip inside it, and the marker written only after the flip has
 * succeeded. An error rolls the whole thing back, which leaves the marker
 * unclaimed and the next join free to retry.
 */
async function addMember(ownerKey, userId, {
  role = 'member', invitedBy = null, seatCheck = null, acceptInviteId = null,
} = {}) {
  if (!ownerKey || !userId) throw new Error('addMember requires ownerKey and userId');
  const normalized = ROLES.includes(role) ? role : normalizeRole(role);
  await ensureSchema();

  let committedStaleGrants = [];
  const client = await db.pool.connect();
  const exec = (text, params) => client.query(text, params);
  try {
    await client.query('BEGIN');
    // Serialises membership changes to THIS workspace only. Held to COMMIT, and
    // taken before the first read so no other accept can observe a half-applied
    // state. Other workspaces, and every request, are unaffected.
    await client.query(
      'SELECT pg_advisory_xact_lock($1, hashtext($2))',
      [WORKSPACE_MEMBERSHIP_LOCK_NAMESPACE, ownerKey]
    );

    // A workspace whose last occupant is closing their account is on its way
    // out, and its billing may already be cancelled: joining it now would
    // leave a live team with no subscription. Read under this lock, which the
    // close's mark was written under. See workspace_closures.
    if (await isWorkspaceClosing(ownerKey, exec)) {
      const error = new Error('This workspace is being closed, so nobody can join it.');
      error.status = 409;
      error.code = 'workspace_closing';
      throw error;
    }

    // THE SEAT CAP IS CHECKED UNDER THE LOCK, OR IT IS NOT A CAP.
    //
    // Both doors counted members and invitations BEFORE calling here, outside
    // this lock, so three people accepting at once into a three-seat team with
    // two seats used each saw one free seat and all three got in: four or five
    // active members on a plan billed for three. Counted here, after the lock,
    // each accept sees the one before it.
    //
    // PENDING INVITATIONS ARE RESERVATIONS, NOT OCCUPANCY.
    //
    // Somebody redeeming an invitation (`seatCheck.excludeInviteId`) is the
    // person a reservation was made for, so they are admitted while an ACTIVE
    // seat is free — the other pending invitations do not count against them.
    // Counting them refused every invitee of a team whose seats had been cut
    // below its outstanding invitations, each blocked by the others' pending
    // rows although a seat stood empty. Somebody arriving WITHOUT a
    // reservation (the domain door) must leave the reserved seats alone, so for
    // them every open invitation counts. Sending an invitation reserves: the
    // /invite route counts active + pending. Somebody who is already an active
    // member takes no new seat.
    //
    // THE DOMAIN DOOR SPENDS THE JOINER'S OWN INVITATION (`seatCheck.email`).
    // Invited AND on an approved domain, a person who came in through the door
    // held a membership and a pending invitation at once: two seats for one
    // person, refused 402 when only their own reserved seat was left, and — the
    // invitation still open — able to walk back in on it after an owner removed
    // them. The door is then a redemption of that invitation: its role, its
    // inviter, spent in this transaction.
    let admitRole = normalized;
    let admitInvitedBy = invitedBy;
    let spendInviteId = acceptInviteId;
    if (seatCheck && seatCheck.email && !spendInviteId) {
      const own = await exec(
        `SELECT invite_id, role, invited_by FROM workspace_invites
          WHERE owner_key = $1 AND email = lower(btrim($2))
            AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at > NOW()
          FOR UPDATE`,
        [ownerKey, seatCheck.email]
      );
      if (own.rows.length) {
        spendInviteId = own.rows[0].invite_id;
        admitRole = normalizeRole(own.rows[0].role);
        admitInvitedBy = own.rows[0].invited_by || invitedBy;
      }
    }
    if (seatCheck) {
      const already = await exec(
        'SELECT 1 FROM workspace_members WHERE owner_key = $1 AND user_id = $2 AND removed_at IS NULL',
        [ownerKey, userId]
      );
      if (!already.rows.length) {
        const active = await countActiveMembers(ownerKey, exec);
        const reserved = Boolean(seatCheck.excludeInviteId || spendInviteId);
        const pending = reserved ? null : await exec(
          `SELECT COUNT(*)::int AS n FROM workspace_invites
            WHERE owner_key = $1 AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at > NOW()`,
          [ownerKey]
        );
        // Required here: entitlementService reaches back into plans and
        // referrals. Throws { status: 402, code: 'limit_exceeded' }, which rolls
        // the whole join back below.
        const { checkLimit } = require('./entitlementService');
        await checkLimit(ownerKey, 'included_seats', active + Number(pending?.rows[0]?.n || 0));
      }
    }

    const wasShared = await isSharedWorkspace(ownerKey, exec);
    // A workspace that has ALREADY held two people has been through the backfill,
    // whether or not the marker existed at the time. Read while the row count
    // still describes the workspace as it was, so every pre-existing team is
    // marked done rather than re-backfilled.
    const predatesMarker = await hasEverHeldTwoMembers(ownerKey, exec);
    if (predatesMarker) await claimOwnershipBackfill(ownerKey, exec);

    // JOINING AGAIN NEVER REVIVES AN OLD GRANT. A hosted connection is pinned to
    // the workspace it was approved for (oauth_workspace_key), and membership is
    // what admits it. Anything stamped for this workspace that belongs to a
    // person who was NOT an active member a moment ago predates this membership:
    // they left, or were removed by a path that revoked nothing, and coming back
    // must mean approving the tool again. Somebody already active is left alone.
    const wasActive = await exec(
      'SELECT 1 FROM workspace_members WHERE owner_key = $1 AND user_id = $2 AND removed_at IS NULL',
      [ownerKey, userId]
    );
    let staleGrants = [];
    if (!wasActive.rows.length && await tableExists(exec, 'api_keys')) {
      const stale = await exec(
        `UPDATE api_keys SET status = 'revoked'
          WHERE owner_id = $1 AND oauth_workspace_key = $2
            AND oauth_resource IS NOT NULL AND status = 'active'
        RETURNING key_hash`,
        [userId, ownerKey]
      );
      staleGrants = stale.rows.map((row) => row.key_hash).filter(Boolean);
    }

    await exec(
      `INSERT INTO workspace_members (owner_key, user_id, role, invited_by, joined_at, removed_at)
       VALUES ($1, $2, $3, $4, NOW(), NULL)
       ON CONFLICT (owner_key, user_id)
       DO UPDATE SET role = EXCLUDED.role, removed_at = NULL, left_voluntarily = FALSE,
                     joined_at = COALESCE(workspace_members.joined_at, NOW())`,
      [ownerKey, userId, admitRole, admitInvitedBy]
    );
    // The invitation is spent in the same transaction that admits its holder,
    // so no concurrent accept can see this person both as a member AND as a
    // pending invitation (two seats for one person), and none can see neither.
    if (spendInviteId) {
      await exec(
        `UPDATE workspace_invites SET accepted_at = NOW(), accepted_user_id = $2
          WHERE invite_id = $1 AND accepted_at IS NULL`,
        [spendInviteId, userId]
      );
    }

    // ONCE PER WORKSPACE, NOT ONCE PER 1->2 TRANSITION.
    //
    // isSharedWorkspace counts ACTIVE members, so a two-person team that loses
    // somebody and hires a replacement crosses 1->2 a second time. The backfill
    // flips every 'private' project to 'personal', which is right for work that
    // predates the team and catastrophic afterwards: the departed engineer's
    // org-owned project became his alone, and the owner who had been reading it
    // got resource_not_found on work nobody could now reach. Two-person teams are
    // the norm here, because the plan has a two-seat minimum.
    if (!wasShared
      && !predatesMarker
      && await isSharedWorkspace(ownerKey, exec)
      && !(await ownershipBackfillClaimed(ownerKey, exec))) {
      // Errors propagate. This used to swallow them, which turned "the flip did
      // not happen" into a permanent state recorded as success.
      //
      // ONLY A WORKSPACE THAT WAS SOMEBODY'S OWN HAS SOLO HISTORY.
      //
      // The flip exists for a personal org upgraded to Team: everything in it
      // predates the team. A workspace made by POST /teams/workspaces was a
      // team from birth — it is nobody's users.org_id — and what it holds was
      // moved in deliberately, stamped 'private' ("visible to you and to
      // owners"). Flipping that to 'personal' on the first invitation broke the
      // promise the new-team wizard made. New ones are marked done at creation;
      // this covers the ones created before that marker was written.
      if (!(await createdAsTeam(ownerKey, exec))) {
        await backfillProjectOwnership(ownerKey, exec);
      }
      // The marker is the record of a COMPLETED backfill, so it is written last.
      await claimOwnershipBackfill(ownerKey, exec);
    }

    await client.query('COMMIT');
    committedStaleGrants = staleGrants;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* connection already broken */ });
    throw err;
  } finally {
    client.release();
  }

  // The api-key cache serves a key without re-reading the table, so a revoked
  // row is not a revoked key until every instance drops it.
  if (committedStaleGrants.length) {
    const apiKeyCache = require('./apiKeyCache');
    await Promise.all(committedStaleGrants.map((hash) => apiKeyCache.invalidateApiKey(hash).catch((err) => {
      console.error(`[WORKSPACE] key cache invalidation failed: ${err.message}`);
    })));
  }

  return getMembership(ownerKey, userId);
}

/**
 * Has this workspace ever held two people at once, counting the ones who left?
 *
 * The membership row survives removal (removeMember only stamps removed_at), so
 * this is a durable answer for every workspace that predates the marker table.
 * It is not sufficient on its own — forgetPerson hard-deletes rows when a person
 * is erased — which is why the marker exists as well.
 */
async function hasEverHeldTwoMembers(ownerKey, exec = systemExec) {
  if (!ownerKey) return false;
  const result = await exec(
    'SELECT COUNT(*)::int AS n FROM workspace_members WHERE owner_key = $1',
    [ownerKey]
  ).catch(() => ({ rows: [{ n: 0 }] }));
  return Number(result.rows[0]?.n || 0) > 1;
}

/**
 * Was this workspace created as a team rather than as somebody's own account?
 *
 * Every signup path points the new user's users.org_id at the org it creates,
 * and so does the legacy invite path for the people it created inside a target
 * org. POST /teams/workspaces points nobody's users.org_id at the workspace it
 * creates. So "no user calls this home" identifies a workspace born as a team.
 *
 * Fails towards FALSE — running the backfill — because that is the privacy-
 * preserving direction: wrongly flipping to 'personal' hides a project from a
 * co-owner (its author can share it again), while wrongly skipping it would
 * expose somebody's solo history to a future co-owner.
 */
async function createdAsTeam(ownerKey, exec = systemExec) {
  if (!ownerKey) return false;
  const result = await exec(
    'SELECT 1 FROM users WHERE org_id = $1 LIMIT 1',
    [ownerKey]
  ).catch(() => null);
  if (!result) return false;
  return result.rows.length === 0;
}

/**
 * Has the one-time project-ownership backfill already been recorded?
 *
 * Read separately from the claim because the marker now means "the flip
 * succeeded", not "somebody is about to try": addMember checks this before
 * running the backfill and writes the marker afterwards, both inside the same
 * locked transaction, so the read-then-write cannot interleave.
 */
async function ownershipBackfillClaimed(ownerKey, exec = systemExec) {
  if (!ownerKey) return false;
  const result = await exec(
    'SELECT 1 FROM workspace_ownership_backfills WHERE owner_key = $1',
    [ownerKey]
  ).catch(() => ({ rows: [] }));
  return result.rows.length > 0;
}

/**
 * Record that the one-time project-ownership backfill is done for a workspace.
 *
 * Returns true when this call wrote the marker. Callers run inside addMember's
 * per-workspace advisory lock, so the INSERT is a record rather than a race
 * (it was the gate as well until the gate turned out to be the bug: see
 * addMember).
 */
async function claimOwnershipBackfill(ownerKey, exec = systemExec) {
  if (!ownerKey) return false;
  const result = await exec(
    `INSERT INTO workspace_ownership_backfills (owner_key)
     VALUES ($1)
     ON CONFLICT (owner_key) DO NOTHING`,
    [ownerKey]
  ).catch(() => ({ rowCount: 0 }));
  return (result.rowCount || 0) > 0;
}

/**
 * Record that a brand-new account owns the personal workspace just created for it.
 *
 * Every signup path (password signup, the Clerk webhook, Clerk JIT provisioning)
 * created a user and an org and no membership row, so the ONLY writer for a new
 * founder was the boot-time backfill. Anyone who signed up between deploys and
 * then bought Team was absent from their own roster: GET /members omitted them,
 * every member PATCH/DELETE 409'd as last_owner, the seat count excluded them,
 * and backfillProjectOwnership never ran because the first invite took the count
 * from 0 to 1 rather than 1 to 2.
 *
 * DO NOTHING on conflict, deliberately unlike addMember: this runs on paths that
 * can re-run for an existing person, and it must never resurrect a removed row or
 * overwrite a role somebody changed since.
 */
async function ensureOwnerMembership(ownerKey, userId) {
  if (!ownerKey || !userId) return false;
  await ensureSchema();
  const result = await db.query(
    `INSERT INTO workspace_members (owner_key, user_id, role, joined_at)
     VALUES ($1, $2, 'owner', NOW())
     ON CONFLICT (owner_key, user_id) DO NOTHING`,
    [ownerKey, userId],
    'org-system'
  );
  return (result.rowCount || 0) > 0;
}

/**
 * Removing somebody must never remove what they contributed. Their decisions,
 * landmines, paths and events are the asset the workspace is paying for, and a
 * team that loses half its brief when an engineer leaves has been given the
 * opposite of the product.
 *
 * So this sets removed_at and nothing else. It is deliberately NOT wired to
 * dataErasureService, which deletes by owner_key across a dozen tables — correct
 * for closing an entire workspace, catastrophic if ever reused here.
 */
async function removeMember(ownerKey, userId) {
  await ensureSchema();
  const result = await db.query(
    `UPDATE workspace_members SET removed_at = NOW(), left_voluntarily = FALSE
      WHERE owner_key = $1 AND user_id = $2 AND removed_at IS NULL`,
    [ownerKey, userId],
    'org-system'
  );
  return result.rowCount > 0;
}

// EVERYTHING KEYED BY (owner_key, project_id) THAT FOLLOWS A PROJECT ROW FOR ROW
// between workspaces, or the brief ends up in one and its history in another.
// The same list POST /teams/projects/:id/move carries (routes/shared/teams.js);
// a table added to one belongs in the other. context_events is keyed by
// project_id alone and follows on its own.
//
// THE GRAPH IS NOT ON THIS LIST, and must never be put back on it. A graph node
// is unique per (owner_key, node_type, canonical_key) and keeps the FIRST
// project that saw it; every later sighting, in any project, is only an
// evidence row. Moving nodes "by project_id" therefore moves them by first
// sighting: an entity somebody met first in a personal project, and the team
// has since built its shared work on, left the team with them. See
// carryProjectGraph.
const PROJECT_FOLLOWER_TABLES = Object.freeze([
  'context_sessions',
  'context_session_loads',
]);

async function tableExists(exec, table) {
  const r = await exec('SELECT to_regclass($1) AS t', [`public.${table}`]);
  return Boolean(r.rows[0]?.t);
}

const uniqueIds = (values) => [...new Set(values.filter(Boolean))];

/**
 * The shared half of carrying or erasing a set of projects' graph: what those
 * projects saw, and which of it anything left behind in `ownerKey` still uses.
 * Read-only. Returns null when there is nothing to plan. See carryProjectGraph
 * for the rules; every query leads with owner_key.
 */
async function planProjectGraph(exec, ownerKey, projectIds) {
  const moving = uniqueIds(projectIds || []);
  if (!moving.length || !ownerKey) return null;
  if (!(await tableExists(exec, 'context_graph_nodes'))) return null;
  const fromKey = ownerKey;
  const movingSet = new Set(moving);
  const inMoving = (projectId) => Boolean(projectId) && movingSet.has(projectId);

  // 1. WHAT THE MOVING PROJECTS SAW. (owner_key, project_id) leads an index on
  //    all three tables.
  const evidence = (await exec(
    `SELECT evidence_id, project_id, node_id, edge_id FROM context_graph_evidence
      WHERE owner_key = $1 AND project_id = ANY($2::text[])`,
    [fromKey, moving]
  )).rows;
  const homeNodeIds = (await exec(
    'SELECT node_id FROM context_graph_nodes WHERE owner_key = $1 AND project_id = ANY($2::text[])',
    [fromKey, moving]
  )).rows.map((row) => row.node_id);
  const homeEdgeIds = (await exec(
    'SELECT edge_id FROM context_graph_edges WHERE owner_key = $1 AND project_id = ANY($2::text[])',
    [fromKey, moving]
  )).rows.map((row) => row.edge_id);

  const EDGE_COLUMNS = `edge_id, project_id, edge_type, from_node_id, to_node_id, summary, metadata,
                        confidence, source_session_id, source_tool, created_at, updated_at, last_seen_at`;
  const edgesById = new Map();
  const carriedEdgeIds = uniqueIds([...homeEdgeIds, ...evidence.map((row) => row.edge_id)]);
  if (carriedEdgeIds.length) {
    const rows = (await exec(
      `SELECT ${EDGE_COLUMNS} FROM context_graph_edges WHERE owner_key = $1 AND edge_id = ANY($2::text[])`,
      [fromKey, carriedEdgeIds]
    )).rows;
    rows.forEach((row) => edgesById.set(row.edge_id, row));
  }
  const carriedEdges = carriedEdgeIds.map((id) => edgesById.get(id)).filter(Boolean);

  const neededNodeIds = uniqueIds([
    ...homeNodeIds,
    ...evidence.map((row) => row.node_id),
    ...carriedEdges.flatMap((edge) => [edge.from_node_id, edge.to_node_id]),
  ]);
  const nodesById = new Map();
  if (neededNodeIds.length) {
    const rows = (await exec(
      'SELECT * FROM context_graph_nodes WHERE owner_key = $1 AND node_id = ANY($2::text[])',
      [fromKey, neededNodeIds]
    )).rows;
    rows.forEach((row) => nodesById.set(row.node_id, row));
  }
  const candidates = [...nodesById.keys()];

  // 2. WHAT IS LEFT BEHIND THAT USES THEM. Every edge touching a candidate —
  //    (owner_key, from_node_id) and (owner_key, to_node_id) are both indexed —
  //    and every sighting outside the moving projects, on a candidate node
  //    ((owner_key, node_id, project_id) is indexed) or on one of those edges.
  //    A sighting with no project is ambiguous and counts as staying: the
  //    workspace keeping an entity costs nothing, taking one it uses does.
  if (candidates.length) {
    const touching = (await exec(
      `SELECT ${EDGE_COLUMNS} FROM context_graph_edges WHERE owner_key = $1 AND from_node_id = ANY($2::text[])
       UNION
       SELECT ${EDGE_COLUMNS} FROM context_graph_edges WHERE owner_key = $1 AND to_node_id = ANY($2::text[])`,
      [fromKey, candidates]
    )).rows;
    touching.forEach((row) => { if (!edgesById.has(row.edge_id)) edgesById.set(row.edge_id, row); });
  }
  const nodeSeenElsewhere = new Map();
  if (candidates.length) {
    const rows = (await exec(
      `SELECT node_id, project_id FROM context_graph_evidence
        WHERE owner_key = $1 AND node_id = ANY($2::text[])
          AND (project_id IS NULL OR NOT (project_id = ANY($3::text[])))
        ORDER BY created_at ASC`,
      [fromKey, candidates, moving]
    )).rows;
    rows.forEach((row) => {
      if (!nodeSeenElsewhere.has(row.node_id)) nodeSeenElsewhere.set(row.node_id, null);
      if (row.project_id && !nodeSeenElsewhere.get(row.node_id)) nodeSeenElsewhere.set(row.node_id, row.project_id);
    });
  }
  const allEdgeIds = [...edgesById.keys()];
  const edgeSeenElsewhere = new Map();
  if (allEdgeIds.length) {
    const rows = (await exec(
      `SELECT edge_id, project_id FROM context_graph_evidence
        WHERE owner_key = $1 AND edge_id = ANY($2::text[])
          AND (project_id IS NULL OR NOT (project_id = ANY($3::text[])))
        ORDER BY created_at ASC`,
      [fromKey, allEdgeIds, moving]
    )).rows;
    rows.forEach((row) => {
      if (!edgeSeenElsewhere.has(row.edge_id)) edgeSeenElsewhere.set(row.edge_id, null);
      if (row.project_id && !edgeSeenElsewhere.get(row.edge_id)) edgeSeenElsewhere.set(row.edge_id, row.project_id);
    });
  }

  const edgeStays = (edge) => !inMoving(edge.project_id) || edgeSeenElsewhere.has(edge.edge_id);
  const pinnedByStayingEdge = new Map(); // node id -> a staying edge's project
  for (const edge of edgesById.values()) {
    if (!edgeStays(edge)) continue;
    for (const end of [edge.from_node_id, edge.to_node_id]) {
      if (!pinnedByStayingEdge.get(end)) pinnedByStayingEdge.set(end, inMoving(edge.project_id) ? null : edge.project_id);
    }
  }
  const nodeStays = (node) => !inMoving(node.project_id)
    || nodeSeenElsewhere.has(node.node_id)
    || pinnedByStayingEdge.has(node.node_id);
  // KEPT FOR ITS NAME, NOT FOR ITS WORDS.
  //
  // A node whose home is a moving project, that nothing left behind has ever
  // SIGHTED, and that stays only because an edge that stays ends on it. The
  // workspace needs it to exist — the edge would dangle otherwise — but no
  // project staying here ever wrote or saw its summary: that is the moving
  // project's writing. The case that matters is a project's ROOT node, keyed by
  // project NAME (contextGraphService projectNode, `project:<name>`), so a
  // personal `acme-api` and the team's shared `acme-api` are one row: re-homed
  // with its text, the personal project's description/status/task became the
  // team project's root, readable by every teammate. It stays as IDENTITY ONLY
  // (type, key, title), exactly as a copy travels, and its text goes with the
  // moving project.
  const keptOnlyByEdge = (node) => inMoving(node.project_id)
    && !nodeSeenElsewhere.has(node.node_id)
    && pinnedByStayingEdge.has(node.node_id);

  // The moving project a copy belongs to: the node's own home when that is
  // moving, otherwise the first moving project with a sighting of it.
  const movingSighting = new Map();
  evidence.forEach((row) => {
    if (row.node_id && !movingSighting.has(row.node_id)) movingSighting.set(row.node_id, row.project_id);
  });
  const edgeMovingSighting = new Map();
  evidence.forEach((row) => {
    if (row.edge_id && !edgeMovingSighting.has(row.edge_id)) edgeMovingSighting.set(row.edge_id, row.project_id);
  });
  carriedEdges.forEach((edge) => {
    if (!inMoving(edge.project_id)) return;
    [edge.from_node_id, edge.to_node_id].forEach((id) => {
      if (!movingSighting.has(id)) movingSighting.set(id, edge.project_id);
    });
  });

  return {
    moving, inMoving, evidence, carriedEdges, nodesById, edgesById, edgeStays, nodeStays, keptOnlyByEdge,
    nodeSeenElsewhere, edgeSeenElsewhere, pinnedByStayingEdge, movingSighting, edgeMovingSighting,
  };
}

/**
 * Re-home a node that stays in `ownerKey` although the project it names is
 * leaving (carry) or going (erase). A node kept only by an edge (see
 * planProjectGraph keptOnlyByEdge) is stripped to identity on the way, and its
 * vector — computed from the text it no longer carries — is dropped with it.
 * Any other keeps its words; `privateTo` marks them private to that person
 * (carryProjectGraph: a one-person source, where nobody can say whose they are).
 */
async function rehomeKeptNode(exec, ownerKey, node, home, identityOnly, embeddings, privateTo = null) {
  if (!identityOnly) {
    if (privateTo) {
      await exec(
        `UPDATE context_graph_nodes
            SET project_id = $3,
                metadata = CASE WHEN COALESCE(metadata->>'private_to', '') = ''
                                THEN metadata || jsonb_build_object('private_to', $4::text) ELSE metadata END
          WHERE owner_key = $1 AND node_id = $2`,
        [ownerKey, node.node_id, home, privateTo]
      );
      return;
    }
    await exec(
      'UPDATE context_graph_nodes SET project_id = $3 WHERE owner_key = $1 AND node_id = $2',
      [ownerKey, node.node_id, home]
    );
    return;
  }
  await exec(
    `UPDATE context_graph_nodes SET project_id = $3, summary = '', metadata = '{}'::jsonb
      WHERE owner_key = $1 AND node_id = $2`,
    [ownerKey, node.node_id, home]
  );
  if (embeddings) {
    await exec(
      `DELETE FROM context_graph_embeddings
        WHERE owner_key = $1 AND target_kind = 'node' AND target_id = $2`,
      [ownerKey, node.node_id]
    );
  }
}

// The scoped-key separator of contextSyncService (scopedEntityKey): a node
// written for project H where the plain key is somebody else's row is keyed
// `<key>::in.<H>`. PARITY: contextSyncService SCOPED_KEY_MARK.
const SCOPED_KEY_MARK = '::in.';

// A SCOPED KEY'S BASE IS BOUNDED (scan 36 b/p119). Canonical keys are slugs of
// an entity's whole text, so a decision filed as a multi-KB summary has a key
// near the unique index's 2704-byte tuple cap, and `::in.<project>` pushed its
// copy over: the first-invite split threw inside the invite's transaction, and
// every retry of the invite failed the same way (a carry, the same). A base
// over SCOPED_KEY_BASE_MAX_BYTES is cut to its first SCOPED_KEY_BASE_KEEP
// characters plus a hash of the whole: deterministic, so every later write
// for that project finds its copy again; idempotent, because a cut base is
// under the limit whatever its characters. The ONE definition — every place a
// scoped key is built (contextSyncService scopedEntityKey, the carry, the
// split) or grouped by its base (contextSyncService entityGroupKey, the
// portfolio's store query) goes through it or its SQL twin, which must agree
// byte for byte: left() and [...s] both count code points, and md5 of the
// same UTF-8 text is the same hash.
const SCOPED_KEY_BASE_MAX_BYTES = 1024;
const SCOPED_KEY_BASE_KEEP = 250; // at most 1000 bytes, + '~' + 16 hex
function boundedKeyBase(key) {
  const base = String(key || '');
  if (Buffer.byteLength(base, 'utf8') <= SCOPED_KEY_BASE_MAX_BYTES) return base;
  const hash = crypto.createHash('md5').update(base, 'utf8').digest('hex').slice(0, 16);
  return `${[...base].slice(0, SCOPED_KEY_BASE_KEEP).join('')}~${hash}`;
}
const boundedKeyBaseSql = (expr) => `(CASE WHEN octet_length(${expr}) <= ${SCOPED_KEY_BASE_MAX_BYTES} THEN ${expr}
  ELSE left(${expr}, ${SCOPED_KEY_BASE_KEEP}) || '~' || left(md5(${expr}), 16) END)`;

// A NODE'S STATE, NOT ITS WORDS (scan 36 b/p115, b/p117). What an identity-only
// copy (the first-invite split, carryProjectGraph) keeps of the node it forks
// from: whether it is resolved or archived, pinned, how durable, how used —
// state the rest of the product acts on, which the copy lost when it was written
// with '{}': a decision the founder resolved before the invite came back open
// in the copy, and the nightly job archived the copies of a pinned, retrieved
// entity. Never a summary, a note or any free text: only these keys, and only a
// number, a boolean, or a short token (an enum or a timestamp — no spaces).
const NODE_STATE_METADATA_KEYS = Object.freeze([
  'status', 'resolved', 'resolved_at', 'pinned', 'importance', 'memory_tier', 'curation_state',
  'retrieval_hits', 'last_selected_at', 'promoted_at', 'seen_count', 'source_count',
  'archived', 'archived_at', 'archived_reason', 'entity_type',
]);
const STATE_TOKEN = /^[A-Za-z0-9_:.+-]{0,40}$/;
function nodeStateMetadata(metadata) {
  const out = {};
  const source = metadata && typeof metadata === 'object' ? metadata : {};
  for (const key of NODE_STATE_METADATA_KEYS) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string' && STATE_TOKEN.test(value)) out[key] = value;
  }
  return out;
}
// The same, in SQL, over node row `n`, for the set-based split. PARITY:
// nodeStateMetadata.
const nodeStateMetadataSql = (n) => `(
  SELECT COALESCE(jsonb_object_agg(m.key, m.value), '{}'::jsonb)
    FROM jsonb_each(${n}.metadata) AS m(key, value)
   WHERE m.key IN (${NODE_STATE_METADATA_KEYS.map((key) => `'${key}'`).join(', ')})
     AND (jsonb_typeof(m.value) IN ('number', 'boolean')
          OR (jsonb_typeof(m.value) = 'string' AND (m.value #>> '{}') ~ '^[A-Za-z0-9_:.+-]{0,40}$')))`;

// Can anybody but one person have work in this workspace? The carry's form of
// contextSyncStore.workspaceMayHoldOthersWork, read through the caller's
// transaction and with no person to exclude (the moving projects are already
// the destination's rows): more than one member, a completed ownership
// backfill, or projects by more than one author. Errs towards yes.
async function destinationHoldsOthersWork(exec, ownerKey) {
  try {
    const members = (await exec(
      'SELECT COUNT(*)::int AS n FROM workspace_members WHERE owner_key = $1',
      [ownerKey]
    )).rows[0]?.n || 0;
    if (members > 1) return true;
    if (await tableExists(exec, 'workspace_ownership_backfills')) {
      const backfilled = await exec('SELECT 1 FROM workspace_ownership_backfills WHERE owner_key = $1 LIMIT 1', [ownerKey]);
      if (backfilled.rows.length) return true;
    }
    const authors = (await exec(
      `SELECT COUNT(DISTINCT owner_user_id)::int AS n FROM context_projects
        WHERE owner_key = $1 AND owner_user_id IS NOT NULL`,
      [ownerKey]
    )).rows[0]?.n || 0;
    return authors > 1;
  } catch {
    return true;
  }
}

// The one person a one-person workspace holds: its member, else the author of
// its projects, else whoever calls it home. Null when there is nobody to name.
async function soleOccupant(exec, ownerKey) {
  const member = await exec(
    `SELECT user_id FROM workspace_members WHERE owner_key = $1 AND removed_at IS NULL
      ORDER BY joined_at ASC LIMIT 1`,
    [ownerKey]
  ).catch(() => ({ rows: [] }));
  if (member.rows[0]?.user_id) return member.rows[0].user_id;
  const author = await exec(
    'SELECT owner_user_id FROM context_projects WHERE owner_key = $1 AND owner_user_id IS NOT NULL LIMIT 1',
    [ownerKey]
  ).catch(() => ({ rows: [] }));
  if (author.rows[0]?.owner_user_id) return author.rows[0].owner_user_id;
  const home = await exec('SELECT user_id FROM users WHERE org_id = $1 LIMIT 1', [ownerKey]).catch(() => ({ rows: [] }));
  return home.rows[0]?.user_id || null;
}

/**
 * Carry the knowledge graph of `projectIds` from `fromKey` into `toKey`, inside
 * the caller's transaction (`exec`). The one sanctioned way to move a project's
 * graph between workspaces — the removal carry and POST /teams/projects/:id/move
 * both come through here.
 *
 * WHAT A PROJECT'S GRAPH IS. Nodes and edges are shared per workspace: one row
 * per entity, carrying the first project that saw it, with every sighting in
 * any project recorded as an evidence row. So "the project's graph" is its
 * EVIDENCE, the nodes and edges that evidence hangs off, and the nodes and edges
 * first seen in it — and some of those the rest of the workspace is using too.
 *
 *   - A node or edge nothing left behind uses (no evidence outside the moving
 *     projects, no edge that stays touches it) MOVES, keeping its id.
 *   - One the workspace still uses STAYS, with its summary, metadata and every
 *     sighting that is not the moving projects'. The destination gets a COPY —
 *     identity only (type, key, title), none of the source workspace's summary
 *     or metadata, which is the source's writing — and the moving projects'
 *     evidence is re-pointed at the copy.
 *   - When the destination already HAS that entity (the unique key), the moving
 *     evidence joins the destination's node instead of a second one being made,
 *     which the unique constraint would refuse anyway.
 *   - An edge moves only when both its ends move; otherwise the destination gets
 *     the edge between the copied/moved ends.
 *   - A node or edge that stays but was FIRST seen in a moving project is
 *     re-homed onto a project it is still seen in, so it does not point at a
 *     project that now lives in another workspace.
 *   - EXCEPT ITS WORDS when nothing staying ever sighted it and it stays only
 *     because a staying edge ends on it (planProjectGraph keptOnlyByEdge — a
 *     root node shared by two same-named projects): the source keeps identity
 *     only, and the summary travels on the copy with the project that wrote it.
 *
 * Embeddings follow their targets: a moved node's and a moved evidence row's
 * vectors move with them; a node merged into the destination's takes its vector
 * nowhere (the destination's node has its own). A COPY gets no vector: the
 * source vector was computed from the summary the copy deliberately does not
 * carry, and a missing vector degrades semantic search for one node where a
 * stale one would answer from text the destination never had.
 *
 * EVERY QUERY LEADS WITH owner_key (see memory: the graph index blindspot).
 * context_graph_evidence has no edge_id index, so the one edge_id filter below
 * is an owner-scoped scan, bounded by the source workspace.
 *
 * Returns counts; throws on failure so the caller's savepoint/transaction can
 * undo a half-carried graph.
 */
async function carryProjectGraph(exec, fromKey, toKey, projectIds) {
  const report = {
    nodes_moved: 0, nodes_copied: 0, nodes_merged: 0, nodes_kept: 0,
    edges_moved: 0, edges_copied: 0, evidence_moved: 0,
  };
  if (!fromKey || !toKey || fromKey === toKey) return report;
  const plan = await planProjectGraph(exec, fromKey, projectIds);
  if (!plan) return report;
  const {
    moving, inMoving, evidence, carriedEdges, nodesById, edgeStays, nodeStays, keptOnlyByEdge,
    nodeSeenElsewhere, edgeSeenElsewhere, pinnedByStayingEdge, movingSighting, edgeMovingSighting,
  } = plan;

  // 3. NODES. The destination's existing entities first, through the unique
  //    (owner_key, node_type, canonical_key) index.
  //
  //    ONE LANDING RULE FOR EVERY GRAPH WRITE, THE CARRY INCLUDED (scan 34
  //    b/p107). A node's target home is the moving project it belongs to
  //    (`homeFor`). The destination's row of the same key is joined only when
  //    it is that project's, or workspace-level and marked private to nobody —
  //    the rows whose readers a moved project's evidence cannot widen
  //    (contextSyncService landGraphWrite). Anything else — a teammate's
  //    PERSONAL node, the owner's private one, a founder's pre-team note — is
  //    somebody else's row: joined, the moved project's evidence made it
  //    readable to the mover, whose recall then served the owner's personal
  //    note and project name. The moved project gets its own `<key>::in.<H>`
  //    node there instead, the key every later write for H finds first. A
  //    viewer never gets here (refuseReadOnlyMove), so a workspace-level row
  //    is one the mover may change.
  //
  //    THE SAME RULE IN A ONE-PERSON DESTINATION (scan 35 a/F1, b/p113). It
  //    used to join any row of the same name there, on the grounds that one
  //    reader cannot publish anything to themselves. But a one-person
  //    workspace is one invite away from being a team, and a join into another
  //    project's row is exactly the cross-project landing the first invite then
  //    has to split (backfillProjectOwnership). What does differ there is the
  //    KEY: nobody else's rows can be in the way, the rebuild's landing writes
  //    plain keys (graphRebuildLanding is null), and a carried `<key>::in.<H>`
  //    was never found again — every later write made a plain twin beside it,
  //    and a resolve flipped the twin (scan 35 a/p1, b/p109b). So there the
  //    carried node takes its PLAIN key, joining the plain row when the rule
  //    above allows it, and keeps its scoped key only when a plain row the rule
  //    refuses (another project's) is already there.
  const nodeMap = new Map();
  const movedNodeIds = [];
  const renamedNodes = [];
  const mergedAwayNodeIds = [];
  const keptNodes = [];
  const needed = [...nodesById.values()];
  const identity = (type, key) => `${type}\u0000${key}`;
  const homeFor = (node) => (inMoving(node.project_id) ? node.project_id : (movingSighting.get(node.node_id) || null));
  const plainKeyFor = (node) => String(node.canonical_key).split(SCOPED_KEY_MARK)[0];
  const scopedKeyFor = (node) => `${boundedKeyBase(plainKeyFor(node))}${SCOPED_KEY_MARK}${homeFor(node) || 'workspace'}`;
  const existing = new Map();
  if (needed.length) {
    const types = [...needed, ...needed, ...needed].map((node) => node.node_type);
    const keys = [...needed.map((node) => node.canonical_key), ...needed.map(scopedKeyFor), ...needed.map(plainKeyFor)];
    const rows = (await exec(
      `SELECT node_id, node_type, canonical_key, project_id, metadata->>'private_to' AS private_to
         FROM context_graph_nodes
        WHERE owner_key = $1
          AND (node_type, canonical_key) IN (SELECT * FROM unnest($2::text[], $3::text[]))`,
      [toKey, types, keys]
    )).rows;
    rows.forEach((row) => existing.set(identity(row.node_type, row.canonical_key), row));
  }
  const othersMayWork = needed.length ? await destinationHoldsOthersWork(exec, toKey) : false;
  const joinable = (row, node) => !row.private_to && (row.project_id ? row.project_id === homeFor(node) : true);
  // A node the source keeps: WHOSE WORDS ARE THEY? (scan 36 a/F1, b/p116)
  //
  // Round 35 said: in a one-person source, a node homed in the moving project
  // carries that project's words, so they went with it (on the copy) and the
  // node left behind was stripped to identity. But in a one-person workspace
  // any project's save used to rewrite a short summary and merge its metadata
  // into whatever node held the key (store.upsertGraphNode, before scan 36), so
  // the words on a node homed in A were as often B's: B's hand-written note
  // went into the team with A — readable by its owner at once, by everyone once
  // shared — and was erased at home, with B's status and tier; and B's plain
  // rebuild-derived entities were blanked for B.
  //
  // Nobody can say whose they are, so they neither travel nor go: a node
  // anything left behind has ANY evidence on — a sighting included — gives the
  // destination an identity-only copy (with its state: nodeStateMetadata), and
  // stays whole. Words travel only with a node kept for an edge's sake alone,
  // which nothing staying ever saw (keptOnlyByEdge).
  //
  // In a ONE-PERSON source the node left behind is also marked PRIVATE to that
  // person (metadata.private_to, as the first invite marks their pre-team
  // notes). Re-homed onto the project that still uses it with the moving
  // project's words, it would otherwise carry them the next time THAT project
  // moves, or is shared after an invite (scan 35 b/p113). Marked, it is read by
  // its author alone wherever it goes, and a marked node is never carried at
  // all: it stays, and the moving project takes an identity-only copy.
  const sourceOthersMayWork = needed.some((node) => nodeStays(node) && inMoving(node.project_id))
    ? await destinationHoldsOthersWork(exec, fromKey)
    : true;
  const keptPrivateTo = sourceOthersMayWork ? null : await soleOccupant(exec, fromKey);
  const wordsTravel = (node) => keptOnlyByEdge(node);
  const privateNote = (node) => Boolean(node.metadata?.private_to) && node.node_type !== 'project';
  for (const node of needed) {
    const stays = nodeStays(node) || privateNote(node);
    if (stays) keptNodes.push(node);
    let key = node.canonical_key;
    if (!othersMayWork) {
      const plain = existing.get(identity(node.node_type, plainKeyFor(node))) || null;
      if (!plain || joinable(plain, node)) key = plainKeyFor(node);
    }
    let already = existing.get(identity(node.node_type, key)) || null;
    if (already && !joinable(already, node)) {
      key = scopedKeyFor(node);
      already = existing.get(identity(node.node_type, key)) || null;
    }
    if (already) {
      nodeMap.set(node.node_id, already.node_id);
      if (!stays) mergedAwayNodeIds.push(node.node_id);
      report.nodes_merged += 1;
    } else if (!stays) {
      nodeMap.set(node.node_id, node.node_id);
      movedNodeIds.push(node.node_id);
      if (key !== node.canonical_key) renamedNodes.push({ node_id: node.node_id, key });
      // A second node of this batch that lands on the same key joins this one.
      existing.set(identity(node.node_type, key), { node_id: node.node_id, project_id: homeFor(node), private_to: null });
    } else {
      const home = homeFor(node);
      // A node the source keeps only for an edge's sake is the MOVING project's
      // writing (wordsTravel): its summary goes with the project, and the node
      // left behind is stripped to identity in step 7. Anything else the source
      // keeps is not provably the moving project's (above), and the copy is
      // identity only. Either way the copy keeps the node's STATE — resolved,
      // pinned, tier, usage — and none of its free-text metadata.
      const summary = wordsTravel(node) ? (node.summary || '') : '';
      // ON CONFLICT returns the row a concurrent writer made in the meantime,
      // so the evidence joins it rather than the carry failing on a race.
      const copy = await exec(
        `INSERT INTO context_graph_nodes
           (node_id, owner_key, project_id, node_type, canonical_key, title, summary, metadata,
            confidence, source_session_id, source_tool, created_at, updated_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $12, $13::jsonb, $7, '', $8, $9, $10, $11)
         ON CONFLICT (owner_key, node_type, canonical_key)
         DO UPDATE SET last_seen_at = context_graph_nodes.last_seen_at
         RETURNING node_id`,
        [`graph_node_${crypto.randomUUID()}`, toKey, home, node.node_type, key, node.title,
          node.confidence, node.source_tool, node.created_at, node.updated_at, node.last_seen_at, summary,
          JSON.stringify(nodeStateMetadata(node.metadata))]
      );
      nodeMap.set(node.node_id, copy.rows[0].node_id);
      existing.set(identity(node.node_type, key), { node_id: copy.rows[0].node_id, project_id: home, private_to: null });
      report.nodes_copied += 1;
    }
  }
  if (movedNodeIds.length) {
    // A moved node the destination's plain key belongs to somebody else takes
    // its project's scoped key on the way (step 3), words and all: nothing left
    // behind ever saw it, so it was only ever this project's. In a one-person
    // destination a scoped node takes its plain key back.
    for (const { node_id: nodeId, key } of renamedNodes) {
      await exec(
        'UPDATE context_graph_nodes SET owner_key = $2, canonical_key = $4 WHERE owner_key = $1 AND node_id = $3',
        [fromKey, toKey, nodeId, key]
      );
    }
    await exec(
      'UPDATE context_graph_nodes SET owner_key = $2 WHERE owner_key = $1 AND node_id = ANY($3::text[])',
      [fromKey, toKey, movedNodeIds]
    );
    report.nodes_moved = movedNodeIds.length;
  }

  // 4. EDGES the moving projects carry. Moved as they are only when both ends
  //    moved as they are; otherwise the destination gets the edge between the
  //    mapped ends, and an edge nothing else uses is then dropped at the source.
  const edgeMap = new Map();
  const movedEdgeIds = [];
  const mergedAwayEdgeIds = [];
  const keptEdges = [];
  for (const edge of carriedEdges) {
    const from = nodeMap.get(edge.from_node_id);
    const to = nodeMap.get(edge.to_node_id);
    if (!from || !to) continue; // an end that is not in this workspace at all
    const stays = edgeStays(edge);
    if (stays) keptEdges.push(edge);
    if (!stays && from === edge.from_node_id && to === edge.to_node_id) {
      movedEdgeIds.push(edge.edge_id);
      edgeMap.set(edge.edge_id, edge.edge_id);
      continue;
    }
    const home = inMoving(edge.project_id) ? edge.project_id : (edgeMovingSighting.get(edge.edge_id) || null);
    const copy = await exec(
      `INSERT INTO context_graph_edges
         (edge_id, owner_key, project_id, edge_type, from_node_id, to_node_id, summary, metadata,
          confidence, source_session_id, source_tool, created_at, updated_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, '', $10, $11, $12, $13)
       ON CONFLICT (owner_key, edge_type, from_node_id, to_node_id)
       DO UPDATE SET last_seen_at = context_graph_edges.last_seen_at
       RETURNING edge_id`,
      [`graph_edge_${crypto.randomUUID()}`, toKey, home, edge.edge_type, from, to,
        // An edge only the moving projects used is theirs, words and all. One
        // the source keeps is the source's writing, and travels as identity.
        stays ? '' : (edge.summary || ''),
        stays ? '{}' : JSON.stringify(edge.metadata || {}),
        edge.confidence, edge.source_tool, edge.created_at, edge.updated_at, edge.last_seen_at]
    );
    edgeMap.set(edge.edge_id, copy.rows[0].edge_id);
    if (!stays) mergedAwayEdgeIds.push(edge.edge_id);
    report.edges_copied += 1;
  }
  if (movedEdgeIds.length) {
    await exec(
      'UPDATE context_graph_edges SET owner_key = $2 WHERE owner_key = $1 AND edge_id = ANY($3::text[])',
      [fromKey, toKey, movedEdgeIds]
    );
    report.edges_moved = movedEdgeIds.length;
  }

  // 5. EVIDENCE: all of the moving projects', re-pointed at the destination's
  //    node and edge ids.
  if (evidence.length) {
    await exec(
      'UPDATE context_graph_evidence SET owner_key = $2 WHERE owner_key = $1 AND project_id = ANY($3::text[])',
      [fromKey, toKey, moving]
    );
    report.evidence_moved = evidence.length;
    const remap = async (column, map) => {
      const pairs = [...map.entries()].filter(([from, to]) => from !== to);
      if (!pairs.length) return;
      await exec(
        `UPDATE context_graph_evidence ev SET ${column} = m.to_id
           FROM unnest($3::text[], $4::text[]) AS m(from_id, to_id)
          WHERE ev.owner_key = $1 AND ev.project_id = ANY($2::text[]) AND ev.${column} = m.from_id`,
        [toKey, moving, pairs.map(([from]) => from), pairs.map(([, to]) => to)]
      );
    };
    await remap('node_id', nodeMap);
    await remap('edge_id', edgeMap);
  }

  // 6. WHAT NOTHING AT THE SOURCE USES ANY MORE, now that everything pointing
  //    at it has been re-pointed. Edges before nodes; embeddings before their
  //    nodes (they hang off the id with no foreign key).
  if (mergedAwayEdgeIds.length) {
    await exec(
      'DELETE FROM context_graph_edges WHERE owner_key = $1 AND edge_id = ANY($2::text[])',
      [fromKey, mergedAwayEdgeIds]
    );
  }
  const embeddings = await tableExists(exec, 'context_graph_embeddings');
  if (mergedAwayNodeIds.length) {
    if (embeddings) {
      await exec(
        `DELETE FROM context_graph_embeddings
          WHERE owner_key = $1 AND target_kind = 'node' AND target_id = ANY($2::text[])`,
        [fromKey, mergedAwayNodeIds]
      );
    }
    await exec(
      'DELETE FROM context_graph_nodes WHERE owner_key = $1 AND node_id = ANY($2::text[])',
      [fromKey, mergedAwayNodeIds]
    );
  }
  if (embeddings && movedNodeIds.length) {
    await exec(
      `UPDATE context_graph_embeddings SET owner_key = $2
        WHERE owner_key = $1 AND target_kind = 'node' AND target_id = ANY($3::text[])`,
      [fromKey, toKey, movedNodeIds]
    );
  }
  if (embeddings && evidence.length) {
    await exec(
      `UPDATE context_graph_embeddings SET owner_key = $2
        WHERE owner_key = $1 AND target_kind = 'evidence' AND target_id = ANY($3::text[])`,
      [fromKey, toKey, evidence.map((row) => row.evidence_id)]
    );
  }

  // 7. WHAT STAYS, RE-HOMED. A node or edge first seen in a moving project
  //    still names that project, which now lives in another workspace; point
  //    it at a project it is still seen in here (or none).
  for (const node of keptNodes) {
    report.nodes_kept += 1;
    if (!inMoving(node.project_id)) continue;
    const home = nodeSeenElsewhere.get(node.node_id) || pinnedByStayingEdge.get(node.node_id) || null;
    await rehomeKeptNode(exec, fromKey, node, home, wordsTravel(node), embeddings,
      wordsTravel(node) || node.node_type === 'project' ? null : keptPrivateTo);
  }
  for (const edge of keptEdges) {
    if (!inMoving(edge.project_id)) continue;
    await exec(
      'UPDATE context_graph_edges SET project_id = $3 WHERE owner_key = $1 AND edge_id = $2',
      [fromKey, edge.edge_id, edgeSeenElsewhere.get(edge.edge_id) || null]
    );
  }

  return report;
}

/**
 * Erase `projectIds`' graph from `ownerKey` — for account erasure deleting a
 * person's personal projects inside somebody else's workspace — WITHOUT taking
 * what the rest of that workspace uses.
 *
 * The same rules as carryProjectGraph, with deletion where it moves: the
 * projects' own evidence goes (with its vectors); a node or edge only they used
 * goes (with its vectors); one the workspace still uses stays, re-homed onto a
 * project it is still seen in. Deleting nodes "WHERE project_id = ANY(...)"
 * instead deleted every entity those projects happened to see FIRST, and the
 * foreign-key cascade took the team's own evidence and edges on them too.
 */
async function eraseProjectGraph(exec, ownerKey, projectIds) {
  const report = { nodes_deleted: 0, nodes_kept: 0, edges_deleted: 0, evidence_deleted: 0 };
  const plan = await planProjectGraph(exec, ownerKey, projectIds);
  if (!plan) return report;
  const {
    moving, inMoving, evidence, carriedEdges, nodesById, edgeStays, nodeStays, keptOnlyByEdge,
    nodeSeenElsewhere, edgeSeenElsewhere, pinnedByStayingEdge,
  } = plan;
  const embeddings = await tableExists(exec, 'context_graph_embeddings');

  if (evidence.length) {
    if (embeddings) {
      await exec(
        `DELETE FROM context_graph_embeddings
          WHERE owner_key = $1 AND target_kind = 'evidence' AND target_id = ANY($2::text[])`,
        [ownerKey, evidence.map((row) => row.evidence_id)]
      );
    }
    const gone = await exec(
      'DELETE FROM context_graph_evidence WHERE owner_key = $1 AND project_id = ANY($2::text[])',
      [ownerKey, moving]
    );
    report.evidence_deleted = gone.rowCount || 0;
  }
  const doomedEdges = carriedEdges.filter((edge) => !edgeStays(edge)).map((edge) => edge.edge_id);
  if (doomedEdges.length) {
    const gone = await exec(
      'DELETE FROM context_graph_edges WHERE owner_key = $1 AND edge_id = ANY($2::text[])',
      [ownerKey, doomedEdges]
    );
    report.edges_deleted = gone.rowCount || 0;
  }
  const nodes = [...nodesById.values()];
  const doomedNodes = nodes.filter((node) => !nodeStays(node)).map((node) => node.node_id);
  if (doomedNodes.length) {
    if (embeddings) {
      await exec(
        `DELETE FROM context_graph_embeddings
          WHERE owner_key = $1 AND target_kind = 'node' AND target_id = ANY($2::text[])`,
        [ownerKey, doomedNodes]
      );
    }
    const gone = await exec(
      'DELETE FROM context_graph_nodes WHERE owner_key = $1 AND node_id = ANY($2::text[])',
      [ownerKey, doomedNodes]
    );
    report.nodes_deleted = gone.rowCount || 0;
  }
  for (const node of nodes) {
    if (!nodeStays(node)) continue;
    report.nodes_kept += 1;
    if (!inMoving(node.project_id)) continue;
    const home = nodeSeenElsewhere.get(node.node_id) || pinnedByStayingEdge.get(node.node_id) || null;
    await rehomeKeptNode(exec, ownerKey, node, home, keptOnlyByEdge(node), embeddings);
  }
  for (const edge of carriedEdges) {
    if (!edgeStays(edge) || !inMoving(edge.project_id)) continue;
    await exec(
      'UPDATE context_graph_edges SET project_id = $3 WHERE owner_key = $1 AND edge_id = $2',
      [ownerKey, edge.edge_id, edgeSeenElsewhere.get(edge.edge_id) || null]
    );
  }
  return report;
}

/**
 * Carry the skills scoped to `projectIds` into `toKey`, inside the caller's
 * transaction.
 *
 * A project-scoped skill applies to that project and nothing else, so it goes
 * where the project goes. The alternatives are both worse: left behind, it
 * scopes a workspace's instructions to a project that workspace no longer has —
 * and workspace_skills.project_id is ON DELETE CASCADE, so the project's new
 * owner deleting it would delete a row in somebody else's workspace; nulled, it
 * silently WIDENS from one project to every session in the workspace, which is
 * a change of meaning nobody asked for. The slug is unique per workspace, so a
 * clash at the destination is resolved with a suffix rather than refused.
 */
async function carryProjectSkills(exec, fromKey, toKey, projectIds) {
  const moving = uniqueIds(projectIds || []);
  if (!moving.length || fromKey === toKey || !(await tableExists(exec, 'workspace_skills'))) return 0;
  const skills = (await exec(
    'SELECT skill_id, slug FROM workspace_skills WHERE owner_key = $1 AND project_id = ANY($2::text[])',
    [fromKey, moving]
  )).rows;
  for (const skill of skills) {
    let slug = skill.slug;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const clash = await exec('SELECT 1 FROM workspace_skills WHERE owner_key = $1 AND slug = $2', [toKey, slug]);
      if (!clash.rows.length) break;
      slug = `${skill.slug}-${crypto.randomUUID().slice(0, 6)}`;
    }
    await exec(
      'UPDATE workspace_skills SET owner_key = $2, slug = $3 WHERE owner_key = $1 AND skill_id = $4',
      [fromKey, toKey, slug, skill.skill_id]
    );
  }
  return skills.length;
}

/**
 * Move a removed person's PERSONAL projects out of `fromKey` into a workspace
 * of their own, `toKey`, inside the caller's transaction (`client`).
 *
 * Matched on every identity the person may be stamped under — their user id,
 * and the ids of their API keys for rows written before attribution named
 * people — and on visibility = 'personal' only. owner_user_id is normalised to
 * the person: the key ids are being revoked with this removal, and a personal
 * project stamped with one would be readable by nobody.
 *
 * The context is re-sealed under the destination's data key before the row
 * moves (per-workspace DEKs: ciphertext from the team cannot be opened under
 * the new workspace's key). A project that cannot be re-sealed is LEFT where it
 * is and reported, rather than moved into a workspace whose key cannot open it
 * — and it does not fail the removal, which is a security action that one
 * damaged row must not be able to block.
 *
 * What travels with it: sessions and loads, the project's graph (through
 * carryProjectGraph, which leaves the team every entity it still uses), its
 * project-scoped skills, and its AUDIT ROWS. The last is deliberately unlike
 * POST /teams/projects/:id/move, which leaves the audit trail where it was
 * written: that is somebody choosing to move a project the workspace could see.
 * A personal project's audit rows were only ever shown to its author, and its
 * author has just been removed from this workspace — left here they would be
 * readable by nobody, and unreachable by the author's own erasure. The team
 * keeps its record of the removal itself (member_removed), which names the
 * count carried.
 */
async function carryPersonalProjects(client, fromKey, toKey, userId) {
  const exec = (text, params) => client.query(text, params);
  const result = { projectsMoved: [], projectsLeft: [], graph: null };
  if (!(await tableExists(exec, 'context_projects'))) return result;

  const identities = [userId];
  if (await tableExists(exec, 'api_keys')) {
    const keys = await exec('SELECT key_id FROM api_keys WHERE owner_id = $1', [userId]);
    identities.push(...keys.rows.map((row) => row.key_id).filter(Boolean));
  }

  const found = await exec(
    `SELECT project_id, context FROM context_projects
      WHERE owner_key = $1 AND visibility = 'personal' AND owner_user_id = ANY($2::text[])
      FOR UPDATE`,
    [fromKey, identities]
  );
  if (!found.rows.length) return result;

  for (const project of found.rows) {
    let resealed = null;
    if (project.context && project.context._enc) {
      try {
        const plaintext = await encryption.decryptContextObject(fromKey, project.context);
        resealed = await encryption.encryptContextObject(toKey, plaintext);
      } catch (err) {
        console.error(`[WORKSPACE] carry: could not re-seal ${project.project_id}, left in place: ${err.message}`);
        result.projectsLeft.push(project.project_id);
        continue;
      }
    }
    // updated_at is deliberately untouched: being carried out of a team is not
    // activity, and stamping it would make the project look freshly edited to
    // the auto-archive sweep and the digest.
    await exec(
      `UPDATE context_projects
          SET owner_key = $2, owner_user_id = $3, context = COALESCE($4::jsonb, context)
        WHERE project_id = $1 AND owner_key = $5`,
      [project.project_id, toKey, userId, resealed ? JSON.stringify(resealed) : null, fromKey]
    );
    result.projectsMoved.push(project.project_id);
  }
  if (!result.projectsMoved.length) return result;

  for (const table of PROJECT_FOLLOWER_TABLES) {
    if (!(await tableExists(exec, table))) continue;
    await exec(
      `UPDATE ${table} SET owner_key = $2 WHERE owner_key = $1 AND project_id = ANY($3::text[])`,
      [fromKey, toKey, result.projectsMoved]
    );
  }
  result.graph = await carryProjectGraph(exec, fromKey, toKey, result.projectsMoved);
  await carryProjectSkills(exec, fromKey, toKey, result.projectsMoved);
  if (await tableExists(exec, 'context_audit_logs')) {
    await exec(
      'UPDATE context_audit_logs SET owner_key = $2 WHERE owner_key = $1 AND project_id = ANY($3::text[])',
      [fromKey, toKey, result.projectsMoved]
    );
  }
  // Public share links are revoked, as the move route revokes them: a link
  // minted while the project lived in the team is not carried into a new
  // workspace behind anybody's back.
  if (await tableExists(exec, 'context_share_tokens')) {
    await exec(
      'DELETE FROM context_share_tokens WHERE owner_key = $1 AND project_id = ANY($2::text[])',
      [fromKey, result.projectsMoved]
    );
  }
  return result;
}

// ── THE "YOU" PROFILE TRAVELS WITH ITS PERSON ───────────────────────────────
//
// Journey scan round 3, D-2. context_globals is keyed by (workspace, person):
// somebody working in a team writes their profile (who they are, their
// recurring instructions, how they like to work) into THAT workspace's row for
// them, and nobody else can read it, not even an owner. Leaving or being
// removed carried their personal projects home and left the profile behind:
// afterwards their own profile read empty, the team answered 403, their export
// did not hold it and their next brief had lost their instructions. A row only
// its author could read, left where its author is barred, is read by nobody.
// The owner's decision: it moves home with them, like the personal projects,
// and when they already have a profile at home the two are MERGED so that
// nothing is overwritten.
//
// THE MERGE RULE, field by field over GlobalContextSchema
// (packages/shared-context: three text fields, six lists, a timestamp):
//   - A field only one side has (the other '', [] or absent) is kept.
//       home user_profile ''  +  team 'Backend lead'  ->  'Backend lead'
//   - A field both have with the same value is kept once (text compared with
//     the surrounding whitespace trimmed).
//       home working_style 'Terse'  +  team 'Terse'  ->  'Terse'
//   - A LIST both have (preferences, recurring_instructions, global_stack,
//     expertise_areas, goals, values) becomes the union: the home entries
//     first, in their order, then the team's that are not already there
//     (compared trimmed).
//       home ['Use pnpm', 'Write tests']  +  team ['Write tests', 'No emojis']
//         ->  ['Use pnpm', 'Write tests', 'No emojis']
//   - A TEXT field both have with DIFFERENT values (user_profile,
//     working_style, communication_preferences) keeps the home text and
//     appends the team text after a blank line, so that no word of either is
//     lost. A team text that is already one whole paragraph of the home text is
//     not appended again: bringing the same profile home twice must not double
//     it.
//       home 'Founder of Acme.'  +  team 'Backend lead on payments.'
//         ->  'Founder of Acme.\n\nBackend lead on payments.'
//   - updated_at is a timestamp, not text: the later of the two.
//   - Anything outside the schema (no writer produces it today) follows the
//     same rules by shape (text, list, nested object field by field); two
//     different values of any other kind keep the home one.
const PROFILE_TEXT_SEPARATOR = '\n\n';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function profileValuePresent(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}

// Something the person actually wrote: any field but the timestamp.
function profileHasContent(profile) {
  return isPlainObject(profile)
    && Object.entries(profile).some(([key, value]) => key !== 'updated_at' && profileValuePresent(value));
}

function mergeProfileText(home, team) {
  const h = home.trim();
  const t = team.trim();
  if (h === t || h.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).includes(t)) return home;
  return `${home.replace(/\s+$/, '')}${PROFILE_TEXT_SEPARATOR}${team.replace(/^\s+/, '')}`;
}

function mergeProfileList(home, team) {
  const out = [];
  const seen = new Set();
  for (const item of [...home, ...team]) {
    const key = typeof item === 'string' ? item.trim() : JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function laterTimestamp(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(tb)) return a;
  if (!Number.isFinite(ta)) return b;
  return tb > ta ? b : a;
}

function mergePersonalProfiles(home, team) {
  const h = isPlainObject(home) ? home : {};
  const t = isPlainObject(team) ? team : {};
  const out = {};
  for (const key of new Set([...Object.keys(h), ...Object.keys(t)])) {
    const hv = h[key];
    const tv = t[key];
    if (!profileValuePresent(tv)) { out[key] = hv !== undefined ? hv : tv; continue; }
    if (!profileValuePresent(hv)) { out[key] = tv; continue; }
    if (key === 'updated_at') out[key] = laterTimestamp(hv, tv);
    else if (typeof hv === 'string' && typeof tv === 'string') out[key] = mergeProfileText(hv, tv);
    else if (Array.isArray(hv) && Array.isArray(tv)) out[key] = mergeProfileList(hv, tv);
    else if (isPlainObject(hv) && isPlainObject(tv)) out[key] = mergePersonalProfiles(hv, tv);
    else out[key] = hv;
  }
  return out;
}

// A stored profile opened for reading. The profile is written in plaintext
// today (encryptionService: only context_projects.context is sealed under the
// owner's data key), but a row sealed under `ownerKey`'s key ({ _enc }) is
// opened with that key rather than moved as ciphertext nobody at the
// destination could open.
const profileIsSealed = (stored) => Boolean(stored && stored._enc);
const openProfile = (ownerKey, stored) => encryption.decryptContextObject(ownerKey, stored);

/**
 * Move a removed person's own profile row out of `fromKey` into `toKey`,
 * merging it into the one already there (rule above), inside the caller's
 * transaction. Only (fromKey, userId): nobody else's profile is read or
 * written, and nothing the workspace owns moves.
 *
 * Stored in the form the destination row is read in: a home row keeps its own
 * form; with no home row, the source's, and a sealed source is re-sealed under
 * the DESTINATION's key. A row that cannot be opened is left where it is and
 * reported (reason 'unreadable'), the way carryPersonalProjects leaves a
 * project it cannot re-seal. A row with nothing written in it is left alone.
 *
 * Returns { moved, merged, reason }.
 */
async function carryPersonalProfile(client, fromKey, toKey, userId) {
  const exec = (text, params) => client.query(text, params);
  const result = { moved: false, merged: false, reason: null };
  if (!fromKey || !toKey || fromKey === toKey || !userId) return result;
  if (!(await tableExists(exec, 'context_globals'))) return result;

  const source = (await exec(
    'SELECT global, updated_at, profile_reviewed_at FROM context_globals WHERE owner_key = $1 AND person_id = $2 FOR UPDATE',
    [fromKey, userId]
  )).rows[0];
  if (!source) return result;
  const home = (await exec(
    'SELECT global, updated_at, profile_reviewed_at FROM context_globals WHERE owner_key = $1 AND person_id = $2 FOR UPDATE',
    [toKey, userId]
  )).rows[0] || null;

  let teamProfile;
  let homeProfile = null;
  try {
    teamProfile = await openProfile(fromKey, source.global);
    if (home) homeProfile = await openProfile(toKey, home.global);
  } catch (err) {
    console.error(`[WORKSPACE] carry: the profile of ${userId} could not be opened, left in place: ${err.message}`);
    return { ...result, reason: 'unreadable' };
  }
  if (!profileHasContent(teamProfile)) return result;

  const merged = home ? mergePersonalProfiles(homeProfile, teamProfile) : teamProfile;
  const sealed = home ? profileIsSealed(home.global) : profileIsSealed(source.global);
  const stored = sealed ? await encryption.encryptContextObject(toKey, merged) : merged;
  // The review marker travels with the data: a profile moved or merged is
  // reviewed only if every part of it was. Anything not yet checked keeps the
  // whole unchecked.
  const reviewedAt = home
    ? (source.profile_reviewed_at && home.profile_reviewed_at
      ? (source.profile_reviewed_at > home.profile_reviewed_at ? source.profile_reviewed_at : home.profile_reviewed_at)
      : null)
    : (source.profile_reviewed_at || null);
  await exec(
    `INSERT INTO context_globals (owner_key, person_id, global, updated_at, profile_reviewed_at)
     VALUES ($1, $2, $3::jsonb, COALESCE(GREATEST($4::timestamptz, $5::timestamptz), NOW()), $6::timestamptz)
     ON CONFLICT (owner_key, person_id) DO UPDATE SET
       global = EXCLUDED.global,
       updated_at = EXCLUDED.updated_at,
       profile_reviewed_at = EXCLUDED.profile_reviewed_at`,
    [toKey, userId, JSON.stringify(stored), source.updated_at || null, home?.updated_at || null, reviewedAt]
  );
  await exec('DELETE FROM context_globals WHERE owner_key = $1 AND person_id = $2', [fromKey, userId]);
  return { moved: true, merged: Boolean(home), reason: null };
}

// carryPersonalProfile under its own savepoint, with the same contract as the
// project carry beside it: a failure leaves the profile where it was and is
// reported ('carry_failed'); it never undoes the removal or the re-home.
async function carryProfileUnderSavepoint(client, fromKey, toKey, userId, name) {
  await client.query(`SAVEPOINT ${name}`);
  try {
    const profile = await carryPersonalProfile(client, fromKey, toKey, userId);
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return profile;
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    console.error(`[WORKSPACE] the profile of ${userId} was not carried: ${err.message}`);
    return { moved: false, merged: false, reason: 'carry_failed' };
  }
}

/**
 * THE LINKS A REMOVED PERSON MINTED STOP WORKING WHEN THEY GO.
 *
 * A share link is a publication by its author, and removal ends that person's
 * standing in this workspace. The links on projects they CARRY out are already
 * deleted by carryPersonalProjects; the rest — links on shared or private
 * projects that stay with the team — used to keep serving the live project to
 * whoever held the URL, including the removed person, and including everything
 * the team decided after they left. Nobody on the team minted those links, and
 * their existence was visible only in a list the team would have no reason to
 * audit.
 *
 * Revoked (revoked_at), not deleted: the page then says "the owner turned this
 * off" rather than looking broken, and an owner who wants the page back mints
 * a new link with the scan in front of them. Matched on the PERSON — created_by
 * holds a user id, or a key id for links minted over an API key before
 * created_by recorded the person — in the removal's own transaction. Returns
 * [{ project_id, token_prefix }]; never the token, which is the read credential.
 */
async function revokeRemovedMembersShareLinks(client, ownerKey, userId) {
  const exec = (text, params) => client.query(text, params);
  if (!(await tableExists(exec, 'context_share_tokens'))) return [];
  const identities = [userId];
  if (await tableExists(exec, 'api_keys')) {
    const keys = await exec('SELECT key_id FROM api_keys WHERE owner_id = $1', [userId]);
    identities.push(...keys.rows.map((row) => row.key_id).filter(Boolean));
  }
  const revoked = await exec(
    `UPDATE context_share_tokens SET revoked_at = NOW()
      WHERE owner_key = $1 AND revoked_at IS NULL AND created_by = ANY($2::text[])
      RETURNING project_id, token`,
    [ownerKey, identities]
  );
  return revoked.rows.map((row) => ({
    project_id: row.project_id,
    token_prefix: String(row.token || '').slice(0, 6),
  }));
}

// A FRESH PERSONAL WORKSPACE FOR SOMEBODY WHOSE users.org_id IS `fromKey`.
//
// Inside the caller's transaction (`client`). Moves users.org_id only while it
// still names `fromKey`, so a concurrent change is never overwritten. Shared by
// removal (removeMemberAndRehome) and account closure (rehomeResidentsBeforeClose).
async function provisionPersonalWorkspace(client, userId, fromKey, email) {
  const personalWorkspace = `org-${crypto.randomUUID()}`;
  const local = String(email || '').split('@')[0] || 'My';
  await client.query(
    `INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, account_type)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [personalWorkspace, `${local}'s Workspace`, 'free', 'free', 'active', 'organization']
  );
  await client.query(
    'UPDATE users SET org_id = $2, role = \'owner\' WHERE user_id = $1 AND org_id = $3',
    [userId, personalWorkspace, fromKey]
  );
  await client.query(
    `INSERT INTO workspace_members (owner_key, user_id, role, joined_at)
     VALUES ($1, $2, 'owner', NOW())
     ON CONFLICT (owner_key, user_id) DO NOTHING`,
    [personalWorkspace, userId]
  );
  return personalWorkspace;
}

// A TEAM WORKSPACE IS CREATED WHEN ITS TEAM SUBSCRIPTION IS CONFIRMED (journey r6).
//
// The wizard used to create an empty Free workspace at its first step, before
// anything was paid, and an abandoned checkout left it behind: an empty team
// nobody could invite into (a Free workspace has no team feature). Now the
// checkout carries the name and the founder (Stripe session metadata) and the
// Stripe webhook calls this, inside its own transaction, when Stripe confirms the
// subscription. Idempotent: a redelivered event finds the workspace there and
// changes nothing. The founder is the owner; their own workspace is untouched.
//
// A WORKSPACE BORN AS A TEAM HAS NO SOLO HISTORY TO PROTECT: recording the
// ownership backfill as done at birth is what keeps the first invitation from
// turning whatever the founder moves in into their personal work.
async function createTeamWorkspaceAtCheckout(client, { orgId, name, founderUserId, via = 'stripe_checkout' }) {
  if (!orgId || !name || !founderUserId) throw new Error('createTeamWorkspaceAtCheckout requires orgId, name and founderUserId');
  await ensureSchema();
  const exec = (text, params) => client.query(text, params);
  const inserted = await exec(
    `INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, account_type)
     VALUES ($1, $2, 'free', 'free', 'active', 'organization')
     ON CONFLICT (org_id) DO NOTHING`,
    [orgId, String(name).trim().slice(0, 120)]
  );
  await exec(
    `INSERT INTO workspace_members (owner_key, user_id, role, joined_at)
     VALUES ($1, $2, 'owner', NOW())
     ON CONFLICT (owner_key, user_id) DO NOTHING`,
    [orgId, founderUserId]
  );
  await exec(
    'INSERT INTO workspace_ownership_backfills (owner_key) VALUES ($1) ON CONFLICT (owner_key) DO NOTHING',
    [orgId]
  );
  if (inserted.rowCount > 0) {
    await exec(
      `INSERT INTO context_audit_logs (audit_id, owner_key, project_id, action, actor_type, actor_user_id, tool, metadata)
       VALUES ($1, $2, NULL, 'workspace_created', 'user', $3, $4, $5)`,
      [`audit_${crypto.randomUUID()}`, orgId, founderUserId, via, { name: String(name).trim().slice(0, 120), at: via === 'stripe_checkout' ? 'checkout' : via }]
    );
  }
  return inserted.rowCount > 0;
}

// A SELF-HOSTED TEAM WORKSPACE IS CREATED ON REQUEST.
//
// On hosted, a team workspace is born when its Team subscription is confirmed
// (above). A self-hosted install has no billing and every workspace already has
// the team feature, so there is nothing to wait for: the same creation runs
// directly, in its own transaction, with the caller as founder and owner.
async function createSelfHostedTeamWorkspace({ name, founderUserId }) {
  const orgId = `org-${crypto.randomUUID()}`;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await createTeamWorkspaceAtCheckout(client, { orgId, name, founderUserId, via: 'self_hosted' });
    await client.query('COMMIT');
    return { key: orgId, name: String(name).trim().slice(0, 120) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* connection broken */ });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * CLOSING AN ACCOUNT CLOSES ONE PERSON'S ACCOUNT.
 *
 * DELETE /api/v1/orgs deletes the organization at users.org_id, and used to
 * delete every users row (and Clerk login) pointing at it. users.org_id is a
 * TEAM for everybody the legacy invite path created inside it, and the
 * workspace_has_members gate counts only ACTIVE members — so a member that team
 * had REMOVED (without re-homing them) was not counted, and closing the
 * founder's account deleted theirs: login, users row, and through the purge's
 * person-keyed half their memberships, keys and personal projects in every
 * OTHER workspace. Somebody else's account is not the caller's to close.
 *
 * So before the org goes, everybody else still pointing at it is moved into a
 * fresh personal workspace (the same move removal makes), carrying their
 * personal projects out of it, and the purge then finds only the caller.
 * Runs inside the caller's transaction; returns [{ user_id, workspace }].
 */
async function rehomeResidentsBeforeClose(client, orgId, keepUserId) {
  if (!orgId) return [];
  await ensureSchema();
  const residents = await client.query(
    'SELECT user_id, email FROM users WHERE org_id = $1 AND user_id IS DISTINCT FROM $2 FOR UPDATE',
    [orgId, keepUserId || null]
  );
  const rehomed = [];
  for (const person of residents.rows || []) {
    const home = await provisionPersonalWorkspace(client, person.user_id, orgId, person.email);
    // Same contract as removal: failing to carry the projects must not undo
    // the re-home, which is what keeps the account alive.
    await client.query('SAVEPOINT carry_resident_projects');
    let carryFailed = false;
    try {
      await carryPersonalProjects(client, orgId, home, person.user_id);
      await client.query('RELEASE SAVEPOINT carry_resident_projects');
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT carry_resident_projects');
      console.error(`[WORKSPACE] close: personal projects of ${person.user_id} were not carried: ${err.message}`);
      carryFailed = true;
    }
    // Their profile in the closing workspace goes with them too: the purge that
    // follows erases everything still keyed to this workspace.
    const profile = await carryProfileUnderSavepoint(client, orgId, home, person.user_id, 'carry_resident_profile');
    rehomed.push({
      user_id: person.user_id, workspace: home, carry_failed: carryFailed, profile_moved: profile.moved,
    });
  }
  return rehomed;
}

/**
 * Remove somebody from a workspace, give them somewhere of their own to stand
 * if this workspace WAS their own, and carry their personal projects out with
 * them — in one transaction.
 *
 * users.org_id is the workspace every header-less request defaults to and the
 * one refuseOwnOrgBinding bars a removed person from. For most people it is
 * their personal org and removal never touches it. It is a TEAM for anybody the
 * legacy invite path created inside the target org, and for a founder who
 * upgraded their own signup org to Team, handed ownership to a colleague and
 * was then removed (or removed themselves). Removal left those people with a
 * default workspace that refuses them: billing portal, account deletion,
 * creating a workspace, minting a key all answered 403, and the switcher listed
 * the barred org as their own. A person must always have somewhere of their own
 * to stand.
 *
 * So the removal and the re-home commit together: a fresh Free workspace, the
 * same shape POST /teams/workspaces creates, owned by them, and users.org_id
 * re-pointed at it. The team keeps everything — its org row, its subscription,
 * its projects — exactly as member removal always has. Serialised with addMember
 * under the same per-workspace advisory lock.
 *
 * THE PERSON'S OWN SESSION HAS TO BE ABLE TO USE IT. A dashboard session's
 * scopes derive from users.role (auth.js deriveScopes), not from the workspace
 * roster, and people the legacy invite path created carry 'read-only' or
 * 'member' there. Re-homed with that role, they owned a workspace their own
 * session could not write to: minting a key, creating a project, saving
 * preferences and deleting their account all answered insufficient_scope. They
 * are the owner of the new workspace, so users.role says so, in the same
 * transaction that makes them one.
 *
 * PERSONAL PROJECTS TRAVEL WITH THEIR AUTHOR — EVERY AUTHOR, NOT ONLY A
 * FOUNDER. A 'personal' project is readable by its author and nobody else, not
 * even a workspace owner, so one left in the team after its author is removed
 * has no reader at all, the author included. They move into the person's own
 * workspace: the new one for a re-homed founder, users.org_id for everybody
 * else (re-sealed under its data key, exactly as POST /teams/projects/:id/move
 * re-seals). 'private' and 'shared' projects are the team's and stay. Nothing
 * is carried into a workspace the person has themselves been removed from.
 *
 * THE PROFILE TRAVELS THE SAME WAY (carryPersonalProfile): their "you" row in
 * this workspace goes to carriedTo, merged into the one there.
 *
 * Returns { removed, personalWorkspace, carriedTo, projectsMoved, projectsLeft,
 * carryFailed, profileMoved, profileMerged, profileNotMoved, shareLinksRevoked }
 * — profileNotMoved names why a profile with something in it stayed
 * ('no_workspace_of_their_own', 'unreadable', 'carry_failed'), else null;
 * personalWorkspace is the new org id, or null when nobody
 * needed re-homing; carriedTo is where personal projects went (null when there
 * was nowhere admissible); projectsLeft names personal projects that could not
 * be re-sealed and so were left where they were rather than moved into a key
 * that cannot open them; carryFailed says the carry as a whole failed and
 * nothing was moved.
 *
 * `voluntary` marks a self-leave (left_voluntarily), which the domain door does
 * not treat as a removal an owner has to reverse.
 */
async function removeMemberAndRehome(ownerKey, userId, { requireAnotherOwner = false, voluntary = false } = {}) {
  const none = () => ({
    removed: false, personalWorkspace: null, carriedTo: null, projectsMoved: [], projectsLeft: [], carryFailed: false,
    profileMoved: false, profileMerged: false, profileNotMoved: null, shareLinksRevoked: [],
  });
  if (!ownerKey || !userId) return none();
  await ensureSchema();

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock($1, hashtext($2))',
      [WORKSPACE_MEMBERSHIP_LOCK_NAMESPACE, ownerKey]
    );
    // THE LAST-OWNER CHECK HAS TO BE UNDER THE LOCK THE REMOVAL IS.
    //
    // DELETE /teams/members counted owners before calling here, outside any
    // lock, so two co-owners removing each other at the same moment each saw
    // the other still there, both removals landed, and the workspace was left
    // with no owner — nobody able to bill, administer or delete it. Counted
    // here, the second removal sees the first.
    // 'if_owner' is the self-leave form: the rule is about not leaving the
    // workspace without an owner, so it binds only when the person going IS
    // one. Read under the lock, so a promotion racing the leave is seen.
    let mustKeepAnOwner = Boolean(requireAnotherOwner);
    if (requireAnotherOwner === 'if_owner') {
      const leaver = await client.query(
        `SELECT role FROM workspace_members
          WHERE owner_key = $1 AND user_id = $2 AND removed_at IS NULL`,
        [ownerKey, userId]
      );
      mustKeepAnOwner = ['owner', 'admin'].includes(leaver.rows[0]?.role);
    }
    if (mustKeepAnOwner && !(await anotherActiveOwnerExists(client, ownerKey, userId))) {
      await client.query('ROLLBACK');
      return { ...none(), reason: 'last_owner' };
    }
    const removed = await client.query(
      `UPDATE workspace_members SET removed_at = NOW(), left_voluntarily = $3
        WHERE owner_key = $1 AND user_id = $2 AND removed_at IS NULL`,
      [ownerKey, userId, voluntary === true]
    );
    if (!removed.rowCount) {
      await client.query('ROLLBACK');
      return none();
    }

    let personalWorkspace = null;
    let carriedTo = null;
    let moved = { projectsMoved: [], projectsLeft: [], carryFailed: false };
    const person = (await client.query(
      'SELECT email, org_id FROM users WHERE user_id = $1 FOR UPDATE',
      [userId]
    )).rows[0] || null;

    // AN UNUSED INVITATION IS NOT A WAY BACK IN.
    //
    // Somebody admitted through the domain door, or invited twice, can still
    // hold an open invitation to this workspace, and redeeming it after removal
    // re-admitted them — at the invitation's role — with nothing but their
    // revoked keys changed. Removal is the owner deciding about this person, so
    // it revokes what is outstanding for them, in the same transaction. A fresh
    // invitation (createInvite clears revoked_at) is still how an owner reverses
    // it.
    if (person?.email) {
      await client.query(
        `UPDATE workspace_invites SET revoked_at = NOW()
          WHERE owner_key = $1 AND email = lower(btrim($2)) AND accepted_at IS NULL AND revoked_at IS NULL`,
        // createInvite stores the address trimmed and lower-cased, so this is
        // an exact match on the (owner_key, email) unique index.
        [ownerKey, person.email]
      );
    }

    if (person && person.org_id === ownerKey) {
      personalWorkspace = await provisionPersonalWorkspace(client, userId, ownerKey, person.email);
      carriedTo = personalWorkspace;
    } else if (person && person.org_id) {
      // An ordinary member: their own workspace is users.org_id — unless they
      // have been removed from THAT too, in which case there is no workspace of
      // theirs to put anything in, and the projects stay (reported) rather than
      // being delivered somewhere their author cannot read.
      const barred = await client.query(
        `SELECT 1 FROM workspace_members
          WHERE owner_key = $1 AND user_id = $2 AND removed_at IS NOT NULL`,
        [person.org_id, userId]
      );
      if (!barred.rows.length) carriedTo = person.org_id;
    }

    if (carriedTo) {
      // Under a savepoint: carrying the projects is part of letting somebody go
      // properly, but a failure there must not undo the REMOVAL, which is the
      // security half of this transaction. Rolled back to here, the projects
      // stay in the team exactly as they were, and the caller is told.
      await client.query('SAVEPOINT carry_personal_projects');
      try {
        moved = await carryPersonalProjects(client, ownerKey, carriedTo, userId);
        await client.query('RELEASE SAVEPOINT carry_personal_projects');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT carry_personal_projects');
        console.error(`[WORKSPACE] removal: personal projects of ${userId} were not carried: ${err.message}`);
        moved = { projectsMoved: [], projectsLeft: [], carryFailed: true };
      }
    }

    // THE PROFILE GOES WHERE THE PERSONAL PROJECTS WENT (see
    // carryPersonalProfile), in this same transaction. With nowhere admissible
    // to put it, it stays, and the reply says so when there is one to speak of.
    let profile = { moved: false, merged: false, reason: null };
    if (carriedTo) {
      profile = await carryProfileUnderSavepoint(client, ownerKey, carriedTo, userId, 'carry_personal_profile');
    } else if (await tableExists((text, params) => client.query(text, params), 'context_globals')) {
      const left = await client.query(
        'SELECT global FROM context_globals WHERE owner_key = $1 AND person_id = $2',
        [ownerKey, userId]
      );
      if (left.rows.length && (profileIsSealed(left.rows[0].global) || profileHasContent(left.rows[0].global))) {
        profile = { ...profile, reason: 'no_workspace_of_their_own' };
      }
    }

    const shareLinksRevoked = await revokeRemovedMembersShareLinks(client, ownerKey, userId);

    await client.query('COMMIT');
    return {
      removed: true,
      personalWorkspace,
      carriedTo,
      projectsMoved: moved.projectsMoved || [],
      projectsLeft: moved.projectsLeft || [],
      carryFailed: Boolean(moved.carryFailed),
      profileMoved: profile.moved,
      profileMerged: profile.merged,
      profileNotMoved: profile.reason,
      shareLinksRevoked,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* connection already broken */ });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Workspaces this person was removed from (and not readmitted to).
 * `byOwnerOnly` leaves out the ones they left on their own — see isRemovedFrom.
 */
async function listRemovedMemberships(userId, { byOwnerOnly = false } = {}) {
  if (!userId) return [];
  await ensureSchema();
  const result = await db.query(
    `SELECT owner_key FROM workspace_members
      WHERE user_id = $1 AND removed_at IS NOT NULL${byOwnerOnly ? ' AND NOT left_voluntarily' : ''}`,
    [userId],
    'org-system'
  );
  return result.rows.map((row) => row.owner_key);
}

/**
 * Drop every workspace membership a PERSON holds, because the person has ceased
 * to exist — the Clerk `user.deleted` webhook, not somebody leaving a team.
 *
 * Deliberately a hard DELETE where removeMember does a soft removal. A
 * `removed_at` row is a record about a person, and after an erasure request
 * there is no person left for it to be about; more practically, this table has
 * no foreign key to `users`, so a membership row outlives the user row it
 * projects. Left behind, the deleted founder still counts in
 * countActiveMembers, still holds a seat against the plan's cap, and still
 * makes isSharedWorkspace true for a workspace nobody is in.
 *
 * It touches nothing the person CONTRIBUTED. Their decisions, landmines and
 * paths stay in every workspace they worked in, for the same reason member
 * removal keeps them: that accumulated brief is what the team is paying for.
 */
async function forgetPerson(userId) {
  if (!userId) return 0;
  await ensureSchema();
  const result = await db.query(
    'DELETE FROM workspace_members WHERE user_id = $1',
    [userId],
    'org-system'
  );
  return result.rowCount || 0;
}

// Is there an ACTIVE owner of this workspace other than `userId`? Run on the
// caller's transaction, after it has taken the membership lock.
async function anotherActiveOwnerExists(client, ownerKey, userId) {
  const result = await client.query(
    `SELECT 1 FROM workspace_members
      WHERE owner_key = $1 AND role IN ('owner', 'admin') AND removed_at IS NULL AND user_id <> $2
      LIMIT 1`,
    [ownerKey, userId]
  );
  return result.rows.length > 0;
}

/**
 * Change a member's role. Returns true when a row changed, false when there is
 * no such active member. Throws `last_owner` (err.code) rather than demote the
 * workspace's only remaining owner.
 *
 * Under the membership lock, and the owner count read inside it: two co-owners
 * demoting each other concurrently each passed the route's check (the other was
 * still an owner when it looked) and both demotions landed — a workspace with no
 * owner. The check is here and not only in the route because it is an invariant
 * of the data, not of one screen.
 */
async function setMemberRole(ownerKey, userId, role) {
  if (!ROLES.includes(role)) throw new Error(`unknown role: ${role}`);
  await ensureSchema();
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock($1, hashtext($2))',
      [WORKSPACE_MEMBERSHIP_LOCK_NAMESPACE, ownerKey]
    );
    if (role !== 'owner' && !(await anotherActiveOwnerExists(client, ownerKey, userId))) {
      const current = await client.query(
        'SELECT role FROM workspace_members WHERE owner_key = $1 AND user_id = $2 AND removed_at IS NULL',
        [ownerKey, userId]
      );
      // Only refuse when this person IS the last owner: with no owner at all
      // (an ownerless legacy workspace) demoting a member changes nothing.
      if (normalizeRole(current.rows[0]?.role) === 'owner') {
        await client.query('ROLLBACK');
        const error = new Error('last_owner');
        error.code = 'last_owner';
        throw error;
      }
    }
    const result = await client.query(
      `UPDATE workspace_members SET role = $3
        WHERE owner_key = $1 AND user_id = $2 AND removed_at IS NULL`,
      [ownerKey, userId, role]
    );
    await client.query('COMMIT');
    return result.rowCount > 0;
  } catch (err) {
    if (err?.code !== 'last_owner') await client.query('ROLLBACK').catch(() => { /* connection already broken */ });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Stamp every unattributed project in a workspace with its founding owner.
 *
 * A project created before per-user attribution existed has owner_user_id NULL,
 * and the visibility filter has to decide what NULL means. Both readings are
 * wrong in isolation: treat it as "belongs to nobody, hide it" and a solo user's
 * entire history vanishes the day they invite a colleague; treat it as "belongs
 * to everybody, show it" and their private history is published by that same
 * act. The ambiguity is only resolvable while the workspace still has one
 * member, because then there is exactly one person it could belong to.
 *
 * So it is resolved there, once, in the instant before a second person can read
 * anything — and afterwards NULL cannot recur, because project creation has
 * stamped owner_user_id since it was added.
 */
async function backfillProjectOwnership(ownerKey, exec = systemExec) {
  const owner = await exec(
    `SELECT user_id FROM workspace_members
      WHERE owner_key = $1 AND removed_at IS NULL
      ORDER BY joined_at ASC LIMIT 1`,
    [ownerKey]
  );
  const founderId = owner.rows[0]?.user_id;
  if (!founderId) return 0;

  // NEITHER WRITE SWALLOWS ITS ERRORS ANY MORE.
  //
  // They used to, which meant a flip that failed on a locked row or a broken
  // connection still returned normally, and addMember then recorded the backfill
  // as done. The ambiguity this function exists to resolve became permanent, and
  // silently. Both statements now throw, which rolls back the caller's
  // transaction and leaves the marker unwritten so the next join retries.
  const result = await exec(
    `UPDATE context_projects SET owner_user_id = $2
      WHERE owner_key = $1 AND owner_user_id IS NULL`,
    [ownerKey, founderId]
  );

  // Everything that predates the team becomes PERSONAL, not merely private.
  //
  // 'private' means org-owned, and org-owned work is readable by a workspace
  // owner. That is right for work done as a team — and wrong for everything
  // written back when this workspace was one person's. Inviting a colleague must
  // never publish what predates them, and that has to hold against a future
  // co-owner too, not only against the person being invited today.
  //
  // At this instant the founder is the sole owner, so the flip costs them
  // nothing and is invisible; it only ever matters later, which is exactly when
  // nobody would think to ask for it. Promoting a project to private or shared
  // stays a deliberate act.
  await exec(
    `UPDATE context_projects SET visibility = 'personal'
      WHERE owner_key = $1 AND visibility = 'private'`,
    [ownerKey]
  );

  // AND SO DOES THE KNOWLEDGE THAT HUNG OFF NO PROJECT.
  //
  // A graph node with no project is workspace-level: every member reads it. The
  // projects above were flipped and the nodes were not, so the first colleague
  // invited read the founder's solo-era decisions, people and notes through
  // recall and their very first brief (scan 31). There is no record of which of
  // them the founder once meant for the team (an explicit scope:"workspace"
  // leaves no trace on a node), so all of them are treated as private — the
  // direction that cannot publish anything.
  //
  // PRIVATE BY MARK, NOT BY MOVE. Round 31 attached each such node to a project
  // (its evidence's, else the founder's latest), which made an unrelated project
  // a privacy container: a scratch project created after them took them in, and
  // deleting it deleted them; a founder with no project at all had nowhere to
  // put them, so they stayed readable by everyone (scan 32). Each node now keeps
  // project_id NULL and carries metadata.private_to = the founder's person id,
  // and the graph visibility filter (contextSyncService nodeVisibleIn) shows it
  // to that person and nobody else — not a workspace owner either, as with a
  // personal project. The way back is the author's own re-save:
  // upsertWorkspaceEntities clears the mark when the founder saves the node
  // with an explicit scope:"workspace", or files it under a project (named, or
  // the working project by default), adopting it there, and says so in the
  // reply. Project roots are keyed to their own project already. Runs inside
  // the same transaction and marker as the flip, so it happens once.
  await exec(
    `UPDATE context_graph_nodes
        SET metadata = metadata || jsonb_build_object('private_to', $2::text)
      WHERE owner_key = $1 AND project_id IS NULL AND node_type <> 'project'
        AND COALESCE(metadata->>'private_to', '') = ''`,
    [ownerKey, founderId]
  );

  // AND EVERY NODE ONE OF THEIR PROJECTS SHARED WITH ANOTHER IS SPLIT (scan 35).
  await splitCrossProjectLandings(ownerKey, exec);

  return result.rowCount || 0;
}

// The scoped key of node row `n` for project expression `pid`, in SQL
// (contextSyncService scopedEntityKey over unscopedEntityKey).
const scopedKeySql = (n, pid) => `${boundedKeyBaseSql(`split_part(${n}.canonical_key, '${SCOPED_KEY_MARK}', 1)`)} || '${SCOPED_KEY_MARK}' || ${pid}`;

// A copy key longer than this is one the unique (owner_key, node_type,
// canonical_key) index could refuse (2704 bytes a tuple, less the other two
// columns): the split skips it rather than fail the invite.
const SPLIT_COPY_KEY_MAX_BYTES = 2400;

// The (node homed in X, evidence from Y) pairs a split acts on: evidence that a
// project's own context produced (a sighting is a usage record and grants
// nothing — store listGraphNodeProjectIds) on a node homed in a DIFFERENT
// project of this workspace. Project roots are keyed by name and never scoped
// (landGraphWrite), so a copy of one would be written over by the next rebuild.
const CROSS_LANDING_FROM = `
  FROM context_graph_evidence e
  JOIN context_graph_nodes n ON n.owner_key = e.owner_key AND n.node_id = e.node_id
  JOIN context_projects p ON p.project_id = e.project_id AND p.owner_key = e.owner_key`;
const CROSS_LANDING_WHERE = `
 WHERE e.owner_key = $1 AND e.project_id IS NOT NULL
   AND COALESCE(e.metadata->>'kind', '') <> 'sighting'
   AND n.project_id IS NOT NULL AND n.project_id <> e.project_id
   AND n.node_type <> 'project'`;
// X's node, the project Y, and Y's copy — read while the evidence still points
// at X's node.
const CROSS_LANDING_MAP = `
  SELECT DISTINCT n.node_id AS from_id, e.project_id AS pid, c.node_id AS to_id
  ${CROSS_LANDING_FROM}
  JOIN context_graph_nodes c
    ON c.owner_key = e.owner_key AND c.node_type = n.node_type
   AND c.canonical_key = ${scopedKeySql('n', 'e.project_id')} AND c.node_id <> n.node_id
  ${CROSS_LANDING_WHERE}`;

/**
 * SPLIT WHAT ONE PERSON'S PROJECTS SHARED, THE MOMENT A SECOND PERSON ARRIVES.
 *
 * While a workspace has one person there is no landing rule (contextSyncService
 * graphRebuildLanding is null there): every write takes the plain key, so an
 * entity two of the founder's projects both name is ONE node, homed in the
 * project that named it first, with the other's rebuild evidence on it. And
 * rebuild evidence is a read grant (nodeVisibleIn: a homed node is read
 * wherever it was seen). Nothing is wrong with that while one person reads it.
 * The first invite flips every project to personal and used to leave those
 * nodes as they were, so the founder sharing project Y later served the node
 * homed in X, still personal, to the team: its hand-written summary ("because I
 * am interviewing at Paddle next week"), its metadata and X's id (scan 35
 * b/p110, a/p5). Round 34's cross-project landing (scan 34 a/F1), made in the
 * solo era, where nothing ever judged it.
 *
 * So the landing rule is applied RETROSPECTIVELY, once, in the transaction that
 * switches it on: for every node homed in X with evidence from Y, Y gets its own
 * `<key>::in.<Y>` node — the one every later write for Y finds first
 * (landGraphWrite) — and Y's evidence and Y's edges (edge.project_id = Y) are
 * re-pointed at it. The copy is IDENTITY ONLY (type, key, title): X's summary
 * and metadata are X's writing, and Y's next rebuild writes Y's own. A copy that
 * already exists is reused. X's node keeps X's evidence and only that.
 * Workspace-level nodes are not split: their evidence grants nothing, and the
 * private_to mark above decides who reads them.
 *
 * SET-BASED, never a round trip per node: the copies, the edge moves and the
 * evidence moves are one statement each over the owner's rows (the evidence
 * scan leads with owner_key; node and edge lookups go through their unique
 * indexes), and the rare edge merges are batched. They run on the invite's
 * transaction client (the 25s statement timeout, not the 8s breaker).
 * Measured (scan 35) on a solo workspace of 20k nodes and 100k evidence rows
 * spread at random over 10 projects — the worst case, ~71k copies: 8-11s for
 * the whole split, no statement over 3.6s; 2k nodes / 10k evidence: 0.6s; a
 * second run, which finds nothing: ~1s.
 *
 * Returns counts. Throws, so the invite that runs it rolls back and retries.
 */
async function splitCrossProjectLandings(ownerKey, exec = systemExec) {
  // rows_skipped is added only when a copy was skipped (step 1).
  const report = { nodes_copied: 0, evidence_repointed: 0, edges_repointed: 0, edges_merged: 0 };
  if (!ownerKey || !(await tableExists(exec, 'context_graph_nodes'))) return report;

  // 1. Y's copies. DISTINCT ON because two nodes of one type can share a plain
  //    key (`x` and a stray `x::in.Z`); ON CONFLICT reuses a copy that exists.
  //    A copy keeps the node's STATE (nodeStateMetadataSql: resolved, pinned,
  //    tier, usage — scan 36 b/p115, b/p117), never its words.
  //
  //    NO ONE ROW MAY FAIL THE INVITE (scan 36 b/p119). This runs inside the
  //    invite's transaction, so a copy the key index refuses threw there and
  //    every retry of the invite failed the same way. Scoped keys are bounded
  //    now (boundedKeyBase), so none should be refused; a copy whose key is
  //    still past the index's cap is skipped (its evidence stays where it is,
  //    step 3 finds no copy for it) and reported, never thrown.
  const copies = (await exec(
    `WITH s AS (
       SELECT n.node_type, ${scopedKeySql('n', 'e.project_id')} AS copy_key, e.project_id AS pid,
              n.title, n.confidence, n.source_tool, n.created_at, n.updated_at, n.last_seen_at,
              ${nodeStateMetadataSql('n')} AS state
       ${CROSS_LANDING_FROM}
       ${CROSS_LANDING_WHERE}
     ), made AS (
       INSERT INTO context_graph_nodes
         (node_id, owner_key, project_id, node_type, canonical_key, title, summary, metadata,
          confidence, source_session_id, source_tool, created_at, updated_at, last_seen_at)
       SELECT DISTINCT ON (s.node_type, s.copy_key)
              'graph_node_' || gen_random_uuid()::text, $1, s.pid, s.node_type, s.copy_key, s.title, '',
              s.state, s.confidence, '', s.source_tool, s.created_at, s.updated_at, s.last_seen_at
         FROM s
        WHERE octet_length(s.copy_key) <= ${SPLIT_COPY_KEY_MAX_BYTES}
        ORDER BY s.node_type, s.copy_key
       ON CONFLICT (owner_key, node_type, canonical_key) DO NOTHING
       RETURNING 1
     )
     SELECT (SELECT COUNT(*) FROM made)::int AS copied,
            (SELECT COUNT(DISTINCT (s.node_type, s.copy_key)) FROM s
              WHERE octet_length(s.copy_key) > ${SPLIT_COPY_KEY_MAX_BYTES})::int AS skipped`,
    [ownerKey]
  )).rows[0] || {};
  report.nodes_copied = copies.copied || 0;
  if (copies.skipped) {
    report.rows_skipped = copies.skipped;
    reportSwallowed(new Error('first-invite split skipped copies whose key is past the index cap'), {
      op: 'split_cross_project_landings_skipped',
      meta: { owner_key: ownerKey, skipped: report.rows_skipped },
    });
  }

  // 2. Y's EDGES re-pointed at Y's copies. An edge whose new ends already have
  //    an edge of its type joins that one — its evidence moves over and the
  //    duplicate goes, which the unique index would otherwise refuse.
  const moves = (await exec(
    `WITH m AS (${CROSS_LANDING_MAP}),
          t AS (
            SELECT ed.edge_id, ed.edge_type,
                   COALESCE(mf.to_id, ed.from_node_id) AS nf,
                   COALESCE(mt.to_id, ed.to_node_id) AS nt
              FROM context_graph_edges ed
              LEFT JOIN m mf ON mf.from_id = ed.from_node_id AND mf.pid = ed.project_id
              LEFT JOIN m mt ON mt.from_id = ed.to_node_id AND mt.pid = ed.project_id
             WHERE ed.owner_key = $1 AND ed.project_id IS NOT NULL
               AND (mf.to_id IS NOT NULL OR mt.to_id IS NOT NULL)
          )
     SELECT t.edge_id, t.edge_type, t.nf, t.nt,
            (SELECT x.edge_id FROM context_graph_edges x
              WHERE x.owner_key = $1 AND x.edge_type = t.edge_type
                AND x.from_node_id = t.nf AND x.to_node_id = t.nt) AS existing_id
       FROM t
      ORDER BY t.edge_id`,
    [ownerKey]
  )).rows;
  const winners = new Map(); // edge type + new ends -> the edge that keeps them
  const updates = [];
  const losers = [];
  for (const row of moves) {
    const target = `${row.edge_type}\u0000${row.nf}\u0000${row.nt}`;
    const winner = row.existing_id || winners.get(target);
    if (winner) losers.push([row.edge_id, winner]);
    else {
      winners.set(target, row.edge_id);
      updates.push(row);
    }
  }
  if (losers.length) {
    await exec(
      `UPDATE context_graph_evidence ev SET edge_id = m.to_id
         FROM unnest($2::text[], $3::text[]) AS m(from_id, to_id)
        WHERE ev.owner_key = $1 AND ev.edge_id = m.from_id`,
      [ownerKey, losers.map(([from]) => from), losers.map(([, to]) => to)]
    );
    await exec(
      'DELETE FROM context_graph_edges WHERE owner_key = $1 AND edge_id = ANY($2::text[])',
      [ownerKey, losers.map(([from]) => from)]
    );
    report.edges_merged = losers.length;
  }
  if (updates.length) {
    await exec(
      `UPDATE context_graph_edges ed SET from_node_id = u.nf, to_node_id = u.nt
         FROM unnest($2::text[], $3::text[], $4::text[]) AS u(edge_id, nf, nt)
        WHERE ed.owner_key = $1 AND ed.edge_id = u.edge_id`,
      [ownerKey, updates.map((row) => row.edge_id), updates.map((row) => row.nf), updates.map((row) => row.nt)]
    );
    report.edges_repointed = updates.length;
  }

  // 3. Y's EVIDENCE re-pointed at Y's copy — last, because steps 1-2 find the
  //    pairs through it.
  const repointed = await exec(
    `UPDATE context_graph_evidence ev SET node_id = m.to_id
       FROM (${CROSS_LANDING_MAP}) m
      WHERE ev.owner_key = $1 AND ev.node_id = m.from_id AND ev.project_id = m.pid
        AND COALESCE(ev.metadata->>'kind', '') <> 'sighting'`,
    [ownerKey]
  );
  report.evidence_repointed = repointed.rowCount || 0;
  return report;
}

/**
 * SETTLE A ONE-PERSON LANDING THAT RACED THE FIRST INVITE (scan 36 a/p3).
 *
 * The split above runs once, in the invite's transaction. But a rebuild decides
 * its landing once, at its start (contextSyncService graphRebuildLanding: null,
 * plain keys, while the workspace is one person's), and takes seconds to write:
 * one in flight when the first invite was accepted wrote its cross-project
 * landings AFTER the split had read the graph — some or all of them — and the
 * claimed marker meant nothing ever split them. Sharing that project then
 * served the founder's other project's note to the new teammate.
 *
 * So a graph write that computed a one-person landing calls this once its
 * writes have committed. It waits for any membership change in flight — a
 * SHARED hold on the lock addMember takes exclusively, released at once: it
 * returns immediately unless an invite is mid-transaction, and then as soon as
 * that commits — and only then asks `stillSolo()`. If the workspace is no
 * longer one person's, the writes may have missed the split, and it runs again:
 * the split is idempotent, finishing a half-done one (new cross landings get
 * copies, copies that exist are reused) and finding nothing to do otherwise.
 *
 * NO DEADLOCK: the caller holds no lock and no open transaction when it waits
 * (its writes are committed), so the invite can never be waiting on it. A
 * shared advisory lock held by every solo rebuild for its whole run was the
 * alternative, and was rejected: a session-level lock held across writes on
 * other pooled connections is a wait no deadlock detector can see.
 *
 * Its own pool client, so neither wait nor split is cut short by the 8s query
 * breaker; the split runs in one transaction. Returns the split's report, or
 * null when the workspace is still one person's.
 */
async function settleSoloEraLandings(ownerKey, stillSolo) {
  if (!ownerKey) return null;
  const client = await db.pool.connect();
  try {
    await client.query(
      'SELECT pg_advisory_xact_lock_shared($1, hashtext($2))',
      [WORKSPACE_MEMBERSHIP_LOCK_NAMESPACE, ownerKey]
    );
    if (await stillSolo()) return null;
    await client.query('BEGIN');
    const report = await splitCrossProjectLandings(ownerKey, (text, params) => client.query(text, params));
    await client.query('COMMIT');
    return report;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* not in a transaction, or connection broken */ });
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

function hashInviteToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Create (or refresh) an invitation and return the raw token exactly once.
 * Only the hash is stored, so a leaked database row is not a usable invite.
 */
async function createInvite(ownerKey, email, { role = 'member', invitedBy = null, ttlDays = 7 } = {}) {
  await ensureSchema();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedRole = ROLES.includes(role) ? role : normalizeRole(role);
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashInviteToken(token);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  const inviteId = `winv_${crypto.randomUUID()}`;

  const result = await db.query(
    `INSERT INTO workspace_invites (invite_id, owner_key, email, role, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (owner_key, email) DO UPDATE SET
       role        = EXCLUDED.role,
       token_hash  = EXCLUDED.token_hash,
       invited_by  = EXCLUDED.invited_by,
       expires_at  = EXCLUDED.expires_at,
       accepted_at = NULL,
       accepted_user_id = NULL,
       revoked_at  = NULL,
       created_at  = NOW()
     RETURNING invite_id`,
    [inviteId, ownerKey, normalizedEmail, normalizedRole, tokenHash, invitedBy, expiresAt.toISOString()],
    'org-system'
  );

  return {
    invite_id: result.rows[0]?.invite_id || inviteId,
    token,
    expires_at: expiresAt.toISOString(),
    email: normalizedEmail,
    role: normalizedRole,
  };
}

/**
 * Open invitations: not accepted, not revoked, and NOT EXPIRED.
 *
 * Both seat checks in routes/shared/teams.js count activeMembers +
 * listInvites().length, and the roster shows this list as "pending". Without the
 * expires_at filter an invitation nobody redeemed inside its window held a seat
 * forever — acceptInvite already refuses it as expired, so it was a seat that
 * could never be filled. Expired rows are kept (createInvite refreshes one on
 * re-invite); pass includeExpired for history, where they carry status 'expired'.
 */
async function listInvites(ownerKey, { includeExpired = false } = {}) {
  await ensureSchema();
  const result = await db.query(
    `SELECT invite_id, email, role, invited_by, expires_at, accepted_at, created_at,
            expires_at <= NOW() AS expired
       FROM workspace_invites
      WHERE owner_key = $1 AND revoked_at IS NULL AND accepted_at IS NULL
        AND ($2::boolean OR expires_at > NOW())
      ORDER BY created_at DESC`,
    [ownerKey, Boolean(includeExpired)],
    'org-system'
  );
  return result.rows.map((row) => ({
    invite_id: row.invite_id,
    email: row.email,
    role: normalizeRole(row.role),
    invited_by: row.invited_by || null,
    expires_at: row.expires_at,
    created_at: row.created_at,
    status: row.expired ? 'expired' : 'pending',
  }));
}

/**
 * Consume an open invitation by id, for the paths that authorised against the
 * invite ROW rather than by redeeming its token (POST /orgs/join).
 *
 * Idempotent and non-escalating: it grants nothing, it only stops an
 * already-used invitation from holding a seat and staying redeemable.
 */
async function markInviteAccepted(ownerKey, inviteId, userId) {
  if (!ownerKey || !inviteId) return false;
  await ensureSchema();
  const result = await db.query(
    `UPDATE workspace_invites SET accepted_at = NOW(), accepted_user_id = $3
      WHERE owner_key = $1 AND invite_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [ownerKey, inviteId, userId || null],
    'org-system'
  );
  return result.rowCount > 0;
}

async function revokeInvite(ownerKey, inviteId) {
  await ensureSchema();
  const result = await db.query(
    `UPDATE workspace_invites SET revoked_at = NOW()
      WHERE owner_key = $1 AND invite_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [ownerKey, inviteId],
    'org-system'
  );
  return result.rowCount > 0;
}

/**
 * Redeem an invitation for an already-signed-in user.
 *
 * The email on the invite must match the redeeming account: an invite is
 * addressed to a person, and a link forwarded to somebody else is not consent to
 * admit them. Returns a typed reason rather than a bare false so the route can
 * say which of "expired", "already used" and "wrong account" actually happened —
 * three failures that look identical from the outside and need different fixes.
 */
async function acceptInvite(token, user) {
  await ensureSchema();
  if (!token || !user?.id) return { ok: false, reason: 'invalid_token' };

  const result = await db.query(
    `SELECT invite_id, owner_key, email, role, expires_at, accepted_at, revoked_at
       FROM workspace_invites
      WHERE token_hash = $1`,
    [hashInviteToken(token)],
    'org-system'
  );
  const invite = result.rows[0];
  if (!invite) return { ok: false, reason: 'invalid_token' };
  if (invite.revoked_at) return { ok: false, reason: 'revoked' };
  if (invite.accepted_at) return { ok: false, reason: 'already_accepted' };
  if (new Date(invite.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };

  // FAIL CLOSED when the redeemer's email is unknown.
  //
  // This used to require BOTH sides to be truthy before comparing, so an actor
  // with no email skipped the check entirely — and a key-authed actor has no
  // email field at all (middleware/auth.js builds it without one). Any valid API
  // key plus a forwarded invite link therefore defeated the guarantee this guard
  // exists to make: an invitation is addressed to a person, and a link passed to
  // somebody else is not consent to admit them.
  const invitedEmail = String(invite.email || '').toLowerCase();
  const actorEmail = String(user.email || '').toLowerCase();
  if (invitedEmail && invitedEmail !== actorEmail) {
    return { ok: false, reason: 'wrong_account', invited_email: invitedEmail };
  }

  // AN INVITATION IS NOT A STANDING GRANT. RE-CHECK AT ACCEPT TIME.
  //
  // /invite enforces the plan feature and the seat cap when the invitation is
  // SENT, and nothing re-asked when it was redeemed — which is a week later by
  // default, and a week is long enough for the subscription to be cancelled.
  // After `customer.subscription.deleted` the workspace is written back to
  // plan free, so a pending invitation accepted afterwards added a third active
  // member to a free workspace: the seat was never sold and the gate that would
  // have refused it had already run.
  //
  // THE INVITATION BEING REDEEMED IS NOT A SECOND SEAT. It was counted when it
  // was sent, precisely so this person would have one. Accepting turns that one
  // pending invitation into one active member: net zero. checkLimit refuses at
  // count >= limit, so counting it again here, next to the membership it is
  // about to become, refused whoever filled the LAST seat: on the default
  // two-seat team that is the very first person anybody invites.
  //
  // NOR ARE THE OTHER PENDING INVITATIONS. They are reservations, and a
  // reservation is not occupancy: once seats were cut below the outstanding
  // invitations, each invitee was refused on the strength of the others'
  // pending rows, so nobody could take a seat that stood empty. At accept time
  // the question is only whether an active seat is free (see addMember).
  //
  // Refused rather than revoked: the invitation stays pending and the invitee's
  // active workspace is untouched, because this is the workspace's billing
  // problem and not a decision about the person holding the link. Paying again
  // makes the same link work.
  //
  // Required here rather than at module scope: entitlementService reaches back
  // into plans and referrals, and this is the only place in this file that
  // needs it.
  const { checkFeature, checkLimit } = require('./entitlementService');
  const [entitled, activeMembers] = await Promise.all([
    checkFeature(invite.owner_key, 'team_management').then(() => true).catch(() => false),
    countActiveMembers(invite.owner_key),
  ]);
  const seatAvailable = entitled
    && await checkLimit(invite.owner_key, 'included_seats', activeMembers)
      .then(() => true)
      .catch(() => false);
  if (!entitled || !seatAvailable) {
    const named = await db.query(
      'SELECT name FROM organizations WHERE org_id = $1',
      [invite.owner_key],
      'org-system',
    ).then((r) => r.rows[0]?.name || null).catch(() => null);
    return {
      ok: false,
      reason: 'workspace_not_accepting_members',
      message: `${named || 'That workspace'} is not accepting new members right now. Ask the person who invited you.`,
    };
  }

  // The check above is the friendly early answer; the one that holds is inside
  // addMember, under the workspace lock, where concurrent accepts serialise.
  let membership;
  try {
    membership = await addMember(invite.owner_key, user.id, {
      role: invite.role,
      invitedBy: invite.invited_by || null,
      seatCheck: { excludeInviteId: invite.invite_id },
      acceptInviteId: invite.invite_id,
    });
  } catch (err) {
    if (err && (err.status === 402 || err.code === 'workspace_closing')) {
      return {
        ok: false,
        reason: err.code === 'workspace_closing' ? 'workspace_closing' : 'workspace_not_accepting_members',
        message: err.code === 'workspace_closing'
          ? 'That workspace is being closed, so it cannot take new members. Ask the person who invited you.'
          : 'That workspace is not accepting new members right now. Ask the person who invited you.',
      };
    }
    throw err;
  }

  const activated = await activateJoinedWorkspace(invite.owner_key, user.id);

  return { ok: true, owner_key: invite.owner_key, membership, activated };
}

/**
 * Point a person who has just joined a workspace at it, unless they have already
 * chosen a different team workspace.
 *
 * addMember never sets is_active, and bindWorkspace resolves every header-less
 * request (every MCP and OAuth session) through getActiveWorkspace. So a new
 * teammate's agents kept landing in their own empty personal org, and on a phone
 * there was no switcher to get out. Their first team is almost certainly where
 * they meant to go; somebody already working in ANOTHER team is not moved,
 * because accepting a second invite must not silently redirect a live agent loop.
 *
 * Best-effort: failing to activate must not fail a redemption that has already
 * been written. The dashboard can still switch explicitly.
 */
async function activateJoinedWorkspace(ownerKey, userId) {
  try {
    const personal = await db.query('SELECT org_id FROM users WHERE user_id = $1', [userId], 'org-system');
    const personalOrg = personal.rows[0]?.org_id || null;
    if (ownerKey === personalOrg) return false;

    const actor = { id: userId, org_id: personalOrg };
    const current = await getActiveWorkspace(actor);
    if (current && current !== personalOrg) {
      if (current === ownerKey) return true;
      // A workspace that is refusing on billing grounds is not one this person
      // is working in: every request they make is already being served from
      // their personal workspace instead. Leaving it active stranded somebody
      // who had just joined a healthy team behind the lapsed one, and a person
      // on an MCP-only or phone client has no switcher to get out with. Only
      // that case moves; a live team they chose is still never redirected.
      // Fails towards NOT moving: an enforcement lookup error leaves things be.
      const { checkEnforcement } = require('./enforcementService');
      const verdict = await checkEnforcement(current).catch(() => null);
      const lapsed = verdict && verdict.allowed === false
        && ['subscription_inactive', 'lockdown_active'].includes(verdict.error);
      if (!lapsed) return false;
    }

    await setActiveWorkspace(actor, ownerKey);
    return true;
  } catch (err) {
    console.warn(`[WORKSPACE] could not activate joined workspace: ${err.message}`);
    return false;
  }
}


// ---------------------------------------------------------------------------
// Domain joining
// ---------------------------------------------------------------------------

// Domains nobody may claim a whole company at. Approving "gmail.com" would let
// anyone on earth join, and the person adding it would have no way to know that
// until it happened — so it is refused rather than warned about.
const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com',
  'gmx.com', 'mail.com', 'yandex.com', 'zoho.com', 'fastmail.com', 'hey.com',
  'qq.com', '163.com', 'duck.com', 'pm.me',
]);

function normalizeDomain(input) {
  return String(input || '').trim().toLowerCase().replace(/^@/, '');
}

function emailDomain(email) {
  const at = String(email || '').lastIndexOf('@');
  return at === -1 ? '' : String(email).slice(at + 1).trim().toLowerCase();
}

function isPublicEmailDomain(domain) {
  return PUBLIC_EMAIL_DOMAINS.has(normalizeDomain(domain));
}

async function listDomains(ownerKey) {
  await ensureSchema();
  const result = await db.query(
    'SELECT domain, role, added_by, created_at FROM workspace_domains WHERE owner_key = $1 ORDER BY domain',
    [ownerKey],
    'org-system'
  );
  return result.rows.map((row) => ({ ...row, role: normalizeRole(row.role) }));
}

async function addDomain(ownerKey, domain, { role = 'member', addedBy = null } = {}) {
  const normalized = normalizeDomain(domain);
  if (!normalized || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(normalized)) {
    const err = new Error('That does not look like a domain.');
    err.code = 'invalid_domain';
    throw err;
  }
  if (isPublicEmailDomain(normalized)) {
    const err = new Error(`${normalized} is a public email provider — approving it would let anyone join this workspace.`);
    err.code = 'public_domain';
    throw err;
  }
  await ensureSchema();
  await db.query(
    `INSERT INTO workspace_domains (owner_key, domain, role, added_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (owner_key, domain) DO UPDATE SET role = EXCLUDED.role`,
    [ownerKey, normalized, ROLES.includes(role) ? role : normalizeRole(role), addedBy],
    'org-system'
  );
  return { domain: normalized, role };
}

async function removeDomain(ownerKey, domain) {
  await ensureSchema();
  const result = await db.query(
    'DELETE FROM workspace_domains WHERE owner_key = $1 AND domain = $2',
    [ownerKey, normalizeDomain(domain)],
    'org-system'
  );
  return result.rowCount > 0;
}

/**
 * Which workspaces this person may join on the strength of their email domain.
 *
 * Offered, never applied automatically. Joining a workspace makes your work
 * visible to other people, and that is a decision a person takes rather than one
 * their email address takes for them — a new hire should not discover on their
 * first session that their side project is now in a company workspace.
 */
async function joinableWorkspaces(email) {
  const domain = emailDomain(email);
  if (!domain || isPublicEmailDomain(domain)) return [];
  await ensureSchema();
  const result = await db.query(
    `SELECT d.owner_key, d.role, o.name
       FROM workspace_domains d
       LEFT JOIN organizations o ON o.org_id = d.owner_key
      WHERE d.domain = $1`,
    [domain],
    'org-system'
  ).catch(() => ({ rows: [] }));
  return result.rows.map((row) => ({
    workspace: row.owner_key,
    name: row.name || 'Workspace',
    role: normalizeRole(row.role),
  }));
}

class WorkspaceAccessError extends Error {
  constructor(message, code = 'workspace_forbidden') {
    super(message);
    this.name = 'WorkspaceAccessError';
    this.status = 403;
    this.code = code;
  }
}

/**
 * THE choke point. Turn an actor (plus an optionally requested workspace) into
 * the owner_key every subsequent query is scoped by.
 *
 * With no workspace requested this returns the actor's own — byte-identical to
 * the `actor.org_id || actor.id` it replaces, so the single-workspace path is
 * unchanged. When a workspace IS requested, membership is checked and a
 * non-member is refused rather than quietly served their own data, which would
 * be the worse failure: a silent wrong answer instead of a loud refusal.
 *
 * System actors (the shared API key, internal jobs) keep their existing
 * unrestricted behaviour — they have no user identity to check a membership
 * against, and narrowing them here would break the jobs without adding safety,
 * since possession of that key is already total access.
 */
async function resolveOwnerKey(actor, requestedWorkspace = null) {
  const fallback = defaultOwnerKey(actor);
  if (!requestedWorkspace || requestedWorkspace === fallback) return fallback;

  if (actor?.type === 'system' || actor?.org_id === 'org-system') return requestedWorkspace;

  const userId = actor?.id && actor?.type !== 'key' ? actor.id : actor?.owner_id;
  if (!userId) {
    throw new WorkspaceAccessError('This credential is not a member of the requested workspace.');
  }

  const membership = await getMembership(requestedWorkspace, userId);
  if (!membership) {
    throw new WorkspaceAccessError('You are not a member of this workspace.');
  }
  return requestedWorkspace;
}

/** The role this actor holds in the resolved workspace, for gating writes. */
async function resolveRole(actor, ownerKey) {
  if (actor?.type === 'system') return 'owner';
  const userId = actor?.id && actor?.type !== 'key' ? actor.id : actor?.owner_id;
  if (!userId) return normalizeRole(actor?.role);
  const membership = await getMembership(ownerKey, userId);
  if (membership) return membership.role;

  // NO ROW MEANS NO ELEVATED ROLE.
  //
  // This used to fall back to normalizeRole(actor.role) so it could ship before
  // the membership backfill had run. But users.role is 'admin' by default for
  // nearly everyone and LEGACY_ROLE_MAP maps admin -> owner, so the fallback
  // silently made every unmigrated actor an OWNER — and owner is now what grants
  // read access to org-private projects. A convenience for a one-time migration
  // became a standing privilege escalation.
  //
  // The one case that still needs the org role is somebody in their OWN
  // workspace before the backfill reaches them: they genuinely own it, and
  // refusing would lock them out of their own account.
  //
  // UNLESS THE WORKSPACE REMOVED THEM. users.org_id is a TEAM for everybody the
  // legacy invite path created inside it, so "their own org" can be a workspace
  // that took them off its roster — and then the absence of an ACTIVE row is
  // the removal, not a backfill gap. Reading the org role there made a removed
  // member an owner again the moment anything consulted this before the
  // binding refusal did (scan 26: emptying the workspace swept the tombstone,
  // and the person was back in as its owner). No row at all still means
  // "not backfilled yet"; a removed row means no.
  //
  // And "their own org" is the PERSON'S (users.org_id): for a key, actor.org_id
  // is the workspace the key was minted in, so a key minted in a team whose
  // holder no longer has a row there read the org role as if the team were
  // theirs, and could write to it (scan 26).
  if (ownerKey && ownerKey === await personalWorkspaceKey(actor) && !(await isRemovedFrom(ownerKey, actor))) {
    return normalizeRole(actor?.role);
  }
  return 'viewer';
}

function canWrite(role) {
  return WRITE_ROLES.has(normalizeRole(role));
}

function canAdminister(role) {
  return ADMIN_ROLES.has(normalizeRole(role));
}

// The scopes a role may put on an API key it mints.
//
// A credential must never out-rank the person who created it. The key carries the
// workspace's org_id, so without this ceiling a viewer could mint themselves a
// context:write key and a member a context:admin one, and thereafter reach routes
// their own session is refused — the key becoming a privilege-escalation ladder
// rather than a convenience.
const ROLE_GRANTABLE_SCOPES = Object.freeze({
  owner: Object.freeze(['context:read', 'context:write', 'context:admin', 'decisions:evaluate']),
  member: Object.freeze(['context:read', 'context:write', 'decisions:evaluate']),
  viewer: Object.freeze(['context:read']),
});

function grantableScopes(role) {
  return [...(ROLE_GRANTABLE_SCOPES[normalizeRole(role)] || ROLE_GRANTABLE_SCOPES.viewer)];
}

module.exports = {
  ROLES,
  resolveAuthors,
  createTeamWorkspaceAtCheckout,
  createSelfHostedTeamWorkspace,
  hashInviteToken,
  selectedWorkspaceKeyForPerson,
  WorkspaceAccessError,
  ensureSchema,
  backfillMembershipsFromUsers,
  backfillProjectOwnership,
  splitCrossProjectLandings,
  settleSoloEraLandings,
  claimOwnershipBackfill,
  ownershipBackfillClaimed,
  hasEverHeldTwoMembers,
  defaultOwnerKey,
  isRemovedFrom,
  isStillAdmitted,
  getActiveWorkspace,
  setActiveWorkspace,
  ensureOwnerMembership,
  actorPersonId,
  actorIdentities,
  personalWorkspaceKey,
  resolveOwnerKey,
  resolveRole,
  normalizeRole,
  canWrite,
  canAdminister,
  grantableScopes,
  getMembership,
  listMemberships,
  listMembers,
  countActiveMembers,
  activateJoinedWorkspace,
  isSharedWorkspace,
  countActiveOwners,
  listSoleOwnedTeams,
  listSoleMemberWorkspaces,
  lockAndConfirmSoleOccupant,
  markWorkspaceClosing,
  clearWorkspaceClosing,
  soleOwnerConflict,
  addMember,
  removeMember,
  removeMemberAndRehome,
  rehomeResidentsBeforeClose,
  carryProjectGraph,
  boundedKeyBase,
  boundedKeyBaseSql,
  eraseProjectGraph,
  carryProjectSkills,
  carryPersonalProfile,
  mergePersonalProfiles,
  listRemovedMemberships,
  forgetPerson,
  setMemberRole,
  createInvite,
  listInvites,
  listDomains,
  addDomain,
  removeDomain,
  joinableWorkspaces,
  isPublicEmailDomain,
  revokeInvite,
  markInviteAccepted,
  acceptInvite,
};
