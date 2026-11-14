'use strict';

// Wardrobe: the first official DeerDawn server add-on.
//
// Every handler is (ctx, args) => { text, data?, images? } and reaches the
// world only through ctx (records, attachments, llm, log). The platform scopes
// every record and attachment call to the calling person, so nothing here
// filters by owner. User-fixable problems come back as a refusal in `text`
// (with data.saved/ok false), never as a thrown error.

const { listAll, newRef, resolveMany, resolveOne } = require('./lib/store');
const { tagFromPhoto, CATEGORIES, SEASONS } = require('./lib/vision');
const { composeContactSheet, MAX_ITEMS: SHEET_MAX } = require('./lib/contactSheet');
const fmt = require('./lib/format');

const STATUSES = ['active', 'stored', 'laundry', 'repair', 'donated', 'wishlist'];
const VERDICTS = ['loved', 'fine', 'rejected'];
const DASHBOARD_HINT = 'the Wardrobe page in the DeerDawn dashboard (/addons/wardrobe)';
const LIST_DEFAULT = 200;
const LIST_MAX = 300;
const INLINE_TAG_LIMIT = 5;
const TAG_PENDING_MAX = 25;

// ---------------------------------------------------------------- helpers

const refuse = (message, problems, extra = {}) => ({
  text: problems && problems.length ? `${message}\n${problems.map((p) => `- ${p}`).join('\n')}` : message,
  data: { ok: false, problems: problems || [message], ...extra },
});

const today = () => new Date().toISOString().slice(0, 10);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const str = (v, max) => {
  if (v === null) return null;
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
};
const strList = (v, maxItems, itemMax) =>
  [...new Set(asArray(v).map((x) => (typeof x === 'string' ? x.trim().slice(0, itemMax) : '')).filter(Boolean))].slice(0, maxItems);
const lower = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

function paginate(list, args, def = LIST_DEFAULT) {
  const limit = Math.min(Math.max(Number(args.limit) || def, 1), LIST_MAX);
  const offset = Math.max(Number.parseInt(args.cursor, 10) || 0, 0);
  const page = list.slice(offset, offset + limit);
  const next = offset + limit < list.length ? String(offset + limit) : null;
  return { page, next, offset, total: list.length };
}

// Validate and clean the item fields a caller may set. Returns
// { patch, problems }. Undefined fields are left out of the patch.
function cleanItemFields(args) {
  const patch = {};
  const problems = [];
  const text = { name: 120, subcategory: 60, pattern: 40, material: 60, fit: 40, brand: 60, size: 20, notes: 2000, location: 60, description: 400 };
  for (const [key, max] of Object.entries(text)) {
    if (args[key] === undefined) continue;
    const v = str(args[key], max);
    if (v === undefined) problems.push(`${key} must be text`);
    else if (key === 'name' && !v) problems.push('name cannot be empty');
    else patch[key] = key === 'subcategory' && v ? v.toLowerCase() : v;
  }
  if (args.category !== undefined) {
    if (args.category === null) patch.category = null;
    else if (CATEGORIES.includes(lower(args.category))) patch.category = lower(args.category);
    else problems.push(`category must be one of ${CATEGORIES.join(', ')}`);
  }
  if (args.status !== undefined) {
    if (STATUSES.includes(lower(args.status))) patch.status = lower(args.status);
    else problems.push(`status must be one of ${STATUSES.join(', ')}`);
  }
  for (const key of ['formality', 'warmth']) {
    if (args[key] === undefined) continue;
    if (args[key] === null) { patch[key] = null; continue; }
    const n = Number(args[key]);
    if (Number.isInteger(n) && n >= 1 && n <= 5) patch[key] = n;
    else problems.push(`${key} must be a whole number from 1 to 5`);
  }
  if (args.colors !== undefined) patch.colors = strList(args.colors, 6, 30).map((c) => c.toLowerCase());
  if (args.seasons !== undefined) {
    const s = strList(args.seasons, 4, 10).map((x) => (lower(x) === 'fall' ? 'autumn' : lower(x)));
    const bad = s.filter((x) => !SEASONS.includes(x));
    if (bad.length) problems.push(`seasons must be from ${SEASONS.join(', ')} (got ${bad.join(', ')})`);
    else patch.seasons = s;
  }
  if (args.acquired !== undefined) {
    if (args.acquired === null || /^\d{4}-\d{2}(-\d{2})?$/.test(String(args.acquired))) patch.acquired = args.acquired;
    else problems.push('acquired must be YYYY-MM or YYYY-MM-DD');
  }
  if (args.cost !== undefined) {
    if (args.cost === null) patch.cost = null;
    else if (Number.isFinite(Number(args.cost)) && Number(args.cost) >= 0) patch.cost = Number(args.cost);
    else problems.push('cost must be a number of zero or more');
  }
  return { patch, problems };
}

const TAG_FIELDS = ['name', 'category', 'subcategory', 'colors', 'pattern', 'material', 'formality', 'warmth', 'seasons', 'description'];

function tagSource(ctx) {
  return ctx.transport === 'http' ? 'user' : 'agent';
}

// Link uploaded photos to their item on the platform side too, so erasure,
// export and listFor see them. data.photo_ids stays the source of display
// order. attach() is scoped to the caller, so it is also the ownership check:
// an id that is not this person's photo fails here. Returns the ids that
// could not be linked. An older platform without attach() links nothing and
// fails nothing.
async function linkPhotos(ctx, attachmentIds, recordId) {
  if (typeof ctx.attachments.attach !== 'function') return [];
  const failed = [];
  for (const id of attachmentIds) {
    try {
      await ctx.attachments.attach(id, recordId);
    } catch (err) {
      failed.push(id);
      ctx.log('wardrobe: attach failed', { attachmentId: id, recordId, error: String(err && err.message) });
    }
  }
  return failed;
}

async function attachedPhotoIds(ctx, row) {
  let attached = [];
  try {
    attached = (await ctx.attachments.listFor('items', row.id)).map((a) => a.id);
  } catch (err) {
    ctx.log('wardrobe: listFor failed', { recordId: row.id, error: String(err && err.message) });
  }
  return fmt.photoIdsOf(row.data, attached);
}

// Photos in the items collection that no item owns yet: uploaded through
// upload_link, or a dashboard upload whose add_item never landed. The platform
// lists them with listFor(collection, null). Ids already named in some item's
// photo_ids are left out, so a failed attach() cannot make a duplicate.
async function unlinkedPhotos(ctx, items) {
  let rows = [];
  try {
    rows = (await ctx.attachments.listFor('items', null)) || [];
  } catch (err) {
    ctx.log('wardrobe: listing unlinked photos failed', { error: String(err && err.message) });
    return [];
  }
  const owned = new Set();
  for (const r of items) for (const id of r.data.photo_ids || []) owned.add(id);
  return rows.filter((a) => a && a.id && !owned.has(a.id));
}

async function adoptUnlinked(ctx, photos) {
  const tagInline = Boolean(ctx.llm);
  const created = [];
  for (const p of photos) {
    const row = await createItemFromPhoto(ctx, p.id, {}, tagInline);
    if (row) created.push(row);
  }
  return created;
}

