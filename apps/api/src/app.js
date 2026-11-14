const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const app = express();

const requestId = require('./middleware/requestId');
const latency = require('./middleware/latency');
const { reportSwallowed } = require('./utils/reportSwallowed');
const { apiLimiter, authLoginLimiter, authSignupLimiter, mcpAuthLimiter, mcpDevicePollLimiter, oauthSharedEgressLimiter, mcpToolLimiter, mcpUnauthenticatedIpLimiter, leadsLimiter, webhookLimiter } = require('./middleware/rateLimit');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const auditAccess = require('./middleware/auditAccess');

// ─── Route Imports ────────────────────────────────────────────────────────────

// Infrastructure / health
const healthRoutes = require('./routes/health');
const logsRoutes = require('./routes/logs');
const docsRoutes = require('./routes/docs');
const { router: debugRoutes } = require('./routes/debug');
const leadsRoutes = require('./routes/leads');
const emailRoutes = require('./routes/email');
const adminContentRoutes = require('./routes/admin-content');
const publicContentRoutes = require('./routes/public-content');
const stripeWebhookRoutes = require('./routes/webhooks-stripe');
const authWebhookRoutes = require('./routes/auth-webhooks');
const resendWebhookRoutes = require('./routes/webhooks-resend');

// Shared (auth, billing, org management, API keys)
const authRoutes = require('./routes/shared/auth');
const mcpAuthRoutes = require('./routes/shared/mcp-auth');
const orgRoutes = require('./routes/shared/orgs');
const billingRoutes = require('./routes/shared/billing');
const metricsRoutes = require('./routes/shared/metrics');
const teamRoutes = require('./routes/shared/teams');
const keyRoutes = require('./routes/shared/keys');
const onboardingRoutes = require('./routes/shared/onboarding');
const dashboardRoutes = require('./routes/shared/dashboard');
const productEventsRoutes = require('./routes/shared/product-events');

// Context sync (extraction, graph, injection)
const contextSyncRoutes = require('./routes/context/context-sync');
const contextDashboardRoutes = require('./routes/context/context-dashboard');
const contextIntegrationsRoutes = require('./routes/context/integrations');
const contextUserscriptRoutes = require('./routes/context/userscript');
const mcpRoutes = require('./routes/mcp');
const a2aRoutes = require('./routes/a2a');
const oauthRoutes = require('./routes/oauth');
const { MCP_RESOURCE_PATH, CLAUDE_MCP_RESOURCE_PATH, LEGACY_MCP_RESOURCE_PATHS } = require('./config/mcpResource');
const { transportGuard } = require('./middleware/transportGuard');
const { A2A_BASE_PATH } = require('./config/agentCard');
const {
    DEFAULT_JSON_BODY_LIMIT,
    TRAIL_JSON_BODY_LIMIT,
    EXTRACTION_JSON_BODY_LIMIT,
    EXTRACTION_BODY_PATH,
} = require('./config/bodyLimits');

const prometheus = require('prom-client');
const ipaddr = require('ipaddr.js');
const { flushBackupAuditLogs } = require('./utils/auditLogger');
const { getBootstrapState } = require('./state/bootstrap');

// Periodically flush any audit logs that failed to write to DB (backed up in Redis).
// unref() so this timer doesn't prevent the process from exiting (e.g. in tests).
setInterval(() => flushBackupAuditLogs().catch(() => {}), 5 * 60 * 1000).unref();

// Daily TTL expiry sweep — deletes context for users who set a ttl_days security preference.
//
// The empty catch that used to be here hid a real failure for as long as the
// job has existed: the DELETE succeeded, the audit INSERT after it threw on a
// NOT NULL audit_id, and nothing recorded that user data had been erased with
// no audit trail — or that the loop aborted before the remaining owners.
// A scheduled job that deletes must never fail quietly.
const { expireContext } = require('../scripts/expire-context');
setInterval(() => {
    expireContext().catch((err) => reportSwallowed(err, {
        op: 'ttl_expiry_sweep',
        destructive: true,
    }));
}, 24 * 60 * 60 * 1000).unref();

