'use strict';

// THE VALUE LADDER — where each person is on the way to getting what they came
// for, and the one email that moves them up a step.
//
// What DeerDawn sells is "your AI does not start cold". Nobody feels that by
// signing up, or by connecting, or even by saving: they feel it the first time
// their AI starts a LATER chat from what they saved. So the ladder is measured in
// tool calls and saves, never in website visits — a person who never opens the
// dashboard again and talks to DeerDawn from ChatGPT every day is the best
// customer we have, and one who reads the dashboard daily and never calls a tool
// has not been served at all.
//
//   0 joined     signed up, or approved the connector on a consent screen
//   1 used       their AI called a DeerDawn tool in a chat
//   2 saved      something was saved from a session (the deposit)
//   3 returned   on a LATER UTC day than the first save, their AI called DeerDawn
//                again — the brief came back. THIS is activation.
//   4 habit      DeerDawn was used on 3+ separate UTC days
//   (5 outgrew Free — a signal, not a rung: a second project wanting
//    cross-project memory, or a teammate. Only here does an email mention money.)
//
// "Used on a day" reads tool_usage_days (every authenticated tool call, reads
// included, since 2026-10-05) and the MCP call events before it. Nothing here
// reads a page view.
//
// THE EMAILS THIS JOB OWNS. Two older jobs already cover the first rungs and are
// left exactly as they are (their reads are live experiments, E-033 and Thing 3f):
//   activationFollowUp.js   day 1, everyone below "saved"
//   morningAfterBrief.js    the morning after a first save, + one reminder at +3d
// This job adds the rest, at most one per step, each sent once ever:
//   value_nudge_unused     day 4-10, still nothing saved: one sentence to type
//   value_nudge_saved      saved 4-10 days ago, never came back, and the
//                          morning-after brief never reached them
//   value_returned         first return in the last 3 days: "it worked", their
//                          brief, and how to make it load without asking
//   value_nudge_returned   came back once, quiet for 5-12 days since
//   value_habit            third separate day: a second tool, or a teammate
//   value_upgrade          habit + a paid signal (2+ projects -> Pro; a teammate
//                          -> the Team trial), on Free, 3+ days after value_habit
//   value_still_there      signed up 21-35 days ago, never came back to a save
//                          (no value_first_return), and no lifecycle email of
//                          any kind in the last 7 days: one plain question from
//                          John, "did something get in the way?"
//
// THE RULES, all enforced here and pinned by tests/unit/value-ladder.test.js:
//   - one email per run per person, the highest step that is due;
//   - 48 hours of quiet after ANY lifecycle email, from any lifecycle job,
//     the weekly digest and the auto-archive notice included (7 days before
//     value_still_there);
//   - each email type at most once per person, ever (a claim row, taken before
//     sending, given back only when the send fails);
//   - every window is relative to a step's own date, so turning this on mails no
//     backlog: nobody who reached a step weeks ago is told about it now;
//   - weekly_digest_unsubscribed, test and internal accounts are never mailed.
//
// MILESTONE EVENTS. Each run also records `value_first_return` and
// `value_habit_reached` (once per person) for anyone who has reached the step,
// inside or outside the send window and whether or not this job is enabled for
// sending — so an ads cohort can be read as "how many reached the value", not
// "how many came back to the website".
//
// OFF UNTIL TURNED ON: nothing is SENT unless VALUE_LADDER_EMAILS_ENABLED is
// true and RESEND_API_KEY is set. The milestone events are recorded regardless.

const db = require('../../config/db');
const store = require('../../store/contextSyncStore');
const resendClient = require('./resendClient');
// Module objects: the facts query reads their send logs for the cooldown.
const weeklyDigest = require('./weeklyDigest');
const autoArchiveNotice = require('./autoArchiveNotice');

const { unsubscribeUrl } = weeklyDigest;
const toolUsageDays = require('../toolUsageDays');
const { internalIdentitySql } = require('../internalAccounts');
const { PLANS } = require('../../config/plans');
// Module objects so tests can stub them.
const productEvents = require('../productEventsService');
const morningAfter = require('./morningAfterBrief');

const SENT_EVENT = 'value_ladder_email_sent';
const RETURN_EVENT = 'value_first_return';
const HABIT_EVENT = 'value_habit_reached';
const REPLY_TO = 'john@deerdawn.com';
const DEFAULT_FROM = 'John Gilbert <john@deerdawn.com>';
const MARKETING_URL = process.env.MARKETING_URL || 'https://deerdawn.com';

