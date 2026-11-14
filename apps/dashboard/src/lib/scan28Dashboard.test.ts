// Scan 28, dashboard: closing an account closes every other workspace its person
// was the only one left in, and DELETE /api/v1/orgs names them in
// `closed_workspaces`. The dialog passed on only `export_emailed`, so the
// confirmation never said a workspace had closed, or that its subscription was
// cancelled.
//
// The module is loaded per test and a missing export tolerated, so on a tree
// without the fix each test fails on its own assertion.
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
  try { return await import('./accountClose'); } catch { return {} as Record<string, unknown>; }
};

test('the closed workspaces are named, with what happened to their billing', async () => {
  const mod: any = await load();
  assert.equal(typeof mod.describeClosedWorkspaces, 'function', 'describeClosedWorkspaces is exported');
  assert.equal(mod.describeClosedWorkspaces([]), null);
  assert.equal(mod.describeClosedWorkspaces(undefined), null);
  const one = mod.describeClosedWorkspaces([{ workspace: 'org-1', name: 'Side Team' }]);
  assert.match(one, /“Side Team” closed with your account/);
  assert.match(one, /subscription was cancelled/);
  const two = mod.describeClosedWorkspaces([{ workspace: 'org-1', name: 'Side Team' }, { workspace: 'org-2', name: null }]);
  assert.match(two, /“Side Team” and “org-2” closed with your account/, 'an unnamed workspace is named by its id');
  assert.match(two, /subscriptions were cancelled/);
});

test('the dialog hands closed_workspaces on and shows them before leaving', () => {
  const dialog = read('../components/dashboard/DeleteAccountDialog.tsx');
  assert.match(dialog, /closed_workspaces: Array\.isArray\(result\.closed_workspaces\)/, 'the response field is read');
  assert.match(dialog, /describeClosedWorkspaces\(closedResult\.closed_workspaces\)/, 'the confirmation renders the names');
  const settings = read('../pages/settings.tsx');
  assert.match(settings, /describeClosedWorkspaces\(closed_workspaces\)/, 'the toast names them too');
});

test('the response field the dashboard reads is the one DELETE /orgs sends', () => {
  const route = read('../../../api/src/routes/shared/orgs.js');
  assert.match(route, /closed_workspaces: alsoClosing\.map\(\(ws\) => \(\{ workspace: ws\.id, name: ws\.name \}\)\)/);
});
