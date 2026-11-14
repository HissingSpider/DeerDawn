const crypto = require('crypto');
const { reportSwallowed } = require('../utils/reportSwallowed');
const { z } = require('zod');
const productEventsService = require('./productEventsService');
const workspace = require('./workspaceService');
const authorStamps = require('./authorStampService');
const folderRule = require('./folderRule');
const connectionIdentity = require('./connectionIdentity');
const { redactSecrets, secretSafeKey } = require('../utils/secretRedaction');
const { safeGet } = require('../utils/safeHttp');
const { dedupeKey,
  normalizeText,
  jaccardSimilarity,
  isGenericText,
  isVagueDecision,
  sanitizeProjectName,
  isValidProjectName,
  isTooShortProjectName,
  MIN_PROJECT_NAME_LENGTH,
} = require('./contextQualityGuards');
const {
  createContextObject,
  mergeContextObject,
  capDecisions,
  decisionHeadline,
  formatConversationalInjection,
  formatCodeInjection,
  formatBriefInjection,
  formatSubagentBrief,
  formatGlobalOnlyInjection,
  formatWorkspaceOverview,
  buildBriefSpine,
  ContextObjectSchema,
  ContextSessionSchema,
  GlobalContextSchema,
  InjectionPreferenceSchema,
  NextBestContextResultSchema,
  SubagentBriefRequestSchema,
  ProjectMatchResultSchema,
  WorkspaceOverviewResultSchema,
  inferSurfaceType,
  timeAgo,
  parseSkillFrontmatter,
  GRAPH_NODE_TYPE_VALUES,
  PRESENCE_WINDOW_SECONDS,
  holdState,
  partitionHeldCards,
  formatExcludedLine,
  normalizeTaskCardInputs,
  debuggingNoteKey,
  DEBUGGING_NOTE_LIMIT,
  // The MERGE's normalizer (dedupe + look-alike collapse + cap), not the
  // shape-only normalizeDebuggingNotes this file defines for PATCH input.
  normalizeDebuggingNotes: mergeNormalizeDebuggingNotes,
  nextBlockerSetAt,
  DebuggingNoteEntrySchema,
  proseBudget,
} = require('../../../../packages/shared-context/src/index.js');
const { taskReviewItems, planReviewedCompletion, followBoardCardsInShipped } = require('../../../../packages/shared-context/src/index.js');
const { formatBriefReceipt, briefReceiptInputs } = require('../../../../packages/shared-context/src/briefReceipt.js');
const { getToolProfile } = require('../../../../packages/tool-adapters/src/index.js');
const store = require('../store/contextSyncStore');
const { pickSummaryContext } = require('../serializers/contextProject');
const graphService = require('./contextGraphService');
const crossProjectService = require('./crossProjectService');
const embeddings = require('./contextGraphEmbeddingService');
const { getEntitlements, getEntitlementsForExistingOrg } = require('./entitlementService');
const { getPlanOrder, PLANS } = require('../config/plans');
const injectionHistory = new Map();
// Briefs older than this are flagged "context may be stale" in the trust banner.
const STALE_CONTEXT_MS = Number(process.env.DEERDAWN_STALE_CONTEXT_MS) || 3 * 24 * 60 * 60 * 1000;
// Beyond the hard threshold, staleness stops being a passive note: volatile
// fields (task, next action, blocker) are declared UNVERIFIED in-band and the
// payload is flagged requires_refresh so a surface can force a refresh instead
// of silently presenting old context as fact.
const HARD_STALE_CONTEXT_MS = Number(process.env.DEERDAWN_HARD_STALE_CONTEXT_MS) || STALE_CONTEXT_MS * 3;
// Pre-write confidence gate: below this floor the LLM extraction is not trusted
// enough to mutate the durable vault. Enforced at write time in sanitizeExtraction
// so low-confidence noise never lands — distinct from the reactive vault cleanup
// that only scrubs junk AFTER it has already degraded search and injection.
const WRITE_CONFIDENCE_FLOOR = Number(process.env.DEERDAWN_WRITE_CONFIDENCE_FLOOR) || 0.6;

// Pure staleness classifier — exported for testing. 'fresh' below the soft
// threshold, 'soft' past it, 'hard' past the hard threshold. 'unknown' when we
// have no timestamp (treated as not-stale so we don't nag on brand-new context).
function classifyStaleness(updatedAt, now = Date.now()) {
  if (!updatedAt) return { tier: 'unknown', ageMs: 0 };
  const ageMs = now - new Date(updatedAt).getTime();
  if (ageMs > HARD_STALE_CONTEXT_MS) return { tier: 'hard', ageMs };
  if (ageMs > STALE_CONTEXT_MS) return { tier: 'soft', ageMs };
  return { tier: 'fresh', ageMs };
}
const commandCapturePlanCache = new Map();

// Evict fingerprints older than 5 minutes every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [key, val] of injectionHistory.entries()) {
    if ((val.ts ?? 0) < cutoff) injectionHistory.delete(key);
  }
}, 10 * 60 * 1000).unref();

setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [orgId, entry] of commandCapturePlanCache.entries()) {
    if ((entry.checked_at ?? 0) < cutoff) commandCapturePlanCache.delete(orgId);
  }
}, 10 * 60 * 1000).unref();

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function isoNow() {
  return new Date().toISOString();
}

function defaultPreferences() {
  return InjectionPreferenceSchema.parse({
    paused: false,
    tools: {
      claude_web:  { enabled: true, verbosity: 'light' },
      chatgpt_web: { enabled: true, verbosity: 'light' },
      cursor:      { enabled: true, verbosity: 'light' },
      claude_code: { enabled: true, verbosity: 'light' },
      codex:       { enabled: true, verbosity: 'light' },
    },
  });
}

// The workspace this actor is operating in, for the single-workspace case.
//
// This is deliberately still synchronous and still the same expression it always
// was — the value is unchanged. What changed is that it is now defined in ONE
// place (workspaceService.defaultOwnerKey) instead of forty, and that any request
// naming a DIFFERENT workspace must go through workspaceService.resolveOwnerKey,
// which checks membership and refuses rather than silently serving the caller
// their own data.
function getActorKey(actor) {
  return workspace.defaultOwnerKey(actor) || 'org-system';
}

// Entitlements for the acting owner (org for org actors, personal org for user
// actors). Fail-open (null = no plan gates applied) — both on lookup errors AND
// when no org row exists (system/dev actors): a hiccup or an unbilled actor
// must never block a sync path or degrade a brief as if they were a free
// customer. Real customers always have an org row, so their tier's gates apply.
async function getOwnerEntitlements(actor) {
  // The WORKSPACE pays, not the person. `actor.org_id || ...` short-circuited
  // before the workspace was consulted, so an invited teammate whose own account
  // is on Free got Free's limits — the 90-day window, the skill cap — while
  // working inside a workspace their employer pays for. getActorKey prefers the
  // bound workspace and falls back to exactly what this used to return.
  const ownerKey = getActorKey(actor);
  // 'org-system' is the internal fallback actor (jobs, migrations, system
  // writes) — never a billable customer, so plan gates don't apply to it.
  if (ownerKey === 'org-system') return null;
  return getEntitlementsForExistingOrg(ownerKey).catch(() => null);
}

// Free's memory window: entries with timestamps older than `days` are dropped
// from the BRIEF (never from storage) and counted, so the brief itself can say
// what it forgot — the aged-out line is the upgrade surface, felt at exactly
// the moment memory is lost. Only timestamped lists are windowed; identity
// fields (goals, stack, current task) never age out. A null/undefined `days`
// (every paid tier) means remember everything and return the context untouched.
function applyHistoryWindow(context, days) {
  const windowDays = Number(days);
  if (!context || !Number.isFinite(windowDays) || windowDays <= 0) {
    return { context, agedOut: 0, days: null };
  }
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  let agedOut = 0;
  const windowList = (list, tsField) => {
    if (!Array.isArray(list) || list.length === 0) return list;
    const kept = list.filter((item) => {
      const ts = Date.parse(item?.[tsField] || '');
      if (Number.isFinite(ts) && ts < cutoff) {
        agedOut += 1;
        return false;
      }
      // Undated entries never age out — windowing only ever removes entries we
      // can prove are older than the plan's memory.
      return true;
    });
    return kept.length === list.length ? list : kept;
  };
  const windowed = {
    ...context,
    recent_decisions: windowList(context.recent_decisions, 'decided_at'),
    debugging_notes: windowList(context.debugging_notes, 'added_at'),
    shipped: windowList(context.shipped, 'shipped_at'),
  };
  return { context: agedOut > 0 ? windowed : context, agedOut, days: windowDays };
}

// The same window, for the reads that do not go through renderInjection. The
// section read (recall action=context) renders straight off the stored context,
// so it served a Free account decisions that its own brief had aged out — two
// reads of one project disagreeing about what the plan remembers. One rule, one
// helper, and the same fail-open: no entitlements means no window.
async function applyPlanHistoryWindow(actor, context) {
  const entitlements = await getOwnerEntitlements(actor).catch(() => null);
  return applyHistoryWindow(context, entitlements?.limits?.history_days);
}

// One sentence for every read. Two surfaces telling a customer different things
// about the same window is the failure this helper exists to stop, and a second
// hand-written copy is how that starts.
function formatAgedOutLine(historyWindow) {
  if (!historyWindow || !(historyWindow.agedOut > 0)) return null;
  const one = historyWindow.agedOut === 1;
  return `${historyWindow.agedOut} older ${one ? 'entry is' : 'entries are'} outside this plan's ${historyWindow.days}-day history window and ${one ? 'is' : 'are'} not included above. Nothing has been deleted.`;
}

// The sections that sentence can be TRUE of. applyHistoryWindow touches
// recent_decisions, debugging_notes and shipped and nothing else, so on a
// section read of the task and the stack there is nothing "above" that could
// have been windowed: the caller goes looking for a loss that did not happen on
// this read, and an upgrade surface shown on every read stops meaning anything.
//
// Every spelling a caller may send, because the alias table lives in
// shared-context's formatter and a read must not have to render to find out
// whether the sentence applies.
const HISTORY_WINDOWED_SECTIONS = new Set([
  'all',
  'decisions', 'decision', 'recent_decisions',
  'debugging_notes', 'notes', 'debug_notes',
  'shipped',
]);

function sectionsTouchHistoryWindow(sections = []) {
  return (Array.isArray(sections) ? sections : [])
    .some((section) => HISTORY_WINDOWED_SECTIONS.has(String(section || '').trim().toLowerCase()));
}

async function canCaptureCommandsForActor(actor) {
  // Same rule as getOwnerEntitlements: gated by the workspace being worked in.
  // defaultOwnerKey (not getActorKey) so a missing workspace stays falsy and the
  // guard below still refuses rather than resolving to the system fallback.
  const orgId = workspace.defaultOwnerKey(actor);
  if (!orgId) return false;

  const cached = commandCapturePlanCache.get(orgId);
  if (cached && (Date.now() - cached.checked_at) < 5 * 60 * 1000) {
    return cached.allowed;
  }

  try {
    const entitlements = await getEntitlements(orgId);
    const tier = String(entitlements?.tier || 'free');
    const allowed = getPlanOrder(tier) >= getPlanOrder('developer_basic');
    commandCapturePlanCache.set(orgId, { allowed, checked_at: Date.now() });
    return allowed;
  } catch {
    return false;
  }
}

const SHAREABLE_SECTIONS = [
  'description',
  'current_task',
  'current_status',
  'goals',
  'open_questions',
  'recent_decisions',
  'tech_stack',
  'file_structure_summary',
  'blocking_issue',
  'task_progress',
  'recurring_context',
  'source_summary',
  'hot_paths',
  'entrypoints',
  'surfaces',
  'debugging_notes',
  'landmines',
  'shipped',
  // THE BOARD IS A SECTION LIKE ANY OTHER.
  //
  // It was absent from this list, which is not "the board is private" — it is
  // "the board has no sharing at all". A shared project's board was invisible to
  // the very teammates the project was shared WITH (filterContextBySectionPolicy
  // drops any key not listed here), and unwritable by them too, since the write
  // gate refuses every field outside this list: a member adding a card got
  // share_write_forbidden on a project they were invited into.
  //
  // One section key, two stored fields — see sectionFieldsForSection. Done
  // cards live in completed_todos and are the same board; governing them with a
  // second switch would be the "two controls that must agree" arrangement
  // CLAUDE.md already names as the bug that made the privacy toggle enforce
  // nothing. Sharing still has ONE switch (context_projects.visibility); this
  // only lets the existing section policy narrow the board like anything else.
  'todo_items',
];

// The board is in the DEFAULTS because a shared project's whole point is that
// the workspace can pick the work up, and the work is the board. A project
// shared with no explicit section rows shares its board.
//
// ─── WHAT A DEFAULT MEANS, AND WHAT IT NEVER DOES ────────────────────────────
//
// This list is read at request time, so changing it changes what every share
// WITHOUT stored rows travels — including shares created years ago. That is the
// intent, and it is why two projects shared on the same day can now behave
// differently. The asymmetry is deliberate:
//
//   - NO share rows  -> today's defaults, whatever this list says today. The
//     author never answered the question, so the product's current answer
//     stands.
//   - EXPLICIT rows  -> exactly what the author chose. A section added to this
//     list later is NEVER backfilled onto a stored configuration; doing so would
//     publish somebody's board by release note, over a decision they made.
//     resolveShareInfo enforces this (hasConfiguredRows wins over the defaults,
//     right down to an empty list).
//
// So a new default reaches unconfigured shares immediately and configured ones
// never. The author of a configured share is not stuck with the old list: every
// key here is in SHAREABLE_SECTIONS and the dashboard's sharing panel offers it
// as a section they can tick — see shareSections.ts, which pins the board.
const DEFAULT_SHARED_SECTIONS = ['current_task', 'current_status', 'recent_decisions', 'todo_items'];

/**
 * The defaults written out as SHARE ROWS — what an unconfigured share is already
 * granting, in the form that stores it.
 *
 * There is one right answer here and it is not a matter of taste:
 * canEditSectionForActor's no-row fallback is
 * `DEFAULT_SHARED_SECTIONS.includes(sectionKey)`, so on a project with no stored
 * rows every default section is READABLE AND WRITABLE. Any code that turns that
 * same state into rows and writes anything less has silently taken a permission
 * away — which is precisely what the sharing panel's first save did to
 * `recent_decisions`, from a screen that showed the section ticked and offered
 * no way to grant the write back.
 *
 * Exported so the route that writes the defaults and the gate that interprets
 * them cannot disagree about what a default means.
 */
function defaultShareSectionRows() {
  return DEFAULT_SHARED_SECTIONS.map((section_key) => ({ section_key, can_view: true, can_edit: true }));
}
// Who may write a section of somebody else's shared project. Stated in the
// three-role vocabulary; the legacy names ('admin', 'operator') still map onto
// these through workspaceService.normalizeRole, so an un-migrated row keeps
// working and cannot grant more than it did.
const ROLE_EDIT_ALLOW = new Set(['owner', 'member']);

// The share-policy section a context FIELD belongs to. One-to-one except for the
// board: `completed_todos` is the Done column of the same board as `todo_items`,
// so both answer to the one `todo_items` section. Mapped rather than listed
// separately because a Done column governed by its own switch could be shared
// while the board it belongs to was not.
const FIELD_SECTION_OVERRIDES = {
  completed_todos: 'todo_items',
  // The task's provenance travels with the task. Left unmapped, each would be
  // its own (unshareable) section, and a teammate setting the task on a shared
  // project would be refused for the stamp the server itself added.
  current_task_source: 'current_task',
  current_task_set_at: 'current_task',
  // Same for the blocker's server stamp: it travels with (and only with) the
  // blocker it dates.
  blocking_issue_set_at: 'blocking_issue',
};

function mapSectionFromField(field) {
  return FIELD_SECTION_OVERRIDES[field] || field;
}

// The inverse of mapSectionFromField: which context FIELDS one share-policy
// section governs. A function, not a second inline list, so the read filter and
// the write gate cannot drift into disagreeing about the mapping.
function sectionFieldsForSection(section) {
  const extra = Object.keys(FIELD_SECTION_OVERRIDES).filter((field) => FIELD_SECTION_OVERRIDES[field] === section);
  return [section, ...extra];
}

// A section-filtered context is a READ view: every key outside the share policy
// is absent, and persisting it writes those sections back as empty. That is how
// one teammate's status update erased the owner's description, goals and hot
// paths while reporting success. Write paths load the raw row instead (see
// loadProjectForWrite); this marker is the backstop, so a future write path that
// loads through getProject fails loudly in saveProject / repairProjectIntegrity
// rather than wiping. A registered Symbol, non-enumerable: invisible to JSON,
// to serializers and to Object.keys, and shared with the store without an import.
const SECTION_FILTERED = Symbol.for('deerdawn.context.sectionFiltered');

function isSectionFilteredContext(context) {
  return Boolean(context && context[SECTION_FILTERED]);
}

// Does this section hold anything a reader would have seen?
//
// Only used to decide whether a WITHHELD section is worth naming. A section
// nobody ever wrote is genuinely empty for everybody, and announcing it as
// withheld would invent a secret that does not exist.
function sectionHasContent(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

// WITHHELD IS NOT EMPTY, and only this function can still tell the difference.
//
// The filtered view drops a section by making its key ABSENT, and absence is
// exactly what "nobody has written this yet" looks like to every renderer
// downstream. So a teammate reading a narrowly-shared project was shown "No
// brief captured yet" / "No tasks on the board yet" over a project full of
// work — and the obvious response to a blank brief is to type it all in again,
// which is how a privacy control turns into duplicated (and diverging) history.
//
// `withheld_sections` names the sections, never their values: it says "this
// exists and is not yours to read", which is the honest answer and leaks
// nothing. It is ENUMERABLE on purpose — unlike SECTION_FILTERED, which is a
// server-side write backstop that JSON cannot carry — because the renderers
// that need it are in packages/shared-context and the dashboard, on the far
// side of a JSON boundary. Its presence is also how a consumer tells a filtered
// view from the raw row: the owner's context never carries the key at all.
function withheldSectionsFor(context = {}, allowed = new Set()) {
  return SHAREABLE_SECTIONS.filter(
    (section) => !allowed.has(section)
      && sectionFieldsForSection(section).some((field) => sectionHasContent(context[field]))
  );
}

function filterContextBySectionPolicy(context = {}, allowedSections = []) {
  const allowed = new Set(allowedSections);
  const filtered = {};
  for (const section of allowed) {
    for (const field of sectionFieldsForSection(section)) {
      if (context[field] !== undefined) filtered[field] = context[field];
    }
  }
  filtered.project_name = context.project_name || filtered.project_name;
  filtered.last_updated = context.last_updated || filtered.last_updated;
  filtered.withheld_sections = withheldSectionsFor(context, allowed);
  Object.defineProperty(filtered, SECTION_FILTERED, { value: true, enumerable: false });
  return filtered;
}

// The sections a shared project's policy lets a teammate READ, from the stored
// share row and section rows. Pure, and the ONLY place this is decided: the
// per-project policy below and the graph filter (graphScopeForActor) both call
// it, so the brief and the knowledge graph cannot disagree about what travels.
function shareSectionsFromInfo(project, info = {}) {
  const share = info.share || null;
  // VISIBILITY IS THE SWITCH. The share row only NARROWS which sections travel.
  //
  // This used to require both to agree — `share.enabled && visibility ===
  // 'shared'` — so a project marked shared with no share row was silently not
  // shared, and no screen said why. Two controls that must agree, where one is
  // invisible, is the same arrangement that produced a privacy toggle enforcing
  // nothing; it just failed in the safe direction instead of the unsafe one.
  //
  // Absent row now means "shared, default sections". An explicit row can still
  // switch it off (enabled === false) or restrict the section list.
  const enabled = project.visibility === 'shared' && (share ? share.enabled !== false : true);
  // can_view GOVERNS, rather than being decoration on a row that exists.
  //
  // This mapped every configured row's section_key regardless of the flag, so a
  // row saying `can_view: false` still put its section in the list that travels
  // to the reader: the switch an author flips to withhold one section enforced
  // nothing, exactly like the project-level toggle before it. A row is a
  // narrowing, and a row with viewing off narrows it to nothing.
  //
  // Withholding the READ also withholds the write, because policy.sections is
  // the precondition in canEditSectionForActor: editing a section you cannot
  // read means merging into content you cannot see, which is how a writer
  // destroys what they never knew was there — the member-write wipe again,
  // wearing a permission flag. An author who wants a teammate to contribute to a
  // section shares it with them.
  const configuredSections = (info.sections || [])
    .filter((row) => row.can_view !== false)
    .map((row) => row.section_key)
    .filter(Boolean);
  // A share narrowed to nothing but unshared sections is still a CONFIGURED
  // share: it must fall through to an empty list, not to the defaults, or
  // hiding every section would publish all of them.
  const hasConfiguredRows = (info.sections || []).length > 0;
  const sections = enabled
    ? (hasConfiguredRows ? configuredSections : DEFAULT_SHARED_SECTIONS)
    : [];
  return { enabled, sections, share };
}

// A SHARE THAT CANNOT BE READ SHARES NOTHING.
//
// An absent share row means "shared, default sections", so the old fallback for
// a failed read — no rows — published the default sections of every shared
// project to every teammate for as long as the read kept failing, which is the
// opposite of the fail-closed the list readers' comments promised. A failed
// read now answers "switched off": a non-author loses the project until the
// read succeeds (a skipped project is a smaller loss than a published one). The
// author is unaffected (isProjectOwner never consults the share), and so is a
// workspace owner reading org-owned private work (that gate is the role).
function unreadableShareInfo(projectIds, err) {
  console.warn('[CONTEXT] share policy read failed; withholding from non-authors', {
    projects: (projectIds || []).length,
    error: err?.message || String(err),
  });
  return { share: { enabled: false }, sections: [], members: [], unreadable: true };
}

async function getProjectSharePolicy(actor, project) {
  const info = await store.getProjectShare(project.project_id)
    .catch((err) => unreadableShareInfo([project.project_id], err));
  // The role that decides whether this actor may WRITE comes from workspace
  // membership, not from actor.role.
  //
  // actor.role is the org-level role on the users row, which is 'admin' by
  // default for nearly everyone and is absent entirely on internal actors — so
  // it answered "may Bob edit Alice's shared project?" with a value that had
  // nothing to do with the workspace. Resolved once here, on the already-async
  // policy, so canEditSectionForActor can stay synchronous.
  const workspaceRole = await workspace.resolveRole(actor, project.owner_key).catch(() => null);
  const policy = buildSharePolicy(actor, project, info, workspaceRole);
  // Has this project's author left the workspace? Only asked for a workspace
  // owner reading somebody else's shared or private project: see
  // holdsAuthorRights.
  if ((project.visibility === 'shared' || project.visibility === 'private')
    && project.owner_user_id
    && workspace.canAdminister(workspaceRole)
    && !workspace.actorIdentities(actor).includes(project.owner_user_id)) {
    const authors = await workspace.resolveAuthors(project.owner_key, [project.owner_user_id]).catch(() => null);
    if (authors) {
      // A legacy stamp that is the ACTOR's own old key id is the actor's work.
      const person = authors.personOf(project.owner_user_id);
      if (person && workspace.actorIdentities(actor).includes(person)) policy.authorIsActor = true;
      else policy.authorLeft = !authors.isActive(project.owner_user_id);
    }
  }
  return policy;
}

// getProjectSharePolicy over a LIST: Map(project_id -> policy).
//
// The per-project form costs three share reads plus a membership lookup, run
// one project after another — a teammate with 60 shared projects paid ~240
// sequential queries for every brief, dashboard load and portfolio read. Here
// the share rows come from one query per table (store.getProjectShares) and the
// role is resolved once per workspace, not once per project. Same policy
// objects, built by the same function; a read failure degrades exactly as the
// single form does (the share read to "switched off", the role read to null).
async function getProjectSharePolicies(actor, projects = []) {
  const list = (projects || []).filter((project) => project && project.project_id);
  const out = new Map();
  if (!list.length) return out;
  if (list.length === 1) {
    out.set(list[0].project_id, await getProjectSharePolicy(actor, list[0]));
    return out;
  }
  // Fails closed exactly as the single form does: every project in the batch
  // is read as switched off (unreadableShareInfo), not as "no rows".
  let unreadable = null;
  const infos = await store.getProjectShares(list.map((project) => project.project_id)).catch((err) => {
    unreadable = unreadableShareInfo(list.map((project) => project.project_id), err);
    return new Map();
  });
  const roles = new Map();
  for (const project of list) {
    const key = project.owner_key || '';
    if (!roles.has(key)) roles.set(key, await workspace.resolveRole(actor, project.owner_key).catch(() => null));
  }
  for (const project of list) {
    const info = unreadable || infos.get(project.project_id) || { share: null, sections: [], members: [] };
    out.set(project.project_id, buildSharePolicy(actor, project, info, roles.get(project.owner_key || '')));
  }
  return out;
}

function buildSharePolicy(actor, project, info, workspaceRole) {
  const { enabled, sections, share } = shareSectionsFromInfo(project, info);
  // Matched on the identity SET, not actor.id: for a key-authed actor — nearly
  // all MCP traffic — actor.id is the API KEY id while the stored user_id is the
  // person, so matching directly made a per-project grant work from the dashboard
  // and not from the tool it was granted for.
  const overrideIdentities = workspace.actorIdentities(actor);
  const memberOverride = (info.members || [])
    .find((row) => overrideIdentities.includes(row.user_id))?.role_override || null;
  return {
    enabled,
    sections,
    share,
    memberOverride,
    workspaceRole,
    // This actor wrote this PERSONAL project. See projectWriteRole.
    personalAuthor: project.visibility === 'personal'
      && Boolean(project.owner_user_id)
      && overrideIdentities.includes(project.owner_user_id),
    sectionRows: info.sections || [],
  };
}

// The role the WORKSPACE gate should judge this project by.
//
// context_project_members exists so an owner can hand one person write on one
// shared project. The workspace gate ran first on the workspace role alone, so a
// viewer was refused before the override was ever consulted and the column
// governed nothing they could reach.
//
// A grant only, never a demotion: an override that does not carry write leaves
// the workspace role in place here, and the per-project checks
// (assertCanWriteProject, canEditSectionForActor) still apply the override in
// both directions through resolveActorProjectRole. And only on a SHARED project
// — an override cannot open somebody's personal work or make a private project
// writable, which is the same line canEditSectionForActor draws.
//
// A PERSONAL PROJECT IS ITS AUTHOR'S, WHATEVER THEIR WORKSPACE ROLE. Nobody else
// can read it — not even a workspace owner — so a workspace role has nothing to
// protect there: demoting a member to viewer made their own diary read-only to
// the one person who can see it, with no one else able to fix it either. The
// role governs what they may do to the TEAM's work; their personal project is
// not that. (The credential cap in auth still narrows a viewer's key or OAuth
// token to read scopes; this is the service gate, which a session reaches.)
function projectWriteRole(project, policy) {
  if (policy?.personalAuthor && project?.visibility === 'personal') return 'member';
  const workspaceRole = policy?.workspaceRole || null;
  if (!policy?.memberOverride || !policy.enabled || project?.visibility !== 'shared') return workspaceRole;
  const overridden = workspace.normalizeRole(policy.memberOverride);
  return workspace.canWrite(overridden) ? overridden : workspaceRole;
}

function resolveActorProjectRole(actor, policy) {
  // Per-project override wins, then workspace membership, and only then the
  // org-level role as a last resort for actors predating membership.
  if (policy?.memberOverride) return workspace.normalizeRole(policy.memberOverride);
  if (policy?.workspaceRole) return policy.workspaceRole;
  return workspace.normalizeRole(actor?.role);
}

// Does this actor own the project outright, rather than merely sharing a
// workspace with it? An unattributed project (owner_user_id NULL) predates
// per-user attribution and belongs to the workspace as a whole — see
// workspaceService.backfillProjectOwnership, which resolves that ambiguity at
// the only moment it can be resolved without guessing.
function isProjectOwner(actor, project) {
  if (!project) return false;
  if (!project.owner_user_id) return true;
  // Match on the identity SET, not on actor.id. For a key-authed actor — which
  // is nearly all MCP traffic — actor.id is the API KEY id, while the stored
  // owner_user_id is the person. Comparing the two directly makes you fail the
  // ownership check on your own project, so your own private work disappears
  // from your own brief the moment the visibility filter starts being enforced.
  return workspace.actorIdentities(actor).includes(project.owner_user_id);
}

// THE AUTHOR'S RIGHTS PASS TO THE WORKSPACE'S OWNERS WHEN THE AUTHOR LEAVES.
//
// Journey r5 (shared), extended in r6 (private). What somebody wrote into a team's
// project stays with the team, and the leave screen says a workspace owner can
// delete it. That has to be true in a project the author made and locked: once the
// AUTHOR has left the workspace (no ACTIVE membership: removed, erased, or a legacy
// owner id that never had a roster row; see workspace.resolveAuthors), a workspace owner
// holds the author's edit rights on that project, sections the author made
// view-only included. It holds for a SHARED project and for a PRIVATE one (org
// work an owner could already read, and now can take over: decisions, notes,
// tasks). While the author is a member nothing changes. `policy.authorLeft` is
// resolved with the rest of the share policy (getProjectSharePolicy), only for a
// workspace owner who is not the author. A member never gets it, and a PERSONAL
// project is never opened to anybody: it is not readable by a non-author at all.
function holdsAuthorRights(actor, project, policy) {
  if (isProjectOwner(actor, project)) return true;
  if (policy?.authorIsActor) return true;
  return Boolean(policy?.authorLeft)
    && (project?.visibility === 'shared' || project?.visibility === 'private')
    && workspace.canAdminister(policy?.workspaceRole);
}

// WHO MAY DELETE, ARCHIVE, MOVE, SHARE OR RENAME A PROJECT (journey r6).
//
// These are the powers over the project as a whole, not over what is written in
// it (that is holdsAuthorRights and the section policy). The rule, one fact
// (policy.authorLeft) read the same way holdsAuthorRights reads it:
//
//   author                         always, on their own project
//   PRIVATE, somebody else's       a workspace owner ONLY once the author has left
//                                  the workspace. An owner reads a private project so
//                                  the org can reach its own work; while the author
//                                  is a member, deleting, archiving, moving or
//                                  sharing it is the author's call.
//   SHARED, somebody else's        a workspace owner, whether or not the author is
//                                  still here. A member with edit rights on its
//                                  sections may write into it and may NOT do any of
//                                  these, rename included.
//   PERSONAL, somebody else's      nobody: it never reaches this function, the
//                                  visibility gate has already answered not-found.
//
// An unattributed project (no author) is the workspace's: isProjectOwner already
// answers for it, as everywhere else.
function holdsProjectPowers(actor, project, policy) {
  if (holdsAuthorRights(actor, project, policy)) return true;
  return project?.visibility === 'shared' && workspace.canAdminister(policy?.workspaceRole);
}

// The refusal for holdsProjectPowers, in words the caller can act on. A member
// never gets here for a project they cannot read (that is not_found), so this only
// ever explains a project the caller can see.
function projectPowersRefusal(project, doing) {
  if (project?.visibility === 'private') {
    return writeForbiddenError(
      `share_write_forbidden: this is ${project.project_name ? `"${project.project_name}", ` : ''}a private project, and only its author can ${doing} it while they are in the workspace. `
      + 'A workspace owner can once the author has left. Ask the author.'
    );
  }
  return writeForbiddenError(
    `share_write_forbidden: only this project's author or a workspace owner can ${doing} it.`
  );
}

// THREE STATES, because "private" was answering two different questions.
//
//   personal — the individual's own work. Nobody else reads it, INCLUDING a
//              workspace owner. This is the independent-side-project case: it
//              happens to live in this workspace, but it is not the org's.
//   private  — the org's work, not shared with the team. The creator reads it,
//              and so may a workspace owner: it is org property, and an owner
//              who cannot see it cannot pick it up when the author leaves.
//   shared   — the workspace, subject to the section policy.
//
// The distinction matters because collapsing them forces a bad trade: either an
// owner can read a colleague's genuinely personal work, or the org cannot reach
// its own. Naming both states costs one column value and removes the trade.
function canViewProjectForActor(actor, project, policy) {
  if (!project) return false;

  // WORKSPACE MEMBERSHIP IS NOT PROJECT ACCESS.
  //
  // This function used to open with `if (project.owner_key === actorKey) return
  // true`, and getActorKey() is `org_id || id` — the same value owner_key holds
  // for every project in the workspace. So for any two people sharing an org the
  // condition was unconditionally true, it returned on the first line, and every
  // branch below was unreachable. context_project_shares, context_project_members
  // and the whole per-section can_view/can_edit model were dead code in the only
  // situation they exist for: flipping a project to private saved, returned 200,
  // and the teammate still saw everything.
  //
  // Sharing a workspace is now the PRECONDITION for the checks below, not a
  // substitute for them. Callers have already resolved owner_key through
  // workspaceService.resolveOwnerKey, so a project from another workspace never
  // reaches here at all.
  const actorKey = getActorKey(actor);
  if (project.owner_key && project.owner_key !== actorKey) return false;

  // 'personal' is checked BEFORE the ownership shortcut, because that shortcut
  // treats an unattributed project (owner_user_id NULL) as owned by whoever is
  // asking. A row that is both NULL-owned and personal would otherwise be
  // readable by the entire workspace — and backfillProjectOwnership, which is
  // what makes that combination unreachable, can leave it behind if its first
  // statement fails while its second succeeds.
  if (project.visibility === 'personal' && project.owner_user_id) {
    if (!workspace.actorIdentities(actor).includes(project.owner_user_id)) return false;
    return true;
  }
  if (project.visibility === 'personal') return false;

  if (isProjectOwner(actor, project)) return true;

  // Org-owned but unshared: the owner may read it. Read only — see
  // canEditSectionForActor, where the same case deliberately stops short.
  if (project.visibility === 'private') return policy?.workspaceRole === 'owner';

  if (project.visibility !== 'shared') return false;
  if (!policy?.enabled) return false;
  return true;
}

function canEditSectionForActor(actor, project, policy, sectionKey) {
  // Same correction as canViewProjectForActor: sharing a workspace is the
  // precondition, not the grant. The old first line made every section editable
  // by every teammate regardless of the share policy's can_edit flags.
  const actorKey = getActorKey(actor);
  if (project.owner_key && project.owner_key !== actorKey) return false;
  if (holdsAuthorRights(actor, project, policy)) return true;
  // While its author is a member, an owner may READ org-owned private work but
  // not rewrite it. Reading solves continuity, which is what the state is for;
  // writing is a different power. Once the author has left, holdsAuthorRights
  // (above) hands the owner the author's edit rights. Deliberate, not an omission.
  if (project.visibility !== 'shared') return false;
  if (!policy?.enabled) return false;
  const role = resolveActorProjectRole(actor, policy);
  if (!ROLE_EDIT_ALLOW.has(role)) return false;
  // A SECTION OUTSIDE THE SHARE IS NOT WRITABLE.
  //
  // policy.sections is what the reader actually receives. The row lookup below
  // falls back to DEFAULT_SHARED_SECTIONS when no explicit row exists — which is
  // right for a project with no configured rows at all (policy.sections is those
  // same defaults), and wrong the moment an author narrows the share: a policy
  // of ['current_task'] still answered "yes, you may write recent_decisions",
  // because the fallback never consulted the section list.
  //
  // Write-to-a-section-you-cannot-read is the precondition for a blind
  // overwrite, and it is what let one event replace an owner's decision log.
  // The default case is unchanged: no rows → sections === DEFAULT_SHARED_SECTIONS.
  if (!(policy.sections || []).includes(sectionKey)) return false;
  const row = (policy.sectionRows || []).find((entry) => entry.section_key === sectionKey);
  if (!row) return DEFAULT_SHARED_SECTIONS.includes(sectionKey);
  return Boolean(row.can_edit);
}

/**
 * The identity of a project NAME: what two spellings must share to be one name.
 *
 * The old rule kept [a-z0-9] and nothing else, which did two wrong things:
 *
 *   - `C#`, `C++` and `C` all became "c". Creating the second was refused as a
 *     duplicate of the first, and a reference to one resolved to whichever row
 *     came back first — a write filed into a different language's project.
 *   - a name with no Latin letter at all ("支付网关", "Платёжный шлюз") became
 *     '', which every caller treats as "no name": it could not be found by name,
 *     and the duplicate gate never fired for it.
 *
 * So: any letter or digit in any script survives (\p{L}\p{N}, plus \p{M} —
 * in Devanagari, Thai and others the vowel signs ARE combining marks, and
 * dropping them merges different words). NFKC first, so a composed "ё" and a
 * decomposed one compare equal. `#` and `+` survive only when they are ATTACHED
 * to the word before them, which is when they are part of the name ("C#",
 * "C++", "Notepad++"); free-standing, as in "Node + React" or "Issue #42", they
 * are punctuation, exactly as they were under the old rule.
 */
function normalizeName(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(?<![\p{L}\p{N}#+])[#+]+/gu, '')
    .replace(/[^\p{L}\p{N}\p{M}#+]/gu, '');
}

// The rule every row written before this change was matched with. Kept ONLY as
// a fallback tier for resolving a caller's reference (findProjectCandidatesByName):
// somebody who has always typed "roadmap c" to reach "Roadmap C#" must still
// reach it. Never used to decide that two names are duplicates — that is the
// merge this rule was replaced to stop.
function legacyNormalizeName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The visibility scope every store enumeration needs, resolved once per actor.
 *
 * Exactly what listProjects computes inline: who this actor is (actorIdentities),
 * and whether they are the OWNER of a shared workspace, which is the only role
 * that may enumerate org-owned `private` work. Nobody enumerates somebody else's
 * `personal` work, owner included.
 *
 * A system actor (internal jobs, the shared dev key) has no person to scope by
 * and says so out loud — visibilityClause refuses an unattributed listing rather
 * than quietly returning the whole workspace.
 *
 * The role lookup is skipped where nothing in the workspace can be somebody
 * else's (see resolveIsWorkspaceOwner) — there the answer cannot change the
 * result and the query would be pure cost.
 */
async function actorVisibilityScope(actor, ownerKey = getActorKey(actor)) {
  const system = actor?.type === 'system' || ownerKey === 'org-system';
  if (system) return { system: true, actorIdentities: [], isWorkspaceOwner: false };
  const actorIdentities = workspace.actorIdentities(actor);
  return {
    system: false,
    actorIdentities,
    isWorkspaceOwner: await resolveIsWorkspaceOwner(actor, ownerKey, actorIdentities),
  };
}

// Is this actor an owner of the workspace, for the purpose of reading org-owned
// `private` work? Decided by ROLE, not by how many people are in the workspace
// today.
//
// This was `isSharedWorkspace && role === 'owner'`, so the day a two-person
// team shrank to one the remaining owner stopped being an owner here and lost
// the departed member's private projects from list, export and recall — the
// exact situation (the author has left) that owners read `private` work for.
//
// The only shortcut left is the one that cannot change the answer: when nothing
// in the workspace is attributed to anybody else, there is no private work of
// someone else's to read, so the role query is skipped. That check is the one
// visibleProjectIdsForActor needs anyway.
async function resolveIsWorkspaceOwner(actor, ownerKey, identities = workspace.actorIdentities(actor)) {
  if (!(await workspaceMayHoldOthersWork(actor, ownerKey, identities))) return false;
  return (await workspace.resolveRole(actor, ownerKey).catch(() => null)) === 'owner';
}

// store.workspaceMayHoldOthersWork, asked ONCE per request.
//
// Two helpers need the answer — resolveIsWorkspaceOwner (every listing) and
// visibilityForActor (every graph filter) — and one request commonly reaches
// both: GET /graph/projects/:id, and hosted start_session, ran the query twice
// for a solo account, which is the account the shortcut exists to keep cheap.
//
// Memoised on the ACTOR object, which the auth middleware builds fresh for
// every request, so the memo lives exactly as long as the request does. The
// TTL is the bound for anything that holds an actor longer than one request
// (a job, a test): a workspace that gains a second person must not stay "solo"
// to a long-lived actor. The PROMISE is memoised, so concurrent callers in one
// request share one round trip too; a failure is not cached.
const MAY_HOLD_OTHERS_MEMO = new WeakMap();
const MAY_HOLD_OTHERS_TTL_MS = 2000;

function workspaceMayHoldOthersWork(actor, ownerKey, identities = workspace.actorIdentities(actor)) {
  if (!actor || typeof actor !== 'object') return store.workspaceMayHoldOthersWork(ownerKey, identities);
  const key = `${ownerKey}\0${[...(identities || [])].sort().join('\0')}`;
  let perActor = MAY_HOLD_OTHERS_MEMO.get(actor);
  if (!perActor) {
    perActor = new Map();
    MAY_HOLD_OTHERS_MEMO.set(actor, perActor);
  }
  const hit = perActor.get(key);
  if (hit && Date.now() - hit.at < MAY_HOLD_OTHERS_TTL_MS) return hit.promise;
  const promise = store.workspaceMayHoldOthersWork(ownerKey, identities);
  perActor.set(key, { at: Date.now(), promise });
  promise.catch(() => perActor.delete(key));
  return promise;
}

// Takes an ACTOR, not an owner key. The owner key answers "which workspace"; only
// the actor answers "which of that workspace's projects may this person see", and
// a name lookup that skips the second question resolves to — and names — work
// that is not theirs. See listProjectIdentifiers.
async function findProjectByName(actor, candidateName) {
  if (!candidateName) return null;
  const ownerKey = getActorKey(actor);
  const target = normalizeName(candidateName);
  // Must track MIN_PROJECT_NAME_LENGTH, not a separate hardcoded floor. createProject's
  // duplicate-name gate calls this function, so while this said `< 3` and the creation
  // minimum was 2, the gate silently no-opped for exactly the short names ("V2", "QA")
  // that lowering the minimum was meant to enable — letting a user create unlimited
  // duplicates named "V2". Matching here is exact (=== on normalized names), never fuzzy,
  // so a shorter floor cannot produce false-positive matches.
  if (!target || target.length < MIN_PROJECT_NAME_LENGTH) return null;
  // Match against a projected list (no context, no decrypt); only fetch + decrypt
  // the single matched project. Shape matches the old listProjects entry
  // (context + events:[]), so callers (saveProject spread) are unaffected.
  const candidates = await store.listProjectIdentifiers(
    ownerKey,
    await actorVisibilityScope(actor, ownerKey)
  );
  const match = candidates.find(p => {
    if (normalizeName(p.project_name) === target) return true;
    return (p.aliases || []).some(a => normalizeName(a) === target);
  });
  if (!match) return null;
  return store.getProjectContextOnly(ownerKey, match.project_id);
}

/**
 * Every project whose name (or alias) normalizes to `candidateName`.
 *
 * findProjectByName above answers "does a project with this name already exist"
 * for the create-time duplicate gate, so it returns the FIRST match and applies
 * a minimum-length floor. Resolving a caller-supplied reference is a different
 * question with a different safe answer: it needs every candidate, because two
 * candidates must REFUSE rather than pick one, and it must not floor short names
 * ("V2", "QA") that are legitimately creatable.
 *
 * listProjectIdentifiers returns every row for the owner in one query, archived
 * included and without decrypting context, so the candidate set is complete.
 * Completeness is the load-bearing part: a match is only provably unique if
 * nothing that could tie with it was out of view.
 *
 * Scoped to what the ACTOR may see, for the same reason findProjectByName is:
 * the refusal this feeds prints every candidate's name and id, so an unscoped
 * candidate set turns a name collision into a disclosure. A name that matches
 * only an invisible project yields no candidates, and the caller reports an
 * unknown project exactly as it would for a name that does not exist.
 *
 * @param {object} actor
 * @param {string} candidateName
 * @returns {Promise<Array<{project_id: string, project_name: string}>>}
 */
async function findProjectCandidatesByName(actor, candidateName) {
  const target = normalizeName(candidateName);
  const legacyTarget = legacyNormalizeName(candidateName);
  if (!target && !legacyTarget) return [];
  const ownerKey = getActorKey(actor);
  const rows = await store.listProjectIdentifiers(
    ownerKey,
    await actorVisibilityScope(actor, ownerKey)
  );
  const match = (normalize, wanted) => {
    const byName = [];
    const byAlias = [];
    if (!wanted) return byName;
    for (const row of rows) {
      if (!row?.project_id) continue;
      if (normalize(row.project_name) === wanted) {
        byName.push(row);
        continue;
      }
      if ((row.aliases || []).some((alias) => normalize(alias) === wanted)) byAlias.push(row);
    }
    // A real name outranks a nickname, so a project renamed to "Billing" is not
    // made ambiguous by another project still carrying "billing" as an old alias.
    // Only ties WITHIN the winning tier are ambiguous.
    return byName.length ? byName : byAlias;
  };
  // The current rule answers first and alone. The rule it replaced is consulted
  // only when that finds NOTHING, so a reference that used to work keeps working
  // ("roadmap c" -> "Roadmap C#") without ever outvoting an exact match. Two
  // old-rule matches come back as two candidates, and the caller refuses them —
  // which is also what the old rule did with them.
  //
  // Not for a reference the old rule would have CUT: given "支付 API" it kept
  // "api" and threw the rest away, so falling back to it would resolve a name
  // nobody has to the project called "API". The fallback exists for spellings
  // the old rule read in full.
  let tier = match(normalizeName, target);
  const legacyReadAllOfIt = !/[^\p{ASCII}]/u.test(String(candidateName || '').normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, ''));
  if (!tier.length && legacyReadAllOfIt) tier = match(legacyNormalizeName, legacyTarget);
  return [...new Map(tier.map((row) => [row.project_id, row])).values()];
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${key}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const NON_CONTENT_DELTA_KEYS = new Set(['category', 'current_task_source', 'current_task_set_at']);

function isMeaningfulDelta(delta = {}) {
  if (!delta || typeof delta !== 'object') return false;
  // `category` is a classification of the project, not something the caller
  // said. The model returns it on nearly every call, so counting it made a delta
  // of {category:'coding'} "meaningful": the merge ran, last_updated moved, and
  // update_context reported the caller's words stored when none were.
  return Object.entries(delta).some(([key, value]) => {
    if (NON_CONTENT_DELTA_KEYS.has(key)) return false;
    if (Array.isArray(value)) return value.length > 0;
    return Boolean(String(value || '').trim());
  });
}

function contextChanged(previous, next) {
  return stableStringify(previous) !== stableStringify(next);
}

function approximateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

function computeContextDiff(previous, delta) {
  if (!delta || typeof delta !== 'object') return {};
  const diff = {};
  for (const [key, newVal] of Object.entries(delta)) {
    if (key === 'you_profile') continue;
    const oldVal = previous?.[key];
    if (Array.isArray(newVal)) {
      const added = newVal.filter((v) => {
        const vs = stableStringify(v);
        return !(oldVal || []).some((o) => stableStringify(o) === vs);
      });
      if (added.length) diff[key] = { added };
    } else if (newVal !== undefined && String(newVal || '') !== String(oldVal || '')) {
      diff[key] = { from: oldVal || null, to: newVal };
    }
  }
  return diff;
}

function clipText(value, maxChars = 80) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function uniqueStrings(values = []) {
  return Array.from(new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean)));
}

function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/[^a-z0-9._:/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function scoreKnownPathMatch(queryTerms, text) {
  const haystack = normalizeText(text);
  if (!haystack) return 0;
  const matched = queryTerms.filter((term) => haystack.includes(term)).length;
  if (!matched) return 0;
  const base = matched / Math.max(queryTerms.length, 1);
  // Segment bonus: a query term that matches a whole path/identifier segment
  // (basename, dir, or word — e.g. "freshness" vs freshness.ts) is a stronger
  // signal than a substring buried in prose. Keeps the substring score as a floor
  // so nothing that matched before stops matching.
  const segments = new Set(haystack.split(/[\s/._-]+/).filter(Boolean));
  const segmentHits = queryTerms.filter((term) => segments.has(term)).length;
  const bonus = segmentHits > 0 ? 0.5 * (segmentHits / Math.max(queryTerms.length, 1)) : 0;
  return base + bonus;
}

function buildProjectMapText(project, verbosity = 'standard') {
  const context = project?.context || {};
  // Three genuinely distinct tiers (light < standard < detailed) — mirrors the
  // pattern getWorkspaceOverview already uses. 'detailed' returns materially
  // more: more hot paths/entrypoints/surfaces, the full path list per surface,
  // and untruncated debugging notes (including their linked paths).
  const tier = verbosity === 'light' ? 'light' : verbosity === 'detailed' ? 'detailed' : 'standard';
  const hotPathCount = tier === 'light' ? 3 : tier === 'detailed' ? 15 : 6;
  const entrypointCount = tier === 'light' ? 2 : tier === 'detailed' ? 10 : 4;
  const surfaceCount = tier === 'light' ? 2 : tier === 'detailed' ? 10 : 4;
  const surfacePathCount = tier === 'detailed' ? Infinity : 2;
  const debugNoteCount = tier === 'light' ? 1 : tier === 'detailed' ? 8 : 3;
  const lines = [
    `Project: ${project.project_name}`,
    context.current_task ? `Current task: ${context.current_task}` : null,
    context.current_status ? `Current status: ${context.current_status}` : null,
    (context.hot_paths || []).length
      ? `Hot paths: ${(context.hot_paths || []).slice(-hotPathCount).reverse().map((entry) => `${entry.label} -> ${entry.path}`).join(' | ')}`
      : null,
    (context.entrypoints || []).length
      ? `Entry points: ${(context.entrypoints || []).slice(0, entrypointCount).map((entry) => `${entry.label} -> ${entry.path}`).join(' | ')}`
      : null,
    (context.surfaces || []).length
      ? `Surfaces: ${(context.surfaces || []).slice(0, surfaceCount).map((entry) => `${entry.label}${entry.paths?.length ? ` -> ${(Number.isFinite(surfacePathCount) ? entry.paths.slice(0, surfacePathCount) : entry.paths).join(' | ')}` : ''}`).join(' | ')}`
      : null,
    (context.debugging_notes || []).length
      ? `Debugging notes: ${[...(context.debugging_notes || [])].sort((a, b) => (Date.parse(b.added_at) || 0) - (Date.parse(a.added_at) || 0)).slice(0, debugNoteCount).map((entry) => {
          const fixRef = entry.commit_ref || entry.diff_ref ? ` (fix: ${entry.commit_ref || entry.diff_ref})` : '';
          const notePaths = tier === 'detailed' && entry.paths?.length ? ` [${entry.paths.join(' | ')}]` : '';
          return `${entry.summary}${fixRef}${notePaths}`;
        }).join(' | ')}`
      : null,
  ].filter(Boolean);
  return lines.join('\n');
}

// Identity for a workspace entity: `${entityType}:${key}`, and the DB enforces
// UNIQUE (owner_key, node_type, canonical_key) on it.
//
// The read path returns the FULL prefixed key, and callers naturally round-trip
// that value straight back into entities[].canonical_key — it is the only key
// they were ever given. Because normalizeKey deliberately preserves ':', doing
// so used to re-prefix it into `decision:decision:foo`: a different identity, so
// the upsert INSERTED a second node instead of updating the first. That is how
// mark_resolved produced a resolved duplicate beside an untouched original while
// reporting the original resolved.
//
// An explicitly supplied key that already carries its own type prefix is
// therefore treated as canonical. Only the providedKey branch is prefix-aware:
// a key derived from the title is left exactly as it was, so an entity whose
// TITLE happens to begin with "decision:" keeps the key it already has in the
// database rather than silently orphaning itself.
function canonicalWorkspaceKey(entityType, title, providedKey) {
  const prefix = `${entityType}:`;
  if (providedKey) {
    const normalizedProvided = normalizeKey(providedKey);
    return normalizedProvided.startsWith(prefix) ? normalizedProvided : `${prefix}${normalizedProvided}`;
  }
  return `${prefix}${normalizeKey(title)}`;
}

// The unredacted entity upsertWorkspaceEntities was handed, kept beside the
// redacted copy so the canonical key can be derived from the caller's own words.
const RAW_WORKSPACE_ENTITY = Symbol('deerdawn.rawWorkspaceEntity');

// canonicalWorkspaceKey over the RAW title and key, then secretSafeKey: a key
// with no secret in it (or its source) is exactly what it always was; one with a
// secret becomes a stable hash of the raw key, distinct per secret.
// `masked` says the secret-safe form was taken, i.e. the caller's title or key
// held a secret: the stored title then reads "... [REDACTED] ...", and two
// different secrets under the same words would look identical to the fuzzy
// title dedup, so such an entity is matched by its exact key only.
function workspaceEntityKey(entity, rawEntity) {
  if (!rawEntity || typeof rawEntity !== 'object') {
    const plain = canonicalWorkspaceKey(entity.entity_type, entity.title, entity.canonical_key);
    const key = secretSafeKey(plain);
    return { key, masked: key !== plain };
  }
  const rawTitle = (rawEntity.title != null && String(rawEntity.title).trim())
    ? String(rawEntity.title).trim()
    : String(rawEntity.name || '').trim();
  const rawProvided = rawEntity.canonical_key ? String(rawEntity.canonical_key) : '';
  // A DECISION IS KEYED ON THE TEXT THE BRIEF STORES. A decision node mirrors an
  // entry in recent_decisions, and the brief keeps that entry REDACTED
  // (cleanSyncedText), so the writers that derive the node from the brief — the
  // graph rebuild and the auto-promotion — key it on "... [REDACTED] ...". The
  // event and upsert doors keyed the RAW text through secretSafeKey, a hash, so
  // one decision with a secret in it became two nodes and every resolve of it
  // was refused as "matches 2 entities". Two decisions differing only in their
  // secret are already one line in the brief; they are one node here too.
  if (entity.entity_type === 'decision' && !rawProvided) {
    const key = secretSafeKey(canonicalWorkspaceKey('decision', entity.title));
    return { key, masked: redactSecrets(rawTitle) !== rawTitle };
  }
  const rawKey = canonicalWorkspaceKey(entity.entity_type, rawTitle, rawProvided);
  const key = secretSafeKey(rawKey, { source: rawProvided || rawTitle });
  return { key, masked: key !== rawKey || redactSecrets(rawTitle) !== rawTitle };
}

function workspaceNodeType(entityType) {
  return entityType === 'service' ? 'service' : entityType;
}

function buildWorkspaceEntitySummary(node) {
  const scope = node.project_id ? 'project' : 'workspace';
  // Never the canonical key in its place: an internal identity, with a project
  // id in it for a per-project copy (scan 36).
  return `${node.title}${node.summary ? `: ${node.summary}` : ''} (${scope})`;
}

function nodeRecencyScore(node) {
  const iso = node?.last_seen_at || node?.updated_at || node?.created_at;
  if (!iso) return 0.2;
  const ageMs = Math.max(0, Date.now() - new Date(iso).getTime());
  const days = ageMs / (24 * 60 * 60 * 1000);
  return Math.max(0, 1 - (days / 21));
}

function nodeImportanceScore(node) {
  const importance = String(node?.metadata?.importance || 'normal').toLowerCase();
  if (importance === 'critical') return 0.45;
  if (importance === 'high') return 0.3;
  if (importance === 'low') return 0.05;
  return 0.15;
}

function nodeMemoryTierScore(node) {
  const tier = String(node?.metadata?.memory_tier || '').toLowerCase();
  if (tier === 'durable') return 0.22;
  if (tier === 'candidate') return -0.14;
  return 0;
}

function nodePinnedScore(node) {
  return node?.metadata?.pinned ? 0.4 : 0;
}

function shouldPromoteCandidateMetadata(metadata = {}) {
  const memoryTier = String(metadata.memory_tier || '').toLowerCase();
  if (memoryTier !== 'candidate') return false;
  return (
    Number(metadata.seen_count || 0) >= 2
    || Number(metadata.source_count || 0) >= 2
    || Number(metadata.retrieval_hits || 0) >= 2
    || Boolean(metadata.pinned)
  );
}

function nodeStatusScore(node) {
  const status = String(node?.metadata?.status || '').toLowerCase();
  if (status === 'resolved' || status === 'archived') return -0.8;
  if (status === 'deprecated' || status === 'stale') return -0.35;
  if (status === 'shipped' || status === 'active') return 0.08;
  return 0;
}

function isCuratedNode(node) {
  const curation = String(node?.metadata?.curation_state || '').toLowerCase();
  return Boolean(node?.metadata?.pinned) || curation === 'curated' || curation === 'promoted';
}

// Reward nodes the agent actually retrieves: a node selected on past sessions is
// empirically more useful. Logarithmic + capped so it can never beat projectMatch.
function nodeUsageScore(node) {
  const hits = Number(node?.metadata?.retrieval_hits || 0);
  if (hits <= 0) return 0;
  return Math.min(0.25, Math.log1p(hits) * 0.08);
}

// Demote nodes that have sat unretrieved for a long time — never-used + stale is
// the signature of capture noise. Exempt pinned/curated nodes (deliberately kept).
function nodeStaleDecayScore(node) {
  if (isCuratedNode(node)) return 0;
  if (Number(node?.metadata?.retrieval_hits || 0) > 0) return 0;
  const iso = node?.last_seen_at || node?.updated_at || node?.created_at;
  if (!iso) return 0;
  const days = (Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000);
  return days > 30 ? -0.15 : 0;
}

function nodeText(node) {
  return normalizeText([
    node?.title,
    node?.summary,
    node?.canonical_key,
    node?.metadata?.entity_type,
    node?.metadata?.status,
    node?.metadata?.category,
    node?.metadata?.surface,
    node?.metadata?.slug,
    Array.isArray(node?.metadata?.input_modes) ? node.metadata.input_modes.join(' ') : '',
    Array.isArray(node?.metadata?.outputs) ? node.metadata.outputs.join(' ') : '',
    Array.isArray(node?.metadata?.integration_keys) ? node.metadata.integration_keys.join(' ') : '',
    Array.isArray(node?.metadata?.project_ids) ? node.metadata.project_ids.join(' ') : '',
  ].filter(Boolean).join(' '));
}

function queryTermsForSearch(input) {
  return uniqueStrings(normalizeText(input).split(/\s+/).filter((part) => part.length >= 3));
}

function analyzeQueryIntent(query) {
  const normalized = normalizeText(query);
  return {
    wantsCapabilities: /\bwhat can\b|\bcapabilit|\bdoes\b.*\bdo\b|\bcan\b.*\bdo\b/.test(normalized),
    wantsConnections: /\bconnect|\bintegration|\buses\b|\bdepends on\b|\bconnected\b/.test(normalized),
    wantsTools: /\btool\b|\bmcp\b|\bapi\b|\bdashboard\b|\bworkflow\b/.test(normalized),
  };
}

function capabilitySurfaceFromPath(pathValue = '') {
  const normalized = String(pathValue || '').replace(/\\/g, '/').toLowerCase();
  if (!normalized) return null;
  if (normalized.includes('packages/mcp-server/src/tools/')) return 'mcp_tool';
  if (normalized.includes('/src/routes/') || normalized.includes('src/routes/')) return 'api';
  if (normalized.includes('apps/dashboard/src/pages/')) return 'dashboard';
  if (normalized.includes('apps/desktop/')) return 'desktop';
  if (normalized.includes('apps/extension/')) return 'extension';
  return null;
}

function capabilityTitleFromPath(pathValue = '') {
  const normalized = String(pathValue || '').replace(/\\/g, '/');
  const base = normalized.split('/').pop() || normalized;
  const stem = base.replace(/\.[a-z0-9]+$/i, '');
  const words = stem
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
  const titled = words
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  if (normalized.toLowerCase().includes('packages/mcp-server/src/tools/')) {
    return titled ? `${titled} MCP tool` : 'MCP tool';
  }
  if (normalized.toLowerCase().includes('/src/routes/') || normalized.toLowerCase().includes('src/routes/')) {
    return titled ? `${titled} API` : 'API capability';
  }
  if (normalized.toLowerCase().includes('apps/dashboard/src/pages/')) {
    return titled ? `${titled} dashboard view` : 'Dashboard capability';
  }
  if (normalized.toLowerCase().includes('apps/desktop/')) {
    return titled ? `${titled} desktop flow` : 'Desktop capability';
  }
  if (normalized.toLowerCase().includes('apps/extension/')) {
    return titled ? `${titled} browser extension flow` : 'Browser extension capability';
  }
  return titled || null;
}

function buildAutoPromotedMemoryEntities(project, extraction, now) {
  const delta = extraction?.delta || {};
  const confidence = Number(extraction?.confidence || 0);
  const baseSource = extraction?.source_tool || extraction?.tool || 'context_sync';
  const entities = [];

  const durableMetadata = {
    importance: 'high',
    status: 'active',
    source_kind: 'inferred',
    curation_state: 'promoted',
    memory_tier: 'durable',
    seen_count: 1,
    source_count: 1,
    retrieval_hits: 0,
    last_matched_at: now,
    source_keys: [baseSource],
    auto_promoted: true,
  };

  const candidateMetadata = {
    importance: 'normal',
    status: 'active',
    source_kind: 'inferred',
    curation_state: 'inferred',
    memory_tier: 'candidate',
    seen_count: 1,
    source_count: 1,
    retrieval_hits: 0,
    last_matched_at: now,
    source_keys: [baseSource],
    auto_promoted: true,
  };

  if (delta.current_task && confidence >= 0.78) {
    entities.push({
      entity_type: 'task',
      title: delta.current_task,
      summary: delta.current_task,
      scope: 'project',
      project_id: project.project_id,
      metadata: {
        ...durableMetadata,
        // `critical` outranks everything in every workspace read. It is earned
        // by a task somebody SET; one a model inferred from a status line is a
        // guess and ranks as one.
        importance: extraction?.explicit ? 'critical' : 'normal',
      },
    });
  }

  for (const decision of delta.recent_decisions || []) {
    if (!decision?.summary) continue;
    // recent_decisions is the source of truth; the graph node mirrors its
    // resolved status so the two never diverge.
    entities.push({
      entity_type: 'decision',
      title: decision.summary,
      summary: decision.summary,
      scope: 'project',
      project_id: project.project_id,
      metadata: {
        ...durableMetadata,
        // Mirrors the decision it was promoted from, and an unmarked decision is
        // `normal` everywhere else (DecisionEntrySchema's default). This said
        // `high`, so the graph node disagreed with its own source of truth and
        // every auto-promoted decision claimed the importance boost in workspace
        // ranking — where a boost everything has is no boost.
        importance: decision.importance || 'normal',
        ...(decision.resolved ? { status: 'resolved', resolved_at: decision.resolved_at || isoNow() } : {}),
      },
    });
  }

  // source_section: which share-policy section this knowledge was promoted
  // from, so the graph filter can hold it to that section alone (see
  // GRAPH_NODE_SECTIONS). Without it, both are required.
  if (delta.source_summary && confidence >= 0.72) {
    entities.push({
      entity_type: 'knowledge',
      title: clipText(delta.source_summary, 72),
      summary: delta.source_summary,
      scope: 'project',
      project_id: project.project_id,
      metadata: { ...candidateMetadata, source_section: 'source_summary' },
    });
  }

  if (delta.description && confidence >= 0.76) {
    entities.push({
      entity_type: 'knowledge',
      title: clipText(delta.description, 72),
      summary: delta.description,
      scope: 'project',
      project_id: project.project_id,
      metadata: { ...candidateMetadata, source_section: 'description' },
    });
  }

  for (const question of (delta.open_questions || []).slice(0, 3)) {
    entities.push({
      entity_type: 'question',
      title: question,
      summary: question,
      scope: 'project',
      project_id: project.project_id,
      metadata: candidateMetadata,
    });
  }

  for (const preference of (delta.recurring_context || []).slice(0, 3)) {
    entities.push({
      entity_type: 'preference',
      title: preference,
      summary: preference,
      scope: 'project',
      project_id: project.project_id,
      metadata: durableMetadata,
    });
  }

  return entities;
}

function inferWorkspaceCapabilities(nodes, activeProject = null) {
  const inferred = [];
  const seen = new Set();
  const projectId = activeProject?.project_id || null;
  const projectName = activeProject?.project_name || '';
  const now = isoNow();

  for (const node of nodes) {
    const pathValue = String(node?.metadata?.path || node?.title || '');
    const surface = capabilitySurfaceFromPath(pathValue);
    if (!surface) continue;
    const title = capabilityTitleFromPath(pathValue);
    if (!title) continue;
    const canonicalKey = canonicalWorkspaceKey('capability', title, normalizeKey(`${surface}:${title}`));
    if (seen.has(canonicalKey)) continue;
    seen.add(canonicalKey);

    inferred.push({
      node_id: `inferred_${normalizeKey(`${node.node_id}:${canonicalKey}`)}`,
      owner_key: node.owner_key,
      project_id: node.project_id || projectId,
      node_type: 'capability',
      canonical_key: canonicalKey,
      title,
      summary: `${title} is inferred from ${pathValue}${projectName ? ` in ${projectName}` : ''}.`,
      metadata: {
        entity_type: 'capability',
        status: 'active',
        scope: node.project_id || projectId ? 'project' : 'workspace',
        importance: 'high',
        curation_state: 'inferred',
        source_kind: 'inferred',
        discovery_source: 'inferred',
        inferred_from_node_id: node.node_id,
        inferred_from_path: pathValue,
        surface,
        slug: normalizeKey(title),
        project_ids: [node.project_id || projectId].filter(Boolean),
      },
      confidence: Math.max(0.78, Number(node.confidence || 0.75)),
      source_session_id: node.source_session_id || 'inferred',
      source_tool: node.source_tool || 'codex',
      created_at: now,
      updated_at: now,
      last_seen_at: now,
    });
  }

  return inferred;
}

async function rerankWorkspaceNodes(nodes, options = {}) {
  const ranked = rankWorkspaceNodes(nodes, options);
  if (!options.query) return ranked;

  const intent = analyzeQueryIntent(options.query);
  const queryVector = await embeddings.embedText(options.query);
  const persistedEmbeddings = await store.getGraphEmbeddings(
    getActorKey(options.actor),
    'node',
    ranked.map((node) => node.node_id).filter((id) => !String(id).startsWith('inferred_')),
    embeddings.MODEL
  ).catch(() => []);
  const embeddingMap = new Map(persistedEmbeddings.map((item) => [item.target_id, item.vector]));

  const rescored = await Promise.all(ranked.map(async (node) => {
    let vector = embeddingMap.get(node.node_id);
    if (!vector || !vector.length) {
      vector = await embeddings.embedText(embeddings.buildNodeEmbeddingText(node));
      // Self-heal: persist the freshly computed vector (covers model bumps and the
      // legacy un-awaited-Promise corruption) so later queries don't recompute it.
      if (options.actor && node.node_id && !String(node.node_id).startsWith('inferred_')) {
        store.upsertGraphEmbedding({
          owner_key: getActorKey(options.actor),
          target_kind: 'node',
          target_id: node.node_id,
          model: embeddings.MODEL,
          dimensions: embeddings.DIMENSIONS,
          vector,
        }).catch(() => {});
      }
    }
    const semantic = embeddings.cosineSimilarity(queryVector, vector);
    const entityType = String(node.metadata?.entity_type || node.node_type || '').toLowerCase();
    let intentBoost = 0;
    if (intent.wantsCapabilities && ['capability', 'workflow', 'feature', 'task'].includes(entityType)) intentBoost += 0.3;
    if (intent.wantsConnections && ['tool', 'environment', 'service', 'database', 'repo'].includes(entityType)) intentBoost += 0.18;
    if (intent.wantsTools && ['capability', 'tool', 'service'].includes(entityType)) intentBoost += 0.12;
    if (intent.wantsTools && /mcp|api|dashboard|desktop|extension/.test(String(node.metadata?.surface || node.title || '').toLowerCase())) intentBoost += 0.08;
    if (intent.wantsCapabilities && ['file', 'component'].includes(entityType)) intentBoost -= 0.12;
    if (intent.wantsCapabilities && node.metadata?.discovery_source === 'inferred') intentBoost += 0.22;
    const score = Math.min(1.75, Number(node._ranking_score || 0) + semantic * 0.55 + intentBoost);
    return { ...node, _ranking_score: score };
  }));

  const sorted = rescored.sort((left, right) => Number(right._ranking_score || 0) - Number(left._ranking_score || 0));
  if (!intent.wantsCapabilities) return sorted;

  return sorted.sort((left, right) => {
    const leftType = String(left.metadata?.entity_type || left.node_type || '').toLowerCase();
    const rightType = String(right.metadata?.entity_type || right.node_type || '').toLowerCase();
    const leftIsCapability = ['capability', 'workflow', 'feature', 'task'].includes(leftType);
    const rightIsCapability = ['capability', 'workflow', 'feature', 'task'].includes(rightType);
    if (leftIsCapability === rightIsCapability) {
      return Number(right._ranking_score || 0) - Number(left._ranking_score || 0);
    }
    return leftIsCapability ? -1 : 1;
  });
}

function rankWorkspaceNodes(nodes, options = {}) {
  const queryTerms = uniqueStrings([
    options.projectName,
    options.currentTask,
    options.cwd ? options.cwd.split('/').filter(Boolean).pop() : '',
    options.query,
  ].filter(Boolean))
    .flatMap((value) => queryTermsForSearch(value));

  // Personalization terms from the user's learned profile (you_profile
  // expertise_areas). The more the profile accumulates across sessions, the more
  // the feed bends toward what this user actually works on — compounding value
  // that can't travel with an exported file.
  const expertiseTerms = uniqueStrings(options.expertiseAreas || [])
    .flatMap((value) => queryTermsForSearch(value));

  return [...nodes]
    .map((node) => {
      const text = nodeText(node);
      const lexical = queryTerms.length
        ? queryTerms.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0) / queryTerms.length
        : 0;
      // Project relevance dominates: an active-project node should outrank a
      // high-importance node from an unrelated project.
      const isActiveProject = options.projectId && node.project_id === options.projectId;
      const isCrossProject = options.projectId && node.project_id && node.project_id !== options.projectId;
      const projectMatch = isActiveProject ? 0.9 : 0;
      const crossProjectPenalty = isCrossProject ? -0.4 : 0;
      const scopedBonus = !node.project_id ? 0.05 : 0;
      const confidence = Number(node.confidence || 0) * 0.35;
      // Global importance must not let another project's "critical" dominate the
      // active project's feed — damp it heavily for cross-project nodes.
      const importance = nodeImportanceScore(node) * (isCrossProject ? 0.4 : 1);
      const memoryTier = nodeMemoryTierScore(node);
      const pinned = nodePinnedScore(node);
      const status = nodeStatusScore(node);
      const recency = nodeRecencyScore(node) * 0.2;
      const curation = isCuratedNode(node) ? 0.1 : 0;
      const usage = nodeUsageScore(node);
      const staleDecay = nodeStaleDecayScore(node);
      // Capped low so personalization tunes ordering without overriding project
      // relevance (projectMatch dominates at 0.9).
      const expertise = expertiseTerms.length
        ? Math.min(0.18, (expertiseTerms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0) / expertiseTerms.length) * 0.36)
        : 0;
      // Sort on the RAW sum, clamp only what is handed out. projectMatch alone is
      // 0.9, so nearly every active-project node summed past 1 and was clamped to
      // exactly 1.0 BEFORE the sort: they all tied, and the comparator returned 0
      // for every pair. The order that came out was the order that went in, and
      // none of lexical match, importance, pinning, usage or staleness — the
      // whole body of this function — decided anything among the nodes that
      // matter most. `_ranking_score` stays clamped to [0, 1] because readers
      // compare it against fixed floors and report it as a confidence.
      const rawScore = lexical * 0.8 + projectMatch + crossProjectPenalty + scopedBonus + confidence + importance + memoryTier + pinned + status + curation + recency + usage + staleDecay + expertise;
      return { node, rawScore, score: Math.min(1, Math.max(0, rawScore)) };
    })
    .sort((left, right) => right.rawScore - left.rawScore)
    .map((item) => ({ ...item.node, _ranking_score: item.score }));
}

const SUSPICIOUS_CONTEXT_PHRASES = [
  'auth probe',
  'authorization probe',
  'auth check',
  'authorization check',
  'connection check',
  'connectivity check',
  'debug probe',
  'smoke check',
  'smoke test',
  'test probe',
];

const SUSPICIOUS_CONTEXT_PATTERNS = [
  /\bdevelop authentication system\b/,
  /\bauth(?:entication|orization)? system\b/,
  /\bdebug-only\b/,
];

// The SUBSTRING form, for text a MODEL produced. An extraction summarising a
// session in which somebody was only poking the connector buries "auth check OK"
// mid-sentence, so a substring match is the only one that catches it there.
function isSuspiciousContextText(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return SUSPICIOUS_CONTEXT_PHRASES.some((phrase) => normalized.includes(phrase))
    || SUSPICIOUS_CONTEXT_PATTERNS.some((pattern) => pattern.test(normalized));
}

// Filler a connection test wraps around its own name: "auth check OK",
// "connection check only", "ran the smoke test again".
const CHATTER_FILLER = /\b(?:a|an|the|is|are|was|it|this|that|ok|okay|only|just|now|again|still|and|to|for|of|passed|passing|pass|failed|failing|fail|fine|good|green|works|working|worked|done|success|successful|complete|completed|run|running|ran|doing|did|another|quick|simple|small|initial|first|new)\b/g;

// The WHOLE-VALUE form, for words a PERSON typed. "smoke test", "auth check" and
// "authentication system" are ordinary engineering vocabulary, so a substring
// match against an explicit write refuses real work: "Add a smoke test for the
// billing webhook" and "Rework the authentication system for SSO" are tasks, not
// chatter. A person's value is chatter only when there is nothing left of it
// once the test phrase and its filler are taken out.
function isConnectionTestChatter(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  let residue = normalized;
  for (const phrase of SUSPICIOUS_CONTEXT_PHRASES) residue = residue.split(phrase).join(' ');
  for (const pattern of SUSPICIOUS_CONTEXT_PATTERNS) {
    residue = residue.replace(new RegExp(pattern.source, 'g'), ' ');
  }
  // Nothing matched at all, so there is nothing to judge.
  if (residue === normalized) return false;
  return !residue.replace(CHATTER_FILLER, ' ').replace(/[^a-z0-9]+/g, '').length;
}

function sanitizeContextArray(values = []) {
  return uniqueStrings(values).filter((value) => !isSuspiciousContextText(value));
}

// The list form of the whole-value check, for lists a person writes (goals,
// open questions, constraints). Same rule: an entry goes only if the entry IS
// the chatter.
function sanitizeExplicitContextArray(values = []) {
  return uniqueStrings(values).filter((value) => !isConnectionTestChatter(value));
}

// PI-01: synced context is later injected into other agents' prompts. Defang the clearest
// prompt-injection signatures at WRITE time (conservative — only acts on unambiguous override
// markers, so normal task/decision text passes through unchanged). Pairs with CSL-01 redaction.
const INJECTION_DEFANG_PATTERNS = [
  /ignore\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|preceding|earlier)\s+(?:instructions?|prompts?|context|messages?|rules?)/gi,
  /disregard\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|preceding|earlier|system)\b[^.\n]*/gi,
  /(?:^|\s)(?:system|developer)\s*prompt\s*[:=]/gi,
  /\bnew\s+(?:system\s+)?instructions?\s*[:=]/gi,
  /\boverride\s+(?:all\s+)?(?:previous|prior|safety|system)\b[^.\n]*/gi,
];

function neutralizeInjectedText(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const re of INJECTION_DEFANG_PATTERNS) out = out.replace(re, '[sanitized-instruction]');
  return out;
}

// CSL-01 + PI-01: scrub secrets and defang injection markers from a free-text value before it is
// persisted into shared context that syncs cross-tool / cross-teammate.
function cleanSyncedText(text) {
  if (typeof text !== 'string' || !text) return text;
  return neutralizeInjectedText(redactSecrets(text));
}

const DECISION_IMPORTANCE = new Set(['low', 'normal', 'high', 'critical']);

function asIsoOrNow(value) {
  if (!value) return isoNow();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? isoNow() : parsed.toISOString();
}

function normalizeDecisionEntries(values = []) {
  if (!Array.isArray(values)) return [];
  const mapped = values.map((item) => {
    if (typeof item === 'string') {
      const summary = item.trim();
      if (!summary) return null;
      return { summary, decided_at: isoNow(), importance: 'normal' };
    }
    if (!item || typeof item !== 'object') return null;
    const summary = cleanSyncedText(String(item.summary || item.title || item.text || '').trim());
    if (!summary) return null;
    const reasoning = item.reasoning == null ? undefined : cleanSyncedText(String(item.reasoning).trim());
    const importance = DECISION_IMPORTANCE.has(String(item.importance || '').toLowerCase())
      ? String(item.importance).toLowerCase()
      : 'normal';
    return {
      // Spread first so declared optional fields (confidence, source_tool,
      // date_inferred, ...) survive this normalizer; junk is stripped by
      // DecisionEntrySchema.parse downstream. Override the cleaned fields.
      ...item,
      summary,
      reasoning: reasoning || undefined,
      decided_at: asIsoOrNow(item.decided_at),
      importance,
      // Preserve resolved lifecycle so it is not wiped on every save
      ...(item.resolved ? { resolved: true, resolved_at: item.resolved_at || isoNow() } : {}),
    };
  }).filter(Boolean);
  return mapped.slice(-20);
}

function normalizeCommandEntries(values = []) {
  if (values == null) return [];
  const entries = Array.isArray(values) ? values : [values];
  const mapped = entries.map((item, index) => {
    if (typeof item === 'string') {
      const run = redactSecrets(item.trim());
      if (!run) return null;
      return { label: `cmd_${index + 1}`, run };
    }
    if (!item || typeof item !== 'object') return null;
    const label = String(item.label || item.name || '').trim();
    // CSL-01: redact secrets out of captured command text before it is stored + injected.
    const run = redactSecrets(String(item.run || item.command || '').trim());
    if (!label || !run) return null;
    const note = item.note == null ? undefined : cleanSyncedText(String(item.note).trim());
    return { label, run, note: note || undefined };
  }).filter(Boolean);
  return mapped.slice(-20);
}

function normalizeHotPaths(values = []) {
  if (!Array.isArray(values)) return [];
  return values
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const label = String(item.label || '').trim();
      const path = String(item.path || '').trim();
      if (!label || !path) return null;
      const purpose = item.purpose == null ? undefined : String(item.purpose).trim();
      // Spread first so declared optional fields (importance, pinned, ...) survive;
      // junk is stripped by HotPathEntrySchema.parse downstream.
      return { ...item, label, path, purpose: purpose || undefined };
    })
    .filter(Boolean)
    .slice(-40);
}

function normalizeEntrypoints(values = []) {
  if (!Array.isArray(values)) return [];
  return values
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const label = String(item.label || '').trim();
      const path = String(item.path || '').trim();
      if (!label || !path) return null;
      const purpose = item.purpose == null ? undefined : String(item.purpose).trim();
      return { label, path, purpose: purpose || undefined };
    })
    .filter(Boolean)
    .slice(-20);
}

function normalizeSurfaces(values = []) {
  if (!Array.isArray(values)) return [];
  return values
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const label = String(item.label || '').trim();
      if (!label) return null;
      const paths = sanitizeContextArray(Array.isArray(item.paths) ? item.paths : []);
      const purpose = item.purpose == null ? undefined : String(item.purpose).trim();
      return { label, paths, purpose: purpose || undefined };
    })
    .filter(Boolean)
    .slice(-20);
}

function normalizeDebuggingNotes(values = []) {
  if (!Array.isArray(values)) return [];
  return values
    .map((item) => {
      if (typeof item === 'string') {
        const summary = item.trim();
        if (!summary) return null;
        return { summary, paths: [], added_at: isoNow() };
      }
      if (!item || typeof item !== 'object') return null;
      const summary = String(item.summary || item.text || '').trim();
      if (!summary) return null;
      const paths = sanitizeContextArray(Array.isArray(item.paths) ? item.paths : []);
      // Spread item first so EVERY declared optional field (commit_ref, diff_ref,
      // confidence, source_tool, verified_at, ...) is preserved through this
      // normalizer — undeclared junk is stripped downstream by
      // DebuggingNoteEntrySchema.parse. This normalizer reruns on every
      // update_context PATCH (normalizeContextForSchema -> repairProjectIntegrity),
      // so rebuilding the note field-by-field here silently stripped those anchors
      // off existing notes whenever any unrelated field was patched. Override the
      // fields we sanitize/normalize. "Teach once": new optional fields survive
      // without re-editing this normalizer.
      return {
        ...item,
        summary,
        paths,
        added_at: asIsoOrNow(item.added_at),
      };
    })
    .filter(Boolean)
    .slice(-30);
}

// LANDMINE slot normalizer. Spread item first so EVERY declared optional field
// (importance, pinned, confidence, source_tool, source_session_id, date_inferred,
// verified_at, verified_commit) survives this normalizer — it reruns on every save
// (normalizeContextForSchema -> repairProjectIntegrity), so rebuilding field-by-
// field would silently strip provenance off existing landmines. Junk is stripped
// downstream by LandmineEntrySchema.parse. "Teach once": new optional fields
// survive without re-editing this normalizer.
function normalizeLandmines(values = []) {
  if (!Array.isArray(values)) return [];
  return values
    .map((item) => {
      if (typeof item === 'string') {
        const summary = item.trim();
        if (!summary) return null;
        return { summary, paths: [], added_at: isoNow() };
      }
      if (!item || typeof item !== 'object') return null;
      const summary = cleanSyncedText(String(item.summary || item.text || '').trim());
      if (!summary) return null;
      const paths = sanitizeContextArray(Array.isArray(item.paths) ? item.paths : []);
      return {
        ...item,
        summary,
        paths,
        added_at: asIsoOrNow(item.added_at),
      };
    })
    .filter(Boolean)
    .slice(-20);
}

// SHIPPED slot normalizer. Spread item first so provenance (source_tool,
// confidence, commit_ref, pinned) survives. Append-style accumulator capped at the
// most recent 15 (evict oldest).
function normalizeShipped(values = []) {
  if (!Array.isArray(values)) return [];
  return values
    .map((item) => {
      if (typeof item === 'string') {
        const summary = item.trim();
        if (!summary) return null;
        return { summary, shipped_at: isoNow() };
      }
      if (!item || typeof item !== 'object') return null;
      const summary = cleanSyncedText(String(item.summary || item.text || '').trim());
      if (!summary) return null;
      return {
        ...item,
        summary,
        shipped_at: asIsoOrNow(item.shipped_at),
      };
    })
    .filter(Boolean)
    .slice(-15);
}

function normalizeContextForSchema(project) {
  const context = project?.context || {};
  // THIS RUNS OVER TEXT THAT IS ALREADY STORED. repairProjectIntegrity
  // re-normalizes the whole context on every read and write, so a filter that
  // blanks on a substring does not only refuse incoming chatter — it eats a task
  // a person saved weeks ago, on the next write that touches anything else. The
  // fields a person authors get the whole-value check; only source_summary, the
  // extraction's own one-line description of what it saw, keeps the substring
  // form, because that is exactly where probe chatter is described mid-sentence.
  const sanitizeField = (value) => {
    if (typeof value !== 'string') return '';
    return isConnectionTestChatter(value) ? '' : value;
  };
  const sanitizeMachineField = (value) => {
    if (typeof value !== 'string') return '';
    return isSuspiciousContextText(value) ? '' : value;
  };
  // A STATUS THAT ONLY QUOTES THE STORED TASK IS THE SERVER'S OWN COMPOSITION.
  //
  // The same argument as current_task below, one field over. finish_task writes
  // `Completed: <the stored task>`, so re-running the whole-value check over
  // ALREADY STORED text blanked the completion again on the next write that
  // touched anything else — the brief reverting to no status under a task
  // everything else agreed was done. Only against a task a person SET: an
  // extracted task is blanked here itself, and a status quoting one has nothing
  // to stand on.
  const explicitTask = context.current_task_source === 'explicit'
    ? normalizeText(context.current_task || '')
    : '';
  const sanitizeStatusField = (value) => {
    if (typeof value !== 'string') return '';
    if (explicitTask && normalizeText(value).includes(explicitTask)) return value;
    return sanitizeField(value);
  };
  return {
    ...context,
    project_name: project?.project_name || context.project_name || 'Untitled project',
    description: sanitizeField(context.description),
    goals: sanitizeExplicitContextArray(Array.isArray(context.goals) ? context.goals : []),
    current_status: sanitizeStatusField(context.current_status),
    recent_decisions: normalizeDecisionEntries(context.recent_decisions),
    recurring_context: sanitizeExplicitContextArray(Array.isArray(context.recurring_context) ? context.recurring_context : []),
    tech_stack: sanitizeExplicitContextArray(Array.isArray(context.tech_stack) ? context.tech_stack : []),
    file_structure_summary: sanitizeExplicitContextArray(Array.isArray(context.file_structure_summary) ? context.file_structure_summary : []),
    // A task somebody SET is their own words, and this runs over text that is
    // ALREADY STORED: leaving the check on here would re-blank "Run the smoke
    // test" on the next write that touched anything else, which is the erasure
    // the whole-value form was introduced to stop, one field narrower. An
    // extracted task keeps the check — that is where probe wording comes from.
    current_task: context.current_task_source === 'explicit'
      ? (typeof context.current_task === 'string' ? context.current_task : '')
      : sanitizeField(context.current_task),
    open_questions: sanitizeExplicitContextArray(Array.isArray(context.open_questions) ? context.open_questions : []),
    commands: normalizeCommandEntries(context.commands),
    hot_paths: normalizeHotPaths(context.hot_paths),
    entrypoints: normalizeEntrypoints(context.entrypoints),
    surfaces: normalizeSurfaces(context.surfaces),
    debugging_notes: normalizeDebuggingNotes(context.debugging_notes),
    // Brief-spine slots — MUST be preserved here or every save wipes them (these
    // fields are not enumerated elsewhere, so the field-by-field rebuild drops them).
    landmines: normalizeLandmines(context.landmines),
    shipped: normalizeShipped(context.shipped),
    source_summary: sanitizeMachineField(context.source_summary),
    blocking_issue: sanitizeField(context.blocking_issue),
    task_progress: sanitizeField(context.task_progress),
    last_updated: asIsoOrNow(context.last_updated),
  };
}

function buildIntegrityRepairPatch(project) {
  const context = project?.context || {};
  const normalized = normalizeContextForSchema(project);
  const patch = {};

  for (const [key, value] of Object.entries(normalized)) {
    if (JSON.stringify(context[key]) !== JSON.stringify(value)) {
      patch[key] = value;
    }
  }

  return patch;
}

async function repairProjectIntegrity(project, options = {}) {
  const persist = options.persist !== false;
  if (!project) return null;
  // The repair patch treats every absent section as corrupt and normalises it to
  // ''/[] — which, on a section-filtered view, is precisely the data loss.
  if (persist && isSectionFilteredContext(project.context)) {
    throw new Error(
      `repairProjectIntegrity: refusing to persist a section-filtered context for ${project.project_id} — ` +
      'load the raw row for writes'
    );
  }
  const patch = buildIntegrityRepairPatch(project);
  if (!Object.keys(patch).length) return project;

  const updated = {
    ...project,
    context: {
      ...project.context,
      ...patch,
      last_updated: isoNow(),
    },
    updated_at: isoNow(),
  };

  if (persist) {
    await store.saveProject(updated, null);
    await recordEvent(updated, 'system', 'integrity-repair', 'manual_override', {
      repaired_fields: Object.keys(patch),
    }, 1);
  }

  return updated;
}

function sanitizeExtraction(project, extraction) {
  const next = {
    ...extraction,
    delta: { ...(extraction.delta || {}) },
  };
  // THE PROFILE IS NEVER LEARNED FROM A PROJECT. A note in one project that
  // reads like a goal or a working style used to be merged into the person's
  // account-wide profile, which prints in every brief they open, unrelated
  // projects included. The profile is written only by what the person says
  // about themselves (PATCH /context/global, the dashboard "You" page).
  delete next.delta.you_profile;
  const current = project?.context || {};

  // Pre-write confidence gate. Below the floor we don't trust the extraction
  // enough to mutate the durable vault at all, so we drop the whole delta rather
  // than letting marginal signals through and relying on later cleanup. Only the
  // LLM extraction path reaches here; deterministic structured events
  // (applyStructuredContextEvent, confidence 1) bypass this entirely.
  if (Number(extraction?.confidence || 0) < WRITE_CONFIDENCE_FLOOR) {
    return {
      ...next,
      delta: {},
      no_material_change: true,
      suppression_reason: 'low_confidence',
    };
  }

  // AN EXPLICIT TASK IS NOT THE MODEL'S TO REPLACE. It stands until it is
  // completed (task_completed / finish_task release it) or somebody sets another.
  // next_action goes with it: it is the cursor INSIDE that task.
  if (isExplicitTaskProtected(current)) {
    delete next.delta.current_task;
    delete next.delta.next_action;
  }
  // Provenance is the server's to stamp, never a model's to claim.
  delete next.delta.current_task_source;
  delete next.delta.current_task_set_at;

  for (const key of ['description', 'current_status', 'current_task', 'source_summary']) {
    if (!next.delta[key]) continue;
    const candidate = String(next.delta[key] || '').trim();
    const existing = String(current[key] || '').trim();
    if (!candidate || normalizeText(candidate) === normalizeText(existing)) {
      delete next.delta[key];
      continue;
    }
    if (isSuspiciousContextText(candidate)) {
      delete next.delta[key];
      continue;
    }
    if (extraction.confidence < 0.72 && isGenericText(candidate)) {
      delete next.delta[key];
      continue;
    }
    // Task drift guard: never let a vague task overwrite a specific one. If we
    // already track a concrete current_task, a generic replacement is almost
    // always extraction drift, not a real change.
    if (key === 'current_task' && existing && isGenericText(candidate) && !isGenericText(existing)) {
      delete next.delta[key];
    }
  }

  for (const key of ['goals', 'tech_stack', 'file_structure_summary', 'open_questions', 'recurring_context']) {
    if (!Array.isArray(next.delta[key])) continue;
    const deduped = sanitizeContextArray(next.delta[key]).filter((item) => !uniqueStrings(current[key] || []).some((existing) => dedupeKey(existing) === dedupeKey(item)));
    if (deduped.length) {
      next.delta[key] = deduped;
    } else {
      delete next.delta[key];
    }
  }

  if (Array.isArray(next.delta.recent_decisions)) {
    // Compared AS STORED. A decision is cleaned on its way to the row
    // (cleanSyncedText: secret redaction and injection defanging), so a text
    // the cleaning rewrites never matched its own stored copy here: an
    // in-session save followed by the end-of-session capture of the same words
    // filed the decision twice (journey BLOCKED 13). appendRecentDecision, the
    // explicit path, already compares the cleaned form.
    const storedKey = (summary) => dedupeKey(cleanSyncedText(String(summary || '')));
    const seenDecisions = new Set((current.recent_decisions || []).map((item) => storedKey(item.summary)));
    const filtered = next.delta.recent_decisions.filter(
      (item) => item?.summary && !seenDecisions.has(storedKey(item.summary)) && !isVagueDecision(item.summary),
    );
    if (filtered.length) {
      next.delta.recent_decisions = filtered;
    } else {
      delete next.delta.recent_decisions;
    }
  }

  if (!isMeaningfulDelta(next.delta)) {
    return {
      ...next,
      delta: {},
      no_material_change: true,
    };
  }

  if (next.delta.current_task) {
    next.delta.current_task_source = 'extracted';
    next.delta.current_task_set_at = isoNow();
  }

  return next;
}

// Null = no expiry: an explicit task stands until it is completed or replaced.
// A number of days makes protection lapse on a task nobody has touched for that
// long, so an abandoned explicit task cannot pin the brief forever.
const EXPLICIT_TASK_PROTECT_DAYS = Number(process.env.EXPLICIT_TASK_PROTECT_DAYS) > 0
  ? Number(process.env.EXPLICIT_TASK_PROTECT_DAYS)
  : null;

function isExplicitTaskProtected(context = {}) {
  if (context.current_task_source !== 'explicit') return false;
  if (!String(context.current_task || '').trim()) return false;
  if (context.task_progress === 'completed') return false;
  if (EXPLICIT_TASK_PROTECT_DAYS === null) return true;
  const setAt = Date.parse(context.current_task_set_at || '');
  if (Number.isNaN(setAt)) return true;
  return Date.now() - setAt < EXPLICIT_TASK_PROTECT_DAYS * 86_400_000;
}

function buildConservativeBrowserFallback(global, verbosity) {
  const base = global
    ? formatGlobalOnlyInjection(global, verbosity)
    : { format: 'conversational', verbosity, body: '' };
  const lines = [
    base.body,
    'Session memory is temporarily uncertain about the active project.',
  ].filter(Boolean);
  return {
    ...base,
    body: lines.join('\n'),
  };
}

function buildConservativeFallback(global, verbosity, surface) {
  if (surface === 'browser') return buildConservativeBrowserFallback(global, verbosity);
  const base = global
    ? formatGlobalOnlyInjection(global, verbosity)
    : { format: 'code', verbosity, body: '' };
  return {
    tool: 'cursor',
    format: 'code',
    verbosity,
    body: [base.body, 'Session memory is temporarily uncertain about the active project.'].filter(Boolean).join('\n'),
  };
}

function makeInjectionHistoryKey(ownerKey, sessionId, tool) {
  return `${ownerKey}:${sessionId}:${tool}`;
}

function makeInjectionFingerprint(tool, body) {
  return crypto.createHash('sha1').update(`${tool}\n${body}`).digest('hex');
}

function normalizeSectionLine(line) {
  const text = String(line || '').trim();
  if (!text) return '';
  const separatorIndex = text.indexOf(': ');
  if (separatorIndex === -1) return text.toLowerCase();
  const label = text.slice(0, separatorIndex);
  const rawValue = text.slice(separatorIndex + 2);
  if (['knowledge web', 'related projects', 'cross-project evidence', 'evidence', 'relevant files'].includes(label.toLowerCase())) {
    const normalizedParts = rawValue
      .split(' | ')
      .map((part) => normalizeText(part))
      .filter(Boolean)
      .sort();
    return `${label.toLowerCase()}:${normalizedParts.join('|')}`;
  }
  return `${label.toLowerCase()}:${normalizeText(rawValue)}`;
}

function makeSectionFingerprintSignature(body) {
  return String(body || '')
    .split('\n')
    .map((line) => normalizeSectionLine(line))
    .filter(Boolean)
    .sort()
    .join('\n');
}


/**
 * Turn incoming decisions into stored ones: resolve who wrote each.
 *
 * Two sources of authorship, in priority order:
 *   1. `author_email` — a git author carried in by an import. It is looked up
 *      against the workspace roster and REPLACED by the member's id; an email
 *      matching nobody resolves to null, because an ex-colleague's commits must
 *      not conjure a member who was never here. The email never persists.
 *   2. The acting person, for anything written by a live session.
 *
 * The email is stripped either way — the wire carries an address, storage
 * carries an id, and leaving the address behind would put a personal email into
 * every teammate's brief.
 */
async function resolveDecisionAuthors(entries, ownerKey, contributor) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return list;

  const emails = new Set(
    list.map((e) => (e?.author_email ? String(e.author_email).toLowerCase() : null)).filter(Boolean)
  );

  let byEmail = new Map();
  if (emails.size) {
    // Only pay for the roster when an import actually carried git authorship.
    const members = await workspace.listMembers(ownerKey, { includeRemoved: true }).catch(() => []);
    byEmail = new Map(
      members.filter((m) => m.email).map((m) => [String(m.email).toLowerCase(), m.user_id])
    );
  }

  return list.map((entry) => {
    if (!entry) return entry;
    const { author_email: authorEmail, ...rest } = entry;
    if (rest.contributed_by) return rest;
    if (authorEmail) {
      const resolved = byEmail.get(String(authorEmail).toLowerCase()) || null;
      // Null is a real answer and renders as unattributed. Falling back to the
      // importer here would credit them with everything their colleagues wrote.
      return resolved ? { ...rest, contributed_by: resolved } : rest;
    }
    return contributor ? { ...rest, contributed_by: contributor } : rest;
  });
}

// WHAT A PROJECT'S EVENT LOG MAY HOLD: the project's own changes. A delta also
// carries fields that are not the project's at all — the "you" profile is
// written to the CALLER'S OWN profile row (updateGlobalContext) and nowhere
// else. Logged with the delta, a member's goals and working style learned in a
// teammate's project were stored in that project's context_events, in the
// clear, and outlived the member's own erasure, which sweeps events only in
// their personal projects (scan 34 a/F2). They never enter the log.
const PERSON_ONLY_DELTA_FIELDS = Object.freeze(['you_profile']);

function projectEventDelta(delta) {
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) return delta;
  if (!PERSON_ONLY_DELTA_FIELDS.some((field) => field in delta)) return delta;
  const kept = { ...delta };
  for (const field of PERSON_ONLY_DELTA_FIELDS) delete kept[field];
  return kept;
}

async function recordEvent(project, sourceType, sourceId, eventKind, delta, confidence = 1, contributingUserId = null) {
  const event = {
    event_id: makeId('evt'),
    project_id: project.project_id,
    source_type: sourceType,
    source_id: sourceId,
    event_kind: eventKind,
    delta: projectEventDelta(delta),
    confidence,
    contributing_user_id: contributingUserId || null,
    created_at: isoNow(),
  };
  project.events.push(event);
  await store.appendEvent(event);
}

// WHO MAY SEE WHICH PROJECT, FOR EVERY LISTING: the live one and the archived
// one. Two listings that each spelled their own filter drifted: the archived
// feed asked the store's SQL question only, so a shared project whose sharing
// had been switched off (a share row with enabled=false) was absent from a
// teammate's live listing and named, with its id, in their archived one.
//
// The scope is the store's half (visibilityClause); viewableWithPolicies is the
// service's half (canViewProjectForActor under the project's share policy).
async function projectListingScope(actor) {
  const ownerKey = getActorKey(actor);
  // A system actor (internal jobs, the shared dev key) has no person to scope by
  // and says so explicitly — the store now refuses an unattributed listing
  // rather than quietly returning the whole workspace.
  const isSystem = actor?.type === 'system' || ownerKey === 'org-system';
  return {
    ownerKey,
    system: isSystem,
    actorIdentities: workspace.actorIdentities(actor),
    // A workspace owner lists org-owned private work; nobody lists somebody
    // else's personal work. By role, not by today's member count — see
    // resolveIsWorkspaceOwner.
    isWorkspaceOwner: !isSystem && await resolveIsWorkspaceOwner(actor, ownerKey),
  };
}

// The rows this actor may read, each with the policy it was judged by. One
// batch for every project's policy (see getProjectSharePolicies).
async function viewableWithPolicies(actor, projects) {
  const policies = await getProjectSharePolicies(actor, projects);
  const out = [];
  for (const project of projects) {
    if (!project) continue;
    const policy = policies.get(project.project_id);
    if (canViewProjectForActor(actor, project, policy)) out.push({ project, policy });
  }
  return out;
}

async function listProjects(actor, { includeArchived = false } = {}) {
  // Filter in SQL as well as in the loop below. The loop already dropped
  // unviewable projects from the RESULT, but only after the store had selected
  // every project in the workspace — so any caller reading store.listProjects
  // directly (the topic picker, extraction's matcher, portfolio) still saw them.
  // The store-level filter is the one that holds for all of them.
  const scope = await projectListingScope(actor);
  const projects = await store.listProjects(scope.ownerKey, {
    includeArchived,
    system: scope.system,
    actorIdentities: scope.actorIdentities,
    isWorkspaceOwner: scope.isWorkspaceOwner,
  });
  const repaired = await Promise.all(projects.map((project) => repairProjectIntegrity(project, { persist: false })));
  const visible = [];
  for (const { project, policy } of await viewableWithPolicies(actor, repaired)) {
    if (!isProjectOwner(actor, project) && project.visibility === 'shared' && policy.enabled) {
      visible.push({
        ...project,
        context: filterContextBySectionPolicy(project.context || {}, policy.sections),
      });
    } else {
      visible.push(project);
    }
  }
  return visible;
}

// Every refusal createProject can give BEFORE it writes: the viewer gate, the
// name checks, the duplicate and the plan cap. Its own function so a dry run
// (Trail import) predicts exactly the refusal the real creation gives — a dry
// run that says "fine" over a name the import then refuses as a duplicate is a
// prediction nobody can use. Returns the name the project will be created with.
async function assertProjectCreatable(actor, input) {
  const ownerKey = getActorKey(actor);
  // Before anything else: in a team workspace a new project is born SHARED, so a
  // viewer creating one would be publishing into the workspace they may only read.
  await assertWorkspaceWritable(actor, ownerKey);
  // Internal auto-create flows (extraction, topic binding) opt into the lenient
  // legacy behavior below via allow_fallback_name — there's no user in the loop
  // to fix a rejected/duplicate name, so they fall back to a safe generic
  // instead of ever throwing. Every OTHER creation path (the API route, the
  // create_project MCP tool) is explicit and user-driven, so it gets the SAME
  // hard gate rename_project already uses — a junk or duplicate name is a
  // mistake worth surfacing, not silently coerced into "Untitled project".
  const allowFallbackName = input.allow_fallback_name === true;
  let projectName;
  if (allowFallbackName) {
    projectName = sanitizeProjectName(input.project_name);
  } else {
    if (isTooShortProjectName(input.project_name)) {
      // A single character isn't junk, it's just too short — say so specifically rather
      // than telling the user their name looks like a file path or a placeholder.
      const err = new Error('project_name_too_short');
      err.publicMessage = `project_name_too_short: "${String(input.project_name).trim()}" is only 1 character. Project names need at least ${MIN_PROJECT_NAME_LENGTH} — try something longer.`;
      throw err;
    }
    if (!isValidProjectName(input.project_name)) {
      const err = new Error('invalid_project_name');
      err.publicMessage = 'invalid_project_name: project names can\'t be empty, a file path, or a placeholder like "Untitled". Provide a real, descriptive name.';
      throw err;
    }
    projectName = String(input.project_name).trim();

    // Reject exact duplicates (by normalized name or alias) for explicit
    // creation — a "create a new project" call should not silently produce a
    // second row for a name that already exists. (Auto-create flows have their
    // own dedup-by-merge path above this function, at the findProjectByName
    // call in applyExtraction, so they never reach here with a real duplicate.)
    const existingByName = await findProjectByName(actor, projectName);
    if (existingByName) {
      const err = new Error('duplicate_project_name');
      err.existing_project_id = existingByName.project_id;
      err.publicMessage = `duplicate_project_name: a project named "${existingByName.project_name}" already exists (${existingByName.project_id}). Use that project, or pick a different name.`;
      throw err;
    }
  }

  // Workspace cap (free: 1; paid: uncapped via null). Enforced at this choke
  // point so every creation path — API route, MCP create_project, session
  // binding, extraction auto-create — hits the same gate. Subprojects are
  // exempt: they're workstreams of an existing workspace, not a new slot.
  if (!input.parent_project_id) {
    const cap = (await getOwnerEntitlements(actor))?.limits?.included_projects;
    if (Number.isFinite(cap)) {
      const existing = await store.countTopLevelProjects(ownerKey);
      if (existing >= cap) {
        const err = new Error('project_limit_exceeded');
        err.status = 422;
        err.upgrade_required = true;
        err.publicMessage = `Your plan includes ${cap} project brief${cap === 1 ? '' : 's'}. Upgrade to ${PLANS.developer_basic.publicName} for unlimited projects and permanent memory — nothing gets deleted, and your existing briefs keep working.`;
        throw err;
      }
    }
  }
  return projectName;
}

async function createProject(actor, input) {
  const ownerKey = getActorKey(actor);
  const projectName = await assertProjectCreatable(actor, input);

  // Subproject: validate the parent before creating the child. Enforced here
  // (not in the DB column): the parent must exist under the same owner and be
  // top-level, so the hierarchy stays exactly one level deep. A brand-new row
  // can't form a cycle or already have children, so those checks don't apply on
  // create — see setProjectParent for the re-parent path where they do.
  let parentProjectId = null;
  let parentWorkspaceKey = null;
  let parentVisibility = null;
  if (input.parent_project_id) {
    // READ THROUGH THE CALLER'S EYES. This read the raw row, so a member could
    // file a subproject under a colleague's personal project — one they cannot
    // read, and whose existence the "not found" is meant to keep from them.
    // A parent the caller cannot read is indistinguishable from none.
    const parent = await getProject(actor, input.parent_project_id);
    if (!parent) throw new Error('parent_project_not_found');
    parentVisibility = parent.visibility || null;
    if (parent.parent_project_id) throw new Error('subproject_depth_exceeded');
    parentProjectId = parent.project_id;
    parentWorkspaceKey = parent.workspace_key || null;
  }

  // WHICH CODEBASE THIS PROJECT BELONGS TO, FROM BIRTH.
  //
  // workspace_key was only ever stamped by applyExtraction, on the first write
  // that happened to carry one. So a project created and then immediately
  // pinned (create a subproject, switch to it — the documented flow) had no key,
  // the pin lookup requires the pinned candidate to be in the caller's
  // workspace, and the switch reported success while the next session opened on
  // something else. The caller's key wins; a subproject with none inherits its
  // parent's, because a work-stream lives in its umbrella's repo unless somebody
  // says otherwise. No key and no parent key stays null: a hosted caller has no
  // repo and nothing is invented for it.
  const suppliedWorkspaceKey = typeof input.workspace_key === 'string' ? input.workspace_key.trim() : '';
  const workspaceKey = suppliedWorkspaceKey || parentWorkspaceKey || null;

  // A project made INSIDE a shared workspace is shared with that workspace; one
  // made in a solo workspace is private.
  //
  // The distinction that matters is between these two and a third case: a project
  // that already existed when the workspace was solo. Those stay private when a
  // second member arrives (workspaceService.backfillProjectOwnership stamps them
  // to the founder), because inviting a colleague must never publish the history
  // you accumulated before they were there. Only new work defaults to shared, and
  // any project can be switched back to private.
  const sharedWorkspace = await workspace.isSharedWorkspace(ownerKey).catch(() => false);
  const authorId = workspace.actorPersonId(actor);

  const project = {
    project_id: makeId('project'),
    owner_key: ownerKey,
    owner_user_id: authorId,
    visibility: newProjectVisibility(actor, { sharedWorkspace, authorId, parentVisibility }),
    parent_project_id: parentProjectId,
    workspace_key: workspaceKey,
    project_name: projectName,
    aliases: [],
    linked_paths: input.linked_paths ?? [],
    linked_conversations: [],
    context: createContextObject({
      project_name: projectName,
      category: input.category,
      description: input.description,
      goals: input.goals,
      current_status: input.current_status,
      recurring_context: input.recurring_context,
      tech_stack: input.tech_stack,
      file_structure_summary: input.file_structure_summary,
      current_task: input.current_task,
      open_questions: input.open_questions,
      hot_paths: input.hot_paths,
      entrypoints: input.entrypoints,
      surfaces: input.surfaces,
      debugging_notes: input.debugging_notes,
      landmines: input.landmines,
      source_summary: 'Created by context-sync API',
    }),
    events: [],
    created_at: isoNow(),
    updated_at: isoNow(),
  };

  await store.saveProject(project, actor);
  // The creator is on record (journey r7): one of the per-person records a project
  // whose author stamp later stops resolving is judged from.
  await recordEvent(project, 'system', 'context-api', 'project_created', {
    project_name: project.project_name,
    description: project.context.description,
  }, 1, workspace.actorPersonId(actor));

  return project;
}

// WHO READS A NEW PROJECT (journey r4, the owner's decision).
//
// In a one-person workspace nobody else reads anything: 'private', as always.
// In a workspace with more than one member:
//   - created by an AI TOOL — anything holding a credential rather than a
//     dashboard session: the hosted connectors and the local server's
//     manage_projects create, and the project the capture path creates — it
//     starts 'personal': only its author reads it, and they share it
//     afterwards. A tool creating a project mid-conversation for somebody's
//     side work used to publish it to every member, before they had said a
//     word about who should read it.
//   - a SUB-PROJECT a tool creates starts with its parent's visibility (the
//     owner's decision, journey r4): under a shared parent it is shared, under
//     a personal one personal, under a private one private. The team that
//     reads a parent reads its children. Moving a project under a parent later
//     does not change its visibility (setProjectParent).
//   - created in the DASHBOARD (a signed-in session, which offers the choice
//     where it is made): 'shared', as before.
// A credential that names no person (an internal actor, a key minted before
// keys carried their owner) keeps today's default: 'personal' with no author is
// a project nobody can read.
function newProjectVisibility(actor, { sharedWorkspace, authorId, parentVisibility = null }) {
  if (!sharedWorkspace) return 'private';
  if (actor?.type === 'key' && authorId) {
    return ['shared', 'private', 'personal'].includes(parentVisibility) ? parentVisibility : 'personal';
  }
  return 'shared';
}

// Where a project is and who reads it, in the words a create or select reply
// uses (journey round 2, round 4). '' in a one-person workspace, where nobody
// else reads anything and the reply is unchanged. READ BACK from the stored
// row: the service decides visibility, not the request. Best-effort: a create
// that succeeded never reports failure over this. Both dispatchers send it:
// the hosted one in-process, the local one from POST /projects'
// placement_note.
async function describeProjectPlacement(actor, projectId, { shareHint = false } = {}) {
  const project = await getProject(actor, projectId).catch(() => null);
  if (!project?.owner_key) return '';
  if (!(await workspace.isSharedWorkspace(project.owner_key).catch(() => false))) return '';
  const label = await workspaceLabel(project.owner_key).catch(() => 'this workspace');
  const mine = workspace.actorIdentities(actor).includes(project.owner_user_id);
  const readers = {
    shared: `shared with the members of ${label}`,
    private: mine ? 'private to you and the workspace\'s owners' : 'private to its author and the workspace\'s owners',
    personal: mine ? 'personal, readable only by you' : 'personal, readable only by its author',
  }[project.visibility];
  if (!readers) return ` It belongs to the workspace ${label}.`;
  // HOW TO SHARE IT, for the one person who can: its author, in the reply to
  // the create that made it personal (select's reply is unchanged). The
  // dashboard's own words — the team settings page, its "What this team can
  // see" list and its "Shared with the team" choice. No tool changes sharing.
  const share = shareHint && mine && project.visibility === 'personal'
    ? ' To share it with the team, open the dashboard\'s team settings and set it to "Shared with the team" under "What this team can see".'
    : '';
  return ` It belongs to the workspace ${label} and is ${readers}.${share}`;
}

// Re-parent an EXISTING project: attach it under an umbrella (backfill / move
// between parents) or promote it back to top-level with parentProjectId = null.
// Enforces the invariants the DB column deliberately leaves to the service:
//   - same owner (getProject is owner-scoped, so a returned row is same-owner)
//   - one level deep: the parent must itself be top-level, AND this project must
//     have no children of its own (moving it under a parent would orphan them a
//     level too far). These two rules together also make a cycle impossible.
// ONE GUARD FOR EVERY STRUCTURAL MUTATION OF A PROJECT.
//
// archive, unarchive, reparent and switch all took a project_id and acted on it
// scoped by owner_key ALONE. On a solo workspace owner_key is the person, so that
// was indistinguishable from a permission check; on a shared workspace it stopped
// being one. Any member — including a viewer — could archive a teammate's private
// project, and manage_projects exposes archive/restore directly over MCP, so the
// reach was the whole agent surface. The project would drop out of its owner's
// listing and out of active-project resolution, and their next session would start
// cold on work the caller was never permitted to read.
//
// Visibility first (an invisible project must 404, not 403, or the refusal itself
// confirms it exists), then authority: its owner, or someone who administers the
// workspace.
async function assertProjectMutable(actor, projectId, doing = 'change') {
  const loaded = await loadProjectForWrite(actor, projectId, { requireWriteRole: false, allowArchived: true });
  if (!loaded) throw new Error('project_not_found');
  if (!holdsProjectPowers(actor, loaded.project, loaded.policy)) {
    // A project the caller can READ but may not manage: shared, where a member
    // is not the author, or private, where the author is still a member. Told
    // why, rather than answered as if it were not there.
    if (loaded.project.visibility === 'shared' || loaded.project.visibility === 'private') {
      throw projectPowersRefusal(loaded.project, doing);
    }
    throw new Error('project_not_found');
  }
  return loaded.project;
}

// The permission check runs once; the read-and-save is guarded like every
// whole-row save and re-runs from a fresh read (withContextWriteRetry).
async function setProjectParent(actor, projectId, parentProjectId = null) {
  await assertProjectMutable(actor, projectId, 'move');
  return withContextWriteRetry(() => setProjectParentOnce(actor, projectId, parentProjectId));
}

async function setProjectParentOnce(actor, projectId, parentProjectId = null) {
  const ownerKey = getActorKey(actor);
  const project = await store.getProject(ownerKey, projectId);
  if (!project) throw new Error('project_not_found');

  if (parentProjectId) {
    if (parentProjectId === projectId) throw new Error('project_cannot_parent_itself');
    // The same rule as a create: a parent the caller cannot read is none.
    const parent = await getProject(actor, parentProjectId);
    if (!parent) throw new Error('parent_project_not_found');
    if (parent.parent_project_id) throw new Error('subproject_depth_exceeded');
    const children = await store.getSubprojects(ownerKey, projectId, {
      actorIdentities: workspace.actorIdentities(actor),
      system: actor?.type === 'system' || ownerKey === 'org-system',
      // Same answer as the flat list, or an owner sees a project in one place
      // and not the other.
      isWorkspaceOwner: (await workspace.resolveRole(actor, ownerKey).catch(() => null)) === 'owner',
    });
    if (children.length) {
      // The condition being enforced is about the project BEING MOVED, not the
      // umbrella it's moving under — name the error after the real offender so
      // the caller knows what to fix (move/archive the children first).
      const err = new Error('project_has_subprojects');
      err.publicMessage = `project_has_subprojects: "${project.project_name}" has ${children.length} subproject${children.length === 1 ? '' : 's'} of its own, so it can't be nested under another umbrella (hierarchy is one level deep). Move or archive its subprojects first.`;
      throw err;
    }
  }

  const updated = { ...project, parent_project_id: parentProjectId || null, updated_at: isoNow() };
  await saveProjectGuarded(updated, actor);
  await recordEvent(updated, 'system', 'context-api', 'project_merged', {
    project_name: updated.project_name,
    parent_project_id: parentProjectId || null,
  });
  return updated;
}

// Portfolio view: top-level projects, each with its subprojects nested under a
// `subprojects` array. An orphan (subproject whose parent isn't in the visible
// set) surfaces as its own root so nothing is ever hidden. Ordering follows
// listProjects (updated_at DESC) at every level.
async function listProjectTree(actor) {
  const projects = await listProjects(actor);
  const byId = new Map(projects.map((p) => [p.project_id, p]));
  const childrenOf = new Map();
  const roots = [];
  for (const p of projects) {
    const parentId = p.parent_project_id;
    if (parentId && byId.has(parentId)) {
      if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
      childrenOf.get(parentId).push(p);
    } else {
      roots.push(p);
    }
  }
  return roots.map((r) => ({ ...r, subprojects: childrenOf.get(r.project_id) || [] }));
}

// Explicit active-subproject switch for a codebase: pin `projectId` as active for
// `workspaceKey` so it wins resolution over the recency tiebreak among siblings.
// Durable ("remember my last subproject") — survives across sessions until
// changed. The pointer is per-workspace, so a workspaceKey is required; web
// surfaces with no git identity can't pin (they bind per-conversation instead).
//
// A PIN IS THE PINNER'S OWN, AND READING IS ENOUGH TO SET ONE.
//
// It was one row per (workspace, repo), so a teammate switching subproject moved
// everybody who works in that repo. And it was guarded by assertProjectMutable —
// the guard for archive and reparent, which change the project for everyone — so
// a member could not pin a colleague's shared subproject at all: the one person
// with the most reason to say "this is the stream I am on" got project_not_found.
// A pin changes nothing about the project. It records where THIS person's
// sessions in this repo should open, so the only question is whether they may
// see it; whether they may write it is decided, as ever, when they write.
//
// An actor with no person behind it (an internal `{ id: ownerKey }` job) has no
// "own" to pin under and sets the workspace default, exactly as before.
async function switchSubproject(actor, projectId, workspaceKey) {
  const ownerKey = getActorKey(actor);
  if (!workspaceKey) throw new Error('workspace_key_required');
  // getProject is the visibility gate: a project this actor may not read is
  // indistinguishable from one that does not exist.
  const project = await getProject(actor, projectId);
  if (!project) throw new Error('project_not_found');
  // Written under the same identity resolveActiveProject READS with. A system
  // actor resolves with no identities at all, so a pin filed under its key id
  // would be one it can never read back.
  const { system } = await actorVisibilityScope(actor, ownerKey);
  await store.setWorkspacePointer(ownerKey, workspaceKey, projectId, system ? null : workspace.actorPersonId(actor));
  return project;
}

// Dense scripts carry a word's worth of meaning in a character or two, so
// isGenericText's Latin rule of thumb ("under 18 characters is too short to be
// specific") refused 日本語の認証サービス — ten characters, a perfectly specific
// "Japanese-language auth service" — as too generic to store. Each character of
// a CJK/Hangul/Thai script counts as three toward that length; anything else is
// judged exactly as before, and the stock filler phrases are still refused.
const DENSE_SCRIPT_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/gu;
function isGenericEntitySummary(summary) {
  const text = String(summary || '').trim();
  const dense = (text.match(DENSE_SCRIPT_CHAR) || []).length;
  if (!dense) return isGenericText(text);
  return text.length + dense * 2 < 18;
}

/**
 * Pin ONE connection to a project.
 *
 * The workspace pointer above is keyed to a CODEBASE, which a hosted client does
 * not have — so on the web "select this project" either errored and pointed at
 * the dashboard, or wrote a pointer row no hosted call ever read. Either way the
 * next id-less call went back to guessing, and a user who had just said where
 * they were working was ignored.
 *
 * A hosted client does have a durable identity: its credential
 * (hostedSessionIdentity). Binding the session row is therefore the web
 * equivalent of the pin, and resolveActiveProject's tier 4a reads it first. It
 * moves THIS connection only, which is the point: another tab or another editor
 * keeps whatever it was on.
 */
async function bindSessionToProject(actor, sessionId, projectId, { tool = 'claude_web', surfaceType = 'browser', transport = null } = {}) {
  const ownerKey = getActorKey(actor);
  if (!sessionId) throw new Error('session_id_required');
  // Same visibility gate as the pin: a project this actor may not read is
  // indistinguishable from one that does not exist.
  const project = await getProject(actor, projectId);
  if (!project) throw new Error('project_not_found');
  // NULL for an internal actor, exactly as everywhere else — its "id" is the
  // workspace, and filing a session under it would hide the row from everyone.
  await store.bindSession(ownerKey, sessionId, project.project_id, {
    userId: workspace.actorPersonId(actor),
    tool,
    surfaceType,
    transport: transport || connectionIdentity.sessionTransport(actor, sessionId),
  });
  return project;
}

// Soft-archive a dead project so it drops out of the list and never auto-resolves
// as the active project. History is preserved and it can be unarchived. Refuses
// to archive an umbrella that still has live children — deal with them first so
// active work is never hidden out from under the user.
async function archiveProject(actor, projectId) {
  await assertProjectMutable(actor, projectId, 'archive');
  const ownerKey = getActorKey(actor);
  const project = await store.getProject(ownerKey, projectId);
  if (!project) throw new Error('project_not_found');
  const children = await store.getSubprojects(ownerKey, projectId, {
      actorIdentities: workspace.actorIdentities(actor),
      system: actor?.type === 'system' || ownerKey === 'org-system',
      // Same answer as the flat list, or an owner sees a project in one place
      // and not the other.
      isWorkspaceOwner: (await workspace.resolveRole(actor, ownerKey).catch(() => null)) === 'owner',
    });
  if (children.length) throw new Error('archive_parent_with_children');
  const archivedAt = isoNow();
  await store.setProjectArchived(ownerKey, projectId, archivedAt);
  await recordEvent(project, 'system', 'context-api', 'project_archived', {
    project_name: project.project_name,
  });
  return { ...project, archived_at: archivedAt };
}

// Archived projects for the current owner, newest first. Powers the
// start_session notice that keeps an aged-out user from seeing a bare "no
// context yet" and concluding their memory was lost, and the archived half of
// recall(action:"projects"), which that notice sends the assistant to for ids.
//
// Listed to exactly the people who could read the project if it were live: the
// live listing's scope and its share-policy check (projectListingScope,
// viewableWithPolicies), not a copy of them. Identity fields only, no context
// and no decrypt; the visibility columns the check needs stay in here.
async function listArchivedProjectSummaries(actor, { limit = 10 } = {}) {
  try {
    const scope = await projectListingScope(actor);
    const rows = await store.listArchivedProjects(scope.ownerKey, limit, {
      actorIdentities: scope.actorIdentities,
      system: scope.system,
      isWorkspaceOwner: scope.isWorkspaceOwner,
    });
    return (await viewableWithPolicies(actor, rows)).map(({ project }) => ({
      project_id: project.project_id,
      project_name: project.project_name,
      aliases: project.aliases,
      archived_at: project.archived_at,
    }));
  } catch {
    return [];
  }
}

async function unarchiveProject(actor, projectId) {
  await assertProjectMutable(actor, projectId, 'restore');
  const ownerKey = getActorKey(actor);
  const project = await store.getProject(ownerKey, projectId);
  if (!project) throw new Error('project_not_found');
  await store.setProjectArchived(ownerKey, projectId, null);
  return { ...project, archived_at: null };
}

async function getSession(actor, sessionId) {
  const ownerKey = getActorKey(actor);
  return store.getSession(ownerKey, sessionId);
}

// A SESSION BELONGS TO A PERSON.
//
// A context_sessions row is somebody's agent on somebody's machine: its cwd, its
// host, its conversation URL and the project it is bound to. owner_key is the
// WORKSPACE, so keying reads and writes on (owner_key, session_id) alone handed
// every teammate — a viewer's dashboard session included — every colleague's
// sessions to read and to rewrite. Rebinding somebody's session sent their next
// Stop-hook flush into whatever project the rebinder chose.
//
// Callers with no person behind them (system, internal scripts) keep the old
// behaviour: there is no person to compare.
//
// AN UNATTRIBUTED ROW IS NOT EVERYBODY'S. Rows that predate attribution (or an
// internal job made) carry user_id NULL, and every write stamps the writer onto
// the row (upsertSession) — so "no person to compare, allow" let the FIRST
// teammate to touch a colleague's legacy session read its cwd and host and claim
// it, after which its real owner's own flush was refused as not theirs. On a
// workspace that can hold nobody else's work (a solo account) the row can only
// be the caller's. Elsewhere the owner is inferred from the session's binding:
// a bound project with an author is that author's work, and only the author
// claims the session; a bound project with no author is the workspace's, and
// anybody who can write it may. An unbound one is claimable by anybody who can
// write the workspace (never a viewer). Everyone else gets not-found.
async function sessionBelongsToActor(actor, session) {
  if (actor?.type === 'system') return true;
  if (!workspace.actorPersonId(actor)) return true;
  const identities = workspace.actorIdentities(actor);
  if (session?.user_id) return identities.includes(session.user_id);
  if (!session) return true;
  const ownerKey = session.owner_key || getActorKey(actor);
  if (!(await workspaceMayHoldOthersWork(actor, ownerKey, identities))) return true;
  if (session.project_id) {
    const project = await store.getProject(ownerKey, session.project_id).catch(() => null);
    if (project?.owner_user_id) return identities.includes(project.owner_user_id);
    if (project) {
      // Hand over the row just read, but only when it came from the key
      // loadProjectForWrite would read it from; otherwise the check would change.
      const preloaded = ownerKey === getActorKey(actor) ? project : undefined;
      return loadProjectForWrite(actor, session.project_id, { allowArchived: true, preloaded })
        .then(Boolean)
        .catch(() => false);
    }
  }
  return actorMayWriteWorkspace(actor, ownerKey).catch(() => false);
}

// Indistinguishable from a session that does not exist: answering "forbidden"
// would confirm that the id is live, and whose it is.
function sessionNotFoundError() {
  const error = new Error('session_not_found');
  error.code = 'session_not_found';
  error.status = 404;
  error.mcpCode = 'invalid_arguments';
  error.retryable = false;
  error.publicMessage = 'That session does not exist, or it is not yours to change.';
  return error;
}

// The caller's OWN sessions. On a workspace where nothing can be anybody
// else's (a solo account) the list is exactly what it always was — including
// unattributed rows, which there can only be the owner's. Anywhere else it is
// narrowed to this person: a colleague's session names their machine, their
// working directory and, through its binding, their personal project ids.
async function listSessions(actor) {
  const ownerKey = getActorKey(actor);
  if (actor?.type === 'system' || ownerKey === 'org-system' || !workspace.actorPersonId(actor)) {
    return store.listSessions(ownerKey);
  }
  const identities = workspace.actorIdentities(actor);
  if (!(await workspaceMayHoldOthersWork(actor, ownerKey, identities))) return store.listSessions(ownerKey);
  return store.listSessions(ownerKey, { userIds: identities });
}

/**
 * Who else is working in this project, and on what.
 *
 * Two queries, both indexed, both against tables that already exist. Called only
 * from a path that has already resolved the project, and wrapped by its caller so
 * a failure degrades to "no peers" — a brief that renders is worth more than a
 * brief that is complete, and presence is additive to every other slot.
 *
 * Scope is DERIVED, never declared: the card a peer holds plus the graph nodes it
 * has written recently. An agent that never thought to announce anything still
 * shows up with a real area of work, which is the whole point — a coordination
 * feature that only works for agents who opt in reports an empty project while
 * three agents are colliding in it.
 */
/** One-query liveness refresh (see store.touchSession). Never throws. */
async function touchSession(actor, sessionId, projectId) {
  const ownerKey = getActorKey(actor);
  // A passive poll may re-point only the caller's own session (see
  // sessionBelongsToActor): the id arrives on the query string.
  const identities = actor?.type === 'system' || !workspace.actorPersonId(actor)
    ? null
    : workspace.actorIdentities(actor);
  return store.touchSession(ownerKey, sessionId, projectId, identities);
}

async function getProjectPresence(actor, projectId, selfSessionId) {
  const ownerKey = getActorKey(actor);
  const peers = await store.listPeerSessions(ownerKey, projectId, selfSessionId, PRESENCE_WINDOW_SECONDS);
  if (!peers.length) return [];

  // The reader's VIEW of the project, not the row. A peer's held cards come from
  // todo_items and its scope from the graph nodes it wrote; on a share that
  // withholds the board or the decisions, reading them off the raw row printed a
  // colleague's card titles and decision nodes into the reader's brief, one line
  // under "Not shared with you". The same rule the graph obeys (nodeSectionAllowedIn)
  // decides which node titles may name a peer's area of work.
  const [view] = await viewProjectsForActor(actor, [
    await store.getProject(ownerKey, projectId).catch(() => null),
  ].filter(Boolean)).catch(() => []);
  const cards = view?.context?.todo_items || [];
  const restricted = isSectionFilteredContext(view?.context)
    ? new Map([[projectId, new Set((await getProjectSharePolicy(actor, view).catch(() => null))?.sections || [])]])
    : null;
  const nodes = !view ? [] : (await store
    .listRecentNodesBySessions(ownerKey, projectId, peers.map((p) => p.session_id), PRESENCE_WINDOW_SECONDS)
    .catch(() => []))
    .filter((node) => !restricted || nodeSectionAllowedIn(node, projectId, restricted));

  // Only pay for the roster when a peer actually belongs to somebody else — a
  // solo account, still the overwhelming majority, does no extra query.
  const names = new Map();
  const selfId = workspace.actorPersonId(actor);
  // A session that carries no person (older, or an internal job's) belongs to
  // nobody in particular: it is named "workspace", never left as an opaque id and
  // never given to whoever is reading. Only where somebody else could be meant.
  const someoneElseMayBeHere = peers.some((p) => !p.user_id)
    && await workspaceMayHoldOthersWork(actor, ownerKey).catch(() => false);
  if (peers.some((p) => p.user_id && p.user_id !== selfId)) {
    const members = await workspace.listMembers(ownerKey, { includeRemoved: true }).catch(() => []);
    for (const m of members) names.set(m.user_id, m.email || m.user_id);
  }

  return peers.map((peer) => {
    const heldCards = cards
      .filter((card) => {
        const state = holdState(card);
        return state.held && state.holder === peer.session_id;
      })
      .map((card) => ({ id: card.id, title: card.title, held_at: card.held_at }));
    // Two entries is the whole budget: this renders as one line in a brief, and a
    // peer's fifth touched file tells the reader nothing the first two did not.
    const scope = nodes
      .filter((n) => n.session_id === peer.session_id)
      .slice(0, 2)
      .map((n) => n.title)
      .filter(Boolean);
    // Deliberately NOT returned: the peer's cwd and host. owner_key is the org in
    // a shared workspace, so a peer can be a colleague on their own machine, and
    // their local filesystem path is not something this feature needs. Nothing
    // reads them — overlap matching runs on `scope` — so exposing them would be
    // pure leak for no capability.
    return {
      session_id: peer.session_id,
      // The peer's identity, resolved to something a human recognises. On a solo
      // workspace this is always the reader themselves on another machine and
      // adds nothing; on a shared one it is the whole point — "Sarah is in this
      // file" is a warning you can act on, "sess_a1b2 is" is not.
      user_id: peer.user_id || null,
      display_name: peer.user_id ? (names.get(peer.user_id) || null) : (someoneElseMayBeHere ? 'workspace' : null),
      tool: peer.tool,
      surface_type: peer.surface_type,
      last_seen_at: peer.last_seen_at,
      held_cards: heldCards,
      scope,
    };
  });
}

async function upsertSession(actor, sessionId, input) {
  const ownerKey = getActorKey(actor);
  const current = await store.getSession(ownerKey, sessionId);
  // Every path that writes a session comes through here — PATCH /sessions/:id,
  // /extraction, the topic chip, a marked /active start — and every one of them
  // takes the id from the request. Somebody else's session is not found.
  if (current && !(await sessionBelongsToActor(actor, current))) throw sessionNotFoundError();
  const now = isoNow();
  const session = ContextSessionSchema.parse({
    session_id: sessionId,
    owner_key: ownerKey,
    // Falls back to the stored value so a later write that carries no identity
    // cannot anonymise a session that already had one.
    user_id: workspace.actorPersonId(actor) || current?.user_id || null,
    tool: input.tool || current?.tool,
    // How it connects, apart from which tool it is. A write that cannot say keeps
    // what the row already knew (see connectionIdentity.sessionTransport).
    transport: input.transport || connectionIdentity.sessionTransport(actor, sessionId) || current?.transport || null,
    surface_type: input.surface_type || current?.surface_type || inferSurfaceType(input.tool || current?.tool || 'claude_web'),
    // UNDEFINED MEANS "LEAVE IT", NULL MEANS "UNBIND".
    //
    // This tested for the KEY, and applyExtraction always sends the key:
    // `project_id: input.project_id || undefined`. So every write that did not
    // name a project wiped the session's binding before the very next line read
    // it back to decide where the write should go, and the person's tier-4
    // "where have I actually worked" record was erased on the calls that depend
    // on it most. Only a caller that says null is asking to unbind.
    project_id: input.project_id !== undefined ? input.project_id : (current?.project_id || null),
    conversation_ref: input.conversation_ref ?? current?.conversation_ref ?? '',
    cwd: input.cwd ?? current?.cwd ?? '',
    host: input.host ?? current?.host ?? '',
    tab_id: input.tab_id ?? current?.tab_id ?? '',
    status: input.status || current?.status || 'active',
    routing_state: input.routing_state || current?.routing_state || (current?.project_id ? 'matched' : 'global_only'),
    match_confidence: typeof input.match_confidence === 'number' ? input.match_confidence : current?.match_confidence || 0,
    last_confirmed_at: Object.prototype.hasOwnProperty.call(input, 'last_confirmed_at')
      ? input.last_confirmed_at
      : current?.last_confirmed_at ?? null,
    created_at: current?.created_at || now,
    updated_at: now,
    last_seen_at: now,
  });

  await store.saveSession(session);
  return session;
}

// PATCH /sessions/:id — the one route whose whole job is to write a session
// row from a request body. So it is held to what every other workspace write is:
// a read-only member writes nothing, and a project_id is loaded through the same
// visibility gate bindSessionTopic uses, so binding to a project this person
// cannot read answers exactly as binding to one that does not exist. (It used
// to store any id at all, which made the route an existence oracle for a
// colleague's personal projects.) null still unbinds.
async function patchSession(actor, sessionId, input) {
  const ownerKey = getActorKey(actor);
  await assertWorkspaceWritable(actor, ownerKey);
  if (typeof input?.project_id === 'string' && input.project_id) {
    const loaded = await loadProjectForWrite(actor, input.project_id, { requireWriteRole: false });
    if (!loaded) throw new Error('project_not_found');
  }
  return upsertSession(actor, sessionId, input);
}

// P3 — cross-platform topic binding (the confirm-chip's action). Binds a (web)
// session to a topic: creates the topic if new, records the conversation URL for
// deterministic same-chat matching, and marks the session confidently matched so
// injection uses this topic. This is the human-in-the-loop that stops the same
// topic becoming a duplicate project per platform.
async function bindSessionTopic(actor, input) {
  // Refused up front, not at the upsert below: by then a new topic would
  // already have been created for a binding that was never going to happen.
  const existing = input.session_id ? await store.getSession(getActorKey(actor), input.session_id) : null;
  if (existing && !(await sessionBelongsToActor(actor, existing))) throw sessionNotFoundError();
  let projectId = input.project_id || null;
  if (!projectId && input.new_topic_name) {
    const created = await createProject(actor, {
      project_name: input.new_topic_name,
      category: 'topic',
      // No user in this loop to fix a rejected name — fall back rather than throw.
      allow_fallback_name: true,
    });
    projectId = created.project_id;
  }
  if (!projectId) throw new Error('bind_requires_project_or_name');

  // Same visibility gate as every other load: binding to a project id this actor
  // cannot see must be indistinguishable from binding to one that does not exist.
  const loaded = await loadProjectForWrite(actor, projectId, { requireWriteRole: false });
  if (!loaded) throw new Error('project_not_found');
  const { project, policy } = loaded;

  // Record the conversation URL so future turns in THIS exact chat re-match it
  // deterministically (scoreProjectMatch awards +1.1 for a linked_conversations hit).
  // That is a write to the project row, so only someone who may change the project
  // makes it; a reader still gets their own session bound below.
  const mayLink = await actorMayWriteWorkspace(actor, project.owner_key, policy.workspaceRole)
    && (isProjectOwner(actor, project)
      || (project.visibility === 'shared' && policy.enabled && ROLE_EDIT_ALLOW.has(resolveActorProjectRole(actor, policy))));
  if (input.conversation_ref && mayLink) {
    // The row is saved whole, context and all, so the save is guarded: an
    // unconditional one wrote back the context as it was read and erased any
    // decision a concurrent writer appended in between.
    await withContextWriteRetry(async (attempt) => {
      const current = attempt === 1 ? project : (await loadProjectForWrite(actor, projectId, { requireWriteRole: false }))?.project;
      if (!current) return;
      const refs = new Set([...(current.linked_conversations || []), input.conversation_ref]);
      await saveProjectGuarded({ ...current, linked_conversations: [...refs] }, actor);
    });
  }

  await upsertSession(actor, input.session_id, {
    tool: input.tool,
    project_id: projectId,
    conversation_ref: input.conversation_ref || '',
    host: input.host || '',
    surface_type: 'browser',
    routing_state: 'matched',
    match_confidence: 1,
    last_confirmed_at: isoNow(),
  });

  return { project_id: projectId, project_name: project.project_name };
}

// P3 — powers the confirm chip. Returns the session's bound topic (+ a fresh brief
// to inject), and the user's topics as switch candidates. The chip loads before any
// capture, so candidates are ranked by recency rather than conversation overlap;
// auto-detection happens through the capture→extraction path, which binds the
// session, and the chip reflects it on the next poll.
async function getSessionTopic(actor, input, options = {}) {
  const ownerKey = getActorKey(actor);
  const stored = input.session_id ? await store.getSession(ownerKey, input.session_id) : null;
  // A colleague's session id reads as no session: its binding is what they are
  // working on, which is theirs to say (presence says it, by name, on purpose).
  const session = stored && (await sessionBelongsToActor(actor, stored)) ? stored : null;
  // Binding a chat to a project is a WRITE target, so an unfiltered list here
  // would offer a teammate's private project as somewhere to put your context.
  const projects = await store.listProjects(ownerKey, { actorIdentities: workspace.actorIdentities(actor) });

  // Offer topics first (the primary web use case) but also existing coding
  // projects, so a user can bind a web chat to work they already track — not
  // only ever create a new topic.
  const candidates = projects
    .sort((a, b) => {
      const aTopic = a.context?.category === 'topic' ? 0 : 1;
      const bTopic = b.context?.category === 'topic' ? 0 : 1;
      if (aTopic !== bTopic) return aTopic - bTopic;
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    })
    .slice(0, 12)
    .map((p) => ({ project_id: p.project_id, project_name: p.project_name, category: p.context?.category || 'coding' }));

  let activeTopic = null;
  let brief = null;
  if (session?.project_id && session.routing_state !== 'global_only') {
    const bound = projects.find((p) => p.project_id === session.project_id);
    if (bound) {
      activeTopic = { project_id: bound.project_id, project_name: bound.project_name };
      // Pass sessionId=null: this is a read/preview for the chip, not a delivered
      // injection. Passing the real session id would record it in injectionHistory
      // and get the brief suppressed (null) on the very next poll, dropping the
      // bound-topic brief back to the generic map. The project graph still carries
      // the imported enrichment nodes, so provenance lines still render.
      const payload = await renderInjection(actor, bound.project_id, input.tool || 'claude_web', 'standard', null, {
        now: new Date().toISOString(),
        tz: options.tz || null,
      }).catch(() => null);
      brief = payload?.body ?? null;
    }
  }

  return { active_topic: activeTopic, candidates, brief };
}

// The member-facing view of a project: the raw row for its owner, the
// section-filtered context for a teammate reading a shared project.
function projectViewForActor(actor, project, policy) {
  if (!project) return project;
  if (!isProjectOwner(actor, project) && project.visibility === 'shared' && policy?.enabled) {
    return {
      ...project,
      context: filterContextBySectionPolicy(project.context || {}, policy.sections),
    };
  }
  return project;
}

// projectViewForActor over a list somebody else already loaded.
//
// store.listProjects filters on VISIBILITY only — which projects exist for you —
// and hands back each row's raw decrypted context. Every reader that took that
// list and put project content in front of a teammate (the portfolio's merged
// decisions, the brief's "Related elsewhere" block) therefore served the
// sections a share withholds, while the brief beside it said "Not shared with
// you". This is the same view listProjects(actor) builds, without re-reading and
// re-repairing every row: the actor's own projects pass through untouched (no
// policy lookup, so a solo account pays nothing), anybody else's goes through the
// share policy, and a project the policy no longer lets them view is dropped. A
// policy that cannot be read fails CLOSED — a skipped project is a smaller loss
// than a published one.
async function viewProjectsForActor(actor, projects = []) {
  const own = (project) => isProjectOwner(actor, project) && canViewProjectForActor(actor, project, null);
  // Policies for everybody else's projects in one batch, not one at a time.
  const policies = await getProjectSharePolicies(
    actor,
    (projects || []).filter((project) => project && !own(project)),
  ).catch(() => new Map());
  const out = [];
  for (const project of projects || []) {
    if (!project) continue;
    if (own(project)) {
      out.push(project);
      continue;
    }
    const policy = policies.get(project.project_id) || null;
    if (!policy || !canViewProjectForActor(actor, project, policy)) continue;
    out.push(projectViewForActor(actor, project, policy));
  }
  return out;
}

// AN ARCHIVED PROJECT IS NOT WRITABLE, AND SAYS SO.
//
// Archiving takes a project out of every list, out of active-project resolution
// and out of the brief. Nothing stopped a write that still held its id — a
// session bound before the archive, a stored project_id in somebody's config, a
// name that still resolves — so the write reported success into a project no
// session will ever open again. For a memory product that is the save that
// silently went nowhere. The 30-day idle auto-archive makes it ordinary rather
// than exotic: the person coming back to dormant work is exactly who hits it.
//
// Refused HERE because every write path loads through here. After the
// visibility gate, so a project the actor may not see is still not_found and the
// refusal never confirms that it exists. allowArchived is for the one change
// that has to work on an archived project: renaming it, which is how a name is
// freed for reuse without restoring anything. Archive, restore and reparent are
// structural and never load through this function.
function archivedProjectError(project) {
  const error = new Error('project_archived');
  error.code = 'project_archived';
  error.status = 409;
  error.mcpCode = 'invalid_arguments';
  error.retryable = false;
  error.project_id = project.project_id;
  // Worded to contain "required" on purpose: normalizeMcpError passes such a
  // message through verbatim, and several hosted handlers re-wrap a publicMessage
  // in a plain Error, which drops mcpCode. Without the word the one sentence that
  // tells the caller how to get their save back collapses to "The MCP request
  // could not be completed".
  error.publicMessage = `project_archived: "${project.project_name}" (${project.project_id}) is archived, so nothing was saved. `
    + 'A restore is required before it can be written to: manage_projects with action "restore", '
    + `or POST /api/v1/context/projects/${project.project_id}/archive with {"unarchive": true}. Then repeat the write.`;
  error.safeMessage = error.publicMessage;
  return error;
}

// THE PROJECT THIS CONNECTION WAS WORKING IN CAN NO LONGER TAKE THE WRITE.
//
// A connection (a hosted connector holds one for its whole life; a session row
// outlives the project it is bound to) keeps its binding after the project is
// archived, or after the person stops being able to read it (visibility changed,
// removed from the share). Both used to read as "no binding": resolution fell
// through to the person's next most recent project and the write went there,
// under a reply that named the wrong project only if the caller read it closely
// (journey r5). The owner's decision: refuse, say why, say what to do. Nothing
// moves without the person choosing.
//
// Both carry the id of the project, which the caller already holds, and the
// NAME only for an archived one: the person can still read an archived project
// they own, and naming one they may no longer read would tell them what the
// share was withholding.
//
// `code` is what the local dispatcher's allow-list keys on. Archived reuses
// project_archived: the same fact, and the same 409.
const BOUND_PROJECT_CHOOSE_ANOTHER = 'To work somewhere else, pass project_id for one of your projects (recall with action "projects" lists them), or choose one with manage_projects (action "select"), then repeat the write.';

function boundProjectArchivedError(projectId, projectName) {
  const error = new Error('project_archived');
  error.code = 'project_archived';
  error.status = 409;
  error.mcpCode = 'invalid_arguments';
  error.retryable = false;
  error.project_id = projectId;
  // Refused by resolveActiveProject: the write named no project, so the caller
  // must be told which one this connection meant.
  error.bindingRefusal = true;
  const label = projectName ? `"${projectName}" (${projectId})` : projectId;
  error.publicMessage = `project_archived: This connection is working in ${label}, which is archived, so nothing was saved. `
    + `To keep working there, restore it: manage_projects with action "restore" and project_id "${projectId}". `
    + BOUND_PROJECT_CHOOSE_ANOTHER;
  error.safeMessage = error.publicMessage;
  return error;
}

// The connection's project could not be CHECKED (a store error or timeout).
// Nothing is claimed about the project; nothing was saved; the caller retries.
function boundProjectTemporaryError(cause) {
  console.warn('[CONTEXT] could not check the connection\'s bound project:', cause?.code || cause?.message);
  const error = new Error('bound_project_check_failed');
  error.code = 'bound_project_check_failed';
  error.status = 503;
  error.mcpCode = 'internal_error';
  error.retryable = true;
  error.bindingRefusal = true;
  error.publicMessage = 'Nothing was saved. DeerDawn could not check the project this connection is working in just now, so it did not guess. This is temporary: try again.';
  error.safeMessage = error.publicMessage;
  return error;
}

function boundProjectUnavailableError(projectId) {
  const error = new Error('bound_project_unavailable');
  error.code = 'bound_project_unavailable';
  error.status = 409;
  error.mcpCode = 'invalid_arguments';
  error.retryable = false;
  error.project_id = projectId;
  error.bindingRefusal = true;
  error.publicMessage = `bound_project_unavailable: The project this connection was working in (${projectId}) is no longer shared with you, so nothing was saved. `
    + BOUND_PROJECT_CHOOSE_ANOTHER;
  error.safeMessage = error.publicMessage;
  return error;
}

// Every WRITE path loads through here, never through getProject. Same visibility
// gate as getProject (an invisible project is not_found), but it hands back the
// RAW row plus the share policy, so the caller filters the DELTA against the
// policy and saves a complete context. Loading the filtered view and saving it
// persisted every unshared section as empty.
//
// It also refuses a read-only member outright (assertWorkspaceWritable), because
// isProjectOwner treats an unattributed project as the caller's own and would
// otherwise wave a viewer through every per-section check below. A caller that
// must degrade instead of throwing (extraction, which also records the session)
// passes requireWriteRole: false and checks actorMayWriteWorkspace itself.
//
// `preloaded` is a row the caller ALREADY read under this same owner key, so one
// project is not fetched and decrypted twice (sessionBelongsToActor did exactly
// that: one read to look for an author, then a second one in here).
async function loadProjectForWrite(actor, projectId, { requireWriteRole = true, allowArchived = false, preloaded } = {}) {
  const ownerKey = getActorKey(actor);
  const stored = preloaded !== undefined ? preloaded : await store.getProject(ownerKey, projectId);
  const project = await repairProjectIntegrity(stored, { persist: false });
  if (!project) return null;
  const policy = await getProjectSharePolicy(actor, project);
  if (!canViewProjectForActor(actor, project, policy)) return null;
  if (project.archived_at && !allowArchived) throw archivedProjectError(project);
  if (requireWriteRole) await assertWorkspaceWritable(actor, project.owner_key || ownerKey, projectWriteRole(project, policy));
  return { project, policy };
}

// READ, CHANGE, SAVE — AND THE SAVE HAS TO KNOW WHAT IT READ.
//
// Every write below builds the whole context from the row it loaded: an append
// to the decision log is "the list I read, plus one". Saved unconditionally,
// two such writes racing on one project keep only the second list, and the
// first caller has already been told its words were stored (scan 36: three
// teammates' simultaneous manage_memory updates, one decision gone, all three
// answered "Context updated"). applyExtraction closed this for flushes with a
// compare-and-swap on context_version; these paths now use the same swap.
//
// saveProjectGuarded throws a private marker when the swap loses, before any
// side effect after the save has run, and withContextWriteRetry re-runs the
// write from a fresh read — so the append is re-derived from the list as it
// now is, never re-applied onto a stale copy. A write that still cannot land
// after the budget is REFUSED (context_write_conflict, "nothing was saved"),
// never reported as done and never forced over the other writers.
const CONTEXT_WRITE_ATTEMPTS = 4; // the first try, then three fresh reads
const STALE_CONTEXT_WRITE = Symbol('deerdawn.staleContextWrite');

function contextWriteConflictError(project) {
  const name = project?.project_name || project?.project_id || 'this project';
  const error = new Error('context_write_conflict');
  error.code = 'context_write_conflict';
  error.status = 409;
  error.retryable = true;
  error.publicMessage = `context_write_conflict: nothing was saved. Other writes to "${name}" kept landing at the same moment, `
    + `and after ${CONTEXT_WRITE_ATTEMPTS} attempts this one could not be applied on top of them without overwriting them. Retry.`;
  error.safeMessage = error.publicMessage;
  return error;
}

async function saveProjectGuarded(project, actor) {
  const expectedVersion = Number.isFinite(project?.context_version) ? project.context_version : null;
  const result = await store.saveProject(project, actor, { expectedVersion });
  // A store that answers nothing predates the swap (or is a test stub): the
  // write happened, as it always did.
  if (result && result.applied === false) {
    const stale = new Error('stale_context_write');
    stale[STALE_CONTEXT_WRITE] = project;
    throw stale;
  }
  return result;
}

// A WRITE MADE AGAINST A READ THE PROJECT HAS SINCE MOVED ON FROM.
//
// Distinct from context_write_conflict above: that one is the server losing its
// OWN swap too many times. This one is the caller saying "I read version N" and
// the project no longer being at N — somebody (usually the person's own AI tool)
// wrote in between. The dashboard rebuilds a whole list from what it loaded, so
// accepting that write erased whatever landed since (journey r3, S3-1). Nothing
// is saved; the caller reads again and re-applies its one change.
function staleContextVersionError(project, expectedVersion) {
  const name = project?.project_name || project?.project_id || 'this project';
  const error = new Error('stale_context_version');
  error.code = 'stale_context_version';
  error.status = 409;
  error.retryable = true;
  error.expected_context_version = expectedVersion;
  error.publicMessage = `stale_context_version: the brief for "${name}" changed after this copy of it was read. `
    + 'Nothing was saved. Read it again and re-apply the change to what is there now.';
  error.safeMessage = error.publicMessage;
  return error;
}

async function withContextWriteRetry(write) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await write(attempt);
    } catch (err) {
      if (!err || !err[STALE_CONTEXT_WRITE]) throw err;
      if (attempt >= CONTEXT_WRITE_ATTEMPTS) throw contextWriteConflictError(err[STALE_CONTEXT_WRITE]);
    }
  }
}

// A board write that would leave more than the open-card limit open. Nothing is
// saved: open work is never deleted to make room, and a new card is never
// dropped quietly either — the caller is told how full the board is, which cards
// were refused, and what frees a slot.
function boardOpenLimitError(outcome = {}) {
  const refusedCards = Array.isArray(outcome.refused_open) ? outcome.refused_open : [];
  const openCount = Number(outcome.open_count) || 0;
  const limit = Number(outcome.open_limit) || 300;
  const shown = refusedCards.slice(0, 5).map((card) => `"${card.title}"`).join(', ');
  const more = refusedCards.length > 5 ? ` and ${refusedCards.length - 5} more` : '';
  const publicMessage = `board_open_limit_reached: the board has ${openCount} open card${openCount === 1 ? '' : 's'} and the limit is ${limit}, `
    + `so ${refusedCards.length === 1 ? 'this card was' : `these ${refusedCards.length} cards were`} not added: ${shown}${more}. `
    + 'Nothing was saved. Complete or remove open cards first (manage_tasks action "complete" or "remove"), then add again.';
  const error = new Error('board_open_limit_reached');
  error.publicMessage = publicMessage;
  error.code = 'board_open_limit_reached';
  error.status = 409;
  error.mcpCode = 'board_full';
  error.retryable = false;
  error.refused_cards = refusedCards;
  error.open_count = openCount;
  error.open_limit = limit;
  return error;
}

// Would this patch's board directives be refused at the open-card limit? The
// same merge updateProjectContext runs (mergeContextObject with an outcome), run
// on a copy and saved nowhere. For a DRY RUN, which must answer what the real
// write would: a Trail import dry run over a full board said "nothing was
// written… 3 cards" as a success, and the real import then refused. Returns the
// error the real write would throw, or null.
const BOARD_DIRECTIVE_KEYS = ['add_todos', 'move_todos', 'complete_todos', 'remove_todos'];
function previewBoardOpenLimit(context, patch = {}) {
  const directive = {};
  for (const key of BOARD_DIRECTIVE_KEYS) {
    if (patch?.[key] !== undefined) directive[key] = patch[key];
  }
  if (!Object.keys(directive).length) return null;
  const outcome = {};
  // A dry-run import into a NEW project has no stored context yet, and the
  // merge validates its result against the project schema, which requires a
  // name: simulate against a named placeholder rather than refuse a valid plan.
  const stored = context && typeof context === 'object' ? context : {};
  const base = stored.project_name ? stored : { ...stored, project_name: 'dry-run preview' };
  mergeContextObject(base, directive, base.source_summary || '', { outcome });
  return Array.isArray(outcome.refused_open) && outcome.refused_open.length ? boardOpenLimitError(outcome) : null;
}

// Which SECTIONS a context patch writes: its keys, with the merge directives
// named by the section they act on. One mapping for the real write
// (updateProjectContext) and its dry run (previewProjectContextWrite), so the two
// cannot disagree about what a patch touches. Deduped: todo_items and
// completed_todos are one section, and a refusal naming it twice reads as two.
const PATCH_DIRECTIVE_SECTIONS = {
  add_todos: 'todo_items',
  move_todos: 'todo_items',
  complete_todos: 'todo_items',
  remove_todos: 'todo_items',
  resolved_landmines: 'landmines',
};
function sectionsWrittenByPatch(patch = {}) {
  return [...new Set(Object.keys(patch || {}).map((key) => PATCH_DIRECTIVE_SECTIONS[key] || mapSectionFromField(key)))];
}

// Refuse, naming every section once, when a non-author's patch writes a section
// they may not edit. The author (and a solo account) passes; a non-author may
// only ever write a SHARED project.
function assertCanWritePatch(actor, project, policy, patch) {
  if (holdsAuthorRights(actor, project, policy)) return;
  if (project.visibility !== 'shared') throw writeForbiddenError(readOnlyProjectMessage(project));
  const blocked = sectionsWrittenByPatch(patch).filter((sectionKey) => (
    !SHAREABLE_SECTIONS.includes(sectionKey) || !canEditSectionForActor(actor, project, policy, sectionKey)
  ));
  if (blocked.length) throw writeForbiddenError(readOnlyProjectMessage(project, blocked), blocked);
}

// What updateProjectContext would answer for this patch, without writing: the
// same load gate (not found, archived, viewer), the same section refusal, and
// the board's open-card limit judged against the STORED board — a dry run judged
// against the caller's filtered copy saw an empty board wherever the share
// withholds it. Throws the refusal the write would throw; otherwise returns the
// board-limit error the write would throw, or null.
async function previewProjectContextWrite(actor, projectId, patch = {}) {
  const loaded = await loadProjectForWrite(actor, projectId);
  if (!loaded) throw new Error('project_not_found');
  assertCanWritePatch(actor, loaded.project, loaded.policy, patch);
  return previewBoardOpenLimit(loaded.project.context || {}, patch);
}

function writeForbiddenError(publicMessage, blocked = []) {
  const error = new Error('share_write_forbidden');
  error.code = 'share_write_forbidden';
  error.status = 403;
  error.blocked_fields = blocked;
  error.publicMessage = publicMessage;
  return error;
}

// A VIEWER WRITES NOTHING.
//
// Scopes on a credential are a snapshot taken when it was minted, and an OAuth
// token outlives a role change. So the service refuses a workspace write from a
// read-only member itself rather than trusting whatever scope rode in on the key.
//
// The role comes from workspace membership (workspaceService.resolveRole), never
// from actor.role. A non-writable role is only refused in a SHARED workspace: a
// solo workspace holds nobody but its owner, and an actor predating the
// membership backfill resolves to 'viewer' there without being one. A real
// viewer is, by construction, in a workspace with at least two people.
//
// An internal actor (a job or script, with no person behind it) is not gated:
// the server constructs it, no request can.
async function actorMayWriteWorkspace(actor, ownerKey, knownRole = null) {
  if (actor?.type === 'system') return true;
  if (!workspace.actorPersonId(actor)) return true;
  const role = knownRole || await workspace.resolveRole(actor, ownerKey);
  if (workspace.canWrite(role)) return true;
  return !(await workspace.isSharedWorkspace(ownerKey));
}

async function assertWorkspaceWritable(actor, ownerKey, knownRole = null) {
  if (await actorMayWriteWorkspace(actor, ownerKey, knownRole)) return;
  throw writeForbiddenError(
    'share_write_forbidden: you have read-only (viewer) access to this workspace, so nothing was saved. Ask a workspace owner to make you a member.'
  );
}

// May this actor change the project as a whole (rename it, resolve a question)?
// Its author may; on a SHARED project a member may; nobody else. In particular a
// workspace owner may READ a colleague's private project but not rewrite it (see
// canEditSectionForActor), and a personal project never gets this far for a
// non-author, because loadProjectForWrite has already answered not_found.
function assertCanWriteProject(actor, project, policy) {
  if (holdsAuthorRights(actor, project, policy)) return;
  if (
    project.visibility === 'shared'
    && policy?.enabled
    && ROLE_EDIT_ALLOW.has(resolveActorProjectRole(actor, policy))
  ) return;
  throw writeForbiddenError(readOnlyProjectMessage(project));
}

function readOnlyProjectMessage(project, blocked = []) {
  if (project?.visibility !== 'shared') {
    return 'share_write_forbidden: you can read this project but not change it, because it is not shared with the workspace. Ask its author to share it.';
  }
  if (!blocked.length) return 'share_write_forbidden: you can read this shared project but not change it.';
  return `share_write_forbidden: you can read this shared project but not edit ${blocked.join(', ')}. Ask its owner to grant edit on ${blocked.length === 1 ? 'that section' : 'those sections'}.`;
}

// Refuse, naming every section, when the actor may not edit one of them. Same
// error shape updateProjectContext throws, so routes map it to one 403.
function assertCanEditSections(actor, project, policy, sections) {
  if (holdsAuthorRights(actor, project, policy)) return;
  const blocked = sections.filter((sectionKey) => (
    !SHAREABLE_SECTIONS.includes(sectionKey) || !canEditSectionForActor(actor, project, policy, sectionKey)
  ));
  if (!blocked.length) return;
  throw writeForbiddenError(readOnlyProjectMessage(project, blocked), blocked);
}

// Can this actor READ this section of the project? The same answer
// projectViewForActor gives, per section: the whole row for its author (and for
// anybody the visibility gate lets read a non-shared project whole), and only
// the share's sections for a teammate reading a shared project.
function canViewSectionForActor(actor, project, policy, sectionKey) {
  if (!canViewProjectForActor(actor, project, policy)) return false;
  if (isProjectOwner(actor, project)) return true;
  if (project.visibility !== 'shared' || !policy?.enabled) return true;
  return (policy.sections || []).includes(sectionKey);
}

// Hot paths and debugging notes: WHO MAY ADD TO THEM, AND HOW.
//
// Returns 'edit' (the actor may rewrite the section: replace an entry by path,
// collapse a reworded note, let the cap evict) or 'append' (strictly additive:
// nothing already stored may change or go), or throws share_write_forbidden.
//
// Recording a path or a finding is the everyday team action, and neither
// section is in the default share — so a member may APPEND to them whether or
// not the share lets them read them. What they may not do is REWRITE: the old
// "append" relabelled the owner's path when the member recorded the same one,
// evicted every hidden path at the cap, collapsed onto the owner's note, and
// the reply handed back the stored list and the text of whatever went. An
// append now rewrites nothing already stored (a collision is left alone and
// counted, a collapse onto somebody else's entry is refused and saves nothing),
// a FULL list ages by fixed rules rather than refusing forever (chooseAgedOut),
// and the reply carries stored content only to a caller the share lets READ the
// section (canViewSectionForActor).
//
// Full edit stays with the author, a solo account, and can_edit on the section.
// A viewer, and anybody on a project that is not shared, is refused.
function sectionWriteMode(actor, project, policy, sectionKey) {
  if (holdsAuthorRights(actor, project, policy)) return 'edit';
  if (canEditSectionForActor(actor, project, policy, sectionKey)) return 'edit';
  if (
    project.visibility === 'shared'
    && policy?.enabled
    && SHAREABLE_SECTIONS.includes(sectionKey)
    && ROLE_EDIT_ALLOW.has(resolveActorProjectRole(actor, policy))
    && canViewProjectForActor(actor, project, policy)
  ) return 'append';
  assertCanEditSections(actor, project, policy, [sectionKey]);
  // Unreachable: assertCanEditSections throws for every case not accepted above.
  throw writeForbiddenError(readOnlyProjectMessage(project, [sectionKey]), [sectionKey]);
}

// The source line a merge may stamp. mergeContextObject writes source_summary
// from its third argument whenever that is non-empty, so a caller who may not
// edit the section hands it the stored value (or nothing) and it stays as it was.
function mergeSourceFor(actor, project, policy, fallback) {
  const stored = project.context?.source_summary || '';
  if (stored) return stored;
  return isProjectOwner(actor, project) || canEditSectionForActor(actor, project, policy, 'source_summary') ? fallback : '';
}

function appendWouldRewriteError(project, sectionKey, what) {
  return writeForbiddenError(
    `share_write_forbidden: nothing was saved. Adding this to ${sectionKey.replace(/_/g, ' ')} would ${what}, `
    + 'and you may add to that section but not rewrite it. Ask its owner to grant edit on that section.',
    [sectionKey]
  );
}

async function getProject(actor, projectId) {
  const ownerKey = getActorKey(actor);
  const project = await store.getProject(ownerKey, projectId);
  const repaired = await repairProjectIntegrity(project, { persist: false });
  if (!repaired) return null;
  const policy = await getProjectSharePolicy(actor, repaired);
  if (!canViewProjectForActor(actor, repaired, policy)) return null;
  return projectViewForActor(actor, repaired, policy);
}

// Rename a project the actor can see. Rejects junk names (paths, filenames,
// "Untitled", etc.) outright rather than coercing them the way creation does —
// a rename to garbage is a mistake worth surfacing, not silently accepting.
const PROJECT_NAME_MAX_LENGTH = 120;

// Visible AND changeable by this actor, or throw: project_not_found for a project
// it cannot see, share_write_forbidden for one it may only read. Exported for the
// routes that write a project row directly through the store.
// RENAMING IS A POWER OVER THE PROJECT, NOT A WRITE INTO IT (journey r6).
//
// Only a SHARED project's author or a workspace owner may rename it: a member with
// edit rights on its sections writes into the brief and may not change what the
// team calls it. On a private project it is the author, or an owner once the
// author has left. Visible first (not_found), then the powers rule.
async function assertProjectRenamable(actor, projectId) {
  const loaded = await loadProjectForWrite(actor, projectId, { allowArchived: true });
  if (!loaded) throw new Error('project_not_found');
  if (!holdsProjectPowers(actor, loaded.project, loaded.policy)) {
    throw projectPowersRefusal(loaded.project, 'rename');
  }
  return loaded;
}

async function assertProjectWritable(actor, projectId, options = {}) {
  const loaded = await loadProjectForWrite(actor, projectId, { allowArchived: options.allowArchived === true });
  if (!loaded) throw new Error('project_not_found');
  assertCanWriteProject(actor, loaded.project, loaded.policy);
  return loaded;
}

async function renameProject(actor, projectId, rawName) {
  // Being able to SEE a project was the only check here, so a viewer — or a
  // workspace owner looking at a colleague's private project — could rename it.
  // allowArchived: renaming is how an archived project's name is freed for
  // reuse (the duplicate gate counts archived rows), and it touches no memory.
  await assertProjectRenamable(actor, projectId);
  const project = await getProject(actor, projectId);
  if (!project) throw new Error('project_not_found');
  if (isTooShortProjectName(rawName)) {
    const err = new Error('project_name_too_short');
    err.publicMessage = `project_name_too_short: "${String(rawName).trim()}" is only 1 character. Project names need at least ${MIN_PROJECT_NAME_LENGTH} — try something longer.`;
    throw err;
  }
  if (!isValidProjectName(rawName)) throw new Error('invalid_project_name');
  const name = String(rawName).trim();
  // Consistent with the rest of this function's validation: an over-limit name is
  // a mistake worth surfacing, not something to silently mangle mid-word.
  if (name.length > PROJECT_NAME_MAX_LENGTH) {
    const err = new Error('project_name_too_long');
    err.publicMessage = `project_name_too_long: project names must be ${PROJECT_NAME_MAX_LENGTH} characters or fewer (got ${name.length}). Shorten it and try again.`;
    throw err;
  }
  await store.renameProject(actor, projectId, name);
  return { ...project, project_name: name };
}

// THE FOLDER RULE LIVES IN services/folderRule.js. This, matchKindForCwd below
// and extractionService's capture routing all read the same claim from it, so
// the resolver and capture cannot disagree about which project a folder is.
function scoreProjectForCwd(project, cwd, workspaceKey = null) {
  return folderRule.folderScore(project, { cwd, workspaceKey });
}

async function getProjectForInjection(actor, projectId) {
  const ownerKey = getActorKey(actor);
  const project = await store.getProjectContextOnly(ownerKey, projectId);
  const repaired = await repairProjectIntegrity(project, { persist: false });
  if (!repaired) return null;
  const policy = await getProjectSharePolicy(actor, repaired);
  if (!canViewProjectForActor(actor, repaired, policy)) return null;
  if (!isProjectOwner(actor, repaired) && repaired.visibility === 'shared' && policy.enabled) {
    return {
      ...repaired,
      context: filterContextBySectionPolicy(repaired.context || {}, policy.sections),
    };
  }
  return repaired;
}

// Classify HOW a project matched the cwd, so callers can tell a real
// "I'm working in this project" signal apart from the recency-only tiebreaker.
// 'path' — cwd is (inside) a linked path; the only signal strong enough to
//   safely write a brief file into that directory. 'name' / 'recency_fallback'
//   are guesses and must be surfaced as low-confidence, never written to disk.
function matchKindForCwd(project, cwd, workspaceKey = null) {
  const claim = folderRule.folderClaim(project, { cwd, workspaceKey });
  return { kind: claim.kind, matchedPath: claim.matchedPath, writable: claim.writable, warning: claim.warning, exact: claim.exact === true };
}

// READS AND WRITES DO NOT GET THE SAME ANSWER.
//
// `name` means "the project's name CONTAINS the directory's basename": a
// directory called `api` matches "Acme API", "Rapid Prototype" and "Therapist
// notes" alike. That is a fair guess to SHOW somebody, flagged as a guess, and
// no basis for deciding where their memory is filed — a wrong write is not
// undoable from the tool that made it. So a caller resolving a write target
// passes { forWrite: true } and a name match is skipped: with a location and
// nothing better it gets null, and the caller asks for a project_id. The same
// goes for a parent folder of another or unknown repository (kind
// 'ancestor_path'): shown, with a warning, never written to. See folderRule.js.
//
// What may receive a write:
//   explicit (the caller named it), path, pinned, workspace, session.
// And, ONLY for a caller with no location at all (every hosted surface):
//   recency_fallback (this person's own most recent project) and
//   shared_fallback. They are the only signals such a surface can have, and
//   they are about this person rather than about a directory name. With a
//   location they are never produced — resolution returns null first.
//   shared_fallback is a write target only for somebody with no work of their
//   own anywhere; anyone else is shown it READ-ONLY (stampMatch readOnly).
// Every result carries match_confidence and write_target, so a consumer that
// resolved for reading can still tell whether it may write there.
const HIGH_CONFIDENCE_MATCH_KINDS = new Set(['explicit', 'path', 'pinned', 'workspace', 'session']);

function describeMatch(matchKind) {
  const high = HIGH_CONFIDENCE_MATCH_KINDS.has(matchKind);
  return {
    match_confidence: high ? 'high' : 'low',
    write_target: high || matchKind === 'recency_fallback' || matchKind === 'shared_fallback',
  };
}

// `guessed` marks a result that came from somewhere OTHER than this caller: the
// person's most recent binding on a different connection, or the most recently
// touched project. It is not a confidence score (match_kind already carries
// that) but an answer to "why am I in this project" — the one thing a user who
// lands in the wrong one cannot otherwise work out.
//
// `readOnly` keeps the kind (and so every consumer's reading of it) but takes
// away the write: the project is shown, and nothing without a project_id is
// filed there. match_confidence is already 'low' for every fallback kind.
function stampMatch(project, matchKind, matchedPath = null, { guessed = false, readOnly = false, warning = null } = {}) {
  project.match_kind = matchKind;
  project.matched_path = matchedPath;
  project.match_guessed = guessed;
  Object.assign(project, describeMatch(matchKind));
  if (readOnly) project.write_target = false;
  // A guess that is shown but not written to says why (the folder rule: a parent
  // folder of another or unknown repository is read with a warning).
  if (warning) project.match_warning = warning;
  return project;
}

// Has this person a project or a session binding of their own in any workspace
// they belong to OTHER than `ownerKey`? Tier 6's precondition, checked where
// tiers 4 and 5 cannot see. The workspaces are their memberships plus their
// personal workspace (a founder predating the membership backfill has no row
// for it). A person-less actor has no "elsewhere" and is answered false.
// Throws when it cannot answer; the two wrappers below decide what that means.
async function checkOwnWorkElsewhere(actor, ownerKey = getActorKey(actor), identities = workspace.actorIdentities(actor)) {
  const personId = workspace.actorPersonId(actor);
  if (!personId) return false;
  const memberships = Array.isArray(actor.workspace_memberships)
    ? actor.workspace_memberships
    : await workspace.listMemberships(personId);
  const personal = await workspace.personalWorkspaceKey(actor);
  const elsewhere = [...new Set([...memberships.map((m) => m.owner_key), personal])]
    .filter((key) => key && key !== ownerKey);
  if (!elsewhere.length) return false;
  return store.hasOwnWorkInWorkspaces(elsewhere, identities, {
    unattributedIn: personal && personal !== ownerKey ? personal : null,
  });
}

// For ROUTING. Fails CLOSED: an unanswerable question takes the write away,
// because a refused id-less write costs the caller a project_id and a wrong one
// files their words into somebody else's project.
async function hasOwnWorkElsewhere(actor, ownerKey, identities) {
  try {
    return await checkOwnWorkElsewhere(actor, ownerKey, identities);
  } catch (err) {
    console.warn(`[CONTEXT] could not check work in other workspaces, not guessing: ${err.message}`);
    return true;
  }
}

// A workspace's display name: organizations.name, the name the dashboard's
// switcher and the invite-accept reply show. null when it cannot be read.
// Capped at 48 characters: it goes into refusals that the hosted normaliser
// cuts at 500, and the longest of them is 438 without the name.
async function workspaceDisplayName(ownerKey) {
  if (!ownerKey) return null;
  const db = require('../config/db');
  const res = await db.query('SELECT name FROM organizations WHERE org_id = $1', [ownerKey], 'org-system')
    .catch(() => ({ rows: [] }));
  const name = String(res.rows[0]?.name || '').replace(/["\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  return name.length > 48 ? `${name.slice(0, 47)}…` : name;
}

// How the workspace is named in a sentence: its display name in quotes, never
// a raw org id, and "this workspace" when the name cannot be read.
async function workspaceLabel(ownerKey) {
  const name = await workspaceDisplayName(ownerKey);
  return name ? `"${name}"` : 'this workspace';
}

// THE WHOLE REFUSAL for an id-less write from a person whose own work is in
// another workspace, in the order they need it: nothing was saved; where this
// connection is working; where their own projects are; how to save there
// (switch workspace) or here (name one of this workspace's projects); and what
// creating a project here means.
//
// It REPLACES the generic refusal rather than following it. Round 1 appended
// a sentence to "…or, if there is no project yet, create one with
// manage_projects(action:"create")", and recall listed only the team's
// projects, so an assistant doing exactly what it was told created the
// person's blog in the TEAM — shared with every member by default — and saved
// their private note into it (journey round 2). Creating here is still
// possible and is described; it is never offered as the way forward.
//
// Said only when it is known to be true: this is wording, not routing, so an
// unanswerable question says nothing rather than something false. Never names
// the other workspace or anything in it. `param` is the caller's own spelling
// of the project argument; `listing` the call that lists this workspace's
// projects on that surface, or null where there is none.
function ownWorkElsewhereRefusal(label, { param = 'project_id', listing = 'recall(action:"projects")' } = {}) {
  return 'Nothing was saved. '
    + `This connection is working in ${label}, and your own projects are in another workspace you belong to. `
    + 'To save there, switch workspace in the dashboard\'s workspace switcher and continue. '
    + `To save here, pass ${param} for one of this workspace's projects${listing ? ` (${listing} lists them)` : ''}. `
    + 'A project created here belongs to this workspace and, in a workspace with more than one member, is shared with its members by default.';
}

async function ownWorkElsewhereNote(actor, options = {}) {
  const elsewhere = await checkOwnWorkElsewhere(actor).catch(() => false);
  if (!elsewhere) return '';
  return ownWorkElsewhereRefusal(await workspaceLabel(getActorKey(actor)), options);
}

/**
 * Which project does this actor's next read or write belong to?
 *
 * THE FALLBACK ORDER IS THE WHOLE POINT, and it used to end in the wrong place.
 * With no cwd and no workspace key — every hosted/web surface: claude.ai,
 * ChatGPT, any connector without a working directory — this fell all the way
 * through to "the most recently updated project in the WHOLE workspace", and it
 * is re-evaluated on every single write. So a teammate saving their own work, or
 * the same person opening another tool, silently redirected the next write into a
 * project this actor had never touched. On a shared workspace that is somebody
 * else's brief being overwritten; the candidate list was not even
 * visibility-filtered, so a colleague's personal project was one recency
 * tiebreak away from being the destination.
 *
 * The order now, most specific first:
 *   1. an explicit project_id — resolved by the CALLER before it gets here
 *      (resolveProjectRefOrActive, applyExtraction's session/project binding).
 *   2. the workspace pin: the subproject this person switched to for this repo.
 *   3. a real location signal — linked path > same workspace > name.
 *   4a. THIS SESSION's own binding, when the caller names its session. The
 *      connection that has been working somewhere is the authority on where it
 *      is working; nothing another connection does may move it.
 *   4b. this PERSON's most recent binding anywhere, as the opening guess for a
 *      connection that has no binding of its own yet.
 *   5. this PERSON's own most recently touched project.
 *   6. nothing. A project the actor neither authored nor worked in is never the
 *      answer — "most recently updated in the workspace" is not a signal about
 *      this actor at all.
 *
 * 4a IS THE FIX FOR CROSS-CLIENT REDIRECTION. Tiers 4b and 5 are both facts
 * about the person rather than about this connection, and re-evaluating them on
 * every call meant a claude.ai tab writing to one project moved where an editor
 * connector's next id-less read AND write landed. Reproduced live. They stay,
 * because a brand-new connection has nothing better, and both now mark the
 * result `match_guessed` so start_session can say out loud that it guessed.
 *
 * Solo users are unaffected: on a one-person workspace every project is theirs,
 * so tier 5 returns exactly what the old recency fallback returned.
 */
// How quiet a session must have been before a newly created project is read as
// "I am starting here now" rather than "I made this for later", and how long
// such a create keeps that claim. See the createdSince rule in tier 4.
const SESSION_QUIET_BEFORE_CREATE_MS = 10 * 60 * 1000;
const CREATED_PROJECT_CLAIMS_WRITES_MS = 2 * 60 * 60 * 1000;

// WHERE THIS CONNECTION SAID IT WAS WORKING, IF THAT PROJECT CAN STILL TAKE A
// WRITE (journey r5).
//
// getSessionBinding reads an archived project as no binding, and tier 4a used
// to skip a project the caller can no longer read: either way resolution fell
// through to this person's next most recent project and the write went there.
// For a WRITE that is the wrong answer. A connection's binding is its own
// statement of where it works, so when that project cannot take the write the
// write is refused with the reason, and nothing lands anywhere else. Null when
// the connection is bound to nothing (a fresh one, a closed session, a deleted
// project): those still resolve as they always did.
//
// ONLY AN ANSWER IS A REFUSAL. "No longer shared with you" is said when the store
// ANSWERED that the project is not readable (getProjectForInjection resolves
// null). A database error or a timeout while asking is not an answer: the write
// is refused all the same, because where it would land is unknown, but as a
// temporary failure that says nothing about the share.
async function heldSessionProject(actor, ownerKey, sessionId) {
  let state;
  try {
    state = await store.getSessionBindingState(ownerKey, sessionId);
  } catch (err) {
    throw boundProjectTemporaryError(err);
  }
  if (!state) return null;
  let project;
  try {
    project = await getProjectForInjection(actor, state.project_id);
  } catch (err) {
    throw boundProjectTemporaryError(err);
  }
  if (!project) throw boundProjectUnavailableError(state.project_id);
  if (state.archived) throw boundProjectArchivedError(state.project_id, project.project_name);
  return project;
}

// The other project this caller's LOCATION points at, if any: what a write bound
// to A reports when the caller says it is working in B's folder (journey r5).
// A path or same-repository match only; a name match is not a signal.
function locationConflictFor(candidates, boundProjectId, cwd, workspaceKey) {
  const rival = [...candidates]
    .map((candidate) => ({ candidate, match: matchKindForCwd(candidate, cwd, workspaceKey) }))
    .filter(({ candidate, match }) => candidate.project_id !== boundProjectId && (match.kind === 'path' || match.kind === 'workspace'))
    .sort((a, b) => scoreProjectForCwd(b.candidate, cwd, workspaceKey) - scoreProjectForCwd(a.candidate, cwd, workspaceKey))[0];
  return rival
    ? { project_id: rival.candidate.project_id, project_name: rival.candidate.project_name || null, match_kind: rival.match.kind }
    : null;
}

async function resolveActiveProject(actor, cwd, workspaceKey = null, options = {}) {
  const trace = {};
  const result = await resolveActiveProjectTiers(actor, cwd, workspaceKey, options, trace);
  // A READ that the dead binding no longer decides is told so, so it is not
  // mistaken for the project the connection was in. Writes never get here: they
  // were refused above.
  if (result && trace.staleBinding) result.stale_binding = trace.staleBinding;
  return result;
}

/**
 * The projects a caller handed a GUESS (or nothing) most plausibly meant
 * instead: this person's own live projects first, then anything else they may
 * read, most recently touched first, never `excludeProjectId`.
 *
 * Exists because a low-confidence answer that names no way out gets used
 * anyway: the agent has a brief, the brief is wrong, and switching would cost
 * a search it does not know to make. Listing the likely ids beside the guess
 * makes the correction one call. Same visibility-filtered candidate read
 * resolution ranks, so it can never name a project the caller may not see.
 * Best effort: an error answers [] and never costs the brief it decorates.
 */
async function listRoutingAlternatives(actor, excludeProjectId = null, limit = 3) {
  try {
    const ownerKey = getActorKey(actor);
    const scope = await actorVisibilityScope(actor, ownerKey);
    const candidates = await store.listProjectCandidates(ownerKey, scope);
    const mine = new Set(scope.actorIdentities || []);
    const isMine = (c) => scope.system || c.owner_user_id === null || mine.has(c.owner_user_id);
    const others = candidates.filter((c) => c.project_id !== excludeProjectId);
    // Stable partition: both halves keep the store's updated_at DESC order.
    return [...others.filter(isMine), ...others.filter((c) => !isMine(c))]
      .slice(0, Math.max(0, limit))
      .map((c) => ({ project_id: c.project_id, project_name: c.project_name || null }));
  } catch {
    return [];
  }
}

async function resolveActiveProjectTiers(actor, cwd, workspaceKey, { forWrite = false, sessionId = null } = {}, trace = {}) {
  const ownerKey = getActorKey(actor);
  // Same scoping listProjects uses.
  const scope = await actorVisibilityScope(actor, ownerKey);
  const { system: isSystem, actorIdentities: identities } = scope;

  // A WRITE FOLLOWS THE CONNECTION'S OWN PROJECT, OR IS REFUSED (journey r5).
  // Decided before anything else is consulted, so neither a location nor a
  // more recent project can take a write the connection meant for somewhere
  // else. When the caller ALSO reports a folder that belongs to a different
  // project, the write still goes to the connection's project and the result
  // carries `location_conflict` for the reply to say so; nothing moves.
  const held = forWrite && sessionId && !isSystem
    ? await heldSessionProject(actor, ownerKey, sessionId)
    : null;
  if (held) {
    const bound = stampMatch(held, 'session');
    if (cwd || workspaceKey) {
      const candidates = await store.listProjectCandidates(ownerKey, { ...scope, cwd, workspaceKey });
      const conflict = locationConflictFor(candidates, held.project_id, cwd, workspaceKey);
      if (conflict) bound.location_conflict = conflict;
    }
    return bound;
  }
  // The location rides along so a project matched by WHERE the caller is can
  // never be hidden behind 200 more recently touched rows.
  const candidates = await store.listProjectCandidates(ownerKey, { ...scope, cwd, workspaceKey });
  if (!candidates.length) return null;

  // Explicit switch wins. If the user pinned an active subproject for THIS
  // codebase (switch_subproject → workspace pointer), honor it over the recency
  // tiebreak among the siblings that share this workspace. The pin is
  // workspace-scoped, so it can never hijack a different repo. A stale pin (the
  // project was deleted or moved to another workspace) is ignored and resolution
  // falls through to normal scoring. match_kind 'pinned' does NOT trigger a disk
  // brief write (only 'path' does) — the umbrella stays the on-disk anchor while
  // the pinned subproject is delivered live by start_session.
  if (workspaceKey) {
    // Person first, then the workspace default — see store.getWorkspacePointer.
    const pinnedId = await store.getWorkspacePointer(ownerKey, workspaceKey, identities).catch(() => null);
    if (pinnedId) {
      const pinned = candidates.find((c) => c.project_id === pinnedId && c.workspace_key === workspaceKey);
      if (pinned) {
        const project = await getProjectForInjection(actor, pinned.project_id);
        if (project) return stampMatch(project, 'pinned');
      }
    }
  }

  // TIER 3 — a real location signal. Path > workspace > name.
  //
  // The confidence floor below used to be conditional on `hasLocationSignal`,
  // because with no cwd "recency was the only available signal". That was true of
  // the candidate set as it then existed — workspace-wide and unscoped — and it is
  // what made a web tool's writes follow whoever last touched anything. A no-cwd
  // caller is not out of signals: it has this person's own session binding and
  // this person's own history, both below. So the floor is unconditional here, and
  // "recency" now means recency AMONG THIS ACTOR'S OWN projects.
  const hasLocationSignal = Boolean(cwd) || Boolean(workspaceKey);
  const ordered = [...candidates].sort((a, b) => scoreProjectForCwd(b, cwd, workspaceKey) - scoreProjectForCwd(a, cwd, workspaceKey));
  for (const candidate of ordered) {
    const match = matchKindForCwd(candidate, cwd, workspaceKey);
    // Confidence floor: never auto-select a project on the recency tiebreak alone.
    // A 'path' (cwd inside a linked path) or 'name' (project name contains the repo
    // dir) match is a real "I'm working here" signal; 'recency_fallback' is just
    // "most recently touched", which is what surfaced the WRONG project (e.g. an
    // unrelated work-stream) for a directory it was never linked to.
    if (match.kind === 'recency_fallback') continue;
    // Only what the folder rule says OWNS the folder answers a write: a name
    // match, a parent folder of another or unknown repository, and a repository
    // identity that is only a folder name answer reads. Skipped, not returned, so
    // a weaker-scored candidate with a REAL signal can still be the write target.
    if (forWrite && !match.writable) continue;
    const project = await getProjectForInjection(actor, candidate.project_id);
    if (!project) continue;
    // An older project carries no repository identity, and without one nothing
    // below its linked path can ever own a folder. The first time a person
    // stands IN the linked directory itself, with an identity to give, it is
    // stamped (only when it has none). Best effort: never costs the read.
    if (match.exact && workspaceKey && !candidate.workspace_key && !isSystem) {
      store.stampWorkspaceKeyIfMissing(ownerKey, candidate.project_id, String(workspaceKey)).catch(() => {});
    }
    return stampMatch(project, match.kind, match.matchedPath, {
      readOnly: match.kind === 'workspace' && !match.writable,
      warning: match.warning,
    });
  }
  // A caller that gave a location and matched nothing gets the global-only brief,
  // not a guess — unchanged. Falling through to the person-scoped tiers below
  // would reintroduce the wrong-directory pick this floor exists to stop.
  if (hasLocationSignal) return null;

  const byId = new Map(candidates.map((candidate) => [candidate.project_id, candidate]));

  // TIER 4a — THIS SESSION's own binding. One primary-key seek (no new index),
  // and it short-circuits before the person-wide lookup below, so the common
  // case of a connection that already knows where it is costs strictly less
  // than it used to rather than more.
  if (sessionId && !isSystem) {
    const state = await store.getSessionBindingState(ownerKey, sessionId).catch(() => null);
    if (state) {
      // A store error while asking is not an answer: it leaves no note (nothing
      // is known), and the read resolves through the tiers below as before.
      let asked = true;
      const read = () => getProjectForInjection(actor, state.project_id).catch(() => { asked = false; return null; });
      const project = !state.archived && byId.has(state.project_id) ? await read() : null;
      if (project) return stampMatch(project, 'session');
      // The binding is dead (archived, or no longer readable). A read still
      // resolves through the tiers below, but it says that it did, and why.
      // The name is given only for an archived project the caller can read.
      const readable = state.archived ? await read() : null;
      if (asked) {
        trace.staleBinding = {
          project_id: state.project_id,
          reason: state.archived && readable ? 'archived' : 'unreadable',
          project_name: state.archived && readable ? (readable.project_name || null) : null,
        };
      }
    }
  }

  // TIER 4b — this person's most recent binding ANYWHERE. The one durable record
  // of "I have actually worked here" that crosses tool surfaces, and the right
  // opening guess for a connection that has never bound anything. Looked up in
  // `byId` first so a stale binding to something this actor may no longer see is
  // simply skipped.
  const binding = isSystem
    ? null
    : await store.getLatestSessionBinding(ownerKey, identities).catch(() => null);
  // A PROJECT THIS PERSON CREATED AFTER THEIR SESSION WENT QUIET WINS.
  //
  // "Create a project, then save to it" is the first thing a new user does, and
  // the second call carries no project_id. The binding still pointed at whatever
  // they had written to before, so the save landed in the OLD project and the
  // new one stayed empty. Creating a project is a louder statement of intent
  // than having once written somewhere else; the binding catches up on the
  // first write.
  //
  // TWO BOUNDS, BOTH LEARNED THE HARD WAY.
  //
  // `created_at > last_seen_at` on its own said yes far too often. It fires for
  // ANY creation path — the dashboard, a trail import, an extraction
  // auto-create — and a session that is mid-flight was last seen moments ago,
  // so a project made FOR LATER stole the very next id-less manage_tasks and
  // record_finding from the project the person was actually working in. It also
  // never expired: a session dormant for ten days let anything created since
  // outrank a binding that was still the better guess.
  //
  // So the create must have interrupted nothing (the session had already gone
  // quiet) and must still be recent enough to be what the caller means. A
  // create that meets neither is not ignored — it simply does not beat a
  // binding, and an explicit project_id or a start_session still selects it.
  const mineIds = new Set(identities);
  const nowMs = Date.now();
  const createdSince = binding?.last_seen_at
    ? candidates.find((candidate) => {
      // The bound project itself can satisfy every clause below (a session
      // bound to a project created minutes ago), and answering "created since"
      // for it only swaps a truthful `session` match for a recency fallback.
      if (candidate.project_id === binding.project_id) return false;
      if (!candidate.created_at || !mineIds.has(candidate.owner_user_id)) return false;
      const createdAt = Date.parse(candidate.created_at);
      const lastSeen = Date.parse(binding.last_seen_at);
      if (!Number.isFinite(createdAt) || !Number.isFinite(lastSeen)) return false;
      if (createdAt - lastSeen <= SESSION_QUIET_BEFORE_CREATE_MS) return false;
      return nowMs - createdAt <= CREATED_PROJECT_CLAIMS_WRITES_MS;
    })
    : null;
  const boundProjectId = createdSince ? null : (binding?.project_id || null);
  if (boundProjectId && byId.has(boundProjectId)) {
    const project = await getProjectForInjection(actor, boundProjectId);
    // A guess: this is where the person was last working, which may well have
    // been a different tool in a different project. Tier 4a above is the same
    // match_kind arrived at from this connection's own history and is not.
    if (project) return stampMatch(project, 'session', null, { guessed: true });
  }

  // TIER 5 — this person's own most recently touched project. `candidates` is
  // already updated_at DESC, so the first match is the most recent.
  //
  // owner_user_id NULL passes for the same reason it passes in visibilityClause:
  // it marks a project created before per-user attribution existed, which belongs
  // to the workspace rather than to anyone in particular, and
  // backfillProjectOwnership resolves that ambiguity the moment a workspace gains
  // a second member. Excluding it would strand every pre-attribution solo user
  // with no active project at all.
  const mine = new Set(identities);
  for (const candidate of candidates) {
    if (isSystem || candidate.owner_user_id === null || mine.has(candidate.owner_user_id)) {
      const project = await getProjectForInjection(actor, candidate.project_id);
      if (project) return stampMatch(project, 'recency_fallback', null, { guessed: true });
    }
  }

  // TIER 6 — THE PERSON WHO HAS AUTHORED NOTHING.
  //
  // Reaching here means this actor owns no project, has no unattributed one to
  // fall back on, and has never been bound to anything: the invited teammate on
  // their first hosted session. Returning null handed them the workspace
  // overview instead of a brief, so team_context_received — the event that marks
  // the product working for a team — could not fire on the session it exists
  // for, and every call that omits project_id threw.
  //
  // The most recent SHARED project is the answer, and only that: `shared` is the
  // workspace saying "this is for the team", which is exactly what this person
  // was invited to. Never `private` (an owner can read those; they were not
  // offered to anybody) and never `personal`. It cannot reintroduce the redirect
  // tier 5 was written to stop, because anyone with a project of their own
  // returned there and never gets this far.
  //
  // "AUTHORED NOTHING" MEANS ANYWHERE, NOT ONLY HERE. Tiers 4 and 5 look in
  // the current workspace alone, so somebody with a personal project they had
  // been saving to all morning reached this tier the moment they accepted an
  // invite and their hosted connection started acting in the team: their next
  // "save this" was filed into a colleague's shared project, a card landed on
  // its board, and the reply said "Context updated". That person is not who
  // this tier is for, and nothing here can tell their next sentence is about
  // the team. So a person with a project or a binding of their own in any
  // other workspace they belong to is never given this project as a WRITE
  // target: resolving for a write returns null, and an id-less write is
  // refused until they name the project.
  //
  // They still READ it, stamped write_target false. Most invitees have written
  // something of their own before they join, and the team's shared brief on
  // their first session is what this tier exists for (team_context_received
  // fires from it); withholding it cost them that. Every hosted handler that
  // writes to a project it resolved itself resolves with forWrite, so the read
  // is never written to. Asked once, and only when there is a project to offer.
  if (!isSystem) {
    let authoredElsewhere = null;
    for (const candidate of candidates) {
      if (candidate.visibility !== 'shared') continue;
      if (authoredElsewhere === null) authoredElsewhere = await hasOwnWorkElsewhere(actor, ownerKey, identities);
      if (authoredElsewhere && forWrite) return null;
      const project = await getProjectForInjection(actor, candidate.project_id);
      if (project) return stampMatch(project, 'shared_fallback', null, { readOnly: authoredElsewhere });
    }
  }

  // Nothing of this actor's resolved, and nothing was shared with them. The
  // workspace's most recently updated project is a fact about somebody else, so
  // it is not an answer.
  return null;
}

function normalizeLinkedPath(value) {
  return String(value || '').toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Which of the directories a write came from may be LINKED to the project it
 * landed in.
 *
 * A linked path is the strongest routing signal there is: resolveActiveProject
 * ranks it above everything else and it never expires. applyExtraction used to
 * union the session's cwd into whatever project the write landed in, including
 * one the caller had merely NAMED. So jotting a note for project X while
 * standing in project Y's repo linked Y's directory to X, and because X had just
 * been written to, the tie went to X on recency: every later session in Y's repo
 * opened X, permanently, from a single write.
 *
 * A directory is linked only when nobody else already owns it:
 *   - another live project links that exact directory: never. That includes an
 *     umbrella's repo root, which stays the umbrella's even when a pinned
 *     work-stream is written to from there.
 *   - another live project links an ANCESTOR of it: only for FAMILY, meaning
 *     parent, child, sibling, or the same workspace_key. That is a monorepo
 *     work-stream claiming its own package under the umbrella's root, which is
 *     how deepest-match routing is meant to be fed. An unrelated project does
 *     not get to carve a sub-directory out of somebody else's repo.
 * A project that was resolved BY location already covers the directory, or is
 * family to whatever does, so it keeps learning its sub-directories exactly as
 * before. And a directory nobody claims is still linked by the first write from
 * it, named or not: that is the first-run flow (project made in the dashboard,
 * first save from its repo), and refusing it would leave that project matching
 * on name forever.
 *
 * Rows written before this rule keep whatever they had linked. There is no
 * record of how a path was acquired, so none can be safely removed.
 */
async function claimablePaths(ownerKey, project, paths, incomingWorkspaceKey = null, { createdHere = false } = {}) {
  const own = new Set((project.linked_paths || []).map(normalizeLinkedPath).filter(Boolean));
  const wanted = uniqueStrings(paths).filter((candidate) => {
    const norm = normalizeLinkedPath(candidate);
    return norm && !own.has(norm);
  });
  if (!wanted.length) return [];
  // Fails CLOSED: a path that is not linked today is linked by the next write,
  // while a wrong link is forever.
  const claims = await store.listLinkedPathClaims(ownerKey, project.project_id).catch(() => null);
  if (!claims) return [];
  const workspaceKey = project.workspace_key || incomingWorkspaceKey || null;
  const isFamily = (other) => (
    (project.parent_project_id && project.parent_project_id === other.project_id)
    || (other.parent_project_id && other.parent_project_id === project.project_id)
    || (project.parent_project_id && project.parent_project_id === other.parent_project_id)
    || (workspaceKey && workspaceKey === other.workspace_key)
  );
  return wanted.filter((candidate) => {
    const norm = normalizeLinkedPath(candidate);
    return !claims.some((other) => other.linked_paths.some((linked) => {
      const claimed = normalizeLinkedPath(linked);
      if (!claimed) return false;
      if (claimed === norm) return true;
      if (!norm.startsWith(`${claimed}/`)) return false;
      // The claimant's path is ABOVE this directory. It holds the directory only
      // when the folder rule says it OWNS it (the same repository), and then only
      // against a project that is not its family. A parent folder of ANOTHER
      // repository owns nothing beneath it: a linked home folder used to keep
      // every repository under it from ever being linked to its own project.
      const claim = folderRule.folderClaim(other, { cwd: norm, workspaceKey: incomingWorkspaceKey });
      if (claim.kind === folderRule.CLAIM.PATH) return !isFamily(other);
      // A directory whose repository is not known cannot be told from one that
      // is inside the claimant's tree, so a named write does not carve it out of
      // it. Only a directory KNOWN to be another repository is free of the claim.
      // The exception is a project THIS capture just created: the claimant holds
      // the directory only as a guess (the folder rule), and a project that
      // cannot link its own directory is never found by the next session, which
      // creates another, every time.
      return !createdHere && claim.kind === folderRule.CLAIM.ANCESTOR && !incomingWorkspaceKey && !isFamily(other);
    }));
  });
}

// A project the caller NAMED that this actor cannot load. Worded once, and the
// same whether the id belongs to another workspace, to a colleague's personal
// project, or to nothing at all: telling those apart would confirm that an id
// exists somewhere the caller cannot see. `message` stays the bare code every
// route already maps to 404; the text is for the caller, and says the one thing
// the old answer never did, that nothing was saved.
function namedProjectNotFoundError() {
  const error = new Error('project_not_found');
  error.code = 'project_not_found';
  error.status = 404;
  error.mcpCode = 'resource_not_found';
  error.retryable = false;
  // The first two sentences fit the 200 characters the local dispatcher relays.
  error.publicMessage = 'project_not_found: nothing was saved. No project with that id is open to you in this workspace '
    + '(one in another workspace you belong to is written from there). '
    + 'Pass an id from recall(action:"projects"), or omit project_id to use the active project.';
  error.safeMessage = error.publicMessage;
  return error;
}

// WHY A BOUND PROJECT CANNOT TAKE THE CAPTURE: archived, or no longer readable by
// this person. Null when it is neither (a transient load failure is not a dead
// binding, and nobody is told one).
async function deadBindingOf(actor, projectId) {
  // A store error is not an answer: no note rather than a false one.
  let readable;
  try {
    readable = await getProjectForInjection(actor, projectId);
  } catch (err) {
    console.warn('[CONTEXT] could not tell why a capture\'s binding is dead, no notice recorded:', err?.code || err?.message);
    return null;
  }
  if (!readable) return { project_id: projectId, reason: 'unreadable', project_name: null };
  if (readable.archived_at) return { project_id: projectId, reason: 'archived', project_name: readable.project_name || null };
  return null;
}

async function recordDeadBindingNotice(actor, filedInProjectId, dead) {
  try {
    await store.saveBindingNotice(getActorKey(actor), workspace.actorPersonId(actor) || '', filedInProjectId, {
      deadProjectId: dead.project_id,
      deadProjectName: dead.project_name,
      reason: dead.reason,
    });
  } catch (err) {
    // A note about where a capture went must never cost the capture.
    console.warn('[CONTEXT] dead-binding notice not recorded:', err?.code || err?.message);
  }
}

// The sentence(s) the next brief for `projectId` carries, and clears. '' when
// there is nothing to say. Said once: the read is the delete.
async function takeDeadBindingNotice(actor, projectId) {
  const rows = await store.takeBindingNotices(getActorKey(actor), workspace.actorPersonId(actor) || '', projectId).catch(() => []);
  // Said in the same place, once: an owner made this person a project's author, or
  // (for an owner) another owner took one over (journey r7).
  const authorship = await authorStamps.takeBriefNotices(getActorKey(actor), workspace.actorPersonId(actor));
  const bindings = rows.map((row) => (row.reason === 'archived'
    ? `Last session was filed here because the project this connection was bound to, "${row.dead_project_name || row.dead_project_id}" (${row.dead_project_id}), is archived. To go back to it, restore it: manage_projects with action "restore" and project_id "${row.dead_project_id}". To work in another project, call manage_projects with action "select".`
    : `Last session was filed here because the project this connection was bound to (${row.dead_project_id}) is no longer shared with you. To work in another project, call manage_projects with action "select".`
  )).join('\n');
  return [authorship, bindings].filter(Boolean).join('\n');
}

/**
 * A name for a captured project whose proposed name another project already
 * holds and whose folder does not own (owner decision, journey round 6): the
 * proposed name with the folder added, "Billing (payments-api)". If that is
 * taken too, the parent folder is added, "Billing (work-payments-api)", and then
 * a short suffix taken from the folder (or the conversation, for a capture with
 * no folder), so the same capture always gets the same name and two projects
 * never share one.
 *
 * "Taken" is the server's own name identity, aliases and archived projects
 * included (findProjectCandidatesByName), so a name reference to either project
 * stays unambiguous on both dispatchers: the punctuation is dropped from the
 * identity, so "Billing (payments-api)" and "Billing" are different names.
 */
async function uniqueCaptureName(actor, proposed, { cwd = '', conversationRef = '' } = {}) {
  const base = String(proposed || '').trim() || 'Untitled project';
  const segments = String(cwd || '').split(/[\\/]+/).filter(Boolean);
  const folder = segments[segments.length - 1] || '';
  const parent = segments[segments.length - 2] || '';
  const fit = (name) => (name.length > PROJECT_NAME_MAX_LENGTH ? name.slice(0, PROJECT_NAME_MAX_LENGTH).trimEnd() : name);
  const free = async (name) => (await findProjectCandidatesByName(actor, name)).length === 0;
  const withFolder = (label) => `${base.slice(0, Math.max(1, PROJECT_NAME_MAX_LENGTH - label.length - 3)).trimEnd()} (${label})`;

  const attempts = [];
  if (folder) attempts.push(withFolder(folder));
  if (folder && parent) attempts.push(withFolder(`${parent}-${folder}`));
  for (const attempt of attempts) {
    const name = fit(attempt);
    if (await free(name)) return name;
  }
  const seed = String(cwd || conversationRef || '');
  const short = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 6);
  const stem = attempts[0] || withFolder(short);
  const suffixed = attempts[0] ? `${stem} ${short}` : stem;
  if (await free(fit(suffixed))) return fit(suffixed);
  for (let n = 2; n < 1000; n += 1) {
    const name = fit(`${suffixed} ${n}`);
    if (await free(name)) return name;
  }
  return fit(`${suffixed} ${crypto.randomBytes(3).toString('hex')}`);
}

async function applyExtraction(actor, input) {
  // A NAMED PROJECT IS LOADED BEFORE ANYTHING IS WRITTEN, AND NOTHING ELSE IS
  // TRIED WHEN IT DOES NOT LOAD.
  //
  // The session used to be upserted first, bound to whatever id the request
  // carried, and the project loaded later. An id this actor cannot open — the
  // personal project an AI tool still holds after its connection moved into a
  // team, or the other way round — then fell through to the extraction's own
  // proposal below: should_create_project made a NEW project in the bound
  // workspace, shared by default on a team, with the private note in it, and the
  // caller was told "Context updated". An id that exists nowhere hit the
  // sessions foreign key instead and surfaced as internal_error. Loading first
  // makes both of them the same not-found answer, and the session is bound only
  // to a project that has been loaded for this actor.
  //
  // requireWriteRole:false for the reason given at the load below: a viewer's
  // session is still recorded, and the single gate after it decides the write.
  const named = input.project_id
    ? await loadProjectForWrite(actor, input.project_id, { requireWriteRole: false })
    : null;
  if (input.project_id && !named) throw namedProjectNotFoundError();

  // A PROJECT NAMED FOR ONE CALL IS THAT CALL'S TARGET, NOT WHERE THE SESSION
  // NOW WORKS — when the caller says so (keep_session_binding: the hosted
  // dispatcher, whose session is the CONNECTION, stable for its whole life).
  // Binding it here moved a hosted connection into B on one note filed to B,
  // and the next id-less decision, card and finish_task followed it there (H3-1).
  // A session already bound keeps its binding; one bound to nothing yet (or
  // closed) is bound as it always was. Without the flag
  // (the REST route the local server saves through) nothing here changes.
  //
  // A binding to a project since ARCHIVED, or one the caller can no longer read,
  // is still HELD (journey r5): the person has not chosen anywhere else, and a
  // note filed to B by id must not be what moves them there. Their id-less
  // writes are refused until they restore A or select another project.
  const heldBinding = named && input.keep_session_binding
    ? (await store.getSessionBindingState(getActorKey(actor), input.session_id).catch(() => null))?.project_id || null
    : null;

  const session = await upsertSession(actor, input.session_id, {
    tool: input.tool,
    surface_type: input.session_context?.surface_type || inferSurfaceType(input.tool),
    conversation_ref: input.session_context?.conversation_ref,
    cwd: input.session_context?.cwd,
    host: input.session_context?.host,
    tab_id: input.session_context?.tab_id,
    status: input.session_context?.status || 'active',
    project_id: named && !heldBinding ? named.project.project_id : undefined,
  });

  // The session's own binding outranks the extraction's guess. That was always
  // the order written here, but upsertSession used to null the binding on every
  // call without a project_id, so the guess won every time.
  //
  // Now that the binding survives, it can also be STALE: this person can no
  // longer see the project, or it has been archived since. A stale binding must
  // not strand the write, so the routed candidate is still the next thing tried
  // (and with no candidate, the extraction may still create a project). A
  // project the caller NAMED is different: it is the only target, and failing
  // to load it is the answer (project_not_found, project_archived), never a
  // reason to write somewhere else.
  //
  // One routed answer DOES outrank the binding: 'stale_match'. The heuristic only
  // says it when another project is anchored (same conversation, inside a linked
  // path) MORE strongly than the binding's own 1.4 — a browser tab that has moved
  // to a conversation belonging to a different topic. It writes no delta (the
  // result is terminal), and what it has always done is move the session, so the
  // NEXT capture routes to where the person now is. While the binding was being
  // wiped that happened by accident; it is kept on purpose, or such a tab would
  // answer 'ambiguous' for the rest of its life.
  const candidateProjectId = input.extraction.project_candidate?.project_id || null;
  const bindingIsStale = input.extraction.routing_state === 'stale_match' && Boolean(candidateProjectId);
  let targetProjectId = input.project_id
    || (bindingIsStale ? candidateProjectId : null)
    || session.project_id
    || candidateProjectId;
  //
  // A DEAD BINDING STILL DOES NOT STRAND THE CAPTURE (owner decision, journey
  // r5): it is filed where the folder or the route points, as it always was.
  // What changed is that this is no longer silent. The next brief for the
  // project it landed in says the last session was filed there and why (see
  // recordDeadBindingNotice / takeDeadBindingNotice).
  let deadBinding = null;
  if (
    !input.project_id
    && session.project_id
    && candidateProjectId !== session.project_id
    && !(await loadProjectForWrite(actor, session.project_id, { requireWriteRole: false }).catch(() => null))
  ) {
    targetProjectId = candidateProjectId;
    deadBinding = await deadBindingOf(actor, session.project_id);
  }
  // RAW row, not getProject's filtered view: this function saves the full
  // context, and a filtered load persisted every unshared section as empty.
  //
  // LOADED BEFORE THE WORKSPACE GATE, ON PURPOSE. context_project_members exists
  // so an owner can hand one person write on one shared project, and that grant
  // lives on the project — so a gate that runs before the project is known
  // cannot see it. Direct writes resolve it through projectWriteRole (see
  // loadProjectForWrite); extraction asserted the bare workspace role first and
  // refused a viewer-with-an-override outright, so the same person could save
  // through the dashboard and silently lose everything their session extracted.
  // requireWriteRole:false here so the load itself does not throw before the
  // override can be applied — the single gate below is the one that decides.
  //
  // A named project was already loaded at the top, and is the only target.
  const loaded = named || (targetProjectId
    ? await loadProjectForWrite(actor, targetProjectId, { requireWriteRole: false })
    : null);
  let project = loaded ? loaded.project : null;

  // A read-only member's session is still recorded above (it is their own), but
  // nothing extracted from it is written into the workspace.
  await assertWorkspaceWritable(
    actor,
    loaded ? (loaded.project.owner_key || getActorKey(actor)) : getActorKey(actor),
    loaded ? projectWriteRole(loaded.project, loaded.policy) : null
  );

  let createdByThisCapture = false;
  if (!project && input.extraction.should_create_project) {
    const candidateName = input.extraction.project_candidate?.project_name;
    const ownerKey = getActorKey(actor);

    // Dedup: check if a project with the same normalized name already exists.
    // findProjectByName is now actor-scoped, so a colleague's personal or private
    // project cannot be the match. The canViewProjectForActor check is kept as the
    // belt to that braces: merging into a project this actor cannot see would
    // write into it AND confirm it exists, and the fallback create below gives the
    // actor their own.
    const named = await findProjectByName(actor, candidateName);
    // A NAME IS NEVER ENOUGH TO MERGE A CAPTURE (owner decision, journey round 3).
    // Two repositories that both propose "API" or "Website" are two projects.
    // The project a name points at takes the capture only when something ties the
    // session to it: the folder rule says the directory (or its repository) is
    // that project's, or the conversation is one it has linked. Otherwise the
    // capture creates its own project below, and the name match changes nothing
    // (no alias, no linked directory, no text written into it).
    const conversationRef = String(input.session_context?.conversation_ref || session.conversation_ref || '').trim();
    // `merge_by_name` is set only by the import (POST /seed), where the person gave
    // the project's name themselves. A capture never sets it.
    const tiedToSession = Boolean(named) && (
      input.merge_by_name === true ||
      folderRule.folderClaim(named, {
        cwd: session.cwd || input.session_context?.cwd,
        workspaceKey: input.session_context?.workspace_key,
      }).writable
      || (Boolean(conversationRef) && (named.linked_conversations || []).some((ref) => String(ref).trim() === conversationRef))
    );
    const existing = named && tiedToSession && canViewProjectForActor(actor, named, await getProjectSharePolicy(actor, named))
      ? named
      : null;
    // The name lookup deliberately sees archived rows. Merging into one is the
    // silent write-into-the-archive this refusal exists for, and creating a
    // second live project under the same name would be worse.
    if (existing?.archived_at) throw archivedProjectError(existing);
    if (existing) {
      project = existing;
      // Store this name variant as an alias if it differs from the canonical name
      if (candidateName && normalizeName(candidateName) !== normalizeName(existing.project_name)) {
        // Guarded for the same reason as bindSessionTopic's link: the whole row,
        // context included, goes back with the alias.
        await withContextWriteRetry(async (attempt) => {
          const current = attempt === 1 ? existing : await store.getProject(ownerKey, existing.project_id);
          if (!current) return;
          const updatedAliases = [...new Set([...(current.aliases || []), candidateName])];
          await saveProjectGuarded({ ...current, aliases: updatedAliases }, actor);
        });
      }
    } else {
      try {
        createdByThisCapture = true;
        project = await createProject(actor, {
          // A name another project already holds, that this folder does not own,
          // becomes a name of its own (see uniqueCaptureName): two projects never
          // share a name.
          project_name: named && !existing
            ? await uniqueCaptureName(actor, candidateName, {
              cwd: session.cwd || input.session_context?.cwd,
              conversationRef: input.session_context?.conversation_ref || session.conversation_ref,
            })
            : (candidateName || 'Untitled project'),
          // Carry the extraction's classification so a freshly-captured life topic
          // is born as category 'topic' (suppresses coding fields, enables topic enrichment).
          category: input.extraction.delta?.category,
          description: '',
          goals: [],
          current_status: '',
          // No user in this loop to fix a rejected/duplicate name — fall back
          // rather than throw and abort the whole extraction.
          allow_fallback_name: true,
        });
      } catch (err) {
        // At the workspace cap, extraction can't auto-create another project.
        // No-op (project stays null → returns null below) instead of failing the
        // whole update — the explicit create_project path is where the upgrade
        // prompt surfaces to the user.
        if (err?.message !== 'project_limit_exceeded') throw err;
        console.warn('[CONTEXT] extraction auto-create blocked by project cap', { owner: ownerKey });
      }
    }
  }

  if (!project) return null;
  project = await repairProjectIntegrity(project);
  if (deadBinding && project.project_id !== deadBinding.project_id) {
    await recordDeadBindingNotice(actor, project.project_id, deadBinding);
  }

  // The delta is redacted before it is sanitised and merged, for the same
  // reason updateProjectContext redacts its patch: the stored context is the
  // masked text, and an unmasked delta compared against it re-applies (and
  // reports as applied) items that are already there.
  let sanitizedExtraction = sanitizeExtraction(project, input.extraction && input.extraction.delta
    ? { ...input.extraction, delta: store.redactForStorage(input.extraction.delta) }
    : input.extraction);
  const sharePolicy = await getProjectSharePolicy(actor, project);
  // Every non-author is filtered, not only on a shared project: a workspace owner
  // can SEE a colleague's private project, and used to skip this filter entirely
  // because it only ran for 'shared'. canEditSectionForActor refuses every
  // section of a non-shared project, so for them the delta simply empties.
  if (!isProjectOwner(actor, project)) {
    const editableDelta = {};
    const blockedFields = [];
    for (const [field, value] of Object.entries(sanitizedExtraction.delta || {})) {
      const sectionKey = mapSectionFromField(field);
      if (!SHAREABLE_SECTIONS.includes(sectionKey) || !canEditSectionForActor(actor, project, sharePolicy, sectionKey)) {
        if (!blockedFields.includes(sectionKey)) blockedFields.push(sectionKey);
        continue;
      }
      editableDelta[field] = value;
    }
    sanitizedExtraction = {
      ...sanitizedExtraction,
      delta: editableDelta,
      blocked_fields: blockedFields,
      no_material_change: !Object.keys(editableDelta).length,
    };
  }
  // THE MERGE WRITES source_summary ITSELF, from the match reason ("Updated from
  // claude_code"), whatever the delta said. The section gate above drops a
  // source_summary the caller sent and cannot edit — and then the merge wrote
  // one anyway, so a teammate the share withholds the section from overwrote it
  // on every extraction. For a caller who may not edit it, the merge is handed
  // no source, and mergeContextObject keeps the stored value.
  const extractionSourceSummary = isProjectOwner(actor, project)
    || canEditSectionForActor(actor, project, sharePolicy, 'source_summary')
    ? (sanitizedExtraction.project_candidate?.reason || `Updated from ${input.tool}`)
    : '';
  // A NEW task is not a completed one — the rule updateProjectContext applies to
  // an explicit task, applied here to one extraction set. Without it a task that
  // lands after finish_task inherits task_progress:'completed' and the brief and
  // catch-up describe fresh work as done. After the section gate on purpose: it
  // is a consequence of the task write, not a field a teammate asked to edit.
  if (sanitizedExtraction.delta?.current_task
    && project.context?.task_progress === 'completed'
    && !('task_progress' in sanitizedExtraction.delta)) {
    sanitizedExtraction = {
      ...sanitizedExtraction,
      delta: { ...sanitizedExtraction.delta, task_progress: '' },
    };
  }
  // Same rule for next_action: it is the cursor INSIDE the task, so a new task
  // that does not bring its own leaves none rather than the old task's.
  if (sanitizedExtraction.delta?.current_task
    && String(project.context?.next_action || '').trim()
    && !('next_action' in sanitizedExtraction.delta)) {
    sanitizedExtraction = {
      ...sanitizedExtraction,
      delta: { ...sanitizedExtraction.delta, next_action: '' },
    };
  }
  // And for the status, when all it says is that the OLD task was completed.
  if (sanitizedExtraction.delta && clearsCompletionStatus(project.context, sanitizedExtraction.delta)) {
    sanitizedExtraction = {
      ...sanitizedExtraction,
      delta: { ...sanitizedExtraction.delta, current_status: '' },
    };
  }
  const resolvedRoutingState = sanitizedExtraction.routing_state || (
    sanitizedExtraction.needs_user_confirmation || sanitizedExtraction.match_decision === 'ambiguous'
      ? (session.project_id && session.project_id !== project.project_id ? 'stale_match' : 'ambiguous')
      : project.project_id ? 'matched' : 'global_only'
  );
  const resolvedSessionStatus = sanitizedExtraction.needs_user_confirmation || sanitizedExtraction.match_decision === 'ambiguous'
    ? 'ambiguous'
    : 'active';
  const lastConfirmedAt = resolvedRoutingState === 'matched' ? isoNow() : session.last_confirmed_at || null;

  // A held binding (above) stays put, routing state and all: this write went to
  // another project for this call only, and the session still describes where
  // the connection works.
  if (heldBinding && heldBinding !== project.project_id) {
    // nothing to move
  } else if (session.project_id !== project.project_id) {
    await upsertSession(actor, input.session_id, {
      tool: session.tool,
      surface_type: session.surface_type,
      conversation_ref: session.conversation_ref,
      cwd: session.cwd,
      host: session.host,
      tab_id: session.tab_id,
      status: resolvedSessionStatus,
      routing_state: resolvedRoutingState,
      match_confidence: sanitizedExtraction.confidence || 0,
      last_confirmed_at: lastConfirmedAt,
      project_id: project.project_id,
    });
  } else if (
    session.status !== resolvedSessionStatus
    || session.routing_state !== resolvedRoutingState
    || Number(session.match_confidence || 0) !== Number(sanitizedExtraction.confidence || 0)
  ) {
    await upsertSession(actor, input.session_id, {
      tool: session.tool,
      surface_type: session.surface_type,
      conversation_ref: session.conversation_ref,
      cwd: session.cwd,
      host: session.host,
      tab_id: session.tab_id,
      status: resolvedSessionStatus,
      routing_state: resolvedRoutingState,
      match_confidence: sanitizedExtraction.confidence || 0,
      last_confirmed_at: lastConfirmedAt,
      project_id: project.project_id,
    });
  }

  // Decided ONCE, against every other project's claims, and reused by the
  // concurrency retries below — see claimablePaths.
  const pathsToLink = await claimablePaths(
    project.owner_key || getActorKey(actor),
    project,
    [session.cwd, input.session_context?.cwd],
    input.session_context?.workspace_key || null,
    { createdHere: createdByThisCapture && Boolean(project) },
  );
  const nextLinkedPaths = uniqueStrings([
    ...(project.linked_paths || []),
    ...pathsToLink,
  ]);
  const nextLinkedConversations = uniqueStrings([
    ...(project.linked_conversations || []),
    session.conversation_ref,
    input.session_context?.conversation_ref,
  ]);
  const projectBindingsChanged = !sanitizedExtraction.no_material_change && (
    contextChanged(project.linked_paths || [], nextLinkedPaths)
    || contextChanged(project.linked_conversations || [], nextLinkedConversations)
  );
  project.linked_paths = nextLinkedPaths;
  project.linked_conversations = nextLinkedConversations;

  // Tag the workspace (repo identity, client-derived from git remote/root) so this
  // project is grouped with its sibling work-streams. Set once and never
  // overwritten here (saveProject also COALESCEs), so an established project keeps
  // its key even if a later session arrives without one.
  const incomingWorkspaceKey = input.session_context?.workspace_key || null;
  const workspaceKeyChanged = Boolean(incomingWorkspaceKey && !project.workspace_key);
  if (workspaceKeyChanged) project.workspace_key = incomingWorkspaceKey;

  let previousContext = project.context;
  // Stamp the author onto every incoming decision before the merge sees it.
  //
  // This is the point where "what somebody learned" becomes "what SARAH learned"
  // — the one fact that makes a shared brief usable and that the brief has never
  // carried. mergeContextObject keeps the FIRST author for a decision that
  // already exists and records a later, different author as corroboration, so
  // re-ingesting somebody else's work never reassigns it to you.
  const contributor = workspace.actorPersonId(actor);
  const incomingDelta = sanitizedExtraction.delta;
  // The other three attributed lists get the same stamp, because a landmine and
  // a shipped item are the other two things a teammate records and the catch-up
  // reads all three. No author_email pass for them: only a git import carries
  // one, and it only ever carried decisions.
  //
  // The stamp REPLACES whatever the delta claimed. It used to fill a blank and
  // keep an author the entry "arrived with" — but nothing legitimate sends one
  // (a Trail export strips contributed_by), so the only entry that arrived
  // attributed was one the caller attributed, to whoever they liked, and a full
  // list ages each person's own entries first. Stored entries keep their first
  // author through the merge (uniqueEntries), so a re-record never reassigns.
  const stampAuthor = (entries) => (Array.isArray(entries)
    ? entries.map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      const { contributed_by: _claimed, ...rest } = entry;
      return contributor ? { ...rest, contributed_by: contributor } : rest;
    })
    : entries);
  const attributedDelta = incomingDelta && typeof incomingDelta === 'object'
    ? {
      ...incomingDelta,
      ...(Array.isArray(incomingDelta.recent_decisions)
        ? {
          recent_decisions: await resolveDecisionAuthors(
            incomingDelta.recent_decisions,
            // getActorKey, not the `ownerKey` above — that one is block-scoped to
            // an earlier branch and is in its temporal dead zone here.
            getActorKey(actor),
            contributor,
          ),
        }
        : {}),
      ...(Array.isArray(incomingDelta.landmines) ? { landmines: stampAuthor(incomingDelta.landmines) } : {}),
      ...(Array.isArray(incomingDelta.shipped) ? { shipped: stampAuthor(incomingDelta.shipped) } : {}),
      ...(Array.isArray(incomingDelta.debugging_notes) ? { debugging_notes: stampAuthor(incomingDelta.debugging_notes) } : {}),
      ...(Array.isArray(incomingDelta.hot_paths) ? { hot_paths: stampAuthor(incomingDelta.hot_paths) } : {}),
    }
    : incomingDelta;
  let extractionBoardOutcome = {};
  let mergedContext = mergeContextObject(
    project.context,
    attributedDelta,
    extractionSourceSummary,
    // For the one entry this merge AUTHORS rather than copies: a card the delta
    // moves to Done becomes a shipped entry built field by field, so it inherits
    // no author and has to be told who moved it.
    //
    // `outcome` catches board cards the merge refused for the open-card limit. A
    // caller-supplied delta can carry add_todos; this path saves the rest of the
    // delta, so the refused cards travel out in the reply instead of vanishing.
    { contributedBy: contributor, outcome: (extractionBoardOutcome = {}) },
  );
  const mergeChanged = !sanitizedExtraction.no_material_change
    && isMeaningfulDelta(sanitizedExtraction.delta)
    && contextChanged(previousContext, mergedContext);

  const prefs = await getPreferences(actor).catch(() => null);
  const excludedFields = prefs?.security?.excluded_fields || [];
  let contextToSave = mergeChanged ? applyExclusions(mergedContext, excludedFields) : previousContext;

  // Stamp the tool/host that last wrote this context so a later session in a
  // different tool/machine can render a "resuming from …" handoff line.
  const activeTool = input.tool || '';
  const activeHost = session.host || '';
  const toolHostChanged = (contextToSave?.last_active_tool || '') !== activeTool
    || (contextToSave?.last_active_host || '') !== activeHost;
  // Multi-tool dependency: record this tool's presence so the project's toolchain
  // coverage accumulates (the more tools, the more painful to leave). A tool
  // switch already triggers a write via toolHostChanged below.
  const existingPresence = (contextToSave && typeof contextToSave.tool_presence === 'object' && contextToSave.tool_presence) || {};
  // `identified: false` when the caller said its tool is a rendering default
  // rather than the client's identity: the receipt then names no tool for this
  // save (shared-context briefReceiptInputs). Omitted otherwise, as before.
  const presenceEntry = () => ({
    last_seen_at: isoNow(),
    host: activeHost,
    ...(input.tool_identified === false ? { identified: false } : {}),
  });
  const toolPresence = activeTool
    ? { ...existingPresence, [activeTool]: presenceEntry() }
    : existingPresence;
  project.context = { ...contextToSave, last_active_tool: activeTool, last_active_host: activeHost, tool_presence: toolPresence };

  if (mergeChanged || projectBindingsChanged || toolHostChanged || workspaceKeyChanged) {
    const writeOwnerKey = getActorKey(actor);
    // Optimistic concurrency: detect if the project changed under us since we
    // loaded it (another machine/tool wrote concurrently). Rather than blindly
    // overwriting with a merge computed against our now-stale snapshot (which
    // would silently drop the concurrent writer's delta), re-fetch the fresh row
    // and re-run mergeContextObject with the ORIGINAL incoming delta against that
    // fresh base — never re-merging the already-merged result, so array appends
    // (decisions, questions, …) aren't double-applied. Bounded so a persistently
    // hot project can't spin forever; if it's still conflicting after the retry
    // budget, fall back to the previous last-write-wins behavior (with the same
    // warning) rather than looping.
    // The loop now turns on whether the WRITE applied, not on a separate read.
    //
    // It used to read updated_at, compare it, and then save — three statements
    // with a window between the check and the act, so a writer landing in that
    // window was overwritten silently. That is the exact failure the check
    // existed to prevent, and it is a memory product: a lost write presents to
    // the customer as "DeerDawn forgot what I told it", the worst thing it can do.
    //
    // saveProject now compares-and-swaps on the row's updated_at, so the check
    // happens inside the write and cannot be raced.
    const MAX_CONCURRENCY_RETRIES = 3;
    let raceDetected = false;
    let unresolvedConflict = false;
    for (let attempt = 0; ; attempt += 1) {
      // The version this merge was computed against. A counter rather than a
      // timestamp: two writes in the same millisecond used to both satisfy the
      // guard, which is precisely the collision it exists to catch.
      const loadedVersion = project.context_version;
      project.updated_at = isoNow();
      const writeResult = await store.saveProject(project, actor, { expectedVersion: loadedVersion });
      // A store that returns nothing is one that predates the swap (or a stub in
      // a test). Absence of the signal means the old unconditional behaviour —
      // the write happened — rather than an unreported conflict, which would
      // spin this loop against a store that cannot answer it.
      const applied = writeResult ? writeResult.applied !== false : true;
      if (applied) break;

      // The swap lost: somebody wrote between our read and our write.
      raceDetected = true;
      if (attempt >= MAX_CONCURRENCY_RETRIES) { unresolvedConflict = true; break; }

      const freshProject = await store.getProject(writeOwnerKey, project.project_id);
      if (!freshProject) { unresolvedConflict = true; break; } // project vanished under us

      previousContext = freshProject.context;
      if (mergeChanged) {
        mergedContext = mergeContextObject(
          previousContext,
          // attributedDelta, not the raw one: the raw delta has no
          // contributed_by, so a decision written via a successful retry would be
          // stored anonymously — silently stripping authorship on exactly the
          // concurrent path attribution exists for.
          attributedDelta,
          extractionSourceSummary,
          { contributedBy: contributor, outcome: (extractionBoardOutcome = {}) },
        );
        contextToSave = applyExclusions(mergedContext, excludedFields);
      } else {
        contextToSave = previousContext;
      }
      const rebuiltPresence = (contextToSave && typeof contextToSave.tool_presence === 'object' && contextToSave.tool_presence) || {};
      const rebuiltToolPresence = activeTool
        ? { ...rebuiltPresence, [activeTool]: presenceEntry() }
        : rebuiltPresence;
      project = {
        ...freshProject,
        // Recompute against the FRESH row, not the pre-race snapshot. nextLinkedPaths /
        // nextLinkedConversations were derived once from the stale project before the
        // retry loop; writing them back wholesale discarded any path or conversation the
        // concurrent writer had added — the exact "silently drop the other writer's delta"
        // failure this retry loop exists to prevent, just on different fields.
        linked_paths: uniqueStrings([
          ...(freshProject.linked_paths || []),
          ...pathsToLink,
        ]),
        linked_conversations: uniqueStrings([
          ...(freshProject.linked_conversations || []),
          session.conversation_ref,
          input.session_context?.conversation_ref,
        ]),
        workspace_key: project.workspace_key || freshProject.workspace_key,
        context: { ...contextToSave, last_active_tool: activeTool, last_active_host: activeHost, tool_presence: rebuiltToolPresence },
      };
    }
    if (unresolvedConflict) {
      // Out of retry budget, or the row vanished. The write still has to land —
      // refusing it would lose this session's delta outright — but it must not
      // land as a merge computed against a snapshot that is now several writes
      // old, because that silently discards everyone who won the swaps.
      //
      // So: one last read, re-merge the ORIGINAL delta against whatever is
      // current, and write unconditionally. Ordering is conceded; data is not.
      // A fallback that clobbers is what the retry loop existed to prevent, and
      // five concurrent writers against a budget of three reach this path
      // routinely — it is the normal case on a busy team project, not an edge.
      console.warn(`[CONTEXT] Concurrent write on project ${project.project_id} — reconciling once more, then last-write-wins on ordering.`);
      const latest = await store.getProject(writeOwnerKey, project.project_id).catch(() => null);
      if (latest) {
        const rebased = mergeChanged
          ? applyExclusions(
            mergeContextObject(
              latest.context,
              attributedDelta,
              extractionSourceSummary,
              { contributedBy: contributor, outcome: (extractionBoardOutcome = {}) },
            ),
            excludedFields,
          )
          : latest.context;
        const latestPresence = (rebased && typeof rebased.tool_presence === 'object' && rebased.tool_presence) || {};
        project = {
          ...latest,
          linked_paths: uniqueStrings([...(latest.linked_paths || []), ...pathsToLink]),
          linked_conversations: uniqueStrings([
            ...(latest.linked_conversations || []),
            session.conversation_ref,
            input.session_context?.conversation_ref,
          ]),
          workspace_key: project.workspace_key || latest.workspace_key,
          context: {
            ...rebased,
            last_active_tool: activeTool,
            last_active_host: activeHost,
            tool_presence: activeTool
              ? { ...latestPresence, [activeTool]: presenceEntry() }
              : latestPresence,
          },
        };
      }
      project.updated_at = isoNow();
      await store.saveProject(project, actor);
    }
    // Notify other machines/tools (SSE /stream subscribers) to refresh. Extraction
    // writes previously didn't publish, so cross-machine views went stale.
    try {
      const { getPublisher } = require('../config/redis');
      await getPublisher().publish(
        `context:${writeOwnerKey}:${project.project_id}`,
        JSON.stringify({ kind: 'context_updated', project_id: project.project_id, concurrent: raceDetected })
      );
    } catch { /* non-fatal */ }
  }
  if (mergeChanged) {
    const diff = computeContextDiff(previousContext, sanitizedExtraction.delta);
    await recordEvent(
      project,
      input.tool,
      `chunk_${project.events.length}`,
      'context_delta_applied',
      { ...sanitizedExtraction.delta, _diff: diff },
      sanitizedExtraction.confidence,
      workspace.actorPersonId(actor)
    );
    // Write-back loop health: one writeback_recorded per materially-applied
    // delta, from THIS chokepoint so it covers every write path (MCP
    // update_context, Stop-hook transcript flush, dashboard edits) — not just
    // MCP tool calls. Fire-and-forget; never blocks the apply.
    setImmediate(() => {
      const delta = sanitizedExtraction.delta || {};
      const slots = Object.keys(delta).filter((k) => {
        const v = delta[k];
        if (Array.isArray(v)) return v.length > 0;
        if (v && typeof v === 'object') return Object.keys(v).length > 0;
        return Boolean(v);
      });
      productEventsService.recordProductEvent(actor, {
        event_name: 'writeback_recorded',
        source: 'context_sync',
        surface: input.tool || null,
        session_id: input.session_id || undefined,
        metadata: { project_id: project.project_id, slots },
      }).catch((err) => console.warn('[CONTEXT] writeback_recorded event failed:', err.message));
    });
    const autoEntities = buildAutoPromotedMemoryEntities(project, {
      ...sanitizedExtraction,
      tool: input.tool,
      source_tool: input.tool,
    }, isoNow());
    if (autoEntities.length) {
      // serverComposed: the project on these entities is the one the brief was
      // written in, not a caller's word about the entity — it never adopts an
      // existing workspace-level node (see upsertOne's adopt rule).
      await upsertWorkspaceEntities(actor, { entities: autoEntities, relations: [] }, { serverComposed: true }).catch((err) => {
        console.warn('[CONTEXT] workspace auto-promotion failed:', err.message);
      });
    }
  }

  const sessionRecord = await getSession(actor, input.session_id);
  const ownerKey = getActorKey(actor);
  let graph = { nodes: [], edges: [], evidence: [] };
  if (mergeChanged) {
    try {
      // Nodes and their canonical keys are derived from this text, so it is
      // redacted before the derivation, not only at the store (see
      // store.redactForStorage): a key is normalised on the way and can carry a
      // secret past the pattern that would have caught it.
      const land = await graphRebuildLanding(actor, ownerKey, project.project_id);
      graph = await graphService.recordGraphArtifacts({
        ownerKey,
        project: { ...project, context: store.redactForStorage(project.context) },
        session: sessionRecord,
        input: store.redactForStorage(input),
        land,
      });
      if (!land) await settleSoloEraLandings(actor, ownerKey);
    } catch (err) {
      console.warn('[GRAPH] Record failed:', err.message);
    }
    cleanupCompletedGraphNodes(ownerKey, project.project_id, sanitizedExtraction.delta, previousContext, mergedContext)
      .catch((err) => console.warn('[GRAPH] Cleanup failed:', err.message));
  }

  console.log('[CONTEXT] Extraction metrics', JSON.stringify({
    sessionId: input.session_id,
    tool: input.tool,
    noMaterialChange: Boolean(sanitizedExtraction.no_material_change),
    mergeChanged,
    sessionStatus: sessionRecord?.status,
    routingState: sessionRecord?.routing_state,
    graphWritten: graph.nodes.length > 0 || graph.edges.length > 0 || graph.evidence.length > 0,
  }));

  // The caller gets the view it is entitled to read; the write above used the raw row.
  //
  // THE GRAPH TOO. recordGraphArtifacts derives nodes from the WHOLE stored
  // context — every section, not only the one this caller wrote — so handing its
  // result back raw gave a teammate who may edit one section of a shared project
  // every decision, stack entry and description its share withholds, in the
  // reply to their own write. It goes through the same filter every graph READ
  // does (round 19); for an author and a solo account that filter is the identity.
  return {
    project: projectViewForActor(actor, project, sharePolicy),
    session: sessionRecord,
    graph: await graphViewForActor(actor, ownerKey, graph, { scopeProjectId: project.project_id }),
    // WHAT WAS APPLIED, not what was asked for. Callers relay an extraction's
    // delta as the reply ("Task → X"), and the request's delta still carries
    // what the gates above took out: a task an explicit one outranks, a list
    // item already stored, a section this person may not edit. An empty delta
    // when the merge changed nothing, because then nothing was applied.
    applied_extraction: appliedExtractionView(sanitizedExtraction, mergeChanged, extractionBoardOutcome.refused_open),
    // Board cards the merge would not open because the board is at its open-card
    // limit. Present only when something was refused.
    ...(Array.isArray(extractionBoardOutcome.refused_open) && extractionBoardOutcome.refused_open.length
      ? {
        refused_cards: extractionBoardOutcome.refused_open,
        board_open_count: extractionBoardOutcome.open_count,
        board_open_limit: extractionBoardOutcome.open_limit,
      }
      : {}),
  };
}

// The sanitized extraction as a reply may report it: provenance the server
// stamps (current_task_source / _set_at) is bookkeeping, not something the
// caller said, and a reply printing it would read as a change they made.
// `refusedOpen`: the cards the merge would not open because the board is at its
// open-card limit (mergeContext's outcome.refused_open). They are reported beside
// this view as refused_cards, and they must not ALSO appear in it as applied: the
// reply said "refused A" and "added A" in one breath while the store held neither.
function appliedExtractionView(sanitizedExtraction, applied, refusedOpen = []) {
  const delta = applied ? { ...(sanitizedExtraction.delta || {}) } : {};
  delete delta.current_task_source;
  delete delta.current_task_set_at;
  const refused = Array.isArray(refusedOpen) ? refusedOpen : [];
  if (refused.length) {
    const titleKey = (value) => String(value ?? '').trim().toLowerCase();
    const refusedNew = new Set(refused.filter((card) => !card.reopened).map((card) => titleKey(card.title)));
    const refusedReopen = refused.filter((card) => card.reopened).map((card) => titleKey(card.title));
    if (Array.isArray(delta.add_todos)) {
      delta.add_todos = delta.add_todos.filter((entry) => (
        !refusedNew.has(titleKey(entry && typeof entry === 'object' ? entry.title : entry))
      ));
      if (!delta.add_todos.length) delete delta.add_todos;
    }
    // A reopen out of Done that was refused leaves the card exactly as it was —
    // column AND assignee (mergeContext restores the prior card whole) — so the
    // move that asked for it applied nothing. Its `match` is a query, not a
    // title, so a move is dropped when it names a refused reopen by its title or
    // a fragment of it.
    if (Array.isArray(delta.move_todos) && refusedReopen.length) {
      delta.move_todos = delta.move_todos.filter((move) => {
        const query = titleKey(move?.match);
        return !query || !refusedReopen.some((title) => title === query || title.includes(query));
      });
      if (!delta.move_todos.length) delete delta.move_todos;
    }
  }
  return { ...sanitizedExtraction, delta, no_material_change: !applied || Boolean(sanitizedExtraction.no_material_change) };
}

// ── Breadth telemetry for context_delivered ─────────────────────────────────
// The strategic bet is that BREADTH is what makes this worth paying for: the ICP
// tension is "one project genuinely does not need this; four or more concurrent
// projects does". Nothing in the product could test that sentence, because
// context_delivered carried only project_id / tool / approximate_tokens — every
// delivered brief looked alike no matter how wide the workspace behind it was.
//
// BOTH context_delivered emitters build their metadata through here. That is the
// point of the helper: a breadth field carried by only one of them would be worse
// than no field at all, because the briefs you could measure would be a biased
// subset of the briefs that happened (the no-project path is exactly where the
// low-breadth accounts live).
//
// WHY THE COUNT IS TAKEN HERE and not from data already in hand:
//   * NOT from the cross-project `related` block. That is raced against a 2s
//     timeout and it reads + decrypts every project, so the timeout is likeliest
//     to fire on precisely the big workspaces this metric exists to count. A
//     count sourced from it would go missing in correlation with the thing being
//     measured, which is how you get a confidently wrong answer.
//   * NOT in the request's Promise.all fan-out. Analytics must not buy latency on
//     /active. Every caller runs this inside the post-suppression fire-and-forget
//     block, after the brief has been handed back.
// It is a COUNT on (owner_key, ...) — the leading column of
// idx_context_projects_owner_updated — so it is an index scan, not an owner-wide
// table scan.
//
// "Concurrent projects" deliberately means top-level and non-archived, matching
// countTopLevelProjects and the plan cap: subprojects are workstreams of one
// workspace rather than separate projects, and an archived project is not
// concurrent with anything.
//
// null, never 0, when the read fails. 0 is a real and meaningful value here (a
// brief delivered to an account with no projects), so letting a failed count
// collapse into it would manufacture exactly the single-project users this
// metric exists to distinguish.
async function briefBreadthMetadata(ownerKey, relatedProjectIds) {
  const workspaceProjectCount = await store.countTopLevelProjects(ownerKey).catch(() => null);
  return {
    workspace_project_count: Number.isFinite(workspaceProjectCount) ? workspaceProjectCount : null,
    related_project_count: new Set(relatedProjectIds || []).size,
  };
}

async function renderInjection(actor, projectId, tool, verbosity, sessionId = null, options = {}) {
  const profile = getToolProfile(tool);
  if (!profile) return null;

  // How the caller resolved this project to the cwd: 'path' is a real match,
  // 'name'/'recency_fallback' are guesses we must flag as low-confidence.
  const matchKind = options.matchKind || null;

  const ownerKey = getActorKey(actor);
  const startMs = Date.now();
  const phaseMs = {
    preferences: 0,
    graph: 0,
    relatedProjects: 0,
  };

  if (projectId) {
    // Fan out all independent fetches in parallel. getPreferences/getGlobal/
    // getProject/getProjectGraph share no dependencies — each only needs
    // actor/ownerKey/projectId which are already resolved. For the common
    // no-session path (/active) this collapses 4 sequential round-trip groups
    // into 1, saving ~2s on a remote DB. For the session path we also start the
    // graph fetch optimistically since degradedRouting (the only early-exit that
    // would waste it) is uncommon and the graph result is non-fatal to discard.
    // Stage 1 (3 connections max): fetch preferences, global context, and the
    // project simultaneously. These are independent and each holds exactly one
    // pool connection, staying within the warm pool (DB_POOL_MIN=4).
    const phase1Start = Date.now();
    const [preferences, global, project, session, ownerEntitlements] = await Promise.all([
      getPreferences(actor),
      loadPersonalGlobal(actor, ownerKey),
      getProjectForInjection(actor, projectId),
      sessionId ? getSession(actor, sessionId) : Promise.resolve(null),
      // Joins the existing fan-out so the plan's memory window costs no extra
      // latency on /active. Fail-open: null entitlements = no window applied.
      getOwnerEntitlements(actor),
    ]);
    phaseMs.preferences = Date.now() - phase1Start;

    const toolPrefs = preferences.tools?.[tool];
    if (preferences.paused || toolPrefs?.enabled === false) return null;
    const resolvedVerbosity = verbosity || toolPrefs?.verbosity || 'light';

    if (!project) return null;
    // Apply the plan's memory window to the brief (free: 7 days; paid: no-op).
    // Everything downstream — formatters, brief_spine, graph lines — reads the
    // windowed context, so nothing older than the window can leak into the brief.
    const historyWindow = applyHistoryWindow(project.context, ownerEntitlements?.limits?.history_days);
    if (historyWindow.agedOut > 0) project.context = historyWindow.context;
    const degradedRouting = session?.status === 'ambiguous'
      || session?.routing_state === 'ambiguous'
      || session?.routing_state === 'stale_match'
      || session?.routing_state === 'global_only';
    if (degradedRouting) {
      const fallbackPayload = buildConservativeFallback(global, resolvedVerbosity, profile.surface);
      return {
        ...fallbackPayload,
        tool,
        degraded_state: 'degraded',
        degraded_reason: session?.routing_state === 'stale_match' ? 'stale_match' : 'ambiguous_session',
        provenance: [{ kind: 'session', label: 'Ambiguous session fallback', confidence: 1 }],
      };
    }
    // Stage 2: graph fetch (internally fans out up to 4 connections). Stage 1
    // connections are already released so this uses the same warm pool slots.
    // Race against a 3s timeout so a slow graph never blocks /active with a 503.
    const graphStart = Date.now();
    let graphDegraded = false;
    // A slow or failing graph must never block /active. Race against a 3s
    // timeout, and .catch the loser so a rejected query can't become an
    // unhandled rejection or surface as a 503 — it just yields an empty graph.
    // Filtered on the way out for the same reason the graph ENDPOINTS now are:
    // both of these fan out past the active project through listRecentGraphFacts,
    // so an unfiltered brief quietly carried related nodes from projects the
    // reader cannot open. Inside the existing catch, so a filter failure degrades
    // to an empty graph rather than a 503 — the same contract the fetch has.
    const graphFetch = (session
      ? graphService.getSessionGraph(ownerKey, sessionForGraphReader(actor, session))
      : graphService.getProjectGraph(ownerKey, projectId)
    ).then((graph) => filterGraphForActor(actor, ownerKey, graph, { scopeProjectId: graph?.project_id || projectId || null }))
      .catch(() => { graphDegraded = true; return { nodes: [], edges: [] }; });
    // The cross-project block rides alongside the graph fetch rather than after
    // it. It reads and decrypts every project, which is real work to put on the
    // product's most important call — so it gets the same discipline the graph
    // has: started in parallel, raced against its own timeout, and failing to an
    // absent line rather than a slow brief. A brief that arrives without the
    // related section is a smaller loss than a brief that arrives late.
    const relatedFetch = crossProjectService
      .getRelatedFromOtherProjects(actor, { projectId })
      .catch(() => null);
    const RELATED_TIMEOUT = Symbol('related_timeout');
    const relatedRace = Promise.race([
      relatedFetch,
      new Promise(resolve => setTimeout(() => resolve(RELATED_TIMEOUT), 2000)),
    ]);

    const TIMEOUT = Symbol('graph_timeout');
    const graphTimeout = new Promise(resolve => setTimeout(() => resolve(TIMEOUT), 3000));
    const raced = await Promise.race([graphFetch, graphTimeout]);
    const resolvedGraph = raced === TIMEOUT ? { nodes: [], edges: [] } : raced;
    if (raced === TIMEOUT) graphDegraded = true;
    phaseMs.graph = Date.now() - graphStart;

    // Brief shape is OPT-IN (?shape=spine / ?format=brief). The DEFAULT on-the-wire
    // injection text is intentionally unchanged — only the explicit opt-in renders
    // the 4-slot brief body. The structured brief_spine stays attached either way.
    const relatedStarted = Date.now();
    const relatedRaced = await relatedRace;
    const related = relatedRaced === RELATED_TIMEOUT ? null : relatedRaced;
    phaseMs.cross_project = Date.now() - relatedStarted;

    const briefShape = options.shape === 'spine' || options.format === 'brief';
    const basePayload = briefShape
      ? formatBriefInjection(project.context, resolvedVerbosity, global, {
        now: options.now,
        tz: options.tz,
      })
      : profile.surface === 'browser'
        ? formatConversationalInjection(project.context, resolvedVerbosity, global, {
          now: options.now,
          tz: options.tz,
          related,
        })
        : formatCodeInjection(project.context, resolvedVerbosity, global, {
          cwd: session?.cwd || '',
          now: options.now,
          tz: options.tz,
          related,
        });

    // Related projects by shared entity (see relatedProjectsBySharedEntity),
    // added to what the graph read found. Best-effort, like the graph: a failure
    // leaves the line as the graph had it.
    if (!graphDegraded && projectId) {
      const byEntity = await relatedProjectsBySharedEntity(actor, ownerKey, projectId).catch(() => []);
      if (byEntity.length) {
        const existing = Array.isArray(resolvedGraph.related_project_ids) ? resolvedGraph.related_project_ids : [];
        resolvedGraph.related_project_ids = [...new Set([...existing, ...byEntity])].filter((id) => id !== projectId);
      }
    }
    const rawGraphLines = graphService.buildGraphLines(resolvedGraph, tool, resolvedVerbosity);

    // Enrich "Related projects:" line — replace bare IDs with names
    let graphLines = rawGraphLines;
    if (rawGraphLines.some((l) => l.startsWith('Related projects:'))) {
      const relatedStart = Date.now();
      try {
        const ids = new Set();
        for (const line of rawGraphLines) {
          if (!line.startsWith('Related projects:')) continue;
          for (const token of line.replace('Related projects: ', '').split(' | ')) {
            const trimmed = token.trim();
            if (!trimmed) continue;
            const parenMatch = trimmed.match(/\(([^)]+)\)$/);
            ids.add((parenMatch?.[1] || trimmed).trim());
          }
        }
        const projectNames = await store.listProjectNames(ownerKey, Array.from(ids));
        const nameMap = new Map((projectNames || []).map((p) => [p.project_id, p.project_name]));
        graphLines = rawGraphLines.map((line) => {
          if (!line.startsWith('Related projects:')) return line;
          const ids = line.replace('Related projects: ', '').split(' | ');
          const named = ids.map((id) => {
            const name = nameMap.get(id.trim());
            return name ? `${name} (${id.trim()})` : id.trim();
          });
          return `Related projects: ${named.join(' | ')}`;
        });
      } catch { /* non-fatal */ }
      phaseMs.relatedProjects = Date.now() - relatedStart;
    }

    const recencyLine = project.updated_at
      ? `Context updated: ${timeAgo(project.updated_at)} via ${tool}`
      : null;
    // Trust banner: surface staleness / degraded sync / low-confidence match
    // in-band so a stale or guessed brief never reads as fresh truth.
    const warnings = [];
    const staleness = classifyStaleness(project.updated_at);
    if (staleness.tier === 'hard') {
      // Enforcement, not just a note: tell the agent the volatile fields cannot
      // be trusted, and flag requires_refresh on the payload below.
      warnings.push(`context is STALE — last verified ${timeAgo(project.updated_at)}. Treat current task, next action, and blocking issue as UNVERIFIED: confirm with the user or run update_context before acting on them`);
    } else if (staleness.tier === 'soft') {
      warnings.push(`context may be stale — last verified ${timeAgo(project.updated_at)}; re-verify volatile fields before relying on them`);
    }
    if (graphDegraded) warnings.push('sync degraded — enrichment skipped');
    // 'pinned' is an explicit user switch (switch_subproject) — a high-confidence
    // choice, not a directory guess — so it must NOT get the low-confidence note.
    if (matchKind === 'shared_fallback') {
      // Two different people reach this kind, and the line has to be true for
      // the one reading it. Somebody with no project anywhere is told exactly
      // that. Somebody whose own projects are in ANOTHER workspace (they joined
      // a team and this connection now works in it) was told the same thing,
      // which was false, and was not told their saves here need a project_id:
      // for them this project is read-only (resolveActiveProject tier 6). The
      // other workspace is never named, nor anything in it. Asked here rather
      // than carried in, because the hosted start_session hands this function
      // the match kind and nothing else; the kind only occurs on that rare path.
      const elsewhere = await checkOwnWorkElsewhere(actor, ownerKey).catch(() => null);
      if (elsewhere === true) {
        // Names the workspace and the way to save to their own projects, and
        // does not suggest creating one here: an assistant acts on this line
        // (see ownWorkElsewhereRefusal for what that led to).
        warnings.push(`this is the most recently active shared project in ${await workspaceLabel(ownerKey)}, the workspace this connection is working in; `
          + 'your own projects are in another workspace you belong to, so it is here to read: to save to your own, '
          + 'switch workspace in the dashboard\'s workspace switcher, and to save here, pass project_id');
      } else if (elsewhere === false) {
        // Said plainly, because it is true and useful: this person has no project
        // of their own yet, and this is what the team most recently worked on.
        warnings.push('you have no project of your own yet — this is the workspace\'s most recently active shared project; pass project_id to open a different one');
      } else {
        warnings.push('this is the workspace\'s most recently active shared project; pass project_id to open a different one');
      }
    } else if (matchKind === 'ancestor_path') {
      // A parent folder of this directory is linked to the project, but this
      // directory is another or unknown repository: shown to read, never written to.
      warnings.push(folderRule.ANCESTOR_WARNING);
    } else if (matchKind && matchKind !== 'path' && matchKind !== 'pinned') {
      warnings.push('directory not linked to this project — match is a guess');
    }
    const statusLine = warnings.length ? `⚠ ${warnings.join('; ')}.` : null;
    // Cross-tool/machine handoff: if a different tool last wrote this context,
    // tell the current tool where to pick up. Surfaced first for visibility.
    const lastTool = project.context?.last_active_tool;
    const lastHost = project.context?.last_active_host;
    const nextAction = project.context?.next_action;
    // Cross-tool resume carries the exact cursor (next_action) between tools, so
    // switching from Cursor to Codex picks up mid-task instead of re-deriving it.
    // Said ONCE. Both brief shapes now render "Next action: X" and every surface
    // prints the receipt ("… Next: X") above the brief, so repeating the step
    // here put the same sentence in front of the model three times. The tail
    // stays only when the body did not render the step (budget-dropped).
    const nextRendered = (basePayload._meta?.chosenSections || []).includes('next_action');
    const handoffTail = nextAction && !nextRendered
      ? ` — next: ${clipText(nextAction, 100)}`
      : nextAction ? '.' : ' — continue where that session left off.';
    const handoffLine = (lastTool && lastTool !== tool)
      ? `Resuming from ${lastTool}${lastHost ? ` on ${lastHost}` : ''}${handoffTail}`
      : null;
    // Multi-tool dependency: surface the toolchain this project is synced across.
    const presenceTools = Object.keys(project.context?.tool_presence || {}).filter(Boolean);
    const presenceLine = presenceTools.length > 1
      ? `Synced across ${presenceTools.length} tools: ${presenceTools.join(', ')}.`
      : null;
    // Team/shared-workspace: for a shared project, show the context is collectively
    // built. Only queried when shared, so private projects pay nothing on this path.
    //
    // The fact, and nothing after it. This line went on "; leaving DeerDawn
    // loses the team's accumulated brief." — a retention pitch, inside the text
    // an assistant reads at session start, addressed to nobody who can act on
    // it (journey r4, the owner's decision: out of every brief). Whatever reads
    // this body — the hosted start_session, the local /active, the dashboard's
    // "What your AI reads" preview — reads it from here.
    let teamLine = null;
    if (project.visibility === 'shared') {
      const contributors = await store.listProjectContributors(ownerKey, projectId).catch(() => []);
      if (contributors.length > 1) {
        teamLine = `Shared workspace — ${contributors.length} teammates have contributed this context.`;
      }
    }
    // State plainly what the brief left out, at the moment it's felt, so the
    // agent knows it is working from partial history rather than silently
    // assuming it has everything. That disclosure is the load-bearing part and
    // it stays.
    //
    // What is gone is the pitch that used to follow it — "Pro remembers
    // everything (deerdawn.com/pricing)". A brief is a tool response injected
    // into someone's assistant, not an ad slot, and a plan upsell with a pricing
    // URL inside one is an advertisement for a subscription in a place the user
    // did not ask for it. Directory policy prohibits exactly that, and a
    // reviewer on a free tenant hit it on the very first call. The upgrade
    // surface belongs in the dashboard, which already carries it.
    const agedOutLine = formatAgedOutLine(historyWindow);
    const body = [
      ...(statusLine ? [statusLine] : []),
      ...(handoffLine ? [handoffLine] : []),
      ...(presenceLine ? [presenceLine] : []),
      ...(teamLine ? [teamLine] : []),
      basePayload.body,
      ...(agedOutLine ? [agedOutLine] : []),
      ...(graphLines.length > 0 ? graphLines : []),
      ...(recencyLine ? [recencyLine] : []),
    ].join('\n');
    // The "Now:" line changes every minute; exclude it from the suppression
    // fingerprint so a fresh clock alone never defeats dedup and re-spams context.
    const fingerprintBody = body.split('\n').filter((line) => !/^Now:/.test(line.trim())).join('\n');
    const fingerprint = makeInjectionFingerprint(tool, fingerprintBody);
    const sectionSignature = makeSectionFingerprintSignature(fingerprintBody);
    if (sessionId) {
      const historyKey = makeInjectionHistoryKey(ownerKey, sessionId, tool);
      const previous = injectionHistory.get(historyKey);
      if (previous?.fingerprint === fingerprint || previous?.sectionSignature === sectionSignature) {
        console.log('[CONTEXT] Injection metrics', JSON.stringify({
          projectId,
          tool,
          sessionId,
          verbosity: resolvedVerbosity,
          approximateTokens: approximateTokens(body),
          lineCount: body.split('\n').length,
          suppressed: true,
          chosenSections: basePayload._meta?.chosenSections || [],
          droppedSections: basePayload._meta?.droppedSections || [],
        }));
        return null;
      }
      injectionHistory.set(historyKey, {
        fingerprint,
        sectionSignature,
        approximateTokens: approximateTokens(body),
        ts: Date.now(),
      });
    }

    console.log('[CONTEXT] Injection metrics', JSON.stringify({
      projectId,
      tool,
      sessionId,
      verbosity: resolvedVerbosity,
      approximateTokens: approximateTokens(body),
      lineCount: body.split('\n').length,
      suppressed: false,
      timing: {
        total_ms: Date.now() - startMs,
        fetch_ms: phaseMs.preferences,
        graph_ms: phaseMs.graph,
        graph_degraded: graphDegraded,
        related_projects_ms: phaseMs.relatedProjects,
      },
      chosenSections: basePayload._meta?.chosenSections || [],
      droppedSections: basePayload._meta?.droppedSections || [],
    }));

    // Compounding intelligence: reinforce the graph nodes we actually surfaced
    // this session so ranking learns from real retrieval (hits → promotion →
    // better future ranking). This is what makes the graph personalize and
    // compound over time — and become impractical to recreate elsewhere. Placed
    // after the suppression check so only delivered injections count, and
    // fire-and-forget so it never adds latency to /active or breaks injection.
    if (options.record_side_effects !== false && resolvedGraph.nodes?.length) {
      setImmediate(() => {
        trackWorkspaceSelections(actor, resolvedGraph.nodes, { source_tool: tool, selected_at: isoNow() })
          .catch((err) => console.warn('[CONTEXT] retrieval reinforcement failed:', err.message));
      });
    }

    // Strengthen cross-project affinity from the projects this session co-occurred
    // with. Fire-and-forget, post-suppression (so only delivered injections count),
    // reusing the already-computed related_project_ids — no extra read, no latency.
    if (options.record_side_effects !== false && resolvedGraph.related_project_ids?.length) {
      setImmediate(() => {
        recordProjectAffinities(actor, project.project_id, resolvedGraph.related_project_ids)
          .catch((err) => console.warn('[CONTEXT] project affinity strengthening failed:', err.message));
      });
    }

    // Activation/engagement signal: a non-suppressed injection means context was
    // actually delivered into a tool this session — the true "reached value" event
    // (vs. merely starting a session). Powers time-to-first-value and the weekly
    // digest's per-tool injection counts. Fire-and-forget; never blocks /active.
    if (options.record_side_effects !== false) {
      setImmediate(() => {
        // `scope` is new on THIS emitter. The global-only emitter below has always
        // set scope:'global', so until now "project brief" was encoded as the
        // ABSENCE of a property — unreadable in a breakdown and indistinguishable
        // from an emitter that forgot to set it. Historical rows still need
        // `scope = 'global' OR scope IS NULL` to be read correctly.
        //
        // related_project_ids is reused, not recomputed: it is the same array
        // recordProjectAffinities consumed a few lines above.
        briefBreadthMetadata(ownerKey, resolvedGraph.related_project_ids)
          .then((breadth) => productEventsService.recordProductEvent(actor, {
            event_name: 'context_delivered',
            source: 'context_sync',
            surface: tool,
            session_id: sessionId || undefined,
            metadata: {
              project_id: projectId,
              tool,
              scope: 'project',
              approximate_tokens: approximateTokens(body),
              ...breadth,
            },
          }))
          .catch((err) => console.warn('[CONTEXT] context_delivered event failed:', err.message));
        // First delivery = the user's "first sync": emit first_sync_completed once
        // and mirror it to Reddit's CAPI as the activation conversion. Lazily
        // required (fire-and-forget) to avoid coupling this module's load order.
        require('./sessionCatchupService')
          .maybeEmitFirstSyncActivation(actor, { tool, projectId })
          .catch((err) => console.warn('[CONTEXT] first_sync_completed check failed:', err.message));
        // Once-per-user marker that this account ever got a tool talking to us at
        // all. Necessary for activation but not sufficient — see the no-project
        // path below, where it is the ONLY thing a first session emits.
        require('./sessionCatchupService')
          .maybeEmitConnectionEstablished(actor, { tool })
          .catch((err) => console.warn('[CONTEXT] connection_established check failed:', err.message));
        // Same moment, different question: this account reached us, and does
        // that now make TWO people in this workspace inside a week. Sits beside
        // connection_established rather than inside it because it is a fact
        // about the workspace, not about the caller.
        require('./sessionCatchupService')
          .maybeEmitTeamActivated(actor, { tool })
          .catch((err) => console.warn('[CONTEXT] team_activated check failed:', err.message));
      });
    }

    return {
      ...basePayload,
      tool,
      body,
      // The one data line a loaded brief starts with (shared-context
      // formatBriefReceipt), kept OUT of `body`: the body is fingerprinted for
      // dedup and written to disk as .deerdawn-context.md, and a line carrying
      // "3 minutes ago" would change on every read. Each surface puts it first.
      // Counted from the same windowed context the body was rendered from.
      receipt: formatBriefReceipt(briefReceiptInputs(project, { now: options.now })),
      provenance: resolvedGraph.provenance,
      // Structured 4-slot brief (Phase A) — additive, alongside the unchanged text
      // `body`. Each item carries its derived trust band (buildBriefSpine wires
      // deriveItemTrust per item). Consumers (dashboard, MCP) read this; the
      // on-the-wire injection TEXT is intentionally unchanged.
      brief_spine: buildBriefSpine(project.context, global, {
        now: options.now,
        tz: options.tz,
      }),
      // Surfaces (MCP start_session, dashboard) act on these to force a refresh
      // instead of trusting old context. Kept structured so it's not just prose.
      stale: staleness.tier === 'soft' || staleness.tier === 'hard',
      stale_tier: staleness.tier,
      // Structured mirror of the aged-out line so surfaces (dashboard, MCP) can
      // render their own upgrade prompt without parsing brief text. null on
      // paid tiers and whenever nothing aged out.
      history_window: historyWindow.agedOut > 0
        ? { aged_out: historyWindow.agedOut, days: historyWindow.days }
        : null,
      stale_age_ms: staleness.ageMs,
      requires_refresh: staleness.tier === 'hard',
    };
  }

  // No project — inject global context only (sequential fetch fine for this rare path).
  const preferences = await getPreferences(actor);
  const toolPrefs = preferences.tools?.[tool];
  if (preferences.paused || toolPrefs?.enabled === false) return null;
  const resolvedVerbosity = verbosity || toolPrefs?.verbosity || 'light';
  const global = await loadPersonalGlobal(actor, ownerKey);

  const payload = global
    ? formatGlobalOnlyInjection(global, resolvedVerbosity)
    : { format: 'conversational', verbosity: resolvedVerbosity, body: 'No context set yet.' };

  console.log('[CONTEXT] Injection metrics', JSON.stringify({
    projectId: null,
    tool,
    sessionId,
    verbosity: resolvedVerbosity,
    approximateTokens: approximateTokens(payload.body),
    lineCount: payload.body.split('\n').length,
    suppressed: false,
  }));

  // A brand-new account lands here with no project AND no global context, so every
  // other signal in this function stays silent — no session_started (buildSessionCatchup
  // returns early without a project), no context_delivered (the `if (global)` below is
  // false for the "No context set yet." fallback). Without this the connection is
  // invisible server-side and the user cannot appear in the funnel until they return.
  // Deliberately outside the `if (global)` guard, and deliberately NOT activation.
  if (options.record_side_effects !== false) {
    setImmediate(() => {
      require('./sessionCatchupService')
        .maybeEmitConnectionEstablished(actor, { tool })
        .catch((err) => console.warn('[CONTEXT] connection_established check failed:', err.message));
      // The no-project path counts too: a teammate whose first session finds an
      // empty workspace still called us, and a team where both people are new
      // would otherwise never register.
      require('./sessionCatchupService')
        .maybeEmitTeamActivated(actor, { tool })
        .catch((err) => console.warn('[CONTEXT] team_activated check failed:', err.message));
    });
  }

  // Global-only delivery still counts as context reaching a tool (only when there's
  // real global context, not the empty "No context set yet" fallback). A render
  // that is not a delivery (record_side_effects:false) records it on neither
  // branch: this one used to ignore the flag the project branch honours.
  if (global && options.record_side_effects !== false) {
    setImmediate(() => {
      // Same breadth block as the project path — see briefBreadthMetadata. This
      // emitter matters MORE to the breadth question than it looks: a delivery
      // that resolved no project is where the low-breadth accounts show up, so
      // omitting the fields here would have biased the sample toward users who
      // already have a working project.
      //
      // related_project_count is a true 0, not an unknown: no project brief was
      // rendered, so no related project was surfaced into it.
      briefBreadthMetadata(ownerKey, [])
        .then((breadth) => productEventsService.recordProductEvent(actor, {
          event_name: 'context_delivered',
          source: 'context_sync',
          surface: tool,
          session_id: sessionId || undefined,
          metadata: {
            project_id: null,
            tool,
            scope: 'global',
            approximate_tokens: approximateTokens(payload.body),
            ...breadth,
          },
        }))
        .catch((err) => console.warn('[CONTEXT] context_delivered event failed:', err.message));
      // Global-only delivery still counts as the first sync (context reached a
      // tool) — emit first_sync_completed once + mirror the Reddit activation.
      require('./sessionCatchupService')
        .maybeEmitFirstSyncActivation(actor, { tool, projectId: null })
        .catch((err) => console.warn('[CONTEXT] first_sync_completed check failed:', err.message));
    });
  }

  return { ...payload, tool };
}

// THE "YOU" PROFILE IS A PERSON'S, NOT THE WORKSPACE'S.
//
// It was stored and read per workspace, so the day a solo founder invited a
// colleague, the colleague's every brief, start_session, recall, inject and
// GET /context/global opened with the founder's profile — the most personal
// thing DeerDawn holds. It is keyed by (workspace, person) now: each person
// reads and writes their own, and the pre-person workspace row belongs to the
// founder (store.getGlobal).
//
// Who a PERSON-LESS actor stands for — an internal job built as { id: ownerKey },
// a key minted before keys carried their owner. In a workspace that has only
// ever held one person there is exactly one profile it could mean, and that is
// what it always read. Anywhere else it is nobody: guessing would put one
// person's profile in front of another, the failure this exists to prevent.
//
// The platform system key (type 'system') is its own identity: it keeps the
// profile it always had, under its own id, which no person's row can carry.
async function globalPersonFor(actor, ownerKey) {
  const person = workspace.actorPersonId(actor);
  if (person) return person;
  if (actor?.type === 'system' && actor.id) return `system:${actor.id}`;
  try {
    if (await workspace.hasEverHeldTwoMembers(ownerKey)) return null;
    if (await workspace.isSharedWorkspace(ownerKey)) return null;
    return await store.globalFounderId(ownerKey);
  } catch {
    return null;
  }
}

// The stored profile for this actor's person in `ownerKey`, or null.
async function loadPersonalGlobal(actor, ownerKey) {
  const person = await globalPersonFor(actor, ownerKey);
  if (!person) return null;
  return store.getGlobal(ownerKey, person);
}

async function getGlobalContext(actor) {
  const stored = await loadPersonalGlobal(actor, getActorKey(actor));
  if (stored) return stored;
  return GlobalContextSchema.parse({});
}

// Does this person's stored profile hold anything they have not yet been asked
// to check? True for a row with content whose profile_reviewed_at is NULL: a
// profile that existed before extraction stopped filling it, and so may hold
// lines lifted from their projects. An explicit save or a dismissal sets it.
// Reads only; a failure answers false rather than nag or break the page.
async function profileNeedsReview(actor) {
  try {
    const ownerKey = getActorKey(actor);
    // getGlobal claims a pre-person row for its founder, so read through it first.
    const stored = await loadPersonalGlobal(actor, ownerKey);
    if (!stored) return false;
    const person = await globalPersonFor(actor, ownerKey);
    const state = await store.getGlobalReviewState(ownerKey, person);
    if (!state || state.reviewed_at) return false;
    return Boolean(state.global && (state.global._enc || Object.entries(state.global).some(([key, value]) => {
      if (key === 'updated_at') return false;
      if (typeof value === 'string') return value.trim() !== '';
      if (Array.isArray(value)) return value.length > 0;
      return value !== null && value !== undefined;
    })));
  } catch (err) {
    console.warn('[CONTEXT] profile review state unavailable:', err.message);
    return false;
  }
}

// The person dismissing the note. Their own row only; no workspace write gate,
// because it changes nothing in the profile and a read-only member would
// otherwise see the note for ever.
async function dismissProfileReview(actor) {
  const ownerKey = getActorKey(actor);
  await loadPersonalGlobal(actor, ownerKey);
  const person = await globalPersonFor(actor, ownerKey);
  if (!person) return false;
  return store.markGlobalReviewed(ownerKey, person);
}

async function updateGlobalContext(actor, input, { auto = false } = {}) {
  const ownerKey = getActorKey(actor);
  // A viewer's dashboard session carries context:write (session scopes come
  // from the org-level users.role), so the route gate alone let a read-only
  // member write here. The workspace role is the gate that decides.
  await assertWorkspaceWritable(actor, ownerKey);
  // Written to the PERSON's own row (see globalPersonFor). An actor that stands
  // for nobody in particular is refused rather than allowed to write a profile
  // somebody else would then read as their own.
  const person = await globalPersonFor(actor, ownerKey);
  if (!person) {
    throw writeForbiddenError(
      'global_profile_unattributed: this credential is not tied to a person in a shared workspace, so there is no "you" profile to update. Use a key or session of your own.'
    );
  }
  const current = (await store.getGlobal(ownerKey, person)) || GlobalContextSchema.parse({});
  const merged = GlobalContextSchema.parse({
    user_profile:              input.user_profile              ?? current.user_profile,
    preferences:               input.preferences               ?? current.preferences,
    recurring_instructions:    input.recurring_instructions    ?? current.recurring_instructions,
    global_stack:              input.global_stack              ?? current.global_stack,
    expertise_areas:           input.expertise_areas           ?? current.expertise_areas,
    goals:                     input.goals                     ?? current.goals,
    working_style:             input.working_style             ?? current.working_style,
    values:                    input.values                    ?? current.values,
    communication_preferences: input.communication_preferences ?? current.communication_preferences,
    updated_at:                new Date().toISOString(),
  });
  await store.saveGlobal(ownerKey, person, merged, { auto });
  return merged;
}

// null means "you cannot see this", and the routes answer not_found for it. See
// the visibility block above filterGraphResultWith for why not_found and not 403.
async function getProjectGraph(actor, projectId) {
  const ownerKey = getActorKey(actor);
  const visible = await visibleProjectIdsForActor(actor, ownerKey);
  if (projectId && visible && !visible.has(projectId)) return null;
  // Still filtered after the project check: getProjectGraph pulls RELATED nodes
  // and edges out of listRecentGraphFacts across the whole owner, so a visible
  // project's graph was a doorway into every other project's.
  return filterGraphForActor(actor, ownerKey, await graphService.getProjectGraph(ownerKey, projectId), { scopeProjectId: projectId });
}

async function getSessionGraph(actor, sessionId) {
  const ownerKey = getActorKey(actor);
  const session = await getSession(actor, sessionId);
  if (!session) return null;
  const visible = await visibleProjectIdsForActor(actor, ownerKey);
  if (session.project_id && visible && !visible.has(session.project_id)) return null;
  // The session row belongs to a PERSON, and on a shared workspace that person is
  // a colleague on their own machine. getProjectPresence already withholds a
  // peer's cwd and host for exactly that reason; the session graph reads both to
  // build its query terms, so it is handed a copy with them cleared rather than
  // trusted not to echo them. Nothing the graph returns is weaker for it — the
  // terms are a ranking signal, and a peer's home directory ranks nothing for the
  // person reading.
  const scoped = sessionForGraphReader(actor, session);
  return filterGraphForActor(actor, ownerKey, await graphService.getSessionGraph(ownerKey, scoped), { scopeProjectId: session.project_id || null });
}

// Somebody else's session, read by somebody who is not them.
function sessionForGraphReader(actor, session) {
  if (!session?.user_id) return session;
  if (workspace.actorIdentities(actor).includes(session.user_id)) return session;
  return { ...session, cwd: '', host: '' };
}

// A PROJECT CARRIED OUT OF ANOTHER WORKSPACE KEEPS ITS OWN GRAPH, AND NOTHING IT
// LINKS TO (journey scan round 3, D-1).
//
// getProjectGraph is a project's graph as its reader sees it, and that includes
// the far end of every edge filed in the project: link a personal project's
// note to the team's workspace entity, or to an entity of a shared project, and
// that entity's title and summary are in the graph. For the ordinary export that
// is right, since the reader reads those in the workspace anyway. In the account-
// deletion email it put the TEAM's text under a heading saying the team's work
// stays with the team and is not attached.
//
// So a carried project keeps the nodes filed in it, and an edge only when both
// its ends are nodes of the projects carried with it: the person's own, erased
// with the account. A link from one of their personal projects to another of
// them stays, and the node at its far end is printed once, under its own
// project. Every other edge is left out and counted (`links_left_out`, present
// only when there is one), so the attachment and the email can say so.
function carriedProjectGraph(graph, projectId, carriedIds) {
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  const home = new Map(nodes.map((node) => [node.node_id, node.project_id || null]));
  // An end the reader's graph does not hold (a node filtered out) has no home
  // here, so its edge is left out with the rest.
  const carried = (nodeId) => carriedIds.has(home.get(nodeId));
  const kept = edges.filter((edge) => carried(edge.from_node_id) && carried(edge.to_node_id));
  return {
    nodes: nodes.filter((node) => node.project_id === projectId),
    edges: kept,
    ...(edges.length > kept.length ? { links_left_out: edges.length - kept.length } : {}),
  };
}

// Full, portable export of everything DeerDawn holds for this owner: global
// profile, preferences, and every project with its context + knowledge graph.
// This is the custody-lock-in pressure valve — "you can always get your data
// out" — and it deliberately does NOT carry the compounding layer (learned
// affinities, rankings, embeddings), which is recomputed, not a stored artifact,
// so the export reassures without weakening the moat.
//
// "EVERY PROJECT" INCLUDES ARCHIVED ONES, AND THE REST OF WHAT A PERSON WROTE.
//
// Account deletion emails this bundle (rendered as Markdown) as "the last copy
// we hold" and then purges the workspace. It used to list live projects only —
// and projects auto-archive after 30 idle days, so that was every older project
// — and it carried no workspace-scoped entities and no skills. Each of those was
// erased at deletion with no copy anywhere. Now: archived projects (marked, with
// their date), the workspace-level graph, and the skills this reader can open,
// switched-off ones included and marked.
//
// Every read goes through the surface a person already reads it by, so the
// bundle holds nothing its reader could not read elsewhere: listProjects for
// projects (visibility + section policy), getProjectGraph for each project's
// graph, the workspace graph through the same filter GET /graph/export uses,
// and listWorkspaceSkills / getWorkspaceSkill for skills (a skill filed in a
// project the reader cannot open does not travel). The plan's history window is
// NOT applied: it hides old entries from a Free brief and deletes nothing, and
// this is the stored data, not a brief.
//
// ALL OR NOTHING. Each read used to .catch() to an empty value, so a failed
// graph read exported a project with no graph, and a failed listing exported no
// projects at all — a well-formed file saying nothing was there, handed over
// just before the purge. A read that fails now fails the export: the download
// errors and can be retried, and the deletion email is not sent (the route
// reports export_emailed:false) instead of attaching a copy that is not one.
//
// `options.projectIds`: THOSE PROJECTS OF THE BOUND WORKSPACE, AND NOTHING ELSE
// OF IT. Account deletion erases a person's `personal` projects inside other
// people's workspaces along with the account, so its email carries them too
// (routes/shared/orgs.js emailContextExport, with the set the purge selects).
// Each is read here like any other project, as this reader, through the same
// listing, graph and skill reads (a skill filed in one of them goes with it),
// and keeps only its OWN graph: see carriedProjectGraph for why the graph read
// alone is not enough here.
// Nothing else of that workspace is read: not its workspace-level graph or its
// workspace-wide skills, which are the team's, and not preferences. The bundle
// then has no preferences or workspace_graph at all, rather than empty ones
// that would read as "you had none". An id this reader cannot see is simply
// absent: the caller counts those.
//
// Two more things the purge takes from such a workspace, with it:
//   `profile: true` — the reader's own "you" profile there, through
//     getGlobalContext, as `global_context`. Only asked for where the caller
//     knows a row of theirs exists, so the read never takes the legacy-claim
//     path in store.getGlobal (which would write).
//   `privateNodeIds` — graph nodes marked private to this reader, as
//     `private_nodes`: each node's OWN type, title and summary, after the graph
//     filter has judged it for this reader, and nothing it links to (a note can
//     point at the team's nodes, which stay with the team). A node marked for
//     anybody else is dropped, whatever the caller passed. The project it sits
//     on is named only if this reader can open that project, and none of that
//     project's text travels. A node already in one of the projects above is
//     left there rather than printed twice.
async function exportContext(actor, { projectIds = null, profile = false, privateNodeIds = [] } = {}) {
  const exportBundle = require('./contextExportBundle');
  const ownerKey = getActorKey(actor);
  const only = Array.isArray(projectIds) ? new Set(projectIds) : null;
  const [globalContext, preferences, listed, ownerGraph, workspaceSkills] = await Promise.all([
    only && !profile ? null : getGlobalContext(actor),
    only ? null : getPreferences(actor),
    listProjects(actor, { includeArchived: true }),
    // Owner-scoped (owner_key leads idx_context_graph_nodes_owner_seen and its
    // edge twin), the read GET /graph/export makes. Only its workspace-level rows
    // are kept, and they are filtered for this reader below.
    only ? null : store.listAllGraphData(ownerKey),
    // Switched-off skills included, marked by their `enabled: false`: see below.
    only ? [] : listWorkspaceSkills(ownerKey, { actor, includeDisabled: true }),
  ]);
  const projects = only ? (listed || []).filter((p) => only.has(p.project_id)) : listed;
  // The projects actually carried: an id this reader could not open is not one.
  const carriedIds = only ? new Set((projects || []).map((p) => p.project_id)) : null;

  // listProjects already returns each project as this reader may see it, so the
  // per-project getProject this used to make re-read the same row — plus every
  // row of the project's event log, unbounded, which nothing here used.
  const perProject = await exportBundle.mapBounded(projects || [], exportBundle.EXPORT_READ_CONCURRENCY, async (p) => {
    const [graph, skills] = await Promise.all([
      getProjectGraph(actor, p.project_id),
      // Workspace-wide skills plus this project's; only this project's are kept.
      listWorkspaceSkills(ownerKey, { project_id: p.project_id, actor, includeDisabled: true }),
    ]);
    return {
      skills: skills.filter((skill) => skill.project_id === p.project_id),
      project: {
        project_id: p.project_id,
        project_name: p.project_name || p.project_id,
        updated_at: p.updated_at || null,
        archived: Boolean(p.archived_at),
        archived_at: p.archived_at || null,
        context: p.context || {},
        // linked_paths are the AUTHOR's own filesystem: /Users/<name>/work/....
        // A shared project travels its context to the workspace, never the
        // machine it is written on — the same line presence draws when it
        // withholds a peer's cwd and host. The bundle is the most complete form
        // this leak can take (one request, no project id, downloaded as a file),
        // so the paths stop with the person who recorded them.
        linked_paths: isProjectOwner(actor, p) ? (p.linked_paths || []) : [],
        graph: carriedIds
          ? carriedProjectGraph(graph, p.project_id, carriedIds)
          : {
            nodes: graph?.nodes || [],
            edges: graph?.edges || [],
          },
      },
    };
  });

  const workspaceGraph = only ? null : await filterGraphDataForActor(actor, ownerKey, exportBundle.workspaceLevelGraph(ownerGraph));

  // The listings carry metadata only; the body is read per skill, through the
  // same gate GET /skills/:id applies. SWITCHED-OFF SKILLS ARE INCLUDED, each
  // carrying `enabled: false` (the Markdown heads it "(switched off)"). They were
  // left out, because the listing every session reads skips them, and so the
  // download that says it holds everything did not, and deletion erased them
  // with no copy anywhere (journey r4).
  const skillRows = [...(workspaceSkills || []), ...perProject.flatMap((entry) => entry.skills)];
  const skills = (await exportBundle.mapBounded(skillRows, exportBundle.EXPORT_READ_CONCURRENCY,
    (row) => getWorkspaceSkill(ownerKey, row.skill_id, { actor }))).filter(Boolean);

  if (only) {
    const inProjects = new Set(perProject.flatMap((entry) => entry.project.graph.nodes.map((node) => node.node_id)));
    const wanted = [...new Set((privateNodeIds || []).filter((id) => id && !inProjects.has(id)))];
    const identities = workspace.actorIdentities(actor);
    const marked = wanted.length
      ? (await store.listGraphNodesByIds(ownerKey, wanted)).filter((node) => identities.includes(String(node.metadata?.private_to || '')))
      : [];
    const privateNodes = marked.length
      ? (await filterGraphDataForActor(actor, ownerKey, { nodes: marked, edges: [], evidence: [] })).nodes || []
      : [];
    // `listed` is every project this reader can open: a name found there is one
    // they may be shown.
    const readable = new Map((listed || []).map((p) => [p.project_id, p.project_name || p.project_id]));
    return {
      exported_at: isoNow(),
      schema_version: 1,
      owner_key: ownerKey,
      ...(profile ? { global_context: globalContext || {} } : {}),
      projects: perProject.map((entry) => entry.project),
      skills,
      private_nodes: privateNodes.map((node) => ({
        node_id: node.node_id,
        node_type: node.node_type,
        title: node.title,
        summary: node.summary || '',
        project_name: (node.project_id && readable.get(node.project_id)) || null,
      })),
    };
  }

  return {
    exported_at: isoNow(),
    schema_version: 1,
    owner_key: ownerKey,
    global_context: globalContext || {},
    preferences: preferences || {},
    projects: perProject.map((entry) => entry.project),
    workspace_graph: {
      nodes: workspaceGraph?.nodes || [],
      edges: workspaceGraph?.edges || [],
    },
    skills,
  };
}

async function getNodeGraph(actor, nodeId) {
  const ownerKey = getActorKey(actor);
  const graph = await graphService.getNodeGraph(ownerKey, nodeId);
  if (!graph) return null;
  const filtered = await filterGraphForActor(actor, ownerKey, graph);
  // The node the caller asked for is gone, so there is nothing to answer with —
  // and an empty graph would confirm the id exists. not_found, as above.
  if (!(filtered.nodes || []).some((node) => node.node_id === nodeId)) return null;
  return filtered;
}

// Cross-project affinity (compounding): strengthen the persisted link between the
// active project and the projects it co-occurs with, so "projects you work
// alongside" becomes learned over time instead of recomputed per call. Designed
// to be called fire-and-forget — callers must never block injection on it.
async function recordProjectAffinities(actor, projectId, relatedProjectIds = []) {
  if (!projectId || !relatedProjectIds.length) return;
  const ownerKey = getActorKey(actor);
  const unique = [...new Set(relatedProjectIds)].filter((id) => id && id !== projectId);
  await Promise.all(unique.map((relatedId) =>
    store.recordProjectAffinity(ownerKey, projectId, relatedId).catch(() => {})));
}

async function getRelatedProjectsByAffinity(actor, projectId, limit = 5) {
  if (!projectId) return [];
  const ownerKey = getActorKey(actor);
  const affinities = await store.listProjectAffinities(ownerKey, projectId, limit).catch(() => []);
  if (!affinities.length) return [];
  const names = await store.listProjectNames(ownerKey, affinities.map((a) => a.project_id)).catch(() => []);
  const nameMap = new Map((names || []).map((p) => [p.project_id, p.project_name]));
  return affinities.map((affinity) => ({
    project_id: affinity.project_id,
    project_name: nameMap.get(affinity.project_id) || affinity.project_id,
    co_occurrence_count: affinity.co_occurrence_count,
  }));
}

// Distinct teammates who have contributed context to a project: shared context
// is visibly collectively built.
async function getProjectContributors(actor, projectId) {
  if (!projectId) return [];
  const ownerKey = getActorKey(actor);
  return store.listProjectContributors(ownerKey, projectId).catch(() => []);
}

// ─── The graph write gate also has to cover the door agents actually use ────
//
// PR #480 gated POST/PATCH/DELETE /graph/nodes. Almost nothing calls those:
// `upsert_workspace_entities` and `mark_resolved` are how a memory node gets
// written, and both land here — the hosted dispatcher calling this function
// directly, the local stdio one calling it over POST /workspace/entities. This
// function resolved nothing but owner_key, which in a shared workspace is the
// same value for every member, so the gate was on the door nobody uses.
//
// Three checks, in the order the rest of the service uses them, memoised per
// call so a batch of twenty entities into one project costs one resolution:
//   1. may you WRITE in this workspace at all → share_write_forbidden for a
//      viewer, whatever scope rode in on the credential. Internal/system actors
//      and a single-member workspace are exempt inside actorMayWriteWorkspace —
//      a solo account's actor usually has no membership row at all;
//   2. may you write the project this entity is FILED under → project_not_found
//      for one you cannot see, share_write_forbidden for one you may only read;
//   3. may you write the EXISTING node the dedup pass matched → node_not_found
//      when it is invisible. This one is not optional: the canonical-key and
//      fuzzy passes below search the whole owner, and upsertGraphNode keeps the
//      existing row's project, so without it a member rewrites a colleague's
//      personal-project node by colliding with its key and never naming it.
// `options.serverWritten`: the entities were composed by the server itself (a
// structured event's node), so their `source` / `event_type` are kept. Every
// other caller's are stripped — see SERVER_ONLY_NODE_METADATA.
async function upsertWorkspaceEntities(actor, rawInput, options = {}) {
  // Redacted BEFORE anything derives from it: a node's canonical key is built
  // from its title and is served with it, and the key's normalisation (lower
  // case, punctuation folded) is enough to carry a secret past the store's own
  // pass (store.redactForStorage) unrecognised.
  //
  // The KEY, though, is derived from the raw entity (secretSafeKey below):
  // derived from the masked title, every title that differed only in its secret
  // would share one key and merge on the unique index.
  const input = {
    ...rawInput,
    entities: Array.isArray(rawInput?.entities)
      ? rawInput.entities.map((raw) => {
        const entity = (!options.serverWritten && raw && typeof raw === 'object' && raw.metadata)
          ? { ...raw, metadata: stripServerOnlyNodeMetadata(raw.metadata) }
          : raw;
        const redacted = store.redactForStorage(entity);
        if (redacted && typeof redacted === 'object') Object.defineProperty(redacted, RAW_WORKSPACE_ENTITY, { value: entity });
        return redacted;
      })
      : rawInput?.entities,
  };
  const ownerKey = getActorKey(actor);
  const now = isoNow();
  const entities = [];
  const relations = [];
  const entityMap = new Map();

  // Cache the promise, not the answer: a rejection re-throws on every await, and
  // each entry is awaited immediately after it is set, so none goes unhandled.
  //
  // Two gates, because the refusal differs by what the caller already knows. A
  // project id the CALLER NAMED is project_not_found when invisible (a 403 would
  // confirm it exists — assertGraphNodeCreatable, the same call POST /graph/nodes
  // makes). A project reached through a node the caller can already see is
  // share_write_forbidden, because there is no existence left to protect.
  const gates = new Map();
  const memo = (key, run) => {
    if (!gates.has(key)) gates.set(key, run());
    return gates.get(key);
  };
  const gateFiledUnder = (projectId) => memo(`filed:${projectId || ''}`, () => assertGraphNodeCreatable(actor, projectId || null));
  // allowArchived: this gate is only ever asked about a node that ALREADY EXISTS
  // (and, with null, about the workspace). See assertExistingGraphNodeWritable.
  const gateProject = (projectId) => memo(`node:${projectId || ''}`, () => assertGraphProjectWritable(actor, ownerKey, projectId || null, { allowArchived: true }));
  // Server-composed entities (auto-promotion, structured events) carry the
  // project their brief was written in. That is not a caller naming the project
  // for the entity, so it never adopts an existing workspace-level node.
  const serverComposed = Boolean(options.serverComposed || options.serverWritten);

  // THE WORKING PROJECT. The manage_memory dispatchers fill in, for an entity
  // that names no project of its own, the project the caller is working in (the
  // top-level project_id, else the active project) and mark it filed_by_default
  // — with scope:"project" kept beside it when the caller asked for the project
  // that way. It is where the caller is, not the caller's word about the entity:
  //
  //   1. A NEW entity is filed there whenever the caller may edit its section
  //      there: the project's author always, a teammate when the share lets them
  //      edit that section. A workspace-level node is readable by every member,
  //      so defaulting to it published what only the project's readers were
  //      meant to see — a solo user's history on the first invite, an author's
  //      decisions past their own narrowed share (scan 31). Only when the caller
  //      may NOT edit that section there — a member writing their own knowledge
  //      while working in a teammate's shared project whose share withholds it
  //      — is it workspace-level: it is theirs, not that project's, and refusing
  //      it made the team's tools unsaveable (scan 30). A personal/private
  //      working project, or one asked for by scope:"project", is refused
  //      instead, naming the section: widening those would publish them.
  //   2. An EXISTING node (the one the write lands on — landGraphWrite, which
  //      never lands on a row the caller may not both read and change outside
  //      its own home) keeps its own home. A dispatcher-filled project never
  //      moves it (scans 29, 31); a sighting in the working project is
  //      recorded instead (recordSighting), which is how the portfolio counts
  //      it as cross-project. The one exception is the caller's own pre-team
  //      private node (metadata.private_to), which their filing adopts.
  //   3. A status change (resolve/reopen) belongs to the working project when
  //      ITS decision log carries the decision, and otherwise to the node's own.
  //
  // Read once per call. A project the caller cannot open is project_not_found,
  // as a named one is; an archived one is fine — reading it files nothing.
  const workingProject = (projectId) => memo(`working:${projectId}`, async () => {
    const loaded = await loadProjectForWrite(actor, projectId, { requireWriteRole: false, allowArchived: true });
    if (!loaded) throw new Error('project_not_found');
    return loaded;
  });
  let sharedWorkspacePromise = null;
  const isSharedWorkspace = () => {
    if (!sharedWorkspacePromise) sharedWorkspacePromise = workspace.isSharedWorkspace(ownerKey).catch(() => false);
    return sharedWorkspacePromise;
  };
  // The sections of `node` this caller may NOT edit in a loaded project: empty
  // for its author (and a solo account, whose every project is theirs).
  const sectionsNotEditable = (loaded, node) => {
    const { project, policy } = loaded;
    if (holdsAuthorRights(actor, project, policy)) return [];
    return graphNodeSectionsForEdit(node).filter((section) => !canEditSectionForActor(actor, project, policy, section));
  };
  // Does the working project's own decision log carry this decision, open or
  // resolved? The same matching the propagation below uses (an exact text, or a
  // clip exactly one open decision begins with — an ambiguous clip counts, so
  // the refusal naming the candidates comes from this project). Only a log the
  // caller may read is asked: an answer about a withheld one would say what it
  // holds.
  const workingLogHolds = (loaded, nodes) => {
    const { project, policy } = loaded;
    if (!canViewSectionForActor(actor, project, policy, 'recent_decisions')) return false;
    const decisions = (project.context?.recent_decisions || []).filter(Boolean);
    return nodes.filter(Boolean).some((node) => {
      if (decisions.some((d) => decisionNodeMatches(d.summary, node))) return true;
      const { indexes, ambiguous } = decisionsResolvedBy(decisions, node);
      return indexes.length > 0 || ambiguous.length > 0;
    });
  };
  // Rule 1's refusal: a new entity the caller may not file in the working
  // project, where widening it to the workspace would publish it. Named, and
  // nothing stored.
  const workingNotFileable = (loaded, blocked, title, asked) => {
    const { project } = loaded;
    const why = asked
      ? 'You asked for scope:"project", so it is not saved for the whole workspace instead.'
      : `That project is ${project.visibility}, so it is not saved for the whole workspace instead.`;
    return writeForbiddenError(
      `share_write_forbidden: nothing was saved. "${title}" names no project, so it would be filed under ${project.project_name || project.project_id}, `
      + `the project you are working in, and you cannot edit ${blocked.join(', ')} there. ${why} `
      + 'Pass project_id naming a project you can change, or scope:"workspace" to share it with everyone.',
      blocked,
    );
  };

  // A KEY HELD BY A ROW THE CALLER MAY NOT LAND ON. Graph nodes are unique on
  // (owner_key, node_type, canonical_key) and owner_key is the WORKSPACE, so a
  // member's personal "Stripe" held `service:stripe` for everybody: every later
  // save of that name by anyone who could not read it was node_not_found (scan
  // 31), and by anyone who could read but not change it (a member's private
  // "Postgres" read by the owner, a view-only team decision) it was refused
  // (scan 32). Such a row is neither written nor refused over: the caller's
  // entity lands on their own node for where it is filed — the one landing rule
  // every graph write uses (landGraphWrite, scopedEntityKey). What it reveals —
  // that the plain key is taken — is what the refusal it replaces already said.
  const landing = () => memo('landing', () => graphLandingForActor(actor, ownerKey));
  // The project this CALL works in, for a relation that names an entity by the
  // key its title makes: the first filled-in working project, else the
  // top-level project_id the caller passed.
  let callWorkingProjectId = null;
  const callerMayWrite = async (node) => {
    try {
      await assertExistingGraphNodeWritable(actor, ownerKey, node, gateProject);
      return true;
    } catch {
      return false;
    }
  };
  const nodeHiddenFromCaller = async (node) => Boolean(node) && !(await graphNodeAccessForActor(actor, ownerKey, node)).visible;

  // A SIGHTING, NOT A MOVE (rule 2). An existing node saved again while the
  // caller works in another project keeps its home; the evidence row records
  // that this project uses it too, which is what the portfolio's cross-project
  // view and the project's graph read (listCrossProjectEntities,
  // listCrossProjectEntities). Only for a node that has a project. It is a USAGE
  // record, never a read grant: the visibility map leaves sightings out
  // (store.listGraphNodeProjectIds), because visibility is judged at every read
  // and a sighting that counted kept a colleague's node readable to whoever
  // re-saved it long after its author took the home project personal (scan 32).
  // Still recorded only where it could not have widened anyone's view — in a
  // team, the caller's own personal project — since the evidence row carries
  // the caller's text into that project's graph. A solo workspace has one reader.
  const recordSighting = async (node, projectId, text) => {
    if (!node?.node_id || !node.project_id || !projectId || node.project_id === projectId) return;
    const loaded = await workingProject(projectId).catch(() => null);
    if (!loaded || loaded.project.archived_at || sectionsNotEditable(loaded, node).length) return;
    const onlyReader = loaded.project.visibility === 'personal' && isProjectOwner(actor, loaded.project);
    if (!onlyReader && await isSharedWorkspace()) return;
    const seen = await store.listGraphNodeProjectIds(ownerKey, [node.node_id], { includeSightings: true });
    if ((seen.get(node.node_id) || []).includes(projectId)) return;
    await store.addGraphEvidence({
      evidence_id: makeId('graph_evidence'),
      owner_key: ownerKey,
      project_id: projectId,
      session_id: 'manual',
      node_id: node.node_id,
      tool: 'manual_workspace_entity',
      // The entity's own title and summary as filed — not conversation text.
      excerpt: clipText(text || node.title, 280),
      excerpt_kind: 'derived',
      metadata: { source: 'manual_workspace_entity', kind: 'sighting' },
      confidence: 0.9,
      created_at: now,
    });
  };

  // `project:<name>` → the ROOT of the one project the caller can see with that
  // name. Roots are keyed `project:<project_id>` since round 16 (projectRootKey),
  // so a key built from a project's NAME — what an agent writes, and what
  // upsert_entities builds from {title: "Atlas", entity_type: "project"} — no
  // longer names the root: the entity became a second, unrelated "Atlas" node
  // and every relation to `project:atlas` was dropped without a word.
  //   { project }         exactly one visible project carries that name;
  //   { ambiguous: [...] } more than one does — naming a winner would hang the
  //                        caller's knowledge off a guess;
  //   null                 none does (or the key is not `project:`-shaped).
  // One project listing per call, however many keys need it.
  let visibleProjectsPromise = null;
  const projectByNameKey = async (key) => {
    const text = String(key || '');
    if (!text.startsWith('project:')) return null;
    const nameKey = normalizeKey(text.slice('project:'.length));
    if (!nameKey) return null;
    if (!visibleProjectsPromise) visibleProjectsPromise = listProjects(actor).catch(() => []);
    const projects = await visibleProjectsPromise;
    // An id is unambiguous. It is compared normalised because a canonical_key
    // an entity supplies is run through normalizeKey, which folds the id's
    // underscore to a hyphen — so `project:<project_id>` would otherwise miss.
    const byId = projects.find((project) => normalizeKey(project.project_id) === nameKey);
    if (byId) return { project: byId };
    const matches = projects.filter((project) => normalizeKey(project.project_name) === nameKey);
    if (matches.length === 1) return { project: matches[0] };
    if (matches.length > 1) return { ambiguous: matches };
    return null;
  };
  const isProjectRoot = (node) => Boolean(node && node.node_type === 'project' && node.project_id
    && node.canonical_key === graphService.projectRootKey(node.project_id));

  // Once, up front: a viewer is refused before any entity is parsed, so a
  // rejected batch never half-lands.
  if ((input.entities || []).length || (input.relations || []).length) await gateProject(null);

  // ONE BAD ENTITY DOES NOT SINK THE BATCH, AND DOES NOT HALF-LAND IT EITHER.
  //
  // Each entity is written inside this loop, so a throw on entity four used to
  // leave one to three stored and answer the caller with an error — a batch the
  // caller believed had failed, and would send again. And the exact-key refusal
  // (a colleague's hidden node already holds that canonical key) made every
  // batch carrying that one title fail for that teammate, forever.
  //
  // Each entity now succeeds or is SKIPPED on its own, and the skips are
  // returned with their reason. A batch in which nothing at all could be written
  // still throws its first error, so a single-entity call reports exactly what
  // it always did.
  const skipped = [];
  // Resolves applied to a named project's brief without writing a node (see the
  // cross-project rule in upsertOne).
  const briefOnlyResolves = [];
  // ...and the reopens: status active on another project's decision node.
  const briefOnlyReopens = [];
  // Nodes written for the NON-status part of such a resolve or reopen: their
  // status is their own project's, so they propagate nothing to any brief.
  const sideWriteKeys = new Set();
  // Status changes a defaulted entity applied to the node's OWN project because
  // the working project's log does not carry the decision: the reply names it.
  const homeStatusKeys = new Set();
  // Existing entities whose stored description the write did not replace:
  // because it was long enough to keep, or because it is another project's.
  const keptSummaries = [];
  const keptElsewhere = [];
  // The caller's own private (pre-team) nodes this call published or kept.
  const privateNotes = [];
  const privateKept = [];
  const projectLabel = async (projectId) => {
    if (!projectId) return null;
    const loaded = await workingProject(projectId).catch(() => null);
    return loaded?.project?.project_name || null;
  };
  let firstError = null;
  for (const rawEntityInput of input.entities || []) {
    try {
      await upsertOne(rawEntityInput);
    } catch (err) {
      if (!firstError) firstError = err;
      skipped.push({
        title: String(rawEntityInput?.title || rawEntityInput?.name || '').slice(0, 200),
        entity_type: String(rawEntityInput?.entity_type || ''),
        reason: err?.code || err?.message || 'failed',
        message: err?.publicMessage || null,
      });
    }
  }
  if (firstError && !entities.length && !briefOnlyResolves.length && !briefOnlyReopens.length) throw firstError;

  async function upsertOne(rawEntityInput) {
    // Contract: entities[].title (required) and entities[].entity_type (required)
    // — see the inputSchema in routes/mcp.js and tools/context-sync.ts for the
    // full declared shape. `name` is accepted as a backward-compatible alias for
    // `title` since many callers guess at that field name.
    const titleCandidate = (rawEntityInput.title != null && String(rawEntityInput.title).trim())
      ? String(rawEntityInput.title).trim()
      : String(rawEntityInput.name || '').trim();
    const rawEntity = { ...rawEntityInput, title: titleCandidate };
    // A project_id the manage_memory dispatchers filled in (the top-level one, or
    // the active project) rather than one this entity names itself: the WORKING
    // project (see workingProject above). The entity itself names nothing, so
    // both are taken off it here and the rules below decide; a scope:"project"
    // beside the flag is the caller asking for that project (askedForProject),
    // which never widens to the workspace. Never stored: it is a note about this
    // call, not about the entity.
    const filedByDefault = rawEntity.filed_by_default === true && Boolean(rawEntity.project_id);
    delete rawEntity.filed_by_default;
    const workingProjectId = filedByDefault ? String(rawEntity.project_id) : null;
    const askedForProject = filedByDefault && rawEntity.scope === 'project';
    if (filedByDefault) {
      delete rawEntity.project_id;
      delete rawEntity.scope;
    }

    if (titleCandidate.length < 3) {
      // Distinct from the low-value CONTENT rejection below: this is a missing or
      // too-short REQUIRED field, not a content-quality judgment, so it gets its
      // own honest, actionable error instead of being blamed on content quality.
      const err = new Error('workspace_entity_title_required');
      err.publicMessage = 'workspace_entity_title_required: entities[].title (or the `name` alias) is required and must be at least 3 characters.';
      throw err;
    }

    const entityType = String(rawEntity.entity_type || '').trim();
    if (!entityType || !GRAPH_NODE_TYPE_VALUES.includes(entityType)) {
      // Caught here, before it ever reaches the store layer — a missing/invalid
      // entity_type must never surface as a raw Postgres error naming an internal
      // table/column (e.g. context_graph_nodes.node_type).
      const err = new Error('workspace_entity_type_invalid');
      err.publicMessage = `workspace_entity_type_invalid: entities[].entity_type is required and must be one of: ${GRAPH_NODE_TYPE_VALUES.join(', ')}`;
      throw err;
    }
    rawEntity.entity_type = entityType;

    if (String(rawEntity.summary || '').trim() && isGenericEntitySummary(rawEntity.summary)) {
      const err = new Error('low_value_workspace_entity');
      err.publicMessage = 'Workspace entity is too generic to store durably.';
      throw err;
    }
    const nodeType = workspaceNodeType(rawEntity.entity_type);
    // Judged before anything is looked up, as a named project is below.
    const working = filedByDefault ? await workingProject(workingProjectId) : null;
    let { key: canonicalKey, masked: secretInIdentity } = workspaceEntityKey(rawEntity, rawEntityInput[RAW_WORKSPACE_ENTITY]);
    // The project the CALLER named, judged before anything is looked up: naming
    // a project id you cannot open must not even reach the lookups below, which
    // would otherwise tell you whether a node is there.
    const namedScope = rawEntity.scope || (rawEntity.project_id ? 'project' : 'workspace');
    if (namedScope === 'project' && rawEntity.project_id) await gateFiledUnder(rawEntity.project_id);
    // WHERE THE WRITE LANDS (landGraphWrite). Home is where the caller puts it:
    // the working project for a defaulted entity, the project it names, or the
    // workspace. The plain-key row is the entity when it is that home's, or is
    // workspace-level and the caller may change it, or — rule 2 — is homed in
    // another project the caller may read and change; otherwise the caller's
    // own node for that home, `<key>::in.<home>`, found or (once its filing is
    // decided, below) created. A free plain key with the caller's own scoped
    // node for this home (the holder since deleted) lands on that node, not
    // beside it. Not for a project root: a `project:` key is a project's
    // identity, and one the caller cannot see is refused as it always was.
    if (filedByDefault && !callWorkingProjectId) callWorkingProjectId = workingProjectId;
    const home = filedByDefault ? workingProjectId : (namedScope === 'project' ? (rawEntity.project_id || null) : null);
    const landed = await landGraphWrite(ownerKey, await landing(), {
      nodeType,
      key: canonicalKey,
      home,
      // By the key's own type prefix, as this lookup always was (a legacy or
      // caller-supplied key can disagree with entity_type).
      plain: await findWorkspaceNodeByCanonicalKey(ownerKey, canonicalKey),
      canSee: async (node) => !(await nodeHiddenFromCaller(node)),
      canWrite: callerMayWrite,
      elsewhere: true,
      ownPrivate: true,
    });
    let existingNode = landed.node;
    // The plain key is somebody else's row: a new entity takes its scoped key.
    const hiddenKeyHolder = landed.scoped;
    let mappedToProjectRoot = false;
    // A `project` entity named like a project the caller can see IS that
    // project: map it onto the project's root (keyed by id) instead of minting a
    // second node of the same name beside it. Two visible projects with the name
    // is refused with the way out, never resolved to a guess.
    if (nodeType === 'project' && !secretInIdentity && !isProjectRoot(existingNode)) {
      const byName = await projectByNameKey(canonicalKey);
      if (byName?.ambiguous) {
        const err = new Error('workspace_entity_project_ambiguous');
        err.publicMessage = `workspace_entity_project_ambiguous: more than one project you can see is named "${rawEntity.title}" `
          + `(${byName.ambiguous.map((project) => project.project_id).join(', ')}). `
          + 'Pass canonical_key "project:<project_id>" to say which one.';
        throw err;
      }
      if (byName?.project) {
        canonicalKey = graphService.projectRootKey(byName.project.project_id);
        rawEntity.project_id = byName.project.project_id;
        rawEntity.scope = 'project';
        // The root's title is the project's name; a lower-cased echo of it must
        // not retitle the project's node.
        rawEntity.title = byName.project.project_name;
        existingNode = await findWorkspaceNodeByCanonicalKey(ownerKey, canonicalKey);
        mappedToProjectRoot = true;
      }
    } else if (isProjectRoot(existingNode)) {
      // Named by its root key: same rule, the root's title is the project's.
      rawEntity.title = existingNode.title;
    }
    // Rows written before canonicalWorkspaceKey became prefix-idempotent carry a
    // DOUBLE prefix (`decision:decision:foo`), because the old code re-prefixed
    // every supplied key. A caller that reconstructs the key it originally sent
    // now computes the single-prefixed form, which misses that row — and without
    // this it would insert a second node, i.e. the fix would reintroduce exactly
    // the duplicate it removes, once per affected entity.
    //
    // Feeding back a key READ FROM the graph is already idempotent, so only the
    // reconstruct-it case needs this. Matching the legacy row also heals it: the
    // upsert below writes through its existing canonical_key.
    let effectiveCanonicalKey = existingNode ? existingNode.canonical_key : canonicalKey;
    if (!existingNode && !hiddenKeyHolder && rawEntity.canonical_key) {
      const legacyKey = `${rawEntity.entity_type}:${canonicalKey}`;
      const legacyNode = await findWorkspaceNodeByCanonicalKey(ownerKey, legacyKey);
      if (legacyNode) {
        existingNode = legacyNode;
        // Write THROUGH the legacy key, or the upsert's ON CONFLICT target does
        // not match and it inserts alongside the row we just found — carrying the
        // old metadata forward while still duplicating the node.
        effectiveCanonicalKey = legacyKey;
      }
    }
    const incomingResolves = nodeType === 'decision'
      && String(rawEntity.metadata?.status || '').toLowerCase() === 'resolved';
    const incomingReopens = nodeType === 'decision'
      && ['active', 'open'].includes(String(rawEntity.metadata?.status || '').toLowerCase());
    // WHERE A DEFAULTED ENTITY GOES (the rules at workingProject, above).
    //   - a status change the working project's decision log carries: that
    //     project's, as if named (the cross-project rule below keeps another
    //     project's node — or the workspace's — out of it). Scan 30: keeping
    //     the node's home first resolved a COLLEAGUE's project instead, and left
    //     the caller's own decision open;
    //   - an existing node: its own home, project or workspace. A defaulted
    //     project never re-homes it (scan 29);
    //   - a new entity: the working project when the caller may edit its section
    //     there; otherwise refused for a personal/private working project or a
    //     scope:"project" ask, and workspace-level for a teammate's shared one.
    //     An archived working project files nothing new (the creation gate
    //     refuses it), so there it is workspace-level unless widening would
    //     publish it, in which case the gate's refusal stands.
    // Not for an entity mapped onto a project's root: that IS its project.
    // THE AUTHOR'S OWN PRIVATE NODE. The first invite marks a founder's pre-team
    // no-project nodes private to them (metadata.private_to,
    // workspaceService.backfillProjectOwnership). The founder saving one again
    // is the author deciding where it lives: filed under a project (named, or
    // the working project by default, when they may file there) it is adopted
    // into that project; with an explicit scope:"workspace" it becomes the
    // team's. Either way the mark is cleared and the reply says so. Anything
    // else — no project, or a server-composed write (auto-promotion, an
    // import) — keeps it private: none of those is the author's word.
    const privateMine = Boolean(existingNode) && !existingNode.project_id && nodePrivateToWriter(existingNode, await landing());
    let workingHolds = false;
    if (filedByDefault && !mappedToProjectRoot) {
      const probe = { title: rawEntity.title, summary: rawEntity.summary || '', canonical_key: effectiveCanonicalKey };
      if ((incomingResolves || incomingReopens) && workingLogHolds(working, [probe, existingNode])) {
        workingHolds = true;
        rawEntity.project_id = workingProjectId;
        rawEntity.scope = 'project';
      } else if (existingNode && !privateMine) {
        if (existingNode.project_id) {
          rawEntity.project_id = existingNode.project_id;
          rawEntity.scope = 'project';
          if ((incomingResolves || incomingReopens) && existingNode.project_id !== workingProjectId) homeStatusKeys.add(effectiveCanonicalKey);
        } else {
          rawEntity.scope = 'workspace';
        }
      } else {
        const blocked = sectionsNotEditable(working, { node_type: nodeType, metadata: { ...(rawEntity.metadata || {}), entity_type: rawEntity.entity_type } });
        const mustNotWiden = askedForProject
          || (['personal', 'private'].includes(working.project.visibility) && await isSharedWorkspace());
        if (blocked.length && mustNotWiden) throw workingNotFileable(working, blocked, rawEntity.title, askedForProject);
        if (!blocked.length && (!working.project.archived_at || mustNotWiden)) {
          rawEntity.project_id = workingProjectId;
          rawEntity.scope = 'project';
        } else {
          rawEntity.scope = 'workspace';
        }
      }
    }
    let scope = rawEntity.scope || (rawEntity.project_id ? 'project' : 'workspace');
    // The project this entity is filed under — the caller's (already judged,
    // memoised), the project a `project` entity was mapped onto above, or a
    // defaulted one's (above).
    const filedUnder = scope === 'project' ? (rawEntity.project_id || null) : null;
    // A defaulted entity on an EXISTING node files nothing new: that node, and
    // its home project, are judged below as any existing node is (archived
    // allowed — scan 30: the creation gate refused re-saving an entity learned
    // in a project since archived).
    if (filedUnder && !(filedByDefault && existingNode && !privateMine)) await gateFiledUnder(filedUnder);
    const publishPrivate = privateMine && !serverComposed && !options.neverAdopt
      ? (filedUnder ? 'project' : (!filedByDefault && rawEntityInput.scope === 'workspace' ? 'workspace' : null))
      : null;
    // A DECISION NAMED BY ITS CLIPPED TITLE IS THAT DECISION. recall(action:
    // "entities") lists a decision under the title the extractor cut to 79
    // characters + "...", and that is the title a caller copies back. Keyed on the
    // clip it was a new node beside the real one — the upsert answered "saved",
    // the brief stayed open (a clip matches no decision), and phase 5 never merged
    // the two. So when exactly one decision node in the named project carries the
    // clip (the same title, or a text that starts with it), the write goes to THAT
    // node, keeping its full text. Two of them is a guess: refused for a resolve
    // (resolving the wrong one is not undoable from here), left alone otherwise.
    if (!existingNode && nodeType === 'decision' && !rawEntity.canonical_key && filedUnder) {
      const cut = decisionClipVisible(rawEntity.title, 'summary');
      if (cut !== null) {
        const carriers = await decisionNodesCarryingCut(actor, ownerKey, filedUnder, rawEntity.title, cut);
        if (carriers.length === 1) {
          existingNode = carriers[0];
          canonicalKey = existingNode.canonical_key;
          effectiveCanonicalKey = existingNode.canonical_key;
          rawEntity.title = existingNode.title;
          if (!String(rawEntity.summary || '').trim()) rawEntity.summary = existingNode.summary;
        } else if (carriers.length > 1 && incomingResolves) {
          const err = new Error('decision_title_ambiguous');
          // The refusal comes first: a long reply is clipped on the way out.
          err.publicMessage = `decision_title_ambiguous: nothing was resolved. "${rawEntity.title}" is cut short and ${carriers.length} decisions `
            + 'in this project begin with it; resolve with the complete decision text, or pass its canonical_key. They begin: '
            + carriers.slice(0, 5).map((node) => `"${clipText(decisionNodeText(node).visible, 120)}"`).join('; ');
          throw err;
        }
      }
    }
    // A RESOLVE FILED UNDER ONE PROJECT IS THAT PROJECT'S. Decision nodes are
    // unique per owner and keep the FIRST project that wrote them, so the same
    // decision recorded in repos A and B is one node filed under A. Resolving it
    // "in B" merged status:resolved into A's node and the propagation flipped A's
    // brief — B stayed open forever, and every retry said "already resolved". The
    // node is another project's, so it is neither written nor answered with; the
    // resolve is applied to the named project's brief alone (below).
    //
    // A workspace-level node counts as "another project's" for a defaulted
    // status change the working project's log carries — resolving the team's
    // decision in your own project's log does not resolve it for the team — and
    // for every SERVER-COMPOSED one (auto-promotion mirroring a brief): that
    // status is what one project's log says, never the caller's word about the
    // team's node. A member resolving a decision in their personal project
    // resolved the team's decision of the same text for everybody, dropping it
    // from every teammate's context loads (scan 34 a/F4).
    const crossProjectStatus = (incomingResolves || incomingReopens) && filedUnder && existingNode
      && existingNode.project_id !== filedUnder
      && (Boolean(existingNode.project_id) || workingHolds || serverComposed);
    // AND SO IS A REOPEN. status:"active" naming B, on the node A filed first,
    // answered "Upserted 1" and wrote A's node (already open) while B's resolved
    // entry stayed resolved: the reopen reached neither brief (scan 27). Same
    // rule as the resolve above: the named project's decision log, not the node.
    if (crossProjectStatus) {
      const item = {
        projectId: filedUnder,
        title: rawEntity.title,
        node: { title: rawEntity.title, summary: rawEntity.summary || '', canonical_key: effectiveCanonicalKey },
        ...(existingNode.project_id ? {} : { workspace_node: true }),
      };
      (incomingResolves ? briefOnlyResolves : briefOnlyReopens).push(item);
      // ONLY THE STATUS IS THE NAMED PROJECT'S. A summary or metadata change in
      // the same upsert is a change to the stored entity, and returning here
      // dropped it without a word behind "Upserted" (scan 28). It is applied to
      // the node when the caller may change that node, with the status left as
      // the node's own project has it; when they may not, the reply names the
      // fields that were not applied.
      const fields = nonStatusDecisionChanges(rawEntity, existingNode);
      if (!fields.length) return;
      // A NODE'S WORDS ARE ITS OWN PROJECT'S (scan 36 b/p114): a save filed
      // under another project records that it is used there and never rewrites
      // it (store.upsertGraphNode), so none of the rest is claimed as applied.
      if (existingNode.project_id) {
        item.fields_not_applied = fields;
        item.not_applied_reason = 'other_project';
        // A long stored summary is not one of `fields` (no upsert replaces it);
        // said as the write below would say it (scan 30).
        const wanted = String(rawEntity.summary || '').trim();
        const had = String(existingNode.summary || '').trim();
        if (wanted && had.length >= 40 && wanted.toLowerCase().replace(/\s+/g, ' ') !== had.toLowerCase().replace(/\s+/g, ' ')) {
          keptSummaries.push(existingNode.title);
        }
        return;
      }
      try {
        await assertExistingGraphNodeWritable(actor, ownerKey, existingNode, gateProject);
      } catch {
        item.fields_not_applied = fields;
        return;
      }
      item.fields_applied = fields;
      const { status: _status, resolved_at: _resolvedAt, resolution_note: _note, ...keptMeta } = rawEntity.metadata || {};
      rawEntity.metadata = keptMeta;
      if (!String(rawEntity.summary || '').trim()) rawEntity.summary = existingNode.summary || '';
      if (existingNode.project_id) {
        rawEntity.project_id = existingNode.project_id;
      } else {
        delete rawEntity.project_id;
        scope = 'workspace';
      }
      sideWriteKeys.add(effectiveCanonicalKey);
    }
    // NO FUZZY DEDUP. A similar node found by title or embedding was set as
    // `existingNode` while the write still went through THIS entity's key, so it
    // inserted a new row beside the match — judged as the match (its gates, not
    // the new row's: a member put new decisions into a view-only share, and was
    // refused their own personal save over a colleague's view-only decision)
    // and carrying the match's metadata (a new decision was born resolved and
    // never shown). The match was never the row written, so it steered the
    // write without merging anything. An entity is its key (scan 31).
    //
    // A new entity whose plain key a hidden node holds takes its scoped key,
    // now that its filing is known. Judged like any key: one someone else holds
    // unseen is refused, never merged into.
    if (hiddenKeyHolder && !existingNode) {
      effectiveCanonicalKey = scopedEntityKey(canonicalKey, filedUnder);
      const taken = await findWorkspaceNodeByCanonicalKey(ownerKey, effectiveCanonicalKey);
      if (taken) existingNode = taken;
    }
    // Whatever the lookup landed on, the write goes to the EXISTING node's project
    // — upsertGraphNode resolves its conflict with
    // project_id = COALESCE(existing, EXCLUDED), so the row keeps the project it
    // already has and the one the caller named is ignored. So the gate has to
    // judge the matched node's own project, not the supplied one.
    //
    // And ALWAYS judged, not only when the projects differ: an exact-key match in
    // the very project the caller named can still be a node that project's share
    // withholds from them (a decision in a share without recent_decisions) or its
    // root, which they see with the summary blanked. Filing under the same
    // project said nothing about either, and the upsert merged into both.
    if (existingNode) {
      await assertExistingGraphNodeWritable(actor, ownerKey, existingNode, gateProject);
    }
    // A NODE'S WORDS ARE ITS OWN PROJECT'S (scan 36 b/p114). An existing node
    // homed in a project this save does not come from — the working project of
    // a defaulted save, or the one the entity names — takes the save as a
    // sighting (below) and keeps its title, summary and metadata: in a
    // one-person workspace this landed a job-hunt project's note on the billing
    // project's decision, and sharing billing published it. The store judges a
    // named project itself; a defaulted save is re-filed under the node's own
    // home above, so it is marked here (keep_text). The one change such a save
    // may still make is the one rule 3 sends to the node's own project — a
    // status its working project's log does not carry — and it makes only that.
    let wordsKept = Boolean(existingNode?.project_id) && !mappedToProjectRoot
      && String(home || '') !== String(existingNode.project_id);
    if (wordsKept && homeStatusKeys.has(effectiveCanonicalKey)) {
      wordsKept = false;
      rawEntity.summary = existingNode.summary || '';
      rawEntity.title = existingNode.title;
      rawEntity.metadata = Object.fromEntries(Object.entries(rawEntity.metadata || {})
        .filter(([key]) => DECISION_STATUS_METADATA_KEYS.has(key) && key !== 'resolution_note'));
    }
    const existingMeta = existingNode?.metadata || {};
    const incomingMeta = rawEntity.metadata || {};
    const sourceKeys = uniqueStrings([
      ...(Array.isArray(existingMeta.source_keys) ? existingMeta.source_keys : []),
      ...(Array.isArray(incomingMeta.source_keys) ? incomingMeta.source_keys : []),
      incomingMeta.source,
      existingMeta.source,
    ]);
    const incomingSeenCount = Number(incomingMeta.seen_count ?? (existingNode ? 1 : 0));
    const seenCount = existingNode
      ? Math.max(1, Number(existingMeta.seen_count || 0) + incomingSeenCount)
      : Math.max(1, incomingSeenCount || 1);
    const sourceCount = Math.max(sourceKeys.length, Number(existingMeta.source_count || 0), Number(incomingMeta.source_count || 0), 1);
    const retrievalHits = Math.max(Number(existingMeta.retrieval_hits || 0), Number(incomingMeta.retrieval_hits || 0), 0);
    let memoryTier = incomingMeta.memory_tier || existingMeta.memory_tier || 'durable';
    if (memoryTier === 'candidate' && shouldPromoteCandidateMetadata({
      ...existingMeta,
      ...incomingMeta,
      memory_tier: memoryTier,
      seen_count: seenCount,
      source_count: sourceCount,
      retrieval_hits: retrievalHits,
      pinned: incomingMeta.pinned || existingMeta.pinned,
    })) {
      memoryTier = 'durable';
    }
    const metadata = {
      ...existingMeta,
      ...incomingMeta,
      scope,
      entity_type: rawEntity.entity_type,
      importance: incomingMeta.importance || existingMeta.importance || 'normal',
      status: incomingMeta.status || existingMeta.status || (rawEntity.entity_type === 'capability' || rawEntity.entity_type === 'workflow' ? 'active' : undefined),
      pinned: Boolean(incomingMeta.pinned || existingMeta.pinned),
      curation_state: incomingMeta.curation_state || existingMeta.curation_state || (memoryTier === 'candidate' ? 'inferred' : 'curated'),
      source_kind: incomingMeta.source_kind || existingMeta.source_kind || 'manual',
      memory_tier: memoryTier,
      seen_count: seenCount,
      source_count: sourceCount,
      retrieval_hits: retrievalHits,
      source_keys: sourceKeys,
      verified_at: incomingMeta.verified_at || existingMeta.verified_at || now,
      last_matched_at: incomingMeta.last_matched_at || existingMeta.last_matched_at || now,
      last_selected_at: incomingMeta.last_selected_at || existingMeta.last_selected_at,
      source: incomingMeta.source || existingMeta.source || 'manual_workspace_entity',
    };
    if (publishPrivate) metadata.private_to = null;

    if (!existingNode) {
      await assertNewGraphNodeReadable(actor, {
        node_type: nodeType,
        project_id: scope === 'project' ? (rawEntity.project_id || null) : null,
        metadata,
      });
    }
    const saved = await store.upsertGraphNode({
      node_id: makeId('graph_node'),
      owner_key: ownerKey,
      project_id: scope === 'project' ? (rawEntity.project_id || null) : null,
      keep_text: wordsKept,
      // Only a project this entity NAMED (judged by gateFiledUnder above) may
      // take a workspace-level node into it; see store.upsertGraphNode.
      // Not a defaulted working project (a scope:"project" ask included — scan
      // 31), not a server-composed one (auto-promotion), and not an import's
      // target (options.neverAdopt): none is the caller's word about this node.
      // The author filing their own private node (publishPrivate) is naming it.
      adopt_project: publishPrivate === 'project'
        || (scope === 'project' && Boolean(rawEntity.project_id) && !filedByDefault && !serverComposed && !options.neverAdopt),
      node_type: nodeType,
      canonical_key: effectiveCanonicalKey,
      title: rawEntity.title,
      summary: rawEntity.summary || '',
      metadata,
      confidence: metadata.pinned ? 0.99 : 0.96,
      source_session_id: 'manual',
      source_tool: 'codex',
      created_at: now,
      updated_at: now,
      last_seen_at: now,
    });

    await store.upsertGraphEmbedding({
      owner_key: ownerKey,
      target_kind: 'node',
      target_id: saved.node_id,
      model: embeddings.MODEL,
      dimensions: embeddings.DIMENSIONS,
      vector: await embeddings.embedText(embeddings.buildNodeEmbeddingText(saved)),
    });

    // THE STORE KEEPS A STORED DESCRIPTION of 40 characters or more
    // (upsertGraphNode), so a new summary on an existing entity is not saved.
    // Said, not answered with a bare "Upserted" (scan 30).
    const wanted = String(rawEntity.summary || '').trim();
    const had = String(existingNode?.summary || '').trim();
    if (existingNode && existingNode.canonical_key === effectiveCanonicalKey && existingNode.node_type === nodeType
      && wanted && String(saved.summary || '').trim() === had
      && wanted.toLowerCase().replace(/\s+/g, ' ') !== had.toLowerCase().replace(/\s+/g, ' ')) {
      if (had.length >= 40) keptSummaries.push(saved.title);
      else if (wordsKept) keptElsewhere.push(saved.title);
    }

    // Rule 2's sighting: an existing node saved from another project than its
    // own (the working one, or one this entity named) is recorded as used there.
    if (existingNode && !serverComposed && saved.node_type !== 'project') {
      const sightingProject = filedByDefault ? workingProjectId : (namedScope === 'project' ? rawEntityInput.project_id : null);
      await recordSighting(saved, sightingProject ? String(sightingProject) : null, `${saved.title}${rawEntity.summary ? `: ${rawEntity.summary}` : ''}`)
        .catch((err) => console.warn('[CONTEXT] entity sighting not recorded:', err.message));
    }

    if (publishPrivate) {
      privateNotes.push(publishPrivate === 'project'
        ? `"${saved.title}" was private to you since your first invite; it is now filed under ${(await projectLabel(saved.project_id)) || 'that project'}, where that project's readers see it.`
        : `"${saved.title}" was private to you since your first invite; it is now shared with the workspace.`);
    } else if (privateMine && !serverComposed && !options.neverAdopt && filedByDefault) {
      privateKept.push(saved.title);
    }

    entities.push(saved);
    entityMap.set(saved.canonical_key, saved);
    // A relation in the same call names the entity by the key its title makes,
    // whichever node that key landed on (landGraphWrite).
    if (saved.canonical_key !== canonicalKey) entityMap.set(canonicalKey, saved);
  }

  // An endpoint the caller supplies by canonical key is looked up across the
  // whole owner, so a relation could be hung off a node in somebody's hidden
  // project — and the edge this writes carries `${fromNode.title} ... ${toNode.title}`
  // straight back to the caller in the response. Resolve an endpoint only if the
  // caller may see it; an unresolvable endpoint is already a skip, not an error,
  // so a hidden one reads exactly like a key that does not exist. Anything this
  // call just wrote (entityMap) is visible by construction and needs no check.
  //
  // Returns { node } or { reason }. The reason travels back to the caller: a
  // relation that could not be recorded was dropped silently before, and the
  // reply counted only the ones that landed. A hidden endpoint and a missing one
  // share the reason `not_found`, so the reason itself leaks nothing.
  const visibleNode = async (node) => {
    if (!node) return null;
    const visible = await visibleGraphNodesForActor(actor, ownerKey, [node]);
    return visible.length ? node : null;
  };
  const resolveEndpoint = async (rawKey) => {
    // The form the key was stored under (secretSafeKey), so a relation naming an
    // entity by the key its caller built finds the node this call just wrote.
    const canonicalKey = secretSafeKey(String(rawKey || ''));
    const written = entityMap.get(canonicalKey);
    if (written) return { node: written };
    const found = await findWorkspaceNodeByCanonicalKey(ownerKey, canonicalKey);
    // `project:<id>` — the root itself.
    if (isProjectRoot(found)) {
      const node = await visibleNode(found);
      return node ? { node } : { reason: 'not_found' };
    }
    // `project:<name>` — the root of the one visible project by that name, ahead
    // of any stray `project`-typed node that happens to hold the name key (the
    // duplicate this used to mint), because the root is what the caller meant.
    const byName = await projectByNameKey(canonicalKey);
    if (byName?.ambiguous) return { reason: 'ambiguous_project_name' };
    if (byName?.project) {
      const rootKey = graphService.projectRootKey(byName.project.project_id);
      const root = entityMap.get(rootKey) || await visibleNode(await findWorkspaceNodeByCanonicalKey(ownerKey, rootKey));
      if (root) return { node: root };
    }
    // A plain key names, for this caller, the node their saves of it land on
    // (landGraphWrite): their own scoped node for the project this call works
    // in, then their workspace-level one — whether the plain key is held by a
    // row they cannot see or has since been freed (scan 32: a relation to a key
    // a write in the same call had just saved was dropped once the holder was
    // gone). A visible plain-key row is still the answer when the caller has no
    // node of their own for it.
    const [keyType] = canonicalKey.split(':');
    if (keyType && keyType !== 'project' && !canonicalKey.includes(SCOPED_KEY_MARK) && (await landing()).scope) {
      const homes = [...new Set([callWorkingProjectId, input.project_id, null].map((home) => (home ? String(home) : null)))];
      for (const home of homes) {
        const own = await visibleNode(await findWorkspaceNodeByCanonicalKey(ownerKey, scopedEntityKey(canonicalKey, home)));
        if (own) return { node: own };
      }
    }
    const node = await visibleNode(found);
    return node ? { node } : { reason: 'not_found' };
  };

  const unresolvedRelations = [];
  for (const rawRelation of input.relations || []) {
    const from = await resolveEndpoint(rawRelation.from_canonical_key);
    const to = await resolveEndpoint(rawRelation.to_canonical_key);
    const fromNode = from.node;
    const toNode = to.node;

    if (!fromNode || !toNode) {
      unresolvedRelations.push({
        from_canonical_key: String(rawRelation.from_canonical_key || '').slice(0, 200),
        to_canonical_key: String(rawRelation.to_canonical_key || '').slice(0, 200),
        relation_type: String(rawRelation.relation_type || ''),
        unresolved: [
          ...(fromNode ? [] : [{ key: String(rawRelation.from_canonical_key || '').slice(0, 200), reason: from.reason }]),
          ...(toNode ? [] : [{ key: String(rawRelation.to_canonical_key || '').slice(0, 200), reason: to.reason }]),
        ],
      });
      continue;
    }

    const edge = await store.upsertGraphEdge({
      edge_id: makeId('graph_edge'),
      owner_key: ownerKey,
      project_id: fromNode.project_id || toNode.project_id || null,
      edge_type: rawRelation.relation_type,
      from_node_id: fromNode.node_id,
      to_node_id: toNode.node_id,
      summary: rawRelation.summary || `${fromNode.title} ${rawRelation.relation_type} ${toNode.title}`,
      metadata: { source: 'manual_workspace_relation' },
      confidence: 0.94,
      source_session_id: 'manual',
      source_tool: 'codex',
      created_at: now,
      updated_at: now,
      last_seen_at: now,
    });

    relations.push(edge);
  }

  // Single source of truth: when a decision node is marked resolved (e.g. via
  // mark_resolved), mirror that onto the owning project's recent_decisions so
  // active context loads exclude it everywhere, not just in the graph.
  //
  // THE PROJECT IS THE ONE THE RESOLVE WAS FILED UNDER. A node written here is
  // in that project (or, filed under none, in its own); a resolve naming another
  // project's node reaches that project's brief alone (briefOnlyResolves).
  const resolvedByProject = new Map();
  const queueResolve = (projectId, item) => {
    if (!resolvedByProject.has(projectId)) resolvedByProject.set(projectId, []);
    resolvedByProject.get(projectId).push(item);
  };
  for (const node of entities) {
    if (node.node_type !== 'decision') continue;
    if (sideWriteKeys.has(node.canonical_key)) continue;
    if (String(node.metadata?.status || '').toLowerCase() !== 'resolved') continue;
    if (!node.project_id) continue;
    queueResolve(node.project_id, { node, title: node.title, briefOnly: false, nodeHome: homeStatusKeys.has(node.canonical_key) });
  }
  for (const item of briefOnlyResolves) {
    queueResolve(item.projectId, {
      node: item.node, title: item.title, briefOnly: true, workspaceNode: item.workspace_node,
      fieldsApplied: item.fields_applied, fieldsNotApplied: item.fields_not_applied, notAppliedReason: item.not_applied_reason,
    });
  }
  //
  // A WRITE INTO THE DECISION LOG, SO IT NEEDS THE RIGHT TO EDIT IT. This read
  // the project raw and saved it without asking, so a member whose share made
  // recent_decisions view-only filed a NEW decision node with status:resolved
  // and flipped the owner's decision — dropped from every brief — through a
  // side door the context write refuses. Judged per project on the same rule
  // (canEditSectionForActor); a project the actor may not edit is skipped, and
  // the node they wrote is theirs to keep.
  //
  // And the match is the decision itself, not a substring of it: "lay off the"
  // resolved "we will lay off the payments team". Nor the prefix of a clipped
  // title, unless exactly one open decision carries it: see decisionsResolvedBy.
  //
  // What each resolve did to its brief is returned (decision_resolves), because
  // "Upserted 1" over a brief that did not change is the silent success this
  // path kept producing: a clip that matched two decisions, a project the caller
  // may not edit, or a decision that is not in the named project at all.
  const decisionResolves = [];
  for (const [projectId, items] of resolvedByProject) {
    const outcomes = items.map((item) => ({
      project_id: projectId, title: item.title, brief_only: item.briefOnly,
      resolved: [], already_resolved: false, ambiguous: [], refused: false,
      ...(item.nodeHome ? { node_home: true } : {}),
      ...(item.workspaceNode ? { workspace_node: true } : {}),
      ...(item.fieldsApplied ? { fields_applied: item.fieldsApplied } : {}),
      ...(item.fieldsNotApplied ? { fields_not_applied: item.fieldsNotApplied } : {}),
      ...(item.notAppliedReason ? { not_applied_reason: item.notAppliedReason } : {}),
    }));
    decisionResolves.push(...outcomes);
    try {
      // Compare-and-swap guarded: a lost swap re-runs this from a fresh read
      // (withContextWriteRetry), so a decision a teammate appended meanwhile is
      // kept, and the outcomes describe the attempt that landed.
      await withContextWriteRetry(async () => {
        for (const outcome of outcomes) Object.assign(outcome, { resolved: [], already_resolved: false, ambiguous: [], refused: false });
        const loaded = await loadProjectForWrite(actor, projectId, { requireWriteRole: false, allowArchived: true });
        const project = loaded?.project;
        if (!project) return;
        for (const outcome of outcomes) outcome.project_name = project.project_name || projectId;
        const decisions = project.context?.recent_decisions || [];
        if (!decisions.length) return;
        if (!isProjectOwner(actor, project) && !canEditSectionForActor(actor, project, loaded.policy, 'recent_decisions')) {
          for (const outcome of outcomes) outcome.refused = true;
          return;
        }
        const hit = new Set();
        items.forEach((item, i) => {
          const { indexes, ambiguous } = decisionsResolvedBy(decisions, item.node);
          for (const index of indexes) {
            hit.add(index);
            outcomes[i].resolved.push(decisions[index].summary);
          }
          outcomes[i].ambiguous = ambiguous;
          outcomes[i].already_resolved = !indexes.length && !ambiguous.length
            && decisions.some((d) => d?.resolved && decisionNodeMatches(d.summary, item.node));
        });
        if (!hit.size) return;
        const nextDecisions = decisions.map((d, index) => (hit.has(index) ? { ...d, resolved: true, resolved_at: now } : d));
        const updated = { ...project, context: { ...project.context, recent_decisions: nextDecisions, last_updated: now }, updated_at: now };
        await saveProjectGuarded(updated, actor);
      });
    } catch (err) {
      // Not fatal to the upsert (the node is written), but never silent: a
      // resolve that did not reach the brief is the thing to go looking for.
      for (const outcome of outcomes) { outcome.resolved = []; outcome.failed = true; }
      console.warn('[CONTEXT] resolved-decision propagation failed:', { projectId, error: err?.code || err?.message });
    }
  }

  // Reopens filed under another project's node: that project's log alone, on
  // the same edit rule as the resolves above.
  for (const item of briefOnlyReopens) {
    const outcome = {
      project_id: item.projectId, title: item.title, brief_only: true, reopen: true,
      reopened: [], already_open: false, refused: false,
      ...(item.workspace_node ? { workspace_node: true } : {}),
      ...(item.fields_applied ? { fields_applied: item.fields_applied } : {}),
      ...(item.fields_not_applied ? { fields_not_applied: item.fields_not_applied } : {}),
      ...(item.not_applied_reason ? { not_applied_reason: item.not_applied_reason } : {}),
    };
    decisionResolves.push(outcome);
    try {
      // Guarded like the resolves above.
      await withContextWriteRetry(async () => {
        Object.assign(outcome, { reopened: [], already_open: false, refused: false });
        const loaded = await loadProjectForWrite(actor, item.projectId, { requireWriteRole: false, allowArchived: true });
        const project = loaded?.project;
        if (!project) return;
        outcome.project_name = project.project_name || item.projectId;
        const decisions = project.context?.recent_decisions || [];
        if (!isProjectOwner(actor, project) && !canEditSectionForActor(actor, project, loaded.policy, 'recent_decisions')) {
          outcome.refused = true;
          return;
        }
        const hit = new Set();
        decisions.forEach((d, index) => { if (d?.resolved && decisionNodeMatches(d.summary, item.node)) hit.add(index); });
        if (!hit.size) {
          outcome.already_open = decisions.some((d) => d && !d.resolved && decisionNodeMatches(d.summary, item.node));
          return;
        }
        const nextDecisions = decisions.map((d, index) => {
          if (!hit.has(index)) return d;
          const { resolved_at: _resolvedAt, ...rest } = d;
          return { ...rest, resolved: false };
        });
        for (const index of hit) outcome.reopened.push(decisions[index].summary);
        await saveProjectGuarded({ ...project, context: { ...project.context, recent_decisions: nextDecisions, last_updated: now }, updated_at: now }, actor);
      });
    } catch (err) {
      outcome.reopened = [];
      outcome.failed = true;
      console.warn('[CONTEXT] reopened-decision propagation failed:', { projectId: item.projectId, error: err?.code || err?.message });
    }
  }

  // A RESOLVED QUESTION LEAVES THE BRIEF'S OPEN QUESTIONS (journey BLOCKED 13).
  //
  // manage_memory(action:"resolve") given an open question's text resolved its
  // graph node and answered "Marked resolved ... will no longer appear in
  // normal context loads", while the brief went on listing the question as
  // open. The same propagation the decisions above get: the question named
  // exactly (its node's title or text, case, outer whitespace and closing
  // punctuation aside) is removed from its project's open_questions, on the
  // same edit rule. Nothing else is written: no answer is invented, so no
  // decision is recorded (resolve_question is the call that records one).
  // A resolve that could not reach the brief says so, in the note both
  // dispatchers already append.
  const questionNotes = [];
  const questionsByProject = new Map();
  for (const node of entities) {
    if (node.node_type !== 'question') continue;
    if (sideWriteKeys.has(node.canonical_key)) continue;
    if (String(node.metadata?.status || '').toLowerCase() !== 'resolved') continue;
    if (!node.project_id) continue;
    if (!questionsByProject.has(node.project_id)) questionsByProject.set(node.project_id, []);
    questionsByProject.get(node.project_id).push(node);
  }
  for (const [projectId, nodes] of questionsByProject) {
    let refusedName = null;
    try {
      await withContextWriteRetry(async () => {
        refusedName = null;
        const loaded = await loadProjectForWrite(actor, projectId, { requireWriteRole: false, allowArchived: true });
        const project = loaded?.project;
        if (!project) return;
        const open = Array.isArray(project.context?.open_questions) ? project.context.open_questions : [];
        const named = new Set(nodes.flatMap((node) => [node.title, node.summary]).filter(Boolean).map((text) => dedupeKey(String(text))));
        const next = open.filter((question) => !named.has(dedupeKey(String(question || ''))));
        if (next.length === open.length) return;
        if (!isProjectOwner(actor, project) && !canEditSectionForActor(actor, project, loaded.policy, 'open_questions')) {
          refusedName = project.project_name || projectId;
          return;
        }
        await saveProjectGuarded({ ...project, context: { ...project.context, open_questions: next, last_updated: now }, updated_at: now }, actor);
      });
      if (refusedName) {
        questionNotes.push(` ${nodes.map((node) => `"${node.title}"`).join(', ')} is still listed as an open question in the brief of ${refusedName}: you cannot edit its open questions.`);
      }
    } catch (err) {
      questionNotes.push(` ${nodes.map((node) => `"${node.title}"`).join(', ')} could not be removed from the open questions of its brief, so it is still listed there.`);
      console.warn('[CONTEXT] resolved-question propagation failed:', { projectId, error: err?.code || err?.message });
    }
  }

  const echoedEntities = await echoGraphNodesForActor(actor, ownerKey, entities);
  return {
    entities: echoedEntities,
    // Where the entities landed, in words both dispatchers append to the reply
    // (journey r5): an entity that named no project is filed in the caller's
    // own, and the caller is told which. Nothing to say for a server-written
    // batch, which no person reads a reply to.
    filed_note: (options.serverComposed || options.serverWritten)
      ? ''
      : await describeEntityFiling(actor, echoedEntities),
    relations,
    skipped,
    unresolved_relations: unresolvedRelations,
    decision_resolves: decisionResolves,
    // Carries the resolved-question outcome too (only when it could not reach
    // the brief): it is the note both dispatchers append to a resolve's reply.
    decision_resolves_note: formatDecisionResolves(decisionResolves) + questionNotes.join(''),
    // Words both dispatchers append (hosted routes/mcp.js; local via POST
    // /workspace/entities), in the TEXT only, like the note above.
    summaries_kept: [...keptSummaries, ...keptElsewhere],
    summaries_kept_note: (keptSummaries.length
      ? ` Kept the existing description of ${keptSummaries.map((title) => `"${title}"`).join(', ')}: a stored description is not replaced by an upsert, so the new summary was not saved.`
      : '')
      + (keptElsewhere.length
        ? ` Kept the description of ${keptElsewhere.map((title) => `"${title}"`).join(', ')}: ${keptElsewhere.length === 1 ? 'it belongs' : 'they belong'} to another project, and a save from this one records that it is used here without rewriting it, so the new summary was not saved.`
        : ''),
    // The caller's pre-team private nodes (metadata.private_to): which this call
    // published, and which it kept private because nothing named where they go.
    private_note: [
      ...privateNotes,
      ...(privateKept.length
        ? [`Kept private to you: ${privateKept.map((title) => `"${title}"`).join(', ')} (saved before your first invite). Pass project_id, or scope:"workspace", to share ${privateKept.length === 1 ? 'it' : 'them'}.`]
        : []),
    ].map((line) => ` ${line}`).join(''),
  };
}

// WHERE A BATCH OF ENTITIES WAS FILED, in words: the project by name, or the
// workspace. A reply that only counts ("Upserted 2") left a caller who named no
// project unable to tell which of the two it had chosen (journey r5). A project
// the caller cannot open is not named. Entities the reply filter withheld are
// not described: they are not the caller's to read back.
async function describeEntityFiling(actor, nodes) {
  const homes = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || node.withheld) continue;
    const key = node.project_id || '';
    homes.set(key, (homes.get(key) || 0) + 1);
  }
  const parts = [];
  for (const [projectId, count] of homes) {
    const many = count > 1 ? ` (${count} entities)` : '';
    if (!projectId) {
      parts.push(`Saved at workspace level${many}, not in a project: every member of the workspace can read ${count > 1 ? 'them' : 'it'}.`);
      continue;
    }
    const project = await getProject(actor, projectId).catch(() => null);
    parts.push(project?.project_name
      ? `Filed in "${project.project_name}"${many}.`
      : `Filed in a project you cannot open${many}.`);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

// What a write of resolved decision entities did to the decision log, in words.
// upsertWorkspaceEntities returns it per resolve (decision_resolves) because
// "Upserted 1" over a brief that did not change was the silent success here: a
// clipped title two decisions begin with, a project whose decisions the caller
// may not edit, or a decision that is not in the project named at all. A node
// resolved with no brief entry to match is ordinary (the log caps at 20) and is
// not remarked on. Returned as decision_resolves_note, the words BOTH dispatchers
// append to their reply (hosted: routes/mcp.js; local: POST /workspace/entities),
// in the TEXT only: structuredContent is held to the frozen output schemas.
// The fields of a decision upsert that are NOT its status and would change the
// stored node: each metadata key that differs (the status and its resolve
// bookkeeping aside — those are the status), and a different summary only where
// ANY upsert would write one: store.upsertGraphNode keeps an existing summary of
// 40 characters or more, so claiming that one "applied" would be the lie.
const DECISION_STATUS_METADATA_KEYS = new Set(['status', 'resolved_at', 'resolution_note']);
function nonStatusDecisionChanges(entity, node) {
  const fields = [];
  const summary = String(entity?.summary || '').trim();
  const existingSummary = String(node?.summary || '');
  if (summary && summary !== existingSummary.trim() && existingSummary.length < 40) fields.push('summary');
  const incoming = entity?.metadata && typeof entity.metadata === 'object' ? entity.metadata : {};
  const existing = node?.metadata && typeof node.metadata === 'object' ? node.metadata : {};
  for (const [key, value] of Object.entries(incoming)) {
    if (DECISION_STATUS_METADATA_KEYS.has(key) || value === undefined) continue;
    if (JSON.stringify(value) !== JSON.stringify(existing[key])) fields.push(key);
  }
  return fields;
}

function formatDecisionResolves(outcomes) {
  const done = [];
  const notDone = [];
  // What happened to the stored entity, which belongs to another project: its
  // status is never changed from here, but the rest of the upsert may have been.
  // A workspace-level entity is the whole workspace's: resolving it in one
  // project's log does not resolve it for everybody (scan 30).
  const entityNote = (outcome) => {
    const whose = outcome.workspace_node ? 'is the whole workspace\'s' : 'belongs to another project';
    if (outcome.fields_applied?.length) {
      return `(the stored entity ${whose}, so its status there was left as it is; your ${outcome.fields_applied.join(', ')} change was applied to it)`;
    }
    if (outcome.fields_not_applied?.length) {
      const why = outcome.not_applied_reason === 'other_project'
        ? 'a save from another project records that it is used there and never rewrites it'
        : 'you cannot change that entity';
      return `(the stored entity ${whose} and was left as it is; your ${outcome.fields_not_applied.join(', ')} change was NOT applied, because ${why})`;
    }
    return `(the stored entity ${whose} and was left as it is)`;
  };
  // For the branches whose sentence does not already say what became of it.
  const entityTail = (outcome) => ((outcome.fields_applied?.length || outcome.fields_not_applied?.length) ? ` ${entityNote(outcome)}` : '');
  for (const outcome of Array.isArray(outcomes) ? outcomes : []) {
    const title = `"${outcome.title}"`;
    const where = outcome.project_name || outcome.project_id;
    if (outcome.reopen) {
      if (outcome.failed) notDone.push(`${title} could not be written to the decision log of ${where}, so it is still resolved there${entityTail(outcome)}`);
      else if (outcome.refused) notDone.push(`you cannot edit the decisions of ${where}, so ${title} is still resolved in its brief${entityTail(outcome)}`);
      else if (outcome.reopened?.length) done.push(`Reopened in the decision log of ${where}: ${outcome.reopened.map((summary) => `"${summary}"`).join('; ')} ${entityNote(outcome)}`);
      else if (outcome.already_open) done.push(`${title} was already open in the decision log of ${where}${entityTail(outcome)}`);
      else notDone.push(`${title} is not a resolved decision in ${where}, so nothing was reopened there ${entityNote(outcome)}`);
      continue;
    }
    if (outcome.failed) notDone.push(`${title} could not be written to the decision log of ${where}, so it is still open there${entityTail(outcome)}`);
    else if (outcome.refused) notDone.push(`you cannot edit the decisions of ${where}, so ${title} is still open in its brief${entityTail(outcome)}`);
    else if (outcome.ambiguous?.length) {
      notDone.push(`${title} is cut short and ${outcome.ambiguous.length} open decisions in ${where} begin with it, so none was resolved in its brief (${outcome.ambiguous.slice(0, 5).map((summary) => `"${summary}"`).join('; ')}); resolve with the complete text${entityTail(outcome)}`);
    } else if (outcome.brief_only && outcome.resolved?.length) {
      done.push(`Resolved in the decision log of ${where}: ${outcome.resolved.map((summary) => `"${summary}"`).join('; ')} ${entityNote(outcome)}`);
    } else if (outcome.brief_only && outcome.already_resolved) {
      done.push(`${title} was already resolved in the decision log of ${where}${entityTail(outcome)}`);
    } else if (outcome.brief_only) {
      notDone.push(`${title} is not an open decision in ${where}, so nothing was resolved there ${entityNote(outcome)}`);
    } else if (outcome.node_home && outcome.resolved?.length) {
      // A defaulted resolve the working project's log does not carry went to
      // the project the decision is filed under: named, since it is not the
      // one the caller is working in.
      done.push(`Resolved in the decision log of ${where}, the project this decision is filed under (the project you are working in does not record it): ${outcome.resolved.map((summary) => `"${summary}"`).join('; ')}`);
    } else if (outcome.node_home && outcome.already_resolved) {
      done.push(`${title} was already resolved in the decision log of ${where}, the project this decision is filed under`);
    } else if (outcome.node_home) {
      done.push(`${title} is filed under ${where} (the project you are working in does not record it); its entity there is now resolved`);
    }
  }
  return `${done.length ? ` ${done.join('. ')}.` : ''}${notDone.length ? ` Not resolved in the brief: ${notDone.join('; ')}.` : ''}`;
}

// WHAT A DECISION NODE SAYS, AND WHETHER IT WAS CUT.
//
// Two writers cut a decision node's text, each to its own exact shape:
//   - contextGraphService writes title = clip(summary, 80) and summary =
//     clip(summary, 240); clip() returns exactly limit - 1 characters plus "...".
//   - the store (contextSyncStore.upsertGraphNode, and vault phase 3) caps EVERY
//     summary at 279 characters plus "…", so an auto-promoted or upserted
//     decision over 280 characters keeps its full title and a cut summary.
// Only those exact shapes are a cut; a shorter text ending in "..." is what
// somebody typed. The summary shapes are both checked on the summary (a model
// can copy a listed title into it); the title is only ever cut by the extractor.
//
// The text is the longest one NOT cut: the summary, or — when the summary is the
// store's cut and the title still carries the whole decision — the title. Scan
// 26: reading the store-cut summary as whole made two decisions over 280
// characters sharing their first 279 "one decision", and phase 5 deleted one.
const DECISION_SUMMARY_CLIP = 240;
const DECISION_TITLE_CLIP = 80;
const STORE_SUMMARY_CLIP = 280;
function decisionClipVisible(value, field) {
  const text = String(value || '').trim();
  if (text.length === DECISION_TITLE_CLIP + 2 && text.endsWith('...')) return text.slice(0, -3);
  if (field === 'title') return null;
  if (text.length === DECISION_SUMMARY_CLIP + 2 && text.endsWith('...')) return text.slice(0, -3);
  if (text.length === STORE_SUMMARY_CLIP && text.endsWith('\u2026')) return text.slice(0, -1);
  return null;
}
function decisionNodeText(node) {
  const summary = String(node?.summary || '').trim();
  const title = String(node?.title || '').trim();
  const summaryCut = summary ? decisionClipVisible(summary, 'summary') : null;
  const titleCut = title ? decisionClipVisible(title, 'title') : null;
  if (summary && summaryCut === null) return { text: summary, clipped: false, visible: summary };
  if (title && titleCut === null && (!summary || title.length > summaryCut.length)) {
    return { text: title, clipped: false, visible: title };
  }
  if (summary) {
    // Both cut: the longer visible prefix says the most.
    const visible = titleCut !== null && titleCut.length > summaryCut.length ? titleCut : summaryCut;
    return { text: summary, clipped: true, visible };
  }
  return { text: title, clipped: titleCut !== null, visible: titleCut !== null ? titleCut : title };
}

// The node's FULL text as its canonical key carries it (the extractor slugs the
// unclipped summary: decision:<normalizeKey(summary)>), with a trailing stop
// trimmed — or null when the key is not provably that slug of this node's text
// (a hand-written key, a legacy shape).
//
// A SCOPED COPY'S KEY IS THE SAME SLUG plus `::in.<home>` (scopedEntityKey),
// which is where it lives, not what it says. Compared with the suffix on, no
// scoped decision past the extractor's cut ever matched its own text, so
// resolving one answered "Marked resolved" and left the node — and the
// brief's Knowledge web line — live (scan 33 p97).
function decisionNodeFullKey(node, visible = decisionNodeText(node).visible) {
  const key = unscopedEntityKey(node?.canonical_key);
  if (!key.startsWith('decision:')) return null;
  const body = key.slice('decision:'.length);
  const shown = graphService.normalizeKey(visible);
  if (!shown || !body.startsWith(shown)) return null;
  return body.replace(/[.-]+$/, '');
}

// Is decision-log entry `summary` the decision graph node `node` stands for?
//
// Exact after normalising case and whitespace, against the node's summary or
// its title — but NEVER against a text the extractor clipped. This used to
// accept any decision starting with a clipped title's 79 characters
// ("<prefix>..."), so resolving one of two decisions sharing a long opening
// resolved both (live, and again every night in the vault job), and a decision
// typed with a trailing "..." resolved every longer decision it prefixed. When
// the only full text left is behind a clip, the canonical key — the slug of the
// unclipped summary — decides, and only when it provably is that slug;
// otherwise nothing matches. Never a bare substring either way.
function decisionNodeMatches(summary, node) {
  const norm = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const a = norm(summary);
  if (!a || !node) return false;
  let clippedVisible = '';
  for (const [raw, field] of [[node.summary, 'summary'], [node.title, 'title']]) {
    const text = String(raw || '').trim();
    if (!text) continue;
    const cut = decisionClipVisible(text, field);
    if (cut !== null) {
      if (cut.length > clippedVisible.length) clippedVisible = cut;
      continue;
    }
    if (norm(text) === a) return true;
  }
  if (!clippedVisible) return false;
  const nodeKey = decisionKeyBeyondCut(node, clippedVisible);
  return Boolean(nodeKey) && nodeKey === graphService.normalizeKey(summary).replace(/[.-]+$/, '');
}

// decisionNodeFullKey, but only when the key carries MORE than the cut text: an
// entity upserted under a clipped title ("<79 characters>...") is keyed on the
// slug of that clip, which says nothing about how the decision goes on.
function decisionKeyBeyondCut(node, visible) {
  const nodeKey = decisionNodeFullKey(node, visible);
  if (!nodeKey) return null;
  return nodeKey === graphService.normalizeKey(visible).replace(/[.-]+$/, '') ? null : nodeKey;
}

// THE TEXT A BRIEF SHOWS FOR A DECISION IT CUT: its opening, then "..."
// (clipText, on "Recent decisions" and the Knowledge web) or "…" (a
// headline, on recall(action:"context", sections:["all"])). A caller copies
// that, and the resolve refused it: the dots are no part of any decision, and
// the bare opening was only read when it ran to 80 characters (scan 28).
//
// So a text ending in an ellipsis is also read as the opening it shows, when
// what is left is at least DECISION_SHOWN_MIN characters. That floor sits under
// the tightest cut any brief makes — light verbosity with a reason, 46
// characters with the dots, backed off to a word boundary — so every opening a
// brief prints qualifies. It names a decision only when exactly ONE decision in
// the project begins with it and that one is open: two sharing it is refused,
// naming both (the round-25 rule — a sibling is never resolved by a shared
// opening), and that holds when one of the two is already resolved (scan 29).
const DECISION_SHOWN_MIN = Math.floor((proseBudget('light', 64) - 3) * 0.75);
function decisionShownOpening(value) {
  const text = String(value || '').trim();
  if (!/(\.\.\.|\u2026)$/.test(text)) return null;
  const opening = text.replace(/\s*(\.\.\.|\u2026)$/, '').trim();
  return opening.length >= DECISION_SHOWN_MIN ? opening : null;
}

// Does the decision NODE's full text begin with the opening `title` shows?
// Its text when not cut; when cut, the part still visible or — past that — the
// canonical key, but only a key that provably carries more than the cut
// (decisionKeyBeyondCut). The entity path's reading of a shown cut; the handler
// still resolves only when exactly one candidate is named.
function decisionNodeNamedByOpening(title, node) {
  const opening = decisionShownOpening(title);
  if (!opening || !node) return false;
  const norm = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const { text, clipped, visible } = decisionNodeText(node);
  if (!clipped) return norm(text).startsWith(norm(opening)) && norm(text) !== norm(opening);
  if (norm(visible).startsWith(norm(opening))) return true;
  const nodeKey = decisionKeyBeyondCut(node, visible);
  const slug = graphService.normalizeKey(opening).replace(/[.-]+$/, '');
  return Boolean(nodeKey && slug) && nodeKey.startsWith(slug);
}

// The decision nodes in `projectId` a clipped title can only mean: the ones
// carrying that very title, or whose own text starts with the clip's visible
// part. Only nodes the caller sees whole, the same rule the fuzzy dedup uses —
// a node withheld from them is not theirs to be redirected onto.
async function decisionNodesCarryingCut(actor, ownerKey, projectId, title, cut) {
  const norm = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const prefix = norm(cut);
  if (!prefix) return [];
  const scanned = await store.listGraphNodes(ownerKey, { nodeTypes: ['decision'], projectId, limit: 500 });
  const inProject = scanned.filter((node) => node.project_id === projectId);
  const readCopies = new Map((await visibleGraphNodesForActor(actor, ownerKey, inProject)).map((node) => [node.node_id, node]));
  return inProject
    .filter((node) => readCopies.get(node.node_id) === node)
    .filter((node) => norm(node.title) === norm(title) || norm(decisionNodeText(node).visible).startsWith(prefix));
}

// WHICH OPEN DECISIONS A RESOLVED DECISION NODE STANDS FOR — the one rule the
// live propagation (upsertWorkspaceEntities), nightly phase 6 and an explicit
// resolve all use.
//
//   { indexes }   the entries to resolve: every open entry decisionNodeMatches
//                 (duplicates of one text are one decision);
//   { ambiguous } nothing resolved, and the decisions that made it a guess.
//
// A node whose every text is cut and whose key carries no more than the cut —
// what an upsert of a title copied from recall(action:"entities") stores — can
// only be read by its prefix. That prefix resolves a decision only when exactly
// ONE open decision starts with it: two decisions sharing a long opening are
// never both resolved (scan 25), and neither is picked (scan 26: the upsert
// answered "saved" while the brief stayed open, the node a stray duplicate).
// `eligible` narrows the open entries (phase 6: nothing newer than the resolve).
function decisionsResolvedBy(decisions, node, { eligible = () => true } = {}) {
  const norm = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const open = (Array.isArray(decisions) ? decisions : [])
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry && !entry.resolved && eligible(entry));
  const exact = open.filter(({ entry }) => decisionNodeMatches(entry.summary, node));
  if (exact.length) return { indexes: exact.map(({ index }) => index), ambiguous: [] };
  const { clipped, visible } = decisionNodeText(node);
  const prefix = norm(visible);
  if (!clipped || !prefix || decisionKeyBeyondCut(node, visible)) return { indexes: [], ambiguous: [] };
  const starts = open.filter(({ entry }) => norm(entry.summary).startsWith(prefix));
  if (starts.length === 1) return { indexes: [starts[0].index], ambiguous: [] };
  return { indexes: [], ambiguous: starts.map(({ entry }) => entry.summary) };
}

// The rows a graph WRITE hands back, as the writer may read them.
//
// A write answers with the stored row, and the stored row is the MERGE of what
// the caller sent with what was already there. The gates in front of these
// writes refuse a node the caller cannot see, or sees only in part, so a merge
// should never carry anything hidden — but this is the last line, and the reply
// is where it leaked before (a PATCH and an upsert of a shared project's root
// both returned its withheld description and stack). So every returned row goes
// through the read filter.
//
// A row the filter HIDES is still counted: the caller wrote it (a decision filed
// under a project whose share withholds decisions lands, and is then not theirs
// to read), and a reply that dropped it would count one fewer save than
// happened. It comes back as a stub naming what the caller supplied — its id,
// type, key and title — and none of the stored content.
async function echoGraphNodesForActor(actor, ownerKey, nodes) {
  if (!Array.isArray(nodes) || !nodes.length) return nodes || [];
  let readable;
  try {
    readable = new Map((await visibleGraphNodesForActor(actor, ownerKey, nodes)).map((node) => [node.node_id, node]));
  } catch (err) {
    console.warn('[GRAPH] write-reply filter failed; returning stubs:', err.message);
    readable = new Map();
  }
  return nodes.map((node) => readable.get(node.node_id) || {
    node_id: node.node_id,
    node_type: node.node_type,
    canonical_key: node.canonical_key,
    project_id: node.project_id || null,
    title: node.title,
    summary: '',
    metadata: {},
    withheld: true,
  });
}

// A SELECTION IS A COUNTER, NOT A WRITE OF THE NODE.
//
// Every brief load, /active and GET /workspace/entities records which nodes it
// selected. It did that by upserting the node it had IN HAND — and since round
// 19 the node in hand is the READER'S copy: a teammate reads a shared project's
// root with the withheld description/status/task blanked. upsertGraphNode takes
// the incoming summary whenever the stored one is under 40 characters, so the
// first teammate to load the brief wrote '' over a short root summary, for
// everybody, the author included. It also rewrote title, source_session_id and
// source_tool from the same copy.
//
// So selection now reads the STORED rows by id and updates only what selection
// owns — retrieval_hits, last_selected_at, the candidate->durable promotion,
// confidence (raise-only) and last_seen_at — through store.recordGraphNodeSelections,
// which never touches title, summary or any other metadata key. The nodes passed
// in are used for their ids and nothing else.
async function trackWorkspaceSelections(actor, nodes = [], options = {}) {
  const ownerKey = getActorKey(actor);
  const selectedAt = options.selected_at || isoNow();
  const ids = [...new Set((nodes || []).map((node) => node?.node_id).filter(Boolean))];
  if (!ids.length) return [];
  const stored = await store.listGraphNodesByIds(ownerKey, ids);
  const selections = stored.map((row) => {
    const existingMeta = row.metadata || {};
    const patch = {
      retrieval_hits: Math.max(0, Number(existingMeta.retrieval_hits || 0)) + 1,
      last_selected_at: selectedAt,
    };
    if (shouldPromoteCandidateMetadata({
      ...existingMeta,
      ...patch,
      memory_tier: existingMeta.memory_tier || 'candidate',
    })) {
      patch.memory_tier = 'durable';
      patch.curation_state = 'promoted';
      patch.promoted_at = existingMeta.promoted_at || selectedAt;
    }
    // A node that gets retrieved and used is empirically more trustworthy — nudge
    // confidence up slightly (raise-only: the store takes the GREATEST).
    return {
      node_id: row.node_id,
      metadata: patch,
      confidence: Math.min(0.97, Number(row.confidence || 0.7) + 0.02),
    };
  });
  return store.recordGraphNodeSelections(ownerKey, selections, selectedAt);
}

async function findWorkspaceNodeByCanonicalKey(ownerKey, canonicalKey) {
  const [nodeType] = String(canonicalKey || '').split(':');
  if (!nodeType) return null;
  return store.getGraphNodeByCanonicalKey(ownerKey, workspaceNodeType(nodeType), canonicalKey);
}

// ─── ONE LANDING RULE FOR EVERY GRAPH WRITE (scan 32) ───────────────────────
//
// Graph nodes are unique on (owner_key, node_type, canonical_key) and owner_key
// is the WORKSPACE, while who may READ a node is decided per project and per
// evidence row (nodeVisibleIn). So any write that lands on an existing row by
// its plain key can cross a privacy boundary: the extraction rebuild added
// evidence in the team project to a member's PERSONAL "Redis" and so published
// it to the team (scan 32 p84); a save merged into a colleague's private row it
// could read but not write, or was refused over it (p87); a colleague's scoped
// node was taken for the caller's own (p89). Round 31 fixed one door.
//
// Every graph write now asks landGraphWrite where it lands. A write for HOME H
// (a project id, or null for workspace-level) lands on the plain-key row only
// when that row is H's, or is workspace-level and the writer may change it —
// and never on a row marked private to someone else (nodePrivateToOther).
// Otherwise it lands on the writer's own node for H, keyed `<key>::in.<H>`
// (`::in.workspace` for workspace level): found if it exists, else created. The
// separator cannot come out of normalizeKey on a title, so no title-derived key
// collides with one; a key read back from recall round-trips unchanged. The
// lookup of "the writer's own node" matches ONLY the key for H: a colleague's
// scoped node elsewhere is somebody else's row, judged like any other.
//
// `elsewhere` is rule 2 of upsertWorkspaceEntities (an existing node keeps its
// home; the save records a sighting, which grants nobody anything): an explicit
// save may still land on a row homed in another project when the writer may
// both read and change it — their own node, or a team node their share lets
// them edit. The rebuild (`derived`) never does: its evidence IS a read grant
// (nodeVisibleIn: a homed node is read wherever it was seen), and who reads a
// project is a switch its author flips at will. Round 33 let the rebuild land
// on a row homed in another of the writer's own projects "with the same
// readers", judged once, at write time: the member then shared one of the two
// and published the other's hand-written note and name to the team (scan 34
// a/F1, b/p103, p103c), and taking one private, or moving it out, did the same
// the other way. Nothing re-judges a landing when a visibility changes, so the
// only safe landing is one that no later visibility change can turn into a
// grant: H's own row, or a workspace-level one (whose evidence grants and
// narrows nothing). One person's projects therefore keep one node EACH for an
// entity they share; the portfolio groups those copies by their plain key
// (portfolioService) to still count it as cross-project (scan 33 p98/p101).
//
// A ROW PRIVATE TO THE WRITER (metadata.private_to — their pre-team notes) is
// theirs, but a write to it can publish it:
//   - the writer's own `<key>::in.<H>` node wins over it (scan 33 p95): the
//     rebuild made that copy the first time H's context named the entity, and a
//     save in H that adopted the private row instead left H holding both;
//   - the rebuild lands on it only when H is read by the writer alone (their
//     own personal project) — anywhere else the rebuild never publishes, and
//     writes their scoped copy for H. Unlike a row homed in another project,
//     this stays safe when H is shared later: the mark, not the evidence,
//     decides who reads the row (nodePrivateToOther);
//   - a person's own save (`ownPrivate`) lands on it, and upsertWorkspaceEntities
//     decides whether that save is the author publishing it (round 32).
//
// A workspace nobody else can have work in (landing.scope null) has one reader,
// so the plain key is the identity and the portfolio's cross-project node is
// one node, as it always was.
const SCOPED_KEY_MARK = '::in.';
// A SCOPED KEY IS BOUNDED (scan 36 b/p119). Canonical keys are slugs of the
// entity's whole text, so a decision filed as a multi-KB `manage_memory update`
// summary has a key near the unique index's 2704-byte tuple cap, and the
// scoped copy's `::in.<project>` pushed it over: the first-invite split threw
// inside the invite's transaction, and every retry of the invite failed the
// same way. A long base is cut to a prefix plus a hash of the whole
// (workspaceService.boundedKeyBase, the one definition; its SQL twin builds the
// split's and the portfolio's keys).
const { boundedKeyBase } = workspace;
function scopedEntityKey(key, projectId) {
  return `${boundedKeyBase(key)}${SCOPED_KEY_MARK}${projectId || 'workspace'}`;
}
// The plain key a scoped one was made from — as written: a bounded base is its
// cut form (see boundedKeyBase).
function unscopedEntityKey(key) {
  return String(key || '').split(SCOPED_KEY_MARK)[0];
}
// What a plain key and every scoped copy of it share, for grouping or naming
// them as one entity: the bounded base, which a long plain key and its copies
// both reduce to.
function entityGroupKey(key) {
  return boundedKeyBase(unscopedEntityKey(key));
}

// The rebuild's landing (recordGraphArtifacts `land`): every entity derived from
// `projectId`'s context is written for that project. Nothing may be merged into
// a row homed in any other project, or into a row marked private to anyone else
// — the rebuild's evidence would make it readable to this project's readers,
// today's or whoever reads it after its next visibility change (scan 34). Null
// for a workspace nobody else can have work in.
async function graphRebuildLanding(actor, ownerKey, projectId) {
  const landing = await graphLandingForActor(actor, ownerKey);
  if (!landing.scope) return null;
  // Asked at most once per rebuild, and only when a private row is in play.
  let home;
  const onlyWriterReads = async () => {
    if (!projectId) return false;
    if (home === undefined) home = (await store.listProjectReaders(ownerKey, [projectId]))[0] || null;
    return Boolean(home) && home.visibility === 'personal' && Boolean(home.owner_user_id)
      && landing.identities.includes(String(home.owner_user_id));
  };
  return (entity) => landGraphWrite(ownerKey, landing, {
    nodeType: entity.node_type,
    key: entity.canonical_key,
    home: projectId,
    derived: { onlyWriterReads },
  });
}

// A rebuild that landed as one person's (graphRebuildLanding null) may have
// raced the first invite: once its writes are in, it waits for any membership
// change in flight and, if the workspace is no longer one person's, splits what
// it landed (workspaceService.settleSoloEraLandings, scan 36 a/p3). The
// workspace is re-read from the store, never the per-request memo, which still
// holds the answer this rebuild started with. Never fails the write it follows:
// reported instead, since a split that did not run is a privacy state.
async function settleSoloEraLandings(actor, ownerKey) {
  if (!ownerKey || !actor) return;
  const identities = workspace.actorIdentities(actor);
  await workspace.settleSoloEraLandings(
    ownerKey,
    async () => !(await store.workspaceMayHoldOthersWork(ownerKey, identities))
  ).catch((err) => reportSwallowed(err, {
    op: 'settle_solo_era_landings_failed',
    meta: { owner_key: ownerKey },
  }));
}

// What landGraphWrite needs to know about the writer, asked once per call.
async function graphLandingForActor(actor, ownerKey) {
  if (!actor) return { scope: null, identities: [] };
  const scope = await graphScopeForActor(actor, ownerKey);
  return { scope, identities: workspace.actorIdentities(actor) };
}

function nodePrivateToWriter(node, landing) {
  const owner = node?.metadata?.private_to;
  return Boolean(owner) && (landing?.identities || []).includes(String(owner));
}

// Returns { node, key, scoped }: the existing row the write lands on (null for
// a new one) and the canonical key it is written under.
//   canSee(node) / canWrite(node): may this writer read / change this row;
//   elsewhere: may land on a readable, changeable row homed in another project;
//   ownPrivate: a row private to the writer is theirs to land on (a person's
//     own save);
//   derived: the rebuild's { onlyWriterReads() } — see the rule above.
async function landGraphWrite(ownerKey, landing, {
  nodeType, key, home = null, plain, canSee = async () => true, canWrite = async () => true,
  elsewhere = false, ownPrivate = false, derived = null,
}) {
  const find = (canonicalKey) => store.getGraphNodeByCanonicalKey(ownerKey, workspaceNodeType(nodeType), canonicalKey);
  const row = plain === undefined ? await find(key) : plain;
  // A key that is already a scoped one names that exact node (a key read back
  // from recall); the caller's gates judge it like any row.
  if (nodeType === 'project' || !landing?.scope || String(key).includes(SCOPED_KEY_MARK)) {
    return { node: row || null, key, scoped: false };
  }
  const ownKey = scopedEntityKey(key, home);
  let own;
  const findOwn = async () => {
    if (own === undefined) own = (await find(ownKey)) || null;
    return own;
  };
  let reachable = false;
  if (row) {
    const mine = nodePrivateToWriter(row, landing);
    if (mine && await findOwn()) return { node: own, key: ownKey, scoped: true };
    const privateOk = !row.metadata?.private_to
      || (mine && (ownPrivate || Boolean(derived && await derived.onlyWriterReads())));
    reachable = privateOk && await canSee(row);
    if (reachable) {
      if (row.project_id && row.project_id === (home || null)) return { node: row, key, scoped: false };
      if (!row.project_id && await canWrite(row)) return { node: row, key, scoped: false };
    }
  }
  if (await findOwn()) return { node: own, key: ownKey, scoped: true };
  if (!row) return { node: null, key, scoped: false };
  if (elsewhere && reachable && row.project_id && await canWrite(row)) return { node: row, key, scoped: false };
  return { node: null, key: ownKey, scoped: true };
}

function classifyWorkspaceNodes(nodes) {
  const knowledgeTypes = new Set(['knowledge', 'decision', 'question', 'preference', 'concept']);
  const toolTypes = new Set(['tool', 'environment', 'service', 'database', 'repo']);
  const capabilityTypes = new Set(['capability', 'workflow', 'feature', 'task']);

  return {
    knowledge: nodes.filter((node) => knowledgeTypes.has(node.node_type)),
    tools: nodes.filter((node) => toolTypes.has(node.node_type)),
    capabilities: nodes.filter((node) => capabilityTypes.has(node.node_type)),
  };
}

function freshnessLabelFromIso(iso) {
  if (!iso) return 'stale';
  const ageMs = Math.max(0, Date.now() - new Date(iso).getTime());
  if (ageMs <= 24 * 60 * 60 * 1000) return 'live';
  if (ageMs <= 7 * 24 * 60 * 60 * 1000) return 'recent';
  return 'stale';
}

function buildPassiveEnrichments({ activeProject, rankedNodes, globalContext, projects }) {
  const items = [];

  for (const node of rankedNodes || []) {
    const sourceKind = String(node?.metadata?.source_kind || '').toLowerCase();
    if (sourceKind !== 'imported' && sourceKind !== 'inferred') continue;

    const projectScoped = activeProject?.project_id && node.project_id === activeProject.project_id;
    const confidence = Math.min(0.99, Number(node._ranking_score || 0.5) / 1.5);
    items.push({
      source: String(node.metadata?.source_label || node.metadata?.integration_key || node.metadata?.source || sourceKind || 'imported context'),
      title: node.title,
      summary: node.summary || node.title,
      source_kind: sourceKind === 'inferred' ? 'inferred' : 'imported',
      confidence,
      freshness: freshnessLabelFromIso(node.last_seen_at || node.updated_at || node.created_at),
      selected: Boolean(projectScoped || confidence >= 0.68),
      workspace_link_reason: projectScoped
        ? 'Linked directly to the active project.'
        : 'Selected because relevance and recency cleared the enrichment threshold.',
    });
  }

  if (globalContext?.user_profile || (globalContext?.preferences || []).length) {
    items.push({
      source: 'global context',
      title: 'User profile and working preferences',
      summary: [
        globalContext.user_profile,
        (globalContext.preferences || []).slice(0, 2).join(' | '),
      ].filter(Boolean).join(' — '),
      source_kind: 'global',
      confidence: 0.81,
      freshness: 'recent',
      selected: true,
      workspace_link_reason: 'Strengthens packaging across every connected surface.',
    });
  }

  for (const project of (projects || []).slice(0, 3)) {
    if (!project?.project_id || project.project_id === activeProject?.project_id) continue;
    if (!project.context?.current_task && !project.context?.current_status) continue;
    items.push({
      source: 'ambient workspace',
      title: project.project_name,
      summary: project.context.current_task || project.context.current_status,
      source_kind: 'ambient',
      confidence: 0.58,
      freshness: freshnessLabelFromIso(project.updated_at),
      selected: false,
      workspace_link_reason: 'Recent adjacent project context kept available for cross-project continuity.',
    });
  }

  const deduped = new Map();
  for (const item of items) {
    const key = `${item.source_kind}:${normalizeText(item.title)}`;
    if (!deduped.has(key) || (deduped.get(key).selected === false && item.selected === true)) {
      deduped.set(key, item);
    }
  }

  return Array.from(deduped.values())
    .sort((left, right) => Number(right.selected) - Number(left.selected) || right.confidence - left.confidence)
    .slice(0, 8);
}

function buildCurrentUnderstanding({ activeProject, knowledge, tools, capabilities, passiveEnrichments }) {
  const recentDecisions = (activeProject?.context?.recent_decisions || [])
    .filter((entry) => typeof entry === 'string' || !entry?.resolved)
    .slice(-3)
    .map((entry) => typeof entry === 'string' ? entry : entry?.summary)
    .filter(Boolean);
  const openQuestions = (activeProject?.context?.open_questions || [])
    .slice(0, 3)
    .filter(Boolean);
  const hotPaths = (activeProject?.context?.hot_paths || [])
    .slice(0, 3)
    .map((entry) => entry.path)
    .filter(Boolean);
  const supportingEvidence = [
    activeProject?.context?.source_summary || '',
    ...knowledge.slice(0, 2).map((node) => node.summary || node.title),
    ...capabilities.slice(0, 1).map((node) => node.summary || node.title),
  ].filter(Boolean).slice(0, 4);
  const relatedEntities = [
    ...knowledge.slice(0, 3).map((node) => node.title),
    ...tools.slice(0, 2).map((node) => node.title),
    ...capabilities.slice(0, 2).map((node) => node.title),
  ].filter(Boolean).slice(0, 6);
  const relevantEnrichments = passiveEnrichments.filter((item) => item.selected).slice(0, 4);

  const confidenceParts = [];
  if (activeProject?.context?.current_task) confidenceParts.push('direct task is set');
  if (recentDecisions.length) confidenceParts.push(`${recentDecisions.length} recent decisions captured`);
  if (openQuestions.length) confidenceParts.push(`${openQuestions.length} open questions need attention`);
  if (relevantEnrichments.length) confidenceParts.push(`${relevantEnrichments.length} enrichments survived ranking`);
  if (hotPaths.length) confidenceParts.push(`${hotPaths.length} hot paths are available`);

  return {
    workspace_label: activeProject?.project_name || 'Current workspace',
    active_project_id: activeProject?.project_id || null,
    active_project_name: activeProject?.project_name || null,
    current_task: activeProject?.context?.current_task || '',
    current_status: activeProject?.context?.current_status || '',
    recent_decisions: recentDecisions,
    open_questions: openQuestions,
    hot_paths: hotPaths,
    supporting_evidence: supportingEvidence,
    related_entities: relatedEntities,
    relevant_enrichments: relevantEnrichments,
    confidence_summary: confidenceParts.length
      ? `High confidence because ${confidenceParts.join(', ')}.`
      : 'Low confidence because direct project signals are still sparse.',
  };
}

function buildSelectionExplanations({ activeProject, knowledge, tools, capabilities, passiveEnrichments }) {
  const items = [];

  if (activeProject?.context?.current_task) {
    items.push({
      kind: 'project_context',
      label: activeProject.context.current_task,
      reason: 'Direct task state outranks archival or ambient context.',
      score: 1.2,
      selected: true,
      source: 'active_project',
    });
  }

  for (const node of [...knowledge, ...capabilities, ...tools].slice(0, 3)) {
    items.push({
      kind: 'entity',
      label: node.title,
      reason: node.project_id && node.project_id === activeProject?.project_id
        ? 'Selected because it is project-scoped and ranked highly for the current task.'
        : 'Selected because importance, relevance, and freshness outweighed broader workspace memory.',
      score: Math.min(1.99, Number(node._ranking_score || 0.5)),
      selected: true,
      source: String(node.metadata?.entity_type || node.node_type || 'entity'),
    });
  }

  for (const enrichment of passiveEnrichments.filter((item) => item.selected).slice(0, 2)) {
    items.push({
      kind: 'enrichment',
      label: enrichment.title,
      reason: enrichment.workspace_link_reason,
      score: Math.min(1.99, enrichment.confidence),
      selected: true,
      source: enrichment.source,
    });
  }

  return items.slice(0, 6);
}

function buildRuntimeLayers({ projects, sessions, knowledge, tools, capabilities, activeProject, passiveEnrichments, selectionExplanations }) {
  const directHighlights = [];
  if (activeProject?.context?.current_task) {
    directHighlights.push(`${activeProject.project_name}: ${activeProject.context.current_task}`);
  }
  const activeDecisions = (activeProject?.context?.recent_decisions || [])
    .filter((d) => typeof d === 'string' || !d?.resolved);
  if (activeDecisions.length) {
    const latestDecision = activeDecisions[activeDecisions.length - 1];
    const summary = typeof latestDecision === 'string' ? latestDecision : latestDecision?.summary;
    if (summary) directHighlights.push(`Recent decision: ${summary}`);
  }
  if (activeProject?.context?.hot_paths?.length) {
    directHighlights.push(`Hot path: ${activeProject.context.hot_paths[0].path}`);
  }

  const importedNodes = passiveEnrichments.filter((item) => ['imported', 'global', 'ambient'].includes(String(item.source_kind || '').toLowerCase()));
  const inferredNodes = [...knowledge, ...tools, ...capabilities]
    .filter((node) => String(node?.metadata?.source_kind || '').toLowerCase() === 'inferred'
      || String(node?.metadata?.curation_state || '').toLowerCase() === 'inferred');

  const passiveHighlights = passiveEnrichments
    .filter((item) => item.selected)
    .slice(0, 2)
    .map((item) => `${item.title}: ${item.summary}`);
  if (passiveHighlights.length === 0) passiveHighlights.push('No imported enrichments selected yet.');

  const intelligenceHighlights = [];
  if (selectionExplanations[0]) intelligenceHighlights.push(`Selected ${selectionExplanations[0].label} because ${selectionExplanations[0].reason.toLowerCase()}`);
  if (inferredNodes[0]) intelligenceHighlights.push(`Inferred ${inferredNodes[0].title} from project structure and recent activity.`);
  if (intelligenceHighlights.length === 0) intelligenceHighlights.push('Ranking active-task context ahead of archival memory.');

  return {
    direct_context: {
      id: 'direct_context',
      title: 'Direct context',
      summary: 'Current work from MCP, active projects, tasks, recent decisions, and current codebase signals.',
      status: directHighlights.length ? 'active' : 'warming',
      input_count: Math.max(projects.length + sessions.length, 0),
      selected_count: Math.min(directHighlights.length || (activeProject ? 1 : 0), Math.max(projects.length + sessions.length, 1)),
      highlights: directHighlights.length ? directHighlights : ['No active workspace summary yet.'],
    },
    passive_enrichment: {
      id: 'passive_enrichment',
      title: 'Passive enrichment',
      summary: 'Imported notes, docs, and ambient signals quietly strengthening the current workspace understanding.',
      status: importedNodes.length ? 'active' : 'warming',
      input_count: passiveEnrichments.length,
      selected_count: passiveEnrichments.filter((item) => item.selected).length,
      highlights: passiveHighlights,
    },
    intelligence: {
      id: 'intelligence',
      title: 'Intelligence layer',
      summary: 'Ranking, deduplication, compression, workspace linking, and packaging deciding what survives.',
      status: (knowledge.length || tools.length || capabilities.length) ? 'active' : 'limited',
      input_count: knowledge.length + tools.length + capabilities.length + passiveEnrichments.length,
      selected_count: selectionExplanations.length,
      highlights: intelligenceHighlights,
    },
  };
}

async function resolveActiveWorkspaceContext(actor, options = {}) {
  const projects = await listProjects(actor);
  const sessions = await listSessions(actor).catch(() => []);
  const projectById = new Map(projects.map((project) => [project.project_id, project]));
  const activeSession = options.project_id
    ? sessions.find((session) => session.project_id === options.project_id)
    : sessions.find((session) => {
        if (options.cwd && session.cwd) return session.cwd === options.cwd;
        if (options.tool && session.tool) return session.tool === options.tool && session.project_id;
        return session.project_id;
      }) || sessions[0] || null;
  const activeProject = options.project_id
    ? projectById.get(options.project_id) || null
    : (activeSession?.project_id ? projectById.get(activeSession.project_id) : null) || projects[0] || null;

  return { projects, sessions, activeSession, activeProject };
}

// GRAPH NODES INHERIT THE VISIBILITY OF THE PROJECTS THEY WERE SEEN IN.
//
// Project ROWS have been visibility-filtered since the sharing work
// (visibilityClause in the store), but entities are auto-promoted OUT of project
// content — a client, a vendor, a decision — and the graph was not filtered at
// all. So a colleague's `personal` project stayed hidden while everything
// learned from it surfaced in everybody else's workspace entities, brief
// knowledge section, recall results and portfolio. Hiding the container and
// publishing its contents is not a smaller leak than publishing the container.
//
// A node is visible when ANY project it has been seen in is visible, and hidden
// only when every one of them is hidden. Cross-project membership is NOT in the
// node row — it keeps the FIRST project it was seen in — so the sightings come
// from context_graph_evidence (see store.listGraphNodeProjectIds and
// portfolio-cross-project-evidence). A node attached to no project at all is
// workspace-scoped by construction and stays visible.
//
// Two owner-scoped queries, and only in a workspace where something could be
// somebody else's: a solo account — nearly every account — pays the one cheap
// check in visibleProjectIdsForActor and nothing more.

// The set of project ids this actor may see, or NULL for "unrestricted". Split
// out of visibleGraphNodesForActor unchanged, because the endpoint gates below
// need the same answer about a project, a session and an aggregate, not only
// about a list of nodes.
//
// Null is the answer for a system actor, an internal actor (a job or script, with
// no person behind it — the same carve-out visibilityClause makes) and, crucially,
// for a workspace where nothing can be anybody else's. Callers must read null as
// "no filtering", never as "nothing is visible": inverting that empties the graph
// for every solo user, which is nearly every user.
//
// "Nothing can be anybody else's" is decided on the DATA, not on today's member
// count. It used to be `!isSharedWorkspace`, so when a two-person team shrank to
// one the filter switched itself off and the remaining owner read the departed
// member's personal activity: audit rows (deleted project names included) and
// graph nodes in /graph/export. See store.workspaceMayHoldOthersWork.
async function visibilityForActor(actor, ownerKey) {
  // 'org-system' is the shared dev key's workspace: the same system carve-out
  // actorVisibilityScope makes. It was reached before only because that
  // workspace has no roster; now that the check reads the data, say it.
  if (actor?.type === 'system' || ownerKey === 'org-system') return null;
  const identities = workspace.actorIdentities(actor);
  if (!identities.length) return null;
  if (!(await workspaceMayHoldOthersWork(actor, ownerKey, identities))) return null;
  const isWorkspaceOwner = (await workspace.resolveRole(actor, ownerKey).catch(() => null)) === 'owner';
  const visible = new Set(await store.listVisibleProjectIds(ownerKey, { actorIdentities: identities, isWorkspaceOwner }));
  return { visible, isWorkspaceOwner, identities };
}

async function visibleProjectIdsForActor(actor, ownerKey) {
  return (await visibilityForActor(actor, ownerKey))?.visible || null;
}

// What GET /audit needs beyond the visible set: which projects still EXIST in
// this workspace, and which recorded visibilities this reader may see.
//
// A row about a project that is gone — deleted, or moved to another workspace —
// cannot be judged by the project's readability NOW, because there is no
// project. Judging it that way (as #522 did) hid a shared project's deletion
// from the whole team: only the person who deleted it could see that it had
// happened. So project_deleted and project_moved_out record the project's
// visibility AT THE TIME in metadata.visibility, and such a row is shown to
// whoever could have read the project then: anyone for 'shared', owners too for
// 'private', and only its author for 'personal' (the author is the actor, which
// the self-rule already covers). A row with no recorded visibility predates
// this and stays with the person who wrote it.
//
// Null, like visibleProjectIdsForActor: nothing to filter.
async function auditScopeForActor(actor, ownerKey) {
  const scope = await visibilityForActor(actor, ownerKey);
  if (!scope) return null;
  const existing = new Set(await store.listVisibleProjectIds(ownerKey, { system: true }));
  return {
    visible: scope.visible,
    existing,
    recordedVisibilities: scope.isWorkspaceOwner ? ['shared', 'private'] : ['shared'],
  };
}

// ─── THE SECTION POLICY APPLIES TO THE GRAPH TOO ────────────────────────────
//
// Everything above judged a node by whether its PROJECT is visible, and stopped
// there. A shared project's share policy narrows which SECTIONS travel, and the
// brief honoured it — "Not shared with you: decisions" — while the line directly
// under it, the Knowledge web, printed the withheld decision verbatim, because
// deriveEntities mirrors recent_decisions into `decision` nodes and nothing on
// the graph side ever asked the policy. The same node reached a teammate through
// /graph/*, both exports, the Trail (and so into their own workspace on import),
// workspace/entities and recall.
//
// So a project this actor reads only THROUGH A SHARE — shared, not theirs — is
// "restricted", and a node counts as seen there only if its type's section is in
// the sections that share grants. The rule for who is restricted is the one
// projectViewForActor uses for the context itself: the author and readers of a
// non-shared project (a workspace owner on `private` work) see everything; a
// teammate, workspace owner included, reads a shared project through its policy.
//
// NODE TYPE -> SECTION. Derived from what writes each type: deriveEntities
// (graph extraction) and promoteDeltaEntities (workspace promotion) above.
//
//   decision               <- recent_decisions
//   question               <- open_questions
//   task                   <- current_task
//   file, component        <- file_structure_summary
//   capability             <- file_structure_summary (inferred from file paths)
//   service, tool, environment, database, repo  <- tech_stack
//   preference             <- recurring_context
//   knowledge, when the extraction promoted it (metadata.auto_promoted) from
//                             description or source_summary: that section
//                             (metadata.source_section, stamped since this
//                             change), or BOTH when an older row does not say
//   capability, when inferred from a file path  <- file_structure_summary
//   project (the root)     kept — its title is the project name the reader can
//                          already see — but its summary (description, status
//                          or task) and metadata.tech_stack are blanked unless
//                          every section they can come from is granted.
//
// Everything else — knowledge and capabilities a person wrote with
// upsert_entities, concept, pattern, workflow, feature, note, any type a caller
// invents — was not derived from a section, so no section can speak for it. It
// travels at the DEFAULT level of sharing and no further down: visible while the
// share grants at least every default section (an unconfigured share, or one the
// author widened), hidden the moment the author narrows the share below the
// defaults. An author who withholds even one default section has said this
// project is sensitive, and an entity no section governs is the thing we can
// least vouch for; a team whose author never narrowed anything keeps the shared
// memory the team product is for.
//
// Evidence is the RAW TRANSCRIPT the nodes were extracted from — any section's
// text can be in it — so evidence recorded in a restricted project travels only
// when that share grants every section, whatever node it hangs off.
//
// A solo account never reaches any of this: visibilityForActor answers null and
// every function below returns its input untouched.
const GRAPH_NODE_SECTIONS = {
  decision: ['recent_decisions'],
  question: ['open_questions'],
  task: ['current_task'],
  file: ['file_structure_summary'],
  component: ['file_structure_summary'],
  capability: ['file_structure_summary'],
  service: ['tech_stack'],
  tool: ['tech_stack'],
  environment: ['tech_stack'],
  database: ['tech_stack'],
  repo: ['tech_stack'],
  preference: ['recurring_context'],
};
const PROJECT_ROOT_SUMMARY_SECTIONS = ['description', 'current_status', 'current_task'];

const KNOWLEDGE_SOURCE_SECTIONS = ['description', 'source_summary'];

function sharesEverySection(allowed) {
  return SHAREABLE_SECTIONS.every((section) => allowed.has(section));
}

function sharesDefaultSections(allowed) {
  return DEFAULT_SHARED_SECTIONS.every((section) => allowed.has(section));
}

// A NODE A STRUCTURED EVENT WROTE BELONGS TO THE SECTION THE EVENT WROTE.
//
// applyStructuredContextEvent promotes three events into nodes whose TYPE says
// nothing about where they came from: command_confirmed becomes a `workflow`
// (carrying the full run line), a blocker a `knowledge` node, a file change
// another. Those types map to no section, so they travelled at default-share
// level — a command's run line reached every teammate on a share that never
// includes `commands`. The event is recorded on the node (metadata.event_type),
// so the node is governed by the section its event writes. Checked first, and
// in the ONE mapping the read filter and the edit gate share.
const EVENT_NODE_SECTIONS = {
  command_confirmed: ['commands'],
  blocker_opened: ['blocking_issue'],
  blocker_resolved: ['blocking_issue'],
  file_changed: ['file_structure_summary'],
};

// WHICH EVENT WROTE A NODE IS THE SERVER'S TO SAY. `source` and `event_type`
// decide the section a node is governed by (EVENT_NODE_SECTIONS), so a caller
// who could set them could file a node under whichever section their share
// grants: POST /graph/nodes judged a `service` as a file_changed event node,
// passed it, and then stored source:'manual' — a node its writer could not read
// back. They are stripped from caller metadata at every door (POST /graph/nodes,
// upsertWorkspaceEntities unless the server itself is writing), so a stored
// source:'structured_context_event' is always the server's own.
// private_to is the server's too: it hides a node from everyone but one person
// (nodeVisibleIn), so a caller who could set it could take a team node out of
// every colleague's view by re-saving it.
const SERVER_ONLY_NODE_METADATA = ['source', 'event_type', 'private_to'];
function stripServerOnlyNodeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const rest = { ...metadata };
  for (const key of SERVER_ONLY_NODE_METADATA) delete rest[key];
  return rest;
}

// The sections one type needs, or null when no section governs it.
function sectionsForGraphType(type, metadata = {}) {
  if (metadata?.source === 'structured_context_event' && EVENT_NODE_SECTIONS[metadata.event_type]) {
    return EVENT_NODE_SECTIONS[metadata.event_type];
  }
  if (GRAPH_NODE_SECTIONS[type]) return GRAPH_NODE_SECTIONS[type];
  if (type === 'knowledge' && metadata.auto_promoted) {
    return KNOWLEDGE_SOURCE_SECTIONS.includes(metadata.source_section)
      ? [metadata.source_section]
      : KNOWLEDGE_SOURCE_SECTIONS;
  }
  if (type === 'capability' && (metadata.inferred_from_path || metadata.source_kind === 'inferred')) {
    return ['file_structure_summary'];
  }
  return null;
}

// The sections one node needs. A node carries its type twice (node_type and,
// for workspace entities, metadata.entity_type); both are judged, so a label
// cannot launder a type past its section. Null when neither maps to a section.
function graphNodeSectionsNeeded(node) {
  const metadata = node?.metadata || {};
  const types = [...new Set([node?.node_type, metadata.entity_type].filter(Boolean).map(String))];
  const needed = new Set();
  let unmapped = false;
  for (const type of types) {
    const sections = sectionsForGraphType(type, metadata);
    if (!sections) { unmapped = true; continue; }
    for (const section of sections) needed.add(section);
  }
  return { sections: [...needed], unmapped: unmapped || types.length === 0 };
}

// May this actor see THIS node as seen in project `projectId`? `restricted` maps
// each project read through a share to the Set of sections it grants.
function nodeSectionAllowedIn(node, projectId, restricted) {
  const allowed = restricted?.get(projectId);
  if (!allowed) return true;
  if (node?.node_type === 'project') return true;
  const { sections, unmapped } = graphNodeSectionsNeeded(node);
  if (unmapped && !sharesDefaultSections(allowed)) return false;
  return sections.every((section) => allowed.has(section));
}

// The project root, blanked of what its sections do not grant. A copy: the row
// itself is never touched, and write paths keep using the original.
// The sections a project root carries that this scope withholds: empty when the
// reader sees the whole root.
function rootWithheldSections(node, scope) {
  if (!node || node.node_type !== 'project' || !scope?.restricted?.size) return [];
  const projectId = node.project_id || node.metadata?.project_id;
  const allowed = scope.restricted.get(projectId);
  if (!allowed) return [];
  return [...PROJECT_ROOT_SUMMARY_SECTIONS, 'tech_stack'].filter((section) => !allowed.has(section));
}

function redactGraphNodeForScope(node, scope) {
  const withheld = rootWithheldSections(node, scope);
  if (!withheld.length) return node;
  const keepSummary = PROJECT_ROOT_SUMMARY_SECTIONS.every((section) => !withheld.includes(section));
  const keepStack = !withheld.includes('tech_stack');
  const metadata = { ...(node.metadata || {}) };
  if (!keepStack) delete metadata.tech_stack;
  return { ...node, summary: keepSummary ? node.summary : '', metadata };
}

// visibilityForActor plus, for the graph, which visible projects are read
// through a share and what that share grants. Null = unrestricted (solo, system).
async function graphScopeForActor(actor, ownerKey) {
  const scope = await visibilityForActor(actor, ownerKey);
  if (!scope) return null;
  const restricted = new Map();
  const rows = await store.listProjectShareScopes(ownerKey, [...scope.visible]);
  for (const row of rows) {
    const project = row.project;
    if (!project || isProjectOwner(actor, project) || project.visibility !== 'shared') continue;
    // enabled === false: a share switched off grants nothing, so every
    // section-governed node from it is hidden (the root alone survives, blank).
    const { sections } = shareSectionsFromInfo(project, row);
    restricted.set(project.project_id, new Set(sections));
  }
  return { visible: scope.visible, restricted, identities: scope.identities };
}

// One node, judged for a WRITE: is it visible at all, and which of the sections
// it carries does this actor not get to read. A write to a node the actor sees
// only in part merges into — and, for PATCH, replies with — content they were
// never shown, so the write gate refuses it (assertExistingGraphNodeWritable).
async function graphNodeAccessForActor(actor, ownerKey, node) {
  if (!node) return { visible: false, withheld: [] };
  const scope = await graphScopeForActor(actor, ownerKey);
  if (!scope) return { visible: true, withheld: [] };
  const sightings = await store.listGraphNodeProjectIds(ownerKey, [node.node_id].filter(Boolean));
  if (!nodeVisibleIn(node, sightings, scope)) return { visible: false, withheld: [] };
  return { visible: true, withheld: rootWithheldSections(node, scope) };
}

async function visibleGraphNodesForActor(actor, ownerKey, nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return nodes || [];
  const scope = await graphScopeForActor(actor, ownerKey);
  if (!scope) return nodes;
  const sightings = await store.listGraphNodeProjectIds(ownerKey, nodes.map((node) => node.node_id).filter(Boolean));
  return nodes
    .filter((node) => nodeVisibleIn(node, sightings, scope))
    .map((node) => redactGraphNodeForScope(node, scope));
}

// A node is visible when ANY project it was seen in is visible AND (for a
// project read through a share) grants the node's section. `scopeProjectId` is
// the project a project-scoped graph is ABOUT: a node seen there whose section
// that project withholds is dropped even if another project would grant it,
// because being listed in that project's graph is itself the withheld fact
// ("this project depends on Postgres").
//
// A node MARKED private to one person (metadata.private_to — the founder's
// pre-team no-project nodes, workspaceService.backfillProjectOwnership) is seen
// by that person alone, whatever project or evidence it has: the mark is the
// node-level `personal`.
//
// EVIDENCE NEVER NARROWS A WORKSPACE-LEVEL NODE (scan 33). A node with no
// project is the workspace's: every member reads it, unless the mark above
// names somebody else. It used to be judged like a homed node — visible only
// where its evidence was — so the first session anywhere that named it took it
// away from everyone else: a member's flush in their personal project hid the
// team's "Postgres" from the whole team, its author included (p94); the owner's
// own flush in a project whose share withholds services hid it from every member
// (p94b); and the founder publishing a pre-team note that any solo session had
// mentioned was told "now shared" while nobody could see it (scan 33 a/p3).
// Evidence rows are still filtered on their own project wherever they are shown
// (filterGraphResultWith), so where a workspace node was seen travels only to
// the readers of that project. Nothing private relies on the narrowing: what a
// team member writes privately is filed under their project, and what predates
// the team carries the mark. A project-scoped graph still drops a node its
// project's share withholds (scopeProjectId), because being listed there is the
// withheld fact.
function nodePrivateToOther(node, identities) {
  const owner = node?.metadata?.private_to;
  return Boolean(owner) && !(identities || []).includes(String(owner));
}

// Workspace-level by the STORED row when the sightings carry it (store
// listGraphNodeProjectIds `.homes`), never only by the object in hand: a
// listing that selected no project_id would otherwise read every homed node as
// the workspace's.
function nodeVisibleIn(node, sightings, scope, scopeProjectId = null) {
  if (nodePrivateToOther(node, scope.identities)) return false;
  const projects = new Set(sightings.get(node.node_id) || []);
  const stored = sightings.homes?.has(node.node_id);
  const home = stored ? sightings.homes.get(node.node_id) : (node.project_id || null);
  if (home) projects.add(home);
  if (node.project_id) projects.add(node.project_id);
  const { visible, restricted } = scope;
  if (scopeProjectId && projects.has(scopeProjectId) && !nodeSectionAllowedIn(node, scopeProjectId, restricted)) {
    return false;
  }
  if (!home && !node.project_id) return true;
  return [...projects].some((projectId) => visible.has(projectId) && nodeSectionAllowedIn(node, projectId, restricted));
}

// ─── The graph ENDPOINTS were never filtered at all ─────────────────────────
//
// The fix above put the inheritance rule in front of the graph nodes that reach a
// brief, a recall result and the portfolio. It did not touch /api/v1/context/graph/*,
// and those routes resolved nothing but `owner_key` — which in a shared workspace
// is the same value for everybody in it. So any member, a VIEWER included, could
// read a colleague's `personal` project graph by id: its nodes, its edges, and its
// evidence, which carries verbatim TRANSCRIPT EXCERPTS. A privacy state that hides
// the brief while serving the transcript it was extracted from hides nothing.
//
// Evidence is filtered on its OWN project, not only on the node it hangs off. A
// node legitimately visible through a sighting in a shared project still has
// evidence rows from the hidden project it was first seen in, and those rows are
// the excerpts.
//
// Refusals are not_found, never forbidden: "you may not read project X" confirms
// project X exists and that a colleague is working on it, which is most of what
// the personal state is protecting.
function filterGraphResultWith(graph, sightings, scope, visibleEndpoints = new Map(), scopeProjectId = null) {
  if (!graph || !scope) return graph;
  const { visible, restricted } = scope;
  const keptRaw = (graph.nodes || []).filter((node) => nodeVisibleIn(node, sightings, scope, scopeProjectId));
  const kept = new Map(keptRaw.map((node) => [node.node_id, node]));
  const nodes = keptRaw.map((node) => redactGraphNodeForScope(node, scope));
  const keptLines = new Set(nodes.map((node) => `${node.node_type}: ${node.title}`));
  // AN EDGE IS JUDGED BY ITS ENDPOINTS, NOT BY THIS GRAPH'S NODE LIST.
  //
  // Requiring both ends to survive the node filter reads as the safe rule and is
  // not one: GET /graph/nodes/:id builds a graph whose node list is the single
  // node asked for, so EVERY edge failed it and the endpoint returned no
  // relationships at all — to a colleague and to the author alike. The
  // relationships are most of what a node graph is.
  //
  // `visibleEndpoints` holds the neighbour nodes the caller may see, resolved by
  // fetching the far ends and running them through the same inheritance rule
  // (filterGraphForActor). An endpoint that is neither in this graph nor in that
  // set — hidden, or a dangling edge to a node that no longer exists — takes its
  // edge with it, so neither the hidden node's id nor its title (edge summaries
  // name both ends) travels.
  //
  // And an edge is a fact ABOUT ITS PROJECT: "Atlas depends on Postgres" states
  // Atlas's stack even when Postgres itself is visible through another project.
  // So in a project read through a share, both ends must also be sections that
  // share grants.
  //
  // And a project the reader cannot open at all states nothing to them. Two
  // visible ends are not enough since workspace-level nodes stopped being
  // narrowed (scan 33): a member's personal-project rebuild drew "Decision made
  // during: <their task>" between two team nodes, stamped with the personal
  // project's id and session, and every teammate read it (scan 34 a/F3).
  const endpoint = (nodeId) => kept.get(nodeId) || visibleEndpoints.get(nodeId) || null;
  const edgeVisible = (edge) => {
    const from = endpoint(edge.from_node_id);
    const to = endpoint(edge.to_node_id);
    if (!from || !to) return false;
    if (!edge.project_id) return true;
    if (!visible.has(edge.project_id)) return false;
    return nodeSectionAllowedIn(from, edge.project_id, restricted) && nodeSectionAllowedIn(to, edge.project_id, restricted);
  };
  const evidenceProjectOpen = (projectId) => {
    const allowed = restricted.get(projectId);
    return !allowed || sharesEverySection(allowed);
  };
  return {
    ...graph,
    nodes,
    edges: (graph.edges || []).filter(edgeVisible),
    evidence: (graph.evidence || []).filter((item) => (
      (!item.node_id || kept.has(item.node_id))
      && (!item.project_id || (visible.has(item.project_id) && evidenceProjectOpen(item.project_id)))
    )),
    related_project_ids: (graph.related_project_ids || []).filter((projectId) => visible.has(projectId)),
    provenance: (graph.provenance || []).filter((entry) => !entry.project_id || visible.has(entry.project_id)),
    // Rebuilt from the surviving nodes rather than recomputed: these lines are
    // `${node_type}: ${title}`, so a hidden node's title would otherwise ride out
    // in the summary of a graph its own node was removed from.
    summary_lines: (graph.summary_lines || []).filter((line) => keptLines.has(line)),
  };
}

// `options.scopeProjectId`: the project a project-scoped graph (a project's
// graph, a session's graph, the brief's) is about — see nodeVisibleIn. Node
// graphs and the whole-vault export pass none.
async function filterGraphForActor(actor, ownerKey, graph, options = {}) {
  if (!graph) return graph;
  const scope = await graphScopeForActor(actor, ownerKey);
  if (!scope) return graph;
  const scopeProjectId = options.scopeProjectId || null;
  const nodeIds = (graph.nodes || []).map((node) => node.node_id).filter(Boolean);
  const inGraph = new Set(nodeIds);
  // The far end of every edge that points outside this graph's own node list.
  // On a single-node graph that is every edge; on a project graph it is the
  // cross-project ones. Judged on their own visibility, which is the only way to
  // keep a legitimate edge without opening a hidden one.
  const endpointIds = [...new Set((graph.edges || [])
    .flatMap((edge) => [edge.from_node_id, edge.to_node_id])
    .filter((nodeId) => nodeId && !inGraph.has(nodeId)))];
  // One sightings pass for the graph's nodes AND the neighbours, not two.
  const sightings = await store.listGraphNodeProjectIds(ownerKey, [...nodeIds, ...endpointIds]);
  // Fetched rather than inferred from the sightings map: a node with no sighting
  // at all is either workspace-scoped (visible by construction) or gone, and the
  // map cannot tell those apart. A neighbour that no longer exists resolves to
  // nothing for the reader, so its edge — whose summary can still name it — goes.
  const neighbours = endpointIds.length ? await store.listGraphNodesByIds(ownerKey, endpointIds) : [];
  const visibleEndpoints = new Map(neighbours
    .filter((node) => nodeVisibleIn(node, sightings, scope))
    .map((node) => [node.node_id, node]));
  return filterGraphResultWith(graph, sightings, scope, visibleEndpoints, scopeProjectId);
}

// RELATED PROJECTS BY SHARED ENTITY, for the brief's "Related projects" line.
//
// The graph reads found related projects through rows two projects share: a
// node homed in one with the other's evidence or edge on it. Per-project copies
// (the team-era landing rule, and the first invite's split of a founder's
// solo-era nodes) share no rows, so the line vanished from every founder brief
// at the first invite (scan 36). This groups by entity identity instead — the
// key before `::in.` — as the portfolio does.
//
// Both ends are judged for the reader: this project's node as part of this
// project's graph, and the other node in its own home project, which must be
// one the reader may open with that node's section shared. A pair the reader
// cannot see both ends of names nothing.
async function relatedProjectsBySharedEntity(actor, ownerKey, projectId, { limit = 3 } = {}) {
  const pairs = await store.listSameEntityNodesInOtherProjects(ownerKey, projectId);
  const live = pairs.filter(({ node }) => node.project_id && !graphService.isInactiveGraphNode(node));
  if (!live.length) return [];
  const ownNodes = await store.listGraphNodesByIds(ownerKey, live.map((pair) => pair.own_node_id));
  const ownActive = new Map(ownNodes.filter((node) => !graphService.isInactiveGraphNode(node)).map((node) => [node.node_id, node]));
  let candidates = live.filter((pair) => ownActive.has(pair.own_node_id));
  const scope = await graphScopeForActor(actor, ownerKey);
  if (scope) {
    const sightings = await store.listGraphNodeProjectIds(ownerKey, [
      ...ownActive.keys(),
      ...candidates.map(({ node }) => node.node_id),
    ]);
    candidates = candidates.filter(({ own_node_id: ownId, node }) => (
      nodeVisibleIn(ownActive.get(ownId), sightings, scope, projectId)
      && scope.visible.has(node.project_id)
      && nodeVisibleIn(node, sightings, scope, node.project_id)
    ));
  }
  const ids = [];
  for (const { node } of candidates) {
    if (!ids.includes(node.project_id)) ids.push(node.project_id);
    if (ids.length >= limit) break;
  }
  return ids;
}

// A graph handed back by a WRITE (extraction, explicit update): the same filter,
// failing CLOSED. A read that cannot run its filter errors; a write has already
// landed by the time it gets here, so it answers with an empty graph rather than
// failing a save that succeeded — and never with the unfiltered one.
async function graphViewForActor(actor, ownerKey, graph, options = {}) {
  if (!graph) return graph;
  try {
    return await filterGraphForActor(actor, ownerKey, graph, options);
  } catch (err) {
    console.warn('[GRAPH] write-reply filter failed; returning no graph:', err.message);
    return { ...graph, nodes: [], edges: [], evidence: [], summary_lines: [], related_project_ids: [], provenance: [] };
  }
}

// The same filter over the raw three-table dump GET /graph/export renders from.
async function filterGraphDataForActor(actor, ownerKey, data) {
  return filterGraphForActor(actor, ownerKey, data);
}

async function getWorkspaceEntities(actor, options = {}) {
  const ownerKey = getActorKey(actor);
  const limit = Math.min(Math.max(Number(options.limit || 10), 1), 50);
  const nodeTypes = (options.types || []).map((type) => workspaceNodeType(type));
  const { activeProject } = await resolveActiveWorkspaceContext(actor, options);
  const globalContext = await getGlobalContext(actor).catch(() => null);

  // `project_id` is a RANKING HINT, not a filter — getNextBestContext and the
  // subagent brief both pass it while deliberately wanting owner-wide
  // candidates biased toward the current project. Making it filter would break
  // both, so it stays a hint.
  //
  // But `scope: 'project'` WITH a project_id can only mean one thing: that
  // project's entities. Before this, the pair filtered nothing — the scope test
  // below keeps any node with any project_id, from any project — so asking for
  // one project's entities returned whichever project had the most nodes.
  // Measured 2026-08-28: Red Queen and ApexFundV3 both came back as the same
  // all-DeerDawn list. An explicit related_project_id still wins, since that is
  // the parameter that has always meant "filter".
  const scopedProjectId = options.scope === 'project' && options.project_id
    ? options.project_id
    : null;
  const filterProjectId = options.related_project_id || scopedProjectId || null;
  let nodes = await store.listGraphNodes(ownerKey, {
    nodeTypes,
    projectId: filterProjectId,
    limit: Math.max(limit * 3, 20),
  });
  // A text query must reach PAST that recency window. The window alone meant an
  // entity outside the newest ~30 was "not found" by recall and could never be
  // resolved. Ask the store for text matches across all of this owner's nodes
  // and union them in; the in-memory filter and rerank below still decide.
  const searchTerms = options.query && !options.semantic_fallback ? queryTermsForSearch(options.query) : [];
  if (searchTerms.length) {
    const matches = await store.listGraphNodes(ownerKey, {
      nodeTypes,
      projectId: filterProjectId,
      textTerms: searchTerms,
      limit: Math.max(limit * 10, 100),
    });
    const seen = new Set(nodes.map((node) => node.node_id));
    for (const node of matches) {
      if (!seen.has(node.node_id)) {
        seen.add(node.node_id);
        nodes.push(node);
      }
    }
  }
  // Before anything is inferred FROM these nodes: an inferred capability derived
  // from a hidden node would republish it under a different name.
  nodes = await visibleGraphNodesForActor(actor, ownerKey, nodes);
  const inferredCapabilities = options.include_inferred === false
    ? []
    : inferWorkspaceCapabilities(nodes, activeProject);
  nodes = [...nodes, ...inferredCapabilities];

  // Hard-exclude resolved/archived unless the caller explicitly wants them
  if (!options.include_resolved && options.status !== 'resolved' && options.status !== 'archived') {
    nodes = nodes.filter((n) => !graphService.isInactiveGraphNode(n));
  }

  if (options.query && !options.semantic_fallback) {
    const queryTerms = queryTermsForSearch(options.query);
    const intent = analyzeQueryIntent(options.query);
    if (queryTerms.length) {
      nodes = nodes.filter((node) => {
        const text = nodeText(node);
        if (queryTerms.some((term) => text.includes(term))) return true;
        if (
          intent.wantsCapabilities
          && node.project_id
          && node.project_id === (options.project_id || activeProject?.project_id || null)
          && String(node.metadata?.entity_type || node.node_type || '').toLowerCase() === 'knowledge'
          && ['high', 'critical'].includes(String(node.metadata?.importance || '').toLowerCase())
        ) {
          return true;
        }
        return false;
      });
    }
  }

  if (options.types?.length) {
    const requestedTypes = new Set(options.types);
    nodes = nodes.filter((node) => requestedTypes.has(node.metadata?.entity_type || node.node_type));
  }

  if (options.scope) {
    nodes = nodes.filter((node) => String(node.metadata?.scope || (node.project_id ? 'project' : 'workspace')) === options.scope);
  }

  if (options.status) {
    nodes = nodes.filter((node) => String(node.metadata?.status || '').toLowerCase() === String(options.status).toLowerCase());
  }

  if (options.surface) {
    nodes = nodes.filter((node) => String(node.metadata?.surface || '').toLowerCase() === String(options.surface).toLowerCase());
  }

  if (options.curated_only) {
    nodes = nodes.filter((node) => isCuratedNode(node));
  }

  const rankedNodes = await rerankWorkspaceNodes(nodes, {
    actor,
    projectId: options.project_id || activeProject?.project_id || null,
    projectName: activeProject?.project_name || '',
    currentTask: activeProject?.context?.current_task || '',
    cwd: options.cwd || '',
    query: options.query || '',
    expertiseAreas: globalContext?.expertise_areas || [],
  });

  const selectedNodes = rankedNodes.slice(0, limit);
  if (selectedNodes.length && options.track_selection !== false) {
    await trackWorkspaceSelections(actor, selectedNodes, { source_tool: options.tool || 'workspace_entities' }).catch((err) => {
      console.warn('[CONTEXT] workspace selection tracking failed:', err.message);
    });
  }

  return selectedNodes;
}

async function getWorkspaceOverview(actor, options = {}) {
  const include = new Set(options.include?.length ? options.include : ['projects', 'knowledge', 'tools', 'capabilities', 'recent']);
  const { projects, sessions, activeProject } = await resolveActiveWorkspaceContext(actor, options);
  const globalContext = await getGlobalContext(actor).catch(() => null);
  const mode = options.mode === 'startup' ? 'startup' : 'overview';
  const entityLimit = mode === 'startup'
    ? (options.verbosity === 'light' ? 8 : 12)
    : (options.verbosity === 'light' ? 12 : options.verbosity === 'detailed' ? 60 : 30);
  const overviewOwnerKey = getActorKey(actor);
  // keepParseableNodes: a stored node the overview schema would reject is
  // skipped (and logged) here, not allowed to fail the parse at the bottom of
  // this function — which is the whole of start_session. See contextGraphService.
  const rawNodes = graphService.keepParseableNodes(await visibleGraphNodesForActor(
    actor,
    overviewOwnerKey,
    await store.listGraphNodes(overviewOwnerKey, { limit: entityLimit })
  )).filter((n) => !graphService.isInactiveGraphNode(n));
  const rankedNodes = rankWorkspaceNodes([
    ...rawNodes,
    ...inferWorkspaceCapabilities(rawNodes, activeProject),
  ], {
    projectId: options.project_id || activeProject?.project_id || null,
    projectName: activeProject?.project_name || '',
    currentTask: activeProject?.context?.current_task || '',
    cwd: options.cwd || '',
    expertiseAreas: globalContext?.expertise_areas || [],
  });
  const classified = classifyWorkspaceNodes(rankedNodes);
  const sliceLimit = mode === 'startup' ? 3 : 8;
  const knowledge = include.has('knowledge') ? classified.knowledge.slice(0, sliceLimit) : [];
  const tools = include.has('tools') ? classified.tools.slice(0, mode === 'startup' ? 2 : sliceLimit) : [];
  const capabilities = include.has('capabilities') ? classified.capabilities.slice(0, sliceLimit) : [];
  const passiveEnrichments = buildPassiveEnrichments({
    activeProject,
    rankedNodes,
    globalContext,
    projects,
  });
  const currentUnderstanding = buildCurrentUnderstanding({
    activeProject,
    knowledge,
    tools,
    capabilities,
    passiveEnrichments,
  });
  const selectionExplanations = buildSelectionExplanations({
    activeProject,
    knowledge,
    tools,
    capabilities,
    passiveEnrichments,
  });
  const layers = buildRuntimeLayers({
    projects,
    sessions,
    knowledge,
    tools,
    capabilities,
    activeProject,
    passiveEnrichments,
    selectionExplanations,
  });
  const feedbackNodes = [
    ...knowledge,
    ...tools,
    ...capabilities,
    ...rankedNodes.filter((node) => {
      const sourceKind = String(node?.metadata?.source_kind || '').toLowerCase();
      return (sourceKind === 'imported' || sourceKind === 'inferred') && Number(node._ranking_score || 0) >= 0.55;
    }).slice(0, 3),
  ];
  if (feedbackNodes.length && options.track_selection !== false) {
    await trackWorkspaceSelections(actor, feedbackNodes, { source_tool: 'workspace_overview' }).catch((err) => {
      console.warn('[CONTEXT] workspace overview tracking failed:', err.message);
    });
  }

  const summaryNow = [];
  const summaryRecent = [];

  for (const project of projects.slice(0, 3)) {
    if (project.context?.current_task) {
      summaryNow.push(`${project.project_name}: ${project.context.current_task}`);
    } else if (project.context?.current_status) {
      summaryNow.push(`${project.project_name}: ${project.context.current_status}`);
    }
  }

  for (const node of [...knowledge, ...tools, ...capabilities].slice(0, 4)) {
    summaryRecent.push(buildWorkspaceEntitySummary(node));
  }

  const overview = WorkspaceOverviewResultSchema.parse({
    mode,
    summary: {
      now: summaryNow,
      recent: include.has('recent') ? summaryRecent : [],
    },
    layers,
    projects: projects.map((project) => ({
      project_id: project.project_id,
      project_name: project.project_name,
      updated_at: project.updated_at,
      // Summary context only — the full context (board, knowledge, hot paths, ...)
      // bloated this embedded list to hundreds of KB. See serializers/contextProject.
      context: pickSummaryContext(project.context),
    })),
    knowledge,
    tools,
    capabilities,
    passive_enrichments: passiveEnrichments,
    current_understanding: currentUnderstanding,
    selection_explanations: selectionExplanations,
    provenance: [{ kind: 'global', label: 'Workspace overview', confidence: 1 }],
  });

  // Surface the learned cross-project affinity — "projects you work alongside",
  // ranked by accumulated co-occurrence. This is the read side that makes the
  // strengthening (in renderInjection) deliver value instead of being write-only.
  const relatedProjects = activeProject?.project_id
    ? await getRelatedProjectsByAffinity(actor, activeProject.project_id, mode === 'startup' ? 3 : 5).catch(() => [])
    : [];

  // Team/shared-workspace surface: who collectively built the active project's
  // context. Visible interdependence is the social switching cost.
  const contributors = activeProject?.project_id
    ? await getProjectContributors(actor, activeProject.project_id).catch(() => [])
    : [];

  // Fold the learned affinity + contributors into the object BEFORE rendering text,
  // otherwise they're returned as structured fields but invisible in the MCP text
  // body (which is what most clients actually read).
  const finalOverview = {
    ...overview,
    related_projects: relatedProjects,
    contributors,
  };

  return {
    ...finalOverview,
    text: formatWorkspaceOverview(finalOverview, options.verbosity || 'standard'),
  };
}

async function getProjectMap(actor, projectId, verbosity = 'standard') {
  const ownerKey = getActorKey(actor);

  // Load the RAW row either way. The explicit-id branch read store.getProject with
  // no visibility check, so any project id in the workspace — a colleague's
  // personal or private project — returned its map and was then persisted by the
  // repair below. The listing branch had the opposite defect: it handed a
  // teammate's section-filtered view to a persisting repair, which refuses one.
  let stored = null;
  if (projectId) {
    stored = await store.getProject(ownerKey, projectId);
  } else {
    const first = (await listProjects(actor))[0];
    stored = first ? await store.getProject(ownerKey, first.project_id) : null;
  }
  if (!stored) return null;

  // Invisible must be indistinguishable from absent: null (not_found), and no write.
  const policy = await getProjectSharePolicy(actor, stored);
  if (!canViewProjectForActor(actor, stored, policy)) return null;

  // A read may still repair a corrupt row, but only its author's read persists
  // that repair; anyone else gets the repaired view and leaves the row alone.
  const repaired = await repairProjectIntegrity(stored, { persist: isProjectOwner(actor, stored) });
  const project = projectViewForActor(actor, repaired, policy);

  return {
    project_id: project.project_id,
    project_name: project.project_name,
    hot_paths: project.context?.hot_paths || [],
    entrypoints: project.context?.entrypoints || [],
    surfaces: project.context?.surfaces || [],
    debugging_notes: project.context?.debugging_notes || [],
    text: buildProjectMapText(project, verbosity),
  };
}

const KNOWN_PATH_NOTE_LIMIT = 3;
const KNOWN_PATH_NOTE_CHARS = 240;

async function findKnownPaths(actor, options = {}) {
  const projects = options.project_id
    ? [await getProject(actor, options.project_id)].filter(Boolean)
    : await listProjects(actor);
  const queryTerms = queryTermsForSearch(options.query || '');
  const limit = Math.max(1, Math.min(Number(options.limit || 10), 25));
  const hits = [];

  for (const project of projects) {
    const context = project?.context || {};
    for (const entry of context.hot_paths || []) {
      const score = scoreKnownPathMatch(queryTerms, [entry.label, entry.path, entry.purpose].join(' '));
      if (!score) continue;
      hits.push({
        project_id: project.project_id,
        project_name: project.project_name,
        kind: 'hot_path',
        label: entry.label,
        path: entry.path,
        purpose: entry.purpose || '',
        score,
      });
    }
    for (const entry of context.entrypoints || []) {
      const score = scoreKnownPathMatch(queryTerms, [entry.label, entry.path, entry.purpose].join(' '));
      if (!score) continue;
      hits.push({
        project_id: project.project_id,
        project_name: project.project_name,
        kind: 'entrypoint',
        label: entry.label,
        path: entry.path,
        purpose: entry.purpose || '',
        score,
      });
    }
    for (const entry of context.surfaces || []) {
      const score = scoreKnownPathMatch(queryTerms, [entry.label, entry.purpose, ...(entry.paths || [])].join(' '));
      if (!score) continue;
      hits.push({
        project_id: project.project_id,
        project_name: project.project_name,
        kind: 'surface',
        label: entry.label,
        paths: entry.paths || [],
        purpose: entry.purpose || '',
        score,
      });
    }
    for (const entry of context.debugging_notes || []) {
      const score = scoreKnownPathMatch(queryTerms, [entry.summary, ...(entry.paths || [])].join(' '));
      if (!score) continue;
      hits.push({
        project_id: project.project_id,
        project_name: project.project_name,
        kind: 'debugging_note',
        summary: entry.summary,
        paths: entry.paths || [],
        added_at: entry.added_at,
        ...(entry.commit_ref ? { commit_ref: entry.commit_ref } : {}),
        ...(entry.diff_ref ? { diff_ref: entry.diff_ref } : {}),
        score,
      });
    }
  }

  // Paths first, then at most three notes.
  //
  // This is `recall paths` — "where does X live". Everything was sorted on one
  // score, and a debugging note scores on its whole summary: notes are long,
  // match more query words, and there are up to 30 of them per project, so they
  // took the top of a list whose caller asked for a file. A note that mentions
  // the path is useful context AFTER the path; it is not the answer.
  //
  // Notes are clipped because a stored summary runs to 4,000 characters and ten
  // of those is the whole reply budget. The full text is still reachable through
  // search and the debugging_notes section.
  //
  // `note_limit` is for the one INTERNAL caller that wants the notes more than
  // the paths: buildSubagentBrief turns them into watch-outs and does its own
  // budgeting. Neither public surface can send it — the REST route parses its
  // query through a zod object that strips unknown keys, and the hosted handler
  // passes three named arguments.
  const noteLimit = Number.isInteger(options.note_limit) && options.note_limit >= 0
    ? options.note_limit
    : KNOWN_PATH_NOTE_LIMIT;
  const byScore = (left, right) => right.score - left.score;
  const notes = hits
    .filter((hit) => hit.kind === 'debugging_note')
    .sort((left, right) => byScore(left, right) || ((Date.parse(right.added_at) || 0) - (Date.parse(left.added_at) || 0)))
    .slice(0, noteLimit)
    .map((hit) => ({ ...hit, summary: clipText(hit.summary, KNOWN_PATH_NOTE_CHARS) }));
  const paths = hits.filter((hit) => hit.kind !== 'debugging_note').sort(byScore);
  // Room is held for the notes only when there are paths to spare; with no path
  // hits at all the notes are the whole (still capped) answer.
  const pathSlots = Math.max(limit - notes.length, Math.ceil(limit / 2));
  return [...paths.slice(0, pathSlots), ...notes].slice(0, limit);
}

// Words that are in every sentence, so matching one says nothing. Short enough
// to read: a long stoplist starts dropping words that are the whole question
// ("auth", "team"), and queryTermsForSearch already drops everything under three
// characters.
const SUBAGENT_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'are', 'was', 'were', 'has', 'have',
  'had', 'not', 'but', 'all', 'any', 'can', 'use', 'via', 'per', 'its', 'our', 'your', 'their',
  'them', 'when', 'then', 'than', 'also', 'only', 'over', 'under', 'out', 'off', 'one', 'two',
  'how', 'why', 'what', 'which', 'who', 'where', 'while', 'you', 'they', 'some', 'each', 'other',
  'about', 'after', 'before', 'again', 'still', 'just', 'more', 'most', 'less', 'very', 'such',
  'should', 'would', 'could', 'must', 'been', 'being', 'does', 'did', 'doing', 'here', 'there',
]);

// Just enough morphology that "scope" and "scopes", or "mapping" and "mapped",
// are the same word. A real stemmer is a dependency and a source of surprises;
// this only collapses the endings that make one engineer's task text miss
// another engineer's decision text. Every form is kept, and two words match when
// their form sets overlap, so nothing depends on picking the "right" stem.
function subagentWordForms(word) {
  const forms = new Set([word]);
  if (word.length > 4) {
    const bases = [];
    if (word.endsWith('ies')) bases.push(`${word.slice(0, -3)}y`);
    if (word.endsWith('es')) bases.push(word.slice(0, -2));
    if (word.endsWith('s') && !word.endsWith('ss')) bases.push(word.slice(0, -1));
    if (word.endsWith('ing')) bases.push(word.slice(0, -3));
    // Both, so "downgraded" reaches "downgrade" and "mapped" reaches "mapp".
    if (word.endsWith('ed')) bases.push(word.slice(0, -2), word.slice(0, -1));
    for (const base of bases) {
      forms.add(base);
      // "mapping" -> "mapp" -> "map"
      if (/([bdgklmnprt])\1$/.test(base)) forms.add(base.slice(0, -1));
    }
  }
  return forms;
}

// ONE TOKENISER FOR BOTH SIDES, AND IT HAS TO KNOW MORE THAN ASCII.
//
// The candidate text was split on /[^a-z0-9]+/ while the query kept whatever
// the person typed, so the two sides never agreed outside English:
// "Rechnungsprüfung" became "rechnungspr" + "fung" on one side and stayed whole
// on the other, and a Cyrillic, Greek or CJK sentence dissolved entirely — no
// tokens, no words, score zero for every candidate. A Russian project's own
// decisions could not reach a brief about them, silently, while the English
// project next door worked.
//
// NFKC first so a composed and a decomposed umlaut are one word, then letters
// and numbers in any script.
const SUBAGENT_TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;
// Han, Hiragana, Katakana and Hangul, which are written without spaces: a
// Japanese sentence is ONE token, and two sentences about the same subject
// would share nothing. Character bigrams are the standard cheap answer and are
// what actually makes those two sentences overlap.
const SUBAGENT_CJK_RUN = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]+/gu;
// The ASCII floor queryTermsForSearch has always applied. Kept for spaced
// scripts — "the" and "for" are noise in every one of them — and deliberately
// not applied to CJK, where two characters is a word.
const SUBAGENT_MIN_TERM_CHARS = 3;

function subagentTokens(text) {
  const normalized = String(text || '').normalize('NFKC').toLowerCase();
  const tokens = [];
  for (const chunk of normalized.split(SUBAGENT_TOKEN_SPLIT)) {
    if (!chunk) continue;
    let hadCjk = false;
    for (const run of chunk.match(SUBAGENT_CJK_RUN) || []) {
      hadCjk = true;
      if (run.length === 1) tokens.push(run);
      for (let i = 0; i + 1 < run.length; i++) tokens.push(run.slice(i, i + 2));
    }
    // What is left once the CJK runs are taken out: a mixed token like
    // "メール2" still contributes its latin/digit half.
    for (const rest of hadCjk ? chunk.split(SUBAGENT_CJK_RUN) : [chunk]) {
      if (rest && rest.length >= SUBAGENT_MIN_TERM_CHARS) tokens.push(rest);
    }
  }
  return tokens;
}

function subagentQueryTerms(text) {
  return uniqueStrings(subagentTokens(text)).filter((term) => !SUBAGENT_STOPWORDS.has(term));
}

// WHOLE TOKENS, AGAINST THE OBJECTIVE'S OWN TERM COUNT.
//
// This was a substring test over every 3+ character term of task + role +
// deliverable, normalised by min(termCount, 5). So "the", "for" and "and"
// counted as hits, any five hits scored a flat 1.0, and a long deliverable
// saturated every candidate on the board. If relevance does not mean "this many
// of the words in the TASK", the threshold below is not filtering anything.
function subagentRelevanceScore(text, queryTerms) {
  if (!queryTerms.length) return 0;
  const words = subagentTokens(text);
  if (!words.length) return 0;
  const forms = new Set();
  for (const word of words) for (const form of subagentWordForms(word)) forms.add(form);
  const matched = queryTerms.filter(
    (term) => [...subagentWordForms(term)].some((form) => forms.has(form))
  ).length;
  return Math.min(1, matched / queryTerms.length);
}

// Additive, for WATCH-OUTS. A landmine is a warning, and a critical warning is
// worth carrying into work it only half touches.
function subagentImportanceBoost(importance) {
  return ({ critical: 0.5, high: 0.3, normal: 0.1, low: 0 }[String(importance || 'normal').toLowerCase()] || 0);
}

// A MULTIPLIER, for KNOWLEDGE. Importance decides which of two RELEVANT
// decisions leads; it is not a substitute for being relevant at all. Added to
// the score instead, a critical decision scored 0.85 and a high 0.65 with zero
// relevance, both clear of the 0.62 threshold — which is how one old critical
// decision came to lead the Know section of five consecutive briefs about five
// unrelated tasks.
function subagentImportanceMultiplier(importance) {
  return ({ critical: 1.5, high: 1.25, normal: 1, low: 0.9 }[String(importance || 'normal').toLowerCase()] || 1);
}

// A critical decision the task does not touch is still worth carrying — the
// worker must not contradict it — but it belongs beneath everything that DOES
// touch the task, taking a slot only if one is left over.
const SUBAGENT_UNMATCHED_CRITICAL_SCORE = 0.5;

function sortSubagentCandidates(items) {
  return items
    .filter((item) => item?.text)
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
}

// `options.sessionId` names THIS connection, and it is not part of the request:
// the caller never sends it, the server derives it. Without it the brief
// resolved through the person's most recent binding ANYWHERE, so an editor
// connection sitting in one repo briefed a worker on whatever project a browser
// tab had written to last — while `recall context` on the same connection,
// which does pass it, named the right one.
async function buildSubagentBrief(actor, input = {}, options = {}) {
  const request = SubagentBriefRequestSchema.parse(input);
  const project = request.project_id
    ? await getProject(actor, request.project_id)
    : await resolveActiveProject(actor, input.cwd || null, input.workspace_key || null, {
      sessionId: options.sessionId || null,
    });
  if (!project) throw new Error('project_not_found');

  const context = project.context || {};
  const query = [request.task, request.role, request.deliverable, ...request.focus_paths]
    .filter(Boolean)
    .join(' ');
  // RETRIEVAL takes the whole request — role and deliverable words genuinely
  // help find files. RELEVANCE takes the OBJECTIVE alone: "reviewer" and
  // "ranked list of defects with file and line" are how the work is to be
  // reported, not what it is about, and counting them made every long
  // deliverable score everything.
  const queryTerms = subagentQueryTerms(request.task);

  // Both are read-only derivations. semantic_fallback deliberately skips the
  // public entity query's lexical prefilter so synonym matches can survive into
  // embedding reranking; selection tracking is disabled so building a brief does
  // not change future rankings or create graph fan-out.
  const [knownPaths, rankedNodes] = await Promise.all([
    findKnownPaths(actor, {
      project_id: project.project_id,
      query,
      limit: 16,
      // Notes become this brief's watch-outs; the 3-note cap is for `recall paths`.
      note_limit: 8,
    }),
    getWorkspaceEntities(actor, {
      project_id: project.project_id,
      query,
      limit: 16,
      include_inferred: true,
      semantic_fallback: true,
      track_selection: false,
      tool: 'subagent_brief',
    }),
  ]);

  const knowledge = [];
  const paths = [];
  const watchouts = [];
  const verificationItems = [];

  if (context.current_task) {
    knowledge.push({
      kind: 'project',
      text: `Main task: ${context.current_task}`,
      source_id: 'current_task',
      score: 1,
    });
  }
  if (context.current_status && subagentRelevanceScore(context.current_status, queryTerms) > 0) {
    knowledge.push({
      kind: 'project',
      text: `Current status: ${context.current_status}`,
      source_id: 'current_status',
      score: 0.65 + subagentRelevanceScore(context.current_status, queryTerms),
      ...(context.status_verified_at ? { verified_at: context.status_verified_at } : {}),
    });
  }

  for (const decision of context.recent_decisions || []) {
    if (!decision || decision.resolved) continue;
    const relevance = subagentRelevanceScore(`${decision.summary} ${decision.reasoning || ''}`, queryTerms);
    const isCritical = String(decision.importance || '').toLowerCase() === 'critical';
    // A decision earns its slot by matching the task. Only `critical` keeps a
    // standing place without one, and then at the floor: beneath everything the
    // worker was actually sent here to do.
    if (!relevance && !isCritical) continue;
    const score = relevance > 0
      ? (0.35 + relevance) * subagentImportanceMultiplier(decision.importance)
      : SUBAGENT_UNMATCHED_CRITICAL_SCORE;
    if (relevance > 0 && score < 0.62) continue;
    knowledge.push({
      kind: 'decision',
      text: decision.reasoning ? `${decision.summary} (because: ${decision.reasoning})` : decision.summary,
      source_id: decision.canonical_key || decision.decided_at || undefined,
      score,
      importance: decision.importance || 'normal',
      ...(decision.verified_at ? { verified_at: decision.verified_at } : {}),
    });
  }

  for (const constraint of context.recurring_context || []) {
    const relevance = subagentRelevanceScore(constraint, queryTerms);
    const score = 0.55 + relevance;
    if (score < 0.62) continue;
    knowledge.push({ kind: 'constraint', text: constraint, score });
  }

  if (context.blocking_issue) {
    watchouts.push({
      kind: 'constraint',
      text: `Active blocker: ${context.blocking_issue}`,
      source_id: 'blocking_issue',
      score: 1.1,
      importance: 'high',
    });
  }
  for (const landmine of context.landmines || []) {
    if (!landmine?.summary) continue;
    const relevance = subagentRelevanceScore(`${landmine.summary} ${(landmine.paths || []).join(' ')}`, queryTerms);
    const score = 0.35 + relevance + subagentImportanceBoost(landmine.importance || 'high');
    if (score < 0.7) continue;
    watchouts.push({
      kind: 'landmine',
      text: landmine.summary,
      source_id: landmine.added_at || undefined,
      path: (landmine.paths || [])[0] || undefined,
      score,
      importance: landmine.importance || 'high',
    });
  }

  for (const focusPath of request.focus_paths) {
    paths.push({
      kind: 'path',
      text: 'Explicit focus path',
      path: focusPath,
      source_id: 'caller_focus_path',
      score: 2,
    });
  }
  for (const hit of knownPaths) {
    if (hit.kind === 'debugging_note') {
      watchouts.push({
        kind: 'debugging_note',
        text: hit.summary,
        path: (hit.paths || [])[0] || undefined,
        source_id: hit.commit_ref || hit.diff_ref || hit.added_at || undefined,
        score: 0.7 + Number(hit.score || 0),
      });
      continue;
    }
    const hitPaths = hit.kind === 'surface' ? (hit.paths || []) : [hit.path].filter(Boolean);
    for (const hitPath of hitPaths) {
      paths.push({
        kind: 'path',
        text: hit.purpose || hit.label || hit.kind,
        path: hitPath,
        source_id: hit.label || undefined,
        score: 0.75 + Number(hit.score || 0),
      });
    }
  }

  for (const node of rankedNodes) {
    if (node.project_id && node.project_id !== project.project_id) continue;
    const score = Number(node._ranking_score || 0);
    if (score < 0.55) continue;
    const entityType = String(node.metadata?.entity_type || node.node_type || 'entity');
    const nodePath = node.metadata?.path || node.metadata?.cwd || undefined;
    const item = {
      kind: entityType === 'decision' ? 'decision' : 'entity',
      text: node.summary || node.title,
      path: nodePath,
      source_id: node.node_id || node.canonical_key || undefined,
      score,
      importance: node.metadata?.importance || 'normal',
    };
    if (nodePath || ['file', 'component', 'repo'].includes(entityType)) {
      // A FILE earns its slot by being the right file, which is what the path
      // ranker already judged. Its title echoing the task is not the test.
      paths.push({ ...item, kind: 'path', path: nodePath || node.title });
      continue;
    }
    // KNOWLEDGE follows the same rule as the decision list above. _ranking_score
    // carries importance, curation, memory-tier and recency terms, so a node
    // with no lexical overlap with the objective at all clears the 0.55 floor —
    // and every decision in a project is auto-promoted to a node, so this is the
    // same unrelated critical arriving by a second door.
    const relevance = subagentRelevanceScore(
      [node.title, node.summary, node.canonical_key].filter(Boolean).join(' '),
      queryTerms,
    );
    const isCriticalNode = String(item.importance || '').toLowerCase() === 'critical';
    if (!relevance && !isCriticalNode) continue;
    knowledge.push({
      ...item,
      score: relevance > 0 ? score * (1 + relevance) : SUBAGENT_UNMATCHED_CRITICAL_SCORE,
    });
  }

  for (const command of context.commands || []) {
    const commandText = `${command.label || ''} ${command.run || ''}`;
    const relevant = /test|lint|build|verify|check/i.test(command.label || '')
      || subagentRelevanceScore(commandText, queryTerms) > 0;
    if (!relevant) continue;
    verificationItems.push({
      kind: 'command',
      text: `${command.label}: ${command.run}`,
      source_id: command.label,
      score: /test|verify|check/i.test(command.label || '') ? 1 : 0.7,
    });
  }

  const brief = formatSubagentBrief({
    ...request,
    project_id: project.project_id,
    project_name: project.project_name,
    context_updated_at: project.updated_at || context.last_updated || null,
    knowledge: sortSubagentCandidates(knowledge).slice(0, 10),
    paths: sortSubagentCandidates(paths).slice(0, 12),
    watchouts: sortSubagentCandidates(watchouts).slice(0, 8),
    verification_items: sortSubagentCandidates(verificationItems).slice(0, 4),
  });
  const mainBriefBody = formatCodeInjection(context, 'standard', null).body || '';
  const mainBriefEstimatedTokens = Math.max(1, Math.ceil(mainBriefBody.length / 4));
  return {
    ...brief,
    main_brief_estimated_tokens: mainBriefEstimatedTokens,
    packaging_token_delta: mainBriefEstimatedTokens - brief.estimated_tokens,
  };
}

function normalizeHotPathKey(path) {
  return String(path || '').trim().toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
}

const hotPathEntryKey = (entry) => `${String(entry?.label || '').trim().toLowerCase()}::${normalizeHotPathKey(entry?.path)}`;

// A FULL LIST AGES; IT IS NOT REWRITTEN.
//
// The capped lists (hot paths 40, debugging notes 30) stay full on any project in
// real use: the author's own writes age the oldest entry out, so the list never
// drops below the cap again. Refusing an append-only member whenever the append
// would displace an entry therefore refused every member write FOREVER once the
// list first filled — the everyday team action, dead, with no way for the member
// (who on a default share cannot even read the section) to see why.
//
// So for an append-only caller the cap is AGING, the same thing it is for the
// author: the append goes in and the oldest entry makes room. Chosen here, not
// by the merge's own ranking, so it follows three rules:
//   1. never a pinned entry — pinning is a person saying "keep this";
//   2. the caller's OWN oldest entry first, when they have one: a teammate's
//      steady stream of writes ages their own work before anybody else's;
//   3. otherwise the oldest of the least-important unpinned entries overall.
// What stays refused is the TARGETED rewrite — relabelling a path somebody else
// recorded, collapsing onto their note, superseding — which is a change to a
// particular entry, not the list ageing. And one write may push out at most
// APPEND_AGE_OUT_LIMIT entries that are not the caller's, so a single call
// cannot empty the list in one go. The reply says only how MANY aged out, and
// names what went only to a caller the share lets read the section.
const APPEND_AGE_OUT_LIMIT = 10;
const HOT_PATH_LIMIT = 40;

// The `count` entries an append-only caller may age out of `entries`, or null
// when the list cannot make that much room by the rules above. `recency` orders
// oldest-first (lower = older).
//
// Rule 1 protects OTHER people's pins. The caller's own entries may age even
// when pinned (their unpinned ones first): an append-only caller cannot pin any
// more (stripAppendOnlyRanking), but entries pinned before that rule are still
// stored, and a pin that shields the pinner's own flood is exactly how one
// member aged every owner entry out of both lists.
function chooseAgedOut(actor, entries, count, recency) {
  if (count <= 0) return [];
  const mine = new Set(workspace.actorIdentities(actor));
  const isMine = (entry) => Boolean(entry?.contributed_by && mine.has(entry.contributed_by));
  const ranked = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry && (!entry.pinned || isMine(entry)))
    .sort((a, b) => (
      (Number(isMine(b.entry)) - Number(isMine(a.entry)))
      || (Number(Boolean(a.entry.pinned)) - Number(Boolean(b.entry.pinned)))
      || (entryPriorityOf(a.entry) - entryPriorityOf(b.entry))
      || (recency(a.entry, a.index) - recency(b.entry, b.index))
    ));
  if (ranked.length < count) return null;
  const chosen = ranked.slice(0, count).map(({ entry }) => entry);
  if (chosen.filter((entry) => !isMine(entry)).length > APPEND_AGE_OUT_LIMIT) return null;
  return chosen;
}

const IMPORTANCE_RANK_FOR_AGING = { critical: 3, high: 2, normal: 0, low: -1 };
function entryPriorityOf(entry) {
  return IMPORTANCE_RANK_FOR_AGING[entry?.importance] || 0;
}

// PINNING AND IMPORTANCE ARE EDITS. They decide what a full list keeps, so a
// caller who may only APPEND does not get to set them: a member filing thirty
// pinned notes made every one of their own entries unageable, so each append
// aged the owner's instead until none were left, and then the owner's own next
// write ranked below a list of pins and was dropped. An append-only entry goes
// in at the default rank; somebody who may edit the section can pin it.
function stripAppendOnlyRanking(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const { pinned: _pinned, importance: _importance, ...rest } = entry;
  return rest;
}

// ONE PATH, AS A CALLER MAY SEND IT. The REST route, /events hot_path_discovered
// and the hosted dispatcher all reach recordHotPaths, and only the first two
// validated anything — /events handed metadata.items through as they came. So
// the service validates here, once, for every door: an item that fails is not
// stored (and is counted as not stored), and it never reaches the overflow
// count, because aging owner paths to make room for items the merge then drops
// deleted ten of them for nothing. contributed_by is not a field a caller sends:
// the stamp is the server's (recordHotPaths), and z.object strips it.
const RecordHotPathItemSchema = z.object({
  label: z.string().min(1),
  path: z.string().min(1),
  purpose: z.string().optional(),
  importance: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  pinned: z.boolean().optional(),
});

// A capped list that ranked the caller's OWN new entry out: every stored entry
// outranks it (all pinned), so the merge kept them and dropped the newcomer.
// "Recorded" over that is the silent loss the read-back replies exist to stop,
// so nothing is saved and the caller is told why.
// A FINDING THE SERVER CANNOT STORE IS THE CALLER'S TO FIX, SAID AS SUCH.
//
// A note the schema rejects (an `added_at` of "yesterday") was handed to the
// merge, which parsed it away, and the "was it stored?" check then answered
// debug_log_full_pinned — into an EMPTY log. So the note is checked here, first,
// and a bad field is a 400 that names it.
function invalidFindingError(field, message) {
  const error = new Error('invalid_debug_finding');
  error.code = 'invalid_debug_finding';
  error.status = 400;
  error.field = field;
  error.retryable = false;
  error.publicMessage = `invalid_debug_finding: nothing was saved. ${message}`;
  error.safeMessage = error.publicMessage;
  return error;
}

// `added_at` as the log stores it: an ISO datetime. A date alone ("2026-09-23")
// is taken as midnight UTC that day; anything else that is not a datetime is
// refused rather than guessed at. Absent means now.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
function normalizeFindingAddedAt(value) {
  if (value === undefined || value === null || value === '') return isoNow();
  const text = String(value).trim();
  const candidate = DATE_ONLY.test(text) ? `${text}T00:00:00.000Z` : text;
  const parsed = z.string().datetime({ offset: true }).safeParse(candidate);
  const time = Date.parse(candidate);
  if (!parsed.success || !Number.isFinite(time)) {
    throw invalidFindingError('added_at', `added_at must be an ISO date or datetime (e.g. "2026-09-23" or "2026-09-23T14:05:00Z"); got ${JSON.stringify(String(value).slice(0, 40))}.`);
  }
  return new Date(time).toISOString();
}

// A full log that ranked the new note out, when it is NOT a log of pins: every
// stored note is newer than this one or more important, so the cap dropped the
// note just filed (a backfilled finding, or a low-importance one).
function debugLogRankedOutError(project) {
  const error = new Error('debug_log_ranked_out');
  error.code = 'debug_log_ranked_out';
  error.status = 409;
  error.retryable = false;
  error.publicMessage = `debug_log_ranked_out: nothing was saved. The debugging log of "${project.project_name}" is full, and this note is older or less important than every note stored in it, `
    + 'so it was the one the cap dropped. Record it with a later added_at or a higher importance, or supersede an older note, then record this again.';
  error.safeMessage = error.publicMessage;
  return error;
}

function listFullOfPinnedError(project, code, what) {
  const error = new Error(code);
  error.code = code;
  error.status = 409;
  error.retryable = false;
  error.publicMessage = `${code}: nothing was saved. The ${what} of "${project.project_name}" is full and every entry in it outranks this one (they are pinned), `
    + 'so there was no room for it. Unpin or supersede an older entry, then record this again.';
  error.safeMessage = error.publicMessage;
  return error;
}

// Compare-and-swap guarded; re-run from a fresh read when the swap loses.
// See withContextWriteRetry.
async function recordHotPaths(actor, projectId, items) {
  return withContextWriteRetry(() => recordHotPathsOnce(actor, projectId, items));
}

async function recordHotPathsOnce(actor, projectId, items = []) {
  const loaded = await loadProjectForWrite(actor, projectId);
  if (!loaded) throw new Error('project_not_found');
  const { project, policy } = loaded;
  const mode = sectionWriteMode(actor, project, policy, 'hot_paths');
  const existing = project.context?.hot_paths || [];
  const existingPathKeys = new Set(existing.map((entry) => normalizeHotPathKey(entry?.path)));
  // Who recorded each path, so a full list can age a caller's own entries first.
  // ALWAYS the server's answer, never the caller's: a member who stamped their
  // paths with the owner's id had none of them count as "theirs", so every
  // write aged ten more of the owner's. Validated first (RecordHotPathItemSchema)
  // and, for an append-only caller, stripped of pin and importance.
  const contributor = workspace.actorPersonId(actor);
  const requestedItems = Array.isArray(items) ? items : [];
  const stamped = requestedItems
    .map((item) => RecordHotPathItemSchema.safeParse(item))
    .filter((parsed) => parsed.success)
    .map(({ data }) => (mode === 'append' ? stripAppendOnlyRanking(data) : data))
    .map((item) => (contributor ? { ...item, contributed_by: contributor } : item));

  // Dedupe by normalized PATH before merging. mergeContextObject's own dedup key
  // is label+path, so recording the same path under a different label would
  // otherwise accumulate a second node for it instead of updating the existing
  // one — directly against the tool's "append nodes, keep it lean" purpose. Drop
  // any existing entry whose path collides with an incoming one so the incoming
  // (freshest) label/purpose wins; genuinely distinct paths still just append.
  //
  // Only for a caller who may REWRITE the section. An append-only caller never
  // replaces somebody else's entry: a path already recorded stays as it was, and
  // the incoming duplicate is reported as not stored.
  const incoming = mode === 'edit'
    ? stamped
    : stamped.filter((item) => !existingPathKeys.has(normalizeHotPathKey(item?.path)));
  // Every path ASKED for (the reply counts against these) — but only a VALID
  // item may displace a stored path, or an editor's malformed item deleted the
  // entry it named and then stored nothing in its place.
  const incomingPathKeys = new Set(requestedItems.map((item) => normalizeHotPathKey(item?.path)).filter(Boolean));
  const validPathKeys = new Set(stamped.map((item) => normalizeHotPathKey(item.path)).filter(Boolean));
  let prunedHotPaths = mode === 'edit'
    ? existing.filter((entry) => !validPathKeys.has(normalizeHotPathKey(entry?.path)))
    : existing;

  // Append-only into a full list: make exactly the room the append needs, by the
  // aging rules above, BEFORE the merge — so the merge's own cap never has to
  // choose, and never chooses somebody's pinned or newer entry.
  let agedOut = [];
  if (mode === 'append' && incoming.length) {
    const newKeys = new Set(incoming
      .filter((item) => item && item.label && item.path)
      .map(hotPathEntryKey));
    const overflow = existing.length + newKeys.size - HOT_PATH_LIMIT;
    if (overflow > 0) {
      agedOut = chooseAgedOut(actor, existing, overflow, (_entry, index) => index);
      if (!agedOut) {
        throw appendWouldRewriteError(project, 'hot_paths',
          `need more room in the full list than it can give (entries that are pinned, or more than ${APPEND_AGE_OUT_LIMIT} of other people's paths in one write)`);
      }
      const going = new Set(agedOut);
      prunedHotPaths = existing.filter((entry) => !going.has(entry));
    }
  }
  const baseContext = { ...project.context, hot_paths: prunedHotPaths };

  const updated = {
    ...project,
    context: mergeContextObject(baseContext, { hot_paths: incoming }, mergeSourceFor(actor, project, policy, 'Recorded hot paths')),
    updated_at: isoNow(),
  };
  const storedPaths = updated.context?.hot_paths || [];
  if (mode === 'append') {
    // Last line: nothing but the entries chosen to age out may have gone.
    const kept = new Set(storedPaths.map(hotPathEntryKey));
    const going = new Set(agedOut);
    if (existing.some((entry) => !going.has(entry) && !kept.has(hotPathEntryKey(entry)))) {
      throw appendWouldRewriteError(project, 'hot_paths', 'push existing hot paths out of the capped list');
    }
  }
  // NOTHING CHANGED, NOTHING SAVED. An append of paths that are all already
  // recorded stores nothing, and saving anyway bumped the owner's updated_at and
  // published project_updated for a write that did nothing.
  const changed = JSON.stringify(storedPaths) !== JSON.stringify(existing);
  if (changed) await saveProjectGuarded(updated, actor);
  // WHAT LANDED, READ BACK — not what was asked for. hot_paths is capped, so a
  // caller can be told "Recorded 3" over a list that stored one of them and
  // evicted two older entries to do it. Both callers (this service's REST route
  // and the hosted dispatcher) report these counts rather than items.length.
  const storedKeys = new Set(storedPaths.map((entry) => normalizeHotPathKey(entry?.path)));
  const requestedKeys = [...incomingPathKeys];
  const incomingKeys = new Set(incoming.map((item) => normalizeHotPathKey(item?.path)));
  const storedCount = requestedKeys.filter((key) => incomingKeys.has(key) && storedKeys.has(key)).length;
  // Paths an append-only caller sent that were already recorded, and so were
  // left exactly as they were rather than relabelled.
  // Invalid items are not "already recorded"; they are simply not stored.
  const alreadyRecorded = requestedKeys.filter((key) => validPathKeys.has(key) && !incomingKeys.has(key)).length;
  const evicted = existing.filter(
    (entry) => !storedKeys.has(normalizeHotPathKey(entry?.path))
  ).length;
  // The stored list goes back only to somebody who may read the section. A
  // member appending blind to a section the share withholds hears the counts
  // for what THEY sent and nothing else: no stored entries, and no label or
  // purpose of a path somebody else already recorded.
  const visible = canViewSectionForActor(actor, project, policy, 'hot_paths');
  return {
    project_id: updated.project_id,
    project_name: updated.project_name,
    ...(visible ? { hot_paths: storedPaths } : {}),
    requested: requestedKeys.length,
    stored: storedCount,
    not_stored: requestedKeys.length - storedCount,
    ...(alreadyRecorded ? { already_recorded: alreadyRecorded } : {}),
    evicted,
    aged_out: evicted,
  };
}

// A finding's paths as the merge will store them (shared-context
// normalizeDebuggingNotes: trimmed, blanks dropped, deduped, redacted), so the
// schema below judges what is saved rather than what was typed. It judged the
// raw list, and `paths: [""]` — which models send for "no path" — was a 400 on
// every door (REST, hosted record_finding, /events) for a note the merge would
// have stored with paths []. A non-string entry is left for the schema to name.
function normalizeFindingPaths(paths) {
  if (!Array.isArray(paths)) return [];
  const out = [];
  for (const entry of paths) {
    if (typeof entry !== 'string') { out.push(entry); continue; }
    const value = String(store.redactForStorage(entry.trim()) || '').trim();
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

// Compare-and-swap guarded; re-run from a fresh read when the swap loses.
// See withContextWriteRetry.
async function recordDebugFinding(actor, projectId, input) {
  return withContextWriteRetry(() => recordDebugFindingOnce(actor, projectId, input));
}

async function recordDebugFindingOnce(actor, projectId, input) {
  const loaded = await loadProjectForWrite(actor, projectId);
  if (!loaded) throw new Error('project_not_found');
  const { project, policy } = loaded;
  const mode = sectionWriteMode(actor, project, policy, 'debugging_notes');
  // Superseding DELETES earlier notes: a rewrite, not an append.
  if (input.supersedes) assertCanEditSections(actor, project, policy, ['debugging_notes']);
  // WHO found it. Same rule as every other attributed write (applyExtraction,
  // applyStructuredContextEvent): stamp whenever there is a person behind the
  // actor, and leave an internal actor's writes NULL. A finding nobody is named
  // on cannot be chased — and this is the one route BOTH dispatchers record a
  // note through, so the stamp belongs here rather than at either call site.
  const contributor = workspace.actorPersonId(actor);
  const note = {
    summary: input.summary,
    paths: normalizeFindingPaths(input.paths),
    added_at: normalizeFindingAddedAt(input.added_at),
    ...(input.commit_ref ? { commit_ref: input.commit_ref } : {}),
    ...(input.diff_ref ? { diff_ref: input.diff_ref } : {}),
    // Rank hints only from a caller who may edit the log (stripAppendOnlyRanking).
    ...(input.importance && mode === 'edit' ? { importance: input.importance } : {}),
    ...(input.pinned && mode === 'edit' ? { pinned: true } : {}),
    ...(input.source_tool ? { source_tool: input.source_tool } : {}),
    ...(contributor ? { contributed_by: contributor } : {}),
  };
  const noteCheck = DebuggingNoteEntrySchema.safeParse(note);
  if (!noteCheck.success) {
    const issue = noteCheck.error.issues[0] || {};
    const field = String((issue.path || [])[0] || 'note');
    throw invalidFindingError(field, `${field}: ${issue.message || 'invalid value'}.`);
  }
  // Supersede: a reworded correction has a different summary than the stale note,
  // so dedup-by-summary won't collapse them and both would survive. When the caller
  // names what this replaces, drop the matching prior note(s) before merging so the
  // log holds the correction, not the contradiction.
  //
  // Everything below is judged against the log AS THE MERGE WILL SEE IT. The
  // merge re-normalizes the whole stored log, so a log written before the
  // look-alike rule (two old notes differing only by a time) collapses on ANY
  // write — and that collapse, measured against the raw row, was charged to
  // whoever happened to write next: a member filing an unrelated finding was
  // refused for "replacing a note somebody else recorded". Normalizing first
  // takes what the log does to itself out of what this write does to it.
  const priorNotes = mergeNormalizeDebuggingNotes(project.context?.debugging_notes || []);
  let baseContext = { ...(project.context || {}), debugging_notes: priorNotes };
  if (input.supersedes) {
    const needle = String(input.supersedes).trim().toLowerCase();
    if (needle) {
      baseContext = {
        ...baseContext,
        debugging_notes: priorNotes.filter((d) => !String(d?.summary || '').toLowerCase().includes(needle)),
      };
    }
  }
  // AN APPEND-ONLY CALLER AGES A FULL LOG; IT DOES NOT REWRITE ANYBODY'S NOTE.
  // See chooseAgedOut. A note that would collapse into a look-alike somebody
  // else filed is a targeted rewrite of THAT note, refused; one collapsing into
  // the caller's own is their note refreshed. Otherwise, into a full log, the
  // room is made here by the aging rules, before the merge — so the merge's
  // flood-aware cap never picks a victim on an append-only write.
  let agedOutNotes = [];
  if (mode === 'append') {
    const mine = new Set(workspace.actorIdentities(actor));
    const noteKeys = new Set([
      debuggingNoteKey(note),
      debuggingNoteKey({ summary: store.redactForStorage(String(note.summary || '')) }),
    ]);
    const current = baseContext?.debugging_notes || [];
    const lookAlike = current.find((entry) => noteKeys.has(debuggingNoteKey(entry)));
    // Somebody else already filed this finding (the same words, or the same
    // words but for a date or a count). Collapsing onto it would rewrite THEIR
    // note, so it is left exactly as it is — and that is a success, not a
    // refusal: the finding is in the log. Same answer hot paths give a path
    // that is already recorded. Nothing is saved.
    if (lookAlike && !(lookAlike.contributed_by && mine.has(lookAlike.contributed_by))) {
      const visibleLog = canViewSectionForActor(actor, project, policy, 'debugging_notes');
      return {
        project_id: project.project_id,
        project_name: project.project_name,
        ...(visibleLog ? { debugging_notes: priorNotes } : {}),
        replaced: null,
        evicted: [],
        aged_out: 0,
        stored: false,
        already_recorded: true,
      };
    }
    if (!lookAlike && current.length >= DEBUGGING_NOTE_LIMIT) {
      agedOutNotes = chooseAgedOut(actor, current, current.length - DEBUGGING_NOTE_LIMIT + 1,
        (entry, index) => (Date.parse(entry?.added_at) || 0) * 1e4 + index);
      if (!agedOutNotes) {
        throw appendWouldRewriteError(project, 'debugging_notes', 'need room in a full log whose notes are all pinned');
      }
      const going = new Set(agedOutNotes);
      baseContext = { ...baseContext, debugging_notes: current.filter((entry) => !going.has(entry)) };
    }
  }
  const updated = {
    ...project,
    context: mergeContextObject(baseContext, { debugging_notes: [note] }, mergeSourceFor(actor, project, policy, 'Recorded debugging finding')),
    updated_at: isoNow(),
  };
  // DID THIS WRITE DELETE SOMEBODY'S NOTE? debuggingNoteKey collapses notes that
  // differ only by a date or a counter, which is what keeps an hourly run-log
  // from evicting every real finding. Collapsing is right; not saying so is not
  // — the caller filed a finding, heard "recorded", and a note it never asked
  // about is gone. From a pre/post comparison: the request cannot know what it
  // collided with. An explicit supersede is excluded, because the caller asked.
  const incomingKey = debuggingNoteKey(note);
  const supersededNeedle = input.supersedes ? String(input.supersedes).trim().toLowerCase() : '';
  const storedSummaries = new Set(
    (updated.context?.debugging_notes || []).map((entry) => String(entry?.summary || ''))
  );
  const dropped = priorNotes.filter((entry) => {
    const summary = String(entry?.summary || '');
    if (!summary || storedSummaries.has(summary)) return false;
    return !(supersededNeedle && summary.toLowerCase().includes(supersededNeedle));
  });
  // AN APPEND-ONLY CALLER REMOVES NOTHING THAT IS NOT THEIR OWN. A collapse into
  // a look-alike and an eviction from a full log both delete a note; for a
  // caller who may not rewrite the section, that is only acceptable when the
  // note they displace is one they filed themselves. Refused before the save.
  if (mode === 'append') {
    const mine = new Set(workspace.actorIdentities(actor));
    const aging = new Set(agedOutNotes);
    if (dropped.some((entry) => !aging.has(entry) && (!entry?.contributed_by || !mine.has(entry.contributed_by)))) {
      throw appendWouldRewriteError(project, 'debugging_notes', 'replace or evict a note somebody else recorded');
    }
    // And the other half of a full log: the merge ranked the NEW note out
    // instead. Nothing changed, so say so rather than answer "recorded".
    // Compared on the key AS STORED too: the merge masks secrets in a summary.
    const ownKeys = new Set([
      debuggingNoteKey(note),
      debuggingNoteKey({ summary: store.redactForStorage(String(note.summary || '')) }),
    ]);
    if (!(updated.context?.debugging_notes || []).some((entry) => ownKeys.has(debuggingNoteKey(entry)))) {
      throw appendWouldRewriteError(project, 'debugging_notes', 'need room in a full log');
    }
  } else {
    // The same half for a caller who MAY rewrite the log: a full log of pinned
    // notes outranks an unpinned newcomer, and evictDebuggingNotesToCap drops
    // it. This answered 200 "recorded" with nothing stored.
    const ownKeys = new Set([
      debuggingNoteKey(note),
      debuggingNoteKey({ summary: store.redactForStorage(String(note.summary || '')) }),
    ]);
    // Which of two things happened decides what the caller should do: a log of
    // PINS needs an unpin, a full log of newer or weightier notes needs this
    // note dated or ranked higher. This said "they are pinned" for both.
    if (!(updated.context?.debugging_notes || []).some((entry) => ownKeys.has(debuggingNoteKey(entry)))) {
      const kept = baseContext.debugging_notes || [];
      if (kept.length >= DEBUGGING_NOTE_LIMIT && kept.every((entry) => entry?.pinned)) {
        throw listFullOfPinnedError(project, 'debug_log_full_pinned', 'debugging log');
      }
      throw debugLogRankedOutError(project);
    }
  }
  await saveProjectGuarded(updated, actor);
  const replacedNote = dropped.find((entry) => debuggingNoteKey(entry) === incomingKey);
  // AND WHAT ELSE WENT? A replacement is one note making room for its own
  // rewording; an EVICTION is the log being full, and the note it takes has
  // nothing to do with the one just filed. Same pre/post comparison, same
  // reason to report it — "Recorded" over a write that deleted somebody's
  // finding is the silent loss this reply exists to stop — but a separate
  // field, because the two mean different things to the caller: a replacement
  // is their own note refreshed, an eviction is a full log.
  //
  // Gated on the log actually being full, because "gone from the stored list"
  // has one other cause: a note whose summary is newly redacted on this pass
  // survives under different text and would otherwise be reported as dropped.
  // Below the cap nothing can have been evicted, so the gate is exact rather
  // than cautious.
  const storedNotes = updated.context?.debugging_notes || [];
  const evicted = storedNotes.length >= DEBUGGING_NOTE_LIMIT
    ? dropped.filter((entry) => entry !== replacedNote).map((entry) => String(entry.summary))
    : [];
  // Note TEXT goes back only to somebody who may read the section — the stored
  // log, and the words of whatever was replaced or evicted. A blind append hears
  // that its own note was recorded, and nothing about anybody else's.
  const visible = canViewSectionForActor(actor, project, policy, 'debugging_notes');
  return {
    project_id: updated.project_id,
    project_name: updated.project_name,
    ...(visible ? { debugging_notes: storedNotes } : {}),
    replaced: visible && replacedNote ? String(replacedNote.summary) : null,
    evicted: visible ? evicted : [],
    // How many older notes left to make room — a count, never their text, so a
    // caller the share does not let read the log still hears that it is full.
    aged_out: evicted.length,
  };
}

// Verify primitive: an agent that re-confirmed a stored claim still holds writes
// verified_at (+ the commit it checked at) back, so the NEXT session sees
// "verified Xd ago" and is spared re-opening the code. Targets the volatile claims
// the hard-stale banner tells agents to distrust: a recent decision (matched by
// summary) or current_status. Write-path only — no LLM, no extra read cost.
// Compare-and-swap guarded; re-run from a fresh read when the swap loses.
// See withContextWriteRetry.
async function confirmClaim(actor, projectId, input) {
  return withContextWriteRetry(() => confirmClaimOnce(actor, projectId, input));
}

async function confirmClaimOnce(actor, projectId, { claim, verified_commit } = {}) {
  // Raw row for the same reason as recordHotPaths: this saves the whole context.
  const loaded = await loadProjectForWrite(actor, projectId);
  if (!loaded) throw new Error('project_not_found');
  const { project, policy } = loaded;
  // THE GATE COMES BEFORE THE MATCH, and the match only reads what the gate let
  // through.
  //
  // This matched the claim against the RAW decision log and status first and
  // asked permission second — and the refusal named the section it matched. So a
  // teammate the share withholds both from could send claim:"a" and learn from
  // 403 recent_decisions vs 200 null whether any hidden decision contains "a",
  // then narrow it a letter at a time: an oracle over text they may not read.
  //
  // Now the sections this actor may stamp are decided from the POLICY alone,
  // before any stored text is looked at; a caller with neither is refused the
  // same way whatever the claim says, and a caller with one never has the other
  // consulted. Stamping verified_at is a write, so the bar is edit (which
  // already requires view — canEditSectionForActor).
  const mayStamp = (sectionKey) => isProjectOwner(actor, project) || canEditSectionForActor(actor, project, policy, sectionKey);
  const mayDecisions = mayStamp('recent_decisions');
  const mayStatus = mayStamp('current_status');
  if (!mayDecisions && !mayStatus) {
    assertCanEditSections(actor, project, policy, ['recent_decisions', 'current_status']);
  }
  const context = { ...(project.context || {}) };
  const now = isoNow();
  const norm = (s) => String(s || '').trim().toLowerCase();
  const needle = norm(claim);
  if (!needle) return { project_id: project.project_id, verified: null };

  let verified = null;
  // 1) Match a recent decision by summary (substring either direction).
  const decisions = mayDecisions && Array.isArray(context.recent_decisions) ? [...context.recent_decisions] : [];
  const idx = decisions.findIndex((d) => {
    const s = norm(d?.summary);
    return s && (s.includes(needle) || needle.includes(s));
  });
  if (idx >= 0) {
    decisions[idx] = {
      ...decisions[idx],
      verified_at: now,
      ...(verified_commit ? { verified_commit: String(verified_commit) } : {}),
    };
    context.recent_decisions = decisions;
    verified = { kind: 'decision', summary: decisions[idx].summary };
  } else if (mayStatus && (needle === 'status' || needle === 'current_status' || (context.current_status && norm(context.current_status).includes(needle)))) {
    // 2) Otherwise confirm current_status (the most volatile claim).
    context.status_verified_at = now;
    if (verified_commit) context.status_verified_commit = String(verified_commit);
    verified = { kind: 'current_status', value: context.current_status || '' };
  }

  if (!verified) return { project_id: project.project_id, verified: null };
  await saveProjectGuarded({ ...project, context, updated_at: now }, actor);
  return { project_id: project.project_id, project_name: project.project_name, verified, verified_at: now };
}

// Below this ranking score an entity is filler — better to return fewer, sharper
// suggestions than to pad the list out to limit.
const NEXT_BEST_RELEVANCE_FLOOR = 0.55;

function buildEntityReason(node, overview) {
  const importance = node.metadata?.importance || 'normal';
  const type = node.metadata?.entity_type || node.node_type;
  const hits = Number(node.metadata?.retrieval_hits || 0);
  const usagePart = hits > 0
    ? ` Retrieved ${hits}× before${node.metadata?.last_selected_at ? ` (last ${timeAgo(node.metadata.last_selected_at)})` : ''}.`
    : '';
  const pinnedPart = node.metadata?.pinned ? ' Pinned by you.' : '';
  const selectorPart = overview.selection_explanations?.[0]
    ? ` Top selector: ${overview.selection_explanations[0].reason}`
    : '';
  return `${importance} importance ${type} for the active project.${usagePart}${pinnedPart}${selectorPart}`.trim();
}

async function getNextBestContext(actor, options = {}) {
  const { activeProject } = await resolveActiveWorkspaceContext(actor, options);
  const overview = await getWorkspaceOverview(actor, {
    mode: 'startup',
    verbosity: 'standard',
    include: ['knowledge', 'tools', 'capabilities', 'recent'],
    project_id: options.project_id || activeProject?.project_id || undefined,
    cwd: options.cwd,
    track_selection: options.track_selection,
  });
  const ranked = await getWorkspaceEntities(actor, {
    limit: Math.max(Number(options.limit || 5), 3) * 2,
    project_id: options.project_id || activeProject?.project_id || undefined,
    cwd: options.cwd,
    query: options.query || '',
    track_selection: options.track_selection,
  });

  const openQuestionSuggestions = (activeProject?.context?.open_questions || [])
    .slice(0, Math.max(Number(options.limit || 5), 3))
    .map((question) => ({
      kind: 'open_question',
      label: question,
      reason: 'Unresolved project question should be answered before this work is considered closed.',
      score: 0.95,
      project_id: activeProject.project_id,
      query: `open question: ${question}`,
    }));

  // Stale blocker detection: if blocking_issue is set and the project has recent decisions
  // (indicating work is continuing), surface a prompt to confirm or clear the blocker.
  const staleBlockerSuggestions = (() => {
    const blocker = activeProject?.context?.blocking_issue;
    if (!blocker) return [];
    const decisions = activeProject?.context?.recent_decisions || [];
    const lastUpdated = activeProject?.context?.last_updated;
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const hasRecentWork = decisions.some((d) => (d.decided_at || '') > sevenDaysAgo);
    const blockerIsOld = lastUpdated && lastUpdated < sevenDaysAgo;
    if (!hasRecentWork && !blockerIsOld) return [];
    return [{
      kind: 'open_question',
      label: `Is this blocker still active? "${blocker.slice(0, 80)}${blocker.length > 80 ? '…' : ''}"`,
      reason: 'Blocking issue was set but recent work has continued. Call blocker_resolved if it has been cleared.',
      score: 0.88,
      project_id: activeProject.project_id,
      query: `blocker status: ${blocker}`,
    }];
  })();

  // Precision over recall: drop low-relevance filler before taking the top few.
  // The open-question / blocker / query fallbacks below guarantee a non-empty result.
  const relevantRanked = ranked.filter((node) => Number(node._ranking_score || 0) >= NEXT_BEST_RELEVANCE_FLOOR);
  const entitySuggestions = relevantRanked.slice(0, Math.max(Number(options.limit || 5) - 1, 1)).map((node) => ({
    kind: 'entity',
    label: node.title,
    reason: buildEntityReason(node, overview),
    score: Math.min(1, Number(node._ranking_score || 0.5)),
    node_id: node.node_id,
    canonical_key: node.canonical_key,
  }));

  const querySuggestions = activeProject
    ? [{
        kind: 'query',
        label: `Show active tools for ${activeProject.project_name}`,
        reason: 'Tool and environment inventory is usually the next most relevant drill-down after the startup brief.',
        score: 0.72,
        query: `active tools for ${activeProject.project_name}`,
      }]
    : [{
        kind: 'query',
        label: 'Show recent high-importance workspace knowledge',
        reason: 'No active project was resolved, so the next best retrieval is broader workspace memory.',
        score: 0.64,
        query: 'recent high-importance workspace knowledge',
      }];

  const openQuestionCount = activeProject?.context?.open_questions?.length || 0;

  // ── Unclaimed board work ────────────────────────────────────────────────────
  // Hand out only cards no OTHER agent is on, so two agents asking "what next"
  // are pointed at different work instead of the same card. The partition is the
  // shared definition of "held" (holds expire; a card whose holder went away is
  // available again by doing nothing).
  //
  // The exclusion is REPORTED, always. A silently shortened list reads as "there
  // is no work left" — the caller then acts confidently on a filtered view it
  // does not know is filtered, which is the same class of bug as silent
  // truncation. If work is being withheld, the summary says so and names who.
  const boardCards = (activeProject?.context?.todo_items || [])
    .filter((card) => ['backlog', 'in_progress'].includes(String(card.phase || '').toLowerCase()));
  const { available: availableCards, excluded: excludedCards } =
    partitionHeldCards(boardCards, options.session_id || null);
  const boardSuggestions = availableCards
    .slice(0, Math.max(Number(options.limit || 5) - 1, 1))
    .map((card) => {
      const own = holdState(card).holder === String(options.session_id || '') && holdState(card).held;
      return {
        kind: 'board_card',
        label: card.title,
        reason: own
          ? 'You are already holding this card — finish or release it before taking new work.'
          : 'Unclaimed card on the task board. No other active agent is holding it.',
        // Own in-progress work outranks a fresh card: resuming beats starting.
        score: own ? 0.97 : 0.93,
        query: `task board card: ${card.title}`,
      };
    });
  const excludedLine = formatExcludedLine(excludedCards);

  return NextBestContextResultSchema.parse({
    summary: activeProject
      ? `Most relevant next context for ${activeProject.project_name}. ${overview.current_understanding.confidence_summary || ''}${openQuestionCount ? ` ${openQuestionCount} open question${openQuestionCount === 1 ? '' : 's'} need attention.` : ''}${excludedLine ? ` ${excludedLine}` : ''}`.trim()
      : 'Most relevant next context for the current workspace.',
    suggestions: [...boardSuggestions, ...openQuestionSuggestions, ...staleBlockerSuggestions, ...entitySuggestions, ...querySuggestions].slice(0, Number(options.limit || 5)),
    provenance: activeProject
      ? [{ kind: 'active_project', label: activeProject.project_name, project_id: activeProject.project_id, confidence: 1 }]
      : [{ kind: 'global', label: 'Workspace-level fallback', confidence: 0.7 }],
  });
}

function resolveMatch(input) {
  const sorted = [...(input.candidates || [])].sort((a, b) => (b.score || 0) - (a.score || 0));
  const top = sorted[0];
  const second = sorted[1];
  const confidence = top?.score || 0;
  const ambiguous = !top || !!(second && confidence - (second.score || 0) < 0.1);

  return ProjectMatchResultSchema.parse({
    match_decision: ambiguous ? 'ambiguous' : confidence >= 0.75 ? 'matched_existing' : 'ambiguous',
    confidence,
    project_candidate: top ? {
      project_id: top.project_id,
      project_name: top.project_name,
      reason: `Highest scoring candidate for ${input.tool}`,
      score: top.score,
    } : undefined,
    should_create_project: !top,
    needs_user_confirmation: ambiguous,
  });
}

async function getPreferences(actor) {
  const ownerKey = getActorKey(actor);
  const prefs = await store.getPreferences(ownerKey);
  if (!prefs) {
    const defaults = defaultPreferences();
    await store.savePreferences(ownerKey, defaults);
    return defaults;
  }
  return prefs;
}

async function updatePreferences(actor, input) {
  // Preferences are stored per WORKSPACE: `paused` here pauses every teammate's
  // brief, and security.excluded_fields strips sections from all of them. A
  // viewer's dashboard session carries context:write (session scopes come from
  // the org-level users.role), so the workspace role is what must refuse it.
  await assertWorkspaceWritable(actor, getActorKey(actor));
  const current = await getPreferences(actor);
  const defaults = { enabled: true, verbosity: 'standard' };
  const merged = InjectionPreferenceSchema.parse({
    paused: typeof input.paused === 'boolean' ? input.paused : current.paused,
    tools: {
      claude_web:  { ...(current.tools.claude_web  || defaults), ...(input.tools?.claude_web  || {}) },
      chatgpt_web: { ...(current.tools.chatgpt_web || defaults), ...(input.tools?.chatgpt_web || {}) },
      cursor:      { ...(current.tools.cursor      || defaults), ...(input.tools?.cursor      || {}) },
      claude_code: { ...(current.tools.claude_code || defaults), ...(input.tools?.claude_code || {}) },
      codex:       { ...(current.tools.codex       || defaults), ...(input.tools?.codex       || {}) },
    },
  });

  // Merge security subkey alongside validated injection prefs — stored as free-form JSONB
  const security = input.security !== undefined
    ? { ...(current.security || {}), ...input.security }
    : (current.security || undefined);

  await store.savePreferences(getActorKey(actor), security ? { ...merged, security } : merged);
  return security ? { ...merged, security } : merged;
}

function applyExclusions(context, excludedFields) {
  if (!excludedFields?.length) return context;
  const result = { ...context };
  for (const field of excludedFields) result[field] = undefined;
  return result;
}

async function cleanupCompletedGraphNodes(ownerKey, projectId, delta, previousContext, mergedContext) {
  const fuzzy = (a, b) => {
    const al = (a || '').toLowerCase(), bl = (b || '').toLowerCase();
    return al.includes(bl) || bl.includes(al);
  };
  // A node's TITLE is its text clipped to 80 characters plus "..."
  // (contextGraphService), so for anything longer the substring test above can
  // never pass in either direction: the title is not inside the full text (the
  // dots) and the full text is not inside the title. Every task longer than 80
  // characters stayed an open task node after the brief moved on to the next
  // one, and an untyped resolve of a decision in the same words was then
  // refused as ambiguous with that stale task. The key the node was filed under
  // is derived from the full text, so it is matched too.
  const names = (node, nodeType, text) => fuzzy(node.title, text)
    || (Boolean(String(text || '').trim())
      && entityGroupKey(node.canonical_key) === entityGroupKey(`${nodeType}:${graphService.normalizeKey(text)}`));

  // Build list of (nodeType, titles) to delete
  const toRemove = [];
  if (delta.resolved_questions?.length) toRemove.push({ nodeType: 'question', titles: delta.resolved_questions });
  if (delta.completed_goals?.length) toRemove.push({ nodeType: 'task', titles: delta.completed_goals });

  // Build list of (nodeType, titles) to mark resolved (status update, not delete)
  const toResolve = [];
  if (delta.resolved_decisions?.length) toResolve.push({ nodeType: 'decision', titles: delta.resolved_decisions });

  // When current_task changes, remove the old task node
  const oldTask = previousContext?.current_task;
  const newTask = mergedContext?.current_task;
  if (oldTask && oldTask !== newTask) {
    const existing = toRemove.find(r => r.nodeType === 'task');
    if (existing) existing.titles.push(oldTask);
    else toRemove.push({ nodeType: 'task', titles: [oldTask] });
  }

  if (!toRemove.length && !toResolve.length) return;

  const allNodeTypes = [...new Set([...toRemove.map(r => r.nodeType), ...toResolve.map(r => r.nodeType)])];
  const nodes = await store.listGraphNodes(ownerKey, { nodeTypes: allNodeTypes, projectId, limit: 200 });

  const toDelete = [];
  for (const { nodeType, titles } of toRemove) {
    for (const node of nodes) {
      if (node.node_type !== nodeType) continue;
      if (titles.some(t => names(node, nodeType, t))) toDelete.push(node.node_id);
    }
  }

  const toMarkResolved = [];
  for (const { nodeType, titles } of toResolve) {
    for (const node of nodes) {
      if (node.node_type !== nodeType) continue;
      if (titles.some(t => names(node, nodeType, t))) toMarkResolved.push(node);
    }
  }

  const ops = [];
  if (toDelete.length) {
    console.log(`[GRAPH] Auto-cleanup removing ${toDelete.length} completed node(s) for project ${projectId}`);
    ops.push(...toDelete.map(nodeId => store.deleteGraphNode(ownerKey, nodeId).catch(() => {})));
  }
  if (toMarkResolved.length) {
    const now = new Date().toISOString();
    console.log(`[GRAPH] Auto-resolve marking ${toMarkResolved.length} decision(s) resolved for project ${projectId}`);
    ops.push(...toMarkResolved.map(node => store.upsertGraphNode({
      ...node,
      metadata: { ...node.metadata, status: 'resolved', resolved_at: now },
      updated_at: now,
      last_seen_at: now,
    }).catch(() => {})));
  }

  if (ops.length) await Promise.all(ops);
}

// Resolve exactly ONE open question, or resolve nothing and say why.
//
// This is the only non-destructive way to retire a question. The alternative is
// cleanup_context (finish_task), which also clears the task, the command log and
// the task steps — so a brief that accumulates dead questions has, until now, had
// only a wrecking ball pointed at it. Being precise is therefore the whole point
// of the endpoint, and it was the one thing it did not do.
//
// It used to be `open_questions.filter(q => !fuzzyMatch(q, question))`, where
// fuzzyMatch is bidirectional substring. One call deleted EVERY question the
// query appeared in and recorded a single decision naming only the query, so the
// caller could not even tell what had been thrown away. Worse, the route's
// `!question` guard passes a whitespace-only string, `.trim()` turns it into '',
// and `fuzzyMatch(q, '')` is true for every q — `{question: '   '}` silently
// emptied the entire list. That is exactly the board wipe that remove_todos
// caused (see mergeContextObject in packages/shared-context), and the fix is the
// same shape.
//
// Resolution order per call: exact (normalized) text, then fuzzy — and fuzzy only
// counts when it lands on exactly ONE question. Zero matches or several resolve
// NOTHING and hand back the candidates so the caller can disambiguate. The
// decision is appended only when a question was actually removed, so the decision
// log can never claim a resolution that did not happen. Every other field —
// current_task, commands, task_steps, the remaining questions — is carried
// through untouched.
// Compare-and-swap guarded; re-run from a fresh read when the swap loses.
// See withContextWriteRetry.
async function resolveQuestion(actor, projectId, question, answer) {
  return withContextWriteRetry(() => resolveQuestionOnce(actor, projectId, question, answer));
}

async function resolveQuestionOnce(actor, projectId, question, answer) {
  const ownerKey = getActorKey(actor);
  // This read store.getProject directly: no visibility check and no write check,
  // so any project id in the workspace could have a question resolved and a
  // decision appended — including a colleague's personal project.
  const loaded = await loadProjectForWrite(actor, projectId);
  if (!loaded) throw new Error('project_not_found');
  const { project, policy } = loaded;
  assertCanEditSections(actor, project, policy, ['open_questions', 'recent_decisions']);

  const original = project.context.open_questions || [];
  const query = String(question ?? '').trim();
  // An empty query is not a request to resolve everything.
  if (!query) return { project, resolved: null, reason: 'unmatched', candidates: [] };

  const fuzzyMatch = (a, b) => { const al = a.toLowerCase(), bl = b.toLowerCase(); return al.includes(bl) || bl.includes(al); };
  const norm = (s) => String(s || '').trim().toLowerCase();
  // Carry the ORIGINAL index through matching. Matching over a filtered copy and
  // then removing by value is what lets one call take out a sibling that merely
  // shares text; an index removes the one question that was actually chosen.
  const pool = original
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => typeof q === 'string' && q.trim());

  const exact = pool.filter(({ q }) => norm(q) === norm(query));
  // Every exact hit has, by construction, the same normalized text — so exact
  // matches are never ambiguous about WHICH question was meant, only about which
  // duplicate row holds it. Take the first. Fuzzy is the only path that can point
  // at genuinely different questions, so that is the path that must be unanimous.
  const hits = exact.length ? [exact[0]] : pool.filter(({ q }) => fuzzyMatch(q, query));

  if (hits.length !== 1) {
    return {
      project,
      resolved: null,
      reason: hits.length > 1 ? 'ambiguous' : 'unmatched',
      candidates: hits.map(({ q }) => q),
    };
  }

  const targetIndex = hits[0].i;
  const resolved = original[targetIndex];
  const nextQuestions = original.filter((_, i) => i !== targetIndex);

  const newDecision = { summary: `Decided: ${answer}`, reasoning: resolved, decided_at: isoNow(), importance: 'normal' };
  // Through the one eviction rule every other append uses. A bare slice(-20)
  // dropped the OLDEST entry whatever it was — a critical decision went before a
  // resolved one (scan 27) — which is exactly what capDecisions exists to stop.
  const nextDecisions = capDecisions([...(project.context.recent_decisions || []), newDecision], { keep: [newDecision.summary] });

  const mergedContext = ContextObjectSchema.parse({
    ...project.context,
    open_questions: nextQuestions,
    recent_decisions: nextDecisions,
    last_updated: isoNow(),
  });
  const updated = { ...project, context: mergedContext };
  await saveProjectGuarded(updated, actor);

  // THE DECISION IT RECORDED IS A GRAPH NODE NOW, not after the next update. This
  // wrote the brief and nothing else, so the answer was in recent_decisions but
  // not in recall(action:"entities"), and a resolve of it by that exact text
  // found no node — the entity search then fell through to whatever other
  // project's decision it could find. The same derivation applyExtraction runs,
  // over the same redacted copy (a key is normalised and can carry a secret past
  // the store's own pass). Best-effort: the brief is already saved.
  try {
    const land = await graphRebuildLanding(actor, ownerKey, projectId);
    await graphService.recordGraphArtifacts({
      ownerKey,
      project: { ...updated, context: store.redactForStorage(mergedContext) },
      session: { session_id: 'manual', tool: 'manual' },
      input: store.redactForStorage({ chunk: { role: 'user', text: `${resolved}\n${newDecision.summary}` } }),
      land,
    });
    if (!land) await settleSoloEraLandings(actor, ownerKey);
  } catch (err) {
    console.warn('[GRAPH] Record after resolve_question failed:', err.message);
  }

  // Only the question that was actually removed is passed downstream. Passing the
  // raw query here fanned the same substring match out over the graph nodes.
  cleanupCompletedGraphNodes(ownerKey, projectId, { resolved_questions: [resolved] }, project.context, mergedContext)
    .catch(() => {});

  try {
    const { getPublisher } = require('../config/redis');
    await getPublisher().publish(`context:${ownerKey}:${projectId}`, JSON.stringify({ kind: 'context_updated', project_id: projectId }));
  } catch { /* non-fatal */ }

  return { project: projectViewForActor(actor, updated, policy), resolved, reason: 'resolved', candidates: [] };
}

// ─── Resolve ONE decision in ONE project's brief ───────────────────────────
//
// mark_resolved (hosted and local, through POST /projects/:id/decisions/resolve)
// when the caller names the project. The decision log is the thing a resolve is
// for, and it is per project; the graph node is not — decision nodes are unique
// per owner and keep the FIRST project that wrote them — so resolving through
// the node flipped whichever project got there first. The same decision recorded
// in repos A and B, resolved "in B", resolved A and left B open for good, and
// every retry answered "already resolved — nothing to do" (judged on A's node).
// A Trail copy's resolve flipped its source; a member's flipped the owner's.
//
// So the named project's brief is read and written here, by the decision's own
// text: exact after normalising case and whitespace (the round-25 rule). A text
// that is cut short — a title copied from recall(action:"entities"), 79
// characters + "..." — or a prefix of 80 characters or more (a decision longer
// than the 500 characters a hosted `title` admits can be named by its opening)
// resolves only when exactly ONE decision in this project starts with it, and
// it is open (a resolved one sharing the opening makes it ambiguous, scan 29).
// "Already resolved" is judged on this brief. Only this project's own decision
// node is marked; no other project's brief or node is touched.
//
// Outcomes: resolved | already_resolved | ambiguous | not_found | not_editable
// (held only in subprojects the caller cannot change). Each carries
// `message`, the words both dispatchers reply with, so they cannot drift.
const DECISION_PREFIX_MIN = 80;
//
// `untyped`: the caller gave no entity_type, so the text may name a task, a
// question or anything else as well as a decision. With no project_id this
// used to resolve a DECISION carrying a task's exact text (or one the task's
// text merely opens) and reply as if the task were done (scan 28). So an open
// non-decision entity in this project named exactly by the text is looked for
// first: beside a decision named exactly, it is ambiguous and both are named;
// without one, the brief's looser readings (an opening, a headline) never pick
// a decision over it — the outcome is not_found and the dispatcher's entity
// search resolves the one thing named exactly.
async function resolveProjectDecision(actor, projectId, { title, notes, untyped = false } = {}) {
  if (untyped) {
    const others = await openNonDecisionsNamed(actor, projectId, title).catch(() => []);
    if (others.length) {
      const probe = await resolveDecisionInBrief(actor, projectId, { title, dryRun: true, exactOnly: true });
      if (probe.outcome !== 'resolvable' && probe.outcome !== 'ambiguous') {
        return { ...probe, outcome: 'not_found', candidates: [] };
      }
      const decisionsNamed = probe.outcome === 'resolvable' ? probe.resolved : probe.candidates;
      const shown = store.redactForStorage(String(title || '').trim());
      const types = ['decision', ...new Set(others.map((e) => e.node_type || e.metadata?.entity_type))];
      const list = [
        ...decisionsNamed.map((summary) => `  - "${summary}" (decision)`),
        ...others.map((e) => `  - "${e.title}" (${e.node_type || e.metadata?.entity_type})`),
      ].join('\n');
      return {
        project_id: probe.project_id,
        project_name: probe.project_name,
        outcome: 'ambiguous',
        candidates: decisionsNamed,
        message: `"${shown}" names ${decisionsNamed.length + others.length} open entries in ${probe.project_name}, so nothing was resolved — resolving the wrong one is not recoverable from here.\n${list}\nRe-run with entity_type (one of: ${types.join(', ')}).`,
      };
    }
  }
  const outcome = await resolveDecisionInBrief(actor, projectId, { title, notes });
  if (outcome.outcome !== 'not_found') return outcome;
  return resolveDecisionInSubproject(actor, outcome, { title, notes });
}

// The OPEN entities of another type than decision in `projectId` (or filed
// under no project) that `title` names exactly: by title, case and outer
// whitespace aside, or by the canonical key the text slugs to — the hosted
// entityNamedExactly's rules for a non-decision. Never a prefix.
async function openNonDecisionsNamed(actor, projectId, title) {
  const wanted = String(title || '').trim().toLowerCase();
  if (!wanted) return [];
  const slug = graphService.normalizeKey(title);
  const hits = await getWorkspaceEntities(actor, { query: title, project_id: projectId, include_inferred: false, limit: 10 });
  return (hits || []).filter((entity) => {
    const type = entity.node_type || entity.metadata?.entity_type;
    if (!type || type === 'decision') return false;
    if (entity.project_id && entity.project_id !== projectId) return false;
    if (graphService.isInactiveGraphNode(entity)) return false;
    return String(entity.title || '').trim().toLowerCase() === wanted || String(entity.canonical_key || '') === `${type}:${slug}`;
  });
}

// A PARENT NAMES ITS SUBPROJECTS' DECISIONS TOO.
//
// A brief is one project's: a parent's does not carry its subprojects'
// decisions (nothing merges them), so a decision recorded in a subproject is in
// no decision log of the umbrella. Naming the umbrella — what a caller in the
// repo root does, and what an older session bound to — refused it as "a
// decision in another project" (scan 27). When the named project does not hold
// the decision and exactly ONE of its subprojects the caller can see does, the
// resolve is applied there and the reply says where. Two subprojects holding it
// is a guess, and resolving the wrong one is not undoable from here, so that is
// refused with their names.
async function resolveDecisionInSubproject(actor, missed, { title, notes }) {
  const ownerKey = getActorKey(actor);
  let children = [];
  try {
    children = await store.getSubprojects(ownerKey, missed.project_id, {
      actorIdentities: workspace.actorIdentities(actor),
      system: actor?.type === 'system' || ownerKey === 'org-system',
      isWorkspaceOwner: (await workspace.resolveRole(actor, ownerKey).catch(() => null)) === 'owner',
    });
  } catch {
    return missed;
  }
  if (!children.length) return missed;
  const held = [];
  const locked = [];
  for (const child of children) {
    try {
      const probe = await resolveDecisionInBrief(actor, child.project_id, { title, dryRun: true });
      // A subproject this caller cannot write is not a place to redirect them.
      if (probe.outcome === 'resolvable' && probe.editable === false) locked.push(probe);
      else if (probe.outcome !== 'not_found') held.push(probe);
    } catch {
      // Nor is one they cannot load for writing at all.
    }
  }
  const parentName = missed.project_name || missed.project_id;
  if (!held.length && locked.length) {
    // The only places it is recorded are ones this caller can read but not
    // change: say which, and why, rather than "not found" or a bare 403.
    const shown = store.redactForStorage(String(title || '').trim());
    const where = locked.map((probe) => `  - ${probe.project_name || probe.project_id} (${probe.project_id}): ${probe.why || 'you can read it but not change it.'}`).join('\n');
    return {
      ...missed,
      outcome: 'not_editable',
      candidates: [],
      subprojects: locked.map((probe) => probe.project_id),
      message: `"${shown}" is not a decision in ${parentName} itself; it is recorded in ${locked.length === 1 ? 'its subproject' : `${locked.length} of its subprojects`} you cannot change, so nothing was resolved.\n${where}`,
    };
  }
  if (!held.length) return missed;
  const where = (probe) => `subproject ${probe.project_name || probe.project_id} of ${parentName}`;
  if (held.length > 1) {
    const list = held.map((probe) => `  - ${probe.project_name || probe.project_id}: ${probe.project_id}`).join('\n');
    return {
      ...missed,
      outcome: 'ambiguous',
      candidates: [],
      subprojects: held.map((probe) => probe.project_id),
      message: `"${store.redactForStorage(String(title || '').trim())}" is not a decision in ${parentName} itself but is in ${held.length} of its subprojects, so nothing was resolved.\n${list}\nRe-run with the project_id of the subproject you mean.`,
    };
  }
  const [only] = held;
  const settled = only.outcome === 'resolvable'
    ? await resolveDecisionInBrief(actor, only.project_id, { title, notes })
    : only;
  return {
    ...settled,
    parent_project_id: missed.project_id,
    message: `In ${where(settled)}, where this decision is recorded (it is not in ${parentName}'s own decision log):\n${settled.message}`,
  };
}

// Compare-and-swap guarded; re-run from a fresh read when the swap loses.
// See withContextWriteRetry.
async function resolveDecisionInBrief(actor, projectId, input) {
  return withContextWriteRetry(() => resolveDecisionInBriefOnce(actor, projectId, input));
}

async function resolveDecisionInBriefOnce(actor, projectId, { title, notes, dryRun = false, exactOnly = false } = {}) {
  const asked = String(title || '').trim();
  if (!asked) {
    const err = new Error('decision_title_required');
    err.publicMessage = 'title is required — the complete text of the decision, as the brief shows it.';
    throw err;
  }
  const loaded = await loadProjectForWrite(actor, projectId, { allowArchived: true });
  if (!loaded) throw new Error('project_not_found');
  const { project, policy } = loaded;
  const name = project.project_name || projectId;
  const base = { project_id: project.project_id, project_name: name };
  // A share that withholds decisions from this caller: there is nothing here
  // they may read, so nothing here they may resolve — and saying which texts
  // matched would read the log out to them.
  if (!canViewSectionForActor(actor, project, policy, 'recent_decisions')) {
    return { ...base, outcome: 'not_found', candidates: [], message: `No decision in ${name} reads "${store.redactForStorage(asked)}".` };
  }
  const decisions = Array.isArray(project.context?.recent_decisions) ? project.context.recent_decisions : [];
  const norm = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();

  const pick = (wanted) => {
    // Only the decision's own text, whole: what an untyped resolve weighs
    // against a task of the same text (resolveProjectDecision).
    if (exactOnly) {
      const indexes = decisions
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry && !entry.resolved && decisionNodeMatches(entry.summary, { title: '', summary: wanted, canonical_key: '' }))
        .map(({ index }) => index);
      return { indexes, ambiguous: [] };
    }
    // The asked text stands in as a node whose only text is its summary, so a
    // cut shape (82, 242 or 280 characters) reads as a cut, never as a whole.
    const probe = { title: '', summary: wanted, canonical_key: '' };
    const found = decisionsResolvedBy(decisions, probe);
    if (found.indexes.length || found.ambiguous.length) return found;
    // THE LOOSER READINGS COUNT EVERY DECISION THEY NAME, OPEN OR RESOLVED.
    // Counting only the open ones, a cut shared by X and Y resolved Y the moment
    // X was resolved — by the full text, by a teammate, by another session —
    // though the caller, sending the same cut again, meant X (scan 29). So one
    // open decision names it only when no resolved decision of another text
    // shares the reading; beside one it is refused, both named, the resolved one
    // marked. None open falls through, to already_resolved when one is done.
    const named = (reads) => {
      const hits = decisions.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry && reads(entry));
      const open = hits.filter(({ entry }) => !entry.resolved);
      if (!open.length) return null;
      const openTexts = new Set(open.map(({ entry }) => norm(entry.summary)));
      // A resolved entry with the very text of an open one is that decision
      // recorded again, not a sibling.
      const shown = hits.filter(({ entry }) => !entry.resolved || !openTexts.has(norm(entry.summary)));
      if (shown.length === 1) return { indexes: [open[0].index], ambiguous: [] };
      return {
        indexes: [],
        ambiguous: shown.map(({ entry }) => entry.summary),
        resolved: shown.filter(({ entry }) => entry.resolved).map(({ entry }) => entry.summary),
      };
    };
    if (wanted.length >= DECISION_PREFIX_MIN && decisionClipVisible(wanted, 'summary') === null) {
      const starts = named((entry) => norm(entry.summary).startsWith(norm(wanted)));
      if (starts) return starts;
    }
    // The brief's own cut, dots and all (decisionShownOpening).
    const opening = decisionShownOpening(wanted);
    if (opening) {
      const starts = named((entry) => norm(entry.summary).startsWith(norm(opening)));
      if (starts) return starts;
    }
    // recall's sections:["all"] prints a long decision as its stored headline,
    // which need not be an opening of it at all ("Set up the payout exporter."
    // heading 500 characters). Named whole, it names the one decision carrying it.
    const headed = named((entry) => entry.headline && norm(entry.headline) === norm(wanted));
    if (headed) return headed;
    return found;
  };
  const isAlready = (wanted) => decisions.find((d) => d?.resolved && (
    decisionNodeMatches(d.summary, { title: '', summary: wanted, canonical_key: '' })
    || (wanted.length >= DECISION_PREFIX_MIN && norm(d.summary).startsWith(norm(decisionClipVisible(wanted, 'summary') ?? wanted)))
    || (decisionShownOpening(wanted) !== null && norm(d.summary).startsWith(norm(decisionShownOpening(wanted))))
    || (d.headline && norm(d.headline) === norm(wanted))
  ));

  // As sent first (a row written before storage redaction still holds the clear
  // text), then as it would have been stored: the brief keeps a secret masked,
  // so the text a caller pastes back in clear never matched it.
  const masked = store.redactForStorage(asked);
  let wanted = asked;
  let found = pick(asked);
  if (!found.indexes.length && !found.ambiguous.length && masked !== asked) {
    wanted = masked;
    found = pick(masked);
  }
  const shown = store.redactForStorage(wanted);

  if (found.ambiguous.length) {
    // A resolved decision is listed when the text opens it too (pick): it is
    // the one a caller sending a stale cut most likely meant.
    const done = new Set(found.resolved || []);
    const list = found.ambiguous.slice(0, 8).map((summary) => `  - "${summary}"${done.has(summary) ? ' — already resolved' : ''}`).join('\n');
    return {
      ...base,
      outcome: 'ambiguous',
      candidates: found.ambiguous,
      message: `"${shown}" matches ${found.ambiguous.length} ${done.size ? '' : 'open '}decisions in ${name}, so nothing was resolved — resolving the wrong one is not recoverable from here.\n${list}\nRe-run with the exact, complete decision text.`,
    };
  }
  if (!found.indexes.length) {
    const already = isAlready(asked) || (masked !== asked ? isAlready(masked) : null);
    if (already) {
      return { ...base, outcome: 'already_resolved', summary: already.summary, message: `"${already.summary}" is already resolved in ${name} — nothing to do.` };
    }
    const near = decisions
      .filter((d) => d && !d.resolved && d.summary)
      .map((d) => ({ summary: d.summary, score: jaccardSimilarity(wanted, d.summary) }))
      .filter((c) => c.score >= 0.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((c) => c.summary);
    return {
      ...base,
      outcome: 'not_found',
      candidates: near,
      message: `No open decision in ${name} reads "${shown}", so nothing was resolved.`
        + (near.length ? `\nClosest:\n${near.map((summary) => `  - "${summary}"`).join('\n')}\nRe-run with the exact, complete decision text.` : ''),
    };
  }

  // A probe (resolveDecisionInSubproject) asks whether it is here — and
  // whether this caller could resolve it here. The probe skipped the edit
  // check, so a parent's resolve was redirected into a member's private child
  // the caller can only read and failed there with a share_write_forbidden that
  // named no project (scan 28).
  if (dryRun) {
    let editable = true;
    let why = null;
    try {
      assertCanEditSections(actor, project, policy, ['recent_decisions']);
    } catch (err) {
      if (err?.code !== 'share_write_forbidden') throw err;
      editable = false;
      why = String(err.publicMessage || '').replace(/^share_write_forbidden:\s*/, '');
    }
    return { ...base, outcome: 'resolvable', resolved: found.indexes.map((index) => decisions[index].summary), editable, why };
  }
  assertCanEditSections(actor, project, policy, ['recent_decisions']);
  const now = isoNow();
  const hit = new Set(found.indexes);
  const resolvedSummaries = found.indexes.map((index) => decisions[index].summary);
  // The same write the live propagation makes. The note goes on the node: a
  // decision entry has no field for it.
  const nextDecisions = decisions.map((d, index) => (hit.has(index) ? { ...d, resolved: true, resolved_at: now } : d));
  await saveProjectGuarded({ ...project, context: { ...project.context, recent_decisions: nextDecisions, last_updated: now }, updated_at: now }, actor);

  // This project's own decision node(s) follow the brief, so the graph and the
  // log agree; a node filed under another project is that project's.
  let nodesResolved = 0;
  try {
    const ownerKey = project.owner_key || getActorKey(actor);
    const nodes = await store.listGraphNodes(ownerKey, { nodeTypes: ['decision'], projectId: project.project_id, limit: 500 });
    for (const node of nodes) {
      if (node.project_id !== project.project_id) continue;
      if (String(node.metadata?.status || '').toLowerCase() === 'resolved') continue;
      if (!resolvedSummaries.some((summary) => decisionNodeMatches(summary, node))) continue;
      await store.upsertGraphNode({
        ...node,
        metadata: { status: 'resolved', resolved_at: now, ...(notes ? { resolution_note: String(notes).slice(0, 1000) } : {}) },
        updated_at: now,
        last_seen_at: node.last_seen_at || now,
      });
      nodesResolved += 1;
    }
  } catch (err) {
    console.warn('[CONTEXT] resolve: marking the decision node failed:', err.message);
  }

  try {
    const { getPublisher } = require('../config/redis');
    await getPublisher().publish(`context:${project.owner_key || getActorKey(actor)}:${project.project_id}`, JSON.stringify({ kind: 'context_updated', project_id: project.project_id }));
  } catch { /* non-fatal */ }

  const quoted = resolvedSummaries.length === 1 ? `"${resolvedSummaries[0]}"` : resolvedSummaries.map((summary) => `"${summary}"`).join(', ');
  return {
    ...base,
    outcome: 'resolved',
    resolved: resolvedSummaries,
    nodes_resolved: nodesResolved,
    message: `Marked resolved: ${quoted}.\nThis entry will no longer appear in normal context loads.\nRetrieve with: recall({ action: "entities", status: "resolved" })`,
  };
}

// "THE AUTHOR HAS LEFT" (holdsAuthorRights, holdsProjectPowers, the sharing route)
// is "the author has NO ACTIVE membership here", judged on the PERSON: a stamped
// id that is a key id is resolved to its owner first (workspace.resolveAuthors).
// It used to be "has a roster row with removed_at", which is false for an author
// whose account was erased (erasure hard-deletes every roster row) and for a
// legacy project stamped with an old key id or an unknown owner, which never had
// one: nobody could ever act on either.

// Union two decision lists, stored-first, keeping the STORED copy of anything
// that appears in both — an incoming duplicate must not quietly rewrite the
// reasoning or the `resolved` flag on a decision somebody else already recorded.
// Same cap and same dedupe key as appendRecentDecision, so a merged list is
// indistinguishable from one the append path produced.
//
// `removableAuthors` (anything with has(personId), or null): a stored entry written by one
// of them, or credited to nobody, and left out of `incoming` is dropped instead of
// kept. Only the write of a workspace owner passes it, and only with the ids of
// people who have left.
function mergeDecisionLists(stored = [], incoming = [], { removableAuthors = null } = {}) {
  const sent = new Set((Array.isArray(incoming) ? incoming : []).map((item) => dedupeKey(item?.summary)).filter(Boolean));
  const merged = (Array.isArray(stored) ? [...stored] : []).filter((item) => !(
    removableAuthors
    && (!item?.contributed_by || removableAuthors.has(item.contributed_by))
    && !sent.has(dedupeKey(item?.summary))
  ));
  const seen = new Set(merged.map((item) => dedupeKey(item?.summary)).filter(Boolean));
  for (const decision of Array.isArray(incoming) ? incoming : []) {
    const key = dedupeKey(decision?.summary);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(decision);
  }
  return capDecisions(merged, { keep: (Array.isArray(incoming) ? incoming : []).map((item) => item?.summary) });
}

const DECISION_IMPORTANCES = new Set(['low', 'normal', 'high', 'critical']);

// `contributedBy` is the acting PERSON (workspace.actorPersonId), threaded down
// from the actor rather than read from anywhere global. Without it every
// tool-written decision was stored anonymous, and a shared brief cannot say
// "Sarah decided" about an entry with no author: buildTeamDelta skips an
// unattributed entry, contradictionDetector filters it out, and
// team_context_received — the event that marks the team product working — could
// therefore never fire for anything written through a tool. Only the extraction
// path stamped, and update_context deletes its decisions and writes them here.
//
// Null stays null. An internal `{ id: ownerKey }` actor is nobody, and an entry
// it writes must render as unattributed rather than as the reader's own.
function appendRecentDecision(context = {}, summary, reasoning, importance = 'normal', headline = '', contributedBy = null) {
  const next = [...(context.recent_decisions || [])];
  // THE TEXT AS IT WILL BE STORED, NOT AS IT ARRIVED.
  //
  // Everything appended here passes through cleanSyncedText on the way to the
  // row (normalizeDecisionEntries: secret redaction plus injection defanging),
  // so a summary naming an api_key or a credentialed URL is STORED REWRITTEN.
  // Deduping on the raw text compared two unlike strings: the stored copy was
  // never recognised, so the retry the caller was (wrongly) told to make
  // appended another identical redacted copy, and the log filled with them.
  const storedSummary = cleanSyncedText(summary);
  const normalizedSummary = dedupeKey(storedSummary);
  // Every floor entry gets a headline, not only the ones whose caller sent one.
  // The summaries arriving here are frequently a whole session's write-up
  // (sampled at 846 to over 4,000 characters), and the surfaces that quote a
  // decision were left to cut it wherever the budget ran out. decisionHeadline is
  // the same deterministic first-sentence rule the read side already falls back
  // to — computing it once at write time means a row carries the line it will be
  // quoted by. A summary short enough to BE its own headline stores none (the
  // equality check below), so a one-line decision is not written twice.
  const cleanHeadline = clipText(
    String(headline || decisionHeadline({ summary: storedSummary }) || '').replace(/\s+/g, ' '),
    200,
  );
  if (!next.some((item) => dedupeKey(item?.summary) === normalizedSummary)) {
    next.push({
      summary: storedSummary,
      ...(cleanHeadline && dedupeKey(cleanHeadline) !== normalizedSummary ? { headline: cleanHeadline } : {}),
      reasoning: reasoning || undefined,
      decided_at: isoNow(),
      importance,
      ...(contributedBy ? { contributed_by: contributedBy } : {}),
    });
  }
  // Not slice(-20): the oldest entry is not the least valuable one. See
  // capDecisions — and the one just appended is never the one evicted.
  return capDecisions(next, { keep: [storedSummary] });
}

// Deterministic SHIPPED-slot append from a structured completion event. Confidence
// 1 (these are real, observed completions — never LLM-inferred). Dedupe by summary,
// keep the most recent 15 (evict oldest).
//
// `contributedBy` is the acting PERSON, threaded down from the actor exactly as
// appendRecentDecision takes it. "A teammate shipped X" is half of what the
// catch-up block says, and buildTeamDelta reads `shipped` beside
// recent_decisions — so without an author here, the completion half of the team
// brief was silent while the decision half worked. Null stays null.
//
// A re-shipped summary is skipped rather than rewritten, so the FIRST author
// keeps it, which is the same rule the shared-context dedupe applies.
function appendShipped(context = {}, summary, { sourceTool, commitRef, contributedBy } = {}) {
  const next = [...(context.shipped || [])];
  // dedupeKey, not normalizeText: the same completion arriving once with and
  // once without a trailing full stop was stored twice and rendered as two
  // near-identical SHIPPED cards.
  const normalizedSummary = dedupeKey(summary);
  if (!normalizedSummary) return next.slice(-15);
  if (!next.some((item) => dedupeKey(item?.summary) === normalizedSummary)) {
    next.push({
      summary,
      shipped_at: isoNow(),
      confidence: 1,
      ...(sourceTool ? { source_tool: sourceTool } : {}),
      ...(commitRef ? { commit_ref: commitRef } : {}),
      ...(contributedBy ? { contributed_by: contributedBy } : {}),
    });
  }
  return next.slice(-15);
}

function appendOpenQuestion(context = {}, question) {
  const next = [...(context.open_questions || [])];
  const normalizedQuestion = dedupeKey(question);
  if (!next.some((item) => dedupeKey(item) === normalizedQuestion)) {
    next.push(question);
  }
  // 15, the schema's bound. This said 20, so the 16th question built a list the
  // parse below rejected and question_asked threw instead of evicting.
  return next.slice(-15);
}

function fuzzyQuestionMatch(a, b) {
  const left = normalizeText(a);
  const right = normalizeText(b);
  return left.includes(right) || right.includes(left);
}

function inferStructuredEventEntities(input, project) {
  const now = isoNow();
  const eventType = String(input.event_type || '').trim();
  const summary = String(input.summary || '').trim();
  const metadata = input.metadata || {};
  const scope = project ? 'project' : 'workspace';
  const projectId = project?.project_id;
  const baseMetadata = {
    importance: 'high',
    status: 'active',
    source_kind: 'manual',
    curation_state: 'promoted',
    memory_tier: 'durable',
    seen_count: 1,
    source_count: 1,
    retrieval_hits: 0,
    last_matched_at: now,
    source_keys: ['mcp', 'cloud_event'],
    source: 'structured_context_event',
    event_type: eventType,
  };

  if (!summary) return [];

  if (eventType === 'task_started' || eventType === 'task_completed') {
    // Filter out session-path artifacts and bare file paths — these are never real tasks
    const isLowQualityTitle = (
      summary.length < 8 ||
      /^Session started in \//i.test(summary) ||
      /^\/[a-zA-Z]/.test(summary)
    );
    if (isLowQualityTitle) return [];
    return [{
      entity_type: 'task',
      title: summary,
      summary,
      scope,
      project_id: projectId,
      metadata: {
        ...baseMetadata,
        importance: eventType === 'task_started' ? 'critical' : 'high',
        status: eventType === 'task_completed' ? 'shipped' : 'active',
        // Tasks start as candidates — only promoted to durable after 2+ sessions
        memory_tier: eventType === 'task_started' ? 'candidate' : 'durable',
        curation_state: eventType === 'task_started' ? 'inferred' : 'promoted',
      },
    }];
  }

  if (eventType === 'decision_made' || eventType === 'question_answered') {
    return [{
      entity_type: 'decision',
      title: metadata.question ? `${metadata.question}` : summary,
      summary,
      scope,
      project_id: projectId,
      metadata: {
        ...baseMetadata,
        importance: 'high',
      },
    }];
  }

  if (eventType === 'question_asked') {
    return [{
      entity_type: 'question',
      title: summary,
      summary,
      scope,
      project_id: projectId,
      metadata: {
        ...baseMetadata,
        importance: 'normal',
        memory_tier: 'candidate',
        curation_state: 'inferred',
      },
    }];
  }

  if (eventType === 'feature_shipped') {
    return [{
      entity_type: 'capability',
      title: metadata.feature_name || summary,
      summary,
      scope,
      project_id: projectId,
      metadata: {
        ...baseMetadata,
        importance: 'critical',
        status: 'shipped',
      },
    }];
  }

  if (eventType === 'command_confirmed') {
    return [{
      entity_type: 'workflow',
      title: metadata.label || summary,
      summary: metadata.run ? `${summary} Command: ${metadata.run}` : summary,
      scope,
      project_id: projectId,
      metadata: {
        ...baseMetadata,
        importance: 'high',
      },
    }];
  }

  if (eventType === 'file_changed') {
    return [{
      entity_type: 'knowledge',
      title: metadata.path || clipText(summary, 72),
      summary,
      scope,
      project_id: projectId,
      metadata: {
        ...baseMetadata,
        importance: 'normal',
      },
    }];
  }

  if (eventType === 'blocker_opened' || eventType === 'blocker_resolved') {
    return [{
      entity_type: 'knowledge',
      title: summary,
      summary,
      scope,
      project_id: projectId,
      metadata: {
        ...baseMetadata,
        importance: 'high',
      },
    }];
  }

  return [];
}

const COMPLETION_EVENTS = new Set(['task_started', 'task_completed', 'feature_shipped']);

// `options.deferAutoPromotion`: do not hold the reply on graph promotion, which
// can make one embedding call per entity. Callers inside a hard deadline (the
// 30s MCP timeout) pass it; the brief itself is already saved either way.
async function applyStructuredContextEvent(actor, input, options = {}) {
  const eventType = String(input.event_type || '').trim();
  // Fields the patch below asked for and the server declined, carried out on
  // the result so a caller cannot report an unqualified success over them.
  let refused = [];
  let evictedCards = [];
  let skippedSections = [];
  const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
  // The agent applying this event. Board directives use it to hold a card; every
  // other event ignores it. Read from metadata (already a free-form record) so no
  // request schema had to change to carry it.
  const eventSessionId = metadata.session_id ? String(metadata.session_id).slice(0, 128) : null;
  const sourceTool = String(metadata.surface || metadata.tool || 'codex');
  // WHO is writing. Same rule applyExtraction uses for the extraction path, so
  // the two agree: stamp whenever there is a person behind the actor, and leave
  // an internal actor's writes unattributed. This is the only reason a decision
  // recorded through manage_memory can ever reach a teammate's catch-up.
  const contributor = workspace.actorPersonId(actor);
  // THIS IS A WRITE PATH, so it loads the RAW row — not getProject, which hands
  // a teammate the section-FILTERED view.
  //
  // Nearly every branch below is an APPEND built by reading the current list and
  // pushing one entry onto it (appendRecentDecision, appendShipped, the
  // open_questions filter). Read through the filter, the "current list" of a
  // withheld section is EMPTY, so the append produced a one-item list and the
  // save wrote it over the author's real history: a member firing one
  // decision_made replaced an owner's entire decision log and the call returned
  // `status: accepted`. Silent, total, and reported as success.
  //
  // loadProjectForWrite is the rule the rest of the service already follows and
  // says so in its own header; this path was the exception. requireWriteRole is
  // false because the per-section gate in updateProjectContext is what decides
  // whether this actor may write each field — refusing here would turn a
  // no-permission event into a throw where it used to be a quiet no-op.
  const loaded = input.project_id
    ? await loadProjectForWrite(actor, input.project_id, { requireWriteRole: false })
    : null;
  const project = loaded?.project || null;

  if (input.project_id && !project) {
    throw new Error('project_not_found');
  }

  if (eventType === 'hot_path_discovered') {
    const items = Array.isArray(metadata.items)
      ? metadata.items
      : (metadata.path ? [{ label: metadata.label || input.summary, path: metadata.path, purpose: metadata.purpose || '' }] : []);
    if (project && items.length) {
      const result = await recordHotPaths(actor, project.project_id, items);
      await recordEvent(project, 'mcp', sourceTool, eventType, { summary: input.summary, metadata }, 1, workspace.actorPersonId(actor));
      return {
        status: 'accepted',
        event_type: eventType,
        project_id: project.project_id,
        source_tool: sourceTool,
        hot_paths: result.hot_paths || [],
        // What landed, not what was sent: an item recordHotPaths could not
        // validate (or that was already recorded) is counted here, not hidden
        // behind "accepted".
        stored: result.stored,
        not_stored: result.not_stored,
        aged_out: result.aged_out,
      };
    }
  }

  if (eventType === 'debug_finding' && project) {
    const result = await recordDebugFinding(actor, project.project_id, {
      summary: input.summary,
      paths: Array.isArray(metadata.paths) ? metadata.paths : [],
      added_at: metadata.added_at || undefined,
    });
    await recordEvent(project, 'mcp', sourceTool, eventType, { summary: input.summary, metadata }, 1, workspace.actorPersonId(actor));
    return {
      status: 'accepted',
      event_type: eventType,
      project_id: project.project_id,
      source_tool: sourceTool,
      debugging_notes: result.debugging_notes || [],
      ...(result.already_recorded ? { already_recorded: true } : {}),
    };
  }

  if (project) {
    if (eventType === 'command_confirmed') {
      const planAllowsCapture = await canCaptureCommandsForActor(actor);
      if (!planAllowsCapture) {
        return {
          status: 'accepted',
          event_type: eventType,
          project_id: project.project_id,
          source_tool: sourceTool,
          summary: input.summary,
          skipped: 'plan_not_eligible',
        };
      }
    }
    // THE PATCH IS A FUNCTION OF THE ROW IT IS APPLIED TO. Nearly every branch
    // appends to a list it reads first; built once from the row loaded above,
    // the append carried that row's list into the save, and a concurrent
    // writer's entry between the two was overwritten while this caller heard
    // "accepted" (scan 36). updateProjectContext re-runs this against a fresh
    // read whenever its compare-and-swap loses.
    const buildPatch = (current) => {
      const context = current?.context || {};
      const patch = {};

      if (eventType === 'task_started') {
        patch.current_task = input.summary;
        patch.current_status = `In progress: ${clipText(input.summary, 120)}`;
        patch.task_progress = 'in_progress';
      } else if (eventType === 'task_completed') {
        patch.current_status = `Completed: ${clipText(input.summary, 120)}`;
        patch.task_progress = 'completed';
        // A finished task no longer needs defending from the next one — and
        // task_progress 'completed' already says so: isExplicitTaskProtected
        // releases a completed task. Its PROVENANCE is deliberately kept. This
        // used to clear current_task_source, and normalizeContextForSchema reads
        // it to decide whether the task and a status quoting it are somebody's
        // own words: stripped, a person-set task shaped like probe wording ("Run
        // the smoke test") and its `Completed: …` status were both blanked by the
        // very completion that was meant to record them. finish_task on both
        // dispatchers emits this event, so both erased the task they finished.
        // Commands are scoped to an active task and are cleared when task closes.
        //
        // EXCEPT FROM finish_task, which has just cleared exactly the entries its
        // review showed and left the ones added since (journey r4, BLOCKED 22):
        // emptying the log again here would clear what that call deliberately
        // kept, and what its reply said it kept. Both dispatchers send this
        // event with source 'cleanup_context'.
        if (metadata.source !== 'cleanup_context') patch.commands = [];
        // SHIPPED slot — deterministic append from this structured completion event
        // (in addition to the current_status header). Never LLM-inferred.
        patch.shipped = appendShipped(context, input.summary, {
          sourceTool,
          commitRef: metadata.commit_ref || metadata.commit || undefined,
          contributedBy: contributor,
        });
      } else if (eventType === 'decision_made') {
        patch.recent_decisions = appendRecentDecision(
          context,
          input.summary,
          metadata.reasoning,
          // The floor's default is `normal`. It was `high`, and because the floor
          // writes far more entries than anybody marks by hand, `high` stopped
          // meaning anything: hourly run-logs from a scheduled agent all carried
          // it and held the top of the brief indefinitely. An importance the
          // caller actually sent is still honoured.
          DECISION_IMPORTANCES.has(metadata.importance) ? metadata.importance : 'normal',
          metadata.headline,
          contributor,
        );
      } else if (eventType === 'question_asked') {
        patch.open_questions = appendOpenQuestion(context, input.summary);
      } else if (eventType === 'question_answered') {
        const question = String(metadata.question || '').trim();
        patch.open_questions = question
          ? (context.open_questions || []).filter((item) => !fuzzyQuestionMatch(item, question))
          : context.open_questions || [];
        patch.recent_decisions = appendRecentDecision(
          context,
          input.summary,
          question || metadata.reasoning,
          DECISION_IMPORTANCES.has(metadata.importance) ? metadata.importance : 'normal',
          metadata.headline,
          contributor,
        );
      } else if (eventType === 'command_confirmed') {
        // A command somebody RAN is not a decision the team AGREED.
        //
        // This used to append to recent_decisions — the same list decision_made
        // writes to, the list the brief renders under "Recent decisions", the list
        // a teammate reads to learn what was settled and why. Nothing here is an
        // assertion by anybody: the PostToolUse hook fires on every Bash call, so
        // `npm test`, `git status` and `rm -rf node_modules` arrived in a
        // colleague's brief as team decisions. And because the log is bounded, a
        // busy afternoon did not merely add noise beside the signal — it evicted
        // the signal.
        //
        // context.commands is the right home and this branch already wrote to it:
        // runnable commands for the project, rendered as commands, claiming
        // nothing. Only the decision-log half is gone.
        //
        // `run` falls back to the summary the capture builds ("Executed command:
        // …") so a payload without the metadata still files SOMEWHERE rather than
        // being silently dropped now that there is no second list to land in.
        const run = String(metadata.run || '').trim()
          || String(input.summary || '').replace(/^Executed command:\s*/i, '').trim();
        if (run) {
          const currentCommands = Array.isArray(context?.commands) ? context.commands : [];
          const nextEntry = {
            label: String(metadata.label || run.split(/\s+/)[0] || 'command').slice(0, 32),
            run,
            note: metadata.note ? String(metadata.note) : undefined,
          };
          patch.commands = [...currentCommands, nextEntry].slice(-20);
        }
      } else if (eventType === 'feature_shipped') {
        patch.current_status = `Shipped: ${clipText(input.summary, 120)}`;
        // `normal`, not `high`: a shipped feature already has its own slot (below),
        // so its decision-log twin does not also need to outrank real decisions.
        patch.recent_decisions = appendRecentDecision(
          context,
          input.summary,
          metadata.reasoning,
          DECISION_IMPORTANCES.has(metadata.importance) ? metadata.importance : 'normal',
          metadata.headline,
          contributor,
        );
        // SHIPPED slot — deterministic append from this structured completion event.
        patch.shipped = appendShipped(context, input.summary, {
          sourceTool,
          commitRef: metadata.commit_ref || metadata.commit || undefined,
          contributedBy: contributor,
        });
      } else if (eventType === 'blocker_opened') {
        patch.blocking_issue = input.summary;
        patch.current_status = `Blocked: ${clipText(input.summary, 120)}`;
      } else if (eventType === 'blocker_resolved') {
        patch.blocking_issue = '';
        patch.current_status = `Unblocked: ${clipText(input.summary, 120)}`;
        patch.recent_decisions = appendRecentDecision(context, input.summary, metadata.reasoning, 'normal', '', contributor);
      } else if (eventType === 'file_changed') {
        patch.source_summary = input.summary;
      } else if (eventType === 'todo_added') {
        const todos = Array.isArray(metadata.todos) ? metadata.todos : (input.summary ? [input.summary] : []);
        // Entries are bare titles (the published contract) or {title, body, phase}.
        // normalizeTaskCardInputs is shared with both MCP dispatchers so the three
        // cannot disagree about what an entry means: the call-level phase is only a
        // FALLBACK, so a per-card phase wins, and a bare title still lands in
        // Backlog via the merge default.
        const cards = normalizeTaskCardInputs(todos, metadata.phase ? String(metadata.phase) : '');
        if (cards.length) patch.add_todos = cards;
      } else if (eventType === 'todo_moved') {
        const todo = String(metadata.todo || '').trim();
        const phase = String(metadata.phase || '').trim();
        if (todo && phase) patch.move_todos = [{ match: todo, phase }];
      } else if (eventType === 'todo_completed') {
        const todo = String(metadata.todo || input.summary || '').trim();
        if (todo) patch.complete_todos = [todo];
      } else if (eventType === 'todo_removed') {
        const todo = String(metadata.todo || input.summary || '').trim();
        if (todo) patch.remove_todos = [todo];
      }
      return patch;
    };
    const patch = buildPatch(project);

    if (Object.keys(patch).length) {
      // `refused` names the fields the server would not take. It has to travel
      // out of here, or a caller that reports `status: 'accepted'` is reporting
      // a write that partly did not happen.
      const patched = await updateProjectContext(actor, project.project_id, buildPatch, {
        sessionId: eventSessionId,
        deferAutoPromotion: Boolean(options.deferAutoPromotion),
        // Starting, finishing and shipping are the everyday teammate events;
        // their progress / command-log / shipped side effects are skipped (and
        // named) for a caller who may not edit those sections, rather than
        // refusing the event. See DERIVED_COMPLETION_FIELDS.
        skipUnwritableDerived: COMPLETION_EVENTS.has(eventType),
      });
      if (Array.isArray(patched?.refused) && patched.refused.length) refused = patched.refused;
      if (Array.isArray(patched?.evicted_cards) && patched.evicted_cards.length) evictedCards = patched.evicted_cards;
      if (Array.isArray(patched?.skipped_sections) && patched.skipped_sections.length) skippedSections = patched.skipped_sections;
    }
    await recordEvent(project, 'mcp', sourceTool, eventType, { summary: input.summary, metadata }, 1, workspace.actorPersonId(actor));
  }

  const entities = inferStructuredEventEntities(input, project);
  if (entities.length) {
    const upsert = upsertWorkspaceEntities(actor, { entities, relations: [] }, { serverWritten: true }).catch((err) => {
      console.warn('[CONTEXT] structured event workspace upsert failed:', err.message);
    });
    if (!options.deferAutoPromotion) await upsert;
  }

  return {
    status: 'accepted',
    event_type: eventType,
    project_id: project?.project_id || null,
    source_tool: sourceTool,
    summary: input.summary,
    ...(refused.length ? { refused } : {}),
    // Cards a board write pushed off the board to make room (the Done cap keeps
    // the most recently completed 100). Present only when something went.
    ...(evictedCards.length ? { evicted_cards: evictedCards } : {}),
    ...(skippedSections.length ? { skipped_sections: skippedSections } : {}),
    entities_written: entities.length,
  };
}

// Lines a caller wrote as "Open question: ..." are questions because the caller
// SAID so. They are filed deterministically rather than left for a model to
// notice, which it did about half the time.
const OPEN_QUESTION_LINE = /^\s*(?:[-*\u2022]\s*)?open question\s*:\s*(.+?)\s*$/i;

// "Current task: X" in an explicit update is the person saying what they are
// working on, not a decision (journey BLOCKED 13: the whole line was filed in
// the decision log, and with no model to infer a task the brief's task stayed
// empty). The LAST such line wins; it is taken out of the text before the rest
// is judged, exactly as "Open question:" lines are.
const CURRENT_TASK_LINE = /^\s*(?:[-*•]\s*)?current task\s*[:：]\s*(\S.*?)\s*$/i;

function parseExplicitCurrentTask(text) {
  let task = '';
  const rest = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(CURRENT_TASK_LINE);
    // A closing full stop ends the sentence, not the task: "Current task: Ship
    // X." sets the task "Ship X", as the model reading the same line does.
    if (match && match[1]) task = match[1].replace(/[.;,]+$/, '').trim();
    else rest.push(line);
  }
  return { task, rest: task ? rest.join('\n').trim() : String(text || '').trim() };
}

function parseExplicitOpenQuestions(text) {
  const questions = [];
  const rest = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(OPEN_QUESTION_LINE);
    if (match && match[1]) questions.push(match[1]);
    else rest.push(line);
  }
  return { questions: uniqueStrings(questions), remainder: rest.join('\n').trim() };
}

/**
 * update_context, for BOTH dispatchers: save what the caller said.
 *
 * The caller's sentence is an instruction, not a candidate. It is stored
 * verbatim as ONE decision, exactly once, and what the model made of it rides
 * along as that decision's `headline`. Extraction still runs, and still fills
 * the fields it is good at (status, stack, landmines, shipped) — but it no
 * longer decides WHETHER the words are kept, which is what let a provider blip,
 * a confidence gate, or a delta of {category} report `stored: true` over a
 * brief that did not contain them.
 *
 * Two things the model may not do on this path: replace an EXPLICITLY set
 * current_task (sanitizeExtraction's isExplicitTaskProtected gate; an unset or
 * extracted task may be moved on by what the caller said) and author the
 * decision text (a paraphrase beside the original is a
 * duplicate; a paraphrase INSTEAD of it is a loss).
 *
 * `stored` means one thing: the caller's text can be read back.
 */
async function recordExplicitUpdate(actor, input) {
  const summary = String(input.summary || '').trim();
  if (!summary) throw new Error('summary required');
  const projectId = input.project_id;
  const tool = input.tool;
  const chunks = [{ role: 'assistant', text: summary }];
  const base = {
    session_id: input.session_id,
    tool,
    project_id: projectId,
    chunks,
    chunk: chunks[0],
    session_context: input.session_context,
    explicit: true,
    ...(input.timeout_ms ? { timeout_ms: input.timeout_ms } : {}),
  };
  const rawExtraction = input.extraction
    || await require('./extractionService').runExtraction(actor, base);

  const delta = { ...(rawExtraction?.delta || {}) };
  const modelDecision = (Array.isArray(delta.recent_decisions) ? delta.recent_decisions : [])
    .find((entry) => entry && entry.summary) || null;
  // current_task is NOT stripped here any more. It was, unconditionally, so an
  // explicit update could not set a task at all on hosted — where `task` is not
  // in the advertised catalog and a summary is the only way to say "I am now on
  // X". What the strip was protecting — a task somebody set on purpose being
  // replaced by an inferred one — is guarded where every extraction is gated:
  // sanitizeExtraction drops current_task AND next_action while
  // isExplicitTaskProtected(current) holds, and the drift guard there refuses a
  // generic task over a specific one. next_action only travels WITH a task: on
  // its own it is the model guessing the cursor inside somebody else's task.
  if (!delta.current_task) delete delta.next_action;
  delete delta.recent_decisions;

  const { task: statedTask, rest: withoutTask } = parseExplicitCurrentTask(summary);
  const { questions, remainder } = parseExplicitOpenQuestions(withoutTask);
  if (questions.length) delete delta.open_questions;

  const extraction = {
    ...rawExtraction,
    delta,
    no_material_change: !isMeaningfulDelta(delta),
  };
  // keep_session_binding: see applyExtraction. Only the hosted dispatcher sends
  // it, and only for a project its caller named; kept out of `base`, which is
  // what extraction reads.
  const result = await applyExtraction(actor, {
    ...base,
    extraction,
    ...(input.keep_session_binding ? { keep_session_binding: true } : {}),
    ...(input.tool_identified === false ? { tool_identified: false } : {}),
  });
  if (!result?.project) throw new Error('project_not_found');
  const targetId = result.project.project_id;

  // A caller who wrote only "Open question:" lines asked a question; they did
  // not make a decision, and filing the same text under both would say they had.
  // Nor is a "Current task:" line a decision: it sets the task, below, and the
  // rest of the text (if any) is what is filed.
  const decisionText = questions.length && !remainder ? '' : withoutTask;
  let taskStored = !statedTask;
  const ignored = rawExtraction?.match_decision === 'ignored';
  let refusal = null;
  let conflict = null;
  try {
    if (statedTask) {
      // The explicit path, as manage_memory's `task` argument writes it: set
      // last, so an inferred task in the delta above cannot stand in its place.
      const patched = await updateProjectContext(actor, targetId, { current_task: statedTask });
      const refusedTask = (patched?.refused || []).some((item) => item.field === 'current_task');
      const live = String(patched?.context?.current_task || '').trim();
      taskStored = !refusedTask && Boolean(live) && dedupeKey(live) === dedupeKey(store.redactForStorage(statedTask));
    }
    for (const question of questions) {
      await applyStructuredContextEvent(actor, {
        event_type: 'question_asked',
        project_id: targetId,
        summary: question,
        metadata: { surface: tool },
      }, { deferAutoPromotion: true });
    }
    if (decisionText) {
      await applyStructuredContextEvent(actor, {
        event_type: 'decision_made',
        project_id: targetId,
        summary: decisionText,
        metadata: {
          surface: tool,
          // What the model judged chatter is still kept — the caller asked — but
          // at `low`, so it is findable without leading anybody's brief.
          importance: ignored ? 'low' : (modelDecision?.importance || 'normal'),
          headline: modelDecision?.headline || modelDecision?.summary || '',
          reasoning: modelDecision?.reasoning,
        },
      }, { deferAutoPromotion: true });
    }
  } catch (err) {
    // Lost the compare-and-swap on every attempt: nothing of this call's
    // decision was saved, and the reply has to say so rather than let a
    // read-back taken before the next writer lands pass for success.
    if (err?.code === 'context_write_conflict') conflict = err;
    else if (err?.code !== 'share_write_forbidden' && err?.code !== 'workspace_read_only') throw err;
    else refusal = err;
  }

  // Judged on the READ-BACK. Every earlier fix to this path was judged on a
  // success string or a moved timestamp, and each one shipped the same bug.
  //
  // Against the text AS IT IS STORED. A summary is cleaned on its way to the row
  // (cleanSyncedText: secret redaction, injection defanging), so comparing the
  // raw sentence answered `not_found_on_read_back` — "Retry" and all — for a
  // decision that had landed perfectly, every time it happened to mention a key,
  // a credentialed URL or an override phrase. The caller is still told that
  // their words were changed; that is what `redacted` below is for. Open
  // questions are compared raw on purpose: suspicious ones are DROPPED rather
  // than rewritten, and "not stored" is then the truth.
  const after = await getProject(actor, targetId).catch(() => null);
  const storedDecisions = after?.context?.recent_decisions || [];
  const storedQuestions = after?.context?.open_questions || [];
  const storedDecisionText = decisionText ? cleanSyncedText(decisionText) : '';
  const decisionStored = !decisionText
    || storedDecisions.some((entry) => dedupeKey(entry?.summary) === dedupeKey(storedDecisionText));
  const questionsStored = questions.every((question) => storedQuestions.some((entry) => dedupeKey(entry) === dedupeKey(question)));
  const liveTask = String(after?.context?.current_task || '').trim();
  const stored = Boolean(after) && decisionStored && questionsStored && taskStored;
  let reason = null;
  if (!stored) {
    if (refusal) reason = 'forbidden';
    else if (conflict) reason = 'conflict';
    else if (!after) reason = 'unverifiable';
    else reason = 'not_found_on_read_back';
  }
  return {
    project: after || result.project,
    session: result.session,
    graph: result.graph,
    // What applyExtraction APPLIED. This returned the request-side delta, so a
    // task the explicit-task gate had refused was relayed as "Task → X" by the
    // local dispatcher over a brief that still carried the old one.
    // With a "Current task:" line, the task as it now stands: both dispatchers
    // report it from here (the local one prints the delta).
    extraction: statedTask && taskStored
      ? { ...(result.applied_extraction || extraction), delta: { ...((result.applied_extraction || extraction)?.delta || {}), current_task: liveTask } }
      : (result.applied_extraction || extraction),
    ...(statedTask && taskStored ? { task_set: liveTask } : {}),
    stored,
    reason,
    // Stored, but not word for word. Both dispatchers say so in their reply:
    // a caller who is told "stored" and later reads [REDACTED] back has been
    // told the truth and still surprised by it.
    redacted: stored && Boolean(storedDecisionText) && storedDecisionText !== decisionText,
    refusal_message: refusal?.publicMessage || (!stored && conflict ? conflict.publicMessage : null),
    questions_added: questions.length,
  };
}

// ─── finish_task: what the review showed is what the confirmation clears ────
//
// The hosted dispatcher's memory of a wrap-up review (journey r4, BLOCKED 22;
// the rule is shared-context taskReview.js, which the local dispatcher applies
// to a review it keeps in its own process). Keyed by the connection's session
// id and the project; digests only, so no question text is stored twice and
// the copy in the brief stays the only one, encrypted at rest.
function taskReviewDigest(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

async function recordTaskReview(actor, sessionId, projectId, context) {
  const reviewed = taskReviewItems(context, { digest: taskReviewDigest });
  await store.saveTaskReview(getActorKey(actor), sessionId, projectId, reviewed);
  return reviewed;
}

async function readTaskReview(actor, sessionId, projectId) {
  return store.getTaskReview(getActorKey(actor), sessionId, projectId);
}

async function forgetTaskReview(actor, sessionId, projectId) {
  return store.deleteTaskReview(getActorKey(actor), sessionId, projectId);
}

// The plan for a confirmed completion of `context` (the caller's view) against
// `reviewed`, the digests its review recorded. A confirmation with no review on
// record never reaches this: the dispatcher refuses it (NO_REVIEW_ON_RECORD).
function planTaskCompletion(context, reviewed) {
  return planReviewedCompletion(context, reviewed, { digest: taskReviewDigest });
}

// `options.sessionId` names the agent applying this patch. It exists so a card
// moved to In Progress can record WHO is on it without any caller adding a tool
// parameter — the server already knows the session from the request. Omitted →
// the merge behaves exactly as it did before holds existed.
// THE SIDE EFFECTS OF COMPLETING WORK, as opposed to the completion itself.
//
// finish_task and the task/ship events compose these fields themselves: the
// progress marker, clearing the task's command log, open questions and
// blocker, the shipped entry. None of them is in the default share and
// `commands` is not shareable at all, so a teammate finishing their own task
// was refused outright — every time, on every share — for fields they never
// sent. Under `skipUnwritableDerived` a field in this set that the caller may
// not edit is SKIPPED (and named in `skipped_sections`) instead of refusing the
// write; the completion itself (current_status, the task) stays strict, as does
// every field outside this set. Nothing here ever writes a section the caller
// cannot edit: it only decides between "refuse all" and "leave that part".
const DERIVED_COMPLETION_FIELDS = new Set([
  'task_progress',
  'commands',
  'open_questions',
  'blocking_issue',
  'shipped',
  'next_action',
]);

// The only task_progress values the server itself composes: task_started's
// and a completion's. Anything else a caller sends is the caller's own write.
const COMPOSED_TASK_PROGRESS = new Set(['in_progress', 'completed']);
// Whether a (post-gate) patch writes the task: its text or its status line.
// Setting a task gates on current_task; a completion gates on current_status.
const writesTask = (patch) => 'current_task' in patch || 'current_status' in patch;

// A STATUS THE SERVER WROTE WHEN THE STORED TASK WAS FINISHED: finish_task's
// `Completed: <task>` (or a bare `Completed` when there was no task), and the
// task_completed event's `Completed: <summary>` — which is why a marker still at
// 'completed' also counts. A status somebody typed that merely starts with the
// word ("Completed: the migration; now on the tests") is theirs, and kept.
function isServerCompletionStatus(context) {
  const status = String(context?.current_status || '').trim();
  const match = /^completed(?::\s*(.*))?$/is.exec(status);
  if (!match) return false;
  if (!match[1] || context?.task_progress === 'completed') return true;
  const task = normalizeText(context?.current_task || '');
  return Boolean(task) && normalizeText(match[1]) === task;
}

// The same bookkeeping as task_progress and next_action, for the status: a NEW
// task that does not bring its own status does not open under the old task's
// "Completed: <old task>" — the brief read "Task: B / Status: Completed: A" and
// the resume hint told the next session to pick up B, already completed.
function clearsCompletionStatus(context, incoming) {
  if ('current_status' in incoming) return false;
  const next = typeof incoming.current_task === 'string' ? incoming.current_task.trim() : '';
  if (!next || normalizeText(next) === normalizeText(context?.current_task || '')) return false;
  return isServerCompletionStatus(context);
}

// `patch` may be a FUNCTION of the freshly loaded project, returning the patch.
// An append ("the decision log I read, plus one") has to be one: if the save
// loses its compare-and-swap, the write is re-run from a fresh read and the
// append re-derived from the list as it now is. A plain object is re-applied
// as sent, which is what a set-this-field write means.
async function updateProjectContext(actor, projectId, patch, options = {}) {
  return withContextWriteRetry(() => updateProjectContextOnce(actor, projectId, patch, options));
}

async function updateProjectContextOnce(actor, projectId, patchOrBuilder, options = {}) {
  const ownerKey = getActorKey(actor);
  // Through the same gate as every other write. This loaded store.getProject
  // raw, so visibility was never consulted, and the section check below only ran
  // for a SHARED project: a teammate could write a colleague's personal project
  // by id, and a workspace owner could rewrite a private one they may only read.
  const loaded = await loadProjectForWrite(actor, projectId);
  if (!loaded) throw new Error('project_not_found');
  // THE CALLER'S READ, CHECKED AGAINST THE ROW THIS WRITE SWAPS ON.
  //
  // Optional: without `expectedContextVersion` the write is exactly as before.
  // With it, the version is compared with the row loaded HERE, and the save
  // below is guarded on that same row's version — so "it was still at N when I
  // wrote" holds at the moment of the write, not just at some earlier check. A
  // lost swap re-runs this from a fresh read, which then no longer matches, so
  // a concurrent writer can never slip between the check and the save.
  if (Number.isInteger(options.expectedContextVersion)
    && Number(loaded.project.context_version) !== options.expectedContextVersion) {
    throw staleContextVersionError(loaded.project, options.expectedContextVersion);
  }
  // A builder also gets the share policy, so it can plan from what the CALLER
  // may see of the row rather than the row itself (finish_task, journey r4 M1).
  const patch = typeof patchOrBuilder === 'function' ? (patchOrBuilder(loaded.project, loaded.policy) || {}) : patchOrBuilder;
  const sharePolicy = loaded.policy;
  // THE SECTION GATE COMES FIRST, on what the caller sent. It used to run after
  // the board merge, so a member with no access to a board got the open-card
  // limit error — with the hidden board's open count in it — before the refusal
  // that was actually theirs. previewProjectContextWrite runs the same check,
  // which is what makes a dry run agree with the write.
  // Under skipUnwritableDerived the completion side effects are judged below,
  // field by field (skipped, not refused); every other field is judged here.
  assertCanWritePatch(actor, loaded.project, sharePolicy, options.skipUnwritableDerived
    ? Object.fromEntries(Object.entries(patch || {}).filter(([key]) => !DERIVED_COMPLETION_FIELDS.has(key)))
    : patch);
  let project = await repairProjectIntegrity(loaded.project);
  // Redacted BEFORE anything compares it with the stored context. The store
  // masks secrets on save, so a patch compared raw ("is this the same task?",
  // "is this card already on the board?") measured the caller's words against
  // the masked copy and saw a change that was not there — re-stating the same
  // task wiped next_action. Masked here, both sides are the same text.
  const sanitizedPatch = store.redactForStorage({ ...patch });
  // The blocker's set-at is the server's stamp (applied after the section gate
  // below, like the other derived fields), never the caller's.
  delete sanitizedPatch.blocking_issue_set_at;
  // REFUSE, NEVER BLANK. This replaced a filtered value with '' — so setting the
  // task to "Add a smoke test for the billing webhook" over a stored task left
  // the project with NO task, and the reply said the task was "NOT changed".
  // A value the server will not take must leave what is already there alone, and
  // dropping the key does exactly that. The check is the whole-value one: these
  // are words somebody typed, not a model's summary of a session.
  const refused = [];
  // EXCEPT THE TASK, WHEN A PERSON SET IT.
  //
  // Even the whole-value check is the wrong instrument for this one field.
  // "Run the smoke test" and "Auth check" are the five-word versions of work
  // the longer forms already pass ("Add a smoke test for the billing webhook"),
  // and a person who types a task and is told the server will not take it has
  // been told the product does not store what they said — with no wording to
  // retry that fixes it.
  //
  // This function IS the explicit path, so a task arriving here is somebody's
  // own words unless the caller itself says otherwise. An inferred one keeps
  // the filter: a model summarising a connection probe is where this wording
  // actually comes from, and that is the case the filter was written for. An
  // empty value is not refused either — that is how a task is cleared.
  const taskWasInferred = 'current_task_source' in patch && patch.current_task_source !== 'explicit';
  // AND THE STATUS, WHEN IT ONLY QUOTES THAT TASK BACK.
  //
  // finish_task composes `Completed: <the stored task>` and sends it here. So
  // the exemption above stored "Run the smoke test", the server built a status
  // out of the very words it had just accepted, and then refused its own
  // composition as connection-test chatter. The refusal landed in `refused`,
  // the cleanup handler did not read it, and the reply announced a completion
  // the brief did not have — the next session opened on a task still in
  // progress under a stale status.
  //
  // Narrow deliberately: this exempts a status that CONTAINS the accepted task,
  // which is the shape every server-composed status has (`Completed:`,
  // `Shipped:`, `Blocked:`) and nothing a model invented. An inferred task is
  // not an accepted one, so a status quoting it is filtered along with it. And
  // an extraction-inferred status never reaches this function at all: it is
  // filtered by the substring form in sanitizeExtractionDelta, which is
  // untouched.
  const acceptedTask = taskWasInferred || typeof sanitizedPatch.current_task !== 'string' || !sanitizedPatch.current_task.trim()
    ? normalizeText(project.context?.current_task || '')
    : normalizeText(sanitizedPatch.current_task);
  const quotesAcceptedTask = (value) => Boolean(acceptedTask) && normalizeText(value).includes(acceptedTask);
  const chatterChecked = ['description', 'current_status', 'blocking_issue', 'task_progress'];
  if (taskWasInferred) chatterChecked.push('current_task');
  for (const key of chatterChecked) {
    if (typeof sanitizedPatch[key] !== 'string') continue;
    if (key === 'current_status' && quotesAcceptedTask(sanitizedPatch[key])) continue;
    if (isConnectionTestChatter(sanitizedPatch[key])) {
      delete sanitizedPatch[key];
      refused.push({ field: key, reason: 'it reads as connection-test chatter rather than project context' });
    }
  }
  for (const key of ['goals', 'open_questions', 'recurring_context']) {
    if (Array.isArray(sanitizedPatch[key])) {
      const kept = sanitizeExplicitContextArray(sanitizedPatch[key]);
      const droppedCount = uniqueStrings(sanitizedPatch[key]).length - kept.length;
      if (droppedCount > 0) {
        refused.push({
          field: key,
          reason: `${droppedCount} entr${droppedCount === 1 ? 'y' : 'ies'} read as connection-test chatter rather than project context`,
        });
      }
      sanitizedPatch[key] = kept;
    }
  }
  let resetCompletedProgress = false;
  // NEXT_ACTION IS THE CURSOR INSIDE A TASK, so it does not outlive the task.
  // A new (or cleared) task, or the task being completed, leaves the old task's
  // next step behind unless the same request names the next step itself — a
  // brief that reads "Task: B / Next action: <a step of A>" sends the next
  // session to do A's work. Applied after the section gate below, like
  // resetCompletedProgress: a consequence the server derives, not a field the
  // caller asked to write.
  // The old task's server-written "Completed: …" status goes the same way; see
  // clearsCompletionStatus. Decided on the patch as sent, before the gate.
  const clearCompletionStatus = clearsCompletionStatus(project.context, sanitizedPatch);
  const storedNextAction = String(project.context?.next_action || '').trim();
  const clearNextAction = Boolean(storedNextAction) && !('next_action' in sanitizedPatch) && (
    (typeof sanitizedPatch.current_task === 'string'
      && sanitizedPatch.current_task.trim() !== String(project.context?.current_task || '').trim())
    || (sanitizedPatch.task_progress === 'completed' && project.context?.task_progress !== 'completed')
  );
  // This function is the EXPLICIT write path (the dashboard, update_context's
  // task, task_started). A task arriving here was set on purpose, so it is
  // stamped as such unless the caller is itself managing the provenance. Only
  // when the text actually changes: re-saving the whole brief from the dashboard
  // must not promote a task the model inferred into one a person set.
  if (typeof sanitizedPatch.current_task === 'string'
    && !('current_task_source' in sanitizedPatch)
    && sanitizedPatch.current_task.trim() !== String(project.context?.current_task || '').trim()) {
    if (sanitizedPatch.current_task.trim()) {
      sanitizedPatch.current_task_source = 'explicit';
      sanitizedPatch.current_task_set_at = isoNow();
      // A NEW task is not a completed one. finish_task leaves task_progress at
      // 'completed', and nothing reset it when the next task was set — so the
      // brief described fresh work as done, and (since a completed task is not
      // protected) the first task after any finish_task was never protected.
      // Applied AFTER the section gate below: it is a consequence the server
      // derives, not a field the caller asked to write, and task_progress is not
      // in the default share — gating it would refuse a teammate's task write.
      if (!('task_progress' in sanitizedPatch) && project.context?.task_progress === 'completed') {
        resetCompletedProgress = true;
      }
    } else {
      sanitizedPatch.current_task_source = undefined;
      sanitizedPatch.current_task_set_at = undefined;
    }
  }
  if (sanitizedPatch.recent_decisions !== undefined) {
    sanitizedPatch.recent_decisions = normalizeDecisionEntries(sanitizedPatch.recent_decisions);
  }
  if (sanitizedPatch.commands !== undefined) {
    sanitizedPatch.commands = normalizeCommandEntries(sanitizedPatch.commands);
  }
  if (sanitizedPatch.hot_paths !== undefined) {
    sanitizedPatch.hot_paths = normalizeHotPaths(sanitizedPatch.hot_paths);
  }
  if (sanitizedPatch.entrypoints !== undefined) {
    sanitizedPatch.entrypoints = normalizeEntrypoints(sanitizedPatch.entrypoints);
  }
  if (sanitizedPatch.surfaces !== undefined) {
    sanitizedPatch.surfaces = normalizeSurfaces(sanitizedPatch.surfaces);
  }
  if (sanitizedPatch.debugging_notes !== undefined) {
    sanitizedPatch.debugging_notes = normalizeDebuggingNotes(sanitizedPatch.debugging_notes);
  }
  if (sanitizedPatch.landmines !== undefined) {
    sanitizedPatch.landmines = normalizeLandmines(sanitizedPatch.landmines);
  }
  if (sanitizedPatch.shipped !== undefined) {
    sanitizedPatch.shipped = normalizeShipped(sanitizedPatch.shipped);
  }
  // resolved_landmines is a removal DIRECTIVE, not a stored field — it would be
  // dropped by the schema parse below. Apply it here against the current (or
  // freshly-patched) landmines so update_brief/PATCH can resolve a landmine by a
  // phrase from its summary, then drop the key so it never persists.
  if (Array.isArray(sanitizedPatch.resolved_landmines) && sanitizedPatch.resolved_landmines.length) {
    const removals = sanitizedPatch.resolved_landmines
      .map((r) => String(r || '').trim().toLowerCase())
      .filter(Boolean);
    const base = sanitizedPatch.landmines !== undefined
      ? sanitizedPatch.landmines
      : (project.context?.landmines || []);
    sanitizedPatch.landmines = normalizeLandmines(base).filter((l) => {
      const summary = String(l?.summary || '').toLowerCase();
      return !removals.some((r) => summary.includes(r) || r.includes(summary));
    });
  }
  delete sanitizedPatch.resolved_landmines;

  // Board/todo directives (add_todos/move_todos/complete_todos/remove_todos) are
  // merge-only side channels, not schema fields — a raw spread + parse would drop
  // them. Route them through mergeContextObject (the single board-merge code path)
  // and lower the result onto the real todo_items/completed_todos fields, then
  // strip the directives so the schema parse below doesn't discard them.
  const TODO_DIRECTIVE_KEYS = ['add_todos', 'move_todos', 'complete_todos', 'remove_todos'];
  const boardOutcome = {};
  let derivedShipped;
  // The stored shipped list AFTER the lines that came from cards have followed
  // them (moved back out of Done, deleted, renamed). Undefined when nothing moved.
  let followedShipped;
  if (TODO_DIRECTIVE_KEYS.some((k) => sanitizedPatch[k] !== undefined)) {
    const directive = {};
    for (const k of TODO_DIRECTIVE_KEYS) {
      if (sanitizedPatch[k] !== undefined) {
        directive[k] = sanitizedPatch[k];
        delete sanitizedPatch[k];
      }
    }
    const mergedBoard = mergeContextObject(project.context, directive, project.context?.source_summary || '', {
      sessionId: options.sessionId || null,
      contributedBy: workspace.actorPersonId(actor),
      outcome: boardOutcome,
    });
    // The merge refused cards that would have taken the board past its open-card
    // limit (it no longer evicts open work to make room). Refuse the WRITE too,
    // before anything is saved: a board write that half-applies — some cards
    // added, the rest silently not — is the failure this exists to end.
    if (Array.isArray(boardOutcome.refused_open) && boardOutcome.refused_open.length) {
      throw boardOpenLimitError(boardOutcome);
    }
    sanitizedPatch.todo_items = mergedBoard.todo_items;
    sanitizedPatch.completed_todos = mergedBoard.completed_todos;
    // A card entering Done is a confirmed completion, and the merge turns it into
    // a `shipped` entry — which this lowering used to throw away with everything
    // else it did not copy, so no board completion ever reached shipped or the
    // catch-up built from it. Kept only when the merge actually grew the list,
    // and only when the caller did not send shipped itself (a caller's shipped
    // is a replace; the merge's is a union onto the stored list). Applied after
    // the section gate below, like resetCompletedProgress: it is a consequence
    // the server derives from a board write, not a field the caller asked for.
    //
    // Only a TRANSITION counts: a card that was already on this board in another
    // column and is in Done now (complete, or move to done). A card that arrives
    // already in Done — a Trail import carrying a project's finished history, or
    // an add straight into the Done column — records work, it does not complete
    // any, and stamping each one "shipped just now" would flood the 15-entry
    // shipped list and the catch-up with history.
    const doneKey = (value) => String(value || '').trim().toLowerCase();
    const wasOpen = new Set((project.context?.todo_items || [])
      .filter((card) => card && String(card.phase || '') !== 'done')
      .map((card) => card.id));
    const completedNow = new Set((mergedBoard.todo_items || [])
      .filter((card) => card && card.phase === 'done' && wasOpen.has(card.id))
      .map((card) => doneKey(card.title)));
    // THE LINE FOLLOWS THE CARD (journey r6). A line that came from a card goes when
    // the card is moved back out of Done or deleted, and takes its new title when
    // renamed. The Done cap's own evictions are history and keep their lines.
    if (sanitizedPatch.shipped === undefined) {
      const asDone = (list) => (list || []).map((card) => ({ ...card, phase: 'done' }));
      const followed = followBoardCardsInShipped(project.context?.shipped, {
        before: [...(project.context?.todo_items || []), ...asDone(project.context?.completed_todos)],
        after: [...(mergedBoard.todo_items || []), ...asDone(mergedBoard.completed_todos)],
        evictedDoneIds: new Set((boardOutcome.evicted_done || []).map((card) => card.id)),
      });
      if (followed.changed) followedShipped = followed.list;
    }
    const storedSummaries = new Set((project.context?.shipped || []).map((entry) => doneKey(entry?.summary)));
    const fromBoard = (mergedBoard.shipped || [])
      .filter((entry) => completedNow.has(doneKey(entry?.summary)) && !storedSummaries.has(doneKey(entry?.summary)));
    if (sanitizedPatch.shipped === undefined && fromBoard.length) {
      derivedShipped = normalizeShipped([...(followedShipped || project.context?.shipped || []), ...fromBoard]);
    }
  }

  // A TEAMMATE MAY ADD TO THE DECISION LOG; NOBODY ELSE'S WRITE MAY SHORTEN IT.
  //
  // `recent_decisions` is spread over the stored value below, so any caller
  // handing over a short list deletes the rest — and every append in the service
  // builds its list by reading the current one first. One bad read (a filtered
  // view, a stale copy, a client that sends only what it knows) and the author's
  // history is gone, with a 200 in reply.
  //
  // For the AUTHOR this stays a plain replace: removing your own decision is a
  // real operation the dashboard offers. For everybody else the patch is unioned
  // onto what is stored, so a teammate's write can only ever grow the log. That
  // is the same line CLAUDE.md draws elsewhere — reading solves continuity,
  // rewriting somebody's brief is a different power nobody asked for.
  //
  // ONE EXCEPTION, FOR THE TEAM'S OWN NOTES. What somebody wrote into a shared
  // project stays with the team when they leave (journey r5), so the team has to
  // be able to take it back out. A workspace OWNER's write may therefore drop an
  // entry whose author has left the workspace, and an entry with no author at
  // all (an old one: nobody is credited with it, so there is nobody to protect).
  // An entry by somebody still here is unioned exactly as before, and a member's
  // write never drops anything. When the project's AUTHOR has left, the owner
  // holds the author's rights (holdsAuthorRights) and this is a plain replace.
  // The section gate below still decides whether this caller may write decisions
  // in this project at all.
  //
  // EVERY NEW ENTRY RECORDS WHO WROTE IT. A decision written from the dashboard
  // or over REST (this route) used to be stored with no author, so it was
  // credited to nobody and, once its writer left, nobody could tell it from an
  // old one. An entry that matches one already stored keeps what is stored (an
  // old entry stays credited to nobody; a claimed `contributed_by` never
  // counts); a new one is credited to the caller, as a tool write is.
  if (Array.isArray(sanitizedPatch.recent_decisions)) {
    const contributor = workspace.actorPersonId(actor);
    const stored = new Map((project.context?.recent_decisions || [])
      .map((entry) => [dedupeKey(entry?.summary), entry]).filter(([key]) => key));
    sanitizedPatch.recent_decisions = sanitizedPatch.recent_decisions.map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      const { contributed_by: _claimed, ...rest } = entry;
      const known = stored.get(dedupeKey(entry.summary));
      if (known) return known.contributed_by ? { ...rest, contributed_by: known.contributed_by } : rest;
      return contributor ? { ...rest, contributed_by: contributor } : rest;
    });
  }
  if (Array.isArray(sanitizedPatch.recent_decisions) && !holdsAuthorRights(actor, project, sharePolicy)) {
    // Entries by anybody who is not an active member (left, or erased).
    const authors = workspace.canAdminister(sharePolicy?.workspaceRole) && project.visibility === 'shared'
      ? await workspace.resolveAuthors(
        project.owner_key || getActorKey(actor),
        (project.context?.recent_decisions || []).map((entry) => entry?.contributed_by)
      )
      : null;
    const removableAuthors = authors ? { has: (personId) => !authors.isActive(personId) } : null;
    sanitizedPatch.recent_decisions = mergeDecisionLists(
      project.context?.recent_decisions,
      sanitizedPatch.recent_decisions,
      { removableAuthors }
    );
  }

  const blockedFields = [];
  const skippedSections = [];
  const mayEditField = (field) => {
    if (holdsAuthorRights(actor, project, sharePolicy)) return true;
    const sectionKey = mapSectionFromField(field);
    return SHAREABLE_SECTIONS.includes(sectionKey) && canEditSectionForActor(actor, project, sharePolicy, sectionKey);
  };
  // TASK BOOKKEEPING GOES WITH THE TASK.
  //
  // task_progress and next_action describe the task, not a section of their
  // own anybody curates: 'completed' is what releases a finished task, '' is
  // what protects the next one from extraction, and next_action is the cursor
  // inside the task. Round 23 gated them on their own (unshared) sections, so a
  // teammate who may set and finish the task could never move its marker: a
  // new task after a finish stayed 'completed' (unprotected — the next summary
  // overwrote it — and missing from the return catch-up), and a teammate's own
  // finish left the marker where it was. So the SERVER-DERIVED values — the
  // reset and the next_action clear below, and the marker a completion or
  // task_started composes (under skipUnwritableDerived, and only its own two
  // values) — land for anybody who may write the task this request carries.
  // A task_progress or next_action the caller wrote itself stays exactly as
  // strict as before.
  let composedTaskProgress;
  if (options.skipUnwritableDerived && !holdsAuthorRights(actor, project, sharePolicy)
    && COMPOSED_TASK_PROGRESS.has(sanitizedPatch.task_progress)) {
    composedTaskProgress = sanitizedPatch.task_progress;
    delete sanitizedPatch.task_progress;
  }
  if (!holdsAuthorRights(actor, project, sharePolicy)) {
    // A non-author may only ever write a shared project; an empty patch is not
    // an exemption (it would still stamp last_updated on somebody else's row).
    if (project.visibility !== 'shared') throw writeForbiddenError(readOnlyProjectMessage(project));
    for (const key of Object.keys(sanitizedPatch)) {
      if (mayEditField(key)) continue;
      const sectionKey = mapSectionFromField(key);
      if (options.skipUnwritableDerived && DERIVED_COMPLETION_FIELDS.has(key)) {
        skippedSections.push(sectionKey);
      } else {
        blockedFields.push(sectionKey);
      }
      delete sanitizedPatch[key];
    }
    if (blockedFields.length) {
      const unique = [...new Set(blockedFields)];
      throw writeForbiddenError(readOnlyProjectMessage(project, unique), unique);
    }
    // Everything left in the patch passed the gate, so a task field still in it
    // is one this caller may write — and with it, the task's bookkeeping.
    if (composedTaskProgress !== undefined) {
      if (writesTask(sanitizedPatch)) sanitizedPatch.task_progress = composedTaskProgress;
      else skippedSections.push(mapSectionFromField('task_progress'));
    }
    // Everything this write carried was a side effect the caller may not make:
    // there is nothing of theirs left to save, which is a refusal, not a 200.
    if (skippedSections.length && !Object.keys(sanitizedPatch).length) {
      const unique = [...new Set(skippedSections)];
      throw writeForbiddenError(readOnlyProjectMessage(project, unique), unique);
    }
  }

  // THE SERVER'S OWN CONSEQUENCES OBEY THE SAME LINE. These are derived after
  // the gate (the caller did not ask for them), and they used to be written
  // whatever the share said — so a teammate setting a task reset task_progress,
  // cleared next_action and grew `shipped`, none of which the default share lets
  // them edit. Now each lands only for a caller who may edit its section, and is
  // otherwise skipped and named, like the fields above.
  //
  // Except the task's own bookkeeping (see TASK BOOKKEEPING GOES WITH THE TASK
  // above): the progress reset and the next_action clear follow the task write
  // that caused them, which already passed the gate.
  const deriveInto = (field, value) => {
    if (mayEditField(field)) sanitizedPatch[field] = value;
    else skippedSections.push(mapSectionFromField(field));
  };
  const deriveTaskBookkeeping = (field, value) => {
    if (writesTask(sanitizedPatch)) sanitizedPatch[field] = value;
    else deriveInto(field, value);
  };
  if (resetCompletedProgress) deriveTaskBookkeeping('task_progress', '');
  if (clearNextAction) deriveTaskBookkeeping('next_action', '');
  if (clearCompletionStatus) deriveTaskBookkeeping('current_status', '');
  if ('blocking_issue' in sanitizedPatch) {
    sanitizedPatch.blocking_issue_set_at = nextBlockerSetAt(project.context, sanitizedPatch);
  }
  if (derivedShipped !== undefined) deriveInto('shipped', derivedShipped);
  // A line mirroring a card the caller just changed follows it whether or not the
  // caller may edit `shipped` as a section: removing or renaming what their own
  // board write made untrue is not a new claim. New lines above stay gated.
  if (followedShipped !== undefined && sanitizedPatch.shipped === undefined) sanitizedPatch.shipped = followedShipped;

  const mergedContext = ContextObjectSchema.parse(normalizeContextForSchema({
    ...project,
    context: { ...project.context, ...sanitizedPatch, last_updated: isoNow() },
  }));
  const updated = { ...project, context: mergedContext };
  // Guarded: a lost swap re-runs this whole write from a fresh read (see
  // withContextWriteRetry). Nothing below this line has run yet when it does.
  await saveProjectGuarded(updated, actor);
  // The swap was guarded on this version and it applied, so the row is now
  // exactly one past it. The object still carried the version it was READ at,
  // and PATCH echoes it: a caller holding the reply's version for its next
  // write would have been refused as stale by its own previous edit.
  if (Number.isFinite(project.context_version)) updated.context_version = project.context_version + 1;

  // PROMOTED FROM WHAT WAS WRITTEN, NOT FROM WHAT WAS ASKED FOR.
  //
  // This read the RAW patch, so a value the server had just refused was
  // promoted into the graph anyway — a task declined as connection-test chatter
  // came back weeks later under Know in a subagent brief, with the refusal
  // holding in the brief and nowhere else. A section a teammate may not edit was
  // blocked above for the same reason and would have travelled the same way.
  const autoEntities = buildAutoPromotedMemoryEntities(updated, {
    confidence: 1,
    explicit: true,
    delta: sanitizedPatch,
    tool: 'codex',
    source_tool: 'codex',
  }, isoNow());
  if (autoEntities.length) {
    // serverComposed: a promotion mirrors the brief; it never re-homes an
    // existing workspace-level node (scan 30). See upsertOne's adopt rule.
    const promotion = upsertWorkspaceEntities(actor, { entities: autoEntities, relations: [] }, { serverComposed: true }).catch((err) => {
      console.warn('[CONTEXT] manual workspace auto-promotion failed:', err.message);
    });
    // Promotion is a side effect the saved brief does not depend on, and it can
    // make one embedding call per entity. A caller writing a large patch in one
    // request (a Trail import) opts out of waiting for it.
    if (!options.deferAutoPromotion) await promotion;
  }

  // Publish real-time update
  try {
    const { getPublisher } = require('../config/redis');
    await getPublisher().publish(`context:${ownerKey}:${projectId}`, JSON.stringify({ kind: 'context_updated', project_id: projectId }));
  } catch { /* non-fatal */ }

  // `refused` travels with the saved project so a caller can say WHICH field the
  // server would not take and why. A silent drop and a successful write look the
  // same from the outside, and this path used to look like neither: it reported
  // "NOT changed" over a field it had just emptied.
  // Board cards the Done cap (or the board cap) pushed off to make room. Named
  // so the reply can say which, rather than "Marked complete" over a board that
  // quietly lost its oldest completion.
  const evictedCards = [...(boardOutcome.evicted_done || []), ...(boardOutcome.evicted_open || [])];
  const extras = {
    ...(refused.length ? { refused } : {}),
    ...(evictedCards.length ? { evicted_cards: evictedCards } : {}),
    // Sections a completion left exactly as they were, because this caller may
    // not edit them. Present only when something was skipped.
    ...(skippedSections.length ? { skipped_sections: [...new Set(skippedSections)] } : {}),
  };
  // THE ACTOR'S VIEW, NOT THE ROW THAT WAS SAVED.
  //
  // This returned `updated` — the complete stored context — so a teammate who
  // changed the one section a share lets them edit got every withheld section
  // back in the reply: PATCH /projects/:id/context serialized it verbatim, and
  // every other caller (events, trail import, finish_task, the brief stash) held
  // it too. Filtered here, once, so no caller can forget to. The author, a solo
  // account and every non-shared project get the row exactly as before
  // (projectViewForActor passes them through untouched).
  const view = projectViewForActor(actor, updated, sharePolicy);
  return Object.keys(extras).length ? { ...view, ...extras } : view;
}

// ─── Shared skills (markdown know-how) ──────────────────────────────────────
// Skills are agent INSTRUCTIONS — a higher-risk payload than context data — so
// they are sanitized on write (cleanSyncedText + neutralizeInjectedText) and
// scanned for embedded secrets, rejecting on hit.
const SKILL_SECRET_RE = /\b(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|-----BEGIN [A-Z ]*PRIVATE KEY-----)\b/;

function slugifySkill(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ─── Import a shared skill from a GitHub repo ───────────────────────────────
// A user pastes a repo URL; we fetch its SKILL.md via the GitHub contents API,
// parse the frontmatter for name/description, and hand the body to upsertSkill
// (which runs the same secret-scan + sanitize as any authored skill). We only
// ever hit api.github.com — the pasted URL is parsed into owner/repo/path and
// never fetched directly, so there is no arbitrary-host SSRF surface. safeGet
// still guards the api.github.com fetch (private-range/rebind defense).
const GITHUB_API = 'https://api.github.com';
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
// Ordered filenames to probe when the URL points at a folder (or a bare repo).
const GITHUB_SKILL_FILENAMES = ['SKILL.md', 'skill.md', 'Skill.md'];

// Warn once (not per request) when imports run unauthenticated: GitHub caps
// unauthenticated calls at 60/hour PER SERVER IP — shared across all users, so
// the feature throttles globally. Set GITHUB_TOKEN to raise this to 5,000/hour.
let warnedNoGithubToken = false;

function githubImportError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Parse the many shapes a "GitHub repo" can take into { owner, repo, ref, filePath }.
//   https://github.com/owner/repo
//   https://github.com/owner/repo/tree/<ref>/<dir>
//   https://github.com/owner/repo/blob/<ref>/<path>/SKILL.md
//   git@github.com:owner/repo.git
//   owner/repo
function parseGithubSkillTarget(input) {
  const raw = String(input || '').trim();
  if (!raw) throw githubImportError('github_url_required', 400);

  const ssh = raw.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (ssh) return { owner: ssh[1], repo: ssh[2], ref: '', filePath: '' };

  if (/^https?:\/\//i.test(raw)) {
    let url;
    try { url = new URL(raw); } catch { throw githubImportError('github_url_invalid', 400); }
    if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) throw githubImportError('github_url_unsupported_host', 400);
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean).map(decodeURIComponent);
    if (parts.length < 2) throw githubImportError('github_url_invalid', 400);
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/, '');
    let ref = '';
    let filePath = '';
    // /tree/<ref>/<dir…> or /blob/<ref>/<path…>
    if ((parts[2] === 'tree' || parts[2] === 'blob') && parts.length >= 4) {
      ref = parts[3];
      filePath = parts.slice(4).join('/');
    }
    return { owner, repo, ref, filePath };
  }

  const short = raw.replace(/^\/+|\/+$/g, '').match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (short) return { owner: short[1], repo: short[2], ref: '', filePath: '' };

  throw githubImportError('github_url_invalid', 400);
}

// Fetch one file from a repo via the contents API. Returns { markdown, path } or
// null when the file is missing (404), so the caller can probe candidates.
async function fetchGithubContentFile(owner, repo, filePath, ref) {
  const encodedPath = String(filePath).split('/').filter(Boolean).map(encodeURIComponent).join('/');
  let apiUrl = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`;
  if (ref) apiUrl += `?ref=${encodeURIComponent(ref)}`;

  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'DeerDawn-SkillImport' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  } else if (!warnedNoGithubToken) {
    warnedNoGithubToken = true;
    console.warn('[SKILL-IMPORT] GITHUB_TOKEN unset — GitHub imports are limited to 60 req/hour shared across all users (server IP). Set GITHUB_TOKEN to raise this to 5,000/hour.');
  }

  let res;
  try {
    res = await safeGet(apiUrl, { headers, responseType: 'json', validateStatus: (s) => s === 200 || s === 404 });
  } catch (err) {
    // 403 with an exhausted rate limit is the common failure for unauthenticated pulls.
    if (err?.response?.status === 403) throw githubImportError('github_rate_limited', 429);
    throw githubImportError('github_fetch_failed', 502);
  }
  if (res.status === 404) return null;

  const data = res.data;
  // Files >1 MB come back with encoding:'none' and an empty body — treat as unusable.
  if (!data || data.type !== 'file' || data.encoding !== 'base64' || typeof data.content !== 'string') return null;
  const markdown = Buffer.from(data.content, 'base64').toString('utf8');
  return { markdown, path: data.path || filePath };
}

// Fall back to the folder/repo name when a SKILL.md omits a frontmatter name.
function deriveSkillNameFromPath(repo, filePath) {
  const parts = String(filePath || '').split('/').filter(Boolean);
  const dir = parts.length >= 2 ? parts[parts.length - 2] : '';
  const base = dir && dir.toLowerCase() !== 'skills' ? dir : repo;
  return String(base || 'imported-skill')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Resolve a pasted repo URL to a parsed skill payload (no DB write). The route
// applies entitlement gating, then hands this to upsertSkill.
async function fetchSkillFromGithub(repoUrl) {
  const { owner, repo, ref, filePath } = parseGithubSkillTarget(repoUrl);

  // If the URL already points at a markdown file, use it verbatim; otherwise
  // probe SKILL.md inside the given folder (or the repo root).
  const candidates = [];
  if (filePath && /\.md$/i.test(filePath)) {
    candidates.push(filePath);
  } else {
    const base = filePath ? filePath.replace(/\/+$/, '') : '';
    for (const name of GITHUB_SKILL_FILENAMES) {
      candidates.push(base ? `${base}/${name}` : name);
    }
  }

  let found = null;
  for (const candidate of candidates) {
     
    const file = await fetchGithubContentFile(owner, repo, candidate, ref);
    if (file) { found = file; break; }
  }
  if (!found) throw githubImportError('skill_file_not_found', 404);

  const { name: fmName, description: fmDescription } = parseSkillFrontmatter(found.markdown);
  const name = String(fmName || '').trim() || deriveSkillNameFromPath(repo, found.path);
  const description = String(fmDescription || '').trim() || `Imported from ${owner}/${repo}`;
  const sourceUrl = `https://github.com/${owner}/${repo}/blob/${ref || 'HEAD'}/${found.path}`;

  return {
    name,
    description,
    markdown_content: found.markdown,
    slug: slugifySkill(name),
    source_url: sourceUrl,
    owner,
    repo,
  };
}

// A PROJECT-SCOPED SKILL IS PART OF ITS PROJECT, and reads with it.
//
// `?project_id=` used to be taken at its word: any teammate who named a
// colleague's `personal` project got that project's skills listed (and could
// then load one by slug). With `actor` given, a project this actor may not read
// is treated exactly like a project that does not exist — the workspace-wide
// skills and nothing else — so the answer neither leaks the skills nor confirms
// the project is there. Callers that pass no actor (the quota count) are
// unchanged; a solo workspace resolves to "unrestricted" and is unchanged too.
async function skillProjectReadable(actor, ownerKey, projectId) {
  if (!actor || !projectId) return true;
  const visible = await visibleProjectIdsForActor(actor, ownerKey);
  return !visible || visible.has(projectId);
}

async function listWorkspaceSkills(ownerKey, { project_id = null, actor = null, includeDisabled = false } = {}) {
  const projectId = project_id && await skillProjectReadable(actor, ownerKey, project_id) ? project_id : null;
  return store.listWorkspaceSkills(ownerKey, projectId, { includeDisabled });
}

async function getWorkspaceSkill(ownerKey, idOrSlug, { actor = null } = {}) {
  const skill = await store.getWorkspaceSkill(ownerKey, idOrSlug);
  if (skill && !(await skillProjectReadable(actor, ownerKey, skill.project_id))) return null;
  return skill;
}

// ─── Who may write a shared skill ───────────────────────────────────────────
//
// A skill is agent INSTRUCTIONS distributed to every session in the workspace,
// so these routes were the highest-leverage unguarded writes in the product:
// they carried requireAuth and nothing else, which every credential holds,
// including a VIEWER's read-only key. A read-only teammate could author skills,
// overwrite a colleague's body with instructions of their own, import one from
// an arbitrary GitHub repo, and delete every skill in the workspace — and the
// next session in that workspace would execute the result.
//
// Two different questions, answered separately:
//   - MAY THIS PERSON WRITE HERE AT ALL? Workspace role, resolved against the
//     BOUND workspace. Not actor.role, which is 'admin' by default for nearly
//     every self-signup and absent on internal actors; not a scope, which a
//     read-only session also carries.
//   - MAY THEY REPLACE *THIS* SKILL? Owner-or-author. A member authoring their
//     own skills is the product working; silently replacing somebody else's
//     instructions is not a thing any screen offers.
function skillWriteForbidden(message) {
  const err = new Error('skill_write_forbidden');
  err.status = 403;
  err.code = 'skill_write_forbidden';
  err.publicMessage = message;
  return err;
}

// A bare owner key used to be the first argument of every skill write. Passing
// one now would resolve to no role at all and fail open-ish in confusing ways,
// so it is rejected as the programming error it is.
function assertSkillActor(actor) {
  if (!actor || typeof actor !== 'object') {
    throw new TypeError('skill writes take an actor, not an owner key');
  }
}

async function resolveSkillWriteRole(actor) {
  assertSkillActor(actor);
  const ownerKey = workspace.defaultOwnerKey(actor);
  const role = await workspace.resolveRole(actor, ownerKey).catch(() => null);
  if (!workspace.canWrite(role)) {
    throw skillWriteForbidden('Your role in this workspace is read-only, so you cannot change its shared skills.');
  }
  return { ownerKey, role };
}

// NULL created_by means the row predates authorship and belongs to the
// workspace as a whole — the same convention context_projects uses for
// owner_user_id. Matched on the identity SET, because for a key-authed actor
// (nearly all MCP traffic) actor.id is the KEY id while created_by is a person.
function isSkillAuthor(actor, skill) {
  if (!skill || !skill.created_by) return true;
  return workspace.actorIdentities(actor).includes(skill.created_by);
}

// The same two questions the write gate asks, answered per row for a LIST, so a
// screen can stop offering an edit that will be refused. The dashboard showed
// every member an Edit and a Delete on every skill, and a colleague's skill
// answered skill_write_forbidden only after they had typed their changes.
// Never throws: a list that cannot resolve a role says nobody may edit.
async function annotateSkillsForActor(actor, skills = []) {
  let role = null;
  try {
    role = await workspace.resolveRole(actor, workspace.defaultOwnerKey(actor));
  } catch { role = null; }
  const mayWrite = workspace.canWrite(role);
  const administers = workspace.canAdminister(role);
  return (skills || []).map((skill) => ({
    ...skill,
    can_edit: Boolean(mayWrite && (administers || isSkillAuthor(actor, skill))),
  }));
}

function assertMaySupersedeSkill(actor, role, skill, verb) {
  if (isSkillAuthor(actor, skill) || workspace.canAdminister(role)) return;
  throw skillWriteForbidden(`Only the person who wrote this skill, or a workspace owner, can ${verb} it.`);
}

async function upsertSkill(actor, input = {}) {
  const { ownerKey, role } = await resolveSkillWriteRole(actor);
  // Update-aware: when a skill_id is supplied, merge the patch onto the existing
  // row so partial updates (e.g. an enabled-toggle with no name/body) work and
  // don't 400. slug is the stable identity — a rename changes the display name,
  // never the slug, so updates never orphan a row under the (owner_key, slug) key.
  const existing = input.skill_id ? await store.getWorkspaceSkill(ownerKey, input.skill_id) : null;

  const name = String(input.name != null ? input.name : (existing?.name || '')).trim();
  const slug = existing ? existing.slug : slugifySkill(input.slug || name);

  // The write lands ON CONFLICT (owner_key, slug), so the row this replaces is
  // the one at that slug — not only the one named by skill_id. Checking
  // authorship against skill_id alone would leave the whole defect intact for
  // anybody who typed the name instead of the id.
  const superseded = existing || (slug ? await store.getWorkspaceSkill(ownerKey, slug) : null);
  if (superseded) assertMaySupersedeSkill(actor, role, superseded, 'change');
  if (!name || !slug) {
    const err = new Error('skill_name_required');
    err.status = 400;
    throw err;
  }

  const rawMd = input.markdown_content != null
    ? String(input.markdown_content)
    : (existing?.markdown_content || '');
  const rawDesc = input.description != null
    ? String(input.description)
    : (existing?.description || '');

  // Secret scan runs on the RAW author input — BEFORE the sanitizers redact it —
  // so a pasted credential is rejected loudly (422) rather than silently mangled
  // into a broken skill body. (cleanSyncedText -> redactSecrets would otherwise
  // strip the match before this scan could see it.)
  if (SKILL_SECRET_RE.test(rawMd) || SKILL_SECRET_RE.test(rawDesc)) {
    const err = new Error('skill_contains_secret');
    err.status = 422;
    throw err;
  }

  const md = neutralizeInjectedText(cleanSyncedText(rawMd));
  const description = neutralizeInjectedText(cleanSyncedText(rawDesc));

  return store.upsertWorkspaceSkill({
    skill_id: superseded?.skill_id || makeId('skill'),
    owner_key: ownerKey,
    created_by: superseded?.created_by || workspace.actorPersonId(actor),
    project_id: input.project_id !== undefined ? (input.project_id || null) : (existing?.project_id || null),
    slug,
    name,
    description,
    markdown_content: md,
    visibility: input.visibility || existing?.visibility || 'private',
    enabled: input.enabled !== undefined ? input.enabled !== false : (existing ? existing.enabled : true),
  });
}

async function deleteSkill(actor, skillId) {
  const { ownerKey, role } = await resolveSkillWriteRole(actor);
  const existing = await store.getWorkspaceSkill(ownerKey, skillId);
  if (!existing) {
    // A delete that matched nothing used to return 204. "Deleted" and "there was
    // never anything there" must not be the same answer on a destructive route.
    const err = new Error('skill_not_found');
    err.status = 404;
    throw err;
  }
  assertMaySupersedeSkill(actor, role, existing, 'delete');
  return store.deleteWorkspaceSkill(ownerKey, existing.skill_id);
}

module.exports = {
  assertProjectMutable,
  assertProjectWritable,
  assertProjectRenamable,
  repairProjectIntegrity,
  listProjects,
  listProjectTree,
  findProjectByName,
  findProjectCandidatesByName,
  resolveActiveProject,
  listRoutingAlternatives,
  takeDeadBindingNotice,
  ownWorkElsewhereNote,
  workspaceLabel,
  describeMatch,
  createProject,
  setProjectParent,
  renameProject,
  switchSubproject,
  bindSessionToProject,
  describeProjectPlacement,
  recordTaskReview,
  readTaskReview,
  forgetTaskReview,
  planTaskCompletion,
  archiveProject,
  unarchiveProject,
  listArchivedProjectSummaries,
  getSession,
  listSessions,
  upsertSession,
  patchSession,
  getProjectPresence,
  touchSession,
  getProject,
  applyExtraction,
  renderInjection,
  applyPlanHistoryWindow,
  formatAgedOutLine,
  sectionsTouchHistoryWindow,
  resolveQuestion,
  resolveProjectDecision,
  resolveMatch,
  getPreferences,
  updatePreferences,
  getGlobalContext,
  updateGlobalContext,
  profileNeedsReview,
  dismissProfileReview,
  updateProjectContext,
  staleContextVersionError,
  getProjectGraph,
  getSessionGraph,
  exportContext,
  bindSessionTopic,
  getSessionTopic,
  getNodeGraph,
  getWorkspaceEntities,
  visibleGraphNodesForActor,
  echoGraphNodesForActor,
  previewBoardOpenLimit,
  previewProjectContextWrite,
  visibleProjectIdsForActor,
  auditScopeForActor,
  filterGraphDataForActor,
  assertGraphNodeWritable,
  assertGraphNodeCreatable,
  assertNewGraphNodeReadable,
  assertGraphNodeKeyUpsertable,
  getWorkspaceOverview,
  getProjectMap,
  findKnownPaths,
  buildSubagentBrief,
  recordHotPaths,
  RecordHotPathItemSchema,
  assertProjectCreatable,
  decisionNodeMatches,
  decisionNodeNamedByOpening,
  decisionNodeText,
  decisionNodeFullKey,
  unscopedEntityKey,
  entityGroupKey,
  boundedKeyBase,
  decisionsResolvedBy,
  recordDebugFinding,
  stripServerOnlyNodeMetadata,
  confirmClaim,
  getNextBestContext,
  upsertWorkspaceEntities,
  applyStructuredContextEvent,
  deleteGraphNode,
  getProjectSharePolicy,
  defaultShareSectionRows,
  canEditSectionForActor,
  canViewProjectForActor,
  // Exported for the readers that load project rows themselves (share preview,
  // portfolio, cross-project retrieval): the section-filtered view, not the row.
  projectViewForActor,
  viewProjectsForActor,
  // Exported for shareService: publishing a brief is the author's call, and the
  // NULL-owner_user_id convention must not be re-derived anywhere else.
  isProjectOwner,
  // Exported for unit testing of ranking behavior (pure functions)
  rankWorkspaceNodes,
  buildAutoPromotedMemoryEntities,
  scoreProjectForCwd,
  matchKindForCwd,
  // Exported for unit testing of write-time and staleness gates (pure functions)
  sanitizeExtraction,
  recordExplicitUpdate,
  annotateSkillsForActor,
  parseExplicitOpenQuestions,
  isExplicitTaskProtected,
  classifyStaleness,
  // Exported for unit testing of integrity-repair normalization (pure functions):
  // guards that update_context PATCHes don't strip replayable debug anchors.
  normalizeContextForSchema,
  buildIntegrityRepairPatch,
  // Exported for the retrieval-reinforcement (compounding) loop + its tests
  trackWorkspaceSelections,
  // Cross-project affinity (compounding): strengthen + read "projects you work alongside"
  recordProjectAffinities,
  getRelatedProjectsByAffinity,
  // Team/shared-workspace (social lock-in): who collectively built a project's context
  getProjectContributors,
  // Shared skills (markdown know-how distributed across connected tools)
  listWorkspaceSkills,
  getWorkspaceSkill,
  upsertSkill,
  deleteSkill,
  fetchSkillFromGithub,
  parseGithubSkillTarget,
};

// ─── Editing a memory node was gated on a scope every session already holds ──
//
// POST/PATCH/DELETE /graph/nodes carried requireContextWrite, which checks the
// context:write SCOPE — derived from users.role, present on every Clerk session
// and every self-signup. Inside a shared workspace that separated nobody from
// anybody: a VIEWER could rewrite or permanently delete a colleague's memory
// nodes, and `owner_key` matched because owner_key IS the workspace.
//
// The gate is the same one the rest of the service uses, in the same order:
//   1. can you SEE it at all → node_not_found (never "forbidden", which would
//      confirm the id exists — see the visibility block above);
//   2. may you WRITE in this workspace at all → share_write_forbidden for a
//      viewer, whatever scope rode in on the credential;
//   3. may you write THIS project's knowledge → share_write_forbidden, because a
//      node hanging off a project is that project's content. A node attached to
//      no project is workspace-scoped by construction and needs only (2).
//
// Deliberately NOT keyed on authorship of the node: context_graph_nodes has no
// author column, and inventing one from source_session_id would attribute every
// node promoted by extraction to whoever happened to be in the session. The
// project IS the authorship record, which is the same thing
// portfolio-cross-project-evidence had to conclude.
async function assertGraphNodeWritable(actor, nodeId) {
  const ownerKey = getActorKey(actor);
  const node = await store.getGraphNode(ownerKey, nodeId);
  if (!node) throw new Error('node_not_found');
  await assertExistingGraphNodeWritable(actor, ownerKey, node);
  return node;
}

// The same gate for a node already in hand. Split out for upsertWorkspaceEntities,
// which resolves its target through the dedup pass rather than by id and would
// otherwise re-fetch a row it is holding. `gate` lets that caller share its
// per-call project memo; on its own it falls back to resolving directly.
async function assertExistingGraphNodeWritable(actor, ownerKey, node, gate = null) {
  const access = await graphNodeAccessForActor(actor, ownerKey, node);
  if (!access.visible) throw new Error('node_not_found');
  // SEEN IN PART IS NOT WRITABLE. A shared project's root reaches a teammate
  // with its summary and stack blanked when the share withholds description,
  // status, task or stack; the node is visible, so the check above passed, and
  // PATCH /graph/nodes and upsert_entities then rewrote the root's summary and
  // answered with the stored row — the withheld description and stack included.
  // Round 19's rule for a hidden node (a write is refused, not merged) applies
  // to the part of a node that is hidden. 403, not 404: the node is visible.
  if (access.withheld.length) {
    throw writeForbiddenError(
      `share_write_forbidden: this project's summary draws on ${access.withheld.join(', ')}, which ${access.withheld.length === 1 ? 'is' : 'are'} not shared with you, so you cannot change its node. Ask its owner to share ${access.withheld.length === 1 ? 'that section' : 'those sections'}.`,
      access.withheld,
    );
  }
  // allowArchived, and only on this path. A graph node is unique per owner and
  // keeps the FIRST project it was seen in, so a node whose home project has
  // since been archived is still the row that live projects' saves land on
  // ("Redis", first learned in a project retired last year). Refusing those
  // would drop ordinary saves into live work because of where an entity
  // happened to be learned. FILING a new node under an archived project is the
  // different case and is still refused — assertGraphNodeCreatable.
  const loaded = await (gate ? gate(node.project_id || null) : assertGraphProjectWritable(actor, ownerKey, node.project_id, { allowArchived: true }));
  assertGraphNodeSectionsEditable(actor, node, loaded);
}

// SEEN IS NOT EDITABLE, PER SECTION.
//
// The gate above asks "may this actor change the PROJECT", which on a shared
// project is any member with a write role. A share can still make a section
// view-only (can_view, not can_edit): PATCH /projects/:id/context refused the
// member's edit of recent_decisions, while PATCH and DELETE of the decision's
// graph node — and resolve / mark_resolved, which upsert the node with
// status:resolved and so drop it from every brief — went straight through.
// Deleting a node is irreversible, so this is the same per-section rule the
// context write applies, judged on the node's HOME project (the row keeps it
// whatever project a caller files a write under).
//
// Which sections a node belongs to is the read filter's own mapping
// (graphNodeSectionsNeeded); a type with no section needs the default share's
// sections, as it does to be read. A project root draws on the summary sections
// and the stack. The author, a solo account and a workspace-scoped node (no
// project) are unaffected.
function graphNodeSectionsForEdit(node) {
  if (node?.node_type === 'project') return [...PROJECT_ROOT_SUMMARY_SECTIONS, 'tech_stack'];
  const { sections, unmapped } = graphNodeSectionsNeeded(node);
  return [...new Set([...sections, ...(unmapped ? DEFAULT_SHARED_SECTIONS : [])])];
}

function assertGraphNodeSectionsEditable(actor, node, loaded) {
  const project = loaded?.project;
  if (!project || !node?.project_id) return;
  if (holdsAuthorRights(actor, project, loaded.policy)) return;
  assertCanEditSections(actor, project, loaded.policy, graphNodeSectionsForEdit(node));
}

// Same gate for a node that does not exist yet, judged on the project it is
// being filed under.
async function assertGraphNodeCreatable(actor, projectId) {
  const ownerKey = getActorKey(actor);
  if (projectId) {
    const stored = await store.getProject(ownerKey, projectId);
    const project = await repairProjectIntegrity(stored, { persist: false });
    if (!project) throw new Error('project_not_found');
    const policy = await getProjectSharePolicy(actor, project);
    if (!canViewProjectForActor(actor, project, policy)) throw new Error('project_not_found');
  }
  await assertGraphProjectWritable(actor, ownerKey, projectId);
}

// A NEW NODE THE WRITER COULD NEVER READ IS NOT WRITTEN.
//
// The graph read filter hides a node filed under a shared project when the
// share withholds its section (a service needs tech_stack; a hand-written
// knowledge node needs the default sections). The write paths never asked, so a
// member filing "Redis Cache Layer" into a share without tech_stack got it
// stored, answered with a withheld stub (REST) or "Upserted 1" (MCP) — and then
// could not read it, save it again (resource_not_found), change it or delete it
// (404). A write the writer can never see again is a write into somebody else's
// hidden section, so it is refused up front, naming the section, nothing stored.
//
// Only for a node that does not exist yet: an existing row is judged by
// assertExistingGraphNodeWritable. Workspace-scoped nodes (no project) are not
// governed by any share and pass.
async function assertNewGraphNodeReadable(actor, node) {
  const projectId = node?.project_id || null;
  if (!projectId) return;
  const scope = await graphScopeForActor(actor, getActorKey(actor));
  const allowed = scope?.restricted?.get(projectId);
  if (!allowed || nodeSectionAllowedIn(node, projectId, scope.restricted)) {
    await assertNewGraphNodeEditable(actor, node);
    return;
  }
  const { sections, unmapped } = graphNodeSectionsNeeded(node);
  const blocked = [...new Set([
    ...sections.filter((section) => !allowed.has(section)),
    ...(unmapped ? DEFAULT_SHARED_SECTIONS.filter((section) => !allowed.has(section)) : []),
  ])];
  const type = String(node.metadata?.entity_type || node.node_type || 'node');
  throw writeForbiddenError(
    `share_write_forbidden: nothing was saved. A ${type} filed under this project belongs to ${blocked.join(', ')}, `
    + `which ${blocked.length === 1 ? 'is' : 'are'} not shared with you, so you could never read, change or delete it once written. `
    + `File it without a project (workspace scope), or ask the project's owner to share ${blocked.length === 1 ? 'that section' : 'those sections'}.`,
    blocked,
  );
}

// READABLE IS NOT EDITABLE, FOR A NEW NODE EITHER. An existing node needs edit
// on its sections (assertGraphNodeSectionsEditable); a new one only had to be
// readable, so a member whose share made decisions and the stack VIEW-ONLY
// created decision and service nodes in the owner's project — in the owner's
// Knowledge web, and never editable by their author again (scan 30). The same
// per-section rule, judged on the project the node is filed under; its author,
// a solo account and a workspace-scoped node are unaffected.
async function assertNewGraphNodeEditable(actor, node) {
  const projectId = node?.project_id || null;
  if (!projectId) return;
  const loaded = await loadProjectForWrite(actor, projectId, { requireWriteRole: false, allowArchived: true });
  if (!loaded) return;
  assertGraphNodeSectionsEditable(actor, node, loaded);
}

// POST /graph/nodes writes through upsertGraphNode, whose ON CONFLICT target is
// (owner_key, node_type, canonical_key) — and the key is built from the TITLE.
// owner_key is the workspace, so a member filing "ledger-svc" under their own
// project landed on a colleague's PERSONAL node of that title: the 201 handed
// back its summary, id and project, the metadata merged into it, and a short
// stored summary was replaced. The project gate above only judged the project
// the caller NAMED; the row the upsert actually lands on was never judged.
//
// Judged here the way upsertWorkspaceEntities judges its exact-key match:
// an existing row the caller cannot see is node_not_found (refused before any
// write, so nothing merges and nothing of it is returned); one they can see but
// whose home project they may not change is share_write_forbidden, because the
// conflict keeps the EXISTING row's project whatever the caller filed it under.
async function assertGraphNodeKeyUpsertable(actor, nodeType, canonicalKey) {
  const ownerKey = getActorKey(actor);
  const existing = await store.getGraphNodeByCanonicalKey(ownerKey, nodeType, canonicalKey);
  if (!existing) return null;
  await assertExistingGraphNodeWritable(actor, ownerKey, existing);
  return existing;
}

async function assertGraphProjectWritable(actor, ownerKey, projectId, { allowArchived = false } = {}) {
  if (!projectId) {
    await assertWorkspaceWritable(actor, ownerKey);
    return;
  }
  // requireWriteRole: false so the workspace check runs once, below, with the
  // per-project role resolved — the same sequence loadProjectForWrite runs for a
  // project write.
  const loaded = await loadProjectForWrite(actor, projectId, { requireWriteRole: false, allowArchived });
  // Visible as a NODE (through a sighting elsewhere) but its home project is one
  // the caller cannot open: readable, not writable. 403, not 404 — the caller can
  // already see the node, so there is no existence left to protect.
  if (!loaded) {
    throw writeForbiddenError(
      'share_write_forbidden: this entity belongs to a project you cannot change. Ask its author to share it.'
    );
  }
  await assertWorkspaceWritable(actor, loaded.project.owner_key || ownerKey, projectWriteRole(loaded.project, loaded.policy));
  assertCanWriteProject(actor, loaded.project, loaded.policy);
  return loaded;
}

async function deleteGraphNode(actor, nodeId) {
  const ownerKey = getActorKey(actor);
  // Deleting somebody's memory is irreversible and was reachable by anybody
  // holding a session in the workspace.
  await assertGraphNodeWritable(actor, nodeId);
  await store.deleteGraphNode(ownerKey, nodeId);
}
