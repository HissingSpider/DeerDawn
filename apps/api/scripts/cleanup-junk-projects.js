'use strict';

/**
 * One-off / repeatable cleanup for junk auto-created projects — the kind that
 * predate the write-time name guard (e.g. a project literally named "CLAUDE.md"
 * from a misextraction). Finds every project whose name fails the SAME
 * isValidProjectName guard the API now enforces, and deletes it (cascading its
 * graph nodes / events) via the store's deleteProject.
 *
 * Safe by default: DRY RUN unless you pass --apply. Scope to one tenant with
 * --owner=<owner_key>. Deletion is NOT reversible, hence the explicit flag.
 *
 *   node scripts/cleanup-junk-projects.js              # list what would go
 *   node scripts/cleanup-junk-projects.js --apply      # actually delete
 *   node scripts/cleanup-junk-projects.js --owner=user-123 --apply
 */

const db = require('../src/config/db');
const store = require('../src/store/contextSyncStore');
const { isValidProjectName } = require('../src/services/contextQualityGuards');

function parseArgs(argv) {
  const apply = argv.includes('--apply');
  const ownerArg = argv.find((a) => a.startsWith('--owner='));
  return { apply, owner: ownerArg ? ownerArg.slice('--owner='.length) : null };
}

async function main() {
  const { apply, owner } = parseArgs(process.argv.slice(2));

  // 'org-system' is the unscoped admin context — see config/db.js. Scan all
  // tenants (or one), then filter in JS with the shared guard so the rule can't
  // drift from the write path.
  const where = owner ? 'WHERE owner_key = $1' : '';
  const params = owner ? [owner] : [];
  const { rows } = await db.query(
    `SELECT project_id, owner_key, project_name FROM context_projects ${where}`,
    params,
    'org-system'
  );

  const junk = rows.filter((r) => !isValidProjectName(r.project_name));

  console.log(`Scanned ${rows.length} project(s); ${junk.length} fail the name guard.`);
  for (const r of junk) {
    console.log(`  ${apply ? 'DELETE' : 'would delete'}  "${r.project_name}"  (${r.project_id}, owner=${r.owner_key})`);
  }

  if (!junk.length) {
    console.log('Nothing to clean up.');
    return;
  }
  if (!apply) {
    console.log('\nDRY RUN — re-run with --apply to delete the above.');
    return;
  }

  let deleted = 0;
  for (const r of junk) {
    const ok = await store.deleteProject({ id: r.owner_key }, r.project_id);
    if (ok) deleted += 1;
    console.log(`  ${ok ? 'deleted' : 'skipped'}  ${r.project_id}`);
  }
  console.log(`\nDone. Deleted ${deleted}/${junk.length} project(s).`);
}

if (require.main === module) {
  main()
    .then(() => db.pool.end())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error('cleanup-junk-projects failed:', err);
      try { await db.pool.end(); } catch { /* ignore */ }
      process.exit(1);
    });
}

module.exports = main;
