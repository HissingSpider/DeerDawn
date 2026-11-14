import { describe, expect, it, vi } from 'vitest';
import { handleContextSyncTool } from '../src/tools/context-sync.js';

describe('grouped MCP tools', () => {
  it('routes recall projects to the existing project-tree reader', async () => {
    const client = {
      listContextProjectTree: vi.fn().mockResolvedValue({
        projects: [{ project_id: 'project_1', project_name: 'Aurora', context: { current_task: 'Review OAuth' }, subprojects: [] }],
      }),
    } as any;

    const result = await handleContextSyncTool('recall', { action: 'projects' }, client);

    expect(client.listContextProjectTree).toHaveBeenCalledOnce();
    expect(result.content[0].text).toContain('Aurora');
  });

  it('routes recall portfolio to the cross-project read and names what spans projects', async () => {
    const client = {
      getPortfolio: vi.fn().mockResolvedValue({
        locked: false,
        counts: { projects: 3, decisions: 12, shared_entities: 2 },
        entities: {
          total: 2,
          entries: [
            {
              node_id: 'node_1',
              title: 'Clerk',
              entity_type: 'service',
              project_count: 2,
              projects: [
                { project_id: 'project_1', project_name: 'Aurora' },
                { project_id: 'project_2', project_name: 'Borealis' },
              ],
            },
            {
              node_id: 'node_2',
              title: 'Pricing model',
              node_type: 'decision',
              project_count: 0,
              projects: [],
            },
          ],
        },
        decisions: {
          total: 12,
          entries: [
            { project_name: 'Aurora', summary: 'Drop the project cap on Free', decided_at: '2026-08-27T09:00:00Z', date_inferred: false },
          ],
        },
      }),
    } as any;

    const result = await handleContextSyncTool('recall', { action: 'portfolio' }, client);
    const text = result.content[0].text;

    expect(client.getPortfolio).toHaveBeenCalledWith({ query: undefined, entity_limit: 8, decision_limit: 5 });
    // The whole point of the action: name the entity AND the projects it spans,
    // so a session can say "you already use this in your other project".
    expect(text).toContain('Across 3 projects');
    expect(text).toContain('Clerk (service): Aurora, Borealis');
    // A workspace-scoped entity has no project list; it must not render as blank.
    expect(text).toContain('Pricing model (decision): workspace-wide');
    expect(text).toContain('[Aurora] Drop the project cap on Free');
  });

  it('reports real counts without contents when the plan withholds the portfolio', async () => {
    const client = {
      getPortfolio: vi.fn().mockResolvedValue({
        locked: true,
        counts: { projects: 4, decisions: 9, shared_entities: 3 },
        entities: { total: 3, entries: [{ project_count: 2 }, { project_count: 2 }, { project_count: 3 }] },
        decisions: { total: 9, entries: [{}, {}] },
      }),
    } as any;

    const result = await handleContextSyncTool('recall', { action: 'portfolio' }, client);
    const text = result.content[0].text;

    // Counts in the clear, contents withheld: the numbers are the account's real
    // ones, so the gate must not read as "nothing found".
    expect(text).toContain('3 entities appear in more than one');
    expect(text).toContain('not included on this plan');
    expect(text).not.toContain('Shared entities');
  });

  it('does not claim a cross-project view when there is only one project', async () => {
    const client = {
      getPortfolio: vi.fn().mockResolvedValue({
        locked: false,
        counts: { projects: 1, decisions: 4, shared_entities: 0 },
        entities: { total: 0, entries: [] },
        decisions: { total: 4, entries: [] },
      }),
    } as any;

    const result = await handleContextSyncTool('recall', { action: 'portfolio' }, client);

    expect(result.content[0].text).toContain('needs more than one project');
  });

  it('routes manage_projects create without changing the legacy handler contract', async () => {
    const client = {
      createContextProject: vi.fn().mockResolvedValue({
        project: { project_id: 'project_2', project_name: 'OAuth Review', parent_project_id: 'project_1' },
      }),
    } as any;

    const result = await handleContextSyncTool('manage_projects', {
      action: 'create',
      project_name: 'OAuth Review',
      parent_project_id: 'project_1',
    }, client);

    // The fourth argument flags the create as this agent session's first load
    // (activation 3a): the tool's surface, so the server books session one.
    expect(client.createContextProject).toHaveBeenCalledWith('OAuth Review', undefined, 'project_1', {
      mcpSession: { tool: null },
    });
    expect(result.content[0].text).toContain('project_2');
  });

  it('routes browse_skills get to the stored-skill reader', async () => {
    const client = {
      getSkill: vi.fn().mockResolvedValue({ slug: 'humanizer', name: 'Humanizer', markdown_content: '# Humanizer' }),
    } as any;

    const result = await handleContextSyncTool('browse_skills', { action: 'get', slug: 'humanizer' }, client);

    expect(client.getSkill).toHaveBeenCalledWith('humanizer');
    expect(result.content[0].text).toContain('# Humanizer');
  });

  it('requires explicit confirmation before forced task cleanup', async () => {
    const client = {
      getContextJson: vi.fn().mockResolvedValue({ context: { project_name: 'Aurora', current_task: 'Review OAuth', commands: ['x'], open_questions: ['Done?'] } }),
      patchProjectContext: vi.fn(),
    } as any;

    const result = await handleContextSyncTool('manage_memory', {
      action: 'finish_task',
      project_id: 'project_1',
      complete_task: true,
    }, client) as any;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('confirm_complete=true');
    expect(client.patchProjectContext).not.toHaveBeenCalled();
  });
});
