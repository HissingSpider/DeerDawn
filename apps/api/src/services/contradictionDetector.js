'use strict';

// Two people, one project, opposite conclusions.
//
// WHY THIS IS PRESENTED AND NEVER RESOLVED. On a single-user account the merge
// can dedupe by summary and let the last writer win, because the loser was also
// you. On a shared workspace that silently deletes a colleague's finding — and
// the finding is the product. So when two authors disagree, both entries stay
// and the brief says so. Picking a winner automatically would throw away the one
// piece of information nobody else has: that the team is not agreed.
//
// WHAT THIS DELIBERATELY DOES NOT ATTEMPT. Semantic contradiction. There is no
// model call here and no attempt to understand a claim. It reports CANDIDATES on
// two mechanical signals that are cheap and checkable:
//
//   1. The two entries are about the same subject — high Jaccard overlap on
//      content tokens, reusing the same primitive the dedupe path already
//      trusts, so "same subject" means here what it means everywhere else.
//   2. They differ in POLARITY — one negates and the other does not.
//
// Requiring both is what keeps the false-positive rate survivable. Overlap alone
// fires constantly (two people describing the same decision agree, they do not
// disagree); polarity alone fires on unrelated sentences. Together they describe
// a narrow shape: same subject, opposite stance.
//
// A missed contradiction costs nothing — the brief is simply as it was. A false
// one costs attention and trust, so every threshold here is set to under-report,
// and the output is worded as something to check rather than as a finding.

const { normalizeText, tokenizeTitle, jaccardSimilarity } = require('./contextQualityGuards');

// Same-subject bar. Set high on purpose: two entries have to be talking about
// substantially the same thing before their stance is worth comparing at all.
const SUBJECT_SIMILARITY = 0.45;

// Below this many shared content tokens, a high Jaccard score is an artefact of
// two very short strings rather than evidence of a shared subject.
const MIN_SHARED_TOKENS = 2;

// Only compare entries recorded near each other. Two opposite decisions six
// months apart is a project changing its mind, which is the system working; two
// in the same fortnight is a team that has not noticed it disagrees.
const DEFAULT_WINDOW_DAYS = 21;

// Negation carried by a whole clause, not by any word that happens to appear.
// Anchored to word boundaries so "cannot" matches and "canonical" does not.
const NEGATION_PATTERNS = [
  /\bnever\b/,
  /\bnot\b/,
  /\bno longer\b/,
  /\bdon'?t\b/,
  /\bdoesn'?t\b/,
  /\bdidn'?t\b/,
  /\bwon'?t\b/,
  /\bcan'?t\b/,
  /\bcannot\b/,
  /\bavoid\b/,
  /\bstop\b/,
  /\bstopped\b/,
  /\bremove\b/,
  /\bremoved\b/,
  /\bdrop\b/,
  /\bdropped\b/,
  /\bdisable\b/,
  /\bdisabled\b/,
  /\brevert\b/,
  /\breverted\b/,
  /\bwithout\b/,
];

function isNegated(text) {
  const normalized = normalizeText(text);
  return NEGATION_PATTERNS.some((pattern) => pattern.test(normalized));
}

function sharedTokenCount(a, b) {
  const ta = new Set(tokenizeTitle(a));
  let shared = 0;
  for (const token of new Set(tokenizeTitle(b))) if (ta.has(token)) shared += 1;
  return shared;
}

function toMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Find candidate disagreements among a project's decisions.
 *
 * Returns [] for anything that is not a genuine two-author disagreement, which
 * on a single-user account is everything — a solo workspace pays one cheap pass
 * over at most twenty entries and gets nothing back, by design.
 *
 * @param {Array} decisions recent_decisions entries
 * @param {{windowDays?: number, now?: number}} [options]
 * @returns {Array<{subject: string, entries: Array}>}
 */
function detectContradictions(decisions, options = {}) {
  const list = (Array.isArray(decisions) ? decisions : [])
    .filter((entry) => entry && entry.summary && entry.contributed_by && !entry.resolved);
  if (list.length < 2) return [];

  const windowMs = (options.windowDays || DEFAULT_WINDOW_DAYS) * 24 * 60 * 60 * 1000;
  const found = [];
  const seen = new Set();

  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];

      // Same author is not a disagreement — it is somebody changing their mind,
      // which needs no intervention from us.
      if (a.contributed_by === b.contributed_by) continue;

      // Opposite stance is the load-bearing signal. Without it, high overlap
      // means the two people AGREE, which is the common case and must stay silent.
      if (isNegated(a.summary) === isNegated(b.summary)) continue;

      const aMs = toMs(a.decided_at);
      const bMs = toMs(b.decided_at);
      if (aMs !== null && bMs !== null && Math.abs(aMs - bMs) > windowMs) continue;

      if (jaccardSimilarity(a.summary, b.summary) < SUBJECT_SIMILARITY) continue;
      if (sharedTokenCount(a.summary, b.summary) < MIN_SHARED_TOKENS) continue;

      const key = [a.summary, b.summary].sort().join('||');
      if (seen.has(key)) continue;
      seen.add(key);

      // Newest first: the entry that changed the position is the one the reader
      // most needs to see against what already stood.
      const ordered = [a, b].sort((x, y) => (toMs(y.decided_at) || 0) - (toMs(x.decided_at) || 0));
      found.push({
        subject: ordered[0].summary,
        entries: ordered.map((entry) => ({
          summary: entry.summary,
          contributed_by: entry.contributed_by,
          decided_at: entry.decided_at || null,
        })),
      });
    }
  }
  return found;
}

/**
 * One block for the brief. Names both people, states both positions, and stops.
 *
 * The wording is deliberately a prompt to check rather than an assertion that
 * something is wrong — this is a mechanical signal, and it says so.
 */
function renderContradictions(contradictions, names = new Map()) {
  if (!contradictions?.length) return null;
  const nameOf = (id) => names.get(id) || id;
  const lines = ['Possible disagreement — both of these are standing:'];
  for (const item of contradictions.slice(0, 3)) {
    for (const entry of item.entries) {
      const when = entry.decided_at ? ` (${String(entry.decided_at).slice(0, 10)})` : '';
      lines.push(`  ${nameOf(entry.contributed_by)}: ${entry.summary}${when}`);
    }
  }
  lines.push('Nothing has been changed or removed — worth confirming which still holds.');
  return lines.join('\n');
}

module.exports = {
  detectContradictions,
  renderContradictions,
  isNegated,
  SUBJECT_SIMILARITY,
  DEFAULT_WINDOW_DAYS,
};
