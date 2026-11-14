const { OpenAPIRegistry, OpenApiGeneratorV3 } = require('@asteasolutions/zod-to-openapi');
const schemas = require('../schemas');
const { z } = require('zod');

const registry = new OpenAPIRegistry();

// --- Security Schemes ---
registry.registerComponent('securitySchemes', 'ApiKeyAuth', {
    type: 'apiKey',
    in: 'header',
    name: 'X-API-Key',
});

registry.registerComponent('securitySchemes', 'BearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
});

// --- Schemas ---
registry.register('Error', schemas.ErrorSchema);

// Session-memory brief components. Registered (not inlined) so they appear under
// components.schemas and the context paths $ref them — which also dedupes
// BriefSpine/BriefItem, shared by both the /active and /inject responses.
registry.register('BriefItem', schemas.BriefItemSchema);
registry.register('BriefSpine', schemas.BriefSpineSchema);
registry.register('BriefPayload', schemas.BriefPayloadSchema);
registry.register('ActiveBriefResponse', schemas.ActiveBriefResponseSchema);
registry.register('InjectResponse', schemas.InjectResponseSchema);
registry.register('ProjectSummary', schemas.ProjectSummarySchema);

// --- Paths ---

// Health & Ready
registry.registerPath({
    method: 'get',
    path: '/healthz',
    tags: ['System'],
    summary: 'Health Check',
    responses: {
        200: { description: 'Server is healthy', content: { 'text/plain': { schema: z.string() } } },
    },
});

registry.registerPath({
    method: 'get',
    path: '/healthz/dashboard',
    tags: ['System'],
    summary: 'Dashboard reachability, as measured by the API',
    responses: {
        200: { description: 'The state is in the body: operational, degraded or unknown', content: { 'application/json': { schema: z.object({ dashboard: z.enum(['operational', 'degraded', 'unknown']), checked_at: z.string() }) } } },
    },
});

// Auth
registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/login',
    tags: ['Auth'],
    summary: 'Login',
    request: {
        body: { content: { 'application/json': { schema: schemas.LoginRequestSchema } } }
    },
    responses: {
        200: { description: 'Login successful', content: { 'application/json': { schema: schemas.LoginResponseSchema } } }
    }
});

registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/signup',
    tags: ['Auth'],
    summary: 'Signup',
    request: {
        body: { content: { 'application/json': { schema: schemas.SignupRequestSchema } } }
    },
    responses: {
        201: { description: 'Signup successful', content: { 'application/json': { schema: schemas.SignupResponseSchema } } }
    }
});

// Keys
registry.registerPath({
    method: 'get',
    path: '/api/v1/keys',
    tags: ['Keys'],
    summary: 'List API Keys',
    security: [{ BearerAuth: [] }],
    responses: {
        200: { description: 'List of keys', content: { 'application/json': { schema: schemas.KeyListResponseSchema } } }
    }
});

registry.registerPath({
    method: 'post',
    path: '/api/v1/keys',
    tags: ['Keys'],
    summary: 'Create API Key',
    security: [{ BearerAuth: [] }],
    request: {
        body: { content: { 'application/json': { schema: schemas.CreateKeyRequestSchema } } }
    },
    responses: {
        201: { description: 'Key created', content: { 'application/json': { schema: schemas.CreateKeyResponseSchema } } }
    }
});

// --- Session Memory (the brief) ---

const shapeParam = z.enum(['spine']).optional().openapi({
    param: { name: 'shape', in: 'query' },
    description: 'Opt-in: ?shape=spine renders the 4-slot brief TEXT body (SHIPPED / DECIDED / OPEN / LANDMINE). Default keeps the current text shape. brief_spine is attached either way.',
});

registry.registerPath({
    method: 'get',
    path: '/api/v1/context/active',
    tags: ['Session Memory'],
    summary: 'Read the active project brief',
    description: 'Resolves the active project from cwd/workspace and returns the brief the AI reads at session start, plus the structured 4-slot brief_spine.',
    security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
    request: {
        query: z.object({
            tool: z.string().optional().openapi({ param: { name: 'tool', in: 'query' } }),
            verbosity: z.enum(['light', 'standard', 'detailed']).optional().openapi({ param: { name: 'verbosity', in: 'query' } }),
            cwd: z.string().optional().openapi({ param: { name: 'cwd', in: 'query' } }),
            sections: z.string().optional().openapi({ param: { name: 'sections', in: 'query' }, description: 'Comma-separated sections incl. landmines, shipped.' }),
            shape: shapeParam,
        }),
    },
    responses: {
        200: { description: 'The active brief', content: { 'application/json': { schema: schemas.ActiveBriefResponseSchema } } },
    },
});

