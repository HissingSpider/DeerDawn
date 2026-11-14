import Head from 'next/head';
import { useCallback, useEffect, useState } from 'react';
import {
  DashboardStatusPill,
  DashboardTableWrap,
  EmptyHero,
  InlineErrorState,
  PageScaffold,
  PanelHeader,
  SurfacePanel,
} from '@/components/dashboard/PageScaffold';
import { Button } from '@/components/ui/Button';
import { UsersIcon } from '@/components/icons';
import { api, type OperatorToday } from '@/lib/api';
import {
  OPERATOR_WINDOWS,
  clockTime,
  displayName,
  overflowLabel,
  relativeTime,
  summarySentence,
} from '@/lib/operatorToday';
import { logger } from '@/lib/logger';

/**
 * /admin/today — "did anyone get value today?", answerable at a glance.
 *
 * WHAT THIS REPLACES: the same question, asked by spinning up an agent and a
 * git worktree and writing SQL by hand. That is why the answer has only ever
 * existed as a daily report in docs/growth/daily-reports/ — there was no
 * surface to read it from.
 *
 * DELIBERATELY A LIST, NOT A DASHBOARD. Tiles and charts are what you build
 * when the number is large enough to have a shape. At this volume the useful
 * artefact is the names: one row per human, readable in five seconds. The three
 * counts at the top are a sentence, not a tile row, for the same reason.
 *
 * COLOUR LAW: a surface is tinted only when it encodes state worth acting on.
 * Exactly one thing here qualifies — somebody's FIRST brief. Counts, tools and
 * project names are neutral.
 */

export default function AdminToday() {
  const [days, setDays] = useState(1);
  const [data, setData] = useState<OperatorToday | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Rendered relative times are computed against a value captured on load
  // rather than at render, so a re-render cannot make two rows disagree.
  const [now, setNow] = useState<number>(() => Date.now());

  const load = useCallback((windowDays: number) => {
    setLoading(true);
    setError(null);
    api.getOperatorToday(windowDays)
      .then((res) => {
        setData(res);
        setNow(Date.now());
      })
      .catch((err) => {
        logger.error('admin_today_load_failed', err);
        setError(err?.message || 'Could not load the day. This view is platform-staff only.');
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load(days);
  }, [days, load]);

  const activeWindow = OPERATOR_WINDOWS.find((w) => w.days === days) ?? OPERATOR_WINDOWS[0];

  return (
    <>
      <Head>
        <title>Today | DeerDawn</title>
      </Head>

      <PageScaffold
        title="Today"
        description="Every human who got a brief, one row each — read from the product database, not analytics. Platform-staff only."
        action={
          <div className="flex items-center gap-1 rounded-full border border-border-subtle bg-overlay-subtle p-1">
            {OPERATOR_WINDOWS.map((w) => (
              <button
                key={w.days}
                type="button"
                onClick={() => setDays(w.days)}
                aria-pressed={w.days === days}
                className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                  w.days === days
                    ? 'bg-surface-elevated text-text-primary'
                    : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
        }
      >
        {error ? (
          <InlineErrorState
            title="Could not load the day"
            description={error}
            onRetry={() => load(days)}
          />
        ) : null}

        {data && !error ? (
          <>
            <p className="text-[15px] leading-7 text-text-secondary">
              {summarySentence(data, activeWindow.phrase)}
            </p>

            {data.people.length === 0 ? (
              <SurfacePanel>
                <EmptyHero
                  icon={<UsersIcon />}
                  title={`No briefs ${activeWindow.phrase}`}
                  description={
                    'Nobody outside the team started a session in this window. This is the real number — '
                    + 'the founder and synthetic accounts are excluded, so an empty list means empty.'
                  }
                  secondaryAction={
                    days === 30 ? undefined : (
                      <Button variant="secondary" onClick={() => setDays(days === 1 ? 7 : 30)}>
                        {days === 1 ? 'Look back 7 days' : 'Look back 30 days'}
                      </Button>
                    )
                  }
                />
              </SurfacePanel>
            ) : (
              <SurfacePanel>
                <PanelHeader
                  title="Who got a brief"
                  description="Most recent first. A person appears once, however many briefs they took."
                />
                <DashboardTableWrap>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-text-muted">
                        <th className="px-6 py-3 font-medium">Who</th>
                        <th className="px-6 py-3 font-medium">Project</th>
                        <th className="px-6 py-3 font-medium">Tool</th>
                        <th className="px-6 py-3 font-medium">Briefs</th>
                        <th className="px-6 py-3 font-medium">Last seen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.people.map((person) => (
                        <tr
                          key={person.person_key}
                          className="border-t border-border-subtle align-top text-text-primary"
                        >
                          <td className="px-6 py-4">
                            <div className="flex flex-wrap items-center gap-2">
                              {/* An unresolved row is named by displayName, which states
                                  the gap rather than inventing a person for it. */}
                              <span className="font-medium">{displayName(person)}</span>
                              {person.is_first_ever ? (
                                <DashboardStatusPill tone="success">First brief</DashboardStatusPill>
                              ) : null}
                            </div>
                            <div className="mt-1 font-mono text-xs text-text-muted">
                              {person.owner_key}
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <div className="text-text-secondary">{person.latest_project ?? '—'}</div>
                            {overflowLabel(person.projects) ? (
                              <div className="mt-1 text-xs text-text-muted">
                                {overflowLabel(person.projects)}
                              </div>
                            ) : null}
                          </td>
                          <td className="px-6 py-4">
                            <div className="text-text-secondary">{person.latest_tool ?? '—'}</div>
                            {overflowLabel(person.tools) ? (
                              <div className="mt-1 text-xs text-text-muted">
                                {overflowLabel(person.tools)}
                              </div>
                            ) : null}
                          </td>
                          <td className="px-6 py-4 text-text-secondary">{person.briefs}</td>
                          <td className="px-6 py-4">
                            <div className="text-text-secondary">{relativeTime(person.last_brief_at, now)}</div>
                            <div className="mt-1 text-xs text-text-muted">{clockTime(person.last_brief_at)}</div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </DashboardTableWrap>
              </SurfacePanel>
            )}
          </>
        ) : null}

        {loading && !data && !error ? (
          <SurfacePanel>
            <div className="px-6 py-5 text-sm text-text-muted">Loading the day…</div>
          </SurfacePanel>
        ) : null}
      </PageScaffold>
    </>
  );
}