const STEP = Object.freeze({ JOINED: 0, USED: 1, SAVED: 2, RETURNED: 3, HABIT: 4 });
const HABIT_DAYS = 3;
const COOLDOWN_HOURS = 48;
// The day-21 check-in waits longer: a person who has had any lifecycle email in
// the last week has just been asked something already.
const STILL_THERE_QUIET_HOURS = 7 * 24;
const STILL_THERE_MIN_DAYS = 21;
const STILL_THERE_MAX_DAYS = 35;
// Only accounts this new are evaluated at all. Every window below is far inside
// it; it bounds the query, and it means nobody from before this shipped is
// suddenly greeted for a step they took last summer.
const MAX_ACCOUNT_AGE_DAYS = 60;

const EMAIL = Object.freeze({
    NUDGE_UNUSED: 'value_nudge_unused',
    NUDGE_SAVED: 'value_nudge_saved',
    RETURNED: 'value_returned',
    NUDGE_RETURNED: 'value_nudge_returned',
    HABIT: 'value_habit',
    UPGRADE: 'value_upgrade',
    STILL_THERE: 'value_still_there',
});

// Every "sent" event any lifecycle job writes. The cooldown reads all of them.
// The weekly digest and the auto-archive notice write no event; the facts query
// reads their send logs (weekly_digest_workspace_sends, project_archive_notices)
// beside these.
const LIFECYCLE_SENT_EVENTS = [
    'activation_followup_email_sent',
    'morning_after_brief_sent',
    'morning_after_reminder_sent',
    'dormant_reactivation_email_sent',
    'concierge_recovery_email_sent',
    SENT_EVENT,
];

const DAY_MS = 86400000;

function isEnabled(env = process.env) {
    return /^(1|true|yes|on)$/i.test(String(env.VALUE_LADDER_EMAILS_ENABLED || '').trim());
}

