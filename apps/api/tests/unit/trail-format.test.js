/**
 * .dawn Trail format — canonicalization, checksum, parse guards. No DB.
 */
const test = require('node:test');
const assert = require('node:assert');

const format = require('../../src/services/trail/trailFormat');
const { buildTrail } = require('../../src/services/trail/trailExport');
const { makeProject } = require('../helpers/trailFixture');

function fixtureTrail(options = {}) {
  const project = makeProject(options);
  return buildTrail({
    project,
    graph: project.graph,
    source: { repo_url: 'https://github.com/example/repo', commit_sha: 'a1b2c3d4e5f6', branch: 'main' },
    exportedAt: '2026-08-17T00:00:00.000Z',
    trailId: 'trail_fixed',
  });
}

test('canonicalize sorts keys and is stable across key insertion order', () => {
  const a = { b: 1, a: { d: [3, 2], c: 'x' } };
  const b = { a: { c: 'x', d: [3, 2] }, b: 1 };
  assert.strictEqual(format.canonicalize(a), format.canonicalize(b));
  // Array order is meaningful and must NOT be sorted.
  assert.notStrictEqual(format.canonicalize({ a: [1, 2] }), format.canonicalize({ a: [2, 1] }));
});

test('canonicalize drops undefined keys but preserves null', () => {
  assert.strictEqual(format.canonicalize({ a: undefined, b: null }), '{"b":null}');
});

test('a freshly built Trail verifies against its own checksum', () => {
  const trail = fixtureTrail();
  assert.strictEqual(format.verifyChecksum(trail).valid, true);
  assert.strictEqual(trail.checksum.algorithm, 'sha256');
  assert.strictEqual(trail.checksum.canonicalization, 'sorted-key-json-v1');
});

test('the checksum is deterministic for identical content', () => {
  assert.strictEqual(fixtureTrail().checksum.value, fixtureTrail().checksum.value);
});

test('tampering with content invalidates the checksum', () => {
  const trail = fixtureTrail();
  const tampered = JSON.parse(JSON.stringify(trail));
  tampered.content.brief.current_task = 'something else entirely';
  const result = format.verifyChecksum(tampered);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'checksum_mismatch');
  assert.throws(() => format.parseTrail(tampered), /checksum/i);
});

test('tampering with the manifest invalidates the checksum too', () => {
  const trail = fixtureTrail();
  const tampered = JSON.parse(JSON.stringify(trail));
  tampered.manifest.source.commit_sha = 'ffffffffffff';
  assert.strictEqual(format.verifyChecksum(tampered).valid, false);
});

test('parseTrail rejects malformed, misversioned, and structurally incomplete files', () => {
  assert.throws(() => format.parseTrail('{not json'), /trail_parse_failed/);
  assert.throws(() => format.parseTrail(JSON.stringify({ format: 'zip' })), /trail_invalid_format/);
  assert.throws(
    () => format.parseTrail(JSON.stringify({ format: 'dawn', format_version: 99, manifest: {}, content: {} })),
    /trail_unsupported_version/,
  );
  assert.throws(
    () => format.parseTrail(JSON.stringify({ format: 'dawn', format_version: 1, content: {} })),
    /trail_manifest_missing/,
  );
  assert.throws(
    () => format.parseTrail(JSON.stringify({ format: 'dawn', format_version: 1, manifest: {} })),
    /trail_content_missing/,
  );
});

test('a serialized Trail round-trips through parse', () => {
  const trail = fixtureTrail();
  const parsed = format.parseTrail(format.serializeTrail(trail));
  assert.deepStrictEqual(parsed, trail);
});

test('a .dawn file is plain readable JSON — not encrypted or obfuscated', () => {
  const serialized = format.serializeTrail(fixtureTrail());
  // The guarantee that matters to an OSS audience: open it in an editor and the
  // content is right there in the clear.
  assert.ok(serialized.includes('Harden the extraction retry path'), 'brief content should be readable in the raw file');
  assert.ok(serialized.includes('"format": "dawn"'), 'should be pretty-printed JSON');
  assert.doesNotThrow(() => JSON.parse(serialized));
});

test('sealTrail replaces a stale checksum rather than nesting one', () => {
  const trail = fixtureTrail();
  const modified = { ...trail, content: { ...trail.content, brief: { ...trail.content.brief, current_task: 'new task' } } };
  const resealed = format.sealTrail(modified);
  assert.strictEqual(format.verifyChecksum(resealed).valid, true);
  assert.notStrictEqual(resealed.checksum.value, trail.checksum.value);
  assert.strictEqual(Object.keys(resealed.checksum).length, 3);
});

// ─── Kind ────────────────────────────────────────────────────────────────────

test('a Trail with no kind reads as a project', () => {
  const trail = fixtureTrail();
  const legacy = format.sealTrail({ ...trail, manifest: { ...trail.manifest, kind: undefined } });
  assert.strictEqual(legacy.manifest.kind, undefined);
  assert.strictEqual(format.trailKind(legacy), 'project');
  assert.doesNotThrow(() => format.parseTrail(format.serializeTrail(legacy)));
});

test('an unrecognized kind is refused rather than defaulted', () => {
  const trail = fixtureTrail();
  const weird = format.sealTrail({ ...trail, manifest: { ...trail.manifest, kind: 'gallery' } });
  // Defaulting would write the author's task state into a stranger's project —
  // exactly what kind exists to prevent — so an unknown kind is a hard stop.
  assert.throws(() => format.parseTrail(format.serializeTrail(weird)), /trail_unsupported_kind/);
});

test('normalizeKind coerces on the write side only', () => {
  assert.strictEqual(format.normalizeKind('pack'), 'pack');
  assert.strictEqual(format.normalizeKind('PACK'), 'pack');
  assert.strictEqual(format.normalizeKind(''), 'project');
  assert.strictEqual(format.normalizeKind('gallery'), 'project');
});
