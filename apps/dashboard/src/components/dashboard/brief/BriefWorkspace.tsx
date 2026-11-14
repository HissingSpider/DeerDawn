import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import {
  api,
  apiErrorReason,
  deriveBriefSpine,
  buildTaskBoard,
  type BriefItem,
  type BriefSlotKind,
  type ProjectContextJson,
} from '@/lib/api';
import { showToast } from '@/components/ui/Toast';
import { Skeleton } from '@/components/ui/Skeleton';
import { logger } from '@/lib/logger';
import { writeRefusalMessage } from '@/lib/writeRefusal';
import { isRefusedLoad } from '@/lib/loadFailure';
import { RefusalNotice } from '@/components/dashboard/RefusalNotice';
import { ArchivedProjectsNotice } from '@/components/dashboard/ArchivedProjectsNotice';
import { AuthorNotices } from '@/components/dashboard/AuthorNotices';
import {
  BLOCKER_CHANGED_MESSAGE,
  BRIEF_BUSY_MESSAGE,
  BRIEF_SAVED_MESSAGE,
  LINE_CHANGED_MESSAGE,
  applyChangeToContext,
  briefLineKeys,
  isStaleVersionError,
  lineIdentity,
  refusedEditFor,
  saveLineChange,
  writeFromFreshRead,
  type EditableSlot,
  type FreshWriteIO,
  type LineChange,
  type RefusedEdit,
  type RefusedEditReason,
} from '@/lib/briefEdits';
import { BriefView } from './BriefView';
import { BriefFreshness } from './BriefFreshness';
import { ProjectSwitcher, persistProjectId } from './ProjectSwitcher';
import { ProjectManager } from './ProjectManager';
import { SampleBriefEmptyState } from './SampleBriefEmptyState';
import { HistoryTrimNotice } from './HistoryTrimNotice';
import { useProjectContext } from './useProjectContext';
import type { BriefLineCallbacks } from './BriefLine';

// The open tab re-reads the brief when it is looked at again (window focus, or
// the tab becoming visible), never more often than this. No polling: a tab
// nobody is looking at costs nothing.
const REFETCH_MIN_INTERVAL_MS = 5_000;

interface BriefWorkspaceProps {
  // Bumped externally (e.g. after AddFromClaude import) to force a re-fetch.
  refreshToken: number;
}

