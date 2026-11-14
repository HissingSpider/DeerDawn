import React, { Component, ErrorInfo, ReactNode } from 'react';
import { captureException } from '@/lib/errorReporting';

/**
 * WHAT THIS FIXES: one render crash used to blank the entire dashboard.
 *
 * There was a single boundary, mounted in `_app.tsx` OUTSIDE ClerkProvider,
 * AuthProvider and Layout. So a throw anywhere — a `.map` on an undefined field
 * in one panel of one page — replaced the nav, the sidebar and every other
 * route with a full-screen apology. The two escapes it offered both dead-ended:
 * "Reload Page" re-mounted the same route and crashed again, and "Try Again"
 * cleared `hasError` so React re-rendered the identical tree with the identical
 * props, which threw on the same line before paint. A deterministic crash on
 * one page meant the whole app was unusable until the user typed a different
 * URL by hand — and nothing on screen told them that would work.
 *
 * TWO CHANGES:
 *
 *   1. `resetKey`. When it changes, the boundary clears itself. Layout passes
 *      the route, so navigating away actually recovers instead of carrying the
 *      error into the next page. Without this, scoping the boundary would make
 *      things WORSE: a crashed panel would stay crashed forever while the nav
 *      around it kept working.
 *
 *   2. `variant`. `inline` renders a panel and is mounted inside the shell
 *      (Layout), around the routed page only — so the sidebar survives and the
 *      user can click their way out. `page` is the original full-screen
 *      treatment, kept for the outermost boundary, where a provider died and
 *      there is genuinely no shell left to navigate with.
 *
 * COLOUR: every value routes through the theme layer. The old fallback
 * hard-coded `#EF4444`, `#0F3D2E`, `#4B5563` and friends, which is the
 * dark-first bug globals.css warns about — the error screen was the one surface
 * guaranteed to be seen on a bad day, and in light mode it was rendering
 * dark-surface colours on white.
 */

type Variant = 'page' | 'inline';

interface Props {
  children: ReactNode;
  /**
   * Full-screen (`page`, the default) or panel-sized (`inline`). Pick `inline`
   * for any boundary mounted inside the shell — the chrome around it is the
   * user's way out, and covering it up is the bug this component exists to fix.
   */
  variant?: Variant;
  /**
   * Change this to clear a caught error. Layout passes `router.asPath`, so a
   * navigation resets the boundary. Compared with `!==`, so pass a primitive.
   */
  resetKey?: string | number;
  /**
   * What this boundary wraps, for the crash report only ("dashboard_page",
   * "app_root"). Never rendered — the user does not need our component names.
   */
  label?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  /** A manual "Try again" was followed by another crash, so it cannot help. */
  retryFailed: boolean;
  /** Mirror of `props.resetKey`, so getDerivedStateFromProps can spot a change. */
  lastResetKey: string | number | undefined;
}