// Initialize Metrics
const register = new prometheus.Registry();
prometheus.collectDefaultMetrics({ register });
const contextActiveLatencyMs = new prometheus.Histogram({
    name: 'context_active_route_duration_ms',
    help: 'Latency of GET /api/v1/context/active',
    labelNames: ['method', 'status_code'],
    buckets: [50, 100, 250, 500, 750, 1000, 2000, 5000, 10000],
    registers: [register],
});
const mcpRequestDurationMs = new prometheus.Histogram({
    name: 'mcp_request_duration_ms',
    help: 'Remote MCP request latency by JSON-RPC method and status',
    labelNames: ['rpc_method', 'status_code'],
    buckets: [25, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000],
    registers: [register],
});
const mcpRequestsTotal = new prometheus.Counter({
    name: 'mcp_requests_total',
    help: 'Remote MCP requests by JSON-RPC method and status',
    labelNames: ['rpc_method', 'status_code'],
    registers: [register],
});
const mcpRequestsInFlight = new prometheus.Gauge({
    name: 'mcp_requests_in_flight',
    help: 'Remote MCP requests currently being processed by this instance',
    registers: [register],
});

function observeMcpRequest(req, res, next) {
    const method = typeof req.body?.method === 'string' && /^[a-z/]+$/i.test(req.body.method)
        ? req.body.method.slice(0, 40)
        : 'unknown';
    const end = mcpRequestDurationMs.startTimer({ rpc_method: method });
    mcpRequestsInFlight.inc();
    let observed = false;
    const observe = () => {
        if (observed) return;
        observed = true;
        const status = String(res.statusCode);
        end({ status_code: status });
        mcpRequestsTotal.inc({ rpc_method: method, status_code: status });
        mcpRequestsInFlight.dec();
    };
    res.once('finish', observe);
    res.once('close', observe);
    next();
}

// Task: Production Proxy Trust
// Expected proxy setup: exactly one trusted proxy (e.g. Fly/ALB/Ingress) that sets X-Forwarded-For.
// Do NOT add additional untrusted hops without adjusting the trust proxy setting.
// SECURITY: Configure via TRUST_PROXY_HOPS env var (default: 1 for Fly.io)
app.set('trust proxy', parseInt(process.env.TRUST_PROXY_HOPS || '1', 10));

// Global Middleware - Security Headers
app.use(helmet({
    // SECURITY: Strict CSP - no unsafe-inline to prevent XSS
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ['\'none\''],
            scriptSrc: ['\'self\''],
            styleSrc: ['\'self\''],
            imgSrc: ['\'self\'', 'data:'],
            connectSrc: ['\'self\'', 'https://api.clerk.com', 'https://*.stripe.com'],
            frameAncestors: ['\'none\''],
            formAction: ['\'self\''],
            baseUri: ['\'self\'']
        }
    },
    // SECURITY: HSTS - force HTTPS with preload
    hsts: {
        maxAge: 31536000, // 1 year
        includeSubDomains: true,
        preload: true
    },
    // Additional security headers
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    noSniff: true,
    xssFilter: true,
    hidePoweredBy: true
}));

// Task: Production CORS Gating
const normalizeUrl = (url) => url ? url.toLowerCase().replace(/\/$/, '') : '';

// Browser-hosted MCP clients usually call from provider infrastructure without
// an Origin header, but their interactive/browser transports may preflight.
// Keep the known GA hosts explicit and allow operators to extend the list
// without a deploy when a provider introduces another documented origin.
const mcpClientOrigins = (process.env.MCP_CLIENT_ORIGINS || 'https://claude.ai,https://chatgpt.com,https://chat.openai.com')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

const allowedOrigins = [
    process.env.DASHBOARD_URL, // Dashboard domain
    process.env.MARKETING_URL, // Marketing domain
    // A self-hosted install's own origin. selfHostedPublicUrl is '' on hosted,
    // so a stray PUBLIC_URL there widens nothing.
    require('./config/selfHosted').selfHostedPublicUrl(),
    'https://app.deerdawn.com', // Explicit production dashboard
    'https://deerdawn.com',     // Production marketing root
'https://www.deerdawn.com', // Production marketing www
    'http://localhost:3000',   // Local dashboard
    'http://localhost:3001',   // Local marketing
    'http://localhost:3002',   // Local dashboard alternate port
    'http://localhost:3003',   // Local dashboard second alternate (parallel sessions)
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    'http://127.0.0.1:3002',
    'http://127.0.0.1:3003',
    ...mcpClientOrigins,
]
    .filter(Boolean)
    .map(normalizeUrl);

