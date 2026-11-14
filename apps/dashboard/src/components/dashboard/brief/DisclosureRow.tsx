import { useState } from 'react';

// Emphasis level 2: an object row. A hairline separator, no border, no fill —
// the cheapest containment there is. Secondary surfaces that used to sit on the
// page as full cards (the per-tool brief preview, the decision log) collapse
// into these, so the page's primary content is the only thing drawn as a card.
export function DisclosureRow({
  label,
  meta,
  children,
  defaultOpen = false,
}: {
  label: string;
  meta?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-t border-border-subtle last:border-b">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 py-3 text-left"
      >
        <span className="text-[13.5px] font-semibold text-text-primary">{label}</span>
        {meta && <span className="truncate text-[12.5px] text-text-muted">{meta}</span>}
        <span
          aria-hidden
          className={`ml-auto shrink-0 text-text-muted transition-transform ${open ? 'rotate-90' : ''}`}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
      </button>
      {open && <div className="pb-4">{children}</div>}
    </div>
  );
}