export function BriefWorkspace({ refreshToken }: BriefWorkspaceProps) {
  // Bumped by the project manager so a create/rename/archive/delete re-reads the
  // tree without the page having to own that state.
  const [localRefresh, setLocalRefresh] = useState(0);
  const [managerOpen, setManagerOpen] = useState(false);
  const {
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
  } = useProjectContext(refreshToken + localRefresh);
  // The workspace refused the list (its subscription is inactive): say so,
  // instead of a sample brief under "Couldn't reach your projects".
  const refused = isRefusedLoad(projectsFailure) ? projectsFailure : null;

  // "Restore a project" (ArchivedProjectsNotice, on Today, the Board and here)
  // links to /projects?manage=archived: open the manager, where the archived
  // list and Restore live, once, and drop the parameter so a reload does not.
  const router = useRouter();
  useEffect(() => {
    if (!router.isReady || router.query.manage !== 'archived') return;
    setManagerOpen(true);
    void router.replace(router.pathname, undefined, { shallow: true });
  }, [router, router.isReady, router.query.manage]);

  // Optimistic override: a draft context applied locally before the PATCH lands.
  // Cleared (and replaced by the authoritative re-fetch) on success; rolled back
  // on error. `busyKey` dims the one line currently mid-mutation.
  const [override, setOverride] = useState<ProjectContextJson | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Read by callbacks that outlive a render: the project on screen NOW (a reply
  // for a project the person has switched away from must not be shown), and
  // whether a write is in flight (a focus refetch must not land mid-write and
  // wipe its optimistic draft).
  const selectedIdRef = useRef<string | null>(selectedId);
  const writingRef = useRef(false);
  const lastReadAtRef = useRef(0);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  // Whenever authoritative context arrives (initial load, project switch, the
  // re-fetch after a write, or a focus refetch), the optimistic draft is
  // superseded — and the brief on screen is as fresh as it gets.
  useEffect(() => {
    setOverride(null);
    if (context) lastReadAtRef.current = Date.now();
  }, [context]);

  const effectiveContext = override ?? context;
  const spine = useMemo(() => deriveBriefSpine(effectiveContext), [effectiveContext]);

  // Show a brief this component already read, if the person is still on it.
  const showFresh = useCallback((projectId: string, fresh: ProjectContextJson) => {
    if (selectedIdRef.current === projectId) setContext(fresh);
  }, [setContext]);

  // ── The open tab notices change ─────────────────────────────────────────────
  // The page used to load the brief once and never again: 90 seconds watched,
  // no read, and focus or visibility changed nothing — so a tab left open since
  // the morning held the morning's lists, and every click wrote them back. Now
  // coming back to the tab re-reads it (throttled; skipped while a write is in
  // flight). A failed background read leaves what is on screen alone.
  useEffect(() => {
    if (!selectedId) return;
    const projectId = selectedId;
    const refetch = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (writingRef.current) return;
      if (Date.now() - lastReadAtRef.current < REFETCH_MIN_INTERVAL_MS) return;
      lastReadAtRef.current = Date.now();
      api
        .getProjectContextJson(projectId)
        .then((fresh) => {
          if (!writingRef.current) showFresh(projectId, fresh);
        })
        .catch((err) => logger.warn('brief_focus_refetch_failed', { error: String(err) }));
    };
    window.addEventListener('focus', refetch);
    document.addEventListener('visibilitychange', refetch);
    return () => {
      window.removeEventListener('focus', refetch);
      document.removeEventListener('visibilitychange', refetch);
    };
  }, [selectedId, showFresh]);

  // Reads and writes for one project. Every write carries the version of the
  // read it was built from, so the API refuses it if the brief moved on since.
  const ioFor = useCallback((projectId: string): FreshWriteIO => ({
    read: () => api.getProjectContextJson(projectId),
    write: (patch, expectedVersion) =>
      api.updateProjectContext(projectId, patch as never, { expectedContextVersion: expectedVersion }),
  }), []);

  // ── Per-line mutations — ONE line changes, everything else is kept ─────────
  // There is still no per-item endpoint, so a change PATCHes the whole list. It
  // used to build that list from the context this tab loaded, which wrote back
  // whatever the tab held over anything saved since (the person's own AI tool's
  // decision, a teammate's edit), answered "Brief updated." (journey r3, S3-1).
  // saveLineChange reads the project fresh, finds the clicked line by identity
  // (text + stamp, never index), changes only it, and writes with the version it
  // read; a stale refusal is re-read and re-applied at most twice. If the line
  // is not there any more as the person saw it, nothing is written and the
  // brief shows what IS saved.
  //
  // An EDIT refused because the brief changed underneath it (the line is not as
  // the person saw it, or every attempt met a newer brief) keeps what they
  // typed: it is held here, and shown in place of the line as it now reads, or
  // on its own when the line is gone, until they save it again or discard it.
  // The editor used to close and the text was lost.
  const [refusedEdits, setRefusedEdits] = useState<RefusedEdit[]>([]);
  const keepRefusedEdit = useCallback(
    (
      projectId: string,
      slot: EditableSlot,
      seen: RefusedEdit['seen'],
      draft: string,
      mode: RefusedEdit['mode'],
      reason: RefusedEditReason,
      replaces?: string,
    ) => {
      setRefusedEdits((prev) => [
        ...prev.filter((edit) => edit.id !== replaces),
        refusedEditFor({ projectId, slot, seen, draft, mode, reason }),
      ]);
    },
    [],
  );
  const dropRefusedEdit = useCallback((id: string) => {
    setRefusedEdits((prev) => prev.filter((edit) => edit.id !== id));
  }, []);

  const mutateLine = useCallback(
    async (
      slot: EditableSlot,
      item: BriefItem,
      change: LineChange,
      opts: { mode?: RefusedEdit['mode']; refusalId?: string } = {},
    ): Promise<void> => {
      if (!selectedId || !context) return;
      const projectId = selectedId;
      const id = lineIdentity(slot, item);
      const slotItems = spine[slot];
      const at = slotItems.indexOf(item);
      setBusyKey(at >= 0 ? briefLineKeys(slot, slotItems)[at] : briefLineKeys(slot, [item])[0]);
      writingRef.current = true;
      const keep = (reason: RefusedEditReason) => {
        if (change.kind !== 'edit') return;
        keepRefusedEdit(projectId, slot, id, change.text, opts.mode ?? 'edit', reason, opts.refusalId);
      };

      // The optimistic draft, applied by the same identity rule.
      const draft = applyChangeToContext(effectiveContext ?? context, slot, id, change);
      if (draft.found) setOverride(draft.context);

      try {
        const result = await saveLineChange(ioFor(projectId), slot, id, change);
        if (result.outcome === 'gone') {
          // Nothing was written. Never "Brief updated." for a write that did
          // not happen: say so, and show the brief as it is now.
          showToast(LINE_CHANGED_MESSAGE, 'warning');
          setOverride(null);
          keep('changed');
          showFresh(projectId, result.context);
          return;
        }
        if (opts.refusalId) dropRefusedEdit(opts.refusalId);
        showToast(BRIEF_SAVED_MESSAGE, 'success');
        // Re-fetch the authoritative context (also clears the override).
        loadContext(projectId);
      } catch (err) {
        logger.error('brief_mutation_failed', err);
        setOverride(null); // rollback to the last authoritative context
        if (isStaleVersionError(err)) {
          showToast(BRIEF_BUSY_MESSAGE, 'error');
          keep('busy');
          loadContext(projectId);
          return;
        }
        showToast(writeRefusalMessage(err) || 'Couldn’t save that change — rolled back.', 'error');
        // Archived since this tab loaded: the page shows the current state, so
        // the project list is read again (the project leaves it, and with
        // nothing active left the archived notice takes its place).
        if (apiErrorReason(err) === 'project_archived') setLocalRefresh((n) => n + 1);
      } finally {
        writingRef.current = false;
        setBusyKey(null);
      }
    },
    [selectedId, context, effectiveContext, spine, ioFor, loadContext, showFresh, keepRefusedEdit, dropRefusedEdit],
  );

  // Save again from a kept editor: the same versioned write, against the line
  // as it reads NOW (the words the person was just shown beside their text).
  const saveRefusedEdit = useCallback(
    (edit: RefusedEdit, now: BriefItem, text: string) =>
      mutateLine(edit.slot, now, { kind: 'edit', text }, { mode: edit.mode, refusalId: edit.id }),
    [mutateLine],
  );
  // Kept text belongs to the project it was typed in.
  const shownRefusedEdits = useMemo(
    () => refusedEdits.filter((edit) => edit.projectId === selectedId),
    [refusedEdits, selectedId],
  );

  // ── Clear the blocking issue — scalar PATCH, not an array mutation ──────────
  // The banner runs its own undo window locally, so by the time this fires the
  // user has committed. Optimistically drop the field, then persist + re-fetch.
  // The same blocker often lives twice — as blocking_issue AND as a card in the
  // board's Blocked lane — so completing it clears BOTH: we match the Blocked
  // cards client-side (id, not fuzzy title, to avoid touching a same-named card
  // in another lane) and complete_todos them to Done in the same PATCH.
  //
  // Same rule as a line: it clears the blocker the person SAW, against a fresh
  // read. Clearing from the loaded copy erased a blocker a tool had set since.
  const completeBlocking = useCallback(async () => {
    if (!selectedId || !context) return;
    const projectId = selectedId;
    const base = effectiveContext ?? context;
    const seen = base.blocking_issue?.trim() ?? '';

    // Optimistic: clear the banner + move any matched Blocked cards to Done so
    // the board reflects it instantly too.
    const now = new Date().toISOString();
    const optimisticIds = blockedCardIdsMatching(base, seen);
    const optimisticTodos = optimisticIds.length
      ? (base.todo_items ?? []).map((t) =>
          optimisticIds.includes(t.id)
            ? { ...t, phase: 'done', updated_at: now, completed_at: t.completed_at ?? now }
            : t,
        )
      : base.todo_items;
    setOverride({ ...base, blocking_issue: '', todo_items: optimisticTodos });
    writingRef.current = true;

    let completedCards = 0;
    try {
      const result = await writeFromFreshRead(ioFor(projectId), (fresh) => {
        const stored = fresh.blocking_issue?.trim() ?? '';
        if (!seen || stored.replace(/\s+/g, ' ') !== seen.replace(/\s+/g, ' ')) return null;
        const matchIds = blockedCardIdsMatching(fresh, seen);
        completedCards = matchIds.length;
        const patch: Record<string, unknown> = { blocking_issue: '' };
        if (matchIds.length) patch.complete_todos = matchIds;
        return patch;
      });
      if (result.outcome === 'gone') {
        showToast(BLOCKER_CHANGED_MESSAGE, 'warning');
        setOverride(null);
        showFresh(projectId, result.context);
        return;
      }
      showToast(
        completedCards ? 'Blocker cleared — and completed on the board.' : 'Blocker cleared.',
        'success',
      );
      loadContext(projectId);
    } catch (err) {
      logger.error('brief_blocking_complete_failed', err);
      setOverride(null); // restore the banner (+ board card)
      if (isStaleVersionError(err)) {
        showToast(BRIEF_BUSY_MESSAGE, 'error');
        loadContext(projectId);
        return;
      }
      showToast(writeRefusalMessage(err) || 'Couldn’t clear that blocker — rolled back.', 'error');
    } finally {
      writingRef.current = false;
    }
  }, [selectedId, context, effectiveContext, ioFor, loadContext, showFresh]);

  // ── Answer an open question — resolve it via the dedicated endpoint ──────────
  // Distinct from the array-PATCH mutations: POST /questions/resolve removes the
  // question from OPEN and records the answer as a Decided entry server-side, by
  // the question's text against the stored list — so it never writes back a
  // stale copy. We mirror that optimistically (drop from open_questions +
  // append a decision) so the answer jumps straight to the DECIDED slot before
  // the re-fetch lands.
  const answerQuestion = useCallback(
    async (item: BriefItem, answer: string) => {
      if (!selectedId || !context) return;
      const at = spine.open.indexOf(item);
      setBusyKey(at >= 0 ? briefLineKeys('open', spine.open)[at] : briefLineKeys('open', [item])[0]);
      writingRef.current = true;

      const base = effectiveContext ?? context;
      const now = new Date().toISOString();
      const nextQuestions = (base.open_questions ?? []).filter((q) => q !== item.text);
      const nextDecisions = [
        ...(base.recent_decisions ?? []),
        { summary: `Decided: ${answer}`, reasoning: item.text, decided_at: now, importance: 'normal' as const },
      ];
      setOverride({ ...base, open_questions: nextQuestions, recent_decisions: nextDecisions });

      try {
        await api.resolveQuestion(selectedId, item.text, answer);
        showToast('Answered — moved to Decided.', 'success');
        loadContext(selectedId);
      } catch (err) {
        logger.error('brief_answer_failed', err);
        showToast(writeRefusalMessage(err) || 'Couldn’t save that answer — rolled back.', 'error');
        setOverride(null); // rollback to the last authoritative context
      } finally {
        writingRef.current = false;
        setBusyKey(null);
      }
    },
    [selectedId, context, effectiveContext, spine, loadContext],
  );

  const callbacks: BriefLineCallbacks = useMemo(() => {
    // The line says which slot it is in; an editor holds the line as it was
    // when it opened, which may no longer be an object in the current spine.
    const slotOf = (item: BriefItem, slot?: BriefSlotKind): EditableSlot =>
      slot === 'decided' || slot === 'open' || slot === 'landmine' ? slot : currentSlotOf(item, spine);
    return {
      onEdit: (item, next, slot) => mutateLine(slotOf(item, slot), item, { kind: 'edit', text: next }),
      onCorrect: (item, next, slot) => mutateLine(slotOf(item, slot), item, { kind: 'edit', text: next }, { mode: 'correct' }),
      onDismiss: (item, slot) => mutateLine(slotOf(item, slot), item, { kind: 'dismiss' }),
      onPin: (item, slot) => mutateLine(slotOf(item, slot), item, { kind: 'pin' }),
      onAnswer: (item, answer) => answerQuestion(item, answer),
    };
  }, [mutateLine, spine, answerQuestion]);

  // ── Render ──────────────────────────────────────────────────────────────────
  const briefTab = (() => {
    if (refused) return <RefusalNotice failure={refused} />;
    if (projects === null) {
      return (
        <div className="space-y-4">
          <Skeleton variant="rectangular" height={120} />
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Skeleton variant="rectangular" height={160} />
            <Skeleton variant="rectangular" height={160} />
          </div>
        </div>
      );
    }
    if (projects.length === 0) {
      if (archived.length > 0) return <ArchivedProjectsNotice archived={archived} />;
      return <SampleBriefEmptyState />;
    }
    if (!selectedId) {
      return <p className="py-12 text-center text-sm text-text-muted">Select a project to see its brief.</p>;
    }
    if (contextLoading && !context) {
      return (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} variant="rectangular" height={150} />
          ))}
        </div>
      );
    }
    if (contextError) {
      return (
        <div className="rounded-xl border border-border-subtle bg-overlay-subtle p-6 text-center">
          <p className="text-sm text-text-secondary">Couldn&apos;t load this project&apos;s brief.</p>
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
      <BriefView
        projectId={selectedId}
        spine={spine}
        context={effectiveContext}
        callbacks={callbacks}
        busyKey={busyKey}
        onCompleteBlocking={completeBlocking}
        refused={shownRefusedEdits}
        onRefusedSave={saveRefusedEdit}
        onRefusedDiscard={(edit) => dropRefusedEdit(edit.id)}
      />
    );
  })();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AuthorNotices />
      {/* One header row: the route's name, which project, and is it current. The
          board moved to its own destination (/board) and the Library tab to
          /memory, so the brief is the whole page.

          This component is /projects' only renderer, so the page's <h1> lives
          here with the row it belongs to. It replaces a two-line "The brief /
          Never start cold" block that appeared only when the account had NO
          projects — the page named itself exactly when it was empty. */}
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="dashboard-title">Projects</h1>
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
        {projects && !refused ? (
          <button
            type="button"
            onClick={() => setManagerOpen(true)}
            className="rounded-lg border border-border-subtle px-3 py-2 text-xs font-medium text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary"
          >
            Manage projects
          </button>
        ) : null}
        <BriefFreshness />
      </div>

      <ProjectManager
        open={managerOpen}
        onClose={() => setManagerOpen(false)}
        projects={projects ?? []}
        onChanged={(focusProjectId) => {
          if (focusProjectId) {
            setSelectedId(focusProjectId);
            persistProjectId(focusProjectId);
          }
          setLocalRefresh((n) => n + 1);
        }}
      />

      {projectsError && !refused && projects && projects.length === 0 ? (
        <p className="mb-3 text-xs text-status-warning">
          Couldn&apos;t reach your projects — showing a sample brief. Retry by reloading.
        </p>
      ) : null}

      {/* Reads the AUTHORITATIVE context, not the optimistic override: an
          in-flight edit must not change what we claim the plan trimmed. */}
      <HistoryTrimNotice context={context} />

      {briefTab}
    </div>
  );
}

// The Blocked-lane cards that name this blocker, by id (not fuzzy title, to
// avoid touching a same-named card in another lane). Steps are read-only
// projections of the task, never completed from here.
function blockedCardIdsMatching(context: ProjectContextJson, blocker: string): string[] {
  if (!blocker) return [];
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const b = norm(blocker);
  const blockedCards = buildTaskBoard(context).find((c) => c.phase === 'blocked')?.cards ?? [];
  return blockedCards
    .filter((card) => card.kind !== 'step')
    .filter((card) => {
      const a = norm(card.title);
      return a === b || a.includes(b) || b.includes(a);
    })
    .map((card) => card.id);
}

// Resolve which slot an item currently belongs to (by identity in the spine).
// Decided/open/landmine are the only editable slots; default to 'decided'.
function currentSlotOf(item: BriefItem, spine: { decided: BriefItem[]; open: BriefItem[]; landmine: BriefItem[] }): EditableSlot {
  if (spine.open.includes(item)) return 'open';
  if (spine.landmine.includes(item)) return 'landmine';
  return 'decided';
}
