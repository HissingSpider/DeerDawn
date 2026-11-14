import Head from 'next/head';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, ApiError, type ContextProjectSummary } from '@/lib/api';
import { Skeleton } from '@/components/ui/Skeleton';
import { InlineErrorState } from '@/components/dashboard/PageScaffold';
import { RefusalNotice, loadFailureFrom } from '@/components/dashboard/RefusalNotice';
import { isRefusedLoad, type LoadFailure } from '@/lib/loadFailure';
import { ArchivedProjectsNotice } from '@/components/dashboard/ArchivedProjectsNotice';
import type { ArchivedProjectLike } from '@/lib/archivedProjects';
import { useDashboardBootstrap } from '@/components/dashboard/DashboardBootstrapProvider';
import { CheckIcon } from '@/components/icons';
import { relativeTime, shortTime } from '@/lib/relativeTime';
import {
  CONNECT_CTA_LABEL,
  CONNECT_ROUTE,
  absentCallout,
  connectionPlacement,
  proofLine,
  readConnectionState,
  type ConnectionPlacement,
  type ConnectionState,
} from '@/lib/todayConnection';

// Five rows, not three. The project cap came off in the same change that added
// this page, so an account can finally hold enough projects for the list to be
// worth scanning; three would have been sized for the world where nobody could
// have more than three anyway.
const RECENT_PROJECT_ROWS = 5;

// Every "4h ago" on this page is measured against ONE timestamp, taken after
// mount rather than during render. Two reasons, and both are real: reading the
// clock while rendering is impure (the same props would produce different
// output), and the server and the browser would disagree on it, which is a
// hydration mismatch on the first thing a returning user sees.
function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => { setNow(Date.now()); }, []);
  return now;
}

function ProjectPill({ name }: { name: string }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-border-subtle bg-overlay-subtle px-2.5 py-0.5 text-[11px] font-medium text-text-secondary">
      {name}
    </span>
  );
}

// "Pick up where you left off" — the most recently touched project, the task you
// stopped on, and the one line that says why it stalled if it did.
function ResumeCard({ project, now }: { project: ContextProjectSummary; now: number | null }) {
  const context = project.context || {};
  const task = context.current_task || context.current_status || 'No current task recorded yet.';
  const relative = relativeTime(now, project.updated_at);
  const touched = relative ? `last touched ${relative} ago` : '';

  return (
    <section className="rounded-xl border border-border-subtle bg-surface-elevated p-5 max-sm:p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs font-medium text-text-muted">Pick up where you left off</span>
        <ProjectPill name={project.project_name} />
      </div>
      <p className="mt-3 text-base leading-6 text-text-primary">{task}</p>
      <p className="mt-2 min-h-[1.25rem] text-[13px] leading-5 text-text-secondary">
        {context.blocking_issue
          ? [`Blocked: ${context.blocking_issue}`, touched].filter(Boolean).join(' · ')
          : touched.charAt(0).toUpperCase() + touched.slice(1)}
      </p>
      <Link
        href="/projects"
        className="mt-4 inline-flex text-[13px] font-semibold text-primary no-underline underline-offset-4 hover:underline"
      >
        Open the brief
      </Link>
    </section>
  );
}

