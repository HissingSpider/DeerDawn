'use strict';

// Weekly activity-digest email — the outbound RETURN TRIGGER the retention loop
// was missing. The reward (the start_session brief) was already excellent; this
// is the trigger that brings users back to receive it. Best-effort throughout:
// a failure for one recipient never aborts the run.

const crypto = require('crypto');
const db = require('../../config/db');
const { computeWorkspaceActivity } = require('../activityDigestService');
const workspaceService = require('../workspaceService');
// Required as a module object (not destructured) so a test can replace the
// transport and count what would actually have been sent.
const resendClient = require('./resendClient');

const SECRET = process.env.JWT_SECRET || 'dev-secret';
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://app.deerdawn.com';
const API_URL = process.env.PUBLIC_API_URL || 'https://api.deerdawn.com';
const MAX_PER_RUN = Number(process.env.WEEKLY_DIGEST_MAX_PER_RUN) || 2000;

// ── ONE DIGEST PER PERSON PER WORKSPACE PER WEEK, WHOEVER ASKS ───────────────
//
// Nothing recorded that a digest had been sent. The only thing standing between
// a recipient and a second copy was the scheduler's Redis lock, which is held
// for five minutes and then forgotten. That is not a statement about this week:
//
//   - Every machine runs its own 7-day timer, started when THAT machine booted.
//     Two machines booted two days apart each fire weekly, two days apart, and
//     each finds the lock free. Every recipient gets two digests a week.
//   - A restart re-arms the timer from zero, so the send drifts to wherever the
//     last deploy left it, independently per machine.
//   - A run longer than the lock TTL (2,000 recipients, one HTTP call each)
//     outlives its own lock mid-send.
//   - And the lock used to fail OPEN, so a Redis blip meant every machine sent.
//
// The fix is a marker in the database, because "has this person had their
// digest" is a durable fact about a person and not a property of a process.
// The CLAIM is the atomic step: one upsert whose WHERE clause only lets it
// through when the previous claim is older than the slot. Postgres serialises
// concurrent upserts on the same row, so of any number of simultaneous senders
// exactly one gets a row back and the rest get nothing and move on. It is
// checked BEFORE sending, and it holds with the scheduler lock gone entirely.
//
// THE MARKER IS PER PERSON PER WORKSPACE (journey r6). The digest goes to every
// member of a team, and one person can belong to several workspaces; each one
// is a separate email about separate work, so a marker keyed by the person alone
// would let the first workspace's send suppress every other.
//
// THE SCHEDULE IS A SLOT, NOT A TIMER. A week starts at a fixed weekday and hour
// (Monday 14:00 UTC unless WEEKLY_DIGEST_DAY / WEEKLY_DIGEST_HOUR say otherwise)
// and a person is DUE when they have not been claimed since that moment. The
// scheduler ticks every hour and asks "who is due", so:
//   - a restart changes nothing: the answer comes from the table, not from when
//     the process booted, so the send never drifts to wherever a deploy left it;
//   - a machine that was down at 14:00 catches up on its first tick after, once;
//   - every machine and every tick in the same week agree on who is due, so the
//     claim below is what decides between them and there is no second copy.
// Three days as a floor between two sends as well, so the first slot after this
// shipped cannot repeat a digest the old seven-day timer sent a day or two
// before, while a catch-up send on a Wednesday still leaves the next Monday's
// slot open (five days on).
//
// AT MOST ONCE, deliberately. A send that fails releases its claim so the next
// tick retries. A process that dies between claiming and sending leaves the
// claim in place and that person misses one digest. The alternative (reclaim
// stale claims) resends whenever the crash came after Resend accepted the
// message, and an email cannot be recalled. A missed digest is the cheaper
// error.
const MIN_GAP_DAYS = Math.max(1, Number(process.env.WEEKLY_DIGEST_MIN_GAP_DAYS) || 3);
function envInt(name, min, max, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}
const SLOT_DAY = envInt('WEEKLY_DIGEST_DAY', 0, 6, 1);
const SLOT_HOUR = envInt('WEEKLY_DIGEST_HOUR', 0, 23, 14);

