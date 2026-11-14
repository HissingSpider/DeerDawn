/**
 * update_context writes the caller's sentence ONCE.
 *
 * The local dispatcher followed its extraction call with a deterministic
 * decision_made event, so the sentence landed whatever the model did. That was
 * the right floor, and it double-wrote: extraction stored the model's paraphrase
 * and the event stored the original beside it, two decisions for one update.
 *
 * The API now owns the rule (recordExplicitUpdate): a request marked
 * `explicit: true` is stored verbatim, once, and answered with `stored` from a
 * read-back. So the local side sends the flag and trusts `stored` — and keeps
 * the event ONLY for an API that predates the flag and answers without it, so a
 * newer client can never lose the sentence to an older server.
 */
import { describe, it, expect, vi } from 'vitest';
import { handleContextSyncTool } from '../src/tools/context-sync.js';
import type { DeerdawnClient } from '../src/client.js';

function mockClient(extractionReply: unknown) {
  return {
    pushContextUpdate: vi.fn().mockResolvedValue(extractionReply),
    recordContextEvent: vi.fn().mockResolvedValue({ status: 'accepted' }),
  } as unknown as DeerdawnClient;
}

const SUMMARY = 'Pinned tsup to 8.3 across the workspace.';

describe('update_context writes the summary once', () => {
  it('sends the write as explicit and does not also fire a decision event when the API stored it', async () => {
    const client = mockClient({ project: { project_name: 'Atlas' }, extraction: { delta: {} }, stored: true });
    const result = await handleContextSyncTool('update_context', { project_id: 'p1', summary: SUMMARY }, client) as any;

    const call = (client.pushContextUpdate as any).mock.calls[0];
    expect(call[4]).toEqual({ explicit: true });
    expect((client.recordContextEvent as any).mock.calls).toHaveLength(0);
    expect(result.content[0].text).toContain('Decision recorded');
    expect(result.content[0].text).toContain('Saved');
  });

  it('keeps the event as the floor for an API that does not answer `stored`', async () => {
    const client = mockClient({ project: { project_name: 'Atlas' }, extraction: { delta: {} } });
    const result = await handleContextSyncTool('update_context', { project_id: 'p1', summary: SUMMARY }, client) as any;

    const events = (client.recordContextEvent as any).mock.calls;
    expect(events).toHaveLength(1);
    expect(events[0][0]).toMatchObject({ event_type: 'decision_made', project_id: 'p1', summary: SUMMARY });
    expect(result.content[0].text).toContain('Saved');
  });

  it('reports a refusal as a refusal, not as a broken write path to retry', async () => {
    const client = mockClient({
      project: { project_name: 'Atlas' },
      extraction: { delta: {} },
      stored: false,
      reason: 'forbidden',
      refusal_message: 'share_write_forbidden: you have read-only (viewer) access to this workspace, so nothing was saved.',
    });
    const result = await handleContextSyncTool('update_context', { project_id: 'p1', summary: SUMMARY }, client) as any;

    const text = result.content[0].text;
    expect(text).toContain('read-only');
    expect(text).not.toContain('write path is broken');
    expect(text).not.toContain('Saved');
    expect((client.recordContextEvent as any).mock.calls).toHaveLength(0);
  });

  // Scan 36: the server lost its compare-and-swap on every attempt and saved
  // none of the summary. The reply says so first — even when extraction
  // applied other fields — and says to retry.
  it('reports a lost write race as NOT saved, with the retry the server asks for', async () => {
    const client = mockClient({
      project: { project_name: 'Atlas' },
      extraction: { delta: { current_status: 'Wiring the exporter' } },
      stored: false,
      reason: 'conflict',
      refusal_message: 'context_write_conflict: nothing was saved. Other writes to "Atlas" kept landing at the same moment. Retry.',
    });
    const result = await handleContextSyncTool('update_context', { project_id: 'p1', summary: SUMMARY }, client) as any;

    const text = result.content[0].text;
    expect(text).toContain('Your summary was NOT saved to "Atlas"');
    expect(text).toContain('context_write_conflict');
    expect(text).toContain('Retry');
    expect(text).not.toMatch(/^Updated "Atlas"/);
    expect((client.recordContextEvent as any).mock.calls).toHaveLength(0);
  });
});

