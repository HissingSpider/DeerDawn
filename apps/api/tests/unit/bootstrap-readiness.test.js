const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { privateSkipReason } = require('../helpers/privatePaths');

function read(relativePath) {
    return fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8');
}

test('server binds before dependency bootstrap and marks readiness separately', () => {
    const server = read('src/server.js');

    assert.match(server, /setBootstrapStarting\(\)/);
    assert.match(server, /app\.listen\(PORT,\s*'0\.0\.0\.0'/);
    assert.match(server, /await testConnection\(\)/);
    assert.match(server, /await runAutoMigration\(\)/);
    assert.match(server, /setBootstrapReady\(\)/);
});

test('app gates non-health traffic while the runtime is still bootstrapping', () => {
    const app = read('src/app.js');

    assert.match(app, /getBootstrapState/);
    assert.match(app, /error:\s*'service_starting'/);
    assert.match(app, /Retry-After/);
});

// fly.toml is the hosted deploy config; the public export does not ship it.
test('fly health checks use a bootstrap-aware path, never raw liveness', {
    skip: privateSkipReason('apps/api/fly.toml') || false,
}, () => {
    const flyToml = read('fly.toml');
    const health = read('src/routes/health.js');

    // The invariant is that Fly must not route traffic to an instance that is still
    // bootstrapping — NOT that any one literal path is used. This originally pinned
    // '/health/readiness', but that endpoint runs SELECT 1 on every poll, which kept
    // Neon's compute from scaling to zero, so the check was deliberately moved to the
    // cheap in-memory '/healthz'. Assert the property instead of the path.
    const checkPath = (flyToml.match(/^\s*path = '([^']+)'/m) || [])[1];
    assert.ok(checkPath, 'fly.toml must declare a health check path');

    assert.notStrictEqual(
        checkPath, '/health/liveness',
        '/health/liveness returns 200 unconditionally — it cannot gate traffic on bootstrap',
    );

    // Whichever path is configured, its handler must consult bootstrap state.
    const handler = health.slice(health.indexOf(`router.get('${checkPath}'`));
    assert.ok(
        handler.startsWith(`router.get('${checkPath}'`),
        `health.js must define a handler for the configured check path ${checkPath}`,
    );
    assert.match(
        handler.slice(0, 400), /getBootstrapState/,
        `${checkPath} must gate on getBootstrapState() so Fly cannot route to a booting instance`,
    );

    assert.match(flyToml, /grace_period = '90s'/);
});
