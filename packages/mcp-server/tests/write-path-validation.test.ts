import { AxiosError, AxiosHeaders } from 'axios';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { handleContextSyncTool } from '../src/tools/context-sync.js';
import { AUTH_EXPIRED_SENTINEL } from '../src/utils/errors.js';

/**
 * The read/write validation asymmetry, audited.
 *
 * A read that is handed a bad argument answers with the field's name. A write
 * handed the same kind of argument used to answer "Operation failed (Error)" —
 * or, worse, not answer at all: it picked a value on the caller's behalf and
 * reported success for the substitution. Both leave the caller unable to fix the
 * call, and the second leaves it unaware there is anything to fix.
 *
 * Everything below drives the real handler. `handleContextSyncTool` routes every
 * grouped tool by CALLING ITSELF, so these also pin the fact that an error
 * crossing that boundary survives it.
 */

/** Enough of a client for the board handler to reach its own argument checks. */
// APPLIES a todo_added event rather than serving a frozen empty board. `add`
// reports a before/after difference of the stored cards now, so a fake that
// never files the card makes every successful add read as one the board
// dropped — which is a real reply, just not the one these tests are about.
const boardClient = () => {
  const todoItems: any[] = [];
  return {
    // A board write with no project_id resolves its write target first, and a
    // target is a linked path, never a name guess (write-target.ts).
    getActiveContextByCwd: vi.fn().mockResolvedValue({ project_id: 'p1', project_name: 'Atlas', match_kind: 'path' }),
    getContextJson: vi.fn().mockImplementation(async () => ({
      project_id: 'p1', project_name: 'Atlas', todo_items: [...todoItems], completed_todos: [],
    })),
    recordContextEvent: vi.fn().mockImplementation(async (event: any) => {
      if (event?.event_type === 'todo_added') {
        for (const card of event?.metadata?.todos || []) {
          todoItems.push({ id: `card-${todoItems.length + 1}`, title: card.title, phase: card.phase || 'backlog' });
        }
      }
      return { ok: true };
    }),
  };
};

async function thrown(name: string, args: unknown, client: unknown = {}): Promise<McpError> {
  try {
    await handleContextSyncTool(name, args as any, client as any);
  } catch (error) {
    return error as McpError;
  }
  throw new Error(`${name} should have rejected these arguments`);
}

describe('an argument a handler rejects itself', () => {
  it('names the valid actions instead of collapsing to "Operation failed"', async () => {
    const err = await thrown('manage_memory', { action: 'add_decision' });

    expect(err.message).not.toContain('Operation failed');
    expect(err.message).toContain('add_decision');
    // The list is the fix: the caller picked a plausible name and needs the real one.
    expect(err.message).toContain('record_finding');
    expect(err.code).toBe(ErrorCode.InvalidParams);
  });

  it('classifies it as the caller\'s error on the read router too', async () => {
    const err = await thrown('recall', { action: 'everything' });

    expect(err.code).toBe(ErrorCode.InvalidParams);
    expect(err.message).toContain('portfolio');
  });

  it('says which argument the task board is missing', async () => {
    const err = await thrown('manage_tasks', { action: 'add' }, boardClient());

    expect(err.message).not.toContain('Operation failed');
    expect(err.message).toContain('todos');
    expect(err.code).toBe(ErrorCode.InvalidParams);
  });
});

/**
 * A bad enum value used to be substituted rather than reported.
 */
describe('a value the write silently replaced', () => {
  it('rejects an unknown phase instead of filing the card in Backlog', async () => {
    // `add` normalised an unrecognised phase to '' and used the default column,
    // and the confirmation never mentioned that the requested column had been
    // dropped. The caller was told the write succeeded, which it had — somewhere
    // other than where it asked.
    const err = await thrown('manage_tasks', { action: 'add', todos: ['Ship it'], phase: 'in-review' });

    expect(err.message).toContain('in-review');
    expect(err.message).toContain('in_progress');
    expect(err.code).toBe(ErrorCode.InvalidParams);
  });

  it('does not claim a phase is missing when one was supplied', async () => {
    const err = await thrown('manage_tasks', { action: 'move', todos: ['Ship it'], phase: 'shipped' });

    expect(err.message).not.toContain('is required');
    expect(err.message).toContain('shipped');
  });

  it('still accepts the spellings it was always willing to normalise', async () => {
    const result = await handleContextSyncTool(
      'manage_tasks',
      { action: 'add', todos: ['Ship it'], phase: 'In Progress' } as any,
      boardClient() as any,
    );
    expect(result.content[0].text).toContain('in progress');
  });

  it('refuses an export kind it does not recognise rather than picking the private one', async () => {
    // "project" carries this project's task state, goals and board to whoever
    // imports the archive; "pack" leaves them out. Everything unrecognised became
    // "project", so a caller reaching for the shareable variant and mistyping got
    // the one that donates the private half, reported as a success.
    const client = { exportTrail: vi.fn() };
    const err = await thrown('manage_memory', { action: 'export_trail', project_id: 'p1', kind: 'shared' }, client);

    expect(err.message).toContain('shared');
    expect(err.message).toContain('pack');
    expect(client.exportTrail).not.toHaveBeenCalled();
  });

  it('says export_trail needs a project_id rather than failing opaquely', async () => {
    const err = await thrown('manage_memory', { action: 'export_trail' });
    expect(err.message).toContain('project_id');
    expect(err.code).toBe(ErrorCode.InvalidParams);
  });
});

