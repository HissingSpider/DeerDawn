// A PAGE LOADED WITH A STORED CHOICE (see pageWorkspace.test.ts for why).
//
// A new tab or a reload opens in the person's most recent choice, as it always
// has: the choice stored in this browser when there is one, which costs no
// extra request. What changed is that the page then KEEPS it: another tab
// choosing personal (which clears the stored choice) used to turn every later
// request from this team page into a header-less one, answered in whatever the
// server held, and the team's project was filed as the person's private one.
import test from 'node:test';
import assert from 'node:assert';

type Call = { url: string; method: string; headers: Record<string, string> };
const calls: Call[] = [];
const store = new Map<string, string>([['deerdawn.activeWorkspace', 'org-olivia-studio']]);

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
  calls.push({ url, method: (init.method || 'GET').toUpperCase(), headers: { ...init.headers } });
  return new Response(JSON.stringify({ projects: [], project: { project_id: 'p' } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

test('a page loaded with a stored team choice names it at once, and keeps it when another tab goes personal', async () => {
  const { api, getActiveWorkspace } = await import('./api');
  await api.getContextProjects();
  assert.strictEqual(calls.length, 1, 'a stored choice needs no listing round trip');
  assert.strictEqual(calls[0].headers['x-deerdawn-workspace'], 'org-olivia-studio');

  // Another tab picks personal: the stored choice is removed.
  store.delete('deerdawn.activeWorkspace');
  calls.length = 0;
  await api.createContextProject({ project_name: 'TeamProject' });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].headers['x-deerdawn-workspace'], 'org-olivia-studio');
  assert.strictEqual(getActiveWorkspace(), 'org-olivia-studio');
});
