const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');

const CLIENT_LOGS_SHARED_SECRET = process.env.CLIENT_LOGS_SHARED_SECRET;
const CLIENT_LOGS_SECRET_HEADER = 'x-client-logs-secret';
const ALLOWED_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const MAX_MESSAGE_LENGTH = 2000;
const MAX_URL_LENGTH = 2048;
const MAX_STRING_LENGTH = 2000;
const MAX_DEPTH = 4;
const MAX_ARRAY_LENGTH = 50;
const SENSITIVE_KEYS = new Set([
    'password',
    'pass',
    'token',
    'authorization',
    'cookie',
    'set-cookie',
    'api_key',
    'apikey',
    'secret',
    'ssn',
    'creditcard',
    'card',
    'access_token',
    'refresh_token'
]);

const secureCompare = (a, b) => {
    if (!a || !b) return false;
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
        crypto.timingSafeEqual(bufA, bufA);
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
};

const authenticateLogs = (req, res, next) => {
    if (CLIENT_LOGS_SHARED_SECRET) {
        const provided = req.headers[CLIENT_LOGS_SECRET_HEADER];
        if (secureCompare(String(provided || ''), CLIENT_LOGS_SHARED_SECRET)) {
            return next();
        }
        return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid client logs secret' });
    }

    return requireAuth(req, res, next);
};

const normalizeString = (value, maxLength) => {
    if (typeof value !== 'string') return null;
    if (!value.trim()) return null;
    if (value.length > maxLength) {
        return `${value.slice(0, maxLength)}…`;
    }
    return value;
};

const redactSensitive = (value, depth = 0, seen = new WeakSet()) => {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
        return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (value instanceof Date) return value.toISOString();

    if (Array.isArray(value)) {
        if (depth >= MAX_DEPTH) return '[Truncated]';
        return value.slice(0, MAX_ARRAY_LENGTH).map((entry) => redactSensitive(entry, depth + 1, seen));
    }

    if (typeof value === 'object') {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
        if (depth >= MAX_DEPTH) return '[Truncated]';
        return Object.entries(value).reduce((acc, [key, entry]) => {
            const normalizedKey = key.toLowerCase();
            if (SENSITIVE_KEYS.has(normalizedKey)) {
                acc[key] = '[REDACTED]';
            } else {
                acc[key] = redactSensitive(entry, depth + 1, seen);
            }
            return acc;
        }, {});
    }

    return String(value).slice(0, MAX_STRING_LENGTH);
};

// POST /api/v1/internal/logs
// Receives client-side errors from the dashboard/marketing sites
router.post('/', authenticateLogs, async (req, res) => {
    const { level, message, url, error, context, timestamp } = req.body;
    const normalizedLevel = typeof level === 'string' ? level.toLowerCase() : '';
    const normalizedMessage = normalizeString(message, MAX_MESSAGE_LENGTH);
    const normalizedUrl = url ? normalizeString(url, MAX_URL_LENGTH) : null;
    const normalizedTimestamp = timestamp
        ? normalizeString(String(timestamp), 64)
        : new Date().toISOString();

    if (!ALLOWED_LEVELS.has(normalizedLevel)) {
        return res.status(400).json({ error: 'invalid_payload', message: 'Invalid log level' });
    }

    if (!normalizedMessage) {
        return res.status(400).json({ error: 'invalid_payload', message: 'Message is required' });
    }

    const safeError = error ? redactSensitive(error) : null;
    const safeContext = context ? redactSensitive(context) : null;

    // In a real production app, you would send this to Sentry, Datadog, or Axiom.
    // For launch, we will log it to the server console so it shows up in 'fly logs'.
    const logPrefix = `[CLIENT-${normalizedLevel.toUpperCase()}]`;
    const urlSegment = normalizedUrl ? ` | URL: ${normalizedUrl}` : '';
    console.error(`${logPrefix} ${normalizedMessage}${urlSegment} | TS: ${normalizedTimestamp}`);
    
    if (safeError) {
        console.error(`${logPrefix} Error Details:`, JSON.stringify(safeError));
    }
    
    if (safeContext) {
        console.error(`${logPrefix} Context:`, JSON.stringify(safeContext));
    }

    res.status(204).end();
});

module.exports = router;
