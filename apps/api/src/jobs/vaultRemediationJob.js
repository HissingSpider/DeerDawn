const { performance } = require('node:perf_hooks');
const db = require('../config/db');
const store = require('../store/contextSyncStore');

// ─── The job runs on the API's own event loop ───────────────────────────────
//
// The scheduler runs this inside the API process, 10 seconds after every boot
// (so after every deploy) and every 24 hours after that. For as long as it
// computes between two awaits, no request is answered: not sign-in, not the
// hosted MCP, not /healthz. Phase 5 compared every decision node of a project
// with every node it had kept before it and awaited only on a merge, so 5,000
// decisions in one project held the loop for 14 s and 20,000 for 13 minutes;
// Fly's health check gives up after 10 s, and with every query fast the DB
// breaker never tripped, so nothing said why (journey r2).
//
// So no loop here runs long: every loop over rows or projects hands the event
// loop back once it has held it for SLICE_MS (pacer.breathe), and a run stops
// at its budget, between units of work, and leaves the rest to the next run.
// Every phase selects only what is still undone, so the next run continues
// where this one stopped rather than repeating it. The budget sits under the
// scheduler's lock (jobs/scheduler.js LOCK_TTL, 300 s): the lock lapses then
// whether or not the run is done, and another machine may start its own, so
// 240 s leaves a minute for the unit of work in flight and the release. The
// next run is the next 24-hour tick, or the next boot.
const SLICE_MS = 20;
const RUN_BUDGET_MS = 240 * 1000;

//
// breathe waits on a timer, not setImmediate: an immediate queued from an I/O
// callback — where the work resumes after every query — runs in that same turn's
// check phase, before the loop polls again, so two slices ran back to back and
// requests waited ~40 ms. A timer fires only after the loop has polled.
function pacer(deadline) {
  let sliceStartedAt = performance.now();
  return {
    // The budget is spent: stop here, before the next unit of work.
    spent: () => Date.now() >= deadline,
    async breathe() {
      if (performance.now() - sliceStartedAt < SLICE_MS) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
      sliceStartedAt = performance.now();
    },
  };
}

// ─── Project context is ENCRYPTED AT REST; this job reads and writes it ─────
//
// Phases 2, 6 and 7 were SQL over `context->'recent_decisions'` and
// `context->>'blocking_issue'`, and wrote back with jsonb_set (2 and 7 are
// retired now, see the runner; 6 remains). With
// ENCRYPTION_MASTER_KEY set — production — context is stored as { _enc }, so
// every JSON path was NULL: the phases found nothing and reported "0 repaired"
// every night, a silent no-op that looked like a clean vault. (And had they found
// a row, jsonb_set would have written PLAINTEXT keys beside the ciphertext, which
// every reader ignores.) So they now read through the store, which decrypts, one
// owner-scoped listing at a time, and write through saveProject, which
// re-encrypts — guarded on the version read, so a user's write that landed in
// between is never overwritten by maintenance. updated_at is carried through
// unchanged: a repair is not activity.
const MAINTENANCE_ACTOR = { type: 'system', id: 'vault-remediation' };

// Every live project of each owner, decrypted. A context that could not be
// decrypted is skipped — saveProject would refuse it anyway, and a repair job
// must never be the thing that touches ciphertext it cannot read. Paced, and
// stops when the budget is spent; returns whether it stopped.
async function forEachLiveProject(ownerKeys, fn, pace) {
  for (const ownerKey of ownerKeys) {
    if (pace.spent()) return true;
    const projects = await store.listProjects(ownerKey, { system: true }).catch((err) => {
      console.warn(`[VAULT-REMEDIATION] could not list ${ownerKey}: ${err.message}`);
      return [];
    });
    for (const project of projects) {
      if (pace.spent()) return true;
      await pace.breathe();
      if (!project?.context || project.context._decrypt_error) continue;
      await fn(project);
    }
  }
  return false;
}

const stoppedNote = (stopped) => (stopped ? ' (stopped at the run\'s time budget; the next run continues)' : '');

async function saveRepairedContext(project, context) {
  const { applied } = await store.saveProject(
    { ...project, context },
    MAINTENANCE_ACTOR,
    { expectedVersion: project.context_version }
  ).catch((err) => {
    console.warn(`[VAULT-REMEDIATION] could not save ${project.project_id}: ${err.message}`);
    return { applied: false };
  });
  return applied;
}

