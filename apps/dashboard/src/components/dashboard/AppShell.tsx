import { BrandLogo } from '@/components/BrandLogo';
import { useCallback, useEffect } from 'react';
import { useRouter } from 'next/router';
import { useSafeSignOut } from '@/lib/useSafeSignOut';
import { getBootstrapErrorState, useDashboardBootstrap } from './DashboardBootstrapProvider';
import { TopNav } from '@/components/layout/TopNav';
import { AppShellSkeleton } from './AppShellSkeleton';
import { UpgradeBanner } from './UpgradeBanner';
import { PostSyncModal } from './PostSyncModal';
import { ThirdBriefOffer } from './ThirdBriefOffer';
import { UpgradeSuccessModal } from './UpgradeSuccessModal';
import { WorkspaceForbiddenExit } from './WorkspaceForbiddenExit';
import { WorkspaceFallbackBanner } from './WorkspaceFallbackBanner';
import { WorkspaceRemovedNotice } from './WorkspaceRemovedNotice';
import { planRequiredRedirect } from '@/lib/planRequired';
import { useDeployment } from '@/lib/deployment';


export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { bootstrap, isLoading, error, refresh } = useDashboardBootstrap();
  const errorState = getBootstrapErrorState(error);
  const signOut = useSafeSignOut();
  // Self-hosted: nothing is for sale, so no upgrade banner, offer or modal.
  const { selfHosted: selfHostedDeployment } = useDeployment();
  const selfHosted = selfHostedDeployment || Boolean(bootstrap?.deployment?.self_hosted);

  // Bug 3 fix: the session-expiry "Go to sign in" button previously just
  // pushed to /login while the Clerk session was still technically active on
  // the client. ClerkAuthPage then got a session_exists error and immediately
  // redirected back to /, which re-triggered the 401 → loop forever.
  // Signing out first clears the Clerk client state so /login shows cleanly.
  const handleAuthErrorSignIn = useCallback(async () => {
    try {
      // Let Clerk land the user on /login itself — a bare signOut() defaults to
      // afterSignOutUrl='/', which races and overrides a manual push('/login')
      // and bounces the user back through the authed home (re-triggering the 401).
      await signOut({ redirectUrl: '/login' });
    } catch {
      // Non-fatal — force the redirect even if signOut throws.
      router.push('/login');
    }
  }, [signOut, router]);

  // A new hosted account created while the free tier for new signups was off
  // has no plan yet (lib/planRequired): every product request would be
  // refused, so send it to the plan picker instead of a page of errors.
  const planRequiredTarget = planRequiredRedirect(bootstrap?.org?.subscription_status, router.pathname);
  useEffect(() => {
    if (planRequiredTarget) void router.replace(planRequiredTarget);
  }, [planRequiredTarget, router]);

  if ((isLoading && !bootstrap) || planRequiredTarget) {
    return <AppShellSkeleton />;
  }

  if (!bootstrap || error) {
    const isAuthError = errorState?.code === 'auth_expired';
    // workspace_forbidden owns its own actions. Retry is the wrong verb there —
    // for a legacy member whose home org IS the team, the account default
    // resolves to the same refused workspace and the button can never succeed.
    const isWorkspaceForbidden = errorState?.code === 'workspace_forbidden';
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-8 bg-background">
        <div className="relative h-12 w-12">
          <BrandLogo alt="DeerDawn" priority sizes="48px" className="object-contain opacity-[0.72]" />
        </div>
        <div className="max-w-[360px] px-6 text-center">
          <div className="mx-auto mb-5 flex h-10 w-10 items-center justify-center rounded-full border border-[#EF4444]/[0.18] bg-[#EF4444]/[0.08]">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <p className="mb-2 text-[15px] font-semibold tracking-[-0.01em] text-text-primary">
            {errorState?.title || 'Could not load workspace'}
          </p>
          {isWorkspaceForbidden ? (
            <WorkspaceForbiddenExit description={errorState?.description || ''} />
          ) : (
          <>
          <p className="mb-6 text-[13px] leading-[1.6] text-text-muted">
            {errorState?.description}
          </p>
          <button
            onClick={() => isAuthError ? handleAuthErrorSignIn() : refresh()}
            className="inline-flex cursor-pointer items-center justify-center rounded-[10px] border-none px-7 py-2.5 text-[13px] font-semibold"
            style={{
              transition: 'opacity 0.15s',
              background: isAuthError ? 'var(--primary)' : 'var(--overlay-active)',
              color: isAuthError ? 'var(--on-primary)' : 'var(--text-primary)',
              outline: isAuthError ? 'none' : '1px solid var(--border-subtle)',
            }}
            onMouseOver={e => { e.currentTarget.style.opacity = '0.85'; }}
            onMouseOut={e => { e.currentTarget.style.opacity = '1'; }}
          >
            {isAuthError ? 'Go to sign in' : (errorState?.primaryLabel || 'Retry')}
          </button>
          </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-shell bg-background">
      <TopNav />

      {/* ABOVE the upgrade banner, and deliberately not dismissible: it does not
          advertise anything, it corrects what the rest of the shell is saying.
          While the active team's subscription is lapsed every request on this
          page is answered by the reader's PERSONAL workspace, and nothing else
          on screen would tell them so. Renders nothing for everybody else. */}
      <WorkspaceFallbackBanner />

      {/* Once, after a tab reloaded because its person was removed from the
          team it showed (lib/workspaceRemoval). */}
      <WorkspaceRemovedNotice />

      {/* One persistent bar. The weekly-activity strip used to sit here and
          repeated the same four numbers above every route — it now lives on
          Usage, where someone actually goes to look at numbers, and its drift
          warning became the count badge on the Memory nav item. The upgrade
          banner stays: it is free-tier only, self-dismissing, and since E-021 it
          waits until the account has actually been briefed once. */}
      {selfHosted ? null : (
        <UpgradeBanner
          limits={bootstrap.usage?.limits}
          hasFirstSync={bootstrap.sync_health?.has_first_sync}
        />
      )}

      <main className="dashboard-main">
        {/* Full-bleed scroll viewport; the inner frame centers content + applies
            the standard page gutters. The home page is now brief-first (the
            4-slot brief), so it uses the standard gutter container like every
            other route — the graph still owns its full canvas inside the
            Library tab, where its own flex chain fills the height. */}
        <div className="dashboard-content-fullbleed">
          <div className="dashboard-content-inner">{children}</div>
        </div>
      </main>

      {/* PostSyncModal claims the session's ask beat — for the celebration as
          well as for its own ask — so the third-brief offer can never land in
          the same beat as the first-sync celebration. See lib/upgradeOffer.ts.
          What holds that today is NOT JSX order: React runs effects child-first,
          so everything inside {children} (HistoryTrimNotice included) mounts
          first. It holds because PostSyncModal decides synchronously on mount
          while HistoryTrimNotice waits on the /inject round trip. If that
          context is ever served from cache (SWR, prefetch, bfcache), the trim
          notice would win the race and could appear alongside the celebration —
          at which point the claim belongs in a hook called here, above children. */}
      {/* All three sell or celebrate a plan; a self-hosted install has none. */}
      {selfHosted ? null : (
        <>
          <PostSyncModal bootstrap={bootstrap} />
          <ThirdBriefOffer bootstrap={bootstrap} />
          <UpgradeSuccessModal bootstrap={bootstrap} />
        </>
      )}
    </div>
  );
}
