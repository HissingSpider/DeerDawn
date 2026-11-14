import axios, { AxiosInstance, AxiosError } from 'axios';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Config } from './config.js';
import { safeWriteFileSync } from './utils/safe-fs.js';
import type {
  OrganizationSettings,
  AuditLog,
  ActionTypeDefinition,
} from './types.js';
import { getAgentSessionId, getAgentSessionContext } from './agent-session.js';
import { resolveIdentifiedSurface } from './surface.js';
import { getWorkspaceKey } from './freshness.js';
import { markCredentialsRejected } from './auth-state.js';
import { sanitizeProductEvent } from './telemetry-safe.js';
import { redactSecrets } from './redact.js';
import { locationHeaders, legacyLocationQuery, locationAcknowledged, LOCATION_ACK_HEADER, type SessionLocation } from './location-headers.js';
import { workspaceHeaders } from './workspace-override.js';

/**
 * The repo identity for a working directory, derived once per process per cwd.
 *
 * Active-project resolution honours an explicit subproject pin (switch_subproject)
 * only when the request carries `workspace_key`. Passing it was left to each call
 * site, and only the two READ paths — start_session and the task board — ever
 * did, so every write resolved its project with the pin skipped: you read the
 * subproject you pinned and saved into its sibling.
 *
 * Deriving it from the cwd here removes the choice. Every caller that resolves
 * "the project I am in" already has a cwd and nothing else, so the key can now
 * only be absent when there is genuinely no repo. Cached because getWorkspaceKey
 * shells out to git twice and this sits on the hook-latency path; a checkout's
 * origin does not change under a running process, and a wrong cache entry would
 * only ever be a stale pin, never another workspace's.
 */
const workspaceKeyCache = new Map<string, string | null>();
export function workspaceKeyForCwd(cwd?: string | null): string | null {
  if (!cwd) return null;
  if (!workspaceKeyCache.has(cwd)) {
    let key: string | null = null;
    try { key = getWorkspaceKey(cwd); } catch { key = null; }
    workspaceKeyCache.set(cwd, key);
  }
  return workspaceKeyCache.get(cwd) ?? null;
}

type RetryableRequestConfig = NonNullable<AxiosError['config']> & {
  __retryCount?: number;
  __firstRetryTimestamp?: number;
};

type OrgUsageApiResponse = {
  org_name?: string;
  plan?: {
    org_id?: string;
    tier?: string;
    fail_mode?: string;
    redaction_mode?: string;
    is_locked?: boolean;
    shadow_mode?: boolean;
    redaction_keys?: string[];
  };
  usage?: Record<string, unknown>;
  limits?: Record<string, unknown>;
};

type ProductEventRequest = {
  event_name: string;
  source: string;
  surface?: string | null;
  path?: string | null;
  session_id?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  duration_ms?: number | null;
  metadata?: Record<string, unknown>;
};

type StructuredContextEventRequest = {
  event_type:
    | 'task_started'
    | 'task_completed'
    | 'decision_made'
    | 'question_asked'
    | 'question_answered'
    | 'file_changed'
    | 'command_confirmed'
    | 'feature_shipped'
    | 'debug_finding'
    | 'hot_path_discovered'
    | 'blocker_opened'
    | 'blocker_resolved'
    | 'todo_added'
    | 'todo_moved'
    | 'todo_completed'
    | 'todo_removed';
  project_id?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
};

type QueuedContextWrite = {
  id: string;
  method: 'POST';
  path: '/api/v1/context/events';
  body: StructuredContextEventRequest;
  created_at: string;
};

type QueueState = { entries: QueuedContextWrite[] };

type ContextGraphResponse = Record<string, unknown>;
type CachedEntry<T> = { data: T; expires: number };

export type SkillMeta = {
  skill_id: string;
  slug: string;
  name: string;
  description: string;
  visibility: 'private' | 'shared' | 'public';
  enabled: boolean;
  project_id?: string | null;
};

export type Skill = SkillMeta & { markdown_content: string };

export type SkillUpsertInput = {
  slug?: string;
  name: string;
  description?: string;
  markdown_content: string;
  project_id?: string | null;
  visibility?: 'private' | 'shared' | 'public';
};

