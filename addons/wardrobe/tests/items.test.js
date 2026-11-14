'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { actions, makeCtx, createStore, run, addItem, addPhotoItem } = require('./helpers');

const shirt = { name: 'Navy oxford shirt', category: 'top', subcategory: 'shirt', colors: ['Navy', 'white'], formality: 3, warmth: 2, seasons: ['spring', 'autumn'], location: 'dorm', notes: 'Iron before wearing' };

test('every action declares mode, description, input schema and handler', () => {
  const expected = {
    read: ['summary', 'list_items', 'get_item', 'list_outfits', 'get_outfit', 'view', 'styles', 'review_queue'],
    write: ['add_item', 'update_item', 'confirm_tags', 'set_status', 'set_location', 'save_outfit', 'rate_outfit', 'save_style', 'set_profile', 'log_wear', 'upload_link', 'tag_pending', 'remove_item', 'remove_outfit'],
  };
  for (const [mode, names] of Object.entries(expected)) {
    for (const name of names) {
      const a = actions[name];
      assert.ok(a, `missing ${name}`);
      assert.equal(a.mode, mode, `${name} mode`);
      assert.equal(typeof a.description, 'string');
      assert.equal(a.input.type, 'object');
      assert.equal(typeof a.handler, 'function');
    }
  }
  assert.equal(actions.help, undefined, 'help is the platform\'s');
});

test('add_item by description stores a confirmed item with a short ref', async () => {
  const ctx = makeCtx();
  const item = await addItem(ctx, shirt);
  assert.match(item.ref, /^i[a-z2-9]{4}$/);
  assert.equal(item.tags_confirmed, true);
  assert.deepEqual(item.colors, ['navy', 'white']);
  assert.equal(item.status, 'active');
  assert.equal(item.tag_source, 'agent');
});

test('add_item refuses bad fields without throwing', async () => {
  const ctx = makeCtx();
  const res = await run(ctx, 'add_item', { name: 'X', category: 'hat', formality: 9, seasons: ['monsoon'] });
  assert.equal(res.data.ok, false);
  assert.match(res.text, /category must be one of/);
  assert.match(res.text, /formality/);
  assert.match(res.text, /seasons/);
  const noName = await run(ctx, 'add_item', {});
  assert.equal(noName.data.ok, false);
});

test('get_item resolves by ref or id and shows notes and photos', async () => {
  const ctx = makeCtx();
  const { item, att } = await addPhotoItem(ctx, [10, 20, 120], { name: 'Blue tee', category: 'top' });
  const byRef = await run(ctx, 'get_item', { item_id: item.ref });
  const byId = await run(ctx, 'get_item', { item_id: item.id });
  assert.equal(byRef.text, byId.text);
  assert.match(byRef.text, /Photos: 1/);
  assert.equal(byRef.data.item.cover_photo_id, att.id);
  const missing = await run(ctx, 'get_item', { item_id: 'izzzz' });
  assert.equal(missing.data.ok, false);
});

test('update_item changes fields, keeps tags a draft unless confirmed, and manages photos', async () => {
  const ctx = makeCtx();
  const { item, att } = await addPhotoItem(ctx, [200, 0, 0]);
  assert.equal(item.tags_confirmed, false);
  const extra = await ctx.attachments.ingest({ collection: 'items', recordId: item.id, buffer: Buffer.from('x'), filename: 'b.jpg' });

  let res = await run(ctx, 'update_item', { item_id: item.ref, name: 'Red hoodie', category: 'top', notes: 'Shrinks in the dryer' });
  assert.equal(res.data.item.tags_confirmed, false);
  assert.match(res.text, /draft/);

  res = await run(ctx, 'update_item', { item_id: item.ref, add_photo_ids: [extra.id], cover_photo_id: extra.id, confirm: true });
  assert.equal(res.data.item.tags_confirmed, true);
  assert.deepEqual(res.data.item.photo_ids, [extra.id, att.id]);

  res = await run(ctx, 'update_item', { item_id: item.ref, remove_photo_ids: [extra.id] });
  const got = await run(ctx, 'get_item', { item_id: item.ref });
  // listFor still returns the attachment (the contract has no delete); the
  // removed list keeps it hidden.
  assert.deepEqual(got.data.item.photo_ids, [att.id]);

  const bad = await run(ctx, 'update_item', { item_id: item.ref, warmth: 0 });
  assert.equal(bad.data.ok, false);
  const nothing = await run(ctx, 'update_item', { item_id: item.ref });
  assert.equal(nothing.data.ok, false);
});

