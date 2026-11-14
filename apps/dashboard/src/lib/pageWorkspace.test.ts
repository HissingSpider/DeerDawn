// A TAB WRITES WHERE IT SHOWS.
//
// The defect (journey scan round 3, T3-1): the workspace every request named
// was read from ONE localStorage key at the moment of each request, and
// "personal" was the ABSENCE of that key. So a tab showing Marcus's personal
// workspace created a project in the team the moment another tab, another
// device or an accepted invitation moved the shared choice: the page still said
// FREE and listed his own projects, and the project landed in "Olivia Studio",
// shared with every member. The reverse filed a team project as personal.
//
// The owner's decision: every request a page makes names the workspace the page
// was loaded for, personal included, until the person switches IN THAT TAB or
// reloads it. A new page still opens in the most recent choice.
//
// One module instance per file (node --test runs each file in its own
// process), so the tests below are one tab's life in order. The page load with a
// stored choice lives in pageWorkspaceStored.test.ts.
import test from 'node:test';
import assert from 'node:assert';

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
const calls: Call[] = [];
const store = new Map<string, string>();
const STORED_CHOICE = 'deerdawn.activeWorkspace';

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

const MARCUS = 'org-marcus-garage';
const OLIVIA = 'org-olivia-studio';
const VERA = 'org-vera-labs';
// What the SERVER holds as the person's active workspace: the default for new
// pages and for tools. Other tabs and other devices move it.
let serverChoice: string | null = null;
let failServerSwitch = false;

function listing() {
  return {
    active: serverChoice || MARCUS,
    fallback: null,
    workspaces: [
      { workspace: MARCUS, name: 'Marcus Garage', role: 'owner', personal: true, team_enabled: false },
      { workspace: OLIVIA, name: 'Olivia Studio', role: 'member', personal: false, team_enabled: true },
      { workspace: VERA, name: 'Vera Labs', role: 'member', personal: false, team_enabled: true },
    ],
  };
}

