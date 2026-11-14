import test from 'node:test';
import assert from 'node:assert';
import { createdWorkspace, readNewTeamArrival } from './newTeamCheckout';

test('the wizard reads how it was opened', () => {
  assert.deepStrictEqual(readNewTeamArrival({}), { resume: false, workspace: null, canceled: false });
  assert.deepStrictEqual(
    readNewTeamArrival({ resume: '1', workspace: 'org-1' }),
    { resume: true, workspace: 'org-1', canceled: false },
  );
  // A workspace with no resume flag is not a return from a payment.
  assert.strictEqual(readNewTeamArrival({ workspace: 'org-1' }).resume, false);
  // Resume with nothing to resume into is nothing.
  assert.strictEqual(readNewTeamArrival({ resume: '1' }).resume, false);
  assert.strictEqual(readNewTeamArrival({ canceled: 'true' }).canceled, true);
});

test('the created workspace is found only in the person\'s own listing, as its owner', () => {
  const listing = { workspaces: [
    { workspace: 'org-home', name: 'Home', role: 'owner' },
    { workspace: 'org-new', name: 'Acme', role: 'owner' },
    { workspace: 'org-theirs', name: 'Theirs', role: 'member' },
  ] };
  assert.deepStrictEqual(createdWorkspace(listing, 'org-new'), { workspace: 'org-new', name: 'Acme' });
  // Not there yet (the webhook has not landed): keep waiting.
  assert.strictEqual(createdWorkspace(listing, 'org-later'), null);
  // A link naming a workspace the person only belongs to is not this checkout's.
  assert.strictEqual(createdWorkspace(listing, 'org-theirs'), null);
  assert.strictEqual(createdWorkspace(null, 'org-new'), null);
  assert.strictEqual(createdWorkspace(listing, null), null);
});
