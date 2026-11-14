import fs from 'fs';
import os from 'os';
import path from 'path';
import { AxiosError, AxiosHeaders } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contextSyncTools, handleContextSyncTool } from '../src/tools/context-sync.js';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-start-session-'));
}

describe('start_session tool', () => {
  const originalProjectDir = process.env.CLAUDE_PROJECT_DIR;

  afterEach(() => {
    process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
    vi.restoreAllMocks();
  });

  it('returns onboarding guidance when no context is available', async () => {
    const cwd = makeTempDir();
    process.env.CLAUDE_PROJECT_DIR = cwd;

    const client = {
      flushQueuedContextWrites: vi.fn().mockResolvedValue(null),
      getActiveContextByCwd: vi.fn().mockResolvedValue(null),
      getContextMap: vi.fn().mockResolvedValue(null),
      recordContextEvent: vi.fn().mockResolvedValue(null),
    };

    const result = await handleContextSyncTool('start_session', {}, client as any);
    const text = result.content?.[0]?.text || '';
    expect(text).toContain('No DeerDawn context yet');
    expect(text).toContain('manage_memory(action:"import_local")');
  });

  // /map stamps a "Now:" line on EVERY answer, an empty account's included:
  // "[DeerDawn] No brief ready yet.\nNow: ...". The map's bare truthiness then
  // read as context, so a brand-new account got "Other projects:\nNow: <date>"
  // and never saw the first-session guide. The stub is that exact response.
  it('a fresh account whose /map carries only a Now: line gets the first-session guide', async () => {
    const cwd = makeTempDir();
    process.env.CLAUDE_PROJECT_DIR = cwd;

    const client = {
      flushQueuedContextWrites: vi.fn().mockResolvedValue(null),
      getActiveContextByCwd: vi.fn().mockResolvedValue(null),
      getContextMap: vi.fn().mockResolvedValue({
        map: '[DeerDawn] No brief ready yet.\nNow: Tue, Sep 22, 2026, 5:40 PM UTC',
        project_count: 0,
        active_project_id: null,
      }),
      recordContextEvent: vi.fn().mockResolvedValue(null),
      listArchivedContextProjects: vi.fn().mockResolvedValue({ projects: [] }),
    };

    const result = await handleContextSyncTool('start_session', {}, client as any);
    const text = result.content?.[0]?.text || '';
    expect(text).toContain('No DeerDawn context yet: this account has no projects');
    expect(text).toContain('Start the first brief in this conversation');
    expect(text).not.toContain('Other projects:');
  });

  it('a Now: line does not become an "Other projects" block of its own', async () => {
    const cwd = makeTempDir();
    process.env.CLAUDE_PROJECT_DIR = cwd;

    const client = {
      flushQueuedContextWrites: vi.fn().mockResolvedValue(null),
      getActiveContextByCwd: vi.fn().mockResolvedValue({
        project_id: 'project_only',
        project_name: 'Only',
        brief: 'Current task: the one project.',
        match_kind: 'path',
        last_updated: new Date().toISOString(),
      }),
      getContextMap: vi.fn().mockResolvedValue({
        map: '[DeerDawn — 1 project]\nNow: Tue, Sep 22, 2026, 5:40 PM UTC\n→ Only (project_only)\n→ Call get_context(project_id?, sections?) for details',
        project_count: 1,
      }),
      recordContextEvent: vi.fn().mockResolvedValue(null),
    };

    const result = await handleContextSyncTool('start_session', {}, client as any);
    const text = result.content?.[0]?.text || '';
    expect(text).toContain('Current task: the one project.');
    expect(text).not.toContain('Other projects:');
  });

  // The converse: an account whose only project is the (empty) active one
  // lists it as `→ Name (id)` — content, not a call hint — and must not be
  // told it has no projects.
  it('an account whose only project is the active one is not treated as empty', async () => {
    const cwd = makeTempDir();
    process.env.CLAUDE_PROJECT_DIR = cwd;

    const client = {
      flushQueuedContextWrites: vi.fn().mockResolvedValue(null),
      getActiveContextByCwd: vi.fn().mockResolvedValue({ project_id: 'project_only', project_name: 'Only', match_kind: 'recency_fallback' }),
      getContextMap: vi.fn().mockResolvedValue({
        map: '[DeerDawn — 1 project]\nNow: Tue, Sep 22, 2026, 5:40 PM UTC\n→ Only (project_only)\n→ Call get_context(project_id?, sections?) for details',
        project_count: 1,
      }),
      recordContextEvent: vi.fn().mockResolvedValue(null),
      listArchivedContextProjects: vi.fn().mockResolvedValue({ projects: [] }),
    };

    const result = await handleContextSyncTool('start_session', {}, client as any);
    const text = result.content?.[0]?.text || '';
    expect(text).not.toContain('this account has no projects');
    expect(text).toContain('"Only" has no saved brief yet');
  });

  it('offers to restore an archived project instead of claiming there is no context', async () => {
    const cwd = makeTempDir();
    process.env.CLAUDE_PROJECT_DIR = cwd;

    const client = {
      flushQueuedContextWrites: vi.fn().mockResolvedValue(null),
      getActiveContextByCwd: vi.fn().mockResolvedValue(null),
      getContextMap: vi.fn().mockResolvedValue(null),
      recordContextEvent: vi.fn().mockResolvedValue(null),
      listArchivedContextProjects: vi.fn().mockResolvedValue({
        projects: [{ project_id: 'project_aged', project_name: 'Aged Out' }],
      }),
    };

    const result = await handleContextSyncTool('start_session', {}, client as any);
    const text = result.content?.[0]?.text || '';
    // The whole point: an aged-out user must not be told their memory is gone.
    expect(text).not.toContain('No DeerDawn context yet');
    expect(text).toContain('Aged Out');
    expect(text).toContain('archived, not gone');
    expect(text).toContain('project_aged');
  });

  it('renders active project summary and related projects when available', async () => {
    const cwd = makeTempDir();
    process.env.CLAUDE_PROJECT_DIR = cwd;

    const client = {
      flushQueuedContextWrites: vi.fn().mockResolvedValue(null),
      getActiveContextByCwd: vi.fn().mockResolvedValue({
        project_id: 'project_active',
        project_name: 'DeerDawn',
        brief: 'Current task: stabilize start_session.',
        last_updated: new Date().toISOString(),
      }),
      getContextMap: vi.fn().mockResolvedValue({
        map: [
          '[DeerDawn]',
          '- DeerDawn (project_active)',
          '- Billing (project_billing)',
        ].join('\n'),
      }),
      recordContextEvent: vi.fn().mockResolvedValue(null),
    };

    const result = await handleContextSyncTool('start_session', {}, client as any);
    const text = result.content?.[0]?.text || '';
    expect(text).toContain('Resuming DeerDawn');
    expect(text).toContain('Other projects:');
    expect(text).toContain('Billing (project_billing)');
    expect(text).not.toContain('project_active)');
  });

  it('emits a compact pointer instead of repeating a brief already on disk', async () => {
    const cwd = makeTempDir();
    process.env.CLAUDE_PROJECT_DIR = cwd;
    const brief = 'Current task: stabilize start_session.\nHot paths: src/foo -> src/bar';
    fs.writeFileSync(path.join(cwd, '.deerdawn-context.md'), `${brief}\n`, 'utf8');

    const client = {
      flushQueuedContextWrites: vi.fn().mockResolvedValue(null),
      getActiveContextByCwd: vi.fn().mockResolvedValue({
        project_id: 'project_active',
        project_name: 'DeerDawn',
        brief,
        last_updated: new Date().toISOString(),
      }),
      getContextMap: vi.fn().mockResolvedValue({ map: '[DeerDawn]\n- DeerDawn (project_active)' }),
      recordContextEvent: vi.fn().mockResolvedValue(null),
    };

    const result = await handleContextSyncTool('start_session', {}, client as any);
    const text = result.content?.[0]?.text || '';
    expect(text).toContain('Resuming DeerDawn');
    expect(text).toContain('already loaded from .deerdawn-context.md');
    // The full brief body must NOT be repeated
    expect(text).not.toContain('Hot paths: src/foo -> src/bar');
  });

  it('delivers the full brief when the on-disk copy is stale (differs)', async () => {
    const cwd = makeTempDir();
    process.env.CLAUDE_PROJECT_DIR = cwd;
    fs.writeFileSync(path.join(cwd, '.deerdawn-context.md'), 'Current task: an OLD task.\n', 'utf8');

    const client = {
      flushQueuedContextWrites: vi.fn().mockResolvedValue(null),
      getActiveContextByCwd: vi.fn().mockResolvedValue({
        project_id: 'project_active',
        project_name: 'DeerDawn',
        brief: 'Current task: a FRESH task.',
        last_updated: new Date().toISOString(),
      }),
      getContextMap: vi.fn().mockResolvedValue({ map: '[DeerDawn]\n- DeerDawn (project_active)' }),
      recordContextEvent: vi.fn().mockResolvedValue(null),
    };

    const result = await handleContextSyncTool('start_session', {}, client as any);
    const text = result.content?.[0]?.text || '';
    expect(text).toContain('Current task: a FRESH task.');
    expect(text).not.toContain('already loaded from .deerdawn-context.md');
  });

  it('update_context resolves active project when project_id is omitted', async () => {
    const cwd = makeTempDir();
    process.env.CLAUDE_PROJECT_DIR = cwd;

    const client = {
      getActiveContextByCwd: vi.fn().mockResolvedValue({
        project_id: 'project_active',
        // As the real /active sends it. Without a match_kind the answer did not
        // come from this directory at all, and a write no longer follows it.
        match_kind: 'path',
      }),
      pushContextUpdate: vi.fn().mockResolvedValue({
        project: { project_name: 'DeerDawn' },
      }),
      recordContextEvent: vi.fn().mockResolvedValue(null),
    };

    await handleContextSyncTool('update_context', {
      summary: 'Shipped the onboarding copy update.',
    }, client as any);

    expect(client.getActiveContextByCwd).toHaveBeenCalledTimes(1);
    expect(client.pushContextUpdate).toHaveBeenCalledWith(
      'project_active',
      'Shipped the onboarding copy update.',
      'claude_code',
      undefined,
      // update_context, and only update_context, marks the write explicit.
      { explicit: true },
    );
  });

  it('update_context accepts a single command object and normalizes it to an array', async () => {
    const client = {
      pushContextUpdate: vi.fn().mockResolvedValue({
        project: { project_name: 'DeerDawn' },
      }),
      recordContextEvent: vi.fn().mockResolvedValue(null),
    };

    await handleContextSyncTool('update_context', {
      project_id: 'project_active',
      summary: 'Store deploy command for handoff.',
      commands: { label: 'deploy', run: 'make deploy' },
    }, client as any);

    expect(client.pushContextUpdate).toHaveBeenCalledWith(
      'project_active',
      'Store deploy command for handoff.',
      'claude_code',
      [{ label: 'deploy', run: 'make deploy', note: undefined }],
      // update_context, and only update_context, marks the write explicit.
      { explicit: true },
    );
  });

  it('update_context normalizes host-specific tool names and string commands', async () => {
    const client = {
      pushContextUpdate: vi.fn().mockResolvedValue({
        project: { project_name: 'DeerDawn' },
      }),
      recordContextEvent: vi.fn().mockResolvedValue(null),
    };

    await handleContextSyncTool('update_context', {
      projectId: 'project_active',
      summary: 'Capture smoke test command.',
      tool: 'claude_desktop',
      commands: 'npm test',
    }, client as any);

    expect(client.pushContextUpdate).toHaveBeenCalledWith(
      'project_active',
      'Capture smoke test command.',
      'claude_code',
      [{ label: 'cmd_1', run: 'npm test', note: undefined }],
      // update_context, and only update_context, marks the write explicit.
      { explicit: true },
    );
  });

  it('update_context returns guidance instead of throwing when summary is missing', async () => {
    const client = {
      getActiveContextByCwd: vi.fn(),
      pushContextUpdate: vi.fn(),
      recordContextEvent: vi.fn(),
    };

    const result = await handleContextSyncTool('update_context', {}, client as any);
    const text = result.content?.[0]?.text || '';
    // Asserted by what the guidance TELLS the caller, not by one phrase of it:
    // the wording moved when these replies stopped naming update_context, which
    // a caller cannot see in tools/list.
    expect(text).toContain('non-empty summary');
    expect(text).toContain('manage_memory');
    expect(client.pushContextUpdate).not.toHaveBeenCalled();
  });

  it('update_context metadata accepts host tool aliases without enum rejection', () => {
    const updateContextTool = contextSyncTools.find((tool) => tool.name === 'update_context');
    const toolProperty = updateContextTool?.inputSchema?.properties?.tool as Record<string, any> | undefined;
    expect(toolProperty?.type).toBe('string');
    expect(toolProperty).not.toHaveProperty('enum');
  });

  it('build_subagent_brief passes a task-scoped request and returns structured content', async () => {
    const cwd = makeTempDir();
    process.env.CLAUDE_PROJECT_DIR = cwd;
    const client = {
      buildSubagentBrief: vi.fn().mockResolvedValue({
        version: 1,
        marker: '[DeerDawn Subagent Brief v1]',
        text: '[DeerDawn Subagent Brief v1]\nObjective: Review MCP parity',
        project_id: 'project_active',
        project_name: 'DeerDawn',
        generated_at: new Date().toISOString(),
        estimated_tokens: 24,
        max_tokens: 250,
        omitted_count: 0,
        sources: [],
      }),
    };

    const result = await handleContextSyncTool('build_subagent_brief', {
      project_id: 'project_active',
      task: 'Review MCP parity',
      role: 'reviewer',
    }, client as any) as any;

    expect(result.content[0].text).toContain('[DeerDawn Subagent Brief v1]');
    expect(result.structuredContent.project_id).toBe('project_active');
    expect(client.buildSubagentBrief).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'project_active',
      task: 'Review MCP parity',
      role: 'reviewer',
      tool: expect.any(String),
      cwd,
    }));
  });

  it('advertises build_subagent_brief as a bounded task-scoped tool', () => {
    const tool = contextSyncTools.find((candidate) => candidate.name === 'build_subagent_brief');
    expect(tool).toBeDefined();
    expect(tool?.inputSchema?.required).toContain('task');
    expect(tool?.description).toContain('isolated/no-history');
  });
});

