import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough, Readable } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Stop hook never flushed a Claude Code session, and when it did flush
 * something it must be the RIGHT session.
 *
 * Claude Code tells a hook which session it belongs to on the hook's STDIN — one
 * JSON object carrying `session_id`, `transcript_path` and `cwd`. It does not
 * export CLAUDE_SESSION_ID or CLAUDE_TRANSCRIPT_PATH. flush-session read only
 * those two env vars, found neither, and read that as "this must be Codex": every
 * Stop on every Claude Code install went down the Codex branch, which either
 * found no ~/.codex/sessions and did nothing, or found one and sent an unrelated
 * Codex conversation. The previous version of this file set CLAUDE_SESSION_ID by
 * hand before calling flushSession, which is the one thing a real hook never
 * does — so it passed while the feature was dead. Everything below drives the
 * flush the way the host does: a payload on stdin, and no session env at all.
 *
 * Still pinned from that file, because both were real and neither is covered
 * elsewhere:
 *   - the transcript directory is named by dashing the absolute path (not
 *     base64url), and a session id that matches nothing REFUSES rather than
 *     falling back to the newest transcript on the machine — a missed flush costs
 *     a session's notes, a wrong one files a stranger's conversation as yours;
 *   - redaction runs BEFORE the per-message slice, so a secret straddling the
 *     2000-character cut cannot survive as an unmatched half.
 */

const TOUCHED_ENV = [
  'HOME', 'DEERDAWN_API_URL', 'DEERDAWN_SURFACE_ID',
  'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PROJECT_DIR', 'CLAUDE_TRANSCRIPT_PATH',
] as const;
const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const key of TOUCHED_ENV) ORIGINAL_ENV[key] = process.env[key];

const SESSION = 'aaaaaaaa-1111-2222-3333-444444444444';
const CLI_ARGV = ['node', 'deerdawn-mcp', 'flush-session'];

function transcriptLine(text: string, i: number, cwd: string): string {
  return JSON.stringify({
    type: i % 2 === 0 ? 'user' : 'assistant',
    cwd,
    message: { content: [{ type: 'text', text }] },
  });
}

function writeTranscript(file: string, texts: string[], cwd: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, texts.map((t, i) => transcriptLine(t, i, cwd)).join('\n') + '\n', 'utf8');
}

function appendTranscript(file: string, texts: string[], cwd: string): void {
  fs.appendFileSync(file, texts.map((t, i) => transcriptLine(t, i, cwd)).join('\n') + '\n', 'utf8');
}

/** stdin exactly as Claude Code hands it to a Stop hook: one JSON object, then EOF. */
function stopHookStdin(payload: Record<string, unknown>): Readable {
  return Readable.from([Buffer.from(JSON.stringify({
    hook_event_name: 'Stop',
    stop_hook_active: false,
    permission_mode: 'default',
    ...payload,
  }))]);
}

