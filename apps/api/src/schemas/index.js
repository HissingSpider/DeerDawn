const { z } = require('zod');
const { extendZodWithOpenApi } = require('@asteasolutions/zod-to-openapi');
const {
    ContextObjectSchema,
    ContextEventSchema,
    ContextSessionSchema,
    ContextRuntimeLayerSchema,
    ExtractionRequestSchema,
    ExtractionResponseSchema,
    ProjectMatchResultSchema,
    InjectionPayloadSchema,
    WorkspaceOverviewResultSchema,
} = require('../../../../packages/shared-context/src/index.js');

extendZodWithOpenApi(z);

// --- Common ---

const ErrorSchema = z.object({
    error: z.string(),
    message: z.string().optional(),
}).openapi({ description: 'Standard error response' });

const TimestampSchema = z.string().datetime().openapi({ description: 'ISO 8601 timestamp' });

// --- Decisions ---

const DecisionRequestSchema = z.object({
    action_type: z.string().min(1).openapi({ example: 'refund.approve' }),
    actor: z.union([
        z.string(),
        z.object({
            id: z.string(),
            role: z.string().optional(),
        }).passthrough()
    ]).nullable().optional().openapi({ example: { id: 'user-123', role: 'agent' } }),
    target: z.union([
        z.string(),
        z.object({
            type: z.string(),
            id: z.string(),
        }).passthrough()
    ]).nullable().optional().openapi({ example: { type: 'ticket', id: 't-456' } }),
    // Accept any JSON; the API will coerce non-object payloads/metadata to {} to avoid 400s from the playground.
    payload: z.unknown().optional().default({}).openapi({ example: { amount: 150.00 } }),
    metadata: z.unknown().optional().default({}).openapi({ example: { source: 'web' } }),
    trace_id: z.string().min(1).openapi({ example: 'trace-abc-123' }),
}).openapi({ description: 'Payload for evaluating a decision' });

const DecisionResponseSchema = z.object({
    decision: z.enum(['allow', 'deny', 'escalate']).openapi({ example: 'allow' }),
    reason: z.string().optional().openapi({ example: 'No blocking policies found' }),
    policy_ids: z.array(z.string()).default([]).openapi({ example: ['policy-default-allow'] }),
    decision_id: z.string().openapi({ example: 'dec-xyz-789' }),
    findings: z.array(z.unknown()).default([]),
    summary: z.unknown().optional(),
    request_id: z.string().optional().openapi({ description: 'Echoed from X-Request-Id header' }),
    latency: z.string().optional().openapi({ example: '15ms' }),
}).openapi({ description: 'Result of the decision evaluation' });

// --- Policies ---

const PolicySchema = z.object({
    policy_id: z.string().optional(),
    name: z.string().optional(),
    enabled: z.boolean().default(true),
    priority: z.number().default(0),
    action_types: z.array(z.string()).min(1),
    effect: z.enum(['allow', 'deny', 'escalate']),
    conditions: z.array(z.object({
        field: z.string(),
        op: z.string(),
        value: z.unknown().optional(),
    })).default([]),
    reason: z.string().optional(),
    environment: z.enum(['sandbox', 'production']).default('production'),
    created_at: TimestampSchema.optional(),
    last_modified: TimestampSchema.optional(),
});

const PolicyListResponseSchema = z.object({
    policies: z.array(PolicySchema),
});

const CreatePolicyRequestSchema = z.object({
    policy: PolicySchema,
});

const CreatePolicyResponseSchema = z.object({
    policy_id: z.string(),
});

// --- Auth ---

// Enhanced email validation to prevent abuse
const emailSchema = z.string()
    .email()
    .min(5)
    .max(254)  // RFC 5321 max length
    .refine(val => !val.includes('..'), 'Invalid email format')
    .refine(val => {
        const domain = val.split('@')[1];
        return domain && domain.includes('.') && domain.length > 3;
    }, 'Invalid email domain');

const LoginRequestSchema = z.object({
    email: emailSchema,
    password: z.string(),
});

const LoginResponseSchema = z.object({
    token: z.string(),
    user: z.object({
        id: z.string(),
        email: z.string(),
        role: z.string(),
        org_id: z.string(),
    }),
});

