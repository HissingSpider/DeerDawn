import { z } from 'zod';
import { stripMapCallHints } from '../map-hints.js';
import axios from 'axios';
import fs from 'fs';
import { join, isAbsolute } from 'path';
import type { DeerdawnClient } from '../client.js';
import { handleApiError, isActionableErrorCode, ToolInputError } from '../utils/errors.js';
import { syncProjectFiles, findGitRoot, SKILL_PREFIX } from '../project-sync.js';
import { getHeadSha } from '../worktree-capture.js';
import { computeFreshness, recencyLine, getWorkspaceKey, checkCommitsInHead, getSourcePin } from '../freshness.js';
import { resolveLocalSurface, resolveLocalSurfaceOrNull, resolveIdentifiedSurface, hasSessionStartHook } from '../surface.js';
// Whether the PREVIOUS session's end-of-session flush actually landed — the
// Stop hook has no tool result of its own to fail into.
import { consumeFlushNotice } from '../flush-notice.js';
import { consumeWorkspaceOverrideNotice, isWorkspaceClosureCode } from '../workspace-override.js';
// The gates in front of the automatic first-run seed: what counts as a
// user-authored context file, which workspaces have already been seeded, and the
// per-process claim that stops start_session and connect-time startup from both
// importing at once. See first-run-import.ts for why each one exists.
import {
  LOCAL_CONTEXT_FILENAMES,
  autoImportOptIn,
  claimFirstRunImport,
  findLocalContextFile,
  hasImportedLocalContext,
  readUserAuthoredContext,
  recordLocalContextImport,
  resolveWorkspaceDir,
} from '../first-run-import.js';
import { parseSkillFrontmatter, redactSecretText, buildTaskBoard, buildTaskBoardSnapshot, taskBoardSnapshotForListing, formatArchivedProjectsNotice, formatProjectListing, formatProjectArchivedReply, ARCHIVED_PROJECTS_FETCH_LIMIT, formatPortfolio, formatQuestionResolution, formatTaskCardDetail, normalizeTaskCardInputs, resolveTaskCard, taskCardBodyWasClipped, BOARD_PHASES, GRAPH_NODE_TYPE_VALUES, MAX_TODO_BODY_CHARS, MAX_TRAIL_CHARS, TASK_BODY_MARKER, holdState, proseBudget, taskReviewItems, planReviewedCompletion, describeTaskState, formatLeftAfterReview, stayedOutside, orderLeftSections, NO_REVIEW_ON_RECORD, type TaskReviewItems } from '../../../shared-context/src/index.js';
// Board moves record WHICH agent took the card, so a second agent asking for
// work is not handed something already underway. The server reads it from the
// event metadata, so no tool parameter had to change.
import { buildFirstSessionGuide } from '../../../shared-context/src/firstSessionGuide.js';
import { repoSeedConsented } from '../setup-choices.js';
import { getAgentSessionId } from '../agent-session.js';
import { redactSecrets } from '../redact.js';
import { projectsNamedLike } from '../project-ref.js';
import { resolveWriteTarget, describeWriteRefusal, NO_PROJECT_NEXT_STEP, rememberWriteTarget, isGuessedMatch, type WriteTarget } from '../write-target.js';
import { alternativesLine } from '../routing-hint.js';
import { recordBriefWatermark, checkStale } from '../session-watermark.js';
import { writePeerMirror } from '../peer-mirror.js';
import { blameFile, attributeByBlame, blameContributors } from '../git-blame.js';

const NOW_LINE = /^Now:/;

/**
 * The lines of a /map answer that actually describe something — projects,
 * global context — with the header, the call hints and the per-request
 * "Now:" timestamp removed. Empty means the account has nothing to brief.
 */
export function mapContentLines(map: unknown): string[] {
  if (typeof map !== 'string' || !map) return [];
  // The same prefixes start_session strips before rendering "Other projects"
  // (untrimmed: `→ Name (id)` marks the ACTIVE project and is content, while
  // the indented `  →` / `  Sections` lines are call hints), plus "Now:".
  return map.split('\n').filter((l) => l.trim()
    && !l.startsWith('[DeerDawn')
    && !l.startsWith('→ Call')
    && !l.startsWith('  Sections')
    && !l.startsWith('  →')
    && !NOW_LINE.test(l.trim()));
}

// First-run close-the-loop directive. Shown on every start_session path that
// leaves the project EMPTY (auto-created-from-manifest, and the two manual
// fallbacks) — never on the auto-import path, which already saved real content.
//
// Why this exists: over 2026-07-24..08-07, 14 people started an MCP runtime and
// 13 made successful tool calls, but only 2 ever produced `writeback_recorded`
// and only 2 ever received `context_delivered`. Connecting is not the wall —
// 12 of 14 connected users never saved anything, so session 2 was as cold as
// session 1 and the product never demonstrated itself. The old copy ended with
// "or just work — context captures automatically when each session ends", which
// reads to an agent as "no action required"; end-of-session capture only runs if
// the session actually flushes, so for those 12 nothing was ever written.
//
// Judge this on writeback_recorded / context_delivered per newly-connected
// person, NOT on tool-call volume (which was already healthy).
const FIRST_BRIEF_DIRECTIVE =
  'Next step — write the first brief now, in this session, rather than waiting for end-of-session capture:\n' +
  '  → Call `manage_memory` with action `update` and what you already know about this project: the current task, any decision\n' +
  '    just made, and what is still open. One or two sentences is enough to start.\n\n' +
  'That single call is what makes the next session open already briefed instead of cold. Until something is\n' +
  'saved, every new session starts from zero.';

// finish_task over a brief with no current task. It completes nothing, so it
// records nothing as shipped, and the reply says so rather than "Task marked as
// completed". PARITY: apps/api/src/routes/mcp.js carries the same sentence;
// apps/api/tests/unit/mcp-dispatcher-parity.test.js pins the two together.
export const NO_TASK_TO_COMPLETE = 'No current task was set, so nothing was recorded as shipped.';

// ─── Fetching a Trail by URL ─────────────────────────────────────────────────
// Packs are distributed as links, so `trail` accepts one. The fetch happens
// HERE, on the user's machine, and never by handing the URL to the API: a server
// that fetches caller-supplied URLs is an SSRF primitive pointed at its own
// network, and nothing is gained by it — the agent already has the network
// access, and the file would have been downloaded to this machine anyway.
//
// Nothing here establishes that the bytes are trustworthy; it only bounds what
// they can cost. The .dawn checksum is verified server-side in planImport, and
// import is non-destructive by construction, which is what actually makes
// pulling a stranger's Trail safe.
const TRAIL_URL_MAX_BYTES = 5 * 1024 * 1024;
const TRAIL_URL_TIMEOUT_MS = 15_000;

async function fetchTrailByUrl(url: string): Promise<string> {
  // Parsed by regex rather than `new URL`, because this package lints against a
  // Node-globals config that does not declare the WHATWG URL globals.
  const match = /^(https?):\/\/([^/?#]+)/i.exec(url);
  if (!match) throw new Error(`import_trail: ${url} is not a fetchable URL.`);
  const scheme = match[1].toLowerCase();
  const host = match[2].toLowerCase().replace(/^.*@/, '').replace(/:\d+$/, '');
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (scheme !== 'https' && !loopback) {
    throw new Error(
      'import_trail: refusing to fetch a Trail over plain http. A .dawn is merged into your project memory, ' +
      'so it arrives over https or from a local file.'
    );
  }

  try {
    const response = await axios.get(url, {
      responseType: 'text',
      // Leave the bytes alone: axios would otherwise JSON.parse them, and
      // parseTrail's own error message ("not valid JSON — check it was not
      // truncated") is the more useful one to surface.
      transformResponse: [(value: unknown) => value],
      timeout: TRAIL_URL_TIMEOUT_MS,
      maxContentLength: TRAIL_URL_MAX_BYTES,
      maxBodyLength: TRAIL_URL_MAX_BYTES,
      headers: { Accept: 'application/json, text/plain, */*' },
    });
    const body = typeof response.data === 'string' ? response.data : String(response.data ?? '');
    if (!body.trim()) throw new Error(`import_trail: ${url} returned an empty body.`);
    return body;
  } catch (err: any) {
    if (err?.message?.startsWith?.('import_trail:')) throw err;
    const status = err?.response?.status;
    if (status) throw new Error(`import_trail: ${url} returned HTTP ${status}.`);
    if (err?.code === 'ECONNABORTED') {
      throw new Error(`import_trail: ${url} did not respond within ${TRAIL_URL_TIMEOUT_MS / 1000}s.`);
    }
    if (String(err?.message || '').includes('maxContentLength')) {
      throw new Error(`import_trail: ${url} is larger than the ${TRAIL_URL_MAX_BYTES / (1024 * 1024)}MB limit for a .dawn file.`);
    }
    throw new Error(`import_trail: could not fetch ${url} (${err?.message || 'unknown error'}).`);
  }
}

const VALID_SECTIONS = ['task', 'status', 'decisions', 'stack', 'files', 'hot_paths', 'entrypoints', 'surfaces', 'debugging_notes', 'landmines', 'shipped', 'goals', 'questions', 'constraints', 'description', 'blocking', 'progress', 'board', 'todos', 'all'] as const;

const GetContextSchema = z.object({
  project_id: z.string().optional().describe('Specific project ID. Omit to get the most recently active project.'),
  tool: z.enum(['claude_web', 'chatgpt_web', 'cursor', 'claude_code', 'codex']).optional().default('claude_code'),
  verbosity: z.enum(['light', 'standard', 'detailed']).optional().default('standard'),
  sections: z.array(z.enum(VALID_SECTIONS)).optional().describe('Which sections to return. Default: [task, status]. Use all for full context.'),
  format: z.enum(['text', 'json']).optional().default('text').describe('Return formatted text (default) or structured JSON.'),
});

const SearchContextSchema = z.object({
  query: z.string().min(1).describe('What to search for across all projects — e.g. "decisions about authentication", "open questions about the API", or "what decisions do I need to make next"'),
  limit: z.number().int().min(1).max(10).optional().default(5),
});

const UpdateContextSchema = z.object({
  project_id: z.string().min(1).optional().describe('Optional project ID. If omitted, resolves from the active project in the current cwd.'),
  summary: z.preprocess(
    (value) => (value == null ? '' : String(value)),
    z.string().trim().min(1),
  ).describe('What you learned or what changed — current task, decisions made, status update, key findings'),
  // A DIRECT write for the brief's headline. Extraction owns every other field,
  // but it never once set this one: summaries opening literally "Current task is
  // now: X" came back "task, status and stack are unchanged", so the most-read
  // line in the brief stayed pinned to finished work. The only escape was
  // finish_task, which also discards the open questions and command log hanging
  // off the task — so nobody used it, and the headline rotted.
  task: z.string().trim().min(1).optional()
    .describe('Set the current task directly, bypassing extraction. Use when the headline of the brief should change.'),
  tool: z.string().optional().default('claude_code'),
  commands: z.preprocess(
    (value) => {
      if (value == null) return undefined;
      return Array.isArray(value) ? value : [value];
    },
    z.array(z.object({
      label: z.coerce.string().trim().min(1),
      run: z.coerce.string().trim().min(1),
      note: z.coerce.string().trim().optional(),
    })).optional(),
  ).describe('Key runnable commands to store (e.g. deploy, test, start). Stored by label — new entry overwrites existing with the same label.'),
});

const ListProjectsSchema = z.object({});

const CreateProjectSchema = z.object({
  project_name: z.string().min(1).describe('Name of the project'),
  description: z.string().optional().describe('Brief description of what this project is'),
  parent_project_id: z.string().optional().describe('Optional parent to nest under as a subproject'),
});

const SwitchSubprojectSchema = z.object({
  project_id: z.string().min(1).describe('The subproject to make active for this workspace'),
});

const ArchiveProjectSchema = z.object({
  project_id: z.string().min(1).describe('The project to archive or restore'),
  unarchive: z.boolean().optional().describe('Set true to restore instead of archive'),
});

const SetProjectParentSchema = z.object({
  project_id: z.string().min(1).describe('The project to move'),
  parent_project_id: z.string().optional().describe('Umbrella to nest under; omit to promote to top-level'),
});

const RenameProjectSchema = z.object({
  project_id: z.string().min(1).describe('The project to rename'),
  project_name: z.string().min(1).describe('The new project name'),
});

const WorkspaceOverviewSchema = z.object({
  mode: z.enum(['startup', 'overview']).optional().default('overview'),
  verbosity: z.enum(['light', 'standard', 'detailed']).optional().default('standard'),
  include: z.array(z.enum(['projects', 'knowledge', 'tools', 'capabilities', 'recent'])).optional(),
  format: z.enum(['text', 'json']).optional().default('text'),
});

const WorkspaceEntitiesSchema = z.object({
  types: z.array(z.string()).optional(),
  query: z.string().optional(),
  project_id: z.string().optional(),
  related_project_id: z.string().optional(),
  scope: z.enum(['workspace', 'project']).optional(),
  surface: z.string().optional(),
  status: z.string().optional(),
  include_inferred: z.boolean().optional().default(true),
  include_resolved: z.boolean().optional().default(false),
  curated_only: z.boolean().optional().default(false),
  limit: z.number().int().min(1).max(50).optional().default(10),
  format: z.enum(['text', 'json']).optional().default('text'),
});

// Cross-project read. `limit` bounds the shared-entity list only; the decision
// timeline is deliberately short because this lands in a chat reply, not a page.
const PortfolioSchema = z.object({
  query: z.string().optional(),
  limit: z.number().int().min(1).max(25).optional().default(8),
  format: z.enum(['text', 'json']).optional().default('text'),
});

const MarkResolvedSchema = z.object({
  title: z.string().min(1),
  entity_type: z.enum(['decision', 'knowledge', 'question', 'task', 'capability', 'workflow']).optional(),
  project_id: z.string().optional(),
  notes: z.string().optional(),
});

// The brief's open_questions list, not the workspace graph. See the
// resolve_open_question handler for why this is a separate action from `resolve`.
const ResolveOpenQuestionSchema = z.object({
  question: z.string().trim().min(1, 'question is required — the exact, complete open question as the brief prints it'),
  answer: z.string().trim().min(1, 'answer is required — what the question was decided to be'),
  project_id: z.string().optional(),
});

const ProjectMapSchema = z.object({
  project_id: z.string().optional(),
  verbosity: z.enum(['light', 'standard', 'detailed']).optional().default('standard'),
  format: z.enum(['text', 'json']).optional().default('text'),
});

const KnownPathsSchema = z.object({
  query: z.string().min(1),
  project_id: z.string().optional(),
  limit: z.number().int().min(1).max(25).optional().default(10),
  format: z.enum(['text', 'json']).optional().default('text'),
});

const RecordHotPathsSchema = z.object({
  project_id: z.string().min(1).optional(),
  items: z.array(z.object({
    label: z.string().min(1),
    path: z.string().min(1),
    purpose: z.string().optional(),
    importance: z.enum(['low', 'normal', 'high', 'critical']).optional(),
    pinned: z.boolean().optional(),
  })).min(1),
});

const RecordDebugFindingSchema = z.object({
  project_id: z.string().min(1).optional(),
  summary: z.string().min(1),
  paths: z.array(z.string()).optional().default([]),
  added_at: z.string().optional(),
  commit_ref: z.string().optional(),
  diff_ref: z.string().optional(),
  importance: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  pinned: z.boolean().optional(),
  supersedes: z.string().optional(),
});

const ConfirmClaimSchema = z.object({
  project_id: z.string().min(1).optional(),
  claim: z.string().min(1),
  verified_commit: z.string().optional(),
});

const UpsertWorkspaceEntitiesSchema = z.object({
  entities: z.array(z.object({
    entity_type: z.string().min(1).describe(`Required. One of: ${GRAPH_NODE_TYPE_VALUES.join(', ')}`),
    // `title` is the real required field; `name` is accepted as a backward-compatible
    // alias since many callers guess at that field name instead. At least one of the
    // two must be present — the exact ">= 3 chars" business rule is enforced (with an
    // honest, field-specific error) by the service, not duplicated here.
    title: z.string().optional().describe('Required (or use `name`). Human-readable title, at least 3 characters.'),
    name: z.string().optional().describe('Alias for `title`.'),
    summary: z.string().optional(),
    scope: z.enum(['workspace', 'project']).optional(),
    project_id: z.string().optional(),
    // Set by fileEntitiesUnderProject, never advertised: project_id above is the
    // manage_memory WORKING project, which the server applies by its own rules.
    filed_by_default: z.boolean().optional(),
    canonical_key: z.string().optional(),
    metadata: z.object({
      importance: z.enum(['low', 'normal', 'high', 'critical']).optional(),
      status: z.enum(['active', 'shipped', 'experimental', 'planned', 'deprecated', 'stale', 'resolved', 'archived']).optional(),
      surface: z.string().optional().describe('Optional surface tag (e.g. mcp_tool, api, dashboard) — filterable via get_workspace_entities({ surface }).'),
      pinned: z.boolean().optional(),
      curation_state: z.enum(['inferred', 'promoted', 'curated', 'stale']).optional(),
      source_kind: z.enum(['manual', 'imported', 'inferred']).optional(),
    }).catchall(z.unknown()).optional(),
  }).refine((entity) => Boolean(String(entity.title || entity.name || '').trim()), {
    message: 'entities[].title (or the `name` alias) is required',
  })).min(1),
  relations: z.array(z.object({
    from_canonical_key: z.string().min(1),
    to_canonical_key: z.string().min(1),
    relation_type: z.string().min(1),
    summary: z.string().optional(),
  })).optional(),
});

const NextBestContextSchema = z.object({
  tool: z.enum(['claude_web', 'chatgpt_web', 'cursor', 'claude_code', 'codex']).optional(),
  cwd: z.string().optional(),
  project_id: z.string().optional(),
  limit: z.number().int().min(1).max(10).optional().default(5),
});

const SubagentBriefSchema = z.object({
  project_id: z.string().min(1).optional(),
  task: z.string().trim().min(1).max(2000),
  role: z.string().trim().min(1).max(120).optional(),
  deliverable: z.string().trim().min(1).max(1000).optional(),
  acceptance_criteria: z.array(z.string().trim().min(1).max(500)).max(8).optional().default([]),
  focus_paths: z.array(z.string().trim().min(1).max(500)).max(12).optional().default([]),
  verification: z.array(z.string().trim().min(1).max(500)).max(8).optional().default([]),
  max_tokens: z.number().int().min(120).max(600).optional().default(250),
});

const CleanupContextSchema = z.object({
  project_id: z.string().optional().describe('Optional project ID. Omit to use the active project for cwd.'),
  complete_task: z.boolean().optional().default(false).describe('Force-complete and close the active task now.'),
  ask_questions: z.boolean().optional().default(true).describe('Include open follow-up questions that should be answered.'),
  confirm_complete: z.boolean().optional().default(false).describe('Required with complete_task=true because cleanup clears open task state and command history.'),
});

function coerceConfirmedFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'confirm';
  }
  return false;
}

/**
 * A boolean flag whose FALSE branch is the side-effectful one.
 *
 * coerceConfirmedFlag above can afford to read anything it does not recognise as
 * false: an unparseable confirmation just means nothing happens. `dry_run` is the
 * mirror image — false is the branch that writes — so the same permissiveness
 * fails OPEN. Recognised string and numeric forms are honoured (that they arrive
 * at all is why coerceConfirmedFlag exists, and import_local_context advertises
 * them in its own schema); anything else stops the call rather than picking the
 * writing branch on the caller's behalf.
 */
function coerceOptionalBooleanFlag(value: unknown, label: string): boolean {
  if (value == null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off', ''].includes(normalized)) return false;
  }
  throw new ToolInputError(`${label} must be true or false (got ${JSON.stringify(value)}).`);
}

const VALID_TOOL_SURFACES = new Set(['claude_web', 'chatgpt_web', 'cursor', 'claude_code', 'codex']);
function normalizeToolSurface(value: unknown): 'claude_web' | 'chatgpt_web' | 'cursor' | 'claude_code' | 'codex' {
  const normalized = String(value || '').trim().toLowerCase();
  if (VALID_TOOL_SURFACES.has(normalized)) return normalized as any;
  if (normalized === 'claude' || normalized === 'claude_desktop') return 'claude_code';
  if (normalized === 'chatgpt') return 'chatgpt_web';
  return 'claude_code';
}

function normalizeCommandEntries(input: any): Array<{ label: string; run: string; note?: string }> | undefined {
  if (input == null) return undefined;
  const entries = Array.isArray(input) ? input : [input];
  const normalized = entries.map((entry: any, index: number) => {
    if (typeof entry === 'string') {
      const run = entry.trim();
      if (!run) return null;
      return { label: `cmd_${index + 1}`, run };
    }
    if (!entry || typeof entry !== 'object') return null;
    const label = String(entry.label ?? entry.name ?? '').trim();
    const run = String(entry.run ?? entry.command ?? '').trim();
    const noteRaw = entry.note ?? entry.description;
    if (!label || !run) return null;
    const note = noteRaw == null ? undefined : String(noteRaw).trim();
    return { label, run, note: note || undefined };
  }).filter(Boolean) as Array<{ label: string; run: string; note?: string }>;
  return normalized.length ? normalized : undefined;
}

function normalizeUpdateContextArgs(rawArgs: any) {
  const parsed = UpdateContextSchema.safeParse(rawArgs ?? {});
  if (parsed.success) {
    return {
      project_id: parsed.data.project_id,
      summary: parsed.data.summary,
      task: parsed.data.task,
      tool: normalizeToolSurface(parsed.data.tool),
      commands: normalizeCommandEntries(parsed.data.commands),
    };
  }

  const fallback = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
  const summaryCandidate = fallback.summary ?? fallback.message ?? fallback.update ?? fallback.notes ?? fallback.text;
  const summary = typeof summaryCandidate === 'string' ? summaryCandidate.trim() : '';
  const taskCandidate = fallback.task ?? fallback.current_task;
  const task = typeof taskCandidate === 'string' && taskCandidate.trim() ? taskCandidate.trim() : undefined;
  // Setting the task is a complete instruction on its own — requiring a summary
  // alongside it would just push callers back to the extraction path that cannot
  // set it.
  if (!summary && !task) return null;

  return {
    project_id: typeof fallback.project_id === 'string' && fallback.project_id.trim()
      ? fallback.project_id.trim()
      : (typeof fallback.projectId === 'string' && fallback.projectId.trim() ? fallback.projectId.trim() : undefined),
    summary,
    task,
    tool: normalizeToolSurface(fallback.tool ?? fallback.surface),
    commands: normalizeCommandEntries(fallback.commands ?? fallback.command),
  };
}

// Every project reference on the surface says the same thing, so it says it in
// one place. It used to read "NOT the project name", which was accurate but
// pointed the caller at the one identifier it does not hold: briefs and
// recall({ action: "projects" }) print names, and the id appears once. Names now
// resolve centrally (see project-ref.ts), so advertise the field the way it
// actually behaves — the id when you have it, the name when you don't.
const PROJECT_REF_DESCRIPTION =
  'Project id (project_1a2b3c4d-...) or the project\'s exact name. Omit to use the active project.';

