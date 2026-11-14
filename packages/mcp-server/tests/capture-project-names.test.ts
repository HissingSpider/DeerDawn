import { describe, expect, it } from 'vitest';
import { normalizeProjectName, projectsNamedLike } from '../src/project-ref.js';

/**
 * A capture whose proposed name another project holds is filed under the name
 * with the folder added ("Billing (payments-api)", journey round 6). The local
 * dispatcher resolves a name reference by the server's own name identity, so the
 * two names must stay two names here as well.
 */
describe('names a capture gives a project', () => {
  const rows = [
    { project_id: 'p_original', project_name: 'Billing' },
    { project_id: 'p_folder', project_name: 'Billing (payments-api)' },
    { project_id: 'p_parent', project_name: 'Billing (work-payments-api)' },
    { project_id: 'p_suffix', project_name: 'Billing (payments-api) 3fa9c1' },
  ];

  it('are four different names', () => {
    const names = rows.map((row) => normalizeProjectName(row.project_name));
    expect(new Set(names).size).toBe(rows.length);
  });

  it('a reference to each one finds exactly that project', () => {
    for (const row of rows) {
      expect(projectsNamedLike(row.project_name, rows).map((r) => r.project_id)).toEqual([row.project_id]);
    }
    expect(projectsNamedLike('billing', rows).map((r) => r.project_id)).toEqual(['p_original']);
  });
});