// One row per recent project. Excludes whatever the resume card already shows —
// repeating it would spend the first row on something the reader just read.
function AcrossYourProjects({ projects, now }: { projects: ContextProjectSummary[]; now: number | null }) {
  if (projects.length === 0) return null;
  return (
    <section>
      <h2 className="mb-2 text-xs font-medium text-text-muted">Across your projects</h2>
      <div className="rounded-xl border border-border-subtle">
        {projects.map((project, index) => (
          <div
            key={project.project_id}
            className={`flex items-center gap-3 px-4 py-3 ${index > 0 ? 'border-t border-border-subtle' : ''}`}
          >
            {/* Fixed min-width so the pills align down the column instead of
                stepping in and out with each project name's length. */}
            <span className="min-w-[8.5rem] shrink-0 max-sm:min-w-0">
              <ProjectPill name={project.project_name} />
            </span>
            <span className="min-w-0 flex-1 truncate text-sm text-text-secondary">
              {project.context?.current_task || project.context?.current_status || 'No current task recorded'}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-text-muted">
              {shortTime(now, project.updated_at)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// Which surfaces are live and when each last called in. This answers the
// question that actually brings someone back to the dashboard after an install:
// did it work?
//
// State is computed by the page (it decides the strip's POSITION from the same
// reading) and handed down, so the two can never disagree about whether this is
// a quiet footer or the thing the reader has to act on.
function ConnectionHealth({ state, now }: { state: ConnectionState; now: number | null }) {
  if (state.absent) {
    // Only reachable with projects on the page — `connectionPlacement` hides the
    // strip in the zero state, where the empty hero already carries this CTA.
    //
    // Which sentence, and which destination, is `absentCallout`'s decision and
    // not this component's. `mcp_surfaces` is a 30-day window, so an empty list
    // means EITHER "never connected" or "connected, then quiet for a month" —
    // and this branch used to render the first sentence to both. Deciding it
    // here would put the rule back somewhere no test can execute it.
    const callout = absentCallout(state.absentReason ?? 'never');
    return (
      <section className="rounded-xl border border-border-subtle bg-surface px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px]">
          <span className="text-text-secondary">{callout.message}</span>
          <Link
            href={callout.ctaRoute}
            className="font-semibold text-primary no-underline underline-offset-4 hover:underline"
          >
            {callout.ctaLabel}
          </Link>
        </div>
      </section>
    );
  }

  const anyStale = state.staleCount > 0;

  return (
    <section className="rounded-xl border border-border-subtle bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px]">
        <span className={`inline-flex items-center gap-1.5 font-semibold ${anyStale ? 'text-status-warning' : 'text-primary'}`}>
          {/* A tick beside an amber count contradicts itself — it read "all
              good" in the exact state the strip exists to flag. */}
          {anyStale ? null : <CheckIcon />}
          {state.liveCount} {state.liveCount === 1 ? 'surface' : 'surfaces'} live
        </span>
        {state.surfaces.map((surface) => (
          <span
            key={surface.surface}
            className={surface.stale ? 'text-status-warning' : 'text-text-muted'}
          >
            {surface.surface} · {shortTime(now, surface.last_called_at)}
          </span>
        ))}
      </div>
    </section>
  );
}

// The proof. DeerDawn works by preventing a cost the user never sees — the
// re-explaining that did not happen — so a page with no evidence on it asks to
// be taken on faith, daily. One line, from numbers the bootstrap already
// returns: nothing new is fetched, and nothing is estimated.
function ProofLine() {
  const { bootstrap, isLoading } = useDashboardBootstrap();
  if (isLoading) return null;

  const line = proofLine(bootstrap?.sync_health?.session_stats);
  if (!line) return null;

  return <p className="text-xs tabular-nums text-text-muted">{line}</p>;
}

function NothingYet() {
  return (
    <div className="rounded-xl border border-primary/20 bg-primary/[0.04] p-5 max-sm:p-4">
      <h2 className="text-xl font-semibold tracking-[-0.02em] text-text-primary max-sm:text-lg">
        Nothing to pick up yet.
      </h2>
      <p className="mt-2 max-w-xl text-sm leading-6 text-text-secondary">
        Once a tool is connected, this page opens on whatever you touched last — the project, the
        task you stopped on, and whether anything is blocking it.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2.5">
        {/* The page's ONE connect CTA. The strip below used to paint a second
            one with the same words and a different route; it now stands down
            whenever this hero is on screen. */}
        <Link
          href={CONNECT_ROUTE}
          className="rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-on-primary no-underline hover:bg-primary/90"
        >
          {CONNECT_CTA_LABEL}
        </Link>
        <Link
          href="/context/import"
          className="text-[13px] font-medium text-text-secondary no-underline underline-offset-4 transition-colors hover:text-text-primary hover:underline"
        >
          or import existing context
        </Link>
      </div>
    </div>
  );
}

// Today — the default landing. What you touched last across every project, the
// resume line, and connection health as one row. It replaces the brief as the
// first thing a returning user sees, because "what was I doing" is the question
// that made them open the tab. The brief itself now lives at /projects.
export default function TodayPage() {
  const [projects, setProjects] = useState<ContextProjectSummary[] | null>(null);
  // Read only when nothing is active, so an account with projects makes no
  // extra request and renders exactly as before.
  const [archived, setArchived] = useState<ArchivedProjectLike[]>([]);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [failureRef, setFailureRef] = useState<string | undefined>(undefined);
  // REFUSED IS NOT "DIDN'T COME BACK". A workspace whose subscription is
  // inactive answers 403 subscription_inactive; this page told that person it
  // was a dropped connection and offered a Retry that is refused identically.
  // lib/loadFailure tells the two apart; `failed` keeps meaning the second.
  const [refusal, setRefusal] = useState<LoadFailure | null>(null);
  const now = useNow();
  const { bootstrap, isLoading: healthLoading } = useDashboardBootstrap();

  useEffect(() => {
    let cancelled = false;
    api.getContextProjects()
      .then((list) => {
        if (cancelled) return;
        // The API already orders by updated_at DESC, but recency IS this page's
        // premise, so it sorts rather than trusting the order it was handed.
        const sorted = [...list].sort(
          (a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0),
        );
        if (sorted.length > 0) {
          setProjects(sorted);
          return;
        }
        // NOTHING ACTIVE IS NOT NOTHING. Idle projects are archived after 30
        // days and leave this listing, so a person back after five weeks was
        // told there was nothing to pick up while their projects sat one click
        // away. Ask before choosing the empty state; the skeleton stays up
        // meanwhile. A failed ask says what the page said before.
        api.getArchivedContextProjects()
          .catch(() => [] as ArchivedProjectLike[])
          .then((rows) => {
            if (cancelled) return;
            setArchived(rows);
            setProjects(sorted);
          });
      })
      // Leave `projects` NULL on failure. Setting it to [] made `resume` null,
      // which rendered NothingYet — so a returning user with five projects whose
      // token refresh failed opened the default page of a MEMORY product and was
      // told, in the largest type on screen, that there was nothing to pick up
      // and they should go connect a tool. Failure is not emptiness.
      .catch((err) => {
        if (cancelled) return;
        void loadFailureFrom(err).then((failure) => {
          if (cancelled) return;
          if (isRefusedLoad(failure)) {
            setRefusal(failure);
            return;
          }
          setFailed(true);
          setFailureRef(err instanceof ApiError ? err.requestId : undefined);
        });
      });
    return () => { cancelled = true; };
  }, [attempt]);

  // Coming back online is a reliable signal a retry can now succeed — the same
  // pattern portfolio.tsx already uses.
  useEffect(() => {
    if (!failed) return;
    const retry = () => { setFailed(false); setProjects(null); setAttempt((n) => n + 1); };
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [failed]);

  const resume = projects?.[0] ?? null;
  const rest = (projects ?? []).slice(1, 1 + RECENT_PROJECT_ROWS);

  // The strip's reading and its position come from one call, so "actionable"
  // and "shown at the top" cannot drift apart. `now === null` before mount, and
  // the bootstrap may still be in flight: both render the skeleton in the
  // footer slot, which is where the strip sits in the common (all-live) case —
  // so the settled layout does not jump for the majority of readers.
  const healthReady = !healthLoading && now !== null;
  // The third argument is the durable half of sync_health — has_first_sync and
  // the lifetime session count. Both outlive the 30-day window the surface list
  // is selected in, so they are what tells an account that has been quiet for a
  // month apart from one that has never connected anything. Same payload, no
  // extra request.
  const connection = readConnectionState(
    bootstrap?.sync_health?.mcp_surfaces,
    now ?? 0,
    bootstrap?.sync_health,
  );
  // Archived projects are projects: the strip stands down only for the empty
  // hero that carries the connect CTA, and the archived notice does not.
  const placement: ConnectionPlacement = healthReady
    ? connectionPlacement(connection, (projects?.length ?? 0) > 0 || archived.length > 0)
    : 'footer';
  const healthStrip = healthReady
    ? <ConnectionHealth state={connection} now={now} />
    : <Skeleton variant="rectangular" height={44} />;

  return (
    <>
      <Head><title>Today | DeerDawn</title></Head>

      <div className="flex min-h-0 flex-1 flex-col gap-4">
        {/* The page names itself in the same slot every route does — an h1 on the
            control row, with the page's own context beside it. ProofLine stays
            above everything, including a failed projects fetch: it comes from a
            different request, and "162 sessions briefed" is exactly the thing
            worth saying to someone whose page just failed to load. */}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="dashboard-title">Today</h1>
          <ProofLine />
        </div>

        {refusal ? <RefusalNotice failure={refusal} /> : null}

        {failed ? (
          <InlineErrorState
            title="Couldn't reach your projects"
            description="The request didn't come back — usually a dropped connection or an expired session. Nothing is lost; retrying is safe."
            requestId={failureRef}
            onRetry={() => { setFailed(false); setFailureRef(undefined); setProjects(null); setAttempt((n) => n + 1); }}
          />
        ) : null}

        {projects === null && !failed && !refusal ? (
          <Skeleton variant="rectangular" height={320} />
        ) : projects === null ? null : (
          <>
            {/* A stale or missing surface is the most important thing on this
                page — a resume card is worth nothing if no tool is reading it —
                so it goes first. When everything is live it is a footer. */}
            {placement === 'top' ? healthStrip : null}
            {resume
              ? <ResumeCard project={resume} now={now} />
              : archived.length > 0 ? <ArchivedProjectsNotice archived={archived} /> : <NothingYet />}
            <AcrossYourProjects projects={rest} now={now} />
            {placement === 'footer' ? healthStrip : null}
          </>
        )}
      </div>
    </>
  );
}
