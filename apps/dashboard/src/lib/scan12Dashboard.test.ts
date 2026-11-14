// Scan 12, dashboard. Each test names the defect it pins. Modules are loaded
// per test (and new ones tolerated as missing) so that, run against a tree
// without the fix, each test fails on its own assertion instead of the whole
// file failing to load.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

(globalThis as any).window ??= {
  location: { hostname: 'localhost', origin: 'http://localhost:3000', pathname: '/', hash: '' },
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
};

const load = async (path: string): Promise<any> => {
  try {
    return await import(path);
  } catch {
    return {};
  }
};

const NO_EM_DASH = /—/;
const source = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

// ── Defect 1: domain join failed silently, and was bound to the stored workspace ──

test('D1: listing and accepting a domain offer never carry the stored workspace header', async () => {
  const { sendsWorkspaceHeader } = await load('./api');
  assert.strictEqual(sendsWorkspaceHeader('/api/v1/teams/joinable'), false);
  assert.strictEqual(sendsWorkspaceHeader('/api/v1/teams/joinable?x=1'), false);
  assert.strictEqual(sendsWorkspaceHeader(`/api/v1/teams/joinable/${encodeURIComponent('org-acme')}/accept`), false);
  assert.strictEqual(sendsWorkspaceHeader(`/api/v1/teams/joinable/${encodeURIComponent('org/a b')}/accept`), false);
  // Anchored: nothing else under /teams stops being workspace-bound.
  assert.strictEqual(sendsWorkspaceHeader('/api/v1/teams/joinable/org-acme'), true);
  assert.strictEqual(sendsWorkspaceHeader('/api/v1/teams/joinable/a/b/accept'), true);
  assert.strictEqual(sendsWorkspaceHeader('/api/v1/teams/joinable/org-acme/accept/x'), true);
  assert.strictEqual(sendsWorkspaceHeader('/api/v1/teams/domains'), true);
  assert.strictEqual(sendsWorkspaceHeader('/api/v1/teams/invite'), true);
});

function refusal(ApiError: any, status: number, body: Record<string, unknown>) {
  return new ApiError(status, String(body.message || body.error), undefined, undefined, undefined, body);
}

test('D1: a refused domain join says why, and does not enter the workspace', async () => {
  const { ApiError } = await load('./api');
  const mod = await load('./domainJoin');
  assert.strictEqual(typeof mod.joinWorkspaceByDomain, 'function', 'the join outcome is decided in lib/domainJoin');
  const offer = { workspace: 'org-acme', name: 'Acme' };
  const cases: Array<[number, Record<string, unknown>, RegExp, boolean]> = [
    [402, { error: 'limit_exceeded', message: 'You have reached the limit for included_seats (5). Upgrade to add more.', upgrade_required: true }, /Acme has no free seats/, false],
    [403, { error: 'upgrade_required', message: "Feature 'team_management' requires a higher plan.", upgrade_required: true }, /not on a plan that includes team members/, false],
    [403, { error: 'removed_from_workspace', message: 'You were removed from this workspace. Ask one of its owners to invite you again.' }, /You were removed from this workspace/, true],
    [403, { error: 'not_joinable' }, /no longer open to your email domain/, true],
    [409, { error: 'workspace_inactive', message: "Sam's subscription is inactive, so nothing was changed." }, /workspace you are currently using blocked this, not Acme/, false],
    [403, { error: 'subscription_inactive' }, /Switch to your own workspace/, false],
    [500, { error: 'internal_error' }, /Could not join Acme/, false],
  ];
  for (const [status, body, expected, dropOffer] of cases) {
    const browser: Array<string | null> = [];
    const server: Array<string | null> = [];
    const outcome = await mod.joinWorkspaceByDomain(offer, {
      accept: async () => { throw refusal(ApiError, status, body); },
      setBrowserWorkspace: (w: string | null) => { browser.push(w); },
      setServerWorkspace: async (w: string | null) => { server.push(w); },
    });
    const label = `${status} ${String(body.error)}`;
    assert.strictEqual(outcome.ok, false, label);
    assert.match(outcome.message, expected, label);
    assert.doesNotMatch(outcome.message, /Upgrade to add more|requires a higher plan/, `${label}: owner-facing copy is not shown to the joiner`);
    assert.doesNotMatch(outcome.message, NO_EM_DASH, label);
    assert.strictEqual(outcome.dropOffer, dropOffer, `${label} dropOffer`);
    assert.deepStrictEqual(browser, [], `${label}: a refusal must not switch this browser`);
    assert.deepStrictEqual(server, [], `${label}: a refusal must not switch the server`);
  }
});

