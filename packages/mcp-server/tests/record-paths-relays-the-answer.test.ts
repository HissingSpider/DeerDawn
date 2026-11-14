import { describe, it, expect, vi } from 'vitest';
import { handleContextSyncTool } from '../src/tools/context-sync.js';
import { redactSecretText } from '../../shared-context/src/index.js';

/**
 * record_paths and record_finding built their replies from the REQUEST.
 *
 * Both writes go through mergeContextObject, which dedupes and caps: hot_paths
 * holds 40 entries, debugging_notes 30, and the service additionally drops any
 * stored hot path whose normalized path collides with an incoming one. So
 * recording five paths onto a nearly-full project stores fewer than five and
 * answered "Recorded 5 hot paths" either way — the silent-success shape this
 * repo has paid for repeatedly.
 *
 * The API already answers with the truth: both routes return the full stored
 * array. Relay it; do not count the request.
 */

const paths = (count: number) => Array.from({ length: count }, (_, i) => ({
  label: `Route ${i}`,
  path: `apps/api/src/routes/r${i}.js`,
  purpose: 'a route',
}));

const client = (overrides: any = {}) => ({
  getActiveContextByCwd: vi.fn().mockResolvedValue({ project_id: 'p1', project_name: 'Atlas', match_kind: 'path' }),
  recordContextEvent: vi.fn().mockResolvedValue({ ok: true }),
  recordHotPaths: vi.fn().mockResolvedValue({ project_name: 'Atlas', hot_paths: [] }),
  recordDebugFinding: vi.fn().mockResolvedValue({ project_name: 'Atlas', debugging_notes: [] }),
  ...overrides,
});

const text = (r: any) => String(r?.content?.[0]?.text ?? '');

describe('record_paths relays what the API stored', () => {
  it('does not claim paths the board did not keep', async () => {
    // Three sent, one survives the cap: the reply may not say three.
    const c = client({
      recordHotPaths: vi.fn().mockResolvedValue({
        project_name: 'Atlas',
        hot_paths: [{ label: 'Route 0', path: 'apps/api/src/routes/r0.js' }],
      }),
    });
    const out = text(await handleContextSyncTool('record_hot_paths', { project_id: 'p1', items: paths(3) }, c as any));

    expect(out).not.toContain('Recorded 3');
    expect(out).toContain('1');
    expect(out).toContain('Atlas');
    // The two that did not land have to be named, or the loss is silent.
    expect(out).toContain('apps/api/src/routes/r1.js');
    expect(out).toContain('apps/api/src/routes/r2.js');
  });

  it('reports the plain success when everything landed', async () => {
    const c = client({
      recordHotPaths: vi.fn().mockResolvedValue({ project_name: 'Atlas', hot_paths: paths(2) }),
    });
    const out = text(await handleContextSyncTool('record_hot_paths', { project_id: 'p1', items: paths(2) }, c as any));

    expect(out).toContain('Recorded 2 hot paths for Atlas');
    expect(out).not.toMatch(/not stored|did not/i);
  });

  it('matches on the path, not the label the caller happened to use', async () => {
    // The service prunes a stored entry whose PATH collides and keeps the fresh
    // label, so a label comparison would report a stored path as dropped.
    const c = client({
      recordHotPaths: vi.fn().mockResolvedValue({
        project_name: 'Atlas',
        hot_paths: [{ label: 'A different label', path: 'apps/api/src/routes/r0.js' }],
      }),
    });
    const out = text(await handleContextSyncTool('record_hot_paths', { project_id: 'p1', items: paths(1) }, c as any));

    expect(out).toContain('Recorded 1 hot path for Atlas');
  });

  it('reports the request when the API answers with no stored list to judge', async () => {
    // An older API build that returns only the project name. A reply must not
    // turn an unmeasurable write into a reported loss.
    const c = client({
      recordHotPaths: vi.fn().mockResolvedValue({ project_name: 'Atlas' }),
    });
    const out = text(await handleContextSyncTool('record_hot_paths', { project_id: 'p1', items: paths(2) }, c as any));

    expect(out).toContain('Recorded 2 hot paths for Atlas');
    // Nothing to report: absent fields are not a loss to announce.
    expect(out).not.toMatch(/made room/i);
  });

  it('says when older paths were evicted to make room', async () => {
    // Eviction is a DELETION, and the stored array cannot show it: hot_paths
    // comes back full either way. The service counts it and the hosted
    // dispatcher has said so since it was added; this reply dropped it, so a
    // write that quietly forgot two paths read as an unremarkable success.
    const c = client({
      recordHotPaths: vi.fn().mockResolvedValue({
        project_name: 'Atlas',
        hot_paths: paths(2),
        requested: 2,
        stored: 2,
        not_stored: 0,
        evicted: 2,
      }),
    });
    const out = text(await handleContextSyncTool('record_hot_paths', { project_id: 'p1', items: paths(2) }, c as any));

    expect(out).toContain('Recorded 2 hot paths for Atlas');
    expect(out).toContain('2 older paths made room');
    expect(out).toContain('no longer in the brief');
  });

  it('says it even when some of the new paths were refused', async () => {
    // Both facts at once: part of the batch did not land, AND something old was
    // deleted for the part that did. Reporting only the first still loses a note.
    const c = client({
      recordHotPaths: vi.fn().mockResolvedValue({
        project_name: 'Atlas',
        hot_paths: [{ label: 'Route 0', path: 'apps/api/src/routes/r0.js' }],
        evicted: 1,
      }),
    });
    const out = text(await handleContextSyncTool('record_hot_paths', { project_id: 'p1', items: paths(2) }, c as any));

    expect(out).toContain('NOT stored: apps/api/src/routes/r1.js');
    expect(out).toContain('1 older path made room');
  });

  it('judges a redacted path against the text as it is stored', async () => {
    // normalizeHotPaths redacts every path on the way to the row, so a path
    // carrying a token lands REWRITTEN. Comparing the raw one reports a
    // successful write as a loss — the mistake the explicit-update read-back
    // made until 7a3cecee.
    const raw = 'postgres://app:hunter2secret@db.internal:5432/prod';
    const c = client({
      recordHotPaths: vi.fn().mockResolvedValue({
        project_name: 'Atlas',
        hot_paths: [{ label: 'Prod database', path: redactSecretText(raw) }],
      }),
    });
    const out = text(await handleContextSyncTool(
      'record_hot_paths',
      { project_id: 'p1', items: [{ label: 'Prod database', path: raw, purpose: 'the primary' }] },
      c as any,
    ));

    expect(redactSecretText(raw)).not.toBe(raw);
    expect(out).toContain('Recorded 1 hot path for Atlas');
    expect(out).not.toContain('NOT stored');
  });
});

