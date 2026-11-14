// A RETURN LINK NAMING A WORKSPACE THE PERSON IS NOT IN (see
// pageWorkspaceLinked.test.ts). The name in the link is not an authority: the
// page opens where it would have opened without the link, with no error, and
// the named workspace is never sent to the server.
import test from 'node:test';
import assert from 'node:assert';

type Call = { url: string; method: string; headers: Record<string, string> };
const calls: Call[] = [];
const OLIVIA = 'org-olivia-studio';
const MARCUS = 'org-marcus-garage';
const STRANGER = 'org-somebody-elses-team';
const store = new Map<string, string>([['deerdawn.activeWorkspace', OLIVIA]]);

(globalThis as any).window = {
  location: {
    hostname: 'localhost',
    origin: 'http://localhost:3000',
    pathname: '/settings/plan',
    search: `?workspace=${STRANGER}`,
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
      active: MARCUS,
      fallback: null,
      workspaces: [
        { workspace: MARCUS, name: 'Marcus Garage', role: 'owner', personal: true, team_enabled: false },
        { workspace: OLIVIA, name: 'Olivia Studio', role: 'member', personal: false, team_enabled: true },
      ],
    }
    : { projects: [] };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

test('a link naming a workspace the person is not in opens where the page would have opened anyway', async () => {
  const { api, getActiveWorkspace } = await import('./api');
  await api.getContextProjects();
  const bound = calls.filter((c) => !c.url.endsWith('/api/v1/teams/workspaces'));
  assert.strictEqual(bound.length, 1);
  assert.strictEqual(bound[0].headers['x-deerdawn-workspace'], OLIVIA, 'the most recent choice, as without the link');
  assert.ok(!calls.some((c) => c.headers['x-deerdawn-workspace'] === STRANGER), 'the foreign workspace was sent to the server');
  assert.strictEqual(getActiveWorkspace(), OLIVIA);
  assert.strictEqual(store.get('deerdawn.activeWorkspace'), OLIVIA, 'the stored choice is untouched');
});