function isLocalApiUrl(apiUrl: string): boolean {
  try {
    const host = new URL(apiUrl).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function getDeerdawnHome(): string {
  return process.env.DEERDAWN_HOME || path.join(os.homedir(), '.deerdawn');
}

function getQueuePath(): string {
  return path.join(getDeerdawnHome(), 'cloud-write-queue.json');
}

function ensureDeerdawnHome(): void {
  fs.mkdirSync(getDeerdawnHome(), { recursive: true });
}

function readQueueState(): QueueState {
  try {
    return JSON.parse(fs.readFileSync(getQueuePath(), 'utf8')) as QueueState;
  } catch {
    return { entries: [] };
  }
}

// The queue is what an offline session writes to instead of the API, and it had
// no ceiling: every command and every file change on a machine that could not
// reach the API appended another entry, for as long as that lasted, to a file
// that is re-read, re-serialised and rewritten whole on each append. A laptop
// left off-network for a week grew it without bound, and the eventual flush
// replayed all of it one request at a time inside start_session.
//
// Capped on both axes, oldest dropped: recent events are the ones a brief can
// still use, and a count alone does not bound the file (one entry can carry a
// long summary). An entry too large to fit on its own is not queued at all.
export const QUEUE_MAX_ENTRIES = 200;
export const QUEUE_MAX_BYTES = 512 * 1024;

function capQueue(entries: QueuedContextWrite[]): QueuedContextWrite[] {
  const recent = entries.length > QUEUE_MAX_ENTRIES ? entries.slice(entries.length - QUEUE_MAX_ENTRIES) : entries;
  // Sized from the newest backwards, so the survivors are the most recent ones
  // that fit. An entry that cannot fit on its own is skipped rather than allowed
  // to end the walk — otherwise one oversize event would evict the whole queue.
  const kept: QueuedContextWrite[] = [];
  let bytes = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(JSON.stringify(recent[i]), 'utf8');
    if (size > QUEUE_MAX_BYTES) continue;
    if (bytes + size > QUEUE_MAX_BYTES) break;
    bytes += size;
    kept.push(recent[i]);
  }
  return kept.reverse();
}

function writeQueueState(state: QueueState): void {
  ensureDeerdawnHome();
  const entries = capQueue(Array.isArray(state.entries) ? state.entries : []);
  // Compact, not pretty-printed: indentation was a third of the file, and the
  // byte cap above is measured on the compact form.
  safeWriteFileSync(getQueuePath(), JSON.stringify({ entries }));
  state.entries = entries;
}

/**
 * How a HOOK talks to the API, as opposed to a tool call.
 *
 * A tool call is something the agent is waiting on and the user asked for, so 30
 * seconds and three backed-off retries are reasonable. A hook fires on every
 * Bash call and every edit, inside the host's turn, and nobody is waiting on its
 * result: the same budget there means an unreachable API adds up to a minute and
 * a half of dead time to a single command, until the host kills the hook. Three
 * seconds, no retry — a hook that cannot reach the API quickly gives up and the
 * event goes to the offline queue.
 */
export type ClientOptions = { timeoutMs?: number; maxRetries?: number };
export const HOOK_CLIENT_OPTIONS: Readonly<ClientOptions> = Object.freeze({ timeoutMs: 3000, maxRetries: 0 });

function mapOrgUsageToSettings(data: OrgUsageApiResponse): OrganizationSettings {
  const plan = data?.plan || {};
  return {
    org_id: plan.org_id || '',
    name: data?.org_name || '',
    plan: typeof plan.tier === 'string' ? plan.tier : 'free',
    fail_mode: plan.fail_mode === 'open' ? 'open' : 'closed',
    redaction_mode: plan.redaction_mode === 'permissive' ? 'permissive' : 'strict',
    is_locked: !!plan.is_locked,
    shadow_mode: !!plan.shadow_mode,
    redaction_keys: Array.isArray(plan.redaction_keys) ? plan.redaction_keys : [],
    created_at: new Date().toISOString(),
    usage: data?.usage,
    limits: data?.limits,
  };
}

// WHAT A PROJECT-ID READ OF /inject KNOWS ABOUT THE PROJECT, AND NOTHING MORE.
//
// These reads used to answer project_name: <the id> and last_updated: null, and
// the formatter printed both: "Project: project_6f0c…" over "Last updated: null"
// on every recall that named its project. The name and the timestamp are taken
// from the payload when the API sends them (the sections branch sends
// project_name) and are null otherwise, so the caller can leave the line out —
// the rendered brief already carries the project name and its recency.
function projectHeaderFrom(payload: any, projectId: string): {
  project_id: string;
  project_name: string | null;
  last_updated: string | null;
} {
  const name = typeof payload?.project_name === 'string' && payload.project_name.trim() ? payload.project_name : null;
  const updated = payload?.updated_at ?? payload?.last_updated ?? null;
  return {
    project_id: payload?.project_id || projectId,
    project_name: name,
    last_updated: typeof updated === 'string' && updated ? updated : null,
  };
}

export class DeerdawnClient {
  private client: AxiosInstance;
  private cache: Map<string, CachedEntry<unknown>>;
  private config: Config;
  private readonly MAX_CACHE_SIZE = 100;
  private readonly MAX_CACHE_ITEM_SIZE_MB = 5;

  constructor(config: Config, options: ClientOptions = {}) {
    if (typeof options.maxRetries === 'number') config = { ...config, maxRetries: options.maxRetries };
    if (!config.apiKey || config.apiKey.trim() !== config.apiKey) {
      throw new Error('Invalid API key: cannot be empty or contain whitespace');
    }

    if (!isLocalApiUrl(config.apiUrl) && !config.apiKey.startsWith('dd_')) {
      throw new Error('Invalid API key format: must start with dd_ prefix');
    }

    this.config = config;
    this.cache = new Map();

    this.client = axios.create({
      baseURL: config.apiUrl,
      headers: {
        'x-api-key': config.apiKey,
        'content-type': 'application/json',
        // On EVERY request, not per call site: a key stays bound to the
        // workspace it was minted for, so a teammate whose install predates
        // their invite can reach the team only through this header. Omitted
        // entirely when DEERDAWN_WORKSPACE is unset, which is the solo case and
        // stays byte-identical to before. See workspace-override.ts.
        ...workspaceHeaders(),
      },
      timeout: options.timeoutMs ?? 30000,
      // Reuse TCP+TLS connections across calls. Without this, axios opens a
      // fresh socket per request and pays a full handshake (~50ms) every time —
      // multiplied across the several sequential calls a single tool can make.
      httpAgent: new http.Agent({ keepAlive: true, maxSockets: 16 }),
      httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 16 }),
    });

    this.client.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const cfg = error.config as RetryableRequestConfig | undefined;
        const response = error.response;

        // Recorded before any early return below, because this is the only point
        // EVERY response passes through. A 401 means the credential is no longer
        // accepted, whatever the caller does with the error next — and callers
        // do swallow it (start_session collapsed it into an "unreachable"
        // sentinel for hours). Never retried: repeating an expired key just
        // spends the retry budget on a guaranteed refusal.
        if (response?.status === 401) markCredentialsRejected();

        if (!cfg) {
          throw error;
        }

        if (!cfg.__retryCount) {
          cfg.__retryCount = 0;
          cfg.__firstRetryTimestamp = Date.now();
        }

        const totalRetryTime = Date.now() - (cfg.__firstRetryTimestamp || Date.now());
        if (totalRetryTime > 60000) {
          throw new Error('Retry timeout exceeded (60s)');
        }

        const shouldRetry =
          (response?.status === 429 || (response?.status && response.status >= 500)) &&
          cfg.__retryCount < this.config.maxRetries;

        if (shouldRetry) {
          cfg.__retryCount++;
          const delay = Math.min(
            this.config.retryBackoffMs * Math.pow(2, cfg.__retryCount - 1),
            30000
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          return this.client.request(cfg);
        }

        throw error;
      }
    );
  }

  /**
   * Adopt a renewed credential without rebuilding the client.
   *
   * The key is baked into the axios instance's default headers at construction,
   * so a sign-in that completes mid-session used to change nothing until the
   * process restarted — and nothing told the user to restart. Called from the
   * device-flow listener via announceCredentialRenewed.
   */
  applyApiKey(apiKey: string): void {
    if (!apiKey || apiKey.trim() !== apiKey) return;
    this.config = { ...this.config, apiKey };
    this.client.defaults.headers['x-api-key'] = apiKey;
  }

  async recordProductEvent(event: ProductEventRequest): Promise<Record<string, unknown>> {
    // Relayed to PostHog: no filesystem path and no raw message leaves here,
    // whatever the call site passed. See telemetry-safe.ts.
    const { data } = await this.client.post('/api/v1/product-events', sanitizeProductEvent(event));
    return data;
  }

  async recordContextEvent(event: StructuredContextEventRequest): Promise<Record<string, unknown>> {
    try {
      const { data } = await this.client.post('/api/v1/context/events', event);
      return data;
    } catch (error: any) {
      const status = error?.response?.status;
      const shouldQueue = !status || status >= 500 || error?.code === 'ECONNREFUSED' || error?.code === 'ENOTFOUND';
      if (!shouldQueue) throw error;

      const state = readQueueState();
      state.entries.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        method: 'POST',
        path: '/api/v1/context/events',
        body: event,
        created_at: new Date().toISOString(),
      });
      writeQueueState(state);
      return { queued: true, queue_size: state.entries.length, event_type: event.event_type };
    }
  }

  async flushQueuedContextWrites(): Promise<{ flushed: number; remaining: number }> {
    const state = readQueueState();
    if (!state.entries.length) return { flushed: 0, remaining: 0 };

    const remaining: QueuedContextWrite[] = [];
    let flushed = 0;

    for (const entry of state.entries) {
      try {
        await this.client.post(entry.path, entry.body);
        flushed += 1;
      } catch {
        remaining.push(entry);
      }
    }

    writeQueueState({ entries: remaining });
    return { flushed, remaining: remaining.length };
  }

  async getOrganizationSettings(): Promise<OrganizationSettings> {
    const { data } = await this.client.get('/api/v1/orgs/usage');
    return mapOrgUsageToSettings(data);
  }

  async getContextGraphProject(projectId: string): Promise<ContextGraphResponse> {
    const { data } = await this.client.get(`/api/v1/context/graph/projects/${encodeURIComponent(projectId)}`);
    return data.graph || data;
  }

  async getContextGraphSession(sessionId: string): Promise<ContextGraphResponse> {
    const { data } = await this.client.get(`/api/v1/context/graph/sessions/${encodeURIComponent(sessionId)}`);
    return data.graph || data;
  }

  async getContextGraphNode(nodeId: string): Promise<ContextGraphResponse> {
    const { data } = await this.client.get(`/api/v1/context/graph/nodes/${encodeURIComponent(nodeId)}`);
    return data.graph || data;
  }

  async queryContextGraph(input: { project_id?: string; session_id?: string; node_id?: string }): Promise<ContextGraphResponse> {
    const { data } = await this.client.post('/api/v1/context/graph/query', input);
    return data.graph || data;
  }

  async updateOrganizationSettings(settings: {
    redaction_mode?: 'strict' | 'permissive';
    redaction_keys?: string[];
    is_locked?: boolean;
    shadow_mode?: boolean;
    fail_mode?: 'open' | 'closed';
  }): Promise<Record<string, unknown>> {
    const { data } = await this.client.patch('/api/v1/orgs/settings', settings);
    return data;
  }

  async getAuditLogs(_params: {
    limit?: number;
    offset?: number;
    action?: string;
    start_date?: string;
    end_date?: string;
  } = {}): Promise<{ logs: AuditLog[]; total: number }> {
    const { data } = await this.client.get('/api/v1/audit');
    const logs = data.logs || [];
    return { logs, total: logs.length };
  }

  async getActionRegistry(): Promise<ActionTypeDefinition[]> {
    const cacheKey = 'registry:actions';
    const cached = this.getFromCache<ActionTypeDefinition[]>(cacheKey);
    if (cached) return cached;

    try {
      const { data } = await this.client.get('/api/v1/registry/actions');
      const actions = data.actions || data;
      if (Array.isArray(actions) && actions.length > 0) {
        this.setInCache(cacheKey, actions, 300000);
        return actions;
      }
    } catch {
      // fall through
    }
    return this.getDefaultActionRegistry();
  }

  private getDefaultActionRegistry(): ActionTypeDefinition[] {
    return [
      {
        action_type: 'auth.login',
        category: 'authentication',
        description: 'User login attempt',
        risk_level: 'medium',
      },
      {
        action_type: 'auth.password_reset',
        category: 'authentication',
        description: 'Password reset request',
        risk_level: 'medium',
      },
      {
        action_type: 'payment.process',
        category: 'financial',
        description: 'Payment processing',
        risk_level: 'high',
      },
      {
        action_type: 'user.delete',
        category: 'data_management',
        description: 'User account deletion',
        risk_level: 'high',
      },
      {
        action_type: 'data.export',
        category: 'data_management',
        description: 'Data export request',
        risk_level: 'medium',
      },
    ];
  }

  private getFromCache<T>(key: string): T | null {
    if (!this.config.cacheEnabled) return null;

    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expires) {
      this.cache.delete(key);
      return null;
    }

    return entry.data as T;
  }

  private setInCache<T>(key: string, data: T, ttlMs: number): void {
    if (!this.config.cacheEnabled) return;

    const estimatedSize = JSON.stringify(data).length;
    const estimatedSizeMB = estimatedSize / (1024 * 1024);

    if (estimatedSizeMB > this.MAX_CACHE_ITEM_SIZE_MB) {
      console.error(`[CACHE] Skipping large object (${estimatedSizeMB.toFixed(2)}MB)`);
      return;
    }

    if (this.cache.size >= this.MAX_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, {
      data,
      expires: Date.now() + ttlMs,
    });
  }

  private invalidateCache(prefix: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * A GET that says where the session is — in headers, not in the URL.
   *
   * See location-headers.ts. `legacyApi` is per client, so an older API costs one
   * repeated request per process rather than one per call; it is never persisted,
   * because the API it describes gets upgraded underneath us.
   */
  private legacyApi = false;
  private async getWithLocation(url: string, params: Record<string, unknown>, location: SessionLocation): Promise<any> {
    const headers = locationHeaders(location);
    if (!Object.keys(headers).length) {
      const { data } = await this.client.get(url, { params });
      return data;
    }
    if (!this.legacyApi) {
      const res = await this.client.get(url, { params, headers });
      if (locationAcknowledged(res.headers?.[LOCATION_ACK_HEADER])) return res.data;
      this.legacyApi = true;
    }
    const { data } = await this.client.get(url, { params: { ...params, ...legacyLocationQuery(location) } });
    return data;
  }

  // /active with no project named. A read that says where it is — `cwd` and
  // the workspace key derived from it, the same identity start_session and the
  // write paths send — resolves the project LINKED to this directory. Without
  // it the server can only fall back to this person's most recent project, and
  // says so ("directory not linked to this project — match is a guess") even in
  // a repo that is linked. No session id and no dedup marker: this is a read.
  //
  // A directory linked to nothing resolves to nothing when it is named, where
  // the unnamed read still offers the most recent project, flagged as a guess.
  // A read is allowed a guess, so that answer is kept: the located read is asked
  // first, and only when it names no project is the old read made.
  private async getActiveAt(params: Record<string, unknown>, location?: SessionLocation): Promise<any> {
    const unlocated = async () => (await this.client.get('/api/v1/context/active', { params })).data;
    if (!location?.cwd) return unlocated();
    const located = await this.getWithLocation('/api/v1/context/active', params, {
      cwd: location.cwd,
      workspaceKey: location.workspaceKey || workspaceKeyForCwd(location.cwd),
    });
    return located?.project_id ? located : unlocated();
  }

  // Context sync methods
  async getActiveContext(projectId?: string, tool = 'claude_code', verbosity = 'standard', location?: SessionLocation): Promise<any> {
    if (projectId) {
      const { data } = await this.client.get(
        `/api/v1/context/projects/${encodeURIComponent(projectId)}/inject`,
        { params: { tool, verbosity } }
      );
      return {
        brief: data.payload?.body ?? null,
        ...projectHeaderFrom(data.payload, projectId),
      };
    }
    return this.getActiveAt({ tool, verbosity }, location);
  }

  // Brief shape (?shape=spine) — the product-voice 4-slot view (SHIPPED / DECIDED
  // / OPEN / LANDMINE). Returns the 4-slot TEXT body plus the structured
  // brief_spine (per-item trust). Opt-in: never changes the default brief text.
  async getActiveBrief(projectId?: string, tool = 'claude_code', verbosity = 'standard', location?: SessionLocation): Promise<any> {
    if (projectId) {
      const { data } = await this.client.get(
        `/api/v1/context/projects/${encodeURIComponent(projectId)}/inject`,
        { params: { tool, verbosity, shape: 'spine' } }
      );
      return {
        brief: data.payload?.body ?? null,
        brief_spine: data.payload?.brief_spine ?? null,
        ...projectHeaderFrom(data.payload, projectId),
      };
    }
    return this.getActiveAt({ tool, verbosity, shape: 'spine' }, location);
  }

  async getActiveContextByCwd(
    cwd: string,
    tool = 'claude_code',
    verbosity = 'standard',
    markSession = false,
    workspaceKey: string | null = null,
    options: { purpose?: 'write' } = {},
  ): Promise<any> {
    // mark_session=1 records a cross-connection dedup marker so a second DeerDawn
    // connection loading the same project gets a compact "already loaded" pointer.
    // Only start_session sets this; passive callers (e.g. cleanup_context) leave it off.
    const params: Record<string, unknown> = { tool, verbosity };
    if (markSession) params.mark_session = 1;
    // `tool` is the rendering profile, which defaults a client this server cannot
    // place to claude_code. Said so, so the session row names no tool rather than
    // a guessed one. An API that predates the parameter ignores it.
    if (tool !== resolveIdentifiedSurface()) params.tool_identified = 0;
    // A caller about to WRITE says so. The API then never answers with a project
    // that matched on its name alone (see write-target.ts). An API that predates
    // the parameter ignores it and answers as it always did, which is why the
    // caller still has to judge the answer and cannot simply trust it.
    if (options.purpose === 'write') params.purpose = 'write';
    // Repo identity so selection prefers the work-stream in THIS workspace — and
    // so an explicit subproject pin is honoured. DERIVED from the cwd when the
    // caller did not pass one: every write path that resolves a project came
    // through here without it, which is what made the pin read-only in practice.
    const resolvedWorkspaceKey = workspaceKey || workspaceKeyForCwd(cwd);
    // Agent identity — this is what makes THIS session visible to its peers and
    // what lets the server exclude it from its own presence block. Sent on every
    // call, not just marked ones, so a long session keeps its liveness fresh
    // without a heartbeat of its own.
    params.session_id = getAgentSessionId();
    // cwd and the workspace key go in headers: see location-headers.ts. No
    // host: the machine name is not sent (agent-session.ts).
    return this.getWithLocation('/api/v1/context/active', params, {
      cwd,
      workspaceKey: resolvedWorkspaceKey,
    });
  }

  // `options.explicit` is for update_context ONLY: the caller asked for THIS
  // sentence to be kept. The local import also comes through here, with a whole
  // CLAUDE.md body as `summary` — material for extraction to mine, not a
  // sentence to file verbatim as a decision — so it must not set the flag.
  async pushContextUpdate(
    projectId: string,
    summary: string,
    tool = 'claude_code',
    commands?: Array<{ label: string; run: string; note?: string }>,
    options: { explicit?: boolean } = {},
  ): Promise<any> {
    // Stable for the life of this process. It used to be `mcp-${Date.now()}` — a
    // new id per write — which made every update look like a different agent and
    // left context_sessions with one orphan row per call. Presence, board holds
    // and staleness are all reads on this id, so it must be the same one the
    // brief was delivered to.
    const sessionId = getAgentSessionId();
    // `explicit` tells the API the caller ASKED for this text to be saved. The
    // server then stores the summary verbatim as one decision (the model's
    // wording becomes its headline), never lets extraction replace the current
    // task, and answers `stored` from a read-back. An API that predates the flag
    // ignores it and answers without `stored`; see update_context for the
    // fallback that covers that case.
    const extractionResult = await this.client.post('/api/v1/context/extraction', {
      session_id: sessionId,
      tool,
      project_id: projectId,
      ...(options.explicit ? { explicit: true } : {}),
      // A defaulted tool is not this client's identity: the save is then not
      // credited to a tool by name. Absent when it is (and on older APIs, ignored).
      ...(tool !== resolveIdentifiedSurface() ? { tool_identified: false } : {}),
      // Tells a peer WHERE this agent is working, not just that it exists.
      session_context: getAgentSessionContext(),
      // Masked before it leaves the machine, like every other text this
      // package sends for extraction (the Stop hook, command capture). The
      // update tool masks first so it can say so; import_local's seeding
      // reaches here with a whole CLAUDE.md and did not.
      chunks: [{ role: 'assistant', text: redactSecrets(summary) }],
    }).then(r => r.data);
    // Commands AFTER extraction, merged by label onto what is stored. This used
    // to PATCH `{ commands }` in parallel with the extraction: the PATCH is a
    // replace, so sending one command deleted the rest of the log, and the two
    // saves raced so either could discard the other. The hosted dispatcher has
    // merged by label, in order, since #486; this is the same rule.
    if (commands?.length) {
      const stored: Array<{ label: string; run: string; note?: string }> =
        Array.isArray(extractionResult?.project?.context?.commands) ? extractionResult.project.context.commands : [];
      const byLabel = new Map(stored.map((entry) => [String(entry?.label ?? '').trim(), entry] as const).filter(([label]) => Boolean(label)));
      for (const entry of commands) {
        const label = String(entry?.label ?? '').trim();
        if (label) byLabel.set(label, entry);
      }
      //
      // The OUTCOME is returned, not swallowed. A refused PATCH (one `run` over
      // the API's cap is 400 field_too_long, and the PATCH is all-or-nothing)
      // used to be written to stderr only, while the reply counted the REQUEST:
      // "+ 2 commands stored" over a log that stored none.
      let commandsOutcome: { requested: number; stored: boolean; error?: string };
      try {
        await this.client.patch(`/api/v1/context/${encodeURIComponent(projectId)}/context`, { commands: [...byLabel.values()] });
        commandsOutcome = { requested: commands.length, stored: true };
      } catch (err: any) {
        const apiMessage = typeof err?.response?.data?.message === 'string' ? err.response.data.message : '';
        process.stderr.write(`[DeerDawn] commands not saved: ${err?.message ?? 'unknown'}\n`);
        commandsOutcome = { requested: commands.length, stored: false, error: apiMessage || err?.message || 'the write failed' };
      }
      return extractionResult && typeof extractionResult === 'object'
        ? { ...extractionResult, commands_outcome: commandsOutcome }
        : { commands_outcome: commandsOutcome };
    }
    return extractionResult;
  }

  async listContextProjects(): Promise<any> {
    const { data } = await this.client.get('/api/v1/context/projects');
    return data;
  }

  // Archived projects only. Two consumers with opposite needs: start_session's
  // "your memory is intact" notice is a display list and wants the server's
  // default page, while the name->id resolver needs every row it could resolve
  // against — a name it cannot see is one whose ambiguity it cannot detect.
  // Callers that need the exhaustive view pass an explicit limit.
  async listArchivedContextProjects(limit?: number): Promise<any> {
    const params: Record<string, unknown> = { archived: 1 };
    if (limit) params.limit = limit;
    const { data } = await this.client.get('/api/v1/context/projects', { params });
    return data;
  }

  async listContextProjectTree(): Promise<any> {
    const { data } = await this.client.get('/api/v1/context/projects/tree');
    return data;
  }

  // WHICH CODEBASE THE PROJECT BELONGS TO, FROM BIRTH.
  //
  // A project's workspace_key used to be stamped only by the first write that
  // happened to carry one. So "create a subproject, switch to it" — the
  // documented flow — pinned a project with no key: the pin lookup requires the
  // pinned project to be in the caller's workspace, the switch reported success,
  // and the next session opened on something else. With the key, a new project
  // also resolves by `workspace` from its first minute, which is a write-grade
  // match (write-target.ts) where the directory's name is only a guess.
  //
  // Derived here, never an argument of the tool: it is a fact about the repo the
  // server is running in, not something a caller gets to assert. `null` opts out
  // (nothing is invented outside a git repo). An API that predates the field
  // drops it: the create schema strips unknown keys rather than refusing them.
  async createContextProject(
    projectName: string,
    description?: string,
    parentProjectId?: string,
    options: { workspaceKey?: string | null; cwd?: string; mcpSession?: { tool: string | null } } = {},
  ): Promise<any> {
    const workspaceKey = options.workspaceKey !== undefined
      ? options.workspaceKey
      : workspaceKeyForCwd(options.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
    const { data } = await this.client.post('/api/v1/context/projects', {
      project_name: projectName,
      description,
      ...(parentProjectId ? { parent_project_id: parentProjectId } : {}),
      ...(workspaceKey ? { workspace_key: workspaceKey } : {}),
      // Only the create_project TOOL sets this: the create happened inside this
      // agent session, so the server books it as the session's first load and
      // the next session's catch-up can name what was saved after it. Imports
      // and the dashboard never send it. An API that predates the flag strips it.
      // The tool only when positively identified; the server stores none otherwise.
      ...(options.mcpSession
        ? {
          from_mcp_session: true,
          ...(options.mcpSession.tool ? { session_tool: options.mcpSession.tool } : {}),
          session_id: getAgentSessionId(),
        }
        : {}),
    });
    return data;
  }

  async switchSubproject(projectId: string, workspaceKey: string): Promise<any> {
    const { data } = await this.client.post('/api/v1/context/subproject/switch', {
      project_id: projectId,
      workspace_key: workspaceKey,
    });
    return data;
  }

  async archiveProject(projectId: string, unarchive = false): Promise<any> {
    const { data } = await this.client.post(
      `/api/v1/context/projects/${encodeURIComponent(projectId)}/archive`,
      { unarchive },
    );
    return data;
  }

  async setProjectParent(projectId: string, parentProjectId: string | null): Promise<any> {
    const { data } = await this.client.post(
      `/api/v1/context/projects/${encodeURIComponent(projectId)}/parent`,
      { parent_project_id: parentProjectId ?? null },
    );
    return data;
  }

  async renameProject(projectId: string, projectName: string): Promise<any> {
    const { data } = await this.client.post(
      `/api/v1/context/projects/${encodeURIComponent(projectId)}/rename`,
      { project_name: projectName },
    );
    return data;
  }

  async getContextSections(projectId: string | undefined, sections: string[], tool = 'claude_code', verbosity = 'standard', location?: SessionLocation): Promise<any> {
    const sectionsParam = sections.join(',');
    if (projectId) {
      const { data } = await this.client.get(
        `/api/v1/context/projects/${encodeURIComponent(projectId)}/inject`,
        { params: { tool, verbosity, sections: sectionsParam } }
      );
      return {
        brief: data.payload?.body ?? null,
        ...projectHeaderFrom(data.payload, projectId),
      };
    }
    return this.getActiveAt({ tool, verbosity, sections: sectionsParam }, location);
  }

  async getContextMap(mcpAvailable = true, cwd?: string, workspaceKey?: string | null): Promise<any> {
    const params: Record<string, string> = { mcp: mcpAvailable ? 'true' : 'false' };
    return this.getWithLocation('/api/v1/context/map', params, { cwd, workspaceKey });
  }

  /**
   * The project's raw structured context — ALWAYS the flat context object
   * (`{project_id, project_name, updated_at, ...context}`), whichever endpoint
   * served it.
   *
   * These two branches used to return different shapes: the projectId path
   * unwrapped `data.context`, while the no-projectId path returned the whole
   * `/active` envelope, which has no `context` key at all. Callers therefore had
   * to guess, and `manage_todos` guessed wrong in the one direction that fails
   * silently — reading `ctx.context.todo_items` off a shape where `.context` is
   * undefined yields no error, just a permanently empty board.
   *
   * One shape, decided here, so no caller has to branch on it again.
   */
  // Without a projectId this reads /active, which resolves the project from
  // `cwd` when one is sent and falls back to THIS PERSON's session binding and
  // then their own most recent project when not. Callers acting on "the project
  // I am in" must still pass cwd: the fallback is no longer a workspace-wide
  // guess, but it is still not this directory.
  async getContextJson(projectId?: string, opts: { cwd?: string; workspaceKey?: string | null } = {}): Promise<any> {
    const path = projectId
      ? `/api/v1/context/projects/${encodeURIComponent(projectId)}/inject`
      : '/api/v1/context/active';
    const params: Record<string, unknown> = { format: 'json' };
    const location: SessionLocation = {};
    if (!projectId && opts.cwd) {
      location.cwd = opts.cwd;
      // Same derivation as getActiveContextByCwd: a pinned subproject must not
      // depend on the caller having remembered to look its workspace key up.
      location.workspaceKey = opts.workspaceKey || workspaceKeyForCwd(opts.cwd);
    }
    const data = await this.getWithLocation(path, params, location);
    // Both routes answer format=json with a {context} envelope, and `context` is
    // null when no project resolved — so an explicit key check, not `??`, which
    // would fall through to the envelope itself on the null case.
    if (data && typeof data === 'object' && 'context' in data) return data.context ?? {};
    // An API build predating format=json on /active returns its normal payload.
    // Hand it back rather than inventing a shape; callers see no todo_items and
    // correctly report an empty board instead of crashing.
    return data;
  }

  async searchContext(query: string, limit = 5): Promise<any> {
    const { data } = await this.client.post('/api/v1/context/search', { query, limit });
    return data;
  }

  async getWorkspaceOverview(params: {
    mode?: 'startup' | 'overview';
    verbosity?: 'light' | 'standard' | 'detailed';
    include?: Array<'projects' | 'knowledge' | 'tools' | 'capabilities' | 'recent'>;
    format?: 'text' | 'json';
  } = {}): Promise<any> {
    const query: Record<string, string> = {};
    if (params.mode) query.mode = params.mode;
    if (params.verbosity) query.verbosity = params.verbosity;
    if (params.include?.length) query.include = params.include.join(',');
    if (params.format) query.format = params.format;
    const { data } = await this.client.get('/api/v1/context/workspace/overview', { params: query });
    return data.overview || data;
  }

  async getWorkspaceEntities(params: {
    types?: string[];
    query?: string;
    project_id?: string;
    related_project_id?: string;
    scope?: 'workspace' | 'project';
    surface?: string;
    status?: string;
    include_inferred?: boolean;
    include_resolved?: boolean;
    curated_only?: boolean;
    limit?: number;
    format?: 'text' | 'json';
  } = {}): Promise<any> {
    const query: Record<string, string | number> = {};
    if (params.types?.length) query.types = params.types.join(',');
    if (params.query) query.query = params.query;
    if (params.project_id) query.project_id = params.project_id;
    if (params.related_project_id) query.related_project_id = params.related_project_id;
    if (params.scope) query.scope = params.scope;
    if (params.surface) query.surface = params.surface;
    if (params.status) query.status = params.status;
    if (typeof params.include_inferred === 'boolean') query.include_inferred = params.include_inferred ? 1 : 0;
    if (typeof params.include_resolved === 'boolean') query.include_resolved = params.include_resolved ? 1 : 0;
    if (typeof params.curated_only === 'boolean') query.curated_only = params.curated_only ? 1 : 0;
    if (typeof params.limit === 'number') query.limit = params.limit;
    if (params.format) query.format = params.format;
    const { data } = await this.client.get('/api/v1/context/workspace/entities', { params: query });
    return data;
  }

  // Cross-project read. One endpoint serves every tier: `counts` always carries
  // the owner's real numbers and `locked` says whether the contents came back
  // with them, so the caller never needs a second entitlement lookup.
  async getPortfolio(params: {
    query?: string;
    entity_limit?: number;
    decision_limit?: number;
  } = {}): Promise<any> {
    const query: Record<string, string | number> = {};
    if (params.query) query.q = params.query;
    if (typeof params.entity_limit === 'number') query.entity_limit = params.entity_limit;
    if (typeof params.decision_limit === 'number') query.decision_limit = params.decision_limit;
    const { data } = await this.client.get('/api/v1/context/portfolio', { params: query });
    return data;
  }

  async getProjectMap(params: {
    project_id?: string;
    verbosity?: 'light' | 'standard' | 'detailed';
    format?: 'text' | 'json';
  } = {}): Promise<any> {
    const projectId = params.project_id;
    if (!projectId) {
      const { data } = await this.client.get('/api/v1/context/active');
      if (!data?.project_id) return null;
      params.project_id = data.project_id;
    }
    const query: Record<string, string> = {};
    if (params.verbosity) query.verbosity = params.verbosity;
    if (params.format) query.format = params.format;
    const resolvedProjectId = String(params.project_id);
    const { data } = await this.client.get(`/api/v1/context/projects/${encodeURIComponent(resolvedProjectId)}/map`, { params: query });
    return data.project_map || data;
  }

  async findKnownPaths(params: {
    query: string;
    project_id?: string;
    limit?: number;
    format?: 'text' | 'json';
  }): Promise<any> {
    const query: Record<string, string | number> = { query: params.query };
    if (params.project_id) query.project_id = params.project_id;
    if (typeof params.limit === 'number') query.limit = params.limit;
    if (params.format) query.format = params.format;
    const { data } = await this.client.get('/api/v1/context/workspace/known-paths', { params: query });
    return data;
  }

  async getNextBestContext(params: {
    tool?: string;
    cwd?: string;
    project_id?: string;
    limit?: number;
  } = {}): Promise<any> {
    const query: Record<string, string | number> = {};
    if (params.tool) query.tool = params.tool;
    if (params.project_id) query.project_id = params.project_id;
    if (typeof params.limit === 'number') query.limit = params.limit;
    // Identify the asker so the server withholds cards ANOTHER agent is holding
    // and ranks up the ones this agent already holds. Sent unconditionally: the
    // server treats an absent id as "holds nothing", which withholds more work
    // rather than less, and being handed a card someone is mid-edit on is the
    // expensive failure.
    query.session_id = getAgentSessionId();
    const data = await this.getWithLocation('/api/v1/context/workspace/next', query, { cwd: params.cwd });
    return data.result || data;
  }

  async upsertWorkspaceEntities(input: {
    entities: Array<{
      entity_type: string;
      title: string;
      summary?: string;
      scope?: 'workspace' | 'project';
      project_id?: string;
      filed_by_default?: boolean;
      canonical_key?: string;
      metadata?: Record<string, unknown>;
    }>;
    relations?: Array<{
      from_canonical_key: string;
      to_canonical_key: string;
      relation_type: string;
      summary?: string;
    }>;
  }): Promise<any> {
    const { data } = await this.client.post('/api/v1/context/workspace/entities', input);
    return data;
  }

  async buildSubagentBrief(params: {
    project_id?: string;
    task: string;
    role?: string;
    deliverable?: string;
    acceptance_criteria?: string[];
    focus_paths?: string[];
    verification?: string[];
    max_tokens?: number;
    cwd?: string;
    workspace_key?: string;
    tool?: string;
  }): Promise<any> {
    const { data } = await this.client.post('/api/v1/context/subagent-brief', params);
    return data.brief || data;
  }

  async recordHotPaths(projectId: string, items: Array<{
    label: string;
    path: string;
    purpose?: string;
    importance?: 'low' | 'normal' | 'high' | 'critical';
    pinned?: boolean;
  }>): Promise<any> {
    const { data } = await this.client.post(`/api/v1/context/projects/${encodeURIComponent(projectId)}/hot-paths`, { items });
    return data;
  }

  // ─── Trails ────────────────────────────────────────────────────────────────
  // exportTrail returns a PRIVATE, unscanned archive. Publishing is a separate
  // gated flow (preview -> per-finding decisions -> publish); there is no
  // one-call publish here on purpose.
  async exportTrail(
    projectId: string,
    source?: { repo_url?: string; commit_sha?: string; branch?: string },
    options?: { kind?: 'project' | 'pack' }
  ): Promise<any> {
    // Built with encodeURIComponent rather than URLSearchParams to match the
    // rest of this client — the package lints against a Node-globals config that
    // does not declare the WHATWG URL globals.
    const query = ([
      ['repo_url', source?.repo_url],
      ['commit_sha', source?.commit_sha],
      ['branch', source?.branch],
      ['kind', options?.kind],
      ['tool', 'claude_code'],
    ] as Array<[string, string | undefined]>)
      .filter(([, value]) => Boolean(value))
      .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
      .join('&');
    const { data } = await this.client.get(
      `/api/v1/context/projects/${encodeURIComponent(projectId)}/trail${query ? `?${query}` : ''}`
    );
    return data;
  }

  async previewTrailPublish(projectId: string): Promise<any> {
    const { data } = await this.client.get(`/api/v1/context/projects/${encodeURIComponent(projectId)}/trail/preview`);
    return data;
  }

  async importTrail(input: {
    trail: string | Record<string, unknown>;
    project_id?: string;
    new_project_name?: string;
    dry_run?: boolean;
  }): Promise<any> {
    const { data } = await this.client.post('/api/v1/context/trail/import', input);
    return data;
  }

  async recordDebugFinding(projectId: string, input: {
    summary: string;
    paths?: string[];
    added_at?: string;
    commit_ref?: string;
    diff_ref?: string;
    importance?: 'low' | 'normal' | 'high' | 'critical';
    pinned?: boolean;
    source_tool?: string;
    supersedes?: string;
  }): Promise<any> {
    const { data } = await this.client.post(`/api/v1/context/projects/${encodeURIComponent(projectId)}/debug-findings`, input);
    return data;
  }

  async confirmClaim(projectId: string, input: { claim: string; verified_commit?: string }): Promise<any> {
    const { data } = await this.client.post(`/api/v1/context/projects/${encodeURIComponent(projectId)}/verify`, input);
    return data;
  }

  async updateGlobalContext(patch: Record<string, any>): Promise<any> {
    const { data } = await this.client.patch('/api/v1/context/global', patch);
    return data;
  }

  // Retire ONE open question. The narrow counterpart to the wholesale clear that
  // cleanup_context performs — see the resolve_open_question handler in
  // tools/context-sync.ts.
  //
  // The interesting responses are the REFUSALS: 409 question_ambiguous carries
  // `candidates`, and 404 question_not_found means nothing matched. Both come
  // back as AxiosErrors, so the handler reads them off error.response rather than
  // letting handleApiError flatten them into a status message.
  async resolveQuestion(projectId: string, question: string, answer: string): Promise<any> {
    const { data } = await this.client.post(
      `/api/v1/context/projects/${encodeURIComponent(projectId)}/questions/resolve`,
      { question, answer },
    );
    return data;
  }

  // Resolve ONE decision in ONE project's brief, by its text. The server answers
  // 200 with { outcome, message } for every outcome, "nothing was resolved"
  // included; see POST /projects/:id/decisions/resolve.
  // `untyped`: mark_resolved named no entity_type, so the server weighs an open
  // task (or other entity) with the same text before any decision (scan 28).
  async resolveProjectDecision(projectId: string, input: { title: string; notes?: string; untyped?: boolean }): Promise<any> {
    const { data } = await this.client.post(
      `/api/v1/context/projects/${encodeURIComponent(projectId)}/decisions/resolve`,
      input,
    );
    return data;
  }

  async patchProjectContext(projectId: string, delta: Record<string, any>): Promise<any> {
    const { data } = await this.client.patch(`/api/v1/context/${encodeURIComponent(projectId)}/context`, delta);
    return data;
  }

  // ── Add-ons ────────────────────────────────────────────────────────────────
  // read_addon / use_addon forward here: the API runs every add-on action
  // (apps/api/src/addons/runner.js), so no add-on logic lives in this package.
  // A refusal is RETURNED, not thrown, so the tool can show the server's own
  // sentence ("switch it on at /addons") instead of an HTTP status.
  async runAddonAction(addon: string, action: string, args: Record<string, unknown>, via: 'read' | 'write'): Promise<
    | { ok: true; result: { text: string; data: Record<string, unknown> | null; images: { mime: string; base64: string }[] } }
    | { ok: false; status: number; error: string; message: string }
  > {
    const res = await this.client.post(
      `/api/v1/addons/${encodeURIComponent(addon)}/actions/${encodeURIComponent(action)}`,
      { args, via },
      { headers: { 'x-deerdawn-transport': 'mcp-local' }, validateStatus: (status) => status < 500 && status !== 401 },
    );
    if (res.status >= 200 && res.status < 300) {
      const body = res.data || {};
      return {
        ok: true,
        result: {
          text: typeof body.text === 'string' ? body.text : '',
          data: body.data && typeof body.data === 'object' ? body.data : null,
          images: Array.isArray(body.images) ? body.images : [],
        },
      };
    }
    const body = res.data || {};
    return {
      ok: false,
      status: res.status,
      error: String(body.error || `http_${res.status}`),
      message: String(body.message || body.error || `The add-on request failed (${res.status}).`),
    };
  }

  /** The brief's add-on lines; [] on any failure — a brief never waits on add-ons. */
  async addonBriefLines(): Promise<string[]> {
    try {
      const { data } = await this.client.get('/api/v1/addons/brief-lines', { timeout: 2000 });
      return Array.isArray(data?.lines) ? data.lines.filter((line: unknown) => typeof line === 'string').slice(0, 3) : [];
    } catch {
      return [];
    }
  }

  // ── Shared skills ──────────────────────────────────────────────────────────
  async listSkills(projectId?: string): Promise<SkillMeta[]> {
    const params: Record<string, string> = {};
    if (projectId) params.project_id = projectId;
    const { data } = await this.client.get('/api/v1/context/skills', { params });
    return data?.skills ?? [];
  }

  async getSkill(idOrSlug: string): Promise<Skill | null> {
    const { data } = await this.client.get(`/api/v1/context/skills/${encodeURIComponent(idOrSlug)}`);
    return data?.skill ?? null;
  }

  async upsertSkill(input: SkillUpsertInput): Promise<Skill> {
    const { data } = await this.client.post('/api/v1/context/skills', input);
    return data?.skill ?? data;
  }

  // Import a shared skill by pasting a GitHub repo URL. The API fetches the
  // repo's SKILL.md, parses its frontmatter, and creates the shared skill.
  async importSkillFromGithub(repoUrl: string, projectId?: string | null): Promise<{ skill: Skill; source_url?: string }> {
    const body: Record<string, unknown> = { repo_url: repoUrl };
    if (projectId) body.project_id = projectId;
    const { data } = await this.client.post('/api/v1/context/skills/import-github', body);
    return data;
  }
}
