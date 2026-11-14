import dynamic from 'next/dynamic';
import { SkeletonNetwork } from '@/components/dashboard/SkeletonNetwork';
import { ContextPanel } from '@/components/dashboard/ContextPanel';

// The context breakdown is a client-only tree; code-split it so it does not
// inflate the home page's first-load JS. The ghost SkeletonNetwork covers the
// brief window while the chunk downloads, then the real tree renders over it.
const ContextNetwork = dynamic(
  () => import('@/components/dashboard/ContextNetwork').then((m) => m.ContextNetwork),
  {
    ssr: false,
    loading: () => (
      <div className="h-full w-full">
        <SkeletonNetwork />
        <span className="sr-only" role="status">Loading your context…</span>
      </div>
    ),
  },
);

interface LibraryTabProps {
  onAddFromClaude: () => void;
  // Bumped after any brief mutation so the tree re-fetches.
  refreshToken: number;
}

// Thin wrapper that re-homes the two-pane body (the context breakdown + the
// Search/Documents ContextPanel) under the Library tab. The tree
// already handles mobile (stacks under the panel on small screens).
export function LibraryTab({ onAddFromClaude, refreshToken }: LibraryTabProps) {
  return (
    <div className="flex min-h-[60vh] overflow-hidden rounded-xl border border-border-subtle bg-overlay-subtle max-lg:flex-col">
      {/* Left — context breakdown (org-chart tree) */}
      <div className="min-h-[55vh] min-w-0 flex-1 overflow-hidden">
        <ContextNetwork onAddFromClaude={onAddFromClaude} refreshToken={refreshToken} />
      </div>

      {/* Right — Search / Documents (re-homed, not orphaned) */}
      <aside className="w-full shrink-0 border-border-subtle lg:w-[400px] lg:border-l max-lg:border-t">
        <ContextPanel />
      </aside>
    </div>
  );
}
