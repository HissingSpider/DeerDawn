'use strict';

// Activation follow-up email — the recovery mechanism for the decoupled-setup
// problem. Signup takes 10 seconds; the aha (connecting an AI tool) is a detour
// into another app that many users defer and never return to. A single, human
// nudge ~a day after signup pulls a real fraction of them back.
//
// Best-effort throughout and no-ops until RESEND_API_KEY is set (like the weekly
// digest). Idempotency + the "not yet activated" check both ride on product_events
// so there is NO new column / migration:
//   - activated  = the user (or their org) received real VALUE: first_sync_completed
//                  or context_delivered
//   - already-sent = an activation_followup_email_sent event exists for the user
//
// mcp_start_session_succeeded deliberately does NOT count as activated. A brand-new
// account has nothing saved, so start_session returns an empty (suppressed) injection
// and emits no context_delivered — the user connected and got nothing. Treating a
// tool call as activation suppressed this nudge for exactly the users closest to
// converting: in production one user completed 5 MCP handshakes and 2 start_session
// calls, received 0 briefs, and was silently excluded from the follow-up while four
// less-engaged users received it.
//
// Because connecting and receiving value are now separate, the email adapts: users
// who never connected get "connect a tool", users who connected but have no brief
// yet get "save your first brief" — telling the latter to connect would be wrong.
//
// A THIRD state, added 2026-09-28 (E-033): authorized but never used. A hosted
// connector (ChatGPT, Claude.ai) is connected the moment the person approves the
// consent screen — the token is minted then — but the client does not handshake
// until the person next uses it in a chat. ChatGPT is now where nearly every new
// account comes from, and on 09-27 three of four ChatGPT approvers had no
// handshake a day later; the fourth handshook 16.7 hours after approving. All
// three were sent the never-connected copy, which tells someone who has just
// approved DeerDawn inside ChatGPT to go and paste a URL into ChatGPT. The grant
// is read from api_keys (the row the token endpoint mints), not from the
// browser-relayed oauth_consent_approved: it is the server's own record, and it
// only exists if the code exchange actually succeeded.

