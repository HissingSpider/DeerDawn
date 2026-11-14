import type { z } from 'zod';

export type Verbosity = 'light' | 'standard' | 'detailed';
export type ContextTool = 'claude_web' | 'chatgpt_web' | 'gemini' | 'perplexity' | 'cursor' | 'claude_code' | 'codex';
/** Provenance of a stored graph fact: any client tool, or the dashboard's own "add node". */
export type GraphSourceTool = ContextTool | 'dashboard';
export type SurfaceType = 'browser' | 'cli' | 'code';
export type SessionStatus = 'active' | 'paused' | 'idle' | 'closed' | 'ambiguous';
export type RoutingState = 'matched' | 'ambiguous' | 'stale_match' | 'global_only';
export type MatchDecision = 'matched_existing' | 'new_project' | 'ambiguous' | 'ignored';
export type DecisionImportance = 'low' | 'normal' | 'high' | 'critical';

// GRAPH_NODE_TYPE_VALUES / GRAPH_EDGE_TYPE_VALUES are declared here as literal
// tuples (not just string[]) so GraphNodeType/GraphEdgeType are DERIVED from
// them via `typeof X[number]` — one list to keep in sync with runtime
// (GRAPH_NODE_TYPE_VALUES / GRAPH_EDGE_TYPE_VALUES in index.js), not two.
export declare const GRAPH_NODE_TYPE_VALUES: readonly [
  'project', 'repo', 'file', 'component', 'feature', 'decision', 'task', 'person', 'company', 'service', 'concept',
  'knowledge', 'question', 'tool', 'environment', 'database', 'capability', 'workflow', 'preference',
];
export type GraphNodeType = typeof GRAPH_NODE_TYPE_VALUES[number];

export declare const GRAPH_EDGE_TYPE_VALUES: readonly [
  'depends_on', 'implements', 'mentions', 'related_to', 'used_in', 'decided_by', 'blocks', 'owns', 'same_as', 'contains', 'tracks',
  'supports', 'uses', 'prefers', 'rule',
];
export type GraphEdgeType = typeof GRAPH_EDGE_TYPE_VALUES[number];

export declare const TOOL_VALUES: readonly ContextTool[];
export declare const GRAPH_SOURCE_TOOL_VALUES: readonly GraphSourceTool[];
export declare const VERBOSITY_VALUES: readonly Verbosity[];
export declare const SURFACE_TYPE_VALUES: readonly SurfaceType[];
export declare const SESSION_STATUS_VALUES: readonly SessionStatus[];
export declare const ROUTING_STATE_VALUES: readonly RoutingState[];
export declare const DECISION_IMPORTANCE_VALUES: readonly DecisionImportance[];

export interface DecisionEntry {
  summary: string;
  decided_at: string;
  reasoning?: string;
  importance?: DecisionImportance;
  resolved?: boolean;
  resolved_at?: string;
  date_inferred?: boolean;
  confidence?: number;
  source_tool?: string;
  source_session_id?: string;
  verified_at?: string;
  verified_commit?: string;
}

export interface CommandEntry {
  label: string;
  run: string;
  note?: string;
}

export interface HotPathEntry {
  label: string;
  path: string;
  purpose?: string;
  importance?: DecisionImportance;
  pinned?: boolean;
  contributed_by?: string | null;
}

export interface EntrypointEntry {
  label: string;
  path: string;
  purpose?: string;
}

export interface SurfaceEntry {
  label: string;
  paths: string[];
  purpose?: string;
}

export interface DebuggingNoteEntry {
  summary: string;
  paths: string[];
  added_at: string;
  commit_ref?: string;
  diff_ref?: string;
  confidence?: number;
  source_tool?: string;
  source_session_id?: string;
  verified_at?: string;
  importance?: DecisionImportance;
  pinned?: boolean;
}

export interface LandmineEntry {
  summary: string;
  paths: string[];
  added_at: string;
  importance?: DecisionImportance;
  pinned?: boolean;
  confidence?: number;
  source_tool?: string;
  source_session_id?: string;
  date_inferred?: boolean;
  verified_at?: string;
  verified_commit?: string;
}

export interface ShippedEntry {
  summary: string;
  shipped_at: string;
  source_tool?: string;
  confidence?: number;
  commit_ref?: string;
  pinned?: boolean;
  /** The Done board card this line came from; the line follows the card. */
  card_id?: string;
}

export type TaskStepStatus = 'todo' | 'in_progress' | 'done';
export interface TaskStep {
  name: string;
  status: TaskStepStatus;
}

export interface YouProfile {
  expertise_areas?: string[];
  goals?: string[];
  working_style?: string;
  values?: string[];
  communication_preferences?: string;
}

