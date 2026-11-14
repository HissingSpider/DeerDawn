const express = require('express');
const { randomUUID } = require('crypto');
const { z } = require('zod');
const IORedis = require('ioredis');
const { requireAuth, requireAnyScope } = require('../../middleware/auth');
const service = require('../../services/contextSyncService');
const contextSearch = require('../../services/contextSearchService');
const { serializeProjectSummary, serializeProjectFull } = require('../../serializers/contextProject');
const { computeWorkspaceActivity, computeMemoryTotals } = require('../../services/activityDigestService');
const { renderContextExportMarkdown } = require('../../services/contextExportMarkdown');
const trailService = require('../../services/trail');
const trailFormat = require('../../services/trail/trailFormat');
const briefStashService = require('../../services/briefStashService');
const portfolioService = require('../../services/portfolioService');
const shareService = require('../../services/shareService');
const { checkAndMarkSessionLoad } = require('../../services/sessionDedup');
const { buildSessionCatchup, recordCreationSessionLoad } = require('../../services/sessionCatchupService');
const { purgeOwnerData } = require('../../services/dataErasureService');
const { cancelSubscriptionForDeletion } = require('../../services/stripeService');
const { getEntitlements } = require('../../services/entitlementService');
const { recordProductEvent } = require('../../services/productEventsService');
const connectionIdentity = require('../../services/connectionIdentity');
const store = require('../../store/contextSyncStore');
const { normalizeGraphNodeTitle } = require('../../store/graphNodeTitle');
const { clientErrorStatus, clientErrorBody } = require('../../utils/clientErrors');
const env = require('../../config/env');
const {
  ProjectMatchResultSchema,
  TOOL_VALUES,
  formatMapInjection,
  formatSectionInjection,
  formatWorkspaceOverview,
  formatCodeInjection,
  extractStructuredFields,
  SubagentBriefRequestSchema,
  buildBriefCard,
  formatPresenceBlock,
  PRESENCE_WINDOW_SECONDS,
} = require('../../../../../packages/shared-context/src/index.js');
const { apiLimiter, contextHeavyLimiter } = require('../../middleware/rateLimit');
const db = require('../../config/db');
const workspace = require('../../services/workspaceService');

const redisDisabled = process.env.DISABLE_REDIS === 'true' || process.env.NODE_ENV === 'test';

// SSE /stream: cap concurrent connections per owner — each one holds its own
// IORedis subscriber, so an unbounded number would exhaust Redis connections.
const MAX_STREAM_CONNECTIONS_PER_OWNER = 5;
const streamConnectionsByOwner = new Map();

const router = express.Router();

// The audit log records WHO, not just what.
//
// context_audit_logs carried owner_key, action, actor_type and tool — and no
// user identity. On a single-person account that is complete. On a shared
// workspace it answers "something happened here", which is the one question
// nobody is asking; "did Marcus read the client project" was unanswerable.
// actor_user_id is populated here so every existing call site gains attribution
// without being touched.
function actorUserId(actor) {
  if (!actor) return null;
  // A key-authed actor's `id` is the key id, not a person — owner_id is the human
  // who created the key, and is what makes MCP traffic attributable at all.
  if (actor.type === 'key') return actor.owner_id || null;
  return actor.id || null;
}

function logContextAudit(actor, action, meta = {}) {
  const ownerKey = meta.owner_key || workspace.defaultOwnerKey(actor);
  if (!ownerKey) return;
  db.query(
    `INSERT INTO context_audit_logs (audit_id, owner_key, project_id, action, actor_type, actor_user_id, tool, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      `audit_${randomUUID()}`,
      ownerKey,
      meta.project_id || null,
      action,
      meta.actor_type || actor?.type || 'user',
      actorUserId(actor),
      meta.tool || null,
      meta,
    ],
    'org-system'
  ).catch(() => {});
}

// Standalone schemas — avoids .pick().extend() / .partial().extend() on shared schemas,
// which breaks when @asteasolutions/zod-to-openapi patches the Zod prototype.

const DecisionEntrySchema = z.object({
  summary: z.string(),
  decided_at: z.string().datetime(),
});

const CreateProjectRequestSchema = z.object({
  project_name:          z.string().min(1),
  parent_project_id:     z.string().optional(),
  // The repo this project belongs to (the client's git-derived workspace key).
  // Zod strips unknown keys, so until this was declared a caller that sent one
  // had it silently dropped, and a pin on the new project could never match.
  workspace_key:         z.string().min(1).max(512).optional(),
  description:           z.string().optional().default(''),
  goals:                 z.array(z.string()).optional().default([]),
  current_status:        z.string().optional().default(''),
  recurring_context:     z.array(z.string()).optional().default([]),
  tech_stack:            z.array(z.string()).optional().default([]),
  file_structure_summary: z.array(z.string()).optional().default([]),
  current_task:          z.string().optional().default(''),
  open_questions:        z.array(z.string()).optional().default([]),
  recent_decisions:      z.array(DecisionEntrySchema).optional().default([]),
  hot_paths: z.array(z.object({
    label: z.string().min(1),
    path: z.string().min(1),
    purpose: z.string().optional(),
  })).optional().default([]),
  entrypoints: z.array(z.object({
    label: z.string().min(1),
    path: z.string().min(1),
    purpose: z.string().optional(),
  })).optional().default([]),
  surfaces: z.array(z.object({
    label: z.string().min(1),
    paths: z.array(z.string()).optional().default([]),
    purpose: z.string().optional(),
  })).optional().default([]),
  debugging_notes: z.array(z.object({
    summary: z.string().min(1),
    paths: z.array(z.string()).optional().default([]),
    added_at: z.string().datetime().optional(),
  })).optional().default([]),
  // Brief-spine LANDMINE slot — sharp, durable watch-outs. Object entries (not
  // bare strings) so per-item provenance/trust works. Optional + defaulted so
  // every existing create request validates unchanged. SHIPPED is intentionally
  // absent here — it is populated only from structured completion events.
  landmines: z.array(z.object({
    summary: z.string().min(1),
    paths: z.array(z.string()).optional().default([]),
    added_at: z.string().datetime().optional(),
    importance: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  })).optional().default([]),
  linked_paths:          z.array(z.string()).optional().default([]),
  last_updated:          z.string().datetime().optional(),
  source_summary:        z.string().optional(),
  // SET ONLY BY THE LOCAL MCP SERVER's create, and never stored on the project:
  // this create happened inside an agent session, so it is that session's
  // first load (recordCreationSessionLoad). Explicit, rather than read off the
  // credential, because a key can just as well be a script or the website: a
  // brief made on the website is not a session and must not count as one.
  //
  // NONE OF THE THREE CAN FAIL A CREATE. They only book a session row, so any
  // value is accepted here and anything that is not exactly right is read as
  // absent in the handler (sessionFieldsFrom): an unknown or over-long tool (a
  // long DEERDAWN_SURFACE_ID) is stored as no tool, a bad session id as none.
  from_mcp_session:      z.unknown().optional(),
  session_tool:          z.unknown().optional(),
  session_id:            z.unknown().optional(),
});

// The MCP-session fields of a create, coerced: never a reason to refuse one.
function sessionFieldsFrom(data) {
  const tool = typeof data.session_tool === 'string' ? data.session_tool.trim() : '';
  const id = typeof data.session_id === 'string' ? data.session_id.trim() : '';
  return {
    fromMcpSession: data.from_mcp_session === true,
    sessionTool: TOOL_VALUES.includes(tool) ? tool : null,
    sessionId: id && id.length <= 128 ? id : null,
  };
}

const ExtractionRouteInputSchema = z.object({
  session_id: z.string().min(1),
  tool:       z.enum(TOOL_VALUES),
  project_id: z.string().min(1).optional(),
  // Benchmark/verification mode: run the extraction pipeline but persist nothing,
  // so latency probes never mutate the live project brief. (See scripts/perf.)
  dry_run:    z.boolean().optional(),
  // The caller ASKED for this text to be saved (update_context), as opposed to
  // a passive capture. Routes the write through recordExplicitUpdate: stored
  // verbatim, once, and never allowed to replace the current task.
  explicit:   z.boolean().optional(),
  // false: `tool` is the local server's rendering DEFAULT for a client it could
  // not place, not that client's identity. The save is then not credited to a
  // tool by name (the receipt's "last saved … in X"). Absent reads as before.
  tool_identified: z.boolean().optional(),
  // Location fields are NULLABLE: a client with nothing to say sends null, and
  // round 11's mcp-server does exactly that for `host` (it stopped sending the
  // hostname) and, outside a project directory, for `cwd`. Refusing null turned
  // every local summary update into a 400. null means "absent" — see
  // withoutNullFields, applied after parsing so nothing downstream sees a null.
  //
  // workspace_key is declared because the Stop-hook flush sends it and
  // applyExtraction reads it (project tagging, and the family rule in
  // claimablePaths). Zod strips undeclared keys, so until now it was dropped
  // on the way in and both of those paths only ever saw null.
  session_context: z.object({
    conversation_ref: z.string().nullish(),
    cwd: z.string().nullish(),
    host: z.string().nullish(),
    tab_id: z.string().nullish(),
    status: z.enum(['active', 'paused', 'idle', 'closed', 'ambiguous']).nullish(),
    surface_type: z.enum(['browser', 'cli', 'code']).nullish(),
    workspace_key: z.string().min(1).max(512).nullish(),
  }).nullish(),
  chunk: z.object({
    role: z.string().min(1),
    text: z.string().min(1),
  }).optional(),
  chunks: z.array(z.object({
    role: z.string().min(1),
    text: z.string().min(1),
  })).optional(),
  extraction: z.object({
    match_decision:         z.enum(['matched_existing', 'new_project', 'ambiguous', 'ignored']),
    confidence:             z.number().min(0).max(1),
    project_candidate:      z.object({ project_id: z.string().optional(), project_name: z.string(), reason: z.string().optional(), score: z.number().optional() }).optional(),
    delta:                  z.record(z.unknown()).default({}),
    should_create_project:  z.boolean(),
    needs_user_confirmation: z.boolean(),
    no_material_change: z.boolean().optional(),
  }).optional(),
});

// Same nullable location fields as session_context above. project_id keeps its
// null: there it means "unbind", not "absent".
const SessionPatchSchema = z.object({
  tool: z.enum(TOOL_VALUES).optional(),
  surface_type: z.enum(['browser', 'cli', 'code']).optional(),
  project_id: z.string().nullable().optional(),
  conversation_ref: z.string().nullish(),
  cwd: z.string().nullish(),
  host: z.string().nullish(),
  tab_id: z.string().nullish(),
  status: z.enum(['active', 'paused', 'idle', 'closed', 'ambiguous']).optional(),
});

// null means "the client has nothing to say about this field", which is what
// an absent key already means everywhere downstream. Dropped here, once, so the
// session store (whose schema defaults these to '') never receives a null.
function withoutNullFields(obj, keep = []) {
  if (!obj || typeof obj !== 'object') return obj ?? undefined;
  return Object.fromEntries(Object.entries(obj).filter(([key, value]) => value !== null || keep.includes(key)));
}

const MatchRequestSchema = z.object({
  tool:         z.enum(TOOL_VALUES),
  project_hint: z.string().optional(),
  candidates:   z.array(z.object({
    project_id:   z.string().optional(),
    project_name: z.string(),
    score:        z.number().min(0).max(1).optional(),
  })).default([]),
});

const ToolPreferencePatchSchema = z.object({
  enabled:   z.boolean().optional(),
  verbosity: z.enum(['light', 'standard', 'detailed']).optional(),
});

const PreferencesRequestSchema = z.object({
  paused: z.boolean().optional(),
  tools: z.object({
    claude_web:  ToolPreferencePatchSchema.optional(),
    chatgpt_web: ToolPreferencePatchSchema.optional(),
    cursor:      ToolPreferencePatchSchema.optional(),
    claude_code: ToolPreferencePatchSchema.optional(),
    codex:       ToolPreferencePatchSchema.optional(),
  }).optional(),
});

const GraphQuerySchema = z.object({
  project_id: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  node_id: z.string().min(1).optional(),
}).refine((value) => value.project_id || value.session_id || value.node_id, {
  message: 'project_id, session_id, or node_id is required',
});

const WorkspaceOverviewQuerySchema = z.object({
  mode: z.enum(['startup', 'overview']).optional().default('overview'),
  verbosity: z.enum(['light', 'standard', 'detailed']).optional().default('standard'),
  include: z.string().optional(),
  format: z.enum(['text', 'json']).optional().default('text'),
});

const WorkspaceEntitiesQuerySchema = z.object({
  types: z.string().optional(),
  query: z.string().optional(),
  project_id: z.string().optional(),
  related_project_id: z.string().optional(),
  scope: z.enum(['workspace', 'project']).optional(),
  surface: z.string().optional(),
  status: z.string().optional(),
  include_inferred: z.preprocess((value) => value === 'true' || value === '1' || value === true, z.boolean()).optional().default(true),
  include_resolved: z.preprocess((value) => value === 'true' || value === '1' || value === true, z.boolean()).optional().default(false),
  curated_only: z.preprocess((value) => value === 'true' || value === '1' || value === true, z.boolean()).optional().default(false),
  limit: z.coerce.number().int().min(1).max(50).optional().default(10),
  format: z.enum(['text', 'json']).optional().default('text'),
});

const NextBestContextQuerySchema = z.object({
  tool: z.enum(['claude_web', 'chatgpt_web', 'cursor', 'claude_code', 'codex']).optional(),
  cwd: z.string().optional(),
  project_id: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(10).optional().default(5),
  // The asking agent. Board cards held by ANOTHER session are withheld (and the
  // withholding is reported); cards this session already holds are ranked up, so
  // resuming your own work beats being handed something new. Absent → nothing is
  // treated as self-held, which withholds more rather than less. That direction
  // is deliberate: over-withholding costs a visible line, under-withholding hands
  // two agents the same card.
  session_id: z.string().max(128).optional(),
});

const WorkspaceEntitiesUpsertSchema = z.object({
  entities: z.array(z.object({
    entity_type: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().optional(),
    scope: z.enum(['workspace', 'project']).optional(),
    project_id: z.string().optional(),
    // project_id is the local manage_memory default (its fileEntitiesUnderProject),
    // which applies to a NEW entity only; see service.upsertWorkspaceEntities.
    filed_by_default: z.boolean().optional(),
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
    }).catchall(z.unknown()).optional(),
  })).min(1),
  relations: z.array(z.object({
    from_canonical_key: z.string().min(1),
    to_canonical_key: z.string().min(1),
    relation_type: z.string().min(1),
    summary: z.string().optional(),
  })).optional(),
});

const ProjectMapQuerySchema = z.object({
  verbosity: z.enum(['light', 'standard', 'detailed']).optional().default('standard'),
  format: z.enum(['text', 'json']).optional().default('text'),
});

const KnownPathsQuerySchema = z.object({
  query: z.string().min(1),
  project_id: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(25).optional().default(10),
  format: z.enum(['text', 'json']).optional().default('text'),
});

// The item schema is the service's, so every door (this route, /events,
// the hosted dispatcher) validates a path the same way.
const RecordHotPathsSchema = z.object({
  items: z.array(service.RecordHotPathItemSchema).min(1),
});

const RecordDebugFindingSchema = z.object({
  summary: z.string().min(1),
  paths: z.array(z.string()).optional().default([]),
  // Any string: the service normalizes it (a date alone is midnight UTC) and
  // answers 400 invalid_debug_finding, naming added_at, for one it cannot read —
  // the same answer /events and the hosted dispatcher give.
  added_at: z.string().optional(),
  commit_ref: z.string().optional(),
  diff_ref: z.string().optional(),
  importance: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  pinned: z.boolean().optional(),
  source_tool: z.string().optional(),
  supersedes: z.string().optional(),
});

const ConfirmClaimSchema = z.object({
  claim: z.string().min(1),
  verified_commit: z.string().optional(),
});

const ContextEventIngestSchema = z.object({
  event_type: z.enum([
    'task_started',
    'task_completed',
    'decision_made',
    'question_asked',
    'question_answered',
    'file_changed',
    'command_confirmed',
    'feature_shipped',
    'debug_finding',
    'hot_path_discovered',
    'blocker_opened',
    'blocker_resolved',
    'todo_added',
    'todo_moved',
    'todo_completed',
    'todo_removed',
  ]),
  project_id: z.string().optional().nullable(),
  summary: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});

router.use(requireAuth);
router.use(requireAnyScope(['context:read', 'context:write', 'context:admin']));

const requireContextWrite = requireAnyScope(['context:write', 'context:admin']);
const requireContextAdmin = requireAnyScope(['context:admin']);

// ── Portfolio (cross-project) ────────────────────────────────────────────────
//
// ONE endpoint for both tiers. Free is not redirected to a marketing page and
// does not get a different route: it gets this route, its own real counts, and
// `locked: true`. The gate is on what comes back, not on who may call.
//
// This is a READ gate, which is the rule the whole entitlement design rests on:
// the MCP writes mid-session inside an agent loop, so a paywall that throws on a
// write produces a broken agent loop and a user who thinks the product is buggy,
// never an upgrade. Writes succeed at every tier; only displays are gated.
const PortfolioQuerySchema = z.object({
  q: z.string().max(200).optional(),
  entity_limit: z.coerce.number().int().min(1).max(200).optional(),
  decision_limit: z.coerce.number().int().min(1).max(200).optional(),
});

router.get('/portfolio', async (req, res, next) => {
  try {
    const parsed = PortfolioQuerySchema.parse(req.query);
    const portfolio = await portfolioService.getPortfolio(req.actor, {
      query: parsed.q || '',
      entityLimit: parsed.entity_limit ?? 50,
      decisionLimit: parsed.decision_limit ?? 50,
    });
    return res.json(portfolio);
  } catch (err) { next(err); }
});

// ── Share links ──────────────────────────────────────────────────────────────

const ShareCreateSchema = z.object({
  visibility: z.enum(['unlisted', 'public']).optional(),
  acknowledged_finding_ids: z.array(z.string()).max(500).optional(),
});
const ShareVisibilitySchema = z.object({
  visibility: z.enum(['unlisted', 'public']),
  acknowledged_finding_ids: z.array(z.string()).max(500).optional(),
});

// 422 + the findings, never a silent success. The client cannot mint a link
// without having been handed the list of what the scan objected to.
function respondShareError(res, err, next) {
  if (err?.message === 'share_scan_unresolved') {
    return res.status(422).json({
      error: 'share_scan_unresolved',
      message: err.publicMessage,
      scan: err.scan,
      // Mirrored into `details` because that is the only field the dashboard's
      // generic ApiError carries through. Without it the client would surface
      // "we found 3 things" and be unable to say which three.
      details: err.scan,
    });
  }
  if (err?.message === 'share_requires_upgrade') {
    return res.status(403).json({
      error: 'share_requires_upgrade',
      upgrade_required: true,
      message: err.publicMessage,
    });
  }
  if (err?.message === 'share_forbidden') {
    return res.status(403).json({ error: 'share_forbidden', message: err.publicMessage });
  }
  if (err?.message === 'project_not_found' || err?.message === 'share_not_found') {
    return res.status(404).json({ error: err.message });
  }
  return next(err);
}

router.get('/projects/:projectId/share/preview', async (req, res, next) => {
  try {
    const result = await shareService.previewShare(req.actor, req.params.projectId);
    return res.json(result);
  } catch (err) { return respondShareError(res, err, next); }
});

router.post('/projects/:projectId/share', requireContextWrite, async (req, res, next) => {
  try {
    const parsed = ShareCreateSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
    }
    const result = await shareService.createShare(req.actor, {
      project_id: req.params.projectId,
      visibility: parsed.data.visibility || 'unlisted',
      acknowledged_finding_ids: parsed.data.acknowledged_finding_ids || [],
    });
    logContextAudit(req.actor, 'share_link_created', {
      project_id: req.params.projectId,
      visibility: result.share.visibility,
    });
    return res.status(201).json(result);
  } catch (err) { return respondShareError(res, err, next); }
});

router.get('/shares', async (req, res, next) => {
  try {
    return res.json(await shareService.listShares(req.actor));
  } catch (err) { return respondShareError(res, err, next); }
});

router.patch('/shares/:token', requireContextWrite, async (req, res, next) => {
  try {
    const parsed = ShareVisibilitySchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
    }
    const share = await shareService.setShareVisibility(
      req.actor,
      req.params.token,
      parsed.data.visibility,
      { acknowledged_finding_ids: parsed.data.acknowledged_finding_ids || [] },
    );
    logContextAudit(req.actor, 'share_link_visibility_changed', {
      project_id: share.project_id,
      visibility: share.visibility,
    });
    return res.json({ share });
  } catch (err) { return respondShareError(res, err, next); }
});

// ⚠ Revoke turns the URL off. It is a tombstone, not a delete — the row stays so
// a visitor holding the old link is told the owner turned it off rather than
// meeting a 404 that reads like a broken product.
router.delete('/shares/:token', requireContextWrite, async (req, res, next) => {
  try {
    const share = await shareService.revokeShare(req.actor, req.params.token);
    logContextAudit(req.actor, 'share_link_revoked', { project_id: share.project_id });
    return res.json({ share });
  } catch (err) { return respondShareError(res, err, next); }
});

// Per-workspace weekly activity — "what DeerDawn did for you" (dashboard "This week").
router.get('/activity', async (req, res, next) => {
  try {
    const sinceDays = Number(req.query.days) || 7;
    const activity = await computeWorkspaceActivity(req.actor, sinceDays);
    res.json({ activity });
  } catch (err) { next(err); }
});

// renderContextExportMarkdown now lives in services/contextExportMarkdown.js so
// the account-deletion "email me my data" export renders the identical .md.

// Context export — the custody-lock-in pressure valve. "You can always get your
// data out": full JSON by default, or human-readable markdown with ?format=markdown.
// Both download as attachments.
router.get('/export', async (req, res, next) => {
  try {
    const bundle = await service.exportContext(req.actor);
    if (String(req.query.format).toLowerCase() === 'markdown') {
      const md = renderContextExportMarkdown(bundle);
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="deerdawn-context-export.md"');
      return res.send(md);
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="deerdawn-context-export.json"');
    return res.send(JSON.stringify(bundle, null, 2));
  } catch (err) { next(err); }
});

// ─── Trails ──────────────────────────────────────────────────────────────────
// A Trail is a portable .dawn archive of one project. Export is private by
// default and deliberately separate from publish: publishing runs the redaction
// gate in services/trail/trailPublish.js, which re-scans server-side and
// refuses while any finding is unresolved. There is no route that publishes in
// one call, and adding one would defeat the gate.

// A DEFENSIVE OUTPUT MASK on the three REST reads an agent's context is built
// from: /active (the SessionStart hook injects it verbatim), /inject and /trail.
// The store now redacts on every write (store.redactForStorage), but rows
// written before that still hold whatever was pasted, and the hosted MCP
// surface has always masked its own output. Same redactor, applied to the
// response OBJECT — never to serialized JSON text, where a pattern spanning
// punctuation could break the document.
function maskSecretsInResponse(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => json(store.redactForStorage(body));
  next();
}

// Export a project as a .dawn file. PRIVATE — nothing here has been scanned.
router.get('/projects/:projectId/trail', maskSecretsInResponse, async (req, res, next) => {
  try {
    const result = await trailService.exportTrail(req.actor, req.params.projectId, {
      source: {
        repo_url: req.query.repo_url,
        commit_sha: req.query.commit_sha,
        branch: req.query.branch,
      },
      exporter: { tool: req.query.tool || 'api', version: req.query.tool_version },
      // ?kind=pack marks the export as curated knowledge for OTHER projects.
      // Anything unrecognized normalizes to 'project', the conservative default.
      kind: req.query.kind,
    });
    // Masked as an object and, only when that changed anything, re-sealed:
    // the checksum is over the content, and one computed before the mask would
    // verify against the unmasked bytes (see trailFormat.sealTrail).
    const masked = store.redactForStorage(result.trail);
    const changed = JSON.stringify(masked) !== JSON.stringify(result.trail);
    const trail = changed ? trailFormat.sealTrail(masked) : result.trail;
    if (String(req.query.format).toLowerCase() === 'markdown') {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename.replace(/\.dawn$/, '.md')}"`);
      return res.send(trailService.renderMarkdown(trail));
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    return res.send(changed ? trailFormat.serializeTrail(trail) : result.serialized);
  } catch (err) {
    if (err?.message === 'project_not_found') return res.status(404).json({ error: 'project_not_found', message: err.publicMessage });
    return next(err);
  }
});