export const contextSyncTools = [
  {
    name: 'recall',
    description: 'Retrieve DeerDawn memory through one tool. Action portfolio reads across every project at once, for what recurs in more than one. Some retrieval actions update selection counters, and every invocation records usage telemetry.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['projects', 'context', 'search', 'overview', 'map', 'paths', 'entities', 'next', 'portfolio'], description: 'The kind of memory to retrieve. Use portfolio for what is shared across projects.' },
        project_id: { type: 'string', description: PROJECT_REF_DESCRIPTION },
        query: { type: 'string', description: 'Topic or path query for search, paths, entities, or portfolio.' },
        sections: { type: 'array', items: { type: 'string' }, description: 'Project brief sections for action=context.' },
        types: { type: 'array', items: { type: 'string' }, description: 'Entity types for action=entities.' },
        scope: { type: 'string', enum: ['workspace', 'project'], description: 'Entity scope for action=entities. workspace looks across ALL of this account\'s projects, which is how you find a service, person, or decision appearing in more than one; project stays inside a single project.' },
        surface: { type: 'string', description: 'Optional entity surface filter.' },
        status: { type: 'string', description: 'Optional entity status filter.' },
        mode: { type: 'string', enum: ['startup', 'overview'], description: 'Overview mode for action=overview.' },
        verbosity: { type: 'string', enum: ['light', 'standard', 'detailed'], description: 'Amount of detail to return.' },
        limit: { type: 'number', description: 'Maximum number of matches.' },
      },
    },
    annotations: { title: 'Recall DeerDawn Memory', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    outputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'manage_projects',
    description: 'Manage projects and subprojects through one tool. Actions can create, select, rename, move, archive, or restore a project. Archive hides a project from normal use, while rename and move replace its current name or hierarchy.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['create', 'select', 'rename', 'move', 'archive', 'restore'] },
        project_id: { type: 'string', description: PROJECT_REF_DESCRIPTION },
        project_name: { type: 'string' },
        description: { type: 'string' },
        parent_project_id: { type: 'string', description: PROJECT_REF_DESCRIPTION },
      },
    },
    annotations: { title: 'Manage Projects', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    outputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'manage_memory',
    description: 'Write or close out DeerDawn memory through one tool. Update the brief, import local context, record paths or findings, upsert entities, confirm or resolve stored knowledge, finish the current task, or move a project between machines as a Trail archive (export_trail writes a private .dawn file — pass kind:"pack" when it is knowledge for other people\'s projects; import_trail merges one in, from a URL, a path or raw contents, without overwriting existing context). Some actions overwrite fields or permanently clear finished task state. Exported Trails are unscanned and private — this tool cannot publish one.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['update', 'import_local', 'record_paths', 'record_finding', 'upsert_entities', 'confirm', 'resolve', 'resolve_question', 'finish_task', 'export_trail', 'import_trail'], description: 'resolve closes a stored workspace entity; resolve_question answers ONE open question in the brief and leaves the rest of it alone.' },
        project_id: { type: 'string', description: 'Project id or exact name. Omit to use the active project. The one exception is action="export_trail", which needs it explicitly and will not guess which project to archive.' },
        summary: { type: 'string' },
        task: { type: 'string', description: "For update: set the brief's current task directly. Extraction cannot change this field, so pass it explicitly whenever the headline of the brief should change." },
        // Trails. export_trail writes a private .dawn archive of the project;
        // import_trail merges one in without overwriting existing context.
        // Neither publishes — publishing runs a separate redaction gate.
        trail: { type: 'string', description: 'For import_trail: an https URL to a .dawn file, a path to one, or the file contents.' },
        kind: { type: 'string', enum: ['project', 'pack'], description: "For export_trail: 'pack' marks the Trail as curated knowledge meant for OTHER projects, so importing it skips this project's task state, goals and board. Default 'project'." },
        output_path: { type: 'string', description: 'For export_trail: where to write the .dawn file. Defaults to the project root.' },
        new_project_name: { type: 'string' },
        dry_run: { type: 'boolean' },
        commands: { type: 'array', items: { type: 'object', additionalProperties: true } },
        items: { type: 'array', items: { type: 'object', additionalProperties: true } },
        paths: { type: 'array', items: { type: 'string' } },
        entities: { type: 'array', items: { type: 'object', additionalProperties: true } },
        relations: { type: 'array', items: { type: 'object', additionalProperties: true } },
        title: { type: 'string' },
        claim: { type: 'string' },
        entity_type: { type: 'string' },
        notes: { type: 'string' },
        question: { type: 'string', description: 'For resolve_question: the exact, complete open question from the brief. A query matching several resolves none and lists them.' },
        answer: { type: 'string', description: 'For resolve_question: what the question was decided to be. Recorded as a decision.' },
        confirmed: { type: 'boolean' },
        path: { type: 'string' },
        complete_task: { type: 'boolean' },
        ask_questions: { type: 'boolean' },
        confirm_complete: { type: 'boolean' },
      },
    },
    annotations: { title: 'Manage Project Memory', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    outputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'manage_tasks',
    description: 'Manage the active project task board. List cards, add new work, move cards between phases, mark work complete, or permanently remove a mistaken card after explicit confirmation. A listing marks cards carrying detail with +body; name those cards in todos with action list to open them in full.',
    inputSchema: {
      type: 'object', required: ['action'], properties: {
        action: { type: 'string', enum: ['list', 'add', 'move', 'complete', 'remove'] },
        project_id: { type: 'string', description: PROJECT_REF_DESCRIPTION },
        todos: { type: 'array', items: { type: 'string' }, description: 'Card titles for add, card IDs or title phrases for other actions, or the cards to open in full for list.' },
        cards: {
          type: 'array',
          description: 'For add: cards with detail. Use instead of todos when a card needs a body. Re-adding an existing title with a body sets that card\'s body.',
          items: {
            type: 'object',
            required: ['title'],
            properties: {
              title: { type: 'string', description: 'Card title, one scannable line.' },
              body: { type: 'string', description: 'The detail: spec, paths, acceptance criteria. Clipped at 2000 characters. Never shown in a listing; opened per card.' },
              phase: { type: 'string', enum: ['backlog', 'blocked', 'in_progress', 'integration', 'testing', 'done'] },
            },
          },
        },
        phase: { type: 'string', enum: ['backlog', 'blocked', 'in_progress', 'integration', 'testing', 'done'] },
        confirm_destructive: { type: 'boolean', description: 'Required for remove, after reviewing the exact cards that will be permanently deleted. Removal is a hard delete with no undo.' },
      },
    },
    annotations: { title: 'Manage Task Board', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    outputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'browse_skills',
    description: 'List shared DeerDawn skills or read one by slug. It does not alter skills, but the invocation records usage telemetry.',
    inputSchema: { type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['list', 'get'] }, project_id: { type: 'string', description: PROJECT_REF_DESCRIPTION }, slug: { type: 'string' } } },
    annotations: { title: 'Browse Shared Skills', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    outputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'manage_skills',
    description: 'Sync enabled shared skills to connected local tools or import a skill from a public GitHub repository. These actions write skill files and may replace an existing skill with the same slug.',
    inputSchema: { type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['sync', 'import_github'] }, repo_url: { type: 'string' }, project_id: { type: 'string' } } },
    annotations: { title: 'Manage Shared Skills', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    outputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'start_session',
    description: 'Start a DeerDawn session and load the active project brief. The call replaces session markers, records a durable session load, may replace generated context files, and records usage telemetry.',
    inputSchema: {
      type: 'object',
      properties: {
        verbosity: { type: 'string', enum: ['light', 'standard'], description: 'How much detail for the active project. Default: standard.' },
      },
    },
  },
  {
    name: 'get_context',
    description: 'Get project context (also available as read_brief). Call this when the user asks about a specific project\'s status, goals, tech stack, open questions, or recent decisions. By default returns only task+status (~30 tokens). Pass sections=[...] to get targeted data, or sections=["all"] for full context. Use start_session at session start instead of this.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Specific project ID. Omit to auto-select the most recently active project.' },
        tool: { type: 'string', enum: ['claude_web', 'chatgpt_web', 'cursor', 'claude_code', 'codex'], description: 'Which tool surface to format context for' },
        verbosity: { type: 'string', enum: ['light', 'standard', 'detailed'], description: 'How much context to include' },
        sections: {
          type: 'array',
          items: { type: 'string', enum: ['task', 'status', 'decisions', 'stack', 'files', 'hot_paths', 'entrypoints', 'surfaces', 'debugging_notes', 'landmines', 'shipped', 'goals', 'questions', 'constraints', 'description', 'blocking', 'progress', 'board', 'todos', 'all'] },
          description: 'Which sections to retrieve. Default: [task, status]. Use ["all"] for everything.',
        },
      },
    },
  },
  {
    name: 'read_brief',
    description: 'Read your project brief — what you shipped, decided, what\'s open, and the landmines — the same brief your AI reads at session start. Alias of get_context; returns the 4-slot brief (SHIPPED / DECIDED / OPEN / LANDMINE) with per-item provenance.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Specific project ID. Omit to auto-select the most recently active project.' },
        tool: { type: 'string', enum: ['claude_web', 'chatgpt_web', 'cursor', 'claude_code', 'codex'], description: 'Which tool surface to format the brief for' },
        verbosity: { type: 'string', enum: ['light', 'standard', 'detailed'], description: 'How much detail to include' },
        sections: {
          type: 'array',
          items: { type: 'string', enum: ['task', 'status', 'decisions', 'stack', 'files', 'hot_paths', 'entrypoints', 'surfaces', 'debugging_notes', 'landmines', 'shipped', 'goals', 'questions', 'constraints', 'description', 'blocking', 'progress', 'board', 'todos', 'all'] },
          description: 'Which slots/sections to retrieve. Omit for the full 4-slot brief.',
        },
      },
    },
  },
  {
    name: 'list_context_map',
    description: 'Get a compact index of all DeerDawn projects and available context sections (~30-50 tokens). Call this at the start of a session to see what\'s available, then call get_context with specific sections for what you need.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'update_context',
    description: 'Push a context update (also available as update_brief). summary = what changed + why (1-2 sentences). Call immediately when triggered, not batched. Also stores runnable commands (deploy, test, start) via the commands param.',
    inputSchema: {
      type: 'object',
      required: ['summary'],
      properties: {
        project_id: { type: 'string', description: 'Optional project ID. If omitted, active project for cwd is used.' },
        summary: { type: 'string', description: 'What changed or what was learned — current task, decision made, open question asked, question answered, status update, key findings' },
        tool: { type: 'string', description: 'Optional surface hint. Host aliases like claude_desktop are accepted and normalized.' },
        commands: {
          type: 'array',
          description: 'Key runnable commands to store. Stored by label — overwrites existing entry with the same label.',
          items: {
            type: 'object',
            required: ['label', 'run'],
            properties: {
              label: { type: 'string', description: 'Short name, e.g. "deploy", "test", "start"' },
              run: { type: 'string', description: 'The full command string to run' },
              note: { type: 'string', description: 'Optional clarification, e.g. "run from monorepo root"' },
            },
          },
        },
      },
    },
  },
  {
    name: 'update_brief',
    description: 'Update your brief — record a decision, an open question, a landmine, or shipped work. Alias of update_context; summary = what changed + why (1-2 sentences). Call immediately when triggered, not batched.',
    inputSchema: {
      type: 'object',
      required: ['summary'],
      properties: {
        project_id: { type: 'string', description: 'Optional project ID. If omitted, active project for cwd is used.' },
        summary: { type: 'string', description: 'What changed or what was learned — a decision made, an open question, a landmine to watch out for, shipped work, or a status update' },
        tool: { type: 'string', description: 'Optional surface hint. Host aliases like claude_desktop are accepted and normalized.' },
        commands: {
          type: 'array',
          description: 'Key runnable commands to store. Stored by label — overwrites existing entry with the same label.',
          items: {
            type: 'object',
            required: ['label', 'run'],
            properties: {
              label: { type: 'string', description: 'Short name, e.g. "deploy", "test", "start"' },
              run: { type: 'string', description: 'The full command string to run' },
              note: { type: 'string', description: 'Optional clarification, e.g. "run from monorepo root"' },
            },
          },
        },
      },
    },
  },
  {
    name: 'list_projects',
    description: 'List all DeerDawn projects for this workspace. Call this when the user asks what projects they have, what they\'re working on, or wants an overview of their work. Also use to find the right project_id before calling get_context or update_context.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'search_context',
    description: 'Search across ALL projects for decisions, goals, tasks, open questions, pending decisions, or any context matching a query. Examples: "decisions about authentication", "projects using PostgreSQL", "what\'s blocking the billing work", "open questions about the API", "what decisions do I need to make". Use this instead of get_context when you don\'t know which project holds the information. If you have not called start_session yet this session, call it first.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Natural language search query across all project context' },
        limit: { type: 'number', description: 'Max results to return (default: 5)' },
      },
    },
  },
  {
    name: 'get_workspace_overview',
    description: 'Workspace overview. mode=startup for compact session orientation, mode=overview when user asks "what am I working on?" or wants a full picture of all projects.',
    inputSchema: {
      type: 'object',
      properties: {
        verbosity: { type: 'string', enum: ['light', 'standard', 'detailed'], description: 'How much detail to include in the overview.' },
        mode: { type: 'string', enum: ['startup', 'overview'], description: 'Use startup for compact session-start context or overview for the full layered brief.' },
        include: {
          type: 'array',
          items: { type: 'string', enum: ['projects', 'knowledge', 'tools', 'capabilities', 'recent'] },
          description: 'Optional subset of sections to include.',
        },
        format: { type: 'string', enum: ['text', 'json'], description: 'Return formatted text (default) or structured JSON.' },
      },
    },
  },
  {
    name: 'get_workspace_entities',
    description: 'Query typed workspace knowledge, tools, environments, capabilities, and workflows for drill-down after the overview.',
    inputSchema: {
      type: 'object',
      properties: {
        types: { type: 'array', items: { type: 'string' }, description: 'Optional entity types to filter.' },
        query: { type: 'string', description: 'Optional text query.' },
        project_id: { type: 'string', description: 'Optional active project to rank against.' },
        related_project_id: { type: 'string', description: 'Filter entities linked to a specific project.' },
        scope: { type: 'string', enum: ['workspace', 'project'], description: 'Optional scope filter.' },
        surface: { type: 'string', description: 'Optional capability surface filter such as mcp_tool, api, dashboard, desktop, or extension.' },
        status: { type: 'string', description: 'Optional lifecycle/status filter such as active, shipped, planned, stale, or resolved.' },
        include_inferred: { type: 'boolean', description: 'Include inferred capability candidates discovered from project files and routes.' },
        include_resolved: { type: 'boolean', description: 'Include resolved and archived entities (default false). Set true or pass status="resolved" to retrieve closed decisions.' },
        curated_only: { type: 'boolean', description: 'Only return curated or promoted entities.' },
        limit: { type: 'number', description: 'Max number of entities to return (default 10).' },
        format: { type: 'string', enum: ['text', 'json'], description: 'Return formatted text (default) or structured JSON.' },
      },
    },
  },
  {
    name: 'get_project_map',
    description: 'Return the durable project map for a project: hot paths, entrypoints, named surfaces, and recent debugging notes. Use this before repo-wide search when you need known file-level orientation.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Optional project ID. Omit to use the active project.' },
        verbosity: { type: 'string', enum: ['light', 'standard', 'detailed'], description: 'How much detail to include.' },
        format: { type: 'string', enum: ['text', 'json'], description: 'Return formatted text (default) or structured JSON.' },
      },
    },
  },
  {
    name: 'find_known_paths',
    description: 'Search DeerDawn durable path memory across hot paths, entrypoints, surfaces, and debugging notes. Use this before repo search when the file might already be known.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Path-oriented query like "auth modal", "signup route", or "workspace setup page".' },
        project_id: { type: 'string', description: 'Optional project ID to scope the search.' },
        limit: { type: 'number', description: 'Max results to return (default 10).' },
        format: { type: 'string', enum: ['text', 'json'], description: 'Return formatted text (default) or structured JSON.' },
      },
    },
  },
  {
    name: 'upsert_workspace_entities',
    description: 'Create or update typed workspace entities and relationships. Use this for durable knowledge, tools, environments, capabilities, or workflows that should persist beyond a single project note.',
    inputSchema: {
      type: 'object',
      required: ['entities'],
      properties: {
        entities: {
          type: 'array',
          description: 'Typed workspace entities to create or update.',
          items: {
            type: 'object',
            required: ['title', 'entity_type'],
            properties: {
              title: { type: 'string', description: 'Required. Human-readable title, at least 3 characters. (Alias: `name`.)' },
              name: { type: 'string', description: 'Alias for `title`, accepted for backward compatibility.' },
              entity_type: { type: 'string', enum: [...GRAPH_NODE_TYPE_VALUES], description: 'Required. The kind of entity being recorded.' },
              summary: { type: 'string', description: 'Optional description of the entity. Must not be generic/low-value filler.' },
              scope: { type: 'string', enum: ['workspace', 'project'], description: 'Optional. Defaults to "project" when project_id is set, else "workspace".' },
              project_id: { type: 'string', description: 'Optional. Scopes the entity to a specific project.' },
              canonical_key: { type: 'string', description: 'Optional. Override the auto-derived dedup key for this entity.' },
              metadata: {
                type: 'object',
                description: 'Optional metadata. Unrecognized keys are preserved.',
                properties: {
                  importance: { type: 'string', enum: ['low', 'normal', 'high', 'critical'] },
                  status: { type: 'string', enum: ['active', 'shipped', 'experimental', 'planned', 'deprecated', 'stale', 'resolved', 'archived'] },
                  surface: { type: 'string', description: 'Optional surface tag (e.g. mcp_tool, api, dashboard) — filterable via get_workspace_entities({ surface }).' },
                  pinned: { type: 'boolean' },
                  curation_state: { type: 'string', enum: ['inferred', 'promoted', 'curated', 'stale'] },
                  source_kind: { type: 'string', enum: ['manual', 'imported', 'inferred'] },
                },
              },
            },
          },
        },
        relations: {
          type: 'array',
          description: 'Optional relationships between workspace entities.',
          items: {
            type: 'object',
            required: ['from_canonical_key', 'to_canonical_key', 'relation_type'],
            properties: {
              from_canonical_key: { type: 'string', description: 'canonical_key of the source entity.' },
              to_canonical_key: { type: 'string', description: 'canonical_key of the target entity.' },
              relation_type: { type: 'string', description: 'Relationship label, e.g. depends_on, implements, related_to.' },
              summary: { type: 'string', description: 'Optional description of the relationship.' },
            },
          },
        },
      },
    },
  },
  {
    name: 'record_hot_paths',
    description: 'Record durable file or folder hot paths for a project after you discover them. Use this when repo search reveals a path future agents should know up front.',
    inputSchema: {
      type: 'object',
      required: ['items'],
      properties: {
        project_id: { type: 'string', description: PROJECT_REF_DESCRIPTION },
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['label', 'path'],
            properties: {
              label: { type: 'string' },
              path: { type: 'string' },
              purpose: { type: 'string' },
              importance: { type: 'string', enum: ['low', 'normal', 'high', 'critical'], description: 'Optional — higher-importance paths survive cap eviction and surface first.' },
              pinned: { type: 'boolean', description: 'Optional — pin a critical path so it is never evicted at the cap.' },
            },
          },
        },
      },
    },
  },
  {
    name: 'record_debug_finding',
    description: 'Record a durable debugging finding for a project, optionally tied to specific paths. Use this after diagnosing a bug or tracing a non-obvious handoff.',
    inputSchema: {
      type: 'object',
      required: ['summary'],
      properties: {
        project_id: { type: 'string', description: PROJECT_REF_DESCRIPTION },
        summary: { type: 'string', description: 'Concise factual finding.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Optional related file paths.' },
        added_at: { type: 'string', description: 'Optional ISO timestamp override.' },
        commit_ref: { type: 'string', description: 'Optional commit SHA or ref that contains the fix, so the finding is replayable.' },
        diff_ref: { type: 'string', description: 'Optional PR/diff URL or identifier for the fix.' },
        importance: { type: 'string', enum: ['low', 'normal', 'high', 'critical'], description: 'Optional — higher-importance findings survive cap eviction and surface first.' },
        pinned: { type: 'boolean', description: 'Optional — pin a critical finding so it is never evicted at the cap.' },
        supersedes: { type: 'string', description: 'Optional — a phrase from a prior finding this one corrects; the stale note is removed so the log holds the correction, not the contradiction.' },
      },
    },
  },
  {
    name: 'confirm_claim',
    description: 'Confirm a stored claim still holds after you actually re-verified it (ran the tests, checked the code/state). Stamps it "verified" so the NEXT session trusts it instead of re-opening the code. Targets a recent decision (matched by a phrase from its summary) or the current status (pass "status").',
    inputSchema: {
      type: 'object',
      required: ['claim'],
      properties: {
        project_id: { type: 'string', description: PROJECT_REF_DESCRIPTION },
        claim: { type: 'string', description: 'A phrase from the decision summary to confirm, or "status" to confirm the current status.' },
        verified_commit: { type: 'string', description: 'Optional commit SHA you verified against; defaults to the current HEAD.' },
      },
    },
  },
  {
    name: 'get_next_best_context',
    description: 'Return the most relevant next context to fetch or use for the current task/session, including open questions and pending decisions ranked for relevance and token efficiency.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', enum: ['claude_web', 'chatgpt_web', 'cursor', 'claude_code', 'codex'], description: 'Optional active tool surface.' },
        cwd: { type: 'string', description: 'Optional current working directory.' },
        project_id: { type: 'string', description: 'Optional active project override.' },
        limit: { type: 'number', description: 'Max ranked suggestions to return (default 5).' },
      },
    },
  },
  {
    name: 'build_subagent_brief',
    description: 'Build a compact, task-scoped prompt for a worker agent. Call once per delegated subtask, then pass only the returned brief using the host\'s isolated/no-history mode when available. The brief includes the objective, success criteria, relevant project facts and paths, watch-outs, and verification under a bounded token target.',
    inputSchema: {
      type: 'object',
      required: ['task'],
      properties: {
        project_id: { type: 'string', description: 'Optional project override. Omit to use the active project for this codebase.' },
        task: { type: 'string', description: 'The concrete, bounded objective delegated to the worker.' },
        role: { type: 'string', description: 'Optional worker role, such as researcher, implementer, reviewer, or tester.' },
        deliverable: { type: 'string', description: 'The exact result the worker should return.' },
        acceptance_criteria: { type: 'array', items: { type: 'string' }, description: 'Explicit success and scope conditions.' },
        focus_paths: { type: 'array', items: { type: 'string' }, description: 'Known files or folders the worker should prioritize.' },
        verification: { type: 'array', items: { type: 'string' }, description: 'Commands or checks the worker should perform.' },
        max_tokens: { type: 'number', minimum: 120, maximum: 600, description: 'Approximate brief token target (default 250).' },
      },
    },
  },
  {
    name: 'cleanup_context',
    description: 'Wrap up task context at handoff/finish time. Reads back the unresolved questions, the blocking issue and the command log attached to the open task. Clears none of them unless complete_task and confirm_complete are both true, which also marks the task completed.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Optional project ID. Omit to use active project by cwd.' },
        complete_task: { type: 'boolean', description: 'Complete and close the active task now. Requires confirm_complete.' },
        ask_questions: { type: 'boolean', description: 'Include unresolved questions in the output checklist.' },
        // Advertised in CleanupContextSchema and enforced, but missing here — so
        // a caller reading this schema could not see the flag it now needs.
        confirm_complete: { type: 'boolean', description: 'Required with complete_task=true: completing clears the open questions, the blocking issue and the command log.' },
      },
    },
  },
  {
    name: 'create_project',
    description: 'Create a new DeerDawn project. Use this when the user starts working on something new that has no existing project. Pass parent_project_id to create it as a subproject (a workstream under an umbrella project) — subprojects keep their own current task and board.',
    inputSchema: {
      type: 'object',
      required: ['project_name'],
      properties: {
        project_name: { type: 'string', description: 'Name of the project' },
        description: { type: 'string', description: 'Brief description' },
        parent_project_id: { type: 'string', description: 'Optional. Create as a subproject under this top-level project. One level deep.' },
      },
    },
  },
  {
    name: 'switch_subproject',
    description: 'Set which subproject is active for THIS codebase, so start_session, update_context, and manage_todos target it by default. Remembered per workspace until you switch again. Use when several subprojects share one repo and you want to work in a specific one.',
    inputSchema: {
      type: 'object',
      required: ['project_id'],
      properties: {
        project_id: { type: 'string', description: 'The subproject to make active for this workspace (from list_projects).' },
      },
    },
  },
  {
    name: 'archive_project',
    description: 'Archive a dead or finished project so it stops cluttering list_projects and never auto-resolves as active. Preserves history; pass unarchive:true to restore. Refuses to archive an umbrella that still has live subprojects.',
    inputSchema: {
      type: 'object',
      required: ['project_id'],
      properties: {
        project_id: { type: 'string', description: 'The project to archive (or restore).' },
        unarchive: { type: 'boolean', description: 'Set true to restore a previously archived project.' },
      },
    },
  },
  {
    name: 'set_project_parent',
    description: 'Re-parent an existing project: nest it under an umbrella with parent_project_id, or promote it to top-level by omitting parent_project_id. Use to gather related projects under one umbrella after the fact. One level deep; the umbrella must be top-level and the moved project must have no subprojects of its own.',
    inputSchema: {
      type: 'object',
      required: ['project_id'],
      properties: {
        project_id: { type: 'string', description: 'The project to move.' },
        parent_project_id: { type: 'string', description: 'Umbrella to nest under. Omit to promote to top-level.' },
      },
    },
  },
  {
    name: 'rename_project',
    description: 'Rename a project (umbrella or subproject). Use to tidy inconsistent, unclear, or shouty project names — the change is immediate and flows into every future brief. Junk names (file paths, "Untitled") are rejected.',
    inputSchema: {
      type: 'object',
      required: ['project_id', 'project_name'],
      properties: {
        project_id: { type: 'string', description: 'The project to rename.' },
        project_name: { type: 'string', description: 'The new name.' },
      },
    },
  },
  {
    name: 'import_local_context',
    description: 'Import context from CLAUDE.md, AGENTS.md, or .cursorrules in the current project directory. First call (no confirmed arg) is FREE — no quota used, returns a preview only. Always preview first, show the user, then call again with confirmed=true to actually import. Use proactively on first connection to any project that has these files but no DeerDawn context yet.',
    inputSchema: {
      type: 'object',
      properties: {
        confirmed: {
          oneOf: [
            { type: 'boolean' },
            { type: 'string', enum: ['true', 'false', '1', '0', 'yes', 'no', 'confirm'] },
            { type: 'integer', enum: [0, 1] },
          ],
          description: 'Set to true after user has confirmed they want to import. Accepts boolean true/false plus common string or numeric forms for client compatibility. If false or omitted, returns a preview of what would be imported.',
        },
        path: { type: 'string', description: 'Override file path. Default: auto-detect CLAUDE.md, AGENTS.md, or .cursorrules in cwd.' },
      },
    },
  },
  {
    name: 'manage_todos',
    description: 'Manage the active project\'s task board — a scrum-style board where every task is a card that moves across phase columns: Backlog → Blocked → In Progress → Integration → Testing → Done. Actions: add (new cards, default to Backlog or a named phase), move (re-column a card to a different phase), complete (shorthand for moving to Done), remove (delete a mistaken card), list (show the board grouped by column). A listing is BOUNDED: each column returns its first cards (Done returns its most recent) with total, returned and has_more, so read a column\'s size from total and never from the number of cards returned. This is the single task tracker for the project.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'move', 'complete', 'remove', 'list'], description: 'add new cards, move a card to another phase, mark cards complete (→ Done), remove erroneous cards, or list the board.' },
        project_id: { type: 'string', description: 'Optional project ID. Omit to use the active project for the current directory.' },
        todos: { type: 'array', items: { type: 'string' }, description: 'For add: card titles to create. For move/complete/remove: card IDs or title substrings to match. For list: cards to open in full.' },
        cards: {
          type: 'array',
          description: 'For add: cards with detail. Use instead of todos when a card needs a body. Re-adding an existing title with a body sets that card\'s body.',
          items: {
            type: 'object',
            required: ['title'],
            properties: {
              title: { type: 'string', description: 'Card title, one scannable line.' },
              body: { type: 'string', description: 'The detail: spec, paths, acceptance criteria. Clipped at 2000 characters. Never shown in a listing; opened per card.' },
              phase: { type: 'string', enum: ['backlog', 'blocked', 'in_progress', 'integration', 'testing', 'done'] },
            },
          },
        },
        phase: { type: 'string', enum: ['backlog', 'blocked', 'in_progress', 'integration', 'testing', 'done'], description: 'For add: the column new cards land in (default backlog). For move: the destination column. Required for move.' },
        cards_per_phase: { type: 'number', minimum: 1, maximum: 50, description: 'For list: cards to return per column (default 20, Done 10). Raise it to see further down a long column. Capped at 50, and lowered further when the whole board would exceed the response budget. Every column still reports its true total and has_more, so a shortened listing is always visible as one.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'mark_resolved',
    description: 'Mark a knowledge or decision entity as resolved so it stops appearing in normal context loads. Resolved entries are still retrievable via get_workspace_entities({ status: "resolved" }). Use when a decision has been implemented, a known issue has been fixed, or a knowledge entry is no longer relevant.',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', description: 'Title or key phrase matching the entity to resolve.' },
        entity_type: { type: 'string', enum: ['decision', 'knowledge', 'question', 'task', 'capability', 'workflow'], description: 'Optional entity type filter. Omit to match any type.' },
        project_id: { type: 'string', description: 'Optional project ID to scope the search.' },
        notes: { type: 'string', description: 'Optional brief note on why/how it was resolved.' },
      },
    },
  },
  {
    name: 'sync_skills',
    description: 'Flush all enabled shared skills to disk for every connected tool (Claude Code, Cursor, Codex). Run after editing a skill so the on-disk copies refresh.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_skills',
    description: 'List available shared skills (name + description, no body). Use on web tools (ChatGPT, Claude.ai) that cannot read skill files from disk.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Optional project ID to scope skills. Omit for workspace-wide skills.' },
      },
    },
  },
  {
    name: 'get_skill',
    description: 'Fetch one shared skill in full (including markdown body) by slug. Call after list_skills when a skill is relevant to the current task.',
    inputSchema: {
      type: 'object',
      required: ['slug'],
      properties: {
        slug: { type: 'string', description: 'The skill slug to fetch.' },
      },
    },
  },
  {
    name: 'import_skill_from_github',
    description: 'Set up a shared skill from a GitHub repo. Paste a repo, folder, or SKILL.md URL — DeerDawn fetches the SKILL.md, reads its frontmatter, saves it as a shared skill, and syncs it to disk for every connected tool (Claude Code, Cursor, Codex).',
    inputSchema: {
      type: 'object',
      required: ['repo_url'],
      properties: {
        repo_url: {
          type: 'string',
          description: 'A public GitHub URL: https://github.com/owner/repo, a /tree/<ref>/<folder> or /blob/<ref>/<path>/SKILL.md link, git@github.com:owner/repo.git, or owner/repo.',
        },
        project_id: { type: 'string', description: 'Optional project ID to scope the skill. Omit for a workspace-wide skill.' },
      },
    },
  },
];

// Parity with the hosted catalog's FIELD_LIMITS.run (apps/api/src/services/mcpSafety.js).
const COMMAND_RUN_MAX_CHARS = 2000;

// ─── CLAUDE.md structured parser ────────────────────────────────────────────

function extractLine(text: string, ...keys: string[]): string {
  for (const key of keys) {
    const m = text.match(new RegExp(`^${key}[:\\s]+(.+)`, 'mi'));
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return '';
}

function extractSectionBullets(text: string, ...keys: string[]): string[] {
  const lines = text.split('\n');
  for (const key of keys) {
    const headerRe = new RegExp(`^${key}[:\\s]*$`, 'i');
    const startIndex = lines.findIndex((line) => headerRe.test(line.trim()));
    if (startIndex === -1) continue;

    const bullets: string[] = [];
    for (let index = startIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];
      const trimmed = line.trim();

      if (!trimmed) {
        if (bullets.length) break;
        continue;
      }

      const bulletMatch = trimmed.match(/^[-*•]\s+(.+)$/);
      if (!bulletMatch) {
        if (bullets.length) break;
        continue;
      }
      bullets.push(bulletMatch[1].trim());
    }

    if (bullets.length) return bullets;
  }
  return [];
}

function extractBulletList(text: string, ...keys: string[]): string[] {
  const sectionBullets = extractSectionBullets(text, ...keys);
  if (sectionBullets.length) return sectionBullets;
  const inline = extractLine(text, ...keys);
  if (inline) return inline.split(/[,|]/).map(s => s.trim()).filter(Boolean);
  return [];
}

function extractDecisions(text: string): Array<{ summary: string; decided_at: string }> {
  const decided_at = new Date().toISOString();
  const bullets = extractSectionBullets(text, 'Recent decisions');
  if (bullets.length) {
    return bullets.filter(Boolean).slice(0, 10).map(summary => ({ summary, decided_at }));
  }
  const inlineRe = /Recent decisions?[:\s]+(.+)/i;
  const inline = inlineRe.exec(text);
  if (inline) return inline[1].split(/\|/).map(s => s.trim()).filter(Boolean).slice(0, 5).map(summary => ({ summary, decided_at }));
  return [];
}

// The API's per-value cap on a context PATCH (CONTEXT_TEXT_MAX in
// apps/api/src/routes/context/context-sync.js). A PATCH carrying ONE longer string
// is refused whole with 400 field_too_long, so a single run-on "Description:" or
// "Task:" line in a CLAUDE.md sank the entire structured import — first as a
// bare "Invalid request parameters", leaving the freshly created project empty.
const CONTEXT_PATCH_TEXT_MAX = 4000;

// Clips every string in the patch to the cap, in place, with an ellipsis, and
// returns the top-level fields it touched so the import can say so. Clipping
// beats skipping: the opening of a long description is still the description.
function clipOverlongFields(patch: Record<string, any>, max = CONTEXT_PATCH_TEXT_MAX): string[] {
  const clipped = new Set<string>();
  const clip = (value: any, field: string): any => {
    if (typeof value === 'string') {
      if (value.length <= max) return value;
      clipped.add(field);
      return `${value.slice(0, max - 1)}…`;
    }
    if (Array.isArray(value)) return value.map((item) => clip(item, field));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clip(child, field)]));
    }
    return value;
  };
  for (const field of Object.keys(patch)) patch[field] = clip(patch[field], field);
  return [...clipped];
}

function parseStructuredContext(content: string, clippedOut?: string[]): Record<string, any> {
  const patch: Record<string, any> = {};
  const task = extractLine(content, 'Current task', 'Task');
  if (task) patch.current_task = task;
  const status = extractLine(content, 'Current status', 'Status');
  if (status) patch.current_status = status;
  const blocking = extractLine(content, 'Blocking issue', 'Blocker', 'Blocked on', 'Blocking');
  if (blocking) patch.blocking_issue = blocking;
  const progress = extractLine(content, 'Task progress', 'Progress');
  if (progress) patch.task_progress = progress;
  const stack = extractBulletList(content, 'Tech stack', 'Default stack', 'Stack');
  if (stack.length) patch.tech_stack = stack;
  const goals = extractBulletList(content, 'Goals', 'Objectives');
  if (goals.length) patch.goals = goals;
  const questions = extractBulletList(content, 'Open questions', 'Questions');
  if (questions.length) patch.open_questions = questions;
  const constraints = extractBulletList(content, 'Recurring context', 'Constraints', 'Rules', 'Always');
  if (constraints.length) patch.recurring_context = constraints;
  const files = extractBulletList(content, 'Key files', 'Relevant files', 'File structure');
  if (files.length) patch.file_structure_summary = files;
  const decisions = extractDecisions(content);
  if (decisions.length) patch.recent_decisions = decisions;
  const description = extractLine(content, 'Description', 'About');
  if (description && description.length > 10) patch.description = description;
  const clipped = clipOverlongFields(patch);
  if (clippedOut) clippedOut.push(...clipped);
  return patch;
}