export interface ContextObject {
  project_name: string;
  category?: 'coding' | 'topic';
  description: string;
  goals: string[];
  current_status: string;
  status_verified_at?: string;
  status_verified_commit?: string;
  recent_decisions: DecisionEntry[];
  recurring_context: string[];
  tech_stack: string[];
  file_structure_summary: string[];
  current_task: string;
  current_task_source?: 'explicit' | 'extracted';
  current_task_set_at?: string;
  open_questions: string[];
  commands: CommandEntry[];
  hot_paths: HotPathEntry[];
  entrypoints: EntrypointEntry[];
  surfaces: SurfaceEntry[];
  debugging_notes: DebuggingNoteEntry[];
  landmines: LandmineEntry[];
  shipped: ShippedEntry[];
  last_updated: string;
  source_summary: string;
  blocking_issue?: string;
  task_progress?: string;
  next_action?: string;
  last_active_tool?: string;
  last_active_host?: string;
  tool_presence?: Record<string, { last_seen_at: string; host: string }>;
  task_steps?: TaskStep[];
  todo_items?: TodoItem[];
  completed_todos?: TodoItem[];
  /**
   * Present only on a SECTION-FILTERED read view (a teammate reading somebody
   * else's shared project): the names of the sections the share policy withheld
   * and that actually hold content. Names only, never values — it exists so a
   * renderer can say "not shared with you" instead of "nothing here yet".
   */
  withheld_sections?: string[];
}

export interface InjectionPayload {
  tool: ContextTool;
  format: 'conversational' | 'code';
  verbosity: Verbosity;
  body: string;
  degraded_state?: 'degraded';
  degraded_reason?: string;
  provenance?: Array<{
    kind: 'active_project' | 'related_project' | 'session' | 'global';
    label: string;
    project_id?: string;
    node_id?: string;
    confidence?: number;
  }>;
}

export interface ContextDelta {
  category?: 'coding' | 'topic';
  description?: string;
  goals?: string[];
  current_status?: string;
  current_task?: string;
  tech_stack?: string[];
  file_structure_summary?: string[];
  open_questions?: string[];
  recurring_context?: string[];
  recent_decisions?: DecisionEntry[];
  landmines?: LandmineEntry[];
  shipped?: ShippedEntry[];
  resolved_questions?: string[];
  resolved_decisions?: string[];
  resolved_landmines?: string[];
  completed_goals?: string[];
  commands?: CommandEntry[];
  hot_paths?: HotPathEntry[];
  entrypoints?: EntrypointEntry[];
  surfaces?: SurfaceEntry[];
  debugging_notes?: DebuggingNoteEntry[];
  source_summary?: string;
  blocking_issue?: string;
  task_progress?: string;
  next_action?: string;
  task_steps?: TaskStep[];
  you_profile?: YouProfile;
  add_todos?: Array<string | { title: string; phase?: string; body?: string }>;
  move_todos?: Array<{ match: string; phase: string }>;
  complete_todos?: string[];
  remove_todos?: string[];
}

export interface ExtractionResponse {
  match_decision: MatchDecision;
  confidence: number;
  project_candidate?: { project_name: string; reason: string; score?: number } | null;
  delta: ContextDelta;
  should_create_project: boolean;
  needs_user_confirmation: boolean;
  no_material_change?: boolean;
  routing_state?: RoutingState;
  suppression_reason?: string;
  graph?: {
    nodes: Array<{ node_type: GraphNodeType; canonical_key: string; title: string }>;
    edges: Array<{ edge_type: GraphEdgeType; from_node_id?: string; to_node_id?: string; summary?: string }>;
  };
}

export interface ContextSession {
  session_id: string;
  owner_key: string;
  tool: ContextTool;
  surface_type: SurfaceType;
  project_id?: string | null;
  conversation_ref: string;
  cwd: string;
  host: string;
  tab_id: string;
  status: SessionStatus;
  routing_state: RoutingState;
  match_confidence: number;
  last_confirmed_at?: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
}

export interface GraphNode {
  node_id: string;
  owner_key: string;
  project_id?: string | null;
  node_type: GraphNodeType;
  canonical_key: string;
  title: string;
  summary: string;
  metadata: Record<string, unknown>;
  confidence: number;
  source_session_id: string;
  source_tool: GraphSourceTool;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
}

export interface GraphEdge {
  edge_id: string;
  owner_key: string;
  project_id?: string | null;
  edge_type: GraphEdgeType;
  from_node_id: string;
  to_node_id: string;
  summary: string;
  metadata: Record<string, unknown>;
  confidence: number;
  source_session_id: string;
  source_tool: GraphSourceTool;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
}

export interface GraphEvidence {
  evidence_id: string;
  owner_key: string;
  project_id?: string | null;
  session_id: string;
  node_id?: string | null;
  edge_id?: string | null;
  tool: GraphSourceTool;
  excerpt: string;
  metadata: Record<string, unknown>;
  confidence: number;
  created_at: string;
}

