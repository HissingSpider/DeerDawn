import Head from 'next/head';
import { useEffect, useState } from 'react';
import { MetricTile, PageScaffold, SurfacePanel } from '@/components/dashboard/PageScaffold';
import { api, type RetentionMetrics } from '@/lib/api';
import { logger } from '@/lib/logger';

function money(cents: number) {
  return `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export default function Retention() {
  const [data, setData] = useState<RetentionMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api.getRetentionMetrics()
      .then(setData)
      .catch((err) => {
        logger.error('retention_load_failed', err);
        setError(err?.message || 'Failed to load retention metrics. This view is admin-only.');
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <>
      <Head>
        <title>Retention | DeerDawn</title>
      </Head>

      <PageScaffold
        title="Retention"
        description="The pay-twice view: MRR, active subscriptions, 30-day renewals and churn, and cohort retention. Admin-only."
      >
        {error && (
          <SurfacePanel>
            <div className="px-6 py-5 text-sm text-text-muted">{error}</div>
          </SurfacePanel>
        )}

        {data && (
          <>
            <div className="grid gap-4 lg:grid-cols-4">
              <MetricTile label="MRR" value={money(data.mrr_cents)} detail={`ARR ${money(data.arr_cents)}`} tone="primary" />
              <MetricTile label="Active subscriptions" value={data.active_subscriptions.toLocaleString()} detail={`${data.past_due} past due`} />
              <MetricTile label={`Renewals (${data.window_days}d)`} value={data.renewals.toLocaleString()} detail={`${data.new_subscriptions} new this window`} />
              <MetricTile label={`Churn (${data.window_days}d)`} value={`${(data.churn_rate * 100).toFixed(1)}%`} detail={`${data.churned} churned`} tone="warning" />
            </div>

            <SurfacePanel>
              <div className="border-b border-border-subtle px-6 py-5">
                <h2 className="text-lg font-semibold text-text-primary">Cohort retention</h2>
                <p className="mt-1 text-sm text-text-muted">Of the accounts that first paid in each month, how many are still active today.</p>
              </div>
              <div className="px-6 py-4">
                {(data.cohort_retention ?? []).length === 0 ? (
                  <p className="text-sm text-text-muted">No paid cohorts yet.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-text-muted">
                        <th className="py-2 font-medium">Cohort</th>
                        <th className="py-2 font-medium">Size</th>
                        <th className="py-2 font-medium">Retained</th>
                        <th className="py-2 font-medium">Retention</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.cohort_retention.map((c) => (
                        <tr key={c.cohort} className="border-t border-border-subtle text-text-primary">
                          <td className="py-2">{c.cohort}</td>
                          <td className="py-2">{c.size}</td>
                          <td className="py-2">{c.retained}</td>
                          <td className="py-2">{(c.retention * 100).toFixed(0)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </SurfacePanel>
          </>
        )}

        {loading && !data && !error && (
          <SurfacePanel>
            <div className="px-6 py-5 text-sm text-text-muted">Loading retention metrics…</div>
          </SurfacePanel>
        )}
      </PageScaffold>
    </>
  );
}
