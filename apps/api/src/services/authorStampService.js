'use strict';

/**
 * WHO A PROJECT'S AUTHOR IS, WHEN THE STAMP ON IT IS A KEY ID (journey r7).
 *
 * Work written before the identity fix is stamped with the writer's KEY id, not
 * their user id. A stamp is resolved to a person through api_keys (key id ->
 * owner_id), and keys are hard-deleted (DELETE /keys/:id), which used to leave a
 * stamp nobody could resolve: in a workspace with several members that counts as
 * "author not left", so no owner could manage the project and its real author was
 * answered 404. Three layers close it:
 *
 *   1. PREVENT   deleteApiKey re-stamps every author field that holds the key id
 *                to the key's owner, before the key goes.
 *   2. RESOLVE   resolveFromHistory: when exactly one active member ever wrote to
 *                a project whose stamp is still unresolvable, it is theirs. Run
 *                lazily when such a project is touched and once at boot
 *                (runAuthorBackfill). Zero or several writers: never a guess.
 *   3. ASSIGN    what is still unresolvable is shown to workspace owners as
 *                "Author unknown", and an owner may assign one active member
 *                (routes/shared/teams.js; assignAuthor here).
 */

const db = require('../config/db');
const store = require('../store/contextSyncStore');
const workspace = require('./workspaceService');

const q = (text, params) => db.query(text, params, 'org-system');

const KEY_ID_SHAPE = /^key[-_]/i;
const looksLikeKeyId = (id) => typeof id === 'string' && KEY_ID_SHAPE.test(id);

// Every plain column that can hold the person who wrote something, and so a key
// id if it was written before the identity fix. (The graph nodes and evidence
// have no author column.) Missing tables or columns are skipped.
const PLAIN_STAMPS = [
  ['context_projects', 'owner_user_id'],
  ['context_events', 'contributing_user_id'],
  ['context_session_loads', 'user_id'],
  ['context_sessions', 'user_id'],
  ['context_project_shares', 'created_by'],
  ['context_project_shares', 'updated_by'],
  ['context_project_members', 'created_by'],
  ['context_share_tokens', 'created_by'],
  ['context_audit_logs', 'actor_user_id'],
];

async function columnExists(exec, table, column) {
  const r = await exec(
    'SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2',
    [table, column]
  );
  return r.rows.length > 0;
}

/** Re-stamp the plain columns, on `exec` (a transaction's executor). Returns counts. */
async function restampPlainStamps(exec, from, to) {
  const counts = {};
  for (const [table, column] of PLAIN_STAMPS) {
    if (!(await columnExists(exec, table, column))) continue;
    const r = await exec(`UPDATE ${table} SET ${column} = $2 WHERE ${column} = $1`, [from, to]);
    if (r.rowCount) counts[`${table}.${column}`] = r.rowCount;
  }
  return counts;
}

// contributed_by appears on decisions, landmines, debugging notes, shipped lines
// and others, all inside the (encrypted) context: walked generically.
function restampContextValue(value, from, to) {
  let changed = 0;
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [key, v] of Object.entries(node)) {
        if (key === 'contributed_by' && v === from) { out[key] = to; changed += 1; } else out[key] = walk(v);
      }
      return out;
    }
    return node;
  };
  return { value: walk(value), changed };
}

/**
 * The encrypted stamps, through the store that already reads and writes the
 * encrypted context. A guarded save re-reads and retries when it loses a swap.
 * Decrypts every project of the workspace, which is acceptable for a rare action.
 */
async function restampContextStamps(ownerKey, from, to) {
  if (!ownerKey) return 0;
  const projects = await store.listProjects(ownerKey, { system: true, includeArchived: true });
  let total = 0;
  for (const listed of projects) {
    if (!JSON.stringify(listed.context || {}).includes(from)) continue;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const project = attempt === 1 ? listed : await store.getProject(ownerKey, listed.project_id);
      if (!project || project.context?._decrypt_error) break;
      const { value, changed } = restampContextValue(project.context, from, to);
      if (!changed) break;
      const result = await store.saveProject({ ...project, context: value }, null, {
        expectedVersion: Number.isFinite(project.context_version) ? project.context_version : null,
      });
      if (result?.applied !== false) { total += changed; break; }
      if (attempt === 4) throw new Error(`could not re-stamp ${listed.project_id}: other writes kept landing`);
    }
  }
  return total;
}

