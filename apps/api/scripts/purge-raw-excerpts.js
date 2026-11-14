#!/usr/bin/env node
'use strict';

// Replace the raw conversation excerpts already stored in the knowledge graph
// with a line the product writes instead. RUN BY THE OWNER, BY HAND.
//
// Until 2026-09-28 every capture stored the first 400 characters of the raw
// conversation — `[user] ...\n[assistant] ...`, secrets redacted, in plaintext —
// in context_graph_evidence.excerpt, once per entity. /pricing, /security and
// the homepage say raw conversation text is never kept. The write path stopped
// storing it (services/graphEvidenceLine.js); this removes what is already
// there. Runbook: docs/runbooks/purge-raw-excerpts.md.
//
//   node scripts/purge-raw-excerpts.js                    # DRY RUN: counts only, changes nothing
//   node scripts/purge-raw-excerpts.js --apply            # replace; asks you to type the database name
//   node scripts/purge-raw-excerpts.js --apply --yes      # replace without asking
//
//   --batch=N        rows examined per transaction (default 1000, at most 5000)
//   --sleep-ms=N     pause between transactions (default 50)
//   --max-batches=N  stop after N transactions (try a little first; rerun to go on)
//   --owner=KEY      only one workspace's rows (to try it on one account first)
//
// WHAT IT CHANGES: on each row it judges raw, `excerpt` becomes a line the
// product writes and `excerpt_kind` becomes 'derived' — the marker the new write
// path sets, so a second run passes over the row. No other column of any
// evidence row, and no evidence row is deleted. It cannot be undone.
//
// AND THE OLD VECTORS (journey scan round 4). Each evidence row's vector in
// context_graph_embeddings (target_kind 'evidence', target_id = the row's id)
// was computed from its excerpt, so for a raw row, from the raw conversation.
// Nothing reads evidence vectors back. The script deletes the vector of each
// row it replaces, in the same transaction as the replacement, and nothing
// else in that table:
//
//   - a row replaced in THIS run: its vector was computed when the row was
//     written, and evidence rows are never rewritten, so from the raw text.
//     Deleted with the replacement, for the ids the UPDATE itself returned.
//   - a row an EARLIER run replaced (the round 3 version of this script left the
//     vectors): its excerpt is the line this script writes, so it opens "<Type>"
//     and ends "recorded in <project> from a captured conversation." A vector is
//     deleted only when it was written before the first line the new write path
//     ever wrote in that workspace: the new path computes a vector only for a
//     row it has just written, so no vector older than that can come from a
//     derived line. A replaced-shaped row whose vector is not that old is LEFT,
//     and counted: the script cannot tell what it was computed from.
//   - every other vector: rows the new path wrote, rows this script does not
//     replace (entity notes, rows a person wrote, unclassified), and vectors whose
//     evidence row is gone. Never deleted.
//
// WHICH ROWS. A row is replaced only when the script is sure, on more than its
// text, that the old capture path wrote it as a conversation excerpt. ALL of:
//
//   1. excerpt_kind IS NULL: written before the change. Every row the new path
//      writes is marked, so nothing it wrote is re-judged, whatever it says.
//   2. its text opens with a bracketed role and a space, `[<role>] `: the shape
//      the old path gave every excerpt it built from a conversation's chunks.
//   3. its tool is one of CAPTURE_TOOLS below: the tool of the session that
//      captured it, the only tool value the old capture path could write.
//
// The text alone is not enough. A person can title an entity `[WIP] Payments
// service`, and upsert_entities files it as `<title>: <summary>`: the same
// opening. So a row written by a person or by the product itself (tool
// manual_workspace_entity, manual, dashboard) is NEVER replaced, whatever its
// text; and a row in the raw shape whose tool this script does not know is left
// too, counted under its own heading by tool, for the owner to decide.
//
// Who wrote which rows, from the code on main before the change (the runbook
// has the full table):
//
//   recordGraphArtifacts from applyExtraction (/extraction, update_context,
//     flush-session, hosted update, /seed): tool = the capturing session's tool,
//     one of CAPTURE_TOOLS. Text: `[role] text` of the conversation's chunks;
//     with no chunks, the brief's status, task or description, or "Context
//     updated for <project>".                                         REPLACED
//     when in the raw shape; otherwise counted as unclassified and left.
//   recordGraphArtifacts from resolve_question: tool 'manual'. Text: the
//     question and the person's answer.                                   NEVER
//   upsert_entities, a sighting from a second project (recordSighting): tool
//     'manual_workspace_entity'. Text: "<title>: <summary>", as typed.   NEVER
//
// The predicate is written ONCE (rawExcerptSql) and used by the census, the
// batch's SELECT, the UPDATE's re-check and the verification query. Four copies
// of a filter is how three of them came to disagree: in journey scan round 4 an
// entity note titled "[WIP] ..." was replaced while the census counted it as
// left alone.
//
// HOW IT IS SAFE. A dry run reads inside a READ ONLY transaction. An apply
// walks the table by primary key in short transactions, each with a lock
// timeout: a row another writer holds makes the batch roll back and retry, never
// wait. The UPDATE re-checks the predicate, so a second run, a concurrent run or
// a run after an interruption changes nothing twice. Interrupt it (Ctrl-C) and
// it stops after the batch in hand; kill it and the open batch rolls back.
// Either way, rerunning finishes the job: a rerun walks the table from the
// start again (it keeps no position), examining the rows already done and
// writing none of them.
//
// It prints counts only: never an excerpt, never a vector, never a workspace or
// person id. The only values from the table it names are tool values.
//
// NOT WIRED INTO ANYTHING. Not the boot migration, the scheduler, CI, a deploy
// hook or an npm script; tests/unit/purge-raw-excerpts-wired-into-nothing.test.js
// fails if it ever is.