// The summaries buildAutoPromotedMemoryEntities and inferStructuredEventEntities
// (contextSyncService) wrote in place of the content, which they put in the
// title: `${prefix}${project_name}.`, or 'Workspace' for an event with no
// project. Each by the node type it was written with.
const LEGACY_TEMPLATE_SUMMARIES = [
  ['task', 'Active task for '],
  ['decision', 'Decision captured automatically for '],
  ['question', 'Open question for '],
  ['preference', 'Recurring context remembered for '],
];
// 734380e4 ("Add resolved/archived lifecycle to context vault entries"), the
// commit that stopped writing them, landed on main at this moment. A template
// the old build wrote while that commit was still deploying is left alone with
// everything else written after it.
const TEMPLATE_GENERATOR_REMOVED_AT = '2026-06-05T04:19:44Z';

/**
 * Phase 1: Repair graph nodes whose summary is one of the legacy templates,
 * by copying the title (the content the generator put there) into the summary.
 */
//
// THE GENERATOR'S EXACT SENTENCE, FROM ITS OWN ERA, OR NOTHING. This matched
// every summary that STARTED WITH one of the four phrases, across every owner,
// and DELETED the node when its title was under 10 characters. The generator
// was removed on 2026-06-04 and nothing in the repo writes the phrases since;
// this job runs at every boot and every 24 hours, so after its first runs the
// only rows it could still find were ones a person or their agent had written:
// "SSO" / "Active task for Q4: replace SAML with OIDC ..." was deleted, and
// "Data residency" / "Open question for the security review: ..." had its
// question replaced by its title, with nothing to say so. A row is now
// repaired only when it provably is the generator's output: its summary is the
// whole template sentence for its own node type and its own project's name,
// and it was created AND last written before the generator was removed — so a
// row somebody has written since, even with that very sentence, is theirs.
// Anything else is left alone: a template row that survives costs a line, a
// deleted entity cannot be recovered. Nothing is deleted here, whatever its
// title: the title is the content, however short.
async function repairTemplateSummaries() {
  const now = new Date().toISOString();
  const { rows } = await db.query(
    `WITH legacy(node_type, prefix) AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS t(node_type text, prefix text)
     )
     UPDATE context_graph_nodes AS n
        SET summary = left(n.title, 280),
            metadata = n.metadata || $3::jsonb,
            updated_at = $4::timestamptz
       FROM legacy
      WHERE n.node_type = legacy.node_type
        AND n.created_at < $2::timestamptz
        AND n.updated_at < $2::timestamptz
        AND btrim(n.title) <> ''
        AND n.summary = legacy.prefix || (
          CASE WHEN n.project_id IS NULL THEN 'Workspace'
               ELSE (SELECT p.project_name FROM context_projects p
                      WHERE p.project_id = n.project_id AND p.owner_key = n.owner_key)
          END
        ) || '.'
      RETURNING n.node_id`,
    [
      JSON.stringify(LEGACY_TEMPLATE_SUMMARIES.map(([nodeType, prefix]) => ({ node_type: nodeType, prefix }))),
      TEMPLATE_GENERATOR_REMOVED_AT,
      JSON.stringify({ remediated_at: now, remediation: 'template_repair' }),
      now,
    ],
    'org-system'
  );

  const repaired = rows.length;
  console.log(`[VAULT-REMEDIATION] Phase 1: ${repaired} legacy template summaries repaired`);
  return { repaired };
}

// 7cd2391f put the 280-character cap on every summary store.upsertGraphNode
// writes, and landed on main (e95f1be8) at this moment.
const SUMMARY_CAP_SHIPPED_AT = '2026-06-05T20:00:24Z';

/**
 * Phase 3: Truncate oversized node summaries (> 400 chars) written before the
 * store capped them. Prevents blob nodes from dominating context enrichment budgets.
 */