/**
 * Drop the sections parseStructuredContext already claimed, so extraction is not
 * paid to re-read them.
 *
 * It deliberately does NOT also strip DeerDawn's own usage instructions, even
 * though this is the last stop before the extraction pipeline and therefore looks
 * like the place to do it. `content` reaching here has already been through
 * readUserAuthoredContext -> stripDeerdawnBoilerplate, which owns that rule.
 *
 * Two reasons to leave it there rather than duplicate it here. It is not the only
 * consumer: the same text decides whether the file clears MIN_USER_AUTHORED_CHARS
 * and counts as an import at all, supplies the heading the project is NAMED
 * after, and feeds the confirm-step preview — a copy here would leave every one
 * of those still reading our own setup page as the user's project. And a second
 * implementation of "is this our boilerplate" in a second module is the shape
 * that has already cost this codebase real bugs; one rule, one owner.
 */
function stripStructuredSections(content: string): string {
  const STRUCTURED_HEADERS = [
    'current task', 'task', 'current status', 'status', 'blocking issue', 'blocker',
    'blocked on', 'task progress', 'progress', 'tech stack', 'default stack', 'stack',
    'goals', 'objectives', 'open questions', 'questions', 'recurring context', 'constraints',
    'rules', 'key files', 'relevant files', 'file structure', 'recent decisions',
    'description', 'about me', 'about', 'preferences',
  ];
  const headerRe = new RegExp(`^(${STRUCTURED_HEADERS.join('|')})[:\\s]`, 'i');
  const lines = content.split('\n');
  let inStructured = false;
  const kept: string[] = [];
  for (const line of lines) {
    if (headerRe.test(line.trim())) { inStructured = true; continue; }
    if (inStructured && /^[ \t]*[-*•]\s+/.test(line)) continue;
    if (inStructured && line.trim() === '') { inStructured = false; continue; }
    inStructured = false;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

// ─── Delta formatter ─────────────────────────────────────────────────────────

/** Human labels for delta fields that deserve a specific phrasing. */
const DELTA_SCALAR_LABELS: Record<string, string> = {
  current_task: 'Task',
  current_status: 'Status',
  blocking_issue: 'Blocking',
  task_progress: 'Progress',
  next_action: 'Next action',
  description: 'Description',
  category: 'Category',
  source_summary: 'Summary',
  you_profile: 'Profile',
};

/** Delta fields that are lists; value shape decides how each item renders. */
const DELTA_LIST_LABELS: Record<string, string> = {
  recent_decisions: 'decision',
  shipped: 'shipped item',
  landmines: 'landmine',
  debugging_notes: 'debugging note',
  open_questions: 'open question',
  resolved_questions: 'resolved question',
  resolved_decisions: 'resolved decision',
  resolved_landmines: 'resolved landmine',
  completed_goals: 'completed goal',
  goals: 'goal',
  tech_stack: 'stack entry',
  recurring_context: 'constraint',
  file_structure_summary: 'file note',
  commands: 'command',
  hot_paths: 'hot path',
  entrypoints: 'entry point',
  surfaces: 'surface',
  task_steps: 'task step',
  add_todos: 'card added',
  move_todos: 'card moved',
};

/** Pull something printable out of a list item without assuming its shape. */
function deltaItemText(item: any): string {
  if (item === null || item === undefined) return '';
  if (typeof item === 'string') return item;
  // Path-shaped entries (hot_paths, entrypoints) and commands carry their real
  // content in a second field — a bare label tells the user nothing about what
  // was recorded.
  if (item.label && item.path) return `${item.label} → ${item.path}`;
  if (item.label && item.run) return `${item.label} → ${item.run}`;
  return String(item.summary ?? item.title ?? item.label ?? item.name ?? item.match ?? JSON.stringify(item));
}

/**
 * Report what the update actually changed.
 *
 * This used to inspect SEVEN of the delta's twenty-nine fields. A summary that
 * extracted cleanly into `shipped`, `next_action`, `landmines`, `hot_paths`,
 * `debugging_notes` — anything outside that hardcoded handful — produced no lines
 * and was reported as "no material changes extracted (summary may have been too
 * vague...)". The delta had been applied. The write succeeded. The tool said
 * nothing happened and blamed the caller's wording, which is the worst possible
 * combination: it invites the agent to rewrite a summary that worked, and it
 * teaches users the product ignores them.
 *
 * So the reporting is now driven off the delta's own keys. Unlabelled fields
 * still get reported generically, which means adding a field to
 * ContextDeltaSchema can never silently reintroduce this.
 */
/**
 * Did the extraction actually change anything?
 *
 * Asked of the delta itself, never by sniffing formatDelta's prose for a magic
 * substring — that coupling meant any reword of the message silently flipped the
 * caller's behaviour.
 */
function deltaHasChanges(result: any): boolean {
  const delta = (result?.extraction ?? result)?.delta ?? {};
  return Object.values(delta).some((v) => {
    if (v === null || v === undefined || v === '') return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'string') return v.trim().length > 0;
    if (typeof v === 'object') return Object.keys(v as object).length > 0;
    return true;
  });
}

// Did `task` land as `live` with storage redaction masking part of it? For an
// API that predates the `redacted` flag on PATCH: every [REDACTED] marker in the
// stored value stands for some non-empty run of what was sent, and everything
// around the markers must match exactly. A dropped write leaves the OLD task,
// which fails this unless it is itself a masked rendering of the new one.
export function taskLandedRedacted(task: string, live: string): boolean {
  const MARKER = /\[REDACTED\]/i;
  if (!MARKER.test(live)) return false;
  const pattern = live
    .split(MARKER)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\S]+?');
  return new RegExp(`^${pattern}$`).test(task);
}

function formatDelta(
  projectName: string,
  result: any,
  opts: { summaryRecorded?: boolean; summary?: string } = {},
): string {
  const extraction = result?.extraction ?? result;
  const delta = extraction?.delta ?? {};
  const name = projectName || result?.project?.project_name || 'project';
  const lines: string[] = [];
  const reported = new Set<string>();

  for (const [key, label] of Object.entries(DELTA_SCALAR_LABELS)) {
    reported.add(key);
    const v = delta[key];
    if (typeof v === 'string' && v.trim()) lines.push(`${label} → "${v.trim()}"`);
  }

  for (const [key, noun] of Object.entries(DELTA_LIST_LABELS)) {
    reported.add(key);
    const v = delta[key];
    if (!Array.isArray(v) || v.length === 0) continue;
    // Name the items when there are few — "Added decision: X" is far more useful
    // than "1 decision" — and collapse to a count once a list gets long.
    if (v.length <= 3) {
      for (const item of v) {
        const text = deltaItemText(item);
        if (text) lines.push(`${noun.charAt(0).toUpperCase()}${noun.slice(1)}: ${text}`);
      }
    } else {
      lines.push(`${v.length} ${noun}s updated`);
    }
  }

  // Catch-all: any delta key we have not labelled still gets reported, so a new
  // schema field is visibly unpolished rather than invisibly dropped.
  for (const [key, v] of Object.entries(delta)) {
    if (reported.has(key)) continue;
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length) lines.push(`${key}: ${v.length} item${v.length > 1 ? 's' : ''}`);
    } else if (typeof v === 'object') {
      lines.push(`${key} updated`);
    } else {
      lines.push(`${key} → "${String(v)}"`);
    }
  }

  // The server lost the race with other writers on every attempt and saved
  // none of the summary. Said first, whatever else extraction applied: an
  // "Updated" headline over a decision that did not land is the silent success.
  // PARITY: apps/api/src/routes/mcp.js explainNotStored ('conflict').
  if (result?.reason === 'conflict' && !opts.summaryRecorded) {
    const why = result.refusal_message || 'other writes to this project kept landing at the same moment, so nothing was saved. Retry.';
    const also = lines.length ? `\n  (Applied from extraction all the same:\n${lines.map(l => `  • ${l}`).join('\n')})` : '';
    return `Your summary was NOT saved to "${name}" — ${why}${also}`;
  }
  if (lines.length === 0) {
    // An empty delta does NOT mean nothing was written: update_context also
    // records the summary itself as a decision, and that write usually succeeds
    // when extraction finds no new structured fields. Saying "nothing was added"
    // here was still false — just less obviously than the old "too vague" text.
    if (opts.summaryRecorded) {
      const recorded = String(opts.summary ?? '').trim();
      const shown = recorded.length > 120 ? `${recorded.slice(0, 117)}…` : recorded;
      return `Updated "${name}":\n  • Decision recorded: ${shown || 'your summary'}\n  (Extraction found no additional structured fields — task, status and stack are unchanged.)`;
    }
    // A REFUSAL is not a broken write path, and telling the caller to retry one
    // sends them round in a circle. The API says which it was.
    if (result?.reason === 'forbidden') {
      return `Nothing was written to "${name}" — ${result.refusal_message || 'you do not have write access to this part of the project.'}`;
    }
    return `Nothing was written to "${name}" — extraction returned an empty delta AND the decision write failed. Retry; if it persists, the write path is broken.`;
  }
  return `Updated "${name}":\n${lines.map(l => `  • ${l}`).join('\n')}`;
}

// isTaskCompleted lived here and read the brief's own status text for
// /(completed|done|shipped|closed)/ to decide whether finish_task should clear
// the open questions, the blocking issue and the command log. It is gone rather
// than merely unused: a status line is prose a person wrote about their work,
// and the day it is read as an instruction to destroy that work is the day
// "Shipped PR 488; now verifying the deploy" empties a live brief. See the
// cleanup_context handler for the rule that replaced it.

function fuzzyTodoMatch(title: unknown, query: unknown): boolean {
  const a = String(title || '').toLowerCase().trim();
  const b = String(query || '').toLowerCase().trim();
  return Boolean(a) && Boolean(b) && (a.includes(b) || b.includes(a));
}

// move/complete/remove each resolve EVERY query to exactly one card through
// shared-context's resolveTaskCard — the same rule the merge applies — and the
// event then names that card by ID, so the write cannot land on a different or
// additional card than the one reported. They used to fuzzy-match, and one
// "auth" completed every card whose title contained it. An ambiguous query
// writes nothing and lists the candidates with their ids.
//
// PARITY: apps/api/src/routes/mcp.js (hosted dispatcher) does the same.
function resolveTodoQueries(cards: any[], queries: string[]) {
  const resolutions = (queries || []).map((q) => resolveTaskCard(cards, q));
  return {
    matched: resolutions.filter((r): r is { status: 'matched'; query: string; card: any } => r.status === 'matched'),
    ambiguous: resolutions.filter((r): r is { status: 'ambiguous'; query: string; candidates: Array<{ id: string; title: string; phase?: string }> } => r.status === 'ambiguous'),
    unmatched: resolutions.filter((r) => r.status === 'unmatched').map((r) => r.query),
  };
}

// A title -> {phase, body} index of every card a project stores, Done included.
//
// manage_tasks builds its `add` reply by comparing one of these from BEFORE the
// write against one from after. It reads todo_items (and the legacy
// completed_todos the Done column folds in) rather than the rendered board,
// because those are exactly the rows the merge in shared-context consults —
// task_steps render as derived cards and are not rows, so a step must not make a
// real card look like it already existed.
//
// PARITY: indexBoardCardsByTitle in apps/api/src/routes/mcp.js.
// A card's title as the SERVER stores it: masked by the storage redactor
// (shared-context's copy, kept identical to the API's), then trimmed and
// lowercased the way the merge compares them. The board holds the masked form,
// so a title naming a key compared RAW never matched its own card and the reply
// said "Not on the board after the write … may be at its card limit" over a card
// that had landed. Masking is idempotent, so a stored title keys to itself.
function storedTitleKey(title: unknown): string {
  return String(redactSecretText(String(title || '')) || '').trim().toLowerCase();
}

function indexTaskCardsByTitle(context: Record<string, any> | null | undefined): Map<string, { phase: string; body: string }> {
  const ctx = context || {};
  const cards = [
    ...(Array.isArray(ctx.todo_items) ? ctx.todo_items : []),
    ...(Array.isArray(ctx.completed_todos) ? ctx.completed_todos.map((card: any) => ({ ...card, phase: 'done' })) : []),
  ];
  const byTitle = new Map<string, { phase: string; body: string }>();
  for (const card of cards) {
    const key = storedTitleKey(card?.title);
    if (!key || byTitle.has(key)) continue;
    byTitle.set(key, { phase: String(card?.phase || 'backlog'), body: String(card?.body || '') });
  }
  return byTitle;
}

const phaseLabel = (phase: unknown) => String(phase || '').replace(/_/g, ' ');

function formatAmbiguousTodos(ambiguous: Array<{ query: string; candidates: Array<{ id: string; title: string; phase?: string }> }>, verb: string): string {
  return ambiguous.map((r) => [
    `"${r.query}" matches ${r.candidates.length} cards, so nothing was ${verb} for it. Re-run with the card id:`,
    ...r.candidates.map((c) => `    - "${c.title}" [${c.id}]${c.phase ? ` (${String(c.phase).replace(/_/g, ' ')})` : ''}`),
  ].join('\n')).join('\n');
}

/**
 * Explain a miss instead of just reporting one.
 *
 * "No matching card found" is a dead end: the caller cannot tell whether the
 * title is wrong, the card is in a column they did not look at, or the card is a
 * derived step that cannot be moved at all. Each needs a different next move, so
 * name which one it is.
 */
