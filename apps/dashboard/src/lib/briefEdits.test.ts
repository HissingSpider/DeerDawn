/**
 * ONE CLICK CHANGES ONE LINE — the rules, run against real inputs.
 *
 * Journey r3, S3-1: /projects was open in a tab; the person's own AI tool
 * recorded a decision (the server held 4); the person clicked Pin on an older
 * line in the tab, which sent back the 3 decisions it had loaded. 200, "Brief
 * updated.", and the tool's decision was gone. These pin what replaced that:
 * the change is applied to a FRESH read, to the line found by identity (text +
 * stamp, never index), written with the version it read, re-read and re-applied
 * on a stale refusal at most twice, and never written at all when the clicked
 * line is not there any more.
 *
 * The component wiring (every per-line action goes through this, the tab
 * refetches on focus) is pinned in tests/brief-stale-tab-contract.test.js.
 *
 * Run: `npx tsx --test src/lib/briefEdits.test.ts`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectContextJson } from './api';
import {
  BRIEF_BUSY_MESSAGE,
  LINE_CHANGED_MESSAGE,
  applyChangeToContext,
  applyLineChange,
  findLine,
  isStaleVersionError,
  lineIdentity,
  mergeLineEdits,
  projectEditorPatch,
  saveLineChange,
  writeFromFreshRead,
  type FreshWriteIO,
} from './briefEdits';

// ── A small in-memory API with the server's version rule ─────────────────────

type Row = { context: Record<string, unknown>; version: number };

class Stale extends Error {
  status = 409;
  code = 'stale_context_version';
  data = { error: 'stale_context_version' };
}

function server(context: Record<string, unknown>) {
  const row: Row = { context: structuredClone(context), version: 7 };
  const writes: Array<{ patch: Record<string, unknown>; expected: number | null }> = [];
  return {
    row,
    writes,
    // What GET /inject?format=json answers.
    read: async (): Promise<ProjectContextJson> =>
      ({ project_id: 'p1', project_name: 'Acme', context_version: row.version, ...structuredClone(row.context) }) as ProjectContextJson,
    // PATCH /projects/:id/context with expected_context_version.
    write: async (patch: Record<string, unknown>, expected: number | null) => {
      writes.push({ patch, expected });
      if (expected !== null && expected !== row.version) throw new Stale('stale');
      Object.assign(row.context, structuredClone(patch));
      row.version += 1;
    },
    // Somebody else's write (the person's AI tool, another tab).
    elsewhere(mutate: (ctx: Record<string, unknown>) => void) {
      mutate(row.context);
      row.version += 1;
    },
  };
}

const D1 = { summary: 'Use Stripe Checkout (hosted)', decided_at: '2026-09-27T10:00:00.000Z', importance: 'normal' };
const D2 = { summary: 'Store prices in plans.js', decided_at: '2026-09-27T10:00:00.000Z', importance: 'normal' };
const D3 = { summary: 'Invoices are generated nightly', decided_at: '2026-09-27T10:00:01.000Z', importance: 'normal' };
const TOOL = { summary: 'Verify Stripe webhook signatures with the raw request body', decided_at: '2026-09-28T09:00:00.000Z', importance: 'normal', source_tool: 'claude' };

const summaries = (ctx: Record<string, unknown>) =>
  (ctx.recent_decisions as Array<{ summary: string; importance?: string }>).map((d) => d.summary);

// The item exactly as the tab rendered it (deriveBriefSpine's decided mapper).
const asRendered = (d: typeof D1, index: number) => ({ text: d.summary, decided_at: d.decided_at, index });

// ── The S3-1 journey ─────────────────────────────────────────────────────────

test('THE BUG: a pin in a tab loaded before the tool wrote keeps the tool\'s decision', async () => {
  const api = server({ recent_decisions: [D1, D2, D3] });
  const tabLoaded = await api.read();
  // The tool records a decision after the tab loaded. The tab never refreshed.
  api.elsewhere((ctx) => { (ctx.recent_decisions as unknown[]).push(TOOL); });

  const clicked = asRendered(D1, 0);
  const result = await saveLineChange(api, 'decided', lineIdentity('decided', clicked), { kind: 'pin' });

  assert.equal(result.outcome, 'saved');
  assert.deepEqual(summaries(api.row.context), [D1.summary, D2.summary, D3.summary, TOOL.summary],
    'the write was built from a fresh read: the tool\'s decision is still there');
  const stored = api.row.context.recent_decisions as Array<{ summary: string; importance: string }>;
  assert.equal(stored[0].importance, 'high', 'and the clicked line is the one pinned');
  assert.deepEqual(stored.slice(1).map((d) => d.importance), ['normal', 'normal', 'normal'], 'nothing else changed');
  assert.equal(api.writes[0].expected, 8, 'written with the version of the fresh read, not the tab\'s');
  assert.notEqual(api.writes[0].expected, tabLoaded.context_version);
});

test('the line is found by identity, not by where it sat in the list the tab loaded', async () => {
  // The tool's decision lands at the FRONT: every index the tab holds is now off by one.
  const api = server({ recent_decisions: [D1, D2, D3] });
  api.elsewhere((ctx) => { (ctx.recent_decisions as unknown[]).unshift(TOOL); });
  const clicked = asRendered(D2, 1); // index 1 in the tab's copy; index 2 on the server
  await saveLineChange(api, 'decided', lineIdentity('decided', clicked), { kind: 'dismiss' });
  assert.deepEqual(summaries(api.row.context), [TOOL.summary, D1.summary, D3.summary],
    'the clicked line went, and the one that moved into its old index (D1) stayed');
});

test('two lines with the same stamp are told apart by their text, and the same text by its stamp', () => {
  const list = [D1, D2, { ...D1, decided_at: '2026-09-01T00:00:00.000Z' }];
  assert.equal(findLine('decided', list, { text: D2.summary, stamp: D2.decided_at }), 1);
  assert.equal(findLine('decided', list, { text: D1.summary, stamp: '2026-09-01T00:00:00.000Z' }), 2);
  assert.equal(findLine('decided', list, { text: D1.summary, stamp: D1.decided_at }), 0);
});

test('an edit keeps every other field of the entry, its stamp included', () => {
  const next = applyLineChange('decided', [D1, TOOL], 1, { kind: 'edit', text: 'Verify signatures on the raw body' }) as Array<Record<string, unknown>>;
  assert.equal(next[1].summary, 'Verify signatures on the raw body');
  assert.equal(next[1].decided_at, TOOL.decided_at);
  assert.equal(next[1].source_tool, 'claude', 'provenance survives an edit');
  assert.deepEqual(next[0], D1);
});

test('a landmine edit rewrites the stored summary, the field every tool reads', () => {
  const mine = { summary: 'Never run migrations on deploy', text: 'Never run migrations on deploy', added_at: '2026-09-20T00:00:00.000Z' };
  const next = applyLineChange('landmine', [mine], 0, { kind: 'edit', text: 'Run migrations by hand only' }) as Array<Record<string, unknown>>;
  assert.equal(next[0].summary, 'Run migrations by hand only');
  assert.equal(next[0].text, 'Run migrations by hand only');
  assert.equal(next[0].added_at, mine.added_at);
});

test('a question is dismissed by its text, with the tool\'s new question left in place', async () => {
  const api = server({ open_questions: ['Do we need idempotency keys?', 'Refunds via dashboard or Stripe?'] });
  api.elsewhere((ctx) => { (ctx.open_questions as string[]).push('Should failed webhooks be retried by a queue?'); });
  await saveLineChange(api, 'open', lineIdentity('open', { text: 'Refunds via dashboard or Stripe?' }), { kind: 'dismiss' });
  assert.deepEqual(api.row.context.open_questions, ['Do we need idempotency keys?', 'Should failed webhooks be retried by a queue?']);
});

// ── When the line is not there any more ──────────────────────────────────────

test('a line the tool removed since the tab loaded: nothing is written, and the fresh brief comes back', async () => {
  const api = server({ recent_decisions: [D1, D2, D3] });
  api.elsewhere((ctx) => { ctx.recent_decisions = [D1, D3, TOOL]; });
  const result = await saveLineChange(api, 'decided', lineIdentity('decided', asRendered(D2, 1)), { kind: 'pin' });
  assert.equal(result.outcome, 'gone');
  assert.equal(api.writes.length, 0, 'THE RULE: a write that did not happen is never reported as one');
  assert.ok(result.outcome === 'gone' && summaries(result.context as Record<string, unknown>).includes(TOOL.summary),
    'the caller gets the brief as it is now, to show');
});

test('a line the tool reworded counts as changed: the person\'s click is not applied to words they never saw', async () => {
  const api = server({ recent_decisions: [D1] });
  api.elsewhere((ctx) => { ctx.recent_decisions = [{ ...D1, summary: 'Use Stripe Checkout (hosted), with Link' }]; });
  const result = await saveLineChange(api, 'decided', lineIdentity('decided', asRendered(D1, 0)), { kind: 'edit', text: 'Use Elements' });
  assert.equal(result.outcome, 'gone');
  assert.equal(api.writes.length, 0);
});

test('a decision resolved since the tab loaded has left DECIDED: a pin on it writes nothing', async () => {
  const api = server({ recent_decisions: [D1, D2] });
  api.elsewhere((ctx) => { ctx.recent_decisions = [D1, { ...D2, resolved: true }]; });
  const result = await saveLineChange(api, 'decided', lineIdentity('decided', asRendered(D2, 1)), { kind: 'pin' });
  assert.equal(result.outcome, 'gone');
});

// ── Stale refusals: read again and re-apply, at most twice ───────────────────

test('a write refused as stale is re-read and re-applied, keeping what landed in between', async () => {
  const api = server({ recent_decisions: [D1, D2, D3] });
  let reads = 0;
  const racing: FreshWriteIO = {
    read: async () => {
      const fresh = await api.read();
      // Right after our first read, the tool writes. Our first write is stale.
      if (reads++ === 0) api.elsewhere((ctx) => { (ctx.recent_decisions as unknown[]).push(TOOL); });
      return fresh;
    },
    write: api.write,
  };
  const result = await saveLineChange(racing, 'decided', lineIdentity('decided', asRendered(D3, 2)), { kind: 'pin' });
  assert.deepEqual(result, { outcome: 'saved', attempts: 2 });
  assert.equal(api.writes.length, 2);
  assert.deepEqual(summaries(api.row.context), [D1.summary, D2.summary, D3.summary, TOOL.summary]);
  assert.equal((api.row.context.recent_decisions as Array<{ importance: string }>)[2].importance, 'high');
});

test('at most two retries: a brief that keeps changing is refused, not overwritten', async () => {
  const api = server({ recent_decisions: [D1] });
  const churning: FreshWriteIO = {
    read: async () => {
      const fresh = await api.read();
      api.elsewhere(() => {}); // somebody writes after every read
      return fresh;
    },
    write: api.write,
  };
  await assert.rejects(
    () => saveLineChange(churning, 'decided', lineIdentity('decided', asRendered(D1, 0)), { kind: 'pin' }),
    (err) => isStaleVersionError(err),
  );
  assert.equal(api.writes.length, 3, 'the first try and two retries, no more');
  assert.equal((api.row.context.recent_decisions as Array<{ importance: string }>)[0].importance, 'normal');
});

test('a failure that is not a stale refusal is not retried', async () => {
  let writes = 0;
  const io: FreshWriteIO = {
    read: async () => ({ project_id: 'p', project_name: 'p', context_version: 1, recent_decisions: [D1] }) as ProjectContextJson,
    write: async () => { writes += 1; throw Object.assign(new Error('nope'), { status: 403, code: 'share_write_forbidden' }); },
  };
  await assert.rejects(() => saveLineChange(io, 'decided', lineIdentity('decided', asRendered(D1, 0)), { kind: 'pin' }));
  assert.equal(writes, 1);
});

test('an API that reports no version is written unguarded — still from the fresh read', async () => {
  let sent: number | null | undefined;
  const io: FreshWriteIO = {
    read: async () => ({ project_id: 'p', project_name: 'p', recent_decisions: [D1, TOOL] }) as ProjectContextJson,
    write: async (_patch, expected) => { sent = expected; },
  };
  await saveLineChange(io, 'decided', lineIdentity('decided', asRendered(D1, 0)), { kind: 'pin' });
  assert.equal(sent, null);
});

// ── Two tabs (or two people), within the same second ─────────────────────────

test('two tabs pin DIFFERENT lines: both pins survive', async () => {
  const api = server({ recent_decisions: [D1, D2, D3] });
  // Both tabs loaded the same brief; both click at once.
  const [a, b] = await Promise.all([
    saveLineChange(api, 'decided', lineIdentity('decided', asRendered(D1, 0)), { kind: 'pin' }),
    saveLineChange(api, 'decided', lineIdentity('decided', asRendered(D3, 2)), { kind: 'dismiss' }),
  ]);
  assert.equal(a.outcome, 'saved');
  assert.equal(b.outcome, 'saved');
  const stored = api.row.context.recent_decisions as Array<{ summary: string; importance: string }>;
  assert.deepEqual(stored.map((d) => d.summary), [D1.summary, D2.summary], 'the dismiss landed');
  assert.equal(stored[0].importance, 'high', 'and so did the pin');
});

test('two tabs change the SAME line: the later change lands on top of the earlier one', async () => {
  const api = server({ recent_decisions: [D1, D2] });
  // Tab A pins D2; a moment later tab B (loaded before A clicked) rewords it.
  await saveLineChange(api, 'decided', lineIdentity('decided', asRendered(D2, 1)), { kind: 'pin' });
  await saveLineChange(api, 'decided', lineIdentity('decided', asRendered(D2, 1)), { kind: 'edit', text: 'Prices live in plans.js only' });
  const stored = api.row.context.recent_decisions as Array<{ summary: string; importance: string }>;
  assert.equal(stored[1].summary, 'Prices live in plans.js only', 'the later edit wins');
  assert.equal(stored[1].importance, 'high', 'without undoing the earlier pin it was applied over');
  // Tab A refreshes (focus) and reads the result.
  const tabA = await api.read();
  assert.equal(summaries(tabA as unknown as Record<string, unknown>)[1], 'Prices live in plans.js only');
});

test('the SAME line reworded in one tab, then edited in the other: the second writes nothing and is told', async () => {
  const api = server({ recent_decisions: [D1] });
  await saveLineChange(api, 'decided', lineIdentity('decided', asRendered(D1, 0)), { kind: 'edit', text: 'Use Stripe Checkout' });
  const late = await saveLineChange(api, 'decided', lineIdentity('decided', asRendered(D1, 0)), { kind: 'edit', text: 'Use Elements' });
  assert.equal(late.outcome, 'gone', 'the line it clicked no longer reads as it saw it');
  assert.deepEqual(summaries(api.row.context), ['Use Stripe Checkout'], 'nobody\'s words were overwritten blind');
});

// ── The optimistic draft uses the same rule ──────────────────────────────────

test('the optimistic draft applies the change by identity too', () => {
  const ctx = { project_id: 'p', project_name: 'p', recent_decisions: [TOOL, D1, D2] } as ProjectContextJson;
  const { context, found } = applyChangeToContext(ctx, 'decided', lineIdentity('decided', asRendered(D1, 0)), { kind: 'pin' });
  assert.equal(found, true);
  const list = context.recent_decisions as Array<{ summary: string; importance?: string }>;
  assert.equal(list[1].importance, 'high');
  assert.equal(list[0].importance, 'normal');
});

// ── A textarea of lines (the /memory project editor's goals) ─────────────────

test('goals edited as text are merged as line changes onto the list as it is now', () => {
  const original = ['Ship checkout', 'Cut churn'];
  const edited = ['Ship checkout', 'Launch annual plan']; // removed "Cut churn", added one
  const fresh = ['Ship checkout', 'Cut churn', 'Add SSO']; // the tool added "Add SSO" meanwhile
  assert.deepEqual(mergeLineEdits(original, edited, fresh), ['Ship checkout', 'Add SSO', 'Launch annual plan']);
});

// ── The words ────────────────────────────────────────────────────────────────

test('the sentences say nothing was saved and that what is shown is current', () => {
  for (const message of [LINE_CHANGED_MESSAGE, BRIEF_BUSY_MESSAGE]) {
    assert.match(message, /^Not saved/);
    assert.match(message, /What you see now is current/);
    assert.doesNotMatch(message, /Brief updated/);
  }
});

test('writeFromFreshRead hands back what it read when there is nothing to write', async () => {
  const io: FreshWriteIO = {
    read: async () => ({ project_id: 'p', project_name: 'p', context_version: 3 }) as ProjectContextJson,
    write: async () => { throw new Error('must not write'); },
  };
  const result = await writeFromFreshRead(io, () => null);
  assert.equal(result.outcome, 'gone');
});

// ── The /memory project editor ───────────────────────────────────────────────


test('the project editor sends only what the person changed', () => {
  const start = { project_name: 'Acme', description: 'Store', current_task: 'Wire webhooks', current_status: '', goals: 'Ship checkout\nCut churn' };
  // A rename, nothing else: the task, status and goals the page loaded stay out of the request.
  assert.deepEqual(projectEditorPatch(start, { ...start, project_name: 'Acme storefront' }), { scalars: { project_name: 'Acme storefront' }, goals: null });
  assert.equal(projectEditorPatch(start, { ...start }), null, 'an unchanged Save writes nothing');
  const goals = projectEditorPatch(start, { ...start, goals: 'Ship checkout\nLaunch annual plan' });
  assert.deepEqual(goals, { scalars: {}, goals: { original: ['Ship checkout', 'Cut churn'], edited: ['Ship checkout', 'Launch annual plan'] } });
});
