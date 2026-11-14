// Sentry first, above every other require: the SDK installs global handlers
// and patches modules as they load, so anything required above it is only
// partially covered. See src/instrument.js for why it does not touch OTel.
require('./instrument');

let shutdownTracing = async () => {};
try {
    ({ shutdownTracing } = require('./config/tracing'));
} catch (e) {
    console.warn('[BOOT] Tracing unavailable:', e.message);
}
const { createHttpTerminator } = require('http-terminator');
const app = require('./app');
const { PORT } = require('./config/env');
const { logLlmStatus } = require('./config/llm');
const { startScheduler, stopScheduler } = require('./jobs/scheduler');
const { runAutoMigration, runProjectRootMigration, backfillRefreshRecordWorkspaces } = require('./config/autoMigrate');
const { testConnection, pool } = require('./config/db');
const { redis } = require('./config/redis');
const { shutdownPostHog } = require('./services/posthog');
const { captureException, shutdownSentry } = require('./services/errorReporting');
const {
    setBootstrapStarting,
    setBootstrapReady,
    setBootstrapFailed,
} = require('./state/bootstrap');

let server;
let httpTerminator;
let isShuttingDown = false;

/**
 * Graceful shutdown handler
 * Ensures in-flight requests complete and resources are cleaned up
 */
async function gracefulShutdown(signal) {
    if (isShuttingDown) {
        console.log(`[SHUTDOWN] Already shutting down, ignoring ${signal}`);
        return;
    }
    isShuttingDown = true;
    console.log(`[SHUTDOWN] ${signal} received. Starting graceful shutdown...`);

    const shutdownTimeout = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '30000', 10);
    const forceExitTimer = setTimeout(() => {
        console.error('[SHUTDOWN] Forced exit after timeout');
        process.exit(1);
    }, shutdownTimeout);

    try {
        const logShutdownResults = (results) => {
            results.forEach((result) => {
                if (result.status === 'fulfilled') {
                    console.log(`[SHUTDOWN] ${result.value}`);
                } else {
                    console.error(`[SHUTDOWN] Error during shutdown: ${result.reason?.message || result.reason}`);
                }
            });
        };

        const shutdownPromises = [];

        // 0. Flush pending OpenTelemetry spans. Previously config/tracing.js did this from
        // its own SIGTERM handler and then called process.exit(0), killing the process
        // before the steps below could finish. It is now part of this sequence.
        shutdownPromises.push(shutdownTracing().then(() => 'Tracing flushed'));

        // 1. Stop accepting new connections and terminate existing ones
        console.log('[SHUTDOWN] Terminating HTTP server...');
        if (httpTerminator) {
            shutdownPromises.push(httpTerminator.terminate().then(() => 'HTTP server terminated'));
        }

        // 2. Stop scheduled jobs
        console.log('[SHUTDOWN] Stopping scheduler...');
        shutdownPromises.push(
            Promise.resolve().then(() => {
                stopScheduler();
                return 'Scheduler stopped';
            })
        );

        // 3. Close Redis connections
        console.log('[SHUTDOWN] Closing Redis connections...');
        if (redis) {
            shutdownPromises.push(redis.quit().then(() => 'Redis shared client closed'));
        }

        // 6. Close database pool
        console.log('[SHUTDOWN] Closing database pool...');
        if (pool) {
            shutdownPromises.push(pool.end().then(() => 'Database pool closed'));
        }

        // 7. Flush buffered PostHog product events
        console.log('[SHUTDOWN] Flushing PostHog...');
        shutdownPromises.push(shutdownPostHog());

        // 8. Flush buffered Sentry errors. Ordering is not a concern — these
        // run concurrently under Promise.allSettled — but the flush itself is:
        // an uncaughtException reports and THEN triggers this sequence, so
        // without it the last error before a crash is the one that never sends.
        console.log('[SHUTDOWN] Flushing Sentry...');
        shutdownPromises.push(shutdownSentry());

        // Execute all shutdown tasks concurrently and log their outcomes
        console.log('[SHUTDOWN] Awaiting all shutdown promises...');
        const results = await Promise.allSettled(shutdownPromises);
        logShutdownResults(results);

    } catch (error) {
        console.error('[SHUTDOWN] Unexpected error during shutdown wrapper:', error);
    } finally {
        clearTimeout(forceExitTimer);
        console.log('[SHUTDOWN] Graceful shutdown sequence complete.');
        // Exit with a failure code for exceptions, success code for signals.
        process.exit(signal === 'uncaughtException' ? 1 : 0);
    }
}

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Centralized error handling for critical process issues
process.on('uncaughtException', (err, origin) => {
    // Immediately log the critical error with more details
    console.error(`[FATAL] Uncaught exception from ${origin}:`, err);
    // Report to Sentry before shutdown flushes the client. Best-effort.
    captureException(err, { properties: { $exception_source: 'uncaughtException', origin } });

    // If not already shutting down, initiate a graceful shutdown.
    // This prevents shutdown race conditions.
    if (!isShuttingDown) {
        gracefulShutdown('uncaughtException');
    } else {
        // If an exception occurs *during* shutdown, force exit immediately.
        console.error('[FATAL] Exception occurred during shutdown. Forcing exit.');
        process.exit(1);
    }
});

