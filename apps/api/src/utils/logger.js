function log(req, message, extra = {}) {
    console.log(JSON.stringify({
        ts: new Date().toISOString(),
        req_id: req && req._req_id ? req._req_id : 'unknown',
        message,
        ...extra
    }));
}

module.exports = { log };
