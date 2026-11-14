'use strict';

// SELF-HOSTED MODE: ONE SWITCH, READ IN ONE PLACE.
//
// DeerDawn is open source (AGPL-3.0). Anyone may run it with nothing but Postgres, Redis
// and an LLM key, and a self-hosted install has EVERYTHING unlocked: teams,
// seats, history, skills. The hosted service at deerdawn.com is the paid one.
//
//   SELF_HOSTED=true       self-hosted mode. Every workspace resolves to full
//                          entitlements, plan enforcement never refuses on billing
//                          grounds, the billing routes answer 404 billing_disabled,
//                          and none of the hosted vendors (Clerk, Stripe, PostHog,
//                          Resend, Fly) are required.
//   TELEMETRY_ENABLED=true product analytics (PostHog, ad conversions) are OFF on
//                          a self-hosted install unless this is set. On hosted
//                          (SELF_HOSTED unset) analytics behave exactly as before.
//   SIGNUP_MODE            open | invite_only. Self-hosted default: invite_only,
//                          which lets the FIRST account sign up (it becomes the
//                          owner) and requires an invitation for every later one.
//   SOURCE_CODE_URL        where the running version's source lives (AGPL-3.0
//                          section 13). Default: the upstream repository. Set it
//                          to your fork if you run a modified version.
//   PUBLIC_URL             the public origin of a self-hosted install. Used for the
//                          links the API builds (invites, password resets, OAuth
//                          redirects, MCP config) when DASHBOARD_URL / API_BASE_URL
//                          are not set individually.
//
// Every function takes `env` so a test can drive it without touching
// process.env, and reads it per call so a test that flips process.env after
// require sees the new value.

function flag(value) {
    return String(value == null ? '' : value).trim().toLowerCase() === 'true';
}

function isSelfHosted(env = process.env) {
    return flag(env.SELF_HOSTED);
}

/**
 * Product analytics (PostHog, ad-platform conversions). Hosted: unchanged —
 * each integration is still gated on its own key. Self-hosted: off unless the
 * operator opts in with TELEMETRY_ENABLED=true.
 */
function isTelemetryEnabled(env = process.env) {
    if (!isSelfHosted(env)) return true;
    return flag(env.TELEMETRY_ENABLED);
}

/** Billing (Stripe checkout, portal, webhooks, plan changes) exists only on hosted. */
function isBillingEnabled(env = process.env) {
    return !isSelfHosted(env);
}

const SIGNUP_MODES = ['open', 'invite_only'];

/**
 * Who may create a local email/password account.
 *
 *   open         anyone who can reach the signup route.
 *   invite_only  the first account on the install, then only somebody holding
 *                a pending, unexpired workspace invitation for that email.
 *
 * Default: invite_only when self-hosted (POST /auth/signup takes an email it
 * never verifies — see config/localAuth.js — so an open signup on a public
 * self-host lets anyone in), open otherwise (local dev and the test suites,
 * unchanged). An unrecognised value falls back to the default rather than to
 * open: a typo must not unlock the door.
 */
function signupMode(env = process.env) {
    const raw = String(env.SIGNUP_MODE || '').trim().toLowerCase();
    if (SIGNUP_MODES.includes(raw)) return raw;
    return isSelfHosted(env) ? 'invite_only' : 'open';
}

function trimUrl(value) {
    const s = String(value || '').trim();
    return s ? s.replace(/\/+$/, '') : '';
}

/**
 * PUBLIC_URL, only on a self-hosted install. Hosted never reads it, so a stray
 * value in a hosted environment cannot redirect a production link.
 */
function selfHostedPublicUrl(env = process.env) {
    return isSelfHosted(env) ? trimUrl(env.PUBLIC_URL) : '';
}

/** Where the dashboard is served. Links in emails, OAuth redirects. */
function dashboardBaseUrl(env = process.env, hostedDefault = 'https://app.deerdawn.com') {
    return trimUrl(env.DASHBOARD_URL)
        || selfHostedPublicUrl(env)
        || (isSelfHosted(env) ? 'http://localhost:3000' : hostedDefault);
}

/**
 * Where the API is reachable from the outside (OAuth issuer, MCP URL handed to
 * clients). A self-host without API_BASE_URL is assumed to put the API behind
 * the same origin as the dashboard (PUBLIC_URL); with neither, the caller should
 * fall back to the request's own host, which is what oauth.js already does.
 */
function apiBaseUrl(env = process.env, hostedDefault = 'https://api.deerdawn.com') {
    return trimUrl(env.API_BASE_URL)
        || selfHostedPublicUrl(env)
        || (isSelfHosted(env) ? '' : hostedDefault);
}

