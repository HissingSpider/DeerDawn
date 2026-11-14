import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DeerdawnClient } from '../src/client.js';
import { handleContextSyncTool } from '../src/tools/context-sync.js';

/**
 * finish_task cleared open task state on nobody's say-so (2026-09).
 *
 * The local handler decided a task was finished by substring-matching the
 * brief's OWN status text for /(completed|done|shipped|closed)/. A status line
 * reading "Shipped PR 488; now verifying the deploy" therefore meant "this task
 * is over", and a bare manage_memory({action:"finish_task"}) — no complete_task,
 * no confirmation — emptied open_questions, the blocking issue and the command
 * log, then reported only the command count. "abandoned" and "disclosed" carry
 * the same substrings.
 *
 * The confirmation gate a few lines above only ran when complete_task was true,
 * so the one destructive path nobody asked for was also the one path that walked
 * around the gate. A gate a second route walks around is not a gate.
 *
 * PARITY with apps/api/tests/integration/mcp-finish-task-guard.test.js, which
 * pins the same rule on the hosted dispatcher.
 */

const QUESTIONS = [
  'Does the deploy need a migration first?',
  'Who owns the rollback if the Fly release fails?',
];
const COMMANDS = [{ label: 'test', run: 'npm test' }, { label: 'lint', run: 'npm run lint' }];
const TASK = 'Ship the local dispatcher fixes';
const BLOCKER = 'Waiting on the Fly deploy to pick up the new image';
// The exact shape that triggered it: a status reporting progress with the word
// "Shipped" while the task is plainly still open.
const STATUS = 'Shipped PR 488; now verifying the deploy';

let stored: Record<string, any>;
const patches: any[] = [];
const events: any[] = [];
// When set, the fake PATCH declines the completion the way the real route does:
// 200, the old value kept, and the declined fields listed in `refused`.
let refuseCompletion: string | null = null;
// When set, the fake PATCH answers the way the real route does for a teammate
// who may not edit these sections: the completion lands, the rest is skipped
// and named. Only when the client opted in with skip_unwritable_derived.
let teammateSkips: string[] | null = null;

let server: http.Server;
let client: DeerdawnClient;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const send = (body: any, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'PATCH' && req.url?.includes('/context')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      return req.on('end', () => {
        const delta = JSON.parse(body || '{}');
        patches.push(delta);
        if (teammateSkips && delta.skip_unwritable_derived === true) {
          const kept = Object.fromEntries(Object.entries(delta)
            .filter(([key]) => !teammateSkips!.includes(key) && key !== 'skip_unwritable_derived'));
          stored = { ...stored, ...kept };
          return send({ project: { project_name: stored.project_name, context: stored }, skipped_sections: teammateSkips });
        }
        if (refuseCompletion) {
          const { current_status: _s, task_progress: _p, ...rest } = delta;
          stored = { ...stored, ...rest };
          return send({
            project: { project_name: stored.project_name, context: stored },
            refused: [
              { field: 'current_status', reason: refuseCompletion },
              { field: 'task_progress', reason: refuseCompletion },
            ],
          });
        }
        stored = { ...stored, ...delta };
        send({ ok: true });
      });
    }
    if (req.url?.includes('/events')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      return req.on('end', () => {
        events.push(JSON.parse(body || '{}'));
        send(teammateSkips ? { status: 'accepted', skipped_sections: ['shipped'] } : { ok: true });
      });
    }
    if (req.url?.includes('/inject') || req.url?.startsWith('/api/v1/context/active')) {
      return send({ context: stored });
    }
    return send({}, 404);
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
  patches.length = 0;
  events.length = 0;
  refuseCompletion = null;
  teammateSkips = null;
  stored = {
    project_id: 'project_test',
    project_name: 'Test Project',
    current_task: TASK,
    current_status: STATUS,
    task_progress: 'in progress',
    commands: COMMANDS.map((c) => ({ ...c })),
    open_questions: [...QUESTIONS],
    blocking_issue: BLOCKER,
  };
});

afterAll(() => server?.close());

const text = (r: any) => String(r?.content?.[0]?.text ?? '');
const finish = (args: any) => handleContextSyncTool('cleanup_context', { project_id: 'project_test', ...args }, client);
// Journey r4: a confirmation is refused unless this process reviewed the task
// first (the owner's decision), so every confirmation here follows its review,
// as the reply tells the assistant to do. The review writes nothing.
const reviewThenConfirm = async () => {
  await finish({});
  return finish({ complete_task: true, confirm_complete: true });
};

