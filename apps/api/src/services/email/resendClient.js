'use strict';

const { isSelfHosted } = require('../../config/selfHosted');

// Minimal Resend transport via the global fetch (Node 20+) — no new dependency.
// Ships dormant: returns { skipped: true } until RESEND_API_KEY is set, exactly
// like the server-side PostHog client. Analytics/notifications are best-effort
// and must never throw into a caller.
// attachments: optional [{ filename, content }] where content is a base64 string
// (Resend's documented attachment shape) — used to ship the .md context export.
//
// emailType: optional short identifier (e.g. 'setup_link') sent as a Resend tag.
// Resend echoes tags back on its delivery/open/click webhooks, and without one
// every webhook event is an anonymous "some email was opened" — useless for
// telling whether the mobile setup link or the activation follow-up is landing.
// Resend restricts tag names/values to ASCII letters, numbers, underscores and
// dashes, so the value is sanitized rather than trusted.
//
// text: a PLAIN-TEXT body, for mail that should read like a person wrote it (the
// morning-after brief). Sent as Resend's `text` field with no html part at all,
// and given the same postal footer as a text line. A caller may pass html, text
// or both; at least one is required.
//
// from: overrides RESEND_FROM for one send — the morning-after brief goes out
// from John's own address rather than hello@. The domain must be one Resend has
// verified, which deerdawn.com is.
async function sendEmail({ to, subject, html, text, from: fromOverride, replyTo, attachments, emailType } = {}) {
    const apiKey = process.env.RESEND_API_KEY;
    const from = fromOverride || process.env.RESEND_FROM || 'DeerDawn <hello@deerdawn.com>';
    if (!apiKey) {
        // A self-host without Resend: say what was not sent, once per email,
        // at info level, never the body, which can carry a whole context
        // export. Callers that hold an ACTION link (an invitation, a password
        // reset) log the link themselves, because only they know which link in
        // the body is the one the recipient needs.
        if (isSelfHosted() && to && subject) {
            console.info(`[EMAIL] Not sent (RESEND_API_KEY not set): "${String(subject).slice(0, 120)}" to ${Array.isArray(to) ? to.join(', ') : to}${emailType ? ` [${sanitizeTagValue(emailType)}]` : ''}`);
        }
        return { skipped: true, reason: 'no_api_key' };
    }
    if (!to || !subject || (!html && !text)) return { skipped: true, reason: 'missing_fields' };

    const htmlWithFooter = html ? withPostalFooter(html) : null;
    const textWithFooter = text ? withPostalFooterText(text) : null;

    try {
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from,
                to,
                subject,
                ...(htmlWithFooter ? { html: htmlWithFooter } : {}),
                ...(textWithFooter ? { text: textWithFooter } : {}),
                ...(replyTo ? { reply_to: replyTo } : {}),
                ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
                ...(emailType ? { tags: [{ name: 'email_type', value: sanitizeTagValue(emailType) }] } : {}),
            }),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            console.warn(`[EMAIL] Resend send failed (${res.status}): ${body.slice(0, 200)}`);
            return { ok: false, status: res.status };
        }
        return { ok: true };
    } catch (err) {
        console.warn(`[EMAIL] Resend send error: ${err.message}`);
        return { ok: false, error: err.message };
    }
}

// Resend rejects the whole send if a tag contains anything outside
// [A-Za-z0-9_-], so a bad value would silently cost us the email, not just the
// tag. Coerce instead of trusting the caller.
function sanitizeTagValue(value) {
    return String(value).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

// CAN-SPAM §7704(a)(5) requires a valid physical postal address in every
// commercial message. Enforced HERE rather than in each template because the
// transport is the only place that sees all of them: the weekly digest, both
// activation follow-up variants, the mobile setup link, and any campaign send
// that gets added next. A template that forgets the footer is a violation; a
// template that cannot forget it is not.
//
// Default is the address DeerDawn already publishes on /terms, /privacy and
// /dpa, so the emails and the site agree. DEERDAWN_POSTAL_ADDRESS overrides it
// if the address of record changes. Read per call, like RESEND_API_KEY and
// RESEND_FROM above, so a change takes effect without a process restart.
const DEFAULT_POSTAL_ADDRESS = 'DeerDawn Inc., 1209 Orange Street, Wilmington, DE 19801, USA';

// Marker doubles as the idempotency check: injecting twice on a re-send (or on
// a template that already carries the block) would read as a bug to the reader.
const POSTAL_FOOTER_MARKER = 'data-dd-postal';

function renderPostalFooter() {
    const address = process.env.DEERDAWN_POSTAL_ADDRESS || DEFAULT_POSTAL_ADDRESS;
    return `<div ${POSTAL_FOOTER_MARKER} style="max-width:520px;margin:0 auto;padding:0 24px 32px;color:#6b7280;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;">${escapeHtml(address)}</div>`;
}

// Appended just inside </body> so it lands after the message rather than after
// the closing tag, where several clients would drop it. Templates that are not
// full documents (no </body>) get it concatenated instead.
function withPostalFooter(html) {
    const source = String(html == null ? '' : html);
    if (source.includes(POSTAL_FOOTER_MARKER)) return source;
    const footer = renderPostalFooter();
    if (/<\/body>/i.test(source)) return source.replace(/<\/body>/i, `${footer}</body>`);
    return source + footer;
}

// The plain-text twin of withPostalFooter: the address as the last line, once.
function withPostalFooterText(text) {
    const source = String(text == null ? '' : text);
    const address = process.env.DEERDAWN_POSTAL_ADDRESS || DEFAULT_POSTAL_ADDRESS;
    if (source.includes(address)) return source;
    return `${source.replace(/\s+$/, '')}\n\n${address}\n`;
}

function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]
    ));
}

module.exports = { sendEmail, sanitizeTagValue, withPostalFooter, withPostalFooterText, renderPostalFooter, DEFAULT_POSTAL_ADDRESS };
