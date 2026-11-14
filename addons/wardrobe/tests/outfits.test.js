'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCtx, run, addItem } = require('./helpers');

async function closet(ctx) {
  const mk = (name, category, extra = {}) => addItem(ctx, { name, category, location: 'dorm', formality: 3, warmth: 2, ...extra });
  return {
    shirt: await mk('White shirt', 'top'),
    knit: await mk('Navy knit', 'top'),
    chinos: await mk('Stone chinos', 'bottom'),
    jeans: await mk('Dark jeans', 'bottom'),
    loafers: await mk('Brown loafers', 'shoes'),
    sneakers: await mk('White sneakers', 'shoes'),
    dress: await mk('Black dress', 'one-piece'),
    coatHome: await mk('Camel coat', 'outerwear', { location: 'home' }),
    dirty: await mk('Grey tee', 'top', { status: 'laundry' }),
  };
}

test('save_outfit saves a valid outfit and creates its style', async () => {
  const ctx = makeCtx();
  const c = await closet(ctx);
  const res = await run(ctx, 'save_outfit', {
    name: 'Friday drinks', item_ids: [c.shirt.ref, c.chinos.ref, c.loafers.ref], style: 'Smart casual',
    occasion: 'drinks', temp_min: 12, temp_max: 18, request: 'something for drinks after work',
  });
  assert.equal(res.data.saved, true, res.text);
  assert.match(res.data.outfit.ref, /^o[a-z2-9]{4}$/);
  assert.deepEqual(res.data.outfit.item_ids, [c.shirt.id, c.chinos.id, c.loafers.id]);
  assert.deepEqual(res.data.created_styles, ['Smart casual']);
  const again = await run(ctx, 'save_outfit', { name: 'Again', item_ids: [c.knit.ref, c.jeans.ref], style: 'smart CASUAL' });
  assert.deepEqual(again.data.created_styles, [], 'style matched case-insensitively');
  assert.deepEqual(again.data.outfit.styles, ['Smart casual']);
  const styles = await run(ctx, 'styles');
  assert.equal(styles.data.styles.length, 1);
  assert.equal(styles.data.styles[0].outfit_count, 2);
});

test('save_outfit refuses user-fixable problems with a clear text', async () => {
  const ctx = makeCtx();
  const c = await closet(ctx);
  const cases = [
    [{ item_ids: [c.shirt.ref, 'izzzz'] }, /not in the closet: izzzz/],
    [{ item_ids: [c.dirty.ref, c.jeans.ref] }, /not active: .*laundry/],
    [{ item_ids: [c.shirt.ref, c.coatHome.ref] }, /different places/],
    [{ item_ids: [c.shirt.ref, c.loafers.ref, c.sneakers.ref] }, /more than one pair of shoes/],
    [{ item_ids: [c.shirt.ref, c.chinos.ref, c.jeans.ref] }, /more than one bottom/],
    [{ item_ids: [c.dress.ref, c.jeans.ref] }, /one-piece .* with a bottom/],
  ];
  for (const [args, pattern] of cases) {
    const res = await run(ctx, 'save_outfit', { name: 'Test', ...args });
    assert.equal(res.data.saved, false, `expected refusal for ${JSON.stringify(args)}`);
    assert.match(res.text, pattern);
    assert.match(res.text, /^Not saved/);
  }
  assert.equal((await run(ctx, 'save_outfit', { name: '', item_ids: [c.shirt.ref] })).data.ok, false);
  assert.equal((await run(ctx, 'save_outfit', { name: 'X', item_ids: [] })).data.ok, false);
  assert.equal((await run(ctx, 'save_outfit', { name: 'X', item_ids: [c.shirt.ref], verdict: 'meh' })).data.ok, false);
  const mixed = await run(ctx, 'save_outfit', { name: 'Trip', item_ids: [c.shirt.ref, c.coatHome.ref], allow_mixed_locations: true });
  assert.equal(mixed.data.saved, true);
  assert.equal((await run(ctx, 'list_outfits', {})).data.total, 1, 'refusals saved nothing');
});

