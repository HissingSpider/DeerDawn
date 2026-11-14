import Head from 'next/head';
import { useEffect, useMemo, useState } from 'react';
import { EmptyHero, InlineErrorState } from '@/components/dashboard/PageScaffold';
import { Button } from '@/components/ui/Button';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { SearchIcon } from '@/components/icons';
import {
  api,
  type ContextGraphResult,
  type ContextGraphNode,
  type ContextProjectSummary,
  type VaultHealthResult,
  type WorkspaceOverviewResult,
} from '@/lib/api';
import { AddFromClaudeModal } from '@/components/dashboard/AddFromClaudeModal';
import { DisclosureRow } from '@/components/dashboard/brief/DisclosureRow';
import { LibraryTab } from '@/components/dashboard/brief/LibraryTab';
import { useWeeklyActivity } from '@/components/dashboard/useWeeklyActivity';
import { RefusalNotice, loadFailureFrom } from '@/components/dashboard/RefusalNotice';
import { isRefusedLoad, type LoadFailure } from '@/lib/loadFailure';
import { ArchivedProjectsNotice } from '@/components/dashboard/ArchivedProjectsNotice';
import { useArchivedOnly } from '@/components/dashboard/useArchivedOnly';

const IMPORTANCE_OPTIONS = ['low', 'normal', 'high', 'critical'] as const;
const PAGE_SIZE = 12;

// Confidence is shown only when it is LOW enough to mean something.
// Every visible row read "97%" — a column of identical numbers encodes
// nothing, it just adds a second monospace value competing with the title for
// attention. Below this, the number is genuinely a caveat about the memory and
// earns its place; above it, silence says "fine" more clearly than 97% does.
const LOW_CONFIDENCE = 0.7;

// Drifted project names shown inline before collapsing to a count. Twelve of
// them wrapped to three lines and turned an actionable notice into a wall.
const DRIFT_NAMES_SHOWN = 4;

