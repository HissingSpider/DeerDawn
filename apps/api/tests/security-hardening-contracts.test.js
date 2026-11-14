const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { privateSkipReason } = require('./helpers/privatePaths');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

function readFromRepo(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function existsInRepo(relativePath) {
  return fs.existsSync(path.join(repoRoot, relativePath));
}

// `requires`: repo paths only the private repo has; reported as skipped where
// they are missing (the public export does not ship apps/marketing).
function test(name, fn, { requires = [] } = {}) {
  const skip = privateSkipReason(...requires);
  if (skip) {
    console.log(`- ${name} (skipped: ${skip})`);
    return;
  }
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    process.exitCode = 1;
  }
}

console.log('=== Security Hardening Contract Tests ===\n');

test('marketing should publish both security.txt endpoints', () => {
  assert(
    existsInRepo('apps/marketing/src/pages/security.txt.ts'),
    'apps/marketing/src/pages/security.txt.ts is missing'
  );
  assert(
    existsInRepo('apps/marketing/src/pages/.well-known/security.txt.ts'),
    'apps/marketing/src/pages/.well-known/security.txt.ts is missing'
  );
}, { requires: ['apps/marketing'] });

test('marketing security.txt should expose responsible disclosure fields', () => {
  const content = readFromRepo('apps/marketing/src/lib/securityTxt.ts');
  for (const required of [
    'Contact: mailto:security@deerdawn.com',
    'Canonical:',
    'Policy:',
    'Preferred-Languages: en',
  ]) {
    assert(content.includes(required), `security.txt is missing "${required}"`);
  }
}, { requires: ['apps/marketing'] });

test('dashboard should send HSTS for production traffic', () => {
  const nextConfig = readFromRepo('apps/dashboard/next.config.ts');
  assert(
    nextConfig.includes('Strict-Transport-Security'),
    'dashboard next.config.ts is missing Strict-Transport-Security'
  );
});

test('browser auth responses should rely on cookies instead of echoing JWTs', () => {
  const authRoutes = readFromRepo('apps/api/src/routes/shared/auth.js');
  assert(
    !authRoutes.includes('res.json({ token, user'),
    'login route still echoes JWTs in the response body'
  );
  assert(
    !authRoutes.includes('res.status(201).json({ token, user })'),
    'signup route still echoes JWTs in the response body'
  );
  assert(
    authRoutes.includes('setAuthCookies(req, res, token);'),
    'auth routes should still establish cookie sessions'
  );
});

test('API key creation should be privileged with an explicit scope allowlist', () => {
  const keyRoutes = readFromRepo('apps/api/src/routes/shared/keys.js');
  const schemas = readFromRepo('apps/api/src/schemas/index.js');

  // THIS ASSERTION WAS RELAXED IN SPELLING AND TIGHTENED IN SUBSTANCE. It used
  // to require the exact text `requireRole(['owner', 'admin'])`, which read as a
  // privilege gate and was not one: requireRole tests `users.role`, and every
  // self-provisioned account is created with 'owner' (routes/shared/auth.js,
  // routes/auth-webhooks.js). It admitted everybody. Worse, once the route began
  // resolving the BOUND workspace, it admitted everybody into workspaces they had
  // merely been invited to — a viewer could mint a credential carrying someone
  // else's team.
  //
  // What replaces it is two gates on two different axes, both of which have to
  // stay. Neither existed before, so this is strictly more than the line it
  // replaces — do not simplify either one away.
  assert(
    !keyRoutes.includes('requireRole('),
    'key routes must not gate on users.role: it is "owner" for every self-signup, so it is not a privilege check'
  );
  assert(
    /router\.post\('\/',\s*requireAnyScope\(\[[^\]]*'context:write'[^\]]*\]\)/.test(keyRoutes),
    'the CREDENTIAL axis: a context:read key must not be able to mint a writable one'
  );
  // The person axis is MEMBERSHIP, and the role sets the ceiling. It used to
  // require canWrite(), which refused a viewer any key at all and left
  // grantableScopes('viewer') dead (scan 11): a viewer reads the team's brief
  // through an agent, so a read-only key is exactly what their role grants.
  assert(
    keyRoutes.includes('resolveRole(') && keyRoutes.includes('getMembership('),
    'the PERSON axis: minting a key for a workspace must require membership IN that workspace'
  );
  assert(
    keyRoutes.includes('grantableScopes('),
    'a key must never carry scopes its creator does not hold, or it is a privilege ladder'
  );
  assert(
    !schemas.includes('scopes: z.array(z.string())'),
    'API key request schema must not accept arbitrary scope strings'
  );
  for (const scope of ['decisions:evaluate', 'context:read', 'context:write', 'context:admin']) {
    assert(schemas.includes(`'${scope}'`), `API key scope allowlist is missing ${scope}`);
  }
});

