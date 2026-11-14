/**
 * Security Regression Tests
 *
 * These tests verify that critical security controls are in place
 * and functioning correctly.
 */

const assert = require('assert');

// Test modules
const { redact, DEFAULT_SENSITIVE_KEYS } = require('../src/utils/redact');

console.log('=== Security Regression Tests ===\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`✓ ${name}`);
        passed++;
    } catch (err) {
        console.log(`✗ ${name}`);
        console.log(`  Error: ${err.message}`);
        failed++;
    }
}

// --- Rate Limit Bypass Tests ---
console.log('\n--- Rate Limit Bypass ---');

test('Hard-coded bypass key should not be in rate limiter', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/middleware/rateLimit'),
        'utf8'
    );
    assert(!source.includes('dd_speed_test_key_999'),
        'Hard-coded bypass key found in rate limiter source');
});

test('Rate limit skip should require non-production env', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/middleware/rateLimit'),
        'utf8'
    );
    assert(source.includes('NODE_ENV !== \'production\''),
        'Rate limit bypass should check for non-production environment');
});

// --- Authentication Security Tests ---
console.log('\n--- Authentication Security ---');

test('System key actor should have scopes array', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/middleware/auth'),
        'utf8'
    );
    // Check that system key actor includes scopes: ['*']
    assert(source.includes('scopes: [\'*\']'),
        'System key actor should have scopes array with wildcard');
});

test('API key comparison should use secure compare', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/middleware/auth'),
        'utf8'
    );
    assert(source.includes('secureCompare') || source.includes('timingSafeEqual'),
        'API key should use timing-safe comparison');
});

test('crypto module should be imported for timing-safe comparison', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/middleware/auth'),
        'utf8'
    );
    assert(source.includes('require(\'crypto\')'),
        'crypto module should be imported for secure comparison');
});

test('Auth middleware should fail closed on missing org context', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/middleware/auth'),
        'utf8'
    );
    assert(source.includes('User is missing organization context'),
        'Missing org context should be rejected instead of auto-repaired');
    assert(!source.includes('Repairing missing org context'),
        'Auth middleware should not synthesize organization context');
});

// --- CSP and Security Headers Tests ---
console.log('\n--- Security Headers ---');

test('CSP should not allow unsafe-inline for scripts', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/app'),
        'utf8'
    );
    // Check scriptSrc doesn't have unsafe-inline
    const scriptSrcMatch = source.match(/scriptSrc:\s*\[(.*?)\]/s);
    if (scriptSrcMatch) {
        assert(!scriptSrcMatch[1].includes('unsafe-inline'),
            'CSP scriptSrc should not include unsafe-inline');
    }
});

test('HSTS should be configured', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/app'),
        'utf8'
    );
    assert(source.includes('hsts:'), 'HSTS configuration should be present');
    assert(source.includes('maxAge'), 'HSTS should have maxAge setting');
});

test('Metrics endpoint should have protection', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/app'),
        'utf8'
    );
    assert(source.includes('METRICS_TOKEN') || source.includes('METRICS_ALLOWED_IPS'),
        'Metrics endpoint should have token or IP protection');
});

test('Entitlements should not trust requested plan fields', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/services/entitlementService'),
        'utf8'
    );
    assert(!source.includes('org?.plan_tier || org?.plan'),
        'Entitlements should resolve from effective plan_tier, not requested plan');
});

test('Auto-migration should provision pending plan storage', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/config/autoMigrate'),
        'utf8'
    );
    assert(source.includes('pending_plan'),
        'Organizations should include pending_plan for pre-checkout selections');
});

// --- Redaction Tests ---
console.log('\n--- Data Redaction ---');

test('DEFAULT_SENSITIVE_KEYS should include common PII fields', () => {
    assert(DEFAULT_SENSITIVE_KEYS.includes('password'), 'Should include password');
    assert(DEFAULT_SENSITIVE_KEYS.includes('ssn'), 'Should include ssn');
    assert(DEFAULT_SENSITIVE_KEYS.includes('credit_card'), 'Should include credit_card');
    assert(DEFAULT_SENSITIVE_KEYS.includes('api_key'), 'Should include api_key');
    assert(DEFAULT_SENSITIVE_KEYS.includes('token'), 'Should include token');
});