export interface GraphExtractionResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  evidence: GraphEvidence[];
}

export interface Provenance {
  kind: 'active_project' | 'related_project' | 'session' | 'global';
  label: string;
  project_id?: string;
  node_id?: string;
  confidence?: number;
}

export interface GraphRetrievalResult {
  project_id?: string | null;
  session_id?: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  evidence: GraphEvidence[];
  related_project_ids: string[];
  summary_lines: string[];
  provenance: Provenance[];
}

export interface ContextRuntimeLayer {
  id: 'direct_context' | 'passive_enrichment' | 'intelligence';
  title: string;
  summary: string;
  status: 'active' | 'warming' | 'limited' | 'idle';
  input_count: number;
  selected_count: number;
  highlights: string[];
}

export interface PassiveEnrichmentItem {
  source: string;
  title: string;
  summary: string;
  source_kind: 'imported' | 'inferred' | 'global' | 'ambient';
  confidence: number;
  freshness: 'live' | 'recent' | 'stale';
  selected: boolean;
  workspace_link_reason: string;
}

export interface ContextSelectionExplanation {
  kind: 'project_context' | 'entity' | 'enrichment';
  label: string;
  reason: string;
  score: number;
  selected: boolean;
  source: string;
}

export interface CurrentUnderstanding {
  workspace_label: string;
  active_project_id?: string | null;
  active_project_name?: string | null;
  current_task: string;
  current_status: string;
  recent_decisions: string[];
  open_questions?: string[];
  hot_paths: string[];
  supporting_evidence: string[];
  related_entities: string[];
  relevant_enrichments: PassiveEnrichmentItem[];
  confidence_summary: string;
}

export interface WorkspaceOverviewResult {
  mode?: 'startup' | 'overview';
  summary: { now: string[]; recent: string[] };
  layers: {
    direct_context: ContextRuntimeLayer;
    passive_enrichment: ContextRuntimeLayer;
    intelligence: ContextRuntimeLayer;
  };
  projects: Array<{
    project_id: string;
    project_name: string;
    updated_at?: string | null;
    context: Record<string, unknown>;
  }>;
  knowledge: GraphNode[];
  tools: GraphNode[];
  capabilities: GraphNode[];
  passive_enrichments: PassiveEnrichmentItem[];
  current_understanding: CurrentUnderstanding;
  selection_explanations: ContextSelectionExplanation[];
  provenance: Provenance[];
  // Compounding-intelligence read side (co-occurrence + shared-workspace surface).
  related_projects: Array<{
    project_id: string;
    project_name: string;
    co_occurrence_count: number;
  }>;
  contributors: Array<{
    user_id: string;
    contributions: number;
    last_at?: string | null;
  }>;
  text?: string;
}

export type WorkspaceEntityType =
  | 'knowledge' | 'decision' | 'question' | 'tool' | 'environment' | 'service'
  | 'database' | 'repo' | 'capability' | 'workflow' | 'preference';

export interface WorkspaceEntityInput {
  entity_type: WorkspaceEntityType;
  title: string;
  summary?: string;
  scope?: 'workspace' | 'project';
  project_id?: string;
  canonical_key?: string;
  metadata?: {
    importance?: DecisionImportance;
    status?: 'active' | 'shipped' | 'experimental' | 'planned' | 'deprecated' | 'stale' | 'resolved' | 'archived';
    pinned?: boolean;
    curation_state?: 'inferred' | 'promoted' | 'curated' | 'stale';
    source_kind?: 'manual' | 'imported' | 'inferred';
    memory_tier?: 'durable' | 'candidate';
    seen_count?: number;
    source_count?: number;
    retrieval_hits?: number;
    last_selected_at?: string;
    last_matched_at?: string;
    source_keys?: string[];
    [key: string]: unknown;
  };
}

export interface WorkspaceRelationInput {
  from_canonical_key: string;
  to_canonical_key: string;
  relation_type: GraphEdgeType;
  summary?: string;
}

export interface NextBestContextSuggestion {
  kind: 'entity' | 'query' | 'open_question';
  label: string;
  reason: string;
  score: number;
  node_id?: string;
  canonical_key?: string;
  query?: string;
}

export interface NextBestContextResult {
  summary: string;
  suggestions: NextBestContextSuggestion[];
  provenance: Provenance[];
}

export interface GlobalContext {
  user_profile: string;
  preferences: string[];
  recurring_instructions: string[];
  global_stack: string[];
  expertise_areas: string[];
  goals: string[];
  working_style: string;
  values: string[];
  communication_preferences: string;
  updated_at?: string;
}

export interface ProjectMatchResult {
  match_decision: MatchDecision;
  confidence: number;
  project_candidate?: { project_id?: string; project_name: string; reason: string; score?: number } | null;
  should_create_project: boolean;
  needs_user_confirmation: boolean;
}

