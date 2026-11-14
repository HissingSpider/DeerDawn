import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildContextPointer,
  contextCustodyEnabled,
  syncProjectFiles,
} from '../src/project-sync.js';

// A brief carrying a recognizable secret marker. The whole point of custody is
// that this string must never be persisted to disk.
const SECRET = 'SECRET_DECISION_swap_to_nats';
const BRIEF = `Project: Atlas\nCurrent task: ship the queue\nRecent decisions: ${SECRET}`;

function mockClient() {
  return {
    getActiveContextByCwd: vi.fn().mockResolvedValue({
      brief: BRIEF,
      project_name: 'Atlas',
      project_id: 'proj-1',
      match_kind: 'path',
      last_updated: '2026-06-08T00:00:00.000Z',
      context: { tech_stack: [] },
    }),
    patchProjectContext: vi.fn().mockResolvedValue(undefined),
    upsertWorkspaceEntities: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('buildContextPointer', () => {
  it('names the project and points to live context, without leaking brief content', () => {
    const pointer = buildContextPointer('Atlas', '2026-06-08T00:00:00.000Z');
    expect(pointer).toContain('Project: Atlas');
    expect(pointer).toContain('start_session');
    expect(pointer).toContain('Last briefed: 2026-06-08T00:00:00.000Z');
    expect(pointer).not.toContain(SECRET);
  });
});

describe('contextCustodyEnabled', () => {
  const prev = process.env.DEERDAWN_CONTEXT_CUSTODY;
  afterEach(() => {
    if (prev === undefined) delete process.env.DEERDAWN_CONTEXT_CUSTODY;
    else process.env.DEERDAWN_CONTEXT_CUSTODY = prev;
  });
  it('defaults on and only disables on the explicit false opt-out', () => {
    delete process.env.DEERDAWN_CONTEXT_CUSTODY;
    expect(contextCustodyEnabled()).toBe(true);
    process.env.DEERDAWN_CONTEXT_CUSTODY = 'false';
    expect(contextCustodyEnabled()).toBe(false);
    process.env.DEERDAWN_CONTEXT_CUSTODY = 'true';
    expect(contextCustodyEnabled()).toBe(true);
  });
});

describe('syncProjectFiles custody behavior', () => {
  let root: string;
  let homeBackup: string | undefined;
  let custodyBackup: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-custody-'));
    fs.mkdirSync(path.join(root, '.git')); // make root a git root for findGitRoot
    // Keep the manifest write (~/.deerdawn) inside the tmpdir, not real $HOME.
    homeBackup = process.env.HOME;
    process.env.HOME = root;
    custodyBackup = process.env.DEERDAWN_CONTEXT_CUSTODY;
  });

  afterEach(() => {
    if (homeBackup === undefined) delete process.env.HOME; else process.env.HOME = homeBackup;
    if (custodyBackup === undefined) delete process.env.DEERDAWN_CONTEXT_CUSTODY;
    else process.env.DEERDAWN_CONTEXT_CUSTODY = custodyBackup;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes a thin pointer to disk, never the brief (custody default on)', async () => {
    delete process.env.DEERDAWN_CONTEXT_CUSTODY;
    const name = await syncProjectFiles(mockClient(), root, undefined, { tools: ['claude_code', 'codex', 'cursor', 'copilot'] });
    expect(name).toBe('Atlas');

    const onDisk = fs.readFileSync(path.join(root, '.deerdawn-context.md'), 'utf8');
    expect(onDisk).toContain('Project: Atlas');
    expect(onDisk).toContain('start_session');
    expect(onDisk).not.toContain(SECRET); // the moat: rich content stays server-side

    // The marker-patched tool files must also carry only the pointer.
    const cursor = fs.readFileSync(path.join(root, '.cursorrules'), 'utf8');
    expect(cursor).not.toContain(SECRET);
  });

  it('persists the full brief to disk when custody is explicitly disabled', async () => {
    process.env.DEERDAWN_CONTEXT_CUSTODY = 'false';
    await syncProjectFiles(mockClient(), root, undefined, { tools: ['claude_code', 'codex', 'cursor', 'copilot'] });
    const onDisk = fs.readFileSync(path.join(root, '.deerdawn-context.md'), 'utf8');
    expect(onDisk).toContain(SECRET);
  });
});
