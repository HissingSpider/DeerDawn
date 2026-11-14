const test = require('node:test');
const assert = require('node:assert');

const db = require('../../src/config/db');
const productEvents = require('../../src/services/productEventsService');
const svc = require('../../src/services/sessionCatchupService');

// connection_established is the ONLY server-side trace a brand-new account's first
// start_session leaves: there is no project yet (so no session_started) and no
// global context yet (so no context_delivered). It must fire exactly once, and it
// must never be mistaken for activation — first_sync_completed still requires real
// context to reach a tool.

const ACTOR = { type: 'user', id: 'user-1', org_id: 'org-1' };

function withStubs({ already }, run) {
    const originalQuery = db.queryBestEffort;
    const originalRecord = productEvents.recordProductEvent;
    const captured = { queries: [], events: [] };
    db.queryBestEffort = async (text, params, orgId) => {
        captured.queries.push({ text, params, orgId });
        return already === undefined ? { rows: [] } : { rows: [{ already }] };
    };
    productEvents.recordProductEvent = async (actor, input) => {
        captured.events.push(input);
        return input;
    };
    return (async () => {
        try {
            return await run(captured);
        } finally {
            db.queryBestEffort = originalQuery;
            productEvents.recordProductEvent = originalRecord;
        }
    })();
}

test('emits connection_established once when no prior marker exists', async () => {
    await withStubs({ already: false }, async (captured) => {
        const emitted = await svc.maybeEmitConnectionEstablished(ACTOR, { tool: 'claude_code' });
        assert.equal(emitted, true);
        assert.equal(captured.events.length, 1);
        assert.equal(captured.events[0].event_name, 'connection_established');
        assert.equal(captured.events[0].surface, 'claude_code');
        const q = captured.queries[0];
        assert.ok(q.text.includes('product_events'), 'idempotence rides the event store');
        assert.deepEqual(q.params, ['user-1', 'org-1'], 'per-user, with org fallback for key-authed rows');
    });
});

test('does not re-emit once the marker exists', async () => {
    await withStubs({ already: true }, async (captured) => {
        const emitted = await svc.maybeEmitConnectionEstablished(ACTOR, { tool: 'claude_code' });
        assert.equal(emitted, false);
        assert.equal(captured.events.length, 0);
    });
});

// queryBestEffort swallows DB errors and returns no rows. Emitting on an unknown
// answer would double-count the milestone, so the check fails closed.
test('does not emit when the idempotence check returns no rows', async () => {
    await withStubs({ already: undefined }, async (captured) => {
        const emitted = await svc.maybeEmitConnectionEstablished(ACTOR, { tool: 'claude_code' });
        assert.equal(emitted, false);
        assert.equal(captured.events.length, 0);
    });
});

test('no-ops for an actor with neither user nor org', async () => {
    await withStubs({ already: false }, async (captured) => {
        const emitted = await svc.maybeEmitConnectionEstablished({}, { tool: 'claude_code' });
        assert.equal(emitted, false);
        assert.equal(captured.queries.length, 0, 'never queries without an identity');
        assert.equal(captured.events.length, 0);
    });
});

// The whole point of the fix: a connection is not activation. findRecipients passes
// its activation-event set as params[0], so this asserts the real query rather than
// the source text. If this ever flips, activation follow-up emails and Reddit CAPI
// conversions start firing for users who received nothing.
test('a bare connection does not count as activation for the follow-up email', async () => {
    const followUp = require('../../src/services/email/activationFollowUp');
    const originalQuery = db.query;
    let params = null;
    db.query = async (text, p) => {
        params = p;
        return { rows: [] };
    };
    try {
        await followUp.findRecipients();
        assert.ok(Array.isArray(params[0]), 'activation events are passed as params[0]');
        assert.ok(
            !params[0].includes('connection_established'),
            'a bare connection must never count as activation',
        );
        assert.ok(params[0].includes('context_delivered'), 'real value still counts');
    } finally {
        db.query = originalQuery;
    }
});