const readline = require('readline');
const db = require('../src/config/db');
const { redactSecrets } = require('../src/utils/secretRedaction');
const { normalizeGraphNodeTitle } = require('../src/store/graphNodeTitle');
const {
  EXCERPT_KIND_DERIVED,
  RAW_TRANSCRIPT_SQL_PATTERN,
  deriveReplacedExcerptLine,
} = require('../src/services/graphEvidenceLine');

// The tools the old capture path stamped on the rows it wrote: the session's
// tool, which ContextSessionSchema holds to TOOL_VALUES (packages/shared-context).
// Written out rather than imported: this is what the OLD writer could produce,
// and a tool added after the change can only ever write marked rows.
const CAPTURE_TOOLS = Object.freeze(['claude_code', 'cursor', 'codex', 'claude_web', 'chatgpt_web', 'gemini', 'perplexity']);
// A person's own words, filed by upsert_entities.
const ENTITY_NOTE_TOOL = 'manual_workspace_entity';
// A person's or the product's words, by other writers: resolve_question's
// question and answer ('manual'), and the hand-made node's tool ('dashboard').
const HAND_OR_PRODUCT_TOOLS = Object.freeze(['manual', 'dashboard']);

for (const value of [...CAPTURE_TOOLS, ENTITY_NOTE_TOOL, ...HAND_OR_PRODUCT_TOOLS]) {
  if (!/^[a-z_]+$/.test(value)) throw new Error(`tool list entry is not a plain name: ${value}`);
}
if (RAW_TRANSCRIPT_SQL_PATTERN.includes('\'')) throw new Error('the raw pattern cannot be written as a SQL literal');
const sqlList = (values) => values.map((value) => `'${value}'`).join(', ');
const rawShapeSql = (column) => `${column} ~ '${RAW_TRANSCRIPT_SQL_PATTERN}'`;

// THE predicate: this row is a raw conversation excerpt the old capture path
// wrote, and may be replaced. Constants only, so it is one literal that the owner
// can also paste into psql. `alias` qualifies the columns inside a join.
function rawExcerptSql(alias = '') {
  const c = alias ? `${alias}.` : '';
  return `(${c}excerpt_kind IS NULL AND ${rawShapeSql(`${c}excerpt`)} AND ${c}tool IN (${sqlList(CAPTURE_TOOLS)}))`;
}

