'use strict';

// Trail redaction scanner — the launch blocker for publishing.
//
// ─── Why this is not just secretRedaction.js ─────────────────────────────────
// utils/secretRedaction.js masks secrets on the way INTO storage and logs, and
// it is documented as "biased toward false negatives on purpose: silently
// mangling a user's debugging notes is worse than missing a low-entropy
// placeholder". That bias is right there and wrong here.
//
// This scanner runs on the way OUT, to a public gallery, and it inverts that
// trade deliberately: a false positive costs the author one click in the publish
// preview; a false negative publishes a credential, a home directory, a client's
// name, or someone's finances to the internet permanently. So this module casts
// a wider net, and — critically — it REPORTS rather than masks. Nothing here
// silently rewrites the author's text. Every hit becomes a finding the author
// must resolve by hand before a Trail can go public.
//
// The scanner does not decide anything. trailPublish.js owns the gate.

const { redactSecrets, REDACTED, DEERDAWN_CREDENTIAL_PATTERNS } = require('../../utils/secretRedaction');
const crypto = require('crypto');

const SCANNER_VERSION = 1;

// Severity drives how loudly the preview shouts, not whether the finding can be
// skipped — the gate requires every finding to be resolved regardless. See
// trailPublish.js.
const SEVERITY = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };

// ─── Detectors ───────────────────────────────────────────────────────────────
// Each detector returns [{ start, end, match }] spans over a string.

// Credentials: reuse the persist-time patterns as a floor. We detect a hit by
// running the canonical redactor and checking whether it changed anything —
// that guarantees this scanner can never be weaker than the storage redactor,
// even as new provider patterns are added there.
//
// DeerDawn's own credentials (an API key / access token `dd_…`, a refresh token
// `ddr_…`) are located EXACTLY first. The floor alone did not know them — the
// storage redactor had no pattern for our own keys — so a Trail carrying a live
// key previewed with 0 findings and published. They are now in the floor too;
// finding them here as well gives each one a precise span, and blanking them
// before the floor runs keeps one secret from becoming two findings.
function detectCredentials(text) {
  const own = [];
  for (const pattern of DEERDAWN_CREDENTIAL_PATTERNS) {
    own.push(...collectMatches(text, new RegExp(pattern.source, 'g')));
  }
  let rest = text;
  for (const span of own) {
    rest = `${rest.slice(0, span.start)}${' '.repeat(span.end - span.start)}${rest.slice(span.end)}`;
  }
  const floor = detectCredentialFloor(rest);
  return [...own.map((span) => ({ ...span, match: '(credential)' })), ...floor];
}

function detectCredentialFloor(text) {
  const redacted = redactSecrets(text);
  if (redacted === text) return [];
  // The redactor masks in place; recover the spans by diffing on [REDACTED]
  // boundaries. We only need span-ish positions for the excerpt, so a single
  // whole-string finding is acceptable when alignment is ambiguous.
  const spans = [];
  let cursor = 0;
  let searchFrom = 0;
  for (;;) {
    const marker = redacted.indexOf(REDACTED, searchFrom);
    if (marker === -1) break;
    // Everything before the marker matched 1:1, so the original offset of the
    // secret is the marker offset adjusted by the drift accumulated so far.
    const prefix = redacted.slice(searchFrom, marker);
    cursor += prefix.length;
    // The offset above drifts after the first secret (the redactor does not say
    // how long each masked span was), so it can land INSIDE an earlier secret —
    // and an excerpt cut there carries that secret's unrecognisable tail. The
    // excerpt is therefore cut from the REDACTED text, where every secret the
    // floor knows is already a marker.
    const head = redacted.slice(Math.max(0, marker - EXCERPT_RADIUS), marker);
    const tailEnd = Math.min(redacted.length, marker + REDACTED.length + EXCERPT_RADIUS);
    const excerpt = `${marker - head.length > 0 ? '…' : ''}${head}${REDACTED}${redacted.slice(marker + REDACTED.length, tailEnd)}${tailEnd < redacted.length ? '…' : ''}`;
    spans.push({ start: cursor, end: cursor, match: '(credential)', excerpt });
    searchFrom = marker + REDACTED.length;
  }
  return spans.length ? spans : [{ start: 0, end: text.length, match: '(credential)' }];
}