const db = require('../../config/db');
const resendClient = require('./resendClient');
const { unsubscribeUrl } = require('./weeklyDigest');
// Required as a module object (not destructured) so tests can stub recordProductEvent.
const productEvents = require('../productEventsService');

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://app.deerdawn.com';
// The day-two return prompt, verbatim — START_SESSION_PROMPT in the activation
// plan (docs/ACTIVATION-MOMENTS-PLAN-2026-07.md §Moment 1, "Magic prompt"). It
// is deliberately the CLOSING ask and never the first move: a brand-new account
// has nothing saved, so start_session comes back empty. Seeding comes first —
// that is the connected variant's opening prompt, mirroring onboarding.tsx's
// FIRST_BRIEF_PROMPT.
const START_SESSION_PROMPT = 'Run start_session from DeerDawn and tell me what I was working on.';
// The seeding prompt, verbatim from the dashboard's FIRST_BRIEF_PROMPT. Both
// variants need it: start_session on an account that never saved anything
// returns an empty brief, so prescribing the day-two prompt alone would send a
// never-connected reader to a guaranteed dead end.
const FIRST_BRIEF_PROMPT = 'I just connected DeerDawn. Ask me what I\u2019m working on and the key decisions so far, then save it with manage_memory (action \u2018update\u2019) as my project brief.';
// No-install fallback for anyone whose local MCP config never worked: the hosted
// OAuth connector needs no file on disk and works from a phone. Mirrors
// REMOTE_MCP_URL / REMOTE_SETUP_LOCATIONS in the dashboard's canonical
// connectCopy.ts — keep them in sync.
const REMOTE_MCP_URL = 'https://api.deerdawn.com/mcp';
const MAX_PER_RUN = Number(process.env.ACTIVATION_FOLLOWUP_MAX_PER_RUN) || 500;
const SENT_EVENT = 'activation_followup_email_sent';
// The dashboard route this email may point at. A named constant so the
// contract test can assert it is a live route rather than a legacy URL kept
// alive by a redirect — see followUpCtaUrl below for what that cost us.
const LIFECYCLE_CTA_PATH_UNCONNECTED = '/setup';
// Which dashboard path each stage's button opens, or null for no button.
//
// Only the never-connected stage gets one. The authorized and connected stages
// used to link /onboarding, and every dashboard page a connected account can
// land on asks it to connect: /onboarding opens on "Step 1 · Connect a tool"
// on desktop whatever the account's state, the home page's empty state for an
// account with nothing saved is a Connect button, and /setup counts a grant
// with no calls yet as "0 of N tools connected". So the email said "nothing
// else to install or paste" and its button sent the reader to paste a URL.
// Nearly every signup now arrives through ChatGPT's consent screen and is in
// exactly that state. What is left for them happens in their AI tool, and the
// email already spells it out (the prompt to paste), so it carries no link at
// all rather than one that contradicts it. The Resend tag (emailType) still
// measures each variant's sends and deliveries.
const LIFECYCLE_CTA_PATHS = Object.freeze({
    unconnected: LIFECYCLE_CTA_PATH_UNCONNECTED,
    authorized: null,
    connected: null,
});
// Real value reached a live AI session. This is activation.
const ACTIVATION_EVENTS = ['first_sync_completed', 'context_delivered'];
// WHAT "SAVED" MEANS FOR THIS EMAIL (journey r6, owner decision: the follow-up
// says "nothing saved yet" only to people who have saved nothing). The variant
// copy tells the reader their AI "has nothing to tell you" until they save a
// first brief, which is a claim about the person's saved content, so that is what
// is checked, for the PERSON and across every workspace:
//   - a project they authored (context_projects.owner_user_id), in any workspace,
//     archived included; or
//   - an event they contributed to any project (context_events
//     .contributing_user_id): a save through the hosted connector, or a write
//     into a colleague's team project, which leaves their own workspace empty.
// It used to ask whether a brief had been DELIVERED to them, or to their own org.
// That is a proxy: it says nothing about somebody who saved and simply had not
// had it read back yet, and it can never see a team save, which is filed under
// the team's key and not theirs. Work stamped before the identity fix carries
// the author's KEY id, not their user id; a key belongs to its owner, so those
// count as the person's too (the same reading workspace.resolveAuthors gives
// the API, run in the direction this query needs: person to keys).
//
// Only the CONNECTED variant, the one that says "there's nothing saved yet", is
// gated on it (owner decision, journey r6). Somebody who saved (say, from the
// dashboard) but never connected a tool still needs the "connect a tool" nudge,
// so they get it, with copy that does not claim nothing is saved.
// (Enforced in findRecipients' query below.)
//
// Their tool handshook. Necessary for activation but NOT sufficient — it only tells
// us which of the two emails to send.
const CONNECTED_EVENTS = ['mcp_runtime_started', 'mcp_start_session_succeeded', 'mcp_tool_call_succeeded'];
// The three variants, lowest rung first. Callers written before `authorized`
// existed pass a boolean; stageOf maps it onto the two stages they knew.
const STAGE_UNCONNECTED = 'unconnected';
const STAGE_AUTHORIZED = 'authorized';
const STAGE_CONNECTED = 'connected';
// Clerk's E2E/journey signups use the +clerk_test convention (same marker the
// account_created webhook tags is_test with) and those addresses are NOT real
// mailboxes. The nightly journey run creates exactly one per day, so they were
// half of everything this job sent: 13 email_bounced against 13 email_delivered
// in the 14d to 2026-08-13, every bounce Transient. That bounce rate is charged
// against the sending domain's reputation, which puts the real activation nudge
// — the only one we send — at risk of being filtered before it is read.
const TEST_EMAIL_MARKER = '+clerk_test';