test('Redact function should redact sensitive keys in strict mode', () => {
    const input = { username: 'test', password: 'secret123', email: 'test@example.com' };
    const result = redact(input, ['username', 'email'], 'strict');
    assert.strictEqual(result.password, '[REDACTED]', 'password should be redacted');
    assert.strictEqual(result.username, 'test', 'username should be preserved');
});

test('Redact function should handle nested objects', () => {
    const input = { user: { name: 'test', password: 'secret' } };
    const result = redact(input, ['name'], 'strict');
    assert.strictEqual(result.user.password, '[REDACTED]', 'nested password should be redacted');
});


// --- Graceful Shutdown Tests ---
console.log('\n--- Graceful Shutdown ---');

test('Server should have SIGTERM handler', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/server'),
        'utf8'
    );
    assert(source.includes('SIGTERM'), 'SIGTERM handler should be present');
    assert(source.includes('SIGINT'), 'SIGINT handler should be present');
});

test('Server should have gracefulShutdown function', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/server'),
        'utf8'
    );
    assert(source.includes('gracefulShutdown'), 'gracefulShutdown function should exist');
});

// --- Distributed Locking Tests ---
console.log('\n--- Distributed Job Locking ---');

test('Scheduler should have distributed locking', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/jobs/scheduler'),
        'utf8'
    );
    assert(source.includes('acquireLock'), 'acquireLock function should exist');
    assert(source.includes('releaseLock'), 'releaseLock function should exist');
});

test('Scheduler should export stopScheduler', () => {
    const scheduler = require('../src/jobs/scheduler');
    assert(typeof scheduler.stopScheduler === 'function', 'stopScheduler should be exported');
});

// --- Error Handler Tests ---
console.log('\n--- Error Handler ---');

test('Error handler should have request_id in responses', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/middleware/errorHandler'),
        'utf8'
    );
    assert(source.includes('request_id'), 'Error responses should include request_id');
});

test('Error handler should handle ZodError', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/middleware/errorHandler'),
        'utf8'
    );
    assert(source.includes('ZodError'), 'Error handler should handle ZodError');
});

test('Error handler should handle circuit breaker open', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/middleware/errorHandler'),
        'utf8'
    );
    assert(source.includes('Breaker is open'), 'Error handler should handle circuit breaker');
});

// --- Audit Logger Tests ---
console.log('\n--- Resilient Audit Logging ---');

test('Audit logger should have Redis fallback', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/utils/auditLogger'),
        'utf8'
    );
    assert(source.includes('AUDIT_BACKUP_KEY'), 'Audit logger should have backup key');
    assert(source.includes('flushBackupAuditLogs'), 'Audit logger should have recovery function');
});

// --- NEW: Security Remediation Tests ---
console.log('\n--- CORS Security ---');

test('CORS should not bypass based on NODE_ENV', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/app'),
        'utf8'
    );
    // Check that CORS doesn't use NODE_ENV !== 'production' as bypass
    const corsMatch = source.match(/origin:[\s\S]*?credentials:/);
    if (corsMatch) {
        assert(!corsMatch[0].includes('NODE_ENV !== \'production\''),
            'CORS should not bypass based on NODE_ENV');
    }
});

test('CORS should use ALLOW_LOCALHOST env var for development', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/app'),
        'utf8'
    );
    assert(source.includes('ALLOW_LOCALHOST'),
        'CORS should use ALLOW_LOCALHOST for explicit localhost access');
});


console.log('\n--- Database Connection Pool ---');

test('Database pool should have idle timeout configured', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/config/db'),
        'utf8'
    );
    assert(source.includes('idleTimeoutMillis'),
        'Database pool should have idleTimeoutMillis configured');
    assert(!source.includes('idleTimeoutMillis: 0'),
        'idleTimeoutMillis should not be 0 (disabled)');
});

test('Database pool should have max lifetime configured', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/config/db'),
        'utf8'
    );
    assert(source.includes('maxLifetimeMillis'),
        'Database pool should have maxLifetimeMillis for connection rotation');
});

console.log('\n--- SQL Injection Prevention ---');

test('Database should validate org_id format', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/config/db'),
        'utf8'
    );
    assert(source.includes('ORG_ID_PATTERN'),
        'Database should have org_id validation pattern');
    assert(source.includes('test(orgId)'),
        'Database should validate org_id against pattern');
});

