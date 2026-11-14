import * as Sentry from '@sentry/nextjs';

// Node runtime: the dashboard's getServerSideProps and /api routes.
// tracesSampleRate is deliberately unset — errors only.
const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV,
});
