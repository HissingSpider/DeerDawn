// A FAILED EXPORT STOPS THE DELETION, AND THE DIALOG SAYS SO (journey r5).
//
// DELETE /api/v1/orgs answers 502 `export_not_sent` when the export was asked
// for and not emailed, and deletes nothing. The dialog shows the reason and
// offers a retry, and its export line says the export also carries every
// workspace that closes with the account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => {
  try { return readFileSync(path.resolve(here, rel), 'utf8'); } catch { return ''; }
};
const load = async () => {
  try { return await import('./accountClose'); } catch { return {} as Record<string, any>; }
};

test('export_not_sent is a notice; every other failure is not', async () => {
  const m = await load();
  assert.equal(typeof m.exportNotSentNotice, 'function', 'THE BUG: nothing turned the refusal into a notice');
  assert.equal(
    m.exportNotSentNotice('export_not_sent', 'Your export could not be emailed, so nothing was deleted. Try again, or turn off the export option to delete without one.'),
    'Your export could not be emailed, so nothing was deleted. Try again, or turn off the export option to delete without one.',
  );
  assert.match(m.exportNotSentNotice('export_not_sent', ''), /nothing was deleted/, 'the server\'s words are missing: the same sentence anyway');
  assert.equal(m.exportNotSentNotice('invalid_password', 'x'), null);
  assert.equal(m.exportNotSentNotice(undefined), null);
});

test('the dialog shows the notice, offers a retry, and the export line names closed workspaces', async () => {
  const m = await load();
  assert.match(String(m.EXPORT_ALSO_CLOSED_WORKSPACES), /also includes any other workspace that closes with your account/);
  const dialog = read('../components/dashboard/DeleteAccountDialog.tsx');
  assert.match(dialog, /exportNotSentNotice\(apiErrorReason\(err\)/, 'the refusal is read from the error');
  assert.match(dialog, /role="alert"[^>]*>\{exportError\}/, 'and shown');
  assert.match(dialog, /exportError \? 'Try again' : 'Delete account'/, 'the button becomes a retry');
  assert.match(dialog, /\{EXPORT_ALSO_CLOSED_WORKSPACES\}/, 'the export line carries the sentence');
});

test('the server sends the code the dashboard reads', () => {
  const route = read('../../../api/src/routes/shared/orgs.js');
  assert.match(route, /error: 'export_not_sent'/);
});
