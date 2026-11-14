'use strict';

/**
 * Cross-project retrieval for the brief.
 *
 * This is the paid unit. Not the /portfolio tab — a tab is visited once and
 * then competes for attention, which is the churn shape. This runs inside the
 * loop the user already runs daily: when a brief is assembled for project X,
 * the decisions from projects Y and Z that bear on X come with it.
 *
 * WHY THIS IS NOT portfolioService.
 *
 * The obvious move was to reuse the portfolio's merged timeline. Validated
 * against live data 2026-08-28 and it does not work: `mergeDecisions` sorts by
 * `decided_at` and slices. It accepts a query, but the brief path has none to
 * give it, so relevance is never consulted. Assembled for real, the top of a
 * quant-research brief was another project's terrain-streaming work — correct
 * by recency, useless to the reader.
 *
 * The retrieval that DID surface the right pair was query-driven. So the query
 * is the product here, and it comes from the project being briefed: its current
 * task and open questions are what "related" has to be related TO.
 *
 * THE RULE THAT SHAPES EVERYTHING BELOW: a bad cross-project pull is worse than
 * none. A brief that opens with an irrelevant decision from an unrelated project
 * teaches the reader to skip the section, and they never come back to it. So
 * every knob here is set to return NOTHING rather than something weak — a
 * distinctiveness gate, a score floor, and a cap well below what the ranking
 * could fill.
 */

const store = require('../store/contextSyncStore');
const entitlementService = require('./entitlementService');
const { decisionHeadline } = require('../../../../packages/shared-context/src/index.js');
const workspace = require('./workspaceService');

// Terms this common carry no signal about what a decision is ABOUT. Without
// this list the query built from a task like "fix the failing test in the auth
// service" matches every decision that contains the word "test".
//
// The second half of the list is the one that earns its keep: words that name
// the ACTIVITY rather than the subject — review, rollout, approach, conditions.
// They survive an ordinary stopword list, they are frequent in task text, and
// they are exactly what two unrelated projects share. IDF cannot catch them on a
// young account, where every term looks rare because there is barely a corpus;
// this list is corpus-independent, which is why the two mechanisms are separate.
// A term dropped here is only dropped from the QUERY, never from the text being
// matched.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'onto', 'not', 'but', 'was', 'were',
  'are', 'has', 'have', 'had', 'its', 'it', 'as', 'at', 'by', 'in', 'of', 'on', 'or', 'to', 'be',
  'is', 'an', 'a', 'we', 'our', 'you', 'your', 'they', 'their', 'then', 'than', 'now', 'new', 'old',
  'add', 'added', 'fix', 'fixed', 'fixes', 'use', 'used', 'using', 'make', 'made', 'run', 'runs',
  'set', 'get', 'put', 'via', 'per', 'out', 'up', 'off', 'all', 'any', 'one', 'two', 'more', 'most',
  'should', 'would', 'could', 'will', 'can', 'may', 'must', 'need', 'needs', 'want', 'wants',
  'work', 'working', 'update', 'updated', 'change', 'changed', 'changes', 'implement', 'implemented',
  'project', 'projects', 'task', 'tasks', 'code', 'file', 'files', 'test', 'tests', 'issue', 'issues',
  'still', 'once', 'when', 'what', 'which', 'while', 'about', 'after', 'before', 'over', 'under',
  'first', 'last', 'next', 'also', 'only', 'just', 'like', 'some', 'each', 'both', 'been', 'because',
  // Activity, not subject.
  'review', 'reviews', 'reviewed', 'reviewing', 'confirm', 'confirmed', 'check', 'checked',
  'condition', 'conditions', 'normal', 'launch', 'window', 'team', 'agreed', 'agree', 'rollout',
  'plan', 'plans', 'planned', 'process', 'approach', 'option', 'options', 'item', 'items',
  'thing', 'things', 'note', 'notes', 'done', 'ready', 'open', 'close', 'closed', 'start',
  'started', 'finish', 'finished', 'follow', 'current', 'recent', 'related', 'general',
  'various', 'several', 'initial', 'final', 'overall', 'proper', 'better', 'best', 'good',
  'ensure', 'ensures', 'support', 'supports', 'handle', 'handles', 'improve', 'improved',
]);

