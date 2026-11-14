import Head from 'next/head';
import Link from 'next/link';
import { useState } from 'react';
import { Skeleton } from '@/components/ui/Skeleton';
import { ProjectSwitcher, persistProjectId } from '@/components/dashboard/brief/ProjectSwitcher';
import { TaskBoard } from '@/components/dashboard/brief/TaskBoard';
import { useProjectContext } from '@/components/dashboard/brief/useProjectContext';
import { RefusalNotice } from '@/components/dashboard/RefusalNotice';
import { ArchivedProjectsNotice } from '@/components/dashboard/ArchivedProjectsNotice';
import { isRefusedLoad } from '@/lib/loadFailure';

// Zero-project empty state for THIS page. The brief's sample (four slots) would
// be the wrong shape here — a board with no projects needs a board's answer.
function NoProjectsYet() {
  return (
    <div className="rounded-xl border border-primary/20 bg-primary/[0.04] p-5 max-sm:p-4">
      <h2 className="text-xl font-semibold tracking-[-0.02em] text-text-primary max-sm:text-lg">
        No board yet.
      </h2>
      <p className="mt-2 max-w-xl text-sm leading-6 text-text-secondary">
        Cards appear as your AI tracks work across sessions — backlog, blocked, in progress,
        integration, testing, done. Connect a tool and the board fills itself in.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <Link
          href="/onboarding"
          className="rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-on-primary no-underline hover:bg-primary/90"
        >
          Connect a tool
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

// The board, promoted out of the brief. Tracking work and reading a brief are
// different jobs on different rhythms — stacking them on one route made both
// worse, and six lanes never had the width they needed. Project scope is shared
// with the brief (same persisted selection), so switching pages keeps context.
export default function BoardPage() {
  const [refreshToken] = useState(0);
  const {
    projects,
    projectsError,
    projectsFailure,
    archived,
    selectedId,
    setSelectedId,
    context,
    contextLoading,
    contextError,
    loadContext,
  } = useProjectContext(refreshToken);
  // Refused (the workspace's subscription is inactive) is not "No board yet".
  const refused = isRefusedLoad(projectsFailure) ? projectsFailure : null;

  const body = (() => {
    if (refused) return <RefusalNotice failure={refused} />;
    if (projects === null) return <Skeleton variant="rectangular" height={320} />;
    if (projects.length === 0) {
      return archived.length > 0 ? <ArchivedProjectsNotice archived={archived} /> : <NoProjectsYet />;
    }
    if (!selectedId) {
      return <p className="py-12 text-center text-sm text-text-muted">Select a project to see its board.</p>;
    }
    if (contextLoading && !context) return <Skeleton variant="rectangular" height={320} />;
    if (contextError) {
      return (
        <div className="rounded-xl border border-border-subtle bg-overlay-subtle p-6 text-center">
          <p className="text-sm text-text-secondary">Couldn&apos;t load this project&apos;s board.</p>
          <button
            onClick={() => selectedId && loadContext(selectedId)}
            className="mt-3 rounded-md border border-border-subtle px-4 py-2 text-[13px] font-medium text-text-secondary hover:text-text-primary"
          >
            Retry
          </button>
        </div>
      );
    }
    return (
      <TaskBoard
        projectId={selectedId}
        context={context}
        onMutated={() => selectedId && loadContext(selectedId)}
      />
    );
  })();

  return (
    <>
      <Head><title>Board | DeerDawn</title></Head>

      <div className="flex min-h-0 flex-1 flex-col">
        {/* The h1 names the route in both branches. It replaces a two-line
            "The board / What's in flight" block that only rendered when the
            account had NO projects — so the page named itself exactly when
            there was nothing on it, and never otherwise. */}
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="dashboard-title">Board</h1>
          {projects && projects.length > 0 ? (
            <ProjectSwitcher
              projects={projects}
              selectedId={selectedId}
              onSelect={(id) => {
                setSelectedId(id);
                persistProjectId(id);
              }}
            />
          ) : null}
        </div>

        {projectsError && !refused && projects && projects.length === 0 ? (
          <p className="mb-3 text-xs text-status-warning">
            Couldn&apos;t reach your projects — showing a sample. Retry by reloading.
          </p>
        ) : null}

        {body}
      </div>
    </>
  );
}
