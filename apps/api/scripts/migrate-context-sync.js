const { Client } = require('pg');
const { getDbSslConfig } = require('../src/config/dbSsl');

const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: getDbSslConfig()
});

async function runMigration() {
    try {
        console.log('[migrate-context-sync] Connecting to DB...');
        await client.connect();

        console.log('[migrate-context-sync] Creating context_projects table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS context_projects (
                project_id          TEXT PRIMARY KEY,
                owner_key           TEXT NOT NULL,
                owner_user_id       TEXT,
                visibility          TEXT NOT NULL DEFAULT 'private',
                project_name        TEXT NOT NULL,
                aliases             TEXT[] DEFAULT '{}',
                linked_paths        TEXT[] DEFAULT '{}',
                linked_conversations TEXT[] DEFAULT '{}',
                context             JSONB NOT NULL DEFAULT '{}',
                created_at          TIMESTAMPTZ DEFAULT NOW(),
                updated_at          TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        await client.query(`
            ALTER TABLE context_projects
            ADD COLUMN IF NOT EXISTS owner_user_id TEXT
        `);
        await client.query(`
            ALTER TABLE context_projects
            ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private'
        `);
        console.log('[migrate-context-sync] PASS: context_projects table ready');

        console.log('[migrate-context-sync] Creating context project sharing tables...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS context_project_shares (
                project_id   TEXT PRIMARY KEY REFERENCES context_projects(project_id) ON DELETE CASCADE,
                org_id       TEXT NOT NULL,
                enabled      BOOLEAN NOT NULL DEFAULT FALSE,
                created_by   TEXT,
                updated_by   TEXT,
                created_at   TIMESTAMPTZ DEFAULT NOW(),
                updated_at   TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS context_project_share_sections (
                project_id   TEXT NOT NULL REFERENCES context_projects(project_id) ON DELETE CASCADE,
                section_key  TEXT NOT NULL,
                can_view     BOOLEAN NOT NULL DEFAULT TRUE,
                can_edit     BOOLEAN NOT NULL DEFAULT FALSE,
                created_at   TIMESTAMPTZ DEFAULT NOW(),
                updated_at   TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (project_id, section_key)
            );
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS context_project_members (
                project_id    TEXT NOT NULL REFERENCES context_projects(project_id) ON DELETE CASCADE,
                user_id       TEXT NOT NULL,
                role_override TEXT NOT NULL,
                created_by    TEXT,
                created_at    TIMESTAMPTZ DEFAULT NOW(),
                updated_at    TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (project_id, user_id)
            );
        `);
        console.log('[migrate-context-sync] PASS: context project sharing tables ready');

        console.log('[migrate-context-sync] Creating context_events table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS context_events (
                event_id    TEXT PRIMARY KEY,
                project_id  TEXT REFERENCES context_projects(project_id) ON DELETE CASCADE,
                source_type TEXT NOT NULL,
                source_id   TEXT NOT NULL,
                event_kind  TEXT NOT NULL,
                delta       JSONB DEFAULT '{}',
                confidence  FLOAT NOT NULL,
                created_at  TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        console.log('[migrate-context-sync] PASS: context_events table ready');

        console.log('[migrate-context-sync] Creating injection_preferences table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS injection_preferences (
                owner_key   TEXT PRIMARY KEY,
                preferences JSONB NOT NULL DEFAULT '{}',
                updated_at  TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        console.log('[migrate-context-sync] PASS: injection_preferences table ready');

        console.log('[migrate-context-sync] Creating context_sessions table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS context_sessions (
                owner_key TEXT NOT NULL,
                session_id TEXT NOT NULL,
                tool TEXT NOT NULL,
                surface_type TEXT NOT NULL,
                project_id TEXT REFERENCES context_projects(project_id) ON DELETE SET NULL,
                conversation_ref TEXT DEFAULT '',
                cwd TEXT DEFAULT '',
                host TEXT DEFAULT '',
                tab_id TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'active',
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                last_seen_at TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (owner_key, session_id)
            );
        `);
        console.log('[migrate-context-sync] PASS: context_sessions table ready');

        console.log('[migrate-context-sync] Creating context_graph_nodes table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS context_graph_nodes (
                node_id TEXT PRIMARY KEY,
                owner_key TEXT NOT NULL,
                project_id TEXT REFERENCES context_projects(project_id) ON DELETE SET NULL,
                node_type TEXT NOT NULL,
                canonical_key TEXT NOT NULL,
                title TEXT NOT NULL,
                summary TEXT DEFAULT '',
                metadata JSONB NOT NULL DEFAULT '{}',
                confidence FLOAT NOT NULL DEFAULT 0.5,
                source_session_id TEXT DEFAULT '',
                source_tool TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                last_seen_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE (owner_key, node_type, canonical_key)
            );
        `);
        console.log('[migrate-context-sync] PASS: context_graph_nodes table ready');

        console.log('[migrate-context-sync] Creating context_graph_edges table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS context_graph_edges (
                edge_id TEXT PRIMARY KEY,
                owner_key TEXT NOT NULL,
                project_id TEXT REFERENCES context_projects(project_id) ON DELETE SET NULL,
                edge_type TEXT NOT NULL,
                from_node_id TEXT NOT NULL REFERENCES context_graph_nodes(node_id) ON DELETE CASCADE,
                to_node_id TEXT NOT NULL REFERENCES context_graph_nodes(node_id) ON DELETE CASCADE,
                summary TEXT DEFAULT '',
                metadata JSONB NOT NULL DEFAULT '{}',
                confidence FLOAT NOT NULL DEFAULT 0.5,
                source_session_id TEXT DEFAULT '',
                source_tool TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                last_seen_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE (owner_key, edge_type, from_node_id, to_node_id)
            );
        `);
        console.log('[migrate-context-sync] PASS: context_graph_edges table ready');

        console.log('[migrate-context-sync] Creating context_graph_evidence table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS context_graph_evidence (
                evidence_id TEXT PRIMARY KEY,
                owner_key TEXT NOT NULL,
                project_id TEXT REFERENCES context_projects(project_id) ON DELETE SET NULL,
                session_id TEXT NOT NULL,
                node_id TEXT REFERENCES context_graph_nodes(node_id) ON DELETE CASCADE,
                edge_id TEXT REFERENCES context_graph_edges(edge_id) ON DELETE CASCADE,
                tool TEXT NOT NULL,
                excerpt TEXT NOT NULL,
                metadata JSONB NOT NULL DEFAULT '{}',
                confidence FLOAT NOT NULL DEFAULT 0.5,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        console.log('[migrate-context-sync] PASS: context_graph_evidence table ready');

        console.log('[migrate-context-sync] Creating context_graph_embeddings table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS context_graph_embeddings (
                owner_key TEXT NOT NULL,
                target_kind TEXT NOT NULL,
                target_id TEXT NOT NULL,
                model TEXT NOT NULL,
                dimensions INTEGER NOT NULL,
                vector JSONB,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (owner_key, target_kind, target_id, model)
            );
        `);
        console.log('[migrate-context-sync] PASS: context_graph_embeddings table ready');

        const sessionConstraintResult = await client.query(`
            SELECT pg_get_constraintdef(con.oid) AS constraint_def
            FROM pg_constraint con
            JOIN pg_class rel ON rel.oid = con.conrelid
            WHERE rel.relname = 'context_sessions' AND con.contype = 'p'
        `);
        const constraintDef = sessionConstraintResult.rows[0]?.constraint_def || '';
        if (constraintDef.includes('(session_id)') && !constraintDef.includes('(owner_key, session_id)')) {
            console.log('[migrate-context-sync] Migrating context_sessions to owner-scoped primary key...');
            await client.query('ALTER TABLE context_sessions RENAME TO context_sessions_legacy');
            await client.query(`
                CREATE TABLE context_sessions (
                    owner_key TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    tool TEXT NOT NULL,
                    surface_type TEXT NOT NULL,
                    project_id TEXT REFERENCES context_projects(project_id) ON DELETE SET NULL,
                    conversation_ref TEXT DEFAULT '',
                    cwd TEXT DEFAULT '',
                    host TEXT DEFAULT '',
                    tab_id TEXT DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'active',
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW(),
                    last_seen_at TIMESTAMPTZ DEFAULT NOW(),
                    PRIMARY KEY (owner_key, session_id)
                );
            `);
            await client.query(`
                INSERT INTO context_sessions
                    (owner_key, session_id, tool, surface_type, project_id, conversation_ref, cwd, host, tab_id, status, created_at, updated_at, last_seen_at)
                SELECT DISTINCT ON (owner_key, session_id)
                    owner_key, session_id, tool, surface_type, project_id, conversation_ref, cwd, host, tab_id, status, created_at, updated_at, last_seen_at
                FROM context_sessions_legacy
                ORDER BY owner_key, session_id, updated_at DESC NULLS LAST, created_at DESC NULLS LAST
            `);
            await client.query('DROP TABLE context_sessions_legacy');
            console.log('[migrate-context-sync] PASS: context_sessions migrated');
        }

        console.log('[migrate-context-sync] Creating indexes...');
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_context_projects_owner
            ON context_projects(owner_key);
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_context_events_project
            ON context_events(project_id);
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_context_sessions_owner_last_seen
            ON context_sessions(owner_key, last_seen_at DESC);
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_context_graph_nodes_owner_project
            ON context_graph_nodes(owner_key, project_id, last_seen_at DESC);
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_context_graph_edges_owner_project
            ON context_graph_edges(owner_key, project_id, last_seen_at DESC);
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_context_graph_evidence_owner_project
            ON context_graph_evidence(owner_key, project_id, created_at DESC);
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_context_graph_embeddings_owner_kind
            ON context_graph_embeddings(owner_key, target_kind);
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_context_projects_owner_user
            ON context_projects(owner_user_id);
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_context_project_shares_org
            ON context_project_shares(org_id, enabled);
        `);
        console.log('[migrate-context-sync] PASS: indexes ready');

        await client.end();
        console.log('[migrate-context-sync] Migration complete.');
    } catch (err) {
        console.error('[migrate-context-sync] ERROR:', err);
        try { await client.end(); } catch (_) { /* ignore disconnect errors */ }
        process.exit(1);
    }
}

runMigration();
