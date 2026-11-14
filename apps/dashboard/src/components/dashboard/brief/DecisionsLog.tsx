import type { DecisionEntry } from '@/lib/api';
import { deriveItemTrust } from '@/lib/api';
import { ProvenanceBadge } from './ProvenanceBadge';
import { decisionsNewestFirst } from '@/lib/decisionLogOrder';

// The FULL decision log — including resolved decisions — with timestamps and
// importance. Distinct from the DECIDED slot (which shows only unresolved ones).
// Reads recent_decisions straight from the context JSON (with provenance).
export function DecisionsLog({ decisions }: { decisions: Array<DecisionEntry | string> }) {
  // Newest first, as the heading says: the stored list is appended to.
  const entries = decisionsNewestFirst((decisions || [])
    .map((d) => (typeof d === 'string' ? { summary: d } as DecisionEntry : d))
    .filter((d) => d.summary));

  if (!entries.length) return null;

  return (
    <section className="rounded-xl border border-border-subtle bg-overlay-subtle p-4">
      <header className="mb-3">
        <h3 className="text-[13px] font-semibold uppercase tracking-[0.1em] text-text-secondary">Decision log</h3>
        <p className="text-[11px] leading-tight text-text-muted">Every call on record, newest first.</p>
      </header>

      <ul className="space-y-2">
        {entries.map((d, i) => {
          const trust = deriveItemTrust(d);
          return (
            <li
              key={i}
              className={`rounded-lg border px-3 py-2.5 ${
                d.resolved ? 'border-border-subtle bg-overlay-subtle opacity-70' : 'border-border-subtle bg-overlay-subtle'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <p className={`break-words text-[13px] leading-[1.55] [overflow-wrap:anywhere] ${d.resolved ? 'text-text-muted line-through' : 'text-text-primary'}`}>
                  {d.summary}
                </p>
                {d.importance === 'critical' && (
                  <span className="shrink-0 rounded-full bg-red-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-status-danger">
                    Critical
                  </span>
                )}
                {d.importance === 'high' && (
                  <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-status-warning">
                    Important
                  </span>
                )}
              </div>
              {d.reasoning && (
                <p className="mt-1 break-words text-[11.5px] leading-[1.5] text-text-muted [overflow-wrap:anywhere]">
                  {d.reasoning}
                </p>
              )}
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <ProvenanceBadge trust={trust} />
                {d.resolved && (
                  <span className="text-[10px] uppercase tracking-[0.08em] text-text-muted">Resolved</span>
                )}
                {d.decided_at && <span className="text-[10px] text-text-muted">{formatDate(d.decided_at)}</span>}
                {d.source_tool && (
                  <span className="text-[10px] uppercase tracking-[0.08em] text-text-muted">{d.source_tool}</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