(globalThis as any).fetch = async (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => {
  const call = { url, method: (init.method || 'GET').toUpperCase(), headers: { ...init.headers }, body: init.body };
  calls.push(call);
  const path = new URL(url).pathname;
  let status = 200;
  let body: unknown = {};
  if (path === '/api/v1/teams/workspaces') body = listing();
  else if (path === '/api/v1/teams/active' && call.method === 'POST') {
    if (failServerSwitch) { status = 500; body = { error: 'internal_error' }; } else {
      const requested = JSON.parse(init.body || '{}').workspace || null;
      serverChoice = requested === MARCUS ? null : requested;
      body = { success: true, active_workspace: serverChoice };
    }
  } else if (path === '/api/v1/context/projects' && call.method === 'POST') {
    status = 201;
    body = { project: { project_id: 'p-1', project_name: 'TwoTab' } };
  } else if (path === '/api/v1/context/projects') body = { projects: [] };
  else if (path === '/api/v1/keys' && call.method === 'POST') { status = 201; body = { key: { id: 'k-1' } }; }
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
};

const load = () => import('./api');
const named = (call: Call | undefined) => call?.headers['x-deerdawn-workspace'];
const boundCalls = () => calls.filter((call) => !call.url.endsWith('/api/v1/teams/workspaces'));

// What ANOTHER tab does when the person picks a workspace there: it writes the
// shared choice and moves the server's. Neither reaches this tab's memory.
function anotherTabChooses(workspace: string | null) {
  if (workspace && workspace !== MARCUS) store.set(STORED_CHOICE, workspace);
  else store.delete(STORED_CHOICE);
  serverChoice = workspace === MARCUS ? null : workspace;
}

test('a page loaded for personal names personal explicitly, and keeps naming it after another tab switches to the team', async () => {
  const { api, getActiveWorkspace } = await load();
  store.clear();
  serverChoice = null;
  calls.length = 0;

  await api.getContextProjects();
  // Nothing stored in this browser, so the SERVER's choice decides which
  // workspace this page is for, once, before the first bound request.
  assert.ok(calls[0].url.endsWith('/api/v1/teams/workspaces'), 'the page asks where it is before its first bound request');
  assert.strictEqual(named(calls[0]), undefined, 'that question is never bound to a workspace itself');
  assert.strictEqual(named(boundCalls()[0]), MARCUS, 'personal is NAMED, not left for the server to decide');
  assert.strictEqual(getActiveWorkspace(), MARCUS);

  // Tab B switches to the team: the shared choice AND the server's choice move.
  anotherTabChooses(OLIVIA);
  calls.length = 0;
  await api.getContextProjects();
  await api.createContextProject({ project_name: 'TwoTab' });
  await api.createKey('Primary key', 'production');
  assert.strictEqual(calls.length, 3, 'no second resolution once the page knows its workspace');
  for (const call of calls) assert.strictEqual(named(call), MARCUS, `${call.method} ${call.url} still names personal`);
  assert.strictEqual(getActiveWorkspace(), MARCUS, 'the page still reports the workspace it shows');
});

test('another device switching, and an invitation accepted in another tab, do not move this tab either', async () => {
  const { api } = await load();
  // Another device: only the server's choice moves.
  serverChoice = VERA;
  // An invitation accepted in another tab stores the joined workspace.
  store.set(STORED_CHOICE, VERA);
  calls.length = 0;
  await api.createContextProject({ project_name: 'OtherDevice' });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(named(calls[0]), MARCUS);
});

test('switching IN this tab moves this tab, and another tab choosing personal does not move it back', async () => {
  const { api, setActiveWorkspace, getActiveWorkspace } = await load();
  setActiveWorkspace(OLIVIA);
  assert.strictEqual(store.get(STORED_CHOICE), OLIVIA, 'the choice is still shared: a new tab opens here');
  calls.length = 0;
  await api.createContextProject({ project_name: 'TeamProject' });
  assert.strictEqual(named(calls[0]), OLIVIA);

  // The reverse journey: tab B goes personal. This tab shows the team and must
  // go on writing to the team.
  anotherTabChooses(null);
  calls.length = 0;
  await api.getContextProjects();
  await api.createContextProject({ project_name: 'ReverseTwoTab' });
  for (const call of calls) assert.strictEqual(named(call), OLIVIA, `${call.method} ${call.url}`);
  assert.strictEqual(getActiveWorkspace(), OLIVIA);
});

test('choosing personal in this tab names it explicitly, and leaves new tabs to the server as before', async () => {
  const { api, setActiveWorkspace, getActiveWorkspace } = await load();
  anotherTabChooses(OLIVIA);
  setActiveWorkspace(null);
  assert.strictEqual(store.has(STORED_CHOICE), false, 'personal is still stored as no choice, so a new tab follows the server');
  calls.length = 0;
  await api.createContextProject({ project_name: 'MineAgain' });
  assert.strictEqual(calls.length, 1, 'the personal workspace was learnt from the listing: no extra request');
  assert.strictEqual(named(calls[0]), MARCUS);
  assert.strictEqual(getActiveWorkspace(), MARCUS);
  // Naming the personal workspace by its key is the same choice.
  setActiveWorkspace(OLIVIA);
  setActiveWorkspace(MARCUS);
  assert.strictEqual(store.has(STORED_CHOICE), false);
  assert.strictEqual(getActiveWorkspace(), MARCUS);
});

test('routes that deliberately carry no workspace still carry none', async () => {
  const { api, sendsWorkspaceHeader, setActiveWorkspace } = await load();
  setActiveWorkspace(OLIVIA);
  calls.length = 0;
  await api.getWorkspaces();
  await api.acceptWorkspaceInvite('tok').catch(() => undefined);
  await api.getCurrentUser().catch(() => undefined);
  for (const call of calls) assert.strictEqual(named(call), undefined, call.url);
  assert.strictEqual(sendsWorkspaceHeader('/api/v1/teams/joinable/org-x/accept'), false);
  assert.strictEqual(sendsWorkspaceHeader('/api/v1/teams/members'), true);
});

test('a switch to personal whose server half fails leaves this tab where it was', async () => {
  const { api, setActiveWorkspace, getActiveWorkspace, switchToPersonalWorkspace } = await load();
  setActiveWorkspace(OLIVIA);
  failServerSwitch = true;
  try {
    assert.strictEqual(await switchToPersonalWorkspace(), false);
  } finally {
    failServerSwitch = false;
  }
  // The caller says "could not switch" and does not reload, so the page still
  // shows the team: it has to go on writing there too.
  assert.strictEqual(getActiveWorkspace(), OLIVIA);
  assert.strictEqual(store.get(STORED_CHOICE), OLIVIA);
  calls.length = 0;
  await api.createContextProject({ project_name: 'StillTeam' });
  assert.strictEqual(named(calls[0]), OLIVIA);

  assert.strictEqual(await switchToPersonalWorkspace(), true);
  calls.length = 0;
  await api.createContextProject({ project_name: 'NowMine' });
  assert.strictEqual(named(calls[0]), MARCUS);
});