// The publish preview: every finding the author has to resolve, grouped by
// field. Read-only — it changes nothing and publishes nothing.
router.get('/projects/:projectId/trail/preview', requireContextWrite, async (req, res, next) => {
  try {
    const { preview } = await trailService.previewPublish(req.actor, req.params.projectId, {
      source: { repo_url: req.query.repo_url, commit_sha: req.query.commit_sha, branch: req.query.branch },
      kind: req.query.kind,
    });
    return res.json({ preview });
  } catch (err) {
    if (err?.message === 'project_not_found') return res.status(404).json({ error: 'project_not_found', message: err.publicMessage });
    return next(err);
  }
});

// Publish. `decisions` must carry one entry per finding id from the preview.
// The server re-scans regardless of what the client says it reviewed.
const TrailPublishSchema = z.object({
  decisions: z.record(z.object({
    action: z.enum(['exclude', 'keep']),
    justification: z.string().optional(),
    digest: z.string().optional(),
  })).default({}),
  source: z.object({
    repo_url: z.string().optional(),
    commit_sha: z.string().optional(),
    branch: z.string().optional(),
  }).optional(),
  author: z.string().optional(),
  // Kind travels through publish because the published bytes are re-exported
  // here; without it a pack would reach the gallery labelled as a project and
  // importers would take the author's task state.
  kind: z.enum(['project', 'pack']).optional(),
});

router.post('/projects/:projectId/trail/publish', requireContextWrite, async (req, res, next) => {
  try {
    const parsed = TrailPublishSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
    }
    const result = await trailService.publishTrail(req.actor, req.params.projectId, parsed.data.decisions, {
      source: parsed.data.source,
      author: parsed.data.author,
      kind: parsed.data.kind,
    });
    return res.json({ trail: result.trail, report: result.report });
  } catch (err) {
    if (err?.message === 'project_not_found') return res.status(404).json({ error: 'project_not_found', message: err.publicMessage });
    if (err?.message === 'trail_publish_blocked') {
      // 422, not 400: the request is well-formed, the CONTENT is not publishable.
      return res.status(422).json({ error: 'trail_publish_blocked', message: err.publicMessage, findings: err.details });
    }
    return next(err);
  }
});

// Import a .dawn into a new or existing project. Non-destructive by
// construction — see services/trail/trailImport.js. ?dry_run=1 returns the plan
// without writing anything.
const { MAX_TRAIL_CHARS } = require('../../config/bodyLimits');
const TrailImportSchema = z.object({
  trail: z.union([z.string().max(MAX_TRAIL_CHARS), z.record(z.any())]),
  project_id: z.string().optional(),
  new_project_name: z.string().optional(),
  dry_run: z.boolean().optional(),
});

// Claim the briefs an anonymous visitor built at /tools/context-preview before
// they had an account. The token comes back on the signup redirect URL.
//
// A missing stash is 410, not an empty 200: it expired, was already claimed, or
// never existed, and every one of those means the user did NOT get the projects
// they were promised. Reporting that as success is the exact silent-success
// shape this codebase keeps getting bitten by.
router.post('/brief-stash/claim', requireContextWrite, async (req, res, next) => {
  const parsed = z.object({ stash_token: z.string().min(1).max(200) }).safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
  }
  try {
    const result = await briefStashService.claimStash(req.actor, parsed.data.stash_token);
    return res.json({
      claimed: result.claimed,
      failed: result.failed,
      claimed_count: result.claimed.length,
    });
  } catch (err) {
    if (err?.status === 410) {
      return res.status(410).json({
        error: 'stash_not_found',
        message: 'Those briefs are no longer available to import. They are kept for one hour after you build them.',
      });
    }
    return next(err);
  }
});

router.post('/trail/import', requireContextWrite, async (req, res, next) => {
  try {
    const parsed = TrailImportSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
    }
    const result = await trailService.importTrail(req.actor, parsed.data.trail, {
      projectId: parsed.data.project_id,
      newProjectName: parsed.data.new_project_name,
      dryRun: parsed.data.dry_run === true,
    });
    return res.json(result);
  } catch (err) {
    if (err?.message === 'project_not_found') return res.status(404).json({ error: 'project_not_found', message: err.publicMessage });
    // A bad .dawn is the caller's mistake, not a server fault — 400, and say why.
    if (String(err?.message || '').startsWith('trail_')) {
      return res.status(400).json({ error: err.message, message: err.publicMessage || err.message });
    }
    // The same refusal from a dry run and a real import, the dry run's marked as
    // a prediction so a client can tell "this would be refused" from "this was".
    if (err?.code === 'share_write_forbidden') {
      return res.status(403).json({
        error: 'share_write_forbidden',
        blocked_fields: err.blocked_fields || [],
        ...(err.publicMessage ? { message: err.publicMessage } : {}),
        ...(err.dry_run ? { dry_run: true } : {}),
      });
    }
    return next(err);
  }
});

router.get('/projects', async (req, res, next) => {
  try {
    // ?archived=1 returns ONLY archived projects (identity-only, newest first).
    // start_session uses it to tell an aged-out user their memory still exists
    // rather than showing an empty workspace. Default is unchanged: live only.
    if (String(req.query.archived || '') === '1' || String(req.query.archived || '') === 'true') {
      // ?limit is honoured because this feed has TWO consumers with opposite
      // needs. start_session's notice is a display list and wants the default 10
      // ("...and N more"). The MCP name->id resolver needs an EXHAUSTIVE view:
      // it turns a project NAME into an id, and a name it cannot see is not just
      // unresolvable — with two projects sharing a normalized name, seeing only
      // one of them makes the ambiguity refusal pass when it should refuse.
      const rawLimit = Number.parseInt(String(req.query.limit || ''), 10);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : undefined;
      const archived = await service.listArchivedProjectSummaries(
        req.actor,
        limit ? { limit } : {}
      );
      return res.json({ projects: archived, archived: true });
    }
    const projects = await service.listProjects(req.actor);
    res.json({ projects: projects.map(serializeProjectSummary) });
  } catch (err) { next(err); }
});

// The caller's own sessions (see service.listSessions). On a solo account that
// is every session, exactly as before.
router.get('/sessions', async (req, res, next) => {
  try {
    const sessions = await service.listSessions(req.actor);
    res.json({ sessions });
  } catch (err) { next(err); }
});

router.patch('/sessions/:sessionId', requireContextWrite, async (req, res, next) => {
  try {
    const parsed = SessionPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
    }
    // patchSession, not upsertSession: a viewer writes nothing, a colleague's
    // session is not found, and a project_id this person cannot read is not
    // found either — each a 4xx the error handler classifies.
    const session = await service.patchSession(
      req.actor,
      req.params.sessionId,
      withoutNullFields(parsed.data, ['project_id'])
    );
    return res.json({ session });
  } catch (err) {
    if (respondWriteForbidden(res, err)) return;
    next(err);
  }
});

// Naming/placement rejections from createProject and renameProject are the
// caller's mistake, not a server defect. The error handler now classifies these
// centrally (any error carrying a publicMessage), so routes no longer have to
// A read-only caller (a viewer, or a workspace owner on a colleague's private
// project) was refused a write. 403 with the service's explanation, never a 500.
function respondWriteForbidden(res, err) {
  if (err?.code !== 'share_write_forbidden') return false;
  const body = { error: 'share_write_forbidden', blocked_fields: err.blocked_fields || [] };
  if (err.publicMessage) body.message = err.publicMessage;
  res.status(403).json(body);
  return true;
}

// remember — this stays only for the routes that want to answer inline.
function respondProjectNameError(res, err) {
  const status = clientErrorStatus(err);
  if (!status) return false;
  res.status(status).json(clientErrorBody(err));
  return true;
}

// Same class of bug as PROJECT_NAME_ERROR_STATUS above, one route down: these are
// plain Errors with a publicMessage explaining the fix, but without this map they
// fall through the catch-all as a 500 and get filed in PostHog Error Tracking as
// if they were server defects.
const WORKSPACE_ENTITY_ERROR_STATUS = {
  workspace_entity_type_invalid: 400,
  workspace_entity_title_required: 400,
  low_value_workspace_entity: 400,
  workspace_entity_project_ambiguous: 400,
  // A resolve naming a decision by a clipped title two decisions begin with.
  decision_title_ambiguous: 409,
};

function respondWorkspaceEntityError(res, err) {
  const status = WORKSPACE_ENTITY_ERROR_STATUS[err?.message];
  if (!status) return false;
  const body = { error: err.message };
  if (err.publicMessage) body.message = err.publicMessage;
  res.status(status).json(body);
  return true;
}

router.post('/projects', requireContextWrite, async (req, res, next) => {
  try {
    const parsed = CreateProjectRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
    }
    const { from_mcp_session: _f, session_tool: _t, session_id: _s, ...createInput } = parsed.data;
    const { fromMcpSession, sessionTool, sessionId } = sessionFieldsFrom(parsed.data);
    const project = await service.createProject(req.actor, createInput);
    // Session one, booked before the first save — the local twin of the hosted
    // create_project dispatch (routes/mcp.js). A person signed in to the
    // dashboard is never a tool's session (renderedForTool), whatever they send.
    if (fromMcpSession && renderedForTool(req.actor)) {
      await recordCreationSessionLoad(req.actor, project.project_id, sessionTool, {
        transport: connectionIdentity.sessionTransport(req.actor, sessionId),
      });
    }
    // Where it is and who reads it, in the words the hosted create replies
    // with; '' in a one-person workspace. The local server appends it to its
    // manage_projects create reply (journey r4).
    const placementNote = await service.describeProjectPlacement(req.actor, project.project_id, { shareHint: true }).catch(() => '');
    return res.status(201).json({
      project: serializeProjectFull(project),
      ...(placementNote ? { placement_note: placementNote.trim() } : {}),
    });
  } catch (err) {
    // Workspace cap. No self-serve plan carries one as of 2026-08-27 (free is
    // included_projects: null), so this branch is currently unreachable — kept
    // because the shape is right for any future capped plan: 422 +
    // upgrade_required so MCP tools and the dashboard can render an upgrade
    // prompt instead of a generic failure.
    if (err?.message === 'project_limit_exceeded') {
      return res.status(err.status || 422).json({
        error: 'project_limit_exceeded',
        upgrade_required: true,
        message: err.publicMessage,
      });
    }
    if (respondWriteForbidden(res, err)) return undefined;
    if (respondProjectNameError(res, err)) return undefined;
    next(err);
  }
});

// Portfolio view: top-level projects with their subprojects nested.
router.get('/projects/tree', async (req, res, next) => {
  try {
    const tree = await service.listProjectTree(req.actor);
    res.json({ projects: tree.map(serializeProjectSummary) });
  } catch (err) { next(err); }
});

// Explicit active-subproject switch for a codebase (workspace_key). Pins the
// project so it wins resolution over the recency tiebreak among siblings.
router.post('/subproject/switch', requireContextWrite, async (req, res, next) => {
  try {
    const projectId = req.body?.project_id ? String(req.body.project_id) : '';
    const workspaceKey = req.body?.workspace_key ? String(req.body.workspace_key) : '';
    if (!projectId) return res.status(400).json({ error: 'project_id_required' });
    if (!workspaceKey) return res.status(400).json({ error: 'workspace_key_required' });
    const project = await service.switchSubproject(req.actor, projectId, workspaceKey);
    return res.json({ project_id: project.project_id, project_name: project.project_name, workspace_key: workspaceKey });
  } catch (err) { next(err); }
});

// Re-parent a project: nest it under { parent_project_id }, or promote it to
// top-level when parent_project_id is omitted/empty.
router.post('/projects/:projectId/parent', requireContextWrite, async (req, res, next) => {
  try {
    const parentProjectId = req.body?.parent_project_id ? String(req.body.parent_project_id) : null;
    const project = await service.setProjectParent(req.actor, req.params.projectId, parentProjectId);
    return res.json({
      project_id: project.project_id,
      project_name: project.project_name,
      parent_project_id: project.parent_project_id,
    });
  } catch (err) {
    if (respondWriteForbidden(res, err)) return undefined;
    next(err);
  }
});

// Soft-archive a project (or restore with { unarchive: true }).
router.post('/projects/:projectId/archive', requireContextWrite, async (req, res, next) => {
  try {
    const project = req.body?.unarchive
      ? await service.unarchiveProject(req.actor, req.params.projectId)
      : await service.archiveProject(req.actor, req.params.projectId);
    return res.json({ project_id: project.project_id, project_name: project.project_name, archived_at: project.archived_at });
  } catch (err) {
    if (respondWriteForbidden(res, err)) return undefined;
    next(err);
  }
});