// Tuning. These are deliberately conservative — see the rule at the top.
const MIN_TERM_LENGTH = 4;       // shorter tokens are almost all noise
const MIN_SCORE = 0.15;          // below this, return nothing
const MAX_QUERY_TERMS = 40;
const DEFAULT_LIMIT = 3;         // the brief can afford three lines, not fifty

// WHY THE GATE IS ABOUT RARITY, NOT COUNT.
//
// The first version required two shared terms and scored by what fraction of
// the whole query a candidate covered. Run against the real pair this exists to
// find — ApexFundV3's "portfolio_sharpe has no covariance term" against Red
// Queen's allocator work — it returned nothing, and it was right to by its own
// rule: the two share exactly ONE word, "covariance".
//
// That one word is the entire relationship. Two projects that both say
// "covariance" are almost certainly talking about the same problem; two that
// both say "service" are not. Counting matches treats those identically, so the
// gate counts DISTINCTIVENESS instead: one rare term qualifies on its own, and
// common terms still need company.
// "Rare" has to be a share, not a count, or the gate breaks at both ends: with
// four candidates every term looks rare, with four hundred none does. The
// max(1, ...) floor keeps a term seen exactly once distinctive even in a tiny
// corpus, which is the case on a young account.
const DISTINCTIVE_MAX_SHARE = 0.25;
const DISTINCTIVE_MIN_LENGTH = 6;
// Normalising by the whole query punishes long tasks — a five-clause task with
// one perfect match scores lower than a terse one with the same match. Normalise
// against the strongest few terms instead, which is scale-free. Three, because
// the unit this has to clear is "matches about as much as the task's single most
// important idea" — one distinctive shared term lands near 0.22 against a 0.15
// floor, two near 0.45, and an unrelated decision still lands at zero.
const NORMALIZE_AGAINST_TOP = 3;

function getActorKey(actor) {
  return workspace.defaultOwnerKey(actor) || 'org-system';
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_./\s-]/g, ' ');
}

function tokenize(value) {
  return normalize(value)
    .split(/[\s/]+/)
    .map((token) => token.replace(/^[-._]+|[-._]+$/g, ''))
    .filter((token) => token.length >= MIN_TERM_LENGTH && !STOPWORDS.has(token));
}

/**
 * The query is built from what the reader is about to do, not from what the
 * project is. current_task and open_questions are the live edge of the work;
 * description and goals describe the project in general and match everything,
 * which is the same as matching nothing.
 */
function buildQueryTerms(project) {
  const context = project?.context || {};
  const sources = [
    context.current_task,
    ...(Array.isArray(context.open_questions) ? context.open_questions : []),
    context.current_status,
  ].filter(Boolean);

  const weights = new Map();
  // A term from the current task counts for more than one from an open
  // question: the task is what this session is for.
  const weightFor = (index) => (index === 0 ? 2 : 1);
  sources.forEach((source, index) => {
    for (const term of tokenize(source)) {
      weights.set(term, Math.max(weights.get(term) || 0, weightFor(index)));
    }
  });

  return [...weights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_QUERY_TERMS);
}

/**
 * Candidates are decisions and debugging notes. Both carried real cross-project
 * signal in the validation — the pair that proved the thesis was one of each —
 * and both are already in the decrypted context object, so scoring them costs
 * no extra read.
 */