app.use(cors({
    origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
        if (!origin) return callback(null, true);
    
        const normalizedOrigin = normalizeUrl(origin);

        // Check against explicit allowed origins only — no subdomain wildcards
        let isAllowed = allowedOrigins.includes(normalizedOrigin);

        // For local development, use explicit localhost check
        if (process.env.ALLOW_LOCALHOST === 'true' &&
            ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002', 'http://localhost:3003', 'http://127.0.0.1:3000', 'http://127.0.0.1:3001', 'http://127.0.0.1:3002', 'http://127.0.0.1:3003', 'http://localhost:8080', 'http://127.0.0.1:8080'].includes(normalizedOrigin)) {
            isAllowed = true;
        }

        if (isAllowed) {
            callback(null, true);
        } else {
            // This will show up in 'fly logs' to help the user debug
            console.warn(`[CORS REJECTED] Origin: "${origin}" | Normalized: "${normalizedOrigin}" | Allowed: ${JSON.stringify(allowedOrigins)}`);
            callback(null, false);
        }
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Api-Key',
        'X-Request-Id',
        'X-CSRF-Token',
        'MCP-Protocol-Version',
        'MCP-Session-Id',
        'Last-Event-ID',
        // The explicit workspace override. apps/dashboard/src/lib/api.ts has been
        // sending it since the switcher shipped, but a header absent from this
        // list fails the preflight, and the dashboard is cross-origin
        // (app.deerdawn.com -> api.deerdawn.com) — so the one deliberate way to
        // name a workspace from a browser never left the browser.
        'x-deerdawn-workspace',
    ],
    // x-deerdawn-workspace-fallback says this response was served by the
    // caller's PERSONAL workspace because the one the request was bound to is
    // refusing on billing grounds. It was being set and never exposed, so the
    // browser dropped it: the dashboard had no way to know that what it was
    // showing came from somewhere other than the workspace its own switcher
    // named.
    exposedHeaders: ['MCP-Session-Id', 'WWW-Authenticate', 'Retry-After', 'x-deerdawn-workspace-fallback'],
    credentials: true
}));

// Prevent caching of CORS-allowed cross-origin responses
// Intermediary caches must not serve CORS responses to other origins
app.use((req, res, next) => {
    if (req.headers.origin) {
        res.set('Cache-Control', 'no-store');
    }
    next();
});

// Metrics endpoint - Protected
// SECURITY: Metrics can expose org_ids, protect with token or IP allowlist
const { secureCompare } = require('./utils/security');
const METRICS_TOKEN = process.env.METRICS_TOKEN;
const METRICS_ALLOWED_IPS = (process.env.METRICS_ALLOWED_IPS || '127.0.0.1,::1')
    .split(',')
    .map(ip => ip.trim())
    .filter(Boolean);

const normalizeIp = (value) => {
    if (!value) return '';
    const trimmed = value.trim();
    if (!ipaddr.isValid(trimmed)) return trimmed;
    return ipaddr.process(trimmed).toString();
};

const getClientIp = (req) => {
    const forwardedFor = req.headers['x-forwarded-for'];
    const forwardedIp = forwardedFor ? forwardedFor.split(',')[0].trim() : '';
    const reqIp = req.ip || req.connection?.remoteAddress || '';
    const normalizedReqIp = normalizeIp(reqIp);
    const normalizedForwarded = normalizeIp(forwardedIp);

    // Express uses X-Forwarded-For when trust proxy is enabled. Avoid trusting raw headers.
    return normalizedReqIp || normalizedForwarded;
};

const isAllowedMetricsIp = (clientIp) => {
    if (!clientIp || !ipaddr.isValid(clientIp)) return false;
    const parsedClient = ipaddr.parse(clientIp);

    return METRICS_ALLOWED_IPS.some((entry) => {
        if (!entry) return false;
        const normalizedEntry = normalizeIp(entry);

        if (normalizedEntry.includes('/')) {
            try {
                const [range, prefix] = ipaddr.parseCIDR(normalizedEntry);
                return parsedClient.match([range, prefix]);
            } catch (error) {
                return false;
            }
        }

        if (!ipaddr.isValid(normalizedEntry)) return false;
        const parsedEntry = ipaddr.parse(normalizedEntry);
        if (parsedEntry.kind() !== parsedClient.kind()) return false;
        return parsedClient.toString() === parsedEntry.toString();
    });
};

app.get('/metrics', async (req, res) => {
    // Allow if valid bearer token provided
    const authHeader = req.headers.authorization;
    const hasValidToken = !!METRICS_TOKEN && secureCompare(authHeader || '', `Bearer ${METRICS_TOKEN}`);

    // Allow if request from allowed IP (internal monitoring)
    const clientIP = getClientIp(req);
    const isAllowedIP = isAllowedMetricsIp(clientIP);

    // Only bypass auth in explicit local dev — not staging/review/CI
    const isLocalDev = process.env.NODE_ENV === 'development' && process.env.ALLOW_LOCALHOST === 'true';

    if (!hasValidToken && !isAllowedIP && !isLocalDev) {
        return res.status(403).json({ error: 'forbidden', message: 'Metrics endpoint requires authentication' });
    }

    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
});