function explainTodoMiss(board: any[], query: string): string {
  const all = board.flatMap((col: any) => (col.cards || []).map((c: any) => ({ ...c, column: col.label })));

  // Derived step cards are a read-only projection of task_steps — they render on
  // the board but have no persisted row, so an event naming one would apply to
  // nothing. Say so rather than letting it look like a title typo.
  const step = all.find((c) => c.kind === 'step' && (c.id === query || fuzzyTodoMatch(c.title, query)));
  if (step) {
    return `"${query}" is a derived step card from the current task, not a board card — it can't be moved. Edit the task itself, or add a real card with action:"add".`;
  }

  // Suggestions must use a DIFFERENT measure than the matcher, or they can never
  // fire: fuzzyTodoMatch is bidirectional containment, so any title a containment
  // score would surface here has already matched and never reached this function.
  // Token overlap catches precisely what containment misses — reworded, reordered,
  // or partially-remembered titles ("trim the tool schemas" vs "Trim tool schema
  // descriptions"), which is the realistic way an agent gets a title wrong.
  const tokenize = (v: unknown) =>
    new Set(String(v || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  const qTokens = tokenize(query);
  const near = qTokens.size
    ? all
      .map((c) => {
        const tTokens = tokenize(c.title);
        let shared = 0;
        for (const t of qTokens) if (tTokens.has(t)) shared += 1;
        return { c, score: shared / qTokens.size, shared };
      })
      // Two shared words, or half the query, is a real lead rather than noise.
      .filter((x) => x.shared >= 2 || x.score >= 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
    : [];

  if (near.length) {
    const suggestions = near.map((x) => `    - "${x.c.title}" [${x.c.id}] (${x.c.column})`).join('\n');
    return `"${query}" didn't match exactly. Did you mean:\n${suggestions}\n  Card IDs always match exactly — prefer those.`;
  }

  return `"${query}" — no card with that title or id. Call action:"list" to see the board.`;
}

// Which board was searched. "No card with that title" is not much of an answer
// when the caller cannot tell WHICH board answered it: a hosted client sends no
// cwd, and a local one may be pinned to a subproject, so the project is resolved
// out of stored state rather than out of the request.
function describeTodoMisses(board: any[], unmatched: string[], projectName: string): string {
  return [
    `Nothing in ${projectName} matched:`,
    ...unmatched.map((t) => `  ${explainTodoMiss(board, t)}`),
  ].join('\n');
}

// ─── Tech stack inference ────────────────────────────────────────────────────

const KNOWN_DEPS: Record<string, string> = {
  // Frontend
  next: 'Next.js', react: 'React', 'react-dom': 'React', vue: 'Vue', nuxt: 'Nuxt',
  svelte: 'Svelte', '@angular/core': 'Angular', remix: 'Remix',
  // TypeScript / runtime
  typescript: 'TypeScript', 'ts-node': 'TypeScript',
  // Databases
  pg: 'PostgreSQL', postgres: 'PostgreSQL', '@neondatabase/serverless': 'Neon/PostgreSQL',
  mysql2: 'MySQL', mongodb: 'MongoDB', mongoose: 'MongoDB',
  redis: 'Redis', ioredis: 'Redis', '@upstash/redis': 'Redis',
  // ORMs
  prisma: 'Prisma', '@prisma/client': 'Prisma', 'drizzle-orm': 'Drizzle ORM',
  typeorm: 'TypeORM', sequelize: 'Sequelize',
  // Validation
  zod: 'Zod', yup: 'Yup', joi: 'Joi',
  // Backend
  express: 'Express', fastify: 'Fastify', hono: 'Hono', koa: 'Koa',
  // AI SDKs
  anthropic: 'Anthropic SDK', '@anthropic-ai/sdk': 'Anthropic SDK', openai: 'OpenAI SDK',
  // Testing
  vitest: 'Vitest', jest: 'Jest', mocha: 'Mocha',
  // Build / infra
  tsup: 'tsup', esbuild: 'esbuild', vite: 'Vite', webpack: 'Webpack',
  // Auth
  '@clerk/nextjs': 'Clerk', '@clerk/clerk-sdk-node': 'Clerk',
  // MCP
  '@modelcontextprotocol/sdk': 'MCP SDK',
};

function inferTechStackFromManifest(dir: string): string[] {
  const labels = new Set<string>();
  // Collect root + workspace package.json files (monorepo-aware)
  const pkgPaths: string[] = [];
  const rootPkg = join(dir, 'package.json');
  if (fs.existsSync(rootPkg)) pkgPaths.push(rootPkg);
  for (const wsDir of ['apps', 'packages', 'services', 'libs', 'modules']) {
    const ws = join(dir, wsDir);
    if (!fs.existsSync(ws)) continue;
    try {
      for (const entry of fs.readdirSync(ws, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const p = join(ws, entry.name, 'package.json');
        if (fs.existsSync(p)) pkgPaths.push(p);
      }
    } catch { /* non-fatal */ }
  }
  for (const pkgPath of pkgPaths) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
        const label = KNOWN_DEPS[dep];
        if (label) labels.add(label);
      }
    } catch { /* non-fatal */ }
  }
  try {
    const reqPath = join(dir, 'requirements.txt');
    if (fs.existsSync(reqPath)) {
      for (const line of fs.readFileSync(reqPath, 'utf8').split('\n')) {
        const pkg = line.split(/[>=<!\s]/)[0].toLowerCase().trim();
        if (KNOWN_DEPS[pkg]) labels.add(KNOWN_DEPS[pkg]);
      }
    }
  } catch { /* non-fatal */ }
  return Array.from(labels);
}

// ─── Local skill detection (detect-only, never silent upload) ─────────────────

type LocalSkillProposal = { slug: string; name: string; description: string; file: string };

// Scan .claude/skills/<slug>/SKILL.md in the project dir and propose any
// user-authored skills for import. Our own deerdawn-* output is skipped so a
// confirm never re-imports what writeSkills just wrote (infinite mirror). This
// DETECTS only — the actual upsert happens on explicit confirmation elsewhere.
function detectLocalSkills(searchDir: string): LocalSkillProposal[] {
  const found: LocalSkillProposal[] = [];
  try {
    const skillsRoot = join(searchDir, '.claude', 'skills');
    if (!fs.existsSync(skillsRoot)) return found;
    for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const slug = entry.name;
      if (slug.startsWith(SKILL_PREFIX)) continue; // ours — skip
      const file = join(skillsRoot, slug, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      try {
        const { name, description } = parseSkillFrontmatter(fs.readFileSync(file, 'utf8'));
        found.push({ slug, name: name || slug, description: description || '', file });
      } catch { /* skip unreadable skill */ }
    }
  } catch { /* non-fatal */ }
  return found;
}

// ─── Importing a local CLAUDE.md / AGENTS.md / .cursorrules ──────────────────
//
// Two callers, one implementation: the `import_local_context` tool (a person
// asked for this) and runFirstRunImport below (nobody asked — the workspace was
// empty on first connection and we seeded it). The difference is carried by
// `auto`, and `auto` only ever NARROWS what may be written. There is no path
// through here that writes more because nobody was watching.

type LocalImportOutcome =
  | { kind: 'not_found'; text: string }
  | { kind: 'preview'; text: string }
  | { kind: 'blocked'; text: string }
  | { kind: 'imported'; text: string; project_id: string; project_name: string; source: string }
  | { kind: 'kept'; text: string; project_id: string; project_name: string; source: string };

type ImportEventName =
  | 'context_import_viewed'
  | 'context_import_started'
  | 'context_import_succeeded'
  | 'context_import_failed';

/** Does the stored context already answer this field? */
function fieldHasContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

/**
 * Reuses the context_import_* names the dashboard's import flow already emits,
 * so the MCP path lands in the SAME funnel rather than a parallel one nobody
 * has a chart for. Fire-and-forget, and guarded on the method existing:
 * telemetry must never decide whether someone's context gets imported.
 */
function emitImportEvent(
  client: DeerdawnClient,
  eventName: ImportEventName,
  metadata: Record<string, unknown>,
): void {
  const record = (client as { recordProductEvent?: (e: unknown) => Promise<unknown> })?.recordProductEvent;
  if (typeof record !== 'function') return;
  try {
    void Promise.resolve(record.call(client, {
      event_name: eventName,
      source: 'mcp',
      surface: resolveLocalSurfaceOrNull(),
      metadata,
    })).catch(() => null);
  } catch { /* never block an import on an event */ }
}

async function importLocalContextFile(
  client: DeerdawnClient,
  opts: {
    path?: string;
    confirmed: boolean;
    auto?: boolean;
    /**
     * The project this directory is already BOUND to (a linked-path match).
     * When known, the import fills that project instead of deriving a name from
     * the file's heading — which is how an empty "acme" project ends up with a
     * near-duplicate "Acme Platform" beside it, both for the same repo.
     */
    projectId?: string | null;
    projectName?: string | null;
  },
): Promise<LocalImportOutcome> {
  const searchDir = resolveWorkspaceDir();
  const candidates = [
    opts.path,
    ...LOCAL_CONTEXT_FILENAMES.map((name) => join(searchDir, name)),
  ].filter(Boolean) as string[];

  let foundPath: string | null = null;
  let content = '';
  for (const candidate of candidates) {
    // readUserAuthoredContext strips the blocks project-sync wrote into these
    // very files. Without that, importing AGENTS.md feeds DeerDawn's own brief
    // back to itself as if the user had written it — context out of nothing.
    const authored = readUserAuthoredContext(candidate);
    if (authored) { foundPath = candidate; content = authored; break; }
  }

  // Detect-only skill proposal (§3.9): surface user-authored skills found
  // under .claude/skills/ but never upload them silently — the user must
  // confirm before any upsertSkill runs.
  const skillProposal = detectLocalSkills(searchDir);
  const skillProposalText = skillProposal.length
    ? `\n\nDetected ${skillProposal.length} local skill${skillProposal.length === 1 ? '' : 's'} under .claude/skills/ (not yet imported — confirm to share across tools):\n${skillProposal.map(s => `  • ${s.name} (${s.slug})${s.description ? ` — ${s.description}` : ''}`).join('\n')}`
    : '';

  if (!foundPath) {
    if (opts.confirmed) {
      emitImportEvent(client, 'context_import_failed', {
        reason: 'no_local_context_file', trigger: opts.auto ? 'auto' : 'manual', path: searchDir,
      });
    }
    if (skillProposal.length) {
      return { kind: 'not_found', text: `No CLAUDE.md, AGENTS.md, or .cursorrules found.${skillProposalText}` };
    }
    return {
      kind: 'not_found',
      text: 'No CLAUDE.md, AGENTS.md, or .cursorrules found in the current directory. Create one and try again, or use manage_projects with action "create" to start fresh.',
    };
  }

  const sourceName = foundPath.split(/[/\\]/).pop() || foundPath;

  if (!opts.confirmed) {
    const preview = content.slice(0, 300) + (content.length > 300 ? '…' : '');
    // Show a preview of what would be parsed
    const parsed = parseStructuredContext(content);
    const previewFields: string[] = [];
    if (parsed.current_task) previewFields.push(`Task: ${parsed.current_task}`);
    if (parsed.current_status) previewFields.push(`Status: ${parsed.current_status}`);
    if (parsed.tech_stack?.length) previewFields.push(`Stack: ${parsed.tech_stack.join(', ')}`);
    if (parsed.goals?.length) previewFields.push(`Goals: ${parsed.goals.length} items`);
    if (parsed.recent_decisions?.length) previewFields.push(`Decisions: ${parsed.recent_decisions.length} items`);
    const structuredSummary = previewFields.length
      ? `\nStructured fields detected:\n${previewFields.map(f => `  • ${f}`).join('\n')}\n`
      : '';
    emitImportEvent(client, 'context_import_viewed', {
      file: sourceName, chars: content.length, fields_detected: Object.keys(parsed).length, path: searchDir,
    });
    return {
      kind: 'preview',
      text: `Found ${foundPath} (${content.length} chars).${structuredSummary}\nPreview:\n${preview}\n\nCall manage_memory(action:"import_local", confirmed:true) to import. Structured fields are imported directly (no LLM cost); remaining text goes through extraction.${skillProposalText}`,
    };
  }

  const trigger = opts.auto ? 'auto' : 'manual';
  emitImportEvent(client, 'context_import_started', { file: sourceName, chars: content.length, trigger, path: searchDir });

  try {
    // Extract project name from file content.
    //
    // The filename strip has to apply to EVERY branch. It used to sit on the
    // first one only, so a file opening `# CLAUDE.md` — which is most of them —
    // fell through to the last branch and came back with the filename as the
    // project name. That is not cosmetic: this name is the key the
    // existing-project match below looks up, so a wrong one can miss the project
    // it should have filled and create a duplicate beside it.
    const stripContextFileName = (raw?: string | null): string =>
      (raw || '').replace(/\b(?:CLAUDE|AGENTS)\.md\b/i, '').replace(/\.cursorrules\b/i, '').trim();
    const nameFromContent =
      stripContextFileName(content.match(/^#+\s+(.+)/m)?.[1]) ||
      content.match(/^[Pp]roject[:\s]+(.+)/m)?.[1]?.trim() ||
      stripContextFileName(content.match(/^#\s*(.+)/m)?.[1]);
    // The directory the file actually sits in. The old slice(-3, -2) took the
    // GRANDPARENT, so a headingless CLAUDE.md in ~/code/acme named the project
    // "code" — and the name is what the existing-project match below keys on,
    // which makes a wrong name a correctness problem, not just a cosmetic one.
    const fileDir = foundPath.includes('/') || foundPath.includes('\\')
      ? foundPath.slice(0, Math.max(foundPath.lastIndexOf('/'), foundPath.lastIndexOf('\\')))
      : searchDir;
    const dirName = fileDir.split(/[/\\]/).filter(Boolean).pop() || 'My Project';
    let projectName = (nameFromContent && nameFromContent.length < 60 ? nameFromContent : dirName);

    // Find or create project
    let pid: string;
    let projectExisted = false;
    if (opts.projectId) {
      pid = opts.projectId;
      projectName = opts.projectName || projectName;
      // Bound, therefore pre-existing, therefore under the no-overwrite rule
      // below — even when the caller believes it is empty.
      projectExisted = true;
    } else {
      // "THE SAME NAME" HAS TO MEAN WHAT THE SERVER MEANS BY IT.
      //
      // This looked the project up by exact lowercase name, while the server's
      // duplicate gate compares NORMALISED names: a file headed "Acme Platform"
      // did not find the project called "acme-platform", went on to create it,
      // and the server refused the create as a duplicate. The retry in the old
      // catch block made the same request again and failed the same way, so the
      // import died with a 409 about a project it had just failed to notice —
      // or, against rows that predate the gate, made the near-duplicate.
      //
      // projectsNamedLike is the server's rule (project-ref.ts): current rule
      // only, names only, never the legacy fallback tier, because the question
      // here is "would the server call this a duplicate", not "what might this
      // reference have meant". An exact spelling still wins among several, which
      // is all the old lookup ever matched. Several normalised matches and no
      // exact one is not a choice this import gets to make: it creates nothing
      // and picks nothing, and lets the server's answer below decide.
      let listed: any[] = [];
      try {
        listed = (await client.listContextProjects())?.projects ?? [];
      } catch {
        // Unknown is not "none", but creating is still right: the server's gate
        // is the authority on duplicates, and it answers below.
        listed = [];
      }
      const alike = projectsNamedLike(projectName, listed);
      const match = alike.find((p) => String(p.project_name || '').toLowerCase() === projectName.toLowerCase())
        ?? (alike.length === 1 ? alike[0] : null);
      if (match?.project_id) {
        pid = match.project_id;
        projectName = match.project_name || projectName;
        projectExisted = true;
      } else {
        try {
          const created = await client.createContextProject(projectName, `Context from ${sourceName}`);
          pid = created.project.project_id;
        } catch (error: any) {
          // The gate saw a project this lookup could not (a list that failed, a
          // page that did not include it) and it NAMES it. Filling that project
          // under the no-overwrite rule is what the lookup would have done.
          const duplicateOf = error?.response?.status === 409
            && error?.response?.data?.error === 'duplicate_project_name'
            && typeof error.response.data.existing_project_id === 'string'
            ? error.response.data.existing_project_id as string
            : null;
          if (!duplicateOf) throw error;
          pid = duplicateOf;
          projectExisted = true;
        }
      }
    }

    // Part A: Direct patch for structured fields (no LLM, instant, accurate)
    const clippedFields: string[] = [];
    const structured = parseStructuredContext(content, clippedFields);

    // Who wrote each of these? The repo already knows.
    //
    // A seeded workspace imported anonymously is a wall of unattributed claims,
    // and a claim with no author cannot be trusted, chased, or retired — which
    // is the whole reason a shared brief is worth reading. git blame turns the
    // seed from "here is some text" into "here is what Marcus worked out in
    // March". Fails open: no git, no attribution, same import as before.
    if (Array.isArray(structured.recent_decisions) && structured.recent_decisions.length) {
      const blame = blameFile(searchDir, foundPath);
      if (blame.size) {
        structured.recent_decisions = attributeByBlame(content, structured.recent_decisions, blame);
      }
    }
    // Merge tech stack inferred from package.json / requirements.txt
    const inferredStack = inferTechStackFromManifest(searchDir);
    if (inferredStack.length) {
      const existingStack = new Set((structured.tech_stack || []).map((s: string) => s.toLowerCase()));
      const newEntries = inferredStack.filter(s => !existingStack.has(s.toLowerCase()));
      if (newEntries.length) structured.tech_stack = [...(structured.tech_stack || []), ...newEntries];
    }

    // ── The no-overwrite rule ────────────────────────────────────────────────
    //
    // An import is a READ of a static file. It has no business replacing what a
    // live session has since recorded, and on the auto path nobody is watching
    // to notice that it did. So when the project already exists, every field it
    // already answers is left exactly as it is and only the blanks get filled.
    //
    // A FAILED read is not permission to write. If we cannot see what is stored,
    // every field is treated as occupied and the import stops — a transient 500
    // must not be able to cost someone their brief.
    const kept: string[] = [];
    let existingReadOk = true;
    if (projectExisted) {
      const readContext = (client as { getContextJson?: (id?: string) => Promise<any> })?.getContextJson;
      const raw = typeof readContext === 'function'
        ? await readContext.call(client, pid).catch(() => null)
        : null;
      const current = raw && typeof raw === 'object'
        ? (raw.context && typeof raw.context === 'object' ? raw.context : raw)
        : null;
      existingReadOk = Boolean(current);
      for (const key of Object.keys(structured)) {
        if (!existingReadOk || fieldHasContent(current[key])) {
          kept.push(key);
          delete structured[key];
        }
      }
    }

    if (projectExisted && !existingReadOk) {
      emitImportEvent(client, 'context_import_failed', {
        reason: 'existing_context_unreadable', file: sourceName, trigger, project_id: pid, path: searchDir,
      });
      return {
        kind: 'blocked',
        text: `"${projectName}" (${pid}) already exists but its current context could not be read, so ${sourceName} was NOT imported — an import must never write over a brief it cannot see. Nothing was changed. Retry, or add context directly with manage_memory(action:"update").`,
      };
    }

    const importedFields: string[] = [];
    if (Object.keys(structured).length > 0) {
      await client.patchProjectContext(pid, structured);
      if (structured.current_task) importedFields.push(`task ✓`);
      if (structured.current_status) importedFields.push(`status ✓`);
      if (structured.tech_stack?.length) importedFields.push(`stack (${structured.tech_stack.length} items) ✓`);
      if (structured.goals?.length) importedFields.push(`goals (${structured.goals.length}) ✓`);
      if (structured.recent_decisions?.length) importedFields.push(`decisions (${structured.recent_decisions.length}) ✓`);
      if (structured.blocking_issue) importedFields.push(`blocking issue ✓`);
      if (structured.open_questions?.length) importedFields.push(`open questions (${structured.open_questions.length}) ✓`);
    }

    // The account-wide profile is NOT written from here. This is a project's
    // file: an `About me:` or `Preferences:` line in it is a project note, and
    // lifting it into the profile printed it in every brief the person opens,
    // unrelated projects included. The profile is filled only from files about
    // the person (buildGlobalProfileSeed) or by the person editing it.

    // Part C: Send remaining unstructured body to extraction pipeline.
    // Extraction REWRITES a brief; it does not merely fill gaps. So it runs only
    // when this import is the thing that put content in the project — a project
    // that already answered something keeps the structured fill as its whole
    // safe payload.
    const targetWasEmpty = !projectExisted || kept.length === 0;
    if (targetWasEmpty) {
      const unstructuredBody = stripStructuredSections(content);
      if (unstructuredBody.length > 100) {
        await client.pushContextUpdate(pid, unstructuredBody, 'claude_code');
      }
    }

    const keptLine = kept.length
      ? `\n\nLeft as it was (already recorded in "${projectName}"): ${kept.join(', ')}. Nothing was overwritten — change any of them with manage_memory(action:"update").`
      : '';
    // Only fields that were actually sent: one the no-overwrite rule kept was
    // not clipped into anything.
    const clippedSent = clippedFields.filter((field) => field in structured);
    const clippedLine = clippedSent.length
      ? `\n\nClipped to the brief's ${CONTEXT_PATCH_TEXT_MAX}-character limit per value: ${clippedSent.join(', ')}. The rest of ${sourceName} was not affected.`
      : '';

    emitImportEvent(client, 'context_import_succeeded', {
      file: sourceName,
      trigger,
      project_id: pid,
      project_existed: projectExisted,
      fields_imported: importedFields.length,
      fields_kept: kept.length,
      path: searchDir,
    });

    if (projectExisted && !importedFields.length) {
      return {
        kind: 'kept',
        text: `"${projectName}" (${pid}) already has context, so ${sourceName} was not imported over it. Nothing was changed.${keptLine}${skillProposalText}`,
        project_id: pid,
        project_name: projectName,
        source: sourceName,
      };
    }

    const fieldSummary = importedFields.length ? `: ${importedFields.join(', ')}` : '';
    // "Call start_session to continue" is right when a person asked for this and
    // wrong when start_session is the thing that asked — the agent is already
    // inside that call, and following the line just spends another round-trip.
    const nextStep = opts.auto ? '' : ' Call start_session to continue with the full brief.';
    return {
      kind: 'imported',
      text: `Imported "${projectName}" (${pid})${fieldSummary}. Context is now live — Claude Code, Cursor, and Codex will pick it up automatically.${nextStep}${keptLine}${clippedLine}${skillProposalText}`,
      project_id: pid,
      project_name: projectName,
      source: sourceName,
    };
  } catch (error) {
    emitImportEvent(client, 'context_import_failed', {
      reason: 'import_error',
      file: sourceName,
      trigger,
      message: error instanceof Error ? error.message : 'unknown',
      path: searchDir,
    });
    throw error;
  }
}

/**
 * The automatic first-run seed.
 *
 * "First run" is per WORKSPACE, not per account — the earlier version only fired
 * when the whole account had no context, so the second repo a user ever opened
 * still started cold. Returns the text to show, or null when this is not a first
 * run: already seeded, no user-authored context file here, or another caller in
 * this process got there first.
 *
 * Every gate lives in first-run-import.ts; every no-overwrite rule lives in
 * importLocalContextFile. This function only sequences them and records that the
 * workspace has now been seeded, so it never happens twice.
 */
export async function runFirstRunImport(
  client: DeerdawnClient,
  cwd: string,
  bound?: { projectId?: string | null; projectName?: string | null },
  // `setup` asked the person, with a preview of the files, and they said yes:
  // that IS the consent the offer below exists to collect, for this workspace.
  options: { consented?: boolean } = {},
): Promise<string | null> {
  const workspace = findGitRoot(cwd) || cwd;
  if (hasImportedLocalContext(workspace)) return null;
  const local = findLocalContextFile(workspace);
  if (!local) return null;

  // Nobody asked for this file to be sent. Offer, don't upload.
  //
  // The offer is returned as TEXT, which is what makes this different from the
  // stderr tip it replaced — this string lands in the conversation, where a
  // person can read it and say yes. Nothing is written to the ledger on this
  // path: declining once must not mark the workspace as seeded, or the offer
  // would be made exactly once and then never again.
  if (!options.consented && !autoImportOptIn()) {
    return `DeerDawn found ${local.name} in this workspace and has no context for it yet.\n\n`
      + `${local.name} has not been sent anywhere. To seed your brief from it, call`
      + ' `manage_memory(action:"import_local")` — it shows a preview first and imports only on'
      + ' confirmation, with secrets masked before anything leaves this machine.\n\n'
      + 'To let DeerDawn do this by itself in every new workspace, set DEERDAWN_AUTO_IMPORT=1 or put'
      + ' {"auto_import_local": true} in ~/.deerdawn/config.json.\n\n'
      // The offer replaces what used to be a completed seed at both start_session
      // call sites, so it has to carry the empty-state guidance the seed made
      // unnecessary. Importing is one way to fill a cold brief; it is not the
      // only one, and nobody should be stuck waiting on a decision they may not
      // want to make.
      + FIRST_BRIEF_DIRECTIVE;
  }

  return claimFirstRunImport(workspace, async () => {
    let outcome: LocalImportOutcome;
    try {
      outcome = await importLocalContextFile(client, {
        path: local.path,
        confirmed: true,
        auto: true,
        projectId: bound?.projectId ?? null,
        projectName: bound?.projectName ?? null,
      });
    } catch {
      // A seed that fails falls back to the normal empty-state guidance rather
      // than surfacing an error for something the user never asked for.
      return null;
    }
    if (outcome.kind !== 'imported' && outcome.kind !== 'kept') return null;

    recordLocalContextImport(workspace, {
      project_id: outcome.project_id,
      source: local.name,
      seeded: outcome.kind === 'imported',
    });
    // This directory's own context file was just filed under that project, so a
    // save that follows with no project_id belongs there too (write-target.ts).
    rememberWriteTarget(workspace, outcome.project_id);
    rememberWriteTarget(cwd, outcome.project_id);
    // Push the seeded brief to disk so the OTHER tools in this repo (Cursor,
    // Codex) see it without waiting for a first session of their own.
    await syncProjectFiles(client, workspace).catch(() => null);

    if (outcome.kind === 'kept') return outcome.text;
    // No "nothing was overwritten" claim here — when something WAS held back,
    // importLocalContextFile names the exact fields, and asserting it over a
    // brand-new project is noise pretending to be a guarantee.
    return `✓ First run in this workspace — DeerDawn seeded your context from ${local.name} (instant, no LLM cost for structured fields) and synced it to your AI tool files. Undo with manage_projects(action:"archive") if this is not a project you want tracked.\n\n${outcome.text}`;
  });
}

// THE ARCHIVED FEED (GET /projects?archived=1), ALL OF IT, for the two replies
// that talk about archived projects: start_session's "waiting, not gone" notice
// and the listing that notice sends the assistant to. [] when this client cannot
// ask or the API does not answer; it never throws, because neither reply should
// fail over a courtesy lookup.
//
// `strict` refuses an answer that does not say it IS the archived feed. An API
// that ignored ?archived=1 would answer with the LIVE projects, and the listing
// would print them under "archived". The notice needs no such guard: it is only
// consulted when there is no live project to mistake for one.
async function listArchivedForListing(client: any, { strict = false }: { strict?: boolean } = {}): Promise<any[]> {
  if (typeof client?.listArchivedContextProjects !== 'function') return [];
  try {
    const result = await client.listArchivedContextProjects(ARCHIVED_PROJECTS_FETCH_LIMIT);
    if (strict && result?.archived !== true) return [];
    return Array.isArray(result?.projects) ? result.projects : [];
  } catch {
    return [];
  }
}

// ─── Resolving an omitted project_id ─────────────────────────────────────────
//
// PROJECT_REF_DESCRIPTION promises the same thing on every project reference:
// omit it and the active project is used. Three writes did not honour it.
// record_hot_paths, record_debug_finding and confirm_claim required project_id
// outright, so the call shape their OWN description advertised was rejected by
// zod before it ever reached the API — "Invalid arguments — project_id is
// required", returned to a caller that had done exactly what it was told. It is
// invisible in exception tracking because a rejected argument is a handled MCP
// error, not a throw, and it lands on the write path the product exists for.
//
// Resolution is by cwd, the same way resolve_open_question already did it —
// lifted here rather than copied a fourth time, so the four cannot drift.
// The reply to a project_id that names no project the caller can see.
// PARITY: apps/api/src/routes/mcp.js unknownProjectMessage says the same words.
function unknownProjectMessage(projectRef: string): string {
  return `No project "${projectRef}" that you can see, so nothing was resolved. List your projects with recall(action:"projects") and pass one of their ids as project_id, or omit project_id to use the active project.`;
}

// The graph's key slug (apps/api/src/services/contextGraphService.js
// normalizeKey): a canonical key is `<type>:<normalizeKey(text)>`.
function graphKeySlug(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/[^a-z0-9._:/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// WHAT A DECISION NODE SAYS, AND WHETHER IT WAS CUT — the server's rule
// (apps/api/src/services/contextSyncService.js decisionClipVisible), to its
// exact shapes: the extractor's title (79 + "...") and summary (239 + "..."),
// and the store's summary (279 + "…"). Such a text is never taken as the
// whole of anything. A title is only ever cut to the first shape.
function decisionClipVisible(value: unknown, field: 'summary' | 'title'): string | null {
  const text = String(value || '').trim();
  if (text.length === 82 && text.endsWith('...')) return text.slice(0, -3);
  if (field === 'title') return null;
  if (text.length === 242 && text.endsWith('...')) return text.slice(0, -3);
  if (text.length === 280 && text.endsWith('…')) return text.slice(0, -1);
  return null;
}

// PARITY: contextSyncService decisionNodeText.
function decisionNodeText(node: any): { text: string; clipped: boolean; visible: string } {
  const summary = String(node?.summary || '').trim();
  const title = String(node?.title || '').trim();
  const summaryCut = summary ? decisionClipVisible(summary, 'summary') : null;
  const titleCut = title ? decisionClipVisible(title, 'title') : null;
  if (summary && summaryCut === null) return { text: summary, clipped: false, visible: summary };
  if (title && titleCut === null && (!summary || title.length > (summaryCut as string).length)) {
    return { text: title, clipped: false, visible: title };
  }
  if (summary) {
    const visible = titleCut !== null && titleCut.length > (summaryCut as string).length ? titleCut : (summaryCut as string);
    return { text: summary, clipped: true, visible };
  }
  return { text: title, clipped: titleCut !== null, visible: titleCut !== null ? titleCut : title };
}

// The decision's full text as its canonical key carries it, trailing stop
// trimmed — only when the key provably is the slug of this node's visible text
// AND carries more than it (an entity upserted under a cut title is keyed on
// the slug of that cut, which says nothing about how the decision goes on).
// PARITY: contextSyncService decisionNodeFullKey + decisionKeyBeyondCut.
// The plain key a scoped copy (`<key>::in.<home>`) was made from.
// PARITY: contextSyncService unscopedEntityKey.
function unscopedKey(key: unknown): string {
  return String(key || '').split('::in.')[0];
}

function decisionKeyBeyondCut(node: any, visible: string): string | null {
  // A scoped copy's key is the plain slug plus where it lives (`::in.<home>`).
  // PARITY: contextSyncService decisionNodeFullKey (scan 33).
  const key = unscopedKey(node?.canonical_key);
  if (!key.startsWith('decision:')) return null;
  const body = key.slice('decision:'.length);
  const shown = graphKeySlug(visible);
  if (!shown || !body.startsWith(shown)) return null;
  const nodeKey = body.replace(/[.-]+$/, '');
  return nodeKey === shown.replace(/[.-]+$/, '') ? null : nodeKey;
}

// Is `summary` the decision `node` stands for? Exact after normalising case and
// whitespace against its summary or title, never against a cut text; when the
// only full text left is behind a cut, the key decides (decisionKeyBeyondCut).
// PARITY: contextSyncService decisionNodeMatches.
function decisionNodeMatches(summary: string, node: any): boolean {
  const norm = (value: unknown) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const a = norm(summary);
  if (!a || !node) return false;
  let clippedVisible = '';
  for (const [raw, field] of [[node.summary, 'summary'], [node.title, 'title']] as const) {
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
  return Boolean(nodeKey) && nodeKey === graphKeySlug(summary).replace(/[.-]+$/, '');
}

// Exact-title candidates narrowed to the caller's home: those filed in
// `projectId`, else the workspace-level ones — whichever tier has any.
// PARITY: apps/api/src/routes/mcp.js preferCallersHome.
function preferCallersHome(exact: any[], projectId: string | null | undefined): any[] {
  if (!Array.isArray(exact) || exact.length < 2) return exact;
  const tiers = [
    (entity: any) => Boolean(projectId) && entity.project_id === projectId,
    (entity: any) => !entity.project_id,
  ];
  for (const tier of tiers) {
    const hits = exact.filter(tier);
    if (hits.length) return hits;
  }
  return exact;
}

// ONE TITLE, SEVERAL HOMES: every exact candidate carries the very same title,
// so "the exact, complete title" cannot tell them apart — where each lives can
// (scan 33 p100). A project the caller cannot open is not named. Null when the
// titles differ. PARITY: apps/api/src/routes/mcp.js sameTitleHomes.
async function sameTitleHomes(client: any, exact: any[]): Promise<string[] | null> {
  if (!Array.isArray(exact) || exact.length < 2) return null;
  const norm = (value: unknown) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (new Set(exact.map((entity: any) => norm(entity.title))).size !== 1) return null;
  // Of one type (two types is entity_type's to tell apart), in more than one home.
  if (new Set(exact.map((entity: any) => entity.node_type || entity.metadata?.entity_type)).size !== 1) return null;
  if (new Set(exact.map((entity: any) => entity.project_id || '')).size < 2) return null;
  let projects: any[] = [];
  try {
    projects = (await client.listContextProjects())?.projects ?? [];
  } catch {
    projects = [];
  }
  const names = new Map<string, string>(projects.map((project: any) => [project.project_id, project.project_name]));
  return exact.map((entity: any) => {
    if (!entity.project_id) return 'workspace-level';
    if (!names.has(entity.project_id)) return 'in a project you cannot open';
    return `in ${names.get(entity.project_id) || 'a project'} (project_id: "${entity.project_id}")`;
  });
}

// IS THIS ENTITY THE ONE `title` NAMES? Its title exactly (case and outer
// whitespace aside), its node id, its canonical key as the slug of `title`, or
// — a decision — the shared decision matcher (decisionNodeMatches). Never a
// prefix or a shared word.
// PARITY: apps/api/src/routes/mcp.js entityNamedExactly, rule for rule. This
// copy used to accept a decision's stored key with no check that it carried
// more than a cut, and "use redis." for "Use Redis" (a trailing stop trimmed
// from both sides) where the hosted server refused it (scan 28).
function entityNamedExactly(entity: any, title: string): boolean {
  if (!entity || typeof title !== 'string') return false;
  if (entity.node_id === title) return true;
  if (String(entity.title || '').trim().toLowerCase() === title.trim().toLowerCase()) return true;
  const type = entity.node_type || entity.metadata?.entity_type;
  const key = unscopedKey(entity.canonical_key);
  if (type && key && key === `${type}:${graphKeySlug(title)}`) return true;
  return type === 'decision' && decisionNodeMatches(title, entity);
}

// THE CUT A BRIEF SHOWS: an opening, then "..." or "…". Read as that
// opening when at least DECISION_SHOWN_MIN characters are left — under the
// tightest cut any brief makes (light verbosity with a reason: 46 characters
// with the dots, backed off to a word boundary).
// PARITY: contextSyncService DECISION_SHOWN_MIN / decisionShownOpening.
const DECISION_SHOWN_MIN = Math.floor((proseBudget('light', 64) - 3) * 0.75);
function decisionShownOpening(value: unknown): string | null {
  const text = String(value || '').trim();
  if (!/(\.\.\.|…)$/.test(text)) return null;
  const opening = text.replace(/\s*(\.\.\.|…)$/, '').trim();
  return opening.length >= DECISION_SHOWN_MIN ? opening : null;
}

// Does the decision node's full text begin with the opening `title` shows?
// PARITY: contextSyncService decisionNodeNamedByOpening.
function decisionNodeNamedByOpening(title: string, node: any): boolean {
  const opening = decisionShownOpening(title);
  if (!opening || !node) return false;
  const norm = (value: unknown) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const { text, clipped, visible } = decisionNodeText(node);
  if (!clipped) return norm(text).startsWith(norm(opening)) && norm(text) !== norm(opening);
  if (norm(visible).startsWith(norm(opening))) return true;
  const nodeKey = decisionKeyBeyondCut(node, visible);
  const slug = graphKeySlug(opening).replace(/[.-]+$/, '');
  return Boolean(nodeKey && slug) && (nodeKey as string).startsWith(slug);
}

// The decision entities a shown cut names: the one decision whose text begins
// with its opening when it is the only one; otherwise every one it opens, OPEN
// OR RESOLVED, refused as a guess with the resolved ones marked — counting only
// the open ones resolved a sibling once the decision cut was resolved (scan 29);
// none open, the resolved one alone, so the reply can say it is already done.
// Read wider than the five-hit ranking, so a sibling sharing the opening cannot hide.
// PARITY: apps/api/src/routes/mcp.js decisionsNamedByOpening.
async function decisionsNamedByOpening(client: DeerdawnClient, title: string, projectId: string | undefined): Promise<any[]> {
  const opening = String(title || '').trim().replace(/\s*(\.\.\.|…)$/, '');
  if (opening === String(title || '').trim()) return [];
  const wide = await client.getWorkspaceEntities({
    query: opening,
    types: ['decision'],
    ...(projectId ? { project_id: projectId } : {}),
    include_resolved: true,
    limit: 50,
    format: 'json',
  }).catch(() => null);
  const named = ((wide as any)?.entities || [])
    .filter((e: any) => (e.node_type || e.metadata?.entity_type) === 'decision')
    .filter((e: any) => decisionNodeNamedByOpening(title, e));
  const open = named.filter((e: any) => e.metadata?.status !== 'resolved');
  return open.length ? named : named.slice(0, 1);
}

async function resolveProjectIdFromCwd(
  client: DeerdawnClient,
  explicit: string | undefined,
  purpose: string,
): Promise<string> {
  if (explicit) return explicit;
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // Every caller of this function WRITES, so it resolves a write target and not
  // "whatever /active says". It used to take active.project_id without looking
  // at how it had matched, so a finding recorded from a folder called `api`
  // went to whichever project had "api" in its name. See write-target.ts.
  const target = await resolveWriteTarget(client, cwd, { nameTheGuess: true });
  // ToolInputError, not a plain Error: this is the caller's arguments, and
  // "Operation failed" gives it no reason to think a different call would work.
  if (target.kind !== 'target') throw new ToolInputError(describeWriteRefusal(target, purpose));
  return target.projectId;
}

// MANAGE_MEMORY(UPSERT_ENTITIES) TELLS THE SERVER WHERE THE CALLER IS WORKING.
// The advertised top-level project_id ("Omit to use the active project") never
// reached the server: only a per-entity project_id did, and the server's default
// for an entity with neither is WORKSPACE scope — a member's personal note
// written "into" their personal project was served to every colleague (scan 28).
// An entity naming no project of its own carries the top-level project_id or,
// omitted, this directory's write target (never a guess), marked
// filed_by_default: the WORKING project, not the caller's word about the entity.
// The server decides from it (service.upsertWorkspaceEntities): a new entity is
// filed there whenever the caller may edit its section there, an existing node
// keeps its own home, and a resolve/reopen goes there when its decision log
// carries the decision (scans 29-31). scope:"project" with no project_id asks
// for the working project: marked the same way, scope kept, so it never adopts
// an existing node (scan 31) and is refused rather than widened;
// scope:"workspace" keeps an entity out of every project. Only the grouped
// action: the legacy tool documents "defaults to workspace".
// PARITY: apps/api/src/routes/mcp.js fileEntitiesUnderProject.
// What an entity write says when there is no project to file it under.
// PARITY: apps/api/src/routes/mcp.js NO_PROJECT_FOR_ENTITIES says the same words.
export const NO_PROJECT_FOR_ENTITIES = 'Nothing was saved. These entities name no project and this connection has no active project, so there is nowhere to file them, and a project is required. '
  + 'Pass project_id (recall(action:"projects") lists them) to file them in one project, or select one first with manage_projects(action:"select"). '
  + 'To save them for the whole workspace, readable by every member, set scope:"workspace" on each entity.';

function entityNamesNoProject(entity: any): boolean {
  return Boolean(entity) && typeof entity === 'object'
    && !(typeof entity.project_id === 'string' && entity.project_id.trim())
    && entity.scope !== 'workspace';
}

export async function fileEntitiesUnderProject(
  client: Pick<DeerdawnClient, 'getActiveContextByCwd'>,
  args: any,
): Promise<any> {
  const entities = Array.isArray(args?.entities) ? args.entities : null;
  if (!entities || !entities.some(entityNamesNoProject)) return args;
  let projectId: string | null = typeof args.project_id === 'string' && args.project_id.trim() ? args.project_id.trim() : null;
  if (!projectId) {
    const target = await resolveWriteTarget(client, process.env.CLAUDE_PROJECT_DIR || process.cwd(), { nameTheGuess: true }).catch(() => null);
    projectId = target?.kind === 'target' ? target.projectId : null;
    // NOTHING TO FILE UNDER IS A REFUSAL, NOT A WORKSPACE SAVE (journey r5).
    // An entity naming no project used to fall through here and be stored
    // workspace-wide, readable by every member, without a word. The workspace is
    // for a caller who asks for it (scope:"workspace"). A guess is refused in the
    // words every other write uses for one, which names the project it matched.
    if (!projectId) {
      throw new ToolInputError(target && target.kind === 'guess'
        ? describeWriteRefusal(target, 'file entities in')
        : NO_PROJECT_FOR_ENTITIES);
    }
  }
  if (!projectId) return args;
  return {
    ...args,
    entities: entities.map((entity: any) => (entityNamesNoProject(entity)
      ? { ...entity, project_id: projectId, filed_by_default: true }
      : entity)),
  };
}

// ─── Tool handler ────────────────────────────────────────────────────────────

// The "Project: / Last updated:" lines over a brief, each only when it is
// KNOWN. A project-id read used to print the id as the name and the literal
// "Last updated: null" (see projectHeaderFrom in client.ts).
export function withProjectHeader(result: { project_name?: string | null; last_updated?: string | null; brief: string }): string {
  const header = [
    result.project_name ? `Project: ${result.project_name}` : null,
    result.last_updated ? `Last updated: ${result.last_updated}` : null,
  ].filter((line): line is string => line !== null);
  return header.length ? `${header.join('\n')}\n\n${result.brief}` : result.brief;
}

// Where a read that names no project is made from. recall(action:"context")
// without a project_id went to /active with no directory at all, so the server
// resolved this person's most recent project and warned "directory not linked
// to this project — match is a guess" even inside a linked repo. The directory
// goes with the read the way it goes with start_session; a named project needs
// none.
function readLocation(projectId?: string): { cwd: string } | undefined {
  return projectId ? undefined : { cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd() };
}

// finish_task: what the last wrap-up review in THIS process showed, per project
// (journey r4, BLOCKED 22). The confirmation clears exactly that, and nothing
// added since; see shared-context taskReview.js, the rule both dispatchers
// apply. A local server process is one session, so its memory is the session's.
// PARITY: the hosted dispatcher keeps the same record in the database, per
// connection and project.
const taskReviews = new Map<string, TaskReviewItems>();

export async function handleContextSyncTool(
  name: string,
  args: any,
  client: DeerdawnClient,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    switch (name) {
      case 'recall': {
        const action = String(args?.action || 'context');
        const targets: Record<string, string> = {
          projects: 'list_projects', context: 'get_context', search: 'search_context', overview: 'get_workspace_overview',
          map: 'get_project_map', paths: 'find_known_paths', entities: 'get_workspace_entities',
          next: 'get_next_best_context',
          // The one read that crosses project boundaries. An ACTION rather than a
          // new tool name: the advertised surface is a token budget, and an enum
          // value costs a word where a tool costs a whole schema.
          portfolio: 'get_portfolio',
        };
        if (!targets[action]) {
          throw new ToolInputError(`Unknown recall action "${action}". Valid actions: ${Object.keys(targets).join(', ')}.`);
        }
        return handleContextSyncTool(targets[action], args, client);
      }

      case 'manage_projects': {
        const action = String(args?.action || 'create');
        const targets: Record<string, string> = {
          create: 'create_project', select: 'switch_subproject',
          rename: 'rename_project', move: 'set_project_parent', archive: 'archive_project',
          restore: 'archive_project',
        };
        if (!targets[action]) {
          throw new ToolInputError(`Unknown manage_projects action "${action}". Valid actions: ${Object.keys(targets).join(', ')}.`);
        }
        return handleContextSyncTool(targets[action], action === 'restore' ? { ...args, unarchive: true } : args, client);
      }

      case 'manage_memory': {
        const action = String(args?.action || 'update');
        const targets: Record<string, string> = {
          update: 'update_context', import_local: 'import_local_context', record_paths: 'record_hot_paths',
          record_finding: 'record_debug_finding', upsert_entities: 'upsert_workspace_entities',
          confirm: 'confirm_claim', resolve: 'mark_resolved',
          // Deliberately NOT folded into `resolve`. mark_resolved flips a
          // workspace graph ENTITY; this edits the brief's open_questions list.
          // One verb over two stores could only be told apart by which optional
          // argument happened to be present, and choosing a destructive path by
          // loose matching is the failure this repo has already paid for.
          resolve_question: 'resolve_open_question',
          finish_task: 'cleanup_context',
          export_trail: 'export_trail', import_trail: 'import_trail',
        };
        if (!targets[action]) {
          throw new ToolInputError(`Unknown manage_memory action "${action}". Valid actions: ${Object.keys(targets).join(', ')}.`);
        }
        // The top-level project_id (or this directory's project) is where
        // entities naming no project of their own are filed. A named project
        // the caller cannot see comes back from the client's own 404 mapping.
        const routed = action === 'upsert_entities' ? await fileEntitiesUnderProject(client, args) : args;
        return handleContextSyncTool(targets[action], routed, client);
      }

      case 'manage_tasks':
        return handleContextSyncTool('manage_todos', args, client);

      case 'browse_skills': {
        const action = String(args?.action || 'list');
        if (action === 'list') return handleContextSyncTool('list_skills', args, client);
        if (action === 'get') return handleContextSyncTool('get_skill', args, client);
        throw new ToolInputError(`Unknown browse_skills action "${action}". Valid actions: list, get.`);
      }

      case 'manage_skills': {
        const action = String(args?.action || 'sync');
        if (action === 'sync') return handleContextSyncTool('sync_skills', args, client);
        if (action === 'import_github') return handleContextSyncTool('import_skill_from_github', args, client);
        throw new ToolInputError(`Unknown manage_skills action "${action}". Valid actions: sync, import_github.`);
      }

      case 'start_session': {
        const verbosity = (args?.verbosity === 'light' ? 'light' : 'standard') as 'light' | 'standard';
        const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
        // Repo identity (git-only, never throws) so selection prefers the
        // work-stream in THIS workspace over an unrelated recently-touched project.
        const workspaceKey = getWorkspaceKey(cwd);

        await client.flushQueuedContextWrites().catch(() => null);

        // Fire both calls in parallel — one round-trip instead of two. Use a
        // sentinel (not null) on error so we can tell "API unreachable" apart
        // from "API responded, no context yet" — they need different messages.
        const SYNC_ERROR = Symbol('sync_error');
        // The sentinel tells "API unreachable" apart from "no context yet",
        // which is worth keeping — but it used to be the ONLY thing kept. The
        // error itself was dropped by `.catch(() => SYNC_ERROR)`, so a 401 and a
        // socket timeout became the same fact, and the message chose the wrong
        // one of the two: "network or service degraded ... retry shortly",
        // against a credential for which retrying can never work.
        //
        // Keeping the errors costs one array and makes the auth case
        // recoverable: rethrown below, it reaches handleApiError, becomes
        // AUTH_EXPIRED_SENTINEL, and tools/index.ts renders the sign-in link
        // that is the actual fix.
        const failures: unknown[] = [];
        const capture = (error: unknown) => { failures.push(error); return SYNC_ERROR; };
        const [activeRaw, mapRaw] = await Promise.all([
          // Surface-aware tool id (env → initialize clientInfo → claude_code) so
          // a Cursor/Codex stdio session marks, briefs, and instruments as itself.
          client.getActiveContextByCwd(cwd, resolveLocalSurface(), verbosity, true, workspaceKey).catch(capture),
          client.getContextMap(true, cwd, workspaceKey).catch(capture),
        ]);
        const activeResult = activeRaw === SYNC_ERROR ? null : (activeRaw as any);
        const mapResult = mapRaw === SYNC_ERROR ? null : (mapRaw as any);
        const bothUnreachable = activeRaw === SYNC_ERROR && mapRaw === SYNC_ERROR;

        const noContextResponse = async () => {
          // What the fallback COPY should name. Deliberately a plain existence
          // check, not findLocalContextFile: a file that holds nothing but
          // DeerDawn's own block is still worth naming in "you have a CLAUDE.md,
          // put something in it" guidance, even though it must never be imported.
          const localFile = LOCAL_CONTEXT_FILENAMES.find((name) => fs.existsSync(join(cwd, name))) ?? null;

          // E1: auto-bootstrap on first session. The structured import is instant
          // and costs no LLM quota, so seed it for the user instead of making
          // them run a second command. Usually already done by the earlier,
          // wider first-run check below — this call is the safety net for the
          // path that reaches here with a boilerplate-only map, and the
          // per-process claim makes the duplicate call free.
          const seeded = await runFirstRunImport(client, cwd);
          if (seeded) return { content: [{ type: 'text', text: seeded }] };

          // No local config file. If this looks like a real project (has a build
          // manifest), auto-create a tracked project so the user's very first sync
          // shows something instead of an empty dashboard. Gate strictly on a manifest
          // so we never spawn junk projects in $HOME or an empty directory.
          if (!localFile) {
            const projectRoot = findGitRoot(cwd) || cwd;
            const MANIFESTS = [
              'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml',
              'requirements.txt', 'pom.xml', 'build.gradle', 'Gemfile', 'composer.json',
            ];
            const hasManifest = MANIFESTS.some(m => fs.existsSync(join(projectRoot, m)));
            const projectName = projectRoot.split(/[/\\]/).filter(Boolean).pop() || '';
            if (hasManifest && projectName) {
              try {
                const created = await client.createContextProject(projectName, `Auto-created from ${projectName}`);
                const pid = created.project.project_id;
                // Created here, for this directory, a moment ago: the save the
                // reply below asks for must reach it even though nothing links
                // the directory yet. See write-target.ts.
                rememberWriteTarget(cwd, pid, created.project.project_name ?? projectName);
                const stack = inferTechStackFromManifest(projectRoot);
                if (stack.length) await client.patchProjectContext(pid, { tech_stack: stack }).catch(() => null);
                await syncProjectFiles(client, cwd).catch(() => null);
                const stackLine = stack.length ? ` Detected stack: ${stack.join(', ')}.` : '';
                return { content: [{ type: 'text', text:
                  `✓ Started tracking "${projectName}" in DeerDawn (${pid}).${stackLine}\n\n` +
                  // No context file here, so the brief is empty. The repo still
                  // says a lot about itself; a first brief built from it beats a
                  // cold one.
                  // Read without asking only after a yes at setup (Thing 4.5):
                  // otherwise the person is asked first, once.
                  (repoSeedConsented()
                    ? 'Its brief is empty. Read the README and the last ~20 commit subjects (`git log --oneline -20`), then save\n'
                    : 'Its brief is empty. Ask the user once whether DeerDawn may start it from the README and the last ~20 commit\n' +
                      'subjects (`git log --oneline -20`); only after a yes, read them, then save\n') +
                  'the current task, goals, recent decisions and open questions they actually state with\n' +
                  '`manage_memory(action:"update")`. If this is a brand-new project with nothing to read yet, or the user said no,\n' +
                  'ask what they are building, their stack, what they are working on first, and any decisions already made.\n\n' +
                  FIRST_BRIEF_DIRECTIVE }] };
              } catch {
                // Fall through to manual guidance if creation fails.
              }
            }
          }

          // A user whose projects all aged out still HAS their memory. Say so
          // before claiming an empty workspace — that bare "no context yet" is
          // the exact "your AI forgot everything" moment this product prevents.
          // Guarded on the method existing, not just on rejection: start_session
          // must degrade to the normal empty-state message rather than throw if
          // it is talking to an older client shape.
          // The whole set, not the server's default page of 10: the notice COUNTS
          // what it is given, and "10 archived projects" beside a listing of 14
          // contradicts the listing it sends the assistant to.
          const archivedNotice = formatArchivedProjectsNotice(await listArchivedForListing(client));
          if (archivedNotice) {
            return { content: [{ type: 'text', text: archivedNotice }] };
          }

          const msg = localFile
            ? `No DeerDawn context yet — but ${localFile} is here.\n\n→ Call \`manage_memory(action:"import_local")\` to seed it now (~2 seconds, no LLM cost for structured fields).\n  After that, every session starts knowing your task, decisions, stack, and where you left off.\n\n${FIRST_BRIEF_DIRECTIVE}`
            // Same guide the hosted server gives an empty account (shared-context
            // firstSessionGuide.js): existing repo or new project, then either the
            // repo's own sources or four questions.
            : buildFirstSessionGuide({ local: true, readRepoWithoutAsking: repoSeedConsented() });
          return { content: [{ type: 'text', text: msg }] };
        };

        // Remember the watermark this brief was cut at, so a later call that
        // already carries the project's updated_at can tell the agent its brief
        // has gone stale — without any call being added to find that out.
        recordBriefWatermark(activeResult?.project_id, activeResult?.brief_watermark);
        // Mirror peers to disk for the PreToolUse hook. The hook runs in the
        // agent's edit path and must never touch the network, so the only way it
        // can know about a peer is a file written here, on a call already made.
        writePeerMirror(cwd, activeResult?.project_id, activeResult?.presence);

        // First run IN THIS WORKSPACE — the unit that matters.
        //
        // The auto-import used to sit behind `hasFreshContext`, which is true as
        // soon as the ACCOUNT has any project at all. So it only ever fired for
        // someone's very first repo; the second one they opened started cold with
        // a CLAUDE.md sitting right there. The condition that actually describes
        // "this directory has nothing" is an empty brief for this cwd.
        //
        // Gated on the /active call having SUCCEEDED (not the SYNC_ERROR
        // sentinel): a timeout means we do not know whether a project exists
        // here, and "we don't know" must never be read as "there is nothing".
        //
        // Two shapes of "empty" reach this point, and only one is safe to act on:
        //   • nothing resolved, or resolved BY PATH — this directory is genuinely
        //     unwritten, so seed it (into the bound project when there is one,
        //     rather than deriving a name and creating a near-duplicate).
        //   • resolved by 'name' or 'recency_fallback' — a guess at some other
        //     work-stream. Seeding against a guess is how you write into the
        //     wrong project, so leave it to the existing best-guess notice.
        const boundProjectId = activeResult?.match_kind === 'path' ? (activeResult.project_id ?? null) : null;
        const resolvedByGuess = Boolean(activeResult?.project_id) && activeResult?.match_kind !== 'path';
        if (activeRaw !== SYNC_ERROR && !activeResult?.brief && !resolvedByGuess) {
          const seeded = await runFirstRunImport(client, cwd, {
            projectId: boundProjectId,
            projectName: boundProjectId ? (activeResult?.project_name ?? null) : null,
          });
          if (seeded) return { content: [{ type: 'text', text: seeded }] };
        }

        // A map is context only if it lists something. /map now stamps a "Now:"
        // line on every answer — including an empty account's, which is
        // "[DeerDawn] No brief ready yet." plus that line — so the bare truthiness
        // of `map` stopped meaning anything: a brand-new account skipped the
        // first-session guide and got a brief reading "Other projects: Now: <date>".
        const mapContent = mapContentLines(mapResult?.map);
        const hasFreshContext = Boolean(activeResult?.brief || mapContent.length > 0 || Number(mapResult?.project_count) > 0);
        if (!hasFreshContext) {
          // An expired credential is NOT a degraded service, and it is the one
          // failure here the caller can actually fix. Rethrowing hands it to
          // handleApiError, which maps 401 to AUTH_EXPIRED_SENTINEL, which
          // tools/index.ts turns into a sign-in link.
          //
          // This has to happen in start_session specifically. Every other tool
          // already reaches that path, because every other tool lets its errors
          // propagate. start_session — the one tool guaranteed to run first, and
          // the only one whose whole job is establishing the session — was the
          // only one that could not recover its own auth.
          //
          // A CLOSED WORKSPACE belongs in the same carve-out, for the same
          // reason. Four ways it can be closed: this key's person is not a
          // member (403 workspace_forbidden), the workspace stopped paying (403
          // subscription_inactive, or 409 workspace_inactive on a write), or it
          // is locked down (403 lockdown_active). "Network or service degraded
          // ... retry shortly" is the one description under which nobody ever
          // looks at the workspace that is actually the problem — a lapsed TEAM
          // read as an outage to every member of it, and the one person who
          // could fix it was never told. Rethrown so handleApiError can name the
          // workspace, say where it is configured, and give both ways out.
          const unrecoverable = failures.find((error: any) => error?.response?.status === 401
            || ((error?.response?.status === 403 || error?.response?.status === 409)
              && isWorkspaceClosureCode(error?.response?.data?.error)));
          if (unrecoverable) throw unrecoverable;

          // API unreachable (e.g. 503/timeout) — don't imply there's no saved
          // context; say sync is degraded so the agent doesn't trust nothing.
          if (bothUnreachable) {
            return { content: [{ type: 'text', text:
              '⚠ DeerDawn context sync is unreachable right now (network or service degraded). Context is NOT loaded this session and may be stale or temporarily unavailable. Work from the repo directly, verify before relying on any cached context, and retry start_session shortly — do not assume there is no saved context.' }] };
          }
          return noContextResponse();
        }

        const parts: string[] = [];

        // Did the PREVIOUS session's context actually land? The Stop-hook flush
        // is a detached CLI process with no tool result and nobody reading its
        // stderr: when it was refused (a 413 on a long transcript, an outage, an
        // expired key) it logged one line and the whole session was lost in
        // silence. It now leaves a notice on disk, and this is the first moment
        // someone is present to be told. Before the brief, because it is
        // precisely the brief that the notice qualifies.
        try {
          const flushNotice = consumeFlushNotice();
          if (flushNotice) parts.push(flushNotice);
        } catch { /* a notice must never cost somebody their session start */ }

        // A configured workspace redirects every read and write in this session,
        // and nothing else in the output says so: the brief of a team project
        // looks exactly like the brief of your own. Once per process —
        // repeating it at every session start is noise, and never saying it is
        // how somebody spends an afternoon writing into a workspace they did
        // not mean to be in.
        //
        // Resolved against THIS session's cwd, because the second source is the
        // repo's own .mcp.json, and it names which source it came from so the
        // sentence can be checked rather than believed. The claim is also now
        // true of the hooks, which is what it always asserted: "everything this
        // session reads and writes" used to exclude the two processes doing the
        // reading at the start and the writing at the end. See
        // workspace-override.ts.
        const workspaceNotice = consumeWorkspaceOverrideNotice({ projectDir: cwd });
        if (workspaceNotice) parts.push(workspaceNotice);

        if (activeResult?.brief) {
          // Honest recency: report when the context was *written*, not "last
          // active", and warn if the working tree has diverged since — the
          // recorded status/decisions are unverified against uncommitted work.
          const fresh = computeFreshness(cwd, activeResult.last_updated);

          // Token dedup: by the time the agent calls start_session, this same
          // brief is already in context — loaded at session start from
          // .deerdawn-context.md (@-imported via CLAUDE.md) and/or the
          // SessionStart hook. If the fresh brief is byte-identical to what's on
          // disk, the agent already has it, so emit a compact pointer instead of
          // repeating ~125 tokens. If it differs, the on-disk copy is stale —
          // deliver the fresh brief in full. (Read before syncProjectFiles below
          // rewrites the file, so we compare against what the agent loaded.)
          let alreadyLoaded = false;
          try {
            const onDisk = fs.readFileSync(join(findGitRoot(cwd) || cwd, '.deerdawn-context.md'), 'utf8').trim();
            alreadyLoaded = onDisk.length > 0 && onDisk === String(activeResult.brief).trim();
          } catch { /* no file on disk — deliver the full brief */ }

          // Cross-connection dedup: the backend reports recently_loaded when
          // another DeerDawn connection (e.g. the claude.ai connector) already
          // loaded this project moments ago. Same compact treatment as the
          // on-disk dedup — the brief is already in this session, so don't repeat it.
          const recentlyLoaded = Boolean(activeResult.recently_loaded);
          const reason = alreadyLoaded
            ? 'Context unchanged since session start (already loaded from .deerdawn-context.md).'
            : `Context already loaded moments ago${activeResult.recently_loaded_other_surface ? ' via your other DeerDawn connection' : ''} — not repeating it.`;

          // Day-two catch-up (server-computed): what changed since the PREVIOUS
          // session, session ordinal, gap phrasing, resume hint. Delivered even
          // when the brief itself dedups against .deerdawn-context.md — the
          // delta is precisely the part the on-disk copy can't contain.
          const catchupText = typeof activeResult.catchup?.text === 'string' && activeResult.catchup.text.trim()
            ? activeResult.catchup.text.trim()
            : null;
          let block = (alreadyLoaded || recentlyLoaded)
            ? [catchupText, `Resuming ${activeResult.project_name} — ${recencyLine(fresh)}. ${reason}`].filter(Boolean).join('\n\n')
            : [`Resuming ${activeResult.project_name} — ${recencyLine(fresh)}`, catchupText, activeResult.brief].filter(Boolean).join('\n\n');
          if (fresh.staleBadge) block = `${fresh.staleBadge}\n\n${block}`;
          // Honest match confidence: resolveActiveProject only auto-selects on a
          // real signal now, but a 'name' match (project name contains the repo
          // dir, no linked path) is a guess — flag it so the agent verifies rather
          // than trusting the wrong work-stream. 'path' matches are confident and
          // get no note. Prepended in the MCP block only (not the API body), so the
          // on-disk dedup + injection fingerprint stay byte-stable.
          //
          // Driven by what the API says about its own answer (match_confidence /
          // write_target) and by match_kind only for an API that says neither —
          // see isGuessedMatch. And it now says what the guess COSTS: a save with
          // no project_id is refused rather than filed under a guess, so the
          // agent is handed the id that makes the first save work, here, instead
          // of discovering the refusal later.
          if (isGuessedMatch(activeResult) && !(alreadyLoaded || recentlyLoaded)) {
            const how = activeResult.match_kind === 'name'
              ? 'matched by name'
              : activeResult.match_kind === 'recency_fallback'
                ? 'matched only by recent use'
                : activeResult.match_kind === 'ancestor_path'
                  ? 'a parent folder is linked to it, but this is another or unknown repository'
                  : 'a low-confidence match';
            const writeHint = activeResult.write_target === true
              ? ''
              : ` Saves with no project_id are refused until it is linked: if this IS the right project, pass project_id: "${activeResult.project_id}" on the first save and the directory is linked from then on.`;
            // The likely alternatives by id (the API sends them beside a
            // guess), so a wrong guess costs one call to correct, not a search.
            // PARITY: the hosted start_session and the SessionStart hook name
            // them the same way (routing-hint.ts alternativesLine).
            const others = alternativesLine(activeResult.alternatives);
            const switchHint = others
              ? ` ${others} To work in one of them, call manage_projects with action "select" and its project_id.`
              : '';
            block = `~ Best guess for this directory — "${activeResult.project_name}" isn't linked to this path yet (${how}). Verify it's the right project before relying on this.${writeHint}${switchHint}\n\n${block}`;
          }
          // Replayability: flag anchored fixes whose commit is no longer in HEAD
          // (rebased/squashed away) — those findings should be re-verified, not
          // trusted. git-only, best-effort, never blocks the brief.
          if (!(alreadyLoaded || recentlyLoaded) && Array.isArray(activeResult.anchored_commits) && activeResult.anchored_commits.length) {
            try {
              const refs = activeResult.anchored_commits.map((a: { ref: string }) => String(a.ref)).filter(Boolean);
              const inHead = checkCommitsInHead(cwd, refs);
              const gone = activeResult.anchored_commits.filter((a: { ref: string }) => inHead[String(a.ref)] === false);
              if (gone.length) {
                const goneLines = gone.slice(0, 3)
                  .map((a: { ref: string; summary?: string }) => `  ⚠ fix ${a.ref}${a.summary ? ` ("${String(a.summary).slice(0, 56)}")` : ''} is no longer in HEAD's history — re-verify before trusting it`)
                  .join('\n');
                block = `${block}\n${goneLines}`;
              }
            } catch { /* ancestry check is best-effort */ }
          }
          parts.push(block);
        }

        // ── The human-facing card ────────────────────────────────────────────
        // On Claude Code the SessionStart hook already rendered this card to the
        // user via systemMessage — deterministically, before we were even called —
        // so asking the agent to print it again would duplicate it.
        //
        // Every other surface has no hook, so the ONLY way the card reaches the
        // human is the agent relaying it. That path is model-mediated and therefore
        // fallible, which is exactly why it is the fallback and not the mechanism.
        if (activeResult?.card && !hasSessionStartHook()) {
          parts.push(
            `[Show the user this card verbatim at the very top of your reply, in a code block, before anything else. It is the only DeerDawn output written for them rather than for you — do not summarise, reformat, or translate it.]\n\n${activeResult.card}`,
          );
        }

        // Deterministic file refresh on session start keeps local context files in sync.
        // Fire the disk/skill refresh in the BACKGROUND. It rewrites
        // .deerdawn-context.md and syncs skills for the NEXT session and for other
        // tools — the current agent already has the brief in this response, and the
        // on-disk dedup read above already ran, so nothing here needs to block the
        // return. Reuse activeResult ('standard' only) to skip a redundant fetch.
        void syncProjectFiles(client, cwd, verbosity === 'standard' ? activeResult : undefined).catch(() => null);

        // Append compact list of non-active projects from map
        if (mapResult?.map) {
          const mapLines = mapResult.map.split('\n').filter((l: string) => !l.startsWith('[DeerDawn') && !l.startsWith('→ Call') && !l.startsWith('  Sections') && !l.startsWith('  →'));
          // Remove the → (active) project since we already showed it above
          const others = activeResult?.project_id
            ? mapLines.filter((l: string) => !l.includes(`(${activeResult.project_id})`))
            : mapLines;
          const otherContent = others.filter((l: string) => l.trim()).join('\n');
          // A "Now:" line on its own is a timestamp, not a list of projects.
          const listsSomething = others.some((l: string) => l.trim() && !NOW_LINE.test(l.trim()));
          if (otherContent && listsSomething) {
            parts.push(`─────────────────────────\nOther projects:\n${otherContent}`);
          }
        }

        // THE RECEIPT LEADS. One data line, rendered by the server from the
        // project it briefed (shared-context formatBriefReceipt): "DeerDawn
        // loaded X: 3 decisions, …". First, above every notice, because it is
        // what says the memory arrived at all. Data, not an instruction; absent
        // from an API that predates it. PARITY: hosted start_session leads with
        // the same line.
        if (activeResult?.brief && typeof activeResult.receipt === 'string' && activeResult.receipt.trim()) {
          parts.unshift(activeResult.receipt.trim());
        }

        const sessionText = parts.join('\n\n').trim();
        if (!sessionText) {
          // Brand-new workspace: the map endpoint returns boilerplate-only
          // content (header + call hints), which passes the hasFreshContext
          // gate but renders to nothing once filtered. Never return an empty
          // brief — a new user's first MCP response must point somewhere.
          //
          // But only an account with NO projects is "brand-new". One whose only
          // project is the (still empty) one resolved here lists nothing else,
          // and telling it "this account has no projects" is false.
          if (activeResult?.project_id || Number(mapResult?.project_count) > 0) {
            const name = activeResult?.project_name ? `"${activeResult.project_name}"` : 'This project';
            return { content: [{ type: 'text', text: `${name} has no saved brief yet, so there is nothing to load.\n\n${FIRST_BRIEF_DIRECTIVE}` }] };
          }
          return noContextResponse();
        }
        // PARITY with the hosted start_session's withAddonLines: at most three
        // add-on lines, rendered by the API, text only. Nothing when no add-on
        // is switched on, and nothing (never an error) when the call fails.
        const addonLines = typeof (client as any).addonBriefLines === 'function'
          ? await client.addonBriefLines().catch(() => [] as string[])
          : [];
        const withAddons = addonLines.length
          ? `${sessionText}\n\nAdd-ons:\n${addonLines.map((line) => `- ${line}`).join('\n')}`
          : sessionText;
        return { content: [{ type: 'text', text: withAddons }] };
      }

      case 'get_context': {
        const { project_id, tool, verbosity, sections, format } = GetContextSchema.parse(args);

        // JSON format — return structured data for programmatic access
        if (format === 'json') {
          const ctx = await client.getContextJson(project_id);
          return {
            content: [{ type: 'text', text: JSON.stringify(ctx, null, 2) }],
          };
        }

        if (sections && sections.length > 0) {
          const result = await client.getContextSections(project_id, sections as string[], tool, verbosity, readLocation(project_id));
          return {
            content: [{
              type: 'text',
              text: result.brief
                ? withProjectHeader(result)
                : `No context found for the requested sections.`,
            }],
          };
        }
        const result = await client.getActiveContext(project_id, tool, verbosity, readLocation(project_id));
        if (!result.brief || result.brief.trim().length < 20) {
          return {
            content: [{
              type: 'text',
              text: [
                result.project_name ? `Project: ${result.project_name}` : null,
                '',
                'No context captured yet for this project.',
                '',
                'Options:',
                '  • Call manage_memory(action:"import_local") to seed from CLAUDE.md — instant structured import',
                '  • Call manage_memory(action:"update", summary:"current task: X, decided Y because Z") to add context now',
                '  • Or just keep working — context captures automatically at end of each session',
              ].filter(s => s !== null).join('\n'),
            }],
          };
        }
        return {
          content: [{
            type: 'text',
            text: withProjectHeader(result),
          }],
        };
      }

      case 'read_brief': {
        // Product-voice alias of get_context's read path. Same args + section gate
        // (landmines/shipped are valid sections), but the default (no sections)
        // surfaces the 4-slot brief view (SHIPPED / DECIDED / OPEN / LANDMINE) by
        // requesting the opt-in brief shape — including the structured brief_spine.
        const { project_id, tool, verbosity, sections, format } = GetContextSchema.parse(args);

        if (format === 'json') {
          const ctx = await client.getContextJson(project_id);
          return { content: [{ type: 'text', text: JSON.stringify(ctx, null, 2) }] };
        }

        if (sections && sections.length > 0) {
          const result = await client.getContextSections(project_id, sections as string[], tool, verbosity, readLocation(project_id));
          return {
            content: [{
              type: 'text',
              text: result.brief
                ? withProjectHeader(result)
                : 'No brief found for the requested sections.',
            }],
          };
        }

        const result = await client.getActiveBrief(project_id, tool, verbosity, readLocation(project_id));
        if (!result.brief || result.brief.trim().length < 20) {
          return {
            content: [{
              type: 'text',
              text: [
                result.project_name ? `Project: ${result.project_name}` : null,
                '',
                'No brief captured yet for this project.',
                '',
                'Options:',
                '  • Call manage_memory(action:"import_local") to seed from CLAUDE.md — instant structured import',
                '  • Call manage_memory(action:"update", summary:"decided X because Y" / "landmine: Z") to add to the brief now',
                '  • Or just keep working — the brief fills in automatically as you go',
              ].filter(s => s !== null).join('\n'),
            }],
          };
        }
        return {
          content: [{
            type: 'text',
            text: withProjectHeader(result),
          }],
        };
      }

      case 'search_context': {
        const { query, limit } = SearchContextSchema.parse(args);
        const result = await client.searchContext(query, limit);
        const hits = result?.results ?? [];
        if (hits.length === 0) {
          return { content: [{ type: 'text', text: `No context found matching "${query}".` }] };
        }
        const lines = hits.map((h: any) =>
          `[${h.project_name}] ${h.field}: ${h.snippet}`
        );
        return { content: [{ type: 'text', text: `Results for "${query}":\n\n${lines.join('\n\n')}` }] };
      }

      case 'get_workspace_overview': {
        const parsed = WorkspaceOverviewSchema.parse(args);
        const result = await client.getWorkspaceOverview(parsed);
        if (parsed.format === 'json') {
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        return { content: [{ type: 'text', text: result.text || result.overview || result.body || 'No workspace overview yet.' }] };
      }

      case 'get_workspace_entities': {
        const parsed = WorkspaceEntitiesSchema.parse(args);
        const result = await client.getWorkspaceEntities(parsed);
        if (parsed.format === 'json') {
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        return { content: [{ type: 'text', text: result.text || 'No workspace entities found.' }] };
      }

      // Cross-project memory. The server does the work: portfolioService already
      // resolves the owner-scoped CTE over context_graph_evidence (a per-node
      // LATERAL on the unindexed evidence.node_id measured 14,219ms and tripped
      // the 8s DB breaker) and already merges decisions in JS because project
      // context is encrypted at rest. Rendering is shared-context's formatPortfolio,
      // the same function the hosted dispatcher calls, so the two cannot drift.
      case 'get_portfolio': {
        const parsed = PortfolioSchema.parse(args);
        const portfolio = await client.getPortfolio({
          query: parsed.query,
          entity_limit: parsed.limit,
          decision_limit: 5,
        });
        if (parsed.format === 'json') {
          return { content: [{ type: 'text', text: JSON.stringify(portfolio, null, 2) }] };
        }
        return {
          content: [{
            type: 'text',
            text: formatPortfolio(portfolio, { entityLimit: parsed.limit, decisionLimit: 5 }),
          }],
        };
      }

      case 'mark_resolved': {
        const parsed = MarkResolvedSchema.parse(args);
        // A DECISION IN A NAMED PROJECT IS RESOLVED IN THAT PROJECT'S BRIEF.
        // Decision nodes are unique per owner and keep the first project that
        // wrote them, so resolving through the node flipped whichever project got
        // there first: the same decision in repos A and B, resolved "in B",
        // resolved A and left B open behind "already resolved". The server reads
        // and writes the NAMED project's decision log by the decision's text and
        // hands back the words to reply with. Only a text that is no decision of
        // that project falls through to the entity search below.
        //
        // An omitted project_id is this directory's project — the write target
        // every other id-less write here uses (resolveWriteTarget), never a name
        // or recency guess. Omitted, this went straight to the entity search and
        // resolved whichever project's node it found (scan 27). No target: the
        // entity search answers, as before.
        // PARITY: identical to the hosted mark_resolved (apps/api/src/routes/
        // mcp.js), which calls the same service in-process.
        const decisionLike = !parsed.entity_type || parsed.entity_type === 'decision';
        let projectId: string | undefined = parsed.project_id;
        let fromActive = false;
        if (!projectId && decisionLike) {
          const target = await resolveWriteTarget(client, process.env.CLAUDE_PROJECT_DIR || process.cwd()).catch(() => null);
          if (target?.kind === 'target') {
            projectId = target.projectId;
            fromActive = true;
          }
        }
        let briefMiss: any = null;
        // Set when the API has no decision-resolve route: it predates resolving
        // in a named project, so a decision filed elsewhere cannot be judged.
        let briefUnsupported = false;
        if (projectId && decisionLike) {
          try {
            const outcome = await client.resolveProjectDecision(projectId, {
              title: parsed.title,
              ...(parsed.notes ? { notes: parsed.notes } : {}),
              // No entity_type: the text may name a task as well — weighed by
              // the server before any decision (PARITY: hosted mark_resolved).
              ...(!parsed.entity_type ? { untyped: true } : {}),
            });
            if (outcome?.outcome && outcome.outcome !== 'not_found') {
              return { content: [{ type: 'text', text: String(outcome.message || '') }] };
            }
            if (outcome?.outcome === 'not_found') briefMiss = outcome;
          } catch (error: any) {
            const status = error?.response?.status;
            const data = error?.response?.data;
            if (status === 404 && data?.error === 'project_not_found') {
              if (!fromActive) throw new ToolInputError(unknownProjectMessage(String(parsed.project_id)));
              projectId = undefined;
              fromActive = false;
            } else if (status === 403) {
              return { content: [{ type: 'text', text: String(data?.message || data?.error || 'You cannot edit the decisions of that project, so nothing was resolved.') }] };
            } else if (status === 404) {
              // An API that predates the route: the entity search below still
              // answers, and never with another project's decision.
              briefUnsupported = true;
            }
          }
        }
        // Search for matching entities first (include resolved so we can see if already done)
        const searchResult = await client.getWorkspaceEntities({
          query: parsed.title,
          ...(parsed.entity_type ? { types: [parsed.entity_type] } : {}),
          ...(projectId ? { project_id: projectId } : {}),
          include_resolved: true,
          limit: 5,
          format: 'json',
        });
        const candidates: any[] = searchResult?.entities || [];
        if (!candidates.length) {
          // Named for a tool the caller can actually call: get_workspace_entities
          // dispatches but is not in tools/list, so a reply pointing at it hands
          // the caller "Unknown tool". recall(action:"entities") is the route.
          return {
            content: [{
              type: 'text',
              text: briefMiss
                ? `${briefMiss.message}\nNo stored entity matches it either.`
                : `No entity found matching "${parsed.title}". Check the title and try again, or browse with recall({ action: "entities" }).`,
            }],
          };
        }

        // Resolve EXACTLY ONE entity, or refuse and show the choices.
        //
        // This used to resolve every candidate the search returned — up to five —
        // from a single title. One call marked five unrelated entities resolved
        // and printed all five titles as if that had been asked for. A search
        // ranking is a guess; acting on all of it is never what "mark this
        // resolved" meant. An exact title match (or a node id) is unambiguous, so
        // it wins outright; anything else stops and asks.
        // "Exact" is the entity's own text, not only its title: a decision or
        // task over 80 characters is stored under a title cut to 79 + "...", so
        // its complete text matched no title and was refused (scan 27).
        let exact = candidates.filter((e: any) => entityNamedExactly(e, parsed.title));
        // The cut a brief shows, "..." and all: the opening of exactly ONE
        // decision (decisionsNamedByOpening). PARITY: hosted mark_resolved.
        if (!exact.length && (!parsed.entity_type || parsed.entity_type === 'decision')) {
          exact = await decisionsNamedByOpening(client, parsed.title, projectId);
        }
        // The caller's own node first: the same title in two homes (the
        // caller's beside a colleague's) is not ambiguous in the project being
        // worked in. PARITY: hosted preferCallersHome (scan 32).
        exact = preferCallersHome(exact, projectId);
        // Only an EXACT title (or node id). A lone search hit was taken as the
        // answer too, and the search ranks by shared words, not identity: a
        // decision not yet in the graph resolved the one decision in ANOTHER
        // project that shared a few words with it.
        const target = exact.length === 1 ? exact[0] : null;
        if (!target) {
          const list = (exact.length > 1 ? exact : candidates)
            .map((e: any) => `  - "${e.title}" (${e.node_type || e.metadata?.entity_type || 'unknown type'})${e.metadata?.status === 'resolved' ? ' — already resolved' : ''}`)
            .join('\n');
          // Disambiguate with entity_type, NOT a node id. The id is printed
          // nowhere on purpose: the entity search matches on title/summary/
          // canonical_key text (nodeText server-side) and never on node_id, so
          // telling the caller to re-run with an id sends them to a guaranteed
          // "No entity found" — advice that cannot work is worse than none.
          // entity_type is already a parameter of this tool and does filter.
          const types = Array.from(new Set(
            (exact.length > 1 ? exact : candidates).map((e: any) => e.node_type || e.metadata?.entity_type).filter(Boolean)
          ));
          const disambiguator = types.length > 1
            ? `Re-run with the exact title plus entity_type (one of: ${types.join(', ')}).`
            : 'Re-run with the exact, complete title.';
          if (!exact.length) {
            return {
              content: [{
                type: 'text',
                text: `No entity is named exactly "${parsed.title}" (by its title, or by the complete text a cut title stands for), so nothing was resolved.${briefMiss ? ` ${String(briefMiss.message || '').split('\n')[0]}` : ''}\nClosest:\n${list}\n${disambiguator}`,
              }],
            };
          }
          const homes = await sameTitleHomes(client, exact);
          if (homes) {
            const where = exact
              .map((e: any, i: number) => `  - "${e.title}" (${e.node_type || e.metadata?.entity_type || 'unknown type'}) ${homes[i]}${e.metadata?.status === 'resolved' ? ' — already resolved' : ''}`)
              .join('\n');
            return {
              content: [{
                type: 'text',
                text: `"${parsed.title}" matches ${exact.length} entities with this same title in different places, so nothing was resolved — resolving the wrong one is not recoverable from here.\n${where}\nRe-run with project_id naming the project whose copy you mean.`,
              }],
            };
          }
          return {
            content: [{
              type: 'text',
              text: `"${parsed.title}" matches ${exact.length} entities, so nothing was resolved — resolving the wrong one is not recoverable from here.\n${list}\n${disambiguator}`,
            }],
          };
        }

        // A decision filed under ANOTHER project than the one named is that
        // project's decision; resolving its node would flip that project's brief.
        if (projectId && target.node_type === 'decision' && target.project_id && target.project_id !== projectId) {
          if (briefUnsupported) {
            // The node is filed elsewhere, but that says nothing about this
            // project's own log, which an older API cannot resolve in: saying
            // "a decision in another project" was false whenever it is here too.
            return {
              content: [{
                type: 'text',
                text: `"${target.title}" was not resolved: the DeerDawn API this server talks to is too old to resolve a decision in ${fromActive ? 'the active project' : 'the project named'} (it has no decision-resolve route). Update or redeploy the DeerDawn API, then retry. Nothing was changed.`,
              }],
            };
          }
          const here = fromActive
            ? `not in the active project${briefMiss?.project_name ? ` (${briefMiss.project_name})` : ''}`
            : 'not in the one named';
          return {
            content: [{
              type: 'text',
              text: `"${target.title}" is a decision in another project, ${here}, so nothing was resolved. ${briefMiss ? String(briefMiss.message || '').split('\n')[0] : ''}\nTo resolve it where it is recorded, re-run with project_id: "${target.project_id}".`.trim(),
            }],
          };
        }

        if (target.metadata?.status === 'resolved') {
          return { content: [{ type: 'text', text: `"${target.title}" is already resolved — nothing to do.` }] };
        }

        const now = new Date().toISOString();
        const written = await client.upsertWorkspaceEntities({
          entities: [{
            // node_type is what the DB keys on; metadata.entity_type is a label and
            // can disagree with it. Writing the label would land on a different
            // identity, which is the same duplicate-instead-of-update failure the
            // canonical_key round-trip used to cause.
            entity_type: target.node_type || target.metadata?.entity_type,
            title: target.title,
            // Carry the summary through unchanged. Overwriting it with the note
            // destroyed the entity's actual content — the one thing a later reader
            // needs — to store a sentence about closing it. The note belongs in
            // metadata, beside the status it explains.
            summary: target.summary || '',
            canonical_key: target.canonical_key,
            // scope is inferred from project_id server-side, so a project entity
            // silently becomes a workspace one if this is dropped.
            ...(target.project_id ? { project_id: target.project_id, scope: 'project' as const } : {}),
            metadata: {
              ...(target.metadata || {}),
              status: 'resolved',
              resolved_at: now,
              ...(parsed.notes ? { resolution_note: parsed.notes } : {}),
            },
          }],
        });

        // Read back before claiming it. The write path can no-op (a stale
        // canonical_key, a rejected payload) and this tool has historically
        // reported success regardless.
        let confirmed = true;
        try {
          const after = await client.getWorkspaceEntities({
            query: target.title,
            ...(target.project_id ? { project_id: target.project_id } : {}),
            include_resolved: true,
            limit: 5,
            format: 'json',
          });
          const same = (after?.entities || []).find((e: any) => e.canonical_key === target.canonical_key);
          confirmed = !same || same.metadata?.status === 'resolved';
        } catch {
          // Best-effort: a failed read-back must not report a good write as bad.
        }
        if (!confirmed) {
          return {
            content: [{
              type: 'text',
              text: `⚠ "${target.title}" is NOT resolved. The write returned without error but the entity still reads unresolved. Nothing else was changed. Check the entity with recall({ action: "entities", status: "resolved" }) before retrying.`,
            }],
          };
        }

        return {
          content: [{
            type: 'text',
            text: `Marked resolved: "${target.title}".${typeof written?.decision_resolves_note === 'string' ? written.decision_resolves_note : ''}\nThis entry will no longer appear in normal context loads.\nRetrieve with: recall({ action: "entities", status: "resolved" })`,
          }],
        };
      }

      case 'get_project_map': {
        const parsed = ProjectMapSchema.parse(args);
        const result = await client.getProjectMap(parsed);
        if (!result) {
          return { content: [{ type: 'text', text: 'No active project map found yet.' }] };
        }
        if (parsed.format === 'json') {
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        return { content: [{ type: 'text', text: result.text || 'No project map available yet.' }] };
      }

      case 'find_known_paths': {
        const parsed = KnownPathsSchema.parse(args);
        const result = await client.findKnownPaths({
          query: parsed.query,
          project_id: parsed.project_id,
          limit: parsed.limit,
          format: parsed.format,
        });
        if (parsed.format === 'json') {
          return { content: [{ type: 'text', text: JSON.stringify(result.results || result, null, 2) }] };
        }
        return { content: [{ type: 'text', text: result.text || 'No known paths found.' }] };
      }

      case 'upsert_workspace_entities': {
        const parsed = UpsertWorkspaceEntitiesSchema.parse(args);
        const result = await client.upsertWorkspaceEntities({
          entities: parsed.entities.map((entity) => ({
            entity_type: entity.entity_type,
            // The schema's own .refine() guarantees at least one of title/name is
            // non-empty before we get here; the '' fallback only satisfies the type.
            title: ((entity.title && String(entity.title).trim()) ? entity.title : entity.name) || '',
            summary: entity.summary,
            scope: entity.scope,
            project_id: entity.project_id,
            ...(entity.filed_by_default === true ? { filed_by_default: true } : {}),
            canonical_key: entity.canonical_key,
            metadata: entity.metadata as Record<string, unknown> | undefined,
          })),
          relations: parsed.relations?.map((relation) => ({
            from_canonical_key: relation.from_canonical_key,
            to_canonical_key: relation.to_canonical_key,
            relation_type: relation.relation_type,
            summary: relation.summary,
          })),
        });
        const entities = result.entities || [];
        const relations = result.relations || [];
        // PARITY with upsert_workspace_entities in apps/api/src/routes/mcp.js:
        // entities the batch skipped, and relations whose endpoint did not
        // resolve, are NAMED. Both were counted out in silence here, so a
        // relation to `project:atlas` simply never existed and nothing said so.
        const skipped: any[] = Array.isArray(result.skipped) ? result.skipped : [];
        const unresolved: any[] = Array.isArray(result.unresolved_relations) ? result.unresolved_relations : [];
        const describeMiss = (reason: string) => (reason === 'ambiguous_project_name'
          ? 'more than one project you can see has this name; use project:<project_id>'
          : 'no such entity you can see');
        const lines = [
          // The filing note is the service's (where the entities landed: the
          // project by name, or the workspace), appended in its own words.
          `Upserted ${entities.length} workspace entit${entities.length === 1 ? 'y' : 'ies'}.${typeof result.filed_note === 'string' ? result.filed_note : ''}`,
          relations.length ? `Recorded ${relations.length} relation${relations.length === 1 ? '' : 's'}.` : '',
          skipped.length
            ? `Skipped ${skipped.length}: ${skipped.map((entry) => `"${entry.title || '(untitled)'}" (${entry.message || entry.reason})`).join('; ')}.`
            : '',
          unresolved.length
            ? `Did not record ${unresolved.length} relation${unresolved.length === 1 ? '' : 's'}: ${unresolved.map((entry) => `${entry.from_canonical_key} ${entry.relation_type} ${entry.to_canonical_key} (${(entry.unresolved || []).map((u: any) => `${u.key}: ${describeMiss(u.reason)}`).join('; ')})`).join('; ')}.`
            : '',
          // What a resolved decision did to its project's decision log, in the
          // server's words (the same note the hosted reply carries).
          typeof result.decision_resolves_note === 'string' ? result.decision_resolves_note.trim() : '',
          // A stored description the upsert did not replace (scan 30).
          typeof result.summaries_kept_note === 'string' ? result.summaries_kept_note.trim() : '',
          // The caller's own pre-team private nodes this save published or kept
          // (scan 32), as the hosted reply says it.
          typeof result.private_note === 'string' ? result.private_note.trim() : '',
        ].filter(Boolean);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // ─── Trails ──────────────────────────────────────────────────────────
      // Reached via manage_memory(action:"export_trail"|"import_trail").
      case 'export_trail': {
        const projectId = String(args?.project_id || '');
        if (!projectId) {
          throw new ToolInputError('export_trail requires project_id — the project to archive. Unlike the reads, it does not fall back to the active project.');
        }
        const cwd = process.cwd();
        const pin = getSourcePin(cwd);
        // `kind` decides whether the archive carries this project's task state,
        // goals and board to whoever imports it. Every unrecognised value used to
        // become "project" in silence, so a caller reaching for a shareable pack
        // and mistyping got the variant that donates the private half — with a
        // success message naming the kind it had substituted.
        const rawKind = args?.kind == null ? '' : String(args.kind).trim().toLowerCase();
        if (rawKind && rawKind !== 'pack' && rawKind !== 'project') {
          throw new ToolInputError(`export_trail: kind must be "project" or "pack" (got ${JSON.stringify(args.kind)}). "project" records this project; "pack" marks it as knowledge for other people's projects, and importing a pack skips this project's task state, goals and board.`);
        }
        const kind = rawKind === 'pack' ? 'pack' : 'project';
        const result = await client.exportTrail(projectId, {
          repo_url: pin.repo_url || undefined,
          commit_sha: pin.commit_sha || undefined,
          branch: pin.branch || undefined,
        }, { kind });

        const trail = typeof result === 'string' ? JSON.parse(result) : result;
        const filename = String(args?.output_path || '').trim()
          || join(cwd, `${String(trail?.manifest?.title || 'trail').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'trail'}.dawn`);
        await fs.promises.writeFile(filename, `${JSON.stringify(trail, null, 2)}\n`, 'utf8');

        const counts = trail?.manifest?.counts || {};
        const pinLine = trail?.manifest?.source?.pinned
          ? `Pinned to ${trail.manifest.source.commit_sha?.slice(0, 12)}${pin.dirty ? ' (working tree is dirty — the Trail describes uncommitted code)' : ''}.`
          : `NOT pinned to a commit (${trail?.manifest?.source?.unpinned_reason || 'unknown'}) — consumers cannot check how stale it is.`;

        return {
          content: [{
            type: 'text',
            text: [
              `Wrote ${filename}`,
              `${counts.decisions || 0} decisions, ${counts.graph_nodes || 0} entities, ${counts.graph_edges || 0} relationships, ${counts.paths || 0} paths, ${counts.findings || 0} findings, ${counts.board_cards || 0} cards.`,
              kind === 'pack'
                ? "Kind: pack. Importing it donates tech stack, recurring context, landmines, decisions, paths, findings, commands and the graph — not this project's task state, goals, open questions or board."
                : 'Kind: project. Importing it into an empty project donates the whole brief, this project\'s current task included. Export with kind:"pack" if it is meant for other people\'s projects.',
              pinLine,
              '',
              'This file is PRIVATE and has not been scanned for secrets, emails, home paths, financial figures, or personal names. Do not share it. Publishing runs a separate redaction review that must be completed per finding.',
            ].join('\n'),
          }],
        };
      }

      case 'import_trail': {
        const raw = String(args?.trail || '').trim();
        if (!raw) {
          throw new ToolInputError('import_trail requires `trail`: a URL, the .dawn contents, or a path to a .dawn file.');
        }
        // dry_run is the difference between a READ (return the merge plan) and a
        // WRITE (merge into a real project), and `=== true` decided it in the
        // writing direction for everything that was not a literal boolean. A
        // client that stringifies booleans — the exact hazard coerceConfirmedFlag
        // exists for — asked for a plan and got an import. Resolved before the
        // fetch, so a bad value costs nothing.
        const dryRun = coerceOptionalBooleanFlag(args?.dry_run, 'import_trail: dry_run');
        // Accept a URL, a path, or the literal contents — an agent has often just
        // been handed one of the three, and failing on the other two is a
        // pointless round-trip.
        let contents = raw;
        if (/^https?:\/\//i.test(raw)) {
          try {
            contents = await fetchTrailByUrl(raw);
          } catch (error) {
            // A bad link is the caller's to fix — wrong URL, dead host, a page
            // where a .dawn should be. It comes back as readable text rather
            // than through handleApiError, which collapses every Error to
            // "Operation failed (Error)" and strands the agent on a typo.
            return { content: [{ type: 'text', text: String((error as Error)?.message || 'import_trail: could not fetch that URL.') }] };
          }
        } else if (!raw.startsWith('{')) {
          const resolved = isAbsolute(raw) ? raw : join(process.cwd(), raw);
          contents = await fs.promises.readFile(resolved, 'utf8');
        }
        // The API refuses contents over MAX_TRAIL_CHARS (the same shared number
        // its validator and body parser use). Say so here, readably, instead of
        // posting megabytes to collect a bare 413 that handleApiError flattens.
        if (contents.length > MAX_TRAIL_CHARS) {
          return { content: [{ type: 'text', text: `import_trail: that Trail is larger than the ${MAX_TRAIL_CHARS} character limit for a .dawn archive, so it was not imported.` }] };
        }
        const result = await client.importTrail({
          trail: contents,
          project_id: args?.project_id ? String(args.project_id) : undefined,
          new_project_name: args?.new_project_name ? String(args.new_project_name) : undefined,
          dry_run: dryRun,
        });

        const applied = result?.plan?.applied || {};
        const lines = [
          result?.applied
            ? `Imported into ${result.project_name} (${result.project_id}).`
            : 'Dry run — nothing was written.',
          `${applied.decisions || 0} decisions, ${applied.paths || 0} paths, ${applied.findings || 0} findings, ${applied.commands || 0} commands, ${applied.board_cards || 0} cards, ${applied.entities || 0} entities, ${applied.relations || 0} relationships.`,
        ];
        const skipped = result?.plan?.skipped_brief_fields || [];
        if (skipped.length) {
          // Say what a pack carried and did not give you. Silence here reads as
          // "the pack had nothing to say about your task", which is a different
          // claim from "it had something and we deliberately did not apply it".
          lines.push('', `Pack — ${skipped.length} brief field${skipped.length === 1 ? '' : 's'} present in the Trail but not applied (they describe its author's project): ${skipped.join(', ')}.`);
        }
        if (result?.conflicts?.length) {
          lines.push('', `${result.conflicts.length} field${result.conflicts.length === 1 ? '' : 's'} kept the existing value rather than the imported one:`);
          for (const conflict of result.conflicts.slice(0, 8)) lines.push(`  • ${conflict.field}`);
        }
        // The Done column is capped, so importing a Trail's finished cards into
        // a full board pushes cards off it — the user's own among them. The API
        // names them (`evicted_cards`, services/trail) and the hosted dispatcher
        // has said so since #530; this reply reported the applied count alone
        // over the loss. PARITY: same sentence as import_trail in
        // apps/api/src/routes/mcp.js.
        const evictedCards = Array.isArray(result?.evicted_cards)
          ? result.evicted_cards.filter((card: any) => card?.title)
          : [];
        if (evictedCards.length) {
          const shown = evictedCards.slice(0, 5).map((card: any) => `"${card.title}"`).join(', ');
          const more = evictedCards.length > 5 ? ` and ${evictedCards.length - 5} more` : '';
          lines.push('', `The board is at its card limit, so ${evictedCards.length} card${evictedCards.length === 1 ? '' : 's'} did not stay on it: ${shown}${more}.`);
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'record_hot_paths': {
        const parsed = RecordHotPathsSchema.parse(args);
        const projectId = await resolveProjectIdFromCwd(client, parsed.project_id, 'record hot paths in');
        const result = await client.recordHotPaths(projectId, parsed.items.map((item) => ({
          label: item.label,
          path: item.path,
          purpose: item.purpose,
          ...(item.importance ? { importance: item.importance } : {}),
          ...(item.pinned ? { pinned: true } : {}),
        })));
        await client.recordContextEvent({
          event_type: 'hot_path_discovered',
          project_id: projectId,
          summary: `Recorded ${parsed.items.length} durable hot path${parsed.items.length === 1 ? '' : 's'}.`,
          metadata: { items: parsed.items, surface: 'claude_code' },
        }).catch(() => null);
        // Relay what the API STORED, not what was asked for. Both this write and
        // the finding below go through mergeContextObject, which dedupes and
        // caps — hot_paths holds 40 — and the service additionally prunes any
        // stored entry whose normalized path collides with an incoming one. So
        // recording five paths onto a nearly-full project stores fewer than
        // five, and "Recorded 5 hot paths" was the silent-success shape this
        // repo keeps paying for. The response already carries the truth.
        //
        // Compared on the PATH, which is the key the service dedupes on: the
        // freshest label wins, so a label comparison would report a stored path
        // as dropped.
        //
        // And on the path AS IT IS STORED. normalizeHotPaths runs every label
        // and path through redactSecretText, so a path carrying a token is
        // stored rewritten — comparing the raw one would report a landed write
        // as lost, which is exactly the mistake the explicit-update read-back
        // made before 7a3cecee.
        const storedPaths = Array.isArray(result?.hot_paths) ? result.hot_paths : null;
        const projectLabel = result?.project_name || projectId;
        // Eviction is a DELETION, and it is the one outcome neither the request
        // nor the stored array can show: hot_paths comes back full either way,
        // so a write that quietly dropped two older paths to make room read as
        // an unremarkable success. The service reports the count
        // (contextSyncService.recordHotPaths) and the hosted dispatcher has
        // relayed it since it was added; only this reply threw it away. Same
        // sentence as the hosted one, so a single write cannot describe itself
        // two ways depending on which connector ran it. An older API sends no
        // such field, and then there is simply nothing to say.
        const evicted = Number.isInteger(result?.evicted) ? Number(result.evicted) : 0;
        const evictedNote = evicted > 0
          ? ` ${evicted} older path${evicted === 1 ? '' : 's'} made room and ${evicted === 1 ? 'is' : 'are'} no longer in the brief.`
          : '';
        // A member adding to a teammate's shared project may add paths but not
        // rewrite them: a path somebody already recorded is left as it was and
        // counted here, and the API sends no stored list when the share withholds
        // the section. Either way "Recorded N" over those paths was untrue.
        // PARITY: the hosted record_hot_paths reply in apps/api/src/routes/mcp.js.
        const alreadyRecorded = Number.isInteger(result?.already_recorded) ? Number(result.already_recorded) : 0;
        const alreadyNote = alreadyRecorded > 0
          ? ` ${alreadyRecorded} ${alreadyRecorded === 1 ? 'was' : 'were'} already recorded and left as ${alreadyRecorded === 1 ? 'it was' : 'they were'}: you may add hot paths to this project but not rewrite them.`
          : '';
        if (alreadyRecorded > 0 && Number.isInteger(result?.stored)) {
          const storedCount = Number(result.stored);
          return {
            content: [{ type: 'text', text: `Recorded ${storedCount} of ${parsed.items.length} hot path${parsed.items.length === 1 ? '' : 's'} for ${projectLabel}.${alreadyNote}${evictedNote}` }],
          };
        }
        if (storedPaths) {
          const pathKey = (value: unknown) => String(redactSecretText(String(value ?? ''))).trim().toLowerCase();
          const storedKeys = new Set(storedPaths.map((entry: any) => pathKey(entry?.path)));
          const missing = parsed.items.filter((item) => !storedKeys.has(pathKey(item.path)));
          if (missing.length) {
            return {
              content: [{
                type: 'text',
                text: `Recorded ${parsed.items.length - missing.length} of ${parsed.items.length} hot paths for ${projectLabel}. `
                  + `NOT stored: ${missing.map((item) => item.path).join(', ')}. The project holds ${storedPaths.length} paths and the list is capped. `
                  + `Remove a stale path, or pin the ones that matter with importance.${evictedNote}`,
              }],
            };
          }
        }
        // No stored list to judge against (an older API build): report the
        // request rather than turning an unmeasurable write into a reported loss.
        return {
          content: [{ type: 'text', text: `Recorded ${parsed.items.length} hot path${parsed.items.length === 1 ? '' : 's'} for ${projectLabel}.${evictedNote}` }],
        };
      }

      case 'record_debug_finding': {
        const parsed = RecordDebugFindingSchema.parse(args);
        const projectId = await resolveProjectIdFromCwd(client, parsed.project_id, 'record a finding in');
        // Anchor the finding to a commit so it's replayable. Auto-capture the
        // current HEAD when the caller didn't supply one.
        const commitRef = parsed.commit_ref || getHeadSha(process.cwd()) || undefined;
        const result = await client.recordDebugFinding(projectId, {
          summary: parsed.summary,
          paths: parsed.paths,
          added_at: parsed.added_at,
          commit_ref: commitRef,
          diff_ref: parsed.diff_ref,
          ...(parsed.importance ? { importance: parsed.importance } : {}),
          ...(parsed.pinned ? { pinned: true } : {}),
          ...(parsed.supersedes ? { supersedes: parsed.supersedes } : {}),
        });
        await client.recordContextEvent({
          event_type: 'debug_finding',
          project_id: projectId,
          summary: parsed.summary,
          metadata: { paths: parsed.paths, added_at: parsed.added_at, commit_ref: commitRef, diff_ref: parsed.diff_ref, surface: 'claude_code' },
        }).catch(() => null);
        const anchor = commitRef ? ` (anchored to commit ${commitRef})` : '';
        const findingLabel = result?.project_name || projectId;
        // PARITY with the hosted dispatcher: a teammate already filed this
        // finding, so the API left their note as it was and wrote nothing.
        if (result?.already_recorded) {
          return {
            content: [{ type: 'text', text: `Already recorded in ${findingLabel}: a teammate filed this finding, so their note was left as it is and nothing was changed.` }],
          };
        }
        // Same rule as record_hot_paths above: debugging_notes is capped at 30
        // and ranked, so a low-importance note onto a full log is dropped by the
        // merge while the write returns 200. The response carries the stored
        // log, so the reply is judged against it rather than against the request.
        //
        // Against the summary AS IT IS STORED: normalizeDebuggingNotes redacts
        // every summary, so a finding naming a key lands rewritten and a raw
        // comparison would call a successful write a loss (7a3cecee).
        const storedNotes = Array.isArray(result?.debugging_notes) ? result.debugging_notes : null;
        const storedSummary = String(redactSecretText(parsed.summary)).trim();
        if (storedNotes && !storedNotes.some((note: any) => String(note?.summary || '').trim() === storedSummary)) {
          return {
            content: [{
              type: 'text',
              text: `⚠ NOT recorded: the finding is not in ${findingLabel}'s stored notes after the write. `
                + `The log holds ${storedNotes.length} notes and is capped, so a note can be dropped by the merge. `
                + 'Retry with importance:"high" or pinned:true, or supersede the note this one replaces.',
            }],
          };
        }
        // A note can REPLACE an earlier one through a dedupe-key collision: two
        // notes differing only by a date or a counter are one note by design, so
        // the write that looks like an append is sometimes an overwrite of
        // somebody's finding. The service names what it dropped and the hosted
        // dispatcher says so; this reply said "Recorded" and nothing else, which
        // is the same silent loss the rest of this family exists to stop.
        // Clipped to 80 like the hosted wording, and absent on an older API.
        const replaced = typeof result?.replaced === 'string' && result.replaced.trim() ? String(result.replaced) : null;
        const replacedNote = replaced
          ? ` Replaced an earlier note: "${replaced.slice(0, 80)}${replaced.length > 80 ? '…' : ''}".`
          : '';
        return {
          content: [{ type: 'text', text: `Recorded debugging finding for ${findingLabel}${anchor}.${replacedNote}` }],
        };
      }

      case 'confirm_claim': {
        const parsed = ConfirmClaimSchema.parse(args);
        const projectId = await resolveProjectIdFromCwd(client, parsed.project_id, 'confirm a claim in');
        // Default to the current HEAD as the commit the claim was verified against.
        const verifiedCommit = parsed.verified_commit || getHeadSha(process.cwd()) || undefined;
        const result = await client.confirmClaim(projectId, { claim: parsed.claim, verified_commit: verifiedCommit });
        if (!result?.verified) {
          return { content: [{ type: 'text', text: `No matching claim found to verify for "${parsed.claim}". Try a phrase from a recent decision, or "status" for the current status.` }] };
        }
        const what = result.verified.kind === 'current_status' ? 'the current status' : `decision "${result.verified.summary}"`;
        return {
          content: [{ type: 'text', text: `Verified ${what}${verifiedCommit ? ` at ${verifiedCommit}` : ''}. Future sessions will see it as confirmed and won't re-check it.` }],
        };
      }

      // ─── Retire ONE open question ──────────────────────────────────────────
      //
      // Reached through manage_memory(action:"resolve_question"), never
      // advertised on its own.
      //
      // Before this, the only agent-facing lever on open_questions was
      // cleanup_context, which empties the list wholesale along with the command
      // log and the blocking issue. A brief that collected a dead question had no
      // way to drop just that one, so they piled up unread — a live brief was
      // carrying twelve, at least two of them demonstrably answered.
      //
      // Two shapes matter here.
      //
      // It is a SEPARATE action from `resolve` (mark_resolved) even though both
      // words mean "close this". mark_resolved searches the workspace graph and
      // flips an entity; this edits the brief's open_questions list. Overloading
      // one action across two stores would mean inferring which the caller meant
      // from whichever optional argument arrived — loose matching on a
      // destructive path, which is a failure this repo has already paid for more
      // than once. An enum value is cheap; a wrong store is not recoverable.
      //
      // And resolving NOTHING is a normal outcome, reported as text carrying the
      // candidate questions verbatim rather than as a bare error. A caller told
      // only "that was ambiguous" cannot become unambiguous; a caller shown the
      // two questions it fell between can re-send one of them. The wording lives
      // in shared-context (formatQuestionResolution) so the hosted dispatcher in
      // apps/api/src/routes/mcp.js cannot drift from it.
      case 'resolve_open_question': {
        const parsed = ResolveOpenQuestionSchema.parse(args);
        const projectId = await resolveProjectIdFromCwd(client, parsed.project_id, 'resolve a question in');
        // Sent as typed (the API matches it as sent and then as stored), but
        // QUOTED masked: the brief holds a pasted key redacted, and a reply —
        // a refusal above all — is no reason to hand it back in clear.
        const shownQuestion = redactSecrets(parsed.question);

        // Read the remaining questions so BOTH refusals can name real text. On a
        // miss the API says only "no match", which is true and useless; the list
        // is what makes the next attempt correct.
        const stillOpen = async (): Promise<string[]> => {
          const contextJson = await client.getContextJson(projectId).catch(() => null);
          const context = contextJson?.context ? contextJson.context : contextJson;
          const open = context?.open_questions;
          return Array.isArray(open) ? open : [];
        };

        try {
          const result = await client.resolveQuestion(projectId, parsed.question, parsed.answer);
          const remaining = result?.project?.context?.open_questions;
          return {
            content: [{
              type: 'text',
              text: formatQuestionResolution(shownQuestion, {
                reason: 'resolved',
                resolved: result?.resolved ? redactSecrets(String(result.resolved)) : shownQuestion,
                open_questions: Array.isArray(remaining) ? remaining : await stillOpen(),
              }),
            }],
          };
        } catch (error: any) {
          const status = error?.response?.status;
          const data = error?.response?.data;
          if (status === 409 && data?.error === 'question_ambiguous') {
            return {
              content: [{
                type: 'text',
                text: formatQuestionResolution(shownQuestion, {
                  reason: 'ambiguous',
                  candidates: Array.isArray(data.candidates) ? data.candidates : [],
                }),
              }],
            };
          }
          if (status === 404 && data?.error === 'question_not_found') {
            return {
              content: [{
                type: 'text',
                text: formatQuestionResolution(shownQuestion, {
                  reason: 'unmatched',
                  open_questions: await stillOpen(),
                }),
              }],
            };
          }
          throw error;
        }
      }

      case 'get_next_best_context': {
        const parsed = NextBestContextSchema.parse(args);
        const result = await client.getNextBestContext(parsed);
        const text = [
          result.summary,
          ...(result.suggestions || []).map((item: any) => `- ${item.label}: ${item.reason}`),
        ].filter(Boolean).join('\n');
        return { content: [{ type: 'text', text }] };
      }

      case 'build_subagent_brief': {
        // max_tokens is advertised as `number` on purpose — a property declared
        // `integer` was refused end to end on the hosted path, which is why this
        // whole catalog uses `number`. The schema below parses it as an int, so
        // 250.5 was refused for being exactly what the advertised type invited.
        // Round it here; the published type does not move, and a value outside
        // the advertised range is still refused by the schema.
        //
        // PARITY: apps/api/src/routes/mcp.js (hosted dispatcher) does the same.
        const requestedTokens = (args as any)?.max_tokens;
        const parsed = SubagentBriefSchema.parse(
          Number.isFinite(requestedTokens)
            ? { ...(args as any), max_tokens: Math.round(requestedTokens) }
            : args,
        );
        const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
        const result = await client.buildSubagentBrief({
          ...parsed,
          cwd,
          workspace_key: getWorkspaceKey(cwd) || undefined,
          tool: resolveLocalSurface(),
        });
        return {
          content: [{ type: 'text', text: result.text }],
          structuredContent: result,
        } as any;
      }

      case 'cleanup_context': {
        const parsed = CleanupContextSchema.parse(args);
        const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
        let projectId = parsed.project_id;
        let projectName = '';

        // This call is a read (the checklist) until the task is completed, and a
        // destructive write (it clears the command log and the open questions)
        // once it is. A name guess may be SHOWN the checklist; it may not be
        // cleared. `guessed` carries that distinction down to the write below.
        let guessed: Exclude<WriteTarget, { kind: 'target' }> | null = null;
        if (!projectId) {
          const target = await resolveWriteTarget(client, cwd, { nameTheGuess: true });
          if (target.kind === 'none') {
            return { content: [{ type: 'text', text: 'No active project found to clean up.' }] };
          }
          projectId = target.projectId;
          projectName = target.projectName || '';
          if (target.kind === 'guess') guessed = target;
        }

        const contextJson = await client.getContextJson(projectId);
        const context = contextJson?.context ? contextJson.context : contextJson;
        projectName = projectName || context?.project_name || projectId;

        const openQuestions = Array.isArray(context?.open_questions) ? context.open_questions : [];
        const commands = Array.isArray(context?.commands) ? context.commands : [];
        const currentTask = String(context?.current_task || '').trim();
        const blocker = String(context?.blocking_issue || '').trim();
        // ONLY an explicit, confirmed completion clears anything.
        //
        // This used to substring-match the brief's OWN status text through
        // isTaskCompleted (/(completed|done|shipped|closed)/), so "Shipped PR
        // 488; now verifying the deploy" meant "this task is over" and a bare
        // finish_task — no arguments at all — emptied the open questions, the
        // blocking issue and the command log. "abandoned" and "disclosed"
        // contain the same substrings. Worse, the confirmation gate below only
        // ran when complete_task was set, so the one destructive path nobody
        // asked for was also the one that skipped the gate. Words in a status
        // line are not consent.
        //
        // PARITY: apps/api/src/routes/mcp.js (hosted dispatcher) does the same.
        const clearing = parsed.complete_task === true && parsed.confirm_complete === true;
        // What a confirmed completion destroys, named the same way in the
        // wrap-up and in the receipt so a caller reads the same list before and
        // after.
        const clearable = describeTaskState({ questions: openQuestions.length, blocker: Boolean(blocker), commands: commands.length });
        // The call that a wrap-up tells the caller to make next. cleanup_context
        // is the dispatch target behind manage_memory(action:"finish_task") and
        // is not in tools/list, so naming it hands the caller "Unknown tool".
        const CONFIRMED_CALL = 'manage_memory with action "finish_task", complete_task=true and confirm_complete=true';

        if (clearing && guessed) {
          return {
            content: [{ type: 'text', text: describeWriteRefusal(guessed, 'finish a task in') }],
            isError: true,
          } as any;
        }

        if (parsed.complete_task && !parsed.confirm_complete) {
          return {
            content: [{ type: 'text', text: 'Finishing this task clears its command history, open questions, and blocking issue. Review the task state, then retry with confirm_complete=true.' }],
            isError: true,
          } as any;
        }

        if (clearing) {
          // WHAT THE REVIEW SHOWED, AND NOTHING ADDED SINCE. This cleared the
          // questions, blocker and command log as they stood at the
          // confirmation, so one added between the review and the confirmation
          // — by the person, or another tool — went without anybody seeing it.
          // The plan is made from the version this call read and the write is
          // refused (409) if the brief moved on meanwhile; then it is re-read
          // and re-planned, so an item that landed during the call stays too.
          // No review in this process keeps today's behaviour: everything there
          // is cleared. PARITY: the hosted finish_task (apps/api routes/mcp.js).
          const reviewed = taskReviews.get(projectId) ?? null;
          // NO REVIEW IN THIS PROCESS FOR THIS PROJECT: refused, nothing
          // cleared (the owner's decision; a restart forgets reviews, and that
          // is exactly when it applies). PARITY: the hosted finish_task.
          if (!reviewed) {
            return {
              content: [{ type: 'text', text: NO_REVIEW_ON_RECORD }],
              isError: true,
            } as any;
          }
          let freshContext: any = context;
          let plan = planReviewedCompletion(freshContext, reviewed);
          let patched: any;
          for (let attempt = 1; ; attempt += 1) {
            const version = Number.isInteger(freshContext?.context_version) ? freshContext.context_version : undefined;
            try {
              patched = await client.patchProjectContext(projectId, {
                current_status: currentTask ? `Completed: ${currentTask}` : 'Completed',
                task_progress: 'completed',
                ...plan.patch,
                // Opt-in: the parts of a completion this caller may not edit (a
                // teammate on a shared project: the owner's command log, questions,
                // blocker, the progress marker) are skipped and named in
                // `skipped_sections` instead of refusing the whole completion.
                // PARITY: the hosted finish_task passes skipUnwritableDerived.
                skip_unwritable_derived: true,
                ...(version !== undefined ? { expected_context_version: version } : {}),
              });
              break;
            } catch (error: any) {
              const stale = error?.response?.status === 409 && error?.response?.data?.error === 'stale_context_version';
              if (!stale || attempt >= 3) throw error;
              const reread = await client.getContextJson(projectId);
              freshContext = reread?.context ? reread.context : reread;
              plan = planReviewedCompletion(freshContext, reviewed);
            }
          }
          const skippedSections = new Set<string>(Array.isArray(patched?.skipped_sections) ? patched.skipped_sections : []);
          // Sections this caller cannot view were never in the patch: left as
          // they are and named by section. PARITY: the hosted finish_task.
          for (const section of plan.hidden || []) skippedSections.add(section);
          // WHAT THE SERVER WOULD NOT TAKE. The PATCH answers 200 and lists the
          // fields it declined in `refused`; this read none of it, so a declined
          // completion answered "Task remains recorded as completed" over a
          // brief still showing the task in progress. PARITY: the hosted
          // dispatcher (apps/api/src/routes/mcp.js, finish_task) reads the same
          // two fields and says the same sentence.
          const refused: Array<{ field: string; reason?: string }> = (Array.isArray(patched?.refused) ? patched.refused : [])
            .filter((item: any) => item?.field === 'current_status' || item?.field === 'task_progress');
          // What was added after the review and therefore left, named. The reply
          // SHOWS it, so it becomes what this session has reviewed: a second
          // confirmation clears it. With nothing left to name, the review is
          // used up. PARITY: the hosted finish_task, same rule and words.
          // Only what this caller can view and the write could have cleared.
          const stayedNote = formatLeftAfterReview(stayedOutside(plan.stayed, skippedSections));
          if (stayedNote) taskReviews.set(projectId, taskReviewItems({ ...freshContext, ...plan.patch }));
          else taskReviews.delete(projectId);
          if (refused.length) {
            const liveStatus = patched?.project?.context?.current_status ?? patched?.context?.current_status;
            const clearedAll = describeTaskState(plan.cleared);
            return {
              content: [{
                type: 'text',
                text: [
                  `Cleanup complete for ${projectName}.`,
                  `Task NOT recorded as completed for ${projectName}: the server declined ${refused.map((item) => item.field).join(' and ')} because ${refused[0].reason || 'it was refused'}. The brief still reads "${liveStatus || '(no status)'}".`,
                  clearedAll.length ? `Cleared: ${clearedAll.join(', ')}.` : (stayedNote ? '' : 'There was no open task state to clear.'),
                  stayedNote,
                ].filter(Boolean).join('\n'),
              }],
            };
          }
          // Only when there IS a task. With none set this posted a shipped item
          // "Task completed in <project>" at confidence 1, which the next
          // catch-up reported as finished work nobody did. The status and the
          // clearing above still run, as they always have. PARITY: the hosted
          // dispatcher (apps/api/src/routes/mcp.js) skips it the same way and
          // says the same sentence.
          if (currentTask) {
            const event = await client.recordContextEvent({
              event_type: 'task_completed',
              project_id: projectId,
              summary: currentTask,
              metadata: {
                source: 'cleanup_context',
                cleared_commands: plan.cleared.commands,
                cleared_questions: plan.cleared.questions,
                surface: 'claude_code',
              },
            }).catch(() => null);
            for (const section of (Array.isArray(event?.skipped_sections) ? event.skipped_sections : [])) skippedSections.add(section);
          }
          // What the completion did NOT clear because this caller may not edit
          // it, said plainly. PARITY: the hosted finish_task, same words.
          const SECTION_LABELS: Record<string, string> = {
            task_progress: 'task progress',
            commands: 'command log',
            open_questions: 'open questions',
            blocking_issue: 'blocker',
            shipped: 'shipped list',
            next_action: 'next action',
          };
          const leftNote = skippedSections.size
            ? `Left as they were (not shared for editing with you): ${orderLeftSections(skippedSections).map((key) => SECTION_LABELS[key] || key.replace(/_/g, ' ')).join(', ')}.`
            : '';
          const clearedNow = describeTaskState({
            questions: skippedSections.has('open_questions') ? 0 : plan.cleared.questions,
            blocker: plan.cleared.blocker && !skippedSections.has('blocking_issue'),
            commands: skippedSections.has('commands') ? 0 : plan.cleared.commands,
          });
          return {
            content: [{
              type: 'text',
              text: [
                `Cleanup complete for ${projectName}.`,
                currentTask ? `Task remains recorded as completed: "${currentTask}".` : NO_TASK_TO_COMPLETE,
                // The old receipt mentioned the command log and nothing else, so
                // cleared questions and a cleared blocker went quietly. Name
                // everything that went — and, for a teammate, what did not.
                clearedNow.length ? `Cleared: ${clearedNow.join(', ')}.` : (skippedSections.size || stayedNote ? '' : 'There was no open task state to clear.'),
                leftNote,
                stayedNote,
              ].filter(Boolean).join('\n'),
            }],
          };
        }

        const checklist: string[] = [];
        if (parsed.ask_questions && openQuestions.length) {
          checklist.push('Open questions to answer before closing this task:');
          for (const question of openQuestions.slice(0, 12)) {
            checklist.push(`- ${question}`);
          }
        }
        if (blocker) {
          checklist.push(`Blocking issue still recorded: ${blocker}`);
        }
        if (commands.length) {
          checklist.push(`Command log entries currently attached to this open task: ${commands.length}.`);
        }
        // Nothing was written, so say so first: the old text said only "no
        // unresolved questions detected", which reads as a report on a call that
        // had already cleared the board.
        checklist.push(clearable.length
          ? `Nothing was cleared. Completing this task would clear ${clearable.join(', ')}. If it is done, call ${CONFIRMED_CALL}.`
          : `Nothing was cleared, and there is no open task state to clear. If this task is done, call ${CONFIRMED_CALL}.`);
        // What this review showed is what its confirmation may clear.
        taskReviews.set(projectId, taskReviewItems(context));

        return {
          content: [{
            type: 'text',
            text: [
              `Task in progress for ${projectName}: "${currentTask || 'Unnamed task'}".`,
              ...checklist,
            ].join('\n'),
          }],
        };
      }

      case 'list_context_map': {
        const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
        const result = await client.getContextMap(true, cwd);
        return {
          content: [{ type: 'text', text: result.map || 'No projects yet.' }],
        };
      }

      // update_brief is the product-voice alias of update_context — identical write path.
      case 'update_context':
      case 'update_brief': {
        const normalizedArgs = normalizeUpdateContextArgs(args);
        if (!normalizedArgs) {
          return {
            content: [{
              type: 'text',
              // Named for the advertised route. update_context dispatches but is
              // not in tools/list, so a caller told to call it by name gets
              // "Unknown tool" — the exact shape of the first-run setup copy
              // that is this repo's best explanation for the activation gap.
              text: 'Saving a brief needs a non-empty summary, or a task to set. Examples: manage_memory({ action: "update", summary: "Shipped auth fix and updated test gates." }), or manage_memory({ action: "update", task: "Fix the Done-column cap" }) to change the brief\'s headline.',
            }],
          };
        }
        const { project_id, task, tool, commands } = normalizedArgs;
        // Refused BEFORE any write, like the hosted catalog's FIELD_LIMITS.run
        // (apps/api/src/services/mcpSafety.js) refuses it at validation. Checked
        // here rather than as a schema maxLength so the advertised local schema
        // is unchanged. Past the API's own cap the commands PATCH was refused
        // whole while the reply said they were stored.
        const oversizedCommand = (commands || []).find((entry) => entry.run.length > COMMAND_RUN_MAX_CHARS);
        if (oversizedCommand) {
          return {
            content: [{
              type: 'text',
              text: `Nothing was saved: command "${oversizedCommand.label.slice(0, 100)}" has a run of ${oversizedCommand.run.length} characters, and the limit is ${COMMAND_RUN_MAX_CHARS}. Shorten it — or store the path of a script that holds it — and resend.`,
            }],
            isError: true,
          } as any;
        }
        // Masked HERE, before it leaves the machine, not only by the server at
        // persist: a key pasted into a summary used to travel to the API in
        // clear and be redacted on arrival. The same redactor the Stop hook
        // uses. Everything below — the fallback event, the reply — sees the
        // masked text, so the key is not echoed back either.
        const summary = normalizedArgs.summary ? redactSecrets(normalizedArgs.summary) : normalizedArgs.summary;
        const summaryMaskedLocally = summary !== normalizedArgs.summary;
        let resolvedProjectId = project_id;
        if (!resolvedProjectId) {
          const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
          // A write target, never a name guess: this is the write the product
          // exists for, and it used to follow active.project_id wherever a
          // substring of the folder name led. See write-target.ts.
          const target = await resolveWriteTarget(client, cwd, { tool, nameTheGuess: true });
          if (target.kind === 'guess') {
            return {
              content: [{ type: 'text', text: describeWriteRefusal(target, 'save to') }],
              isError: true,
            } as any;
          }
          if (target.kind === 'target') resolvedProjectId = target.projectId;
        }
        if (!resolvedProjectId) {
          // Nothing was saved, so this is an error, not an answer. It returned
          // isError:false, and an agent reading a non-error reply to "save this"
          // reasonably moves on as if it landed — the ordinary way to reach it is
          // a repo whose only project was auto-archived after 30 idle days.
          return {
            content: [{
              type: 'text',
              // NO_PROJECT_NEXT_STEP, not "call start_session": on an account
              // with no project yet start_session creates nothing, so that hint
              // sent the caller round in a circle (see write-target.ts).
              text: `No active project for this directory to save to. ${NO_PROJECT_NEXT_STEP}`,
            }],
            isError: true,
          } as any;
        }
        // A task-only call has nothing for extraction to do.
        const result = summary
          ? await client.pushContextUpdate(resolvedProjectId, summary, tool, commands, { explicit: true })
          : null;

        // The task is written DIRECTLY, because extraction has never been able to
        // set this field — and LAST, AFTER extraction, because the server's merge
        // is `{ ...current, ...delta }`: a delta that happens to carry
        // current_task would silently overwrite an explicitly requested one. An
        // explicit instruction must beat an inferred one, and verifying before
        // extraction ran would confirm a value extraction then replaced.
        let taskWritten: string | null = null;
        // Set when the task landed in the form storage redaction gave it — a key
        // in it masked — rather than word for word. Holds the STORED value, so
        // the reply never quotes the secret the brief does not hold.
        let taskRedacted: string | null = null;
        let taskError: string | null = null;
        // A task-only call has no extraction result to take the project name
        // from, so the read-back below is the only place it comes from.
        let taskProjectName = '';
        if (task) {
          try {
            const patched = await client.patchProjectContext(resolvedProjectId, { current_task: task });
            // What the server says it STORED. It redacts on the way to the row,
            // so a task naming a key lands masked, and an API that knows this
            // says `redacted: true` and returns the stored value. An older API
            // sends neither — see taskLandedRedacted for that case.
            const serverRedacted = patched?.redacted === true;
            const storedTask = serverRedacted
              ? String(patched?.project?.context?.current_task ?? '').trim()
              : '';
            // Read back: a PATCH that 200s having changed nothing is precisely the
            // failure this whole change exists to stop being invisible.
            const after = await client.getContextJson(resolvedProjectId).catch(() => null);
            taskProjectName = after?.project_name ?? '';
            if (!after) {
              // Could not read back. The PATCH itself did not throw, so treat it
              // as written rather than inventing a failure — same best-effort
              // policy as the other read-backs here.
              if (serverRedacted && storedTask && storedTask !== task) taskRedacted = storedTask;
              else taskWritten = task;
            } else {
              // Compare even when the live value is EMPTY. Gating on truthiness
              // meant a dropped PATCH on a project whose task was already ''
              // reported success for a field that is still blank.
              const live = String(after.current_task ?? after.task ?? '').trim();
              if (live === task) {
                taskWritten = task;
              } else if (live && (serverRedacted ? live === storedTask : taskLandedRedacted(task, live))) {
                // Written — as stored, not as sent. Comparing with the literal
                // task called this "NOT changed", which invites the model to
                // retry a write that already landed, forever.
                taskRedacted = live;
              } else {
                taskError = `the brief still reads "${live || '(empty)'}"`;
              }
            }
          } catch (err: any) {
            // An archived project refuses the PATCH with the restore call in its
            // message. axios's own message for it is "Request failed with status
            // code 409", which is what this line used to report.
            // The same for every refusal whose message IS the fix — a task over
            // the API's 4,000-character cap (field_too_long) read "Request
            // failed with status code 400", naming neither the limit nor the field.
            const relayed = isActionableErrorCode(String(err?.response?.data?.error ?? '')) && typeof err.response.data.message === 'string'
              ? String(err.response.data.message)
              : null;
            taskError = relayed || (err?.message ? String(err.message) : 'the write failed');
          }
        }
        // TWO writes happen here, and the report must account for both.
        // pushContextUpdate runs extraction, which can legitimately return an
        // empty delta. This event records the summary itself as a decision and
        // usually succeeds anyway — so judging the outcome on the delta alone
        // reports "nothing was added" while the brief just grew by one decision.
        // Its result was previously discarded by a bare .catch(() => null).
        //
        // ONE of them now, when the API can do it. An API that understands
        // `explicit: true` stores the summary verbatim itself, exactly once, and
        // says so in `stored` — sending this event as well wrote the caller's
        // sentence a SECOND time beside the model's paraphrase of it. The event
        // stays as the floor for an API that predates the flag (it answers with
        // no `stored` at all), so a newer client never loses the sentence to an
        // older server.
        const serverStoresVerbatim = typeof result?.stored === 'boolean';
        const summaryRecorded = !summary
          ? false
          : serverStoresVerbatim
            ? result.stored === true
            : await client.recordContextEvent({
              event_type: 'decision_made',
              project_id: resolvedProjectId,
              summary,
              metadata: { commands, surface: tool },
            }).then(() => true).catch(() => false);
        const projectName = result?.project?.project_name || taskProjectName || '';
        // Masked as a whole: the delta is the MODEL's rewrite of the summary,
        // and an API that predates relaying it as stored handed back a goal
        // carrying the key the summary was masked for.
        const deltaBody = summary
          ? redactSecrets(formatDelta(projectName, result, { summaryRecorded, summary }))
          : `Updated ${projectName ? `"${projectName}"` : 'the brief'}:`;
        const taskLines: string[] = [];
        // Stored is not the same as stored verbatim: a summary naming a key, or
        // carrying an override phrase, is rewritten on its way to the row. The
        // server says when that happened; saying nothing here leaves the caller
        // to discover [REDACTED] in a brief weeks later.
        // PARITY: apps/api/src/routes/mcp.js says the same in its own reply.
        if (summaryRecorded && (result?.redacted || summaryMaskedLocally)) {
          taskLines.push('  • Sensitive text in your summary was redacted before it was stored.');
        }
        if (taskWritten) taskLines.push(`  • Current task → "${taskWritten}"`);
        if (taskRedacted) taskLines.push(`  • Current task written, with sensitive text redacted → "${taskRedacted}"`);
        if (taskError) taskLines.push(`  ⚠ Current task NOT changed — ${taskError}. Nothing else in this call was affected.`);
        const delta = taskLines.length ? `${deltaBody}\n${taskLines.join('\n')}` : deltaBody;
        // Something reached the brief if ANY write landed.
        const wrote = deltaHasChanges(result) || summaryRecorded || Boolean(taskWritten) || Boolean(taskRedacted);
        // From the OUTCOME of the commands write, never from the request.
        let cmdNote = '';
        if (commands?.length) {
          const outcome = result?.commands_outcome;
          const n = `${commands.length} command${commands.length > 1 ? 's' : ''}`;
          if (outcome?.stored === true) cmdNote = ` + ${n} stored`;
          else if (outcome) cmdNote = `\n  ⚠ ${n} NOT stored — ${outcome.error || 'the write failed'}. Nothing else in this call was affected.`;
          else cmdNote = `\n  ⚠ ${n} NOT stored — commands are saved alongside a summary. Resend them with a summary.`;
        }
        return {
          content: [{ type: 'text', text: wrote ? `${delta}${cmdNote}\nSaved — all connected tools will see this on their next session start.` : `${delta}${cmdNote}` }],
        };
      }

      case 'list_projects': {
        ListProjectsSchema.parse(args);
        // Live AND archived, rendered by shared-context's formatProjectListing
        // so this answer is the hosted connector's, word for word.
        // start_session sends somebody whose projects were archived here "for
        // the IDs"; this used to answer "[DeerDawn — 0 projects]" (the map
        // fallback below), and an assistant that believed it created an empty
        // project beside the archived one.
        const [treeRoots, archived] = await Promise.all([
          client.listContextProjectTree().then((r: any) => (r?.projects ?? []) as any[], () => null),
          listArchivedForListing(client, { strict: true }),
        ]);
        // Nested tree first — shows subprojects under their umbrella. When the
        // API answered it, its answer stands, empty included: the map below
        // only knows live projects.
        if (treeRoots) return { content: [{ type: 'text', text: formatProjectListing(treeRoots, archived).text }] };
        // Fallbacks for an API without /projects/tree: rich compact map, then a
        // plain flat list.
        try {
          const mapResult = await client.getContextMap();
          // Without its "→ Call get_context" hints: get_context is not in tools/list.
          const mapText = mapResult.map ? stripMapCallHints(String(mapResult.map)) : '';
          if (mapText.trim()) return { content: [{ type: 'text', text: mapText }] };
        } catch { /* fall through to simple list */ }
        const result = await client.listContextProjects();
        const projects = result?.projects ?? [];
        if (projects.length === 0) {
          return { content: [{ type: 'text', text: formatProjectListing([], archived).text }] };
        }
        const lines = projects.map((p: any) =>
          `• ${p.project_name} (${p.project_id}) — updated ${p.updated_at}`
        );
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'create_project': {
        const { project_name, description, parent_project_id } = CreateProjectSchema.parse(args);
        // PARITY with the hosted create_project dispatch, which books session one
        // at create: same rule, flagged so a website-made brief never counts.
        const result = await client.createContextProject(project_name, description, parent_project_id, {
          // Only a POSITIVELY identified tool: resolveLocalSurface() defaults an
          // unplaced client to claude_code, and the next catch-up would then say
          // "last session … in Claude Code" for a Windsurf session.
          mcpSession: { tool: resolveIdentifiedSurface() },
        });
        // "Create a project, then save to it" is the first thing a new user does,
        // and the second call carries no project_id. Until that save links the
        // directory, the only thing /active can say about a project named after
        // its folder is `name` — a guess, which writes refuse. This process was
        // just asked to create it from here, which is not a guess; a linked path
        // or a pin still outranks it. See write-target.ts.
        rememberWriteTarget(process.env.CLAUDE_PROJECT_DIR || process.cwd(), result?.project?.project_id, result?.project?.project_name);
        const nested = result.project.parent_project_id ? ' (subproject)' : '';
        // WHERE IT IS AND WHO READS IT, in a workspace with more than one
        // member: the server's own words (placement_note, absent in a
        // one-person workspace and from an API that predates it). A project an
        // AI tool creates there starts personal, and this is where its author
        // is told so and how to share it (journey r4). PARITY: the hosted
        // manage_projects create appends the same sentence.
        const placement = typeof result?.placement_note === 'string' && result.placement_note.trim()
          ? ` ${result.placement_note.trim()}`
          : '';
        return {
          content: [{
            type: 'text',
            text: `Created project "${result.project.project_name}"${nested} with ID: ${result.project.project_id}${placement ? `.${placement}` : ''}`,
          }],
        };
      }

      case 'switch_subproject': {
        const { project_id } = SwitchSubprojectSchema.parse(args);
        const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
        const workspaceKey = getWorkspaceKey(cwd);
        if (!workspaceKey) {
          return { content: [{ type: 'text', text: 'Could not identify this codebase (no git repo found), so there is nothing to pin the subproject to. Run this from inside the project’s git repository.' }] };
        }
        const result = await client.switchSubproject(project_id, workspaceKey);
        // The pin answers for this from now on (`pinned`); remembered as well so
        // the very next write does not depend on it having been read back.
        rememberWriteTarget(cwd, result?.project_id ?? project_id, result?.project_name);
        return {
          content: [{
            type: 'text',
            text: `Switched active subproject to "${result.project_name}" for this workspace. New sessions here will brief it by default.`,
          }],
        };
      }

      case 'archive_project': {
        const { project_id, unarchive } = ArchiveProjectSchema.parse(args);
        const result = await client.archiveProject(project_id, unarchive === true);
        return {
          content: [{
            type: 'text',
            text: unarchive
              ? `Restored "${result.project_name}" from the archive.`
              : formatProjectArchivedReply({ project_id: result?.project_id ?? project_id, project_name: result?.project_name }),
          }],
        };
      }

      case 'set_project_parent': {
        const { project_id, parent_project_id } = SetProjectParentSchema.parse(args);
        const parentId = parent_project_id ?? null;
        const result = await client.setProjectParent(project_id, parentId);
        return {
          content: [{
            type: 'text',
            text: parentId
              ? `Nested "${result.project_name}" as a subproject of ${parentId}.`
              : `Promoted "${result.project_name}" to a top-level project.`,
          }],
        };
      }

      case 'rename_project': {
        const { project_id, project_name } = RenameProjectSchema.parse(args);
        const result = await client.renameProject(project_id, project_name);
        return {
          content: [{
            type: 'text',
            text: `Renamed to "${result.project_name}".`,
          }],
        };
      }

      case 'import_local_context': {
        const outcome = await importLocalContextFile(client, {
          path: typeof args?.path === 'string' ? args.path : undefined,
          confirmed: coerceConfirmedFlag(args?.confirmed),
          // Unattended imports (start_session's first-run seed, connect-time
          // startup) are held to stricter rules than one a person confirmed.
          // See importLocalContextFile — `auto` only ever narrows what is written.
          auto: coerceConfirmedFlag(args?.auto),
        });
        // A confirmed import is the user filing THIS directory's context under
        // that project, so the save that follows goes there (write-target.ts).
        if (outcome.kind === 'imported' || outcome.kind === 'kept') {
          rememberWriteTarget(process.env.CLAUDE_PROJECT_DIR || process.cwd(), outcome.project_id, outcome.project_name);
        }
        return { content: [{ type: 'text', text: outcome.text }] };
      }

      case 'manage_todos': {
        const action = String(args?.action || 'list');
        const projectId = args?.project_id || undefined;
        const todos: string[] = Array.isArray(args?.todos) ? args.todos.filter(Boolean) : [];
        // `cards` is the richer form of the same request: {title, body, phase}
        // per card. `todos: string[]` is untouched and still means bare titles —
        // it is the published contract, written into CLAUDE.md files on disk.
        const rawCards: any[] = Array.isArray(args?.cards) ? args.cards : [];
        const rawPhase = args?.phase ? String(args.phase).trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
        // An unrecognised phase became '' and then took two different silent
        // routes: on `add` the card landed in Backlog and the reply never
        // mentioned that the requested column had been dropped, and on `move` the
        // caller was told "phase is required" for a phase it had just supplied.
        // Neither answer contains the one fact that fixes the call.
        if (rawPhase && !(BOARD_PHASES as string[]).includes(rawPhase)) {
          throw new ToolInputError(`Unknown phase ${JSON.stringify(args.phase)}. Valid phases: ${BOARD_PHASES.join(', ')}.`);
        }
        const phase = rawPhase;

        // No project_id means the project for THIS cwd, as every other local
        // write resolves it. This call used to send no cwd, so /active answered
        // with the account's most recently touched project — a card added from
        // one repo landed on another repo's board.
        //
        // Reading the board may follow a guess; CHANGING it may not. The
        // format=json answer carries no match_kind to judge, so a write with no
        // project_id resolves its target first (see write-target.ts) and then
        // loads that board by id.
        const taskCwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
        let writeTargetId: string | undefined;
        if (!projectId && action !== 'list') {
          const target = await resolveWriteTarget(client, taskCwd, { nameTheGuess: true });
          if (target.kind !== 'target') throw new ToolInputError(describeWriteRefusal(target, 'change the task board of'));
          writeTargetId = target.projectId;
        }
        const ctx = projectId || writeTargetId
          ? await client.getContextJson(projectId || writeTargetId)
          : await client.getContextJson(undefined, { cwd: taskCwd, workspaceKey: getWorkspaceKey(taskCwd) });
        const resolvedProjectId = ctx?.project_id || projectId || writeTargetId;
        // A write with no project would go out with project_id undefined and
        // land wherever the server's fallback puts it — the silent wrong-board
        // write this resolution exists to stop. Reading an empty board is fine.
        if (!resolvedProjectId && action !== 'list') {
          throw new ToolInputError(`No active project for this directory. ${NO_PROJECT_NEXT_STEP}`);
        }
        const projectName = ctx?.project_name || 'project';
        // Staleness rides on a response we already made: getContextJson loads the
        // project, so its updated_at is a watermark that cost nothing to obtain.
        // If checking this ever needs its own request, the banner belongs on a
        // different call — never on a new round-trip.
        const staleness = checkStale(resolvedProjectId, ctx?.updated_at);
        const staleLine = staleness
          ? `[DeerDawn] This project changed ${Math.max(1, Math.round(staleness.staleMs / 60000))} min after your brief was loaded — another session may have moved work. Re-read context before relying on the brief.`
          : null;

        // ctx is the FLAT context object (see client.getContextJson) — todo_items
        // and completed_todos hang off it directly, NOT off a nested .context.
        const board = buildTaskBoard(ctx || {});

        // Report what the write DID, not what it was asked to do.
        //
        // Both writes into Done used to declare success straight from `matched`,
        // without ever reading the board back. That is how a real completion was
        // lost in silence on 2026-08-29: the Done-cap trim discarded the incoming
        // card, and this tool still answered "Marked complete (→ Done)". The
        // underlying trim is fixed (shared-context ranks Done by completed_at
        // now), so this should never fire — which is exactly why it is worth
        // keeping. A cap regression stays loud instead of eating a card.
        //
        // The board merge runs synchronously inside the event request, so once the
        // recordContextEvent calls have resolved the result is readable.
        // Takes RESOLVED cards and checks by id, so the read-back asks about the
        // exact card that was written — never a title that might match another.
        const cardsThatNeverReachedDone = async (cards: any[]): Promise<string[]> => {
          if (!cards.length) return [];
          try {
            const after = await client.getContextJson(resolvedProjectId);
            const doneAfter = buildTaskBoard(after || {})
              .find((c: any) => c.phase === 'done')?.cards || [];
            const doneIds = new Set(doneAfter.map((c: any) => c?.id));
            return cards.filter((card) => !doneIds.has(card.id)).map((card) => String(card.title));
          } catch {
            // Verification is best-effort. A failed read-back must never turn a
            // completion that actually landed into a reported failure.
            return [];
          }
        };
        const doneWriteLostWarning = (cards: string[]) =>
          `⚠ NOT recorded: ${cards.map((t) => `"${t}"`).join(', ')} left the board without arriving in Done — ` +
          `this write dropped ${cards.length > 1 ? 'them' : 'it'}. Re-add with action:"add" (adds are not affected) ` +
          `and do not retry complete until the board trim in packages/shared-context/src/index.js is checked.`;

        // The Done column keeps the most recently completed cards, so a
        // completion at the cap pushes the oldest one off the board. The API's
        // POST /events reply names what it evicted (`evicted_cards`, #525); the
        // hosted dispatcher has said so since, and this path answered "Marked
        // complete" over the silent loss. Same wording as describeEvictedCards
        // in apps/api/src/routes/mcp.js.
        const collectEvictedCards = (into: Array<{ id?: string; title: string }>, eventResult: any) => {
          const cards = Array.isArray(eventResult?.evicted_cards) ? eventResult.evicted_cards : [];
          for (const card of cards) {
            if (card?.title && !into.some((seen) => (seen.id && seen.id === card.id) || seen.title === card.title)) {
              into.push({ id: card.id, title: String(card.title) });
            }
          }
        };
        const describeEvictedCards = (cards: Array<{ title: string }>) => {
          const shown = cards.slice(0, 5).map((card) => `"${card.title}"`).join(', ');
          const more = cards.length > 5 ? ` and ${cards.length - 5} more` : '';
          return `The board is at its limit, so ${cards.length === 1 ? 'this older card was' : 'these older cards were'} removed to make room: ${shown}${more}.`;
        };

        if (action === 'list') {
          // Named cards are OPENED — title, column and body. An unfiltered list
          // is the board, which shows a marker instead of any body: listing the
          // live board already strains the response limit on titles alone.
          if (todos.length) {
            return {
              content: [{ type: 'text', text: [staleLine, formatTaskCardDetail(ctx || {}, todos)].filter(Boolean).join('\n\n') }],
              structuredContent: { action: 'list', project_id: resolvedProjectId, project_name: projectName, opened: todos },
            } as any;
          }
          const snapshot = buildTaskBoardSnapshot(ctx || {}, { project_id: resolvedProjectId, project_name: projectName });
          // PARITY with renderTaskBoard in apps/api/src/routes/mcp.js: render from
          // the BOUNDED listing so the text and structured halves describe the same
          // view, and print col.total (storage) rather than the number of rows shown.
          // A model can pass "30" as a string; coerce rather than silently
          // ignoring it and handing back the default, which would look like the
          // parameter did nothing. shared-context clamps whatever survives.
          const rawPerPhase = (args as any)?.cards_per_phase;
          const perPhase = typeof rawPerPhase === 'string' ? Number(rawPerPhase.trim()) : rawPerPhase;
          const listing = taskBoardSnapshotForListing(
            snapshot,
            Number.isFinite(perPhase) ? { cards_per_phase: perPhase } : {},
          );
          const columns = listing.board;
          const total = snapshot.total_cards;
          const lines: string[] = [`Task board for ${projectName}:`];
          let withBody = 0;
          if (!total) {
            lines.push('  (empty — add a card with action:"add")');
          } else {
            for (const col of columns) {
              lines.push(`  ${col.label} (${col.total}):`);
              if (!col.cards.length) { lines.push('    —'); continue; }
              for (const t of col.cards) {
                const when = col.phase === 'done' && t.completed_at ? ` (${String(t.completed_at).slice(0, 10)})` : '';
                // Who is on this card. Rendered only when another agent holds it —
                // your own holds are unremarkable, and an unheld board should look
                // exactly as it always has.
                const hold = holdState(t);
                const heldBy = hold.held && hold.holder !== getAgentSessionId()
                  ? ` ← held by ${hold.holder}`
                  : '';
                if (t.has_body) withBody += 1;
                lines.push(`    - ${t.title}${when} [${t.id}]${t.has_body ? TASK_BODY_MARKER : ''}${heldBy}`);
              }
              // Name the elision in the column it happened to.
              if (col.has_more) {
                lines.push(`    …+${col.total - col.returned} more not shown — open by id with todos:["<card id>"].`);
              }
            }
          }
          if (withBody) {
            lines.push(`  ${withBody} card${withBody > 1 ? 's carry' : ' carries'} detail — open with action:"list" and todos:["<card id>"].`);
          }
          return {
            content: [{ type: 'text', text: [staleLine, lines.join('\n')].filter(Boolean).join('\n\n') }],
            // Bodies are stripped and columns bounded in the structured half too:
            // shipping them there would blow the same budget, just where nobody
            // looks. Reuses the SAME listing the text was rendered from, so the two
            // halves can never disagree about what was returned.
            structuredContent: { action: 'list', ...listing },
          } as any;
        }

        if (action === 'add') {
          const cards = normalizeTaskCardInputs([...todos, ...rawCards], phase);
          if (!cards.length) throw new ToolInputError('todos or cards is required for the add action — card titles to create, or cards with a title and body.');
          const titles = cards.map((card: any) => card.title);
          // Built from a BEFORE/AFTER difference of the board, never from the
          // request. Re-adding a title already on the board is a no-op in the
          // shared-context merge — with one exception, an entry carrying a body,
          // which sets that card's body and changes nothing else — so a reply
          // read off the request answered `Added to in progress: "X"` for a card
          // sitting untouched in Done. Only the board can say what happened.
          //
          // `ctx` was already loaded above, so BEFORE costs no round-trip; only
          // the read-back is new.
          const beforeCards = indexTaskCardsByTitle(ctx);
          // The event's result was dropped, so a card the write pushed off the
          // board went unreported — move and complete already named theirs. An
          // add no longer evicts OPEN work (the API refuses the whole add, with a
          // message, when open cards would pass the limit), but an add straight
          // into Done can still push the oldest completion off a full Done column.
          // PARITY: the add handler in apps/api/src/routes/mcp.js.
          const evictedOnAdd: Array<{ id?: string; title: string }> = [];
          collectEvictedCards(evictedOnAdd, await client.recordContextEvent({
            event_type: 'todo_added',
            project_id: resolvedProjectId,
            summary: `Added ${cards.length} card${cards.length > 1 ? 's' : ''}: ${titles.join(', ')}`,
            metadata: { todos: cards, phase: phase || undefined, surface: 'claude_code', session_id: getAgentSessionId() },
          }));
          let afterCards = beforeCards;
          let readBack = true;
          try {
            afterCards = indexTaskCardsByTitle(await client.getContextJson(resolvedProjectId));
          } catch {
            // Verification is best-effort, the same rule the Done read-back
            // follows: a failed read must never turn a write that landed into a
            // reported failure. Fall back to reporting the request, and say so.
            readBack = false;
          }

          const created: Array<{ card: any; phase: string }> = [];
          const bodyUpdated: Array<{ card: any; phase: string }> = [];
          const alreadyThere: Array<{ card: any; phase: string }> = [];
          const absent: any[] = [];
          // Two titles that differ only in a masked secret are ONE title once
          // stored, so the second merged into the first. Said, not counted as a
          // second card added.
          const collapsed: Array<{ card: any; into: any }> = [];
          const firstByKey = new Map<string, any>();
          for (const raw of cards as any[]) {
            // Every title and body is reported as STORED — masked — so the reply
            // matches the board and never repeats a key the board does not hold.
            const card = { ...raw, title: redactSecretText(String(raw.title)), body: raw.body ? redactSecretText(String(raw.body)) : raw.body };
            const key = storedTitleKey(raw.title);
            const earlier = firstByKey.get(key);
            if (earlier) { collapsed.push({ card, into: earlier }); continue; }
            firstByKey.set(key, card);
            const was = beforeCards.get(key);
            const now = afterCards.get(key);
            if (!readBack) created.push({ card, phase: card.phase || phase || 'backlog' });
            else if (!now) absent.push(card);
            else if (!was) created.push({ card, phase: now.phase });
            else if (card.body && now.body === card.body && was.body !== card.body) bodyUpdated.push({ card, phase: now.phase });
            else alreadyThere.push({ card, phase: now.phase });
          }

          // A body over the cap is clipped rather than refused, so the reply says
          // so — a silently shortened spec is the same failure as a silently
          // dropped card, one layer down.
          const clipped = rawCards.filter((card) => taskCardBodyWasClipped(card?.body)).length;
          const text: string[] = [];
          if (created.length) {
            text.push(`Added to ${projectName}: ${created.map((e) => `"${e.card.title}"${e.card.body ? TASK_BODY_MARKER : ''} → ${phaseLabel(e.phase)}`).join(', ')}`);
          }
          // The fallback above says "report the request, and say so", and the
          // second half was missing: a read-back that failed produced a reply
          // indistinguishable from a verified one, complete with the column the
          // card supposedly landed in. The write may well have landed — that is
          // why it is still reported — but the phase in that line is the phase
          // ASKED FOR, and re-adding an existing title is a no-op, so this is
          // exactly the sentence that must not be stated as observed fact.
          if (!readBack) {
            text.push('The add was sent but could not be verified: reading the board back failed, so this reports what was requested. Call manage_tasks with action:"list" to confirm.');
          }
          if (bodyUpdated.length) {
            text.push(`Updated the body of: ${bodyUpdated.map((e) => `"${e.card.title}" (${phaseLabel(e.phase)} in ${projectName})`).join(', ')}`);
          }
          for (const entry of alreadyThere) {
            text.push(`"${entry.card.title}" already exists in ${phaseLabel(entry.phase)} in ${projectName}; nothing was added. Move it with action:"move", or re-add it with a body to fill in its detail.`);
          }
          if (absent.length) {
            text.push(`Not on the board after the write: ${absent.map((card) => `"${card.title}"`).join(', ')}. The board may be at its card limit.`);
          }
          if (collapsed.length) {
            text.push(`Stored as one card: ${collapsed.map((e) => `"${e.card.title}" is the same card as "${e.into.title}" once the secret in it is masked`).join('; ')}. Nothing separate was added for ${collapsed.length === 1 ? 'it' : 'them'}.`);
          }
          if (clipped) text.push(`${clipped} body clipped to ${MAX_TODO_BODY_CHARS} characters.`);
          if (evictedOnAdd.length) text.push(describeEvictedCards(evictedOnAdd));
          return { content: [{ type: 'text', text: text.join('\n') || `Nothing changed on the board for ${projectName}.` }] };
        }

        if (action === 'move') {
          if (!todos.length) throw new ToolInputError('todos is required for the move action — an array of card ids or title substrings to move.');
          if (!phase) throw new ToolInputError('phase is required for the move action — one of: ' + BOARD_PHASES.join(', '));
          const todoItems = ctx?.todo_items || [];
          const { matched, ambiguous, unmatched } = resolveTodoQueries(todoItems, todos);
          const evictedOnMove: Array<{ id?: string; title: string }> = [];
          for (const { card } of matched) {
            collectEvictedCards(evictedOnMove, await client.recordContextEvent({
              event_type: 'todo_moved',
              project_id: resolvedProjectId,
              summary: `Moved to ${phase.replace(/_/g, ' ')}: ${card.title}`,
              metadata: { todo: card.id, phase, surface: 'claude_code', session_id: getAgentSessionId() },
            }));
          }
          // Moving INTO Done is the same write as `complete` and carries the same
          // historical risk, so it gets the same read-back. Every other column is
          // uncapped and needs none.
          const matchedCards = matched.map((r) => r.card);
          const lostOnMove = phase === 'done' ? await cardsThatNeverReachedDone(matchedCards) : [];
          const landedOnMove = matchedCards.map((c) => String(c.title)).filter((t) => !lostOnMove.includes(t));
          const lines: string[] = [];
          if (landedOnMove.length) lines.push(`Moved to ${phase.replace(/_/g, ' ')} in ${projectName}: ${landedOnMove.map(t => `"${t}"`).join(', ')}`);
          if (lostOnMove.length) lines.push(doneWriteLostWarning(lostOnMove));
          if (evictedOnMove.length) lines.push(describeEvictedCards(evictedOnMove));
          if (ambiguous.length) lines.push(formatAmbiguousTodos(ambiguous, 'moved'));
          if (unmatched.length) lines.push(describeTodoMisses(board, unmatched, projectName));
          // A move is where two agents most plausibly collide on the same card,
          // so the staleness line earns its place here.
          if (staleLine) lines.push(staleLine);
          // Moving INTO In Progress takes the card. Say so, so the agent knows the
          // hold exists and that finishing or moving it out is what releases it.
          if (matched.length && phase === 'in_progress') {
            lines.push(`Held by this session (${getAgentSessionId()}) — other agents asking for work will be told these are taken. Move out of In Progress or complete to release.`);
          }
          return { content: [{ type: 'text', text: lines.join('\n') || `No matching cards found in ${projectName}.` }] };
        }

        if (action === 'complete') {
          if (!todos.length) throw new ToolInputError('todos is required for the complete action — an array of card ids or title substrings to complete.');
          const todoItems = ctx?.todo_items || [];
          const { matched, ambiguous, unmatched } = resolveTodoQueries(todoItems, todos);
          const evicted: Array<{ id?: string; title: string }> = [];
          for (const { card } of matched) {
            collectEvictedCards(evicted, await client.recordContextEvent({
              event_type: 'todo_completed',
              project_id: resolvedProjectId,
              summary: `Completed: ${card.title}`,
              metadata: { todo: card.id, surface: 'claude_code', session_id: getAgentSessionId() },
            }));
          }
          const matchedCards = matched.map((r) => r.card);
          const lost = await cardsThatNeverReachedDone(matchedCards);
          const landed = matchedCards.map((c) => String(c.title)).filter((t) => !lost.includes(t));
          const lines: string[] = [];
          if (landed.length) lines.push(`Marked complete (→ Done) in ${projectName}: ${landed.map(t => `"${t}"`).join(', ')}`);
          if (lost.length) lines.push(doneWriteLostWarning(lost));
          if (evicted.length) lines.push(describeEvictedCards(evicted));
          if (ambiguous.length) lines.push(formatAmbiguousTodos(ambiguous, 'completed'));
          if (unmatched.length) lines.push(describeTodoMisses(board, unmatched, projectName));
          return { content: [{ type: 'text', text: lines.join('\n') || `No matching cards found in ${projectName}.` }] };
        }

        if (action === 'remove') {
          if (!todos.length) throw new ToolInputError('todos is required for the remove action — an array of card ids or title substrings to remove.');
          // The schema has advertised confirm_destructive since this tool
          // shipped, and nothing here read it — while the hosted dispatcher
          // (apps/api/src/routes/mcp.js) has always enforced it. Advertising a
          // confirmation that does not exist is worse than having none: it tells
          // the caller a safety net is there. Removal is a hard delete with no
          // undo, so the local path now matches the contract it publishes.
          if (args?.confirm_destructive !== true) {
            const preview = todos.map((t) => {
              const hit = [...(ctx?.todo_items || []), ...(ctx?.completed_todos || [])]
                .filter((c: any) => c?.id === t || String(c?.title || '').trim().toLowerCase() === String(t).trim().toLowerCase());
              return hit.length === 1
                ? `  • "${hit[0].title}" [${hit[0].id}]`
                : `  • "${t}" — ${hit.length ? `${hit.length} cards match` : 'no exact match'}`;
            }).join('\n');
            return {
              content: [{
                type: 'text',
                text: `Nothing was removed. Deleting a card is permanent and there is no undo, so this needs confirm_destructive: true.\n${preview}\nRe-run with confirm_destructive: true once these are the cards you mean.`,
              }],
            };
          }
          const removeCandidates = [...(ctx?.todo_items || []), ...(ctx?.completed_todos || [])];
          const { matched, ambiguous, unmatched } = resolveTodoQueries(removeCandidates, todos);
          for (const { card } of matched) {
            await client.recordContextEvent({
              event_type: 'todo_removed',
              project_id: resolvedProjectId,
              summary: `Removed: ${card.title}`,
              metadata: { todo: card.id, surface: 'claude_code', session_id: getAgentSessionId() },
            });
          }
          // Report what the board LOST, not what was asked for — checked by id, so
          // the read-back asks about the exact card that was addressed.
          const matchedCards = matched.map((r) => r.card);
          let stillPresent: string[] = [];
          if (matchedCards.length) {
            try {
              const after = await client.getContextJson(resolvedProjectId);
              const remainingIds = new Set([...(after?.todo_items || []), ...(after?.completed_todos || [])].map((c: any) => c?.id));
              stillPresent = matchedCards.filter((c) => remainingIds.has(c.id)).map((c) => String(c.title));
            } catch { /* best-effort: never turn a real removal into a reported failure */ }
          }
          const gone = matchedCards.map((c) => String(c.title)).filter((t) => !stillPresent.includes(t));
          const lines: string[] = [];
          if (gone.length) lines.push(`Removed from ${projectName}: ${gone.map(t => `"${t}"`).join(', ')}`);
          if (stillPresent.length) {
            lines.push(
              `Still on the board: ${stillPresent.map(t => `"${t}"`).join(', ')} — the delete did not land. `
              + 'Re-run with the card id, and check the board with action:"list".'
            );
          }
          if (ambiguous.length) lines.push(formatAmbiguousTodos(ambiguous, 'removed'));
          if (unmatched.length) lines.push(describeTodoMisses(board, unmatched, projectName));
          return { content: [{ type: 'text', text: lines.join('\n') || `No matching cards found in ${projectName}.` }] };
        }

        // Named for the tool the caller actually invoked. manage_todos is the
        // dispatch target behind manage_tasks and is not in tools/list, so
        // telling a caller its action was rejected by a tool it cannot see
        // leaves it nothing to correct.
        throw new ToolInputError(`Unknown manage_tasks action "${action}". Valid actions: list, add, move, complete, remove.`);
      }

      case 'sync_skills': {
        const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
        await syncProjectFiles(client, cwd);
        const skills = await client.listSkills().catch(() => []);
        const enabled = skills.filter((s) => s.enabled);
        const text = enabled.length
          ? `Synced ${enabled.length} shared skill${enabled.length === 1 ? '' : 's'} to disk for every connected tool: ${enabled.map((s) => s.slug).join(', ')}.`
          : 'No enabled shared skills to sync. Skill distribution is dark until skills are enabled.';
        return { content: [{ type: 'text', text }] };
      }

      case 'list_skills': {
        const skills = await client.listSkills(args?.project_id);
        if (!skills.length) {
          return { content: [{ type: 'text', text: 'No shared skills available.' }] };
        }
        const lines = skills.map((s) => `- ${s.name} (${s.slug})${s.description ? ` — ${s.description}` : ''}`);
        return { content: [{ type: 'text', text: `Shared skills:\n${lines.join('\n')}\n\nCall browse_skills with action "get" and a slug to load one in full.` }] };
      }

      case 'get_skill': {
        const slug = String(args?.slug || '').trim();
        if (!slug) {
          return { content: [{ type: 'text', text: 'A slug is required. Call browse_skills with action "list" to see available skills.' }] };
        }
        const skill = await client.getSkill(slug);
        if (!skill) {
          return { content: [{ type: 'text', text: `No shared skill found for slug "${slug}".` }] };
        }
        return { content: [{ type: 'text', text: skill.markdown_content || `Skill "${skill.name}" has no content.` }] };
      }

      case 'import_skill_from_github': {
        const repoUrl = String(args?.repo_url || args?.url || '').trim();
        if (!repoUrl) {
          return { content: [{ type: 'text', text: 'Importing a skill requires a repo_url. Paste a GitHub repo, folder, or SKILL.md URL into manage_skills({ action: "import_github", repo_url: "..." }).' }] };
        }
        try {
          const { skill, source_url } = await client.importSkillFromGithub(repoUrl, args?.project_id);
          // Flush to disk so the connected tool picks up the new skill immediately.
          const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
          await syncProjectFiles(client, cwd).catch(() => {});
          const from = source_url || repoUrl;
          return { content: [{ type: 'text', text: `Imported "${skill.name}" (${skill.slug}) from ${from} and synced it to disk for every connected tool. Manage it anytime under Settings → Shared Skills.` }] };
        } catch (error) {
          // Translate the API's error codes into actionable guidance rather than
          // letting handleApiError collapse them into a generic status message.
          const code = (error as { response?: { data?: { error?: string } } })?.response?.data?.error;
          const friendly: Record<string, string> = {
            skills_limit_exceeded: 'You’ve reached your shared-skills limit — upgrade your plan to import more.',
            skill_file_not_found: 'No SKILL.md found there. Point to the repo, folder, or file that contains it.',
            github_url_required: 'Paste a GitHub repo URL.',
            github_url_invalid: 'That doesn’t look like a GitHub repo URL.',
            github_url_unsupported_host: 'Only public github.com repos can be imported.',
            github_rate_limited: 'GitHub rate limit hit — try again in a minute (or set GITHUB_TOKEN in the server env).',
            github_fetch_failed: 'Couldn’t reach that repo. Check the URL and that it’s public.',
            skill_contains_secret: 'That SKILL.md contains what looks like a secret, so it was rejected.',
          };
          if (code && friendly[code]) {
            return { content: [{ type: 'text', text: friendly[code] }] };
          }
          return handleApiError(error);
        }
      }

      default:
        throw new Error(`Unknown context sync tool: ${name}`);
    }
  } catch (error) {
    handleApiError(error);
  }
}
