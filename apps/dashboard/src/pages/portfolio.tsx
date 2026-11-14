import { PRO_PLAN_NAME } from '@/lib/planCopy';
import Head from 'next/head';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { api, type Portfolio, type PortfolioDecision, type PortfolioEntity } from '@/lib/api';
import { Skeleton } from '@/components/ui/Skeleton';
import { InlineErrorState } from '@/components/dashboard/PageScaffold';
import { RefusalNotice, loadFailureFrom } from '@/components/dashboard/RefusalNotice';
import { isRefusedLoad, type LoadFailure } from '@/lib/loadFailure';
import { ArchivedProjectsNotice } from '@/components/dashboard/ArchivedProjectsNotice';
import { useArchivedOnly } from '@/components/dashboard/useArchivedOnly';
import { LayersIcon, LockIcon, SearchIcon } from '@/components/icons';
import { ClampedText } from '@/components/ui/ClampedText';
import {
  portfolioLead,
  reachLabel,
  splitEntities,
  stackShare,
} from '@/lib/portfolioGrouping';

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function ProjectPill({ name }: { name: string }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-border-subtle bg-overlay-subtle px-2.5 py-0.5 text-[11px] font-medium text-text-secondary">
      {name}
    </span>
  );
}

// A different failure from the raw-palette one, with the same symptom. These
// used tokens correctly — and still disappeared in light mode, because the token
// they picked was `--surface` (#ffffff) sitting on `--background` (#f7f9fc): a
// borderless white card on a near-white page, ~1.02:1. A token is not by itself
// a light-mode guarantee; the PAIR has to be checked. Bordered and tinted like
// every other card on this page and across the brief surfaces, it now has an
// edge in both themes rather than relying on fill contrast alone.
// Exported for /dev/brief-surfaces, which renders it against both palettes at
// once. Only the default export is the page; Next ignores the rest.
export function CountCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-overlay-subtle p-4">
      <div className="text-[13px] text-text-muted">{label}</div>
      <div className="mt-1 text-2xl font-medium tabular-nums text-text-primary">{value}</div>
    </div>
  );
}

// Redaction bars, deliberately not blur. A bar reads as "there is something
// specific here" and shows honestly how much is being withheld; blur reads as a
// visual effect and hides the volume, which is the one thing the locked state
// exists to communicate. Widths vary so the column looks like withheld text
// rather than a loading skeleton.
function RedactionBar({ seed }: { seed: number }) {
  const widths = ['w-32', 'w-44', 'w-52', 'w-40', 'w-60', 'w-36'];
  return <span className={`inline-block h-3 rounded-sm bg-overlay-strong ${widths[seed % widths.length]} max-w-full`} />;
}

