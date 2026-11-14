// ─── Sentry, initialised before anything else ────────────────────────────────
//
// This file must be required on the FIRST line of server.js, above every other
// require. The SDK installs global handlers and patches modules as they load,
// so anything required before it is only partially covered.
//
// WHY skipOpenTelemetrySetup. @sentry/node v8+ is built on OpenTelemetry and
// registers its own NodeSDK, TracerProvider, context manager and propagator by
// default. This API ALREADY registers one in config/tracing.js
// (@opentelemetry/sdk-node → OTLP exporter). Two SDKs racing to own the global
// tracer provider is not a merge; the second registration is ignored with a
// warning and whichever loses stops producing spans. Setting this tells Sentry
// to keep its hands off the OTel globals and leave tracing to config/tracing.js.
//
// WHY NO tracesSampleRate. Omitting it entirely is what disables tracing —
// setting it to 0 still initialises the tracing machinery and merely samples
// none of it. Sentry here is an ERROR tracker; spans stay with OpenTelemetry.
const Sentry = require('@sentry/node');

const dsn = process.env.SENTRY_DSN;

Sentry.init({
    dsn,
    // No DSN in local dev and in tests. Without this the SDK still installs
    // handlers and does per-error work with nowhere to send it.
    enabled: Boolean(dsn),
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    // Fly sets this per deploy; it is what ties an issue to the release that
    // introduced it and makes regressions visible as regressions.
    release: process.env.SENTRY_RELEASE || process.env.FLY_MACHINE_VERSION,
    skipOpenTelemetrySetup: true,
    // The API handles secrets, tokens and encrypted context. Sentry scrubs
    // common credential shapes server-side, but not sending request bodies and
    // headers in the first place is the stronger guarantee.
    sendDefaultPii: false,
    maxValueLength: 2048,
});

// Say so at boot, both ways. "Is error reporting actually on in production?"
// should be answerable by grepping the logs, not inferred from a secret being
// present in `fly secrets list` — a staged-but-never-deployed secret, a typo in
// the name, or an init that threw all look identical from the outside, and a
// silently-disabled error tracker is the exact failure this repo keeps finding
// the expensive way (see utils/reportSwallowed.js).
console.log(
    dsn
        ? `[BOOT] Sentry enabled (environment=${process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development'})`
        : '[BOOT] Sentry disabled — no SENTRY_DSN. Errors are logged but not reported.'
);

module.exports = Sentry;