registry.registerPath({
    method: 'get',
    path: '/api/v1/context/projects/{projectId}/inject',
    tags: ['Session Memory'],
    summary: 'Read a project brief (injection payload)',
    description: 'Returns the brief injection payload for a specific project. ?shape=spine renders the 4-slot text; ?format=json returns the raw context object.',
    security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
    request: {
        params: z.object({ projectId: z.string().openapi({ param: { name: 'projectId', in: 'path' } }) }),
        query: z.object({
            tool: z.string().optional().openapi({ param: { name: 'tool', in: 'query' } }),
            verbosity: z.enum(['light', 'standard', 'detailed']).optional().openapi({ param: { name: 'verbosity', in: 'query' } }),
            sections: z.string().optional().openapi({ param: { name: 'sections', in: 'query' }, description: 'Comma-separated sections incl. landmines, shipped.' }),
            shape: shapeParam,
        }),
    },
    responses: {
        200: { description: 'The project brief payload', content: { 'application/json': { schema: schemas.InjectResponseSchema } } },
        204: { description: 'No brief (suppressed by dedup or preferences)' },
        404: { description: 'Project not found', content: { 'application/json': { schema: schemas.ErrorSchema } } },
    },
});

registry.registerPath({
    method: 'get',
    path: '/api/v1/context/projects',
    tags: ['Session Memory'],
    summary: 'List projects',
    security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
    responses: {
        200: { description: 'Projects', content: { 'application/json': { schema: schemas.ProjectListResponseSchema } } },
    },
});

registry.registerPath({
    method: 'post',
    path: '/api/v1/context/projects',
    tags: ['Session Memory'],
    summary: 'Create a project',
    description: 'Creates a session-memory project. Supports the additive landmines[] slot.',
    security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
    request: {
        body: { content: { 'application/json': { schema: schemas.CreateBriefProjectRequestSchema } } },
    },
    responses: {
        201: { description: 'Project created', content: { 'application/json': { schema: schemas.ProjectResponseSchema } } },
        400: { description: 'Invalid payload', content: { 'application/json': { schema: schemas.ErrorSchema } } },
    },
});

registry.registerPath({
    method: 'post',
    path: '/api/v1/context/extraction',
    tags: ['Session Memory'],
    summary: 'Push a brief update (extraction)',
    description: 'Records a context update into the brief. Used by update_context / update_brief.',
    security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
    request: {
        body: { content: { 'application/json': { schema: schemas.ExtractionRouteRequestSchema } } },
    },
    responses: {
        200: { description: 'Extraction result', content: { 'application/json': { schema: schemas.ExtractionResponseSchema } } },
    },
});

registry.registerPath({
    method: 'get',
    path: '/api/v1/context/export',
    tags: ['Session Memory'],
    summary: 'Export all briefs',
    description: 'Full data export — JSON by default, or human-readable markdown with ?format=markdown.',
    security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
    request: {
        query: z.object({ format: z.enum(['markdown']).optional().openapi({ param: { name: 'format', in: 'query' } }) }),
    },
    responses: {
        200: { description: 'Export payload' },
    },
});

registry.registerPath({
    method: 'post',
    path: '/api/v1/context/match',
    tags: ['Session Memory'],
    summary: 'Resolve which project a session belongs to',
    security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
    request: {
        body: { content: { 'application/json': { schema: schemas.MatchRequestSchema } } },
    },
    responses: {
        200: { description: 'Match result', content: { 'application/json': { schema: schemas.ProjectMatchResultSchema } } },
    },
});

registry.registerPath({
    method: 'get',
    path: '/api/v1/context/preferences',
    tags: ['Session Memory'],
    summary: 'Read injection preferences',
    security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
    responses: {
        200: { description: 'Preferences', content: { 'application/json': { schema: schemas.PreferencesResponseSchema } } },
    },
});

registry.registerPath({
    method: 'patch',
    path: '/api/v1/context/preferences',
    tags: ['Session Memory'],
    summary: 'Update injection preferences',
    security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
    request: {
        body: { content: { 'application/json': { schema: schemas.PreferencesPatchSchema } } },
    },
    responses: {
        200: { description: 'Updated preferences', content: { 'application/json': { schema: schemas.PreferencesResponseSchema } } },
    },
});


function generateOpenApiSpec() {
    const generator = new OpenApiGeneratorV3(registry.definitions);

    return generator.generateDocument({
        openapi: '3.0.0',
        info: {
            title: 'DeerDawn Session Memory API',
            version: '1.0.0',
            description: 'AI session memory API — the brief every new AI session reads.',
        },
        servers: [
            { url: 'http://localhost:8080', description: 'Localhost' },
            { url: 'https://api.deerdawn.com', description: 'Production' }
        ],  });
}

module.exports = { generateOpenApiSpec };
