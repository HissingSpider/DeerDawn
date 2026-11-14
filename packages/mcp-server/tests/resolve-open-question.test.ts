import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DeerdawnClient } from '../src/client.js';
import { handleContextSyncTool } from '../src/tools/context-sync.js';

/**
 * Retiring ONE open question from an agent session (2026-08-29).
 *
 * The API half shipped first and nothing could reach it. From a session the only
 * lever on open_questions was manage_memory(action:"finish_task"), which clears
 * the list wholesale along with the command log and the blocking issue — so dead
 * questions accumulated because the only tool pointed at them was a wrecking ball.
 *
 * What these pin is the part a model has to READ: a refusal that carries the
 * candidate questions is recoverable, and a refusal that does not is a dead end.
 * The 409 and the 404 arrive as AxiosErrors, and handleApiError would otherwise
 * flatten the 409 into "Conflicts with something that already exists" — a
 * sentence that is not even true here, since nothing was created.
 */

let server: http.Server;
let client: DeerdawnClient;
let openQuestions: string[] = [];
let resolvedCalls: any[] = [];

const SEED = [
  'How should I authenticate with GitHub?',
  'Which auth provider should the dashboard use?',
  'What is causing the CI install step to fail?',
];

const norm = (s: string) => s.trim().toLowerCase();
const fuzzy = (a: string, b: string) => norm(a).includes(norm(b)) || norm(b).includes(norm(a));

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const send = (status: number, body: any) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      // Mirrors contextSyncService.resolveQuestion and the route above it: exact
      // text first, fuzzy only when it lands on exactly one, otherwise nothing.
      if (req.method === 'POST' && req.url?.includes('/questions/resolve')) {
        const payload = JSON.parse(body || '{}');
        resolvedCalls.push(payload);
        const query = String(payload.question || '').trim();
        const exact = openQuestions.filter((q) => norm(q) === norm(query));
        const hits = exact.length ? [exact[0]] : openQuestions.filter((q) => fuzzy(q, query));
        if (hits.length > 1) {
          return send(409, {
            error: 'question_ambiguous',
            message: `"${query}" matches ${hits.length} open questions, so nothing was resolved. Re-send the exact, complete question text.`,
            candidates: hits,
          });
        }
        if (!hits.length) {
          return send(404, { error: 'question_not_found', message: `No open question matches "${query}".` });
        }
        openQuestions = openQuestions.filter((q) => q !== hits[0]);
        return send(200, { resolved: hits[0], project: { context: { open_questions: openQuestions } } });
      }
      if (req.url?.includes('/inject')) {
        return send(200, { context: { open_questions: openQuestions } });
      }
      if (req.url?.includes('/context/active')) {
        // match_kind as the real route sends it; a write follows a linked path
        // and never a name guess (write-target.ts).
        return send(200, { project_id: 'project_active', project_name: 'Active', match_kind: 'path' });
      }
      send(200, { ok: true });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  client = new DeerdawnClient({
    apiUrl: `http://127.0.0.1:${port}`, apiKey: 'dev-key', environment: 'sandbox',
    cacheEnabled: false, cacheTtlSeconds: 60, maxRetries: 1, retryBackoffMs: 10,
  } as any);
});

beforeEach(() => {
  openQuestions = [...SEED];
  resolvedCalls = [];
});

afterAll(() => server?.close());

// Enter through the GROUPED tool, the way a session actually calls it.
const call = async (args: any) => {
  const r = await handleContextSyncTool('manage_memory', { action: 'resolve_question', project_id: 'project_test', ...args }, client);
  return String((r as any)?.content?.[0]?.text ?? '');
};

describe('manage_memory action resolve_question', () => {
  it('resolves exactly one question and says what is left', async () => {
    const out = await call({
      question: 'What is causing the CI install step to fail?',
      answer: 'A stale lockfile.',
    });
    expect(out).toContain('Resolved: "What is causing the CI install step to fail?"');
    expect(out).toContain('2 questions still open');
    expect(openQuestions).toHaveLength(2);
  });

  it('refuses an ambiguous query and prints the candidates in full', async () => {
    // "auth" is a substring of two different questions. A count alone would leave
    // the caller with no way to become unambiguous.
    const out = await call({ question: 'auth', answer: 'Clerk' });
    expect(out).toContain('nothing was resolved');
    expect(out).toContain('How should I authenticate with GitHub?');
    expect(out).toContain('Which auth provider should the dashboard use?');
    expect(openQuestions).toHaveLength(3);
  });

  it('does not collapse the 409 into a generic conflict message', async () => {
    // The regression guard: unlisted in ACTIONABLE_ERROR_CODES, handleApiError
    // rewrites this to "Conflicts with something that already exists".
    const out = await call({ question: 'auth', answer: 'Clerk' });
    expect(out).not.toMatch(/already exists/i);
    expect(out).not.toMatch(/Operation failed/);
  });

  it('reports a miss with the questions that ARE open, not a bare not-found', async () => {
    const out = await call({ question: 'Which colour should the logo be?', answer: 'Black' });
    expect(out).toContain('No open question matches');
    expect(out).toContain('How should I authenticate with GitHub?');
    expect(openQuestions).toHaveLength(3);
  });

  it('says so plainly when the brief has no open questions at all', async () => {
    openQuestions = [];
    const out = await call({ question: 'anything', answer: 'x' });
    expect(out).toContain('no open questions at all');
  });

  it('falls back to the active project when project_id is omitted', async () => {
    const r = await handleContextSyncTool(
      'manage_memory',
      { action: 'resolve_question', question: 'What is causing the CI install step to fail?', answer: 'Stale lockfile.' },
      client,
    );
    expect(String((r as any)?.content?.[0]?.text ?? '')).toContain('Resolved:');
  });

  it('rejects a blank question before it can reach the wholesale clear', async () => {
    // A whitespace-only query used to trim to '' and fuzzy-match EVERY question.
    await expect(call({ question: '   ', answer: 'x' })).rejects.toThrow(/question/i);
    expect(resolvedCalls).toHaveLength(0);
    expect(openQuestions).toHaveLength(3);
  });

  it('rejects a missing answer, so a resolve never records an empty decision', async () => {
    await expect(call({ question: 'What is causing the CI install step to fail?' })).rejects.toThrow(/answer/i);
    expect(resolvedCalls).toHaveLength(0);
  });

  it('keeps resolve pointed at the entity store, not the question list', async () => {
    // Same verb, two stores. If `resolve` ever started routing here, one call
    // would silently retire a brief question when the caller meant an entity.
    const r = await handleContextSyncTool('manage_memory', { action: 'resolve', title: 'nothing here' }, client);
    expect(String((r as any)?.content?.[0]?.text ?? '')).toContain('No entity found');
    expect(resolvedCalls).toHaveLength(0);
    expect(openQuestions).toHaveLength(3);
  });
});