function refMap(rows) {
  return new Map(rows.map((r) => [r.id, r.data.ref]));
}

function compactItem(row) {
  return { id: row.id, ...row.data, cover_photo_id: fmt.coverOf(row.data) };
}

async function itemsByIds(ctx, ids) {
  const { found, missing } = await resolveMany(ctx, 'items', ids);
  return { rows: [...found.values()], missing };
}

function missingText(missing) {
  return `not in the closet: ${missing.join(', ')}`;
}

async function findStyleByName(ctx, name) {
  const all = await listAll(ctx, 'styles');
  return all.find((s) => lower(s.data.name) === lower(name)) || null;
}

async function getProfile(ctx) {
  const page = await ctx.records.list('profile', { limit: 1 });
  return (page.rows || [])[0] || null;
}

// ---------------------------------------------------------------- schemas

const ids = (description) => ({ type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 200, description });
const ITEM_FIELD_SCHEMA = {
  name: { type: 'string' },
  category: { enum: [...CATEGORIES, null] },
  subcategory: { type: ['string', 'null'] },
  colors: { type: 'array', items: { type: 'string' } },
  pattern: { type: ['string', 'null'] },
  material: { type: ['string', 'null'] },
  formality: { type: ['integer', 'null'], minimum: 1, maximum: 5, description: '1 gym or lounge, 3 smart casual, 5 black tie' },
  warmth: { type: ['integer', 'null'], minimum: 1, maximum: 5, description: '1 very light, 5 heavy winter' },
  seasons: { type: 'array', items: { enum: SEASONS } },
  fit: { type: ['string', 'null'] },
  brand: { type: ['string', 'null'] },
  size: { type: ['string', 'null'] },
  notes: { type: ['string', 'null'] },
  status: { enum: STATUSES },
  location: { type: ['string', 'null'], description: 'Free label such as dorm or home' },
  acquired: { type: ['string', 'null'], description: 'YYYY-MM or YYYY-MM-DD' },
  cost: { type: ['number', 'null'] },
  description: { type: ['string', 'null'], description: 'One plain sentence describing the item' },
};
const oneOrMany = (inner) => ({ anyOf: [inner, { type: 'array', items: inner }] });

// ---------------------------------------------------------------- reads

async function summary(ctx) {
  const items = await listAll(ctx, 'items');
  const outfits = await listAll(ctx, 'outfits');
  const styles = await listAll(ctx, 'styles');
  const profile = await getProfile(ctx);
  const newPhotos = await unlinkedPhotos(ctx, items);

  if (!items.length && !outfits.length && newPhotos.length) {
    return {
      text: `Wardrobe has ${newPhotos.length} new photo(s) and no items yet. Call tag_pending to turn each photo into an item.`,
      data: { items: 0, outfits: 0, review_queue: 0, new_photos: newPhotos.length, styles: [] },
    };
  }
  if (!items.length && !outfits.length) {
    return {
      text: `Wardrobe is empty. Ask the user to add photos on ${DASHBOARD_HINT}, or call upload_link for a link they can open on their phone. Items can also be added by description with add_item.`,
      data: { items: 0, outfits: 0, review_queue: 0, styles: [] },
    };
  }

  const byStatus = {};
  const byLocation = {};
  let queue = 0;
  for (const r of items) {
    byStatus[r.data.status] = (byStatus[r.data.status] || 0) + 1;
    if (r.data.status === 'active') {
      const loc = r.data.location || 'no location';
      byLocation[loc] = (byLocation[loc] || 0) + 1;
    }
    if (!r.data.tags_confirmed) queue += 1;
  }
  const byVerdict = {};
  const styleUse = {};
  for (const o of outfits) {
    byVerdict[o.data.verdict] = (byVerdict[o.data.verdict] || 0) + 1;
    for (const s of o.data.styles || []) styleUse[lower(s)] = (styleUse[lower(s)] || 0) + 1;
  }
  const rejections = outfits
    .filter((o) => o.data.verdict === 'rejected')
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, 5);

  const counts = (m) => Object.entries(m).map(([k, v]) => `${k} ${v}`).join(', ');
  const lines = [
    `Wardrobe: ${items.length} items (${counts(byStatus)}).`,
    `Active by location: ${counts(byLocation) || 'none'}.`,
  ];
  if (newPhotos.length) lines.push(`New photos not yet in the closet: ${newPhotos.length} (tag_pending turns them into items).`);
  if (queue) lines.push(`To confirm: ${queue} item(s) with draft tags (review_queue).`);
  lines.push(`Outfits: ${outfits.length}${outfits.length ? ` (${counts(byVerdict)})` : ''}.`);
  lines.push(`Styles: ${styles.length ? styles.map((s) => `${s.data.name} (${styleUse[lower(s.data.name)] || 0})`).join(', ') : 'none yet'}.`);
  const prefs = (profile && profile.data.preferences) || [];
  if (prefs.length) lines.push(`Standing preferences: ${prefs.join('; ')}.`);
  if (rejections.length) {
    lines.push('Recent rejections (do not repeat these):');
    const refs = refMap(items);
    for (const r of rejections) lines.push(`- ${fmt.outfitLine(r, refs)}`);
  }
  return {
    text: lines.join('\n'),
    data: {
      items: items.length,
      by_status: byStatus,
      by_location: byLocation,
      review_queue: queue,
      new_photos: newPhotos.length,
      outfits: outfits.length,
      by_verdict: byVerdict,
      styles: styles.map((s) => s.data.name),
      preferences: prefs,
      recent_rejections: rejections.map((r) => ({ id: r.id, ref: r.data.ref, name: r.data.name, reason: r.data.reason || null })),
    },
  };
}

async function listItems(ctx, args) {
  const where = {};
  const cats = strList(args.category, 6, 20).map(lower);
  if (cats.length) where.category = cats.length === 1 ? cats[0] : cats;
  const sts = strList(args.status, 6, 20).map(lower);
  if (sts.length) where.status = sts.length === 1 ? sts[0] : sts;
  let rows = await listAll(ctx, 'items', Object.keys(where).length ? where : undefined);

  const locs = strList(args.location, 10, 60).map(lower);
  if (locs.length) rows = rows.filter((r) => locs.includes(lower(r.data.location)));
  const season = lower(args.season === 'fall' ? 'autumn' : args.season);
  if (season) rows = rows.filter((r) => !(r.data.seasons || []).length || r.data.seasons.includes(season));
  const range = (key, min, max) => {
    if (min === undefined && max === undefined) return;
    rows = rows.filter((r) => {
      const v = r.data[key];
      if (v === null || v === undefined) return false;
      return (min === undefined || v >= min) && (max === undefined || v <= max);
    });
  };
  range('formality', args.formality_min, args.formality_max);
  range('warmth', args.warmth_min, args.warmth_max);
  if (typeof args.confirmed === 'boolean') rows = rows.filter((r) => Boolean(r.data.tags_confirmed) === args.confirmed);
  const q = lower(args.q);
  if (q) {
    const terms = q.split(/\s+/).filter(Boolean);
    rows = rows.filter((r) => {
      const hay = lower([r.data.name, r.data.notes, r.data.description, r.data.subcategory, (r.data.colors || []).join(' '), r.data.brand].filter(Boolean).join(' '));
      return terms.every((t) => hay.includes(t));
    });
  }

  const { page, next, offset, total } = paginate(rows, args);
  if (!total) {
    return { text: 'No items match those filters.', data: { items: [], total: 0, next_cursor: null } };
  }
  const header = `${total} item(s)${page.length < total ? `, showing ${offset + 1}-${offset + page.length}` : ''}. ref name | kind | colours | formality warmth | status @location`;
  const lines = [header, ...page.map(fmt.itemLine)];
  if (next) lines.push(`More: call list_items with cursor "${next}".`);
  return { text: lines.join('\n'), data: { items: page.map(compactItem), total, next_cursor: next } };
}

