import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';

/**
 * A WRITE FOLLOWED WHATEVER /active SAID, INCLUDING A GUESS.
 *
 * `/active` resolves "the project for this directory", and its weakest signal is
 * `name`: the project's name CONTAINS the folder's basename. A folder called
 * `api` matches "Acme API" and "Therapist notes" alike. start_session shows that
 * match flagged as a best guess, which is fair. But every write path that had to
 * resolve a project — update_context, the record_* tools, the task board, the
 * finish-task cleanup, and both capture hooks — took `active.project_id` without
 * looking at how it had matched, so the guess the brief warned about is where
 * the next save was filed.
 *
 * These run the real handlers and the real client against a fake API and assert
 * on the requests that reach it. Two fakes, because this package is published on
 * its own schedule and must be right against both:
 *   - OLD: ignores `purpose`, answers a write request with the name guess, and
 *     sends no `write_target` / `match_confidence`.
 *   - NEW: answers `purpose=write` with no project when only the name matched,
 *     and stamps `write_target` / `match_confidence` on everything it returns.
 *
 * HOME is a temp dir and is set BEFORE the modules load: the client's offline
 * queue, the worktree snapshots and the plan cache all resolve ~/.deerdawn at
 * import time.
 */

type Seen = { method: string; url: string; body: any };

let server: http.Server;
let home: string;
let repo: string;
let seen: Seen[] = [];
let api: 'old' | 'new' = 'old';
/** How the fake API matches the directory when asked to READ. */
let match: { kind: string; id: string; name: string } | null = null;

const savedEnv: Record<string, string | undefined> = {};
let DeerdawnClient: typeof import('../src/client.js').DeerdawnClient;
let handleContextSyncTool: typeof import('../src/tools/context-sync.js').handleContextSyncTool;
let captureCommandWithClient: typeof import('../src/command-capture.js').captureCommandWithClient;
let captureWorktreeChangeWithClient: typeof import('../src/worktree-capture.js').captureWorktreeChangeWithClient;
let writeTarget: typeof import('../src/write-target.js');
let client: InstanceType<typeof DeerdawnClient>;

const HIGH = new Set(['path', 'pinned', 'workspace']);

