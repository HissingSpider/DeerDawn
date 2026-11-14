# Runbook: three database jobs for the owner to run by hand

**Who runs it:** the owner. Nothing runs these automatically: not the boot
migration, the scheduler, CI, a deploy hook or an npm script
(`apps/api/tests/unit/owner-run-db-scripts.test.js` fails if anything ever does).
Whoever wrote them did not connect to production and does not have its URL.

**Where:** `apps/api/scripts/owner-run/`. Four SQL files, run with `psql`
against the production database.

| File | What it does | Changes data? | Locks |
|---|---|---|---|
| `01-graph-delete-indexes.sql` | Builds four indexes | Adds indexes only | None that block reads or writes (`CONCURRENTLY`) |
| `02-count-cross-account-rows.sql` | Counts graph rows whose owner differs from their project's, node's or edge's owner | No: READ ONLY transaction | Read locks only |
| `03-count-lifetime-accounts.sql` | Counts legacy lifetime accounts and how many are active | No: READ ONLY transaction | Read locks only |
| `04-count-empty-team-workspaces.sql` | Counts and lists team workspaces the old wizard made before payment and nobody used | No: READ ONLY transaction | Read locks only |

## How to run any of them

```bash
psql "$PRODUCTION_DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/api/scripts/owner-run/<file>.sql
```

Use your own production connection string. Do not paste it into a chat, a
commit or a file. `-v ON_ERROR_STOP=1` makes `psql` stop at the first error
instead of carrying on.

Run them from a machine that can reach the database (your laptop with the
credentials you already use, or `fly ssh console` on an API machine if `psql` is
there). Run 02, 03 and 04 first if you want to look before you change anything: they
touch nothing.

## 01: the index migration

**Why.** Four foreign keys on the graph tables are `ON DELETE CASCADE`. When a
graph node or edge is deleted, Postgres looks the deleted id up in each child
table, and the child columns lead no index (every existing index on these tables
starts with `owner_key`). So each delete reads the whole child table, every
account's rows included.

| Index | Serves |
|---|---|
| `idx_context_graph_evidence_node_id` on `context_graph_evidence (node_id)` | the cascade when a node is deleted, against its evidence |
| `idx_context_graph_evidence_edge_id` on `context_graph_evidence (edge_id)` | the cascade when an edge is deleted, against the evidence riding it |
| `idx_context_graph_edges_from_node_id` on `context_graph_edges (from_node_id)` | the cascade when a node is deleted, against edges that start there |
| `idx_context_graph_edges_to_node_id` on `context_graph_edges (to_node_id)` | the same, for edges that end there |

The callers are the vault job's phase 4 (one `DELETE` across every account's
stale candidates) and phase 5 (one `DELETE` per merged duplicate), `DELETE
/graph/nodes/:id`, edge merges, and account deletion. This is finding BLOCKED 16
of the round 2 write-up.

**Measured locally** (Postgres 15, 40 accounts, 40,000 nodes, 24,000 edges,
320,000 evidence rows):

| | Before | After |
|---|---|---|
| Delete one node, cascade checks | 38 ms | 1 ms |
| Delete one edge | 15 ms | 0.07 ms |
| Phase 4 delete of 10,120 candidate nodes | did not finish in over 2 minutes | 0.36 s |

Production will differ; the direction and the order of magnitude are the point.

**Non-locking.** Each statement is `CREATE INDEX CONCURRENTLY IF NOT EXISTS`. A
concurrent build takes only a lock that lets reads and writes carry on, so the
API keeps serving while it runs. Its price is time: it reads the table twice and
waits for any transaction that was already open when it started.

**Each statement stands alone, on purpose.** `CONCURRENTLY` cannot run inside a
transaction. Do not wrap the file in `BEGIN` / `COMMIT` and do not use
`psql -1` / `--single-transaction`; Postgres refuses it with `CREATE INDEX
CONCURRENTLY cannot run inside a transaction block`.

**How long.** Locally, on the 320,000-row evidence table: 0.16 s for the biggest
index, under 0.1 s for the others. A build is roughly linear in table size, so
budget seconds per million rows and minutes for tens of millions. It runs
longer than that if a long transaction is open (it waits for it), so run it when
the API is quiet and no long report or export is running. Writes to these tables
get slightly slower afterwards (one more index to keep on each insert); the
measurement above is what they buy.

**Safe to run twice.** `IF NOT EXISTS` skips an index that is already there.

**If a build fails or you cancel it.** Postgres leaves an INVALID index behind
and `IF NOT EXISTS` then skips it by name, so a second run would report success
over a useless index. Check after every run:

```sql
SELECT c.relname, i.indisvalid
FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
WHERE c.relname IN ('idx_context_graph_evidence_node_id', 'idx_context_graph_evidence_edge_id',
                    'idx_context_graph_edges_from_node_id', 'idx_context_graph_edges_to_node_id');
```

