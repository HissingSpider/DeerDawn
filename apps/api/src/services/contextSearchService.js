'use strict';

/**
 * Cross-project context search — ONE implementation, two callers.
 *
 * There were two: the hosted `search_context` handler (routes/mcp.js) and
 * `POST /api/v1/context/search` (which the local stdio server calls). They were
 * written apart and drifted apart. The hosted one — the one most real users hit —
 * searched six fields, so a debugging note, a landmine, a shipped entry, a hot
 * path, a board card or a graph entity saved through `manage_memory` could not be
 * found through `recall` a minute later. The REST copy had picked up two of those
 * and none of the rest. Every fix to one was half-shipped until somebody copied
 * it, which is the two-dispatcher problem in miniature; so the candidate list,
 * the matcher, the scoring and the snippet all live here and both callers are a
 * few lines each.
 *
 * What was wrong with the matching, beyond coverage:
 *
 *   - The tokeniser lower-cased, replaced every non-alphanumeric with a space and
 *     dropped tokens of two characters or fewer. `A-2` became `a` + `2` and
 *     vanished entirely; `$12` became `12` and vanished; `E-007` became `007`,
 *     which matches every other `-007` there is. Identifiers like these are
 *     exactly what people search a memory for. So the RAW query is tried first as
 *     a case-insensitive substring, before anything is tokenised, and the
 *     tokeniser that runs after it keeps `-`, `$`, `.`, `_`, `/`, `#` inside a
 *     token.
 *   - Scores were flat. A one-word query scores 1.0 on every hit, and the sort
 *     was then decided by the order projects happened to be listed in. An exact
 *     phrase now outranks scattered words, the active (or requested) project
 *     gets +0.25, and the entry's own date breaks what ties are left.
 *   - The snippet was the first 117 characters of the entry. Stored summaries
 *     run to 4,000 characters, so the match was usually not in it and the result
 *     read as a false positive. The snippet is centred on the match.
 *
 * Visibility: projects come from service.listProjects / service.getProject,
 * which drop what this actor may not see and strip the sections a share policy
 * withholds — never from the store. Graph nodes go through
 * visibleGraphNodesForActor, and a node tied to a project that is not in the
 * actor's visible list is dropped rather than shown under a guessed name.
 */

const service = require('./contextSyncService');
const store = require('../store/contextSyncStore');
const workspace = require('./workspaceService');

const MAX_RESULTS = 10;
const SNIPPET_CHARS = 160;
const ACTIVE_PROJECT_BOOST = 0.25;
const PHRASE_SCORE = 1;
// Every word present but not as a phrase. Below PHRASE_SCORE on purpose, and
// partial matches scale down from here.
const ALL_TOKENS_SCORE = 0.8;
const GRAPH_NODE_FETCH_LIMIT = 100;

// Punctuation that carries meaning INSIDE an identifier and is therefore kept:
// A-2, E-007, $12, v1.0.52, owner_key, apps/api, #486. Anything else splits.
const TOKEN_SPLIT = /[^a-z0-9\-$._/#]+/;
const TOKEN_TRIM = /^[-._/]+|[-._/#]+$/g;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'did', 'do', 'for', 'from', 'in', 'is', 'it',
  'of', 'on', 'or', 'our', 'the', 'to', 'we', 'with',
]);

function lower(value) {
  return String(value || '').toLowerCase();
}

