'use strict';

const { PLANS } = require('../../config/plans');

// Derived from plans.js, never typed out. An outbound email is the worst place
// for stale plan copy: it cannot be corrected after it is sent, and this exact
// line spent a day telling dormant users they were capped at 3 projects on a
// tier that had just become unlimited.
function planFooterLine() {
  const free = PLANS.free.limits;
  const pro = PLANS.developer_basic;
  const projects = Number.isFinite(free.included_projects)
    ? `${free.included_projects} projects`
    : 'unlimited projects';
  const history = Number.isFinite(free.history_days)
    ? `${free.history_days} days of history`
    : 'full history';
  return `DeerDawn is free for ${projects} with ${history}. ${pro.publicName} is $${pro.price}/month or $${pro.annual_price}/year and adds everything across your projects — cross-project search, shared entities, and history that never ages out:`;
}

// Dormant reactivation email (task A-4) — a ONE-SHOT campaign, not a lifecycle job.
//
// Audience: accounts that signed up and never got as far as ATTEMPTING a
// connection — no config copied, no tool picked, no consent screen reached.
// They looked at onboarding and left. Anyone whose attempt broke belongs to A-3
// (conciergeRecovery.js) instead, and the shared ladder in lifecycleSegments.js
// is what keeps the two audiences from ever containing the same person. The
// reason to write to this one now is that the thing they bounced off has
// actually changed: the hosted connector needs no local file and no API key, so
// the setup they skipped is genuinely shorter than it was.
//
// WHY THIS IS NOT IN THE SCHEDULER, deliberately: every other sender here is a
// lifecycle email tied to an event (signed up 20-44h ago, context touched this
// week). This one targets a FIXED, historical list. On a 6-hour timer it would
// re-evaluate the same 28 people forever, and the only thing standing between
// that and a repeat nag would be the sent-marker — one bug away from mailing
// dormant users on a loop. A campaign with a fixed audience should be fired
// deliberately, once, by a human who has read it. See scripts/send-dormant-
// reactivation.js; the default there is a dry run.
//
// CAN-SPAM: this is the first send in the sprint that is bulk commercial email
// to people who never used the product, so it is the first that strictly needs
// both a working unsubscribe and a physical postal address IN the message. Both
// ride on the existing transport rather than this template — resendClient
// injects the postal footer for every outbound email, and unsubscribeUrl mints
// the per-user HMAC-signed link. That is exactly why this goes through the app's
// Resend pipeline instead of being pasted into a mail client, where it would
// carry neither.

const db = require('../../config/db');
const resendClient = require('./resendClient');
const { unsubscribeUrl } = require('./weeklyDigest');
// Module object (not destructured) so tests can stub recordProductEvent.
const productEvents = require('../productEventsService');
const segments = require('./lifecycleSegments');

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://app.deerdawn.com';
const SITE_URL = process.env.SITE_URL || 'https://deerdawn.com';
// Mirrors REMOTE_MCP_URL in the dashboard's canonical connectCopy.ts and in
// activationFollowUp.js — keep the three in sync.
const REMOTE_MCP_URL = 'https://api.deerdawn.com/mcp';

const SENT_EVENT = 'dormant_reactivation_email_sent';
const EMAIL_TYPE = 'dormant_reactivation';
// Reaching ANY of these means the account is not dormant: they got past the
// looking-at-onboarding stage. Defined in lifecycleSegments.js as the union of
// every rung above "looked at onboarding", so that this audience and A-3's
// stuck audience are complements by construction and nobody can receive both
// campaigns. Previously this list was maintained here by hand and omitted the
// failed-OAuth rungs, which put a hosted user whose consent hand-off BROKE into
// the "never tried" bucket — the one group this email's premise is false for.
const ENGAGED_EVENTS = segments.ENGAGED_EVENTS;
// Same +clerk_test convention the activation follow-up filters on: those are
// journey-test signups, not real mailboxes, and their bounces are charged
// against the sending domain's reputation.
const TEST_EMAIL_MARKER = segments.TEST_EMAIL_MARKER;
// An account has to be old enough that the activation follow-up (20-44h) has
// already had its turn, or the two would land on the same person in the same
// week saying different things.
const MIN_AGE_DAYS = Number(process.env.DORMANT_REACTIVATION_MIN_AGE_DAYS) || 7;
const MAX_PER_RUN = Number(process.env.DORMANT_REACTIVATION_MAX_PER_RUN) || 200;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]
  ));
}

const SUBJECT = 'No install needed anymore';

function checkoutUrl() {
  return `${DASHBOARD_URL}/checkout?plan=developer_basic&billing=annual&campaign=a4_dormant`;
}