const SignupRequestSchema = z.object({
    email: emailSchema,
    password: z.string().min(8),
    org_name: z.string().min(2).optional(), // Auto-generate if missing
    account_type: z.enum(['organization']).default('organization'),
    plan: z.enum(['free', 'starter', 'growth', 'scale', 'developer_basic', 'developer_pro', 'personal_basic', 'personal_developer', 'lifetime']).optional(),
    referral_code: z.string().trim().min(4).max(20).optional(),
});

const SignupResponseSchema = LoginResponseSchema;

const ForgotPasswordRequestSchema = z.object({
    email: emailSchema,
});

const ResetPasswordRequestSchema = z.object({
    token: z.string().min(1),
    password: z.string().min(8),
});

// --- Leads ---

const LeadCaptureSchema = z.object({
    email: z.string().trim().email(),
    company_name: z.string().trim().min(1).max(200).optional(),
    use_case: z.string().trim().min(1).max(1000).optional(),
    source_route: z.string().trim().max(500).optional(),
    source_type: z.string().trim().max(100).optional(),
    campaign: z.string().trim().max(200).optional(),
    resource_type: z.string().trim().max(100).optional(),
    tool_type: z.string().trim().max(100).optional(),
    metadata: z.record(z.unknown()).optional(),
}).openapi({ description: 'Lead capture payload' });

// --- Growth Content ---

const ContentTypeSchema = z.enum(['use_case', 'comparison', 'blog_post', 'doc', 'faq', 'example', 'resource']);
const ContentStatusSchema = z.enum(['draft', 'scheduled', 'published', 'archived']);

const slugSchema = z.string()
    .trim()
    .min(2)
    .max(160)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase kebab-case');

const ContentPageUpsertSchema = z.object({
    content_type: ContentTypeSchema,
    slug: slugSchema,
    title: z.string().trim().min(3).max(180),
    description: z.string().trim().min(10).max(500),
    body_markdown: z.string().max(50000).optional().default(''),
    seo_title: z.string().trim().max(180).optional().nullable(),
    seo_description: z.string().trim().max(500).optional().nullable(),
    canonical_path: z.string().trim().max(300).optional().nullable(),
    og_image: z.string().trim().max(500).optional().nullable(),
    tags: z.array(z.string().trim().min(1).max(60)).max(20).optional().default([]),
    category: z.string().trim().max(120).optional().nullable(),
    status: ContentStatusSchema.optional().default('draft'),
    cta_label: z.string().trim().max(120).optional().nullable(),
    cta_href: z.string().trim().max(500).optional().nullable(),
    specialized: z.record(z.unknown()).optional().default({}),
    published_at: z.string().datetime().optional().nullable(),
    scheduled_at: z.string().datetime().optional().nullable(),
}).openapi({ description: 'Create or update a growth content page' });

const ToolSubmissionSchema = z.object({
    tool_type: z.enum(['risk_calculator', 'policy_generator', 'roi_calculator']),
    email: z.string().trim().email().optional(),
    source_route: z.string().trim().max(500).optional(),
    inputs: z.record(z.unknown()).default({}),
    outputs: z.record(z.unknown()).default({}),
}).openapi({ description: 'Tool usage event payload' });

// --- Keys ---
const KeySchema = z.object({
    key_id: z.string(),
    prefix: z.string(),
    name: z.string(),
    environment: z.enum(['sandbox', 'production']),
    status: z.string(),
    last_used: TimestampSchema.nullable(),
    created_at: TimestampSchema
});

const KeyListResponseSchema = z.object({
    keys: z.array(KeySchema)
});

const CreateKeyRequestSchema = z.object({
    name: z.string().optional(),
    environment: z.enum(['sandbox', 'production']).default('sandbox'),
    scopes: z.array(z.enum([
        'decisions:evaluate',
        'context:read',
        'context:write',
        'context:admin',
    ])).min(1).max(8).default(['context:read', 'context:write'])
});

const CreateKeyResponseSchema = z.object({
    key: KeySchema.extend({ key: z.string() }) // Full key only on create
});

// --- Session-memory brief ---

// One trust band shared across every brief surface (derived, never stored).
const TrustBandSchema = z.enum(['high', 'inferred', 'unverified'])
    .openapi({ description: 'Per-item confidence band derived from provenance: high (verified or confidence ≥ 0.75), inferred (0.4–0.75 or date_inferred), unverified (below that or absent).' });

