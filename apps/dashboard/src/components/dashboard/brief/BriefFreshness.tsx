import { useDashboardBootstrap } from '@/components/dashboard/DashboardBootstrapProvider';
import { everConnected, SURFACE_WINDOW_DAYS } from '@/lib/todayConnection';
import { identifiedSurfaces, surfaceLabel } from './surfaces';

// One line that answers "is this current?".
//
// It replaces four separate cards that each answered a slice of the same
// question — ConnectedToolsCaughtUp (per-tool last-seen), TodaysBriefCard
// (which project is active), BriefDiffCard (what changed this week) and the
// session badge. Four panels for one question is why the page read as clutter;
// the answer is a dot, a timestamp and the tools it reached.
export function BriefFreshness() {
  const { bootstrap } = useDashboardBootstrap();
  const health = bootstrap?.sync_health;
  const surfaces = identifiedSurfaces(health?.mcp_surfaces);

  if (!health) return null;

  // Most recent call across every connected surface — the honest "caught up" time.
  const latest = surfaces.reduce<number | null>((acc, s) => {
    const t = s.last_called_at ? new Date(s.last_called_at).getTime() : NaN;
    if (Number.isNaN(t)) return acc;
    return acc === null || t > acc ? t : acc;
  }, null);

  const tools = surfaces
    .slice()
    .sort((a, b) => (b.tool_calls ?? 0) - (a.tool_calls ?? 0))
    .slice(0, 3)
    .map((s) => surfaceLabel(s.surface));

  const live = Boolean(health.recently_active);

  // `mcp_surfaces` is a 30-DAY window server-side, so an empty array means "no
  // tool has called in 30 days" — NOT "never". Reading it as never told an
  // established user who had been quiet for a month that their brief had never
  // synced, which is the one thing a memory product must never say wrongly. The
  // lifetime signals sit in the same payload, and everConnected() is the rule
  // Today already uses; a second copy of it here is how the two would drift.
  const hasConnectedEver = everConnected(health);
  const freshness = latest !== null
    ? `caught up ${relativeTime(latest)}`
    : hasConnectedEver
      ? `no tool has called in ${SURFACE_WINDOW_DAYS} days`
      : 'not synced yet';

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12.5px] text-text-muted">
      <span
        aria-hidden
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${live ? 'bg-primary' : 'bg-overlay-strong'}`}
      />
      <span>{freshness}</span>
      {tools.length > 0 && (
        <>
          <span aria-hidden className="opacity-50">
            ·
          </span>
          <span className="truncate">{tools.join(', ')}</span>
        </>
      )}
    </span>
  );
}

function relativeTime(then: number): string {
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
