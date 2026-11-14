const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { LeadCaptureSchema } = require('../schemas');
const { sendEmail } = require('../services/email/resendClient');
const { recordProductEvent } = require('../services/productEventsService');

const PUBLIC_SITE_URL = (process.env.MARKETING_URL || process.env.DEERDAWN_PUBLIC_URL || 'https://deerdawn.com').replace(/\/$/, '');
const PUBLIC_API_URL = (process.env.DEERDAWN_PUBLIC_API_URL || process.env.DEERDAWN_API_URL || 'https://api.deerdawn.com').replace(/\/$/, '');
const REMOTE_MCP_URL = `${PUBLIC_API_URL}/mcp`;

// Desktop-setup email for mobile visitors. A phone can't wire an MCP server into
// a desktop AI tool, so rather than bounce ~half of paid traffic we capture the
// lead and email them the 2-minute setup to finish when they're back at a computer.
function buildSetupLinkEmail(email) {
    const claudeCode = `claude mcp add -s user --transport http deerdawn ${REMOTE_MCP_URL}`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="margin:0;background:#07111d;color:#e5e7eb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:40px 24px;">
    <div style="font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:#10B981;font-weight:700;">DeerDawn</div>
    <h1 style="margin:14px 0 0;font-size:24px;color:#ffffff;line-height:1.25;">Set DeerDawn up on your computer</h1>
    <p style="margin:14px 0 0;color:#9aa4b2;font-size:15px;line-height:1.7;">You asked for the setup link from your phone &mdash; here it is. DeerDawn wires into your desktop AI tool (Claude Code, Cursor, Codex, Claude.ai, ChatGPT) in about two minutes, then every tool picks up your project context automatically.</p>
    <div style="margin:28px 0 0;padding:18px;border:1px solid rgba(255,255,255,0.08);border-radius:14px;background:rgba(255,255,255,0.03);">
      <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#8593ab;font-weight:700;">Your remote MCP URL</div>
      <div style="margin-top:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;color:#dff8ea;word-break:break-all;">${REMOTE_MCP_URL}</div>
    </div>
    <ol style="margin:24px 0 0;padding-left:20px;color:#cbd5e1;font-size:15px;line-height:1.8;">
      <li>In your AI tool, add a custom / remote MCP server (a &ldquo;connector&rdquo;) and paste the URL above. Leave any OAuth fields blank.</li>
      <li>Click Connect &mdash; a DeerDawn tab opens. Sign in and authorize.</li>
      <li>You&rsquo;re back in your tool with DeerDawn ready (start_session, get_context, update_context).</li>
    </ol>
    <p style="margin:24px 0 0;color:#9aa4b2;font-size:14px;line-height:1.7;">Using Claude Code? Run this instead:</p>
    <div style="margin:8px 0 0;padding:14px;border:1px solid rgba(255,255,255,0.08);border-radius:12px;background:#0b1622;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#dff8ea;word-break:break-all;">${claudeCode}</div>
    <a href="${PUBLIC_SITE_URL}/connect" style="display:inline-block;margin:28px 0 0;background:#10B981;color:#03120b;font-weight:700;font-size:15px;text-decoration:none;padding:13px 22px;border-radius:10px;">Open the full setup guide &rarr;</a>
    <p style="margin:28px 0 0;color:#64748b;font-size:13px;line-height:1.7;">Built on the open MCP standard. No raw transcripts stored &mdash; DeerDawn syncs structured project context, not your chat logs. If you didn&rsquo;t request this, you can ignore it.</p>
  </div></body></html>`;
    return { to: email, subject: 'Your DeerDawn setup link', html };
}

// A LEAD NOBODY IS TOLD ABOUT IS A LEAD THAT DID NOT HAPPEN.
//
// Capture wrote a row and returned success, and that was the whole flow: the
// only way to learn someone had raised their hand was to go and query the
// table. For a funnel whose entire premise is that John gets on a call with
// them, a row nobody reads is indistinguishable from no lead at all.
//
// Sent for every source rather than only the founding-slot form, deliberately.
// Volume is a handful a week, a missed one costs a customer, and a notification
// wired to one route is a hole the next route falls through.
function buildLeadAlert(lead) {
    const rows = Object.entries({
        Email: lead.email,
        Company: lead.company_name,
        'Use case': lead.use_case,
        Page: lead.source_route,
        Source: lead.source_type,
        Campaign: lead.campaign,
        Tool: lead.tool_type,
    }).filter(([, v]) => v);

    const meta = lead.metadata && Object.keys(lead.metadata).length
        ? Object.entries(lead.metadata).map(([k, v]) => `<li>${escapeHtml(k)}: ${escapeHtml(String(v))}</li>`).join('')
        : '';

    return {
        to: process.env.LEAD_ALERT_TO || process.env.RESEND_REPLY_TO || 'john@deerdawn.com',
        replyTo: lead.email,
        subject: `New lead: ${lead.email}${lead.source_type ? ` (${lead.source_type})` : ''}`,
        html: `<p>Someone raised their hand.</p><ul>${
            rows.map(([k, v]) => `<li><strong>${escapeHtml(k)}:</strong> ${escapeHtml(String(v))}</li>`).join('')
        }</ul>${meta ? `<p>Details:</p><ul>${meta}</ul>` : ''}<p>Reply to this email to reach them directly.</p>`,
    };
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

router.post('/', async (req, res) => {
    const parseResult = LeadCaptureSchema.safeParse(req.body);

    if (!parseResult.success) {
        const ip = req.ip || req.connection?.remoteAddress || 'unknown';
        const requestId = req._req_id || 'unknown';
        console.warn('[LEAD] Rejected invalid payload', {
            ip,
            request_id: requestId,
            issues: parseResult.error.issues
        });
        return res.status(400).json({ error: 'invalid_payload' });
    }

    const {
        email,
        company_name,
        use_case,
        source_route,
        source_type,
        campaign,
        resource_type,
        tool_type,
        metadata = {}
    } = parseResult.data;

    try {
        const leadId = crypto.randomUUID();
        await db.query(
            `INSERT INTO leads (
                lead_id, email, company_name, use_case, source_route, source_type,
                campaign, resource_type, tool_type, metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [leadId, email, company_name, use_case, source_route, source_type, campaign, resource_type, tool_type, metadata]
        );

        await db.query(
            `INSERT INTO lead_events (
                event_id, lead_id, email, event_type, source_route, source_type,
                campaign, resource_type, tool_type, metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [crypto.randomUUID(), leadId, email, 'lead_capture', source_route, source_type, campaign, resource_type, tool_type, metadata]
        );
        
        console.log(`[LEAD] New lead captured: ${email}`);

        // Mobile visitors can't install a desktop MCP server from a phone — if they
        // asked us to email the setup link, send it now (best-effort; dormant until
        // RESEND_API_KEY is set, and never throws into the capture response).
        if (resource_type === 'setup_link') {
            try {
                // emailType tags this send so Resend's open/click webhooks can be
                // attributed to the mobile setup link specifically. 4 of 16 mobile
                // signups requested this and none activated; without the tag there
                // is no way to tell whether it went unopened or unclicked.
                const result = await sendEmail({ ...buildSetupLinkEmail(email), emailType: 'setup_link' });
                if (result && result.skipped) {
                    console.warn(`[LEAD] setup-link email skipped: ${result.reason}`);
                }
            } catch (mailErr) {
                console.warn('[LEAD] setup-link email error:', mailErr?.message);
            }
        }

        // Both best-effort and after the row is committed: a lead is captured
        // whether or not the alert or the analytics call succeeds, and neither
        // may turn a saved lead into a 500 for the person who submitted it.
        try {
            const alert = await sendEmail({ ...buildLeadAlert({
                email, company_name, use_case, source_route, source_type, campaign, tool_type, metadata,
            }), emailType: 'lead_alert' });
            if (alert && alert.skipped) console.warn(`[LEAD] alert skipped: ${alert.reason}`);
        } catch (alertErr) {
            console.warn('[LEAD] alert error:', alertErr?.message);
        }

        try {
            await recordProductEvent(
                { type: 'system', id: 'lead-capture', org_id: 'org-system' },
                {
                    event_name: 'lead_submitted',
                    source: 'api',
                    surface: source_route || 'unknown',
                    metadata: {
                        source_type: source_type || null,
                        campaign: campaign || null,
                        tool_type: tool_type || null,
                        // The count, never the address: this lands in PostHog.
                        has_company: Boolean(company_name),
                        ...(metadata && metadata.team_size ? { team_size: String(metadata.team_size) } : {}),
                    },
                },
            );
        } catch (evErr) {
            console.warn('[LEAD] product event error:', evErr?.message);
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Lead capture error:', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

module.exports = router;
