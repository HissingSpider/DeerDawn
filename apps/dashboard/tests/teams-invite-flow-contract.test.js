/**
 * Wiring for the team invite and workspace flows, read from source.
 *
 * Each assertion is a hop that was verified broken (scan 2026-09-17, findings
 * 3, 4, 5, 7 and 14). The behaviour of the helpers is unit-tested in
 * src/lib/{pendingInvite,teamInvites,apiWorkspace}.test.ts; this pins that the
 * pages actually call them. Comment-blind, so a comment describing the fix does
 * not satisfy the test meant to pin it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (rel) => stripComments(fs.readFileSync(path.join(root, rel), 'utf8'));

test('a signed-out invitee is sent to sign-up with the invitation parked, not to the legacy password form', () => {
  const invite = read('src/pages/invite.tsx');
  const api = read('src/lib/api.ts');
  assert.ok(!api.includes('/api/v1/auth/invite/accept'), 'the legacy users.invite_token_hash accept is back');
  assert.ok(!/acceptInvite\s*:/.test(api), 'api.acceptInvite (legacy) is back');
  assert.ok(!invite.includes('type="password"'), 'the invite page grew a password form again');
  assert.match(invite, /stashPendingInvite\(token\)/);
  assert.match(invite, /goToAuth\('signup'\)/);
  assert.match(invite, /window\.location\.assign\(inviteAuthPath\(token, mode\)\)/);
});

test('/invite renders for a signed-out reader and outside the bootstrap-dependent shell', () => {
  const authProvider = read('src/components/layout/AuthProvider.tsx');
  const app = read('src/pages/_app.tsx');
  const list = authProvider.match(/const PREVIEW_PAGES\s*=\s*\[([^\]]*)\]/);
  assert.ok(list && list[1].includes("'/invite'"), '/invite is not a preview page, so a signed-out invitee bounces to /login');
  const standalone = app.match(/const isStandaloneAuthedPage\s*=([^;]*);/);
  assert.ok(standalone && standalone[1].includes("'/invite'"), '/invite renders inside Layout again');
});

test('a pending invitation is redeemed once the tab has a session, on both auth branches', () => {
  const app = read('src/pages/_app.tsx');
  assert.match(app, /<ClerkPendingInvite \/>/);
  assert.match(app, /<CredentialPendingInvite \/>/);
});

test('switching between sign-in and sign-up keeps the return URL', () => {
  const clerk = read('src/components/ClerkAuthPage.tsx');
  const toggle = clerk.slice(clerk.indexOf('const toggleMode'), clerk.indexOf('const title ='));
  assert.ok(toggle.length > 0, 'could not isolate toggleMode');
  assert.ok(!/router\.push\(isSignup \? '\/login' : '\/signup'/.test(toggle), 'toggleMode pushes a bare path again');
  assert.match(clerk, /query: authQueryWithClerkHash\(router\.query/);
});

test('joining or creating a workspace switches into it on the server as well as in the browser', () => {
  for (const file of ['src/pages/invite.tsx', 'src/pages/settings/new-team.tsx']) {
    const src = read(file);
    assert.match(src, /setActiveWorkspace\(/, `${file} does not switch the browser`);
    assert.match(src, /api\.setActiveWorkspaceOnServer\(/, `${file} leaves agent sessions in the old workspace`);
  }
  assert.match(read('src/pages/invite.tsx'), /result\?\.workspace/, 'the accepted workspace is discarded again');
});

test('an invitation is reported as sent only when the server says the email left', () => {
  const team = read('src/pages/settings/team.tsx');
  assert.ok(!team.includes("showToast('Invitation sent'"), 'the unconditional "Invitation sent" toast is back');
  assert.match(team, /inviteWasEmailed\(result\)/);
  assert.match(team, /<InviteLinkCopy/);
  const wizard = read('src/pages/settings/new-team.tsx');
  assert.match(wizard, /result\.invite_link/, 'the wizard discards invite links again');
  assert.match(wizard, /<InviteLinkCopy/);
  assert.match(wizard, /inviteFailureLabel\(email, status\)/, 'the wizard maps only 402 again');
});

test('a full workspace can buy the seat it needs, and only on purpose', () => {
  // There was no way in the product to add a seat: every purchase path buys the
  // two-seat floor, the third invitation 402s, and the only thing an owner could
  // "upgrade" to was the plan she was already paying for. The arithmetic and the
  // copy are unit-tested in src/lib/teamSeats.test.ts; this pins that the page
  // asks the right questions before spending anybody's money.
  const team = read('src/pages/settings/team.tsx');
  assert.match(team, /canAddSeat\(/, 'the control is offered without asking who may buy a seat');
  assert.match(team, /addSeatRequest\(roster\)/, 'the seat count is built somewhere else again');
  assert.match(team, /api\.setSeatCount\(/, 'the seat change does not reach the billing endpoint');

  const handler = team.slice(team.indexOf('async function addSeat'), team.indexOf('async function changeRole'));
  assert.ok(handler.length > 0, 'could not isolate addSeat');
  assert.ok(
    handler.indexOf('window.confirm') < handler.indexOf('api.setSeatCount'),
    'a seat is bought before the owner is asked',
  );
  assert.match(handler, /addSeatConfirmation\(request, roster\)/);

  // Never on load and never out of the URL: the two ways a money action fires
  // without anybody having decided to.
  assert.ok(!/useEffect\([^)]*addSeat/.test(team), 'a seat purchase is wired to an effect');
  assert.ok(!/router\.query[\s\S]{0,80}seat/i.test(team), 'the seat count is readable out of the URL');
});

test('a lapsed team gets its roster and a billing link, not an upsell', () => {
  const team = read('src/pages/settings/team.tsx');
  assert.match(team, /subscriptionInactive\(/, 'the page cannot tell a lapsed team from one that never had Team');
  // Journey r4: the sentence and the link come from inactiveTeamNotice, which
  // gives an owner SUBSCRIPTION_INACTIVE_LINE and the link, and anybody else who
  // can act (src/lib/billingAccess.test.ts runs it for every role).
  assert.match(team, /inactiveTeamNotice\(roster\)\.line/);
  assert.match(read('src/lib/teamSeats.ts'), /\? \{ line: SUBSCRIPTION_INACTIVE_LINE, billingLink: true \}/);
  assert.match(team, /href="\/settings\/plan"/, 'the banner names no way to fix the bill');
  assert.match(team, /canAdminister && !inactive &&/,
    'the invite form is offered on a workspace whose invitations the server refuses');
});

test('the mobile drawer has the workspace switcher', () => {
  const nav = read('src/components/layout/TopNav.tsx');
  assert.ok((nav.match(/<WorkspaceSwitcher \/>/g) || []).length >= 2, 'the switcher is desktop-only again');
});

test('the board names the advertised task tool', () => {
  const board = read('src/components/dashboard/brief/TaskBoard.tsx');
  assert.ok(!board.includes('manage_todos'), 'TaskBoard tells the AI to call manage_todos, which tools/list does not advertise');
  assert.ok(board.includes('manage_tasks'));
});

test('the dashboard no longer carries the retired POST /api/v1/orgs/users invite', () => {
  const api = read('src/lib/api.ts');
  assert.ok(!/inviteUser\s*:/.test(api), 'api.inviteUser (legacy, now 410 Gone) is back');
});
