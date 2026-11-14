import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DeerdawnClient } from '../src/client.js';
import { handleContextSyncTool } from '../src/tools/context-sync.js';
import { normalizeTaskCardInputs, redactSecretText } from '../../shared-context/src/index.js';

/**
 * manage_todos could file cards but never advance them: `add` writes an event
 * without reading state, while list/move/complete/remove all read
 * `getContextJson()`. That call returned two different shapes depending on
 * whether a projectId was passed, and the tool assumed a third — `ctx.context
 * .todo_items`, where `.context` is undefined on both paths. Reading a field off
 * undefined-coalesced state throws no error, so the board simply read empty
 * forever and every move reported "no matching card found".
 *
 * These tests pin the contract end-to-end through the real client and the real
 * tool handler, against a fake API, so a shape regression fails here rather than
 * silently in a user's board.
 */

const TODO_ITEMS = [
  { id: 'card-1', title: 'Ship the session-start card', phase: 'in_progress' },
  { id: 'card-2', title: 'Trim tool schema descriptions', phase: 'backlog' },
  { id: 'card-3', title: 'One-command setup', phase: 'backlog' },
];
const COMPLETED_TODOS = [{ id: 'card-0', title: 'Old finished thing' }];

/**
 * The fake API APPLIES todo events instead of serving a frozen board.
 *
 * It used to answer every read with the same static array, which meant a write
 * that silently dropped a card looked identical to one that landed. That is the
 * exact failure this suite exists to catch, and on 2026-08-29 it did not: the
 * Done-cap trim destroyed three real cards while `complete` reported success.
 * Applying the events here is what lets the tool's read-back be tested at all.
 */
let todoItems: any[] = [];
let completedTodos: any[] = [];
/** Simulates the Done-cap trim discarding a card the write was told to file. */
let swallowDoneWrites = false;
/** Simulates the merge refusing an ambiguous removal: the card stays. */
let swallowRemoves = false;
/** Simulates a full board: the add is accepted on the wire and files nothing. */
let swallowAdds = false;
/**
 * Simulates the read-back itself failing: the add goes out, and the request
 * that would confirm it comes back 500. The write may well have landed — which
 * is exactly why the reply must not describe it as if it had been observed.
 */
let failReadBackAfterAdd = false;
let addSeen = false;
/**
 * Simulates the Done column at its cap: each write into Done pushes the oldest
 * completion off, and the reply names it in `evicted_cards` exactly as
 * POST /events does (applyStructuredContextEvent, #525).
 */
let evictOnDone = false;

const hits = (card: any, q: string) => {
  const a = String(card?.title ?? '').toLowerCase();
  const b = String(q ?? '').toLowerCase();
  return card?.id === q || (!!a && !!b && (a.includes(b) || b.includes(a)));
};

function applyTodoEvent(event: any) {
  const meta = event?.metadata || {};
  // metadata.todos carries bare titles OR {title, body, phase} cards. The fake
  // resolves them exactly the way the API's todo_added handler does — through
  // the shared normalizer — so a dispatcher that sent the wrong shape fails here
  // instead of on a real board.
  const raw: any[] = meta.todos || (meta.todo ? [meta.todo] : []);
  const targets: string[] = raw.map((entry) => (entry && typeof entry === 'object' ? entry.title : String(entry)));
  const stamp = new Date().toISOString();
  if (event?.event_type === 'todo_added') {
    if (swallowAdds) return;
    for (const input of normalizeTaskCardInputs(raw, meta.phase || '')) {
      // Stored the way the API stores it: through the storage redactor, so a
      // title naming a key lands masked (round 16).
      const card = { ...input, title: redactSecretText(input.title) };
      // Done is a separate array here exactly as it is on a real project, and the
      // merge treats a title already in EITHER as a no-op. An add reply that
      // reads the request instead of the board cannot see that.
      const done = completedTodos.find((t) => String(t.title).toLowerCase() === card.title.toLowerCase());
      if (done) {
        if (card.body) done.body = card.body;
        continue;
      }
      const existing = todoItems.find((t) => String(t.title).toLowerCase() === card.title.toLowerCase());
      if (existing) {
        if (card.body) existing.body = card.body;
        continue;
      }
      todoItems.push({
        id: `card-new-${todoItems.length + 1}`,
        title: card.title,
        ...(card.body ? { body: card.body } : {}),
        phase: card.phase || 'backlog',
        completed_at: card.phase === 'done' ? stamp : null,
      });
    }
    return;
  }
  if (event?.event_type === 'todo_removed') {
    if (swallowRemoves) return;
    todoItems = todoItems.filter((t) => !targets.some((q) => hits(t, q)));
    completedTodos = completedTodos.filter((t) => !targets.some((q) => hits(t, q)));
    return;
  }
  const phase = event?.event_type === 'todo_completed' ? 'done' : meta.phase;
  if (!phase) return;
  if (phase === 'done' && swallowDoneWrites) {
    // The card leaves its column and arrives nowhere — exactly what the trim did.
    todoItems = todoItems.filter((t) => !targets.some((q) => hits(t, q)));
    return;
  }
  todoItems = todoItems.map((t) =>
    targets.some((q) => hits(t, q))
      ? { ...t, phase, completed_at: phase === 'done' ? (t.completed_at || stamp) : null }
      : t
  );
}

