'use strict';

const { MCP_RESOURCE_PATH, CLAUDE_MCP_RESOURCE_PATH, LEGACY_MCP_RESOURCE_PATHS } = require('../config/mcpResource');
const { selfHostedPlainHttp, selfHostedHttpsRefusal } = require('../config/selfHosted');

// Fail closed instead of redirecting authenticated MCP/OAuth requests over an
// insecure transport. Redirects can forward bearer credentials to an
// unintended origin; clients should reconnect to the advertised HTTPS URL.
// Production only.
//
// A self-hosted install (SELF_HOSTED=true) differs in one way: plain HTTP to
// localhost is accepted everywhere, and plain HTTP to any other host is
// refused on every route but the health checks, with a message saying how to
// set up HTTPS (config/selfHosted.js). Hosted is unchanged.
const HEALTH_PATH = /^\/(healthz|health)(\/|$)/;

function transportGuard(req, res, next) {
    if (process.env.NODE_ENV !== 'production') return next();
    const selfHostedHttp = selfHostedPlainHttp(req);
    if (selfHostedHttp === 'local') return next();
    if (selfHostedHttp === 'remote' && !HEALTH_PATH.test(req.path)) {
        return res.status(400).json(selfHostedHttpsRefusal(req));
    }
    const sensitivePath = req.path === MCP_RESOURCE_PATH
        || req.path === CLAUDE_MCP_RESOURCE_PATH
        || LEGACY_MCP_RESOURCE_PATHS.includes(req.path)
        || req.path.startsWith('/api/v1/oauth/')
        || req.path.startsWith('/.well-known/oauth-');
    if (!sensitivePath) return next();
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (req.secure || forwardedProto === 'https') return next();
    return res.status(400).json({ error: 'https_required', message: 'MCP and OAuth requests require HTTPS.' });
}

module.exports = { transportGuard };