describe('a summary the server had to redact', () => {
  it('is reported as stored, and the reply says what happened to it', async () => {
    const client = mockClient({
      project: { project_name: 'Atlas' },
      extraction: { delta: {} },
      stored: true,
      redacted: true,
    });
    const result = await handleContextSyncTool('update_context', {
      project_id: 'p1',
      summary: 'Decided to keep api_key: dd_live_abcdefghijklmnop in .env.local',
    }, client) as any;

    const text = result.content[0].text;
    expect(text).toContain('Saved');
    expect(text).toContain('redacted before it was stored');
    // Still one write: the redaction note must not send the caller round the
    // retry loop that stored a second copy every time.
    expect((client.recordContextEvent as any).mock.calls).toHaveLength(0);
  });

  it('says nothing about redaction when nothing was redacted', async () => {
    const client = mockClient({ project: { project_name: 'Atlas' }, extraction: { delta: {} }, stored: true });
    const result = await handleContextSyncTool('update_context', { project_id: 'p1', summary: SUMMARY }, client) as any;
    expect(result.content[0].text).not.toContain('redacted');
  });
});

// Scan 13: DeerDawn's own key, in the shape apps/api mints it (dd_<8 hex>_<64
// hex>), pasted into a summary. It used to travel to the API in clear and rely
// on the server to redact it on arrival. Now it is masked before it leaves.
describe('a DeerDawn key in a summary never leaves the machine', () => {
  const KEY = `dd_${'5e6f7a8b'}_${'d1'.repeat(32)}`;
  const REFRESH = `ddr_${'e2'.repeat(32)}`;
  const WITH_KEY = `Rotated the staging key; the old one was ${KEY} and its refresh token ${REFRESH}.`;

  it('masks the summary sent for extraction, in the fallback event, and in the reply', async () => {
    const client = mockClient({ project: { project_name: 'Atlas' }, extraction: { delta: {} } });
    const result = await handleContextSyncTool('update_context', { project_id: 'p1', summary: WITH_KEY }, client) as any;

    const sentSummary = (client.pushContextUpdate as any).mock.calls[0][1];
    expect(sentSummary).toBe('Rotated the staging key; the old one was [REDACTED] and its refresh token [REDACTED].');
    const event = (client.recordContextEvent as any).mock.calls[0][0];
    expect(event.summary).not.toContain('d1d1d1d1');
    expect(event.summary).not.toContain('e2e2e2e2');
    const text = result.content[0].text;
    expect(text).not.toContain('d1d1d1d1');
    expect(text).toContain('redacted before it was stored');
  });

  it('the client masks it on the wire too (import_local seeds through the same call)', async () => {
    const nock = (await import('nock')).default;
    const { DeerdawnClient: Client } = await import('../src/client.js');
    const base = 'http://localhost:19998';
    let body: any = null;
    nock(base).post('/api/v1/context/extraction').reply(200, (_uri: string, requestBody: any) => {
      body = requestBody;
      return { project: { project_name: 'Atlas' }, extraction: { delta: {} } };
    });
    try {
      const client = new Client({ apiUrl: base, apiKey: 'dd_sandbox_key', environment: 'sandbox', cacheEnabled: false, cacheTtlSeconds: 60, maxRetries: 0, retryBackoffMs: 100 } as any);
      await client.pushContextUpdate('p1', WITH_KEY);
    } finally {
      nock.cleanAll();
    }
    expect(JSON.stringify(body)).not.toContain('d1d1d1d1');
    expect(JSON.stringify(body)).not.toContain('e2e2e2e2');
    expect(body.chunks[0].text).toContain('[REDACTED]');
  });
});
