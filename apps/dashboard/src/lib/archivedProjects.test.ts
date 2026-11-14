// A1: a person back after five weeks, whose two projects the nightly job had
// archived, was told on Today "Nothing to pick up yet. Once a tool is connected
// ..." and on Projects "right now there's nothing saved for it to return". Their
// projects were archived, not gone, and restore was one click away behind
// "Manage projects". These tests run the copy the empty states now use.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import {
  ARCHIVED_NAMES_SHOWN,
  AUTO_ARCHIVE_RULE,
  RESTORE_ROUTE,
  archivedProjectsCopy,
} from './archivedProjects';

const project = (name: string, i = 0) => ({ project_id: `project_${i}`, project_name: name });

test('nothing archived: no notice, so a brand-new account keeps its own empty state', () => {
  assert.strictEqual(archivedProjectsCopy([]), null);
  assert.strictEqual(archivedProjectsCopy(null), null);
  assert.strictEqual(archivedProjectsCopy(undefined), null);
});

test('two archived projects: how many, that they are archived and not gone, and their names', () => {
  const copy = archivedProjectsCopy([project('Ledger Dashboard', 1), project('Ledger API', 2)]);
  assert.ok(copy);
  assert.strictEqual(copy.headline, '2 archived projects are waiting, not gone.');
  assert.strictEqual(copy.names, 'Ledger Dashboard · Ledger API');
  assert.match(copy.body, /^Nothing is active right now\./);
  assert.ok(copy.body.includes(AUTO_ARCHIVE_RULE));
  assert.strictEqual(copy.actionLabel, 'Restore a project');
});

test('one archived project is named in the headline', () => {
  const copy = archivedProjectsCopy([project('Ledger API')]);
  assert.ok(copy);
  assert.strictEqual(copy.headline, '“Ledger API” is archived, not gone.');
  assert.strictEqual(copy.names, null);
  assert.match(copy.body, /Everything it remembered is still there\./);
  assert.strictEqual(copy.actionLabel, 'Restore it');
});

test('a long list is capped like the hosted notice', () => {
  const many = Array.from({ length: 7 }, (_, i) => project(`P${i + 1}`, i));
  const copy = archivedProjectsCopy(many);
  assert.ok(copy);
  assert.strictEqual(ARCHIVED_NAMES_SHOWN, 5);
  assert.strictEqual(copy.headline, '7 archived projects are waiting, not gone.');
  assert.strictEqual(copy.names, 'P1 · P2 · P3 · P4 · P5 and 2 more');
});

test('every sentence is one string, so no number runs into its word', () => {
  // JSX drops the space after an expression: "{n} archived" renders "2archived".
  for (const n of [1, 2, 9]) {
    const copy = archivedProjectsCopy(Array.from({ length: n }, (_, i) => project(`Project ${i}`, i)))!;
    for (const text of [copy.headline, copy.names || '', copy.body]) {
      assert.doesNotMatch(text, /\d[A-Za-z]/, text);
      assert.doesNotMatch(text, /\s{2,}/, text);
    }
  }
});

test('the 30-day rule is stated only in the sentence the dashboard already uses', () => {
  const manager = fs.readFileSync(path.join(__dirname, '../components/dashboard/brief/ProjectManager.tsx'), 'utf8');
  assert.strictEqual(AUTO_ARCHIVE_RULE, 'Projects idle for 30 days are archived automatically.');
  // ProjectManager's archived list: "Projects idle for 30 days are archived
  // automatically and show up here." The notice repeats it without the "here".
  assert.ok(
    manager.includes(AUTO_ARCHIVE_RULE.replace(/\.$/, '')),
    'ProjectManager no longer states the rule this notice repeats',
  );
});

test('the action goes to where projects are restored', () => {
  assert.strictEqual(RESTORE_ROUTE, '/projects?manage=archived');
});