async function getItem(ctx, args) {
  const row = await resolveOne(ctx, 'items', args.item_id);
  if (!row) return refuse(`No item ${args.item_id} in the closet.`);
  const photoIds = await attachedPhotoIds(ctx, row);
  return { text: fmt.itemDetail(row, photoIds), data: { item: { ...compactItem(row), photo_ids: photoIds, cover_photo_id: photoIds[0] || null } } };
}

async function listOutfits(ctx, args) {
  let rows = await listAll(ctx, 'outfits');
  const style = lower(args.style);
  if (style) rows = rows.filter((r) => (r.data.styles || []).some((s) => lower(s) === style));
  const verdicts = strList(args.verdict, 3, 10).map(lower);
  if (verdicts.length) rows = rows.filter((r) => verdicts.includes(r.data.verdict));
  let itemFilter = null;
  if (args.item_id) {
    itemFilter = await resolveOne(ctx, 'items', args.item_id);
    if (!itemFilter) return refuse(`No item ${args.item_id} in the closet.`);
    rows = rows.filter((r) => (r.data.item_ids || []).includes(itemFilter.id));
  }
  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const { page, next, total } = paginate(rows, args, 50);
  if (!total) return { text: 'No outfits match.', data: { outfits: [], total: 0, next_cursor: null } };
  const items = await listAll(ctx, 'items');
  const byId = new Map(items.map((r) => [r.id, r]));
  const refs = refMap(items);
  const lines = [`${total} outfit(s).`, ...page.map((r) => fmt.outfitLine(r, refs))];
  if (next) lines.push(`More: call list_outfits with cursor "${next}".`);
  return {
    text: lines.join('\n'),
    data: {
      total,
      next_cursor: next,
      outfits: page.map((r) => ({
        id: r.id,
        ...r.data,
        items: (r.data.item_ids || []).map((id) => {
          const it = byId.get(id);
          return it ? { id, ref: it.data.ref, name: it.data.name, category: it.data.category || null, cover_photo_id: fmt.coverOf(it.data) } : { id, removed: true };
        }),
      })),
    },
  };
}

async function getOutfit(ctx, args) {
  const row = await resolveOne(ctx, 'outfits', args.outfit_id);
  if (!row) return refuse(`No outfit ${args.outfit_id}.`);
  const { rows } = await itemsByIds(ctx, row.data.item_ids || []);
  const ordered = (row.data.item_ids || []).map((id) => rows.find((r) => r.id === id)).filter(Boolean);
  return { text: fmt.outfitDetail(row, ordered), data: { outfit: { id: row.id, ...row.data }, items: ordered.map(compactItem) } };
}

async function view(ctx, args) {
  let itemInputs = asArray(args.item_ids);
  let outfit = null;
  if (args.outfit_id) {
    outfit = await resolveOne(ctx, 'outfits', args.outfit_id);
    if (!outfit) return refuse(`No outfit ${args.outfit_id}.`);
    itemInputs = outfit.data.item_ids || [];
  }
  if (!itemInputs.length) return refuse('Give item_ids (up to 8) or an outfit_id.');
  const { ordered, missing } = await resolveMany(ctx, 'items', itemInputs);
  if (!ordered.length) return refuse(`Nothing to show: ${missingText(missing)}.`);
  const shown = ordered.slice(0, SHEET_MAX);

  const tiles = [];
  const lines = [`Contact sheet${outfit ? ` for "${outfit.data.name}"` : ''}, numbered left to right, top to bottom:`];
  for (let i = 0; i < shown.length; i += 1) {
    const row = shown[i];
    const photoIds = await attachedPhotoIds(ctx, row);
    let buffer = null;
    if (photoIds[0]) {
      try {
        buffer = await ctx.attachments.read(photoIds[0], 'thumb');
      } catch (err) {
        ctx.log('wardrobe: thumb read failed', { attachmentId: photoIds[0], error: String(err && err.message) });
      }
    }
    tiles.push({ buffer });
    const d = row.data;
    lines.push(`${i + 1}. ${fmt.itemLine(row)}${buffer ? '' : ' | no photo'}${d.description ? `\n   ${d.description}` : ''}`);
  }
  if (ordered.length > SHEET_MAX) lines.push(`Only the first ${SHEET_MAX} are shown; ${ordered.length - SHEET_MAX} left out.`);
  if (missing.length) lines.push(`Skipped, ${missingText(missing)}.`);

  let images = [];
  try {
    const sheet = await composeContactSheet(tiles);
    images = [{ mime: sheet.mime, base64: sheet.buffer.toString('base64') }];
  } catch (err) {
    ctx.log('wardrobe: contact sheet failed', { error: String(err && err.message) });
    lines.push('The picture could not be made; the descriptions above are complete.');
  }
  return { text: lines.join('\n'), data: { item_ids: shown.map((r) => r.id) }, images };
}

