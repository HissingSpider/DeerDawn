// Scan 11, dashboard. Each test names the defect it pins. Imported as
// namespaces so that, run against a tree without the fix, each test fails on
// its own assertion instead of the whole file failing to load.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as fallbackModule from './workspaceFallback';
import * as inviteModule from './pendingInvite';
import * as keyModule from './apiKeyCreation';
import * as teamModule from './teamInvites';
import { checkoutAutoSubmitDecision } from './checkoutPlanChange';

type Call = { url: string; method: string; headers: Record<string, string> };
const calls: Call[] = [];
const store = new Map<string, string>();
let respond: (call: Call) => { status: number; body: unknown } = () => ({ status: 200, body: {} });

(globalThis as any).window = {
  location: { hostname: 'localhost', origin: 'http://localhost:3000', pathname: '/', hash: '' },
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  },
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
};
(globalThis as any).fetch = async (url: string, init: { method?: string; headers: Record<string, string> }) => {
  const call = { url, method: (init.method || 'GET').toUpperCase(), headers: { ...init.headers } };
  calls.push(call);
  const { status, body } = respond(call);
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
};

const loadApi = () => import('./api');
const wf = fallbackModule as any;
const inv = inviteModule as any;
const keys = keyModule as any;
const team = teamModule as any;

const TEAM = { workspace: 'org-acme', name: 'Acme', role: 'member', personal: false };
const MINE = { workspace: 'org-sam', name: 'Sam', role: 'owner', personal: true };
// The browser saved Acme; the server's active choice (what the header-less
// listing reports) is the person's own workspace, e.g. switched on another device.
const LISTING = { active: 'org-sam', workspaces: [TEAM, MINE], fallback: null };

// ── Defect 1: invite accept under a lapsed / removed stored workspace ──────────

test('D1: accepting an invitation never carries the stored workspace header', async () => {
  const { api, sendsWorkspaceHeader, setActiveWorkspace } = await loadApi();
  assert.strictEqual(sendsWorkspaceHeader('/api/v1/teams/invite/accept'), false);
  assert.strictEqual(sendsWorkspaceHeader('/api/v1/teams/invite'), true, 'sending an invite stays workspace-bound');
  setActiveWorkspace('org-lapsed-team');
  calls.length = 0;
  respond = () => ({ status: 200, body: { success: true, workspace: 'org-new' } });
  await api.acceptWorkspaceInvite('tok');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].headers['x-deerdawn-workspace'], undefined);
  setActiveWorkspace(null);
});

test('D1: refusals about the bound workspace are named, not called an invalid link', () => {
  for (const reason of ['subscription_inactive', 'past_due', 'workspace_inactive', 'lockdown_active', 'workspace_forbidden']) {
    const message = inv.inviteFailureMessage(reason, undefined, undefined);
    assert.doesNotMatch(message, /invalid or has been revoked/, reason);
    assert.match(message, /still valid/, `${reason} says the link is fine`);
    assert.match(message, /Switch to your own workspace and try again/, `${reason} names the fix`);
    assert.doesNotMatch(message, /—/, 'no em dashes in user-facing copy');
    assert.strictEqual(inv.inviteFailureIsRetryable?.(reason), true, `${reason} offers the own-workspace retry`);
  }
  for (const reason of ['expired', 'revoked', 'already_accepted', 'wrong_account', undefined]) {
    assert.strictEqual(inv.inviteFailureIsRetryable?.(reason), false, `${String(reason)} is about the token`);
  }
  assert.strictEqual(inv.inviteFailureMessage(undefined, undefined), 'This invite link is invalid or has been revoked.');
});

test('D1: the invite page offers the switch on a retryable refusal', () => {
  const source = readFileSync(join(__dirname, '..', 'pages', 'invite.tsx'), 'utf8');
  assert.match(source, /inviteFailureIsRetryable\(reason\)/);
  assert.match(source, /switchToPersonalWorkspace\(\)/);
  assert.match(source, /Use my own workspace and try again/);
});

// ── Defect 2: name the workspace this browser is actually bound to ─────────────

test('D2: the bound workspace is the stored choice when the listing still offers it', () => {
  assert.strictEqual(wf.boundWorkspace?.(LISTING, 'org-acme'), 'org-acme');
  assert.strictEqual(wf.boundWorkspace?.(LISTING, null), 'org-sam', 'no stored choice: the server decides');
  assert.strictEqual(wf.boundWorkspace?.(LISTING, 'org-gone'), 'org-sam', 'a stale choice is not a binding');
  assert.strictEqual(wf.boundWorkspace?.(null, 'org-acme'), null);
});

test('D2: the key panel names the stored team, which is where POST /keys mints', () => {
  const credential = fallbackModule.credentialWorkspace(LISTING, null, 'org-acme' as any);
  assert.strictEqual(credential.workspace, 'org-acme');
  assert.strictEqual(credential.name, 'Acme');
  assert.strictEqual(credential.personal, false, 'must not promise the reader their own workspace');
  assert.strictEqual(credential.role, 'member');
});

