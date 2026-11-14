const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { privateSkipReason } = require('../helpers/privatePaths');

process.env.CLERK_WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET || 'whsec_test_clerk';

const app = require('../../src/app');

function readRoute() {
    return fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'routes', 'auth-webhooks.js'), 'utf8');
}

test('Clerk webhook route aliases are mounted on the API', async () => {
    const mountedRouters = app._router.stack
        .filter((layer) => layer && layer.name === 'router' && layer.regexp)
        .map((layer) => String(layer.regexp));

    assert.ok(
        mountedRouters.includes('/^\\/api\\/v1\\/webhooks\\/?(?=\\/|$)/i'),
        'expected Clerk webhook alias mount at /api/v1/webhooks'
    );

    assert.ok(
        mountedRouters.includes('/^\\/api\\/v1\\/webhooks\\/auth\\/?(?=\\/|$)/i'),
        'expected legacy Clerk webhook mount at /api/v1/webhooks/auth'
    );
});

test('Clerk webhook provisioning uses replay caching and transactional writes', () => {
    const source = readRoute();

    // This used to assert the literal `clerk:webhook:${eventId}`. That pinned
    // the BUG: a Clerk event body has no top-level id, so that key was always
    // null and the cache never stored anything, while this line stayed green.
    // The key is now the svix-id header, and what it does is asserted against
    // real deliveries in tests/integration/clerk-user-updated.test.js.
    assert.match(source, /await client\.query\('BEGIN'\)/);
    assert.match(source, /await client\.query\('COMMIT'\)/);
    assert.match(source, /await client\.query\('ROLLBACK'\)/);
    assert.match(source, /SELECT user_id, org_id, created_at FROM users WHERE auth_provider = \$1 AND auth_subject = \$2 LIMIT 1/);
    assert.match(source, /duplicate:\s*true/);
});

test('Clerk webhook user.deleted returns 500 on DB failure (not silent success)', () => {
    const source = readRoute();
    // Verify the bug fix: user.deleted must have an explicit return for both success and error paths
    // so it doesn't fall through to the unconditional res.json({ success: true }) at the end
    assert.match(source, /return res\.status\(500\)\.json/,
        'user.deleted error path must return 500, not silently succeed');
    assert.match(source, /sync_failed/,
        'user.deleted error must identify as sync_failed');
});

test('Clerk webhook user.deleted success returns explicit 200 (not fall-through)', () => {
    const source = readRoute();
    // Verify user.deleted has its own return res.json({ success: true }) before the outer one
    const deletedBlock = source.slice(source.indexOf('eventType === \'user.deleted\''));
    assert.ok(
        deletedBlock.includes('return res.json({ success: true })'),
        'user.deleted success path must explicitly return 200, not fall through to outer res.json'
    );
});

test('Clerk webhook replay cache prevents duplicate processing', () => {
    const source = readRoute();
    assert.match(source, /alreadyProcessed/,
        'webhook handler must check for already-processed events');
    assert.match(source, /duplicate:\s*true/,
        'duplicate events must return { success: true, duplicate: true }');
    assert.match(source, /CLERK_EVENT_TTL_SECONDS/,
        'replay cache must have a TTL');
});

test('Clerk webhook emits signup_completed for BOTH signup methods', () => {
    // signup_completed used to live only on the email/password branch of the
    // client form. The Google path leaves the page for Clerk's redirect, so it
    // never fired there: 18 people on signup_completed against 64 on
    // account_created over 30 days (PostHog, 2026-08-14). Emitting it from the
    // webhook — the one place that runs exactly once per real account, for every
    // method — is what makes the two counts agree.
    const source = readRoute();

    assert.match(source, /event_name: 'signup_completed'/,
        'the user.created webhook must emit signup_completed');

    const analyticsBlock = source.slice(source.indexOf('event_name: \'account_created\''));
    const completedIndex = analyticsBlock.indexOf('event_name: \'signup_completed\'');
    assert.ok(completedIndex > -1,
        'signup_completed must be emitted alongside account_created, from the same authoritative block');

    // Method has to ride on it, or the funnel cannot separate password from OAuth.
    const completedBlock = analyticsBlock.slice(completedIndex, completedIndex + 600);
    assert.match(completedBlock, /method: signupMethod/,
        'signup_completed must carry the signup method');
});

// The marketing form lives in apps/marketing, which only the private repo has.
test('the client PostHog signup_completed emitters stay removed', {
    skip: privateSkipReason('apps/marketing') || false,
}, () => {
    // Both would double-count the email path now that the webhook emits it.
    // Their GA4 / Ads / Reddit conversions are browser-only and must NOT be
    // removed — this asserts the PostHog emitters specifically.
    const marketingForm = fs.readFileSync(
        path.join(__dirname, '..', '..', '..', 'marketing', 'src', 'components', 'MarketingAuthForm.tsx'),
        'utf8'
    );
    assert.ok(
        !/trackGrowthEvent\(\s*'signup_completed'/.test(marketingForm),
        'marketing form must not emit signup_completed to PostHog (webhook owns it)'
    );
    assert.match(marketingForm, /gaEvent\('signup_completed'/,
        'the GA4 signup_completed must stay — it has no server counterpart');

    const clerkAuthPage = fs.readFileSync(
        path.join(__dirname, '..', '..', '..', 'dashboard', 'src', 'components', 'ClerkAuthPage.tsx'),
        'utf8'
    );
    assert.ok(
        !/trackProductEvent\(PRODUCT_EVENTS\.signupCompleted/.test(clerkAuthPage),
        'dashboard signup page must not emit signup_completed to PostHog (webhook owns it)'
    );
    assert.match(clerkAuthPage, /gaEvent\('signup_completed'/,
        'the GA4 signup_completed must stay — it has no server counterpart');
});
