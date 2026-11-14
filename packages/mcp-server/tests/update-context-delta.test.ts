import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DeerdawnClient } from '../src/client.js';
import { handleContextSyncTool } from '../src/tools/context-sync.js';

/**
 * update_context reported "no material changes extracted (summary may have been
 * too vague or already captured)" for writes that had in fact been applied.
 *
 * formatDelta inspected seven of the delta's twenty-nine fields. A summary that
 * extracted into `shipped`, `next_action`, `landmines`, `hot_paths`, or
 * `debugging_notes` produced zero lines and hit the empty-delta branch. So the
 * write succeeded, the brief grew, and the tool told the caller nothing happened
 * and blamed their wording — which invites an agent to rewrite a summary that
 * worked, and reads to a user as the product ignoring them.
 *
 * These tests assert against fields OUTSIDE the original seven, since those are
 * the ones that were silently unreported.
 */

let server: http.Server;
let client: DeerdawnClient;
let nextDelta: Record<string, unknown> = {};
/** update_context ALSO fires a decision_made event; these let us exercise it. */
let eventsFail = false;
let eventsQueue = false;
/**
 * The brief's headline, as the server would hold it. Extraction NEVER sets this
 * field — summaries opening literally "Current task is now: X" came back "task,
 * status and stack are unchanged" — so the task now has a direct PATCH path and
 * this fake has to model it to test that.
 */
let currentTask = 'the task that will not die';
/** Simulates a PATCH that 200s having changed nothing. */
let swallowTaskPatch = false;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const send = (body: any) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      // Direct task write + the read-back that verifies it.
      if (req.method === 'PATCH' && req.url?.includes('/context')) {
        const patch = JSON.parse(body || '{}');
        if (patch.current_task !== undefined && !swallowTaskPatch) currentTask = patch.current_task;
        return send({ ok: true });
      }
      // Extraction applies its delta the way the server does: a spread over the
      // current context, so a delta carrying current_task OVERWRITES.
      if (req.url?.includes('/extraction') && (nextDelta as any).current_task) {
        currentTask = String((nextDelta as any).current_task);
      }
      if (req.url?.includes('/active') || req.url?.includes('/inject')) {
        return send({
          context: {
            project_id: 'project_test',
            project_name: 'Test Project',
            current_task: currentTask,
            todo_items: [],
            completed_todos: [],
          },
        });
      }
      if (req.url?.includes('/extraction')) {
        return send({
          project: { project_id: 'project_test', project_name: 'Test Project' },
          extraction: { delta: nextDelta },
        });
      }
      if (req.url?.includes('/events') && eventsQueue) {
        res.writeHead(503, { 'content-type': 'application/json' });
        return res.end('{}');
      }
      if (req.url?.includes('/events') && eventsFail) {
        // 4xx, deliberately. recordContextEvent QUEUES 5xx/network failures for
        // durable retry and resolves, so a 500 is not a lost write — only a
        // client error is genuinely dropped.
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end('{"error":"bad_request"}');
      }
      send({ ok: true });
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
  currentTask = 'the task that will not die';
  swallowTaskPatch = false;
});

afterAll(() => server?.close());

async function update(delta: Record<string, unknown>): Promise<string> {
  nextDelta = delta;
  const r = await handleContextSyncTool(
    'update_context',
    { project_id: 'project_test', summary: 'Shipped the thing.' },
    client,
  );
  return String(r?.content?.[0]?.text ?? '');
}

const NOT_REPORTED = /no material changes|empty delta|Nothing was written/;