export interface ToolPreference {
  enabled: boolean;
  verbosity: Verbosity;
}

export interface InjectionPreference {
  paused: boolean;
  tools: Record<ContextTool, ToolPreference>;
}

export type SetupSurfaceState = 'not_detected' | 'detected' | 'configured' | 'verified' | 'degraded';

export interface SetupSurfaceStatus {
  id: string;
  label: string;
  mode: 'mcp' | 'global_instructions' | 'workspace_rules' | 'fallback';
  state: SetupSurfaceState;
  detected: boolean;
  configured: boolean;
  verified: boolean;
  runtime_verified: boolean;
  status_basis: 'config' | 'runtime';
  path?: string | null;
  backup_path?: string | null;
  last_seen_at?: string | null;
  runtime_version?: string | null;
  last_error?: string | null;
  stale: boolean;
  degraded_reason?: string | null;
  config_has_deerdawn_mcp?: boolean;
  config_format_valid?: boolean;
  env_key_present?: boolean;
  saved_key_present?: boolean;
  /** DeerDawn's instruction block in this tool's file with no DeerDawn server registered for the tool. Kept until asked. */
  stale_block?: { path: string; tool: string; removable: boolean; remove_with: string | null; summary: string } | null;
  /** A DeerDawn block written by another install (a file synced between machines): kept, nothing written beside it. */
  foreign_block?: { path: string; tool: string; summary: string; adopt_with?: string } | null;
}

export interface SetupStatusResult {
  authenticated: boolean;
  setup_complete: boolean;
  configured_count: number;
  verified_count: number;
  runtime_verified_count: number;
  pending_sign_in_url?: string | null;
  diagnostics?: {
    env_key_present: boolean;
    saved_key_present: boolean;
    pending_auth_state: 'none' | 'pending' | 'error' | 'expired';
    api_reachable: 'unchecked' | 'reachable' | 'unreachable';
    /** Files that hold the API key in plain text where the tool does not read one. */
    plain_text_keys?: Array<{ path: string; tool: string; entry: string | null; readable?: boolean; remove_with: string | null; summary: string }>;
    next_action?: string;
  };
  execution_source?: 'desktop_bridge' | 'dashboard_fallback' | 'local_direct' | 'unavailable';
  surfaces: SetupSurfaceStatus[];
}

export interface SetupApplyResult {
  surface: string;
  mode: 'auto' | 'repair' | 'restore';
  applied: boolean;
  already_configured?: boolean;
  execution_source?: 'desktop_bridge' | 'dashboard_fallback' | 'local_direct' | 'unavailable';
  status: SetupStatusResult;
  changed_paths: string[];
  restored_from_backup?: string | null;
}

// ─── Zod schemas (runtime validators mirroring the interfaces above) ────────
// Typed loosely (z.ZodTypeAny) rather than z.ZodType<Interface> — the schemas'
// exact zod-internal shape (defaults/transforms/refinements) isn't 1:1 with the
// plain TS interfaces above, and no current TS consumer imports these directly
// (they parse plain JS objects at the JSON boundary). Declaring them (instead of
// omitting them, as this file did before) is the fix; a fully shape-accurate
// zod type can follow if/when a TS consumer actually needs it.
export declare const YouProfileSchema: z.ZodTypeAny;
export declare const CommandEntrySchema: z.ZodTypeAny;
export declare const ContextObjectSchema: z.ZodTypeAny;
export declare const ContextDeltaSchema: z.ZodTypeAny;
export declare const ContextEventSchema: z.ZodTypeAny;
export declare const ContextSessionSchema: z.ZodTypeAny;
export declare const GraphNodeSchema: z.ZodTypeAny;
export declare const GraphEdgeSchema: z.ZodTypeAny;
export declare const GraphEvidenceSchema: z.ZodTypeAny;
export declare const GraphExtractionResultSchema: z.ZodTypeAny;
export declare const GraphRetrievalResultSchema: z.ZodTypeAny;
export declare const SetupApplyResultSchema: z.ZodTypeAny;
export declare const SetupStatusResultSchema: z.ZodTypeAny;
export declare const SetupSurfaceStateSchema: z.ZodTypeAny;
export declare const SetupSurfaceStatusSchema: z.ZodTypeAny;
export declare const ContextRuntimeLayerSchema: z.ZodTypeAny;
export declare const PassiveEnrichmentItemSchema: z.ZodTypeAny;
export declare const ContextSelectionExplanationSchema: z.ZodTypeAny;
export declare const CurrentUnderstandingSchema: z.ZodTypeAny;
export declare const WorkspaceEntityInputSchema: z.ZodTypeAny;
export declare const WorkspaceEntityTypeSchema: z.ZodTypeAny;
export declare const WorkspaceRelationInputSchema: z.ZodTypeAny;
export declare const SubagentBriefRequestSchema: z.ZodTypeAny;
export declare const SubagentBriefSourceSchema: z.ZodTypeAny;
export declare const SubagentBriefResultSchema: z.ZodTypeAny;
export declare const NextBestContextResultSchema: z.ZodTypeAny;
export declare const NextBestContextSuggestionSchema: z.ZodTypeAny;
export declare const WorkspaceOverviewModeSchema: z.ZodTypeAny;
export declare const WorkspaceOverviewResultSchema: z.ZodTypeAny;
export declare const WorkspaceOverviewSectionSchema: z.ZodTypeAny;
export declare const GlobalContextSchema: z.ZodTypeAny;
export declare const ExtractionRequestSchema: z.ZodTypeAny;
export declare const ExtractionResponseSchema: z.ZodTypeAny;
export declare const ProjectMatchResultSchema: z.ZodTypeAny;
export declare const InjectionPreferenceSchema: z.ZodTypeAny;
export declare const InjectionPayloadSchema: z.ZodTypeAny;
export declare const ToolPreferenceSchema: z.ZodTypeAny;
export declare const DecisionEntrySchema: z.ZodTypeAny;
export declare const LandmineEntrySchema: z.ZodTypeAny;
export declare const ShippedEntrySchema: z.ZodTypeAny;

