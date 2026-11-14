'use strict';

// ONE CONTENT-FREE ROW PER PERSON, PER UTC DAY, PER TOOL, PER CLIENT.
//
// Why it exists (activation plan 2026-10, Thing 3e). The hosted dispatcher
// writes no telemetry for a tool whose annotation says readOnlyHint:true
// (recall, read_tasks, browse_skills, build_subagent_brief), so the exact
// return the plan teaches — "where did I leave off?" answered from recall —
// left no trace anywhere. Nothing could say whether somebody came back, so no
// rule could fire on "did not return".
//
// What is stored, and nothing else:
//   user_id    the PERSON (workspaceService.actorPersonId), never a key id
//   day        the UTC calendar day of the call
//   tool_name  the MCP tool's name, e.g. "recall" (a fixed identifier, never
//              an argument)
//   client     which client made the call, e.g. "chatgpt_web" or "claude_code"
//              (connectionIdentity's tool vocabulary), '' when unknown
// Never arguments, never results, never a project, never a count of what was
// read. It is the same kind of operational write as api_keys.last_used_at,
// which auth already performs on every request: it changes nothing a tool
// returns or stores for the user, so readOnlyHint stays true.
//
// Cost: the first call of a (person, day, tool, client) is one INSERT ... ON
// CONFLICT DO NOTHING; every later one is answered from an in-process set and
// touches no database at all. Failure is swallowed — a usage row must never
// break, slow or change the tool call it describes. Rows go with the person
// (ON DELETE CASCADE), like every other per-person row.

const db = require('../config/db');
const workspace = require('./workspaceService');

const MAX_TOOL_NAME = 64;
const MAX_CLIENT = 40;

// Every tool name either MCP server can dispatch: the hosted catalog
// (routes/mcp.js TOOLS, grouped and legacy) and the local stdio server's
// (packages/mcp-server, which adds its sign-in and setup tools). The local
// path posts its own tool name to an endpoint anyone authenticated can call,
// so only these names count there; anything else mints no usage day.
// tests/unit/tool-usage-days.test.js checks every hosted name is listed.
const KNOWN_TOOL_NAMES = Object.freeze(new Set([
    // grouped
    'start_session', 'recall', 'manage_projects', 'manage_memory', 'manage_tasks',
    'read_tasks', 'browse_skills', 'manage_skills', 'build_subagent_brief',
    'read_addon', 'use_addon',
    // legacy and per-action
    'archive_project', 'cleanup_context', 'create_project', 'export_trail', 'import_trail',
    'find_known_paths', 'get_context', 'get_next_best_context', 'get_portfolio',
    'get_project_map', 'get_skill', 'get_workspace_entities', 'get_workspace_overview',
    'list_projects', 'list_skills', 'list_context_map', 'manage_todos', 'mark_resolved',
    'record_debug_finding', 'record_hot_paths', 'rename_project', 'resolve_open_question',
    'search_context', 'set_project_parent', 'switch_subproject', 'update_context',
    'upsert_workspace_entities', 'inspect_context_graph', 'import_local_context',
    'import_skill_from_github', 'sync_skills', 'read_brief', 'update_brief', 'confirm_claim',
    // local sign-in and setup
    'get_auth_status', 'get_setup_status', 'apply_setup', 'complete_setup',
]));

function isKnownToolName(name) {
    return KNOWN_TOOL_NAMES.has(String(name || ''));
}

let tableReady = null;
function ensureTable() {
    if (!tableReady) {
        // Also created by config/autoMigrate.js at boot. Repeated here (once per
        // process) because scripts and tests reach this module without booting
        // the app, the same reason weeklyDigest.js mirrors its table.
        tableReady = db.query(
            `CREATE TABLE IF NOT EXISTS tool_usage_days (
               user_id   TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
               day       DATE NOT NULL,
               tool_name TEXT NOT NULL,
               client    TEXT NOT NULL DEFAULT '',
               PRIMARY KEY (user_id, day, tool_name, client)
             )`,
            [],
            'org-system',
        ).catch((err) => {
            tableReady = null;
            throw err;
        });
    }
    return tableReady;
}

// Identifiers only. A local client posts its own tool name, so it is held to
// the shape a tool name has and cannot smuggle a sentence into the table.
function cleanIdentifier(value, max) {
    const s = String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, max);
    return s;
}

function utcDay(now = new Date()) {
    return now.toISOString().slice(0, 10);
}

// Already-written keys for the current UTC day. Cleared when the day turns, so
// it holds at most one day's distinct (person, tool, client) triples.
let seenDay = null;
const seen = new Set();
const MAX_SEEN = 50000;

/**
 * Record that this person called this tool today. Fire-and-forget: returns a
 * promise that never rejects, and callers should not await it on a hot path.
 */
function recordToolUse(actor, { toolName, client = null, now = new Date() } = {}) {
    try {
        const userId = workspace.actorPersonId(actor);
        const tool = cleanIdentifier(toolName, MAX_TOOL_NAME);
        if (!userId || !tool) return Promise.resolve(false);
        const day = utcDay(now);
        const cleanClient = cleanIdentifier(client, MAX_CLIENT);
        if (seenDay !== day) {
            seenDay = day;
            seen.clear();
        }
        const key = `${userId}\u0000${tool}\u0000${cleanClient}`;
        if (seen.has(key)) return Promise.resolve(false);
        if (seen.size >= MAX_SEEN) seen.clear();
        seen.add(key);
        return ensureTable()
            .then(() => db.query(
                `INSERT INTO tool_usage_days (user_id, day, tool_name, client)
                 VALUES ($1, $2::date, $3, $4)
                 ON CONFLICT DO NOTHING`,
                [userId, day, tool, cleanClient],
                'org-system',
            ))
            .then(() => true)
            .catch((err) => {
                // Let the next call try again rather than believing a failed write.
                seen.delete(key);
                console.warn(`[USAGE] tool usage day not recorded: ${err.message}`);
                return false;
            });
    } catch (err) {
        return Promise.resolve(false);
    }
}

/**
 * Distinct UTC days on which this person used DeerDawn from an AI tool.
 *
 * tool_usage_days only exists from the deploy that added it, so the days
 * before it are read from the product_events rows both MCP servers already
 * wrote for start_session and every non-read-only call. A day counted by both
 * is one day. Errors read as 0: every caller uses this to hold something back
 * until there is evidence, so the safe answer is "not yet".
 */
async function countActiveDays(userIds) {
    const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean))];
    if (!ids.length) return 0;
    try {
        await ensureTable();
        const res = await db.query(
            `SELECT COUNT(*)::int AS days FROM (
               SELECT day FROM tool_usage_days WHERE user_id = ANY($1)
               UNION
               SELECT (created_at AT TIME ZONE 'UTC')::date AS day
                 FROM product_events
                WHERE user_id = ANY($1)
                  AND source = 'mcp'
                  AND event_name IN ('mcp_tool_call_succeeded', 'mcp_start_session_succeeded')
             ) d`,
            [ids],
            'org-system',
        );
        return Number(res.rows?.[0]?.days || 0);
    } catch (err) {
        console.warn(`[USAGE] active-day count failed: ${err.message}`);
        return 0;
    }
}

function resetForTests() {
    seenDay = null;
    seen.clear();
    tableReady = null;
}

module.exports = { KNOWN_TOOL_NAMES, isKnownToolName, recordToolUse, countActiveDays, ensureTable, cleanIdentifier, utcDay, resetForTests };
