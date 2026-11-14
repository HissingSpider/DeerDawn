import { TopNav } from '@/components/layout/TopNav';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Structural loading state for the dashboard shell.
 *
 * Renders the REAL TopNav (it needs only Clerk identity, not the bootstrap
 * payload) plus animate-pulse blocks shaped like dashboard content, instead of a
 * centered spinner on a blank canvas. Because the same <TopNav /> is reused once
 * bootstrap resolves, the nav never remounts — the shell feels present
 * immediately and the content simply fills in.
 */
export function AppShellSkeleton() {
  return (
    <div className="dashboard-shell bg-background">
      <TopNav />
      <main className="dashboard-main">
        <div className="dashboard-content-fullbleed">
          <div className="dashboard-content-inner">
            <span className="sr-only" role="status">Loading your workspace…</span>
            <div className="space-y-6 py-8" aria-hidden="true">
              <Skeleton variant="rectangular" height={112} className="w-full" />
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} variant="rectangular" height={140} className="w-full" />
                ))}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