test('D2: the switcher and banner read the bound workspace, not the server choice', () => {
  const served = fallbackModule.servedWorkspace(LISTING, null, 'org-acme' as any);
  assert.strictEqual(served.served, 'org-acme');
  assert.strictEqual(served.fallback, null);
  // A fallback the header-less listing reports is about the SERVER's active
  // workspace; a browser bound elsewhere by its stored choice is not served by it.
  const lapsedServerChoice = {
    active: 'org-other',
    workspaces: [TEAM, MINE, { workspace: 'org-other', name: 'Other', role: 'member', personal: false }],
    fallback: { from: 'org-other', to: 'org-sam', reason: 'subscription_inactive' },
  };
  assert.strictEqual(fallbackModule.servedWorkspace(lapsedServerChoice, null, 'org-acme' as any).fallback, null);
  assert.strictEqual(fallbackModule.servedWorkspace(lapsedServerChoice, null).fallback?.from, 'org-other', 'unchanged without a stored choice');
});

test('D2: checkout decides on the workspace the charge goes to, not the server choice', () => {
  const bound = wf.boundWorkspaceEntry?.(LISTING, 'org-acme');
  assert.strictEqual(bound?.workspace, 'org-acme');
  const decision = checkoutAutoSubmitDecision({
    hasSubscription: false,
    workspaceRole: bound?.role ?? null,
    boundIsPersonal: bound ? bound.personal : null,
    targetPlan: 'developer_basic',
  });
  assert.strictEqual(decision.action, 'refuse', 'a member may not buy for the team the charge would land on');
  assert.strictEqual(decision.action === 'refuse' && decision.exit, 'own_workspace');
});

test('D2: a switch to personal whose server half fails reports it', async () => {
  const { switchToPersonalWorkspace, setActiveWorkspace, getActiveWorkspace } = await loadApi();
  setActiveWorkspace('org-acme');
  respond = (call) => (call.url.endsWith('/api/v1/teams/active') ? { status: 500, body: { error: 'internal_error' } } : { status: 200, body: {} });
  assert.strictEqual(await switchToPersonalWorkspace(), false, 'a failed server half is not a switch');
  // Not a half switch either: the caller does not reload, so the page still
  // shows Acme and must go on naming it (journey round 3, "a tab writes where it
  // shows"). It used to be left sending no header, answered in the server's
  // active workspace, which was Acme anyway.
  assert.strictEqual(getActiveWorkspace(), 'org-acme');
  respond = () => ({ status: 200, body: { success: true, active_workspace: null } });
  assert.strictEqual(await switchToPersonalWorkspace(), true);
});

// ── Defect 3: revoke errors read the status, not the prose ─────────────────────

test('D3: an already-revoked key is not reported as a failure', () => {
  const gone = keys.describeKeyRevokeFailure?.({ status: 404, message: 'not_found', data: { error: 'not_found' } });
  assert.strictEqual(gone?.alreadyGone, true);
  const theirs = keys.describeKeyRevokeFailure?.({
    status: 403,
    message: 'This key belongs to someone else. Only its owner or a workspace owner can revoke it.',
    data: { error: 'forbidden', message: 'This key belongs to someone else. Only its owner or a workspace owner can revoke it.' },
  });
  assert.strictEqual(theirs?.alreadyGone, false);
  assert.strictEqual(theirs?.message, 'This key belongs to someone else. Only its owner or a workspace owner can revoke it.');
  const source = readFileSync(join(__dirname, '..', 'pages', 'setup.tsx'), 'utf8');
  assert.doesNotMatch(source, /includes\('404'\)/, 'ApiError.message is the body, never the status');
});

// ── Defect 4: a refused roster offers the plan to an owner, the truth to a member ─

test('D4: the refused roster links an owner to the plan page', () => {
  const owner = team.teamLoadRefusal?.({ status: 403, reason: 'upgrade_required', role: 'owner', personal: true });
  assert.ok(owner?.planLink, 'an upgrade sentence needs the way to upgrade');
  const lapsedOwner = team.teamLoadRefusal?.({ status: 403, reason: 'subscription_inactive', role: 'owner', personal: false });
  assert.strictEqual(lapsedOwner?.planLink?.label, 'Update billing');
});

test('D4: a member of a lapsed team is told only an owner can fix it', () => {
  const member = team.teamLoadRefusal?.({ status: 403, reason: 'subscription_inactive', role: 'member', personal: false });
  assert.strictEqual(member?.planLink, null, 'no billing page a member cannot use');
  assert.match(member?.message || '', /lapsed/);
  assert.match(member?.message || '', /Only a workspace owner/);
  const gated = team.teamLoadRefusal?.({ status: 403, reason: 'upgrade_required', role: 'viewer', personal: false });
  assert.match(gated?.message || '', /Only a workspace owner/);
  const outage = team.teamLoadRefusal?.({ status: 500 });
  assert.strictEqual(outage?.planLink, null);
  assert.match(outage?.message || '', /Try again/);
});

// ── Defect 5: dead client method ────────────────────────────────────────────────

test('D5: the dead getStats client (no /decisions/stats route) is gone', async () => {
  const { api } = await loadApi();
  assert.strictEqual('getStats' in api, false);
});
