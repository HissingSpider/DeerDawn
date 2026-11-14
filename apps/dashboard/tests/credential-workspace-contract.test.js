/**
 * A KEY IS MINTED AGAINST THE BOUND WORKSPACE, NOT THE SERVED ONE.
 *
 * When a person's active team is refusing on billing grounds and their browser
 * sends no workspace header, the API serves their NON-exempt reads out of their
 * personal workspace. /api/v1/keys is exempt from plan enforcement by prefix
 * (credential management is a containment action: revoking a leaked key must
 * never wait on a card), and an exempt request is never rebound. So the key is
 * minted against `defaultOwnerKey(actor)`, which is still the lapsed TEAM.
 *
 * /setup picked the workspace for its key panel with `servedWorkspace` and
 * rendered "Keys you create here belong to <you>, your own workspace." The key
 * was the team's: dead with 403 subscription_inactive until somebody paid, and
 * live IN THE TEAM afterwards, where a new project defaults to `shared`. The
 * one page on the dashboard that hands out a long-lived credential promised the
 * exact opposite of what it produced.
 *
 * Source-text, and comment-blind: the comment that explains the trap names the
 * function it is a trap about.
 *
 * Run: `node tests/credential-workspace-contract.test.js` (wired into
 * `npm test -w dashboard`).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const setupPage = stripComments(fs.readFileSync(path.join(root, 'src/pages/setup.tsx'), 'utf8'));
const lib = fs.readFileSync(path.join(root, 'src/lib/workspaceFallback.ts'), 'utf8');

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    process.exitCode = 1;
  }
}

test('the key panel does NOT decide its workspace from what is serving reads', () => {
  assert.ok(
    !/servedWorkspace/.test(setupPage),
    '/setup must not name the served workspace anywhere near the credential it mints',
  );
  assert.ok(
    /credentialWorkspace\(/.test(setupPage),
    '/setup asks which workspace would OWN a key created now',
  );
});

test('the helper it uses reads the BOUND workspace, which is the binding an exempt route keeps', () => {
  // Scan 11: `active` from the header-less listing is the SERVER's choice. POST
  // /keys carries this browser's stored choice, so the helper resolves through
  // boundWorkspace (stored choice when offered, else `active`) and the page
  // hands it that stored choice.
  const body = lib.slice(lib.indexOf('export function credentialWorkspace('));
  assert.ok(body, 'credentialWorkspace must exist');
  assert.ok(/boundWorkspace\(listing, storedChoice\)/.test(body), 'credentialWorkspace resolves the bound workspace');
  const bound = lib.slice(lib.indexOf('export function boundWorkspace('), lib.indexOf('export function boundWorkspaceEntry('));
  assert.ok(/listing\?\.active/.test(bound), 'with no usable stored choice the server `active` still answers');
  assert.ok(
    /credentialWorkspace\(res, getWorkspaceFallbackKey\(\), getActiveWorkspace\(\)\)/.test(setupPage),
    'the key panel passes this browser\'s stored choice',
  );
});

test('a lapsed team is not offered as a silent default for a new credential', () => {
  // The primary action is the one that makes the promise true again, and it is
  // the switch the shell already offers. Minting into the lapsed workspace
  // stays possible, deliberately: its owner may be about to pay, and an owner
  // who knows what they are doing is not the person this protects.
  assert.ok(
    /switchToPersonalWorkspace/.test(setupPage),
    'the panel offers the workspace switch as the way out',
  );
  assert.ok(
    /Use my own workspace/.test(setupPage),
    'named the same way the shell banner names it',
  );
  assert.ok(
    /anyway/i.test(setupPage),
    'an owner may still mint into the workspace they are about to pay for',
  );
});

test('no em dashes and no emoji in the key panel copy', () => {
  // Scoped to the panel this change owns. The rest of /setup carries older
  // copy with its own em dashes, and rewriting it here would be a different
  // change hiding inside this one.
  const start = setupPage.indexOf('function WorkspaceKeyScope');
  assert.notStrictEqual(start, -1, 'the key panel must still be its own component');
  const panel = setupPage.slice(start, setupPage.indexOf('\n}', setupPage.indexOf('return (', start)));
  const strings = panel.match(/`[^`]*`|'[^'\n]*'|"[^"\n]*"/g) || [];
  for (const raw of strings) {
    assert.ok(!/—/.test(raw), `em dash in user-facing copy: ${raw}`);
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(raw), `emoji in copy: ${raw}`);
  }
});

if (!process.exitCode) console.log('\nAll credential-workspace contract checks passed.');