describe('finish_task clears open state only when asked and confirmed', () => {
  it('a bare finish_task clears nothing, whatever the status line says', async () => {
    const out = text(await finish({}));

    expect(patches).toHaveLength(0);
    expect(stored.open_questions).toEqual(QUESTIONS);
    expect(stored.commands).toHaveLength(COMMANDS.length);
    expect(stored.blocking_issue).toBe(BLOCKER);
    expect(stored.current_status).toBe(STATUS);
    expect(stored.task_progress).not.toBe('completed');

    // A read-only wrap-up still has to be useful: say what a confirmed call
    // would destroy, and give the call that would do it.
    expect(out).toContain('2 open questions');
    expect(out).toContain('the blocking issue');
    expect(out).toContain('2 command log entries');
    expect(out).toContain('complete_task');
    expect(out).toContain('confirm_complete');
  });

  it('complete_task without confirm_complete is refused and writes nothing', async () => {
    const result = await finish({ complete_task: true });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('confirm_complete');
    expect(patches).toHaveLength(0);
    expect(stored.open_questions).toEqual(QUESTIONS);
    expect(stored.blocking_issue).toBe(BLOCKER);
  });

  it('a confirmed completion clears the state AND names everything it cleared', async () => {
    const out = text(await reviewThenConfirm());

    expect(patches).toHaveLength(1);
    expect(stored.open_questions).toEqual([]);
    expect(stored.commands).toEqual([]);
    expect(stored.blocking_issue).toBe('');
    expect(stored.task_progress).toBe('completed');
    expect(stored.current_status).toBe(`Completed: ${TASK}`);

    // The reply used to mention only the command log, so two questions and a
    // blocker went quietly. Everything destroyed gets named.
    expect(out).toContain('2 open questions');
    expect(out).toContain('the blocking issue');
    expect(out).toContain('2 command log entries');
  });

  it('says there was nothing to clear rather than inventing a list', async () => {
    stored.open_questions = [];
    stored.commands = [];
    stored.blocking_issue = '';

    const wrapUp = text(await finish({}));
    expect(wrapUp).toContain('no open task state to clear');
    expect(wrapUp).toContain('confirm_complete');

    const cleared = text(await reviewThenConfirm());
    expect(cleared).toContain('no open task state to clear');
  });

  it('names the advertised tool, never the dispatch-only cleanup_context', async () => {
    const out = text(await finish({}));
    expect(out).toContain('manage_memory');
    expect(out).not.toContain('cleanup_context');
  });
});

// Scan 13 PARITY: the PATCH answers 200 and lists what it declined in
// `refused`. The hosted dispatcher reads it (apps/api/src/routes/mcp.js,
// finish_task); the local one reported "Task remains recorded as completed"
// over a brief still showing the task in progress.
describe('a completion the server declines', () => {
  it('is reported as NOT recorded, with the reason and the live status, and no task_completed event', async () => {
    refuseCompletion = 'it reads as connection-test chatter rather than project context';
    const out = text(await reviewThenConfirm());

    expect(patches).toHaveLength(1);
    expect(out).toContain('Task NOT recorded as completed for Test Project');
    expect(out).toContain('current_status and task_progress');
    expect(out).toContain('connection-test chatter');
    expect(out).toContain(`The brief still reads "${STATUS}"`);
    expect(out).not.toContain('Task remains recorded as completed');
    expect(events.filter((e) => e.event_type === 'task_completed')).toHaveLength(0);
  });

  it('an accepted completion still records task_completed', async () => {
    await reviewThenConfirm();
    expect(events.filter((e) => e.event_type === 'task_completed')).toHaveLength(1);
  });
});

// Scan 23: a teammate finishing their task on a shared project. The PATCH opts
// in to skipping what the share does not let them edit, and the reply says
// what was left for the owner instead of claiming it was cleared. PARITY with
// the hosted finish_task (apps/api/tests/integration/scan23-fixes.test.js).
describe('a teammate completing a task', () => {
  it('opts in, marks it complete, and names what was left as it was', async () => {
    teammateSkips = ['task_progress', 'commands', 'open_questions', 'blocking_issue'];
    const out = text(await reviewThenConfirm());

    expect(patches).toHaveLength(1);
    expect(patches[0].skip_unwritable_derived).toBe(true);
    expect(stored.current_status).toBe(`Completed: ${TASK}`);
    expect(stored.open_questions).toEqual(QUESTIONS);
    expect(stored.blocking_issue).toBe(BLOCKER);
    expect(out).toContain('Left as they were (not shared for editing with you): task progress, command log, open questions, blocker, shipped list.');
    expect(out).not.toContain('Cleared:');
  });

  it('an owner\'s completion sends the same flag and reads exactly as before', async () => {
    const out = text(await reviewThenConfirm());
    expect(patches[0].skip_unwritable_derived).toBe(true);
    expect(out).toContain('Cleared: 2 open questions, the blocking issue, 2 command log entries.');
    expect(out).not.toContain('Left as they were');
  });
});