test('dashboard edits are attributed to the user', async () => {
  const ctx = makeCtx({ transport: 'http' });
  const item = await addItem(ctx, { name: 'Belt', category: 'accessory' });
  assert.equal(item.tag_source, 'user');
});

test('confirm_tags, set_status and set_location work in bulk and report missing ids', async () => {
  const ctx = makeCtx();
  const a = (await addPhotoItem(ctx, [1, 1, 1])).item;
  const b = (await addPhotoItem(ctx, [2, 2, 2])).item;

  let res = await run(ctx, 'confirm_tags', { item_ids: [a.ref, b.id, 'inope'] });
  assert.equal(res.data.updated.length, 2);
  assert.deepEqual(res.data.missing, ['inope']);

  res = await run(ctx, 'set_status', { item_ids: [a.ref, b.ref], status: 'laundry' });
  assert.equal(res.data.updated.length, 2);
  assert.equal((await run(ctx, 'get_item', { item_id: a.ref })).data.item.status, 'laundry');
  assert.equal((await run(ctx, 'set_status', { item_ids: [a.ref], status: 'lost' })).data.ok, false);

  res = await run(ctx, 'set_location', { item_ids: [a.ref, b.ref], location: 'home' });
  assert.equal((await run(ctx, 'get_item', { item_id: b.ref })).data.item.location, 'home');
  res = await run(ctx, 'set_location', { item_ids: [a.ref], location: null });
  assert.equal((await run(ctx, 'get_item', { item_id: a.ref })).data.item.location, null);

  assert.equal((await run(ctx, 'confirm_tags', { item_ids: ['inope'] })).data.ok, false);
});

test('list_items filters by category, status, location, season, formality and text', async () => {
  const ctx = makeCtx();
  await addItem(ctx, shirt);
  await addItem(ctx, { name: 'Grey joggers', category: 'bottom', colors: ['grey'], formality: 1, warmth: 2, seasons: ['winter'], location: 'Dorm' });
  await addItem(ctx, { name: 'Wool overcoat', category: 'outerwear', colors: ['camel'], formality: 4, warmth: 5, seasons: ['winter'], location: 'home' });
  await addItem(ctx, { name: 'Old trainers', category: 'shoes', formality: 1, status: 'donated', location: 'dorm' });

  const names = async (args) => (await run(ctx, 'list_items', args)).data.items.map((i) => i.name).sort();
  assert.deepEqual(await names({ category: 'top' }), ['Navy oxford shirt']);
  assert.deepEqual(await names({ category: ['top', 'bottom'] }), ['Grey joggers', 'Navy oxford shirt']);
  assert.deepEqual(await names({ status: 'active', location: 'dorm' }), ['Grey joggers', 'Navy oxford shirt']);
  assert.deepEqual(await names({ season: 'winter', status: 'active' }), ['Grey joggers', 'Wool overcoat']);
  assert.deepEqual(await names({ formality_min: 3 }), ['Navy oxford shirt', 'Wool overcoat']);
  assert.deepEqual(await names({ q: 'iron' }), ['Navy oxford shirt']);
  assert.deepEqual(await names({ q: 'camel parka' }), []);
  assert.deepEqual(await names({ q: 'camel wool' }), ['Wool overcoat']);
  const none = await run(ctx, 'list_items', { category: 'one-piece' });
  assert.match(none.text, /No items/);
});

