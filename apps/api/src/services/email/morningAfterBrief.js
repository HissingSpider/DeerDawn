'use strict';

// THE MORNING-AFTER BRIEF (activation plan 2026-10, Thing 3f; template C9).
//
// The morning after somebody's FIRST save from an AI session, send them their
// own brief: what their AI will start from next time, the next step, and how to
// pick it up in ChatGPT, Claude or Codex. Plain text, from John's address. If
// they have not come back three days after it went out, one reminder ("Your
// brief for {project} is waiting"), then nothing, ever.
//
// Its own job, deliberately apart from activationFollowUp.js (E-033's
// treatment): that job writes to people who have NOT got value yet, this one
// only to people who saved, so the two audiences cannot overlap and E-033's
// read is untouched. The sending and unsubscribe plumbing is shared: the same
// Resend transport (plain-text mode), the same HMAC unsubscribe link and the
// same `weekly_digest_unsubscribed` opt-out every lifecycle email honours.
//
// OFF UNTIL JOHN TURNS IT ON. Nothing is sent unless MORNING_AFTER_BRIEF_ENABLED
// is "true" (or "1") AND RESEND_API_KEY is set, so deploying this changes
// nothing.
//
// WHO. A person whose first-ever save from a session (a context_events row they
// contributed, from an MCP tool or a named AI client — not a system event, not
// project creation) happened 10–40 hours ago, who has an email that is not a
// journey-test address and has not unsubscribed. The brief comes from the
// project they saved to most recently, and only from a project that is THEIRS
// (they authored it, or it is an unattributed project in their own org): the
// email says "your brief", and quoting a teammate's project — whose share policy
// may withhold sections — would be somebody else's words in it.
//
// WHEN. Only inside a morning window, MORNING_AFTER_BRIEF_HOUR_UTC (default 14,
// i.e. 7am Pacific / 10am Eastern) for MORNING_AFTER_BRIEF_WINDOW_HOURS (default
// 4). With the 10–40h band every first save meets exactly one window: a save at
// 8pm Pacific gets it the next morning, not two days later and not the same
// evening.
//
// AT MOST ONCE, by a claim row (morning_after_brief_sends, one per person,
// ever). The claim is taken BEFORE sending; a failed send gives it back so the
// next tick retries; a process that dies between claim and send leaves it, and
// that person gets nothing — the same trade weeklyDigest.js makes, because a
// sent email cannot be recalled and a missed one costs little.
//
// ENCRYPTION. The brief is read through the store's getProjectContextOnly,
// which decrypts at rest exactly as every other reader does; a project that
// cannot be decrypted sends nothing. No project name is ever put in a URL: the
// only link is the unsubscribe link (person id + HMAC token).

const db = require('../../config/db');
const store = require('../../store/contextSyncStore');
const resendClient = require('./resendClient');
const { unsubscribeUrl } = require('./weeklyDigest');
const toolUsageDays = require('../toolUsageDays');
// A module object so tests can stub recordProductEvent.
const productEvents = require('../productEventsService');
const {
    selectBriefDecisions,
    decisionHeadline,
} = require('../../../../../packages/shared-context/src/index.js');

const BRIEF_EVENT = 'morning_after_brief_sent';
const REMINDER_EVENT = 'morning_after_reminder_sent';
const BRIEF_EMAIL_TYPE = 'morning_after_brief';
const REMINDER_EMAIL_TYPE = 'morning_after_reminder';
const TEST_EMAIL_MARKER = '+clerk_test';
const REPLY_TO = 'john@deerdawn.com';
const DEFAULT_FROM = 'John Gilbert <john@deerdawn.com>';

// A save FROM A SESSION: the AI clients and the MCP structured events. Excludes
// 'system' (project creation, archive, merge, repairs) and 'manual'.
const SESSION_SOURCES = ['mcp', 'claude_web', 'chatgpt_web', 'gemini', 'perplexity', 'cursor', 'claude_code', 'codex'];
const NOT_SAVES = ['project_created', 'project_archived', 'project_merged', 'manual_override'];

const MIN_HOURS_AFTER_SAVE = 10;
const MAX_HOURS_AFTER_SAVE = 40;
const REMINDER_AFTER_DAYS = 3;
// A reminder that missed its moment by a week is not a reminder; stop instead.
const REMINDER_STALE_DAYS = 10;
// How much older than the save window an account may be and still count as new.
const MAX_ACCOUNT_AGE_DAYS = 3;

