/**
 * The locked Portfolio's lead line — the one sentence the whole upgrade mechanic
 * rests on. Two rules, and the first version broke both at once:
 *   1. Lead with the reader's OWN number, never a feature name.
 *   2. Say something true. It rendered "Your 1 projects have no shared entities
 *      yet" — ungrammatical, and a non-sequitur to the single-project account
 *      that removing the cap exists to unblock.
 */
import test from 'node:test';
import assert from 'node:assert';
import { leadLine } from '../pages/portfolio';

test('a single-project account is told where to start, not what it lacks', () => {
  const line = leadLine({ projects: 1, decisions: 3, shared_entities: 0 });
  assert.ok(!/1 projects/.test(line), `ungrammatical: "${line}"`);
  assert.ok(!/have no shared entities/.test(line), 'do not report an absence that is definitionally true at one project');
  assert.match(line, /second project/, 'point at the next step');
});

test('a multi-project account with nothing shared gets its own real number', () => {
  const line = leadLine({ projects: 6, decisions: 47, shared_entities: 0 });
  assert.match(line, /\b6 projects\b/, 'lead with the reader’s own number');
});

test('the headline case leads with the count and agrees in number', () => {
  assert.match(leadLine({ projects: 6, decisions: 47, shared_entities: 9 }), /^9 things show up/);
  assert.match(leadLine({ projects: 2, decisions: 4, shared_entities: 1 }), /^1 thing shows up/);
});

test('no lead line ever names a feature instead of a number', () => {
  for (const counts of [
    { projects: 1, decisions: 0, shared_entities: 0 },
    { projects: 6, decisions: 47, shared_entities: 0 },
    { projects: 6, decisions: 47, shared_entities: 9 },
  ]) {
    assert.ok(!/[Uu]pgrade|[Uu]nlock/.test(leadLine(counts)),
      'the lead line is an observation about their work, not an advert');
  }
});