//
// ONLY WHAT THE CAP WOULD HAVE CUT HAD IT EXISTED. This truncated every summary
// over 400 characters, whenever it was written. The store has capped every
// summary it writes at 280 since the same commit that added this phase, so the
// phase is a backfill — and what gets past the cap does so on purpose: the
// vault editor (PATCH /graph/nodes/:id) takes a person's hand edit whole. That
// edit was cut to 279 characters the next night, with nothing to say so. Now
// only a row created AND last written before the cap shipped is cut; one
// anybody has written since is theirs, however long.
async function truncateBlobSummaries({ deadline = Date.now() + RUN_BUDGET_MS } = {}) {
  const pace = pacer(deadline);
  const { rows } = await db.query(
    `SELECT node_id, summary FROM context_graph_nodes
     WHERE length(summary) > 400 AND created_at < $1::timestamptz AND updated_at < $1::timestamptz`,
    [SUMMARY_CAP_SHIPPED_AT],
    'org-system'
  );

  let truncated = 0;
  let stopped = false;

  for (const node of rows) {
    // A row cut is no longer selected, so the next run picks up from here.
    if (pace.spent()) { stopped = true; break; }
    const now = new Date().toISOString();
    // Guarded again on the write: an edit that lands after the read is theirs.
    const { rowCount } = await db.query(
      `UPDATE context_graph_nodes
       SET summary = $1,
           metadata = metadata || $2::jsonb,
           updated_at = $3
       WHERE node_id = $4 AND updated_at < $5::timestamptz`,
      [
        node.summary.slice(0, 279) + '…',
        JSON.stringify({ blob_truncated: true, original_length: node.summary.length }),
        now,
        node.node_id,
        SUMMARY_CAP_SHIPPED_AT,
      ],
      'org-system'
    ).catch(() => ({ rowCount: 0 }));
    truncated += rowCount || 0;
  }

  console.log(`[VAULT-REMEDIATION] Phase 3: ${truncated} blob summaries truncated${stoppedNote(stopped)}`);
  return { truncated, stopped };
}

/**
 * Phase 4: Delete stale candidate nodes not seen in 21+ days.
 * These never accumulated enough evidence to promote to durable.
 */
async function pruneStaleCandiates() {
  const { rowCount } = await db.query(
    `DELETE FROM context_graph_nodes
     WHERE metadata->>'memory_tier' = 'candidate'
       AND last_seen_at < NOW() - INTERVAL '21 days'`,
    [],
    'org-system'
  );

  console.log(`[VAULT-REMEDIATION] Phase 4: ${rowCount} stale candidate nodes pruned`);
  return { pruned: rowCount };
}

/**
 * Phase 5: Collapse TRUE duplicate decision nodes within a project — the same
 * decision stored twice (its full text differs only in case, spacing or a
 * trailing stop), by the same author.
 */
//
// ONLY THE SAME DECISION, AND NEVER ACROSS AUTHORS. This clustered on token
// overlap: any two decision nodes in a project sharing half their words were
// "re-phrased copies", and the loser was hard-deleted every night. Ordinary
// sibling decisions share half their words — "use Postgres 16 for the ledger
// storage layer" and "...for the audit log storage layer", or "deploy the API
// on Fly.io in the iad region" and "deploy the worker ..." — so a teammate's
// decision silently deleted the owner's (preferring whichever was resolved), and
// the owner's next resolve of their own decision was refused as ambiguous,
// matching the survivor. Now a pair collapses only when the two nodes' FULL
// TEXT is one decision, the author is the same (two unattributed nodes count as
// the same; one attributed and one not do not), and neither node is pinned or
// curated by hand. A resolved node and an active one with the same text are a
// decision that was re-opened, not a duplicate: both are kept. The survivor is
// the earliest; the other's evidence and edges are moved onto it before it is
// deleted, so no sighting is lost.
//
// THE TITLE IS NOT THE DECISION. The extractor clips a decision's title to 80
// characters plus "..." (contextGraphService clip), so comparing titles —
// even through the live matcher, which reads "..." as "cut short" — collapsed
// two distinct decisions sharing their first 79 characters (the newer was
// deleted), and a decision the user had typed with a trailing "..." swallowed
// every longer decision it was a prefix of. The comparison is on the summary:
// the decision's own text, clipped only past 240 characters. A summary the
// extractor DID clip is a prefix too, so a pair with a clipped side is decided
// by the canonical keys, which the extractor slugs from the unclipped text —
// and only when both keys provably are that slug. When the full text cannot be
// recovered the pair is kept: a missed duplicate costs a line in the vault, a
// wrong collapse deletes somebody's decision.
function normalizeDecisionTitle(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!;:,\s]+$/, '');
}