// The old normaliser, kept as the SECOND chance for a token: "auth decisions"
// should still find "auth-decisions", and "owner key" should find "owner_key".
function alnum(value) {
  return lower(value).replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokenize(query) {
  const seen = new Set();
  const tokens = [];
  for (const part of lower(query).split(TOKEN_SPLIT)) {
    const token = part.replace(TOKEN_TRIM, '');
    // Two characters is the floor so `A-2` (3) and `$12` (3) survive and `go`
    // does too; a single character matches nearly everything and means nothing.
    if (token.length < 2 || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  // Lowering the floor to two characters let `in`, `of`, `to` through, and those
  // match nearly every entry. Drop the filler — unless filler is all there is,
  // in which case the query is searched as typed rather than not at all.
  const meaningful = tokens.filter((token) => !STOPWORDS.has(token));
  return meaningful.length ? meaningful : tokens;
}

/**
 * @returns {{score:number, index:number, length:number}|null} where `index` is
 *   the position in `text` the snippet should centre on.
 */
function matchText(text, rawQuery, tokens) {
  const haystack = lower(text);
  if (!haystack) return null;

  // 1. The raw query, untouched. This is the step that finds `E-007` and `$12`.
  const phraseAt = rawQuery ? haystack.indexOf(rawQuery) : -1;
  if (phraseAt >= 0) return { score: PHRASE_SCORE, index: phraseAt, length: rawQuery.length };

  if (!tokens.length) return null;
  // Leading space so the flattened comparison below only ever starts at a word
  // boundary: without it `e 007` is found inside "typ[e 007]".
  const flattened = ` ${alnum(text)}`;
  let matched = 0;
  let firstAt = -1;
  let firstLength = 0;
  for (const token of tokens) {
    let at = haystack.indexOf(token);
    if (at < 0) {
      // Fall back to the punctuation-blind comparison, but only for a token
      // that still says something once flattened. `a-2` flattens to `a 2`,
      // which is compared whole — never as a bare `2`.
      const flatToken = alnum(token);
      if (flatToken.length >= 3 && flattened.includes(` ${flatToken}`)) {
        matched += 1;
        if (firstAt < 0) {
          // Best effort at a position in the ORIGINAL text for the snippet.
          at = haystack.indexOf(flatToken.split(' ')[0]);
          firstAt = at >= 0 ? at : 0;
          firstLength = token.length;
        }
      }
      continue;
    }
    matched += 1;
    if (firstAt < 0) {
      firstAt = at;
      firstLength = token.length;
    }
  }
  if (!matched) return null;
  return { score: (matched / tokens.length) * ALL_TOKENS_SCORE, index: firstAt, length: firstLength };
}

function snippetAround(text, index, length) {
  const flat = String(text || '');
  if (flat.length <= SNIPPET_CHARS) return flat.replace(/\s+/g, ' ').trim();
  const centre = Math.max(0, index) + Math.floor(Math.max(0, length) / 2);
  let start = Math.max(0, centre - Math.floor(SNIPPET_CHARS / 2));
  const end = Math.min(flat.length, start + SNIPPET_CHARS);
  start = Math.max(0, end - SNIPPET_CHARS);
  // Do not open mid-word when a boundary is close by — unless that would push
  // the match itself out of the window.
  if (start > 0) {
    const space = flat.indexOf(' ', start);
    if (space >= 0 && space < Math.max(0, index) && space - start < 20) start = space + 1;
  }
  const body = flat.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < flat.length ? '…' : ''}`;
}

function joinText(parts) {
  return parts.filter((part) => typeof part === 'string' && part.trim()).join(' — ');
}

/**
 * Everything in one project's context that a person might have saved and then
 * look for. `value` is what is matched AND what the snippet is cut from.
 * `context` has already been through the share policy: a withheld section is
 * simply absent here, so it cannot be matched.
 */
function buildProjectCandidates(project) {
  const ctx = project?.context || {};
  const fallbackDate = ctx.last_updated || project?.updated_at || null;
  const out = [];
  const push = (field, value, date) => {
    if (typeof value !== 'string' || !value.trim()) return;
    out.push({ field, value, date: date || fallbackDate });
  };

  push('task', ctx.current_task);
  push('status', ctx.current_status);
  push('description', ctx.description);
  push('next_action', ctx.next_action);
  push('blocking', ctx.blocking_issue);

  // Resolved decisions stay in: they are excluded from the BRIEF, and the schema
  // says why they are kept at all — "retained for retrieval". This is retrieval.
  (ctx.recent_decisions || []).forEach((d, i) => {
    if (typeof d === 'string') return push(`decision[${i}]`, d);
    return push(`decision[${i}]`, joinText([d?.summary, d?.headline, d?.reasoning]), d?.decided_at);
  });
  (ctx.goals || []).forEach((g, i) => push(`goal[${i}]`, g));
  (ctx.open_questions || []).forEach((q, i) => push(`question[${i}]`, q));
  (ctx.tech_stack || []).forEach((t, i) => push(`tech[${i}]`, t));
  (ctx.recurring_context || []).forEach((c, i) => push(`constraint[${i}]`, c));
  (ctx.debugging_notes || []).forEach((n, i) => push(
    `debug[${i}]`,
    joinText([n?.summary, ...(Array.isArray(n?.paths) ? n.paths : []), n?.commit_ref]),
    n?.added_at,
  ));
  (ctx.landmines || []).forEach((n, i) => push(
    `landmine[${i}]`,
    joinText([n?.summary, ...(Array.isArray(n?.paths) ? n.paths : [])]),
    n?.added_at,
  ));
  (ctx.shipped || []).forEach((s, i) => push(`shipped[${i}]`, joinText([s?.summary, s?.commit_ref]), s?.shipped_at));
  (ctx.hot_paths || []).forEach((h, i) => push(`hotpath[${i}]`, joinText([h?.label, h?.path, h?.purpose])));
  (ctx.entrypoints || []).forEach((h, i) => push(`entrypoint[${i}]`, joinText([h?.label, h?.path, h?.purpose])));
  // The board. Cards are memory too — "what did we say about the Stripe
  // repoint" is as likely to be sitting on a card as in a decision.
  (ctx.todo_items || []).forEach((t, i) => push(`todo[${i}]`, joinText([t?.title, t?.body]), t?.created_at));
  (ctx.completed_todos || []).forEach((t, i) => push(`done[${i}]`, joinText([t?.title, t?.body]), t?.completed_at || t?.created_at));

  return out;
}

async function graphNodeCandidates(actor, rawQuery, tokens, projectsById) {
  const ownerKey = workspace.defaultOwnerKey(actor) || 'org-system';
  // The text filter runs in SQL, owner-scoped (see store.listGraphNodes): a
  // newest-N fetch filtered here could never find anything older than N.
  const nodes = await store.listGraphNodes(ownerKey, {
    textTerms: [rawQuery, ...tokens].filter(Boolean),
    limit: GRAPH_NODE_FETCH_LIMIT,
  });
  const visible = await service.visibleGraphNodesForActor(actor, ownerKey, nodes);
  const out = [];
  for (const node of visible || []) {
    if (String(node?.metadata?.status || '').toLowerCase() === 'archived') continue;
    // A node tied to a project this search did not list (archived, or not this
    // actor's to read) is dropped: there is no honest project name to show it
    // under, and "not listed" is the safe reading of "not visible".
    const project = node.project_id ? projectsById.get(node.project_id) : null;
    if (node.project_id && !project) continue;
    // A SHARE POLICY FILTERS THE BRIEF, NOT THE GRAPH. Graph visibility is
    // per-project: if the actor may see the project, they may see its nodes. But
    // a decision's auto-promoted entity carries the decision's sentence verbatim,
    // so on a project shared WITHOUT its decisions a teammate's search found the
    // withheld text under `entity:decision` — caught by this module's own test,
    // on its first run. A node does not record which section it was derived
    // from, so there is no honest per-node answer; when this reader's view of
    // the project has anything withheld, none of that project's nodes are
    // offered. The author, and readers of a fully shared project, lose nothing.
    if (project && Array.isArray(project.context?.withheld_sections) && project.context.withheld_sections.length) continue;
    const title = String(node.title || '').trim();
    const summary = String(node.summary || '').trim();
    out.push({
      project,
      field: `entity:${node.metadata?.entity_type || node.node_type || 'node'}`,
      // The auto-promoted entities store the same sentence as title and summary.
      value: summary && lower(summary) !== lower(title) ? joinText([title, summary]) : (title || summary),
      date: node.last_seen_at || node.updated_at || null,
      dedupeText: lower(summary || title),
    });
  }
  return out;
}

/**
 * @param {object} actor
 * @param {object} options
 * @param {string} options.query
 * @param {number} [options.limit] clamped to [1, 10]
 * @param {string} [options.project_id] BOOSTED, not filtered on: its hits lead,
 *   and an archived project named here is searched even though archived
 *   projects are otherwise left out. A project the actor cannot read resolves to
 *   nothing and changes nothing — it is never confirmed to exist.
 * @param {string} [options.cwd]
 * @param {string} [options.workspace_key]
 * @returns {Promise<{results: Array<{score:number, project_id?:string, project_name:string, field:string, snippet:string}>}>}
 */
async function searchContext(actor, options = {}) {
  const rawQuery = lower(options.query).trim();
  if (!rawQuery) return { results: [] };
  const tokens = tokenize(rawQuery);
  const numericLimit = Number(options.limit);
  const limit = Math.min(Math.max(Number.isFinite(numericLimit) ? Math.floor(numericLimit) : 5, 1), MAX_RESULTS);

  const projects = [...((await service.listProjects(actor)) || [])];
  const projectsById = new Map(projects.map((project) => [project.project_id, project]));

  let boostedProjectId = null;
  if (options.project_id) {
    const requested = projectsById.get(options.project_id)
      || await service.getProject(actor, options.project_id).catch(() => null);
    if (requested) {
      boostedProjectId = requested.project_id;
      if (!projectsById.has(requested.project_id)) {
        projects.push(requested);
        projectsById.set(requested.project_id, requested);
      }
    }
  }
  if (!boostedProjectId && projects.length > 1) {
    // Hosted callers have no cwd; resolveActiveProject then falls back to THIS
    // CONNECTION's own binding first (options.session_id, derived server-side
    // and never sent by the caller), and only after that to this PERSON's
    // history — never the workspace's. Without the session id a search on one
    // connector was boosted towards whatever another connector wrote to last.
    // With one project there is nothing to rank between, so the lookup is
    // skipped.
    const active = await service.resolveActiveProject(actor, options.cwd || undefined, options.workspace_key || null, {
      sessionId: options.session_id || null,
    }).catch(() => null);
    if (active?.project_id && projectsById.has(active.project_id)) boostedProjectId = active.project_id;
  }

  const hits = [];
  const consider = (project, candidate) => {
    const match = matchText(candidate.value, rawQuery, tokens);
    if (!match) return;
    const boost = project && project.project_id === boostedProjectId ? ACTIVE_PROJECT_BOOST : 0;
    hits.push({
      score: Math.round((match.score + boost) * 100) / 100,
      ...(project ? { project_id: project.project_id } : {}),
      project_name: project ? project.project_name : 'Workspace',
      field: candidate.field,
      snippet: snippetAround(candidate.value, match.index, match.length),
      _time: Date.parse(candidate.date) || 0,
    });
  };

  // Everything already offered as a candidate, per project, as one lower-cased
  // blob — what the graph pass below checks a node against.
  const offeredText = new Map();
  for (const project of projects) {
    const values = [];
    for (const candidate of buildProjectCandidates(project)) {
      values.push(lower(candidate.value));
      consider(project, candidate);
    }
    offeredText.set(project.project_id, values.join('\n'));
  }

  // The graph is a bonus on top of the brief, never a reason a search fails.
  try {
    const seenNodes = new Set();
    for (const candidate of await graphNodeCandidates(actor, rawQuery, tokens, projectsById)) {
      // A decision and the entity auto-promoted from it are the same sentence;
      // one result slot is enough.
      const projectId = candidate.project?.project_id || '';
      if (candidate.dedupeText && (offeredText.get(projectId) || '').includes(candidate.dedupeText)) continue;
      const key = `${projectId}::${candidate.dedupeText}`;
      if (seenNodes.has(key)) continue;
      seenNodes.add(key);
      consider(candidate.project, candidate);
    }
  } catch (err) {
    console.warn('[CONTEXT] search: graph candidates skipped:', err?.message || err);
  }

  hits.sort((a, b) => (b.score - a.score) || (b._time - a._time));
  return {
    results: hits.slice(0, limit).map(({ _time, ...hit }) => hit),
  };
}

module.exports = {
  searchContext,
  // Exported for unit tests (pure functions).
  tokenize,
  matchText,
  snippetAround,
  buildProjectCandidates,
};
