'use strict';

// Resend delivery webhooks -> product events -> PostHog.
//
// Why this exists: 23 activation follow-up emails and a handful of mobile
// setup-link emails have been sent with zero resulting activations, and there
// was no way to tell whether that is a deliverability problem (never arrived),
// an attention problem (never opened), or a landing problem (opened, clicked,
// still did not finish). Those three have completely different fixes.
//
// Resend signs webhooks with Svix, the same scheme Clerk uses, so this reuses
// the `svix` dependency already in the tree — no new package.
//
// Ships dormant: without RESEND_WEBHOOK_SECRET every delivery is rejected, which
// is the correct failure mode for an unauthenticated public endpoint.

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { Webhook } = require('svix');
const db = require('../config/db');
const { recordProductEvent } = require('../services/productEventsService');

const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET;

// Resend event type -> our event name. Anything not listed is acknowledged and
// dropped, so new Resend event types can never 500 the endpoint into a retry
// storm.
const EVENT_MAP = {
    'email.sent': 'email_sent',
    'email.delivered': 'email_delivered',
    'email.opened': 'email_opened',
    'email.clicked': 'email_clicked',
    'email.bounced': 'email_bounced',
    'email.complained': 'email_complained',
    'email.delivery_delayed': 'email_delivery_delayed',
};

/** Pull the email_type tag we set in resendClient.sendEmail. */
function readEmailType(data) {
    const tags = data && data.tags;
    if (Array.isArray(tags)) {
        const hit = tags.find((t) => t && t.name === 'email_type');
        if (hit && hit.value) return String(hit.value);
    }
    // Resend has also delivered tags as a plain object in some payload versions.
    if (tags && typeof tags === 'object' && !Array.isArray(tags) && tags.email_type) {
        return String(tags.email_type);
    }
    return undefined;
}

/**
 * Resolve the recipient to a DeerDawn user so the event lands on the right
 * PostHog person instead of orphaning. Best-effort: a lead who never signed up
 * has no user row, and that is fine — the event still records with the email
 * hash for aggregate rates.
 */
async function findUserByEmail(email) {
    if (!email) return null;
    try {
        const { rows } = await db.query(
            'SELECT user_id, org_id FROM users WHERE lower(email) = lower($1) LIMIT 1',
            [email],
        );
        return rows[0] || null;
    } catch (err) {
        console.warn(`[RESEND] user lookup failed: ${err.message}`);
        return null;
    }
}

router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
    const svixId = req.headers['svix-id'];
    const svixTimestamp = req.headers['svix-timestamp'];
    const svixSignature = req.headers['svix-signature'];

    if (!RESEND_WEBHOOK_SECRET) {
        console.warn('[RESEND] webhook received but RESEND_WEBHOOK_SECRET is not configured');
        return res.status(500).json({ error: 'webhook_secret_not_configured' });
    }
    if (!svixId || !svixTimestamp || !svixSignature) {
        return res.status(400).json({ error: 'missing_signature_headers' });
    }

    let evt;
    try {
        const wh = new Webhook(RESEND_WEBHOOK_SECRET);
        evt = wh.verify(req.body.toString(), {
            'svix-id': svixId,
            'svix-timestamp': svixTimestamp,
            'svix-signature': svixSignature,
        });
    } catch (err) {
        return res.status(400).json({ error: 'invalid_signature' });
    }

    const eventName = EVENT_MAP[evt && evt.type];
    if (!eventName) {
        // 200, not 4xx: an unmapped type is not Resend's error, and a non-2xx
        // would make it retry forever.
        return res.status(200).json({ received: true, ignored: evt && evt.type });
    }

    // Analytics must never break the webhook contract. Any failure past this
    // point still returns 200 — a retry would duplicate the event, which is
    // worse than losing one.
    try {
        const data = (evt && evt.data) || {};
        const recipient = Array.isArray(data.to) ? data.to[0] : data.to;
        const user = await findUserByEmail(recipient);

        // distinctId resolves as user_id || session_id || anonymous_id || org_id,
        // so an unmatched recipient (a lead who never signed up) would land with
        // no distinct_id at all and vanish from PostHog. A stable hash of the
        // address keeps open->click correlated for the same person without ever
        // putting the address in the event.
        const recipientHash = recipient
            ? crypto.createHash('sha256').update(String(recipient).toLowerCase()).digest('hex').slice(0, 32)
            : undefined;

        await recordProductEvent(
            user ? { type: 'user', id: user.user_id, org_id: user.org_id } : {},
            {
                event_name: eventName,
                source: 'api',
                surface: 'resend_webhook',
                session_id: user ? undefined : recipientHash,
                metadata: {
                    email_type: readEmailType(data) || 'unknown',
                    subject: data.subject,
                    // Present on email.clicked only — tells us WHICH link pulled,
                    // e.g. the setup URL vs the unsubscribe.
                    click_url: data.click && data.click.link ? data.click.link : undefined,
                    bounce_type: data.bounce && data.bounce.type ? data.bounce.type : undefined,
                    email_id: data.email_id,
                    // The raw address never enters the payload — only whether we
                    // could resolve it to a known user.
                    matched_user: Boolean(user),
                },
            },
        );
    } catch (err) {
        console.warn(`[RESEND] failed to record ${eventName}: ${err.message}`);
    }

    return res.status(200).json({ received: true });
});

module.exports = router;
