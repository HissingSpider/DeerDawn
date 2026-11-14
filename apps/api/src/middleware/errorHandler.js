/**
 * Centralized Error Handler
 *
 * Provides context-rich error responses without leaking sensitive information.
 * Maps different error types to appropriate HTTP status codes.
 */

const { captureException } = require('../services/errorReporting');
const { clientErrorStatus, clientErrorBody } = require('../utils/clientErrors');

/**
 * Application-specific error class for controlled errors
 */
class AppError extends Error {
    constructor(statusCode, errorCode, message, details = null) {
        super(message);
        this.statusCode = statusCode;
        this.errorCode = errorCode;
        this.details = details;
        this.isOperational = true;  // Distinguishes from programming errors
    }
}

/**
 * Main error handler middleware
 */
function errorHandler(err, req, res, _next) {
    // Build error context for logging (never sent to client)
    const errorContext = {
        request_id: req.id || req.headers['x-request-id'] || 'unknown',
        path: req.path,
        method: req.method,
        org_id: req.actor?.org_id || 'unauthenticated',
        user_agent: req.headers['user-agent'],
        timestamp: new Date().toISOString()
    };

    // --- Handle specific error types ---

    // 1. Payload too large
    //
    // This is the refusal a long end-of-session flush used to hit: the transcript
    // exceeded the limit, the CLI printed one stderr line nobody reads, and the
    // whole session's context was gone. A client can only trim to fit if the
    // refusal says what the cap is and what to do about it — a bare byte count is
    // a status, not an answer. Written for the human reading a log as much as for
    // the client parsing it.
    if (err.type === 'entity.too.large') {
        const kb = (bytes) => `${Math.floor(Number(bytes) / 1024)}KB`;
        const received = Number(err.length) > 0 ? ` The body received was ${kb(err.length)}.` : '';
        console.warn('[PAYLOAD_TOO_LARGE]', errorContext, { limit: err.limit ?? null, length: err.length ?? null });
        return res.status(413).json({
            error: 'payload_too_large',
            message: `Request body is too large for ${req.path} — the limit is ${kb(err.limit)}.${received}`
                + ' Trim it or split it into smaller requests; nothing in this request was stored.',
            limit_bytes: Number(err.limit) || null,
            received_bytes: Number(err.length) || null,
            request_id: errorContext.request_id
        });
    }

    // 2. JSON parsing errors
    if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
        return res.status(400).json({
            error: 'invalid_json',
            message: 'Request body contains invalid JSON.',
            request_id: errorContext.request_id
        });
    }

    // 3. Zod validation errors
    if (err.name === 'ZodError') {
        return res.status(400).json({
            error: 'validation_error',
            message: 'Request validation failed.',
            details: err.issues.map(e => ({
                field: e.path.join('.'),
                message: e.message
            })),
            request_id: errorContext.request_id
        });
    }

    // 4. Application errors (thrown intentionally)
    if (err instanceof AppError) {
        console.warn('[APP_ERROR]', errorContext, { code: err.errorCode, message: err.message });
        return res.status(err.statusCode).json({
            error: err.errorCode,
            message: err.message,
            details: err.details,
            request_id: errorContext.request_id
        });
    }

    // 5. Circuit breaker open
    if (err.message === 'Breaker is open' || err.code === 'ECIRCUITOPEN') {
        console.error('[CIRCUIT_BREAKER]', errorContext, 'Database circuit breaker is open');
        return res.status(503).json({
            error: 'service_unavailable',
            message: 'Service temporarily unavailable. Please retry shortly.',
            request_id: errorContext.request_id
        });
    }

    // 6. Database connection errors
    if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') {
        console.error('[DB_CONNECTION]', errorContext, err.message);
        return res.status(503).json({
            error: 'service_unavailable',
            message: 'Database connection failed. Please retry shortly.',
            request_id: errorContext.request_id
        });
    }

    // 7. PostgreSQL constraint violations
    if (err.code && err.code.startsWith('23')) {
        console.error('[DB_CONSTRAINT]', errorContext, { code: err.code, message: err.message });

        // 23505 = unique_violation
        if (err.code === '23505') {
            return res.status(409).json({
                error: 'conflict',
                message: 'A resource with this identifier already exists.',
                request_id: errorContext.request_id
            });
        }

        // 23503 = foreign_key_violation
        if (err.code === '23503') {
            return res.status(400).json({
                error: 'invalid_reference',
                message: 'Referenced resource does not exist.',
                request_id: errorContext.request_id
            });
        }

        // Generic constraint violation
        return res.status(400).json({
            error: 'constraint_violation',
            message: 'Database constraint violation.',
            request_id: errorContext.request_id
        });
    }

    // 8. Statement timeout
    if (err.code === '57014') {
        console.error('[DB_TIMEOUT]', errorContext, err.message);
        return res.status(503).json({
            error: 'timeout',
            message: 'Request timed out. Please retry.',
            request_id: errorContext.request_id
        });
    }

    // 9. Redis errors
    if (err.message && (err.message.includes('Redis') || err.message.includes('REDIS'))) {
        console.error('[REDIS_ERROR]', errorContext, err.message);
        return res.status(503).json({
            error: 'service_unavailable',
            message: 'Cache service unavailable. Please retry shortly.',
            request_id: errorContext.request_id
        });
    }

    // 10. Rate limit exceeded (should be handled by rate limiter, but as fallback)
    if (err.status === 429 || err.statusCode === 429) {
        return res.status(429).json({
            error: 'rate_limit_exceeded',
            message: 'Too many requests. Please slow down.',
            request_id: errorContext.request_id
        });
    }

    // 11. Deliberate client errors from the service layer.
    // A `publicMessage` means the service wrote this text FOR the caller — it's a
    // rejected input, not a defect. Classified here rather than route-by-route so
    // a route that forgets to catch its service's validation error still returns a
    // 4xx with the fix in it, instead of an opaque 500 that retrying clients
    // amplify and that lands in Error Tracking as a server bug. Deliberately above
    // the catch-all, and deliberately NOT captured as an exception.
    const clientStatus = clientErrorStatus(err);
    if (clientStatus) {
        console.warn('[CLIENT_ERROR]', errorContext, { code: err.message, status: clientStatus });
        return res.status(clientStatus).json(clientErrorBody(err, errorContext.request_id));
    }

    // --- Default: Unexpected error ---
    // Log error for debugging (never expose to client, never log stack traces)
    console.error('[UNHANDLED_ERROR]', errorContext, {
        name: err.name,
        message: err.message,
        code: err.code,
        // Never log stack traces as they can leak sensitive information
        // Use structured logging/monitoring tools to capture full errors securely
    });

    // Report the unexpected 500 to PostHog Error Tracking so real server bugs are
    // visible/alertable, not just buried in logs. Only the default catch-all —
    // the handled 4xx above (validation, conflict, rate limit) are client errors,
    // not defects worth an exception. Best-effort; never throws.
    captureException(err, {
        distinctId: req.actor?.user_id || req.actor?.org_id || 'anonymous',
        properties: {
            $exception_source: 'api_error_handler',
            path: errorContext.path,
            method: errorContext.method,
            request_id: errorContext.request_id,
            org_id: errorContext.org_id,
        },
    });

    // Generic response (no details leaked to client)
    res.status(500).json({
        error: 'internal_error',
        message: 'An unexpected error occurred.',
        request_id: errorContext.request_id
    });
}

/**
 * 404 handler for undefined routes
 */
function notFoundHandler(req, res) {
    console.warn('[NOT_FOUND]', {
        request_id: req.id || req.headers['x-request-id'] || 'unknown',
        path: req.path,
        method: req.method,
        referer: req.headers.referer || null,
        org_id: req.actor?.org_id || 'unauthenticated',
        user_agent: req.headers['user-agent'],
        timestamp: new Date().toISOString()
    });
    res.status(404).json({
        error: 'not_found',
        message: `Route ${req.method} ${req.path} not found.`,
        request_id: req.id || req.headers['x-request-id'] || 'unknown'
    });
}

module.exports = { errorHandler, notFoundHandler, AppError };
