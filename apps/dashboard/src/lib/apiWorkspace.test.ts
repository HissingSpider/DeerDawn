// The API client's side of two teams defects:
//  - error bodies were parsed for message/code and then thrown away, so every
//    caller that branched on `err.data.error` (invite reasons) was dead code;
//  - a stored workspace the person was removed from was sent on every request,
//    each one 403'd, and the bootstrap read that as an expired session.
import test from 'node:test';
import assert from 'node:assert';

type Call = { url: string; headers: Record<string, string> };
const calls: Call[] = [];
const store = new Map<string, string>();
let respond: (call: Call) => { status: number; body: unknown; headers?: Record<string, string> } =
  () => ({ status: 200, body: {} });

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
(globalThis as any).fetch = async (url: string, init: { headers: Record<string, string> }) => {
  const call = { url, headers: { ...init.headers } };
  calls.push(call);
  const { status, body, headers } = respond(call);
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
  });
};

const load = () => import('./api');

test('ApiError carries the parsed body, and the reason is readable from `error`', async () => {
  const { api, apiErrorReason, isApiError } = await load();
  calls.length = 0;
  respond = () => ({ status: 403, body: { error: 'wrong_account', invited_email: 'sam@acme.com' } });
  await assert.rejects(api.acceptWorkspaceInvite('t'), (err: unknown) => {
    assert.ok(isApiError(err));
    assert.strictEqual(err.data?.invited_email, 'sam@acme.com');
    assert.strictEqual(apiErrorReason(err), 'wrong_account');
    return true;
  });
});

test('a removed member drops the stale workspace and the request succeeds without it', async () => {
  const { api, getActiveWorkspace, setActiveWorkspace } = await load();
  calls.length = 0;
  setActiveWorkspace('org-team');
  respond = (call) => call.headers['x-deerdawn-workspace']
    ? { status: 403, body: { error: 'workspace_forbidden', message: 'You are no longer a member of this workspace.' } }
    : { status: 200, body: { members: [], invites: [] } };
  const roster = await api.getTeam();
  assert.deepStrictEqual(roster, { members: [], invites: [] });
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].headers['x-deerdawn-workspace'], 'org-team');
  assert.strictEqual(calls[1].headers['x-deerdawn-workspace'], undefined);
  assert.strictEqual(getActiveWorkspace(), null);
});

test('any other 403 keeps the stored workspace and is not retried', async () => {
  const { api, getActiveWorkspace, setActiveWorkspace } = await load();
  calls.length = 0;
  setActiveWorkspace('org-team');
  respond = () => ({ status: 403, body: { error: 'forbidden: owners only' } });
  await assert.rejects(api.getTeam());
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(getActiveWorkspace(), 'org-team');
  setActiveWorkspace(null);
});

test('who-am-I and the workspace list never carry the stored workspace', async () => {
  const { api, setActiveWorkspace, sendsWorkspaceHeader } = await load();
  calls.length = 0;
  setActiveWorkspace('org-team');
  respond = (call) => call.url.endsWith('/auth/me')
    ? { status: 200, body: { user: { id: 'u' } } }
    : { status: 200, body: { active: 'org-team', workspaces: [] } };
  await api.getCurrentUser();
  await api.getWorkspaces();
  assert.strictEqual(calls.length, 2);
  for (const call of calls) assert.strictEqual(call.headers['x-deerdawn-workspace'], undefined, call.url);
  assert.strictEqual(sendsWorkspaceHeader('/api/v1/teams/members'), true);
  assert.strictEqual(sendsWorkspaceHeader('/api/v1/auth/me?x=1'), false);
  setActiveWorkspace(null);
});

test('a refused WRITE is not replayed against the personal workspace', async () => {
  // THE DEFECT. The workspace_forbidden recovery replayed whatever the method
  // was. So a removed member with a stale tab who created a project, minted an
  // API key or posted /billing/checkout had that write silently re-aimed at
  // their PERSONAL workspace and succeed there — reported as success, while the
  // page around them still showed the team.
  const { api, getActiveWorkspace, setActiveWorkspace, isApiError } = await load();
  calls.length = 0;
  setActiveWorkspace('org-team');
  respond = (call) => call.headers['x-deerdawn-workspace']
    ? { status: 403, body: { error: 'workspace_forbidden', message: 'You are no longer a member of this workspace.' } }
    // If the replay ever comes back, this is the answer it would get: a real,
    // successful write in the wrong workspace.
    : { status: 201, body: { key: { id: 'key-oops', key: 'dd_live_oops' } } };

  await assert.rejects(api.createKey('Primary key', 'sandbox'), (err: unknown) => {
    assert.ok(isApiError(err));
    assert.strictEqual(err.status, 403);
    assert.strictEqual(err.code, 'workspace_forbidden');
    assert.match(err.message, /Nothing was changed/);
    return true;
  });

  assert.strictEqual(calls.length, 1, 'the write must be sent exactly once, and never without the workspace');
  assert.strictEqual(getActiveWorkspace(), null, 'the stale workspace is still dropped');
});

