import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DeerdawnClient } from '../src/client.js';
import { handleContextSyncTool, taskLandedRedacted, NO_TASK_TO_COMPLETE } from '../src/tools/context-sync.js';

/**
 * Scan 14, HONEST REPLIES — the local dispatcher's half.
 *
 * 1. A task the server stores REDACTED (a key in it masked) was reported
 *    "⚠ Current task NOT changed — the brief still reads …" although the write
 *    had landed: the read-back was compared with the literal task. That reads
 *    as a failed write and invites the model to retry it, forever.
 * 2. finish_task with NO current task posted a task_completed event with the
 *    invented summary "Task completed in <project>", which the API files as a
 *    shipped item at confidence 1 and the next catch-up reports as done work.
 * 3. The update reply printed the extraction delta — the model's rewrite of a
 *    summary — so "Goal: … ghp_…" came back in clear although the summary had
 *    been masked and the brief stored the goal masked.
 *
 * The fake API below models the REAL storage behaviour: every write is passed
 * through the same masking the store applies, and a NEW API answers the PATCH
 * with the stored value and `redacted: true`, while an OLD API answers with the
 * unredacted in-memory object and no flag.
 */

// A real-shaped GitHub PAT: a true positive for every pattern version, before
// or after the over-broad kebab-case patterns are narrowed.
const GHP = `ghp_${'A1b2C3d4E5f6G7h8I9j0'.repeat(2).slice(0, 36)}`;
const mask = (s: string) => s.replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED]');

let stored: Record<string, any>;
let apiMode: 'new' | 'old' | 'drop' = 'new';
let nextDelta: Record<string, unknown> = {};
const events: any[] = [];
let resolveBodies: any[] = [];

let server: http.Server;
let client: DeerdawnClient;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const send = (body: any, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      if (req.method === 'PATCH' && req.url?.includes('/context')) {
        if (apiMode === 'drop') return send({ project: { project_name: stored.project_name, context: stored } });
        const submitted = { ...stored, ...parsed };
        const masked: Record<string, any> = {};
        for (const [k, v] of Object.entries(submitted)) masked[k] = typeof v === 'string' ? mask(v) : v;
        stored = masked;
        const changed = Object.keys(parsed).filter((k) => typeof parsed[k] === 'string' && mask(parsed[k]) !== parsed[k]);
        if (apiMode === 'old') return send({ project: { project_name: stored.project_name, context: submitted } });
        return send({
          project: { project_name: stored.project_name, context: stored },
          ...(changed.length ? { redacted: true, redacted_fields: changed } : {}),
        });
      }
      if (req.url?.includes('/extraction')) {
        // The model's rewrite, relayed raw — what an API that predates relaying
        // the delta as stored sends back.
        return send({
          project: { project_id: 'project_test', project_name: 'Test Project' },
          extraction: { delta: nextDelta },
          stored: true,
        });
      }
      if (req.url?.includes('/questions/resolve')) {
        resolveBodies.push(parsed);
        return send({ error: 'question_not_found', message: 'No open question matches.' }, 404);
      }
      if (req.url?.includes('/events')) {
        events.push(parsed);
        return send({ ok: true });
      }
      if (req.url?.includes('/inject') || req.url?.startsWith('/api/v1/context/active')) {
        return send({ context: stored });
      }
      return send({}, 404);
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
  apiMode = 'new';
  nextDelta = {};
  events.length = 0;
  resolveBodies = [];
  stored = {
    project_id: 'project_test',
    project_name: 'Test Project',
    current_task: 'The previous task',
    current_status: 'working',
    open_questions: [`Is [REDACTED] revoked yet?`],
    commands: [],
    blocking_issue: '',
  };
});

afterAll(() => server?.close());

const text = (r: any) => String(r?.content?.[0]?.text ?? '');
const setTask = (task: string) => handleContextSyncTool('update_context', { project_id: 'project_test', task }, client).then(text);