// Every row falls in exactly one class, so the census adds up to the table.
const CLASS_SQL = `CASE
      WHEN excerpt_kind IS NOT NULL THEN 'derived'
      WHEN ${rawExcerptSql()} THEN 'raw'
      WHEN tool = '${ENTITY_NOTE_TOOL}' THEN 'entity_note'
      WHEN tool IN (${sqlList(HAND_OR_PRODUCT_TOOLS)}) THEN 'hand'
      WHEN ${rawShapeSql('excerpt')} THEN 'raw_shape_unknown_tool'
      ELSE 'unclassified'
    END`;
const CLASSES = ['raw', 'derived', 'entity_note', 'hand', 'raw_shape_unknown_tool', 'unclassified'];

const VERIFY_SQL = `SELECT count(*) AS raw_excerpts_left FROM context_graph_evidence WHERE ${rawExcerptSql()};`;

// ─── The evidence vectors ───────────────────────────────────────────────────
//
// The line this script writes (graphEvidenceLine.deriveReplacedExcerptLine)
// always ends like this; the line the new write path writes never does.
const REPLACED_LINE_LIKE = '% recorded in % from a captured conversation.';
if (REPLACED_LINE_LIKE.includes('\'') || REPLACED_LINE_LIKE.includes('_')) throw new Error('the replaced-line pattern cannot be written as a LIKE literal');

// A row an earlier run replaced: marked, a capture tool, and the line this
// script writes. `e` is the evidence alias.
function replacedEarlierSql(e) {
  return `(${e}.excerpt_kind IS NOT NULL AND ${e}.tool IN (${sqlList(CAPTURE_TOOLS)}) AND ${e}.excerpt LIKE '${REPLACED_LINE_LIKE}')`;
}

// Per workspace, when the new write path first wrote a line there: the oldest
// marked row that is not a line this script wrote. Read ONCE, when the run
// starts (firstDerivedLines), and handed to every query as two arrays, so the
// census and every batch judge against the same moments, and a batch does not
// re-scan the table. A line written while the script runs cannot move a
// workspace's first moment earlier; a workspace with none yet is judged against
// the run's start (earlierVectorSql). Joined as `f` on owner_key.
function firstDerivedLineCte(keysParam, atsParam) {
  return `first_derived AS (
      SELECT * FROM unnest(${keysParam}::text[], ${atsParam}::timestamptz[]) AS f(owner_key, first_at))`;
}

async function firstDerivedLines(client, args) {
  const params = [];
  const rows = (await client.query(
    `SELECT owner_key, min(created_at) AS first_at
       FROM context_graph_evidence
      WHERE excerpt_kind IS NOT NULL AND NOT (excerpt LIKE '${REPLACED_LINE_LIKE}')${scope(args, params)}
      GROUP BY owner_key`,
    params
  )).rows;
  return new Map(rows.map((row) => [row.owner_key, row.first_at.toISOString()]));
}

// The two arrays for firstDerivedLineCte, for the given workspaces (all, when
// none are given).
function firstDerivedArrays(args, owners = null) {
  const keys = owners ? [...new Set(owners)].filter((key) => args.firstDerived.has(key)) : [...args.firstDerived.keys()];
  return [keys, keys.map((key) => args.firstDerived.get(key))];
}

// THE vector predicate: this vector belongs to a row an earlier run replaced,
// and was written before any line the new path wrote in its workspace, so it
// cannot have been computed from one. `runStart` is a parameter holding the
// moment the run began: a workspace with no new-path line yet is judged against
// it, so a vector written while the script runs is never deleted.
function earlierVectorSql(e, v, f, runStart) {
  return `(${replacedEarlierSql(e)} AND ${v}.updated_at < LEAST(COALESCE(${f}.first_at, ${runStart}::timestamptz), ${runStart}::timestamptz))`;
}

