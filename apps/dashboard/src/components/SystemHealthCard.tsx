import { Card } from './ui/Card';
import { Skeleton } from './ui/Skeleton';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { logger } from '@/lib/logger';

interface HealthMetrics {
  latency: {
    avg: number;
    p95: number;
    p99: number;
    unit: string;
  };
  error_rate: {
    percent: number;
    fail_safe_count: number;
    total_decisions: number;
  };
  last_outage: {
    timestamp: string;
    metadata: any;
  } | null;
  total_decisions_24h: number;
}

export function SystemHealthCard() {
  const [metrics, setMetrics] = useState<HealthMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const data = await api.getHealthMetrics();
        setMetrics(data);
      } catch (err) {
        logger.error('Failed to load health metrics', err);
      } finally {
        setLoading(false);
      }
    };

    load();

    // Refresh every 30 seconds
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, []);

  const getLatencyColor = (p95: number) => {
    if (p95 < 50) return 'text-primary'; // Green - Excellent
    if (p95 < 100) return 'text-[#6EE7B7]'; // Light green - Good
    if (p95 < 200) return 'text-[#FCD34D]'; // Yellow - Warning
    return 'text-[#EF4444]'; // Red - Critical
  };

  const getErrorRateColor = (percent: number) => {
    if (percent === 0) return 'text-primary'; // Green
    if (percent < 1) return 'text-[#FCD34D]'; // Yellow
    return 'text-[#EF4444]'; // Red
  };

  const formatOutageTime = (timestamp: string) => {
    const now = new Date();
    const outageTime = new Date(timestamp);
    const diffMs = now.getTime() - outageTime.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

    if (diffDays > 0) return `${diffDays}d ago`;
    if (diffHours > 0) return `${diffHours}h ago`;
    return 'Recently';
  };

  const hasRecentActivity = (metrics?.total_decisions_24h || 0) > 0;

  return (
    <div>
      <Card>
        <div className="rounded-md border border-border px-5 py-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-x-[var(--vr-card-row)] gap-y-[var(--vr-card-stack)]">
            {/* API Latency */}
            <div>
              <div className="text-xs font-medium text-text-muted mb-2">API Latency (24h)</div>
              {loading ? (
                <>
                  <Skeleton height={32} className="mb-2" />
                  <Skeleton height={20} />
                </>
              ) : (
                <>
                  {hasRecentActivity ? (
                    <>
                      <div className={`text-xl font-semibold mb-2 ${getLatencyColor(metrics?.latency.p95 || 0)}`}>
                        {metrics?.latency.p95 || 0}ms
                        <span className="text-xs text-text-muted ml-1">(p95)</span>
                      </div>
                      <div className="text-xs text-text-muted space-y-1">
                        <div>
                          Avg: <span className="text-text-secondary">{metrics?.latency.avg || 0}ms</span>
                        </div>
                        <div>
                          p99: <span className="text-text-secondary">{metrics?.latency.p99 || 0}ms</span>
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="text-xl font-semibold mb-2 text-text-secondary">—</div>
                      <div className="text-xs text-text-muted">
                        Awaiting live traffic.
                      </div>
                    </>
                  )}
                </>
              )}
            </div>

            {/* Error Rate */}
            <div>
              <div className="text-xs font-medium text-text-muted mb-2">Error Rate (24h)</div>
              {loading ? (
                <>
                  <Skeleton height={32} className="mb-2" />
                  <Skeleton height={20} />
                </>
              ) : (
                <>
                  {hasRecentActivity ? (
                    <>
                      <div className={`text-xl font-semibold mb-2 ${getErrorRateColor(metrics?.error_rate.percent || 0)}`}>
                        {metrics?.error_rate.percent || 0}%
                      </div>
                      <div className="text-xs text-text-muted space-y-1">
                        <div>
                          Fail-safe count:{' '}
                          <span className="text-text-secondary">
                            {metrics?.error_rate.fail_safe_count || 0}
                          </span>
                        </div>
                        <div>
                          Total decisions:{' '}
                          <span className="text-text-secondary">
                            {metrics?.error_rate.total_decisions?.toLocaleString() || 0}
                          </span>
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="text-xl font-semibold mb-2 text-text-secondary">—</div>
                      <div className="text-xs text-text-muted">
                        Awaiting live traffic.
                      </div>
                    </>
                  )}
                </>
              )}
            </div>

            {/* Last Outage */}
            <div>
              <div className="text-xs font-medium text-text-muted mb-2">Last Outage</div>
              {loading ? (
                <>
                  <Skeleton height={32} className="mb-2" />
                  <Skeleton height={20} />
                </>
              ) : (
                <>
                  {metrics?.last_outage ? (
                    <>
                      <div className="text-xl font-semibold text-[#FCD34D] mb-2">
                        {formatOutageTime(metrics.last_outage.timestamp)}
                      </div>
                      <div className="text-xs text-text-muted">
                        {new Date(metrics.last_outage.timestamp).toLocaleString()}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="text-xl font-semibold text-primary mb-2">
                        None recorded
                      </div>
                      <div className="text-xs text-text-muted">
                        No incidents reported.
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Health Summary */}
        {!loading && metrics && (
          <div className="mt-4 pt-4 border-t border-border">
            <div className="flex items-center gap-2">
              {hasRecentActivity ? (
                <>
                  <div
                    className={`w-2 h-2 rounded-full ${
                      metrics.error_rate.percent === 0 && metrics.latency.p95 < 100
                        ? 'bg-primary'
                        : metrics.error_rate.percent < 1 && metrics.latency.p95 < 200
                        ? 'bg-[#FCD34D]'
                        : 'bg-[#EF4444]'
                    }`}
                  />
                  <span className="text-xs text-text-secondary">
                    {metrics.error_rate.percent === 0 && metrics.latency.p95 < 100
                      ? 'Operating within expected thresholds.'
                      : metrics.error_rate.percent < 1 && metrics.latency.p95 < 200
                      ? 'Performance is slightly degraded.'
                      : 'Performance is degraded.'}
                  </span>
                </>
              ) : (
                <span className="text-xs text-text-secondary">
                  Awaiting live activity to establish health status.
                </span>
              )}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
