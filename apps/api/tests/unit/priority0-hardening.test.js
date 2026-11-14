/**
 * Priority-0 security hardening — unit + source-contract tests (no DB required).
 *
 * Covers: AUTHZ-001/002/003 (role model, no admin wildcard, platform-staff gate, derived
 * scopes), AUTHN-001 (local JWT fallback gating), LOG-02/03 (no token logging), INFRA-01
 * (DB TLS verification in scripts), FILE-01 (Obsidian vault confinement).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { requireRole, requirePlatformStaff, deriveScopes } = require('../../src/middleware/auth');
const { getDbSslConfig } = require('../../src/config/dbSsl');

function mockRes() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
        send(payload) { this.body = payload; return this; },
    };
}
function run(mw, actor) {
    const req = { actor };
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    return { res, nextCalled };
}

test('deriveScopes: roles map to least-privilege scopes, never wildcard', () => {
    assert.deepStrictEqual(deriveScopes('read-only'), ['context:read']);
    assert.deepStrictEqual(deriveScopes('member'), ['context:read', 'context:write']);
    assert.ok(deriveScopes('owner').includes('context:admin'));
    assert.ok(deriveScopes('admin').includes('context:admin'));
    for (const role of ['read-only', 'member', 'owner', 'admin', 'operator', 'approver', 'bogus']) {
        assert.ok(!deriveScopes(role).includes('*'), `role ${role} must not derive a wildcard scope`);
    }
});

test('AUTHZ-001: requireRole no longer treats admin as a global wildcard', () => {
    const guard = requireRole(['operator']);
    // role 'admin' must NOT pass a route that only allows 'operator'
    const admin = run(guard, { role: 'admin', id: 'u1' });
    assert.strictEqual(admin.nextCalled, false);
    assert.strictEqual(admin.res.statusCode, 403);
    // explicit membership still passes
    const op = run(guard, { role: 'operator', id: 'u2' });
    assert.strictEqual(op.nextCalled, true);
});

test('AUTHZ-002/003: requirePlatformStaff blocks tenant roles, allows staff + system key', () => {
    // anonymous
    assert.strictEqual(run(requirePlatformStaff, null).res.statusCode, 401);
    // org owner / admin (tenant) are NOT platform staff
    assert.strictEqual(run(requirePlatformStaff, { role: 'owner', is_platform_staff: false }).res.statusCode, 403);
    assert.strictEqual(run(requirePlatformStaff, { role: 'admin' }).res.statusCode, 403);
    // explicit platform staff passes
    assert.strictEqual(run(requirePlatformStaff, { role: 'owner', is_platform_staff: true }).nextCalled, true);
    // internal system key (infra credential) passes
    assert.strictEqual(run(requirePlatformStaff, { type: 'system', role: 'admin' }).nextCalled, true);
});

test('INFRA-01: getDbSslConfig verifies certs for remote hosts, disables TLS only for local', () => {
    assert.strictEqual(getDbSslConfig('postgres://localhost:5432/deerdawn_dev'), false);
    assert.strictEqual(getDbSslConfig('postgres://127.0.0.1:5432/db'), false);
    const remote = getDbSslConfig('postgres://user:pw@ep-cool.us-east-2.neon.tech/db');
    assert.strictEqual(remote.rejectUnauthorized, true);
    // a production-looking URL must never disable verification
    const prodish = getDbSslConfig('postgresql://u:p@db.internal.example.com:5432/app');
    assert.strictEqual(prodish.rejectUnauthorized, true);
});

test('INFRA-01: no migration/ops script disables TLS certificate verification', () => {
    const scriptsDir = path.join(__dirname, '..', '..', 'scripts');
    const offenders = fs.readdirSync(scriptsDir)
        .filter((f) => f.endsWith('.js'))
        .filter((f) => /rejectUnauthorized:\s*false/.test(fs.readFileSync(path.join(scriptsDir, f), 'utf8')));
    assert.deepStrictEqual(offenders, [], `scripts still disabling TLS: ${offenders.join(', ')}`);
});

// FILE-01 originally exercised validateObsidianVaultPath() in
// src/services/contextIntegrationSyncService. That module has never existed in this
// repo (confirmed against the branch point), and neither does OBSIDIAN_VAULT_ROOTS —
// so the test could only ever throw MODULE_NOT_FOUND. It was guarding a server-side
// "write the vault to a user-supplied directory" feature that was never built; the
// Obsidian export that does exist returns markdown as JSON over HTTP and touches no
// local path.
//
// Rather than delete the guard, assert the property that makes it unnecessary: the API
// writes no files at all. If server-side vault writing is ever added, this fails and
// forces path confinement to be written alongside it.
test('FILE-01: the API performs no filesystem writes (so no vault path can escape)', () => {
    const srcDir = path.join(__dirname, '..', '..', 'src');
    const WRITE_CALL = /\bfs(?:\.promises)?\.(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|createWriteStream|rename|renameSync|copyFile|copyFileSync)\s*\(/;

    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return walk(full);
        return e.isFile() && e.name.endsWith('.js') ? [full] : [];
    });

    // The one sanctioned writer: add-on file storage on local disk (self-hosted).
    // Its keys are built by the platform from its own ids, never from a request,
    // and fileFor() refuses any key that is malformed or resolves outside the
    // configured root (tests/unit/addons-platform-unit.test.js pins that).
    const CONFINED_WRITERS = new Set([path.join('addons', 'storage', 'localDisk.js')]);
    const confined = fs.readFileSync(path.join(srcDir, 'addons', 'storage', 'localDisk.js'), 'utf8');
    assert.match(confined, /startsWith\(base \+ path\.sep\)/, 'localDisk confines every key to its root');

    const offenders = walk(srcDir)
        .filter((f) => WRITE_CALL.test(fs.readFileSync(f, 'utf8')))
        .map((f) => path.relative(srcDir, f))
        .filter((rel) => !CONFINED_WRITERS.has(rel));

    assert.deepStrictEqual(
        offenders, [],
        'apps/api now writes to the filesystem. If the path can be influenced by a '
        + 'request, confine it to an allow-listed root before removing this guard: '
        + offenders.join(', '),
    );
});

test('source contracts: hardening is wired where it must be (regression guards)', () => {
    const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

    const authMw = read('src/middleware/auth.js');
    assert.ok(!/req\.actor\.role === 'admin'/.test(authMw), 'requireRole admin wildcard must be removed');
    assert.ok(/requirePlatformStaff/.test(authMw), 'requirePlatformStaff must exist');
    assert.ok(/scopes:\s*deriveScopes\(user\.role\)/.test(authMw), 'user actor must derive scopes from role');
    assert.ok(/this\.provider === 'clerk' && !this\.allowLocalFallback/.test(authMw), 'AUTHN-001 fallback gate must exist');

    assert.ok(/requirePlatformStaff/.test(read('src/routes/shared/metrics.js')), 'metrics must use requirePlatformStaff');
    assert.ok(/requirePlatformStaff/.test(read('src/routes/admin-content.js')), 'admin-content must use requirePlatformStaff');

    const authRoute = read('src/routes/shared/auth.js');
    assert.ok(/const role = 'owner'/.test(authRoute), 'signup must mint org owner, not admin');
    assert.ok(!/console\.log\(`\[AUTH\] Password reset link/.test(authRoute), 'reset URL must not be unconditionally logged');

    assert.ok(/'owner', 'member', 'read-only', 'admin', 'operator', 'approver'/.test(read('sql/schema.sql')), 'schema role CHECK must include owner/member');
});