// Rename a project by { project_name }.
router.post('/projects/:projectId/rename', requireContextWrite, async (req, res, next) => {
  try {
    const rawName = req.body?.project_name;
    if (!rawName || typeof rawName !== 'string' || !rawName.trim()) {
      return res.status(400).json({ error: 'project_name_required' });
    }
    const project = await service.renameProject(req.actor, req.params.projectId, rawName);
    return res.json({ project_id: project.project_id, project_name: project.project_name });
  } catch (err) {
    if (err?.message === 'project_not_found') return res.status(404).json({ error: 'project_not_found' });
    if (respondWriteForbidden(res, err)) return undefined;
    if (respondProjectNameError(res, err)) return undefined;
    next(err);
  }
});

router.post('/preview', requireContextWrite, async (req, res, next) => {
  try {
    const parsed = z.object({ text: z.string().min(1).max(20000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
    const fields = extractStructuredFields(parsed.data.text);
    const brief = formatCodeInjection(fields, 'standard', null);
    const fieldCount = Object.keys(fields).filter(k => {
      const v = fields[k];
      return Array.isArray(v) ? v.length > 0 : Boolean(v);
    }).length;
    return res.json({ fields, brief: brief?.body || '', field_count: fieldCount });
  } catch (err) { next(err); }
});

// Hard daily cap on LLM extractions per org. The per-IP apiLimiter alone
// allows ~170k extraction calls/day from one machine, each spending
// OPENAI_API_KEY money — an unbounded-cost hole when running unattended.
// Redis INCR with a 25h TTL; fails open if Redis is down (the rate limiter
// and in-service guards still apply).
const EXTRACTION_DAILY_CAP = Number(process.env.EXTRACTION_DAILY_CAP || 500);
async function checkExtractionBudget(req, res) {
  if (redisDisabled) return true;
  try {
    const { redis } = require('../../config/redis');
    const key = `extractions:daily:${workspace.defaultOwnerKey(req.actor) || 'anon'}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 25 * 60 * 60);
    if (count > EXTRACTION_DAILY_CAP) {
      res.status(429).json({ error: 'extraction_quota_exceeded', message: 'Daily extraction limit reached. Resets within 24 hours.' });
      return false;
    }
  } catch { /* fail open */ }
  return true;
}

router.post('/extraction', requireContextWrite, apiLimiter, async (req, res, next) => {
  try {
    if (!(await checkExtractionBudget(req, res))) return;
    const parsed = ExtractionRouteInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
    }

    let data = parsed.data;
    if ('session_context' in data) {
      const sessionContext = withoutNullFields(data.session_context);
      data = { ...data, session_context: sessionContext };
      if (!sessionContext) delete data.session_context;
    }

    const explicitText = data.explicit && data.project_id && !data.extraction && !data.dry_run
      ? (data.chunks?.length ? data.chunks : data.chunk ? [data.chunk] : []).map((c) => c.text).join('\n').trim()
      : '';
    if (explicitText) {
      const outcome = await service.recordExplicitUpdate(req.actor, {
        session_id: data.session_id,
        tool: data.tool,
        project_id: data.project_id,
        summary: explicitText,
        session_context: data.session_context,
        ...(data.tool_identified === false ? { tool_identified: false } : {}),
      });
      logContextAudit(req.actor, 'context_write', { project_id: outcome.project.project_id, tool: data.tool, actor_type: 'user' });
      return res.status(202).json({
        project: serializeProjectFull(asStoredProject(outcome.project)),
        session: outcome.session,
        extraction: store.redactForStorage(outcome.extraction),
        graph: outcome.graph,
        stored: outcome.stored,
        // Sent only when it is true, so a client that predates the field sees
        // exactly the response it saw before. The local dispatcher turns it
        // into one line of its reply: stored, but not word for word.
        ...(outcome.redacted ? { redacted: true } : {}),
        ...(outcome.reason ? { reason: outcome.reason, refusal_message: outcome.refusal_message } : {}),
      });
    }

    // If no extraction delta was provided, run the LLM extraction pipeline.
    if (!data.extraction) {
      const extractionService = require('../../services/extractionService');
      data = { ...data, extraction: await extractionService.runExtraction(req.actor, data) };
    }

    if (!data.chunk && !data.chunks?.length) {
      return res.status(400).json({ error: 'invalid_payload', details: [{ path: ['chunks'], message: 'chunk or chunks is required' }] });
    }

    // dry_run: the extraction pipeline above already ran (representative timing),
    // but persist nothing — no delta applied, no events written, brief untouched.
    // This is how latency probes exercise the write path without polluting context.
    if (data.dry_run) {
      const project = data.project_id ? await service.getProject(req.actor, data.project_id) : null;
      return res.status(200).json({ project: serializeProjectFull(project), session: null, extraction: store.redactForStorage(data.extraction), graph: null, dry_run: true });
    }

    const result = await service.applyExtraction(req.actor, data);
    if (!result?.project) {
      return res.status(404).json({ error: 'project_not_found' });
    }

    logContextAudit(req.actor, 'context_write', { project_id: result.project.project_id, tool: data.tool, actor_type: 'user' });
    // serializeProjectFull drops the raw event log (unbounded, >1MB, unread by any
    // /extraction consumer) — this used to make every update_context download the
    // whole history. See serializers/contextProject.js.
    // `extraction` is what was APPLIED (see applyExtraction's applied_extraction),
    // not the request's delta: the local dispatcher prints it as the reply.
    //
    // Both as STORED: the event log and the brief are redacted on the way in, so
    // the delta relayed here is masked the same way — this is the text the local
    // dispatcher prints back to the model.
    return res.status(202).json({
      project: serializeProjectFull(asStoredProject(result.project)),
      session: result.session,
      extraction: store.redactForStorage(result.applied_extraction || data.extraction),
      graph: result.graph,
      // Board cards refused because the board is at its open-card limit (the
      // rest of the delta was saved). Present only when something was refused.
      ...(Array.isArray(result.refused_cards) && result.refused_cards.length
        ? { refused_cards: result.refused_cards, board_open_count: result.board_open_count, board_open_limit: result.board_open_limit }
        : {}),
    });
  } catch (err) { next(err); }
});

// Sections a caller may name on `?sections=`. ONE list, shared by every route
// that serves a section-targeted brief, because two copies drifted: /active
// listed `todos` and /inject did not, so asking /inject for the board returned
// a payload with no board and no error — indistinguishable from "you have no
// cards". The MCP client routes the SAME get_context call to /inject when it has
// a project_id and to /active when it does not, so one list served the board and
// the other silently dropped it.
//
// This is a typo guard, not an authorization boundary: `sections=all` already
// renders every one of these, so naming one can never widen what a caller may
// read. It therefore tracks what formatSectionInjection actually renders
// (shared-context SECTION_MAP, plus the `board` alias for `todos` and the
// global-context keys), and anything the MCP tool schema advertises must appear
// here or that documented call silently returns nothing.
const VALID_SECTIONS = new Set([
  'task','status','description','blocking','progress','decisions','stack','files',
  'hot_paths','entrypoints','surfaces','debugging_notes','landmines','shipped',
  'goals','questions','constraints','todos','board','all','user','prefs',
]);

// WAS THIS BRIEF RENDERED FOR A TOOL, OR SHOWN TO A PERSON?
//
// /inject and /active serve both. The local MCP server, its SessionStart hook
// and the userscript read them to deliver a brief into a tool; the dashboard
// reads the same routes, with the same ?tool=, to show a person what that tool
// would receive ("What your AI reads next session"). A delivery records things —
// context_delivered, the once-per-person first_sync_completed that is mirrored
// to an ad platform as an activation, connection_established, retrieval hits,
// project affinity, a session load, a tool's session row — and the preview
// recorded every one of them: a three-minute-old account that had connected
// nothing was told "No tool has called in for 30 days".
//
// Decided by how the request AUTHENTICATED, never by a parameter the dashboard
// would have to remember to send. A person's interactive session (the
// dashboard's session token or the dd_session cookie) is the only thing the
// auth middleware builds as type 'user'; every tool presents a credential — an
// API key ('key'; OAuth-issued MCP tokens are refused on these routes), or the
// internal system key ('system') — and records exactly as before.
function renderedForTool(actor) {
  return actor?.type !== 'user';
}

router.get('/projects/:projectId/inject', maskSecretsInResponse, async (req, res, next) => {
  try {
    const tool = String(req.query.tool || '');
    const verbosity = String(req.query.verbosity || 'standard');
    const sessionId = req.query.session_id ? String(req.query.session_id) : null;
    // sections= comma-separated list; see VALID_SECTIONS above.
    const rawSections = req.query.sections ? String(req.query.sections) : null;

    // JSON format — return raw structured context object.
    //
    // This branch IS the dashboard's project read: the brief and the board both
    // call /inject?format=json. It used to return before the context_read audit
    // line at the bottom of this handler, so a teammate opening a shared
    // project in the browser left no trace at all — and
    // GET /teams/projects/:id/access, the "who has opened this project" roster
    // built on those rows, was blind to every dashboard read ever made. Same
    // action name as the text path: it is the same event, in a different shape.
    if (req.query.format === 'json') {
      const project = await service.getProject(req.actor, req.params.projectId);
      if (!project) return res.status(404).json({ error: 'project_not_found' });
      logContextAudit(req.actor, 'context_read', {
        project_id: req.params.projectId,
        tool: tool || 'dashboard',
        actor_type: 'user',
        format: 'json',
      });
      return res.json({
        context: {
          project_id: project.project_id,
          project_name: project.project_name,
          updated_at: project.updated_at,
          // The version this read was taken at: the counter the store's
          // compare-and-swap guards on. An edit built from this read sends it
          // back as expected_context_version, so a write made against a copy
          // the project has since moved on from is refused, not applied over
          // whatever landed in between (journey r3, S3-1). updated_at cannot
          // do this job: an explicit PATCH does not move it, and two writes in
          // one millisecond share it.
          context_version: Number.isFinite(project.context_version) ? project.context_version : null,
          ...project.context,
        }
      });
    }

    if (rawSections) {
      // Section-targeted retrieval — return only requested sections
      const sections = rawSections.split(',').map(s => s.trim()).filter(s => VALID_SECTIONS.has(s));
      const project = await service.getProject(req.actor, req.params.projectId);
      if (!project) return res.status(404).json({ error: 'project_not_found' });
      const globalCtx = await service.getGlobalContext(req.actor).catch(() => null);
      // THE SAME MEMORY WINDOW renderInjection and the hosted section read
      // apply. This one rendered straight off the stored context, so a Free
      // account got its aged-out decisions back by asking this surface for the
      // project its own brief had just trimmed. The aged-out sentence rides
      // along, and only when a requested section is one the window can trim.
      const windowed = await service.applyPlanHistoryWindow(req.actor, project.context || {});
      const sectionBody = formatSectionInjection(windowed.context || {}, sections, globalCtx);
      const agedOut = service.sectionsTouchHistoryWindow(sections)
        ? service.formatAgedOutLine(windowed)
        : null;
      const body = agedOut ? `${sectionBody}\n${agedOut}` : sectionBody;
      logContextAudit(req.actor, 'context_read', {
        project_id: req.params.projectId,
        tool: tool || null,
        actor_type: 'user',
        sections,
      });
      return res.json({ payload: { body, sections, project_id: project.project_id, project_name: project.project_name } });
    }

    // Brief shape is OPT-IN. ?shape=spine (or ?format=brief) renders the 4-slot
    // brief TEXT body; default keeps the current text shape. brief_spine attaches
    // either way. (?format=json is the separate raw-context branch handled above.)
    const briefShape = String(req.query.shape) === 'spine' || String(req.query.format) === 'brief';
    const payload = await service.renderInjection(req.actor, req.params.projectId, tool, verbosity, sessionId, {
      ...(briefShape ? { shape: 'spine' } : {}),
      // A preview for a person is not a delivery. See renderedForTool.
      record_side_effects: renderedForTool(req.actor),
    });
    if (!payload) return res.status(204).end();
    logContextAudit(req.actor, 'context_read', { project_id: req.params.projectId, tool, actor_type: 'user' });
    return res.json({ payload });
  } catch (err) { next(err); }
});

// ─── The stored form, not the submitted one ─────────────────────────────────
//
// Every service write hands back the in-memory object it gave store.saveProject,
// and saveProject redacts on the way to the row. A response built from that
// return value therefore echoed a pasted credential the row does not hold: PATCH
// answered with the key in clear, and the local dispatcher printed the
// /extraction delta ("Goal: ... ghp_...") as its reply. redactForStorage is the
// function saveProject applies, and it is idempotent, so this IS the stored
// value — not an approximation of it.
function asStoredProject(project) {
  if (!project || typeof project !== 'object' || !project.context) return project;
  return { ...project, context: store.redactForStorage(project.context) };
}

// Which context fields storage redaction rewrote. A caller that compares what it
// sent with what a read returns needs to know the difference is redaction, not a
// dropped write — the local dispatcher reported "Current task NOT changed" over a
// task that had landed with its key masked, which invites a retry loop.
//
// Measured against the REQUEST. The service now masks a
// patch before it merges (updateProjectContext -> redactForStorage), so the
// project it hands back is already the stored form, and comparing it with
// asStoredProject(itself) found nothing: PATCH never sent `redacted`, and a
// caller comparing what it sent with what it read back saw a "dropped" write.
// The difference has to be measured against what the caller SENT. A field the
// server refused was not stored at all, so it is not reported as redacted.
//
// A field named in `refused` is not always wholly refused. The list fields
// (goals, open_questions, recurring_context) drop only the entries that read as
// connection-test chatter and store the rest — so a list whose accepted entry
// was stored masked was left out, and the caller saw a "dropped" entry that had
// in fact landed. A partly-refused list is reported when an entry the server
// KEPT (its masked form is in the stored list) was masked.
function redactedPatchFields(patch, refused = [], storedContext = null) {
  const refusedFields = new Set(refused.map((item) => item?.field).filter(Boolean));
  const norm = (value) => (typeof value === 'string' ? value.trim() : JSON.stringify(value));
  return Object.keys(patch || {}).filter((key) => {
    const sent = patch[key];
    const masked = store.redactForStorage(sent);
    if (JSON.stringify(masked) === JSON.stringify(sent)) return false;
    if (!refusedFields.has(key)) return true;
    if (!Array.isArray(sent) || !Array.isArray(masked) || !Array.isArray(storedContext?.[key])) return false;
    const stored = new Set(storedContext[key].map(norm));
    return sent.some((entry, index) => norm(masked[index]) !== norm(entry) && stored.has(norm(masked[index])));
  });
}

// ─── Free text has a ceiling ────────────────────────────────────────────────
//
// Every string in a PATCH is run through the storage redactor, and nothing
// capped how long one could be: a 40 KB description took 15 seconds on a
// quadratic redaction pattern (fixed — every pattern is linear now), and a
// value the brief clips to 120 characters has no business being 250 KB. The
// hosted MCP tools already refuse a description over 2,000 and a summary over
// 4,000 (mcpSafety FIELD_LIMITS); this is the REST twin, at the larger of the
// two so a dashboard edit that fit before still fits.
//
// A value identical to what is already STORED is exempt: the dashboard sends
// the whole description back on every save, and an over-long one written by
// some older path must not make the brief unsavable.
const CONTEXT_TEXT_MAX = 4000;
function collectStrings(value, out = [], depth = 0) {
  if (depth > 6 || value === null || value === undefined) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out, depth + 1);
  else if (typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, out, depth + 1);
  return out;
}
function oversizedPatchField(patch, storedContext) {
  for (const [field, value] of Object.entries(patch || {})) {
    const long = collectStrings(value).filter((text) => text.length > CONTEXT_TEXT_MAX);
    if (!long.length) continue;
    const stored = new Set(collectStrings(storedContext?.[field]));
    const offending = long.find((text) => !stored.has(text));
    if (offending) return { field, length: offending.length };
  }
  return null;
}

// ─── Direct context patch — for dashboard editing ────────────────────────────

// ONLY IF NOTHING CHANGED SINCE I READ IT.
//
// PATCH replaces a list with the list it is sent, and the dashboard builds that
// list from the brief it loaded. An open tab clicking Pin after the person's own
// AI tool had recorded a decision sent the three decisions it had loaded, got a
// 200 and "Brief updated.", and the tool's decision was gone everywhere but the
// graph (journey r3, S3-1).
//
// `expected_context_version` is the version the caller read (the brief read,
// GET /projects/:id/inject?format=json, carries it as `context_version`). A
// write made against any other version is refused with 409
// stale_context_version and nothing is saved. OPTIONAL: a request without it —
// every existing client — is exactly as unconditional as it always was.
// Returns { value } (null when absent) or { invalid: true }.
function parseExpectedContextVersion(raw) {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return { invalid: true };
  return { value: raw };
}

function respondStaleContextVersion(res, err) {
  return res.status(409).json({
    error: 'stale_context_version',
    code: 'stale_context_version',
    message: err.publicMessage,
  });
}

async function patchProjectContextHandler(req, res, next) {
  try {
    const expected = parseExpectedContextVersion(req.body?.expected_context_version);
    if (expected.invalid) {
      return res.status(400).json({
        error: 'invalid_expected_context_version',
        message: 'expected_context_version must be the whole-number context_version you read (GET /projects/:id/inject?format=json), or left out. Nothing was saved.',
      });
    }

    const project = await service.getProject(req.actor, req.params.projectId);
    if (!project) return res.status(404).json({ error: 'project_not_found' });

    // Checked here as well as inside the write, so a stale request is refused
    // before the rename below can land half of it. The check that holds under a
    // race is the one in updateProjectContext, against the row it swaps on.
    if (expected.value !== null && Number(project.context_version) !== expected.value) {
      return respondStaleContextVersion(res, service.staleContextVersionError(project, expected.value));
    }

    // task_steps is patchable because the steps BELONG TO the current task, and
    // until now nothing but extraction could write them. So a direct task change
    // left the old steps behind, and buildTaskBoard renders them as cards — the
    // board showed sub-steps of a task that no longer existed, with no way to
    // clear them short of finish_task (which also discards the open questions and
    // command log). Same shape as current_task itself being unsettable.
    const PATCHABLE = ['description','current_task','current_status','task_progress','next_action','goals','open_questions','tech_stack','recent_decisions','blocking_issue','recurring_context','commands','hot_paths','entrypoints','surfaces','debugging_notes','landmines','resolved_landmines','shipped','task_steps','add_todos','move_todos','complete_todos','remove_todos'];
    const patch = {};
    for (const key of PATCHABLE) {
      if (req.body[key] !== undefined) patch[key] = req.body[key];
    }
    // An empty removal query is not a request to delete everything. The merge
    // rejects it now, but the MCP path filters falsy entries before sending and
    // this one did not, so the two surfaces disagreed about what {remove_todos:['']}
    // meant. Drop them here too, so the difference cannot come back.
    if (Array.isArray(patch.remove_todos)) {
      patch.remove_todos = patch.remove_todos.filter((q) => String(q ?? '').trim());
      if (!patch.remove_todos.length) delete patch.remove_todos;
    }

    // Changing the task orphans its steps. They are DERIVED sub-steps of one
    // specific task, so once it changes they describe work nobody asked for —
    // and they render as board cards, which is how five phantom cards outlived
    // the task that produced them. An explicit task_steps in the same request
    // wins; this only fills the gap when the caller said nothing about them.
    // Reworded-but-identical tasks are left alone.
    if (patch.current_task !== undefined && patch.task_steps === undefined) {
      const currentTask = String(project.context?.current_task || '').trim();
      const nextTask = String(patch.current_task || '').trim();
      if (nextTask !== currentTask && (project.context?.task_steps || []).length) {
        patch.task_steps = [];
      }
    }

    if (Object.keys(patch).length === 0 && req.body.project_name === undefined) {
      return res.status(400).json({ error: 'no_patchable_fields' });
    }

    const oversized = oversizedPatchField(patch, project.context);
    if (oversized) {
      return res.status(400).json({
        error: 'field_too_long',
        field: oversized.field,
        length: oversized.length,
        max_length: CONTEXT_TEXT_MAX,
        message: `${oversized.field} holds a value of ${oversized.length} characters; the limit is ${CONTEXT_TEXT_MAX}. Nothing was saved — shorten it and resend.`,
      });
    }

    // Allow renaming the project directly
    if (req.body.project_name && typeof req.body.project_name === 'string') {
      const name = req.body.project_name.trim().slice(0, 120);
      if (name) {
        // store.renameProject is scoped by owner_key alone, so without this any
        // project id in the workspace could be renamed, whatever its visibility
        // or the caller's role. Throws project_not_found / share_write_forbidden.
        // Renaming is the author's or a workspace owner's, not any member's who
        // may edit the sections: assertProjectRenamable.
        await service.assertProjectRenamable(req.actor, req.params.projectId);
        // A rename advances the version (a tab that read before it is refused
        // on its next guarded save). When fields follow in this same request,
        // their write advances it, guarded on the version the caller sent;
        // advancing it here first would refuse that write.
        await store.renameProject(req.actor, req.params.projectId, name, {
          advanceVersion: Object.keys(patch).length === 0,
        });
      }
    }

    // Only call updateProjectContext if there are context fields to patch
    if (Object.keys(patch).length > 0) {
      // skip_unwritable_derived: OPT-IN, for a completion (the local server's
      // finish_task). A completion's side effects the caller may not edit are
      // skipped and named in `skipped_sections` instead of refusing the write;
      // see DERIVED_COMPLETION_FIELDS. Without the flag — every older client —
      // the write is exactly as strict as before.
      const updated = await service.updateProjectContext(req.actor, req.params.projectId, patch, {
        skipUnwritableDerived: req.body.skip_unwritable_derived === true,
        ...(expected.value !== null ? { expectedContextVersion: expected.value } : {}),
      });
      // WHICH FIELDS THE SERVER WOULD NOT TAKE, WHERE A CALLER LOOKS FOR THEM.
      //
      // The list was not lost: serializeProjectFull passes everything but the
      // event log through, so `refused` arrived nested INSIDE the project
      // resource — which is not where it belongs and not where anybody reads
      // it. It describes this request, not the project, and no client has ever
      // reached for project.refused. So a declined write answered 200 with the
      // old value and, as far as every consumer was concerned, no reason: the
      // failure `refused` was added to updateProjectContext to end.
      //
      // Additive on both counts — the nested copy stays, and a write with
      // nothing refused still answers with `project` alone.
      const refused = Array.isArray(updated?.refused) ? updated.refused : [];
      // The STORED project, and a flag when storage redaction changed what the
      // caller SENT. Sent only when true (as /extraction does), so a write with
      // nothing to redact answers exactly as before; `project.context` carries
      // the stored, masked values either way.
      const stored = asStoredProject(updated);
      const redactedFields = redactedPatchFields(patch, refused, stored?.context);
      const skippedSections = Array.isArray(updated?.skipped_sections) ? updated.skipped_sections : [];
      // WHO WROTE, ON RECORD (journey r7): a dashboard or REST write left no
      // per-person record, which is what a project whose author stamp stops
      // resolving is judged from (services/authorStampService.js).
      logContextAudit(req.actor, 'context_write', { project_id: req.params.projectId, actor_type: 'user' });
      return res.json({
        project: serializeProjectFull(stored),
        ...(refused.length ? { refused } : {}),
        ...(skippedSections.length ? { skipped_sections: skippedSections } : {}),
        ...(redactedFields.length ? { redacted: true, redacted_fields: redactedFields } : {}),
      });
    }
    // Rename-only: re-fetch and return the project
    const refreshed = await service.getProject(req.actor, req.params.projectId);
    return res.json({ project: serializeProjectFull(refreshed) });
  } catch (err) {
    if (err?.message === 'project_not_found') return res.status(404).json({ error: 'project_not_found' });
    if (err?.code === 'stale_context_version') return respondStaleContextVersion(res, err);
    if (err?.code === 'share_write_forbidden') {
      logContextAudit(req.actor, 'context_write_blocked', {
        project_id: req.params.projectId,
        actor_type: 'user',
        reason: 'share_write_forbidden',
        blocked_fields: err.blocked_fields || [],
      });
      // respondWriteForbidden, not a hand-built body: this handler dropped
      // err.publicMessage, so the refusal reached the dashboard as the bare
      // token `share_write_forbidden` with no explanation of WHICH section was
      // read-only — and every dashboard write surface turned that into
      // "Couldn't save that change", which reads as a transient glitch.
      if (respondWriteForbidden(res, err)) return;
    }
    next(err);
  }
}

router.patch('/:projectId/context', requireContextWrite, patchProjectContextHandler);
// Backward-compatible alias used by older MCP clients.
router.patch('/projects/:projectId/context', requireContextWrite, patchProjectContextHandler);

// ─── Delete a project (and its graph nodes / events) ────────────────────────
router.delete('/projects/:projectId', requireContextWrite, async (req, res, next) => {
  try {
    // Resolve through the MUTABILITY guard, not the read path. getProject answers
    // "may this person read it", and on a shared workspace a viewer, or any member
    // who is not the author, can read a project they have no business deleting.
    // Archive, rename and reparent already go through assertProjectMutable; a
    // delete, the one irreversible action, was the one that did not.
    let project;
    try {
      project = await service.assertProjectMutable(req.actor, req.params.projectId, 'delete');
    } catch (err) {
      if (err?.message === 'project_not_found') return res.status(404).json({ error: 'project_not_found' });
      if (respondWriteForbidden(res, err)) return undefined;
      throw err;
    }
    const deleted = await store.deleteProject(req.actor, req.params.projectId);
    if (!deleted) return res.status(404).json({ error: 'project_not_found' });
    logContextAudit(req.actor, 'project_deleted', {
      project_id: req.params.projectId,
      project_name: project.project_name,
      // Who could read it when it existed. The project is gone after this line,
      // so GET /audit has nothing else to judge this row by — see
      // service.auditScopeForActor.
      visibility: project.visibility || null,
      actor_type: 'user',
    });
    return res.json({ success: true, deleted: req.params.projectId });
  } catch (err) { next(err); }
});

// A question is stored redacted, so the text a caller pastes back — carrying the
// key in clear — never matched the question it quotes, and the refusal echoed
// the key. Match as sent first (a row written before storage redaction still
// holds the clear text), then as it would have been stored. PARITY: the hosted
// resolve_open_question in routes/mcp.js does the same.
async function resolveQuestionAsStored(actor, projectId, question, answer) {
  const outcome = await service.resolveQuestion(actor, projectId, question, answer);
  if (outcome.reason !== 'unmatched') return outcome;
  const masked = store.redactForStorage(question);
  if (masked === question) return outcome;
  return service.resolveQuestion(actor, projectId, masked, answer);
}

// ─── Resolve a question — removes from open_questions, adds to decisions ─────
//
// The narrow, non-destructive counterpart to cleanup_context: it retires ONE
// question and leaves the task, the command log, the task steps and the other
// questions exactly as they were. It resolves a single question or none at all,
// so an ambiguous query comes back as 409 with the candidates rather than
// resolving the closest guess, and a query that matches nothing comes back as
// 404 rather than a 200 that recorded a decision about a question the brief
// never held.
router.post('/projects/:projectId/questions/resolve', requireContextWrite, async (req, res, next) => {
  try {
    const { question, answer } = req.body;
    if (!question || typeof question !== 'string' || !answer || typeof answer !== 'string') {
      return res.status(400).json({ error: 'question and answer are required strings' });
    }
    // Whitespace-only passes the guard above but trims to '', which the old
    // substring filter matched against every question in the list.
    if (!question.trim() || !answer.trim()) {
      return res.status(400).json({ error: 'question and answer are required strings' });
    }
    const outcome = await resolveQuestionAsStored(req.actor, req.params.projectId, question.trim(), answer.trim());
    // Quoted back as STORED: the question a caller pastes may carry a key the
    // brief holds masked, and a refusal is no reason to hand it back in clear.
    const asked = store.redactForStorage(question.trim());
    if (outcome.reason === 'ambiguous') {
      return res.status(409).json({
        error: 'question_ambiguous',
        message: `"${asked}" matches ${outcome.candidates.length} open questions, so nothing was resolved. Re-send the exact, complete question text.`,
        candidates: store.redactForStorage(outcome.candidates),
      });
    }
    if (outcome.reason === 'unmatched') {
      return res.status(404).json({
        error: 'question_not_found',
        message: `No open question matches "${asked}".`,
      });
    }
    logContextAudit(req.actor, 'context_write', { project_id: req.params.projectId, actor_type: 'user' });
    return res.json({ project: serializeProjectFull(asStoredProject(outcome.project)), resolved: store.redactForStorage(outcome.resolved) });
  } catch (err) {
    if (err?.message === 'project_not_found') return res.status(404).json({ error: 'project_not_found' });
    if (respondWriteForbidden(res, err)) return undefined;
    next(err);
  }
});

// ─── Resolve ONE decision in this project's brief ────────────────────────────
//
// What mark_resolved does when the caller names the project, for the local stdio
// server (the hosted dispatcher calls the service in-process). The decision log
// is per project and the graph node is not — a decision recorded in two repos is
// one node filed under the first — so the resolve is applied to THIS project's
// brief by the decision's own text, never through the node (see
// service.resolveProjectDecision). 200 with the outcome and the words to reply
// with, for every outcome including "nothing was resolved": ambiguous and
// not_found are answers the caller acts on, not failures.
router.post('/projects/:projectId/decisions/resolve', requireContextWrite, async (req, res, next) => {
  try {
    const { title, notes, untyped } = req.body || {};
    if (typeof title !== 'string' || !title.trim() || title.length > 20000) {
      return res.status(400).json({ error: 'title is required: the complete text of the decision' });
    }
    if (notes !== undefined && notes !== null && typeof notes !== 'string') {
      return res.status(400).json({ error: 'notes must be a string' });
    }
    // `untyped`: the caller's mark_resolved named no entity_type, so an open task
    // (or other entity) with the same text is weighed before any decision.
    const outcome = await service.resolveProjectDecision(req.actor, req.params.projectId, {
      title,
      notes: notes || undefined,
      untyped: untyped === true,
    });
    // The project CHANGED, which is not the one named when a parent's resolve
    // landed in its subproject (outcome.project_id is where it was applied).
    if (outcome.outcome === 'resolved') logContextAudit(req.actor, 'context_write', { project_id: outcome.project_id || req.params.projectId, actor_type: 'user' });
    return res.json(outcome);
  } catch (err) {
    if (err?.message === 'project_not_found') return res.status(404).json({ error: 'project_not_found' });
    if (respondWriteForbidden(res, err)) return undefined;
    if (err?.publicMessage) return res.status(400).json({ error: err.message, message: err.publicMessage });
    next(err);
  }
});

// ─── Search endpoint — cross-project context search ──────────────────────────

// The candidate list, the matcher and the scoring are contextSearchService's —
// shared with the hosted `search_context` handler so the two cannot drift again.
// `project_id`, `cwd` and `workspace_key` are optional: they only decide which
// project's hits get the active-project boost.
router.post('/search', async (req, res, next) => {
  try {
    const { query, limit = 5, project_id: projectId, cwd, workspace_key: workspaceKey } = req.body || {};
    if (!query || typeof query !== 'string' || query.length < 2) {
      return res.status(400).json({ error: 'query required' });
    }
    const { results } = await contextSearch.searchContext(req.actor, {
      query,
      limit,
      project_id: typeof projectId === 'string' ? projectId : undefined,
      cwd: typeof cwd === 'string' ? cwd : undefined,
      workspace_key: typeof workspaceKey === 'string' ? workspaceKey : undefined,
    });
    return res.json({ results });
  } catch (err) { next(err); }
});

// ─── Where the caller is, without putting it in the URL ──────────────────────
// `cwd`, the machine's `host` name and the repo's `workspace_key` used to arrive
// only as query parameters on these GETs. A query string is the one part of a
// request that every hop writes down: the load balancer's access log, the proxy,
// APM traces, error reports. So a user's home directory, their hostname and their
// private git remote were being copied into log retention on every tool call.
//
// The MCP client now sends them as headers, URI-encoded (a header cannot carry
// the non-ASCII characters a path can). The query parameters are still read, so
// every client already installed keeps working unchanged; the header wins when
// both are present. `X-DeerDawn-Location: header` on the response tells a new
// client its headers were understood — a client that does not see it is talking
// to an older API and falls back to the query string rather than silently
// resolving the wrong project.
//
// Not to be confused with `x-deerdawn-workspace`, which selects the TEAM
// workspace in the auth middleware. `x-deerdawn-workspace-key` is the repo
// identity (git remote / root name) used to rank projects.
const LOCATION_HEADERS = {
  cwd: 'x-deerdawn-cwd',
  host: 'x-deerdawn-host',
  workspace_key: 'x-deerdawn-workspace-key',
};
const LOCATION_VALUE_MAX = 4096;

function readLocationParam(req, res, name) {
  const raw = req.headers[LOCATION_HEADERS[name]];
  const headerValue = Array.isArray(raw) ? raw[0] : raw;
  if (typeof headerValue === 'string' && headerValue.length > 0 && headerValue.length <= LOCATION_VALUE_MAX * 3) {
    let decoded = headerValue;
    // A malformed escape is used as sent rather than rejected: a wrong cwd costs
    // a missed match, and failing the whole brief over it would cost the session.
    try { decoded = decodeURIComponent(headerValue); } catch { /* keep raw */ }
    res.setHeader('X-DeerDawn-Location', 'header');
    return decoded.slice(0, LOCATION_VALUE_MAX);
  }
  const queryValue = req.query[name];
  return queryValue ? String(queryValue) : null;
}

// ─── Map endpoint — returns compact multi-project index (Tier 1) ──────────────

router.get('/map', async (req, res, next) => {
  try {
    const projects = await service.listProjects(req.actor);
    const globalCtx = await service.getGlobalContext(req.actor).catch(() => null);
    const mcpAvailable = req.query.mcp === 'true' || req.headers['x-deerdawn-mcp'] === '1';
    const cwd = readLocationParam(req, res, 'cwd');
    const workspaceKey = readLocationParam(req, res, 'workspace_key');

    // Find the CWD-matched project so the map can mark it with →. Use the SAME
    // canonical scorer as resolveActiveProject (cwd + workspace) so the map's →
    // marker and the brief's active project can't disagree. The >= 1.0 floor keeps
    // the → marker to real path/workspace matches, not name/recency guesses.
    let activeProjectId = null;
    if ((cwd || workspaceKey) && projects?.length) {
      const scored = projects
        .map(p => ({ id: p.project_id, score: service.scoreProjectForCwd(p, cwd, workspaceKey) }))
        .sort((a, b) => b.score - a.score);
      if (scored[0]?.score >= 1.0) activeProjectId = scored[0].id;
    }

    // Stamp the current time fresh per request (never cached) + the client's tz so
    // the assistant always knows "what time is it" — a constant web-chat annoyance.
    const tz = req.query.tz ? String(req.query.tz) : null;
    const now = new Date().toISOString();
    // T2.3 — rank by relevance (workspace siblings + cwd, then recency) using the
    // canonical scorer, so the brief's "Other projects" surfaces this workspace's
    // work-streams instead of unrelated recently-touched projects from other repos.
    // formatMapInjection shows the top of the passed order, so reordering here is
    // enough; line format is unchanged, so the start_session strip stays byte-stable.
    const rankedProjects = (cwd || workspaceKey) && projects?.length
      ? [...projects].sort((a, b) => service.scoreProjectForCwd(b, cwd, workspaceKey) - service.scoreProjectForCwd(a, cwd, workspaceKey))
      : (projects || []);
    const map = formatMapInjection(rankedProjects, globalCtx, { mcpAvailable, activeProjectId, now, tz });
    return res.json({ map, project_count: (projects || []).length, active_project_id: activeProjectId });
  } catch (err) { next(err); }
});

// One-line "what DeerDawn did for you this week" — appended to the brief on a
// real session start so every return delivers felt value in the IDE, not just a
// task list. Best-effort: callers wrap it so a failure never affects the brief.
function buildWeeklyReceiptLine(activity) {
  if (!activity) return null;
  const parts = [];
  if (activity.context_delivered > 0) parts.push(`${activity.context_delivered} context loads`);
  if (activity.decisions_captured > 0) parts.push(`${activity.decisions_captured} decisions captured`);
  if (activity.projects_touched > 0) parts.push(`${activity.projects_touched} projects active`);
  if (!parts.length) return null;
  return `This week DeerDawn delivered ${parts.join(', ')} for you.`;
}

router.get('/active', maskSecretsInResponse, async (req, res, next) => {
  try {
    const startedAt = Date.now();
    const VALID_TOOLS = ['claude_web', 'chatgpt_web', 'gemini', 'perplexity', 'cursor', 'claude_code', 'codex'];
    const VALID_VERBOSITIES = ['light', 'standard', 'detailed'];
    const tool = VALID_TOOLS.includes(String(req.query.tool)) ? String(req.query.tool) : 'claude_code';
    const verbosity = VALID_VERBOSITIES.includes(String(req.query.verbosity)) ? String(req.query.verbosity) : 'standard';
    const cwd = readLocationParam(req, res, 'cwd');
    const workspaceKey = readLocationParam(req, res, 'workspace_key');
    const host = readLocationParam(req, res, 'host');
    const rawSections = req.query.sections ? String(req.query.sections) : null;

    // A caller about to WRITE says so (purpose=write) and is never handed a
    // project that matched on its name alone — see resolveActiveProject. Every
    // other call is a read and may be shown the guess, flagged below.
    const forWrite = String(req.query.purpose) === 'write';
    const active = await service.resolveActiveProject(req.actor, cwd, workspaceKey, { forWrite });
    if (!active) {
      // Keep format=json total: a caller asking for structured context must always
      // get the {context} envelope, even when nothing resolved. Falling through to
      // the brief payload here would hand back a differently-shaped body for the
      // no-project case and put the shape-guessing back on the client.
      if (String(req.query.format) === 'json') return res.json({ context: null });
      const globalCtx = await service.getGlobalContext(req.actor);
      const brief = globalCtx
        ? `${globalCtx.user_profile ? `About: ${globalCtx.user_profile}` : ''}`.trim() || null
        : null;
      // Nothing matched this location. The projects this person most plausibly
      // meant ride along, so a hook can say "none matched; it is probably one of
      // these" instead of leaving the agent to assume there is no memory at all.
      const alternatives = (await service.listRoutingAlternatives?.(req.actor, null, 3)) || [];
      return res.json({ brief, project_name: null, project_id: null, last_updated: null, alternatives });
    }

    // format=json — the raw structured context for the CWD-resolved project, in
    // exactly the shape `/projects/:id/inject?format=json` returns.
    //
    // The MCP client has always sent this param here (client.ts getContextJson
    // with no projectId), but the route never implemented it: the request fell
    // through to the brief payload below, which has no `context` object at all.
    // Anything reading structured fields off it — manage_todos reading
    // todo_items, most visibly — silently saw nothing and reported an empty
    // board. Shapes must match inject's, or callers need two code paths again.
    if (String(req.query.format) === 'json') {
      const project = await service.getProject(req.actor, active.project_id);
      if (!project) return res.status(404).json({ error: 'project_not_found' });
      return res.json({
        context: {
          project_id: project.project_id,
          project_name: project.project_name,
          updated_at: project.updated_at,
          // Same shape as the by-id read above; see the note there.
          context_version: Number.isFinite(project.context_version) ? project.context_version : null,
          ...project.context,
        },
      });
    }

    if (rawSections) {
      const sections = rawSections.split(',').map(s => s.trim()).filter(s => VALID_SECTIONS.has(s));
      const project = await service.getProject(req.actor, active.project_id);
      if (!project) return res.status(404).json({ error: 'project_not_found' });
      const globalCtx = await service.getGlobalContext(req.actor).catch(() => null);
      // Same window, same sentence, same condition as the by-id read above and
      // the hosted one. Three reads of one project must not disagree about what
      // the plan remembers.
      const windowed = await service.applyPlanHistoryWindow(req.actor, project.context || {});
      const sectionBody = formatSectionInjection(windowed.context || {}, sections, globalCtx);
      const agedOut = service.sectionsTouchHistoryWindow(sections)
        ? service.formatAgedOutLine(windowed)
        : null;
      const body = agedOut ? `${sectionBody}\n${agedOut}` : sectionBody;
      return res.json({ brief: body, project_name: active.project_name, project_id: active.project_id, last_updated: active.updated_at });
    }

    // Brief shape is OPT-IN. ?shape=spine (or ?format=brief) renders the 4-slot
    // brief TEXT body; default (no param) keeps the current text shape unchanged.
    // The structured brief_spine is attached either way.
    const briefShape = String(req.query.shape) === 'spine' || String(req.query.format) === 'brief';
    // A person reading this route (the dashboard) records nothing a tool's
    // session does: no delivery, no session load, no tool session row. See
    // renderedForTool. The parameters below cannot opt a person back in.
    const forTool = renderedForTool(req.actor);
    const payload = await service.renderInjection(req.actor, active.project_id, tool, verbosity, null, {
      matchKind: active.match_kind,
      matchedPath: active.matched_path,
      now: new Date().toISOString(),
      tz: req.query.tz ? String(req.query.tz) : null,
      ...(briefShape ? { shape: 'spine' } : {}),
      record_side_effects: forTool,
    });
    // Cross-connection dedup: only the start_session TOOL marks (it passes
    // mark_session=1). The SessionStart hook hits this same endpoint passively
    // and must NOT mark, so a single-connection session still gets the full
    // brief. When a second connection (e.g. claude.ai connector + local MCP)
    // loads the same project within the window, recently_loaded lets the caller
    // return a compact pointer instead of repeating the brief.
    const markSession = forTool && (String(req.query.mark_session) === '1' || String(req.query.mark_session) === 'true');
    // The calling process's own id (the local server's per-process agent id),
    // null for a person. Declared here because the dedup reads it too: it is
    // what tells the same process loading twice from another process of the
    // same tool, which each need the brief. See checkAndMarkSessionLoad.
    const agentSessionId = forTool && req.query.session_id ? String(req.query.session_id).slice(0, 128) : null;
    const dedup = markSession
      ? await checkAndMarkSessionLoad(req.actor, active.project_id, tool, { sessionId: agentSessionId })
      : { duplicate: false, secondsAgo: null, otherSurface: null };
    // Day-two catch-up: on a REAL session start (marked, not a cross-connection
    // duplicate), record the session durably and compute what changed since the
    // previous one. Strictly additive to the brief and best-effort — the service
    // returns null on any failure. Duplicates are excluded so a second connector
    // racing at session start never inflates session_number.
    // `tool` is a RENDERING profile, and the local server defaults a client it
    // cannot place (Windsurf, Zed, …) to claude_code so something can render.
    // It says so with tool_identified=0, and the session row then names no tool
    // ('unknown'), so the next catch-up never says "in Claude Code" on a guess.
    const toolUnidentified = String(req.query.tool_identified) === '0';
    const catchup = (markSession && !dedup.duplicate)
      ? await buildSessionCatchup(req.actor, active, tool, {
        transport: connectionIdentity.sessionTransport(req.actor, req.query.session_id ? String(req.query.session_id) : null),
        ...(toolUnidentified ? { loadTool: 'unknown' } : {}),
      })
      : null;
    // ── Multi-agent presence ────────────────────────────────────────────────
    // The local coding-agent path (Claude Code / Cursor / Codex) never recorded a
    // context_sessions row: sessions were only written by the web surfaces via
    // /extraction and /match. So the table modelled every surface EXCEPT the one
    // where two agents actually collide. Recording here closes that, and doing it
    // on every call — not just marked ones — means a long session stays live
    // without a heartbeat of its own.
    //
    // Best-effort throughout: coordination is additive, and a presence failure
    // must never cost someone the brief they came for.
    // Cost discipline, matching this file's existing convention that passive polls
    // don't pay a real session start's price: a REAL start (mark_session) does the
    // full read-then-upsert, since it is establishing the row and this endpoint is
    // already doing far heavier work. Every other call takes the one-query
    // primary-key touch instead. Liveness therefore stays accurate for an agent
    // that only ever reads, which is precisely the agent presence needs to see —
    // it is still editing files even when it writes no memory. `agentSessionId`
    // is declared above, with the dedup call.
    let presence = [];
    if (agentSessionId) {
      try {
        if (markSession) {
          await service.upsertSession(req.actor, agentSessionId, {
            tool,
            // A session is BOUND only to a project that may receive its writes.
            // The binding is what a later write with no project_id follows, so
            // binding on a name guess turned "shown as a best guess" into "every
            // capture from this session is filed there". undefined leaves
            // whatever binding the session already had.
            project_id: active.write_target === false ? undefined : active.project_id,
            cwd: cwd || undefined,
            host: host ? host.slice(0, 200) : undefined,
            status: 'active',
          });
        } else {
          // Same rule as the bind above: a passive poll refreshes liveness, and
          // re-points the session only at a project that may receive its writes.
          await service.touchSession(req.actor, agentSessionId, active.write_target === false ? null : active.project_id);
        }
        presence = await service.getProjectPresence(req.actor, active.project_id, agentSessionId);
      } catch (err) {
        console.warn('[CONTEXT] presence failed:', err.message);
        presence = [];
      }
    }

    let brief = payload?.body ?? null;
    // The presence BLOCK is rendered only when a peer exists, so a solo session —
    // the overwhelming majority — pays exactly zero tokens for this feature. It is
    // appended to the brief rather than replacing anything, and it states a fact
    // without instructing: enforcement is the model's call, not ours.
    if (brief && presence.length) {
      try {
        const block = formatPresenceBlock(presence);
        if (block) brief = `${brief}\n\n${block}`;
      } catch { /* presence is decoration on a working brief */ }
    }
    // A capture from an earlier session was filed in this project because the
    // project that session was bound to has since been archived (or is no longer
    // shared with the caller): said once, on a real start, with how to restore
    // it or pick another (journey r5). The read clears it.
    if (brief && markSession && !dedup.duplicate) {
      try {
        const deadBindingNote = await service.takeDeadBindingNotice(req.actor, active.project_id);
        if (deadBindingNote) brief = `${deadBindingNote}\n\n${brief}`;
      } catch { /* a note about where a capture went never costs the brief */ }
    }
    // Value receipt on a real session start (mark_session) — one weekly line in
    // the user's own habitat (the IDE). Gated to real starts so passive polls
    // don't pay the extra query, and best-effort so it can never break the brief.
    if (brief && markSession && !dedup.duplicate) {
      try {
        const activity = await computeWorkspaceActivity(req.actor, 7);
        const receipt = buildWeeklyReceiptLine(activity);
        if (receipt) brief = `${brief}\n${receipt}`;
      } catch { /* value receipt is non-critical */ }
    }

    // The session-start CARD — the one artefact rendered for the human rather than
    // the model (see packages/shared-context/src/briefCard.js). Rendered here, not
    // in the MCP server, because the MCP server updates on the user's schedule and
    // this needs to be able to improve without anyone reinstalling anything.
    //
    // Same gate as the receipt: real session starts only. A duplicate load already
    // showed the card moments ago, and a passive poll has no human watching.
    let card = null;
    if (markSession && !dedup.duplicate) {
      try {
        const totals = await computeMemoryTotals(req.actor).catch(() => null);
        const ctx = active.context || {};
        card = buildBriefCard({
          projectName: active.project_name,
          lastUpdated: active.updated_at,
          catchup,
          spine: payload?.brief_spine ?? null,
          totals,
          nextAction: ctx.next_action || ctx.current_task || null,
          // Session one has no prior state to report, so the card sets an
          // expectation instead of rendering rows about a gap that never happened.
          isFirstSession: !brief || (catchup ? catchup.session_number <= 1 : false),
        });
      } catch (err) {
        // The card is decoration on top of a working brief — never let it 500 a
        // session start. Log so a silent disappearance is diagnosable.
        console.warn('[CONTEXT] brief card render failed:', err.message);
      }
    }
    // Logged after the receipt so total_ms reflects the real session-start cost.
    console.log('[CONTEXT] /active timing', JSON.stringify({
      project_id: active?.project_id || null,
      tool,
      match_kind: active.match_kind || null,
      recently_loaded: dedup.duplicate,
      total_ms: Date.now() - startedAt,
    }));
    return res.json({
      brief,
      // Pre-rendered session-start card for the HUMAN (opaque string, box-drawn,
      // ~52 cols). Consumers print it verbatim and print nothing when it's null.
      // Never parse it — the shape is ours to change.
      card,
      // Day-two catch-up (additive): session ordinal, gap phrasing, the
      // since-last-session delta, and a pre-rendered compact text block. null on
      // passive polls, duplicates, first sessions, and any computation failure.
      catchup,
      // Structured 4-slot brief (Phase A) — additive, attached regardless of the
      // text shape so dashboard/MCP consumers can read it without the opt-in param.
      brief_spine: payload?.brief_spine ?? null,
      // The receipt line (shared-context formatBriefReceipt): "DeerDawn loaded
      // {Project}: …". Kept out of `brief` because the brief is written to disk
      // and dedup-compared byte for byte; a consumer prints it FIRST, above the
      // brief. Data, not an instruction. null when nothing rendered.
      receipt: payload?.receipt ?? null,
      project_name: active.project_name,
      project_id: active.project_id,
      last_updated: active.updated_at,
      match_kind: active.match_kind || null,
      matched_path: active.matched_path || null,
      // How far the match can be trusted, so a consumer does not have to keep its
      // own list of which kinds are guesses. write_target:false means "show it,
      // do not file anything there without the user naming the project".
      match_confidence: active.match_confidence || null,
      write_target: active.write_target !== false,
      // A low-confidence answer names the likely alternatives (ids included), so
      // the consumer can offer a one-call correction rather than a guess to be
      // used as-is. Empty for a confident match: nothing is guessed there.
      alternatives: active.match_confidence === 'low' || active.match_guessed
        ? ((await service.listRoutingAlternatives?.(req.actor, active.project_id, 3)) || [])
        : [],
      match_guessed: Boolean(active.match_guessed),
      // Anchored findings (commit_ref) so the MCP can check, git-side, whether each
      // fix is still in the working tree's history and flag rebased-away anchors as
      // "re-verify" — turning a stored claim from "locatable" into "replayable".
      anchored_commits: (active.context?.debugging_notes || [])
        .filter((d) => d && d.commit_ref)
        .slice(-5)
        .map((d) => ({ ref: String(d.commit_ref), summary: d.summary })),
      recently_loaded: dedup.duplicate,
      recently_loaded_seconds_ago: dedup.secondsAgo,
      recently_loaded_other_surface: dedup.otherSurface,
      // Structured peers, so a consumer can mirror them locally (the PreToolUse
      // hook) instead of parsing the rendered block. Empty array when solo.
      presence,
      presence_window_seconds: PRESENCE_WINDOW_SECONDS,
      // The watermark this brief was cut at. A later call compares it against the
      // project's current updated_at to tell the agent its brief has gone stale —
      // no new round-trip, because the comparison rides on a row already loaded.
      brief_watermark: active.updated_at || null,
    });
  } catch (err) { next(err); }
});

// P3 — the in-page topic confirm chip reads this on load: the session's bound
// topic (+ a fresh brief to inject) and the user's topics as switch candidates.
router.get('/session/topic', async (req, res, next) => {
  try {
    const result = await service.getSessionTopic(req.actor, {
      session_id: req.query.session_id ? String(req.query.session_id) : null,
      tool: req.query.tool ? String(req.query.tool) : 'claude_web',
    }, { tz: req.query.tz ? String(req.query.tz) : null });
    return res.json(result);
  } catch (err) { next(err); }
});

// P3 — the chip's "confirm / switch / new topic" action binds the session.
router.post('/session/topic', requireContextWrite, async (req, res, next) => {
  try {
    const sessionId = req.body?.session_id ? String(req.body.session_id) : '';
    const projectId = req.body?.project_id ? String(req.body.project_id) : null;
    const newTopicName = req.body?.new_topic_name ? String(req.body.new_topic_name).trim() : null;
    if (!sessionId) return res.status(400).json({ error: 'session_id_required' });
    if (!projectId && !newTopicName) return res.status(400).json({ error: 'project_id_or_new_topic_name_required' });
    const bound = await service.bindSessionTopic(req.actor, {
      session_id: sessionId,
      project_id: projectId,
      new_topic_name: newTopicName,
      conversation_ref: req.body?.conversation_ref ? String(req.body.conversation_ref) : '',
      host: req.body?.host ? String(req.body.host) : '',
      tool: req.body?.tool ? String(req.body.tool) : 'claude_web',
    });
    return res.json(bound);
  } catch (err) {
    // "New topic" from the confirm chip creates a project, so the workspace cap
    // can fire here too — same upgrade-aware shape as POST /projects.
    if (err?.message === 'project_limit_exceeded') {
      return res.status(err.status || 422).json({
        error: 'project_limit_exceeded',
        upgrade_required: true,
        message: err.publicMessage,
      });
    }
    next(err);
  }
});

router.get('/workspace/overview', async (req, res, next) => {
  try {
    const parsed = WorkspaceOverviewQuerySchema.parse(req.query);
    const include = parsed.include
      ? parsed.include.split(',').map((value) => value.trim()).filter(Boolean)
      : undefined;
    const overview = await service.getWorkspaceOverview(req.actor, {
      mode: parsed.mode,
      verbosity: parsed.verbosity,
      include,
    });
    if (parsed.format === 'json') {
      return res.json({ overview });
    }
    return res.json({ overview, text: overview.text || formatWorkspaceOverview(overview, parsed.verbosity) });
  } catch (err) { next(err); }
});

router.get('/workspace/entities', async (req, res, next) => {
  try {
    const parsed = WorkspaceEntitiesQuerySchema.parse(req.query);
    const types = parsed.types
      ? parsed.types.split(',').map((value) => value.trim()).filter(Boolean)
      : undefined;
    const entities = await service.getWorkspaceEntities(req.actor, {
      types,
      query: parsed.query,
      project_id: parsed.project_id,
      related_project_id: parsed.related_project_id,
      scope: parsed.scope,
      surface: parsed.surface,
      status: parsed.status,
      include_inferred: parsed.include_inferred,
      include_resolved: parsed.include_resolved,
      curated_only: parsed.curated_only,
      limit: parsed.limit,
    });
    if (parsed.format === 'json') {
      return res.json({ entities });
    }
    const text = entities.length
      // Title alone when there is no summary, never the internal key (see the
      // hosted get_workspace_entities; the local dispatcher prints this text).
      ? entities.map((node) => `- ${node.title}${node.summary ? `: ${node.summary}` : ''}`).join('\n')
      : 'No workspace entities found.';
    return res.json({ entities, text });
  } catch (err) { next(err); }
});

router.post('/workspace/entities', requireContextWrite, contextHeavyLimiter, async (req, res, next) => {
  try {
    const parsed = WorkspaceEntitiesUpsertSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
    }
    const result = await service.upsertWorkspaceEntities(req.actor, parsed.data);
    return res.json(result);
  } catch (err) {
    if (respondWorkspaceEntityError(res, err)) return undefined;
    // This is the route the LOCAL stdio MCP server posts to, so it carries the
    // same refusals /graph/nodes does and must answer in the same shapes: 404
    // for anything the caller cannot see (a 403 would confirm the id exists),
    // 403 for something they can see and may not change. Without these they fell
    // through the catch-all as 500s and read as server defects.
    if (err?.message === 'project_not_found' || err?.message === 'node_not_found') {
      return res.status(404).json({ error: err.message });
    }
    if (respondWriteForbidden(res, err)) return undefined;
    next(err);
  }
});

router.post('/events', requireContextWrite, contextHeavyLimiter, async (req, res, next) => {
  try {
    const parsed = ContextEventIngestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
    }
    const result = await service.applyStructuredContextEvent(req.actor, parsed.data);
    if (result?.project_id) {
      logContextAudit(req.actor, 'context_write', {
        project_id: result.project_id,
        actor_type: 'user',
        tool: result.source_tool || null,
        event_type: result.event_type,
      });
    }
    return res.status(202).json(result);
  } catch (err) {
    if (err?.message === 'project_not_found') return res.status(404).json({ error: 'project_not_found' });
    // A hot_path_discovered / debug_finding event into a section the share
    // does not let this caller read is refused by the same gate as the direct
    // routes, and answers the same 403 with the section named.
    if (respondWriteForbidden(res, err)) return;
    next(err);
  }
});

router.get('/workspace/next', async (req, res, next) => {
  try {
    const headerCwd = req.headers[LOCATION_HEADERS.cwd] ? readLocationParam(req, res, 'cwd') : null;
    const parsed = NextBestContextQuerySchema.parse(headerCwd ? { ...req.query, cwd: headerCwd } : req.query);
    const result = await service.getNextBestContext(req.actor, parsed);
    return res.json({ result });
  } catch (err) { next(err); }
});

// Task-scoped context package for an orchestrator to pass to a worker agent.
// POST is used because the objective and acceptance criteria can be longer than
// a practical query string; the operation remains read-only and idempotent.
router.post('/subagent-brief', async (req, res, next) => {
  try {
    const parsed = SubagentBriefRequestSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
    }
    const result = await service.buildSubagentBrief(req.actor, parsed.data);
    logContextAudit(req.actor, 'subagent_brief_read', {
      project_id: result.project_id,
      tool: String(req.body?.tool || 'unknown'),
      actor_type: 'user',
      estimated_tokens: result.estimated_tokens,
      omitted_count: result.omitted_count,
    });
    recordProductEvent(req.actor, {
      event_name: 'subagent_brief_built',
      source: 'api',
      surface: String(req.body?.tool || 'unknown'),
      metadata: {
        role: parsed.data.role || null,
        selected_source_count: result.sources.length,
        estimated_tokens: result.estimated_tokens,
        max_tokens: result.max_tokens,
        main_brief_estimated_tokens: result.main_brief_estimated_tokens,
        packaging_token_delta: result.packaging_token_delta,
        omitted_count: result.omitted_count,
      },
    }).catch(() => {});
    return res.json({ brief: result, text: result.text });
  } catch (err) {
    if (err?.message === 'project_not_found') return res.status(404).json({ error: 'project_not_found' });
    next(err);
  }
});

router.get('/projects/:projectId/map', async (req, res, next) => {
  try {
    const parsed = ProjectMapQuerySchema.parse(req.query);
    const result = await service.getProjectMap(req.actor, req.params.projectId, parsed.verbosity);
    if (!result) return res.status(404).json({ error: 'project_not_found' });
    if (parsed.format === 'json') return res.json({ project_map: result });
    return res.json({ project_map: result, text: result.text });
  } catch (err) { next(err); }
});

router.get('/workspace/known-paths', async (req, res, next) => {
  try {
    const parsed = KnownPathsQuerySchema.parse(req.query);
    const results = await service.findKnownPaths(req.actor, parsed);
    if (parsed.format === 'json') return res.json({ results });
    const text = results.length
      ? results.map((item) => {
        if (item.kind === 'debugging_note') {
          const fix = item.commit_ref || item.diff_ref;
          return `- [${item.project_name}] note: ${item.summary}${item.paths?.length ? ` [${item.paths.join(' | ')}]` : ''}${fix ? ` (fix: ${fix})` : ''}`;
        }
        if (item.kind === 'surface') {
          return `- [${item.project_name}] surface ${item.label}: ${(item.paths || []).join(' | ')}${item.purpose ? ` — ${item.purpose}` : ''}`;
        }
        return `- [${item.project_name}] ${item.kind} ${item.label}: ${item.path}${item.purpose ? ` — ${item.purpose}` : ''}`;
      }).join('\n')
      : 'No known paths found.';
    return res.json({ results, text });
  } catch (err) { next(err); }
});

router.post('/projects/:projectId/hot-paths', requireContextWrite, async (req, res, next) => {
  try {
    const parsed = RecordHotPathsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
    }
    const result = await service.recordHotPaths(req.actor, req.params.projectId, parsed.data.items);
    return res.json(result);
  } catch (err) {
    if (err?.message === 'project_not_found') return res.status(404).json({ error: 'project_not_found' });
    // respondWriteForbidden keeps err.publicMessage, which names the section
    // that is read-only; the hand-built body dropped it.
    if (respondWriteForbidden(res, err)) return;
    next(err);
  }
});

router.post('/projects/:projectId/debug-findings', requireContextWrite, async (req, res, next) => {
  try {
    const parsed = RecordDebugFindingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
    }
    const result = await service.recordDebugFinding(req.actor, req.params.projectId, parsed.data);
    return res.json(result);
  } catch (err) {
    if (err?.message === 'project_not_found') return res.status(404).json({ error: 'project_not_found' });
    // respondWriteForbidden keeps err.publicMessage, which names the section
    // that is read-only; the hand-built body dropped it.
    if (respondWriteForbidden(res, err)) return;
    next(err);
  }
});

// Verify primitive — an agent re-confirms a stored claim still holds; we stamp
// verified_at so the next session trusts it instead of re-checking.
router.post('/projects/:projectId/verify', requireContextWrite, async (req, res, next) => {
  try {
    const parsed = ConfirmClaimSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
    }
    const result = await service.confirmClaim(req.actor, req.params.projectId, parsed.data);
    return res.json(result);
  } catch (err) {
    if (err?.message === 'project_not_found') return res.status(404).json({ error: 'project_not_found' });
    // respondWriteForbidden keeps err.publicMessage, which names the section
    // that is read-only; the hand-built body dropped it.
    if (respondWriteForbidden(res, err)) return;
    next(err);
  }
});

const SeedProjectSchema = z.object({
  name: z.string().min(1).max(120),
  conversations: z.array(z.object({
    title: z.string().optional(),
    messages: z.array(z.object({
      role: z.string().min(1),
      text: z.string().min(1),
    })).min(1),
  })).min(1).max(50),
});

// `file_import` is what the Memory page's "Paste text" and "From file" tabs send
// (a document the person chose, not a chat transcript). It was missing here, so
// both tabs were refused with a 400 (journey scan round 4 BLOCKED 26). The route
// never reads `source` after this check, so every source is processed alike: a
// document goes through the same extraction as a conversation, and with no model
// answering, nothing from it is saved (see runExtractionForSeed).
const SeedRequestSchema = z.object({
  source: z.enum(['chatgpt_export', 'claude_export', 'paste', 'manual', 'file_import']),
  projects: z.array(SeedProjectSchema).min(1).max(30),
});

router.post('/seed', requireContextWrite, contextHeavyLimiter, async (req, res, next) => {
  try {
    const parsed = SeedRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
    }

    const { projects } = parsed.data;
    const { runExtractionForSeed } = require('../../services/extractionService');
    // not_processed: projects whose conversations no model processed. Nothing
    // from those conversations is saved (see buildSeedNotProcessed); each is
    // listed by the name it was sent under, never counted as created, so no
    // caller can read it as imported.
    const results = { projects_created: 0, projects_skipped: 0, not_processed: [], errors: [] };

    for (const proj of projects) {
      try {
        // Flatten all messages across conversations for this project
        const allChunks = proj.conversations.flatMap((c) =>
          c.messages.map((m) => ({ role: m.role, text: m.text }))
        );

        const extraction = await runExtractionForSeed(req.actor, proj.name, allChunks);

        if (extraction.no_material_change || extraction.match_decision === 'ignored') {
          results.projects_skipped++;
          continue;
        }

        const sessionId = `seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        if (extraction.not_processed) {
          // The project under the name the person gave, and nothing else: no
          // chunks, an empty delta. A retry finds it by name and fills it.
          const kept = await service.applyExtraction(req.actor, {
            session_id: sessionId,
            tool: 'claude_web',
            chunks: [],
            extraction,
            // An import names its project: the person gave the name, so it is the
            // identity here, not a model's guess about a conversation.
            merge_by_name: true,
          });
          results.not_processed.push({ project: proj.name, project_id: kept?.project?.project_id || null });
          continue;
        }

        const created = await service.applyExtraction(req.actor, {
          session_id: sessionId,
          tool: 'claude_web',
          chunks: allChunks.slice(0, 5),
          extraction,
          merge_by_name: true,
        });

        // applyExtraction returns null when nothing was persisted. Never report a
        // phantom success — the UI's "N projects imported" must match what landed,
        // or the user sees an empty Context Graph after a "successful" import.
        if (!created) {
          results.errors.push({ project: proj.name, error: 'not_persisted' });
          continue;
        }

        results.projects_created++;

        // Throttle between projects to avoid hammering the LLM
        if (projects.indexOf(proj) < projects.length - 1) {
          // Throttle between LLM calls in production; skip delay when no key (test/dev)
          if (process.env.ANTHROPIC_API_KEY) {
            await new Promise((r) => setTimeout(r, 600));
          }
        }
      } catch (err) {
        console.error('[SEED] Failed for project', proj.name, err.message);
        results.errors.push({ project: proj.name, error: err.message });
      }
    }

    return res.json({ status: 'ok', ...results, projects_not_processed: results.not_processed.length });
  } catch (err) { next(err); }
});