const SUPPORT_EMAIL = 'support@deerdawn.com';

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    retryFailed: false,
    lastResetKey: undefined,
  };

  /**
   * Instance field, not state: it must survive the `setState` that clears the
   * error, so that the NEXT crash can tell "first failure" from "the retry I
   * just offered did not work".
   */
  private retried = false;

  public static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  public static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey === state.lastResetKey) return null;
    // A new route (or whatever else the caller keys on). Drop the error rather
    // than rendering the previous page's crash on top of the next page.
    return { lastResetKey: props.resetKey, hasError: false, error: null, retryFailed: false };
  }

  public componentDidUpdate(prevProps: Props) {
    if (prevProps.resetKey !== this.props.resetKey) this.retried = false;
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
    // If we already offered a retry and landed back here, the crash is
    // deterministic. Say so instead of offering the same button again.
    if (this.retried && !this.state.retryFailed) this.setState({ retryFailed: true });
    // Report to Sentry. React swallows render crashes here, so automatic
    // capture never sees them — this is the only path that reports them.
    // `boundary` distinguishes "one page died" from "the whole app died", which
    // is the difference between a bug and an outage.
    captureException(error, {
      source: 'react_error_boundary',
      boundary: this.props.label || this.props.variant || 'page',
      componentStack: errorInfo.componentStack,
      page: typeof window !== 'undefined' ? window.location.pathname : undefined,
    });
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleReset = () => {
    this.retried = true;
    this.setState({ hasError: false, error: null });
  };

  private renderDetails() {
    if (process.env.NODE_ENV === 'production' || !this.state.error) return null;
    return (
      <details className="rounded-xl border border-border-subtle bg-overlay-subtle p-4 text-left">
        <summary className="cursor-pointer text-sm font-semibold text-status-danger">
          Error details (development only)
        </summary>
        <pre className="mt-3 overflow-auto font-mono text-xs leading-5 text-text-primary">
          {this.state.error.toString()}
          {'\n\n'}
          {this.state.error.stack}
        </pre>
      </details>
    );
  }

  private renderSupport() {
    return (
      <p className="text-sm text-text-muted">
        Need help? Contact{' '}
        <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary no-underline hover:underline">
          {SUPPORT_EMAIL}
        </a>
      </p>
    );
  }

  /**
   * Panel-sized. The shell around this is intact, so the copy says so and the
   * primary way out is the nav the user can already see — not a reload that
   * would throw away the rest of a working session.
   */
  private renderInline() {
    return (
      <div
        role="alert"
        className="rounded-2xl border border-status-danger/25 bg-[var(--status-deny-bg)] p-6"
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-base font-semibold text-status-danger">This page hit an error</h2>
            <p className="max-w-2xl text-sm leading-6 text-text-secondary">
              {this.state.retryFailed
                ? 'Retrying loaded the same error, so it is not a temporary glitch. The rest of '
                  + 'the dashboard is unaffected — pick another page from the sidebar, and we have '
                  + 'the crash report.'
                : 'Only this page failed to render. The rest of the dashboard still works, so you '
                  + 'can move on from the sidebar — or try this page again.'}
            </p>
          </div>
          {this.renderDetails()}
          <div className="flex flex-wrap items-center gap-3">
            {this.state.retryFailed ? null : (
              <button
                type="button"
                onClick={this.handleReset}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary transition-colors hover:bg-primary-hover"
              >
                Try again
              </button>
            )}
            <button
              type="button"
              onClick={this.handleReload}
              className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-text-secondary transition-colors hover:border-border-strong"
            >
              Reload the page
            </button>
          </div>
          {this.renderSupport()}
        </div>
      </div>
    );
  }

  /**
   * Full-screen. Reached only when something above the shell threw, so there is
   * no nav to point at and reloading really is the honest first move.
   */
  private renderPage() {
    return (
      <div
        role="alert"
        className="flex min-h-screen flex-col items-center justify-center bg-background px-6 py-12 text-text-primary"
      >
        <div className="w-full max-w-xl space-y-6 text-center">
          <div className="space-y-2">
            <h1 className="text-[28px] font-semibold tracking-[-0.04em] text-status-danger">
              Something went wrong
            </h1>
            <p className="text-[15px] leading-7 text-text-secondary">
              {this.state.retryFailed
                ? 'Retrying produced the same error, so reloading is the next thing to try. '
                  + 'The crash has been reported.'
                : 'The dashboard failed to start. Reloading usually clears it, and the crash has '
                  + 'been reported either way.'}
            </p>
          </div>
          {this.renderDetails()}
          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={this.handleReload}
              className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-on-primary transition-colors hover:bg-primary-hover"
            >
              Reload page
            </button>
            {this.state.retryFailed ? null : (
              <button
                type="button"
                onClick={this.handleReset}
                className="rounded-lg border border-border px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors hover:border-border-strong"
              >
                Try again
              </button>
            )}
          </div>
          {this.renderSupport()}
        </div>
      </div>
    );
  }

  public render() {
    if (!this.state.hasError) return this.props.children;
    return this.props.variant === 'inline' ? this.renderInline() : this.renderPage();
  }
}