describe('record_finding relays what the API stored', () => {
  it('does not claim a finding the log did not keep', async () => {
    const c = client({
      recordDebugFinding: vi.fn().mockResolvedValue({ project_name: 'Atlas', debugging_notes: [] }),
    });
    const out = text(await handleContextSyncTool(
      'record_debug_finding',
      { project_id: 'p1', summary: 'The Done cap eats cards' },
      c as any,
    ));

    expect(out).not.toMatch(/^Recorded debugging finding/);
    expect(out).toMatch(/not stored|NOT recorded/i);
    expect(out).toContain('Atlas');
  });

  it('reports the finding when it is in the stored log', async () => {
    const c = client({
      recordDebugFinding: vi.fn().mockResolvedValue({
        project_name: 'Atlas',
        debugging_notes: [{ summary: 'The Done cap eats cards' }],
      }),
    });
    const out = text(await handleContextSyncTool(
      'record_debug_finding',
      { project_id: 'p1', summary: 'The Done cap eats cards' },
      c as any,
    ));

    expect(out).toContain('Recorded debugging finding for Atlas');
  });

  it('reports the request when the API answers with no stored log to judge', async () => {
    const c = client({
      recordDebugFinding: vi.fn().mockResolvedValue({ project_name: 'Atlas' }),
    });
    const out = text(await handleContextSyncTool(
      'record_debug_finding',
      { project_id: 'p1', summary: 'The Done cap eats cards' },
      c as any,
    ));

    expect(out).toContain('Recorded debugging finding for Atlas');
  });

  it('judges a redacted summary against the text as it is stored', async () => {
    const raw = 'The simulator still reads api_key: dd_live_abcd1234efgh5678 from .env.local';
    const c = client({
      recordDebugFinding: vi.fn().mockResolvedValue({
        project_name: 'Atlas',
        debugging_notes: [{ summary: redactSecretText(raw) }],
      }),
    });
    const out = text(await handleContextSyncTool('record_debug_finding', { project_id: 'p1', summary: raw }, c as any));

    expect(redactSecretText(raw)).not.toBe(raw);
    expect(out).toContain('Recorded debugging finding for Atlas');
    expect(out).not.toContain('NOT recorded');
  });

  it('says when the write replaced an earlier note', async () => {
    // Two notes differing only by a date or a counter are one note by design, so
    // an append can be an overwrite of somebody's finding. The service names
    // what it dropped and the hosted dispatcher relays it; this reply said
    // "Recorded" and nothing else.
    const c = client({
      recordDebugFinding: vi.fn().mockResolvedValue({
        project_name: 'Atlas',
        debugging_notes: [{ summary: 'The limiter counts 429s against the budget' }],
        replaced: 'An older note about the limiter',
      }),
    });
    const out = text(await handleContextSyncTool(
      'record_debug_finding',
      { project_id: 'p1', summary: 'The limiter counts 429s against the budget' },
      c as any,
    ));

    expect(out).toContain('Recorded debugging finding for Atlas');
    expect(out).toContain('Replaced an earlier note');
    expect(out).toContain('An older note about the limiter');
  });

  it('stays quiet about a replacement the API did not report', async () => {
    const c = client({
      recordDebugFinding: vi.fn().mockResolvedValue({
        project_name: 'Atlas',
        debugging_notes: [{ summary: 'The Done cap eats cards' }],
        replaced: null,
      }),
    });
    const out = text(await handleContextSyncTool(
      'record_debug_finding',
      { project_id: 'p1', summary: 'The Done cap eats cards' },
      c as any,
    ));

    expect(out).not.toMatch(/replaced/i);
  });
});