// Email addresses. Intentionally broad — an address in a public Trail is a
// spam vector and, for a corporate domain, a client disclosure.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// Absolute home directories. These leak the author's OS username, and often a
// client or employer name in the folder path.
const HOME_PATH_RE = /(?:\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._ -]+)(?:[/\\][^\s"'`,;)\]]*)?/g;

// Financial figures: currency-marked amounts, and bare magnitudes with a
// currency word. Not every number is sensitive; a number attached to money in
// someone's private project notes usually is.
const FINANCIAL_RE = /(?:[$£€¥]\s?\d[\d,.]*\s?(?:[kKmMbB]|million|billion|thousand)?\b|\b\d[\d,.]*\s?(?:USD|EUR|GBP|JPY|CAD|AUD)\b|\b(?:USD|EUR|GBP)\s?\d[\d,.]*)/g;

// Long digit runs that look like an account, card, routing, or IBAN fragment.
//
// The bare-digit-run branch is guarded against machine identifiers. Every board
// card id and graph node id in a Trail looks like `todo-1787941234-9tbp6`, and
// `\b\d{9,18}\b` happily matched the embedded timestamp — so a routine publish
// raised a HIGH "account number" finding per card and per node. That is worse
// than noise: the only way to clear a finding on an id is to exclude the field,
// and excluding a node_id breaks every edge that references it. The gate would
// have corrupted the graph in the name of protecting it.
//
// An account number written in prose is delimited by whitespace or sentence
// punctuation. One embedded in an identifier is flanked by a hyphen, an
// underscore, or a letter, so those are excluded. Grouped card numbers keep
// their own branch above, which still allows the hyphens inside them.
const ACCOUNT_NUMBER_RE = /\b(?:[A-Z]{2}\d{2}[A-Z0-9]{10,30}|\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{2,7}|(?<![-_A-Za-z0-9])\d{9,18}(?![-_A-Za-z0-9]))\b/g;

// Person names. This is the weakest detector in the module and it is honest
// about that: generic NER on prose is a research problem, and a Trail is full
// of capitalized product nouns ("Next Auth", "Redis Cluster") that look exactly
// like "Jane Smith" to a regex.
//
// So it works two ways, and the precise one carries the weight:
//   1. SEEDED (high confidence): names the caller already knows are personal —
//      the account holder's own name and email local-part, supplied by
//      services/trail/index.js. Deliberately narrow: an earlier version also
//      seeded every capitalized token from the owner's project titles, which
//      made a project named "Sync Loop" unpublishable under its own name.
//      High severity is reserved for what we can actually be confident about.
//   2. HEURISTIC (low confidence): a capitalized bigram whose tokens are not
//      recognizable technical vocabulary. Noisy by design — surfaced so a human
//      glances at it, never trusted on its own.
const NAME_STOPLIST = new Set([
  // Common capitalized technical/product bigram tokens. Not exhaustive and not
  // meant to be — it only trims the loudest false positives.
  'api', 'apis', 'app', 'apps', 'aws', 'azure', 'ci', 'cd', 'cli', 'cors', 'cpu', 'css',
  'data', 'db', 'docker', 'dom', 'edge', 'error', 'event', 'file', 'flow', 'git', 'github',
  'google', 'graph', 'html', 'http', 'https', 'id', 'ide', 'io', 'java', 'javascript', 'job',
  'json', 'jwt', 'key', 'kubernetes', 'linux', 'log', 'mac', 'macos', 'map', 'mcp', 'mode',
  'model', 'name', 'next', 'node', 'npm', 'oauth', 'open', 'page', 'path', 'pdf', 'plan',
  'postgres', 'postgresql', 'python', 'react', 'redis', 'rest', 'run', 'rust', 'scope',
  'sdk', 'server', 'service', 'session', 'shell', 'sql', 'ssh', 'ssl', 'stack', 'state',
  'store', 'stripe', 'sync', 'task', 'team', 'test', 'tls', 'token', 'tool', 'trail', 'type',
  'typescript', 'ui', 'url', 'user', 'ux', 'vercel', 'view', 'web', 'windows', 'work',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'deerdawn', 'claude', 'chatgpt', 'cursor', 'codex', 'anthropic', 'openai',
]);
const CAPITALIZED_BIGRAM_RE = /\b([A-Z][a-z]{1,20})\s+([A-Z][a-z]{1,20})\b/g;

function collectMatches(text, regex) {
  const spans = [];
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    spans.push({ start: match.index, end: match.index + match[0].length, match: match[0] });
    if (match.index === regex.lastIndex) regex.lastIndex += 1; // zero-width guard
  }
  return spans;
}

function detectSeededNames(text, seededNames) {
  if (!seededNames || !seededNames.length) return [];
  const spans = [];
  const haystack = text.toLowerCase();
  for (const name of seededNames) {
    const needle = String(name || '').trim().toLowerCase();
    if (needle.length < 3) continue;
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      const before = at === 0 ? ' ' : haystack[at - 1];
      const after = at + needle.length >= haystack.length ? ' ' : haystack[at + needle.length];
      // Word-boundary check so "jo" does not match inside "json".
      if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) {
        spans.push({ start: at, end: at + needle.length, match: text.slice(at, at + needle.length) });
      }
      from = at + needle.length;
    }
  }
  return spans;
}

