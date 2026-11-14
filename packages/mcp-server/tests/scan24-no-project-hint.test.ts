import { describe, it, expect } from 'vitest';
import { describeWriteRefusal } from '../src/write-target.js';
import { listTools } from '../src/tools/index.js';

// SCAN 24 (b) #5. With no project, a write told the caller to "run
// start_session first" — and on a brand-new account start_session creates
// nothing, so the caller went round in a circle. The hint now names the
// advertised tool that creates one.

describe('the no-project hint', () => {
  it('names manage_projects(create), not start_session', () => {
    const text = describeWriteRefusal({ kind: 'none' } as any, 'record a finding in');
    expect(text).toContain('manage_projects(action:"create", project_name:');
    expect(text).toContain('recall(action:"projects")');
    expect(text).not.toMatch(/start_session first/);
  });

  it('names only tools every local catalog advertises', () => {
    for (const options of [undefined, { authed: true, hasSkills: true }, { authed: false, hasSkills: false }]) {
      const names = listTools(options as any).map((tool: any) => tool.name);
      expect(names).toContain('manage_projects');
      expect(names).toContain('recall');
      const manage = listTools(options as any).find((tool: any) => tool.name === 'manage_projects') as any;
      expect(manage.inputSchema.properties.action.enum).toContain('create');
      expect(Object.keys(manage.inputSchema.properties)).toContain('project_name');
    }
  });
});
