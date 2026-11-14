'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { makeCtx, run, addItem, addPhotoItem } = require('./helpers');
const { parseVisionReply } = require('../lib/vision');
const { layout } = require('../lib/contactSheet');

const goodReply = JSON.stringify({
  name: 'Navy oxford shirt', category: 'Top', subcategory: 'Shirt', colors: ['navy', 'white', 'navy'],
  pattern: 'Solid', material: 'cotton', formality: 3.4, warmth: '2', seasons: ['spring', 'fall', 'monsoon'],
  description: 'A navy button-down oxford shirt.',
});

test('parseVisionReply cleans a good reply', () => {
  const { tags, error } = parseVisionReply(goodReply);
  assert.equal(error, undefined);
  assert.equal(tags.category, 'top');
  assert.equal(tags.subcategory, 'shirt');
  assert.deepEqual(tags.colors, ['navy', 'white']);
  assert.equal(tags.formality, 3);
  assert.equal(tags.warmth, 2);
  assert.deepEqual(tags.seasons, ['spring', 'autumn']);
});

test('parseVisionReply survives fences, chatter, aliases and nonsense', () => {
  const fenced = parseVisionReply('Sure! Here it is:\n```json\n{"name": "Jeans {dark}", "category": "jeans", "formality": 99}\n```');
  assert.equal(fenced.tags.name, 'Jeans {dark}');
  assert.equal(fenced.tags.category, 'bottom');
  assert.equal(fenced.tags.formality, 5, 'clamped');

  const bad = [
    '', 'no idea', '{"name": ', '[1,2,3]', '{"foo": "bar"}', '{"error": "not clothing"}',
    null, undefined, 42, '{"name": 7, "category": "spaceship"}',
  ];
  for (const reply of bad) {
    const out = parseVisionReply(reply);
    assert.ok(out.error, `expected an error for ${JSON.stringify(reply)}`);
    assert.equal(out.tags, undefined);
  }
  assert.equal(parseVisionReply({ name: 'Scarf', category: 'accessories' }).tags.category, 'accessory');
});

test('add_item with a photo drafts tags from the vision model', async () => {
  const prompts = [];
  const llm = { async describeImage(buf, prompt) { assert.ok(Buffer.isBuffer(buf)); prompts.push(prompt); return goodReply; } };
  const ctx = makeCtx({ llm });
  const { item } = await addPhotoItem(ctx, [20, 30, 90]);
  assert.equal(item.name, 'Navy oxford shirt');
  assert.equal(item.tags_confirmed, false);
  assert.equal(item.tag_source, 'vision');
  assert.match(prompts[0], /JSON/);
  const q = await run(ctx, 'review_queue');
  assert.equal(q.data.total, 1);
  assert.match(q.text, /draft from vision/);
  await run(ctx, 'confirm_tags', { item_ids: [item.ref] });
  assert.equal((await run(ctx, 'review_queue')).data.total, 0);
});

test('a bad or failing vision reply leaves the item in the queue and never throws', async () => {
  for (const llm of [
    { async describeImage() { return 'I think this is a nice shirt!'; } },
    { async describeImage() { throw new Error('model timeout'); } },
  ]) {
    const ctx = makeCtx({ llm });
    const { item, res } = await addPhotoItem(ctx, [5, 5, 5]);
    assert.equal(res.data.ok, true);
    assert.equal(item.tags_confirmed, false);
    assert.ok(item.tag_error, 'error recorded');
    assert.equal(item.name, 'New item');
    const q = await run(ctx, 'review_queue');
    assert.match(q.text, /tagging failed/);
  }
});

test('without a vision model items wait and the agent is told to tag by looking', async () => {
  const ctx = makeCtx({ llm: null });
  const { res } = await addPhotoItem(ctx, [100, 100, 100]);
  assert.match(res.text, /No vision model/);
  const q = await run(ctx, 'review_queue');
  assert.match(q.text, /view/);
  const tp = await run(ctx, 'tag_pending');
  assert.equal(tp.data.reason, 'no_vision_model');
  assert.match(tp.text, /update_item/);
});

test('tag_pending drafts untagged items and retries failed ones', async () => {
  let good = false;
  const llm = { async describeImage() { return good ? goodReply : 'garbage'; } };
  const ctx = makeCtx({ llm });
  const atts = [];
  for (let i = 0; i < 7; i += 1) {
    atts.push((await ctx.attachments.ingest({ collection: 'items', buffer: Buffer.from(`p${i}`), filename: `${i}.jpg` })).id);
  }
  // A batch above the inline limit defers tagging to tag_pending.
  const added = await run(ctx, 'add_item', { attachment_ids: atts });
  assert.equal(added.data.items.length, 7);
  assert.match(added.text, /tag_pending/);
  let res = await run(ctx, 'tag_pending', { limit: 3 });
  assert.equal(res.data.tagged, 0);
  assert.equal(res.data.failed, 3);
  good = true;
  res = await run(ctx, 'tag_pending', { limit: 25 });
  assert.equal(res.data.tagged, 7, 'failed ones are retried along with the untagged');
  assert.equal(res.data.remaining, 0);
  const noPhoto = await addItem(ctx, { name: 'Described only', confirm: false });
  res = await run(ctx, 'tag_pending', { item_ids: [noPhoto.ref] });
  assert.match(res.text, /No photo/);
});