/**
 * dry_run is the flag that decides whether import_trail is a read or a write,
 * and `=== true` resolved every non-boolean in the WRITING direction.
 */
describe('import_trail dry_run', () => {
  const TRAIL = JSON.stringify({ manifest: { title: 'Atlas' } });
  const client = () => ({
    importTrail: vi.fn().mockResolvedValue({ applied: false, plan: { applied: {} } }),
  });

  it('honours a dry run that arrived as a string', async () => {
    // Clients that stringify booleans are not hypothetical — coerceConfirmedFlag
    // exists for them, and import_local_context advertises the string forms in
    // its own schema. Here the same client asked for a plan and got an import.
    const api = client();
    await handleContextSyncTool('manage_memory', { action: 'import_trail', trail: TRAIL, dry_run: 'true' } as any, api as any);

    expect(api.importTrail).toHaveBeenCalledWith(expect.objectContaining({ dry_run: true }));
  });

  it('still writes when no dry run was asked for', async () => {
    const api = client();
    await handleContextSyncTool('manage_memory', { action: 'import_trail', trail: TRAIL } as any, api as any);

    expect(api.importTrail).toHaveBeenCalledWith(expect.objectContaining({ dry_run: false }));
  });

  it('stops on a value it cannot read rather than choosing the writing branch', async () => {
    const api = client();
    const err = await thrown('manage_memory', { action: 'import_trail', trail: TRAIL, dry_run: 'maybe' }, api);

    expect(err.code).toBe(ErrorCode.InvalidParams);
    expect(err.message).toContain('dry_run');
    expect(api.importTrail).not.toHaveBeenCalled();
  });
});

/**
 * Every advertised tool is a router that re-enters handleContextSyncTool under a
 * legacy name, so the message a caller of the advertised surface reads is built
 * one frame down from where it is thrown.
 */
describe('an error that crosses the grouped-tool boundary', () => {
  it('keeps the field-level message through the second pass', async () => {
    const err = await thrown('manage_memory', { action: 'record_paths' });

    expect(err.message).not.toContain('Operation failed');
    expect(err.message).toContain('items is required');
    expect(err.code).toBe(ErrorCode.InvalidParams);
  });

  it('reaches the same message when the legacy name is called directly', async () => {
    const direct = await thrown('record_hot_paths', {});
    const grouped = await thrown('manage_memory', { action: 'record_paths' });

    expect(grouped.message).toBe(direct.message);
    expect(grouped.code).toBe(direct.code);
  });
});

/**
 * The description and the schema disagreed, and the schema won.
 *
 * Every project_id on this surface is advertised as "omit to use the active
 * project". record_paths, record_finding and confirm rejected that exact call
 * with "Invalid arguments — project_id is required" — a refusal of the documented
 * shape, on the write path, invisible to exception tracking because a rejected
 * argument is a handled MCP error rather than a throw.
 */