/** The most recent moment the weekly slot opened, at or before `now` (UTC). */
function currentSlotStart(now = new Date()) {
    const t = now instanceof Date ? now : new Date(now);
    const open = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), SLOT_HOUR, 0, 0, 0);
    const daysBack = (t.getUTCDay() - SLOT_DAY + 7) % 7;
    let start = open - daysBack * 86400000;
    if (start > t.getTime()) start -= 7 * 86400000;
    return new Date(start);
}

let sendLogReady = null;
function ensureSendLog() {
    if (!sendLogReady) {
        // Also created by config/autoMigrate.js at boot. Repeated here because
        // this module is reachable from scripts and tests that never boot the
        // app, and a missing table would otherwise read as "everyone is
        // unclaimed". ON DELETE CASCADE: the row is about a person and goes
        // with them (every FK into users must declare an action — see
        // tests/integration/user-delete-fk.test.js).
        sendLogReady = db.query(
            `CREATE TABLE IF NOT EXISTS weekly_digest_workspace_sends (
               user_id      TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
               owner_key    TEXT NOT NULL,
               claimed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
               last_sent_at TIMESTAMPTZ,
               sends        INTEGER NOT NULL DEFAULT 0,
               PRIMARY KEY (user_id, owner_key)
             )`,
            [],
            'org-system',
        ).then(() => db.query(
            // The old marker was per person. Carry it over against the person's
            // own workspace (the one the old job always sent for) so the week
            // this ships does not repeat a digest somebody already had.
            `INSERT INTO weekly_digest_workspace_sends (user_id, owner_key, claimed_at, last_sent_at, sends)
             SELECT s.user_id, u.org_id, s.claimed_at, s.last_sent_at, s.sends
               FROM weekly_digest_sends s
               JOIN users u ON u.user_id = s.user_id
              WHERE u.org_id IS NOT NULL
             ON CONFLICT (user_id, owner_key) DO NOTHING`,
            [],
            'org-system',
        ).catch(() => null)).catch((err) => {
            sendLogReady = null;
            throw err;
        });
    }
    return sendLogReady;
}

/** True when THIS caller now owns the right to send this person's digest for this workspace. */
async function claimDigest(userId, ownerKey, now = new Date()) {
    await ensureSendLog();
    const slotStart = currentSlotStart(now);
    const floor = new Date(now.getTime() - MIN_GAP_DAYS * 86400000);
    const res = await db.query(
        `INSERT INTO weekly_digest_workspace_sends (user_id, owner_key, claimed_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, owner_key) DO UPDATE SET claimed_at = $3
           WHERE weekly_digest_workspace_sends.claimed_at < $4
             AND weekly_digest_workspace_sends.claimed_at < $5
         RETURNING user_id`,
        [userId, ownerKey, now.toISOString(), slotStart.toISOString(), floor.toISOString()],
        'org-system',
    );
    return res.rows.length > 0;
}

async function markDigestSent(userId, ownerKey, now = new Date()) {
    await db.query(
        'UPDATE weekly_digest_workspace_sends SET last_sent_at = $3, sends = sends + 1 WHERE user_id = $1 AND owner_key = $2',
        [userId, ownerKey, now.toISOString()],
        'org-system',
    );
}

/** The send did not happen: give the claim back so the next tick can retry. */
async function releaseDigestClaim(userId, ownerKey) {
    await db.query(
        'UPDATE weekly_digest_workspace_sends SET claimed_at = COALESCE(last_sent_at, \'epoch\'::timestamptz) WHERE user_id = $1 AND owner_key = $2',
        [userId, ownerKey],
        'org-system',
    );
}