// WHAT A NODE IS COMPARED BY, READ ONCE PER NODE. decisionNodeText /
// decisionNodeFullKey (contextSyncService) read a node's own text, whether the
// extractor cut it, and the full text its key carries — the same reading the
// resolve propagation below and the live path use. Two nodes are one decision
// when neither text was cut and the texts are equal once case, spacing and a
// trailing stop are set aside (`text`), or when either was cut and both keys
// provably are the slug of the full text and are equal (`full`). A node with no
// text at all is nobody's duplicate.
//
// NOR DOES A TITLE GO WITH ITS NODE (journey r1). One text is not always one
// decision: question_answered titles its node with the QUESTION and puts the
// answer in the summary (inferStructuredEventEntities), so two questions
// answered the same way — "Which region hosts the EU tenants?" and "... the
// disaster-recovery replica?", both "Frankfurt" — were one decision here with
// the brief's own node for the answer, and both question nodes were deleted.
// For the second question that was the only place it was still written: the
// answer takes it out of open_questions, and the brief keeps one copy of a
// repeated answer. So the node going away must carry nothing its survivor does
// not: the same `title`, or a title that is only the opening of its own text,
// as every extractor title is (`titleInText`, which holds whatever the survivor).
function decisionReading(node) {
  const { decisionNodeText, decisionNodeFullKey } = require('../services/contextSyncService');
  const read = decisionNodeText(node);
  const title = normalizeDecisionTitle(node.title);
  return {
    clipped: read.clipped,
    text: read.text && !read.clipped ? normalizeDecisionTitle(read.text) || null : null,
    full: read.text ? decisionNodeFullKey(node, read.visible) || null : null,
    title,
    titleInText: !title || normalizeDecisionTitle(read.visible).startsWith(title),
  };
}

const nodeAuthor = (node) => node.metadata?.contributed_by || null;
const isResolvedNode = (node) => String(node.metadata?.status || '').toLowerCase() === 'resolved';
const isHandKept = (node) => ['true', '1'].includes(String(node.metadata?.pinned ?? '').toLowerCase())
  || String(node.metadata?.curation_state || '').toLowerCase() === 'curated';

// LOOK THE SURVIVOR UP; DO NOT COMPARE EVERY PAIR (journey r2). This was
// kept.find over every node kept so far, for every node of the project: 20,000
// decisions was 200 million comparisons with no await among them, and the API
// answered nothing for the 13 minutes they took. Every condition of a match is
// an equality — the same author (strictly, as before), the same status, one of
// the two readings above, and the same title unless the duplicate's title is
// only the opening of its own text — so each node kept is filed under those
// keys, and a node looks up only where a match can be: one key when its text
// was cut (`full`, against every node kept), two when it was not (`text`
// against the nodes kept whole, `full` against the nodes kept cut). Each key
// holds the EARLIEST node filed under it, and the earlier of the two found is
// the one kept.find returned: the same survivor, the same merges, in the same
// order. tests/unit/vault-phase5-index.test.js runs the pairwise loop beside
// this over the same random vault and holds them to the same pairs.
function decisionIndex() {
  const lanes = new Map();
  let filed = 0;
  const laneOf = (node) => {
    const author = nodeAuthor(node);
    if (!lanes.has(author)) lanes.set(author, new Map());
    const byStatus = lanes.get(author);
    const resolved = isResolvedNode(node);
    if (!byStatus.has(resolved)) byStatus.set(resolved, { wholeByText: new Map(), cutByFull: new Map(), anyByFull: new Map() });
    return byStatus.get(resolved);
  };
  const file = (map, key, entry, title) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, { first: entry, byTitle: new Map() });
    const slot = map.get(key);
    if (!slot.byTitle.has(title)) slot.byTitle.set(title, entry);
  };
  const find = (map, key, reading) => {
    const slot = key ? map.get(key) : null;
    if (!slot) return null;
    return reading.titleInText ? slot.first : (slot.byTitle.get(reading.title) || null);
  };
  return {
    // The node this one duplicates, or null — and then it is kept, to be found.
    survivorFor(node) {
      const reading = decisionReading(node);
      const lane = laneOf(node);
      const found = reading.clipped
        ? [find(lane.anyByFull, reading.full, reading)]
        : [find(lane.wholeByText, reading.text, reading), find(lane.cutByFull, reading.full, reading)];
      const earliest = found.reduce((best, entry) => (entry && (!best || entry.order < best.order) ? entry : best), null);
      if (earliest) return earliest.node;
      const entry = { node, order: filed++ };
      if (reading.clipped) file(lane.cutByFull, reading.full, entry, reading.title);
      else file(lane.wholeByText, reading.text, entry, reading.title);
      file(lane.anyByFull, reading.full, entry, reading.title);
      return null;
    },
  };
}

