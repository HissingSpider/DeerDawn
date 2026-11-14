// LOG-01: the inbound x-request-id is attacker-controlled and flows into log lines and a
// response header. Accept only a bounded set of safe characters and cap the length so it
// cannot be used for log forging or header (CRLF) injection.
function sanitizeRequestId(value) {
    if (typeof value !== 'string') return null;
    const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 128);
    return cleaned.length > 0 ? cleaned : null;
}

function requestId(req, res, next) {
    // A unique ID for THIS HTTP request (not the same as trace_id).
    const headerId = sanitizeRequestId(req.headers['x-request-id']);
    const requestIdValue = headerId || `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    req._req_id = requestIdValue;
    req.id = requestIdValue;

    // Helpful for debugging: send it back so clients can reference it.
    res.setHeader('X-Request-Id', requestIdValue);

    next();
}

module.exports = requestId;
