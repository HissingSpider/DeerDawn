import Head from 'next/head';
import { useEffect, useState } from 'react';
import {
  InlineErrorState,
  MetricTile,
  PageScaffold,
  PanelHeader,
  SurfacePanel,
} from '@/components/dashboard/PageScaffold';
import { api, type ProductEventSummary } from '@/lib/api';
import { logger } from '@/lib/logger';

function formatDuration(durationMs: number | null) {
  if (!durationMs || durationMs <= 0) return '—';
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatEventLabel(eventName: string) {
  return eventName.replace(/_/g, ' ');
}

export default function AnalyticsPage() {
  const [summary, setSummary] = useState<ProductEventSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadSummary = async () => {
    setLoading(true);
    setError('');
    try {
      const next = await api.getProductEventSummary();
      setSummary(next);
    } catch (err) {
      logger.error('product_analytics_load_failed', err);
      setError('Could not load product analytics right now.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSummary();
  }, []);

  return (
    <>
      <Head>
        <title>Analytics | DeerDawn</title>
      </Head>

      <PageScaffold
        title="Product analytics"
        description="Track onboarding speed, where people stall in conversion, and whether MCP activation is actually happening."
      >
        {error ? (
          <InlineErrorState
            title="Analytics unavailable"
            description={error}
            onRetry={loadSummary}
          />
        ) : null}

        <div className="grid gap-4 lg:grid-cols-4">
          <MetricTile
            label="Events"
            value={loading || !summary ? '—' : summary.totals.total_events.toLocaleString()}
            detail="All captured product events"
            tone="primary"
          />
          <MetricTile
            label="24h"
            value={loading || !summary ? '—' : summary.totals.events_last_24h.toLocaleString()}
            detail="Recent event volume"
          />
          <MetricTile
            label="Median onboarding"
            value={loading || !summary ? '—' : formatDuration(summary.onboarding.median_duration_ms)}
            detail="Time from first onboarding view to completion"
          />
          <MetricTile
            label="MCP activations"
            value={loading || !summary ? '—' : summary.funnel.mcp_start_sessions.toLocaleString()}
            detail="Successful start_session calls"
            tone="warning"
          />
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
          <SurfacePanel>
            <PanelHeader
              title="Conversion funnel"
              description="First cut on signup, checkout, import, and activation."
            />
            {loading || !summary ? (
              <div className="p-6 text-sm text-text-secondary">Loading funnel metrics…</div>
            ) : (
              <div className="grid gap-4 p-6 md:grid-cols-2">
                <div className="rounded-2xl border border-border-subtle bg-overlay-subtle p-5">
                  <div className="text-xs font-semibold uppercase tracking-[0.16em] text-text-muted">Signup</div>
                  <div className="mt-4 flex items-end gap-6">
                    <div>
                      <div className="text-3xl font-semibold tracking-[-0.04em] text-text-primary">{summary.funnel.signup_starts.toLocaleString()}</div>
                      <div className="mt-1 text-sm text-text-muted">Started</div>
                    </div>
                    <div>
                      <div className="text-3xl font-semibold tracking-[-0.04em] text-text-primary">{summary.funnel.signup_successes.toLocaleString()}</div>
                      <div className="mt-1 text-sm text-text-muted">Succeeded</div>
                    </div>
                    <div>
                      <div className="text-3xl font-semibold tracking-[-0.04em] text-text-primary">{summary.funnel.signup_failures.toLocaleString()}</div>
                      <div className="mt-1 text-sm text-text-muted">Failed</div>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-border-subtle bg-overlay-subtle p-5">
                  <div className="text-xs font-semibold uppercase tracking-[0.16em] text-text-muted">Checkout</div>
                  <div className="mt-4 flex items-end gap-6">
                    <div>
                      <div className="text-3xl font-semibold tracking-[-0.04em] text-text-primary">{summary.funnel.checkout_starts.toLocaleString()}</div>
                      <div className="mt-1 text-sm text-text-muted">Started</div>
                    </div>
                    <div>
                      <div className="text-3xl font-semibold tracking-[-0.04em] text-text-primary">{summary.funnel.checkout_failures.toLocaleString()}</div>
                      <div className="mt-1 text-sm text-text-muted">Failed</div>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-border-subtle bg-overlay-subtle p-5">
                  <div className="text-xs font-semibold uppercase tracking-[0.16em] text-text-muted">Import</div>
                  <div className="mt-4 flex items-end gap-6">
                    <div>
                      <div className="text-3xl font-semibold tracking-[-0.04em] text-text-primary">{summary.funnel.import_starts.toLocaleString()}</div>
                      <div className="mt-1 text-sm text-text-muted">Started</div>
                    </div>
                    <div>
                      <div className="text-3xl font-semibold tracking-[-0.04em] text-text-primary">{summary.funnel.import_successes.toLocaleString()}</div>
                      <div className="mt-1 text-sm text-text-muted">Succeeded</div>
                    </div>
                    <div>
                      <div className="text-3xl font-semibold tracking-[-0.04em] text-text-primary">{summary.funnel.import_failures.toLocaleString()}</div>
                      <div className="mt-1 text-sm text-text-muted">Failed</div>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-border-subtle bg-overlay-subtle p-5">
                  <div className="text-xs font-semibold uppercase tracking-[0.16em] text-text-muted">Onboarding</div>
                  <div className="mt-4 flex items-end gap-6">
                    <div>
                      <div className="text-3xl font-semibold tracking-[-0.04em] text-text-primary">{summary.onboarding.views.toLocaleString()}</div>
                      <div className="mt-1 text-sm text-text-muted">Views</div>
                    </div>
                    <div>
                      <div className="text-3xl font-semibold tracking-[-0.04em] text-text-primary">{summary.onboarding.completions.toLocaleString()}</div>
                      <div className="mt-1 text-sm text-text-muted">Completed</div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </SurfacePanel>

          <SurfacePanel>
            <PanelHeader
              title="Recent events"
              description="Most recent event trail for this org."
            />
            {loading || !summary ? (
              <div className="p-6 text-sm text-text-secondary">Loading recent events…</div>
            ) : (
              <div className="divide-y divide-border-subtle">
                {summary.recent.map((event) => (
                  <div key={`${event.event_name}-${event.created_at}`} className="px-6 py-4">
                    <div className="flex items-center justify-between gap-4">
                      <div className="text-sm font-medium text-text-primary">{formatEventLabel(event.event_name)}</div>
                      <div className="text-xs text-text-muted">{new Date(event.created_at).toLocaleString()}</div>
                    </div>
                    <div className="mt-1 text-xs uppercase tracking-[0.14em] text-text-muted">
                      {event.source}{event.surface ? ` · ${event.surface}` : ''}{event.path ? ` · ${event.path}` : ''}
                    </div>
                  </div>
                ))}
                {summary.recent.length === 0 ? (
                  <div className="p-6 text-sm text-text-secondary">No events recorded yet.</div>
                ) : null}
              </div>
            )}
          </SurfacePanel>
        </div>
      </PageScaffold>
    </>
  );
}