// ─── /graph/* IS THE SAME DATA THE VISIBILITY COLUMN GOVERNS ────────────────
//
// Every route below resolved nothing but owner_key, and in a shared workspace
// owner_key is the same value for every member. So a viewer could read a
// colleague's `personal` project graph by id — nodes, edges, and evidence, which
// then carried verbatim transcript excerpts (it carries a derived line now, and
// still names what the project holds). The service now answers null for anything
// the caller may not see, and these routes turn that into not_found rather than
// forbidden: naming the refusal would confirm the project exists and that
// somebody is working on it, which is most of what `personal` protects.
router.get('/graph/projects/:projectId', async (req, res, next) => {
  try {
    const graph = await service.getProjectGraph(req.actor, req.params.projectId);
    if (!graph) return res.status(404).json({ error: 'project_not_found' });
    return res.json({ graph });
  } catch (err) { next(err); }
});

router.get('/graph/sessions/:sessionId', async (req, res, next) => {
  try {
    const graph = await service.getSessionGraph(req.actor, req.params.sessionId);
    if (!graph) {
      return res.status(404).json({ error: 'session_not_found' });
    }
    return res.json({ graph });
  } catch (err) { next(err); }
});

router.get('/graph/nodes/:nodeId', async (req, res, next) => {
  try {
    const graph = await service.getNodeGraph(req.actor, req.params.nodeId);
    if (!graph) {
      return res.status(404).json({ error: 'node_not_found' });
    }
    return res.json({ graph });
  } catch (err) { next(err); }
});