/** Marketing site. A self-host has none, so it points at its own dashboard. */
function marketingBaseUrl(env = process.env, hostedDefault = 'https://deerdawn.com') {
    return trimUrl(env.MARKETING_URL)
        || (isSelfHosted(env) ? dashboardBaseUrl(env) : hostedDefault);
}

const DEFAULT_SOURCE_CODE_URL = 'https://github.com/HissingSpider/DeerDawn';

/**
 * Where the source code of the RUNNING version can be had. The server is
 * AGPL-3.0: section 13 says that if you modify it and let people use it over a
 * network, you must offer those users the corresponding source. The dashboard
 * shows this as a "Source code" link, so an operator of a modified fork only has
 * to set SOURCE_CODE_URL to that fork. Only an absolute http(s) URL is accepted
 * (it is rendered as a link; a javascript: URL must never get there); anything
 * else falls back to the upstream repository.
 */
function sourceCodeUrl(env = process.env) {
    const raw = String(env.SOURCE_CODE_URL || '').trim();
    if (!raw) return DEFAULT_SOURCE_CODE_URL;
    try {
        const url = new URL(raw);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return DEFAULT_SOURCE_CODE_URL;
        return raw;
    } catch {
        return DEFAULT_SOURCE_CODE_URL;
    }
}

/**
 * What the dashboard needs to know about this deployment. Public: it is read
 * before sign-in (the login page needs signup_mode) and it names no secret.
 */
function deploymentInfo(env = process.env) {
    const selfHosted = isSelfHosted(env);
    return {
        self_hosted: selfHosted,
        billing_enabled: isBillingEnabled(env),
        telemetry_enabled: isTelemetryEnabled(env),
        signup_mode: signupMode(env),
        auth_provider: env.AUTH_PROVIDER === 'clerk' ? 'clerk' : 'local',
        source_code_url: sourceCodeUrl(env),
    };
}

/**
 * Full entitlements for a self-hosted workspace, derived from the plan catalog
 * rather than written into it (config/plans.js is the hosted price list):
 * every feature any plan grants is on, and every limit any plan declares is
 * null — the "uncapped" sentinel that checkLimit, checkEnforcement, the project
 * cap and applyHistoryWindow all read as unlimited.
 *
 * `tier` is the highest self-serve plan id so code that compares plan ORDER
 * (command capture: getPlanOrder(tier) >= developer_basic) treats it as paid.
 */
const SELF_HOSTED_TIER = 'developer_pro';

function selfHostedEntitlements() {
    const { PLANS } = require('./plans');
    const features = {};
    const limits = {};
    for (const plan of Object.values(PLANS)) {
        for (const key of Object.keys(plan.features || {})) features[key] = true;
        for (const key of Object.keys(plan.limits || {})) limits[key] = null;
    }
    return {
        tier: SELF_HOSTED_TIER,
        limits,
        features,
        self_hosted: true,
        referral_premium_active: false,
        referral_reward_tier: null,
        referral_premium_until: null,
    };
}

/**
 * One line per hosted vendor, at boot, saying it is off. Never one per
 * request: a self-hoster running without Stripe is not an error, and a log
 * full of warnings about it would hide the real ones.
 */
function describeVendors(env = process.env) {
    const selfHosted = isSelfHosted(env);
    const telemetry = isTelemetryEnabled(env);
    const lines = [];
    const off = (name, why) => lines.push(`[BOOT] ${name} disabled: ${why}`);

    if (env.AUTH_PROVIDER !== 'clerk') off('Clerk', 'using local email/password auth (AUTH_PROVIDER is not clerk)');
    if (selfHosted) off('Stripe billing', 'self-hosted mode, every workspace has full entitlements');
    else if (!env.STRIPE_SECRET_KEY) off('Stripe billing', 'STRIPE_SECRET_KEY not set');
    if (!telemetry) off('PostHog and ad conversions', 'self-hosted mode (set TELEMETRY_ENABLED=true to opt in)');
    else if (!env.POSTHOG_API_KEY) off('PostHog', 'POSTHOG_API_KEY not set');
    if (!env.RESEND_API_KEY) {
        off('Resend email', selfHosted
            ? 'RESEND_API_KEY not set; invitation and password-reset links will be written to this log'
            : 'RESEND_API_KEY not set');
    }
    if (!env.FLY_ALLOC_ID && !env.FLY_MACHINE_ID) off('Fly.io integration', 'not running on Fly (no FLY_* env)');
    if (selfHosted) {
        lines.push(`[BOOT] Self-hosted mode: signup_mode=${signupMode(env)}, public URL=${selfHostedPublicUrl(env) || '(PUBLIC_URL not set)'}`);
    }
    return lines;
}

/**
 * Express guard for billing surfaces. On a self-host they answer as if they
 * were not there, with a reason a client can act on (hide the billing UI)
 * rather than a bare not_found that reads like a broken deploy.
 */