/**
 * Delete an API key, first re-stamping everything that names it as an author to
 * the person who owns it, so its stamps never become unresolvable.
 *
 * The plain columns and the delete run in ONE transaction, first; the stamps inside
 * the encrypted brief follow, best-effort, through the store. `scanContext: false` is for a key created moments ago that
 * nothing has used (the rollback of a failed hand-off). Returns
 * { deleted, keyHash, restamped }.
 */
async function deleteApiKey({ keyId, orgId = null, scanContext = true }) {
  const found = await q(
    `SELECT key_id, key_hash, owner_id, org_id, oauth_workspace_key FROM api_keys WHERE key_id = $1${orgId ? ' AND org_id = $2' : ''}`,
    orgId ? [keyId, orgId] : [keyId]
  );
  const key = found.rows[0];
  if (!key) return { deleted: false, keyHash: null, restamped: {} };
  const person = key.owner_id || null;
  const restamped = {};

  // THE REVOKE NEVER FAILS BECAUSE OF THE RE-STAMP. The plain columns and the
  // delete go in ONE transaction, first: the key is revoked whatever happens next.
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const exec = (text, params) => client.query(text, params);
    if (person && person !== keyId) Object.assign(restamped, await restampPlainStamps(exec, keyId, person));
    await client.query('DELETE FROM api_keys WHERE key_id = $1', [keyId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Then the stamps inside the encrypted brief, best-effort: retried inside
  // restampContextStamps, a failure is logged and never undoes the delete. What it
  // leaves is found by the history pass or assigned by an owner. (The save keeps the
  // project's updated_at, so the re-stamp does not reset the auto-archive clock.)
  if (person && person !== keyId && scanContext) {
    for (const ownerKey of new Set([key.org_id, key.oauth_workspace_key].filter(Boolean))) {
      try {
        const n = await restampContextStamps(ownerKey, keyId, person);
        if (n) restamped[`context(${ownerKey})`] = n;
      } catch (err) {
        restamped.context_incomplete = true;
        console.warn(`[AUTHORS] key ${keyId} deleted, but the brief stamps in ${ownerKey} were not all re-stamped: ${err.message}`);
      }
    }
  }
  return { deleted: true, keyHash: key.key_hash, restamped };
}

// ─── layer 2: resolve from history ──────────────────────────────────────────

function collectContributors(context) {
  const ids = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object') {
      for (const [key, v] of Object.entries(node)) {
        if (key === 'contributed_by' && typeof v === 'string' && v) ids.add(v);
        else walk(v);
      }
    }
  };
  walk(context || {});
  return ids;
}

/**
 * The one active member who ever WROTE to this PRIVATE project, or null.
 *
 * A write counts only if it was made while the project was PRIVATE: only writes at
 * or after the most recent switch to private count, and when the project has a
 * sharing change on record that cannot be ordered against the writes (no time, an
 * unknown target, an unrecorded change, a write with no time) nothing resolves.
 * The project's creator, alone on record, is the exception.
 *
 * Only content writes count: context_events with a contributor (a structured
 * write, and the project's creation) and `context_write` audit rows, plus the
 * contributed_by stamps inside the brief. A bound session, a read, a listing is
 * not a write, and never counts. Only a private project is resolved: a shared
 * project with an unknown author is not stuck (workspace owners hold its powers),
 * and a personal one is never touched.
 *
 * Null (left for "Assign author") when there is no writer on record, when there
 * are several, when the only writer is not an active member, when any record
 * names somebody who cannot be resolved (an unknown writer is one more writer;
 * the project's own dead stamp is one), and when the sole writer is a workspace
 * OWNER: an owner cannot write a colleague's private project while its author is
 * active, so an owner's writes here prove nothing about who the author was. Never
 * a guess.
 */
