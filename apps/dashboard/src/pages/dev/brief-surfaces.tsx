import { useState } from 'react';
import { BriefSlot } from '@/components/dashboard/brief/BriefSlot';
import { TaskBoard } from '@/components/dashboard/brief/TaskBoard';
import { CountCard } from '@/pages/portfolio';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import type { BriefItem, BriefSlotKind, ProjectContextJson } from '@/lib/api';

/**
 * Dev-only visual harness for the brief surfaces — <BriefSlot>, <TaskBoard> and
 * the portfolio <CountCard> — rendered against BOTH palettes at once so a colour
 * that only works on one ground is visible side by side rather than from memory.
 *
 * This exists because raw-palette classes with no light-mode value shipped
 * unnoticed (TaskBoard's per-lane accents, BriefSlot's slot accents). Measured
 * here, those ran 6.6-12.8:1 on the dark ground and 1.4-2.7:1 on the light one;
 * they are now theme tokens and every one of them clears 4.5:1 in both panes.
 * Keep using it that way: anything that reads clearly in one pane and washes out
 * in the other is a token missing from globals.css, not an artefact of this page.
 *
 * Reached at /dev/brief-surfaces. Rendered outside Layout AND outside
 * AuthProvider via the /dev/ bypass in _app.tsx, so it needs no session and no
 * API; 404'd in production by getServerSideProps below.
 *
 * Two limits worth knowing:
 *  - Writes are real. TaskBoard PATCHes the API on every drag/add/remove, so
 *    with no API on :8080 each one rolls back with an error toast. That is the
 *    honest error path, not a broken harness — the toast itself is worth a look.
 *  - Toasts render at the app root, outside both scopes, so they follow the
 *    document theme (the toggle in the header), not the pane they came from.
 */

// Pin a subtree to one palette. The scope classes are declared alongside the
// real :root selectors in globals.css, so these panes cannot drift from what
// ships — see the Theming block there.
function ThemePane({ theme, children }: { theme: 'light' | 'dark'; children: React.ReactNode }) {
  return (
    <div className={`theme-scope-${theme} min-w-0 flex-1 rounded-xl border border-border-subtle bg-background p-4`}>
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">{theme}</p>
      {children}
    </div>
  );
}

// Render the same element once per palette. `children` is a factory rather than
// a node so each pane gets its own component instances — the surfaces here hold
// local state (collapsed slots, expanded lanes, open dialogs) and sharing one
// element would make the two panes fight over it.
function Pair({ title, note, children }: { title: string; note?: string; children: () => React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
        {note ? <p className="mt-0.5 text-[12px] text-text-muted">{note}</p> : null}
      </div>
      <div className="flex gap-4 max-lg:flex-col">
        <ThemePane theme="light">{children()}</ThemePane>
        <ThemePane theme="dark">{children()}</ThemePane>
      </div>
    </section>
  );
}

// One item per trust level so all three ProvenanceBadge variants are on screen.
const SLOT_ITEMS: Record<BriefSlotKind, BriefItem[]> = {
  shipped: [
    { text: 'Dev previews now bypass AuthProvider, so /dev/* renders without a session.', trust: 'high', shipped_at: '2026-08-29', index: 0 },
    { text: 'Task card bodies land behind a marker instead of printing on the board.', trust: 'inferred', shipped_at: '2026-08-28', index: 1 },
  ],
  decided: [
    { text: 'Board phases stay six lanes — no per-project columns.', trust: 'high', decided_at: '2026-08-27', index: 0 },
    { text: 'Light mode is device-driven with a sticky override, not a per-page setting.', trust: 'unverified', decided_at: '2026-08-20', index: 1 },
  ],
  // Four items so the PREVIEW_COUNT=3 "1 more" expander is exercised.
  open: [
    { text: 'Does the portfolio count decisions per project or per canonical key?', trust: 'inferred', added_at: '2026-08-29', index: 0 },
    { text: 'Should a step card be draggable once its parent task closes?', trust: 'unverified', added_at: '2026-08-28', index: 1 },
    { text: 'Do we surface Trails redaction findings inline or on a preview screen?', trust: 'unverified', added_at: '2026-08-26', index: 2 },
    { text: 'Which slot owns an answered question — Open, or Decided?', trust: 'inferred', added_at: '2026-08-25', index: 3 },
  ],
  landmine: [
    { text: 'Completing a card while Done is at its cap destroys it and reports success.', trust: 'high', added_at: '2026-08-29', index: 0 },
    { text: 'A context_graph_* join on an unindexed column scans every owner and trips the 8s breaker.', trust: 'high', added_at: '2026-08-22', index: 1 },
  ],
};