// An insight reads as prose, because it is prose. The old row rendered the
// title `truncate`d into a 10rem column with the type and project names
// squeezed into another truncated column beside it — so "Day-2 activation is
// upstream of every acquisition question" arrived as "Day-2 activation is up…"
// and its `summary`, which the API has always returned, was never rendered at
// all. The row was shaped for one-word titles like "TypeScript"; these are
// sentences and get a sentence's width.
function InsightRow({ entity }: { entity: PortfolioEntity }) {
  return (
    <div className="border-t border-border-subtle px-4 py-3.5 first:border-t-0">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="text-[13.5px] font-semibold leading-snug text-text-primary">
          {entity.title}
        </span>
        <span className="text-[11px] uppercase tracking-[0.1em] text-text-muted">
          {entity.entity_type}
        </span>
      </div>
      {entity.summary ? (
        <div className="mt-1 max-w-3xl">
          <ClampedText
            text={entity.summary}
            lines={2}
            className="text-[12.5px] leading-[1.55] text-text-secondary"
          />
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {/* Named projects beat a number: "which two?" is the actual question,
            and the old row answered it with a truncated comma list or, for a
            workspace-scoped row, a bare em dash that read as missing data. */}
        {entity.projects.length > 0 ? (
          entity.projects.map((project) => (
            <ProjectPill key={project.project_id} name={project.project_name} />
          ))
        ) : (
          <span className="text-[11px] text-text-muted">{reachLabel(entity)}</span>
        )}
      </div>
    </div>
  );
}

// The stack is a distribution, not a reading list. Thirty-five rows saying
// "TypeScript · service · 9" told you nothing a chart doesn't tell you faster.
// The bar is measured against ALL your projects, so its length means "how much
// of my work is this in" rather than "how does this rank" — a neutral fill, not
// a tinted one, because reach is data and not a state you can act on.
function StackBar({ entity, totalProjects }: { entity: PortfolioEntity; totalProjects: number }) {
  const share = stackShare(entity.project_count, totalProjects);
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="w-40 shrink-0 truncate text-[12.5px] text-text-primary" title={entity.title}>
        {entity.title}
      </span>
      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-overlay-subtle">
        <span
          className="block h-full rounded-full bg-text-muted"
          style={{ width: `${Math.round(share * 100)}%` }}
        />
      </span>
      <span className="w-6 shrink-0 text-right text-[11.5px] tabular-nums text-text-muted">
        {entity.project_count || '—'}
      </span>
    </div>
  );
}

// Twelve bars is enough to see the shape of a stack; the tail is a long run of
// 2s that adds length, not information. Expandable rather than truncated,
// because "and 23 more" hidden behind nothing is how the useful rows got buried
// in the first place.
const STACK_PREVIEW = 12;

function StackChart({ stack, totalProjects }: { stack: PortfolioEntity[]; totalProjects: number }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? stack : stack.slice(0, STACK_PREVIEW);
  const hidden = stack.length - visible.length;

  return (
    <div className="rounded-xl border border-border-subtle px-4 py-3">
      <div className="grid gap-x-8 md:grid-cols-2">
        {visible.map((entity) => (
          <StackBar key={entity.node_id} entity={entity} totalProjects={totalProjects} />
        ))}
      </div>
      {(hidden > 0 || showAll) && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-2 w-full rounded-lg border border-dashed border-border-subtle py-1.5 text-[11.5px] font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text-secondary"
        >
          {showAll ? 'Show fewer' : `${hidden} more`}
        </button>
      )}
    </div>
  );
}

function LockedEntityRow({ row, index }: { row: Partial<PortfolioEntity>; index: number }) {
  return (
    <div className="flex items-center gap-3 border-t border-border-subtle px-4 py-3 first:border-t-0">
      <span className="shrink-0 text-text-muted">
        <LayersIcon />
      </span>
      <span className="min-w-0 flex-1">
        <RedactionBar seed={index} />
      </span>
      {/* The count stays in the clear. Seeing "4" beside a redacted row is what
          turns the number at the top of the page into something concrete. */}
      <span className="shrink-0 text-xs tabular-nums text-text-muted">{row.project_count || '—'}</span>
    </div>
  );
}

function DecisionTimeline({ decisions }: { decisions: PortfolioDecision[] }) {
  return (
    <div className="border-l border-border-subtle pl-4">
      {decisions.map((decision, index) => (
        <div key={`${decision.project_id}-${index}`} className={index > 0 ? 'mt-4' : ''}>
          <div className="flex flex-wrap items-center gap-2">
            <ProjectPill name={decision.project_name} />
            <span className="text-xs text-text-muted">{formatDate(decision.decided_at)}</span>
          </div>
          <p className="mt-1 text-sm leading-6 text-text-secondary">{decision.summary}</p>
        </div>
      ))}
    </div>
  );
}

function LockedTimeline({ count }: { count: number }) {
  return (
    <div className="border-l border-border-subtle pl-4">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className={index > 0 ? 'mt-4' : ''}>
          <RedactionBar seed={index + 3} />
          <div className="mt-1.5">
            <RedactionBar seed={index} />
          </div>
        </div>
      ))}
    </div>
  );
}

// Leads with the reader's own number in every case, including the two where
// there isn't one yet. A single-project account is the most important of the
// three: cross-project is meaningless at one project, and telling that reader
// "Your 1 projects have no shared entities" was both ungrammatical and a
// non-sequitur. It is also the exact account the cap removal exists to unblock,
// so that line points at the next step rather than at a locked feature.
export function leadLine(counts: Portfolio['counts']): string {
  const shared = counts.shared_entities;
  if (shared > 0) {
    return `${shared} thing${shared === 1 ? '' : 's'} show${shared === 1 ? 's' : ''} up in more than one of your projects.`;
  }
  if (counts.projects <= 1) {
    return 'Cross-project starts at your second project — this is where the services, people and decisions that show up in more than one will collect.';
  }
  return `Nothing yet spans two of your ${counts.projects} projects — this is where the services, people and decisions that show up in more than one will collect.`;
}