test('MCP device flow should not put the pickup secret in the dashboard URL', () => {
  const mcpAuth = readFromRepo('apps/api/src/routes/shared/mcp-auth.js');
  const dashboardPage = readFromRepo('apps/dashboard/src/pages/mcp-auth.tsx');
  const dashboardProxy = readFromRepo('apps/dashboard/src/pages/api/mcp-authorize.ts');
  assert(
    mcpAuth.includes('mcp:user:${userCode}') && mcpAuth.includes('verification_url: `${DASHBOARD_URL}/mcp-auth?code=${userCode}`'),
    'MCP start should expose only the user code in the browser verification URL'
  );
  assert(
    mcpAuth.includes('const MCP_API_KEY_SCOPES = [\'context:read\', \'context:write\']'),
    'MCP flow should issue least-privilege context API keys'
  );
  assert(!mcpAuth.includes('[\'*\']'), 'MCP flow must not issue wildcard-scoped API keys');
  assert(dashboardPage.includes('user_code: userCode'), 'dashboard auth page should submit a user code');
  assert(dashboardProxy.includes('user_code'), 'dashboard API proxy should forward a user code');
});

test('account deletion should fail closed and require context admin scope', () => {
  const contextRoutes = readFromRepo('apps/api/src/routes/context/context-sync.js');
  const accountDeletionRoute = contextRoutes.slice(contextRoutes.indexOf('router.delete(\'/account\''));
  assert(
    contextRoutes.includes('const requireContextAdmin = requireAnyScope([\'context:admin\'])'),
    'context routes should define an admin-only scope guard'
  );
  assert(
    contextRoutes.includes('router.delete(\'/account\', requireContextAdmin'),
    'account deletion should require context:admin'
  );
  assert(
    !accountDeletionRoute.includes('.catch(() => {})'),
    'account deletion must not swallow table deletion failures'
  );
  assert(
    !contextRoutes.includes('process.env.JWT_SECRET || \'deerdawn\''),
    'account deletion confirmation must not use a weak fallback HMAC key'
  );
  assert(
    contextRoutes.includes('confirmation !== \'DELETE MY DEERDAWN ACCOUNT\''),
    'account deletion must require an exact destructive confirmation phrase'
  );
  assert(
    // workspaceOnly (scan 24): this route empties a workspace and keeps the
    // person, so it does not reach into the other workspaces they belong to.
    /purgeOwnerData\(ownerKey, \{\s*strict: true,\s*workspaceOnly: true,/.test(contextRoutes),
    'account deletion must fail closed on partial owner-data erasure'
  );
});

test('MCP and OAuth production routes should fail closed without HTTPS', () => {
  // The guard lives in middleware/transportGuard.js and is mounted in app.js.
  const appSource = readFromRepo('apps/api/src/app.js');
  assert(appSource.includes('app.use(transportGuard);'), 'app.js must mount the HTTPS guard');
  const guardSource = readFromRepo('apps/api/src/middleware/transportGuard.js');
  assert(guardSource.includes('error: \'https_required\''), 'protected routes should return a stable HTTPS-required error');
  for (const route of ['req.path === MCP_RESOURCE_PATH', 'req.path === CLAUDE_MCP_RESOURCE_PATH', 'req.path.startsWith(\'/api/v1/oauth/\')', 'req.path.startsWith(\'/.well-known/oauth-\')']) {
    assert(guardSource.includes(route), `HTTPS guard is missing ${route}`);
  }
});

test('OAuth refresh grants should use one-way lookup keys', () => {
  const oauthSource = readFromRepo('apps/api/src/routes/oauth.js');
  assert(oauthSource.includes('crypto.createHash(\'sha256\').update(String(token)).digest(\'hex\')'));
  assert(oauthSource.includes('refreshTokenKey(refreshToken)'));
  assert(!oauthSource.includes('`oauth:refresh:${refreshToken}`'), 'plaintext refresh token must not be a Redis key');
});

test('production boot should require context credential encryption key', () => {
  const envSource = readFromRepo('apps/api/src/config/env.js');
  assert(envSource.includes('\'ENCRYPTION_MASTER_KEY\''), 'production env validation should require ENCRYPTION_MASTER_KEY');
  assert(envSource.includes('/^[a-f0-9]{64}$/i.test(process.env.ENCRYPTION_MASTER_KEY)'), 'ENCRYPTION_MASTER_KEY should be validated as 64 hex characters');
});

test('MCP auth endpoints should have a dedicated rate limiter', () => {
  const appSource = readFromRepo('apps/api/src/app.js');
  const limiterSource = readFromRepo('apps/api/src/middleware/rateLimit.js');
  assert(limiterSource.includes('const mcpAuthLimiter = rateLimit'), 'mcpAuthLimiter should be defined');
  // The mount is no longer one blanket limiter: the device-code poll endpoint
  // is SUPPOSED to be hit hundreds of times per sign-in and has its own budget
  // (middleware/rateLimit.js), while /start and /authorize keep the tight one.
  // What this still pins is that nothing under the prefix is unlimited.
  assert(appSource.includes('app.use(\'/api/v1/auth/mcp\', ('), 'MCP auth route should be rate limited');
  assert(appSource.includes('mcpDevicePollLimiter(req, res, next)'), 'the device-code poll should have its own limiter');
  assert(appSource.includes('mcpAuthLimiter(req, res, next)'), 'everything else under /api/v1/auth/mcp keeps the tight limiter');
  assert(limiterSource.includes('const mcpDevicePollLimiter ='), 'mcpDevicePollLimiter should be defined');
});

if (process.exitCode) {
  console.error('\nSecurity hardening regressions detected.');
} else {
  console.log('\nSecurity hardening contracts in place.');
}
