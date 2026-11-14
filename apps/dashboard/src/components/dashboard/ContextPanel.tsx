import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import type { ContextGraphNode, ContextProjectSummary } from '@/lib/api';
import { SearchIcon, FileTextIcon } from '@/components/icons';
import { logger } from '@/lib/logger';

type TabId = 'search' | 'documents';

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: 'search', label: 'Search', icon: <SearchIcon /> },
  { id: 'documents', label: 'Documents', icon: <FileTextIcon /> },
];

export function ContextPanel() {
  const [active, setActive] = useState<TabId>('search');

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Icon tab header */}
      <div className="flex shrink-0 items-stretch border-b border-border-subtle px-6">
        {TABS.map((tab) => {
          const isActive = active === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActive(tab.id)}
              aria-label={tab.label}
              aria-selected={isActive}
              role="tab"
              className={`relative flex flex-1 items-center justify-center py-4 transition-colors ${
                isActive ? 'text-text-primary' : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              {tab.icon}
              {isActive && <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-primary" />}
            </button>
          );
        })}
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {active === 'search' && <SearchTab />}
        {active === 'documents' && <DocumentsTab />}
      </div>
    </div>
  );
}

/* ─── Search ──────────────────────────────────────────────────────────────── */

function SearchTab() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ContextGraphNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  // A failed search used to `setResults([])` and then setSearched(true), so a
  // 500 or a dropped connection rendered as "No matches for X" — the one answer
  // a search must never give wrongly, because it reads as a fact about your
  // context rather than a fact about the request.
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const term = query.trim();
    if (!term) {
      setResults([]);
      setSearched(false);
      setFailed(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const entities = await api.getWorkspaceEntities({ query: term, limit: 20 });
        if (!cancelled) {
          setResults(entities);
          setFailed(false);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          logger.error('context_search_failed', err);
          setResults([]);
          setFailed(true);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setSearched(true);
        }
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, attempt]);

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 px-6 pt-5">
        <div className="flex items-center gap-2.5 rounded-xl border border-border-subtle bg-overlay-subtle px-3.5 py-2.5 focus-within:border-primary/40">
          <span className="text-text-muted">
            <SearchIcon size={16} />
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your connected context…"
            className="w-full min-w-0 bg-transparent text-sm max-sm:text-base text-text-primary placeholder:text-text-muted focus:outline-none"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {!query.trim() ? (
          <div className="pt-10">
            <h2 className="text-2xl font-semibold leading-tight tracking-[-0.03em] text-text-primary">
              Search across your<br />connected context.
            </h2>
            <p className="mt-3 text-sm leading-6 text-text-secondary">
              Ask questions, find insights,<br />and explore your data.
            </p>
          </div>
        ) : loading ? (
          <SearchSkeleton />
        ) : failed ? (
          <div className="pt-6">
            <div className="text-sm font-semibold text-status-danger">Search didn&rsquo;t run</div>
            <p className="mt-1.5 max-w-sm text-sm leading-6 text-text-secondary">
              The request didn&rsquo;t come back, so this is not an answer about your context. Nothing was changed.
            </p>
            <button
              onClick={() => setAttempt((n) => n + 1)}
              className="mt-3 rounded-lg border border-border-strong px-3 py-1.5 text-[13px] font-medium text-text-secondary hover:text-text-primary"
            >
              Try again
            </button>
          </div>
        ) : results.length === 0 && searched ? (
          <div className="pt-6 text-sm text-text-muted">No matches for “{query.trim()}”.</div>
        ) : (
          <div className="space-y-2">
            {results.map((node) => (
              <SearchResultCard key={node.node_id} node={node} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Skeleton mirrors the result-card shape (title line, type pill, two body
// lines) so the loading state reads as "cards arriving", not generic blocks.
function SearchSkeleton() {
  return (
    <div className="space-y-2" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="rounded-xl border border-border-subtle bg-overlay-subtle px-3.5 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="h-3.5 w-1/2 animate-pulse rounded bg-overlay-active" />
            <div className="h-4 w-14 shrink-0 animate-pulse rounded-full bg-overlay-hover" />
          </div>
          <div className="mt-3 space-y-1.5">
            <div className="h-2.5 w-full animate-pulse rounded bg-overlay-hover" />
            <div className="h-2.5 w-3/4 animate-pulse rounded bg-overlay-hover" />
          </div>
        </div>
      ))}
    </div>
  );
}

// Result cards are collapsed by default — title, type, and a 2-line preview of
// the summary. Clicking expands to the full text. `break-words` +
// `[overflow-wrap:anywhere]` keep long unbroken tokens (hashes, keys, URLs)
// inside the card instead of bleeding past the edge.
function SearchResultCard({ node }: { node: ContextGraphNode }) {
  const [expanded, setExpanded] = useState(false);
  const hasSummary = Boolean(node.summary && node.summary.trim());

  return (
    <div className="overflow-hidden rounded-xl border border-border-subtle bg-overlay-subtle transition-colors hover:border-border-strong">
      <button
        type="button"
        onClick={() => hasSummary && setExpanded((v) => !v)}
        aria-expanded={hasSummary ? expanded : undefined}
        className={`flex w-full flex-col gap-1.5 px-3.5 py-3 text-left ${hasSummary ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 break-words text-sm font-medium text-text-primary [overflow-wrap:anywhere]">
            {node.title}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="rounded-full border border-border-subtle px-2 py-0.5 text-[10px] uppercase tracking-[0.1em] text-text-muted">
              {node.node_type}
            </span>
            {hasSummary && (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                className={`text-text-muted transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`}
                aria-hidden="true"
              >
                <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </div>
        </div>
        {hasSummary && (
          <p
            className={`break-words text-xs leading-5 text-text-secondary [overflow-wrap:anywhere] ${
              expanded ? 'whitespace-pre-wrap' : 'line-clamp-2'
            }`}
          >
            {node.summary}
          </p>
        )}
      </button>
    </div>
  );
}

/* ─── Documents ───────────────────────────────────────────────────────────── */

function DocumentsTab() {
  const [projects, setProjects] = useState<ContextProjectSummary[] | null>(null);
  // Same shape as the search tab: a failed load used to become an empty list,
  // so "No projects yet" was shown to accounts that have projects.
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    api
      .getContextProjects()
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          logger.error('context_projects_load_failed', err);
          setProjects([]);
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-primary">Your projects</h2>
        <Link href="/memory" className="text-xs text-primary no-underline hover:underline">
          Open graph →
        </Link>
      </div>

      {projects === null ? (
        <div className="mt-4 space-y-2.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl border border-border-subtle bg-overlay-subtle" />
          ))}
        </div>
      ) : failed ? (
        <div className="mt-6">
          <div className="text-sm font-semibold text-status-danger">Couldn&rsquo;t load your projects</div>
          <p className="mt-1.5 text-sm leading-6 text-text-secondary">
            This list is empty because the request failed, not because your workspace is.
          </p>
          <button
            onClick={() => setAttempt((n) => n + 1)}
            className="mt-3 rounded-lg border border-border-strong px-3 py-1.5 text-[13px] font-medium text-text-secondary hover:text-text-primary"
          >
            Try again
          </button>
        </div>
      ) : projects.length === 0 ? (
        <p className="mt-6 text-sm leading-6 text-text-muted">
          No projects yet. Import context to populate your workspace.
        </p>
      ) : (
        <div className="mt-4 space-y-2">
          {projects.map((p) => {
            const detail = p.context?.current_task || p.context?.description || p.context?.current_status || '';
            return (
              <div
                key={p.project_id}
                className="rounded-xl border border-border-subtle bg-overlay-subtle px-3.5 py-3"
              >
                <div className="text-sm font-medium text-text-primary">{p.project_name}</div>
                {detail ? <p className="mt-1 line-clamp-2 text-xs leading-5 text-text-secondary">{detail}</p> : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
