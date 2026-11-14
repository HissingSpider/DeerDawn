/**
 * `withheld_sections` — the dashboard half of "withheld is not empty".
 *
 * The API section-filters a teammate's view of somebody else's shared project by
 * DROPPING keys. An absent key is indistinguishable from an unwritten one, so
 * every empty state on this page ("This project doesn't have brief content
 * yet", "No tasks on the board yet") was telling a member a busy project was
 * blank — and a blank brief invites you to type it in again, producing a second,
 * diverging copy of work that already exists.
 *
 * These pin the two helpers the components read, including the case that matters
 * most: an OWNER's context has no marker and must keep its ordinary empty state.
 */
import test from 'node:test';
import assert from 'node:assert';
import { withheldSectionLabels, isSectionWithheld, type ProjectContextJson } from './api';

const filtered = {
  project_id: 'p1',
  project_name: 'WithheldProj',
  current_task: 'Ship the share policy',
  withheld_sections: ['recent_decisions', 'goals', 'todo_items'],
} as ProjectContextJson;

const owned = {
  project_id: 'p1',
  project_name: 'Mine',
  current_task: 'Ship the share policy',
} as ProjectContextJson;

test('labels are human words, not field names', () => {
  assert.deepStrictEqual(withheldSectionLabels(filtered), ['decisions', 'goals', 'task board']);
});

test('an unfiltered context yields no labels, so the ordinary empty state stands', () => {
  assert.deepStrictEqual(withheldSectionLabels(owned), []);
  assert.deepStrictEqual(withheldSectionLabels(null), []);
  assert.deepStrictEqual(withheldSectionLabels(undefined), []);
});

test('a malformed marker degrades to "nothing withheld" rather than throwing', () => {
  // This value crosses a JSON boundary from a server the page does not control;
  // a render crash here would be a worse outcome than a missing notice.
  assert.deepStrictEqual(withheldSectionLabels({ withheld_sections: 'decisions' } as never), []);
  assert.strictEqual(isSectionWithheld({ withheld_sections: null } as never, 'todo_items'), false);
});

test('isSectionWithheld distinguishes a withheld board from an empty one', () => {
  assert.strictEqual(isSectionWithheld(filtered, 'todo_items'), true);
  assert.strictEqual(isSectionWithheld(filtered, 'current_task'), false, 'a SHARED section is not withheld');
  assert.strictEqual(isSectionWithheld(owned, 'todo_items'), false, 'the author sees no marker');
});

test('an unknown section name still reads as words', () => {
  assert.deepStrictEqual(
    withheldSectionLabels({ withheld_sections: ['some_new_section'] } as never),
    ['some new section'],
  );
});
