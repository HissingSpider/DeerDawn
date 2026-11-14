const prometheus = require('prom-client');

// Collapse high-cardinality path segments (ids, uuids, prefixed ids, tokens)
// down to ':id' so the Prometheus route label stays bounded. We prefer the
// matched Express route template (req.baseUrl + req.route.path) and only fall
// back to normalizing the raw path for unmatched (404) requests.
function normalizeRoute(path) {
    if (!path) return 'unknown';
    return path
        .split('?')[0]
        .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
        .replace(/\/(proj|sess|usr|user|org|key|sk|pk)_[A-Za-z0-9]+/gi, '/$1_:id')
        .replace(/\/[0-9a-f]{24,}/gi, '/:id')
        .replace(/\/\d+/g, '/:id');
}

// Per-route request latency. Registered on the SAME registry as the rest of the
// app's metrics so it surfaces on the existing GET /metrics endpoint with no new
// route. Slow requests (>500ms) also emit a structured JSON line keyed by the
// existing req.id so they're greppable in logs without a tracing backend.
module.exports = function latency(register) {
    const httpDuration = new prometheus.Histogram({
        name: 'http_request_duration_ms',
        help: 'Duration of HTTP requests in ms, labeled by method, normalized route, and status_code',
        labelNames: ['method', 'route', 'status_code'],
        buckets: [10, 25, 50, 100, 200, 400, 800, 1500, 3000, 8000],
        registers: [register],
    });

    return function latencyMiddleware(req, res, next) {
        const start = process.hrtime.bigint();
        res.on('finish', () => {
            const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
            const matched = (req.baseUrl || '') + (req.route && req.route.path ? req.route.path : '');
            const route = matched ? normalizeRoute(matched) : normalizeRoute(req.path);
            httpDuration.labels(req.method, route, String(res.statusCode)).observe(durationMs);

            if (durationMs > 500) {
                console.warn(JSON.stringify({
                    level: 'warn',
                    msg: 'slow_request',
                    req_id: req.id,
                    method: req.method,
                    route,
                    status_code: res.statusCode,
                    duration_ms: Math.round(durationMs),
                }));
            }
        });
        next();
    };
};

module.exports.normalizeRoute = normalizeRoute;