export declare function createContextObject(input: Partial<ContextObject> & { project_name: string }): ContextObject;
export declare function capDecisions<T extends { summary: string; importance?: string; resolved?: boolean }>(decisions: T[], options?: { cap?: number; keep?: string[] }): T[];
export declare function mergeContextObject(current: ContextObject, delta: ContextDelta, sourceSummary?: string): ContextObject;
export declare function formatConversationalInjection(context: ContextObject, verbosity?: Verbosity, global?: GlobalContext | null, options?: { now?: string; tz?: string }): InjectionPayload;
export declare function formatCodeInjection(context: ContextObject, verbosity?: Verbosity, global?: GlobalContext | null, options?: { now?: string; tz?: string; cwd?: string }): InjectionPayload;
export declare function formatBriefInjection(context: ContextObject, verbosity?: Verbosity, global?: GlobalContext | null, options?: { now?: string; tz?: string }): InjectionPayload;
export declare function formatSubagentBrief(input: Record<string, unknown>): {
  version: 1;
  marker: string;
  text: string;
  project_id: string;
  project_name: string;
  context_updated_at?: string | null;
  generated_at: string;
  estimated_tokens: number;
  max_tokens: number;
  omitted_count: number;
  sources: Array<Record<string, unknown>>;
};
export declare const SUBAGENT_BRIEF_MARKER: string;
export declare function formatGlobalOnlyInjection(global: GlobalContext, verbosity?: Verbosity): InjectionPayload;
export declare function formatMapInjection(
  projects?: Array<{ project_id?: string; project_name: string; updated_at?: string | null; context?: Record<string, unknown> }>,
  global?: GlobalContext | null,
  options?: { mcpAvailable?: boolean; activeProjectId?: string | null; now?: string | null; tz?: string | null },
): string;
export declare function formatSectionInjection(context: ContextObject, sections?: string[], global?: Record<string, unknown> | null): string;
/** Human labels for `context.withheld_sections`; empty when nothing is withheld. */
export declare function withheldSectionLabels(context: ContextObject | null | undefined): string[];
/** One line naming what the share policy withheld, or null when nothing was. */
export declare function formatWithheldSectionsLine(
  context: ContextObject | null | undefined,
  options?: { prefix?: string },
): string | null;
export declare function formatWorkspaceOverview(overview: Partial<WorkspaceOverviewResult>, verbosity?: Verbosity): string;

/** One entity or decision the account recorded in more than one project. */
export interface PortfolioResult {
  /** True when the plan withholds contents; `counts` is still the real numbers. */
  locked?: boolean;
  counts?: { projects?: number; decisions?: number; shared_entities?: number };
  entities?: {
    total?: number;
    entries?: Array<{
      node_id?: string;
      title?: string;
      summary?: string;
      entity_type?: string;
      node_type?: string;
      shared_reason?: 'cross_project' | 'workspace_scope';
      project_count?: number;
      projects?: Array<{ project_id?: string; project_name?: string | null }>;
      updated_at?: string | null;
    }>;
  };
  decisions?: {
    total?: number;
    entries?: Array<{
      project_id?: string;
      project_name?: string;
      summary?: string;
      reasoning?: string | null;
      decided_at?: string | null;
      importance?: string;
      date_inferred?: boolean;
    }>;
  };
}
export declare function formatPortfolio(
  portfolio: PortfolioResult | null | undefined,
  options?: { entityLimit?: number; decisionLimit?: number },
): string;