// Every evidence vector falls in exactly one class.
function vectorClassSql(runStart) {
  return `CASE
      WHEN e.evidence_id IS NULL THEN 'no_row'
      WHEN ${rawExcerptSql('e')} THEN 'raw'
      WHEN ${earlierVectorSql('e', 'v', 'f', runStart)} THEN 'replaced_earlier'
      WHEN ${replacedEarlierSql('e')} THEN 'replaced_unsure'
      WHEN e.excerpt_kind IS NOT NULL THEN 'derived'
      ELSE 'not_replaced'
    END`;
}
const VECTOR_CLASSES = ['raw', 'replaced_earlier', 'replaced_unsure', 'derived', 'not_replaced', 'no_row'];

function parseArgs(argv) {
  const args = { apply: false, yes: false, batch: 1000, sleepMs: 50, maxBatches: 0, owner: null, help: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--apply') args.apply = true;
    else if (arg === '--yes') args.yes = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg.startsWith('--batch=')) args.batch = Math.min(5000, Math.max(1, parseInt(arg.slice(8), 10) || 1000));
    else if (arg.startsWith('--sleep-ms=')) args.sleepMs = Math.max(0, parseInt(arg.slice(11), 10) || 0);
    else if (arg.startsWith('--max-batches=')) args.maxBatches = Math.max(0, parseInt(arg.slice(14), 10) || 0);
    else if (arg.startsWith('--owner=')) args.owner = arg.slice(8) || null;
    else throw new Error(`unknown argument: ${arg} (see --help)`);
  }
  return args;
}

const HELP = `Replace raw conversation excerpts in context_graph_evidence with derived lines.

  node scripts/purge-raw-excerpts.js                  dry run: counts only, changes nothing
  node scripts/purge-raw-excerpts.js --apply          replace; asks you to type the database name
  node scripts/purge-raw-excerpts.js --apply --yes    replace without asking

  --batch=N  --sleep-ms=N  --max-batches=N  --owner=KEY

Runbook: docs/runbooks/purge-raw-excerpts.md`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The owner filter, when there is one, as the next positional parameter.
function scope(args, params, alias = '') {
  if (!args.owner) return '';
  params.push(args.owner);
  return ` AND ${alias}owner_key = $${params.length}`;
}

