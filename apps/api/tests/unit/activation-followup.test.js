const test = require('node:test');
const assert = require('node:assert');

const db = require('../../src/config/db');
const resendClient = require('../../src/services/email/resendClient');
const productEvents = require('../../src/services/productEventsService');
const svc = require('../../src/services/email/activationFollowUp');

test('no-ops (skipped) when RESEND_API_KEY is unset', async () => {
    const prev = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
        const res = await svc.sendActivationFollowUpEmails();
        assert.deepEqual(res, { sent: 0, skipped: true });
    } finally {
        if (prev !== undefined) process.env.RESEND_API_KEY = prev;
    }
});

test('findRecipients targets un-activated, non-unsubscribed, not-yet-emailed signups', async () => {
    const originalQuery = db.query;
    const captured = [];
    db.query = async (text, params, orgId) => {
        captured.push({ text, params, orgId });
        return { rows: [{ user_id: 'user-1', org_id: 'org-1', email: 'a@example.com' }] };
    };
    try {
        const rows = await svc.findRecipients();
        assert.equal(rows.length, 1);
        const q = captured[0];
        assert.equal(q.orgId, 'org-system');
        assert.ok(q.text.includes('weekly_digest_unsubscribed'), 'honors unsubscribe');
        assert.ok(q.text.includes('NOT EXISTS'), 'excludes activated + already-emailed');
        assert.ok(q.text.includes('product_events'), 'checks the event store');
        // Activation = real value delivered, NOT merely calling a tool. A brand-new
        // account's start_session returns an empty injection, so treating it as
        // activation suppressed the nudge for connected-but-briefless users.
        assert.ok(Array.isArray(q.params[0]) && q.params[0].includes('context_delivered'), 'activation events param');
        assert.ok(
            !q.params[0].includes('mcp_start_session_succeeded'),
            'a tool call alone must NOT count as activation',
        );
        assert.ok(
            Array.isArray(q.params[1]) && q.params[1].includes('mcp_start_session_succeeded'),
            'connected-events param drives which email variant is sent',
        );
        assert.equal(q.params[2], 'activation_followup_email_sent', 'sent-marker param');
        assert.equal(typeof q.params[3], 'number', 'per-run cap param');
    } finally {
        db.query = originalQuery;
    }
});