/** One call resolves at most one question; `reason` says which of the three
 *  outcomes happened and the refusals carry the text needed to retry. */
export interface QuestionResolutionOutcome {
  reason?: 'resolved' | 'ambiguous' | 'unmatched';
  /** The question actually removed, on reason 'resolved'. */
  resolved?: string | null;
  /** The open questions an ambiguous query fell between. */
  candidates?: string[];
  /** The questions still open after the call — printed on a miss so the caller can retry exactly. */
  open_questions?: string[];
}
export declare function formatQuestionResolution(
  query: string,
  outcome?: QuestionResolutionOutcome,
): string;
/** finish_task: what a wrap-up review shows, as keys (see taskReview.js). */
export interface TaskReviewItems {
  questions: string[];
  blocker: string;
  commands: string[];
}
export declare function taskReviewItems(
  context: Record<string, any> | null | undefined,
  options?: { digest?: (key: string) => string },
): TaskReviewItems;
export interface ReviewedCompletionPlan {
  patch: { open_questions?: string[]; commands?: any[]; blocking_issue?: string };
  hidden: Array<'commands' | 'open_questions' | 'blocking_issue'>;
  cleared: { questions: number; blocker: boolean; commands: number };
  stayed: { questions: string[]; blocker: string; commands: number };
}
export declare function planReviewedCompletion(
  context: Record<string, any> | null | undefined,
  reviewed: TaskReviewItems | null | undefined,
  options?: { digest?: (key: string) => string },
): ReviewedCompletionPlan;
export declare function describeTaskState(counts?: { questions?: number; blocker?: boolean; commands?: number }): string[];
export declare const NO_REVIEW_ON_RECORD: string;
export declare function stayedOutside(stayed: ReviewedCompletionPlan['stayed'] | null | undefined, skippedSections: Iterable<string> | Set<string>): ReviewedCompletionPlan['stayed'];
export declare function orderLeftSections(sections: Iterable<string>): string[];
export declare function formatLeftAfterReview(stayed: ReviewedCompletionPlan['stayed'] | null | undefined): string;
export declare function buildMcpServerConfigObject(apiUrl?: string, apiKey?: string, workspaceId?: string): {
  command: 'npx';
  args: ['-y', '@deerdawn/mcp-server@latest'];
  env: { DEERDAWN_API_URL: string; DEERDAWN_WORKSPACE?: string; DEERDAWN_API_KEY?: string };
};
export declare function formatMcpJsonConfig(apiUrl?: string, apiKey?: string, workspaceId?: string): string;
export declare function formatCodexMcpTomlConfig(apiUrl?: string, apiKey?: string): string;
export declare function inferSurfaceType(tool: ContextTool | string): SurfaceType;
export declare function timeAgo(isoString?: string | null): string;
export declare function hasCriticalDecision(decisions?: DecisionEntry[]): boolean;
export declare function deriveItemTrust(item: { verified_at?: string; confidence?: number; date_inferred?: boolean; source_kind?: string; source?: string } | null | undefined): 'high' | 'inferred' | 'unverified';

export interface BriefSpineItem {
  text: string;
  trust: 'high' | 'inferred' | 'unverified';
  source_tool?: string | null;
  date?: string | null;
  importance?: DecisionImportance;
  reasoning?: string | null;
  paths?: string[];
  pinned?: boolean;
  commit_ref?: string | null;
  /** A shipped line that came from a Done board card: a surface labels it "Shipped", not "Verified". */
  from_card?: boolean;
}

export interface BriefSpine {
  shipped: BriefSpineItem[];
  decided: BriefSpineItem[];
  open: BriefSpineItem[];
  landmine: BriefSpineItem[];
  shipped_header?: { text: string; verified: boolean };
}

export declare function followBoardCardsInShipped(
  shipped: ShippedEntry[] | undefined,
  boards: { before?: Array<{ id?: string; title?: string; phase?: string }>; after?: Array<{ id?: string; title?: string; phase?: string }>; evictedDoneIds?: Set<string> },
): { list: ShippedEntry[]; changed: boolean };
export declare function buildBriefSpine(context?: Partial<ContextObject>, global?: GlobalContext | null, options?: { now?: string; tz?: string }): BriefSpine;
export declare function extractStructuredFields(rawText: string): ContextDelta;

// ─── Injection-boundary text safety (C3/M12) ────────────────────────────────
export declare function neutralizeInjectedText(value: string): string;
export declare function clipText(value: unknown, maxChars: number): string;
export declare function proseBudget(verbosity: string, base: number): number;
export declare function redactSecretText(value: string): string;

export interface SkillIndexEntry {
  name: string;
  description?: string;
  slug: string;
}