async function resolveFromHistory(project) {
  const stamp = project?.owner_user_id;
  const ownerKey = project?.owner_key;
  if (!stamp || !ownerKey || project.visibility !== 'private') return null;

  // Every record of a write, with when it was made where it says.
  const events = (await q(
    'SELECT event_kind, contributing_user_id AS person, created_at FROM context_events WHERE project_id = $1 AND contributing_user_id IS NOT NULL',
    [project.project_id]
  )).rows;
  const audits = (await q(
    'SELECT actor_user_id AS person, created_at FROM context_audit_logs WHERE owner_key = $1 AND project_id = $2 AND action = \'context_write\' AND actor_user_id IS NOT NULL',
    [ownerKey, project.project_id]
  )).rows;
  const untimed = [...collectContributors(project.context)];

  const everyone = new Set([...events.map((e) => e.person), ...audits.map((a) => a.person), ...untimed]);
  if (everyone.has(stamp)) return null; // the project's own dead stamp is somebody we cannot name
  const authors = await workspace.resolveAuthors(ownerKey, [...everyone]);
  // Not an active member's id and not a live key: a person who is gone (a user id)
  // is still a writer; a dead key id is an unknown one, and one more writer.
  const personOf = (id) => authors.personOf(id) || (looksLikeKeyId(id) ? null : id);
  for (const id of everyone) if (personOf(id) === null) return null;

  // WHEN was it private? A write counts only if it was made while the project was
  // PRIVATE, and the sharing changes are on record with their times: the sharing
  // PATCH (sharing_policy_updated) and a move into the workspace (arrives private).
  // No change on record at all: it has always been private, and every write counts.
  const changes = (await q(
    `SELECT created_at, action, metadata FROM context_audit_logs
      WHERE owner_key = $1
        AND ((project_id = $2 AND action = 'sharing_policy_updated')
          OR (action = 'project_moved' AND metadata->>'project_id' = $2))
      ORDER BY created_at ASC`,
    [ownerKey, project.project_id]
  )).rows.map((row) => ({
    at: row.created_at ? new Date(row.created_at).getTime() : NaN,
    to: row.action === 'project_moved' ? 'private' : row.metadata?.visibility || null,
  }));

  let writers;
  // The project's creation, by one person who is also the only person on record at
  // all: strong evidence whatever was done to its sharing afterwards.
  const creators = new Set(events.filter((e) => e.event_kind === 'project_created').map((e) => personOf(e.person)));
  const all = new Set([...everyone].map(personOf));
  if (creators.size === 1 && all.size === 1 && creators.has([...all][0])) {
    writers = all;
  } else if (changes.length === 0) {
    writers = all;
  } else {
    // A change whose time or target we cannot read, or a latest change that is not
    // the switch to private (an unrecorded one happened), or a write with no time
    // (the brief's entries): the writes cannot be ordered against the changes.
    if (changes.some((c) => Number.isNaN(c.at) || !c.to)) return null;
    const last = changes[changes.length - 1];
    if (last.to !== 'private' || untimed.length > 0) return null;
    const since = last.at;
    writers = new Set([...events, ...audits]
      .filter((w) => w.created_at && new Date(w.created_at).getTime() >= since)
      .map((w) => personOf(w.person)));
  }

  if (writers.size !== 1) return null;
  const [only] = writers;
  const members = await workspace.listMembers(ownerKey);
  const member = members.find((m) => m.user_id === only && !m.removed_at);
  // An owner as the only writer proves nothing: an owner cannot write a colleague's
  // private project while its author is active.
  return member && member.role !== 'owner' ? only : null;
}

/** Is this project's stamp a key id that resolves to nobody? */
async function stampIsUnresolvable(project, authors = null) {
  const stamp = project?.owner_user_id;
  if (!stamp || project.visibility === 'personal' || !looksLikeKeyId(stamp)) return false;
  const resolved = authors || await workspace.resolveAuthors(project.owner_key, [stamp]);
  return resolved.personOf(stamp) === null;
}

