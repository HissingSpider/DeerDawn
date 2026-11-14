const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const svc = require('../../src/services/email/activationFollowUp');

/**
 * Lifecycle emails must link to LIVE dashboard routes.
 *
 * The failure this guards against, measured on production 2026-08-27:
 *
 *   GET /settings/tools?dd_email=x&utm_source=y
 *     -> /login?redirect_url=%2Fsetup                       (query destroyed)
 *   GET /setup?dd_email=x&utm_source=y
 *     -> /login?redirect_url=%2Fsetup%3Fdd_email%3Dx%26...   (query intact)
 *
 * The redesign renamed /settings/tools to /setup and kept the old URL alive with
 * a next.config redirect. That redirect drops the query string, so the un-connected
 * activation follow-up — the only lifecycle email we send to people who signed up
 * and never connected — arrived with dd_email and all four utm_* stripped.
 * lifecycle_email_clicked consequently never fired: 44 sent, 31 delivered, 0
 * clicks in the 30 days to 2026-08-27. The click emitter was fine; the link was not.
 *
 * A route that only works through a redirect is therefore not an acceptable CTA
 * target, even though it "works" when you click it yourself.
 */

const DASHBOARD_NEXT_CONFIG = path.join(
    __dirname, '..', '..', '..', 'dashboard', 'next.config.ts',
);

const CTA_PATHS = Object.values(svc.LIFECYCLE_CTA_PATHS).filter(Boolean);

test('lifecycle CTA paths are the post-redesign routes', () => {
    assert.equal(svc.LIFECYCLE_CTA_PATH_UNCONNECTED, '/setup');
    // Connected and authorized accounts get no dashboard link: /onboarding is a
    // connect-first flow, and so is every other page an empty account lands on.
    assert.deepEqual({ ...svc.LIFECYCLE_CTA_PATHS }, { unconnected: '/setup', authorized: null, connected: null });
});

test('follow-up CTA URLs carry the attribution params on a non-redirected path', () => {
    for (const saved of [true, false]) {
        const url = new URL(svc.followUpCtaUrl('https://app.deerdawn.com', false, saved));
        const expectedType = svc.emailTypeFor(false, saved);
        assert.ok(CTA_PATHS.includes(url.pathname), `${url.pathname} is a declared CTA path`);
        assert.equal(url.searchParams.get('dd_email'), expectedType);
        assert.equal(url.searchParams.get('utm_source'), 'lifecycle_email');
        assert.equal(url.searchParams.get('utm_medium'), 'email');
        assert.equal(url.searchParams.get('utm_campaign'), expectedType);
    }
});

test('no lifecycle CTA path is a redirect source in the dashboard config', (t) => {
    let config;
    try {
        config = fs.readFileSync(DASHBOARD_NEXT_CONFIG, 'utf8');
    } catch (err) {
        // Partial checkout (apps/api alone) — skip rather than fail. The two
        // assertions above still pin the paths; this one adds the cross-app half.
        t.skip(`dashboard next.config.ts unreadable: ${err.message}`);
        return;
    }

    // Every `source: "..."` in the redirects() table. A CTA path appearing here
    // means the link only resolves through a redirect, which strips the query.
    const sources = [...config.matchAll(/source:\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
    assert.ok(sources.length > 0, 'found redirect sources to check against');

    for (const cta of CTA_PATHS) {
        assert.ok(
            !sources.includes(cta),
            `${cta} is a next.config redirect source — the redirect drops the query string, `
            + 'so dd_email/utm_* would never reach the page. Link the destination directly.',
        );
    }
});

test('no email template still links the legacy /settings/tools URL', () => {
    const emailDir = path.join(__dirname, '..', '..', 'src', 'services', 'email');
    const offenders = [];
    for (const file of fs.readdirSync(emailDir)) {
        if (!file.endsWith('.js')) continue;
        const body = fs.readFileSync(path.join(emailDir, file), 'utf8');
        // Only href targets, so the explanatory comments above may keep naming it.
        if (/href="[^"]*\/settings\/tools/.test(body)) offenders.push(file);
    }
    assert.deepEqual(offenders, [], 'email templates linking the redirected /settings/tools');
});