export interface SkillFrontmatterMeta {
  name?: string;
  slug?: string;
  description?: string;
}

export declare function buildSkillsIndexBlock(skills: SkillIndexEntry[]): string;
export declare function toClaudeSkillMd(meta: SkillFrontmatterMeta, body: string): string;
export declare function toCursorMdc(meta: SkillFrontmatterMeta, body: string): string;
export declare function parseSkillFrontmatter(md: string): { name: string; description: string };

// ─── Task board ──────────────────────────────────────────────────────────────
export type BoardPhase = 'backlog' | 'blocked' | 'in_progress' | 'integration' | 'testing' | 'done';
export declare const BOARD_PHASES: BoardPhase[];
export declare const BOARD_PHASE_LABELS: Record<BoardPhase, string>;
export interface TodoItem {
  id: string;
  title: string;
  /** Free-form card detail, clipped at MAX_TODO_BODY_CHARS. Never rendered in a listing. */
  body?: string;
  phase?: string;
  kind?: 'step';
  created_at?: string;
  updated_at?: string | null;
  completed_at?: string | null;
}
export interface TaskCardInput {
  title: string;
  body?: string;
  phase?: string;
}
export interface BoardColumn {
  phase: BoardPhase;
  label: string;
  cards: TodoItem[];
}
export declare function normalizeBoardPhase(value: unknown): BoardPhase;
export declare function buildTaskBoard(context: Record<string, unknown> | null | undefined): BoardColumn[];
export interface TaskBoardSnapshot {
  project_id?: string;
  project_name: string;
  board: BoardColumn[];
  counts_by_phase: Record<string, number>;
  total_cards: number;
  open_cards: number;
}
export declare function buildTaskBoardSnapshot(
  context: Record<string, unknown> | null | undefined,
  project?: { project_id?: string; project_name?: string },
): TaskBoardSnapshot;
/**
 * A card as it appears in a LISTING: the body is replaced by a flag, because a
 * body is something you open, not something you scan past.
 */
export interface TodoListingItem extends Omit<TodoItem, 'body'> {
  has_body?: boolean;
}
/**
 * A listing column: `cards` is BOUNDED, so read the count from `total` (storage)
 * and never from `cards.length` (this view).
 */
export interface BoardListingColumn extends Omit<BoardColumn, 'cards'> {
  cards: TodoListingItem[];
  total: number;
  returned: number;
  has_more: boolean;
}
export interface TaskBoardListingSnapshot extends TaskBoardSnapshot {
  board: BoardListingColumn[];
}
/**
 * `cards_per_phase` is a REQUEST, not a guarantee: it is clamped to 1..50 and
 * lowered further when the whole listing would exceed the total card budget.
 * Read each column's real size from `total`, never from `cards.length`.
 */
export declare function taskBoardSnapshotForListing(
  snapshot: TaskBoardSnapshot,
  options?: { cards_per_phase?: number },
): TaskBoardListingSnapshot;
export declare function formatTaskBoardText(
  snapshot: TaskBoardSnapshot,
  options?: { cards_per_phase?: number },
): string;
export declare const MAX_TODO_BODY_CHARS: number;
/** Largest .dawn archive import_trail accepts as contents, on both dispatchers. */
export declare const MAX_TRAIL_CHARS: number;
/** JSON body limit for POST /api/v1/context/extraction, in bytes. */
export declare const MAX_EXTRACTION_BODY_BYTES: number;
/** What a client may serialize for that route before it must trim, in bytes. */
export declare const EXTRACTION_BODY_BUDGET_BYTES: number;
export declare const TASK_BODY_MARKER: string;
export declare function normalizeTodoBody(value: unknown): string | undefined;
export declare function normalizeTaskCardInputs(
  entries: Array<string | TaskCardInput> | null | undefined,
  defaultPhase?: string,
): TaskCardInput[];
export declare function taskCardBodyWasClipped(value: unknown): boolean;
export type TaskCardResolution =
  | { status: 'matched'; query: string; card: any }
  | { status: 'ambiguous'; query: string; candidates: Array<{ id: string; title: string; phase?: string }> }
  | { status: 'unmatched'; query: string };
/**
 * Resolve exactly one card: exact id, then exact title, then containment — each
 * tier counts only when it lands on ONE card. Ambiguity refuses.
 */
