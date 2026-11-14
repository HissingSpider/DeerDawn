/**
 * originGuard — "this call came from one of our own pages".
 *
 * It fronts the unauthenticated, model-backed public tools (context preview, AI
 * brief, repo brief, brief stash). They cost money per call and have no caller
 * identity to bill or ban, so the only thing standing between them and a script
 * is (a) the rate limiters and (b) the fact that a browser cannot forge Origin
 * or Referer cross-site.
 *
 * WHAT WAS WRONG: the allowlist itself was real, but it was bypassed wholesale
 * whenever NODE_ENV was anything other than 'production' —
 *
 *     if (process.env.NODE_ENV !== 'production') return next();
 *
 * — which is the behaviour "accepts any Origin" describes. Production sets
 * NODE_ENV, so the guard did hold there; every other environment (staging, a
 * review box, any container that forgot the variable) accepted every origin,
 * and a guard that is off wherever it is easiest to reach is decorative where
 * it matters. The list was also hard-coded to the two marketing hosts, so
 * MARKETING_URL / DASHBOARD_URL deployments were refused by their own API, and
 * matching was case- and trailing-slash-sensitive against a header nothing
 * normalises.
 *
 * Now: one allowlist, enforced in every environment, built from the app's own
 * origins. Localhost is on the list only outside production, so local
 * development works without the guard ever being switched off.
 *
 * Deliberately NOT here: the MCP client origins (claude.ai, chatgpt.com) that
 * app.js's CORS config allows. Those are allowed to talk to the MCP endpoints
 * with a credential; they are not our pages and have no business spending our
 * OpenAI budget.
 */

const normalizeOrigin = (value) => (typeof value === 'string' ? value.trim().toLowerCase().replace(/\/$/, '') : '');

const PRODUCTION_ORIGINS = [
  'https://deerdawn.com',
  'https://www.deerdawn.com',
  'https://app.deerdawn.com',
];

const LOCAL_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://localhost:3003',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:3002',
  'http://127.0.0.1:3003',
];

/**
 * Built per call rather than at module load: the tests, and any process that
 * sets env after require (autoMigrate, a worker), would otherwise be judged
 * against a snapshot taken before their configuration existed.
 */
function buildOriginAllowlist(env = process.env) {
  const origins = [
    env.MARKETING_URL,
    env.DASHBOARD_URL,
    // A self-hosted install's own origin ('' on hosted).
    require('../config/selfHosted').selfHostedPublicUrl(env),
    ...PRODUCTION_ORIGINS,
    ...(env.PUBLIC_TOOL_ORIGINS || '').split(','),
    ...(env.NODE_ENV === 'production' ? [] : LOCAL_ORIGINS),
  ]
    .map(normalizeOrigin)
    .filter(Boolean);
  return new Set(origins);
}

/** The origin a request claims, from Origin first and Referer as the fallback. */
function claimedOrigins(req) {
  const out = [];
  const origin = normalizeOrigin(req.headers?.origin);
  if (origin) out.push(origin);
  try {
    const refOrigin = normalizeOrigin(new URL(req.headers?.referer || '').origin);
    if (refOrigin) out.push(refOrigin);
  } catch { /* invalid or missing referer */ }
  return out;
}

function isAllowedOrigin(req, env = process.env) {
  const allowlist = buildOriginAllowlist(env);
  const claimed = claimedOrigins(req);
  // No Origin and no Referer is a non-browser caller: curl, a script, a bot.
  // These endpoints exist for our own pages, so an unattributable call is
  // refused rather than waved through.
  if (claimed.length === 0) return false;
  return claimed.some((candidate) => allowlist.has(candidate));
}

function originGuard(req, res, next) {
  if (!isAllowedOrigin(req)) {
    return res.status(403).json({ error: 'forbidden', message: 'This endpoint is only callable from DeerDawn.' });
  }
  return next();
}

module.exports = { originGuard, isAllowedOrigin, buildOriginAllowlist, normalizeOrigin };
