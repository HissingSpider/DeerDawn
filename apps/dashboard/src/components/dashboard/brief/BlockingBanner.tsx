import { useEffect, useRef, useState } from 'react';

// How long the "Completed · Undo" window stays open before the clear is
// persisted. Undo-send style: we DON'T write to the server until this elapses,
// so hitting Undo in the window is a pure local no-op (no round-trip to revert).
const UNDO_WINDOW_MS = 4000;

interface BlockingBannerProps {
  text: string;
  // Persist the clear (PATCH blocking_issue → ''). Only fired once the undo
  // window closes without an undo. The parent owns the optimistic override +
  // re-fetch, which unmounts this banner on success and remounts it on failure.
  onComplete: () => void;
}

export function BlockingBanner({ text, onComplete }: BlockingBannerProps) {
  const [completed, setCompleted] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Belt-and-suspenders: never leave a timer running past unmount.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const complete = () => {
    setCompleted(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      onComplete();
    }, UNDO_WINDOW_MS);
  };

  const undo = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setCompleted(false);
  };

  if (completed) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] p-4">
        <span className="shrink-0 text-primary">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <path d="M8 12.5l2.5 2.5L16 9" />
          </svg>
        </span>
        <p className="min-w-0 flex-1 break-words text-[14px] leading-[1.55] text-text-primary line-through [overflow-wrap:anywhere]">
          {text}
        </p>
        <button
          onClick={undo}
          className="shrink-0 rounded-md border border-border-strong px-2.5 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary"
        >
          Undo
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 rounded-xl border border-red-500/25 bg-red-500/[0.06] p-4">
      <span className="mt-0.5 shrink-0 text-status-danger">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-status-danger">Blocking</p>
        <p className="mt-0.5 break-words text-[14px] leading-[1.55] text-text-primary [overflow-wrap:anywhere]">
          {text}
        </p>
      </div>
      <button
        onClick={complete}
        className="mt-0.5 shrink-0 rounded-md border border-emerald-500/30 px-2.5 py-1 text-[11px] font-medium text-primary transition-colors hover:border-emerald-500/50 hover:text-primary-hover"
      >
        Mark completed
      </button>
    </div>
  );
}