function requireBillingEnabled(req, res, next) {
    if (isBillingEnabled()) return next();
    return res.status(404).json({
        error: 'billing_disabled',
        message: 'Billing is disabled on this self-hosted DeerDawn install. Every workspace already has every feature.',
    });
}

// ── Plain HTTP on a self-hosted install ──────────────────────────────────────
//
// With NODE_ENV=production the API sets Secure cookies and refuses MCP/OAuth
// over plain HTTP (https_required). The self-host quickstart serves
// http://localhost:3000, so a self-hosted install accepts plain HTTP when the
// request is addressed to this machine: browsers treat localhost as a secure
// context, and nothing crosses a network. Any other host over plain HTTP is
// refused with a message telling the operator how to get HTTPS, because the
// browser would drop the Secure session cookie (sign-in that silently does not
// stick) and MCP clients would send bearer tokens in the clear.
//
// "HTTPS" is the transport Express sees (req.secure, which honours
// X-Forwarded-Proto from the trusted proxy hop) or an x-forwarded-proto of
// https, as the existing MCP check has always read it, or a PUBLIC_URL that is
// https:// (the operator terminates TLS in front of the bundled Caddy, which
// then forwards plain HTTP). The host is req.hostname, which honours
// X-Forwarded-Host from the trusted hop (Caddy sets it and replaces a client's).
// Hosted never reaches any of this: every function returns null unless
// SELF_HOSTED=true.

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

function isLocalHostname(hostname) {
    const h = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    return LOCAL_HOSTNAMES.has(h) || h.endsWith('.localhost');
}

function requestIsHttps(req) {
    const forwardedProto = String((req.headers && req.headers['x-forwarded-proto']) || '')
        .split(',')[0].trim().toLowerCase();
    return Boolean(req.secure) || forwardedProto === 'https';
}

/**
 * How a self-hosted install treats this request's transport:
 *   null      not self-hosted, or HTTPS (nothing changes)
 *   'local'   plain HTTP addressed to localhost / 127.0.0.1 / ::1: accepted
 *   'remote'  plain HTTP to any other host: refused (see selfHostedHttpsRefusal)
 */
function selfHostedPlainHttp(req, env = process.env) {
    if (!isSelfHosted(env)) return null;
    if (requestIsHttps(req)) return null;
    if (/^https:\/\//i.test(selfHostedPublicUrl(env))) return null;
    return isLocalHostname(req.hostname) ? 'local' : 'remote';
}

/** The 400 body for plain HTTP to a non-local host on a self-hosted install. */
function selfHostedHttpsRefusal(req) {
    const host = String(req.hostname || 'this host');
    return {
        error: 'https_required',
        message: `This self-hosted DeerDawn was reached over plain HTTP at ${host}. Plain HTTP is accepted only on localhost. `
            + 'Give the install a domain for automatic HTTPS: run scripts/selfhost/init.sh --domain <your-domain> on a fresh install, '
            + 'or set DEERDAWN_DOMAIN=<your-domain>, DEERDAWN_PUBLIC_URL=https://<your-domain> and '
            + 'COMPOSE_FILE=docker-compose.yml:infra/selfhost/docker-compose.https.yml in .env, then docker compose up -d. '
            + 'If TLS already ends at your own proxy, set DEERDAWN_PUBLIC_URL to its https:// address. See docs/self-hosting.md.',
    };
}

/**
 * Whether the session cookies are Secure. Production: yes, except a
 * self-hosted install reached over plain HTTP at localhost, where Chrome and
 * Firefox would accept a Secure cookie and Safari would not (the sign-in would
 * silently not stick). Unchanged everywhere else.
 */
function sessionCookieSecure(req, env = process.env) {
    if (req.secure) return true;
    return env.NODE_ENV === 'production' && selfHostedPlainHttp(req, env) !== 'local';
}

let vendorsLogged = false;
function logVendorStatusOnce(log = console.log, env = process.env) {
    if (vendorsLogged) return;
    vendorsLogged = true;
    for (const line of describeVendors(env)) log(line);
}

module.exports = {
    SIGNUP_MODES,
    SELF_HOSTED_TIER,
    isSelfHosted,
    isTelemetryEnabled,
    isBillingEnabled,
    signupMode,
    selfHostedPublicUrl,
    dashboardBaseUrl,
    apiBaseUrl,
    marketingBaseUrl,
    deploymentInfo,
    sourceCodeUrl,
    DEFAULT_SOURCE_CODE_URL,
    selfHostedEntitlements,
    describeVendors,
    logVendorStatusOnce,
    requireBillingEnabled,
    isLocalHostname,
    selfHostedPlainHttp,
    selfHostedHttpsRefusal,
    sessionCookieSecure,
};