// Query params appended to the CTA link so the click is attributable when the
// user lands (dashboard/_app reads dd_email and emits lifecycle_email_clicked).
//
// Why we self-host this instead of using the ESP's own click tracking: Resend
// reports opens/clicks only when open/click tracking is enabled per SENDING
// DOMAIN in its dashboard — there is no per-send API field, so apps/api cannot
// turn it on. The result is that this job is unjudgeable: 52 follow-ups sent in
// the 30d to 2026-08-15, 14 confirmed delivered, and zero of the resulting
// accounts activated, with no way to tell an unopened email from an opened one
// whose landing page failed. One query param closes that gap without depending
// on the ESP, on a tracking pixel, or on rewriting the link through a redirector.
//
// utm_* ride along too because captureAttribution() already stores those
// first-touch, so the email shows up in the existing source breakdowns for free.
//
// The paths MUST be live dashboard routes, never ones that only survive through
// a next.config redirect. This link pointed at /settings/tools, which the
// redesign renamed to /setup and kept alive with a redirect — and measured on
// production 2026-08-27, that redirect drops the whole query string:
//
//   /settings/tools?dd_email=x&utm_source=y  ->  /login?redirect_url=%2Fsetup
//   /setup?dd_email=x&utm_source=y           ->  /login?redirect_url=%2Fsetup%3Fdd_email%3Dx%26utm_source%3Dy
//
// So every click on the un-connected variant arrived stripped of dd_email and
// all four utm_*, and lifecycle_email_clicked could not fire. It never has: 44
// follow-ups sent and 31 confirmed delivered in the 30d to 2026-08-27, against
// zero recorded clicks. That zero was the redirect, not the readers.
// tests/unit/lifecycle-email-cta-routes.test.js keeps these paths off the
// dashboard's redirect table.
function followUpCtaUrl(dashboardUrl, connected, saved = false) {
    const stage = stageOf(connected);
    const emailType = emailTypeFor(stage, saved);
    // /setup, NOT /settings/tools. The latter is a redirect (see the dashboard's
    // next.config.ts) and the query string did not survive it in production —
    // which is why 31 delivered lifecycle emails produced zero recorded clicks:
    // dd_email never arrived, so _app.tsx had nothing to capture. Linking the
    // canonical route directly removes the hop rather than trusting it. The
    // constant is exported and pinned by lifecycle-email-cta-routes.test.js so
    // both senders cannot drift apart on it again.
    // An authorized or connected account gets no link: see LIFECYCLE_CTA_PATHS.
    const path = ctaPathFor(stage);
    if (!path) return null;
    const params = new URLSearchParams({
        dd_email: emailType,
        utm_source: 'lifecycle_email',
        utm_medium: 'email',
        utm_campaign: emailType,
    });
    return `${dashboardUrl}${path}?${params.toString()}`;
}

function ctaPathFor(stageOrConnected) {
    return LIFECYCLE_CTA_PATHS[stageOf(stageOrConnected)] || null;
}

function stageOf(stageOrConnected) {
    if (stageOrConnected === STAGE_AUTHORIZED || stageOrConnected === STAGE_CONNECTED
        || stageOrConnected === STAGE_UNCONNECTED) return stageOrConnected;
    return stageOrConnected ? STAGE_CONNECTED : STAGE_UNCONNECTED;
}

function stageForRecipient(r) {
    if (r.connected) return STAGE_CONNECTED;
    if (r.authorized) return STAGE_AUTHORIZED;
    return STAGE_UNCONNECTED;
}

// `saved` splits the two variants that do not assume an empty account, so the
// copy that never says "nothing saved" is measured on its own. The connected
// variant has no saved form: the query never sends it to a saver.
function emailTypeFor(connected, saved = false) {
    const stage = stageOf(connected);
    if (stage === STAGE_CONNECTED) return 'activation_followup_connected';
    if (stage === STAGE_AUTHORIZED) return saved ? 'activation_followup_authorized_saved' : 'activation_followup_authorized';
    return saved ? 'activation_followup_unconnected_saved' : 'activation_followup_unconnected';
}

// oauth_client_name is whatever the client registered, and Dynamic Client
// Registration lets anyone register anything, so it never reaches an email
// verbatim. Only the two hosted tools we name everywhere else get their name.
function clientLabel(clientName) {
    const name = String(clientName || '');
    if (/chatgpt|openai/i.test(name)) return 'ChatGPT';
    if (/claude/i.test(name)) return 'Claude';
    return null;
}

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]
    ));
}