// Every duplicate among `rows` (oldest first), as [survivor, duplicate], group
// by group — with a null for every row looked at in between, so the caller can
// hand the event loop back as it goes.
function* duplicateDecisionPairs(rows) {
  const groups = new Map();
  for (const node of rows) {
    yield null;
    if (isHandKept(node)) continue;
    // A node private to one person (metadata.private_to) is never merged with
    // anybody else's copy: the survivor's mark would hide theirs, or drop its own.
    const key = `${node.owner_key}::${node.project_id || ''}::${node.metadata?.private_to || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  for (const nodes of groups.values()) {
    // Oldest first, so the survivor of every pair is the canonical (earliest) node.
    const index = decisionIndex();
    for (const node of nodes) {
      const survivor = index.survivorFor(node);
      yield survivor ? [survivor, node] : null;
    }
  }
}

async function mergeDecisionNodeInto(survivor, loser) {
  // Evidence rows point at the node; re-pointing them keeps every sighting.
  await db.query(
    'UPDATE context_graph_evidence SET node_id = $2 WHERE owner_key = $3 AND node_id = $1',
    [loser.node_id, survivor.node_id, survivor.owner_key],
    'org-system'
  );
  // Edges move unless the survivor already has the same edge (the unique key
  // is owner, type, from, to) or the move would join the node to itself; those
  // go with the loser, which is what deleting it did to every edge before.
  for (const [column, other] of [['from_node_id', 'to_node_id'], ['to_node_id', 'from_node_id']]) {
    await db.query(
      `UPDATE context_graph_edges e SET ${column} = $2
       WHERE e.owner_key = $3 AND e.${column} = $1 AND e.${other} <> $2
         AND NOT EXISTS (
           SELECT 1 FROM context_graph_edges x
           WHERE x.owner_key = e.owner_key AND x.edge_type = e.edge_type
             AND x.${column} = $2 AND x.${other} = e.${other}
         )`,
      [loser.node_id, survivor.node_id, survivor.owner_key],
      'org-system'
    );
  }
  await db.query('DELETE FROM context_graph_nodes WHERE node_id = $1', [loser.node_id], 'org-system');
}

// ONE OWNER AT A TIME, A PAGE AT A TIME. This read every decision node of every
// owner into one array (title, summary and the whole metadata of each) before
// grouping them. Groups never span owners, so it now reads one owner's, oldest
// first as before, with only the metadata the match reads — the same values, the
// rest left in the database — and what it holds is the largest single owner's
// decisions, not the table. It reads them DECISION_PAGE rows to a query: the
// driver parses a result as it streams in, and the socket hands it over in runs
// of reads the event loop cannot interrupt, so one 20,000-row result alone held
// the loop for ~55 ms. The pages are keyed on (created_at, node_id), the order
// the phase has always used — created_at read back at full precision, since a
// JS Date keeps milliseconds and Postgres microseconds — and rows with no
// created_at come last, by node_id, as ORDER BY created_at ASC puts them.
const DECISION_PAGE = 2000;
const PHASE5_COLUMNS = `node_id, owner_key, project_id, canonical_key, title, summary,
  jsonb_build_object(
    'contributed_by', metadata->'contributed_by', 'status', metadata->'status',
    'private_to', metadata->'private_to', 'pinned', metadata->'pinned',
    'curation_state', metadata->'curation_state'
  ) AS metadata,
  created_at::text AS page_at`;

async function ownerDecisionNodes(ownerKey) {
  const rows = [];
  let after = null;
  for (;;) {
    const { rows: page } = await db.query(
      `SELECT ${PHASE5_COLUMNS} FROM context_graph_nodes
       WHERE owner_key = $1 AND node_type = 'decision' AND created_at IS NOT NULL
         AND ($2::timestamptz IS NULL OR (created_at, node_id) > ($2::timestamptz, $3::text))
       ORDER BY created_at ASC, node_id ASC LIMIT ${DECISION_PAGE}`,
      [ownerKey, after?.page_at ?? null, after?.node_id ?? null],
      'org-system'
    );
    for (const row of page) rows.push(row);
    if (page.length < DECISION_PAGE) break;
    after = page[page.length - 1];
  }
  let afterId = null;
  for (;;) {
    const { rows: page } = await db.query(
      `SELECT ${PHASE5_COLUMNS} FROM context_graph_nodes
       WHERE owner_key = $1 AND node_type = 'decision' AND created_at IS NULL
         AND ($2::text IS NULL OR node_id > $2::text)
       ORDER BY node_id ASC LIMIT ${DECISION_PAGE}`,
      [ownerKey, afterId],
      'org-system'
    );
    for (const row of page) rows.push(row);
    if (page.length < DECISION_PAGE) break;
    afterId = page[page.length - 1].node_id;
  }
  return rows;
}

async function collapseDuplicateDecisions({ deadline = Date.now() + RUN_BUDGET_MS } = {}) {
  const pace = pacer(deadline);
  const { rows: owners } = await db.query(
    'SELECT DISTINCT owner_key FROM context_graph_nodes WHERE node_type = \'decision\' ORDER BY owner_key',
    [],
    'org-system'
  );

  let removed = 0;
  let stopped = false;
  for (const { owner_key: ownerKey } of owners) {
    if (pace.spent()) { stopped = true; break; }
    const rows = await ownerDecisionNodes(ownerKey);
    for (const pair of duplicateDecisionPairs(rows)) {
      if (!pair) { await pace.breathe(); continue; }
      // Stopped between merges: what is merged is gone, what is not is found
      // again next run with the same survivor, since every node kept is still here.
      if (pace.spent()) { stopped = true; break; }
      const [survivor, node] = pair;
      try {
        await mergeDecisionNodeInto(survivor, node);
        removed++;
      } catch (err) {
        console.warn(`[VAULT-REMEDIATION] Phase 5 could not merge ${node.node_id}: ${err.message}`);
      }
    }
    if (stopped) break;
  }

  console.log(`[VAULT-REMEDIATION] Phase 5: ${removed} duplicate decision nodes collapsed${stoppedNote(stopped)}`);
  return { removed, stopped };
}

/**
 * Phase 6: Propagate resolved decision graph-node status onto the owning project's
 * recent_decisions. Historically mark_resolved flipped only the graph node, leaving
 * the project copy active so it kept surfacing in context loads.
 */
//
// THE SAME MATCH THE LIVE PATH USES, AND NOTHING NEWER THAN THE RESOLVE. This
// matched with fuzzyContains — a substring in either direction — so resolving
// "Adopt Redis as the cache layer for sessions" resolved every decision that
// merely CONTAINED those words, nightly, including ones recorded long after the
// node was resolved. The live propagation (upsertWorkspaceEntities) was fixed
// to one matcher in scan 22 (decisionNodeMatches now); once d4244d0b let this phase decrypt,
// the nightly run quietly undid that fix in production. It now uses the same
// matcher, and a decision dated after the node was resolved is a later decision
// the resolve cannot have been about, so it is left alone. The matcher reads the
// node's full text, never its clipped title (scan 25: resolving one of two
// decisions sharing their first 79 characters resolved both, every night) —
// and a node with nothing but a clip resolves by its prefix only when exactly
// one open decision carries it (decisionsResolvedBy, scan 26).
//
// ONE OWNER AT A TIME (journey r2). This read every resolved decision node of
// every owner into one map before touching a project, and matched them without
// an await. It now reads each owner's in turn, a page at a time (see
// ownerDecisionNodes; the order is no part of the match), and paces the
// matching.
//
// IT NEVER WRITES ACROSS ACCOUNTS (round 6, the owner's decision). A node is
// applied only to a project of the SAME owner. A resolved node filed under a
// project another owner holds used to be read up front and applied there, so one
// account's resolve rewrote another account's brief. Those nodes are now counted
// and skipped, and the count is logged; nothing about them is read into a map
// or written anywhere.
const RESOLVED_DECISION_NODE = 'n.node_type = \'decision\' AND n.metadata->>\'status\' = \'resolved\' AND n.project_id IS NOT NULL';
const RESOLVED_DECISION_COLUMNS = 'n.node_id, n.project_id, n.canonical_key, n.title, n.summary, n.metadata->>\'resolved_at\' AS resolved_at, n.updated_at';

async function addResolvedNodes(byProject, rows, pace) {
  for (const row of rows) {
    await pace.breathe();
    if (!byProject.has(row.project_id)) byProject.set(row.project_id, []);
    byProject.get(row.project_id).push({
      node: { canonical_key: row.canonical_key, title: row.title, summary: row.summary },
      // When it was resolved; the row's last write when the resolve left no stamp.
      resolvedAt: Date.parse(row.resolved_at) || new Date(row.updated_at || 0).getTime() || 0,
    });
  }
}

async function ownerResolvedNodesByProject(ownerKey, pace) {
  const byProject = new Map();
  let afterId = null;
  for (;;) {
    const { rows } = await db.query(
      `SELECT ${RESOLVED_DECISION_COLUMNS} FROM context_graph_nodes n
       WHERE n.owner_key = $1 AND ${RESOLVED_DECISION_NODE} AND ($2::text IS NULL OR n.node_id > $2::text)
       ORDER BY n.node_id ASC LIMIT ${DECISION_PAGE}`,
      [ownerKey, afterId],
      'org-system'
    );
    await addResolvedNodes(byProject, rows, pace);
    if (rows.length < DECISION_PAGE) break;
    afterId = rows[rows.length - 1].node_id;
  }
  return byProject;
}

async function propagateResolvedDecisions({ deadline = Date.now() + RUN_BUDGET_MS } = {}) {
  const { decisionsResolvedBy } = require('../services/contextSyncService');
  const pace = pacer(deadline);
  const { rows: owners } = await db.query(
    `SELECT DISTINCT n.owner_key FROM context_graph_nodes n WHERE ${RESOLVED_DECISION_NODE} ORDER BY n.owner_key`,
    [],
    'org-system'
  );
  const { rows: [{ n: foreignSkipped }] } = await db.query(
    `SELECT count(*)::int AS n
     FROM context_graph_nodes n JOIN context_projects p ON p.project_id = n.project_id
     WHERE ${RESOLVED_DECISION_NODE} AND p.owner_key <> n.owner_key`,
    [],
    'org-system'
  );
  if (foreignSkipped > 0) {
    console.warn(`[VAULT-REMEDIATION] Phase 6 skipped ${foreignSkipped} resolved decision nodes filed under another owner's project; it never writes across accounts`);
  }

  let updated = 0;
  let stopped = false;
  for (const { owner_key: ownerKey } of owners) {
    if (pace.spent()) { stopped = true; break; }
    const own = await ownerResolvedNodesByProject(ownerKey, pace);
    stopped = await forEachLiveProject([ownerKey], async (project) => {
      const resolvedNodes = own.get(project.project_id) || [];
      const decisions = project.context.recent_decisions;
      if (!resolvedNodes.length || !Array.isArray(decisions) || !decisions.length) return;

      const now = new Date().toISOString();
      const hit = new Set();
      for (const node of resolvedNodes) {
        await pace.breathe();
        const eligible = (d) => {
          const decidedAt = Date.parse(d.decided_at);
          return !(Number.isFinite(decidedAt) && node.resolvedAt && decidedAt > node.resolvedAt);
        };
        for (const index of decisionsResolvedBy(decisions, node.node, { eligible }).indexes) hit.add(index);
      }
      if (!hit.size) return;
      const next = decisions.map((d, index) => (hit.has(index) ? { ...d, resolved: true, resolved_at: d.resolved_at || now } : d));
      if (await saveRepairedContext(project, { ...project.context, recent_decisions: next })) updated++;
    }, pace);
    if (stopped) break;
  }

  console.log(`[VAULT-REMEDIATION] Phase 6: ${updated} projects had resolved decisions propagated to recent_decisions${stoppedNote(stopped)}`);
  return { updated, stopped };
}

