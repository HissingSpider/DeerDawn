'use strict';

// The one email the 30-day auto-archive sends (journey r6, owner decision:
// "auto-archive: one email when it happens").
//
// A project that ages out drops off the dashboard and out of start_session. The
// data is all still there, but to the person it reads as "my project vanished".
// This says, once, that it was archived and not deleted, names what was
// archived, and gives both ways back.
//
// WHO IS TOLD, AND WHY THE NARROWEST SENSIBLE SET. Only people who may read the
// project, because the message names it:
//
//   personal  the author, and nobody else. Not even a workspace owner: that is
//             what `personal` means.
//   private   the author and the workspace owners: org-owned work an owner may
//             read, so an owner is told when it leaves the board.
//   shared    the author and the workspace owners. The rest of the team can read
//             a shared project, but a project going quiet is news for the person
//             who owns it and the people accountable for the workspace, not a
//             note to every member and viewer. (Somebody else who wants it back
//             finds it under "archived" in the dashboard, which the message
//             points at.)
//
// ONLY TOLD TO RESTORE WHAT THEY CAN RESTORE. Restore is the author's while the
// author is still a member of the workspace. An owner reading a colleague's
// PRIVATE project is told it was archived and that its author can restore it,
// and is given no restore call or id for it. Once the author has no active
// membership the owner can restore it, and is told how (as for a workspace-owned
// project with no author).
//
// A SERVICE NOTICE, not a nudge (owner decision, journey r6): it is sent even to
// somebody who unsubscribed from the weekly digest. That unsubscribe covers the
// digest and the reminder emails; a message that says one of your projects just
// left the board is about your data, not marketing, and carries no unsubscribe
// link. The email says so.
//
// A project with no recorded author (workspace-owned) goes to the owners. A
// person the workspace removed is not told about its work, and an author who has
// left leaves a personal project with nobody to tell: it is not an owner's to
// read, and the message would name it.
//
// ONE EMAIL PER PERSON PER RUN. Everything archived for a person in one sweep is
// one message, across workspaces. The claim rows below make it once per archive
// even if the sender is called again for the same sweep (a retry, two machines):
// a row per (person, project, archive moment), inserted before sending.
//
// Best-effort, like every job email: a failure here never fails the archive.

const db = require('../../config/db');
const workspace = require('../workspaceService');
const resendClient = require('./resendClient');

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://app.deerdawn.com';
// Same route the dashboard's archived-projects notice sends people to
// (dashboard/src/lib/archivedProjects.ts RESTORE_ROUTE).
const RESTORE_ROUTE = '/projects?manage=archived';
// +clerk_test addresses are journey-test signups, not mailboxes (see
// activationFollowUp.TEST_EMAIL_MARKER).
const TEST_EMAIL_MARKER = '+clerk_test';
const MAX_LISTED = 20;

let noticeLogReady = null;
function ensureNoticeLog() {
    if (!noticeLogReady) {
        // Also created by config/autoMigrate.js at boot; repeated for scripts and
        // tests that never boot the app. ON DELETE CASCADE: the row is about a
        // person and goes with them.
        noticeLogReady = db.query(
            `CREATE TABLE IF NOT EXISTS project_archive_notices (
               user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
               project_id  TEXT NOT NULL,
               archived_at TIMESTAMPTZ NOT NULL,
               sent_at     TIMESTAMPTZ,
               PRIMARY KEY (user_id, project_id, archived_at)
             )`,
            [],
            'org-system',
        ).catch((err) => {
            noticeLogReady = null;
            throw err;
        });
    }
    return noticeLogReady;
}

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]
    ));
}

