// ─── Brief stash: carrying level-0 work through signup ──────────────────────
//
// The level-0 tool (/tools/context-preview) runs on deerdawn.com with no
// account. Signup redirects to app.deerdawn.com. Those are different origins,
// so sessionStorage cannot carry the briefs across — and the briefs themselves
// are kilobytes, far too big for the query string that already carries
// attribution through the same handoff.
//
// So the anonymous side POSTs its briefs here and gets a short opaque token.
// The token rides in the redirect URL, and the authenticated side claims it
// once, turning each stashed brief into a real project.
//
// WHY REDIS AND NOT A TABLE. A stash is worthless ten minutes after it is made
// and there is no reason to keep one: the claim happens during a single signup,
// or never. A TTL expresses that exactly, and it needs no migration.
//
// WHY THE CLAIM READS BACK. This module is on the wrong side of a well-known
// trap in this codebase: a write path that reports success while doing nothing.
// A stash can legitimately be absent (expired, evicted, already claimed, or a
// forged token), and the temptation is to treat "nothing to do" as success
// because the user did get their account. It is not success — the thing they
// were promised did not happen. claimStash returns only projects it actually
// created and re-reads each one, and reports a missing stash as a distinct
// outcome rather than an empty win.

const crypto = require('crypto');

// Lazily required for the same reason as repoBriefService: importing the shared
// Redis client at module load leaves reconnect timers on the event loop, which
// makes any unit test of the pure helpers here hang instead of exiting.
let redisClient = null;
function getRedis() {
  if (!redisClient) redisClient = require('../config/redis').redis;
  return redisClient;
}

function getService() {
  return require('./contextSyncService');
}

const STASH_PREFIX = 'brief-stash:v1:';

// One hour. Long enough for a signup that detours through email verification or
// an OAuth account switch, short enough that an abandoned stash costs nothing.
const STASH_TTL_SECONDS = 60 * 60;

// A stash is one sitting at the level-0 tool, which caps itself at 4 projects.
// The extra headroom is for a future import step, not for bulk upload.
const MAX_BRIEFS = 10;

// The fields updateProjectContext refuses as a WHOLE VALUE, as opposed to the
// list fields it filters entry by entry. Only the former mean "this field did
// not land", which is the difference the claim count has to respect.
const WHOLE_VALUE_FIELDS = new Set(['description', 'current_status', 'current_task', 'blocking_issue', 'task_progress']);

class StashError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * Turn the level-0 tool's label into something createProject will accept.
 *
 * Repo briefs are labelled "owner/repo", and a slash makes the project-name
 * guard read the value as a file path and reject it. Paste briefs are labelled
 * with a slice of the description, which can be any shape at all.
 */
function projectNameFromLabel(label, index) {
  const raw = String(label || '').trim();

  // "owner/repo" -> "repo". Anything else containing a slash gets it flattened
  // rather than truncated, so a description that happens to contain one keeps
  // its words.
  const segments = raw.split('/').filter(Boolean);
  let name = segments.length === 2 && !raw.includes(' ') ? segments[1] : raw.replace(/[/\\]+/g, ' ');

  name = name.replace(/\s+/g, ' ').trim().slice(0, 60);

  // createProject rejects names under 2 characters outright; fall back rather
  // than throw, because losing one brief should not fail the whole claim.
  if (name.length < 2) name = `Imported project ${index + 1}`;
  return name;
}

/** The subset of a stashed brief that maps onto project context. */
function contextPatchFromFields(fields) {
  const patch = {};
  if (typeof fields?.description === 'string' && fields.description.trim()) patch.description = fields.description.trim();
  if (typeof fields?.current_task === 'string' && fields.current_task.trim()) patch.current_task = fields.current_task.trim();
  if (typeof fields?.current_status === 'string' && fields.current_status.trim()) patch.current_status = fields.current_status.trim();
  if (typeof fields?.blocking_issue === 'string' && fields.blocking_issue.trim()) patch.blocking_issue = fields.blocking_issue.trim();
  if (Array.isArray(fields?.tech_stack) && fields.tech_stack.length) {
    patch.tech_stack = fields.tech_stack.map((t) => String(t)).filter(Boolean).slice(0, 20);
  }
  if (Array.isArray(fields?.open_questions) && fields.open_questions.length) {
    patch.open_questions = fields.open_questions.map((q) => String(q)).filter(Boolean).slice(0, 20);
  }
  if (Array.isArray(fields?.recent_decisions) && fields.recent_decisions.length) {
    patch.recent_decisions = fields.recent_decisions
      .map((d) => (typeof d === 'string' ? { summary: d } : d))
      .filter((d) => d && typeof d.summary === 'string' && d.summary.trim())
      .map((d) => ({ summary: d.summary.trim(), decided_at: d.decided_at || new Date().toISOString() }))
      .slice(0, 20);
  }
  return patch;
}

