import { resolveRuntimeAuthToken } from './authToken';
import type { ShareSectionRow } from './shareSections';
// No runtime cycle: workspaceRecovery imports only a TYPE from here.
import {
  WORKSPACE_FORBIDDEN_WRITE_MESSAGE,
  shouldReplayAfterWorkspaceForbidden,
} from './workspaceRecovery';
import { isLeavingRemovedWorkspace, noteRemovedFromWorkspace } from './workspaceRemoval';
// workspaceFallback imports nothing at runtime, so no cycle either way.
import { listingEndsRecordedFallback, readProvesWorkspaceServing } from './workspaceFallback';
import type { WorkspaceFallbackResponse } from './workspaceFallback';

function normalizeApiBaseUrl(value: string | undefined) {
  const getLocalBrowserApiUrl = () => {
    if (typeof window === 'undefined') return null;
    const hostname = window.location.hostname;
    const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0';
    return isLocalHost ? `http://${hostname}:8080` : null;
  };

  const raw = (value || '').trim();
  const isDev = process.env.NODE_ENV !== 'production';
  const fallback = isDev ? (getLocalBrowserApiUrl() || 'http://localhost:8080') : 'https://api.deerdawn.com';
  if (!raw) return fallback;
  if (isDev && raw === 'https://api.deerdawn.com') return getLocalBrowserApiUrl() || 'http://localhost:8080';
  if (raw.startsWith('/')) return raw.replace(/\/$/, '');
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw.replace(/\/$/, '');

  const isLocal = raw.startsWith('localhost') || raw.startsWith('127.0.0.1') || raw.startsWith('0.0.0.0');
  const scheme = isLocal ? 'http://' : 'https://';
  return `${scheme}${raw}`.replace(/\/$/, '');
}

const API_URL = normalizeApiBaseUrl(process.env.NEXT_PUBLIC_API_URL);
/** The API origin every request goes to (NEXT_PUBLIC_API_URL, normalised). */
export const getApiBaseUrl = (): string => API_URL;
const CSRF_COOKIE_KEYS = ['dd_csrf', 'csrf_token', 'XSRF-TOKEN'];
const CLERK_TOKEN_TTL_MS = 30_000;
const FETCH_TIMEOUT_MS = 8_000;

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;
  /**
   * The server's own id for this failure. apps/api's error handler attaches
   * request_id to every error body it returns AND logs the same id — but this
   * client parsed message/code/details and dropped it, so no surface could show
   * one. Bug reports read "it broke" against logs keyed by an id the user was
   * never shown. With roughly one active user there is no second report to
   * triangulate against, so the id IS the diagnosis.
   */
  requestId?: string;
  /**
   * The parsed JSON error body, verbatim. Several routes (teams, invites) name
   * the failure in `error` and carry context beside it (`invited_email`), and
   * callers read `err.data.error` to say which failure it was. Nothing set this
   * before, so every one of those branches was dead and "sent to a different
   * address" rendered as "invalid or revoked".
   */
  data?: Record<string, unknown>;

  constructor(status: number, message: string, code?: string, details?: unknown, requestId?: string, data?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
    this.data = data;
  }
}

/**
 * The machine-readable reason for a failure: `code` when the route sets one,
 * otherwise the body's `error` when it is a bare identifier. Teams routes answer
 * `{ error: 'workspace_forbidden', message }`, which never reached `code`.
 */
export function apiErrorReason(error: unknown): string | undefined {
  if (!isApiError(error)) return undefined;
  if (error.code) return error.code;
  const raw = error.data?.error;
  return typeof raw === 'string' && /^[a-z][a-z0-9_]*$/.test(raw) ? raw : undefined;
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export interface DashboardBootstrap {
  status: 'ok' | 'error';
  // What kind of install this is (lib/deployment.ts). Absent on an older API,
  // which is always hosted.
  deployment?: {
    self_hosted: boolean;
    billing_enabled: boolean;
    telemetry_enabled: boolean;
    signup_mode: 'open' | 'invite_only';
    auth_provider: 'clerk' | 'local';
    source_code_url?: string;
  };
  error_code?: string | null;
  user: { id: string; email: string; role: string };
  sync_health?: {
    has_projects: boolean;
    last_synced: string | null;
    recently_active: boolean;
    // The user's first context delivery into any tool — the funnel's activation
    // moment, recorded once per user server-side. Durable, unlike the onboarding
    // page's connection poll.
    first_synced_at?: string | null;
    has_first_sync?: boolean;
    // Distinct UTC days THIS PERSON called DeerDawn from an AI tool, reads
    // included. Gates the upgrade asks (lib/firstSyncMoment.ts activeEnoughToAsk).
    active_days?: number;
    desktop_connected: boolean;
    mcp_registered: boolean;
    // A hosted connector (ChatGPT, claude.ai) holds a live OAuth credential for
    // this person, whether or not it has called yet. Display only: NOT
    // connection evidence (see lib/connectionEvidence.ts).
    connector_authorized?: boolean;
    connector_client_name?: string | null;
    mcp_surfaces?: Array<{
      surface: string;
      start_sessions: number;
      start_session_skips: number;
      update_contexts: number;
      tool_calls: number;
      last_called_at: string | null;
      call_rate: number | null;
    }>;
    // The same calls by WHICH TOOL and HOW IT CONNECTED (local_stdio,
    // hosted_oauth, hosted_api_key, rest_api, or hosted for older rows). `tool`
    // is null for a client nothing could name. Absent on an older API.
    mcp_tools?: Array<{
      tool: string | null;
      transport: string | null;
      start_sessions: number;
      start_session_skips: number;
      update_contexts: number;
      tool_calls: number;
      handshakes: number;
      last_called_at: string | null;
    }>;
    command_capture?: {
      active_task_project_id: string | null;
      active_task_project_name: string | null;
      active_task_label: string | null;
      open_task_command_count: number;
      last_captured_command_at: string | null;
    };
    session_stats?: {
      total_sessions: number;
      first_session_at: string | null;
    };
    execution_source?: 'desktop_bridge' | 'dashboard_fallback' | 'local_direct' | 'unavailable';
    verified_surfaces?: number;
    setup_complete?: boolean;
  };
  setup_status?: SetupStatusResult | null;
  org: {
    id: string;
    name: string;
    account_type: string;
    plan_tier: string;
    plan_label?: string;
    subscription_status: string;
    trial_ends_at?: string | null;
    billing_period_start?: string | null;
    billing_period_end?: string | null;
    stripe_customer_id?: string | null;
    /** When this workspace's Team trial started (Stripe-confirmed); null or absent = never had one. */
    team_trial_started_at?: string | null;
    shadow_mode: boolean;
    onboarding_template: string;
    referral_premium_until?: string | null;
    referral_premium_active?: boolean;
    unsupported_workspace?: boolean;
    unsupported_reason?: string | null;
  };
  onboarding: {
    template: string;
    template_label: string;
    progress: Record<string, boolean>;
    recommended_next_step: string;
    activation: {
      next_step: string;
      recommended_policy_template: string;
      sample_action_type: string;
      sample_payload: Record<string, unknown>;
    };
    completed_steps: number;
    total_steps: number;
  };
  usage: {
    integrations: number;
    admins: number;
    api_keys: number;
    limits: Record<string, number | null>;
    syncs?: UsageSummary | null;
  };
  entitlements: {
    tier: string;
    limits: Record<string, number | null>;
    features: Record<string, boolean>;
  };
  shell: {
    status: 'operational' | 'shadow';
    pending_escalations: number;
    audit_events: number;
    counts: {
      integrations: number;
      api_keys: number;
      decisions: number;
      policies: number;
    };
    nav: {
      show_escalations: boolean;
      show_audit: boolean;
      show_usage: boolean;
      show_playground: boolean;
    };
    visible_navigation: {
      show_escalations: boolean;
      show_audit: boolean;
      show_usage: boolean;
      show_playground: boolean;
    };
  };
  billing: {
    plan_tier: string;
    overage_per_decision?: number | null;
    remaining_trial_actions?: number | null;
    referral_premium_until?: string | null;
    referral_premium_active?: boolean;
    subscription_status: string;
    trial_ends_at?: string | null;
    billing_period_end?: string | null;
    self_serve: boolean;
    unsupported_workspace?: boolean;
    usage_summary?: UsageSummary | null;
  };
  metrics: {
    total_decisions: number;
    escalation_rate: string;
    avg_latency: string;
    policies_enabled: number;
  };
  cta: {
    next_step: string;
    recommended_label: string;
  };
  recent_decisions: Array<{
    id: string;
    ts: string;
    action: string;
    decision: 'allow' | 'deny' | 'escalate';
    policy: string;
    latency: string;
    trace_id: string;
    environment?: string;
    summary?: string;
    shadow?: boolean;
  }>;
}

export interface ContentPage {
  content_id?: string;
  content_type: 'use_case' | 'comparison' | 'blog_post' | 'doc' | 'faq' | 'example' | 'resource';
  slug: string;
  title: string;
  description: string;
  body_markdown: string;
  seo_title?: string | null;
  seo_description?: string | null;
  canonical_path?: string | null;
  og_image?: string | null;
  tags: string[];
  category?: string | null;
  status: 'draft' | 'scheduled' | 'published' | 'archived';
  cta_label?: string | null;
  cta_href?: string | null;
  specialized: Record<string, unknown>;
  published_at?: string | null;
  scheduled_at?: string | null;
  updated_at?: string;
}

export interface ContextProjectSummary {
  project_id: string;
  project_name: string;
  updated_at: string;
  aliases?: string[];
  context: {
    project_name?: string;
    description?: string;
    goals?: string[];
    current_status?: string;
    current_task?: string;
    tech_stack?: string[];
    open_questions?: string[];
    recent_decisions?: Array<{ summary: string; decided_at?: string } | string>;
    recurring_context?: string[];
    blocking_issue?: string;
    task_progress?: string;
    source_summary?: string;
  };
  // Subproject hierarchy. parent_project_id is set on a child; subprojects is
  // populated only by the tree endpoint (nested under their umbrella).
  parent_project_id?: string | null;
  subprojects?: ContextProjectSummary[];
}

// ── Portfolio ────────────────────────────────────────────────────────────────
// One shape for both tiers. `locked` says whether the contents came back; the
// counts are always the account's real numbers, which is what the locked state
// is built to show. Entity and decision entries are Partial on purpose: a locked
// response carries the row count and nothing else, and the type should force the
// UI to handle that rather than let it read `.title` off a redacted row.
export interface PortfolioEntity {
  node_id: string;
  title: string;
  summary: string;
  entity_type: string;
  node_type: string;
  shared_reason: 'cross_project' | 'workspace_scope';
  project_count: number;
  projects: { project_id: string; project_name: string }[];
  updated_at: string;
}

export interface PortfolioDecision {
  project_id: string;
  project_name: string;
  summary: string;
  reasoning: string | null;
  decided_at: string | null;
  importance: string;
  date_inferred: boolean;
}

export interface Portfolio {
  locked: boolean;
  counts: { projects: number; decisions: number; shared_entities: number };
  entities: { total: number; entries: Partial<PortfolioEntity>[] };
  decisions: { total: number; entries: Partial<PortfolioDecision>[] };
}

// ── Share links ──────────────────────────────────────────────────────────────
export interface ShareScanFinding {
  id: string;
  path: string;
  section: string;
  category: string;
  severity: 'high' | 'medium' | 'low';
  excerpt: string;
}

export interface ShareScan {
  scanner_version: number;
  scanned_at: string;
  counts: { total: number; by_category: Record<string, number>; by_severity: Record<string, number> };
  findings: ShareScanFinding[];
  unresolved_count?: number;
}

export interface ShareLink {
  // null when the link exists but this reader may not hold it: the token is the
  // read credential, and it goes only to the link's author, the project's author
  // and workspace owners (token_withheld is then true).
  token: string | null;
  token_withheld?: boolean;
  ref_code?: string | null;
  project_id: string;
  project_name: string | null;
  visibility: 'unlisted' | 'public';
  created_at: string;
  revoked_at: string | null;
  last_viewed_at: string | null;
  view_count: number;
}

// Thrown by createShareLink / setShareVisibility when the scan found something.
// It carries the findings so the caller can show them — a share refusal that
// doesn't say what it objected to is unactionable.
export class ShareScanError extends Error {
  scan: ShareScan;
  constructor(message: string, scan: ShareScan) {
    super(message);
    this.name = 'ShareScanError';
    this.scan = scan;
  }
}

export interface SharedSkill {
  skill_id: string;
  slug: string;
  name: string;
  description: string;
  // Only present on the single-skill (detail) fetch — the list endpoint omits
  // the full SKILL.md body to keep the index payload small.
  markdown_content?: string;
  visibility: 'private' | 'shared' | 'public';
  enabled: boolean;
  // null = workspace-wide; a project id scopes the skill to that project.
  project_id: string | null;
  // Whether THIS person may change the skill: its author, or a workspace owner.
  // Absent from an API that predates the field, which reads as "may" so nothing
  // that worked before is hidden; the write gate still has the last word.
  can_edit?: boolean;
}

export interface ContextGraphNode {
  node_id: string;
  project_id?: string | null;
  node_type: string;
  title: string;
  summary: string;
  confidence: number;
  canonical_key: string;
  metadata: Record<string, unknown>;
}

export interface VaultHealthResult {
  total: number;
  active: number;
  resolved_or_archived: number;
  candidates: number;
  durable: number;
  pinned: number;
  stale_unused: number;
  avg_confidence: number;
  computed_at: string;
}

export interface ContextGraphEdge {
  edge_id: string;
  project_id?: string | null;
  edge_type: string;
  from_node_id: string;
  to_node_id: string;
  summary: string;
  confidence: number;
}

export interface ContextGraphEvidence {
  evidence_id: string;
  project_id?: string | null;
  session_id: string;
  node_id?: string | null;
  edge_id?: string | null;
  tool: string;
  excerpt: string;
  confidence: number;
  created_at: string;
  metadata: Record<string, unknown>;
}

export interface ContextGraphResult {
  project_id?: string | null;
  session_id?: string | null;
  nodes: ContextGraphNode[];
  edges: ContextGraphEdge[];
  evidence: ContextGraphEvidence[];
  related_project_ids: string[];
  summary_lines: string[];
  provenance: Array<{
    kind: 'active_project' | 'related_project' | 'session' | 'global';
    label: string;
    project_id?: string;
    node_id?: string;
    confidence?: number;
  }>;
}

export interface WorkspaceOverviewSummary {
  now: string[];
  recent: string[];
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
  hot_paths: string[];
  supporting_evidence: string[];
  related_entities: string[];
  relevant_enrichments: PassiveEnrichmentItem[];
  confidence_summary: string;
}

export interface WorkspaceOverviewResult {
  mode?: 'startup' | 'overview';
  summary: WorkspaceOverviewSummary;
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
  knowledge: ContextGraphNode[];
  tools: ContextGraphNode[];
  capabilities: ContextGraphNode[];
  passive_enrichments: PassiveEnrichmentItem[];
  current_understanding: CurrentUnderstanding;
  selection_explanations: ContextSelectionExplanation[];
  provenance: Array<{
    kind: 'active_project' | 'related_project' | 'session' | 'global';
    label: string;
    project_id?: string;
    node_id?: string;
    confidence?: number;
  }>;
  text?: string;
}

export interface ReferralRecord {
  referral_id: string;
  referral_code: string;
  referrer_user_id: string;
  referrer_org_id: string;
  referred_user_id: string;
  referred_org_id: string;
  status: string;
  activation_reason?: string | null;
  reward_tier?: string | null;
  reward_expires_at?: string | null;
  activated_at?: string | null;
  rewarded_at?: string | null;
  created_at?: string;
}

export interface ReferralOverview {
  /** Only accounts that have completed a first sync can refer. */
  eligible: boolean;
  /** Null until the account is eligible. */
  referral_code: string | null;
  reward_tier: string;
  reward_days: number;
  /**
   * How many referrals this account can ever be paid for, and how far along it
   * is. The programme stacks, so it has a ceiling (REFERRAL_REWARDED_CAP in the
   * API's config/plans.js); saying where somebody stands beats letting them
   * find it by running into it. Optional so an older API build still parses.
   */
  reward_cap?: number;
  granted_count?: number;
  rewarded_count?: number;
  cap_reached?: boolean;
  referrals: ReferralRecord[];
}

export interface OnboardingSurveyInput {
  role?: string;
  primary_use?: string;
  tools?: string[];
  team_size?: string;
  motivation?: string;
}

export interface OnboardingSurvey extends OnboardingSurveyInput {
  user_id: string;
  org_id: string | null;
  created_at?: string;
}

export interface CurrentUser {
  id?: string;
  email?: string;
  org_name?: string;
  role?: string;
}

export interface OrgUsageSummary {
  org_name?: string;
  /**
   * WHICH workspace these numbers describe.
   *
   * Absent on older API builds. The page must print it beside anything that
   * spends money: /billing/checkout targets the BOUND workspace, and until this
   * field existed the plan page read the personal org instead — so the card
   * could describe your own Free account while the Upgrade button next to it
   * charged the team.
   */
  workspace?: string;
  /** False when the caller switched into a workspace they were invited to. */
  is_personal_workspace?: boolean;
  account_type: string;
  usage: {
    decisions: number;
    admins: number;
  };
  limits: {
    decisions: number | null;
    admins: number | null;
    projects?: number | null;
    history_days?: number | null;
  };
  // Value ledger: what DeerDawn has accumulated for the user — the plan page
  // renders this instead of a usage-meter countdown.
  ledger?: {
    briefs_this_period: number;
    briefs_all_time: number;
    decisions_remembered: number;
    oldest_memory_at: string | null;
    projects: number;
  };
  plan: {
    tier: string;
    public_name?: string | null;
    status: string;
    stripe_customer_id?: string | null;
    /** When this workspace's Team trial started (Stripe-confirmed); null or absent = never had one. */
    team_trial_started_at?: string | null;
    /** The subscription's current period and seat count, as the webhook
     *  recorded them (absent on older API builds). */
    billing_period_start?: string | null;
    billing_period_end?: string | null;
    purchased_seats?: number | null;
    /** Stripe's pending cancellation and the real price, as the webhook
     *  recorded them (journey r6). null = not on record. */
    cancel_at_period_end?: boolean | null;
    cancel_at?: string | null;
    price?: {
      unit_amount_cents: number;
      currency?: string | null;
      interval?: string | null;
      interval_count?: number | null;
    } | null;
    /** Who pays, and a takeover of billing in progress (lib/billingOwner). */
    billing_owner?: {
      recorded: boolean;
      is_you: boolean;
      email?: string | null;
      can_manage?: boolean;
    } | null;
    takeover?: { pending: boolean; started_by_you: boolean; started_at?: string | null } | null;
    /** More people than seats; nobody is suspended. */
    seat_shortfall?: { members: number; seats: number; over_by: number } | null;
    referral_premium_active?: boolean;
    referral_premium_until?: string | null;
    remaining_trial_actions?: number | null;
  };
}

/**
 * What POST /billing/checkout answers with.
 *
 * `url` is NOT always present, and treating it as though it were is how this
 * type earned a comment. When the workspace already has a live subscription the
 * API moves THAT subscription onto the new plan — prorated, one subscription,
 * no second charge — and there is no Stripe page to visit, so `url` is null and
 * `updated` is true. Sending someone to Stripe anyway is what produced two
 * concurrent subscriptions on one customer. `portal: true` is the third answer:
 * the change could not be made automatically and a human should finish it in
 * the billing portal, which is also a real `url`.
 */
export interface CheckoutStart {
  url?: string | null;
  updated?: boolean;
  portal?: boolean;
  plan_tier?: string | null;
  seats?: number | null;
  subscription_id?: string | null;
  reason?: string | null;
  message?: string | null;
  /** In-place moves only. When the billing period changed with the plan, Stripe
   *  charges the prorated difference immediately instead of on the next
   *  invoice — `message` already says which; these are for anything that needs
   *  to branch on it rather than print it. */
  billing_cycle?: 'monthly' | 'annual' | null;
  interval_changed?: boolean;
  billed_now?: boolean;
}

export interface UsageSummary {
  syncs_used: number;
  syncs_limit: number | null;
  pct: number;
}

export interface NextBestContextResult {
  summary: string;
  suggestions: Array<{
    kind: 'entity' | 'query';
    label: string;
    reason: string;
    score: number;
    node_id?: string;
    canonical_key?: string;
    query?: string;
  }>;
  provenance: Array<{
    kind: 'active_project' | 'related_project' | 'session' | 'global';
    label: string;
    project_id?: string;
    node_id?: string;
    confidence?: number;
  }>;
}

export interface SetupSurfaceStatus {
  id: string;
  label: string;
  mode: 'mcp' | 'global_instructions' | 'workspace_rules' | 'fallback';
  state: 'not_detected' | 'detected' | 'configured' | 'verified' | 'degraded';
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
}

export interface SetupStatusResult {
  authenticated: boolean;
  setup_complete: boolean;
  configured_count: number;
  verified_count: number;
  runtime_verified_count: number;
  pending_sign_in_url?: string | null;
  execution_source?: 'desktop_bridge' | 'dashboard_fallback' | 'local_direct' | 'unavailable';
  surfaces: SetupSurfaceStatus[];
}

export interface ProductEventSummary {
  totals: {
    total_events: number;
    events_last_24h: number;
  };
  onboarding: {
    views: number;
    step_completions: number;
    completions: number;
    avg_duration_ms: number | null;
    median_duration_ms: number | null;
  };
  funnel: {
    signup_starts: number;
    signup_successes: number;
    signup_failures: number;
    checkout_starts: number;
    checkout_failures: number;
    import_starts: number;
    import_successes: number;
    import_failures: number;
    mcp_start_sessions: number;
  };
  recent: Array<{
    event_name: string;
    created_at: string;
    source: string;
    surface?: string | null;
    path?: string | null;
    metadata: Record<string, unknown>;
  }>;
}

export interface SetupApplyResult {
  surface: string;
  mode: 'auto' | 'repair' | 'restore';
  applied: boolean;
  execution_source?: 'desktop_bridge' | 'dashboard_fallback' | 'local_direct' | 'unavailable';
  status: SetupStatusResult;
  changed_paths: string[];
  restored_from_backup?: string | null;
}

const LOCAL_SETUP_URL = 'http://127.0.0.1:41338';
const LOCAL_SETUP_CLIENT_HEADER = 'dashboard';
// Session flag: set once the local CLI probe fails so we don't re-probe (and
// re-log ERR_CONNECTION_REFUSED) on every subsequent bootstrap this session.
const LOCAL_SETUP_UNAVAILABLE_KEY = 'dd_local_setup_unavailable';

const getCookieValue = (name: string) => {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name.replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&')}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
};

const getCsrfToken = () => {
  for (const key of CSRF_COOKIE_KEYS) {
    const value = getCookieValue(key);
    if (value) return value;
  }
  return null;
};

let cachedClerkToken: { token: string; fetchedAt: number } | null = null;
let inflightToken: Promise<string | null> | null = null;

// A null token has two very different causes and the 401 handler has to tell
// them apart. "Signed out" is a real answer — retrying cannot improve it. "The
// token fetch itself failed" (Clerk's script or its /v1 endpoints died with the
// connection — ERR_INTERNET_DISCONNECTED / ERR_NETWORK_CHANGED) is not an
// answer at all: the request then goes out with NO Authorization header and the
// API can only return 401. That 401 says nothing about the session, so it is the
// one worth retrying.
let tokenFetchFailed = false;

const isClerkEnabled = () => Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) && process.env.NODE_ENV === 'production';

