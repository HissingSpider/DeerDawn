import React, { createContext, useContext, useMemo, useRef } from 'react';
import useSWR from 'swr';
import { ApiError, api, apiErrorReason, DashboardBootstrap, SetupStatusResult } from '@/lib/api';
import { logger } from '@/lib/logger';
import { trackProductEvent } from '@/lib/productAnalytics';
import { connectionEvidence } from '@/lib/connectionEvidence';

type BootstrapState = {
  bootstrap: DashboardBootstrap | null;
  isLoading: boolean;
  error: ApiError | null;
  refresh: () => Promise<void>;
};

const DashboardBootstrapContext = createContext<BootstrapState | null>(null);

function mergeSetupStatus(data: DashboardBootstrap, setupStatus: SetupStatusResult | null): DashboardBootstrap {
  if (!setupStatus) return data;
  const runtimeReady = (setupStatus.runtime_verified_count || 0) > 0;
  const baseSyncHealth = data.sync_health || {
    has_projects: false,
    last_synced: null,
    recently_active: false,
    desktop_connected: false,
    mcp_registered: false,
  };
  return {
    ...data,
    setup_status: setupStatus,
    sync_health: {
      ...baseSyncHealth,
      execution_source: setupStatus.execution_source,
      verified_surfaces: runtimeReady ? setupStatus.runtime_verified_count : setupStatus.verified_count,
      setup_complete: runtimeReady || setupStatus.setup_complete,
      desktop_connected: setupStatus.execution_source === 'desktop_bridge' || Boolean(baseSyncHealth.desktop_connected),
      mcp_registered: runtimeReady || Boolean(baseSyncHealth.mcp_registered),
    },
  };
}

const BOOTSTRAP_KEY = 'dashboard-bootstrap';

const RECONCILED_KEY_PREFIX = 'dd_connection_reconciled:';

/**
 * Record a connection observed on a later dashboard load, once per person per
 * browser.
 *
 * This used to live in SampleBriefEmptyState, which renders only when the account
 * has NO projects. Anyone who connects and receives a brief has a project, so the
 * emitter was structurally blind to exactly the users who succeed; measured, all
 * 3 people who synced read 0 while the 1 it detected never synced. The provider
 * is mounted on every dashboard page, so it sees every returning connected user.
 */
function reportReconciledConnection(merged: DashboardBootstrap) {
  // Same definition the connect step uses, from the same module, so the two
  // emitters of onboarding_connection_detected cannot mean different things.
  //
  // `verified_count` used to be ORed in here and is gone: it counts surfaces the
  // local CLI has CONFIGURED, which is a file on disk, not a client that reached
  // us. runtime_verified_count is the one that means the runtime came up.
  const evidence = connectionEvidence({
    mcpRegistered: Boolean(merged.sync_health?.mcp_registered),
    hasFirstSync: Boolean(merged.sync_health?.has_first_sync),
    runtimeVerified: (merged.setup_status?.runtime_verified_count ?? 0) > 0,
    hasProjects: Boolean(merged.sync_health?.has_projects),
    recentlyActive: Boolean(merged.sync_health?.recently_active),
  });
  if (evidence === 'none' || typeof window === 'undefined') return;
  const key = `${RECONCILED_KEY_PREFIX}${merged.user?.id || 'anonymous'}`;
  try {
    if (window.localStorage.getItem(key)) return;
    window.localStorage.setItem(key, new Date().toISOString());
  } catch {
    // Storage unavailable: the ref guard below still limits it to once per load.
  }
  trackProductEvent('onboarding_connection_detected', {
    source: 'dashboard',
    path: window.location.pathname,
    metadata: {
      surface: 'dashboard_bootstrap',
      reconciled: true,
      evidence,
      has_projects: Boolean(merged.sync_health?.has_projects),
      has_first_sync: Boolean(merged.sync_health?.has_first_sync),
    },
  });
}

// Combined bootstrap fetch: the workspace bootstrap plus the best-effort local
// setup status, merged. Always throws an ApiError on failure so SWR's `error`
// (and getBootstrapErrorState) stays an ApiError, matching the prior behavior.
async function fetchBootstrap(): Promise<DashboardBootstrap> {
  try {
    const [data, setupStatus] = await Promise.all([
      api.getDashboardBootstrap(),
      api.getLocalSetupStatus().catch(() => null),
    ]);
    return mergeSetupStatus(data, setupStatus);
  } catch (err) {
    throw err instanceof ApiError ? err : new ApiError(500, 'Failed to load workspace');
  }
}

