import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * start_session's "best guess" notice asked the wrong question.
 *
 * It fired on `match_kind === 'name'` and on nothing else. That is one API's
 * spelling of "this is a guess", not the question itself: the API now answers it
 * directly with `match_confidence` and `write_target`, and a low-confidence
 * answer under any other kind went out looking exactly like a linked project.
 *
 * HOME is a temp dir, set before the modules load: start_session mirrors peers
 * and syncs project files under ~/.deerdawn.
 */

let home: string;
let cwd: string;
const saved: Record<string, string | undefined> = {};
let handleContextSyncTool: typeof import('../src/tools/context-sync.js').handleContextSyncTool;

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-guess-home-')));
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-guess-cwd-')));
  for (const key of ['HOME', 'USERPROFILE', 'DEERDAWN_HOME_DIR', 'CLAUDE_PROJECT_DIR']) saved[key] = process.env[key];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.DEERDAWN_HOME_DIR = home;
  process.env.CLAUDE_PROJECT_DIR = cwd;
  vi.resetModules();
  ({ handleContextSyncTool } = await import('../src/tools/context-sync.js'));
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of [home, cwd]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

async function startSession(active: Record<string, unknown>): Promise<string> {
  const client = {
    flushQueuedContextWrites: vi.fn().mockResolvedValue(null),
    getActiveContextByCwd: vi.fn().mockResolvedValue({
      brief: 'Current task: ack after the write.',
      project_id: 'project_shown',
      project_name: 'Therapist notes',
      last_updated: '2026-09-01T00:00:00.000Z',
      ...active,
    }),
    getContextMap: vi.fn().mockResolvedValue(null),
    recordContextEvent: vi.fn().mockResolvedValue(null),
  };
  const result = await handleContextSyncTool('start_session', {}, client as any);
  return String(result.content?.[0]?.text || '');
}

describe('the best-guess notice', () => {
  it('follows match_confidence when the API sends it, whatever the kind is called', async () => {
    const text = await startSession({ match_kind: 'some_future_kind', match_confidence: 'low', write_target: false });
    expect(text).toContain('Best guess for this directory');
    expect(text).toContain('Therapist notes');
  });

  it('says what the guess costs, and hands over the id that makes the first save work', async () => {
    const text = await startSession({ match_kind: 'name', match_confidence: 'low', write_target: false });
    expect(text).toContain('matched by name');
    expect(text).toContain('project_id: "project_shown"');
    expect(text).toContain('refused');
  });

  it('does not threaten a refusal the API says will not happen', async () => {
    // A low-confidence answer that MAY be written to (the API's fallback for a
    // caller with no location). Still a guess to verify; saves are not refused.
    const text = await startSession({ match_kind: 'recency_fallback', match_confidence: 'low', write_target: true });
    expect(text).toContain('Best guess for this directory');
    expect(text).not.toContain('refused');
  });

  it('is silent for a confident match, even one whose kind is "name"', async () => {
    // The API's verdict outranks this side's reading of the kind.
    expect(await startSession({ match_kind: 'name', match_confidence: 'high', write_target: true })).not.toContain('Best guess');
    expect(await startSession({ match_kind: 'path', match_confidence: 'high', write_target: true })).not.toContain('Best guess');
  });

  it('falls back to match_kind for an API that sends neither field', async () => {
    expect(await startSession({ match_kind: 'name' })).toContain('Best guess for this directory');
    expect(await startSession({ match_kind: 'path' })).not.toContain('Best guess');
    expect(await startSession({ match_kind: 'pinned' })).not.toContain('Best guess');
    expect(await startSession({ match_kind: 'workspace' })).not.toContain('Best guess');
    // No kind at all is not evidence of a guess.
    expect(await startSession({})).not.toContain('Best guess');
  });
});
