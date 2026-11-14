/**
 * The sharing panel must SHOW the permission it writes.
 *
 * The first version offered one tick per section and derived `can_edit` from a
 * rule of its own, so it decided about WRITING while displaying only READING —
 * and because there was no edit control anywhere, a section turned off and back
 * on came back read-only for good.
 *
 * shareSections.test.ts pins the behaviour of the helpers. This pins that the
 * page actually renders both controls and feeds them the project's real
 * permissions, because a helper that computes the right answer is worth nothing
 * if the screen never asks it. Comment-blind: a comment about the edit control
 * must not satisfy the test that requires the edit control.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (rel) => stripComments(fs.readFileSync(path.join(root, rel), 'utf8'));

test('the picker renders a read control AND an edit control per section', () => {
  const team = read('src/pages/settings/team.tsx');
  assert.match(team, /can read it/, 'the read control lost its label');
  assert.match(
    team,
    /can change it/,
    'the edit control is gone: the panel is deciding about writing without showing it, which is ' +
    'how the decision log became read-only with no way back'
  );
  assert.match(
    team,
    /onToggle\(sectionKey, 'edit'/,
    'the edit box has to actually toggle the edit permission'
  );
});

test('the picker opens on the permissions the project already grants', () => {
  const team = read('src/pages/settings/team.tsx');
  assert.match(
    team,
    /effectivePermissions\(project\.sections, defaults\)/,
    'the panel must read the project\'s real permissions — the defaults are READ AND WRITE when no ' +
    'rows are stored, and a panel that opens on anything less downgrades on its first save'
  );
  assert.ok(
    !/section_key !== 'recent_decisions'/.test(team + read('src/lib/shareSections.ts')),
    'the hardcoded "everything but the decision log" rule is back; can_edit comes from the edit set'
  );
});

test('the panel only offers the control to somebody the PATCH would accept', () => {
  // 2026-09 scan, defect 4. Every role got the dropdown and the section ticks,
  // and every refusal came back as "Could not change that. Nothing was moved."
  // So a member could not learn that their own project was theirs to share, and
  // a viewer could not learn why nothing ever happened.
  //
  // The rule is not "are you an owner" and cannot be computed here — the
  // project's AUTHOR may change their own whatever their role, and a `personal`
  // project is nobody else's to move, an owner included. The server answers it
  // with the same function the PATCH enforces with; this pins that the panel
  // reads that answer instead of guessing.
  const team = read('src/pages/settings/team.tsx');
  assert.match(
    team,
    /disabled=\{busy === project\.project_id \|\| project\.can_change_visibility === false\}/,
    'the visibility dropdown must be shut for anybody the server would refuse',
  );
  assert.match(
    team,
    /project\.visibility_locked_reason/,
    'and the server\'s reason must be shown, not a generic failure',
  );
  assert.ok(
    !/showToast\('Could not change that\. Nothing was moved\.', 'error'\)/.test(team),
    'the blanket refusal message must not be the only thing a refusal can say',
  );
});
