const { z } = require('zod');
const coordination = require('./coordination.js');

// Multi-agent coordination (presence, board holds, staleness). Imported rather
// than restated so the writer (mergeContextObject applying a hold) and every
// reader (the board renderer, next-best work, the brief block) share one
// definition of what "held" means and cannot drift apart.
const { applyHold, holdState, partitionHeldCards, formatExcludedLine } = coordination;

const VERBOSITY_VALUES = ['light', 'standard', 'detailed'];
const TOOL_VALUES = ['claude_web', 'chatgpt_web', 'gemini', 'perplexity', 'cursor', 'claude_code', 'codex'];
// Where a stored graph fact came FROM, which is a wider question than which
// client tool is asking. POST /graph/nodes (the dashboard's "add node") has
// always stamped source_tool 'dashboard', and the node schemas validated
// provenance against TOOL_VALUES, so ONE hand-added node made every read that
// parsed it fail: start_session answered invalid_arguments, recall context
// internal_error, and the node's own graph routes 400 — until it was deleted.
//
// A separate list, not an eighth TOOL_VALUES entry: TOOL_VALUES is also what
// the ingest routes accept as the CALLING client (`tool` on /extraction,
// /match, sessions) and what the brief is formatted for, and 'dashboard' is
// neither. Widening it would let a caller ask for a brief shaped for a tool
// with no profile. Only provenance fields read this one.
const GRAPH_SOURCE_TOOL_VALUES = [...TOOL_VALUES, 'dashboard'];
const MATCH_DECISION_VALUES = ['matched_existing', 'new_project', 'ambiguous', 'ignored'];
const SURFACE_TYPE_VALUES = ['browser', 'cli', 'code'];
const SESSION_STATUS_VALUES = ['active', 'paused', 'idle', 'closed', 'ambiguous'];
const ROUTING_STATE_VALUES = ['matched', 'ambiguous', 'stale_match', 'global_only'];
const GRAPH_NODE_TYPE_VALUES = [
  'project', 'repo', 'file', 'component', 'feature', 'decision', 'task', 'person', 'company', 'service', 'concept',
  'knowledge', 'question', 'tool', 'environment', 'database', 'capability', 'workflow', 'preference',
];
const GRAPH_EDGE_TYPE_VALUES = [
  'depends_on', 'implements', 'mentions', 'related_to', 'used_in', 'decided_by', 'blocks', 'owns', 'same_as', 'contains', 'tracks',
  'supports', 'uses', 'prefers', 'rule',
];

const DECISION_IMPORTANCE_VALUES = ['low', 'normal', 'high', 'critical'];

const DecisionEntrySchema = z.object({
  summary: z.string().min(1),
  // headline: the one-line form of the claim, for surfaces that quote a decision
  // rather than display it — chiefly the cross-project block injected into
  // another project's brief, where the full summary cannot be afforded.
  // What gets stored in `summary` is often a whole session's write-up: sampled
  // 2026-08-28 at 846 to over 4,000 characters. Three of those is more than a
  // thousand tokens on a brief that has other work to do. Extraction fills this
  // going forward; decisionHeadline() derives one for everything already stored.
  headline: z.string().max(200).optional(),
  reasoning: z.string().optional(),
  decided_at: z.string().datetime(),
  importance: z.enum(['low', 'normal', 'high', 'critical']).optional().default('normal'),
  // Resolved decisions are retained for retrieval but excluded from active context loads.
  resolved: z.boolean().optional().default(false),
  resolved_at: z.string().datetime().optional(),
  // Per-item provenance / trust (all optional; preserved by the spread normalizers).
  // date_inferred: decided_at was stamped because the source omitted a real date,
  // so it must not be treated as genuinely "fresh" when ordering the brief.
  date_inferred: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
  source_tool: z.string().optional(),
  source_session_id: z.string().optional(),
  // verified_at: a later session/agent confirmed the claim still holds (verify primitive).
  verified_at: z.string().datetime().optional(),
  verified_commit: z.string().optional(),
  // WHO. A decision with no author is folklore.
  //
  // Attribution existed one layer down — context_events.contributing_user_id is
  // written on every sync and listProjectContributors aggregates it — but it
  // never crossed into the brief, so the thing a shared workspace is actually
  // for ("what did somebody else learn about this codebase") arrived anonymous.
  // A claim nobody is named on cannot be trusted, chased, or retired.
  //
  // Optional and nullable on purpose: everything written before this existed has
  // no author, and a null must render as "unattributed" rather than silently
  // looking like the reader's own.
  contributed_by: z.string().nullish(),
  // Currency, as distinct from age. Facts written by people decay, and the
  // person who wrote one may have left. "Sarah wrote this in March and nobody
  // has confirmed it since" is a different statement from "this is old".
  confirmed_by: z.string().nullish(),
  confirmed_at: z.string().datetime().optional(),
  // WIRE-ONLY. A git author email carried in on an import, resolved to a member
  // and replaced with contributed_by before anything is stored. The MCP server
  // can read git but has no idea who is in the workspace; the API knows the
  // roster but has no repo. So the email travels and the id is what persists —
  // an email that matches nobody resolves to null, never to an invented member.
  author_email: z.string().nullish(),
});

const CommandEntrySchema = z.object({
  label: z.string().min(1),
  run: z.string().min(1),
  note: z.string().optional(),
});

const HotPathEntrySchema = z.object({
  label: z.string().min(1),
  path: z.string().min(1),
  purpose: z.string().optional().default(''),
  // Optional ranking hints so a high-value path survives cap eviction over
  // trivial newer ones, and surfaces first. All optional (spread-preserved).
  importance: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  pinned: z.boolean().optional(),
  // WHO recorded it. Lets a full list age out a teammate's own oldest path
  // before anybody else's (recordHotPaths, append mode). Optional and nullable:
  // every path recorded before this has no author. See DebuggingNoteEntrySchema.
  contributed_by: z.string().nullish(),
});

const EntrypointEntrySchema = z.object({
  label: z.string().min(1),
  path: z.string().min(1),
  purpose: z.string().optional().default(''),
});

const SurfaceEntrySchema = z.object({
  label: z.string().min(1),
  paths: z.array(z.string().min(1)).default([]),
  purpose: z.string().optional().default(''),
});

const DebuggingNoteEntrySchema = z.object({
  summary: z.string().min(1),
  paths: z.array(z.string().min(1)).default([]),
  added_at: z.string().datetime(),
  // Optional references that make a finding replayable rather than just locatable.
  commit_ref: z.string().optional(),
  diff_ref: z.string().optional(),
  // Per-item provenance / trust (all optional; preserved by the spread normalizers).
  confidence: z.number().min(0).max(1).optional(),
  source_tool: z.string().optional(),
  source_session_id: z.string().optional(),
  verified_at: z.string().datetime().optional(),
  // Ranking hints so a high-value finding survives cap eviction and surfaces first.
  importance: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  pinned: z.boolean().optional(),
  // WHO. Same field, same type and same optionality as DecisionEntrySchema's —
  // read that one for why a claim with no author is folklore.
  //
  // A decision was the only one of these lists that carried it, and a zod object
  // strips what it does not declare: every stamp the write path applied to a
  // note, a landmine or a shipped entry was parsed away here without a word, so
  // a teammate who FOUND something rather than DECIDED something reached nobody.
  // Nullish for the same reason as decisions: everything written before this
  // existed has no author, and a null must render as "unattributed" rather than
  // silently looking like the reader's own.
  contributed_by: z.string().nullish(),
});

// LANDMINE slot — a sharp, durable watch-out (footgun, fragile invariant, dead
// code, something that already bit someone) that causes breakage/rework if
// forgotten. Object entry (not a bare string) so per-item trust/provenance work,
// modeled on DebuggingNoteEntrySchema + DecisionEntry's provenance set. May be
// LLM-extracted (confidence-gated) or written explicitly. Distinct from
// open_questions (unanswered) and recent_decisions (choices).
const LandmineEntrySchema = z.object({
  summary: z.string().min(1),
  paths: z.array(z.string().min(1)).default([]),
  added_at: z.string().datetime(),
  // Ranking hint — 'high' default because a landmine is a watch-out worth
  // surfacing; 'critical' for data-loss/security footguns.
  importance: z.enum(['low', 'normal', 'high', 'critical']).optional().default('high'),
  pinned: z.boolean().optional(),
  // Per-item provenance / trust (all optional; preserved by the spread normalizers).
  confidence: z.number().min(0).max(1).optional(),
  source_tool: z.string().optional(),
  source_session_id: z.string().optional(),
  date_inferred: z.boolean().optional(),
  verified_at: z.string().datetime().optional(),
  verified_commit: z.string().optional(),
  // WHO hit it. See DebuggingNoteEntrySchema.contributed_by above.
  contributed_by: z.string().nullish(),
});

// SHIPPED slot — a completion event accumulator. Populated DETERMINISTICALLY from
// structured task_completed/feature_shipped events (never the LLM), so each entry
// is a confident, real "this shipped" fact rather than an inferred claim.
const ShippedEntrySchema = z.object({
  summary: z.string().min(1),
  shipped_at: z.string().datetime(),
  source_tool: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  commit_ref: z.string().optional(),
  pinned: z.boolean().optional(),
  // WHO shipped it. See DebuggingNoteEntrySchema.contributed_by above.
  contributed_by: z.string().nullish(),
  // THE BOARD CARD THIS LINE CAME FROM (journey r6). A card moved to Done writes a
  // shipped line, and the line follows the card: moved back out of Done or deleted
  // it goes, renamed its text follows (followBoardCardsInShipped). Also what lets a
  // surface say "Shipped" rather than "Verified": a Done card is a completion
  // somebody reported, not one anybody checked. Absent on every line that did not
  // come from a card (a structured event, an extraction).
  card_id: z.string().optional(),
});

const TaskStepSchema = z.object({
  name: z.string().min(1),
  status: z.enum(['todo', 'in_progress', 'done']),
});

// ─── Task board (scrum-style phased columns) ────────────────────────────────
// Every project todo is a board card that flows across a fixed phase pipeline.
// This is the single, unified task tracker — it supersedes the old flat
// todo_items/completed_todos split (completed_todos is kept read-only for
// back-compat and folded into the "done" column). Ordered left→right.
const BOARD_PHASES = ['backlog', 'blocked', 'in_progress', 'integration', 'testing', 'done'];
const BOARD_PHASE_LABELS = {
  backlog: 'Backlog',
  blocked: 'Blocked',
  in_progress: 'In Progress',
  integration: 'Integration',
  testing: 'Testing',
  done: 'Done',
};
const DEFAULT_BOARD_PHASE = 'backlog';
const DONE_BOARD_PHASE = 'done';

// Coerce any legacy/unknown phase value to a valid column so old JSONB and
// fuzzy agent input never fail the schema parse.
function normalizeBoardPhase(value) {
  const v = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return BOARD_PHASES.includes(v) ? v : DEFAULT_BOARD_PHASE;
}

// A card in In Progress is HELD by the agent session that moved it there, so a
// second agent asking for work is not handed a card someone is already on. Both
// fields are optional+nullable: every context JSONB written before holds existed
// validates unchanged and simply reads as unheld.
//
// A hold is advisory and EXPIRES — see holdState(). Nothing is stored as
// "expired"; staleness is computed from held_at at read time, so a crashed agent
// releases its card by doing nothing, and no reaper job has to exist.
// Board size limits. These MUST stay the single source of truth for both the
// schema bound and the trim in mergeContextObject: when the two drifted apart,
// the trim produced boards the schema then rejected, and the only way to satisfy
// the schema was to silently destroy the user's open cards.
//
// MAX_TODO_ITEMS bounds what a context can store at all. It is generous because
// the token-sensitive read paths (the brief, next-work suggestions) already take
// their own small slices — the full board only ever leaves on an explicit board
// listing, which is a thing the user asked for.
//
// MAX_DONE_RETAINED is the ceiling on the Done column specifically. Completed
// work is history: valuable, but never at the cost of open work. Holding it at
// 100 means no board that validates today loses a single card to this change.
const MAX_TODO_ITEMS = 300;
const MAX_DONE_RETAINED = 100;

// A card's BODY: the detail that does not belong in its title.
//
// The board stored titles and nothing else, so every spec detail either became
// an unreadable 800-character title or was lost. On a board where the title IS
// the body, a wrong file path is the whole card — four shipped that way before
// anyone noticed, and listing the live board now overruns the MCP response
// budget purely because titles are carrying prose.
//
// 2,000 characters ≈ 500 tokens: comfortably more than the 500-900 character
// titles people were cramming into cards, and small enough that opening several
// cards in one call stays cheap. A body is never rendered in a board listing —
// the listing marks which cards have one, and you open those.
//
// Over-long bodies are CLIPPED, never rejected. Same rule as normalizeBoardPhase
// above: stored JSONB must always survive a parse, because the only way to
// satisfy a schema that rejects it is to destroy the user's cards.
const MAX_TODO_BODY_CHARS = 2000;

// The largest .dawn archive accepted as CONTENTS by import_trail, on both MCP
// dispatchers and the REST import. Real archives are 8-30KB; this leaves wide
// headroom (roughly 7x the largest seen) while keeping one request body small:
// the MCP body parser runs before authentication and rate limiting, so every
// character allowed here is a character any caller can make the server parse. The
// hosted server also takes a Trail URL and fetches it itself (5MB cap); the local
// runtime fetches a URL and then posts the CONTENTS, so this cap applies there.
// apps/api sizes the JSON body parser for the import routes from this number.
const MAX_TRAIL_CHARS = 200_000;

// The JSON body limit for POST /api/v1/context/extraction, in bytes — the route
// the end-of-session flush posts a whole transcript to.
//
// It lives here because BOTH sides have to agree on it, and the fact that a
// client can read it matters more than the number. A Stop-hook flush that
// exceeds the cap does not fail loudly: express answers 413, the CLI prints one
// stderr line nobody reads, and the whole session's context is gone. So the MCP
// client sizes its own trim budget from this constant and sends something that
// fits, instead of discovering the cap by being refused.
//
// Deliberately NOT generous: the body parser runs before authentication, so every
// byte allowed here is a byte any unauthenticated caller can make the server
// buffer. Trimming the oldest messages client-side is the right trade — the end
// of a session is the part worth keeping.
const MAX_EXTRACTION_BODY_BYTES = 256 * 1024;

// What a client may serialize before it must trim: the cap minus headroom for
// anything added on top of the body we measured.
const EXTRACTION_BODY_BUDGET_BYTES = MAX_EXTRACTION_BODY_BYTES - 16 * 1024;

function normalizeTodoBody(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  return text.length > MAX_TODO_BODY_CHARS
    ? `${text.slice(0, MAX_TODO_BODY_CHARS - 1)}…`
    : text;
}

/**
 * Normalize whatever a caller offered as "cards to add" into {title, body?, phase?}.
 *
 * `todos: string[]` is the published contract — every existing caller, every
 * CLAUDE.md on disk, and the dashboard's own PATCH all send it — so a bare
 * string stays a bare title forever. Objects are the richer form. Both MCP
 * dispatchers and the API's todo_added event funnel through this one function so
 * the three cannot disagree about what an entry means.
 */
function normalizeTaskCardInputs(entries, defaultPhase = '') {
  const cards = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const structured = entry && typeof entry === 'object';
    const title = String((structured ? entry.title : entry) ?? '').trim();
    if (!title) continue;
    const body = normalizeTodoBody(structured ? entry.body : undefined);
    const phase = String((structured ? entry.phase : '') || defaultPhase || '').trim();
    const assignee = structured && entry.assignee ? String(entry.assignee).trim() : '';
    cards.push({
      title,
      ...(body ? { body } : {}),
      ...(phase ? { phase } : {}),
      ...(assignee ? { assignee } : {}),
    });
  }
  return cards;
}

/**
 * Resolve ONE task card from a caller's query, or refuse.
 *
 * move/complete used to apply to every card the query matched, through a
 * bidirectional substring test: completing "auth" completed "Fix the auth
 * redirect", "Rewrite auth middleware" and "Ship auth docs" together, and the
 * tool reported one card. remove had already been fixed to resolve precisely;
 * this is that same rule, shared, so the merge and both MCP dispatchers cannot
 * drift apart again.
 *
 * Order: exact id, then exact (trimmed, case-insensitive) title, then substring
 * containment — and at every tier the answer counts only when it is EXACTLY ONE
 * card. Two cards with the same title are two different cards (they carry
 * different ids), so an exact-title tie is ambiguous too, not a free pick.
 *
 * Returns { status: 'matched', query, card } | { status: 'ambiguous', query,
 * candidates } | { status: 'unmatched', query }. Blank queries never match.
 */
function resolveTaskCard(cards, query) {
  const q = String(query ?? '').trim();
  if (!q) return { status: 'unmatched', query: String(query ?? '') };
  const pool = (Array.isArray(cards) ? cards : []).filter((card) => card && typeof card === 'object');
  const lower = q.toLowerCase();
  const titleOf = (card) => String(card.title ?? '').trim().toLowerCase();
  const tiers = [
    () => pool.filter((card) => card.id === q),
    () => pool.filter((card) => titleOf(card) === lower),
    () => pool.filter((card) => {
      const title = titleOf(card);
      return Boolean(title) && (title.includes(lower) || lower.includes(title));
    }),
  ];
  for (const tier of tiers) {
    const hits = tier();
    if (hits.length === 1) return { status: 'matched', query: q, card: hits[0] };
    if (hits.length > 1) {
      return {
        status: 'ambiguous',
        query: q,
        candidates: hits.map((card) => ({ id: card.id, title: card.title, phase: card.phase })),
      };
    }
  }
  return { status: 'unmatched', query: q };
}

/** True when the text a caller supplied was longer than a card body can hold. */
function taskCardBodyWasClipped(value) {
  const text = String(value ?? '').trim();
  return text.length > MAX_TODO_BODY_CHARS;
}

// What a listing prints next to a card that has a body. Shared so the brief, the
// CLI view and both MCP dispatchers mark it identically — a marker that differs
// per surface is a marker nobody learns to look for.
const TASK_BODY_MARKER = ' +body';

const TodoItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  // Which board column the card sits in. Optional+default so every existing
  // context JSONB (written before the board existed) validates unchanged and
  // simply lands in Backlog on read.
  phase: z.string().default(DEFAULT_BOARD_PHASE).transform(normalizeBoardPhase),
  // The card's detail. Optional (and clipped rather than bounded) for exactly the
  // reason phase is defaulted: every context JSONB written before today has no
  // body at all and must still validate byte-for-byte unchanged.
  body: z.string().optional().nullable().transform(normalizeTodoBody),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime().optional().nullable(),
  completed_at: z.string().datetime().optional().nullable(),
  held_by: z.string().optional().nullable(),
  held_at: z.string().datetime().optional().nullable(),
  // WHO IS DOING THIS. Distinct from held_by, which is a transient lock naming
  // the SESSION currently touching a card; assignee is a durable statement about
  // a PERSON and survives that session ending.
  //
  // A six-column board with nobody on it is fine alone and meaningless at four:
  // "In Progress" answers what is being worked on and leaves out the only other
  // thing anybody wants to know. Optional and nullable, so every card written
  // before today validates unchanged and simply reads as unassigned — which is a
  // real state, not a gap to be filled in with a guess.
  assignee: z.string().optional().nullable(),
});

const ContextObjectSchema = z.object({
  project_name: z.string().min(1),
  // 'coding' = a software project (the original model); 'topic' = any non-coding
  // life context (a trip, a move, a health plan). Default 'coding' keeps every
  // existing project valid on read with no backfill. Drives which fields render.
  category: z.enum(['coding', 'topic']).default('coding'),
  description: z.string().default(''),
  goals: z.array(z.string()).max(15).default([]),
  current_status: z.string().default(''),
  // current_status is the most volatile claim the hard-stale banner tells agents to
  // distrust. When an agent re-confirms it still holds (verify primitive), stamp it
  // so the next session sees "verified Xd ago" instead of re-checking. Optional.
  status_verified_at: z.string().datetime().optional(),
  status_verified_commit: z.string().optional(),
  recent_decisions: z.array(DecisionEntrySchema).max(20).default([]),
  recurring_context: z.array(z.string()).max(15).default([]),
  tech_stack: z.array(z.string()).max(15).default([]),
  file_structure_summary: z.array(z.string()).max(15).default([]),
  current_task: z.string().default(''),
  // WHO set current_task. 'explicit' = a person or an agent asked for it by name
  // (update_context task, the dashboard, task_started); 'extracted' = a model
  // inferred it from a conversation. An explicit task is protected from
  // extraction until it is completed or explicitly replaced. Absent on every
  // row written before this field existed, which reads as unprotected — the
  // behaviour those rows always had.
  current_task_source: z.enum(['explicit', 'extracted']).optional(),
  current_task_set_at: z.string().datetime().optional(),
  open_questions: z.array(z.string()).max(15).default([]),
  commands: z.array(CommandEntrySchema).max(20).default([]),
  hot_paths: z.array(HotPathEntrySchema).max(40).default([]),
  entrypoints: z.array(EntrypointEntrySchema).max(20).default([]),
  surfaces: z.array(SurfaceEntrySchema).max(20).default([]),
  debugging_notes: z.array(DebuggingNoteEntrySchema).max(30).default([]),
  // Brief-spine slots (Phase A). Both .default([]) so every existing JSONB context
  // validates unchanged on read — legacy projects simply carry empty arrays until
  // the next landmine extraction / completion event populates them.
  landmines: z.array(LandmineEntrySchema).max(20).default([]),
  shipped: z.array(ShippedEntrySchema).max(15).default([]),
  last_updated: z.string().datetime(),
  source_summary: z.string().default(''),
  blocking_issue: z.string().default(''),
  // WHEN the current blocker was set — stamped by the server whenever the text
  // changes (mergeContextObject, updateProjectContext), never taken from a
  // caller. The nightly blocker reconciliation needs it to tell a decision that
  // resolved THIS blocker from an older one about the same subject: without it
  // a regression reported after "Resolved: X" was wiped every night. Absent on
  // every blocker set before it existed, which reads as "cannot be ordered".
  blocking_issue_set_at: z.string().datetime().optional(),
  task_progress: z.string().default(''),
  // The single next concrete step — surfaced in briefs so an interrupted session
  // resumes at the exact cursor instead of re-deriving it.
  next_action: z.string().default(''),
  // The tool/host that last wrote this context — used to render a cross-tool/machine
  // handoff line ("resuming from Codex on laptop") when a different tool reads it.
  last_active_tool: z.string().default(''),
  last_active_host: z.string().default(''),
  // Per-tool presence: which tools carry this project and when each last touched
  // it. The wider the coverage, the more load-bearing DeerDawn is across the
  // toolchain — surfaced as a "synced across …" cue, so leaving means
  // re-establishing context in every tool by hand.
  tool_presence: z.record(z.object({
    last_seen_at: z.string().default(''),
    host: z.string().default(''),
    // false: that save's tool was a rendering default, not the client's
    // identity (the local server's fallback for a client it cannot place).
    identified: z.boolean().optional(),
  })).default({}),
  task_steps: z.array(TaskStepSchema).max(20).default([]),
  todo_items: z.array(TodoItemSchema).max(MAX_TODO_ITEMS).default([]),
  // Legacy, read-only: no longer written, only folded into the Done column on
  // read. Left at its historical bound because nothing appends to it.
  completed_todos: z.array(TodoItemSchema).max(100).default([]),
});

const YouProfileSchema = z.object({
  expertise_areas: z.array(z.string()).optional(),
  goals: z.array(z.string()).optional(),
  working_style: z.string().optional(),
  values: z.array(z.string()).optional(),
  communication_preferences: z.string().optional(),
});

const ContextDeltaSchema = z.object({
  // Extraction may classify a freshly-seen context as a non-coding 'topic'.
  category: z.enum(['coding', 'topic']).optional(),
  description: z.string().optional(),
  goals: z.array(z.string()).max(15).optional(),
  current_status: z.string().optional(),
  recent_decisions: z.array(DecisionEntrySchema).max(20).optional(),
  recurring_context: z.array(z.string()).max(15).optional(),
  tech_stack: z.array(z.string()).max(15).optional(),
  file_structure_summary: z.array(z.string()).max(15).optional(),
  current_task: z.string().optional(),
  open_questions: z.array(z.string()).max(15).optional(),
  // LANDMINE slot may be LLM-extracted (gated by the confidence floor + vagueness
  // guard) or written explicitly.
  landmines: z.array(LandmineEntrySchema).max(20).optional(),
  // SHIPPED slot. Structured completion events (task_completed/feature_shipped) and
  // board Done-transitions append here deterministically at confidence 1 (VERIFIED).
  // The extractor may ALSO propose completions it read in a chunk — but it never
  // writes this field directly: sanitizeLlmOutput drops any model-authored `shipped`,
  // then rebuilds it from the model's `completed_work` strings stamped at confidence
  // 0.5, so LLM-proposed completions always surface as INFERRED, never self-certified.
  shipped: z.array(ShippedEntrySchema).max(15).optional(),
  // Removal/resolution fields — processed during merge, not stored directly
  resolved_questions: z.array(z.string()).optional().default([]),
  resolved_decisions: z.array(z.string()).optional().default([]),
  resolved_landmines: z.array(z.string()).optional().default([]),
  completed_goals: z.array(z.string()).optional().default([]),
  commands: z.array(CommandEntrySchema).max(20).optional(),
  hot_paths: z.array(HotPathEntrySchema).max(40).optional(),
  entrypoints: z.array(EntrypointEntrySchema).max(20).optional(),
  surfaces: z.array(SurfaceEntrySchema).max(20).optional(),
  debugging_notes: z.array(DebuggingNoteEntrySchema).max(30).optional(),
  source_summary: z.string().optional(),
  blocking_issue: z.string().optional(),
  task_progress: z.string().optional(),
  next_action: z.string().optional(),
  task_steps: z.array(TaskStepSchema).max(20).optional(),
  you_profile: YouProfileSchema.optional(),
  // Todo/board side-channel fields — processed during merge, not stored directly.
  // add_todos accepts a bare title (lands in Backlog) or {title, phase, body} to
  // drop a card straight into a column and/or give it detail. move_todos
  // re-columns existing cards.
  add_todos: z.array(z.union([
    z.string(),
    z.object({
      title: z.string().min(1),
      phase: z.string().optional(),
      body: z.string().optional(),
      assignee: z.string().nullish(),
      // When a card that arrives straight into Done was actually finished. Only
      // honoured for Done cards, only when it parses and is not in the future
      // (see the add_todos merge). A Trail import carries the source card's.
      completed_at: z.string().optional(),
    }),
  ])).optional(),
  move_todos: z.array(z.object({
    match: z.string().min(1),
    // Either or both: a move can change the column, the person, or both at once.
    // `phase` stays optional so "give this to Sarah" does not require restating
    // which column it is already in — a caller that had to would eventually get
    // it wrong and move the card as a side effect of assigning it.
    phase: z.string().min(1).optional(),
    assignee: z.string().nullish(),
  }).refine((v) => v.phase !== undefined || v.assignee !== undefined, {
    message: 'move_todos needs a phase, an assignee, or both',
  })).optional(),
  complete_todos: z.array(z.string()).optional(),
  remove_todos: z.array(z.string()).optional(),
});

const ContextEventSchema = z.object({
  event_id: z.string().min(1),
  project_id: z.string().min(1),
  source_type: z.enum(['claude_web', 'chatgpt_web', 'cursor', 'claude_code', 'codex', 'manual', 'system']),
  source_id: z.string().min(1),
  event_kind: z.enum(['project_created', 'context_delta_applied', 'manual_override', 'project_merged', 'project_archived']),
  delta: ContextDeltaSchema.default({}),
  confidence: z.number().min(0).max(1),
  created_at: z.string().datetime(),
});

const ProjectMatchCandidateSchema = z.object({
  project_id: z.string().optional(),
  project_name: z.string().min(1),
  reason: z.string().default(''),
  score: z.number().min(0).max(1).optional(),
});

const ContextSessionSchema = z.object({
  session_id: z.string().min(1),
  owner_key: z.string().min(1),
  // Who is driving this session. Nullable because plenty of sessions predate it
  // and because a system actor genuinely has no person behind it — presence
  // falls back to naming the tool rather than inventing an identity.
  user_id: z.string().nullish(),
  tool: z.enum(TOOL_VALUES),
  // HOW the tool connects (local_stdio, hosted_oauth, hosted_api_key, rest_api),
  // apart from WHICH tool it is. Null for a session that predates the field or
  // arrived on a path that cannot say. See apps/api services/connectionIdentity.js.
  transport: z.string().nullish(),
  surface_type: z.enum(SURFACE_TYPE_VALUES),
  project_id: z.string().nullable().optional(),
  conversation_ref: z.string().default(''),
  cwd: z.string().default(''),
  host: z.string().default(''),
  tab_id: z.string().default(''),
  status: z.enum(SESSION_STATUS_VALUES).default('active'),
  routing_state: z.enum(ROUTING_STATE_VALUES).default('global_only'),
  match_confidence: z.number().min(0).max(1).default(0),
  last_confirmed_at: z.string().datetime().nullable().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  last_seen_at: z.string().datetime(),
});

const ProjectMatchResultSchema = z.object({
  match_decision: z.enum(MATCH_DECISION_VALUES),
  confidence: z.number().min(0).max(1),
  project_candidate: ProjectMatchCandidateSchema.nullable().optional(),
  should_create_project: z.boolean(),
  needs_user_confirmation: z.boolean(),
});

