import Head from 'next/head';
import { useEffect, useMemo, useState } from 'react';
import { PageScaffold, SurfacePanel } from '@/components/dashboard/PageScaffold';
import { api, type ContextExportBundle } from '@/lib/api';
import { Skeleton } from '@/components/ui/Skeleton';

export default function DataPage() {
  const [bundle, setBundle] = useState<ContextExportBundle | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [downloading, setDownloading] = useState<'json' | 'markdown' | null>(null);
  const [downloadError, setDownloadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getContextExport()
      .then((b) => { if (!cancelled) setBundle(b); })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, []);

  const stats = useMemo(() => {
    if (!bundle) return null;
    const projects = bundle.projects || [];
    const knowledgeNodes = projects.reduce((sum, p) => sum + (p.graph?.nodes?.length || 0), 0);
    const g = bundle.global_context || {};
    const profileFields = Object.entries(g).filter(([, v]) =>
      (Array.isArray(v) ? v.length > 0 : Boolean(v)),
    ).length;
    return { projectCount: projects.length, knowledgeNodes, profileFields };
  }, [bundle]);

  // Neither arrived yet: no bundle to count, and no failure to report.
  const loading = !bundle && !loadError;

  async function handleDownload(format: 'json' | 'markdown') {
    setDownloading(format);
    setDownloadError(false);
    try {
      await api.downloadContextExport(format);
    } catch {
      setDownloadError(true);
    } finally {
      setDownloading(null);
    }
  }

  return (
    <>
      <Head>
        <title>Your data | DeerDawn</title>
      </Head>

      <PageScaffold
        title="Your data"
        description="Your profile, preferences, projects, knowledge graph and skills, and a one-click way to take them with you. Your context is yours."
      >
        <SurfacePanel className="p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-text-primary">What we hold</h2>
              <p className="mt-1 text-xs text-text-secondary max-w-xl">
                Your profile, preferences, every project (archived ones included) with its full context and
                knowledge graph, and your skills, with any you switched off marked as switched off.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => handleDownload('json')}
                disabled={downloading !== null}
                className="inline-flex items-center gap-1.5 rounded-lg border border-primary/40 bg-primary px-3.5 py-1.5 text-xs font-semibold text-on-primary transition-colors hover:bg-primary/90 disabled:opacity-60"
              >
                {downloading === 'json' ? 'Exporting…' : 'Export JSON'}
              </button>
              <button
                onClick={() => handleDownload('markdown')}
                disabled={downloading !== null}
                className="inline-flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-3.5 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/15 disabled:opacity-60"
              >
                {downloading === 'markdown' ? 'Exporting…' : 'Export Markdown'}
              </button>
            </div>
          </div>

          {downloadError ? (
            <p className="mt-3 text-[11px] text-status-danger">
              Export failed. Make sure you’re signed in, then try again.
            </p>
          ) : null}

          {/* SAY IT IS WORKING. These three numbers are not read from a counts
              endpoint — there isn't one. They are derived by downloading the
              entire export bundle and counting it client-side, which for a real
              account is thousands of knowledge nodes and takes seconds. The old
              placeholder was a single "…" character inside each tile: no motion,
              no label, indistinguishable from a number that failed to arrive. It
              read as broken, and people closed the page before it finished. A
              pulsing bar plus a sentence naming what is happening costs nothing
              and turns a suspected fault into an obvious wait. */}
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <Stat label="Projects" value={loadError ? '—' : stats?.projectCount} />
            <Stat label="Knowledge entries" value={loadError ? '—' : stats?.knowledgeNodes} />
            <Stat label="Profile fields" value={loadError ? '—' : stats?.profileFields} />
          </div>

          {loading ? (
            <p className="mt-3 flex items-center gap-2 text-[11px] text-text-muted" role="status">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-text-muted" />
              Reading your whole archive to count it — this can take a few seconds on a large
              workspace. The export buttons work now; they don&apos;t wait for this.
            </p>
          ) : null}

          {loadError ? (
            <p className="mt-4 text-[11px] text-text-muted">
              Couldn’t load your data summary right now — the export buttons above still work.
            </p>
          ) : null}

          <div className="mt-6 rounded-xl border border-border-subtle bg-background p-4">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">
              What the export does and doesn’t include
            </h3>
            <p className="mt-2 text-[11px] leading-5 text-text-secondary">
              The export carries your raw context — profiles, project notes, decisions, and knowledge.
              It does not carry the compounding layer DeerDawn builds on top: learned cross-project
              affinities, retrieval rankings, and embeddings are recomputed continuously, not stored as a
              portable file. Your data is fully yours to take; the intelligence is the part that keeps
              working when you stay.
            </p>
          </div>
        </SurfacePanel>
      </PageScaffold>
    </>
  );
}

/**
 * `undefined` means still counting, and gets a pulsing bar sized like the number
 * it will become — so the tile does not jump when the value lands. It must NOT
 * fall back to a static character: the previous "…" was silent, motionless and
 * identical to a permanent failure, which is exactly how it was read.
 * A hard failure is a separate, deliberate em dash passed in by the caller.
 */
function Stat({ label, value }: { label: string; value?: number | string }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-overlay-subtle p-4">
      <div className="flex h-8 items-center text-2xl font-semibold tabular-nums text-text-primary">
        {value === undefined ? (
          <Skeleton variant="text" width="3.5rem" height="1.5rem" />
        ) : (
          value
        )}
      </div>
      <div className="mt-0.5 text-[11px] text-text-muted">{label}</div>
    </div>
  );
}
