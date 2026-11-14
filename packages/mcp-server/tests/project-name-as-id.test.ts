import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DeerdawnClient } from '../src/client.js';
import { handleToolCall } from '../src/tools/index.js';
import { resolveProjectRefs } from '../src/project-ref.js';

/**
 * `project_id` now accepts a project NAME.
 *
 * The model holds names — the brief prints one, the board prints one,
 * recall({ action: "projects" }) prints one with the id in parentheses — so the
 * most natural call it can make was the one that failed, with a 404 about a
 * project the user can plainly see. Resolution happens once, in handleToolCall,
 * so these tests drive the REAL dispatcher rather than a handler in isolation:
 * a tool added tomorrow gets this behaviour without touching this file, and a
 * regression that unhooks the resolver fails here.
 *
 * The two properties worth more than the convenience:
 *   • an id never triggers a lookup (no round-trip on the common path), and
 *   • an ambiguous name REFUSES. Guessing writes one user's memory into another
 *     project, and nothing in this tool can undo that.
 */

const LIVE_PROJECTS = [
  { project_id: 'project_ddapi', project_name: 'DeerDawn API', aliases: ['api'], updated_at: '2026-08-28T00:00:00.000Z' },
  { project_id: 'project_market', project_name: 'Marketing Site', aliases: [], updated_at: '2026-08-27T00:00:00.000Z' },
  // Two live projects that normalize to the same name. The server's creation
  // gate blocks this today, but renames and pre-gate rows still produce it —
  // and it is the case that must never be resolved by picking one.
  { project_id: 'project_twin_a', project_name: 'Billing', aliases: [], updated_at: '2026-08-26T00:00:00.000Z' },
  { project_id: 'project_twin_b', project_name: 'billing', aliases: [], updated_at: '2026-08-25T00:00:00.000Z' },
];

const ARCHIVED_PROJECTS: any[] = [
  { project_id: 'project_aged', project_name: 'Aged Out', archived_at: '2026-07-01T00:00:00.000Z' },
];

let server: http.Server;
let client: DeerdawnClient;
/** Every request the fake API saw, so we can assert what was NOT fetched. */
let seenPaths: string[] = [];

const isProjectList = (url: string) =>
  url.startsWith('/api/v1/context/projects?') || url === '/api/v1/context/projects';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url || '';
    seenPaths.push(url);
    const send = (body: any, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (isProjectList(url)) {
      const archived = /[?&]archived=(1|true)/.test(url);
      if (!archived) return send({ projects: LIVE_PROJECTS });
      // Mirrors the real route: ?limit is honoured and the response is a PAGE.
      // Without modelling the cap, a resolver that silently sees a partial
      // archive looks identical to one that sees all of it.
      const m = /[?&]limit=(\d+)/.exec(url);
      const limit = m ? Number(m[1]) : 10;
      return send({ projects: ARCHIVED_PROJECTS.slice(0, limit), archived: true });
    }

    const hotPaths = /^\/api\/v1\/context\/projects\/([^/]+)\/hot-paths/.exec(url);
    if (hotPaths) {
      const id = decodeURIComponent(hotPaths[1]);
      const project = LIVE_PROJECTS.find((p) => p.project_id === id);
      // An unknown project 404s exactly as the real API does — which is what a
      // name that resolves to nothing must still produce.
      if (!project) return send({ error: 'project_not_found' }, 404);
      return send({ project_id: id, project_name: project.project_name });
    }

    if (url.startsWith('/api/v1/context/active')) return send({ context: null });
    if (url.startsWith('/api/v1/context/map')) return send({ map: '' });

    let body = '';
    req.on('data', (c) => { body += c; });
    return req.on('end', () => send({ ok: true }));
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  client = new DeerdawnClient({
    apiUrl: `http://127.0.0.1:${port}`,
    apiKey: 'dev-key',
    environment: 'sandbox',
    cacheEnabled: false,
    cacheTtlSeconds: 60,
    maxRetries: 1,
    retryBackoffMs: 10,
  } as any);

  // handleToolCall refuses every tool until start_session has run once. Point it
  // at an empty temp dir so it cannot find a CLAUDE.md or a build manifest and
  // take a bootstrap path that writes into the repo.
  process.env.CLAUDE_PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-project-ref-'));
  const started: any = await call('start_session', {});
  expect(started?.isError).toBeFalsy();
});