async function recordAuthorAudit(project, action, metadata) {
  await q(
    `INSERT INTO context_audit_logs (audit_id, owner_key, project_id, action, actor_type, actor_user_id, tool, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [`audit_${require('crypto').randomUUID()}`, project.owner_key, project.project_id, action,
      metadata.by ? 'user' : 'system', metadata.by || null, metadata.by ? 'dashboard' : 'author_backfill', metadata]
  ).catch((err) => console.warn(`[AUTHORS] audit write failed (${action}): ${err.message}`));
}

/**
 * Re-stamp a private project whose stamp is an unresolvable key id to the one
 * person who wrote to it (resolveFromHistory). NEVER called from a read path:
 * authority does not change as a side effect of reading. It runs in the boot pass
 * and when an owner loads the projects-sharing listing. Mutates `project.owner_user_id` when it resolves, so the caller in
 * the middle of a request sees the answer. Returns the person or null.
 */
async function resolveAndRestamp(project, authors = null) {
  if (!(await stampIsUnresolvable(project, authors))) return null;
  const person = await resolveFromHistory(project);
  if (!person) return null;
  const from = project.owner_user_id;
  const r = await q(
    'UPDATE context_projects SET owner_user_id = $3 WHERE project_id = $1 AND owner_key = $2 AND owner_user_id = $4',
    [project.project_id, project.owner_key, person, from]
  );
  if (!r.rowCount) return null;
  project.owner_user_id = person;
  await recordAuthorAudit(project, 'project_author_resolved', { from, to: person, basis: 'single_writer' });
  return person;
}

// ─── layer 3: an owner assigns what is left ─────────────────────────────────

class AuthorAssignError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
    this.publicMessage = message;
  }
}

// context_author_notices is created with the rest of the context schema at boot
// (contextSyncStore.ensureSchema), not here.
const ensureNoticeTable = () => store.ensureSchema();

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));

function noticeSentence(row) {
  const name = row.project_name || row.project_id;
  return row.kind === 'self_assigned'
    ? `${row.actor_label || 'A workspace owner'} took over "${name}" as its author: its author could not be identified, so an owner assigned it.`
    : `${row.actor_label || 'A workspace owner'} made you the author of "${name}", which could not be attributed to anybody. You can manage it now.`;
}

/**
 * A workspace owner assigns a project whose author cannot be identified to one
 * ACTIVE member (themselves allowed). Only for a genuinely unresolvable stamp (a
 * key id that resolves to nobody): never for a project whose author resolves to a
 * person, and never for a personal project. Recorded in the audit log; the
 * assignee is told (in-app, and by email), and when an owner assigns it to
 * themselves the other owners are told. Returns { project_id, from, to }.
 */
async function assignAuthor({ ownerKey, projectId, toPersonId, byPersonId }) {
  const found = await q(
    'SELECT project_id, owner_key, project_name, owner_user_id, visibility FROM context_projects WHERE project_id = $1 AND owner_key = $2',
    [projectId, ownerKey]
  );
  const project = found.rows[0];
  // A personal project answers as though it were not there: it is never touched.
  if (!project || project.visibility === 'personal') throw new AuthorAssignError('project_not_found', 404, 'That project does not exist.');
  if (!(await stampIsUnresolvable(project))) {
    throw new AuthorAssignError('author_known', 409, 'This project\'s author is known, so it cannot be reassigned here.');
  }
  const members = await workspace.listMembers(ownerKey);
  const target = members.find((m) => m.user_id === toPersonId && !m.removed_at);
  if (!target) throw new AuthorAssignError('not_an_active_member', 400, 'Pick somebody who is an active member of this workspace.');
  if (target.role === 'viewer') throw new AuthorAssignError('viewer_cannot_be_author', 400, 'A viewer cannot be a project\'s author. Pick an owner or a member.');

  const from = project.owner_user_id;
  const updated = await q(
    'UPDATE context_projects SET owner_user_id = $3 WHERE project_id = $1 AND owner_key = $2 AND owner_user_id = $4',
    [projectId, ownerKey, toPersonId, from]
  );
  if (!updated.rowCount) throw new AuthorAssignError('author_changed', 409, 'This project\'s author changed while you were choosing. Reload and look again.');
  await recordAuthorAudit(project, 'project_author_assigned', { from, to: toPersonId, by: byPersonId, project_name: project.project_name });

  const actor = members.find((m) => m.user_id === byPersonId);
  const actorLabel = actor?.email || 'A workspace owner';
  const kind = toPersonId === byPersonId ? 'self_assigned' : 'assigned';
  const recipients = kind === 'self_assigned'
    ? members.filter((m) => !m.removed_at && m.role === 'owner' && m.user_id !== byPersonId)
    : [target];
  try {
    await ensureNoticeTable();
    for (const person of recipients) {
      await q(
        `INSERT INTO context_author_notices (notice_id, owner_key, person_id, kind, project_id, project_name, actor_label)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [`notice_${require('crypto').randomUUID()}`, ownerKey, person.user_id, kind, projectId, project.project_name, actorLabel]
      );
      if (person.email) {
        const sentence = noticeSentence({ kind, project_name: project.project_name, project_id: projectId, actor_label: actorLabel });
        require('./email/resendClient').sendEmail({
          to: person.email,
          subject: kind === 'self_assigned' ? 'A workspace owner took over a project' : 'You are now the author of a DeerDawn project',
          html: `<p>${escapeHtml(sentence)}</p><p>Open the project manager in DeerDawn to see it.</p>`,
          emailType: 'author_assigned_notice',
        }).catch((err) => console.warn(`[AUTHORS] notice email failed: ${err.message}`));
      }
    }
  } catch (err) {
    // The assignment stands; a notice that could not be stored never undoes it.
    console.warn(`[AUTHORS] notices for ${projectId} not stored: ${err.message}`);
  }
  return { project_id: projectId, from, to: toPersonId };
}

