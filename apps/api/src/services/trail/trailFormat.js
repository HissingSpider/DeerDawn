'use strict';

// The .dawn Trail archive format — single source of truth for how a Trail is
// serialized, checksummed, and validated.
//
// DESIGN CONSTRAINT (deliberate, do not "improve" this later): a .dawn file is
// plain UTF-8 JSON. It is NOT encrypted, NOT obfuscated, NOT a proprietary
// container. Anyone can open one in a text editor, diff two of them in git, and
// reimplement this reader in an afternoon from the spec below. A Trail's value
// has to come from the graph being genuinely queryable — see trailFlatten.js,
// which exists to keep us honest about that — never from the file being hard to
// read. An OSS audience detects artificial lock-in immediately and it would
// define the project's reputation.
//
// ─── Canonical form + checksum ───────────────────────────────────────────────
// The checksum is a SHA-256 over the canonical JSON encoding of
// { format, format_version, manifest, content }, where canonical means:
//   1. object keys sorted by code unit (Array.prototype.sort default),
//   2. no insignificant whitespace,
//   3. `undefined`-valued keys omitted; arrays keep their order.
// The top-level `checksum` block is NOT part of the digest input (it cannot be —
// it contains the digest). This is deliberately simple so a third-party reader
// can verify a Trail without our code.

const crypto = require('crypto');

const DAWN_FORMAT = 'dawn';
const DAWN_FORMAT_VERSION = 1;
const CHECKSUM_ALGORITHM = 'sha256';
const CANONICALIZATION = 'sorted-key-json-v1';

// Every content section a Trail carries. Order is stable so a flattened or
// rendered Trail reads the same way twice.
const CONTENT_SECTIONS = [
  'brief',
  'decisions',
  'graph',
  'paths',
  'findings',
  'commands',
  'board',
];

// ─── Kind ────────────────────────────────────────────────────────────────────
// A Trail is either a PROJECT — one project's memory, moved between machines or
// published as a case study — or a PACK: curated knowledge about a stack or a
// tool, written to be imported into somebody else's project.
//
// The distinction is not cosmetic, and it lives in the manifest rather than in a
// convention because the importer has to act on it. A project Trail donates its
// whole brief; a pack donates almost none of it, because a pack's `current_task`
// is its author's task, not the importer's (see PACK_BRIEF_FIELDS in
// trailImport.js).
//
// Trails exported before this field existed carry no `kind` and read as
// 'project', which is what they are.
const TRAIL_KINDS = ['project', 'pack'];
const DEFAULT_TRAIL_KIND = 'project';

/**
 * Coerce a caller-supplied kind to a known one. Export-side only — on the read
 * side an unrecognized kind is refused rather than defaulted (see parseTrail).
 * @param {*} kind
 * @returns {string}
 */
function normalizeKind(kind) {
  const value = String(kind || '').trim().toLowerCase();
  return TRAIL_KINDS.includes(value) ? value : DEFAULT_TRAIL_KIND;
}

/**
 * The kind of an already-parsed Trail.
 * @param {object} trail
 * @returns {string}
 */
function trailKind(trail) {
  const stated = trail?.manifest?.kind;
  if (stated === undefined || stated === null || stated === '') return DEFAULT_TRAIL_KIND;
  return normalizeKind(stated);
}

/**
 * Recursively produce the canonical JSON string for a value.
 * Sorted keys, no whitespace, undefined dropped.
 * @param {*} value
 * @returns {string}
 */
function canonicalize(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry === undefined ? null : entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
  return JSON.stringify(value);
}

/**
 * Digest input for a Trail: everything except the checksum block itself.
 * @param {object} trail
 * @returns {string}
 */
function digestInput(trail) {
  return canonicalize({
    format: trail.format,
    format_version: trail.format_version,
    manifest: trail.manifest,
    content: trail.content,
  });
}

/**
 * Compute the checksum block for a Trail.
 * @param {object} trail
 * @returns {{algorithm: string, canonicalization: string, value: string}}
 */
function computeChecksum(trail) {
  const value = crypto.createHash(CHECKSUM_ALGORITHM).update(digestInput(trail), 'utf8').digest('hex');
  return { algorithm: CHECKSUM_ALGORITHM, canonicalization: CANONICALIZATION, value };
}

/**
 * Attach (or refresh) the checksum on a Trail. Returns a new object.
 * Call this LAST, after any redaction — a Trail whose checksum predates its
 * redaction would verify against the unredacted bytes and defeat the gate.
 * @param {object} trail
 * @returns {object}
 */
function sealTrail(trail) {
  const unsealed = { ...trail };
  delete unsealed.checksum;
  return { ...unsealed, checksum: computeChecksum(unsealed) };
}

/**
 * Verify a Trail's checksum.
 * @param {object} trail
 * @returns {{valid: boolean, reason?: string, expected?: string, actual?: string}}
 */
