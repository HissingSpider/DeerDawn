'use strict';

const sharp = require('sharp');
const { actions } = require('..');
const { makeCtx, createStore } = require('./fakeCtx');

async function solidThumb(r, g, b, size = 256) {
  return sharp({ create: { width: size, height: size, channels: 3, background: { r, g, b } } }).webp().toBuffer();
}

async function run(ctx, name, args = {}) {
  const action = actions[name];
  if (!action) throw new Error(`no action ${name}`);
  const result = await action.handler(ctx, args);
  if (!result || typeof result.text !== 'string') throw new Error(`${name} returned no text`);
  return result;
}

// Upload a solid-colour photo the way the dashboard does: ingest with no
// record, then add_item with the attachment id.
async function addPhotoItem(ctx, rgb, fields = {}) {
  const buffer = await solidThumb(...rgb);
  const att = await ctx.attachments.ingest({ collection: 'items', buffer, filename: 'photo.jpg' });
  const res = await run(ctx, 'add_item', { attachment_id: att.id, ...fields });
  return { att, item: res.data.items[0], res };
}

async function addItem(ctx, fields) {
  const res = await run(ctx, 'add_item', fields);
  if (!res.data.ok) throw new Error(res.text);
  return res.data.item;
}

module.exports = { actions, makeCtx, createStore, run, solidThumb, addPhotoItem, addItem };
