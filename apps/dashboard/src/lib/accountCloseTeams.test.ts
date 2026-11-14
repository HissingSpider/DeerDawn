// THE DELETE DIALOG SAYS WHAT STAYS.
//
// Journey r4: the delete-account dialog said it "permanently deletes your
// account and all synced context across every project". The shared and private
// projects the person worked on inside a team stay with that team, and only the
// deletion email said so, after the fact. The owner's decision: the dialog says
// it, names the teams, and uses the email's sentence for the same fact
// (apps/api/src/routes/shared/orgs.js contextExportEmailHtml).
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const load = async () => {
  try { return await import('./accountClose'); } catch { return {} as Record<string, any>; }
};

const PERSONAL = { workspace: 'org-marco', name: 'Marco Garage', role: 'owner', personal: true };
const OLIVE = { workspace: 'org-olive', name: 'Olive Studio', role: 'member', personal: false };
const VERA = { workspace: 'org-vera', name: 'Vera Labs', role: 'viewer', personal: false };

test('one team: named, in the email\'s words', async () => {
  const m = await load();
  assert.strictEqual(typeof m.describeTeamWorkThatStays, 'function', 'THE BUG: the dialog had nothing to say about team work');
  assert.strictEqual(m.describeTeamWorkThatStays([PERSONAL, OLIVE]), 'Olive Studio’s shared and private projects stay with it.');
});

test('several teams: each named', async () => {
  const m = await load();
  assert.strictEqual(
    m.describeTeamWorkThatStays?.([PERSONAL, OLIVE, VERA, { workspace: 'org-x', name: '', personal: false }]),
    'The shared and private projects of Olive Studio, Vera Labs and org-x stay with them.',
  );
});

test('nobody in a team, or no listing: nothing is added', async () => {
  const m = await load();
  assert.strictEqual(m.describeTeamWorkThatStays?.([PERSONAL]), null);
  assert.strictEqual(m.describeTeamWorkThatStays?.(null), null);
});

test('the sentence is the deletion email\'s, for the same fact', () => {
  const orgs = readFileSync(join(__dirname, '..', '..', '..', 'api', 'src', 'routes', 'shared', 'orgs.js'), 'utf8');
  assert.match(orgs, /that workspace\\'s shared and private projects stay with it/);
  assert.match(orgs, /the shared and private projects of those workspaces stay with them/);
});

test('the dialog asks which teams the person is in, and says it before the delete', () => {
  const dialog = readFileSync(join(__dirname, '..', 'components', 'dashboard', 'DeleteAccountDialog.tsx'), 'utf8');
  assert.match(dialog, /api\.getWorkspaces\(\)/, 'the existing listing, no new endpoint');
  assert.match(dialog, /describeTeamWorkThatStays\(/);
  const confirm = dialog.slice(dialog.indexOf('Delete your account?'), dialog.indexOf('Email me a full export'));
  assert.match(confirm, /\{teamWorkStays\}/, 'shown in the confirmation, before anything is deleted');
});