function verifyChecksum(trail) {
  const stated = trail?.checksum;
  if (!stated || typeof stated !== 'object') return { valid: false, reason: 'checksum_missing' };
  if (stated.algorithm !== CHECKSUM_ALGORITHM) {
    return { valid: false, reason: `unsupported_checksum_algorithm: ${stated.algorithm}` };
  }
  if (stated.canonicalization !== CANONICALIZATION) {
    return { valid: false, reason: `unsupported_canonicalization: ${stated.canonicalization}` };
  }
  const actual = computeChecksum(trail).value;
  if (actual !== stated.value) {
    return { valid: false, reason: 'checksum_mismatch', expected: stated.value, actual };
  }
  return { valid: true };
}

/**
 * Serialize a Trail to the bytes that belong in a .dawn file.
 * Pretty-printed on purpose: these files are meant to be read and diffed.
 * @param {object} trail
 * @returns {string}
 */
function serializeTrail(trail) {
  return `${JSON.stringify(trail, null, 2)}\n`;
}

/**
 * Parse and structurally validate a .dawn document.
 * Throws an Error carrying `publicMessage` on anything a caller can fix.
 * @param {string|object} input raw file contents or an already-parsed object
 * @param {{requireChecksum?: boolean}} [options]
 * @returns {object} the parsed Trail
 */
function parseTrail(input, options = {}) {
  const requireChecksum = options.requireChecksum !== false;
  let trail;
  if (typeof input === 'string') {
    try {
      trail = JSON.parse(input);
    } catch (err) {
      const error = new Error('trail_parse_failed');
      error.publicMessage = `trail_parse_failed: not valid JSON (${err.message}). A .dawn file is plain JSON — check it was not truncated.`;
      throw error;
    }
  } else {
    trail = input;
  }

  if (!trail || typeof trail !== 'object' || Array.isArray(trail)) {
    const error = new Error('trail_invalid');
    error.publicMessage = 'trail_invalid: expected a JSON object at the top level.';
    throw error;
  }
  if (trail.format !== DAWN_FORMAT) {
    const error = new Error('trail_invalid_format');
    error.publicMessage = `trail_invalid_format: expected format "${DAWN_FORMAT}", got ${JSON.stringify(trail.format)}.`;
    throw error;
  }
  // Reject the future, accept the past: a newer major version may carry sections
  // this reader would silently drop, and silently dropping a section of someone's
  // project memory is worse than refusing the file.
  if (!Number.isInteger(trail.format_version) || trail.format_version > DAWN_FORMAT_VERSION) {
    const error = new Error('trail_unsupported_version');
    error.publicMessage = `trail_unsupported_version: this build reads .dawn format_version <= ${DAWN_FORMAT_VERSION}, got ${JSON.stringify(trail.format_version)}. Upgrade DeerDawn to read it.`;
    throw error;
  }
  if (!trail.manifest || typeof trail.manifest !== 'object') {
    const error = new Error('trail_manifest_missing');
    error.publicMessage = 'trail_manifest_missing: a .dawn file must carry a manifest.';
    throw error;
  }
  if (!trail.content || typeof trail.content !== 'object') {
    const error = new Error('trail_content_missing');
    error.publicMessage = 'trail_content_missing: a .dawn file must carry a content block.';
    throw error;
  }

  // An unknown kind is refused, not defaulted. Kind decides how much of the
  // brief an import is willing to donate, so guessing it wrong writes a
  // stranger's task state into someone's project — the exact failure this field
  // exists to prevent. Same reasoning as the format_version check above.
  const statedKind = trail.manifest.kind;
  if (statedKind !== undefined && statedKind !== null && !TRAIL_KINDS.includes(statedKind)) {
    const error = new Error('trail_unsupported_kind');
    error.publicMessage = `trail_unsupported_kind: expected one of ${TRAIL_KINDS.map((kind) => JSON.stringify(kind)).join(', ')}, got ${JSON.stringify(statedKind)}. Upgrade DeerDawn to read it.`;
    throw error;
  }

  if (requireChecksum) {
    const result = verifyChecksum(trail);
    if (!result.valid) {
      const error = new Error('trail_checksum_invalid');
      error.publicMessage = result.reason === 'checksum_mismatch'
        ? `trail_checksum_invalid: content does not match its checksum (expected ${result.expected}, computed ${result.actual}). The file was modified after export — re-export it rather than hand-editing.`
        : `trail_checksum_invalid: ${result.reason}.`;
      throw error;
    }
  }

  return trail;
}

/**
 * An empty, well-formed content block. Import and export both start here so a
 * section that happens to be empty is present-and-empty rather than absent,
 * which keeps consumers from having to guard every access.
 * @returns {object}
 */
function emptyContent() {
  return {
    brief: {},
    decisions: [],
    graph: { nodes: [], edges: [] },
    paths: [],
    findings: [],
    commands: [],
    board: { cards: [] },
  };
}

module.exports = {
  DAWN_FORMAT,
  DAWN_FORMAT_VERSION,
  CHECKSUM_ALGORITHM,
  CANONICALIZATION,
  CONTENT_SECTIONS,
  TRAIL_KINDS,
  DEFAULT_TRAIL_KIND,
  normalizeKind,
  trailKind,
  canonicalize,
  computeChecksum,
  sealTrail,
  verifyChecksum,
  serializeTrail,
  parseTrail,
  emptyContent,
};
