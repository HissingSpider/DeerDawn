import { describe, expect, it } from 'vitest';
import { handleAddonTool } from '../src/tools/addons.js';

// PARITY with apps/api/src/addons/runner.js forMcp: an add-on reply over MCP
// is its text (and images) unless the caller asks for data with
// include_data: true, or the action returned no text. include_data never
// reaches the API, where it would trip the action's own argument schema.

function fakeClient(result: { text: string; data: any; images?: any[] }) {
  const calls: any[] = [];
  return {
    calls,
    client: {
      runAddonAction: async (addon: string, action: string, args: any, via: string) => {
        calls.push({ addon, action, args, via });
        return { ok: true, result: { images: [], ...result } };
      },
    } as any,
  };
}

describe('read_addon / use_addon replies', () => {
  it('leave data out by default, and strip include_data before forwarding', async () => {
    const { client, calls } = fakeClient({ text: '1 notes record(s):\n- rec_1 {"title":"x"}', data: { rows: [{ id: 'rec_1' }] } });
    const lean = await handleAddonTool('read_addon', { addon: 'notes-example', action: 'list', args: { collection: 'notes' } }, client);
    expect(lean.structuredContent).toEqual({ text: '1 notes record(s):\n- rec_1 {"title":"x"}' });
    expect(calls[0]).toEqual({ addon: 'notes-example', action: 'list', args: { collection: 'notes' }, via: 'read' });

    const full = await handleAddonTool('use_addon', { addon: 'notes-example', action: 'list', args: { collection: 'notes', include_data: true } }, client);
    expect((full.structuredContent as any).data).toEqual({ rows: [{ id: 'rec_1' }] });
    expect(calls[1].args).toEqual({ collection: 'notes' });
    expect(calls[1].via).toBe('write');
  });

  it('keeps data when the action returned no text', async () => {
    const { client } = fakeClient({ text: '', data: { count: 3 } });
    const result = await handleAddonTool('read_addon', { addon: 'a', action: 'count', args: {} }, client);
    expect((result.structuredContent as any).data).toEqual({ count: 3 });
  });

  it('returns images as MCP image blocks', async () => {
    const { client } = fakeClient({ text: 'sheet', data: null, images: [{ mime: 'image/png', base64: 'AAAA' }] });
    const result = await handleAddonTool('read_addon', { addon: 'a', action: 'view', args: {} }, client);
    expect(result.content[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' });
  });
});