function detectHeuristicNames(text) {
  return collectMatches(text, CAPITALIZED_BIGRAM_RE).filter((span) => {
    const [first, second] = span.match.split(/\s+/);
    return !NAME_STOPLIST.has(first.toLowerCase()) && !NAME_STOPLIST.has(second.toLowerCase());
  });
}

// ─── Excerpts ────────────────────────────────────────────────────────────────
// The preview has to show the author enough to judge, without the excerpt
// becoming a second copy of the secret in logs, screenshots, and support
// tickets. Credentials are masked outright; everything else keeps a short,
// recognizable head so the author can tell which value it is.

const EXCERPT_RADIUS = 32;

function maskMatch(category, match) {
  if (category === 'credential') return REDACTED;
  const value = String(match);
  if (category === 'email') {
    const at = value.indexOf('@');
    if (at > 0) return `${value.slice(0, 1)}${'*'.repeat(Math.max(1, at - 1))}${value.slice(at)}`;
  }
  if (value.length <= 4) return value;
  return `${value.slice(0, Math.min(4, value.length - 2))}${'*'.repeat(Math.min(8, value.length - 4))}`;
}

function buildExcerpt(text, span, category) {
  const masked = maskMatch(category, text.slice(span.start, span.end) || span.match);
  // The surrounding context is itself untrusted text, so run it through the
  // storage redactor — a secret sitting next to an email should not ride out in
  // that email's excerpt. Redact the WHOLE prefix and suffix and only then cut
  // the radius: cutting first split a neighbouring credential in two, the
  // redactor no longer recognised either half, and the excerpt carried 20-odd
  // characters of a live key (two keys in one sentence showed each other's).
  const before = redactSecrets(text.slice(0, span.start));
  const after = redactSecrets(text.slice(span.end));
  const head = before.slice(Math.max(0, before.length - EXCERPT_RADIUS));
  const tail = after.slice(0, EXCERPT_RADIUS);
  return `${before.length > head.length ? '…' : ''}${head}${masked}${tail}${after.length > tail.length ? '…' : ''}`;
}

// ─── Field walking ───────────────────────────────────────────────────────────
// Produces (path, value) for every string in the Trail content, with a stable
// dotted/bracketed path so a finding can be tied to exactly one field and an
// exclusion can remove exactly one field.

const MAX_WALK_DEPTH = 12;

function walkStrings(value, path, out, depth = 0) {
  if (depth > MAX_WALK_DEPTH) return out;
  if (typeof value === 'string') {
    if (value.trim()) out.push({ path, value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkStrings(entry, `${path}[${index}]`, out, depth + 1));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      walkStrings(value[key], path ? `${path}.${key}` : key, out, depth + 1);
    }
  }
  return out;
}

// A field path maps back to the section it came from, which is what the preview
// groups by and what an exclusion is scoped to.
function sectionForPath(path) {
  const match = /^content\.([A-Za-z_]+)/.exec(path);
  return match ? match[1] : 'unknown';
}

// The entity a finding sits inside, when there is one — a graph node, a decision,
// a board card. Lets the author exclude a whole entity instead of playing
// whack-a-mole with its fields.
function entityRefForPath(path, content) {
  const nodeMatch = /^content\.graph\.nodes\[(\d+)\]/.exec(path);
  if (nodeMatch) {
    const node = content?.graph?.nodes?.[Number(nodeMatch[1])];
    return node?.node_id ? { kind: 'graph_node', id: String(node.node_id) } : null;
  }
  const cardMatch = /^content\.board\.cards\[(\d+)\]/.exec(path);
  if (cardMatch) {
    const card = content?.board?.cards?.[Number(cardMatch[1])];
    return card?.id ? { kind: 'board_card', id: String(card.id) } : null;
  }
  return null;
}

const DETECTORS = [
  { category: 'credential', severity: SEVERITY.HIGH, confidence: 'high', run: (text) => detectCredentials(text) },
  { category: 'email', severity: SEVERITY.HIGH, confidence: 'high', run: (text) => collectMatches(text, EMAIL_RE) },
  { category: 'home_path', severity: SEVERITY.HIGH, confidence: 'high', run: (text) => collectMatches(text, HOME_PATH_RE) },
  { category: 'account_number', severity: SEVERITY.HIGH, confidence: 'medium', run: (text) => collectMatches(text, ACCOUNT_NUMBER_RE) },
  { category: 'financial', severity: SEVERITY.MEDIUM, confidence: 'medium', run: (text) => collectMatches(text, FINANCIAL_RE) },
];