// The upgrade panel. Two copy rules, both load-bearing:
//   1. Lead with the reader's OWN number, never a feature name. "9 things show
//      up in more than one of your projects" is an observation about their work;
//      "unlock cross-project search" is an advert.
//   2. ALWAYS say projects stay unlimited. Without that line a counter of locked
//      rows reads as a new cap — which is the exact anxiety removing the project
//      cap exists to remove, reintroduced by the page selling the removal.
function UpgradePanel({ counts }: { counts: Portfolio['counts'] }) {
  return (
    <section className="rounded-xl border border-primary/25 bg-primary/[0.05] p-5 max-sm:p-4">
      <div className="flex items-center gap-2 text-primary">
        <LockIcon />
        <span className="text-xs font-semibold uppercase tracking-[0.12em]">Across projects</span>
      </div>
      <p className="mt-3 text-base leading-6 text-text-primary">{leadLine(counts)}</p>
      <p className="mt-2 text-sm leading-6 text-text-secondary">
        {PRO_PLAN_NAME} opens the contents: what they are, which projects they span, and one decision timeline
        across everything. Your projects stay unlimited on Free, and nothing here is deleted.
      </p>
      <Link
        href="/settings/plan"
        className="mt-4 inline-flex rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-on-primary no-underline hover:bg-primary/90"
      >
        See {PRO_PLAN_NAME}
      </Link>
    </section>
  );
}

