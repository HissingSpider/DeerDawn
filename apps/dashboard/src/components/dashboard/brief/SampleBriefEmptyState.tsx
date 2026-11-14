import Link from 'next/link';
import type { BriefItem, BriefSlotKind } from '@/lib/api';
import { useDashboardBootstrap } from '@/components/dashboard/DashboardBootstrapProvider';
import { BriefSlot } from './BriefSlot';

// Zero-project users see a CALM sample brief — ONE line per slot so the shape of
// the product is legible at a glance without a wall of text. A single primary
// path plus one quiet secondary. Clearly labeled "Sample" so it's never mistaken
// for real data.
const SAMPLE: Record<BriefSlotKind, BriefItem[]> = {
  shipped: [
    { text: 'Brief-first dashboard redesign — the 4-slot brief now leads the home page.', trust: 'high', source_tool: 'claude_code', index: 0 },
  ],
  decided: [
    { text: 'Pricing is scope-based: free within a project, paid across projects.', trust: 'high', importance: 'high', index: 0 },
  ],
  open: [
    { text: 'Do we surface the brief diff per project, or workspace-wide?', trust: 'unverified', index: 0 },
  ],
  landmine: [
    { text: 'normalizeContextForSchema silently drops any field it doesn’t explicitly preserve.', trust: 'high', source_tool: 'codex', index: 0 },
  ],
};

const SLOT_ORDER: BriefSlotKind[] = ['shipped', 'decided', 'open', 'landmine'];

export function SampleBriefEmptyState() {
  const { bootstrap } = useDashboardBootstrap();

  // The onboarding checklist's definition of "connected", plus one thing it
  // deliberately does not count: a hosted connector that holds a credential but
  // has not called yet. ChatGPT exchanges its code at approve and first calls
  // when a chat uses the connector, so on that definition alone somebody who had
  // just connected landed here and was told to "Connect a tool" (2026-09-27).
  // Enough to stop asking for a step they have done; NOT enough to count as a
  // connection, which is why it stays out of connectionEvidence.
  const connectorAuthorized = Boolean(bootstrap?.sync_health?.connector_authorized);
  const connected = Boolean(
    (bootstrap?.setup_status?.runtime_verified_count ?? 0) > 0 ||
    (bootstrap?.setup_status?.verified_count ?? 0) > 0 ||
    bootstrap?.sync_health?.mcp_registered ||
    connectorAuthorized
  );
  const connectorName = connectorAuthorized ? bootstrap?.sync_health?.connector_client_name?.trim() || null : null;

  // The connection-reconciliation event used to fire here. It moved to
  // DashboardBootstrapProvider: this component renders only for accounts with no
  // projects, so it could never see a user who connected AND got a brief.

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-primary/20 bg-primary/[0.04] p-5 max-sm:p-4">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-primary">
          {connected ? (
            <>
              <span className="flex h-3 w-3 flex-shrink-0 items-center justify-center rounded-full bg-primary text-[8px] font-bold text-on-primary">✓</span>
              {connectorName ? `${connectorName} connected` : 'Tool connected'}
            </>
          ) : 'Sample brief'}
        </span>

        {connected ? (
          <>
            <h2 className="mt-3 text-xl font-semibold tracking-[-0.02em] text-text-primary max-sm:text-lg">
              Connected. Now give it something to read.
            </h2>
            {/* The gap this closes: connecting is not a trigger. A connected tool
                only loads a brief when the model calls start_session, and on an
                empty account start_session has nothing to return — so the user
                sees no change and concludes it didn't work. Saying both halves
                out loud is the fix. */}
            <p className="mt-2 max-w-xl text-sm leading-6 text-text-secondary">
              Your tool is wired to DeerDawn. It won’t brief itself, though: your AI loads the brief
              when it calls <code className="rounded-sm bg-overlay-strong px-[5px] py-px">start_session</code>,
              and right now there’s nothing saved for it to return. Import your project context and the
              next session opens briefed.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2.5">
              <Link
                href="/context/import"
                className="rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-on-primary no-underline hover:bg-primary/90"
              >
                Import your project context
              </Link>
              <Link
                href="/onboarding"
                className="text-[13px] font-medium text-text-secondary no-underline underline-offset-4 transition-colors hover:text-text-primary hover:underline"
              >
                or walk through setup again
              </Link>
            </div>
          </>
        ) : (
          <>
            <h2 className="mt-3 text-xl font-semibold tracking-[-0.02em] text-text-primary max-sm:text-lg">
              Never start cold.
            </h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-text-secondary">
              This is what your AI reads at the start of every session. Connect a tool and your real
              brief replaces this sample.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2.5">
              <Link
                href="/onboarding"
                className="rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-on-primary no-underline hover:bg-primary/90"
              >
                Connect a tool
              </Link>
              <Link
                href="/context/import"
                className="text-[13px] font-medium text-text-secondary no-underline underline-offset-4 transition-colors hover:text-text-primary hover:underline"
              >
                or import existing context
              </Link>
            </div>
          </>
        )}
      </div>

      {/* One line per slot — a light preview, not a wall. Rendered with the real
          slot components so it reads exactly like a live brief — which is exactly
          why it goes once a tool is connected. It is there to show the shape of
          the product before somebody connects; after, invented "verified" lines
          under their own account read as data that was already loaded
          (2026-09-27, reported from a fresh ChatGPT signup). */}
      {!connected && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2" aria-label="Sample brief preview">
          {SLOT_ORDER.map((slot) => (
            <BriefSlot key={slot} slot={slot} items={SAMPLE[slot]} />
          ))}
        </div>
      )}
    </div>
  );
}