test('a refused READ is still replayed, which is what the recovery is for', async () => {
  const { api, setActiveWorkspace } = await load();
  calls.length = 0;
  setActiveWorkspace('org-team');
  respond = (call) => call.headers['x-deerdawn-workspace']
    ? { status: 403, body: { error: 'workspace_forbidden' } }
    : { status: 200, body: { projects: [] } };
  await api.getProjectSharing();
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].headers['x-deerdawn-workspace'], undefined);
});

test('the lapsed-workspace fallback header is recorded once, centrally', async () => {
  // THE DEFECT. Under the fallback the API serves a header-less read out of the
  // person's PERSONAL workspace and names the team it declined to use. Nothing
  // in the client read that, so the shell went on rendering the team while the
  // data under it belonged to the reader.
  const { api, getWorkspaceFallbackKey, onWorkspaceFallback, setActiveWorkspace } = await load();
  calls.length = 0;
  setActiveWorkspace(null);
  const seen: (string | null)[] = [];
  const unsubscribe = onWorkspaceFallback((key) => seen.push(key));
  respond = () => ({
    status: 200,
    body: { projects: [] },
    headers: { 'x-deerdawn-workspace-fallback': 'org-acme' },
  });
  await api.getProjectSharing();
  assert.strictEqual(getWorkspaceFallbackKey(), 'org-acme');
  assert.deepStrictEqual(seen, ['org-acme'], 'subscribers are told once, not once per request');
  await api.getProjectSharing();
  assert.deepStrictEqual(seen, ['org-acme']);
  unsubscribe();
  // Choosing a workspace is what clears it: a header describes a request that
  // already happened and says nothing about where the next one goes.
  setActiveWorkspace('org-other');
  assert.strictEqual(getWorkspaceFallbackKey(), null);
  setActiveWorkspace(null);
});

test('a response with no fallback header changes nothing, and neither does an API that never sends one', async () => {
  // Absence is not evidence: only some routes are workspace-bound, and an origin
  // that does not expose the header leaves it unreadable. Clearing on absence
  // made the banner flicker off on the next poll.
  const { api, getWorkspaceFallbackKey, setActiveWorkspace } = await load();
  calls.length = 0;
  setActiveWorkspace(null);
  respond = () => ({ status: 200, body: { projects: [] }, headers: { 'x-deerdawn-workspace-fallback': 'org-acme' } });
  await api.getProjectSharing();
  assert.strictEqual(getWorkspaceFallbackKey(), 'org-acme');
  respond = () => ({ status: 200, body: { projects: [] } });
  await api.getProjectSharing();
  assert.strictEqual(getWorkspaceFallbackKey(), 'org-acme');
  setActiveWorkspace(null);
});

test('a refused write under the fallback is surfaced as-is: no replay, no success', async () => {
  const { api, isApiError, setActiveWorkspace } = await load();
  calls.length = 0;
  // The page is bound to the lapsed team. It used to be modelled as "no stored
  // choice" (header-less, answered in the server's active team); a page now
  // names the workspace it was loaded for, and a page loaded with no stored
  // choice names the server's, so the request is the same one.
  setActiveWorkspace('org-acme');
  respond = () => ({
    status: 409,
    body: {
      error: 'workspace_inactive',
      message: 'Acme’s subscription is inactive, so this workspace is read-only.',
      workspace: 'org-acme',
    },
    headers: { 'x-deerdawn-workspace-fallback': 'org-acme' },
  });
  await assert.rejects(api.createKey('Primary key', 'sandbox'), (err: unknown) => {
    assert.ok(isApiError(err));
    assert.strictEqual(err.status, 409);
    assert.strictEqual(err.data?.error, 'workspace_inactive');
    return true;
  });
  assert.strictEqual(calls.length, 1, 'a refused write is never re-aimed at another workspace');
});
