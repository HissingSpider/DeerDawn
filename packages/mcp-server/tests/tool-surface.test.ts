import { describe, it, expect } from 'vitest';
import { listTools } from '../src/tools/index.js';

/**
 * The advertised tool surface is a budget, not an inventory. These tests exist to
 * make that budget fail loudly in CI rather than drift back to 36 tools one
 * reasonable-looking addition at a time.
 */

const STEADY = { authed: true, hasBoundProject: true, hasSkills: false };
const FIRST_RUN = { authed: false, hasBoundProject: false, hasSkills: false };

const names = (state?: Parameters<typeof listTools>[0]) => listTools(state).map((t) => t.name);
const payloadTokens = (state?: Parameters<typeof listTools>[0]) =>
  Math.round(JSON.stringify(listTools(state)).length / 4);

describe('advertised tool surface', () => {
  it('keeps the review surface unchanged unless task-board UI is explicitly enabled', () => {
    const previous = process.env.MCP_TASK_BOARD_UI_ENABLED;
    try {
      delete process.env.MCP_TASK_BOARD_UI_ENABLED;
      expect((listTools(STEADY).find((tool) => tool.name === 'manage_tasks') as any)?._meta).toBeUndefined();
      process.env.MCP_TASK_BOARD_UI_ENABLED = 'true';
      expect((listTools(STEADY).find((tool) => tool.name === 'manage_tasks') as any)?._meta?.ui?.resourceUri)
        .toBe('ui://deerdawn/task-board/v1.html');
    } finally {
      if (previous === undefined) delete process.env.MCP_TASK_BOARD_UI_ENABLED;
      else process.env.MCP_TASK_BOARD_UI_ENABLED = previous;
    }
  });

  it('charges a steady-state session under the token budget', () => {
    // Measured baseline before tiering: 36 tools / ~7,000 tokens on EVERY session.
    // This ceiling is deliberately just above the current ~3,550 so a large new
    // schema trips it. Lower it when descriptions get trimmed; never raise it
    // without deciding, explicitly, that the tokens are worth it.
    expect(payloadTokens(STEADY)).toBeLessThan(4000);
  });

  it('advertises the two add-on tools once signed in, and nothing per add-on', () => {
    // Decided 2026-11-13, against this budget: read_addon + use_addon cost ~396
    // tokens (steady state 2,534 -> 2,930) and stay that size however many
    // add-ons exist, because each add-on's actions come from `help` on demand.
    // A third add-on tool, or per-add-on tools, needs the same decision again.
    expect(names(STEADY)).toEqual(expect.arrayContaining(['read_addon', 'use_addon']));
    expect(names(FIRST_RUN)).not.toContain('use_addon');
    expect(names(STEADY).filter((name) => name.endsWith('_addon'))).toHaveLength(2);
  });

  it('keeps the steady-state surface small enough to choose from', () => {
    expect(names(STEADY).length).toBeLessThanOrEqual(15);
  });

  it('never advertises names replaced by grouped actions', () => {
    for (const state of [STEADY, FIRST_RUN]) {
      for (const legacy of ['read_brief', 'update_brief', 'get_context', 'update_context', 'manage_todos', 'create_project']) {
        expect(names(state)).not.toContain(legacy);
      }
    }
  });

  it('still DISPATCHES every de-advertised name (published contract)', async () => {
    // Tool names are literal strings in CLAUDE.md / AGENTS.md / .cursorrules files
    // already on users' disks and in the hook commands in auth.ts. Hiding a name
    // from tools/list is fine; making it unreachable is a breaking change for
    // every install that has those files. This is the test that catches the
    // difference, so it must assert against the real dispatch table.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/tools/index.ts', import.meta.url), 'utf8'));
    const dispatchLine = src.match(/const CONTEXT_SYNC_TOOLS = \[(.*?)\];/s)?.[1] ?? '';
    const dispatchable = new Set([
      ...dispatchLine.split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean),
      'get_auth_status', 'get_setup_status', 'apply_setup', 'complete_setup',
      'inspect_context_graph',
      // Dispatched through ADDON_TOOL_NAMES, built from the same array listTools reads.
      'read_addon', 'use_addon',
    ]);

    const everyAdvertisableName = names(); // undefined state => the full list
    for (const name of everyAdvertisableName) {
      expect(dispatchable, `${name} is advertised but not dispatchable`).toContain(name);
    }
    // The two aliases are never advertised, but must remain callable forever.
    expect(dispatchable).toContain('read_brief');
    expect(dispatchable).toContain('update_brief');
  });

  it('shows setup tools only until the user is signed in', () => {
    expect(names(FIRST_RUN)).toContain('get_auth_status');
    expect(names(FIRST_RUN)).toContain('apply_setup');
    expect(names(STEADY)).not.toContain('get_auth_status');
    expect(names(STEADY)).not.toContain('apply_setup');
  });

  it('keeps project creation and local import inside grouped tools', () => {
    expect(names(FIRST_RUN)).toContain('manage_projects');
    expect(names(FIRST_RUN)).toContain('manage_memory');
    expect(names(FIRST_RUN)).not.toContain('create_project');
    expect(names(FIRST_RUN)).not.toContain('import_local_context');
  });

  it('shows skills tools only when the workspace has skills', () => {
    expect(names(STEADY)).not.toContain('manage_skills');
    expect(names({ ...STEADY, hasSkills: true })).toContain('manage_skills');
    expect(names({ ...STEADY, hasSkills: true })).toContain('browse_skills');
  });

  it('always advertises the core loop regardless of state', () => {
    const core = ['start_session', 'recall', 'manage_projects', 'manage_memory', 'manage_tasks'];
    for (const state of [STEADY, FIRST_RUN, { ...STEADY, hasSkills: true }]) {
      for (const tool of core) expect(names(state)).toContain(tool);
    }
  });

  it('keeps unknown state compact while showing setup and skills entry points', () => {
    expect(names().length).toBeGreaterThan(names(STEADY).length);
    expect(names()).toContain('get_auth_status');
    expect(names()).toContain('manage_projects');
    expect(names()).toContain('manage_skills');
    expect(names()).not.toContain('create_project');
  });

  it('advertises strict invocation-level annotations for every visible tool', () => {
    // readOnlyHint is false for everything here because this runtime records
    // tool-call telemetry on every call, unconditionally (index.ts). The hosted
    // connector suppresses that for read-only tools and so gets to say true; the
    // two answers are both honest about two different runtimes.
    //
    // destructiveHint is a different question and used to be answered by copying
    // readOnlyHint. get_auth_status and recall destroy nothing, and advertising
    // that they might is what a host uses to decide whether to interrupt the
    // user before a plain read. That over-claim is the same class of defect the
    // ChatGPT reviewer rejected the hosted catalog for on 2026-09-08, in the
    // opposite direction.
    //
    // start_session stays destructive here and is false on the hosted connector.
    // That is deliberate, not drift: only this runtime rewrites
    // .deerdawn-context.md, AGENTS.md and .cursorrules via syncProjectFiles, so
    // only here can the call replace a file the user wrote.
    const destructive = new Set([
      'apply_setup',
      'complete_setup',
      'start_session',
      'manage_projects',
      'manage_memory',
      'manage_tasks',
      'manage_skills',
      // An add-on's write actions include permanent deletes of its records.
      'use_addon',
    ]);

    for (const tool of listTools()) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} records invocation state`).toBe(false);
      expect(tool.annotations?.idempotentHint, `${tool.name} records another event when repeated`).toBe(false);
      expect(tool.annotations?.destructiveHint, `${tool.name} destructive hint`).toBe(destructive.has(tool.name));
      expect(tool.annotations?.openWorldHint, `${tool.name} open-world hint`).toBe(tool.name === 'manage_skills');
    }
  });

  it('describes get_auth_status as a setup and recovery tool, not a session-start prerequisite', () => {
    const authStatus = listTools(FIRST_RUN).find((tool) => tool.name === 'get_auth_status');
    expect(authStatus?.description).toContain('initial setup');
    expect(authStatus?.description).toContain('sign-in needs attention');
    expect(authStatus?.description).not.toMatch(/start of every new session/i);
  });
});