async function hasMarkerColumn(client) {
  const res = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'context_graph_evidence' AND column_name = 'excerpt_kind'`
  );
  return res.rows.length > 0;
}

async function census(client, args) {
  const classParams = [];
  const rows = (await client.query(
    `SELECT class, COALESCE(tool, '(none)') AS tool, count(*)::bigint AS n
       FROM (SELECT ${CLASS_SQL} AS class, tool
               FROM context_graph_evidence
              WHERE TRUE${scope(args, classParams)}) classified
      GROUP BY 1, 2
      ORDER BY 1, 3 DESC, 2`,
    classParams
  )).rows;
  const classes = Object.fromEntries(CLASSES.map((name) => [name, { n: 0, byTool: [] }]));
  let total = 0;
  for (const row of rows) {
    const n = Number(row.n);
    classes[row.class].n += n;
    classes[row.class].byTool.push({ tool: row.tool, n });
    total += n;
  }

  const rawParams = [];
  const raw = (await client.query(
    `SELECT count(DISTINCT owner_key)::bigint AS owners,
            count(*) FILTER (WHERE excerpt ~ '^\\[(user|assistant)\\] ')::bigint AS usual_label
       FROM context_graph_evidence
      WHERE ${rawExcerptSql()}${scope(args, rawParams)}`,
    rawParams
  )).rows[0];

  const monthParams = [];
  const byMonth = (await client.query(
    `SELECT COALESCE(to_char(date_trunc('month', created_at), 'YYYY-MM'), 'no date') AS month, count(*)::bigint AS n
       FROM context_graph_evidence
      WHERE ${rawExcerptSql()}${scope(args, monthParams)}
      GROUP BY 1 ORDER BY 1`,
    monthParams
  )).rows;

  const ownerParams = [];
  const byOwnerSize = (await client.query(
    `SELECT bucket, count(*)::bigint AS owners FROM (
       SELECT CASE WHEN count(*) < 10 THEN '1-9' WHEN count(*) < 100 THEN '10-99'
                   WHEN count(*) < 1000 THEN '100-999' ELSE '1000+' END AS bucket
         FROM context_graph_evidence
        WHERE ${rawExcerptSql()}${scope(args, ownerParams)}
        GROUP BY owner_key) per_owner
      GROUP BY bucket ORDER BY min(CASE bucket WHEN '1-9' THEN 1 WHEN '10-99' THEN 2 WHEN '100-999' THEN 3 ELSE 4 END)`,
    ownerParams
  )).rows;

  const vectors = Object.fromEntries(VECTOR_CLASSES.map((name) => [name, 0]));
  let vectorTotal = 0;
  if (args.hasVectors) {
    const vectorParams = [args.runStart, ...firstDerivedArrays(args)];
    const ownerOnly = scope(args, vectorParams, 'v.');
    const rows2 = (await client.query(
      `WITH ${firstDerivedLineCte('$2', '$3')}
       SELECT class, count(*)::bigint AS n
         FROM (SELECT ${vectorClassSql('$1')} AS class
                 FROM context_graph_embeddings v
                 LEFT JOIN context_graph_evidence e ON e.evidence_id = v.target_id AND e.owner_key = v.owner_key
                 LEFT JOIN first_derived f ON f.owner_key = v.owner_key
                WHERE v.target_kind = 'evidence'${ownerOnly}) classified
        GROUP BY class`,
      vectorParams
    )).rows;
    for (const row of rows2) {
      vectors[row.class] = Number(row.n);
      vectorTotal += Number(row.n);
    }
  }

  return {
    total,
    classes,
    rawOwners: Number(raw.owners),
    rawUsualLabel: Number(raw.usual_label),
    byMonth,
    byOwnerSize,
    vectors,
    vectorTotal,
    hasVectors: Boolean(args.hasVectors),
  };
}

const RAW_HEADING = {
  dry: 'raw conversation excerpts (would be replaced)',
  before: 'raw conversation excerpts (to replace)',
  after: 'raw conversation excerpts (still to replace)',
};

const VECTOR_HEADING = {
  dry: 'of the raw excerpts above (would be deleted with them)',
  before: 'of the raw excerpts above (to delete with them)',
  after: 'of raw excerpts still to replace (to delete with them)',
};
const EARLIER_HEADING = {
  dry: 'of rows an earlier run replaced, older than any new-path line (would be deleted)',
  before: 'of rows an earlier run replaced, older than any new-path line (to delete)',
  after: 'of rows an earlier run replaced, older than any new-path line (still to delete)',
};

function printCensus(label, phase, { total, classes, rawOwners, rawUsualLabel, byMonth, byOwnerSize, vectors, vectorTotal, hasVectors }) {
  const n = (value) => Number(value || 0).toLocaleString('en-US');
  const line = (heading, value, extra = '') => console.log(`  ${heading.padEnd(78)} ${n(value)}${extra}`);
  const tools = (cls) => {
    if (classes[cls].byTool.length) console.log(`    by tool: ${classes[cls].byTool.map((row) => `${row.tool} ${n(row.n)}`).join(', ')}`);
  };
  console.log(`\n${label}`);
  line('evidence rows', total);
  line(RAW_HEADING[phase], classes.raw.n, `  held by ${n(rawOwners)} workspace(s)`);
  tools('raw');
  if (classes.raw.n) {
    console.log(`    opening [user] or [assistant]: ${n(rawUsualLabel)}; opening another bracketed label: ${n(classes.raw.n - rawUsualLabel)}`);
  }
  line('derived lines (marked: written by the new path, or replaced)', classes.derived.n);
  line('entity notes from upsert_entities, whatever their text (left alone)', classes.entity_note.n);
  tools('entity_note');
  line('other rows a person or the product wrote (left alone)', classes.hand.n);
  tools('hand');
  line('looks like a conversation excerpt, written by a tool this script does not know: left alone', classes.raw_shape_unknown_tool.n);
  tools('raw_shape_unknown_tool');
  line('unclassified (left alone; can hold brief text)', classes.unclassified.n);
  tools('unclassified');
  if (byMonth.length) {
    console.log(`  ${RAW_HEADING[phase]}, by month written:`);
    for (const row of byMonth) console.log(`    ${row.month}  ${n(row.n)}`);
  }
  if (byOwnerSize.length) {
    console.log('  workspaces by how many of them they hold:');
    for (const row of byOwnerSize) console.log(`    ${row.bucket.padEnd(8)} rows: ${n(row.owners)} workspace(s)`);
  }
  if (!hasVectors) {
    console.log('  evidence vectors: there is no context_graph_embeddings table here');
    return;
  }
  const vline = (heading, value) => console.log(`    ${heading.padEnd(76)} ${n(value)}`);
  line('evidence vectors (context_graph_embeddings, target_kind evidence)', vectorTotal);
  vline(VECTOR_HEADING[phase], vectors.raw);
  vline(EARLIER_HEADING[phase], vectors.replaced_earlier);
  vline('of rows an earlier run replaced, not older than every new-path line (left: cannot tell)', vectors.replaced_unsure);
  vline('of lines the new path wrote (never deleted)', vectors.derived);
  vline('of rows this script does not replace (never deleted)', vectors.not_replaced);
  vline('with no evidence row (left)', vectors.no_row);
}

async function confirmDatabaseName(dbName) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  try {
    const answer = await new Promise((resolve) => {
      let settled = false;
      rl.question(`\nThis cannot be undone. Type the database name (${dbName}) to go ahead: `, (value) => { settled = true; resolve(value); });
      rl.once('close', () => { if (!settled) resolve(''); });
    });
    return String(answer || '').trim() === dbName;
  } finally {
    rl.close();
  }
}

function lineFor(row) {
  const nodeType = row.node_type || 'entity';
  const title = row.node_type ? normalizeGraphNodeTitle(row.title, row.node_type, row.metadata || {}) : '';
  // Through the same redaction the store gives every excerpt it writes.
  return redactSecrets(deriveReplacedExcerptLine({ nodeType, title, projectName: row.project_name }));
}

// One transaction: the next `batch` rows by primary key after `cursor`, of
// which the ones the predicate calls raw are replaced. Returns where the next
// one starts.
async function replaceBatch(client, args, cursor) {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL lock_timeout = \'2s\'');
    await client.query('SET LOCAL statement_timeout = \'30s\'');
    const params = [cursor, args.batch];
    const ownerFilter = scope(args, params);
    const windowRows = (await client.query(
      `SELECT evidence_id, owner_key FROM context_graph_evidence
        WHERE evidence_id > $1${ownerFilter}
        ORDER BY evidence_id
        LIMIT $2`,
      params
    )).rows;
    if (!windowRows.length) {
      await client.query('COMMIT');
      return { next: null, examined: 0, replaced: 0, vectorsReplaced: 0, vectorsEarlier: 0 };
    }
    const ids = windowRows.map((row) => row.evidence_id);

    // The vectors of rows an EARLIER run replaced, re-checked here under the
    // same predicate the census counts with. Before this batch's UPDATE, so a
    // row replaced below is not judged twice.
    let vectorsEarlier = 0;
    if (args.hasVectors) {
      const deleted = await client.query(
        `WITH ${firstDerivedLineCte('$3', '$4')}
         DELETE FROM context_graph_embeddings v
          USING context_graph_evidence e
          LEFT JOIN first_derived f ON f.owner_key = e.owner_key
          WHERE v.target_kind = 'evidence'
            AND v.target_id = e.evidence_id AND v.owner_key = e.owner_key
            AND e.evidence_id = ANY($1::text[])
            AND ${earlierVectorSql('e', 'v', 'f', '$2')}`,
        [ids, args.runStart, ...firstDerivedArrays(args, windowRows.map((row) => row.owner_key))]
      );
      vectorsEarlier = deleted.rowCount;
    }

    const candidates = (await client.query(
      `SELECT e.evidence_id, n.node_type, n.title, n.metadata, p.project_name
         FROM context_graph_evidence e
         LEFT JOIN context_graph_nodes n ON n.node_id = e.node_id
         LEFT JOIN context_projects p ON p.project_id = e.project_id
        WHERE e.evidence_id = ANY($1::text[])
          AND ${rawExcerptSql('e')}`,
      [ids]
    )).rows;
    let replaced = 0;
    let vectorsReplaced = 0;
    if (candidates.length) {
      const res = await client.query(
        `UPDATE context_graph_evidence e
            SET excerpt = m.line, excerpt_kind = $3
           FROM unnest($1::text[], $2::text[]) AS m(evidence_id, line)
          WHERE e.evidence_id = m.evidence_id
            AND ${rawExcerptSql('e')}
          RETURNING e.evidence_id, e.owner_key`,
        [candidates.map((row) => row.evidence_id), candidates.map(lineFor), EXCERPT_KIND_DERIVED]
      );
      replaced = res.rowCount;
      // The vector of each row this UPDATE replaced, and of no other: the ids
      // are the ones it returned, so the UPDATE's re-check is this one's too.
      if (args.hasVectors && res.rows.length) {
        const deleted = await client.query(
          `DELETE FROM context_graph_embeddings v
            USING unnest($1::text[], $2::text[]) AS r(evidence_id, owner_key)
            WHERE v.target_kind = 'evidence' AND v.target_id = r.evidence_id AND v.owner_key = r.owner_key`,
          [res.rows.map((row) => row.evidence_id), res.rows.map((row) => row.owner_key)]
        );
        vectorsReplaced = deleted.rowCount;
      }
    }
    await client.query('COMMIT');
    return { next: ids[ids.length - 1], examined: ids.length, replaced, vectorsReplaced, vectorsEarlier };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function readCensus(client, args) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    return await census(client, args);
  } finally {
    await client.query('ROLLBACK');
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  const client = await db.pool.connect();
  let stopRequested = false;
  const onSignal = () => {
    if (stopRequested) return;
    stopRequested = true;
    console.log('\nStopping after the batch in hand. Nothing is left half-done; rerun to carry on.');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const dbName = (await client.query('SELECT current_database() AS name')).rows[0].name;
    console.log(`Database: ${dbName}${args.owner ? ' (one workspace only)' : ''}`);

    if (!(await hasMarkerColumn(client))) {
      console.error('The excerpt_kind column is not there yet. Deploy the API change that adds it first (it is added at');
      console.error('boot): until then the old code is still writing raw excerpts, and this script could not tell a row');
      console.error('it replaced from one still to do. Nothing was changed.');
      return 1;
    }

    args.hasVectors = (await client.query('SELECT to_regclass(\'context_graph_embeddings\') IS NOT NULL AS present')).rows[0].present;
    // The moment the run began, from the database's clock (the clock that
    // stamps every vector): see earlierVectorSql.
    args.runStart = (await client.query('SELECT now() AS t')).rows[0].t.toISOString();
    args.firstDerived = await firstDerivedLines(client, args);

    const before = await readCensus(client, args);
    printCensus(args.apply ? 'Before:' : 'DRY RUN — nothing is changed.', args.apply ? 'before' : 'dry', before);

    if (!args.apply) {
      console.log('\nTo replace the raw excerpts: node scripts/purge-raw-excerpts.js --apply');
      console.log(`To check at any time (read-only):\n  ${VERIFY_SQL}`);
      return 0;
    }

    if (before.classes.raw.n === 0 && before.vectors.replaced_earlier === 0) {
      console.log('\nNo raw excerpts to replace, and no old vectors to delete. Nothing was changed.');
      return 0;
    }

    if (!args.yes && !(await confirmDatabaseName(dbName))) {
      console.log('Not confirmed. Nothing was changed.');
      return 1;
    }

    let cursor = '';
    let batches = 0;
    let replaced = 0;
    let vectorsReplaced = 0;
    let vectorsEarlier = 0;
    let examined = 0;
    let lockRetries = 0;
    let finished = false;
    while (!stopRequested) {
      if (args.maxBatches && batches >= args.maxBatches) break;
      let result;
      try {
        result = await replaceBatch(client, args, cursor);
      } catch (err) {
        // 55P03 lock_not_available: another writer holds a row. The batch rolled
        // back whole; wait and try the same window again.
        if (err.code === '55P03' && lockRetries < 5) {
          lockRetries += 1;
          await sleep(1000 * lockRetries);
          continue;
        }
        throw err;
      }
      lockRetries = 0;
      if (result.next === null) {
        finished = true;
        break;
      }
      batches += 1;
      examined += result.examined;
      replaced += result.replaced;
      vectorsReplaced += result.vectorsReplaced;
      vectorsEarlier += result.vectorsEarlier;
      cursor = result.next;
      console.log(`  batch ${batches}: examined ${result.examined}, replaced ${result.replaced} (total replaced ${replaced}); deleted vectors: ${result.vectorsReplaced} of rows replaced, ${result.vectorsEarlier} of rows replaced earlier`);
      if (args.sleepMs) await sleep(args.sleepMs);
    }

    const after = await readCensus(client, args);
    printCensus('After:', 'after', after);

    const c = after.classes;
    console.log(`\n${finished ? 'Done' : 'Stopped early'}: replaced ${replaced} raw excerpt(s) with derived lines, in ${batches} batch(es) over ${examined} row(s) examined.`);
    console.log(`Only \`excerpt\` and \`excerpt_kind\` of those ${replaced} row(s) were written.`);
    if (after.hasVectors) {
      const v = after.vectors;
      console.log(`Deleted ${vectorsReplaced + vectorsEarlier} evidence vector(s): ${vectorsReplaced} of the rows replaced in this run, `
        + `${vectorsEarlier} of rows an earlier run replaced. No other row of any table was deleted.`);
      console.log(`Evidence vectors left, counted now: ${v.derived} of lines the new path wrote, ${v.not_replaced} of rows this script does not replace, `
        + `${v.replaced_unsure} of replaced rows it cannot tell were computed from the old text, ${v.no_row} with no evidence row.`);
    }
    console.log(`Not written by this run: ${before.classes.derived.n} row(s) already marked when it began; and, counted now, `
      + `${c.entity_note.n} entity note(s), ${c.hand.n} other row(s) a person or the product wrote, `
      + `${c.raw_shape_unknown_tool.n} conversation-shaped row(s) from a tool this script does not know, `
      + `${c.unclassified.n} unclassified row(s).`);
    if (c.raw.n) console.log(`${c.raw.n} raw excerpt(s) still to replace. Rerun the same command to finish: it walks the table from the start again, and rows already replaced are examined but not written.`);
    console.log(`Verify (read-only; expect 0${args.owner ? ' for this workspace, and across the table once every workspace has been run' : ''}):\n  ${VERIFY_SQL}`);
    console.log('This cannot be undone. Backups taken before this run still hold the old excerpts until they age out.');
    return 0;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    client.release();
  }
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
      return db.pool.end?.();
    })
    .catch(async (err) => {
      console.error(`[purge-raw-excerpts] failed: ${err.message}`);
      console.error('Nothing is left half-done: the batch in hand rolled back. Rerun to carry on.');
      await db.pool.end?.().catch(() => {});
      process.exit(1);
    });
}

module.exports = {
  parseArgs,
  lineFor,
  rawExcerptSql,
  replacedEarlierSql,
  REPLACED_LINE_LIKE,
  VERIFY_SQL,
  CAPTURE_TOOLS,
  ENTITY_NOTE_TOOL,
  HAND_OR_PRODUCT_TOOLS,
};