describe('flush-session driven by the hook payload on stdin', () => {
  let home: string;
  let projectsDir: string;
  let projectDir: string;
  let transcript: string;
  let sent: Array<{ body: any; raw: string; init: any }>;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-hook-stdin-')));
    fs.mkdirSync(path.join(home, '.deerdawn'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.deerdawn', 'credentials.json'),
      JSON.stringify({ api_key: 'dd_test_key' }),
      'utf8',
    );
    projectsDir = path.join(home, '.claude', 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    projectDir = '/Users/me/Desktop/Atlas';
    transcript = path.join(projectsDir, '-Users-me-Desktop-Atlas', `${SESSION}.jsonl`);
    process.env.HOME = home;
    process.env.DEERDAWN_API_URL = 'https://api.test.invalid';
    // What a real hook process sees: no session env of any spelling.
    for (const key of ['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_TRANSCRIPT_PATH', 'CLAUDE_PROJECT_DIR', 'DEERDAWN_SURFACE_ID']) {
      delete process.env[key];
    }
    sent = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  function stubFetch(respond: () => { ok: boolean; status: number } = () => ({ ok: true, status: 200 })) {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      sent.push({ body: JSON.parse(String(init.body)), raw: String(init.body), init });
      return {
        ...respond(),
        json: async () => ({ project: { project_name: 'Atlas' } }),
        text: async () => '',
      } as any;
    }));
  }

  function writeRecentCodexSession(): void {
    const file = path.join(home, '.codex', 'sessions', '2026', '09', 'rollout-1.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const message = (role: string, text: string) => JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role, content: [{ type: 'input_text', text }] },
    });
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'session_meta', payload: { cwd: '/Users/me/Desktop/CodexProject' } }),
      message('user', 'a codex question that has nothing to do with Atlas'),
      message('assistant', 'a codex answer that has nothing to do with Atlas'),
    ].join('\n'), 'utf8');
  }

  describe('a Claude Code Stop hook', () => {
    it('flushes the transcript named on stdin, with no session env set', async () => {
      writeTranscript(transcript, ['we decided to use postgres for the queue', 'agreed, recording that decision'], projectDir);
      stubFetch();

      const { runFlushSessionCli } = await loadFlush();
      await runFlushSessionCli(CLI_ARGV, stopHookStdin({ session_id: SESSION, transcript_path: transcript, cwd: projectDir }));

      expect(sent, 'the Stop hook is the whole capture path — it has to send').toHaveLength(1);
      expect(sent[0].body.tool).toBe('claude_code');
      expect(sent[0].body.session_id).toBe(SESSION);
      expect(sent[0].body.session_context.conversation_ref).toBe(SESSION);
      expect(sent[0].body.session_context.cwd).toBe(projectDir);
      expect(sent[0].body.chunks.map((c: any) => c.text)).toEqual([
        'we decided to use postgres for the queue',
        'agreed, recording that decision',
      ]);
    });

    it('a Stop hook payload identifies the tool: no tool_identified:false on the capture', async () => {
      writeTranscript(transcript, ['we decided to use postgres for the queue', 'agreed, recording that decision'], projectDir);
      stubFetch();

      const { runFlushSessionCli } = await loadFlush();
      await runFlushSessionCli(CLI_ARGV, stopHookStdin({ session_id: SESSION, transcript_path: transcript, cwd: projectDir }));

      expect(sent[0].body.tool).toBe('claude_code');
      expect('tool_identified' in sent[0].body).toBe(false);
    });

    it('a flush with no hook payload and no identified tool says the tool is the default, like a save does', async () => {
      writeTranscript(transcript, ['we decided to use postgres for the queue', 'agreed, recording that decision'], projectDir);
      stubFetch();
      process.env.CLAUDE_SESSION_ID = SESSION;

      const { flushSession } = await loadFlush();
      await flushSession({ hookInput: null });

      expect(sent).toHaveLength(1);
      expect(sent[0].body.tool_identified).toBe(false);
    });

    it('finds the transcript from session_id alone when the payload carries no path', async () => {
      writeTranscript(transcript, ['first real message here', 'second real message here'], projectDir);
      stubFetch();

      const { runFlushSessionCli } = await loadFlush();
      await runFlushSessionCli(CLI_ARGV, stopHookStdin({ session_id: SESSION, cwd: projectDir }));

      expect(sent).toHaveLength(1);
      expect(sent[0].body.session_id).toBe(SESSION);
    });

    it('does not send a Codex session just because ~/.codex/sessions exists', async () => {
      // The machine has Codex too. On the old code this is what every Claude
      // Code Stop uploaded instead of its own transcript.
      writeRecentCodexSession();
      writeTranscript(transcript, ['the claude code conversation, turn one', 'the claude code reply, turn one'], projectDir);
      stubFetch();

      const { runFlushSessionCli } = await loadFlush();
      await runFlushSessionCli(CLI_ARGV, stopHookStdin({ session_id: SESSION, transcript_path: transcript, cwd: projectDir }));

      expect(sent).toHaveLength(1);
      expect(sent[0].body.tool).toBe('claude_code');
      expect(sent[0].raw).not.toContain('nothing to do with Atlas');
    });

    it('gives the request a timeout, so a hung API cannot hold the hook open', async () => {
      writeTranscript(transcript, ['first real message here', 'second real message here'], projectDir);
      stubFetch();

      const { runFlushSessionCli } = await loadFlush();
      await runFlushSessionCli(CLI_ARGV, stopHookStdin({ session_id: SESSION, transcript_path: transcript }));

      expect(sent[0].init.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('Stop fires every turn', () => {
    it('sends each turn once: nothing when unchanged, only the new messages after', async () => {
      const stdin = () => stopHookStdin({ session_id: SESSION, transcript_path: transcript, cwd: projectDir });
      writeTranscript(transcript, ['turn one question about the schema', 'turn one answer about the schema'], projectDir);
      stubFetch();

      const { runFlushSessionCli } = await loadFlush();
      await runFlushSessionCli(CLI_ARGV, stdin());
      expect(sent).toHaveLength(1);

      // A second Stop with nothing new (a turn that produced no transcript text).
      await runFlushSessionCli(CLI_ARGV, stdin());
      expect(sent, 'the same transcript must not be extracted twice').toHaveLength(1);

      appendTranscript(transcript, ['turn two question about the index', 'turn two answer about the index'], projectDir);
      await runFlushSessionCli(CLI_ARGV, stdin());
      expect(sent).toHaveLength(2);
      expect(sent[1].body.chunks.map((c: any) => c.text)).toEqual([
        'turn two question about the index',
        'turn two answer about the index',
      ]);
    });

    it('does not count a half-written last line as flushed', async () => {
      const stdin = () => stopHookStdin({ session_id: SESSION, transcript_path: transcript, cwd: projectDir });
      writeTranscript(transcript, ['turn one question about the schema', 'turn one answer about the schema'], projectDir);
      // Claude Code is mid-append when the hook reads the file.
      const whole = transcriptLine('turn two question, still being written', 0, projectDir);
      fs.appendFileSync(transcript, whole.slice(0, 40), 'utf8');
      stubFetch();

      const { runFlushSessionCli } = await loadFlush();
      await runFlushSessionCli(CLI_ARGV, stdin());
      fs.appendFileSync(transcript, `${whole.slice(40)}\n${transcriptLine('turn two answer, complete', 1, projectDir)}\n`, 'utf8');
      await runFlushSessionCli(CLI_ARGV, stdin());

      expect(sent).toHaveLength(2);
      expect(sent[1].body.chunks.map((c: any) => c.text)).toEqual([
        'turn two question, still being written',
        'turn two answer, complete',
      ]);
    });

    it('re-sends a turn whose flush was refused', async () => {
      const stdin = () => stopHookStdin({ session_id: SESSION, transcript_path: transcript, cwd: projectDir });
      writeTranscript(transcript, ['a question that must not be lost', 'an answer that must not be lost'], projectDir);
      let ok = false;
      stubFetch(() => (ok ? { ok: true, status: 200 } : { ok: false, status: 401 }));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const { runFlushSessionCli } = await loadFlush();
      await runFlushSessionCli(CLI_ARGV, stdin());
      ok = true;
      await runFlushSessionCli(CLI_ARGV, stdin());

      expect(sent).toHaveLength(2);
      expect(sent[1].body.chunks.map((c: any) => c.text)).toContain('a question that must not be lost');
    });

    it('keeps one session’s mark from hiding another session’s transcript', async () => {
      const otherSession = 'bbbbbbbb-1111-2222-3333-444444444444';
      const otherTranscript = path.join(projectsDir, '-Users-me-Desktop-Atlas', `${otherSession}.jsonl`);
      writeTranscript(transcript, ['session A question goes here', 'session A answer goes here'], projectDir);
      writeTranscript(otherTranscript, ['session B question goes here', 'session B answer goes here'], projectDir);
      stubFetch();

      const { runFlushSessionCli } = await loadFlush();
      await runFlushSessionCli(CLI_ARGV, stopHookStdin({ session_id: SESSION, transcript_path: transcript }));
      await runFlushSessionCli(CLI_ARGV, stopHookStdin({ session_id: otherSession, transcript_path: otherTranscript }));

      expect(sent).toHaveLength(2);
      expect(sent[1].body.session_id).toBe(otherSession);
    });
  });

  describe('Codex', () => {
    it('flushes the Codex session when asked for with --codex', async () => {
      writeRecentCodexSession();
      stubFetch();

      const { runFlushSessionCli } = await loadFlush();
      // No stdin payload: Codex has no hook, this is a shell alias.
      await runFlushSessionCli([...CLI_ARGV, '--codex'], Readable.from([]));

      expect(sent).toHaveLength(1);
      expect(sent[0].body.tool).toBe('codex');
      expect(sent[0].body.session_context.cwd).toBe('/Users/me/Desktop/CodexProject');
    });

    it('sends nothing without --codex when no Claude Code session was named', async () => {
      writeRecentCodexSession();
      stubFetch();
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { runFlushSessionCli } = await loadFlush();
      await runFlushSessionCli(CLI_ARGV, Readable.from([]));

      expect(sent).toHaveLength(0);
      // Somebody with an old alias needs to be told what changed.
      expect(stderr.mock.calls.flat().join(' ')).toContain('--codex');
    });

    it('flushes Codex on shutdown of a server whose host is Codex, without reading stdin', async () => {
      writeRecentCodexSession();
      stubFetch();

      const { flushSession } = await loadFlush();
      await flushSession({ codex: true });

      expect(sent).toHaveLength(1);
      expect(sent[0].body.tool).toBe('codex');
    });
  });

  describe('stdin that is not a hook payload', () => {
    it('swallows garbage instead of throwing', async () => {
      const { readHookInput } = await loadFlush();
      await expect(readHookInput(Readable.from([Buffer.from('not json {')]))).resolves.toBeNull();
      await expect(readHookInput(Readable.from([Buffer.from('[1,2,3]')]))).resolves.toBeNull();
      await expect(readHookInput(Readable.from([]))).resolves.toBeNull();
    });

    it('gives up on a pipe nobody closes', async () => {
      const { readHookInput } = await loadFlush();
      const open = new PassThrough();
      const started = Date.now();
      await expect(readHookInput(open, 50)).resolves.toBeNull();
      expect(Date.now() - started).toBeLessThan(1000);
      open.destroy();
    });

    it('does not read a terminal', async () => {
      const { readHookInput } = await loadFlush();
      const tty = Object.assign(new PassThrough(), { isTTY: true });
      const onData = vi.spyOn(tty, 'on');
      await expect(readHookInput(tty)).resolves.toBeNull();
      expect(onData).not.toHaveBeenCalled();
    });
  });

  describe('a caller that sets the env by hand', () => {
    it('still works through CLAUDE_CODE_SESSION_ID when there is no payload', async () => {
      writeTranscript(transcript, ['first real message here', 'second real message here'], projectDir);
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;
      process.env.CLAUDE_PROJECT_DIR = projectDir;
      stubFetch();

      const { flushSession } = await loadFlush();
      await flushSession();

      expect(sent).toHaveLength(1);
      expect(sent[0].body.session_id).toBe(SESSION);
    });
  });

  describe('project directory naming', () => {
    it('encodes a path the way Claude Code actually writes it', async () => {
      const { encodeProjectPath } = await loadFlush();
      // Observed on disk: every non-alphanumeric character becomes a dash, and
      // case is preserved. A dotted segment produces the doubled dash that a
      // worktree path shows (`/…/DeerDawn/.claude-worktrees/x`).
      expect(encodeProjectPath('/Users/me/Desktop/DeerDawn'))
        .toBe('-Users-me-Desktop-DeerDawn');
      expect(encodeProjectPath('/Users/me/Desktop/DeerDawn/.claude-worktrees/festive-yalow-889319'))
        .toBe('-Users-me-Desktop-DeerDawn--claude-worktrees-festive-yalow-889319');
      expect(encodeProjectPath('/Users/me/my_project'))
        .toBe('-Users-me-my-project');
    });

    it('finds this session transcript in the directory Claude Code wrote it to', async () => {
      const { findSessionFile } = await loadFlush();
      writeTranscript(transcript, ['mine one', 'mine two'], projectDir);
      expect(findSessionFile(SESSION, projectDir)).toBe(transcript);
    });
  });

  describe('refusing to guess', () => {
    const otherTexts = [
      'their private conversation about something confidential',
      'and the reply to it, which is also long enough not to be trivial',
    ];

    it('never falls back to the newest transcript of another project', async () => {
      const { findSessionFile } = await loadFlush();
      // Somebody else's session, in a different project, written LAST — exactly
      // what the newest-across-all-projects fallback used to return.
      const other = path.join(projectsDir, '-Users-me-Desktop-Someone-Else', 'ffffffff-9999-8888-7777-666666666666.jsonl');
      writeTranscript(other, otherTexts, '/Users/me/Desktop/Someone-Else');

      expect(
        findSessionFile(SESSION, projectDir),
        'no transcript for this session id exists, so there is nothing to send',
      ).toBeNull();
    });

    it('sends nothing when the session named on stdin has no transcript', async () => {
      const other = path.join(projectsDir, '-Users-me-Desktop-Someone-Else', 'ffffffff-9999-8888-7777-666666666666.jsonl');
      writeTranscript(other, otherTexts, '/Users/me/Desktop/Someone-Else');
      stubFetch();
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const { runFlushSessionCli } = await loadFlush();
      await runFlushSessionCli(CLI_ARGV, stopHookStdin({
        session_id: SESSION,
        transcript_path: path.join(projectsDir, '-Users-me-Desktop-Atlas', 'gone.jsonl'),
        cwd: projectDir,
      }));

      expect(sent, 'capturing the wrong session is worse than capturing nothing').toHaveLength(0);
    });

    it('still finds the transcript when the project directory name does not line up', async () => {
      // A host whose project dir is a parent (or a symlinked spelling) of the
      // directory the transcript landed in. The session id is a uuid and
      // identifies the conversation on its own, so an exact id match elsewhere
      // is a find, not a guess.
      const { findSessionFile } = await loadFlush();
      const mine = path.join(projectsDir, '-private-var-folders-Atlas', `${SESSION}.jsonl`);
      writeTranscript(mine, ['mine'], projectDir);
      const other = path.join(projectsDir, '-Users-me-Desktop-Someone-Else', 'ffffffff-9999-8888-7777-666666666666.jsonl');
      writeTranscript(other, ['theirs'], '/Users/me/Desktop/Someone-Else');

      expect(findSessionFile(SESSION, projectDir)).toBe(mine);
    });
  });

  describe('redaction runs before the slice', () => {
    it('does not let a secret survive by straddling the per-message cut', async () => {
      // A real-shaped Anthropic key positioned so the 2000-char message cut
      // lands in the MIDDLE of it. Sliced first, the leading half matches no
      // pattern and goes out in clear text.
      const secret = 'sk-ant-api03-' + 'A'.repeat(60);
      const prefixLen = 2000 - Math.floor(secret.length / 2);
      const straddling = 'x'.repeat(prefixLen) + secret + ' trailing words';
      writeTranscript(transcript, [straddling, 'a reply long enough not to count as trivial'], projectDir);
      stubFetch();

      const { runFlushSessionCli } = await loadFlush();
      await runFlushSessionCli(CLI_ARGV, stopHookStdin({ session_id: SESSION, transcript_path: transcript, cwd: projectDir }));

      expect(sent).toHaveLength(1);
      expect(sent[0].raw).not.toContain('sk-ant-api03-');
      expect(sent[0].raw).not.toContain(secret.slice(0, 30));
      expect(sent[0].raw).toContain('[REDACTED]');
    });
  });

  // Real Claude Code transcripts store a TYPED prompt as a plain string; only
  // tool results and pasted images are block arrays. The shapes below are the
  // real ones — top-level keys and `message` keys copied from a live
  // ~/.claude/projects transcript, with invented text. The parser used to
  // require an array, so every typed prompt was dropped: a session flushed the
  // assistant's half alone, and a one-reply session sent nothing at all.
  describe('the real transcript shape: a typed prompt is a string', () => {
    const base = (cwd: string) => ({
      parentUuid: null, isSidechain: false, userType: 'external', cwd,
      sessionId: SESSION, version: '2.1.0', gitBranch: 'main', timestamp: '2026-09-22T10:00:00.000Z',
    });
    const typedPrompt = (text: string, cwd: string) => JSON.stringify({
      ...base(cwd), type: 'user', uuid: 'u-1', promptId: 'p-1', permissionMode: 'default',
      message: { role: 'user', content: text },
    });
    const assistantReply = (text: string, cwd: string) => JSON.stringify({
      ...base(cwd), type: 'assistant', uuid: 'a-1', requestId: 'req_1',
      message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn' },
    });
    const toolResult = (cwd: string) => JSON.stringify({
      ...base(cwd), type: 'user', uuid: 'u-2', toolUseResult: { stdout: 'ok' }, sourceToolAssistantUUID: 'a-0',
      message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'tool output that is not a prompt' }] },
    });
    const hostEntry = (content: string, cwd: string, extra: Record<string, unknown> = {}) => JSON.stringify({
      ...base(cwd), type: 'user', uuid: 'u-3', message: { role: 'user', content }, ...extra,
    });

    function writeLines(lines: string[]) {
      fs.mkdirSync(path.dirname(transcript), { recursive: true });
      fs.writeFileSync(transcript, lines.join('\n') + '\n', 'utf8');
    }

    it('flushes a one-prompt session: the typed prompt AND the reply', async () => {
      writeLines([
        typedPrompt('Add trailing comma support to the widget tokenizer and keep it single-pass.', projectDir),
        assistantReply('Added trailing comma support in src/parser/widget.ts and wrote three tests.', projectDir),
      ]);
      stubFetch();

      const { runFlushSessionCli } = await loadFlush();
      await runFlushSessionCli(CLI_ARGV, stopHookStdin({ session_id: SESSION, transcript_path: transcript, cwd: projectDir }));

      expect(sent, 'a one-prompt session sent nothing').toHaveLength(1);
      expect(sent[0].body.chunks).toEqual([
        { role: 'user', text: 'Add trailing comma support to the widget tokenizer and keep it single-pass.' },
        { role: 'assistant', text: 'Added trailing comma support in src/parser/widget.ts and wrote three tests.' },
      ]);
    });

    it('still skips tool results, host wrappers and injected meta entries', async () => {
      writeLines([
        typedPrompt('Decide whether retries should be capped at five, I lean yes.', projectDir),
        toolResult(projectDir),
        hostEntry('<local-command-stdout>npm test output here</local-command-stdout>', projectDir),
        hostEntry('<command-name>/review</command-name>\n<command-message>review</command-message>', projectDir),
        hostEntry('<task-notification>\n<task-id>abc</task-id>\n</task-notification>', projectDir),
        hostEntry('Base directory for this skill: an injected skill body that nobody typed', projectDir, { isMeta: true }),
        hostEntry('This session is being continued from a previous conversation; summary follows', projectDir, { isCompactSummary: true }),
        assistantReply('Capped retries at five in the queue worker config.', projectDir),
      ]);
      stubFetch();

      const { runFlushSessionCli } = await loadFlush();
      await runFlushSessionCli(CLI_ARGV, stopHookStdin({ session_id: SESSION, transcript_path: transcript, cwd: projectDir }));

      expect(sent).toHaveLength(1);
      expect(sent[0].body.chunks.map((c: any) => c.role + ':' + c.text)).toEqual([
        'user:Decide whether retries should be capped at five, I lean yes.',
        'assistant:Capped retries at five in the queue worker config.',
      ]);
    });

    it('redacts a secret in a typed prompt', async () => {
      const secret = 'sk-ant-api03-' + 'B'.repeat(60);
      writeLines([
        typedPrompt(`Use this key for the staging run: ${secret} and nothing else`, projectDir),
        assistantReply('Understood, I will not write that key anywhere in the repo.', projectDir),
      ]);
      stubFetch();

      const { runFlushSessionCli } = await loadFlush();
      await runFlushSessionCli(CLI_ARGV, stopHookStdin({ session_id: SESSION, transcript_path: transcript, cwd: projectDir }));

      expect(sent).toHaveLength(1);
      expect(sent[0].raw).not.toContain(secret.slice(0, 30));
      expect(sent[0].raw).toContain('[REDACTED]');
    });

    // Scan 13: more host-written user entries. A `!` shell escape writes the
    // command and its output as `<bash-input>` / `<bash-stdout>` /
    // `<bash-stderr>` string entries, and Esc writes an interrupt marker as a
    // text block. Shapes from a live transcript, text invented.
    it('skips shell-escape entries and interrupt markers, keeps a prompt that quotes one', async () => {
      const interrupted = (text: string, cwd: string) => JSON.stringify({
        ...base(cwd), type: 'user', uuid: 'u-4', message: { role: 'user', content: [{ type: 'text', text }] },
      });
      writeLines([
        typedPrompt('Rename the retry helper to backoffWithJitter everywhere.', projectDir),
        hostEntry('<bash-input>git status --short</bash-input>', projectDir),
        hostEntry('<bash-stdout> M src/queue/retry.ts</bash-stdout><bash-stderr></bash-stderr>', projectDir),
        hostEntry('<bash-stderr>fatal: not a git repository</bash-stderr>', projectDir),
        interrupted('[Request interrupted by user]', projectDir),
        interrupted('[Request interrupted by user for tool use]', projectDir),
        hostEntry('[Request interrupted by user]', projectDir),
        typedPrompt('Why did it print [Request interrupted by user] when I pressed Esc?', projectDir),
        assistantReply('Renamed the helper in src/queue/retry.ts and its two call sites.', projectDir),
      ]);
      stubFetch();

      const { runFlushSessionCli } = await loadFlush();
      await runFlushSessionCli(CLI_ARGV, stopHookStdin({ session_id: SESSION, transcript_path: transcript, cwd: projectDir }));

      expect(sent).toHaveLength(1);
      expect(sent[0].body.chunks.map((c: any) => c.role + ':' + c.text)).toEqual([
        'user:Rename the retry helper to backoffWithJitter everywhere.',
        'user:Why did it print [Request interrupted by user] when I pressed Esc?',
        'assistant:Renamed the helper in src/queue/retry.ts and its two call sites.',
      ]);
    });

    // DeerDawn's own credentials, in the shapes apps/api mints them:
    // dd_<8 hex>_<64 hex> (an API key or OAuth access token) and ddr_<64 hex>
    // (an OAuth refresh token). The redactor knew every vendor's key but ours.
    it('redacts a pasted DeerDawn API key and refresh token in a typed prompt', async () => {
      const apiKey = `dd_${'3f9a0c1e'}_${'7b'.repeat(32)}`;
      const refresh = `ddr_${'c4'.repeat(32)}`;
      writeLines([
        typedPrompt(`The hook keeps failing, my key is ${apiKey} and the refresh token was ${refresh}.`, projectDir),
        assistantReply('Do not paste keys here; rotate that key from the dashboard instead.', projectDir),
      ]);
      stubFetch();

      const { runFlushSessionCli } = await loadFlush();
      await runFlushSessionCli(CLI_ARGV, stopHookStdin({ session_id: SESSION, transcript_path: transcript, cwd: projectDir }));

      expect(sent).toHaveLength(1);
      expect(sent[0].raw).not.toContain('7b7b7b7b');
      expect(sent[0].raw).not.toContain('c4c4c4c4');
      expect(sent[0].body.chunks[0].text).toBe('The hook keeps failing, my key is [REDACTED] and the refresh token was [REDACTED].');
    });
  });
});
