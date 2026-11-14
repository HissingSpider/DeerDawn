import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DeerdawnClient } from '../src/client.js';
import { handleContextSyncTool } from '../src/tools/context-sync.js';

/**
 * JOURNEY R4 (BLOCKED 22), LOCAL: finish_task cleared what nobody had seen.
 *
 * The wrap-up review named the open questions, blocker and command log; the
 * confirmation cleared them as they stood AT THE CONFIRMATION, so a question
 * added in between — by the person or another tool — went unseen. The owner's
 * decision: the confirmation clears exactly what the review showed, anything
 * added since stays, and the reply says what stayed.
 *
 * The local server remembers the review in its own process (one process is one
 * session) and writes with the version it read: a brief that moved on during
 * the call answers 409 and is re-read and re-planned, so an item landing
 * mid-call stays too.
 *
 * PARITY: apps/api/tests/integration/journey-r4-finish-task-review.test.js pins
 * the same on the hosted dispatcher, same words (shared-context taskReview.js).
 */

const TASK = 'Ship the invoice export';
const Q1 = 'Does the export need a migration first?';
const Q2 = 'Who owns the rollback if the release fails?';
const Q_LATE = 'Should archived invoices be exported too?';
const BLOCKER = 'Waiting on the payments team to approve the schema';

let stored: Record<string, any>;
let version = 1;
const patches: any[] = [];
const events: any[] = [];
// When set, runs once just before the next PATCH is judged: another writer
// landing between this call's read and its write.
let beforeNextPatch: (() => void) | null = null;

let server: http.Server;
let client: DeerdawnClient;
// Each test file shares one process, and the review is per process: a project
// id per test keeps one test's review from answering for another's.
let projectId = '';

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
        if (beforeNextPatch) { const run = beforeNextPatch; beforeNextPatch = null; run(); }
        if (Number.isInteger(delta.expected_context_version) && delta.expected_context_version !== version) {
          return send({ error: 'stale_context_version', code: 'stale_context_version', message: 'stale' }, 409);
        }
        const { expected_context_version: _v, skip_unwritable_derived: _s, ...rest } = delta;
        stored = { ...stored, ...rest };
        version += 1;
        return send({ project: { project_name: stored.project_name, context: stored } });
      });
    }
    if (req.url?.includes('/events')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      return req.on('end', () => { events.push(JSON.parse(body || '{}')); send({ ok: true }); });
    }
    if (req.url?.includes('/inject') || req.url?.startsWith('/api/v1/context/active')) {
      return send({ context: { ...stored, context_version: version } });
    }
    return send({}, 404);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  client = new DeerdawnClient({
    apiUrl: `http://127.0.0.1:${port}`, apiKey: 'dev-key', environment: 'sandbox',
    cacheEnabled: false, cacheTtlSeconds: 60, maxRetries: 1, retryBackoffMs: 10,
  } as any);
});

let n = 0;
beforeEach(() => {
  patches.length = 0;
  events.length = 0;
  beforeNextPatch = null;
  version = 1;
  projectId = `project_review_${n += 1}`;
  stored = {
    project_id: projectId,
    project_name: 'Invoices',
    current_task: TASK,
    task_progress: 'in progress',
    open_questions: [Q1, Q2],
    blocking_issue: BLOCKER,
    commands: [{ label: 'test', run: 'npm test' }],
  };
});

afterAll(() => server?.close());

const text = (r: any) => String(r?.content?.[0]?.text ?? '');
const finish = (args: any) => handleContextSyncTool('cleanup_context', { project_id: projectId, ...args }, client);
const confirm = () => finish({ complete_task: true, confirm_complete: true });

