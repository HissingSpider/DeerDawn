-- Organizations Table (Updated)
CREATE TABLE IF NOT EXISTS organizations (
    org_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    plan TEXT DEFAULT 'starter', -- starter, growth, scale, pilot, enterprise, developer_basic, developer_pro
    plan_tier TEXT DEFAULT 'free',
    pending_plan TEXT,
    -- M15 (resolved): 'trial_active' is canonical, and autoMigrate.js's ALTER now
    -- matches it. New orgs must start in trial rather than jumping straight to active.
    subscription_status TEXT DEFAULT 'trial_active', -- active, trial_active, trial_expired, past_due, cancelled
    
    -- Billing/Stripe
    invite_code TEXT UNIQUE,
    stripe_customer_id TEXT UNIQUE,
    stripe_subscription_id TEXT UNIQUE,
    billing_cycle_anchor TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    billing_period_start TIMESTAMP WITH TIME ZONE,
    billing_period_end TIMESTAMP WITH TIME ZONE,
    
    -- Redaction Strategy (Strict by default for SOC 2)
    redaction_mode TEXT DEFAULT 'strict' CHECK (redaction_mode IN ('strict', 'permissive')),
    redaction_keys TEXT[] DEFAULT '{}', 

    -- Pilots (Sales-led)
    is_pilot BOOLEAN DEFAULT FALSE,
    pilot_ends_at TIMESTAMP WITH TIME ZONE,
    
    -- Safety & Compliance
    is_locked BOOLEAN DEFAULT FALSE, -- SOC 2: Emergency incident response mode
    
    -- Runtime Configuration
    shadow_mode BOOLEAN DEFAULT FALSE,
    fail_mode TEXT DEFAULT 'closed' CHECK (fail_mode IN ('open', 'closed')),
    trial_ends_at TIMESTAMP WITH TIME ZONE,
    account_type TEXT DEFAULT 'organization' CHECK (account_type IN ('organization', 'personal')),
    -- Seats actually being billed, read from the Stripe subscription item's
    -- quantity. NULL means "no purchased count on record", which is different
    -- from zero: entitlements then fall back to the plan's own included_seats
    -- rather than capping a paying team at nothing.
    purchased_seats INT,
    -- When this workspace's Team trial started, as CONFIRMED BY STRIPE (the
    -- webhook writes it from the subscription, never from the checkout click).
    -- NULL means the workspace has never had one. One Team trial per workspace:
    -- its next Team checkout goes straight to paid. Never cleared or moved.
    team_trial_started_at TIMESTAMPTZ,
    -- THE DISPUTE LOCK, separate from is_locked (the owner's own lockdown switch,
    -- PATCH /orgs/settings). Stripe dispute ids that currently hold this
    -- workspace locked: set by charge.dispute.funds_withdrawn, removed by
    -- charge.dispute.closed as won or warning_closed, kept when lost. Only the
    -- webhook and DeerDawn's own hand (docs/RUNBOOK.md, "Disputes") write it, so
    -- an owner cannot clear it through the lockdown setting.
    dispute_lock_ids TEXT[] NOT NULL DEFAULT '{}',
    dispute_locked_at TIMESTAMPTZ,
    onboarding_template TEXT,
    -- Declared here as well as in config/autoMigrate.js. The org cache selects it
    -- on every entitlement and enforcement read, so a database built from this
    -- file alone (every bootstrapped test database) failed that query, and
    -- enforcement FAILS OPEN on a query error: in such a database no workspace
    -- could ever be lapsed, and a test of lapse behaviour proved nothing.
    referral_premium_until TIMESTAMPTZ,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for billing sync
-- CREATE TABLE IF NOT EXISTS is a no-op against an existing table, so a column
-- added to the definition above never reaches a database that already has one.
-- `npm run migrate` runs THIS FILE alone — autoMigrate.js only executes on app
-- boot — so without this ALTER the column exists in development and not in a
-- migrated environment, which is the worst of the two.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS purchased_seats INT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS team_trial_started_at TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS dispute_lock_ids TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS dispute_locked_at TIMESTAMPTZ;
-- Who pays and what they pay (journey r6). Nullable, no default: NULL is "not on
-- record". Also added at boot by config/autoMigrate.js.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_owner_user_id TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_takeover JSONB;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS cancel_at TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS price_unit_amount_cents INT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS price_currency TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS price_interval TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS price_interval_count INT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS overdue_notified_at TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS seat_shortfall_notified_at TIMESTAMPTZ;

