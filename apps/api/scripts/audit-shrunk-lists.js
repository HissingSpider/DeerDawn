'use strict';

/**
 * READ-ONLY audit: which projects lost list items to the extraction merge?
 *
 * Between #486 going live (2026-09-19 17:58 UTC) and the union fix, an
 * extraction that added ONE item to goals / tech_stack / recurring_context /
 * file_structure_summary REPLACED the stored list with just the new items:
 * sanitizeExtraction stripped what was already stored, and mergeContextObject
 * assigned what was left. Stored [G1,G2,G3] + model [G1,G4] became [G4].
 *
 * The prior list is not stored anywhere, but every applied extraction recorded
 * what it ADDED (context_events.delta). So the list a project SHOULD have is, at
 * most, the union of everything ever added to it, minus goals later completed.
 * This script reports, per project and field, the items that were added at some
 * point, are not in the stored list now, and were last seen before a
 * post-cutoff extraction touched that field.
 *
 * It writes NOTHING. A deliberate removal through the dashboard looks the same
 * as a wipe from here, so every row is a candidate for a person to confirm, not
 * a repair to apply blind.
 *
 *   node scripts/audit-shrunk-lists.js
 *   node scripts/audit-shrunk-lists.js --since=2026-09-19T17:58:00Z --owner=<owner_key>
 *   node scripts/audit-shrunk-lists.js --json
 */

const db = require('../src/config/db');
const store = require('../src/store/contextSyncStore');

const LIST_FIELDS = ['goals', 'tech_stack', 'recurring_context', 'file_structure_summary'];
const DEFAULT_SINCE = '2026-09-19T17:58:00Z';

function parseArgs(argv) {
  const value = (name) => {
    const arg = argv.find((a) => a.startsWith(`--${name}=`));
    return arg ? arg.slice(name.length + 3) : null;
  };
  return { since: value('since') || DEFAULT_SINCE, owner: value('owner'), json: argv.includes('--json') };
}

const keyOf = (text) => String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();

async function main() {
  const { since, owner, json } = parseArgs(process.argv.slice(2));

  // Projects with an applied extraction that touched a list field after the cutoff.
  const touched = await db.query(
    `SELECT DISTINCT e.project_id, p.owner_key, p.project_name
       FROM context_events e
       JOIN context_projects p ON p.project_id = e.project_id
      WHERE e.event_kind = 'context_delta_applied'
        AND e.created_at >= $1
        AND (${LIST_FIELDS.map((field) => `e.delta ? '${field}'`).join(' OR ')})
        ${owner ? 'AND p.owner_key = $2' : ''}`,
    owner ? [since, owner] : [since],
    'org-system'
  );

  const findings = [];
  for (const row of touched.rows) {
    const project = await store.getProject(row.owner_key, row.project_id).catch(() => null);
    if (!project) continue;
    const events = (project.events || [])
      .filter((event) => event.event_kind === 'context_delta_applied')
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

    for (const field of LIST_FIELDS) {
      const postCutoff = events.filter((event) => new Date(event.created_at) >= new Date(since) && Array.isArray(event.delta?.[field]));
      if (!postCutoff.length) continue;

      const everAdded = new Map();
      const completed = new Set();
      for (const event of events) {
        for (const item of Array.isArray(event.delta?.[field]) ? event.delta[field] : []) {
          if (!everAdded.has(keyOf(item))) everAdded.set(keyOf(item), { text: item, first_seen: event.created_at });
        }
        if (field === 'goals') {
          for (const item of Array.isArray(event.delta?.completed_goals) ? event.delta.completed_goals : []) completed.add(keyOf(item));
        }
      }
      const stored = new Set((project.context?.[field] || []).map(keyOf));
      const missing = [...everAdded.entries()]
        .filter(([key, seen]) => !stored.has(key) && !completed.has(key) && new Date(seen.first_seen) < new Date(postCutoff[0].created_at))
        .map(([, seen]) => seen);
      if (!missing.length) continue;

      findings.push({
        owner_key: row.owner_key,
        project_id: row.project_id,
        project_name: row.project_name,
        field,
        stored_now: project.context?.[field] || [],
        first_post_cutoff_write: postCutoff[0].created_at,
        added_by_that_write: postCutoff[0].delta[field],
        missing_candidates: missing,
      });
    }
  }

  if (json) {
    console.log(JSON.stringify({ since, projects_checked: touched.rows.length, findings }, null, 2));
  } else {
    console.log(`Cutoff ${since}. Projects with a list-field extraction since then: ${touched.rows.length}.`);
    if (!findings.length) console.log('No list shows items that were added before the cutoff and are gone now.');
    for (const finding of findings) {
      console.log(`\n${finding.project_name} (${finding.project_id}, owner ${finding.owner_key}) — ${finding.field}`);
      console.log(`  stored now (${finding.stored_now.length}): ${JSON.stringify(finding.stored_now)}`);
      console.log(`  first write after cutoff: ${finding.first_post_cutoff_write} added ${JSON.stringify(finding.added_by_that_write)}`);
      console.log(`  missing, previously added (${finding.missing_candidates.length}):`);
      for (const item of finding.missing_candidates) console.log(`    - ${item.text}  [first seen ${item.first_seen}]`);
    }
    console.log('\nNothing was written. Items a person removed on purpose appear here too: confirm before restoring.');
  }
}

main()
  .then(() => db.pool?.end?.())
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
    return db.pool?.end?.();
  });