describe('#1 a task stored redacted is reported written, not "NOT changed"', () => {
  const TASK = `Rotate the leaked token ${GHP} today`;

  it('new API: uses the stored value and the redacted flag', async () => {
    const out = await setTask(TASK);
    expect(stored.current_task).toBe('Rotate the leaked token [REDACTED] today');
    expect(out).not.toContain('NOT changed');
    expect(out).toContain('written, with sensitive text redacted');
    expect(out).toContain('"Rotate the leaked token [REDACTED] today"');
    expect(out).not.toContain(GHP);
    expect(out).toContain('Saved');
  });

  it('old API (no flag, unredacted echo): falls back to a marker-tolerant read-back', async () => {
    apiMode = 'old';
    const out = await setTask(TASK);
    expect(out).not.toContain('NOT changed');
    expect(out).toContain('written, with sensitive text redacted');
    expect(out).not.toContain(GHP);
  });

  it('a genuinely dropped write is still reported NOT changed', async () => {
    apiMode = 'drop';
    const out = await setTask(TASK);
    expect(out).toContain('Current task NOT changed');
    expect(out).toContain('The previous task');
    expect(out).not.toContain(GHP);
  });

  it('ordinary text stored verbatim is reported verbatim', async () => {
    const out = await setTask('Ship the risk-assessment-framework-v2');
    expect(out).toContain('Current task → "Ship the risk-assessment-framework-v2"');
    expect(out).not.toContain('redacted');
  });

  it('taskLandedRedacted matches only a masked rendering of what was sent', () => {
    expect(taskLandedRedacted(`a ${GHP} b`, 'a [REDACTED] b')).toBe(true);
    expect(taskLandedRedacted('a b', 'a b')).toBe(false);
    expect(taskLandedRedacted(`a ${GHP} b`, 'The previous task')).toBe(false);
    expect(taskLandedRedacted(`x ${GHP} b`, 'a [REDACTED] b')).toBe(false);
    // Regex metacharacters in the stored text are literal.
    expect(taskLandedRedacted(`fix (a+b) ${GHP}`, 'fix (a+b) [REDACTED]')).toBe(true);
  });
});

describe('#2 finish_task with no current task invents nothing', () => {
  it('posts no task_completed event and says no task was set', async () => {
    stored.current_task = '';
    // Journey r4: a confirmation follows its review (the owner's decision).
    await handleContextSyncTool('cleanup_context', { project_id: 'project_test' }, client);
    const out = text(await handleContextSyncTool('cleanup_context', { project_id: 'project_test', complete_task: true, confirm_complete: true }, client));
    expect(events.filter((e) => e.event_type === 'task_completed')).toHaveLength(0);
    expect(out).toContain(NO_TASK_TO_COMPLETE);
    expect(out).not.toContain('Task marked as completed');
    expect(out).toContain('Cleanup complete for Test Project.');
  });

  it('a real task still records exactly one task_completed with its own text', async () => {
    stored.current_task = 'Ship the importer';
    // Journey r4: a confirmation follows its review (the owner's decision).
    await handleContextSyncTool('cleanup_context', { project_id: 'project_test' }, client);
    await handleContextSyncTool('cleanup_context', { project_id: 'project_test', complete_task: true, confirm_complete: true }, client);
    const done = events.filter((e) => e.event_type === 'task_completed');
    expect(done).toHaveLength(1);
    expect(done[0].summary).toBe('Ship the importer');
  });
});

describe('#3 replies never quote a credential the brief holds masked', () => {
  it('the update reply masks the relayed extraction delta', async () => {
    nextDelta = { goals: [`Local goal ${GHP}`] };
    const out = text(await handleContextSyncTool('update_context', { project_id: 'project_test', summary: `Pasted ${GHP} for rotation` }, client));
    expect(out).toContain('Local goal [REDACTED]');
    expect(out).not.toContain(GHP);
  });

  it('resolve_question sends the question as typed but never quotes it back in clear', async () => {
    const question = `Is ${GHP} revoked yet?`;
    const out = text(await handleContextSyncTool('resolve_open_question', { project_id: 'project_test', question, answer: 'Yes' }, client));
    expect(resolveBodies[0]?.question).toBe(question);
    expect(out).toContain('No open question matches "Is [REDACTED] revoked yet?"');
    expect(out).not.toContain(GHP);
  });
});