// Every lane occupied, plus the two card variants the board renders specially:
// one with a body (marker shown) and one derived step card (read-only, dashed).
const BOARD_CONTEXT: ProjectContextJson = {
  project_id: 'dev-preview',
  project_name: 'Dev preview',
  updated_at: '2026-08-29T12:00:00.000Z',
  todo_items: [
    { id: 'c1', title: 'A card long enough to wrap onto three lines in a narrow lane', phase: 'backlog', created_at: '2026-08-29T09:00:00.000Z' },
    { id: 'c2', title: 'Short card', phase: 'backlog', created_at: '2026-08-29T09:05:00.000Z' },
    { id: 'c3', title: 'Third backlog card, to exercise the "+1 more" collapse', phase: 'backlog', created_at: '2026-08-29T09:06:00.000Z' },
    { id: 'c4', title: 'Waiting on the API deploy for the write-path fixes', phase: 'blocked', created_at: '2026-08-28T14:00:00.000Z' },
    {
      id: 'c5',
      title: 'Ship the /dev/ AuthProvider bypass',
      phase: 'in_progress',
      body: 'A card with a body renders a marker on the board and reads in the dialog — click it to check the modal against this pane.\n\nThe body is clipped, never rejected, at 2,000 characters.',
      created_at: '2026-08-29T10:00:00.000Z',
    },
    { id: 'c6', title: 'Merge the connectCopy parity test', phase: 'integration', created_at: '2026-08-27T11:00:00.000Z' },
    { id: 'c7', title: 'Verify light mode on the task board', phase: 'testing', created_at: '2026-08-29T11:00:00.000Z' },
    { id: 'c8', title: 'Wire the frontend suites into CI', phase: 'done', created_at: '2026-08-20T08:00:00.000Z', completed_at: '2026-08-26T16:30:00.000Z' },
  ],
  task_steps: [{ name: 'Confirm the harness renders without a session', status: 'in_progress' }],
};

export default function BriefSurfacesPreview() {
  // Re-mount every surface so an edited slot / dragged card / open dialog can be
  // put back without a page reload.
  const [key, setKey] = useState(0);

  // BriefSlot only shows its per-line actions when at least one callback is
  // supplied, so pass no-ops — the affordances are part of what we're eyeballing.
  const noopCallbacks = {
    onEdit: () => {},
    onDismiss: () => {},
    onPin: () => {},
    onCorrect: () => {},
    onAnswer: () => {},
  };

  return (
    <div className="min-h-full bg-background px-6 py-10 text-text-primary">
      <div className="mx-auto flex max-w-6xl flex-col gap-10">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">Dev preview</p>
            <h1 className="mt-1 text-xl font-semibold text-text-primary">Brief surfaces — light vs dark</h1>
            <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-text-muted">
              Each surface is rendered twice, pinned to each palette. The toggle changes only this page&rsquo;s
              chrome and the toasts — the two panes below always show both.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <button
              onClick={() => setKey((k) => k + 1)}
              className="rounded-md border border-border-strong px-2.5 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:text-text-primary"
            >
              Reset
            </button>
          </div>
        </header>

        <Pair
          title="BriefSlot"
          note="All four slots. Decided and Open were sky-400 / violet-400 (2.07 and 2.70:1 on light); they now read 5.63 and 6.74."
        >
          {() => (
            <div key={key} className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              {(Object.keys(SLOT_ITEMS) as BriefSlotKind[]).map((slot) => (
                <BriefSlot key={slot} slot={slot} items={SLOT_ITEMS[slot]} {...noopCallbacks} />
              ))}
            </div>
          )}
        </Pair>

        <Pair
          title="TaskBoard"
          note="Every lane occupied, one card with a body, one derived step card. Backlog / Integration / Testing were 1.41, 1.58 and 1.76:1 on light; they now read 7.18, 5.63 and 6.74. Drags and adds PATCH the API and roll back when it is not running."
        >
          {() => (
            <TaskBoard key={key} projectId="dev-preview" context={BOARD_CONTEXT} onMutated={() => {}} />
          )}
        </Pair>

        <Pair title="TaskBoard — empty" note="The zero-card state, which routes through EmptyBoard rather than the lanes.">
          {() => <TaskBoard key={key} projectId="dev-preview" context={null} onMutated={() => {}} />}
        </Pair>

        <Pair title="Portfolio CountCard" note="bg-surface on bg-background — the pair that goes flat when surface and background converge.">
          {() => (
            <div key={key} className="grid grid-cols-3 gap-3">
              <CountCard label="Projects" value={7} />
              <CountCard label="Decisions" value={142} />
              <CountCard label="Shared entities" value={0} />
            </div>
          )}
        </Pair>
      </div>
    </div>
  );
}

// Never ship this route to production.
export async function getServerSideProps() {
  if (process.env.NODE_ENV === 'production') {
    return { notFound: true };
  }
  return { props: {} };
}