export function DashboardBootstrapProvider({ children }: { children: React.ReactNode }) {
  const trackedLoad = useRef(false);

  const { data, error, isLoading, mutate } = useSWR<DashboardBootstrap, ApiError>(
    BOOTSTRAP_KEY,
    fetchBootstrap,
    {
      // Preserve current behavior: load on mount + manual refresh only. We do NOT
      // revalidate on focus/reconnect yet — AppShell treats any `error` as fatal
      // even when data exists, so a background-revalidation failure would wrongly
      // bounce the user to the error screen. Enabling focus revalidation needs
      // that AppShell change first.
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
      dedupingInterval: 5000,
      onSuccess: (merged) => {
        if (trackedLoad.current) return;
        trackedLoad.current = true;
        reportReconciledConnection(merged);
        trackProductEvent('dashboard_bootstrap_loaded', {
          source: 'dashboard',
          path: typeof window !== 'undefined' ? window.location.pathname : '/dashboard',
          metadata: {
            status: merged.status,
            runtime_verified_count: merged.setup_status?.runtime_verified_count || 0,
            verified_count: merged.setup_status?.verified_count || 0,
            has_projects: Boolean(merged.sync_health?.has_projects),
          },
        });
      },
      onError: (err) => {
        logger.error('dashboard_bootstrap_failed', err, { route: typeof window !== 'undefined' ? window.location.pathname : 'server' });
        trackProductEvent('dashboard_bootstrap_failed', {
          source: 'dashboard',
          path: typeof window !== 'undefined' ? window.location.pathname : '/dashboard',
          metadata: {
            status: err.status,
            code: err.code || null,
          },
        });
      },
    }
  );

  const refresh = React.useCallback(async () => {
    await mutate();
  }, [mutate]);

  const value = useMemo<BootstrapState>(
    () => ({ bootstrap: data ?? null, isLoading, error: error ?? null, refresh }),
    [data, isLoading, error, refresh]
  );
  return <DashboardBootstrapContext.Provider value={value}>{children}</DashboardBootstrapContext.Provider>;
}

export function useDashboardBootstrap() {
  const context = useContext(DashboardBootstrapContext);
  if (!context) {
    throw new Error('useDashboardBootstrap must be used inside DashboardBootstrapProvider');
  }
  return context;
}

export function getBootstrapErrorState(error: ApiError | null) {
  if (!error) return null;

  // A 401 we caused by sending no token is NOT an expired session, and routing
  // it to sign-in is what closes the loop: /login sees a live Clerk session,
  // redirects straight back here, this fetch 401s again, and the reader is
  // pinned between two screens that each think the other will fix it. Offer a
  // retry, which is the action that can actually succeed once the auth service
  // answers again.
  if (error.code === 'auth_token_unavailable') {
    return {
      code: 'auth_unverified',
      title: 'We couldn’t verify your sign-in.',
      description: 'The authentication service didn’t answer, so your session could not be confirmed. You are most likely still signed in — retry in a moment.',
      primaryLabel: 'Retry',
    };
  }

  // A 403 that names the WORKSPACE, not the session. The API client has already
  // dropped a stale stored workspace and retried, so reaching here means the
  // account's own default workspace refused too (a legacy member whose home org
  // is the team they were removed from). Signing out cannot fix that, and it is
  // what used to close the loop: /login saw a live session and sent them back.
  //
  // Retry cannot fix it either, and offering it was the second dead end: the
  // stale choice is already gone, so a retry re-asks the same refused default
  // forever. AppShell hands this state to WorkspaceForbiddenExit, which asks the
  // server which workspaces this person may actually enter and offers a switch —
  // or, when the answer is none, says so and signs out deliberately. The
  // description below is only the fallback shown while that lookup is in flight.
  if (apiErrorReason(error) === 'workspace_forbidden') {
    return {
      code: 'workspace_forbidden',
      title: 'You no longer have access to this workspace.',
      description: 'A workspace owner removed you, or the workspace was closed. Your own account is unaffected.',
      primaryLabel: 'Sign out',
    };
  }

  if (error.status === 401 || error.status === 403) {
    return {
      code: 'auth_expired',
      title: 'Your dashboard session expired.',
      description: 'Sign in again to restore the workspace session and continue where you left off.',
      primaryLabel: 'Go to sign in',
    };
  }

  // A blocked / timed-out bootstrap (often a CORS-masked 401) would otherwise land
  // in a Retry-only state that just re-runs the same failing fetch — a dead end.
  // Route it to sign-in too so the user always has a working escape hatch.
  if (error.code === 'network_unreachable' || error.code === 'network_timeout') {
    return {
      code: 'auth_expired',
      title: 'We couldn’t reach your workspace.',
      description: 'This usually clears with a fresh sign-in. If it keeps happening, check your connection and try again.',
      primaryLabel: 'Go to sign in',
    };
  }

  if (error.code === 'org_not_found' || error.status === 404) {
    return {
      code: 'workspace_missing',
      title: 'This workspace is no longer available.',
      description: 'The session is valid, but the workspace could not be found. Retry once, then contact support if the workspace should still exist.',
      primaryLabel: 'Retry workspace bootstrap',
    };
  }

  if (error.code === 'bootstrap_failed' || error.status >= 500) {
    return {
      code: 'bootstrap_failed',
      title: 'We could not restore the workspace bootstrap.',
      description: 'The workspace request failed before the dashboard could render. Retry once. If it keeps failing, use sign in recovery instead of continuing on a stale session.',
      primaryLabel: 'Retry workspace bootstrap',
    };
  }

  return {
    code: 'provider_unavailable',
    title: 'The workspace is temporarily unavailable.',
    description: error.message || 'Retry once. If it continues to fail, sign in again.',
    primaryLabel: 'Retry workspace bootstrap',
  };
}