test('Database should use parameterized queries for org context', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/config/db'),
        'utf8'
    );
    const usesSetConfig = source.includes('set_config')
        && source.includes('app.current_org_id')
        && source.includes('$1')
        && source.includes('true');
    const usesSetLocal = source.includes('SET LOCAL app.current_org_id = $1');
    assert(usesSetConfig || usesSetLocal,
        'Database should set org context using a parameterized SQL statement');
    assert(source.includes('[orgId]'),
        'Database org context statement should pass orgId as a bound parameter');
    assert(!source.includes('escapeLiteral(orgId)'),
        'Database should not use string interpolation with escapeLiteral');
});

console.log('\n--- Rate Limiting Security ---');

test('Rate limiter should validate IP format', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/middleware/rateLimit'),
        'utf8'
    );
    assert(source.includes('getClientIp'),
        'Rate limiter should have IP validation function');
    assert(source.includes('ipv4Pattern') || source.includes('ipv6Pattern'),
        'Rate limiter should validate IP format');
});

test('App should configure trust proxy from env var', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/app'),
        'utf8'
    );
    assert(source.includes('TRUST_PROXY_HOPS'),
        'App should read trust proxy configuration from env var');
});

console.log('\n--- JWT Security ---');

test('JWT verification should always enforce algorithm', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/utils/security'),
        'utf8'
    );
    const verifyTokenMatch = source.match(/const verifyToken[\s\S]*?};/);
    if (verifyTokenMatch) {
        assert(verifyTokenMatch[0].includes('algorithms:'),
            'JWT verification should specify algorithms');
        assert(verifyTokenMatch[0].includes('HS256'),
            'JWT verification should enforce HS256 algorithm');
    }
});

test('JWT expiry should be configurable via env var', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/utils/security'),
        'utf8'
    );
    assert(source.includes('JWT_EXPIRY'),
        'JWT expiry should be configurable');
});

console.log('\n--- Error Handler Security ---');

test('Error handler should default to production mode', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/middleware/errorHandler'),
        'utf8'
    );
    const isProductionMatch = source.match(/const isProduction[\s\S]*?;/);
    if (isProductionMatch) {
        assert(isProductionMatch[0].includes('!process.env.NODE_ENV'),
            'Error handler should default to production when NODE_ENV not set');
    }
});

console.log('\n--- Webhook Security ---');

test('Webhook handler should have reduced tolerance window', () => {
    const webhookPath = require('path').join(__dirname, '../src/routes/governance/webhooks.js');
    if (!require('fs').existsSync(webhookPath)) {
        return;
    }
    const source = require('fs').readFileSync(
        webhookPath,
        'utf8'
    );
    const toleranceMatch = source.match(/SIGNATURE_TOLERANCE_SECONDS\s*=\s*(\d+)/);
    if (toleranceMatch) {
        const tolerance = parseInt(toleranceMatch[1], 10);
        assert(tolerance <= 60,
            'Webhook signature tolerance should be 60 seconds or less');
    }
});

test('Webhook handler should implement replay protection', () => {
    const webhookPath = require('path').join(__dirname, '../src/routes/governance/webhooks.js');
    if (!require('fs').existsSync(webhookPath)) {
        return;
    }
    const source = require('fs').readFileSync(
        webhookPath,
        'utf8'
    );
    assert(source.includes('replay_detected') || source.includes('replay'),
        'Webhook handler should detect replay attacks');
    assert(source.includes('redis.get') || source.includes('redis.setex'),
        'Webhook handler should use Redis for nonce tracking');
});

console.log('\n--- Password Reset Security ---');

test('Password reset should use atomic UPDATE', () => {
    const source = require('fs').readFileSync(
        require.resolve('../src/routes/shared/auth'),
        'utf8'
    );
    // Check for the atomic UPDATE pattern in reset-password (the legacy
    // /invite/accept that also matched invite_token_hash is retired: 410 Gone)
    const hasAtomicUpdate = source.includes('UPDATE users') &&
                           source.includes('WHERE invite_token_hash = $2') &&
                           source.includes('RETURNING user_id, email');
    assert(hasAtomicUpdate,
        'Password reset should use atomic UPDATE with WHERE and RETURNING');
});

// --- Summary ---
console.log('\n=== Summary ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
    console.log('\nSecurity tests failed!');
    process.exit(1);
} else {
    console.log('\nAll security tests passed!');
    process.exit(0);
}