/** Who may be told about each project: Map<userId, { email, entries: [{ row, workspaceName }] }>. */
async function resolveRecipients(rows) {
    const ownerKeys = [...new Set(rows.map((row) => row.owner_key).filter(Boolean))];
    const rosters = new Map();
    for (const ownerKey of ownerKeys) {
        const members = await workspace.listMembers(ownerKey).catch(() => []);
        rosters.set(ownerKey, members.filter((m) => m.active && m.email));
    }
    const shared = new Map();
    for (const ownerKey of ownerKeys) {
        shared.set(ownerKey, await workspace.isSharedWorkspace(ownerKey).catch(() => false));
    }
    const names = new Map();
    if (ownerKeys.length) {
        const res = await db.query(
            'SELECT org_id, name FROM organizations WHERE org_id = ANY($1::text[])',
            [ownerKeys],
            'org-system',
        ).catch(() => ({ rows: [] }));
        for (const r of res.rows || []) names.set(r.org_id, r.name);
    }

    // The pre-roster case: an account the roster backfill has not reached has no
    // rows at all, and its one person is the author, or the earliest user.
    async function legacyPerson(row) {
        const byAuthor = row.owner_user_id
            ? await db.query('SELECT user_id, email FROM users WHERE user_id = $1 AND email IS NOT NULL', [row.owner_user_id], 'org-system').catch(() => ({ rows: [] }))
            : { rows: [] };
        if (byAuthor.rows[0]) return byAuthor.rows[0];
        const byOrg = await db.query(
            'SELECT user_id, email FROM users WHERE org_id = $1 AND email IS NOT NULL ORDER BY created_at ASC LIMIT 1',
            [row.owner_key],
            'org-system',
        ).catch(() => ({ rows: [] }));
        return byOrg.rows[0] || null;
    }

    const wanted = []; // { user_id, email, row, canRestore }
    // The author, judged the way the API judges them: a project written before
    // the identity fix is stamped with a KEY id, and is its key owner's. Whether
    // they are still a member is asked of the roster by PERSON
    // (workspace.resolveAuthors), never of the raw stamp.
    const authorsByKey = new Map();
    for (const ownerKey of ownerKeys) {
        const stamps = rows.filter((row) => row.owner_key === ownerKey).map((row) => row.owner_user_id).filter(Boolean);
        authorsByKey.set(ownerKey, (rosters.get(ownerKey) || []).length && stamps.length
            ? await workspace.resolveAuthors(ownerKey, stamps).catch(() => null)
            : null);
    }
    for (const row of rows) {
        const roster = rosters.get(row.owner_key) || [];
        if (!roster.length) {
            const person = await legacyPerson(row);
            if (person) wanted.push({ ...person, row, canRestore: true });
            continue;
        }
        const authors = authorsByKey.get(row.owner_key);
        const authorPerson = row.owner_user_id && authors ? authors.personOf(row.owner_user_id) : null;
        // isActive is the API's own answer to "has the author left", including for
        // a stamp it cannot resolve to a person; the roster row is only needed to
        // know WHO to write to.
        const authorActive = Boolean(row.owner_user_id && authors && authors.isActive(row.owner_user_id));
        const author = authorActive && authorPerson ? roster.find((m) => m.user_id === authorPerson) : null;
        if (author) wanted.push({ user_id: author.user_id, email: author.email, row, canRestore: true });
        // An owner reads private and shared work, and unattributed (workspace
        // owned) work; never somebody else's personal project.
        if (row.visibility !== 'personal' || !row.owner_user_id) {
            for (const owner of roster.filter((m) => m.role === 'owner')) {
                if (author && owner.user_id === author.user_id) continue;
                // A private project belongs to its author while they are a member.
                const authorRestores = authorActive && row.visibility === 'private';
                wanted.push({ user_id: owner.user_id, email: owner.email, row, canRestore: !authorRestores });
            }
        }
    }

    const people = new Map();
    for (const w of wanted) {
        if (!w.email) continue;
        if (String(w.email).toLowerCase().includes(TEST_EMAIL_MARKER)) continue;
        if (!people.has(w.user_id)) people.set(w.user_id, { email: w.email, entries: [] });
        people.get(w.user_id).entries.push({
            row: w.row,
            canRestore: w.canRestore !== false,
            workspaceName: shared.get(w.row.owner_key) ? (names.get(w.row.owner_key) || null) : null,
        });
    }
    return people;
}

