// A REMOVED MEMBER'S OPEN TAB RELOADS INTO THEIR OWN WORKSPACE, AND SAYS WHY.
//
// Journey r4: Priya's tab shows the team "Olivia Studio". An owner removes her.
// The tab's next background read is refused (403 workspace_forbidden); the API
// client silently dropped the workspace and replayed the read in her own
// workspace, the shell still said TEAM, and the next thing she saved landed in
// her personal workspace under that badge.
//
// The owner's decision: when ANY request is refused because the person is no
// longer a member, the tab reloads into their own workspace and tells them they
// were removed; nothing is written anywhere in between. The legacy member whose
// own org IS the refusing team keeps the screen built for them.
//
// One module instance per file: these tests are one tab's life in order.
import test from 'node:test';
import assert from 'node:assert';

type Call = { url: string; method: string; headers: Record<string, string> };
const calls: Call[] = [];
const local = new Map<string, string>();
const session = new Map<string, string>();
let reloads = 0;
let removed = false;

const PRIYA = 'org-priya-personal';
const OLIVIA = 'org-olivia-studio';

(globalThis as any).window = {
  location: { hostname: 'localhost', origin: 'http://localhost:3000', pathname: '/', hash: '', reload: () => { reloads += 1; } },
  localStorage: {
    getItem: (k: string) => (local.has(k) ? local.get(k)! : null),
    setItem: (k: string, v: string) => { local.set(k, v); },
    removeItem: (k: string) => { local.delete(k); },
  },
  sessionStorage: {
    getItem: (k: string) => (session.has(k) ? session.get(k)! : null),
    setItem: (k: string, v: string) => { session.set(k, v); },
    removeItem: (k: string) => { session.delete(k); },
  },
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
};

function listing() {
  return {
    active: removed ? PRIYA : OLIVIA,
    fallback: null,
    workspaces: [
      { workspace: PRIYA, name: 'Priya Personal', role: 'owner', personal: true },
      ...(removed ? [] : [{ workspace: OLIVIA, name: 'Olivia Studio', role: 'member', personal: false }]),
    ],
  };
}

(globalThis as any).fetch = async (url: string, init: { method?: string; headers: Record<string, string> }) => {
  const call = { url, method: (init.method || 'GET').toUpperCase(), headers: { ...init.headers } };
  calls.push(call);
  const path = new URL(url).pathname;
  const ws = call.headers['x-deerdawn-workspace'];
  let status = 200;
  let body: unknown = {};
  if (path === '/api/v1/teams/workspaces') body = listing();
  else if (removed && ws === OLIVIA) { status = 403; body = { error: 'workspace_forbidden', message: 'You are no longer a member of this workspace.' }; }
  else if (path === '/api/v1/context/projects' && call.method === 'POST') { status = 201; body = { project: { project_id: 'p-oops' } }; }
  else if (path === '/api/v1/context/projects') body = { projects: [] };
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
};

const load = () => import('./api');
const removal = () => import('./workspaceRemoval');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const writes = () => calls.filter((c) => c.method !== 'GET');

test('THE BUG: after removal, a background read reloads the tab, and nothing is written in between', async () => {
  const { api, getActiveWorkspace } = await load();
  // Absent before this change; the rest of this test runs either way, so on the
  // old code it fails on what the tab DOES, not on a missing import.
  const names = await removal().catch(() => null);
  // The tab loads for the team (the server's active workspace) and is shown its name.
  const shown = await api.getWorkspaces();
  names?.rememberWorkspaceNames(shown.workspaces);
  await api.getContextProjects();
  assert.strictEqual(getActiveWorkspace(), OLIVIA);

  // An owner removes her. The tab's next background read is refused.
  removed = true;
  calls.length = 0;
  await api.getContextProjects().catch(() => undefined);
  await sleep(20);
  assert.strictEqual(reloads, 1, 'THE BUG: the tab silently carried on in her own workspace under the TEAM badge');

  // Between the refusal and the reload the page may still try to save.
  calls.length = 0;
  await assert.rejects(api.createContextProject({ project_name: 'Filed under the TEAM badge' }), (err: any) => {
    assert.strictEqual(err.status, 403);
    assert.strictEqual(err.code, 'workspace_forbidden');
    assert.match(err.message, /Nothing was changed/);
    return true;
  });
  assert.strictEqual(writes().length, 0, 'the write is not sent anywhere: not to the team, not to her own workspace');
});

test('after the reload she is told, once, that she was removed from the team, by name', async () => {
  const { takeRemovalNotice, removalNoticeText } = await removal();
  const notice = takeRemovalNotice();
  assert.ok(notice, 'the reason survives the reload');
  assert.strictEqual(notice!.workspace, OLIVIA);
  assert.strictEqual(
    removalNoticeText(notice!),
    'You are no longer a member of Olivia Studio. A workspace owner removed you, or the workspace was closed. This tab has reloaded into your own workspace.',
  );
  assert.deepStrictEqual(takeRemovalNotice(), notice, 'the same answer for the rest of this page (a remounted component still shows it)');
  const stored = JSON.parse(session.get('deerdawn.removedFromWorkspace')!);
  assert.strictEqual(stored.shown, true, 'and marked shown, so the next page does not say it again');
});

test('the same refusal a moment later does not reload the tab again (no loop)', async () => {
  const { noteRemovedFromWorkspace } = await removal();
  assert.strictEqual(noteRemovedFromWorkspace(OLIVIA, PRIYA), false);
  assert.strictEqual(noteRemovedFromWorkspace(OLIVIA, PRIYA, Date.now() + 120_000), true, 'but a later removal from it does');
});

test('the legacy member refused by their OWN workspace keeps their screen: no reload, no notice', async () => {
  const { noteRemovedFromWorkspace } = await removal();
  session.clear();
  assert.strictEqual(noteRemovedFromWorkspace(PRIYA, PRIYA), false);
  assert.strictEqual(session.size, 0);
  assert.strictEqual(noteRemovedFromWorkspace(null, PRIYA), false, 'a request that named no workspace is not a removal from one');
});

test('with browser storage blocked, the tab still reloads and still writes nothing; only the sentence is lost', async () => {
  const { noteRemovedFromWorkspace, takeRemovalNotice } = await removal();
  const w = (globalThis as any).window;
  const saved = w.sessionStorage;
  Object.defineProperty(w, 'sessionStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  try {
    assert.strictEqual(noteRemovedFromWorkspace('org-another-team', PRIYA), true);
    assert.doesNotThrow(() => takeRemovalNotice());
  } finally {
    Object.defineProperty(w, 'sessionStorage', { configurable: true, value: saved, writable: true });
  }
});

test('every signed-in page can say it: the notice sits in the shell, beside the fallback banner it does not replace', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const shell = readFileSync(join(__dirname, '..', 'components', 'dashboard', 'AppShell.tsx'), 'utf8');
  assert.match(shell, /<WorkspaceFallbackBanner \/>/);
  assert.match(shell, /<WorkspaceRemovedNotice \/>/);
  assert.match(shell, /<WorkspaceForbiddenExit/, 'the legacy member\'s screen is still there');
  const notice = readFileSync(join(__dirname, '..', 'components', 'dashboard', 'WorkspaceRemovedNotice.tsx'), 'utf8');
  assert.match(notice, /takeRemovalNotice\(\)/);
  assert.match(notice, /onWorkspaceListing\(\(listing\) => rememberWorkspaceNames/, 'it learns the team\'s name while the team is still listed');
});
