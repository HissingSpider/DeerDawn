'use strict';

/**
 * ROTATING A DATA KEY MUST NOT DESTROY THE DATA.
 *
 * rotateDek generated a new key and overwrote the wrapped one. Every row sealed
 * under the old key stayed sealed under it, and the old key then existed
 * nowhere. One call made every encrypted brief for that owner permanently
 * unreadable and returned without error.
 *
 * Real database, real cipher. Every assertion is "can the brief still be read,
 * and does it still say what it said".
 *
 * Run via scripts/run-db-test.sh node --test tests/integration/dek-rotation.test.js
 */

process.env.ENCRYPTION_MASTER_KEY = process.env.ENCRYPTION_MASTER_KEY
    || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');
const { ensureDatabaseAvailable } = require('../helpers/dbAvailability');
const store = require('../../src/store/contextSyncStore');
const service = require('../../src/services/contextSyncService');
const encryption = require('../../src/services/encryptionService');

const owners = [];

async function ownerWithBriefs(tasks) {
    const orgId = `org-${uuidv4()}`;
    owners.push(orgId);
    const actor = { type: 'system', id: 'system-key', org_id: orgId };
    const projects = [];
    for (const task of tasks) {
        const project = await service.createProject(actor, { project_name: `Rotation ${uuidv4()}` });
        await service.updateProjectContext(actor, project.project_id, { current_task: task });
        projects.push({ id: project.project_id, task });
    }
    return { orgId, projects };
}

async function rawRow(projectId) {
    const res = await db.query(
        'SELECT context, updated_at FROM context_projects WHERE project_id = $1', [projectId], 'org-system'
    );
    return res.rows[0];
}

async function keyRow(orgId) {
    const res = await db.query(
        'SELECT encrypted_dek, dek_version FROM user_encryption_keys WHERE owner_key = $1', [orgId], 'org-system'
    );
    return res.rows[0];
}

async function assertAllReadable(orgId, projects, message) {
    for (const p of projects) {
        const stored = await store.getProject(orgId, p.id);
        assert.notStrictEqual(stored.context._decrypt_error, true, `${message}: ${p.id} can no longer be decrypted`);
        assert.strictEqual(stored.context.current_task, p.task, message);
    }
}

after(async () => {
    for (const orgId of owners) {
        await db.query('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [orgId], 'org-system').catch(() => {});
        await db.query('DELETE FROM context_projects WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
        await db.query('DELETE FROM user_encryption_keys WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
    }
    await closeRedisConnections?.().catch(() => {});
    await db.pool.end().catch(() => {});
});

test('calling rotateDek never leaves an encrypted brief unreadable', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'dek rotation'))) return;
    const { orgId, projects } = await ownerWithBriefs(['ship the importer', 'fix the billing webhook']);
    assert.ok((await rawRow(projects[0].id)).context._enc, 'the fixture must actually be encrypted at rest');

    // The bare call, exactly as the old signature invited it. It may refuse or
    // it may rotate; what it may not do is what it used to.
    await encryption.rotateDek(orgId).catch(() => {});

    await assertAllReadable(orgId, projects, 'after a bare rotateDek call');
});

test('without an exclusivity assertion it refuses, says why, and changes nothing', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'dek rotation'))) return;
    const { orgId, projects } = await ownerWithBriefs(['one brief']);
    const keyBefore = await keyRow(orgId);

    await assert.rejects(
        () => encryption.rotateDek(orgId),
        (err) => {
            assert.strictEqual(err.code, 'dek_rotation_refused');
            assert.strictEqual(err.encrypted_rows, 1);
            assert.match(err.message, /exclusive/);
            return true;
        }
    );

    assert.deepStrictEqual(await keyRow(orgId), keyBefore, 'a refusal must not touch the key');
    await assertAllReadable(orgId, projects, 'after a refused rotation');
});