async function stylesAction(ctx) {
  const styles = await listAll(ctx, 'styles');
  const outfits = await listAll(ctx, 'outfits');
  const profile = await getProfile(ctx);
  const use = {};
  for (const o of outfits) for (const s of o.data.styles || []) use[lower(s)] = (use[lower(s)] || 0) + 1;
  const lines = [];
  if (styles.length) {
    lines.push(`${styles.length} style(s):`);
    for (const s of styles) lines.push(`- ${fmt.styleLine(s, use[lower(s.data.name)] || 0)}`);
  } else {
    lines.push('No styles yet. Ask the user what looks they want (for example smart casual, gym, date night) and save them with save_style.');
  }
  const p = profile ? profile.data : {};
  if ((p.preferences || []).length) lines.push(`Standing preferences: ${p.preferences.join('; ')}`);
  if (p.sizes && Object.keys(p.sizes).length) lines.push(`Sizes: ${Object.entries(p.sizes).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (p.notes) lines.push(`Profile notes: ${p.notes}`);
  return {
    text: lines.join('\n'),
    data: {
      styles: styles.map((s) => ({ id: s.id, ...s.data, outfit_count: use[lower(s.data.name)] || 0 })),
      profile: profile ? { id: profile.id, ...profile.data } : null,
    },
  };
}

async function reviewQueue(ctx, args) {
  const all = await listAll(ctx, 'items');
  const newPhotos = await unlinkedPhotos(ctx, all);
  const photoData = newPhotos.map((p) => ({ id: p.id, created_at: p.created_at || null }));
  const photoLine = newPhotos.length
    ? `${newPhotos.length} new photo(s) are not in the closet yet. Call tag_pending to turn each into an item${ctx.llm ? ' with drafted tags' : ''}.`
    : null;
  const rows = all.filter((r) => !r.data.tags_confirmed);
  const { page, next, total } = paginate(rows, args, 50);
  if (!total) {
    return {
      text: photoLine || 'Nothing to confirm. Every item has confirmed tags.',
      data: { items: [], total: 0, next_cursor: null, new_photos: photoData },
    };
  }
  const lines = [];
  if (photoLine) lines.push(photoLine);
  lines.push(`${total} item(s) waiting for confirmation:`);
  for (const r of page) {
    const state = r.data.tag_error
      ? `tagging failed: ${r.data.tag_error}`
      : r.data.tag_source ? `draft from ${r.data.tag_source}` : 'not tagged yet';
    lines.push(`- ${fmt.itemLine(r)} | ${state}`);
  }
  const untagged = page.filter((r) => !r.data.tag_source).length;
  if (untagged) {
    lines.push(ctx.llm
      ? 'Untagged items can be drafted with tag_pending.'
      : 'No vision model is configured: look at each with view, describe it with update_item, then confirm with the user.');
  }
  lines.push('Show the user the drafts (view), fix anything wrong with update_item, then confirm_tags.');
  if (next) lines.push(`More: cursor "${next}".`);
  return { text: lines.join('\n'), data: { items: page.map(compactItem), total, next_cursor: next, new_photos: photoData } };
}

// ---------------------------------------------------------------- writes

async function createItemFromPhoto(ctx, attachmentId, fields, tagInline) {
  const data = {
    ref: await newRef(ctx, 'items', 'i'),
    name: 'New item',
    status: 'active',
    colors: [],
    seasons: [],
    photo_ids: [attachmentId],
    removed_photo_ids: [],
    wear_count: 0,
    last_worn: null,
    tags_confirmed: false,
    tag_source: null,
    tag_error: null,
    ...fields,
  };
  let row = await ctx.records.create('items', data);
  if ((await linkPhotos(ctx, [attachmentId], row.id)).length) {
    // Not this person's photo (or gone): leave no item pointing at it.
    await ctx.records.remove('items', row.id);
    return null;
  }
  if (tagInline) {
    const tags = await tagFromPhoto(ctx, attachmentId);
    if (tags) {
      // Caller-supplied fields win over the model's guesses.
      const merged = { ...tags };
      for (const k of Object.keys(fields)) delete merged[k];
      row = await ctx.records.update('items', row.id, merged);
    }
  }
  return row;
}

async function addItem(ctx, args) {
  const { patch, problems } = cleanItemFields(args);
  if (problems.length) return refuse('Item not added. Fix and retry:', problems);
  const photos = [...new Set([...asArray(args.attachment_id), ...asArray(args.attachment_ids)].filter((x) => typeof x === 'string' && x))];

  if (photos.length) {
    if (photos.length > 50) return refuse('At most 50 photos per add_item call.');
    const tagInline = Boolean(ctx.llm) && args.tag !== false && photos.length <= INLINE_TAG_LIMIT;
    const created = [];
    const unknown = [];
    for (const id of photos) {
      const row = await createItemFromPhoto(ctx, id, patch, tagInline);
      if (row) created.push(row);
      else unknown.push(id);
    }
    if (!created.length) return refuse(`No item added: no photo ${unknown.join(', ')} among your uploads.`);
    const lines = [`Added ${created.length} item(s), one per photo:`];
    if (unknown.length) lines.push(`Skipped, not among your uploads: ${unknown.join(', ')}.`);
    for (const r of created) lines.push(`- ${fmt.itemLine(r)}${r.data.tag_error ? ` | ${r.data.tag_error}` : ''}`);
    if (!ctx.llm) lines.push('No vision model is configured, so these wait in review_queue: look at them with view and fill the tags with update_item.');
    else if (!tagInline) lines.push('Tags not drafted yet: call tag_pending.');
    else lines.push('Tags are drafts until the user confirms them (confirm_tags).');
    return { text: lines.join('\n'), data: { ok: true, items: created.map(compactItem) } };
  }

  if (!patch.name) return refuse('Item not added: give a name (or an attachment_id for an uploaded photo).');
  const confirmed = args.confirm === undefined ? true : Boolean(args.confirm);
  const row = await ctx.records.create('items', {
    ref: await newRef(ctx, 'items', 'i'),
    status: 'active',
    colors: [],
    seasons: [],
    photo_ids: [],
    removed_photo_ids: [],
    wear_count: 0,
    last_worn: null,
    tags_confirmed: confirmed,
    tag_source: tagSource(ctx),
    tag_error: null,
    ...patch,
  });
  return { text: `Added ${fmt.itemLine(row)}`, data: { ok: true, item: compactItem(row) } };
}

async function updateItem(ctx, args) {
  const row = await resolveOne(ctx, 'items', args.item_id);
  if (!row) return refuse(`No item ${args.item_id} in the closet.`);
  const { patch, problems } = cleanItemFields(args);
  if (problems.length) return refuse('Not updated. Fix and retry:', problems);

  const d = row.data;
  let add = strList(args.add_photo_ids, 20, 200);
  if (add.length) {
    const failed = await linkPhotos(ctx, add, row.id);
    if (failed.length === add.length) return refuse(`Not updated: no photo ${failed.join(', ')} among your uploads.`);
    add = add.filter((id) => !failed.includes(id));
  }
  const remove = strList(args.remove_photo_ids, 20, 200);
  if (add.length || remove.length || args.cover_photo_id) {
    let photoIds = [...(d.photo_ids || [])];
    let removed = [...(d.removed_photo_ids || [])].filter((id) => !add.includes(id));
    for (const id of add) if (!photoIds.includes(id)) photoIds.push(id);
    for (const id of remove) {
      photoIds = photoIds.filter((p) => p !== id);
      if (!removed.includes(id)) removed.push(id);
    }
    if (args.cover_photo_id) {
      const cover = String(args.cover_photo_id);
      if (removed.includes(cover)) return refuse('That photo was removed; it cannot be the cover.');
      photoIds = [cover, ...photoIds.filter((p) => p !== cover)];
    }
    patch.photo_ids = photoIds;
    patch.removed_photo_ids = removed;
  }

  const touchedTags = TAG_FIELDS.some((k) => k in patch);
  if (touchedTags) {
    patch.tag_source = tagSource(ctx);
    patch.tag_error = null;
  }
  if (args.confirm === true) patch.tags_confirmed = true;
  if (!Object.keys(patch).length) return refuse('Nothing to change: pass at least one field.');
  const updated = await ctx.records.update('items', row.id, patch);
  const note = !updated.data.tags_confirmed && touchedTags ? ' Tags stay a draft until confirmed (confirm_tags or confirm:true).' : '';
  return { text: `Updated ${fmt.itemLine(updated)}.${note}`, data: { ok: true, item: compactItem(updated) } };
}

async function bulkPatch(ctx, args, patch, verb) {
  const { rows, missing } = await itemsByIds(ctx, args.item_ids);
  if (!rows.length) return refuse(`Nothing ${verb}: ${missingText(missing)}.`);
  const updated = [];
  for (const r of rows) updated.push(await ctx.records.update('items', r.id, patch));
  const lines = [`${verb[0].toUpperCase()}${verb.slice(1)} ${updated.length} item(s): ${updated.map((r) => r.data.ref).join(', ')}.`];
  if (missing.length) lines.push(`Skipped, ${missingText(missing)}.`);
  return { text: lines.join(' '), data: { ok: true, updated: updated.map((r) => r.id), missing } };
}

async function confirmTags(ctx, args) {
  return bulkPatch(ctx, args, { tags_confirmed: true, tag_error: null }, 'confirmed');
}

async function setStatus(ctx, args) {
  const status = lower(args.status);
  if (!STATUSES.includes(status)) return refuse(`status must be one of ${STATUSES.join(', ')}.`);
  return bulkPatch(ctx, args, { status }, `set to ${status}`);
}

async function setLocation(ctx, args) {
  const location = str(args.location, 60);
  if (location === undefined) return refuse('location must be text (or null to clear it).');
  return bulkPatch(ctx, args, { location }, location ? `moved to ${location}` : 'cleared location on');
}

// Slots where two of a kind is clearly a mistake. Tops and outerwear layer;
// accessories stack.
function slotProblems(rows) {
  const by = {};
  for (const r of rows) {
    const c = r.data.category;
    if (c) (by[c] = by[c] || []).push(r.data.ref);
  }
  const problems = [];
  if ((by.shoes || []).length > 1) problems.push(`more than one pair of shoes (${by.shoes.join(', ')})`);
  if ((by.bottom || []).length > 1) problems.push(`more than one bottom (${by.bottom.join(', ')})`);
  if ((by['one-piece'] || []).length > 1) problems.push(`more than one one-piece (${by['one-piece'].join(', ')})`);
  if ((by['one-piece'] || []).length && (by.bottom || []).length) {
    problems.push(`a one-piece (${by['one-piece'].join(', ')}) with a bottom (${by.bottom.join(', ')})`);
  }
  return problems;
}

async function ensureStyles(ctx, names) {
  const existing = await listAll(ctx, 'styles');
  const out = [];
  const created = [];
  for (const name of names) {
    const hit = existing.find((s) => lower(s.data.name) === lower(name));
    if (hit) out.push(hit.data.name);
    else {
      const row = await ctx.records.create('styles', { name, description: null, do: [], dont: [], palette: [], reference_outfit_ids: [] });
      existing.push(row);
      created.push(name);
      out.push(name);
    }
  }
  return { names: out, created };
}

async function saveOutfit(ctx, args) {
  const name = str(args.name, 120);
  if (!name) return refuse('Not saved: give the outfit a name.');
  const verdict = args.verdict === undefined ? 'loved' : lower(args.verdict);
  if (!VERDICTS.includes(verdict)) return refuse(`Not saved: verdict must be one of ${VERDICTS.join(', ')}.`);
  if (verdict === 'rejected' && !str(args.reason, 500)) return refuse('Not saved: a rejected outfit needs a reason, so it is not proposed again.');
  const inputs = asArray(args.item_ids);
  if (!inputs.length) return refuse('Not saved: give item_ids.');
  if (inputs.length > 12) return refuse('Not saved: an outfit has at most 12 items.');

  const { ordered, missing } = await resolveMany(ctx, 'items', inputs);
  const problems = [];
  if (missing.length) problems.push(missingText(missing));
  // A rejection records what was proposed and why; it does not have to be
  // wearable today, so only existence is checked.
  if (verdict !== 'rejected') {
    const inactive = ordered.filter((r) => r.data.status !== 'active');
    if (inactive.length) problems.push(`not active: ${inactive.map((r) => `${r.data.ref} (${r.data.status})`).join(', ')}`);
    if (!args.allow_mixed_locations) {
      const locs = {};
      for (const r of ordered) if (r.data.location) (locs[lower(r.data.location)] = locs[lower(r.data.location)] || []).push(r.data.ref);
      if (Object.keys(locs).length > 1) {
        problems.push(`items are in different places (${Object.entries(locs).map(([l, refs]) => `${l}: ${refs.join(',')}`).join('; ')}); pass allow_mixed_locations if that is intended`);
      }
    }
    problems.push(...slotProblems(ordered));
  }
  if (problems.length) return refuse('Not saved. Fix and retry:', problems, { saved: false });

  const styleNames = strList([...asArray(args.style), ...asArray(args.styles)], 6, 60);
  const { names, created } = await ensureStyles(ctx, styleNames);
  const seasons = strList(args.seasons, 4, 10).map(lower).filter((s) => SEASONS.includes(s));
  const num = (v) => (v === undefined || v === null || !Number.isFinite(Number(v)) ? null : Number(v));
  const row = await ctx.records.create('outfits', {
    ref: await newRef(ctx, 'outfits', 'o'),
    name,
    item_ids: ordered.map((r) => r.id),
    styles: names,
    occasions: strList([...asArray(args.occasion), ...asArray(args.occasions)], 6, 60),
    seasons,
    temp_min: num(args.temp_min),
    temp_max: num(args.temp_max),
    verdict,
    reason: str(args.reason, 500) || null,
    notes: str(args.notes, 2000) || null,
    made_by: args.made_by === 'user' || (args.made_by === undefined && ctx.transport === 'http') ? 'user' : 'agent',
    request: str(args.request, 500) || null,
    cover_attachment_id: null,
    worn_dates: [],
  });
  const lines = [`Saved ${fmt.outfitLine(row, refMap(ordered))}.`];
  if (created.length) lines.push(`Created style(s): ${created.join(', ')}. Ask the user for its rules and store them with save_style.`);
  return { text: lines.join(' '), data: { ok: true, saved: true, outfit: { id: row.id, ...row.data }, created_styles: created } };
}

async function rateOutfit(ctx, args) {
  const row = await resolveOne(ctx, 'outfits', args.outfit_id);
  if (!row) return refuse(`No outfit ${args.outfit_id}.`);
  const verdict = lower(args.verdict);
  if (!VERDICTS.includes(verdict)) return refuse(`verdict must be one of ${VERDICTS.join(', ')}.`);
  const reason = str(args.reason, 500);
  if (verdict === 'rejected' && !reason && !row.data.reason) return refuse('A rejection needs a reason, so it is not proposed again.');
  const patch = { verdict };
  if (reason !== undefined) patch.reason = reason;
  const updated = await ctx.records.update('outfits', row.id, patch);
  return { text: `Rated ${updated.data.ref} "${updated.data.name}" ${verdict}${updated.data.reason ? ` (${updated.data.reason})` : ''}.`, data: { ok: true, outfit: { id: updated.id, ...updated.data } } };
}

async function updateOutfit(ctx, args) {
  const row = await resolveOne(ctx, 'outfits', args.outfit_id);
  if (!row) return refuse(`No outfit ${args.outfit_id}.`);
  const patch = {};
  if (args.name !== undefined) {
    const n = str(args.name, 120);
    if (!n) return refuse('name cannot be empty.');
    patch.name = n;
  }
  if (args.notes !== undefined) patch.notes = str(args.notes, 2000) || null;
  if (args.occasions !== undefined) patch.occasions = strList(args.occasions, 6, 60);
  if (args.styles !== undefined) patch.styles = (await ensureStyles(ctx, strList(args.styles, 6, 60))).names;
  if (!Object.keys(patch).length) return refuse('Nothing to change: pass name, notes, occasions or styles.');
  const updated = await ctx.records.update('outfits', row.id, patch);
  return { text: `Updated ${updated.data.ref} "${updated.data.name}".`, data: { ok: true, outfit: { id: updated.id, ...updated.data } } };
}

async function saveStyle(ctx, args) {
  const name = str(args.name, 60);
  if (!name) return refuse('Give the style a name.');
  const existing = await findStyleByName(ctx, name);
  const patch = {};
  if (args.description !== undefined) patch.description = str(args.description, 1000) || null;
  if (args.do !== undefined) patch.do = strList(args.do, 20, 200);
  if (args.dont !== undefined) patch.dont = strList(args.dont, 20, 200);
  if (args.palette !== undefined) patch.palette = strList(args.palette, 12, 30).map((c) => c.toLowerCase());
  if (args.reference_outfit_ids !== undefined) {
    const { ordered, missing } = await resolveMany(ctx, 'outfits', args.reference_outfit_ids);
    if (missing.length) return refuse(`Style not saved: no outfit ${missing.join(', ')}.`);
    patch.reference_outfit_ids = ordered.map((r) => r.id);
  }
  let renamedOutfits = 0;
  const renameTo = str(args.rename_to, 60);
  if (renameTo && existing && lower(renameTo) !== lower(existing.data.name)) {
    if (await findStyleByName(ctx, renameTo)) return refuse(`A style named "${renameTo}" already exists.`);
    patch.name = renameTo;
    for (const o of await listAll(ctx, 'outfits')) {
      if ((o.data.styles || []).some((s) => lower(s) === lower(existing.data.name))) {
        await ctx.records.update('outfits', o.id, { styles: o.data.styles.map((s) => (lower(s) === lower(existing.data.name) ? renameTo : s)) });
        renamedOutfits += 1;
      }
    }
  }
  let row;
  if (existing) row = Object.keys(patch).length ? await ctx.records.update('styles', existing.id, patch) : existing;
  else row = await ctx.records.create('styles', { name, description: null, do: [], dont: [], palette: [], reference_outfit_ids: [], ...patch });
  const verb = existing ? 'Updated' : 'Created';
  return {
    text: `${verb} style: ${fmt.styleLine(row)}${renamedOutfits ? ` (renamed on ${renamedOutfits} outfit(s))` : ''}`,
    data: { ok: true, style: { id: row.id, ...row.data } },
  };
}

async function removeStyle(ctx, args) {
  const existing = await findStyleByName(ctx, args.name || '');
  if (!existing) return refuse(`No style named "${args.name}".`);
  let touched = 0;
  for (const o of await listAll(ctx, 'outfits')) {
    if ((o.data.styles || []).some((s) => lower(s) === lower(existing.data.name))) {
      await ctx.records.update('outfits', o.id, { styles: o.data.styles.filter((s) => lower(s) !== lower(existing.data.name)) });
      touched += 1;
    }
  }
  await ctx.records.remove('styles', existing.id);
  return { text: `Removed style "${existing.data.name}"${touched ? ` and untagged ${touched} outfit(s); the outfits are kept` : ''}.`, data: { ok: true } };
}

async function setProfile(ctx, args) {
  const current = await getProfile(ctx);
  const d = current ? current.data : { preferences: [], sizes: {}, notes: null };
  let prefs = args.preferences !== undefined ? strList(args.preferences, 30, 200) : [...(d.preferences || [])];
  for (const p of strList(args.add_preferences, 30, 200)) if (!prefs.some((x) => lower(x) === lower(p))) prefs.push(p);
  const drop = strList(args.remove_preferences, 30, 200).map(lower);
  if (drop.length) prefs = prefs.filter((p) => !drop.includes(lower(p)));
  const patch = { preferences: prefs.slice(0, 30) };
  if (args.sizes !== undefined) {
    if (!args.sizes || typeof args.sizes !== 'object' || Array.isArray(args.sizes)) return refuse('sizes must be an object such as {"shoes": "43", "tops": "M"}.');
    const sizes = { ...(d.sizes || {}) };
    for (const [k, v] of Object.entries(args.sizes)) {
      const key = String(k).trim().slice(0, 30);
      if (!key) continue;
      if (v === null || v === '') delete sizes[key];
      else sizes[key] = String(v).trim().slice(0, 20);
    }
    patch.sizes = sizes;
  }
  if (args.notes !== undefined) patch.notes = str(args.notes, 2000) || null;
  const row = current ? await ctx.records.update('profile', current.id, patch) : await ctx.records.create('profile', { sizes: {}, notes: null, ...patch });
  return {
    text: `Profile saved. Standing preferences: ${row.data.preferences.length ? row.data.preferences.join('; ') : 'none'}.`,
    data: { ok: true, profile: { id: row.id, ...row.data } },
  };
}

async function logWear(ctx, args) {
  const date = args.date === undefined ? today() : args.date;
  if (!isDate(date)) return refuse('date must be YYYY-MM-DD.');
  let outfit = null;
  let inputs = asArray(args.item_ids);
  if (args.outfit_id) {
    outfit = await resolveOne(ctx, 'outfits', args.outfit_id);
    if (!outfit) return refuse(`No outfit ${args.outfit_id}.`);
    inputs = [...(outfit.data.item_ids || []), ...inputs];
  }
  if (!inputs.length) return refuse('Give an outfit_id or item_ids.');
  const { ordered, missing } = await resolveMany(ctx, 'items', inputs);
  for (const r of ordered) {
    const last = r.data.last_worn && r.data.last_worn > date ? r.data.last_worn : date;
    await ctx.records.update('items', r.id, { wear_count: (r.data.wear_count || 0) + 1, last_worn: last });
  }
  if (outfit) {
    const dates = [...(outfit.data.worn_dates || []), date].sort();
    await ctx.records.update('outfits', outfit.id, { worn_dates: dates.slice(-200) });
  }
  const lines = [`Logged ${date}: ${ordered.length} item(s)${outfit ? ` in "${outfit.data.name}"` : ''}.`];
  if (missing.length) lines.push(`Skipped, ${missingText(missing)}.`);
  return { text: lines.join(' '), data: { ok: true, date, items: ordered.map((r) => r.id), outfit_id: outfit ? outfit.id : null } };
}

async function uploadLink(ctx, args) {
  const minutes = Math.min(Math.max(Number(args.ttl_minutes) || 30, 5), 24 * 60);
  const link = await ctx.attachments.createUploadLink({ collection: 'items', ttlSeconds: minutes * 60 });
  return {
    text: `Give the user this link to add photos from their phone (expires ${link.expires_at}): ${link.url}\nEach photo becomes one item. Afterwards call review_queue to confirm the tags.`,
    data: { ok: true, url: link.url, expires_at: link.expires_at },
  };
}

async function tagPending(ctx, args) {
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), TAG_PENDING_MAX);
  // New photos first: each becomes an item (tagged inline when a vision model
  // exists).
  // Naming item_ids means "tag these": a caller still uploading (the
  // dashboard) must not have its in-flight photos adopted from under it.
  const newPhotos = args.item_ids ? [] : await unlinkedPhotos(ctx, await listAll(ctx, 'items'));
  const adopted = await adoptUnlinked(ctx, newPhotos.slice(0, limit));
  const adoptedLine = adopted.length
    ? `Added ${adopted.length} new photo(s) to the closet: ${adopted.map((r) => r.data.ref).join(', ')}.${newPhotos.length > adopted.length ? ` ${newPhotos.length - adopted.length} more new photo(s) wait; call tag_pending again.` : ''}`
    : '';

  if (!ctx.llm) {
    return {
      text: `${adoptedLine ? `${adoptedLine}\n` : ''}No vision model is configured on this server. For each item in review_queue: call view to see it, describe it with update_item (name, category, colours, formality, warmth, seasons, description), and ask the user to confirm.`,
      data: { ok: adopted.length > 0, tagged: 0, added: adopted.length, reason: 'no_vision_model', items: adopted.map(compactItem) },
    };
  }
  if (adopted.length && !args.item_ids) {
    const failedNew = adopted.filter((r) => r.data.tag_error).length;
    return {
      text: `${adoptedLine} Drafted tags for ${adopted.length - failedNew}${failedNew ? `, ${failedNew} could not be tagged` : ''}. Drafts need the user to confirm (review_queue, then confirm_tags).`,
      data: { ok: true, tagged: adopted.length - failedNew, added: adopted.length, failed: failedNew, remaining: Math.max(newPhotos.length - adopted.length, 0), items: adopted.map(compactItem) },
    };
  }
  let candidates;
  if (args.item_ids) candidates = (await itemsByIds(ctx, args.item_ids)).rows;
  else candidates = (await listAll(ctx, 'items')).filter((r) => !r.data.tags_confirmed && (!r.data.tag_source || r.data.tag_error));
  const batch = candidates.slice(0, limit);
  let tagged = 0;
  const failed = [];
  const noPhoto = [];
  for (const r of batch) {
    const photoIds = await attachedPhotoIds(ctx, r);
    if (!photoIds[0]) { noPhoto.push(r.data.ref); continue; }
    const tags = await tagFromPhoto(ctx, photoIds[0]);
    if (!tags) continue;
    await ctx.records.update('items', r.id, tags);
    if (tags.tag_error) failed.push(`${r.data.ref} (${tags.tag_error})`);
    else tagged += 1;
  }
  const lines = [`Drafted tags for ${tagged} of ${batch.length} item(s).`];
  if (failed.length) lines.push(`Could not tag: ${failed.join(', ')}. Use view and update_item for those.`);
  if (noPhoto.length) lines.push(`No photo: ${noPhoto.join(', ')}.`);
  if (candidates.length > batch.length) lines.push(`${candidates.length - batch.length} more waiting; call tag_pending again.`);
  lines.push('Drafts need the user to confirm (review_queue, then confirm_tags).');
  return { text: lines.join(' '), data: { ok: true, tagged, failed: failed.length, remaining: candidates.length - batch.length } };
}

async function removeItem(ctx, args) {
  const { rows, missing } = await itemsByIds(ctx, args.item_ids);
  if (!rows.length) return refuse(`Nothing removed: ${missingText(missing)}.`);
  const removedIds = new Set(rows.map((r) => r.id));
  for (const r of rows) await ctx.records.remove('items', r.id);
  const affected = (await listAll(ctx, 'outfits')).filter((o) => (o.data.item_ids || []).some((id) => removedIds.has(id)));
  const lines = [`Removed ${rows.length} item(s): ${rows.map((r) => `${r.data.ref} ${r.data.name}`).join(', ')}.`];
  if (affected.length) lines.push(`${affected.length} saved outfit(s) used them and now show them as removed.`);
  if (missing.length) lines.push(`Skipped, ${missingText(missing)}.`);
  lines.push('To keep history instead, set_status donated.');
  return { text: lines.join(' '), data: { ok: true, removed: [...removedIds], affected_outfits: affected.map((o) => o.id) } };
}

async function removeOutfit(ctx, args) {
  const row = await resolveOne(ctx, 'outfits', args.outfit_id);
  if (!row) return refuse(`No outfit ${args.outfit_id}.`);
  await ctx.records.remove('outfits', row.id);
  return { text: `Removed outfit ${row.data.ref} "${row.data.name}". The items stay in the closet.`, data: { ok: true, removed: row.id } };
}

// ---------------------------------------------------------------- registry

const actions = {
  summary: {
    mode: 'read',
    description: 'Closet counts, review queue size, styles, standing preferences and recent rejections. Start here.',
    input: { type: 'object', properties: {}, additionalProperties: false },
    handler: summary,
  },
  list_items: {
    mode: 'read',
    description: 'Compact closet rows (ref name | kind | colours | formality warmth | status @location). Filters combine.',
    input: {
      type: 'object',
      properties: {
        category: oneOrMany({ enum: CATEGORIES }),
        status: oneOrMany({ enum: STATUSES }),
        location: oneOrMany({ type: 'string' }),
        season: { enum: SEASONS },
        formality_min: { type: 'integer', minimum: 1, maximum: 5 },
        formality_max: { type: 'integer', minimum: 1, maximum: 5 },
        warmth_min: { type: 'integer', minimum: 1, maximum: 5 },
        warmth_max: { type: 'integer', minimum: 1, maximum: 5 },
        confirmed: { type: 'boolean' },
        q: { type: 'string', description: 'Words to match in name, notes, description, colours, brand' },
        limit: { type: 'integer', minimum: 1, maximum: LIST_MAX },
        cursor: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: listItems,
  },
  get_item: {
    mode: 'read',
    description: 'Everything about one item: tags, notes, wear history, photos.',
    input: { type: 'object', required: ['item_id'], properties: { item_id: { type: 'string', description: 'Ref (i3k9q) or id' } }, additionalProperties: false },
    handler: getItem,
  },
  list_outfits: {
    mode: 'read',
    description: 'Saved outfits, newest first, filterable by style, verdict or an item they contain.',
    input: {
      type: 'object',
      properties: {
        style: { type: 'string' },
        verdict: oneOrMany({ enum: VERDICTS }),
        item_id: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: LIST_MAX },
        cursor: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: listOutfits,
  },
  get_outfit: {
    mode: 'read',
    description: 'One outfit with its items, verdict, reason and wear dates.',
    input: { type: 'object', required: ['outfit_id'], properties: { outfit_id: { type: 'string' } }, additionalProperties: false },
    handler: getOutfit,
  },
  view: {
    mode: 'read',
    description: 'One contact-sheet image of up to 8 items (numbered), plus their written descriptions. Show this to the user when proposing an outfit.',
    input: {
      type: 'object',
      properties: { item_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12 }, outfit_id: { type: 'string' } },
      additionalProperties: false,
    },
    handler: view,
  },
  styles: {
    mode: 'read',
    description: 'All styles with their rules and palette, plus the standing profile preferences.',
    input: { type: 'object', properties: {}, additionalProperties: false },
    handler: stylesAction,
  },
  review_queue: {
    mode: 'read',
    description: 'Items whose tags are drafts or missing and need the user to confirm.',
    input: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: LIST_MAX }, cursor: { type: 'string' } }, additionalProperties: false },
    handler: reviewQueue,
  },

  add_item: {
    mode: 'write',
    description: 'Add an item from an uploaded photo (attachment_id, or attachment_ids for one item per photo) or by description (name plus tags).',
    input: {
      type: 'object',
      properties: {
        attachment_id: { type: 'string' },
        attachment_ids: { type: 'array', items: { type: 'string' }, maxItems: 50 },
        ...ITEM_FIELD_SCHEMA,
        confirm: { type: 'boolean', description: 'For a described item: tags are already confirmed by the user (default true)' },
        tag: { type: 'boolean', description: 'false: do not draft tags now (tag_pending does it later). Default true' },
      },
      additionalProperties: false,
    },
    handler: addItem,
  },
  update_item: {
    mode: 'write',
    description: 'Change any field of one item, including notes; add, remove or reorder photos. confirm:true also confirms the tags.',
    input: {
      type: 'object',
      required: ['item_id'],
      properties: {
        item_id: { type: 'string' },
        ...ITEM_FIELD_SCHEMA,
        add_photo_ids: { type: 'array', items: { type: 'string' } },
        remove_photo_ids: { type: 'array', items: { type: 'string' } },
        cover_photo_id: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    handler: updateItem,
  },
  confirm_tags: {
    mode: 'write',
    description: 'Mark the tags on these items as confirmed by the user.',
    input: { type: 'object', required: ['item_ids'], properties: { item_ids: ids('Refs or ids') }, additionalProperties: false },
    handler: confirmTags,
  },
  set_status: {
    mode: 'write',
    description: 'Set the status of several items at once (active, stored, laundry, repair, donated, wishlist).',
    input: { type: 'object', required: ['item_ids', 'status'], properties: { item_ids: ids('Refs or ids'), status: { enum: STATUSES } }, additionalProperties: false },
    handler: setStatus,
  },
  set_location: {
    mode: 'write',
    description: 'Move several items to a location label (dorm, home). null clears it.',
    input: { type: 'object', required: ['item_ids', 'location'], properties: { item_ids: ids('Refs or ids'), location: { type: ['string', 'null'] } }, additionalProperties: false },
    handler: setLocation,
  },
  save_outfit: {
    mode: 'write',
    description: 'Save an outfit under a style. Checks items exist, are active, share one location and do not double up on shoes or bottoms. verdict "rejected" with a reason records a proposal the user turned down.',
    input: {
      type: 'object',
      required: ['name', 'item_ids'],
      properties: {
        name: { type: 'string' },
        item_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12 },
        style: { type: 'string', description: 'Style name; created if new' },
        styles: { type: 'array', items: { type: 'string' } },
        occasion: { type: 'string' },
        occasions: { type: 'array', items: { type: 'string' } },
        seasons: { type: 'array', items: { enum: SEASONS } },
        temp_min: { type: 'number', description: 'Celsius' },
        temp_max: { type: 'number', description: 'Celsius' },
        verdict: { enum: VERDICTS, description: 'Default loved' },
        reason: { type: 'string' },
        notes: { type: 'string' },
        made_by: { enum: ['agent', 'user'] },
        request: { type: 'string', description: 'What the user asked for' },
        allow_mixed_locations: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    handler: saveOutfit,
  },
  rate_outfit: {
    mode: 'write',
    description: 'Set an outfit verdict: loved, fine or rejected, with the reason.',
    input: { type: 'object', required: ['outfit_id', 'verdict'], properties: { outfit_id: { type: 'string' }, verdict: { enum: VERDICTS }, reason: { type: 'string' } }, additionalProperties: false },
    handler: rateOutfit,
  },
  update_outfit: {
    mode: 'write',
    description: 'Rename an outfit or change its notes, occasions or styles.',
    input: {
      type: 'object',
      required: ['outfit_id'],
      properties: { outfit_id: { type: 'string' }, name: { type: 'string' }, notes: { type: ['string', 'null'] }, occasions: { type: 'array', items: { type: 'string' } }, styles: { type: 'array', items: { type: 'string' } } },
      additionalProperties: false,
    },
    handler: updateOutfit,
  },
  save_style: {
    mode: 'write',
    description: 'Create or update a style by name: description, do and don\'t rules, palette (plain colour names). rename_to renames it everywhere.',
    input: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        rename_to: { type: 'string' },
        description: { type: ['string', 'null'] },
        do: { type: 'array', items: { type: 'string' } },
        dont: { type: 'array', items: { type: 'string' } },
        palette: { type: 'array', items: { type: 'string' } },
        reference_outfit_ids: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    handler: saveStyle,
  },
  remove_style: {
    mode: 'write',
    description: 'Delete a style. Outfits that used it are kept and untagged.',
    input: { type: 'object', required: ['name'], properties: { name: { type: 'string' } }, additionalProperties: false },
    handler: removeStyle,
  },
  set_profile: {
    mode: 'write',
    description: 'Standing preferences that apply to every outfit ("nothing tight", "no logos"), sizes and notes.',
    input: {
      type: 'object',
      properties: {
        preferences: { type: 'array', items: { type: 'string' }, description: 'Replaces the list' },
        add_preferences: { type: 'array', items: { type: 'string' } },
        remove_preferences: { type: 'array', items: { type: 'string' } },
        sizes: { type: 'object', additionalProperties: { type: ['string', 'null'] } },
        notes: { type: ['string', 'null'] },
      },
      additionalProperties: false,
    },
    handler: setProfile,
  },
  log_wear: {
    mode: 'write',
    description: 'Record that an outfit (or some items) was worn; bumps wear counts.',
    input: {
      type: 'object',
      properties: { outfit_id: { type: 'string' }, item_ids: { type: 'array', items: { type: 'string' } }, date: { type: 'string', description: 'YYYY-MM-DD, default today' } },
      additionalProperties: false,
    },
    handler: logWear,
  },
  upload_link: {
    mode: 'write',
    description: 'A short-lived link the user opens on their phone to upload clothing photos.',
    input: { type: 'object', properties: { ttl_minutes: { type: 'integer', minimum: 5, maximum: 1440 } }, additionalProperties: false },
    handler: uploadLink,
  },
  tag_pending: {
    mode: 'write',
    description: 'Draft tags for untagged items with the server vision model, when one is configured.',
    input: { type: 'object', properties: { item_ids: { type: 'array', items: { type: 'string' } }, limit: { type: 'integer', minimum: 1, maximum: TAG_PENDING_MAX } }, additionalProperties: false },
    handler: tagPending,
  },
  remove_item: {
    mode: 'write',
    description: 'Delete items permanently. Prefer set_status donated to keep history.',
    input: { type: 'object', required: ['item_ids'], properties: { item_ids: ids('Refs or ids') }, additionalProperties: false },
    handler: removeItem,
  },
  remove_outfit: {
    mode: 'write',
    description: 'Delete a saved outfit. Its items stay.',
    input: { type: 'object', required: ['outfit_id'], properties: { outfit_id: { type: 'string' } }, additionalProperties: false },
    handler: removeOutfit,
  },
};

module.exports = { actions };