describe('finish_task clears what its review showed', () => {
  it('a question added between the review and the confirmation stays, and the reply says so', async () => {
    const review = text(await finish({}));
    expect(review).toContain('Completing this task would clear 2 open questions, the blocking issue, 1 command log entry.');

    stored.open_questions = [...stored.open_questions, Q_LATE];
    version += 1;

    const out = text(await confirm());
    expect(stored.open_questions).toEqual([Q_LATE]);
    expect(stored.blocking_issue).toBe('');
    expect(stored.commands).toEqual([]);
    expect(stored.task_progress).toBe('completed');
    expect(out).toBe([
      'Cleanup complete for Invoices.',
      `Task remains recorded as completed: "${TASK}".`,
      'Cleared: 2 open questions, the blocking issue, 1 command log entry.',
      `Left as they were (added after the review, so not shown in it): the open question "${Q_LATE}".`,
    ].join('\n'));

    // The reply showed it: a second confirmation clears it.
    const again = text(await confirm());
    expect(again).toContain('Cleared: 1 open question.');
    expect(stored.open_questions).toEqual([]);
  });

  it('a blocker changed and a command added after the review stay', async () => {
    await finish({});
    stored.blocking_issue = 'Waiting on legal to sign off the export format';
    stored.commands = [...stored.commands, { label: 'export', run: 'npm run export' }];
    version += 1;
    const out = text(await confirm());
    expect(stored.open_questions).toEqual([]);
    expect(stored.blocking_issue).toBe('Waiting on legal to sign off the export format');
    expect(stored.commands.map((c: any) => c.label)).toEqual(['export']);
    expect(out).toContain('Cleared: 2 open questions, 1 command log entry.');
    expect(out).toContain('Left as they were (added after the review, so not shown in it): the blocking issue "Waiting on legal to sign off the export format"; 1 command log entry.');
    // The task_completed event must not empty the log it just kept.
    expect(events.filter((e) => e.event_type === 'task_completed').map((e) => e.metadata.source)).toEqual(['cleanup_context']);
  });

  it('the race: a question that lands between this call\'s read and its write is re-read and kept', async () => {
    await finish({});
    beforeNextPatch = () => {
      stored.open_questions = [...stored.open_questions, Q_LATE];
      version += 1;
    };
    const out = text(await confirm());
    expect(patches).toHaveLength(2);
    expect(patches[0].expected_context_version).toBe(1);
    expect(patches[1].expected_context_version).toBe(2);
    expect(stored.open_questions).toEqual([Q_LATE]);
    expect(out).toContain(`the open question "${Q_LATE}"`);
  });

  it('a confirmation with no review in this process for this project is refused and clears nothing', async () => {
    const REFUSED = 'Nothing was cleared: this task has not been reviewed here. Call manage_memory with action "finish_task" and without confirm_complete to review what completing it would clear, then confirm with complete_task=true and confirm_complete=true.';
    // No review at all (as after a restart of the local server).
    let result: any = await confirm();
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(REFUSED);
    expect(patches).toHaveLength(0);
    expect(stored.open_questions).toEqual([Q1, Q2]);
    // A review of ANOTHER project is not a review of this one.
    await handleContextSyncTool('cleanup_context', { project_id: `${projectId}_other` }, client);
    result = await confirm();
    expect(result.isError).toBe(true);
    expect(patches).toHaveLength(0);
    // Reviewed, it goes through; a second confirmation has nothing reviewed left.
    await finish({});
    expect(text(await confirm())).toContain('Cleared: 2 open questions, the blocking issue, 1 command log entry.');
    result = await confirm();
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(REFUSED);
  });

  it('M1: a share that hides the blocker and the command log: never planned, never quoted, named by section', async () => {
    // What the server hands a teammate: the withheld fields are absent from
    // their view, and the view says which sections were withheld.
    delete stored.blocking_issue;
    delete stored.commands;
    stored.withheld_sections = ['blocking_issue', 'commands'];
    await finish({});
    const out = text(await confirm());
    expect(patches).toHaveLength(1);
    expect('blocking_issue' in patches[0]).toBe(false);
    expect('commands' in patches[0]).toBe(false);
    expect(stored.open_questions).toEqual([]);
    expect(out).toContain('Cleared: 2 open questions.');
    expect(out).toContain('Left as they were (not shared for editing with you): command log, blocker.');
    expect(out).not.toContain('added after the review');
  });
});