-- The compare-and-swap counter on context_projects. That table is created by
-- contextSyncStore.ensureSchema() rather than by this file, so the ALTER is
-- guarded: on a database where the context tables do not exist yet, `npm run
-- migrate` runs before any boot has bootstrapped them and a bare ALTER would
-- abort the whole single-transaction migration.
DO $$ BEGIN
  IF to_regclass('public.context_projects') IS NOT NULL THEN
    ALTER TABLE context_projects ADD COLUMN IF NOT EXISTS context_version BIGINT NOT NULL DEFAULT 0;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_orgs_stripe_sub ON organizations (stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_orgs_pilot ON organizations (pilot_ends_at) WHERE is_pilot = TRUE;

-- Users Table
CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY, -- Internal stable UUID
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT, -- Optional if using external auth
    invite_token_hash TEXT,
    invite_expires_at TIMESTAMP WITH TIME ZONE,
    password_reset_required BOOLEAN DEFAULT FALSE,
    
    -- Auth Adapter Mapping (Vendor Abstraction)
    auth_provider TEXT DEFAULT 'local', -- 'clerk', 'auth0', 'local'
    auth_subject TEXT UNIQUE, -- The ID from the provider (e.g. user_2n...)
    
    -- Org-scoped roles: read-only < member < owner. 'admin'/'operator'/'approver' kept for
    -- backward compatibility. 'admin' is NOT a platform superuser (see requireRole/requirePlatformStaff).
    role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'read-only', 'admin', 'operator', 'approver')),
    -- AUTHZ: platform-staff is a separate, non-grantable capability for cross-tenant/global surfaces.
    -- Never set via signup/webhook; only via migration/seed or the PLATFORM_ADMIN_EMAILS allowlist.
    is_platform_staff BOOLEAN NOT NULL DEFAULT FALSE,
    org_id TEXT REFERENCES organizations(org_id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_org_id ON users (org_id);

-- API Keys Table
CREATE TABLE IF NOT EXISTS api_keys (
    key_id TEXT PRIMARY KEY,
    prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    name TEXT,
    owner_id TEXT REFERENCES users(user_id),
    org_id TEXT REFERENCES organizations(org_id),
    environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    scopes TEXT[] DEFAULT '{decisions:evaluate}',
    last_used_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL, -- SOC 2: Auto-rotation enforcement
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- The audience an OAuth-issued MCP token is bound to. autoMigrate.js has added
-- this to running databases for a while; it was never in the schema, so a freshly
-- bootstrapped database (every test database) did not have the column at all and
-- every suite that mints an OAuth token failed before it asserted anything.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS oauth_resource TEXT;
-- WHICH CLIENT this OAuth token was issued to. Stamped once at mint and carried
-- across refresh, because a refresh grant mints a NEW key row: the key id cannot
-- identify a connection that outlives a token, and the hosted session a project
-- binding hangs off is per connection. See services/hostedSessionIdentity.js.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS oauth_client_id TEXT;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS oauth_client_name TEXT;
-- WHICH WORKSPACE the person was working in when they approved this connection.
-- Stamped at consent and carried across refresh. It is what lets an owner of a
-- team workspace list and disconnect the connections approved FOR that
-- workspace and nobody's others: api_keys.org_id is the approver's own org, not
-- the workspace they approved into. NULL on grants from before it existed, which
-- no owner is shown. See routes/oauth.js (hostedConnections).
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS oauth_workspace_key TEXT;

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_org ON api_keys (org_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_oauth_workspace ON api_keys (oauth_workspace_key) WHERE oauth_workspace_key IS NOT NULL;

-- Policies Table
CREATE TABLE IF NOT EXISTS policies (
    policy_id TEXT PRIMARY KEY,
    name TEXT,
    org_id TEXT REFERENCES organizations(org_id),
    environment TEXT DEFAULT 'production', 
    enabled BOOLEAN DEFAULT TRUE,
    priority INTEGER DEFAULT 0,
    action_types JSONB NOT NULL,
    effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny', 'escalate')),
    conditions JSONB DEFAULT '[]'::jsonb,
    reason TEXT,
    hit_count INTEGER DEFAULT 0,
    last_hit_at TIMESTAMP WITH TIME ZONE,
    version INTEGER DEFAULT 1, -- Added for policy versioning support
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_modified TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_policies_lookup ON policies (org_id, environment, enabled, priority DESC);

-- Policy Versions (Immutable history)
CREATE TABLE IF NOT EXISTS policy_versions (
    version_id TEXT PRIMARY KEY,
    policy_id TEXT REFERENCES policies(policy_id) ON DELETE CASCADE,
    org_id TEXT REFERENCES organizations(org_id),
    version INTEGER NOT NULL,
    name TEXT,
    action_types JSONB NOT NULL,
    effect TEXT NOT NULL,
    conditions JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_policy_versions_lookup ON policy_versions (policy_id, version);

-- Decisions Table
CREATE TABLE IF NOT EXISTS decisions (
    decision_id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL,
    org_id TEXT REFERENCES organizations(org_id),
    environment TEXT NOT NULL,
    action_type TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT,
    policy_ids JSONB DEFAULT '[]'::jsonb,
    findings JSONB DEFAULT '[]'::jsonb,
    summary JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    latency TEXT,
    latency_ms INTEGER,
    is_fail_safe BOOLEAN DEFAULT FALSE -- Flag for SOC 2 auditing of non-deterministic decisions
);

-- Enable RLS on core tables (to be activated via migration)
-- ALTER TABLE decisions ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE policies ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON decisions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_org_time ON decisions (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_trace_id ON decisions (trace_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_org_env_trace ON decisions (org_id, environment, trace_id);

-- Audit Logs Table
CREATE TABLE IF NOT EXISTS audit_logs (
    log_id TEXT PRIMARY KEY,
    org_id TEXT REFERENCES organizations(org_id),
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    details JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_org_time ON audit_logs (org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS access_logs (
    access_id TEXT PRIMARY KEY,
    org_id TEXT REFERENCES organizations(org_id) ON DELETE SET NULL,
    actor_id TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_access_logs_org_created_at ON access_logs (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_logs_actor_created_at ON access_logs (actor_id, created_at DESC);

-- Escalation Resolutions Table
CREATE TABLE IF NOT EXISTS escalation_resolutions (
    resolution_id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL,
    status TEXT CHECK (status IN ('pending', 'approved', 'denied')) NOT NULL DEFAULT 'pending',
    approver_id TEXT,
    approver_email TEXT,
    justification TEXT,
    sla_minutes INTEGER DEFAULT 240,
    sla_deadline TIMESTAMP WITH TIME ZONE,
    resolved_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    org_id TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_escalation_resolutions_decision_unique
ON escalation_resolutions(decision_id);

CREATE INDEX IF NOT EXISTS idx_escalation_resolutions_status
ON escalation_resolutions(status);

CREATE INDEX IF NOT EXISTS idx_escalation_resolutions_org
ON escalation_resolutions(org_id);

CREATE INDEX IF NOT EXISTS idx_escalation_resolutions_org_status
ON escalation_resolutions(org_id, status);

-- Integrations Table (Placeholder for limit enforcement)
-- Valid types: webhook, slack, zendesk, intercom, teams, openclaw
CREATE TABLE IF NOT EXISTS integrations (
    integration_id TEXT PRIMARY KEY,
    org_id TEXT REFERENCES organizations(org_id),
    type TEXT NOT NULL,
    config JSONB DEFAULT '{}'::jsonb,
    webhook_secret TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_integrations_org ON integrations (org_id);
CREATE INDEX IF NOT EXISTS idx_integrations_org_type_created_at ON integrations (org_id, type, created_at DESC);

CREATE TABLE IF NOT EXISTS stripe_events (
    event_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing',
    processed_at TIMESTAMP WITH TIME ZONE,
    error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Append-only retention ledger: subscription lifecycle events behind MRR/churn/
-- cohort metrics (see services/retentionLedger.js + retentionMetrics.js).
CREATE TABLE IF NOT EXISTS subscription_events (
    event_pk BIGSERIAL PRIMARY KEY,
    org_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    plan_tier TEXT,
    mrr_cents INTEGER NOT NULL DEFAULT 0,
    stripe_event_id TEXT,
    billing_reason TEXT,
    occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE (stripe_event_id, event_type)
);

CREATE INDEX IF NOT EXISTS idx_subscription_events_occurred ON subscription_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_subscription_events_org ON subscription_events(org_id);

CREATE TABLE IF NOT EXISTS system_health_log (
    log_id TEXT PRIMARY KEY,
    metric_name TEXT NOT NULL,
    metric_value DOUBLE PRECISION NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    org_id TEXT REFERENCES organizations(org_id) ON DELETE SET NULL,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_system_health_log_timestamp ON system_health_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_system_health_log_metric_timestamp ON system_health_log(metric_name, timestamp DESC);

CREATE TABLE IF NOT EXISTS product_events (
    event_id UUID PRIMARY KEY,
    event_name TEXT NOT NULL,
    org_id TEXT REFERENCES organizations(org_id) ON DELETE SET NULL,
    user_id TEXT REFERENCES users(user_id) ON DELETE SET NULL,
    session_id TEXT,
    source TEXT NOT NULL,
    surface TEXT,
    path TEXT,
    started_at TIMESTAMP WITH TIME ZONE,
    ended_at TIMESTAMP WITH TIME ZONE,
    duration_ms INTEGER,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- WHICH TOOL and HOW IT CONNECTS, apart from `surface` (which mixes them and is
-- unchanged). Written by productEventsService; rows before this carry neither
-- and are read through the derivation in services/connectionIdentity.js.
ALTER TABLE product_events ADD COLUMN IF NOT EXISTS tool TEXT;
ALTER TABLE product_events ADD COLUMN IF NOT EXISTS transport TEXT;

CREATE INDEX IF NOT EXISTS idx_product_events_org_created
ON product_events (org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_product_events_org_name_created
ON product_events (org_id, event_name, created_at DESC);

-- Per-user lookups: the day-two catch-up queries filter on
-- (org_id = $1 OR user_id = $2); without this the user_id arm seq-scans the
-- whole (append-only, unbounded) event table on every session start / handshake.
CREATE INDEX IF NOT EXISTS idx_product_events_user_created
ON product_events (user_id, created_at DESC);

-- Leads Table
CREATE TABLE IF NOT EXISTS leads (
    lead_id UUID PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    company_name VARCHAR(255),
    use_case VARCHAR(255),
    source_route TEXT,
    source_type TEXT,
    campaign TEXT,
    resource_type TEXT,
    tool_type TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE leads ADD COLUMN IF NOT EXISTS source_route TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS source_type TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS campaign TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS resource_type TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS tool_type TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

-- Organic Growth Content Tables
CREATE TABLE IF NOT EXISTS content_pages (
    content_id UUID PRIMARY KEY,
    content_type TEXT NOT NULL CHECK (content_type IN ('use_case', 'comparison', 'blog_post', 'doc', 'faq', 'example', 'resource')),
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    body_markdown TEXT DEFAULT '',
    seo_title TEXT,
    seo_description TEXT,
    canonical_path TEXT,
    og_image TEXT,
    tags TEXT[] DEFAULT '{}',
    category TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'published', 'archived')),
    cta_label TEXT,
    cta_href TEXT,
    specialized JSONB DEFAULT '{}'::jsonb,
    created_by TEXT,
    updated_by TEXT,
    published_at TIMESTAMP WITH TIME ZONE,
    scheduled_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (content_type, slug)
);

CREATE INDEX IF NOT EXISTS idx_content_pages_public
ON content_pages (content_type, status, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_content_pages_slug
ON content_pages (content_type, slug);

CREATE TABLE IF NOT EXISTS content_versions (
    version_id UUID PRIMARY KEY,
    content_id UUID NOT NULL REFERENCES content_pages(content_id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    snapshot JSONB NOT NULL,
    created_by TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (content_id, version_number)
);

CREATE TABLE IF NOT EXISTS content_assets (
    asset_id UUID PRIMARY KEY,
    content_id UUID REFERENCES content_pages(content_id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    url TEXT NOT NULL,
    alt_text TEXT,
    asset_type TEXT DEFAULT 'download',
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lead_events (
    event_id UUID PRIMARY KEY,
    lead_id UUID REFERENCES leads(lead_id) ON DELETE SET NULL,
    email VARCHAR(255),
    event_type TEXT NOT NULL,
    source_route TEXT,
    source_type TEXT,
    campaign TEXT,
    resource_type TEXT,
    tool_type TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_events_source
ON lead_events (source_type, source_route, created_at DESC);

CREATE TABLE IF NOT EXISTS tool_submissions (
    submission_id UUID PRIMARY KEY,
    tool_type TEXT NOT NULL CHECK (tool_type IN ('risk_calculator', 'policy_generator', 'roi_calculator')),
    email VARCHAR(255),
    source_route TEXT,
    inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
    outputs JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tool_submissions_tool_created
ON tool_submissions (tool_type, created_at DESC);

-- Enterprise Inquiries Table
CREATE TABLE IF NOT EXISTS enterprise_inquiries (
    inquiry_id TEXT PRIMARY KEY,
    org_id TEXT REFERENCES organizations(org_id),
    user_id TEXT REFERENCES users(user_id),
    company_size TEXT,
    estimated_decisions TEXT,
    use_case TEXT,
    timeline TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Idempotency Records
CREATE TABLE IF NOT EXISTS idempotency_records (
    key TEXT PRIMARY KEY,
    response JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- H15/M14: tables that previously existed ONLY in src/config/autoMigrate.js
-- (created via `CREATE TABLE IF NOT EXISTS` on every boot), so a fresh install
-- from this file alone was missing them. Ported here verbatim from
-- autoMigrate.js so `npm run migrate` / a fresh install matches a
-- migrated-in-place instance. Keep these two in sync going forward — this file
-- is the fresh-install source of truth, autoMigrate.js is the in-place-upgrade
-- path for existing databases.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS referrals (
    referral_id TEXT PRIMARY KEY,
    referral_code TEXT NOT NULL,
    referrer_user_id TEXT NOT NULL,
    referrer_org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    referred_user_id TEXT NOT NULL,
    referred_org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'signed_up', 'activated', 'rewarded', 'fraud_hold', 'expired')),
    activation_reason TEXT,
    fraud_reason TEXT,
    reward_tier TEXT,
    reward_expires_at TIMESTAMP WITH TIME ZONE,
    activated_at TIMESTAMP WITH TIME ZONE,
    rewarded_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer_user
ON referrals (referrer_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_referrals_referred_user
ON referrals (referred_user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_referred_unique
ON referrals (referred_user_id, referred_org_id);

CREATE TABLE IF NOT EXISTS usage_counters (
    org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    period_start TIMESTAMP WITH TIME ZONE NOT NULL,
    period_end TIMESTAMP WITH TIME ZONE NOT NULL,
    decisions_count BIGINT DEFAULT 0,
    reported_overage_count BIGINT DEFAULT 0,
    last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (org_id, period_start)
);

-- "Why are you using DeerDawn" onboarding questionnaire responses.
-- One row per user (upserted), captured during onboarding for product insight.
CREATE TABLE IF NOT EXISTS onboarding_responses (
    user_id     TEXT PRIMARY KEY,
    org_id      TEXT REFERENCES organizations(org_id) ON DELETE CASCADE,
    role        TEXT,
    primary_use TEXT,
    tools       TEXT[] DEFAULT '{}',
    team_size   TEXT,
    motivation  TEXT,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_responses_org
ON onboarding_responses (org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS context_audit_logs (
    audit_id TEXT PRIMARY KEY,
    owner_key TEXT NOT NULL,
    project_id TEXT,
    action TEXT NOT NULL,
    actor_type TEXT DEFAULT 'user',
    -- The human behind the action. For a key-authed actor this is the key's
    -- owner, not the key id: a shared workspace's audit log is read by person,
    -- and "which credential" is not an answer to "who".
    actor_user_id TEXT,
    tool TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- CREATE TABLE IF NOT EXISTS is a no-op against an existing table, so a column
-- added to the definition above never reaches a database that already has one.
-- The index below then fails on a column that does not exist, taking the whole
-- single-transaction migration with it. Every added column needs its own ALTER.
ALTER TABLE context_audit_logs ADD COLUMN IF NOT EXISTS actor_user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_context_audit_logs_owner_created
ON context_audit_logs(owner_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_context_audit_logs_owner_actor
ON context_audit_logs(owner_key, actor_user_id, created_at DESC);

-- Workspace membership: who may read and write a given owner_key.
-- Removing somebody sets removed_at and nothing else — their contributions are
-- the asset the workspace pays for and must survive their departure.
CREATE TABLE IF NOT EXISTS workspace_members (
    owner_key  TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'member',
    invited_by TEXT,
    joined_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    removed_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (owner_key, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_members_user
ON workspace_members (user_id) WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_workspace_members_owner_active
ON workspace_members (owner_key) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS context_integrations (
    integration_id TEXT PRIMARY KEY,
    owner_key TEXT NOT NULL,
    provider TEXT NOT NULL,
    encrypted_key TEXT,
    agent_id TEXT,
    agent_url TEXT,
    meta JSONB DEFAULT '{}'::jsonb,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ctx_integrations_owner
ON context_integrations(owner_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ctx_integrations_owner_provider
ON context_integrations(owner_key, provider);

CREATE TABLE IF NOT EXISTS user_encryption_keys (
    owner_key TEXT PRIMARY KEY,
    encrypted_dek TEXT NOT NULL,
    dek_version INT NOT NULL DEFAULT 1,
    encrypted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Shared skills (markdown know-how) distributed across connected tools.
-- project_id NULL = workspace-wide; UNIQUE(owner_key, slug) keeps one slug
-- per owner regardless of scope.
--
-- ORDERING NOTE: in autoMigrate.js this references context_projects(project_id),
-- but context_projects is a context_* table owned by contextSyncStore.ensureSchema()
-- (see the comment at the top of autoMigrate.js) — it is NOT created anywhere in
-- this schema.sql file. Declaring the same FK here would make a fresh
-- `npm run migrate` (which just runs this file in one transaction, without first
-- calling ensureSchema()) fail outright. The FK is therefore omitted here; the
-- column stays a plain TEXT reference. Once ensureSchema() has run (e.g. after
-- the app has booted once), the two tables coexist fine without the DB-level
-- constraint — application code is the only writer of project_id on this table.
-- If you want the FK enforced, add it manually after context_projects exists:
--   ALTER TABLE workspace_skills
--     ADD CONSTRAINT workspace_skills_project_id_fkey
--     FOREIGN KEY (project_id) REFERENCES context_projects(project_id) ON DELETE CASCADE;
CREATE TABLE IF NOT EXISTS workspace_skills (
    skill_id    TEXT PRIMARY KEY,
    owner_key   TEXT NOT NULL,
    project_id  TEXT,
    slug        TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT DEFAULT '',
    markdown_content TEXT NOT NULL,
    visibility  TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','shared','public')),
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    -- Who wrote it. A skill is agent INSTRUCTIONS handed to every session in the
    -- workspace, so replacing somebody else's skill is not an ordinary write.
    -- NULL means the row predates attribution and belongs to the workspace.
    created_by  TEXT,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (owner_key, slug)
);

-- CREATE TABLE IF NOT EXISTS adds no column to a table that already exists, so
-- the author column needs its own idempotent ALTER for databases created before
-- it was added.
ALTER TABLE workspace_skills ADD COLUMN IF NOT EXISTS created_by TEXT;

CREATE INDEX IF NOT EXISTS idx_workspace_skills_owner
ON workspace_skills(owner_key, enabled);

-- M14: subscription_events (above, near decisions/audit_logs) exists ONLY in this
-- file — it has no autoMigrate.js counterpart. It is lazily self-created by
-- services/retentionLedger.js on a fresh DB that skipped schema.sql, so no
-- action needed here; noted for completeness of the schema.sql/autoMigrate.js
-- reconciliation.