// Stateless HMAC unsubscribe token — no token column needed; the link is valid
// as long as JWT_SECRET is stable and is unguessable without it.
function unsubscribeToken(userId) {
    return crypto.createHmac('sha256', SECRET).update(`unsub:${userId}`).digest('hex').slice(0, 32);
}

function verifyUnsubscribeToken(userId, token) {
    if (!userId || !token) return false;
    const expected = unsubscribeToken(userId);
    if (token.length !== expected.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
    } catch {
        return false;
    }
}

function unsubscribeUrl(userId) {
    return `${API_URL}/api/v1/email/unsubscribe?u=${encodeURIComponent(userId)}&t=${unsubscribeToken(userId)}`;
}

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]
    ));
}

function renderDigestHtml(digest, userId, { workspaceName = null } = {}) {
    const tools = (digest.delivered_by_tool || []).slice(0, 4).map((t) => t.tool).filter(Boolean).join(', ');
    const stats = [];
    if (digest.context_delivered > 0) stats.push(`<strong>${digest.context_delivered}</strong> briefs delivered${tools ? ` across ${esc(tools)}` : ''}`);
    if (digest.decisions_captured > 0) stats.push(`<strong>${digest.decisions_captured}</strong> decisions captured`);
    if (digest.projects_touched > 0) stats.push(`<strong>${digest.projects_touched}</strong> projects active`);
    const staleLine = digest.stale_projects > 0
        ? `<p style="margin:16px 0 0;color:#9aa4b2;font-size:14px;line-height:1.6;">⚠ ${digest.stale_projects} project${digest.stale_projects === 1 ? '' : 's'} drifting from your latest work — open ${digest.stale_projects === 1 ? 'it' : 'them'} in your AI tool and DeerDawn rebriefs ${digest.stale_projects === 1 ? 'it' : 'them'} automatically.</p>`
        : '';
    // Habit moment: everything above came through ONE tool — a fact plus an
    // offer, never a nag. Links /setup, not the legacy /settings/tools: the
    // redirect that keeps the old URL alive strips the query string (see
    // activationFollowUp.followUpCtaUrl), so any tracked variant of this link
    // would arrive stripped too. The brief following you to a second surface is the
    // moment DeerDawn stops being "a tool I tried" and becomes infrastructure.
    const distinctTools = (digest.delivered_by_tool || []).filter((t) => t && t.tool).length;
    const secondToolLine = distinctTools === 1 && digest.context_delivered > 0
        ? `<p style="margin:16px 0 0;color:#9aa4b2;font-size:14px;line-height:1.6;">All of this reached you through one tool. Connect a second — Cursor, Claude, ChatGPT, or Codex — and the same brief follows you there too. <a href="${esc(DASHBOARD_URL)}/setup" style="color:#10B981;">Connect a second tool &rarr;</a></p>`
        : '';
    return `<!doctype html><html><body style="margin:0;background:#07111d;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px;color:#e5e7eb;">
    <div style="font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:#10B981;font-weight:700;">DeerDawn · this week</div>
    <h1 style="margin:10px 0 0;font-size:24px;line-height:1.2;color:#ffffff;">Here&rsquo;s your DeerDawn brief for the week</h1>${workspaceName ? `
    <p style="margin:8px 0 0;color:#9aa4b2;font-size:14px;line-height:1.6;">Workspace: ${esc(workspaceName)}. This covers the work you can read there.</p>` : ''}
    <ul style="margin:18px 0 0;padding-left:18px;color:#cbd5e1;font-size:15px;line-height:1.9;">
      ${stats.length ? stats.map((s) => `<li>${s}</li>`).join('') : '<li>Your brief is ready and waiting in every connected tool — no session starts cold.</li>'}
    </ul>
    ${staleLine}
    ${secondToolLine}
    <a href="${esc(DASHBOARD_URL)}" style="display:inline-block;margin-top:24px;background:#10B981;color:#03120b;text-decoration:none;font-weight:600;font-size:14px;padding:12px 20px;border-radius:12px;">Resume where you left off &rarr;</a>
    <p style="margin:28px 0 0;color:#6b7280;font-size:12px;line-height:1.6;">You&rsquo;re getting this because you use DeerDawn. <a href="${esc(unsubscribeUrl(userId))}" style="color:#6b7280;">Unsubscribe from the weekly digest and reminder emails</a>.</p>
  </div></body></html>`;
}