test('an exclusive rotation re-seals every row under the new key', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'dek rotation'))) return;
    const { orgId, projects } = await ownerWithBriefs(['alpha', 'beta', 'gamma']);
    const keyBefore = await keyRow(orgId);
    const rowsBefore = await Promise.all(projects.map((p) => rawRow(p.id)));

    const result = await encryption.rotateDek(orgId, { exclusive: true });

    assert.strictEqual(result.rotated, true);
    assert.strictEqual(result.reencrypted, 3);
    const keyAfter = await keyRow(orgId);
    assert.notStrictEqual(keyAfter.encrypted_dek, keyBefore.encrypted_dek, 'the key must actually have changed');
    assert.strictEqual(keyAfter.dek_version, keyBefore.dek_version + 1);

    for (let i = 0; i < projects.length; i += 1) {
        const after = await rawRow(projects[i].id);
        assert.notStrictEqual(after.context._enc, rowsBefore[i].context._enc, 'the row must be sealed afresh');
        assert.strictEqual(
            new Date(after.updated_at).getTime(), new Date(rowsBefore[i].updated_at).getTime(),
            're-sealing is not activity: updated_at drives auto-archive and the digest'
        );
    }
    await assertAllReadable(orgId, projects, 'after an exclusive rotation');

    // And writable: the next save uses the new key and reads back.
    await service.updateProjectContext({ type: 'system', id: 'system-key', org_id: orgId }, projects[0].id, { current_task: 'written after rotation' });
    assert.strictEqual((await store.getProject(orgId, projects[0].id)).context.current_task, 'written after rotation');
});

test('a row that will not open under the current key aborts the rotation and changes nothing', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'dek rotation'))) return;
    const { orgId, projects } = await ownerWithBriefs(['intact', 'about to be damaged']);
    const keyBefore = await keyRow(orgId);
    const intactBefore = await rawRow(projects[0].id);

    // Flip the last byte of one ciphertext: the AES-GCM tag no longer matches.
    const damaged = await rawRow(projects[1].id);
    const enc = damaged.context._enc;
    const flipped = enc.slice(0, -1) + (enc.endsWith('0') ? '1' : '0');
    await db.query('UPDATE context_projects SET context = $1::jsonb WHERE project_id = $2', [JSON.stringify({ _enc: flipped }), projects[1].id], 'org-system');

    await assert.rejects(
        () => encryption.rotateDek(orgId, { exclusive: true }),
        (err) => err.code === 'dek_rotation_unreadable_row' && err.project_id === projects[1].id
    );

    assert.deepStrictEqual(await keyRow(orgId), keyBefore, 'the only key that might open that row must survive');
    assert.strictEqual((await rawRow(projects[0].id)).context._enc, intactBefore.context._enc, 'all or nothing: the intact row was rolled back too');
    await assertAllReadable(orgId, [projects[0]], 'after an aborted rotation');
});

test('another process still holding the old key recovers on its next read', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'dek rotation'))) return;
    const { orgId, projects } = await ownerWithBriefs(['read by a second machine']);

    // A second copy of the module is a second process as far as the DEK cache is
    // concerned: its own LRU, same database.
    const modulePath = path.join(__dirname, '..', '..', 'src', 'services', 'encryptionService.js');
    const resolved = require.resolve(modulePath);
    const original = require.cache[resolved];
    delete require.cache[resolved];
    const otherMachine = require(modulePath);
    require.cache[resolved] = original;

    // It reads once, which caches the old key for the next half hour.
    const before = await otherMachine.decryptContextObject(orgId, (await rawRow(projects[0].id)).context);
    assert.strictEqual(before.current_task, 'read by a second machine');

    await encryption.rotateDek(orgId, { exclusive: true });

    const afterRotation = await otherMachine.decryptContextObject(orgId, (await rawRow(projects[0].id)).context);
    assert.strictEqual(afterRotation.current_task, 'read by a second machine', 'a stale cached key must not read as an empty brief');
});

test('an owner with no key is reported, not invented', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'dek rotation'))) return;
    const result = await encryption.rotateDek(`org-${uuidv4()}`, { exclusive: true });
    assert.deepStrictEqual(result, { rotated: false, reason: 'no_key', reencrypted: 0 });
});