test('D1: a successful domain join enters the joined workspace, browser and server', async () => {
  const mod = await load('./domainJoin');
  assert.strictEqual(typeof mod.joinWorkspaceByDomain, 'function');
  const browser: Array<string | null> = [];
  const server: Array<string | null> = [];
  const outcome = await mod.joinWorkspaceByDomain({ workspace: 'org-acme', name: 'Acme' }, {
    accept: async () => ({ success: true, workspace: 'org-acme', role: 'member' }),
    setBrowserWorkspace: (w: string | null) => { browser.push(w); },
    // The server half failing still enters the workspace (the header carries it).
    setServerWorkspace: async (w: string | null) => { server.push(w); throw new Error('500'); },
  });
  assert.deepStrictEqual(outcome, { ok: true, workspace: 'org-acme' });
  assert.deepStrictEqual(browser, ['org-acme']);
  assert.deepStrictEqual(server, ['org-acme']);
  assert.doesNotMatch(mod.domainJoinLabel({ workspace: 'org-acme', name: 'Acme' }, false), NO_EM_DASH);
});

test('D1: the switcher reloads only on success and renders the refusal', () => {
  const nav = source('components/layout/TopNav.tsx');
  assert.match(nav, /joinWorkspaceByDomain\(offer\)/);
  assert.doesNotMatch(nav, /\.finally\(\(\) => window\.location\.reload\(\)\)/, 'reloads whatever happened');
  assert.doesNotMatch(nav, /&mdash;/, 'no em dash in the offer label');
  assert.match(nav, /\{joinError\}/);
});

// ── Defect 2: a native-app consent hand-off stayed on "Returning…" forever ─────

test('D2: a native-scheme redirect gets a follow-up state with a retry; a web one does not', async () => {
  const mod = await load('./consentHandoff');
  assert.strictEqual(typeof mod.planConsentHandoff, 'function', 'the hand-off is decided in lib/consentHandoff');
  const cursor = 'cursor://anysphere.cursor-mcp/oauth/callback?code=abc&state=xyz';
  const native = mod.planConsentHandoff(cursor);
  assert.strictEqual(native.kind, 'native');
  assert.strictEqual(native.href, cursor, 'the retry goes to the same redirect, code and all');
  assert.ok(native.followUpAfterMs >= 1000 && native.followUpAfterMs <= 3000, 'follow up after about 1.5s');
  assert.strictEqual(mod.planConsentHandoff('com.example.app:/cb?code=1').kind, 'native');
  for (const web of ['https://claude.ai/api/mcp/auth_callback?code=1', 'http://localhost:3118/callback?code=1']) {
    assert.deepStrictEqual(mod.planConsentHandoff(web), { kind: 'web', href: web });
  }
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', '', null, 'not a url']) {
    assert.strictEqual(mod.planConsentHandoff(bad).kind, 'invalid', String(bad));
  }
  assert.strictEqual(mod.nativeHandoffMessage('Cursor'), 'Cursor should have opened. You can close this tab.');
  assert.strictEqual(mod.nativeHandoffMessage(null), 'Your AI tool should have opened. You can close this tab.');
  assert.strictEqual(mod.nativeHandoffRetryLabel('Cursor'), 'Open Cursor again');
  for (const text of [mod.nativeHandoffMessage('Cursor'), mod.nativeHandoffHint('Cursor'), mod.nativeHandoffHint(null), mod.INVALID_HANDOFF_MESSAGE]) {
    assert.doesNotMatch(text, NO_EM_DASH);
  }
});

test('D2: the consent page follows up a native hand-off instead of assigning the raw redirect', () => {
  const page = source('pages/oauth/consent.tsx');
  assert.match(page, /planConsentHandoff\(body\.redirect\)/);
  assert.doesNotMatch(page, /window\.location\.href = body\.redirect/);
  assert.match(page, /status === 'handed_off'/);
  assert.match(page, /href=\{handoffHref\}/);
});