/**
 * Phase 8: Archive durable nodes that have never been retrieved and have sat
 * untouched for 45+ days. Never-used + stale is the signature of capture noise.
 * Status-flip (reversible, already -0.8 in ranking), not delete. Exempts pinned
 * and curated/promoted nodes (deliberately kept) and anything already resolved.
 */
async function archiveUnusedNodes() {
  const now = new Date().toISOString();
  const { rowCount } = await db.query(
    `UPDATE context_graph_nodes
     SET metadata = metadata || jsonb_build_object('status', 'archived', 'archived_at', $1::text, 'archived_reason', 'unused_45d'),
         updated_at = $1::timestamptz
     WHERE COALESCE((metadata->>'retrieval_hits')::int, 0) = 0
       AND last_seen_at < NOW() - INTERVAL '45 days'
       AND COALESCE(metadata->>'pinned', 'false') NOT IN ('true', '1')
       AND COALESCE(metadata->>'curation_state', '') NOT IN ('curated', 'promoted')
       AND COALESCE(metadata->>'status', '') NOT IN ('resolved', 'archived')`,
    [now],
    'org-system'
  );

  console.log(`[VAULT-REMEDIATION] Phase 8: ${rowCount} never-retrieved stale nodes archived`);
  return { archived: rowCount };
}