test('a rejection needs a reason and skips the wearability checks', async () => {
  const ctx = makeCtx();
  const c = await closet(ctx);
  const noReason = await run(ctx, 'save_outfit', { name: 'Clash', item_ids: [c.dirty.ref, c.jeans.ref], verdict: 'rejected' });
  assert.equal(noReason.data.ok, false);
  const res = await run(ctx, 'save_outfit', { name: 'Clash', item_ids: [c.dirty.ref, c.jeans.ref], verdict: 'rejected', reason: 'too casual for class' });
  assert.equal(res.data.saved, true);
  const summary = await run(ctx, 'summary');
  assert.match(summary.text, /Recent rejections/);
  assert.match(summary.text, /too casual for class/);
  assert.equal(summary.data.recent_rejections[0].reason, 'too casual for class');
});

test('rate_outfit, update_outfit, list_outfits filters, get_outfit and remove_outfit', async () => {
  const ctx = makeCtx();
  const c = await closet(ctx);
  const a = (await run(ctx, 'save_outfit', { name: 'Office', item_ids: [c.shirt.ref, c.chinos.ref, c.loafers.ref], style: 'Work' })).data.outfit;
  const b = (await run(ctx, 'save_outfit', { name: 'Weekend', item_ids: [c.knit.ref, c.jeans.ref, c.sneakers.ref], style: 'Casual', verdict: 'fine' })).data.outfit;

  let res = await run(ctx, 'rate_outfit', { outfit_id: b.ref, verdict: 'rejected', reason: 'sneakers look tired' });
  assert.equal(res.data.outfit.verdict, 'rejected');
  assert.equal((await run(ctx, 'rate_outfit', { outfit_id: a.ref, verdict: 'rejected' })).data.ok, false);
  assert.equal((await run(ctx, 'rate_outfit', { outfit_id: a.ref, verdict: 'great' })).data.ok, false);
  assert.equal((await run(ctx, 'rate_outfit', { outfit_id: 'ozzzz', verdict: 'fine' })).data.ok, false);

  assert.deepEqual((await run(ctx, 'list_outfits', { style: 'work' })).data.outfits.map((o) => o.name), ['Office']);
  assert.deepEqual((await run(ctx, 'list_outfits', { verdict: 'rejected' })).data.outfits.map((o) => o.name), ['Weekend']);
  assert.deepEqual((await run(ctx, 'list_outfits', { item_id: c.loafers.ref })).data.outfits.map((o) => o.name), ['Office']);
  const listed = await run(ctx, 'list_outfits', {});
  assert.ok(listed.data.outfits[0].items[0].name, 'items carry names for the dashboard');
  assert.ok(listed.data.outfits.every((o) => o.items.length === 3));

  res = await run(ctx, 'update_outfit', { outfit_id: a.ref, name: 'Office Monday', notes: 'Roll the sleeves', styles: ['Work', 'Minimal'] });
  assert.equal(res.data.outfit.name, 'Office Monday');
  assert.deepEqual(res.data.outfit.styles, ['Work', 'Minimal']);
  assert.equal((await run(ctx, 'update_outfit', { outfit_id: a.ref })).data.ok, false);

  const detail = await run(ctx, 'get_outfit', { outfit_id: a.ref });
  assert.match(detail.text, /Office Monday/);
  assert.match(detail.text, /Roll the sleeves/);
  assert.match(detail.text, /White shirt/);

  res = await run(ctx, 'remove_outfit', { outfit_id: b.ref });
  assert.equal(res.data.ok, true);
  assert.equal((await run(ctx, 'list_outfits', {})).data.total, 1);
  assert.equal((await run(ctx, 'get_item', { item_id: c.jeans.ref })).data.ok, undefined, 'items stay');
});

test('log_wear bumps items and appends the date to the outfit', async () => {
  const ctx = makeCtx();
  const c = await closet(ctx);
  const o = (await run(ctx, 'save_outfit', { name: 'Office', item_ids: [c.shirt.ref, c.chinos.ref] })).data.outfit;
  await run(ctx, 'log_wear', { outfit_id: o.ref, date: '2026-11-10' });
  await run(ctx, 'log_wear', { outfit_id: o.ref, date: '2026-11-03' });
  await run(ctx, 'log_wear', { item_ids: [c.shirt.ref] });
  const shirt = (await run(ctx, 'get_item', { item_id: c.shirt.ref })).data.item;
  assert.equal(shirt.wear_count, 3);
  assert.ok(shirt.last_worn >= '2026-11-10');
  const chinos = (await run(ctx, 'get_item', { item_id: c.chinos.ref })).data.item;
  assert.equal(chinos.wear_count, 2);
  assert.equal(chinos.last_worn, '2026-11-10', 'an older date does not move last_worn back');
  const outfit = (await run(ctx, 'get_outfit', { outfit_id: o.ref })).data.outfit;
  assert.deepEqual(outfit.worn_dates, ['2026-11-03', '2026-11-10']);
  assert.equal((await run(ctx, 'log_wear', { date: 'yesterday', item_ids: [c.shirt.ref] })).data.ok, false);
  assert.equal((await run(ctx, 'log_wear', {})).data.ok, false);
});