function renderNoticeHtml(entries, { days }) {
    const listed = entries.slice(0, MAX_LISTED);
    const more = entries.length - listed.length;
    const restorable = entries.filter((e) => e.canRestore);
    const items = listed.map(({ row, workspaceName, canRestore }) => `<li style="margin:0 0 10px;">
        <strong style="color:#ffffff;">${esc(row.project_name)}</strong>${workspaceName ? ` <span style="color:#9aa4b2;">in ${esc(workspaceName)}</span>` : ''}
        ${canRestore
        ? `<div style="font-size:12px;color:#9aa4b2;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${esc(row.project_id)}</div>`
        : '<div style="font-size:13px;color:#9aa4b2;">Its author can restore it.</div>'}
      </li>`).join('');
    const one = entries.length === 1;
    const restoreParagraph = restorable.length
        ? `<p style="margin:18px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">
      To bring ${restorable.length === 1 ? 'it' : 'one'} back, open Restore in the dashboard, or ask your AI tool to run manage_projects with action &ldquo;restore&rdquo; and the project id shown above (for example project_id &ldquo;${esc(restorable[0].row.project_id)}&rdquo;). A restored project gets a fresh ${esc(days)}-day window.${restorable.length < entries.length ? ' The others can be restored by their authors.' : ''}
    </p>
    <a href="${esc(DASHBOARD_URL)}${RESTORE_ROUTE}" style="display:inline-block;margin-top:24px;background:#10B981;color:#03120b;text-decoration:none;font-weight:600;font-size:14px;padding:12px 20px;border-radius:12px;">Restore in the dashboard &rarr;</a>`
        : `<p style="margin:18px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">
      ${one ? 'Its author' : 'Their authors'} can restore ${one ? 'it' : 'them'} from DeerDawn. There is nothing you need to do.
    </p>`;
    return `<!doctype html><html><body style="margin:0;background:#07111d;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px;color:#e5e7eb;">
    <div style="font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:#10B981;font-weight:700;">DeerDawn</div>
    <h1 style="margin:10px 0 0;font-size:23px;line-height:1.25;color:#ffffff;">${one ? 'A project was archived' : `${entries.length} projects were archived`}</h1>
    <p style="margin:16px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">
      ${one ? 'This project has' : 'These projects have'} had no activity for ${esc(days)} days, so DeerDawn archived ${one ? 'it' : 'them'}. Nothing was deleted: everything saved in ${one ? 'it is' : 'them is'} still there.
    </p>
    <ul style="margin:18px 0 0;padding-left:18px;color:#cbd5e1;font-size:15px;line-height:1.6;">${items}</ul>
    ${more > 0 ? `<p style="margin:0;color:#9aa4b2;font-size:14px;">and ${more} more.</p>` : ''}
    ${restoreParagraph}
    <p style="margin:28px 0 0;color:#6b7280;font-size:12px;line-height:1.6;">
      This is a service notice about ${one ? 'a project' : 'projects'} you can read in DeerDawn, so it is sent even if you have unsubscribed from the weekly digest and reminder emails.
    </p>
  </div></body></html>`;
}

/**
 * Tell people what this sweep archived. `rows` are the candidates that WERE
 * archived (project_id, owner_key, owner_user_id, project_name, visibility).
 * `archivedAt` is the sweep's own timestamp: the identity of "this archive".
 */
async function sendAutoArchiveNotices(rows, { archivedAt, days } = {}) {
    if (!process.env.RESEND_API_KEY) return { sent: 0, skipped: true };
    if (!Array.isArray(rows) || !rows.length) return { sent: 0, people: 0 };
    await ensureNoticeLog();
    const people = await resolveRecipients(rows);
    let sent = 0;
    for (const [userId, person] of people) {
        const claimed = [];
        try {
            for (const entry of person.entries) {
                const res = await db.query(
                    `INSERT INTO project_archive_notices (user_id, project_id, archived_at)
                     VALUES ($1, $2, $3)
                     ON CONFLICT DO NOTHING
                     RETURNING project_id`,
                    [userId, entry.row.project_id, archivedAt],
                    'org-system',
                );
                if (res.rows.length) claimed.push(entry);
            }
            if (!claimed.length) continue;
            const result = await resendClient.sendEmail({
                to: person.email,
                subject: !claimed.some((e) => e.canRestore)
                    ? (claimed.length === 1 ? 'A DeerDawn project was archived' : `${claimed.length} DeerDawn projects were archived`)
                    : (claimed.length === 1
                        ? 'A DeerDawn project was archived — how to restore it'
                        : `${claimed.length} DeerDawn projects were archived — how to restore them`),
                html: renderNoticeHtml(claimed, { days }),
                emailType: 'auto_archive_notice',
            });
            if (result && result.ok) {
                sent += 1;
                await db.query(
                    'UPDATE project_archive_notices SET sent_at = NOW() WHERE user_id = $1 AND project_id = ANY($2::text[]) AND archived_at = $3',
                    [userId, claimed.map((e) => e.row.project_id), archivedAt],
                    'org-system',
                );
            } else {
                await releaseClaims(userId, claimed, archivedAt);
            }
        } catch (err) {
            console.warn(`[EMAIL] auto-archive notice failed for ${userId}: ${err.message}`);
            await releaseClaims(userId, claimed, archivedAt).catch(() => {});
        }
    }
    console.log(`[EMAIL] Auto-archive notices sent ${sent}/${people.size}`);
    return { sent, people: people.size };
}

/** The send did not happen: give the claim back so a re-run of the same sweep can retry. */
async function releaseClaims(userId, claimed, archivedAt) {
    if (!claimed.length) return;
    await db.query(
        'DELETE FROM project_archive_notices WHERE user_id = $1 AND project_id = ANY($2::text[]) AND archived_at = $3 AND sent_at IS NULL',
        [userId, claimed.map((e) => e.row.project_id), archivedAt],
        'org-system',
    );
}

module.exports = { sendAutoArchiveNotices, resolveRecipients, renderNoticeHtml, RESTORE_ROUTE, ensureNoticeLog };