// requireContextWrite is a SCOPE check, and the context:write scope is derived
// from users.role — every Clerk session in the workspace holds it. It never
// answered "is this your memory to delete"; the service does, and this is
// permanent.
router.delete('/graph/nodes/:nodeId', requireContextWrite, async (req, res, next) => {
  try {
    await service.deleteGraphNode(req.actor, req.params.nodeId);
    return res.json({ success: true });
  } catch (err) {
    if (err?.message === 'node_not_found') return res.status(404).json({ error: 'node_not_found' });
    if (respondWriteForbidden(res, err)) return undefined;
    return next(err);
  }
});

router.post('/graph/query', async (req, res, next) => {
  try {
    const parsed = GraphQuerySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
    }

    if (parsed.data.node_id) {
      const graph = await service.getNodeGraph(req.actor, parsed.data.node_id);
      if (!graph) return res.status(404).json({ error: 'node_not_found' });
      return res.json({ graph });
    }

    if (parsed.data.session_id) {
      const graph = await service.getSessionGraph(req.actor, parsed.data.session_id);
      if (!graph) return res.status(404).json({ error: 'session_not_found' });
      return res.json({ graph });
    }

    // Same gate as GET /graph/projects/:projectId — this is the same read behind
    // a different verb, and leaving it open would make the fix above cosmetic.
    const graph = await service.getProjectGraph(req.actor, parsed.data.project_id);
    if (!graph) return res.status(404).json({ error: 'project_not_found' });
    return res.json({ graph });
  } catch (err) { next(err); }
});

