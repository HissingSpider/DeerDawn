import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_EXTRACTION_BODY_BYTES,
  EXTRACTION_BODY_BUDGET_BYTES,
} from '../../shared-context/src/index.js';

/**
 * A long session's Stop-hook flush VANISHED.
 *
 * flush-session posts the whole transcript to /api/v1/context/extraction in one
 * body. Past the JSON body limit express refuses it with a 413, which the retry
 * loop classifies as "not retryable", prints on stderr — a stream nobody reads —
 * and returns. The end of a long session, the session most worth keeping, was
 * exactly the one that silently kept nothing.
 *
 * Two halves are tested here: the body is trimmed to fit before it is sent, and
 * a flush that does not land leaves a mark the next session shows.
 */

const TOUCHED_ENV = [
  'HOME', 'DEERDAWN_API_URL', 'CLAUDE_SESSION_ID', 'CLAUDE_PROJECT_DIR', 'CLAUDE_TRANSCRIPT_PATH',
] as const;
const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const key of TOUCHED_ENV) ORIGINAL_ENV[key] = process.env[key];

function makeTranscript(file: string, messages: number) {
  const lines: string[] = [];
  for (let i = 0; i < messages; i++) {
    lines.push(JSON.stringify({
      type: i % 2 === 0 ? 'user' : 'assistant',
      cwd: '/tmp/atlas',
      message: { content: [{ type: 'text', text: `message ${i} ${'x'.repeat(1500)}` }] },
    }));
  }
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
}

describe('flush-session oversize transcripts', () => {
  let home: string;
  let sent: string[];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-flush-'));
    fs.mkdirSync(path.join(home, '.deerdawn'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.deerdawn', 'credentials.json'),
      JSON.stringify({ api_key: 'dd_test_key' }),
      'utf8',
    );
    process.env.HOME = home;
    process.env.DEERDAWN_API_URL = 'https://api.test.invalid';
    process.env.CLAUDE_SESSION_ID = 'sess-1';
    process.env.CLAUDE_PROJECT_DIR = home;
    sent = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of TOUCHED_ENV) {
      if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL_ENV[key];
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function loadFlush() {
    vi.resetModules();
    return import('../src/flush-session.js');
  }

  function stubFetch(response: { ok: boolean; status: number }) {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      sent.push(String(init.body));
      return {
        ok: response.ok,
        status: response.status,
        json: async () => ({ project: { project_name: 'Atlas' } }),
        text: async () => JSON.stringify({ error: 'payload_too_large', message: 'Request body is too large' }),
      } as any;
    }));
  }

  it('keeps its own budget under the server limit', () => {
    expect(EXTRACTION_BODY_BUDGET_BYTES).toBeLessThan(MAX_EXTRACTION_BODY_BYTES);
  });

  it('trims an oversize transcript to fit instead of letting the flush be refused', async () => {
    const transcript = path.join(home, 'session.jsonl');
    makeTranscript(transcript, 400); // ~600KB of message text, well past the cap
    process.env.CLAUDE_TRANSCRIPT_PATH = transcript;
    stubFetch({ ok: true, status: 200 });

    const { flushSession } = await loadFlush();
    await flushSession();

    expect(sent).toHaveLength(1);
    const body = sent[0];
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(MAX_EXTRACTION_BODY_BYTES);

    const parsed = JSON.parse(body);
    expect(parsed.chunks.length).toBeGreaterThan(0);
    expect(parsed.chunks.length).toBeLessThan(400);
    // The omission is stated in what was sent — a trimmed flush must not read
    // like a complete one.
    const note = parsed.chunks.map((c: any) => c.text).join('\n');
    expect(note).toMatch(/truncat/i);
    // The END of the session is what survives: the last message is still there.
    expect(note).toContain('message 399');
    // ~2s alone (600KB redacted and re-serialised per fit attempt); it crossed the
    // 5s default when the whole suite ran in parallel on a busy machine.
  }, 20_000);

  it('sends a short transcript untouched, with no truncation note', async () => {
    const transcript = path.join(home, 'session.jsonl');
    makeTranscript(transcript, 6);
    process.env.CLAUDE_TRANSCRIPT_PATH = transcript;
    stubFetch({ ok: true, status: 200 });

    const { flushSession } = await loadFlush();
    await flushSession();

    const parsed = JSON.parse(sent[0]);
    expect(parsed.chunks).toHaveLength(6);
    expect(parsed.chunks.map((c: any) => c.text).join('\n')).not.toMatch(/truncat/i);
  });

  it('leaves a notice the next session can show when the flush does not land', async () => {
    const transcript = path.join(home, 'session.jsonl');
    makeTranscript(transcript, 6);
    process.env.CLAUDE_TRANSCRIPT_PATH = transcript;
    stubFetch({ ok: false, status: 413 });

    const { flushSession } = await loadFlush();
    await flushSession();

    const { consumeFlushNotice } = await import('../src/flush-notice.js');
    const notice = consumeFlushNotice();
    expect(notice, 'a dropped flush must leave a mark, not just a stderr line').toBeTruthy();
    expect(notice).toMatch(/413/);
    expect(notice).toMatch(/not saved|did not|was not/i);

    // Consumed once — a stale warning every session is its own kind of noise.
    expect(consumeFlushNotice()).toBeNull();
  });

  it('clears a previous failure notice once a flush lands', async () => {
    const transcript = path.join(home, 'session.jsonl');
    makeTranscript(transcript, 6);
    process.env.CLAUDE_TRANSCRIPT_PATH = transcript;

    stubFetch({ ok: false, status: 400 });
    const { flushSession } = await loadFlush();
    await flushSession();

    const notice = await import('../src/flush-notice.js');
    expect(notice.readFlushNotice()).toBeTruthy();

    stubFetch({ ok: true, status: 200 });
    const { flushSession: flushAgain } = await loadFlush();
    await flushAgain();
    expect(notice.readFlushNotice()).toBeNull();
  });
});

