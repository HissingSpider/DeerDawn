import * as Sentry from '@sentry/nextjs';

/**
 * Next.js loads this once per runtime, before any route code. The server and
 * edge Sentry clients are imported here rather than at module scope so each
 * runtime only pulls the SDK build it can actually run.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('../sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

// Reports errors thrown inside getServerSideProps / API routes / RSC, which
// otherwise never reach the client SDK.
export const onRequestError = Sentry.captureRequestError;
