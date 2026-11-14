#!/usr/bin/env node
'use strict';

// Re-write project context that was stored in plaintext back when
// encryptionService.shouldEncrypt() could never return true.
//
// The gate read `actor.plan_tier`, a field no code path has ever set on an
// actor, so the answer was always false and every row in context_projects was
// written unencrypted. Reads already tolerate both forms (rowToProject decrypts
// only when context._enc is present), so this is a pure catch-up pass and is
// safe to run repeatedly or to interrupt.
//
//   node scripts/backfill-context-encryption.js [--dry-run] [--batch=200]
//
// Requires ENCRYPTION_MASTER_KEY. Without it the script refuses rather than
// reporting success over a no-op, which is the failure mode that hid the
// original bug.

const db = require('../src/config/db');
const encryption = require('../src/services/encryptionService');

function parseArgs(argv) {
  const args = { dryRun: false, batch: 200 };
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg.startsWith('--batch=')) args.batch = Math.max(1, parseInt(arg.slice(8), 10) || 200);
  }
  return args;
}

async function main() {
  const { dryRun, batch } = parseArgs(process.argv);

  if (!process.env.ENCRYPTION_MASTER_KEY) {
    console.error('[backfill] ENCRYPTION_MASTER_KEY is not set — refusing to run.');
    console.error('[backfill] Without it every row would be left in plaintext and this would still exit 0.');
    process.exit(1);
  }

  let scanned = 0;
  let encrypted = 0;
  let failed = 0;
  let lastId = '';

  for (;;) {
    const rows = await db.query(
      `SELECT project_id, owner_key, context
         FROM context_projects
        WHERE project_id > $1
        ORDER BY project_id ASC
        LIMIT $2`,
      [lastId, batch],
      'org-system'
    );
    if (!rows.rows.length) break;

    for (const row of rows.rows) {
      lastId = row.project_id;
      scanned += 1;
      if (row.context && row.context._enc) continue;

      if (dryRun) {
        encrypted += 1;
        continue;
      }

      try {
        const sealed = await encryption.encryptContextObject(row.owner_key, row.context || {});
        // Guarded on the row still being plaintext so a concurrent live write
        // cannot be clobbered by this pass — the running API is the authority on
        // any project it is actively touching.
        const res = await db.query(
          `UPDATE context_projects
              SET context = $2
            WHERE project_id = $1
              AND (context->'_enc') IS NULL`,
          [row.project_id, JSON.stringify(sealed)],
          'org-system'
        );
        if (res.rowCount) encrypted += 1;
      } catch (err) {
        failed += 1;
        console.error(`[backfill] ${row.project_id}: ${err.message}`);
      }
    }

    console.log(`[backfill] scanned=${scanned} encrypted=${encrypted} failed=${failed}`);
  }

  console.log(`[backfill] ${dryRun ? 'DRY RUN — ' : ''}done. scanned=${scanned} encrypted=${encrypted} failed=${failed}`);
  if (failed) process.exitCode = 1;
}

main()
  .then(() => db.pool?.end?.())
  .catch((err) => {
    console.error('[backfill] fatal:', err);
    process.exit(1);
  });
