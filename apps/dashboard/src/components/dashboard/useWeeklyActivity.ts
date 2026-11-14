import { useEffect, useState } from 'react';
import { api, type WeeklyActivity } from '@/lib/api';
import { logger } from '@/lib/logger';
import { classifyLoadFailure, isRefusedLoad } from '@/lib/loadFailure';

// Single fetch of the weekly-activity rollup, shared by every consumer in the
// session. Previously the shell strip, the brief-diff card and the usage page
// each fired their own request on mount; now the nav badge and the usage page
// read the same in-flight promise.
let cached: Promise<WeeklyActivity> | null = null;

function load(): Promise<WeeklyActivity> {
  if (!cached) {
    cached = api.getWeeklyActivity().catch((err) => {
      // Let the next consumer retry rather than caching the failure forever.
      cached = null;
      throw err;
    });
  }
  return cached;
}

export function useWeeklyActivity(): WeeklyActivity | null {
  const [data, setData] = useState<WeeklyActivity | null>(null);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        // A workspace whose subscription is inactive refuses this rollup on
        // every page load (the nav reads it everywhere). That refusal is the
        // workspace's state, not a fault in the request: the badge has nothing
        // to show, and the pages that load the workspace's data say why.
        // Logging it put an "ApiError" issue on every page a locked person
        // opened.
        if (isRefusedLoad(classifyLoadFailure(err))) return;
        logger.error('weekly_activity_failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return data;
}
