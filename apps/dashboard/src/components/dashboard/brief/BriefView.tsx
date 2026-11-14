import { useState } from 'react';
import type { BriefItem, BriefSpine, BriefSlotKind, ProjectContextJson, DecisionEntry } from '@/lib/api';
import { api, isSectionWithheld, withheldSectionLabels } from '@/lib/api';
import { showToast } from '@/components/ui/Toast';
import { logger } from '@/lib/logger';
import { BriefSlot } from './BriefSlot';
import { BlockingBanner } from './BlockingBanner';
import { WhatYourAiReadsPanel } from './WhatYourAiReadsPanel';
import { DecisionsLog } from './DecisionsLog';
import { DisclosureRow } from './DisclosureRow';
import type { BriefLineCallbacks } from './BriefLine';
import type { RefusedEdit } from '@/lib/briefEdits';

// All four slots render in the grid — landmines are the 4th card (amber-tinted
// via BriefSlot), so the 2×2 grid stays complete with no dangling empty cell.
const GRID_SLOTS: BriefSlotKind[] = ['shipped', 'decided', 'open', 'landmine'];

// Which context section backs each slot, so a slot can tell "never written"
// from "withheld from you". The names are the API's section keys.
const SLOT_SECTION: Record<BriefSlotKind, string> = {
  shipped: 'shipped',
  decided: 'recent_decisions',
  open: 'open_questions',
  landmine: 'landmines',
};

interface BriefViewProps {
  projectId: string;
  spine: BriefSpine;
  context: ProjectContextJson | null;
  callbacks: BriefLineCallbacks;
  busyKey: string | null;
  // Persist a cleared blocking issue (PATCH blocking_issue → '').
  onCompleteBlocking: () => void;
  // Edits refused because the brief changed underneath them: their text stays.
  refused?: RefusedEdit[];
  onRefusedSave?: (edit: RefusedEdit, now: BriefItem, text: string) => Promise<void> | void;
  onRefusedDiscard?: (edit: RefusedEdit) => void;
}