// Each phase is isolated so one failure doesn't cancel the remaining phases —
// mirrors the per-item isolation pattern in jobs/scheduler.js (log and continue).
async function runPhase(name, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[VAULT-REMEDIATION] ${name} failed:`, err.message);
    return fallback;
  }
}

async function runVaultRemediation({ budgetMs = RUN_BUDGET_MS } = {}) {
  console.log('[VAULT-REMEDIATION] Starting nightly vault remediation...');
  const start = Date.now();
  const deadline = start + budgetMs;
  // A phase starts only while the budget lasts; one that does not is named,
  // and is the next run's.
  const left = [];
  const phase = (name, fn, fallback) => {
    if (Date.now() >= deadline) {
      left.push(name);
      return fallback;
    }
    return runPhase(name, () => fn({ deadline }), fallback);
  };

  // PHASES 2 AND 7 ARE RETIRED (round 6, the owner's decision) and their numbers
  // are not reused: the others keep theirs so a log line, a test and an audit
  // still mean the same phase. Phase 2 rewrote every decided_at in 2023, and a
  // date a person gave cannot be told from one a model invented. Phase 7 cleared
  // a blocker when a newer decision merely used resolution words and shared
  // enough of its own. The code is deleted, not switched off: no flag, config or
  // env var reaches it. tests/integration/journey-r6-vault-jobs.test.js pins it.
  const p1 = await phase('Phase 1 (repairTemplateSummaries)', repairTemplateSummaries, { repaired: 0 });
  const p3 = await phase('Phase 3 (truncateBlobSummaries)', truncateBlobSummaries, { truncated: 0 });
  const p4 = await phase('Phase 4 (pruneStaleCandiates)', pruneStaleCandiates, { pruned: 0 });
  const p5 = await phase('Phase 5 (collapseDuplicateDecisions)', collapseDuplicateDecisions, { removed: 0 });
  const p6 = await phase('Phase 6 (propagateResolvedDecisions)', propagateResolvedDecisions, { updated: 0 });
  const p8 = await phase('Phase 8 (archiveUnusedNodes)', archiveUnusedNodes, { archived: 0 });

  const elapsed = Date.now() - start;
  if (left.length) {
    console.log(`[VAULT-REMEDIATION] Time budget of ${budgetMs}ms spent; left for the next run: ${left.join(', ')}`);
  }
  console.log(`[VAULT-REMEDIATION] Done in ${elapsed}ms — repaired=${p1.repaired} truncated=${p3.truncated} pruned=${p4.pruned} dupesCollapsed=${p5.removed} resolvedPropagated=${p6.updated} archivedUnused=${p8.archived}`);
}

module.exports = {
  runVaultRemediation,
  // Exported for tests: the phases that read and write encrypted project context.
  collapseDuplicateDecisions,
  propagateResolvedDecisions,
  // Exported for tests: phase 5's matching, without the database.
  duplicateDecisionPairs,
};
