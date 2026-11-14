const express = require('express');
const router = express.Router();
const swaggerUi = require('swagger-ui-express');
const { generateOpenApiSpec } = require('../docs/registry');

// Cache the spec
let cachedSpec = null;

function getSpec() {
    if (!cachedSpec) {
        cachedSpec = generateOpenApiSpec();
    }
    return cachedSpec;
}

// 1. JSON endpoint - Always available (safe for schema introspection)
router.get('/openapi.json', (req, res) => {
    res.json(getSpec());
});

// 2. Swagger UI - Protected in production
const docsEnabled = process.env.DOCS_ENABLED === 'true' || process.env.NODE_ENV !== 'production';

if (docsEnabled) {
    router.use('/docs', swaggerUi.serve, (req, res, next) => {
        // Re-generate on request in dev for hot reloading schemas? 
        // For now, caching is safer/faster for prod.
        swaggerUi.setup(getSpec())(req, res, next);
    });
} else {
    router.use('/docs', (req, res) => {
        res.status(403).send('Documentation is disabled in this environment. Set DOCS_ENABLED=true to enable.');
    });
}

module.exports = router;