/** The sentences the person's next brief carries, once. '' when there are none. */
async function takeBriefNotices(ownerKey, personId) {
  if (!ownerKey || !personId) return '';
  try {
    await ensureNoticeTable();
    const r = await q(
      `UPDATE context_author_notices SET brief_seen_at = NOW()
        WHERE owner_key = $1 AND person_id = $2 AND brief_seen_at IS NULL
        RETURNING kind, project_id, project_name, actor_label, created_at`,
      [ownerKey, personId]
    );
    return r.rows.map(noticeSentence).join('\n');
  } catch {
    return '';
  }
}

/** The notices the dashboard has not shown this person yet. */
async function listDashboardNotices(ownerKey, personId) {
  if (!ownerKey || !personId) return [];
  await ensureNoticeTable();
  const r = await q(
    `SELECT notice_id, kind, project_id, project_name, actor_label, created_at
       FROM context_author_notices
      WHERE owner_key = $1 AND person_id = $2 AND dash_seen_at IS NULL
      ORDER BY created_at ASC`,
    [ownerKey, personId]
  );
  return r.rows.map((row) => ({ ...row, message: noticeSentence(row) }));
}

async function markDashboardNoticesSeen(ownerKey, personId, noticeIds = []) {
  if (!ownerKey || !personId) return 0;
  await ensureNoticeTable();
  const r = await q(
    `UPDATE context_author_notices SET dash_seen_at = NOW()
      WHERE owner_key = $1 AND person_id = $2 AND dash_seen_at IS NULL
        AND ($3::text[] IS NULL OR notice_id = ANY($3::text[]))`,
    [ownerKey, personId, noticeIds.length ? noticeIds : null]
  );
  return r.rowCount;
}

// One machine at a time (a session-level advisory lock), batched, never in a
// test process: the same shape as the transport backfill.
const AUTHOR_BACKFILL_LOCK_KEY = 0x44443034; // 'DD04'
let backfillScheduled = false;

async function runAuthorBackfill({ batchSize = 200, pauseMs = 25 } = {}) {
  const lock = await db.pool.connect();
  try {
    const got = await lock.query('SELECT pg_try_advisory_lock($1) AS locked', [AUTHOR_BACKFILL_LOCK_KEY]);
    if (!got.rows[0]?.locked) return { skipped: true };
    try {
      const totals = { scanned: 0, resolved: 0 };
      let cursor = '';
      for (;;) {
        const batch = await q(
          `SELECT project_id, owner_key FROM context_projects p
            WHERE p.project_id > $1 AND p.visibility = 'private' AND p.owner_user_id ~* '^key[-_]'
              AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.key_id = p.owner_user_id)
            ORDER BY p.project_id LIMIT $2`,
          [cursor, batchSize]
        );
        for (const row of batch.rows) {
          totals.scanned += 1;
          try {
            const project = await store.getProject(row.owner_key, row.project_id);
            if (project && await resolveAndRestamp(project)) totals.resolved += 1;
          } catch (err) {
            console.warn(`[AUTHORS] ${row.project_id} not resolved: ${err.message}`);
          }
        }
        if (batch.rows.length < batchSize) break;
        cursor = batch.rows[batch.rows.length - 1].project_id;
        if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
      }
      console.log(`[AUTHORS] author backfill finished: scanned=${totals.scanned}, resolved=${totals.resolved}`);
      return totals;
    } finally {
      await lock.query('SELECT pg_advisory_unlock($1)', [AUTHOR_BACKFILL_LOCK_KEY]).catch(() => {});
    }
  } finally {
    lock.release();
  }
}

/** Once, after boot. Never in a test process; DEERDAWN_AUTHOR_BACKFILL_DISABLE=1 turns it off. */
function scheduleAuthorBackfill(delayMs = 60_000) {
  if (backfillScheduled) return;
  if (process.env.NODE_ENV === 'test' || process.env.DEERDAWN_AUTHOR_BACKFILL_DISABLE === '1') return;
  backfillScheduled = true;
  const timer = setTimeout(() => {
    runAuthorBackfill().catch((err) => console.warn('[AUTHORS] author backfill stopped:', err.message));
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
}

module.exports = {
  AuthorAssignError,
  assignAuthor,
  takeBriefNotices,
  listDashboardNotices,
  markDashboardNoticesSeen,
  looksLikeKeyId,
  deleteApiKey,
  restampPlainStamps,
  restampContextStamps,
  resolveFromHistory,
  stampIsUnresolvable,
  resolveAndRestamp,
  recordAuthorAudit,
  runAuthorBackfill,
  scheduleAuthorBackfill,
};