// RAW BODY ROUTES (Must be before express.json)
// Apply webhook rate limiting to prevent DoS attacks
app.use('/api/v1/webhooks/stripe', webhookLimiter, stripeWebhookRoutes);
app.use('/api/v1/webhooks', webhookLimiter, authWebhookRoutes);
app.use('/api/v1/webhooks/auth', webhookLimiter, authWebhookRoutes);
app.use('/api/v1/webhooks/resend', webhookLimiter, resendWebhookRoutes);

const captureRawBody = (req, res, buf) => {
    req.rawBody = buf.toString();
};
const defaultJsonParser = express.json({ limit: DEFAULT_JSON_BODY_LIMIT, verify: captureRawBody });
// import_trail carries a whole .dawn archive as contents, over REST and inside an
// MCP tool call, so those paths alone get the larger limit (config/bodyLimits.js).
const trailJsonParser = express.json({ limit: TRAIL_JSON_BODY_LIMIT, verify: captureRawBody });
const TRAIL_BODY_PATHS = new Set([
    '/api/v1/context/trail/import',
    MCP_RESOURCE_PATH,
    CLAUDE_MCP_RESOURCE_PATH,
    ...LEGACY_MCP_RESOURCE_PATHS,
]);
// The end-of-session flush posts a whole transcript here, and the MCP client
// sizes its own trim budget from the same constant — so this route's limit is
// named rather than inherited, and cannot drift when the default moves.
const extractionJsonParser = express.json({ limit: EXTRACTION_JSON_BODY_LIMIT, verify: captureRawBody });
app.use((req, res, next) => {
    const path = req.path.replace(/\/+$/, '') || '/';
    if (TRAIL_BODY_PATHS.has(path)) return trailJsonParser(req, res, next);
    if (path === EXTRACTION_BODY_PATH) return extractionJsonParser(req, res, next);
    return defaultJsonParser(req, res, next);
});
app.use(requestId);

// Fail closed instead of redirecting authenticated MCP/OAuth requests over an
// insecure transport (and the self-hosted plain-HTTP rule): middleware/transportGuard.js.
app.use(transportGuard);
// Per-route latency histogram (http_request_duration_ms) on the shared registry,
// surfaced via the existing GET /metrics. Placed after requestId so slow-request
// logs carry req.id, and after express.json so body parsing is included.
app.use(latency(register));

// Routes
app.use('/', healthRoutes);

// OAuth discovery + authorization server for the remote MCP endpoint.
// Mounted above the bootstrap gate so MCP clients can discover and register
// (and connect) even while the rest of the service is still warming up.
app.use('/', oauthRoutes);

// A2A Agent Card discovery. Above the bootstrap gate for the same reason as
// OAuth discovery: a scanner or peer agent must be able to read the card while
// the service is still warming up.
app.use('/', a2aRoutes.discoveryRouter);

app.use((req, res, next) => {
    const bootstrap = getBootstrapState();
    if (bootstrap.ready) return next();

    res.set('Retry-After', '5');
    return res.status(503).json({
        error: 'service_starting',
        status: bootstrap.status,
        message: 'Service is starting up. Retry shortly.',
    });
});

app.use('/', docsRoutes); // Mounts /openapi.json and /docs

// API Routes with audit logging
app.use('/api', auditAccess); // Log sensitive access