test('findRecipients excludes Clerk +clerk_test journey accounts', async () => {
    const originalQuery = db.query;
    const captured = [];
    db.query = async (text, params, orgId) => {
        captured.push({ text, params, orgId });
        return { rows: [] };
    };
    try {
        await svc.findRecipients();
        const q = captured[0];
        // These addresses are not real mailboxes, so every send to one bounces.
        // The nightly journey run makes exactly one per day, which was half of
        // this job's entire volume and half its sender reputation.
        assert.equal(q.params[4], '+clerk_test', 'test-email marker is a bound param');
        assert.ok(
            /POSITION\(\$5 IN lower\(u\.email\)\) = 0/.test(q.text),
            'the marker is applied to the recipient query, case-insensitively',
        );
        // Escaping trap: '_' is a LIKE wildcard, so LIKE '%+clerk_test%' would
        // also match '+clerkXtest'. POSITION is literal — keep it that way.
        assert.ok(!/LIKE\s+'%\+clerk_test/i.test(q.text), 'must not match the marker with an unescaped LIKE');
    } finally {
        db.query = originalQuery;
    }
});

test('sends one email per recipient and records a sent-marker on success', async () => {
    const prevKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = 'test_key';
    const originalQuery = db.query;
    const originalSend = resendClient.sendEmail;
    const originalRecord = productEvents.recordProductEvent;

    const emails = [];
    const marks = [];
    db.query = async () => ({ rows: [
        { user_id: 'user-1', org_id: 'org-1', email: 'a@example.com' },
        { user_id: 'user-2', org_id: 'org-2', email: 'b@example.com' },
    ] });
    resendClient.sendEmail = async (payload) => { emails.push(payload); return { ok: true }; };
    productEvents.recordProductEvent = async (actor, payload) => { marks.push({ actor, payload }); return {}; };

    try {
        const res = await svc.sendActivationFollowUpEmails();
        assert.equal(res.sent, 2);
        assert.equal(res.total, 2);
        assert.equal(emails.length, 2);
        assert.equal(emails[0].to, 'a@example.com');
        assert.ok(emails[0].subject.includes('connect your first tool'));
        assert.ok(emails[0].html.includes('/setup'), 'CTA links to the connect step');
        assert.ok(emails[0].html.toLowerCase().includes('unsubscribe'), 'has an unsubscribe link');
        assert.equal(marks.length, 2);
        assert.equal(marks[0].payload.event_name, 'activation_followup_email_sent');
        assert.equal(marks[0].actor.id, 'user-1');
    } finally {
        db.query = originalQuery;
        resendClient.sendEmail = originalSend;
        productEvents.recordProductEvent = originalRecord;
        if (prevKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = prevKey;
    }
});

test('sends the first-brief variant to users who connected but have no brief yet', async () => {
    const prevKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = 'test_key';
    const originalQuery = db.query;
    const originalSend = resendClient.sendEmail;
    const originalRecord = productEvents.recordProductEvent;

    const emails = [];
    db.query = async () => ({ rows: [
        { user_id: 'user-1', org_id: 'org-1', email: 'connected@example.com', connected: true },
        { user_id: 'user-2', org_id: 'org-2', email: 'cold@example.com', connected: false },
    ] });
    resendClient.sendEmail = async (payload) => { emails.push(payload); return { ok: true }; };
    productEvents.recordProductEvent = async () => ({});

    try {
        await svc.sendActivationFollowUpEmails();

        // Connected user: do not tell them to connect — they already did.
        assert.ok(emails[0].subject.includes('save your first brief'));
        assert.ok(emails[0].html.includes('manage_memory'), 'gives them the seeding prompt');
        // No button: /onboarding opens on the connect step, which is the one
        // thing this person has already done.
        assert.ok(!emails[0].html.includes('/onboarding'), 'never sent to the connect-first onboarding');
        assert.ok(!emails[0].html.includes('/setup'), 'never sent to the connect step');
        assert.ok(!emails[0].html.includes('dd_email='), 'carries no dashboard link at all');
        assert.ok(!emails[0].subject.includes('connect your first tool'));

        // Never-connected user keeps the original copy.
        assert.ok(emails[1].subject.includes('connect your first tool'));
        assert.ok(emails[1].html.includes('/setup'));
    } finally {
        db.query = originalQuery;
        resendClient.sendEmail = originalSend;
        productEvents.recordProductEvent = originalRecord;
        if (prevKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = prevKey;
    }
});

test('does not record a sent-marker when the send fails (so it retries next run)', async () => {
    const prevKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = 'test_key';
    const originalQuery = db.query;
    const originalSend = resendClient.sendEmail;
    const originalRecord = productEvents.recordProductEvent;
    const marks = [];
    db.query = async () => ({ rows: [{ user_id: 'user-1', org_id: 'org-1', email: 'a@example.com' }] });
    resendClient.sendEmail = async () => ({ ok: false, status: 500 });
    productEvents.recordProductEvent = async (a, p) => { marks.push(p); return {}; };
    try {
        const res = await svc.sendActivationFollowUpEmails();
        assert.equal(res.sent, 0);
        assert.equal(marks.length, 0);
    } finally {
        db.query = originalQuery;
        resendClient.sendEmail = originalSend;
        productEvents.recordProductEvent = originalRecord;
        if (prevKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = prevKey;
    }
});

// ── Lifecycle-email click attribution (2026-08-15) ──────────────────────────
// Resend reports opens/clicks only when tracking is enabled per sending domain
// in its dashboard — no per-send API field — so the CTA carries its own marker
// and the dashboard records the arrival. Without this the follow-up has no click
// signal: 52 sent / 14 delivered / 0 activations in the 30d to 2026-08-15, with
// "unread" and "read then lost on the landing page" indistinguishable.

test('the CTA link carries the email type so the click is attributable on arrival', () => {
    const unconnected = svc.followUpCtaUrl('https://app.deerdawn.com', false);
    const u = new URL(unconnected);

    // Was '/settings/tools' until 2026-08-27. The redesign renamed that route to
    // /setup and kept the old URL alive with a next.config redirect — and that
    // redirect strips the query string, so every click arrived without dd_email
    // or any utm_*, and lifecycle_email_clicked never fired once in 30 days
    // (44 sent, 31 delivered, 0 clicks). See lifecycle-email-cta-routes.test.js,
    // which pins these paths against the dashboard's redirect table.
    assert.equal(u.pathname, '/setup');

    // dd_email is what the dashboard reads to emit lifecycle_email_clicked.
    assert.equal(u.searchParams.get('dd_email'), 'activation_followup_unconnected');
    // The saved variant is measured on its own.
    const saved = new URL(svc.followUpCtaUrl('https://app.deerdawn.com', false, true));
    assert.equal(saved.searchParams.get('dd_email'), 'activation_followup_unconnected_saved');

    // utm_* ride along because captureAttribution() already stores them
    // first-touch, so the email appears in existing source breakdowns for free.
    assert.equal(u.searchParams.get('utm_source'), 'lifecycle_email');
    assert.equal(u.searchParams.get('utm_medium'), 'email');
    assert.equal(u.searchParams.get('utm_campaign'), 'activation_followup_unconnected');
});

test('dd_email matches the Resend tag exactly, so sends and clicks join', () => {
    // The webhook writes email_delivered/email_bounced keyed on the Resend tag
    // value; lifecycle_email_clicked is keyed on dd_email. If the two ever drift
    // the funnel silently splits into two unjoinable halves.
    for (const saved of [true, false]) {
        const url = new URL(svc.followUpCtaUrl('https://app.deerdawn.com', false, saved));
        assert.equal(url.searchParams.get('dd_email'), svc.emailTypeFor(false, saved));
    }
});

test('the sent email actually contains the tagged link', async () => {
    const prevKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = 'test_key';
    const originalQuery = db.query;
    const originalSend = resendClient.sendEmail;
    const originalRecord = productEvents.recordProductEvent;
    const emails = [];
    db.query = async () => ({
        rows: [
            { user_id: 'u-1', org_id: 'o-1', email: 'a@example.com', connected: false },
            { user_id: 'u-2', org_id: 'o-2', email: 'b@example.com', connected: true },
        ],
    });
    resendClient.sendEmail = async (msg) => { emails.push(msg); return { ok: true }; };
    productEvents.recordProductEvent = async () => ({});
    try {
        await svc.sendActivationFollowUpEmails();
        assert.equal(emails.length, 2);
        assert.ok(
            emails[0].html.includes('dd_email=activation_followup_unconnected'),
            'unconnected email links with its own marker',
        );
        assert.ok(!emails[1].html.includes('dd_email='), 'the connected email has no dashboard link');
        // The tag on the send and the marker in the link must agree.
        assert.equal(emails[0].emailType, 'activation_followup_unconnected');
        assert.equal(emails[1].emailType, 'activation_followup_connected');
    } finally {
        db.query = originalQuery;
        resendClient.sendEmail = originalSend;
        productEvents.recordProductEvent = originalRecord;
        if (prevKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = prevKey;
    }
});

// ── CTA upgrade: the return prompt and the no-install path (C-4, 2026-08-21) ──
// The old closing paraphrased the ask as "Where did I leave off?", which is a
// description of the product, not something a user can paste. The activation
// plan's START_SESSION_PROMPT is the literal sentence that makes the tool do the
// thing; these assertions pin the exact copy because it is John-approved.

test('both variants close with the exact start_session return prompt', () => {
    const connected = svc.renderFollowUpHtml('https://app.deerdawn.test/onboarding', 'https://unsub.test', true);
    const unconnected = svc.renderFollowUpHtml('https://app.deerdawn.test/setup', 'https://unsub.test', false);

    const prompt = 'Run start_session from DeerDawn and tell me what I was working on.';
    assert.ok(connected.includes(prompt), 'connected variant prescribes the return prompt');
    assert.ok(unconnected.includes(prompt), 'unconnected variant prescribes the return prompt');

    // The seeding prompt must still come FIRST for the connected user: a
    // brand-new account has nothing saved, so start_session on day one returns
    // an empty brief. Seed, then return.
    assert.ok(connected.includes('as my project brief'), 'seeding prompt still leads');
    assert.ok(connected.indexOf('as my project brief') < connected.indexOf(prompt));
});

test('the never-connected variant offers the no-install remote MCP path', () => {
    const unconnected = svc.renderFollowUpHtml('https://app.deerdawn.test/setup', 'https://unsub.test', false);

    // The URL is the whole no-install path — pasting it into a connector is all
    // there is to do, so it has to be in the email, not one click away.
    assert.ok(unconnected.includes('https://api.deerdawn.com/mcp'), 'remote MCP URL is spelled out');
    assert.ok(/Claude\.ai and ChatGPT/.test(unconnected), 'names the two hosted connectors');
    assert.ok(/Nothing to install/.test(unconnected), 'frames it as the local-setup fallback');

    // Someone who already connected does not need a way around local config;
    // offering it would just be a second, confusing ask.
    const connected = svc.renderFollowUpHtml('https://app.deerdawn.test/onboarding', 'https://unsub.test', true);
    assert.ok(!connected.includes('https://api.deerdawn.com/mcp'), 'connected variant is not offered the fallback');
});

test('the CTA upgrade did not disturb targeting, idempotency or the no-key no-op', async () => {
    // C-4 is a copy change. Everything that decides WHO gets mailed and WHETHER
    // a second run re-nags them lives in findRecipients + the sent-marker, and
    // must be byte-identical in behaviour.
    const prevKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
        assert.deepEqual(await svc.sendActivationFollowUpEmails(), { sent: 0, skipped: true });
    } finally {
        if (prevKey !== undefined) process.env.RESEND_API_KEY = prevKey;
    }

    const originalQuery = db.query;
    const originalSend = resendClient.sendEmail;
    const originalRecord = productEvents.recordProductEvent;
    process.env.RESEND_API_KEY = 'test_key';
    const marks = [];
    db.query = async () => ({ rows: [{ user_id: 'user-1', org_id: 'org-1', email: 'a@example.com', connected: false }] });
    resendClient.sendEmail = async () => ({ ok: true });
    productEvents.recordProductEvent = async (actor, payload) => { marks.push(payload); return {}; };
    try {
        await svc.sendActivationFollowUpEmails();
        assert.equal(marks.length, 1);
        assert.equal(marks[0].event_name, 'activation_followup_email_sent');
    } finally {
        db.query = originalQuery;
        resendClient.sendEmail = originalSend;
        productEvents.recordProductEvent = originalRecord;
        if (prevKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = prevKey;
    }
});

test('the seeding prompt names a tool the connectors actually advertise', () => {
  // update_context is dispatchable but not in tools/list; a first save that
  // names it fails on hosted connectors. The dashboard's copy was fixed in
  // 2026-08; this email kept the old name until 2026-09-16.
  const src = require('fs').readFileSync(require.resolve('../../src/services/email/activationFollowUp'), 'utf8');
  assert.ok(!/update_context/.test(src.replace(/^\s*\/\/.*$/gm, '')), 'no update_context in the email copy');
});

// ── E-033 (2026-09-28): authorized on a consent screen, never used ─────────────
// A hosted connector is connected when the person approves it, but the client
// only handshakes when they next use it in a chat. On 09-27 three of four new
// ChatGPT approvers had no handshake a day later and were sent the never-connected
// copy, which asks them to paste a URL into the tool they had just approved.

function withSendHarness(rows, fn) {
    return async () => {
        const prevKey = process.env.RESEND_API_KEY;
        process.env.RESEND_API_KEY = 'test_key';
        const originalQuery = db.query;
        const originalSend = resendClient.sendEmail;
        const originalRecord = productEvents.recordProductEvent;
        const emails = [];
        const marks = [];
        db.query = async () => ({ rows });
        resendClient.sendEmail = async (msg) => { emails.push(msg); return { ok: true }; };
        productEvents.recordProductEvent = async (actor, payload) => { marks.push(payload); return {}; };
        try {
            await svc.sendActivationFollowUpEmails();
            await fn(emails, marks);
        } finally {
            db.query = originalQuery;
            resendClient.sendEmail = originalSend;
            productEvents.recordProductEvent = originalRecord;
            if (prevKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = prevKey;
        }
    };
}

test('findRecipients reads the hosted grant from the row the token endpoint mints', async () => {
    const originalQuery = db.query;
    const captured = [];
    db.query = async (text, params, orgId) => { captured.push({ text, params, orgId }); return { rows: [] }; };
    try {
        await svc.findRecipients();
        const q = captured[0].text;
        assert.match(q, /FROM api_keys k\s+WHERE k\.owner_id = u\.user_id AND k\.oauth_resource IS NOT NULL\s*\)\s*AS authorized/);
        assert.match(q, /AS authorized_client/);
    } finally {
        db.query = originalQuery;
    }
});

test('an authorized-but-silent account is sent back to the tool it approved, not to /setup', withSendHarness(
    [{ user_id: 'u-1', org_id: 'o-1', email: 'a@example.com', connected: false, authorized: true, authorized_client: 'ChatGPT' }],
    (emails, marks) => {
        assert.equal(emails.length, 1);
        const e = emails[0];
        assert.equal(e.emailType, 'activation_followup_authorized');
        assert.ok(e.subject.includes('ChatGPT'), e.subject);
        assert.ok(!e.subject.includes('connect your first tool'));
        // No dashboard link: every page it could open asks a connected account
        // to connect again. The Resend tag still measures the variant.
        assert.ok(!e.html.includes('dd_email='), 'no dashboard link');
        assert.ok(!e.html.includes('/onboarding'), 'never sent to the connect-first onboarding');
        assert.ok(!e.html.includes('<a href="https://app.'), 'no button into the dashboard');
        assert.ok(!e.html.includes('/setup?'), 'never offers the connect step to a connected account');
        assert.ok(!e.html.includes('https://api.deerdawn.com/mcp'), 'no URL to paste: the connection exists');
        assert.ok(e.html.includes('manage_memory'), 'the one message they still need to send');
        assert.equal(marks[0].metadata.email_type, 'activation_followup_authorized', 'variant readable in analytics');
    },
));

test('a handshake outranks a grant: connected accounts keep the connected copy', withSendHarness(
    [{ user_id: 'u-1', org_id: 'o-1', email: 'a@example.com', connected: true, authorized: true, authorized_client: 'ChatGPT' }],
    (emails) => {
        assert.equal(emails[0].emailType, 'activation_followup_connected');
    },
));

test('no grant and no handshake keeps the never-connected copy', withSendHarness(
    [{ user_id: 'u-1', org_id: 'o-1', email: 'a@example.com', connected: false, authorized: false, authorized_client: null }],
    (emails, marks) => {
        assert.equal(emails[0].emailType, 'activation_followup_unconnected');
        assert.ok(emails[0].html.includes('/setup?'));
        assert.equal(marks[0].metadata.email_type, 'activation_followup_unconnected');
    },
));

test('a client-registered name never reaches the email verbatim', () => {
    // DCR lets anyone register any client_name.
    assert.equal(svc.clientLabel('ChatGPT'), 'ChatGPT');
    assert.equal(svc.clientLabel('openai-mcp'), 'ChatGPT');
    assert.equal(svc.clientLabel('Claude'), 'Claude');
    assert.equal(svc.clientLabel('Connect to all the apps with OAuth DCR + CIMD'), null);
    assert.equal(svc.clientLabel(null), null);
    const html = svc.renderFollowUpHtml('https://x/onboarding', 'https://x/u', 'authorized', false, '<b>Win a prize</b>');
    assert.ok(!html.includes('Win a prize'));
    assert.ok(html.includes('your AI tool'));
    assert.ok(svc.subjectFor('authorized', 'Free money').endsWith('your AI tool — one message left'));
});

test('dd_email and the Resend tag agree wherever there is a link', () => {
    for (const stage of ['unconnected', false]) {
        const url = new URL(svc.followUpCtaUrl('https://app.deerdawn.com', stage));
        assert.equal(url.searchParams.get('dd_email'), svc.emailTypeFor(stage));
        assert.equal(url.searchParams.get('utm_campaign'), svc.emailTypeFor(stage));
    }
});

test('which path each stage gets: only the never-connected stage gets a dashboard link', () => {
    assert.equal(svc.ctaPathFor('unconnected'), '/setup');
    assert.equal(svc.ctaPathFor(false), '/setup');
    assert.equal(svc.ctaPathFor('authorized'), null);
    assert.equal(svc.ctaPathFor('connected'), null);
    assert.equal(svc.ctaPathFor(true), null);
    for (const stage of ['authorized', 'connected', true]) {
        for (const saved of [true, false]) {
            assert.equal(svc.followUpCtaUrl('https://app.deerdawn.com', stage, saved), null, `${stage} saved=${saved}`);
        }
    }
    // Rendered without a link, the button is gone rather than pointing nowhere.
    for (const stage of ['authorized', 'connected']) {
        const html = svc.renderFollowUpHtml(null, 'https://unsub.test', stage, false, 'ChatGPT');
        assert.ok(!html.includes('href="null"'), stage);
        assert.equal((html.match(/<a /g) || []).length, 1, `${stage}: only the unsubscribe link`);
    }
});

// Rebased onto journey r6 (2026-10-02): the authorized copy said "nothing is
// saved", and the owner decision is that only people who saved nothing are told
// that. An authorized person who saved (from the dashboard, say) keeps the
// authorized copy without the claim, and is measured as its own variant.
test('an authorized person who saved is not told nothing is saved', withSendHarness(
    [{ user_id: 'u-1', org_id: 'o-1', email: 'a@example.com', connected: false, authorized: true, authorized_client: 'ChatGPT', saved: true }],
    (emails, marks) => {
        assert.equal(emails[0].emailType, 'activation_followup_authorized_saved');
        assert.equal(marks[0].metadata.email_type, 'activation_followup_authorized_saved');
        assert.doesNotMatch(emails[0].html, /nothing is saved|nothing to brief/i);
        assert.match(emails[0].html, /Run start_session from DeerDawn/);
        assert.doesNotMatch(emails[0].html, /dd_email=/, 'no dashboard link for a connected account');
        assert.match(emails[0].subject, /ChatGPT/);
    },
));

test('an authorized person who saved nothing keeps the authorized copy', withSendHarness(
    [{ user_id: 'u-1', org_id: 'o-1', email: 'a@example.com', connected: false, authorized: true, authorized_client: 'ChatGPT', saved: false }],
    (emails) => {
        assert.equal(emails[0].emailType, 'activation_followup_authorized');
        assert.match(emails[0].html, /nothing is saved/);
        assert.match(emails[0].html, /save it with manage_memory/);
    },
));

test('a saver who never connected or authorized keeps the saved connect copy', withSendHarness(
    [{ user_id: 'u-1', org_id: 'o-1', email: 'a@example.com', connected: false, authorized: false, authorized_client: null, saved: true }],
    (emails) => {
        assert.equal(emails[0].emailType, 'activation_followup_unconnected_saved');
        assert.match(emails[0].subject, /Your work is saved/);
        assert.ok(emails[0].html.includes('/setup?'));
    },
));