// `connected` picks the variant. Defaults to false (the never-connected copy), which
// is the safe fallback if a caller can't determine connection state.
// `saved` is meaningful only when not connected: this person has saved work (from
// the dashboard, say) but has not used a tool yet, so the copy never says or
// implies that nothing is saved. `clientName` is used only by the authorized copy.
function renderFollowUpHtml(connectUrl, unsubUrl, connected = false, saved = false, clientName = null) {
    const stage = stageOf(connected);
    if (stage === STAGE_AUTHORIZED) return renderAuthorizedHtml(connectUrl, unsubUrl, clientName, saved);
    connected = stage === STAGE_CONNECTED;
    const headline = connected
        ? 'You&rsquo;re connected — one last step to make it useful'
        : 'You&rsquo;re set up — one 2-minute step left';

    const body = connected
        ? `<p style="margin:16px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">
      Your AI tool is talking to DeerDawn — nice. But there&rsquo;s nothing saved yet, so it has nothing to tell you. Your <strong style="color:#ffffff;">first</strong> session is the one that writes the brief.
    </p>
    <p style="margin:14px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">
      Open your AI tool and paste this:
    </p>
    <p style="margin:12px 0 0;padding:12px 14px;background:#0d1b2a;border-radius:10px;color:#e5e7eb;font-size:14px;line-height:1.6;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">
      I just connected DeerDawn. Ask me what I&rsquo;m working on and the key decisions so far, then save it with manage_memory (action &lsquo;update&rsquo;) as my project brief.
    </p>`
        : saved
        ? `<p style="margin:16px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">
      Your DeerDawn account is ready, and the work you saved is in it. The last step is connecting an AI tool so that work loads automatically at the start of every session — no more re-explaining your project.
    </p>
    <p style="margin:14px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">
      It takes about two minutes: paste one URL into <strong>Claude, ChatGPT, Cursor, or Codex</strong>, authorize, and you&rsquo;re done. We&rsquo;ll walk you through it.
    </p>`
        : `<p style="margin:16px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">
      Your DeerDawn account is ready. The last step is connecting an AI tool so your brief loads automatically at the start of every session — no more re-explaining your project.
    </p>
    <p style="margin:14px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">
      It takes about two minutes: paste one URL into <strong>Claude, ChatGPT, Cursor, or Codex</strong>, authorize, and you&rsquo;re done. We&rsquo;ll walk you through it.
    </p>
    <p style="margin:14px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">
      Once you&rsquo;re connected, paste this first so there is something to remember:
    </p>
    <p style="margin:12px 0 0;padding:12px 14px;background:#0d1b2a;border-radius:10px;color:#e5e7eb;font-size:14px;line-height:1.6;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">
      ${esc(FIRST_BRIEF_PROMPT)}
    </p>`;

    // The connected variant has no button (see LIFECYCLE_CTA_PATHS): the step
    // left is the prompt above, pasted into the tool that is already connected.
    const cta = connected ? null : 'Connect your first tool &rarr;';

    const payoff = connected
        ? 'It answers with what you actually saved.'
        : saved
        ? 'It answers with what you saved — what you shipped, what you decided, what&rsquo;s still open.'
        : 'It answers with your actual project state — what you shipped, what you decided, what&rsquo;s still open.';

    // Only the never-connected variant gets this: the connected user's local
    // setup already worked, so offering them a way around it would be noise.
    const noInstallPath = connected
        ? ''
        : `
    <p style="margin:20px 0 0;color:#9aa4b2;font-size:13px;line-height:1.7;">
      Local config not working? You don&rsquo;t need it. Claude.ai and ChatGPT connect over the web instead: Settings &rarr; Connectors, add a custom connector (ChatGPT calls it &ldquo;Add MCP server&rdquo; — choose OAuth), paste <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#e5e7eb;">${esc(REMOTE_MCP_URL)}</span>, and sign in. Nothing to install &mdash; and on Claude it works straight from your phone. Or open this link later from a desktop.
    </p>`;

    const closing = `<p style="margin:20px 0 0;color:#cbd5e1;font-size:14px;line-height:1.7;">
      Then, tomorrow, open your AI tool and paste this:
    </p>
    <p style="margin:12px 0 0;padding:12px 14px;background:#0d1b2a;border-radius:10px;color:#e5e7eb;font-size:14px;line-height:1.6;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">
      ${esc(START_SESSION_PROMPT)}
    </p>
    <p style="margin:12px 0 0;color:#cbd5e1;font-size:14px;line-height:1.7;">
      ${payoff} That&rsquo;s the product.
    </p>${noInstallPath}`;

    return renderShell({ connectUrl, unsubUrl, headline, body, cta, closing });
}

function renderShell({ connectUrl, unsubUrl, headline, body, cta, closing }) {
    return `<!doctype html><html><body style="margin:0;background:#07111d;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px;color:#e5e7eb;">
    <div style="font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:#10B981;font-weight:700;">DeerDawn</div>
    <h1 style="margin:10px 0 0;font-size:23px;line-height:1.25;color:#ffffff;">${headline}</h1>
    ${body}
    ${connectUrl && cta ? `<a href="${esc(connectUrl)}" style="display:inline-block;margin-top:24px;background:#10B981;color:#03120b;text-decoration:none;font-weight:600;font-size:14px;padding:12px 20px;border-radius:12px;">${cta}</a>` : ''}
    ${closing}
    <p style="margin:28px 0 0;color:#6b7280;font-size:12px;line-height:1.6;">
      You&rsquo;re getting this because you created a DeerDawn account. <a href="${esc(unsubUrl)}" style="color:#6b7280;">Unsubscribe from weekly and reminder emails</a>.
    </p>
  </div></body></html>`;
}

