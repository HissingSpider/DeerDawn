import { useCallback, useEffect, useState } from 'react';
import { api, type ContextProjectSummary, type ProjectContextJson } from '@/lib/api';
import { logger } from '@/lib/logger';
import { isRefusedLoad, type LoadFailure } from '@/lib/loadFailure';
import type { ArchivedProjectLike } from '@/lib/archivedProjects';
import { loadFailureFrom } from '@/components/dashboard/RefusalNotice';
import { readPersistedProjectId } from './ProjectSwitcher';

// Project list + selection + the selected project's full context. Shared by the
// Brief (/) and the Board (/board), which are now separate destinations but read
// the same project scope and must agree on which project is selected.
export function useProjectContext(refreshToken: number) {
  const [projects, setProjects] = useState<ContextProjectSummary[] | null>(null);
  const [projectsError, setProjectsError] = useState(false);
  // WHY the list failed (lib/loadFailure). A workspace whose subscription is
  // inactive refuses it, and a refusal is not a dropped connection: the pages
  // say so instead of a sample brief under "Couldn't reach your projects".
  const [projectsFailure, setProjectsFailure] = useState<LoadFailure | null>(null);
  // Archived projects, read only when nothing is active: an idle project is
  // archived after 30 days, and "no projects" was the wrong answer for it.
  const [archived, setArchived] = useState<ArchivedProjectLike[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [context, setContext] = useState<ProjectContextJson | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState(false);

  // ── Load the project list ──────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setProjectsError(false);
    setProjectsFailure(null);
    api
      // Nested tree (umbrella → subprojects); fall back to the flat list if the
      // API predates /projects/tree, which still renders fine (roots only).
      .getContextProjectsTree()
      .catch(() => api.getContextProjects())
      .then(async (tree) => {
        if (cancelled) return;
        // Nothing active: is that because there is nothing, or because it is
        // archived? Asked before the empty state renders, so it never flashes.
        // A failed ask says what the page said before.
        const rows = tree.length === 0
          ? await api.getArchivedContextProjects().catch(() => [] as ArchivedProjectLike[])
          : [];
        if (cancelled) return;
        setArchived(rows);
        setProjects(tree);
        // Flatten roots + subprojects for selection membership and the default pick.
        const flat = tree.flatMap((p) => [p, ...(p.subprojects ?? [])]);
        // Restore last-viewed selection, else first project.
        setSelectedId((prev) => {
          if (prev && flat.some((p) => p.project_id === prev)) return prev;
          const persisted = readPersistedProjectId();
          if (persisted && flat.some((p) => p.project_id === persisted)) return persisted;
          return flat[0]?.project_id ?? null;
        });
      })
      .catch(async (err) => {
        if (cancelled) return;
        const failure = await loadFailureFrom(err);
        if (cancelled) return;
        // A refusal is the workspace's state, which the page explains; it is
        // not a fault to report.
        if (!isRefusedLoad(failure)) logger.error('brief_projects_failed', err);
        setProjectsFailure(failure);
        setProjects([]);
        setProjectsError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  // ── Load the selected project's FULL context (with provenance) ──────────────
  // Uses /inject?format=json — NOT getContextProjects, which strips provenance.
  const loadContext = useCallback((projectId: string) => {
    let cancelled = false;
    setContextLoading(true);
    setContextError(false);
    api
      .getProjectContextJson(projectId)
      .then((ctx) => {
        if (!cancelled) setContext(ctx);
      })
      .catch((err) => {
        if (cancelled) return;
        logger.error('brief_context_failed', err);
        setContextError(true);
        setContext(null);
      })
      .finally(() => {
        if (!cancelled) setContextLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setContext(null);
      return;
    }
    return loadContext(selectedId);
  }, [selectedId, loadContext, refreshToken]);

  return {
    projects,
    projectsError,
    projectsFailure,
    archived,
    selectedId,
    setSelectedId,
    context,
    setContext,
    contextLoading,
    contextError,
    loadContext,
  };
}