// WHO IS DUE. Every active member of every workspace whose context moved this
// week, minus anybody who unsubscribed and anybody already claimed for the
// current slot. A workspace with no roster rows at all (an account the roster
// backfill has not reached) falls back to what this job always did: its
// earliest user, or the bare user id an owner_key can be.
//
// The claimed-this-slot filter is only a cheap pre-check so an hourly tick over
// an already-served week costs a query and not a digest computation per member.
// The atomic claim in claimDigest is what actually decides.
async function findRecipients({ now = new Date() } = {}) {
    const slotStart = currentSlotStart(now).toISOString();
    const floor = new Date(now.getTime() - MIN_GAP_DAYS * 86400000).toISOString();
    await ensureSendLog();
    const activeRes = await db.query(
        'SELECT DISTINCT owner_key FROM context_projects WHERE updated_at > NOW() - interval \'7 days\'',
        [],
        'org-system',
    ).catch((err) => {
        console.warn(`[EMAIL] active-orgs query failed: ${err.message}`);
        return { rows: [] };
    });
    const ownerKeys = (activeRes.rows || []).map((row) => row.owner_key).filter(Boolean);
    if (!ownerKeys.length) return [];

    const memberRes = await db.query(
        `SELECT m.owner_key, m.user_id, m.role, u.email, o.name AS workspace_name
           FROM workspace_members m
           JOIN users u ON u.user_id = m.user_id
           LEFT JOIN organizations o ON o.org_id = m.owner_key
          WHERE m.owner_key = ANY($1::text[])
            AND m.removed_at IS NULL
            AND u.email IS NOT NULL
            AND COALESCE(u.weekly_digest_unsubscribed, false) = false
            AND NOT EXISTS (
              SELECT 1 FROM weekly_digest_workspace_sends d
               WHERE d.user_id = m.user_id AND d.owner_key = m.owner_key
                 AND (d.claimed_at >= $2 OR d.claimed_at >= $3)
            )
          ORDER BY m.owner_key, m.joined_at ASC`,
        [ownerKeys, slotStart, floor],
        'org-system',
    ).catch((err) => {
        console.warn(`[EMAIL] member lookup failed: ${err.message}`);
        return { rows: [] };
    });

    const recipients = [];
    const covered = new Set();
    for (const row of memberRes.rows || []) {
        covered.add(row.owner_key);
        recipients.push({
            orgId: row.owner_key,
            userId: row.user_id,
            email: row.email,
            role: row.role,
            workspaceName: row.workspace_name || null,
        });
    }

    // Owners with no active roster row at all: the pre-roster path.
    const rostered = await db.query(
        'SELECT DISTINCT owner_key FROM workspace_members WHERE owner_key = ANY($1::text[]) AND removed_at IS NULL',
        [ownerKeys],
        'org-system',
    ).then((r) => new Set((r.rows || []).map((x) => x.owner_key))).catch(() => new Set(ownerKeys));
    for (const ownerKey of ownerKeys) {
        if (rostered.has(ownerKey) || covered.has(ownerKey)) continue;
        const orgRes = await db.query(
            `SELECT u.user_id, u.email, COALESCE(u.weekly_digest_unsubscribed, false) AS unsubscribed
               FROM users u
              WHERE u.org_id = $1 AND u.email IS NOT NULL
              ORDER BY u.created_at ASC
              LIMIT 1`,
            [ownerKey],
        ).catch((err) => {
            console.warn(`[EMAIL] recipient lookup failed for ${ownerKey}: ${err.message}`);
            return { rows: [] };
        });
        let r = orgRes.rows && orgRes.rows[0];
        if (!r) {
            const userRes = await db.query(
                `SELECT user_id, email, COALESCE(weekly_digest_unsubscribed, false) AS unsubscribed
                   FROM users WHERE user_id = $1 AND email IS NOT NULL`,
                [ownerKey],
            ).catch(() => ({ rows: [] }));
            r = userRes.rows && userRes.rows[0];
        }
        if (!r || !r.email || r.unsubscribed) continue;
        recipients.push({ orgId: ownerKey, userId: r.user_id, email: r.email, role: 'owner', workspaceName: null });
    }
    return recipients.slice(0, MAX_PER_RUN);
}