test('a 200-item closet lists in one reply under the token budget, and paginates beyond', async () => {
  const ctx = makeCtx();
  const cats = ['top', 'bottom', 'outerwear', 'shoes', 'accessory'];
  for (let i = 0; i < 230; i += 1) {
    await ctx.records.create('items', {
      ref: `i${String(i).padStart(4, '0')}`,
      name: `Slim fit cotton chino trousers no ${i}`,
      category: cats[i % 5],
      subcategory: 'chinos',
      colors: ['navy', 'stone'],
      formality: 3,
      warmth: 2,
      status: 'active',
      location: 'dorm',
      tags_confirmed: true,
    });
  }
  const res = await run(ctx, 'list_items', {});
  const lines = res.text.split('\n').filter((l) => l.startsWith('i0'));
  assert.equal(lines.length, 200);
  // Budget: about 25 tokens an item at roughly 4 characters a token. 200 rows
  // must stay under 20,000 characters (about 5,000 tokens) even with long names.
  assert.ok(res.text.length < 20000, `200 items took ${res.text.length} chars`);
  const perLine = lines.reduce((n, l) => n + l.length, 0) / lines.length;
  assert.ok(perLine < 100, `avg line ${perLine} chars`);
  assert.equal(res.data.next_cursor, '200');
  const next = await run(ctx, 'list_items', { cursor: res.data.next_cursor });
  assert.equal(next.data.items.length, 30);
  assert.equal(next.data.next_cursor, null);
});

test('remove_item deletes items and reports outfits that used them', async () => {
  const ctx = makeCtx();
  const top = await addItem(ctx, { name: 'Tee', category: 'top' });
  const pants = await addItem(ctx, { name: 'Jeans', category: 'bottom' });
  await run(ctx, 'save_outfit', { name: 'Basic', item_ids: [top.ref, pants.ref] });
  const res = await run(ctx, 'remove_item', { item_ids: [top.ref] });
  assert.equal(res.data.removed.length, 1);
  assert.equal(res.data.affected_outfits.length, 1);
  const outfits = await run(ctx, 'list_outfits', {});
  assert.match(outfits.text, /removed/);
  assert.equal((await run(ctx, 'remove_item', { item_ids: ['izzzz'] })).data.ok, false);
});

test('records are personal: another person sees none of them', async () => {
  const store = createStore();
  const alice = makeCtx({ store, personId: 'alice' });
  const bob = makeCtx({ store, personId: 'bob' });
  const item = await addItem(alice, shirt);
  assert.equal((await run(bob, 'list_items', {})).data.total, 0);
  assert.equal((await run(bob, 'get_item', { item_id: item.id })).data.ok, false);
  assert.equal((await run(bob, 'get_item', { item_id: item.ref })).data.ok, false);
  assert.equal((await run(bob, 'set_status', { item_ids: [item.id], status: 'donated' })).data.ok, false);
  assert.equal((await run(alice, 'get_item', { item_id: item.ref })).data.item.status, 'active');
});

test('a photo added to an item is linked to it on the platform', async () => {
  const ctx = makeCtx();
  const { item, att } = await addPhotoItem(ctx, [9, 9, 9]);
  assert.deepEqual((await ctx.attachments.listFor('items', item.id)).map((a) => a.id), [att.id]);
  const later = await ctx.attachments.ingest({ collection: 'items', buffer: Buffer.from('y'), filename: 'c.jpg' });
  await run(ctx, 'update_item', { item_id: item.ref, add_photo_ids: [later.id] });
  assert.deepEqual((await ctx.attachments.listFor('items', item.id)).map((a) => a.id), [att.id, later.id]);
});

test('another person\'s photo id cannot be turned into or added to an item', async () => {
  const store = createStore();
  const alice = makeCtx({ store, personId: 'alice' });
  const bob = makeCtx({ store, personId: 'bob' });
  const alicePhoto = await alice.attachments.ingest({ collection: 'items', buffer: Buffer.from('a'), filename: 'a.jpg' });
  const res = await run(bob, 'add_item', { attachment_id: alicePhoto.id });
  assert.equal(res.data.ok, false);
  assert.equal((await run(bob, 'list_items', {})).data.total, 0, 'no item left behind');
  const mine = await addItem(bob, { name: 'Bob tee', category: 'top' });
  const upd = await run(bob, 'update_item', { item_id: mine.ref, add_photo_ids: [alicePhoto.id] });
  assert.equal(upd.data.ok, false);
  assert.deepEqual((await run(bob, 'get_item', { item_id: mine.ref })).data.item.photo_ids, []);
  assert.equal((await alice.attachments.listFor('items', null)).length, 1, 'alice\'s photo untouched');
});