beforeEach(() => { seenPaths = []; });

afterAll(() => {
  server?.close();
  delete process.env.CLAUDE_PROJECT_DIR;
});

// Declared, not assigned, so beforeAll above can use it.
function call(name: string, args: any): Promise<any> {
  return handleToolCall(name, args, async () => client) as Promise<any>;
}
const textOf = (r: any) => String(r?.content?.[0]?.text ?? '');
const recordPaths = (project_id: string) =>
  call('manage_memory', {
    action: 'record_paths',
    project_id,
    items: [{ label: 'Client', path: 'src/client.ts' }],
  });

describe('project_id accepts a name — through the real dispatcher', () => {
  it('never lists projects when the value already looks like an id', async () => {
    const result = await recordPaths('project_ddapi');
    expect(textOf(result)).toContain('DeerDawn API');
    // The whole cost argument for this feature: the common path is unchanged.
    expect(seenPaths.filter(isProjectList)).toHaveLength(0);
    expect(seenPaths.some((p) => p.includes('/project_ddapi/hot-paths'))).toBe(true);
  });

  it('resolves a plain name to the right project', async () => {
    const result = await recordPaths('DeerDawn API');
    expect(textOf(result)).toContain('Recorded 1 hot path');
    expect(seenPaths.some((p) => p.includes('/project_ddapi/hot-paths'))).toBe(true);
    // and the raw name never reached the API
    expect(seenPaths.some((p) => p.includes('DeerDawn'))).toBe(false);
  });

  it('matches case- and punctuation-insensitively, like the server\'s own name gate', async () => {
    for (const spelling of ['deerdawn api', 'DEERDAWN-API', 'deerdawn_api']) {
      seenPaths = [];
      await recordPaths(spelling);
      expect(seenPaths.some((p) => p.includes('/project_ddapi/hot-paths'))).toBe(true);
    }
  });

  it('resolves an alias', async () => {
    await recordPaths('api');
    expect(seenPaths.some((p) => p.includes('/project_ddapi/hot-paths'))).toBe(true);
  });

  it('refuses an ambiguous name, names the candidates, and writes nothing', async () => {
    const result = await recordPaths('Billing');
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('project_twin_a');
    expect(text).toContain('project_twin_b');
    expect(text).toMatch(/nothing was written/i);
    // The refusal happens BEFORE the handler runs — no write of any kind.
    expect(seenPaths.some((p) => p.includes('hot-paths'))).toBe(false);
  });

  it('leaves a name that matches nothing alone, so the existing error still surfaces', async () => {
    // The message is now actionable rather than the bare 'Resource not found'
    // (see utils/errors.ts). What matters here is unchanged: an unresolvable
    // name is NOT swallowed and NOT rewritten — the server still decides.
    await expect(recordPaths('Ghost Project')).rejects.toThrow(/No project matches that reference/);
    // Passed through verbatim rather than swallowed or rewritten to a guess.
    expect(seenPaths.some((p) => p.includes('Ghost%20Project'))).toBe(true);
  });

  it('finds an archived project by name, so it can be restored without its id', async () => {
    const { args, refusal } = await resolveProjectRefs({ project_id: 'Aged Out' }, client);
    expect(refusal).toBeUndefined();
    expect(args.project_id).toBe('project_aged');
    // The archived list costs a request only after the live list misses.
    expect(seenPaths.filter(isProjectList)).toHaveLength(2);
  });

  it('asks for the whole archive, not the display default of 10', async () => {
    // The endpoint's default page was sized for start_session's notice. Reusing
    // it here made restore-by-name die past the 10th archived project — and
    // worse, made a partial view look like a unique match.
    await resolveProjectRefs({ project_id: 'Aged Out' }, client);
    const archivedCall = seenPaths.filter((u) => /[?&]archived=(1|true)/.test(u)).pop() || '';
    const m = /[?&]limit=(\d+)/.exec(archivedCall);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(10);
  });

  it('refuses a lone archived match when the archive came back truncated', async () => {
    // A single match inside a FULL page is not a proven unique match: another
    // row with the same name may sit just past the boundary. renameProject has
    // no duplicate-name gate, so same-named projects genuinely can exist, and
    // guessing here files a write into the wrong project's memory.
    const filler = Array.from({ length: 600 }, (_, i) => ({
      project_id: `project_arch_${i}`,
      project_name: `Archived Filler ${i}`,
      archived_at: '2026-07-01T00:00:00.000Z',
    }));
    ARCHIVED_PROJECTS.push(...filler);
    try {
      const { args, refusal } = await resolveProjectRefs({ project_id: 'Aged Out' }, client);
      expect(refusal).toBeDefined();
      expect(refusal).toContain('cannot be proven unique');
      // The argument must come back UNREWRITTEN, so an ignored refusal cannot
      // proceed against a guessed project.
      expect(args.project_id).toBe('Aged Out');
    } finally {
      ARCHIVED_PROJECTS.length = 1;
    }
  });
});

