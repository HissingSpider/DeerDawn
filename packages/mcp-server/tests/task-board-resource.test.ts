import { describe, expect, it } from 'vitest';
import { listResources, readResource } from '../src/resources/index.js';

describe('task board app resource', () => {
  it('is absent by default and available with the explicit feature flag', async () => {
    const previous = process.env.MCP_TASK_BOARD_UI_ENABLED;
    try {
      delete process.env.MCP_TASK_BOARD_UI_ENABLED;
      expect(listResources().map((resource) => resource.uri)).not.toContain('ui://deerdawn/task-board/v1.html');

      process.env.MCP_TASK_BOARD_UI_ENABLED = 'true';
      expect(listResources().map((resource) => resource.uri)).toContain('ui://deerdawn/task-board/v1.html');
      const result = await readResource('ui://deerdawn/task-board/v1.html', null as never);
      expect(result?.contents[0].mimeType).toBe('text/html;profile=mcp-app');
      expect(result?.contents[0].text).toContain('ui/notifications/tool-result');
    } finally {
      if (previous === undefined) delete process.env.MCP_TASK_BOARD_UI_ENABLED;
      else process.env.MCP_TASK_BOARD_UI_ENABLED = previous;
    }
  });
});
