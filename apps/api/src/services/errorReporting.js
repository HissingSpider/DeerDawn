// ─── The one place server errors are reported from ───────────────────────────
//
// Sentry replaced PostHog on this path on 2026-09-01. PostHog keeps product
// events (services/posthog.js) and its replay linkage; it no longer captures
// exceptions, so an error has exactly one home and one issue history instead of
// two half-populated ones.
//
// The signature is unchanged from the function this replaced, deliberately:
// every call site already passes { distinctId, properties } and those call
// sites are the load-bearing part. See utils/reportSwallowed.js for why the
// SET of call sites matters more than which vendor is behind them.
const Sentry = require('@sentry/node');

// Properties whose names are PostHog conventions. They stay in the call sites
// (changing ~10 of them buys nothing) but map onto Sentry's own concepts here,
// so issues group and filter the way Sentry expects rather than carrying a
// dollar-prefixed key into a generic extras blob.
const TAG_KEYS = new Set([
    '$exception_source',
    'swallowed_op',
    'swallowed_destructive',
    'path',
    'method',
]);

const TAG_NAMES = {
    $exception_source: 'error_source',
    swallowed_op: 'swallowed_op',
    swallowed_destructive: 'destructive',
};

/**
 * Report an exception.
 *
 * @param {unknown} error             the error, or anything throwable
 * @param {object}  [opts]
 * @param {string}  [opts.distinctId] actor id when known, else a server sentinel
 * @param {object}  [opts.properties] route, request_id, org_id, source…
 */
function captureException(error, { distinctId = 'api-server', properties = {} } = {}) {
    try {
        const err = error instanceof Error ? error : new Error(String(error));

        const tags = {};
        const extra = {};
        for (const [key, value] of Object.entries(properties)) {
            if (value === undefined || value === null) continue;
            if (TAG_KEYS.has(key)) {
                tags[TAG_NAMES[key] || key] = String(value);
            } else {
                extra[key] = value;
            }
        }

        Sentry.captureException(err, {
            tags,
            extra,
            // 'id' rather than an email or name: this is an internal actor id,
            // and sendDefaultPii is off in instrument.js.
            user: distinctId ? { id: String(distinctId) } : undefined,
        });
    } catch {
        // Telemetry is best-effort; never surface to the caller. A failure to
        // report must not become the error the caller sees.
    }
}

/**
 * Flush buffered events during graceful shutdown. Errors captured moments
 * before SIGTERM are exactly the ones worth keeping, and they are the ones an
 * un-flushed client drops.
 */
async function shutdownSentry() {
    try {
        await Sentry.flush(2000);
        return 'Sentry flushed';
    } catch (error) {
        return `Sentry flush failed: ${error.message}`;
    }
}

module.exports = { captureException, shutdownSentry };