// A single brief item (one line of one slot) with its derived trust band and
// provenance. Slots share this shape; slot-specific fields are optional.
const BriefItemSchema = z.object({
    text: z.string().openapi({ example: 'Shipped the brief-spine data model' }),
    trust: TrustBandSchema,
    source_tool: z.string().nullable().optional().openapi({ example: 'claude_code' }),
    date: z.string().nullable().optional().openapi({ description: 'ISO timestamp this item was recorded/decided/shipped.' }),
    importance: z.enum(['low', 'normal', 'high', 'critical']).optional(),
    reasoning: z.string().nullable().optional().openapi({ description: 'DECIDED items only — why the decision was made.' }),
    paths: z.array(z.string()).optional().openapi({ description: 'LANDMINE items only — related file paths.' }),
    commit_ref: z.string().nullable().optional().openapi({ description: 'SHIPPED items only — the commit this shipped in.' }),
    pinned: z.boolean().optional(),
    from_card: z.boolean().optional().openapi({ description: 'SHIPPED items only — true when the line came from a board card moved to Done. Label it "Shipped": a Done card is a reported completion, not a checked one.' }),
}).openapi('BriefItem', { description: 'One brief line with its trust band and provenance.' });

// The structured 4-slot brief: SHIPPED / DECIDED / OPEN / LANDMINE, plus an
// optional SHIPPED header (current_status). Omit-not-fabricate: empty slots are
// empty arrays. This is the single source of truth (buildBriefSpine) that the
// text body, MCP, and dashboard all derive from.
const BriefSpineSchema = z.object({
    shipped: z.array(BriefItemSchema).openapi({ description: 'SHIPPED slot — deterministic completion events (newest first).' }),
    decided: z.array(BriefItemSchema).openapi({ description: 'DECIDED slot — unresolved recent decisions.' }),
    open: z.array(BriefItemSchema).openapi({ description: 'OPEN slot — open questions.' }),
    landmine: z.array(BriefItemSchema).openapi({ description: 'LANDMINE slot — sharp, durable watch-outs.' }),
    shipped_header: z.object({
        text: z.string(),
        verified: z.boolean(),
    }).optional().openapi({ description: 'Optional SHIPPED header (current_status).' }),
}).openapi('BriefSpine', { description: 'The structured 4-slot brief — SHIPPED / DECIDED / OPEN / LANDMINE.' });

// The injection payload returned by GET /active and GET /projects/:id/inject.
// Extends the shared InjectionPayloadSchema (text body + provenance) with the
// additive structured brief_spine and staleness flags. The 4-slot TEXT body is
// opt-in via ?shape=spine; brief_spine attaches regardless.
const BriefPayloadSchema = z.object({
    tool: z.string().openapi({ example: 'claude_code' }),
    format: z.string().openapi({ example: 'code' }),
    verbosity: z.enum(['light', 'standard', 'detailed']),
    body: z.string().openapi({ description: 'The brief TEXT the AI reads. Default shape unless ?shape=spine, which renders the 4 labeled slots.' }),
    provenance: z.array(z.object({
        kind: z.enum(['active_project', 'related_project', 'session', 'global']),
        label: z.string(),
        project_id: z.string().optional(),
        node_id: z.string().optional(),
        confidence: z.number().min(0).max(1).optional(),
    })).optional(),
    brief_spine: BriefSpineSchema.nullable().optional(),
    stale: z.boolean().optional(),
    stale_tier: z.string().nullable().optional(),
    requires_refresh: z.boolean().optional(),
}).openapi('BriefPayload', { description: 'Brief payload: the text body the AI reads plus the structured 4-slot brief_spine with per-item trust.' });

const ActiveBriefResponseSchema = z.object({
    brief: z.string().nullable().openapi({ description: 'The brief text for the active project (null if none).' }),
    brief_spine: BriefSpineSchema.nullable().optional(),
    project_name: z.string().nullable(),
    project_id: z.string().nullable(),
    last_updated: z.string().nullable(),
    match_kind: z.string().nullable().optional(),
    recently_loaded: z.boolean().optional(),
}).openapi('ActiveBriefResponse', { description: 'The active project brief, resolved from cwd/workspace.' });