describe('update_context delta reporting', () => {
  it('reports the fields it always reported', async () => {
    const out = await update({ current_task: 'Ship the card', tech_stack: ['TypeScript'] });
    expect(out).toContain('Task → "Ship the card"');
    expect(out).not.toMatch(NOT_REPORTED);
  });

  // Each of these landed in the brief but produced "no material changes".
  const previouslyInvisible: Array<[string, unknown, RegExp]> = [
    ['shipped', [{ summary: 'Shipped PR #258' }], /Shipped PR #258/],
    ['next_action', 'Tag v1.0.39', /Next action → "Tag v1\.0\.39"/],
    ['landmines', [{ summary: 'Tool names are a published contract' }], /published contract/],
    ['debugging_notes', [{ summary: 'formatDelta under-reports' }], /under-reports/],
    ['hot_paths', [{ label: 'card', path: 'src/briefCard.js' }], /card → src\/briefCard\.js/],
    ['open_questions', ['Publish to npm tonight?'], /Publish to npm tonight\?/],
    ['blocking_issue', 'CI is red', /Blocking → "CI is red"/],
    ['description', 'AI session memory', /Description → "AI session memory"/],
    ['commands', [{ label: 'test', run: 'npm test' }], /test → npm test/],
    ['task_steps', [{ name: 'Write the tests' }], /Write the tests/],
  ];

  for (const [field, value, expected] of previouslyInvisible) {
    it(`reports "${field}" instead of claiming nothing changed`, async () => {
      const out = await update({ [field]: value });
      expect(out).not.toMatch(NOT_REPORTED);
      expect(out).toMatch(expected);
    });
  }

  it('names items in a short list and counts a long one', async () => {
    const three = await update({ recent_decisions: [{ summary: 'A' }, { summary: 'B' }, { summary: 'C' }] });
    expect(three).toContain('Decision: A');

    const many = await update({ recent_decisions: Array.from({ length: 7 }, (_, i) => ({ summary: `D${i}` })) });
    expect(many).toContain('7 decisions updated');
  });

  it('reports an unlabelled field rather than dropping it', async () => {
    // The regression guard: a new ContextDeltaSchema field must never be
    // invisible just because nobody added a label for it here.
    const out = await update({ some_future_field: ['a', 'b'] });
    expect(out).not.toMatch(NOT_REPORTED);
    expect(out).toContain('some_future_field');
  });

  it('reports the recorded decision when extraction returns an empty delta', async () => {
    // THE SECOND HALF OF THE BUG. update_context does TWO writes: extraction, and
    // a decision_made event carrying the summary verbatim. An empty delta is
    // normal and the event still lands — so "nothing was added to the brief" was
    // false, just less obviously than "too vague" was. Caught against real prod
    // data: the decision appeared in recent_decisions while the tool denied it.
    const out = await update({});
    expect(out).toMatch(/Decision recorded/);
    expect(out).toContain('Shipped the thing.');
    expect(out).not.toMatch(/too vague/);
    expect(out).not.toMatch(/Nothing was written/);
    expect(out).toContain('all connected tools');
  });

  it('treats a queued event as recorded, since the queue delivers it', async () => {
    // A 5xx is retried from a durable on-disk queue, so the write is not lost and
    // must not be reported as one.
    eventsQueue = true;
    try {
      expect(await update({})).toMatch(/Decision recorded/);
    } finally { eventsQueue = false; }
  });

  it('says nothing was written only when BOTH writes fail', async () => {
    eventsFail = true;
    try {
      const out = await update({});
      expect(out).toMatch(/Nothing was written/);
      expect(out).not.toContain('all connected tools');
    } finally { eventsFail = false; }
  });

  it('does not treat empty-valued fields as delta changes', async () => {
    const out = await update({ current_task: '', goals: [], recent_decisions: [] });
    expect(out).toMatch(/Decision recorded/);
  });

  it('confirms cross-tool propagation only when something actually changed', async () => {
    // hasMaterial used to sniff formatDelta's prose for a magic substring, so any
    // reword of the message silently flipped this behaviour.
    expect(await update({ shipped: [{ summary: 'x' }] })).toContain('all connected tools');
    eventsFail = true;
    try {
      expect(await update({})).not.toContain('all connected tools');
    } finally { eventsFail = false; }
  });
});


/**
 * The task field could not be set at all (2026-08-29).
 *
 * update_context routed everything through server-side extraction, and
 * extraction never wrote `current_task`. Two calls whose summary opened
 * "Current task is now: merge growth PR #342" both returned "task, status and
 * stack are unchanged", and the brief still headlined a task finished days
 * earlier. The only way to clear it was finish_task, which also discards the
 * open questions and command log attached to the task — so it went unused and
 * every brief's most-read line rotted.
 */
describe('update_context: the task has a direct write path', () => {
  const call = async (args: Record<string, unknown>) => {
    nextDelta = {};
    const r = await handleContextSyncTool('update_context', { project_id: 'project_test', ...args }, client);
    return String((r as any)?.content?.[0]?.text ?? '');
  };

  it('sets the task without going through extraction', async () => {
    const out = await call({ task: 'Fix the Done-column cap' });
    expect(currentTask).toBe('Fix the Done-column cap');
    expect(out).toContain('Current task → "Fix the Done-column cap"');
  });

  it('accepts a task with no summary at all', async () => {
    // Requiring a summary would push callers straight back onto the extraction
    // path that cannot set this field.
    const out = await call({ task: 'Ship the read-back guard' });
    expect(currentTask).toBe('Ship the read-back guard');
    expect(out).not.toContain('requires a non-empty summary');
  });

  it('names the project on a task-only call', async () => {
    // A task-only call skips extraction, so it has no result to take the name
    // from and the header used to render as: Updated "":
    const out = await call({ task: 'Name the project properly' });
    expect(out).toContain('Updated "Test Project"');
    expect(out).not.toContain('Updated ""');
  });

  it('sets the task and records the summary in the same call', async () => {
    nextDelta = {};
    const r = await handleContextSyncTool(
      'update_context',
      { project_id: 'project_test', summary: 'Landed the trim fix.', task: 'Write the regression tests' },
      client,
    );
    const out = String((r as any)?.content?.[0]?.text ?? '');
    expect(currentTask).toBe('Write the regression tests');
    expect(out).toContain('Current task → "Write the regression tests"');
    expect(out).toContain('Decision recorded');
  });

  it('reports a task write that did not take, instead of claiming success', async () => {
    swallowTaskPatch = true;
    const out = await call({ task: 'this will not stick' });
    expect(out).toContain('Current task NOT changed');
    expect(out).toContain('the task that will not die');
    expect(out).not.toContain('Current task → "this will not stick"');
  });

  it('catches a dropped write even when the task was previously empty', async () => {
    // Gating the comparison on a truthy live value meant a project with no task
    // yet reported success for a PATCH that changed nothing.
    currentTask = '';
    swallowTaskPatch = true;
    const out = await call({ task: 'first task this project ever had' });
    expect(out).toContain('Current task NOT changed');
    expect(out).toContain('(empty)');
  });

  it('an explicit task beats one extraction inferred from the same call', async () => {
    // The server merge is `{ ...current, ...delta }`. Writing the task BEFORE
    // extraction let an inferred current_task silently replace the instructed
    // one — and the read-back, also running before extraction, confirmed a value
    // that was about to be discarded.
    nextDelta = { current_task: 'something extraction guessed' };
    const r = await handleContextSyncTool(
      'update_context',
      { project_id: 'project_test', summary: 'Landed the ordering fix.', task: 'the task I actually asked for' },
      client,
    );
    const out = String((r as any)?.content?.[0]?.text ?? '');
    expect(currentTask).toBe('the task I actually asked for');
    expect(out).toContain('Current task → "the task I actually asked for"');
  });

  it('still refuses a call carrying neither a summary nor a task', async () => {
    const r = await handleContextSyncTool('update_context', { project_id: 'project_test' }, client);
    const text = String((r as any)?.content?.[0]?.text ?? '');
    // The refusal is what matters; its wording moved when these replies stopped
    // naming update_context, which a caller cannot see in tools/list.
    expect(text).toContain('non-empty summary');
    expect(text).toContain('manage_memory');
  });
});