function envInt(name, min, max, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function settings() {
    return {
        // Default 14:00 UTC for 8 hours: 7am-3pm Pacific, 10am-6pm Eastern.
        hour: envInt('VALUE_LADDER_HOUR_UTC', 0, 23, 14),
        windowHours: envInt('VALUE_LADDER_WINDOW_HOURS', 1, 24, 8),
        maxPerRun: envInt('VALUE_LADDER_MAX_PER_RUN', 1, 5000, 200),
        from: process.env.VALUE_LADDER_FROM || DEFAULT_FROM,
    };
}

function inSendWindow(now, { hour, windowHours }) {
    const h = now.getUTCHours();
    const end = hour + windowHours;
    return end <= 24 ? (h >= hour && h < end) : (h >= hour || h < end - 24);
}

// ── The ladder (pure) ────────────────────────────────────────────────────────

function utcDay(value) {
    if (!value) return null;
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function dayMs(day) {
    return Date.parse(`${day}T00:00:00Z`);
}

/** Sorted, de-duplicated UTC day strings. */
function normaliseDays(days) {
    return [...new Set((days || []).map(utcDay).filter(Boolean))].sort();
}

/**
 * The facts a person's step is computed from, everything as plain values so it
 * can be tested without a database:
 *   usedDays       UTC days DeerDawn was called from a chat
 *   firstSaveAt    the first save from a session, or null
 *   authorized     holds a hosted connector grant
 */
function ladderOf(facts) {
    const days = normaliseDays(facts.usedDays);
    const firstSaveDay = utcDay(facts.firstSaveAt);
    const returnDays = firstSaveDay ? days.filter((d) => d > firstSaveDay) : [];
    let step = STEP.JOINED;
    if (days.length > 0) step = STEP.USED;
    if (firstSaveDay) step = STEP.SAVED;
    if (firstSaveDay && returnDays.length > 0) step = STEP.RETURNED;
    if (step === STEP.RETURNED && days.length >= HABIT_DAYS) step = STEP.HABIT;
    return {
        step,
        days,
        firstSaveDay,
        firstReturnDay: returnDays[0] || null,
        // The day the habit was reached: the third separate day of use.
        habitDay: step === STEP.HABIT ? days[HABIT_DAYS - 1] : null,
        lastUsedDay: days.length ? days[days.length - 1] : null,
    };
}

function daysSince(day, now) {
    if (!day) return Infinity;
    return Math.floor((dayMs(utcDay(now)) - dayMs(day)) / DAY_MS);
}

function hoursSince(ts, now) {
    if (!ts) return Infinity;
    return (now.getTime() - new Date(ts).getTime()) / 3600000;
}

/**
 * Which paid plan this person's behaviour has reached the edge of, or null.
 * A teammate is the stronger signal (it is the thing Free cannot do at all),
 * so it wins over a second project.
 */
function upgradeSignal(facts) {
    if (facts.paid) return null;
    if ((facts.invitesSent || 0) > 0 || (facts.workspaceMembers || 0) > 1) return 'team';
    if ((facts.ownProjects || 0) >= 2) return 'pro';
    return null;
}

/**
 * The one email due for this person now, or null. `facts.sent` is the set of
 * value-ladder email types already claimed for them; `facts.lastLifecycleSentAt`
 * the newest send from any lifecycle job.
 */
function dueEmail(facts, now = new Date()) {
    if (hoursSince(facts.lastLifecycleSentAt, now) < COOLDOWN_HOURS) return null;
    const sent = facts.sent instanceof Set ? facts.sent : new Set(facts.sent || []);
    const l = ladderOf(facts);
    const fresh = (type) => !sent.has(type);
    const ageDays = (now.getTime() - new Date(facts.createdAt).getTime()) / DAY_MS;

    // Highest step first: somebody who reached a step is never sent a nudge for
    // a lower one.
    if (l.step === STEP.HABIT) {
        if (fresh(EMAIL.UPGRADE) && sent.has(EMAIL.HABIT) && upgradeSignal(facts)
            && hoursSince(facts.habitEmailSentAt, now) >= 72) {
            return EMAIL.UPGRADE;
        }
        if (fresh(EMAIL.HABIT) && daysSince(l.habitDay, now) <= 4) return EMAIL.HABIT;
        return null;
    }
    if (l.step === STEP.RETURNED) {
        if (fresh(EMAIL.RETURNED) && daysSince(l.firstReturnDay, now) <= 3) return EMAIL.RETURNED;
        const quiet = daysSince(l.lastUsedDay, now);
        if (fresh(EMAIL.NUDGE_RETURNED) && quiet >= 5 && quiet <= 12) return EMAIL.NUDGE_RETURNED;
        return null;
    }
    if (l.step === STEP.SAVED) {
        const sinceSave = daysSince(l.firstSaveDay, now);
        if (fresh(EMAIL.NUDGE_SAVED) && !facts.morningAfterSent && sinceSave >= 4 && sinceSave <= 10) {
            return EMAIL.NUDGE_SAVED;
        }
        return stillThereDue(facts, { fresh, ageDays, now });
    }
    // Joined or used, nothing saved.
    if (fresh(EMAIL.NUDGE_UNUSED) && ageDays >= 4 && ageDays <= 10) return EMAIL.NUDGE_UNUSED;
    return stillThereDue(facts, { fresh, ageDays, now });
}

// Day 21-35, below "returned", a week of quiet from every lifecycle email. Only
// reached for steps below RETURNED; the milestone is checked as well, so anyone
// the job has ever recorded a first return for is never asked.
function stillThereDue(facts, { fresh, ageDays, now }) {
    if (!fresh(EMAIL.STILL_THERE)) return null;
    if (ageDays < STILL_THERE_MIN_DAYS || ageDays > STILL_THERE_MAX_DAYS) return null;
    if (facts.milestones && typeof facts.milestones.has === 'function' && facts.milestones.has(RETURN_EVENT)) return null;
    if (hoursSince(facts.lastLifecycleSentAt, now) < STILL_THERE_QUIET_HOURS) return null;
    return EMAIL.STILL_THERE;
}

// ── Facts (SQL) ──────────────────────────────────────────────────────────────

const SESSION_SOURCES = morningAfter.SESSION_SOURCES;
const NOT_SAVES = morningAfter.NOT_SAVES;

let tableReady = null;
function ensureTable() {
    if (!tableReady) {
        // Also created by config/autoMigrate.js at boot; mirrored for scripts and
        // tests that never boot the app.
        tableReady = db.query(
            `CREATE TABLE IF NOT EXISTS value_ladder_sends (
               user_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
               email_type TEXT NOT NULL,
               claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
               sent_at    TIMESTAMPTZ,
               PRIMARY KEY (user_id, email_type)
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

// The person's keys: work stamped before the identity fix carries a key id.
const PERSON_IDS = (person) => `(${person} = ANY(ARRAY[u.user_id] || ARRAY(SELECT k.key_id FROM api_keys k WHERE k.owner_id = u.user_id)))`;

async function loadFacts({ now = new Date(), userIds = null } = {}) {
    await ensureTable();
    // The cooldown reads these two send logs. Created at boot by autoMigrate;
    // ensured here too because a missing table fails the whole facts query.
    await weeklyDigest.ensureSendLog().catch(() => {});
    await autoArchiveNotice.ensureNoticeLog().catch(() => {});
    const internal = internalIdentitySql({ emailExpr: 'u.email', platformStaffExpr: 'u.is_platform_staff' }, 7);
    const params = [
        new Date(now.getTime() - MAX_ACCOUNT_AGE_DAYS * DAY_MS).toISOString(),
        SESSION_SOURCES,
        NOT_SAVES,
        LIFECYCLE_SENT_EVENTS,
        Array.isArray(userIds) ? userIds : null,
        [RETURN_EVENT, HABIT_EVENT],
        ...internal.params,
    ];
    const res = await db.query(
        `SELECT u.user_id, u.org_id, u.email, u.created_at,
                COALESCE(u.weekly_digest_unsubscribed, false) AS unsubscribed,
                EXISTS (SELECT 1 FROM api_keys k WHERE k.owner_id = u.user_id AND k.oauth_resource IS NOT NULL) AS authorized,
                (SELECT k.oauth_client_name FROM api_keys k
                  WHERE k.owner_id = u.user_id AND k.oauth_resource IS NOT NULL
                  ORDER BY k.created_at DESC LIMIT 1) AS authorized_client,
                ARRAY(
                    SELECT DISTINCT d FROM (
                        SELECT t.day AS d FROM tool_usage_days t WHERE t.user_id = u.user_id
                        UNION
                        SELECT (pe.created_at AT TIME ZONE 'UTC')::date FROM product_events pe
                         WHERE pe.user_id = u.user_id AND pe.source = 'mcp'
                           AND pe.event_name IN ('mcp_tool_call_succeeded', 'mcp_start_session_succeeded')
                    ) used ORDER BY d
                )::text[] AS used_days,
                (SELECT t.client FROM tool_usage_days t
                  WHERE t.user_id = u.user_id AND t.client <> ''
                  GROUP BY t.client ORDER BY MAX(t.day) DESC, COUNT(*) DESC LIMIT 1) AS main_client,
                (SELECT MIN(ce.created_at) FROM context_events ce
                  WHERE ${PERSON_IDS('ce.contributing_user_id')}
                    AND ce.source_type = ANY($2) AND ce.event_kind <> ALL($3)) AS first_save_at,
                (SELECT COUNT(*) FROM context_projects p
                  WHERE p.archived_at IS NULL AND ${PERSON_IDS('p.owner_user_id')})::int AS own_projects,
                (SELECT COUNT(*) FROM workspace_invites wi WHERE wi.invited_by = u.user_id)::int AS invites_sent,
                (SELECT COALESCE(MAX(c), 0) FROM (
                    SELECT COUNT(*) AS c FROM workspace_members m
                     WHERE m.removed_at IS NULL
                       AND m.owner_key IN (SELECT wm.owner_key FROM workspace_members wm
                                            WHERE wm.user_id = u.user_id AND wm.removed_at IS NULL)
                     GROUP BY m.owner_key) w)::int AS workspace_members,
                EXISTS (
                    SELECT 1 FROM workspace_members wm
                      JOIN organizations o ON o.org_id = wm.owner_key
                     WHERE wm.user_id = u.user_id AND wm.removed_at IS NULL
                       AND COALESCE(o.plan_tier, o.plan, 'free') <> 'free'
                       AND COALESCE(o.subscription_status, 'active') IN ('active', 'trialing', 'past_due')
                ) AS paid,
                GREATEST(
                    (SELECT MAX(pe.created_at) FROM product_events pe
                      WHERE pe.user_id = u.user_id AND pe.event_name = ANY($4)),
                    (SELECT MAX(COALESCE(s.sent_at, s.claimed_at)) FROM value_ladder_sends s WHERE s.user_id = u.user_id),
                    (SELECT GREATEST(m.brief_sent_at, m.reminder_sent_at) FROM morning_after_brief_sends m WHERE m.user_id = u.user_id),
                    (SELECT MAX(w.last_sent_at) FROM weekly_digest_workspace_sends w WHERE w.user_id = u.user_id),
                    (SELECT MAX(n.sent_at) FROM project_archive_notices n WHERE n.user_id = u.user_id)
                ) AS last_lifecycle_sent_at,
                EXISTS (SELECT 1 FROM morning_after_brief_sends m WHERE m.user_id = u.user_id AND m.brief_sent_at IS NOT NULL) AS morning_after_sent,
                ARRAY(SELECT s.email_type FROM value_ladder_sends s WHERE s.user_id = u.user_id)::text[] AS sent,
                (SELECT COALESCE(s.sent_at, s.claimed_at) FROM value_ladder_sends s
                  WHERE s.user_id = u.user_id AND s.email_type = 'value_habit') AS habit_email_sent_at,
                ARRAY(SELECT DISTINCT pe.event_name FROM product_events pe
                       WHERE pe.user_id = u.user_id AND pe.event_name = ANY($6))::text[] AS milestones
           FROM users u
          WHERE u.created_at >= $1
            AND ($5::text[] IS NULL OR u.user_id = ANY($5))
            AND NOT ${internal.sql}
          ORDER BY u.created_at ASC`,
        params,
        'org-system',
    ).catch((err) => {
        console.warn(`[EMAIL] value ladder facts query failed: ${err.message}`);
        return { rows: [] };
    });
    return (res.rows || []).map(rowToFacts);
}

function rowToFacts(r) {
    return {
        userId: r.user_id,
        orgId: r.org_id,
        email: r.email,
        createdAt: r.created_at,
        unsubscribed: Boolean(r.unsubscribed),
        authorized: Boolean(r.authorized),
        authorizedClient: r.authorized_client || null,
        usedDays: r.used_days || [],
        mainClient: r.main_client || null,
        firstSaveAt: r.first_save_at || null,
        ownProjects: Number(r.own_projects) || 0,
        invitesSent: Number(r.invites_sent) || 0,
        workspaceMembers: Number(r.workspace_members) || 0,
        paid: Boolean(r.paid),
        lastLifecycleSentAt: r.last_lifecycle_sent_at || null,
        morningAfterSent: Boolean(r.morning_after_sent),
        sent: new Set(r.sent || []),
        habitEmailSentAt: r.habit_email_sent_at || null,
        milestones: new Set(r.milestones || []),
    };
}

// ── Claims ───────────────────────────────────────────────────────────────────

async function claim(userId, emailType, now = new Date()) {
    const res = await db.query(
        `INSERT INTO value_ladder_sends (user_id, email_type, claimed_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, email_type) DO NOTHING
         RETURNING user_id`,
        [userId, emailType, now.toISOString()],
        'org-system',
    );
    return res.rows.length > 0;
}

async function release(userId, emailType) {
    await db.query(
        'DELETE FROM value_ladder_sends WHERE user_id = $1 AND email_type = $2 AND sent_at IS NULL',
        [userId, emailType],
        'org-system',
    );
}

async function markSent(userId, emailType, now = new Date()) {
    await db.query(
        'UPDATE value_ladder_sends SET sent_at = $3 WHERE user_id = $1 AND email_type = $2',
        [userId, emailType, now.toISOString()],
        'org-system',
    );
}

// ── Copy (plain text, from John) ─────────────────────────────────────────────

// Which tool the person talks to DeerDawn from, for the sentence they should
// type. tool_usage_days' client wins (it is what they actually use); the OAuth
// client name only ever selects one of the labels we name, never reaches the
// email verbatim (Dynamic Client Registration lets anyone register anything).
function toolOf(facts) {
    const c = String(facts.mainClient || '');
    if (c === 'chatgpt_web') return 'chatgpt';
    if (c === 'claude_web') return 'claude';
    if (c === 'claude_code') return 'claude_code';
    if (c === 'codex') return 'codex';
    if (c === 'cursor') return 'cursor';
    const name = String(facts.authorizedClient || '');
    if (/chatgpt|openai/i.test(name)) return 'chatgpt';
    if (/claude/i.test(name)) return 'claude';
    return null;
}

const TOOL_NAME = {
    chatgpt: 'ChatGPT', claude: 'Claude', claude_code: 'Claude Code', codex: 'Codex', cursor: 'Cursor',
};

// The two phrases the activation plan teaches (Thing 3i). In ChatGPT the @
// mention is what makes the model reach for the connector.
function phrases(tool) {
    if (tool === 'chatgpt') {
        return { save: '@DeerDawn save what we worked out', resume: '@DeerDawn where did I leave off?' };
    }
    return { save: 'Save what we worked out to DeerDawn', resume: 'Where did I leave off? Check DeerDawn' };
}

// The standing instruction: what turns "I have to remember to ask" into "it
// loads by itself". Shorter than the dashboard's full prompts (connectCopy.ts
// AUTOMATION_SETUP) on purpose — this is pasted from an email on a phone.
const STANDING_INSTRUCTION = 'At the start of every conversation, call start_session from DeerDawn before you answer, and use what it returns. When we make a decision or finish something, save it with DeerDawn.';

function automationWhere(tool) {
    switch (tool) {
        case 'chatgpt': return 'ChatGPT: Settings > Personalization > Custom instructions';
        case 'claude': return 'Claude: Settings > Profile > personal preferences (or a Project\'s instructions)';
        case 'claude_code': return 'Claude Code: ~/.claude/CLAUDE.md';
        case 'codex': return 'Codex: ~/.codex/AGENTS.md';
        case 'cursor': return 'Cursor: Settings > Rules > User Rules';
        default: return 'your AI tool\'s custom instructions';
    }
}

function oneLine(value, max = 240) {
    const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

function footer(unsubUrl) {
    return ['', 'John', '', '--', `Unsubscribe: ${unsubUrl}`];
}

function briefBlock(brief) {
    if (!brief || !brief.lines) return [];
    const out = [];
    if (brief.lines.task) out.push(`  Working on: ${brief.lines.task}`);
    if (brief.lines.decision) out.push(`  Latest decision: ${brief.lines.decision}`);
    if (brief.lines.next) out.push(`  Next step: ${brief.lines.next}`);
    return out.length ? ['', ...out, ''] : [];
}

function pricingUrl(emailType) {
    const params = new URLSearchParams({ utm_source: 'lifecycle_email', utm_medium: 'email', utm_campaign: emailType });
    return `${MARKETING_URL}/pricing?${params.toString()}`;
}

// The day-21 check-in's one link. Its own utm_source and campaign, as asked
// for this email, so its arrivals read apart from the other lifecycle links.
function stillThereUrl() {
    const params = new URLSearchParams({ utm_source: 'lifecycle', utm_medium: 'email', utm_campaign: 'day21' });
    return `${MARKETING_URL}/start?${params.toString()}`;
}

function startUrl(emailType) {
    const params = new URLSearchParams({ utm_source: 'lifecycle_email', utm_medium: 'email', utm_campaign: emailType });
    return `${MARKETING_URL}/start?${params.toString()}`;
}

/** { subject, text } for one email. `brief` is { projectName, lines } or null. */
function render(emailType, facts, { brief = null, unsubUrl }) {
    const tool = toolOf(facts);
    const where = tool ? TOOL_NAME[tool] : 'your AI tool';
    const p = phrases(tool);
    const project = brief ? oneLine(brief.projectName, 80) : null;
    const connected = facts.authorized || (facts.usedDays || []).length > 0;

    switch (emailType) {
        case EMAIL.NUDGE_UNUSED: {
            if (connected) {
                return {
                    subject: `One sentence to try in ${where}`,
                    text: [
                        'Hi,',
                        '',
                        `DeerDawn is connected to ${where}, but nothing has been saved yet, so`,
                        'there is nothing for it to bring back.',
                        '',
                        `Next time you finish working something out in ${where}, type:`,
                        '',
                        `  ${p.save}`,
                        '',
                        'Then, in a new chat the next day:',
                        '',
                        `  ${p.resume}`,
                        '',
                        'It will pick up where you stopped, without you re-explaining. That is',
                        'the whole product. If something gets in the way, reply and tell me what.',
                        ...footer(unsubUrl),
                    ].join('\n'),
                };
            }
            return {
                subject: 'DeerDawn is not connected to your AI yet',
                text: [
                    'Hi,',
                    '',
                    'You signed up for DeerDawn but it is not connected to an AI tool yet, so',
                    'it cannot do anything for you. It takes about a minute, and you never',
                    'need to come back to our site afterwards. Everything happens in the',
                    'tool you already use.',
                    '',
                    `Pick your tool here: ${startUrl(emailType)}`,
                    '',
                    'Once it is connected, finish a chat with:',
                    '',
                    '  Save what we worked out to DeerDawn',
                    '',
                    'and start the next one with "Where did I leave off? Check DeerDawn".',
                    '',
                    'Stuck on any step? Reply and I will help.',
                    ...footer(unsubUrl),
                ].join('\n'),
            };
        }
        case EMAIL.NUDGE_SAVED:
            return {
                subject: project ? `Your ${project} brief is still waiting` : 'Your DeerDawn brief is still waiting',
                text: [
                    'Hi,',
                    '',
                    `A few days ago DeerDawn saved a brief${project ? ` for ${project}` : ''}. It has not been`,
                    'used since, so you have not seen the part that matters yet: your AI',
                    'picking up where you left off.',
                    ...briefBlock(brief),
                    `Start a new chat in ${where} and type:`,
                    '',
                    `  ${p.resume}`,
                    '',
                    'If it gets something wrong, reply and tell me.',
                    ...footer(unsubUrl),
                ].join('\n'),
            };
        case EMAIL.RETURNED:
            return {
                subject: 'That is DeerDawn working. Now make it automatic',
                text: [
                    'Hi,',
                    '',
                    `You came back to ${project || 'your project'} and your AI started from what you saved`,
                    'instead of from zero. That is what DeerDawn is for.',
                    ...briefBlock(brief),
                    'Right now it only loads when you ask. To make it load on its own every',
                    'time, paste this into',
                    `${automationWhere(tool)}:`,
                    '',
                    `  ${STANDING_INSTRUCTION}`,
                    '',
                    'After that, every new chat starts already knowing where you are.',
                    ...footer(unsubUrl),
                ].join('\n'),
            };
        case EMAIL.NUDGE_RETURNED:
            return {
                subject: project ? `${project} is where you left it` : 'Your project is where you left it',
                text: [
                    'Hi,',
                    '',
                    `DeerDawn still has${project ? ` ${project}` : ' your project'} saved, exactly where you left it.`,
                    ...briefBlock(brief),
                    `When you pick it up again, start the chat in ${where} with:`,
                    '',
                    `  ${p.resume}`,
                    '',
                    'And if it stopped being useful, I would really like to know why. Just',
                    'reply, one line is plenty.',
                    ...footer(unsubUrl),
                ].join('\n'),
            };
        case EMAIL.HABIT:
            return {
                subject: 'Three days in. Two ways to get more out of it',
                text: [
                    'Hi,',
                    '',
                    'You have now picked up your work through DeerDawn on three different days.',
                    'Thank you for using it. Two things that make it more useful from here:',
                    '',
                    `1. Use it from a second tool. What you saved in ${where} is there in`,
                    '   ChatGPT, Claude, Claude Code, Cursor and Codex as well. Start there',
                    `   with "${phrases(null).resume}" and it carries on.`,
                    '',
                    '2. Share it with whoever you work with. Their AI starts from the same',
                    '   brief, so you stop re-explaining things to each other as well as to',
                    '   the AI. Reply with their email and I will set it up.',
                    ...footer(unsubUrl),
                ].join('\n'),
            };
        case EMAIL.UPGRADE: {
            const signal = upgradeSignal(facts);
            if (signal === 'team') {
                const team = PLANS.developer_pro;
                return {
                    subject: 'DeerDawn for your team, free for 14 days',
                    text: [
                        'Hi,',
                        '',
                        'You are working on this with other people. On the Team plan everyone\'s',
                        'AI starts from one shared brief, every decision says who made it, and',
                        'you choose which projects are shared and which stay yours.',
                        '',
                        `It is $${team.price} per person per month, and the first ${team.trial_days || 14} days are free:`,
                        pricingUrl(emailType),
                        '',
                        'Questions, or want me to set it up with you? Reply here.',
                        ...footer(unsubUrl),
                    ].join('\n'),
                };
            }
            const pro = PLANS.developer_basic;
            return {
                subject: 'You have more than one project in DeerDawn now',
                text: [
                    'Hi,',
                    '',
                    'You have several projects in DeerDawn now. On Free each one is',
                    `remembered on its own, for ${PLANS.free.limits.history_days} days. ${pro.publicName} connects them:`,
                    'search across every project, the people, services and decisions they',
                    'share, and history that never ages out.',
                    '',
                    `It is $${pro.price} a month or $${pro.annual_price} a year: ${pricingUrl(emailType)}`,
                    '',
                    'Free keeps working exactly as it does now if you stay on it.',
                    ...footer(unsubUrl),
                ].join('\n'),
            };
        }
        case EMAIL.STILL_THERE:
            return {
                subject: 'Did something get in the way?',
                text: [
                    'Hi,',
                    '',
                    'You signed up for DeerDawn about three weeks ago, and from what I can',
                    'see it has not done much for you yet.',
                    '',
                    'Did something get in the way?',
                    '',
                    'If you reply and tell me where you got stuck, I will help you get it',
                    'working. One line is plenty.',
                    '',
                    'If you would rather try again on your own, the steps for each tool are',
                    `here: ${stillThereUrl()}`,
                    ...footer(unsubUrl),
                ].join('\n'),
            };
        default:
            throw new Error(`unknown value-ladder email: ${emailType}`);
    }
}

// The project an email quotes: the one this person saved to most recently, and
// only one that is wholly theirs (the same predicate as the morning-after brief).
async function loadOwnBrief(userId) {
    const res = await db.query(
        `SELECT p.project_id, p.owner_key
           FROM context_projects p
           JOIN users u ON u.user_id = $1
          WHERE p.archived_at IS NULL
            AND ${morningAfter.ownReadableProjectSql('u.user_id', 'p', 'u')}
          ORDER BY p.updated_at DESC
          LIMIT 1`,
        [userId],
        'org-system',
    ).catch(() => ({ rows: [] }));
    const row = res.rows[0];
    if (!row) return null;
    try {
        const project = await store.getProjectContextOnly(row.owner_key, row.project_id);
        if (!project || project.archived_at) return null;
        const lines = morningAfter.briefLines(project.context);
        if (!lines) return null;
        return { projectName: project.project_name, lines };
    } catch {
        return null;
    }
}

// ── The job ──────────────────────────────────────────────────────────────────

function recordEvent(facts, eventName, metadata) {
    return productEvents.recordProductEvent(
        { type: 'user', id: facts.userId, org_id: facts.orgId || null },
        { event_name: eventName, source: 'api', surface: 'value_ladder', metadata },
    ).catch((err) => console.warn(`[EMAIL] value ladder event ${eventName} failed for ${facts.userId}: ${err.message}`));
}

// Once per person, whenever the job first sees them at the step.
async function recordMilestones(facts) {
    const l = ladderOf(facts);
    let recorded = 0;
    if (l.step >= STEP.RETURNED && !facts.milestones.has(RETURN_EVENT)) {
        await recordEvent(facts, RETURN_EVENT, { first_return_day: l.firstReturnDay, first_save_day: l.firstSaveDay });
        recorded += 1;
    }
    if (l.step >= STEP.HABIT && !facts.milestones.has(HABIT_EVENT)) {
        await recordEvent(facts, HABIT_EVENT, { habit_day: l.habitDay, days_used: l.days.length });
        recorded += 1;
    }
    return recorded;
}

const NEEDS_BRIEF = new Set([EMAIL.NUDGE_SAVED, EMAIL.RETURNED, EMAIL.NUDGE_RETURNED]);

async function sendOne(facts, emailType, { now, cfg }) {
    let claimed = false;
    let delivered = false;
    try {
        const brief = NEEDS_BRIEF.has(emailType) ? await loadOwnBrief(facts.userId) : null;
        if (!(await claim(facts.userId, emailType, now))) return false;
        claimed = true;
        const { subject, text } = render(emailType, facts, { brief, unsubUrl: unsubscribeUrl(facts.userId) });
        const result = await resendClient.sendEmail({
            to: facts.email,
            from: cfg.from,
            replyTo: REPLY_TO,
            subject,
            text,
            emailType,
        });
        if (!result?.ok) {
            await release(facts.userId, emailType);
            return false;
        }
        // Sent: from here on the claim must stay, whatever fails below.
        delivered = true;
        await _internals.markSent(facts.userId, emailType, now);
        await recordEvent(facts, SENT_EVENT, { channel: 'email', email_type: emailType, step: ladderOf(facts).step });
        return true;
    } catch (err) {
        console.warn(`[EMAIL] value ladder ${emailType} failed for ${facts.userId}: ${err.message}`);
        if (claimed && !delivered) await release(facts.userId, emailType).catch(() => {});
        return delivered;
    }
}

// `userIds` narrows the run to those people (tests, and a hand-run for one person).
async function runValueLadder({ now = new Date(), userIds = null } = {}) {
    await toolUsageDays.ensureTable().catch(() => {});
    await morningAfter.ensureTable().catch(() => {});
    const all = await loadFacts({ now, userIds });

    let milestones = 0;
    for (const facts of all) milestones += await recordMilestones(facts);

    const cfg = settings();
    const sending = isEnabled() && Boolean(process.env.RESEND_API_KEY) && inSendWindow(now, cfg);
    let sent = 0;
    let due = 0;
    if (sending) {
        for (const facts of all) {
            if (sent >= cfg.maxPerRun) break;
            if (!facts.email || facts.unsubscribed) continue;
            const emailType = dueEmail(facts, now);
            if (!emailType) continue;
            due += 1;
            if (await sendOne(facts, emailType, { now, cfg })) sent += 1;
        }
    }
    console.log(`[EMAIL] Value ladder: ${all.length} people, ${milestones} milestones, ${sending ? `sent ${sent}/${due}` : 'not sending'}`);
    return { people: all.length, milestones, sending, sent, due };
}

function resetForTests() {
    tableReady = null;
}

// A module object so a test can make the post-send bookkeeping fail.
const _internals = { markSent };

module.exports = {
    _internals,
    STEP,
    EMAIL,
    SENT_EVENT,
    RETURN_EVENT,
    HABIT_EVENT,
    LIFECYCLE_SENT_EVENTS,
    COOLDOWN_HOURS,
    STILL_THERE_QUIET_HOURS,
    ladderOf,
    dueEmail,
    upgradeSignal,
    toolOf,
    render,
    loadFacts,
    runValueLadder,
    inSendWindow,
    isEnabled,
    ensureTable,
    resetForTests,
};