// Apply rate limiting selectively
app.use('/api/v1/context', apiLimiter);
app.use('/api/v1/context/active', (req, res, next) => {
    const end = contextActiveLatencyMs.startTimer({ method: req.method });
    res.on('finish', () => end({ status_code: String(res.statusCode) }));
    next();
});
app.use('/api/v1/keys', apiLimiter);
app.use('/api/v1/internal/logs', apiLimiter);
app.use('/api/v1/auth/login', authLoginLimiter);
app.use('/api/v1/auth/signup', authSignupLimiter);
// /api/v1/auth/mcp carries the device flow, and its three endpoints want three
// different keys. One IP bucket over all of them was wrong for two.
//
//   /token   is MEANT to be hit hundreds of times by one client: /start tells
//            it to poll every two seconds until the browser step finishes.
//            Sharing the 30-per-10-minutes bucket spent that budget about a
//            minute into a sign-in and left the minted key uncollectable for
//            the rest of the window.
//   /authorize arrives through a Vercel passthrough that forwards no client
//            IP, so the address here is the dashboard's, identical for every
//            person using it. It is counted per PERSON inside the route
//            instead (routes/shared/mcp-auth.js); this floor is only the
//            unauthenticated flood ceiling, sized for a shared egress.
//   /start   is unauthenticated and anonymous, so the address is all there is,
//            and it keeps the tight bucket.
//
// See middleware/rateLimit.js.
app.use('/api/v1/auth/mcp', (req, res, next) => {
    // Express routes '/token' and '/token/' to the same handler, so the limiter
    // has to read them as the same endpoint. Otherwise a trailing slash picks a
    // different budget than the one chosen for that path.
    const leg = req.path.replace(/\/+$/, '') || '/';
    if (req.method === 'GET' && leg === '/token') return mcpDevicePollLimiter(req, res, next);
    if (leg === '/authorize') return oauthSharedEgressLimiter(req, res, next);
    return mcpAuthLimiter(req, res, next);
});
app.use('/api/v1/public/leads', leadsLimiter);
app.use('/api/v1/public/content/tools/submissions', leadsLimiter);

// ── Shared routes ─────────────────────────────────────────────────────────────
app.use('/api/v1/auth/mcp', mcpAuthRoutes);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/orgs', orgRoutes);
app.use('/api/v1/billing', billingRoutes);
app.use('/api/v1/metrics', metricsRoutes);
app.use('/api/v1/teams', teamRoutes);
app.use('/api/v1/keys', keyRoutes);
app.use('/api/v1/connections', require('./routes/shared/connections'));
// What kind of deployment this is (self-hosted, billing, telemetry, signup
// mode). Public and unauthenticated: the dashboard reads it before sign-in to
// decide whether to offer sign-up and whether to draw any billing UI at all.
app.get('/api/v1/public/deployment', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(require('./config/selfHosted').deploymentInfo());
});
app.use('/api/v1/public/leads', leadsRoutes);
app.use('/api/v1/public/content', publicContentRoutes);
app.use('/api/v1/email', emailRoutes);
app.use('/api/v1/internal/logs', logsRoutes);
app.use('/api/v1/debug', debugRoutes);

// ── Remote MCP endpoint (Streamable HTTP — Claude.ai, ChatGPT.com) ────────────
// /mcp is the one advertised production URL. Keep the former API-prefixed path
// as a compatibility alias so existing configured clients continue to work.
// mcpUnauthenticatedIpLimiter runs FIRST and bounds, per IP, only the traffic
// that never resolves to a recognised actor — the rotating-token flood the
// per-credential bucket below cannot see. It decrements itself for every
// identified caller, so two real users behind one provider egress still do not
// share a bucket. See middleware/rateLimit.js.
// Spelled out on every line rather than spread from an array: three separate
// suites pin this chain by reading the source, because "which guardrails does
// the MCP route actually carry" is the kind of thing a refactor drops silently.
app.use(CLAUDE_MCP_RESOURCE_PATH, observeMcpRequest, mcpUnauthenticatedIpLimiter, mcpToolLimiter, mcpRoutes);
app.use(MCP_RESOURCE_PATH, observeMcpRequest, mcpUnauthenticatedIpLimiter, mcpToolLimiter, mcpRoutes);
for (const legacyPath of LEGACY_MCP_RESOURCE_PATHS) {
  app.use(legacyPath, observeMcpRequest, mcpUnauthenticatedIpLimiter, mcpToolLimiter, mcpRoutes);
}

// ── A2A JSON-RPC binding (the interface the published Agent Card declares) ────
app.use(A2A_BASE_PATH, mcpUnauthenticatedIpLimiter, mcpToolLimiter, a2aRoutes);

// ── Context sync routes ───────────────────────────────────────────────────────
app.use('/api/v1/context', contextSyncRoutes);
app.use('/api/v1/context/integrations', contextIntegrationsRoutes);
app.use('/api/v1/context/userscript', contextUserscriptRoutes);
if (process.env.NODE_ENV !== 'production') app.use('/dashboard', contextDashboardRoutes);
app.use('/api/v1/admin/content', adminContentRoutes);
app.use('/api/v1/onboarding', onboardingRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1/product-events', productEventsRoutes);

// 404 handler for undefined routes
app.use(notFoundHandler);

// Global error handler (must be last)
app.use(errorHandler);

module.exports = app;
