/**
 * The Memory page's "Add context" modal, Paste text and From file tabs (journey
 * scan round 4 BLOCKED 26): what they send to /seed, and what they tell the
 * person about the answer. The API side is pinned by
 * apps/api/tests/integration/journey-r5-import-file-source.test.js, which posts
 * these same bodies.
 */
import test from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fileImportBody, parseContextText, TEXT_NOT_STORED_NOTE } from './addContextPayload';
import { failedMessage, importVerdict } from './importOutcome';

test('text with no numbered headers goes as one project, source file_import', () => {
  const body = fileImportBody('Notes on the berth planner, in no particular structure.');
  assert.strictEqual(body.source, 'file_import');
  assert.deepStrictEqual(body.projects, [{
    name: 'Imported context',
    conversations: [{ messages: [{ role: 'user', text: 'Notes on the berth planner, in no particular structure.' }] }],
  }]);
});

test('numbered headers split into one project each, named from the header', () => {
  const text = '1. HARBOR LEDGER\n' + 'a'.repeat(60) + '\n2. Tide Tables / Feed\n' + 'b'.repeat(60);
  const projects = parseContextText(text);
  assert.deepStrictEqual(projects.map((p) => p.name), ['Harbor Ledger', 'Tide Tables Feed']);
});

test('numbered sections that are all thin do not become an empty list, which /seed refuses', () => {
  const projects = parseContextText('1. Berths\nshort\n2. Pilots\nshort');
  assert.strictEqual(projects.length, 1);
  assert.strictEqual(projects[0].name, 'Imported context');
});

test('the verdict: only a created project is a save', () => {
  assert.strictEqual(importVerdict({ projects_created: 1 }), 'saved');
  assert.strictEqual(importVerdict({ projects_created: 1, errors: [{ project: 'x', error: 'boom' }] }), 'saved');
  assert.strictEqual(importVerdict({ projects_created: 0, not_processed: [{ project: 'x', project_id: 'p' }] }), 'not_processed');
  assert.strictEqual(importVerdict({ projects_created: 0, errors: [{ project: 'x', error: 'not_persisted' }] }), 'failed');
  assert.strictEqual(importVerdict({ projects_created: 0, projects_skipped: 1, errors: [] }), 'nothing');
  assert.strictEqual(importVerdict(null), 'nothing');
});

test('the failure sentences say what was not saved', () => {
  assert.strictEqual(failedMessage(2, false), 'Nothing was saved: 2 projects could not be saved. Please try again.');
  assert.strictEqual(failedMessage(1, true), '1 project could not be saved.');
});

test('the modal sends file_import through the shared body, and never reads a refusal as a success', () => {
  const root = join(import.meta.dirname, '../..');
  const modal = readFileSync(join(root, 'src/components/dashboard/AddFromClaudeModal.tsx'), 'utf8');
  assert.ok(/fileImportBody\(/.test(modal), 'the modal builds the Paste text / From file body itself');
  assert.ok(!/source: 'file_import'/.test(modal), 'the modal hard-codes the source');
  assert.ok(/importVerdict\(/.test(modal), 'the modal does not read what /seed said happened');
  const nothing = modal.indexOf('>Nothing added<');
  const added = modal.indexOf('>Context added<');
  assert.ok(nothing > -1, 'a thin import has no state of its own, so it reads as "Context added"');
  assert.ok(nothing < added, 'the "Nothing added" state must be chosen before the "Context added" one');
});

test('the Paste text and From file tabs say the text is summarised, not stored as-is, in the pricing page\'s terms', () => {
  assert.strictEqual(
    TEXT_NOT_STORED_NOTE,
    'The extraction model summarises this text into your brief. The text itself is not stored.',
  );
  const root = join(import.meta.dirname, '../..');
  const modal = readFileSync(join(root, 'src/components/dashboard/AddFromClaudeModal.tsx'), 'utf8');
  const shown = modal.match(/\{TEXT_NOT_STORED_NOTE\}/g) || [];
  assert.strictEqual(shown.length, 2, 'the note must show on both the Paste text and From file tabs');
});

// The marketing /pricing page only exists in the private repo (the public export
// does not ship apps/marketing), so its half of the check skips without it.
const PRICING_PAGE = join(import.meta.dirname, '../../../marketing/src/pages/pricing.tsx');
test('the pricing page makes the claim the note repeats', {
  skip: existsSync(PRICING_PAGE) ? false : 'apps/marketing is not in this checkout (private repo only)',
}, () => {
  const pricing = readFileSync(PRICING_PAGE, 'utf8');
  assert.ok(/processed to build the brief and then discarded/.test(pricing), 'premise: the public claim this line repeats');
});