test('save_style upserts by name, renames everywhere; remove_style untags outfits', async () => {
  const ctx = makeCtx();
  const c = await closet(ctx);
  let res = await run(ctx, 'save_style', { name: 'Smart casual', description: 'Office without a tie', do: ['collared shirts'], dont: ['logos'], palette: ['Navy', 'stone'] });
  assert.match(res.text, /^Created style/);
  await run(ctx, 'save_outfit', { name: 'O', item_ids: [c.shirt.ref, c.chinos.ref], style: 'smart casual' });
  res = await run(ctx, 'save_style', { name: 'smart casual', dont: ['logos', 'shorts'] });
  assert.match(res.text, /^Updated/);
  assert.deepEqual(res.data.style.do, ['collared shirts'], 'unspecified fields kept');
  assert.deepEqual(res.data.style.palette, ['navy', 'stone']);
  res = await run(ctx, 'save_style', { name: 'Smart casual', rename_to: 'Business casual' });
  assert.match(res.text, /renamed on 1 outfit/);
  assert.deepEqual((await run(ctx, 'list_outfits', {})).data.outfits[0].styles, ['Business casual']);
  await run(ctx, 'save_style', { name: 'Gym' });
  assert.equal((await run(ctx, 'save_style', { name: 'Gym', rename_to: 'business casual' })).data.ok, false);
  assert.equal((await run(ctx, 'save_style', { name: '' })).data.ok, false);

  res = await run(ctx, 'remove_style', { name: 'Business casual' });
  assert.match(res.text, /untagged 1 outfit/);
  assert.deepEqual((await run(ctx, 'list_outfits', {})).data.outfits[0].styles, []);
  assert.equal((await run(ctx, 'remove_style', { name: 'Nope' })).data.ok, false);
});

test('set_profile replaces, adds and removes preferences; styles shows them', async () => {
  const ctx = makeCtx();
  let res = await run(ctx, 'set_profile', { preferences: ['nothing tight'], sizes: { shoes: '43' } });
  assert.deepEqual(res.data.profile.preferences, ['nothing tight']);
  res = await run(ctx, 'set_profile', { add_preferences: ['no logos', 'Nothing tight'], sizes: { tops: 'M', shoes: null } });
  assert.deepEqual(res.data.profile.preferences, ['nothing tight', 'no logos']);
  assert.deepEqual(res.data.profile.sizes, { tops: 'M' });
  res = await run(ctx, 'set_profile', { remove_preferences: ['NOTHING TIGHT'], notes: 'Runs warm' });
  assert.deepEqual(res.data.profile.preferences, ['no logos']);
  assert.equal((await run(ctx, 'set_profile', { sizes: 'M' })).data.ok, false);
  const styles = await run(ctx, 'styles');
  assert.match(styles.text, /No styles yet/);
  assert.match(styles.text, /no logos/);
  assert.match(styles.text, /Runs warm/);
  const page = await ctx.records.list('profile', {});
  assert.equal(page.rows.length, 1, 'one profile record');
});

test('summary on an empty closet says what to do next, and counts a full one', async () => {
  const ctx = makeCtx();
  const empty = await run(ctx, 'summary');
  assert.match(empty.text, /empty/);
  assert.match(empty.text, /upload_link/);
  const c = await closet(ctx);
  await run(ctx, 'save_outfit', { name: 'O', item_ids: [c.shirt.ref, c.chinos.ref], style: 'Work' });
  await run(ctx, 'set_profile', { preferences: ['no logos'] });
  const full = await run(ctx, 'summary');
  assert.equal(full.data.items, 9);
  assert.equal(full.data.by_status.laundry, 1);
  assert.equal(full.data.by_location.dorm, 7);
  assert.equal(full.data.outfits, 1);
  assert.deepEqual(full.data.styles, ['Work']);
  assert.match(full.text, /no logos/);
});

test('upload_link asks the platform for an items link', async () => {
  const ctx = makeCtx();
  const res = await run(ctx, 'upload_link', { ttl_minutes: 15 });
  assert.match(res.data.url, /\/u\/items\//);
  assert.match(res.text, /expires/);
});