const InjectResponseSchema = z.object({
    payload: BriefPayloadSchema,
}).openapi('InjectResponse', { description: 'Wrapper for a project brief injection payload.' });

const ProjectSummarySchema = z.object({
    project_id: z.string(),
    project_name: z.string(),
    updated_at: z.string().optional(),
    context: z.unknown().optional(),
}).openapi('ProjectSummary', { description: 'A project record.' });

const ProjectListResponseSchema = z.object({
    projects: z.array(ProjectSummarySchema),
}).openapi({ description: 'All projects for the workspace.' });

const ProjectResponseSchema = z.object({
    project: ProjectSummarySchema,
}).openapi({ description: 'A single project record.' });

// Create-project request mirrors the route's CreateProjectRequestSchema, including
// the additive landmines[] slot (object entries with per-item provenance).
const CreateBriefProjectRequestSchema = z.object({
    project_name: z.string().min(1),
    description: z.string().optional(),
    goals: z.array(z.string()).optional(),
    current_status: z.string().optional(),
    current_task: z.string().optional(),
    open_questions: z.array(z.string()).optional(),
    tech_stack: z.array(z.string()).optional(),
    recent_decisions: z.array(z.object({
        summary: z.string(),
        decided_at: z.string().datetime(),
    })).optional(),
    landmines: z.array(z.object({
        summary: z.string().min(1),
        paths: z.array(z.string()).optional(),
        added_at: z.string().datetime().optional(),
        importance: z.enum(['low', 'normal', 'high', 'critical']).optional(),
    })).optional().openapi({ description: 'LANDMINE slot — sharp watch-outs. Object entries so per-item trust works.' }),
}).openapi({ description: 'Create a session-memory project (with optional landmines[]).' });

const ExtractionRouteRequestSchema = z.object({
    session_id: z.string().min(1),
    tool: z.string(),
    project_id: z.string().optional(),
    summary: z.string().optional(),
    chunks: z.array(z.object({ role: z.string(), text: z.string() })).optional(),
}).openapi({ description: 'Push a context update / extraction for the brief.' });

const MatchRequestSchema = z.object({
    cwd: z.string().optional(),
    workspace_key: z.string().optional(),
    text: z.string().optional(),
}).openapi({ description: 'Resolve which project a session/cwd belongs to.' });

const PreferencesResponseSchema = z.object({
    paused: z.boolean().optional(),
    tools: z.record(z.unknown()).optional(),
}).openapi({ description: 'Per-tool injection preferences.' });

const PreferencesPatchSchema = z.object({
    paused: z.boolean().optional(),
    tools: z.record(z.unknown()).optional(),
}).openapi({ description: 'Update injection preferences.' });


module.exports = {
    ErrorSchema,
    DecisionRequestSchema,
    DecisionResponseSchema,
    PolicySchema,
    PolicyListResponseSchema,
    CreatePolicyRequestSchema,
    CreatePolicyResponseSchema,
    LoginRequestSchema,
    LoginResponseSchema,
    SignupRequestSchema,
    SignupResponseSchema,
    ForgotPasswordRequestSchema,
    ResetPasswordRequestSchema,
    LeadCaptureSchema,
    ContentPageUpsertSchema,
    ToolSubmissionSchema,
    KeyListResponseSchema,
    CreateKeyRequestSchema,
    CreateKeyResponseSchema,
    ContextObjectSchema,
    ContextEventSchema,
    ContextSessionSchema,
    ContextRuntimeLayerSchema,
    ExtractionRequestSchema,
    ExtractionResponseSchema,
    ProjectMatchResultSchema,
    InjectionPayloadSchema,
    WorkspaceOverviewResultSchema,
    // Session-memory brief
    TrustBandSchema,
    BriefItemSchema,
    BriefSpineSchema,
    BriefPayloadSchema,
    ActiveBriefResponseSchema,
    InjectResponseSchema,
    ProjectSummarySchema,
    ProjectListResponseSchema,
    ProjectResponseSchema,
    CreateBriefProjectRequestSchema,
    ExtractionRouteRequestSchema,
    MatchRequestSchema,
    PreferencesResponseSchema,
    PreferencesPatchSchema,
};