async function sendWeeklyDigestEmails({ now = new Date() } = {}) {
    if (!process.env.RESEND_API_KEY) {
        console.log('[EMAIL] Weekly digest skipped — RESEND_API_KEY not set');
        return { sent: 0, skipped: true };
    }
    const recipients = await findRecipients({ now });
    const teamByKey = new Map();
    const isTeamWorkspace = async (ownerKey) => {
        if (!teamByKey.has(ownerKey)) {
            teamByKey.set(ownerKey, await workspaceService.isSharedWorkspace(ownerKey).catch(() => false));
        }
        return teamByKey.get(ownerKey);
    };
    let sent = 0;
    for (const r of recipients) {
        try {
            // Computed AS THIS MEMBER: the projects, decisions and drifting
            // counts are the ones this person may read in this workspace
            // (personal work of others never counts, private work only for its
            // author and owners, shared work through its share policy).
            const digest = await computeWorkspaceActivity(
                { type: 'user', id: r.userId, org_id: r.orgId, workspace_key: r.orgId, role: r.role },
                7,
            );
            const hasActivity = digest.context_delivered > 0 || digest.decisions_captured > 0 || digest.projects_touched > 0;
            if (!hasActivity) continue;
            // Claim AFTER the activity check, so a quiet week does not consume
            // the claim and suppress next week's digest, and BEFORE the send,
            // so two senders cannot both be past this line for one person.
            if (!(await claimDigest(r.userId, r.orgId, now))) continue;
            let result;
            try {
                // A person in two workspaces gets two digests; say which is which.
                // A solo account keeps the copy it always had.
                const teamName = r.workspaceName && (await isTeamWorkspace(r.orgId)) ? r.workspaceName : null;
                result = await resendClient.sendEmail({
                    to: r.email,
                    subject: teamName
                        ? `Your DeerDawn week in ${teamName} — pick up where you left off`
                        : 'Your DeerDawn week — pick up where you left off',
                    html: renderDigestHtml(digest, r.userId, { workspaceName: teamName }),
                });
            } catch (sendErr) {
                result = { ok: false, error: sendErr.message };
            }
            if (result && result.ok) {
                sent += 1;
                await markDigestSent(r.userId, r.orgId, now);
            } else {
                await releaseDigestClaim(r.userId, r.orgId);
            }
        } catch (err) {
            console.warn(`[EMAIL] digest failed for ${r.orgId}/${r.userId}: ${err.message}`);
        }
    }
    if (recipients.length) console.log(`[EMAIL] Weekly digest sent ${sent}/${recipients.length}`);
    return { sent, total: recipients.length };
}

async function unsubscribeUser(userId, token) {
    if (!verifyUnsubscribeToken(userId, token)) return false;
    await db.query(
        'UPDATE users SET weekly_digest_unsubscribed = TRUE WHERE user_id = $1',
        [userId],
    );
    return true;
}

module.exports = {
    sendWeeklyDigestEmails,
    ensureSendLog,
    findRecipients,
    currentSlotStart,
    unsubscribeUser,
    unsubscribeToken,
    verifyUnsubscribeToken,
    unsubscribeUrl,
    renderDigestHtml,
};
