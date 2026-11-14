// Scan 13, dashboard: the browser's saved workspace differs from the server's
// active one, and header-bound reads fall back.
//
// Round 12 made a read that carries x-deerdawn-workspace fall back to the
// person's own workspace when that header names a lapsed team, and say so in
// x-deerdawn-workspace-fallback. GET /teams/workspaces is fetched WITHOUT the
// header, so its `fallback` is computed for the SERVER's active workspace. When
// the member switched to personal on another device, this browser still stores
// the team, the listing answers `fallback: null` about the other binding, and
// servedWorkspace trusted that null over the header this browser's own reads
// carried: shell "Acme", data personal, no banner, and then a write refused
// with 409 naming Acme.
//
// Modules are loaded per test and missing exports tolerated, so on a tree
// without the fix each test fails on its own assertion.
import test from 'node:test';
import assert from 'node:assert';

type Call = { url: string; method: string; headers: Record<string, string> };
const calls: Call[] = [];
const store = new Map<string, string>();
let respond: (call: Call) => { status: number; body: unknown; headers?: Record<string, string> } =
  () => ({ status: 200, body: {} });

(globalThis as any).window = {
  location: { hostname: 'localhost', origin: 'http://localhost:3000', pathname: '/', hash: '', reload: () => {} },
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
  const { status, body, headers } = respond(call);
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
  });
};

const load = async (path: string): Promise<any> => {
  try {
    return await import(path);
  } catch {
    return {};
  }
};

const TEAM = { workspace: 'org-acme', name: 'Acme', role: 'member', personal: false };
const MINE = { workspace: 'org-sam', name: 'Sam', role: 'owner', personal: true };
// Switched to personal on the laptop: the server's active workspace is personal,
// and the listing's fallback, computed for that binding, is null.
const SWITCHED_ELSEWHERE = { active: 'org-sam', workspaces: [TEAM, MINE], fallback: null };

test('stored choice = lapsed team, listing active = personal with fallback null, header = team: served is personal', async () => {
  const { servedWorkspace } = await load('./workspaceFallback');
  const served = servedWorkspace(SWITCHED_ELSEWHERE, 'org-acme', 'org-acme');
  assert.strictEqual(served.stored, 'org-acme', 'the choice is still the team');
  assert.strictEqual(served.served, 'org-sam', 'the reads are the member\'s own');
  assert.ok(served.fallback, 'the listing\'s null is about the other binding, not this browser\'s requests');
  assert.strictEqual(served.fallback.from, 'org-acme');
  assert.strictEqual(served.fallback.fromName, 'Acme');
  assert.strictEqual(served.fallback.to, 'org-sam');
});

test('the reverse: no header recorded, the listing decides and there is no banner', async () => {
  const { servedWorkspace } = await load('./workspaceFallback');
  const served = servedWorkspace(SWITCHED_ELSEWHERE, null, 'org-acme');
  assert.deepStrictEqual(served, { served: 'org-acme', stored: 'org-acme', fallback: null });
  // And a header naming some OTHER workspace is stale, not a banner.
  const stale = servedWorkspace(SWITCHED_ELSEWHERE, 'org-other', 'org-acme');
  assert.strictEqual(stale.fallback, null);
  // With no override, the explicit null still outranks a stale header (the
  // bill-was-paid case this must not regress).
  const paid = servedWorkspace({ active: 'org-acme', workspaces: [TEAM, MINE], fallback: null }, 'org-acme', 'org-acme');
  assert.strictEqual(paid.fallback, null);
  assert.strictEqual(paid.served, 'org-acme');
});

test('the banner names the lapsed team and the served workspace, and the key panel warns', async () => {
  const { servedWorkspace, workspaceFallbackNotice, credentialWorkspace } = await load('./workspaceFallback');
  const { fallback } = servedWorkspace(SWITCHED_ELSEWHERE, 'org-acme', 'org-acme');
  assert.ok(fallback);
  const notice = workspaceFallbackNotice(fallback);
  assert.match(notice, /^Acme’s subscription is inactive\./);
  assert.match(notice, /from your own workspace/);
  assert.ok(!/—/.test(notice));
  const credential = credentialWorkspace(SWITCHED_ELSEWHERE, 'org-acme', 'org-acme');
  assert.strictEqual(credential.workspace, 'org-acme');
  assert.strictEqual(credential.inactive?.from, 'org-acme', 'a key minted here belongs to the lapsed team');
});

test('a fresh listing does not clear the header-bound report under an override', async () => {
  const api = await load('./api');
  assert.strictEqual(typeof api.getWorkspaceFallbackKey, 'function');
  store.clear();
  api.setActiveWorkspace('org-acme');
  calls.length = 0;
  respond = (call) => {
    if (call.url.endsWith('/api/v1/teams/workspaces')) return { status: 200, body: SWITCHED_ELSEWHERE };
    return call.headers['x-deerdawn-workspace'] === 'org-acme'
      ? { status: 200, body: { projects: [] }, headers: { 'x-deerdawn-workspace-fallback': 'org-acme' } }
      : { status: 200, body: { projects: [] } };
  };
  await api.api.getProjectSharing();
  assert.strictEqual(api.getWorkspaceFallbackKey(), 'org-acme', 'the header-bound read reported the fallback');
  await api.api.getWorkspaces();
  assert.strictEqual(api.getWorkspaceFallbackKey(), 'org-acme', 'the listing\'s null is about the laptop\'s binding');
  api.setActiveWorkspace(null);
});

