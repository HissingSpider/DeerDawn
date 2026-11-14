import { describe, it, expect, vi } from 'vitest';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { handleContextSyncTool } from '../src/tools/context-sync.js';
import { contextSyncTools } from '../src/tools/context-sync.js';

/**
 * build_subagent_brief advertises max_tokens as `number` — deliberately: a
 * property declared `integer` was refused end to end on the hosted path, which
 * is why this whole catalog uses `number`. The request schema parsed it with
 * z.number().int(), so 250.5 was rejected for being exactly what the advertised
 * type invited, and rejected through the generic validation path rather than as
 * something a caller could act on.
 *
 * PARITY with apps/api/tests/integration/mcp-subagent-brief-max-tokens.test.js.
 */

const client = () => ({
  buildSubagentBrief: vi.fn().mockResolvedValue({ text: 'a brief', project_name: 'Atlas' }),
});

const brief = (args: any, c: any) => handleContextSyncTool('build_subagent_brief', args, c);

describe('build_subagent_brief max_tokens', () => {
  it('still advertises max_tokens as a number, not an integer', () => {
    const tool: any = contextSyncTools.find((t: any) => t.name === 'build_subagent_brief');
    expect(tool.inputSchema.properties.max_tokens.type).toBe('number');
  });

  it('rounds a fractional max_tokens instead of refusing it', async () => {
    const c = client();
    const result = await brief({ task: 'Fix the board cap', max_tokens: 250.5 }, c);

    expect(String(result?.content?.[0]?.text ?? '')).toContain('a brief');
    expect(c.buildSubagentBrief).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 251 }));
  });

  it('still refuses a max_tokens outside the advertised range, and names the field', async () => {
    const c = client();
    let error: McpError | null = null;
    try {
      await brief({ task: 'Fix the board cap', max_tokens: 5000 }, c);
    } catch (err) {
      error = err as McpError;
    }

    expect(error).toBeTruthy();
    expect(error!.code).toBe(ErrorCode.InvalidParams);
    // A serialized Zod issue array makes a model parse JSON to learn which
    // argument was wrong. The field name is the only part it can act on.
    expect(error!.message).toContain('max_tokens');
    expect(error!.message).not.toContain('"code":');
    expect(c.buildSubagentBrief).not.toHaveBeenCalled();
  });

  it('leaves a max_tokens that was never supplied to the schema default', async () => {
    const c = client();
    await brief({ task: 'Fix the board cap' }, c);
    expect(c.buildSubagentBrief).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 250 }));
  });
});
