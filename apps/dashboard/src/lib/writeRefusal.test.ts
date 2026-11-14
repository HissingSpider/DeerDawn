// A refused write is not a failed write. The dashboard turned every
// share_write_forbidden into "Couldn't save that change — rolled back.", which
// reads as a dropped connection: the reader retries, is refused again, and
// nothing on the screen ever says the section is not theirs to edit.
import test from 'node:test';
import assert from 'node:assert';
import { ApiError } from './api';
import { blockedSectionLabels, writeRefusalMessage } from './writeRefusal';

const refusal = (body: Record<string, unknown>, message = 'share_write_forbidden') =>
  new ApiError(403, message, undefined, undefined, undefined, body);

test('a section refusal names the section, in the words the UI uses elsewhere', () => {
  const err = refusal({ error: 'share_write_forbidden', blocked_fields: ['recent_decisions'] });
  const msg = writeRefusalMessage(err);
  assert.ok(msg);
  assert.match(msg, /decisions/);
  assert.match(msg, /read-only/);
  assert.doesNotMatch(msg, /recent_decisions/, 'the raw field key is not a word anybody uses');
  assert.doesNotMatch(msg, /rolled back/);
});

test('several refused sections are all named', () => {
  const err = refusal({ error: 'share_write_forbidden', blocked_fields: ['todo_items', 'open_questions', 'landmines'] });
  const msg = writeRefusalMessage(err) || '';
  assert.match(msg, /task board/);
  assert.match(msg, /open questions/);
  assert.match(msg, /landmines/);
  assert.deepStrictEqual(blockedSectionLabels(err), ['task board', 'open questions', 'landmines']);
});

test('a whole-project refusal uses the server\'s explanation, without the machine prefix', () => {
  const err = refusal(
    { error: 'share_write_forbidden', blocked_fields: [] },
    'share_write_forbidden: you can read this project but not change it, because it is not shared with the workspace. Ask its author to share it.'
  );
  const msg = writeRefusalMessage(err) || '';
  assert.doesNotMatch(msg, /share_write_forbidden/, 'the code is for clients, not for people');
  assert.match(msg, /not shared with the workspace/);
});

test('a refusal whose body carries no message still says something true', () => {
  const msg = writeRefusalMessage(refusal({ error: 'share_write_forbidden' })) || '';
  assert.match(msg, /read-only/);
  assert.doesNotMatch(msg, /share_write_forbidden/);
});

test('an ordinary save failure is NOT claimed as a permission problem', () => {
  // The two must not converge: a 500 or a dropped connection keeps the
  // caller's own "couldn't save, rolled back" wording, because retrying that
  // one really can work.
  assert.strictEqual(writeRefusalMessage(new ApiError(500, 'boom')), null);
  assert.strictEqual(writeRefusalMessage(new ApiError(404, 'project_not_found', undefined, undefined, undefined, { error: 'project_not_found' })), null);
  assert.strictEqual(writeRefusalMessage(new Error('offline')), null);
  assert.strictEqual(writeRefusalMessage(undefined), null);
});

test('a lapsed team refuses the write with 409, and that is not a save failure either', () => {
  // The write surfaces reach this through the SAME helper, so the lapsed-team
  // refusal cannot show up as "couldn't save, rolled back" on one screen and
  // truthfully on another.
  const err = new ApiError(
    409,
    'workspace_inactive',
    undefined,
    undefined,
    undefined,
    { error: 'workspace_inactive', message: 'Acme’s subscription is inactive, so this workspace is read-only.', workspace: 'org-acme' },
  );
  const msg = writeRefusalMessage(err) || '';
  // "Not saved." is its own sentence now: the server's sentence follows it
  // verbatim rather than being lowercased to read on from a colon, which used
  // to recase the name of whichever workspace the server had just named.
  assert.match(msg, /^Not saved\. /);
  assert.ok(msg.includes('Acme’s subscription is inactive'), 'the workspace keeps its name');
  assert.match(msg, /read-only/);
  assert.doesNotMatch(msg, /workspace_inactive/, 'the code is for clients, not for people');
  assert.doesNotMatch(msg, /rolled back/);
  // A different 409 is a different problem and keeps the caller's wording.
  assert.strictEqual(writeRefusalMessage(new ApiError(409, 'conflict', undefined, undefined, undefined, { error: 'last_owner' })), null);
});