test('view composes one decodable contact sheet of sane size, with descriptions in text', async () => {
  const ctx = makeCtx();
  const colours = [[200, 30, 30], [30, 200, 30], [30, 30, 200], [200, 200, 30], [30, 200, 200]];
  const refs = [];
  for (const rgb of colours) {
    const { item } = await addPhotoItem(ctx, rgb, { name: `Item ${rgb.join('-')}`, category: 'top', description: 'A plain test garment.' });
    refs.push(item.ref);
  }
  const noPhoto = await addItem(ctx, { name: 'Paper hat', category: 'accessory' });
  refs.push(noPhoto.ref);

  const res = await run(ctx, 'view', { item_ids: refs });
  assert.equal(res.images.length, 1);
  assert.equal(res.images[0].mime, 'image/jpeg');
  const meta = await sharp(Buffer.from(res.images[0].base64, 'base64')).metadata();
  const expected = layout(6);
  assert.equal(meta.width, expected.width);
  assert.equal(meta.height, expected.height);
  assert.ok(meta.width <= 1200 && meta.height <= 700, `${meta.width}x${meta.height}`);
  assert.match(res.text, /^Contact sheet/);
  assert.match(res.text, /1\. i/);
  assert.match(res.text, /6\. .*Paper hat.*no photo/);
  assert.match(res.text, /A plain test garment/);

  // The first tile really holds the first thumb's colour.
  const { data, info } = await sharp(Buffer.from(res.images[0].base64, 'base64')).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => Array.from(data.slice((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3));
  const [r, g, b] = px(16 + 120, 16 + 120);
  assert.ok(r > 150 && g < 80 && b < 80, `tile 1 centre is ${[r, g, b]}`);
});

test('view caps at eight, works from an outfit, and refuses nothing to show', async () => {
  const ctx = makeCtx();
  const refs = [];
  for (let i = 0; i < 10; i += 1) refs.push((await addPhotoItem(ctx, [i * 20, 50, 50], { name: `T${i}`, category: 'accessory' })).item.ref);
  const res = await run(ctx, 'view', { item_ids: refs });
  assert.equal(res.data.item_ids.length, 8);
  assert.match(res.text, /2 left out/);
  const meta = await sharp(Buffer.from(res.images[0].base64, 'base64')).metadata();
  assert.equal(meta.width, layout(8).width);
  assert.equal(meta.height, layout(8).height);

  const o = (await run(ctx, 'save_outfit', { name: 'Accessorised', item_ids: refs.slice(0, 3) })).data.outfit;
  const fromOutfit = await run(ctx, 'view', { outfit_id: o.ref });
  assert.equal(fromOutfit.data.item_ids.length, 3);
  assert.match(fromOutfit.text, /Accessorised/);

  assert.equal((await run(ctx, 'view', {})).data.ok, false);
  assert.equal((await run(ctx, 'view', { item_ids: ['izzzz'] })).data.ok, false);
  assert.equal((await run(ctx, 'view', { outfit_id: 'ozzzz' })).data.ok, false);
});

test('photos with no item (upload link) show as new photos and tag_pending adopts them', async () => {
  for (const llm of [null, { async describeImage() { return goodReply; } }]) {
    const ctx = makeCtx({ llm });
    const orphan1 = await ctx.attachments.ingest({ collection: 'items', buffer: Buffer.from('a'), filename: 'a.jpg' });
    const orphan2 = await ctx.attachments.ingest({ collection: 'items', buffer: Buffer.from('b'), filename: 'b.jpg' });
    // A photo already named by an item is never a "new photo", even unlinked.
    const owned = await ctx.attachments.ingest({ collection: 'items', buffer: Buffer.from('c'), filename: 'c.jpg' });
    await ctx.records.create('items', { ref: 'iown1', name: 'Owned', status: 'active', photo_ids: [owned.id], tags_confirmed: true });

    let summary = await run(ctx, 'summary');
    assert.equal(summary.data.new_photos, 2);
    let q = await run(ctx, 'review_queue');
    assert.deepEqual(q.data.new_photos.map((p) => p.id).sort(), [orphan1.id, orphan2.id].sort());
    assert.match(q.text, /2 new photo/);

    const res = await run(ctx, 'tag_pending');
    assert.equal(res.data.added, 2);
    assert.equal((await ctx.attachments.listFor('items', null)).filter((a) => a.id !== owned.id).length, 0, 'adopted photos are linked');
    q = await run(ctx, 'review_queue');
    assert.equal(q.data.new_photos.length, 0);
    assert.equal(q.data.total, 2, 'the new items wait for confirmation');
    if (llm) assert.ok(q.data.items.every((i) => i.tag_source === 'vision'));
    summary = await run(ctx, 'summary');
    assert.equal(summary.data.new_photos, 0);
  }
});

test('the dashboard flow: add without tagging, then tag_pending on those items only', async () => {
  let calls = 0;
  const llm = { async describeImage() { calls += 1; return goodReply; } };
  const ctx = makeCtx({ llm, transport: 'http' });
  const mine = await ctx.attachments.ingest({ collection: 'items', buffer: Buffer.from('m'), filename: 'm.jpg' });
  const inFlight = await ctx.attachments.ingest({ collection: 'items', buffer: Buffer.from('f'), filename: 'f.jpg' });
  const added = await run(ctx, 'add_item', { attachment_id: mine.id, tag: false });
  assert.equal(calls, 0, 'no vision call while adding');
  assert.match(added.text, /tag_pending/);
  const item = added.data.items[0];
  const tp = await run(ctx, 'tag_pending', { item_ids: [item.id] });
  assert.equal(tp.data.tagged, 1);
  assert.equal(calls, 1);
  assert.equal((await run(ctx, 'get_item', { item_id: item.ref })).data.item.name, 'Navy oxford shirt');
  const unlinked = await ctx.attachments.listFor('items', null);
  assert.deepEqual(unlinked.map((a) => a.id), [inFlight.id], 'a photo still being added is not adopted');
});
