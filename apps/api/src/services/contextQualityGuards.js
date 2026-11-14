'use strict';

// Shared write-time quality guards. Centralized here so contextSyncService and
// extractionService (and import paths) apply the SAME rules and can't drift.

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A comparison key for "have we already stored this?" checks.
 *
 * Deliberately SEPARATE from normalizeText. normalizeText also builds canonical
 * graph keys (canonicalWorkspaceKey) and search haystacks, and changing what it
 * returns would silently re-identify existing graph nodes — so the looser rules
 * a dedupe check wants cannot live there.
 *
 * What this adds over normalizeText: terminal punctuation is ignored. The same
 * completion arriving once as "OAuth review suite passed" and once as "OAuth
 * review suite passed." was stored TWICE and rendered as two near-identical
 * SHIPPED cards, because a trailing full stop made the strings unequal. Models
 * vary that punctuation freely between sessions, so it carries no meaning worth
 * distinguishing entries by.
 *
 * Only trailing sentence punctuation is stripped — internal punctuation stays,
 * so "Ship v1, then v2" and "Ship v1 then v2" remain different entries.
 */
function dedupeKey(text) {
  return normalizeText(text).replace(/[.!?;:,\s]+$/g, '');
}

function tokenizeTitle(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}

function titleSimilarity(a, b) {
  const ta = new Set(tokenizeTitle(a));
  const tb = tokenizeTitle(b);
  if (!ta.size || !tb.length) return 0;
  const overlap = tb.filter((t) => ta.has(t)).length;
  return overlap / Math.max(ta.size, tb.length);
}

// Symmetric Jaccard over token sets — better than titleSimilarity for long
// content (decisions/knowledge) where re-phrasing dilutes one-directional overlap.
function jaccardSimilarity(a, b) {
  const ta = new Set(tokenizeTitle(a));
  const tb = new Set(tokenizeTitle(b));
  if (!ta.size || !tb.size) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection += 1;
  const union = ta.size + tb.size - intersection;
  return union ? intersection / union : 0;
}

const GENERIC_PHRASES = [
  'working on it',
  'continue',
  'continuing',
  'progressing',
  'moving forward',
  'updating',
  'in progress',
];

function isGenericText(text) {
  const normalized = normalizeText(text);
  if (!normalized) return true;
  if (normalized.length < 18) return true;
  return GENERIC_PHRASES.includes(normalized);
}

// Trivial = too short or no substantive token to be worth storing. Distinct from
// extractionService.isTrivialConversation, which scores whole chunk batches.
function isTrivialText(text) {
  const normalized = normalizeText(text);
  if (!normalized) return true;
  if (normalized.length <= 12) return true;
  const hasMeaningfulToken = normalized
    .split(/\s+/)
    .some((w) => w.length > 4 && /[a-z]{3,}/i.test(w));
  return !hasMeaningfulToken;
}

// Filler tokens that carry no decision signal on their own. A "decision" made
// entirely of these ("various improvements", "general cleanup") is noise.
const VAGUE_DECISION_TOKENS = new Set([
  'various', 'misc', 'miscellaneous', 'general', 'stuff', 'things', 'thing',
  'improvement', 'improvements', 'update', 'updates', 'change', 'changes',
  'cleanup', 'refactor', 'refactoring', 'tweak', 'tweaks', 'fix', 'fixes',
  'work', 'progress', 'wip', 'done', 'other', 'others', 'etc', 'minor', 'small',
]);

const DECISION_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'into', 'from', 'this', 'that', 'some', 'more',
  'made', 'making', 'using', 'used', 'add', 'added', 'adding', 'now', 'then',
]);

// A decision summary is vague when it's too short, too few words, or dominated
// by filler with no concrete anchor token to ground what was actually decided.
// Conservative on purpose: it should drop obvious noise ("various improvements")
// but keep anything with a real subject ("switched sessions to Redis").
function isVagueDecision(summary) {
  const normalized = normalizeText(summary);
  if (!normalized) return true;
  if (normalized.length < 20) return true;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length < 3) return true;
  const hasAnchor = words.some(
    (w) => w.length >= 4 && !VAGUE_DECISION_TOKENS.has(w) && !DECISION_STOPWORDS.has(w),
  );
  if (!hasAnchor) return true;
  const vague = words.filter((w) => VAGUE_DECISION_TOKENS.has(w)).length;
  return vague / words.length > 0.4;
}

// Names that look like files, paths, or boilerplate placeholders should never
// become a project title — that's how a "CLAUDE.md" project gets created.
const FILENAME_NAME_RE = /\.(md|markdown|txt|json|ya?ml|toml|js|cjs|mjs|ts|tsx|jsx|py|go|rb|rs|java|c|h|cpp|hpp|sh|bash|zsh|env|lock|cfg|conf|ini|xml|html|css|sql)$/i;
const PLACEHOLDER_NAMES = new Set([
  'untitled', 'untitled project', 'new project', 'project', 'readme', 'claude',
  'agents', 'cursorrules', 'copilot instructions', 'context', 'index',
]);

// Shortest acceptable project name. 2 rather than 3 so genuinely-used short names
// ("V2", "QA", "ML") work; junk rejection below (paths, dotfiles, placeholders) is what
// this guard is really for, and is unaffected by the length.
const MIN_PROJECT_NAME_LENGTH = 2;

// True when a name is rejected *only* because it is too short. Callers use this to tell
// the user "make it longer" instead of the generic junk-name message, which is confusing
// advice when the name is fine apart from its length.
function isTooShortProjectName(name) {
  const raw = String(name || '').trim();
  return raw.length > 0 && raw.length < MIN_PROJECT_NAME_LENGTH;
}

function isValidProjectName(name) {
  const raw = String(name || '').trim();
  if (raw.length < MIN_PROJECT_NAME_LENGTH) return false;
  if (raw.includes('/') || raw.includes('\\')) return false; // a path, not a name
  if (/^[._]/.test(raw)) return false; // dotfile-ish (.deerdawn-context, etc.)
  if (FILENAME_NAME_RE.test(raw)) return false;
  const normalized = normalizeText(raw);
  if (!normalized) return false;
  if (PLACEHOLDER_NAMES.has(normalized)) return false;
  return true;
}

// Returns a usable project name: the candidate if it's valid, otherwise the
// fallback (also validated, else a safe generic). Keeps junk names out of the
// project list while never throwing on creation.
function sanitizeProjectName(candidate, fallback = '') {
  if (isValidProjectName(candidate)) return String(candidate).trim();
  if (isValidProjectName(fallback)) return String(fallback).trim();
  return 'Untitled project';
}

module.exports = {
  dedupeKey,
  normalizeText,
  tokenizeTitle,
  titleSimilarity,
  jaccardSimilarity,
  isGenericText,
  isTrivialText,
  isVagueDecision,
  isValidProjectName,
  isTooShortProjectName,
  sanitizeProjectName,
  MIN_PROJECT_NAME_LENGTH,
};
