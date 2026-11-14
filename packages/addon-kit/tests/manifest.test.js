'use strict';
const test = require('node:test');
const assert = require('node:assert');
const kit = require('../src');

const good = () => ({
  id: 'notes-example',
  name: 'Notes',
  version: '0.1.0',
  kind: 'declarative',
  collections: { notes: { schema: 'schemas/note.json' } },
  skill: 'SKILL.md',
  brief_line: 'Notes: {{notes.count}} saved',
  views: [{ id: 'all', type: 'table', collection: 'notes', fields: ['title'] }],
});

test('a well-formed manifest validates', () => {
  assert.deepStrictEqual(kit.validateManifest(good()), { ok: true, errors: [] });
});

test('bad manifests are rejected with a reason', () => {
  const cases = [
    [null, /JSON object/],
    [{ ...good(), id: 'Bad Id' }, /"id"/],
    [{ ...good(), version: 'one' }, /"version"/],
    [{ ...good(), kind: 'plugin' }, /"kind"/],
    [{ ...good(), collections: {} }, /at least one collection/],
    [{ ...good(), collections: { notes: { schema: '../../etc/passwd' } } }, /relative path/],
    [{ ...good(), collections: { notes: { schema: '/abs.json' } } }, /relative path/],
    [{ ...good(), skill: '../SKILL.md' }, /"skill"/],
    [{ ...good(), brief_line: '{{notes.data.title}}' }, /only substitution/],
    [{ ...good(), brief_line: '{{others.count}}' }, /only substitution/],
    [{ ...good(), views: [{ id: 'x', type: 'kanban', collection: 'notes' }] }, /"type"/],
    [{ ...good(), views: [{ id: 'x', type: 'table', collection: 'nope' }] }, /declared collection/],
    [{ ...good(), default_visibility: 'shared' }, /personal/],
    [{ ...good(), extra: 1 }, /unknown field "extra"/],
    [(() => { const m = good(); delete m.name; return m; })(), /"name" is required/],
  ];
  for (const [manifest, pattern] of cases) {
    const result = kit.validateManifest(manifest);
    assert.strictEqual(result.ok, false, JSON.stringify(manifest));
    assert.ok(result.errors.some((e) => pattern.test(e)), `${pattern} in ${result.errors.join('; ')}`);
  }
});

test('validateActions rejects reserved and malformed actions', () => {
  assert.ok(kit.validateActions({ ok: { mode: 'read', description: 'x', handler: async () => ({ text: '' }) } }).ok);
  assert.ok(!kit.validateActions({ help: { mode: 'read', description: 'x', handler: async () => ({}) } }).ok);
  assert.ok(!kit.validateActions({ go: { mode: 'delete', description: 'x', handler: async () => ({}) } }).ok);
  assert.ok(!kit.validateActions({ go: { mode: 'read', description: 'x' } }).ok);
});

test('renderBriefLine substitutes counts only', () => {
  assert.strictEqual(kit.renderBriefLine('Notes: {{notes.count}} saved', { notes: 4 }), 'Notes: 4 saved');
  assert.strictEqual(kit.renderBriefLine('{{notes.count}} / {{x.y}}', {}), '0 /');
  assert.deepStrictEqual(kit.briefLineCollections('{{a.count}} {{b.count}} {{a.count}}'), ['a', 'b']);
});