export function BriefView({
  projectId,
  spine,
  context,
  callbacks,
  busyKey,
  onCompleteBlocking,
  refused = [],
  onRefusedSave,
  onRefusedDiscard,
}: BriefViewProps) {
  const slotWithheld = (slot: BriefSlotKind) => isSectionWithheld(context, SLOT_SECTION[slot]);
  // A withheld slot counts as content for the grid: rendering the "no brief
  // content yet" panel over a project whose slots are merely withheld is the
  // exact confusion this is here to remove.
  const hasGridSlot = GRID_SLOTS.some(
    (s) => spine[s].length > 0 || slotWithheld(s) || refused.some((edit) => edit.slot === s),
  );
  const decisions = (context?.recent_decisions as Array<DecisionEntry | string>) || [];
  // WITHHELD IS NOT EMPTY. On somebody else's shared project the API hands back
  // only the sections the share policy allows, and everything else is simply
  // absent — which is exactly what an unwritten section looks like. Without
  // this, a teammate was told a busy project "doesn't have brief content yet",
  // and the natural reaction to that is to type the brief in again.
  const withheld = withheldSectionLabels(context);

  return (
    <div className="space-y-5">
      {/* Blocking issue — top-of-brief, can't-miss banner with mark-complete + undo. */}
      {context?.blocking_issue && (
        <BlockingBanner
          key={context.blocking_issue}
          text={context.blocking_issue}
          onComplete={onCompleteBlocking}
        />
      )}

      {/* The four slots ARE the page. Empty slots omit themselves. */}
      {hasGridSlot ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {GRID_SLOTS.map((slot) => (
            <BriefSlot
              key={slot}
              slot={slot}
              items={spine[slot]}
              busyKey={busyKey}
              withheld={slotWithheld(slot)}
              {...slotCallbacks(slot, callbacks)}
              {...(slot === 'shipped' ? {} : { refused, onRefusedSave, onRefusedDiscard })}
            />
          ))}
        </div>
      ) : withheld.length > 0 ? (
        <div className="rounded-xl border border-border-subtle bg-overlay-subtle p-6 text-center">
          <p className="text-sm text-text-secondary">
            Not shared with you: {withheld.join(', ')}.
          </p>
          <p className="mx-auto mt-1 max-w-md text-[12.5px] text-text-muted">
            These sections are withheld by this project&apos;s share policy, not empty. Ask its
            author to widen the share.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-border-subtle bg-overlay-subtle p-6 text-center">
          <p className="text-sm text-text-secondary">
            This project doesn&apos;t have brief content yet. Run a session in your AI tool and the
            slots fill in automatically — so you never start cold.
          </p>
        </div>
      )}

      {/* The slots rendered, but something is still being held back. Say so —
          a partial view that looks complete is the worse of the two failures. */}
      {hasGridSlot && withheld.length > 0 && (
        <p className="text-[12.5px] text-text-muted">
          Not shared with you: {withheld.join(', ')} — withheld by this project&apos;s share policy,
          not empty.
        </p>
      )}

      {/* Secondary surfaces, demoted from full cards to hairline rows. Nothing was
          removed — the per-tool preview and the full decision log are one click
          away instead of permanently occupying half the page. */}
      <div className="flex flex-col">
        <DisclosureRow label="What your AI reads next session" meta="the exact injected brief, per tool">
          <WhatYourAiReadsPanel projectId={projectId} />
        </DisclosureRow>

        {decisions.length > 0 ? (
          <DisclosureRow
            label="Full decision history"
            meta={`${decisions.length} on record, including resolved`}
          >
            <DecisionsLog decisions={decisions} />
          </DisclosureRow>
        ) : isSectionWithheld(context, 'recent_decisions') ? (
          // The row used to vanish outright, which reads as "this project has
          // never recorded a decision" — the opposite of the truth here.
          <DisclosureRow label="Full decision history" meta="not shared with you">
            <p className="px-1 py-3 text-[12.5px] leading-5 text-text-muted">
              This project&rsquo;s decisions are withheld by its share policy. They exist; they are
              just not part of what was shared with you.
            </p>
          </DisclosureRow>
        ) : null}

        <ExportRow />
      </div>
    </div>
  );
}

// Only DECIDED / OPEN / LANDMINE accept user mutations today (read-modify-write
// PATCH on their backing arrays). SHIPPED is structured-events only — it isn't
// hand-editable — so it gets no mutation callbacks.
function slotCallbacks(slot: BriefSlotKind, callbacks: BriefLineCallbacks): BriefLineCallbacks {
  if (slot === 'shipped') return {};
  return callbacks;
}

function ExportRow() {
  const [busy, setBusy] = useState(false);

  const run = async (format: 'json' | 'markdown') => {
    setBusy(true);
    try {
      await api.downloadContextExport(format);
      showToast(`Exported your brief as ${format === 'markdown' ? 'Markdown' : 'JSON'}.`, 'success');
    } catch (err) {
      logger.error('brief_export_failed', err);
      showToast('Export failed. Try again in a moment.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3 border-t border-border-subtle py-3">
      <span className="text-[13.5px] font-semibold text-text-primary">Export</span>
      <span className="text-[12.5px] text-text-muted">take the whole brief with you</span>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <button
          onClick={() => run('markdown')}
          disabled={busy}
          className="rounded-md border border-border-subtle px-2.5 py-1.5 text-[11px] font-medium text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary disabled:opacity-50"
        >
          .md
        </button>
        <button
          onClick={() => run('json')}
          disabled={busy}
          className="rounded-md border border-border-subtle px-2.5 py-1.5 text-[11px] font-medium text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary disabled:opacity-50"
        >
          .json
        </button>
      </div>
    </div>
  );
}
