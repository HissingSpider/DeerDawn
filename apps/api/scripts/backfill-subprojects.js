'use strict';

/**
 * One-off backfill: collapse the fractured DeerDawn projects into ONE umbrella
 * with subprojects. A subproject is just a normal project row with
 * parent_project_id set (see the feat/subprojects data model), so this moves NO
 * context, board, or knowledge — it only re-parents rows and renames a few, then
 * creates the one subproject ("Platform & Release") that has no existing row.
 *
 * Safe by default: DRY RUN unless you pass --apply. It derives owner_key from the
 * parent row, so it can only ever act within that one tenant. Idempotent —
 * re-running skips anything already in place.
 *
 * IMPORTANT: the project ids in PLAN below are the LIVE DeerDawn ids from the
 * production workspace. Point DATABASE_URL at the database that actually holds
 * them (production), review the dry run, THEN re-run with --apply.
 *
 *   node scripts/backfill-subprojects.js            # dry run — show the plan
 *   node scripts/backfill-subprojects.js --apply    # execute
 *   node scripts/backfill-subprojects.js --parent=project_xxx --apply
 *
 * Re-parenting is reversible (promote a child back to top-level by clearing its
 * parent); the created "Platform & Release" row is the only additive change.
 */

const db = require('../src/config/db');
const store = require('../src/store/contextSyncStore');
const service = require('../src/services/contextSyncService');

// The umbrella + the existing rows that become its children (with the tidied
// names). Rename is optional per entry — omit `name` to keep the current one.
const DEFAULT_PARENT = 'project_3c489778-ff4f-4cf0-bee4-56d90f325323'; // "DeerDawn"
const CHILDREN = [
  { id: 'project_678e816f-8a95-4ad4-b358-48cce322ff9a', name: 'Marketing & Growth' },
  { id: 'project_d3e6228c-0ffa-4ee2-8560-bbaf70763904', name: 'Brief-First Migration' },
  { id: 'project_f4036991-e3f7-4694-a884-319069c7b78b', name: 'Setup & API Testing' },
  { id: 'project_0f06ebce-8707-42e6-83dc-79cd59f55d73', name: 'Context Engine' },
  { id: 'project_daa012be-aa56-4dba-804c-b4f9639872ab', name: 'Design System' },
];
// The one subproject with no existing row — holds the deploy/migrations/release
// work that has been squatting on the umbrella. Created under the parent.
const NEW_SUBPROJECTS = [
  {
    name: 'Platform & Release',
    description: 'Deploy, migrations, health/ops, MCP publishing, and launch-gate work.',
  },
];

function parseArgs(argv) {
  const apply = argv.includes('--apply');
  const parentArg = argv.find((a) => a.startsWith('--parent='));
  return { apply, parent: parentArg ? parentArg.slice('--parent='.length) : DEFAULT_PARENT };
}

async function main(opts = {}) {
  // Options let a test drive this without touching process.argv; the CLI path
  // still parses argv when no options are passed.
  const fromArgv = parseArgs(process.argv.slice(2));
  const apply = opts.apply !== undefined ? opts.apply : fromArgv.apply;
  const parentId = opts.parent || fromArgv.parent;

  // Resolve owner_key from the parent row via an unscoped admin read (getProject
  // is owner-scoped, but we don't know the owner yet — that's what we're after).
  const { rows: parentLookup } = await db.query(
    'SELECT project_id, owner_key, project_name, parent_project_id FROM context_projects WHERE project_id = $1',
    [parentId],
    'org-system'
  );
  if (!parentLookup.length) {
    console.error(`Parent ${parentId} not found in this database. Is DATABASE_URL pointed at the right tenant?`);
    return;
  }
  const ownerKey = parentLookup[0].owner_key;
  if (parentLookup[0].parent_project_id) {
    console.error(`Parent ${parentId} is itself a subproject — pick a top-level umbrella.`);
    return;
  }
  const actor = { id: ownerKey };

  console.log(`Umbrella: "${parentLookup[0].project_name}" (${parentId}, owner=${ownerKey})`);
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}\n`);

  // A migration script has no user to scope by, and says so rather than relying
  // on an empty identity list meaning "no filter" — which it no longer does.
  const existingChildren = await store.getSubprojects(ownerKey, parentId, { system: true });
  const existingChildNames = new Set(existingChildren.map((c) => c.project_name.toLowerCase()));

  // 1) Re-parent (and optionally rename) the existing rows.
  for (const child of CHILDREN) {
    const row = await store.getProject(ownerKey, child.id);
    if (!row) {
      console.log(`  skip     ${child.id} — not found under this owner`);
      continue;
    }
    const already = row.parent_project_id === parentId;
    const rename = child.name && child.name !== row.project_name ? ` + rename → "${child.name}"` : '';
    console.log(`  ${apply ? 'parent' : 'would'}   "${row.project_name}" (${child.id})${already ? ' — already parented' : ''}${rename}`);
    if (!apply) continue;

    if (!already) {
      await service.setProjectParent(actor, child.id, parentId);
    }
    if (child.name && child.name !== row.project_name) {
      const fresh = await store.getProject(ownerKey, child.id);
      await store.saveProject({ ...fresh, project_name: child.name, updated_at: new Date().toISOString() }, actor);
    }
  }

  // 2) Create the subprojects that have no existing row.
  for (const sub of NEW_SUBPROJECTS) {
    if (existingChildNames.has(sub.name.toLowerCase())) {
      console.log(`  exists   "${sub.name}" — already a subproject`);
      continue;
    }
    console.log(`  ${apply ? 'create' : 'would'}   new subproject "${sub.name}"`);
    if (apply) {
      await service.createProject(actor, {
        project_name: sub.name,
        description: sub.description,
        parent_project_id: parentId,
      });
    }
  }

  if (!apply) {
    console.log('\nDRY RUN — re-run with --apply to execute the above.');
  } else {
    console.log('\nDone. Board cards / current_task on the umbrella can be moved into "Platform & Release" separately.');
  }
}

if (require.main === module) {
  main()
    .then(() => db.pool.end())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error('backfill-subprojects failed:', err);
      try { await db.pool.end(); } catch { /* ignore */ }
      process.exit(1);
    });
}

module.exports = main;
module.exports.PLAN = { DEFAULT_PARENT, CHILDREN, NEW_SUBPROJECTS };