All four rows must exist with `indisvalid = t`. To clear an invalid one, run
`DROP INDEX CONCURRENTLY <name>;` (also outside a transaction) and run the file
again.

**Undo.** `DROP INDEX CONCURRENTLY <name>;` for any of them. Nothing else
depends on them.

**Not included, on purpose.** Foreign keys from `project_id` on nodes, edges,
evidence and sessions also lead no index, so deleting a whole project reads
those tables too (8 ms per project locally). They are not in this file: a
project delete is rare next to a capture, and an index on `context_graph_evidence`
taxes every capture. If deleting accounts with many projects ever feels slow,
add `CREATE INDEX CONCURRENTLY ... (project_id) WHERE project_id IS NOT NULL`
on those tables then.

## 02: cross-account rows

**What it counts.** In this schema `owner_key` is the workspace, and a graph row
and the project, node or edge it points at should carry the same `owner_key`.
The file prints one row per check, with how many rows disagree:

1. nodes, edges and evidence filed under a project another workspace owns
2. edges whose start or end node belongs to another workspace
3. evidence attached to a node or an edge of another workspace
4. resolved decision nodes filed under another owner's project: what the vault
   job's phase 6 could have applied across accounts

Then two lists: the owner pairs behind the node disagreements (top 50), and the
projects that check 4 could have reached (top 100). Both list ids and owner keys
only; no titles or text are read.

**Read-only.** The whole file runs in `BEGIN READ ONLY` and ends in `ROLLBACK`.
Postgres refuses any write inside it (`cannot execute DELETE in a read-only
transaction`). It takes only the read locks a `SELECT` takes, so it blocks
nothing. `SET LOCAL statement_timeout = '10min'` stops it if it runs away.

**How long.** It reads the three graph tables once each and joins to the
projects table. Locally, 75 ms over 320,000 evidence rows. Expect seconds up to
a minute or two at millions of rows. Running it during the day is fine.

**Reading the result.**

- **All 0:** clean. Nothing was ever filed across accounts, and phase 6 had
  nothing to apply.
- **Check 4 above 0:** before this release, phase 6 applied each such node to the
  other account's project, marking a decision there as resolved when its text
  matched. The briefs are encrypted, so SQL cannot say whether any decision was
  actually marked. Open the projects in the last list and read their recent
  decisions; a decision marked resolved that its owner did not resolve is the
  damage. The job now skips these rows and logs how many
  (`Phase 6 skipped N resolved decision nodes filed under another owner's
  project`), so nothing new is written.
- **Checks 1 to 3 above 0:** rows exist whose owner does not agree with what they
  point at. That is a finding, not proof of a leak: it says the ownership does
  not agree, not how it came about. Send the numbers back and it can be traced.

## 03: legacy lifetime accounts

**What it counts.** Workspaces whose `plan_tier` is `lifetime`, or that have a
`lifetime_activated_at` (the time a one-off lifetime payment was applied). A
refund on such an account now changes nothing (round 3, BLOCKED 21), so ending
access takes a database write; this tells you whether that question exists.

"Active" is not one thing, so the count row shows the measures side by side:

- `lifetime_accounts`: how many in all
- `plan_tier_is_lifetime`, `activated_once_now_on_another_plan`: how many are
  still on the tier, and how many were activated once and have moved off it
- `in_good_standing`: `subscription_status = 'active'` and not locked (neither
  the lockdown switch nor a dispute lock);
  `lifetime_tier_in_good_standing` is the same restricted to the tier
- `used_in_last_30_days`, `used_in_last_90_days`: a session was seen in the
  workspace in that window

Below it, each account (at most 200): workspace id, tier, status, lock,
activation time, creation time and last session. No names, emails or content.

**Read-only.** Same as 02. `lifetime_activated_at` is read through `to_jsonb`, so
the file still runs, and counts the column as never set, on a database that does
not have it.

**How long.** One pass over `organizations` plus one indexed lookup per lifetime
account. Under a second.

## 04: empty team workspaces

**What it counts.** Before this release, the new-team wizard created the team
workspace before the person paid. Somebody who started it and stopped left a
workspace behind. The file counts a workspace only when all of these hold:

- it is not anyone's personal workspace (no user has it as `users.org_id`);
- it has exactly one member row, and that member has not been removed (a
  workspace somebody joined and left is not counted);
- it has no project, archived or not;
- it has no Stripe customer and no Stripe subscription;
- it has no row in the billing ledger (`subscription_events`).

The first result is the count. The second lists each one (at most 500, oldest
first): workspace id, `created_at`, and the member's user id. No names and no
emails are read.

**Nothing is deleted.** The file is read-only, the same as 02 and 03. Whether to
remove any of these workspaces is a separate decision that has not been made;
this only tells you how many there are.

**How long.** One pass over `organizations` with an indexed lookup per row for
members, projects and the ledger. Under a second at thousands of workspaces.

## After you run them

After 01, run the invalid-index query above. After 02, 03 and 04, nothing changed, so
there is nothing to check.
