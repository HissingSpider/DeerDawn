import type { PortfolioEntity } from '@/lib/api';

/**
 * Portfolio is one flat list of "things in more than one project", and that flat
 * list buried its own point.
 *
 * Sixty-two rows came back, and roughly thirty-five of them were language and
 * framework names lifted out of project stacks: TypeScript in 9, React in 6,
 * Node.js in 4, then a long tail of 2s. All true, none of it insight — "I use
 * TypeScript a lot" is not something you needed a memory product to learn.
 *
 * Meanwhile the rows that ARE the point — "Day-2 activation is upstream of
 * every acquisition question", "Entitlements gate reads, never writes" — sat at
 * the BOTTOM of the same undifferentiated list, in the same type, showing a
 * bare em dash where the others showed a count, because they belong to the
 * whole workspace rather than to N named projects. The list sorted by project
 * count, so the least interesting rows were structurally guaranteed to win the
 * top of the page and the most interesting ones to lose it.
 *
 * So the split is by KIND, not by count. Two groups, two treatments:
 *
 *   - Insight (what you decided and learned) reads as prose, leads the page,
 *     and shows the summary the old list never rendered at all.
 *   - Stack (the tools) is a distribution, not a reading list. It collapses to
 *     one compact bar chart, where "spans 9 of your 18 projects" is a glance
 *     rather than a row.
 */

/**
 * Node types that carry a judgement rather than a dependency. These are the
 * rows worth reading top to bottom.
 *
 * `environment` is deliberately NOT here: "DeerDawn API — Fly.io" is where
 * something runs, which is stack. The test is whether the row would still be
 * true if you rewrote the code in another language — a decision survives that,
 * a runtime does not.
 */
export const INSIGHT_TYPES: ReadonlySet<string> = new Set([
  'knowledge',
  'decision',
  'workflow',
  'pattern',
  'insight',
  'finding',
  'constraint',
]);

export function isInsight(entity: Pick<PortfolioEntity, 'entity_type'>): boolean {
  return INSIGHT_TYPES.has(String(entity.entity_type || '').toLowerCase());
}

/**
 * Split, preserving the server's order inside each group. The server sorts by
 * project count, which is the right order for the stack chart and harmless for
 * insight (where the count is usually workspace-wide anyway).
 */
export function splitEntities(entities: PortfolioEntity[]): {
  insights: PortfolioEntity[];
  stack: PortfolioEntity[];
} {
  const insights: PortfolioEntity[] = [];
  const stack: PortfolioEntity[] = [];
  for (const entity of entities) (isInsight(entity) ? insights : stack).push(entity);
  return { insights, stack };
}

/**
 * Bar width, as a fraction of ALL your projects — not of the largest bar.
 *
 * Scaling to the largest would stretch the top item to full width and imply it
 * is everywhere, which at 9 of 18 is exactly half true. The honest denominator
 * is the project count, so a short bar reads as "narrow reach" rather than as a
 * rendering artefact. Clamped to a visible minimum so a real 1-project row is
 * never an invisible sliver, and to 1 so bad data cannot overflow the track.
 */
export function stackShare(projectCount: number, totalProjects: number): number {
  if (!Number.isFinite(projectCount) || projectCount <= 0) return 0;
  if (!Number.isFinite(totalProjects) || totalProjects <= 0) return 0;
  return Math.min(1, Math.max(0.04, projectCount / totalProjects));
}

/**
 * How far something reaches, in words.
 *
 * The old list printed `project_count || '—'`, so every workspace-scoped row —
 * which is most of the interesting ones — rendered a dash. A dash reads as
 * missing data. These rows are not missing a number; they genuinely apply
 * everywhere, which is MORE reach than "3 projects", not less.
 */
export function reachLabel(entity: Pick<PortfolioEntity, 'project_count' | 'shared_reason'>): string {
  if (entity.shared_reason === 'workspace_scope') return 'Workspace-wide';
  const count = Number(entity.project_count || 0);
  if (count <= 0) return 'Workspace-wide';
  return `${count} project${count === 1 ? '' : 's'}`;
}

/**
 * The sentence at the top of the page. Leads with whichever group the reader
 * actually has, because "62 shared entities" is a number about our data model
 * and "11 things you decided that apply across projects" is a number about
 * their work.
 */
export function portfolioLead(
  insightCount: number,
  stackCount: number,
  projectCount: number,
): string {
  if (insightCount === 0 && stackCount === 0) {
    return projectCount <= 1
      ? 'Cross-project starts at your second project. What repeats across them collects here.'
      : `Nothing yet spans two of your ${projectCount} projects.`;
  }
  const parts: string[] = [];
  if (insightCount > 0) {
    parts.push(
      `${insightCount} thing${insightCount === 1 ? '' : 's'} you've decided or learned ${
        insightCount === 1 ? 'applies' : 'apply'
      } beyond one project`,
    );
  }
  if (stackCount > 0) {
    parts.push(`${stackCount} tool${stackCount === 1 ? '' : 's'} repeat${stackCount === 1 ? 's' : ''} across them`);
  }
  return `${parts.join(', and ')}.`;
}