// Per-node graph markdown export — one Obsidian-style .md file per node, with
// frontmatter, related-node links, and its evidence lines. Distinct from the
// bundle export above (GET /export), which returns the raw JSON/markdown
// context snapshot.
router.get('/graph/export', async (req, res, next) => {
  try {
    const ownerKey = workspace.defaultOwnerKey(req.actor);
    // The whole vault as markdown, one file per node, evidence lines included.
    // Unfiltered, this was the single largest of the graph leaks: it does not even
    // need a project id to ask for.
    const { nodes, edges, evidence } = await service.filterGraphDataForActor(
      req.actor,
      ownerKey,
      await store.listAllGraphData(ownerKey),
    );

    const nodeById = new Map(nodes.map(n => [n.node_id, n]));
    const edgesByNode = new Map();
    for (const e of edges) {
      if (!edgesByNode.has(e.from_node_id)) edgesByNode.set(e.from_node_id, []);
      if (!edgesByNode.has(e.to_node_id)) edgesByNode.set(e.to_node_id, []);
      edgesByNode.get(e.from_node_id).push({ dir: 'out', edge: e });
      edgesByNode.get(e.to_node_id).push({ dir: 'in', edge: e });
    }
    const evidenceByNode = new Map();
    for (const ev of evidence) {
      if (!ev.node_id) continue;
      if (!evidenceByNode.has(ev.node_id)) evidenceByNode.set(ev.node_id, []);
      evidenceByNode.get(ev.node_id).push(ev);
    }

    function safeFilename(title) {
      return (title || 'untitled').replace(/[^a-zA-Z0-9\-_ .]/g, '_').slice(0, 80);
    }

    function nodeToMd(node) {
      const nodeEdges = edgesByNode.get(node.node_id) || [];
      const nodeEvidence = evidenceByNode.get(node.node_id) || [];
      const created = node.created_at ? new Date(node.created_at).toISOString().split('T')[0] : '';
      const updated = node.updated_at ? new Date(node.updated_at).toISOString().split('T')[0] : '';

      const relatedLines = nodeEdges.map(({ dir, edge }) => {
        const otherId = dir === 'out' ? edge.to_node_id : edge.from_node_id;
        const other = nodeById.get(otherId);
        if (!other) return null;
        const label = dir === 'out'
          ? `[[${other.title}]] (${edge.edge_type})`
          : `[[${other.title}]] ← (${edge.edge_type})`;
        return `- ${label}`;
      }).filter(Boolean);

      // A list line, not a quotation: the line is the product's own sentence
      // about why the node exists (graphEvidenceLine), not anybody's words, so it
      // is not set in quotation marks or a blockquote. Which tool and when follow.
      const evidenceLines = nodeEvidence.slice(0, 5).map(ev => {
        const date = ev.created_at ? new Date(ev.created_at).toISOString().split('T')[0] : '';
        const provenance = [ev.tool, date].filter(Boolean).join(', ');
        return `- ${ev.excerpt || ''}${provenance ? ` (${provenance})` : ''}`;
      });

      const metaLines = node.metadata && Object.keys(node.metadata).length
        ? Object.entries(node.metadata).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')
        : '';

      return [
        '---',
        `id: ${node.node_id}`,
        `type: ${node.node_type}`,
        `confidence: ${node.confidence ?? ''}`,
        `created: ${created}`,
        `updated: ${updated}`,
        `tags: [${node.node_type}]`,
        '---',
        '',
        `# ${node.title}`,
        '',
        node.summary || '',
        '',
        metaLines ? `## Details\n\`\`\`\n${metaLines}\n\`\`\`` : '',
        relatedLines.length ? `## Related\n${relatedLines.join('\n')}` : '',
        evidenceLines.length ? `## Evidence\n${evidenceLines.join('\n')}` : '',
      ].filter(l => l !== '').join('\n');
    }

    const files = nodes.map(node => ({
      path: `${node.node_type}/${safeFilename(node.title)}.md`,
      content: nodeToMd(node),
    }));

    logContextAudit(req.actor, 'context_export', { actor_type: 'user' });
    return res.json({ files, count: files.length });
  } catch (err) { next(err); }
});

router.post('/match', async (req, res, next) => {
  try {
    const parsed = MatchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
    }
    const match = ProjectMatchResultSchema.parse(service.resolveMatch(parsed.data));
    return res.json({ match });
  } catch (err) { next(err); }
});


router.get('/tools/status', async (req, res, next) => {
  try {
    const ownerKey = workspace.defaultOwnerKey(req.actor);
    const db = require('../../config/db');
    // Which tool AND how it connected, as two facts (services/connectionIdentity).
    // `transport` is null on a session that arrived by a path that cannot say;
    // a row the background backfill has not reached yet is derived from its id,
    // the same answer the backfill will store.
    const result = await db.query(
      `SELECT tool,
              COALESCE(transport, CASE WHEN session_id LIKE 'web-%' THEN 'hosted'
                                       WHEN session_id LIKE 'agent-%' THEN 'local_stdio' END) AS transport,
              MAX(last_seen_at) AS last_seen
           FROM context_sessions
          WHERE owner_key = $1
            AND last_seen_at > NOW() - INTERVAL '90 days'
          GROUP BY 1, 2`,
      [ownerKey],
      'org-system'
    );
    const newer = (a, b) => (!a || new Date(b) > new Date(a) ? b : a);
    const tools = {};
    const connections = [];
    let unidentified = null;
    for (const row of result.rows) {
      const transport = row.transport || null;
      // A web app's id on a connection a web app cannot make (a local install,
      // a hosted API key) is not that app. It is reported as an unidentified
      // client rather than as "Claude.ai connected" (or, the other way, as a
      // tool it is not).
      const tool = connectionIdentity.displayTool(row.tool, transport);
      connections.push({
        tool,
        label: connectionIdentity.toolLabel(tool),
        transport,
        transport_label: connectionIdentity.transportLabel(transport),
        last_seen: row.last_seen,
      });
      if (tool) tools[tool] = { last_seen: newer(tools[tool]?.last_seen, row.last_seen) };
      else unidentified = newer(unidentified, row.last_seen);
    }
    if (unidentified) tools.unidentified = { last_seen: unidentified };
    return res.json({ tools, connections });
  } catch (err) { next(err); }
});

router.get('/preferences', async (req, res, next) => {
  try {
    const preferences = await service.getPreferences(req.actor);
    return res.json({ preferences });
  } catch (err) { next(err); }
});

router.patch('/preferences', requireContextWrite, async (req, res, next) => {
  try {
    const parsed = PreferencesRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
    }
    const preferences = await service.updatePreferences(req.actor, parsed.data);
    return res.json({ preferences });
  } catch (err) {
    if (respondWriteForbidden(res, err)) return;
    next(err);
  }
});

