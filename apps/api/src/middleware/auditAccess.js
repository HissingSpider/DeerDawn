const crypto = require('crypto');
const db = require('../config/db');

function auditAccess(req, res, next) {
    // Only log sensitive routes.
    // Must match on originalUrl, not path: this middleware is mounted at '/api'
    // (app.js), and Express strips the mount prefix from req.path — so req.path is
    // '/v1/keys', never '/api/v1/keys', and a req.path check never fired at all.
    const url = req.originalUrl || req.url || '';
    if (url.startsWith('/api/v1/audit') || url.startsWith('/api/v1/keys')) {
        const orgId = req.actor ? req.actor.org_id : null;
        const actorId = req.actor ? req.actor.id : 'anonymous';
      
        // Fire and forget log
        db.query(
            `INSERT INTO access_logs (access_id, org_id, actor_id, method, path, ip, user_agent)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [`acc-${crypto.randomUUID()}`, orgId, actorId, req.method, req.originalUrl, req.ip, req.get('user-agent')]
        ).catch(console.error);
    }
    next();
}

module.exports = auditAccess;
