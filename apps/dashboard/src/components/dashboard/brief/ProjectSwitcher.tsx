import { useEffect, useRef, useState } from 'react';
import type { ContextProjectSummary } from '@/lib/api';
import { ChevronDownIcon } from '@/components/icons';

const SELECTION_KEY = 'dd_brief_selected_project';

interface ProjectSwitcherProps {
  projects: ContextProjectSummary[];
  selectedId: string | null;
  onSelect: (projectId: string) => void;
}

// Persist the last-viewed project so the brief reopens where the user left off.
export function readPersistedProjectId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(SELECTION_KEY);
  } catch {
    return null;
  }
}

export function persistProjectId(projectId: string) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SELECTION_KEY, projectId);
  } catch {
    /* storage may be unavailable */
  }
}

// Flatten the project tree into ordered rows so a subproject renders indented
// directly under its umbrella. Roots at depth 0, subprojects at depth 1 (the
// hierarchy is one level deep).
interface ProjectRow {
  project: ContextProjectSummary;
  depth: number;
}
function flattenProjectTree(projects: ContextProjectSummary[]): ProjectRow[] {
  const rows: ProjectRow[] = [];
  for (const root of projects) {
    rows.push({ project: root, depth: 0 });
    for (const sub of root.subprojects ?? []) {
      rows.push({ project: sub, depth: 1 });
    }
  }
  return rows;
}

export function ProjectSwitcher({ projects, selectedId, onSelect }: ProjectSwitcherProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const rows = flattenProjectTree(projects);
  const selected = rows.find((r) => r.project.project_id === selectedId)?.project || null;

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (rows.length === 0) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex max-w-full items-center gap-2 rounded-xl border border-border-subtle bg-overlay-subtle px-3.5 py-2 text-left transition-colors hover:border-border-strong"
      >
        <span className="min-w-0">
          <span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">
            Project
          </span>
          <span className="block truncate text-sm font-semibold text-text-primary">
            {selected?.project_name || 'Select a project'}
          </span>
        </span>
        <span className={`shrink-0 text-text-muted transition-transform ${open ? 'rotate-180' : ''}`}>
          <ChevronDownIcon />
        </span>
      </button>

      {open && (
        <ul
          role="listbox"
          className="absolute left-0 top-[calc(100%+0.4rem)] z-40 max-h-[60vh] w-[280px] max-w-[80vw] overflow-y-auto rounded-xl border border-border-subtle bg-surface p-1.5 shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
        >
          {rows.map(({ project: p, depth }) => {
            const isActive = p.project_id === selectedId;
            const isSub = depth > 0;
            return (
              <li key={p.project_id}>
                <button
                  role="option"
                  aria-selected={isActive}
                  onClick={() => {
                    onSelect(p.project_id);
                    persistProjectId(p.project_id);
                    setOpen(false);
                  }}
                  className={`flex w-full items-start gap-2 rounded-lg py-2 pr-3 text-left transition-colors ${
                    isSub ? 'pl-7' : 'pl-3'
                  } ${
                    isActive ? 'bg-overlay-active text-text-primary' : 'text-text-secondary hover:bg-overlay-hover hover:text-text-primary'
                  }`}
                >
                  {isSub && (
                    <span aria-hidden className="mt-0.5 shrink-0 text-[11px] leading-none text-text-muted">
                      └─
                    </span>
                  )}
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-[13px] font-medium">{p.project_name}</span>
                    {p.context?.current_task && (
                      <span className="truncate text-[11px] text-text-muted">{p.context.current_task}</span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