export declare function resolveTaskCard(cards: any[] | null | undefined, query: unknown): TaskCardResolution;
/** Render named cards in full, including their body. The only renderer that prints one. */
export declare function formatTaskCardDetail(
  context: Record<string, unknown> | null | undefined,
  queries: string[] | null | undefined,
  options?: { max_matches?: number },
): string;
export declare const TASK_BOARD_WIDGET_URI: string;
export declare const TASK_BOARD_WIDGET_MIME: string;
export declare function isTaskBoardUiEnabled(env?: Record<string, string | undefined>): boolean;
export declare function taskBoardToolMeta(): Record<string, unknown>;
export declare function taskBoardResource(): { uri: string; name: string; description: string; mimeType: string };
export declare function taskBoardWidgetHtml(): string;
export interface ArchivedProjectSummary {
  project_id: string;
  project_name: string;
  archived_at?: string;
}
export declare function formatArchivedProjectsNotice(
  archived: ArchivedProjectSummary[] | null | undefined,
): string;
export declare const LISTING_ARCHIVED_SHOWN: number;
export declare const ARCHIVED_PROJECTS_FETCH_LIMIT: number;
export interface ProjectListingNode {
  project_id: string;
  project_name: string;
  context?: { current_task?: string | null } | null;
  subprojects?: ProjectListingNode[] | null;
}
export interface ProjectListingData {
  projects: Array<{
    project_id: string;
    project_name: string;
    current_task?: string;
    subprojects: Array<{ project_id: string; project_name: string; current_task?: string }>;
  }>;
  archived_projects?: Array<{ project_id: string; project_name: string; archived: true; archived_at?: string }>;
  archived_total?: number;
}
export declare function formatProjectListing(
  tree: ProjectListingNode[] | null | undefined,
  archived: ArchivedProjectSummary[] | null | undefined,
): { text: string; data: ProjectListingData };
export declare function formatProjectArchivedReply(
  project: { project_id?: string | null; project_name?: string | null } | null | undefined,
): string;

// ── Multi-agent coordination ─────────────────────────────────────────────────
// Presence, board holds, and brief staleness. Declared here because this file is
// hand-maintained: an export added to index.js but not to this file typechecks
// fine in CommonJS and fails the mcp-server build.
// See docs/MULTI-AGENT-COORDINATION-PLAN-2026-08.md.
export declare const PRESENCE_WINDOW_SECONDS: number;
export declare const PRESENCE_IDLE_SECONDS: number;
export declare const HOLD_TTL_MS: number;
export interface TodoCardLike {
  id?: string;
  title?: string;
  phase?: string;
  held_by?: string | null;
  held_at?: string | null;
}
export interface HoldState {
  held: boolean;
  holder: string | null;
  ageMs: number | null;
  expired: boolean;
}
export declare function holdState(card: TodoCardLike | null | undefined, nowMs?: number): HoldState;
export declare function isHeldByOther(
  card: TodoCardLike | null | undefined,
  sessionId: string | null | undefined,
  nowMs?: number,
): boolean;
export declare function partitionHeldCards<T extends TodoCardLike>(
  cards: T[] | null | undefined,
  sessionId: string | null | undefined,
  nowMs?: number,
): { available: T[]; excluded: Array<{ card: T; holder: string | null; age: string | null }> };
export declare function formatExcludedLine(
  excluded: Array<{ holder: string | null }> | null | undefined,
): string | null;
export declare function applyHold<T extends TodoCardLike>(
  card: T,
  phase: string,
  sessionId: string | null | undefined,
  nowIso: string,
): T;
export interface PresencePeer {
  session_id: string;
  tool?: string | null;
  last_seen_at?: string | null;
  cwd?: string | null;
  held_cards?: Array<{ title?: string } | string> | null;
  scope?: string[] | null;
}
export declare function formatPresenceBlock(
  peers: PresencePeer[] | null | undefined,
  options?: { now?: string },
): string | null;
export declare function formatStalenessBanner(
  changes: Array<string | null | undefined> | null | undefined,
  options?: { max?: number },
): string | null;
export declare function isBriefStale(
  briefedWatermark: string | null | undefined,
  currentWatermark: string | null | undefined,
): boolean;
export declare function relativeAge(fromIso: string | null | undefined, nowMs?: number): string | null;
export interface BriefReceiptInput {
  projectName: string | null | undefined;
  decisions?: number | null;
  openQuestions?: number | null;
  lastSavedAt?: string | Date | null;
  /** Tool id the last save came from; only when known (see briefReceiptInputs). */
  lastSavedTool?: string | null;
  nextAction?: string | null;
  now?: string | number | Date;
}
/**
 * `DeerDawn loaded {Project}: {n} decisions, {n} open questions, last saved {when}{ in tool}. Next: {next_action}`
 * Unknown parts are omitted; null when there is no project name.
 */
export declare function formatBriefReceipt(input: BriefReceiptInput): string | null;
export declare function briefReceiptInputs(
  project: { project_name?: string | null; updated_at?: string | Date | null; context?: Record<string, unknown> | null } | null | undefined,
  options?: { now?: string | number | Date },
): BriefReceiptInput | null;
export declare function receiptToolLabel(tool: string | null | undefined): string | null;
export declare function receiptWhen(at: string | Date | null | undefined, now?: string | number | Date): string | null;
