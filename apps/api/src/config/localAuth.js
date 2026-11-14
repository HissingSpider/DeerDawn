'use strict';

// IS THE NATIVE EMAIL/PASSWORD PATH SWITCHED ON?
//
// The rule, in one place: local credentials are on unless Clerk is the
// authoritative provider, and even then only when the local-token fallback has
// been explicitly re-enabled. That is exactly the condition under which a
// locally-issued session can authenticate at all (AuthAdapter.verifySession),
// so the credential routes are reachable precisely when the tokens they mint
// would work.
//
//   AUTH_PROVIDER unset / 'local'                 -> on   (local dev, tests, self-host)
//   AUTH_PROVIDER=clerk                           -> OFF  (production; env.js requires it)
//   AUTH_PROVIDER=clerk + ALLOW_LOCAL_JWT_FALLBACK -> on   (explicit opt-in; env.js
//                                                           refuses it in production)
//
// Why it matters: the routes were mounted unguarded in production, and
// POST /auth/signup takes any email without verifying it. That minted a users
// row, a workspace named by the caller, a referral attribution and a
// password_hash for somebody else's address — which the real owner's first
// Clerk sign-in then ADOPTED (syncUser's provider-migration branch). It also
// answered 409 user_exists for any registered address. Read at request time,
// not load time, so a test can flip it.
function localAuthEnabled(env = process.env) {
    return env.AUTH_PROVIDER !== 'clerk' || env.ALLOW_LOCAL_JWT_FALLBACK === 'true';
}

// Express guard: a 404 indistinguishable from an unmounted route, so a
// clerk-only deployment neither serves the path nor confirms it exists.
function requireLocalAuth(req, res, next) {
    if (localAuthEnabled()) return next();
    return res.status(404).json({ error: 'not_found' });
}

module.exports = { localAuthEnabled, requireLocalAuth };
