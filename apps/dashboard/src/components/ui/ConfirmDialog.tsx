import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Button } from './Button';

export type ConfirmOptions = {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive actions get the red confirm button. */
  destructive?: boolean;
};

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * Promise-based confirm — a themed, focus-trapped replacement for the native
 * window.confirm(). Usage mirrors the browser API so call sites stay tiny:
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: 'Delete?', destructive: true }))) return;
 */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within <ConfirmProvider>');
  return ctx;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((value: boolean) => void) | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    setOpts(options);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const close = useCallback((result: boolean) => {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setOpts(null);
  }, []);

  useEffect(() => {
    if (!opts) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button') ?? []);
    // Focus Cancel first — the safe default for a destructive prompt.
    focusables()[0]?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
        return;
      }
      if (e.key === 'Tab') {
        const f = focusables();
        if (f.length === 0) return;
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
  }, [opts, close]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {opts && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="dd-confirm-title"
          aria-describedby={opts.body ? 'dd-confirm-body' : undefined}
          onMouseDown={() => close(false)}
          className="fixed inset-0 z-[90] flex items-center justify-center bg-[rgba(3,7,18,0.72)] p-4 backdrop-blur-[12px]"
        >
          <div
            ref={dialogRef}
            onMouseDown={(e) => e.stopPropagation()}
            className="w-full max-w-[420px] rounded-2xl border border-border-subtle bg-surface-elevated p-6 shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
          >
            <h2 id="dd-confirm-title" className="m-0 text-lg font-semibold text-text-primary">
              {opts.title}
            </h2>
            {opts.body && (
              <p id="dd-confirm-body" className="mt-2 text-sm leading-relaxed text-text-secondary">
                {opts.body}
              </p>
            )}
            <div className="mt-6 flex items-center justify-end gap-3">
              <Button variant="secondary" size="sm" onClick={() => close(false)}>
                {opts.cancelLabel ?? 'Cancel'}
              </Button>
              <Button
                variant={opts.destructive ? 'danger' : 'primary'}
                size="sm"
                onClick={() => close(true)}
              >
                {opts.confirmLabel ?? 'Confirm'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
