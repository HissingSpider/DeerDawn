const crypto = require('crypto');
const store = require('../store/contextSyncStore');
const { sendAutoArchiveNotices } = require('../services/email/autoArchiveNotice');

// A project that hasn't been touched in this many days drops off the dashboard.
// "Touched" means written to, opened in a live session, OR delivered as a brief
// (see store.listProjectsInactiveSince): a project somebody reads every day and
// never edits is in use.
// Soft-archive only: archived_at is set, nothing is deleted, and the user can
// restore it at any time (unarchiveProject / POST /projects/:id/archive), which
// also stamps updated_at and so grants a fresh window.
const DEFAULT_INACTIVE_DAYS = 30;

// Bound the nightly sweep. Anything past the cap is picked up on the next run,
// so a large backlog drains over a few nights instead of one long transaction.
const DEFAULT_BATCH_LIMIT = 500;

function readPositiveInt(raw, fallback) {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function inactiveDays(env = process.env) {
  return readPositiveInt(env.PROJECT_AUTO_ARCHIVE_DAYS, DEFAULT_INACTIVE_DAYS);
}

function batchLimit(env = process.env) {
  return readPositiveInt(env.PROJECT_AUTO_ARCHIVE_BATCH, DEFAULT_BATCH_LIMIT);
}

// Opt-out switch, default ON.
//
// This shipped dormant at first: archived projects are filtered out of
// listProjects and getSubprojects, so a user whose projects all aged out would
// have come back to a bare "no DeerDawn context yet" — their memory intact but
// invisible, which is the exact "your AI forgot everything" experience this
// product exists to prevent.
//
// That gap is now closed. Both start_session paths (remote mcp.js and the local
// MCP server) check for archived projects before declaring an empty workspace
// and return formatArchivedProjectsNotice instead: the project is named, said to
// be archived rather than gone, and paired with the manage_projects restore
// call. So the sweep can run by default — a stale board cleans itself up, and a
// returning user is told exactly how to get their project back.
function isEnabled(env = process.env) {
  return String(env.PROJECT_AUTO_ARCHIVE_ENABLED ?? 'true').toLowerCase() !== 'false';
}

// WHAT THIS JOB MAY SAY ABOUT A PROJECT, AND TO WHOM.
//
// The event written below is a system event with no author, recorded against the
// workspace. The manual archive path writes the project's name into the same
// field, and there it is harmless: the person archiving it can obviously see it.
// This job has no such person. It sweeps EVERY project of EVERY owner, including
// the `personal` ones that nobody but their author may read ("not even a
// workspace owner") and the `private` ones the team cannot. Copying a project's
// name out of the access-controlled project row into an event is how "Offer
// negotiation - Acme" or "Performance review: <colleague>" ends up somewhere
// that is filtered by workspace rather than by project visibility.
//
// A name is only ever attached for a project the whole workspace can already
// see. Nothing is lost for the rest: the event is keyed by project_id, so any
// reader entitled to the project resolves the name from the project itself,
// through the same visibility check as everything else, and a reader who is not
// entitled to it learns nothing. Unknown or missing visibility is treated as
// not shared.
function nameForFeed(candidate) {
  return candidate && candidate.visibility === 'shared'
    ? { project_name: candidate.project_name }
    : {};
}

/**
 * Soft-archive every project with no activity for `inactiveDays`.
 *
 * Non-destructive and reversible by construction: this only ever writes
 * archived_at. Archived projects drop out of listProjects, stop auto-resolving
 * as the active project, and free their plan slot (countTopLevelProjects skips
 * them) — but the context, events, and graph nodes are all left untouched.
 */
async function runAutoArchive({ env = process.env, now = new Date() } = {}) {
  if (!isEnabled(env)) {
    return { skipped: 'disabled', archived: 0, candidates: 0 };
  }

  const days = inactiveDays(env);
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const candidates = await store.listProjectsInactiveSince(cutoff, batchLimit(env));
  if (!candidates.length) return { archived: 0, candidates: 0, cutoff, inactive_days: days };

  const archivedAt = now.toISOString();
  let archived = 0;
  const archivedRows = [];

  for (const candidate of candidates) {
    try {
      const updated = await store.setProjectArchived(candidate.owner_key, candidate.project_id, archivedAt);
      if (!updated) continue;
      archived += 1;
      archivedRows.push(candidate);
      // Same event kind the manual path records, with auto_archived so the
      // activity feed can tell "I archived this" from "it aged out".
      await store.appendEvent({
        event_id: `evt_${crypto.randomUUID()}`,
        project_id: candidate.project_id,
        source_type: 'system',
        source_id: 'auto-archive-job',
        event_kind: 'project_archived',
        delta: {
          summary: `Auto-archived after ${days} days without activity`,
          metadata: {
            ...nameForFeed(candidate),
            auto_archived: true,
            inactive_days: days,
            last_active_at: candidate.updated_at,
          },
        },
        confidence: 1,
        contributing_user_id: null,
        created_at: archivedAt,
      });
    } catch (err) {
      // One bad row must not abort the sweep — the rest still archive, and this
      // one is retried on the next run.
      console.error(`[JOB] Auto-archive failed for ${candidate.project_id}:`, err.message);
    }
  }

  console.log(`[JOB] Auto-archive: ${archived}/${candidates.length} projects idle >${days}d`);

  // ONE EMAIL WHEN IT HAPPENS, to the people who may read what was archived
  // (services/email/autoArchiveNotice.js). Best-effort and AFTER the archive:
  // the sweep is done and correct whether or not anybody could be told.
  if (archivedRows.length) {
    await sendAutoArchiveNotices(archivedRows, { archivedAt, days })
      .catch((err) => console.error('[JOB] Auto-archive notice failed:', err.message));
  }
  return { archived, candidates: candidates.length, cutoff, inactive_days: days };
}

module.exports = {
  runAutoArchive,
  inactiveDays,
  batchLimit,
  isEnabled,
  DEFAULT_INACTIVE_DAYS,
  DEFAULT_BATCH_LIMIT,
};
