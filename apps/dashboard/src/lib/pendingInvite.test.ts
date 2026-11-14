// The invite round trip for somebody with no account: park the token, detour
// through sign-up, come back and redeem it. Each helper here is one hop that
// used to drop the invitation.
import test from 'node:test';
import assert from 'node:assert';
import {
  PENDING_INVITE_TTL_MS,
  inviteAuthPath,
  inviteFailureMessage,
  invitePath,
  parsePendingInvite,
  shouldRedirectToPendingInvite,
} from './pendingInvite';
import { getSafeRedirectPath } from './redirects';

test('the auth detour carries a return path the login/signup guard accepts', () => {
  const path = inviteAuthPath('tok en/+', 'signup');
  assert.ok(path.startsWith('/signup?redirect_url='));
  const returned = new URLSearchParams(path.split('?')[1]).get('redirect_url');
  assert.strictEqual(returned, invitePath('tok en/+'));
  // If getSafeRedirectPath rejected it, sign-in would fall back to "/" and the
  // invitation would be lost again.
  assert.strictEqual(getSafeRedirectPath(returned), returned);
  assert.strictEqual(new URLSearchParams(returned!.split('?')[1]).get('token'), 'tok en/+');
  assert.ok(inviteAuthPath('t', 'login').startsWith('/login?redirect_url='));
});

test('a parked token is honoured within its window and not after', () => {
  const now = 1_000_000_000;
  const stored = JSON.stringify({ token: 'abc', at: now });
  assert.strictEqual(parsePendingInvite(stored, now + 1000), 'abc');
  assert.strictEqual(parsePendingInvite(stored, now + PENDING_INVITE_TTL_MS + 1), null);
  for (const junk of [null, '', 'not json', '{}', JSON.stringify({ token: '', at: now }), JSON.stringify({ token: 'x' })]) {
    assert.strictEqual(parsePendingInvite(junk, now), null);
  }
});

test('a pending invite never pulls the reader off a sign-in or an OAuth handshake', () => {
  for (const path of ['/login', '/signup', '/forgot-password', '/mcp-auth', '/oauth/consent', '/oauth/sso-callback', '/invite', '/checkout']) {
    assert.strictEqual(shouldRedirectToPendingInvite(path), false, path);
  }
  for (const path of ['/', '/onboarding', '/projects', '/settings/team']) {
    assert.strictEqual(shouldRedirectToPendingInvite(path), true, path);
  }
});

test('each refusal reason gets its own message', () => {
  assert.match(inviteFailureMessage('wrong_account', 'sam@acme.com'), /sam@acme\.com/);
  assert.match(inviteFailureMessage('expired', undefined), /expired/);
  assert.match(inviteFailureMessage('already_accepted', undefined), /already been used/);
  assert.match(inviteFailureMessage(undefined, undefined), /invalid or has been revoked/);
});

test('a workspace that cannot take people is not a bad link', () => {
  // The API answers 409 workspace_not_accepting_members with a sentence that
  // names the workspace. The page used to fall through to "invalid or has been
  // revoked", which is false: the link works again once the workspace can take people.
  const server = 'Acme Engineering is not accepting new members right now. Ask the person who invited you.';
  assert.equal(inviteFailureMessage('workspace_not_accepting_members', undefined, server), server);
  assert.doesNotMatch(inviteFailureMessage('workspace_not_accepting_members', undefined), /invalid|revoked/);
});
