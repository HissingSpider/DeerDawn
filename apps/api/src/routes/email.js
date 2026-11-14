const express = require('express');
const router = express.Router();
const { unsubscribeUser, verifyUnsubscribeToken } = require('../services/email/weeklyDigest');

function page(title, body) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · DeerDawn</title></head>
  <body style="margin:0;background:#07111d;color:#e5e7eb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:440px;margin:80px auto;padding:0 24px;text-align:center;">
    <div style="font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:#10B981;font-weight:700;">DeerDawn</div>
    <h1 style="margin:12px 0 0;font-size:22px;color:#ffffff;">${title}</h1>
    <p style="margin:12px 0 0;color:#9aa4b2;font-size:15px;line-height:1.7;">${body}</p>
  </div></body></html>`;
}

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]
    ));
}

// Public (no auth). Identity is proven by the HMAC token in the link, so no
// session is required.
//
// A GET IS ONLY EVER A PAGE. It used to unsubscribe on fetch, so a mail client
// that prefetches links, or a security scanner following every URL in a message,
// silently removed people from the digest. The GET now checks the token and
// shows one button; the POST behind that button is what changes the account.
router.get('/unsubscribe', (req, res) => {
    const userId = typeof req.query.u === 'string' ? req.query.u : '';
    const token = typeof req.query.t === 'string' ? req.query.t : '';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!verifyUnsubscribeToken(userId, token)) {
        return res.status(400).send(page('Link expired', 'This unsubscribe link is invalid or expired. You can manage email preferences from your dashboard settings.'));
    }
    return res.status(200).send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe · DeerDawn</title></head>
  <body style="margin:0;background:#07111d;color:#e5e7eb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:440px;margin:80px auto;padding:0 24px;text-align:center;">
    <div style="font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:#10B981;font-weight:700;">DeerDawn</div>
    <h1 style="margin:12px 0 0;font-size:22px;color:#ffffff;">Unsubscribe from the weekly digest and reminders?</h1>
    <p style="margin:12px 0 0;color:#9aa4b2;font-size:15px;line-height:1.7;">This stops the weekly digest and the reminder emails that nudge you to set up or come back. You will still get notices about your account and your projects, such as when a project is archived. Your context keeps syncing as usual.</p>
    <form method="post" action="/api/v1/email/unsubscribe" style="margin:24px 0 0;">
      <input type="hidden" name="u" value="${esc(userId)}">
      <input type="hidden" name="t" value="${esc(token)}">
      <button type="submit" style="background:#10B981;color:#03120b;border:0;font-weight:600;font-size:14px;padding:12px 20px;border-radius:12px;cursor:pointer;">Unsubscribe</button>
    </form>
  </div></body></html>`);
});

router.post('/unsubscribe', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const userId = typeof body.u === 'string' ? body.u : (typeof req.query.u === 'string' ? req.query.u : '');
    const token = typeof body.t === 'string' ? body.t : (typeof req.query.t === 'string' ? req.query.t : '');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    try {
        const ok = await unsubscribeUser(userId, token);
        if (ok) {
            return res.status(200).send(page('You&rsquo;re unsubscribed', 'You won&rsquo;t get the weekly digest or reminder emails anymore. You will still get notices about your account and projects, such as when a project is archived. Your context keeps syncing as usual.'));
        }
        return res.status(400).send(page('Link expired', 'This unsubscribe link is invalid or expired. You can manage email preferences from your dashboard settings.'));
    } catch {
        return res.status(500).send(page('Something went wrong', 'Please try again in a moment.'));
    }
});

module.exports = router;
