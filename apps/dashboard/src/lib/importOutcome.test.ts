/**
 * An import no model processed must say so, and must not read as a success.
 *
 * Journey scan round 4, the owner's decision: when no extraction model answers,
 * /api/v1/context/seed saves nothing from the conversation (it used to copy the
 * longest message into the brief), keeps the project under the name it was
 * sent with, and lists it in `not_processed`. These are the sentences both
 * import surfaces show for it.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { notProcessedMessage, notProcessedOf } from './importOutcome';

test('an import every project of which was processed says nothing about it', () => {
  assert.strictEqual(notProcessedMessage({ projects_created: 2, not_processed: [] }), null);
  // An API that predates the list.
  assert.strictEqual(notProcessedMessage({ projects_created: 1 }), null);
  assert.strictEqual(notProcessedMessage(null), null);
  assert.deepStrictEqual(notProcessedOf(undefined), []);
});

test('one project not processed: what happened, what was saved, what to do', () => {
  assert.strictEqual(
    notProcessedMessage({ projects_created: 0, not_processed: [{ project: 'Tide Tables', project_id: 'p1' }] }),
    'The conversations for “Tide Tables” could not be processed, so nothing from them was saved. '
      + 'The project is kept under its name, with an empty brief. Please try the import again.',
  );
});

test('several, and one that could not even be kept (a refused create): each named, nothing overclaimed', () => {
  assert.strictEqual(
    notProcessedMessage({
      not_processed: [
        { project: 'Tide Tables', project_id: 'p1' },
        { project: 'Berths', project_id: 'p2' },
      ],
    }),
    'The conversations for “Tide Tables” and “Berths” could not be processed, so nothing from them was saved. '
      + 'The projects are kept under their names, with empty briefs. Please try the import again.',
  );
  assert.strictEqual(
    notProcessedMessage({
      not_processed: [
        { project: 'Tide Tables', project_id: 'p1' },
        { project: 'Berths', project_id: null },
        { project: 'Pilots', project_id: null },
      ],
    }),
    'The conversations for “Tide Tables”, “Berths” and “Pilots” could not be processed, so nothing from them was saved. '
      + '“Tide Tables” is kept under its name, with an empty brief. Please try the import again.',
  );
  assert.strictEqual(
    notProcessedMessage({ not_processed: [{ project: 'Berths', project_id: null }] }),
    'The conversations for “Berths” could not be processed, so nothing from them was saved. Please try the import again.',
  );
});

/**
 * Both surfaces that call /seed show the sentence. The Memory page's modal used
 * to answer every import with a check mark and "Context added"; the import page
 * with "0 projects imported" and a line about thin conversations. Neither is
 * what happened when no model answered.
 */
test('both import surfaces show it, and the modal has its own not-processed state', () => {
  const root = join(import.meta.dirname, '../..');
  const page = readFileSync(join(root, 'src/pages/context/import.tsx'), 'utf8');
  const modal = readFileSync(join(root, 'src/components/dashboard/AddFromClaudeModal.tsx'), 'utf8');
  for (const [name, code] of [['context/import.tsx', page], ['AddFromClaudeModal.tsx', modal]] as const) {
    assert.ok(/notProcessedMessage\(/.test(code), `${name} does not show the not-processed sentence`);
    assert.ok(/notProcessedOf\(/.test(code), `${name} does not read the not-processed list`);
  }
  const notProcessedState = modal.indexOf('>Not processed<');
  const addedState = modal.indexOf('>Context added<');
  assert.ok(notProcessedState > -1, 'the modal has no not-processed state');
  assert.ok(notProcessedState < addedState, 'the not-processed state must be chosen before the "Context added" one');
  assert.ok(/not processed<\/span>/.test(page), 'the import page heading does not count what was not processed');
});
