const db = require('./db');

// ─────────────────────────────────────────────────────────────────────────────
// A SECOND BOOT MUST BE A NO-OP, AND "IDEMPOTENT" IS NOT THE SAME THING.
//
// Every statement in this file was written to be safe to repeat, and every one
// of them was then repeated on every start of every machine. Safe to repeat is
// a statement about the RESULT. It says nothing about the cost of getting there:
//
//   - `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` takes ACCESS EXCLUSIVE on the
//     table BEFORE it looks at whether the column exists. The lock is brief,
//     but it queues behind any transaction already reading the table, and every
//     other query on that table then queues behind IT. One slow report at
//     deploy time stalls `users` for the whole API.
//   - `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` is worse: the ADD validates
//     by scanning the whole table while holding that lock, and a foreign key
//     takes a second lock on the table it references. On api_keys -> users that
//     is a full scan with both of the auth path's tables locked, per boot, per
//     machine, growing with the data.
//   - An UPDATE that matches rows already in their final state still writes a
//     new version of each one.
//
// So each step below first asks the catalog whether there is anything to do and
// issues DDL only when there is. On a database that is already current, a boot
// reads the catalog and changes nothing.
//
// Catalog checks are used for anything the catalog can answer (columns,
// constraints): they are self-correcting if somebody changes the schema by
// hand. The `context_migrations` marker table is used only for one-time DATA
// repairs, where "has this run" is not recoverable from the data itself.
// ─────────────────────────────────────────────────────────────────────────────

// Arbitrary, fixed, and unique to this file. Transaction-scoped, so it is
// released by COMMIT/ROLLBACK and cannot leak onto a pooled connection.
const AUTO_MIGRATE_LOCK_KEY = 0x44443031; // 'DD01'

/**
 * Add only the columns a table is missing. `columns` is [[name, definition]].
 * Issues no ALTER (and so takes no table lock) when none are missing.
 */