const ExtractionRequestSchema = z.object({
  session_id: z.string().min(1),
  tool: z.enum(TOOL_VALUES),
  project_id: z.string().min(1).optional(),
  session_context: z.object({
    conversation_ref: z.string().optional(),
    cwd: z.string().optional(),
    host: z.string().optional(),
    tab_id: z.string().optional(),
    status: z.enum(SESSION_STATUS_VALUES).optional(),
    surface_type: z.enum(SURFACE_TYPE_VALUES).optional(),
  }).optional(),
  chunk: z.object({
    role: z.string().min(1),
    text: z.string().min(1),
  }).optional(),
  chunks: z.array(z.object({
    role: z.string().min(1),
    text: z.string().min(1),
  })).optional(),
  extraction: z.object({
    match_decision: z.enum(MATCH_DECISION_VALUES),
    confidence: z.number().min(0).max(1),
    project_candidate: ProjectMatchCandidateSchema.nullable().optional(),
    delta: ContextDeltaSchema.default({}),
    should_create_project: z.boolean(),
    needs_user_confirmation: z.boolean(),
    no_material_change: z.boolean().default(false),
  }),
});

const ExtractionResponseSchema = z.object({
  match_decision: z.enum(MATCH_DECISION_VALUES),
  confidence: z.number().min(0).max(1),
  project_candidate: ProjectMatchCandidateSchema.nullable().optional(),
  delta: ContextDeltaSchema.default({}),
  should_create_project: z.boolean(),
  needs_user_confirmation: z.boolean(),
  no_material_change: z.boolean().default(false),
  routing_state: z.enum(ROUTING_STATE_VALUES).optional(),
  suppression_reason: z.string().optional(),
  graph: z.object({
    nodes: z.array(z.object({
      node_type: z.enum(GRAPH_NODE_TYPE_VALUES),
      canonical_key: z.string().min(1),
      title: z.string().min(1),
    })).default([]),
    edges: z.array(z.object({
      edge_type: z.enum(GRAPH_EDGE_TYPE_VALUES),
      from_node_id: z.string().optional(),
      to_node_id: z.string().optional(),
      summary: z.string().optional(),
    })).default([]),
  }).optional(),
});

const GraphNodeSchema = z.object({
  node_id: z.string().min(1),
  owner_key: z.string().min(1),
  project_id: z.string().nullable().optional(),
  node_type: z.enum(GRAPH_NODE_TYPE_VALUES),
  canonical_key: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().default(''),
  metadata: z.record(z.unknown()).default({}),
  confidence: z.number().min(0).max(1).default(0.5),
  source_session_id: z.string().default(''),
  source_tool: z.enum(GRAPH_SOURCE_TOOL_VALUES),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  last_seen_at: z.string().datetime(),
});

const GraphEdgeSchema = z.object({
  edge_id: z.string().min(1),
  owner_key: z.string().min(1),
  project_id: z.string().nullable().optional(),
  edge_type: z.enum(GRAPH_EDGE_TYPE_VALUES),
  from_node_id: z.string().min(1),
  to_node_id: z.string().min(1),
  summary: z.string().default(''),
  metadata: z.record(z.unknown()).default({}),
  confidence: z.number().min(0).max(1).default(0.5),
  source_session_id: z.string().default(''),
  source_tool: z.enum(GRAPH_SOURCE_TOOL_VALUES),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  last_seen_at: z.string().datetime(),
});

const GraphEvidenceSchema = z.object({
  evidence_id: z.string().min(1),
  owner_key: z.string().min(1),
  project_id: z.string().nullable().optional(),
  session_id: z.string().min(1),
  node_id: z.string().nullable().optional(),
  edge_id: z.string().nullable().optional(),
  tool: z.enum(GRAPH_SOURCE_TOOL_VALUES),
  excerpt: z.string().min(1),
  metadata: z.record(z.unknown()).default({}),
  confidence: z.number().min(0).max(1).default(0.5),
  created_at: z.string().datetime(),
});

const GraphExtractionResultSchema = z.object({
  nodes: z.array(GraphNodeSchema).default([]),
  edges: z.array(GraphEdgeSchema).default([]),
  evidence: z.array(GraphEvidenceSchema).default([]),
});

const GraphRetrievalResultSchema = z.object({
  project_id: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
  nodes: z.array(GraphNodeSchema).default([]),
  edges: z.array(GraphEdgeSchema).default([]),
  evidence: z.array(GraphEvidenceSchema).default([]),
  related_project_ids: z.array(z.string()).default([]),
  summary_lines: z.array(z.string()).default([]),
  provenance: z.array(z.object({
    kind: z.enum(['active_project', 'related_project', 'session', 'global']),
    label: z.string().min(1),
    project_id: z.string().optional(),
    node_id: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
  })).default([]),
});

const WorkspaceEntityTypeSchema = z.enum([
  'knowledge', 'decision', 'question', 'tool', 'environment', 'service', 'database', 'repo', 'capability', 'workflow', 'preference',
]);

const WorkspaceOverviewSectionSchema = z.enum(['projects', 'knowledge', 'tools', 'capabilities', 'recent']);
const WorkspaceOverviewModeSchema = z.enum(['startup', 'overview']);
const SetupSurfaceStateSchema = z.enum(['not_detected', 'detected', 'configured', 'verified', 'degraded']);
const ContextRuntimeLayerIdSchema = z.enum(['direct_context', 'passive_enrichment', 'intelligence']);
const ContextRuntimeLayerStatusSchema = z.enum(['active', 'warming', 'limited', 'idle']);

const SetupSurfaceStatusSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  mode: z.enum(['mcp', 'global_instructions', 'workspace_rules', 'fallback']),
  state: SetupSurfaceStateSchema,
  detected: z.boolean().default(false),
  configured: z.boolean().default(false),
  verified: z.boolean().default(false),
  runtime_verified: z.boolean().default(false),
  status_basis: z.enum(['config', 'runtime']).default('config'),
  path: z.string().nullable().optional(),
  backup_path: z.string().nullable().optional(),
  last_seen_at: z.string().datetime().nullable().optional(),
  runtime_version: z.string().nullable().optional(),
  last_error: z.string().nullable().optional(),
  stale: z.boolean().default(false),
  degraded_reason: z.string().nullable().optional(),
  config_has_deerdawn_mcp: z.boolean().optional(),
  config_format_valid: z.boolean().optional(),
  env_key_present: z.boolean().optional(),
  saved_key_present: z.boolean().optional(),
  // DeerDawn's instruction block sitting in this tool's file with no DeerDawn
  // server registered for the tool: which file, which tool, and how to remove it.
  // Kept until asked; see setup-status.js staleBlockOf.
  stale_block: z.object({
    path: z.string(),
    tool: z.string(),
    removable: z.boolean(),
    remove_with: z.string().nullable(),
    summary: z.string(),
  }).nullable().optional(),
  // A well-formed DeerDawn block written by ANOTHER install (the file is synced
  // between machines): kept as it is, nothing written beside it.
  foreign_block: z.object({
    path: z.string(),
    tool: z.string(),
    summary: z.string(),
    adopt_with: z.string().optional(),
  }).nullable().optional(),
});

const SetupStatusResultSchema = z.object({
  authenticated: z.boolean(),
  setup_complete: z.boolean(),
  configured_count: z.number().int().nonnegative(),
  verified_count: z.number().int().nonnegative(),
  runtime_verified_count: z.number().int().nonnegative().default(0),
  pending_sign_in_url: z.string().nullable().optional(),
  diagnostics: z.object({
    env_key_present: z.boolean().default(false),
    saved_key_present: z.boolean().default(false),
    pending_auth_state: z.enum(['none', 'pending', 'error', 'expired']).default('none'),
    api_reachable: z.enum(['unchecked', 'reachable', 'unreachable']).default('unchecked'),
    // Files holding the API key in plain text where the tool does not read one.
    plain_text_keys: z.array(z.object({
      path: z.string(),
      tool: z.string(),
      entry: z.string().nullable(),
      // false: the file mentions the key and cannot be read as JSON, so DeerDawn
      // names it and will not edit it (remove_with is null then).
      readable: z.boolean().optional(),
      remove_with: z.string().nullable(),
      summary: z.string(),
    })).optional(),
    next_action: z.string().optional(),
  }).optional(),
  execution_source: z.enum(['desktop_bridge', 'dashboard_fallback', 'local_direct', 'unavailable']).optional().default('unavailable'),
  surfaces: z.array(SetupSurfaceStatusSchema).default([]),
});

const SetupApplyResultSchema = z.object({
  surface: z.string().min(1),
  mode: z.enum(['auto', 'repair', 'restore']),
  applied: z.boolean(),
  already_configured: z.boolean().optional().default(false),
  execution_source: z.enum(['desktop_bridge', 'dashboard_fallback', 'local_direct', 'unavailable']).optional().default('unavailable'),
  status: SetupStatusResultSchema,
  changed_paths: z.array(z.string()).default([]),
  restored_from_backup: z.string().nullable().optional(),
});

const WorkspaceEntityInputSchema = z.object({
  entity_type: WorkspaceEntityTypeSchema,
  title: z.string().min(1),
  summary: z.string().optional().default(''),
  scope: z.enum(['workspace', 'project']).optional().default('workspace'),
  project_id: z.string().optional(),
  canonical_key: z.string().optional(),
  metadata: z.object({
    importance: z.enum(['low', 'normal', 'high', 'critical']).optional(),
    status: z.enum(['active', 'shipped', 'experimental', 'planned', 'deprecated', 'stale', 'resolved', 'archived']).optional(),
    pinned: z.boolean().optional(),
    curation_state: z.enum(['inferred', 'promoted', 'curated', 'stale']).optional(),
    source_kind: z.enum(['manual', 'imported', 'inferred']).optional(),
    memory_tier: z.enum(['durable', 'candidate']).optional(),
    seen_count: z.number().int().nonnegative().optional(),
    source_count: z.number().int().nonnegative().optional(),
    retrieval_hits: z.number().int().nonnegative().optional(),
    last_selected_at: z.string().datetime().optional(),
    last_matched_at: z.string().datetime().optional(),
    source_keys: z.array(z.string()).optional(),
  }).catchall(z.unknown()).optional().default({}),
});

const WorkspaceRelationInputSchema = z.object({
  from_canonical_key: z.string().min(1),
  to_canonical_key: z.string().min(1),
  relation_type: z.enum(GRAPH_EDGE_TYPE_VALUES),
  summary: z.string().optional().default(''),
});

const SUBAGENT_BRIEF_MARKER = '[DeerDawn Subagent Brief v1]';

const SubagentBriefRequestSchema = z.object({
  project_id: z.string().min(1).optional(),
  cwd: z.string().trim().min(1).max(2000).optional(),
  workspace_key: z.string().trim().min(1).max(1000).optional(),
  tool: z.string().trim().min(1).max(100).optional(),
  task: z.string().trim().min(1).max(2000),
  role: z.string().trim().min(1).max(120).optional(),
  deliverable: z.string().trim().min(1).max(1000).optional(),
  acceptance_criteria: z.array(z.string().trim().min(1).max(500)).max(8).optional().default([]),
  focus_paths: z.array(z.string().trim().min(1).max(500)).max(12).optional().default([]),
  verification: z.array(z.string().trim().min(1).max(500)).max(8).optional().default([]),
  max_tokens: z.number().int().min(120).max(600).optional().default(250),
});

const SubagentBriefSourceSchema = z.object({
  kind: z.enum(['project', 'decision', 'constraint', 'landmine', 'path', 'debugging_note', 'entity', 'command', 'explicit']),
  text: z.string().min(1),
  path: z.string().optional(),
  source_id: z.string().optional(),
  score: z.number().optional(),
  importance: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  verified_at: z.string().optional(),
}).catchall(z.unknown());

const SubagentBriefResultSchema = z.object({
  version: z.literal(1),
  marker: z.literal(SUBAGENT_BRIEF_MARKER),
  text: z.string().min(1),
  project_id: z.string().min(1),
  project_name: z.string().min(1),
  context_updated_at: z.string().nullable().optional(),
  generated_at: z.string().min(1),
  estimated_tokens: z.number().int().positive(),
  max_tokens: z.number().int().min(120).max(600),
  omitted_count: z.number().int().nonnegative(),
  sources: z.array(SubagentBriefSourceSchema).default([]),
});

const ContextRuntimeLayerSchema = z.object({
  id: ContextRuntimeLayerIdSchema,
  title: z.string().min(1),
  summary: z.string().min(1),
  status: ContextRuntimeLayerStatusSchema.default('active'),
  input_count: z.number().int().nonnegative().default(0),
  selected_count: z.number().int().nonnegative().default(0),
  highlights: z.array(z.string().min(1)).default([]),
});

const PassiveEnrichmentItemSchema = z.object({
  source: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  source_kind: z.enum(['imported', 'inferred', 'global', 'ambient']).default('imported'),
  confidence: z.number().min(0).max(1).default(0.5),
  freshness: z.enum(['live', 'recent', 'stale']).default('recent'),
  selected: z.boolean().default(false),
  workspace_link_reason: z.string().min(1),
});

const ContextSelectionExplanationSchema = z.object({
  kind: z.enum(['project_context', 'entity', 'enrichment']),
  label: z.string().min(1),
  reason: z.string().min(1),
  score: z.number().min(0).max(2).default(0.5),
  selected: z.boolean().default(true),
  source: z.string().min(1),
});

const CurrentUnderstandingSchema = z.object({
  workspace_label: z.string().min(1),
  active_project_id: z.string().nullable().optional(),
  active_project_name: z.string().nullable().optional(),
  current_task: z.string().default(''),
  current_status: z.string().default(''),
  recent_decisions: z.array(z.string()).default([]),
  open_questions: z.array(z.string()).default([]),
  hot_paths: z.array(z.string()).default([]),
  supporting_evidence: z.array(z.string()).default([]),
  related_entities: z.array(z.string()).default([]),
  relevant_enrichments: z.array(PassiveEnrichmentItemSchema).default([]),
  confidence_summary: z.string().default(''),
});

const WorkspaceOverviewResultSchema = z.object({
  mode: WorkspaceOverviewModeSchema.default('overview'),
  summary: z.object({
    now: z.array(z.string()).default([]),
    recent: z.array(z.string()).default([]),
  }).default({ now: [], recent: [] }),
  layers: z.object({
    direct_context: ContextRuntimeLayerSchema,
    passive_enrichment: ContextRuntimeLayerSchema,
    intelligence: ContextRuntimeLayerSchema,
  }).default({
    direct_context: {
      id: 'direct_context',
      title: 'Direct context',
      summary: 'Current work from MCP, active projects, tasks, and recent AI activity.',
      status: 'active',
      input_count: 0,
      selected_count: 0,
      highlights: [],
    },
    passive_enrichment: {
      id: 'passive_enrichment',
      title: 'Passive enrichment',
      summary: 'Imported notes, docs, and ambient work signals strengthening current context.',
      status: 'idle',
      input_count: 0,
      selected_count: 0,
      highlights: [],
    },
    intelligence: {
      id: 'intelligence',
      title: 'Intelligence layer',
      summary: 'Ranking, deduplication, compression, and packaging deciding what survives.',
      status: 'active',
      input_count: 0,
      selected_count: 0,
      highlights: [],
    },
  }),
  projects: z.array(z.object({
    project_id: z.string().min(1),
    project_name: z.string().min(1),
    updated_at: z.string().datetime().optional().nullable(),
    context: z.record(z.unknown()).default({}),
  })).default([]),
  knowledge: z.array(GraphNodeSchema).default([]),
  tools: z.array(GraphNodeSchema).default([]),
  capabilities: z.array(GraphNodeSchema).default([]),
  passive_enrichments: z.array(PassiveEnrichmentItemSchema).default([]),
  current_understanding: CurrentUnderstandingSchema.default({
    workspace_label: 'Current workspace',
    active_project_id: null,
    active_project_name: null,
    current_task: '',
    current_status: '',
    recent_decisions: [],
    open_questions: [],
    hot_paths: [],
    supporting_evidence: [],
    related_entities: [],
    relevant_enrichments: [],
    confidence_summary: '',
  }),
  selection_explanations: z.array(ContextSelectionExplanationSchema).default([]),
  provenance: z.array(z.object({
    kind: z.enum(['active_project', 'related_project', 'session', 'global']),
    label: z.string().min(1),
    project_id: z.string().optional(),
    node_id: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
  })).default([]),
  // Compounding-intelligence read side: projects this workspace works alongside,
  // ranked by accumulated co-occurrence. Strengthened in renderInjection; surfaced
  // here so the learned affinity delivers value instead of being write-only.
  related_projects: z.array(z.object({
    project_id: z.string().min(1),
    project_name: z.string().min(1),
    co_occurrence_count: z.number().default(0),
  })).default([]),
  // Team / shared-workspace surface: who collectively built the active project's
  // context. Visible interdependence is the social switching cost.
  contributors: z.array(z.object({
    user_id: z.string().min(1),
    contributions: z.number().default(0),
    last_at: z.string().nullable().optional(),
  })).default([]),
});

const NextBestContextSuggestionSchema = z.object({
  // 'board_card' is unclaimed work from the task board. It ranks above the
  // retrieval kinds because a card nobody holds is a more concrete answer to
  // "what should I do next" than a document to go read.
  kind: z.enum(['entity', 'query', 'open_question', 'board_card']),
  label: z.string().min(1),
  reason: z.string().min(1),
  score: z.number().min(0).max(1),
  node_id: z.string().optional(),
  canonical_key: z.string().optional(),
  query: z.string().optional(),
});

const NextBestContextResultSchema = z.object({
  summary: z.string().min(1),
  suggestions: z.array(NextBestContextSuggestionSchema).default([]),
  provenance: z.array(z.object({
    kind: z.enum(['active_project', 'related_project', 'session', 'global']),
    label: z.string().min(1),
    project_id: z.string().optional(),
    node_id: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
  })).default([]),
});

const GlobalContextSchema = z.object({
  user_profile:            z.string().default(''),
  preferences:             z.array(z.string()).default([]),
  recurring_instructions:  z.array(z.string()).default([]),
  global_stack:            z.array(z.string()).default([]),
  // Structured personal profile — populated from you_profile extraction
  expertise_areas:         z.array(z.string()).default([]),
  goals:                   z.array(z.string()).default([]),
  working_style:           z.string().default(''),
  values:                  z.array(z.string()).default([]),
  communication_preferences: z.string().default(''),
  updated_at:              z.string().datetime().optional(),
});

const ToolPreferenceSchema = z.object({
  enabled: z.boolean().default(true),
  verbosity: z.enum(VERBOSITY_VALUES).default('standard'),
});

const InjectionPreferenceSchema = z.object({
  paused: z.boolean().default(false),
  tools: z.object({
    claude_web:  ToolPreferenceSchema.default({ enabled: true, verbosity: 'light' }),
    chatgpt_web: ToolPreferenceSchema.default({ enabled: true, verbosity: 'light' }),
    cursor:      ToolPreferenceSchema.default({ enabled: true, verbosity: 'light' }),
    claude_code: ToolPreferenceSchema.default({ enabled: true, verbosity: 'light' }),
    codex:       ToolPreferenceSchema.default({ enabled: true, verbosity: 'light' }),
  }).default({}),
});

const InjectionPayloadSchema = z.object({
  tool: z.enum(TOOL_VALUES),
  format: z.enum(['conversational', 'code']),
  verbosity: z.enum(VERBOSITY_VALUES),
  body: z.string().min(1),
  provenance: z.array(z.object({
    kind: z.enum(['active_project', 'related_project', 'session', 'global']),
    label: z.string().min(1),
    project_id: z.string().optional(),
    node_id: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
  })).optional(),
});

function isoNow() {
  return new Date().toISOString();
}