async function getClerkToken(): Promise<string | null> {
  if (typeof window === 'undefined' || !isClerkEnabled()) return null;

  const now = Date.now();
  if (cachedClerkToken && now - cachedClerkToken.fetchedAt < CLERK_TOKEN_TTL_MS) {
    return cachedClerkToken.token;
  }

  if (inflightToken) return inflightToken;

  inflightToken = (async () => {
    try {
      const bridgedToken = await resolveRuntimeAuthToken();
      if (bridgedToken) {
        cachedClerkToken = { token: bridgedToken, fetchedAt: Date.now() };
        tokenFetchFailed = false;
        return bridgedToken;
      }

      const clerk = (window as typeof window & { Clerk?: any }).Clerk;
      const session = clerk?.session;
      // No Clerk object at all means the script never loaded — on a page that
      // requires auth to render that is a load failure, not a signed-out user.
      if (!clerk) {
        tokenFetchFailed = true;
        return null;
      }
      if (!session) {
        tokenFetchFailed = false;
        return null;
      }

      const template = process.env.NEXT_PUBLIC_CLERK_JWT_TEMPLATE;
      let token: string | null = null;
      if (template) {
        try {
          token = await session.getToken({ template });
        } catch {
          token = null;
        }
      }
      if (!token) token = await session.getToken();
      if (!token) {
        tokenFetchFailed = true;
        return null;
      }

      cachedClerkToken = { token, fetchedAt: Date.now() };
      tokenFetchFailed = false;
      return token;
    } catch {
      tokenFetchFailed = true;
      return null;
    } finally {
      inflightToken = null;
    }
  })();

  return inflightToken;
}

// The person's most recent workspace choice in this browser.
//
// An invited teammate's user row still carries their own personal org, so the
// server would resolve owner_key to that workspace and they would see an empty
// product. The switcher stores the choice here; a page opened afterwards is
// loaded for it, and every request that page makes names it (see "THE
// WORKSPACE THIS PAGE WAS LOADED FOR" below). The server checks membership and
// refuses a workspace the caller is not in, rather than quietly serving them
// their own.
//
// Per-browser and non-authoritative on purpose: it selects among workspaces the
// server independently verifies, so a tampered value gets a 403, not access.
const ACTIVE_WORKSPACE_KEY = 'deerdawn.activeWorkspace';

// Requests that must never carry the stored workspace. The first two answer "who
// am I and where may I go", which is exactly what a person needs when the stored
// choice is stale: a removed member's switcher fetch used to 403 on the very
// header it existed to let them change, so the one control that could fix it
// never rendered.
//
// Accepting an invitation is the third. It names its own workspace (the token),
// so the stored choice has nothing to say about it, and sending it made the
// accept answer for the WRONG workspace: a browser still pointed at a team whose
// subscription had lapsed got 403 subscription_inactive, and one pointed at a
// team the person had been removed from got 403 workspace_forbidden. Both
// rendered as "This invite link is invalid or has been revoked" about a link
// that was fine.
//
// The domain door is the same case as the invitation. Listing the offers is
// about the PERSON (their email domain), and accepting one names its own
// workspace in the path. Bound to a lapsed or removed team, both were answered
// for that team instead, so the offer and the join failed for a reason that had
// nothing to do with the workspace being joined.
const WORKSPACE_UNBOUND_PATHS = new Set([
  '/api/v1/teams/workspaces',
  '/api/v1/auth/me',
  '/api/v1/teams/invite/accept',
  '/api/v1/teams/joinable',
]);

// Paths with a segment in them. Anchored at both ends and one segment wide, so
// nothing under /teams/joinable except the accept itself stops carrying the
// header, and a key containing a slash (encodeURIComponent turns it into %2F)
// cannot widen it.
const WORKSPACE_UNBOUND_PATTERNS: RegExp[] = [
  /^\/api\/v1\/teams\/joinable\/[^/]+\/accept$/,
];

