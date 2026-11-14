import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SHARE_SECTION_LABELS,
  effectivePermissions,
  offeredSections,
  sectionLabel,
  sectionRowsFor,
} from './shareSections';

// THE RULE THIS PINS (stated in full where DEFAULT_SHARED_SECTIONS is defined):
// an absent share row means today's defaults, an explicit row means the author's
// choice, and a default added later is never backfilled onto a saved
// configuration. The screen's half of that bargain is that every section can be
// TICKED — an author who configured a share before the task board became a
// default keeps what they chose, and must be able to change their mind.
test('the task board is a section the sharing panel offers', () => {
  const allowlist = ['current_task', 'current_status', 'recent_decisions', 'todo_items'];
  assert.ok(offeredSections(allowlist).includes('todo_items'), 'the board is offerable');
  assert.equal(sectionLabel('todo_items'), 'Task board', 'and named as the board, not as to-dos');
  assert.ok(
    Object.keys(SHARE_SECTION_LABELS).includes('todo_items'),
    'a section with no label would render as a raw key',
  );
});

test('an unlabelled section still renders, by key', () => {
  // The allowlist is the API's, not this file's. A new section must show up on
  // the screen that claims to be the complete list of what travels.
  assert.deepEqual(offeredSections(['something_new']), ['something_new']);
  assert.equal(sectionLabel('something_new'), 'something_new');
});

test('no saved rows shows today\'s defaults, saved rows show the author\'s choice', () => {
  const defaults = ['current_task', 'current_status', 'recent_decisions', 'todo_items'];
  assert.deepEqual(effectivePermissions(undefined, defaults).view, defaults, 'absent means defaults');
  assert.deepEqual(effectivePermissions([], defaults).view, defaults, 'and so does an empty list of rows');

  const saved = [
    { section_key: 'current_task', can_view: true, can_edit: true },
    { section_key: 'todo_items', can_view: false, can_edit: false },
  ];
  assert.deepEqual(
    effectivePermissions(saved, defaults).view,
    ['current_task'],
    'a configured share is never repainted with a default it does not have',
  );
});

// ─── THE FIRST SAVE MUST CHANGE ONLY WHAT WAS CHANGED ────────────────────────
//
// The picker's first save is where a screen that only shows READING silently
// decided about WRITING. On a project with no stored rows the API's own fallback
// (canEditSectionForActor: `DEFAULT_SHARED_SECTIONS.includes(sectionKey)`) makes
// every default section writable — so a first save that wrote `can_edit: false`
// for the decision log took a permission away that the author was never shown,
// never asked about, and, with no edit control on the screen, could not restore.

test('an unconfigured share already grants edit on every default', () => {
  const defaults = ['current_task', 'current_status', 'recent_decisions', 'todo_items'];
  const effective = effectivePermissions(undefined, defaults);

  assert.deepEqual(effective.view, defaults, 'the defaults are what a teammate reads');
  assert.deepEqual(
    effective.edit,
    defaults,
    'and what a teammate WRITES: the no-row fallback is the same list, the decision log included',
  );
});

test('saving the picker untouched preserves the permissions of a moment earlier', () => {
  const defaults = ['current_task', 'current_status', 'recent_decisions', 'todo_items'];
  const offered = ['current_task', 'current_status', 'recent_decisions', 'todo_items', 'goals'];

  const rows = sectionRowsFor(offered, effectivePermissions(undefined, defaults));
  const by = new Map(rows.map((row) => [row.section_key, row]));

  assert.equal(by.get('recent_decisions')?.can_view, true);
  assert.equal(
    by.get('recent_decisions')?.can_edit,
    true,
    'the decision log was shared AND writable a moment earlier; a save that touched nothing must not downgrade it',
  );
  for (const key of defaults) {
    assert.equal(by.get(key)?.can_edit, true, `${key} keeps the write it already had`);
  }
  assert.equal(by.get('goals')?.can_view, false, 'and a section outside the defaults is still not shared');
});

test('a configured share is read back exactly as stored', () => {
  const saved = [
    { section_key: 'current_task', can_view: true, can_edit: true },
    { section_key: 'recent_decisions', can_view: true, can_edit: false },
    { section_key: 'todo_items', can_view: false, can_edit: false },
  ];
  const effective = effectivePermissions(saved, ['current_task', 'recent_decisions', 'todo_items']);

  assert.deepEqual(effective.view, ['current_task', 'recent_decisions'], 'stored rows win over the defaults');
  assert.deepEqual(effective.edit, ['current_task'], 'including a deliberate read-only grant');
});

test('saving writes a row for every offered section, not only the ticked ones', () => {
  // PATCH /projects/:id/sharing writes the DEFAULT rows for an explicit empty
  // sections array, so a ticked-only payload would publish all four defaults at
  // the exact moment somebody unticked everything.
  const offered = ['current_task', 'recent_decisions', 'todo_items'];
  const none = sectionRowsFor(offered, { view: [], edit: [] });
  assert.equal(none.length, 3, 'unticking everything still sends rows');
  assert.ok(none.every((row) => !row.can_view), 'and every one of them is off');

  const some = sectionRowsFor(offered, { view: ['current_task', 'todo_items'], edit: ['current_task'] });
  assert.deepEqual(
    some.map((row) => [row.section_key, row.can_view, row.can_edit]),
    [['current_task', true, true], ['recent_decisions', false, false], ['todo_items', true, false]],
  );
});

test('an unreadable section is never editable, and edit is a control of its own', () => {
  const offered = ['current_task', 'recent_decisions', 'todo_items'];

  // Withholding the read withholds the write — a writer merging into content
  // they cannot see is how one destroys what they never knew was there.
  const withheld = sectionRowsFor(offered, { view: ['current_task'], edit: ['current_task', 'recent_decisions'] });
  assert.equal(
    withheld.find((row) => row.section_key === 'recent_decisions')?.can_edit,
    false,
    'an edit grant on a section nobody can read is not a grant',
  );

  // And the other direction: re-sharing a section that was turned off is not a
  // one-way door. Before this the panel had no edit control at all, so a section
  // unticked and re-ticked came back read-only and stayed that way forever.
  const restored = sectionRowsFor(offered, { view: offered, edit: offered });
  assert.ok(restored.every((row) => row.can_view && row.can_edit), 'the write can be granted back');
});

test('a ticked section outside the offered list is still written', () => {
  // `offered` comes from the server's allowlist. If it ever arrives short of a
  // section the project actually shares, dropping the row would silently
  // unshare it — the panel must never delete what it could not display.
  const rows = sectionRowsFor(['current_task'], { view: ['current_task', 'hot_paths'], edit: ['hot_paths'] });
  assert.deepEqual(
    rows.map((row) => [row.section_key, row.can_view, row.can_edit]),
    [['current_task', true, false], ['hot_paths', true, true]],
  );
});
