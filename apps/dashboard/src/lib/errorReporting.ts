import * as Sentry from '@sentry/nextjs';

/**
 * The one place browser errors are reported from.
 *
 * Sentry replaced PostHog here on 2026-09-01. PostHog keeps product analytics
 * (and, on marketing, session replay); it no longer captures exceptions, so
 * every error has exactly one home and one issue history rather than two
 * half-populated ones.
 *
 * Automatic capture — window.onerror, unhandled rejections — is installed by
 * instrumentation-client.ts and needs no call site. This function exists for
 * the errors the browser never surfaces: React swallows render crashes inside
 * an error boundary, so componentDidCatch is the ONLY path that reports them.
 */
export function captureException(
  error: unknown,
  context: {
    /** Stable, low-cardinality label for grouping and filtering in Sentry. */
    source: string;
    /** Which boundary caught it — a page-level death is an outage, an inline one is a bug. */
    boundary?: string;
    /** React's component stack, shown in Sentry's dedicated React section. */
    componentStack?: string | null;
    /** Route the crash happened on. */
    page?: string;
  }
): void {
  const { source, boundary, componentStack, page } = context;

  Sentry.captureException(error, {
    tags: {
      error_source: source,
      ...(boundary ? { boundary } : {}),
      ...(page ? { page } : {}),
    },
    // Sentry renders contexts.react.componentStack as a first-class section
    // rather than burying the stack in a generic extras blob.
    ...(componentStack ? { contexts: { react: { componentStack } } } : {}),
  });
}