function activePayload(purposeWrite: boolean) {
  const none = { brief: null, project_name: null, project_id: null, last_updated: null };
  if (!match) return none;
  if (api === 'new' && purposeWrite && match.kind === 'name') return none;
  return {
    brief: 'brief',
    project_id: match.id,
    project_name: match.name,
    match_kind: match.kind,
    last_updated: null,
    ...(api === 'new'
      ? { match_confidence: HIGH.has(match.kind) ? 'high' : 'low', write_target: HIGH.has(match.kind) }
      : {}),
  };
}

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-wt-home-')));
  repo = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-wt-repo-'))), 'api');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/api.git'], { cwd: repo });
  for (const key of ['HOME', 'USERPROFILE', 'DEERDAWN_HOME_DIR', 'CLAUDE_PROJECT_DIR', 'DEERDAWN_API_KEY']) savedEnv[key] = process.env[key];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.DEERDAWN_HOME_DIR = home;
  process.env.CLAUDE_PROJECT_DIR = repo;
  delete process.env.DEERDAWN_API_KEY;

  const { vi } = await import('vitest');
  vi.resetModules();
  ({ DeerdawnClient } = await import('../src/client.js'));
  ({ handleContextSyncTool } = await import('../src/tools/context-sync.js'));
  ({ captureCommandWithClient } = await import('../src/command-capture.js'));
  ({ captureWorktreeChangeWithClient } = await import('../src/worktree-capture.js'));
  writeTarget = await import('../src/write-target.js');

  server = http.createServer((req, res) => {
    if (req.headers['x-deerdawn-cwd'] || req.headers['x-deerdawn-workspace-key']) res.setHeader('X-DeerDawn-Location', 'header');
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body: any = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      const url = req.url || '';
      seen.push({ method: req.method || 'GET', url, body });
      const send = (payload: any, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const query = new URLSearchParams(url.split('?')[1] || '');
      if (req.method === 'POST' && url.endsWith('/context/projects')) {
        return send({ project: { project_id: 'project_created', project_name: body?.project_name, parent_project_id: null } });
      }
      if (url.includes('/context/active')) {
        if (query.get('format') === 'json') {
          return send({ context: match ? { project_id: match.id, project_name: match.name, todo_items: [], completed_todos: [] } : null });
        }
        return send(activePayload(query.get('purpose') === 'write'));
      }
      if (url.includes('/inject')) {
        const id = decodeURIComponent(url.split('/projects/')[1].split('/')[0]);
        return send({ context: { project_id: id, project_name: id, current_task: 'Ship it', todo_items: [], completed_todos: [], commands: [], open_questions: [] } });
      }
      if (url.includes('/extraction')) {
        return send({ stored: true, project: { project_id: body?.project_id, project_name: 'whatever' }, extraction: { delta: {} } });
      }
      send({ ok: true, status: 'accepted' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  client = new DeerdawnClient({
    apiUrl: `http://127.0.0.1:${port}`,
    apiKey: 'dev-key',
    environment: 'sandbox',
    cacheEnabled: false,
    cacheTtlSeconds: 60,
    maxRetries: 1,
    retryBackoffMs: 10,
  } as any);
});

beforeEach(() => {
  seen = [];
  api = 'old';
  match = null;
  writeTarget.forgetWriteTargets();
});

afterEach(() => {
  try { execFileSync('git', ['checkout', '-q', '--', '.'], { cwd: repo, stdio: 'ignore' }); } catch { /* nothing committed */ }
});

afterAll(() => {
  server?.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of [home, path.dirname(repo)]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** Everything that is not a lookup: the requests that would change stored data. */
const writes = () => seen.filter((r) => r.method !== 'GET');
const textOf = (result: any): string => String(result?.content?.[0]?.text ?? '');
const GUESS = { kind: 'name', id: 'project_guess', name: 'Therapist notes' };
const LINKED = { kind: 'path', id: 'project_linked', name: 'Acme API' };

for (const flavour of ['old', 'new'] as const) {
  describe(`explicit tool calls against the ${flavour} API`, () => {
    beforeEach(() => { api = flavour; });

    it('update_context refuses a name guess, writes nothing, and names the project to pass', async () => {
      match = GUESS;
      const result: any = await handleContextSyncTool('update_context', { summary: 'Decided to ack after the write.' }, client);
      expect(writes(), 'a guess must not receive the save').toEqual([]);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Nothing was saved');
      expect(textOf(result)).toContain('project_guess');
      expect(textOf(result)).toContain('Therapist notes');
      expect(textOf(result)).toContain('project_id');
      expect(textOf(result)).toContain('start_session');
    });

    it('update_context asks for a write target and saves to a linked path', async () => {
      match = LINKED;
      await handleContextSyncTool('update_context', { summary: 'Decided to ack after the write.' }, client);
      const lookup = seen.find((r) => r.url.includes('/context/active'));
      expect(new URLSearchParams(lookup!.url.split('?')[1]).get('purpose')).toBe('write');
      const saved = writes().find((r) => r.url.includes('/extraction'));
      expect(saved?.body?.project_id).toBe('project_linked');
    });

    it('record_finding refuses a name guess', async () => {
      match = GUESS;
      await expect(handleContextSyncTool('record_debug_finding', { summary: 'The consumer acked before the write landed.' }, client))
        .rejects.toThrow(/project_guess/);
      expect(writes()).toEqual([]);
    });

    it('the task board can be READ through a guess and cannot be changed through one', async () => {
      match = GUESS;
      const listed: any = await handleContextSyncTool('manage_todos', { action: 'list' }, client);
      expect(listed.isError).toBeFalsy();
      await expect(handleContextSyncTool('manage_todos', { action: 'add', todos: ['Ack after the write'] }, client))
        .rejects.toThrow(/project_guess/);
      expect(writes()).toEqual([]);
    });

    it('finishing a task shows a guess its checklist and never clears it', async () => {
      match = GUESS;
      const shown: any = await handleContextSyncTool('cleanup_context', {}, client);
      expect(shown.isError).toBeFalsy();
      expect(textOf(shown)).toContain('Ship it');
      const refused: any = await handleContextSyncTool('cleanup_context', { complete_task: true, confirm_complete: true }, client);
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain('project_guess');
      expect(writes()).toEqual([]);
    });

    it('an explicit project_id is still written to without any lookup', async () => {
      match = GUESS;
      await handleContextSyncTool('update_context', { project_id: 'project_named', summary: 'Decided to ack after the write.' }, client);
      expect(seen.some((r) => r.url.includes('/context/active'))).toBe(false);
      expect(writes().find((r) => r.url.includes('/extraction'))?.body?.project_id).toBe('project_named');
    });

    // The casualty a blanket refusal would have: a brand-new repo. The project
    // is typically NAMED after the folder, so until the first save links the
    // directory the only thing /active can say about it is `name`.
    it('a first-run user: create a project, then save with no project_id', async () => {
      match = null;
      await handleContextSyncTool('create_project', { project_name: 'api' }, client);
      match = { kind: 'name', id: 'project_created', name: 'api' };
      seen = [];
      const result: any = await handleContextSyncTool('update_context', { summary: 'Chose Postgres over SQLite for the queue.' }, client);
      expect(result.isError).toBeFalsy();
      const saved = writes().find((r) => r.url.includes('/extraction'));
      expect(saved?.body?.project_id).toBe('project_created');
      // The write carries the directory, which is what lets the API link it so
      // the NEXT session resolves by path and needs none of this.
      expect(saved?.body?.session_context?.cwd).toBe(repo);
    });

    it('what this process created never outranks a linked path', async () => {
      await handleContextSyncTool('create_project', { project_name: 'Side idea' }, client);
      match = LINKED;
      seen = [];
      await handleContextSyncTool('update_context', { summary: 'Decided to ack after the write.' }, client);
      expect(writes().find((r) => r.url.includes('/extraction'))?.body?.project_id).toBe('project_linked');
    });

    it('capture-command drops a name guess in silence and records a linked path', async () => {
      const payload = { tool_input: { command: 'npm test' }, tool_response: { exit_code: 0 } };
      match = GUESS;
      await expect(captureCommandWithClient(client, payload as any)).resolves.toBeUndefined();
      expect(writes()).toEqual([]);

      match = LINKED;
      await captureCommandWithClient(client, payload as any);
      const events = writes().filter((r) => r.url.includes('/context/events'));
      expect(events).toHaveLength(1);
      expect(events[0].body.project_id).toBe('project_linked');
    });

    it('capture-worktree-change drops a name guess in silence and records a linked path', async () => {
      fs.writeFileSync(path.join(repo, `changed-${flavour}-a.txt`), 'x');
      match = GUESS;
      const dropped = await captureWorktreeChangeWithClient(client, repo);
      expect(dropped.recorded).toBe(false);
      expect(writes()).toEqual([]);

      fs.writeFileSync(path.join(repo, `changed-${flavour}-b.txt`), 'x');
      match = LINKED;
      const recorded = await captureWorktreeChangeWithClient(client, repo);
      expect(recorded).toMatchObject({ recorded: true, project_id: 'project_linked' });
      expect(writes().filter((r) => r.url.includes('/context/events'))).toHaveLength(1);
    });
  });
}

describe('judging an /active answer', () => {
  it('follows write_target when the API sent it, in both directions', () => {
    const { isWriteGradeMatch } = writeTarget;
    expect(isWriteGradeMatch({ project_id: 'p', match_kind: 'recency_fallback', write_target: true })).toBe(true);
    expect(isWriteGradeMatch({ project_id: 'p', match_kind: 'path', write_target: false })).toBe(false);
  });

  it('falls back to match_kind for an API that sends neither field', () => {
    const { isWriteGradeMatch } = writeTarget;
    for (const kind of ['path', 'pinned', 'workspace']) expect(isWriteGradeMatch({ project_id: 'p', match_kind: kind }), kind).toBe(true);
    for (const kind of ['name', 'recency_fallback', '', undefined]) expect(isWriteGradeMatch({ project_id: 'p', match_kind: kind as any }), String(kind)).toBe(false);
    expect(isWriteGradeMatch({ project_id: 'p', match_kind: 'session', match_confidence: 'high' })).toBe(true);
    expect(isWriteGradeMatch({ project_id: null, match_kind: 'path' })).toBe(false);
  });

  it('a parent folder of another or unknown repository is a guess, in both spellings', () => {
    const { isWriteGradeMatch, isGuessedMatch, describeWriteRefusal } = writeTarget;
    // The newer API says so itself.
    const sent = { project_id: 'p', match_kind: 'ancestor_path', match_confidence: 'low', write_target: false };
    expect(isWriteGradeMatch(sent)).toBe(false);
    expect(isGuessedMatch(sent)).toBe(true);
    // An API that sends neither field: the kind alone is not on the write list.
    expect(isWriteGradeMatch({ project_id: 'p', match_kind: 'ancestor_path' })).toBe(false);
    const refusal = describeWriteRefusal(
      { kind: 'guess', projectId: 'p', projectName: 'Home', reason: 'parent_folder' },
      'record a finding in',
    );
    expect(refusal).toContain('a parent folder of this directory is linked to it');
    expect(refusal).toContain('project_id: "p"');
  });

  it('an unreachable API is "no target", never a throw', async () => {
    let calls = 0;
    const down = { getActiveContextByCwd: async () => { calls += 1; throw new Error('ECONNREFUSED'); } };
    await expect(writeTarget.resolveWriteTarget(down as any, repo, { nameTheGuess: true })).resolves.toEqual({ kind: 'none' });
    // One timeout, not two: the follow-up read is for naming a guess, and an
    // unreachable API has none to name.
    expect(calls).toBe(1);
  });
});