// Approved on a consent screen, token minted, never used in a chat. The only
// thing left is one message in the tool they already connected — so the email
// says exactly that, names the tool when it safely can, and does not offer a
// URL or a config to someone whose connection already exists.
function renderAuthorizedHtml(_connectUrl, unsubUrl, clientName, saved = false) {
    const tool = clientLabel(clientName);
    const where = tool ? esc(tool) : 'your AI tool';
    const headline = `DeerDawn is connected to ${where} &mdash; it just hasn&rsquo;t been used yet`;
    const body = `<p style="margin:16px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">
      You approved DeerDawn in ${where}, so the connection is in place. There is nothing else to install or paste. ${saved
        ? 'It hasn&rsquo;t been used in a chat yet, so the work you saved has not reached it.'
        : 'It hasn&rsquo;t been used in a chat yet, and nothing is saved, so it has nothing to brief you on.'}
    </p>
    <p style="margin:14px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">
      Start a new chat in ${where}, make sure DeerDawn is switched on for that chat, and paste this:
    </p>
    <p style="margin:12px 0 0;padding:12px 14px;background:#0d1b2a;border-radius:10px;color:#e5e7eb;font-size:14px;line-height:1.6;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">
      ${esc(saved ? START_SESSION_PROMPT : FIRST_BRIEF_PROMPT)}
    </p>`;
    const closing = `<p style="margin:20px 0 0;color:#cbd5e1;font-size:14px;line-height:1.7;">
      Then, tomorrow, start another chat and paste this:
    </p>
    <p style="margin:12px 0 0;padding:12px 14px;background:#0d1b2a;border-radius:10px;color:#e5e7eb;font-size:14px;line-height:1.6;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">
      ${esc(START_SESSION_PROMPT)}
    </p>
    <p style="margin:12px 0 0;color:#cbd5e1;font-size:14px;line-height:1.7;">
      It answers with what you actually saved. That&rsquo;s the product.
    </p>`;
    // No button: everything left happens in the tool they approved, and every
    // dashboard page would ask them to connect again (see LIFECYCLE_CTA_PATHS).
    return renderShell({ connectUrl: null, unsubUrl, headline, body, cta: null, closing });
}

function subjectFor(stage, clientName, saved = false) {
    if (stage === STAGE_CONNECTED) return 'You’re connected — save your first brief (1 minute)';
    if (stage === STAGE_AUTHORIZED) {
        const tool = clientLabel(clientName) || 'your AI tool';
        return `DeerDawn is connected to ${tool} — one message left`;
    }
    return saved
        ? 'Your work is saved — connect a tool so it loads in every session'
        : 'You’re set up — the 2-minute step to connect your first tool';
}

