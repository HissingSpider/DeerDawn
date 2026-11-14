import { describe, expect, it } from 'vitest';

import { contextSyncAssistantPrompt } from '../src/prompts/context-sync.js';
import { stripMapCallHints } from '../src/map-hints.js';
import { buildOnDiskInstructionBlock } from '../src/on-disk-instructions.js';
import { listTools } from '../src/tools/index.js';

/**
 * FIRST-RUN TEXT NAMES ONLY TOOLS THE MODEL WAS SHOWN (scan 19).
 *
 * Three surfaces a model reads before it has done anything still named calls
 * missing from tools/list:
 *   - the session-brief prompt appended the raw context map, whose trailer is
 *     "→ Call get_context(project_id?, sections?) for details" (start_session
 *     strips it; the prompt did not);
 *   - the same prompt told a signed-in session to use get_setup_status /
 *     apply_setup, the SETUP_TIER that tools/list hides once authed;
 *   - with /mcp and /mcp/claude both registered, the on-disk CLAUDE.md block
 *     said "Read the board with `read_tasks`", which /mcp does not advertise.
 */

// The map as GET /api/v1/context/map renders it with mcp=true.
const MAP = [
  '[DeerDawn] 2 projects',
  '→ DeerDawn (proj-1)',
  '  Other (proj-2)',
  '→ Call get_context(project_id?, sections?) for details',
  '  Sections: task | status | decisions | stack | files | hot_paths | entrypoints | surfaces | debugging_notes | goals | questions | todos | all',
  '  → marks the active project for this directory',
].join('\n');

const fakeClient = { getContextMap: async () => ({ map: MAP }) } as any;

/** Every `backticked_name` or `name(` that looks like a tool call. */
function namedTools(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/`([a-z][a-z_]+)(?:\(|`)/g)) names.add(m[1]);
  for (const m of text.matchAll(/\b([a-z]+_[a-z_]+)\(/g)) names.add(m[1]);
  return [...names];
}

describe('the session-brief prompt', () => {
  it('drops the map\'s "Call get_context" trailer but keeps the projects', async () => {
    const text = await contextSyncAssistantPrompt(fakeClient, { authed: true });
    expect(text).not.toContain('get_context');
    expect(text).not.toContain('Sections: task');
    expect(text).toContain('→ DeerDawn (proj-1)');
    expect(text).toContain('Other (proj-2)');
  });

  it('names the setup tools only while signed out', async () => {
    const signedIn = await contextSyncAssistantPrompt(fakeClient, { authed: true });
    expect(signedIn).not.toContain('get_setup_status');
    expect(signedIn).not.toContain('apply_setup');
    const signedOut = await contextSyncAssistantPrompt(fakeClient, { authed: false });
    expect(signedOut).toContain('get_setup_status');
  });

  it('every tool it names is in tools/list for that state', async () => {
    for (const authed of [true, false]) {
      const text = await contextSyncAssistantPrompt(fakeClient, { authed });
      const advertised = new Set(listTools({ authed, hasSkills: true }).map((tool: any) => tool.name));
      const strays = namedTools(text).filter((name) => /_/.test(name) && !advertised.has(name)
        // Not tools: the host-prefix example and argument names in call shapes.
        && !['deerdawn-start_session', 'project_id', 'complete_task', 'confirm_complete', 'import_local', 'finish_task'].includes(name));
      expect(strays, `authed=${authed}`).toEqual([]);
    }
  });
});

describe('stripMapCallHints', () => {
  it('removes exactly the three hint prefixes start_session removes', () => {
    expect(stripMapCallHints(MAP)).toBe(['[DeerDawn] 2 projects', '→ DeerDawn (proj-1)', '  Other (proj-2)'].join('\n'));
  });
});

describe('the on-disk block with both hosted endpoints registered', () => {
  it('does not name read_tasks, which /mcp does not advertise', () => {
    const block = buildOnDiskInstructionBlock(['hosted', 'hosted_claude']);
    expect(block).not.toContain('read_tasks');
    expect(block).toContain('`manage_tasks`');
  });

  it('a /mcp registration alone uses manage_tasks list, never read_tasks', () => {
    const block = buildOnDiskInstructionBlock('hosted');
    expect(block).not.toContain('read_tasks');
    expect(block).toContain('action:"list"');
  });
});