// Portfolio — the cross-project view, and the only screen in the product no
// competitor can show. Free and Pro call the SAME endpoint and see the SAME
// counts, computed from the reader's own data; `locked` only decides whether the
// contents come with them.
export default function PortfolioPage() {
  const [data, setData] = useState<Portfolio | null>(null);
  const [error, setError] = useState(false);
  // Refused (the workspace's subscription is inactive) is not a dropped
  // connection; lib/loadFailure tells them apart. `error` keeps meaning the second.
  const [refusal, setRefusal] = useState<LoadFailure | null>(null);
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    setRefusal(null);
    api.getPortfolio(submitted ? { q: submitted } : {})
      .then((result) => { if (!cancelled) setData(result); })
      .catch((err) => {
        if (cancelled) return;
        void loadFailureFrom(err).then((failure) => {
          if (cancelled) return;
          if (isRefusedLoad(failure)) setRefusal(failure);
          else setError(true);
        });
      });
    return () => { cancelled = true; };
  }, [submitted, attempt]);

  // Almost every failure here is the connection dropping mid-request — the auth
  // token fetch dies with it, the call goes out unauthenticated and comes back
  // 401. Coming back online is a reliable signal that a retry can now succeed,
  // so take it rather than leaving the reader to notice the page is dead.
  useEffect(() => {
    if (!error || typeof window === 'undefined') return;
    const retry = () => setAttempt((n) => n + 1);
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [error]);

  const entities = useMemo(
    () => (data && !data.locked ? (data.entities.entries as PortfolioEntity[]) : []),
    [data],
  );
  const decisions = useMemo(
    () => (data && !data.locked ? (data.decisions.entries as PortfolioDecision[]) : []),
    [data],
  );
  // Judgements and tools are different kinds of thing and get different
  // treatments; see lib/portfolioGrouping for why the flat list buried its own
  // point. Empty for a locked account, which renders one undifferentiated list.
  const { insights, stack } = useMemo(() => splitEntities(entities), [entities]);
  // No project to show because every one is archived: say that, not "No
  // decisions recorded yet" (useArchivedOnly).
  const archivedOnly = useArchivedOnly(Boolean(data) && data!.counts.projects === 0);

  return (
    <>
      <Head><title>Portfolio | DeerDawn</title></Head>

      <div className="flex min-h-0 flex-1 flex-col gap-5">
        {refusal ? <RefusalNotice failure={refusal} /> : null}

        {error ? (
          <InlineErrorState
            title="Couldn't load your portfolio"
            description="The request didn't come back — usually a dropped connection. Nothing is lost; retrying is safe."
            onRetry={() => setAttempt((n) => n + 1)}
          />
        ) : null}

        {data === null && !error && !refusal ? <Skeleton variant="rectangular" height={420} /> : null}

        {data ? (
          <>
            {/* Title and search on one row — the same header slot /memory,
                /board and every PageScaffold page use. A search box that cannot
                search is worse than no search box, so the locked state simply
                doesn't have one; the title holds the row on its own. */}
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="dashboard-title">Portfolio</h1>
              {!data.locked ? (
                <form
                  onSubmit={(event) => { event.preventDefault(); setSubmitted(query.trim()); }}
                  className="relative ml-auto min-w-[220px] flex-1 sm:max-w-[320px] sm:flex-none"
                >
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">
                    <SearchIcon />
                  </span>
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search across all projects"
                    aria-label="Search across all projects"
                    className="w-full rounded-lg border border-border-subtle bg-surface py-2.5 pl-10 pr-3 text-sm text-text-primary placeholder:text-text-muted focus:border-border-strong focus:outline-none"
                  />
                </form>
              ) : null}
            </div>

            {archivedOnly ? <ArchivedProjectsNotice archived={archivedOnly} /> : (
            <>
            <div className="grid grid-cols-3 gap-3 max-sm:grid-cols-1">
              <CountCard label="Projects" value={data.counts.projects} />
              <CountCard label="Decisions" value={data.counts.decisions} />
              <CountCard label="Shared entities" value={data.counts.shared_entities} />
            </div>

            {/* ONE SENTENCE, IN THE READER'S OWN NUMBERS, before any list. The
                three count tiles above are about our data model ("62 shared
                entities"); this is about their work. */}
            <p className="text-[15px] leading-7 text-text-secondary">
              {data.locked
                ? leadLine(data.counts)
                : portfolioLead(insights.length, stack.length, data.counts.projects)}
            </p>

            {data.entities.entries.length === 0 ? (
              <section>
                <div className="rounded-xl border border-border-subtle">
                  <p className="px-4 py-6 text-center text-sm text-text-muted">
                    {data.counts.projects <= 1
                      ? 'Add a second project and anything they share will appear here.'
                      : 'Nothing spans two projects yet.'}
                  </p>
                </div>
              </section>
            ) : data.locked ? (
              // Locked keeps ONE undifferentiated list on purpose. Splitting it
              // would advertise which group is the valuable one while withholding
              // exactly that group — a worse tease than the honest redaction.
              <section>
                <h2 className="mb-2 text-xs font-medium text-text-muted">
                  Appears in more than one project
                </h2>
                <div className="rounded-xl border border-border-subtle">
                  {data.entities.entries.map((row, index) => (
                    <LockedEntityRow key={index} row={row} index={index} />
                  ))}
                </div>
              </section>
            ) : (
              <>
                {/* INSIGHT LEADS. The old page sorted everything by project
                    count, which guaranteed the tool names won the top of the
                    screen and the judgements lost it. */}
                {insights.length > 0 && (
                  <section>
                    <h2 className="mb-2 text-xs font-medium text-text-muted">
                      What you&apos;ve decided and learned
                    </h2>
                    <div className="rounded-xl border border-border-subtle">
                      {insights.map((entity) => (
                        <InsightRow key={entity.node_id} entity={entity} />
                      ))}
                    </div>
                  </section>
                )}

                {stack.length > 0 && (
                  <section>
                    <h2 className="mb-2 text-xs font-medium text-text-muted">
                      Stack you reuse
                      <span className="ml-2 font-normal text-text-muted/80">
                        share of your {data.counts.projects} projects
                      </span>
                    </h2>
                    <StackChart stack={stack} totalProjects={data.counts.projects} />
                  </section>
                )}
              </>
            )}

            <section>
              <h2 className="mb-3 text-xs font-medium text-text-muted">Decisions across everything</h2>
              {data.decisions.entries.length === 0 ? (
                <p className="text-sm text-text-muted">No decisions recorded yet.</p>
              ) : data.locked ? (
                <LockedTimeline count={data.decisions.entries.length} />
              ) : (
                <DecisionTimeline decisions={decisions} />
              )}
            </section>

            {data.locked ? <UpgradePanel counts={data.counts} /> : null}
            </>
            )}
          </>
        ) : null}
      </div>
    </>
  );
}