// Memory — what DeerDawn knows, and how to correct it.
//
// This replaces the Context Graph page, which opened with eleven numbers (four
// metric tiles plus seven vault-health pills) and a machine explainer before it
// reached the first thing anyone could act on. The node list is the page now:
// health is one line, the explainer is a disclosure, and search leads because
// browsing three thousand nodes was never going to work.
export default function MemoryPage() {
  const confirm = useConfirm();
  const weekly = useWeeklyActivity();

  const [projects, setProjects] = useState<ContextProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [graph, setGraph] = useState<ContextGraphResult | null>(null);
  const [overview, setOverview] = useState<WorkspaceOverviewResult | null>(null);
  const [vaultHealth, setVaultHealth] = useState<VaultHealthResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A refused load (the workspace's subscription is inactive) gets its reason
  // and, for an owner, the billing link: not the server's text beside a Retry
  // that is refused identically every time.
  const [refusal, setRefusal] = useState<LoadFailure | null>(null);
  // Nothing in memory because every project is archived: say that, not
  // "Nothing briefed yet" (useArchivedOnly).
  // With no active project there is no graph at all (null), so both count.
  const archivedOnly = useArchivedOnly(!loading && !refusal && (!graph || graph.nodes.length === 0));

  const [query, setQuery] = useState('');
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editSummary, setEditSummary] = useState('');
  const [busyNodeId, setBusyNodeId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [libraryToken, setLibraryToken] = useState(0);

  async function load(projectId?: string) {
    setError(null);
    const list = await api.getContextProjects();
    setProjects(list);
    const nextProjectId = projectId || selectedProjectId || list[0]?.project_id || '';
    setSelectedProjectId(nextProjectId);
    api.getVaultHealth().then(setVaultHealth).catch(() => setVaultHealth(null));

    if (!nextProjectId) {
      setGraph(null);
      setOverview(await api.getWorkspaceOverview({ mode: 'overview', verbosity: 'standard' }));
      return;
    }

    const [nextGraph, nextOverview] = await Promise.all([
      api.getContextProjectGraph(nextProjectId),
      api.getWorkspaceOverview({ mode: 'overview', verbosity: 'standard' }),
    ]);
    setGraph(nextGraph);
    setOverview(nextOverview);
  }

  // Refused, or did not come back? lib/loadFailure decides; the second keeps
  // the message this page always showed.
  async function fail(err: unknown, fallback: string) {
    const failure = await loadFailureFrom(err);
    if (isRefusedLoad(failure)) {
      setRefusal(failure);
      return;
    }
    setError(err instanceof Error ? err.message : fallback);
  }

  useEffect(() => {
    (async () => {
      try {
        await load();
      } catch (err) {
        await fail(err, 'Failed to load your memory');
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh(projectId?: string) {
    setRefreshing(true);
    try {
      await load(projectId);
    } catch (err) {
      await fail(err, 'Failed to refresh');
    } finally {
      setRefreshing(false);
    }
  }

  async function mutateNode(nodeId: string, fn: () => Promise<unknown>) {
    setActionError(null);
    setBusyNodeId(nodeId);
    try {
      await fn();
      await load(selectedProjectId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusyNodeId(null);
    }
  }

  function startEdit(node: ContextGraphNode) {
    setEditingNodeId(node.node_id);
    setEditTitle(node.title);
    setEditSummary(node.summary || '');
  }

  function cancelEdit() {
    setEditingNodeId(null);
    setEditTitle('');
    setEditSummary('');
  }

  async function saveEdit(node: ContextGraphNode) {
    await mutateNode(node.node_id, () =>
      api.updateGraphNode(node.node_id, { title: editTitle.trim(), summary: editSummary.trim() }),
    );
    cancelEdit();
  }

  const matches = useMemo(() => {
    const nodes = graph?.nodes ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return nodes;
    return nodes.filter((n) =>
      [n.title, n.summary, n.node_type, n.canonical_key]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(q)),
    );
  }, [graph, query]);

  useEffect(() => {
    setVisible(PAGE_SIZE);
  }, [query, selectedProjectId]);

  const runtimeLayers = overview
    ? [overview.layers.direct_context, overview.layers.passive_enrichment, overview.layers.intelligence]
    : [];
  const driftNames = weekly?.stale_project_names ?? [];
  const driftCount = weekly?.stale_projects ?? 0;

  if (loading) {
    return (
      <div className="space-y-2.5 py-6">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-xl border border-border-subtle bg-overlay-subtle" />
        ))}
      </div>
    );
  }

  if (refusal) {
    return <RefusalNotice failure={refusal} />;
  }

  if (error) {
    return <InlineErrorState title="Memory unavailable" description={error} onRetry={() => refresh()} />;
  }

  return (
    <>
      <Head><title>Memory | DeerDawn</title></Head>

      <div className="flex min-h-0 flex-1 flex-col gap-4">
        {/* Header — project scope and search. Search leads: with thousands of
            nodes, finding beats browsing, and this page previously had none. */}
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="dashboard-title">Memory</h1>

          {projects.length > 0 && (
            <select
              name="project-filter"
              aria-label="Filter by project"
              value={selectedProjectId}
              onChange={(event) => {
                setSelectedProjectId(event.target.value);
                void refresh(event.target.value);
              }}
              className="rounded-lg border border-border-subtle bg-overlay-subtle px-3 py-1.5 text-[13px] text-text-primary outline-none max-sm:text-base"
            >
              {projects.map((project) => (
                <option key={project.project_id} value={project.project_id} className="bg-surface">
                  {project.project_name}
                </option>
              ))}
            </select>
          )}

          <label className="ml-auto flex min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-border-subtle bg-surface px-3 py-1.5 sm:max-w-[320px] sm:flex-none">
            <span className="shrink-0 text-text-muted"><SearchIcon size={15} /></span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search what DeerDawn knows"
              aria-label="Search memory"
              className="w-full bg-transparent text-[13px] text-text-primary outline-none placeholder:text-text-muted max-sm:text-base"
            />
          </label>

          <Button size="sm" variant="secondary" onClick={() => refresh(selectedProjectId)} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>

        {/* One health line. Only the count with an action attached is tinted. */}
        {vaultHealth && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] text-text-secondary">
            <span className="font-semibold tabular-nums text-text-primary">
              {vaultHealth.total.toLocaleString()}
            </span>
            remembered
            <span aria-hidden className="opacity-40">·</span>
            <span className="font-semibold tabular-nums text-text-primary">
              {vaultHealth.durable.toLocaleString()}
            </span>
            durable
            {vaultHealth.stale_unused > 0 && (
              <>
                <span aria-hidden className="opacity-40">·</span>
                <span className="font-semibold tabular-nums text-status-warning">
                  {vaultHealth.stale_unused.toLocaleString()} stale
                </span>
              </>
            )}
            <span
              title={`Resolved and archived entries are excluded from briefs, duplicates collapse, and never-used stale nodes are archived nightly. ${vaultHealth.pinned} pinned, ${vaultHealth.candidates} candidate, ${vaultHealth.resolved_or_archived} resolved or archived. Average confidence ${Math.round(vaultHealth.avg_confidence * 100)}%.`}
              className="ml-1 inline-flex h-[18px] w-[18px] cursor-help items-center justify-center rounded-full border border-border-strong text-[10px] font-bold text-text-muted"
            >
              ?
            </span>
            <span className="ml-auto text-[12px] text-text-muted">Archived nightly</span>
          </div>
        )}

        {/* Drifting projects — what the Memory nav badge points at. Named, so the
            count is actionable rather than an ambient warning. */}
        {driftCount > 0 && (
          <div className="rounded-xl border border-status-warning/25 bg-[var(--status-escalate-bg)] px-4 py-3">
            <p className="text-[13px] text-text-secondary">
              <span className="font-semibold text-status-warning">{driftCount}</span>{' '}
              {driftCount === 1 ? 'project has' : 'projects have'} drifted from your latest work. Open{' '}
              {driftCount === 1 ? 'it' : 'them'} in your AI tool and DeerDawn refreshes automatically.
            </p>
            {driftNames.length > 0 && (
              <p className="mt-1 text-[12px] text-text-muted">
                {driftNames.slice(0, DRIFT_NAMES_SHOWN).join(', ')}
                {driftCount > DRIFT_NAMES_SHOWN
                  ? `, +${driftCount - DRIFT_NAMES_SHOWN} more`
                  : ''}
              </p>
            )}
          </div>
        )}

        {actionError && (
          <div className="rounded-xl border border-status-danger/30 bg-[var(--status-deny-bg)] px-3 py-2 text-sm text-status-danger">
            {actionError}
          </div>
        )}

        {(!graph || graph.nodes.length === 0) && archivedOnly ? (
          <ArchivedProjectsNotice archived={archivedOnly} />
        ) : !graph || graph.nodes.length === 0 ? (
          <EmptyHero
            icon={
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 6.75A2.25 2.25 0 106.75 9 2.25 2.25 0 009 6.75zm0 0h6m-6 0v10.5m6-10.5A2.25 2.25 0 1017.25 9 2.25 2.25 0 0015 6.75zm0 0v10.5m0 0A2.25 2.25 0 1017.25 15 2.25 2.25 0 0015 17.25zm0 0H9m0 0A2.25 2.25 0 106.75 15 2.25 2.25 0 009 17.25" />
              </svg>
            }
            title="Nothing briefed yet"
            description="Once you start working in Claude or ChatGPT, DeerDawn builds a map of your projects, current tasks, and recent decisions. It shows up here."
            primaryAction={<Button onClick={() => setAddOpen(true)}>Import from a conversation</Button>}
          />
        ) : (
          <>
            {/* The list is the page. Hairline rows, no card per item. */}
            <div className="flex flex-col">
              {matches.slice(0, visible).map((node) => {
                const pinned = Boolean((node.metadata as { pinned?: boolean })?.pinned);
                const importance = String((node.metadata as { importance?: string })?.importance || 'normal');
                const busy = busyNodeId === node.node_id;
                const isEditing = editingNodeId === node.node_id;

                return (
                  <div
                    key={node.node_id}
                    className="group border-t border-border-subtle py-3 last:border-b"
                  >
                    {isEditing ? (
                      <div className="space-y-2">
                        <input
                          value={editTitle}
                          onChange={(event) => setEditTitle(event.target.value)}
                          placeholder="Title"
                          aria-label="Title"
                          className="w-full rounded-lg border border-border-subtle bg-overlay-subtle px-3 py-2 text-sm text-text-primary outline-none max-sm:text-base"
                        />
                        <textarea
                          value={editSummary}
                          onChange={(event) => setEditSummary(event.target.value)}
                          rows={3}
                          placeholder="Summary"
                          aria-label="Summary"
                          className="w-full rounded-lg border border-border-subtle bg-overlay-subtle px-3 py-2 text-sm text-text-primary outline-none max-sm:text-base"
                        />
                        <div className="flex gap-2">
                          <Button size="sm" onClick={() => void saveEdit(node)} disabled={busy || !editTitle.trim()}>
                            {busy ? 'Saving…' : 'Save'}
                          </Button>
                          <Button size="sm" variant="secondary" onClick={cancelEdit} disabled={busy}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
                        <div className="min-w-[16rem] flex-1">
                          <div className="flex items-center gap-2">
                            {pinned && (
                              <span title="Pinned" aria-label="Pinned" className="shrink-0 text-primary">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                  <path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.3 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z" />
                                </svg>
                              </span>
                            )}
                            <span className="break-words text-[13.5px] font-semibold text-text-primary [overflow-wrap:anywhere]">
                              {node.title}
                            </span>
                          </div>
                          {(node.summary || node.canonical_key) && (
                            <p className="mt-0.5 break-words text-[12.5px] leading-snug text-text-muted [overflow-wrap:anywhere]">
                              {node.summary || node.canonical_key}
                            </p>
                          )}
                        </div>

                        <span className="w-24 shrink-0 font-mono text-[11.5px] text-text-muted">{node.node_type}</span>
                        {/* Only when it is low enough to be a caveat — see
                            LOW_CONFIDENCE. The column keeps its width either way
                            so rows stay aligned down the page. */}
                        <span
                          className="w-12 shrink-0 font-mono text-[11.5px] tabular-nums text-text-muted"
                          title={`DeerDawn's confidence in this memory: ${Math.round((node.confidence || 0) * 100)}%`}
                        >
                          {(node.confidence ?? 1) < LOW_CONFIDENCE
                            ? `${Math.round((node.confidence || 0) * 100)}%`
                            : ''}
                        </span>

                        {/* FOUR CONTROLS PER ROW, TWELVE ROWS: forty-eight
                            interactive elements, including a bordered <select>
                            and a red Delete on every line, all competing with
                            the content they act on. Revealed on hover and on
                            keyboard focus instead — nothing is removed, and the
                            same pattern already governs the brief's lines. Kept
                            permanently visible below `sm`, where there is no
                            hover to reveal them with. */}
                        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 max-sm:opacity-100">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void mutateNode(node.node_id, () => api.updateGraphNode(node.node_id, { pinned: !pinned }))}
                            disabled={busy}
                          >
                            {pinned ? 'Unpin' : 'Pin'}
                          </Button>
                          <select
                            value={importance}
                            onChange={(event) =>
                              void mutateNode(node.node_id, () =>
                                api.updateGraphNode(node.node_id, {
                                  importance: event.target.value as (typeof IMPORTANCE_OPTIONS)[number],
                                }),
                              )
                            }
                            disabled={busy}
                            aria-label="Importance"
                            className="rounded-md border border-border-subtle bg-transparent px-2 py-1 text-[11.5px] text-text-secondary outline-none disabled:opacity-50 max-sm:text-base"
                          >
                            {IMPORTANCE_OPTIONS.map((option) => (
                              <option key={option} value={option} className="bg-surface">
                                {option}
                              </option>
                            ))}
                          </select>
                          <Button size="sm" variant="ghost" onClick={() => startEdit(node)} disabled={busy}>
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={async () => {
                              if (
                                await confirm({
                                  title: 'Delete this memory?',
                                  body: 'DeerDawn will stop including it in your briefs. This cannot be undone.',
                                  confirmLabel: 'Delete',
                                  destructive: true,
                                })
                              ) {
                                void mutateNode(node.node_id, () => api.deleteGraphNode(node.node_id));
                              }
                            }}
                            disabled={busy}
                          >
                            Delete
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {matches.length === 0 && (
                <p className="border-t border-border-subtle py-8 text-center text-sm text-text-muted">
                  Nothing matches “{query}”.
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {visible < matches.length && (
                <Button size="sm" variant="secondary" onClick={() => setVisible((v) => v + PAGE_SIZE)}>
                  Load {Math.min(PAGE_SIZE, matches.length - visible)} more
                </Button>
              )}
              <span className="font-mono text-[11.5px] text-text-muted">
                {query
                  ? `${matches.length} of ${graph.nodes.length} in this project`
                  : `${graph.nodes.length} in this project`}
              </span>
            </div>
          </>
        )}

        {/* Everything that explains the machine rather than showing your data.
            Nothing was deleted — it stopped being the first thing on the page. */}
        <div className="mt-2 flex flex-col">
          {graph && graph.summary_lines.length > 0 && (
            <DisclosureRow label="What DeerDawn knows about this project" meta={`${graph.summary_lines.length} lines`}>
              <ul className="space-y-1.5">
                {graph.summary_lines.map((line) => (
                  <li key={line} className="text-[13px] leading-6 text-text-secondary">{line}</li>
                ))}
              </ul>
            </DisclosureRow>
          )}

          {runtimeLayers.length > 0 && (
            <DisclosureRow label="How DeerDawn decides what survives" meta="direct, passive and intelligence layers">
              <div className="grid gap-3 lg:grid-cols-3">
                {runtimeLayers.map((layer) => (
                  <div key={layer.id} className="rounded-xl border border-border-subtle bg-overlay-subtle p-4">
                    <div className="text-[13px] font-semibold text-text-primary">{layer.title}</div>
                    <p className="mt-2 text-[12.5px] leading-6 text-text-secondary">{layer.summary}</p>
                    <p className="mt-3 font-mono text-[11.5px] text-text-muted">
                      {layer.input_count} in · {layer.selected_count} selected · {layer.status}
                    </p>
                  </div>
                ))}
              </div>
            </DisclosureRow>
          )}

          {graph && graph.evidence.length > 0 && (
            <DisclosureRow label="Evidence" meta={`${graph.evidence.length} ${graph.evidence.length === 1 ? 'source' : 'sources'}`}>
              <div className="space-y-2">
                {graph.evidence.slice(0, 8).map((item) => (
                  <div key={item.evidence_id} className="rounded-xl border border-border-subtle bg-overlay-subtle p-3">
                    <div className="flex items-center justify-between gap-3 font-mono text-[11px] text-text-muted">
                      <span>{item.tool}</span>
                      <span>{new Date(item.created_at).toLocaleString()}</span>
                    </div>
                    <p className="mt-2 text-[12.5px] leading-6 text-text-secondary">{item.excerpt}</p>
                  </div>
                ))}
              </div>
            </DisclosureRow>
          )}

          <DisclosureRow label="Browse the full context tree" meta="files, documents and search across the workspace">
            <LibraryTab onAddFromClaude={() => setAddOpen(true)} refreshToken={libraryToken} />
          </DisclosureRow>
        </div>
      </div>

      {addOpen && (
        <AddFromClaudeModal
          onClose={() => setAddOpen(false)}
          onDone={() => {
            setLibraryToken((t) => t + 1);
            void refresh(selectedProjectId);
          }}
        />
      )}
    </>
  );
}