const GlobalContextPatchSchema = z.object({
  user_profile:              z.string().optional(),
  preferences:               z.array(z.string()).optional(),
  recurring_instructions:    z.array(z.string()).optional(),
  global_stack:              z.array(z.string()).optional(),
  expertise_areas:           z.array(z.string()).optional(),
  goals:                     z.array(z.string()).optional(),
  working_style:             z.string().optional(),
  values:                    z.array(z.string()).optional(),
  communication_preferences: z.string().optional(),
  // 'seed' marks the local first-run seed: an unattended write from a file about
  // the person. It never settles the one-time review note.
  source: z.literal('seed').optional(),
});

router.get('/global', async (req, res, next) => {
  try {
    const global = await service.getGlobalContext(req.actor);
    // review_needed: a profile from before extraction stopped filling it, not
    // yet checked by its person. Drives the one-time note on the You page.
    return res.json({ global, review_needed: await service.profileNeedsReview(req.actor) });
  } catch (err) { next(err); }
});

// The person dismisses the one-time review note. Nothing is changed or deleted.
router.post('/global/review', requireContextWrite, async (req, res, next) => {
  try {
    await service.dismissProfileReview(req.actor);
    return res.json({ review_needed: false });
  } catch (err) { next(err); }
});

router.patch('/global', requireContextWrite, async (req, res, next) => {
  try {
    const parsed = GlobalContextPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
    }
    const { source, ...patch } = parsed.data;
    const global = await service.updateGlobalContext(req.actor, patch, { auto: source === 'seed' });
    return res.json({ global });
  } catch (err) {
    if (respondWriteForbidden(res, err)) return;
    next(err);
  }
});

// The SSE channel is WORKSPACE-wide, so forwarding every message told a
// teammate (a viewer included) that a colleague's personal project exists and
// when it is being worked on, while every read route answers 404 for it. Each
// message is checked against the same visible-project set the graph filter uses
// (null = solo workspace or system actor: nothing to filter; a message with no
// project always passes).
//
// Read fresh for every message, not cached: the message that most needs
// dropping is the one right after an author flips a project to personal, and a
// cached "visible" answer is exactly what would forward it. The cost is bounded
// — at most MAX_STREAM_CONNECTIONS_PER_OWNER streams per workspace, and
// messages arrive at the pace of human writes.
//
// NOT EVERY CHANNEL IS A PROJECT. The store also publishes on
// `context:<owner>:preferences`, `:global` and `:session:<id>`, and reading every
// suffix as a project id dropped all three on any shared workspace — for every
// reader, including the person whose own change produced them. The first two
// always pass: preferences are stored per workspace, and a `:global` message
// carries no content (only that some profile changed; each reader refetches
// their own, which is keyed by person). A session channel belongs to the person driving
// that session: it goes to them, and to nobody else once there is anybody else.
// A session with no person behind it (it predates attribution, or a system actor
// made it) is judged by the project it is bound to, which is what its
// session_bound payload names.
const WORKSPACE_STREAM_CHANNELS = new Set(['preferences', 'global']);
const SESSION_STREAM_PREFIX = 'session:';

//
// AND THE READER HAS TO STILL BE IN THE WORKSPACE. Authentication binds a
// workspace per REQUEST, and a stream is one request that never ends: removing a
// member revoked their keys and barred their next request, while the stream they
// already had open went on delivering project_updated for every shared project.
// So membership is re-read here too — cached for STREAM_MEMBERSHIP_RECHECK_MS,
// because it is the same answer for every message and this runs per message —
// and once it says no, the filter refuses everything from then on and reports
// `evicted()`, which the route uses to close the connection.
const STREAM_MEMBERSHIP_RECHECK_MS = 5_000;

function createStreamProjectFilter(actor, ownerKey, { membershipRecheckMs = STREAM_MEMBERSHIP_RECHECK_MS } = {}) {
  let admittedUntil = 0;
  let evicted = false;
  async function stillAdmitted() {
    if (evicted) return false;
    if (Date.now() < admittedUntil) return true;
    if (!(await workspace.isStillAdmitted(ownerKey, actor))) {
      evicted = true;
      return false;
    }
    admittedUntil = Date.now() + membershipRecheckMs;
    return true;
  }
  async function mayForward(suffix) {
    if (!(await stillAdmitted())) return false;
    if (!suffix) return true;
    if (WORKSPACE_STREAM_CHANNELS.has(suffix)) return true;
    const visible = await service.visibleProjectIdsForActor(actor, ownerKey);
    if (!visible) return true;
    if (suffix.startsWith(SESSION_STREAM_PREFIX)) {
      const sessionId = suffix.slice(SESSION_STREAM_PREFIX.length);
      const session = sessionId ? await store.getSession(ownerKey, sessionId) : null;
      if (session?.user_id) return workspace.actorIdentities(actor).includes(session.user_id);
      return !session?.project_id || visible.has(session.project_id);
    }
    return visible.has(suffix);
  }
  mayForward.stillAdmitted = stillAdmitted;
  mayForward.evicted = () => evicted;
  return mayForward;
}

// SSE stream — delivers real-time context updates to connected desktop clients.
// Each connection gets its own IORedis subscriber; never share the singleton
// because any punsubscribe call would remove subscriptions for ALL connected clients.
router.get('/stream', async (req, res, next) => {
  // Hoisted so the catch below can release the connection slot too. Reassigned once the
  // slot is actually taken; a no-op until then, so an early failure is harmless.
  let releaseSlot = () => {};
  try {
    const ownerKey = workspace.defaultOwnerKey(req.actor) || 'org-system';

    const activeForOwner = streamConnectionsByOwner.get(ownerKey) || 0;
    if (activeForOwner >= MAX_STREAM_CONNECTIONS_PER_OWNER) {
      return res.status(429).json({ error: 'too_many_stream_connections' });
    }
    streamConnectionsByOwner.set(ownerKey, activeForOwner + 1);
    let slotReleased = false;
    releaseSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      const remaining = (streamConnectionsByOwner.get(ownerKey) || 1) - 1;
      if (remaining <= 0) {
        streamConnectionsByOwner.delete(ownerKey);
      } else {
        streamConnectionsByOwner.set(ownerKey, remaining);
      }
    };

    // Bind the release BEFORE any await. The Redis setup below can reject (failover,
    // restart, unreachable host), and the only other release path was a 'close' listener
    // registered after that await — so a failed connect leaked the slot permanently, with
    // no TTL to recover it. Five transient Redis errors would lock an owner out of the
    // stream until the process restarted. releaseSlot is idempotent, so binding here and
    // again later is safe.
    req.on('close', releaseSlot);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    res.write('data: {"type":"connected"}\n\n');

    if (redisDisabled) {
      // In test / no-redis mode: hold the connection open with periodic pings.
      const keepalive = setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n');
      }, 30_000);
      req.on('close', () => {
        clearInterval(keepalive);
        releaseSlot();
      });
      return;
    }

    const sub = new IORedis(env.REDIS_URL);
    sub.on('error', (err) => console.error('[CONTEXT SSE] Redis error:', err.message));

    const channelPrefix = `context:${ownerKey}:`;
    await sub.psubscribe(`${channelPrefix}*`);

    // WORKSPACE MEMBERSHIP IS NOT PROJECT ACCESS — here too; see
    // createStreamProjectFilter. Writes are chained so the async check cannot
    // reorder the stream.
    const mayForward = createStreamProjectFilter(req.actor, ownerKey);
    let delivery = Promise.resolve();
    let closed = false;
    const closeStream = async () => {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      releaseSlot();
      if (!res.writableEnded) res.end();
      try {
        await sub.punsubscribe();
        await sub.quit();
      } catch { /* ignore disconnect errors */ }
    };
    // A removed reader's stream is CLOSED, not left open and silent: an open
    // stream still holds one of the workspace's connection slots.
    const closeIfEvicted = () => {
      if (mayForward.evicted()) closeStream();
    };

    sub.on('pmessage', (_pattern, channel, message) => {
      // The channel's suffix: a project id, or one of the non-project channels
      // createStreamProjectFilter knows by name.
      const suffix = String(channel || '').startsWith(channelPrefix)
        ? String(channel).slice(channelPrefix.length) || null
        : null;
      delivery = delivery
        .then(() => mayForward(suffix))
        .then((allowed) => {
          if (allowed && !res.writableEnded) res.write(`data: ${message}\n\n`);
          closeIfEvicted();
        })
        // Fail closed: a visibility read that errors drops the message rather
        // than forwarding something the reader may not be allowed to see.
        .catch((err) => console.warn('[CONTEXT SSE] visibility check failed:', err.message));
    });

    // Same keepalive cadence as the redisDisabled branch above — without it,
    // proxy/ALB idle timeouts silently sever connections that go quiet between
    // pubsub messages.
    // The keepalive tick also re-reads membership, so a removed reader's stream
    // closes within one tick even when nothing is being published.
    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
      mayForward.stillAdmitted()
        .then(closeIfEvicted)
        .catch((err) => console.warn('[CONTEXT SSE] membership check failed:', err.message));
    }, 30_000);

    req.on('close', closeStream);
  } catch (err) {
    // Release the slot on any setup failure. Without this a rejected Redis connect leaked
    // the slot with no TTL, so repeated transient failures permanently locked the owner
    // out of the stream.
    releaseSlot();
    next(err);
  }
});

// ─── Graph node manual mutation ───────────────────────────────────────────────

const GraphNodeCreateSchema = z.object({
  project_id:  z.string().optional(),
  node_type:   z.string().min(1),
  title:       z.string().min(1),
  summary:     z.string().optional().default(''),
  metadata:    z.record(z.unknown()).optional().default({}),
  confidence:  z.number().min(0).max(1).optional().default(0.85),
});

const GraphNodePatchSchema = z.object({
  title:      z.string().optional(),
  summary:    z.string().optional(),
  importance: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  pinned:     z.boolean().optional(),
});

router.post('/graph/nodes', requireContextWrite, async (req, res, next) => {
  try {
    const parsed = GraphNodeCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
    }
    const now = new Date().toISOString();
    const ownerKey = workspace.defaultOwnerKey(req.actor) || 'org-system';
    const d = parsed.data;
    // Filing a node under a project writes that project's knowledge, so it takes
    // the project's write gate; with no project it is workspace-scoped and takes
    // the workspace one. Neither was checked: a viewer could plant a node in a
    // project they cannot even open.
    await service.assertGraphNodeCreatable(req.actor, d.project_id || null);
    // From the REDACTED title: the key is served with the node, and a secret
    // lowercased and underscored no longer matches the redactor's patterns.
    const canonicalKey = store.redactForStorage(d.title).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 80);
    // The upsert lands on whatever row already holds this key in the WORKSPACE,
    // which can be a colleague's hidden node: judge that row before writing.
    const existingByKey = await service.assertGraphNodeKeyUpsertable(req.actor, d.node_type, canonicalKey);
    // Judged on the metadata this route STORES, not the metadata it was sent:
    // the caller's source / event_type are the server's to set (they pick the
    // section an event node is governed by), so they are dropped, and the
    // node is stored — and judged — as source:'manual'.
    const metadata = { ...service.stripServerOnlyNodeMetadata(d.metadata), source: 'manual' };
    // A NEW node in a section the share withholds from the caller would be
    // theirs to write and never to read, change or delete: refused, nothing
    // written. See service.assertNewGraphNodeReadable.
    if (!existingByKey) {
      await service.assertNewGraphNodeReadable(req.actor, {
        node_type: d.node_type,
        project_id: d.project_id || null,
        metadata,
      });
    }
    const node = await store.upsertGraphNode({
      node_id:          `node_${crypto.randomUUID()}`,
      owner_key:        ownerKey,
      project_id:       d.project_id || null,
      // The project this node names, judged creatable above, may take a
      // workspace-level row with the same key into it; see store.upsertGraphNode.
      adopt_project:    Boolean(d.project_id),
      node_type:        d.node_type,
      canonical_key:    canonicalKey,
      title:            d.title,
      summary:          d.summary,
      metadata,
      confidence:       d.confidence,
      source_session_id: 'manual',
      source_tool:      'dashboard',
      created_at:       now,
      updated_at:       now,
      last_seen_at:     now,
    });
    // As the caller may READ it: the upsert above can land on an existing row,
    // and the reply is the stored merge. See service.echoGraphNodesForActor.
    const [shown] = await service.echoGraphNodesForActor(req.actor, ownerKey, [node]);
    return res.status(201).json({ node: shown });
  } catch (err) {
    if (err?.message === 'project_not_found') return res.status(404).json({ error: 'project_not_found' });
    if (err?.message === 'node_not_found') return res.status(404).json({ error: 'node_not_found' });
    if (respondWriteForbidden(res, err)) return undefined;
    return next(err);
  }
});

router.patch('/graph/nodes/:nodeId', requireContextWrite, async (req, res, next) => {
  try {
    const parsed = GraphNodePatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
    }
    const ownerKey = workspace.defaultOwnerKey(req.actor) || 'org-system';
    const now = new Date().toISOString();
    const d = parsed.data;

    // Owner-scoped is not caller-scoped: owner_key is the WORKSPACE, so this
    // matched for every member of it. The visibility + write gate runs first, and
    // answers node_not_found for a node the caller cannot see.
    await service.assertGraphNodeWritable(req.actor, req.params.nodeId);

    // Load the node (owner-scoped) so we can merge metadata + normalize the title
    // against the node's own type, and force-override the summary on explicit edits.
    const existing = await db.query(
      'SELECT * FROM context_graph_nodes WHERE node_id = $1 AND owner_key = $2',
      [req.params.nodeId, ownerKey],
      'org-system'
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'node_not_found' });
    const node = existing.rows[0];

    const metadata = { ...(node.metadata || {}) };
    if (d.importance !== undefined) metadata.importance = d.importance;
    if (d.pinned !== undefined) metadata.pinned = d.pinned;
    if (d.title !== undefined || d.summary !== undefined || d.importance !== undefined || d.pinned !== undefined) {
      metadata.curation_state = 'curated';
    }

    // Redacted like every other graph write (store.upsertGraphNode): a pasted
    // key in a hand-edited node is served by every graph read after it.
    const rawTitle = d.title !== undefined ? store.redactForStorage(d.title) : node.title;
    const normalizedTitle = normalizeGraphNodeTitle(rawTitle, node.node_type, metadata);
    const newSummary = d.summary !== undefined ? store.redactForStorage(d.summary) : node.summary;

    const result = await db.query(
      `UPDATE context_graph_nodes
       SET title = $1, summary = $2, metadata = $3, updated_at = $4
       WHERE node_id = $5 AND owner_key = $6
       RETURNING *`,
      [normalizedTitle, newSummary, JSON.stringify(metadata), now, req.params.nodeId, ownerKey],
      'org-system'
    );
    if (!result.rows.length) return res.status(404).json({ error: 'node_not_found' });
    // RETURNING * is the stored row. GET of the same node is filtered for the
    // reader (a teammate sees a shared project's root with the withheld
    // description and stack blanked); this reply was not, so editing a node read
    // back exactly what reading it hid. The gate above now refuses such a node,
    // and the reply goes through the read filter regardless.
    const [shown] = await service.echoGraphNodesForActor(req.actor, ownerKey, result.rows);
    return res.json({ node: shown });
  } catch (err) {
    if (err?.message === 'node_not_found') return res.status(404).json({ error: 'node_not_found' });
    if (respondWriteForbidden(res, err)) return undefined;
    return next(err);
  }
});

// Live, per-owner vault health — lets a user see the vault is staying clean.
router.get('/graph/vault-health', async (req, res, next) => {
  try {
    const ownerKey = workspace.defaultOwnerKey(req.actor) || 'org-system';
    // Aggregates over the whole workspace's vault, which on a shared workspace is
    // a count of work the caller may not read. Scoped to the projects they can
    // see (plus workspace-scoped nodes, which belong to no project).
    //
    // This used to judge a node by its HOME project alone, and said so: the
    // accurate rule needs the node's SIGHTINGS too, and the obvious way to get
    // them is a per-node lateral over context_graph_evidence.node_id — the exact
    // shape graph-query-index-blindspot measured at 14,219ms and the 8s breaker
    // turns into a 503. So it under-reported on purpose, which meant this gauge
    // disagreed with every other surface: the node read, the export and the brief
    // all show a teammate a node seen in a shared project, and only the health
    // number pretended it was not there. It under-reports by MORE the more a
    // workspace shares, so the number got worse exactly as teams adopted it.
    //
    // The lateral was never the only accurate shape. One owner-scoped CTE
    // collects every sighting in a visible project in a single pass — leading
    // with owner_key, then project_id, which is
    // idx_context_graph_evidence_owner_project exactly — and the outer query
    // semi-joins it once. Same answer as the lateral, at roughly the cost of the
    // home-project-only version. That is the same rewrite listCrossProjectEntities
    // needed (14,219ms -> 177ms); the index the memory said was missing exists
    // now, so check before assuming the slow shape is forced.
    //
    // node_id IS NOT NULL is not decoration: an evidence row with a NULL node_id
    // would put a NULL in the semi-join's set.
    const visible = await service.visibleProjectIdsForActor(req.actor, ownerKey);
    const params = [ownerKey];
    let scope = '';
    let sightings = '';
    if (visible) {
      params.push([...visible]);
      const p = `$${params.length}`;
      sightings = `WITH visible_sightings AS (
         SELECT DISTINCT node_id
           FROM context_graph_evidence
          WHERE owner_key = $1 AND node_id IS NOT NULL AND project_id = ANY(${p})
            AND COALESCE(metadata->>'kind', '') <> 'sighting'
       )
       `;
      // A node marked private to one person (the founder's pre-team notes,
      // workspaceService.backfillProjectOwnership) counts for that person only.
      params.push(workspace.actorIdentities(req.actor));
      const ids = `$${params.length}`;
      scope = ` AND (project_id IS NULL OR project_id = ANY(${p})`
        + ' OR node_id IN (SELECT node_id FROM visible_sightings))'
        + ` AND (COALESCE(metadata->>'private_to', '') = '' OR metadata->>'private_to' = ANY(${ids}::text[]))`;
    }
    const { rows } = await db.query(
      `${sightings}SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE metadata->>'status' IN ('resolved', 'archived'))::int AS resolved_or_archived,
         COUNT(*) FILTER (WHERE metadata->>'memory_tier' = 'candidate')::int AS candidates,
         COUNT(*) FILTER (WHERE metadata->>'memory_tier' = 'durable')::int AS durable,
         COUNT(*) FILTER (WHERE COALESCE(metadata->>'pinned', 'false') IN ('true', '1'))::int AS pinned,
         COUNT(*) FILTER (WHERE COALESCE((metadata->>'retrieval_hits')::int, 0) = 0 AND last_seen_at < NOW() - INTERVAL '30 days')::int AS stale_unused,
         COALESCE(ROUND(AVG(confidence)::numeric, 3), 0)::float AS avg_confidence
       FROM context_graph_nodes
       WHERE owner_key = $1${scope}`,
      params,
      'org-system'
    );
    const stats = rows[0] || {};
    const active = Math.max(0, (stats.total || 0) - (stats.resolved_or_archived || 0));
    return res.json({ health: { ...stats, active, computed_at: new Date().toISOString() } });
  } catch (err) { next(err); }
});