// ─── Structure: which keys get rewritten, and how the walk degrades ──────────

function stubClient(overrides: Record<string, any> = {}) {
  return {
    listContextProjects: async () => ({ projects: LIVE_PROJECTS }),
    listArchivedContextProjects: async () => ({ projects: ARCHIVED_PROJECTS }),
    ...overrides,
  } as any;
}

describe('resolveProjectRefs', () => {
  it('returns the arguments by reference when there is nothing to resolve', async () => {
    const args = { project_id: 'project_ddapi', summary: 'x' };
    let listed = false;
    const out = await resolveProjectRefs(args, stubClient({
      listContextProjects: async () => { listed = true; return { projects: LIVE_PROJECTS }; },
    }));
    expect(out.args).toBe(args);
    expect(listed).toBe(false);
  });

  it('resolves nested references, such as upsert_entities\' per-entity project', async () => {
    const { args } = await resolveProjectRefs({
      entities: [
        { title: 'Router', project_id: 'Marketing Site' },
        { title: 'Store', project_id: 'project_ddapi' },
      ],
    }, stubClient());
    expect(args.entities[0].project_id).toBe('project_market');
    expect(args.entities[1].project_id).toBe('project_ddapi');
  });

  it('resolves several distinct references in one request', async () => {
    let calls = 0;
    const { args } = await resolveProjectRefs(
      { project_id: 'Marketing Site', parent_project_id: 'DeerDawn API', related_project_id: 'api' },
      stubClient({ listContextProjects: async () => { calls += 1; return { projects: LIVE_PROJECTS }; } }),
    );
    expect(args).toMatchObject({
      project_id: 'project_market',
      parent_project_id: 'project_ddapi',
      related_project_id: 'project_ddapi',
    });
    expect(calls).toBe(1);
  });

  it('never rewrites a name being WRITTEN, only a reference being read', async () => {
    // rename_project and import_trail both carry a project_id next to a name
    // field. Rewriting the latter would rename the project to a UUID.
    const { args } = await resolveProjectRefs(
      { project_id: 'Marketing Site', project_name: 'DeerDawn API', new_project_name: 'DeerDawn API' },
      stubClient(),
    );
    expect(args.project_id).toBe('project_market');
    expect(args.project_name).toBe('DeerDawn API');
    expect(args.new_project_name).toBe('DeerDawn API');
  });

  it('lets an exact name outrank another project\'s stale alias', async () => {
    const rows = [
      { project_id: 'project_real', project_name: 'Billing', aliases: [] },
      { project_id: 'project_old', project_name: 'Old Thing', aliases: ['Billing'] },
    ];
    const { args, refusal } = await resolveProjectRefs(
      { project_id: 'billing' },
      stubClient({ listContextProjects: async () => ({ projects: rows }) }),
    );
    expect(refusal).toBeUndefined();
    expect(args.project_id).toBe('project_real');
  });

  it('still refuses when two projects tie inside the same tier', async () => {
    const { refusal, args } = await resolveProjectRefs({ project_id: 'billing' }, stubClient());
    expect(refusal).toContain('matches 2 projects');
    // Arguments are handed back untouched so a caller ignoring the refusal
    // cannot accidentally proceed with a guess.
    expect(args.project_id).toBe('billing');
  });

  it('passes arguments through untouched when the project list cannot be fetched', async () => {
    const args = { project_id: 'DeerDawn API' };
    const out = await resolveProjectRefs(args, stubClient({
      listContextProjects: async () => { throw new Error('network down'); },
    }));
    expect(out.args).toBe(args);
    expect(out.refusal).toBeUndefined();
  });
});
