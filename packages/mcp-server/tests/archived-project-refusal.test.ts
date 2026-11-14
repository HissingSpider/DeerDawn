import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it, vi } from 'vitest';

import { handleContextSyncTool } from '../src/tools/context-sync.js';

/**
 * A save to an archived project was reported as a conflict with nothing.
 *
 * The API refuses the write with 409 project_archived and a message that names
 * the project, says nothing was saved, and gives the restore call. Locally that
 * became "Conflicts with something that already exists" (the generic 409 text),
 * or on a task-only update "Request failed with status code 409" — so the save
 * was gone and the one sentence that gets it back never reached the caller.
 * The 30-day idle auto-archive makes this the ordinary way to return to a
 * project, not an edge case.
 *
 * Driven through the real handler with an explicit project_id, so no lookup and
 * nothing on disk is involved.
 */

const ID = 'project_0b9b2c1e-7a43-4c58-9f0e-2d6a1c3e5f70';
const MESSAGE = `project_archived: "Ledger migration" (${ID}) is archived, so nothing was saved. `
  + 'A restore is required before it can be written to: manage_projects with action "restore", '
  + `or POST /api/v1/context/projects/${ID}/archive with {"unarchive": true}. Then repeat the write.`;

function archivedError(): AxiosError {
  const err = new AxiosError('Request failed with status code 409');
  err.response = {
    status: 409,
    statusText: 'Conflict',
    data: { error: 'project_archived', message: MESSAGE },
    headers: new AxiosHeaders(),
    config: { headers: new AxiosHeaders() },
  } as AxiosError['response'];
  return err;
}

describe('a write to an archived project', () => {
  it('update with a summary: the restore instruction reaches the caller verbatim', async () => {
    const client = { pushContextUpdate: vi.fn().mockRejectedValue(archivedError()) };
    await expect(handleContextSyncTool('manage_memory', { action: 'update', project_id: ID, summary: 'Chose the ledger cutover date.' }, client as any))
      .rejects.toThrow(MESSAGE);
  });

  it('a task-only update says the same thing instead of quoting axios', async () => {
    const client = {
      patchProjectContext: vi.fn().mockRejectedValue(archivedError()),
      getContextJson: vi.fn(),
    };
    const result = await handleContextSyncTool('update_context', { project_id: ID, task: 'Cut over the ledger' }, client as any);
    const text = String(result.content?.[0]?.text ?? '');
    expect(text).toContain('Current task NOT changed');
    expect(text).toContain('manage_projects with action "restore"');
    expect(text).not.toContain('status code 409');
  });

  it('a task-board write says it too', async () => {
    const client = {
      getContextJson: vi.fn().mockResolvedValue({ project_id: ID, project_name: 'Ledger migration', todo_items: [], completed_todos: [] }),
      recordContextEvent: vi.fn().mockRejectedValue(archivedError()),
    };
    await expect(handleContextSyncTool('manage_tasks', { action: 'add', project_id: ID, todos: ['Cut over'] }, client as any))
      .rejects.toThrow(/manage_projects with action "restore"/);
  });
});