function isEnabled(env = process.env) {
    return /^(1|true|yes|on)$/i.test(String(env.MORNING_AFTER_BRIEF_ENABLED || '').trim());
}

function envInt(name, min, max, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function settings() {
    return {
        hour: envInt('MORNING_AFTER_BRIEF_HOUR_UTC', 0, 23, 14),
        windowHours: envInt('MORNING_AFTER_BRIEF_WINDOW_HOURS', 1, 24, 4),
        maxPerRun: envInt('MORNING_AFTER_BRIEF_MAX_PER_RUN', 1, 5000, 200),
        from: process.env.MORNING_AFTER_BRIEF_FROM || DEFAULT_FROM,
    };
}

/** True when `now` is inside today's morning window (UTC). */
function inMorningWindow(now = new Date(), { hour, windowHours } = settings()) {
    const h = now.getUTCHours();
    const end = hour + windowHours;
    return end <= 24 ? (h >= hour && h < end) : (h >= hour || h < end - 24);
}

let tableReady = null;
function ensureTable() {
    if (!tableReady) {
        // Also created by config/autoMigrate.js at boot; mirrored for scripts and
        // tests that never boot the app (as weeklyDigest.js does).
        tableReady = db.query(
            `CREATE TABLE IF NOT EXISTS morning_after_brief_sends (
               user_id          TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
               project_id       TEXT,
               owner_key        TEXT,
               save_day         DATE,
               brief_claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
               brief_sent_at    TIMESTAMPTZ,
               reminder_claimed_at TIMESTAMPTZ,
               reminder_sent_at TIMESTAMPTZ
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

// ── Who is due ───────────────────────────────────────────────────────────────

// IS THIS PROJECT STILL THIS PERSON'S OWN BRIEF? One predicate, used by the
// brief AND the reminder, so a person who has since left the workspace, or a
// project they can no longer read whole, is never quoted to them.
//   - They are an ACTIVE member of the project's workspace (not merely that it
//     is the org on their users row: on the legacy invite path users.org_id can
//     be a team they have since been removed from).
//   - They authored it (their person id, or one of their keys from before the
//     identity fix), OR it is unattributed AND its workspace has exactly one
//     active member. An unattributed project in a team is read through a share
//     policy that can withhold sections; this email reads the whole context, so
//     it never quotes one.
// `person`, `proj` and `usr` are SQL expressions for the person id, the
// context_projects alias and the users alias.
function ownReadableProjectSql(person, proj, usr) {
    return `(
        EXISTS (SELECT 1 FROM workspace_members wm
                 WHERE wm.owner_key = ${proj}.owner_key AND wm.user_id = ${person} AND wm.removed_at IS NULL)
        AND (
            ${proj}.owner_user_id = ${person}
         OR ${proj}.owner_user_id IN (SELECT key_id FROM api_keys WHERE owner_id = ${person})
         OR (${proj}.owner_user_id IS NULL
             AND ${proj}.owner_key = ${usr}.org_id
             AND (SELECT COUNT(*) FROM workspace_members wm1
                   WHERE wm1.owner_key = ${proj}.owner_key AND wm1.removed_at IS NULL) = 1)
        )
    )`;
}

async function findBriefRecipients({ now = new Date(), limit = settings().maxPerRun } = {}) {
    await ensureTable();
    const windowStart = new Date(now.getTime() - MAX_HOURS_AFTER_SAVE * 3600000);
    const latestFirstSave = new Date(now.getTime() - MIN_HOURS_AFTER_SAVE * 3600000);
    // Driven from projects touched in the window (a save always rewrites the
    // project), then that project's events by (project_id, created_at) — the
    // index the events table has — rather than a scan of every event by time.
    const res = await db.query(
        `WITH recent AS (
           SELECT COALESCE(u.user_id, k.owner_id) AS user_id,
                  p.project_id, p.owner_key, p.owner_user_id, ce.created_at
             FROM context_projects p
             JOIN context_events ce
               ON ce.project_id = p.project_id
              AND ce.created_at >= $1
              AND ce.created_at <= $2
             LEFT JOIN users u ON u.user_id = ce.contributing_user_id
             LEFT JOIN api_keys k ON k.key_id = ce.contributing_user_id
            WHERE p.updated_at >= $1
              AND p.archived_at IS NULL
              AND ce.contributing_user_id IS NOT NULL
              AND ce.source_type = ANY($4)
              AND ce.event_kind <> ALL($5)
         ), firsts AS (
           SELECT user_id, MIN(created_at) AS first_save_at
             FROM recent WHERE user_id IS NOT NULL GROUP BY user_id
         ), own AS (
           SELECT r.* FROM recent r
             JOIN users ru ON ru.user_id = r.user_id
            WHERE ${ownReadableProjectSql('r.user_id', 'r', 'ru')}
         ), picked AS (
           SELECT DISTINCT ON (user_id) user_id, project_id, owner_key
             FROM own ORDER BY user_id, created_at DESC
         )
         SELECT pk.user_id, pk.project_id, pk.owner_key, u.email, u.org_id,
                f.first_save_at,
                EXISTS (
                    SELECT 1 FROM tool_usage_days t WHERE t.user_id = pk.user_id AND t.client = 'codex'
                ) OR EXISTS (
                    SELECT 1 FROM product_events pe
                     WHERE pe.user_id = pk.user_id AND pe.source = 'mcp' AND pe.tool = 'codex'
                ) AS uses_codex
           FROM picked pk
           JOIN firsts f ON f.user_id = pk.user_id
           JOIN users u ON u.user_id = pk.user_id
          WHERE f.first_save_at <= $3
            AND u.email IS NOT NULL
            AND POSITION($6 IN lower(u.email)) = 0
            AND COALESCE(u.weekly_digest_unsubscribed, false) = false
            AND NOT EXISTS (SELECT 1 FROM morning_after_brief_sends s WHERE s.user_id = pk.user_id)
            -- A NEW person, not a long-time one whose earlier saves this query
            -- cannot see. context_events only carries contributing_user_id since
            -- 2026-06-08, and events go with a deleted project, so "no earlier
            -- save" alone would greet a veteran with "Yesterday DeerDawn saved a
            -- brief". Both guards, because a missed email costs nothing and a
            -- wrong one costs trust:
            --   the account is at most a few days older than the window, and
            AND u.created_at >= $1::timestamptz - make_interval(days => $8)
            --   no MCP tool call was ever recorded for them before the window.
            AND NOT EXISTS (
                SELECT 1 FROM product_events pe0
                 WHERE pe0.user_id = pk.user_id
                   AND pe0.created_at < $1
                   AND pe0.source = 'mcp'
                   AND pe0.event_name IN ('mcp_tool_call_succeeded', 'mcp_start_session_succeeded')
            )
            -- FIRST save: nothing saved from a session before the window opened.
            AND NOT EXISTS (
                SELECT 1 FROM context_events e2
                 WHERE e2.created_at < $1
                   AND e2.source_type = ANY($4)
                   AND e2.event_kind <> ALL($5)
                   AND (e2.contributing_user_id = pk.user_id
                     OR e2.contributing_user_id IN (SELECT key_id FROM api_keys WHERE owner_id = pk.user_id))
            )
          ORDER BY f.first_save_at ASC
          LIMIT $7`,
        [
            windowStart.toISOString(),
            now.toISOString(),
            latestFirstSave.toISOString(),
            SESSION_SOURCES,
            NOT_SAVES,
            TEST_EMAIL_MARKER,
            limit,
            MAX_ACCOUNT_AGE_DAYS,
        ],
        'org-system',
    ).catch((err) => {
        console.warn(`[EMAIL] morning-after brief recipient query failed: ${err.message}`);
        return { rows: [] };
    });
    return res.rows || [];
}

async function findReminderRecipients({ now = new Date(), limit = settings().maxPerRun } = {}) {
    await ensureTable();
    const due = new Date(now.getTime() - REMINDER_AFTER_DAYS * 86400000);
    const stale = new Date(now.getTime() - REMINDER_STALE_DAYS * 86400000);
    // "Has not come back": no tool call of any kind (reads included, which is
    // what tool_usage_days exists for), no MCP call event and no save, since
    // the day the brief went out.
    const res = await db.query(
        `SELECT s.user_id, s.project_id, s.owner_key, s.brief_sent_at, u.email
           FROM morning_after_brief_sends s
           JOIN users u ON u.user_id = s.user_id
           JOIN context_projects p ON p.project_id = s.project_id AND p.owner_key = s.owner_key
          WHERE s.brief_sent_at IS NOT NULL
            -- Re-checked now, as the brief was: they may have left the workspace.
            AND p.archived_at IS NULL
            AND ${ownReadableProjectSql('s.user_id', 'p', 'u')}
            AND s.brief_sent_at <= $1
            AND s.brief_sent_at > $2
            AND s.reminder_claimed_at IS NULL
            AND u.email IS NOT NULL
            AND COALESCE(u.weekly_digest_unsubscribed, false) = false
            AND NOT EXISTS (
                SELECT 1 FROM tool_usage_days t
                 WHERE t.user_id = s.user_id
                   AND t.day >= (s.brief_sent_at AT TIME ZONE 'UTC')::date
            )
            AND NOT EXISTS (
                SELECT 1 FROM product_events pe
                 WHERE pe.user_id = s.user_id
                   AND pe.source = 'mcp'
                   AND pe.event_name IN ('mcp_tool_call_succeeded', 'mcp_start_session_succeeded', 'mcp_runtime_started')
                   AND pe.created_at >= date_trunc('day', s.brief_sent_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
            )
            AND NOT EXISTS (
                SELECT 1 FROM context_events ce
                 WHERE ce.created_at >= s.brief_sent_at
                   AND (ce.contributing_user_id = s.user_id
                     OR ce.contributing_user_id IN (SELECT key_id FROM api_keys WHERE owner_id = s.user_id))
            )
          ORDER BY s.brief_sent_at ASC
          LIMIT $3`,
        [due.toISOString(), stale.toISOString(), limit],
        'org-system',
    ).catch((err) => {
        console.warn(`[EMAIL] morning-after reminder recipient query failed: ${err.message}`);
        return { rows: [] };
    });
    return res.rows || [];
}

// ── Claims ───────────────────────────────────────────────────────────────────

async function claimBrief(row, now = new Date()) {
    const res = await db.query(
        `INSERT INTO morning_after_brief_sends (user_id, project_id, owner_key, save_day, brief_claimed_at)
         VALUES ($1, $2, $3, $4::date, $5)
         ON CONFLICT (user_id) DO NOTHING
         RETURNING user_id`,
        [
            row.user_id,
            row.project_id,
            row.owner_key,
            new Date(row.first_save_at || now).toISOString().slice(0, 10),
            now.toISOString(),
        ],
        'org-system',
    );
    return res.rows.length > 0;
}

async function releaseBrief(userId) {
    await db.query(
        'DELETE FROM morning_after_brief_sends WHERE user_id = $1 AND brief_sent_at IS NULL',
        [userId],
        'org-system',
    );
}

async function markBriefSent(userId, now = new Date()) {
    await db.query(
        'UPDATE morning_after_brief_sends SET brief_sent_at = $2 WHERE user_id = $1',
        [userId, now.toISOString()],
        'org-system',
    );
}

async function claimReminder(userId, now = new Date()) {
    const res = await db.query(
        `UPDATE morning_after_brief_sends SET reminder_claimed_at = $2
          WHERE user_id = $1 AND reminder_claimed_at IS NULL
         RETURNING user_id`,
        [userId, now.toISOString()],
        'org-system',
    );
    return res.rows.length > 0;
}

async function releaseReminder(userId) {
    await db.query(
        'UPDATE morning_after_brief_sends SET reminder_claimed_at = NULL WHERE user_id = $1 AND reminder_sent_at IS NULL',
        [userId],
        'org-system',
    );
}

async function markReminderSent(userId, now = new Date()) {
    await db.query(
        'UPDATE morning_after_brief_sends SET reminder_sent_at = $2 WHERE user_id = $1',
        [userId, now.toISOString()],
        'org-system',
    );
}

// ── Rendering (plain text, C9) ───────────────────────────────────────────────

// One line of brief text, on one line: stored entries can carry newlines and
// whole write-ups, and the email quotes, it does not reproduce.
function oneLine(value, max = 280) {
    const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    if (s.length <= max) return s;
    return `${s.slice(0, max - 1).trimEnd()}…`;
}

/** What the email quotes from a decrypted context, or null when there is nothing to quote. */
function briefLines(context) {
    if (!context || context._decrypt_error) return null;
    const task = oneLine(context.current_task);
    const decision = selectBriefDecisions(context.recent_decisions || [])[0];
    const decisionText = decision ? oneLine(decisionHeadline(decision)) : '';
    const question = oneLine((context.open_questions || []).find((q) => String(q || '').trim()));
    const next = oneLine(context.next_action);
    if (!task && !decisionText && !question && !next) return null;
    return { task, decision: decisionText, question, next };
}

function renderBriefText({ projectName, lines, unsubUrl, usesCodex = false }) {
    const project = oneLine(projectName, 120);
    const body = [];
    body.push('Hi,');
    body.push('');
    body.push(`Yesterday DeerDawn saved a brief for ${project}. This is what your AI will start`);
    body.push('from next time:');
    body.push('');
    if (lines.task) body.push(`Working on: ${lines.task}`);
    if (lines.decision) body.push(`Latest decision: ${lines.decision}`);
    if (lines.question) body.push(`Open question: ${lines.question}`);
    if (lines.next) body.push(`Next step: ${lines.next}`);
    body.push('');
    body.push('To pick it up, start a new chat and say:');
    body.push('- in ChatGPT: @DeerDawn where did I leave off?');
    body.push('- in Claude: Where did I leave off? Check DeerDawn');
    if (usesCodex) body.push('- in Codex: it loads at the start of each task');
    body.push('');
    body.push('If anything in it is wrong, reply and tell me. If someone else works on');
    body.push(`${project} with you, reply with their name and I'll set them up so their AI starts`);
    body.push('from the same brief. (Reply "stop", or use the unsubscribe link below, to turn');
    body.push('these off.)');
    body.push('');
    body.push('John');
    body.push('');
    body.push('--');
    body.push(`Unsubscribe: ${unsubUrl}`);
    return body.join('\n');
}

function renderReminderText({ projectName, nextAction, unsubUrl }) {
    const project = oneLine(projectName, 120);
    const next = oneLine(nextAction);
    const saved = next ? ` The next step you saved: ${next}.` : '';
    return [
        `Hi, your DeerDawn brief for ${project} is where you left it.${saved} To pick it up,`
        + ' say "@DeerDawn where did I leave off?" in a new ChatGPT chat, or "Where did I leave'
        + ' off? Check DeerDawn" in Claude. (Reply "stop", or use the unsubscribe link below,'
        + ' to turn these off.)',
        '',
        'John',
        '',
        '--',
        `Unsubscribe: ${unsubUrl}`,
    ].join('\n');
}

function briefSubject(projectName) {
    return `Your ${oneLine(projectName, 80)} brief for next time`;
}

function reminderSubject(projectName) {
    return `Your brief for ${oneLine(projectName, 80)} is waiting`;
}

// ── The job ──────────────────────────────────────────────────────────────────

async function loadProject(ownerKey, projectId) {
    try {
        const project = await store.getProjectContextOnly(ownerKey, projectId);
        if (!project || project.archived_at) return null;
        return project;
    } catch (err) {
        console.warn(`[EMAIL] morning-after brief could not read ${projectId}: ${err.message}`);
        return null;
    }
}

function recordSent(row, eventName, emailType) {
    return productEvents.recordProductEvent(
        { type: 'user', id: row.user_id, org_id: row.org_id || row.owner_key || null },
        { event_name: eventName, source: 'api', surface: 'morning_after_brief', metadata: { channel: 'email', email_type: emailType } },
    ).catch((err) => console.warn(`[EMAIL] morning-after sent-marker event failed for ${row.user_id}: ${err.message}`));
}

async function sendBriefs({ now, cfg }) {
    const rows = await findBriefRecipients({ now, limit: cfg.maxPerRun });
    let sent = 0;
    for (const row of rows) {
        let claimed = false;
        let delivered = false;
        try {
            const project = await loadProject(row.owner_key, row.project_id);
            const lines = briefLines(project?.context);
            // Nothing quotable (or undecryptable): send nothing and claim nothing.
            if (!project || !lines) continue;
            if (!(await claimBrief(row, now))) continue;
            claimed = true;
            const result = await resendClient.sendEmail({
                to: row.email,
                from: cfg.from,
                replyTo: REPLY_TO,
                subject: briefSubject(project.project_name),
                text: renderBriefText({
                    projectName: project.project_name,
                    lines,
                    unsubUrl: unsubscribeUrl(row.user_id),
                    usesCodex: Boolean(row.uses_codex),
                }),
                emailType: BRIEF_EMAIL_TYPE,
            });
            if (result?.ok) {
                // From here on the email has gone. Whatever fails below, the
                // claim must stay, or the next tick sends it a second time.
                delivered = true;
                sent += 1;
                await _internals.markBriefSent(row.user_id, now);
                await recordSent(row, BRIEF_EVENT, BRIEF_EMAIL_TYPE);
            } else {
                await releaseBrief(row.user_id);
            }
        } catch (err) {
            console.warn(`[EMAIL] morning-after brief failed for ${row.user_id}: ${err.message}`);
            if (claimed && !delivered) await releaseBrief(row.user_id).catch(() => {});
        }
    }
    return { sent, total: rows.length };
}

async function sendReminders({ now, cfg }) {
    const rows = await findReminderRecipients({ now, limit: cfg.maxPerRun });
    let sent = 0;
    for (const row of rows) {
        let claimed = false;
        let delivered = false;
        try {
            if (!(await claimReminder(row.user_id, now))) continue;
            claimed = true;
            const project = await loadProject(row.owner_key, row.project_id);
            // The project is gone or archived: the claim stays, so this person is
            // never reminded about it. "Then stop" holds either way.
            if (!project || project.context?._decrypt_error) continue;
            const result = await resendClient.sendEmail({
                to: row.email,
                from: cfg.from,
                replyTo: REPLY_TO,
                subject: reminderSubject(project.project_name),
                text: renderReminderText({
                    projectName: project.project_name,
                    nextAction: project.context?.next_action,
                    unsubUrl: unsubscribeUrl(row.user_id),
                }),
                emailType: REMINDER_EMAIL_TYPE,
            });
            if (result?.ok) {
                // Sent: never release the claim after this point.
                delivered = true;
                sent += 1;
                await _internals.markReminderSent(row.user_id, now);
                await recordSent(row, REMINDER_EVENT, REMINDER_EMAIL_TYPE);
            } else {
                await releaseReminder(row.user_id);
            }
        } catch (err) {
            console.warn(`[EMAIL] morning-after reminder failed for ${row.user_id}: ${err.message}`);
            if (claimed && !delivered) await releaseReminder(row.user_id).catch(() => {});
        }
    }
    return { sent, total: rows.length };
}

async function sendMorningAfterBriefs({ now = new Date() } = {}) {
    if (!isEnabled()) return { skipped: true, reason: 'disabled' };
    if (!process.env.RESEND_API_KEY) return { skipped: true, reason: 'no_api_key' };
    const cfg = settings();
    if (!inMorningWindow(now, cfg)) return { skipped: true, reason: 'outside_window' };
    // The usage-day table is read by both queries; make sure it exists even on
    // a machine that has not served a tool call since boot.
    await toolUsageDays.ensureTable().catch(() => {});
    const briefs = await sendBriefs({ now, cfg });
    const reminders = await sendReminders({ now, cfg });
    console.log(`[EMAIL] Morning-after briefs sent ${briefs.sent}/${briefs.total}, reminders ${reminders.sent}/${reminders.total}`);
    return { briefs, reminders };
}

function resetForTests() {
    tableReady = null;
}

// A module object so a test can make the post-send bookkeeping fail.
const _internals = { markBriefSent, markReminderSent };

module.exports = {
    _internals,
    sendMorningAfterBriefs,
    findBriefRecipients,
    findReminderRecipients,
    claimBrief,
    claimReminder,
    briefLines,
    renderBriefText,
    renderReminderText,
    briefSubject,
    reminderSubject,
    inMorningWindow,
    isEnabled,
    ensureTable,
    resetForTests,
    SESSION_SOURCES,
    NOT_SAVES,
    // Shared with valueLadder.js, which quotes the same "own brief".
    ownReadableProjectSql,
};
