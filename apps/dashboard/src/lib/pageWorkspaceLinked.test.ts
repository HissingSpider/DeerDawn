// THE RETURN FROM STRIPE OPENS THE WORKSPACE THAT WAS BOUGHT FOR.
//
// The defect (journey scan round 4): after checkout or the billing portal,
// Stripe sends the person back to the dashboard, and the page opened in
// whichever workspace they had used most recently. Somebody who bought Team for
// "Vera Labs" in one tab, while another tab had last switched to "Olivia
// Studio", landed on Olivia Studio, which still said it had not been bought.
//
// The owner's decision: the return link names the workspace the purchase or
// portal session was for (`?workspace=`), and the page opens in it, by the
// mechanism every page already uses to decide its workspace once (see
// pageWorkspace.test.ts). The name is not an authority: the page takes it only
// when the person's own workspace listing includes it (and the server still
// checks membership on every request); pageWorkspaceLinkedForeign.test.ts is a
// link naming a workspace the person is not in.
//
// One module instance per file: this is one page load.
import test from 'node:test';
import assert from 'node:assert';

type Call = { url: string; method: string; headers: Record<string, string> };
const calls: Call[] = [];
const OLIVIA = 'org-olivia-studio';
const VERA = 'org-vera-labs';
const MARCUS = 'org-marcus-garage';
// The most recent choice in this browser, made in ANOTHER tab.
const store = new Map<string, string>([['deerdawn.activeWorkspace', OLIVIA]]);

(globalThis as any).window = {
  location: {
    hostname: 'localhost',
    origin: 'http://localhost:3000',
    pathname: '/',
    // Stripe's success_url, as the API now writes it.
    search: `?upgrade=success&tier=developer_pro&billing=monthly&session_id=cs_test_1&workspace=${VERA}`,
    hash: '',
    reload: () => {},
  },
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  },
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
};

(globalThis as any).fetch = async (url: string, init: { method?: string; headers: Record<string, string> }) => {
  calls.push({ url, method: (init.method || 'GET').toUpperCase(), headers: { ...init.headers } });
  const path = new URL(url).pathname;
  const body = path === '/api/v1/teams/workspaces'
    ? {
      active: OLIVIA,
      fallback: null,
      workspaces: [
        { workspace: MARCUS, name: 'Marcus Garage', role: 'owner', personal: true, team_enabled: false },
        { workspace: OLIVIA, name: 'Olivia Studio', role: 'member', personal: false, team_enabled: true },
        { workspace: VERA, name: 'Vera Labs', role: 'owner', personal: false, team_enabled: true },
      ],
    }
    : { projects: [], project: { project_id: 'p' } };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const named = (call: Call | undefined) => call?.headers['x-deerdawn-workspace'];

test('a page opened from a return link names the workspace in the link, not the most recent choice', async () => {
  const { api, getActiveWorkspace } = await import('./api');
  assert.strictEqual(getActiveWorkspace(), null, 'undecided until the listing says the person may enter the linked workspace');

  await api.getContextProjects();
  assert.ok(calls[0].url.endsWith('/api/v1/teams/workspaces'), 'the link is checked against the person\'s own listing first');
  assert.strictEqual(named(calls[0]), undefined);
  const bound = calls.filter((c) => !c.url.endsWith('/api/v1/teams/workspaces'));
  assert.strictEqual(named(bound[0]), VERA, `the page opened in ${named(bound[0])}, not the workspace that was bought for`);
  assert.strictEqual(getActiveWorkspace(), VERA);
});

test('it keeps naming it, and leaves the most recent choice for new tabs alone', async () => {
  const { api, getActiveWorkspace } = await import('./api');
  calls.length = 0;
  await api.createContextProject({ project_name: 'AfterPurchase' });
  assert.strictEqual(calls.length, 1, 'the link is settled once');
  assert.strictEqual(named(calls[0]), VERA);
  assert.strictEqual(getActiveWorkspace(), VERA);
  assert.strictEqual(store.get('deerdawn.activeWorkspace'), OLIVIA, 'a return link is not a switch: new tabs still open in the most recent choice');
});

test('switching in this tab still moves it', async () => {
  const { api, setActiveWorkspace } = await import('./api');
  setActiveWorkspace(OLIVIA);
  calls.length = 0;
  await api.getContextProjects();
  assert.strictEqual(named(calls[0]), OLIVIA);
});