/**
 * Stable id for a finding. Bound to the field path, the category, and the
 * matched text — so an acknowledgement cannot silently carry over to a
 * different value that later lands in the same field.
 */
function findingId(path, category, matchText) {
  return crypto
    .createHash('sha256')
    .update(`${path} ${category} ${matchText}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
}

/**
 * Scan a Trail's content for material that must not be published.
 *
 * @param {object} content the Trail `content` block
 * @param {{seededNames?: string[], includeHeuristicNames?: boolean}} [options]
 * @returns {{scanner_version: number, scanned_at: string, findings: object[], counts: object}}
 */
function scanContent(content, options = {}) {
  const seededNames = options.seededNames || [];
  const includeHeuristicNames = options.includeHeuristicNames !== false;
  // rootPath lets the publish gate scan a whole document ({manifest, content})
  // without every manifest finding being reported under a "content.manifest.…"
  // path that does not exist. A wrong path in an error message sends the author
  // looking for a field that is not there.
  const fields = walkStrings(content, options.rootPath === undefined ? 'content' : options.rootPath, []);
  const findings = [];
  const seen = new Set();

  const push = (path, text, span, category, severity, confidence) => {
    const matchText = text.slice(span.start, span.end) || span.match;
    const id = findingId(path, category, matchText);
    if (seen.has(id)) return;
    seen.add(id);
    findings.push({
      id,
      path,
      section: sectionForPath(path),
      entity: entityRefForPath(path, content),
      category,
      severity,
      confidence,
      excerpt: span.excerpt || buildExcerpt(text, span, category),
    });
  };

  for (const field of fields) {
    for (const detector of DETECTORS) {
      for (const span of detector.run(field.value)) {
        push(field.path, field.value, span, detector.category, detector.severity, detector.confidence);
      }
    }
    for (const span of detectSeededNames(field.value, seededNames)) {
      push(field.path, field.value, span, 'person_name', SEVERITY.HIGH, 'high');
    }
    if (includeHeuristicNames) {
      for (const span of detectHeuristicNames(field.value)) {
        push(field.path, field.value, span, 'person_name', SEVERITY.LOW, 'low');
      }
    }
  }

  const counts = findings.reduce((acc, finding) => {
    acc.by_category[finding.category] = (acc.by_category[finding.category] || 0) + 1;
    acc.by_severity[finding.severity] = (acc.by_severity[finding.severity] || 0) + 1;
    acc.total += 1;
    return acc;
  }, { total: 0, by_category: {}, by_severity: {} });

  return {
    scanner_version: SCANNER_VERSION,
    scanned_at: new Date().toISOString(),
    findings,
    counts,
  };
}

/**
 * Remove a field (or a whole entity) from a Trail's content by the path a
 * finding reported. Returns a new content object; the original is untouched.
 *
 * Removal, not masking: a published Trail should not advertise "there was a
 * secret here". Array members are dropped rather than left as holes.
 *
 * @param {object} content
 * @param {string[]} paths field paths to strip
 * @returns {{content: object, removed: string[], missing: string[]}}
 */
function excludePaths(content, paths) {
  const clone = JSON.parse(JSON.stringify(content));
  const removed = [];
  const missing = [];
  // Deepest-first so removing a parent does not invalidate a child's index, and
  // descending array indices so earlier splices do not shift later targets.
  const ordered = [...new Set(paths || [])].sort((a, b) => b.length - a.length || b.localeCompare(a));

  for (const path of ordered) {
    const segments = String(path).split(/\.|\[(\d+)\]/).filter((s) => s !== undefined && s !== '');
    if (segments[0] !== 'content') { missing.push(path); continue; }
    let parent = null;
    let key = null;
    let cursor = clone;
    let ok = true;
    for (let i = 1; i < segments.length; i += 1) {
      const segment = segments[i];
      const index = /^\d+$/.test(segment) ? Number(segment) : segment;
      if (cursor === null || cursor === undefined || typeof cursor !== 'object') { ok = false; break; }
      parent = cursor;
      key = index;
      cursor = cursor[index];
    }
    if (!ok || parent === null || cursor === undefined) { missing.push(path); continue; }
    if (Array.isArray(parent) && typeof key === 'number') parent.splice(key, 1);
    else delete parent[key];
    removed.push(path);
  }

  return { content: clone, removed, missing };
}

module.exports = {
  SCANNER_VERSION,
  SEVERITY,
  scanContent,
  excludePaths,
  findingId,
  walkStrings,
  // exported for tests
  detectCredentials,
  detectSeededNames,
  detectHeuristicNames,
};
