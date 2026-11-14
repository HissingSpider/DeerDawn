import Link from 'next/link';
import { useDashboardBootstrap } from '@/components/dashboard/DashboardBootstrapProvider';
import { SURFACE_WINDOW_DAYS } from '@/lib/todayConnection';
import { identifiedSurfaces, surfaceLabel } from './surfaces';

// The habit nudge: shown only when exactly ONE tool is connected to DeerDawn.
// The first cross-surface catch-up (work in Cursor Monday, open Claude Code
// Tuesday, already current) is the moment DeerDawn stops being "a tool I tried"
// and becomes part of how the machine works — single-tool users can churn back
// to CLAUDE.md; two-surface users structurally can't. A fact plus an offer,
// calm by design: no urgency, no streaks. Disappears forever once a second
// surface shows up.
//
// Uses the SAME identifiedSurfaces() list as ConnectedToolsCaughtUp so the two
// panels can never contradict: the "everything reached you through X" copy only
// appears when X really is the only connected tool.
//
// The sentence is scoped to the window ON PURPOSE. `mcp_surfaces` is a 30-day
// aggregate server-side, so a one-entry list means "one tool called in during
// the window", NOT "one tool, ever" — someone who spent six months in Claude
// Code and moved to Cursor last month arrives here with a list of exactly one.
// The old copy, "Everything SO FAR has reached you through Cursor", is the same
// windowed-array bug that told a month-quiet account it had never synced (see
// BriefFreshness): a lifetime claim read off a 30-day window.
//
// Unlike that one it cannot be fixed by checking lifetime evidence, because
// there is none to check at this grain — `has_first_sync` and
// `session_stats.total_sessions` are account-wide and say nothing about HOW MANY
// surfaces have ever called in. So the fix is the one `absentCallout()` uses:
// claim only what the data covers, and name the window. The offer underneath
// needs no such hedge — a second surface that is actually live is worth having
// whether or not an older one has gone quiet.

export function SecondToolNudge() {
  const { bootstrap } = useDashboardBootstrap();
  const health = bootstrap?.sync_health;
  const surfaces = identifiedSurfaces(health?.mcp_surfaces);

  // Only the single-tool state gets the nudge — and only once a project exists,
  // so it never competes with onboarding.
  if (surfaces.length !== 1 || !health?.has_projects) return null;

  const current = surfaceLabel(surfaces[0].surface);

  return (
    <div className="rounded-xl border border-border-subtle bg-overlay-subtle p-4">
      <h3 className="text-[12px] font-semibold uppercase tracking-[0.1em] text-text-secondary">
        The brief follows you
      </h3>
      <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">
        Over the last {SURFACE_WINDOW_DAYS} days, everything has reached you through{' '}
        <span className="text-text-primary">{current}</span>. Connect a second tool and the same brief is already
        current there — switch surfaces without re-explaining anything.
      </p>
      <Link
        href="/setup"
        className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline"
      >
        Connect a second tool →
      </Link>
    </div>
  );
}
