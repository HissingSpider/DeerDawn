import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleContextSyncTool } from '../src/tools/context-sync.js';
import { formatProjectListing, ARCHIVED_PROJECTS_FETCH_LIMIT } from '../../shared-context/src/index.js';

// Journey round 3, A1, on the local stdio server.
//
// After the nightly job archived both of a person's projects, start_session
// said "2 archived projects are waiting, not gone ... call
// recall(action:"projects") for the IDs", and this server's listing answered
// "[DeerDawn — 0 projects]" (its map fallback, because the live tree was
// empty). An assistant that believed it created an empty project beside the
// archived one. archived-listing-parity.node.test.cjs drives the built server
// against the real routes; these pin the local-only edges.

const LEDGER_API = { project_id: 'project_ledger_api', project_name: 'Ledger API', archived_at: '2026-08-24T03:00:00.000Z' };
const LEDGER_DASH = { project_id: 'project_ledger_dash', project_name: 'Ledger Dashboard', archived_at: '2026-08-24T03:00:00.000Z' };

function listingClient({ tree = [], archived = [], archivedMarker = true, map = '[DeerDawn — 0 projects]\nNow: Mon, Sep 28, 2026' } = {}) {
  return {
    listContextProjectTree: vi.fn().mockResolvedValue({ projects: tree }),
    listArchivedContextProjects: vi.fn().mockResolvedValue(archivedMarker ? { projects: archived, archived: true } : { projects: archived }),
    getContextMap: vi.fn().mockResolvedValue({ map, project_count: tree.length }),
    listContextProjects: vi.fn().mockResolvedValue({ projects: [] }),
  };
}

describe('recall(action:"projects") on the local server', () => {
  const originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
  afterEach(() => {
    process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
    vi.restoreAllMocks();
  });

  it('names archived projects with their ids and the restore call, and reads the whole archived feed', async () => {
    const client = listingClient({ archived: [LEDGER_DASH, LEDGER_API] });
    const result = await handleContextSyncTool('recall', { action: 'projects' }, client as any);
    const text = result.content[0].text;

    expect(text).not.toContain('0 projects]');
    expect(text).not.toContain('No projects yet');
    expect(text).toContain('Ledger Dashboard (project_ledger_dash) — archived 2026-08-24');
    expect(text).toContain('Ledger API (project_ledger_api) — archived 2026-08-24');
    expect(text).toContain('manage_projects(action:"restore", project_id:"<id>")');
    // The hosted connector's words exactly: one renderer for both.
    expect(text).toBe(formatProjectListing([], [LEDGER_DASH, LEDGER_API]).text);
    expect(client.listArchivedContextProjects).toHaveBeenCalledWith(ARCHIVED_PROJECTS_FETCH_LIMIT);
    expect(client.getContextMap).not.toHaveBeenCalled();
  });

  it('an answer that is not the archived feed is never listed as archived', async () => {
    // An API that ignored ?archived=1 answers with the LIVE projects; printing
    // those under "archived" would send the assistant to restore live work.
    const live = [{ project_id: 'project_live', project_name: 'Live One', context: {} }];
    const client = listingClient({ tree: live, archived: live as any, archivedMarker: false });
    const result = await handleContextSyncTool('recall', { action: 'projects' }, client as any);
    expect(result.content[0].text).toBe('• Live One (project_live)');
    expect(result.content[0].text).not.toContain('archived');
  });

  it('an empty account gets the hosted connector\'s sentence, not the map\'s "0 projects"', async () => {
    const client = listingClient();
    const result = await handleContextSyncTool('recall', { action: 'projects' }, client as any);
    expect(result.content[0].text).toBe('No projects yet. Use manage_projects with action "create" to create one.');
  });

  it('an API without /projects/tree still lists archived projects from the flat fallback', async () => {
    const client = {
      ...listingClient({ archived: [LEDGER_API], map: '' }),
      listContextProjectTree: vi.fn().mockRejectedValue(new Error('404')),
    };
    const result = await handleContextSyncTool('recall', { action: 'projects' }, client as any);
    expect(result.content[0].text).toBe(formatProjectListing([], [LEDGER_API]).text);
  });

  it('the start_session notice counts the whole archived feed, as the listing does', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-archived-notice-'));
    process.env.CLAUDE_PROJECT_DIR = cwd;
    const many = Array.from({ length: 14 }, (_, i) => ({ project_id: `project_old_${i}`, project_name: `Old ${i}` }));
    const client = {
      flushQueuedContextWrites: vi.fn().mockResolvedValue(null),
      getActiveContextByCwd: vi.fn().mockResolvedValue(null),
      getContextMap: vi.fn().mockResolvedValue(null),
      recordContextEvent: vi.fn().mockResolvedValue(null),
      listArchivedContextProjects: vi.fn().mockImplementation(async (limit?: number) => ({ projects: many.slice(0, limit ?? 10), archived: true })),
    };
    const result = await handleContextSyncTool('start_session', {}, client as any);
    expect(result.content[0].text).toContain('14 archived projects are waiting, not gone');
  });
});

describe('manage_projects archive reply on the local server', () => {
  it('no longer promises the project leaves recall(action:"projects")', async () => {
    const client = {
      archiveProject: vi.fn().mockResolvedValue({ project_id: 'project_ledger_api', project_name: 'Ledger API', archived_at: '2026-09-28T00:00:00Z' }),
    };
    const result = await handleContextSyncTool('manage_projects', { action: 'archive', project_id: 'project_ledger_api' }, client as any);
    const text = result.content[0].text;
    expect(text).not.toMatch(/won't appear/);
    expect(text).toBe('Archived "Ledger API". It no longer resolves as the active project, and recall(action:"projects") lists it as archived. Restore it with manage_projects(action:"restore", project_id:"project_ledger_api").');
  });
});
