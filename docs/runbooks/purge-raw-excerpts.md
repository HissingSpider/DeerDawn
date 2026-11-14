# Runbook: remove the raw conversation excerpts already stored

**Who runs it:** the owner, by hand. Nothing runs it automatically: not the boot
migration, the scheduler, CI, a deploy hook or an npm script
(`apps/api/tests/unit/purge-raw-excerpts-wired-into-nothing.test.js` fails if
anything ever does).

**When:** after the API release that stops storing them is fully deployed on
every machine. The script refuses to run on a database that does not yet have
the `excerpt_kind` column that release adds.

**It cannot be undone.**

## What it removes, and what it keeps

Until this release, every capture stored the first 400 characters of the raw
conversation (`[user] …` / `[assistant] …`, secrets redacted, in plaintext) in
`context_graph_evidence.excerpt`, once for each entity the capture recorded.
`/pricing`, `/security` and the homepage say raw conversation text is never
kept.

The script replaces each of those excerpts with a line the product writes from
what the row records: the entity's type and title, and the name of the project
the row was written in. For example:

> Decision "Cap export retries at five attempts" recorded in Harbor Ledger from a captured conversation.

This is deliberately less than the line new rows get ("… recorded in Harbor
Ledger's recent decisions"). The live write path knows which section of the
brief it derived the entity from. An old row does not record that: the node's
type only suggests a section, and the node may have been merged or re-keyed
since. So the replacement line names no section. It does not name the tool
either: the tool stays on the row, and every reader shows it beside the line.
(`/seed` filed every imported conversation under `claude_web`, whichever product
it came from, so the tool column is not always the product the conversation
happened in.)

For each row it replaces, it writes two columns: `excerpt` (the line) and
`excerpt_kind` (set to `derived`). It writes no other column of the row and
deletes no evidence row. The evidence rows stay, so every entity still shows
where it came from. The row's tool, date, session, project and node stay as
they were.

It also deletes that row's **vector**: the rows in `context_graph_embeddings`
with `target_kind = 'evidence'` and `target_id` = the row's id (one per
embedding model). See [The evidence vectors](#the-evidence-vectors). That is the
only other thing it deletes, and nothing else in any other table changes.

## Which rows it replaces

A row is replaced only when **all three** hold:

1. `excerpt_kind IS NULL`: the row was written before this release. The new
   write path marks every row it writes, so nothing it wrote is ever re-judged,
   whatever its text says.
2. Its text opens with a bracketed role and a space (`^\[[^]]{1,40}] `): the
   shape the old path gave every excerpt it built from a conversation.
3. Its `tool` is one of the capture tools in the table below: the tool of the
   session that captured it.

The text alone is not enough. A person can title an entity `[WIP] Payments
service`, and `upsert_entities` stores it as `[WIP] Payments Service: <summary>`,
which opens exactly like a transcript. Before this was fixed, such an entity note
was replaced with a line saying it had been found in a tech stack, while the
count said entity notes were left alone.

So a row written by a person or by the product itself is **never** replaced,
whatever its text. A row in the transcript shape whose tool is not in the table
is **not** replaced either: it is counted under its own heading, by tool, so you
can decide what it is.

The same predicate, written once in the script, drives the count, the rows each
batch selects, the UPDATE's re-check and the verification query below.

## Who wrote the rows

From the code on `main` before this release. There were only ever two callers of
`store.addGraphEvidence`, and only these tool values reach it.

| Writer | `tool` on the row | What the text is | Replaced? |
|---|---|---|---|
| `recordGraphArtifacts`, called from `applyExtraction`: `/extraction` (local MCP `update_context`, the Stop hook's flush-session, the userscript), hosted `manage_memory` update, A2A `record-memory-update`, `/seed` | The capturing session's tool, held by the session schema to `claude_web`, `chatgpt_web`, `gemini`, `perplexity`, `cursor`, `claude_code`, `codex` (`/seed` always writes `claude_web`) | `[role] text` of the conversation's chunks, joined and clipped at 400: the raw conversation. For an update_context call, the one chunk is `[assistant] <the summary the agent sent>` | **Yes**, when in the transcript shape |
| the same, when the call carried no chunks | the same | The brief's `current_status`, `current_task` or `description`, or `Context updated for <project>`: brief text | No: counted as **unclassified** (unless it happens to open with `[x] `, see below) |
| `recordGraphArtifacts`, called from `resolve_question` (REST `/projects/:id/questions/resolve`, hosted resolve) | `manual` | `[user] <the question>` then `Decided: <the person's answer>` | **Never**, whatever its text |
| `upsert_entities` recording a sighting: an existing entity saved again from a second project (`recordSighting`) | `manual_workspace_entity` | `<title>: <summary>`, as the person typed it | **Never**, whatever its text |
| a hand-made node (`dashboard` is its source tool) | `dashboard` | No writer on `main` puts this on an evidence row; listed so that one ever found is left | **Never** |
| anything else | any other value | | Not replaced; counted under "looks like a conversation excerpt, written by a tool this script does not know" if in the transcript shape, else under unclassified |

**One case the tool cannot settle.** A capture-tool row written with no chunks
holds the brief's status. If that status itself opened with a bracketed tag
(`[WIP] migrating the ledger`), the row is in the transcript shape with a
capture tool, and it is replaced. What is lost is a copy of a status line; the
brief itself keeps the status. The dry run shows how many rows this could be:
under the raw count, "opening another bracketed label" counts the rows whose
opening is not `[user]` or `[assistant]`. If that number is not 0, look at those
rows by hand before you apply.

**Shapes the old writer could not produce.** The old path always began the
excerpt with the `[` of the first chunk (it trimmed the text), and a role longer
than 40 characters does not match the pattern. So a row that starts with
whitespace before `[role]`, or carries a role longer than 40 characters, was not
written by it as a conversation excerpt. A person may have typed it. Those rows
are left alone and counted as unclassified.

## What it leaves, and counts

- **derived lines**: rows the new code wrote, and rows an earlier run already replaced (`excerpt_kind` is set)
- **entity notes from upsert_entities**: every unmarked row with tool `manual_workspace_entity`, whatever its text
- **other rows a person or the product wrote**: tool `manual` (resolve_question) or `dashboard`
- **looks like a conversation excerpt, written by a tool this script does not know**: in the transcript shape, tool not in the table. Shown by tool name
- **unclassified**: every other unmarked row. These **can hold brief text**: the old fallback line is the project's status, task or description at the time of the capture, and a row in a shape the old writer could not produce may be something a person typed. Shown by tool name

Every row falls in exactly one of these and the raw count, so the counts add up
to the number of evidence rows.

## The evidence vectors

When the capture path wrote an evidence row, it also computed a vector from the
row's excerpt and stored it in `context_graph_embeddings` (`target_kind =
'evidence'`, `target_id` = the evidence id). For a raw row, that vector was
computed from the raw conversation. A vector is numbers, not text, and nothing
reads evidence vectors back. The owner's decision (journey scan round 4): the
script deletes them with the excerpts they came from.

Which vectors it deletes, and nothing else:

1. **The vector of each row it replaces in this run.** In the same transaction
   as the replacement, for exactly the ids the UPDATE returned (so the UPDATE's
   re-check is the delete's too). Evidence rows are never rewritten, so a raw
   row's vector can only have been computed from its raw text.
2. **The vector of a row an earlier run replaced**, when it can tell. The first
   version of this script (round 3) replaced excerpts and left their vectors. Such
   a row is marked, carries a capture tool, and holds the line this script
   writes, which always ends `recorded in <project> from a captured conversation.`
   The line the new write path writes never ends that way. Its vector is deleted
   only when it was written **before the first line the new write path wrote in
   that workspace**: the new path computes a vector only for a row it has just
   written, so no vector older than that can have come from a derived line. The
   script reads that moment for each workspace once, when it starts; a workspace
   with no new-path line yet is judged against the moment the run started.
   Checked in the same batch, under the same predicate the dry run counts with.

It **never** deletes:

- the vector of a row the new write path wrote (its line is not the replaced
  line);
- the vector of any row the script does not replace: entity notes, rows a person
  or the product wrote, rows from a tool it does not know, unclassified rows;
- a vector whose evidence row is gone (no row to judge);
- the vector of a replaced-looking row written **after** that workspace's first
  new-path line. The script cannot tell what it was computed from (a new-path
  line whose project name happened to end "from a captured conversation" would
  look the same), so it is left and counted under "cannot tell". Such rows
  arise when a machine still ran the old code after another had deployed the
  new one, and an earlier run then replaced what it wrote.

Node vectors (`target_kind = 'node'`) are not evidence vectors and are never
touched.

## 1. Dry run (changes nothing)

From `apps/api`, with the production `DATABASE_URL` in the environment:

```sh
node scripts/purge-raw-excerpts.js
```

The dry run reads inside a READ ONLY transaction. It prints counts only, never
an excerpt and never a workspace or person identifier. The only values from the
table it names are tool values:

```
Database: <name>

DRY RUN — nothing is changed.
  evidence rows                                                                  17
  raw conversation excerpts (would be replaced)                                  5  held by 1 workspace(s)
    by tool: claude_code 2, claude_web 1, codex 1, cursor 1
    opening [user] or [assistant]: 5; opening another bracketed label: 0
  derived lines (marked: written by the new path, or replaced)                   1
  entity notes from upsert_entities, whatever their text (left alone)            5
    by tool: manual_workspace_entity 5
  other rows a person or the product wrote (left alone)                          2
    by tool: dashboard 1, manual 1
  looks like a conversation excerpt, written by a tool this script does not know: left alone 1
    by tool: a2a 1
  unclassified (left alone; can hold brief text)                                 3
    by tool: claude_code 3
  raw conversation excerpts (would be replaced), by month written:
    2026-07  3
    2026-08  1
    2026-09  1
  workspaces by how many of them they hold:
    1-9      rows: 1 workspace(s)
  evidence vectors (context_graph_embeddings, target_kind evidence)              19
    of the raw excerpts above (would be deleted with them)                       6
    of rows an earlier run replaced, older than any new-path line (would be deleted) 0
    of rows an earlier run replaced, not older than every new-path line (left: cannot tell) 0
    of lines the new path wrote (never deleted)                                  1
    of rows this script does not replace (never deleted)                         11
    with no evidence row (left)                                                  1
```

(Here five raw rows hold six vectors: one row has a vector from a second
embedding model.)

What the numbers mean:

- **raw conversation excerpts**: exactly the rows the apply step will replace, by tool, and how many workspaces hold them
- **opening another bracketed label**: raw rows that do not open `[user]` or `[assistant]`. Imported conversations can use other roles, but a status that began with a tag lands here too (see above). If this is not 0, look before you apply
- **derived lines**: this number grows with every capture after the deploy. Right after the deploy it is small
- **entity notes / other rows a person or the product wrote**: never touched
- **looks like a conversation excerpt, from a tool this script does not know**: not touched. If this is not 0, a writer exists that this runbook does not list. Find it before deciding anything
- **unclassified**: not touched. If it is large, or includes a tool you did not expect, look at a few rows by hand
- **by month**: when the raw excerpts were written. Nothing should be dated after the deploy. If something is, a machine was still running the old code
- **by size**: how the raw rows are spread across workspaces, as counts only
- **evidence vectors**: every evidence vector, in exactly one class, so the classes add up to the total. The first two are what the apply step deletes; the rest it leaves. **of rows an earlier run replaced** is 0 unless the first version of this script already ran. **cannot tell** should be 0 or small: if it is not, those vectors stay, and deleting them is a separate decision

To try one workspace first, add `--owner=<owner_key>`.

## 2. Apply

```sh
node scripts/purge-raw-excerpts.js --apply
```

The script asks you to type the database name back. Any other answer, or no
answer, changes nothing. `--yes` skips the question.

It walks the table in primary-key order, in short transactions of 1000 rows by
default (`--batch=N`), pausing 50 ms between them (`--sleep-ms=N`). Each
transaction has a 2-second lock timeout and a 30-second statement timeout. If
another writer holds a row, the batch rolls back and is retried; the script
never waits on a lock. `--max-batches=N` stops after N transactions, which is a
way to do a little and look.

A batch is a window of rows **examined**, in primary-key order, not a number of
rows replaced. Each progress line says both, and the vectors the batch deleted:
`batch 12: examined 1000, replaced 7 (total replaced 84); deleted vectors: 7 of
rows replaced, 0 of rows replaced earlier`. A replaced row and its vector go in
the same transaction, so at no moment is a row replaced with its old vector
still there, or its vector deleted with the old excerpt still there. Evidence ids are random, so raw rows are spread evenly
through the table, and "replaced" per batch is roughly the raw share of the
table. A batch can replace 0 and still be progress: it examined its window.
`--max-batches=N` stops after N windows of examined rows, and the closing lines
say how many raw rows are still to replace.

You can interrupt it (Ctrl-C) or kill it at any time. A batch either commits
whole or rolls back whole, vectors included. Running it a second time after it
finishes changes nothing.

**A rerun starts from the beginning of the table, not where the last run
stopped.** It does not remember a position. It examines the rows the last run
already did (they are marked now, so it writes none of them: those batches print
`replaced 0`), then reaches the rows still to do. That is safe but not free.
Measured on a laptop against a local Postgres, with 300,000 rows of which 3,000
were raw and 3,000 replaced by an earlier run, and a vector for every row, at the
defaults (1000 rows a batch, 50 ms pause):

- a dry run: 3.1 s (it also classifies every evidence vector)
- a run stopped with `--max-batches=150`: 19.1 s, replaced 1,482, deleted 3,009
  vectors (1,482 of rows it replaced, 1,527 of rows replaced earlier)
- the rerun that finished it: 22.4 s over all 300 batches. The first 150
  printed `replaced 0` (re-examining what was done), and the remaining 1,518 were
  replaced after them, with their vectors and the other 1,473 earlier ones

So each rerun costs about as much as a full pass over the table: about 75 ms a
batch, of which 50 ms is the pause. On a few hundred thousand rows that is tens
of seconds. Against production over the network, expect each batch to take
longer than that. `--sleep-ms=0` removes the pause, and `--batch=5000` makes
fewer, larger transactions. With `--owner`, the window is read through the
owner index, so one workspace costs milliseconds whatever the size of the table.

When it finishes, it prints the counts again (the raw count should be 0), how
many rows it replaced, how many rows of each other kind it did not write, how
many evidence vectors it deleted (of rows replaced in this run, of rows an
earlier run replaced), and how many it left, by class.

## 3. Verify (read-only)

```sql
SELECT count(*) AS raw_excerpts_left FROM context_graph_evidence WHERE (excerpt_kind IS NULL AND excerpt ~ '^\[[^]]{1,40}] ' AND tool IN ('claude_code', 'cursor', 'codex', 'claude_web', 'chatgpt_web', 'gemini', 'perplexity'));
```

Expect `0`. And for the vectors of the rows it replaced in any run so far:

```sql
SELECT count(*) AS replaced_rows_with_a_vector FROM context_graph_embeddings v JOIN context_graph_evidence e ON e.evidence_id = v.target_id AND e.owner_key = v.owner_key WHERE v.target_kind = 'evidence' AND e.excerpt_kind IS NOT NULL AND e.tool IN ('claude_code', 'cursor', 'codex', 'claude_web', 'chatgpt_web', 'gemini', 'perplexity') AND e.excerpt LIKE '% recorded in % from a captured conversation.';
```

Expect the closing census's "cannot tell" count: those are the vectors it left
on purpose. Anything above it means a vector the script should have deleted.

A query on the text alone (`excerpt_kind IS NULL AND excerpt ~ '^\[[^]]{1,40}] '`,
without the tool list) does **not** return 0 afterwards, and should not: it also
counts the transcript-shaped rows the script rightly left, namely the entity
notes, resolve_question answers and `dashboard` rows that open with a bracketed
tag, and any row counted under "a tool this script does not know". That number
is at most the sum of those three counts in the closing census; it is not a
failure.

## After a rollback

If the API is rolled back to the release before this one, the old capture path
comes back with it, and writes raw excerpts again, with `excerpt_kind` empty.
The script leaves them for as long as the old code runs: they look exactly like
the rows it has not reached yet. After rolling forward again, **run the script
again** (dry run first; the by-month count shows the new rows).

## Backups still hold the old excerpts

The script changes the live database only. Backups taken before the run still
hold the old excerpts, in plaintext (the evidence table was never encrypted at
rest), until they age out.

What the repository says about backups:

- `/security` (`apps/marketing/src/pages/security.tsx`): "Neon for PostgreSQL with continuous backups and point-in-time recovery."
- `/privacy` (`apps/marketing/src/pages/privacy.tsx`, account deletion): "Encrypted backups age out on their normal cycle, no later than 30 days, unless a narrow legal obligation requires longer retention."
- `docs/SECURITY-AUDIT-2026-06.md` (Backups): no backup, point-in-time recovery or encryption posture is recorded anywhere in the repo or infra. The setup relies on managed Neon.

The length of Neon's point-in-time restore window is a setting on the Neon
project and is not recorded in this repository. Check it in the Neon console. A
restore to a moment before the run brings the excerpts back. If you restore,
run this script again afterwards.
