/**
 * The load-bearing swallow points must stay reported.
 *
 * On 2026-08-30 four failures had been running silently for days to months and
 * not one of them threw — each was caught, logged to console, and handled. That
 * is precisely why the existing error capture never saw them: captureException
 * is wired to next(err) and to uncaught exceptions, and these reached neither.
 *
 * Adding an error-tracking vendor does not fix that. The report has to happen
 * where the error is absorbed, which is what reportSwallowed does — and what
 * this file keeps true.
 *
 * Source-text assertions, deliberately. The behaviour under test is "this call
 * site still reports", which is a property of the code rather than of a
 * runtime: exercising it for real would mean booting a cron, a webhook and the
 * Clerk SDK to observe an absence.
 */
const test = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src');
const read = (rel) => readFileSync(path.join(SRC, rel), 'utf8');

// Comment-blind: a call site described in prose is not a call site. This repo
// has been caught by that before, where a source-text assertion passed against
// a mention in a comment rather than real code.
const stripComments = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SITES = [
    {
        file: 'app.js',
        op: 'ttl_expiry_sweep',
        why: 'a daily job that DELETES user context. The empty catch here hid an audit-write failure for the life of the feature.',
    },
    {
        file: 'middleware/auth.js',
        op: 'clerk_identity_sync_failed',
        why: 'a DB write failure here 401s a real user on every request, forever, and reads to them as "session expired".',
    },
    {
        file: 'routes/auth-webhooks.js',
        op: 'clerk_user_deleted_sync',
        why: 'this 500d on every delivery for months, orphaning 120 users rows and silently breaking right-to-erasure.',
    },
    {
        file: 'routes/auth-webhooks.js',
        op: 'erasure_incomplete_org_delete',
        why: 'a right-to-erasure request that half-completed must reach a human.',
    },
    {
        file: 'routes/auth-webhooks.js',
        op: 'erasure_subscription_cancel_failed',
        why: 'the webhook erasure path cannot abort, so a failed Stripe cancel here means a deleted account that keeps getting billed — silently, forever, with no dashboard left to cancel from.',
    },
];

for (const site of SITES) {
    test(`${site.file} still reports ${site.op}`, () => {
        const code = stripComments(read(site.file));
        assert.ok(
            code.includes('reportSwallowed'),
            `${site.file} no longer calls reportSwallowed. ${site.why}`
        );
        assert.ok(
            code.includes(site.op),
            `${site.file} no longer reports op "${site.op}". ${site.why}\n` +
            'The op string is the fingerprint occurrences group by, so renaming it ' +
            'silently splits the history of an incident in two.'
        );
    });
}

test('the destructive paths are marked destructive', () => {
    // `destructive: true` is what separates "worth an alert at 3am" from
    // "worth a dashboard". Every path that deletes user data carries it.
    //
    // ASSERTED PER CALL SITE, NOT BY COUNTING THEM. This used to require
    // exactly three `destructive: true` in auth-webhooks.js, which made adding
    // a FOURTH reported erasure failure — the thing this file exists to
    // encourage — fail the build. A count pins how much code there is; what
    // matters is that every reporting site on the erasure path has answered the
    // question, and that the answer is right.
    const app = stripComments(read('app.js'));
    assert.ok(/destructive:\s*true/.test(app), 'the TTL sweep deletes user context and must be flagged destructive');

    // The one op in this file that reports something NOT destructive: the
    // workspace was deliberately retained because other members are still in
    // it. Nothing was erased, so nothing needs waking anybody at 3am — but it
    // still has to reach a human, because that workspace now has no owner.
    //
    // And clerk_user_updated_email_collision: a user.updated whose new primary
    // address already belongs to another account. The handler writes NOTHING
    // (no merge, no overwrite) and asks a human to look, so it erased nothing
    // either.
    const KEPT_EVERYTHING = new Set([
        'erasure_skipped_shared_workspace',
        'clerk_user_updated_email_collision',
        // The same handler's email UPDATE failing outright: the row is left as
        // it was and Clerk retries. A sync that did not happen deleted nothing.
        'clerk_user_updated_sync',
        // A Stripe customer's email not following a Clerk email change: the
        // users row moved and the customer kept its old address. Nothing was
        // deleted; a human re-sends the update.
        'clerk_user_updated_stripe_email_failed',
        // A side workspace that somebody joined while its last member's
        // account was being erased (scan 28): it is left open, with its new
        // member and its subscription. Nothing was erased, but the person who
        // asked for erasure is gone from it, so a human should know.
        'erasure_sole_workspace_gained_member',
    ]);

    const webhooks = stripComments(read('routes/auth-webhooks.js'));
    const sites = webhooks.split('reportSwallowed(').slice(1);
    assert.ok(sites.length >= 3, 'the erasure path must still report its swallowed failures');

    for (const site of sites) {
        const op = /op:\s*'([a-z0-9_]+)'/.exec(site);
        const flag = /destructive:\s*(true|false)/.exec(site);
        assert.ok(op, `a reportSwallowed site in auth-webhooks.js has no op: ${site.slice(0, 80)}`);
        assert.ok(flag, `${op[1]} does not say whether it is destructive — on the erasure path that has to be answered, not defaulted`);
        assert.strictEqual(
            flag[1] === 'true',
            !KEPT_EVERYTHING.has(op[1]),
            `${op[1]} is flagged destructive: ${flag[1]}, which is not what this path does`
        );
    }
});

test('reportSwallowed logs as well as captures', () => {
    // The log line is what someone greps when the dashboard is the broken
    // thing. Capturing without logging trades one blind spot for another.
    const helper = stripComments(read('utils/reportSwallowed.js'));
    assert.ok(helper.includes('console.error'), 'must still write a greppable line');
    assert.ok(helper.includes('captureException'), 'must still reach the error tracker');
});

test('reportSwallowed never rethrows', () => {
    // These call sites swallow for good reasons — a failed audit write should
    // not abort a deletion, a failed token verify should 401 rather than 500.
    // The handling stays; only the silence goes. A throw here would convert
    // every reported site into a new outage.
    const helper = stripComments(read('utils/reportSwallowed.js'));
    assert.ok(!/^\s*throw /m.test(helper), 'reportSwallowed must not rethrow');
});