/**
 * The other half of "never a silent drop": the Stop hook has no tool result to
 * fail into, so the failure has to reach the next thing that DOES have one.
 */
describe('start_session surfaces a dropped flush', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-notice-'));
    fs.mkdirSync(path.join(home, '.deerdawn'), { recursive: true });
    process.env.HOME = home;
    process.env.CLAUDE_PROJECT_DIR = home;
  });

  afterEach(() => {
    for (const key of TOUCHED_ENV) {
      if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL_ENV[key];
    }
    fs.rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('ignores a notice too old to still describe "the previous session"', async () => {
    vi.resetModules();
    const { recordFlushNotice, readFlushNotice } = await import('../src/flush-notice.js');
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    recordFlushNotice({ kind: 'failed', at: longAgo, status: 500, reason: 'outage' });
    expect(readFlushNotice()).toBeNull();
  });

  it('tells the agent the previous session was not saved, once', async () => {
    vi.resetModules();
    const { recordFlushNotice } = await import('../src/flush-notice.js');
    // A minute ago, not a fixed date: a notice older than 14 days is ignored by
    // design, so a hard-coded date turned this test red on 2026-10-01.
    recordFlushNotice({ kind: 'failed', at: new Date(Date.now() - 60_000).toISOString(), status: 413, reason: 'Request body is too large' });

    const { handleContextSyncTool } = await import('../src/tools/context-sync.js');
    const client = {
      flushQueuedContextWrites: vi.fn().mockResolvedValue(null),
      getActiveContextByCwd: vi.fn().mockResolvedValue({
        project_id: 'project_active',
        project_name: 'Atlas',
        brief: 'Current task: ship the queue.',
        last_updated: new Date().toISOString(),
      }),
      getContextMap: vi.fn().mockResolvedValue({ map: '[DeerDawn]\n- Atlas (project_active)' }),
      recordContextEvent: vi.fn().mockResolvedValue(null),
    };

    const first = await handleContextSyncTool('start_session', {}, client as any);
    const text = String(first.content?.[0]?.text || '');
    expect(text).toMatch(/NOT saved/);
    expect(text).toContain('413');
    // Still delivers the brief — a warning about the last session is not a
    // reason to withhold this one's context.
    expect(text).toContain('Resuming Atlas');

    const second = await handleContextSyncTool('start_session', {}, client as any);
    expect(String(second.content?.[0]?.text || '')).not.toMatch(/NOT saved/);
  });
});