// ── Defect 3: a viewer's key was described as one that writes ──────────────────

test('D3: a viewer is told the key reads the workspace but cannot write to it', async () => {
  const keys = await load('./apiKeyCreation');
  assert.strictEqual(typeof keys.keyWorkspaceSentence, 'function', 'the key panel copy is decided in lib/apiKeyCreation');
  const viewer = keys.keyWorkspaceSentence({ name: 'Acme', personal: false, role: 'viewer' });
  assert.match(viewer, /can read Acme but not write to it/);
  assert.doesNotMatch(viewer, /Anything an agent writes/);
  const member = keys.keyWorkspaceSentence({ name: 'Acme', personal: false, role: 'member' });
  assert.match(member, /Anything an agent writes with one lands in that workspace/);
  assert.strictEqual(
    keys.keyWorkspaceSentence({ name: 'Sam', personal: true, role: 'owner' }),
    'Keys you create here belong to Sam, your own workspace.',
  );

  // After minting: the scopes the server granted, where it says.
  assert.deepStrictEqual(keys.grantedKeyScopes({ key: { id: 'k' }, scopes: ['context:read'] }), ['context:read']);
  assert.deepStrictEqual(keys.grantedKeyScopes({ key: { id: 'k', scopes: ['context:read'] } }), ['context:read']);
  assert.strictEqual(keys.grantedKeyScopes({ key: { id: 'k' } }), null, 'an older API says nothing, which is not read-only');
  assert.match(keys.mintedKeyAccessNote(['context:read'], 'Acme'), /can read Acme but not write to it/);
  assert.strictEqual(keys.mintedKeyAccessNote(['context:read', 'context:write'], 'Acme'), null);
  assert.strictEqual(keys.mintedKeyAccessNote(null, 'Acme'), null);
  for (const text of [viewer, keys.mintedKeyAccessNote(['context:read'], null)]) assert.doesNotMatch(text, NO_EM_DASH);

  const page = source('pages/setup.tsx');
  assert.match(page, /keyWorkspaceSentence\(scope\)/);
  assert.match(page, /mintedKeyAccessNote\(newKeyScopes/);
});

// ── Defect 4: the access log claimed "every read" to readers of a filtered log ──

test('D4: a member or viewer is told the access log covers the projects they can see', async () => {
  const mod = await load('./accessLog');
  assert.strictEqual(typeof mod.accessLogDescription, 'function');
  for (const role of ['member', 'viewer', 'Member']) {
    const text = mod.accessLogDescription(role);
    assert.doesNotMatch(text, /^Every read/, role);
    assert.match(text, /projects you can see/, role);
  }
  assert.match(mod.accessLogDescription('owner'), /^Every read, write and export/);
  assert.match(source('pages/settings/audit.tsx'), /description=\{accessLogDescription\(role\)\}/);
});

// ── Defect 5: a refused retry re-parked the invite and trapped the reader ───────

test('D5: a pending invite never pulls the reader off the billing pages', async () => {
  const mod = await load('./pendingInvite');
  for (const path of ['/settings/plan', '/settings/plan/', '/settings/upgrade', '/select-plan', '/checkout']) {
    assert.strictEqual(mod.shouldRedirectToPendingInvite(path), false, path);
  }
  for (const path of ['/', '/projects', '/settings/team', '/settings/planner']) {
    assert.strictEqual(mod.shouldRedirectToPendingInvite(path), true, path);
  }
});

test('D5: a refused accept clears the parked token instead of parking it again', () => {
  const page = source('pages/invite.tsx');
  const catchBlock = page.slice(page.indexOf('} catch (err) {'), page.indexOf('}, [token]);'));
  assert.ok(catchBlock.length > 0, 'found the accept failure path');
  assert.doesNotMatch(catchBlock, /stashPendingInvite\(/, 'the failure path re-parks the token');
  assert.match(catchBlock, /clearPendingInvite\(\)/);
});

// ── Defect 6: removeTeamMember's type omitted rehomed_to ────────────────────────

test('D6: removeTeamMember declares rehomed_to', () => {
  const api = source('lib/api.ts');
  const decl = api.slice(api.indexOf('removeTeamMember:'), api.indexOf('removeTeamMember:') + 200);
  assert.match(decl, /rehomed_to\?: string \| null/);
});