test('a full board says so, in the server\'s words, not "rolled back"', () => {
  // 409 board_open_limit_reached: the board is at its open-card limit, nothing
  // was saved, and retrying cannot help until a card is closed. The board
  // showed the generic save-failure toast over it.
  const serverMessage = 'board_open_limit_reached: the board has 300 open cards and the limit is 300, so this card was not added: "Ship retry cap". '
    + 'Nothing was saved. Complete or remove open cards first (manage_tasks action "complete" or "remove"), then add again.';
  const err = new ApiError(409, serverMessage, undefined, undefined, undefined, { error: 'board_open_limit_reached', message: serverMessage });
  const msg = writeRefusalMessage(err) || '';
  assert.match(msg, /^Not saved\. The board has 300 open cards and the limit is 300/);
  assert.ok(msg.includes('"Ship retry cap"'), 'the refused card is named');
  assert.match(msg, /Complete or remove open cards first, then add again\./);
  assert.doesNotMatch(msg, /board_open_limit_reached/, 'the code is for clients, not for people');
  assert.doesNotMatch(msg, /manage_tasks/, 'an MCP instruction means nothing on the dashboard');
  assert.doesNotMatch(msg, /rolled back/);
  // Said once: the toast opens with "Not saved.", so the server's own
  // "Nothing was saved." is not repeated after it.
  assert.strictEqual((msg.match(/not saved|nothing was saved/gi) || []).length, 1, msg);
});

test('a section named twice by the server is named once', () => {
  const err = refusal({ error: 'share_write_forbidden', blocked_fields: ['todo_items', 'todo_items', 'recent_decisions'] });
  assert.strictEqual(blockedSectionLabels(err).length, 2);
  const msg = writeRefusalMessage(err) || '';
  assert.strictEqual((msg.match(/task board/g) || []).length, 1, msg);
});

test('any 409/422 refusal that carries a server sentence shows it; a bare code keeps the caller\'s wording', () => {
  const unprocessable = new ApiError(422, 'x', undefined, undefined, undefined, { error: 'trail_publish_blocked', message: 'Resolve the 2 redaction findings before publishing.' });
  assert.strictEqual(writeRefusalMessage(unprocessable), 'Not saved. Resolve the 2 redaction findings before publishing.');
  // Code only, or a message that is just the code again: nothing to say.
  assert.strictEqual(writeRefusalMessage(new ApiError(409, 'stale', undefined, undefined, undefined, { error: 'stale_write' })), null);
  assert.strictEqual(writeRefusalMessage(new ApiError(409, 'stale_write', undefined, undefined, undefined, { error: 'stale_write', message: 'stale_write' })), null);
  // Other statuses are not refusals this helper speaks for.
  assert.strictEqual(writeRefusalMessage(new ApiError(500, 'boom', undefined, undefined, undefined, { error: 'internal_error', message: 'Something broke.' })), null);
});

test('a refused project action shows the server sentence, not the machine code', async () => {
  const { projectActionRefusal } = await import('./writeRefusal');
  assert.strictEqual(
    projectActionRefusal('share_write_forbidden: this is "Notes", a private project, and only its author can delete it while they are in the workspace. A workspace owner can once the author has left. Ask the author.'),
    'This is "Notes", a private project, and only its author can delete it while they are in the workspace. A workspace owner can once the author has left. Ask the author.',
  );
  assert.strictEqual(projectActionRefusal('Could not archive that project.'), 'Could not archive that project.');
  assert.strictEqual(projectActionRefusal(''), '');
});