// WORKSPACE MEMBERSHIP IS NOT PROJECT ACCESS. The audit log is workspace-wide,
// and its rows name projects (project_deleted / project_moved carry the NAME in
// metadata), who touched them and when — so an unfiltered read handed every
// member and viewer the activity of colleagues' personal and private work.
//
// A row about a project is shown when the reader may read that project NOW, or
// when the reader is the person who acted (their own history of a project they
// deleted, moved away, or can no longer see). Team rows file the project under
// metadata.project_id with a NULL column, hence the COALESCE. Rows about no
// project (membership, domains) are workspace-level and stay.
//
// A row about a project that is no longer IN this workspace (deleted, or moved
// out) is judged by the visibility recorded on the row when it was written:
// a shared project's deletion is the team's news, not only its deleter's. Rows
// with nothing recorded predate that and stay with their actor. See
// service.auditScopeForActor.
//
// Appends to `params` and returns the clause, so the page query and the
// retained_since query cannot drift apart.
function auditVisibilityClause(scope, identities, params) {
  params.push([...scope.visible]);
  const visibleParam = params.length;
  params.push(identities);
  const selfParam = params.length;
  params.push([...scope.existing]);
  const existingParam = params.length;
  params.push(scope.recordedVisibilities);
  const recordedParam = params.length;
  const projectOf = 'COALESCE(a.project_id, a.metadata->>\'project_id\')';
  return `(${projectOf} IS NULL
          OR ${projectOf} = ANY($${visibleParam}::text[])
          OR a.actor_user_id = ANY($${selfParam}::text[])
          OR (NOT (${projectOf} = ANY($${existingParam}::text[]))
              AND a.metadata->>'visibility' = ANY($${recordedParam}::text[])))`;
}

router.get('/audit', async (req, res, next) => {
  try {
    const ownerKey = workspace.defaultOwnerKey(req.actor);
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 100);
    // null = nothing in the workspace can be anybody else's, or a system actor:
    // nothing to filter, so exactly what it saw before.
    const scope = await service.auditScopeForActor(req.actor, ownerKey);
    const visible = scope?.visible || null;
    const identities = workspace.actorIdentities(req.actor);
    const conditions = ['a.owner_key = $1'];
    const params = [ownerKey];
    if (scope) conditions.push(auditVisibilityClause(scope, identities, params));
    if (req.query.project_id) { conditions.push(`a.project_id = $${params.length + 1}`); params.push(req.query.project_id); }
    if (req.query.action) { conditions.push(`a.action = $${params.length + 1}`); params.push(req.query.action); }
    // "Has anyone outside the team opened this?" is the question a shared
    // workspace's log is actually read for, so it has to be filterable by person.
    if (req.query.actor_user_id) {
      conditions.push(`a.actor_user_id = $${params.length + 1}`);
      params.push(req.query.actor_user_id);
    }
    params.push(limit);
    const result = await db.query(
      `SELECT a.audit_id AS id, a.project_id, a.action, a.actor_type, a.actor_user_id,
              u.email AS actor_email, a.tool, a.metadata, a.created_at
         FROM context_audit_logs a
         LEFT JOIN users u ON u.user_id = a.actor_user_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY a.created_at DESC
        LIMIT $${params.length}`,
      params,
      'org-system'
    );
    // A project the reader cannot read answers 404, the same as the project read
    // routes — unless the reader has rows of their own on it, which the filter
    // above already returned. "Unreadable" and "no such project" both answer 404,
    // so the status confirms nothing.
    if (visible && req.query.project_id && !visible.has(req.query.project_id) && !result.rows.length) {
      return res.status(404).json({ error: 'project_not_found' });
    }
    // How far back the log actually goes, said out loud. A window that silently
    // truncates is indistinguishable from "nothing happened", which is the worst
    // thing an audit log can imply. Measured over the rows this reader may see.
    const oldestParams = [ownerKey];
    const oldestConditions = ['a.owner_key = $1'];
    if (scope) oldestConditions.push(auditVisibilityClause(scope, identities, oldestParams));
    const oldest = await db.query(
      `SELECT MIN(a.created_at) AS since FROM context_audit_logs a WHERE ${oldestConditions.join(' AND ')}`,
      oldestParams,
      'org-system'
    ).catch(() => ({ rows: [] }));
    return res.json({
      logs: result.rows,
      retained_since: oldest.rows[0]?.since || null,
      truncated: result.rows.length >= limit,
    });
  } catch (err) { next(err); }
});

// ── TWO ROUTES ARE CALLED "DELETE MY ACCOUNT". THEY ARE NOT THE SAME ACTION. ──
//
//   DELETE /api/v1/context/account     (this one)          EMPTIES A WORKSPACE.
//   DELETE /api/v1/orgs                (routes/shared/orgs) CLOSES THE ACCOUNT.
//
// This route erases every row of the BOUND workspace's data and stops there. The
// users row, the organizations row and the Clerk identity all survive it: the
// person can sign straight back in, to an empty workspace on the same plan.
// DELETE /api/v1/orgs does the same erasure against the person's OWN org
// (req.actor.org_id, never the bound workspace), behind a step-up confirmation,
// and then deletes the account shell and the Clerk identities as well. The full
// comparison is at that definition.
//
// What the two must never differ in is WHAT COUNTS AS DATA. Both go through
// purgeOwnerData and neither keeps a list of its own. They used to: the audit
// trail, decisions, policies and enterprise inquiries were deleted inline by the
// other route only, so this one answered `deleted: true` and left them behind.
// What they DO differ in is the person: DELETE /orgs also erases the person's
// rows in other people's workspaces; this route passes workspaceOnly and leaves
// the person — memberships, keys and personal projects elsewhere — alone.
//
// Authorization is identical on both (workspace owner, and never while the
// workspace has other members) and was not changed when the lists were merged.
router.delete('/account', requireContextAdmin, async (req, res, next) => {
  try {
    const ownerKey = workspace.defaultOwnerKey(req.actor);
    if (!ownerKey) return res.status(401).json({ error: 'unauthorized' });

    // TWO GATES, BECAUSE ownerKey IS NOW A WORKSPACE THAT MAY HOLD OTHER PEOPLE.
    //
    // requireContextAdmin only checks the context:admin SCOPE, and scopes come from
    // deriveScopes(users.role) — 'owner' for every self-signup. Once this route
    // started resolving the BOUND workspace, that gate stopped separating anybody
    // from anybody: an invited viewer could send the workspace header and purge the
    // whole company's projects, sessions, graph, integration credentials and keys,
    // leaving their own account untouched.
    //
    // 1. The workspace role, not the org role, decides who may administer it.
    const role = await workspace.resolveRole(req.actor, ownerKey);
    if (!workspace.canAdminister(role)) {
        // A REFUSAL THAT NAMES NO NEXT STEP IS A DEAD END.
        //
        // The commonest way to arrive here is header-less: somebody whose
        // requests resolve to a team they belong to, asking to delete their OWN
        // account and told only that they are not an owner — of a workspace
        // they never meant to address. The account they asked about is in their
        // own workspace, and switching to it is the entire answer.
        const here = role
            ? await db.query('SELECT name FROM organizations WHERE org_id = $1', [ownerKey], 'org-system')
                .then((r) => r.rows[0]?.name || null)
                .catch(() => null)
            : null;
        return res.status(403).json({
            error: 'forbidden',
            message: role
                ? `You are working in ${here || 'a team workspace'}. Switch to your own workspace to delete your own data.`
                : 'Only a workspace owner can delete its data.',
            workspace: ownerKey,
        });
    }
    // 1b. The caller is an owner here (step 1). Make sure the roster says so
    // before anything counts it: a founder whose own row is missing (a signup
    // path that predates ensureOwnerMembership, or the pre-scan-25 version of
    // this route, which swept the caller's row with everybody else's) is still
    // one of this workspace's people, and without the row the count in step 2
    // is one short — a founder plus one teammate reads as solo, and the empty
    // below erases the teammate's work. Done here, for this caller, rather than
    // by counting every users.org_id in countActiveMembers: invited people's
    // home org can point at the team too, and counting them there makes a
    // workspace read as shared before its first join, so the solo-era
    // ownership backfill never fires.
    const callerPersonId = workspace.actorPersonId(req.actor);
    if (callerPersonId) await workspace.ensureOwnerMembership(ownerKey, callerPersonId);
    // 2. Even an owner does not get to destroy other people's work through a route
    // called "delete my account". Deleting a SHARED workspace is a different
    // decision with different consequences, and it must be taken deliberately after
    // the other members are removed — not as a side effect of one person leaving.
    if (await workspace.isSharedWorkspace(ownerKey)) {
        return res.status(409).json({
            error: 'workspace_has_members',
            message: 'This workspace has other members. Remove them first, or leave the workspace instead of deleting it.',
        });
    }
    // 3. Same gate as DELETE /api/v1/orgs. This route no longer takes the person
    // off any other workspace (workspaceOnly, below), so it cannot leave a team
    // ownerless on its own; the gate is kept deliberately, so that the two
    // "delete" routes refuse the same people and a sole owner is pointed at
    // their team before erasing anything.
    const soleOwned = await workspace.listSoleOwnedTeams(workspace.actorIdentities(req.actor));
    if (soleOwned.length) {
        return res.status(409).json(workspace.soleOwnerConflict(soleOwned));
    }

    if (req.body?.confirmation !== 'DELETE MY DEERDAWN ACCOUNT') {
      return res.status(400).json({
        error: 'confirmation_required',
        message: 'Set confirmation to "DELETE MY DEERDAWN ACCOUNT" after exporting any data you want to keep.',
      });
    }
    // BILLING FIRST, AND ABORT ON FAILURE. Until 2026-09-03 this route erased
    // everything and left the Stripe subscription alive — a deleted account
    // that keeps getting charged, with no dashboard left to cancel from. The
    // ordering is deliberate: cancel, then purge. If the cancel fails the
    // deletion refuses to proceed, because "data gone, billing alive" is
    // strictly worse than making the user retry.
    const billing = await cancelSubscriptionForDeletion(ownerKey);
    if (!billing.ok) {
      return res.status(502).json({
        error: 'billing_cancellation_failed',
        message: 'Your subscription could not be cancelled, so nothing was deleted. Try again, or cancel the subscription from Billing first.',
      });
    }
    // DS-01: erase ALL owner-scoped data (incl. context_integrations credentials, globals,
    // embeddings, api_keys) via the shared helper so this path can't drift from the webhook path.
    //
    // workspaceOnly: THIS WORKSPACE, AND NOTHING BEYOND IT. The account survives
    // this route, so the person does too — their memberships in other teams,
    // their keys there and their personal projects there are untouched. Until
    // scan 24 it ran the person-keyed half of the erasure as well, so a member
    // emptying their own workspace was silently removed from every team they
    // belonged to, keys revoked, while the page promised "an empty workspace".
    // Leaving a team is its own action (DELETE /teams/members/:self); closing
    // the account is DELETE /api/v1/orgs.
    //
    // keepMembers: THE PERSON EMPTYING THE WORKSPACE STAYS ITS OWNER. Their own
    // roster row survives the sweep (and is written if it never existed), or
    // every count of this workspace's people is one short from here on: the
    // next join reads as its FIRST member, the solo-era projects never flip to
    // personal, and a second empty with a teammate aboard passes the
    // workspace_has_members gate above. See keepMembers in dataErasureService.
    const callerId = workspace.actorPersonId(req.actor);
    const deleted = await purgeOwnerData(ownerKey, {
        strict: true,
        workspaceOnly: true,
        keepMembers: callerId ? [callerId] : [],
    });
    if (callerId) await workspace.ensureOwnerMembership(ownerKey, callerId);
    return res.json({
        deleted: true,
        deleted_counts: deleted,
        // Always empty now, and kept so a client reading it does not break.
        left_workspaces: [],
        message: 'Your data in this workspace was deleted. Your account, and your membership in any other workspace, are unchanged.',
        subscription_cancelled: billing.cancelled,
    });
  } catch (err) { next(err); }
});

// ─── Shared skills (markdown know-how distributed across connected tools) ────
// Owner key = the bound workspace (workspace.defaultOwnerKey), matching
// logContextAudit. List returns metadata only (no markdown_content); get returns
// the full skill. Writes are gated on the WORKSPACE's shared_skills feature flag
// + included_skills cap — never the person's own org, which for an invited
// teammate is usually Free.

// Slug an editing lookup would resolve to, so an update/toggle of an already-owned
// skill is exempted from consuming a new slot at the cap.
function skillLookupKey(body = {}) {
  return body.skill_id
    || String(body.slug || body.name || '')
      .trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

const SKILL_QUOTA_BLOCK = { status: 422, body: { error: 'skills_limit_exceeded', upgrade_required: true } };

// Fetch the caller's skill entitlements once, so a route can gate the hard
// feature flag before doing expensive work and re-check the cap afterwards
// without a second lookup.
async function getSkillEntitlements(orgOrOwnerKey) {
  const entitlements = await getEntitlements(orgOrOwnerKey).catch(() => null);
  return { features: entitlements?.features || {}, limits: entitlements?.limits || {} };
}

// Gate a skill write against already-fetched entitlements. `lookupExisting`
// (skill_id or slug) exempts an update of an already-owned skill from the
// per-plan cap. Returns null when allowed, or { status, body } describing the block.
async function skillQuotaBlock(ownerKey, ent, lookupExisting) {
  if (!ent.features.shared_skills) return SKILL_QUOTA_BLOCK;
  const cap = ent.limits.included_skills;
  if (cap != null && Number.isFinite(Number(cap))) {
    const owned = lookupExisting ? await service.getWorkspaceSkill(ownerKey, lookupExisting) : null;
    if (!owned) {
      const active = await service.listWorkspaceSkills(ownerKey, {});
      if (active.length >= Number(cap)) return SKILL_QUOTA_BLOCK;
    }
  }
  return null;
}

router.get('/skills', requireAuth, apiLimiter, async (req, res, next) => {
  try {
    const ownerKey = workspace.defaultOwnerKey(req.actor);
    const skills = await service.listWorkspaceSkills(ownerKey, { project_id: req.query.project_id, actor: req.actor });
    // can_edit per row, from the same rule the write gate enforces.
    return res.json({ skills: await service.annotateSkillsForActor(req.actor, skills) });
  } catch (err) { next(err); }
});

router.get('/skills/:idOrSlug', requireAuth, apiLimiter, async (req, res, next) => {
  try {
    const ownerKey = workspace.defaultOwnerKey(req.actor);
    const skill = await service.getWorkspaceSkill(ownerKey, req.params.idOrSlug, { actor: req.actor });
    if (!skill) return res.status(404).json({ error: 'not_found' });
    return res.json({ skill });
  } catch (err) { next(err); }
});

// AUTHORIZATION, NOT ONLY ENTITLEMENT. These three routes carried requireAuth
// and a plan check, which together answer "is somebody signed in and paying" —
// never "may THIS person change the instructions every session in this
// workspace will execute". The scope gate keeps a read-only credential out; the
// role and author checks inside the service decide the rest. GET stays
// deliberately ungated: browsing skills is a read, and browse_skills on a plan
// without the feature must return an empty list rather than a refusal.
router.post('/skills', requireAuth, requireContextWrite, apiLimiter, async (req, res, next) => {
  try {
    const ownerKey = workspace.defaultOwnerKey(req.actor);
    // Monetization: meter on # of skills — gate on the shared_skills feature flag,
    // then on the included_skills cap. An edit/toggle of an owned skill is exempt.
    const ent = await getSkillEntitlements(ownerKey);
    const blocked = await skillQuotaBlock(ownerKey, ent, skillLookupKey(req.body || {}));
    if (blocked) return res.status(blocked.status).json(blocked.body);
    const skill = await service.upsertSkill(req.actor, req.body || {});
    logContextAudit(req.actor, 'skill.upsert', { skill_id: skill.skill_id, actor_type: 'user' });
    return res.json({ skill });
  } catch (err) {
    if (err?.status) return res.status(err.status).json({ error: err.message, message: err.publicMessage });
    next(err);
  }
});

// Import a shared skill from a pasted GitHub repo URL. Fail fast on the hard
// feature gate BEFORE the network fetch; then fetch + parse the SKILL.md and
// re-check the cap with the real slug (so a re-import updates in place without
// consuming a slot), reusing the same secret-scan/sanitize path via upsertSkill.
router.post('/skills/import-github', requireAuth, requireContextWrite, apiLimiter, async (req, res, next) => {
  try {
    const ownerKey = workspace.defaultOwnerKey(req.actor);
    const repoUrl = req.body?.repo_url || req.body?.url || req.body?.github_url;
    const ent = await getSkillEntitlements(ownerKey);
    if (!ent.features.shared_skills) {
      return res.status(SKILL_QUOTA_BLOCK.status).json(SKILL_QUOTA_BLOCK.body);
    }
    const parsed = await service.fetchSkillFromGithub(repoUrl);
    const blocked = await skillQuotaBlock(ownerKey, ent, parsed.slug);
    if (blocked) return res.status(blocked.status).json(blocked.body);
    const skill = await service.upsertSkill(req.actor, {
      name: parsed.name,
      description: parsed.description,
      markdown_content: parsed.markdown_content,
      project_id: req.body?.project_id,
    });
    logContextAudit(req.actor, 'skill.import_github', {
      skill_id: skill.skill_id, actor_type: 'user', project_id: req.body?.project_id || null,
    });
    return res.json({ skill, source_url: parsed.source_url });
  } catch (err) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.delete('/skills/:id', requireAuth, requireContextWrite, apiLimiter, async (req, res, next) => {
  try {
    await service.deleteSkill(req.actor, req.params.id);
    return res.status(204).end();
  } catch (err) {
    if (err?.status) return res.status(err.status).json({ error: err.message, message: err.publicMessage });
    return next(err);
  }
});

module.exports = router;
// Exported for the visibility pin: the stream's Redis branch never runs under
// NODE_ENV=test, so the filter is tested directly as well as over HTTP.
module.exports.createStreamProjectFilter = createStreamProjectFilter;