function candidatesFor(project) {
  const context = project?.context || {};
  const out = [];

  for (const decision of Array.isArray(context.recent_decisions) ? context.recent_decisions : []) {
    if (!decision?.summary || decision.resolved) continue;
    out.push({
      kind: 'decision',
      project_id: project.project_id,
      project_name: project.project_name,
      headline: decisionHeadline(decision),
      text: `${decision.summary} ${decision.reasoning || ''}`,
      at: decision.decided_at || null,
      date_inferred: Boolean(decision.date_inferred),
      importance: decision.importance || 'normal',
    });
  }

  for (const note of Array.isArray(context.debugging_notes) ? context.debugging_notes : []) {
    if (!note?.summary) continue;
    const paths = Array.isArray(note.paths) ? note.paths : [];
    out.push({
      kind: 'finding',
      project_id: project.project_id,
      project_name: project.project_name,
      headline: decisionHeadline({ summary: note.summary }),
      text: `${note.summary} ${paths.join(' ')}`,
      at: note.added_at || note.created_at || null,
      date_inferred: false,
      importance: note.importance || 'normal',
      anchor: paths[0] || null,
    });
  }

  return out;
}

/**
 * Score = matched term mass against the mass of the task's strongest few terms,
 * with two adjustments that are about trust rather than relevance:
 *   - a rare term is worth more than a common one, so a candidate matching one
 *     distinctive term ("covariance") outranks one matching three vague ones;
 *   - importance breaks ties, because between two equally-related decisions the
 *     critical one is the one worth the reader's attention.
 * Recency deliberately does NOT feature. Recency is what the merged timeline
 * used, and it is exactly what made that retrieval useless.
 */
function scoreCandidate(candidate, queryTerms, documentFrequency, totalDocuments) {
  const text = normalize(candidate.text);
  const idfFor = (term) => {
    const df = documentFrequency.get(term) || 0;
    // Bounded so a term unique to one candidate cannot dominate outright.
    return Math.min(2.5, Math.log((totalDocuments + 1) / (df + 1)) + 0.5);
  };

  const weighted = queryTerms
    .map(([term, weight]) => ({ term, weight, mass: weight * idfFor(term) }))
    .sort((a, b) => b.mass - a.mass);

  let matchedMass = 0;
  let distinctiveMatches = 0;

  for (const { term, mass } of weighted) {
    if (!text.includes(term)) continue;
    matchedMass += mass;
    const maxDf = Math.max(1, totalDocuments * DISTINCTIVE_MAX_SHARE);
    if ((documentFrequency.get(term) || 0) <= maxDf && term.length >= DISTINCTIVE_MIN_LENGTH) {
      distinctiveMatches += 1;
    }
  }

  // At least one distinctive term, always. Two generic shared words is the
  // noise case this whole section exists to avoid — "service" and "update"
  // appear in everything, and a block built from them is the irrelevant pull
  // that teaches the reader to stop looking at the section.
  if (distinctiveMatches < 1) return 0;

  const reference = weighted.slice(0, NORMALIZE_AGAINST_TOP).reduce((sum, entry) => sum + entry.mass, 0);
  if (reference === 0) return 0;

  const base = matchedMass / reference;
  const importanceBonus = candidate.importance === 'critical' ? 0.06
    : candidate.importance === 'high' ? 0.03
      : 0;
  return Math.min(1, base + importanceBonus);
}

function documentFrequencyFor(candidates, queryTerms) {
  const df = new Map();
  const texts = candidates.map((candidate) => normalize(candidate.text));
  for (const [term] of queryTerms) {
    let count = 0;
    for (const text of texts) if (text.includes(term)) count += 1;
    df.set(term, count);
  }
  return df;
}

async function isUnlocked(actor) {
  // Entitlements follow the WORKSPACE, not the person — the same key
  // portfolioService.isPortfolioUnlocked reads. An invited teammate's own org is
  // usually Free, so reading it locked a paid Team's members out of the Team's
  // own feature while the portfolio beside it said unlocked.
  const ownerKey = getActorKey(actor);
  if (ownerKey === 'org-system') return true;
  const entitlements = await entitlementService.getEntitlementsForExistingOrg(ownerKey).catch(() => null);
  // No org row = a system/dev actor, never a billed customer. Same fail-open
  // posture as portfolioService.isPortfolioUnlocked.
  if (!entitlements) return true;
  return Boolean(entitlements.features?.portfolio);
}