export function sendsWorkspaceHeader(endpoint: string | undefined): boolean {
  if (!endpoint) return true;
  const pathOnly = endpoint.split(/[?#]/)[0];
  if (WORKSPACE_UNBOUND_PATHS.has(pathOnly)) return false;
  return !WORKSPACE_UNBOUND_PATTERNS.some((pattern) => pattern.test(pathOnly));
}

// THE WORKSPACE THIS PAGE WAS LOADED FOR. A TAB WRITES WHERE IT SHOWS.
//
// The stored choice above is ONE key shared by every tab, and each request used
// to read it at the moment it was sent, with "personal" being the ABSENCE of the
// key (a header-less request, answered in whatever the server held as active).
// So a tab showing Marcus's personal workspace (badge FREE, his own projects)
// created a project in the TEAM as soon as another tab, another device or an
// accepted invitation moved either of the two shared choices: the page still
// said FREE, and the project was shared with every member. The reverse filed a
// team project as his private one, where the team never saw it.
//
// So a page decides its workspace ONCE and keeps it, in memory, which is per
// tab: every request it makes names that workspace explicitly, personal
// included, until the person switches IN THIS TAB (setActiveWorkspace) or
// reloads it. Nothing listens for `storage` events on purpose. A new tab or a
// reload decides again from the person's most recent choice exactly as before:
// the stored choice when this browser has one, otherwise the server's (GET
// /teams/workspaces `active`). The stored choice and the server's keep their
// meaning — the default for new pages and for tools — and no longer override a
// page that is already open.
//
// Personal is named by the person's own org id, which the API already honours
// for that person (the auth middleware binds it as their own workspace, never
// following is_active) and refuses for everybody else (resolveOwnerKey finds no
// membership). The page learns it from the listing's `personal: true` row.
type PageWorkspace =
  // Nothing decided yet: the first request (or read) decides.
  | { state: 'undecided' }
  // The person chose personal here before this page learnt its key.
  | { state: 'personal' }
  // Decided. `key: null` means there is nothing to name (the listing offered no
  // workspace at all), and requests go header-less as they always did.
  | { state: 'bound'; key: string | null };

let pageWorkspace: PageWorkspace = { state: 'undecided' };
let pageWorkspaceResolution: Promise<void> | null = null;

// THE WORKSPACE A RETURN LINK NAMES. After checkout or the billing portal,
// Stripe sends the person back with `?workspace=` naming the workspace the
// purchase or portal session was for (the API writes it into the return URL),
// and the page opens in THAT workspace rather than in the most recent choice,
// which another tab may have moved. The name is not an authority: an undecided
// page takes it only once the person's own listing includes it, and until then
// nothing is decided from the stored choice. A name the listing does not
// include is dropped and the page decides exactly as it would have without the
// link, with no error. It is read once per page load, decides only an undecided
// page, and is not stored: new tabs still open in the most recent choice.
// `undefined`: not read yet; null: none, or already settled.
let linkedWorkspace: string | null | undefined;

function pendingLinkedWorkspace(): string | null {
  if (linkedWorkspace !== undefined) return linkedWorkspace;
  linkedWorkspace = null;
  if (typeof window === 'undefined') return null;
  try {
    const value = new URLSearchParams(window.location?.search || '').get('workspace');
    if (value && value.length <= 200) linkedWorkspace = value;
  } catch {
    /* no readable location: there is no link */
  }
  return linkedWorkspace;
}
// The person's own workspace, from the most recent listing.
let personalWorkspaceKey: string | null = null;

function readStoredChoice(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(ACTIVE_WORKSPACE_KEY);
  } catch {
    // Private mode, blocked site data: there is simply no stored choice.
    return null;
  }
}

function writeStoredChoice(workspace: string | null): void {
  try {
    if (workspace) window.localStorage.setItem(ACTIVE_WORKSPACE_KEY, workspace);
    else window.localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
  } catch {
    /* nothing to do: this tab still knows its own workspace */
  }
}

/**
 * The workspace this page's requests name.
 *
 * Null only before the page has decided and when this browser has no stored
 * choice: the server's `active` will decide it, and every caller reads null as
 * exactly that (see lib/workspaceFallback boundWorkspace).
 */
export function getActiveWorkspace(): string | null {
  if (typeof window === 'undefined') return null;
  if (pageWorkspace.state === 'bound') return pageWorkspace.key;
  if (pageWorkspace.state === 'personal') return personalWorkspaceKey;
  // A return link waits for the listing (learnFromWorkspaceListing).
  if (pendingLinkedWorkspace()) return null;
  const stored = readStoredChoice();
  if (stored) pageWorkspace = { state: 'bound', key: stored };
  return stored;
}

/**
 * The person chose a workspace IN THIS TAB: this page moves to it, and it
 * becomes the most recent choice that new tabs open in. Other open tabs keep
 * theirs. Null, or the person's own workspace key, means personal, which is
 * still stored as no choice at all so that a new tab follows the server's
 * choice exactly as before.
 */
export function setActiveWorkspace(workspace: string | null): void {
  if (typeof window === 'undefined') return;
  // A new choice invalidates the old fallback report: whatever workspace could
  // not serve the last request says nothing about where the next one goes. The
  // subscribers are told, so a shell that is showing the banner stops.
  clearWorkspaceFallback();
  // A choice made here outranks whatever a return link named.
  linkedWorkspace = null;
  const personal = !workspace || workspace === personalWorkspaceKey;
  writeStoredChoice(personal ? null : workspace);
  if (!personal) pageWorkspace = { state: 'bound', key: workspace };
  else if (personalWorkspaceKey) pageWorkspace = { state: 'bound', key: personalWorkspaceKey };
  else pageWorkspace = { state: 'personal' };
}

// A workspace that refused this person (workspace_forbidden): drop it, exactly
// as the stored choice has always been dropped, and let the page decide again
// the way a reload would. The request being replayed goes out header-less,
// answered in the account's default as before; the next one re-decides.
function forgetRefusedWorkspace(): void {
  clearWorkspaceFallback();
  writeStoredChoice(null);
  pageWorkspace = { state: 'undecided' };
}

// A listing is the one place the page can learn its personal key and, with no
// stored choice, which workspace it was loaded for. Called for every listing.
function learnFromWorkspaceListing(listing: WorkspacesListing): void {
  if (!listing || !Array.isArray(listing.workspaces)) return;
  personalWorkspaceKey = listing.workspaces.find((entry) => entry && entry.personal)?.workspace || null;
  if (pageWorkspace.state === 'personal') {
    pageWorkspace = { state: 'bound', key: personalWorkspaceKey };
    return;
  }
  if (pageWorkspace.state !== 'undecided') return;
  // A return link decides first, when the person may enter what it names.
  const linked = pendingLinkedWorkspace();
  if (linked) {
    linkedWorkspace = null;
    if (listing.workspaces.some((entry) => entry && entry.workspace === linked)) {
      pageWorkspace = { state: 'bound', key: linked };
      return;
    }
  }
  // A stored choice decides next, as it always has.
  if (getActiveWorkspace()) return;
  // Fetched without the header, so `active` is the server's choice right now:
  // precisely the workspace a header-less first request would have landed in.
  pageWorkspace = { state: 'bound', key: typeof listing.active === 'string' && listing.active ? listing.active : null };
}

function decidedPageWorkspace(): string | null | undefined {
  return pageWorkspace.state === 'bound' ? pageWorkspace.key : undefined;
}

// The workspace to name on a bound request, deciding it first if the page has
// not yet. Resolves null only when there is nothing to name, or the listing
// could not be read (the request then goes header-less, as it always did, and
// the next one tries again).
async function resolvePageWorkspace(): Promise<string | null> {
  // A stored choice decides an undecided page at once, with no round trip.
  getActiveWorkspace();
  const decided = decidedPageWorkspace();
  if (decided !== undefined) return decided;
  if (!pageWorkspaceResolution) {
    // One read for every request waiting on it. GET /teams/workspaces is never
    // bound, so this cannot recurse.
    pageWorkspaceResolution = api.getWorkspaces()
      .then(() => undefined, () => undefined)
      .finally(() => { pageWorkspaceResolution = null; });
  }
  await pageWorkspaceResolution;
  return decidedPageWorkspace() ?? null;
}

// THE WORKSPACE THAT COULD NOT SERVE THE REQUEST.
//
// When the active team's subscription has lapsed the API answers a header-less
// READ out of the person's personal workspace and names the team it declined to
// use in `x-deerdawn-workspace-fallback`. Every page would otherwise go on
// rendering the team it thinks it is in while reading somebody else's data, so
// the client records the signal once, centrally, and the shell subscribes.
//
// SET, NEVER CLEARED BY A PLAIN RESPONSE. Only some routes are workspace-bound
// (the billing and membership exits deliberately still work against the team),
// so a response without the header is not evidence the fallback has ended, and
// clearing on absence made the banner flicker off on the next poll. It is
// cleared when the person actually chooses a workspace, above; by a listing
// whose `fallback: null` was computed for this browser's binding; and by a
// header-bound read of a route the fallback rebinds that comes back without it
// (lib/workspaceFallback readProvesWorkspaceServing), the only end a browser
// whose stored choice differs from the server's active workspace can observe.
//
// Its absence proves nothing either way: an API that has not been redeployed
// does not send it, and an origin that does not expose it leaves `get` returning
// null. The `fallback` field on GET /teams/workspaces is the other half, and
// lib/workspaceFallback reconciles the two.
let workspaceFallbackKey: string | null = null;
const workspaceFallbackListeners = new Set<(key: string | null) => void>();

function announceWorkspaceFallback(key: string | null): void {
  workspaceFallbackListeners.forEach((listener) => {
    try {
      listener(key);
    } catch {
      /* a subscriber that throws must not break the request that fed it */
    }
  });
}

function recordWorkspaceFallback(
  res: Response,
  endpoint?: string,
  method?: string,
  sentWorkspace?: string | null,
): void {
  let key: string | null = null;
  try {
    key = res.headers?.get?.('x-deerdawn-workspace-fallback') || null;
  } catch {
    key = null;
  }
  if (!key) {
    // The one absence that IS evidence: a header-bound read of a route the
    // fallback rebinds, naming the recorded workspace, answered without the
    // header. That workspace served it. Needed because when this browser's
    // stored choice differs from the server's active workspace, the listing
    // speaks for the other binding and can never end this one.
    if (endpoint && readProvesWorkspaceServing(endpoint, method, res.status, sentWorkspace, workspaceFallbackKey)) {
      clearWorkspaceFallback();
    }
    return;
  }
  if (key === workspaceFallbackKey) return;
  workspaceFallbackKey = key;
  announceWorkspaceFallback(key);
}

/**
 * A REFUSED WRITE NAMES THE WORKSPACE THAT IS NOT ANSWERING.
 *
 * The 409 is raised before the fallback would rebind the request, so it carries
 * no response header, only `workspace` in its body. A browser that had not yet
 * made a read that reported the fallback showed "Not saved. Acme's subscription
 * is inactive" under a shell that still named Acme and no banner. Recording the
 * refused workspace puts the banner (and its "Use my own workspace" action) up
 * beside the refusal that tells the reader to switch.
 */
async function recordWorkspaceInactiveRefusal(res: Response): Promise<void> {
  if (res.status !== 409) return;
  const body = await res.clone().json().catch(() => null);
  if (!body || typeof body !== 'object') return;
  if (body.error !== 'workspace_inactive' && body.code !== 'workspace_inactive') return;
  const key = typeof body.workspace === 'string' && body.workspace ? body.workspace : null;
  if (!key || key === workspaceFallbackKey) return;
  workspaceFallbackKey = key;
  announceWorkspaceFallback(key);
}

/**
 * The fallback is OVER: somebody paid, or the person chose another workspace.
 *
 * The recorded key is never cleared by a response that merely omits the header
 * (most routes do not send one), so without an explicit end it outlived the
 * thing it described and the banner stayed up until a full reload. The two
 * things that DO end it are a fresh listing carrying `fallback: null` and a
 * deliberate switch, and both come through here.
 */
export function clearWorkspaceFallback(): void {
  if (workspaceFallbackKey === null) return;
  workspaceFallbackKey = null;
  announceWorkspaceFallback(null);
}

export function getWorkspaceFallbackKey(): string | null {
  return workspaceFallbackKey;
}

export function onWorkspaceFallback(listener: (key: string | null) => void): () => void {
  workspaceFallbackListeners.add(listener);
  return () => { workspaceFallbackListeners.delete(listener); };
}

// EVERY SURFACE THAT RENDERS THE WORKSPACE HEARS ABOUT A FRESH LISTING.
//
// The banner and the switcher each fetch GET /teams/workspaces on mount and
// then never again, so whichever of them re-reads after the bill is paid was
// the only one to notice. They now share one answer: any successful read of the
// listing is broadcast, and either of them can ask for a re-read.
const workspaceListingListeners = new Set<(listing: WorkspacesListing) => void>();

export function onWorkspaceListing(listener: (listing: WorkspacesListing) => void): () => void {
  workspaceListingListeners.add(listener);
  return () => { workspaceListingListeners.delete(listener); };
}

function applyWorkspaceListing(listing: WorkspacesListing): WorkspacesListing {
  // First, so that everything below reads the workspace this page is for.
  learnFromWorkspaceListing(listing);
  // An explicit `fallback: null` is computed for THIS read and outranks a key
  // recorded earlier in the tab. A listing that omits the field entirely is an
  // older API and says nothing either way — see lib/workspaceFallback.
  //
  // But the listing is fetched without the stored workspace header, so its null
  // is about the SERVER's active workspace. When this browser's stored choice
  // binds it elsewhere, that null says nothing about the key its own reads
  // reported, and clearing on it hid the banner from exactly the browser being
  // served out of the wrong workspace.
  if (listingEndsRecordedFallback(listing, getActiveWorkspace())) clearWorkspaceFallback();
  workspaceListingListeners.forEach((listener) => {
    try {
      listener(listing);
    } catch {
      /* a subscriber that throws must not break the fetch that fed it */
    }
  });
  return listing;
}

let workspaceListingRefresh: Promise<void> | null = null;

// A small GET the fallback rebinds (plan-enforced, under /api/v1/context), used
// to ask whether the workspace this browser names is answering again.
const WORKSPACE_FALLBACK_PROBE = '/api/v1/context/preferences';

/**
 * Re-read the listing, at most one at a time.
 *
 * Called on window focus while a fallback is showing (the bill is usually paid
 * in another tab) and after any WRITE that succeeds while one is recorded — a
 * successful write is proof the refusal has ended, because the refusal was a
 * 409 that wrote nothing.
 */
export function refreshWorkspaceListing(): Promise<void> {
  if (workspaceListingRefresh) return workspaceListingRefresh;
  workspaceListingRefresh = api.getWorkspaces()
    .then(async () => {
      // A key recorded from this browser's header-bound reads is one the listing
      // cannot end (it speaks for header-less requests). Ask a read that would
      // carry the header again; recordWorkspaceFallback clears the key when the
      // answer comes back without it.
      const stored = getActiveWorkspace();
      if (workspaceFallbackKey && stored && workspaceFallbackKey === stored) {
        await fetchAPI(WORKSPACE_FALLBACK_PROBE).catch(() => undefined);
      }
    })
    .catch(() => undefined)
    .finally(() => { workspaceListingRefresh = null; });
  return workspaceListingRefresh;
}

/**
 * Leave the workspace that is not answering and use your own.
 *
 * Both halves matter and they fail independently: the browser half is the
 * stored choice this tab sends on every request, the server half is what the
 * person's AGENT sessions read (they send no header at all). Resolves true when
 * both halves applied and false when the server half failed. It never throws,
 * but false is not "switched anyway": a header-less browser is bound to the
 * server's active workspace too, so the caller must show
 * PERSONAL_SWITCH_FAILED_MESSAGE rather than reload as if it had worked.
 *
 * Deliberately does not reload: the banner wants a full reload (everything
 * already fetched in the tab is scoped to the old workspace), /checkout wants to
 * re-evaluate in place without losing the plan it was asked to buy.
 */
export async function switchToPersonalWorkspace(): Promise<boolean> {
  const previousPage = pageWorkspace;
  const previousChoice = readStoredChoice();
  setActiveWorkspace(null);
  try {
    await api.setActiveWorkspaceOnServer(null);
    return true;
  } catch {
    // NOT a silent success, and not half of one either. Personal is stored as
    // NO choice, so a new page or a reload of this one follows the server's
    // active workspace — the half that just failed — and would land back in the
    // team being left. The caller says "could not switch" and does not reload,
    // so this page still shows the team: it goes on writing there too, rather
    // than quietly naming personal under a shell that says otherwise.
    pageWorkspace = previousPage;
    writeStoredChoice(previousChoice);
    return false;
  }
}

/** What to say when the server half of a switch to your own workspace failed. */
export const PERSONAL_SWITCH_FAILED_MESSAGE =
  'Could not switch to your own workspace. The server did not confirm the change, so this browser may still be using the other workspace. Try again.';

async function getHeaders(options: RequestInit = {}, endpoint?: string, withoutWorkspace = false) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (typeof window !== 'undefined') {
    const token = await getClerkToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    // The workspace this PAGE was loaded for, not whatever the shared choice
    // says at this instant (see resolvePageWorkspace).
    const workspace = sendsWorkspaceHeader(endpoint) && !withoutWorkspace ? await resolvePageWorkspace() : null;
    if (workspace) headers['x-deerdawn-workspace'] = workspace;
  }



  const method = options.method?.toUpperCase() ?? 'GET';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrfToken = getCsrfToken();
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  }

  return headers;
}

function apiBase() {
  // Always use the normalized API_URL (prod-safe fallback) — the old
  // localhost:8080 fallback broke userscript download/export in prod builds
  // when NEXT_PUBLIC_API_URL was missing at build time.
  return API_URL;
}

