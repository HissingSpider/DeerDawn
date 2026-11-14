const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const express = require('express');
const { Webhook } = require('svix');

const db = require('../../src/config/db');
const productEvents = require('../../src/services/productEventsService');

// A Svix-format secret: "whsec_" + base64. The library rejects anything else,
// so the test signs with a real one rather than stubbing verification away —
// otherwise the signature check itself would go untested.
const SECRET = `whsec_${Buffer.from('resend-webhook-test-secret-key-32').toString('base64')}`;

function loadRoute() {
    // The route reads RESEND_WEBHOOK_SECRET at module load, so it must be set
    // before require and the module cache cleared between configurations.
    delete require.cache[require.resolve('../../src/routes/webhooks-resend')];
    return require('../../src/routes/webhooks-resend');
}

/** Sign and deliver a payload the way Resend does, through the real router. */
async function post(router, body, { secret = SECRET, tamper = false } = {}) {
    const app = express();
    app.use('/hook', router);

    const payload = JSON.stringify(body);
    const msgId = `msg_${crypto.randomUUID()}`;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = new Webhook(secret).sign(msgId, new Date(timestamp * 1000), payload);

    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    try {
        const res = await fetch(`http://127.0.0.1:${port}/hook`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'svix-id': msgId,
                'svix-timestamp': timestamp,
                'svix-signature': tamper ? 'v1,not-a-real-signature' : signature,
            },
            body: payload,
        });
        return { status: res.status, body: await res.json().catch(() => ({})) };
    } finally {
        server.close();
    }
}

function withEnv(value, fn) {
    const prev = process.env.RESEND_WEBHOOK_SECRET;
    if (value === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
    else process.env.RESEND_WEBHOOK_SECRET = value;
    return (async () => {
        try {
            return await fn();
        } finally {
            if (prev !== undefined) process.env.RESEND_WEBHOOK_SECRET = prev;
            else delete process.env.RESEND_WEBHOOK_SECRET;
        }
    })();
}

test('rejects an unsigned/forged delivery', async () => {
    await withEnv(SECRET, async () => {
        const router = loadRoute();
        const res = await post(router, { type: 'email.opened', data: { to: ['a@example.com'] } }, { tamper: true });
        assert.equal(res.status, 400);
        assert.equal(res.body.error, 'invalid_signature');
    });
});

test('refuses to run when the webhook secret is not configured', async () => {
    await withEnv(undefined, async () => {
        const router = loadRoute();
        const res = await post(router, { type: 'email.opened', data: {} });
        // 500, not 200: an unauthenticated public endpoint that silently accepts
        // unverifiable payloads is worse than one that is loudly broken.
        assert.equal(res.status, 500);
    });
});

test('records an open against the matched user, carrying the email_type tag', async () => {
    await withEnv(SECRET, async () => {
        const originalQuery = db.query;
        const originalRecord = productEvents.recordProductEvent;
        const recorded = [];
        db.query = async () => ({ rows: [{ user_id: 'user-1', org_id: 'org-1' }] });
        productEvents.recordProductEvent = async (actor, input) => { recorded.push({ actor, input }); };
        try {
            const router = loadRoute();
            const res = await post(router, {
                type: 'email.opened',
                data: {
                    to: ['someone@example.com'],
                    subject: 'You are set up',
                    email_id: 'email-abc',
                    tags: [{ name: 'email_type', value: 'setup_link' }],
                },
            });
            assert.equal(res.status, 200);
            assert.equal(recorded.length, 1);
            assert.equal(recorded[0].input.event_name, 'email_opened');
            assert.equal(recorded[0].actor.id, 'user-1');
            assert.equal(recorded[0].input.metadata.email_type, 'setup_link');
            assert.equal(recorded[0].input.metadata.matched_user, true);
            // The recipient address must never ride along in the payload.
            const serialized = JSON.stringify(recorded[0].input);
            assert.ok(!serialized.includes('someone@example.com'), 'recipient address leaked into the event');
        } finally {
            db.query = originalQuery;
            productEvents.recordProductEvent = originalRecord;
        }
    });
});

test('an unmatched recipient still gets a stable distinct id, not a null one', async () => {
    await withEnv(SECRET, async () => {
        const originalQuery = db.query;
        const originalRecord = productEvents.recordProductEvent;
        const recorded = [];
        db.query = async () => ({ rows: [] }); // lead who never signed up
        productEvents.recordProductEvent = async (actor, input) => { recorded.push({ actor, input }); };
        try {
            const router = loadRoute();
            const send = () => post(router, {
                type: 'email.clicked',
                data: {
                    to: ['Lead@Example.com'],
                    tags: [{ name: 'email_type', value: 'setup_link' }],
                    click: { link: 'https://app.deerdawn.com/onboarding' },
                },
            });
            await send();
            await send();

            assert.equal(recorded.length, 2);
            assert.equal(recorded[0].input.metadata.matched_user, false);
            assert.ok(recorded[0].input.session_id, 'unmatched recipients need a session_id or they have no distinct_id at all');
            // Stable across deliveries, so open -> click correlates for one person.
            assert.equal(recorded[0].input.session_id, recorded[1].input.session_id);
            assert.ok(!recorded[0].input.session_id.includes('@'), 'session_id must be a hash, not the address');
            assert.equal(recorded[0].input.metadata.click_url, 'https://app.deerdawn.com/onboarding');
        } finally {
            db.query = originalQuery;
            productEvents.recordProductEvent = originalRecord;
        }
    });
});

test('acknowledges unmapped event types instead of forcing a retry storm', async () => {
    await withEnv(SECRET, async () => {
        const originalRecord = productEvents.recordProductEvent;
        let called = 0;
        productEvents.recordProductEvent = async () => { called += 1; };
        try {
            const router = loadRoute();
            const res = await post(router, { type: 'email.something_new', data: {} });
            assert.equal(res.status, 200);
            assert.equal(called, 0);
        } finally {
            productEvents.recordProductEvent = originalRecord;
        }
    });
});

test('still returns 200 when recording fails, so Resend does not duplicate on retry', async () => {
    await withEnv(SECRET, async () => {
        const originalQuery = db.query;
        const originalRecord = productEvents.recordProductEvent;
        db.query = async () => ({ rows: [] });
        productEvents.recordProductEvent = async () => { throw new Error('posthog down'); };
        try {
            const router = loadRoute();
            const res = await post(router, {
                type: 'email.delivered',
                data: { to: ['a@example.com'] },
            });
            assert.equal(res.status, 200);
        } finally {
            db.query = originalQuery;
            productEvents.recordProductEvent = originalRecord;
        }
    });
});