test('without an override the listing\'s null still ends the recorded fallback', async () => {
  const api = await load('./api');
  store.clear();
  // No override: the page is bound to the listing's own `active`. (A page with
  // no stored choice is loaded for the server's choice and now names it; this
  // used to be written as "no stored choice", which meant header-less.)
  api.setActiveWorkspace('org-acme');
  respond = (call) => (call.url.endsWith('/api/v1/teams/workspaces')
    ? { status: 200, body: { active: 'org-acme', workspaces: [TEAM, MINE], fallback: null } }
    : { status: 200, body: { projects: [] }, headers: { 'x-deerdawn-workspace-fallback': 'org-acme' } });
  await api.api.getProjectSharing();
  assert.strictEqual(api.getWorkspaceFallbackKey(), 'org-acme');
  await api.api.getWorkspaces();
  assert.strictEqual(api.getWorkspaceFallbackKey(), null);
});

test('a header-bound gated read answered without the header ends it; an ungated route does not', async () => {
  const api = await load('./api');
  store.clear();
  api.setActiveWorkspace('org-acme');
  respond = () => ({ status: 200, body: {}, headers: { 'x-deerdawn-workspace-fallback': 'org-acme' } });
  await api.api.getProjectSharing();
  assert.strictEqual(api.getWorkspaceFallbackKey(), 'org-acme');
  // /teams/members is exempt from enforcement and never carries the header.
  respond = () => ({ status: 200, body: { members: [], invites: [] } });
  await api.api.getTeam();
  assert.strictEqual(api.getWorkspaceFallbackKey(), 'org-acme', 'absence on an ungated route proves nothing');
  // The bill was paid: a /context read bound to the team is served by the team.
  respond = () => ({ status: 200, body: { preferences: {} } });
  await api.api.getContextPreferences();
  assert.strictEqual(api.getWorkspaceFallbackKey(), null);
  api.setActiveWorkspace(null);
});

test('refreshing under an override asks a gated read, so paying ends the banner without a reload', async () => {
  const api = await load('./api');
  assert.strictEqual(typeof api.refreshWorkspaceListing, 'function');
  store.clear();
  api.setActiveWorkspace('org-acme');
  respond = () => ({ status: 200, body: {}, headers: { 'x-deerdawn-workspace-fallback': 'org-acme' } });
  await api.api.getProjectSharing();
  assert.strictEqual(api.getWorkspaceFallbackKey(), 'org-acme');
  calls.length = 0;
  respond = (call) => (call.url.endsWith('/api/v1/teams/workspaces')
    ? { status: 200, body: SWITCHED_ELSEWHERE }
    : { status: 200, body: { preferences: {} } });
  await api.refreshWorkspaceListing();
  const probe = calls.find((call) => call.url.includes('/api/v1/context/'));
  assert.ok(probe, 'a header-bound read was made');
  assert.strictEqual(probe.headers['x-deerdawn-workspace'], 'org-acme');
  assert.strictEqual(api.getWorkspaceFallbackKey(), null);
  api.setActiveWorkspace(null);
});

test('a refused write puts up the banner that names the same workspace as its message', async () => {
  const api = await load('./api');
  const { servedWorkspace, workspaceFallbackNotice, workspaceInactiveMessage } = await load('./workspaceFallback');
  store.clear();
  api.setActiveWorkspace('org-acme');
  assert.strictEqual(api.getWorkspaceFallbackKey(), null, 'no read has reported anything yet');
  respond = () => ({
    status: 409,
    body: {
      error: 'workspace_inactive',
      message: "Acme's subscription is inactive, so nothing was changed. Switch to your own workspace to keep working, or ask a workspace owner to update billing.",
      workspace: 'org-acme',
    },
  });
  let refusal: unknown = null;
  await api.api.updateContextPreferences({ theme: 'dark' }).catch((err: unknown) => { refusal = err; });
  assert.ok(refusal, 'the write was refused');
  assert.match(String(workspaceInactiveMessage(refusal)), /^Not saved\. Acme's subscription is inactive/);
  assert.strictEqual(api.getWorkspaceFallbackKey(), 'org-acme', 'the refusal names the workspace that is not answering');
  const { fallback } = servedWorkspace(SWITCHED_ELSEWHERE, api.getWorkspaceFallbackKey(), api.getActiveWorkspace());
  assert.ok(fallback, 'the banner is up beside the refusal');
  assert.match(workspaceFallbackNotice(fallback), /^Acme’s subscription is inactive\./);
  api.setActiveWorkspace(null);
});