process.on('unhandledRejection', (reason, promise) => {
    // Log loudly but DO NOT crash: rethrowing converts any stray un-awaited
    // promise anywhere in the codebase into a process death → platform 502
    // window. Unattended-operation posture: survive, log, investigate later.
    console.error('[FATAL] Unhandled rejection at:', promise, 'reason:', reason);
    // We survive these, so Sentry is the only durable signal — report every one.
    captureException(reason instanceof Error ? reason : new Error(String(reason)), {
        properties: { $exception_source: 'unhandledRejection' },
    });
});

async function startServer() {
    setBootstrapStarting();

    // Start listening immediately so the platform sees the bound port while
    // the app finishes bootstrapping its dependencies.
    server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`[BOOT] DD active on port ${PORT} (PID: ${process.pid})`);
        // One info line per hosted vendor that is off, once, here, rather than a
        // warning per request wherever it is first missed.
        require('./config/selfHosted').logVendorStatusOnce(console.info);
    });

    // One line saying which LLM endpoint extraction will use, or that it is off.
    logLlmStatus();

    httpTerminator = createHttpTerminator({ server });

    // Configure server timeouts for graceful shutdown
    server.keepAliveTimeout = 65000;  // Slightly higher than ALB's 60s
    server.headersTimeout = 66000;     // Slightly higher than keepAliveTimeout

    try {
        await testConnection();
        await runAutoMigration();
        startScheduler();
        setBootstrapReady();
        console.log('[BOOT] Runtime ready.');
        // Data repairs that scale with an account's history run AFTER readiness,
        // never inside the boot transaction: a slow one must not hold the boot
        // lock, fail a second machine's boot, or delay traffic. Not awaited.
        runProjectRootMigration().catch((err) => {
            console.error('[MIGRATE] project root re-key pass failed (retried next boot):', err.message);
        });
        // Projects whose author stamp is a key id that no longer resolves: re-stamped
        // when exactly one active member ever wrote to them. Batched, advisory-locked,
        // not awaited, never in a test process (services/authorStampService.js).
        require('./services/authorStampService').scheduleAuthorBackfill();
        backfillRefreshRecordWorkspaces().catch((err) => {
            console.error('[MIGRATE] refresh record workspace stamp failed (stamped on next refresh or boot):', err.message);
        });
    } catch (err) {
        setBootstrapFailed(err);
        console.error('[BOOT] Runtime bootstrap failed:', err);
        throw err;
    }
}

startServer().catch((err) => {
    console.error('[BOOT] Fatal startup failure:', err);
    gracefulShutdown('uncaughtException');
});