async function addMissingColumns(client, table, columns) {
    const existing = await client.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1`,
        [table]
    );
    const have = new Set(existing.rows.map((row) => row.column_name));
    // An empty set means the TABLE is missing. Fall through and let the ALTER
    // fail exactly as it always did, rather than reporting success over a
    // schema that is not there.
    const missing = have.size === 0 ? columns : columns.filter(([name]) => !have.has(name));
    if (missing.length === 0) return 0;
    await client.query(
        `ALTER TABLE ${table}\n${missing.map(([name, definition]) => `      ADD COLUMN IF NOT EXISTS ${name} ${definition}`).join(',\n')};`
    );
    return missing.length;
}

/** The constraint's current definition, or null when it does not exist. */
async function constraintDefinition(client, table, name) {
    const res = await client.query(
        `SELECT pg_get_constraintdef(c.oid) AS def
           FROM pg_constraint c
          WHERE c.conname = $1
            AND c.conrelid = to_regclass($2)`,
        [name, table]
    );
    return res.rows[0]?.def ?? null;
}

async function migrationDone(client, name) {
    const res = await client.query('SELECT 1 FROM context_migrations WHERE name = $1', [name]);
    return res.rows.length > 0;
}

async function markMigrationDone(client, name) {
    await client.query('INSERT INTO context_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
}

/**
 * Derive `organizations.team_trial_started_at` for workspaces that had a Team
 * trial before it was recorded. Two facts already stored say so:
 *
 *  1. The retention ledger: a Team trial books ZERO at creation (the
 *     checkout.session.completed handler writes mrr_cents 0 for a trialing
 *     subscription), and nothing else writes a zero-value Team 'created' row (a
 *     lifetime purchase is not on the Team plan). Its time is the trial's start.
 *  2. The status: a workspace whose recorded status is 'trialing' on a plan that
 *     trials is in one now (its billing period start is the trial's start).
 *
 * What neither shows (a trial whose ledger row was never written and that was
 * cancelled before this ran) is not derivable here. Only fills workspaces with
 * no value, so it is safe to repeat. Returns how many workspaces it set.
 */
async function backfillTeamTrialStartedAt(client) {
    const { PLANS } = require('./plans');
    const trialPlans = Object.entries(PLANS).filter(([, plan]) => Number(plan.trial_days) > 0).map(([id]) => id);
    if (trialPlans.length === 0) return 0;
    let total = 0;
    const ledger = await client.query('SELECT to_regclass(\'subscription_events\') IS NOT NULL AS present');
    if (ledger.rows[0]?.present) {
        const res = await client.query(
            `UPDATE organizations o
                SET team_trial_started_at = t.started
               FROM (SELECT org_id, MIN(occurred_at) AS started
                       FROM subscription_events
                      WHERE event_type = 'created' AND mrr_cents = 0 AND plan_tier = ANY($1::text[])
                      GROUP BY org_id) t
              WHERE o.org_id = t.org_id AND o.team_trial_started_at IS NULL`,
            [trialPlans]
        );
        total += res.rowCount || 0;
    }
    const trialing = await client.query(
        `UPDATE organizations
            SET team_trial_started_at = COALESCE(billing_period_start, NOW())
          WHERE team_trial_started_at IS NULL
            AND subscription_status = 'trialing'
            AND plan_tier = ANY($1::text[])`,
        [trialPlans]
    );
    total += trialing.rowCount || 0;
    return total;
}

// HOSTED CONNECTIONS ARE PINNED TO THE WORKSPACE THEY WERE APPROVED FOR.
//
// A grant made before the pin has no stamp, and used to act in whichever
// workspace its person had selected at each call. It is stamped ONCE with the
// workspace its person has selected RIGHT NOW (where it acts today), or with
// their own workspace when they have none selected or are no longer a member of
// the one they had (removed_at is set), so nothing changes workspace overnight
// and owners see these connections. Only unstamped rows are touched, so a second
// boot, or a person who has since switched, changes nothing.
const STAMP_HOSTED_GRANTS_SQL = `
  UPDATE api_keys k
     SET oauth_workspace_key = COALESCE(
           (SELECT m.owner_key FROM workspace_members m
             WHERE m.user_id = k.owner_id AND m.is_active AND m.removed_at IS NULL
             LIMIT 1),
           (SELECT u.org_id FROM users u WHERE u.user_id = k.owner_id),
           k.org_id)
   WHERE k.oauth_resource IS NOT NULL
     AND k.oauth_workspace_key IS NULL
     AND k.status = 'active'`;

async function backfillHostedConnectionWorkspaces() {
    await require('../services/workspaceService').ensureSchema();
    const result = await db.query(STAMP_HOSTED_GRANTS_SQL, [], 'org-system');
    return result.rowCount || 0;
}

// The refresh records (Redis) of those same grants, stamped from the access key
// each last minted, or from the person when that key is gone. Not in the boot
// transaction: Redis is not part of it, and a record this misses is stamped from
// its key the next time it is refreshed (routes/oauth.js).
async function backfillRefreshRecordWorkspaces() {
    const { redis } = require('./redis');
    const workspaceService = require('../services/workspaceService');
    const orgs = await db.query(
        'SELECT DISTINCT org_id FROM api_keys WHERE oauth_resource IS NOT NULL AND org_id IS NOT NULL',
        [],
        'org-system'
    );
    let stamped = 0;
    for (const { org_id: orgId } of orgs.rows) {
        for (const tokenKey of (await redis.smembers(`oauth:refresh:owner:${orgId}`)) || []) {
            const raw = await redis.get(tokenKey);
            if (!raw) continue;
            let record;
            try { record = JSON.parse(raw); } catch { continue; }
            if (!record || record.workspace_key) continue;
            let key = null;
            if (record.access_key_hash) {
                const found = await db.query(
                    'SELECT oauth_workspace_key FROM api_keys WHERE key_hash = $1 AND oauth_resource IS NOT NULL',
                    [record.access_key_hash],
                    'org-system'
                );
                key = found.rows[0]?.oauth_workspace_key || null;
            }
            if (!key) key = await workspaceService.selectedWorkspaceKeyForPerson(record.owner_id);
            if (!key) continue;
            // KEEPTTL: stamping must not extend how long a refresh token lives.
            // XX: and must not bring one back. The record was read above; if a
            // rotation or a disconnect deleted it since, a plain SET would
            // resurrect a retired token with no expiry at all.
            const written = await redis.set(tokenKey, JSON.stringify({ ...record, workspace_key: key }), 'KEEPTTL', 'XX');
            if (written !== 'OK') continue;
            stamped += 1;
        }
    }
    return stamped;
}

async function runAutoMigration() {
    console.log('[BOOT] Checking for required migrations...');

    // The context_* tables are owned by contextSyncStore.ensureSchema(), not by schema.sql
    // or by this file. Several ALTERs below target them, so on a fresh database (where no
    // request has yet triggered the lazy bootstrap) those statements would abort the whole
    // single-transaction migration and silently roll back every unrelated change with it.
    // Create them first so this migration has a schema to alter.
    const { ensureSchema } = require('../store/contextSyncStore');
    await ensureSchema();
    // workspace_members is owned by workspaceService, and the hosted-connection
    // stamp below reads it.
    await require('../services/workspaceService').ensureSchema();

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // TWO MACHINES BOOT TOGETHER ON EVERY DEPLOY.
        //
        // Without this, both read "not applied yet" from the catalog and from
        // the marker table, and both run the repair: the second blocks on the
        // first's row and table locks, then does all of it again. One boot at a
        // time runs the body; the other waits here, then finds everything
        // applied and changes nothing. It is an advisory lock, so it blocks only
        // other boots, never a request. The wait is bounded by the pool's
        // statement_timeout: a boot that cannot get it fails, reports 503 on
        // its readiness probe and is restarted, which is what a boot blocked on
        // a table lock already did.
        await client.query('SELECT pg_advisory_xact_lock($1)', [AUTO_MIGRATE_LOCK_KEY]);

        // The marker table for one-time data repairs. Created first so every
        // step below can consult it.
        await client.query(`
      CREATE TABLE IF NOT EXISTS context_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

        // Add billing fields to organizations if they don't exist
        await addMissingColumns(client, 'organizations', [
            ['plan_tier', 'VARCHAR(50) DEFAULT \'free\''],
            ['pending_plan', 'VARCHAR(50)'],
            ['invite_code', 'TEXT UNIQUE'],
            ['onboarding_template', 'VARCHAR(50)'],
            ['stripe_customer_id', 'VARCHAR(255)'],
            ['stripe_subscription_id', 'VARCHAR(255)'],
            ['billing_cycle_anchor', 'TIMESTAMPTZ DEFAULT NOW()'],
            ['billing_period_start', 'TIMESTAMPTZ'],
            ['billing_period_end', 'TIMESTAMPTZ'],
            ['redaction_mode', 'VARCHAR(50) DEFAULT \'strict\' CHECK (redaction_mode IN (\'strict\', \'permissive\'))'],
            ['redaction_keys', 'TEXT[] DEFAULT \'{}\''],
            ['is_pilot', 'BOOLEAN DEFAULT FALSE'],
            ['pilot_ends_at', 'TIMESTAMPTZ'],
            ['is_locked', 'BOOLEAN DEFAULT FALSE'],
            ['shadow_mode', 'BOOLEAN DEFAULT FALSE'],
            ['fail_mode', 'VARCHAR(50) DEFAULT \'closed\' CHECK (fail_mode IN (\'open\', \'closed\'))'],
            ['trial_ends_at', 'TIMESTAMPTZ'],
            ['account_type', 'VARCHAR(50) DEFAULT \'organization\' CHECK (account_type IN (\'organization\', \'personal\'))'],
            // 'trial_active' is canonical (matches sql/schema.sql). This previously defaulted to
            // 'active', so the two sources of truth disagreed about whether a new org starts in
            // trial; an org created on a path that used this default would skip the trial flow.
            ['subscription_status', 'VARCHAR(50) DEFAULT \'trial_active\''],
            ['referral_premium_until', 'TIMESTAMPTZ'],
            // When a lifetime (one-off payment) purchase was applied. Written by
            // the Stripe webhook's lifetime checkout path; until now only
            // scripts/migrate-ltd.js created it, so on a database that never
            // ran that script the write answered 500. Nullable: nearly every
            // workspace has no lifetime purchase.
            ['lifetime_activated_at', 'TIMESTAMPTZ'],
            // When the workspace's Team trial started, from Stripe's subscription
            // (webhooks-stripe.js). NULL = never had one. One trial per workspace.
            ['team_trial_started_at', 'TIMESTAMPTZ'],
            // The dispute lock: its own column, apart from is_locked (the owner's
            // lockdown switch). See sql/schema.sql.
            ['dispute_lock_ids', 'TEXT[] NOT NULL DEFAULT \'{}\''],
            ['dispute_locked_at', 'TIMESTAMPTZ'],
            // WHO PAYS, AND WHAT THEY PAY (journey r6, billing). All nullable, no
            // default, no backfill: NULL is "not on record", which is never read as
            // an answer (see services/billingOwnerService.js and
            // services/billingRecord.js). They go with the org row when it is deleted.
            //  billing_owner_user_id  the person whose card the subscription renews
            //                         on, as far as DeerDawn can tell; NULL = unknown,
            //                         which refuses nobody.
            //  billing_takeover       { user_id, started_at, payment_methods[] }: an
            //                         owner's takeover of billing in progress.
            ['billing_owner_user_id', 'TEXT'],
            ['billing_takeover', 'JSONB'],
            //  cancel_at_period_end / cancel_at  Stripe's pending cancellation.
            //  price_*                           the price the subscription is billed
            //                                    at, from Stripe (cents per seat).
            ['cancel_at_period_end', 'BOOLEAN'],
            ['cancel_at', 'TIMESTAMPTZ'],
            ['price_unit_amount_cents', 'INT'],
            ['price_currency', 'TEXT'],
            ['price_interval', 'TEXT'],
            ['price_interval_count', 'INT'],
            // The episode markers behind "once per episode": set when the owner is
            // emailed, cleared when the episode ends (services/billingNoticeService.js).
            ['overdue_notified_at', 'TIMESTAMPTZ'],
            ['seat_shortfall_notified_at', 'TIMESTAMPTZ'],
        ]);

        // A workspace that had a Team trial BEFORE the column existed. Once: the
        // webhook records every trial from here on.
        if (!(await migrationDone(client, 'organizations_team_trial_started_at_backfill_v1'))) {
            await backfillTeamTrialStartedAt(client);
            await markMigrationDone(client, 'organizations_team_trial_started_at_backfill_v1');
        }

        await addMissingColumns(client, 'users', [
            ['referral_code', 'TEXT'],
            ['weekly_digest_unsubscribed', 'BOOLEAN NOT NULL DEFAULT FALSE'],
        ]);

        await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code_unique
      ON users (referral_code)
      WHERE referral_code IS NOT NULL;
    `);

        await client.query(`
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
        reward_expires_at TIMESTAMPTZ,
        activated_at TIMESTAMPTZ,
        rewarded_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

        await client.query(`
      DO $$ BEGIN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE referrals TO %I', current_user);
      END $$;
    `);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_referrals_referrer_user
      ON referrals (referrer_user_id, created_at DESC);
    `);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_referrals_referred_user
      ON referrals (referred_user_id, created_at DESC);
    `);

        // One referral per referred account, enforced by the DB. Without this, the
        // check-then-insert in maybeRecordReferralSignup (routes/shared/orgs.js) was a plain
        // TOCTOU race: concurrent requests with the same code created duplicate rows, and
        // activateReferralForActor consumes one row per invocation with an ADDITIVE reward —
        // so a single genuine referral could be redeemed repeatedly for +30d Pro each time.
        // De-duplicate any rows a previous deploy already accepted before adding the index,
        // keeping the oldest (the one activation would have consumed first).
        await client.query(`
      DELETE FROM referrals a
       USING referrals b
       WHERE a.referred_user_id = b.referred_user_id
         AND a.referred_org_id  = b.referred_org_id
         AND (a.created_at > b.created_at
              OR (a.created_at = b.created_at AND a.referral_id > b.referral_id));
    `);

        await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_referred_unique
      ON referrals (referred_user_id, referred_org_id);
    `);

        await addMissingColumns(client, 'api_keys', [
            ['last_used_at', 'TIMESTAMPTZ'],
            ['expires_at', 'TIMESTAMPTZ'],
            ['oauth_resource', 'TEXT'],
            // Which client this token was issued to. A refresh grant mints a NEW
            // key row, so the key id cannot identify a connection that outlives
            // one token, and the hosted session a project binding hangs off is
            // per connection. See services/hostedSessionIdentity.js.
            ['oauth_client_id', 'TEXT'],
            ['oauth_client_name', 'TEXT'],
            // The workspace the person was working in when they approved the
            // connection (see sql/schema.sql).
            ['oauth_workspace_key', 'TEXT'],
        ]);
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_api_keys_oauth_workspace
      ON api_keys (oauth_workspace_key) WHERE oauth_workspace_key IS NOT NULL;
    `);
        // Grants from before a connection was pinned to a workspace: stamp each
        // with where it acts today. Idempotent by its own predicate.
        await client.query(STAMP_HOSTED_GRANTS_SQL);

        // Create usage_counters table
        await client.query(`
      CREATE TABLE IF NOT EXISTS usage_counters (
        org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
        period_start TIMESTAMPTZ NOT NULL,
        period_end TIMESTAMPTZ NOT NULL,
        decisions_count BIGINT DEFAULT 0,
        reported_overage_count BIGINT DEFAULT 0,
        last_updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (org_id, period_start)
      );
    `);

        await addMissingColumns(client, 'policies', [
            ['hit_count', 'INTEGER DEFAULT 0'],
            ['last_hit_at', 'TIMESTAMPTZ'],
        ]);

        await addMissingColumns(client, 'decisions', [
            ['latency_ms', 'INTEGER'],
        ]);

        if (await constraintDefinition(client, 'decisions', 'decisions_trace_id_key')) {
            await client.query(`
      ALTER TABLE decisions
      DROP CONSTRAINT IF EXISTS decisions_trace_id_key;
    `);
        }

        await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_org_env_trace
      ON decisions (org_id, environment, trace_id);
    `);

        await client.query(`
      CREATE TABLE IF NOT EXISTS stripe_events (
        event_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'processing',
        processed_at TIMESTAMPTZ,
        error TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

        await client.query(`
      CREATE TABLE IF NOT EXISTS access_logs (
        access_id TEXT PRIMARY KEY,
        org_id TEXT REFERENCES organizations(org_id) ON DELETE SET NULL,
        actor_id TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        ip TEXT,
        user_agent TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_access_logs_org_created_at
      ON access_logs (org_id, created_at DESC);
    `);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_access_logs_actor_created_at
      ON access_logs (actor_id, created_at DESC);
    `);

        await client.query(`
      CREATE TABLE IF NOT EXISTS system_health_log (
        log_id TEXT PRIMARY KEY,
        metric_name TEXT NOT NULL,
        metric_value DOUBLE PRECISION NOT NULL,
        metadata JSONB DEFAULT '{}'::jsonb,
        org_id TEXT REFERENCES organizations(org_id) ON DELETE SET NULL,
        timestamp TIMESTAMPTZ DEFAULT NOW()
      );
    `);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_system_health_log_timestamp
      ON system_health_log (timestamp DESC);
    `);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_system_health_log_metric_timestamp
      ON system_health_log (metric_name, timestamp DESC);
    `);

        await client.query(`
      CREATE TABLE IF NOT EXISTS product_events (
        event_id UUID PRIMARY KEY,
        event_name TEXT NOT NULL,
        org_id TEXT REFERENCES organizations(org_id) ON DELETE SET NULL,
        user_id TEXT REFERENCES users(user_id) ON DELETE SET NULL,
        session_id TEXT,
        source TEXT NOT NULL,
        surface TEXT,
        path TEXT,
        started_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ,
        duration_ms INTEGER,
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

        // Which tool and how it connects, apart from `surface` (see schema.sql).
        await addMissingColumns(client, 'product_events', [['tool', 'TEXT'], ['transport', 'TEXT']]);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_product_events_org_created
      ON product_events (org_id, created_at DESC);
    `);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_product_events_org_name_created
      ON product_events (org_id, event_name, created_at DESC);
    `);

        // Per-user lookups for the day-two catch-up queries, which filter on
        // (org_id = $1 OR user_id = $2). Without a user_id index the user arm
        // seq-scans the unbounded product_events table on every session start.
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_product_events_user_created
      ON product_events (user_id, created_at DESC);
    `);

        // "Why are you using DeerDawn" onboarding questionnaire responses.
        // One row per user (upserted), captured during onboarding for product insight.
        await client.query(`
      CREATE TABLE IF NOT EXISTS onboarding_responses (
        user_id     TEXT PRIMARY KEY,
        org_id      TEXT REFERENCES organizations(org_id) ON DELETE CASCADE,
        role        TEXT,
        primary_use TEXT,
        tools       TEXT[] DEFAULT '{}',
        team_size   TEXT,
        motivation  TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_onboarding_responses_org
      ON onboarding_responses (org_id, created_at DESC);
    `);

        await client.query(`
      CREATE TABLE IF NOT EXISTS context_audit_logs (
        audit_id TEXT PRIMARY KEY,
        owner_key TEXT NOT NULL,
        project_id TEXT,
        action TEXT NOT NULL,
        actor_type TEXT DEFAULT 'user',
        tool TEXT,
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

        // Who did it, not just that it happened. A shared workspace's audit log
        // is read BY PERSON ("has anyone outside the team opened this?"), which
        // the owner_key-leading index cannot serve — hence its own index rather
        // than a filter over the one above.
        await addMissingColumns(client, 'organizations', [['purchased_seats', 'INT']]);

        // The compare-and-swap counter. ensureSchema() adds it too; mirrored here
        // so a boot that has already bootstrapped the context tables still gets
        // it, and so `npm run migrate` is not the only path that does.
        await addMissingColumns(client, 'context_projects', [['context_version', 'BIGINT NOT NULL DEFAULT 0']]);

        // The evidence excerpt's kind ('derived' from the day the graph stopped
        // storing conversation text; NULL before). ensureSchema() adds it too;
        // mirrored for the same reason as context_version. Nullable with no
        // default, so adding it rewrites nothing and changes no existing row.
        // Adding a column is all a boot does here: REMOVING the stored excerpts
        // is scripts/purge-raw-excerpts.js, which the owner runs by hand and
        // which nothing at boot, in the scheduler, in CI or at deploy may call.
        await addMissingColumns(client, 'context_graph_evidence', [['excerpt_kind', 'TEXT']]);

        await addMissingColumns(client, 'context_audit_logs', [['actor_user_id', 'TEXT']]);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_context_audit_logs_owner_created
      ON context_audit_logs(owner_key, created_at DESC);
    `);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_context_audit_logs_owner_actor
      ON context_audit_logs(owner_key, actor_user_id, created_at DESC);
    `);

        await client.query(`
      CREATE TABLE IF NOT EXISTS workspace_members (
        owner_key  TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        role       TEXT NOT NULL DEFAULT 'member',
        invited_by TEXT,
        joined_at  TIMESTAMPTZ DEFAULT NOW(),
        removed_at TIMESTAMPTZ,
        PRIMARY KEY (owner_key, user_id)
      );
    `);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_workspace_members_user
      ON workspace_members (user_id) WHERE removed_at IS NULL;
    `);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_workspace_members_owner_active
      ON workspace_members (owner_key) WHERE removed_at IS NULL;
    `);

        // Every user already belongs to exactly one org, so membership starts as
        // a projection of that rather than as an empty table nobody is in.
        await client.query(`
      INSERT INTO workspace_members (owner_key, user_id, role, joined_at)
      SELECT u.org_id, u.user_id,
             CASE WHEN u.role IN ('owner', 'admin') THEN 'owner'
                  WHEN u.role IN ('read-only') THEN 'viewer'
                  ELSE 'member' END,
             u.created_at
        FROM users u
       WHERE u.org_id IS NOT NULL
         -- Deliberately NOT marker-gated: the Clerk webhook and JIT provisioning
         -- both name this statement as the safety net for a membership write
         -- that failed after its transaction committed, so it has to keep
         -- running. The anti-join makes the steady state one hash pass that
         -- proposes zero rows, instead of one speculative insert per user.
         -- Any existing row counts, including a soft-removed one: a removed
         -- member must not be re-added by a restart.
         AND NOT EXISTS (
               SELECT 1 FROM workspace_members m
                WHERE m.owner_key = u.org_id AND m.user_id = u.user_id)
      ON CONFLICT (owner_key, user_id) DO NOTHING;
    `);

        // ATTRIBUTION REPAIR — rows that name a credential where they mean a person.
        //
        // RUNS ONCE, NOT ON EVERY BOOT. These are three unbounded UPDATEs joined on
        // columns that lead no index, inside the migration transaction, under a
        // statement timeout, with a catch that rolls back and rethrows. They are a
        // one-time repair of historical rows, but they were re-executed on every
        // start — so as the tables grow the cost grows with them, and the first
        // boot that exceeds the timeout fails, rolls back, and the next boot
        // retries exactly the same work. A permanent 503 loop that gets worse
        // rather than self-healing.
        //
        // A marker row makes it idempotent for real instead of by accident.
        // (context_migrations itself is now created at the top of this
        // transaction, so the later one-time repairs can consult it too.)
        const attributionDone = await client.query(
            'SELECT 1 FROM context_migrations WHERE name = \'attribution_key_to_person_v1\''
        );
        if (attributionDone.rows.length === 0) {
        //
        // Every attribution site used `actor.id`, which is the user id for a
        // dashboard request but the API KEY id for a key-authed one. Since nearly
        // all writes arrive over MCP, most stored attribution points at a key.
        // That made listProjectContributors count keys and call them teammates,
        // and it would make the new visibility filter hide a person's own
        // projects from them the moment they rotated a key.
        //
        // Map key ids back to their owner where the key still exists.
        await client.query(`
      UPDATE context_projects p
         SET owner_user_id = k.owner_id
        FROM api_keys k
       WHERE p.owner_user_id = k.key_id
         AND k.owner_id IS NOT NULL;
    `);

        await client.query(`
      UPDATE context_events e
         SET contributing_user_id = k.owner_id
        FROM api_keys k
       WHERE e.contributing_user_id = k.key_id
         AND k.owner_id IS NOT NULL;
    `);

        // What remains points at a key that has since been deleted, so the person
        // is unrecoverable. Null it rather than leaving a dangling id: NULL means
        // "belongs to the workspace" and is resolved to the founding owner by
        // workspaceService.backfillProjectOwnership the moment a second member
        // joins. A dangling id would instead make the project invisible to
        // everyone, including the person who created it.
        await client.query(`
      UPDATE context_projects p
         SET owner_user_id = NULL
       WHERE p.owner_user_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = p.owner_user_id);
    `);

            await client.query(
                'INSERT INTO context_migrations (name) VALUES (\'attribution_key_to_person_v1\') ON CONFLICT DO NOTHING'
            );
        }

        await client.query(`
      CREATE TABLE IF NOT EXISTS context_integrations (
        integration_id TEXT PRIMARY KEY,
        owner_key TEXT NOT NULL,
        provider TEXT NOT NULL,
        encrypted_key TEXT,
        agent_id TEXT,
        agent_url TEXT,
        meta JSONB DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ctx_integrations_owner
      ON context_integrations(owner_key);
    `);

        await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ctx_integrations_owner_provider
      ON context_integrations(owner_key, provider);
    `);

        await client.query(`
      CREATE TABLE IF NOT EXISTS user_encryption_keys (
        owner_key TEXT PRIMARY KEY,
        encrypted_dek TEXT NOT NULL,
        dek_version INT NOT NULL DEFAULT 1,
        encrypted_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

        await client.query(`
      CREATE TABLE IF NOT EXISTS escalation_resolutions (
        resolution_id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL,
        status TEXT CHECK (status IN ('pending', 'approved', 'denied')) NOT NULL DEFAULT 'pending',
        approver_id TEXT,
        approver_email TEXT,
        justification TEXT,
        sla_minutes INTEGER DEFAULT 240,
        sla_deadline TIMESTAMPTZ,
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        org_id TEXT NOT NULL
      );
    `);

        await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_escalation_resolutions_decision_unique
      ON escalation_resolutions(decision_id);
    `);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_escalation_resolutions_status
      ON escalation_resolutions(status);
    `);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_escalation_resolutions_org
      ON escalation_resolutions(org_id);
    `);

        // Performance indexes for common dashboard queries.
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_org_created_at
      ON users (org_id, created_at DESC);
    `);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_integrations_org_created_at
      ON integrations (org_id, created_at DESC);
    `);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_integrations_org_type_created_at
      ON integrations (org_id, type, created_at DESC);
    `);

        // Used by duplicate check: WHERE org_id = $1 AND (config->>'name') = $2
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_integrations_org_name
      ON integrations (org_id, (config->>'name'));
    `);
    
        // Create Leads table (from separate migration)
        await client.query(`
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
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

        await addMissingColumns(client, 'leads', [
            ['source_route', 'TEXT'],
            ['source_type', 'TEXT'],
            ['campaign', 'TEXT'],
            ['resource_type', 'TEXT'],
            ['tool_type', 'TEXT'],
            ['metadata', 'JSONB DEFAULT \'{}\'::jsonb'],
        ]);

        await client.query(`
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
        published_at TIMESTAMPTZ,
        scheduled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (content_type, slug)
      );
    `);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_content_pages_public
      ON content_pages (content_type, status, published_at DESC);
    `);
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_content_pages_slug
      ON content_pages (content_type, slug);
    `);

        await client.query(`
      CREATE TABLE IF NOT EXISTS content_versions (
        version_id UUID PRIMARY KEY,
        content_id UUID NOT NULL REFERENCES content_pages(content_id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL,
        snapshot JSONB NOT NULL,
        created_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (content_id, version_number)
      );
    `);

        await client.query(`
      CREATE TABLE IF NOT EXISTS content_assets (
        asset_id UUID PRIMARY KEY,
        content_id UUID REFERENCES content_pages(content_id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        url TEXT NOT NULL,
        alt_text TEXT,
        asset_type TEXT DEFAULT 'download',
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

        await client.query(`
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
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_lead_events_source
      ON lead_events (source_type, source_route, created_at DESC);
    `);

        await client.query(`
      CREATE TABLE IF NOT EXISTS tool_submissions (
        submission_id UUID PRIMARY KEY,
        tool_type TEXT NOT NULL CHECK (tool_type IN ('risk_calculator', 'policy_generator', 'roi_calculator')),
        email VARCHAR(255),
        source_route TEXT,
        inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
        outputs JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tool_submissions_tool_created
      ON tool_submissions (tool_type, created_at DESC);
    `);

        // LEGACY PLAN NAMES -> CANONICAL. A one-time rename of rows written before
        // the plan ids settled, and it was a sequential scan of `organizations`
        // on three unindexed columns on every boot to find, every time, nothing.
        // Safe to stop repeating: plans.js PLAN_ALIASES maps every one of these
        // names forward on READ, so a legacy value that somehow reappears still
        // resolves to the same plan. It just is not rewritten at boot.
        if (!(await migrationDone(client, 'organizations_legacy_plan_names_v1'))) {
            await client.query(`
          UPDATE organizations
          SET plan = CASE
            WHEN plan IN ('standard', 'starter_cx') THEN 'starter'
            WHEN plan IN ('growth_cx') THEN 'growth'
            WHEN plan IN ('scale_cx') THEN 'scale'
            WHEN plan IN ('refund_gate_pilot') THEN 'pilot'
            WHEN plan IN ('personal_basic') THEN 'developer_basic'
            WHEN plan IN ('personal_developer') THEN 'developer_pro'
            WHEN plan IN ('pro') THEN 'enterprise'
            ELSE plan
          END,
          plan_tier = CASE
            WHEN plan_tier IN ('standard', 'starter_cx') THEN 'starter'
            WHEN plan_tier IN ('growth_cx') THEN 'growth'
            WHEN plan_tier IN ('scale_cx') THEN 'scale'
            WHEN plan_tier IN ('refund_gate_pilot') THEN 'pilot'
            WHEN plan_tier IN ('personal_basic') THEN 'developer_basic'
            WHEN plan_tier IN ('personal_developer') THEN 'developer_pro'
            WHEN plan_tier IN ('pro') THEN 'enterprise'
            ELSE plan_tier
          END,
          pending_plan = CASE
            WHEN pending_plan IN ('standard', 'starter_cx') THEN 'starter'
            WHEN pending_plan IN ('growth_cx') THEN 'growth'
            WHEN pending_plan IN ('scale_cx') THEN 'scale'
            WHEN pending_plan IN ('refund_gate_pilot') THEN 'pilot'
            WHEN pending_plan IN ('personal_basic') THEN 'developer_basic'
            WHEN pending_plan IN ('personal_developer') THEN 'developer_pro'
            WHEN pending_plan IN ('pro') THEN 'enterprise'
            ELSE pending_plan
          END
          WHERE plan IN ('standard', 'starter_cx', 'growth_cx', 'scale_cx', 'refund_gate_pilot', 'personal_basic', 'personal_developer', 'pro')
             OR plan_tier IN ('standard', 'starter_cx', 'growth_cx', 'scale_cx', 'refund_gate_pilot', 'personal_basic', 'personal_developer', 'pro')
             OR pending_plan IN ('standard', 'starter_cx', 'growth_cx', 'scale_cx', 'refund_gate_pilot', 'personal_basic', 'personal_developer', 'pro');
        `);
            await markMigrationDone(client, 'organizations_legacy_plan_names_v1');
        }

        // Add org_id to context sync tables so cleanup queries work across all test suites.
        // These tables use owner_key for business logic; org_id is a cleanup/query convenience.
        for (const table of [
            'context_projects', 'context_events', 'context_sessions',
            'context_graph_edges', 'context_graph_nodes', 'context_graph_evidence',
            'injection_preferences', 'leads', 'lead_events',
        ]) {
            await addMissingColumns(client, table, [['org_id', 'TEXT']]);
        }

        // AUTHZ hardening (idempotent): add the platform-staff capability, widen the role CHECK to
        // the org-scoped taxonomy, downgrade legacy platform-'admin'-by-default users to org 'owner',
        // and seed platform staff strictly from the PLATFORM_ADMIN_EMAILS allowlist.
        await addMissingColumns(client, 'users', [['is_platform_staff', 'BOOLEAN NOT NULL DEFAULT FALSE']]);

        // The role CHECK used to be dropped and re-added unconditionally: ACCESS
        // EXCLUSIVE on `users` plus a validating scan of every row, on every
        // boot, on the table every authenticated request reads. Swap it only
        // when the constraint that exists does not already admit every role in
        // the taxonomy. Compared by CONTENT (pg_get_constraintdef), not by
        // name, so a database still carrying the old narrower CHECK under the
        // same name is corrected rather than skipped.
        const REQUIRED_ROLES = ['owner', 'member', 'read-only', 'admin', 'operator', 'approver'];
        const roleCheck = await constraintDefinition(client, 'users', 'users_role_check');
        if (!roleCheck || !REQUIRED_ROLES.every((role) => roleCheck.includes(`'${role}'`))) {
            await client.query(`
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
      ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner', 'member', 'read-only', 'admin', 'operator', 'approver'));
    `);
        }

        // One-time downgrade of the legacy platform-'admin'-by-default rows. Not
        // an invariant: 'admin' remains a VALID org-scoped role with exactly
        // owner's scopes (see middleware/auth.js ROLE_SCOPES), so a row that
        // carries it later is not a privilege problem, and rewriting it at every
        // boot was a sequential scan of `users` that found nothing.
        if (!(await migrationDone(client, 'users_admin_role_to_owner_v1'))) {
            await client.query(`
      UPDATE users SET role = 'owner' WHERE role = 'admin';
    `);
            await markMigrationDone(client, 'users_admin_role_to_owner_v1');
        }
        const platformAdminEmails = (process.env.PLATFORM_ADMIN_EMAILS || '')
            .split(',')
            .map((e) => e.trim().toLowerCase())
            .filter(Boolean);
        if (platformAdminEmails.length > 0) {
            await client.query(
                // Runs every boot ON PURPOSE: the allowlist is an env var and can
                // change between deploys, so there is no "done". What it must not
                // do is rewrite the rows that are already correct, which is what
                // it did: every staff row got a new version on every start.
                'UPDATE users SET is_platform_staff = TRUE WHERE lower(email) = ANY($1::text[]) AND is_platform_staff IS DISTINCT FROM TRUE;',
                [platformAdminEmails]
            );
        }
        // Normalize any tenant api_keys carrying a wildcard scope to the explicit context:* set.
        //
        // Also every boot on purpose, and also already a no-op when clean: this
        // is a SECURITY invariant (no tenant credential holds '*'), not a
        // historical repair, so a marker would turn "never" into "not as of the
        // day the marker was written". The predicate matches only offending
        // rows, so a clean table is read and not written.
        await client.query(`
      UPDATE api_keys
         SET scopes = ARRAY['context:read','context:write','context:admin']
       WHERE scopes @> ARRAY['*'];
    `);

        // Shared skills (markdown know-how) distributed across connected tools.
        // project_id NULL = workspace-wide; UNIQUE(owner_key, slug) keeps one slug
        // per owner regardless of scope.
        await client.query(`
      CREATE TABLE IF NOT EXISTS workspace_skills (
        skill_id    TEXT PRIMARY KEY,
        owner_key   TEXT NOT NULL,
        project_id  TEXT REFERENCES context_projects(project_id) ON DELETE CASCADE,
        slug        TEXT NOT NULL,
        name        TEXT NOT NULL,
        description TEXT DEFAULT '',
        markdown_content TEXT NOT NULL,
        visibility  TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','shared','public')),
        enabled     BOOLEAN NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (owner_key, slug)
      );
    `);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_workspace_skills_owner
      ON workspace_skills(owner_key, enabled);
    `);

        // WHO WROTE THIS SKILL.
        //
        // A skill is agent INSTRUCTIONS handed to every session in the workspace,
        // so "may write skills" and "may replace the skill somebody else wrote"
        // are different questions, and the table could not tell them apart: with
        // no author on the row, every teammate's write was indistinguishable from
        // the author's own. NULL means the row predates attribution and belongs
        // to the workspace as a whole — the same convention context_projects
        // uses for owner_user_id.
        await addMissingColumns(client, 'workspace_skills', [['created_by', 'TEXT']]);

        // The weekly digest's per-recipient sent marker. See
        // services/email/weeklyDigest.js for why a Redis lock was never enough.
        // Mirrored there (CREATE IF NOT EXISTS) for scripts that never boot.
        await client.query(`
      CREATE TABLE IF NOT EXISTS weekly_digest_sends (
        user_id      TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
        claimed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_sent_at TIMESTAMPTZ,
        sends        INTEGER NOT NULL DEFAULT 0
      );
    `);

        // The per-workspace successor: the digest goes to every member of a team,
        // one email per person per workspace, on a fixed weekly slot. See
        // services/email/weeklyDigest.js. Rows carry over from the table above.
        await client.query(`
      CREATE TABLE IF NOT EXISTS weekly_digest_workspace_sends (
        user_id      TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        owner_key    TEXT NOT NULL,
        claimed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_sent_at TIMESTAMPTZ,
        sends        INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, owner_key)
      );
    `);

        // One email when auto-archive happens: a claim row per (person, project,
        // archive moment) so the same archive is never announced twice. See
        // services/email/autoArchiveNotice.js.
        await client.query(`
      CREATE TABLE IF NOT EXISTS project_archive_notices (
        user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        project_id  TEXT NOT NULL,
        archived_at TIMESTAMPTZ NOT NULL,
        sent_at     TIMESTAMPTZ,
        PRIMARY KEY (user_id, project_id, archived_at)
      );
    `);

        // One content-free row per person, per UTC day, per tool, per client: the
        // only record that a read-only tool call (recall, read_tasks, ...) happened.
        // No arguments, no results. See services/toolUsageDays.js, which mirrors
        // this for scripts that never boot.
        await client.query(`
      CREATE TABLE IF NOT EXISTS tool_usage_days (
        user_id   TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        day       DATE NOT NULL,
        tool_name TEXT NOT NULL,
        client    TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (user_id, day, tool_name, client)
      );
    `);

        // The morning-after brief email (Thing 3f): one row per person, ever.
        // brief_sent_at / reminder_sent_at are the at-most-once claims. See
        // services/email/morningAfterBrief.js, which mirrors this.
        await client.query(`
      CREATE TABLE IF NOT EXISTS morning_after_brief_sends (
        user_id          TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
        project_id       TEXT,
        owner_key        TEXT,
        save_day         DATE,
        brief_claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        brief_sent_at    TIMESTAMPTZ,
        reminder_claimed_at TIMESTAMPTZ,
        reminder_sent_at TIMESTAMPTZ
      );
    `);

        // The value-ladder emails: one claim row per person per email type, ever.
        // See services/email/valueLadder.js, which mirrors this.
        await client.query(`
      CREATE TABLE IF NOT EXISTS value_ladder_sends (
        user_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        email_type TEXT NOT NULL,
        claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sent_at    TIMESTAMPTZ,
        PRIMARY KEY (user_id, email_type)
      );
    `);

        // ── A connector's registration must outlive the cache ────────────────────
        //
        // OAuth DCR registrations lived only in Redis, so a restart, a failover
        // or a maxmemory eviction silently deleted every connector's identity —
        // surfacing to the user as `invalid_client: unknown client_id
        // (re-register the connector)` on a connector they installed weeks ago.
        // Clients never re-register on their own: the issued client_id is
        // written into local config (~/.codex, Claude Code) and resent forever,
        // so that error is a dead end only a manual reinstall escapes.
        //
        // See apps/api/src/store/oauthClientStore.js. Redis is now a cache in
        // front of this table, and this table is the record.
        await client.query(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        redirect_uris TEXT[] NOT NULL,
        client_name TEXT,
        registration_type TEXT NOT NULL DEFAULT 'dcr',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ
      );
    `);

        // ── Deleting a user must actually be possible ────────────────────────────
        //
        // Two foreign keys referenced users(user_id) with NO ON DELETE clause, so
        // `DELETE FROM users` raised a violation for any user who had ever held an
        // API key. That is not a corner case: it is the Clerk `user.deleted`
        // webhook's first write, so the handler 500'd, Clerk retried forever, and
        // the users row survived pointing at an auth_subject that no longer
        // existed. Every subsequent sign-in with that email then hit the
        // account-takeover guard, fell through to an INSERT that violated
        // users_email_key, and 401'd — surfacing to the user as an endless
        // "your session expired" loop.
        //
        // Measured 2026-08-30: EVERY failed delivery on the Clerk endpoint was a
        // user.deleted (27% error rate, the same message ids retried eight times),
        // and one of them was the only paying customer, locked out for ~19 days.
        //
        // It also silently broke right-to-erasure: the GDPR path 500s and the data
        // stays. product_events already had ON DELETE SET NULL, which is the tell
        // that these two were oversights rather than decisions.
        //
        // An api key without an owner is meaningless, so it goes with them.
        //
        // Swapped only when the constraint that exists is not already the one
        // wanted. The unconditional DROP + ADD took ACCESS EXCLUSIVE on
        // api_keys AND a lock on users, then re-validated every key against
        // every user while holding both: the two tables requireAuth reads on
        // each request, locked together on each boot of each machine.
        const apiKeysFk = await constraintDefinition(client, 'api_keys', 'api_keys_owner_id_fkey');
        if (!apiKeysFk || !/ON DELETE CASCADE/i.test(apiKeysFk)) {
            await client.query(`
      ALTER TABLE api_keys
      DROP CONSTRAINT IF EXISTS api_keys_owner_id_fkey;
    `);
            await client.query(`
      ALTER TABLE api_keys
      ADD CONSTRAINT api_keys_owner_id_fkey
      FOREIGN KEY (owner_id) REFERENCES users(user_id) ON DELETE CASCADE;
    `);
        }

        // An enterprise inquiry is a business record that outlives the account that
        // raised it, so the row stays and loses its author rather than vanishing.
        const inquiriesFk = await constraintDefinition(client, 'enterprise_inquiries', 'enterprise_inquiries_user_id_fkey');
        if (!inquiriesFk || !/ON DELETE SET NULL/i.test(inquiriesFk)) {
            await client.query(`
      ALTER TABLE enterprise_inquiries
      DROP CONSTRAINT IF EXISTS enterprise_inquiries_user_id_fkey;
    `);
            await client.query(`
      ALTER TABLE enterprise_inquiries
      ADD CONSTRAINT enterprise_inquiries_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL;
    `);
        }

        // The project-root re-key (graph_project_roots_by_id_v1) is a DATA repair
        // and no longer runs here: see runProjectRootMigration below, which
        // server.js starts after the runtime is ready.

        await client.query('COMMIT');
        console.log('[BOOT] Schema sync complete.');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[BOOT] Migration failed:', err);
        // Rethrow. This runs as ONE transaction, so a failure here rolls back every
        // statement in it — the instance would otherwise pass its readiness probe and serve
        // production traffic against a schema that is missing tables and columns. Let
        // server.js mark bootstrap failed so the readiness probe reports 503 instead.
        throw err;
    } finally {
        client.release();
    }
}

// ── Project root graph nodes: keyed by project id, not by name ──────────────
//
// A root node was `project:<name>`, so two projects with the same name in one
// workspace — a teammate's personal "Atlas" and the team's "Atlas" — were ONE
// row, and each project's readers were served the other's status text through
// it (graph, entities, exports, search, recall). New writes key by id
// (contextGraphService.projectRootKey); this splits the rows already written.
// See migrateNameKeyedProjectRoots for exactly which text survives.
//
// NOT IN THE BOOT TRANSACTION. It ran there once, under the boot advisory lock,
// and a large workspace took 20s+ of it: past the statement timeout a second
// machine's boot failed on the lock and restarted in a loop, an old machine's
// extraction upserts blocked on the root rows until COMMIT (tripping the 8s DB
// breaker mid rolling deploy), and a killed boot rolled the whole repair back
// with no marker, so it started again from nothing. So instead:
//   - it starts AFTER readiness (server.js does not await it);
//   - one short transaction per OWNER, so a row is locked for that owner's
//     split only, never for the whole pass;
//   - progress is the data itself: a finished owner has no legacy roots left,
//     so an interrupted pass resumes where it stopped instead of restarting;
//   - a per-owner advisory lock serialises two machines on the same owner — the
//     second waits for that one owner's transaction, then finds nothing to do;
//   - the marker is written only after a pass in which every owner succeeded,
//     and a failed owner is logged and retried by the next boot.
const PROJECT_ROOTS_MIGRATION = 'graph_project_roots_by_id_v1';
const PROJECT_ROOTS_LOCK_CLASS = 0x44443032; // 'DD02'

async function runProjectRootMigration({ log = console } = {}) {
    const poolQuery = (text, params) => db.pool.query(text, params);
    if ((await poolQuery('SELECT 1 FROM context_migrations WHERE name = $1', [PROJECT_ROOTS_MIGRATION])).rows.length) {
        return { skipped: true };
    }
    const graph = require('../services/contextGraphService');
    const owners = await graph.listOwnersWithLegacyProjectRoots(poolQuery);
    const totals = { owners: owners.length, failed: 0 };
    for (const ownerKey of owners) {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [PROJECT_ROOTS_LOCK_CLASS, ownerKey]);
            const stats = await graph.migrateProjectRootsForOwner((text, params) => client.query(text, params), ownerKey);
            await client.query('COMMIT');
            for (const [key, value] of Object.entries(stats)) totals[key] = (totals[key] || 0) + value;
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            totals.failed += 1;
            log.error('[MIGRATE] project root re-key failed for one owner (retried next boot):', err.message);
        } finally {
            client.release();
        }
    }
    if (!totals.failed) {
        await poolQuery('INSERT INTO context_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [PROJECT_ROOTS_MIGRATION]);
    }
    if (totals.roots) log.log('[MIGRATE] project root nodes re-keyed by id:', JSON.stringify(totals));
    return totals;
}

module.exports = {
    runAutoMigration,
    backfillTeamTrialStartedAt,
    runProjectRootMigration,
    PROJECT_ROOTS_MIGRATION,
    backfillHostedConnectionWorkspaces,
    backfillRefreshRecordWorkspaces,
};