// Copy is A-4 from docs/growth/outreach/a4-dormant-reactivation.md, John-approved.
// It leads with the no-install path because that is the thing that changed since
// these people left; the founding offer is a footer, not the point.
function renderDormantHtml(unsubUrl) {
  return `<!doctype html><html><body style="margin:0;background:#07111d;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px;color:#e5e7eb;">
    <div style="font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:#10B981;font-weight:700;">DeerDawn</div>
    <h1 style="margin:10px 0 0;font-size:23px;line-height:1.25;color:#ffffff;">The setup you skipped got a lot shorter</h1>
    <p style="margin:16px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">
      You signed up for DeerDawn and never got through setup. Fair &mdash; it used to mean editing a config file. It doesn&rsquo;t any more: if you use claude.ai or ChatGPT in the browser, you paste one URL into their connector settings and sign in. Nothing is installed, and there&rsquo;s no API key.
    </p>
    <p style="margin:14px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">
      <strong style="color:#ffffff;">Claude.ai</strong> &mdash; Settings &rarr; Connectors &rarr; Add custom connector<br />
      <strong style="color:#ffffff;">ChatGPT.com</strong> &mdash; Settings &rarr; Connectors &rarr; Add MCP server, choose OAuth
    </p>
    <p style="margin:14px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">The URL, either way:</p>
    <p style="margin:12px 0 0;padding:12px 14px;background:#0d1b2a;border-radius:10px;color:#e5e7eb;font-size:14px;line-height:1.6;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">
      ${esc(REMOTE_MCP_URL)}
    </p>
    <p style="margin:14px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">
      Click Connect, a DeerDawn tab opens, sign in, and your tools are live. After that, every new chat can start with your project&rsquo;s current state instead of you re-explaining it. Full instructions, including Cursor, Claude Code and Codex: <a href="${esc(SITE_URL)}/connect" style="color:#10B981;">${esc(SITE_URL)}/connect</a>
    </p>
    <p style="margin:14px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">
      If it doesn&rsquo;t work, reply and tell me where it stopped &mdash; I&rsquo;d rather fix it than have you skip it twice.
    </p>
    <p style="margin:18px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">John</p>
    <hr style="margin:24px 0 0;border:none;border-top:1px solid #1e2b3d;" />
    <p style="margin:16px 0 0;color:#9aa4b2;font-size:13px;line-height:1.7;">
      ${esc(planFooterLine())} <a href="${esc(checkoutUrl())}" style="color:#10B981;">start here</a>.
    </p>
    <p style="margin:14px 0 0;color:#6b7280;font-size:12px;line-height:1.6;">
      You&rsquo;re receiving this because you created a DeerDawn account at deerdawn.com.<br />
      <a href="${esc(unsubUrl)}" style="color:#6b7280;">Unsubscribe</a>
    </p>
  </div>
</body></html>`;
}

// Dormant = has an account, is old enough that the activation follow-up already
// ran, has never reached any engagement event, has not already had this email,
// and has not opted out. The unsubscribe flag is the same one the weekly digest
// and the activation follow-up honour — one opt-out stops all marketing mail.
async function findRecipients({ limit = MAX_PER_RUN, minAgeDays = MIN_AGE_DAYS } = {}) {
  const res = await db.query(
    `SELECT u.user_id, u.org_id, u.email, u.created_at
       FROM users u
      WHERE u.email IS NOT NULL
        AND POSITION($4 IN lower(u.email)) = 0
        AND COALESCE(u.weekly_digest_unsubscribed, false) = false
        AND u.created_at <= NOW() - ($5 || ' days')::interval
        AND NOT EXISTS (
            SELECT 1 FROM product_events e
             WHERE e.event_name = ANY($1)
               AND (e.user_id = u.user_id OR e.org_id = u.org_id)
        )
        AND NOT EXISTS (
            SELECT 1 FROM product_events s
             WHERE s.event_name = $2 AND s.user_id = u.user_id
        )
      ORDER BY u.created_at ASC
      LIMIT $3`,
    [ENGAGED_EVENTS, SENT_EVENT, limit, TEST_EMAIL_MARKER, String(minAgeDays)],
    'org-system',
  ).catch((err) => {
    console.warn(`[EMAIL] dormant reactivation recipient query failed: ${err.message}`);
    return { rows: [] };
  });
  return res.rows || [];
}

/**
 * Send the dormant reactivation campaign.
 *
 * `apply` defaults to FALSE. Nothing leaves the building unless the caller opts
 * in explicitly — a campaign to a fixed historical list is the wrong thing to
 * fire by accident, and the dry run is what makes the audience reviewable
 * before it is mailed.
 */
async function sendDormantReactivationEmails({ apply = false, limit, minAgeDays } = {}) {
  const recipients = await findRecipients({ limit, minAgeDays });

  if (!apply) {
    return { dryRun: true, sent: 0, total: recipients.length, recipients };
  }
  if (!process.env.RESEND_API_KEY) {
    console.log('[EMAIL] Dormant reactivation skipped — RESEND_API_KEY not set');
    return { sent: 0, total: recipients.length, skipped: true };
  }

  let sent = 0;
  for (const r of recipients) {
    try {
      const result = await resendClient.sendEmail({
        to: r.email,
        subject: SUBJECT,
        html: renderDormantHtml(unsubscribeUrl(r.user_id)),
        replyTo: 'john@deerdawn.com',
        emailType: EMAIL_TYPE,
      });
      if (result.ok) {
        sent += 1;
        // The sent-marker is what makes this campaign once-per-person for good,
        // even if it is re-run. Recorded per user so a second run sees it.
        await productEvents.recordProductEvent(
          { type: 'user', id: r.user_id, org_id: r.org_id },
          {
            event_name: SENT_EVENT,
            source: 'api',
            surface: 'dormant_reactivation',
            metadata: { channel: 'email', campaign: 'a4_dormant' },
          },
        ).catch((err) => console.warn(`[EMAIL] dormant sent-marker failed for ${r.user_id}: ${err.message}`));
      }
    } catch (err) {
      console.warn(`[EMAIL] dormant reactivation failed for ${r.user_id}: ${err.message}`);
    }
  }
  console.log(`[EMAIL] Dormant reactivation sent ${sent}/${recipients.length}`);
  return { sent, total: recipients.length };
}

module.exports = {
  sendDormantReactivationEmails,
  findRecipients,
  renderDormantHtml,
  checkoutUrl,
  SUBJECT,
  SENT_EVENT,
  EMAIL_TYPE,
  ENGAGED_EVENTS,
};
