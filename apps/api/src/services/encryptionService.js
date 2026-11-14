'use strict';

const crypto = require('crypto');
const { LRUCache } = require('lru-cache');
const db = require('../config/db');

const ALGORITHM = 'aes-256-gcm';
const IV_LEN = 12;

// In-process DEK cache — avoids a DB round-trip on every encrypt/decrypt.
// Bounded (unlike a plain Map) so memory doesn't grow with every org that has
// ever encrypted context over the life of the process. Matches the pattern in
// services/apiKeyCache.js.
const dekCache = new LRUCache({
  max: 10000,          // ~10k owner DEKs in memory (32 bytes each — negligible)
  ttl: 1000 * 60 * 30, // 30 minute TTL
  updateAgeOnGet: true,
});

function getMasterKey() {
  const hex = process.env.ENCRYPTION_MASTER_KEY;
  if (!hex || hex.length !== 64) throw new Error('ENCRYPTION_MASTER_KEY must be a 64-char hex string');
  return Buffer.from(hex, 'hex');
}

function encryptWithKey(key, plaintext) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

function decryptWithKey(key, encoded) {
  const parts = encoded.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Invalid ciphertext format');
  const iv = Buffer.from(parts[1], 'hex');
  const tag = Buffer.from(parts[2], 'hex');
  const ciphertext = Buffer.from(parts[3], 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

async function getDek(ownerKey) {
  if (dekCache.has(ownerKey)) return dekCache.get(ownerKey);

  const result = await db.query(
    'SELECT encrypted_dek FROM user_encryption_keys WHERE owner_key = $1',
    [ownerKey],
    'org-system'
  );

  let dek;
  if (result.rows.length) {
    dek = Buffer.from(decryptWithKey(getMasterKey(), result.rows[0].encrypted_dek), 'hex');
  } else {
    // THE WRITE DECIDES WHICH KEY IS REAL, SO READ THE WRITE BACK.
    //
    // This used to INSERT ... ON CONFLICT DO NOTHING and then return the LOCALLY
    // generated dek regardless of whether that INSERT won. Two concurrent first
    // writes for the same owner therefore produced two keys: one stored, one used
    // to encrypt a row that nothing could ever decrypt again — and the write
    // reported success.
    //
    // That is not a rare race here. shouldEncrypt() is now gated on the master key
    // alone and the secret is already set in production, so the first deploy is
    // precisely the moment when every owner has no key row and their sessions are
    // writing concurrently.
    //
    // RETURNING yields a row only when the INSERT actually inserted. No row means
    // somebody else won; re-read and use theirs.
    const candidate = crypto.randomBytes(32);
    const encryptedDek = encryptWithKey(getMasterKey(), candidate.toString('hex'));
    const inserted = await db.query(
      `INSERT INTO user_encryption_keys (owner_key, encrypted_dek, encrypted_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (owner_key) DO NOTHING
       RETURNING encrypted_dek`,
      [ownerKey, encryptedDek],
      'org-system'
    );

    if (inserted.rows.length) {
      dek = candidate;
    } else {
      const winner = await db.query(
        'SELECT encrypted_dek FROM user_encryption_keys WHERE owner_key = $1',
        [ownerKey],
        'org-system'
      );
      if (!winner.rows.length) {
        // The row neither inserted nor exists: something is wrong with the table,
        // and inventing a key here is how data becomes unreadable. Fail loudly.
        throw new Error(`getDek: could not establish a data key for ${ownerKey}`);
      }
      dek = Buffer.from(decryptWithKey(getMasterKey(), winner.rows[0].encrypted_dek), 'hex');
    }
  }

  dekCache.set(ownerKey, dek);
  return dek;
}

// Encrypt whenever a master key is configured. No plan check, no actor check.
//
// This function used to read `actor.plan_tier === 'pro' || 'enterprise'`, and it
// had never once returned true in production. `req.actor` is built in three
// places in middleware/auth.js and not one of them sets plan_tier — the field
// simply does not exist on an actor — so the comparison was `undefined === 'pro'`
// on every request and every customer's project context was written in plaintext.
// A second, independent bug sat underneath it: organizations.plan_tier holds plan
// IDs like 'developer_pro', and 'pro' is a PLAN_ALIAS for 'enterprise', so even
// with the field populated the literal comparison would still have been false for
// every self-serve plan.
//
// It is gated on nothing now, deliberately. Tying a security control to a
// billing tier is what produced a fully-implemented cipher that never ran, and
// the cost of always encrypting is one AES-GCM pass over a JSON blob against an
// already-cached DEK. There is no argument for selling this by the tier, and
// "is our data encrypted at rest" is a yes-or-no question that a five-person
// company asks in the first email.
//
// Reads stay tolerant of legacy plaintext via isEncrypted(), so switching this
// on is forward-only; scripts/backfill-context-encryption.js re-writes rows
// stored before the fix.
function shouldEncrypt() {
  return Boolean(process.env.ENCRYPTION_MASTER_KEY);
}

async function encryptContext(ownerKey, plaintext) {
  const dek = await getDek(ownerKey);
  return encryptWithKey(dek, plaintext);
}

// A CACHED KEY CAN BE A STALE KEY.
//
// The DEK cache is per process and lives for 30 minutes (longer, with
// updateAgeOnGet, for an owner who is active). A rotation performed by one
// process is invisible to every other process until that entry expires, and a
// reader holding the old key fails the AES-GCM tag on a row sealed under the
// new one — which rowToProject turns into {_decrypt_error: true}, an empty
// brief, for a row that is perfectly readable.
//
// So an authentication failure with a CACHED key is retried once with the key
// re-read from the database. Only on failure, so the hot path is unchanged, and
// only once: if the stored key cannot open the row either, the row really is
// unreadable and the original error is what the caller should see.
//
// This heals READERS. It cannot heal a stale WRITER, which is why rotateDek
// below will not run while other writers may exist.
async function decryptContext(ownerKey, encoded) {
  const wasCached = dekCache.has(ownerKey);
  const dek = await getDek(ownerKey);
  try {
    return decryptWithKey(dek, encoded);
  } catch (err) {
    if (!wasCached) throw err;
    dekCache.delete(ownerKey);
    const fresh = await getDek(ownerKey);
    if (fresh.equals(dek)) throw err;
    return decryptWithKey(fresh, encoded);
  }
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith('v1:');
}

// Encrypt a context object to the DB-storable form: { _enc: "v1:..." }
async function encryptContextObject(ownerKey, contextObj) {
  const plaintext = JSON.stringify(contextObj);
  const ciphertext = await encryptContext(ownerKey, plaintext);
  return { _enc: ciphertext };
}

// Decrypt a DB row's context field — handles both encrypted ({ _enc }) and plaintext JSONB
async function decryptContextObject(ownerKey, contextField) {
  if (!contextField) return contextField;
  if (contextField._enc && isEncrypted(contextField._enc)) {
    const plaintext = await decryptContext(ownerKey, contextField._enc);
    return JSON.parse(plaintext);
  }
  return contextField;
}

/**
 * ROTATE AN OWNER'S DATA KEY — BY RE-ENCRYPTING WHAT IT PROTECTS.
 *
 * The previous version of this function generated a new key and overwrote the
 * wrapped one. It did nothing else. Every `context_projects.context` row for
 * that owner was still sealed under the OLD key, and the old key now existed
 * nowhere: not in the table, and after `dekCache.delete`, not in memory either.
 * One call made every encrypted brief that owner had ever written permanently
 * unreadable, and returned without error. There is no recovery from that;
 * CLAUDE.md is explicit that nothing recovers a lost key. It had no callers,
 * which is the only reason it had not happened.
 *
 * What rotation has to be:
 *   1. lock the key row, so two rotations cannot interleave
 *   2. lock and read every row sealed under it
 *   3. open each with the OLD key, seal it with the NEW one, and open the result
 *      again to prove the new ciphertext yields the same plaintext
 *   4. prove the wrapped new key unwraps to the new key
 *   5. only then swap the key — in the SAME transaction as the rows
 * Any failure at any step rolls the whole thing back and the owner is exactly
 * where they started: old key, old rows, all readable. A row that will not open
 * under the old key ABORTS the rotation rather than being skipped, because
 * after the swap the old key is gone and "skipped" would mean "destroyed".
 *
 * `updated_at` is deliberately not touched. Re-sealing is not activity; stamping
 * it would make every rotated project look freshly edited to the auto-archive
 * sweep, the digest and the dashboard.
 *
 * WHY IT REFUSES UNLESS `exclusive: true`.
 *
 * The transaction protects the rows. It cannot protect against another PROCESS.
 * Ciphertext is `v1:iv:tag:data` — it carries no key id — and every API process
 * caches each owner's DEK for 30+ minutes. A second machine that still holds the
 * old key will, after this commits, happily encrypt the owner's next save under
 * a key that no longer exists anywhere durable. That write succeeds, and the row
 * is unreadable the moment that machine's cache entry expires. decryptContext's
 * retry heals stale readers; nothing here can heal a stale writer.
 *
 * So a caller must assert that this process is the only one that can write for
 * this owner right now: a maintenance script with the API stopped, a single
 * local process, a test. Making rotation safe ONLINE needs a key version in the
 * ciphertext (so a writer's key can be checked against the current one) — a
 * format change that belongs in its own change, not inside a fix for a function
 * that destroys data. Until then this refuses, and says so, rather than
 * guessing.
 *
 * Only `context_projects.context` is sealed under the owner DEK
 * (context_integrations.encrypted_key uses the credential cipher, not this one).
 * Anything else that starts using encryptContextObject has to be added to step
 * 2, or it becomes the next thing a rotation silently destroys.
 */
async function rotateDek(ownerKey, { exclusive = false } = {}) {
  if (!ownerKey) throw new Error('rotateDek: ownerKey is required');

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const keyRow = await client.query(
      'SELECT encrypted_dek, dek_version FROM user_encryption_keys WHERE owner_key = $1 FOR UPDATE',
      [ownerKey]
    );
    if (!keyRow.rows.length) {
      // Nothing has ever been encrypted for this owner. Same outcome as before
      // (the old UPDATE matched no row), but reported instead of silent.
      await client.query('ROLLBACK');
      return { rotated: false, reason: 'no_key', reencrypted: 0 };
    }

    if (!exclusive) {
      const sealed = await client.query(
        'SELECT COUNT(*)::int AS n FROM context_projects WHERE owner_key = $1 AND context ? \'_enc\'',
        [ownerKey]
      );
      await client.query('ROLLBACK');
      const err = new Error(
        `rotateDek refused for ${ownerKey}: ${sealed.rows[0].n} encrypted project(s) are sealed under this key, ` +
        'ciphertext carries no key version, and other API processes cache the current key for 30+ minutes. ' +
        'Rotating while any of them can still write would leave their next save sealed under a key that no longer exists. ' +
        'Run it with { exclusive: true } only when this is the sole process able to write for this owner ' +
        '(API stopped or restarted afterwards).'
      );
      err.code = 'dek_rotation_refused';
      err.encrypted_rows = sealed.rows[0].n;
      throw err;
    }

    const masterKey = getMasterKey();
    const oldDek = Buffer.from(decryptWithKey(masterKey, keyRow.rows[0].encrypted_dek), 'hex');
    const newDek = crypto.randomBytes(32);

    const rows = await client.query(
      'SELECT project_id, context FROM context_projects WHERE owner_key = $1 AND context ? \'_enc\' FOR UPDATE',
      [ownerKey]
    );

    let reencrypted = 0;
    for (const row of rows.rows) {
      const sealedUnderOld = row.context._enc;
      let plaintext;
      try {
        plaintext = decryptWithKey(oldDek, sealedUnderOld);
      } catch (openErr) {
        const err = new Error(
          `rotateDek aborted for ${ownerKey}: project ${row.project_id} does not open under the current key ` +
          `(${openErr.message}). Nothing was changed. Rotating would discard the only key that might still open it.`
        );
        err.code = 'dek_rotation_unreadable_row';
        err.project_id = row.project_id;
        throw err;
      }
      const sealedUnderNew = encryptWithKey(newDek, plaintext);
      if (decryptWithKey(newDek, sealedUnderNew) !== plaintext) {
        throw new Error(`rotateDek aborted for ${ownerKey}: round-trip mismatch on ${row.project_id}`);
      }
      await client.query(
        'UPDATE context_projects SET context = $1::jsonb WHERE project_id = $2 AND owner_key = $3',
        [JSON.stringify({ ...row.context, _enc: sealedUnderNew }), row.project_id, ownerKey]
      );
      reencrypted += 1;
    }

    const wrapped = encryptWithKey(masterKey, newDek.toString('hex'));
    if (decryptWithKey(masterKey, wrapped) !== newDek.toString('hex')) {
      throw new Error(`rotateDek aborted for ${ownerKey}: the wrapped key did not unwrap to the new key`);
    }
    const swapped = await client.query(
      `UPDATE user_encryption_keys
          SET encrypted_dek = $1, dek_version = dek_version + 1, encrypted_at = NOW(), updated_at = NOW()
        WHERE owner_key = $2
        RETURNING dek_version`,
      [wrapped, ownerKey]
    );

    await client.query('COMMIT');
    // After COMMIT, never before: a cache cleared ahead of a rollback would
    // simply be refilled with the same key, but one cleared ahead of a COMMIT
    // that then fails is a window in which this process re-reads the OLD key
    // and keeps it for half an hour.
    dekCache.delete(ownerKey);
    return { rotated: true, reencrypted, dek_version: swapped.rows[0]?.dek_version ?? null };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  shouldEncrypt,
  encryptContextObject,
  decryptContextObject,
  rotateDek,
  isEncrypted,
};
