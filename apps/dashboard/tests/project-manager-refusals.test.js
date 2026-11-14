/**
 * The "Manage projects" dialog must not offer an action the server refuses.
 *
 * 2026-09 scan, defect 6. Archiving an umbrella that still has live
 * subprojects is refused by design — archiving it would hide work the user is
 * still doing — and the API answers 409. The dialog offered the button anyway,
 * so the refusal read as a failure. Delete has been shut on the same condition,
 * with the reason in its title, since it was written; Archive was not.
 *
 * Source-text and comment-blind, as the other dialog contracts are: this is
 * about a control being OFFERED, which no assertion on a helper can see.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const source = stripComments(
  fs.readFileSync(
    path.resolve(__dirname, '..', 'src/components/dashboard/brief/ProjectManager.tsx'),
    'utf8',
  ),
);

test('Archive is shut for a project with subprojects, with the reason attached', () => {
  const archiveButton = /isLoading=\{busy === `archive:\$\{id\}`\}/.exec(source);
  assert.ok(archiveButton, 'the Archive button moved — re-point this test');

  // The whole <Button ...> element around that marker.
  const start = source.lastIndexOf('<Button', archiveButton.index);
  const end = source.indexOf('>', source.indexOf('Archive', archiveButton.index));
  const element = source.slice(start, end);

  assert.match(element, /disabled=\{busy !== null \|\| hasChildren\}/, 'Archive must be disabled for a parent');
  assert.match(element, /title=\{hasChildren \? '[^']*subprojects[^']*' : undefined\}/, 'and say why');
});

test('Delete keeps the guard it already had', () => {
  assert.match(source, /disabled=\{busy !== null \|\| hasChildren\}[\s\S]{0,400}Delete/);
});
