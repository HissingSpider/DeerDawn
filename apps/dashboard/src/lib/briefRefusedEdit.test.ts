/**
 * A REFUSED EDIT KEEPS WHAT WAS TYPED — the rules, against real inputs.
 *
 * Journey r4: a person opened the editor on a line of the brief, typed, and
 * pressed Save while their AI tool (or a teammate) had changed the brief
 * underneath. The save was rightly refused (409 stale_context_version, or the
 * line was no longer as they saw it) — and the editor closed, throwing away what
 * they had typed. The owner's decision: the editor stays open with their text,
 * beside the line as it now is; when the line is gone, the text is still kept
 * and they are told the line is gone.
 *
 * These pin the pure half: which line the kept text sits beside, and what the
 * person is told. The component wiring is pinned in
 * tests/brief-refused-edit-contract.test.js.
 *
 * Run: `npx tsx --test src/lib/briefRefusedEdit.test.ts`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectContextJson } from './api';
import {
  BRIEF_BUSY_MESSAGE,
  EDIT_KEPT_NOTE,
  LINE_CHANGED_MESSAGE,
  LINE_GONE_MESSAGE,
  isStaleVersionError,
  lineIdentity,
  locateRefusedLine,
  refusedEditFor,
  refusedEditMessage,
  saveLineChange,
  type FreshWriteIO,
} from './briefEdits';

class Stale extends Error {
  status = 409;
  code = 'stale_context_version';
}

function server(context: Record<string, unknown>, opts: { alwaysStale?: boolean } = {}) {
  const row = { context: structuredClone(context), version: 3 };
  const io: FreshWriteIO = {
    read: async () => ({ project_id: 'p1', project_name: 'Acme', context_version: row.version, ...structuredClone(row.context) }) as ProjectContextJson,
    write: async (patch, expected) => {
      if (opts.alwaysStale || (expected !== null && expected !== row.version)) {
        row.version += 1;
        throw new Stale('stale');
      }
      Object.assign(row.context, structuredClone(patch));
      row.version += 1;
    },
  };
  return { row, io };
}

const D1 = { summary: 'Use Postgres for the queue', decided_at: '2026-09-20T10:00:00.000Z' };
const D2 = { summary: 'Ship on Fridays', decided_at: '2026-09-21T10:00:00.000Z' };

test('THE BUG: a line reworded by a tool — the typed text is kept, beside the line as it now reads', async () => {
  // The tab loaded D1; the tool rewords it; the person saves an edit of D1.
  const seen = lineIdentity('decided', { text: D1.summary, decided_at: D1.decided_at });
  const { row, io } = server({ recent_decisions: [D1, D2] });
  (row.context.recent_decisions as Array<Record<string, unknown>>)[0] = { ...D1, summary: 'Use Postgres for the queue, not Redis' };

  const result = await saveLineChange(io, 'decided', seen, { kind: 'edit', text: 'Use Postgres for the job queue' });
  assert.equal(result.outcome, 'gone', 'nothing was written');

  const kept = refusedEditFor({ projectId: 'p1', slot: 'decided', seen, draft: 'Use Postgres for the job queue', mode: 'edit', reason: 'changed' });
  assert.equal(kept.draft, 'Use Postgres for the job queue', 'what was typed is what is kept');

  // The line it sits beside is the SAME entry (by its stamp), as it reads now.
  const items = [
    { text: 'Use Postgres for the queue, not Redis', decided_at: D1.decided_at },
    { text: D2.summary, decided_at: D2.decided_at },
  ];
  const at = locateRefusedLine('decided', items, kept.seen);
  assert.equal(at, 0);
  assert.equal(items[at].text, 'Use Postgres for the queue, not Redis');
  assert.equal(refusedEditMessage(kept, true), LINE_CHANGED_MESSAGE);
});

test('a line removed since the tab loaded: the text is still kept, and the person is told the line is gone', async () => {
  const seen = lineIdentity('decided', { text: D1.summary, decided_at: D1.decided_at });
  const { io } = server({ recent_decisions: [D2] });
  const result = await saveLineChange(io, 'decided', seen, { kind: 'edit', text: 'typed words' });
  assert.equal(result.outcome, 'gone');

  const kept = refusedEditFor({ projectId: 'p1', slot: 'decided', seen, draft: 'typed words', mode: 'edit', reason: 'changed' });
  const items = [{ text: D2.summary, decided_at: D2.decided_at }];
  assert.equal(locateRefusedLine('decided', items, kept.seen), -1, 'no other line is taken for it');
  assert.equal(refusedEditMessage(kept, false), LINE_GONE_MESSAGE);
  assert.match(LINE_GONE_MESSAGE, /^Not saved:/);
  assert.match(LINE_GONE_MESSAGE, /no longer in the brief/);
});

test('a brief that kept changing (stale on every attempt): the typed text is kept beside the unchanged line', async () => {
  const seen = lineIdentity('landmine', { text: 'Never run the purge twice', added_at: '2026-09-22T00:00:00.000Z' });
  const { io } = server({ landmines: [{ summary: 'Never run the purge twice', added_at: '2026-09-22T00:00:00.000Z' }] }, { alwaysStale: true });
  let refused: unknown = null;
  try {
    await saveLineChange(io, 'landmine', seen, { kind: 'edit', text: 'Never run the purge without a dry run' });
  } catch (err) {
    refused = err;
  }
  assert.ok(isStaleVersionError(refused), 'the refusal the editor keeps the text for');

  const kept = refusedEditFor({ projectId: 'p1', slot: 'landmine', seen, draft: 'Never run the purge without a dry run', mode: 'correct', reason: 'busy' });
  const items = [{ text: 'Never run the purge twice', added_at: '2026-09-22T00:00:00.000Z' }];
  assert.equal(locateRefusedLine('landmine', items, kept.seen), 0);
  assert.equal(refusedEditMessage(kept, true), BRIEF_BUSY_MESSAGE);
  assert.equal(kept.mode, 'correct', 'a correction stays a correction');
});

test('a question carries no stamp: it is found by its words, and reworded counts as gone', () => {
  const seen = lineIdentity('open', { text: 'Which region do we deploy to?' });
  const kept = refusedEditFor({ projectId: 'p1', slot: 'open', seen, draft: 'Which EU region?', mode: 'edit', reason: 'busy' });
  assert.equal(locateRefusedLine('open', [{ text: 'Other' }, { text: 'Which  region do we deploy to?' }], kept.seen), 1);
  assert.equal(locateRefusedLine('open', [{ text: 'Which region do we deploy to first?' }], kept.seen), -1);
});

test('a stamped line is never matched by words alone: two decisions can read alike', () => {
  const seen = { text: 'Ship on Fridays', stamp: '2026-09-21T10:00:00.000Z' };
  const items = [{ text: 'Ship on Fridays', decided_at: '2026-09-01T00:00:00.000Z' }];
  assert.equal(locateRefusedLine('decided', items, seen), -1);
});

test('each kept edit has its own id, and the sentence tells the person what they can do', () => {
  const a = refusedEditFor({ projectId: 'p1', slot: 'open', seen: { text: 'q' }, draft: 'x', mode: 'edit', reason: 'busy' });
  const b = refusedEditFor({ projectId: 'p1', slot: 'open', seen: { text: 'q' }, draft: 'x', mode: 'edit', reason: 'busy' });
  assert.notEqual(a.id, b.id);
  assert.match(EDIT_KEPT_NOTE, /copy/i);
  assert.match(EDIT_KEPT_NOTE, /save again/i);
});