// Fetch an auth-gated endpoint (a plain link 401s) and hand the browser a blob to
// download. Shared by the userscript install and the context export.
async function downloadAuthedBlob(path: string, filename: string, mime: string): Promise<void> {
  const headers = await getHeaders({}, path);
  const res = await fetch(`${apiBase()}${path}`, { headers });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const text = await res.text();
  const blobUrl = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
}

async function throwApiError(res: Response): Promise<never> {
  const errorBody = await res.text();
  let message = errorBody || res.statusText;
  let code: string | undefined;
  let details: unknown;
  let requestId: string | undefined;
  let data: Record<string, unknown> | undefined;

  try {
    const parsed = JSON.parse(errorBody);
    const detailsMsg = Array.isArray(parsed?.details) && parsed.details.length > 0
      ? parsed.details[0]?.message || parsed.details[0]?.code
      : null;
    message = parsed?.message || detailsMsg || parsed?.error || message;
    code = parsed?.code;
    details = parsed?.details;
    requestId = typeof parsed?.request_id === 'string' ? parsed.request_id : undefined;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    // Keep text response.
  }

  throw new ApiError(res.status, message, code, details, requestId, data);
}

// A write that does real work server-side (a Trail import upserts a graph) can
// outlive the 8s read budget while still succeeding. Aborting it does not undo
// the write; it only tells the user it failed, and a retry then duplicates it.
// Such calls pass their own `timeoutMs`.
type FetchOptions = RequestInit & { timeoutMs?: number };