// Real users who signed up ~a day ago, still haven't activated, haven't
// unsubscribed, and haven't already been sent this follow-up. The 20–44h window waits about a
// day and gives a ~24h catch band so a missed run doesn't drop anyone; the
// sent-marker (not the window) is what actually prevents duplicates.
async function findRecipients() {
    const res = await db.query(
        `SELECT * FROM (
           SELECT u.user_id, u.org_id, u.email, u.created_at,
                  EXISTS (
                      SELECT 1 FROM product_events c
                       WHERE c.event_name = ANY($2)
                         AND (c.user_id = u.user_id OR c.org_id = u.org_id)
                  ) AS connected,
                  -- A hosted grant: the row /oauth/token mints when a code is
                  -- exchanged. Keyed by the PERSON (owner_id), the same way
                  -- loadHostedGrants lists a person's connections.
                  EXISTS (
                      SELECT 1 FROM api_keys k
                       WHERE k.owner_id = u.user_id AND k.oauth_resource IS NOT NULL
                  ) AS authorized,
                  (SELECT k.oauth_client_name FROM api_keys k
                    WHERE k.owner_id = u.user_id AND k.oauth_resource IS NOT NULL
                    ORDER BY k.created_at DESC LIMIT 1) AS authorized_client,
                  EXISTS (
                      SELECT 1 FROM context_projects sp
                       WHERE sp.owner_user_id = u.user_id
                          OR sp.owner_user_id IN (SELECT k.key_id FROM api_keys k WHERE k.owner_id = u.user_id)
                  ) OR EXISTS (
                      SELECT 1 FROM context_events ce
                       WHERE (ce.contributing_user_id = u.user_id
                          OR ce.contributing_user_id IN (SELECT k.key_id FROM api_keys k WHERE k.owner_id = u.user_id))
                         AND ce.event_kind NOT IN ('project_archived', 'project_merged')
                  ) AS saved
             FROM users u
            WHERE u.email IS NOT NULL
              AND POSITION($5 IN lower(u.email)) = 0
              AND COALESCE(u.weekly_digest_unsubscribed, false) = false
              AND u.created_at <= NOW() - interval '20 hours'
              AND u.created_at >  NOW() - interval '44 hours'
              AND NOT EXISTS (
                  SELECT 1 FROM product_events a
                   WHERE a.event_name = ANY($1)
                     AND (a.user_id = u.user_id OR a.org_id = u.org_id)
              )
              AND NOT EXISTS (
                  SELECT 1 FROM product_events s
                   WHERE s.event_name = $3 AND s.user_id = u.user_id
              )
         ) r
          -- The "nothing saved yet" (connected) variant goes only to people who
          -- have saved nothing. A saver who never connected still gets "connect",
          -- and an authorized saver gets the authorized copy without that claim.
          WHERE NOT (r.connected AND r.saved)
          ORDER BY r.created_at ASC
          LIMIT $4`,
        [ACTIVATION_EVENTS, CONNECTED_EVENTS, SENT_EVENT, MAX_PER_RUN, TEST_EMAIL_MARKER],
        'org-system',
    ).catch((err) => {
        console.warn(`[EMAIL] activation follow-up recipient query failed: ${err.message}`);
        return { rows: [] };
    });
    return res.rows || [];
}

async function sendActivationFollowUpEmails() {
    if (!process.env.RESEND_API_KEY) {
        console.log('[EMAIL] Activation follow-up skipped — RESEND_API_KEY not set');
        return { sent: 0, skipped: true };
    }
    const recipients = await findRecipients();
    let sent = 0;
    for (const r of recipients) {
        try {
            // Never connected → /setup, the connect step. Connected, or
            // authorized but silent → no link: the copy sends them back to the
            // tool they already connected (see LIFECYCLE_CTA_PATHS).
            const stage = stageForRecipient(r);
            // Only meaningful when not connected: a connected person who has
            // saved is filtered out by the query.
            const saved = stage !== STAGE_CONNECTED && Boolean(r.saved);
            const result = await resendClient.sendEmail({
                to: r.email,
                subject: subjectFor(stage, r.authorized_client, saved),
                html: renderFollowUpHtml(
                    followUpCtaUrl(DASHBOARD_URL, stage, saved),
                    unsubscribeUrl(r.user_id),
                    stage,
                    saved,
                    r.authorized_client,
                ),
                replyTo: 'john@deerdawn.com',
                // Split the two variants: they make different asks, so a combined
                // open/click rate would hide which one works. 23 of these have
                // been sent with zero resulting activations.
                emailType: emailTypeFor(stage, saved),
            });
            if (result.ok) {
                sent += 1;
                // Mark as sent so later runs never re-nag this user (also a funnel event).
                await productEvents.recordProductEvent(
                    { type: 'user', id: r.user_id, org_id: r.org_id },
                    // email_type makes the variant readable in PostHog without a
                    // join to the Resend webhook's delivery rows.
                    { event_name: SENT_EVENT, source: 'api', surface: 'activation_followup', metadata: { channel: 'email', email_type: emailTypeFor(stage, saved) } },
                ).catch((err) => console.warn(`[EMAIL] follow-up sent-marker failed for ${r.user_id}: ${err.message}`));
            }
        } catch (err) {
            console.warn(`[EMAIL] activation follow-up failed for ${r.user_id}: ${err.message}`);
        }
    }
    console.log(`[EMAIL] Activation follow-up sent ${sent}/${recipients.length}`);
    return { sent, total: recipients.length };
}

module.exports = {
    LIFECYCLE_CTA_PATH_UNCONNECTED,
    LIFECYCLE_CTA_PATHS,
    ctaPathFor,
    sendActivationFollowUpEmails,
    findRecipients,
    renderFollowUpHtml,
    followUpCtaUrl,
    emailTypeFor,
    stageForRecipient,
    subjectFor,
    clientLabel,
};
