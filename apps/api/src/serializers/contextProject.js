'use strict';

// Single source of truth for shaping a stored project object before it goes over
// the HTTP wire. EVERY route (and service builder) that returns a project MUST go
// through here, so heavy internals never leak by accident — including from
// endpoints added later:
//
//   - `events`  : the raw per-project event log. Unbounded, grows to >1MB, and no
//                 HTTP consumer reads it. Dropped unless a caller explicitly opts in.
//   - `context` : the full context carries board cards, knowledge, hot paths,
//                 debugging notes, landmines, entrypoints, etc. List/tree/overview
//                 views only need the lightweight summary fields (see
//                 ContextProjectSummary in the dashboard) — the rest is pure bloat
//                 on those endpoints (a portfolio of projects was ~213KB / ~249KB).
//
// Detail endpoints that genuinely need the full context still return it via
// serializeProjectFull; only the raw event log is stripped there.

// Lightweight context fields exposed on summary/list/tree/overview payloads.
// Mirrors ContextProjectSummary.context in apps/dashboard/src/lib/api.ts. Anything
// not listed (board, knowledge, hot_paths, debugging_notes, landmines,
// entrypoints, surfaces, resolved_landmines, ...) is intentionally omitted here.
const SUMMARY_CONTEXT_FIELDS = [
  'project_name',
  'description',
  'goals',
  'current_status',
  'current_task',
  'tech_stack',
  'open_questions',
  'recent_decisions',
  'recurring_context',
  'blocking_issue',
  'task_progress',
  'source_summary',
];

// Trim a full context object down to the summary field set. Returns a plain
// object (never undefined) so callers can embed it directly.
function pickSummaryContext(context) {
  const out = {};
  if (!context || typeof context !== 'object') return out;
  for (const key of SUMMARY_CONTEXT_FIELDS) {
    if (context[key] !== undefined) out[key] = context[key];
  }
  return out;
}

// Lean summary for lists / tree / portfolio views. Matches ContextProjectSummary.
// Recurses into `subprojects` when present (the tree endpoint nests them).
function serializeProjectSummary(project) {
  if (!project || typeof project !== 'object') return project;
  const out = {
    project_id: project.project_id,
    project_name: project.project_name,
    updated_at: project.updated_at,
    aliases: project.aliases || [],
    parent_project_id: project.parent_project_id ?? null,
    workspace_key: project.workspace_key ?? null,
    archived_at: project.archived_at ?? null,
    context: pickSummaryContext(project.context),
  };
  if (Array.isArray(project.subprojects)) {
    out.subprojects = project.subprojects.map(serializeProjectSummary);
  }
  return out;
}

// Full project for detail / write responses, minus the raw event log. Pass
// includeEvents:true only when a caller genuinely needs the log on the wire.
function serializeProjectFull(project, { includeEvents = false } = {}) {
  if (!project || typeof project !== 'object') return project;
  if (includeEvents) return project;
  const { events: _events, ...rest } = project;
  return rest;
}

module.exports = {
  SUMMARY_CONTEXT_FIELDS,
  pickSummaryContext,
  serializeProjectSummary,
  serializeProjectFull,
};