/**
 * An expired key is not an outage (2026-09-04).
 *
 * api.deerdawn.com/healthz served 200 for hours while every context call came
 * back 401 "API Key has expired." start_session collapsed both failures into one
 * sentinel and reported "network or service degraded ... retry shortly" — the
 * one remedy guaranteed never to work against an expired credential. Because the
 * error was discarded it never reached handleApiError, so it never became
 * AUTH_EXPIRED_SENTINEL, so the sign-in link was never rendered. A memory
 * product recorded nothing for the duration and reported it as somebody else's
 * fault.
 */
describe('start_session when the credential, not the service, is the problem', () => {
  // A REAL AxiosError, because handleApiError branches on `instanceof
  // AxiosError`. A duck-typed stand-in passes a shape check and then classifies
  // as a generic Error, which would make this test green against code that still
  // could not tell a 401 from a crash.
  const http = (status: number, body: unknown = {}) => {
    const err = new AxiosError(`Request failed with status code ${status}`);
    err.response = {
      status,
      statusText: '',
      data: body,
      headers: new AxiosHeaders(),
      config: { headers: new AxiosHeaders() } as any,
    };
    return err;
  };

  const failingClient = (error: unknown) => ({
    flushQueuedContextWrites: vi.fn().mockResolvedValue(null),
    getActiveContextByCwd: vi.fn().mockRejectedValue(error),
    getContextMap: vi.fn().mockRejectedValue(error),
    recordContextEvent: vi.fn().mockResolvedValue(null),
  });

  const thrown = async (client: unknown): Promise<any> => {
    try {
      return { ok: await handleContextSyncTool('start_session', {}, client as any) };
    } catch (error) {
      return { error };
    }
  };

  it('surfaces a 401 as re-authentication, not as a degraded service', async () => {
    process.env.CLAUDE_PROJECT_DIR = makeTempDir();
    const { AUTH_EXPIRED_SENTINEL } = await import('../src/utils/errors.js');

    const outcome = await thrown(failingClient(http(401, { error: 'unauthorized', message: 'API Key has expired.' })));

    // The sentinel is what tools/index.ts keys on to render the sign-in link.
    expect(outcome.error).toBeDefined();
    expect(String(outcome.error.message)).toContain(AUTH_EXPIRED_SENTINEL);
    // And emphatically NOT the sentence that sent a whole session down the wrong road.
    expect(String(outcome.error.message)).not.toContain('service degraded');
  });

  it('still reports a genuine outage as an outage', async () => {
    process.env.CLAUDE_PROJECT_DIR = makeTempDir();
    // No `response` at all — a socket-level failure, where "retry shortly" is
    // honest advice and there is nothing for the caller to re-authenticate.
    const socketError: any = new Error('connect ECONNREFUSED');
    socketError.code = 'ECONNREFUSED';

    const outcome = await thrown(failingClient(socketError));

    expect(outcome.error).toBeUndefined();
    expect(outcome.ok.content[0].text).toContain('unreachable');
    expect(outcome.ok.content[0].text).toContain('degraded');
  });

  it('does not mistake a 500 for expired credentials', async () => {
    process.env.CLAUDE_PROJECT_DIR = makeTempDir();

    const outcome = await thrown(failingClient(http(500, { error: 'server_error' })));

    expect(outcome.error).toBeUndefined();
    expect(outcome.ok.content[0].text).toContain('unreachable');
  });
});