describe('a write whose project_id was omitted, as the description invites', () => {
  /** Enough of a client to answer "what project is this cwd?" and take the write. */
  const activeClient = (activeProjectId: string | null = 'p_active') => ({
    getActiveContextByCwd: vi.fn().mockResolvedValue(
      // match_kind as /active sends it: these writes follow a linked path, and
      // refuse a name guess (tests/write-target-routing.test.ts).
      activeProjectId ? { project_id: activeProjectId, project_name: 'Atlas', match_kind: 'path' } : null,
    ),
    recordHotPaths: vi.fn().mockResolvedValue({ project_name: 'Atlas' }),
    recordDebugFinding: vi.fn().mockResolvedValue({ project_name: 'Atlas' }),
    confirmClaim: vi.fn().mockResolvedValue({ verified: { kind: 'current_status', summary: 'green' } }),
    recordContextEvent: vi.fn().mockResolvedValue({ ok: true }),
  });

  it('records paths against the active project', async () => {
    const api = activeClient();
    const result = await handleContextSyncTool(
      'manage_memory',
      { action: 'record_paths', items: [{ label: 'signup route', path: 'apps/api/src/routes/auth.js' }] } as any,
      api as any,
    );

    expect(api.recordHotPaths).toHaveBeenCalledWith('p_active', expect.any(Array));
    expect(result.content[0].text).toContain('Atlas');
  });

  it('records a finding against the active project', async () => {
    const api = activeClient();
    await handleContextSyncTool(
      'manage_memory',
      { action: 'record_finding', summary: 'The loopback port made every add a 400.' } as any,
      api as any,
    );

    expect(api.recordDebugFinding).toHaveBeenCalledWith('p_active', expect.objectContaining({
      summary: 'The loopback port made every add a 400.',
    }));
  });

  it('confirms a claim against the active project', async () => {
    const api = activeClient();
    await handleContextSyncTool('confirm_claim', { claim: 'status' } as any, api as any);

    expect(api.confirmClaim).toHaveBeenCalledWith('p_active', expect.objectContaining({ claim: 'status' }));
  });

  it('still says what to do when there is no active project to fall back to', async () => {
    const api = activeClient(null);
    const err = await thrown('manage_memory', { action: 'record_finding', summary: 'x' }, api);

    expect(err.code).toBe(ErrorCode.InvalidParams);
    expect(err.message).not.toContain('Operation failed');
    // What to do is create a project: start_session creates nothing, so naming
    // it here sent a brand-new account round in a circle (scan 24).
    expect(err.message).toContain('manage_projects(action:"create"');
    expect(api.recordDebugFinding).not.toHaveBeenCalled();
  });

  it('uses the project it was given when it was given one', async () => {
    const api = activeClient();
    await handleContextSyncTool(
      'manage_memory',
      { action: 'record_finding', project_id: 'p_explicit', summary: 'x' } as any,
      api as any,
    );

    expect(api.getActiveContextByCwd).not.toHaveBeenCalled();
    expect(api.recordDebugFinding).toHaveBeenCalledWith('p_explicit', expect.anything());
  });
});

/**
 * An error that reaches handleApiError twice.
 *
 * A handler may call handleApiError inside its OWN catch to map error codes back
 * to something actionable — import_skill_from_github does exactly that. But the
 * catch in handleContextSyncTool wraps the entire switch, and a throw from
 * inside a case's catch block is still inside it. So the finished McpError came
 * straight back in, matched `instanceof Error`, and left as "Operation failed
 * (McpError)": a fully-classified, field-naming error demoted to an internal one
 * on its way out of the same function that built it.
 *
 * The 401 sentinel travelled that same road, and it is not a message — it is the
 * signal tools/index.ts watches for to start a fresh device flow. Losing it turns
 * "your session expired, here is a sign-in link" into "Operation failed".
 */
describe('an error handled once by the case and once by the wrapper', () => {
  const failing = (status: number, data: unknown) => {
    const err = new AxiosError(`Request failed with status code ${status}`);
    err.response = {
      status, statusText: '', data,
      headers: new AxiosHeaders(),
      config: { headers: new AxiosHeaders() },
    } as AxiosError['response'];
    return { importSkillFromGithub: vi.fn().mockRejectedValue(err) };
  };

  it('keeps the classification the case already made', async () => {
    const err = await thrown(
      'manage_skills',
      { action: 'import_github', repo_url: 'https://github.com/acme/skills' },
      failing(404, { error: 'skill_not_found' }),
    );

    expect(err.message).not.toContain('Operation failed');
    expect(err.message).toContain('Resource not found');
  });

  it('keeps the auth sentinel intact so a 401 can still trigger sign-in', async () => {
    const err = await thrown(
      'manage_skills',
      { action: 'import_github', repo_url: 'https://github.com/acme/skills' },
      failing(401, { error: 'unauthorized' }),
    );

    // tools/index.ts matches on this to open a device flow. Anything else here
    // and an expired token is shown to the user as an internal failure.
    expect(err.message).toContain(AUTH_EXPIRED_SENTINEL);
  });
});
