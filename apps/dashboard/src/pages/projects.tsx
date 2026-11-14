import Head from 'next/head';
import Link from 'next/link';
import { useState } from 'react';
import { BriefWorkspace } from '@/components/dashboard/brief/BriefWorkspace';
import { useDashboardBootstrap } from '@/components/dashboard/DashboardBootstrapProvider';
import { shouldShowFirstValueBanner } from '@/lib/firstValueBanner';

// First-value setup strip: surfaces MCP setup status on the home page and routes
// incomplete users straight to onboarding / context import. Hides itself once the
// MCP is connected and a first briefed session has landed, so established users never see it.
function FirstValueBanner() {
  const { bootstrap, isLoading } = useDashboardBootstrap();
  const mcpConnected = Boolean(bootstrap?.sync_health?.mcp_registered);
  const hasProjects = Boolean(bootstrap?.sync_health?.has_projects);
  // Two first-run surfaces would be noise. The sample-brief hero owns the
  // no-projects state (it already carries connect + import CTAs), so this strip
  // is scoped to the one case the hero can't cover: the user HAS a brief (e.g.
  // imported context) but never connected a live tool, so future sessions won't
  // auto-pick-it-up. That's the only reachable state — hence no mcpConnected
  // branch below (connected users are either set up or covered by the hero).
  // The rule, and why a 30-day-idle user is not first-run, lives in
  // lib/firstValueBanner so it can be tested as behaviour.
  const hasFirstSync = Boolean(bootstrap?.sync_health?.has_first_sync);
  if (!shouldShowFirstValueBanner({ isLoading, hasProjects, mcpConnected, hasFirstSync })) return null;

  return (
    <div className="shrink-0 border-b border-border-subtle bg-overlay-subtle px-6 py-3 max-sm:px-4 max-sm:py-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 max-sm:gap-x-3 max-sm:gap-y-1.5">
        <span className="text-xs font-semibold uppercase tracking-[0.12em] text-primary">
          Get started
        </span>
        <span className="text-sm text-text-secondary">
          Connect an AI tool so every new session picks up this brief automatically.
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Link
            href="/onboarding"
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary hover:bg-primary/90"
          >
            Connect a tool
          </Link>
          <Link
            href="/context/import"
            className="rounded-md border border-border-strong px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
          >
            Import context
          </Link>
        </div>
      </div>
    </div>
  );
}

// The Brief. One object, one page: the four slots your AI reads next session.
// The task board lives at /board and the context library at /memory — stacking
// all three here is what made this page read as twelve competing panels.
export default function ProjectsPage() {
  const [refreshToken] = useState(0);

  return (
    <>
      <Head><title>Projects | DeerDawn</title></Head>

      <div className="flex min-h-0 flex-1 flex-col">
        <FirstValueBanner />

        <div className="min-h-0 flex-1">
          <BriefWorkspace refreshToken={refreshToken} />
        </div>
      </div>
    </>
  );
}
