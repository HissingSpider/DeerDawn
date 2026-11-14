'use strict';

// Handlers may reach the world only through ctx. Two checks: a static scan of
// every runtime source file's requires and globals, and a runtime run of every
// action with the network and filesystem modules booby-trapped.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const runtimeFiles = ['index.js', ...fs.readdirSync(path.join(ROOT, 'lib')).map((f) => path.join('lib', f))].filter((f) => f.endsWith('.js'));

test('runtime code requires only sharp and its own files', () => {
  for (const file of runtimeFiles) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    for (const r of requires) {
      const ok = r === 'sharp' || r.startsWith('./') || r.startsWith('../lib/');
      assert.ok(ok, `${file} requires ${r}`);
      assert.ok(!/apps\/api|packages\//.test(r), `${file} reaches into ${r}`);
    }
    assert.ok(!/\bimport\s*\(/.test(src), `${file} uses dynamic import`);
    assert.ok(!/\b(fetch|XMLHttpRequest|WebSocket)\s*\(/.test(src), `${file} calls the network`);
    assert.ok(!/process\.(env|cwd|chdir)/.test(src), `${file} reads the process environment`);
  }
});

test('every action runs with fs, net and fetch trapped', async () => {
  const trapped = [];
  const trap = (name) => () => { trapped.push(name); throw new Error(`${name} used`); };
  const fsMod = require('node:fs');
  const fsp = require('node:fs/promises');
  const http = require('node:http');
  const https = require('node:https');
  const net = require('node:net');
  const saved = [];
  const patch = (obj, key, name) => { saved.push([obj, key, obj[key]]); obj[key] = trap(name); };
  // helpers/fakeCtx have already read their files at load time.
  const { makeCtx, run, solidThumb } = require('./helpers');
  const thumb = await solidThumb(120, 60, 30);
  for (const k of ['readFileSync', 'writeFileSync', 'readFile', 'writeFile', 'createReadStream', 'createWriteStream', 'openSync']) patch(fsMod, k, `fs.${k}`);
  for (const k of ['readFile', 'writeFile', 'open']) patch(fsp, k, `fs/promises.${k}`);
  patch(http, 'request', 'http.request');
  patch(https, 'request', 'https.request');
  patch(net, 'connect', 'net.connect');
  const savedFetch = globalThis.fetch;
  globalThis.fetch = trap('fetch');
  try {
    const ctx = makeCtx({ llm: { async describeImage() { return '{"name":"Tee","category":"top"}'; } } });
    const att = await ctx.attachments.ingest({ collection: 'items', buffer: thumb, filename: 'a.jpg' });
    const a = (await run(ctx, 'add_item', { attachment_id: att.id })).data.items[0];
    const b = (await run(ctx, 'add_item', { name: 'Jeans', category: 'bottom' })).data.item;
    const o = (await run(ctx, 'save_outfit', { name: 'Basic', item_ids: [a.ref, b.ref], style: 'Casual' })).data.outfit;
    const calls = [
      ['summary', {}], ['list_items', {}], ['get_item', { item_id: a.ref }], ['list_outfits', {}],
      ['get_outfit', { outfit_id: o.ref }], ['view', { item_ids: [a.ref, b.ref] }], ['styles', {}], ['review_queue', {}],
      ['update_item', { item_id: a.ref, notes: 'n' }], ['confirm_tags', { item_ids: [a.ref] }],
      ['set_status', { item_ids: [b.ref], status: 'active' }], ['set_location', { item_ids: [b.ref], location: 'dorm' }],
      ['rate_outfit', { outfit_id: o.ref, verdict: 'fine' }], ['update_outfit', { outfit_id: o.ref, notes: 'x' }],
      ['save_style', { name: 'Casual', do: ['denim'] }], ['set_profile', { preferences: ['no logos'] }],
      ['log_wear', { outfit_id: o.ref }], ['upload_link', {}], ['tag_pending', {}],
      ['remove_outfit', { outfit_id: o.ref }], ['remove_item', { item_ids: [b.ref] }], ['remove_style', { name: 'Casual' }],
    ];
    for (const [name, args] of calls) {
      const res = await run(ctx, name, args);
      assert.notEqual(res.data && res.data.ok, false, `${name}: ${res.text}`);
    }
  } finally {
    for (const [obj, key, value] of saved) obj[key] = value;
    globalThis.fetch = savedFetch;
  }
  assert.deepEqual(trapped, []);
});