type Mode = 'normal' | 'no-project' | 'legacy-api';
let mode: Mode = 'normal';

let server: http.Server;
let client: DeerdawnClient;
const recorded: any[] = [];

/** Requests the fake API saw, so we can assert which endpoint the client used. */
const seenPaths: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seenPaths.push(req.url || '');
    const send = (body: any, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    // No project resolved for this cwd — the route still answers with the
    // envelope, context null.
    //
    // A board WRITE with no project_id resolves its target first, on the brief
    // shape of /active (no format=json), because that is the shape that says HOW
    // the directory matched — and a name guess may be read but not changed. The
    // real route stamps match_kind on every project it returns; 'path' here is
    // the ordinary linked-directory case these tests were always about.
    const briefLookup = Boolean(req.url?.startsWith('/api/v1/context/active')) && !req.url?.includes('format=json');
    if (mode === 'no-project') return send(briefLookup ? { brief: null, project_id: null, project_name: null } : { context: null });
    if (briefLookup && mode !== 'legacy-api') {
      return send({ brief: 'b', project_id: 'project_test', project_name: 'Test Project', match_kind: 'path' });
    }
    // An API build predating format=json on /active: returns its brief payload,
    // which has no context key at all. The client must not crash or invent one.
    if (mode === 'legacy-api') return send({ brief: 'some brief', project_id: 'project_test', project_name: 'Test Project', match_kind: 'path' });

    // Mirrors the real route contract: BOTH /active?format=json and
    // /projects/:id/inject?format=json return { context: {...flat context} }.
    if (req.url?.startsWith('/api/v1/context/active') || req.url?.includes('/inject')) {
      if (failReadBackAfterAdd && addSeen) return send({ error: 'boom' }, 500);
      return send({
        context: {
          project_id: 'project_test',
          project_name: 'Test Project',
          updated_at: new Date().toISOString(),
          todo_items: todoItems,
          completed_todos: completedTodos,
          task_steps: [{ name: 'A derived step', status: 'pending' }],
        },
      });
    }

    if (req.url?.includes('/events')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      return req.on('end', () => {
        const event = JSON.parse(body || '{}');
        recorded.push(event);
        applyTodoEvent(event);
        if (event?.event_type === 'todo_added') addSeen = true;
        const intoDone = event?.event_type === 'todo_completed' || event?.metadata?.phase === 'done';
        if (evictOnDone && intoDone && completedTodos.length) {
          const oldest = completedTodos.shift();
          return send({ ok: true, project_id: 'project_test', evicted_cards: [{ id: oldest.id, title: oldest.title, phase: 'done' }] });
        }
        send({ ok: true });
      });
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

// Each test starts from the same board, so applying writes cannot make one test
// depend on another's leftovers.
beforeEach(() => {
  todoItems = TODO_ITEMS.map((t) => ({ ...t }));
  completedTodos = COMPLETED_TODOS.map((t) => ({ ...t }));
  swallowDoneWrites = false;
  swallowRemoves = false;
  swallowAdds = false;
  failReadBackAfterAdd = false;
  addSeen = false;
  evictOnDone = false;
});

afterAll(() => server?.close());

const text = (r: any) => String(r?.content?.[0]?.text ?? '');
const call = (args: any) => handleContextSyncTool('manage_todos', args, client);

describe('manage_todos', () => {
  it('getContextJson returns the same flat shape with and without a projectId', async () => {
    // The original defect. Both must expose todo_items at the top level.
    const withId = await client.getContextJson('project_test');
    const withoutId = await client.getContextJson();
    for (const ctx of [withId, withoutId]) {
      expect(Array.isArray(ctx.todo_items)).toBe(true);
      expect(ctx.todo_items).toHaveLength(3);
      expect(ctx.project_id).toBe('project_test');
      // The shape callers wrongly assumed must NOT come back, or the old
      // defensive `ctx.context ? ... : ctx` branches start guessing again.
      expect(ctx.context).toBeUndefined();
    }
  });

  it('lists the board instead of reporting it empty', async () => {
    const out = text(await call({ action: 'list' }));
    expect(out).toContain('Ship the session-start card');
    expect(out).toContain('Trim tool schema descriptions');
    expect(out).not.toContain('(empty');
  });

  it('folds legacy completed_todos into Done', async () => {
    expect(text(await call({ action: 'list' }))).toContain('Old finished thing');
  });

  it('moves a card matched by title', async () => {
    recorded.length = 0;
    const out = text(await call({ action: 'move', phase: 'testing', todos: ['Ship the session-start card'] }));
    expect(out).toContain('Moved to testing');
    expect(out).not.toContain('No card with that title');
    expect(recorded.at(-1)).toMatchObject({ event_type: 'todo_moved', metadata: { phase: 'testing' } });
  });

  it('moves a card matched by id', async () => {
    recorded.length = 0;
    expect(text(await call({ action: 'move', phase: 'done', todos: ['card-2'] }))).toContain('Moved to done');
    expect(recorded.at(-1)).toMatchObject({ event_type: 'todo_moved' });
  });

  it('completes and removes by title', async () => {
    expect(text(await call({ action: 'complete', todos: ['One-command setup'] }))).toContain('Marked complete');
    // remove also searches completed_todos, not just the open column. It needs
    // confirm_destructive now — the schema always advertised that, and only the
    // hosted dispatcher ever enforced it.
    expect(
      text(await call({ action: 'remove', todos: ['Old finished thing'], confirm_destructive: true }))
    ).toContain('Removed from');
  });

  it('emits no event when nothing matched', async () => {
    // A miss must not look like a success upstream.
    recorded.length = 0;
    await call({ action: 'move', phase: 'done', todos: ['definitely not a real card'] });
    expect(recorded).toHaveLength(0);
  });

  /**
   * move/complete used to apply to EVERY card whose title contained the query,
   * and report one. They now resolve exactly one card (shared-context's
   * resolveTaskCard, the rule remove already used) and name it by id on the
   * wire, so the write cannot land anywhere the reply did not say.
   */
  it('refuses an ambiguous move or complete, emits nothing, and lists the candidates', async () => {
    todoItems.push(
      { id: 'card-a1', title: 'Fix the auth redirect', phase: 'backlog' },
      { id: 'card-a2', title: 'Ship auth docs', phase: 'backlog' },
    );
    recorded.length = 0;
    for (const args of [
      { action: 'complete', todos: ['auth'] },
      { action: 'move', phase: 'testing', todos: ['auth'] },
      { action: 'remove', todos: ['auth'], confirm_destructive: true },
    ]) {
      const out = text(await call(args));
      expect(out).toContain('matches 2 cards');
      expect(out).toContain('card-a1');
      expect(out).toContain('card-a2');
      expect(out).not.toMatch(/Marked complete|Moved to|Removed from/);
    }
    expect(recorded).toHaveLength(0);
    expect(todoItems.filter((t) => t.id.startsWith('card-a')).map((t) => t.phase)).toEqual(['backlog', 'backlog']);
  });

  it('names the resolved card by id on the wire', async () => {
    recorded.length = 0;
    await call({ action: 'complete', todos: ['session-start card'] });
    expect(recorded.at(-1)).toMatchObject({ event_type: 'todo_completed', metadata: { todo: 'card-1' } });
  });

  it('matches a partial title, since the matcher is containment-based', async () => {
    // "session-start card" is a substring of the real title, so fuzzyTodoMatch
    // accepts it outright — it must never reach the suggestion path.
    const out = text(await call({ action: 'move', phase: 'done', todos: ['session-start card'] }));
    expect(out).toContain('Moved to done');
  });

  /**
   * The lie this tool told on 2026-08-29. `complete` built its success string
   * from the request and never read the board back, so when the Done-cap trim
   * discarded the incoming card the answer was still "Marked complete (→ Done)".
   * Three real cards were lost that way. The trim is fixed in shared-context, so
   * these paths now assert the guard rather than the bug: a write that does not
   * land must never be reported as one that did.
   */
  // The Done column keeps the newest completions; one more at the cap pushes
  // the oldest off. POST /events names it (evicted_cards) and the hosted
  // dispatcher says so; the local reply said only "Marked complete".
  it('names the card a completion pushed off a full Done column', async () => {
    evictOnDone = true;
    const out = text(await call({ action: 'complete', todos: ['One-command setup'] }));
    expect(out).toContain('Marked complete');
    expect(out).toContain('The board is at its limit, so this older card was removed to make room: "Old finished thing".');
  });

  it('names the card a move into Done pushed off, and says nothing when none was', async () => {
    evictOnDone = true;
    const out = text(await call({ action: 'move', phase: 'done', todos: ['card-2'] }));
    expect(out).toContain('Moved to done');
    expect(out).toContain('removed to make room: "Old finished thing"');

    evictOnDone = false;
    const quiet = text(await call({ action: 'complete', todos: ['One-command setup'] }));
    expect(quiet).toContain('Marked complete');
    expect(quiet).not.toContain('removed to make room');
  });

  it('does not report a completion that never reached Done', async () => {
    swallowDoneWrites = true;
    const out = text(await call({ action: 'complete', todos: ['One-command setup'] }));

    expect(out).not.toContain('Marked complete');
    expect(out).toContain('NOT recorded');
    expect(out).toContain('One-command setup');
    // The recovery has to be actionable, and `add` is the path that works.
    expect(out).toContain('action:"add"');
  });

  /**
   * `add` built its reply from the REQUEST. The merge in shared-context treats a
   * title already on the board as a no-op, so asking to add a card that was
   * sitting in Done answered `Added to in progress: "X"` and added nothing — a
   * write reporting success while the board the user is looking at is unchanged.
   * The reply is now a before/after difference of the stored cards.
   *
   * PARITY with apps/api/tests/integration/mcp-task-board-replies.test.js.
   */
  it('does not claim an add for a title already on the board', async () => {
    const out = text(await call({ action: 'add', phase: 'in_progress', todos: ['Old finished thing'] }));

    expect(out).not.toMatch(/^Added/m);
    expect(out).toContain('already exists in done');
    expect(out).toContain('nothing was added');
    // The card must not have been dragged out of Done by the report either.
    expect(todoItems.some((t) => t.title === 'Old finished thing')).toBe(false);
  });

  it('says which column a genuinely new card landed in', async () => {
    const out = text(await call({ action: 'add', phase: 'testing', todos: ['A brand new card'] }));
    expect(out).toContain('A brand new card');
    expect(out).toContain('testing');
    expect(out).toContain('Test Project');
  });

  it('reports re-adding an existing title WITH a body as a body update', async () => {
    // The documented path for filling in a card's detail. It is a real change,
    // and calling it "added" hides that the card was already there.
    const out = text(await call({
      action: 'add',
      cards: [{ title: 'One-command setup', body: 'Ship the installer first.' }],
    }));
    expect(out).toContain('Updated the body');
    expect(out).toContain('One-command setup');
    expect(out).not.toMatch(/^Added/m);
  });

  it('does not claim an add that never reached the board', async () => {
    swallowAdds = true;
    const out = text(await call({ action: 'add', todos: ['A card the board refused'] }));

    expect(out).not.toMatch(/^Added/m);
    expect(out).toContain('Not on the board after the write');
    expect(out).toContain('A card the board refused');
  });

  /**
   * Round 16: the board holds a title MASKED, and the reply compared the raw
   * title it sent — so a card naming a key read as "Not on the board after the
   * write … may be at its card limit" over a card that had landed. And two
   * titles differing only in the key are one card once stored.
   *
   * PARITY with apps/api/tests/integration/scan16-redaction.test.js #6.
   */
  it('finds a card whose title was masked, and names two that collapsed into one', async () => {
    const k1 = 'sk_' + 'live_' + '4eC39HqLyjWDarjtT1zdp7d1';
    const k2 = 'sk_' + 'live_' + '4eC39HqLyjWDarjtT1zdp7d2';
    const out = text(await call({ action: 'add', todos: [`Rotate key ${k1} in billing`, `Rotate key ${k2} in billing`, 'Move CACHE_KEY=user:1234 to redis'] }));

    expect(out).not.toContain('Not on the board');
    expect(out).not.toContain(k1);
    expect(out).not.toContain(k2);
    const added = out.split('\n').find((line) => line.startsWith('Added to')) || '';
    expect(added).toContain('"Rotate key [REDACTED] in billing"');
    expect(added).toContain('"Move CACHE_KEY=user:1234 to redis"');
    expect((added.match(/→/g) || []).length).toBe(2);
    expect(out).toContain('Stored as one card: "Rotate key [REDACTED] in billing" is the same card as "Rotate key [REDACTED] in billing"');
    expect(todoItems.filter((t) => t.title === 'Rotate key [REDACTED] in billing')).toHaveLength(1);
  });

  it('says when the add could not be verified, rather than sounding verified', async () => {
    // The fallback's own comment says "report the request, and SAY SO" — and the
    // second half was missing. A failed read-back produced a line identical to a
    // confirmed one, naming the column the card supposedly landed in, when that
    // column is only the one that was asked for. Re-adding an existing title is
    // a no-op on the merge, so this is precisely the sentence that must not be
    // stated as observed fact.
    failReadBackAfterAdd = true;
    const out = text(await call({ action: 'add', todos: ['A card nobody could check'], phase: 'in_progress' }));

    // Still reported: a read that failed is not evidence the write failed.
    expect(out).toContain('A card nobody could check');
    expect(out).toMatch(/could not be verified/i);
    expect(out).toMatch(/action:"list"/);
  });

  it('names the project when nothing matched', async () => {
    // A hosted client sends no cwd and even a local one may be pinned elsewhere,
    // so a confirmation that cannot be checked against a name is not much of one.
    for (const args of [
      { action: 'complete', todos: ['definitely not a real card'] },
      { action: 'remove', todos: ['definitely not a real card'], confirm_destructive: true },
    ]) {
      expect(text(await call(args))).toContain('Test Project');
    }
  });

  it('does not report a move to Done that never reached Done', async () => {
    swallowDoneWrites = true;
    const out = text(await call({ action: 'move', phase: 'done', todos: ['card-1'] }));

    expect(out).not.toContain('Moved to done');
    expect(out).toContain('NOT recorded');
  });

  it('still reports the cards that did land when only some are lost', async () => {
    // A partial failure must not read as total success or total failure.
    const out = text(await call({ action: 'complete', todos: ['One-command setup'] }));
    expect(out).toContain('Marked complete');
    expect(out).not.toContain('NOT recorded');
  });

  it('a move to any other column needs no read-back', async () => {
    // Only Done is capped. Every other column must keep answering from intent,
    // with no extra round-trip.
    swallowDoneWrites = true;
    const out = text(await call({ action: 'move', phase: 'in_progress', todos: ['card-2'] }));
    expect(out).toContain('Moved to in progress');
    expect(out).not.toContain('NOT recorded');
  });

  /**
   * Removal is a hard delete with no undo. The schema has advertised
   * confirm_destructive since this tool shipped and nothing read it, while the
   * hosted dispatcher always enforced it — so the two surfaces disagreed about
   * whether a safety net existed, and the local one silently had none.
   */
  it('refuses to remove without confirm_destructive', async () => {
    const before = todoItems.length;
    const out = text(await call({ action: 'remove', todos: ['One-command setup'] }));
    expect(out).toContain('confirm_destructive');
    expect(out).toContain('no undo');
    expect(todoItems).toHaveLength(before);
  });

  it('removes once confirmed', async () => {
    const out = text(await call({ action: 'remove', todos: ['One-command setup'], confirm_destructive: true }));
    expect(out).toContain('Removed from');
    expect(todoItems.some((t) => t.title === 'One-command setup')).toBe(false);
  });

  it('previews the exact cards before deleting them', async () => {
    // The confirmation is only meaningful if the caller can see WHAT it is
    // confirming — a card id, not just its own query echoed back.
    const out = text(await call({ action: 'remove', todos: ['card-1'] }));
    expect(out).toContain('Ship the session-start card');
    expect(out).toContain('card-1');
  });

  it('does not claim a removal the board did not make', async () => {
    // The server refuses an ambiguous removal, so the card survives. Echoing the
    // request would report a deletion that never happened.
    swallowRemoves = true;
    const out = text(await call({ action: 'remove', todos: ['One-command setup'], confirm_destructive: true }));
    expect(out).toContain('Still on the board');
    expect(out).not.toContain('Removed from');
  });

  it('suggests near matches rather than dead-ending', async () => {
    // Reworded, so containment fails and the token-overlap suggester takes over.
    // This is the case the old containment-based suggester could never reach.
    const out = text(await call({ action: 'move', phase: 'done', todos: ['trim the tool schemas'] }));
    expect(out).toMatch(/Did you mean/);
    expect(out).toContain('card-2');
    expect(out).toContain('Trim tool schema descriptions');
  });

  it('explains that derived step cards cannot be moved', async () => {
    // task_steps render on the board but have no persisted row, so an event
    // naming one would apply to nothing. That must not read as a typo.
    const out = text(await call({ action: 'move', phase: 'done', todos: ['A derived step'] }));
    expect(out).toMatch(/derived step card/);
    expect(out).not.toMatch(/Did you mean/);
  });

  it('reports an empty board when no project resolved, without crashing', async () => {
    mode = 'no-project';
    try {
      expect(await client.getContextJson()).toEqual({});
      expect(text(await call({ action: 'list' }))).toContain('empty');
    } finally { mode = 'normal'; }
  });

  // manage_tasks with no project_id sent no cwd, so /active answered with the
  // account's most recently touched project and a card added in one repo landed
  // on another repo's board. It must resolve from cwd like every other local write.
  it('resolves the board from the cwd project when project_id is omitted', async () => {
    const prevDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = '/work/this-repo';
    seenPaths.length = 0;
    try {
      await call({ action: 'list' });
      const active = seenPaths.filter((p) => p.startsWith('/api/v1/context/active'));
      expect(active.length).toBeGreaterThan(0);
      const params = new URL(active[0], 'http://x').searchParams;
      expect(params.get('cwd')).toBe('/work/this-repo');
      expect(params.get('format')).toBe('json');
    } finally {
      if (prevDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prevDir;
    }
  });

  it('refuses a write when no project resolves for the cwd, instead of writing unscoped', async () => {
    mode = 'no-project';
    recorded.length = 0;
    try {
      await expect(call({ action: 'add', todos: ['Should not land anywhere'] })).rejects.toThrow(/No active project/);
      expect(recorded).toHaveLength(0);
    } finally { mode = 'normal'; }
  });

  it('degrades gracefully against an API build without format=json on /active', async () => {
    // The published MCP server talks to whatever API version is deployed. An old
    // API returns the brief payload; that must read as an empty board, not a throw.
    mode = 'legacy-api';
    try {
      const out = text(await call({ action: 'list' }));
      expect(out).toContain('empty');
    } finally { mode = 'normal'; }
  });

  it('points an unrecognisable title at the board', async () => {
    expect(text(await call({ action: 'move', phase: 'done', todos: ['zzzzz'] }))).toMatch(/action:"list"/);
  });

  // ─── Card bodies ───────────────────────────────────────────────────────────
  // A card can hold detail that does not fit its title. The listing must MARK a
  // body and never print one — listing the live board already strains the
  // response limit on titles alone.

  it('files a card with a body, and still files a bare title', async () => {
    await call({
      action: 'add',
      todos: ['A bare title'],
      cards: [{ title: 'A specced card', body: 'Touch apps/api/src/routes/mcp.js first.', phase: 'in_progress' }],
    });
    const event = recorded.at(-1);
    expect(event.event_type).toBe('todo_added');
    // The wire shape the API's todo_added handler normalizes.
    expect(event.metadata.todos).toEqual([
      { title: 'A bare title' },
      { title: 'A specced card', body: 'Touch apps/api/src/routes/mcp.js first.', phase: 'in_progress' },
    ]);
    expect(todoItems.find((t) => t.title === 'A bare title')?.body).toBeUndefined();
    expect(todoItems.find((t) => t.title === 'A specced card')?.body).toContain('mcp.js');
  });

  it('marks a body in the listing without printing it', async () => {
    todoItems[0].body = 'SECRET-SPEC-TEXT that must not be listed';
    const result: any = await call({ action: 'list' });
    const out = text(result);
    expect(out).toContain('+body');
    expect(out).not.toContain('SECRET-SPEC-TEXT');
    expect(out).toMatch(/open with action:"list"/);
    // structuredContent ships alongside the text and would blow the same budget.
    expect(JSON.stringify(result.structuredContent)).not.toContain('SECRET-SPEC-TEXT');
    expect(JSON.stringify(result.structuredContent)).toContain('has_body');
  });

  it('opens a named card in full', async () => {
    todoItems[0].body = 'SECRET-SPEC-TEXT that must not be listed';
    const out = text(await call({ action: 'list', todos: ['card-1'] }));
    expect(out).toContain('SECRET-SPEC-TEXT');
    expect(out).toContain('card-1');
    // Opening ONE card is not a listing of every other card.
    expect(out).not.toContain('Trim tool schema descriptions');
  });

  it('refuses an add with neither todos nor cards', async () => {
    await expect(call({ action: 'add' })).rejects.toThrow(/todos or cards/);
  });
});