function timeAgo(isoString) {
  if (!isoString) return '';
  const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)}d ago`;
  return `${Math.floor(seconds / (86400 * 7))}w ago`;
}

function trimLines(lines) {
  return lines.filter(Boolean).map((line) => String(line).trim()).filter(Boolean);
}

// ─── Injected-text fencing (C3) ──────────────────────────────────────────────
// Conservative defence at the context → agent boundary: formatters interpolate
// user/LLM-derived free text directly into a brief the receiving agent reads as
// trusted instructions, with no delimiter between "data" and "instructions".
// This does NOT restructure the brief (same labels/order) — it neutralizes two
// concrete injection vectors within a field's own text:
//   1. An embedded raw newline that would let a single field value spawn a
//      brand-new top-level "line" in the rendered brief (indistinguishable from
//      a fresh section, role turn, or heading the tool itself authored).
//   2. A value whose (post-collapse) text starts with a markdown heading (#),
//      a code fence (```), or a role/preamble phrase ("system:", "assistant:",
//      "ignore previous instructions", "disregard the above") that could read
//      as a directive rather than data when it lands at the start of a line.
// Zero-width space (U+200B) is invisible — it does not change what a human (or
// a render) sees, so the brief's visible shape is unchanged — but it breaks a
// literal "line starts with X" match, which is the property both markdown
// parsers and naive prompt-injection pattern-matching rely on.
const ZERO_WIDTH_GUARD = '​';
const INJECTION_HEADING_RE = /^\s*(#{1,6}(?:\s|$)|```)/;
const INJECTION_PREAMBLE_RE = /^\s*(system|assistant|user)\s*:|^\s*ignore\s+(all\s+)?previous\s+instructions?\b|^\s*disregard\s+(the\s+)?above\b/i;

function neutralizeInjectedText(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  // Collapse embedded newlines to a single space so a value can never spawn a
  // fresh top-level line in the rendered brief.
  let text = value.replace(/\r\n|\r|\n/g, ' ').replace(/[ \t]{2,}/g, ' ');
  if (INJECTION_HEADING_RE.test(text) || INJECTION_PREAMBLE_RE.test(text)) {
    text = ZERO_WIDTH_GUARD + text;
  }
  return text;
}

const CLIP_ELLIPSIS = '...';
const CLIP_BOUNDARY = /[\s/_.,;:-]/;

function clipText(value, maxChars) {
  const text = String(value || '').trim();
  if (!maxChars || text.length <= maxChars) return neutralizeInjectedText(text);
  const budget = Math.max(0, maxChars - CLIP_ELLIPSIS.length);
  if (budget <= 0) return CLIP_ELLIPSIS;
  // Code-point aware slicing (M12): Array.from splits `text` into full UTF-16
  // code points (correctly pairing surrogate halves — e.g. emoji — as a single
  // element), so slicing the first `budget` elements can never emit a lone/
  // broken surrogate the way `text.slice(0, budget)` (UTF-16 code-unit
  // slicing) could when the cut landed inside a pair.
  const slice = Array.from(text).slice(0, budget).join('');
  // Break on the last word boundary inside the budget so we never cut a word in
  // half (e.g. "credential m..."). Fall back to a hard cut only when the very
  // first token is itself longer than the budget — then there is no boundary.
  let boundary = -1;
  for (let index = slice.length - 1; index >= 0; index -= 1) {
    if (CLIP_BOUNDARY.test(slice[index])) {
      boundary = index;
      break;
    }
  }
  const clipped = (boundary >= 0 ? slice.slice(0, boundary) : slice)
    .replace(/[\s/_.,;:-]+$/, '')
    .trim();
  return neutralizeInjectedText(`${clipped || slice.trim()}${CLIP_ELLIPSIS}`);
}

// Per-field character budgets for prose fields, scaled by verbosity. Inline
// 'light' injections stay tight to save tokens; 'standard' (the verbosity used
// for the persisted .deerdawn-context.md / .cursorrules files) fits a full
// sentence so generated files read as complete thoughts, not chopped fragments.
function proseBudget(verbosity, base) {
  const scale = verbosity === 'light' ? 0.72 : verbosity === 'detailed' ? 1.8 : 1.4;
  return Math.round(base * scale);
}

function approximateTokenCount(value) {
  return Math.ceil(String(value || '').length / 4);
}

function fitLinesToBudget(lines, maxTokens) {
  const result = [];
  let used = 0;
  for (const line of trimLines(lines)) {
    const cost = approximateTokenCount(line) + 1;
    if (result.length > 0 && used + cost > maxTokens) break;
    result.push(line);
    used += cost;
  }
  return result;
}

function defineMeta(payload, meta) {
  Object.defineProperty(payload, '_meta', {
    value: meta,
    enumerable: false,
    configurable: true,
  });
  return payload;
}

// ─── The cross-project line ───────────────────────────────────────────────────
//
// One line, in the brief the reader already opens, naming what another project
// of theirs has already settled about the thing they are about to do. This is
// the paid unit; see apps/api/src/services/crossProjectService.js for how the
// entries are chosen and why relevance — not recency — picks them.
//
// Two copy rules, both load-bearing:
//   1. Name the OTHER project. "Related elsewhere" without a project name is a
//      claim the reader cannot check, and an unverifiable line in a brief is
//      worse than no line.
//   2. The locked form states the reader's own numbers and never silently
//      omits. A free reader who sees nothing cannot tell there was anything to
//      see, which puts Pro back out of sight — the exact failure the locked
//      Portfolio counts exist to prevent.
function buildRelatedProjectsLine(related, verbosity = 'standard') {
  if (!related || !related.count) return null;

  if (related.locked) {
    const things = related.count === 1 ? '1 related decision' : `${related.count} related decisions`;
    const where = related.project_count === 1 ? 'another project' : `${related.project_count} other projects`;
    return `Related elsewhere: ${things} in ${where} — Pro shows them.`;
  }

  const entries = (related.entries || []).filter((entry) => entry && entry.headline);
  if (!entries.length) return null;

  const budget = proseBudget(verbosity, verbosity === 'light' ? 52 : 76);
  const rendered = entries.map((entry) => {
    const name = neutralizeInjectedText(entry.project_name || 'another project');
    const headline = clipText(entry.headline, budget);
    // The anchor is what makes the claim checkable in the other repo. Worth its
    // characters on anything but the tight-token path.
    const anchor = verbosity !== 'light' && entry.anchor ? ` (${neutralizeInjectedText(entry.anchor)})` : '';
    return `${name} — ${headline}${anchor}`;
  });

  return `Related elsewhere: ${rendered.join(' | ')}`;
}

function buildSection(key, line, priority) {
  return line ? { key, line, priority } : null;
}

function chooseSections(sections, maxTokens) {
  const chosen = [];
  const dropped = [];
  let used = 0;
  for (const section of sections.filter(Boolean).sort((a, b) => a.priority - b.priority)) {
    const cost = approximateTokenCount(section.line) + 1;
    if (chosen.length > 0 && used + cost > maxTokens) {
      dropped.push(section.key);
      continue;
    }
    chosen.push(section);
    used += cost;
  }
  return {
    lines: chosen.map((section) => section.line),
    chosenSections: chosen.map((section) => section.key),
    droppedSections: dropped,
    approximateTokens: used,
  };
}

function scoreByRecency(items = [], getDate) {
  return [...items].sort((left, right) => {
    const leftAt = new Date(getDate(left) || 0).getTime();
    const rightAt = new Date(getDate(right) || 0).getTime();
    return rightAt - leftAt;
  });
}

const IMPORTANCE_RANK = { critical: 0, high: 1, normal: 2, low: 3 };

// The one-line form of a decision, for surfaces that QUOTE it rather than
// display it — chiefly the cross-project block, where a decision from another
// project has to justify every token it takes from the brief it lands in.
//
// Purely deterministic on purpose. The obvious alternative is to summarise at
// read time, but read time here is session start: an LLM call on the product's
// most important call, paid on every session, to shorten text that was already
// written once. Extraction fills `headline` going forward; this covers
// everything already stored, and stays the fallback when it is missing.
//
// The rule is "first sentence, then hard cap". Stored summaries lead with the
// claim and follow with the evidence, so the first sentence is the claim far
// more often than any cleverer heuristic would be — and when it isn't, a flat
// truncation is at least honestly a truncation.
const HEADLINE_MAX = 160;

function decisionHeadline(decision) {
  if (!decision) return '';
  const explicit = String(decision.headline || '').trim();
  if (explicit) return explicit.length > HEADLINE_MAX ? `${explicit.slice(0, HEADLINE_MAX - 1)}…` : explicit;

  const summary = String(decision.summary || '').replace(/\s+/g, ' ').trim();
  if (!summary) return '';

  // Sentence end = . ! ? followed by whitespace. Guard the common abbreviation
  // shapes that would otherwise cut mid-claim: a decimal ("0.85 Sharpe"), an
  // initial, and a file extension ("next.config.ts").
  const match = summary.match(/^(.{20,}?[.!?])(\s|$)/);
  let head = match ? match[1] : summary;
  if (match && /(\s\w|\d)\.$/.test(head) && summary.length > head.length) head = summary;

  if (head.length <= HEADLINE_MAX) return head;
  // Cut on a word boundary rather than mid-token.
  const cut = head.slice(0, HEADLINE_MAX - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > HEADLINE_MAX * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:\s]+$/, '')}…`;
}

// How long a decision counts as "recent" for ordering purposes. Inside the
// window the brief reads as a timeline; outside it, importance takes over again.
const DECISION_RECENCY_WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

// The shared ranker for every surface that shows "recent decisions".
//
// It used to rank importance-first with no decay: every `high` above every
// `normal`, forever. That would be defensible if `high` were rare, but the
// structured-event floors stamped `high` on everything they wrote — every
// shipped feature, every answered question, every hourly run-log a scheduled
// agent filed. So the brief led with whichever `high` entries happened to
// exist, a month-old run-log outranked the decision made this morning, and the
// slots never turned over. A brief that confidently describes last month is
// worse than a short one.
//
// The order now:
//   1. `critical`, newest first. Critical is the one level that is a standing
//      claim ("never do X") rather than a news item, so it does not decay.
//   2. Everything genuinely dated inside the last 14 days, newest DAY first.
//      `high` is only a tie-break between entries from the same day — it can
//      reorder a day's entries, it cannot pull last week above today. Day, not
//      millisecond, because a millisecond tie never happens and a tie-break that
//      never fires is not a tie-break.
//   3. Everything else — older than the window, or carrying a stamped-in date —
//      in the old order (importance, genuine date before inferred, recency).
//      For entries that are all stale, importance is the better signal left.
//
// A date_inferred entry never enters the window: its decided_at is the moment
// it was EXTRACTED, which is always "just now", so admitting it would float an
// undated claim to the top of the brief as if it were the freshest. It keeps
// its old place below genuinely dated entries of the same importance.
//
// `options.now` exists for tests; every caller takes the clock.
function selectRecentDecisions(decisions = [], count, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const windowStart = now - DECISION_RECENCY_WINDOW_DAYS * DAY_MS;
  const timeOf = (item) => {
    const parsed = new Date(item.decided_at || 0).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const rankOf = (item) => IMPORTANCE_RANK[item.importance || 'normal'] ?? 2;
  // 0 = critical, 1 = inside the window, 2 = the rest.
  const bandOf = (item) => {
    if (item.importance === 'critical') return 0;
    if (!item.date_inferred && timeOf(item) >= windowStart) return 1;
    return 2;
  };

  // Resolved decisions are excluded from active context loads.
  const ranked = [...decisions]
    .filter((item) => item && item.summary && !item.resolved)
    .sort((a, b) => {
      const bandA = bandOf(a);
      const bandB = bandOf(b);
      if (bandA !== bandB) return bandA - bandB;

      if (bandA === 1) {
        const dayA = Math.floor(timeOf(a) / DAY_MS);
        const dayB = Math.floor(timeOf(b) / DAY_MS);
        if (dayA !== dayB) return dayB - dayA;
        const highA = a.importance === 'high' ? 0 : 1;
        const highB = b.importance === 'high' ? 0 : 1;
        if (highA !== highB) return highA - highB;
        return timeOf(b) - timeOf(a);
      }

      if (bandA === 2) {
        const rankA = rankOf(a);
        const rankB = rankOf(b);
        if (rankA !== rankB) return rankA - rankB;
      }
      // A genuinely-dated decision outranks one whose date was inferred (stamped
      // because the source omitted it) — otherwise an undated claim stamped "now"
      // would float to the top of the brief as if it were the freshest.
      const inferredA = a.date_inferred ? 1 : 0;
      const inferredB = b.date_inferred ? 1 : 0;
      if (inferredA !== inferredB) return inferredA - inferredB;
      return timeOf(b) - timeOf(a);
    });

  const selected = ranked.slice(0, count);
  // "RECENT DECISIONS" WITH NOTHING RECENT IN IT.
  //
  // Band 0 never decays, which is the point of `critical` — but with three of
  // them the brief's three decision slots were spoken for permanently, and a
  // project could make a decision every day without the section ever changing.
  // The criticals stay; the LAST slot is handed back to the newest decision
  // inside the recency window, so the section can always answer "and lately?".
  // Only when there is a slot to trade and nothing recent already holds one.
  if (count > 1 && selected.length === count && !selected.some((item) => bandOf(item) === 1)) {
    // Band 1 is sorted newest-day-first, so the first one is the newest.
    const newestInWindow = ranked.find((item) => bandOf(item) === 1);
    if (newestInWindow) selected[count - 1] = newestInWindow;
  }
  return selected;
}

// ─── What the brief shows of the decision log (journey r4) ───────────────────
//
// The owner's decision: the NEWEST THREE decisions, plus anything pinned. The
// brief used to print ONE, chosen by importance (selectRecentDecisions), so on
// a project that decided something every day the newest was routinely absent
// and a months-old "important" one stood in for "Recent decisions". Older
// decisions stay searchable (recall with action "search"); the 20-decision cap
// and its eviction are unchanged.
//
// "Newest" is decided_at, latest first, a later entry in the log winning a tie
// (the log is appended to). "Pinned" is what the dashboard's Pin sets on a
// decision — importance 'high' — and above it, 'critical'; a stored `pinned`
// flag counts too. Pinned decisions beyond the newest three follow them,
// newest first. Resolved decisions are never shown, as before.
const BRIEF_NEWEST_DECISIONS = 3;

function isPinnedDecision(item) {
  return Boolean(item) && (item.pinned === true || item.importance === 'high' || item.importance === 'critical');
}

function selectBriefDecisions(decisions = []) {
  const open = (Array.isArray(decisions) ? decisions : [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item && item.summary && !item.resolved);
  const timeOf = ({ item }) => {
    const parsed = Date.parse(item.decided_at || '');
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const newestFirst = [...open].sort((a, b) => (timeOf(b) - timeOf(a)) || (b.index - a.index));
  const newest = newestFirst.slice(0, BRIEF_NEWEST_DECISIONS);
  const shown = new Set(newest.map(({ index }) => index));
  const pinned = newestFirst.filter(({ item, index }) => !shown.has(index) && isPinnedDecision(item));
  return [...newest, ...pinned].map(({ item }) => item);
}

// One decision as the brief's "Recent decisions" line prints it: the cut and
// the tags the single-decision line always used (80 on its own, 64 beside its
// reasoning). The cut matters beyond looks: the Knowledge web line cuts a
// decision the same way, and a resolve accepts the cut the brief showed.
function briefDecisionText(item, verbosity) {
  const tag = (item.importance === 'critical' ? ' ⚠ critical' : (item.importance === 'high' ? ' ★ important' : ''))
    + (item.verified_at ? ' ✓ verified' : '');
  return item.reasoning
    ? `${clipText(item.summary, proseBudget(verbosity, 64))}${tag} (because: ${clipText(item.reasoning, proseBudget(verbosity, 64))})`
    : `${clipText(item.summary, proseBudget(verbosity, 80))}${tag}`;
}

// The "Recent decisions" section for the conversational and code briefs:
// { line, critical, extraTokens }. `extraTokens` is what the decisions after
// the first cost: the formatters widen their budget by it, so showing three
// decisions does not push another section out of a brief that used to hold one.
// Light — the caller's tight-token mode — keeps the single line it always had
// (the decision names what the brief shows; light is the mode a caller picks to
// get less of it).
function buildBriefDecisionsSection(context, verbosity, legacyCount) {
  if (verbosity === 'light') {
    const first = selectRecentDecisions(context.recent_decisions || [], legacyCount)[0];
    if (!first) return { line: null, critical: false, extraTokens: 0 };
    const tag = (first.importance === 'critical' ? ' ⚠ critical' : (first.importance === 'high' ? ' ★ important' : ''))
      + (first.verified_at ? ' ✓ verified' : '');
    const line = first.reasoning
      ? `Recent decisions: ${clipText(first.summary, proseBudget(verbosity, 64))}${tag} (because: ${clipText(first.reasoning, proseBudget(verbosity, 64))})`
      : `Recent decisions: ${clipText(first.summary, proseBudget(verbosity, 80))}${tag}`;
    return { line, critical: first.importance === 'critical', extraTokens: 0 };
  }
  const shown = selectBriefDecisions(context.recent_decisions || []);
  if (!shown.length) return { line: null, critical: false, extraTokens: 0 };
  const texts = shown.map((item) => briefDecisionText(item, verbosity));
  const rest = texts.slice(1).map((text) => ` | ${text}`).join('');
  return {
    line: `Recent decisions: ${texts.join(' | ')}`,
    critical: shown.some((item) => item.importance === 'critical'),
    extraTokens: rest ? approximateTokenCount(rest) : 0,
  };
}

function hasCriticalDecision(decisions = []) {
  return decisions.some((d) => d?.importance === 'critical');
}

// Per-item trust band — derived, never stored. One vocabulary across every brief
// surface (data, MCP, dashboard, marketing):
//   high       — verified_at set OR confidence >= 0.75
//   inferred   — 0.4 <= confidence < 0.75 OR date_inferred OR source kind 'inferred'
//   unverified — otherwise (confidence < 0.4 or absent and nothing else to go on)
function deriveItemTrust(item) {
  if (!item || typeof item !== 'object') return 'unverified';
  const confidence = typeof item.confidence === 'number' ? item.confidence : null;
  if (item.verified_at || (confidence !== null && confidence >= 0.75)) return 'high';
  const sourceKind = item.source_kind || item.source;
  if (
    (confidence !== null && confidence >= 0.4 && confidence < 0.75)
    || item.date_inferred
    || sourceKind === 'inferred'
  ) {
    return 'inferred';
  }
  return 'unverified';
}

// A SHIPPED LINE THAT CAME FROM A DONE CARD FOLLOWS THE CARD (journey r6).
//
// `before` and `after` are the board's cards (Done-column cards from the legacy
// completed_todos list included, as done) on either side of a write. For each
// shipped line that names a card (card_id):
//   - the card is on the board and Done: the line takes the card's title (rename);
//   - the card is on the board and NOT Done: the line goes (moved back out);
//   - the card is gone: the line goes (deleted), unless it was pushed off by the
//     Done cap in this very write (`evictedDoneIds`), which is history and stays,
//     or was not on the board before either (an old board, an import): not this
//     write's doing, so untouched.
// Lines with no card_id are never touched. Pure; returns { list, changed }.
function followBoardCardsInShipped(shipped, { before = [], after = [], evictedDoneIds = new Set() } = {}) {
  const list = Array.isArray(shipped) ? shipped : [];
  const prevIds = new Set((before || []).map((card) => card && card.id).filter(Boolean));
  const nextById = new Map((after || []).filter((card) => card && card.id).map((card) => [card.id, card]));
  let changed = false;
  const out = [];
  for (const entry of list) {
    const id = entry && typeof entry === 'object' ? entry.card_id : null;
    if (!id) { out.push(entry); continue; }
    const card = nextById.get(id);
    if (!card) {
      if (prevIds.has(id) && !evictedDoneIds.has(id)) { changed = true; continue; }
      out.push(entry);
      continue;
    }
    if (normalizeBoardPhase(card.phase) !== DONE_BOARD_PHASE) { changed = true; continue; }
    const title = String(card.title || '').trim();
    if (title && title !== entry.summary) {
      changed = true;
      out.push({ ...entry, summary: title });
      continue;
    }
    out.push(entry);
  }
  return { list: out, changed };
}

// Single source of truth for the 4-slot brief. Pure: returns
// { shipped[], decided[], open[], landmine[] } from the current context, each item
// carrying { text, trust, source_tool, date, importance?, paths? }. Omit-not-
// fabricate: a slot with no items is an empty array (callers omit empty slots).
// SHIPPED reads the deterministic shipped[] accumulator (+ current_status as an
// optional header line); DECIDED reads unresolved recent_decisions; OPEN reads
// open_questions; LANDMINE reads landmines[].
function buildBriefSpine(context = {}, global = null, options = {}) {
  const ctx = context || {};

  const shipped = (ctx.shipped || [])
    .filter((item) => item && item.summary)
    .slice()
    .sort((a, b) => (Date.parse(b.shipped_at) || 0) - (Date.parse(a.shipped_at) || 0))
    .map((item) => ({
      text: String(item.summary),
      trust: deriveItemTrust(item),
      source_tool: item.source_tool || null,
      date: item.shipped_at || null,
      commit_ref: item.commit_ref || null,
      pinned: Boolean(item.pinned),
      // A Done card, not a checked claim: a surface labels it "Shipped".
      ...(item.card_id ? { from_card: true } : {}),
    }));

  const decided = selectRecentDecisions(ctx.recent_decisions || [], (ctx.recent_decisions || []).length)
    .map((item) => ({
      text: String(item.summary),
      trust: deriveItemTrust(item),
      source_tool: item.source_tool || null,
      date: item.decided_at || null,
      importance: item.importance || 'normal',
      reasoning: item.reasoning || null,
    }));

  const open = (ctx.open_questions || [])
    .filter(Boolean)
    .map((q) => ({
      text: String(q),
      // Open questions are bare strings with no provenance to derive from.
      trust: 'unverified',
      source_tool: null,
      date: null,
    }));

  const landmine = normalizeLandmines(ctx.landmines || [])
    .slice()
    .sort((a, b) => entryPriority(b) - entryPriority(a) || (Date.parse(b.added_at) || 0) - (Date.parse(a.added_at) || 0))
    .map((item) => ({
      text: String(item.summary),
      trust: deriveItemTrust(item),
      source_tool: item.source_tool || null,
      date: item.added_at || null,
      importance: item.importance || 'high',
      paths: item.paths && item.paths.length ? item.paths : undefined,
      pinned: Boolean(item.pinned),
    }));

  const spine = { shipped, decided, open, landmine };
  // current_status is the SHIPPED slot header (the most recent completion state),
  // surfaced separately so a caller can show it even when shipped[] is empty.
  if (ctx.current_status) {
    spine.shipped_header = {
      text: String(ctx.current_status),
      verified: Boolean(ctx.status_verified_at),
    };
  }
  return spine;
}

function selectConstraints(values = [], count) {
  return [...values].filter(Boolean).slice(-count).reverse();
}

function selectRelevantFiles(files = [], count, cwd = '') {
  const terms = String(cwd || '')
    .toLowerCase()
    .split(/[\\/]/g)
    .filter((term) => term.length >= 2);

  return [...files]
    .map((file, index) => {
      const normalized = String(file || '').trim();
      const lower = normalized.toLowerCase();
      const relevance = terms.reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0);
      return { file: normalized, relevance, index };
    })
    .filter((entry) => entry.file)
    .sort((left, right) => {
      if (right.relevance !== left.relevance) return right.relevance - left.relevance;
      return left.index - right.index;
    })
    .slice(0, count)
    .map((entry) => entry.file);
}

function buildYouSection(global, verbosity) {
  if (!global) return '';
  const lines = [];
  // working_style or user_profile as the primary "who are you" line
  if (global.working_style) lines.push(`You: ${neutralizeInjectedText(global.working_style)}`);
  else if (global.user_profile) lines.push(`You: ${neutralizeInjectedText(global.user_profile)}`);
  if (verbosity !== 'light') {
    if ((global.expertise_areas || []).length > 0) lines.push(`Expertise: ${global.expertise_areas.map(neutralizeInjectedText).join(', ')}`);
    if ((global.values || []).length > 0) lines.push(`Values: ${global.values.map(neutralizeInjectedText).join(', ')}`);
    if ((global.goals || []).length > 0) lines.push(`Goals: ${global.goals.slice(0, 3).map(neutralizeInjectedText).join(' | ')}`);
    if (global.communication_preferences) lines.push(`Communication: ${neutralizeInjectedText(global.communication_preferences)}`);
  }
  return lines.join('\n');
}

function buildBrowserGlobalLine(global, verbosity) {
  if (!global) return '';
  const prefs = (global.preferences || []).slice(0, verbosity === 'light' ? 1 : 3);
  const instructions = (global.recurring_instructions || []).slice(0, verbosity === 'light' ? 1 : 2);
  const youSection = buildYouSection(global, verbosity);
  return trimLines([
    youSection,
    prefs.length > 0 && `Prefs: ${prefs.map(neutralizeInjectedText).join(' | ')}`,
    instructions.length > 0 && `Always: ${instructions.map(neutralizeInjectedText).join(' | ')}`,
  ]).join('\n');
}

function buildCodeGlobalLine(global, verbosity) {
  if (!global) return '';
  const prefs = (global.preferences || []).slice(0, verbosity === 'light' ? 1 : 3);
  const instructions = (global.recurring_instructions || []).slice(0, verbosity === 'light' ? 1 : 2);
  const stack = (global.global_stack || []).slice(0, verbosity === 'light' ? 2 : 4);
  const youSection = buildYouSection(global, verbosity);
  return trimLines([
    youSection,
    prefs.length > 0 && `Prefs: ${prefs.map(neutralizeInjectedText).join(' | ')}`,
    instructions.length > 0 && `Always: ${instructions.map(neutralizeInjectedText).join(' | ')}`,
    stack.length > 0 && `Stack: ${stack.map(neutralizeInjectedText).join(', ')}`,
  ]).join('\n');
}

function uniqueStrings(values = []) {
  return Array.from(new Set((values || []).map((value) => String(value).trim()).filter(Boolean)));
}

// ─── Secret redaction (H4) ───────────────────────────────────────────────────
// shared-context is the write path for hot_paths/entrypoints/surfaces/
// debugging_notes/landmines/shipped — free-text fields (label/path/purpose/
// summary) that flow, unsanitized until now, straight into the brief injected
// into another agent's prompt. This is a third faithful copy of the same
// patterns as packages/mcp-server/src/redact.ts and
// apps/api/src/utils/secretRedaction.js — kept behaviourally identical to both.
// shared-context is a dependency-light CommonJS package consumed by apps/api,
// apps/dashboard, apps/marketing, and packages/mcp-server, so it must not
// import from apps/api (module boundary) — hence the local copy rather than a
// shared import.
const SC_REDACTED = '[REDACTED]';

// Left-anchored, and the identifier-shaped prefixes need a digit inside the
// run: `sk-` with no left boundary matched inside "task-", "risk-", "flask-",
// so kebab ids and every canonical key built from a "Task ..." title were
// masked at persist time (see apps/api/src/utils/secretRedaction.js, which
// carries the reasoning and the corpus test).
// 64, not 256 (round 16): a prefix repeated end to end ("sk-sk-sk-…") is one
// candidate per three characters, each paying the whole window. 64 characters
// of a real key without a digit is (52/62)^64 ≈ 1e-5.
const SC_DIGIT_WITHIN = (cls) => `(?=${cls}{0,64}[0-9])`;
const SC_TOKEN_PATTERNS = [
  // DeerDawn's own credentials, the exact minted shapes (API key / OAuth access
  // token dd_<8 hex>_<64 hex>; refresh token ddr_<64 hex>). PARITY with
  // apps/api/src/utils/secretRedaction.js DEERDAWN_CREDENTIAL_PATTERNS.
  /\bddr?_[0-9a-f]{8}_[0-9a-f]{64}\b/g,
  /\bddr_[0-9a-f]{64}\b/g,
  // Anthropic: the version tag (api03-, admin01-, oat01-) is specific enough
  // to need no left boundary, so a key glued to the text before it still goes.
  /sk-ant-[a-z]{2,12}[0-9]{2}-[A-Za-z0-9_-]{8,}/g,
  new RegExp(String.raw`(?<![A-Za-z0-9_])sk-${SC_DIGIT_WITHIN('[A-Za-z0-9_-]')}[A-Za-z0-9_-]{20,}`, 'g'),
  new RegExp(String.raw`(?<![A-Za-z0-9])rk_(?:live|test)_${SC_DIGIT_WITHIN('[A-Za-z0-9]')}[A-Za-z0-9]{8,}`, 'g'),
  new RegExp(String.raw`(?<![A-Za-z0-9])(?:pk|sk)_(?:live|test)_${SC_DIGIT_WITHIN('[A-Za-z0-9]')}[A-Za-z0-9]{8,}`, 'g'),
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}/g,
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g,
  new RegExp(String.raw`(?<![A-Za-z0-9])xox[baprs]-${SC_DIGIT_WITHIN('[A-Za-z0-9-]')}[A-Za-z0-9-]{10,}`, 'g'),
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g,
  // JWT, left-anchored (round 16): unanchored, "eyJeyJ…" was quadratic.
  new RegExp(String.raw`(?:(?<![A-Za-z0-9_-])|(?<=%[0-9A-Fa-f]{2}))eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`, 'g'),
  // Round 15 (PARITY with apps/api/src/utils/secretRedaction.js): SendGrid,
  // npm, webhook secrets, GitLab (digit AND capital: a lowercase kebab id has
  // none), PyPI, and a Slack incoming-webhook path.
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /\bnpm_[A-Za-z0-9]{20,}/g,
  new RegExp(String.raw`(?<![A-Za-z0-9])whsec_(?=[A-Za-z0-9+/=]{0,64}[0-9A-Z])[A-Za-z0-9+/=]{16,}`, 'g'),
  new RegExp(String.raw`(?<![A-Za-z0-9])glpat-${SC_DIGIT_WITHIN('[A-Za-z0-9_.-]')}(?=[A-Za-z0-9_.-]{0,64}[A-Z])[A-Za-z0-9_.-]{20,}`, 'g'),
  /(?<![A-Za-z0-9])pypi-AgE[A-Za-z0-9_-]{40,}/g,
  /(?<=hooks\.slack\.com\/(?:services|workflows|triggers)\/)T[A-Z0-9]{6,16}\/[AB][A-Z0-9]{6,16}\/[A-Za-z0-9]{16,64}/g,
  // Round 16 (PARITY with apps/api/src/utils/secretRedaction.js): Fly.io,
  // Hugging Face, Shopify, Linear, Doppler.
  /\bFlyV1[ _][A-Za-z0-9_+/=,-]{16,}/g,
  /(?<![A-Za-z0-9])f(?:m1|m2|o1)_[A-Za-z0-9_+/=,-]{16,}/g,
  // A signed URL's signature IS the credential (Azure SAS `sig=`, S3 / GCS
  // presigned URLs). The URL and its other parameters stay readable.
  /(?<=[?&](?:sig|X-Amz-Signature|X-Goog-Signature)=)[A-Za-z0-9%+/=_-]{16,1024}/g,
  /(?<![A-Za-z0-9_])hf_(?=[A-Za-z0-9]{0,40}[A-Z])(?=[A-Za-z0-9]{0,40}[a-z])[A-Za-z0-9]{30,40}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9])shp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9])lin_api_[A-Za-z0-9]{30,}/g,
  /(?<![A-Za-z0-9.])dp\.(?:pt|st|ct|sa|scim|audit)\.(?:[A-Za-z0-9_-]{1,64}\.)?[A-Za-z0-9]{40,}/g,
  // Round 17: formats in gitleaks' default rules that every redactor let
  // through bare. Each is anchored on its left and shape-specific; the one a
  // kebab id could start with (GitLab's other token kinds) needs a digit AND a
  // capital, as glpat- does. PARITY: all three redactors carry these lines.
  /(?<![A-Za-z0-9])NRAK-[A-Za-z0-9]{27}(?![A-Za-z0-9])/g, // New Relic user API key
  /(?<![A-Za-z0-9])NRII-[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])/g, // New Relic insert key
  /(?<![A-Za-z0-9])sntrys_eyJ[A-Za-z0-9+/=_-]{20,1024}/g, // Sentry org auth token
  /(?<![A-Za-z0-9])sntryu_[a-f0-9]{64}(?![A-Za-z0-9])/g, // Sentry user auth token
  /(?<![A-Za-z0-9_.])sk\.eyJ[A-Za-z0-9_-]{10,512}\.[A-Za-z0-9_-]{20,1024}/g, // Mapbox secret token (pk. is public)
  /(?<![A-Za-z0-9])ATATT3[A-Za-z0-9_=-]{150,1024}/g, // Atlassian API token
  /(?<![A-Za-z0-9])do[por]_v1_[a-f0-9]{64}(?![A-Za-z0-9])/g, // DigitalOcean PAT / OAuth / refresh
  /(?<![A-Za-z0-9])gl(?:dt|rt|ptt|cbt|ft|imt|soat)-(?=[A-Za-z0-9_.-]{0,64}[0-9])(?=[A-Za-z0-9_.-]{0,64}[A-Z])[A-Za-z0-9_.-]{20,1024}/g, // GitLab deploy / runner / trigger / ...
  /(?<![A-Za-z0-9.])hv[sbr]\.(?=[A-Za-z0-9_-]{0,64}[0-9])[A-Za-z0-9_-]{24,1024}/g, // HashiCorp Vault service / batch / recovery
  /(?<![A-Za-z0-9])dapi[a-f0-9]{32}(?:-[0-9])?(?![A-Za-z0-9])/g, // Databricks
  /(?<![A-Za-z0-9])glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}(?![A-Za-z0-9])/g, // Grafana service account
  /(?<![A-Za-z0-9])glc_(?=[A-Za-z0-9+/]{0,64}[0-9])[A-Za-z0-9+/]{32,400}={0,2}/g, // Grafana Cloud
  /AGE-SECRET-KEY-1[0-9A-Z]{58}/g, // age
  /(?<![A-Za-z0-9])pscale_(?:pw|tkn|oauth)_[A-Za-z0-9=._-]{32,64}/g, // PlanetScale
  /(?<![A-Za-z0-9])[A-Za-z0-9]{14}\.atlasv1\.[A-Za-z0-9_=-]{60,1024}/g, // Terraform Cloud / Enterprise
];
// PEM blocks, paired BEGIN -> first END after it, with the input cut at the
// last END so no BEGIN can scan to the end and fail (quadratic on many
// unterminated BEGINs). PARITY: redactPemBlocks in apps/api secretRedaction.js.
const SC_PEM_BLOCK = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const SC_PEM_END = /-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
function scRedactPemBlocks(input) {
  if (!input.includes('-----BEGIN ')) return input;
  let lastEnd = -1;
  for (const m of input.matchAll(SC_PEM_END)) lastEnd = m.index + m[0].length;
  if (lastEnd < 0) return input;
  return input.slice(0, lastEnd).replace(SC_PEM_BLOCK, SC_REDACTED) + input.slice(lastEnd);
}
// Optional closing quote (["']?) allowed between key name and separator so
// JSON-quoted keys (e.g. {"api_key": "..."}) still redact.
// EVERY QUANTIFIER HERE IS BOUNDED ON BOTH SIDES, DELIBERATELY.
//
// These patterns run at PERSIST time on arbitrary user text, and an open-ended
// quantifier makes each failed match attempt scan to the end of the input —
// once per starting position, which is quadratic. Measured on the unbounded
// version: 8 KB took 38 ms, 20 KB took 228 ms, 40 KB took 897 ms. Four times
// the text, sixteen times the work. A 200 KB brief would have held the write
// path for roughly twenty seconds, and a brief is a thing a user can paste
// into.
//
// The ceilings are chosen to be far above any real secret and far below the
// size where the scan costs anything: a credential that needs more than 1024
// characters is a PEM block or a JWT, and both have their own patterns above.
const SC_MAX_SECRET = 1024;
// The separator is ':' / '=' or whitespace FOLLOWED BY A SCHEME ("authorization
// middleware" is English), and a bare value needs a digit, '+' or '='.
const SC_AUTH_VALUE = '[A-Za-z0-9._\\-+/=~]';
const SC_AUTH_HEADER = new RegExp(
  String.raw`\b(authorization|x-api-key|api[_-]?key)\b(["']?)(\s*[:=]\s*|\s+(?=(?:bearer|basic|token)\s))`
  + String.raw`(?:(["']?)((?:bearer|basic|token)\s+)(${SC_AUTH_VALUE}{8,${SC_MAX_SECRET}})`
  + String.raw`|"${SC_AUTH_VALUE}{8,${SC_MAX_SECRET}}"|'${SC_AUTH_VALUE}{8,${SC_MAX_SECRET}}'`
  + String.raw`|(?=${SC_AUTH_VALUE}{0,256}[0-9+=])${SC_AUTH_VALUE}{8,${SC_MAX_SECRET}})`,
  'gi',
);
// Prefix before the KEY/TOKEN/SECRET/... suffix is 0-or-more so a bare key
// name that IS one of the suffix words (e.g. "secret", "token") also matches.
// Value guard: a secret value is at least 8 chars, and when unquoted must contain a
// digit or secret-ish symbol. Without this the pattern matched ordinary prose —
// "ADMIN_PASSWORD: contact support" became "[REDACTED] support", and "the auth:
// middleware runs first" lost the word after the colon. That runs at PERSIST time in
// the shared-context normalizers, so it destroyed the stored text irreversibly, not
// just one rendered brief. Biased toward false negatives on purpose: silently
// mangling a user's debugging notes is worse than missing a low-entropy placeholder.
// The lookahead window is bounded too, and it is the expensive one: unbounded,
// `[^\s'";]*` walked the whole unbroken run at EVERY starting position looking
// for a digit or symbol, which is where the quadratic above came from. A real
// secret carries one inside its first 256 characters.
const SC_LOOKAHEAD_WINDOW = 256;
// A bare "KEY" is not a secret name ("Partition key: tenant_id", "cache_key:
// user:123", "hotkey=ctrl+shift+k"); and a value needs a digit, '+' or '=' —
// '-', '_', '.' and '/' are every kebab id, column name and path.
const SC_SECRET_NAME = '(?:API|SECRET|PRIVATE|ACCESS|MASTER|SIGNING|ENCRYPTION|CLIENT|AUTH)[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH';
const SC_ASSIGNMENT_GUARD = `(?=[^\\s'";]{0,${SC_LOOKAHEAD_WINDOW}}[0-9+=])`;
// A reference to a secret (`${API_KEY}`, `${{ secrets.X }}`, `$(cmd)`, `$VAR`)
// is not one.
// Only `${…}`, `$(…)` and a bare `$NAME` that ENDS the value (round 17):
// `DB_PASSWORD=$uperS3cret!` is a password that starts with '$'.
const SC_NOT_A_REFERENCE = String.raw`(?!["']?\$(?:[{(]|[A-Za-z_][A-Za-z0-9_]{0,128}(?![^\s'"\x60;,)}\]&|])))`;
const SC_ASSIGNMENT_VALUE = String.raw`("${SC_ASSIGNMENT_GUARD}[^"\s]{8,${SC_MAX_SECRET}}"|'${SC_ASSIGNMENT_GUARD}[^'\s]{8,${SC_MAX_SECRET}}'|${SC_ASSIGNMENT_GUARD}[^\s'";]{8,${SC_MAX_SECRET}})`;
const SC_ASSIGNMENT = new RegExp(
  String.raw`\b([A-Za-z0-9_]{0,64}(?:${SC_SECRET_NAME}))\b(["']?)(\s*[:=]\s*)(?!\[REDACTED\])${SC_NOT_A_REFERENCE}${SC_ASSIGNMENT_VALUE}`,
  'gi',
);
// An UPPER_SNAKE env var named for a credential (*_KEY_BASE, *_PASS, *_PWD,
// *_CREDENTIALS, and TOKEN / SECRET / PASSWORD in the `:` and JSON forms),
// CASE-SENSITIVELY. *_KEY moved to SC_KEY_NAME_ASSIGNMENT. PARITY:
// ENV_KEY_ASSIGNMENT in apps/api/src/utils/secretRedaction.js.
const SC_ENV_SECRET_SUFFIX = '_(?:KEY_BASE|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?)';
const SC_ENV_KEY_ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]{0,64}${SC_ENV_SECRET_SUFFIX})(?![A-Za-z0-9_])(["']?)(\s*[:=]\s*)(?!\[REDACTED\])${SC_NOT_A_REFERENCE}${SC_ASSIGNMENT_VALUE}`,
  'g',
);
// Terraform's per-host credential variable, `TF_TOKEN_app_terraform_io=…`:
// the host rides in the name, so no suffix rule sees it (round 17).
const SC_TF_TOKEN_ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9_])(TF_TOKEN_[A-Za-z0-9_-]{1,128})(?![A-Za-z0-9_-])(["']?)(\s*[:=]\s*)(?!\[REDACTED\])${SC_NOT_A_REFERENCE}${SC_ASSIGNMENT_VALUE}`,
  'g',
);
// Any name ending in "key" (camelCase, snake, kebab, dotted; any case), but
// only over a SECRET-SHAPED value: `AccountKey=<base64>;` and
// `Ocp-Apim-Subscription-Key: <hex>` are masked, `SEEN_KEY =
// 'dd_post_sync_modal_seen_v1'` and ROUTING_KEY=orders.created.v1 are not.
// PARITY: KEY_NAME_ASSIGNMENT / secretShapedValue in apps/api secretRedaction.js,
// which carries the reasoning.
const SC_KEY_NAME_ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9_.-])([A-Za-z0-9][A-Za-z0-9_.-]{0,64}?key)(?![A-Za-z0-9_])(["']?)(\s*[:=]\s*)(?!\[REDACTED\])${SC_NOT_A_REFERENCE}${SC_ASSIGNMENT_VALUE}`,
  'gi',
);
const SC_PUBLIC_KEY_NAME = /public|publishable/i;
// Round 17: a name that says the key IDENTIFIES something — a cache entry, an
// object, an event, a row — holds a hash or an id, not a credential:
// `cacheKey=<sha1>` and `dedupeKey: evt_…` were masked, and two cards that
// differed only there merged. Credential-ish names (storageKey, accountKey,
// apiKey, secretKey, privateKey, accessKey, masterKey, signingKey,
// subscriptionKey, licenseKey, adminKey …) are deliberately NOT here.
// Round 18: the exempt word must be a WHOLE segment of the name (camelCase is
// split first), so `blockKey` is not `lock`+Key and `PROFILE_KEY` is not
// `file`+KEY; and words that also name real credentials were dropped —
// Azure `primaryKey`, Azure Cache `REDIS_KEY`, securecookie `hashKey`,
// PagerDuty `routing_key`, `EVENT_KEY`, `STATE_KEY`, `lockKey`.
const SC_IDENTIFIER_KEY_NAME = /(?:^|[_.-])(?:cache|object|dedupe?|idempot(?:ency)?|sort|partition|shard|integrity|foreign|i18n|translation|etag|lookup|index|group(?:ing)?|row|range|composite|unique|cursor|react|item|path|message|record)[_.-]?key$/;
function scIsIdentifierKeyName(key) {
  const snake = String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return SC_IDENTIFIER_KEY_NAME.test(snake);
}
// A value that NAMES its digest algorithm is a digest (`integrity:
// sha512-…`, an ssh host key's `SHA256:…` fingerprint), never a secret.
const SC_DIGEST_VALUE = /^(?:sha(?:1|224|256|384|512)|md5|blake2[bs]?|xxh(?:32|64|128|3)?)[-:]/i;
const SC_SECRET_VALUE_PREFIX = /^(?:base64:|key-|SG\.)/;
function scSecretShapedRun(run) {
  if (run.length < 16) return false;
  let digits = 0, upper = 0, lower = 0, changes = 0, prev = '';
  for (const ch of run) {
    const cls = ch >= '0' && ch <= '9' ? 'd' : ch >= 'A' && ch <= 'Z' ? 'u' : ch >= 'a' && ch <= 'z' ? 'l' : 'o';
    if (cls === 'd') digits++; else if (cls === 'u') upper++; else if (cls === 'l') lower++;
    if (prev && cls !== prev) changes++;
    prev = cls;
  }
  if (!digits || upper + lower < 2) return false;
  if (upper && lower) return changes * 3 >= run.length || (changes + 1) * 2 >= run.length;
  if (digits < 2) return false;
  if (/^(?:[0-9a-f]+|[0-9A-F]+)$/.test(run)) return true; // hex
  return changes * 5 >= run.length;
}
function scSecretShapedValue(value) {
  const v = String(value).replace(/^["']|["']$/g, '');
  if (SC_DIGEST_VALUE.test(v)) return false;
  if (SC_SECRET_VALUE_PREFIX.test(v)) return true;
  // '/' separates a path's segments but is also a base64 character: a piece
  // carrying '+' or '=' is read whole, anything else is split on '/' too.
  return v.split(/[-_.:]+/).some((piece) => (/[+=]/.test(piece) ? scSecretShapedRun(piece) : piece.split('/').some(scSecretShapedRun)));
}
// `x-api-key <token>` with no colon, only when the value is secret-shaped.
const SC_X_API_KEY_SPACE = new RegExp(
  String.raw`\b(x-api-key)(["']?[ \t]{1,16}["']?)(?=${SC_AUTH_VALUE}{0,256}[0-9])(?=${SC_AUTH_VALUE}{0,256}[A-Za-z])${SC_AUTH_VALUE}{16,${SC_MAX_SECRET}}`,
  'gi',
);
// THE ACTUAL QUADRATIC ONE, found by timing each pattern rather than reasoning
// about which looked worst. The unbounded scheme `[a-z0-9+.-]*` consumed an
// entire unbroken run at every starting position looking for `://`, failed,
// and advanced one character to do it again: 200 KB took 22.5 SECONDS on its
// own, while the two patterns that look more frightening took under a
// millisecond between them.
//
// A URI scheme is at most 32 characters (RFC 3986 keeps them far shorter), and
// userinfo long enough to matter is not a credential anyone typed.
const SC_URI_SCHEME_MAX = 31;
const SC_URI_PART_MAX = 256;
// The password runs to the LAST '@' before the host (`u:p@ss@host` masked only
// `p`), stopping at '/', quotes, backtick, angle brackets and backslash.
const SC_URI_CREDS = new RegExp(
  String.raw`([a-z][a-z0-9+.-]{0,${SC_URI_SCHEME_MAX}}://[^\s:/@]{0,${SC_URI_PART_MAX}}:)((?:(?!,[a-z][a-z0-9+.-]{0,31}:)[^\s/"'\x60<>\\?#]){1,${SC_URI_PART_MAX}})(@)`,
  'gi',
);

function redactSecretText(input) {
  if (typeof input !== 'string' || input.length === 0) return input;
  let out = scRedactPemBlocks(input);
  out = out.replace(SC_URI_CREDS, `$1${SC_REDACTED}$3`);
  out = out.replace(SC_AUTH_HEADER, (m, key, quote, sep, openQuote, scheme, schemeValue) => {
    if (scheme && /^[a-z]+$/.test(schemeValue)) return m;
    return `${key}${quote}${sep}${openQuote || ''}${scheme || ''}${SC_REDACTED}`;
  });
  out = out.replace(SC_X_API_KEY_SPACE, (m, key, sep) => `${key}${sep}${SC_REDACTED}`);
  out = out.replace(SC_ASSIGNMENT, (m, key, quote, sep) => `${key}${quote}${sep}${SC_REDACTED}`);
  out = out.replace(SC_ENV_KEY_ASSIGNMENT, (m, key, quote, sep) => `${key}${quote}${sep}${SC_REDACTED}`);
  out = out.replace(SC_TF_TOKEN_ASSIGNMENT, (m, key, quote, sep) => `${key}${quote}${sep}${SC_REDACTED}`);
  out = out.replace(SC_KEY_NAME_ASSIGNMENT, (m, key, quote, sep, value) => (
    SC_PUBLIC_KEY_NAME.test(key) || scIsIdentifierKeyName(key) || !scSecretShapedValue(value) ? m : `${key}${quote}${sep}${SC_REDACTED}`));
  for (const re of SC_TOKEN_PATTERNS) out = out.replace(re, SC_REDACTED);
  return out;
}

function redactSecretTextArray(values) {
  return Array.isArray(values) ? values.map((v) => redactSecretText(v)) : values;
}

// Pinned and high-importance entries survive cap eviction ahead of trivial newer
// ones (0 when the entry carries no hints, so untagged logs behave as before).
const IMPORTANCE_PRIORITY = { critical: 3, high: 2, normal: 0, low: -1 };
function entryPriority(item) {
  return (item && item.pinned ? 1000 : 0) + (IMPORTANCE_PRIORITY[item && item.importance] || 0);
}

// `recencyOf` may be the sentinel POSITION_IS_RECENCY for entry types that carry
// no timestamp: mergeContextObject feeds [...current, ...delta], so their ORDER
// is their recency and the newest sits at the tail.
const POSITION_IS_RECENCY = 'position';

function uniqueEntries(values = [], makeKey, schema, maxItems, recencyOf = null, priorityOf = null) {
  const positional = recencyOf === POSITION_IS_RECENCY;
  const deduped = new Map();
  for (const value of values || []) {
    const parsed = schema.safeParse(value);
    if (!parsed.success) continue;
    const item = parsed.data;
    const key = makeKey(item);
    if (!key) continue;
    // ATTRIBUTION SURVIVES A DEDUPE, and the FIRST writer keeps it.
    //
    // These lists are fed [...stored, ...incoming], so the entry already in the
    // map is the one recorded first — and whoever recorded a thing first is who
    // learned it. A later copy of the same summary is a re-record, not a change
    // of authorship, which is exactly the rule mergeContextObject already
    // applies to recent_decisions. Without this, a colleague re-shipping the
    // same line quietly took credit for it, and an unattributed re-record erased
    // the author outright. Inert on lists whose schema has no author.
    const previous = deduped.get(key);
    const kept = previous?.contributed_by && previous.contributed_by !== item.contributed_by
      ? { ...item, contributed_by: previous.contributed_by }
      : item;
    // Re-recording an entry REFRESHES it. Map.set on a key it already holds
    // keeps the original slot, so a path written down again today ranked as old
    // as the day it first appeared — and at the cap that is the difference
    // between kept and evicted. Only for positional recency: where a real
    // timestamp exists it already says this, and the other lists are read by
    // position from their head.
    if (positional && deduped.has(key)) deduped.delete(key);
    deduped.set(key, kept);
  }
  const entries = Array.from(deduped.values());
  if (entries.length <= maxItems) return entries;
  // Keep the most valuable maxItems, not the oldest. mergeContextObject feeds
  // [...current, ...delta], so a naive slice(0,N) silently drops every new append
  // at the cap while the tool still reports "Recorded". Rank by priority
  // (pinned/important) first, then recency; restore chronological order among the
  // kept set. With no priority/recency hints, the delta tail is the newest.
  if (priorityOf || recencyOf) {
    // Untagged entries all score the same priority, so recency is what actually
    // decides the cap. Passing priority WITHOUT recency made every comparison a
    // tie, and a stable sort then kept the oldest maxItems — the silent drop the
    // ranking exists to prevent, one layer down.
    const order = positional ? new Map(entries.map((item, index) => [item, index])) : null;
    const rec = positional ? ((item) => order.get(item)) : (recencyOf || (() => 0));
    const pri = priorityOf || (() => 0);
    return entries
      .slice()
      .sort((a, b) => (pri(b) - pri(a)) || (rec(b) - rec(a)))
      .slice(0, maxItems)
      .sort((a, b) => rec(a) - rec(b));
  }
  return entries.slice(-maxItems);
}

function normalizeHotPaths(values = []) {
  return uniqueEntries(
    (values || []).map((item) => item && typeof item === 'object' ? {
      ...item,
      label: redactSecretText(item.label),
      path: redactSecretText(item.path),
      purpose: redactSecretText(item.purpose),
    } : item),
    (item) => `${String(item.label || '').trim().toLowerCase()}::${String(item.path || '').trim().toLowerCase()}`,
    HotPathEntrySchema,
    40,
    POSITION_IS_RECENCY,
    entryPriority,
  );
}

function normalizeEntrypoints(values = []) {
  return uniqueEntries(
    (values || []).map((item) => item && typeof item === 'object' ? {
      ...item,
      label: redactSecretText(item.label),
      path: redactSecretText(item.path),
      purpose: redactSecretText(item.purpose),
    } : item),
    (item) => `${String(item.label || '').trim().toLowerCase()}::${String(item.path || '').trim().toLowerCase()}`,
    EntrypointEntrySchema,
    20,
  );
}

function normalizeSurfaces(values = []) {
  return uniqueEntries(
    (values || []).map((item) => ({
      ...item,
      label: redactSecretText(item?.label),
      purpose: redactSecretText(item?.purpose),
      paths: redactSecretTextArray(uniqueStrings(item?.paths || [])),
    })),
    (item) => String(item.label || '').trim().toLowerCase(),
    SurfaceEntrySchema,
    20,
  );
}

// The identity of a debugging note, for dedupe.
//
// It was the lower-cased summary, verbatim — so a scheduled agent filing
// "Growth run 2026-09-04 14:00: 3 signups, nothing to act on" every hour produced
// a note that was new every hour, by one digit. The log holds 30, the run filed
// 24 a day, and within two days every real finding had been evicted by copies of
// the same sentence. Dates, times and digit runs are therefore not part of a
// note's identity: two notes that differ ONLY by numbers are the same note, and
// the later one is kept.
//
// That cost was first written down as acceptable and is not: "port 8080
// refuses" and "port 3001 refuses" are two findings, and so are "Migration 0042
// fails" and "Migration 0057 fails", and "Tests hang on Node 18" and "on Node
// 22". Stripping every digit run collapsed each of those pairs into one note
// while record_finding still answered "recorded" — the same silent loss the
// dedupe was written to stop, pointed at real findings instead of run-logs.
//
// So a number that NAMES something keeps its place in the key, and a number
// that COUNTS something does not. Written out, because the first attempt at
// this listed `#`, `v`, `pr`, `issue`, `error`, `status` and `code` as
// identifiers — which is precisely how a scheduled agent numbers its own logs,
// so the run-logs became distinct findings again and the log emptied a second
// time, from the other end:
//
//   the number is a NAME (kept)        |  the number is a COUNT (stripped)
//   -----------------------------------+-----------------------------------
//   Migration 0042 fails               |  Hourly scan #41: 0 regressions
//   listens on port 8080               |  Deploy v542 healthy
//   Tests hang on Node 18 / node v18   |  error 3 times in the last hour
//   Postgres 16 plans a seq scan       |  issue 0 open, queue depth 12
//   the endpoint returns 404           |  PR #512 merged, 3 open
//   answers status 502 while booting   |  attempt 4 timed out
//
// The two columns are the same SHAPE — "port 8080" and "run 2" differ in the
// word, not the pattern — so a keyword list is what separates them, and the
// list is of things whose number is their name: a migration, a port, a language
// runtime, an HTTP status. A version or release NUMBER is on the right-hand
// side on purpose: two notes identical except for "v542"/"v543" are one
// recurring note about successive releases, and two notes that say different
// things about two releases differ in the rest of the sentence anyway.
//
// An HTTP status needs the shape as well as the word, because "error 3 times"
// and "error 500 on upload" share the word: three digits in 100-599, nothing
// else. Erring towards stripping stays the safe direction — an unlisted
// identifier collapses, which the cap policy below then limits the cost of,
// while a counter listed by mistake lets the hourly run-logs back in.
//
// The floor below limits the rest — once the digits are gone there must still
// be a sentence left to compare, otherwise the verbatim key stands and short
// numeric notes ("502", "PR #486") keep their own identity.
const NOTE_KEY_MIN_CHARS = 16;
const NOTE_DATE_TIME = /\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?)?|\d{1,2}:\d{2}(?::\d{2})?/g;
// The word immediately before a number that is the NAME of the thing it follows.
const NOTE_NAMED_THING_BEFORE = /(?:^|[^a-z0-9])(?:migrations?|ports?|node|deno|bun|python|ruby|php|java|go|rust|postgres|postgresql|mysql|redis)[\s:=#v]*$/;
// The word before an HTTP status, which only counts with a status-shaped number.
const NOTE_HTTP_STATUS_BEFORE = /(?:^|[^a-z0-9])(?:http|https|status|code|returns?|returned|responds?|responded|answers?|answered|error)[\s:=#]*$/;
const NOTE_HTTP_STATUS = /^[1-5]\d\d$/;

function noteNumberIsIdentity(digits, before) {
  if (NOTE_NAMED_THING_BEFORE.test(before)) return true;
  return NOTE_HTTP_STATUS.test(digits) && NOTE_HTTP_STATUS_BEFORE.test(before);
}

function debuggingNoteKey(item) {
  const verbatim = String(item?.summary || '').trim().toLowerCase();
  const stripped = verbatim
    .replace(NOTE_DATE_TIME, ' ')
    .replace(/\d+/g, (digits, offset, whole) => (
      noteNumberIsIdentity(digits, whole.slice(0, offset)) ? digits : ' '
    ))
    .replace(/[\s:/.,#-]+/g, ' ')
    .trim();
  return stripped.length >= NOTE_KEY_MIN_CHARS ? stripped : verbatim;
}

// The log holds this many notes. Named because the eviction policy below is
// about what happens AT it, and a bare 30 two screens down said nothing.
const DEBUGGING_NOTE_LIMIT = 30;

// "Do these two notes look alike?" — the key with EVERY digit gone.
//
// That is the wrong question for identity (it makes "Migration 0042" and
// "Migration 0057" one note, which is the bug above) and exactly the right one
// for the cap: look-alikes are what a scheduled agent produces, whichever way
// the key above decides about their numbers.
function debuggingNoteGroupKey(item) {
  const stripped = String(item?.summary || '').trim().toLowerCase()
    .replace(NOTE_DATE_TIME, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[\s:/.,#-]+/g, ' ')
    .trim();
  return stripped || debuggingNoteKey(item);
}

// WHICH NOTE GOES WHEN THE LOG IS FULL.
//
// The key can never be perfect, so the cap is the last line of defence, and
// ranking by recency is no defence at all: the newest 30 of a flood ARE the
// flood. 32 run-logs that each slipped past the key evicted 30 distinct
// findings, one per write, every reply answering "Recorded".
//
// So the note that goes is the OLDEST member of the largest group of
// look-alikes THAT IS ACTUALLY A FLOOD, and otherwise the oldest note overall.
// A flood can then never displace more than it brings: its own group grows, its
// own oldest member leaves, and the distinct findings around it keep their
// slots. Pinned and important notes are ranked last for eviction, the same
// order uniqueEntries would have applied.
//
// "THAT IS ACTUALLY A FLOOD" IS THE WHOLE DIFFICULTY.
//
// The group key strips EVERY digit, which is the right question for a flood and
// deliberately a different question from identity: debuggingNoteKey works case
// by case to keep "port 8080" and "port 3000" apart, and to keep five
// "Migration 00NN fails" findings as five findings. Asking only for the largest
// group handed those straight back — a PAIR the key had just kept apart was the
// largest group on an otherwise unrelated log, so it was eaten before any older
// singleton, and five migration notes shrank to one over four unrelated writes.
//
// Two signals, because either alone is wrong. SIZE: a group of two is a pair,
// not a flood, and no group is ever taken below two. TIME: three notes recorded
// weeks apart are somebody hitting the same class of bug three times; a run is
// an agent writing the same line inside a couple of days, so more than half the
// group has to fall inside one 48h window. Notes with no timestamp parse to 0,
// which reads as one instant and therefore as a run — the behaviour this had
// before timestamps entered the decision.
//
// TIME ALONE LET A SLOW FLOOD THROUGH. An agent that writes its look-alike line
// once a week never has half its group inside any 48h window, so by the rule
// above it was never a run: its notes competed as ordinary singletons, the
// oldest notes overall were the real findings, and one of those left on every
// write until none remained. So there is a third signal, SHARE: a look-alike
// group holding a fifth of the log is a flood at any cadence. Five
// "Migration 00NN fails" findings on a 30-note log are under it; a weekly
// run-log is stopped at six and costs at most a handful of older notes once,
// instead of all of them eventually.
const NOTE_RUN_MIN_MEMBERS = 3;
const NOTE_RUN_WINDOW_MS = 48 * 3600 * 1000;
const NOTE_RUN_LOG_SHARE = 5;

function noteGroupIsARun(members, recency, cap = DEBUGGING_NOTE_LIMIT) {
  if (members.length < NOTE_RUN_MIN_MEMBERS) return false;
  if (members.length >= Math.max(NOTE_RUN_MIN_MEMBERS + 1, Math.ceil(cap / NOTE_RUN_LOG_SHARE))) return true;
  const times = members.map(recency).sort((a, b) => a - b);
  // A window STARTS at each note and runs forward. Testing `t - start <= window`
  // alone also counts every note before it, which makes the last note's window
  // contain the whole group and calls any group at all a run.
  for (const start of times) {
    const within = times.filter((t) => t >= start && t - start <= NOTE_RUN_WINDOW_MS).length;
    if (within * 2 > members.length) return true;
  }
  return false;
}

function evictDebuggingNotesToCap(entries, cap) {
  if (entries.length <= cap) return entries;
  // Computed once per call, not once per eviction: a long import can arrive
  // hundreds of notes over the cap, and the group key runs three regexes.
  const recencyOf = new Map(entries.map((item) => [item, Date.parse(item?.added_at) || 0]));
  const priorityOf = new Map(entries.map((item) => [item, entryPriority(item)]));
  const groupKeyOf = new Map(entries.map((item) => [item, debuggingNoteGroupKey(item)]));
  const recency = (item) => recencyOf.get(item) || 0;
  const survivors = new Set(entries);
  while (survivors.size > cap) {
    // Everything the caller marked as worth keeping is considered only once
    // nothing cheaper is left, rather than protected outright: a log of thirty
    // pinned notes still has to lose one to store the thirty-first.
    let floor = Infinity;
    for (const item of survivors) floor = Math.min(floor, priorityOf.get(item));
    const groups = new Map();
    for (const item of survivors) {
      if (priorityOf.get(item) !== floor) continue;
      const key = groupKeyOf.get(item);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    let victim = null;
    let victimGroupSize = 0;
    for (const members of groups.values()) {
      const oldest = members.reduce((left, right) => (recency(right) < recency(left) ? right : left));
      // A group that is not a run is not a candidate at all. Its members still
      // compete as ordinary notes through the singleton branch below, so the
      // oldest of them can still go — just not ahead of an older note elsewhere.
      const size = noteGroupIsARun(members, recency, cap) ? members.length : 1;
      const wins = size > victimGroupSize
        || (size === victimGroupSize && recency(oldest) < recency(victim));
      if (wins) {
        victim = oldest;
        victimGroupSize = size;
      }
    }
    survivors.delete(victim);
  }
  // Survivors keep the order they arrived in. mergeContextObject feeds
  // [...current, ...delta] and the refresh map below moves a re-recorded note to
  // the tail, so that order already reads oldest-first, which is where every
  // reader looks for the newest.
  return entries.filter((item) => survivors.has(item));
}

function normalizeDebuggingNotes(values = []) {
  // Latest wins AND takes the latest position. uniqueEntries alone would keep the
  // refreshed note in the slot its first copy held, and every reader takes the
  // tail as "newest" — so this hour's run would render as last week's.
  const latest = new Map();
  for (const item of values || []) {
    if (!item || typeof item !== 'object') continue;
    const key = debuggingNoteKey(item);
    const previous = latest.get(key);
    if (previous) latest.delete(key);
    // A pin is a person saying "keep this"; it outlives the rewording. Without
    // this an unpinned hourly copy would silently unpin the note it replaced.
    //
    // The author outlives it for the same reason and one stronger: the note that
    // survives here is the REWORDED copy, so rebuilding it from the newcomer
    // alone hands a colleague's finding to whoever happened to refresh it. The
    // dedupe in uniqueEntries below applies the same rule; this map runs first
    // and would otherwise have already thrown the author away.
    const carried = {
      ...item,
      ...(previous?.pinned && !item.pinned ? { pinned: true } : {}),
      ...(previous?.contributed_by ? { contributed_by: previous.contributed_by } : {}),
    };
    latest.set(key, carried);
  }
  // Capped by evictDebuggingNotesToCap, not by uniqueEntries: this is the one
  // list whose floods are self-similar, so "keep the most recent/important N"
  // is the policy that empties it. uniqueEntries still does the parsing and the
  // dedupe, with its own cap lifted out of the way.
  const parsed = uniqueEntries(
    Array.from(latest.values()).map((item) => ({
      ...item,
      summary: redactSecretText(item?.summary),
      paths: redactSecretTextArray(uniqueStrings(item?.paths || [])),
    })),
    debuggingNoteKey,
    DebuggingNoteEntrySchema,
    Number.MAX_SAFE_INTEGER,
  );
  return evictDebuggingNotesToCap(parsed, DEBUGGING_NOTE_LIMIT);
}

function normalizeLandmines(values = []) {
  return uniqueEntries(
    (values || []).map((item) => ({
      ...item,
      summary: redactSecretText(item?.summary),
      paths: redactSecretTextArray(uniqueStrings(item?.paths || [])),
    })),
    (item) => String(item.summary || '').trim().toLowerCase(),
    LandmineEntrySchema,
    20,
    (item) => Date.parse(item.added_at) || 0,
    entryPriority,
  );
}

function normalizeShipped(values = []) {
  // Append-style accumulator: dedupe by summary, keep the newest 15 (evict oldest).
  // No importance ranking — every shipped entry is an equally-real completion fact;
  // recency is the only ordering that matters.
  return uniqueEntries(
    (values || []).map((item) => item && typeof item === 'object' ? {
      ...item,
      summary: redactSecretText(item.summary),
    } : item),
    (item) => String(item.summary || '').trim().toLowerCase(),
    ShippedEntrySchema,
    15,
    (item) => Date.parse(item.shipped_at) || 0,
  );
}

function formatPathEntries(entries = [], count = 2) {
  return entries
    .slice(0, count)
    .map((entry) => {
      const label = clipText(entry.label, 28);
      const path = clipText(entry.path, 52);
      return `${label} -> ${path}`;
    });
}

function formatEntrypointEntries(entries = [], count = 2) {
  return entries
    .slice(0, count)
    .map((entry) => {
      const label = clipText(entry.label, 28);
      const path = clipText(entry.path, 52);
      return `${label} -> ${path}`;
    });
}

function createContextObject(input) {
  return ContextObjectSchema.parse({
    project_name: input.project_name,
    category: input.category || 'coding',
    description: input.description || '',
    goals: uniqueStrings(input.goals),
    current_status: input.current_status || '',
    recent_decisions: (input.recent_decisions || []).slice(0, 20),
    recurring_context: uniqueStrings(input.recurring_context),
    tech_stack: uniqueStrings(input.tech_stack),
    file_structure_summary: uniqueStrings(input.file_structure_summary),
    current_task: input.current_task || '',
    open_questions: uniqueStrings(input.open_questions),
    hot_paths: normalizeHotPaths(input.hot_paths),
    entrypoints: normalizeEntrypoints(input.entrypoints),
    surfaces: normalizeSurfaces(input.surfaces),
    debugging_notes: normalizeDebuggingNotes(input.debugging_notes),
    landmines: normalizeLandmines(input.landmines),
    shipped: normalizeShipped(input.shipped),
    last_updated: input.last_updated || isoNow(),
    source_summary: input.source_summary || '',
    next_action: input.next_action || '',
    todo_items: input.todo_items || [],
    completed_todos: input.completed_todos || [],
  });
}

// `options.sessionId` is the agent session applying this merge. It is threaded
// in (not read from a global) so the board can record WHICH agent holds a card
// without any caller having to pass a new field — the server already knows the
// session, so holds cost no new tool parameter. Omitted → merges behave exactly
// as they did before holds existed.
// WHICH DECISION GOES WHEN THE LOG IS FULL.
//
// The cap was `slice(-20)`: the oldest entry went, whatever it was. So a
// `critical` decision from last month was evicted to make room for today's
// run-log, and a decision already marked resolved — excluded from every active
// read — kept its seat while a live one lost its own.
//
// Order of eviction: resolved first, then the lowest importance, oldest first
// within a tie. An entry arriving in THIS write is never the one evicted: a
// caller told "stored" must be able to read the text back, even into a log full
// of higher-ranked entries.
//
// THE IMPORTANCE STAMP DOES NOT DECIDE THIS, AND COST EVERY NEW DECISION WHEN
// IT DID.
//
// Ranking by the stamp assumed the stamp meant something. Until #495 every
// structured-event floor write was stamped `high`, so a project holds twenty
// `high` run-logs while a new decision defaults to `normal`. The moment the
// entry written in THIS call stopped being the protected one it was the
// lowest-ranked entry in the log, so the NEXT write evicted it: each decision
// survived exactly one write, every call reported `stored: true`, and the
// floor's entries never turned over. Banding by age alone does not fix it
// either — it rescues only the projects whose backlog has aged past the
// window, and every project active this fortnight holds twenty `high` entries
// INSIDE it.
//
// So among ordinary entries this is simply OLDEST FIRST, in three bands:
//   0. resolved — excluded from every active read already, whatever its age.
//   1. outside the recency window (the same 14 days selectRecentDecisions bands
//      by — one window, not two). An entry with no parseable date counts as
//      old, because a missing date is not evidence of freshness.
//   2. inside the window.
//   3. `critical` — a standing claim rather than a news item. It is the one
//      stamp a person sets deliberately, it does not decay, and it goes last
//      whatever its age.
// Within EVERY band, oldest first, then stored order. `low`, `normal` and
// `high` are not distinguished anywhere: `high` is what the floor wrote by
// default, and telling them apart is what let last week's entry outlive
// today's. A `low` somebody saved on purpose is still a decision they saved.
const DECISION_LOG_CAP = 20;
const DECISION_EVICTION_BAND = { resolved: 0, stale: 1, recent: 2, critical: 3 };

// Same identity the API's dedupeKey gives a summary (case, spacing and trailing
// punctuation do not make a different decision). Kept local: this package has no
// dependency on the API.
function decisionKey(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?;:,\s]+$/g, '');
}

// `options.now` exists for tests; every caller takes the clock.
function capDecisions(decisions, { cap = DECISION_LOG_CAP, keep = [], now = Date.now() } = {}) {
  const list = Array.isArray(decisions) ? [...decisions] : [];
  if (list.length <= cap) return list;
  const kept = new Set((keep || []).map((summary) => decisionKey(summary)).filter(Boolean));
  const windowStart = now - DECISION_RECENCY_WINDOW_DAYS * DAY_MS;
  const timeOf = (entry) => {
    const parsed = Date.parse(entry?.decided_at || '');
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const bandOf = (entry) => {
    if (entry?.resolved) return DECISION_EVICTION_BAND.resolved;
    if (entry?.importance === 'critical') return DECISION_EVICTION_BAND.critical;
    return timeOf(entry) >= windowStart ? DECISION_EVICTION_BAND.recent : DECISION_EVICTION_BAND.stale;
  };
  while (list.length > cap) {
    let victim = -1;
    let victimBand = Infinity;
    let victimTime = Infinity;
    list.forEach((entry, index) => {
      if (kept.has(decisionKey(entry?.summary))) return;
      const band = bandOf(entry);
      if (band > victimBand) return;
      const time = timeOf(entry);
      if (band === victimBand && time >= victimTime) return;
      victim = index; victimBand = band; victimTime = time;
    });
    // Everything left is protected: fall back to the oldest rather than exceed
    // a bound the schema enforces.
    list.splice(victim === -1 ? 0 : victim, 1);
  }
  return list;
}

// The server's stamp for the blocker: a new time when the blocker's text
// changes, none once it is cleared, and otherwise whatever was stored. A delta
// never supplies its own (the spread of `delta` is overridden by this).
function nextBlockerSetAt(current, delta) {
  const stored = String(current?.blocking_issue || '').trim();
  if (typeof delta?.blocking_issue !== 'string') return current?.blocking_issue_set_at || undefined;
  const incoming = delta.blocking_issue.trim();
  if (!incoming) return undefined;
  if (incoming === stored) return current?.blocking_issue_set_at || undefined;
  return isoNow();
}

function mergeContextObject(current, delta, sourceSummary, options = {}) {
  const mergeSessionId = options.sessionId ? String(options.sessionId) : null;
  // `options.contributedBy`: the acting PERSON, for the entries this merge
  // AUTHORS itself rather than copies (a Done transition becoming a shipped
  // entry). Everything that merely travels through already carries its own
  // author from the write path. Omitted — an internal actor, a repair pass —
  // leaves the entry unattributed, which is the honest answer.
  const mergeContributor = options.contributedBy ? String(options.contributedBy) : null;
  const incomingDecisions = (delta.recent_decisions || [])
    .filter((entry) => entry && entry.summary)
    .filter((entry, index, list) => list.findIndex((candidate) => candidate.summary === entry.summary) === index);
  const mergedDecisions = incomingDecisions.length > 0
    ? uniqueStrings([
      ...(current.recent_decisions || []).map((entry) => entry.summary),
      ...incomingDecisions.map((entry) => entry.summary),
    ]).map((summary) => {
      const incoming = incomingDecisions.find((entry) => entry.summary === summary);
      const existing = (current.recent_decisions || []).find((entry) => entry.summary === summary);
      const base = incoming || existing;
      // Preserve reasoning from incoming if present, else keep existing reasoning
      const reasoning = incoming?.reasoning || existing?.reasoning;
      // Take the higher importance level between incoming and existing
      const importanceRanks = { critical: 0, high: 1, normal: 2, low: 3 };
      const incomingRank = importanceRanks[incoming?.importance || 'normal'] ?? 2;
      const existingRank = importanceRanks[existing?.importance || 'normal'] ?? 2;
      const importance = incomingRank <= existingRank ? (incoming?.importance || 'normal') : (existing?.importance || 'normal');
      // Preserve resolved lifecycle across re-ingestion (incoming rarely re-sends it)
      const resolved = incoming?.resolved ?? existing?.resolved ?? false;
      const resolvedAt = incoming?.resolved_at || existing?.resolved_at;
      // ATTRIBUTION SURVIVES RE-INGESTION.
      //
      // A later session re-sending the same decision must not silently adopt it:
      // whoever recorded a claim FIRST is who learned it, and the merge is not a
      // change of authorship. So contributed_by is taken from the existing entry
      // when there is one, and only falls through to the incoming author for a
      // genuinely new decision.
      //
      // A same-summary re-send from a DIFFERENT person is not a rewrite either —
      // it is corroboration, which is exactly what confirmed_by records. On a
      // solo account this is inert, because there is only ever one author.
      const contributedBy = existing?.contributed_by ?? incoming?.contributed_by ?? null;
      const incomingAuthor = incoming?.contributed_by || null;
      const corroborates = Boolean(
        existing && incomingAuthor && contributedBy && incomingAuthor !== contributedBy
      );
      const confirmedBy = corroborates ? incomingAuthor : (incoming?.confirmed_by ?? existing?.confirmed_by ?? null);
      const confirmedAt = corroborates
        ? (incoming?.decided_at || new Date().toISOString())
        : (incoming?.confirmed_at || existing?.confirmed_at);
      return {
        ...base,
        ...(reasoning ? { reasoning } : {}),
        importance,
        resolved,
        ...(resolvedAt ? { resolved_at: resolvedAt } : {}),
        ...(contributedBy ? { contributed_by: contributedBy } : {}),
        ...(confirmedBy ? { confirmed_by: confirmedBy } : {}),
        ...(confirmedAt ? { confirmed_at: confirmedAt } : {}),
      };
    }).filter(Boolean)
    : current.recent_decisions;
  const cappedDecisions = incomingDecisions.length > 0
    ? capDecisions(mergedDecisions, { keep: incomingDecisions.map((entry) => entry.summary) })
    : mergedDecisions;

  let mergedCommands = current.commands || [];
  if (delta.commands && delta.commands.length > 0) {
    const byLabel = new Map((current.commands || []).map((c) => [c.label.toLowerCase(), c]));
    for (const cmd of delta.commands) {
      byLabel.set(cmd.label.toLowerCase(), cmd);
    }
    mergedCommands = Array.from(byLabel.values()).slice(0, 20);
  }

  // Apply removal fields — fuzzy match so minor wording differences still resolve
  const fuzzyMatch = (a, b) => {
    const al = a.toLowerCase(), bl = b.toLowerCase();
    return al.includes(bl) || bl.includes(al);
  };

  /**
   * Resolve removal QUERIES against a list, precisely.
   *
   * Every removal field here used to be `list.filter(x => !queries.some(q =>
   * fuzzyMatch(x, q)))`, and fuzzyMatch is bidirectional substring — so one
   * query deleted everything it appeared in, and because `fuzzyMatch(x, '')` is
   * true for every x, a single empty string emptied the whole list. Extraction
   * explicitly asks the model for fuzzy text, so these are reached by an LLM's
   * paraphrase, not just by a careful caller.
   *
   * Same defect as remove_todos, which destroyed three of four cards from the
   * query "auth", and as resolveQuestion server-side. This is the one rule they
   * should all share, because four hand-written copies is how they drifted.
   *
   * Order: exact (normalized) text, then fuzzy — and fuzzy only counts when it
   * lands on EXACTLY ONE. A query matching nothing, or several fuzzily, removes
   * nothing. Blank queries are rejected rather than treated as match-everything.
   *
   * Several EXACT hits are different: every one of them has, by construction,
   * the same normalized text, so they are never ambiguous about WHICH item was
   * meant — only about which duplicate row holds it. Take the first, exactly as
   * resolveQuestion does server-side. Requiring unanimity here instead made a
   * case variant unresolvable forever and said nothing: uniqueStrings dedupes
   * with a case-SENSITIVE Set, so 'Ship auth' and 'ship auth' both persist, and
   * an extraction naming either removed NEITHER. That is this whole family's
   * failure — reporting success while doing nothing — reintroduced one level down.
   *
   * remove_todos deliberately keeps the stricter rule: its cards carry ids, so
   * two same-titled cards are two genuinely different things and picking one to
   * hard-delete would be a guess. Identity is the difference, not caution — these
   * three lists are keyed by their text alone (landmines dedupe by summary), so
   * same text means the same item.
   */
  const resolveRemovals = (items, queries, getText) => {
    const doomed = new Set();
    for (const raw of queries || []) {
      const q = String(raw ?? '').trim();
      if (!q) continue;
      const indexed = items.map((item, i) => ({ item, i })).filter(({ i }) => !doomed.has(i));
      const exact = indexed.filter(({ item }) => String(getText(item) ?? '').trim().toLowerCase() === q.toLowerCase());
      const hits = exact.length ? [exact[0]] : indexed.filter(({ item }) => fuzzyMatch(String(getText(item) ?? ''), q));
      if (hits.length === 1) doomed.add(hits[0].i);
    }
    return doomed.size ? items.filter((_, i) => !doomed.has(i)) : items;
  };
  let nextQuestions = current.open_questions || [];
  if (delta.open_questions?.length) {
    nextQuestions = uniqueStrings([
      ...(current.open_questions || []),
      ...delta.open_questions,
    ]).slice(-15);
  }
  if (delta.resolved_questions?.length) {
    nextQuestions = resolveRemovals(nextQuestions, delta.resolved_questions, (q) => q);
  }
  // LISTS ARE UNIONED, NEVER REPLACED.
  //
  // An extraction delta names what ONE conversation mentioned, not the whole
  // stored list — and sanitizeExtraction strips the items already stored before
  // the delta gets here. Replacing the list with the delta therefore turned
  // stored [G1,G2,G3] + model [G1,G4] into [G4]: one new goal deleted the rest.
  // A deliberate replace (the dashboard removing a goal) goes through
  // updateProjectContext, which never reaches this merge; removal from here is
  // completed_goals. Over the schema cap the oldest entries go, the same rule
  // open_questions has always used.
  const LIST_CAP = 15;
  const unionList = (stored, incoming) => {
    if (!incoming) return stored;
    const seen = new Set();
    const out = [];
    for (const value of uniqueStrings([...(stored || []), ...incoming])) {
      const key = value.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
    }
    return out.slice(-LIST_CAP);
  };
  let nextGoals = unionList(current.goals, delta.goals);
  if (delta.completed_goals?.length) {
    nextGoals = resolveRemovals(nextGoals || [], delta.completed_goals, (g) => g);
  }

  // Resolve decisions in place (single source of truth): mark, don't delete, so
  // they stay retrievable but are excluded from active context loads.
  let nextDecisions = cappedDecisions;
  if (delta.resolved_decisions?.length) {
    const resolvedAt = isoNow();
    nextDecisions = (nextDecisions || []).map((d) =>
      d && delta.resolved_decisions.some((r) => fuzzyMatch(d.summary, r))
        ? { ...d, resolved: true, resolved_at: d.resolved_at || resolvedAt }
        : d
    );
  }

  // Landmine merge: append + importance-aware dedupe by summary (mirrors
  // recent_decisions — keep the higher importance when the same landmine recurs),
  // then honor resolved_landmines removal, then normalize/cap to 20.
  let nextLandmines = current.landmines || [];
  if (delta.landmines?.length) {
    const importanceRanks = { critical: 0, high: 1, normal: 2, low: 3 };
    const byKey = new Map();
    for (const entry of [...(current.landmines || []), ...delta.landmines]) {
      if (!entry || !entry.summary) continue;
      const key = String(entry.summary).trim().toLowerCase();
      if (!key) continue;
      const existing = byKey.get(key);
      if (!existing) { byKey.set(key, entry); continue; }
      // Keep the higher (lower-rank-number) importance, preferring incoming fields
      // otherwise so fresh provenance/paths win.
      const existingRank = importanceRanks[existing.importance || 'high'] ?? 1;
      const incomingRank = importanceRanks[entry.importance || 'high'] ?? 1;
      const importance = incomingRank <= existingRank ? (entry.importance || 'high') : (existing.importance || 'high');
      // The incoming spread wins on every field EXCEPT the author: recording the
      // same landmine again sharpens it, it does not make the second person the
      // one who hit it. Same rule the decision merge applies above.
      const contributedBy = existing.contributed_by ?? entry.contributed_by ?? null;
      byKey.set(key, {
        ...existing,
        ...entry,
        importance,
        ...(contributedBy ? { contributed_by: contributedBy } : {}),
      });
    }
    nextLandmines = Array.from(byKey.values());
  }
  if (delta.resolved_landmines?.length) {
    nextLandmines = resolveRemovals(
      (nextLandmines || []).filter(Boolean),
      delta.resolved_landmines,
      (l) => l.summary
    );
  }
  nextLandmines = normalizeLandmines(nextLandmines);

  // Board merge: every card lives in todo_items with a phase. add_todos appends
  // (to Backlog, or a named column), move_todos re-columns, complete_todos is
  // shorthand for moving to Done, remove_todos hard-deletes. completed_todos is
  // legacy read-only — no longer written; the Done column reads it in on top of
  // todo_items(phase=done) for back-compat.
  const now = isoNow();
  let nextTodoItems = (current.todo_items || []).map(t => ({ ...t, phase: normalizeBoardPhase(t.phase) }));
  let nextCompletedTodos = [...(current.completed_todos || [])];
  if (delta.add_todos?.length) {
    const byTitle = new Map(nextTodoItems.map(t => [String(t.title || '').toLowerCase(), t]));
    // WHEN A CARD ADDED STRAIGHT INTO DONE WAS FINISHED. Stamping every such card
    // "now" made history outrank reality: the Done cap keeps the most recently
    // COMPLETED cards, so importing fifty old completions into a full Done column
    // evicted fifty of the importer's real ones. A caller that knows the real
    // completion time (a Trail import) passes it; the stamp is honoured when it
    // parses and is not in the future, and otherwise falls back to now.
    const nowMs = Date.parse(now);
    const suppliedCompletion = new Map();
    for (const raw of delta.add_todos) {
      if (!raw || typeof raw !== 'object' || typeof raw.completed_at !== 'string') continue;
      const ms = Date.parse(raw.completed_at);
      if (Number.isNaN(ms) || ms > nowMs) continue;
      const titleKey = String(raw.title ?? '').trim().toLowerCase();
      if (titleKey && !suppliedCompletion.has(titleKey)) suppliedCompletion.set(titleKey, new Date(ms).toISOString());
    }
    for (const entry of normalizeTaskCardInputs(delta.add_todos)) {
      const key = entry.title.toLowerCase();
      const existing = byTitle.get(key);
      if (existing) {
        // Re-adding a title already on the board stays the no-op it always was,
        // with one exception: an entry carrying a BODY sets that card's body.
        // Detail arrives after the card exists far more often than with it — a
        // card gets filed, then specced — and without this, a body could only
        // ever be written at creation time. It only ever ADDS detail: the card
        // keeps its id, its title and its column, and a body is never cleared
        // by an add that omits one.
        if (entry.body && entry.body !== existing.body) {
          const updated = { ...existing, body: entry.body, updated_at: now };
          nextTodoItems = nextTodoItems.map(t => (t.id === existing.id ? updated : t));
          byTitle.set(key, updated);
        }
        continue;
      }
      const phase = normalizeBoardPhase(entry.phase || DEFAULT_BOARD_PHASE);
      const card = applyHold({
        id: `todo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        title: entry.title,
        ...(entry.body ? { body: entry.body } : {}),
        ...(entry.assignee ? { assignee: entry.assignee } : {}),
        phase,
        created_at: now,
        updated_at: now,
        completed_at: phase === DONE_BOARD_PHASE ? (suppliedCompletion.get(key) || now) : null,
        held_by: null,
        held_at: null,
      }, phase, mergeSessionId, now);
      nextTodoItems.push(card);
      byTitle.set(key, card);
    }
  }
  if (delta.move_todos?.length) {
    for (const mv of delta.move_todos) {
      // A move may change the column, the assignee, or both. Only apply what was
      // ASKED for: normalizeBoardPhase turns an absent phase into Backlog, so
      // reading it unconditionally would silently drag a card out of whatever
      // column it was in every time somebody assigned it — a change nobody
      // requested, arriving as a side effect of an unrelated one.
      const wantsPhase = mv?.phase !== undefined && mv?.phase !== null;
      const wantsAssignee = Object.prototype.hasOwnProperty.call(mv || {}, 'assignee');
      // Exactly one card, or none: see resolveTaskCard. An ambiguous or unmatched
      // query moves nothing — a move is recoverable, but silently re-columning
      // every card that shares a word is not what anybody asked for.
      const resolved = resolveTaskCard(nextTodoItems, mv?.match);
      if (resolved.status !== 'matched') continue;
      nextTodoItems = nextTodoItems.map((t) => {
        if (t !== resolved.card) return t;
        const phase = wantsPhase ? normalizeBoardPhase(mv.phase) : t.phase;
        const moved = {
          ...t,
          phase,
          // null clears an assignment — "nobody is on this" is a real state and
          // has to be expressible, not only settable.
          ...(wantsAssignee ? { assignee: mv.assignee || null } : {}),
          updated_at: now,
          completed_at: phase === DONE_BOARD_PHASE ? (t.completed_at || now) : null,
        };
        return applyHold(moved, phase, mergeSessionId, now);
      });
    }
  }
  if (delta.complete_todos?.length) {
    const completing = new Set();
    for (const q of delta.complete_todos) {
      const resolved = resolveTaskCard(nextTodoItems, q);
      if (resolved.status === 'matched') completing.add(resolved.card);
    }
    nextTodoItems = nextTodoItems.map(t => completing.has(t) ? applyHold({
      ...t,
      phase: DONE_BOARD_PHASE,
      updated_at: now,
      completed_at: t.completed_at || now,
    }, DONE_BOARD_PHASE, mergeSessionId, now) : t);
  }
  // REMOVAL IS A HARD DELETE, so it resolves precisely. move/complete now use the
  // same rule (resolveTaskCard); they did not until 2026-09, and one query
  // completed every card containing it.
  //
  // It used to reuse matchCard, whose fallback is the bidirectional substring
  // fuzzyMatch above. One directive therefore destroyed every card whose title
  // merely CONTAINED the query: {remove_todos:['auth']} against "Fix the auth
  // redirect", "Rewrite auth middleware" and "Ship auth docs" left none of them,
  // and the tool reported removing "auth" — one name, taken from the request.
  // Worse, fuzzyMatch(title, '') is true for every title, so a single empty
  // string wiped the entire board. There is no context version table, so none of
  // it was recoverable.
  //
  // Resolution order per query: exact id, then exact (normalized) title, then
  // fuzzy — and fuzzy only counts when it lands on exactly ONE card. A query
  // that matches nothing, or matches several fuzzily, removes NOTHING and is
  // reported back so the caller can disambiguate. Empty queries are rejected
  // outright rather than treated as "matches everything".
  const removalOutcome = { removed: [], ambiguous: [], unmatched: [] };
  if (delta.remove_todos?.length) {
    // Same rule as resolveRemovals above, with one addition the others do not
    // need: a card can be addressed by its ID, which is exact by construction and
    // must win before any text matching. The outcome detail is kept because the
    // MCP tool reports what actually went, rather than echoing the request.
    const pool = [...nextTodoItems, ...nextCompletedTodos];
    const doomed = new Set();
    for (const raw of delta.remove_todos) {
      const resolved = resolveTaskCard(pool, raw);
      if (resolved.status === 'matched') {
        doomed.add(resolved.card.id);
        removalOutcome.removed.push({ id: resolved.card.id, title: resolved.card.title });
      } else if (resolved.status === 'ambiguous') {
        removalOutcome.ambiguous.push({ query: resolved.query, candidates: resolved.candidates });
      } else {
        removalOutcome.unmatched.push(resolved.query);
      }
    }
    if (doomed.size) {
      nextTodoItems = nextTodoItems.filter(t => !doomed.has(t.id));
      nextCompletedTodos = nextCompletedTodos.filter(t => !doomed.has(t.id));
    }
  }
  // OPEN WORK IS NEVER THE PRICE OF NEW WORK.
  //
  // The trim below used to make room for an incoming open card by deleting the
  // OLDEST open card on the board — not completed, not shipped, not searchable,
  // just gone — and every caller answered "Added … → backlog". That is the failure
  // the trim's own comment calls the worst this product has, reached on the one
  // path it said needed "300+ simultaneously open cards" (scan 19 reached it).
  //
  // So open cards are never evicted to fit another. If this merge would leave more
  // than MAX_TODO_ITEMS open, the cards it would have OPENED are refused as a
  // batch: a new card is not added, and a card being reopened out of Done stays in
  // Done exactly as it was. Every other part of the merge still applies. A caller
  // passing `options.outcome` is told what was refused and why; updateProjectContext
  // turns that into a refusal that writes nothing, and every other caller reports it.
  const openCountOf = (items) => items.filter(t => t.phase !== DONE_BOARD_PHASE).length;
  if (openCountOf(nextTodoItems) > MAX_TODO_ITEMS) {
    const priorById = new Map((current.todo_items || [])
      .map(t => [t.id, { ...t, phase: normalizeBoardPhase(t.phase) }]));
    const refusedOpen = [];
    nextTodoItems = nextTodoItems.flatMap((t) => {
      if (t.phase === DONE_BOARD_PHASE) return [t];
      const prior = priorById.get(t.id);
      if (prior && prior.phase !== DONE_BOARD_PHASE) return [t];
      refusedOpen.push({ title: t.title, phase: t.phase, ...(prior ? { reopened: true } : {}) });
      return prior ? [prior] : [];
    });
    if (options.outcome && typeof options.outcome === 'object' && refusedOpen.length) {
      options.outcome.refused_open = refusedOpen;
      options.outcome.open_count = openCountOf(nextTodoItems);
      options.outcome.open_limit = MAX_TODO_ITEMS;
    }
  }

  // Board trim. Completed work yields before open work, always.
  //
  // This did the exact OPPOSITE of its own comment until 2026-08-26. `active`
  // was concatenated FIRST, so `[...active, ...done].slice(-100)` dropped from
  // the FRONT — evicting the oldest OPEN cards while preserving every Done card.
  // Observed on the DeerDawn board itself at 73 done + 27 open: adding 3 cards
  // silently deleted the 3 oldest backlog cards. They were not marked complete
  // and surfaced nowhere. Silent loss of the user's open work is the worst
  // failure mode this product has.
  //
  // It then stayed subtly wrong until 2026-08-29, in a way that destroyed the
  // OTHER half. "Keep the newest Done" was implemented as "keep the tail of the
  // array", and array position is CREATION order, not completion order. A card
  // created in July and completed today sits near the FRONT of the array, so the
  // instant it was marked done it became the first thing trimmed — while genuinely
  // older completions that happened to be created later survived.
  //
  // Observed on the DeerDawn board at done = 100: three cards were completed in a
  // single call, all three vanished from EVERY phase, and the Done column was
  // byte-identical before and after. Nothing was evicted; the incoming completion
  // was the only casualty, and the write reported success. Ranking by
  // completed_at fixes it at the root: the card entering Done is by definition
  // the most recently completed, so it can never be the one dropped.
  //
  // Two independent bounds, in priority order:
  //   1. Done is capped at MAX_DONE_RETAINED, keeping the most recently COMPLETED.
  //      History is worth keeping, but never at the cost of a slot an open card
  //      needs.
  //   2. Only if the board STILL exceeds MAX_TODO_ITEMS — i.e. open cards alone
  //      overflow it — do open cards get trimmed, oldest first. The refusal above
  //      means no merge can push open cards over the limit any more, so this is
  //      reachable only from a stored board that was already over it; it stays as
  //      the last resort, and still reports what it took (evicted_open).
  const doneCards = nextTodoItems.filter(t => t.phase === DONE_BOARD_PHASE);
  // Done cards this trim pushes off the board: history, so their shipped lines stay.
  const evictedDoneIds = new Set();
  if (doneCards.length > MAX_DONE_RETAINED || nextTodoItems.length > MAX_TODO_ITEMS) {
    const active = nextTodoItems.filter(t => t.phase !== DONE_BOARD_PHASE);
    // Open cards are placed FIRST and take whatever room they need; Done gets
    // only what is left over, so it shrinks to zero before an open card is cut.
    const activeKept = active.slice(Math.max(0, active.length - MAX_TODO_ITEMS));
    const doneSlots = Math.max(0, Math.min(MAX_DONE_RETAINED, MAX_TODO_ITEMS - activeKept.length));
    // Rank by when the card was COMPLETED. completed_at is set on every path into
    // Done (add/move/complete all stamp it), but fall back through the card's own
    // timestamps for rows written before that was true, and treat an unparseable
    // stamp as oldest. sort() is stable, so a board with no usable timestamps at
    // all degrades to the previous insertion order rather than to something
    // arbitrary.
    const completedRank = (t) => {
      for (const stamp of [t.completed_at, t.updated_at, t.created_at]) {
        const ms = stamp ? Date.parse(stamp) : NaN;
        if (!Number.isNaN(ms)) return ms;
      }
      return 0;
    };
    const keptDoneIds = new Set(
      [...doneCards]
        .sort((a, b) => completedRank(a) - completedRank(b))
        .slice(Math.max(0, doneCards.length - doneSlots))
        .map(t => t.id)
    );
    // Re-emit in the board's existing order so retaining a card never reshuffles
    // the column around it — only the dropped rows change.
    const doneKept = doneSlots > 0 ? doneCards.filter(t => keptDoneIds.has(t.id)) : [];
    for (const card of doneCards) if (!doneKept.includes(card)) evictedDoneIds.add(card.id);
    // WHAT THE TRIM TOOK, SAID OUT LOUD. Ranking by completed_at stopped the
    // incoming card being the casualty, but the card that makes room for it is
    // still gone — and every caller answered "Marked complete" and nothing else.
    // A caller that passes `options.outcome` is told exactly which cards went,
    // so the reply can name them. Callers that pass nothing are unchanged.
    if (options.outcome && typeof options.outcome === 'object') {
      const keptActiveIds = new Set(activeKept.map(t => t.id));
      const keptDoneSet = new Set(doneKept.map(t => t.id));
      options.outcome.evicted_done = doneCards
        .filter(t => !keptDoneSet.has(t.id))
        .map(t => ({ id: t.id, title: t.title }));
      options.outcome.evicted_open = active
        .filter(t => !keptActiveIds.has(t.id))
        .map(t => ({ id: t.id, title: t.title, phase: t.phase }));
    }
    nextTodoItems = [...activeKept, ...doneKept];
  }

  // SHIPPED assembly. Two feeds, both deduped by summary into the newest-15 window:
  //   1. delta.shipped — structured completion events + LLM-proposed completions
  //      (already stamped with their trust confidence upstream).
  //   2. Board Done-transitions — any card that entered the Done column in THIS
  //      merge (present-and-done now, not done before). A user moving a card to Done
  //      is a real, confirmed completion, so it lands at confidence 1 (VERIFIED),
  //      the same trust as a structured task_completed event.
  const preDoneIds = new Set(
    (current.todo_items || [])
      .filter(t => normalizeBoardPhase(t.phase) === DONE_BOARD_PHASE)
      .map(t => t.id)
  );
  const shippedFromBoard = nextTodoItems
    .filter(t => t.phase === DONE_BOARD_PHASE && !preDoneIds.has(t.id))
    // Built field by field from the card, so the author has to be added here on
    // purpose — this entry is authored by the merge and inherits nothing.
    .map(t => ({
      summary: t.title,
      shipped_at: now,
      confidence: 1,
      // The line follows the card (followBoardCardsInShipped).
      card_id: t.id,
      ...(mergeContributor ? { contributed_by: mergeContributor } : {}),
    }));
  let nextShipped = current.shipped || [];
  const incomingShipped = [...(delta.shipped || []), ...shippedFromBoard];
  if (incomingShipped.length) {
    nextShipped = normalizeShipped([...(current.shipped || []), ...incomingShipped]);
  }
  // And it follows the card when the card moves back out of Done, is deleted or
  // renamed in this same merge. See followBoardCardsInShipped.
  nextShipped = followBoardCardsInShipped(nextShipped, {
    before: [...(current.todo_items || []), ...(current.completed_todos || []).map((t) => ({ ...t, phase: DONE_BOARD_PHASE }))],
    after: [...nextTodoItems, ...nextCompletedTodos.map((t) => ({ ...t, phase: DONE_BOARD_PHASE }))],
    evictedDoneIds,
  }).list;

  const next = {
    ...current,
    ...delta,
    // Category is sticky once a topic: a later extraction turn that (mis)classifies
    // it as 'coding' must not downgrade a life topic — that would re-enable coding
    // fields and disable topic enrichment. Coding→topic promotion is still allowed.
    category: current.category === 'topic' || delta.category === 'topic'
      ? 'topic'
      : (current.category || 'coding'),
    goals: nextGoals,
    recurring_context: unionList(current.recurring_context, delta.recurring_context),
    tech_stack: unionList(current.tech_stack, delta.tech_stack),
    file_structure_summary: unionList(current.file_structure_summary, delta.file_structure_summary),
    open_questions: nextQuestions,
    commands: mergedCommands,
    hot_paths: delta.hot_paths ? normalizeHotPaths([...(current.hot_paths || []), ...delta.hot_paths]) : current.hot_paths,
    entrypoints: delta.entrypoints ? normalizeEntrypoints([...(current.entrypoints || []), ...delta.entrypoints]) : current.entrypoints,
    surfaces: delta.surfaces ? normalizeSurfaces([...(current.surfaces || []), ...delta.surfaces]) : current.surfaces,
    debugging_notes: delta.debugging_notes ? normalizeDebuggingNotes([...(current.debugging_notes || []), ...delta.debugging_notes]) : current.debugging_notes,
    landmines: nextLandmines,
    shipped: nextShipped,
    recent_decisions: nextDecisions,
    source_summary: sourceSummary || delta.source_summary || current.source_summary,
    blocking_issue_set_at: nextBlockerSetAt(current, delta),
    last_updated: isoNow(),
    task_steps: delta.task_steps ? delta.task_steps.slice(0, 20) : current.task_steps,
    todo_items: nextTodoItems,
    completed_todos: nextCompletedTodos,
  };

  return ContextObjectSchema.parse(next);
}

function formatGlobalHeader(global, verbosity) {
  if (!global) return [];
  const prefs = (global.preferences || []).slice(0, verbosity === 'light' ? 2 : 4);
  const instructions = (global.recurring_instructions || []).slice(0, verbosity === 'light' ? 1 : 3);
  const lines = [];
  if (global.working_style) lines.push(`About me: ${global.working_style}`);
  else if (global.user_profile) lines.push(`About me: ${global.user_profile}`);
  if (verbosity !== 'light') {
    if ((global.expertise_areas || []).length > 0) lines.push(`Expertise: ${global.expertise_areas.join(', ')}`);
    if ((global.values || []).length > 0) lines.push(`Values: ${global.values.join(', ')}`);
    if ((global.goals || []).length > 0) lines.push(`Goals: ${global.goals.slice(0, 3).join(' | ')}`);
  }
  if (prefs.length > 0) lines.push(`My preferences: ${prefs.join(' | ')}`);
  if (instructions.length > 0) lines.push(`Always: ${instructions.join(' | ')}`);
  return trimLines(lines);
}

// Current wall-clock for the assistant. Server stamps `now` (ISO) per request so it
// is never cached/stale; the client passes its IANA `tz` so we can render local time.
// A bad/unknown tz falls back to UTC rather than throwing.
function buildNowLine(now, tz) {
  const date = new Date(now || NaN);
  if (Number.isNaN(date.getTime())) return null;
  if (tz) {
    try {
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
      });
      return `Now: ${fmt.format(date)} (${tz})`;
    } catch (_) { /* unknown tz → UTC fallback */ }
  }
  return `Now: ${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function openQuestionsLine(questions, verbosity) {
  const open = (Array.isArray(questions) ? questions : [])
    .filter((q) => typeof q === 'string' && q.trim())
    .slice(-3)
    .reverse();
  if (!open.length) return null;
  const each = proseBudget(verbosity, open.length === 1 ? 88 : 56);
  return `Open questions: ${open.map((q) => clipText(q, each)).join(' | ')}`;
}

// The call a brief's footer tells the model to make for the rest of it. It named
// `get_context`, which neither tools/list advertises — hosted or local — so a
// model following the footer called a tool it had never been shown (the same
// defect as the first-run copy that named update_context). recall with action
// "context" is the advertised route to the same read on both surfaces.
const FULL_CONTEXT_CALL = 'recall(action="context", sections=["all"])';

function formatConversationalInjection(context, verbosity = 'standard', global = null, options = {}) {
  const isTopic = context.category === 'topic';
  const recurring = selectConstraints(context.recurring_context || [], verbosity === 'detailed' ? 2 : 1);
  // Coding-only signal — irrelevant for a life topic, so don't render it there.
  const hotPaths = isTopic ? [] : formatPathEntries(rankHotPaths(context.hot_paths), verbosity === 'light' ? 1 : 2);
  // The newest three decisions plus anything pinned (see
  // buildBriefDecisionsSection). A stable verified marker rides on each (no
  // live timestamp, so it doesn't churn the dedup fingerprint).
  const decisionSection = buildBriefDecisionsSection(context, verbosity, 1);
  const isCritical = decisionSection.critical;
  const decisionText = decisionSection.line;
  const budget = (verbosity === 'light' ? 76 : verbosity === 'detailed' ? 250 : 195) + decisionSection.extraTokens;

  const sections = [
    buildSection('now', buildNowLine(options.now, options.tz), 0.5),
    buildSection('current_task', context.current_task && `Current task: ${clipText(context.current_task, proseBudget(verbosity, 88))}`, 1),
    // THE NEXT STEP, right after the task, as the coding-shaped brief has always
    // had it. The chat-shaped brief rendered none, so a ChatGPT or Claude.ai
    // session that had saved "next: call the landlord" opened on the task alone
    // and re-derived the cursor the save existed to keep. Same text, same
    // priority as formatCodeInjection's, so both shapes say it identically.
    buildSection('next_action', context.next_action && `Next action: ${clipText(context.next_action, proseBudget(verbosity, 88))}`, 1.05),
    buildSection('blocking', context.blocking_issue && `Blocking: ${clipText(context.blocking_issue, proseBudget(verbosity, 80))}`, 1.5),
    buildSection('current_status', context.current_status && `Current status: ${clipText(context.current_status, proseBudget(verbosity, 88))}${context.status_verified_at ? ' ✓ verified' : ''}`, 2),
    buildSection('hot_paths', hotPaths.length > 0 && `Hot paths: ${hotPaths.join(' | ')}`, 2.5),
    // Critical decisions get priority 1.2 so they always appear before status; others stay at 3
    buildSection('recent_decision', decisionText, isCritical ? 1.2 : 3),
    // OPEN QUESTIONS, at standard and detailed. start_session's description
    // promises them and this — the hosted brief — never rendered one: a question
    // filed with "Open question:" was stored, and the next session opened without
    // it. Newest first and at most three, like the `questions` section of
    // get_context, each clipped, so it cannot crowd out the task. Light stays the
    // tight-token mode and omits it. If the budget drops it, the omitted-sections
    // note names it, which is the model's cue to ask for it.
    buildSection('open_questions', verbosity !== 'light' && openQuestionsLine(context.open_questions, verbosity), 3.25),
    // After the project's OWN recent decision, before the constraint. Another
    // project's finding is worth real estate, but never ahead of this one's state.
    buildSection('related_projects', buildRelatedProjectsLine(options.related, verbosity), 3.5),
    buildSection('constraint', recurring.length > 0 && `Constraint: ${clipText(recurring[0], proseBudget(verbosity, 52))}`, 4),
    buildSection('project', `Project: ${neutralizeInjectedText(context.project_name)}`, 5),
    buildSection('global', buildBrowserGlobalLine(global, verbosity), 6),
    buildSection('description', context.description && `What it is: ${clipText(context.description, verbosity === 'light' ? 72 : 120)}`, 7),
  ];
  const selection = chooseSections(sections, budget);

  const lines = [...selection.lines];
  if (selection.droppedSections.length > 0) {
    lines.push(`[+${selection.droppedSections.length} section${selection.droppedSections.length > 1 ? 's' : ''} omitted (${selection.droppedSections.join(', ')}) — call ${FULL_CONTEXT_CALL} for full context]`);
  } else if (verbosity !== 'light' && lines.some((line) => line.includes('...'))) {
    // 'light' is the tight-token mode: the inline '...' already signals clipping,
    // so the ~20-token restatement is pure waste here (and blows the light budget).
    lines.push(`[Some fields are ellipsized. Call ${FULL_CONTEXT_CALL} for full context]`);
  }
  // Distinct from the budget notice above: that one says "ask me again", this
  // one says "you may not have it". Conflating them would send a member round
  // a retry loop that can never succeed.
  const withheldLine = formatWithheldSectionsLine(context);
  if (withheldLine) lines.push(withheldLine);

  const payload = InjectionPayloadSchema.parse({
    tool: 'claude_web',
    format: 'conversational',
    verbosity,
    body: lines.join('\n') || 'No context available.',
  });
  return defineMeta(payload, selection);
}

function formatCodeInjection(context, verbosity = 'standard', global = null, options = {}) {
  // A topic rendered in an IDE/CLI surface still suppresses coding-only fields.
  const isTopic = context.category === 'topic';
  const files = isTopic ? [] : selectRelevantFiles(
    context.file_structure_summary || [],
    verbosity === 'light' ? 2 : verbosity === 'detailed' ? 5 : 3,
    options.cwd || ''
  );
  const recurring = selectConstraints(context.recurring_context || [], verbosity === 'light' ? 1 : 2);
  const stack = isTopic ? [] : (context.tech_stack || []).slice(0, verbosity === 'light' ? 3 : 5);
  const hotPaths = isTopic ? [] : formatPathEntries(rankHotPaths(context.hot_paths), verbosity === 'light' ? 2 : 3);
  const entrypoints = isTopic ? [] : formatEntrypointEntries(context.entrypoints || [], verbosity === 'light' ? 1 : 2);
  // The newest three decisions plus anything pinned (buildBriefDecisionsSection).
  const decisionSectionCode = buildBriefDecisionsSection(context, verbosity, 1);
  const isCriticalCode = decisionSectionCode.critical;
  const decisionCodeText = decisionSectionCode.line;
  const budget = (verbosity === 'light' ? 76 : verbosity === 'detailed' ? 260 : 210) + decisionSectionCode.extraTokens;

  // Newest first. Captured commands are APPENDED (and the oldest evicted at 20),
  // so rendering from the head showed the three oldest forever and never the one
  // just confirmed.
  const cmds = isTopic ? [] : (context.commands || []).slice(-(verbosity === 'light' ? 1 : 3)).reverse();
  const cmdText = cmds.length > 0
    ? `Commands: ${cmds.map((c) => `${neutralizeInjectedText(c.label)}=${clipText(c.run, 48)}`).join(' | ')}`
    : null;

  const inProgressSteps = (context.task_steps || []).filter((s) => s.status === 'in_progress');
  const stepsText = inProgressSteps.length > 0
    ? `In progress: ${inProgressSteps.map((s) => neutralizeInjectedText(s.name)).join(', ')}`
    : null;

  const sections = [
    buildSection('now', buildNowLine(options.now, options.tz), 0.5),
    buildSection('current_task', context.current_task && `Current task: ${clipText(context.current_task, proseBudget(verbosity, 88))}`, 1),
    buildSection('next_action', context.next_action && `Next action: ${clipText(context.next_action, proseBudget(verbosity, 88))}`, 1.05),
    buildSection('in_progress', stepsText, 1.1),
    buildSection('blocking', context.blocking_issue && `Blocking: ${clipText(context.blocking_issue, proseBudget(verbosity, 80))}`, 1.5),
    buildSection('hot_paths', hotPaths.length > 0 && `Hot paths: ${hotPaths.join(' | ')}`, 1.75),
    buildSection('relevant_files', files.length > 0 && `Relevant files: ${files.map(neutralizeInjectedText).join(' | ')}`, 2),
    buildSection('entrypoints', entrypoints.length > 0 && `Entry points: ${entrypoints.join(' | ')}`, 2.25),
    buildSection('current_status', context.current_status && `Current status: ${clipText(context.current_status, proseBudget(verbosity, 88))}${context.status_verified_at ? ' ✓ verified' : ''}`, 3),
    buildSection('recent_decision', decisionCodeText, isCriticalCode ? 1.2 : 4),
    buildSection('related_projects', buildRelatedProjectsLine(options.related, verbosity), 4.5),
    buildSection('constraint', recurring.length > 0 && `Constraint: ${clipText(recurring[0], proseBudget(verbosity, 52))}`, 5),
    buildSection('project', context.project_name && `Project: ${neutralizeInjectedText(context.project_name)}`, 6),
    buildSection('global', buildCodeGlobalLine(global, verbosity), 7),
    buildSection('tech_stack', stack.length > 0 && `Tech stack: ${stack.map(neutralizeInjectedText).join(', ')}`, 8),
    buildSection('commands', cmdText, 9),
  ];
  const selection = chooseSections(sections, budget);

  const lines = [...selection.lines];
  if (selection.droppedSections.length > 0) {
    lines.push(`# [+${selection.droppedSections.length} section${selection.droppedSections.length > 1 ? 's' : ''} omitted (${selection.droppedSections.join(', ')}) — call ${FULL_CONTEXT_CALL} for full context]`);
  } else if (verbosity !== 'light' && lines.some((line) => line.includes('...'))) {
    // 'light' is the tight-token mode: the inline '...' already signals clipping,
    // so the ~20-token restatement is pure waste here (and blows the light budget).
    lines.push(`# Some fields are ellipsized. Call ${FULL_CONTEXT_CALL} for full context`);
  }
  // Same distinction as the conversational formatter: a budget drop is worth
  // retrying, a share-policy withholding is not.
  const withheldCodeLine = formatWithheldSectionsLine(context, { prefix: '# ' });
  if (withheldCodeLine) lines.push(withheldCodeLine);

  const payload = InjectionPayloadSchema.parse({
    tool: 'cursor',
    format: 'code',
    verbosity,
    body: lines.join('\n') || 'No context available.',
  });
  return defineMeta(payload, selection);
}

// ─── Brief injection (4-slot text shape — OPT-IN, ?shape=spine) ───────────────
//
// Renders the FOUR labeled brief slots (SHIPPED / DECIDED / OPEN / LANDMINE) as
// text, reusing buildBriefSpine() as the single source of truth. This is the
// product-voice "the brief" view; it is OPT-IN and does NOT change the default
// conversational/code injection text. Omit-not-fabricate: an empty slot is
// skipped entirely rather than rendered as an empty header. Per-field token
// budgets reuse clipText + proseBudget so a slot line is sized exactly like the
// existing formatters. Trust bands (high|inferred|unverified) are surfaced
// inline as a compact suffix so a guessed item never reads as a confirmed fact.
const TRUST_TAG = { inferred: ' ~inferred', unverified: ' ?unverified' };

function trustSuffix(trust) {
  // 'high' is the clean default — no tag (a confirmed fact carries no caveat).
  return TRUST_TAG[trust] || '';
}

function formatBriefInjection(context, verbosity = 'standard', global = null, options = {}) {
  const ctx = context || {};
  const spine = buildBriefSpine(ctx, global, { now: options.now, tz: options.tz });
  // How many items each slot shows, scaled by verbosity — matches the tight/full
  // posture of the other formatters (light is token-frugal; detailed shows more).
  const perSlot = verbosity === 'light' ? 2 : verbosity === 'detailed' ? 6 : 4;
  const lineBudget = proseBudget(verbosity, 80);

  const renderItem = (item, prefix = '  - ') => {
    const base = `${prefix}${clipText(item.text, lineBudget)}`;
    const importanceTag = item.importance === 'critical' ? ' ⚠ critical' : '';
    return `${base}${importanceTag}${trustSuffix(item.trust)}`;
  };

  const slots = [];

  // SHIPPED — current_status header (if present) then the deterministic shipped[].
  const shippedLines = [];
  if (spine.shipped_header) {
    shippedLines.push(`  ${clipText(spine.shipped_header.text, proseBudget(verbosity, 88))}${spine.shipped_header.verified ? ' ✓ verified' : ''}`);
  }
  for (const item of spine.shipped.slice(0, perSlot)) shippedLines.push(renderItem(item));
  if (shippedLines.length) slots.push(`SHIPPED\n${shippedLines.join('\n')}`);

  // DECIDED
  if (spine.decided.length) {
    const lines = spine.decided.slice(0, perSlot).map((item) => {
      const importanceTag = item.importance === 'critical' ? ' ⚠ critical' : (item.importance === 'high' ? ' ★ important' : '');
      const because = item.reasoning ? ` (because: ${clipText(item.reasoning, proseBudget(verbosity, 64))})` : '';
      return `  - ${clipText(item.text, lineBudget)}${importanceTag}${trustSuffix(item.trust)}${because}`;
    });
    slots.push(`DECIDED\n${lines.join('\n')}`);
  }

  // OPEN
  if (spine.open.length) {
    // Newest first. The list evicts its OLDEST entry at the cap, so rendering
    // from the head showed exactly the questions about to be dropped and never
    // the one just asked.
    const lines = spine.open.slice(-perSlot).reverse().map((item) => `  - ${clipText(item.text, lineBudget)}`);
    slots.push(`OPEN\n${lines.join('\n')}`);
  }

  // LANDMINE
  if (spine.landmine.length) {
    const lines = spine.landmine.slice(0, perSlot).map((item) => {
      const paths = item.paths && item.paths.length ? ` [${item.paths.map(neutralizeInjectedText).join(' | ')}]` : '';
      const importanceTag = item.importance === 'critical' ? ' ⚠ critical' : '';
      return `  - ${clipText(item.text, lineBudget)}${importanceTag}${trustSuffix(item.trust)}${paths}`;
    });
    slots.push(`LANDMINE\n${lines.join('\n')}`);
  }

  const header = ctx.project_name ? `Brief — ${neutralizeInjectedText(ctx.project_name)}` : 'Brief';
  // "No brief captured yet" is a claim about the PROJECT, and it is false when
  // the slots are empty only because the share policy emptied them. Say which
  // it is; a member who believes the project is blank rewrites it.
  const withheldLine = formatWithheldSectionsLine(ctx);
  const emptyBody = withheldLine || 'No brief captured yet.';
  const body = slots.length
    ? `${header}\n\n${slots.join('\n\n')}${withheldLine ? `\n\n${withheldLine}` : ''}`
    : `${header}\n\n${emptyBody}`;

  return InjectionPayloadSchema.parse({
    tool: 'claude_code',
    format: 'code',
    verbosity,
    body,
  });
}

function cleanSubagentBriefText(value, maxChars) {
  const clean = neutralizeInjectedText(redactSecretText(String(value || '').trim()));
  return maxChars ? clipText(clean, maxChars) : clean;
}

function dedupeSubagentBriefItems(items = []) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item?.text) continue;
    const text = cleanSubagentBriefText(item.text, 240);
    const path = item.path ? cleanSubagentBriefText(item.path, 220) : '';
    // A path is the identity for path candidates. The same file frequently
    // arrives once from hot_paths and again from graph inference; keep the
    // highest-ranked first occurrence instead of spending budget twice.
    const key = item.kind === 'path' && path
      ? `path:${path.toLowerCase()}`
      : `${String(item.kind || '')}:${text.toLowerCase()}:${path.toLowerCase()}`;
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...item, text, ...(path ? { path } : {}) });
  }
  return out;
}

/**
 * Format a task-scoped, spawn-ready worker prompt. The caller supplies ranked
 * candidates; this pure function owns sanitization, deterministic ordering, and
 * the hard packaging budget. Four chars/token is deliberately conservative and
 * provider-neutral — estimated_tokens is an estimate, never a billing claim.
 */
function formatSubagentBrief(input = {}) {
  const request = SubagentBriefRequestSchema.parse(input);
  const projectId = String(input.project_id || '').trim();
  const projectName = cleanSubagentBriefText(input.project_name || 'Current project', 120);
  if (!projectId) throw new Error('project_id required');

  const maxTokens = request.max_tokens;
  const maxChars = maxTokens * 4;
  const footer = '\n\nReturn:\n- Findings or changes, verification performed, and unresolved questions; no broad project recap.';
  const objective = cleanSubagentBriefText(request.task, Math.max(120, Math.min(420, maxChars - 180)));
  const lines = [SUBAGENT_BRIEF_MARKER, `Project: ${projectName}`, `Objective: ${objective}`];
  let body = lines.join('\n');
  let omittedCount = 0;
  const selectedSources = [];

  const roomFor = (block) => body.length + block.length + footer.length <= maxChars;
  const addBlock = (block) => {
    if (!block || !roomFor(block)) return false;
    body += block;
    return true;
  };
  const startedSections = new Set();
  const addSectionItem = (title, line) => {
    const block = startedSections.has(title)
      ? `\n${line}`
      : `\n\n${title}:\n${line}`;
    if (!addBlock(block)) return false;
    startedSections.add(title);
    return true;
  };

  if (request.role && !addBlock(`\nRole: ${cleanSubagentBriefText(request.role, 100)}`)) omittedCount += 1;
  if (request.deliverable && !addBlock(`\nDeliverable: ${cleanSubagentBriefText(request.deliverable, 220)}`)) omittedCount += 1;

  if (request.acceptance_criteria.length) {
    for (const criterion of request.acceptance_criteria) {
      const line = `- ${cleanSubagentBriefText(criterion, 180)}`;
      if (!addSectionItem('Success', line)) omittedCount += 1;
    }
  }

  // NO SINGLE RETRIEVED LINE MAY EAT THE BUDGET. The fixed clips below are right
  // for an ordinary brief and far too generous for a small one: at max_tokens
  // 140 a 220-character decision is nearly half of everything the worker gets,
  // and the paths it needs then do not fit beside it. A share of the budget,
  // never above the fixed clip, and never so small the line stops being a
  // sentence.
  const itemClip = (fixed) => Math.max(80, Math.min(fixed, Math.floor(maxChars * 0.18)));

  const sectionSpecs = [
    ['Know', dedupeSubagentBriefItems(input.knowledge || [])],
    ['Work here', dedupeSubagentBriefItems(input.paths || [])],
    ['Watch', dedupeSubagentBriefItems(input.watchouts || [])],
    ['Verify', dedupeSubagentBriefItems(input.verification_items || [])],
  ];

  for (const [title, items] of sectionSpecs) {
    for (const item of items) {
      const detail = item.path && item.path !== item.text
        ? `${item.path} — ${item.text}`
        : item.text;
      const line = `- ${cleanSubagentBriefText(detail, itemClip(title === 'Work here' ? 260 : 220))}`;
      if (addSectionItem(title, line)) {
        selectedSources.push(SubagentBriefSourceSchema.parse(item));
      } else {
        omittedCount += 1;
      }
    }
  }

  // Explicit verification belongs in the same final section, after retrieved
  // commands. It remains caller-authored and therefore carries explicit source.
  for (const command of request.verification) {
    const line = `- ${cleanSubagentBriefText(command, 200)}`;
    if (addSectionItem('Verify', line)) {
      selectedSources.push({ kind: 'explicit', text: cleanSubagentBriefText(command, 200) });
    } else {
      omittedCount += 1;
    }
  }

  body += footer;
  // A very small budget plus unusually long project/task text can still exceed
  // the target before optional packing. Trim the objective once, never the marker
  // or return contract, so the result remains recognizable and actionable.
  if (body.length > maxChars) {
    const overflow = body.length - maxChars;
    const clippedObjective = cleanSubagentBriefText(objective, Math.max(80, objective.length - overflow - 1));
    body = body.replace(`Objective: ${objective}`, `Objective: ${clippedObjective}`);
  }

  return SubagentBriefResultSchema.parse({
    version: 1,
    marker: SUBAGENT_BRIEF_MARKER,
    text: body,
    project_id: projectId,
    project_name: projectName,
    context_updated_at: input.context_updated_at || null,
    generated_at: input.generated_at || isoNow(),
    estimated_tokens: Math.max(1, Math.ceil(body.length / 4)),
    max_tokens: maxTokens,
    omitted_count: omittedCount,
    sources: selectedSources,
  });
}

function formatGlobalOnlyInjection(global, verbosity = 'standard') {
  const prefs = (global.preferences || []).slice(0, verbosity === 'light' ? 2 : 5);
  const instructions = (global.recurring_instructions || []).slice(0, verbosity === 'light' ? 2 : 5);
  const stack = (global.global_stack || []).slice(0, 6);
  const profileLines = formatGlobalHeader(global, verbosity);
  const lines = trimLines([
    ...profileLines,
    prefs.length > 0 && `Preferences: ${prefs.join(' | ')}`,
    instructions.length > 0 && `Always: ${instructions.join(' | ')}`,
    stack.length > 0 && `Default stack: ${stack.join(', ')}`,
  ]);
  const budget = verbosity === 'light' ? 70 : 200;

  return InjectionPayloadSchema.parse({
    tool: 'claude_web',
    format: 'conversational',
    verbosity,
    body: fitLinesToBudget(lines, budget).join('\n') || 'No global context set.',
  });
}

// ─── Map injection (Tier 1 — always injected, flat cost) ─────────────────────

/**
 * Produces a compact multi-project index (~30-80 tokens).
 * MCP variant: tells the AI it can call get_context for targeted sections.
 * File variant: includes inline key-facts since the AI can't retrieve more.
 */
function formatMapInjection(projects = [], global = null, { mcpAvailable = false, activeProjectId = null, now = null, tz = null } = {}) {
  const count = projects.length;
  const nowLine = buildNowLine(now, tz);
  if (count === 0 && !global) {
    return nowLine ? `[DeerDawn] No brief ready yet.\n${nowLine}` : '[DeerDawn] No brief ready yet.';
  }

  const lines = [];
  lines.push(`[DeerDawn — ${count} project${count !== 1 ? 's' : ''}]`);
  if (nowLine) lines.push(nowLine);

  for (const p of projects.slice(0, 5)) {
    const ctx = p.context || {};
    const id = p.project_id || '';
    const ago = p.updated_at ? timeAgo(p.updated_at) : '';
    const taskSnip = ctx.current_task ? clipText(ctx.current_task, 50) : null;
    const stack = ctx.category === 'topic' ? '' : neutralizeInjectedText((ctx.tech_stack || []).slice(0, 3).join(','));
    const isActive = activeProjectId && id === activeProjectId;
    const projectName = neutralizeInjectedText(ctx.project_name || p.project_name);

    if (mcpAvailable) {
      // Compact reference — AI calls get_context for details
      // → prefix marks the CWD-matched project so the AI doesn't have to guess
      const topics = [taskSnip, stack, ago].filter(Boolean).join(' · ');
      const prefix = isActive ? '→' : '•';
      lines.push(`${prefix} ${projectName} (${id})${topics ? ': ' + topics : ''}`);
    } else {
      // Inline facts — AI reads them directly
      const parts = [];
      if (taskSnip) parts.push(`task=${taskSnip}`);
      if (ctx.current_status) parts.push(`status=${clipText(ctx.current_status, 40)}`);
      if (stack) parts.push(`stack=${stack}`);
      if (ago) parts.push(ago);
      lines.push(`${projectName}: ${parts.join(' · ')}`);

      // First recent decision with reasoning
      const dec = (ctx.recent_decisions || []).filter((d) => d && !d.resolved)[0];
      if (dec) {
        const decText = dec.reasoning
          ? `${clipText(dec.summary, 55)} (because: ${clipText(dec.reasoning, 40)})`
          : clipText(dec.summary, 70);
        lines.push(`  decision: ${decText}`);
      }
    }
  }

  // Global user line
  if (global) {
    const prefs = (global.preferences || []).slice(0, 3);
    const gstack = neutralizeInjectedText((global.global_stack || []).slice(0, 3).join('/'));
    const userParts = [
      global.user_profile ? clipText(global.user_profile, 60) : null,
      gstack || null,
      prefs.length ? neutralizeInjectedText(prefs.join(' | ')) : null,
    ].filter(Boolean);
    if (userParts.length) lines.push(`You: ${userParts.join(' · ')}`);
  }

  if (mcpAvailable) {
    lines.push('→ Call get_context(project_id?, sections?) for details');
    lines.push('  Sections: task | status | decisions | stack | files | hot_paths | entrypoints | surfaces | debugging_notes | goals | questions | todos | all');
    if (activeProjectId) {
      lines.push(`  → marks the active project for this directory`);
    }
  }

  return lines.join('\n');
}

// ─── Withheld sections (share policy) ────────────────────────────────────────
//
// Every renderer below omits an empty section rather than printing an empty
// header ("omit-not-fabricate"), which is right for a section nobody has
// written. It is WRONG for a section a teammate's share policy is withholding:
// the two look identical on the wire, so a member reading a narrowly-shared
// project was told the project was blank when it was merely filtered. The
// obvious response to a blank brief is to write it all down again, so the
// privacy control was quietly manufacturing duplicate, diverging history.
//
// The API stamps `withheld_sections` (names only, never values) onto a
// section-filtered context; these helpers turn it into one honest line. Same
// idiom as coordination.formatExcludedLine: say what is being held back and by
// what, or say nothing at all.
const WITHHELD_SECTION_LABELS = {
  description: 'description',
  current_task: 'current task',
  current_status: 'status',
  goals: 'goals',
  open_questions: 'open questions',
  recent_decisions: 'decisions',
  tech_stack: 'stack',
  file_structure_summary: 'files',
  blocking_issue: 'blocking issue',
  task_progress: 'progress',
  recurring_context: 'constraints',
  source_summary: 'source summary',
  hot_paths: 'hot paths',
  entrypoints: 'entry points',
  surfaces: 'surfaces',
  debugging_notes: 'debugging notes',
  landmines: 'landmines',
  shipped: 'shipped',
  todo_items: 'task board',
};

/** The withheld section names on a context, as human labels. Empty when none. */
function withheldSectionLabels(context) {
  const withheld = Array.isArray(context?.withheld_sections) ? context.withheld_sections : [];
  return withheld
    .map((section) => WITHHELD_SECTION_LABELS[section] || String(section || '').replace(/_/g, ' ').trim())
    .filter(Boolean);
}

/**
 * One line naming what this reader's share policy withheld, or null.
 * @param {object} context a (possibly section-filtered) project context
 * @param {{prefix?: string}} [options] `prefix` for comment-syntax formats
 */
function formatWithheldSectionsLine(context, { prefix = '' } = {}) {
  const labels = withheldSectionLabels(context);
  if (!labels.length) return null;
  // "Not empty" is the load-bearing half of this sentence — it is the whole
  // reason the line exists. Naming the author is the actionable half.
  return `${prefix}Not shared with you: ${labels.join(', ')}. `
    + 'These are withheld by this project\'s share policy, not empty — ask its author to widen the share.';
}

// ─── Section injection (Tier 2 — on-demand retrieval) ────────────────────────

const SECTION_DECISION_MAX = 240;

// clipText neutralises as well as clips, so every branch here is safe to print.
function sectionDecisionText(decision) {
  const summary = String(decision?.summary || '').replace(/\s+/g, ' ').trim();
  if (summary.length <= SECTION_DECISION_MAX) return clipText(summary, SECTION_DECISION_MAX);
  const headline = String(decision?.headline || '').replace(/\s+/g, ' ').trim();
  return clipText(headline || summary, SECTION_DECISION_MAX);
}

// Hot paths are stored in append order, and every surface rendered them with
// slice(0, N): the N OLDEST, forever. normalizeHotPaths already honours
// `pinned`/`importance` when it decides what survives the cap of 40 — but a path
// that survives eviction and then never renders has been kept for nobody. Same
// priority function, applied at read time. The sort is stable, so entries with
// no hints (everything written before the hints existed, and most things since)
// keep exactly the order they had.
function rankHotPaths(entries = []) {
  return (entries || [])
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (entryPriority(b.entry) - entryPriority(a.entry)) || (a.index - b.index))
    .map((item) => item.entry);
}

const SECTION_MAP = {
  task:        (ctx) => ctx.current_task   ? `Task: ${neutralizeInjectedText(ctx.current_task)}` : null,
  status:      (ctx) => ctx.current_status ? `Status: ${neutralizeInjectedText(ctx.current_status)}` : null,
  description: (ctx) => ctx.description   ? `About: ${neutralizeInjectedText(ctx.description)}` : null,
  blocking:    (ctx) => ctx.blocking_issue ? `Blocking: ${neutralizeInjectedText(ctx.blocking_issue)}` : null,
  progress:    (ctx) => {
    // Steps are no longer listed here — task_steps are folded into the task board
    // (the `todos`/`board` section) so there's one task surface, not two.
    const parts = [];
    if (ctx.next_action) parts.push(`Next action: ${neutralizeInjectedText(ctx.next_action)}`);
    if (ctx.task_progress) parts.push(`Progress: ${neutralizeInjectedText(ctx.task_progress)}`);
    return parts.length ? parts.join('\n') : null;
  },
  decisions:   (ctx) => {
    // MUST rank, not slice. recent_decisions is append-ordered, so slice(0, 3)
    // returns the THREE OLDEST decisions and keeps returning them forever — a
    // project with twenty decisions permanently briefs its first three. That is
    // how a brief ends up confidently describing last month. selectRecentDecisions
    // is the shared ranker (importance, then genuine-date, then recency).
    const d = selectRecentDecisions((ctx.recent_decisions || []).filter((x) => x && !x.resolved), 3);
    if (!d.length) return null;
    // Clipped, because `summary` is frequently not a summary. Sampled 2026-08-28
    // at 846 to over 4,000 characters — a whole session's write-up filed as one
    // decision — and this section printed all of it, three times over, into a
    // call whose entire purpose is to be the cheap targeted read. A summary that
    // fits is printed whole; one that does not gives way to its stored headline,
    // and rows written before headlines existed get a flat 240-char cut.
    const lines = d.map((x) => {
      const text = sectionDecisionText(x);
      return x.reasoning
        ? `  - ${text} (because: ${clipText(x.reasoning, SECTION_DECISION_MAX)})`
        : `  - ${text}`;
    });
    // SAY THAT THERE ARE MORE. Three of twenty rendered exactly like three of
    // three, so a targeted read of this section was indistinguishable from a
    // project that had only ever decided three things — and the caller had no
    // reason to look further, which is the whole risk of a bounded read that
    // does not name its bound. Every other bounded surface here already says
    // "+N more"; this one was silent.
    const held = (ctx.recent_decisions || []).filter((x) => x && !x.resolved).length - d.length;
    if (held > 0) {
      lines.push(`  …+${held} more ${held === 1 ? 'decision' : 'decisions'}: use recall with action "search", or verbosity "detailed".`);
    }
    return `Decisions:\n${lines.join('\n')}`;
  },
  stack:  (ctx) => (ctx.tech_stack || []).length ? `Stack: ${ctx.tech_stack.map(neutralizeInjectedText).join(', ')}` : null,
  // NEWEST FIRST, like open_questions and commands.
  //
  // The union merge appends, so the newest entry is at the TAIL of each of
  // these three lists — and each of them took the head. With four goals stored,
  // a fifth added today rendered nowhere at all: the brief kept briefing the
  // goals the project opened with, which reads exactly like a dropped write.
  files:  (ctx) => (ctx.file_structure_summary || []).length ? `Files: ${ctx.file_structure_summary.slice(-8).reverse().map(neutralizeInjectedText).join(' | ')}` : null,
  hot_paths: (ctx) => (ctx.hot_paths || []).length ? `Hot paths:\n${rankHotPaths(ctx.hot_paths).slice(0, 6).map((entry) => `  - ${neutralizeInjectedText(entry.label)}: ${neutralizeInjectedText(entry.path)}${entry.purpose ? ` — ${neutralizeInjectedText(entry.purpose)}` : ''}`).join('\n')}` : null,
  entrypoints: (ctx) => (ctx.entrypoints || []).length ? `Entry points:\n${ctx.entrypoints.slice(0, 6).map((entry) => `  - ${neutralizeInjectedText(entry.label)}: ${neutralizeInjectedText(entry.path)}${entry.purpose ? ` — ${neutralizeInjectedText(entry.purpose)}` : ''}`).join('\n')}` : null,
  surfaces: (ctx) => (ctx.surfaces || []).length ? `Surfaces:\n${ctx.surfaces.slice(0, 4).map((entry) => `  - ${neutralizeInjectedText(entry.label)}: ${(entry.paths || []).slice(0, 3).map(neutralizeInjectedText).join(' | ')}${entry.purpose ? ` — ${neutralizeInjectedText(entry.purpose)}` : ''}`).join('\n')}` : null,
  debugging_notes: (ctx) => (ctx.debugging_notes || []).length ? `Debugging notes:\n${ctx.debugging_notes.slice(-5).reverse().map((entry) => `  - ${neutralizeInjectedText(entry.summary)}${entry.paths?.length ? ` [${entry.paths.map(neutralizeInjectedText).join(' | ')}]` : ''}${entry.commit_ref || entry.diff_ref ? ` (fix: ${neutralizeInjectedText(entry.commit_ref || entry.diff_ref)})` : ''}`).join('\n')}` : null,
  landmines: (ctx) => (ctx.landmines || []).length ? `Landmines:\n${ctx.landmines.slice(-6).reverse().map((entry) => `  - ${neutralizeInjectedText(entry.summary)}${entry.paths?.length ? ` [${entry.paths.map(neutralizeInjectedText).join(' | ')}]` : ''}${entry.importance === 'critical' ? ' ⚠ critical' : ''}`).join('\n')}` : null,
  shipped: (ctx) => (ctx.shipped || []).length ? `Shipped:\n${ctx.shipped.slice(-6).reverse().map((entry) => `  - ${neutralizeInjectedText(entry.summary)}${entry.commit_ref ? ` (${neutralizeInjectedText(entry.commit_ref)})` : ''}`).join('\n')}` : null,
  goals:  (ctx) => (ctx.goals || []).length ? `Goals:\n${ctx.goals.slice(-4).reverse().map(g => `  - ${neutralizeInjectedText(g)}`).join('\n')}` : null,
  questions: (ctx) => (ctx.open_questions || []).length ? `Open questions:\n${ctx.open_questions.slice(-3).reverse().map(q => `  - ${neutralizeInjectedText(q)}`).join('\n')}` : null,
  constraints: (ctx) => (ctx.recurring_context || []).length ? `Constraints: ${ctx.recurring_context.slice(-3).reverse().map(neutralizeInjectedText).join(' | ')}` : null,
  todos: (ctx) => {
    const columns = buildTaskBoard(ctx);
    const total = columns.reduce((n, c) => n + c.cards.length, 0);
    if (!total) return null;
    // Render as a phased board so every AI session reads which column each task
    // sits in — not just a flat "done / not done" list.
    const lines = ['Task board:'];
    for (const col of columns) {
      if (!col.cards.length) continue;
      lines.push(`  ${col.label} (${col.cards.length}):`);
      const cap = col.phase === DONE_BOARD_PHASE ? 5 : 12;
      const shown = col.phase === DONE_BOARD_PHASE ? col.cards.slice(-cap) : col.cards.slice(0, cap);
      for (const t of shown) {
        const when = col.phase === DONE_BOARD_PHASE && t.completed_at ? ` (${t.completed_at.slice(0, 10)})` : '';
        // The marker, never the body. A brief that inlined card detail would be
        // the same token blowout the board listing already has.
        lines.push(`    - ${neutralizeInjectedText(t.title)}${when}${t.body ? TASK_BODY_MARKER : ''}`);
      }
      if (col.cards.length > cap) lines.push(`    …+${col.cards.length - cap} more`);
    }
    return lines.join('\n');
  },
};

/**
 * Group a project's todo cards into ordered board columns. The single source of
 * truth for the board shape — used by brief formatting, the API, and the
 * dashboard so all three render identical column state. Legacy completed_todos
 * (pre-board projects) are folded into the Done column.
 */
// task_steps (the LLM-extracted sub-steps of the CURRENT task) map onto board
// columns so the board is the single task surface — no separate "Steps" list.
const STEP_STATUS_TO_PHASE = { todo: 'backlog', in_progress: 'in_progress', done: 'done' };

function buildTaskBoard(context) {
  const ctx = context || {};
  const byPhase = new Map(BOARD_PHASES.map((p) => [p, []]));
  for (const item of ctx.todo_items || []) {
    const phase = normalizeBoardPhase(item.phase);
    byPhase.get(phase).push({ ...item, phase });
  }
  // Fold legacy completed_todos into Done, skipping any already present by id.
  const doneCol = byPhase.get(DONE_BOARD_PHASE);
  const seenIds = new Set(doneCol.map((t) => t.id));
  for (const item of ctx.completed_todos || []) {
    if (seenIds.has(item.id)) continue;
    doneCol.push({ ...item, phase: DONE_BOARD_PHASE });
    seenIds.add(item.id);
  }
  // Fold the current task's steps in as derived, read-only cards (kind:'step').
  // They are dedup'd against real cards by title and never persisted — they're a
  // live projection of task_steps, which extraction still owns wholesale.
  const titles = new Set();
  for (const col of byPhase.values()) for (const c of col) titles.add(String(c.title || '').toLowerCase());
  (ctx.task_steps || []).forEach((step, i) => {
    const title = String(step?.name || '').trim();
    if (!title || titles.has(title.toLowerCase())) return;
    const phase = STEP_STATUS_TO_PHASE[step?.status] || DEFAULT_BOARD_PHASE;
    byPhase.get(phase).push({
      id: `step-${i}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`,
      title,
      phase,
      kind: 'step',
      created_at: ctx.last_updated || undefined,
      completed_at: phase === DONE_BOARD_PHASE ? (ctx.last_updated || undefined) : null,
    });
    titles.add(title.toLowerCase());
  });
  return BOARD_PHASES.map((phase) => ({
    phase,
    label: BOARD_PHASE_LABELS[phase],
    cards: byPhase.get(phase),
  }));
}

/** Build the compact, presentation-ready shape shared by chat and CLI views. */
function buildTaskBoardSnapshot(context, project = {}) {
  const board = buildTaskBoard(context);
  const counts_by_phase = Object.fromEntries(board.map((column) => [column.phase, column.cards.length]));
  const total_cards = board.reduce((total, column) => total + column.cards.length, 0);
  const done_cards = counts_by_phase[DONE_BOARD_PHASE] || 0;
  return {
    project_id: project.project_id || context?.project_id || undefined,
    project_name: project.project_name || context?.project_name || 'Project',
    board,
    counts_by_phase,
    total_cards,
    open_cards: total_cards - done_cards,
  };
}

/**
 * The line a returning user sees when every project they have is archived.
 *
 * Archived projects are filtered out of listProjects and can never resolve as
 * active, so without this the brief reads as an empty "no context yet" — the
 * exact "your AI forgot everything" moment DeerDawn exists to prevent. Their
 * memory is intact; say so, name it, and give the one call that brings it back.
 */
function formatArchivedProjectsNotice(archived) {
  if (!Array.isArray(archived) || !archived.length) return '';
  const shown = archived.slice(0, 5);
  const lines = archived.length === 1
    ? [`Nothing active right now — but "${shown[0].project_name}" is archived, not gone.`]
    : [`Nothing active right now — but ${archived.length} archived projects are waiting, not gone:`];
  if (archived.length > 1) {
    for (const project of shown) lines.push(`  • ${project.project_name}`);
    if (archived.length > shown.length) lines.push(`  … and ${archived.length - shown.length} more`);
  }
  lines.push('');
  lines.push(archived.length === 1
    ? `Everything it remembered is still there. Restore it with manage_projects(action:"restore", project_id:"${shown[0].project_id}").`
    : 'Everything they remembered is still there. Restore one with manage_projects(action:"restore", project_id:"…") — call recall(action:"projects") for the IDs.');
  return lines.join('\n');
}

// How many archived projects the listing prints by name and id. The rest are
// counted, never dropped silently.
const LISTING_ARCHIVED_SHOWN = 25;

// How many archived projects a caller asks for when it needs the whole set: the
// cap GET /api/v1/context/projects?archived=1&limit= already applies, and the
// page the local name resolver reads. A display that is cut at 10 and then
// counted says "10 archived projects" to somebody who has 14.
const ARCHIVED_PROJECTS_FETCH_LIMIT = 500;

const NO_PROJECTS_LISTING = 'No projects yet. Use manage_projects with action "create" to create one.';

function archivedDay(value) {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
}

/**
 * THE PROJECT LISTING, recall(action:"projects"), for BOTH dispatchers.
 *
 * start_session tells somebody whose projects were archived (the nightly job
 * archives after 30 idle days) that they are "waiting, not gone", and sends the
 * assistant here for the ids. This listing used to enumerate live projects only
 * and answer "No projects yet. Use manage_projects with action "create"", so an
 * assistant doing exactly what it was told created a new, EMPTY project beside
 * the archived one and the session started cold: the one failure the product
 * exists to prevent. It now lists what it was sent for: each archived project,
 * marked archived, with its id and the call that restores it. "No projects yet"
 * is said only to somebody who has none, live or archived.
 *
 * `tree` is the live listing as both dispatchers already read it (roots with a
 * `subprojects` array); `archived` is the archived summary feed. Both are
 * visibility-filtered by the API before they get here; this only renders.
 * Rendering lives here, not in either dispatcher, so the hosted and the local
 * server cannot say different things (see mcp-dispatcher-parity.test.js).
 *
 * Returns { text, data }. `data` is the hosted reply's structuredContent: the
 * `projects` array exactly as before, plus, only when there are archived
 * projects, `archived_projects` (the same ones the text names) and
 * `archived_total` (how many there are, which the text states too).
 */
function formatProjectListing(tree, archived) {
  const roots = (Array.isArray(tree) ? tree : []).filter((p) => p && p.project_id);
  const archivedRows = (Array.isArray(archived) ? archived : []).filter((p) => p && p.project_id);
  const taskOf = (p) => (p.context?.current_task ? ` — ${p.context.current_task}` : '');

  const lines = [];
  for (const root of roots) {
    lines.push(`• ${root.project_name} (${root.project_id})${taskOf(root)}`);
    const subs = (root.subprojects || []).filter((s) => s && s.project_id);
    subs.forEach((s, i) => {
      const branch = i === subs.length - 1 ? '└─' : '├─';
      lines.push(`    ${branch} ${s.project_name} (${s.project_id})${taskOf(s)}`);
    });
  }
  const data = {
    projects: roots.map((root) => ({
      project_id: root.project_id,
      project_name: root.project_name,
      current_task: root.context?.current_task || undefined,
      subprojects: (root.subprojects || []).filter((s) => s && s.project_id).map((s) => ({
        project_id: s.project_id,
        project_name: s.project_name,
        current_task: s.context?.current_task || undefined,
      })),
    })),
  };

  if (!archivedRows.length) {
    return { text: lines.length ? lines.join('\n') : NO_PROJECTS_LISTING, data };
  }

  const total = archivedRows.length;
  const shown = archivedRows.slice(0, LISTING_ARCHIVED_SHOWN);
  const one = total === 1;
  if (lines.length) {
    lines.push('', `Archived, not gone (${total}):`);
  } else {
    lines.push(`No active projects. ${total} archived project${one ? ' is' : 's are'} waiting, not gone:`);
  }
  for (const project of shown) {
    const day = archivedDay(project.archived_at);
    lines.push(`• ${project.project_name} (${project.project_id}) — archived${day ? ` ${day}` : ''}`);
  }
  if (total > shown.length) lines.push(`  … and ${total - shown.length} more archived`);
  lines.push('');
  lines.push(one
    ? `Everything it remembered is still there. To work in it, restore it with manage_projects(action:"restore", project_id:"${shown[0].project_id}") rather than creating a new project: a new project starts with an empty brief.`
    : 'Everything they remembered is still there. To work in one, restore it with manage_projects(action:"restore", project_id:"<id>") rather than creating a new project: a new project starts with an empty brief.');

  data.archived_projects = shown.map((project) => ({
    project_id: project.project_id,
    project_name: project.project_name,
    archived: true,
    archived_at: project.archived_at || undefined,
  }));
  data.archived_total = total;
  return { text: lines.join('\n'), data };
}

/**
 * What both dispatchers say after archiving a project. It used to promise that
 * the project would not appear in recall(action:"projects") (local) or in
 * "normal project lists" (hosted); the listing names archived projects now,
 * marked archived, so say that instead.
 */
function formatProjectArchivedReply(project) {
  const name = project?.project_name || project?.project_id || 'the project';
  const id = project?.project_id ? `, project_id:"${project.project_id}"` : '';
  return `Archived "${name}". It no longer resolves as the active project, and recall(action:"projects") lists it as archived. Restore it with manage_projects(action:"restore"${id}).`;
}

// How many cards a LISTING returns per column. Done is tighter because it is the
// column that grows without bound and the one nobody is reading a listing to
// find. These are display caps only — counts_by_phase, total_cards and every
// column's `total` keep reporting STORAGE.
const LISTING_CARDS_PER_PHASE = 20;
const LISTING_CARDS_PER_DONE_PHASE = 10;

// Ceilings on an EXPLICIT cards_per_phase. The parameter exists so a caller can
// see further down a long column, but it must not be a way to rebuild the
// unbounded response this cap was added to prevent — a knob that lets the client
// truncate again would undo the fix while looking like a feature.
//
// Per-phase alone is not enough of a guard: six columns at the per-phase maximum
// is a bigger payload than the one that broke. So the TOTAL is what is really
// budgeted, and the per-phase request is shrunk until the whole listing fits.
// The default path never reaches this — 5 open columns at 20 plus Done at 10 is
// 110, already inside the budget — so defaults behave exactly as before.
const LISTING_CARDS_PER_PHASE_MAX = 50;
const LISTING_CARDS_TOTAL_BUDGET = 120;

function completionTimeMs(card) {
  for (const value of [card?.completed_at, card?.updated_at, card?.created_at]) {
    const ms = value ? Date.parse(value) : NaN;
    if (Number.isFinite(ms)) return ms;
  }
  return -Infinity;
}

/**
 * Done cards ordered newest completion first: completed_at, falling back to
 * updated_at then created_at for legacy rows that never carried one. Ties keep
 * the later array position first, so equal stamps still read newest-filed first.
 */
function sortByMostRecentlyCompleted(cards) {
  return cards
    .map((card, index) => ({ card, index, ms: completionTimeMs(card) }))
    .sort((a, b) => (b.ms - a.ms) || (b.index - a.index))
    .map(({ card }) => card);
}

/** The cap a column gets under a given request (null = per-phase defaults). */
function listingCapForColumn(column, requested) {
  if (requested !== null) return requested;
  return column.phase === DONE_BOARD_PHASE ? LISTING_CARDS_PER_DONE_PHASE : LISTING_CARDS_PER_PHASE;
}

/** Cards the whole listing would return at this request. */
function listingTotalForCap(board, requested) {
  return board.reduce(
    (n, col) => n + Math.min((Array.isArray(col.cards) ? col.cards : []).length, listingCapForColumn(col, requested)),
    0,
  );
}

/**
 * The board snapshot as a LISTING payload: every card body replaced by a
 * has_body flag, and every column bounded.
 *
 * An MCP tool result carries structuredContent alongside its text, and a listing
 * that dropped bodies from the text while shipping them in the structured half
 * would blow the response budget just as thoroughly — silently, because nobody
 * reads that half by eye. Listing the live board already overruns the limit on
 * titles alone. Both dispatchers pass their listing through here.
 *
 * Stripping bodies was never enough. A 282-card board still serialises to ~83KB
 * of titles, and OUR OWN sanitizeToolResult clamps that on the way out
 * (apps/api/src/services/mcpSafety.js): arrays are sliced to 100, and once
 * STRUCTURED_BUDGET_CHARS is spent the object walk breaks, dropping every key it
 * had not reached yet. `board` serialises before counts_by_phase / total_cards /
 * open_cards, so the clamp removed exactly the fields that would have revealed
 * it. The result reads as a complete board with a short Done column, which is
 * indistinguishable from a board that really is short. That is how a full column
 * came to look like a dropped write.
 *
 * This was first diagnosed as client-side truncation and it is not — the string
 * marker that led there, "[output truncated]", is written by clampValue in that
 * same file. Worth stating plainly, because the wrong version of this comment
 * shipped: when a payload comes back short, check what our own response
 * sanitiser did to it before blaming the transport.
 *
 * So the bound belongs HERE, on the server, where the true totals are still
 * known: return a capped set of cards, and carry `total` / `returned` /
 * `has_more` per column so a partial read can never be mistaken for the whole
 * board. `counts_by_phase`, `total_cards` and `open_cards` ride through from the
 * full snapshot untouched and always describe storage — never this view.
 */
function taskBoardSnapshotForListing(snapshot, options = {}) {
  if (!snapshot || !Array.isArray(snapshot.board)) return snapshot;
  let requested = Number.isFinite(options.cards_per_phase)
    ? Math.max(1, Math.min(LISTING_CARDS_PER_PHASE_MAX, Math.floor(options.cards_per_phase)))
    : null;
  // Shrink an explicit request until the whole listing fits the total budget.
  // Silently returning fewer than asked is safe BECAUSE every column still
  // reports `total` and `has_more` — the caller is told exactly what it did not
  // get, which is the property that makes a partial listing honest.
  if (requested !== null) {
    while (requested > 1 && listingTotalForCap(snapshot.board, requested) > LISTING_CARDS_TOTAL_BUDGET) {
      requested -= 1;
    }
  }
  return {
    ...snapshot,
    board: snapshot.board.map((column) => {
      const all = Array.isArray(column.cards) ? column.cards : [];
      const cap = listingCapForColumn(column, requested);
      // Done shows the most RECENTLY COMPLETED cards, newest first; every open
      // column shows its head, which is the order the board is actually worked.
      //
      // Done used to take the TAIL of the array, and array position is creation
      // order: a card filed in July and finished today sat near the front and was
      // elided, while older completions created later filled the listing. The
      // same mistake the Done trim made (see mergeContextObject), one layer up.
      const shown = column.phase === DONE_BOARD_PHASE
        ? sortByMostRecentlyCompleted(all).slice(0, cap)
        : all.slice(0, cap);
      return {
        ...column,
        total: all.length,
        returned: shown.length,
        has_more: all.length > shown.length,
        cards: shown.map(({ body, ...card }) => (body ? { ...card, has_body: true } : card)),
      };
    }),
  };
}

/** Render a compact terminal/chat answer without changing the underlying board. */
function formatTaskBoardText(snapshot, options = {}) {
  const limit = Number.isFinite(options.cards_per_phase) ? Math.max(1, options.cards_per_phase) : 2;
  const lines = [
    `Task board — ${snapshot.project_name}`,
    `${snapshot.open_cards} open · ${snapshot.counts_by_phase.blocked || 0} blocked · ${snapshot.counts_by_phase.in_progress || 0} active · ${snapshot.counts_by_phase.testing || 0} testing`,
  ];
  for (const column of snapshot.board) {
    if (!column.cards.length) continue;
    lines.push('', `${column.label} (${column.cards.length})`);
    for (const card of column.cards.slice(0, limit)) lines.push(`  • ${card.title}${card.body ? TASK_BODY_MARKER : ''}`);
    if (column.cards.length > limit) lines.push(`  … ${column.cards.length - limit} more`);
  }
  return lines.join('\n');
}

/**
 * Open one or more cards in full — the ONLY renderer that prints a card's body.
 *
 * A board listing shows titles plus a `+body` marker and stops there, because
 * listing the live board already strains the MCP response limit with titles
 * alone. A body is something you open, not something you scan past.
 *
 * This lives in shared-context for the same reason formatPortfolio and
 * formatQuestionResolution do: both MCP dispatchers require this package, so the
 * one part of the feature that is pure rendering physically cannot drift between
 * the local stdio server and the hosted connectors.
 *
 * @param {object} context flat context object (todo_items / completed_todos)
 * @param {string[]} queries card ids, exact titles, or title phrases
 * @param {{max_matches?: number}} [options]
 * @returns {string}
 */
function formatTaskCardDetail(context, queries, options = {}) {
  // Bidirectional substring, the same predicate mergeContextObject and both MCP
  // dispatchers use to match a card by phrase. Kept local rather than reaching
  // into the merge's closure copy — this path is a read and must never inherit a
  // change made for the destructive one.
  const fuzzyMatch = (a, b) => {
    const al = String(a || '').toLowerCase();
    const bl = String(b || '').toLowerCase();
    return Boolean(al) && Boolean(bl) && (al.includes(bl) || bl.includes(al));
  };
  const cards = [];
  for (const column of buildTaskBoard(context)) cards.push(...column.cards);
  const limit = Number.isFinite(options.max_matches) ? Math.max(1, options.max_matches) : 5;
  const lines = [];
  const shown = new Set();

  for (const raw of Array.isArray(queries) ? queries : []) {
    const q = String(raw ?? '').trim();
    if (!q) continue;
    // Same resolution ORDER the removal path uses — exact id, then exact title,
    // then fuzzy — so an id can never be out-voted by a substring. Unlike
    // removal this is a read, so several fuzzy hits are all rendered rather than
    // refused: the risk that made loose matching dangerous there does not exist
    // here, and a caller who typed a phrase usually wants to see the near misses.
    const byId = cards.filter((c) => c.id === q);
    const exact = byId.length
      ? byId
      : cards.filter((c) => String(c.title || '').trim().toLowerCase() === q.toLowerCase());
    const hits = exact.length ? exact : cards.filter((c) => fuzzyMatch(String(c.title || ''), q));
    if (!hits.length) {
      if (lines.length) lines.push('');
      lines.push(`No card matched "${q}".`);
      continue;
    }
    for (const card of hits.slice(0, limit)) {
      if (shown.has(card.id)) continue;
      shown.add(card.id);
      if (lines.length) lines.push('');
      lines.push(neutralizeInjectedText(card.title));
      const meta = [BOARD_PHASE_LABELS[normalizeBoardPhase(card.phase)] || 'Backlog', `[${card.id}]`];
      if (card.completed_at) meta.push(`completed ${String(card.completed_at).slice(0, 10)}`);
      lines.push(`  ${meta.join(' · ')}`);
      if (card.body) {
        // Split FIRST, then neutralize each line. neutralizeInjectedText collapses
        // newlines so a value cannot spawn a top-level line in a brief — correct
        // there, wrong here, where a body is a checklist or a short spec and its
        // line breaks are the readable part. Every line is indented, so it still
        // cannot pose as brief structure, and each one keeps its own guard.
        for (const line of String(card.body).split(/\r\n|\r|\n/)) {
          lines.push(`  ${neutralizeInjectedText(line)}`);
        }
      } else {
        lines.push('  (no body — add detail with action:"add" and cards:[{title:"…", body:"…"}])');
      }
    }
    if (hits.length > limit) {
      lines.push(`  …+${hits.length - limit} more cards matched "${q}" — pass a card id to open one.`);
    }
  }

  return lines.join('\n') || 'No cards named. Pass card ids or title phrases.';
}

// The section names callers actually send, mapped onto the ones SECTION_MAP
// holds. The advertised `sections` schema is a plain array of strings with no
// enum, so a near-miss reached the formatter and was filtered out in silence:
// sections:["current_status"] returned the project header and nothing else, and
// the caller could not tell that from a project with no status.
//
// Only names with one possible meaning. `task` is already the current task, so
// the plural `tasks` can only be the board; anything genuinely ambiguous is left
// to the unknown-name line below, which is the honest answer.
const SECTION_ALIASES = {
  board: 'todos',
  todo: 'todos',
  tasks: 'todos',
  current_task: 'task',
  current_status: 'status',
  blocking_issue: 'blocking',
  task_progress: 'progress',
  decision: 'decisions',
  recent_decisions: 'decisions',
  question: 'questions',
  open_questions: 'questions',
  goal: 'goals',
  tech_stack: 'stack',
  file_structure_summary: 'files',
  paths: 'hot_paths',
  hotpaths: 'hot_paths',
  entry_points: 'entrypoints',
  landmine: 'landmines',
  notes: 'debugging_notes',
  debug_notes: 'debugging_notes',
  recurring_context: 'constraints',
};

// Not in SECTION_MAP: these select the GLOBAL block at the end of the formatter,
// so they are understood names even though no section renders for them.
const GLOBAL_SECTION_NAMES = new Set(['all', 'user', 'prefs']);

/**
 * Returns only the requested sections of a project's context.
 * Powers the section-targeted get_context MCP call.
 */
function formatSectionInjection(context, sections = ['task', 'status'], global = null) {
  const ctx = context || {};
  const asked = (Array.isArray(sections) ? sections : [])
    .map((s) => String(s ?? '').trim().toLowerCase())
    .filter(Boolean);
  const requested = asked.map((s) => SECTION_ALIASES[s] || s);
  const unknown = [...new Set(
    asked.filter((_, i) => !SECTION_MAP[requested[i]] && !GLOBAL_SECTION_NAMES.has(requested[i]))
  )];
  const resolved = requested.includes('all')
    ? Object.keys(SECTION_MAP)
    // Deduped: two spellings of one section (task and current_task) are one ask.
    : [...new Set(requested.filter(s => SECTION_MAP[s]))];

  const name = neutralizeInjectedText(ctx.project_name || 'Unknown project');
  const lines = [`## ${name}`];

  for (const s of resolved) {
    const line = SECTION_MAP[s]?.(ctx);
    if (line) lines.push(line);
  }

  // Before the global block, so it sits with the project's own sections: a
  // requested section that printed nothing because it is WITHHELD would
  // otherwise be indistinguishable from one that printed nothing because it is
  // empty, and this is the call site where a caller explicitly asked for it.
  const withheldLine = formatWithheldSectionsLine(ctx);
  if (withheldLine) lines.push(withheldLine);

  // Same reason, one step earlier: a name nobody here recognizes printed nothing
  // and said nothing, which reads as "that section is empty".
  if (unknown.length) {
    lines.push(`Not a section name: ${unknown.join(', ')}. Valid sections: ${[...Object.keys(SECTION_MAP), 'all'].join(', ')}.`);
  }

  // Append relevant global context if requested
  if (requested.includes('all') || requested.includes('user') || requested.includes('prefs')) {
    if (global?.user_profile) lines.push(`\nUser: ${neutralizeInjectedText(global.user_profile)}`);
    if (global?.preferences?.length) lines.push(`Prefs: ${global.preferences.map(neutralizeInjectedText).join(' | ')}`);
    if (global?.recurring_instructions?.length) lines.push(`Always: ${global.recurring_instructions.map(neutralizeInjectedText).join(' | ')}`);
  }

  return lines.join('\n');
}


// A node with no summary is its title alone. The canonical key used to stand in
// for it: an internal identity, which for a per-project copy carries a project
// id (`…::in.project_<uuid>`), printed into text a person reads (scan 36).
function workspaceNodeLine(node) {
  return node.summary ? `- ${node.title}: ${clipText(node.summary, 90)}` : `- ${node.title}`;
}

function formatWorkspaceOverview(overview, verbosity = 'standard') {
  const parsed = WorkspaceOverviewResultSchema.parse(overview || {});
  const limit = parsed.mode === 'startup'
    ? (verbosity === 'light' ? 2 : 3)
    : (verbosity === 'light' ? 2 : verbosity === 'detailed' ? 6 : 4);
  const lines = [];

  lines.push('What matters now');
  for (const line of parsed.summary.now.slice(0, limit)) lines.push(`- ${line}`);
  if (parsed.summary.now.length === 0) lines.push('- No active workspace summary yet.');

  if (parsed.projects.length > 0 && parsed.mode !== 'startup') {
    lines.push('');
    lines.push('Projects');
    for (const project of parsed.projects.slice(0, limit)) {
      const task = project.context?.current_task ? `: ${clipText(project.context.current_task, 70)}` : '';
      lines.push(`- ${project.project_name}${task}`);
    }
  }

  if (parsed.knowledge.length > 0) {
    lines.push('');
    lines.push('Knowledge');
    for (const node of parsed.knowledge.slice(0, limit)) {
      lines.push(workspaceNodeLine(node));
    }
  }

  if (parsed.tools.length > 0 && parsed.mode !== 'startup') {
    lines.push('');
    lines.push('Tools and environments');
    for (const node of parsed.tools.slice(0, limit)) {
      lines.push(workspaceNodeLine(node));
    }
  }

  if (parsed.capabilities.length > 0) {
    lines.push('');
    lines.push('Capabilities and workflows');
    for (const node of parsed.capabilities.slice(0, limit)) {
      lines.push(workspaceNodeLine(node));
    }
  }

  if (parsed.related_projects.length > 0 && parsed.mode !== 'startup') {
    lines.push('');
    lines.push('Projects you work alongside');
    for (const rel of parsed.related_projects.slice(0, limit)) {
      const co = rel.co_occurrence_count > 0 ? ` (co-occurs ${rel.co_occurrence_count}×)` : '';
      lines.push(`- ${rel.project_name}${co}`);
    }
  }

  if (parsed.contributors.length > 0 && parsed.mode !== 'startup') {
    lines.push('');
    lines.push('Contributors');
    for (const c of parsed.contributors.slice(0, limit)) {
      const plural = c.contributions === 1 ? 'contribution' : 'contributions';
      lines.push(`- ${c.user_id} — ${c.contributions} ${plural}`);
    }
  }

  const layers = [
    parsed.layers.direct_context,
    parsed.layers.passive_enrichment,
    parsed.layers.intelligence,
  ];
  if (parsed.mode !== 'startup' && layers.some((layer) => layer.input_count > 0 || layer.selected_count > 0 || layer.highlights.length > 0)) {
    lines.push('');
    lines.push('Context runtime');
    for (const layer of layers) {
      lines.push(`- ${layer.title} (${layer.status}, ${layer.selected_count}/${layer.input_count} selected): ${clipText(layer.summary, 90)}`);
      for (const highlight of layer.highlights.slice(0, verbosity === 'detailed' ? 2 : 1)) {
        lines.push(`  - ${clipText(highlight, 90)}`);
      }
    }
  }

  if ((parsed.current_understanding.relevant_enrichments || []).length > 0 && parsed.mode !== 'startup') {
    lines.push('');
    lines.push('Current understanding');
    if (parsed.current_understanding.current_task) lines.push(`- Task: ${clipText(parsed.current_understanding.current_task, 90)}`);
    if (parsed.current_understanding.current_status) lines.push(`- Status: ${clipText(parsed.current_understanding.current_status, 90)}`);
    for (const enrichment of parsed.current_understanding.relevant_enrichments.slice(0, verbosity === 'detailed' ? 3 : 2)) {
      lines.push(`- Enrichment: ${enrichment.title} (${enrichment.source})`);
    }
    if (parsed.current_understanding.confidence_summary) {
      lines.push(`- Confidence: ${clipText(parsed.current_understanding.confidence_summary, 90)}`);
    }
  }

  if (parsed.summary.recent.length > 0 && verbosity !== 'light') {
    lines.push('');
    lines.push('Recent changes');
    for (const line of parsed.summary.recent.slice(0, limit)) lines.push(`- ${line}`);
  }

  return lines.join('\n');
}

// ── Portfolio (cross-project) ────────────────────────────────────────────────
//
// The portfolio is the only read that crosses project boundaries: entities the
// account has recorded in more than one project, plus one decision timeline over
// all of them. Until now it had no model-facing surface at all, so a session
// could never volunteer "you already decided this in your other project" — the
// single moment that makes cross-project memory felt rather than described.
//
// It renders HERE, in shared-context, rather than in either MCP dispatcher, and
// that placement is the point. DeerDawn runs two hand-maintained dispatchers over
// the same tool names (packages/mcp-server for local stdio, apps/api/src/routes/
// mcp.js for the hosted connectors), and they have drifted before. Both require
// this module already, so a shared formatter is the one part of the feature that
// physically cannot diverge.
//
// `portfolio` is the payload from portfolioService.getPortfolio: `counts` is
// always populated with the owner's real numbers, and `locked` says whether the
// contents travelled with them.
function formatPortfolio(portfolio, { entityLimit = 8, decisionLimit = 5 } = {}) {
  const counts = portfolio?.counts || {};
  const projectCount = Number(counts.projects || 0);
  const sharedCount = Number(counts.shared_entities || 0);
  const decisionCount = Number(counts.decisions || 0);

  // One project cannot span projects. Say that plainly instead of returning an
  // empty list the model would read as "the feature found nothing".
  //
  // "Active", because the count is: portfolioService counts live projects only.
  // "this account has 0" was said to somebody whose two projects the nightly job
  // had archived, the same "you have no projects" the listing used to say.
  if (projectCount <= 1) {
    return `Cross-project memory needs more than one project; this account has ${projectCount} active ${projectCount === 1 ? 'project' : 'projects'}. `
      + 'Nothing spans projects yet.';
  }

  const lines = [
    `Across ${projectCount} projects: ${sharedCount} ${sharedCount === 1 ? 'entity appears' : 'entities appear'} `
    + `in more than one, ${decisionCount} ${decisionCount === 1 ? 'decision' : 'decisions'} on the merged timeline.`,
  ];

  if (portfolio?.locked) {
    // Counts in the clear, contents withheld — the same shape the dashboard
    // gets. State it as a fact about the plan, not as a pitch.
    lines.push('');
    lines.push('The contents are not included on this plan. The counts above are this account\'s real numbers.');
    return lines.join('\n');
  }

  const entityEntries = (portfolio?.entities?.entries || []).slice(0, entityLimit);
  if (entityEntries.length > 0) {
    lines.push('');
    lines.push('Shared entities');
    for (const entity of entityEntries) {
      const type = entity.entity_type || entity.node_type || 'entity';
      const names = (entity.projects || []).map((p) => p?.project_name).filter(Boolean);
      // A workspace-scoped entity is portfolio-level by declaration rather than
      // by observation, so it has no project list to name.
      const where = names.length > 0
        ? `${names.slice(0, 4).join(', ')}${names.length > 4 ? ` +${names.length - 4} more` : ''}`
        : 'workspace-wide, not yet seen in a specific project';
      lines.push(`- ${entity.title} (${type}): ${where}`);
    }
    const rest = Number(portfolio?.entities?.total || 0) - entityEntries.length;
    if (rest > 0) lines.push(`- ...and ${rest} more`);
  }

  const decisionEntries = (portfolio?.decisions?.entries || []).slice(0, decisionLimit);
  if (decisionEntries.length > 0) {
    lines.push('');
    lines.push('Decisions across every project');
    for (const decision of decisionEntries) {
      // date_inferred means the timestamp was stamped in, not recorded. The
      // brief never presents those as real dates, and neither does this.
      const when = decision.decided_at && !decision.date_inferred
        ? `${String(decision.decided_at).slice(0, 10)} `
        : '';
      lines.push(`- ${when}[${decision.project_name}] ${clipText(decision.summary, 110)}`);
    }
    const rest = Number(portfolio?.decisions?.total || 0) - decisionEntries.length;
    if (rest > 0) lines.push(`- ...and ${rest} more`);
  }

  if (entityEntries.length === 0 && decisionEntries.length === 0) {
    lines.push('');
    lines.push('No entity or decision is shared across these projects yet.');
  }

  return lines.join('\n');
}

// ── Resolving ONE open question ──────────────────────────────────────────────
//
// An agent session's only lever on open_questions used to be cleanup_context,
// which clears the whole list along with the command log and the blocking issue.
// So dead questions accumulated: the only tool pointed at them was a wrecking
// ball. `manage_memory(action:"resolve_question")` is the narrow alternative, and
// this renders every one of its three outcomes.
//
// It renders HERE for the same reason formatPortfolio does. DeerDawn runs two
// hand-maintained dispatchers over the same tool names (packages/mcp-server for
// local stdio, apps/api/src/routes/mcp.js for the hosted connectors) and they
// have drifted before. Both already require this module, so the wording of a
// refusal — the part a model actually reads and acts on — is the one part of the
// feature that physically cannot diverge.
//
// The refusals carry the CANDIDATE QUESTIONS, not just a count. A caller told
// only "that was ambiguous" has no way to become unambiguous; a caller shown the
// two questions it fell between can re-send one of them verbatim. That is the
// whole difference between a recoverable refusal and a dead end.
//
// `outcome` is contextSyncService.resolveQuestion's return value, plus the list
// of questions still open:
//   { reason: 'resolved'|'ambiguous'|'unmatched', resolved, candidates, open_questions }
function formatQuestionResolution(query, outcome = {}) {
  const asked = String(query ?? '').trim();
  const open = (outcome.open_questions || []).filter((item) => typeof item === 'string' && item.trim());
  // Deliberately NOT `candidates.map(...)`: one query resolves at most one
  // question, and a formatter that iterates the candidate list into an action is
  // the exact shape of the fan-out bug this endpoint was hardened against. Here
  // the list is only ever printed, never acted on.
  const bullets = (items, limit = 12) => {
    const shown = items.slice(0, limit).map((item) => `  - ${clipText(item, 160)}`);
    if (items.length > limit) shown.push(`  - ...and ${items.length - limit} more`);
    return shown;
  };

  if (outcome.reason === 'ambiguous') {
    const near = (outcome.candidates || []).filter((item) => typeof item === 'string' && item.trim());
    return [
      `"${clipText(asked, 160)}" matches ${near.length} open questions, so nothing was resolved and the brief still holds all of them.`,
      ...bullets(near),
      'Re-send the exact, complete text of the one you meant.',
    ].join('\n');
  }

  if (outcome.reason === 'unmatched') {
    if (!open.length) {
      return `No open question matches "${clipText(asked, 160)}" — the brief has no open questions at all, so nothing was resolved.`;
    }
    return [
      `No open question matches "${clipText(asked, 160)}", so nothing was resolved. Still open:`,
      ...bullets(open),
      'Re-send one of these verbatim.',
    ].join('\n');
  }

  const lines = [`Resolved: "${clipText(outcome.resolved, 200)}"`];
  lines.push('The answer is now a decision in the brief; every other question, the task, and the command log are untouched.');
  lines.push(open.length
    ? `${open.length} question${open.length === 1 ? '' : 's'} still open.`
    : 'No questions remain open.');
  return lines.join('\n');
}

function inferSurfaceType(tool) {
  if (tool === 'claude_web' || tool === 'chatgpt_web' || tool === 'gemini' || tool === 'perplexity') return 'browser';
  if (tool === 'cursor') return 'code';
  return 'cli';
}

const DEFAULT_MCP_API_URL = 'https://api.deerdawn.com';

// A WORKSPACE KEY IS AN IDENTIFIER, NOT A CREDENTIAL.
//
// The committable .mcp.json named no workspace, so a teammate who already had a
// local install before accepting the invite had no way to point it at the team:
// `setup` reuses the saved valid key, the boot device flow is skipped when
// credentials.json exists, and the server sends no x-deerdawn-workspace header.
// Three product surfaces promised it just worked.
//
// Naming the workspace in the file is safe in a way an API key is not. The
// header it feeds is membership-checked on every request (middleware/auth.js
// binds it through workspaceService.resolveOwnerKey), so somebody who is not a
// member gains nothing by knowing it, and the file stays committable. Omitted
// for a personal workspace: there is nothing there to point at.
function buildMcpServerConfigObject(apiUrl = DEFAULT_MCP_API_URL, apiKey = '', workspaceId = '') {
  const env = { DEERDAWN_API_URL: apiUrl || DEFAULT_MCP_API_URL };
  if (workspaceId) env.DEERDAWN_WORKSPACE = workspaceId;
  if (apiKey) env.DEERDAWN_API_KEY = apiKey;
  return {
    command: 'npx',
    args: ['-y', '@deerdawn/mcp-server@latest'],
    env,
  };
}

function formatMcpJsonConfig(apiUrl = DEFAULT_MCP_API_URL, apiKey = '', workspaceId = '') {
  const workspaceLine = workspaceId ? `,\n        "DEERDAWN_WORKSPACE": "${workspaceId}"` : '';
  const keyLine = apiKey ? `,\n        "DEERDAWN_API_KEY": "${apiKey}"` : '';
  return `{
  "mcpServers": {
    "deerdawn": {
      "command": "npx",
      "args": ["-y", "@deerdawn/mcp-server@latest"],
      "env": {
        "DEERDAWN_API_URL": "${apiUrl || DEFAULT_MCP_API_URL}"${workspaceLine}${keyLine}
      }
    }
  }
}`;
}

function formatCodexMcpTomlConfig(apiUrl = DEFAULT_MCP_API_URL, apiKey = '') {
  const lines = [
    '[mcp_servers.deerdawn]',
    'command = "npx"',
    'args = ["-y", "@deerdawn/mcp-server@latest"]',
    'startup_timeout_sec = 120',
    '',
    '[mcp_servers.deerdawn.env]',
    `DEERDAWN_API_URL = "${apiUrl || DEFAULT_MCP_API_URL}"`,
  ];
  if (apiKey) lines.push(`DEERDAWN_API_KEY = "${apiKey}"`);
  return lines.join('\n');
}

// ─── Shared skills formatting (spec §3.6) ─────────────────────────────────
// Three small, pure helpers + a tolerant frontmatter parser. No Zod schema,
// no token-budgeted clip pipeline — skill bodies are written verbatim.

// One-line-per-skill index for always-on files (AGENTS.md / copilot). Leads with
// a precedence sentence so an agent never treats a skill as overriding project
// context or user instructions. Returns '' for empty input so callers can no-op.
function buildSkillsIndexBlock(skills) {
  if (!skills || !skills.length) return '';
  const lines = skills.map((skill) => {
    const name = String(skill?.name || '').trim();
    const description = String(skill?.description || '').trim();
    const slug = String(skill?.slug || '').trim();
    return `- **${name}** — ${description} _(load: deerdawn://skills/${slug})_`;
  });
  return [
    '## Shared skills (via DeerDawn)',
    'Project context and user instructions take precedence over skills on conflict.',
    '',
    ...lines,
  ].join('\n');
}

// Near-identity for Claude Code: if the body already carries a leading
// `--- ... ---` frontmatter block with name/description, return it verbatim;
// otherwise prepend a minimal frontmatter. Body is never clipped/token-budgeted.
function toClaudeSkillMd(meta, body) {
  const content = typeof body === 'string' ? body : '';
  const existing = parseSkillFrontmatter(content);
  if (existing.name && existing.description) return content;
  const name = String(meta?.name || meta?.slug || '').trim();
  const description = String(meta?.description || '').trim();
  const frontmatter = `---\nname: ${name}\ndescription: ${description}\n---\n`;
  return `${frontmatter}${content}`;
}

// Rewrites the frontmatter to Cursor's shape (`description`, `alwaysApply: false`)
// so Cursor gates the skill instead of treating Claude frontmatter as prose.
// Strips any existing leading frontmatter, then prepends the Cursor block.
function toCursorMdc(meta, body) {
  const content = typeof body === 'string' ? body : '';
  const description = String(meta?.description || '').trim();
  const stripped = stripLeadingFrontmatter(content);
  const frontmatter = `---\ndescription: ${description}\nalwaysApply: false\n---\n`;
  return `${frontmatter}${stripped}`;
}

// Tolerant parse of a leading `--- ... ---` YAML frontmatter block. Simple line
// scan (no YAML dependency); returns empty strings when a key/block is absent.
function parseSkillFrontmatter(md) {
  const text = typeof md === 'string' ? md : '';
  const result = { name: '', description: '' };
  const lines = text.split('\n');
  let index = 0;
  // Allow a leading blank line or two before the opening fence.
  while (index < lines.length && lines[index].trim() === '') index += 1;
  if (lines[index]?.trim() !== '---') return result;
  index += 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '---') break;
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key === 'name' && !result.name) result.name = value;
    else if (key === 'description' && !result.description) result.description = value;
  }
  return result;
}

// Remove a single leading `--- ... ---` frontmatter block (if present), returning
// just the body. Tolerant of leading blank lines before the fence.
function stripLeadingFrontmatter(md) {
  const text = typeof md === 'string' ? md : '';
  const lines = text.split('\n');
  let index = 0;
  while (index < lines.length && lines[index].trim() === '') index += 1;
  if (lines[index]?.trim() !== '---') return text;
  index += 1;
  for (; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      return lines.slice(index + 1).join('\n');
    }
  }
  // No closing fence — not a real frontmatter block, leave content untouched.
  return text;
}

module.exports = {
  YouProfileSchema,
  CommandEntrySchema,
  ContextObjectSchema,
  ContextDeltaSchema,
  ContextEventSchema,
  ContextSessionSchema,
  GraphNodeSchema,
  GraphEdgeSchema,
  GraphEvidenceSchema,
  GraphExtractionResultSchema,
  GraphRetrievalResultSchema,
  SetupApplyResultSchema,
  SetupStatusResultSchema,
  SetupSurfaceStateSchema,
  SetupSurfaceStatusSchema,
  ContextRuntimeLayerSchema,
  PassiveEnrichmentItemSchema,
  ContextSelectionExplanationSchema,
  CurrentUnderstandingSchema,
  WorkspaceEntityInputSchema,
  WorkspaceEntityTypeSchema,
  WorkspaceRelationInputSchema,
  SubagentBriefRequestSchema,
  SubagentBriefSourceSchema,
  SubagentBriefResultSchema,
  NextBestContextResultSchema,
  NextBestContextSuggestionSchema,
  WorkspaceOverviewModeSchema,
  WorkspaceOverviewResultSchema,
  WorkspaceOverviewSectionSchema,
  GlobalContextSchema,
  ExtractionRequestSchema,
  ExtractionResponseSchema,
  ProjectMatchResultSchema,
  InjectionPreferenceSchema,
  InjectionPayloadSchema,
  ToolPreferenceSchema,
  decisionHeadline,
  selectRecentDecisions,
  selectBriefDecisions,
  rankHotPaths,
  normalizeDebuggingNotes,
  nextBlockerSetAt,
  // Exported so a writer can tell a COLLISION from an append: it is the identity
  // this package dedupes notes by, and a second copy of that rule elsewhere
  // would answer a different question than the one the merge asked.
  debuggingNoteKey,
  // And exported for the same reason: a writer reporting an EVICTION has to
  // know when the log could have evicted anything, and a second copy of the cap
  // would go stale the first time this one moved.
  DEBUGGING_NOTE_LIMIT,
  buildRelatedProjectsLine,
  createContextObject,
  mergeContextObject,
  capDecisions,
  formatConversationalInjection,
  formatCodeInjection,
  formatBriefInjection,
  formatSubagentBrief,
  formatGlobalOnlyInjection,
  formatMapInjection,
  formatSectionInjection,
  formatWithheldSectionsLine,
  withheldSectionLabels,
  formatWorkspaceOverview,
  formatPortfolio,
  formatQuestionResolution,
  buildMcpServerConfigObject,
  formatMcpJsonConfig,
  formatCodexMcpTomlConfig,
  inferSurfaceType,
  timeAgo,
  VERBOSITY_VALUES,
  TOOL_VALUES,
  GRAPH_SOURCE_TOOL_VALUES,
  GRAPH_NODE_TYPE_VALUES,
  GRAPH_EDGE_TYPE_VALUES,
  SURFACE_TYPE_VALUES,
  SESSION_STATUS_VALUES,
  ROUTING_STATE_VALUES,
  DECISION_IMPORTANCE_VALUES,
  SUBAGENT_BRIEF_MARKER,
  DecisionEntrySchema,
  DebuggingNoteEntrySchema,
  LandmineEntrySchema,
  ShippedEntrySchema,
  hasCriticalDecision,
  deriveItemTrust,
  buildBriefSpine,
  followBoardCardsInShipped,
  buildTaskBoard,
  buildTaskBoardSnapshot,
  taskBoardSnapshotForListing,
  formatTaskBoardText,
  formatTaskCardDetail,
  formatArchivedProjectsNotice,
  formatProjectListing,
  formatProjectArchivedReply,
  LISTING_ARCHIVED_SHOWN,
  ARCHIVED_PROJECTS_FETCH_LIMIT,
  normalizeBoardPhase,
  normalizeTodoBody,
  normalizeTaskCardInputs,
  resolveTaskCard,
  taskCardBodyWasClipped,
  BOARD_PHASES,
  BOARD_PHASE_LABELS,
  MAX_TODO_BODY_CHARS,
  MAX_TRAIL_CHARS,
  MAX_EXTRACTION_BODY_BYTES,
  EXTRACTION_BODY_BUDGET_BYTES,
  TASK_BODY_MARKER,
  // Multi-agent coordination — re-exported so consumers have one import surface.
  ...coordination,
  extractStructuredFields,
  buildSkillsIndexBlock,
  toClaudeSkillMd,
  toCursorMdc,
  parseSkillFrontmatter,
  // Session-start card (see briefCard.js) — the human-facing surface.
  buildBriefCard: require('./briefCard.js').buildBriefCard,
  // The one data line every loaded brief starts with (see briefReceipt.js).
  // Hosted start_session, local /active and the SessionStart hook share it.
  ...require('./briefReceipt.js'),
  ...require('./taskBoardWidget.js'),
  // finish_task: what a confirmation clears is what its review showed (see
  // taskReview.js). Both dispatchers, one rule.
  ...require('./taskReview.js'),
  neutralizeInjectedText,
  // The brief's own cut and budgets, for a surface that prints a decision next
  // to the "Recent decisions" line (the API's Knowledge web line) and must cut
  // it the same way, so the text a caller copies from either reads the same.
  clipText,
  proseBudget,
  redactSecretText,
};

// ─── CLAUDE.md / AGENTS.md structured parser ──────────────────────────────

function _extractLine(text, ...keys) {
  for (const key of keys) {
    const m = text.match(new RegExp(`^#{0,6}\\s*${key}[:\\s]+(.+)`, 'mi'));
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return '';
}

function _extractSectionBullets(text, ...keys) {
  const lines = text.split('\n');
  for (const key of keys) {
    const headerRe = new RegExp(`^#{0,6}\\s*${key}[:\\s]*$`, 'i');
    const startIndex = lines.findIndex(line => headerRe.test(line.trim()));
    if (startIndex === -1) continue;
    const bullets = [];
    for (let i = startIndex + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed) { if (bullets.length) break; continue; }
      const m = trimmed.match(/^[-*•]\s+(.+)$/);
      if (!m) { if (bullets.length) break; continue; }
      bullets.push(m[1].trim());
    }
    if (bullets.length) return bullets;
  }
  return [];
}

function _extractBulletList(text, ...keys) {
  const bullets = _extractSectionBullets(text, ...keys);
  if (bullets.length) return bullets;
  const inline = _extractLine(text, ...keys);
  if (inline) return inline.split(/[,|]/).map(s => s.trim()).filter(Boolean);
  return [];
}

/**
 * Parse a raw CLAUDE.md / AGENTS.md string into a structured context delta.
 * Pure function — no I/O, no persistence. Used for preview endpoints.
 */
function extractStructuredFields(rawText) {
  const text = typeof rawText === 'string' ? rawText : '';
  const patch = {};

  const task = _extractLine(text, 'Current task', 'Task');
  if (task) patch.current_task = task;

  const status = _extractLine(text, 'Current status', 'Status');
  if (status) patch.current_status = status;

  const blocking = _extractLine(text, 'Blocking issue', 'Blocker', 'Blocked on', 'Blocking');
  if (blocking) patch.blocking_issue = blocking;

  const progress = _extractLine(text, 'Task progress', 'Progress');
  if (progress) patch.task_progress = progress;

  const stack = _extractBulletList(text, 'Tech stack', 'Default stack', 'Stack', 'Technology stack');
  if (stack.length) patch.tech_stack = stack;

  const goals = _extractBulletList(text, 'Goals', 'Objectives');
  if (goals.length) patch.goals = goals;

  const questions = _extractBulletList(text, 'Open questions', 'Questions');
  if (questions.length) patch.open_questions = questions;

  const constraints = _extractBulletList(text, 'Recurring context', 'Constraints', 'Rules', 'Module boundaries');
  if (constraints.length) patch.recurring_context = constraints;

  const files = _extractBulletList(text, 'Key files', 'Relevant files', 'File structure', 'Key Files');
  if (files.length) patch.file_structure_summary = files;

  // decisions: bullet list with optional decided_at
  const decidedAt = new Date().toISOString();
  const decisionBullets = _extractSectionBullets(text, 'Recent decisions');
  if (decisionBullets.length) {
    patch.recent_decisions = decisionBullets.slice(0, 10).map(summary => ({ summary, decided_at: decidedAt }));
  } else {
    const inline = _extractLine(text, 'Recent decisions?');
    if (inline) {
      patch.recent_decisions = inline.split(/\|/).map(s => s.trim()).filter(Boolean).slice(0, 5)
        .map(summary => ({ summary, decided_at: decidedAt }));
    }
  }

  const description = _extractLine(text, 'Description', 'About', 'Product overview', 'Overview');
  if (description && description.length > 10) patch.description = description;

  // fallback: extract apps/packages bullet list as tech stack when no stack found
  if (!patch.tech_stack || !patch.tech_stack.length) {
    const apps = _extractSectionBullets(text, 'Applications', 'Apps');
    const pkgs = _extractSectionBullets(text, 'Packages');
    const combined = [...apps, ...pkgs].map(s => s.replace(/\s*—.*$/, '').replace(/`/g, '').trim()).filter(Boolean);
    if (combined.length) patch.tech_stack = combined.slice(0, 8);
  }

  return patch;
}
