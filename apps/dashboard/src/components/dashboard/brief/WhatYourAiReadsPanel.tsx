import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { logger } from '@/lib/logger';
import { Skeleton } from '@/components/ui/Skeleton';

// Per-tool toggle — each tool gets a slightly different rendered brief, and this
// is the transparency moment: "this is the exact text your AI reads." Reads
// /projects/:id/inject?tool=… which is UNBLOCKED today.
const TOOLS: { id: string; label: string }[] = [
  { id: 'claude_code', label: 'Claude Code' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'codex', label: 'Codex' },
  { id: 'chatgpt_web', label: 'ChatGPT' },
  { id: 'claude_web', label: 'Claude (web)' },
];

export function WhatYourAiReadsPanel({ projectId }: { projectId: string | null }) {
  const [tool, setTool] = useState(TOOLS[0].id);
  const [body, setBody] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!projectId) {
      setBody(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(false);
    api
      .getProjectInject(projectId, { tool, verbosity: 'standard' })
      .then((r) => {
        if (!cancelled) setBody(r.body);
      })
      .catch((err) => {
        if (cancelled) return;
        logger.error('what_ai_reads_failed', err);
        setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, tool]);

  return (
    <div className="rounded-xl border border-border-subtle bg-overlay-subtle p-4">
      <h3 className="text-[12px] font-semibold uppercase tracking-[0.1em] text-text-secondary">
        This is what your AI reads
      </h3>
      <p className="mt-1 text-[11px] leading-tight text-text-muted">
        The exact brief injected per tool. No black box — just the brief.
      </p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {TOOLS.map((t) => {
          const isActive = t.id === tool;
          return (
            <button
              key={t.id}
              onClick={() => setTool(t.id)}
              aria-pressed={isActive}
              className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                isActive
                  ? 'border-primary/40 bg-primary/15 text-primary'
                  : 'border-border-subtle text-text-secondary hover:border-border-strong hover:text-text-primary'
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="mt-3">
        {!projectId ? (
          <p className="text-[13px] leading-6 text-text-muted">Select a project to preview its brief.</p>
        ) : loading ? (
          <div className="space-y-2">
            <Skeleton variant="text" width="100%" />
            <Skeleton variant="text" width="92%" />
            <Skeleton variant="text" width="70%" />
          </div>
        ) : error ? (
          <p className="text-[13px] leading-6 text-text-muted">Couldn&apos;t render the {labelFor(tool)} brief. Try another tool or reload.</p>
        ) : !body ? (
          <p className="text-[13px] leading-6 text-text-muted">No brief to render for this project yet.</p>
        ) : (
          <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--code-bg)] p-3 font-mono text-[11.5px] leading-[1.55] text-text-secondary [overflow-wrap:anywhere]">
            {body}
          </pre>
        )}
      </div>
    </div>
  );
}

function labelFor(id: string) {
  return TOOLS.find((t) => t.id === id)?.label ?? id;
}
