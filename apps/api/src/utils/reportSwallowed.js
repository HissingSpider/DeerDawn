// ─── Errors that are handled, but shouldn't be invisible ─────────────────────
//
// The API reports two kinds of error well: anything that reaches next(err)
// (middleware/errorHandler.js) and anything uncaught (server.js). Both call
// captureException, and both work.
//
// (That captureException is services/errorReporting.js — Sentry — as of
// 2026-09-01. Which vendor is behind it is the least important thing on this
// page; the point below is about WHERE it is called from.)
//
// Neither covers the case that actually hurt. On 2026-08-30 four separate
// failures had been running silently for days to months, and not one of them
// threw:
//
//   - a cron deleted user projects, threw on the audit INSERT, and app.js's
//     `.catch(() => {})` absorbed it
//   - the Clerk user.deleted webhook 500'd on a foreign key for MONTHS, leaving
//     120 orphaned rows, and console.error'd each time
//   - _verifyClerk logged "syncUser failed" and returned null, 401ing the only
//     paying customer on every request for ~19 days
//   - the Stripe webhook's duplicate endpoint failed every delivery
//
// Each was caught, logged, and handled. That is why no error tracker saw them:
// they never reached one. Adding a vendor does not fix this — the errors have
// to be REPORTED at the point they are absorbed.
//
// This is that report. It is deliberately NOT a rethrow: these paths swallow
// for good reasons (a best-effort audit write should not abort a deletion, a
// failed token verify should 401 rather than 500). The handling stays; the
// silence goes.
//
// WHEN TO USE IT. Not on all ~50 `.catch(() => {})` sites — most are genuinely
// best-effort telemetry and should stay quiet, and reporting everything is the
// same as reporting nothing. Use it where the answer to this question is yes:
//
//     does this path change data, or gate access?
//
// A swallowed error in a cache warm is noise. A swallowed error in account
// deletion, authentication, billing, or a scheduled job that writes is an
// incident nobody has noticed yet.

const { captureException } = require('../services/errorReporting');

/**
 * Report an error that has been handled but must not disappear.
 *
 * @param {unknown} error       the caught error
 * @param {object}  context
 * @param {string}  context.op  what was being attempted, in stable snake_case
 *                              so occurrences group: 'ttl_expiry_audit_write',
 *                              'clerk_user_deleted_sync', 'clerk_token_sync'.
 *                              This is the fingerprint — keep it constant
 *                              across occurrences and put the varying detail
 *                              in `meta`.
 * @param {boolean} [context.destructive]  true when the path deletes or
 *                              overwrites user data. These are the ones worth
 *                              waking up for.
 * @param {object}  [context.meta]  extra properties (ids, counts). Never
 *                              secrets, never raw request bodies.
 */
function reportSwallowed(error, { op, destructive = false, meta = {} } = {}) {
    const err = error instanceof Error ? error : new Error(String(error));

    // Logged as well as captured, on purpose. The log line is what someone
    // greps at 2am when the dashboard is the thing that is broken.
    console.error(`[SWALLOWED] ${op}: ${err.message}`);

    captureException(err, {
        distinctId: 'api-server',
        properties: {
            $exception_source: 'swallowed',
            swallowed_op: op,
            swallowed_destructive: destructive,
            ...meta,
        },
    });
}

module.exports = { reportSwallowed };
