import Link from 'next/link';
import { surfaceLabel } from './brief/surfaces';
import { useDashboardBootstrap } from './DashboardBootstrapProvider';
import { useWeeklyActivity } from './useWeeklyActivity';

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-2xl font-semibold tabular-nums tracking-[-0.03em] text-text-primary">
        {value.toLocaleString()}
      </span>
      <span className="text-[13px] leading-snug text-text-muted">{label}</span>
    </div>
  );
}

// "What DeerDawn did for you this week." This used to be a strip pinned above
// every route in AppShell — the same four numbers on the brief, the graph, the
// tool setup and the key list, plus an undismissable drift warning. Numbers
// belong where someone goes to read numbers, so it lives on Usage now; the
// drift count moved to the Memory nav badge, next to the list that resolves it.
// Renders nothing until there is real activity.
export function WeeklyActivityPanel() {
  const { bootstrap } = useDashboardBootstrap();
  const data = useWeeklyActivity();

  if (!data) return null;
  const hasActivity =
    data.context_delivered > 0 || data.decisions_captured > 0 || data.projects_touched > 0;
  if (!hasActivity) return null;

  const tools = data.delivered_by_tool.slice(0, 4).map((t) => surfaceLabel(t.tool));
  // Only surface "teammates" for a genuinely shared workspace — a solo owner's own
  // multiple logins/keys (now also excluded server-side) should never trigger it.
  const isTeamOrg =
    (bootstrap?.usage?.admins ?? 0) > 1 || bootstrap?.org?.account_type === 'organization';
  const staleNames = data.stale_project_names ?? [];
  const overflow = data.stale_projects - staleNames.length;

  return (
    <section className="rounded-xl border border-border-subtle bg-overlay-subtle p-5">
      <h2 className="text-[13px] font-semibold uppercase tracking-[0.1em] text-text-secondary">
        This week
      </h2>

      <div className="mt-4 flex flex-wrap gap-x-10 gap-y-5">
        {data.context_delivered > 0 && <Stat value={data.context_delivered} label="context loads" />}
        {data.decisions_captured > 0 && (
          <Stat value={data.decisions_captured} label="decisions captured" />
        )}
        {data.projects_touched > 0 && <Stat value={data.projects_touched} label="projects active" />}
        {isTeamOrg && data.contributors > 0 && <Stat value={data.contributors} label="teammates" />}
      </div>

      {tools.length > 0 && (
        <p className="mt-4 text-[13px] text-text-muted">Delivered to {tools.join(', ')}.</p>
      )}

      {data.stale_projects > 0 && (
        <div className="mt-4 border-t border-border-subtle pt-4">
          <p className="text-[13px] text-text-secondary">
            <span className="font-semibold text-status-warning">{data.stale_projects}</span>{' '}
            {data.stale_projects === 1 ? 'project has' : 'projects have'} drifted from your latest
            work. Open {data.stale_projects === 1 ? 'it' : 'them'} in your AI tool and DeerDawn
            refreshes automatically.
          </p>
          {staleNames.length > 0 && (
            <p className="mt-1.5 text-[12px] text-text-muted">
              {staleNames.join(', ')}
              {overflow > 0 ? `, +${overflow} more` : ''}
            </p>
          )}
          <Link
            href="/memory"
            className="mt-2 inline-block text-[13px] font-medium text-primary hover:underline"
          >
            Review in Memory →
          </Link>
        </div>
      )}
    </section>
  );
}