/**
 * Store a set of anonymous briefs and return the token that claims them.
 * Called from the PUBLIC route, so it validates shape defensively.
 */
async function createStash(briefs) {
  if (!Array.isArray(briefs) || briefs.length === 0) {
    throw new StashError('stash_empty', 400);
  }
  if (briefs.length > MAX_BRIEFS) {
    throw new StashError('stash_too_large', 400);
  }

  const normalized = briefs.map((brief) => ({
    label: String(brief?.label || '').slice(0, 200),
    fields: brief?.fields && typeof brief.fields === 'object' ? brief.fields : {},
    source: brief?.source && typeof brief.source === 'object'
      ? { owner: String(brief.source.owner || ''), repo: String(brief.source.repo || '') }
      : null,
  }));

  const token = crypto.randomBytes(24).toString('base64url');
  const payload = JSON.stringify({ briefs: normalized, created_at: new Date().toISOString() });

  // A stash that cannot be stored must not hand back a token — the token would
  // become a promise the claim step cannot keep.
  await getRedis().set(`${STASH_PREFIX}${token}`, payload, 'EX', STASH_TTL_SECONDS);

  return { token, count: normalized.length };
}

async function readStash(token) {
  if (!token || typeof token !== 'string') return null;
  let raw;
  try {
    raw = await getRedis().get(`${STASH_PREFIX}${token}`);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Turn a stash into real projects for an authenticated actor.
 *
 * Returns { claimed: [...], failed: [...] }. A stash that is gone throws
 * stash_not_found rather than returning an empty success — see the note at the
 * top of this file.
 */
async function claimStash(actor, token) {
  const stash = await readStash(token);
  if (!stash || !Array.isArray(stash.briefs) || stash.briefs.length === 0) {
    throw new StashError('stash_not_found', 410);
  }

  const service = getService();
  const claimed = [];
  const failed = [];

  for (let i = 0; i < stash.briefs.length; i += 1) {
    const brief = stash.briefs[i];
    const projectName = projectNameFromLabel(brief.label, i);
    try {
      const created = await service.createProject(actor, {
        project_name: projectName,
        // These come from an anonymous tool where two repos can share a name,
        // and a duplicate-name rejection should not lose the brief.
        allow_fallback_name: true,
      });
      const projectId = created?.project_id || created?.id;
      if (!projectId) throw new Error('project_id_missing');

      const patch = contextPatchFromFields(brief.fields);
      let refused = [];
      if (Object.keys(patch).length > 0) {
        const patched = await service.updateProjectContext(actor, projectId, patch);
        refused = Array.isArray(patched?.refused) ? patched.refused : [];
      }

      // Read back. The whole point of this module is to not report a project
      // that is not there.
      const verified = await service.getProject(actor, projectId);
      if (!verified) throw new Error('project_not_readable_after_create');

      claimed.push({
        project_id: projectId,
        project_name: verified.project_name || projectName,
        // COUNTED FROM WHAT LANDED, not from what was sent. The server refuses
        // a field rather than blanking it and names it in `refused`; counting
        // the request keys reported a brief as fully claimed over one the
        // server had declined part of.
        //
        // Only the WHOLE-VALUE refusals are subtracted. A list field named in
        // `refused` lost some entries and was still applied, so counting it as
        // unapplied would trade one wrong number for another.
        fields_applied: Object.keys(patch).length
          - refused.filter((item) => WHOLE_VALUE_FIELDS.has(item.field)).length,
        ...(refused.length ? { refused } : {}),
      });
    } catch (err) {
      failed.push({ label: brief.label, reason: err?.message || 'unknown' });
    }
  }

  // Delete only after the work is done, so a crash mid-claim leaves the stash
  // claimable rather than silently consumed. A partial re-claim creating a
  // duplicate project is a far better failure than losing the briefs.
  if (claimed.length > 0) {
    try {
      await getRedis().del(`${STASH_PREFIX}${token}`);
    } catch {
      // The TTL will collect it.
    }
  }

  return { claimed, failed };
}

module.exports = {
  createStash,
  claimStash,
  readStash,
  StashError,
  // exported for tests
  projectNameFromLabel,
  contextPatchFromFields,
  MAX_BRIEFS,
};