/**
 * The one read. Returns the block to inject into `projectId`'s brief.
 *
 * `projects` may be passed in by a caller that has already loaded and decrypted
 * them — which every brief path has. Loading them again would put a second
 * full decrypt on session start, and session start is the product's most
 * important call.
 *
 * Shape is the same at every tier. `locked` decides whether the entries come
 * with the counts, exactly as the portfolio does: a free reader is told there
 * are three related decisions in two other projects, because a free reader who
 * sees nothing cannot tell there was anything to see.
 */
async function getRelatedFromOtherProjects(actor, {
  projectId,
  projects = null,
  limit = DEFAULT_LIMIT,
} = {}) {
  const empty = { locked: false, count: 0, project_count: 0, entries: [] };
  if (!projectId) return empty;

  const ownerKey = getActorKey(actor);
  const [allProjects, unlocked] = await Promise.all([
    projects || store.listProjects(ownerKey, {
      // "Related decisions" are injected into the reader's brief, so an
      // unfiltered list would carry a colleague's private decisions into it.
      actorIdentities: workspace.actorIdentities(actor),
      isWorkspaceOwner: (await workspace.resolveRole(actor, ownerKey).catch(() => null)) === 'owner',
    }),
    isUnlocked(actor),
  ]);

  // THE ACTOR'S VIEW, NOT THE ROWS. store.listProjects filters on visibility
  // only, and hands back every row's raw decrypted context — so the candidates
  // below (decisions, debugging notes) came from sections a share withholds, and
  // this block printed a colleague's withheld decision into the reader's brief
  // for some OTHER project, under a heading that never said where it came from.
  // The query terms are built from the target's view for the same reason: a
  // withheld current_task steering what gets surfaced is the withheld task,
  // inferred. Lazy require: contextSyncService requires this module at load.
  const visibleProjects = await require('./contextSyncService').viewProjectsForActor(actor, allProjects);
  const target = visibleProjects.find((project) => project.project_id === projectId);
  if (!target) return empty;

  // Cross-project means across projects. One project has nothing to relate to,
  // and a subproject's parent is the same body of work, not another one.
  const others = visibleProjects.filter((project) => (
    project.project_id !== projectId
    && project.parent_project_id !== projectId
    && !(target.parent_project_id && project.project_id === target.parent_project_id)
  ));
  if (!others.length) return empty;

  const queryTerms = buildQueryTerms(target);
  if (!queryTerms.length) return empty;

  const candidates = others.flatMap(candidatesFor);
  if (!candidates.length) return empty;

  const df = documentFrequencyFor(candidates, queryTerms);
  const scored = candidates
    .map((candidate) => ({ ...candidate, score: scoreCandidate(candidate, queryTerms, df, candidates.length) }))
    .filter((candidate) => candidate.score >= MIN_SCORE && candidate.headline)
    .sort((a, b) => b.score - a.score);

  // One project should not fill the block. Three decisions from the same
  // neighbour reads as that project leaking into this one; one each from three
  // reads as a portfolio.
  const perProject = new Map();
  const picked = [];
  for (const candidate of scored) {
    const seen = perProject.get(candidate.project_id) || 0;
    if (seen >= 2) continue;
    perProject.set(candidate.project_id, seen + 1);
    picked.push(candidate);
    if (picked.length >= limit) break;
  }

  const projectCount = new Set(picked.map((candidate) => candidate.project_id)).size;

  if (!unlocked) {
    return { locked: true, count: picked.length, project_count: projectCount, entries: [] };
  }

  return {
    locked: false,
    count: picked.length,
    project_count: projectCount,
    entries: picked.map((candidate) => ({
      project_id: candidate.project_id,
      project_name: candidate.project_name,
      kind: candidate.kind,
      headline: candidate.headline,
      anchor: candidate.anchor || null,
      decided_at: candidate.at,
      date_inferred: candidate.date_inferred,
      score: Math.round(candidate.score * 100) / 100,
    })),
  };
}

module.exports = {
  getRelatedFromOtherProjects,
  // Exported for tests — the ranking is the product, so it is worth pinning
  // directly rather than only through the assembled block.
  buildQueryTerms,
  decisionHeadline,
  MIN_SCORE,
};
