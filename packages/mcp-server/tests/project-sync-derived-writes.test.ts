import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { syncProjectFiles } from '../src/project-sync.js';

/**
 * Project sync REPLACED the stored tech stack with its package.json guess on
 * every session start.
 *
 * The response it runs on is the BRIEF payload from /context/active, which
 * carries no `context` object at all — so `result.context?.tech_stack` was
 * always undefined, every inferred label counted as "new", and the patch it
 * sent was the guess alone. `mergeContextObject` gives tech_stack REPLACE
 * semantics (a delta array overwrites, so the dashboard can delete an entry),
 * so a hand-curated stack was silently overwritten by whatever the dependency
 * table happened to recognise.
 *
 * Same shape as the member-write wipe: absent must never mean empty.
 */

const BRIEF_PAYLOAD = {
  brief: 'Project: Atlas\nCurrent task: ship the queue',
  project_name: 'Atlas',
  project_id: 'proj-1',
  match_kind: 'path',
  last_updated: '2026-09-01T00:00:00.000Z',
  // NOTE: deliberately no `context` key — this mirrors what GET
  // /api/v1/context/active actually returns for the brief shape.
};

function mockClient(stored: Record<string, unknown> | null, opts: { readThrows?: boolean } = {}) {
  return {
    getActiveContextByCwd: vi.fn().mockResolvedValue({ ...BRIEF_PAYLOAD }),
    getContextJson: opts.readThrows
      ? vi.fn().mockRejectedValue(new Error('network down'))
      : vi.fn().mockResolvedValue(stored),
    patchProjectContext: vi.fn().mockResolvedValue(undefined),
    upsertWorkspaceEntities: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function stackPatch(client: any): string[] | undefined {
  const call = client.patchProjectContext.mock.calls.find((c: any[]) => c[1] && c[1].tech_stack);
  return call?.[1]?.tech_stack;
}

function progressPatch(client: any): string | undefined {
  const call = client.patchProjectContext.mock.calls.find((c: any[]) => c[1] && c[1].task_progress);
  return call?.[1]?.task_progress;
}

describe('syncProjectFiles derived writes', () => {
  let root: string;
  let homeBackup: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-derived-'));
    fs.mkdirSync(path.join(root, '.git'));
    homeBackup = process.env.HOME;
    process.env.HOME = root;
    // A package.json the stack inference recognises: Express + Zod.
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'atlas', dependencies: { express: '^4', zod: '^3' } }),
      'utf8',
    );
  });

  afterEach(() => {
    if (homeBackup === undefined) delete process.env.HOME; else process.env.HOME = homeBackup;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps a hand-curated tech stack across a sync that would have guessed differently', async () => {
    const client = mockClient({ tech_stack: ['Rust', 'Kubernetes'], task_progress: '' });
    await syncProjectFiles(client, root);

    const patched = stackPatch(client);
    expect(patched, 'a stack patch should have been sent — the guess adds entries').toBeTruthy();
    // The curated entries must survive. Before the fix the patch was ['Express','Zod'].
    expect(patched).toContain('Rust');
    expect(patched).toContain('Kubernetes');
    expect(patched).toContain('Express');
  });

  it('still records the guess for a project with no stored stack', async () => {
    const client = mockClient({ tech_stack: [], task_progress: '' });
    await syncProjectFiles(client, root);
    const patched = stackPatch(client);
    expect(patched).toEqual(expect.arrayContaining(['Express', 'Zod']));
  });

  it('writes nothing when the stored stack already covers the guess', async () => {
    const client = mockClient({ tech_stack: ['Express', 'Zod'], task_progress: '' });
    await syncProjectFiles(client, root);
    expect(stackPatch(client)).toBeUndefined();
  });

  it('writes nothing derived when the stored context cannot be read', async () => {
    const client = mockClient(null, { readThrows: true });
    await syncProjectFiles(client, root);
    expect(client.patchProjectContext).not.toHaveBeenCalled();
  });

  it('never treats a payload without a structured context as an empty one', async () => {
    // An older API build answers format=json with its ordinary brief payload —
    // no tech_stack anywhere. That is "unknown", not "empty".
    const client = mockClient({ ...BRIEF_PAYLOAD } as any);
    await syncProjectFiles(client, root);
    expect(client.patchProjectContext).not.toHaveBeenCalled();
  });

  it('leaves an agent-set task_progress alone but refreshes its own plan-derived one', async () => {
    const plans = path.join(root, 'docs', 'superpowers', 'plans');
    fs.mkdirSync(plans, { recursive: true });
    fs.writeFileSync(path.join(plans, '2026-09-01-queue.md'), '- [x] one\n- [ ] two\n', 'utf8');

    const curated = mockClient({ tech_stack: ['Express', 'Zod'], task_progress: 'Phase 2 of 4 — schema migration' });
    await syncProjectFiles(curated, root);
    expect(progressPatch(curated), 'a hand-set progress must not be overwritten by a plan-file guess').toBeUndefined();

    const derived = mockClient({ tech_stack: ['Express', 'Zod'], task_progress: '0/2 steps complete (queue)' });
    await syncProjectFiles(derived, root);
    expect(progressPatch(derived)).toBe('1/2 steps complete (queue)');
  });
});
