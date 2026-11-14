import { useEffect, useRef, type ReactNode } from 'react';

type ModalProps = {
  open: boolean;
  onClose: () => void;
  /** id of the heading inside the modal, for aria-labelledby. */
  labelledById?: string;
  /** Accessible name when there is no single heading to point at. */
  ariaLabel?: string;
  /** Classes for the modal card (width, padding, radius, surface). */
  cardClassName?: string;
  /** Close when the backdrop is clicked. Defaults to true; pass false for
   *  deliberate nudges (e.g. the post-sync upgrade) that should only dismiss via
   *  an explicit action. Escape always closes for keyboard accessibility. */
  closeOnBackdrop?: boolean;
  /** z-index utility for the overlay. Modals default to z-[80]. */
  zClassName?: string;
  children: ReactNode;
};

const DEFAULT_CARD =
  'w-full max-w-[480px] rounded-[28px] border border-border-subtle bg-background p-7 shadow-[0_24px_80px_rgba(0,0,0,0.35)]';

/**
 * The one themed modal shell — a dimmed/blurred backdrop, a centered card, and
 * the dialog accessibility every overlay needs: role="dialog" + aria-modal,
 * focus moved into the card on open and restored on close, a focus trap, and
 * Escape-to-close. Card styling and content stay per-modal via cardClassName +
 * children, so adopting this changes behavior, not appearance.
 */
export function Modal({
  open,
  onClose,
  labelledById,
  ariaLabel,
  cardClassName,
  closeOnBackdrop = true,
  zClassName = 'z-[80]',
  children,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        ) ?? []
      ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1);

    // Move focus into the dialog (first focusable, else the card itself).
    (focusables()[0] ?? dialogRef.current)?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        const f = focusables();
        if (f.length === 0) {
          e.preventDefault();
          return;
        }
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className={`fixed inset-0 ${zClassName} flex items-center justify-center bg-[rgba(3,7,18,0.72)] p-4 backdrop-blur-[12px]`}
      onMouseDown={closeOnBackdrop ? onClose : undefined}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledById}
        aria-label={labelledById ? undefined : ariaLabel}
        onMouseDown={(e) => e.stopPropagation()}
        className={`outline-none ${cardClassName ?? DEFAULT_CARD}`}
      >
        {children}
      </div>
    </div>
  );
}