async function executeFetch(endpoint: string, options: FetchOptions = {}, headers?: Record<string, string>) {
  const { timeoutMs = FETCH_TIMEOUT_MS, ...init } = options;
  const controller = new AbortController();
  const timeout = typeof window !== 'undefined'
    ? window.setTimeout(() => controller.abort(), timeoutMs)
    : null;

  try {
    return await fetch(`${API_URL}${endpoint}`, {
      ...init,
      headers: headers || (await getHeaders(init, endpoint)),
      credentials: 'include',
      signal: init.signal || controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError(504, `Dashboard API request timed out after ${timeoutMs / 1000}s.`, 'network_timeout', {
        endpoint,
        api_url: API_URL,
      });
    }

    throw new ApiError(503, `Dashboard could not reach ${API_URL}. Verify the local API and allowed dashboard origin, then retry.`, 'network_unreachable', {
      endpoint,
      api_url: API_URL,
      cause: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (timeout !== null) window.clearTimeout(timeout);
  }
}

async function fetchLocalSetup(endpoint: string, options: RequestInit = {}): Promise<any> {
  const controller = new AbortController();
  const timeout = typeof window !== 'undefined'
    ? window.setTimeout(() => controller.abort(), 2500)
    : null;

  try {
    const res = await fetch(`${LOCAL_SETUP_URL}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-DeerDawn-Setup-Client': LOCAL_SETUP_CLIENT_HEADER,
        ...(options.headers as Record<string, string>),
      },
      signal: options.signal || controller.signal,
    });
    if (!res.ok) {
      await throwApiError(res);
    }
    return res.json();
  } finally {
    if (timeout !== null) window.clearTimeout(timeout);
  }
}

async function fetchDashboardRoute(endpoint: string, options: RequestInit = {}): Promise<any> {
  const res = await fetch(endpoint, {
    ...options,
    headers: await getHeaders(options, endpoint),
    credentials: 'include',
  });

  if (!res.ok) {
    return throwApiError(res);
  }

  if (res.status === 204) return null;
  return res.json();
}

// A WRITE THAT SUCCEEDS IS PROOF THE REFUSAL IS OVER.
//
// While a workspace is refusing on billing grounds, a header-less write is
// answered 409 and nothing is stored — so a 2xx on a write means the workspace
// is serving again (or the person has moved to one that is). Nothing told the
// shell, and it went on showing the banner over writes that were landing. The
// listing is the authority, so ask it rather than guessing from the status.
function noteSuccessfulWrite(endpoint: string, method: string | undefined): void {
  if (!workspaceFallbackKey) return;
  const verb = (method || 'GET').toUpperCase();
  if (verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS') return;
  // The listing read itself is a GET, so this cannot recurse, but be explicit.
  if (endpoint.split(/[?#]/)[0] === '/api/v1/teams/workspaces') return;
  void refreshWorkspaceListing();
}

// After a refused WRITE the stored workspace has been dropped but the page is
// still rendering the workspace that refused it. Reload once, a beat later, so
// the shell comes back in the person's own workspace after they have read the
// refusal — the same bootstrap path that shows the recovery screen when a READ
// is refused. Guarded on reload existing so a non-browser host (tests, SSR)
// simply does nothing.
const WORKSPACE_RELOAD_DELAY_MS = 4_000;
let workspaceReloadScheduled = false;
function scheduleWorkspaceReload(delayMs = WORKSPACE_RELOAD_DELAY_MS) {
  if (workspaceReloadScheduled) return;
  if (typeof window === 'undefined' || typeof window.location?.reload !== 'function') return;
  workspaceReloadScheduled = true;
  window.setTimeout(() => window.location.reload(), delayMs);
}

async function fetchAPI(
  endpoint: string,
  options: FetchOptions = {},
  retryAttempted = false,
  withoutWorkspace = false,
): Promise<any> {
  // Removed from the team this tab shows, and reloading: nothing is written
  // anywhere until the reload lands (lib/workspaceRemoval).
  if (isLeavingRemovedWorkspace() && !shouldReplayAfterWorkspaceForbidden(options.method)) {
    throw new ApiError(403, WORKSPACE_FORBIDDEN_WRITE_MESSAGE, 'workspace_forbidden');
  }
  const headers = await getHeaders(options, endpoint, withoutWorkspace);
  const res = await executeFetch(endpoint, options, headers);

  // Before anything branches on the status: a fallback is reported on the
  // successful read as readily as on the refused write, and the shell needs it
  // from whichever arrives first.
  recordWorkspaceFallback(res, endpoint, options.method, headers['x-deerdawn-workspace'] || null);
  await recordWorkspaceInactiveRefusal(res);

  // A stored workspace the server no longer lets this person into (they were
  // removed, or the workspace is gone). Every request carries it, so leaving it
  // in place fails every request, and the bootstrap used to read that 403 as an
  // expired session and sign them out: Clerk then bounced them straight back
  // with the same header, and the loop had no exit. Drop the stale choice and
  // retry once against the account's default workspace.
  if (res.status === 403 && headers['x-deerdawn-workspace'] && !retryAttempted) {
    const body = await res.clone().json().catch(() => null);
    if (body && (body.error === 'workspace_forbidden' || body.code === 'workspace_forbidden')) {
      // Removed from a team this tab shows: reload into the person's own
      // workspace, and say why (lib/workspaceRemoval). A read reloads at once;
      // a write, after the refusal below has been read.
      if (noteRemovedFromWorkspace(headers['x-deerdawn-workspace'], personalWorkspaceKey)) {
        scheduleWorkspaceReload(shouldReplayAfterWorkspaceForbidden(options.method) ? 0 : WORKSPACE_RELOAD_DELAY_MS);
      }
      forgetRefusedWorkspace();
      // ONLY A READ MAY BE REPLAYED. This retried whatever the method was, so a
      // removed member with a stale tab who created a project, minted a key or
      // posted /billing/checkout had that write re-aimed at their PERSONAL
      // workspace and succeed there, reported as success, while the page around
      // them still showed the team. See shouldReplayAfterWorkspaceForbidden.
      //
      // The replay goes out WITHOUT a workspace, answered in the account's
      // default exactly as it always was; the page decides again on its next
      // request.
      if (shouldReplayAfterWorkspaceForbidden(options.method)) {
        return fetchAPI(endpoint, options, true, true);
      }
      scheduleWorkspaceReload();
      throw new ApiError(
        403,
        WORKSPACE_FORBIDDEN_WRITE_MESSAGE,
        'workspace_forbidden',
        undefined,
        undefined,
        body,
      );
    }
  }

  if (res.status === 401) {
    cachedClerkToken = null;

    // Bug 6 fix: only retry if Clerk is active AND there's an actual session to
    // refresh a token from. Without the session check, every 401 made two
    // round-trips — the retry went out without an Authorization header and got
    // another 401 immediately, doubling latency and log noise on expired sessions.
    //
    // tokenFetchFailed widens that by exactly one case, and it is the one the
    // session check cannot see: Clerk itself failed to load or answer, so there
    // is no `Clerk.session` to point at even though the reader is signed in. The
    // 401 was caused by us sending no token, not by the session, so retry it.
    const hasLiveSession = typeof window !== 'undefined' && Boolean((window as any).Clerk?.session);
    if (!retryAttempted && isClerkEnabled() && (hasLiveSession || tokenFetchFailed)) {
      return fetchAPI(endpoint, options, true, withoutWorkspace);
    }

    // A 401 on a request we sent WITHOUT an Authorization header says nothing
    // about the session — we never asked the server about it. Callers that treat
    // every 401 as "signed out" then send the reader to sign in, which cannot
    // fix a missing token and, when the session is in fact alive, bounces
    // straight back: login sees isSignedIn and returns them to the page that
    // 401s. That is a closed loop with no user error in it, and this code is
    // what tells the two ends apart.
    if (isClerkEnabled() && !headers.Authorization) {
      throw new ApiError(
        401,
        'Could not verify your sign-in — the authentication service did not answer.',
        'auth_token_unavailable',
        { endpoint },
      );
    }
  }

  if (!res.ok) {
    return throwApiError(res);
  }

  noteSuccessfulWrite(endpoint, options.method);

  if (res.status === 204) return null;
  return res.json();
}

// FOR lib/addonsApi.ts. The JSON path (fetchAPI) for ordinary calls, and a raw
// one for the two things fetchAPI cannot carry: a multipart upload (the
// browser must set its own Content-Type boundary) and a binary response
// (attachment bytes, read as a Blob). Both send the same auth, workspace and
// CSRF headers every other request does.
export function requestApi<T = any>(endpoint: string, options: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  return fetchAPI(endpoint, options);
}

export async function requestApiRaw(endpoint: string, options: RequestInit = {}): Promise<Response> {
  const headers = await getHeaders(options, endpoint);
  if (typeof FormData !== 'undefined' && options.body instanceof FormData) delete headers['Content-Type'];
  const res = await executeFetch(endpoint, { ...options, timeoutMs: 60_000 }, headers);
  if (!res.ok) return throwApiError(res);
  noteSuccessfulWrite(endpoint, options.method);
  return res;
}

// Web tools whose context sync runs via an installable browser userscript
// (served from /api/v1/context/userscript?tool=...). Gemini/Perplexity have no
// remote-MCP path, so the userscript is their only integration route.
export type WebCaptureTool = 'claude_web' | 'chatgpt_web' | 'gemini' | 'perplexity';

export interface ContextExportBundle {
  exported_at: string;
  schema_version: number;
  owner_key: string;
  global_context: Record<string, unknown>;
  preferences: Record<string, unknown>;
  projects: Array<{
    project_id: string;
    project_name: string;
    updated_at: string | null;
    context: Record<string, unknown>;
    linked_paths: string[];
    graph: { nodes: Array<{ node_type?: string; title: string; summary?: string }>; edges: unknown[] };
  }>;
}

// ─── Brief spine (4-slot) types ──────────────────────────────────────────────
// The product noun is "the brief": four slots (SHIPPED / DECIDED / OPEN /
// LANDMINE) rendered everywhere. Phase A adds a structured `brief_spine` to the
// API payload with per-item provenance; until that ships the dashboard derives
// the slots CLIENT-SIDE from the existing context fields (deriveBriefSpine).
// The 4th slot's UI label is "Landmine" (the DB field stays `landmines`).

export type BriefTrust = 'high' | 'inferred' | 'unverified';
export type BriefSlotKind = 'shipped' | 'decided' | 'open' | 'landmine';

// One item inside any of the four slots. `trust` is provided by Phase A's
// brief_spine; when absent the dashboard derives it from the raw provenance
// fields via deriveItemTrust().
export interface BriefItem {
  text: string;
  trust?: BriefTrust;
  source_tool?: string;
  // Raw provenance carried through from the context object so the dashboard can
  // derive trust + render timestamps even before Phase A's brief_spine exists.
  confidence?: number;
  verified_at?: string;
  date_inferred?: boolean;
  source_kind?: string;
  decided_at?: string;
  added_at?: string;
  shipped_at?: string;
  /** SHIPPED only: the line came from a board card moved to Done. Labelled "Shipped", not "Verified". */
  from_card?: boolean;
  importance?: 'low' | 'normal' | 'high' | 'critical';
  resolved?: boolean;
  // Stable position in its source array — used as the optimistic-mutation key
  // (text + index) until Phase C-backend adds per-item IDs.
  index?: number;
}

// A stored SHIPPED entry, mirroring ShippedEntrySchema in shared-context:
// { summary, shipped_at, ... }. Note there is NO `text` field — the slot
// renderer's field is `text`, and translating between the two is the mapper's
// job, exactly as decisionToItem does for `summary`.
//
// This interface exists because `shipped` used to be typed as
// `Array<BriefItem | string>` — i.e. "already a BriefItem". That was untrue, and
// it let `shippedToItem` get away with a blind `{ ...s }` spread that produced
// `text: undefined` and rendered two blank cards with only a provenance badge.
// Typing the STORED shape means the compiler catches a missing translation.
export interface ShippedEntry {
  summary: string;
  shipped_at?: string;
  source_tool?: string;
  confidence?: number;
  commit_ref?: string;
  pinned?: boolean;
  /** The Done board card this line came from (the line follows the card). */
  card_id?: string;
  /** Tolerated because some legacy rows were written pre-schema. */
  text?: string;
}

// A landmine: a sharp, durable watch-out (footgun, fragile invariant). Modeled
// on DebuggingNoteEntrySchema — object entries with provenance, not bare strings.
export interface Landmine {
  text?: string;
  summary?: string;
  added_at?: string;
  confidence?: number;
  verified_at?: string;
  source_tool?: string;
  source_kind?: string;
  importance?: 'low' | 'normal' | 'high' | 'critical';
}

// The structured 4-slot payload. Phase A attaches this to the inject JSON; the
// dashboard prefers it when present and falls back to deriveBriefSpine().
export interface BriefSpine {
  shipped: BriefItem[];
  decided: BriefItem[];
  open: BriefItem[];
  landmine: BriefItem[];
}

export interface Brief {
  project_id: string | null;
  project_name: string | null;
  last_updated: string | null;
  // The rendered injection text the AI actually reads (today's /active shape).
  brief: string | null;
  // Present only once Phase A ships `?shape=spine`.
  brief_spine?: BriefSpine | null;
  match_kind?: string | null;
}

// Raw context object returned by /inject?format=json — the FULL payload WITH
// per-item provenance. (getContextProjects strips provenance, so it must not be
// used to build the brief.) `brief_spine` is present only after Phase A deploys.
export interface ProjectContextJson {
  project_id: string;
  project_name: string;
  updated_at?: string;
  description?: string;
  current_status?: string;
  current_task?: string;
  blocking_issue?: string;
  open_questions?: string[];
  recent_decisions?: Array<DecisionEntry | string>;
  landmines?: Array<Landmine | string>;
  shipped?: Array<ShippedEntry | string>;
  todo_items?: TodoItem[];
  completed_todos?: TodoItem[];
  task_steps?: Array<{ name: string; status: 'todo' | 'in_progress' | 'done' }>;
  brief_spine?: BriefSpine | null;
  /**
   * Present only when the API handed back a SECTION-FILTERED view — a teammate
   * reading somebody else's shared project. Names the sections the share policy
   * withheld that actually hold content; names only, never values.
   *
   * An empty state must consult this before claiming a project is blank:
   * absence of a section means "not written yet", but a section named here
   * means "written, and not yours to read". Telling a member the first when the
   * truth is the second invites them to re-enter work that already exists.
   */
  withheld_sections?: string[];
  [key: string]: unknown;
}

/**
 * Human labels for `withheld_sections`. Mirrors WITHHELD_SECTION_LABELS in
 * packages/shared-context/src/index.js — keep the two in step.
 */
export const WITHHELD_SECTION_LABELS: Record<string, string> = {
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

/** Withheld section names as human labels; empty when nothing is withheld. */
export function withheldSectionLabels(
  context: { withheld_sections?: unknown } | null | undefined,
): string[] {
  const raw = context?.withheld_sections;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((section) => WITHHELD_SECTION_LABELS[String(section)] || String(section).replace(/_/g, ' ').trim())
    .filter(Boolean);
}

/** True when the share policy is withholding a specific section from this reader. */
export function isSectionWithheld(
  context: { withheld_sections?: unknown } | null | undefined,
  section: string,
): boolean {
  const raw = context?.withheld_sections;
  return Array.isArray(raw) && raw.includes(section);
}

// ─── Task board (scrum-style phased columns) ─────────────────────────────────
// Mirrors packages/shared-context BOARD_PHASES — the one source of truth for the
// column pipeline. Keep in sync with that module.
export type BoardPhase = 'backlog' | 'blocked' | 'in_progress' | 'integration' | 'testing' | 'done';

export const BOARD_PHASES: BoardPhase[] = ['backlog', 'blocked', 'in_progress', 'integration', 'testing', 'done'];

export const BOARD_PHASE_LABELS: Record<BoardPhase, string> = {
  backlog: 'Backlog',
  blocked: 'Blocked',
  in_progress: 'In Progress',
  integration: 'Integration',
  testing: 'Testing',
  done: 'Done',
};

export interface TodoItem {
  id: string;
  title: string;
  phase?: string;
  // The card's detail — prose, a checklist, a short spec. Optional and clipped
  // (never rejected) at 2,000 characters server-side; see src/lib/taskCardBody.ts
  // for the rules and packages/shared-context for the source of them. Absent on
  // every card written before 2026-08-29.
  body?: string | null;
  // 'step' marks a derived, read-only card projected from the current task's
  // task_steps — it's not a persisted todo and can't be dragged/removed.
  kind?: 'step';
  created_at?: string;
  updated_at?: string | null;
  completed_at?: string | null;
}

const STEP_STATUS_TO_PHASE: Record<string, BoardPhase> = {
  todo: 'backlog',
  in_progress: 'in_progress',
  done: 'done',
};

export interface BoardColumn {
  phase: BoardPhase;
  label: string;
  cards: TodoItem[];
}

function normalizeBoardPhase(value: unknown): BoardPhase {
  const v = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_') as BoardPhase;
  return BOARD_PHASES.includes(v) ? v : 'backlog';
}

// Group a project's cards into ordered columns; fold legacy completed_todos into
// Done. Mirror of buildTaskBoard() in packages/shared-context.
export function buildTaskBoard(context: ProjectContextJson | null | undefined): BoardColumn[] {
  const byPhase = new Map<BoardPhase, TodoItem[]>(BOARD_PHASES.map((p) => [p, []]));
  for (const item of context?.todo_items ?? []) {
    const phase = normalizeBoardPhase(item.phase);
    byPhase.get(phase)!.push({ ...item, phase });
  }
  const done = byPhase.get('done')!;
  const seen = new Set(done.map((t) => t.id));
  for (const item of context?.completed_todos ?? []) {
    if (seen.has(item.id)) continue;
    done.push({ ...item, phase: 'done' });
    seen.add(item.id);
  }
  // Fold the current task's steps in as derived read-only cards (kind:'step').
  const titles = new Set<string>();
  for (const cards of byPhase.values()) for (const c of cards) titles.add(c.title.toLowerCase());
  (context?.task_steps ?? []).forEach((step, i) => {
    const title = String(step?.name ?? '').trim();
    if (!title || titles.has(title.toLowerCase())) return;
    const phase = STEP_STATUS_TO_PHASE[step?.status] ?? 'backlog';
    byPhase.get(phase)!.push({
      id: `step-${i}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`,
      title,
      phase,
      kind: 'step',
      created_at: context?.updated_at,
      completed_at: phase === 'done' ? context?.updated_at ?? null : null,
    });
    titles.add(title.toLowerCase());
  });
  return BOARD_PHASES.map((phase) => ({ phase, label: BOARD_PHASE_LABELS[phase], cards: byPhase.get(phase)! }));
}

export interface DecisionEntry {
  summary: string;
  reasoning?: string;
  decided_at?: string;
  importance?: 'low' | 'normal' | 'high' | 'critical';
  resolved?: boolean;
  resolved_at?: string;
  date_inferred?: boolean;
  confidence?: number;
  source_tool?: string;
  verified_at?: string;
}

export interface WeeklyActivity {
  window_days: number;
  context_delivered: number;
  delivered_by_tool: Array<{ tool: string; count: number }>;
  decisions_captured: number;
  knowledge_captured: number;
  contributors: number;
  projects_touched: number;
  stale_projects: number;
  /** Names of the most-recently-touched stale projects (capped server-side); shown on hover. */
  stale_project_names?: string[];
  generated_at: string;
}

export interface RetentionMetrics {
  generated_for: string;
  active_subscriptions: number;
  past_due: number;
  mrr_cents: number;
  arr_cents: number;
  window_days: number;
  new_subscriptions: number;
  renewals: number;
  churned: number;
  churn_rate: number;
  cohort_retention: Array<{ cohort: string; size: number; retained: number; retention: number }>;
}

/**
 * One human who got a brief in the window. Read from Postgres
 * (`context_session_loads`), not PostHog — every recorded distortion of this
 * number (the nightly journey E2E against production, the ad-verification
 * crawler, the `$virt_is_bot` filter that drops server events) lives on the
 * analytics side.
 */
export interface OperatorTodayPerson {
  person_key: string;
  owner_key: string;
  /** Null when the row names no resolvable user. Rendered as the workspace key, never guessed. */
  email: string | null;
  briefs: number;
  projects: number;
  tools: number;
  latest_project: string | null;
  latest_tool: string | null;
  first_brief_at: string;
  last_brief_at: string;
  /**
   * This WORKSPACE's first brief ever landed in the window — the server scopes
   * the probe to `owner_key`, because that is the column its index leads with.
   * At DeerDawn's account shape (effectively all solo workspaces) that is the
   * same thing as the person's first; in a multi-seat org the second seat's
   * debut would not be flagged.
   */
  is_first_ever: boolean;
}

export interface OperatorToday {
  window_start: string;
  window_end: string;
  window_days: number;
  generated_at: string;
  people_count: number;
  first_timers: number;
  briefs_count: number;
  people: OperatorTodayPerson[];
}

// ─── Pure client-side brief derivation ───────────────────────────────────────
// These run with NO network and NO Phase-A backend. They let the dashboard
// render the 4-slot brief against TODAY's API and upgrade transparently when
// Phase A's richer `brief_spine` / `landmines` / `shipped` fields arrive.

// Per-item trust band, one vocabulary across every surface. Prefer the item's
// own `trust` (set by Phase A's brief_spine); otherwise derive from provenance:
//   high       — verified_at set OR confidence >= 0.75
//   inferred   — 0.4 <= confidence < 0.75 OR date_inferred / source_kind 'inferred'
//   unverified — everything else
export function deriveItemTrust(item: {
  trust?: BriefTrust;
  confidence?: number;
  verified_at?: string;
  date_inferred?: boolean;
  source_kind?: string;
}): BriefTrust {
  if (item.trust) return item.trust;
  const c = item.confidence;
  if (item.verified_at || (typeof c === 'number' && c >= 0.75)) return 'high';
  if (
    (typeof c === 'number' && c >= 0.4 && c < 0.75) ||
    item.date_inferred ||
    item.source_kind === 'inferred'
  ) {
    return 'inferred';
  }
  return 'unverified';
}

function decisionToItem(d: DecisionEntry | string, index: number): BriefItem {
  if (typeof d === 'string') return { text: d, index, trust: 'unverified' };
  const item: BriefItem = {
    text: d.summary,
    index,
    confidence: d.confidence,
    verified_at: d.verified_at,
    date_inferred: d.date_inferred,
    source_tool: d.source_tool,
    decided_at: d.decided_at,
    importance: d.importance,
    resolved: d.resolved,
  };
  item.trust = deriveItemTrust(item);
  return item;
}

function landmineToItem(l: Landmine | string, index: number): BriefItem {
  if (typeof l === 'string') return { text: l, index, trust: 'unverified' };
  const item: BriefItem = {
    text: l.text || l.summary || '',
    index,
    confidence: l.confidence,
    verified_at: l.verified_at,
    source_tool: l.source_tool,
    source_kind: l.source_kind,
    added_at: l.added_at,
    importance: l.importance,
  };
  item.trust = deriveItemTrust(item);
  return item;
}

function shippedToItem(s: ShippedEntry | string, index: number): BriefItem {
  if (typeof s === 'string') return { text: s, index, trust: 'high' };
  // Explicit, field by field — NOT a spread. A stored entry carries `summary`
  // and `shipped_at`; the slot renderer reads `text`. The spread this replaces
  // copied neither across, so every shipped card rendered blank: no title, and
  // no date either, since BriefLine had no `shipped_at` to read.
  const item: BriefItem = {
    text: s.text || s.summary || '',
    index,
    confidence: s.confidence,
    source_tool: s.source_tool,
    shipped_at: s.shipped_at,
    ...(s.card_id ? { from_card: true } : {}),
  };
  // Shipped entries come from structured completion events (confidence 1), so
  // they're high-trust unless the payload says otherwise.
  item.trust = deriveItemTrust({ ...item, confidence: item.confidence ?? 1 });
  return item;
}

// Build the 4-slot spine from a raw context object. PREFERS Phase A's richer
// fields when the API provides them, then falls back to today's fields:
//   SHIPPED  ← brief_spine.shipped || context.shipped || a header from current_status
//   DECIDED  ← brief_spine.decided || context.recent_decisions (unresolved)
//   OPEN     ← brief_spine.open     || context.open_questions
//   LANDMINE ← brief_spine.landmine || context.landmines || []  (empty → omitted)
// Empty slots stay empty and are OMITTED by the UI — never fabricated.
export function deriveBriefSpine(context: ProjectContextJson | null | undefined): BriefSpine {
  if (!context) return { shipped: [], decided: [], open: [], landmine: [] };

  // If Phase A's structured spine is present, trust it directly.
  if (context.brief_spine) {
    const s = context.brief_spine;
    const withTrust = (items: BriefItem[]) =>
      (items || []).map((it, i) => ({ ...it, index: i, trust: it.trust || deriveItemTrust(it) }));
    return {
      shipped: withTrust(s.shipped),
      decided: withTrust(s.decided),
      open: withTrust(s.open),
      landmine: withTrust(s.landmine),
    };
  }

  // SHIPPED: prefer the structured accumulator; else synthesize a single header
  // line from current_status so the slot isn't empty for legacy projects.
  let shipped: BriefItem[] = [];
  if (Array.isArray(context.shipped) && context.shipped.length) {
    // .filter matches decided/open/landmine below. A blank card is worse than a
    // missing one: it claims something shipped and refuses to say what.
    shipped = context.shipped.map(shippedToItem).filter((it) => it.text);
  } else if (typeof context.current_status === 'string' && context.current_status.trim()) {
    shipped = [{ text: context.current_status.trim(), index: 0, trust: 'high' }];
  }

  // DECIDED: unresolved recent_decisions only (resolved ones live in DecisionsLog).
  const decided = (context.recent_decisions || [])
    .map(decisionToItem)
    .filter((it) => it.text && !it.resolved);

  // OPEN: open_questions (bare strings today).
  const open = (context.open_questions || [])
    .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
    .map((q, i): BriefItem => ({ text: q, index: i, trust: 'unverified' }));

  // LANDMINE: only if the field exists. Empty → omitted (never fabricated).
  const landmine = Array.isArray(context.landmines)
    ? context.landmines.map(landmineToItem).filter((it) => it.text)
    : [];

  return { shipped, decided, open, landmine };
}

// A 422 from the share endpoints is not a failure to report as "something went
// wrong" — it is the scan handing back a list the user has to look at. Promote
// it to a typed error so the caller can render the findings.
function asShareScanError(err: unknown): unknown {
  if (err instanceof ApiError && err.status === 422 && err.details && typeof err.details === 'object') {
    return new ShareScanError(err.message, err.details as ShareScan);
  }
  return err;
}


// ---- Teams / workspaces -----------------------------------------------------

export interface WorkspaceSummary {
  workspace: string;
  name: string;
  role: 'owner' | 'member' | 'viewer';
  personal: boolean;
  /** The workspace's plan already includes team features (absent on older APIs). */
  team_enabled?: boolean;
}

/**
 * `active` is the STORED CHOICE, and it keeps that meaning: it is the workspace
 * this person selected and the one they go back to once a bill is fixed.
 *
 * `fallback` is the different fact — the choice is not being honoured, because
 * that workspace's subscription has lapsed, and reads are being served from the
 * person's own workspace instead. Absent on an API that predates it, which is
 * why every reader goes through lib/workspaceFallback rather than testing the
 * field directly.
 */
export interface WorkspacesListing {
  active: string;
  workspaces: WorkspaceSummary[];
  fallback?: WorkspaceFallbackResponse | null;
}

export interface WorkspaceConfigFile {
  path: string;
  description: string;
  contents: string;
}

export interface WorkspaceConfig {
  workspace: string;
  workspace_name: string;
  contains_secrets: boolean;
  files: WorkspaceConfigFile[];
  verify: string;
}

export type ProjectVisibility = 'personal' | 'private' | 'shared';

export interface AuthorNotice {
  notice_id: string;
  kind: 'assigned' | 'self_assigned';
  project_id: string;
  project_name: string | null;
  message: string;
  created_at: string;
}

export interface ProjectSharing {
  project_id: string;
  project_name: string;
  visibility: ProjectVisibility;
  owner_user_id: string | null;
  updated_at: string;
  /**
   * The share rows this project has SAVED. An empty list is not "nothing is
   * shared" — it means no configuration exists and today's defaults travel. The
   * two are different decisions, and the panel has to render them differently.
   */
  sections?: ShareSectionRow[];
  /**
   * Whether THIS person's PATCH would be accepted. Decided server-side by the
   * same function the PATCH enforces with, because the rule is not "are you an
   * owner": the project's AUTHOR may change their own, a viewer may change
   * nothing, and a `personal` project belongs to its author alone — an owner
   * included. Absent on an older API, which is read as "offer the control", the
   * behaviour this screen already had.
   */
  can_change_visibility?: boolean;
  /** The server's sentence for why not. Shown instead of a guess. */
  visibility_locked_reason?: string | null;
  /** Owners only: the author stamp resolves to nobody (journey r7). Shown as
   *  "Author unknown", with an Assign author action. */
  author_unknown?: boolean;
}

export interface ProjectSharingPage {
  projects: ProjectSharing[];
  /** Every section that can be configured at all. Absent on an older server. */
  section_allowlist?: string[];
  /** What travels when a project has saved no rows. */
  defaults?: string[];
}

export interface AuditEntry {
  id: string;
  project_id: string | null;
  action: string;
  actor_type: string;
  actor_user_id: string | null;
  actor_email: string | null;
  tool: string | null;
  created_at: string;
}

export interface AuditPage {
  logs: AuditEntry[];
  /** How far back the log goes — stated, never implied by an empty list. */
  retained_since: string | null;
  truncated: boolean;
}

export interface ProjectAccess {
  project_id: string;
  project_name: string;
  visibility: ProjectVisibility;
  accessed_by: {
    user_id: string;
    email: string | null;
    still_a_member: boolean;
    events: number;
    last_at: string;
    actions: string[];
  }[];
}

export interface WorkspaceDomain {
  domain: string;
  role: string;
  created_at: string;
}

export interface JoinableWorkspace {
  workspace: string;
  name: string;
  role: string;
}

export interface TeamMember {
  id: string;
  email: string | null;
  role: 'owner' | 'member' | 'viewer';
  // 'removed' members are listed on purpose: their contributions stay in the
  // workspace brief and stay attributed, so the roster has to explain who a name
  // on a decision belonged to.
  status: 'active' | 'removed';
  removed_at: string | null;
  created_at: string;
}

export interface TeamInvite {
  invite_id: string;
  email: string;
  role: 'owner' | 'member' | 'viewer';
  expires_at: string;
  status: 'pending';
}

export interface TeamRoster {
  actor_role: 'owner' | 'member' | 'viewer';
  members: TeamMember[];
  invites: TeamInvite[];
  /** `included` is the ENTITLEMENT, and it drops to the free tier's single seat
   *  the moment a subscription lapses; `purchased` is what the subscription is
   *  actually billed for. lib/teamSeats picks between them. */
  seats: { used: number; pending: number; included: number | null; purchased?: number | null };
  /** False on a workspace whose subscription lapsed: the roster is served to its
   *  owner anyway so she can see and shrink it. Absent on an older API, which
   *  could only have answered 403 in that case. */
  team_management?: boolean;
  billing?: {
    plan_tier?: string | null;
    subscription_status?: string | null;
    /** A live Stripe subscription, which is what a seat change reprices. */
    has_subscription?: boolean;
    seats_purchased?: number | null;
    /** More people than seats: `{ members, seats, over_by }`; nobody is suspended. */
    seat_shortfall?: { members: number; seats: number; over_by: number } | null;
  } | null;
}

/**
 * One AI tool this person has let in over OAuth, however many times its token
 * has rotated. `surface` is read from the client's own registered NAME
 * (claude_web, chatgpt_web, claude_code, cursor, codex) and is '' when the name
 * says nothing Setup has a card for, or there is no name. `identified` is false
 * when no name was ever recorded: `client_name` is then the client id's host,
 * or null, and it could be any tool.
 */
export interface HostedConnection {
  connection_id: string;
  client_id: string | null;
  client_name: string | null;
  identified: boolean;
  surface: string;
  /** Which tool the client's name says it is; null when it names none. */
  tool?: string | null;
  /** How it connects: always 'hosted_oauth' for a listed connection. */
  transport?: string;
  resource: string;
  first_authorized_at: string;
  last_used_at: string | null;
}

export interface HostedConnectionDisconnect {
  disconnected: boolean;
  connection: HostedConnection;
  revoked: { access_tokens: number; refresh_tokens: number };
  remaining: { access_tokens: number; refresh_tokens: number };
}

/** A hosted connection approved for the team workspace, as its OWNER sees it:
 *  the same row plus whose it is. Never carries a token. See
 *  apps/api/src/routes/shared/teams.js (GET /api/v1/teams/connections). */
export interface TeamConnection extends HostedConnection {
  person: { user_id: string; display_name: string };
  own: boolean;
}

export const api = {
  login: (email: string, password: string) => fetchAPI('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  }),

  signup: (email: string, password: string, opts?: { account_type?: string; plan?: string; referral_code?: string; invite_token?: string }) => fetchAPI('/api/v1/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ email, password, ...opts }),
  }),

  logout: async () => {
    try {
      return await fetchAPI('/api/v1/auth/logout', { method: 'POST' });
    } finally {
      cachedClerkToken = null;
    }
  },

  getCurrentUser: (): Promise<CurrentUser> => fetchAPI('/api/v1/auth/me').then((r) => r.user as CurrentUser),

  // ---- Teams ----------------------------------------------------------------
  getWorkspaces: (): Promise<WorkspacesListing> =>
    fetchAPI('/api/v1/teams/workspaces').then(applyWorkspaceListing),

  getTeam: (): Promise<TeamRoster> => fetchAPI('/api/v1/teams/members'),

  getWorkspaceConfig: (): Promise<WorkspaceConfig> => fetchAPI('/api/v1/teams/workspace-config'),

  getAudit: (params: { project_id?: string; actor_user_id?: string; limit?: number } = {}): Promise<AuditPage> => {
    const q = new URLSearchParams();
    if (params.project_id) q.set('project_id', params.project_id);
    if (params.actor_user_id) q.set('actor_user_id', params.actor_user_id);
    q.set('limit', String(params.limit ?? 100));
    return fetchAPI(`/api/v1/context/audit?${q.toString()}`);
  },

  getProjectAccess: (projectId: string): Promise<ProjectAccess> =>
    fetchAPI(`/api/v1/teams/projects/${encodeURIComponent(projectId)}/access`),

  getWorkspaceDomains: (): Promise<{ domains: WorkspaceDomain[] }> =>
    fetchAPI('/api/v1/teams/domains'),

  addWorkspaceDomain: (domain: string, role = 'member') => fetchAPI('/api/v1/teams/domains', {
    method: 'POST',
    body: JSON.stringify({ domain, role }),
  }),

  removeWorkspaceDomain: (domain: string) =>
    fetchAPI(`/api/v1/teams/domains/${encodeURIComponent(domain)}`, { method: 'DELETE' }),

  getJoinableWorkspaces: (): Promise<{ joinable: JoinableWorkspace[] }> =>
    fetchAPI('/api/v1/teams/joinable'),

  acceptJoinableWorkspace: (workspaceKey: string): Promise<{ success: boolean; workspace?: string; role?: string; activated?: boolean }> =>
    fetchAPI(`/api/v1/teams/joinable/${encodeURIComponent(workspaceKey)}/accept`, { method: 'POST' }),

  // Persist the workspace choice on the SERVER, not just in this browser.
  //
  // The header below is a browser-only override, and an MCP client cannot send
  // one — its OAuth token carries the person's personal org. So a teammate who
  // switched to the team workspace in the dashboard still had their agent
  // sessions resolve to their own empty one. Writing the choice server-side is
  // what makes the two agree.
  //
  // Passing null returns the person to their personal workspace.
  setActiveWorkspaceOnServer: (workspace: string | null): Promise<{ success: boolean; active_workspace: string | null }> =>
    fetchAPI('/api/v1/teams/active', { method: 'POST', body: JSON.stringify({ workspace }) }),

  /**
   * Opens the Team checkout that CREATES a new team workspace. Nothing exists
   * until Stripe confirms the subscription (the webhook creates it), so an
   * abandoned checkout leaves nothing behind. `workspace` is the key it will
   * have; it is not a workspace yet.
   */
  /** Self-hosted only: create a team workspace directly (there is no checkout). */
  createSelfHostedWorkspace: (name: string): Promise<{ created: true; workspace: { key: string; name: string } }> =>
    fetchAPI('/api/v1/teams/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  startTeamWorkspaceCheckout: (name: string, billingCycle: 'monthly' | 'annual', seats: number): Promise<{ url: string; workspace: string; created: false }> =>
    fetchAPI('/api/v1/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({ tierId: 'developer_pro', billingCycle, seats, newWorkspaceName: name }),
    }),

  /** An owner assigns one ACTIVE member as the author of a project whose author
   *  cannot be identified (journey r7). Only for `author_unknown` projects. */
  assignProjectAuthor: (projectId: string, userId: string): Promise<{ success: boolean; project_id: string; from: string; to: string }> =>
    fetchAPI(`/api/v1/teams/projects/${encodeURIComponent(projectId)}/assign-author`, {
      method: 'POST',
      body: JSON.stringify({ user_id: userId }),
    }),

  /** Notices about authorship this person has not been shown yet. */
  getAuthorNotices: (): Promise<{ notices: AuthorNotice[] }> => fetchAPI('/api/v1/teams/author-notices'),
  markAuthorNoticesSeen: (noticeIds: string[]): Promise<{ success: boolean; seen: number }> =>
    fetchAPI('/api/v1/teams/author-notices/seen', { method: 'POST', body: JSON.stringify({ notice_ids: noticeIds }) }),

  moveProjectToWorkspace: (projectId: string, workspaceKey: string) =>
    fetchAPI(`/api/v1/teams/projects/${encodeURIComponent(projectId)}/move`, {
      method: 'POST',
      body: JSON.stringify({ workspace: workspaceKey }),
    }),


  getProjectSharing: (): Promise<ProjectSharingPage> =>
    fetchAPI('/api/v1/teams/projects-sharing'),

  /**
   * `sections` is optional and must be passed whenever the project HAS saved
   * rows: the endpoint rewrites the share, and a payload with no sections falls
   * back to the defaults — so changing visibility alone would quietly discard
   * the author's configuration and publish today's default list in its place.
   */
  setProjectVisibility: (
    projectId: string,
    visibility: ProjectVisibility,
    sections?: ShareSectionRow[],
  ) =>
    fetchAPI(`/api/v1/teams/projects/${encodeURIComponent(projectId)}/sharing`, {
      method: 'PATCH',
      body: JSON.stringify(sections?.length ? { visibility, sections } : { visibility }),
    }),



  inviteTeamMember: (email: string, role: string): Promise<{
    invite_link: string;
    invite_expires_at: string;
    recipient_has_account: boolean;
    /**
     * Whether the invitation email actually left. Undefined from a server that
     * predates the field, which is NOT a yes: treat anything but `true` as
     * "share the link yourself".
     */
    email_sent?: boolean;
    /** True when this refreshed an invitation that was already outstanding: the
     *  link in the earlier email is now dead and this one replaces it. */
    resent?: boolean;
  }> => fetchAPI('/api/v1/teams/invite', {
    method: 'POST',
    body: JSON.stringify({ email, role }),
  }),

  acceptWorkspaceInvite: (token: string): Promise<{ success: boolean; workspace?: string; role?: string; active_workspace?: string | null }> => fetchAPI('/api/v1/teams/invite/accept', {
    method: 'POST',
    body: JSON.stringify({ token }),
  }),

  revokeTeamInvite: (inviteId: string) =>
    fetchAPI(`/api/v1/teams/invites/${encodeURIComponent(inviteId)}`, { method: 'DELETE' }),

  setTeamMemberRole: (userId: string, role: string) =>
    fetchAPI(`/api/v1/teams/members/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    }),

  /** `rehomed_to` is set when the removed person's own default workspace was
   *  this one and they were given a new personal workspace to land in; null
   *  otherwise, and absent on an older API. */
  removeTeamMember: (userId: string): Promise<{ contributions_retained: boolean; keys_revoked: number; rehomed_to?: string | null }> =>
    fetchAPI(`/api/v1/teams/members/${encodeURIComponent(userId)}`, { method: 'DELETE' }),

  getKeys: () => fetchAPI('/api/v1/keys').then((r) => r.keys),
  getOnboardingKey: () => fetchAPI('/api/v1/keys/onboarding'),
  createKey: (name: string, environment: string) => fetchAPI('/api/v1/keys', {
    method: 'POST',
    body: JSON.stringify({ name, environment }),
  }),
deleteKey: (id: string) => fetchAPI(`/api/v1/keys/${id}`, { method: 'DELETE' }),

  // The AI tools this person has let in over OAuth (Claude.ai, ChatGPT, an
  // editor on the hosted endpoint), one row per client. See
  // apps/api/src/routes/shared/connections.js.
  getHostedConnections: (): Promise<HostedConnection[]> =>
    fetchAPI('/api/v1/connections').then((r) => (Array.isArray(r?.connections) ? r.connections : [])),
  /** Revokes that client's access and refresh tokens for this person; the reply is the server's read-back. */
  disconnectHostedConnection: (connectionId: string): Promise<HostedConnectionDisconnect> =>
    fetchAPI(`/api/v1/connections/${encodeURIComponent(connectionId)}`, { method: 'DELETE' }),

  /** Owners only: what colleagues connected to THIS workspace. */
  getTeamConnections: (): Promise<TeamConnection[]> =>
    fetchAPI('/api/v1/teams/connections').then((r) => (Array.isArray(r?.connections) ? r.connections : [])),
  /** Owners only: revokes that connection's access and refresh tokens; the reply is the server's read-back. */
  disconnectTeamConnection: (connectionId: string): Promise<HostedConnectionDisconnect> =>
    fetchAPI(`/api/v1/teams/connections/${encodeURIComponent(connectionId)}`, { method: 'DELETE' }),

  getUsage: (): Promise<OrgUsageSummary> => fetchAPI('/api/v1/orgs/usage'),
  getUsageSummary: (): Promise<UsageSummary> => fetchAPI('/api/v1/billing/usage-summary'),
  getRetentionMetrics: (): Promise<RetentionMetrics> => fetchAPI('/api/v1/metrics/retention'),
  // Platform-staff only, enforced server-side on the same router as
  // /metrics/retention (requireAuth + requirePlatformStaff). A tenant
  // 'admin'/'owner' gets a 403 here, which the page renders as such.
  getOperatorToday: (days = 1): Promise<OperatorToday> =>
    fetchAPI(`/api/v1/metrics/today?days=${encodeURIComponent(String(days))}`),
  getWeeklyActivity: (): Promise<WeeklyActivity> => fetchAPI('/api/v1/context/activity').then((r) => r.activity),
  // Transparency preview: the same export bundle, used to show what we hold.
  getContextExport: (): Promise<ContextExportBundle> => fetchAPI('/api/v1/context/export'),
  // "Get your data out" — authed fetch (route is scope-gated) → blob download.
  downloadContextExport: async (format: 'json' | 'markdown') => {
    const ext = format === 'markdown' ? 'md' : 'json';
    const mime = format === 'markdown' ? 'text/markdown' : 'application/json';
    await downloadAuthedBlob(`/api/v1/context/export?format=${format}`, `deerdawn-context-export.${ext}`, mime);
  },
  getDashboardBootstrap: (): Promise<DashboardBootstrap> => fetchAPI('/api/v1/dashboard/bootstrap'),
  trackProductEvent: (payload: {
    event_name: string;
    source: string;
    surface?: string;
    path?: string;
    session_id?: string;
    started_at?: string;
    ended_at?: string;
    duration_ms?: number;
    metadata?: Record<string, unknown>;
  }) => fetchAPI('/api/v1/product-events', {
    method: 'POST',
    body: JSON.stringify(payload),
    // Terminal funnel events (signup_completed, onboarding_completed) are fired
    // immediately before a client-side navigation (setActive + router.push). Without
    // keepalive the browser cancels the in-flight request as the page tears down, so
    // these completions never reached the API — no product_events row and no PostHog
    // mirror — even though every non-terminal step landed. keepalive lets the POST
    // finish through the navigation. (Bodies are tiny, well under the 64KB cap.)
    keepalive: true,
  }),
  getProductEventSummary: (): Promise<ProductEventSummary> => fetchAPI('/api/v1/product-events/summary').then((r) => r.summary as ProductEventSummary),
  previewContext: (text: string): Promise<{ fields: Record<string, unknown>; brief: string; field_count: number }> =>
    fetchAPI('/api/v1/context/preview', { method: 'POST', body: JSON.stringify({ text }) }),
  getContextProjects: (): Promise<ContextProjectSummary[]> => fetchAPI('/api/v1/context/projects').then((r) => r.projects),
  // Create a project directly. Used by onboarding to write the user's FIRST brief
  // without making them leave for their AI tool: a fresh account has nothing saved,
  // so start_session returns an empty (suppressed) injection and emits no
  // context_delivered — connected but zero value. Seeding here makes has_projects
  // true, so their very next session opens with something real.
  // Deliberately NOT /api/v1/context/seed: that path runs LLM extraction over
  // conversation transcripts, is rate-limited, and can return no_material_change on
  // a short answer — which would silently create nothing. This one is deterministic.
  // Only project_name is required server-side; the rest default.
  createContextProject: (payload: {
    project_name: string;
    current_task?: string;
    description?: string;
  }): Promise<{ project: ContextProjectSummary }> =>
    fetchAPI('/api/v1/context/projects', { method: 'POST', body: JSON.stringify(payload) }),
  /**
   * Claim briefs built anonymously at deerdawn.com/tools/context-preview.
   *
   * Throws ApiError 410 when the stash is gone (expired after an hour, already
   * claimed, or never existed). That is deliberately NOT an empty success: the
   * user was promised their briefs would carry over, and if they did not, the
   * caller has to say so rather than show an empty workspace.
   */
  claimBriefStash: (stashToken: string): Promise<{
    claimed: Array<{ project_id: string; project_name: string; fields_applied: number }>;
    failed: Array<{ label: string; reason: string }>;
    claimed_count: number;
  }> =>
    fetchAPI('/api/v1/context/brief-stash/claim', {
      method: 'POST',
      body: JSON.stringify({ stash_token: stashToken }),
    }),
  // ── Project management ──────────────────────────────────────────────────────
  // The API has carried every one of these since subprojects shipped; the
  // dashboard exposed none, so after onboarding a project could only be renamed,
  // archived, restored, moved or deleted through an AI tool.
  renameContextProject: (projectId: string, projectName: string): Promise<{ project_id: string; project_name: string }> =>
    fetchAPI(`/api/v1/context/projects/${encodeURIComponent(projectId)}/rename`, {
      method: 'POST',
      body: JSON.stringify({ project_name: projectName }),
    }),
  archiveContextProject: (projectId: string, opts: { unarchive?: boolean } = {}): Promise<{ project_id: string; project_name: string; archived_at: string | null }> =>
    fetchAPI(`/api/v1/context/projects/${encodeURIComponent(projectId)}/archive`, {
      method: 'POST',
      body: JSON.stringify(opts.unarchive ? { unarchive: true } : {}),
    }),
  /** Irreversible: removes the project and its graph nodes. */
  deleteContextProject: (projectId: string): Promise<{ success: boolean; deleted: string }> =>
    fetchAPI(`/api/v1/context/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' }),
  /** Nest under `parentProjectId`, or promote to top level with null. */
  setContextProjectParent: (projectId: string, parentProjectId: string | null): Promise<{ project_id: string; parent_project_id: string | null }> =>
    fetchAPI(`/api/v1/context/projects/${encodeURIComponent(projectId)}/parent`, {
      method: 'POST',
      body: JSON.stringify({ parent_project_id: parentProjectId }),
    }),
  getArchivedContextProjects: (): Promise<Array<{ project_id: string; project_name: string; archived_at?: string | null }>> =>
    fetchAPI('/api/v1/context/projects?archived=1&limit=500').then((r) => r.projects || []),
  // Top-level projects with their subprojects nested under `subprojects`.
  getContextProjectsTree: (): Promise<ContextProjectSummary[]> => fetchAPI('/api/v1/context/projects/tree').then((r) => r.projects),
  // FULL context object WITH per-item provenance — use this (not getContextProjects,
  // which strips provenance) to build the 4-slot brief. Returns Phase A's
  // `brief_spine` when present; otherwise the dashboard derives it client-side.
  getProjectContextJson: (projectId: string): Promise<ProjectContextJson> =>
    fetchAPI(`/api/v1/context/projects/${projectId}/inject?format=json`).then((r) => r.context as ProjectContextJson),
  // The active project's rendered brief (today's text shape). `shape: 'spine'` is
  // opt-in and only returns a structured brief_spine once Phase B deploys it;
  // until then the response carries the text brief and brief_spine stays absent.
  getActiveBrief: (params: { tool?: string; verbosity?: string; tz?: string; shape?: 'spine' } = {}): Promise<Brief> => {
    const query = new URLSearchParams();
    if (params.tool) query.set('tool', params.tool);
    if (params.verbosity) query.set('verbosity', params.verbosity);
    if (params.tz) query.set('tz', params.tz);
    if (params.shape) query.set('shape', params.shape);
    const qs = query.toString();
    return fetchAPI(`/api/v1/context/active${qs ? `?${qs}` : ''}`).then((r) => ({
      project_id: r.project_id ?? null,
      project_name: r.project_name ?? null,
      last_updated: r.last_updated ?? null,
      brief: r.brief ?? null,
      brief_spine: r.brief_spine ?? null,
      match_kind: r.match_kind ?? null,
    } as Brief));
  },
  // The rendered injection body for a specific project + tool — powers the
  // "this is what your AI reads" per-tool preview.
  getProjectInject: (projectId: string, params: { tool?: string; verbosity?: string } = {}): Promise<{ body: string }> => {
    const query = new URLSearchParams();
    if (params.tool) query.set('tool', params.tool);
    if (params.verbosity) query.set('verbosity', params.verbosity);
    const qs = query.toString();
    return fetchAPI(`/api/v1/context/projects/${projectId}/inject${qs ? `?${qs}` : ''}`).then((r) => ({
      body: (r.payload?.body as string) ?? '',
    }));
  },
  seedContext: (payload: { source: string; projects: { name: string; conversations: { title?: string; messages: { role: string; text: string }[] }[] }[] }) =>
    fetchAPI('/api/v1/context/seed', { method: 'POST', body: JSON.stringify(payload) }),
  // Email the setup link to finish on a computer — a phone can't wire an MCP
  // server into a desktop AI tool. Reuses the public leads endpoint (which emails
  // the remote MCP URL + steps); the auth header is harmless there.
  requestMobileSetupLink: (email: string): Promise<{ success: boolean }> =>
    fetchAPI('/api/v1/public/leads', {
      method: 'POST',
      body: JSON.stringify({
        email,
        resource_type: 'setup_link',
        source_type: 'onboarding_mobile',
        source_route: '/onboarding',
        use_case: 'mobile_setup_link',
      }),
    }),
  getContextProjectGraph: (projectId: string): Promise<ContextGraphResult> => fetchAPI(`/api/v1/context/graph/projects/${projectId}`).then((r) => r.graph),
  getWorkspaceOverview: (params: { mode?: 'startup' | 'overview'; verbosity?: 'light' | 'standard' | 'detailed'; include?: string[] } = {}): Promise<WorkspaceOverviewResult> => {
    const query = new URLSearchParams();
    query.set('format', 'json');
    if (params.mode) query.set('mode', params.mode);
    if (params.verbosity) query.set('verbosity', params.verbosity);
    if (params.include?.length) query.set('include', params.include.join(','));
    return fetchAPI(`/api/v1/context/workspace/overview?${query.toString()}`).then((r) => r.overview);
  },
  getWorkspaceEntities: (params: { types?: string[]; query?: string; project_id?: string; related_project_id?: string; scope?: 'workspace' | 'project'; surface?: string; status?: string; include_inferred?: boolean; curated_only?: boolean; limit?: number } = {}) => {
    const query = new URLSearchParams();
    query.set('format', 'json');
    if (params.types?.length) query.set('types', params.types.join(','));
    if (params.query) query.set('query', params.query);
    if (params.project_id) query.set('project_id', params.project_id);
    if (params.related_project_id) query.set('related_project_id', params.related_project_id);
    if (params.scope) query.set('scope', params.scope);
    if (params.surface) query.set('surface', params.surface);
    if (params.status) query.set('status', params.status);
    if (typeof params.include_inferred === 'boolean') query.set('include_inferred', String(params.include_inferred));
    if (typeof params.curated_only === 'boolean') query.set('curated_only', String(params.curated_only));
    if (typeof params.limit === 'number') query.set('limit', String(params.limit));
    return fetchAPI(`/api/v1/context/workspace/entities?${query.toString()}`).then((r) => r.entities as ContextGraphNode[]);
  },
  getNextBestContext: (params: { tool?: string; cwd?: string; project_id?: string; limit?: number } = {}): Promise<NextBestContextResult> => {
    const query = new URLSearchParams();
    if (params.tool) query.set('tool', params.tool);
    if (params.cwd) query.set('cwd', params.cwd);
    if (params.project_id) query.set('project_id', params.project_id);
    if (typeof params.limit === 'number') query.set('limit', String(params.limit));
    return fetchAPI(`/api/v1/context/workspace/next?${query.toString()}`).then((r) => r.result);
  },
  upsertWorkspaceEntities: (payload: {
    entities: Array<{
      entity_type: string;
      title: string;
      summary?: string;
      scope?: 'workspace' | 'project';
      project_id?: string;
      metadata?: Record<string, unknown>;
    }>;
    relations?: Array<{
      from_canonical_key: string;
      to_canonical_key: string;
      relation_type: string;
      summary?: string;
    }>;
  }) => fetchAPI('/api/v1/context/workspace/entities', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  getLocalSetupStatus: async (): Promise<SetupStatusResult> => {
    // The local DeerDawn CLI listens on 127.0.0.1:41338. Probing it from the
    // browser is the only way to detect it from a hosted dashboard, but when
    // the CLI isn't running the failed fetch logs ERR_CONNECTION_REFUSED on
    // every bootstrap. Cache the "no local CLI" result per session so we probe
    // at most once per session and fall straight through to the server route
    // afterwards. A fresh tab (e.g. the one the CLI opens) gets a clean probe.
    if (typeof window !== 'undefined' && sessionStorage.getItem(LOCAL_SETUP_UNAVAILABLE_KEY) !== '1') {
      try {
        const local = await fetchLocalSetup('/setup/status');
        return local.status as SetupStatusResult;
      } catch {
        try { sessionStorage.setItem(LOCAL_SETUP_UNAVAILABLE_KEY, '1'); } catch { /* storage may be unavailable */ }
      }
    }
    // No local CLI. There used to be a fallback to /api/setup-status here, but
    // that route can only ever answer a constant "unavailable" (a hosted
    // dashboard cannot inspect the visitor's machine), and it 401s whenever the
    // Clerk session is not visible to Next's API routes, which put a red error
    // in the console on every dashboard load for no information. Both callers
    // already treat a rejection as "no local setup".
    throw new ApiError(503, 'The local DeerDawn CLI is not running.', 'local_setup_unavailable');
  },
  applyLocalSetup: async (payload: { surface: string; mode?: 'auto' | 'repair' | 'restore' }): Promise<SetupApplyResult> => {
    if (typeof window !== 'undefined') {
      try {
        const local = await fetchLocalSetup('/setup/apply', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        return local.result as SetupApplyResult;
      } catch {
        // Fall through to dashboard-hosted fallback route.
      }
    }
    return fetchDashboardRoute('/api/setup-apply', {
      method: 'POST',
      body: JSON.stringify(payload),
    }).then((r) => r.result as SetupApplyResult);
  },
  deleteGraphNode: (nodeId: string) => fetchAPI(`/api/v1/context/graph/nodes/${nodeId}`, { method: 'DELETE' }),
  updateGraphNode: (nodeId: string, patch: { title?: string; summary?: string; importance?: 'low' | 'normal' | 'high' | 'critical'; pinned?: boolean }) =>
    fetchAPI(`/api/v1/context/graph/nodes/${nodeId}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.node as ContextGraphNode),
  getVaultHealth: (): Promise<VaultHealthResult> => fetchAPI('/api/v1/context/graph/vault-health').then((r) => r.health),
  // `expectedContextVersion`: the context_version of the read this patch was
  // built from (getProjectContextJson carries it). Sent, the API refuses the
  // write with 409 stale_context_version when the brief has moved on since that
  // read, instead of replacing a list over whatever landed in between. Left out
  // (or null), the write is unconditional, as it always was.
  updateProjectContext: (
    projectId: string,
    patch: Partial<ContextProjectSummary['context']>,
    options: { expectedContextVersion?: number | null } = {},
  ) => {
    const version = options.expectedContextVersion;
    const body = typeof version === 'number' && Number.isInteger(version) && version >= 0
      ? { ...patch, expected_context_version: version }
      : patch;
    return fetchAPI(`/api/v1/context/projects/${projectId}/context`, { method: 'PATCH', body: JSON.stringify(body) });
  },
  resolveQuestion: (projectId: string, question: string, answer: string) =>
    fetchAPI(`/api/v1/context/projects/${projectId}/questions/resolve`, { method: 'POST', body: JSON.stringify({ question, answer }) }),
  getToolsStatus: (): Promise<{ tools: Record<string, { last_seen: string | null }> }> =>
    fetchAPI('/api/v1/context/tools/status'),
  getContextPreferences: () => fetchAPI('/api/v1/context/preferences').then((r) => r.preferences),
  updateContextPreferences: (prefs: Record<string, unknown>) => fetchAPI('/api/v1/context/preferences', { method: 'PATCH', body: JSON.stringify(prefs) }),
  getGlobalContext: (): Promise<{ user_profile: string; preferences: string[]; recurring_instructions: string[]; global_stack: string[]; expertise_areas: string[]; goals: string[]; working_style: string; values: string[]; communication_preferences: string }> =>
    fetchAPI('/api/v1/context/global').then((r) => r.global),
  // True while the person has not yet looked at a profile that existed before
  // extraction stopped filling it from their projects (one-time note).
  getProfileReviewNeeded: (): Promise<boolean> =>
    fetchAPI('/api/v1/context/global').then((r) => r.review_needed === true),
  dismissProfileReview: () =>
    fetchAPI('/api/v1/context/global/review', { method: 'POST', body: JSON.stringify({}) }),
  updateGlobalContext: (data: Partial<{ user_profile: string; preferences: string[]; recurring_instructions: string[]; global_stack: string[]; expertise_areas: string[]; goals: string[]; working_style: string; values: string[]; communication_preferences: string }>) =>
    fetchAPI('/api/v1/context/global', { method: 'PATCH', body: JSON.stringify(data) }).then((r) => r.global),
  createClaudeAgent: (anthropic_api_key: string) =>
    fetchAPI('/api/v1/context/integrations/claude-agent', { method: 'POST', body: JSON.stringify({ anthropic_api_key }) }),
  deleteClaudeAgent: () =>
    fetchAPI('/api/v1/context/integrations/claude-agent', { method: 'DELETE' }),
  getUserscriptUrl: (tool: WebCaptureTool) => {
    // Returns the URL the userscript is served from (display only).
    return `${apiBase()}/api/v1/context/userscript?tool=${tool}`;
  },
  // The userscript route is auth + role gated, so a plain link 401s — fetch it
  // with the session token and hand the browser a blob to install.
  downloadUserscript: async (tool: WebCaptureTool) => {
    await downloadAuthedBlob(`/api/v1/context/userscript?tool=${tool}`, `deerdawn-${tool}.user.js`, 'application/javascript');
  },
  queryContextGraph: (input: { project_id?: string; session_id?: string; node_id?: string }): Promise<ContextGraphResult> => fetchAPI('/api/v1/context/graph/query', {
    method: 'POST',
    body: JSON.stringify(input),
  }).then((r) => r.graph),
  getOnboardingState: () => fetchAPI('/api/v1/onboarding/state').then((r) => r.state),
  getOnboardingSurvey: (): Promise<{ completed: boolean; survey: OnboardingSurvey | null }> =>
    fetchAPI('/api/v1/onboarding/survey'),
  saveOnboardingSurvey: (payload: OnboardingSurveyInput): Promise<{ completed: boolean; survey: OnboardingSurvey }> =>
    fetchAPI('/api/v1/onboarding/survey', { method: 'POST', body: JSON.stringify(payload) }),
  setOnboardingTemplate: (template: string) => fetchAPI('/api/v1/onboarding/template', {
    method: 'PATCH',
    body: JSON.stringify({ template }),
  }).then((r) => r.state),
  updateOrgSettings: (settings: { redaction_mode?: string; redaction_keys?: string[]; is_locked?: boolean; shadow_mode?: boolean }) => fetchAPI('/api/v1/orgs/settings', {
    method: 'PATCH',
    body: JSON.stringify(settings),
  }),
  // No referral_code parameter, on purpose. An invite is applied while the
  // account is being created — POST /auth/signup, or the Clerk webhook reading
  // the code out of signup metadata — and the API now refuses one from this
  // authenticated handoff (error `referral_signup_only`). Sending it here only
  // ever meant "attach somebody's code to an account that already exists",
  // which is the half of referral farming that needs no puppet at all.
  updateAccountType: (account_type?: string, plan?: string) => fetchAPI('/api/v1/orgs/account-type', {
    method: 'PATCH',
    body: JSON.stringify({ account_type, plan }),
  }),
  // `billingCycle` is OPTIONAL and deliberately has no default. A surface with
  // no billing toggle must send none: the API then keeps the cadence the
  // subscription is already on, instead of moving an annual subscriber to
  // monthly as a side effect of changing plan. A new checkout still defaults to
  // monthly server-side.
  // `allowReduce` is the one flag that lets a seat count go DOWN. The route
  // refuses a reduction with 409 `seat_reduction_not_confirmed` without it,
  // which is deliberate: a link carrying `?seats=2` must not be able to take
  // three seats off a five-seat team on a GET. Send it only after the person has
  // confirmed a reduction that NAMED both numbers.
  upgrade: (tierId: string, billingCycle?: 'monthly' | 'annual', promotionCode?: string, campaign?: string, seats?: number, allowReduce?: boolean): Promise<CheckoutStart> => fetchAPI('/api/v1/billing/checkout', {
    method: 'POST',
    body: JSON.stringify({ tierId, billingCycle, promotionCode, campaign, seats, ...(allowReduce ? { allow_reduce: true } : {}) }),
  }),
  // `seats` is ignored for per-person plans and is the quantity for per-seat
  // ones. Omitting it billed a whole team at one seat's price.
  checkout: (tierId: string, billingCycle: 'monthly' | 'annual' = 'monthly', promotionCode?: string, campaign?: string, seats?: number): Promise<CheckoutStart> => fetchAPI('/api/v1/billing/checkout', {
    method: 'POST',
    body: JSON.stringify({ tierId, billingCycle, promotionCode, campaign, seats }),
  }),
  // Buying a seat is the SAME endpoint, and deliberately not a second one: a
  // same-tier request from an owner that names a seat count is repriced onto the
  // existing subscription rather than opening a Checkout session. It has its own
  // name here because "upgrade" is the wrong word at the call site — the plan
  // does not move — and because no cadence may be sent: the subscription keeps
  // the billing period it already has.
  setSeatCount: (tierId: string, seats: number): Promise<CheckoutStart> => fetchAPI('/api/v1/billing/checkout', {
    method: 'POST',
    body: JSON.stringify({ tierId, seats }),
  }),
  getPortalUrl: (flow?: 'payment_method' | 'cancel') => fetchAPI('/api/v1/billing/portal', {
    method: 'POST',
    body: JSON.stringify(flow ? { flow } : {}),
  }),
  // Who pays (journey r6). Taking billing over: start opens Stripe's card flow,
  // confirm reads the result back. Ending at the period's end is the payer's own
  // way out. See lib/billingOwner.
  startBillingTakeover: () => fetchAPI('/api/v1/billing/takeover/start', {
    method: 'POST',
    body: JSON.stringify({}),
  }) as Promise<{ started: boolean; url: string }>,
  confirmBillingTakeover: () => fetchAPI('/api/v1/billing/takeover/confirm', {
    method: 'POST',
    body: JSON.stringify({}),
  }) as Promise<{ status: 'none' | 'nothing_renews' | 'pending' | 'confirmed' | 'not_applied'; billing_owner_is_you: boolean }>,
  cancelAtPeriodEnd: () => fetchAPI('/api/v1/billing/cancel-at-period-end', {
    method: 'POST',
    body: JSON.stringify({}),
  }) as Promise<{ cancelled: string[]; already_ending: string[]; ends_on: string | null; message: string }>,
  downgradeToFree: () => fetchAPI('/api/v1/billing/downgrade', { method: 'POST' }) as Promise<{
    success: boolean;
    plan_tier: string;
  }>,
  deleteOrg: (body: { password?: string; confirm_email?: string; email_export: boolean }) =>
    fetchAPI('/api/v1/orgs', { method: 'DELETE', body: JSON.stringify(body) }) as Promise<{
      success: boolean;
      export_emailed: boolean;
      // Other workspaces closed with the account because nobody else was left in them.
      closed_workspaces?: Array<{ workspace: string; name: string | null }>;
      message: string;
    }>,

  getUsers: () => fetchAPI('/api/v1/orgs/users').then((r) => r.users),
  deleteUser: (id: string) => fetchAPI(`/api/v1/orgs/users/${id}`, { method: 'DELETE' }),
  getInviteCode: () => fetchAPI('/api/v1/orgs/invite-code'),
  generateInviteCode: () => fetchAPI('/api/v1/orgs/invite-code/generate', { method: 'POST' }),
  joinOrg: (invite_code: string) => fetchAPI('/api/v1/orgs/join', {
    method: 'POST',
    body: JSON.stringify({ invite_code }),
  }),
  getReferralOverview: (): Promise<ReferralOverview> => fetchAPI('/api/v1/orgs/referrals/me'),
  getHealthMetrics: () => fetchAPI('/health/metrics'),

  listContentPages: (type?: string): Promise<ContentPage[]> => {
    const query = type ? `?type=${encodeURIComponent(type)}` : '';
    return fetchAPI(`/api/v1/admin/content${query}`).then((r) => r.pages);
  },
  saveContentPage: (page: ContentPage): Promise<{ page: ContentPage }> => {
    const endpoint = page.content_id ? `/api/v1/admin/content/${page.content_id}` : '/api/v1/admin/content';
    return fetchAPI(endpoint, {
      method: page.content_id ? 'PUT' : 'POST',
      body: JSON.stringify(page),
    });
  },
  publishContentPage: (contentId: string): Promise<{ page: ContentPage }> => fetchAPI(`/api/v1/admin/content/${contentId}/publish`, {
    method: 'POST',
  }),
  archiveContentPage: (contentId: string): Promise<{ page: ContentPage }> => fetchAPI(`/api/v1/admin/content/${contentId}/archive`, {
    method: 'POST',
  }),
  // Repointed to /graph/export. Two handlers were registered for GET /export, so Express
  // always dispatched to the first (the JSON context bundle) and this caller silently
  // received a payload that did not match its own declared { files, count } type. The
  // per-node markdown export it actually wants now lives at its own path.
  exportObsidianVault: (): Promise<{ files: { path: string; content: string }[]; count: number }> =>
    fetchAPI('/api/v1/context/graph/export'),
  getAuditLog: (params?: { project_id?: string; action?: string; limit?: number }): Promise<{ logs: Array<{ id: string; project_id: string | null; action: string; actor_type: string | null; tool: string | null; metadata: Record<string, unknown> | null; created_at: string }> }> =>
    fetchAPI(`/api/v1/context/audit${params ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])) : ''}`),
  /**
   * Empty the BOUND workspace: every project, brief, session, graph node, audit
   * line, shared skill, integration credential and API key it holds, plus the
   * Stripe subscription, which is cancelled FIRST and aborts the deletion if it
   * fails. The account itself survives — that is DELETE /api/v1/orgs.
   *
   * `confirmation` is required and compared verbatim (lib/accountErasure holds
   * the phrase, pinned to the route). This used to be sent with no body at all
   * and its result typed as a `confirmation_token` the route has never
   * returned, so the control could not succeed and could not report why.
   */
  deleteAccount: (confirmation: string): Promise<{
    deleted: boolean;
    deleted_counts?: Record<string, number>;
    subscription_cancelled?: boolean;
  }> =>
    fetchAPI('/api/v1/context/account', {
      method: 'DELETE',
      body: JSON.stringify({ confirmation }),
    }),

  // Shared skills — workspace know-how distributed across connected tools. The
  // list endpoint returns metadata only (no markdown_content); fetch a single
  // skill to get the full SKILL.md body.
  getSharedSkills: (projectId?: string): Promise<SharedSkill[]> => {
    const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
    return fetchAPI(`/api/v1/context/skills${query}`).then((r) => r.skills as SharedSkill[]);
  },
  getSharedSkill: (idOrSlug: string): Promise<SharedSkill> =>
    fetchAPI(`/api/v1/context/skills/${encodeURIComponent(idOrSlug)}`).then((r) => r.skill as SharedSkill),
  createSharedSkill: (payload: {
    slug?: string;
    name: string;
    description: string;
    markdown_content: string;
    project_id?: string | null;
    visibility?: 'private' | 'shared' | 'public';
  }): Promise<SharedSkill> =>
    fetchAPI('/api/v1/context/skills', { method: 'POST', body: JSON.stringify(payload) }).then((r) => r.skill as SharedSkill),
  updateSharedSkill: (id: string, patch: {
    name?: string;
    description?: string;
    markdown_content?: string;
    project_id?: string | null;
    visibility?: 'private' | 'shared' | 'public';
    enabled?: boolean;
  }): Promise<SharedSkill> =>
    fetchAPI('/api/v1/context/skills', { method: 'POST', body: JSON.stringify({ skill_id: id, ...patch }) }).then((r) => r.skill as SharedSkill),
  deleteSharedSkill: (id: string): Promise<null> =>
    fetchAPI(`/api/v1/context/skills/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // Import a skill by pasting a GitHub repo URL. The API fetches the repo's
  // SKILL.md, parses its frontmatter, and creates the shared skill.
  importSkillFromGithub: (payload: { repo_url: string; project_id?: string | null }): Promise<{ skill: SharedSkill; source_url?: string }> =>
    fetchAPI('/api/v1/context/skills/import-github', { method: 'POST', body: JSON.stringify(payload) }),

  // ── Portfolio ──────────────────────────────────────────────────────────────
  // Free calls this too and gets `locked: true` with its own real counts. There
  // is deliberately no separate "locked" endpoint to call instead.
  getPortfolio: (params: { q?: string } = {}): Promise<Portfolio> => {
    const query = params.q ? `?q=${encodeURIComponent(params.q)}` : '';
    return fetchAPI(`/api/v1/context/portfolio${query}`);
  },

  // ── Trails ─────────────────────────────────────────────────────────────────
  /**
   * Import a .dawn Trail. Needs an account and the context:write scope, and
   * nothing installed — which is the point: it is one of the few things a
   * signed-in user with no MCP connection can actually do.
   *
   * `trail` takes the file's CONTENTS (or an https URL to one). Pass dryRun to
   * get the plan and any conflicts back without writing.
   */
  importTrail: (
    trail: string,
    opts: { projectId?: string; newProjectName?: string; dryRun?: boolean } = {}
  ): Promise<{
    applied: boolean;
    plan?: unknown;
    conflicts?: unknown[];
    patch_keys?: string[];
    project_id?: string;
    project_name?: string;
  }> =>
    fetchAPI('/api/v1/context/trail/import', {
      method: 'POST',
      timeoutMs: opts.dryRun ? FETCH_TIMEOUT_MS : 60_000,
      body: JSON.stringify({
        trail,
        project_id: opts.projectId,
        new_project_name: opts.newProjectName,
        dry_run: opts.dryRun,
      }),
    }),

  // ── Share links ────────────────────────────────────────────────────────────
  previewShare: (projectId: string): Promise<{ preview: unknown; scan: ShareScan }> =>
    fetchAPI(`/api/v1/context/projects/${encodeURIComponent(projectId)}/share/preview`),

  // Returns can_create alongside the list: listing is ungated (a downgraded
  // account still owns and can revoke its existing links) while minting is a
  // paid action, so the caller needs both facts to render the right state.
  getShareLinks: (): Promise<{ can_create: boolean; shares: ShareLink[] }> =>
    fetchAPI('/api/v1/context/shares'),

  createShareLink: async (projectId: string, payload: {
    visibility?: 'unlisted' | 'public';
    acknowledged_finding_ids?: string[];
  } = {}): Promise<{ share: ShareLink; scan: ShareScan }> => {
    try {
      return await fetchAPI(`/api/v1/context/projects/${encodeURIComponent(projectId)}/share`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw asShareScanError(err);
    }
  },

  setShareVisibility: async (token: string, visibility: 'unlisted' | 'public', acknowledged_finding_ids: string[] = []): Promise<ShareLink> => {
    try {
      const r = await fetchAPI(`/api/v1/context/shares/${encodeURIComponent(token)}`, {
        method: 'PATCH',
        body: JSON.stringify({ visibility, acknowledged_finding_ids }),
      });
      return r.share as ShareLink;
    } catch (err) {
      throw asShareScanError(err);
    }
  },

  revokeShareLink: (token: string): Promise<ShareLink> =>
    fetchAPI(`/api/v1/context/shares/${encodeURIComponent(token)}`, { method: 'DELETE' }).then((r) => r.share as ShareLink),
};
